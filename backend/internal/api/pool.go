package api

import (
	"context"
	"encoding/json"
	"log"
	"strconv"
	"strings"
	"time"

	"a09f/bottle/internal/pgstore"
	"a09f/bottle/internal/store"

	"github.com/gofiber/fiber/v3"
)

type depositRequest struct {
	Keys []store.PoolKey `json:"keys"`
}

func (s *Server) depositKeys(c fiber.Ctx) error {
	var req depositRequest
	if err := bindJSON(c, &req); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid json")
	}
	if len(req.Keys) == 0 || len(req.Keys) > 100 {
		return fiber.NewError(fiber.StatusBadRequest, "keys must contain 1..100 entries")
	}
	for i := range req.Keys {
		if strings.TrimSpace(req.Keys[i].KID) == "" || len(req.Keys[i].KID) > 128 {
			return fiber.NewError(fiber.StatusBadRequest, "invalid kid")
		}
		if strings.TrimSpace(req.Keys[i].PublicKey) == "" || len(req.Keys[i].PublicKey) > 8192 {
			return fiber.NewError(fiber.StatusBadRequest, "invalid publicKey")
		}
		var jwk struct {
			X string `json:"x"`
			Y string `json:"y"`
		}
		if err := json.Unmarshal([]byte(req.Keys[i].PublicKey), &jwk); err != nil || jwk.X == "" || jwk.Y == "" {
			return fiber.NewError(fiber.StatusBadRequest, "invalid publicKey")
		}
		if req.Keys[i].TTLSeconds < 0 || req.Keys[i].TTLSeconds > 2592000 || (req.Keys[i].TTLSeconds > 0 && req.Keys[i].TTLSeconds < 60) {
			return fiber.NewError(fiber.StatusBadRequest, "ttlSeconds must be 0 or 60..2592000")
		}
		if tz := req.Keys[i].TZOffset; tz != nil && (*tz < -720 || *tz > 840) {
			return fiber.NewError(fiber.StatusBadRequest, "tzOffset must be -720..840")
		}
		if len(req.Keys[i].Owner) > 128 {
			return fiber.NewError(fiber.StatusBadRequest, "owner too long")
		}
		req.Keys[i].ExpiresAt = 0
	}
	if err := s.store.DepositKeys(c.Context(), req.Keys); err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "deposit failed")
	}
	if s.pg != nil {
		user, authed := s.authUser(c)
		keys := append([]store.PoolKey(nil), req.Keys...)
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			// PG_ONLY: LiveStore.DepositKeys already registered these rows
			// synchronously — re-upserting could reset consumed_at on a key
			// a concurrent fetch just claimed.
			if !s.pgBacked {
				if err := s.pg.RegisterPoolKeys(ctx, keys); err != nil {
					log.Printf("pg key_registry: %v", err)
				}
			}
			if authed {
				if err := s.pg.UpsertUserKeys(ctx, user.ID, keys); err != nil {
					log.Printf("pg user_keys %s: %v", user.ID, err)
				}
			}
		}()
	}
	s.metrics.inc("key_deposits")
	s.cacheInvalidatePool(c.Context())
	return c.JSON(fiber.Map{"accepted": len(req.Keys)})
}

type fetchRequest struct {
	Count    int      `json:"count"`
	Exclude  []string `json:"exclude,omitempty"`
	TZOffset *int     `json:"tzOffset,omitempty"`
}

