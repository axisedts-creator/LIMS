package config

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const (
	configPath     = "/v1/instruments/agent/config"
	maxConfigBytes = 2 << 20
)

// ClientConfig configures the HTTPS E02 client (TLS >= 1.2, optional SPKI pins, no proxy fallback).
type ClientConfig struct {
	BaseURL       string
	Token         func() string
	ProxyURL      string
	RootCAs       *x509.CertPool
	SPKIPins      []string
	SPKIPinSource func() []string
	Timeout       time.Duration
}

// Client fetches signed `lims.bridge.config.v1` envelopes from GET /v1/instruments/agent/config (E02).
type Client struct {
	base  string
	token func() string
	http  *http.Client
}

func (c *Client) CloseIdleConnections() {
	if c != nil && c.http != nil {
		c.http.CloseIdleConnections()
	}
}

func NewClient(cfg ClientConfig) (*Client, error) {
	u, err := url.Parse(cfg.BaseURL)
	if err != nil || u.Scheme != "https" || u.Host == "" {
		return nil, errors.New("config: base URL must be an https:// URL")
	}
	if cfg.Token == nil {
		return nil, errors.New("config: token source required")
	}
	pins := make(map[string]bool, len(cfg.SPKIPins))
	for _, p := range cfg.SPKIPins {
		if b, err := hex.DecodeString(p); err != nil || len(b) != sha256.Size {
			return nil, errors.New("config: SPKI pin must be 64 hex characters (SHA-256)")
		}
		pins[strings.ToLower(p)] = true
	}
	tlsCfg := &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: cfg.RootCAs}
	if len(pins) > 0 || cfg.SPKIPinSource != nil {
		tlsCfg.VerifyConnection = func(cs tls.ConnectionState) error {
			active := pins
			if cfg.SPKIPinSource != nil {
				if dyn := cfg.SPKIPinSource(); len(dyn) > 0 {
					active = make(map[string]bool, len(dyn))
					for _, p := range dyn {
						if b, err := hex.DecodeString(p); err != nil || len(b) != sha256.Size {
							return errors.New("config: invalid runtime SPKI pin")
						}
						active[strings.ToLower(p)] = true
					}
				}
			}
			if len(active) == 0 {
				return nil
			}
			for _, chain := range cs.VerifiedChains {
				for _, c := range chain {
					h := sha256.Sum256(c.RawSubjectPublicKeyInfo)
					if active[hex.EncodeToString(h[:])] {
						return nil
					}
				}
			}
			return errors.New("config: no certificate in the chain matches a pinned SPKI hash")
		}
	}
	tr := &http.Transport{TLSClientConfig: tlsCfg, DisableCompression: true}
	if cfg.ProxyURL != "" {
		p, err := url.Parse(cfg.ProxyURL)
		if err != nil || (p.Scheme != "http" && p.Scheme != "https") || p.Host == "" {
			return nil, errors.New("config: proxy URL must be http:// or https://")
		}
		tr.Proxy = http.ProxyURL(p)
	}
	if cfg.Timeout <= 0 {
		cfg.Timeout = 30 * time.Second
	}
	return &Client{
		base:  strings.TrimRight(cfg.BaseURL, "/"),
		token: cfg.Token,
		http: &http.Client{
			Transport: tr,
			Timeout:   cfg.Timeout,
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
	}, nil
}

// HTTPError captures non-200 status/error code from E02.
type HTTPError struct {
	Status int
	Code   string
}

func (e *HTTPError) Error() string {
	if e.Code != "" {
		return fmt.Sprintf("config: HTTP %d %s", e.Status, e.Code)
	}
	return fmt.Sprintf("config: HTTP %d", e.Status)
}

// Fetch returns the raw signed JSON envelope from E02 GET /v1/instruments/agent/config.
func (c *Client) Fetch(ctx context.Context) ([]byte, error) {
	tok := c.token()
	if tok == "" {
		return nil, errors.New("config: device token unavailable")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.base+configPath, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+tok)
	req.Header.Set("Accept", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxConfigBytes+1))
	if err != nil {
		return nil, err
	}
	if len(body) > maxConfigBytes {
		return nil, errors.New("config: response exceeds maximum size")
	}
	if resp.StatusCode != http.StatusOK {
		var p struct {
			Code  string `json:"code"`
			Error *struct {
				Code string `json:"code"`
			} `json:"error"`
		}
		_ = json.Unmarshal(body, &p)
		code := p.Code
		if code == "" && p.Error != nil {
			code = p.Error.Code
		}
		return nil, &HTTPError{Status: resp.StatusCode, Code: code}
	}
	return body, nil
}
