package heartbeat_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"lims/apps/bridge-agent/internal/heartbeat"
	"lims/apps/bridge-agent/internal/uploader"
)

func TestNewRequiresEveryCollaborator(t *testing.T) {
	good := func() heartbeat.Options {
		r := newRig(t)
		return heartbeat.Options{Sender: r.snd, Store: r.store, Source: fakeSource{}, Actions: r.act, Logs: r.logs, Redact: r.redact}
	}
	if _, err := heartbeat.New(good()); err != nil {
		t.Fatalf("complete options: %v", err)
	}
	for name, mut := range map[string]func(*heartbeat.Options){
		"sender":  func(o *heartbeat.Options) { o.Sender = nil },
		"store":   func(o *heartbeat.Options) { o.Store = nil },
		"source":  func(o *heartbeat.Options) { o.Source = nil },
		"actions": func(o *heartbeat.Options) { o.Actions = nil },
		"logs":    func(o *heartbeat.Options) { o.Logs = nil },
		"redact":  func(o *heartbeat.Options) { o.Redact = nil }, // log egress must never be possible without redaction
	} {
		o := good()
		mut(&o)
		if _, err := heartbeat.New(o); err == nil {
			t.Errorf("New without %s must fail", name)
		}
	}
}

// AC-13.1: the report carries the snapshot and the agent's own send time; no command results when none are pending.
func TestTickSendsSnapshotWithAgentTime(t *testing.T) {
	r := newRig(t)
	r.tick()
	if len(r.snd.reports) != 1 {
		t.Fatalf("reports = %d", len(r.snd.reports))
	}
	got := r.snd.reports[0]
	if got.SentAtAgent == "" {
		t.Fatal("sent_at_agent empty")
	}
	if ts, err := time.Parse(time.RFC3339Nano, got.SentAtAgent); err != nil || !ts.Equal(t0) {
		t.Fatalf("sent_at_agent = %q, want %v", got.SentAtAgent, t0)
	}
	want := snapshot()
	want.SentAtAgent = got.SentAtAgent
	if fmt.Sprintf("%+v", got) != fmt.Sprintf("%+v", want) {
		t.Fatalf("report differs from snapshot:\n got %+v\nwant %+v", got, want)
	}
	if len(got.CommandResults) != 0 {
		t.Fatalf("unexpected command_results %v", got.CommandResults)
	}
}

// done_when: commands executed once per command_id.
func TestCommandExecutedOncePerCommandID(t *testing.T) {
	r := newRig(t, resp(cmd(cmdA, "refresh_config")), resp(cmd(cmdA, "refresh_config")), resp(cmd(cmdA, "refresh_config")))
	r.tick() // delivered, executed
	r.tick() // re-delivered (server has no result yet), must not run again
	r.tick() // re-delivered again
	if r.act.refresh != 1 {
		t.Fatalf("RefreshConfig ran %d times, want 1", r.act.refresh)
	}
	if got := r.results(0); len(got) != 0 {
		t.Fatalf("first heartbeat carried results %v", got)
	}
	// the result is reported until a heartbeat carrying it succeeded, so heartbeat 2 has it
	if got := r.results(1); len(got) != 1 || got[0].CommandID != cmdA || got[0].State != "completed" {
		t.Fatalf("heartbeat 2 results = %+v", got)
	}
	// heartbeat 2 succeeded -> acked; heartbeat 3's response re-delivered A (server did not apply it) -> reported again, still not re-run
	if got := r.results(2); len(got) != 1 || got[0].CommandID != cmdA {
		t.Fatalf("heartbeat 3 results = %+v", got)
	}
}

func TestSameCommandTwiceInOneResponseRunsOnce(t *testing.T) {
	r := newRig(t, resp(cmd(cmdA, "refresh_config"), cmd(cmdA, "refresh_config")))
	r.tick()
	if r.act.refresh != 1 {
		t.Fatalf("RefreshConfig ran %d times, want 1", r.act.refresh)
	}
}

