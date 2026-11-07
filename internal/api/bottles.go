package api

import (
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"log"
	"sort"
	"strconv"
	"strings"
	"time"

	"a09f/bottle/internal/store"

	"github.com/gofiber/fiber/v3"
)

func (s *Server) createBottle(c fiber.Ctx) error {
	var bottle store.Bottle
	if err := bindJSON(c, &bottle); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid json")
	}
	if err := validateBottle(bottle); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, err.Error())
	}
	bottle.CreatedAt = time.Now().Unix()
	bottle.Deliveries = 0
	bottle.Status = "ACTIVE"
	bottle.DeliveredKids = nil
	if bottle.Depth <= 0 {
		bottle.Depth = 1
	}
	if err := s.store.CreateBottle(c.Context(), bottle); err != nil {
		if err == store.ErrBottleExists {
			return fiber.NewError(fiber.StatusConflict, "bottle id already exists")
		}
		return fiber.NewError(fiber.StatusInternalServerError, "create failed")
	}
	s.syncBottlePG(c.Context(), bottle)
	return c.Status(fiber.StatusCreated).JSON(fiber.Map{"id": bottle.ID, "status": bottle.Status})
}

func validateBottle(b store.Bottle) error {
	if len(b.ID) < 8 || len(b.ID) > 128 || !validBottleID(b.ID) {
		return fiber.NewError(fiber.StatusBadRequest, "invalid id")
	}
	if b.MaxDeliveries < 1 || b.MaxDeliveries > 5 {
		return fiber.NewError(fiber.StatusBadRequest, "maxDeliveries must be 1..5")
	}
	if b.Depth < 0 || b.Depth > 20 {
		return fiber.NewError(fiber.StatusBadRequest, "depth must be 0..20")
	}
	if b.ParentID != "" && (len(b.ParentID) > 128 || !validBottleID(b.ParentID)) {
		return fiber.NewError(fiber.StatusBadRequest, "invalid parentId")
	}
	if len(b.Envelopes) != b.MaxDeliveries {
		return fiber.NewError(fiber.StatusBadRequest, "envelope count must equal maxDeliveries")
	}
	if b.PayloadIV == "" || len(b.PayloadIV) > 64 || b.Ciphertext == "" || len(b.Ciphertext) > 256*1024 {
		return fiber.NewError(fiber.StatusBadRequest, "invalid payload fields")
	}
	for _, env := range b.Envelopes {
		if env.KID == "" || len(env.KID) > 128 ||
			env.AuthorPublicKey == "" || len(env.AuthorPublicKey) > 8192 ||
			env.WrapIV == "" || len(env.WrapIV) > 64 ||
			env.WrappedKey == "" || len(env.WrappedKey) > 1024 ||
			len(env.PickupHash) > 128 {
			return fiber.NewError(fiber.StatusBadRequest, "incomplete or invalid envelope")
		}
	}
	return nil
}

func validBottleID(id string) bool {
	for _, r := range id {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' {
			continue
		}
		return false
	}
	return true
}

