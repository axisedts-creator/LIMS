package astm

// AG-T06 tests: ASTM sender state machine. Spec: 03-APP-FLOW §3.2 (+ its rules), 02-TRD §5.2.2/§5.2.4,
// 01-PRD AC-06.1..AC-06.5. Pure state machine: no queue, no I/O, no sleeps; time comes from the fake lkClock
// (link_helpers_test.go, AG-T05). The spec names only the file (internal/astm/link.go); the Go names below are the
// tests' contract for the writer. Everything is in package astm, next to the AG-T05 Receiver.
//
//	type SenderConfig struct {
//	    Clock                                                                  Clock    // required; link.go never calls time.Now/Sleep
//	    EstablishReply, NakRetryDelay, ContentionDefer, TransferReply          time.Duration // 0 = 15 s, 10 s, 20 s, 15 s
//	    InterruptBackoff, OutboundRetryCycle                                   time.Duration // 0 = 15 s, 60 s
//	    MaxFrameSends, MaxEstablishAttempts, MaxOutboundCycles                 int           // 0 = 6, 6, 3
//	}
//	func NewSender(cfg SenderConfig) *Sender
//	func (s *Sender) Submit(records [][]byte) error // one outbound message = its records (each incl. trailing CR). Error: no/empty
//	                                                // records, or a message is already retained/in flight. Copies the input.
//	                                                // A new Submit is allowed after ResultSent / ResultFailed. Resets Cycles().
//	func (s *Sender) Tick() []byte   // timers + "start establishing" (ENQ). Returns the bytes to write (nil = nothing). Idempotent.
//	func (s *Sender) Feed(b []byte) []byte // bytes read from the line (one event per call) -> bytes to write (nil = nothing)
//	func (s *Sender) State() SendState     // SendNeutral | SendEstablishing | SendNakWait | SendTransfer | SendDeferred
//	func (s *Sender) Result() SendResult   // ResultPending (zero; message retained or none submitted) | ResultSent | ResultFailed
//	func (s *Sender) Cycles() int          // finished retry cycles (Terminate / Giveup) of the current message
//
// Contention (AC-06.3): Feed(ENQ) while Establishing returns {ACK}, state SendDeferred; while deferred the Sender writes nothing
// and ignores bytes except EOT, which ends the deferral early (the owner feeds all line bytes to Sender and Receiver).
// Terminal timeouts/limits send EOT and end the cycle: a retained message restarts from frame 1 in a new transfer phase.

import (
	"bytes"
	"strings"
	"testing"
	"time"
)

type sdRig struct {
	t   *testing.T
	clk *lkClock
	s   *Sender
}

func newSdRig(t *testing.T, mut ...func(*SenderConfig)) *sdRig {
	t.Helper()
	clk := &lkClock{t: time.Date(2026, 11, 11, 8, 0, 0, 0, time.UTC)}
	cfg := SenderConfig{Clock: clk}
	for _, m := range mut {
		m(&cfg)
	}
	return &sdRig{t: t, clk: clk, s: NewSender(cfg)}
}

func (r *sdRig) adv(d time.Duration) { r.clk.Advance(d) }

func (r *sdRig) tick(what string, want []byte) {
	r.t.Helper()
	if got := r.s.Tick(); !bytes.Equal(got, want) {
		r.t.Fatalf("%s: Tick = %q, want %q", what, got, want)
	}
}

func (r *sdRig) feed(what string, in, want []byte) {
	r.t.Helper()
	if got := r.s.Feed(in); !bytes.Equal(got, want) {
		r.t.Fatalf("%s: Feed(%q) = %q, want %q", what, in, got, want)
	}
}

func (r *sdRig) state(want SendState) {
	r.t.Helper()
	if got := r.s.State(); got != want {
		r.t.Fatalf("state = %v, want %v", got, want)
	}
}

func (r *sdRig) result(want SendResult) {
	r.t.Helper()
	if got := r.s.Result(); got != want {
		r.t.Fatalf("result = %v, want %v", got, want)
	}
}

func (r *sdRig) cycles(want int) {
	r.t.Helper()
	if got := r.s.Cycles(); got != want {
		r.t.Fatalf("Cycles = %d, want %d", got, want)
	}
}

func sdGold() [][]byte {
	out := make([][]byte, len(lkGoldTexts))
	for i, s := range lkGoldTexts {
		out[i] = []byte(s)
	}
	return out
}

