package svc_test

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"lims/apps/bridge-agent/internal/svc"
)

type counters struct{ hb, fl atomic.Int64 }

func (c *counters) triggers() svc.Triggers {
	return svc.Triggers{HeartbeatNow: func() { c.hb.Add(1) }, FlushNow: func() { c.fl.Add(1) }}
}

// 02-TRD 5.12: user-defined control codes 128 (heartbeat now) and 129 (flush now); nothing else does anything.
func TestHandleControl(t *testing.T) {
	var c counters
	if !svc.HandleControl(128, c.triggers()) || c.hb.Load() != 1 || c.fl.Load() != 0 {
		t.Fatalf("128: hb=%d fl=%d", c.hb.Load(), c.fl.Load())
	}
	if !svc.HandleControl(129, c.triggers()) || c.hb.Load() != 1 || c.fl.Load() != 1 {
		t.Fatalf("129: hb=%d fl=%d", c.hb.Load(), c.fl.Load())
	}
	for _, code := range []uint32{0, 1, 2, 3, 4, 127, 130, 200, 255, 256, 1 << 31, 0xFFFFFFFF} {
		if svc.HandleControl(code, c.triggers()) {
			t.Errorf("code %d reported as handled", code)
		}
	}
	if c.hb.Load() != 1 || c.fl.Load() != 1 {
		t.Fatalf("an unassigned control code fired a trigger: hb=%d fl=%d", c.hb.Load(), c.fl.Load())
	}
}

func TestHandleControlNilTriggersDoNotPanic(t *testing.T) {
	svc.HandleControl(128, svc.Triggers{})
	svc.HandleControl(129, svc.Triggers{})
}

func readRequest(t *testing.T, dir string) map[string]any {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(dir, svc.RequestFile))
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatalf("request.json is not a JSON object: %v", err)
	}
	return m
}

func TestWriteRequestThenConsumeFiresOnceAndDeletes(t *testing.T) {
	for kind, which := range map[string]string{svc.RequestHeartbeatNow: "hb", svc.RequestFlushNow: "fl"} {
		dir := t.TempDir()
		if err := svc.WriteRequest(dir, kind); err != nil {
			t.Fatalf("%s: %v", kind, err)
		}
		if readRequest(t, dir)["kind"] != kind {
			t.Fatalf("%s: request.json = %v", kind, readRequest(t, dir))
		}
		var c counters
		handled, err := svc.ConsumeRequest(dir, c.triggers())
		if err != nil || !handled {
			t.Fatalf("%s: handled=%v err=%v", kind, handled, err)
		}
		if which == "hb" && (c.hb.Load() != 1 || c.fl.Load() != 0) || which == "fl" && (c.fl.Load() != 1 || c.hb.Load() != 0) {
			t.Fatalf("%s: hb=%d fl=%d", kind, c.hb.Load(), c.fl.Load())
		}
		ents, _ := os.ReadDir(dir)
		if len(ents) != 0 {
			t.Fatalf("%s: %d files left in the status dir after consume", kind, len(ents))
		}
		if handled, _ := svc.ConsumeRequest(dir, c.triggers()); handled || c.hb.Load()+c.fl.Load() != 1 {
			t.Fatalf("%s: the same request fired twice", kind)
		}
	}
}

func TestWriteRequestRejectsUnknownKind(t *testing.T) {
	dir := t.TempDir()
	for _, k := range []string{"", "restart", "../x", "flush_now\n", "HEARTBEAT_NOW"} {
		if err := svc.WriteRequest(dir, k); err == nil {
			t.Errorf("kind %q accepted", k)
		}
	}
	if ents, _ := os.ReadDir(dir); len(ents) != 0 {
		t.Fatalf("a rejected kind left files behind: %v", ents)
	}
}

// The CLI fallback must fail visibly when the service folder does not exist, not invent a folder with default permissions.
func TestWriteRequestDoesNotCreateTheStatusDir(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "status")
	if err := svc.WriteRequest(dir, svc.RequestFlushNow); err == nil {
		t.Fatal("WriteRequest succeeded into a missing directory")
	}
	if _, err := os.Stat(dir); err == nil {
		t.Fatal("WriteRequest created the status directory")
	}
}

