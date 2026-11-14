package uploader

import (
	"bytes"
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

const batchPath = "/v1/instruments/agent/message-batches"

// MessageResult is one per-message entry of the E04 response, in request order.
type MessageResult struct{ AgentMessageID, Outcome, InstrumentMessageID, ErrorCode string }

// BatchResult is a parsed 200 response plus the local times bracketing the call (for clock estimation, AC-14.1).
type BatchResult struct {
	Results                  []MessageResult
	ServerTime, TSend, TRecv time.Time
}

// HTTPError is any non-200 answer. Status 401 satisfies errors.Is(err, ErrUnauthorized).
type HTTPError struct {
	Status     int
	Code       string
	RetryAfter time.Duration
}

func (e *HTTPError) Error() string {
	if e.Code != "" {
		return fmt.Sprintf("uploader: HTTP %d %s", e.Status, e.Code)
	}
	return fmt.Sprintf("uploader: HTTP %d", e.Status)
}

func (e *HTTPError) Is(target error) bool {
	return target == ErrUnauthorized && e.Status == http.StatusUnauthorized
}

// Config for the HTTPS client. RootCAs nil means the system roots. SPKIPins (lowercase hex SHA-256) are optional.
type Config struct {
	BaseURL  string
	Token    func() string
	ProxyURL string
	RootCAs  *x509.CertPool
	SPKIPins []string
	Timeout  time.Duration
}

// Client submits batches over verified TLS >= 1.2. It never skips verification, never follows redirects,
// and never falls back to a direct connection when a configured proxy fails.
type Client struct {
	base  string
	token func() string
	http  *http.Client
}

func NewClient(cfg Config) (*Client, error) {
	u, err := url.Parse(cfg.BaseURL)
	if err != nil || u.Scheme != "https" || u.Host == "" {
		return nil, errors.New("uploader: base URL must be an https:// URL")
	}
	if cfg.Token == nil {
		return nil, errors.New("uploader: token source required")
	}
	pins := make(map[string]bool, len(cfg.SPKIPins))
	for _, p := range cfg.SPKIPins {
		if b, err := hex.DecodeString(p); err != nil || len(b) != sha256.Size {
			return nil, errors.New("uploader: SPKI pin must be 64 hex characters (SHA-256)")
		}
		pins[strings.ToLower(p)] = true
	}
	tlsCfg := &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: cfg.RootCAs}
	if len(pins) > 0 {
		// Runs after the normal chain and hostname verification; a pin only narrows trust.
		tlsCfg.VerifyConnection = func(cs tls.ConnectionState) error {
			for _, chain := range cs.VerifiedChains {
				for _, c := range chain {
					h := sha256.Sum256(c.RawSubjectPublicKeyInfo)
					if pins[hex.EncodeToString(h[:])] {
						return nil
					}
				}
			}
			return errors.New("uploader: no certificate in the chain matches a pinned SPKI hash")
		}
	}
	tr := &http.Transport{TLSClientConfig: tlsCfg, DisableCompression: true} // Proxy nil: direct, never the environment
	if cfg.ProxyURL != "" {
		p, err := url.Parse(cfg.ProxyURL)
		if err != nil || (p.Scheme != "http" && p.Scheme != "https") || p.Host == "" {
			return nil, errors.New("uploader: proxy URL must be http:// or https://")
		}
		tr.Proxy = http.ProxyURL(p)
	}
	if cfg.Timeout <= 0 {
		cfg.Timeout = 30 * time.Second
	}
	return &Client{
		base:  strings.TrimRight(cfg.BaseURL, "/"),
		token: cfg.Token,
		http: &http.Client{Transport: tr, Timeout: cfg.Timeout,
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }},
	}, nil
}

// SubmitBatch POSTs the body (E04). Any status other than 200 is an *HTTPError.
func (c *Client) SubmitBatch(ctx context.Context, idemKey string, body []byte) (BatchResult, error) {
	tok := c.token()
	if idemKey == "" || tok == "" {
		return BatchResult{}, errors.New("uploader: Idempotency-Key and device token are required")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.base+batchPath, bytes.NewReader(body))
	if err != nil {
		return BatchResult{}, err
	}
	req.Header.Set("Authorization", "Bearer "+tok)
	req.Header.Set("Idempotency-Key", idemKey)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")

	res := BatchResult{TSend: time.Now()}
	resp, err := c.http.Do(req)
	res.TRecv = time.Now()
	if err != nil {
		return BatchResult{}, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return BatchResult{}, err
	}
	if resp.StatusCode != http.StatusOK {
		he := &HTTPError{Status: resp.StatusCode}
		he.RetryAfter, _ = ParseRetryAfter(resp.Header.Get("Retry-After"), res.TRecv)
		var eb struct {
			Error struct {
				Code string `json:"code"`
			} `json:"error"`
		}
		if json.Unmarshal(raw, &eb) == nil {
			he.Code = eb.Error.Code
		}
		return BatchResult{}, he
	}
	var pb struct {
		ServerTime string `json:"server_time"`
		Results    []struct {
			AgentMessageID      string `json:"agent_message_id"`
			Outcome             string `json:"outcome"`
			InstrumentMessageID string `json:"instrument_message_id"`
			ErrorCode           string `json:"error_code"`
		} `json:"results"`
	}
	if err := json.Unmarshal(raw, &pb); err != nil {
		return BatchResult{}, fmt.Errorf("uploader: response is not the contract body: %w", err)
	}
	if res.ServerTime, err = time.Parse(time.RFC3339Nano, pb.ServerTime); err != nil {
		return BatchResult{}, fmt.Errorf("uploader: bad server_time: %w", err)
	}
	for _, r := range pb.Results {
		res.Results = append(res.Results, MessageResult(r))
	}
	return res, nil
}
