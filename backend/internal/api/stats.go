package api

import (
	"github.com/gofiber/fiber/v3"
)

// clientIP echoes the requester's IP as seen by the server. c.IP() is
// proxy-aware (loopback-trusted X-Forwarded-For) so the value reflects the
// real client and cannot be spoofed by request headers.
func (s *Server) clientIP(c fiber.Ctx) error {
	return c.JSON(fiber.Map{"ip": c.IP()})
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
