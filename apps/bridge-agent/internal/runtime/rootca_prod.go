//go:build !nonprod

package runtime

import "crypto/x509"

// loadRuntimeRootCAs returns nil in standard/release builds so only the system root store is trusted.
func loadRuntimeRootCAs() (*x509.CertPool, error) { return nil, nil }
