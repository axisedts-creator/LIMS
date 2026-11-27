//go:build !nonprod

package config

// RuntimeTrustedKeys returns EmbeddedKeys only in standard/release builds (fail closed).
func RuntimeTrustedKeys() TrustedKeys { return EmbeddedKeys() }
