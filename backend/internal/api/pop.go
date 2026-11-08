package api

import (
	"crypto/ecdh"
	"crypto/subtle"
	"encoding/base64"
	"log"
	"time"

	"a09f/bottle/internal/keyauth"

	"github.com/gofiber/fiber/v3"
)

// popProof is one kid's possession proof: ts (unix seconds) + base64
// SHA-256(ecdhShared || "a09f-pop-v1" || kid || ts) where ecdhShared is the
// ECDH result between the kid's private key and the server identity key.
type popProof struct {
	Ts    int64  `json:"ts"`
	Proof string `json:"proof"`
}

type popTokenRequest struct {
	Kids   []string            `json:"kids"`
	Proofs map[string]popProof `json:"proofs"`
}

func validPopKid(kid string) bool {
	if kid == "" || len(kid) > 128 {
		return false
	}
	for _, r := range kid {
		if r < 0x20 || r > 0x7e {
			return false
		}
	}
	return true
}

// popToken verifies proof-of-possession for a set of envelope kids and
// issues a short-lived token authorizing kid-filtered bottle access.
// The server learns nothing new: pubkeys it checks against are the
// recipientPublicKey values clients embedded in envelopes at cast time.
func (s *Server) popToken(c fiber.Ctx) error {
	var req popTokenRequest
	if err := bindJSON(c, &req); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid json")
	}
	seen := make(map[string]struct{}, len(req.Kids))
	kids := make([]string, 0, len(req.Kids))
	for _, kid := range req.Kids {
		if !validPopKid(kid) {
			continue
		}
		if _, dup := seen[kid]; dup {
			continue
		}
		seen[kid] = struct{}{}
		kids = append(kids, kid)
		if len(kids) >= 300 {
			break
		}
	}
	if len(kids) == 0 {
		return fiber.NewError(fiber.StatusBadRequest, "no valid kids")
	}

	verified := kids
	if s.pg != nil {
		verified = nil
		serverPriv, err := s.authKey()
		if err != nil {
			return fiber.NewError(fiber.StatusInternalServerError, "auth key unavailable")
		}
		now := time.Now().Unix()
		for _, kid := range kids {
			p, ok := req.Proofs[kid]
			if !ok || p.Ts <= 0 {
				continue
			}
			delta := now - p.Ts
			if delta < 0 {
				delta = -delta
			}
			if delta > keyauth.ProofWindowSkew {
				continue
			}
			pubs, err := s.pg.PubkeysForKid(c.Context(), kid)
			if err != nil {
				log.Printf("pg pubkeys for kid: %v", err)
				continue
			}
			if kidProofValid(serverPriv, pubs, kid, p.Ts, p.Proof, now) {
				verified = append(verified, kid)
			}
		}
	} else {
		// No Postgres: pubkey registry unavailable, cannot verify PoP.
		// Dev-mode fallback trusts the claimed kid set.
		log.Printf("pop-token: pg disabled, skipping proof verification")
	}

	if len(verified) == 0 {
		return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"error": "no_valid_proofs"})
	}
	token, err := s.store.IssuePopToken(c.Context(), verified)
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "token issue failed")
	}
	return c.JSON(fiber.Map{
		"token":     token,
		"kids":      verified,
		"expiresIn": 600,
	})
}

// kidProofValid reports whether proofB64 matches PoPHash computed with the
// ECDH shared secret between the server private key and ANY of the candidate
// recipient pubkeys for kid. Multiple pubkeys may exist for a kid (key
// rotation, legacy rows); one valid match is enough.
func kidProofValid(serverPriv *ecdh.PrivateKey, pubJWKs []string, kid string, ts int64, proofB64 string, now int64) bool {
	if ts <= 0 {
		return false
	}
	delta := now - ts
	if delta < 0 {
		delta = -delta
	}
	if delta > keyauth.ProofWindowSkew {
		return false
	}
	got, err := base64.StdEncoding.DecodeString(proofB64)
	if err != nil {
		return false
	}
	for _, pubJWK := range pubJWKs {
		pub, err := keyauth.ParsePublicKey(pubJWK)
		if err != nil {
			continue
		}
		shared, err := serverPriv.ECDH(pub)
		if err != nil {
			continue
		}
		if subtle.ConstantTimeCompare(got, keyauth.PoPHash(shared, kid, ts)) == 1 {
			return true
		}
	}
	return false
}
