package astm

import (
	"errors"
	"strings"
)

const (
	maxText  = 240 // TRD §5.2.2
	maxFrame = 247
)

// Frame is one decoded E1381 frame.
type Frame struct {
	FN         int
	Text       []byte
	Terminator byte
	Checksum   string // uppercase
}

// Verdict is the receiver decision for a raw frame (TRD §5.2.3).
type Verdict int

const (
	Accept     Verdict = iota // ACK, append text
	Retransmit                // ACK, do not append
	Reject                    // NAK
)

var (
	errFrame = errors.New("astm: defective frame")
	errArg   = errors.New("astm: invalid frame argument")
)

// NextFN returns the frame number following fn (modulo 8).
func NextFN(fn int) int { return (fn + 1) % 8 }

// EncodeFrame builds STX FN text term C1 C2 CR LF.
func EncodeFrame(fn int, text []byte, term byte) ([]byte, error) {
	if fn < 0 || fn > 7 || len(text) > maxText || (term != ETX && term != ETB) {
		return nil, errArg
	}
	out := make([]byte, 0, len(text)+7)
	out = append(out, STX, byte('0'+fn))
	out = append(out, text...)
	out = append(out, term)
	out = append(out, Checksum(fn, text, term)...)
	return append(out, '\r', '\n'), nil
}

// DecodeFrame parses and fully validates a raw frame (structure, FN digit,
// terminator, checksum case-insensitively, CR LF, length ≤ 247).
func DecodeFrame(raw []byte) (Frame, error) {
	n := len(raw)
	if n < 7 || n > maxFrame || raw[0] != STX || raw[n-2] != '\r' || raw[n-1] != '\n' {
		return Frame{}, errFrame
	}
	if raw[1] < '0' || raw[1] > '7' {
		return Frame{}, errFrame
	}
	fn, term := int(raw[1]-'0'), raw[n-5]
	if term != ETX && term != ETB {
		return Frame{}, errFrame
	}
	text := raw[2 : n-5]
	got := strings.ToUpper(string(raw[n-4 : n-2]))
	if got != Checksum(fn, text, term) {
		return Frame{}, errFrame
	}
	return Frame{FN: fn, Text: append([]byte(nil), text...), Terminator: term, Checksum: got}, nil
}

// Receive applies TRD §5.2.3: prevFN is the previous accepted FN (-1 = none).
// A Reject returns the zero Frame.
func Receive(raw []byte, expectedFN, prevFN int) (Frame, Verdict) {
	f, err := DecodeFrame(raw)
	if err != nil {
		return Frame{}, Reject
	}
	switch {
	case f.FN == expectedFN:
		return f, Accept
	case prevFN >= 0 && f.FN == prevFN:
		return f, Retransmit
	}
	return Frame{}, Reject
}

// EncodeRecords frames each record separately (never mixing records in one
// frame), splitting records > 240 bytes into ETB… ETX frames. Returns the
// frames and the FN that follows the last one.
func EncodeRecords(records [][]byte, startFN int) ([][]byte, int, error) {
	if startFN < 0 || startFN > 7 {
		return nil, 0, errArg
	}
	var frames [][]byte
	fn := startFN
	for _, rec := range records {
		if len(rec) == 0 {
			return nil, 0, errArg
		}
		for len(rec) > 0 {
			chunk, term := rec, ETX
			if len(rec) > maxText {
				chunk, term = rec[:maxText], ETB
			}
			rec = rec[len(chunk):]
			f, err := EncodeFrame(fn, chunk, term)
			if err != nil {
				return nil, 0, err
			}
			frames = append(frames, f)
			fn = NextFN(fn)
		}
	}
	return frames, fn, nil
}

// Assemble concatenates accepted frame texts (TRD §5.2.7 "raw").
func Assemble(frames []Frame) []byte {
	var out []byte
	for _, f := range frames {
		out = append(out, f.Text...)
	}
	return out
}
