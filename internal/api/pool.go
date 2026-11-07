package api

import (
	"encoding/json"
	"strconv"
	"strings"

	"a09f/bottle/internal/store"

	"github.com/gofiber/fiber/v3"
)

type depositRequest struct {
	Keys []store.PoolKey `json:"keys"`
}

func (s *Server) depositKeys(c fiber.Ctx) error {
	var req depositRequest
	if err := bindJSON(c, &req); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid json")
	}
	if len(req.Keys) == 0 || len(req.Keys) > 100 {
		return fiber.NewError(fiber.StatusBadRequest, "keys must contain 1..100 entries")
	}
	for i := range req.Keys {
		if strings.TrimSpace(req.Keys[i].KID) == "" || len(req.Keys[i].KID) > 128 {
			return fiber.NewError(fiber.StatusBadRequest, "invalid kid")
		}
		if strings.TrimSpace(req.Keys[i].PublicKey) == "" || len(req.Keys[i].PublicKey) > 8192 {
			return fiber.NewError(fiber.StatusBadRequest, "invalid publicKey")
		}
		var jwk struct {
			X string `json:"x"`
			Y string `json:"y"`
		}
		if err := json.Unmarshal([]byte(req.Keys[i].PublicKey), &jwk); err != nil || jwk.X == "" || jwk.Y == "" {
			return fiber.NewError(fiber.StatusBadRequest, "invalid publicKey")
		}
		if req.Keys[i].TTLSeconds < 0 || req.Keys[i].TTLSeconds > 2592000 || (req.Keys[i].TTLSeconds > 0 && req.Keys[i].TTLSeconds < 60) {
			return fiber.NewError(fiber.StatusBadRequest, "ttlSeconds must be 0 or 60..2592000")
		}
		req.Keys[i].ExpiresAt = 0
	}
	if err := s.store.DepositKeys(c.Context(), req.Keys); err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "deposit failed")
	}
	return c.JSON(fiber.Map{"accepted": len(req.Keys)})
}

type fetchRequest struct {
	Count int `json:"count"`
}

func (s *Server) fetchKeys(c fiber.Ctx) error {
	var req fetchRequest
	if len(c.Body()) > 0 {
		if err := bindJSON(c, &req); err != nil {
			return fiber.NewError(fiber.StatusBadRequest, "invalid json")
		}
	}
	if req.Count <= 0 {
		req.Count = 2
	}
	if req.Count > 5 {
		req.Count = 5
	}
	keys, err := s.store.FetchKeys(c.Context(), req.Count)
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "fetch failed")
	}
	return c.JSON(fiber.Map{"keys": keys})
}

func (s *Server) listPoolKeys(c fiber.Ctx) error {
	limit := 200
	if raw := c.Query("limit"); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil {
			limit = n
		}
	}
	keys, size, err := s.store.ListPoolKeys(c.Context(), limit)
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "list failed")
	}
	return c.JSON(fiber.Map{"keys": keys, "size": size})
}

func (s *Server) listPoolKids(c fiber.Ctx) error {
	limit := 20000
	if raw := c.Query("limit"); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil {
			limit = n
		}
	}
	kids, size, err := s.store.ListPoolKids(c.Context(), limit)
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "list failed")
	}
	return c.JSON(fiber.Map{"kids": kids, "size": size})
}

