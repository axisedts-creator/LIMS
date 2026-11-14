// AG-T03 tests: frame encode/decode and receiver validation (02-TRD §5.2.2, §5.2.3). AC-05.3, AC-05.5.
package astm_test

import (
	"bytes"
	"strings"
	"testing"

	"lims/apps/bridge-agent/internal/astm"
)

// mk builds a raw frame with a correct checksum, independent of astm.EncodeFrame.
func mk(fn byte, text string, termB byte) []byte {
	sum := int(fn) + int(termB)
	for _, b := range []byte(text) {
		sum += int(b)
	}
	const hexd = "0123456789ABCDEF"
	s := sum % 256
	out := []byte{astm.STX, fn}
	out = append(out, text...)
	out = append(out, termB, hexd[s>>4], hexd[s&15], '\r', '\n')
	return out
}

func TestEncodeFrameGolden(t *testing.T) {
	for _, f := range loadVectors(t).Frames {
		got, err := astm.EncodeFrame(f.FN, []byte(f.Text), term(t, f.Terminator))
		if err != nil {
			t.Fatalf("FN %d: %v", f.FN, err)
		}
		want := []byte{astm.STX, byte('0' + f.FN)}
		want = append(want, f.Text...)
		want = append(want, term(t, f.Terminator))
		want = append(want, f.Checksum...)
		want = append(want, '\r', '\n')
		if !bytes.Equal(got, want) {
			t.Errorf("FN %d: got %q want %q", f.FN, got, want)
		}
	}
}

func TestEncodeDecodeRoundTrip(t *testing.T) {
	for _, f := range loadVectors(t).Frames {
		raw, _ := astm.EncodeFrame(f.FN, []byte(f.Text), term(t, f.Terminator))
		fr, err := astm.DecodeFrame(raw)
		if err != nil {
			t.Fatalf("FN %d: %v", f.FN, err)
		}
		if fr.FN != f.FN || string(fr.Text) != f.Text || fr.Terminator != term(t, f.Terminator) || fr.Checksum != f.Checksum {
			t.Errorf("FN %d round trip mismatch: %+v", f.FN, fr)
		}
	}
}

func TestEncodeFrameLimits(t *testing.T) { // text <= 240, whole frame <= 247
	ok := strings.Repeat("A", 240)
	raw, err := astm.EncodeFrame(1, []byte(ok), astm.ETX)
	if err != nil || len(raw) != 247 {
		t.Fatalf("240-char text must encode to 247 bytes, got len=%d err=%v", len(raw), err)
	}
	if _, err := astm.EncodeFrame(1, []byte(ok+"A"), astm.ETX); err == nil {
		t.Error("241-char text must be rejected")
	}
	for _, fn := range []int{-1, 8, 9, 100} {
		if _, err := astm.EncodeFrame(fn, []byte("x"), astm.ETX); err == nil {
			t.Errorf("FN %d must be rejected", fn)
		}
	}
	for _, tb := range []byte{0, 'X', astm.STX, astm.EOT} {
		if _, err := astm.EncodeFrame(1, []byte("x"), tb); err == nil {
			t.Errorf("terminator %#x must be rejected", tb)
		}
	}
}

func TestNextFNWrapsModulo8(t *testing.T) {
	want := map[int]int{0: 1, 1: 2, 6: 7, 7: 0}
	for in, out := range want {
		if got := astm.NextFN(in); got != out {
			t.Errorf("NextFN(%d) = %d, want %d", in, got, out)
		}
	}
}

func TestEncodeRecordsSplitsLongRecordETBThenETX(t *testing.T) { // §5.2.2 DECISION
	long := "R|1|" + strings.Repeat("x", 596) + "\r" // 601 bytes -> 240, 240, 121
	short := "L|1|N\r"
	frames, next, err := astm.EncodeRecords([][]byte{[]byte(long), []byte(short)}, 7)
	if err != nil {
		t.Fatal(err)
	}
	if len(frames) != 4 {
		t.Fatalf("want 4 frames (3 for long record + 1), got %d", len(frames))
	}
	wantFN := []int{7, 0, 1, 2}
	wantTerm := []byte{astm.ETB, astm.ETB, astm.ETX, astm.ETX}
	var joined []byte
	for i, raw := range frames {
		fr, err := astm.DecodeFrame(raw)
		if err != nil {
			t.Fatalf("frame %d: %v", i, err)
		}
		if fr.FN != wantFN[i] || fr.Terminator != wantTerm[i] {
			t.Errorf("frame %d: FN=%d term=%#x, want FN=%d term=%#x", i, fr.FN, fr.Terminator, wantFN[i], wantTerm[i])
		}
		if len(raw) > 247 || len(fr.Text) > 240 {
			t.Errorf("frame %d exceeds limits: len=%d text=%d", i, len(raw), len(fr.Text))
		}
		joined = append(joined, fr.Text...)
	}
	if string(joined) != long+short {
		t.Error("concatenated frame texts must equal the original records")
	}
	if next != 3 {
		t.Errorf("nextFN = %d, want 3", next)
	}
}

