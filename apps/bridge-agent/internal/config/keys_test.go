package config

// keys.go = embedded trusted public keys (02-TRD 5.1 layout, 5.10: current + next).
// The LD-73 test key is public by construction (seed = SHA-256("cfg-test-1")); if a shipped agent trusted it,
// anyone could sign a config for the whole fleet (AS4/AS5, AB6).

import (
	"bytes"
	"testing"
)

func TestEmbeddedKeys_NeverTrustTheSyntheticTestKey(t *testing.T) {
	pub := goldenPub(t)
	for id, k := range EmbeddedKeys() {
		if id == testKeyID {
			t.Errorf("embedded trusted keys contain test key id %q", id)
		}
		if bytes.Equal(k, pub) {
			t.Errorf("embedded key %q is the public synthetic test key", id)
		}
		if len(k) != 32 {
			t.Errorf("embedded key %q is not a 32-byte Ed25519 public key", id)
		}
		if n := len([]rune(id)); n < 1 || n > 32 {
			t.Errorf("embedded key id %q must be 1..32 chars (05-SCHEMA key_id)", id)
		}
	}
}

func TestEmbeddedKeys_ReturnsACopy(t *testing.T) {
	a := EmbeddedKeys()
	for id := range a {
		delete(a, id)
	}
	a["x"] = goldenPub(t)
	if _, ok := EmbeddedKeys()["x"]; ok {
		t.Fatal("EmbeddedKeys exposes its internal map; callers could add a trusted key at runtime")
	}
}
