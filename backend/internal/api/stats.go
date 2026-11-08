package api

import (
	"github.com/gofiber/fiber/v3"
)

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
