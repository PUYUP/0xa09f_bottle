package main

import (
	"context"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"a09f/bottle/internal/api"
	"a09f/bottle/internal/config"
	"a09f/bottle/internal/pgstore"
	"a09f/bottle/internal/store"

	"github.com/getsentry/sentry-go"
	"github.com/joho/godotenv"
)

func main() {
	_ = godotenv.Load()
	cfg := config.FromEnv()
	if cfg.SentryDSN != "" {
		if err := sentry.Init(sentry.ClientOptions{Dsn: cfg.SentryDSN}); err != nil {
			log.Printf("sentry init: %v", err)
		} else {
			defer sentry.Flush(2 * time.Second)
			log.Printf("sentry error reporting enabled")
		}
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	var pg *pgstore.PGStore
	var err error
	if cfg.DatabaseURL != "" {
		pg, err = pgstore.New(ctx, cfg.DatabaseURL, cfg.DBMaxConns, cfg.DBMinConns)
		if err != nil {
			log.Fatalf("postgres init: %v", err)
		}
		defer pg.Close()
		log.Printf("postgres enabled")
	}

	// PG_ONLY: all live state (pool, bottles, pickup, nonces, pop tokens)
	// lives in Postgres — Redis is not connected at all. Otherwise Redis is
	// the hot store and PG the archive.
	var live api.LiveStore
	if cfg.PGOnly {
		if pg == nil {
			log.Fatalf("PG_ONLY requires DATABASE_URL")
		}
		live = pgstore.NewLiveStore(pg, cfg.PoolTTL, cfg.MaxPool)
		log.Printf("storage: postgres-only (redis disabled)")
	} else {
		st, err := store.New(cfg.RedisURL, cfg.PoolTTL, cfg.BottleTTL, cfg.MaxPool, cfg.MaxBottles)
		if err != nil {
			log.Fatalf("redis init: %v", err)
		}
		defer st.Close()

		pingCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
		if err := st.Ping(pingCtx); err != nil {
			cancel()
			log.Fatalf("redis ping: %v", err)
		}
		cancel()
		st.StartPoolSweeper(ctx, time.Minute)
		live = st
	}

	app := api.New(ctx, cfg, live, pg)
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := app.ShutdownWithContext(shutdownCtx); err != nil {
			log.Printf("shutdown: %v", err)
		}
	}()

	log.Printf("0xa09f listening on %s (redis=%s)", cfg.Addr, cfg.RedisURL)
	if err := app.Listen(cfg.Addr); err != nil {
		log.Fatalf("listen: %v", err)
	}
}