func (s *Server) fetchKeys(c fiber.Ctx) error {
	var req fetchRequest
	if len(c.Body()) > 0 {
		if err := bindJSON(c, &req); err != nil {
			return fiber.NewError(fiber.StatusBadRequest, "invalid json")
		}
	}
	if req.Count <= 0 {
		req.Count = 2
	}
	if req.Count > 5 {
		req.Count = 5
	}
	if len(req.Exclude) > 1000 {
		return fiber.NewError(fiber.StatusBadRequest, "exclude too large")
	}
	for _, k := range req.Exclude {
		if len(k) > 128 {
			return fiber.NewError(fiber.StatusBadRequest, "invalid exclude kid")
		}
	}
	if tz := req.TZOffset; tz != nil && (*tz < -720 || *tz > 840) {
		return fiber.NewError(fiber.StatusBadRequest, "tzOffset must be -720..840")
	}
	var exclude []string
	if user, ok := s.authUser(c); ok {
		if kids, err := s.pg.ListBlockedKids(c.Context(), user.ID, 10000); err == nil {
			exclude = kids
		} else {
			log.Printf("pg blocked kids %s: %v", user.ID, err)
		}
	}
	exclude = append(exclude, req.Exclude...)
	keys, err := s.store.FetchKeys(c.Context(), req.Count, exclude, req.TZOffset)
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "fetch failed")
	}
	if s.pg != nil && !s.pgBacked && len(keys) > 0 {
		fetched := make([]string, 0, len(keys))
		for _, k := range keys {
			fetched = append(fetched, k.KID)
		}
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if err := s.pg.MarkPoolKeysConsumed(ctx, fetched); err != nil {
				log.Printf("pg mark consumed: %v", err)
			}
		}()
	}
	s.cacheInvalidatePool(c.Context())
	return c.JSON(fiber.Map{"keys": keys})
}

type poolStatusRequest struct {
	Kids []string `json:"kids"`
}

type poolStatusEntry struct {
	KID        string `json:"kid"`
	InPool     bool   `json:"inPool"`
	Registered bool   `json:"registered"`
	Consumed   bool   `json:"consumed"`
	CreatedAt  int64  `json:"createdAt"`
	ExpiresAt  int64  `json:"expiresAt"`
}

// poolStatus reports, per kid, whether it is live in the Redis pool and what
// the Postgres registry says about it (registered, consumed, expiry). Clients
// use it to detect keys lost from the pool (e.g. after a Redis collapse) so
// they can be re-deposited. Pool membership and pubkeys are already public;
// this exposes nothing beyond that.
func (s *Server) poolStatus(c fiber.Ctx) error {
	var req poolStatusRequest
	if err := bindJSON(c, &req); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid json")
	}
	seen := make(map[string]struct{}, len(req.Kids))
	kids := make([]string, 0, len(req.Kids))
	for _, kid := range req.Kids {
		if !validPopKid(kid) {
			continue
		}
		if _, dup := seen[kid]; dup {
			continue
		}
		seen[kid] = struct{}{}
		kids = append(kids, kid)
		if len(kids) >= 200 {
			break
		}
	}
	if len(kids) == 0 {
		return fiber.NewError(fiber.StatusBadRequest, "no valid kids")
	}
	// Short-TTL cache: pool status changes on deposit/fetch/pickup, so 5s
	// staleness is acceptable and collapses repeat polls to Redis.
	var statusKey string
	if s.cache != nil {
		statusKey = "poolstat:" + strconv.FormatInt(s.cache.GetInt(c.Context(), "pver"), 10) + ":" + kidsHash(kids)
		var page struct {
			Kids []poolStatusEntry `json:"kids"`
		}
		if s.cache.GetJSON(c.Context(), statusKey, &page) {
			return c.JSON(fiber.Map{"kids": page.Kids})
		}
	}
	inPool, err := s.store.PoolKidsExist(c.Context(), kids)
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "status failed")
	}
	var reg map[string]pgstore.PoolKeyState
	if s.pg != nil {
		reg, err = s.pg.PoolKeyStates(c.Context(), kids)
		if err != nil {
			log.Printf("pg pool status: %v", err)
			reg = nil
		}
	}
	out := make([]poolStatusEntry, 0, len(kids))
	for _, kid := range kids {
		entry := poolStatusEntry{KID: kid, InPool: inPool[kid]}
		if st, ok := reg[kid]; ok {
			entry.Registered = st.Found
			entry.Consumed = st.Consumed
			entry.CreatedAt = st.CreatedAt
			entry.ExpiresAt = st.ExpiresAt
		}
		out = append(out, entry)
	}
	if statusKey != "" {
		s.cache.SetJSON(c.Context(), statusKey, fiber.Map{"kids": out}, 5*time.Second)
	}
	return c.JSON(fiber.Map{"kids": out})
}

