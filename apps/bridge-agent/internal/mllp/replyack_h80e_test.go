// H80-T01 tests (tester, written first): host-query replies and ReplyAckPolicy in the MLLP session.
// Spec: 08-ADDENDUM-TRUTH-H80E §5-§7, CR-C7-016, PRD AC-10.6, 02-TRD D-02; binding lead decision LD-139 (D-H80-1).
// Run: go test ./internal/mllp/ -run H80E
//
// Contract expected from package mllp (additions to Config in session.go; zero values = today's behaviour):
//
//	type HostQueryFunc func(raw []byte, msh hl7.MSH) [][]byte // reply messages in order, unframed; nil/empty = API unreachable
//	type Config struct {
//	    ...existing fields...
//	    HostQueryTypes         []string      // MSH-9 values classified as host queries (profile.HostQueryMessageTypes)
//	    HostQuery              HostQueryFunc // called only for a message whose MSH-9 is in HostQueryTypes, AFTER CommitMessage succeeded
//	    ExpectAckOnReply       bool          // profile.ExpectAckOnReply; false = never wait for an ACK
//	    ReplyAckPolicy         string        // "" or "each": wait for an ACK after every reply message; "last": after the final one only; "none": never
//	    ReplyAckMatchControlId bool          // true: the awaited ACK's MSA-2 must equal the MSH-10 of the reply it acknowledges
//	    ReplyTimeout           time.Duration // how long to wait for the ACK; 0 -> 10s. Never hard-coded (every U value is configurable)
//	}
//	func (s *Stats) ReplyAckTimeouts() int64   // waits that ended without an ACK
//	func (s *Stats) ReplyAckMismatches() int64 // ACKs seen while ReplyAckMatchControlId=true whose MSA-2 did not match
//
// Rules: a host-query message is committed (D-02), gets NO HL7 ACK of its own (QCK/DSR are the answer), and
// is answered by writing every reply message framed with Encode, in order. If HostQuery returns no reply (API down) the
// agent writes nothing at all (AC-10.6) and keeps the session. An ACK consumed while waiting is never committed and never
// ACKed. A timeout is not an error: the session continues. Messages that are not host queries behave exactly as today.
package mllp_test

import (
	"bytes"
	"net"
	"strings"
	"sync"
	"testing"
	"time"

	"lims/apps/bridge-agent/internal/hl7"
	"lims/apps/bridge-agent/internal/mllp"
)

// Synthetic messages from 08-ADDENDUM §5 (Test Patient / E2600000042; short timestamps).
const (
	qry  = "MSH|^~\\&|Truth|Truth-H80E|||20261105103542||QRY^Q02|126|P|2.3||||||UTF-8||||\rQRD|20261105103542|R|D|65|||RD|E2600000042||||\rQRF|||||RCT|COR|ALL|||\r"
	qck  = "MSH|^~\\&|Truth|Truth-H80E|||20261105103542||QCK^Q02|12601|P|2.3|||||UTF-8||||\rMSA|AA|126|Message accepted|||0\rERR|0\rQAK|SR|OK|||||\r"
	dsr  = "MSH|^~\\&|Truth|Truth-H80E|||20261105103542||DSR^Q03|12602|P|2.3||||||UTF-8||||\rMSA|AA|126|Message accepted|||0\rERR|0\rQAK|1|OK|||||\rQRD|20261105103542|R|D|65|||RD||OTH|||T|\rDSP|3||Test Patient|||\rDSP|21||E2600000042|||\rDSC|0|\r"
	qckN = "MSH|^~\\&|Truth|Truth-H80E|||20261105103542||QCK^Q02|12601|P|2.3|||||UTF-8||||\rMSA|AA|126|Message accepted|||0\rERR|0\rQAK|SR|NF|||||\r"
	// the manual's ACK^Q03 echoes the QUERY id (126), not the DSR id (12602)
	ackQ03Query = "MSH|^~\\&|Truth|Truth-H80E|||20261105103542||ACK^Q03|127|P|2.3||||||UTF-8||||\rMSA|AA|126|Message accepted|||0\rERR|0\r"
	ackQ03Dsr   = "MSH|^~\\&|Truth|Truth-H80E|||20261105103542||ACK^Q03|128|P|2.3||||||UTF-8||||\rMSA|AA|12602|Message accepted|||0\rERR|0\r"
	oruH80E     = "MSH|^~\\&|Truth|Truth-H80E|||20261105173723||ORU^R01|7|P|2.3||||0||UTF-8||||\rPID|1||P0000123||Test Patient\rOBR|1|0001|E2600000042\rOBX|1|NM|HbA1c_NGSP||5.63|%||0\r"
)

