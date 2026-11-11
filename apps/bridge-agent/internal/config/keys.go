package config

import "crypto/ed25519"

// TrustedKeys maps key_id -> Ed25519 public key (current + next; rotation = release with the new key first, 02-TRD 5.10).
type TrustedKeys map[string]ed25519.PublicKey

// embeddedKeys holds the production config-signing public keys, filled by the release pipeline.
// It is EMPTY on purpose: no key is trusted until one is provisioned (fail closed). The synthetic test key
// (LD-73, seed = SHA-256("cfg-test-1")) is public by construction and must never appear here.
var embeddedKeys = map[string]ed25519.PublicKey{}

// EmbeddedKeys returns a copy so callers cannot add a trusted key at runtime.
func EmbeddedKeys() TrustedKeys {
	out := make(TrustedKeys, len(embeddedKeys))
	for id, k := range embeddedKeys {
		out[id] = append(ed25519.PublicKey(nil), k...)
	}
	return out
}
