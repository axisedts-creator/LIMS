package cli_test

// Shared fakes for AG-T15 (package cli, 04-UI-UX §2, AC-01.4, AC-22.1, AC-22.2). They also document the API the implementation must provide:
//
//	const ExitOK = 0; ExitUsage = 1; ExitFailed = 2; ExitNotElevated = 3
//	type VersionInfo struct{ Agent, Launcher, Build string }
//	type Deps struct {
//	    Out, Err io.Writer
//	    Env      svc.Env                       // Platform (IsElevated, SendControl, firewall, service), Enroller, Layout, NewProtector, versions, HostFingerprint
//	    Pending  func() (int, error)           // pending + rejected queue items, for `uninstall --purge`
//	    Version  VersionInfo
//	    Now      func() time.Time              // "last 7 days" of logs is relative to this
//	}
//	func Run(args []string, d Deps) int        // args exclude the program name; exit codes per 04-UI-UX §2: 0 ok, 1 usage, 2 failed, 3 not elevated
//
// Commands covered here: install, enrol, status [--json], flush, diagnostics --out <zip>, firewall enable|disable, uninstall [--purge] [--force-discard-pending], version.
// `version` is the only command that does not need elevation. Elevation is checked (exit 3) before anything else runs for every other command.
// A usage error (exit 1) never touches the machine. No command ever prints a device token or an enrolment code, not even inside an error.
// Assumption (CR-free): `--force-discard-pending` is a boolean flag; the refusal text shows the pending count.

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"lims/apps/bridge-agent/internal/cli"
	"lims/apps/bridge-agent/internal/secrets"
	"lims/apps/bridge-agent/internal/svc"
)

const (
	testServer = "https://lims.example.np"
	testCode   = "lmse_AbCdEfGhIjKlMnOpQrStUv"
	testCode2  = "lmse_ZyXwVuTsRqPoNmLkJiHgFe"
	testToken  = "lmsd_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCde"
	testToken2 = "lmsd_ZyXwVuTsRqPoNmLkJiHgFeDcBa9876543210-_ZyXwv"
	testAgent  = "01a1a98a-0000-7000-8000-0000000d0101"
	fp64       = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
)

var now = time.Date(2026, 11, 11, 8, 30, 0, 0, time.UTC)

func TestTokenFixtureShape(t *testing.T) {
	if len(testCode) != 27 || len(testCode2) != 27 || len(testToken) != 48 || len(testToken2) != 48 {
		t.Fatalf("fixture lengths: %d %d %d %d", len(testCode), len(testCode2), len(testToken), len(testToken2))
	}
}

type fakePlatform struct {
	mu       sync.Mutex
	calls    []string
	elevated bool
	ctlCodes []uint32
	ctlErr   error
	fwExe    string
}

func (f *fakePlatform) rec(s string) { f.mu.Lock(); f.calls = append(f.calls, s); f.mu.Unlock() }
func (f *fakePlatform) names() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.calls...)
}
func (f *fakePlatform) mutating() []string {
	var m []string
	for _, c := range f.names() {
		if c != "OSVersion" && c != "IsElevated" {
			m = append(m, c)
		}
	}
	return m
}
func (f *fakePlatform) has(n string) bool {
	for _, c := range f.names() {
		if c == n {
			return true
		}
	}
	return false
}
func (f *fakePlatform) OSVersion() (svc.OSVersion, error) {
	f.rec("OSVersion")
	return svc.OSVersion{Major: 10, Build: 26300, Name: "Windows 11"}, nil
}
func (f *fakePlatform) IsElevated() bool { f.rec("IsElevated"); return f.elevated }
func (f *fakePlatform) PrepareFolders(l svc.Layout, _ string) error {
	f.rec("PrepareFolders")
	for _, d := range l.Dirs() {
		if err := os.MkdirAll(d, 0o700); err != nil {
			return err
		}
	}
	return nil
}
func (f *fakePlatform) RegisterService(svc.ServiceConfig) error { f.rec("RegisterService"); return nil }
func (f *fakePlatform) StartService() error                     { f.rec("StartService"); return nil }
func (f *fakePlatform) StopService() error                      { f.rec("StopService"); return nil }
func (f *fakePlatform) RemoveService() error                    { f.rec("RemoveService"); return nil }
func (f *fakePlatform) AddFirewallRule(exe string) error {
	f.rec("AddFirewallRule")
	f.fwExe = exe
	return nil
}
func (f *fakePlatform) RemoveFirewallRule() error { f.rec("RemoveFirewallRule"); return nil }
func (f *fakePlatform) SendControl(c uint32) error {
	f.rec("SendControl")
	f.ctlCodes = append(f.ctlCodes, c)
	return f.ctlErr
}

