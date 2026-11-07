package api

import (
	"testing"

	"a09f/bottle/internal/store"
)

func TestValidBottleID(t *testing.T) {
	validIDs := []string{
		"12345678",
		"bottle_abc-123",
		"a09f-test-id_99",
	}
	for _, id := range validIDs {
		if !validBottleID(id) {
			t.Errorf("expected %s to be valid", id)
		}
	}

	invalidIDs := []string{
		"abc/123",
		"id with space",
		"bottle$123",
		"../path",
	}
	for _, id := range invalidIDs {
		if validBottleID(id) {
			t.Errorf("expected %s to be invalid", id)
		}
	}
}

func TestValidateBottle(t *testing.T) {
	valid := store.Bottle{
		ID:            "bottle-12345",
		MaxDeliveries: 1,
		Depth:         1,
		PayloadIV:     "iv-base64",
		Ciphertext:    "ciphertext-base64",
		Envelopes: []store.Envelope{
			{
				KID:             "kid-1",
				AuthorPublicKey: `{"x":"...","y":"..."}`,
				WrapIV:          "wrap-iv",
				WrappedKey:      "wrapped-key",
				PickupHash:      "valid-pickup-hash-base64",
			},
		},
	}

	if err := validateBottle(valid); err != nil {
		t.Fatalf("expected valid bottle, got: %v", err)
	}

	// Oversized pickup hash
	invalidHash := valid
	invalidHash.Envelopes = []store.Envelope{
		{
			KID:             "kid-1",
			AuthorPublicKey: `{"x":"...","y":"..."}`,
			WrapIV:          "wrap-iv",
			WrappedKey:      "wrapped-key",
			PickupHash:      string(make([]byte, 200)),
		},
	}
	if err := validateBottle(invalidHash); err == nil {
		t.Errorf("expected error for oversized pickup hash")
	}

	// Payload too large
	invalidPayload := valid
	invalidPayload.Ciphertext = string(make([]byte, 300*1024))
	if err := validateBottle(invalidPayload); err == nil {
		t.Errorf("expected error for oversized ciphertext")
	}

	// Mismatched envelopes
	invalidEnv := valid
	invalidEnv.Envelopes = nil
	if err := validateBottle(invalidEnv); err == nil {
		t.Errorf("expected error for envelope count mismatch")
	}
}