func TestResultReportedOnceAfterAck(t *testing.T) {
	r := newRig(t, resp(cmd(cmdA, "refresh_config")))
	r.tick()
	r.tick() // reports the result, success -> acked
	r.tick() // server stopped delivering A: nothing to report
	if len(r.results(1)) != 1 {
		t.Fatalf("heartbeat 2 results = %+v", r.results(1))
	}
	if got := r.results(2); len(got) != 0 {
		t.Fatalf("acked result repeated: %+v", got)
	}
}

func TestFailedHeartbeatKeepsResultsAndSkipsCommands(t *testing.T) {
	r := newRig(t, resp(cmd(cmdA, "refresh_config")))
	r.tick()
	r.tick() // sends result of A (acked)
	r.snd.hbErr = errors.New("network down")
	_ = r.store.Put(heartbeat.CommandRecord{CommandID: cmdB, Kind: "refresh_config", State: "completed"})
	if err := r.svc.Tick(context.Background()); err == nil {
		t.Fatal("Tick must return the send error")
	}
	if recs, _ := r.store.Unacked(20); len(recs) != 1 || recs[0].CommandID != cmdB {
		t.Fatalf("result lost or wrongly acked after failed send: %+v", recs)
	}
	r.snd.hbErr = nil
	r.tick()
	last := r.results(len(r.snd.reports) - 1)
	if len(last) != 1 || last[0].CommandID != cmdB {
		t.Fatalf("result not re-sent after recovery: %+v", last)
	}
}

func TestUnauthorizedIsSurfaced(t *testing.T) {
	r := newRig(t)
	r.snd.hbErr = &uploader.HTTPError{Status: 401, Code: "auth.device_token_invalid"}
	err := r.svc.Tick(context.Background())
	if !errors.Is(err, uploader.ErrUnauthorized) {
		t.Fatalf("want errors.Is(err, uploader.ErrUnauthorized), got %v", err)
	}
}

// F-10: restart_service is persisted as completed BEFORE the process exits, so the re-delivery after the SCM restart
// is answered, not executed (otherwise the agent would restart forever).
func TestRestartRecordedBeforeExitAndNotRepeatedAfterRestart(t *testing.T) {
	r := newRig(t, resp(cmd(cmdA, "restart_service")), resp(cmd(cmdA, "restart_service")))
	var seen heartbeat.CommandRecord
	r.act.onRestart = func() { seen, _, _ = r.store.Get(cmdA) }
	r.tick()
	if r.act.restart != 1 {
		t.Fatalf("RestartService calls = %d", r.act.restart)
	}
	if seen.State != "completed" {
		t.Fatalf("at the moment of restart the record was %+v, want state completed", seen)
	}
	r.rebuild() // new process, same persisted store
	r.tick()
	if r.act.restart != 1 {
		t.Fatalf("restart repeated after process restart (%d calls)", r.act.restart)
	}
	if got := r.results(1); len(got) != 1 || got[0].CommandID != cmdA || got[0].State != "completed" {
		t.Fatalf("restart result not reported after restart: %+v", got)
	}
}

// A crash in the middle of a command must not re-run it; the server is told it failed.
func TestInterruptedCommandIsReportedFailedNotRerun(t *testing.T) {
	r := newRig(t, resp(cmd(cmdA, "refresh_config")))
	_ = r.store.Put(heartbeat.CommandRecord{CommandID: cmdA, Kind: "refresh_config", State: "started"})
	r.tick()
	r.tick()
	if r.act.refresh != 0 {
		t.Fatalf("interrupted command re-ran (%d)", r.act.refresh)
	}
	got := r.results(1)
	if len(got) != 1 || got[0].State != "failed" || got[0].ResultCode == "" || len(got[0].ResultCode) > 64 {
		t.Fatalf("results = %+v", got)
	}
}

