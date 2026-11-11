// AG-T07 session tests: MLLP receiver over real loopback TCP (03-APP-FLOW §3.3, 02-TRD §5.4, D-02).
// AC-07.1 .. AC-07.5 and the required simulator sessions "HL7 original and enhanced ACK", "MLLP garbage before start
// block", "oversize", "reused MSH-10" (02-TRD §15.3). Run: go test ./internal/mllp/... -run TestSessions
//
// Contract expected from package mllp (in addition to codec_test.go):
//
//	type Sink interface {
//	    // CommitMessage persists the raw message durably (queue item) BEFORE returning nil. An error → AR/CR, not received.
//	    CommitMessage(raw []byte, msh hl7.MSH) error
//	    // CommitIncomplete stores raw as an `incomplete` item; reason ∈ Reason* constants.
//	    CommitIncomplete(raw []byte, reason string) error
//	}
//	type Config struct {
//	    Sink                              Sink
//	    MaxMessageBytes                   int       // 0 → DefaultMaxMessageBytes
//	    AckMode                           string    // auto|original|enhanced|none ("" = auto)
//	    AckSendingApp, AckSendingFacility string
//	    AckTypeFormat                     string
//	    Now                               func() time.Time
//	    NewControlID                      func() string
//	    Stats                             *Stats
//	}
//	// Serve runs the receiver for one connection until EOF (returns nil), a hard error, or oversize
//	// (conn is closed, returns an error satisfying errors.Is(err, ErrOversize)). It writes ACK blocks to conn.
//	func Serve(conn io.ReadWriteCloser, cfg Config) error
package mllp_test

import (
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"io"
	"net"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"lims/apps/bridge-agent/internal/hl7"
	"lims/apps/bridge-agent/internal/mllp"
)

var fixedNow = time.Date(2026, 11, 11, 11, 42, 0, 0, time.UTC)

const (
	msgOrig = "MSH|^~\\&|ANALYZER|LAB|LIMS|AG-01|20261111110000||ORU^R01|MSG0001|P|2.5.1\rPID|1||E26000000001\rOBX|1|NM|GLU||5.4|mmol/L|||||F\r"
	msgEnh  = "MSH|^~\\&|ANALYZER|LAB|LIMS|AG-01|20261111110000||ORU^R01|MSG0002|P|2.5.1|||AL|NE\rPID|1||E26000000002\r"
)

type incomplete struct{ raw, reason string }

type fakeSink struct {
	mu      sync.Mutex
	msgs    []string
	mshs    []hl7.MSH
	inc     []incomplete
	calls   int
	fail    bool
	gate    chan struct{} // when non-nil, CommitMessage blocks until closed
	entered chan struct{} // signalled (non-blocking) when CommitMessage is entered
}

func (s *fakeSink) CommitMessage(raw []byte, m hl7.MSH) error {
	s.mu.Lock()
	s.calls++
	gate, entered, fail := s.gate, s.entered, s.fail
	s.mu.Unlock()
	if entered != nil {
		select {
		case entered <- struct{}{}:
		default:
		}
	}
	if gate != nil {
		<-gate
	}
	if fail {
		return errors.New("disk full")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.msgs = append(s.msgs, string(raw))
	s.mshs = append(s.mshs, m)
	return nil
}

func (s *fakeSink) CommitIncomplete(raw []byte, reason string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.inc = append(s.inc, incomplete{string(raw), reason})
	return nil
}

func (s *fakeSink) snapshot() (msgs []string, inc []incomplete, calls int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.msgs...), append([]incomplete(nil), s.inc...), s.calls
}

func newCfg(sink *fakeSink, st *mllp.Stats) mllp.Config {
	var n int64
	return mllp.Config{
		Sink: sink, MaxMessageBytes: 4096, AckMode: "auto",
		AckSendingApp: "LIMS", AckSendingFacility: "AG-01", AckTypeFormat: "ACK",
		Now:          func() time.Time { return fixedNow },
		NewControlID: func() string { return fmt.Sprintf("ACK%04d", atomic.AddInt64(&n, 1)) },
		Stats:        st,
	}
}

