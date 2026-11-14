package uploader_test

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"lims/apps/bridge-agent/internal/uploader"
)

const okBody = `{"server_time":"2026-11-06T04:00:05.000Z","results":[{"agent_message_id":"m1","outcome":"accepted","instrument_message_id":"s1"},{"agent_message_id":"m2","outcome":"rejected","error_code":"instruments.message_malformed"}]}`

type tlsStub struct {
	srv  *httptest.Server
	hits atomic.Int32
	last atomic.Pointer[http.Request]
	pool *x509.CertPool
}

func newTLSStub(t *testing.T, h http.HandlerFunc, cfg *tls.Config) *tlsStub {
	t.Helper()
	s := &tlsStub{}
	s.srv = httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.hits.Add(1)
		s.last.Store(r)
		h(w, r)
	}))
	if cfg != nil {
		s.srv.TLS = cfg
	}
	s.srv.StartTLS()
	t.Cleanup(s.srv.Close)
	s.pool = x509.NewCertPool()
	s.pool.AddCert(s.srv.Certificate())
	return s
}

func ok200(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_, _ = io.WriteString(w, okBody)
}

func (s *tlsStub) client(t *testing.T, mut func(*uploader.Config)) *uploader.Client {
	t.Helper()
	cfg := uploader.Config{BaseURL: s.srv.URL, Token: func() string { return "lmsd_" + strings.Repeat("A", 43) }, RootCAs: s.pool, Timeout: 5 * time.Second}
	if mut != nil {
		mut(&cfg)
	}
	c, err := uploader.NewClient(cfg)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func submit(c *uploader.Client) (uploader.BatchResult, error) {
	return c.SubmitBatch(context.Background(), "01a1a98a-ac40-7000-8000-0000000d0001", []byte(`{"sent_at_agent":"2026-11-06T04:00:00.000Z","clock_offset_ms":0,"messages":[]}`))
}

func spkiHex(s *tlsStub) string {
	h := sha256.Sum256(s.srv.Certificate().RawSubjectPublicKeyInfo)
	return hex.EncodeToString(h[:])
}

// AC-08.1 + contract (contracts/openapi/instruments.yaml submitBatch E04): POST path, bearer token, Idempotency-Key, JSON.
func TestClient_RequestShapeAndResponseParsing(t *testing.T) {
	s := newTLSStub(t, ok200, nil)
	res, err := submit(s.client(t, nil))
	if err != nil {
		t.Fatal(err)
	}
	r := s.last.Load()
	if r.Method != "POST" || r.URL.Path != "/v1/instruments/agent/message-batches" {
		t.Fatalf("%s %s", r.Method, r.URL.Path)
	}
	if got := r.Header.Get("Authorization"); got != "Bearer lmsd_"+strings.Repeat("A", 43) {
		t.Fatalf("Authorization %q", got)
	}
	if r.Header.Get("Idempotency-Key") != "01a1a98a-ac40-7000-8000-0000000d0001" || !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		t.Fatalf("headers %v", r.Header)
	}
	if len(res.Results) != 2 || res.Results[0].Outcome != "accepted" || res.Results[0].InstrumentMessageID != "s1" ||
		res.Results[1].ErrorCode != "instruments.message_malformed" {
		t.Fatalf("results %+v", res.Results)
	}
	if !res.ServerTime.Equal(time.Date(2026, 11, 6, 4, 0, 5, 0, time.UTC)) {
		t.Fatalf("server_time %v", res.ServerTime)
	}
	if res.TSend.IsZero() || res.TRecv.Before(res.TSend) {
		t.Fatalf("tSend=%v tRecv=%v", res.TSend, res.TRecv)
	}
}

func TestClient_EmptyIdempotencyKeyIsRefusedBeforeSending(t *testing.T) {
	s := newTLSStub(t, ok200, nil)
	if _, err := s.client(t, nil).SubmitBatch(context.Background(), "", []byte("{}")); err == nil || s.hits.Load() != 0 {
		t.Fatalf("err=%v hits=%d", err, s.hits.Load())
	}
}

// AC-14.1: the offset is estimated from tSend/tRecv around a real call.
func TestClient_TimestampsBracketTheCall(t *testing.T) {
	s := newTLSStub(t, func(w http.ResponseWriter, r *http.Request) { time.Sleep(50 * time.Millisecond); ok200(w, r) }, nil)
	before := time.Now()
	res, err := submit(s.client(t, nil))
	after := time.Now()
	if err != nil {
		t.Fatal(err)
	}
	if res.TSend.Before(before) || res.TRecv.After(after) || res.TRecv.Sub(res.TSend) < 50*time.Millisecond {
		t.Fatalf("tSend=%v tRecv=%v not bracketing a 50 ms call", res.TSend, res.TRecv)
	}
}

