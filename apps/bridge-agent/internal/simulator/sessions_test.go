package simulator_test

// AG-T17 / AC-21.1: every file in apps/bridge-agent/testdata/sessions/ runs green, and the required set of 02-TRD §15.3
// (plus CR-C10-007 micro sessions) exists. `build/ci.sh sessions` runs `go test ./internal/... -run TestSessions`.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"testing"

	"lims/apps/bridge-agent/internal/simulator"
)

var sessionsDir = filepath.Join("..", "..", "testdata", "sessions")

// Required session names (tests' contract; one file per name: <name>.session.json). Topics = 02-TRD §15.3 list.
var requiredSessions = []string{
	"astm-upload-single-glucose",
	"astm-upload-multi-frame",
	"astm-upload-etb-split",
	"astm-bad-checksum-nak-retransmit",
	"astm-duplicate-retransmit",
	"astm-receiver-timeout-incomplete",
	"astm-contention-enq-cross",
	"astm-host-query-round-trip",
	"astm-send-6-failed-eot",
	"astm-nak-to-enq-retry-10s",
	"hl7-original-ack",
	"hl7-enhanced-ack",
	"mllp-garbage-before-start",
	"mllp-oversize",
	"hl7-reused-msh10",
	"filedrop-stable-file",
	"filedrop-unstable-file",
	"astm-micro-two-isolates-same-antibiotic",
	"astm-micro-composite-code-over-64",
}

func TestSessions(t *testing.T) {
	ss, err := simulator.LoadDir(sessionsDir)
	if err != nil {
		t.Fatalf("LoadDir(%s): %v", sessionsDir, err)
	}
	if len(ss) < len(requiredSessions) {
		t.Fatalf("%d sessions, want at least the %d required", len(ss), len(requiredSessions))
	}
	for _, s := range ss {
		t.Run(s.Name, func(t *testing.T) {
			if err := simulator.Run(s, t.TempDir()); err != nil {
				t.Fatal(err)
			}
		})
	}
}

type rawSession struct {
	Name      string `json:"name"`
	Protocol  string `json:"protocol"`
	Transport string `json:"transport"`
	Steps     []map[string]any
}

// leaves returns every string leaf under v, plus "key=value" for scalar leaves, so tests can grep a session without
// depending on step shapes the spec leaves open (host query, file drop, outbound).
func leaves(v any, key string, out *[]string) {
	switch x := v.(type) {
	case string:
		*out = append(*out, x, key+"="+x)
	case float64:
		*out = append(*out, key+"="+strconv.FormatFloat(x, 'f', -1, 64))
	case []any:
		for _, e := range x {
			leaves(e, key, out)
		}
	case map[string]any:
		for k, e := range x {
			leaves(e, k, out)
		}
	}
}

func readRaw(t *testing.T, name string) (rawSession, string) {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(sessionsDir, name+".session.json"))
	if err != nil {
		t.Fatalf("required session file missing: %v", err)
	}
	var rs rawSession
	if err := json.Unmarshal(b, &rs); err != nil {
		t.Fatalf("%s: %v", name, err)
	}
	var all []string
	for _, st := range rs.Steps {
		leaves(st, "", &all)
	}
	return rs, strings.Join(all, "\n")
}

func TestSessionsRequiredSetPresentAndNamed(t *testing.T) {
	for _, n := range requiredSessions {
		rs, _ := readRaw(t, n)
		if rs.Name != n {
			t.Errorf("%s: name field = %q, must equal the file name", n, rs.Name)
		}
		if rs.Protocol == "" || rs.Transport == "" {
			t.Errorf("%s: protocol and transport are required", n)
		}
	}
}