func (s *Server) listBottles(c fiber.Ctx) error {
	limit := 50
	if raw := c.Query("limit"); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil {
			limit = n
		}
	}
	if limit <= 0 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}

	cursorRaw := c.Query("cursor")
	cursorMode := cursorRaw != ""
	var beforeCreatedAt int64
	var beforeID string
	if cursorMode {
		// Composite cursor "<createdAt>_<id>"; a bare number is accepted as
		// a legacy timestamp-only cursor.
		if idx := strings.LastIndex(cursorRaw, "_"); idx > 0 {
			if n, err := strconv.ParseInt(cursorRaw[:idx], 10, 64); err == nil && n > 0 && validBottleID(cursorRaw[idx+1:]) {
				beforeCreatedAt, beforeID = n, cursorRaw[idx+1:]
			}
		} else if n, err := strconv.ParseInt(cursorRaw, 10, 64); err == nil && n > 0 {
			beforeCreatedAt = n
		}
	}

	var bottles []store.Bottle
	if cursorMode {
		// Scalable Cursor-based pagination (O(log N + limit) index seek)
		if s.pg != nil {
			redisBottles, err := s.store.ListBottlesCursor(c.Context(), limit, beforeCreatedAt, beforeID)
			if err != nil {
				return fiber.NewError(fiber.StatusInternalServerError, "list failed")
			}
			pgBottles, err := s.pg.ListBottlesCursor(c.Context(), limit, beforeCreatedAt, beforeID)
			if err != nil {
				log.Printf("pg list bottles: %v", err)
				pgBottles = nil
			}
			seen := make(map[string]bool, len(redisBottles)+len(pgBottles))
			merged := make([]store.Bottle, 0, len(redisBottles)+len(pgBottles))
			for _, b := range redisBottles {
				seen[b.ID] = true
				merged = append(merged, b)
			}
			for _, b := range pgBottles {
				if !seen[b.ID] {
					merged = append(merged, b)
				}
			}
			sortBottles(merged)
			if len(merged) > limit {
				merged = merged[:limit]
			}
			bottles = merged
		} else {
			var err error
			bottles, err = s.store.ListBottlesCursor(c.Context(), limit, beforeCreatedAt, beforeID)
			if err != nil {
				return fiber.NewError(fiber.StatusInternalServerError, "list failed")
			}
		}
	} else {
		// Offset pagination (backward compatible)
		offset := 0
		if raw := c.Query("offset"); raw != "" {
			if n, err := strconv.Atoi(raw); err == nil && n > 0 {
				offset = n
			}
		}
		if s.pg != nil {
			need := limit + offset
			redisBottles, err := s.store.ListBottles(c.Context(), need, 0)
			if err != nil {
				return fiber.NewError(fiber.StatusInternalServerError, "list failed")
			}
			pgBottles, err := s.pg.ListBottles(c.Context(), need, 0)
			if err != nil {
				log.Printf("pg list bottles: %v", err)
				pgBottles = nil
			}
			seen := make(map[string]bool, len(redisBottles)+len(pgBottles))
			merged := make([]store.Bottle, 0, len(redisBottles)+len(pgBottles))
			for _, b := range redisBottles {
				seen[b.ID] = true
				merged = append(merged, b)
			}
			for _, b := range pgBottles {
				if !seen[b.ID] {
					merged = append(merged, b)
				}
			}
			sortBottles(merged)
			if offset >= len(merged) {
				bottles = []store.Bottle{}
			} else {
				end := offset + limit
				if end > len(merged) {
					end = len(merged)
				}
				bottles = merged[offset:end]
			}
		} else {
			var err error
			bottles, err = s.store.ListBottles(c.Context(), limit, offset)
			if err != nil {
				return fiber.NewError(fiber.StatusInternalServerError, "list failed")
			}
		}
	}

	var nextCursor string
	if len(bottles) > 0 {
		last := bottles[len(bottles)-1]
		nextCursor = fmt.Sprintf("%d_%s", last.CreatedAt, last.ID)
	}
	return c.JSON(fiber.Map{"bottles": bottles, "nextCursor": nextCursor})
}

// sortBottles orders by (createdAt DESC, id DESC) so pagination is stable
// even when several bottles share the same second-resolution timestamp.
func sortBottles(b []store.Bottle) {
	sort.Slice(b, func(i, j int) bool {
		if b[i].CreatedAt != b[j].CreatedAt {
			return b[i].CreatedAt > b[j].CreatedAt
		}
		return b[i].ID > b[j].ID
	})
}

type pickupRequest struct {
	KID         string `json:"kid"`
	PickupToken string `json:"pickupToken,omitempty"`
}

func (s *Server) pickupBottle(c fiber.Ctx) error {
	var req pickupRequest
	if err := bindJSON(c, &req); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid json")
	}
	id := c.Params("id")
	if !validBottleID(id) {
		return fiber.NewError(fiber.StatusBadRequest, "invalid bottle id")
	}
	if strings.TrimSpace(req.KID) == "" || len(req.KID) > 128 {
		return fiber.NewError(fiber.StatusBadRequest, "invalid kid")
	}
	var tokenHash string
	if req.PickupToken != "" {
		if len(req.PickupToken) > 256 {
			return fiber.NewError(fiber.StatusBadRequest, "invalid pickup token")
		}
		h := sha256.Sum256([]byte(req.PickupToken))
		tokenHash = base64.StdEncoding.EncodeToString(h[:])
	}
	result, err := s.store.Pickup(c.Context(), id, req.KID, tokenHash)
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "pickup failed")
	}
	if !result.OK {
		return c.Status(fiber.StatusConflict).JSON(result)
	}
	if s.pg != nil {
		s.archiveBottle(c.Context(), id)
	}
	return c.JSON(result)
}
