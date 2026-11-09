package api

import (
	"context"
	"crypto/ecdh"
	"sync"
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
	cfg    config.Config
	store  *store.Store
	pg     *pgstore.PGStore
	events *eventHub

	authOnce sync.Once
	authPriv *ecdh.PrivateKey
	authErr  error

	metrics *metrics

	devMu   sync.Mutex
	devSeen map[string]int64
}

func New(ctx context.Context, cfg config.Config, st *store.Store, pg *pgstore.PGStore) *fiber.App {
	s := &Server{cfg: cfg, store: st, pg: pg, events: newEventHub(), metrics: newMetrics(), devSeen: map[string]int64{}}
	if pg != nil {
		go s.rebuildPool(ctx)
		go s.pgReconciler(ctx)
		go s.pgOutboxWorker(ctx)
		go s.retentionWorker(ctx)
	}
	app := fiber.New(fiber.Config{
		BodyLimit:   4 * 1024 * 1024,
		ProxyHeader: fiber.HeaderXForwardedFor,
		// The backend binds to 127.0.0.1 — only the local nginx reaches it.
		// Trusting loopback proxies lets c.IP() resolve the real client IP
		// from X-Forwarded-For (rightmost untrusted entry) so per-IP rate
		// limits key on the actual client. Direct/external connections keep
		// their TCP peer IP and cannot spoof XFF.
		TrustProxyConfig: fiber.TrustProxyConfig{Loopback: true},
	})

	app.Use(logger.New())
	app.Use(helmet.New())
	app.Use(sentryRecovery())
	app.Use(cors.New(cors.Config{
		AllowOrigins: []string{"*"},
		AllowMethods: []string{"GET", "POST", "DELETE", "HEAD", "OPTIONS"},
		AllowHeaders: []string{"Content-Type", "X-User-Id", "X-Auth-Ts", "X-Auth-Nonce", "X-Auth-Proof", "X-Device-Id"},
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

	userLimiter := limiter.New(limiter.Config{
		Max:        30,
		Expiration: 1 * time.Minute,
		LimitReached: func(c fiber.Ctx) error {
			return fiber.NewError(fiber.StatusTooManyRequests, "user rate limit exceeded")
		},
	})
	nonceLimiter := limiter.New(limiter.Config{
		Max:        120,
		Expiration: 1 * time.Minute,
		LimitReached: func(c fiber.Ctx) error {
			return fiber.NewError(fiber.StatusTooManyRequests, "nonce rate limit exceeded")
		},
	})
	reportLimiter := limiter.New(limiter.Config{
		Max:        10,
		Expiration: 1 * time.Minute,
		LimitReached: func(c fiber.Ctx) error {
			return fiber.NewError(fiber.StatusTooManyRequests, "report rate limit exceeded")
		},
	})

	app.Get("/api/metrics", s.metricsHandler)
	app.Get("/api/health", s.health)
	app.Get("/api/ip", s.clientIP)
	app.Get("/api/health/live", s.live)
	app.Get("/api/health/ready", s.ready)
	app.Post("/api/pool/deposit", depositLimiter, s.depositKeys)
	app.Post("/api/pool/fetch", fetchLimiter, s.fetchKeys)
	app.Post("/api/pool/status", fetchLimiter, s.poolStatus)
	app.Get("/api/pool/keys", s.listPoolKeys)
	app.Get("/api/pool/kids", s.listPoolKids)
	app.Post("/api/bottles", bottleLimiter, s.createBottle)
	app.Get("/api/bottles", s.listBottles)
	app.Get("/api/bottles/:id/children", s.listBottleChildren)
	app.Get("/api/events", s.streamEvents)
	app.Post("/api/bottles/:id/pickup", bottleLimiter, s.pickupBottle)
	app.Post("/api/bottles/:id/report", reportLimiter, s.reportBottle)
	app.Delete("/api/bottles/:id", userLimiter, s.deleteBottle)
	app.Get("/api/auth/server-key", s.serverKey)
	app.Post("/api/auth/nonce", nonceLimiter, s.issueNonce)
	app.Post("/api/auth/pop-token", nonceLimiter, s.popToken)
	app.Post("/api/users", userLimiter, s.registerUser)
	app.Get("/api/me", s.me)
	app.Get("/api/me/devices", s.listDevices)
	app.Delete("/api/me/devices/:deviceId", userLimiter, s.revokeDevice)
	app.Post("/api/me/username", userLimiter, s.changeUsername)
	app.Delete("/api/me", userLimiter, s.deleteMe)
	app.Get("/api/me/stats", s.meStats)
	app.Get("/api/users/by-username/:username", s.getUserByUsername)
	app.Get("/api/users/:id", s.getUser)
	app.Post("/api/users/:id/block", userLimiter, s.blockUser)
	app.Delete("/api/users/:id/block", userLimiter, s.unblockUser)
	app.Get("/api/me/blocks", s.listBlocks)
	app.Post("/api/sync/records", userLimiter, s.syncRecords)
	app.Post("/api/users/:id/report", reportLimiter, s.reportUser)

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