func TestSessionsEverySessionAssertsSomething(t *testing.T) {
	files, _ := filepath.Glob(filepath.Join(sessionsDir, "*.session.json"))
	if len(files) == 0 {
		t.Fatalf("no session files in %s", sessionsDir)
	}
	sort.Strings(files)
	sha := regexp.MustCompile(`^[0-9a-f]{64}$`)
	for _, f := range files {
		base := strings.TrimSuffix(filepath.Base(f), ".session.json")
		rs, _ := readRaw(t, base)
		asserts := false
		for _, st := range rs.Steps {
			if _, ok := st["expect"]; ok {
				asserts = true
			}
			if q, ok := st["expect_queue"].(map[string]any); ok {
				asserts = true
				// AC-21.1: queue items are asserted by hash, not just counted
				if n, _ := q["items"].(float64); n > 0 {
					h, _ := q["raw_sha256"].(string)
					if !sha.MatchString(h) {
						t.Errorf("%s: expect_queue with items>0 needs a 64-hex raw_sha256, got %q", base, h)
					}
				}
			}
		}
		if !asserts {
			t.Errorf("%s: a session without expect/expect_queue proves nothing", base)
		}
	}
}

func TestSessionsRequiredContent(t *testing.T) {
	has := func(name string, wants ...string) {
		t.Helper()
		_, all := readRaw(t, name)
		for _, w := range wants {
			if !strings.Contains(all, w) {
				t.Errorf("%s: session must contain %q", name, w)
			}
		}
	}
	has("astm-bad-checksum-nak-retransmit", "<NAK>")
	has("astm-upload-etb-split", "<ETB>")
	has("astm-receiver-timeout-incomplete", "kind=incomplete", "wait_ms=")
	has("astm-contention-enq-cross", "<ENQ>")
	has("astm-send-6-failed-eot", "<EOT>", "<NAK>")
	has("astm-nak-to-enq-retry-10s", "<NAK>", "wait_ms=10000")
	has("hl7-original-ack", "MSA|AA|")
	has("hl7-enhanced-ack", "MSA|CA|")
	has("mllp-garbage-before-start", "<VT>")
	has("hl7-reused-msh10", "MSA|")
	has("filedrop-unstable-file", "items=0")
	has("filedrop-stable-file", "items=1")
}

func TestSessionsSendFailedSessionHasSixFrameNaks(t *testing.T) {
	rs, _ := readRaw(t, "astm-send-6-failed-eot")
	n := 0
	for _, st := range rs.Steps {
		if st["from"] == "instrument" && st["bytes"] == "<NAK>" {
			n++
		}
	}
	if n < 6 {
		t.Fatalf("instrument must NAK the same frame 6 times (max_frame_sends), got %d NAK steps", n)
	}
}

// CR-C10-007 / 08 R13: two isolates of one specimen with the same antibiotic stay two distinct items' worth of data in
// the raw capture; the over-64-character composite code case is a data session too. The parse into `ast` records and
// the skipped_invalid rule live in the API driver (TRD §6, micro-code.ts) and are NOT covered by these Go sessions.
func TestSessionsMicroSessionsAreSynthetic(t *testing.T) {
	for _, n := range []string{"astm-micro-two-isolates-same-antibiotic", "astm-micro-composite-code-over-64"} {
		_, all := readRaw(t, n)
		if !strings.Contains(all, "kind=data") {
			t.Errorf("%s: must assert the uploaded item kind=data", n)
		}
	}
	_, all := readRaw(t, "astm-micro-two-isolates-same-antibiotic")
	if strings.Count(all, "O|1|") < 1 || strings.Count(all, "R|") < 2 {
		t.Errorf("two-isolates session must carry one order with >= 2 result records")
	}
}

// Synthetic data only (CLAUDE.md): barcodes follow E26000000nn; no e-mail, no URL, no long digit runs that look like real ids.
func TestSessionsSyntheticDataOnly(t *testing.T) {
	files, _ := filepath.Glob(filepath.Join(sessionsDir, "*.session.json"))
	bad := regexp.MustCompile(`(?i)[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}|https?://|\b\d{10,}\b`)
	for _, f := range files {
		b, _ := os.ReadFile(f)
		// strip the allowed synthetic barcodes (E26000000nn) and 64-hex hashes before the scan
		s := regexp.MustCompile(`E26\d{8}|[0-9a-f]{64}`).ReplaceAllString(string(b), "")
		if m := bad.FindString(s); m != "" {
			t.Errorf("%s: looks like real data (%q)", filepath.Base(f), m)
		}
	}
}
