package astm

// Receiver state machine (03-APP-FLOW §3.1, TRD §5.2.3/§5.2.4/§5.2.7). Persist-before-ACK (D-02): an ACK is returned
// only after the frame is committed by queue.AppendChunk. Single goroutine owns a Receiver (Feed and Tick are not
// safe for concurrent use). This file never calls time.Now or time.Sleep: time comes from Clock.

import (
	"bytes"
	"encoding/json"
	"errors"
	"time"

	"lims/apps/bridge-agent/internal/queue"
)

const (
	linkTS           = "2006-01-02T15:04:05.000Z" // agent timestamps: UTC text (same as queue)
	defaultFrameWait = 30 * time.Second           // receiver_frame_wait_s (TRD §5.2.4)
	protocolASTM     = "astm"
)

// Clock is the receiver's only source of time.
type Clock interface{ Now() time.Time }

// State of the link receiver.
type State int

const (
	StateNeutral State = iota
	StateReceiving
)

func (s State) String() string {
	if s == StateReceiving {
		return "receiving"
	}
	return "neutral"
}

// Stats are cumulative since NewReceiver.
type Stats struct{ Frames, Retransmits, NaksSent, DiscardedBytes int }

// ReceiverConfig configures a Receiver. Queue, Clock and NewID are required.
type ReceiverConfig struct {
	InstrumentID  string
	Queue         *queue.DB
	Clock         Clock
	FrameWait     time.Duration // 0 = 30 s
	NewID         func() string // ids for sessions and items
	ClockOffsetMs func() int64  // nil = 0
}

type linkMeta struct {
	Frames           int    `json:"frames"`
	Retransmits      int    `json:"retransmits"`
	NaksSent         int    `json:"naks_sent"`
	IncompleteReason string `json:"incomplete_reason,omitempty"`
}

type rxSession struct {
	id          string
	expectedFN  int
	prevFN      int // -1 = no frame accepted yet
	frames      int
	retransmits int
	naks        int
	lastAct     time.Time
}

// Receiver is the ASTM E1381 receiver for one instrument link.
type Receiver struct {
	cfg   ReceiverConfig
	wait  time.Duration
	state State
	sess  rxSession
	buf   []byte // frame being assembled (STX..LF)
	inFr  bool
	over  bool // current frame exceeded maxFrame: discard to LF, then one NAK
	stats Stats
}

// NewReceiver does not touch the queue; it starts Neutral.
func NewReceiver(cfg ReceiverConfig) *Receiver {
	w := cfg.FrameWait
	if w <= 0 {
		w = defaultFrameWait
	}
	return &Receiver{cfg: cfg, wait: w}
}

func (r *Receiver) State() State { return r.state }
func (r *Receiver) Stats() Stats { return r.stats }

func (r *Receiver) now() time.Time { return r.cfg.Clock.Now().UTC() }

func (r *Receiver) offset() int64 {
	if r.cfg.ClockOffsetMs == nil {
		return 0
	}
	return r.cfg.ClockOffsetMs()
}

// Feed consumes bytes read from the line and returns the bytes to write back (ACK/NAK per event, in order).
func (r *Receiver) Feed(b []byte) []byte {
	var out []byte
	for _, c := range b {
		out = r.feedByte(c, out)
	}
	return out
}

func (r *Receiver) feedByte(c byte, out []byte) []byte {
	if r.state == StateNeutral {
		if c == ENQ {
			return r.onENQ(out)
		}
		r.stats.DiscardedBytes++
		return out
	}
	if !r.inFr {
		switch c {
		case ENQ:
			return r.onENQ(out)
		case EOT:
			r.onEOT()
		case STX:
			r.inFr, r.over = true, false
			r.buf = append(r.buf[:0], c)
		default:
			r.stats.DiscardedBytes++
		}
		return out
	}
	// inside a frame: it ends at LF; anything beyond maxFrame bytes is discarded (bounded memory), one NAK at LF
	if r.over {
		r.stats.DiscardedBytes++
	} else {
		r.buf = append(r.buf, c)
		if len(r.buf) > maxFrame {
			r.stats.DiscardedBytes += len(r.buf)
			r.over, r.buf = true, r.buf[:0]
		}
	}
	if c != '\n' {
		return out
	}
	r.inFr = false
	if r.over {
		r.over = false
		return r.nak(out)
	}
	return r.onFrame(out)
}

func (r *Receiver) nak(out []byte) []byte {
	r.stats.NaksSent++
	r.sess.naks++
	return append(out, NAK)
}

