//go:build windows

package svc_test

// AG-T15 Windows integration: the icacls audit of 02-TRD 5.12 against real folders, real DPAPI for the token, and (opt-in) a real SCM round trip.
// The PrepareFolders/icacls tests need an elevated shell; the AG-T15 verify run must be elevated to exercise them (otherwise they skip, not pass).
// The SCM test changes the machine (registers and removes a throw-away service) and so runs only when LIMS_AG_T15_SCM=1 in an elevated shell.

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/windows"

	"lims/apps/bridge-agent/internal/secrets"
	"lims/apps/bridge-agent/internal/svc"
)

func whoami(t *testing.T) string {
	t.Helper()
	out, err := exec.Command("whoami").Output()
	if err != nil {
		t.Fatalf("whoami: %v", err)
	}
	return strings.TrimSpace(string(out))
}

type aceLine struct{ who, flags string }

var aceRe = regexp.MustCompile(`^\s*(.+?):((?:\([A-Z,]+\))+)\s*$`)

// icacls prints "<path> <principal>:(flags)(rights)" for the first entry and "<spaces><principal>:(...)" for the rest.
func icacls(t *testing.T, path string) []aceLine {
	t.Helper()
	out, err := exec.Command("icacls", path).CombinedOutput()
	if err != nil {
		t.Fatalf("icacls %s: %v\n%s", path, err, out)
	}
	var res []aceLine
	for i, ln := range strings.Split(strings.ReplaceAll(string(out), "\r", ""), "\n") {
		if strings.TrimSpace(ln) == "" || strings.HasPrefix(ln, "Successfully processed") {
			continue
		}
		if i == 0 {
			ln = strings.TrimPrefix(ln, path)
		}
		m := aceRe.FindStringSubmatch(ln)
		if m == nil {
			t.Fatalf("cannot parse icacls line %q in\n%s", ln, out)
		}
		res = append(res, aceLine{who: strings.ToLower(strings.TrimSpace(m[1])), flags: m[2]})
	}
	return res
}

func assertAudit(t *testing.T, path string, me string, inherited bool) {
	t.Helper()
	acl := icacls(t, path)
	want := map[string]string{strings.ToLower(me): "(M)", `builtin\administrators`: "(F)", `nt authority\system`: "(F)"}
	seen := map[string]bool{}
	for _, a := range acl {
		w, ok := want[a.who]
		if !ok {
			t.Errorf("%s: unexpected ACE for %q %s (02-TRD 5.12: no Users / Authenticated Users / anything else)", path, a.who, a.flags)
			continue
		}
		seen[a.who] = true
		if !strings.Contains(a.flags, w) {
			t.Errorf("%s: %q has %s, want %s", path, a.who, a.flags, w)
		}
		if strings.Contains(a.flags, "(I)") != inherited {
			t.Errorf("%s: %q flags %s, inherited ACE expected = %v", path, a.who, a.flags, inherited)
		}
	}
	for who := range want {
		if !seen[who] {
			t.Errorf("%s: no ACE for %q in %v", path, who, acl)
		}
	}
}

func layoutFor(t *testing.T) svc.Layout {
	t.Helper()
	return svc.NewLayout(t.TempDir(), t.TempDir())
}

func TestIcaclsAuditMatchesTRD512(t *testing.T) {
	if !elevated() {
		t.Skip("PrepareFolders runs only from the elevated installer (04-UI-UX §2, 02-TRD §5.11)")
	}
	me := whoami(t)
	l := layoutFor(t)
	p := svc.NewWindowsPlatform(l, "")
	if err := p.PrepareFolders(l, me); err != nil {
		t.Fatalf("PrepareFolders: %v", err)
	}
	assertAudit(t, l.DataRoot, me, false) // explicit DACL on the root, inheritance disabled
	for _, d := range l.Dirs() {
		if _, err := os.Stat(d); err != nil {
			t.Fatalf("folder missing: %v", err)
		}
		assertAudit(t, d, me, true) // children carry the same three entries by inheritance from the root
	}
	// a file created later under the root inherits the same ACL and nothing broader
	f := filepath.Join(l.DataRoot, "queue", "agent.db")
	if err := os.WriteFile(f, []byte("synthetic"), 0o600); err != nil {
		t.Fatal(err)
	}
	assertAudit(t, f, me, true)
}

