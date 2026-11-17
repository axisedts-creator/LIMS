package status_test

// AG-T15 tests for package status (02-TRD 5.13, AC-22.1). They also document the API the implementation must provide:
//
//	const FileName = "status.json"
//	const Interval = 10 * time.Second                 // the service rewrites the file every 10 s
//	var ErrNotFound error                             // Read: no status.json yet
//	type Queue struct{ Pending, Uploading, Rejected, Oversize, UploadedRetained, OldestPendingAgeSeconds int }
//	    // json: pending, uploading, rejected, oversize, uploaded_retained, oldest_pending_age_seconds
//	type Instrument struct{ InstrumentCode, LinkState, LastMessageAtAgent string; MessagesToday int; LastErrorCode string }
//	    // json: instrument_code, link_state, last_message_at_agent (omitempty), messages_today, last_error_code (omitempty)
//	type Status struct {
//	    ServiceState, AgentID, AgentVersion, LauncherVersion string           // service_state, agent_id, agent_version, launcher_version
//	    ServerReachable bool                                                  // server_reachable
//	    LastHeartbeatAt, LastHeartbeatOutcome, AuthState string               // last_heartbeat_at, last_heartbeat_outcome, auth_state
//	    ConfigVersion int; ConfigState, UpdateState string                    // config_version, config_state, update_state
//	    Queue Queue; DiskFreeMB int64                                         // queue, disk_free_mb
//	    Instruments []Instrument; Counters map[string]int64                   // instruments, counters
//	}
//	func Write(dir string, s Status) error            // atomic (temp file in dir + rename); leaves no temp file; retries a rename that Windows refuses while a reader holds the file
//	func Read(dir string) (Status, error)             // ErrNotFound when absent; any other error for unreadable or corrupt JSON
//	func Run(ctx context.Context, dir string, snapshot func() Status, every time.Duration) error // writes at once, then every `every`; returns ctx.Err() on cancel

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"lims/apps/bridge-agent/internal/status"
)

func full() status.Status {
	return status.Status{
		ServiceState: "RUNNING", AgentID: "01a1a98a-0000-7000-8000-0000000d0101", AgentVersion: "1.0.0", LauncherVersion: "1.0.0",
		ServerReachable: true, LastHeartbeatAt: "2026-11-11T08:30:00.000Z", LastHeartbeatOutcome: "ok", AuthState: "ok",
		ConfigVersion: 7, ConfigState: "applied", UpdateState: "idle",
		Queue:       status.Queue{Pending: 1, Uploading: 2, Rejected: 3, Oversize: 4, UploadedRetained: 1204, OldestPendingAgeSeconds: 42},
		DiskFreeMB:  41230,
		Instruments: []status.Instrument{{InstrumentCode: "SIM-CHEM-1", LinkState: "up", LastMessageAtAgent: "2026-11-11T08:28:00.000Z", MessagesToday: 9, LastErrorCode: "tcp_connect_refused"}},
		Counters:    map[string]int64{"astm_naks_sent": 2},
	}
}

func TestConstants(t *testing.T) {
	if status.FileName != "status.json" {
		t.Fatalf("FileName = %q", status.FileName)
	}
	if status.Interval != 10*time.Second {
		t.Fatalf("Interval = %v, want 10s (02-TRD 5.13)", status.Interval)
	}
}

func TestWriteReadRoundTrip(t *testing.T) {
	dir := t.TempDir()
	want := full()
	if err := status.Write(dir, want); err != nil {
		t.Fatal(err)
	}
	got, err := status.Read(dir)
	if err != nil {
		t.Fatal(err)
	}
	a, _ := json.Marshal(want)
	b, _ := json.Marshal(got)
	if string(a) != string(b) {
		t.Fatalf("round trip differs:\n want %s\n  got %s", a, b)
	}
}

// 02-TRD 5.13: the file carries these fields and nothing else. No barcodes, values, names, raw bytes, tokens.
func keys(m map[string]any) []string {
	var k []string
	for x := range m {
		k = append(k, x)
	}
	sort.Strings(k)
	return k
}

func sameKeys(t *testing.T, where string, m map[string]any, want ...string) {
	t.Helper()
	sort.Strings(want)
	got := keys(m)
	if len(got) != len(want) {
		t.Fatalf("%s keys = %v, want %v", where, got, want)
	}
	for i := range got {
		if got[i] != want[i] {
			t.Fatalf("%s keys = %v, want %v", where, got, want)
		}
	}
}

func TestWireSchemaIsExactlyTheTRDFieldSet(t *testing.T) {
	dir := t.TempDir()
	if err := status.Write(dir, full()); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(filepath.Join(dir, status.FileName))
	if err != nil {
		t.Fatal(err)
	}
	var top map[string]any
	if err := json.Unmarshal(raw, &top); err != nil {
		t.Fatalf("status.json is not a JSON object: %v", err)
	}
	sameKeys(t, "top level", top, "service_state", "agent_id", "agent_version", "launcher_version", "server_reachable",
		"last_heartbeat_at", "last_heartbeat_outcome", "auth_state", "config_version", "config_state", "update_state",
		"queue", "disk_free_mb", "instruments", "counters")
	sameKeys(t, "queue", top["queue"].(map[string]any), "pending", "uploading", "rejected", "oversize", "uploaded_retained", "oldest_pending_age_seconds")
	ins := top["instruments"].([]any)
	if len(ins) != 1 {
		t.Fatalf("instruments = %v", ins)
	}
	sameKeys(t, "instrument", ins[0].(map[string]any), "instrument_code", "link_state", "last_message_at_agent", "messages_today", "last_error_code")
}

