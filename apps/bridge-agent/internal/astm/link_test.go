package astm

// AG-T05 receiver tests (fake clock, real AG-T04 queue). Contract: see link_helpers_test.go.
// AC-05.1 .. AC-05.6 here; AC-05.7 + restart recovery in link_recover_test.go and link_crash_test.go.

import (
	"bytes"
	"fmt"
	"strings"
	"testing"
	"time"
)

// ---------- AC-05.1 ENQ ----------

func TestAC051EnqWritableQueueAcksAndOpensSession(t *testing.T) {
	r := newLkRig(t)
	r.wantState(StateNeutral)
	r.mustReply("ENQ", []byte{ENQ}, []byte{ACK})
	r.wantState(StateReceiving)
	ss := r.openSessions()
	if len(ss) != 1 || ss[0].InstrumentID != lkInst || ss[0].Protocol != "astm" || ss[0].ExpectedFN != 1 || ss[0].Frames != 0 {
		t.Fatalf("session after ENQ = %+v, want 1 open astm session of %s, expected_fn 1, 0 frames", ss, lkInst)
	}
	if ss[0].ID != r.ids[0] {
		t.Errorf("session id %q was not taken from cfg.NewID (%q)", ss[0].ID, r.ids[0])
	}
}

func TestAC051EnqDiskLowNaks(t *testing.T) { // 07-SECURITY: disk fill -> disk guard NAK
	r := newLkRig(t)
	r.free.Store(1 << 20) // 1 MiB free, guard is 500 MB
	r.mustReply("ENQ", []byte{ENQ}, []byte{NAK})
	r.wantState(StateNeutral)
	if n := len(r.openSessions()); n != 0 {
		t.Fatalf("%d session(s) opened although the queue is not writable", n)
	}
	r.free.Store(100 << 30) // disk recovered: the instrument's next ENQ is accepted
	r.mustReply("ENQ after recovery", []byte{ENQ}, []byte{ACK})
	r.wantState(StateReceiving)
}

func TestAC051EnqDatabaseErrorNaks(t *testing.T) {
	r := newLkRig(t)
	r.rawExec(`CREATE TRIGGER lk_no_sessions BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END`)
	r.mustReply("ENQ", []byte{ENQ}, []byte{NAK})
	r.wantState(StateNeutral)
	r.rawExec(`DROP TRIGGER lk_no_sessions`)
	r.mustReply("ENQ after recovery", []byte{ENQ}, []byte{ACK})
}

func TestAC051EnqOnClosedQueueNaksNoPanic(t *testing.T) {
	r := newLkRig(t)
	_ = r.db.Close()
	r.mustReply("ENQ", []byte{ENQ}, []byte{NAK})
	r.wantState(StateNeutral)
}

// ---------- AC-05.2 persist before ACK ----------

func TestAC052FrameCommittedBeforeAck(t *testing.T) {
	r := newLkRig(t)
	r.mustReply("ENQ", []byte{ENQ}, []byte{ACK})
	for i := 1; i <= 5; i++ {
		r.mustReply(fmt.Sprintf("frame %d", i), lkGoldFrame(t, i), []byte{ACK})
		// the moment the ACK is returned, a SEPARATE connection (what survives a crash) already sees the frame
		if n := r.rawCount("session_chunks"); n != i {
			t.Fatalf("after ACK of frame %d only %d chunks are committed", i, n)
		}
		ss := r.openSessions()
		if len(ss) != 1 || ss[0].Frames != i || ss[0].ExpectedFN != (i+1)%8 {
			t.Fatalf("after frame %d session = %+v, want frames=%d expected_fn=%d", i, ss, i, (i+1)%8)
		}
	}
	ch, err := r.db.Chunks(r.ids[0])
	if err != nil || len(ch) != 5 {
		t.Fatalf("chunks: %v %d", err, len(ch))
	}
	for i, c := range ch {
		if string(c) != lkGoldTexts[i] {
			t.Errorf("chunk %d = %q, want the frame TEXT only (no STX/FN/terminator/checksum/CRLF) %q", i+1, c, lkGoldTexts[i])
		}
	}
}

