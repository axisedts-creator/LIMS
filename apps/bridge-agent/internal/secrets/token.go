// Package secrets holds the agent's DPAPI wrap and the device-token file (02-TRD 5.12, REQ-SEC-118).
package secrets

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// Protector wraps and unwraps secrets. *DPAPI (Windows) satisfies it; tests use fakes.
type Protector interface {
	Protect(plain []byte) ([]byte, error)
	Unprotect(blob []byte) ([]byte, error)
}

// TokenFile is the DPAPI blob of the device token inside the secrets folder. Never plaintext (REQ-SEC-118).
const TokenFile = "device-token.bin"

// ErrNoToken means no token file exists yet (not enrolled). A corrupt file is a different error.
var ErrNoToken = errors.New("secrets: no device token")

// SaveToken wraps token and writes dir\TokenFile atomically (temp file + rename). Plaintext is never written.
func SaveToken(dir, token string, p Protector) error {
	if token == "" {
		return errors.New("secrets: empty token")
	}
	blob, err := p.Protect([]byte(token))
	if err != nil {
		return fmt.Errorf("secrets: protect token: %w", err)
	}
	tmp, err := os.CreateTemp(dir, "device-token-*.tmp")
	if err != nil {
		return err
	}
	name := tmp.Name()
	_, err = tmp.Write(blob)
	if err == nil {
		err = tmp.Sync()
	}
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Rename(name, filepath.Join(dir, TokenFile))
	}
	if err != nil {
		_ = os.Remove(name)
		return err
	}
	return nil
}

// LoadToken returns the stored token, ErrNoToken when the file does not exist.
func LoadToken(dir string, p Protector) (string, error) {
	blob, err := os.ReadFile(filepath.Join(dir, TokenFile))
	if errors.Is(err, os.ErrNotExist) {
		return "", ErrNoToken
	}
	if err != nil {
		return "", err
	}
	plain, err := p.Unprotect(blob)
	if err != nil {
		return "", fmt.Errorf("secrets: unprotect token: %w", err)
	}
	if len(plain) == 0 {
		return "", errors.New("secrets: empty token in file")
	}
	return string(plain), nil
}