const settle = 150 * time.Millisecond // "nothing arrives" window; the waits under test are 5 s or more

// peer is the simulated analyser at the far end of a net.Pipe; a goroutine turns every frame the agent writes into an event.
type peer struct {
	t      *testing.T
	c      net.Conn
	frames chan string
	done   chan error
	sink   *h80Sink
	stats  *mllp.Stats
}

type h80Sink struct {
	mu       sync.Mutex
	msgs     []string
	failNext bool
}

func (s *h80Sink) CommitMessage(raw []byte, _ hl7.MSH) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.failNext {
		return errCommit
	}
	s.msgs = append(s.msgs, string(raw))
	return nil
}
func (s *h80Sink) CommitIncomplete([]byte, string) error { return nil }
func (s *h80Sink) committed() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.msgs...)
}

type commitErr struct{}

func (commitErr) Error() string { return "disk full" }

var errCommit = commitErr{}

type hqCall struct {
	raw string
	msh hl7.MSH
}

// start wires Serve to one end of the pipe. hq nil = no HostQuery configured.
func start(t *testing.T, cfg mllp.Config) *peer {
	t.Helper()
	srv, cli := net.Pipe()
	p := &peer{t: t, c: cli, frames: make(chan string, 16), done: make(chan error, 1), sink: &h80Sink{}, stats: &mllp.Stats{}}
	cfg.Sink, cfg.Stats = p.sink, p.stats
	if cfg.AckMode == "" {
		cfg.AckMode = "original"
	}
	cfg.Now = func() time.Time { return time.Date(2026, 11, 5, 10, 35, 42, 0, time.UTC) }
	cfg.NewControlID = func() string { return "ACKID" }
	go func() { p.done <- mllp.Serve(srv, cfg) }()
	go func() {
		rd := mllp.NewReader(cli, 0, &mllp.Stats{})
		for {
			ev, err := rd.Next()
			if err != nil {
				close(p.frames)
				return
			}
			p.frames <- string(ev.Data)
		}
	}()
	t.Cleanup(func() {
		cli.Close()
		select {
		case <-p.done:
		case <-time.After(5 * time.Second):
			t.Error("Serve did not return after the peer closed")
		}
	})
	return p
}

func (p *peer) send(msg string) {
	p.t.Helper()
	_ = p.c.SetWriteDeadline(time.Now().Add(5 * time.Second))
	if _, err := p.c.Write(mllp.Encode([]byte(msg))); err != nil {
		p.t.Fatalf("peer write: %v", err)
	}
}

func (p *peer) next(within time.Duration) (string, bool) {
	select {
	case f, ok := <-p.frames:
		return f, ok
	case <-time.After(within):
		return "", false
	}
}

func (p *peer) mustNext(what string) string {
	p.t.Helper()
	f, ok := p.next(2 * time.Second)
	if !ok {
		p.t.Fatalf("expected %s from the agent, got nothing", what)
	}
	return f
}

func (p *peer) mustSilent(what string) {
	p.t.Helper()
	if f, ok := p.next(settle); ok {
		p.t.Fatalf("%s: agent wrote %q, want nothing", what, f)
	}
}

// proveAlive sends a plain ORU and expects the AA, proving the session survived and is no longer waiting.
func (p *peer) proveAlive() {
	p.t.Helper()
	p.send(oruH80E)
	ack := p.mustNext("AA for the ORU")
	if !strings.Contains(ack, "ACK") || !strings.Contains(ack, "MSA|AA|7") {
		p.t.Fatalf("ORU answer = %q, want ACK with MSA|AA|7", ack)
	}
}

// hq returns a HostQueryFunc recording its calls and answering with replies.
func hq(replies ...string) (mllp.HostQueryFunc, *[]hqCall, *sync.Mutex) {
	var mu sync.Mutex
	var calls []hqCall
	return func(raw []byte, m hl7.MSH) [][]byte {
		mu.Lock()
		calls = append(calls, hqCall{string(raw), m})
		mu.Unlock()
		var out [][]byte
		for _, r := range replies {
			out = append(out, []byte(r))
		}
		return out
	}, &calls, &mu
}