func TestAC052PersistFailureNaksAndFrameIsNotCounted(t *testing.T) { // never ACK what is not on disk
	r := newLkRig(t)
	r.mustReply("ENQ", []byte{ENQ}, []byte{ACK})
	r.mustReply("frame 1", lkGoldFrame(t, 1), []byte{ACK})
	r.rawExec(`CREATE TRIGGER lk_no_chunks BEFORE INSERT ON session_chunks BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END`)
	r.mustReply("frame 2 while disk full", lkGoldFrame(t, 2), []byte{NAK})
	if n := r.rawCount("session_chunks"); n != 1 {
		t.Fatalf("chunks = %d after failed persist, want 1", n)
	}
	if s := r.openSessions()[0]; s.Frames != 1 || s.ExpectedFN != 2 {
		t.Fatalf("failed persist advanced the session: %+v", s)
	}
	r.wantState(StateReceiving)
	r.rawExec(`DROP TRIGGER lk_no_chunks`)
	// the instrument re-sends frame 2: it was never accepted, so it is a NEW frame (appended once), not a retransmit
	r.mustReply("frame 2 resend", lkGoldFrame(t, 2), []byte{ACK})
	if n := r.rawCount("session_chunks"); n != 2 {
		t.Fatalf("chunks = %d, want 2", n)
	}
	if st := r.rx.Stats(); st.NaksSent != 1 || st.Retransmits != 0 {
		t.Errorf("stats = %+v, want naks_sent 1, retransmits 0", st)
	}
}

// ---------- AC-05.3 defective frames ----------

func lkBadFrames(t *testing.T) map[string][]byte {
	good := lkFrame(t, 2, lkGoldTexts[1], ETX) // the frame the receiver expects next
	flip := bytes.Clone(good)
	flip[len(flip)-3] ^= 0x01 // last checksum char
	noCR := bytes.Clone(good)
	noCR[len(noCR)-2] = 'X' // CR replaced; LF still ends the frame
	lfOnly := append(bytes.Clone(good[:len(good)-2]), '\n')
	badTerm := bytes.Clone(good)
	badTerm[len(badTerm)-5] = 'X'
	nonDigitFN := bytes.Clone(good)
	nonDigitFN[1] = 'A'
	long := make([]byte, 0, 248) // 241 text chars -> 248 bytes, valid checksum, one over the 247 limit
	text := bytes.Repeat([]byte{'A'}, 241)
	long = append(long, STX, '2')
	long = append(long, text...)
	long = append(long, ETX)
	long = append(long, Checksum(2, text, ETX)...)
	long = append(long, '\r', '\n')
	m := map[string][]byte{}
	m["wrong checksum"] = flip
	m["unexpected FN"] = lkFrame(t, 4, lkGoldTexts[1], ETX)
	m["FN zero, expected 2"] = lkFrame(t, 0, lkGoldTexts[1], ETX)
	m["missing CR"] = noCR
	m["missing CR LF (LF only)"] = lfOnly
	m["longer than 247"] = long
	m["bad terminator"] = badTerm
	m["FN not a digit"] = nonDigitFN
	m["too short to be a frame"] = []byte{STX, '2', '\r', '\n'}
	return m
}

func TestAC053DefectiveFramesNakAndNeverAppend(t *testing.T) {
	for name, bad := range lkBadFrames(t) {
		t.Run(name, func(t *testing.T) {
			r := newLkRig(t)
			r.openMsg(1)
			r.mustReply("defective frame", bad, []byte{NAK}) // exactly one NAK per defective frame
			if n := r.rawCount("session_chunks"); n != 1 {
				t.Fatalf("a defective frame was appended: %d chunks", n)
			}
			if s := r.openSessions()[0]; s.Frames != 1 || s.ExpectedFN != 2 {
				t.Fatalf("session advanced by a defective frame: %+v", s)
			}
			r.wantState(StateReceiving)
			if st := r.rx.Stats(); st.NaksSent != 1 {
				t.Errorf("naks_sent = %d, want 1", st.NaksSent)
			}
			r.mustReply("good frame 2 afterwards", lkGoldFrame(t, 2), []byte{ACK}) // link is still usable
			if n := r.rawCount("session_chunks"); n != 2 {
				t.Fatalf("chunks = %d, want 2", n)
			}
		})
	}
}

func TestAC053FrameLengthBoundary(t *testing.T) { // 247 bytes accepted, 248 refused
	r := newLkRig(t)
	r.mustReply("ENQ", []byte{ENQ}, []byte{ACK})
	text := strings.Repeat("A", 240) // 240 + 7 = 247
	r.mustReply("247-byte frame", lkFrame(t, 1, text, ETB), []byte{ACK})
}

