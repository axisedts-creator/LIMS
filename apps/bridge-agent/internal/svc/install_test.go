package svc_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"lims/apps/bridge-agent/internal/secrets"
	"lims/apps/bridge-agent/internal/svc"
)

func install(r *rig, o svc.InstallOptions) (string, error) {
	var out bytes.Buffer
	err := svc.Install(context.Background(), r.env, o, &out)
	return out.String(), err
}

func noSecretsIn(t *testing.T, what, s string) {
	t.Helper()
	for _, bad := range []string{testCode, testToken, "lmsd_", "lmse_"} {
		if strings.Contains(s, bad) {
			t.Errorf("%s leaks a credential (%q)", what, bad)
		}
	}
}

// AC-01.4 happy path.
func TestInstallEnrolsStoresTokenDPAPIOnlyAndStartsInOrder(t *testing.T) {
	r := newRig(t)
	out, err := install(r, goodOpts())
	if err != nil {
		t.Fatalf("Install: %v\noutput:\n%s", err, out)
	}
	order := []string{"OSVersion", "PrepareFolders", "RegisterService", "StartService"}
	prev := -1
	for _, n := range order {
		i := r.plat.index(n)
		if i < 0 || i <= prev {
			t.Fatalf("call order = %v, want %v in that order", r.plat.names(), order)
		}
		prev = i
	}
	if len(r.enrol.reqs) != 1 {
		t.Fatalf("enrolAgent called %d times", len(r.enrol.reqs))
	}
	q := r.enrol.reqs[0]
	if q.Server != testServer || q.Code != testCode || q.HostFingerprintSHA256 != fp64 || q.AgentVersion != "1.0.0" || q.LauncherVersion != "1.0.0" || q.OSVersion == "" || len(q.OSVersion) > 64 {
		t.Fatalf("enrol request = %+v (E01 body: host_fingerprint_sha256, agent_version, launcher_version, os_version <= 64)", q)
	}
	// the token is on disk only as a wrapped blob, wrapped with the agent id as entropy
	blob, err := os.ReadFile(r.layout.TokenFile())
	if err != nil {
		t.Fatalf("token file missing: %v", err)
	}
	if bytes.Contains(blob, []byte(testToken)) || bytes.Contains(blob, []byte("lmsd_")) {
		t.Fatal("device token written in plaintext (REQ-SEC-118)")
	}
	got, err := secrets.LoadToken(r.layout.SecretsDir(), fakeProtector{entropy: []byte(testAgent)})
	if err != nil || got != testToken {
		t.Fatalf("token does not unwrap with entropy = agent id: %q, %v", got, err)
	}
	if _, err := secrets.LoadToken(r.layout.SecretsDir(), fakeProtector{entropy: []byte("other-agent")}); err == nil {
		t.Fatal("token unwraps with the wrong entropy")
	}
	var sawAgentEntropy bool
	for _, e := range *r.prot {
		if string(e) == testAgent {
			sawAgentEntropy = true
		}
	}
	if !sawAgentEntropy {
		t.Fatalf("NewProtector never got the agent id as entropy: %q", *r.prot)
	}
	noSecretsIn(t, "install output", out)
	if !strings.Contains(out, "Installed") {
		t.Errorf("output lacks the final 'Installed' line:\n%s", out)
	}
	if !strings.Contains(out, "LimsBridgeAgent") {
		t.Errorf("output lacks the service registration progress line:\n%s", out)
	}
}

func TestInstallRegistersVirtualAccountByDefault(t *testing.T) {
	r := newRig(t)
	if _, err := install(r, goodOpts()); err != nil {
		t.Fatal(err)
	}
	if r.plat.cfg.Account != svc.VirtualAccount || r.plat.account != svc.VirtualAccount {
		t.Fatalf("account = %q (folders %q), want %q", r.plat.cfg.Account, r.plat.account, svc.VirtualAccount)
	}
	if r.plat.cfg.Binary != r.layout.LauncherExe() || !r.plat.cfg.DelayedAutoStart || len(r.plat.cfg.Recovery) != 3 {
		t.Fatalf("service config = %+v", r.plat.cfg)
	}
}

func TestInstallAccountLocalServiceFallback(t *testing.T) {
	r := newRig(t)
	o := goodOpts()
	o.Account = "localservice"
	if _, err := install(r, o); err != nil {
		t.Fatal(err)
	}
	if r.plat.cfg.Account != svc.LocalServiceAccount || r.plat.account != svc.LocalServiceAccount {
		t.Fatalf("account = %q (folders %q), want %q", r.plat.cfg.Account, r.plat.account, svc.LocalServiceAccount)
	}
}

