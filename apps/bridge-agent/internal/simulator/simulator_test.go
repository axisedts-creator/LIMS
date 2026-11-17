package simulator_test

// AG-T17 tests: the session runner (02-TRD §15.3, 01-PRD AC-21.1). Spec names only cmd/simulator, testdata/sessions
// and the session JSON format; the Go API below is the tests' contract for the writer (package internal/simulator):
//
//	type Session struct { Name, Protocol, Transport, InstrumentProfile string; Options map[string]any; Steps []Step }
//	func ParseBytes(s string) ([]byte, error)          // mnemonics <ENQ> <ACK> <NAK> <EOT> <STX> <ETX> <ETB> <CR> <LF> <VT> <FS>; other text literal; unknown <XXX> = error
//	func LoadSession(path string) (Session, error)     // one *.session.json; malformed / unknown shape = error, never panic
//	func LoadDir(dir string) ([]Session, error)        // every *.session.json, sorted by file name; none found = error
//	func Run(s Session, scratchDir string) error       // runs on in-memory duplex + fake clock + real link layers + real queue under scratchDir;
//	                                                   // error text names the failing step as "step N" (1-based) and says what differed
//
// Runner rules the tests pin: instrument bytes are fed to the agent; every byte the agent writes must be consumed by the next
// {"expect":"agent"} step (exact bytes; leftovers or a missing reply = error); {"wait_ms":n} advances the FAKE clock (no real
// sleep) and then ticks the link layer; {"expect_queue":{items,kind,raw_sha256}} checks the queue (items = count of items, kind and
// raw_sha256 apply to the item(s); raw = concatenated frame texts for ASTM).

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"lims/apps/bridge-agent/internal/astm"
	"lims/apps/bridge-agent/internal/simulator"
)

var mnemonics = []struct {
	name string
	b    byte
}{
	{"ENQ", 0x05}, {"ACK", 0x06}, {"NAK", 0x15}, {"EOT", 0x04}, {"STX", 0x02}, {"ETX", 0x03},
	{"ETB", 0x17}, {"CR", 0x0D}, {"LF", 0x0A}, {"VT", 0x0B}, {"FS", 0x1C},
}

// mn renders raw bytes as a session "bytes" string.
func mn(b []byte) string {
	var sb strings.Builder
	for _, c := range b {
		done := false
		for _, m := range mnemonics {
			if m.b == c {
				sb.WriteString("<" + m.name + ">")
				done = true
				break
			}
		}
		if !done {
			sb.WriteByte(c)
		}
	}
	return sb.String()
}

func frame(t *testing.T, fn int, text string, term byte) string {
	t.Helper()
	b, err := astm.EncodeFrame(fn, []byte(text), term)
	if err != nil {
		t.Fatalf("EncodeFrame: %v", err)
	}
	return mn(b)
}

func sha(s string) string { h := sha256.Sum256([]byte(s)); return hex.EncodeToString(h[:]) }

type m = map[string]any

func inst(b string) m  { return m{"from": "instrument", "bytes": b} }
func agent(b string) m { return m{"expect": "agent", "bytes": b, "within_ms": 200} }
func wait(ms int) m    { return m{"wait_ms": ms} }
func queueIs(items int, kind, rawSHA string) m {
	q := m{"items": items}
	if kind != "" {
		q["kind"] = kind
	}
	if rawSHA != "" {
		q["raw_sha256"] = rawSHA
	}
	return m{"expect_queue": q}
}

func session(name string, opts m, steps ...m) m {
	return m{"name": name, "protocol": "astm", "transport": "pipe", "instrument_profile": "astm_generic_e1394", "options": opts, "steps": steps}
}

func load(t *testing.T, v any) simulator.Session {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(t.TempDir(), "x.session.json")
	if err := os.WriteFile(p, b, 0o600); err != nil {
		t.Fatal(err)
	}
	s, err := simulator.LoadSession(p)
	if err != nil {
		t.Fatalf("LoadSession: %v", err)
	}
	return s
}

func run(t *testing.T, v any) error {
	t.Helper()
	return simulator.Run(load(t, v), t.TempDir())
}

const hRec = "H|\\^&|||SIM-ANALYSER^0.1|||||||P|1\r"

func okUpload(t *testing.T) m {
	return session("astm-upload-single-glucose", m{"receiver_frame_wait_s": 30},
		inst("<ENQ>"), agent("<ACK>"),
		inst(frame(t, 1, hRec, astm.ETX)), agent("<ACK>"),
		inst("<EOT>"),
		queueIs(1, "data", sha(hRec)))
}

// ---- mnemonics ----

