package api

import (
	"context"
	"encoding/json"
	"log"
	"time"

	"a09f/bottle/internal/store"

	"github.com/redis/go-redis/v9"
)

// syncBottlePG writes through to Postgres synchronously; on failure it
// schedules an async retry so transient PG outages do not lose data.
func (s *Server) syncBottlePG(ctx context.Context, bottle store.Bottle) {
	if s.pg == nil {
		return
	}
	syncCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := s.pg.SaveBottle(syncCtx, bottle); err != nil {
		log.Printf("pg save bottle %s: %v", bottle.ID, err)
		s.retryBottlePG(bottle)
	}
}

func (s *Server) retryBottlePG(bottle store.Bottle) {
	go func() {
		for i := 0; i < 10; i++ {
			time.Sleep(time.Duration(i+1) * 3 * time.Second)
			if err := s.pg.SaveBottle(context.Background(), bottle); err == nil {
				return
			}
		}
		// Out of retry budget: park the bottle in the Redis outbox so the
		// worker can persist it whenever Postgres comes back. Without this a
		// long outage plus Redis TTL expiry loses the bottle permanently.
		raw, err := json.Marshal(bottle)
		if err != nil {
			log.Printf("pg sync gave up for bottle %s (unmarshalable)", bottle.ID)
			return
		}
		if err := s.store.PGOutboxPush(context.Background(), string(raw)); err != nil {
			log.Printf("pg outbox push %s: %v", bottle.ID, err)
		} else {
			log.Printf("pg sync parked bottle %s in outbox", bottle.ID)
		}
	}()
}

// pgOutboxWorker drains the Redis outbox into Postgres. SaveBottle is an
// upsert, so replays after partial drains are idempotent.
func (s *Server) pgOutboxWorker(ctx context.Context) {
	if s.pg == nil {
		return
	}
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			default:
			}
			raw, err := s.store.PGOutboxPop(ctx, 5*time.Second)
			if err == redis.Nil {
				continue
			}
			if err != nil {
				if ctx.Err() != nil {
					return
				}
				log.Printf("pg outbox pop: %v", err)
				time.Sleep(5 * time.Second)
				continue
			}
			var b store.Bottle
			if err := json.Unmarshal([]byte(raw), &b); err != nil {
				log.Printf("pg outbox bad entry dropped: %v", err)
				continue
			}
			if err := s.pg.SaveBottle(ctx, b); err != nil {
				log.Printf("pg outbox save %s: %v", b.ID, err)
				// Put it back and back off — the head-of-line entry blocks
				// the queue, which is fine: ordering is preserved and PG is
				// presumably still down.
				_ = s.store.PGOutboxPush(context.Background(), raw)
				time.Sleep(15 * time.Second)
			}
		}
	}()
}

func (s *Server) archiveBottle(ctx context.Context, id string) {
	bottle, err := s.store.GetBottle(ctx, id)
	if err != nil {
		log.Printf("pg archive fetch %s: %v", id, err)
		return
	}
	s.syncBottlePG(ctx, bottle)
}

const reconcilerLockID int64 = 90901

// pgReconciler periodically re-upserts every active Redis bottle into
// Postgres, healing any writes lost to crashes or prolonged PG outages.
// In multi-replica deployments, it uses an advisory lock so only one replica
// performs reconciliation at a time.
func (s *Server) pgReconciler(ctx context.Context) {
	t := time.NewTicker(5 * time.Minute)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if s.pg == nil {
				continue
			}
			acquired, err := s.pg.TryAdvisoryLock(context.Background(), reconcilerLockID)
			if err != nil || !acquired {
				continue
			}
			s.reconcileOnce()
			_ = s.pg.AdvisoryUnlock(context.Background(), reconcilerLockID)
		}
	}
}

const retentionLockID int64 = 90902

// retentionWorker runs the PG retention prune once a day under an advisory
// lock so only one replica does it.
func (s *Server) retentionWorker(ctx context.Context) {
	go func() {
		// First pass shortly after boot, then daily.
		timer := time.NewTimer(2 * time.Minute)
		defer timer.Stop()
		ticker := time.NewTicker(24 * time.Hour)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-timer.C:
			case <-ticker.C:
			}
			acquired, err := s.pg.TryAdvisoryLock(context.Background(), retentionLockID)
			if err != nil || !acquired {
				continue
			}
			if err := s.pg.RunRetention(context.Background(), s.cfg.BottleRetentionDays); err != nil {
				log.Printf("pg retention: %v", err)
			}
			_ = s.pg.AdvisoryUnlock(context.Background(), retentionLockID)
		}
	}()
}

func (s *Server) reconcileOnce() {
	bottles, err := s.store.ListBottles(context.Background(), 500, 0)
	if err != nil {
		log.Printf("pg reconcile list: %v", err)
		return
	}
	for _, b := range bottles {
		if err := s.pg.SaveBottle(context.Background(), b); err != nil {
			log.Printf("pg reconcile %s: %v", b.ID, err)
		}
	}
}
