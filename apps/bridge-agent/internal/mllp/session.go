package mllp

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
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
	Now                               func() time.Time // default time.Now
	NewControlID                      func() string    // default: random 16 hex chars
	Stats                             *Stats           // default: private counters
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
	rd := NewReader(conn, cfg.MaxMessageBytes, cfg.Stats)
	for {
		ev, err := rd.Next()
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
		committed := cfg.Sink.CommitMessage(ev.Data, msh) == nil
		code, send := hl7.AckCode(msh, cfg.AckMode, committed)
		if !send {
			continue
		}
		ack := hl7.BuildACK(msh, code, hl7.AckOptions{
			SendingApp: cfg.AckSendingApp, SendingFacility: cfg.AckSendingFacility,
			TypeFormat: cfg.AckTypeFormat, Now: now(), ControlID: newID(),
		})
		if _, err := conn.Write(Encode(ack)); err != nil {
			return fmt.Errorf("mllp: write ACK: %w", err)
		}
	}
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