func TestAC053UnterminatedFloodIsBoundedAndNaksOnce(t *testing.T) {
	for _, split := range []bool{false, true} {
		t.Run(fmt.Sprintf("split=%v", split), func(t *testing.T) {
			r := newLkRig(t)
			r.mustReply("ENQ", []byte{ENQ}, []byte{ACK})
			flood := append([]byte{STX, '1'}, bytes.Repeat([]byte{'A'}, 5000)...) // no LF for a long time
			var got []byte
			if split {
				got = append(got, r.feed(flood)...)
				got = append(got, r.feed([]byte{'\n'})...)
			} else {
				got = r.feed(append(flood, '\n'))
			}
			if !bytes.Equal(got, []byte{NAK}) {
				t.Fatalf("replies to one runaway frame = %q, want a single NAK", got)
			}
			if n := r.rawCount("session_chunks"); n != 0 {
				t.Fatalf("runaway frame appended: %d chunks", n)
			}
			r.mustReply("good frame 1 afterwards", lkGoldFrame(t, 1), []byte{ACK})
		})
	}
}

// ---------- AC-05.4 retransmission ----------

func TestAC054RetransmittedFrameAckedNotAppendedTwice(t *testing.T) {
	r := newLkRig(t)
	r.openMsg(2)
	r.mustReply("retransmit of frame 2", lkGoldFrame(t, 2), []byte{ACK})
	r.mustReply("retransmit of frame 2 again", lkGoldFrame(t, 2), []byte{ACK})
	if n := r.rawCount("session_chunks"); n != 2 {
		t.Fatalf("chunks = %d, want 2 (retransmits must not append)", n)
	}
	if s := r.openSessions()[0]; s.Frames != 2 || s.ExpectedFN != 3 {
		t.Fatalf("session = %+v, want frames 2 expected_fn 3", s)
	}
	r.mustReply("frame 3", lkGoldFrame(t, 3), []byte{ACK})
	if st := r.rx.Stats(); st.Retransmits != 2 || st.Frames != 3 {
		t.Errorf("stats = %+v, want retransmits 2, frames 3", st)
	}
}

func TestAC054FrameOlderThanPreviousIsNotARetransmit(t *testing.T) {
	r := newLkRig(t)
	r.openMsg(3)
	r.mustReply("frame 1 again (two back)", lkGoldFrame(t, 1), []byte{NAK})
	if n := r.rawCount("session_chunks"); n != 3 {
		t.Fatalf("chunks = %d, want 3", n)
	}
}

func TestAC054NoPreviousFrameMeansNoRetransmit(t *testing.T) {
	r := newLkRig(t)
	r.mustReply("ENQ", []byte{ENQ}, []byte{ACK})
	r.mustReply("frame with FN 0 before any frame", lkFrame(t, 0, "P|1\r", ETX), []byte{NAK})
}

func TestFrameNumbersWrapModulo8(t *testing.T) {
	r := newLkRig(t)
	r.mustReply("ENQ", []byte{ENQ}, []byte{ACK})
	var want bytes.Buffer
	fn := 1
	for i := 1; i <= 10; i++ { // FN 1..7,0,1,2
		txt := fmt.Sprintf("C|%d|x\r", i)
		want.WriteString(txt)
		r.mustReply(fmt.Sprintf("frame #%d (FN %d)", i, fn), lkFrame(t, fn, txt, ETX), []byte{ACK})
		fn = NextFN(fn)
	}
	if s := r.openSessions()[0]; s.ExpectedFN != 3 || s.Frames != 10 {
		t.Fatalf("session = %+v, want expected_fn 3 frames 10", s)
	}
	r.mustReply("EOT", []byte{EOT}, nil)
	if it := r.oneItem(); string(it.Raw) != want.String() {
		t.Fatalf("raw = %q, want %q", it.Raw, want.String())
	}
}

// ---------- AC-05.5 EOT -> one item ----------

