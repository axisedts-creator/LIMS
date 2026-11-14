// Package mllp implements the MLLP receiver: stream → messages (codec.go) and the per-connection
// session that persists, then ACKs (session.go). State machine: 03-APP-FLOW §3.3, rules: 02-TRD §5.4.
package mllp

import (
	"bufio"
	"errors"
	"io"
	"sync/atomic"
)

const (
	SB = 0x0B // start block
	EB = 0x1C // end block (followed by CR)
	CR = 0x0D
)

// DefaultMaxMessageBytes is max_message_bytes [CONV]; the limit applies to message bytes, framing excluded.
const DefaultMaxMessageBytes = 1 << 20

const (
	ReasonNewStartBlock  = "new_start_block"
	ReasonMSHUnparseable = "msh_unparseable"
)

// ErrOversize: a block exceeded the maximum; the caller must reset the connection.
var ErrOversize = errors.New("mllp: message exceeds max_message_bytes")

// Stats are the link counters; zero value is usable and safe for concurrent use.
type Stats struct {
	discarded, incomplete, oversize atomic.Int64
	replyAckTimeouts, replyAckMism  atomic.Int64
}

func (s *Stats) DiscardedBytes() int64 { return s.discarded.Load() } // mllp_discarded_bytes
func (s *Stats) Incomplete() int64     { return s.incomplete.Load() }
func (s *Stats) Oversize() int64       { return s.oversize.Load() } // mllp_oversize

// ReplyAckTimeouts counts ACK waits that ended without an ACK (CR-C7-016).
func (s *Stats) ReplyAckTimeouts() int64 { return s.replyAckTimeouts.Load() }

// ReplyAckMismatches counts ACKs whose MSA-2 differed while ReplyAckMatchControlId=true.
func (s *Stats) ReplyAckMismatches() int64 { return s.replyAckMism.Load() }

// Encode frames msg as SB + msg + EB + CR.
func Encode(msg []byte) []byte {
	out := make([]byte, 0, len(msg)+3)
	out = append(out, SB)
	out = append(out, msg...)
	return append(out, EB, CR)
}

type Kind int

const (
	KindMessage Kind = iota + 1
	KindIncomplete
)

// Event is one complete message, or a partial one (Reason set, or empty for a mid-block close).
type Event struct {
	Kind   Kind
	Data   []byte
	Reason string
}

// Reader extracts MLLP blocks from a byte stream. Not safe for concurrent use.
type Reader struct {
	br      *bufio.Reader
	max     int
	st      *Stats
	buf     []byte
	inBlock bool
	sawFS   bool
	err     error // sticky: returned once pending events are drained
}

// NewReader: maxMessageBytes <= 0 → DefaultMaxMessageBytes; st may be nil.
func NewReader(r io.Reader, maxMessageBytes int, st *Stats) *Reader {
	if maxMessageBytes <= 0 {
		maxMessageBytes = DefaultMaxMessageBytes
	}
	if st == nil {
		st = &Stats{}
	}
	return &Reader{br: bufio.NewReader(r), max: maxMessageBytes, st: st}
}

// Next returns the next event. io.EOF (or the read error) ends the stream, after a final
// incomplete event with empty Reason (E04 has no enum value for a mid-block close) if a block was open. ErrOversize is sticky.
func (r *Reader) Next() (Event, error) {
	if r.err != nil {
		return Event{}, r.err
	}
	for {
		b, err := r.br.ReadByte()
		if err != nil {
			r.err = err
			if r.inBlock {
				return r.incomplete("", true), nil
			}
			return Event{}, err
		}
		if !r.inBlock {
			if b == SB {
				r.start()
			} else {
				r.st.discarded.Add(1)
			}
			continue
		}
		if r.sawFS {
			r.sawFS = false
			switch b {
			case CR:
				ev := Event{Kind: KindMessage, Data: append([]byte(nil), r.buf...)}
				r.inBlock, r.buf = false, r.buf[:0]
				return ev, nil
			case EB: // 1C 1C: first is literal, second may still start a terminator [CONV]
				if !r.add(EB) {
					return Event{}, r.err
				}
				r.sawFS = true
				continue
			case SB: // 1C 0B: literal 1C, then a new start block [CONV]
				if !r.add(EB) {
					return Event{}, r.err
				}
				ev := r.incomplete(ReasonNewStartBlock, false)
				r.start()
				return ev, nil
			}
			if !r.add(EB) || !r.add(b) {
				return Event{}, r.err
			}
			continue
		}
		switch b {
		case EB:
			r.sawFS = true
		case SB:
			ev := r.incomplete(ReasonNewStartBlock, false)
			r.start()
			return ev, nil
		default:
			if !r.add(b) {
				return Event{}, r.err
			}
		}
	}
}

func (r *Reader) start() { r.inBlock, r.sawFS, r.buf = true, false, r.buf[:0] }

// add appends one message byte; false means oversize (r.err set, buffer dropped).
func (r *Reader) add(b byte) bool {
	if len(r.buf) >= r.max {
		r.st.oversize.Add(1)
		r.err, r.inBlock, r.buf = ErrOversize, false, nil
		return false
	}
	r.buf = append(r.buf, b)
	return true
}

// incomplete emits the partial block; closing=true when the stream ended (a pending EB is kept as literal).
func (r *Reader) incomplete(reason string, closing bool) Event {
	data := append([]byte(nil), r.buf...)
	if closing && r.sawFS && len(data) < r.max {
		data = append(data, EB)
	}
	r.st.incomplete.Add(1)
	r.inBlock, r.sawFS, r.buf = false, false, r.buf[:0]
	return Event{Kind: KindIncomplete, Data: data, Reason: reason}
}