// No listener / no firewall rule by default; opt-in only with --allow-lan-listener (02-TRD 5.12, REQ-SEC-114).
func TestInstallCreatesNoFirewallRuleByDefault(t *testing.T) {
	r := newRig(t)
	if _, err := install(r, goodOpts()); err != nil {
		t.Fatal(err)
	}
	if r.plat.index("AddFirewallRule") >= 0 {
		t.Fatalf("a firewall rule was created without --allow-lan-listener: %v", r.plat.names())
	}
}

func TestInstallAllowLANListenerAddsProgramScopedRule(t *testing.T) {
	r := newRig(t)
	o := goodOpts()
	o.AllowLANListener = true
	if _, err := install(r, o); err != nil {
		t.Fatal(err)
	}
	if r.plat.index("AddFirewallRule") < 0 || r.plat.fwExe != r.layout.LauncherExe() {
		t.Fatalf("firewall rule not added for the launcher: calls %v exe %q", r.plat.names(), r.plat.fwExe)
	}
}

func TestInstallWritesConfigLocalWithoutCredentials(t *testing.T) {
	r := newRig(t)
	o := goodOpts()
	o.Proxy = "http://proxy.example.np:3128"
	if _, err := install(r, o); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(r.layout.ConfigFile())
	if err != nil {
		t.Fatalf("config.local.json missing: %v", err)
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatalf("config.local.json is not a JSON object: %v", err)
	}
	s := string(raw)
	if !strings.Contains(s, testServer) || !strings.Contains(s, "proxy.example.np:3128") {
		t.Errorf("config.local.json lacks server or proxy: %s", s)
	}
	noSecretsIn(t, "config.local.json", s)
}

func TestInstallWithoutProxyWritesNoProxy(t *testing.T) {
	r := newRig(t)
	if _, err := install(r, goodOpts()); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(r.layout.ConfigFile())
	if strings.Contains(strings.ToLower(string(raw)), "proxy.") {
		t.Errorf("unexpected proxy in config: %s", raw)
	}
}

func TestInstallRefusesWhenNotElevatedBeforeTouchingAnything(t *testing.T) {
	r := newRig(t)
	r.plat.elevated = false
	_, err := install(r, goodOpts())
	if !errors.Is(err, svc.ErrNotElevated) {
		t.Fatalf("err = %v, want ErrNotElevated", err)
	}
	if m := r.plat.mutating(); len(m) != 0 || len(r.enrol.reqs) != 0 {
		t.Fatalf("machine touched while not elevated: %v, enrol calls %d", m, len(r.enrol.reqs))
	}
}

// LD-93: supported set is Windows 10 and 11. Anything older is refused before any change.
func TestInstallRefusesUnsupportedWindows(t *testing.T) {
	for name, v := range map[string]svc.OSVersion{
		"Windows 7":   {Major: 6, Minor: 1, Build: 7601, Name: "Windows 7"},
		"Windows 8.1": {Major: 6, Minor: 3, Build: 9600, Name: "Windows 8.1"},
	} {
		r := newRig(t)
		r.plat.ver = v
		_, err := install(r, goodOpts())
		if !errors.Is(err, svc.ErrUnsupportedOS) {
			t.Errorf("%s: err = %v, want ErrUnsupportedOS", name, err)
		}
		if m := r.plat.mutating(); len(m) != 0 {
			t.Errorf("%s: machine touched: %v", name, m)
		}
	}
}

func TestInstallAcceptsWindows10And11(t *testing.T) {
	for name, v := range map[string]svc.OSVersion{
		"Windows 10 22H2":  {Major: 10, Build: 19045, Name: "Windows 10"},
		"Windows 11 26300": {Major: 10, Build: 26300, Name: "Windows 11"},
	} {
		r := newRig(t)
		r.plat.ver = v
		if out, err := install(r, goodOpts()); err != nil {
			t.Errorf("%s: %v\n%s", name, err, out)
		}
	}
}

