package api

import (
	"context"
	"crypto/ecdh"
	"strconv"
	"time"

	"a09f/bottle/internal/keyauth"
	"a09f/bottle/internal/pgstore"

	"github.com/gofiber/fiber/v3"
)

// Proof-of-possession headers sent by clients on authenticated requests:
//
//	X-User-Id:    the user id derived from the identity public key
//	X-Auth-Ts:    unix timestamp (seconds) used in the proof
//	X-Auth-Nonce: single-use nonce issued by POST /api/auth/nonce
//	X-Auth-Proof: base64 SHA-256( ecdhShared || userId || ts || nonce )
//
// where ecdhShared is ECDH(userPrivateKey, serverPublicKey). The server
// verifies by recomputing ECDH(serverPrivateKey, userPublicKey). The nonce
// is consumed atomically (GETDEL) so each proof works exactly once —
// replaying captured headers always fails.

// authKey lazily loads and parses the server's static ECDH identity.
func (s *Server) authKey() (*ecdh.PrivateKey, error) {
	s.authOnce.Do(func() {
		id, err := s.store.AuthIdentity(context.Background())
		if err != nil {
			s.authErr = err
			return
		}
		s.authPriv, s.authErr = keyauth.ParsePrivateKey(id.PrivateJWK)
	})
	return s.authPriv, s.authErr
}

// authUser verifies the proof headers and returns the user, or ok=false for
// anonymous/invalid requests. It never rejects the request itself — callers
// decide whether auth is optional or required.
func (s *Server) authUser(c fiber.Ctx) (pgstore.User, bool) {
	if s.pg == nil {
		return pgstore.User{}, false
	}
	uid := c.Get("X-User-Id")
	tsRaw := c.Get("X-Auth-Ts")
	nonce := c.Get("X-Auth-Nonce")
	proof := c.Get("X-Auth-Proof")
	if uid == "" || tsRaw == "" || nonce == "" || proof == "" ||
		len(uid) > 64 || len(nonce) > 128 || len(proof) > 512 {
		return pgstore.User{}, false
	}
	ts, err := strconv.ParseInt(tsRaw, 10, 64)
	if err != nil {
		return pgstore.User{}, false
	}
	user, err := s.pg.GetUserByID(c.Context(), uid)
	if err != nil {
		return pgstore.User{}, false
	}
	priv, err := s.authKey()
	if err != nil {
		return pgstore.User{}, false
	}
	// Consume the nonce before verifying: GETDEL is atomic, so of two
	// concurrent requests carrying the same nonce exactly one proceeds.
	ok, err := s.store.ConsumeNonce(c.Context(), nonce, uid)
	if err != nil || !ok {
		return pgstore.User{}, false
	}
	if !keyauth.VerifyProof(priv, user.PublicKey, uid, ts, nonce, proof, time.Now().Unix()) {
		return pgstore.User{}, false
	}
	return user, true
}

// requireAuth returns the authenticated user or a 401/503 error.
func (s *Server) requireAuth(c fiber.Ctx) (pgstore.User, error) {
	if s.pg == nil {
		return pgstore.User{}, fiber.NewError(fiber.StatusServiceUnavailable, "auth unavailable")
	}
	user, ok := s.authUser(c)
	if !ok {
		return pgstore.User{}, fiber.NewError(fiber.StatusUnauthorized, "valid proof-of-possession required")
	}
	return user, nil
}
