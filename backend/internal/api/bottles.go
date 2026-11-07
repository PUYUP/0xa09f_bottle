package api

import (
	"context"
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
	if user, ok := s.authUser(c); ok {
		kids := make([]string, 0, len(bottle.Envelopes))
		for _, env := range bottle.Envelopes {
			kids = append(kids, env.KID)
		}
		blocked, err := s.pg.BlockedKidsAmong(c.Context(), user.ID, kids)
		if err != nil {
			log.Printf("pg blocked check %s: %v", user.ID, err)
		} else if len(blocked) > 0 {
			return c.Status(fiber.StatusConflict).JSON(fiber.Map{
				"error":   "blocked_key_conflict",
				"blocked": len(blocked),
			})
		}
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
	// Envelopes may be fewer than maxDeliveries: a bottle cast while the pool
	// is sparse (or empty) starts with only the self archive envelope, and
	// recipient envelopes are appended later via POST /:id/envelopes.
	// Upper bound: maxDeliveries recipients + 1 self envelope.
	if len(b.Envelopes) < 1 || len(b.Envelopes) > b.MaxDeliveries+1 {
		return fiber.NewError(fiber.StatusBadRequest, "envelope count out of range")
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

// appendBottleEnvelopes lets the session-key holder top up recipient
// envelopes on an already-cast bottle — the "cast into the void, deliver
// later" flow. Appended wraps are opaque to the server; only the original
// sender can produce ones that actually decrypt.
func (s *Server) appendBottleEnvelopes(c fiber.Ctx) error {
	id := c.Params("id")
	var body struct {
		Envelopes []store.Envelope `json:"envelopes"`
	}
	if err := bindJSON(c, &body); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid json")
	}
	if len(body.Envelopes) < 1 || len(body.Envelopes) > 5 {
		return fiber.NewError(fiber.StatusBadRequest, "envelopes must contain 1..5 entries")
	}
	for _, env := range body.Envelopes {
		if env.KID == "" || len(env.KID) > 128 ||
			env.AuthorPublicKey == "" || len(env.AuthorPublicKey) > 8192 ||
			env.WrapIV == "" || len(env.WrapIV) > 64 ||
			env.WrappedKey == "" || len(env.WrappedKey) > 1024 ||
			len(env.PickupHash) > 128 {
			return fiber.NewError(fiber.StatusBadRequest, "incomplete or invalid envelope")
		}
	}
	bottle, err := s.store.AppendEnvelopes(c.Context(), id, body.Envelopes)
	if err != nil {
		switch err {
		case store.ErrBottleNotFound:
			return fiber.NewError(fiber.StatusNotFound, "bottle not found")
		case store.ErrBottleNotActive:
			return fiber.NewError(fiber.StatusConflict, "bottle not active")
		case store.ErrEnvelopeLimit:
			return fiber.NewError(fiber.StatusConflict, "envelope limit reached")
		}
		return fiber.NewError(fiber.StatusInternalServerError, "append failed")
	}
	s.syncBottlePG(c.Context(), bottle)
	return c.JSON(fiber.Map{"id": bottle.ID, "envelopes": len(bottle.Envelopes)})
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

	// Optional recipient filter: only bottles carrying at least one of the
	// given envelope kids are returned. Used by clients to fetch just their
	// own bottles instead of the entire corpus.
	kidSet := parseKidFilter(c.Query("kids"))

	var bottles []store.Bottle
	if len(kidSet) > 0 {
		return s.listBottlesByKids(c, limit, beforeCreatedAt, beforeID, kidSet)
	}
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

func parseKidFilter(raw string) map[string]struct{} {
	if raw == "" {
		return nil
	}
	set := make(map[string]struct{})
	for _, part := range strings.Split(raw, ",") {
		kid := strings.TrimSpace(part)
		if kid == "" || len(kid) > 128 {
			continue
		}
		set[kid] = struct{}{}
		if len(set) >= 300 {
			break
		}
	}
	if len(set) == 0 {
		return nil
	}
	return set
}

func bottleMatchesKids(b store.Bottle, kids map[string]struct{}) bool {
	for _, env := range b.Envelopes {
		if _, ok := kids[env.KID]; ok {
			return true
		}
	}
	return false
}

// fetchCursorPage merges the Redis fast path and Postgres archive for one
// cursor-paginated page.
func (s *Server) fetchCursorPage(ctx context.Context, limit int, beforeCreatedAt int64, beforeID string) ([]store.Bottle, error) {
	if s.pg != nil {
		redisBottles, err := s.store.ListBottlesCursor(ctx, limit, beforeCreatedAt, beforeID)
		if err != nil {
			return nil, err
		}
		pgBottles, err := s.pg.ListBottlesCursor(ctx, limit, beforeCreatedAt, beforeID)
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
		return merged, nil
	}
	return s.store.ListBottlesCursor(ctx, limit, beforeCreatedAt, beforeID)
}

// listBottlesByKids pages through the corpus and returns only bottles whose
// envelopes carry a requested kid. Pages may return fewer than limit items;
// nextCursor always points at the last scanned candidate so filtered-out
// bottles are never skipped.
func (s *Server) listBottlesByKids(c fiber.Ctx, limit int, beforeCreatedAt int64, beforeID string, kids map[string]struct{}) error {
	const pageSize = 200
	const maxPages = 30
	out := make([]store.Bottle, 0, limit)
	curCA, curID := beforeCreatedAt, beforeID
	nextCursor := ""
	for page := 0; page < maxPages && len(out) < limit; page++ {
		candidates, err := s.fetchCursorPage(c.Context(), pageSize, curCA, curID)
		if err != nil {
			return fiber.NewError(fiber.StatusInternalServerError, "list failed")
		}
		if len(candidates) == 0 {
			break
		}
		exhausted := len(candidates) < pageSize
		for _, b := range candidates {
			if bottleMatchesKids(b, kids) {
				out = append(out, b)
				if len(out) >= limit {
					curCA, curID = b.CreatedAt, b.ID
					nextCursor = fmt.Sprintf("%d_%s", curCA, curID)
					return c.JSON(fiber.Map{"bottles": out, "nextCursor": nextCursor})
				}
			}
		}
		last := candidates[len(candidates)-1]
		curCA, curID = last.CreatedAt, last.ID
		if exhausted {
			break
		}
	}
	if len(out) > 0 {
		nextCursor = fmt.Sprintf("%d_%s", curCA, curID)
	}
	return c.JSON(fiber.Map{"bottles": out, "nextCursor": nextCursor})
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

type reportBottleRequest struct {
	Reason string `json:"reason"`
}

// reportBottle files a UGC report against a bottle for moderation. Auth is
// optional: authenticated reporters are attributed, anonymous ones stored
// with an empty reporter id.
func (s *Server) reportBottle(c fiber.Ctx) error {
	if s.pg == nil {
		return fiber.NewError(fiber.StatusServiceUnavailable, "reports unavailable")
	}
	id := c.Params("id")
	if !validBottleID(id) {
		return fiber.NewError(fiber.StatusBadRequest, "invalid bottle id")
	}
	var req reportBottleRequest
	if len(c.Body()) > 0 {
		if err := bindJSON(c, &req); err != nil {
			return fiber.NewError(fiber.StatusBadRequest, "invalid json")
		}
	}
	req.Reason = strings.TrimSpace(req.Reason)
	if len(req.Reason) > 1000 {
		return fiber.NewError(fiber.StatusBadRequest, "reason too long")
	}
	exists := false
	if _, err := s.store.GetBottle(c.Context(), id); err == nil {
		exists = true
	}
	if !exists {
		pgExists, err := s.pg.BottleExists(c.Context(), id)
		if err != nil {
			return fiber.NewError(fiber.StatusInternalServerError, "lookup failed")
		}
		exists = pgExists
	}
	if !exists {
		return fiber.NewError(fiber.StatusNotFound, "bottle not found")
	}
	reporter := ""
	if user, ok := s.authUser(c); ok {
		reporter = user.ID
	}
	if err := s.pg.ReportBottle(c.Context(), id, reporter, req.Reason); err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "report failed")
	}
	return c.Status(fiber.StatusCreated).JSON(fiber.Map{"ok": true})
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