func TestInstallRejectsBadOptionsWithoutTouchingAnything(t *testing.T) {
	bad := map[string]svc.InstallOptions{
		"http server":          {Server: "http://lims.example.np", EnrolmentCode: testCode},
		"no scheme":            {Server: "lims.example.np", EnrolmentCode: testCode},
		"ftp server":           {Server: "ftp://lims.example.np", EnrolmentCode: testCode},
		"empty server":         {Server: "", EnrolmentCode: testCode},
		"userinfo in server":   {Server: "https://user:pw@lims.example.np", EnrolmentCode: testCode},
		"empty host":           {Server: "https://", EnrolmentCode: testCode},
		"code too short":       {Server: testServer, EnrolmentCode: "lmse_short"},
		"device token as code": {Server: testServer, EnrolmentCode: testToken},
		"empty code":           {Server: testServer, EnrolmentCode: ""},
		"code with space":      {Server: testServer, EnrolmentCode: "lmse_AbCdEfGhIjKlMnOpQrSt U"},
		"unknown account":      {Server: testServer, EnrolmentCode: testCode, Account: "system"},
		"proxy file scheme":    {Server: testServer, EnrolmentCode: testCode, Proxy: "file:///c:/x"},
		"proxy no scheme":      {Server: testServer, EnrolmentCode: testCode, Proxy: "proxy.example.np:3128"},
	}
	for name, o := range bad {
		r := newRig(t)
		out, err := install(r, o)
		if !errors.Is(err, svc.ErrInvalidOptions) {
			t.Errorf("%s: err = %v, want ErrInvalidOptions", name, err)
		}
		if m := r.plat.mutating(); len(m) != 0 || len(r.enrol.reqs) != 0 {
			t.Errorf("%s: machine touched: %v, enrol %d", name, m, len(r.enrol.reqs))
		}
		if _, statErr := os.Stat(r.layout.DataRoot); statErr == nil {
			t.Errorf("%s: data root created", name)
		}
		noSecretsIn(t, name+" output", out)
		if err != nil {
			noSecretsIn(t, name+" error", err.Error())
		}
	}
}

// AC-01.4: a response whose token is not lmsd_ + 43 base64url is never stored and the service is never started.
func TestInstallRejectsMalformedTokenFromServer(t *testing.T) {
	for _, tok := range []string{"", "lmsd_short", "abc", strings.Replace(testToken, "lmsd_", "lmse_", 1), testToken + "x", "lmsd_" + strings.Repeat("!", 43)} {
		r := newRig(t)
		r.enrol.res.DeviceToken = tok
		out, err := install(r, goodOpts())
		if err == nil {
			t.Errorf("token %q accepted", tok)
		}
		if _, statErr := os.Stat(r.layout.TokenFile()); statErr == nil {
			t.Errorf("token %q: a token file was written", tok)
		}
		if r.plat.index("StartService") >= 0 {
			t.Errorf("token %q: service started although enrolment failed", tok)
		}
		noSecretsIn(t, "output for bad token", out)
	}
}

func TestInstallEnrolFailureStoresNothingStartsNothingLeaksNothing(t *testing.T) {
	r := newRig(t)
	r.enrol.err = errors.New("401 auth.device_token_invalid for " + testCode) // a careless server/transport error that echoes the code
	out, err := install(r, goodOpts())
	if err == nil {
		t.Fatal("expected an error")
	}
	if _, statErr := os.Stat(r.layout.TokenFile()); statErr == nil {
		t.Error("token file exists after a failed enrolment")
	}
	if r.plat.index("StartService") >= 0 {
		t.Error("service started after a failed enrolment")
	}
	noSecretsIn(t, "output", out)
	noSecretsIn(t, "returned error", err.Error())
}

func TestInstallPropagatesFolderAndRegistrationFailures(t *testing.T) {
	r := newRig(t)
	r.plat.verErr = errors.New("version probe failed")
	if _, err := install(r, goodOpts()); err == nil {
		t.Fatal("OS version probe failure must fail the install (fail closed)")
	}
	if len(r.plat.mutating()) != 0 {
		t.Fatalf("machine touched after a failed OS probe: %v", r.plat.mutating())
	}
}

