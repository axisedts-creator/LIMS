package mllp

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"lims/apps/bridge-agent/internal/hl7"
)

// Sink persists what the session receives.
type Sink interface {
	// CommitMessage must make raw durable BEFORE returning nil (D-02); an error → AR/CR, not received.
	CommitMessage(raw []byte, msh hl7.MSH) error
	// CommitIncomplete stores raw as an `incomplete` item; reason is a Reason* constant, or "" for a mid-block close (uploader omits it).
	CommitIncomplete(raw []byte, reason string) error
}

// Config for one receiver session; safe to share between connections.
type Config struct {
	Sink                              Sink
	MaxMessageBytes                   int    // 0 → DefaultMaxMessageBytes
	AckMode                           string // auto|original|enhanced|none ("" = auto)
	AckSendingApp, AckSendingFacility string
	AckTypeFormat                     string
	AckFullForm                       bool             // profile.HL7AckFullForm: the 09-ADDENDUM-GETEIN-METIS §6 ACK (MET-T01, LD-163)
	Now                               func() time.Time // default time.Now
	NewControlID                      func() string    // default: random 16 hex chars
	Stats                             *Stats           // default: private counters

	// Host query (CR-C7-016, 08-ADDENDUM-TRUTH-H80E §5-§7, lead decision LD-139). Zero values = today's behaviour.
	HostQueryTypes         []string      // MSH-9 values (exact match) classified as host queries (profile.HostQueryMessageTypes)
	HostQuery              HostQueryFunc // nil: no message is a host query
	ExpectAckOnReply       bool          // profile.ExpectAckOnReply; false = never wait for an ACK
	ReplyAckPolicy         string        // "" | "each": wait after every reply message; "last": after the final one only; "none": never
	ReplyAckMatchControlId bool          // true: the awaited ACK's MSA-2 must equal the MSH-10 of the reply it acknowledges
	ReplyTimeout           time.Duration // wait for the ACK; <= 0 → DefaultReplyTimeout (U per model, never hard-coded in a profile)
}

// DefaultReplyTimeout is the ACK wait when Config.ReplyTimeout is unset. U: unverified until a real capture (addendum §9 item 5).
const DefaultReplyTimeout = 10 * time.Second

// HostQueryFunc answers one committed host query: the reply messages in order, unframed. nil or empty means the API is
// unreachable: the agent then writes nothing at all (PRD AC-10.6, decision D-H80-1).
type HostQueryFunc func(raw []byte, msh hl7.MSH) [][]byte

type readResult struct {
	ev  Event
	err error
}

// pump reads the Reader in a goroutine so an ACK wait can time out without a conn deadline (Reader.err is sticky).
// At most one read is outstanding; a result that arrives after a timeout is handed to the next wait/loop turn.
type pump struct {
	rd *Reader
	ch chan readResult
}

// wait returns the next read result, or false if timeout fired first (nil timeout = wait forever).
func (p *pump) wait(timeout <-chan time.Time) (readResult, bool) {
	if p.ch == nil {
		ch := make(chan readResult, 1) // buffered: the goroutine ends even when Serve already returned (conn closed)
		p.ch = ch
		go func() { ev, err := p.rd.Next(); ch <- readResult{ev, err} }()
	}
	select {
	case r := <-p.ch:
		p.ch = nil
		return r, true
	case <-timeout:
		return readResult{}, false
	}
}