func (s *Server) listPoolKeys(c fiber.Ctx) error {
	limit := 200
	if raw := c.Query("limit"); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil {
			limit = n
		}
	}
	offset := 0
	if raw := c.Query("offset"); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil {
			offset = n
		}
	}
	cacheKey := ""
	if s.cache != nil {
		cacheKey = "poolkeys:" + strconv.Itoa(limit) + ":" + strconv.Itoa(offset)
		var page struct {
			Keys []store.PoolKey `json:"keys"`
			Size int64           `json:"size"`
		}
		if s.cache.GetJSON(c.Context(), cacheKey, &page) {
			return c.JSON(fiber.Map{"keys": page.Keys, "size": page.Size})
		}
	}
	keys, size, err := s.store.ListPoolKeys(c.Context(), limit, offset)
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "list failed")
	}
	if cacheKey != "" {
		s.cache.SetJSON(c.Context(), cacheKey, fiber.Map{"keys": keys, "size": size}, 10*time.Second)
	}
	return c.JSON(fiber.Map{"keys": keys, "size": size})
}

// rebuildPool restores the Redis bait pool from key_registry on boot. It is
// the recovery path for a Redis collapse: registry rows that are unconsumed,
// unexpired, and never wrapped into a bottle go back into the pool with
// their original expiry. The deposit script dedupes by kid, so running it
// against an intact pool is a harmless no-op.
func (s *Server) rebuildPool(ctx context.Context) {
	rctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	keys, err := s.pg.LivePoolKeys(rctx, time.Now().Unix())
	if err != nil {
		log.Printf("pool rebuild query: %v", err)
		return
	}
	if len(keys) == 0 {
		return
	}
	n, err := s.store.RestorePoolKeys(rctx, keys)
	if err != nil {
		log.Printf("pool rebuild restore: %v", err)
		return
	}
	log.Printf("pool rebuild: restored %d/%d live key(s) from registry", n, len(keys))
}

// releaseMyKeys pulls every unconsumed pool key owned by the caller off
// the water — the explicit-logout path so bait doesn't linger in the pool
// (unreadable to anyone) after the owning device signs out. Requires
// identity auth; only the caller's own keys are touched.
func (s *Server) releaseMyKeys(c fiber.Ctx) error {
	user, ok := s.authUser(c)
	if !ok || s.pg == nil {
		return fiber.NewError(fiber.StatusUnauthorized, "auth required")
	}
	n, err := s.pg.ReleaseUserPoolKeys(c.Context(), user.ID)
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "release failed")
	}
	s.cacheInvalidatePool(c.Context())
	return c.JSON(fiber.Map{"released": n})
}

func (s *Server) listPoolKids(c fiber.Ctx) error {
	limit := 20000
	if raw := c.Query("limit"); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil {
			limit = n
		}
	}
	cacheKey := ""
	if s.cache != nil {
		cacheKey = "poolkids:" + strconv.FormatInt(s.cache.GetInt(c.Context(), "pver"), 10) + ":" + strconv.Itoa(limit)
		var page struct {
			Kids []string `json:"kids"`
			Size int64    `json:"size"`
		}
		if s.cache.GetJSON(c.Context(), cacheKey, &page) {
			return c.JSON(fiber.Map{"kids": page.Kids, "size": page.Size})
		}
	}
	kids, size, err := s.store.ListPoolKids(c.Context(), limit)
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "list failed")
	}
	if cacheKey != "" {
		s.cache.SetJSON(c.Context(), cacheKey, fiber.Map{"kids": kids, "size": size}, 5*time.Second)
	}
	return c.JSON(fiber.Map{"kids": kids, "size": size})
}