func TestAC055EotFinalisesOneItemWithGoldenSHA(t *testing.T) {
	r := newLkRig(t, func(c *ReceiverConfig) { c.ClockOffsetMs = func() int64 { return -120 } })
	r.openMsg(5)
	r.clk.Advance(2 * time.Second)
	end := r.clk.Now()
	r.mustReply("EOT", []byte{EOT}, nil) // EOT is not answered
	r.wantState(StateNeutral)
	it := r.oneItem()
	if it.RawSHA256 != lkGoldSHA {
		t.Errorf("raw_sha256 = %s, want golden %s (TRD 5.2.6)", it.RawSHA256, lkGoldSHA)
	}
	if want := strings.Join(lkGoldTexts, ""); string(it.Raw) != want {
		t.Errorf("raw = %q, want concatenated frame texts %q", it.Raw, want)
	}
	if it.Kind != "data" || it.Protocol != "astm" || it.InstrumentID != lkInst || it.State != "pending" {
		t.Errorf("item = kind %q protocol %q instrument %q state %q", it.Kind, it.Protocol, it.InstrumentID, it.State)
	}
	if it.ClockOffsetMs != -120 {
		t.Errorf("clock_offset_ms = %d, want -120", it.ClockOffsetMs)
	}
	if at, err := time.Parse(lkTS, it.CapturedAtAgent); err != nil || at.Before(r.start) || at.After(end) {
		t.Errorf("captured_at_agent %q: want %s timestamp within [%s, %s] (err %v)", it.CapturedAtAgent, lkTS, r.start.Format(lkTS), end.Format(lkTS), err)
	}
	if m := lkMeta(t, it); m.Frames != 5 || m.Retransmits != 0 || m.NaksSent != 0 || m.IncompleteReason != "" {
		t.Errorf("link_meta = %+v, want frames 5 and nothing else", m)
	}
	if n := len(r.openSessions()); n != 0 {
		t.Errorf("%d session(s) left open after EOT", n)
	}
	if n := r.rawCount("session_chunks"); n != 0 {
		t.Errorf("%d chunk(s) left after finalise", n)
	}
}

func TestAC055RetransmitsAndNaksDoNotChangeRawButAreCounted(t *testing.T) {
	r := newLkRig(t)
	r.mustReply("ENQ", []byte{ENQ}, []byte{ACK})
	r.mustReply("frame 1", lkGoldFrame(t, 1), []byte{ACK})
	bad := lkGoldFrame(t, 2)
	bad[len(bad)-3] ^= 1
	r.mustReply("bad frame 2", bad, []byte{NAK})
	r.mustReply("frame 2", lkGoldFrame(t, 2), []byte{ACK})
	r.mustReply("frame 2 retransmitted", lkGoldFrame(t, 2), []byte{ACK})
	for i := 3; i <= 5; i++ {
		r.mustReply("frame", lkGoldFrame(t, i), []byte{ACK})
	}
	r.mustReply("EOT", []byte{EOT}, nil)
	it := r.oneItem()
	if it.RawSHA256 != lkGoldSHA {
		t.Fatalf("raw_sha256 = %s, want golden (retransmission counted once, NAKed frame not at all)", it.RawSHA256)
	}
	if m := lkMeta(t, it); m.Frames != 5 || m.Retransmits != 1 || m.NaksSent != 1 {
		t.Errorf("link_meta = %+v, want frames 5 retransmits 1 naks_sent 1", m)
	}
}

func TestAC055HostQueryKind(t *testing.T) {
	r := newLkRig(t)
	r.mustReply("ENQ", []byte{ENQ}, []byte{ACK})
	for i, txt := range []string{lkGoldTexts[0], "Q|1|^SAMPLE-0001||||||||O\r", "L|1|N\r"} {
		r.mustReply("frame", lkFrame(t, i+1, txt, ETX), []byte{ACK})
	}
	r.mustReply("EOT", []byte{EOT}, nil)
	if it := r.oneItem(); it.Kind != "host_query" {
		t.Fatalf("kind = %q, want host_query (TRD 5.3: Q and no R)", it.Kind)
	}
}

func TestAC055ClassOtherIsStoredAsData(t *testing.T) { // TRD 5.3: "other" is still uploaded as data
	r := newLkRig(t)
	r.mustReply("ENQ", []byte{ENQ}, []byte{ACK})
	r.mustReply("frame 1", lkGoldFrame(t, 1), []byte{ACK})
	r.mustReply("frame 2", lkFrame(t, 2, "L|1|N\r", ETX), []byte{ACK})
	r.mustReply("EOT", []byte{EOT}, nil)
	if it := r.oneItem(); it.Kind != "data" {
		t.Fatalf("kind = %q, want data", it.Kind)
	}
}

