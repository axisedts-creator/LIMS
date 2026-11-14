package cli_test

import (
	"archive/zip"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"lims/apps/bridge-agent/internal/cli"
	"lims/apps/bridge-agent/internal/status"
)

// AC-22.2: `bridge-agent diagnostics --out <file>` writes a zip with status, redacted config (no token) and the last 7 days of logs;
// it contains no queue payloads. 04-UI-UX §2: never queue payloads, token or code.

const (
	queueMarker  = "QUEUEPAYLOAD-E2600000042-TESTPATIENT^SYNTHETIC"
	secretMarker = "SECRETBLOB-DPAPI-MARKER"
	proxyPw      = "S3cretProxyPw"
)

func writeFile(t *testing.T, p, body string, mtime time.Time) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(p, mtime, mtime); err != nil {
		t.Fatal(err)
	}
}

func diagFixture(t *testing.T, r *rig) {
	t.Helper()
	l := r.layout
	seedLayout(t, l)
	writeFile(t, filepath.Join(l.DataRoot, "queue", "agent.db"), queueMarker, now)
	writeFile(t, filepath.Join(l.DataRoot, "queue", "agent.db-wal"), queueMarker, now)
	writeFile(t, l.TokenFile(), secretMarker+testToken, now)
	writeFile(t, l.ConfigFile(),
		`{"server_url":"`+testServer+`","proxy_url":"https://user:`+proxyPw+`@proxy.example.np:3128","device_token":"`+testToken+`","enrolment_code":"`+testCode+`","token":"`+testToken2+`","password":"`+proxyPw+`"}`, now)
	writeFile(t, filepath.Join(l.LogsDir(), "agent.log"), `{"msg":"heartbeat ok","auth":"Bearer `+testToken+`"}`+"\n", now.Add(-time.Hour))
	writeFile(t, filepath.Join(l.LogsDir(), "agent.1.log"), `{"msg":"three days old"}`+"\n", now.Add(-3*24*time.Hour))
	writeFile(t, filepath.Join(l.LogsDir(), "agent.2.log"), `{"msg":"six days old"}`+"\n", now.Add(-6*24*time.Hour))
	writeFile(t, filepath.Join(l.LogsDir(), "agent.9.log"), `{"msg":"EIGHT-DAYS-OLD"}`+"\n", now.Add(-8*24*time.Hour))
	if err := status.Write(l.StatusDir(), sampleStatus()); err != nil {
		t.Fatal(err)
	}
	// the request fallback file and a stray temp file must not travel either
	writeFile(t, filepath.Join(l.StatusDir(), "request.json"), `{"kind":"flush_now"}`, now)
}

func readZip(t *testing.T, p string) map[string]string {
	t.Helper()
	zr, err := zip.OpenReader(p)
	if err != nil {
		t.Fatalf("not a valid zip: %v", err)
	}
	defer zr.Close()
	m := map[string]string{}
	for _, f := range zr.File {
		rc, err := f.Open()
		if err != nil {
			t.Fatal(err)
		}
		b, _ := io.ReadAll(rc)
		rc.Close()
		m[f.Name] = string(b)
	}
	return m
}