// Serve runs the receiver for one connection until EOF (nil), a hard error, or oversize
// (ErrOversize). It always closes conn. Order per message: parse MSH → commit → ACK (D-02).
func Serve(conn io.ReadWriteCloser, cfg Config) error {
	defer conn.Close()
	if cfg.Stats == nil {
		cfg.Stats = &Stats{}
	}
	now, newID := cfg.Now, cfg.NewControlID
	if now == nil {
		now = time.Now
	}
	if newID == nil {
		newID = randomControlID
	}
	pm := &pump{rd: NewReader(conn, cfg.MaxMessageBytes, cfg.Stats)}
	var held readResult // a message read while waiting for an ACK that was not that ACK
	var haveHeld bool
	for {
		var r readResult
		if haveHeld {
			r, haveHeld = held, false
		} else {
			r, _ = pm.wait(nil)
		}
		ev, err := r.ev, r.err
		if errors.Is(err, ErrOversize) {
			return err
		}
		if err != nil {
			// EOF or a peer reset/abort: the link ended, any open partial was already emitted as
			// incomplete (empty reason). Not a receiver fault. ponytail: read-error cause is dropped; add a logger hook if ops needs it.
			return nil
		}
		if ev.Kind == KindIncomplete {
			if err := commitIncomplete(cfg.Sink, ev.Data, ev.Reason); err != nil {
				return err
			}
			continue
		}
		msh, perr := hl7.ParseMSH(ev.Data)
		if perr != nil { // AC-07.4: cannot echo MSH-10 → no ACK, keep the bytes, keep the session
			cfg.Stats.incomplete.Add(1)
			if err := commitIncomplete(cfg.Sink, ev.Data, ReasonMSHUnparseable); err != nil {
				return err
			}
			continue
		}
		if cfg.HostQuery != nil {
			if isACK(msh) { // protocol, not data: a late ACK^Q03 (after a timeout) is neither committed nor ACKed
				continue
			}
			if inTypes(cfg.HostQueryTypes, msh.MessageType) {
				if cfg.Sink.CommitMessage(ev.Data, msh) != nil { // D-02: not durable → not received → no answer
					continue
				}
				// QCK/DSR are the answer: no HL7 ACK of its own. API unreachable (no replies) → silence (AC-10.6).
				var err error
				if held, haveHeld, err = answerHostQuery(conn, pm, cfg, cfg.HostQuery(ev.Data, msh)); err != nil {
					return err
				}
				continue
			}
		}
		committed := cfg.Sink.CommitMessage(ev.Data, msh) == nil
		code, send := hl7.AckCode(msh, cfg.AckMode, committed)
		if !send {
			continue
		}
		ack := hl7.BuildACK(msh, code, hl7.AckOptions{
			SendingApp: cfg.AckSendingApp, SendingFacility: cfg.AckSendingFacility,
			TypeFormat: cfg.AckTypeFormat, Now: now(), ControlID: newID(), FullForm: cfg.AckFullForm,
		})
		if _, err := conn.Write(Encode(ack)); err != nil {
			return fmt.Errorf("mllp: write ACK: %w", err)
		}
	}
}

// answerHostQuery writes the replies in order, waiting for ACKs per cfg.ReplyAckPolicy. A missing ACK (timeout) ends the
// exchange and is counted, not an error. A message that is not the awaited ACK is returned held for the main loop.
func answerHostQuery(conn io.Writer, pm *pump, cfg Config, replies [][]byte) (held readResult, have bool, err error) {
	for i, reply := range replies {
		if _, err := conn.Write(Encode(reply)); err != nil {
			return readResult{}, false, fmt.Errorf("mllp: write host-query reply: %w", err)
		}
		if !waitsAfter(cfg, i, len(replies)) {
			continue
		}
		var ok bool
		if held, have, ok = awaitACK(pm, cfg, reply); !ok {
			return held, have, nil
		}
	}
	return readResult{}, false, nil
}

func waitsAfter(cfg Config, i, n int) bool {
	if !cfg.ExpectAckOnReply {
		return false
	}
	switch cfg.ReplyAckPolicy {
	case "none":
		return false
	case "last":
		return i == n-1
	}
	return true // "" and "each": today's behaviour
}

// awaitACK consumes one ACK for reply. ok=false ends the exchange (timeout, or something else arrived → returned held).
func awaitACK(pm *pump, cfg Config, reply []byte) (held readResult, have, ok bool) {
	d := cfg.ReplyTimeout
	if d <= 0 {
		d = DefaultReplyTimeout
	}
	t := time.NewTimer(d)
	defer t.Stop()
	r, got := pm.wait(t.C)
	if !got {
		cfg.Stats.replyAckTimeouts.Add(1)
		return readResult{}, false, false
	}
	if r.err == nil && r.ev.Kind == KindMessage {
		if msh, perr := hl7.ParseMSH(r.ev.Data); perr == nil && isACK(msh) {
			if cfg.ReplyAckMatchControlId {
				if want, werr := hl7.ParseMSH(reply); werr != nil || msa2(r.ev.Data, msh.FieldSep) != want.ControlID {
					cfg.Stats.replyAckMism.Add(1)
				}
			}
			return readResult{}, false, true
		}
	}
	return r, true, false
}

func inTypes(types []string, t string) bool {
	for _, x := range types {
		if x == t {
			return true
		}
	}
	return false
}

// isACK: MSH-9 component 1 is ACK.
func isACK(m hl7.MSH) bool {
	sep := "^"
	if m.Encoding != "" {
		sep = m.Encoding[:1]
	}
	c, _, _ := strings.Cut(m.MessageType, sep)
	return c == "ACK"
}

// msa2 returns MSA-2 (the acknowledged control id) of the first MSA segment, or "".
func msa2(msg []byte, sep byte) string {
	for _, seg := range strings.FieldsFunc(string(msg), func(r rune) bool { return r == '\r' || r == '\n' }) {
		if strings.HasPrefix(seg, "MSA"+string(sep)) {
			if f := strings.SplitN(seg, string(sep), 4); len(f) > 2 {
				return f[2]
			}
		}
	}
	return ""
}

// commitIncomplete skips empty partials (a bare 0x0B carries no bytes worth a queue item).
func commitIncomplete(s Sink, raw []byte, reason string) error {
	if len(raw) == 0 {
		return nil
	}
	return s.CommitIncomplete(raw, reason)
}

func randomControlID() string {
	var b [8]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}
