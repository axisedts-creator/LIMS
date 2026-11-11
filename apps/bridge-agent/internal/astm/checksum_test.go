// AG-T03 tests: ASTM E1381 checksum + golden vectors (02-TRD §5.2.2, §5.2.6).
// Shared vector file: apps/bridge-agent/__tests__/astm-vectors.json (also read by the TS server tests).
package astm_test

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"strings"
	"testing"

	"lims/apps/bridge-agent/internal/astm"
)

type vectorFrame struct {
	FN         int    `json:"fn"`
	Text       string `json:"text"`
	Terminator string `json:"terminator"`
	Checksum   string `json:"checksum"`
}

type vectorFile struct {
	Frames       []vectorFrame `json:"frames"`
	AssembledN   int           `json:"assembled_from_first_n_frames"`
	AssembledSHA string        `json:"assembled_sha256"`
}

func loadVectors(t *testing.T) vectorFile {
	t.Helper()
	b, err := os.ReadFile("../../__tests__/astm-vectors.json")
	if err != nil {
		t.Fatalf("shared vector file missing: %v", err)
	}
	var v vectorFile
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatalf("vector file invalid JSON: %v", err)
	}
	if len(v.Frames) != 6 {
		t.Fatalf("TRD §5.2.6 has 6 vectors, file has %d", len(v.Frames))
	}
	return v
}

func term(t *testing.T, name string) byte {
	t.Helper()
	switch name {
	case "ETX":
		return astm.ETX
	case "ETB":
		return astm.ETB
	}
	t.Fatalf("bad terminator %q in vector file", name)
	return 0
}

func TestControlCharacterValues(t *testing.T) { // TRD §5.2.1
	for name, got := range map[string]struct{ got, want byte }{
		"STX": {astm.STX, 0x02}, "ETX": {astm.ETX, 0x03}, "ETB": {astm.ETB, 0x17},
		"ENQ": {astm.ENQ, 0x05}, "ACK": {astm.ACK, 0x06}, "NAK": {astm.NAK, 0x15},
		"EOT": {astm.EOT, 0x04},
	} {
		if got.got != got.want {
			t.Errorf("%s = %#x, want %#x", name, got.got, got.want)
		}
	}
}

func TestChecksumGoldenVectors(t *testing.T) { // done_when: §5.2.6 vectors pass
	for _, f := range loadVectors(t).Frames {
		got := astm.Checksum(f.FN, []byte(f.Text), term(t, f.Terminator))
		if got != f.Checksum {
			t.Errorf("FN %d: checksum %q, want %q", f.FN, got, f.Checksum)
		}
	}
}

func TestChecksumIsUppercaseTwoCharHex(t *testing.T) {
	// text chosen so the sum mod 256 is 0x0A..0x0F range digits -> must be "0A" not "a" / "0a".
	for fn := 0; fn < 8; fn++ {
		for _, text := range []string{"", "x", strings.Repeat("\xff", 240), "a\r"} {
			c := astm.Checksum(fn, []byte(text), astm.ETX)
			if len(c) != 2 || c != strings.ToUpper(c) {
				t.Fatalf("checksum %q not two uppercase chars", c)
			}
			if _, err := hex.DecodeString(c); err != nil {
				t.Fatalf("checksum %q not hex: %v", c, err)
			}
		}
	}
	// FN '0'(0x30)+ETX(0x03) = 0x33 -> "33"; add 'x'(0x78) = 0xAB.
	if got := astm.Checksum(0, []byte("x"), astm.ETX); got != "AB" {
		t.Errorf("Checksum(0,\"x\",ETX) = %q, want AB", got)
	}
}

func TestChecksumWrapsModulo256(t *testing.T) {
	text := bytes.Repeat([]byte{0xFF}, 240)
	sum := int('3') + 240*0xFF + int(astm.ETX)
	want := strings.ToUpper(hex.EncodeToString([]byte{byte(sum % 256)}))
	if got := astm.Checksum(3, text, astm.ETX); got != want {
		t.Errorf("got %q want %q", got, want)
	}
}

func TestChecksumExcludesSTXAndChecksumAndCRLF(t *testing.T) {
	// Independent recomputation over FN+text+terminator only.
	f := loadVectors(t).Frames[0]
	text := []byte(f.Text)
	sum := int('0'+byte(f.FN)) + int(astm.ETX)
	for _, b := range text {
		sum += int(b)
	}
	if want := strings.ToUpper(hex.EncodeToString([]byte{byte(sum)})); astm.Checksum(f.FN, text, astm.ETX) != want {
		t.Fatal("checksum must cover FN, text and terminator only")
	}
}

func TestChecksumTerminatorMatters(t *testing.T) {
	a := astm.Checksum(1, []byte("P|1\r"), astm.ETX)
	b := astm.Checksum(1, []byte("P|1\r"), astm.ETB)
	if a == b {
		t.Fatal("ETX and ETB must produce different checksums")
	}
}

func TestAssembledSHA256GoldenVector(t *testing.T) { // AC-05.5
	v := loadVectors(t)
	var frames []astm.Frame
	for _, f := range v.Frames[:v.AssembledN] {
		raw, err := astm.EncodeFrame(f.FN, []byte(f.Text), term(t, f.Terminator))
		if err != nil {
			t.Fatalf("EncodeFrame FN %d: %v", f.FN, err)
		}
		fr, err := astm.DecodeFrame(raw)
		if err != nil {
			t.Fatalf("DecodeFrame FN %d: %v", f.FN, err)
		}
		frames = append(frames, fr)
	}
	raw := astm.Assemble(frames)
	var want bytes.Buffer
	for _, f := range v.Frames[:v.AssembledN] {
		want.WriteString(f.Text)
	}
	if !bytes.Equal(raw, want.Bytes()) {
		t.Fatalf("Assemble must be the plain concatenation of frame texts (no STX/FN/terminator/checksum/CRLF)")
	}
	sum := sha256.Sum256(raw)
	if got := hex.EncodeToString(sum[:]); got != v.AssembledSHA {
		t.Errorf("raw_sha256 = %s, want %s", got, v.AssembledSHA)
	}
	if v.AssembledSHA != "56ebd538f73ae63fd6cdc8ffc3bc2e4c948482e9570b7146c20f6c7878d0baaf" {
		t.Error("vector file sha drifted from TRD §5.2.6")
	}
}

func TestAssembleEmpty(t *testing.T) {
	if got := astm.Assemble(nil); len(got) != 0 {
		t.Errorf("Assemble(nil) = %q, want empty", got)
	}
}