func TestOptionalInstrumentFieldsOmittedWhenEmpty(t *testing.T) {
	dir := t.TempDir()
	s := full()
	s.Instruments = []status.Instrument{{InstrumentCode: "SIM-HEMA-1", LinkState: "connecting"}}
	if err := status.Write(dir, s); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(filepath.Join(dir, status.FileName))
	var top map[string]any
	_ = json.Unmarshal(raw, &top)
	sameKeys(t, "instrument", top["instruments"].([]any)[0].(map[string]any), "instrument_code", "link_state", "messages_today")
}

func TestWriteIsAtomicAndLeavesNoTempFile(t *testing.T) {
	dir := t.TempDir()
	s := full()
	for i := 0; i < 20; i++ {
		s.ConfigVersion = i
		if err := status.Write(dir, s); err != nil {
			t.Fatal(err)
		}
	}
	ents, _ := os.ReadDir(dir)
	if len(ents) != 1 || ents[0].Name() != status.FileName {
		var n []string
		for _, e := range ents {
			n = append(n, e.Name())
		}
		t.Fatalf("dir holds %v, want only status.json", n)
	}
	got, _ := status.Read(dir)
	if got.ConfigVersion != 19 {
		t.Fatalf("last write did not win: %d", got.ConfigVersion)
	}
}

// The CLI reads while the service writes. A reader must never see a torn file, and the writer must not fail because a reader
// holds the file open (Windows refuses to rename over a file that is open without FILE_SHARE_DELETE).
func TestConcurrentReadersNeverSeeTornFileAndWriterNeverFails(t *testing.T) {
	dir := t.TempDir()
	if err := status.Write(dir, full()); err != nil {
		t.Fatal(err)
	}
	var stop atomic.Bool
	var wg sync.WaitGroup
	var bad atomic.Int64
	var firstBad atomic.Value
	for r := 0; r < 4; r++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for !stop.Load() {
				if _, err := status.Read(dir); err != nil {
					bad.Add(1)
					firstBad.CompareAndSwap(nil, err.Error())
				}
			}
		}()
	}
	s := full()
	var werr error
	for i := 0; i < 300 && werr == nil; i++ {
		s.ConfigVersion = i
		s.Instruments = append(s.Instruments[:1], status.Instrument{InstrumentCode: "SIM-X", LinkState: "up", MessagesToday: i})
		werr = status.Write(dir, s)
	}
	stop.Store(true)
	wg.Wait()
	if werr != nil {
		t.Fatalf("Write failed while readers were active: %v", werr)
	}
	if bad.Load() != 0 {
		t.Fatalf("%d reads failed or saw a torn file, first: %v", bad.Load(), firstBad.Load())
	}
}

func TestReadMissingIsErrNotFound(t *testing.T) {
	_, err := status.Read(t.TempDir())
	if !errors.Is(err, status.ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
}

func TestReadCorruptIsNotErrNotFound(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, status.FileName), []byte(`{"service_state":`), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := status.Read(dir)
	if err == nil || errors.Is(err, status.ErrNotFound) {
		t.Fatalf("err = %v, want a parse error that is not ErrNotFound", err)
	}
}

func TestWriteIntoMissingDirFails(t *testing.T) {
	if err := status.Write(filepath.Join(t.TempDir(), "nope", "deeper"), full()); err == nil {
		t.Fatal("Write into a missing directory must fail, not silently succeed")
	}
}

func TestRunWritesImmediatelyThenEveryIntervalAndStopsOnCancel(t *testing.T) {
	dir := t.TempDir()
	var n atomic.Int64
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- status.Run(ctx, dir, func() status.Status {
			s := full()
			s.ConfigVersion = int(n.Add(1))
			return s
		}, 20*time.Millisecond)
	}()
	deadline := time.Now().Add(3 * time.Second)
	for n.Load() < 3 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if n.Load() < 3 {
		t.Fatalf("snapshot called %d times in 3 s with a 20 ms interval", n.Load())
	}
	if _, err := status.Read(dir); err != nil {
		t.Fatalf("no readable status.json while running: %v", err)
	}
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("Run returned %v, want context.Canceled", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Run did not stop after cancel")
	}
	after := n.Load()
	time.Sleep(100 * time.Millisecond)
	if n.Load() != after {
		t.Fatal("Run kept writing after cancel")
	}
}

func TestRunFirstWriteIsImmediate(t *testing.T) {
	dir := t.TempDir()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = status.Run(ctx, dir, full, time.Hour) }()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := status.Read(dir); err == nil {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("status.json not written within 2 s although the interval is 1 h")
}
