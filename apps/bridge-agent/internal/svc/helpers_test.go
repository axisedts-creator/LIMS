package svc_test

// Shared fakes for AG-T15. They also document the API the implementation must provide (package svc, 02-TRD 5.12).
// LD-93/LD-94: supported OS set is Windows 10 and 11 only; Windows 10 install/uninstall is a pre-pilot release gate, not a build gate.
//
//	const ServiceName = "LimsBridgeAgent"; DisplayName = "LIMS Bridge Agent"
//	const VirtualAccount = `NT SERVICE\LimsBridgeAgent`; LocalServiceAccount = `NT AUTHORITY\LocalService`
//	const CtlHeartbeatNow uint32 = 128; CtlFlushNow uint32 = 129
//	const RequestFile = "request.json"; RequestHeartbeatNow = "heartbeat_now"; RequestFlushNow = "flush_now"; RequestPollInterval = 5 * time.Second
//	const FirewallRuleName = "LIMS Bridge Agent LAN listener"
//	const RightFull = "full"; RightModify = "modify"
//
//	type Layout struct{ DataRoot, ProgramDir string }
//	func NewLayout(programData, programFiles string) Layout   // DataRoot = <programData>\LIMS\BridgeAgent, ProgramDir = <programFiles>\LIMS\BridgeAgent
//	func (Layout) Dirs() []string        // DataRoot\{queue,secrets,logs,versions,config,status}, in that order
//	func (Layout) LauncherExe() string   // ProgramDir\bridge-launcher.exe
//	func (Layout) SecretsDir() string; StatusDir() string; LogsDir() string
//	func (Layout) TokenFile() string     // secrets\device-token.bin
//	func (Layout) ConfigFile() string    // config\config.local.json (server URL and optional proxy only; never the code or the token)
//	func (Layout) StatusFile() string    // status\status.json
//	func (Layout) RequestFile() string   // status\request.json
//
//	func ParseAccount(kind string) (string, error)            // "" and "virtual" -> VirtualAccount, "localservice" -> LocalServiceAccount, anything else error
//	type ACE struct{ Principal, Right string }                // Right: RightFull | RightModify
//	func DataACL(account string) []ACE                        // service account modify; BUILTIN\Administrators full; NT AUTHORITY\SYSTEM full; nothing else
//	func StatusFileACL(account string) []ACE                  // same principals only; never Users / Authenticated Users / Everyone
//	func ApplyACL(path string, aces []ACE) error              // windows: explicit protected DACL (inheritance off, existing ACEs replaced), container+object inherit  [windows file]
//	type ServiceConfig struct{ Name, Display, Binary, Account string; DelayedAutoStart bool; Recovery []time.Duration }
//	func NewServiceConfig(l Layout, account string) ServiceConfig   // Binary = LauncherExe, DelayedAutoStart, Recovery {60s, 60s, 300s}
//	func FirewallAddArgs(exe string) ([]string, error)        // netsh args, run without a shell
//	func FirewallDeleteArgs() []string
//
//	type OSVersion struct{ Major, Minor, Build uint32; Name string }
//	type Platform interface {
//	    OSVersion() (OSVersion, error); IsElevated() bool
//	    PrepareFolders(l Layout, account string) error          // creates the six folders with DataACL, replacing any existing DACL
//	    RegisterService(c ServiceConfig) error; StartService() error; StopService() error; RemoveService() error
//	    AddFirewallRule(exe string) error; RemoveFirewallRule() error
//	    SendControl(code uint32) error
//	}
//	func NewWindowsPlatform(l Layout, serviceName string) Platform   // "" = ServiceName  [windows file]
//
//	type EnrolRequest struct{ Server, Code, HostFingerprintSHA256, AgentVersion, LauncherVersion, OSVersion string }
//	type EnrolResult struct{ AgentID, CentreID, DeviceToken, ServerTime string; ConfigVersion int }
//	type Enroller interface{ Enrol(ctx context.Context, r EnrolRequest) (EnrolResult, error) }
//	type Env struct {
//	    Platform Platform; Enroller Enroller; Layout Layout
//	    NewProtector func(entropy []byte) secrets.Protector    // entropy = []byte(agent id) (02-TRD 5.12)
//	    AgentVersion, LauncherVersion string; HostFingerprint func() (string, error)
//	}
//	type InstallOptions struct{ Server, EnrolmentCode, Proxy, Account string; AllowLANListener bool }
//	var ErrNotElevated, ErrUnsupportedOS, ErrInvalidOptions error
//	func Install(ctx context.Context, e Env, o InstallOptions, out io.Writer) error
//	type UninstallOptions struct{ Purge, ForceDiscardPending bool }
//	type PendingError struct{ Count int }  // pointer receiver: Uninstall returns a *PendingError (errors.As target **PendingError); Error() text contains the count
//	func Uninstall(ctx context.Context, e Env, o UninstallOptions, pending func() (int, error), out io.Writer) error
//
//	type Triggers struct{ HeartbeatNow, FlushNow func() }     // nil funcs are allowed
//	func HandleControl(code uint32, t Triggers) bool          // 128 -> HeartbeatNow, 129 -> FlushNow; every other code false, no call
//	func WriteRequest(statusDir, kind string) error           // atomic; unknown kind is an error
//	func ConsumeRequest(statusDir string, t Triggers) (bool, error)   // claims request.json at most once (rename-to-claim), deletes it, fires the trigger; bad files are deleted, never fire
//	func PollRequests(ctx context.Context, statusDir string, t Triggers, every time.Duration)   // ConsumeRequest every `every` until ctx is done

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"os"
	"strings"
	"sync"
	"testing"

	"lims/apps/bridge-agent/internal/secrets"
	"lims/apps/bridge-agent/internal/svc"
)