func (r *sdRig) submit(recs [][]byte) {
	r.t.Helper()
	if err := r.s.Submit(recs); err != nil {
		r.t.Fatalf("Submit: %v", err)
	}
}

// startGold: submit the golden message, ENQ out, ACK in -> frame 1 out; leaves the sender in Transfer with sends=1.
func (r *sdRig) startGold() {
	r.t.Helper()
	r.submit(sdGold())
	r.tick("ENQ", []byte{ENQ})
	r.feed("ACK to ENQ", []byte{ACK}, lkGoldFrame(r.t, 1))
	r.state(SendTransfer)
}

// sendAll runs a whole message through an ACKing instrument and returns the frames the sender wrote.
func sdSendAll(t *testing.T, r *sdRig, recs [][]byte) [][]byte {
	t.Helper()
	r.submit(recs)
	r.tick("ENQ", []byte{ENQ})
	var frames [][]byte
	reply := r.s.Feed([]byte{ACK})
	for len(frames) < 100000 {
		if bytes.Equal(reply, []byte{EOT}) {
			r.result(ResultSent)
			return frames
		}
		if len(reply) == 0 || reply[0] != STX {
			t.Fatalf("after %d frames: reply = %q, want a frame or EOT", len(frames), reply)
		}
		frames = append(frames, reply)
		reply = r.s.Feed([]byte{ACK})
	}
	t.Fatal("sender never terminated the message")
	return nil
}

func rec(prefix string, n int) []byte { // record of exactly n bytes, ends with CR
	return []byte(prefix + strings.Repeat("a", n-len(prefix)-1) + "\r")
}

// ---------------------------------------------------------------- AC-06.1 ENQ, frames, FN, splitting

func TestSend_NothingPendingSendsNothing(t *testing.T) {
	r := newSdRig(t)
	r.tick("idle", nil)
	r.feed("stray ACK", []byte{ACK}, nil)
	r.feed("stray ENQ (receiver's job)", []byte{ENQ}, nil)
	r.state(SendNeutral)
	r.result(ResultPending)
}

func TestSend_GoldenMessageEnqAckFramesEot(t *testing.T) {
	r := newSdRig(t)
	r.submit(sdGold())
	r.state(SendNeutral)
	r.tick("ENQ", []byte{ENQ})
	r.state(SendEstablishing)
	r.adv(time.Second)
	r.tick("no second ENQ while waiting", nil)
	r.feed("ACK", []byte{ACK}, lkGoldFrame(t, 1))
	r.state(SendTransfer)
	for i := 2; i <= 5; i++ {
		r.feed("ACK -> next frame", []byte{ACK}, lkGoldFrame(t, i))
	}
	r.feed("ACK for last frame -> EOT", []byte{ACK}, []byte{EOT})
	r.state(SendNeutral)
	r.result(ResultSent)
	r.adv(10 * time.Minute)
	r.tick("nothing after sent", nil)
}

func TestSend_FrameNumbersWrapModulo8(t *testing.T) {
	var recs [][]byte
	for i := 0; i < 10; i++ {
		recs = append(recs, []byte("P|1\r"))
	}
	frames := sdSendAll(t, newSdRig(t), recs)
	want := []int{1, 2, 3, 4, 5, 6, 7, 0, 1, 2}
	if len(frames) != len(want) {
		t.Fatalf("frames = %d, want %d", len(frames), len(want))
	}
	for i, f := range frames {
		d, err := DecodeFrame(f)
		if err != nil || d.FN != want[i] {
			t.Fatalf("frame %d: FN = %d err = %v, want FN %d", i, d.FN, err, want[i])
		}
	}
}

func TestSend_RecordsSplitEtbEtx(t *testing.T) {
	cases := []struct {
		n    int
		want []byte // terminators
	}{
		{5, []byte{ETX}}, {240, []byte{ETX}}, {241, []byte{ETB, ETX}}, {480, []byte{ETB, ETX}},
		{481, []byte{ETB, ETB, ETX}}, {600, []byte{ETB, ETB, ETX}},
	}
	for _, c := range cases {
		r := rec("R|1|", c.n)
		frames := sdSendAll(t, newSdRig(t), [][]byte{r})
		if len(frames) != len(c.want) {
			t.Fatalf("len %d: frames = %d, want %d", len(r), len(frames), len(c.want))
		}
		var got []byte
		for i, f := range frames {
			if len(f) > 247 {
				t.Fatalf("len %d frame %d: %d bytes > 247", len(r), i, len(f))
			}
			d, err := DecodeFrame(f)
			if err != nil {
				t.Fatalf("len %d frame %d: %v", len(r), i, err)
			}
			if len(d.Text) > 240 {
				t.Fatalf("len %d frame %d: text %d > 240", len(r), i, len(d.Text))
			}
			if d.Terminator != c.want[i] {
				t.Fatalf("len %d frame %d: terminator %#x, want %#x", len(r), i, d.Terminator, c.want[i])
			}
			got = append(got, d.Text...)
		}
		if !bytes.Equal(got, r) {
			t.Fatalf("len %d: reassembled text differs", len(r))
		}
	}
}

