// Package cache is a thin Redis cache-aside layer in front of Postgres.
// It is strictly an accelerator: every value is populated from PG reads and
// every error is swallowed — when Redis is down or disabled the API keeps
// serving straight from Postgres with zero behavior change.
package cache

import (
	"context"
	"encoding/json"
	"log"
	"sync/atomic"
	"time"

	"github.com/redis/go-redis/v9"
)

type Store struct {
	rdb *redis.Client

	// errLogged throttles "cache disabled after error" spam — a dead Redis
	// should produce one log line, not one per request.
	errLogged atomic.Bool
}

// New connects to Redis and pings it. Returns nil (cache disabled) when the
// ping fails so callers can run fully on Postgres.
func New(ctx context.Context, url string) *Store {
	if url == "" {
		return nil
	}
	opt, err := redis.ParseURL(url)
	if err != nil {
		log.Printf("cache: bad REDIS_URL: %v", err)
		return nil
	}
	rdb := redis.NewClient(opt)
	pingCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	if err := rdb.Ping(pingCtx).Err(); err != nil {
		log.Printf("cache: redis unavailable (%v) — running PG-only", err)
		_ = rdb.Close()
		return nil
	}
	log.Printf("cache: redis connected (%s)", url)
	return &Store{rdb: rdb}
}

func (s *Store) noteErr(err error) {
	if s.errLogged.CompareAndSwap(false, true) {
		log.Printf("cache: redis error — bypassing cache until it recovers: %v", err)
	}
}

// GetJSON fetches and unmarshals a cached value. ok=false on miss, disabled
// cache, or any Redis error.
func (s *Store) GetJSON(ctx context.Context, key string, v any) bool {
	if s == nil {
		return false
	}
	raw, err := s.rdb.Get(ctx, key).Bytes()
	if err == redis.Nil {
		return false
	}
	if err != nil {
		s.noteErr(err)
		return false
	}
	if err := json.Unmarshal(raw, v); err != nil {
		return false
	}
	return true
}

// SetJSON marshals v and stores it with the given TTL. Best-effort.
func (s *Store) SetJSON(ctx context.Context, key string, v any, ttl time.Duration) {
	if s == nil {
		return
	}
	raw, err := json.Marshal(v)
	if err != nil {
		return
	}
	if err := s.rdb.Set(ctx, key, raw, ttl).Err(); err != nil {
		s.noteErr(err)
	}
}

// MGetBytes fetches many keys in one round trip. Missing keys and Redis
// errors yield nil entries — callers treat them as cache misses.
func (s *Store) MGetBytes(ctx context.Context, keys []string) [][]byte {
	out := make([][]byte, len(keys))
	if s == nil || len(keys) == 0 {
		return out
	}
	vals, err := s.rdb.MGet(ctx, keys...).Result()
	if err != nil {
		s.noteErr(err)
		return out
	}
	for i, v := range vals {
		if v == nil {
			continue
		}
		switch t := v.(type) {
		case string:
			out[i] = []byte(t)
		case []byte:
			out[i] = t
		}
	}
	return out
}

// Del removes keys; used to invalidate entries after writes.
func (s *Store) Del(ctx context.Context, keys ...string) {
	if s == nil || len(keys) == 0 {
		return
	}
	if err := s.rdb.Del(ctx, keys...).Err(); err != nil {
		s.noteErr(err)
	}
}

// Incr bumps a version counter so versioned cache keys self-invalidate.
func (s *Store) Incr(ctx context.Context, key string) {
	if s == nil {
		return
	}
	if err := s.rdb.Incr(ctx, key).Err(); err != nil {
		s.noteErr(err)
	}
}

// GetInt returns a counter's current value (0 when absent/disabled).
func (s *Store) GetInt(ctx context.Context, key string) int64 {
	if s == nil {
		return 0
	}
	v, err := s.rdb.Get(ctx, key).Int64()
	if err != nil {
		if err != redis.Nil {
			s.noteErr(err)
		}
		return 0
	}
	return v
}

// Ping reports whether Redis is reachable — used by /api/metrics.
func (s *Store) Ping(ctx context.Context) error {
	if s == nil {
		return nil
	}
	return s.rdb.Ping(ctx).Err()
}

func (s *Store) Close() {
	if s != nil {
		_ = s.rdb.Close()
	}
}
