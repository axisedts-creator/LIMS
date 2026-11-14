package heartbeat_test

import (
	"context"
	"crypto/x509"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"lims/apps/bridge-agent/internal/heartbeat"
	"lims/apps/bridge-agent/internal/uploader"
)

const tok = "lmsd_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"

type stub struct {
	srv    *httptest.Server
	pool   *x509.CertPool
	method string
	path   string
	hdr    http.Header
	body   []byte
	status int
	reply  string
}

func newStub(t *testing.T) *stub {
	t.Helper()
	s := &stub{status: 200}
	s.srv = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.method, s.path, s.hdr = r.Method, r.URL.Path, r.Header.Clone()
		s.body, _ = io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(s.status)
		_, _ = io.WriteString(w, s.reply)
	}))
	t.Cleanup(s.srv.Close)
	s.pool = x509.NewCertPool()
	s.pool.AddCert(s.srv.Certificate())
	return s
}

func (s *stub) client(t *testing.T) *heartbeat.Client {
	t.Helper()
	c, err := heartbeat.NewClient(uploader.Config{BaseURL: s.srv.URL, Token: func() string { return tok }, RootCAs: s.pool, Timeout: 5 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func noNulls(t *testing.T, path string, v any) {
	t.Helper()
	switch x := v.(type) {
	case nil:
		t.Errorf("null on the wire at %s (02-TRD 7.4: no nulls)", path)
	case map[string]any:
		for k, e := range x {
			noNulls(t, path+"."+k, e)
		}
	case []any:
		for i, e := range x {
			noNulls(t, path+"[]"+string(rune('0'+i%10)), e)
		}
	}
}

func keys(m map[string]any) map[string]bool {
	out := map[string]bool{}
	for k := range m {
		out[k] = true
	}
	return out
}

// E03 contract: POST /v1/instruments/agent/heartbeats, bearer token, schema of 02-TRD 7.4.
func TestHeartbeatRequestMatchesE03Schema(t *testing.T) {
	s := newStub(t)
	s.reply = `{"server_time":"2026-11-11T08:30:00.000Z","latest_config_version":8,"health_state":"online","commands":[]}`
	rep := snapshot()
	rep.SentAtAgent = iso(t0)
	rep.CommandResults = []heartbeat.CommandResult{{CommandID: cmdA, State: "completed"}, {CommandID: cmdB, State: "failed", ResultCode: "refresh_failed"}}
	if _, err := s.client(t).Heartbeat(context.Background(), rep); err != nil {
		t.Fatal(err)
	}
	if s.method != http.MethodPost || s.path != "/v1/instruments/agent/heartbeats" {
		t.Fatalf("%s %s", s.method, s.path)
	}
	if s.hdr.Get("Authorization") != "Bearer "+tok {
		t.Errorf("Authorization = %q", s.hdr.Get("Authorization"))
	}
	if !strings.HasPrefix(s.hdr.Get("Content-Type"), "application/json") {
		t.Errorf("Content-Type = %q", s.hdr.Get("Content-Type"))
	}
	var m map[string]any
	if err := json.Unmarshal(s.body, &m); err != nil {
		t.Fatalf("body is not JSON: %v", err)
	}
	noNulls(t, "$", m)
	allowed := map[string]bool{"sent_at_agent": true, "agent_version": true, "launcher_version": true, "os_version": true, "queue": true,
		"disk_free_mb": true, "clock_offset_ms": true, "clock_offset_uncertainty_ms": true, "config": true, "update": true,
		"auth_state": true, "instruments": true, "counters": true, "command_results": true}
	for k := range m { // additionalProperties: false
		if !allowed[k] {
			t.Errorf("unexpected top-level key %q", k)
		}
	}
	for k := range allowed {
		if !keys(m)[k] {
			t.Errorf("missing top-level key %q", k)
		}
	}
	q := m["queue"].(map[string]any)
	for _, k := range []string{"pending", "uploading", "rejected", "oversize", "uploaded_retained", "oldest_pending_age_seconds"} {
		if _, ok := q[k]; !ok {
			t.Errorf("queue.%s missing", k)
		}
	}
	if len(q) != 6 {
		t.Errorf("queue keys = %v", keys(q))
	}
	cfg := m["config"].(map[string]any)
	if cfg["applied_version"] != float64(7) || cfg["state"] != "ok" {
		t.Errorf("config = %v", cfg)
	}
	upd := m["update"].(map[string]any)
	if upd["state"] != "idle" || len(upd) != 1 { // target_version / error_code omitted when empty
		t.Errorf("update = %v", upd)
	}
	ins := m["instruments"].([]any)[0].(map[string]any)
	for _, k := range []string{"instrument_id", "link_state", "messages_last_interval", "errors_last_interval"} {
		if _, ok := ins[k]; !ok {
			t.Errorf("instruments[0].%s missing", k)
		}
	}
	if _, ok := ins["last_error_code"]; ok {
		t.Error("empty last_error_code must be omitted, not sent")
	}
	ctr := m["counters"].(map[string]any)
	for _, k := range []string{"astm_naks_sent", "astm_naks_received", "astm_incomplete_sessions", "mllp_discarded_bytes", "mllp_oversize", "host_query_unavailable"} {
		if _, ok := ctr[k]; !ok {
			t.Errorf("counters.%s missing", k)
		}
	}
	cr := m["command_results"].([]any)
	if len(cr) != 2 {
		t.Fatalf("command_results = %v", cr)
	}
	first := cr[0].(map[string]any)
	if first["command_id"] != cmdA || first["state"] != "completed" || len(first) != 2 {
		t.Errorf("command_results[0] = %v (empty result_code must be omitted)", first)
	}
	if cr[1].(map[string]any)["result_code"] != "refresh_failed" {
		t.Errorf("command_results[1] = %v", cr[1])
	}
}

func TestHeartbeatWithNoResultsHasNoNulls(t *testing.T) {
	s := newStub(t)
	s.reply = `{"server_time":"2026-11-11T08:30:00.000Z","latest_config_version":1,"health_state":"online","commands":[]}`
	rep := snapshot()
	rep.SentAtAgent = iso(t0)
	if _, err := s.client(t).Heartbeat(context.Background(), rep); err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	_ = json.Unmarshal(s.body, &m)
	noNulls(t, "$", m)
}

func TestHeartbeatResponseParsing(t *testing.T) {
	s := newStub(t)
	s.reply = `{"server_time":"2026-11-11T08:30:00.000Z","latest_config_version":8,"health_state":"degraded","commands":[
	 {"command_id":"` + cmdA + `","kind":"refresh_config","params":{},"expires_at":"2026-11-12T08:30:00.000Z"},
	 {"command_id":"` + cmdB + `","kind":"reupload_since","params":{"since":"2026-11-10T08:30:00.000Z"},"expires_at":"2026-11-12T08:30:00.000Z"}]}`
	got, err := s.client(t).Heartbeat(context.Background(), snapshot())
	if err != nil {
		t.Fatal(err)
	}
	if got.LatestConfigVersion != 8 || got.HealthState != "degraded" || got.ServerTime != "2026-11-11T08:30:00.000Z" {
		t.Errorf("response = %+v", got)
	}
	if len(got.Commands) != 2 || got.Commands[0].CommandID != cmdA || got.Commands[0].Kind != "refresh_config" ||
		got.Commands[1].Params.Since != "2026-11-10T08:30:00.000Z" || got.Commands[1].ExpiresAt == "" {
		t.Errorf("commands = %+v", got.Commands)
	}
}

func TestHeartbeatHTTPErrors(t *testing.T) {
	for _, st := range []int{400, 401, 429, 500, 503} {
		s := newStub(t)
		s.status, s.reply = st, `{"error":{"code":"x"}}`
		_, err := s.client(t).Heartbeat(context.Background(), snapshot())
		var he *uploader.HTTPError
		if !errors.As(err, &he) || he.Status != st {
			t.Errorf("status %d: err = %v", st, err)
		}
		if st == 401 && !errors.Is(err, uploader.ErrUnauthorized) {
			t.Errorf("401 must satisfy errors.Is(err, uploader.ErrUnauthorized)")
		}
	}
}

func TestHeartbeatMalformedResponseIsAnError(t *testing.T) {
	s := newStub(t)
	s.reply = `<html>captive portal</html>`
	if _, err := s.client(t).Heartbeat(context.Background(), snapshot()); err == nil {
		t.Fatal("non-JSON 200 must be an error")
	}
}

// Security: same TLS rules as the uploader (REQ-SEC-114): https only, verified chain, token required, no redirects.
func TestClientRefusesPlainHTTPAndMissingToken(t *testing.T) {
	if _, err := heartbeat.NewClient(uploader.Config{BaseURL: "http://lims.example.org", Token: func() string { return tok }}); err == nil {
		t.Error("http:// base URL accepted")
	}
	if _, err := heartbeat.NewClient(uploader.Config{BaseURL: "https://lims.example.org"}); err == nil {
		t.Error("missing token source accepted")
	}
	var hits atomic.Int32
	srv := httptest.NewTLSServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { hits.Add(1) }))
	defer srv.Close()
	c, err := heartbeat.NewClient(uploader.Config{BaseURL: srv.URL, Token: func() string { return "" }, RootCAs: x509.NewCertPool()})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.Heartbeat(context.Background(), snapshot()); err == nil {
		t.Error("empty token must not be sent")
	}
	if hits.Load() != 0 {
		t.Error("a request was sent without a token / with an untrusted certificate")
	}
}

func TestClientDoesNotFollowRedirects(t *testing.T) {
	var elsewhere atomic.Int32
	other := httptest.NewTLSServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { elsewhere.Add(1) }))
	defer other.Close()
	s := newStub(t)
	s.srv.Config.Handler = http.RedirectHandler(other.URL, http.StatusTemporaryRedirect)
	pool := x509.NewCertPool()
	pool.AddCert(s.srv.Certificate())
	pool.AddCert(other.Certificate())
	c, err := heartbeat.NewClient(uploader.Config{BaseURL: s.srv.URL, Token: func() string { return tok }, RootCAs: pool})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.Heartbeat(context.Background(), snapshot()); err == nil {
		t.Error("redirect treated as success")
	}
	if elsewhere.Load() != 0 {
		t.Error("bearer token sent to the redirect target")
	}
}