func TestSend_FramesNeverMixRecords(t *testing.T) {
	// 300-byte record then a short one: second record starts its own frame (TRD 5.2.2).
	frames := sdSendAll(t, newSdRig(t), [][]byte{rec("R|1|", 300), []byte("L|1|N\r")})
	if len(frames) != 3 {
		t.Fatalf("frames = %d, want 3 (ETB 240, ETX 60, ETX L)", len(frames))
	}
	d, _ := DecodeFrame(frames[2])
	if string(d.Text) != "L|1|N\r" || d.FN != 3 {
		t.Fatalf("third frame = FN %d %q, want FN 3 \"L|1|N\\r\"", d.FN, d.Text)
	}
}

func TestSend_HugeRecordIsBoundedFrames(t *testing.T) { // security: 100 kB input never yields an oversize frame
	frames := sdSendAll(t, newSdRig(t), [][]byte{rec("R|1|", 100000)})
	if len(frames) != 417 { // ceil(100000/240)
		t.Fatalf("frames = %d, want 417", len(frames))
	}
	for i, f := range frames {
		if len(f) > 247 {
			t.Fatalf("frame %d is %d bytes", i, len(f))
		}
	}
}

func TestSubmit_Validation(t *testing.T) {
	r := newSdRig(t)
	for name, recs := range map[string][][]byte{"nil": nil, "no records": {}, "empty record": {[]byte("H|\\^&\r"), {}}} {
		if err := r.s.Submit(recs); err == nil {
			t.Fatalf("Submit(%s) = nil error, want error", name)
		}
	}
	r.tick("rejected submit leaves nothing to send", nil)
	r.submit(sdGold())
	if err := r.s.Submit(sdGold()); err == nil {
		t.Fatal("second Submit while a message is retained = nil error, want error")
	}
	r.state(SendNeutral)
}

func TestSubmit_AllowedAgainAfterSent(t *testing.T) {
	r := newSdRig(t)
	sdSendAll(t, r, sdGold())
	r.submit([][]byte{[]byte("P|1\r")})
	r.result(ResultPending)
	r.cycles(0)
}

func TestSubmit_CopiesInput(t *testing.T) { // caller reuses its buffer after Submit
	r := newSdRig(t)
	buf := []byte("P|1\r")
	r.submit([][]byte{buf})
	copy(buf, "XXXX")
	r.tick("ENQ", []byte{ENQ})
	r.feed("ACK", []byte{ACK}, lkFrame(t, 1, "P|1\r", ETX))
}

// ---------------------------------------------------------------- AC-06.2 NAK, 6 sends, timeout, interrupt

func TestSend_NakResendsSameFrameSameFN_SixthSendThenEot(t *testing.T) {
	r := newSdRig(t)
	r.startGold()
	f1 := lkGoldFrame(t, 1)
	for i := 2; i <= 6; i++ { // sends 2..6
		r.feed("NAK -> resend", []byte{NAK}, f1)
	}
	r.state(SendTransfer)
	r.feed("NAK after 6th send -> EOT", []byte{NAK}, []byte{EOT})
	r.state(SendNeutral)
	r.result(ResultPending) // message kept for a later attempt
	r.cycles(1)
}

func TestSend_AnyOtherCharCountsAsNak(t *testing.T) {
	r := newSdRig(t)
	r.startGold()
	f1 := lkGoldFrame(t, 1)
	for _, c := range []byte{'X', 0x00, 0xFF, STX, ENQ} {
		r.feed("other char -> resend", []byte{c}, f1)
	}
	r.feed("6th unaccepted -> EOT", []byte{'Z'}, []byte{EOT})
	r.result(ResultPending)
}