func TestClient_ErrorStatuses(t *testing.T) {
	cases := []struct {
		status     int
		retryAfter string
		wantRA     time.Duration
		unauth     bool
	}{
		{401, "", 0, true},
		{429, "7", 7 * time.Second, false},
		{503, "120", 120 * time.Second, false},
		{500, "", 0, false},
		{413, "", 0, false},
	}
	for _, c := range cases {
		s := newTLSStub(t, func(w http.ResponseWriter, _ *http.Request) {
			if c.retryAfter != "" {
				w.Header().Set("Retry-After", c.retryAfter)
			}
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(c.status)
			_, _ = io.WriteString(w, `{"error":{"code":"x"}}`)
		}, nil)
		_, err := submit(s.client(t, nil))
		var he *uploader.HTTPError
		if !errors.As(err, &he) || he.Status != c.status || he.RetryAfter != c.wantRA {
			t.Errorf("status %d: err=%v", c.status, err)
			continue
		}
		if errors.Is(err, uploader.ErrUnauthorized) != c.unauth {
			t.Errorf("status %d: ErrUnauthorized=%v, want %v", c.status, !c.unauth, c.unauth)
		}
	}
}

func TestClient_MalformedSuccessBodyIsAnError(t *testing.T) {
	s := newTLSStub(t, func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, "<html>captive portal</html>") }, nil)
	if _, err := submit(s.client(t, nil)); err == nil {
		t.Fatal("a 200 that is not the contract body must not count as success")
	}
}

// REQ-SEC-115 / S-10: system roots only. A self-signed (MITM) certificate fails and NO data is sent.
func TestTLS_UntrustedCertificateRefusedAndNothingSent(t *testing.T) {
	s := newTLSStub(t, ok200, nil)
	c := s.client(t, func(cfg *uploader.Config) { cfg.RootCAs = nil }) // nil = system roots
	if _, err := submit(c); err == nil {
		t.Fatal("self-signed certificate was accepted")
	}
	if s.hits.Load() != 0 {
		t.Fatal("request reached the server despite a failed TLS verification")
	}
}

func TestTLS_HostnameMismatchRefused(t *testing.T) {
	s := newTLSStub(t, ok200, nil)
	// httptest cert is valid for 127.0.0.1 / example.com only; "localhost" must not verify.
	c := s.client(t, func(cfg *uploader.Config) { cfg.BaseURL = strings.Replace(cfg.BaseURL, "127.0.0.1", "localhost", 1) })
	if _, err := submit(c); err == nil || s.hits.Load() != 0 {
		t.Fatalf("err=%v hits=%d", err, s.hits.Load())
	}
}

func TestTLS_PlainHTTPBaseURLRefused(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hits.Add(1); ok200(w, r) }))
	defer srv.Close()
	c, err := uploader.NewClient(uploader.Config{BaseURL: srv.URL, Token: func() string { return "t" }})
	if err == nil {
		_, err = submit(c)
	}
	if err == nil || hits.Load() != 0 {
		t.Fatalf("http:// base URL must be rejected (err=%v hits=%d)", err, hits.Load())
	}
}

// REQ-SEC-115: TLS >= 1.2.
func TestTLS_MinimumVersion12(t *testing.T) {
	old := &tls.Config{MinVersion: tls.VersionTLS10, MaxVersion: tls.VersionTLS11}
	s := newTLSStub(t, ok200, old)
	// control: the stub really does speak TLS 1.1 to a client that allows it
	ctl := &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: s.pool, MinVersion: tls.VersionTLS10, MaxVersion: tls.VersionTLS11}}}
	resp, err := ctl.Get(s.srv.URL)
	if err != nil {
		t.Skipf("this Go toolchain cannot serve TLS 1.1, cannot test the floor behaviourally: %v", err)
	}
	resp.Body.Close()
	hits := s.hits.Load()
	if _, err := submit(s.client(t, nil)); err == nil || s.hits.Load() != hits {
		t.Fatalf("TLS 1.1 server accepted (err=%v)", err)
	}
	ok := newTLSStub(t, ok200, &tls.Config{MinVersion: tls.VersionTLS12})
	if _, err := submit(ok.client(t, nil)); err != nil {
		t.Fatalf("TLS 1.2 server refused: %v", err)
	}
}

// Optional SPKI pins (signed config): non-empty -> chain must contain a pinned SPKI hash.
func TestTLS_SPKIPins(t *testing.T) {
	s := newTLSStub(t, ok200, nil)
	if _, err := submit(s.client(t, func(c *uploader.Config) { c.SPKIPins = nil })); err != nil {
		t.Fatalf("no pins must verify normally: %v", err)
	}
	if _, err := submit(s.client(t, func(c *uploader.Config) { c.SPKIPins = []string{strings.Repeat("0", 64), spkiHex(s)} })); err != nil {
		t.Fatalf("matching pin among others refused: %v", err)
	}
	before := s.hits.Load()
	_, err := submit(s.client(t, func(c *uploader.Config) { c.SPKIPins = []string{strings.Repeat("0", 64)} }))
	if err == nil || s.hits.Load() != before {
		t.Fatalf("non-matching pin accepted (err=%v)", err)
	}
	if _, err := uploader.NewClient(uploader.Config{BaseURL: s.srv.URL, Token: func() string { return "t" }, SPKIPins: []string{"not-hex"}}); err == nil {
		t.Fatal("malformed pin must be rejected at construction, not silently ignored")
	}
}

