package config

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"strings"
)

// TrustedKeys maps key_id -> Ed25519 public key (current + next; rotation = release with the new key first, 02-TRD 5.10).
type TrustedKeys map[string]ed25519.PublicKey

// embeddedKeys holds the production config-signing public keys, filled by the release pipeline (either directly or via -ldflags).
// It is EMPTY by default: no key is trusted until one is provisioned (fail closed). The synthetic test key
// (LD-73, seed = SHA-256("cfg-test-1")) is public by construction and must never appear here.
var embeddedKeys = map[string]ed25519.PublicKey{}

// embeddedKeysHex can be set at build time via `-ldflags "-X lims/apps/bridge-agent/internal/config.embeddedKeysHex=k1=<64hex>,k2=<64hex>"`.
var embeddedKeysHex string

var goldenTestPub ed25519.PublicKey

func init() {
	seed := sha256.Sum256([]byte("cfg-test-1"))
	goldenTestPub = ed25519.NewKeyFromSeed(seed[:]).Public().(ed25519.PublicKey)
	if strings.TrimSpace(embeddedKeysHex) == "" {
		return
	}
	for _, entry := range strings.Split(embeddedKeysHex, ",") {
		parts := strings.SplitN(strings.TrimSpace(entry), "=", 2)
		if len(parts) != 2 {
			continue
		}
		id, hx := strings.TrimSpace(parts[0]), strings.TrimSpace(parts[1])
		if len([]rune(id)) < 1 || len([]rune(id)) > 32 || id == "cfg-test-1" {
			continue
		}
		b, err := hex.DecodeString(hx)
		if err != nil || len(b) != ed25519.PublicKeySize || bytes.Equal(b, goldenTestPub) {
			continue
		}
		embeddedKeys[id] = ed25519.PublicKey(b)
	}
}

// EmbeddedKeys returns a copy so callers cannot add a trusted key at runtime.
func EmbeddedKeys() TrustedKeys {
	out := make(TrustedKeys, len(embeddedKeys))
	for id, k := range embeddedKeys {
		out[id] = append(ed25519.PublicKey(nil), k...)
	}
	return out
}