// The installer must REPLACE the DACL, not add to it: a pre-existing Users grant has to be gone afterwards.
func TestPrepareFoldersReplacesExistingBroadAndIsIdempotent(t *testing.T) {
	if !elevated() {
		t.Skip("PrepareFolders runs only from the elevated installer (04-UI-UX §2, 02-TRD §5.11)")
	}
	me := whoami(t)
	l := layoutFor(t)
	if err := os.MkdirAll(l.SecretsDir(), 0o700); err != nil {
		t.Fatal(err)
	}
	for _, d := range []string{l.DataRoot, l.SecretsDir()} {
		if out, err := exec.Command("icacls", d, "/grant", "*S-1-5-32-545:(OI)(CI)R", "*S-1-5-11:(OI)(CI)R").CombinedOutput(); err != nil {
			t.Fatalf("seeding a Users grant: %v\n%s", err, out)
		}
	}
	p := svc.NewWindowsPlatform(l, "")
	for i := 0; i < 2; i++ {
		if err := p.PrepareFolders(l, me); err != nil {
			t.Fatalf("PrepareFolders run %d: %v", i+1, err)
		}
		assertAudit(t, l.DataRoot, me, false)
		assertAudit(t, l.SecretsDir(), me, true)
	}
}

func ownerIsAdministrators(t *testing.T, path string) bool {
	t.Helper()
	sd, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION)
	if err != nil {
		t.Fatalf("GetNamedSecurityInfo(%s): %v", path, err)
	}
	owner, _, err := sd.Owner()
	if err != nil || owner == nil {
		t.Fatalf("owner of %s: %v", path, err)
	}
	admins, err := windows.CreateWellKnownSid(windows.WinBuiltinAdministratorsSid)
	if err != nil {
		t.Fatal(err)
	}
	return owner.Equals(admins)
}

// AG-T15 review item 1: an owner keeps implicit WRITE_DAC, so a user who pre-created the data root must not stay its owner.
// Not elevated: PrepareFolders MUST fail closed (an error), since a non-admin cannot assign BUILTIN\Administrators as owner (AG-T15 ruling).
// Elevated: BUILTIN\Administrators owns the root and every child.
func TestPrepareFoldersOwnerIsAdministrators(t *testing.T) {
	me := whoami(t)
	l := layoutFor(t)
	if err := os.MkdirAll(l.SecretsDir(), 0o700); err != nil {
		t.Fatal(err)
	}
	err := svc.NewWindowsPlatform(l, "").PrepareFolders(l, me)
	if !elevated() {
		if err == nil {
			t.Fatal("PrepareFolders succeeded without elevation: it must fail closed")
		}
		return
	}
	if err != nil {
		t.Fatalf("PrepareFolders: %v", err)
	}
	for _, p := range append([]string{l.DataRoot}, l.Dirs()...) {
		if !ownerIsAdministrators(t, p) {
			t.Errorf(`%s: owner is not BUILTIN\Administrators after PrepareFolders`, p)
		}
	}
}

// AG-T15 review item 2: a link entry in a folder must not stop the repair of its later siblings (fs.SkipDir on a non-directory skips the rest of the folder).
func TestPrepareFoldersLinkDoesNotSkipLaterSiblings(t *testing.T) {
	if !elevated() {
		t.Skip("PrepareFolders runs only from the elevated installer (04-UI-UX §2, 02-TRD §5.11)")
	}
	me := whoami(t)
	l := layoutFor(t)
	if err := os.MkdirAll(l.SecretsDir(), 0o700); err != nil {
		t.Fatal(err)
	}
	target := t.TempDir()
	link := filepath.Join(l.SecretsDir(), "a") // sorts before "z.bin": WalkDir visits the link first
	if out, err := exec.Command("cmd", "/c", "mklink", "/J", link, target).CombinedOutput(); err != nil {
		t.Skipf("cannot create a junction here: %v\n%s", err, out)
	}
	later := filepath.Join(l.SecretsDir(), "z.bin")
	if err := os.WriteFile(later, []byte("synthetic"), 0o600); err != nil {
		t.Fatal(err)
	}
	if out, err := exec.Command("icacls", later, "/grant", "*S-1-5-32-545:R", "*S-1-5-11:R").CombinedOutput(); err != nil {
		t.Fatalf("seeding a broad grant: %v\n%s", err, out)
	}
	if err := svc.NewWindowsPlatform(l, "").PrepareFolders(l, me); err != nil {
		t.Fatalf("PrepareFolders: %v", err)
	}
	assertAudit(t, later, me, true) // the broad explicit ACEs behind the link entry must be gone
	if _, err := os.Stat(target); err != nil {
		t.Errorf("link target damaged: %v", err)
	}
}