func TestAC055TwoMessagesAreTwoItemsWithTheirOwnSessions(t *testing.T) {
	r := newLkRig(t)
	for i := 0; i < 2; i++ {
		r.openMsg(5)
		r.mustReply("EOT", []byte{EOT}, nil)
	}
	its := r.items()
	if len(its) != 2 || its[0].ID == its[1].ID || its[0].RawSHA256 != lkGoldSHA || its[1].RawSHA256 != lkGoldSHA {
		t.Fatalf("items = %+v, want two distinct items both with the golden sha (frame numbering restarts at 1 per session)", its)
	}
}

// ---------- AC-05.6 frame-wait timeout ----------

func TestAC056TimeoutStoresIncompleteItemAndReturnsToNeutral(t *testing.T) {
	r := newLkRig(t)
	r.openMsg(3)
	r.clk.Advance(29 * time.Second)
	r.rx.Tick()
	r.wantState(StateReceiving) // 30 s not yet over
	if n := len(r.items()); n != 0 {
		t.Fatalf("item stored after 29 s")
	}
	r.clk.Advance(2 * time.Second) // 31 s without a frame
	r.rx.Tick()
	r.wantState(StateNeutral)
	it := r.oneItem()
	if it.Kind != "incomplete" || string(it.Raw) != strings.Join(lkGoldTexts[:3], "") {
		t.Fatalf("item = kind %q raw %q, want incomplete with the 3 frames received", it.Kind, it.Raw)
	}
	if m := lkMeta(t, it); m.IncompleteReason != "frame_timeout" || m.Frames != 3 {
		t.Errorf("link_meta = %+v, want incomplete_reason frame_timeout, frames 3", m)
	}
	if n := len(r.openSessions()); n != 0 {
		t.Errorf("%d session(s) left open after timeout", n)
	}
	r.mustReply("new ENQ after timeout", []byte{ENQ}, []byte{ACK}) // neutral again
}

func TestAC056EachAcceptedFrameRestartsTheTimer(t *testing.T) {
	r := newLkRig(t)
	r.mustReply("ENQ", []byte{ENQ}, []byte{ACK})
	for i := 1; i <= 5; i++ { // 5 x 20 s = 100 s in total, never 30 s between frames
		r.clk.Advance(20 * time.Second)
		r.rx.Tick()
		r.wantState(StateReceiving)
		r.mustReply("frame", lkGoldFrame(t, i), []byte{ACK})
	}
	r.mustReply("EOT", []byte{EOT}, nil)
	if it := r.oneItem(); it.Kind != "data" {
		t.Fatalf("kind = %q, want data", it.Kind)
	}
}

func TestAC056FrameWaitIsConfigurable(t *testing.T) {
	r := newLkRig(t, func(c *ReceiverConfig) { c.FrameWait = 5 * time.Second })
	r.openMsg(2)
	r.clk.Advance(4 * time.Second)
	r.rx.Tick()
	r.wantState(StateReceiving)
	r.clk.Advance(2 * time.Second)
	r.rx.Tick()
	r.wantState(StateNeutral)
	if it := r.oneItem(); it.Kind != "incomplete" {
		t.Fatalf("kind = %q", it.Kind)
	}
}

func TestAC056TimeoutAfterEnqOnlyDoesNotWedgeOrPanic(t *testing.T) {
	r := newLkRig(t)
	r.mustReply("ENQ", []byte{ENQ}, []byte{ACK})
	r.clk.Advance(31 * time.Second)
	r.rx.Tick()
	r.wantState(StateNeutral)
	if n := len(r.openSessions()); n != 0 {
		t.Fatalf("%d session(s) left open", n)
	}
	r.mustReply("ENQ again", []byte{ENQ}, []byte{ACK})
}

func TestTickInNeutralIsHarmless(t *testing.T) {
	r := newLkRig(t)
	r.clk.Advance(time.Hour)
	r.rx.Tick()
	r.wantState(StateNeutral)
	if n := len(r.items()); n != 0 {
		t.Fatal("item created from nothing")
	}
}

// ---------- state machine corners (03-APP-FLOW §3.1) ----------