// E07 contract.
func TestLogBundleRequestMatchesE07(t *testing.T) {
	s := newStub(t)
	s.status, s.reply = 201, `{"bundle_id":"0196a3c0-0000-7000-8000-0000000000bb"}`
	id, err := s.client(t).SubmitLogBundle(context.Background(), heartbeat.LogBundle{
		CommandID: cmdA, Lines: []string{"one", "two"}, FromAtAgent: iso(t0.Add(-24 * time.Hour)), ToAtAgent: iso(t0)})
	if err != nil {
		t.Fatal(err)
	}
	if id != "0196a3c0-0000-7000-8000-0000000000bb" {
		t.Errorf("bundle id = %q", id)
	}
	if s.method != http.MethodPost || s.path != "/v1/instruments/agent/log-bundles" {
		t.Fatalf("%s %s", s.method, s.path)
	}
	if s.hdr.Get("Authorization") != "Bearer "+tok {
		t.Errorf("Authorization = %q", s.hdr.Get("Authorization"))
	}
	if got := s.hdr.Get("Idempotency-Key"); got != cmdA { // E07: Idempotency required (02-TRD 7.2, 02-CONVENTIONS 4.5)
		t.Errorf("Idempotency-Key = %q, want the bundle command_id %q", got, cmdA)
	}
	var m map[string]any
	if err := json.Unmarshal(s.body, &m); err != nil {
		t.Fatal(err)
	}
	if len(m) != 4 || m["command_id"] != cmdA || len(m["lines"].([]any)) != 2 || m["from_at_agent"] == nil || m["to_at_agent"] == nil {
		t.Errorf("body = %v", m)
	}
}

