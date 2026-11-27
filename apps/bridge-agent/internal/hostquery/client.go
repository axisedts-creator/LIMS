// Package hostquery relays instrument host queries to the server (E05) and queues the replies for the link layer.
package hostquery

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
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
	queryPath   = "/v1/instruments/agent/host-queries"
	maxRawBytes = 64 * 1024 // E05 raw_base64 <= 64 KiB decoded
)

// Request is one E05 call. AgentMessageID is the queue item id, so the later kind=host_query upload dedupes.
type Request struct {
	InstrumentID, AgentMessageID, Protocol string
	Raw                                    []byte
	CapturedAt                             time.Time
	ClockOffsetMs                          int64
}

// Response is a parsed 200: replies are already base64-decoded, in server order.
type Response struct {
	ServerTime          time.Time
	InstrumentMessageID string
	ReplyMessages       [][]byte
}

// Sender is the E05 call; *Client implements it.
type Sender interface {
	SubmitHostQuery(ctx context.Context, idemKey string, r Request) (Response, error)
}

// Client is the HTTPS E05 client: TLS >= 1.2 with verification, no redirects, no proxy fallback (same rules as uploader.Client).
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

func NewClient(cfg uploader.Config) (*Client, error) {
	u, err := url.Parse(cfg.BaseURL)
	if err != nil || u.Scheme != "https" || u.Host == "" {
		return nil, errors.New("hostquery: base URL must be an https:// URL")
	}
	if cfg.Token == nil {
		return nil, errors.New("hostquery: token source required")
	}
	tlsCfg, err := uploader.BuildTLSConfig(cfg.RootCAs, cfg.SPKIPins, cfg.SPKIPinSource, "hostquery")
	if err != nil {
		return nil, err
	}
	tr := &http.Transport{TLSClientConfig: tlsCfg, DisableCompression: true}
	if cfg.ProxyURL != "" {
		p, err := url.Parse(cfg.ProxyURL)
		if err != nil || (p.Scheme != "http" && p.Scheme != "https") || p.Host == "" {
			return nil, errors.New("hostquery: proxy URL must be http:// or https://")
		}
		tr.Proxy = http.ProxyURL(p)
	}
	if cfg.Timeout <= 0 {
		cfg.Timeout = 30 * time.Second
	}
	return &Client{base: strings.TrimRight(cfg.BaseURL, "/"), token: cfg.Token,
		http: &http.Client{Transport: tr, Timeout: cfg.Timeout,
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}, nil
}

// SubmitHostQuery POSTs E05. Any status other than 200 is an *uploader.HTTPError; an undecodable 200 is a plain error.
func (c *Client) SubmitHostQuery(ctx context.Context, idemKey string, r Request) (Response, error) {
	tok := c.token()
	if idemKey == "" || tok == "" {
		return Response{}, errors.New("hostquery: Idempotency-Key and device token are required")
	}
	if len(r.Raw) > maxRawBytes {
		return Response{}, errors.New("hostquery: query exceeds 64 KiB")
	}
	sum := sha256.Sum256(r.Raw)
	body, err := json.Marshal(map[string]any{
		"instrument_id":     r.InstrumentID,
		"agent_message_id":  r.AgentMessageID,
		"protocol":          r.Protocol,
		"raw_base64":        base64.StdEncoding.EncodeToString(r.Raw),
		"raw_sha256":        hex.EncodeToString(sum[:]),
		"captured_at_agent": r.CapturedAt.UTC().Format("2006-01-02T15:04:05.000Z07:00"),
		"clock_offset_ms":   r.ClockOffsetMs,
	})
	if err != nil {
		return Response{}, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.base+queryPath, bytes.NewReader(body))
	if err != nil {
		return Response{}, err
	}
	req.Header.Set("Authorization", "Bearer "+tok)
	req.Header.Set("Idempotency-Key", idemKey)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")

	resp, err := c.http.Do(req)
	if err != nil {
		return Response{}, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return Response{}, err
	}
	if resp.StatusCode != http.StatusOK {
		he := &uploader.HTTPError{Status: resp.StatusCode}
		he.RetryAfter, _ = uploader.ParseRetryAfter(resp.Header.Get("Retry-After"), time.Now())
		var eb struct {
			Error struct {
				Code string `json:"code"`
			} `json:"error"`
		}
		if json.Unmarshal(raw, &eb) == nil {
			he.Code = eb.Error.Code
		}
		return Response{}, he
	}
	var pb struct {
		ServerTime          string `json:"server_time"`
		InstrumentMessageID string `json:"instrument_message_id"`
		ReplyMessages       []struct {
			RawBase64 string `json:"raw_base64"`
		} `json:"reply_messages"`
	}
	if err := json.Unmarshal(raw, &pb); err != nil {
		return Response{}, fmt.Errorf("hostquery: response is not the contract body: %w", err)
	}
	out := Response{InstrumentMessageID: pb.InstrumentMessageID}
	if out.ServerTime, err = time.Parse(time.RFC3339Nano, pb.ServerTime); err != nil {
		return Response{}, fmt.Errorf("hostquery: bad server_time: %w", err)
	}
	for _, m := range pb.ReplyMessages {
		b, err := base64.StdEncoding.DecodeString(m.RawBase64)
		if err != nil {
			return Response{}, errors.New("hostquery: reply is not valid base64")
		}
		out.ReplyMessages = append(out.ReplyMessages, b)
	}
	return out, nil
}
