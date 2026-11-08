package api

import (
	"crypto/ecdh"
	"encoding/base64"
	"testing"
	"time"

	"a09f/bottle/internal/keyauth"
)

// makeKidProof mirrors the client side: ECDH(kidPriv, serverPub) then
// PoPHash, base64-encoded.
func makeKidProof(t *testing.T, kidPriv *ecdh.PrivateKey, serverPub *ecdh.PublicKey, kid string, ts int64) string {
	t.Helper()
	shared, err := kidPriv.ECDH(serverPub)
	if err != nil {
		t.Fatal(err)
	}
	return base64.StdEncoding.EncodeToString(keyauth.PoPHash(shared, kid, ts))
}

func TestKidProofValid(t *testing.T) {
	serverPrivJWK, serverPubJWK, err := keyauth.GenerateIdentity()
	if err != nil {
		t.Fatal(err)
	}
	serverPriv, err := keyauth.ParsePrivateKey(serverPrivJWK)
	if err != nil {
		t.Fatal(err)
	}
	serverPub, err := keyauth.ParsePublicKey(serverPubJWK)
	if err != nil {
		t.Fatal(err)
	}

	kidPriv, err := ecdh.P256().GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	kidPubJWK := keyauth.PublicJWK(kidPriv.PublicKey())
	kid := "kid-test-1"
	ts := time.Now().Unix()
	proof := makeKidProof(t, kidPriv, serverPub, kid, ts)
	now := time.Now().Unix()

	if !kidProofValid(serverPriv, []string{kidPubJWK}, kid, ts, proof, now) {
		t.Fatal("valid kid proof rejected")
	}

	// Wrong kid rejected.
	if kidProofValid(serverPriv, []string{kidPubJWK}, "other-kid", ts, proof, now) {
		t.Fatal("proof accepted for different kid")
	}
	// Stale timestamp rejected.
	if kidProofValid(serverPriv, []string{kidPubJWK}, kid, ts, proof, now+keyauth.ProofWindowSkew+1) {
		t.Fatal("stale proof accepted")
	}
	// Proof from a different private key rejected.
	otherPriv, _ := ecdh.P256().GenerateKey(nil)
	otherProof := makeKidProof(t, otherPriv, serverPub, kid, ts)
	if kidProofValid(serverPriv, []string{kidPubJWK}, kid, ts, otherProof, now) {
		t.Fatal("proof from wrong private key accepted")
	}
	// Unknown pubkey rejected.
	if kidProofValid(serverPriv, []string{}, kid, ts, proof, now) {
		t.Fatal("proof accepted with no candidate pubkeys")
	}
	// Garbage proof rejected.
	if kidProofValid(serverPriv, []string{kidPubJWK}, kid, ts, "!!!not-base64!!!", now) {
		t.Fatal("malformed proof accepted")
	}
	// Multiple candidate pubkeys: one match is enough.
	otherKeyPriv, _ := ecdh.P256().GenerateKey(nil)
	otherPubJWK := keyauth.PublicJWK(otherKeyPriv.PublicKey())
	if !kidProofValid(serverPriv, []string{otherPubJWK, kidPubJWK}, kid, ts, proof, now) {
		t.Fatal("valid proof rejected when mixed with unrelated pubkey")
	}
}
