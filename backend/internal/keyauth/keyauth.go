// Package keyauth implements passwordless authentication based purely on
// ECDH P-256 private-key possession.
//
// Identity: a user's id is derived deterministically from their identity
// public key, so re-registering the same key always yields the same user.
//
// Request auth: the client proves possession of the private key by computing
//
//	proof = base64( SHA-256( ecdhShared || utf8(userId) || utf8(strconv(ts)) ) )
//
// where ecdhShared is the 32-byte ECDH result between the user's private key
// and the server's static public key, and ts is a unix timestamp (seconds)
// the server accepts within a ±proofWindowSkew window. No passwords, tokens,
// or sessions are involved; the proof is recomputed on every request.
package keyauth

import (
	"crypto/ecdh"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
)

// ProofWindowSkew is the accepted clock skew for proof timestamps.
const ProofWindowSkew int64 = 300

type jwk struct {
	Kty string `json:"kty"`
	Crv string `json:"crv"`
	X   string `json:"x"`
	Y   string `json:"y"`
	D   string `json:"d,omitempty"`
}

func b64dec(s string) ([]byte, error) {
	return base64.RawURLEncoding.DecodeString(s)
}

func b64enc(b []byte) string {
	return base64.RawURLEncoding.EncodeToString(b)
}

// ParsePublicKey imports an ECDH P-256 public JWK.
func ParsePublicKey(publicJWK string) (*ecdh.PublicKey, error) {
	var j jwk
	if err := json.Unmarshal([]byte(publicJWK), &j); err != nil {
		return nil, fmt.Errorf("invalid jwk: %w", err)
	}
	if j.Kty != "EC" || j.Crv != "P-256" {
		return nil, errors.New("jwk must be EC P-256")
	}
	x, err := b64dec(j.X)
	if err != nil || len(x) != 32 {
		return nil, errors.New("invalid jwk x coordinate")
	}
	y, err := b64dec(j.Y)
	if err != nil || len(y) != 32 {
		return nil, errors.New("invalid jwk y coordinate")
	}
	point := make([]byte, 0, 65)
	point = append(point, 0x04)
	point = append(point, x...)
	point = append(point, y...)
	return ecdh.P256().NewPublicKey(point)
}

// ParsePrivateKey imports an ECDH P-256 private JWK (needs the "d" member).
func ParsePrivateKey(privateJWK string) (*ecdh.PrivateKey, error) {
	var j jwk
	if err := json.Unmarshal([]byte(privateJWK), &j); err != nil {
		return nil, fmt.Errorf("invalid jwk: %w", err)
	}
	if j.Kty != "EC" || j.Crv != "P-256" {
		return nil, errors.New("jwk must be EC P-256")
	}
	d, err := b64dec(j.D)
	if err != nil || len(d) != 32 {
		return nil, errors.New("invalid jwk d scalar")
	}
	return ecdh.P256().NewPrivateKey(d)
}

// PublicJWK exports a public key as a canonical JWK JSON string.
func PublicJWK(pub *ecdh.PublicKey) string {
	b := pub.Bytes() // uncompressed point 0x04||X||Y
	j := jwk{
		Kty: "EC", Crv: "P-256",
		X: b64enc(b[1:33]),
		Y: b64enc(b[33:65]),
	}
	raw, _ := json.Marshal(j)
	return string(raw)
}

// PrivateJWK exports a private key as a canonical JWK JSON string.
func PrivateJWK(priv *ecdh.PrivateKey) string {
	pub := priv.PublicKey()
	b := pub.Bytes()
	j := jwk{
		Kty: "EC", Crv: "P-256",
		X: b64enc(b[1:33]),
		Y: b64enc(b[33:65]),
		D: b64enc(priv.Bytes()),
	}
	raw, _ := json.Marshal(j)
	return string(raw)
}

// GenerateIdentity creates a fresh ECDH P-256 keypair for server-side use.
func GenerateIdentity() (privateJWK, publicJWK string, err error) {
	priv, err := ecdh.P256().GenerateKey(nil)
	if err != nil {
		return "", "", err
	}
	return PrivateJWK(priv), PublicJWK(priv.PublicKey()), nil
}

// UserID derives the deterministic user id from an identity public JWK:
// "u_" + first 16 bytes of SHA-256(x || y), hex encoded.
func UserID(publicJWK string) (string, error) {
	var j jwk
	if err := json.Unmarshal([]byte(publicJWK), &j); err != nil {
		return "", fmt.Errorf("invalid jwk: %w", err)
	}
	x, err := b64dec(j.X)
	if err != nil || len(x) != 32 {
		return "", errors.New("invalid jwk x coordinate")
	}
	y, err := b64dec(j.Y)
	if err != nil || len(y) != 32 {
		return "", errors.New("invalid jwk y coordinate")
	}
	sum := sha256.Sum256(append(append([]byte{}, x...), y...))
	return "u_" + hex.EncodeToString(sum[:16]), nil
}

// SharedSecret computes the ECDH shared secret between priv and peerPub.
func SharedSecret(priv *ecdh.PrivateKey, peerPub *ecdh.PublicKey) ([]byte, error) {
	return priv.ECDH(peerPub)
}

// ProofHash computes the expected proof digest for a request. The nonce is
// a single-use value issued by the server; binding it into the hash makes
// every proof unique per request and kills replay.
func ProofHash(shared []byte, userID string, ts int64, nonce string) []byte {
	h := sha256.New()
	h.Write(shared)
	h.Write([]byte(userID))
	h.Write([]byte(strconv.FormatInt(ts, 10)))
	h.Write([]byte(nonce))
	return h.Sum(nil)
}

// PoPHash computes the kid-scoped proof-of-possession digest:
//
//	SHA-256( ecdhShared || "a09f-pop-v1" || kid || str(ts) )
//
// Unlike ProofHash it is not bound to a userId — it proves control of the
// specific envelope kid's private key so the server can gate kid-filtered
// bottle listings without learning anything about the plaintext.
func PoPHash(shared []byte, kid string, ts int64) []byte {
	h := sha256.New()
	h.Write(shared)
	h.Write([]byte("a09f-pop-v1"))
	h.Write([]byte(kid))
	h.Write([]byte(strconv.FormatInt(ts, 10)))
	return h.Sum(nil)
}

// EncodeProof returns the base64 proof string a client must send.
func EncodeProof(shared []byte, userID string, ts int64, nonce string) string {
	return base64.StdEncoding.EncodeToString(ProofHash(shared, userID, ts, nonce))
}

// DecodeProof parses a base64 proof string.
func DecodeProof(proof string) ([]byte, error) {
	return base64.StdEncoding.DecodeString(proof)
}

// VerifyProof checks a client proof against the server's private key and the
// user's stored public key, including the timestamp freshness window. The
// caller is responsible for consuming the nonce beforehand.
func VerifyProof(serverPriv *ecdh.PrivateKey, userPubJWK, userID string, ts int64, nonce, proofB64 string, now int64) bool {
	if ts <= 0 {
		return false
	}
	delta := now - ts
	if delta < 0 {
		delta = -delta
	}
	if delta > ProofWindowSkew {
		return false
	}
	if nonce == "" {
		return false
	}
	userPub, err := ParsePublicKey(userPubJWK)
	if err != nil {
		return false
	}
	shared, err := serverPriv.ECDH(userPub)
	if err != nil {
		return false
	}
	got, err := DecodeProof(proofB64)
	if err != nil {
		return false
	}
	want := ProofHash(shared, userID, ts, nonce)
	return subtle.ConstantTimeCompare(got, want) == 1
}
