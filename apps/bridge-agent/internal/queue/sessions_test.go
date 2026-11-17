package queue

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"testing"
	"time"
)

// 03-APP-FLOW 3.1 persist chunk + finalise; AC-05.2.

func TestSessionAppendUpdatesCounters(t *testing.T) {
	d, _, _ := openNew(t)
	if err := d.BeginSession(Session{ID: "S1", InstrumentID: "inst-1", Protocol: "astm",
		StartedAtAgent: "2026-11-11T08:00:00.000Z", LastFrameAtAgent: "2026-11-11T08:00:00.000Z"}); err != nil {
		t.Fatal(err)
	}
	if err := d.AppendChunk("S1", 1, 2, []byte("frame-1"), "2026-11-11T08:00:05.000Z"); err != nil {
		t.Fatal(err)
	}
	if err := d.AppendChunk("S1", 2, 3, []byte("frame-2"), "2026-11-11T08:00:09.000Z"); err != nil {
		t.Fatal(err)
	}
	s, err := d.GetSession("S1")
	if err != nil {
		t.Fatal(err)
	}
	if s.Frames != 2 || s.ExpectedFN != 3 || s.InstrumentID != "inst-1" || s.Protocol != "astm" {
		t.Errorf("session = %+v", s)
	}
	last, perr := time.Parse(time.RFC3339Nano, s.LastFrameAtAgent)
	if perr != nil || !last.Equal(time.Date(2026, 11, 11, 8, 0, 9, 0, time.UTC)) {
		t.Errorf("last_frame_at_agent = %q (%v)", s.LastFrameAtAgent, perr)
	}
	ch, err := d.Chunks("S1")
	if err != nil || len(ch) != 2 || string(ch[0]) != "frame-1" || string(ch[1]) != "frame-2" {
		t.Errorf("chunks = %q err %v", ch, err)
	}
}

func TestChunksReturnedInSeqOrder(t *testing.T) {
	d, _, _ := openNew(t)
	if err := d.BeginSession(Session{ID: "S1", InstrumentID: "i", Protocol: "astm", StartedAtAgent: "2026-11-11T08:00:00.000Z", LastFrameAtAgent: "2026-11-11T08:00:00.000Z"}); err != nil {
		t.Fatal(err)
	}
	for _, n := range []int{3, 1, 2} {
		if err := d.AppendChunk("S1", n, 0, []byte{byte('0' + n)}, "2026-11-11T08:00:01.000Z"); err != nil {
			t.Fatal(err)
		}
	}
	ch, _ := d.Chunks("S1")
	if len(ch) != 3 || string(ch[0]) != "1" || string(ch[1]) != "2" || string(ch[2]) != "3" {
		t.Errorf("order = %q", ch)
	}
}

func TestAppendRejectsDuplicateSeqAndUnknownSession(t *testing.T) {
	d, _, _ := openNew(t)
	seedSession(t, d, "S1", 1)
	if err := d.AppendChunk("S1", 1, 2, []byte("again"), "2026-11-11T08:00:02.000Z"); err == nil {
		t.Error("duplicate (session, seq) must fail")
	}
	s, _ := d.GetSession("S1")
	if s.Frames != 1 {
		t.Errorf("failed append must not bump frames, got %d", s.Frames)
	}
	if err := d.AppendChunk("nope", 1, 2, []byte("x"), "2026-11-11T08:00:02.000Z"); err == nil {
		t.Error("append to a missing session must fail (foreign_keys on)")
	}
}

func TestBeginSessionDuplicateFails(t *testing.T) {
	d, _, _ := openNew(t)
	seedSession(t, d, "S1", 0)
	if err := d.BeginSession(Session{ID: "S1", InstrumentID: "i", Protocol: "astm", StartedAtAgent: "x", LastFrameAtAgent: "x"}); err == nil {
		t.Error("duplicate session id must fail")
	}
	if err := d.BeginSession(Session{ID: "S9", InstrumentID: "i", Protocol: "astm"}); err == nil {
		t.Error("session without started_at_agent/last_frame_at_agent must fail (NOT NULL)")
	}
}

func TestGetSessionMissing(t *testing.T) {
	d, _, _ := openNew(t)
	if _, err := d.GetSession("nope"); !errors.Is(err, ErrNotFound) {
		t.Errorf("err = %v, want ErrNotFound", err)
	}
}