func TestSessionsParseBytesMnemonics(t *testing.T) {
	for _, mm := range mnemonics {
		got, err := simulator.ParseBytes("<" + mm.name + ">")
		if err != nil || len(got) != 1 || got[0] != mm.b {
			t.Errorf("<%s> = %x, %v; want %02x", mm.name, got, err, mm.b)
		}
	}
	got, err := simulator.ParseBytes("<STX>1H|\\^&<CR><ETX>1C<CR><LF>")
	want := []byte("\x021H|\\^&\r\x031C\r\n")
	if err != nil || string(got) != string(want) {
		t.Errorf("mixed = %q, %v; want %q", got, err, want)
	}
	if got, err := simulator.ParseBytes(""); err != nil || len(got) != 0 {
		t.Errorf("empty = %q, %v", got, err)
	}
}

func TestSessionsParseBytesUnknownMnemonic(t *testing.T) {
	if got, err := simulator.ParseBytes("<ENQ><FOO>"); err == nil {
		t.Fatalf("unknown mnemonic accepted: %x", got)
	}
}

// ---- green path ----

func TestSessionsRunUploadGreen(t *testing.T) {
	if err := run(t, okUpload(t)); err != nil {
		t.Fatalf("spec example session must pass: %v", err)
	}
}

func TestSessionsRunBadChecksumNakRetransmit(t *testing.T) {
	good, err := astm.EncodeFrame(1, []byte(hRec), astm.ETX)
	if err != nil {
		t.Fatal(err)
	}
	bad := append([]byte(nil), good...)
	c1 := len(bad) - 4 // C1 C2 CR LF
	if bad[c1] == '0' {
		bad[c1] = '1'
	} else {
		bad[c1] = '0'
	}
	s := session("astm-bad-checksum-nak-retransmit", nil,
		inst("<ENQ>"), agent("<ACK>"),
		inst(mn(bad)), agent("<NAK>"),
		inst(mn(good)), agent("<ACK>"),
		inst("<EOT>"),
		queueIs(1, "data", sha(hRec)))
	if err := run(t, s); err != nil {
		t.Fatalf("NAK then retransmit must give exactly one item: %v", err)
	}
}

// ---- the runner must really assert (a runner that always passes would satisfy "all green") ----

func TestSessionsRunDetectsWrongAgentBytes(t *testing.T) {
	s := session("x", nil, inst("<ENQ>"), agent("<NAK>"))
	err := run(t, s)
	if err == nil || !strings.Contains(err.Error(), "step 2") {
		t.Fatalf("want error naming step 2, got %v", err)
	}
}

func TestSessionsRunDetectsMissingAgentReply(t *testing.T) {
	s := session("x", nil, inst("<ENQ>"), agent("<ACK>"), agent("<ACK>"))
	err := run(t, s)
	if err == nil || !strings.Contains(err.Error(), "step 3") {
		t.Fatalf("want error naming step 3 (no bytes to match), got %v", err)
	}
}

func TestSessionsRunDetectsUnexpectedAgentBytes(t *testing.T) {
	// agent ACKs the ENQ; the session never expects it -> exact-bytes assertion must fail, not ignore it
	s := session("x", nil, inst("<ENQ>"), inst("<EOT>"))
	if err := run(t, s); err == nil {
		t.Fatal("unconsumed agent bytes were silently ignored")
	}
}

func TestSessionsRunDetectsQueueMismatch(t *testing.T) {
	for name, q := range map[string]m{
		"items":  queueIs(2, "data", sha(hRec)),
		"kind":   queueIs(1, "incomplete", sha(hRec)),
		"sha256": queueIs(1, "data", sha("something else\r")),
	} {
		s := session("x", nil, inst("<ENQ>"), agent("<ACK>"), inst(frame(t, 1, hRec, astm.ETX)), agent("<ACK>"), inst("<EOT>"), q)
		err := run(t, s)
		if err == nil || !strings.Contains(err.Error(), "step 6") {
			t.Errorf("%s mismatch: want error naming step 6, got %v", name, err)
		}
	}
}

// ---- fake clock ----

func TestSessionsRunWaitAdvancesFakeClock(t *testing.T) {
	open := func(w int, q m) m {
		return session("astm-receiver-timeout-incomplete", m{"receiver_frame_wait_s": 5},
			inst("<ENQ>"), agent("<ACK>"),
			inst(frame(t, 1, hRec, astm.ETX)), agent("<ACK>"),
			wait(w), q)
	}
	if err := run(t, open(5000, queueIs(1, "incomplete", ""))); err != nil {
		t.Errorf("wait_ms == frame wait must close the session as incomplete: %v", err)
	}
	if err := run(t, open(4000, queueIs(0, "", ""))); err != nil {
		t.Errorf("wait_ms below frame wait must leave nothing in the queue: %v", err)
	}
}