type fakeProtector struct{ entropy []byte }

func (p fakeProtector) Protect(b []byte) ([]byte, error) {
	r := make([]byte, len(b))
	for i := range b {
		r[i] = b[len(b)-1-i] ^ 0x5a
	}
	return []byte("FAKEWRAP:" + base64.StdEncoding.EncodeToString(r) + ":" + base64.StdEncoding.EncodeToString(p.entropy)), nil
}

func (p fakeProtector) Unprotect(b []byte) ([]byte, error) {
	parts := strings.Split(string(b), ":")
	if len(parts) != 3 || parts[0] != "FAKEWRAP" {
		return nil, errors.New("not wrapped")
	}
	ent, _ := base64.StdEncoding.DecodeString(parts[2])
	if !bytes.Equal(ent, p.entropy) {
		return nil, errors.New("entropy mismatch")
	}
	r, _ := base64.StdEncoding.DecodeString(parts[1])
	o := make([]byte, len(r))
	for i := range r {
		o[i] = r[len(r)-1-i] ^ 0x5a
	}
	return o, nil
}

var _ secrets.Protector = fakeProtector{}

type fakeEnroller struct {
	reqs []svc.EnrolRequest
	res  svc.EnrolResult
	err  error
}

func (f *fakeEnroller) Enrol(_ context.Context, r svc.EnrolRequest) (svc.EnrolResult, error) {
	f.reqs = append(f.reqs, r)
	return f.res, f.err
}

type rig struct {
	t       *testing.T
	plat    *fakePlatform
	enrol   *fakeEnroller
	layout  svc.Layout
	out     bytes.Buffer
	errOut  bytes.Buffer
	pending int
	pendErr error
	allOut  strings.Builder // every byte printed by every Run in this test
}

func newRig(t *testing.T) *rig {
	t.Helper()
	r := &rig{t: t, plat: &fakePlatform{elevated: true}, layout: svc.NewLayout(t.TempDir(), t.TempDir())}
	r.enrol = &fakeEnroller{res: svc.EnrolResult{AgentID: testAgent, CentreID: "0196a3c0-0000-7000-8000-0000000c0001", DeviceToken: testToken, ServerTime: "2026-11-11T08:30:00.000Z", ConfigVersion: 3}}
	return r
}

func (r *rig) deps() cli.Deps {
	return cli.Deps{
		Out: &r.out, Err: &r.errOut,
		Env: svc.Env{
			Platform: r.plat, Enroller: r.enrol, Layout: r.layout, AgentVersion: "1.0.0", LauncherVersion: "1.0.0",
			HostFingerprint: func() (string, error) { return fp64, nil },
			NewProtector:    func(e []byte) secrets.Protector { return fakeProtector{entropy: append([]byte(nil), e...)} },
		},
		Pending: func() (int, error) { return r.pending, r.pendErr },
		Version: cli.VersionInfo{Agent: "1.0.0", Launcher: "1.0.1", Build: "abc1234"},
		Now:     func() time.Time { return now },
	}
}

// run executes one command and returns the exit code and everything printed (stdout + stderr).
func (r *rig) run(args ...string) (int, string) {
	r.out.Reset()
	r.errOut.Reset()
	code := cli.Run(args, r.deps())
	s := r.out.String() + r.errOut.String()
	r.allOut.WriteString(s)
	return code, s
}

func (r *rig) noCredentialsPrinted() {
	r.t.Helper()
	s := r.allOut.String()
	for _, bad := range []string{testCode, testCode2, testToken, testToken2, "lmsd_", "lmse_"} {
		if strings.Contains(s, bad) {
			r.t.Errorf("CLI output leaks a credential (%q):\n%s", bad, s)
		}
	}
}

func (r *rig) installed() {
	r.t.Helper()
	if code, out := r.run("install", "--server", testServer, "--enrolment-code", testCode); code != 0 {
		r.t.Fatalf("setup install exit %d:\n%s", code, out)
	}
	r.plat.calls = nil
}

func exists(p string) bool { _, err := os.Stat(p); return err == nil }
