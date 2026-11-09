package api

import (
	"crypto/ecdh"
	"crypto/subtle"
	"encoding/base64"
	"log"
	"strings"
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
		if len(kids) >= 2000 {
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
		// One batched pubkey lookup for the whole kid set instead of a
		// query per kid — keeps issuance O(1) round-trips at any pool size.
		pubsMap, err := s.pg.PubkeysForKids(c.Context(), kids)
		if err != nil {
			log.Printf("pg pubkeys for kids: %v", err)
			return fiber.NewError(fiber.StatusInternalServerError, "pubkey lookup failed")
		}
		// Redis fallback: a fresh bottle's bottle_kids row lands only after
		// syncBottlePG commits, so kids like reply:<id> would be unprovable
		// for the sync gap even though the envelope pubkey is already live.
		missing := make([]string, 0)
		for _, kid := range kids {
			if len(pubsMap[kid]) == 0 {
				missing = append(missing, kid)
			}
		}
		if len(missing) > 0 {
			if redisPubs, err := s.store.PubkeysForKids(c.Context(), missing); err != nil {
				log.Printf("redis pubkeys for kids: %v", err)
			} else {
				for k, pubs := range redisPubs {
					pubsMap[k] = append(pubsMap[k], pubs...)
				}
			}
		}
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
			if kidProofValid(serverPriv, pubsMap[kid], kid, p.Ts, p.Proof, now) {
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
	if len(verified) < len(kids) {
		vset := make(map[string]struct{}, len(verified))
		for _, k := range verified {
			vset[k] = struct{}{}
		}
		missing := make([]string, 0, len(kids)-len(verified))
		for _, k := range kids {
			if _, ok := vset[k]; !ok {
				missing = append(missing, k)
			}
		}
		if len(missing) > 5 {
			missing = missing[:5]
		}
		log.Printf("pop-token partial: %d/%d kids verified, missing e.g. %v", len(verified), len(kids), missing)
	}

	// Verified-set expansion: when the request proves the identity kid
	// (self:<userId>), merge this request's verified kids into the user's
	// remembered set so subsequent tokens only need proofs for new kids.
	// The set is bound to userId — proving it requires the identity private
	// key, so a stolen pool key cannot expand access to sibling kids.
	final := verified
	if s.pg != nil {
		var bindUID string
		for _, k := range verified {
			if strings.HasPrefix(k, "self:") {
				bindUID = strings.TrimPrefix(k, "self:")
				break
			}
		}
		if bindUID != "" {
			if stored, err := s.store.PopSetGet(c.Context(), bindUID); err == nil && len(stored) > 0 {
				seenSet := make(map[string]struct{}, len(stored)+len(verified))
				for _, k := range stored {
					seenSet[k] = struct{}{}
				}
				for _, k := range verified {
					seenSet[k] = struct{}{}
				}
				merged := make([]string, 0, len(seenSet))
				for k := range seenSet {
					merged = append(merged, k)
				}
				final = merged
			}
			if err := s.store.PopSetPut(c.Context(), bindUID, final); err != nil {
				log.Printf("pop set put %s: %v", bindUID, err)
			}
		}
	}

	token, err := s.store.IssuePopToken(c.Context(), final)
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "token issue failed")
	}
	return c.JSON(fiber.Map{
		"token":     token,
		"kids":      final,
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
