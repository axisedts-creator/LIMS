package astm

// AG-T05 restart recovery (03-APP-FLOW §3.1 rule 4, AC-05.7). A "crashed" process is simulated by seeding the queue
// with open sessions through the AG-T04 API and then starting a fresh Receiver on it.

import (
	"strings"
	"testing"

	"lims/apps/bridge-agent/internal/queue"
)

const lkSessTS = "2026-11-11T07:59:00.000Z"

// lkSeed creates an open session with the given frame texts already committed (as if ACKed before the crash).
func lkSeed(t *testing.T, r *lkRig, id string, texts ...string) {
	t.Helper()
	if err := r.db.BeginSession(queue.Session{ID: id, InstrumentID: lkInst, Protocol: "astm", StartedAtAgent: lkSessTS, LastFrameAtAgent: lkSessTS, ExpectedFN: 1}); err != nil {
		t.Fatal(err)
	}
	for i, txt := range texts {
		if err := r.db.AppendChunk(id, i+1, (i+2)%8, []byte(txt), lkSessTS); err != nil {
			t.Fatal(err)
		}
	}
}

func TestRecoverNothingOpen(t *testing.T) {
	r := newLkRig(t)
	n, err := r.rx.Recover()
	if err != nil || n != 0 {
		t.Fatalf("Recover = %d, %v, want 0, nil", n, err)
	}
	r.wantState(StateNeutral)
}

func TestRecoverOpenSessionWithoutLRecordIsIncompleteProcessRestart(t *testing.T) {
	r := newLkRig(t)
	lkSeed(t, r, "crashed-1", lkGoldTexts[:3]...)
	n, err := r.rx.Recover()
	if err != nil || n != 1 {
		t.Fatalf("Recover = %d, %v, want 1, nil", n, err)
	}
	it := r.oneItem()
	if it.Kind != "incomplete" || string(it.Raw) != strings.Join(lkGoldTexts[:3], "") || it.State != "pending" {
		t.Fatalf("item = kind %q state %q raw %q, want pending incomplete with the 3 ACKed frames", it.Kind, it.State, it.Raw)
	}
	if m := lkMeta(t, it); m.IncompleteReason != "process_restart" || m.Frames != 3 {
		t.Errorf("link_meta = %+v, want incomplete_reason process_restart, frames 3", m)
	}
	if it.InstrumentID != lkInst || it.Protocol != "astm" {
		t.Errorf("item instrument/protocol = %q/%q", it.InstrumentID, it.Protocol)
	}
	if n := len(r.openSessions()); n != 0 {
		t.Errorf("%d session(s) still open after Recover", n)
	}
	r.wantState(StateNeutral)
	r.mustReply("ENQ after recovery", []byte{ENQ}, []byte{ACK})
}

func TestRecoverLastChunkIsLRecordFinalisesNormally(t *testing.T) { // all ACKs were seen; only EOT was lost
	r := newLkRig(t)
	lkSeed(t, r, "crashed-1", lkGoldTexts...)
	if n, err := r.rx.Recover(); err != nil || n != 1 {
		t.Fatalf("Recover = %d, %v", n, err)
	}
	it := r.oneItem()
	if it.Kind != "data" || it.RawSHA256 != lkGoldSHA {
		t.Fatalf("item = kind %q sha %s, want data with the golden sha", it.Kind, it.RawSHA256)
	}
	if m := lkMeta(t, it); m.IncompleteReason != "" || m.Frames != 5 {
		t.Errorf("link_meta = %+v, want no incomplete_reason, frames 5", m)
	}
}

func TestRecoverLRecordMustBeTheLastChunk(t *testing.T) {
	r := newLkRig(t)
	lkSeed(t, r, "crashed-1", lkGoldTexts[0], lkGoldTexts[4], "C|1|x\r") // an L record in the middle is not "end of message"
	if _, err := r.rx.Recover(); err != nil {
		t.Fatal(err)
	}
	if it := r.oneItem(); it.Kind != "incomplete" {
		t.Fatalf("kind = %q, want incomplete", it.Kind)
	}
}

// An ETB continuation chunk (first 240 bytes of a longer record, no trailing CR) that happens to start with "L|" is not
// an L record ending with ETX, so the message is incomplete (03-APP-FLOW §3.1 rule 4).
func TestRecoverLRecordLookalikeEtbChunkIsIncompleteProcessRestart(t *testing.T) {
	r := newLkRig(t)
	lkSeed(t, r, "crashed-1", lkGoldTexts[0], "L|"+strings.Repeat("x", 238))
	if n, err := r.rx.Recover(); err != nil || n != 1 {
		t.Fatalf("Recover = %d, %v, want 1, nil", n, err)
	}
	it := r.oneItem()
	if it.Kind != "incomplete" {
		t.Fatalf("kind = %q, want incomplete", it.Kind)
	}
	if m := lkMeta(t, it); m.IncompleteReason != "process_restart" {
		t.Errorf("link_meta = %+v, want incomplete_reason process_restart", m)
	}
}

func TestRecoverFinalisesEveryOpenSession(t *testing.T) {
	r := newLkRig(t)
	lkSeed(t, r, "crashed-1", lkGoldTexts[:2]...)
	lkSeed(t, r, "crashed-2", lkGoldTexts...)
	n, err := r.rx.Recover()
	if err != nil || n != 2 {
		t.Fatalf("Recover = %d, %v, want 2", n, err)
	}
	its := r.items()
	if len(its) != 2 {
		t.Fatalf("items = %d, want 2", len(its))
	}
	kinds := map[string]int{}
	for _, it := range its {
		kinds[it.Kind]++
	}
	if kinds["incomplete"] != 1 || kinds["data"] != 1 {
		t.Fatalf("kinds = %v, want one incomplete and one data", kinds)
	}
	if n := len(r.openSessions()); n != 0 {
		t.Fatalf("%d session(s) still open", n)
	}
}

func TestRecoverIsIdempotent(t *testing.T) {
	r := newLkRig(t)
	lkSeed(t, r, "crashed-1", lkGoldTexts[:2]...)
	if _, err := r.rx.Recover(); err != nil {
		t.Fatal(err)
	}
	if n, err := r.rx.Recover(); err != nil || n != 0 {
		t.Fatalf("second Recover = %d, %v, want 0, nil", n, err)
	}
	if n := len(r.items()); n != 1 {
		t.Fatalf("items = %d, want 1 (no duplicate item from a second recovery)", n)
	}
}

func TestRecoverSessionWithNoChunksDoesNotPanicOrStayOpen(t *testing.T) {
	r := newLkRig(t)
	lkSeed(t, r, "crashed-1")
	if _, err := r.rx.Recover(); err != nil {
		t.Fatal(err)
	}
	if n := len(r.openSessions()); n != 0 {
		t.Fatalf("%d session(s) still open", n)
	}
}

func TestRecoverTamperedChunkIsReportedAndKeepsTheSession(t *testing.T) { // untrusted/corrupt disk content: no silent loss
	r := newLkRig(t)
	lkSeed(t, r, "crashed-1", lkGoldTexts[:2]...)
	r.rawExec(`UPDATE session_chunks SET ct = zeroblob(length(ct)) WHERE seq = 1`)
	if _, err := r.rx.Recover(); err == nil {
		t.Fatal("Recover returned nil although a chunk failed authentication")
	}
	if n := len(r.openSessions()); n != 1 {
		t.Fatalf("open sessions = %d, want 1: the unreadable session must stay for diagnosis, not be deleted", n)
	}
	if n := len(r.items()); n != 0 {
		t.Fatalf("an item was created from a tampered session")
	}
}
