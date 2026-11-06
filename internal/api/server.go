package api

import (
	"context"
	"encoding/json"
	"io/fs"
	"log"
	"mime"
	"path"
	"strconv"
	"strings"
	"time"

	"a09f/bottle/internal/config"
	"a09f/bottle/internal/pgstore"
	"a09f/bottle/internal/store"
	"a09f/bottle/web"

	"github.com/gofiber/fiber/v3"
)

type Server struct {
	cfg   config.Config
	store *store.Store
	pg    *pgstore.PGStore
}

func New(cfg config.Config, st *store.Store, pg *pgstore.PGStore) *fiber.App {
	s := &Server{cfg: cfg, store: st, pg: pg}
	app := fiber.New(fiber.Config{
		BodyLimit: 4 * 1024 * 1024,
	})

	app.Get("/api/health", s.health)
	app.Post("/api/pool/deposit", s.depositKeys)
	app.Post("/api/pool/fetch", s.fetchKeys)
	app.Get("/api/pool/keys", s.listPoolKeys)
	app.Get("/api/pool/kids", s.listPoolKids)
	app.Post("/api/bottles", s.createBottle)
	app.Get("/api/bottles", s.listBottles)
	app.Post("/api/bottles/:id/pickup", s.pickupBottle)

	app.Use(s.serveStatic)
	return app
}

func (s *Server) health(c fiber.Ctx) error {
	return c.JSON(fiber.Map{"ok": true, "time": time.Now().UTC().Format(time.RFC3339)})
}

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

func (s *Server) createBottle(c fiber.Ctx) error {
	var bottle store.Bottle
	if err := bindJSON(c, &bottle); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid json")
	}
	if err := validateBottle(bottle); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, err.Error())
	}
	bottle.CreatedAt = time.Now().Unix()
	bottle.Deliveries = 0
	bottle.Status = "ACTIVE"
	bottle.DeliveredKids = nil
	if bottle.Depth <= 0 {
		bottle.Depth = 1
	}
	if err := s.store.CreateBottle(c.Context(), bottle); err != nil {
		if err == store.ErrBottleExists {
			return fiber.NewError(fiber.StatusConflict, "bottle id already exists")
		}
		return fiber.NewError(fiber.StatusInternalServerError, "create failed")
	}
	if s.pg != nil {
		if err := s.pg.SaveBottle(c.Context(), bottle); err != nil {
			log.Printf("pg save bottle %s: %v", bottle.ID, err)
		}
	}
	return c.Status(fiber.StatusCreated).JSON(fiber.Map{"id": bottle.ID, "status": bottle.Status})
}

func validateBottle(b store.Bottle) error {
	if len(b.ID) < 8 || len(b.ID) > 128 || !validBottleID(b.ID) {
		return fiber.NewError(fiber.StatusBadRequest, "invalid id")
	}
	if b.MaxDeliveries < 1 || b.MaxDeliveries > 5 {
		return fiber.NewError(fiber.StatusBadRequest, "maxDeliveries must be 1..5")
	}
	if b.Depth < 0 || b.Depth > 20 {
		return fiber.NewError(fiber.StatusBadRequest, "depth must be 0..20")
	}
	if b.ParentID != "" && (len(b.ParentID) > 128 || !validBottleID(b.ParentID)) {
		return fiber.NewError(fiber.StatusBadRequest, "invalid parentId")
	}
	if len(b.Envelopes) != b.MaxDeliveries {
		return fiber.NewError(fiber.StatusBadRequest, "envelope count must equal maxDeliveries")
	}
	if b.PayloadIV == "" || b.Ciphertext == "" {
		return fiber.NewError(fiber.StatusBadRequest, "payload fields required")
	}
	for _, env := range b.Envelopes {
		if env.KID == "" || env.AuthorPublicKey == "" || env.WrapIV == "" || env.WrappedKey == "" {
			return fiber.NewError(fiber.StatusBadRequest, "incomplete envelope")
		}
	}
	return nil
}

func validBottleID(id string) bool {
	for _, r := range id {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' {
			continue
		}
		return false
	}
	return true
}

func (s *Server) listBottles(c fiber.Ctx) error {
	limit := 50
	if raw := c.Query("limit"); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil {
			limit = n
		}
	}
	if limit <= 0 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}
	bottles, err := s.store.ListBottles(c.Context(), limit)
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "list failed")
	}
	if s.pg != nil {
		pgBottles, err := s.pg.ListBottles(c.Context(), limit)
		if err != nil {
			log.Printf("pg list bottles: %v", err)
		} else {
			seen := make(map[string]bool, len(bottles))
			for _, b := range bottles {
				seen[b.ID] = true
			}
			for _, b := range pgBottles {
				if !seen[b.ID] {
					bottles = append(bottles, b)
				}
			}
		}
	}
	return c.JSON(fiber.Map{"bottles": bottles})
}

type pickupRequest struct {
	KID string `json:"kid"`
}

func (s *Server) pickupBottle(c fiber.Ctx) error {
	var req pickupRequest
	if err := bindJSON(c, &req); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid json")
	}
	if strings.TrimSpace(req.KID) == "" || len(req.KID) > 128 {
		return fiber.NewError(fiber.StatusBadRequest, "invalid kid")
	}
	result, err := s.store.Pickup(c.Context(), c.Params("id"), req.KID)
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "pickup failed")
	}
	if !result.OK {
		return c.Status(fiber.StatusConflict).JSON(result)
	}
	if s.pg != nil {
		go s.archiveBottle(context.Background(), c.Params("id"))
	}
	return c.JSON(result)
}

func (s *Server) archiveBottle(ctx context.Context, id string) {
	bottle, err := s.store.GetBottle(ctx, id)
	if err != nil {
		log.Printf("pg archive fetch %s: %v", id, err)
		return
	}
	if err := s.pg.SaveBottle(ctx, bottle); err != nil {
		log.Printf("pg archive %s: %v", id, err)
	}
}

func bindJSON(c fiber.Ctx, v any) error {
	if len(c.Body()) == 0 {
		return fiber.NewError(fiber.StatusBadRequest, "empty body")
	}
	return json.Unmarshal(c.Body(), v)
}

func (s *Server) serveStatic(c fiber.Ctx) error {
	if c.Method() != fiber.MethodGet && c.Method() != fiber.MethodHead {
		return c.Next()
	}
	raw := c.Path()
	if strings.HasPrefix(raw, "/api/") {
		return c.Next()
	}
	name := strings.TrimPrefix(raw, "/")
	if name == "" {
		name = "index.html"
	}
	name = path.Clean(name)
	if strings.HasPrefix(name, "../") || name == ".." {
		return c.Status(fiber.StatusNotFound).SendString("not found")
	}
	data, err := fs.ReadFile(web.FS, name)
	if err != nil {
		return c.Status(fiber.StatusNotFound).SendString("not found")
	}
	contentType := mime.TypeByExtension(path.Ext(name))
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	c.Set("Content-Type", contentType)
	c.Set("Cache-Control", "no-store")
	return c.Send(data)
}