// serveOne listens on loopback, serves exactly one connection with cfg and returns the client side.
func serveOne(t *testing.T, cfg mllp.Config) (net.Conn, <-chan error) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	done := make(chan error, 1)
	go func() {
		c, err := ln.Accept()
		if err != nil {
			done <- err
			return
		}
		done <- mllp.Serve(c, cfg)
	}()
	cl, err := net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cl.Close() })
	return cl, done
}

func readACK(t *testing.T, c net.Conn) []byte {
	t.Helper()
	c.SetReadDeadline(time.Now().Add(3 * time.Second))
	br := bufio.NewReader(c)
	var out []byte
	for {
		b, err := br.ReadByte()
		if err != nil {
			t.Fatalf("reading ACK: %v (got %q)", err, out)
		}
		out = append(out, b)
		if len(out) >= 2 && out[len(out)-2] == 0x1C && out[len(out)-1] == 0x0D {
			break
		}
	}
	if out[0] != 0x0B {
		t.Fatalf("ACK block must start with 0x0B: %q", out)
	}
	return out[1 : len(out)-2]
}

// expectSilence asserts that no byte arrives within d and the connection is still open.
func expectSilence(t *testing.T, c net.Conn, d time.Duration) {
	t.Helper()
	c.SetReadDeadline(time.Now().Add(d))
	buf := make([]byte, 64)
	n, err := c.Read(buf)
	var ne net.Error
	if n > 0 || err == nil || !errors.As(err, &ne) || !ne.Timeout() {
		t.Fatalf("expected silence on open connection, got n=%d err=%v data=%q", n, err, buf[:n])
	}
}

// expectClosedWithoutData asserts the server closed/reset the connection and sent no data.
func expectClosedWithoutData(t *testing.T, c net.Conn) {
	t.Helper()
	c.SetReadDeadline(time.Now().Add(3 * time.Second))
	buf := make([]byte, 64)
	n, err := c.Read(buf)
	var ne net.Error
	if n > 0 {
		t.Fatalf("server sent %q before closing", buf[:n])
	}
	if err == nil || (errors.As(err, &ne) && ne.Timeout()) {
		t.Fatalf("expected closed connection, got err=%v", err)
	}
}

func waitServe(t *testing.T, done <-chan error) error {
	t.Helper()
	select {
	case err := <-done:
		return err
	case <-time.After(5 * time.Second):
		t.Fatal("Serve did not return")
		return nil
	}
}

func msa(t *testing.T, ack []byte) (code, ref string) {
	t.Helper()
	segs := strings.Split(strings.TrimSuffix(string(ack), "\r"), "\r")
	if len(segs) != 2 || !strings.HasPrefix(segs[0], "MSH|") || !strings.HasPrefix(segs[1], "MSA|") {
		t.Fatalf("ACK is not MSH+MSA: %q", ack)
	}
	f := strings.Split(segs[1], "|")
	if len(f) < 3 {
		t.Fatalf("short MSA: %q", segs[1])
	}
	return f[1], f[2]
}

// AC-07.2 + Sessions: original mode → AA, MSA-2 = MSH-10, exact ACK layout; message persisted unchanged.
func TestSessionsOriginalAck(t *testing.T) {
	sink, st := &fakeSink{}, &mllp.Stats{}
	c, done := serveOne(t, newCfg(sink, st))
	c.Write(mllp.Encode([]byte(msgOrig)))
	ack := readACK(t, c)
	want := "MSH|^~\\&|LIMS|AG-01|ANALYZER|LAB|20261111114200||ACK|ACK0001|P|2.5.1\rMSA|AA|MSG0001\r"
	if string(ack) != want {
		t.Errorf("ACK\n got %q\nwant %q", ack, want)
	}
	c.Close()
	if err := waitServe(t, done); err != nil {
		t.Fatal(err)
	}
	msgs, inc, _ := sink.snapshot()
	if len(msgs) != 1 || msgs[0] != msgOrig || len(inc) != 0 {
		t.Fatalf("msgs=%q inc=%v", msgs, inc)
	}
	if sink.mshs[0].ControlID != "MSG0001" {
		t.Errorf("sink got msh %+v", sink.mshs[0])
	}
}

// AC-07.3: enhanced mode (MSH-15 present) → CA.
func TestSessionsEnhancedAck(t *testing.T) {
	sink := &fakeSink{}
	c, _ := serveOne(t, newCfg(sink, &mllp.Stats{}))
	c.Write(mllp.Encode([]byte(msgEnh)))
	code, ref := msa(t, readACK(t, c))
	if code != "CA" || ref != "MSG0002" {
		t.Errorf("MSA = %s|%s, want CA|MSG0002", code, ref)
	}
}

