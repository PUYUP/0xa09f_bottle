package keyauth

import (
	"crypto/ecdh"
	"testing"
	"time"
)

func TestProofRoundTrip(t *testing.T) {
	// Server identity.
	serverPrivJWK, serverPubJWK, err := GenerateIdentity()
	if err != nil {
		t.Fatal(err)
	}
	serverPriv, err := ParsePrivateKey(serverPrivJWK)
	if err != nil {
		t.Fatal(err)
	}
	serverPub, err := ParsePublicKey(serverPubJWK)
	if err != nil {
		t.Fatal(err)
	}

	// User identity.
	userPriv, err := ecdh.P256().GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	userPubJWK := PublicJWK(userPriv.PublicKey())
	userID, err := UserID(userPubJWK)
	if err != nil {
		t.Fatal(err)
	}
	if len(userID) != 34 || userID[:2] != "u_" {
		t.Fatalf("unexpected user id %q", userID)
	}

	// Client side: ECDH(userPriv, serverPub) then proof.
	shared, err := userPriv.ECDH(serverPub)
	if err != nil {
		t.Fatal(err)
	}
	ts := time.Now().Unix()
	nonce := "testnonce123"
	proof := EncodeProof(shared, userID, ts, nonce)

	if !VerifyProof(serverPriv, userPubJWK, userID, ts, nonce, proof, ts) {
		t.Fatal("valid proof rejected")
	}
	// Stale timestamp rejected.
	if VerifyProof(serverPriv, userPubJWK, userID, ts, nonce, proof, ts+ProofWindowSkew+1) {
		t.Fatal("stale proof accepted")
	}
	// Wrong user id rejected.
	if VerifyProof(serverPriv, userPubJWK, "u_"+userID[2:]+"0", ts, nonce, proof, ts) {
		t.Fatal("proof for different user id accepted")
	}
	// Different key rejected.
	otherPriv, _ := ecdh.P256().GenerateKey(nil)
	otherShared, _ := otherPriv.ECDH(serverPub)
	badProof := EncodeProof(otherShared, userID, ts, nonce)
	if VerifyProof(serverPriv, userPubJWK, userID, ts, nonce, badProof, ts) {
		t.Fatal("proof from wrong private key accepted")
	}
}
