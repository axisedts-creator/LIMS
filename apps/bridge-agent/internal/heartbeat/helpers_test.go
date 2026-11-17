package heartbeat_test

// Shared fakes for AG-T12. They also document the API the implementation must provide (package heartbeat):
//
//	type Report struct {                         // E03 request body, JSON tags = wire names (02-TRD 7.4); no nulls, optionals omitted when empty
//	    SentAtAgent, AgentVersion, LauncherVersion, OSVersion string
//	    Queue Queue; DiskFreeMB, ClockOffsetMs, ClockOffsetUncertaintyMs int64
//	    Config ConfigState; Update UpdateState; AuthState string
//	    Instruments []InstrumentLink; Counters Counters; CommandResults []CommandResult
//	}
//	type Queue struct{ Pending, Uploading, Rejected, Oversize, UploadedRetained, OldestPendingAgeSeconds int }
//	type ConfigState struct { AppliedVersion int; State string }
//	type UpdateState struct { State, TargetVersion, ErrorCode string }
//	type InstrumentLink struct { InstrumentID, LinkState, LastMessageAtAgent string; MessagesLastInterval, ErrorsLastInterval int; LastErrorCode string }
//	type Counters struct { AstmNaksSent, AstmNaksReceived, AstmIncompleteSessions, MllpDiscardedBytes, MllpOversize, HostQueryUnavailable int }
//	type CommandResult struct { CommandID, State, ResultCode string }     // State completed|failed
//	type Params struct{ Since string }
//	type Command struct { CommandID, Kind string; Params Params; ExpiresAt string }
//	type Response struct { ServerTime string; LatestConfigVersion int; HealthState string; Commands []Command }
//	type LogBundle struct { CommandID string; Lines []string; FromAtAgent, ToAtAgent string }   // E07 body, wire tags
//	type CommandRecord struct { CommandID, Kind, State, ResultCode string; Acked bool }       // State started|completed|failed
//	type CommandStore interface { Get(id string) (CommandRecord, bool, error); Put(CommandRecord) error; Unacked(limit int) ([]CommandRecord, error); Ack(ids []string) error }
//	type Sender interface { Heartbeat(ctx, Report) (Response, error); SubmitLogBundle(ctx, LogBundle) (string, error) }  // *Client implements it
//	type Source interface { Snapshot() Report }          // everything except SentAtAgent and CommandResults
//	type Actions interface { RefreshConfig(ctx) error; RestartService(ctx) error; RequeueUploadedSince(ctx, since time.Time) (int, error) }
//	type LogSource interface { Lines(from, to time.Time) ([]string, error) }
//	type Options struct { Sender; Store CommandStore; Source; Actions; Logs LogSource; Redact func(string) string; Now func() time.Time }
//	func New(Options) (*Service, error)   // error when any of Sender, Store, Source, Actions, Logs, Redact, is nil (Now defaults to time.Now)
//	func (*Service) Tick(ctx) error       // one heartbeat + execution of the commands in its response
//	func NewClient(uploader.Config) (*Client, error); (*Client).Heartbeat; (*Client).SubmitLogBundle
//	func NextDelay(rnd func() float64) time.Duration

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"

	"lims/apps/bridge-agent/internal/heartbeat"
)

var t0 = time.Date(2026, 11, 11, 8, 30, 0, 0, time.UTC)

const (
	cmdA = "0196a3c0-0000-7000-8000-00000000000a"
	cmdB = "0196a3c0-0000-7000-8000-00000000000b"
	cmdC = "0196a3c0-0000-7000-8000-00000000000c"
	// synthetic PHI-looking values; none may ever reach the wire in a heartbeat, result code or command result
	synthBarcode = "E2600000042"
	synthName    = "TESTPATIENT^SYNTHETIC"
)

func iso(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }

func snapshot() heartbeat.Report {
	return heartbeat.Report{
		AgentVersion: "1.2.3", LauncherVersion: "1.0.0", OSVersion: "Windows 11 10.0.26300",
		Queue:      heartbeat.Queue{Pending: 3, Uploading: 1, Rejected: 0, Oversize: 0, UploadedRetained: 10, OldestPendingAgeSeconds: 42},
		DiskFreeMB: 51200, ClockOffsetMs: -400, ClockOffsetUncertaintyMs: 100,
		Config:    heartbeat.ConfigState{AppliedVersion: 7, State: "ok"},
		Update:    heartbeat.UpdateState{State: "idle"},
		AuthState: "ok",
		Instruments: []heartbeat.InstrumentLink{{
			InstrumentID: "0196a3c0-0000-7000-8000-0000000000aa", LinkState: "up",
			LastMessageAtAgent: iso(t0.Add(-30 * time.Second)), MessagesLastInterval: 4,
		}},
		Counters: heartbeat.Counters{AstmNaksSent: 1, MllpOversize: 2},
	}
}

func cmd(id, kind string) heartbeat.Command {
	return heartbeat.Command{CommandID: id, Kind: kind, ExpiresAt: iso(t0.Add(23 * time.Hour))}
}

func reupload(id string, since time.Time) heartbeat.Command {
	c := cmd(id, "reupload_since")
	c.Params = heartbeat.Params{Since: iso(since)}
	return c
}

// ---- fakes -------------------------------------------------------------------------------------------------------