func TestSessionsRunNeverSleepsForReal(t *testing.T) {
	s := session("x", m{"receiver_frame_wait_s": 5},
		inst("<ENQ>"), agent("<ACK>"), inst(frame(t, 1, hRec, astm.ETX)), agent("<ACK>"),
		wait(3_600_000), queueIs(1, "incomplete", ""))
	start := time.Now()
	if err := run(t, s); err != nil {
		t.Fatal(err)
	}
	if d := time.Since(start); d > 3*time.Second {
		t.Fatalf("1 h of wait_ms took %v of real time; the clock must be fake", d)
	}
}

// ---- hostile / malformed input (session files are data, never code) ----

func TestSessionsRunRejectsUnknownProtocol(t *testing.T) {
	s := okUpload(t)
	s["protocol"] = "bogus"
	b, _ := json.Marshal(s)
	p := filepath.Join(t.TempDir(), "x.session.json")
	_ = os.WriteFile(p, b, 0o600)
	loaded, lerr := simulator.LoadSession(p)
	if lerr != nil {
		return // rejected at load: fine
	}
	if err := simulator.Run(loaded, t.TempDir()); err == nil {
		t.Fatal("unknown protocol must be an error (load or run)")
	}
}

func TestSessionsRunRejectsBadMnemonicStep(t *testing.T) {
	p := filepath.Join(t.TempDir(), "x.session.json")
	b, _ := json.Marshal(session("x", nil, inst("<NOPE>")))
	_ = os.WriteFile(p, b, 0o600)
	s, lerr := simulator.LoadSession(p)
	if lerr != nil {
		return
	}
	if err := simulator.Run(s, t.TempDir()); err == nil {
		t.Fatal("unknown mnemonic in a step must fail the session")
	}
}

func TestSessionsLoadRejectsMalformed(t *testing.T) {
	dir := t.TempDir()
	for name, body := range map[string]string{
		"trunc.session.json":   `{"name":"x","protocol":"astm","steps":[`,
		"notjson.session.json": "\x00\x01\x02",
		"empty.session.json":   "",
		"steps.session.json":   `{"name":"x","protocol":"astm","transport":"pipe","steps":"nope"}`,
	} {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := simulator.LoadSession(p); err == nil {
			t.Errorf("%s: malformed session accepted", name)
		}
	}
}

func TestSessionsLoadRejectsStepWithBothFromAndExpect(t *testing.T) {
	s := session("x", nil, m{"from": "instrument", "expect": "agent", "bytes": "<ENQ>"})
	b, _ := json.Marshal(s)
	p := filepath.Join(t.TempDir(), "x.session.json")
	_ = os.WriteFile(p, b, 0o600)
	loaded, lerr := simulator.LoadSession(p)
	if lerr != nil {
		return
	}
	if err := simulator.Run(loaded, t.TempDir()); err == nil {
		t.Fatal("ambiguous step accepted")
	}
}

func TestSessionsLoadDirEmptyIsError(t *testing.T) {
	if got, err := simulator.LoadDir(t.TempDir()); err == nil {
		t.Fatalf("empty dir must be an error (a vacuous CI pass is a failure); got %d sessions", len(got))
	}
	if _, err := simulator.LoadDir(filepath.Join(t.TempDir(), "missing")); err == nil {
		t.Fatal("missing dir must be an error")
	}
}

func TestSessionsLoadDirIgnoresOtherFilesAndSorts(t *testing.T) {
	dir := t.TempDir()
	for _, n := range []string{"b-two", "a-one"} {
		b, _ := json.Marshal(session(n, nil, inst("<ENQ>"), agent("<ACK>")))
		_ = os.WriteFile(filepath.Join(dir, n+".session.json"), b, 0o600)
	}
	_ = os.WriteFile(filepath.Join(dir, "README.md"), []byte("not a session"), 0o600)
	ss, err := simulator.LoadDir(dir)
	if err != nil || len(ss) != 2 || ss[0].Name != "a-one" || ss[1].Name != "b-two" {
		t.Fatalf("LoadDir = %+v, %v; want [a-one b-two]", ss, err)
	}
}

func TestSessionsRunStaysInScratchDir(t *testing.T) {
	// a hostile session name must not become a path
	outer := t.TempDir()
	scratch := filepath.Join(outer, "s")
	if err := os.Mkdir(scratch, 0o700); err != nil {
		t.Fatal(err)
	}
	s := okUpload(t)
	s["name"] = `..\..\escape/../../escape`
	if err := simulator.Run(load(t, s), scratch); err != nil {
		t.Fatalf("run: %v", err)
	}
	ents, _ := os.ReadDir(outer)
	if len(ents) != 1 || ents[0].Name() != "s" {
		t.Fatalf("runner wrote outside its scratch dir: %v", ents)
	}
}
