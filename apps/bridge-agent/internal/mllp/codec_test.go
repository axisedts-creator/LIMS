// AG-T07 tests: MLLP codec (02-TRD §5.4, 03-APP-FLOW §3.3 receiver). AC-07.1, AC-07.5.
//
// Contract expected from package mllp:
//
//	const (SB = 0x0B; EB = 0x1C; CR = 0x0D)
//	const DefaultMaxMessageBytes = 1 << 20
//	const (ReasonNewStartBlock = "new_start_block"; ReasonMSHUnparseable = "msh_unparseable")
//	var ErrOversize error
//	type Stats struct{...}                     // zero value usable, safe for concurrent use
//	func (s *Stats) DiscardedBytes() int64     // mllp_discarded_bytes
//	func (s *Stats) Incomplete() int64
//	func (s *Stats) Oversize() int64           // mllp_oversize
//	func Encode(msg []byte) []byte             // SB + msg + EB + CR
//	type Kind int; const (KindMessage Kind = iota + 1; KindIncomplete)
//	type Event struct { Kind Kind; Data []byte; Reason string }  // Reason set for KindIncomplete
//	func NewReader(r io.Reader, maxMessageBytes int, st *Stats) *Reader // max<=0 → DefaultMaxMessageBytes
//	func (r *Reader) Next() (Event, error) // io.EOF at end of stream; ErrOversize when a block exceeds max (message bytes, framing excluded)
package mllp_test

import (
	"bytes"
	"errors"
	"io"
	"math/rand"
	"testing"
	"testing/iotest"

	"lims/apps/bridge-agent/internal/mllp"
)

func blk(msg string) []byte { return append(append([]byte{0x0B}, msg...), 0x1C, 0x0D) }

func collect(t *testing.T, r io.Reader, max int, st *mllp.Stats) ([]mllp.Event, error) {
	t.Helper()
	rd := mllp.NewReader(r, max, st)
	var evs []mllp.Event
	for i := 0; i < 100000; i++ {
		ev, err := rd.Next()
		if err != nil {
			return evs, err
		}
		evs = append(evs, ev)
	}
	t.Fatal("reader did not terminate")
	return nil, nil
}

func TestConstants(t *testing.T) {
	if mllp.DefaultMaxMessageBytes != 1<<20 {
		t.Errorf("DefaultMaxMessageBytes = %d, want 1 MiB", mllp.DefaultMaxMessageBytes)
	}
	if mllp.ReasonNewStartBlock != "new_start_block" || mllp.ReasonMSHUnparseable != "msh_unparseable" {
		t.Error("reason strings differ from spec")
	}
}

func TestEncode(t *testing.T) {
	got := mllp.Encode([]byte("MSH|x\r"))
	if !bytes.Equal(got, []byte("\x0bMSH|x\r\x1c\x0d")) {
		t.Errorf("got %q", got)
	}
}

// AC-07.1: exactly <message> is extracted.
func TestExtractsExactMessage(t *testing.T) {
	st := &mllp.Stats{}
	evs, err := collect(t, bytes.NewReader(blk("MSH|^~\\&|A\rPID|1\r")), 0, st)
	if err != io.EOF {
		t.Fatalf("err = %v, want io.EOF", err)
	}
	if len(evs) != 1 || evs[0].Kind != mllp.KindMessage || string(evs[0].Data) != "MSH|^~\\&|A\rPID|1\r" {
		t.Fatalf("events = %+v", evs)
	}
	if st.DiscardedBytes() != 0 || st.Incomplete() != 0 || st.Oversize() != 0 {
		t.Errorf("counters not zero: %d %d %d", st.DiscardedBytes(), st.Incomplete(), st.Oversize())
	}
}

// AC-07.1: bytes before 0x0B are discarded and counted (also between blocks).
func TestGarbageBeforeStartBlockDiscardedAndCounted(t *testing.T) {
	st := &mllp.Stats{}
	in := append([]byte("junk\r\n"), blk("ONE")...)
	in = append(in, "xy"...)
	in = append(in, blk("TWO")...)
	in = append(in, 0x1C, 0x0D, 'z') // stray terminator outside a block is also garbage
	evs, err := collect(t, bytes.NewReader(in), 0, st)
	if err != io.EOF {
		t.Fatalf("err = %v", err)
	}
	if len(evs) != 2 || string(evs[0].Data) != "ONE" || string(evs[1].Data) != "TWO" {
		t.Fatalf("events = %+v", evs)
	}
	if got, want := st.DiscardedBytes(), int64(6+2+3); got != want {
		t.Errorf("DiscardedBytes = %d, want %d", got, want)
	}
}