func h80Cfg(f mllp.HostQueryFunc) mllp.Config {
	return mllp.Config{
		HostQueryTypes: []string{"QRY^Q02"}, HostQuery: f,
		ExpectAckOnReply: true, ReplyAckPolicy: "last", ReplyAckMatchControlId: false, ReplyTimeout: 10 * time.Second,
	}
}

// done criterion: with ReplyAckPolicy last the QCK is written, the DSR is written immediately, then the agent waits for ACK^Q03.
func TestH80E_Last_QckThenDsrImmediatelyThenWaitsForAckQ03(t *testing.T) {
	f, calls, mu := hq(qck, dsr)
	p := start(t, h80Cfg(f))
	p.send(qry)
	if got := p.mustNext("QCK"); got != qck {
		t.Fatalf("first reply = %q, want the QCK bytes", got)
	}
	// no ACK from the analyser in between: the DSR must follow at once
	if got := p.mustNext("DSR right after QCK"); got != dsr {
		t.Fatalf("second reply = %q, want the DSR bytes", got)
	}
	p.mustSilent("after the DSR the agent only waits (no ACK of its own for a query)")
	mu.Lock()
	defer mu.Unlock()
	if len(*calls) != 1 || (*calls)[0].raw != qry || (*calls)[0].msh.MessageType != "QRY^Q02" || (*calls)[0].msh.ControlID != "126" {
		t.Fatalf("HostQuery calls = %+v, want one call with the exact QRY bytes and parsed MSH", *calls)
	}
	if c := p.sink.committed(); len(c) != 1 || c[0] != qry {
		t.Fatalf("committed = %q, want the QRY committed once before the reply (D-02)", c)
	}
}

// Q03 id mismatch: the manual's ACK^Q03 answers id 126 although the DSR was 12602; it must be accepted.
func TestH80E_Last_AckQ03WithQueryIdIsAcceptedAndConsumed(t *testing.T) {
	f, _, _ := hq(qck, dsr)
	p := start(t, h80Cfg(f))
	p.send(qry)
	p.mustNext("QCK")
	p.mustNext("DSR")
	p.send(ackQ03Query)
	p.mustSilent("an ACK is never ACKed")
	if c := p.sink.committed(); len(c) != 1 {
		t.Fatalf("committed %d messages, want only the QRY: the ACK^Q03 is protocol, not data", len(c))
	}
	if n := p.stats.ReplyAckMismatches(); n != 0 {
		t.Errorf("mismatches = %d, want 0 when ReplyAckMatchControlId=false", n)
	}
	if n := p.stats.ReplyAckTimeouts(); n != 0 {
		t.Errorf("timeouts = %d, want 0", n)
	}
	p.proveAlive()
}

func TestH80E_Last_MatchControlIdTrue_CountsAMismatchButKeepsTheSession(t *testing.T) {
	f, _, _ := hq(qck, dsr)
	cfg := h80Cfg(f)
	cfg.ReplyAckMatchControlId = true
	p := start(t, cfg)

	p.send(qry)
	p.mustNext("QCK")
	p.mustNext("DSR")
	p.send(ackQ03Dsr) // MSA-2 = 12602 = the DSR's MSH-10
	p.mustSilent("matching ACK")
	if n := p.stats.ReplyAckMismatches(); n != 0 {
		t.Fatalf("matching ACK counted as mismatch (%d)", n)
	}

	p.send(qry)
	p.mustNext("QCK")
	p.mustNext("DSR")
	p.send(ackQ03Query) // MSA-2 = 126, not 12602
	p.mustSilent("mismatching ACK")
	if n := p.stats.ReplyAckMismatches(); n != 1 {
		t.Fatalf("mismatches = %d, want 1", n)
	}
	for _, m := range p.sink.committed() {
		if strings.Contains(m, "ACK^Q03") {
			t.Fatalf("an ACK^Q03 was committed as data: %q", m)
		}
	}
	p.proveAlive()
}

// "each" is today's behaviour for a profile that expects ACKs: the DSR waits for the ACK of the QCK.
func TestH80E_Each_DsrIsWithheldUntilTheQckIsAcknowledged(t *testing.T) {
	f, _, _ := hq(qck, dsr)
	cfg := h80Cfg(f)
	cfg.ReplyAckPolicy = "each"
	p := start(t, cfg)
	p.send(qry)
	if got := p.mustNext("QCK"); got != qck {
		t.Fatalf("first reply = %q", got)
	}
	p.mustSilent("DSR before the QCK was acknowledged")
	p.send(ackQ03Query)
	if got := p.mustNext("DSR after the first ACK"); got != dsr {
		t.Fatalf("second reply = %q, want the DSR", got)
	}
	p.send(ackQ03Query)
	p.mustSilent("end of exchange")
	p.proveAlive()
}

