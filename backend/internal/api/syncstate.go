package api

import (
	"errors"
	"time"

	"a09f/bottle/internal/keyauth"

	"github.com/gofiber/fiber/v3"
	"github.com/jackc/pgx/v5"
)

// syncStateRequest doubles as the auth envelope and the payload. When Blob
// is empty the endpoint returns the stored blob; when set it upserts it.
// Auth is the same nonce + proof-of-possession used at registration, so it
// works for anonymous identities that never claimed a username.
type syncStateRequest struct {
	PublicKey string `json:"publicKey"`
	UserID    string `json:"userId"`
	Ts        int64  `json:"ts"`
	Nonce     string `json:"nonce"`
	Proof     string `json:"proof"`
	Blob      string `json:"blob,omitempty"`
}

// verifySyncAuth validates the identity proof and returns the canonical
// user id derived from the presented public key.
func (s *Server) verifySyncAuth(c fiber.Ctx, req *syncStateRequest) (string, error) {
	if s.pg == nil {
		return "", fiber.NewError(fiber.StatusServiceUnavailable, "sync unavailable")
	}
	if len(req.PublicKey) == 0 || len(req.PublicKey) > 8192 {
		return "", fiber.NewError(fiber.StatusBadRequest, "invalid publicKey")
	}
	userID, err := keyauth.UserID(req.PublicKey)
	if err != nil {
		return "", fiber.NewError(fiber.StatusBadRequest, "invalid publicKey")
	}
	if req.UserID != "" && req.UserID != userID {
		return "", fiber.NewError(fiber.StatusBadRequest, "userId does not match publicKey")
	}
	priv, err := s.authKey()
	if err != nil {
		return "", fiber.NewError(fiber.StatusInternalServerError, "auth key unavailable")
	}
	ok, err := s.store.ConsumeNonce(c.Context(), req.Nonce, userID)
	if err != nil || !ok {
		return "", fiber.NewError(fiber.StatusUnauthorized, "invalid or used nonce")
	}
	if !keyauth.VerifyProof(priv, req.PublicKey, userID, req.Ts, req.Nonce, req.Proof, time.Now().Unix()) {
		return "", fiber.NewError(fiber.StatusUnauthorized, "invalid proof")
	}
	return userID, nil
}

// syncState stores/returns the client's encrypted state blob. The server
// only ever sees ciphertext it cannot decrypt.
func (s *Server) syncState(c fiber.Ctx) error {
	var req syncStateRequest
	if err := bindJSON(c, &req); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid json")
	}
	userID, err := s.verifySyncAuth(c, &req)
	if err != nil {
		return err
	}
	if req.Blob == "" {
		blob, updated, err := s.pg.GetSyncState(c.Context(), userID)
		if errors.Is(err, pgx.ErrNoRows) {
			return c.JSON(fiber.Map{})
		}
		if err != nil {
			return fiber.NewError(fiber.StatusInternalServerError, "lookup failed")
		}
		return c.JSON(fiber.Map{"blob": blob, "updatedAt": updated})
	}
	if len(req.Blob) > 256*1024 {
		return fiber.NewError(fiber.StatusBadRequest, "blob too large")
	}
	if err := s.pg.PutSyncState(c.Context(), userID, req.Blob); err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "save failed")
	}
	return c.JSON(fiber.Map{"ok": true})
}