func TestBackToBackMessagesInOneRead(t *testing.T) {
	in := append(blk("A"), blk("BB")...)
	in = append(in, blk("CCC")...)
	evs, _ := collect(t, bytes.NewReader(in), 0, &mllp.Stats{})
	if len(evs) != 3 || string(evs[0].Data) != "A" || string(evs[1].Data) != "BB" || string(evs[2].Data) != "CCC" {
		t.Fatalf("events = %+v", evs)
	}
}

// Split delivery must not change the result (TCP segmentation).
func TestOneByteAtATimeEqualsWholeBuffer(t *testing.T) {
	in := append([]byte("zz"), blk("MSH|1\rPID|2\r")...)
	in = append(in, 0x0B, 'P', 'A', 'R', 'T') // partial, then a new start
	in = append(in, blk("MSH|3\r")...)
	in = append(in, 0x0B, 'T', 'A', 'I', 'L') // partial at EOF

	stA, stB := &mllp.Stats{}, &mllp.Stats{}
	a, errA := collect(t, bytes.NewReader(in), 0, stA)
	b, errB := collect(t, iotest.OneByteReader(bytes.NewReader(in)), 0, stB)
	if errA != io.EOF || errB != io.EOF {
		t.Fatalf("errs = %v / %v", errA, errB)
	}
	if len(a) != len(b) {
		t.Fatalf("len %d vs %d", len(a), len(b))
	}
	for i := range a {
		if a[i].Kind != b[i].Kind || !bytes.Equal(a[i].Data, b[i].Data) || a[i].Reason != b[i].Reason {
			t.Errorf("event %d differs: %+v vs %+v", i, a[i], b[i])
		}
	}
	if stA.DiscardedBytes() != stB.DiscardedBytes() || stA.Incomplete() != stB.Incomplete() {
		t.Errorf("counters differ")
	}
}

// 03-APP-FLOW §3.3: InBlock rx 0x0B → previous partial becomes incomplete(new_start_block), buffer restarts.
func TestNewStartBlockInsideBlock(t *testing.T) {
	st := &mllp.Stats{}
	in := append([]byte("\x0bPARTIAL"), blk("GOOD")...)
	evs, err := collect(t, bytes.NewReader(in), 0, st)
	if err != io.EOF {
		t.Fatal(err)
	}
	if len(evs) != 2 {
		t.Fatalf("events = %+v", evs)
	}
	if evs[0].Kind != mllp.KindIncomplete || evs[0].Reason != mllp.ReasonNewStartBlock || string(evs[0].Data) != "PARTIAL" {
		t.Errorf("first = %+v", evs[0])
	}
	if evs[1].Kind != mllp.KindMessage || string(evs[1].Data) != "GOOD" {
		t.Errorf("second = %+v", evs[1])
	}
	if st.Incomplete() != 1 {
		t.Errorf("Incomplete = %d", st.Incomplete())
	}
}

// §3.3 "Connection closed mid-block → partial stored as incomplete".
func TestEOFMidBlockIsIncomplete(t *testing.T) {
	st := &mllp.Stats{}
	evs, err := collect(t, bytes.NewReader([]byte("\x0bMSH|^~\\&|A|B")), 0, st)
	if err != io.EOF {
		t.Fatalf("err = %v", err)
	}
	if len(evs) != 1 || evs[0].Kind != mllp.KindIncomplete || evs[0].Reason != "" || string(evs[0].Data) != "MSH|^~\\&|A|B" {
		t.Fatalf("events = %+v", evs)
	}
	if st.Incomplete() != 1 {
		t.Errorf("Incomplete = %d", st.Incomplete())
	}
}

func TestEOFOutsideBlockIsPlainEOF(t *testing.T) {
	st := &mllp.Stats{}
	evs, err := collect(t, bytes.NewReader([]byte("noise")), 0, st)
	if err != io.EOF || len(evs) != 0 {
		t.Fatalf("evs=%+v err=%v", evs, err)
	}
	if st.DiscardedBytes() != 5 {
		t.Errorf("DiscardedBytes = %d", st.DiscardedBytes())
	}
}

// §3.3 SawFS: 0x1C followed by a byte other than 0x0D is literal content.
func TestFSNotFollowedByCRIsLiteral(t *testing.T) {
	evs, err := collect(t, bytes.NewReader(blk("AB\x1cCD")), 0, &mllp.Stats{})
	if err != io.EOF || len(evs) != 1 || string(evs[0].Data) != "AB\x1cCD" {
		t.Fatalf("evs=%+v err=%v", evs, err)
	}
}