func TestSend_SendCountResetsOnAck(t *testing.T) {
	r := newSdRig(t)
	r.startGold()
	for i := 0; i < 4; i++ {
		r.feed("NAK f1", []byte{NAK}, lkGoldFrame(t, 1))
	}
	r.feed("ACK f1 -> f2", []byte{ACK}, lkGoldFrame(t, 2))
	for i := 0; i < 5; i++ { // f2 gets its own full 6 sends
		r.feed("NAK f2", []byte{NAK}, lkGoldFrame(t, 2))
	}
	r.feed("ACK f2 -> f3", []byte{ACK}, lkGoldFrame(t, 3))
	r.state(SendTransfer)
}

func TestSend_LastFrameUnacceptedIsNotSent(t *testing.T) {
	r := newSdRig(t)
	r.startGold()
	for i := 2; i <= 5; i++ {
		r.feed("ACK", []byte{ACK}, lkGoldFrame(t, i))
	}
	for i := 0; i < 5; i++ {
		r.feed("NAK f5", []byte{NAK}, lkGoldFrame(t, 5))
	}
	r.feed("6th NAK on last frame", []byte{NAK}, []byte{EOT})
	r.result(ResultPending)
	r.cycles(1)
}

func TestSend_RetainedMessageRestartsAtFrame1AfterRetryCycle(t *testing.T) {
	r := newSdRig(t)
	r.startGold()
	r.feed("ACK f1 -> f2", []byte{ACK}, lkGoldFrame(t, 2))
	for i := 0; i < 5; i++ {
		r.feed("NAK f2", []byte{NAK}, lkGoldFrame(t, 2))
	}
	r.feed("EOT", []byte{NAK}, []byte{EOT})
	r.adv(59 * time.Second)
	r.tick("before outbound_retry_cycle_s (60 s)", nil)
	r.adv(2 * time.Second)
	r.tick("retry", []byte{ENQ})
	r.feed("ACK", []byte{ACK}, lkGoldFrame(t, 1)) // whole message again, from frame 1
}

func TestSend_TransferReplyTimeoutTerminates(t *testing.T) {
	r := newSdRig(t)
	r.startGold()
	r.adv(14 * time.Second)
	r.tick("before transfer_reply_s", nil)
	r.adv(2 * time.Second)
	r.tick("timeout -> EOT", []byte{EOT})
	r.state(SendNeutral)
	r.result(ResultPending)
	r.cycles(1)
	r.adv(10 * time.Second)
	r.tick("no immediate retry", nil)
}

func TestSend_TransferTimerRestartsOnAckAndOnResend(t *testing.T) {
	r := newSdRig(t)
	r.startGold()
	r.adv(10 * time.Second)
	r.feed("ACK f1", []byte{ACK}, lkGoldFrame(t, 2))
	r.adv(14 * time.Second) // 14 s after the ACK, 24 s after frame 1
	r.tick("timer restarted by ACK", nil)
	r.adv(2 * time.Second)
	r.tick("16 s after f2 -> EOT", []byte{EOT})

	r2 := newSdRig(t)
	r2.startGold()
	r2.adv(10 * time.Second)
	r2.feed("NAK -> resend", []byte{NAK}, lkGoldFrame(t, 1))
	r2.adv(14 * time.Second)
	r2.tick("timer restarted by resend", nil)
	r2.adv(2 * time.Second)
	r2.tick("then times out", []byte{EOT})
}

func TestSend_ReceiverInterruptEotBackoffRetainsMessage(t *testing.T) {
	r := newSdRig(t)
	r.startGold()
	r.feed("ACK f1", []byte{ACK}, lkGoldFrame(t, 2))
	r.feed("ACK f2", []byte{ACK}, lkGoldFrame(t, 3))
	r.feed("receiver interrupt EOT -> EOT", []byte{EOT}, []byte{EOT})
	r.state(SendNeutral)
	r.result(ResultPending)
	r.adv(14 * time.Second)
	r.tick("before receiver_interrupt_backoff_s (15 s)", nil)
	r.adv(2 * time.Second)
	r.tick("re-establish", []byte{ENQ})
	r.feed("ACK", []byte{ACK}, lkGoldFrame(t, 1)) // whole message from frame 1
}

// ---------------------------------------------------------------- AC-06.3 contention