// AC-07.3: cannot persist → AR (original) / CR (enhanced); not considered received (nothing stored, no retry loop).
func TestSessionsCommitFailure(t *testing.T) {
	for _, tc := range []struct{ name, msg, code, ref string }{
		{"original", msgOrig, "AR", "MSG0001"},
		{"enhanced", msgEnh, "CR", "MSG0002"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			sink := &fakeSink{fail: true}
			c, done := serveOne(t, newCfg(sink, &mllp.Stats{}))
			c.Write(mllp.Encode([]byte(tc.msg)))
			code, ref := msa(t, readACK(t, c))
			if code != tc.code || ref != tc.ref {
				t.Errorf("MSA = %s|%s, want %s|%s", code, ref, tc.code, tc.ref)
			}
			c.Close()
			waitServe(t, done)
			msgs, inc, calls := sink.snapshot()
			if len(msgs) != 0 || len(inc) != 0 || calls != 1 {
				t.Errorf("msgs=%v inc=%v calls=%d: failed message must not be stored and committed exactly once", msgs, inc, calls)
			}
		})
	}
}

// D-02 / AC-07.2: the ACK is written only AFTER the commit has completed.
func TestSessionsAckOnlyAfterCommit(t *testing.T) {
	sink := &fakeSink{gate: make(chan struct{}), entered: make(chan struct{}, 1)}
	c, _ := serveOne(t, newCfg(sink, &mllp.Stats{}))
	c.Write(mllp.Encode([]byte(msgOrig)))
	select {
	case <-sink.entered:
	case <-time.After(3 * time.Second):
		t.Fatal("CommitMessage never called")
	}
	expectSilence(t, c, 300*time.Millisecond) // commit still in flight → no ACK yet
	close(sink.gate)
	code, _ := msa(t, readACK(t, c))
	if code != "AA" {
		t.Errorf("code = %s", code)
	}
}

// ack_mode none: message is committed, no ACK is written.
func TestSessionsAckModeNone(t *testing.T) {
	sink := &fakeSink{}
	cfg := newCfg(sink, &mllp.Stats{})
	cfg.AckMode = "none"
	c, done := serveOne(t, cfg)
	c.Write(mllp.Encode([]byte(msgOrig)))
	expectSilence(t, c, 300*time.Millisecond)
	c.Close()
	waitServe(t, done)
	if msgs, _, _ := sink.snapshot(); len(msgs) != 1 {
		t.Errorf("msgs = %v", msgs)
	}
}

func TestSessionsAckTypeFormatTrigger(t *testing.T) {
	cfg := newCfg(&fakeSink{}, &mllp.Stats{})
	cfg.AckTypeFormat = "ACK^{trigger}^ACK"
	c, _ := serveOne(t, cfg)
	c.Write(mllp.Encode([]byte(msgOrig)))
	if ack := string(readACK(t, c)); !strings.Contains(ack, "||ACK^R01^ACK|ACK0001|") {
		t.Errorf("ACK = %q", ack)
	}
}

// AC-07.1: garbage before the start block is discarded and counted; the following message is still extracted and ACKed.
func TestSessionsGarbageBeforeStartBlock(t *testing.T) {
	sink, st := &fakeSink{}, &mllp.Stats{}
	c, done := serveOne(t, newCfg(sink, st))
	c.Write(append([]byte("\r\nnoise!"), mllp.Encode([]byte(msgOrig))...))
	if code, _ := msa(t, readACK(t, c)); code != "AA" {
		t.Errorf("code = %s", code)
	}
	c.Close()
	waitServe(t, done)
	if msgs, _, _ := sink.snapshot(); len(msgs) != 1 || msgs[0] != msgOrig {
		t.Errorf("msgs = %q", msgs)
	}
	if st.DiscardedBytes() != 8 {
		t.Errorf("DiscardedBytes = %d, want 8", st.DiscardedBytes())
	}
}