func TestEncodeRecordsNeverMixesRecordsInOneFrame(t *testing.T) {
	recs := [][]byte{[]byte("H|\\^&\r"), []byte("P|1\r"), []byte("L|1|N\r")}
	frames, _, err := astm.EncodeRecords(recs, 1)
	if err != nil || len(frames) != 3 {
		t.Fatalf("each record starts a new frame: frames=%d err=%v", len(frames), err)
	}
	for i, raw := range frames {
		fr, _ := astm.DecodeFrame(raw)
		if !bytes.Equal(fr.Text, recs[i]) || fr.Terminator != astm.ETX {
			t.Errorf("frame %d text/term wrong: %q %#x", i, fr.Text, fr.Terminator)
		}
	}
}

func TestEncodeRecordsExactly240IsSingleETXFrame(t *testing.T) {
	rec := []byte("R|" + strings.Repeat("y", 237) + "\r") // 240
	frames, _, err := astm.EncodeRecords([][]byte{rec}, 1)
	if err != nil || len(frames) != 1 {
		t.Fatalf("frames=%d err=%v", len(frames), err)
	}
	if fr, _ := astm.DecodeFrame(frames[0]); fr.Terminator != astm.ETX {
		t.Error("single-frame record must end with ETX")
	}
}

func TestEncodeRecordsRejectsBadStartFN(t *testing.T) {
	if _, _, err := astm.EncodeRecords([][]byte{[]byte("L|1|N\r")}, 8); err == nil {
		t.Error("startFN 8 must be rejected")
	}
}

// ---- Receiver validation (AC-05.3) ----

func TestReceiveAcceptsGoldenSequence(t *testing.T) {
	prev := -1
	for i, f := range loadVectors(t).Frames[:5] {
		exp := 1
		if prev >= 0 {
			exp = astm.NextFN(prev)
		}
		raw, _ := astm.EncodeFrame(f.FN, []byte(f.Text), term(t, f.Terminator))
		fr, v := astm.Receive(raw, exp, prev)
		if v != astm.Accept {
			t.Fatalf("frame %d: verdict %v, want Accept", i, v)
		}
		if fr.FN != exp {
			t.Fatalf("frame %d: FN %d want %d", i, fr.FN, exp)
		}
		prev = fr.FN
	}
}

func TestReceiveAC053Defects(t *testing.T) { // every defect -> NAK, nothing appended
	good := mk('1', "P|1\r", astm.ETX)
	cases := map[string][]byte{
		"wrong checksum":      []byte("\x021P|1\r\x033F\r\n"),
		"checksum off by one": []byte("\x021P|1\r\x033D\r\n"), // correct is 3E
		"unexpected FN":       mk('4', "P|1\r", astm.ETX),
		"FN 8":                mk('8', "P|1\r", astm.ETX),
		"FN 9":                mk('9', "P|1\r", astm.ETX),
		"FN non-digit":        mk('A', "P|1\r", astm.ETX),
		"missing CR LF":       good[:len(good)-2],
		"missing LF":          good[:len(good)-1],
		"CR only then junk":   append(append([]byte{}, good[:len(good)-1]...), 'X'),
		"LF CR swapped":       append(append([]byte{}, good[:len(good)-2]...), '\n', '\r'),
		"missing STX":         good[1:],
		"wrong leading byte":  append([]byte{astm.ETX}, good[1:]...),
		"bad terminator":      mk('1', "P|1\r", 'X'),
		"no terminator":       []byte("\x021P|1\r1C\r\n"),
		"trailing garbage":    append(append([]byte{}, good...), 'Z'),
		"empty":               {},
		"STX only":            {astm.STX},
		"STX FN only":         {astm.STX, '1'},
		"nil":                 nil,
	}
	for name, raw := range cases {
		fr, v := astm.Receive(raw, 1, -1)
		if v != astm.Reject {
			t.Errorf("%s: verdict %v, want Reject (NAK)", name, v)
		}
		if len(fr.Text) != 0 {
			t.Errorf("%s: rejected frame must not expose text", name)
		}
	}
	if _, v := astm.Receive(good, 1, -1); v != astm.Accept {
		t.Fatalf("control: the unmodified frame must be accepted, got %v", v)
	}
}

