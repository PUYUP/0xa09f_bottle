package api

import (
	"context"
	"crypto/subtle"
	"sync"
	"time"

	"github.com/gofiber/fiber/v3"
)

// metrics keeps lightweight in-process counters for operational visibility.
// Resets on restart — it complements, not replaces, external monitoring.
type metrics struct {
	mu     sync.Mutex
	counts map[string]uint64
}

func newMetrics() *metrics {
	return &metrics{counts: map[string]uint64{}}
}

func (m *metrics) inc(name string) {
	m.mu.Lock()
	m.counts[name]++
	m.mu.Unlock()
}

func (m *metrics) snapshot() map[string]uint64 {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make(map[string]uint64, len(m.counts))
	for k, v := range m.counts {
		out[k] = v
	}
	return out
}

// metricsHandler exposes GET /api/metrics: request counters, live gauges
// (pool size, PG outbox depth) and a small alerts list for conditions that
// need operator attention.
func (s *Server) metricsHandler(c fiber.Ctx) error {
	// When METRICS_TOKEN is configured the endpoint requires the matching
	// X-Metrics-Token header; unset means open access (local dev only).
	if s.cfg.MetricsToken != "" {
		got := c.Get("X-Metrics-Token")
		if subtle.ConstantTimeCompare([]byte(got), []byte(s.cfg.MetricsToken)) != 1 {
			return fiber.NewError(fiber.StatusUnauthorized, "metrics token required")
		}
	}

	ctx, cancel := context.WithTimeout(c.Context(), 2*time.Second)
	deps := fiber.Map{}
	deps["store"] = s.store.Ping(ctx) == nil
	deps["pg_only"] = s.pgBacked
	if s.pg != nil && !s.pgBacked {
		deps["pg"] = s.pg.Ping(ctx) == nil
	}
	cancel()

	poolSize, _ := s.store.PoolSize(c.Context())
	outboxDepth, _ := s.store.PGOutboxLen(c.Context())

	alerts := []string{}
	if outboxDepth > 100 {
		alerts = append(alerts, "pg_outbox_backlog")
	}
	if ok, _ := deps["store"].(bool); !ok {
		alerts = append(alerts, "store_down")
	}
	if s.pg != nil {
		if ok, _ := deps["pg"].(bool); !ok {
			alerts = append(alerts, "pg_down")
		}
	}

	return c.JSON(fiber.Map{
		"uptimeSec": time.Since(startedAt).Seconds(),
		"counters":  s.metrics.snapshot(),
		"gauges": fiber.Map{
			"poolKeys":    poolSize,
			"outboxDepth": outboxDepth,
		},
		"deps":   deps,
		"alerts": alerts,
	})
}

var startedAt = time.Now()
