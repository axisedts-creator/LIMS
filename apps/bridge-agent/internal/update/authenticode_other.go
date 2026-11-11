//go:build !windows

package update

import "errors"

type unsupportedVerifier struct{}

func (unsupportedVerifier) Publisher(string) (string, error) {
	return "", errors.New("update: Authenticode verification is only available on Windows")
}

// NewAuthenticode off Windows always fails closed (the agent only ships for Windows; this keeps `go build ./...` working elsewhere).
func NewAuthenticode() Authenticode { return unsupportedVerifier{} }
