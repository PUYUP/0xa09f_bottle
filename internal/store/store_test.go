package store

import (
	"testing"
)

func TestEncodeDecodePoolMember(t *testing.T) {
	key := PoolKey{
		KID:       "test-kid-123",
		PublicKey: `{"kty":"EC","crv":"P-256","x":"f83OJ3D2xFmT4vGLPJd4oQ","y":"x_daQJJmee3Fs0Ty3YNtBg"}`,
	}
	expiresAt := int64(1730000000)

	encoded, err := encodePoolMember(key, expiresAt)
	if err != nil {
		t.Fatalf("encodePoolMember failed: %v", err)
	}

	decoded, ok := decodePoolMember(encoded)
	if !ok {
		t.Fatalf("decodePoolMember failed")
	}

	if decoded.KID != key.KID {
		t.Errorf("expected KID %s, got %s", key.KID, decoded.KID)
	}
	if decoded.ExpiresAt != expiresAt {
		t.Errorf("expected ExpiresAt %d, got %d", expiresAt, decoded.ExpiresAt)
	}
}

func TestPoolKeyFromMemberLegacy(t *testing.T) {
	legacyJSON := `{"kid":"legacy-kid","publicKey":"legacy-pub","expiresAt":1730000000}`
	key, ok := poolKeyFromMember(legacyJSON)
	if !ok {
		t.Fatalf("poolKeyFromMember failed for legacy format")
	}
	if key.KID != "legacy-kid" {
		t.Errorf("expected KID legacy-kid, got %s", key.KID)
	}
}