// Reused MSH-10: two messages with the same control id are both persisted and both ACKed (dedupe is server-side, D-12).
func TestSessionsReusedControlId(t *testing.T) {
	sink := &fakeSink{}
	c, done := serveOne(t, newCfg(sink, &mllp.Stats{}))
	for i := 0; i < 2; i++ {
		c.Write(mllp.Encode([]byte(msgOrig)))
		if code, ref := msa(t, readACK(t, c)); code != "AA" || ref != "MSG0001" {
			t.Fatalf("round %d: %s|%s", i, code, ref)
		}
	}
	c.Close()
	waitServe(t, done)
	if msgs, _, _ := sink.snapshot(); len(msgs) != 2 {
		t.Errorf("want 2 stored messages, got %d", len(msgs))
	}
}

// AC-07.4: MSH unparseable → no ACK, bytes stored as incomplete(msh_unparseable); the session continues.
func TestSessionsMSHUnparseable(t *testing.T) {
	for _, bad := range []string{
		"this is not hl7 at all\r",
		"PID|1||E26000000001\r",
		"MSH|^~\\&|A|B|C|D|2026||ORU^R01\r", // no MSH-10
		"MSH|^~\\&|A|B|C|D|2026||ORU^R01||P|2.5\r",
		"\x00\x01\xff\xfe",
	} {
		t.Run(fmt.Sprintf("%.12q", bad), func(t *testing.T) {
			sink := &fakeSink{}
			c, done := serveOne(t, newCfg(sink, &mllp.Stats{}))
			c.Write(mllp.Encode([]byte(bad)))
			expectSilence(t, c, 250*time.Millisecond)
			// connection stays usable: a valid message afterwards is ACKed
			c.Write(mllp.Encode([]byte(msgOrig)))
			if code, _ := msa(t, readACK(t, c)); code != "AA" {
				t.Errorf("follow-up code = %s", code)
			}
			c.Close()
			waitServe(t, done)
			msgs, inc, _ := sink.snapshot()
			if len(msgs) != 1 || msgs[0] != msgOrig {
				t.Errorf("msgs = %q", msgs)
			}
			if len(inc) != 1 || inc[0].raw != bad || inc[0].reason != mllp.ReasonMSHUnparseable {
				t.Errorf("incomplete = %+v, want one {%q msh_unparseable}", inc, bad)
			}
		})
	}
}

// §3.3: new 0x0B inside a block → partial becomes incomplete(new_start_block); the new block is processed normally.
func TestSessionsNewStartBlockMidMessage(t *testing.T) {
	sink, st := &fakeSink{}, &mllp.Stats{}
	c, done := serveOne(t, newCfg(sink, st))
	c.Write(append([]byte("\x0bMSH|^~\\&|HALF"), mllp.Encode([]byte(msgOrig))...))
	if code, _ := msa(t, readACK(t, c)); code != "AA" {
		t.Errorf("code = %s", code)
	}
	c.Close()
	waitServe(t, done)
	msgs, inc, _ := sink.snapshot()
	if len(msgs) != 1 || len(inc) != 1 || inc[0].reason != mllp.ReasonNewStartBlock || inc[0].raw != "MSH|^~\\&|HALF" {
		t.Fatalf("msgs=%q inc=%+v", msgs, inc)
	}
	if st.Incomplete() != 1 {
		t.Errorf("Incomplete = %d", st.Incomplete())
	}
}

// §3.3: connection closed mid-block → partial stored as incomplete with empty reason (E04 incomplete_reason is optional; no enum value for this), no ACK, Serve returns cleanly.
func TestSessionsConnectionClosedMidBlock(t *testing.T) {
	sink := &fakeSink{}
	c, done := serveOne(t, newCfg(sink, &mllp.Stats{}))
	c.Write([]byte("\x0bMSH|^~\\&|A|B|C|D|2026||ORU^R01|ID1|P|2.5\rOBX|1"))
	time.Sleep(100 * time.Millisecond)
	c.Close()
	if err := waitServe(t, done); err != nil {
		t.Fatalf("Serve = %v, want nil on peer close", err)
	}
	msgs, inc, _ := sink.snapshot()
	if len(msgs) != 0 || len(inc) != 1 || inc[0].reason != "" || !strings.HasPrefix(inc[0].raw, "MSH|^~\\&|A|B") {
		t.Fatalf("msgs=%q inc=%+v", msgs, inc)
	}
}

