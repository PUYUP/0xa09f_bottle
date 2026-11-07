package api

import (
	"context"
	"time"

	"a09f/bottle/internal/config"
	"a09f/bottle/internal/pgstore"
	"a09f/bottle/internal/store"

	"github.com/gofiber/fiber/v3"
	"github.com/gofiber/fiber/v3/middleware/cors"
	"github.com/gofiber/fiber/v3/middleware/helmet"
	"github.com/gofiber/fiber/v3/middleware/limiter"
	"github.com/gofiber/fiber/v3/middleware/logger"
)

type Server struct {
	cfg   config.Config
	store *store.Store
	pg    *pgstore.PGStore
}

func New(ctx context.Context, cfg config.Config, st *store.Store, pg *pgstore.PGStore) *fiber.App {
	s := &Server{cfg: cfg, store: st, pg: pg}
	if pg != nil {
		go s.pgReconciler(ctx)
	}
	app := fiber.New(fiber.Config{
		BodyLimit: 4 * 1024 * 1024,
	})

	app.Use(logger.New())
	app.Use(helmet.New())
	app.Use(cors.New(cors.Config{
		AllowOrigins: []string{"*"},
		AllowMethods: []string{"GET", "POST", "HEAD", "OPTIONS"},
		AllowHeaders: []string{"Content-Type"},
	}))

	depositLimiter := limiter.New(limiter.Config{
		Max:        30,
		Expiration: 1 * time.Minute,
		LimitReached: func(c fiber.Ctx) error {
			return fiber.NewError(fiber.StatusTooManyRequests, "deposit rate limit exceeded")
		},
	})
	fetchLimiter := limiter.New(limiter.Config{
		Max:        15,
		Expiration: 1 * time.Minute,
		LimitReached: func(c fiber.Ctx) error {
			return fiber.NewError(fiber.StatusTooManyRequests, "fetch rate limit exceeded")
		},
	})
	bottleLimiter := limiter.New(limiter.Config{
		Max:        30,
		Expiration: 1 * time.Minute,
		LimitReached: func(c fiber.Ctx) error {
			return fiber.NewError(fiber.StatusTooManyRequests, "bottle rate limit exceeded")
		},
	})

	app.Get("/api/health", s.health)
	app.Get("/api/health/live", s.live)
	app.Get("/api/health/ready", s.ready)
	app.Post("/api/pool/deposit", depositLimiter, s.depositKeys)
	app.Post("/api/pool/fetch", fetchLimiter, s.fetchKeys)
	app.Get("/api/pool/keys", s.listPoolKeys)
	app.Get("/api/pool/kids", s.listPoolKids)
	app.Post("/api/bottles", bottleLimiter, s.createBottle)
	app.Get("/api/bottles", s.listBottles)
	app.Post("/api/bottles/:id/pickup", bottleLimiter, s.pickupBottle)

	app.Use(s.serveStatic)
	return app
}

func (s *Server) health(c fiber.Ctx) error {
	return c.JSON(fiber.Map{"ok": true, "time": time.Now().UTC().Format(time.RFC3339)})
}

func (s *Server) live(c fiber.Ctx) error {
	return c.JSON(fiber.Map{"status": "alive"})
}

func (s *Server) ready(c fiber.Ctx) error {
	ctx, cancel := context.WithTimeout(c.Context(), 2*time.Second)
	defer cancel()

	if err := s.store.Ping(ctx); err != nil {
		return c.Status(fiber.StatusServiceUnavailable).JSON(fiber.Map{
			"status": "unhealthy",
			"error":  "redis unavailable",
		})
	}
	if s.pg != nil {
		if err := s.pg.Ping(ctx); err != nil {
			return c.Status(fiber.StatusServiceUnavailable).JSON(fiber.Map{
				"status": "unhealthy",
				"error":  "postgres unavailable",
			})
		}
	}
	return c.JSON(fiber.Map{
		"status": "ready",
		"redis":  "ok",
		"pg":     s.pg != nil,
	})
}
