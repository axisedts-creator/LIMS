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
	"mime/multipart"
	"net/http"
	"net/textproto"
	"net/url"
	"path/filepath"
	"strings"
	"time"
)

const (
	batchPath  = "/v1/instruments/agent/message-batches"
	attachPath = "/v1/instruments/agent/attachments"
)

// AttachmentResult is the parsed 202 response from E06 POST /v1/instruments/agent/attachments.
type AttachmentResult struct {
	Outcome             string
	InstrumentMessageID string
	AttachmentID        string
	ScanState           string
}

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
	BaseURL       string
	Token         func() string
	ProxyURL      string
	RootCAs       *x509.CertPool
	SPKIPins      []string
	SPKIPinSource func() []string
	Timeout       time.Duration
}

// BuildTLSConfig builds a TLS >= 1.2 client config that verifies server chains/hostnames and enforces static or dynamic SPKI pins.
func BuildTLSConfig(rootCAs *x509.CertPool, staticPins []string, dynamicPins func() []string, errPrefix string) (*tls.Config, error) {
	pins := make(map[string]bool, len(staticPins))
	for _, p := range staticPins {
		if b, err := hex.DecodeString(p); err != nil || len(b) != sha256.Size {
			return nil, fmt.Errorf("%s: SPKI pin must be 64 hex characters (SHA-256)", errPrefix)
		}
		pins[strings.ToLower(p)] = true
	}
	tlsCfg := &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: rootCAs}
	if len(pins) > 0 || dynamicPins != nil {
		// Runs after the normal chain and hostname verification; a pin only narrows trust.
		tlsCfg.VerifyConnection = func(cs tls.ConnectionState) error {
			active := pins
			if dynamicPins != nil {
				if dyn := dynamicPins(); len(dyn) > 0 {
					active = make(map[string]bool, len(dyn))
					for _, p := range dyn {
						if b, err := hex.DecodeString(p); err != nil || len(b) != sha256.Size {
							return fmt.Errorf("%s: invalid runtime SPKI pin", errPrefix)
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
			return fmt.Errorf("%s: no certificate in the chain matches a pinned SPKI hash", errPrefix)
		}
	}
	return tlsCfg, nil
}

// Client submits batches over verified TLS >= 1.2. It never skips verification, never follows redirects,
// and never falls back to a direct connection when a configured proxy fails.
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

func NewClient(cfg Config) (*Client, error) {
	u, err := url.Parse(cfg.BaseURL)
	if err != nil || u.Scheme != "https" || u.Host == "" {
		return nil, errors.New("uploader: base URL must be an https:// URL")
	}
	if cfg.Token == nil {
		return nil, errors.New("uploader: token source required")
	}
	tlsCfg, err := BuildTLSConfig(cfg.RootCAs, cfg.SPKIPins, cfg.SPKIPinSource, "uploader")
	if err != nil {
		return nil, err
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

// SubmitAttachment POSTs a file_drop item to E06 multipart /v1/instruments/agent/attachments.
func (c *Client) SubmitAttachment(ctx context.Context, idemKey string, metadataJSON []byte, fileName string, fileBytes []byte) (AttachmentResult, error) {
	tok := c.token()
	if idemKey == "" || tok == "" {
		return AttachmentResult{}, errors.New("uploader: Idempotency-Key and device token are required")
	}
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	if err := mw.WriteField("metadata", string(metadataJSON)); err != nil {
		return AttachmentResult{}, err
	}
	if fileName == "" {
		fileName = "attachment.bin"
	}
	mimeType := "application/octet-stream"
	switch strings.ToLower(filepath.Ext(fileName)) {
	case ".pdf":
		mimeType = "application/pdf"
	case ".png":
		mimeType = "image/png"
	case ".jpg", ".jpeg":
		mimeType = "image/jpeg"
	}
	hdr := make(textproto.MIMEHeader)
	hdr.Set("Content-Disposition", fmt.Sprintf(`form-data; name="file"; filename="%s"`, strings.NewReplacer(`"`, "_", "\r", "", "\n", "").Replace(filepath.Base(fileName))))
	hdr.Set("Content-Type", mimeType)
	fw, err := mw.CreatePart(hdr)
	if err != nil {
		return AttachmentResult{}, err
	}
	if _, err := fw.Write(fileBytes); err != nil {
		return AttachmentResult{}, err
	}
	if err := mw.Close(); err != nil {
		return AttachmentResult{}, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.base+attachPath, &body)
	if err != nil {
		return AttachmentResult{}, err
	}
	req.Header.Set("Authorization", "Bearer "+tok)
	req.Header.Set("Idempotency-Key", idemKey)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	req.Header.Set("Accept", "application/json")

	resp, err := c.http.Do(req)
	tRecv := time.Now()
	if err != nil {
		return AttachmentResult{}, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return AttachmentResult{}, err
	}
	if resp.StatusCode != http.StatusAccepted && resp.StatusCode != http.StatusOK {
		he := &HTTPError{Status: resp.StatusCode}
		he.RetryAfter, _ = ParseRetryAfter(resp.Header.Get("Retry-After"), tRecv)
		var eb struct {
			Error struct {
				Code string `json:"code"`
			} `json:"error"`
		}
		if json.Unmarshal(raw, &eb) == nil {
			he.Code = eb.Error.Code
		}
		return AttachmentResult{}, he
	}
	var out struct {
		Outcome             string `json:"outcome"`
		InstrumentMessageID string `json:"instrument_message_id"`
		AttachmentID        string `json:"attachment_id"`
		ScanState           string `json:"scan_state"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return AttachmentResult{}, fmt.Errorf("uploader: attachment response invalid: %w", err)
	}
	return AttachmentResult{
		Outcome:             out.Outcome,
		InstrumentMessageID: out.InstrumentMessageID,
		AttachmentID:        out.AttachmentID,
		ScanState:           out.ScanState,
	}, nil
}