type fakeSender struct {
	mu        sync.Mutex
	reports   []heartbeat.Report
	script    []heartbeat.Response // one per Heartbeat call; after the script is used up, empty responses
	hbErr     error
	bundles   []heartbeat.LogBundle
	bundleErr error
}

func (s *fakeSender) Heartbeat(_ context.Context, r heartbeat.Report) (heartbeat.Response, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.hbErr != nil {
		return heartbeat.Response{}, s.hbErr
	}
	s.reports = append(s.reports, r)
	i := len(s.reports) - 1
	if i < len(s.script) {
		return s.script[i], nil
	}
	return heartbeat.Response{ServerTime: iso(t0), HealthState: "online"}, nil
}

func (s *fakeSender) SubmitLogBundle(_ context.Context, b heartbeat.LogBundle) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.bundleErr != nil {
		return "", s.bundleErr
	}
	s.bundles = append(s.bundles, b)
	return "bundle-1", nil
}

type memStore struct {
	mu   sync.Mutex
	recs map[string]heartbeat.CommandRecord
	seq  []string
}

func newStore() *memStore { return &memStore{recs: map[string]heartbeat.CommandRecord{}} }

func (m *memStore) Get(id string) (heartbeat.CommandRecord, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	r, ok := m.recs[id]
	return r, ok, nil
}

func (m *memStore) Put(r heartbeat.CommandRecord) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.recs[r.CommandID]; !ok {
		m.seq = append(m.seq, r.CommandID)
	}
	m.recs[r.CommandID] = r
	return nil
}

func (m *memStore) Unacked(limit int) ([]heartbeat.CommandRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []heartbeat.CommandRecord
	for _, id := range m.seq {
		r := m.recs[id]
		if (r.State == "completed" || r.State == "failed") && !r.Acked && len(out) < limit {
			out = append(out, r)
		}
	}
	return out, nil
}

func (m *memStore) Ack(ids []string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, id := range ids {
		r := m.recs[id]
		r.Acked = true
		m.recs[id] = r
	}
	return nil
}

type fakeSource struct{}

func (fakeSource) Snapshot() heartbeat.Report { return snapshot() }

type fakeActions struct {
	mu                          sync.Mutex
	refresh, restart, requeue   int
	since                       []time.Time
	refreshErr, restartErr, rqErr error
	onRestart                   func() // runs inside RestartService, before it returns
}

func (a *fakeActions) RefreshConfig(context.Context) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.refresh++
	return a.refreshErr
}

func (a *fakeActions) RestartService(context.Context) error {
	a.mu.Lock()
	a.restart++
	f, err := a.onRestart, a.restartErr
	a.mu.Unlock()
	if f != nil {
		f()
	}
	return err
}

func (a *fakeActions) RequeueUploadedSince(_ context.Context, since time.Time) (int, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.requeue++
	a.since = append(a.since, since)
	return 5, a.rqErr
}

type fakeLogs struct {
	lines    []string
	from, to time.Time
	calls    int
	err      error
}

func (l *fakeLogs) Lines(from, to time.Time) ([]string, error) {
	l.calls++
	l.from, l.to = from, to
	return l.lines, l.err
}

// codedErr lets a handler choose the result_code (<= 64 chars) that is reported.
type codedErr struct{ code, msg string }

func (e codedErr) Error() string { return e.msg }
func (e codedErr) Code() string  { return e.code }

type rig struct {
	t       *testing.T
	snd     *fakeSender
	store   *memStore
	act     *fakeActions
	logs    *fakeLogs
	redact  func(string) string
	svc     *heartbeat.Service
	nowFunc func() time.Time
}

func newRig(t *testing.T, script ...heartbeat.Response) *rig {
	t.Helper()
	r := &rig{t: t, snd: &fakeSender{script: script}, store: newStore(), act: &fakeActions{}, logs: &fakeLogs{},
		redact: func(s string) string { return strings.ReplaceAll(s, synthBarcode, "[REDACTED]") }, nowFunc: func() time.Time { return t0 }}
	r.rebuild()
	return r
}

// rebuild makes a fresh Service over the same store (simulates a process restart).
func (r *rig) rebuild() {
	r.t.Helper()
	svc, err := heartbeat.New(heartbeat.Options{Sender: r.snd, Store: r.store, Source: fakeSource{}, Actions: r.act,
		Logs: r.logs, Redact: r.redact, Now: r.nowFunc})
	if err != nil {
		r.t.Fatalf("New: %v", err)
	}
	r.svc = svc
}

func (r *rig) tick() {
	r.t.Helper()
	if err := r.svc.Tick(context.Background()); err != nil {
		r.t.Fatalf("Tick: %v", err)
	}
}

func resp(cmds ...heartbeat.Command) heartbeat.Response {
	return heartbeat.Response{ServerTime: iso(t0), LatestConfigVersion: 7, HealthState: "online", Commands: cmds}
}

func (r *rig) results(i int) []heartbeat.CommandResult {
	r.t.Helper()
	if i >= len(r.snd.reports) {
		r.t.Fatalf("only %d heartbeats sent, wanted index %d", len(r.snd.reports), i)
	}
	return r.snd.reports[i].CommandResults
}

func mustJSON(t *testing.T, v any) map[string]any {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	return m
}
