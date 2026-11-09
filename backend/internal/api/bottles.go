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
		// Reply-path enforcement: reply/self envelope kids are not pool keys
		// in user_keys, so BlockedKidsAmong cannot see them. Resolve the
		// parent bottle's author via its self:<uid> marker and reject when
		// a block exists in either direction.
		if bottle.ParentID != "" && s.pg != nil {
			if blocked, err := s.threadBlocked(c.Context(), user.ID, bottle.ParentID); err != nil {
				log.Printf("thread block check %s: %v", bottle.ParentID, err)
			} else if blocked {
				return c.Status(fiber.StatusConflict).JSON(fiber.Map{
					"error": "blocked_thread",
				})
			}
		}
	}
	if err := s.store.CreateBottle(c.Context(), bottle); err != nil {
		if err == store.ErrBottleExists {
			return fiber.NewError(fiber.StatusConflict, "bottle id already exists")
		}
		return fiber.NewError(fiber.StatusInternalServerError, "create failed")
	}
	s.syncBottlePG(c.Context(), bottle)
	s.events.publish(bottle)
	s.metrics.inc("bottles_created")
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
	if b.RootID != "" && (len(b.RootID) > 128 || !validBottleID(b.RootID)) {
		return fiber.NewError(fiber.StatusBadRequest, "invalid rootId")
	}
	// Envelopes may exceed maxDeliveries by one: clients append a self-addressed
	// archive envelope (kid "self:...") so sent plaintext stays recoverable.
	// It never claims a delivery slot, so EXHAUSTED math is unaffected.
	if len(b.Envelopes) != b.MaxDeliveries && len(b.Envelopes) != b.MaxDeliveries+1 {
		return fiber.NewError(fiber.StatusBadRequest, "envelope count must equal maxDeliveries")
	}
	if b.PayloadIV == "" || len(b.PayloadIV) > 64 || b.Ciphertext == "" || len(b.Ciphertext) > 256*1024 {
		return fiber.NewError(fiber.StatusBadRequest, "invalid payload fields")
	}
	for _, env := range b.Envelopes {
		if env.KID == "" || len(env.KID) > 128 ||
			env.AuthorPublicKey == "" || len(env.AuthorPublicKey) > 8192 ||
			len(env.RecipientPublicKey) > 8192 ||
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

	// Bottle listings are gated by proof-of-possession: the client must hold
	// a pop token issued for the exact kid set it wants to filter by. The
	// token binds the request to keys the requester proved control of, so a
	// third party cannot enumerate bottles addressed to other people's kids.
	var kidSet map[string]struct{}
	if token := c.Query("token"); token != "" {
		if tokenKids, ok := s.store.PopTokenKids(c.Context(), token); ok {
			kidSet = make(map[string]struct{}, len(tokenKids))
			for _, k := range tokenKids {
				kidSet[k] = struct{}{}
			}
		} else {
			return fiber.NewError(fiber.StatusUnauthorized, "invalid or expired pop token")
		}
	} else if raw := c.Query("kids"); raw != "" {
		return fiber.NewError(fiber.StatusForbidden, "proof of possession required")
	} else {
		return fiber.NewError(fiber.StatusBadRequest, "kids or token required")
	}

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

// listBottleChildren returns direct children of a bottle, merged from the
// Redis active set and the Postgres archive, ordered oldest-first so clients
// can render a thread level by level.
func (s *Server) listBottleChildren(c fiber.Ctx) error {
	parentID := c.Params("id")
	if !validBottleID(parentID) {
		return fiber.NewError(fiber.StatusBadRequest, "invalid bottle id")
	}
	limit := 200
	if raw := c.Query("limit"); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil {
			limit = n
		}
	}
	if limit <= 0 {
		limit = 200
	}
	if limit > 1000 {
		limit = 1000
	}
	tokenKids, ok := s.store.PopTokenKids(c.Context(), c.Query("token"))
	if !ok {
		return fiber.NewError(fiber.StatusUnauthorized, "valid pop token required")
	}
	kidSet := make(map[string]struct{}, len(tokenKids))
	for _, k := range tokenKids {
		kidSet[k] = struct{}{}
	}

	seen := make(map[string]bool)
	merged := make([]store.Bottle, 0, limit)
	add := func(list []store.Bottle) {
		for _, b := range list {
			if b.ParentID != parentID || seen[b.ID] || !bottleMatchesKids(b, kidSet) {
				continue
			}
			seen[b.ID] = true
			merged = append(merged, b)
		}
	}

	redisChildren, err := s.store.ListChildren(c.Context(), parentID, limit)
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "list failed")
	}
	add(redisChildren)
	if s.pg != nil {
		pgChildren, err := s.pg.ListChildren(c.Context(), parentID, limit)
		if err != nil {
			log.Printf("pg list children %s: %v", parentID, err)
		} else {
			add(pgChildren)
		}
	}
	sort.Slice(merged, func(i, j int) bool {
		if merged[i].CreatedAt != merged[j].CreatedAt {
			return merged[i].CreatedAt < merged[j].CreatedAt
		}
		return merged[i].ID < merged[j].ID
	})
	if len(merged) > limit {
		merged = merged[:limit]
	}
	return c.JSON(fiber.Map{"bottles": merged, "parentId": parentID})
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
	// Postgres path: the bottle_kids index answers "bottles involving these
	// kids" (recipient, self:<userId> sender marker, reply:<id>) directly and
	// exhaustively — no corpus scan, no page cap. Falls back to the Redis+PG
	// scan below if the query fails.
	if s.pg != nil {
		kidList := make([]string, 0, len(kids))
		for k := range kids {
			kidList = append(kidList, k)
		}
		if bottles, err := s.pg.ListBottlesByKids(c.Context(), kidList, limit, beforeCreatedAt, beforeID); err == nil {
			ids := make([]string, len(bottles))
			for i, b := range bottles {
				ids[i] = b.ID
			}
			if stats, err := s.pg.ChildStats(c.Context(), ids); err != nil {
				log.Printf("pg child stats: %v", err)
			} else {
				for i := range bottles {
					if st, ok := stats[bottles[i].ID]; ok {
						bottles[i].ChildCount = int(st[0])
						bottles[i].LastChildAt = st[1]
					}
				}
			}
			// Thread-level aggregates keyed by root id: a reply at any depth
			// bumps the root's activity so inbox badges/ordering reflect the
			// whole conversation, not just direct children.
			threadKeys := make(map[string]struct{}, len(bottles))
			for _, b := range bottles {
				key := b.RootID
				if key == "" {
					key = b.ID
				}
				threadKeys[key] = struct{}{}
			}
			keyList := make([]string, 0, len(threadKeys))
			for k := range threadKeys {
				keyList = append(keyList, k)
			}
			if tstats, err := s.pg.ThreadStats(c.Context(), keyList); err != nil {
				log.Printf("pg thread stats: %v", err)
			} else {
				for i := range bottles {
					key := bottles[i].RootID
					if key == "" {
						key = bottles[i].ID
					}
					if st, ok := tstats[key]; ok {
						bottles[i].ThreadCount = int(st[0])
						bottles[i].ThreadLastAt = st[1]
					}
				}
			}
			// PG is authoritative but lags Redis by the syncBottlePG retry
			// window: a bottle is cast-visible in Redis seconds before its PG
			// row + bottle_kids index commit, so the PG-only path can miss a
			// fresh catch for one refresh. Merge in kid-matching bottles from
			// the recent Redis tail to close that gap.
			if recent, err := s.recentRedisBottlesForKids(c.Context(), kids, beforeCreatedAt, beforeID); err != nil {
				log.Printf("redis recent merge: %v", err)
			} else if len(recent) > 0 {
				seen := make(map[string]struct{}, len(bottles))
				for _, b := range bottles {
					seen[b.ID] = struct{}{}
				}
				for _, b := range recent {
					if _, ok := seen[b.ID]; !ok {
						bottles = append(bottles, b)
					}
				}
				sortBottles(bottles)
				if len(bottles) > limit {
					bottles = bottles[:limit]
				}
			}
			nextCursor := ""
			if len(bottles) > 0 {
				last := bottles[len(bottles)-1]
				nextCursor = fmt.Sprintf("%d_%s", last.CreatedAt, last.ID)
			}
			return c.JSON(fiber.Map{"bottles": bottles, "nextCursor": nextCursor})
		} else {
			log.Printf("pg list bottles by kids: %v", err)
		}
	}
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