func TestH80E_EmptyPolicyBehavesAsEach(t *testing.T) {
	f, _, _ := hq(qck, dsr)
	cfg := h80Cfg(f)
	cfg.ReplyAckPolicy = ""
	p := start(t, cfg)
	p.send(qry)
	p.mustNext("QCK")
	p.mustSilent("DSR before the QCK was acknowledged")
}

func TestH80E_None_BothRepliesWrittenAndNoWait(t *testing.T) {
	f, _, _ := hq(qck, dsr)
	cfg := h80Cfg(f)
	cfg.ReplyAckPolicy = "none"
	p := start(t, cfg)
	p.send(qry)
	p.mustNext("QCK")
	p.mustNext("DSR")
	p.proveAlive() // processed at once, nothing swallowed as the awaited ACK
	if n := p.stats.ReplyAckTimeouts(); n != 0 {
		t.Errorf("timeouts = %d, want 0 under policy none", n)
	}
}

func TestH80E_ExpectAckOnReplyFalse_NeverWaits(t *testing.T) {
	f, _, _ := hq(qck, dsr)
	cfg := h80Cfg(f)
	cfg.ExpectAckOnReply = false
	cfg.ReplyAckPolicy = "last" // ignored without ExpectAckOnReply
	p := start(t, cfg)
	p.send(qry)
	p.mustNext("QCK")
	p.mustNext("DSR")
	p.proveAlive()
	if n := p.stats.ReplyAckTimeouts(); n != 0 {
		t.Errorf("timeouts = %d, want 0", n)
	}
}

// ReplyTimeout is configurable (every U value is a default, not a guess): a short one ends the wait; the session lives on.
func TestH80E_Last_NoAckWithinReplyTimeout_CountsATimeoutAndContinues(t *testing.T) {
	f, _, _ := hq(qck, dsr)
	cfg := h80Cfg(f)
	cfg.ReplyTimeout = 120 * time.Millisecond
	p := start(t, cfg)
	p.send(qry)
	p.mustNext("QCK")
	p.mustNext("DSR")
	deadline := time.Now().Add(3 * time.Second)
	for p.stats.ReplyAckTimeouts() == 0 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if n := p.stats.ReplyAckTimeouts(); n != 1 {
		t.Fatalf("timeouts = %d, want 1 after ReplyTimeout with no ACK", n)
	}
	p.proveAlive()
}

// Zero ReplyTimeout must not mean "do not wait" nor "wait forever": the documented default applies (profile: 10 s).
func TestH80E_Last_ZeroReplyTimeoutStillWaitsForTheAck(t *testing.T) {
	f, _, _ := hq(qck, dsr)
	cfg := h80Cfg(f)
	cfg.ReplyTimeout = 0
	p := start(t, cfg)
	p.send(qry)
	p.mustNext("QCK")
	p.mustNext("DSR")
	time.Sleep(2 * settle)
	if n := p.stats.ReplyAckTimeouts(); n != 0 {
		t.Fatalf("timed out after %v with ReplyTimeout=0; default must be a real wait", 2*settle)
	}
	p.send(ackQ03Query)
	p.mustSilent("ACK consumed")
	p.proveAlive()
}

func TestH80E_QryNotFound_OnlyTheQckIsWritten(t *testing.T) {
	f, _, _ := hq(qckN)
	p := start(t, h80Cfg(f))
	p.send(qry)
	if got := p.mustNext("QCK NF"); got != qckN || !strings.Contains(got, "QAK|SR|NF") {
		t.Fatalf("reply = %q, want the QCK NF", got)
	}
	p.mustSilent("no DSR after NF")
}

// PRD AC-10.6 / D-H80-1: API unreachable -> the agent sends no reply at all; the query stays committed; the session lives.
func TestH80E_ApiDown_NoReplyAtAll(t *testing.T) {
	p := start(t, h80Cfg(func([]byte, hl7.MSH) [][]byte { return nil }))
	p.send(qry)
	p.mustSilent("API down: no QCK, no ACK, no error reply")
	if c := p.sink.committed(); len(c) != 1 || c[0] != qry {
		t.Fatalf("committed = %q, want the QRY kept (it stays pending, AC-10.6)", c)
	}
	p.proveAlive() // results still flow while the query path is down
}

