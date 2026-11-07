package api

import (
	"context"
	"log"
	"time"

	"a09f/bottle/internal/store"
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
		log.Printf("pg sync gave up for bottle %s (reconciler will backfill if still active)", bottle.ID)
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

// pgReconciler periodically re-upserts every active Redis bottle into
// Postgres, healing any writes lost to crashes or prolonged PG outages.
func (s *Server) pgReconciler(ctx context.Context) {
	t := time.NewTicker(5 * time.Minute)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			bottles, err := s.store.ListBottles(context.Background(), 500, 0)
			if err != nil {
				log.Printf("pg reconcile list: %v", err)
				continue
			}
			for _, b := range bottles {
				if err := s.pg.SaveBottle(context.Background(), b); err != nil {
					log.Printf("pg reconcile %s: %v", b.ID, err)
				}
			}
		}
	}
}

