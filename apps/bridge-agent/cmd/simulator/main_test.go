package main_test

// AG-T17: cmd/simulator is the CI binary. Contract: `simulator -sessions <dir>` runs every *.session.json in dir,
// prints one line per session containing its name and PASS/FAIL, exits 0 only if all pass (and at least one exists),
// exits non-zero otherwise with the failing session name and "step N" on stderr or stdout.

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"lims/apps/bridge-agent/internal/astm"
)

func build(t *testing.T) string {
	t.Helper()
	exe := filepath.Join(t.TempDir(), "simulator")
	if runtime.GOOS == "windows" {
		exe += ".exe"
	}
	cmd := exec.Command("go", "build", "-o", exe, ".")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("go build ./cmd/simulator: %v\n%s", err, out)
	}
	return exe
}

func runBin(exe string, args ...string) (string, int) {
	cmd := exec.Command(exe, args...)
	var b bytes.Buffer
	cmd.Stdout, cmd.Stderr = &b, &b
	err := cmd.Run()
	code := 0
	if ee, ok := err.(*exec.ExitError); ok {
		code = ee.ExitCode()
	} else if err != nil {
		code = -1
	}
	return b.String(), code
}

func writeSession(t *testing.T, dir, name, expectedACK string) {
	t.Helper()
	fr, err := astm.EncodeFrame(1, []byte("H|\\^&|||SIM-ANALYSER^0.1|||||||P|1\r"), astm.ETX)
	if err != nil {
		t.Fatal(err)
	}
	_ = fr
	steps := []map[string]any{
		{"from": "instrument", "bytes": "<ENQ>"},
		{"expect": "agent", "bytes": expectedACK, "within_ms": 200},
		{"from": "instrument", "bytes": "<EOT>"},
	}
	b, _ := json.Marshal(map[string]any{"name": name, "protocol": "astm", "transport": "pipe",
		"instrument_profile": "astm_generic_e1394", "steps": steps})
	if err := os.WriteFile(filepath.Join(dir, name+".session.json"), b, 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestSimulatorBinaryExitCodes(t *testing.T) {
	exe := build(t)

	good := t.TempDir()
	writeSession(t, good, "ok-one", "<ACK>")
	if out, code := runBin(exe, "-sessions", good); code != 0 || !strings.Contains(out, "ok-one") {
		t.Fatalf("all-green dir: exit %d, want 0 and the session name in output:\n%s", code, out)
	}

	badDir := t.TempDir()
	writeSession(t, badDir, "ok-one", "<ACK>")
	writeSession(t, badDir, "broken-two", "<NAK>") // agent ACKs an ENQ, never NAKs
	out, code := runBin(exe, "-sessions", badDir)
	if code == 0 {
		t.Fatalf("one failing session must give a non-zero exit:\n%s", out)
	}
	if !strings.Contains(out, "broken-two") || !strings.Contains(out, "step 2") {
		t.Errorf("failure output must name the session and the step:\n%s", out)
	}
	if !strings.Contains(out, "ok-one") {
		t.Errorf("passing sessions are still reported when another fails:\n%s", out)
	}
}

func TestSimulatorBinaryEmptyOrMissingDirFails(t *testing.T) {
	exe := build(t)
	if out, code := runBin(exe, "-sessions", t.TempDir()); code == 0 {
		t.Fatalf("empty dir must fail (vacuous pass hides a broken CI path):\n%s", out)
	}
	if out, code := runBin(exe, "-sessions", filepath.Join(t.TempDir(), "nope")); code == 0 {
		t.Fatalf("missing dir must fail:\n%s", out)
	}
	if out, code := runBin(exe); code == 0 {
		t.Fatalf("no -sessions flag must fail with usage:\n%s", out)
	}
}

func TestSimulatorBinaryRunsRepoSessions(t *testing.T) {
	exe := build(t)
	out, code := runBin(exe, "-sessions", filepath.Join("..", "..", "testdata", "sessions"))
	if code != 0 {
		t.Fatalf("repo session suite not green (exit %d):\n%s", code, out)
	}
	if !strings.Contains(out, "astm-upload-single-glucose") {
		t.Errorf("output must list sessions by name:\n%s", out)
	}
}

func TestSimulatorBinaryHasNoNetworkOrInsecureTLS(t *testing.T) {
	// 07-SECURITY / TRD 5.7: CI tool must not dial out or weaken TLS.
	src, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatalf("cmd/simulator/main.go missing: %v", err)
	}
	for _, bad := range []string{"InsecureSkipVerify", "net/http", "net.Dial"} {
		if strings.Contains(string(src), bad) {
			t.Errorf("cmd/simulator/main.go must not contain %q", bad)
		}
	}
}