func TestConsumeRequestMissingFileIsQuiet(t *testing.T) {
	var c counters
	handled, err := svc.ConsumeRequest(t.TempDir(), c.triggers())
	if handled || err != nil || c.hb.Load()+c.fl.Load() != 0 {
		t.Fatalf("handled=%v err=%v", handled, err)
	}
}

// request.json is untrusted input from the CLI side: garbage must never fire a trigger, and must be removed so it is not re-read every 5 s.
func TestConsumeRequestIgnoresAndRemovesBadFiles(t *testing.T) {
	cases := map[string][]byte{
		"not json":      []byte("kind=flush_now"),
		"empty":         {},
		"array":         []byte(`["flush_now"]`),
		"unknown kind":  []byte(`{"kind":"restart_service"}`),
		"traversal":     []byte(`{"kind":"..\\..\\flush_now"}`),
		"wrong type":    []byte(`{"kind":129}`),
		"missing kind":  []byte(`{"k":"flush_now"}`),
		"oversize":      append([]byte(`{"kind":"flush_now","pad":"`), append([]byte(strings.Repeat("A", 1<<20)), []byte(`"}`)...)...),
		"binary":        {0xff, 0xfe, 0x00, 0x01},
		"trailing junk": []byte(`{"kind":"flush_now"} {"kind":"heartbeat_now"}`),
	}
	for name, body := range cases {
		dir := t.TempDir()
		p := filepath.Join(dir, svc.RequestFile)
		if err := os.WriteFile(p, body, 0o600); err != nil {
			t.Fatal(err)
		}
		var c counters
		handled, _ := svc.ConsumeRequest(dir, c.triggers())
		if handled || c.hb.Load()+c.fl.Load() != 0 {
			t.Errorf("%s: fired a trigger (handled=%v hb=%d fl=%d)", name, handled, c.hb.Load(), c.fl.Load())
		}
		if _, err := os.Stat(p); err == nil {
			t.Errorf("%s: request.json left in place (would be re-read every poll)", name)
		}
	}
}

func TestConsumeRequestDirectoryNamedRequestJSONDoesNotPanic(t *testing.T) {
	dir := t.TempDir()
	if err := os.Mkdir(filepath.Join(dir, svc.RequestFile), 0o700); err != nil {
		t.Fatal(err)
	}
	var c counters
	if handled, _ := svc.ConsumeRequest(dir, c.triggers()); handled || c.hb.Load()+c.fl.Load() != 0 {
		t.Fatal("a directory fired a trigger")
	}
}

// Two pollers (or a poller and a manual call) racing for one file: exactly one wins.
func TestConsumeRequestIsAtMostOnceUnderRace(t *testing.T) {
	for round := 0; round < 50; round++ {
		dir := t.TempDir()
		if err := svc.WriteRequest(dir, svc.RequestFlushNow); err != nil {
			t.Fatal(err)
		}
		var c counters
		var wg sync.WaitGroup
		for i := 0; i < 8; i++ {
			wg.Add(1)
			go func() { defer wg.Done(); _, _ = svc.ConsumeRequest(dir, c.triggers()) }()
		}
		wg.Wait()
		if c.fl.Load() != 1 {
			t.Fatalf("round %d: flush fired %d times, want exactly 1", round, c.fl.Load())
		}
	}
}

func TestPollRequestsPicksUpFileOnceWithinInterval(t *testing.T) {
	dir := t.TempDir()
	var c counters
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { svc.PollRequests(ctx, dir, c.triggers(), 10*time.Millisecond); close(done) }()
	time.Sleep(30 * time.Millisecond)
	if err := svc.WriteRequest(dir, svc.RequestHeartbeatNow); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for c.hb.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if c.hb.Load() != 1 {
		t.Fatalf("heartbeat trigger fired %d times within 2 s", c.hb.Load())
	}
	time.Sleep(100 * time.Millisecond)
	if c.hb.Load() != 1 {
		t.Fatalf("the same request fired %d times", c.hb.Load())
	}
	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("PollRequests did not stop on cancel")
	}
	// after cancel nothing is consumed
	_ = svc.WriteRequest(dir, svc.RequestFlushNow)
	time.Sleep(60 * time.Millisecond)
	if c.fl.Load() != 0 {
		t.Fatal("PollRequests kept polling after cancel")
	}
}
