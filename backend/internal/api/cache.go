package api

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"sort"
	"strings"

	"a09f/bottle/internal/store"
)

// kidsHash produces a stable short hash of a kid set for cache keys —
// kid lists arrive in arbitrary order, so sort before hashing.
func kidsHash(kids []string) string {
	sorted := append([]string(nil), kids...)
	sort.Strings(sorted)
	sum := sha256.Sum256([]byte(strings.Join(sorted, ",")))
	return hex.EncodeToString(sum[:8])
}

// threadRootOf approximates the thread root id the same way stats keying
// does: rootId when present, otherwise the bottle's own id.
func threadRootOf(b store.Bottle) string {
	if b.RootID != "" {
		return b.RootID
	}
	return b.ID
}

// cacheInvalidateBottle bumps the global inbox version and the thread
// version/stats for the affected root after any bottle write (create,
// delete, pickup). Versioned keys self-invalidate; explicit DEL covers the
// per-root stats entries.
func (s *Server) cacheInvalidateBottle(ctx context.Context, b store.Bottle) {
	if s.cache == nil {
		return
	}
	s.cache.Incr(ctx, "iver")
	root := threadRootOf(b)
	s.cache.Incr(ctx, "tver:"+root)
	s.cache.Del(ctx, "tstat:"+root)
	// Bottle writes change pool membership too: a kid wrapped into an
	// envelope leaves the "unclaimed pool" listing, so pool caches must
	// self-invalidate alongside the inbox version.
	s.cacheInvalidatePool(ctx)
}

// cacheInvalidatePool bumps the pool version counter so cached poolkids/
// poolstat entries self-invalidate on any membership change (deposit,
// fetch/consume, bottle create/delete/pickup).
func (s *Server) cacheInvalidatePool(ctx context.Context) {
	if s.cache == nil {
		return
	}
	s.cache.Incr(ctx, "pver")
}
