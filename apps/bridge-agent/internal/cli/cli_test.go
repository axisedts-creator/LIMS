package cli_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"lims/apps/bridge-agent/internal/cli"
	"lims/apps/bridge-agent/internal/secrets"
	"lims/apps/bridge-agent/internal/status"
	"lims/apps/bridge-agent/internal/svc"
)

func TestExitCodeConstants(t *testing.T) {
	if cli.ExitOK != 0 || cli.ExitUsage != 1 || cli.ExitFailed != 2 || cli.ExitNotElevated != 3 {
		t.Fatalf("exit codes = %d %d %d %d, want 0 1 2 3 (04-UI-UX §2)", cli.ExitOK, cli.ExitUsage, cli.ExitFailed, cli.ExitNotElevated)
	}
}

// ---- usage errors never touch the machine (exit 1)

func TestUsageErrors(t *testing.T) {
	cases := map[string][]string{
		"no args":                 {},
		"unknown command":         {"frobnicate"},
		"install without flags":   {"install"},
		"install no code":         {"install", "--server", testServer},
		"install no server":       {"install", "--enrolment-code", testCode},
		"install http":            {"install", "--server", "http://lims.example.np", "--enrolment-code", testCode},
		"install ftp":             {"install", "--server", "ftp://lims.example.np", "--enrolment-code", testCode},
		"install userinfo":        {"install", "--server", "https://u:p@lims.example.np", "--enrolment-code", testCode},
		"install bad code":        {"install", "--server", testServer, "--enrolment-code", "lmse_short"},
		"install token as code":   {"install", "--server", testServer, "--enrolment-code", testToken},
		"install bad account":     {"install", "--server", testServer, "--enrolment-code", testCode, "--account", "system"},
		"install bad proxy":       {"install", "--server", testServer, "--enrolment-code", testCode, "--proxy", "file:///c:/x"},
		"install unknown flag":    {"install", "--server", testServer, "--enrolment-code", testCode, "--bogus"},
		"enrol no code":           {"enrol"},
		"enrol bad code":          {"enrol", "--enrolment-code", "nope"},
		"status unknown flag":     {"status", "--bogus"},
		"diagnostics without out": {"diagnostics"},
		"diagnostics empty out":   {"diagnostics", "--out", ""},
		"firewall bare":           {"firewall"},
		"firewall bad verb":       {"firewall", "open"},
		"uninstall unknown flag":  {"uninstall", "--bogus"},
		"flush extra arg":         {"flush", "now"},
	}
	for name, args := range cases {
		r := newRig(t)
		code, out := r.run(args...)
		if code != cli.ExitUsage {
			t.Errorf("%s: exit %d, want 1\n%s", name, code, out)
		}
		if m := r.plat.mutating(); len(m) != 0 || len(r.enrol.reqs) != 0 {
			t.Errorf("%s: machine touched on a usage error: %v enrol=%d", name, m, len(r.enrol.reqs))
		}
		if exists(r.layout.DataRoot) {
			t.Errorf("%s: data root created on a usage error", name)
		}
		if strings.TrimSpace(out) == "" {
			t.Errorf("%s: a usage error must say what is wrong", name)
		}
		r.noCredentialsPrinted()
	}
}

// ---- elevation (exit 3), `version` is the one exception