// AC-07.5: message > max → ErrOversize (caller resets the connection), counter increments; max itself is allowed.
func TestOversizeBoundary(t *testing.T) {
	const max = 64
	okMsg := string(bytes.Repeat([]byte("a"), max))
	st := &mllp.Stats{}
	evs, err := collect(t, bytes.NewReader(blk(okMsg)), max, st)
	if err != io.EOF || len(evs) != 1 || string(evs[0].Data) != okMsg || st.Oversize() != 0 {
		t.Fatalf("at-limit: evs=%d err=%v oversize=%d", len(evs), err, st.Oversize())
	}

	st = &mllp.Stats{}
	evs, err = collect(t, bytes.NewReader(blk(okMsg+"b")), max, st)
	if !errors.Is(err, mllp.ErrOversize) {
		t.Fatalf("over-limit err = %v, want ErrOversize", err)
	}
	for _, e := range evs {
		if e.Kind == mllp.KindMessage {
			t.Errorf("oversize message must not be delivered: %+v", e)
		}
	}
	if st.Oversize() != 1 {
		t.Errorf("Oversize = %d, want 1", st.Oversize())
	}
}

func TestOversizeWithoutTerminatorStillDetected(t *testing.T) {
	// A hostile peer never sends 0x1C: memory must stay bounded and the error must surface.
	st := &mllp.Stats{}
	in := append([]byte{0x0B}, bytes.Repeat([]byte("x"), 10000)...)
	_, err := collect(t, bytes.NewReader(in), 100, st)
	if !errors.Is(err, mllp.ErrOversize) || st.Oversize() != 1 {
		t.Fatalf("err=%v oversize=%d", err, st.Oversize())
	}
}

func TestDefaultMaxIsOneMiB(t *testing.T) {
	at := bytes.Repeat([]byte("a"), 1<<20)
	evs, err := collect(t, bytes.NewReader(blk(string(at))), 0, &mllp.Stats{})
	if err != io.EOF || len(evs) != 1 || len(evs[0].Data) != 1<<20 {
		t.Fatalf("1 MiB exactly must pass: err=%v n=%d", err, len(evs))
	}
	_, err = collect(t, bytes.NewReader(blk(string(at)+"a")), 0, &mllp.Stats{})
	if !errors.Is(err, mllp.ErrOversize) {
		t.Fatalf("1 MiB + 1 must be oversize, err = %v", err)
	}
}

func TestEncodeRoundTrip(t *testing.T) {
	msg := "MSH|^~\\&|A|B|C|D|2026||ORU^R01|ID1|P|2.5\rOBX|1|NM|GLU||5.4\r"
	evs, err := collect(t, bytes.NewReader(mllp.Encode([]byte(msg))), 0, &mllp.Stats{})
	if err != io.EOF || len(evs) != 1 || string(evs[0].Data) != msg {
		t.Fatalf("evs=%+v err=%v", evs, err)
	}
}

// Security (AB9): random hostile streams never panic, never loop forever, never exceed max, never invent bytes.
func TestRandomStreamsInvariants(t *testing.T) {
	const max = 48
	rng := rand.New(rand.NewSource(7))
	alphabet := []byte{0x0B, 0x0B, 0x1C, 0x1C, 0x0D, 0x0D, 'M', 'S', 'H', '|', '\r', 0x00, 0xFF}
	for i := 0; i < 3000; i++ {
		n := rng.Intn(300)
		in := make([]byte, n)
		for j := range in {
			if rng.Intn(4) == 0 {
				in[j] = byte(rng.Intn(256))
			} else {
				in[j] = alphabet[rng.Intn(len(alphabet))]
			}
		}
		checkInvariants(t, in, max)
	}
}

func FuzzReader(f *testing.F) {
	f.Add(blk("MSH|^~\\&|A"))
	f.Add([]byte("\x0bA\x0bB\x1c\x0d"))
	f.Add([]byte("\x1c\x0d\x0b\x1c\x1c\x0d"))
	f.Add(bytes.Repeat([]byte{0x0B}, 100))
	f.Fuzz(func(t *testing.T, in []byte) { checkInvariants(t, in, 48) })
}

func checkInvariants(t *testing.T, in []byte, max int) {
	t.Helper()
	st := &mllp.Stats{}
	rd := mllp.NewReader(bytes.NewReader(in), max, st)
	total := int64(0)
	for steps := 0; ; steps++ {
		if steps > len(in)+5 {
			t.Fatalf("reader made no progress on %q", in)
		}
		ev, err := rd.Next()
		if err != nil {
			if err != io.EOF && !errors.Is(err, mllp.ErrOversize) {
				t.Fatalf("unexpected error %v on %q", err, in)
			}
			break
		}
		if len(ev.Data) > max {
			t.Fatalf("event larger than max (%d) on %q", len(ev.Data), in)
		}
		total += int64(len(ev.Data))
	}
	if total+st.DiscardedBytes() > int64(len(in)) {
		t.Fatalf("accounted %d+%d bytes from only %d input bytes", total, st.DiscardedBytes(), len(in))
	}
}
