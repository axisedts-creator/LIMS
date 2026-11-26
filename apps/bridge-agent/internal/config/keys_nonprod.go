//go:build nonprod

package config

import (
	"bytes"
	"crypto/ed25519"
	"crypto/x509"
	"encoding/pem"
	"os"
	"strings"
)

// RuntimeTrustedKeys in nonprod builds merges EmbeddedKeys with optional LIMS_BRIDGE_CONFIG_PUBLIC_KEY_FILE.
func RuntimeTrustedKeys() TrustedKeys { return NonprodRuntimeKeys() }

// NonprodRuntimeKeys loads optional development/CI SPKI public keys from LIMS_BRIDGE_CONFIG_KEY_ID and
// LIMS_BRIDGE_CONFIG_PUBLIC_KEY_FILE (nonprod builds only; forbidden in release binaries by build/ci.sh release-tag-check).
// Always rejects the public synthetic test key (cfg-test-1).
func NonprodRuntimeKeys() TrustedKeys {
	out := EmbeddedKeys()
	id := strings.TrimSpace(os.Getenv("LIMS_BRIDGE_CONFIG_KEY_ID"))
	file := strings.TrimSpace(os.Getenv("LIMS_BRIDGE_CONFIG_PUBLIC_KEY_FILE"))
	if id == "" || file == "" || id == "cfg-test-1" || len([]rune(id)) > 32 {
		return out
	}
	raw, err := os.ReadFile(file)
	if err != nil {
		return out
	}
	blk, _ := pem.Decode(raw)
	if blk == nil {
		return out
	}
	k, err := x509.ParsePKIXPublicKey(blk.Bytes)
	if err != nil {
		return out
	}
	pub, ok := k.(ed25519.PublicKey)
	if !ok || len(pub) != ed25519.PublicKeySize || bytes.Equal(pub, goldenTestPub) {
		return out
	}
	out[id] = pub
	return out
}
