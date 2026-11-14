package heartbeat

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"lims/apps/bridge-agent/internal/uploader"
)

const (
	heartbeatPath = "/v1/instruments/agent/heartbeats"
	bundlePath    = "/v1/instruments/agent/log-bundles"
	maxReply      = 1 << 20
	// NextDelay: every 60 s, jitter +/- 2 s [CONV] (03-APP-FLOW F-10).
	interval = 60 * time.Second
	jitter   = 2 * time.Second
)

// NextDelay returns the wait before the next heartbeat; rnd yields [0,1).
func NextDelay(rnd func() float64) time.Duration {
	return interval - jitter + time.Duration(rnd()*float64(2*jitter))
}

// Client talks E03/E07 with the same transport rules as the uploader (REQ-SEC-114): https only, verified TLS >= 1.2,
// optional SPKI pins, no redirects, no environment proxy, no request without a token. It implements Sender.
type Client struct {
	base  string
	token func() string
	http  *http.Client
}

var _ Sender = (*Client)(nil)

func NewClient(cfg uploader.Config) (*Client, error) {
	u, err := url.Parse(cfg.BaseURL)
	if err != nil || u.Scheme != "https" || u.Host == "" {
		return nil, errors.New("heartbeat: base URL must be an https:// URL")
	}
	if cfg.Token == nil {
		return nil, errors.New("heartbeat: token source required")
	}
	pins := make(map[string]bool, len(cfg.SPKIPins))
	for _, p := range cfg.SPKIPins {
		if b, err := hex.DecodeString(p); err != nil || len(b) != sha256.Size {
			return nil, errors.New("heartbeat: SPKI pin must be 64 hex characters (SHA-256)")
		}
		pins[strings.ToLower(p)] = true
	}
	tlsCfg := &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: cfg.RootCAs}
	if len(pins) > 0 {
		tlsCfg.VerifyConnection = func(cs tls.ConnectionState) error {
			for _, chain := range cs.VerifiedChains {
				for _, c := range chain {
					h := sha256.Sum256(c.RawSubjectPublicKeyInfo)
					if pins[hex.EncodeToString(h[:])] {
						return nil
					}
				}
			}
			return errors.New("heartbeat: no certificate in the chain matches a pinned SPKI hash")
		}
	}
	tr := &http.Transport{TLSClientConfig: tlsCfg, DisableCompression: true}
	if cfg.ProxyURL != "" {
		p, err := url.Parse(cfg.ProxyURL)
		if err != nil || (p.Scheme != "http" && p.Scheme != "https") || p.Host == "" {
			return nil, errors.New("heartbeat: proxy URL must be http:// or https://")
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

// post sends body and returns the raw reply when the status equals want; any other status is an *uploader.HTTPError.
func (c *Client) post(ctx context.Context, path, idemKey string, body any, want int) ([]byte, error) {
	tok := c.token()
	if tok == "" {
		return nil, errors.New("heartbeat: device token required")
	}
	raw, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.base+path, bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+tok)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	if idemKey != "" {
		req.Header.Set("Idempotency-Key", idemKey)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	reply, err := io.ReadAll(io.LimitReader(resp.Body, maxReply))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != want {
		he := &uploader.HTTPError{Status: resp.StatusCode}
		he.RetryAfter, _ = uploader.ParseRetryAfter(resp.Header.Get("Retry-After"), time.Now())
		var eb struct {
			Error struct {
				Code string `json:"code"`
			} `json:"error"`
		}
		if json.Unmarshal(reply, &eb) == nil {
			he.Code = eb.Error.Code
		}
		return nil, he
	}
	return reply, nil
}

// Heartbeat POSTs E03. Nil slices are sent as [] so the body never contains null.
func (c *Client) Heartbeat(ctx context.Context, r Report) (Response, error) {
	if r.Instruments == nil {
		r.Instruments = []InstrumentLink{}
	}
	if r.CommandResults == nil {
		r.CommandResults = []CommandResult{}
	}
	reply, err := c.post(ctx, heartbeatPath, "", r, http.StatusOK)
	if err != nil {
		return Response{}, err
	}
	var out Response
	if err := json.Unmarshal(reply, &out); err != nil {
		return Response{}, fmt.Errorf("heartbeat: response is not the contract body: %w", err)
	}
	return out, nil
}

// SubmitLogBundle POSTs E07 and returns the bundle id. E07 requires Idempotency-Key; the
// command_id is used so a retried send replays instead of creating a second bundle.
func (c *Client) SubmitLogBundle(ctx context.Context, b LogBundle) (string, error) {
	if b.CommandID == "" {
		return "", errors.New("heartbeat: log bundle needs command_id for Idempotency-Key")
	}
	reply, err := c.post(ctx, bundlePath, b.CommandID, b, http.StatusCreated)
	if err != nil {
		return "", err
	}
	var out struct {
		BundleID string `json:"bundle_id"`
	}
	if err := json.Unmarshal(reply, &out); err != nil || out.BundleID == "" {
		return "", errors.New("heartbeat: log-bundle response is not the contract body")
	}
	return out.BundleID, nil
}