func TestStateStartedIsPersistedBeforeExecution(t *testing.T) {
	r := newRig(t, resp(cmd(cmdA, "refresh_config")))
	var during heartbeat.CommandRecord
	r.svc = mustNew(t, r, &hookActions{fakeActions: r.act, onRefresh: func() { during, _, _ = r.store.Get(cmdA) }})
	r.tick()
	if during.State != "started" {
		t.Fatalf("record during execution = %+v, want state started", during)
	}
	if after, _, _ := r.store.Get(cmdA); after.State != "completed" {
		t.Fatalf("record after execution = %+v", after)
	}
}

type hookActions struct {
	*fakeActions
	onRefresh func()
}

func (h *hookActions) RefreshConfig(ctx context.Context) error {
	h.onRefresh()
	return h.fakeActions.RefreshConfig(ctx)
}

func mustNew(t *testing.T, r *rig, a heartbeat.Actions) *heartbeat.Service {
	t.Helper()
	s, err := heartbeat.New(heartbeat.Options{Sender: r.snd, Store: r.store, Source: fakeSource{}, Actions: a, Logs: r.logs, Redact: r.redact, Now: r.nowFunc})
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func TestFailureReportsCodeNotErrorText(t *testing.T) {
	r := newRig(t, resp(cmd(cmdA, "refresh_config"), cmd(cmdB, "restart_service")))
	r.act.refreshErr = fmt.Errorf("open C:\\Users\\x\\%s.txt for %s: denied", synthBarcode, synthName) // error text may carry PHI/paths
	r.act.restartErr = codedErr{code: strings.Repeat("x", 100), msg: synthName}
	r.tick()
	r.tick()
	got := r.results(1)
	if len(got) != 2 {
		t.Fatalf("results = %+v", got)
	}
	for _, c := range got {
		if c.State != "failed" {
			t.Errorf("%s state = %q, want failed", c.CommandID, c.State)
		}
		if c.ResultCode == "" || len(c.ResultCode) > 64 {
			t.Errorf("%s result_code %q must be 1..64 chars", c.CommandID, c.ResultCode)
		}
		if strings.Contains(c.ResultCode, synthBarcode) || strings.Contains(c.ResultCode, synthName) || strings.Contains(c.ResultCode, "Users") {
			t.Errorf("%s result_code leaks error text: %q", c.CommandID, c.ResultCode)
		}
	}
}

func TestUnknownKindFailsWithoutRunningAnything(t *testing.T) {
	r := newRig(t, resp(cmd(cmdA, "format_disk"), cmd(cmdB, "REFRESH_CONFIG"), cmd(cmdC, "")))
	r.tick()
	r.tick()
	a := r.act
	if a.refresh+a.restart+a.requeue != 0 || r.logs.calls != 0 || len(r.snd.bundles) != 0 {
		t.Fatalf("unknown kind triggered an action: %+v", a)
	}
	got := r.results(1)
	if len(got) != 3 {
		t.Fatalf("results = %+v", got)
	}
	for _, c := range got {
		if c.State != "failed" || c.ResultCode == "" {
			t.Errorf("%+v", c)
		}
	}
}

func TestExpiredCommandIsNotExecuted(t *testing.T) {
	old := cmd(cmdA, "restart_service")
	old.ExpiresAt = iso(t0.Add(-time.Second))
	r := newRig(t, resp(old))
	r.tick()
	if r.act.restart != 0 {
		t.Fatal("expired restart_service executed")
	}
}

func TestMalformedExpiryIsNotExecuted(t *testing.T) {
	c := cmd(cmdA, "restart_service")
	c.ExpiresAt = "not-a-time"
	r := newRig(t, resp(c))
	r.tick()
	if r.act.restart != 0 {
		t.Fatal("command with unparseable expires_at executed")
	}
}

func TestAtMost20ResultsPerHeartbeat(t *testing.T) {
	r := newRig(t)
	for i := range 25 {
		_ = r.store.Put(heartbeat.CommandRecord{CommandID: fmt.Sprintf("0196a3c0-0000-7000-8000-%012d", i), Kind: "refresh_config", State: "completed"})
	}
	r.tick()
	r.tick()
	if n := len(r.results(0)); n != 20 {
		t.Fatalf("first heartbeat carried %d results, want 20", n)
	}
	if n := len(r.results(1)); n != 5 {
		t.Fatalf("second heartbeat carried %d results, want the remaining 5", n)
	}
}

// ---- upload_logs (AC-24.1) --------------------------------------------------------------------------------------------

func TestUploadLogsSendsLast24hRedacted(t *testing.T) {
	r := newRig(t, resp(cmd(cmdA, "upload_logs")))
	r.logs.lines = []string{"link up instrument=0196", "received barcode=" + synthBarcode + " ok"}
	r.tick()
	r.tick()
	if want := t0.Add(-24 * time.Hour); !r.logs.from.Equal(want) || !r.logs.to.Equal(t0) {
		t.Fatalf("log window = %v..%v, want %v..%v", r.logs.from, r.logs.to, want, t0)
	}
	if len(r.snd.bundles) != 1 {
		t.Fatalf("bundles = %d", len(r.snd.bundles))
	}
	b := r.snd.bundles[0]
	if b.CommandID != cmdA {
		t.Fatalf("bundle command_id = %q", b.CommandID)
	}
	if ts, err := time.Parse(time.RFC3339Nano, b.FromAtAgent); err != nil || !ts.Equal(t0.Add(-24*time.Hour)) {
		t.Fatalf("from_at_agent = %q", b.FromAtAgent)
	}
	if ts, err := time.Parse(time.RFC3339Nano, b.ToAtAgent); err != nil || !ts.Equal(t0) {
		t.Fatalf("to_at_agent = %q", b.ToAtAgent)
	}
	if len(b.Lines) != 2 || strings.Contains(strings.Join(b.Lines, "\n"), synthBarcode) {
		t.Fatalf("lines not redacted: %q", b.Lines)
	}
	if got := r.results(1); len(got) != 1 || got[0].State != "completed" {
		t.Fatalf("results = %+v", got)
	}
}

// Even if the log source were to return a raw line, the redactor runs on the way out.
func TestUploadLogsAppliesRedactorToEveryLine(t *testing.T) {
	r := newRig(t, resp(cmd(cmdA, "upload_logs")))
	r.redact = func(s string) string { return "R:" + s }
	r.rebuild()
	r.logs.lines = []string{"a", "b"}
	r.tick()
	if got := r.snd.bundles[0].Lines; len(got) != 2 || got[0] != "R:a" || got[1] != "R:b" {
		t.Fatalf("lines = %q", got)
	}
}

// E07 limits (02-TRD E07/7.4): 1..20000 lines, each <= 1000 chars, body <= 4 MiB. Newest lines win.
func TestUploadLogsRespectsWireLimits(t *testing.T) {
	r := newRig(t, resp(cmd(cmdA, "upload_logs")))
	lines := make([]string, 0, 30000)
	for i := range 30000 {
		lines = append(lines, fmt.Sprintf("line-%05d", i))
	}
	lines[29999] = strings.Repeat("z", 2500) + "END"
	r.logs.lines = lines
	r.tick()
	b := r.snd.bundles[0]
	if n := len(b.Lines); n < 1 || n > 20000 {
		t.Fatalf("%d lines, want 1..20000", n)
	}
	for i, l := range b.Lines {
		if len(l) > 1000 {
			t.Fatalf("line %d has %d chars (> 1000)", i, len(l))
		}
	}
	if !strings.HasPrefix(b.Lines[len(b.Lines)-1], "zzz") {
		t.Fatal("newest line was dropped; oldest must go first")
	}
	if b.Lines[0] == "line-00000" {
		t.Fatal("oldest line kept while newest were cut")
	}
}

func TestUploadLogsBodyUnder4MiB(t *testing.T) {
	r := newRig(t, resp(cmd(cmdA, "upload_logs")))
	big := strings.Repeat("y", 1000)
	lines := make([]string, 15000) // 15 MB raw
	for i := range lines {
		lines[i] = big
	}
	r.logs.lines = lines
	r.tick()
	body, err := json.Marshal(r.snd.bundles[0])
	if err != nil {
		t.Fatal(err)
	}
	if len(body) > 4<<20 {
		t.Fatalf("log bundle body %d bytes exceeds the 4 MiB route limit", len(body))
	}
}

func TestUploadLogsFailureIsReported(t *testing.T) {
	for name, setup := range map[string]func(*rig){
		"submit fails": func(r *rig) { r.snd.bundleErr = &uploader.HTTPError{Status: 409, Code: "instruments.invalid_transition"} },
		"read fails":   func(r *rig) { r.logs.err = errors.New("disk read error " + synthBarcode) },
	} {
		t.Run(name, func(t *testing.T) {
			r := newRig(t, resp(cmd(cmdA, "upload_logs")))
			r.logs.lines = []string{"x"}
			setup(r)
			r.tick()
			r.tick()
			got := r.results(1)
			if len(got) != 1 || got[0].State != "failed" || got[0].ResultCode == "" || strings.Contains(got[0].ResultCode, synthBarcode) {
				t.Fatalf("results = %+v", got)
			}
		})
	}
}

// ---- reupload_since (AC-24.2) -------------------------------------------------------------------------------------------

func TestReuploadSinceRequeuesFromGivenTime(t *testing.T) {
	since := t0.Add(-5 * time.Hour)
	r := newRig(t, resp(reupload(cmdA, since)))
	r.tick()
	r.tick()
	if r.act.requeue != 1 || len(r.act.since) != 1 || !r.act.since[0].Equal(since) {
		t.Fatalf("RequeueUploadedSince calls=%d since=%v, want 1 call with %v", r.act.requeue, r.act.since, since)
	}
	if got := r.results(1); len(got) != 1 || got[0].CommandID != cmdA || got[0].State != "completed" {
		t.Fatalf("results = %+v", got)
	}
}

func TestReuploadSinceOlderThan72hIsClampedToRetention(t *testing.T) {
	r := newRig(t, resp(reupload(cmdA, t0.Add(-100*time.Hour))))
	r.tick()
	if len(r.act.since) != 1 || r.act.since[0].Before(t0.Add(-72*time.Hour)) {
		t.Fatalf("since = %v, must not reach further back than 72 h", r.act.since)
	}
}

func TestReuploadSinceRejectsBadParams(t *testing.T) {
	missing := cmd(cmdA, "reupload_since")
	garbage := cmd(cmdB, "reupload_since")
	garbage.Params.Since = "yesterday"
	future := reupload(cmdC, t0.Add(time.Hour))
	r := newRig(t, resp(missing, garbage, future))
	r.tick()
	r.tick()
	if r.act.requeue != 0 {
		t.Fatalf("requeue ran for invalid params (%d)", r.act.requeue)
	}
	got := r.results(1)
	if len(got) != 3 {
		t.Fatalf("results = %+v", got)
	}
	for _, c := range got {
		if c.State != "failed" || c.ResultCode == "" {
			t.Errorf("%+v", c)
		}
	}
}

func TestReuploadFailureIsReported(t *testing.T) {
	r := newRig(t, resp(reupload(cmdA, t0.Add(-time.Hour))))
	r.act.rqErr = errors.New("sqlite busy")
	r.tick()
	r.tick()
	if got := r.results(1); len(got) != 1 || got[0].State != "failed" || got[0].ResultCode == "" {
		t.Fatalf("results = %+v", got)
	}
}

// ---- ordering ---------------------------------------------------------------------------------------------------------

func TestCommandsRunInResponseOrder(t *testing.T) {
	r := newRig(t, resp(cmd(cmdA, "refresh_config"), cmd(cmdB, "upload_logs"), reupload(cmdC, t0.Add(-time.Hour))))
	r.logs.lines = []string{"x"}
	r.tick()
	r.tick()
	got := r.results(1)
	if len(got) != 3 || got[0].CommandID != cmdA || got[1].CommandID != cmdB || got[2].CommandID != cmdC {
		t.Fatalf("results = %+v", got)
	}
}
