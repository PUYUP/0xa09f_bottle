package api

import (
	"time"

	"a09f/bottle/internal/keyauth"

	"github.com/gofiber/fiber/v3"
)

// syncAuthRequest is the auth envelope shared by the sync endpoints. Auth is
// the same nonce + proof-of-possession used at registration, so it works for
// anonymous identities that never claimed a username.
type syncAuthRequest struct {
	PublicKey string `json:"publicKey"`
	UserID    string `json:"userId"`
	Ts        int64  `json:"ts"`
	Nonce     string `json:"nonce"`
	Proof     string `json:"proof"`
}

// verifySyncAuth validates the identity proof and returns the canonical
// user id derived from the presented public key.
func (s *Server) verifySyncAuth(c fiber.Ctx, req *syncAuthRequest) (string, error) {
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

type syncRecordEntry struct {
	Key       string `json:"key"`
	Blob      string `json:"blob"`
	UpdatedAt int64  `json:"updatedAt,omitempty"`
}

type syncRecordsRequest struct {
	PublicKey string            `json:"publicKey"`
	UserID    string            `json:"userId"`
	Ts        int64             `json:"ts"`
	Nonce     string            `json:"nonce"`
	Proof     string            `json:"proof"`
	Records   []syncRecordEntry `json:"records,omitempty"`
	Since     int64             `json:"since,omitempty"`
}

// syncRecords is the encrypted per-record sync endpoint: clients push deltas
// of encrypted fields and pull them back (optionally only those updated
// after `since`). record_key is a client-computed salted hash and blob is
// ciphertext — the server learns only how many fields exist and when they
// were last written.
func (s *Server) syncRecords(c fiber.Ctx) error {
	var req syncRecordsRequest
	if err := bindJSON(c, &req); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid json")
	}
	auth := syncAuthRequest{
		PublicKey: req.PublicKey,
		UserID:    req.UserID,
		Ts:        req.Ts,
		Nonce:     req.Nonce,
		Proof:     req.Proof,
	}
	userID, err := s.verifySyncAuth(c, &auth)
	if err != nil {
		return err
	}
	if len(req.Records) == 0 {
		recs, err := s.pg.ListSyncRecords(c.Context(), userID, req.Since)
		if err != nil {
			return fiber.NewError(fiber.StatusInternalServerError, "lookup failed")
		}
		out := make([]syncRecordEntry, 0, len(recs))
		for _, r := range recs {
			out = append(out, syncRecordEntry{Key: r.Key, Blob: r.Blob, UpdatedAt: r.UpdatedAt})
		}
		return c.JSON(fiber.Map{"records": out})
	}
	if len(req.Records) > 500 {
		return fiber.NewError(fiber.StatusBadRequest, "too many records")
	}
	keys := make([]string, 0, len(req.Records))
	blobs := make([]string, 0, len(req.Records))
	for _, r := range req.Records {
		if len(r.Key) != 64 || len(r.Blob) == 0 || len(r.Blob) > 4096 {
			return fiber.NewError(fiber.StatusBadRequest, "invalid record")
		}
		keys = append(keys, r.Key)
		blobs = append(blobs, r.Blob)
	}
	if err := s.pg.UpsertSyncRecords(c.Context(), userID, keys, blobs); err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "save failed")
	}
	return c.JSON(fiber.Map{"ok": true})
}