func padded(size int) string {
	head := "MSH|^~\\&|ANALYZER|LAB|LIMS|AG-01|20261111110000||ORU^R01|BIG1|P|2.5.1\rNTE|1||"
	return head + strings.Repeat("x", size-len(head))
}

// AC-07.5: > max → not ACKed, connection reset, counter incremented, nothing stored as received.
func TestSessionsOversize(t *testing.T) {
	sink, st := &fakeSink{}, &mllp.Stats{}
	cfg := newCfg(sink, st)
	cfg.MaxMessageBytes = 2048
	c, done := serveOne(t, cfg)
	c.Write(mllp.Encode([]byte(padded(2049))))
	expectClosedWithoutData(t, c)
	if err := waitServe(t, done); !errors.Is(err, mllp.ErrOversize) {
		t.Fatalf("Serve = %v, want ErrOversize", err)
	}
	if st.Oversize() != 1 {
		t.Errorf("Oversize = %d, want 1", st.Oversize())
	}
	if msgs, _, _ := sink.snapshot(); len(msgs) != 0 {
		t.Errorf("oversize message was committed: %d", len(msgs))
	}
}

// Exactly max bytes is accepted (limit is "larger than"), and a reconnect after a reset works (Reset → WaitStart).
func TestSessionsAtLimitThenReconnectAfterOversize(t *testing.T) {
	sink, st := &fakeSink{}, &mllp.Stats{}
	cfg := newCfg(sink, st)
	cfg.MaxMessageBytes = 2048

	c1, d1 := serveOne(t, cfg)
	c1.Write(mllp.Encode([]byte(padded(2048))))
	if code, ref := msa(t, readACK(t, c1)); code != "AA" || ref != "BIG1" {
		t.Errorf("at limit: %s|%s", code, ref)
	}
	c1.Close()
	waitServe(t, d1)

	c2, d2 := serveOne(t, cfg)
	c2.Write(mllp.Encode([]byte(padded(2049))))
	expectClosedWithoutData(t, c2)
	if err := waitServe(t, d2); !errors.Is(err, mllp.ErrOversize) {
		t.Fatalf("Serve = %v", err)
	}

	c3, d3 := serveOne(t, cfg)
	c3.Write(mllp.Encode([]byte(msgOrig)))
	if code, _ := msa(t, readACK(t, c3)); code != "AA" {
		t.Errorf("after reset: %s", code)
	}
	c3.Close()
	waitServe(t, d3)
	if st.Oversize() != 1 {
		t.Errorf("Oversize = %d", st.Oversize())
	}
}

// Default limit is 1 MiB when MaxMessageBytes is 0 (02-TRD §5.4 [CONV]).
func TestSessionsDefaultLimitIsOneMiB(t *testing.T) {
	sink, st := &fakeSink{}, &mllp.Stats{}
	cfg := newCfg(sink, st)
	cfg.MaxMessageBytes = 0
	c, done := serveOne(t, cfg)
	go c.Write(mllp.Encode([]byte(padded(1<<20 + 1)))) // may fail once the server resets
	expectClosedWithoutData(t, c)
	if err := waitServe(t, done); !errors.Is(err, mllp.ErrOversize) {
		t.Fatalf("Serve = %v, want ErrOversize", err)
	}
	if st.Oversize() != 1 {
		t.Errorf("Oversize = %d", st.Oversize())
	}
}

// Segmented delivery (byte by byte with pauses) yields the same ACK.
func TestSessionsSegmentedDelivery(t *testing.T) {
	c, _ := serveOne(t, newCfg(&fakeSink{}, &mllp.Stats{}))
	for _, b := range mllp.Encode([]byte(msgEnh)) {
		c.Write([]byte{b})
	}
	if code, ref := msa(t, readACK(t, c)); code != "CA" || ref != "MSG0002" {
		t.Errorf("MSA = %s|%s", code, ref)
	}
}