const (
	testServer = "https://lims.example.np"
	testCode   = "lmse_AbCdEfGhIjKlMnOpQrStUv"                      // lmse_ + 22 base64url
	testToken  = "lmsd_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCde" // lmsd_ + 43 base64url (len check in TestTokenFixtureShape)
	testAgent  = "01a1a98a-0000-7000-8000-0000000d0101"
	fp64       = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
)

func TestTokenFixtureShape(t *testing.T) {
	if len(testCode) != len("lmse_")+22 || len(testToken) != len("lmsd_")+43 {
		t.Fatalf("fixture lengths wrong: code %d token %d", len(testCode), len(testToken))
	}
}

// fakePlatform records every call in order.
type fakePlatform struct {
	mu       sync.Mutex
	calls    []string
	elevated bool
	ver      svc.OSVersion
	verErr   error
	cfg      svc.ServiceConfig
	account  string
	fwExe    string
	ctlCodes []uint32
	ctlErr   error
}

func newFake() *fakePlatform {
	return &fakePlatform{elevated: true, ver: svc.OSVersion{Major: 10, Build: 26300, Name: "Windows 11"}}
}

func (f *fakePlatform) rec(s string) { f.mu.Lock(); f.calls = append(f.calls, s); f.mu.Unlock() }

func (f *fakePlatform) OSVersion() (svc.OSVersion, error) { f.rec("OSVersion"); return f.ver, f.verErr }
func (f *fakePlatform) IsElevated() bool                  { f.rec("IsElevated"); return f.elevated }
func (f *fakePlatform) PrepareFolders(l svc.Layout, account string) error {
	f.rec("PrepareFolders")
	f.account = account
	for _, d := range l.Dirs() {
		if err := os.MkdirAll(d, 0o700); err != nil {
			return err
		}
	}
	return nil
}
func (f *fakePlatform) RegisterService(c svc.ServiceConfig) error {
	f.rec("RegisterService")
	f.cfg = c
	return nil
}
func (f *fakePlatform) StartService() error  { f.rec("StartService"); return nil }
func (f *fakePlatform) StopService() error   { f.rec("StopService"); return nil }
func (f *fakePlatform) RemoveService() error { f.rec("RemoveService"); return nil }
func (f *fakePlatform) AddFirewallRule(exe string) error {
	f.rec("AddFirewallRule")
	f.fwExe = exe
	return nil
}
func (f *fakePlatform) RemoveFirewallRule() error { f.rec("RemoveFirewallRule"); return nil }
func (f *fakePlatform) SendControl(code uint32) error {
	f.rec("SendControl")
	f.ctlCodes = append(f.ctlCodes, code)
	return f.ctlErr
}

func (f *fakePlatform) names() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.calls...)
}

// mutating returns every call that changes the machine (not the two read-only probes).
func (f *fakePlatform) mutating() []string {
	var m []string
	for _, c := range f.names() {
		if c != "OSVersion" && c != "IsElevated" {
			m = append(m, c)
		}
	}
	return m
}

func (f *fakePlatform) index(name string) int {
	for i, c := range f.names() {
		if c == name {
			return i
		}
	}
	return -1
}

// fakeProtector is a reversible, non-identity wrap so a plaintext file is distinguishable from a wrapped one.
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
	t      *testing.T
	plat   *fakePlatform
	enrol  *fakeEnroller
	env    svc.Env
	layout svc.Layout
	prot   *[][]byte // entropies handed to NewProtector
}

func newRig(t *testing.T) *rig {
	t.Helper()
	l := svc.NewLayout(t.TempDir(), t.TempDir())
	p := newFake()
	e := &fakeEnroller{res: svc.EnrolResult{AgentID: testAgent, CentreID: "0196a3c0-0000-7000-8000-0000000c0001", DeviceToken: testToken, ServerTime: "2026-11-11T08:30:00.000Z", ConfigVersion: 3}}
	var ents [][]byte
	r := &rig{t: t, plat: p, enrol: e, layout: l, prot: &ents}
	r.env = svc.Env{
		Platform: p, Enroller: e, Layout: l, AgentVersion: "1.0.0", LauncherVersion: "1.0.0",
		HostFingerprint: func() (string, error) { return fp64, nil },
		NewProtector: func(entropy []byte) secrets.Protector {
			ents = append(ents, append([]byte(nil), entropy...))
			return fakeProtector{entropy: append([]byte(nil), entropy...)}
		},
	}
	return r
}

func goodOpts() svc.InstallOptions {
	return svc.InstallOptions{Server: testServer, EnrolmentCode: testCode}
}