func TestOpenSessionsAndDelete(t *testing.T) {
	d, path, _ := openNew(t)
	seedSession(t, d, "S1", 2)
	seedSession(t, d, "S2", 1)
	ss, err := d.OpenSessions()
	if err != nil || len(ss) != 2 {
		t.Fatalf("OpenSessions = %v %v", ss, err)
	}
	if err := d.DeleteSession("S1"); err != nil {
		t.Fatal(err)
	}
	ss, _ = d.OpenSessions()
	if len(ss) != 1 || ss[0].ID != "S2" {
		t.Errorf("after delete: %+v", ss)
	}
	var n int
	if err := rawDB(t, path).QueryRow("SELECT count(*) FROM session_chunks WHERE session_id='S1'").Scan(&n); err != nil || n != 0 {
		t.Errorf("chunks of deleted session must cascade away, left %d (%v)", n, err)
	}
}

func TestFinalizeSessionBuildsItemAndClearsSession(t *testing.T) {
	d, path, _ := openNew(t)
	seedSession(t, d, "S1", 3)
	chunks, _ := d.Chunks("S1")
	var want []byte
	for _, c := range chunks {
		want = append(want, c...)
	}
	sum := sha256.Sum256(want)

	it, err := d.FinalizeSession("S1", ItemInput{ID: "it-1", InstrumentID: "inst-1", Kind: "data", Protocol: "astm",
		Meta: []byte(`{"link_meta":{"frames":3}}`), CapturedAtAgent: "2026-11-11T08:00:09.000Z", ClockOffsetMs: 40})
	if err != nil {
		t.Fatal(err)
	}
	if it.ID != "it-1" || it.State != "pending" || it.SizeBytes != int64(len(want)) || it.RawSHA256 != hex.EncodeToString(sum[:]) {
		t.Errorf("item = %+v", it)
	}
	got, err := d.GetItem("it-1")
	if err != nil || string(got.Raw) != string(want) || string(got.Meta) != `{"link_meta":{"frames":3}}` {
		t.Fatalf("stored item = %v %q", err, got.Raw)
	}
	if _, err := d.GetSession("S1"); !errors.Is(err, ErrNotFound) {
		t.Errorf("session must be gone after finalise, got %v", err)
	}
	var n int
	if err := rawDB(t, path).QueryRow("SELECT count(*) FROM session_chunks").Scan(&n); err != nil || n != 0 {
		t.Errorf("chunks of a finalised session are deleted immediately (TRD 5.6), left %d", n)
	}
}

func TestFinalizeIsAtomicOnItemInsertFailure(t *testing.T) {
	d, _, _ := openNew(t)
	seedSession(t, d, "S1", 2)
	if err := d.InsertItem(in("dup", "data", []byte("already here"))); err != nil {
		t.Fatal(err)
	}
	if _, err := d.FinalizeSession("S1", in("dup", "data", nil)); err == nil {
		t.Fatal("finalise with an existing item id must fail")
	}
	ch, err := d.Chunks("S1")
	if err != nil || len(ch) != 2 {
		t.Errorf("rollback must keep all chunks (nothing lost before the item exists): %d %v", len(ch), err)
	}
	if _, err := d.GetSession("S1"); err != nil {
		t.Errorf("session must survive a failed finalise: %v", err)
	}
}

func TestFinalizeUnknownSession(t *testing.T) {
	d, _, _ := openNew(t)
	if _, err := d.FinalizeSession("nope", in("it-1", "data", nil)); !errors.Is(err, ErrNotFound) {
		t.Errorf("err = %v, want ErrNotFound", err)
	}
}

func TestFinalizeIncompleteKind(t *testing.T) {
	d, _, _ := openNew(t)
	seedSession(t, d, "S1", 1)
	it, err := d.FinalizeSession("S1", in("it-1", "incomplete", nil))
	if err != nil || it.Kind != "incomplete" {
		t.Fatalf("%v %+v", err, it)
	}
}

// The same message re-sent by the instrument produces the same raw_sha256 (server dedupes by (instrument_id, sha256(raw)), AC-05.7).
func TestResentMessageHasSameSHA256(t *testing.T) {
	d, _, _ := openNew(t)
	seedSession(t, d, "S1", 3)
	seedSession(t, d, "S2", 3)
	a, err := d.FinalizeSession("S1", in("it-1", "data", nil))
	if err != nil {
		t.Fatal(err)
	}
	b, err := d.FinalizeSession("S2", in("it-2", "data", nil))
	if err != nil {
		t.Fatal(err)
	}
	if a.RawSHA256 != b.RawSHA256 || a.ID == b.ID {
		t.Errorf("sha %s vs %s, ids %s/%s", a.RawSHA256, b.RawSHA256, a.ID, b.ID)
	}
}