func TestNotElevated(t *testing.T) {
	cmds := map[string][]string{
		"install":     {"install", "--server", testServer, "--enrolment-code", testCode},
		"enrol":       {"enrol", "--enrolment-code", testCode},
		"status":      {"status"},
		"flush":       {"flush"},
		"diagnostics": {"diagnostics", "--out", filepath.Join(os.TempDir(), "never-written-ag-t15.zip")},
		"fw enable":   {"firewall", "enable"},
		"fw disable":  {"firewall", "disable"},
		"uninstall":   {"uninstall", "--purge", "--force-discard-pending"},
	}
	for name, args := range cmds {
		r := newRig(t)
		r.plat.elevated = false
		seedLayout(t, r.layout)
		code, out := r.run(args...)
		if code != cli.ExitNotElevated {
			t.Errorf("%s: exit %d, want 3\n%s", name, code, out)
		}
		if m := r.plat.mutating(); len(m) != 0 || len(r.enrol.reqs) != 0 {
			t.Errorf("%s: acted while not elevated: %v", name, m)
		}
		if !exists(r.layout.TokenFile()) {
			t.Errorf("%s: data deleted while not elevated", name)
		}
		r.noCredentialsPrinted()
	}
	if exists(filepath.Join(os.TempDir(), "never-written-ag-t15.zip")) {
		t.Error("diagnostics wrote a file while not elevated")
	}
}

func TestVersionNeedsNoElevation(t *testing.T) {
	r := newRig(t)
	r.plat.elevated = false
	code, out := r.run("version")
	if code != cli.ExitOK {
		t.Fatalf("exit %d\n%s", code, out)
	}
	for _, want := range []string{"1.0.0", "1.0.1", "abc1234"} {
		if !strings.Contains(out, want) {
			t.Errorf("version output lacks %q:\n%s", want, out)
		}
	}
	if m := r.plat.mutating(); len(m) != 0 {
		t.Errorf("version touched the machine: %v", m)
	}
}