// onENQ: a running session is closed incomplete (new_enq); the new session opens only if the queue is writable (AC-05.1).
func (r *Receiver) onENQ(out []byte) []byte {
	if r.state == StateReceiving {
		r.closeSession("new_enq")
	}
	r.state, r.inFr, r.over, r.buf = StateNeutral, false, false, r.buf[:0]
	if low, err := r.cfg.Queue.DiskLow(); err != nil || low {
		return append(out, NAK)
	}
	now := r.now()
	id := r.cfg.NewID()
	ts := now.Format(linkTS)
	err := r.cfg.Queue.BeginSession(queue.Session{ID: id, InstrumentID: r.cfg.InstrumentID, Protocol: protocolASTM,
		StartedAtAgent: ts, LastFrameAtAgent: ts, ExpectedFN: 1})
	if err != nil {
		return append(out, NAK)
	}
	r.sess = rxSession{id: id, expectedFN: 1, prevFN: -1, lastAct: now}
	r.state = StateReceiving
	return append(out, ACK)
}

// onFrame applies TRD §5.2.3 and persists before it ACKs (AC-05.2, AC-05.3, AC-05.4).
func (r *Receiver) onFrame(out []byte) []byte {
	f, v := Receive(r.buf, r.sess.expectedFN, r.sess.prevFN)
	r.buf = r.buf[:0]
	switch v {
	case Retransmit:
		r.stats.Retransmits++
		r.sess.retransmits++
		r.sess.lastAct = r.now()
		return append(out, ACK)
	case Accept:
		if low, err := r.cfg.Queue.DiskLow(); err != nil || low {
			return r.nak(out)
		}
		now := r.now()
		next := NextFN(f.FN)
		if err := r.cfg.Queue.AppendChunk(r.sess.id, r.sess.frames+1, next, f.Text, now.Format(linkTS)); err != nil {
			return r.nak(out)
		}
		r.stats.Frames++
		r.sess.frames++
		r.sess.expectedFN, r.sess.prevFN, r.sess.lastAct = next, f.FN, now
		return append(out, ACK)
	}
	return r.nak(out)
}

// onEOT ends the message: one item (kind from the classifier), EOT is not answered.
func (r *Receiver) onEOT() { r.closeSession("") }

// Tick applies the frame-wait timeout (AC-05.6). The owner calls it on a timer.
func (r *Receiver) Tick() {
	if r.state == StateReceiving && !r.now().Before(r.sess.lastAct.Add(r.wait)) {
		r.closeSession("frame_timeout")
	}
}

// closeSession finalises the running session and returns to Neutral. reason "" = normal EOT. On a queue error the
// session stays in the queue; Recover finalises it as process_restart at the next start [CONV].
func (r *Receiver) closeSession(reason string) {
	s := r.sess
	r.state, r.inFr, r.over, r.buf, r.sess = StateNeutral, false, false, r.buf[:0], rxSession{}
	meta := linkMeta{Frames: s.frames, Retransmits: s.retransmits, NaksSent: s.naks, IncompleteReason: reason}
	_ = r.finalize(s.id, s.frames, meta, r.now().Format(linkTS))
}

// finalize stores the session as one item, or drops a session without frames (nothing to upload).
func (r *Receiver) finalize(sessionID string, frames int, meta linkMeta, capturedAt string) error {
	q := r.cfg.Queue
	if frames == 0 {
		return q.DeleteSession(sessionID)
	}
	kind := "incomplete"
	if meta.IncompleteReason == "" {
		parts, err := q.Chunks(sessionID)
		if err != nil {
			return err
		}
		kind = string(Classify(bytes.Join(parts, nil)))
		if kind == string(ClassOther) {
			kind = string(ClassData) // TRD §5.3: still uploaded as data
		}
	}
	mj, err := json.Marshal(struct {
		LinkMeta linkMeta `json:"link_meta"`
	}{meta})
	if err != nil {
		return err
	}
	_, err = q.FinalizeSession(sessionID, queue.ItemInput{
		ID: r.cfg.NewID(), InstrumentID: r.cfg.InstrumentID, Kind: kind, Protocol: protocolASTM,
		Meta: mj, CapturedAtAgent: capturedAt, ClockOffsetMs: r.offset(),
	})
	return err
}

