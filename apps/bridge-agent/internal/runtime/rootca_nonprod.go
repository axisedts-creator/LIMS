//go:build nonprod

package runtime

import (
	"crypto/x509"
	"fmt"
	"os"
	"strings"
)

// loadRuntimeRootCAs loads LIMS_BRIDGE_CA_FILE in nonprod builds for self-signed local TLS tests.
func loadRuntimeRootCAs() (*x509.CertPool, error) {
	p := strings.TrimSpace(os.Getenv("LIMS_BRIDGE_CA_FILE"))
	if p == "" {
		return nil, nil
	}
	pem, err := os.ReadFile(p)
	if err != nil {
		return nil, fmt.Errorf("runtime: read LIMS_BRIDGE_CA_FILE: %w", err)
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(pem) {
		return nil, fmt.Errorf("runtime: invalid PEM in LIMS_BRIDGE_CA_FILE")
	}
	return pool, nil
}