func TestLogBundleHTTPErrors(t *testing.T) {
	for _, st := range []int{404, 409, 413} {
		s := newStub(t)
		s.status, s.reply = st, `{"error":{"code":"instruments.invalid_transition"}}`
		_, err := s.client(t).SubmitLogBundle(context.Background(), heartbeat.LogBundle{CommandID: cmdA, Lines: []string{"x"}, FromAtAgent: iso(t0), ToAtAgent: iso(t0)})
		var he *uploader.HTTPError
		if !errors.As(err, &he) || he.Status != st {
			t.Errorf("status %d: err = %v", st, err)
		}
	}
}

// AC-13.1: every 60 s, jitter +/- 2 s [CONV] (03-APP-FLOW F-10).
func TestNextDelayIs60sPlusMinus2s(t *testing.T) {
	for _, c := range []struct {
		rnd  float64
		want time.Duration
	}{{0, 58 * time.Second}, {0.5, 60 * time.Second}} {
		if got := heartbeat.NextDelay(func() float64 { return c.rnd }); got != c.want {
			t.Errorf("rnd=%v: %v, want %v", c.rnd, got, c.want)
		}
	}
	for _, r := range []float64{0.0001, 0.25, 0.75, 0.9999999} {
		got := heartbeat.NextDelay(func() float64 { return r })
		if got < 58*time.Second || got > 62*time.Second {
			t.Errorf("rnd=%v: %v outside 58..62 s", r, got)
		}
	}
}