func TestReceiveFrameLengthBoundary247(t *testing.T) { // AC-05.3 "longer than 247"
	at := mk('1', strings.Repeat("A", 240), astm.ETX)   // 247
	over := mk('1', strings.Repeat("A", 241), astm.ETX) // 248, checksum still correct
	if len(at) != 247 || len(over) != 248 {
		t.Fatalf("test setup lengths %d/%d", len(at), len(over))
	}
	if _, v := astm.Receive(at, 1, -1); v != astm.Accept {
		t.Errorf("247-byte frame: %v, want Accept", v)
	}
	if _, v := astm.Receive(over, 1, -1); v != astm.Reject {
		t.Errorf("248-byte frame with valid checksum: %v, want Reject", v)
	}
	huge := mk('1', strings.Repeat("A", 1<<20), astm.ETX)
	if _, v := astm.Receive(huge, 1, -1); v != astm.Reject {
		t.Errorf("1 MiB frame: %v, want Reject", v)
	}
}

func TestReceiveRetransmissionIsAckedNotAppended(t *testing.T) { // §5.2.3
	raw := mk('3', "O|1|E2600000042||^^^GLU\r", astm.ETX)
	fr, v := astm.Receive(raw, 4, 3) // expected 4, previous accepted 3, frame is 3 again
	if v != astm.Retransmit {
		t.Fatalf("verdict %v, want Retransmit", v)
	}
	_ = fr
	// A retransmission with a bad checksum is still defective.
	bad := mk('3', "O|1|E2600000042||^^^GLU\r", astm.ETX)
	bad[len(bad)-4] ^= 1
	if _, v := astm.Receive(bad, 4, 3); v != astm.Reject {
		t.Errorf("corrupt retransmission: %v, want Reject", v)
	}
	// No previous frame (-1) means FN 1 is the only valid number; FN 0 is not a "retransmission".
	if _, v := astm.Receive(mk('0', "P|1\r", astm.ETX), 1, -1); v != astm.Reject {
		t.Errorf("FN 0 as first frame: %v, want Reject", v)
	}
	// Wrap: expected 0 after 7.
	if _, v := astm.Receive(mk('0', "P|1\r", astm.ETX), 0, 7); v != astm.Accept {
		t.Errorf("FN 0 after 7: want Accept")
	}
	if _, v := astm.Receive(mk('7', "P|1\r", astm.ETX), 0, 7); v != astm.Retransmit {
		t.Errorf("FN 7 repeated: want Retransmit")
	}
}

func TestReceiveChecksumCaseInsensitive(t *testing.T) { // §5.2.3 [CONV]
	raw := mk('1', "O|1|E2600000042||^^^GLU\r", astm.ETX) // checksum E8
	lower := bytes.ToLower(raw[len(raw)-4 : len(raw)-2])
	copy(raw[len(raw)-4:], lower)
	if _, v := astm.Receive(raw, 1, -1); v != astm.Accept {
		t.Errorf("lowercase checksum 'e8' must be accepted, got %v", v)
	}
	if _, v := astm.Receive([]byte("\x021P|1\r\x033e\r\n"), 1, -1); v != astm.Accept {
		t.Errorf("lowercase 3e must be accepted")
	}
}

func TestReceiveETBFrameAccepted(t *testing.T) {
	fr, v := astm.Receive(mk('1', "R|1|part", astm.ETB), 1, -1)
	if v != astm.Accept || fr.Terminator != astm.ETB {
		t.Errorf("ETB frame: verdict %v term %#x", v, fr.Terminator)
	}
}

func TestReceiveDoesNotPanicOnTruncationsAndMutations(t *testing.T) {
	good := mk('1', "R|1|^^^GLU|5.4|mmol/L||N||F\r", astm.ETX)
	for n := 0; n < len(good); n++ {
		if _, v := astm.Receive(good[:n], 1, -1); v == astm.Accept {
			t.Errorf("truncated to %d bytes was accepted", n)
		}
	}
	// Flip every single byte: no panic, and nothing but a still-valid case may be accepted.
	for i := range good {
		m := append([]byte{}, good...)
		m[i] ^= 0xFF
		_, v := astm.Receive(m, 1, -1)
		if v == astm.Accept {
			t.Errorf("mutation at byte %d was accepted", i)
		}
	}
}

func TestDecodeFrameRejectsDefects(t *testing.T) {
	for name, raw := range map[string][]byte{
		"bad checksum": []byte("\x021P|1\r\x033F\r\n"),
		"no crlf":      []byte("\x021P|1\r\x033F"),
		"too short":    {astm.STX, '1'},
		"over 247":     mk('1', strings.Repeat("A", 241), astm.ETX),
		"non-digit FN": mk('Z', "x", astm.ETX),
	} {
		if _, err := astm.DecodeFrame(raw); err == nil {
			t.Errorf("%s: DecodeFrame must return an error", name)
		}
	}
}

func TestDecodeFrameTextMayContainControlBytesExceptTerminatorSemantics(t *testing.T) {
	// text with embedded LF and high bytes (latin1) is carried unchanged.
	text := "R|1|\xb5g/L\n\r"
	fr, err := astm.DecodeFrame(mk('2', text, astm.ETX))
	if err != nil || string(fr.Text) != text {
		t.Fatalf("err=%v text=%q", err, fr.Text)
	}
}
