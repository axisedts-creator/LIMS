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

// endsWithL reports whether the last chunk is an L (terminator) record; the field delimiter comes from the H record.
func endsWithL(parts [][]byte) bool {
	if len(parts) == 0 {
		return false
	}
	delim := byte('|')
	if h := parts[0]; len(h) >= 2 && h[0] == 'H' {
		delim = h[1]
	}
	last := parts[len(parts)-1]
	return len(last) >= 1 && last[0] == 'L' && (len(last) == 1 || last[1] == delim || last[1] == '\r')
}