func TestSend_ContentionYieldsAckAndDefers20s(t *testing.T) {
	r := newSdRig(t)
	r.submit(sdGold())
	r.tick("ENQ", []byte{ENQ})
	r.adv(2 * time.Second)
	r.feed("instrument ENQ crosses ours -> ACK", []byte{ENQ}, []byte{ACK})
	r.state(SendDeferred)
	r.result(ResultPending)
	r.adv(17 * time.Second) // 17 s after the yield (t=19); also past the 15 s establish timer
	r.tick("no ENQ and no EOT inside defer window", nil)
	r.adv(4 * time.Second) // 21 s after the yield (t=23)
	r.tick("defer over -> ENQ again", []byte{ENQ})
	r.state(SendEstablishing)
	r.feed("ACK", []byte{ACK}, lkGoldFrame(t, 1)) // message kept
}

func TestSend_DeferEndsEarlyWhenInstrumentMessageCompletes(t *testing.T) {
	r := newSdRig(t)
	r.submit(sdGold())
	r.tick("ENQ", []byte{ENQ})
	r.feed("contention", []byte{ENQ}, []byte{ACK})
	r.feed("instrument frame is the Receiver's business", lkGoldFrame(t, 1), nil)
	r.adv(3 * time.Second)
	r.tick("message still running", nil)
	r.state(SendDeferred)
	r.feed("instrument EOT", []byte{EOT}, nil)
	r.tick("re-establish right away", []byte{ENQ})
	r.state(SendEstablishing)
}

func TestSend_DeferSurvivesNoise(t *testing.T) {
	r := newSdRig(t)
	r.submit(sdGold())
	r.tick("ENQ", []byte{ENQ})
	r.feed("contention", []byte{ENQ}, []byte{ACK})
	for _, c := range []byte{ACK, NAK, 'X', ENQ} {
		r.feed("ignored while deferred", []byte{c}, nil)
	}
	r.state(SendDeferred)
	r.tick("still deferred", nil)
}

// ---------------------------------------------------------------- AC-06.4 establish timeout, NAK to ENQ

func TestSend_NoReplyToEnqTerminatesThenRetriesAfterCycle(t *testing.T) {
	r := newSdRig(t)
	r.submit(sdGold())
	r.tick("ENQ", []byte{ENQ})
	r.adv(14 * time.Second)
	r.tick("before establish_reply_s", nil)
	r.adv(2 * time.Second)
	r.tick("no reply in 15 s -> EOT", []byte{EOT})
	r.state(SendNeutral)
	r.result(ResultPending)
	r.cycles(1)
	r.adv(59 * time.Second)
	r.tick("before outbound_retry_cycle_s", nil)
	r.adv(2 * time.Second)
	r.tick("retry", []byte{ENQ})
	r.feed("ACK", []byte{ACK}, lkGoldFrame(t, 1))
}

func TestSend_NakToEnqWaits10sThenResendsEnq(t *testing.T) {
	r := newSdRig(t)
	r.submit(sdGold())
	r.tick("ENQ", []byte{ENQ})
	r.feed("NAK to ENQ", []byte{NAK}, nil)
	r.state(SendNakWait)
	r.adv(9 * time.Second)
	r.tick("before nak_retry_delay_s", nil)
	r.adv(2 * time.Second)
	r.tick("ENQ again", []byte{ENQ})
	r.state(SendEstablishing)
	r.adv(14 * time.Second)
	r.tick("establish timer restarted for the new ENQ", nil)
	r.feed("ACK", []byte{ACK}, lkGoldFrame(t, 1))
}

func TestSend_MaxEstablishAttemptsEndsCycle(t *testing.T) {
	r := newSdRig(t)
	r.submit(sdGold())
	for i := 1; i <= 6; i++ { // max_establish_attempts = 6 ENQs
		r.tick("ENQ attempt", []byte{ENQ})
		r.feed("NAK", []byte{NAK}, nil)
		r.adv(11 * time.Second)
	}
	r.tick("7th ENQ is not sent: cycle over", nil)
	r.state(SendNeutral)
	r.result(ResultPending)
	r.cycles(1)
	r.adv(30 * time.Second)
	r.tick("wait for the retry cycle", nil)
	r.adv(62 * time.Second)
	r.tick("next cycle: attempts reset", []byte{ENQ})
}