// Security: MSH-10 carrying MLLP control bytes must not let the instrument-controlled value break ACK framing.
func TestSessionsHostileControlIdCannotBreakAckFraming(t *testing.T) {
	hostile := "MSH|^~\\&|A|B|LIMS|AG-01|2026||ORU^R01|ID\x1c\x0d\x0bEVIL|P|2.5\r"
	sink := &fakeSink{}
	c, _ := serveOne(t, newCfg(sink, &mllp.Stats{}))
	c.Write(mllp.Encode([]byte(hostile)))

	c.SetReadDeadline(time.Now().Add(700 * time.Millisecond))
	var got []byte
	buf := make([]byte, 4096)
	for {
		n, err := c.Read(buf)
		got = append(got, buf[:n]...)
		if err != nil {
			break
		}
	}
	if len(got) == 0 {
		return // refusing to ACK a hostile id is acceptable
	}
	if got[0] != 0x0B || !bytes.HasSuffix(got, []byte{0x1C, 0x0D}) ||
		bytes.Count(got, []byte{0x0B}) != 1 || bytes.Count(got, []byte{0x1C}) != 1 {
		t.Errorf("ACK framing corrupted by hostile MSH-10: %q", got)
	}
}

// Security: hostile stream (random bytes incl. framing bytes) never crashes Serve and never produces a malformed ACK.
func TestSessionsRandomBytesNoCrash(t *testing.T) {
	sink := &fakeSink{}
	c, done := serveOne(t, newCfg(sink, &mllp.Stats{}))
	junk := bytes.Repeat([]byte{0x0B, 0x1C, 0x0D, 'M', 0xFF, 0x00, '|'}, 500)
	c.Write(junk)
	c.Write(mllp.Encode([]byte(msgOrig)))
	// A valid message after hostile junk must still be ACKed (junk may have been absorbed into a block — then it is
	// consumed up to the first terminator; send a second valid message to resynchronise).
	c.Write(mllp.Encode([]byte(msgOrig)))
	c.SetReadDeadline(time.Now().Add(3 * time.Second))
	br := bufio.NewReader(c)
	if b, err := br.ReadByte(); err != nil || b != 0x0B {
		t.Fatalf("expected an ACK block after junk, got %v %v", b, err)
	}
	c.Close()
	if err := waitServe(t, done); err != nil && !errors.Is(err, mllp.ErrOversize) {
		t.Fatalf("Serve error: %v", err)
	}
}

// Many instruments at once: each connection gets ACKs for its own control ids; counters are race-free.
func TestSessionsConcurrentConnections(t *testing.T) {
	const conns, perConn = 8, 25
	sink, st := &fakeSink{}, &mllp.Stats{}
	cfg := newCfg(sink, st)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	var srv sync.WaitGroup
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			srv.Add(1)
			go func() { defer srv.Done(); mllp.Serve(c, cfg) }()
		}
	}()

	var wg sync.WaitGroup
	errs := make(chan string, conns*perConn)
	for i := 0; i < conns; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			c, err := net.Dial("tcp", ln.Addr().String())
			if err != nil {
				errs <- err.Error()
				return
			}
			defer c.Close()
			for j := 0; j < perConn; j++ {
				id := fmt.Sprintf("C%dM%d", i, j)
				m := "MSH|^~\\&|ANALYZER|LAB|LIMS|AG-01|20261111110000||ORU^R01|" + id + "|P|2.5.1\rPID|1\r"
				c.Write(mllp.Encode([]byte(m)))
				c.SetReadDeadline(time.Now().Add(5 * time.Second))
				br := bufio.NewReader(c)
				var out []byte
				for !(len(out) >= 2 && out[len(out)-2] == 0x1C && out[len(out)-1] == 0x0D) {
					b, err := br.ReadByte()
					if err != nil {
						errs <- fmt.Sprintf("%s: %v", id, err)
						return
					}
					out = append(out, b)
				}
				if !strings.HasSuffix(string(out), "MSA|AA|"+id+"\r\x1c\x0d") {
					errs <- fmt.Sprintf("%s: wrong ACK %q", id, out)
					return
				}
			}
		}(i)
	}
	wg.Wait()
	close(errs)
	for e := range errs {
		t.Error(e)
	}
	ln.Close()
	srv.Wait()
	if msgs, _, _ := sink.snapshot(); len(msgs) != conns*perConn {
		t.Errorf("stored %d messages, want %d", len(msgs), conns*perConn)
	}
	if st.DiscardedBytes() != 0 || st.Oversize() != 0 {
		t.Errorf("unexpected counters: discarded=%d oversize=%d", st.DiscardedBytes(), st.Oversize())
	}
}

var _ io.ReadWriteCloser = net.Conn(nil)
