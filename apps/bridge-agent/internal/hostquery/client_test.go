package hostquery_test

import (
	"context"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"lims/apps/bridge-agent/internal/hostquery"
	"lims/apps/bridge-agent/internal/uploader"
)

func newStub(t *testing.T) *stub {
	t.Helper()
	s := &stub{status: 200, reply: replyBody("REPLY-1\r", "REPLY-2\r")}
	s.srv = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		s.hits++
		s.method, s.path, s.hdr = r.Method, r.URL.Path, r.Header.Clone()
		s.body, _ = io.ReadAll(r.Body)
		status, reply := s.status, s.reply
		s.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = io.WriteString(w, reply)
	}))
	t.Cleanup(s.srv.Close)
	s.pool = x509.NewCertPool()
	s.pool.AddCert(s.srv.Certificate())
	return s
}

func (s *stub) client(t *testing.T) *hostquery.Client {
	t.Helper()
	c, err := hostquery.NewClient(uploader.Config{BaseURL: s.srv.URL, Token: func() string { return tok }, RootCAs: s.pool, Timeout: 5 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func request() hostquery.Request {
	return hostquery.Request{InstrumentID: instID, AgentMessageID: itemA, Protocol: "astm", Raw: astmQuery, CapturedAt: t0, ClockOffsetMs: -400}
}

// ---- E05 wire contract -------------------------------------------------------------------------------------------------

func TestClient_WireRequestMatchesE05Contract(t *testing.T) {
	s := newStub(t)
	if _, err := s.client(t).SubmitHostQuery(context.Background(), "idem-1", request()); err != nil {
		t.Fatal(err)
	}
	if s.method != http.MethodPost || s.path != "/v1/instruments/agent/host-queries" {
		t.Errorf("%s %s, want POST /v1/instruments/agent/host-queries", s.method, s.path)
	}
	if s.hdr.Get("Authorization") != "Bearer "+tok || s.hdr.Get("Idempotency-Key") != "idem-1" ||
		!strings.HasPrefix(s.hdr.Get("Content-Type"), "application/json") {
		t.Errorf("headers wrong: %v", s.hdr)
	}
	var m map[string]any
	if err := json.Unmarshal(s.body, &m); err != nil {
		t.Fatal(err)
	}
	// additionalProperties:false and exactly these required keys (contracts/openapi/instruments.yaml)
	want := []string{"instrument_id", "agent_message_id", "protocol", "raw_base64", "raw_sha256", "captured_at_agent", "clock_offset_ms"}
	if len(m) != len(want) {
		t.Errorf("body has %d keys, want exactly %v; got %v", len(want), want, m)
	}
	for _, k := range want {
		if _, ok := m[k]; !ok {
			t.Errorf("missing key %q", k)
		}
	}
	sum := sha256.Sum256(astmQuery)
	if m["raw_base64"] != base64.StdEncoding.EncodeToString(astmQuery) || m["raw_sha256"] != hex.EncodeToString(sum[:]) {
		t.Error("raw_base64 / raw_sha256 do not describe the query bytes")
	}
	if m["instrument_id"] != instID || m["agent_message_id"] != itemA || m["protocol"] != "astm" ||
		m["captured_at_agent"] != "2026-11-11T08:30:00.000Z" || m["clock_offset_ms"] != float64(-400) {
		t.Errorf("field values wrong: %v", m)
	}
}

func TestClient_ParsesRepliesAndInstrumentMessageID(t *testing.T) {
	s := newStub(t)
	got, err := s.client(t).SubmitHostQuery(context.Background(), "k", request())
	if err != nil {
		t.Fatal(err)
	}
	if len(got.ReplyMessages) != 2 || string(got.ReplyMessages[0]) != "REPLY-1\r" || string(got.ReplyMessages[1]) != "REPLY-2\r" {
		t.Errorf("replies = %q", got.ReplyMessages)
	}
	if got.InstrumentMessageID != "0196a3c0-0000-7000-8000-0000000000ee" || got.ServerTime.IsZero() {
		t.Errorf("response = %+v", got)
	}
}

func TestClient_NonOKIsHTTPErrorWithServerCode(t *testing.T) {
	s := newStub(t)
	s.status, s.reply = 422, `{"error":{"code":"instruments.capability_not_supported"}}`
	_, err := s.client(t).SubmitHostQuery(context.Background(), "k", request())
	var he *uploader.HTTPError
	if !errors.As(err, &he) || he.Status != 422 || he.Code != "instruments.capability_not_supported" {
		t.Errorf("err = %v, want *uploader.HTTPError 422 with code", err)
	}
	s.status, s.reply = 401, `{"error":{"code":"auth.device_token_invalid"}}`
	if _, err := s.client(t).SubmitHostQuery(context.Background(), "k", request()); !errors.Is(err, uploader.ErrUnauthorized) {
		t.Errorf("401 must satisfy errors.Is(err, uploader.ErrUnauthorized), got %v", err)
	}
}

func TestClient_BadReplyBase64IsAnErrorNotAReply(t *testing.T) {
	s := newStub(t)
	s.reply = `{"server_time":"2026-11-11T08:30:00.200Z","instrument_message_id":"x","reply_messages":[{"raw_base64":"!!!not-base64!!!"}]}`
	got, err := s.client(t).SubmitHostQuery(context.Background(), "k", request())
	if err == nil || len(got.ReplyMessages) != 0 {
		t.Errorf("undecodable reply must be an error with no messages: %+v, %v", got, err)
	}
}

func TestClient_MalformedBodyIsAnError(t *testing.T) {
	s := newStub(t)
	s.reply = `<html>captive portal</html>`
	if _, err := s.client(t).SubmitHostQuery(context.Background(), "k", request()); err == nil {
		t.Error("a non-contract 200 body must not be treated as an empty answer")
	}
}

// ---- security ---------------------------------------------------------------------------------------------------------------

func TestClient_RefusesWithoutKeyOrToken(t *testing.T) {
	s := newStub(t)
	if _, err := s.client(t).SubmitHostQuery(context.Background(), "", request()); err == nil {
		t.Error("missing Idempotency-Key must not be sent (08 A13 P-8)")
	}
	c, err := hostquery.NewClient(uploader.Config{BaseURL: s.srv.URL, Token: func() string { return "" }, RootCAs: s.pool})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.SubmitHostQuery(context.Background(), "k", request()); err == nil {
		t.Error("empty device token must not be sent")
	}
	if s.hits != 0 {
		t.Errorf("%d requests reached the server, want 0", s.hits)
	}
}

func TestClient_RefusesPlainHTTPAndUntrustedCertificate(t *testing.T) {
	if _, err := hostquery.NewClient(uploader.Config{BaseURL: "http://lims.example.test", Token: func() string { return tok }}); err == nil {
		t.Error("http:// base URL accepted (REQ-SEC-115)")
	}
	s := newStub(t)
	c, err := hostquery.NewClient(uploader.Config{BaseURL: s.srv.URL, Token: func() string { return tok }, RootCAs: x509.NewCertPool(), Timeout: 5 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	_, err = c.SubmitHostQuery(context.Background(), "k", request())
	if err == nil {
		t.Fatal("untrusted certificate accepted")
	}
	if s.hits != 0 {
		t.Error("request body reached a server with an untrusted certificate")
	}
	if strings.Contains(err.Error(), tok) || strings.Contains(err.Error(), barcode) {
		t.Errorf("error text leaks token or barcode: %v", err)
	}
}

func TestClient_DoesNotFollowRedirects(t *testing.T) {
	hits := 0
	other := httptest.NewTLSServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { hits++ }))
	defer other.Close()
	s := newStub(t)
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, other.URL, http.StatusTemporaryRedirect)
	}))
	defer srv.Close()
	pool := x509.NewCertPool()
	pool.AddCert(srv.Certificate())
	pool.AddCert(other.Certificate())
	_ = s
	c, err := hostquery.NewClient(uploader.Config{BaseURL: srv.URL, Token: func() string { return tok }, RootCAs: pool, Timeout: 5 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.SubmitHostQuery(context.Background(), "k", request()); err == nil {
		t.Error("307 must be an error")
	}
	if hits != 0 {
		t.Error("the redirect was followed; the bearer token and query would leave the LIMS host")
	}
}

func TestClient_OversizeQueryIsRefusedBeforeSending(t *testing.T) {
	s := newStub(t)
	r := request()
	r.Raw = make([]byte, 64*1024+1) // E05 raw_base64 <= 64 KiB decoded
	if _, err := s.client(t).SubmitHostQuery(context.Background(), "k", r); err == nil {
		t.Error("query over 64 KiB accepted")
	}
	if s.hits != 0 {
		t.Error("oversize query was sent")
	}
}

func TestClient_RespectsContextDeadline(t *testing.T) {
	slow := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-r.Context().Done():
		case <-time.After(3 * time.Second):
		}
	}))
	defer slow.Close()
	pool := x509.NewCertPool()
	pool.AddCert(slow.Certificate())
	c, err := hostquery.NewClient(uploader.Config{BaseURL: slow.URL, Token: func() string { return tok }, RootCAs: pool, Timeout: 10 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()
	start := time.Now()
	if _, err := c.SubmitHostQuery(ctx, "k", request()); err == nil || time.Since(start) > 2*time.Second {
		t.Errorf("slow server not cut off by the ReplyTimeout context: err=%v after %v", err, time.Since(start))
	}
}

// ---- done_when: round trip with server stub; offline gives no reply -------------------------------------------------------

func realRelay(t *testing.T, s *stub) (*hostquery.Relay, *fakeOut, *fakeItems) {
	t.Helper()
	out, items := &fakeOut{}, &fakeItems{}
	rel, err := hostquery.New(hostquery.Options{Sender: s.client(t), Outbound: out, Items: items, Auth: &fakeAuth{state: "ok"},
		Now: func() time.Time { return t0 }})
	if err != nil {
		t.Fatal(err)
	}
	return rel, out, items
}

func TestRoundTrip_QueryGoesToServerAndRepliesReachTheLinkLayer(t *testing.T) {
	s := newStub(t)
	rel, out, items := realRelay(t, s)
	if got := rel.Handle(context.Background(), query(itemA)); got != hostquery.OutcomeReplied {
		t.Fatalf("outcome = %q, want replied", got)
	}
	if s.hits != 1 || out.n() != 2 || string(out.msgs[0].msg) != "REPLY-1\r" || string(out.msgs[1].msg) != "REPLY-2\r" {
		t.Errorf("hits=%d enqueued=%d", s.hits, out.n())
	}
	if !items.done(itemA) {
		t.Error("item not marked uploaded after 200")
	}
}

func TestOffline_ServerDownGivesNoReplyAndItemStaysPending(t *testing.T) {
	s := newStub(t)
	rel, out, items := realRelay(t, s)
	s.srv.Close() // server unreachable
	if got := rel.Handle(context.Background(), query(itemA)); got != hostquery.OutcomeUnavailable {
		t.Fatalf("outcome = %q, want unavailable", got)
	}
	if out.n() != 0 {
		t.Error("an invented reply was queued while offline (AC-10.6)")
	}
	if items.done(itemA) {
		t.Error("offline query must stay pending for the next batch upload")
	}
	if rel.Unavailable() != 1 {
		t.Errorf("host_query_unavailable = %d, want 1", rel.Unavailable())
	}
}

func TestOffline_Server5xxViaRealClientGivesNoReply(t *testing.T) {
	s := newStub(t)
	s.status, s.reply = 503, `{"error":{"code":"common.internal"}}`
	rel, out, items := realRelay(t, s)
	if got := rel.Handle(context.Background(), query(itemA)); got != hostquery.OutcomeUnavailable || out.n() != 0 || items.done(itemA) {
		t.Errorf("outcome=%q enqueued=%d uploaded=%v", got, out.n(), items.done(itemA))
	}
}