// recentRedisBottlesForKids scans the newest Redis bottles inside a short
// recency window and returns those matching the kid set. It exists to cover
// the gap between a bottle's Redis write and its Postgres commit
// (syncBottlePG retry backoff / outbox lag), which the PG bottle_kids index
// cannot see yet. Bounded by window + page cap so it stays cheap.
func (s *Server) recentRedisBottlesForKids(ctx context.Context, kids map[string]struct{}, beforeCreatedAt int64, beforeID string) ([]store.Bottle, error) {
	const windowSec = 900 // 15min — far beyond the PG retry/outbox lag
	const pageSize = 200
	const maxPages = 10
	cutoff := time.Now().Unix() - windowSec
	curCA, curID := beforeCreatedAt, beforeID
	out := make([]store.Bottle, 0, 64)
	for page := 0; page < maxPages; page++ {
		candidates, err := s.store.ListBottlesCursor(ctx, pageSize, curCA, curID)
		if err != nil {
			return nil, err
		}
		if len(candidates) == 0 {
			break
		}
		exhausted := len(candidates) < pageSize
		stop := false
		for _, b := range candidates {
			if b.CreatedAt < cutoff {
				stop = true
				break
			}
			if bottleMatchesKids(b, kids) {
				out = append(out, b)
			}
		}
		if stop || exhausted {
			break
		}
		last := candidates[len(candidates)-1]
		curCA, curID = last.CreatedAt, last.ID
	}
	return out, nil
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

// threadBlocked resolves a reply's parent bottle to its author's user id —
// every bottle carries a self:<uid> envelope marker — and reports whether a
// block exists between the replier and that author in either direction.
// Missing parents fail open: the check is best-effort on top of the
// anonymous-by-design cast path.
func (s *Server) threadBlocked(ctx context.Context, userID, parentID string) (bool, error) {
	parent, err := s.store.GetBottle(ctx, parentID)
	if err != nil && s.pg != nil {
		parent, err = s.pg.GetBottle(ctx, parentID)
	}
	if err != nil {
		return false, err
	}
	var authorUID string
	for _, env := range parent.Envelopes {
		if strings.HasPrefix(env.KID, "self:") {
			authorUID = strings.TrimPrefix(env.KID, "self:")
			break
		}
	}
	if authorUID == "" || authorUID == userID {
		return false, nil
	}
	iBlocked, err := s.pg.BlockExists(ctx, userID, authorUID)
	if err != nil {
		return false, err
	}
	theyBlocked, err := s.pg.BlockExists(ctx, authorUID, userID)
	if err != nil {
		return false, err
	}
	return iBlocked || theyBlocked, nil
}

// deleteBottle lets the author remove their own message (UGC "delete
// content"): the bottle is crypto-shredded into a DELETED tombstone in
// Postgres and removed from Redis, then delete events go to the same
// kid-matched subscribers so online clients drop their local copies.
// Only the sender may delete — authorship is proven by the self:<userId>
// envelope marker every bottle carries.
func (s *Server) deleteBottle(c fiber.Ctx) error {
	user, err := s.requireAuth(c)
	if err != nil {
		return err
	}
	id := c.Params("id")
	bottle, err := s.store.GetBottle(c.Context(), id)
	if err != nil && s.pg != nil {
		bottle, err = s.pg.GetBottle(c.Context(), id)
	}
	if err != nil {
		return fiber.NewError(fiber.StatusNotFound, "bottle not found")
	}
	if bottle.Status == "DELETED" {
		return c.JSON(fiber.Map{"ok": true, "alreadyDeleted": true})
	}
	selfKid := "self:" + user.ID
	author := false
	for _, env := range bottle.Envelopes {
		if env.KID == selfKid {
			author = true
			break
		}
	}
	if !author {
		return fiber.NewError(fiber.StatusForbidden, "only the author can delete a bottle")
	}
	s.events.publishDeleted(bottle)
	if s.pg != nil {
		if _, err := s.pg.TombstoneBottle(c.Context(), id); err != nil {
			log.Printf("pg tombstone %s: %v", id, err)
		}
	}
	if err := s.store.DeleteBottle(c.Context(), id); err != nil {
		log.Printf("redis delete %s: %v", id, err)
	}
	s.metrics.inc("bottle_deletes")
	return c.JSON(fiber.Map{"ok": true})
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
	if len(req.Reason) > 280 {
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
	s.metrics.inc("bottle_reports")
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
	s.metrics.inc("pickups")
	if s.pg != nil {
		s.archiveBottle(c.Context(), id)
	}
	return c.JSON(result)
}