// A pin never replaces certificate verification.
func TestTLS_PinDoesNotBypassVerification(t *testing.T) {
	s := newTLSStub(t, ok200, nil)
	c := s.client(t, func(cfg *uploader.Config) { cfg.RootCAs = nil; cfg.SPKIPins = []string{spkiHex(s)} })
	if _, err := submit(c); err == nil || s.hits.Load() != 0 {
		t.Fatalf("pinned but untrusted cert accepted (err=%v)", err)
	}
}

// Redirects are never followed (a 3xx must not move the bearer token to another host or downgrade to http).
func TestClient_DoesNotFollowRedirects(t *testing.T) {
	var other atomic.Int32
	o := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		other.Add(1)
		if r.Header.Get("Authorization") != "" {
			t.Error("bearer token leaked to the redirect target")
		}
	}))
	defer o.Close()
	s := newTLSStub(t, func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, o.URL, http.StatusTemporaryRedirect) }, nil)
	if _, err := submit(s.client(t, nil)); err == nil || other.Load() != 0 {
		t.Fatalf("err=%v redirect hits=%d", err, other.Load())
	}
}

// connectProxy is a minimal HTTP CONNECT proxy; mode "ok" tunnels, mode "502" refuses.
func connectProxy(t *testing.T, mode string) (url string, connects *atomic.Int32) {
	t.Helper()
	connects = new(atomic.Int32)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodConnect {
			http.Error(w, "connect only", 405)
			return
		}
		connects.Add(1)
		if mode == "502" {
			http.Error(w, "bad gateway", 502)
			return
		}
		up, err := net.Dial("tcp", r.Host)
		if err != nil {
			http.Error(w, err.Error(), 502)
			return
		}
		hj := w.(http.Hijacker)
		down, _, _ := hj.Hijack()
		_, _ = io.WriteString(down, "HTTP/1.1 200 Connection established\r\n\r\n")
		go func() { _, _ = io.Copy(up, down); up.Close() }()
		go func() { _, _ = io.Copy(down, up); down.Close() }()
	}))
	t.Cleanup(srv.Close)
	return srv.URL, connects
}

func TestProxy_UsedForUploadsAndTLSStillVerifiedEndToEnd(t *testing.T) {
	s := newTLSStub(t, ok200, nil)
	purl, connects := connectProxy(t, "ok")
	if _, err := submit(s.client(t, func(c *uploader.Config) { c.ProxyURL = purl })); err != nil {
		t.Fatal(err)
	}
	if connects.Load() != 1 {
		t.Fatalf("proxy CONNECTs = %d, want 1", connects.Load())
	}
	// the proxy tunnels bytes only: an untrusted origin cert is still refused through it
	before := s.hits.Load()
	if _, err := submit(s.client(t, func(c *uploader.Config) { c.ProxyURL = purl; c.RootCAs = nil })); err == nil || s.hits.Load() != before {
		t.Fatalf("untrusted cert accepted via proxy (err=%v)", err)
	}
}

// TRD 5.7: proxy failure never falls back to direct or insecure.
func TestProxy_FailureNeverFallsBackToDirect(t *testing.T) {
	s := newTLSStub(t, ok200, nil)
	refused, _ := connectProxy(t, "502")
	dead := func() string {
		l, _ := net.Listen("tcp", "127.0.0.1:0")
		a := l.Addr().String()
		l.Close()
		return "http://" + a
	}()
	for name, purl := range map[string]string{"502": refused, "unreachable": dead} {
		if _, err := submit(s.client(t, func(c *uploader.Config) { c.ProxyURL = purl })); err == nil {
			t.Errorf("%s: proxy failure produced a success", name)
		}
	}
	if s.hits.Load() != 0 {
		t.Fatalf("server received %d direct requests after proxy failure", s.hits.Load())
	}
}

func TestProxy_InvalidURLRejectedAtConstruction(t *testing.T) {
	for _, bad := range []string{"::not a url", "ftp://proxy:21", "proxy-without-scheme"} {
		if _, err := uploader.NewClient(uploader.Config{BaseURL: "https://lims.example.test", Token: func() string { return "t" }, ProxyURL: bad}); err == nil {
			t.Errorf("proxy_url %q accepted", bad)
		}
	}
}

// REQ-SEC-115 CI gate (job c7-go-insecure-tls-gate): no InsecureSkipVerify in any non-test agent source.
func TestNoInsecureSkipVerifyInAgentSources(t *testing.T) {
	root := filepath.Join("..", "..")
	needle := "Insecure" + "SkipVerify"
	n := 0
	err := filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(p, ".go") || strings.HasSuffix(p, "_test.go") {
			return err
		}
		n++
		b, err := os.ReadFile(p)
		if err == nil && strings.Contains(string(b), needle) {
			t.Errorf("%s uses %s", p, needle)
		}
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	if n < 5 {
		t.Fatalf("gate looked at only %d files; wrong root?", n)
	}
}