func seedLayout(t *testing.T, l svc.Layout) {
	t.Helper()
	for _, d := range l.Dirs() {
		if err := os.MkdirAll(d, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(l.TokenFile(), []byte("synthetic-blob"), 0o600); err != nil {
		t.Fatal(err)
	}
}

// ---- install (AC-01.4)

func TestInstallHappyPath(t *testing.T) {
	r := newRig(t)
	code, out := r.run("install", "--server", testServer, "--enrolment-code", testCode)
	if code != cli.ExitOK {
		t.Fatalf("exit %d\n%s", code, out)
	}
	for _, c := range []string{"PrepareFolders", "RegisterService", "StartService"} {
		if !r.plat.has(c) {
			t.Errorf("%s not called: %v", c, r.plat.names())
		}
	}
	if r.plat.has("AddFirewallRule") {
		t.Error("firewall rule created by default")
	}
	if len(r.enrol.reqs) != 1 || r.enrol.reqs[0].Code != testCode || r.enrol.reqs[0].Server != testServer {
		t.Fatalf("enrol requests = %+v", r.enrol.reqs)
	}
	blob, err := os.ReadFile(r.layout.TokenFile())
	if err != nil || strings.Contains(string(blob), "lmsd_") {
		t.Fatalf("token file: err=%v plaintext=%v", err, strings.Contains(string(blob), "lmsd_"))
	}
	if got, err := secrets.LoadToken(r.layout.SecretsDir(), fakeProtector{entropy: []byte(testAgent)}); err != nil || got != testToken {
		t.Fatalf("stored token = %q, %v", got, err)
	}
	if !strings.Contains(out, "Installed") {
		t.Errorf("no final 'Installed' line:\n%s", out)
	}
	r.noCredentialsPrinted()
}

func TestInstallFlags(t *testing.T) {
	r := newRig(t)
	code, out := r.run("install", "--server", testServer, "--enrolment-code", testCode, "--account", "localservice", "--allow-lan-listener", "--proxy", "http://proxy.example.np:3128")
	if code != cli.ExitOK {
		t.Fatalf("exit %d\n%s", code, out)
	}
	if !r.plat.has("AddFirewallRule") || r.plat.fwExe != r.layout.LauncherExe() {
		t.Errorf("--allow-lan-listener did not add the launcher-scoped rule: %v %q", r.plat.names(), r.plat.fwExe)
	}
	raw, _ := os.ReadFile(r.layout.ConfigFile())
	if !strings.Contains(string(raw), "proxy.example.np:3128") {
		t.Errorf("proxy not in config.local.json: %s", raw)
	}
	r.noCredentialsPrinted()
}

func TestInstallEnrolFailureExitsFailedAndLeaksNothing(t *testing.T) {
	r := newRig(t)
	r.enrol.err = errString("401 auth.device_token_invalid for " + testCode)
	code, out := r.run("install", "--server", testServer, "--enrolment-code", testCode)
	if code != cli.ExitFailed {
		t.Fatalf("exit %d, want 2\n%s", code, out)
	}
	if exists(r.layout.TokenFile()) || r.plat.has("StartService") {
		t.Error("token stored or service started after a failed enrolment")
	}
	r.noCredentialsPrinted()
}

type errString string

func (e errString) Error() string { return string(e) }

// ---- enrol (re-enrol after revocation / new PC)

func TestEnrolReplacesTokenAndKeepsOldOneOnFailure(t *testing.T) {
	r := newRig(t)
	r.installed()
	p := fakeProtector{entropy: []byte(testAgent)}

	r.enrol.err = errString("401 for " + testCode2)
	if code, out := r.run("enrol", "--enrolment-code", testCode2); code != cli.ExitFailed {
		t.Fatalf("failed enrol: exit %d\n%s", code, out)
	}
	if got, err := secrets.LoadToken(r.layout.SecretsDir(), p); err != nil || got != testToken {
		t.Fatalf("a failed re-enrolment damaged the existing token: %q, %v", got, err)
	}

	r.enrol.err = nil
	r.enrol.res.DeviceToken = testToken2
	if code, out := r.run("enrol", "--enrolment-code", testCode2); code != cli.ExitOK {
		t.Fatalf("enrol: exit %d\n%s", code, out)
	}
	if n := len(r.enrol.reqs); r.enrol.reqs[n-1].Code != testCode2 || r.enrol.reqs[n-1].Server != testServer {
		t.Fatalf("re-enrol request = %+v (server must come from the installed config.local.json)", r.enrol.reqs[n-1])
	}
	if got, err := secrets.LoadToken(r.layout.SecretsDir(), p); err != nil || got != testToken2 {
		t.Fatalf("token after re-enrol = %q, %v", got, err)
	}
	blob, _ := os.ReadFile(r.layout.TokenFile())
	if strings.Contains(string(blob), "lmsd_") {
		t.Fatal("plaintext token after re-enrol")
	}
	r.noCredentialsPrinted()
}

func TestEnrolWithoutInstallFails(t *testing.T) {
	r := newRig(t)
	code, out := r.run("enrol", "--enrolment-code", testCode)
	if code != cli.ExitFailed {
		t.Fatalf("exit %d, want 2 (not installed)\n%s", code, out)
	}
	if len(r.enrol.reqs) != 0 || exists(r.layout.TokenFile()) {
		t.Error("enrolment attempted without an installation")
	}
	r.noCredentialsPrinted()
}

// ---- status (AC-22.1)

func sampleStatus() status.Status {
	return status.Status{
		ServiceState: "RUNNING", AgentID: testAgent, AgentVersion: "1.0.0", LauncherVersion: "1.0.1", ServerReachable: true,
		LastHeartbeatAt: "2026-11-11T08:29:48.000Z", LastHeartbeatOutcome: "ok", AuthState: "ok", ConfigVersion: 7, ConfigState: "applied", UpdateState: "idle",
		Queue:      status.Queue{Pending: 0, Uploading: 0, Rejected: 1, Oversize: 0, UploadedRetained: 1204},
		DiskFreeMB: 41230,
		Instruments: []status.Instrument{
			{InstrumentCode: "SIM-CHEM-1", LinkState: "up", LastMessageAtAgent: "2026-11-11T08:28:00.000Z", MessagesToday: 9},
			{InstrumentCode: "SIM-HEMA-1", LinkState: "connecting", LastMessageAtAgent: "2026-11-11T05:30:00.000Z", LastErrorCode: "tcp_connect_refused"},
		},
		Counters: map[string]int64{"astm_naks_sent": 2},
	}
}

func TestStatusPrintsTheAC221Fields(t *testing.T) {
	r := newRig(t)
	seedLayout(t, r.layout)
	if err := status.Write(r.layout.StatusDir(), sampleStatus()); err != nil {
		t.Fatal(err)
	}
	code, out := r.run("status")
	if code != cli.ExitOK {
		t.Fatalf("exit %d\n%s", code, out)
	}
	for _, want := range []string{
		"RUNNING",          // service state
		testAgent,          // agent id
		"1.0.0",            // agent version
		"reachable",        // server reachability
		"ok",               // last heartbeat result
		"rejected 1",       // queue counts by state
		"pending 0",        //
		"SIM-CHEM-1", "up", // per-instrument link state
		"SIM-HEMA-1", "connecting", //
		"tcp_connect_refused", // last error code
		"7",                   // config version
		"idle",                // update state
	} {
		if !strings.Contains(out, want) {
			t.Errorf("status output lacks %q:\n%s", want, out)
		}
	}
	r.noCredentialsPrinted()
}

func TestStatusJSONMatchesStatusFile(t *testing.T) {
	r := newRig(t)
	seedLayout(t, r.layout)
	want := sampleStatus()
	if err := status.Write(r.layout.StatusDir(), want); err != nil {
		t.Fatal(err)
	}
	code, out := r.run("status", "--json")
	if code != cli.ExitOK {
		t.Fatalf("exit %d\n%s", code, out)
	}
	var got status.Status
	if err := json.Unmarshal([]byte(out), &got); err != nil {
		t.Fatalf("--json output is not a single JSON document: %v\n%s", err, out)
	}
	a, _ := json.Marshal(want)
	b, _ := json.Marshal(got)
	if string(a) != string(b) {
		t.Fatalf("--json differs from status.json:\n want %s\n  got %s", a, b)
	}
}

func TestStatusWhenServiceNeverWroteTheFile(t *testing.T) {
	r := newRig(t)
	seedLayout(t, r.layout)
	code, out := r.run("status")
	if code != cli.ExitFailed || strings.TrimSpace(out) == "" {
		t.Fatalf("exit %d, want 2 with a message\n%s", code, out)
	}
}

// 04-UI-UX 2.1: "No barcodes, values, names or file names are ever printed." The status schema has no such field; this guards the printer
// against reaching for anything else (e.g. dumping the raw file or the queue).
func TestStatusOutputContainsNoPHIOrSecrets(t *testing.T) {
	r := newRig(t)
	seedLayout(t, r.layout)
	if err := os.WriteFile(filepath.Join(r.layout.DataRoot, "queue", "agent.db"), []byte("E2600000042 TESTPATIENT^SYNTHETIC"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := status.Write(r.layout.StatusDir(), sampleStatus()); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{{"status"}, {"status", "--json"}} {
		_, out := r.run(args...)
		for _, bad := range []string{"E2600000042", "TESTPATIENT", "synthetic-blob", "device-token", ".db"} {
			if strings.Contains(out, bad) {
				t.Errorf("%v prints %q:\n%s", args, bad, out)
			}
		}
	}
}

// ---- flush: custom control 129, fallback request.json (02-TRD 5.12)

func TestFlushUsesControl129(t *testing.T) {
	r := newRig(t)
	seedLayout(t, r.layout)
	if code, out := r.run("flush"); code != cli.ExitOK {
		t.Fatalf("exit %d\n%s", code, out)
	}
	if len(r.plat.ctlCodes) != 1 || r.plat.ctlCodes[0] != svc.CtlFlushNow {
		t.Fatalf("control codes sent = %v, want [129]", r.plat.ctlCodes)
	}
	if exists(r.layout.RequestFile()) {
		t.Error("request.json written although the control reached the service")
	}
}

func TestFlushFallsBackToRequestJSON(t *testing.T) {
	r := newRig(t)
	seedLayout(t, r.layout)
	r.plat.ctlErr = errString("control not delivered")
	if code, out := r.run("flush"); code != cli.ExitOK {
		t.Fatalf("exit %d\n%s", code, out)
	}
	raw, err := os.ReadFile(r.layout.RequestFile())
	if err != nil {
		t.Fatalf("fallback request.json missing: %v", err)
	}
	var m map[string]any
	if json.Unmarshal(raw, &m) != nil || m["kind"] != svc.RequestFlushNow {
		t.Fatalf("request.json = %s", raw)
	}
}

func TestFlushFailsWhenNeitherPathWorks(t *testing.T) {
	r := newRig(t)
	r.plat.ctlErr = errString("control not delivered")
	// no status dir at all: the fallback cannot be written either
	if code, out := r.run("flush"); code != cli.ExitFailed {
		t.Fatalf("exit %d, want 2\n%s", code, out)
	}
}

// ---- firewall

func TestFirewallEnableDisable(t *testing.T) {
	r := newRig(t)
	if code, out := r.run("firewall", "enable"); code != cli.ExitOK || !r.plat.has("AddFirewallRule") || r.plat.fwExe != r.layout.LauncherExe() {
		t.Fatalf("enable: exit %d calls %v exe %q\n%s", code, r.plat.names(), r.plat.fwExe, out)
	}
	if code, out := r.run("firewall", "disable"); code != cli.ExitOK || !r.plat.has("RemoveFirewallRule") {
		t.Fatalf("disable: exit %d calls %v\n%s", code, r.plat.names(), out)
	}
}

// ---- uninstall

func TestUninstallKeepsDataWithoutPurge(t *testing.T) {
	r := newRig(t)
	seedLayout(t, r.layout)
	r.pending = 4
	if code, out := r.run("uninstall"); code != cli.ExitOK {
		t.Fatalf("exit %d\n%s", code, out)
	}
	if !r.plat.has("RemoveService") || !r.plat.has("RemoveFirewallRule") || !exists(r.layout.TokenFile()) {
		t.Fatalf("calls %v, token kept=%v", r.plat.names(), exists(r.layout.TokenFile()))
	}
}

func TestUninstallPurgeRefusedWithPendingShowsCount(t *testing.T) {
	r := newRig(t)
	seedLayout(t, r.layout)
	r.pending = 7
	code, out := r.run("uninstall", "--purge")
	if code != cli.ExitFailed || !strings.Contains(out, "7") {
		t.Fatalf("exit %d, want 2 and the count 7 in the text:\n%s", code, out)
	}
	if len(r.plat.mutating()) != 0 || !exists(r.layout.TokenFile()) {
		t.Fatalf("anything removed although refused: %v", r.plat.mutating())
	}
}

func TestUninstallPurgeForceAndPurgeClean(t *testing.T) {
	r := newRig(t)
	seedLayout(t, r.layout)
	r.pending = 7
	if code, out := r.run("uninstall", "--purge", "--force-discard-pending"); code != cli.ExitOK || exists(r.layout.DataRoot) {
		t.Fatalf("forced purge: exit %d, data root exists=%v\n%s", code, exists(r.layout.DataRoot), out)
	}
	r2 := newRig(t)
	seedLayout(t, r2.layout)
	if code, out := r2.run("uninstall", "--purge"); code != cli.ExitOK || exists(r2.layout.DataRoot) {
		t.Fatalf("clean purge: exit %d, data root exists=%v\n%s", code, exists(r2.layout.DataRoot), out)
	}
}

func TestUninstallForceWithoutPurgeIsHarmless(t *testing.T) {
	r := newRig(t)
	seedLayout(t, r.layout)
	r.pending = 2
	r.run("uninstall", "--force-discard-pending")
	if !exists(r.layout.TokenFile()) {
		t.Fatal("--force-discard-pending alone deleted data")
	}
}