func TestEnqWhileReceivingFinalisesIncompleteAndOpensNewSession(t *testing.T) {
	r := newLkRig(t)
	r.openMsg(2)
	r.mustReply("second ENQ", []byte{ENQ}, []byte{ACK})
	r.wantState(StateReceiving)
	it := r.oneItem()
	if it.Kind != "incomplete" || string(it.Raw) != lkGoldTexts[0]+lkGoldTexts[1] {
		t.Fatalf("item = kind %q raw %q, want incomplete with frames 1-2", it.Kind, it.Raw)
	}
	if m := lkMeta(t, it); m.IncompleteReason != "new_enq" {
		t.Errorf("incomplete_reason = %q, want new_enq", m.IncompleteReason)
	}
	ss := r.openSessions()
	if len(ss) != 1 || ss[0].Frames != 0 || ss[0].ExpectedFN != 1 || ss[0].ID == it.ID {
		t.Fatalf("open sessions = %+v, want exactly one fresh session at FN 1", ss)
	}
	for i := 1; i <= 5; i++ { // the re-sent message completes normally in the new session
		r.mustReply("frame", lkGoldFrame(t, i), []byte{ACK})
	}
	r.mustReply("EOT", []byte{EOT}, nil)
	its := r.items()
	if len(its) != 2 || its[1].Kind != "data" || its[1].RawSHA256 != lkGoldSHA {
		t.Fatalf("items = %+v, want incomplete + data(golden)", its)
	}
}

func TestStrayBytesInNeutralAreDiscardedAndCounted(t *testing.T) {
	r := newLkRig(t)
	r.mustReply("garbage", []byte("abc"), nil)
	r.mustReply("frame without ENQ", lkGoldFrame(t, 1), nil) // not ACKed: nothing was established
	r.mustReply("EOT in neutral", []byte{EOT}, nil)
	r.wantState(StateNeutral)
	if n := len(r.openSessions()); n != 0 {
		t.Fatalf("a session was opened without ENQ")
	}
	if n := len(r.items()); n != 0 {
		t.Fatalf("an item was created without ENQ")
	}
	if st := r.rx.Stats(); st.DiscardedBytes < 3 {
		t.Errorf("discarded_bytes = %d, want >= 3", st.DiscardedBytes)
	}
}

func TestEotWithoutFramesDoesNotPanicAndReturnsToNeutral(t *testing.T) {
	r := newLkRig(t)
	r.mustReply("ENQ", []byte{ENQ}, []byte{ACK})
	r.mustReply("EOT", []byte{EOT}, nil)
	r.wantState(StateNeutral)
	if n := len(r.openSessions()); n != 0 {
		t.Fatalf("%d session(s) left open", n)
	}
}

// ---------- byte-stream handling (serial/TCP deliver arbitrary slices) ----------

func lkWholeMessage(t *testing.T) (stream, wantReplies []byte) {
	stream = []byte{ENQ}
	for i := 1; i <= 5; i++ {
		stream = append(stream, lkGoldFrame(t, i)...)
	}
	return append(stream, EOT), lkAcks(6)
}

func TestWholeMessageInOneFeed(t *testing.T) {
	r := newLkRig(t)
	stream, want := lkWholeMessage(t)
	r.mustReply("ENQ+5 frames+EOT in one read", stream, want)
	if it := r.oneItem(); it.RawSHA256 != lkGoldSHA {
		t.Fatalf("sha = %s", it.RawSHA256)
	}
}

func TestMessageFedByteByByte(t *testing.T) {
	r := newLkRig(t)
	stream, want := lkWholeMessage(t)
	var got []byte
	for _, b := range stream {
		got = append(got, r.feed([]byte{b})...)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("replies = %q, want %q", got, want)
	}
	if it := r.oneItem(); it.RawSHA256 != lkGoldSHA {
		t.Fatalf("sha = %s", it.RawSHA256)
	}
}

func TestPartialFrameIsNotAckedUntilComplete(t *testing.T) {
	r := newLkRig(t)
	r.mustReply("ENQ", []byte{ENQ}, []byte{ACK})
	f := lkGoldFrame(t, 1)
	r.mustReply("first half", f[:len(f)/2], nil)
	if n := r.rawCount("session_chunks"); n != 0 {
		t.Fatalf("partial frame persisted")
	}
	r.mustReply("second half", f[len(f)/2:], []byte{ACK})
	if n := r.rawCount("session_chunks"); n != 1 {
		t.Fatalf("chunks = %d, want 1", n)
	}
}

func TestFeedNeverPanicsOnHostileBytes(t *testing.T) {
	r := newLkRig(t)
	for _, in := range [][]byte{nil, {}, {STX}, {STX, STX, STX}, {0x00, 0xff, 0x80}, {ETX, ETB, '\r', '\n'}, bytes.Repeat([]byte{ENQ}, 50), bytes.Repeat([]byte{EOT, ENQ}, 20)} {
		_ = r.feed(in)
		r.rx.Tick()
	}
	r.rx.Tick()
}