// Recover (03-APP-FLOW §3.1 rule 4) finalises every session left open by a crash: complete (last chunk is an L record,
// only EOT was lost) -> normal item; otherwise incomplete / process_restart. Sessions that cannot be read stay open and
// are reported in the error. Returns the number of sessions finalised.
func (r *Receiver) Recover() (int, error) {
	open, err := r.cfg.Queue.OpenSessions()
	if err != nil {
		return 0, err
	}
	n := 0
	var errs []error
	for _, s := range open {
		if r.state == StateReceiving && s.ID == r.sess.id {
			continue
		}
		parts, err := r.cfg.Queue.Chunks(s.ID)
		if err != nil {
			errs = append(errs, err)
			continue
		}
		meta := linkMeta{Frames: len(parts), IncompleteReason: "process_restart"}
		if endsWithL(parts) {
			meta.IncompleteReason = ""
		}
		if err := r.finalize(s.ID, len(parts), meta, s.LastFrameAtAgent); err != nil {
			errs = append(errs, err)
			continue
		}
		if len(parts) > 0 {
			n++
		}
	}
	return n, errors.Join(errs...)
}

// endsWithL reports whether the last chunk is a complete L (terminator) record ending with ETX
// (03-APP-FLOW §3.1 rule 4). An ETX-terminated record text ends with CR; an ETB chunk never does.
// The field delimiter comes from the H record.
func endsWithL(parts [][]byte) bool {
	if len(parts) == 0 {
		return false
	}
	delim := byte('|')
	if h := parts[0]; len(h) >= 2 && h[0] == 'H' {
		delim = h[1]
	}
	last := parts[len(parts)-1]
	return len(last) >= 2 && last[0] == 'L' && (last[1] == delim || last[1] == '\r') && last[len(last)-1] == '\r'
}

// ---- Sender state machine (03-APP-FLOW §3.2, TRD §5.2.2/§5.2.4; AC-06.1..AC-06.5) ----
// One outbound message (its records) is retained until it is sent or given up. No I/O and no sleeping: the owner writes
// the bytes returned by Tick/Feed, calls Tick on a timer and feeds the bytes read from the line (one event per call;
// the first byte is the event, except while deferred where a trailing EOT ends the deferral). Not safe for concurrent use.

// Sender timer and limit defaults (TRD §5.2.4); every one is overridable per instrument (AC-06.5).
const (
	defEstablishReply     = 15 * time.Second // establish_reply_s
	defNakRetryDelay      = 10 * time.Second // nak_retry_delay_s
	defContentionDefer    = 20 * time.Second // host_contention_defer_s
	defTransferReply      = 15 * time.Second // transfer_reply_s
	defInterruptBackoff   = 15 * time.Second // receiver_interrupt_backoff_s
	defOutboundRetryCycle = 60 * time.Second // outbound_retry_cycle_s
	defMaxFrameSends      = 6                // max_frame_sends
	defMaxEstablish       = 6                // max_establish_attempts
	defMaxOutboundCycles  = 3                // max_outbound_cycles
)

// SendState is the sender's link state.
type SendState int

const (
	SendNeutral SendState = iota
	SendEstablishing
	SendNakWait
	SendTransfer
	SendDeferred
)

func (s SendState) String() string {
	switch s {
	case SendEstablishing:
		return "establishing"
	case SendNakWait:
		return "nak_wait"
	case SendTransfer:
		return "transfer"
	case SendDeferred:
		return "deferred"
	}
	return "neutral"
}

// SendResult is the outcome of the current message.
type SendResult int

const (
	ResultPending SendResult = iota // none submitted, or retained for a later attempt
	ResultSent
	ResultFailed
)

// SenderConfig configures a Sender. Clock is required; 0 = default.
type SenderConfig struct {
	Clock                                                         Clock
	EstablishReply, NakRetryDelay, ContentionDefer, TransferReply time.Duration
	InterruptBackoff, OutboundRetryCycle                          time.Duration
	MaxFrameSends, MaxEstablishAttempts, MaxOutboundCycles        int
}

// Sender is the ASTM E1381 sender for one instrument link.
type Sender struct {
	cfg      SenderConfig
	state    SendState
	result   SendResult
	frames   [][]byte
	idx      int // frame being sent
	sends    int // sends of frames[idx]
	attempts int // ENQs sent in this cycle
	cycles   int
	deadline time.Time // timer of the current state
	notUntil time.Time // Neutral: no ENQ before this
}

// NewSender returns an idle Sender; zero config values take the TRD defaults.
func NewSender(cfg SenderConfig) *Sender {
	d := func(v *time.Duration, def time.Duration) {
		if *v <= 0 {
			*v = def
		}
	}
	n := func(v *int, def int) {
		if *v <= 0 {
			*v = def
		}
	}
	d(&cfg.EstablishReply, defEstablishReply)
	d(&cfg.NakRetryDelay, defNakRetryDelay)
	d(&cfg.ContentionDefer, defContentionDefer)
	d(&cfg.TransferReply, defTransferReply)
	d(&cfg.InterruptBackoff, defInterruptBackoff)
	d(&cfg.OutboundRetryCycle, defOutboundRetryCycle)
	n(&cfg.MaxFrameSends, defMaxFrameSends)
	n(&cfg.MaxEstablishAttempts, defMaxEstablish)
	n(&cfg.MaxOutboundCycles, defMaxOutboundCycles)
	return &Sender{cfg: cfg}
}