func TestInstallHonoursCancelledContext(t *testing.T) {
	r := newRig(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	err := svc.Install(ctx, r.env, goodOpts(), &bytes.Buffer{})
	if err == nil {
		t.Fatal("a cancelled context must stop the install")
	}
	if r.plat.index("StartService") >= 0 {
		t.Fatal("service started with a cancelled context")
	}
}

// ---------------------------------------------------------------- uninstall

func seedData(t *testing.T, l svc.Layout) {
	t.Helper()
	for _, d := range l.Dirs() {
		if err := os.MkdirAll(d, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	for _, f := range []string{filepath.Join(l.DataRoot, "queue", "agent.db"), l.TokenFile()} {
		if err := os.WriteFile(f, []byte("synthetic"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
}

func uninstall(r *rig, o svc.UninstallOptions, pending func() (int, error)) error {
	return svc.Uninstall(context.Background(), r.env, o, pending, &bytes.Buffer{})
}

func zero() (int, error) { return 0, nil }

func exists(p string) bool { _, err := os.Stat(p); return err == nil }

func TestUninstallKeepsDataByDefaultAndRemovesRule(t *testing.T) {
	r := newRig(t)
	seedData(t, r.layout)
	if err := uninstall(r, svc.UninstallOptions{}, func() (int, error) { return 5, nil }); err != nil {
		t.Fatal(err)
	}
	for _, c := range []string{"StopService", "RemoveService", "RemoveFirewallRule"} {
		if r.plat.index(c) < 0 {
			t.Errorf("%s not called: %v", c, r.plat.names())
		}
	}
	if !exists(r.layout.TokenFile()) || !exists(filepath.Join(r.layout.DataRoot, "queue", "agent.db")) {
		t.Fatal("uninstall without --purge deleted queue or secrets (pending data would be lost)")
	}
}

func TestUninstallPurgeRefusedWhilePendingItemsExist(t *testing.T) {
	r := newRig(t)
	seedData(t, r.layout)
	err := uninstall(r, svc.UninstallOptions{Purge: true}, func() (int, error) { return 3, nil })
	var pe *svc.PendingError
	if !errors.As(err, &pe) || pe.Count != 3 || !strings.Contains(err.Error(), "3") {
		t.Fatalf("err = %v, want *PendingError{Count:3} whose text shows the count", err)
	}
	if m := r.plat.mutating(); len(m) != 0 {
		t.Fatalf("service touched although the purge was refused: %v", m)
	}
	if !exists(r.layout.DataRoot) || !exists(r.layout.TokenFile()) {
		t.Fatal("data removed although the purge was refused")
	}
}

func TestUninstallPurgeFailsClosedWhenPendingCountUnknown(t *testing.T) {
	r := newRig(t)
	seedData(t, r.layout)
	err := uninstall(r, svc.UninstallOptions{Purge: true}, func() (int, error) { return 0, errors.New("queue locked") })
	if err == nil || !exists(r.layout.DataRoot) || len(r.plat.mutating()) != 0 {
		t.Fatalf("purge went ahead without a known pending count: err=%v calls=%v", err, r.plat.mutating())
	}
}

func TestUninstallPurgeWithForceDiscardsPending(t *testing.T) {
	r := newRig(t)
	seedData(t, r.layout)
	if err := uninstall(r, svc.UninstallOptions{Purge: true, ForceDiscardPending: true}, func() (int, error) { return 3, nil }); err != nil {
		t.Fatal(err)
	}
	if exists(r.layout.DataRoot) {
		t.Fatal("data root still there after --purge --force-discard-pending")
	}
	if r.plat.index("RemoveService") < 0 {
		t.Fatal("service not removed")
	}
}

func TestUninstallPurgeWithNothingPending(t *testing.T) {
	r := newRig(t)
	seedData(t, r.layout)
	if err := uninstall(r, svc.UninstallOptions{Purge: true}, zero); err != nil {
		t.Fatal(err)
	}
	if exists(r.layout.DataRoot) {
		t.Fatal("data root still there after --purge with nothing pending")
	}
}

// A purge must only ever delete the BridgeAgent data root, never an arbitrary directory.
func TestUninstallPurgeRefusesWrongDataRoot(t *testing.T) {
	r := newRig(t)
	victim := t.TempDir()
	lookalike := filepath.Join(victim, "BridgeAgent") // right last element, but not <x>\LIMS\BridgeAgent
	if err := os.MkdirAll(lookalike, 0o700); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(lookalike, "keep.txt")
	if err := os.WriteFile(marker, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, root := range []string{victim, lookalike, ""} {
		r.env.Layout = svc.Layout{DataRoot: root, ProgramDir: r.layout.ProgramDir}
		err := uninstall(r, svc.UninstallOptions{Purge: true, ForceDiscardPending: true}, zero)
		if err == nil {
			t.Errorf("purge accepted DataRoot %q", root)
		}
		if !exists(marker) {
			t.Fatalf("purge with DataRoot %q deleted files outside the BridgeAgent folder", root)
		}
	}
}

func TestUninstallRefusesWhenNotElevated(t *testing.T) {
	r := newRig(t)
	r.plat.elevated = false
	seedData(t, r.layout)
	err := uninstall(r, svc.UninstallOptions{Purge: true, ForceDiscardPending: true}, zero)
	if !errors.Is(err, svc.ErrNotElevated) || len(r.plat.mutating()) != 0 || !exists(r.layout.DataRoot) {
		t.Fatalf("err=%v calls=%v", err, r.plat.mutating())
	}
}
