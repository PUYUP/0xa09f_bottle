package api

import (
	"strings"

	"github.com/gofiber/fiber/v3"
)

// clientIP echoes the requester's IP as seen by the server (proxy-aware).
// Used by clients to display their own network metadata.
func (s *Server) clientIP(c fiber.Ctx) error {
	ip := c.Get("X-Real-IP")
	if ip == "" {
		if xff := c.Get("X-Forwarded-For"); xff != "" {
			ip = strings.TrimSpace(strings.Split(xff, ",")[0])
		}
	}
	if ip == "" {
		ip = c.IP()
	}
	return c.JSON(fiber.Map{"ip": ip})
}

// meStats returns server-computed activity stats for the authenticated user.
// Everything is derived from stored metadata (self envelopes, delivered
// kids, user_keys) — no plaintext ever involved.
func (s *Server) meStats(c fiber.Ctx) error {
	if s.pg == nil {
		return fiber.NewError(fiber.StatusServiceUnavailable, "stats unavailable")
	}
	user, err := s.requireAuth(c)
	if err != nil {
		return err
	}
	stats, err := s.pg.UserStats(c.Context(), user.ID)
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "stats failed")
	}
	return c.JSON(fiber.Map{"stats": stats})
}