func (s *Sender) State() SendState   { return s.state }
func (s *Sender) Result() SendResult { return s.result }
func (s *Sender) Cycles() int        { return s.cycles }

func (s *Sender) now() time.Time { return s.cfg.Clock.Now().UTC() }

// Submit retains one outbound message (records incl. trailing CR; the input is copied) and encodes its frames.
// It fails for no/empty records or while a message is still retained.
func (s *Sender) Submit(records [][]byte) error {
	if s.frames != nil {
		return errors.New("astm: outbound message already retained")
	}
	if len(records) == 0 {
		return errArg
	}
	cp := make([][]byte, len(records))
	for i, r := range records {
		cp[i] = append([]byte(nil), r...)
	}
	frames, _, err := EncodeRecords(cp, 1)
	if err != nil {
		return err
	}
	*s = Sender{cfg: s.cfg, frames: frames}
	return nil
}

// Tick applies timers and starts establishing for a retained message. Idempotent; returns bytes to write.
func (s *Sender) Tick() []byte {
	now := s.now()
	switch s.state {
	case SendEstablishing, SendTransfer:
		if now.Before(s.deadline) {
			return nil
		}
		s.endCycle(now)
		return []byte{EOT}
	case SendNakWait, SendDeferred:
		if now.Before(s.deadline) {
			return nil
		}
		return s.establish(now)
	}
	if s.frames == nil || now.Before(s.notUntil) {
		return nil
	}
	return s.establish(now)
}

// establish sends ENQ, or ends the cycle (no bytes) when the attempts are used up.
func (s *Sender) establish(now time.Time) []byte {
	if s.attempts >= s.cfg.MaxEstablishAttempts {
		s.endCycle(now)
		return nil
	}
	s.attempts++
	s.state, s.deadline = SendEstablishing, now.Add(s.cfg.EstablishReply)
	return []byte{ENQ}
}

// endCycle: the message stays retained for a new cycle from frame 1, or fails after max_outbound_cycles.
func (s *Sender) endCycle(now time.Time) {
	s.state, s.attempts, s.idx, s.sends = SendNeutral, 0, 0, 0
	s.cycles++
	if s.cycles >= s.cfg.MaxOutboundCycles {
		s.frames, s.result = nil, ResultFailed
		return
	}
	s.notUntil = now.Add(s.cfg.OutboundRetryCycle)
}

// Feed handles one line event and returns bytes to write.
func (s *Sender) Feed(b []byte) []byte {
	if len(b) == 0 {
		return nil
	}
	now := s.now()
	switch s.state {
	case SendDeferred: // the instrument's message is the Receiver's business; its EOT ends the deferral
		if b[len(b)-1] == EOT {
			s.state, s.notUntil = SendNeutral, now
		}
	case SendEstablishing:
		switch b[0] {
		case ACK:
			s.state, s.idx, s.sends, s.deadline = SendTransfer, 0, 1, now.Add(s.cfg.TransferReply)
			return append([]byte(nil), s.frames[0]...)
		case NAK:
			s.state, s.deadline = SendNakWait, now.Add(s.cfg.NakRetryDelay)
		case ENQ: // contention: the instrument wins
			s.state, s.deadline = SendDeferred, now.Add(s.cfg.ContentionDefer)
			return []byte{ACK}
		}
	case SendTransfer:
		switch b[0] {
		case ACK:
			s.idx++
			if s.idx >= len(s.frames) {
				s.state, s.frames, s.result = SendNeutral, nil, ResultSent
				return []byte{EOT}
			}
			s.sends, s.deadline = 1, now.Add(s.cfg.TransferReply)
			return append([]byte(nil), s.frames[s.idx]...)
		case EOT: // receiver interrupt: keep the message, restart from frame 1 after the backoff
			s.state, s.attempts, s.idx, s.sends = SendNeutral, 0, 0, 0
			s.notUntil = now.Add(s.cfg.InterruptBackoff)
			return []byte{EOT}
		}
		// NAK or any other character: resend, up to max_frame_sends
		if s.sends >= s.cfg.MaxFrameSends {
			s.endCycle(now)
			return []byte{EOT}
		}
		s.sends++
		s.deadline = now.Add(s.cfg.TransferReply)
		return append([]byte(nil), s.frames[s.idx]...)
	}
	return nil
}