func TestSend_GiveupAfterMaxOutboundCycles(t *testing.T) {
	r := newSdRig(t)
	r.submit(sdGold())
	for c := 1; c <= 3; c++ { // max_outbound_cycles = 3
		r.tick("ENQ", []byte{ENQ})
		r.adv(16 * time.Second)
		r.tick("establish timeout", []byte{EOT})
		r.cycles(c)
		if c < 3 {
			r.result(ResultPending)
			r.adv(61 * time.Second)
		}
	}
	r.result(ResultFailed)
	r.state(SendNeutral)
	r.adv(10 * time.Minute)
	r.tick("failed message is never sent again", nil)
	r.submit([][]byte{[]byte("P|1\r")}) // sender is reusable
	r.result(ResultPending)
	r.cycles(0)
	r.tick("new message", []byte{ENQ})
}

// ---------------------------------------------------------------- AC-06.5 per-instrument configuration

func TestSend_ConfigurableTimersAndLimits(t *testing.T) {
	all := func(c *SenderConfig) {
		c.EstablishReply, c.NakRetryDelay, c.ContentionDefer = 3*time.Second, 2*time.Second, 4*time.Second
		c.TransferReply, c.InterruptBackoff, c.OutboundRetryCycle = 5*time.Second, 6*time.Second, 7*time.Second
		c.MaxFrameSends, c.MaxEstablishAttempts, c.MaxOutboundCycles = 2, 2, 2
	}
	s := func(n int) time.Duration { return time.Duration(n) * time.Second }

	t.Run("establish_reply_s + outbound_retry_cycle_s", func(t *testing.T) {
		r := newSdRig(t, all)
		r.submit(sdGold())
		r.tick("ENQ", []byte{ENQ})
		r.adv(s(2))
		r.tick("before 3 s", nil)
		r.adv(s(2))
		r.tick("EOT", []byte{EOT})
		r.adv(s(6))
		r.tick("before 7 s", nil)
		r.adv(s(2))
		r.tick("ENQ", []byte{ENQ})
	})
	t.Run("nak_retry_delay_s", func(t *testing.T) {
		r := newSdRig(t, all)
		r.submit(sdGold())
		r.tick("ENQ", []byte{ENQ})
		r.feed("NAK", []byte{NAK}, nil)
		r.adv(s(1))
		r.tick("before 2 s", nil)
		r.adv(s(2))
		r.tick("ENQ", []byte{ENQ})
	})
	t.Run("host_contention_defer_s", func(t *testing.T) {
		r := newSdRig(t, all)
		r.submit(sdGold())
		r.tick("ENQ", []byte{ENQ})
		r.feed("contention", []byte{ENQ}, []byte{ACK})
		r.adv(s(3))
		r.tick("before 4 s", nil)
		r.adv(s(2))
		r.tick("ENQ", []byte{ENQ})
	})
	t.Run("transfer_reply_s", func(t *testing.T) {
		r := newSdRig(t, all)
		r.startGold()
		r.adv(s(4))
		r.tick("before 5 s", nil)
		r.adv(s(2))
		r.tick("EOT", []byte{EOT})
	})
	t.Run("max_frame_sends", func(t *testing.T) {
		r := newSdRig(t, all)
		r.startGold()
		r.feed("NAK -> 2nd send", []byte{NAK}, lkGoldFrame(t, 1))
		r.feed("NAK -> EOT", []byte{NAK}, []byte{EOT})
	})
	t.Run("receiver_interrupt_backoff_s", func(t *testing.T) {
		r := newSdRig(t, all)
		r.startGold()
		r.feed("interrupt", []byte{EOT}, []byte{EOT})
		r.adv(s(5))
		r.tick("before 6 s", nil)
		r.adv(s(2))
		r.tick("ENQ", []byte{ENQ})
	})
	t.Run("max_establish_attempts", func(t *testing.T) {
		r := newSdRig(t, all)
		r.submit(sdGold())
		for i := 0; i < 2; i++ {
			r.tick("ENQ", []byte{ENQ})
			r.feed("NAK", []byte{NAK}, nil)
			r.adv(s(3))
		}
		r.tick("3rd ENQ not sent", nil)
		r.cycles(1)
	})
	t.Run("max_outbound_cycles", func(t *testing.T) {
		r := newSdRig(t, all)
		r.submit(sdGold())
		for c := 1; c <= 2; c++ {
			r.tick("ENQ", []byte{ENQ})
			r.adv(s(4))
			r.tick("EOT", []byte{EOT})
			r.adv(s(8))
		}
		r.result(ResultFailed)
		r.tick("never again", nil)
	})
}