func TestDiagnosticsZipContentAndRedaction(t *testing.T) {
	r := newRig(t)
	diagFixture(t, r)
	out := filepath.Join(t.TempDir(), "diag.zip")
	code, msg := r.run("diagnostics", "--out", out)
	if code != cli.ExitOK {
		t.Fatalf("exit %d\n%s", code, msg)
	}
	entries := readZip(t, out)

	// shape: status.json, config/..., logs/... and nothing else
	var haveStatus, haveConfig, haveLog bool
	for name := range entries {
		switch {
		case name == "status.json":
			haveStatus = true
		case strings.HasPrefix(name, "config/"):
			haveConfig = true
		case strings.HasPrefix(name, "logs/"):
			haveLog = true
		default:
			t.Errorf("unexpected zip entry %q (only status.json, config/*, logs/* may travel)", name)
		}
		if strings.Contains(name, "..") || strings.HasPrefix(name, "/") || strings.Contains(name, `\`) || strings.Contains(name, ":") {
			t.Errorf("unsafe zip entry name %q", name)
		}
		low := strings.ToLower(name)
		if strings.Contains(low, "queue") || strings.Contains(low, "secrets") || strings.Contains(low, "device-token") || strings.HasSuffix(low, ".db") || strings.Contains(low, "request.json") {
			t.Errorf("forbidden entry %q", name)
		}
	}
	if !haveStatus || !haveConfig || !haveLog {
		t.Fatalf("zip lacks status=%v config=%v logs=%v; entries: %v", haveStatus, haveConfig, haveLog, keysOf(entries))
	}

	// 7-day window, relative to Deps.Now
	var logsText string
	for n, b := range entries {
		if strings.HasPrefix(n, "logs/") {
			logsText += b
		}
	}
	for _, want := range []string{"heartbeat ok", "three days old", "six days old"} {
		if !strings.Contains(logsText, want) {
			t.Errorf("logs lack %q", want)
		}
	}
	if strings.Contains(logsText, "EIGHT-DAYS-OLD") {
		t.Error("a log file older than 7 days was included")
	}

	// nothing secret anywhere in the archive
	all := ""
	for _, b := range entries {
		all += b + "\n"
	}
	for _, bad := range []string{queueMarker, "QUEUEPAYLOAD", "E2600000042", "TESTPATIENT", secretMarker, proxyPw, "lmsd_", "lmse_", testToken, testToken2, testCode} {
		if strings.Contains(all, bad) {
			t.Errorf("diagnostics zip contains %q", bad)
		}
	}
	// but the useful, non-secret parts are kept
	if !strings.Contains(all, testServer) || !strings.Contains(all, "proxy.example.np") {
		t.Error("redacted config lost the server URL / proxy host (redact secrets, not the whole file)")
	}
	if !strings.Contains(entries["status.json"], testAgent) {
		t.Error("status.json missing agent id")
	}
	for _, bad := range []string{"lmsd_", "lmse_", proxyPw} {
		if strings.Contains(msg, bad) {
			t.Errorf("CLI output leaks %q", bad)
		}
	}
}

func keysOf(m map[string]string) []string {
	var k []string
	for x := range m {
		k = append(k, x)
	}
	return k
}

func TestDiagnosticsRedactsTokenShapedStringsInAnyLogLine(t *testing.T) {
	r := newRig(t)
	seedLayout(t, r.layout)
	writeFile(t, filepath.Join(r.layout.LogsDir(), "agent.log"), "plain line\nuploader got "+testToken+" in an error\nenrol said "+testCode+" is used\n", now)
	if err := status.Write(r.layout.StatusDir(), sampleStatus()); err != nil {
		t.Fatal(err)
	}
	out := filepath.Join(t.TempDir(), "d.zip")
	if code, msg := r.run("diagnostics", "--out", out); code != cli.ExitOK {
		t.Fatalf("exit %d\n%s", code, msg)
	}
	var logs string
	for n, b := range readZip(t, out) {
		if strings.HasPrefix(n, "logs/") {
			logs += b
		}
	}
	if !strings.Contains(logs, "plain line") || strings.Contains(logs, "lmsd_") || strings.Contains(logs, "lmse_") {
		t.Fatalf("log egress redaction wrong:\n%s", logs)
	}
}

func TestDiagnosticsWorksWithoutLogsOrConfigAndRefusesOutsideInputs(t *testing.T) {
	r := newRig(t)
	seedLayout(t, r.layout)
	if err := status.Write(r.layout.StatusDir(), sampleStatus()); err != nil {
		t.Fatal(err)
	}
	out := filepath.Join(t.TempDir(), "d.zip")
	if code, msg := r.run("diagnostics", "--out", out); code != cli.ExitOK {
		t.Fatalf("exit %d\n%s", code, msg)
	}
	if _, ok := readZip(t, out)["status.json"]; !ok {
		t.Fatal("status.json missing")
	}
}

// The output file must never be placed where it could be mistaken for, or overwrite, agent data.
func TestDiagnosticsRefusesToWriteInsideTheDataRoot(t *testing.T) {
	r := newRig(t)
	diagFixture(t, r)
	for _, out := range []string{
		filepath.Join(r.layout.DataRoot, "queue", "agent.db"),
		filepath.Join(r.layout.DataRoot, "secrets", "device-token.bin"),
		filepath.Join(r.layout.DataRoot, "status", "status.json"),
	} {
		before, _ := os.ReadFile(out)
		code, msg := r.run("diagnostics", "--out", out)
		after, _ := os.ReadFile(out)
		if code == cli.ExitOK || string(before) != string(after) {
			t.Errorf("--out %s: exit %d, file changed=%v\n%s", out, code, string(before) != string(after), msg)
		}
	}
}
