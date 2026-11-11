package update_test

// AG-T16 review items 1 and 2 (.orchestra/notes/AG-T16-review.md).
//  1. A version the launcher rolled back (AC-15.3 crash loop) stays blocked: Stage/Download refuse it and leave update-state.json at
//     rolled_back, and a NEW launcher on the same root refuses a re-staged pending.json for it (the block is on disk, not in memory).
//  2. 03-APP-FLOW 3.6: download retries are capped at 3 per 24 h per version ("retry cap"). Contract: package var update.Now = time.Now
//     is the clock Download uses for the cap (tests replace it).
import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"lims/apps/bridge-agent/internal/update"
)

// crashLoopRolledBack drives 1.0.0 -> 1.1.0 -> 3 crashes -> rolled back to 1.0.0 and waits for the launcher to settle.
func crashLoopRolledBack(t *testing.T) *lrig {
	t.Helper()
	l := newLRig(t)
	l.installed("1.0.0")
	l.stage("1.1.0")
	l.on("1.0.0", step{exit: update.ExitApply})
	l.on("1.1.0", step{exit: 1}, step{exit: 1}, step{exit: 1})
	l.run()
	l.wantRolledBack("1.1.0", "1.0.0")
	l.waitStarts(5)
	l.settle()
	return l
}

func wantRolledBackStatus(t *testing.T, l *lrig, version string) {
	t.Helper()
	st, err := update.ReadStatus(l.root)
	if err != nil {
		t.Fatalf("ReadStatus: %v", err)
	}
	if st.State != update.StateRolledBack || st.TargetVersion != version {
		t.Fatalf("update status = %q target %q, want %q target %q (the old agent must not clobber the rollback report)",
			st.State, st.TargetVersion, update.StateRolledBack, version)
	}
}

func TestStageRefusesRolledBackVersionAndKeepsStatus(t *testing.T) {
	l := crashLoopRolledBack(t)
	z, rel := l.pkg("1.1.0") // the signed config still targets the failed version, so the agent offers it again
	err := update.Stage(l.root, l.part("1.1.0", z), rel, l.keys, l.auth)
	var ue *update.Error
	if !errors.As(err, &ue) || ue.State != update.StateRolledBack {
		t.Fatalf("Stage of a rolled-back version = %T %v, want *update.Error State %q", err, err, update.StateRolledBack)
	}
	if l.exists("pending.json") {
		t.Fatal("pending.json written for a rolled-back version")
	}
	wantRolledBackStatus(t, l, "1.1.0")
}

func TestDownloadRefusesRolledBackVersionWithoutRequestAndKeepsStatus(t *testing.T) {
	l := crashLoopRolledBack(t)
	_, rel := l.pkg("1.1.0")
	var hits atomic.Int32
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, q *http.Request) { hits.Add(1) }))
	defer srv.Close()
	_, err := update.Download(context.Background(), srv.Client(), srv.URL+"/p", testToken, l.root, rel)
	var ue *update.Error
	if !errors.As(err, &ue) || ue.State != update.StateRolledBack {
		t.Fatalf("Download of a rolled-back version = %T %v, want *update.Error State %q", err, err, update.StateRolledBack)
	}
	if hits.Load() != 0 {
		t.Fatal("re-downloaded a rolled-back package (up to 256 MiB per config check)")
	}
	wantRolledBackStatus(t, l, "1.1.0")
}

// A launcher or PC restart empties any in-memory state: the block must come from disk.
func TestNewLauncherRefusesRestagedRolledBackVersion(t *testing.T) {
	l := crashLoopRolledBack(t)
	l.cancel()
	err := <-l.done
	l.done <- err // keep it for the rig's cleanup
	before := len(l.startsNow())

	// Re-stage 1.1.0 behind the agent's back (Stage itself now refuses): zip, unpacked exe and pending.json all valid and signed.
	z, rel := l.pkg("1.1.0")
	l.write("versions/1.1.0.zip", z)
	l.write("versions/1.1.0/agent.exe", agentBytes("1.1.0"))
	l.write("pending.json", pendingJSON(rel))
	l.on("1.0.0", step{exit: update.ExitApply})
	l.on("1.1.0", step{healthy: true, hang: true})

	lau, err := update.NewLauncher(update.LauncherOptions{Root: l.root, Keys: l.keys, Authenticode: l.auth, Clock: l.clk, Start: l.start,
		Policy: func() update.Policy { return update.Policy{} }})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- lau.Run(ctx) }()
	defer func() { cancel(); <-done }()
	eventually(t, "second launcher to start an agent", func() bool { return len(l.startsNow()) >= before+2 })
	l.settle()
	for _, v := range l.startsNow()[before:] {
		if v != "1.0.0" {
			t.Fatalf("new launcher started %s although it was rolled back (starts %v)", v, l.startsNow())
		}
	}
	if l.currentVersion() != "1.0.0" {
		t.Fatalf("new launcher switched to %s", l.currentVersion())
	}
	if l.exists("pending.json") {
		t.Fatal("refused pending.json must be removed")
	}
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Download retry cap: max 3 per 24 h (per version)
// ---------------------------------------------------------------------------------------------------------------------------------

func TestDownloadRetryCapThreePerDay(t *testing.T) {
	r := newRig(t)
	_, rel := r.pkg("1.1.0")
	_, other := r.pkg("1.2.0")
	now := time.Date(2026, 11, 11, 10, 0, 0, 0, time.UTC)
	old := update.Now
	update.Now = func() time.Time { return now }
	t.Cleanup(func() { update.Now = old })

	var hits atomic.Int32
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, q *http.Request) {
		hits.Add(1)
		http.Error(w, "common.internal_error", http.StatusInternalServerError)
	}))
	defer srv.Close()
	try := func(rel update.Release) error {
		_, err := update.Download(context.Background(), srv.Client(), srv.URL+"/p", testToken, r.root, rel)
		return err
	}
	wantFailed := func(err error, reason string) {
		t.Helper()
		var ue *update.Error
		if !errors.As(err, &ue) || ue.State != update.StateFailed {
			t.Fatalf("want *update.Error State %q, got %T: %v", update.StateFailed, err, err)
		}
		if reason != "" && !strings.Contains(ue.Reason, reason) {
			t.Fatalf("Reason = %q, want it to contain %q", ue.Reason, reason)
		}
		if reason == "" && strings.Contains(ue.Reason, "retry cap") {
			t.Fatalf("attempt refused by the retry cap too early: %q", ue.Reason)
		}
	}

	for i := 1; i <= 3; i++ {
		wantFailed(try(rel), "")
		now = now.Add(time.Hour)
	}
	if hits.Load() != 3 {
		t.Fatalf("server hits = %d after 3 attempts, want 3", hits.Load())
	}
	wantFailed(try(rel), "retry cap") // 4th within 24 h
	if hits.Load() != 3 {
		t.Fatalf("4th attempt within 24 h reached the server (hits %d)", hits.Load())
	}
	wantFailed(try(other), "") // the cap is per version
	if hits.Load() != 4 {
		t.Fatalf("other version blocked by 1.1.0's cap (hits %d)", hits.Load())
	}
	now = now.Add(24*time.Hour + time.Minute) // first attempts are now older than 24 h
	wantFailed(try(rel), "")
	if hits.Load() != 5 {
		t.Fatalf("attempt after 24 h was refused (hits %d)", hits.Load())
	}
}