func TestH80E_ApiDown_EmptyNonNilReplyListIsAlsoSilent(t *testing.T) {
	p := start(t, h80Cfg(func([]byte, hl7.MSH) [][]byte { return [][]byte{} }))
	p.send(qry)
	p.mustSilent("empty reply list")
	p.proveAlive()
}

// D-02: when the durable commit fails the agent must not answer the query as if it had been received.
func TestH80E_CommitFailure_HostQueryNotCalledAndNothingWritten(t *testing.T) {
	f, calls, mu := hq(qck, dsr)
	p := start(t, h80Cfg(f))
	p.sink.mu.Lock()
	p.sink.failNext = true
	p.sink.mu.Unlock()
	p.send(qry)
	p.mustSilent("commit failed")
	mu.Lock()
	n := len(*calls)
	mu.Unlock()
	if n != 0 {
		t.Fatalf("HostQuery called %d times after a failed commit", n)
	}
}

// Without HostQueryTypes (every other profile) a QRY is an ordinary message: committed and ACKed as today.
func TestH80E_NoHostQueryTypes_QryIsAnOrdinaryMessage(t *testing.T) {
	f, calls, mu := hq(qck, dsr)
	cfg := h80Cfg(f)
	cfg.HostQueryTypes = nil
	p := start(t, cfg)
	p.send(qry)
	ack := p.mustNext("the ordinary ACK")
	if !strings.Contains(ack, "MSA|AA|126") {
		t.Fatalf("answer = %q, want an ordinary AA for MSH-10 126", ack)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(*calls) != 0 {
		t.Fatalf("HostQuery called for a type outside HostQueryTypes")
	}
}

// ORU results are never routed to the host-query path and still get AA after commit (D-02).
func TestH80E_OruIsNotAHostQuery(t *testing.T) {
	f, calls, mu := hq(qck, dsr)
	p := start(t, h80Cfg(f))
	p.proveAlive()
	mu.Lock()
	defer mu.Unlock()
	if len(*calls) != 0 {
		t.Fatalf("HostQuery called for ORU^R01")
	}
}

// Hostile: MSH-9 must match exactly; a lookalike type is not a host query.
func TestH80E_LookalikeMessageTypeIsNotAHostQuery(t *testing.T) {
	f, calls, mu := hq(qck, dsr)
	p := start(t, h80Cfg(f))
	p.send(strings.Replace(qry, "QRY^Q02", "QRY^Q02X", 1))
	p.mustNext("ordinary ACK")
	p.send(strings.Replace(qry, "QRY^Q02", "qry^q02", 1))
	p.mustNext("ordinary ACK")
	mu.Lock()
	defer mu.Unlock()
	if len(*calls) != 0 {
		t.Fatalf("HostQuery called for a lookalike type: %d", len(*calls))
	}
}

// Replies are MLLP-framed exactly as Encode does (checked on the wire, not through the reader).
func TestH80E_RepliesAreFramedWithEncode(t *testing.T) {
	srv, cli := net.Pipe()
	f, _, _ := hq(qck, dsr)
	cfg := h80Cfg(f)
	cfg.Sink, cfg.AckMode = &h80Sink{}, "original"
	done := make(chan error, 1)
	go func() { done <- mllp.Serve(srv, cfg) }()
	go func() { _, _ = cli.Write(mllp.Encode([]byte(qry))) }()
	want := append(mllp.Encode([]byte(qck)), mllp.Encode([]byte(dsr))...)
	got := make([]byte, 0, len(want))
	buf := make([]byte, 4096)
	_ = cli.SetReadDeadline(time.Now().Add(3 * time.Second))
	for len(got) < len(want) {
		n, err := cli.Read(buf)
		got = append(got, buf[:n]...)
		if err != nil {
			break
		}
	}
	cli.Close()
	<-done
	if !bytes.Equal(got, want) {
		t.Fatalf("wire bytes = %q, want %q", got, want)
	}
}

// Many analysers at once: each connection keeps its own wait state (no shared ACK slot between sessions).
func TestH80E_ConcurrentSessionsDoNotShareAckState(t *testing.T) {
	for i := 0; i < 8; i++ {
		t.Run(string(rune('a'+i)), func(t *testing.T) {
			t.Parallel()
			f, _, _ := hq(qck, dsr)
			p := start(t, h80Cfg(f))
			p.send(qry)
			p.mustNext("QCK")
			p.mustNext("DSR")
			p.send(ackQ03Query)
			p.mustSilent("ACK consumed")
			p.proveAlive()
		})
	}
}