func TestStatusFileACLAppliedNoUsers(t *testing.T) {
	me := whoami(t)
	f := filepath.Join(t.TempDir(), "status.json")
	if err := os.WriteFile(f, []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := svc.ApplyACL(f, svc.StatusFileACL(me)); err != nil {
		t.Fatalf("ApplyACL: %v", err)
	}
	for _, a := range icacls(t, f) {
		if strings.Contains(a.flags, "(I)") {
			t.Errorf("status.json still inherits: %v", a)
		}
		switch a.who {
		case strings.ToLower(me), `builtin\administrators`, `nt authority\system`:
		default:
			t.Errorf("status.json readable by %q", a.who)
		}
	}
}

func TestApplyACLRejectsEmptyAndMissing(t *testing.T) {
	if err := svc.ApplyACL(filepath.Join(t.TempDir(), "does-not-exist"), svc.DataACL(whoami(t))); err == nil {
		t.Error("ApplyACL on a missing path must fail")
	}
	// an empty ACE list would produce an empty (deny-all) or null (allow-all) DACL: both are wrong
	if err := svc.ApplyACL(t.TempDir(), nil); err == nil {
		t.Error("ApplyACL with no entries must fail")
	}
}

// AC-01.4 on a real machine: install with the real DPAPI, token only as a DPAPI blob keyed by the agent id.
func TestInstallTokenIsRealDPAPIBlobWithAgentEntropy(t *testing.T) {
	r := newRig(t)
	r.env.NewProtector = func(entropy []byte) secrets.Protector { return secrets.NewDPAPI(secrets.ScopeUser, entropy) }
	var out bytes.Buffer
	if err := svc.Install(context.Background(), r.env, goodOpts(), &out); err != nil {
		t.Fatalf("Install: %v\n%s", err, out.String())
	}
	blob, err := os.ReadFile(r.layout.TokenFile())
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(blob, []byte("lmsd_")) {
		t.Fatal("plaintext token in device-token.bin")
	}
	if got, err := secrets.LoadToken(r.layout.SecretsDir(), secrets.NewDPAPI(secrets.ScopeUser, []byte(testAgent))); err != nil || got != testToken {
		t.Fatalf("LoadToken with agent-id entropy: %q, %v", got, err)
	}
	if _, err := secrets.LoadToken(r.layout.SecretsDir(), secrets.NewDPAPI(secrets.ScopeUser, []byte("other"))); err == nil {
		t.Fatal("token decrypts without the agent-id entropy")
	}
}

func TestWindowsPlatformReportsOSAndElevation(t *testing.T) {
	p := svc.NewWindowsPlatform(layoutFor(t), "")
	v, err := p.OSVersion()
	if err != nil || v.Major < 10 || v.Build == 0 || v.Name == "" {
		t.Fatalf("OSVersion = %+v, %v (this suite runs on Windows 10/11)", v, err)
	}
	_ = p.IsElevated() // must not panic; value depends on the shell
}

func elevated() bool { return svc.NewWindowsPlatform(svc.Layout{}, "").IsElevated() }

func sc(t *testing.T, args ...string) string {
	t.Helper()
	out, _ := exec.Command("sc.exe", args...).CombinedOutput()
	return string(out)
}

// Opt-in. Registers a throw-away service, audits it with sc.exe, removes it. Win10/11 install/uninstall is the release-gate manual check (LD-94).
func TestWindowsServiceRegisterQueryRemove(t *testing.T) {
	if os.Getenv("LIMS_AG_T15_SCM") != "1" {
		t.Skip("set LIMS_AG_T15_SCM=1 in an elevated shell to register and remove a throw-away service")
	}
	if !elevated() {
		t.Skip("not elevated")
	}
	const name = "LimsBridgeAgentT15Test"
	l := layoutFor(t)
	p := svc.NewWindowsPlatform(l, name)
	cfg := svc.NewServiceConfig(l, svc.LocalServiceAccount)
	cfg.Name = name
	cfg.Display = "LIMS Bridge Agent T15 test"
	cfg.Binary = filepath.Join(os.Getenv("SystemRoot"), "System32", "cmd.exe") // never started
	t.Cleanup(func() { _ = p.RemoveService() })
	if err := p.RegisterService(cfg); err != nil {
		t.Fatalf("RegisterService: %v", err)
	}
	qc := sc(t, "qc", name)
	if !strings.Contains(qc, "AUTO_START") || !strings.Contains(qc, "DELAYED") {
		t.Errorf("start type is not automatic (delayed):\n%s", qc)
	}
	if !strings.Contains(strings.ToLower(qc), `nt authority\localservice`) {
		t.Errorf("account is not LocalService:\n%s", qc)
	}
	qf := sc(t, "qfailure", name)
	for _, want := range []string{"60000", "300000", "RESTART"} {
		if !strings.Contains(qf, want) {
			t.Errorf("recovery actions lack %q:\n%s", want, qf)
		}
	}
	if err := p.RemoveService(); err != nil {
		t.Fatalf("RemoveService: %v", err)
	}
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) && !strings.Contains(sc(t, "query", name), "1060") {
		time.Sleep(200 * time.Millisecond)
	}
	if !strings.Contains(sc(t, "query", name), "1060") {
		t.Errorf("service still registered after RemoveService:\n%s", sc(t, "query", name))
	}
}
