package svc_test

import (
	"path/filepath"
	"strings"
	"testing"
	"time"

	"lims/apps/bridge-agent/internal/secrets"
	"lims/apps/bridge-agent/internal/svc"
)

func TestNames(t *testing.T) {
	if svc.ServiceName != "LimsBridgeAgent" || svc.DisplayName != "LIMS Bridge Agent" {
		t.Fatalf("service name/display = %q / %q", svc.ServiceName, svc.DisplayName)
	}
	if svc.VirtualAccount != `NT SERVICE\LimsBridgeAgent` || svc.LocalServiceAccount != `NT AUTHORITY\LocalService` {
		t.Fatalf("accounts = %q / %q", svc.VirtualAccount, svc.LocalServiceAccount)
	}
	if svc.CtlHeartbeatNow != 128 || svc.CtlFlushNow != 129 {
		t.Fatalf("control codes = %d / %d, want 128 / 129 (02-TRD 5.12)", svc.CtlHeartbeatNow, svc.CtlFlushNow)
	}
	if svc.RequestPollInterval != 5*time.Second || svc.RequestFile != "request.json" {
		t.Fatalf("request fallback = %v %q", svc.RequestPollInterval, svc.RequestFile)
	}
}

func TestLayoutMatchesTRD512(t *testing.T) {
	l := svc.NewLayout(`C:\ProgramData`, `C:\Program Files`)
	root := filepath.Join(`C:\ProgramData`, "LIMS", "BridgeAgent")
	if l.DataRoot != root {
		t.Fatalf("DataRoot = %q, want %q", l.DataRoot, root)
	}
	if want := filepath.Join(`C:\Program Files`, "LIMS", "BridgeAgent", "bridge-launcher.exe"); l.LauncherExe() != want {
		t.Fatalf("LauncherExe = %q, want %q", l.LauncherExe(), want)
	}
	var want []string
	for _, d := range []string{"queue", "secrets", "logs", "versions", "config", "status"} {
		want = append(want, filepath.Join(root, d))
	}
	got := l.Dirs()
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("Dirs = %v, want %v", got, want)
	}
	if l.TokenFile() != filepath.Join(root, "secrets", secrets.TokenFile) {
		t.Fatalf("TokenFile = %q", l.TokenFile())
	}
	if l.StatusFile() != filepath.Join(root, "status", "status.json") || l.RequestFile() != filepath.Join(root, "status", "request.json") {
		t.Fatalf("status/request = %q / %q", l.StatusFile(), l.RequestFile())
	}
	if l.ConfigFile() != filepath.Join(root, "config", "config.local.json") {
		t.Fatalf("ConfigFile = %q", l.ConfigFile())
	}
	if l.SecretsDir() != filepath.Join(root, "secrets") || l.StatusDir() != filepath.Join(root, "status") || l.LogsDir() != filepath.Join(root, "logs") {
		t.Fatal("SecretsDir / StatusDir / LogsDir wrong")
	}
}

func TestParseAccount(t *testing.T) {
	ok := map[string]string{"": svc.VirtualAccount, "virtual": svc.VirtualAccount, "localservice": svc.LocalServiceAccount}
	for in, want := range ok {
		got, err := svc.ParseAccount(in)
		if err != nil || got != want {
			t.Errorf("ParseAccount(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	// the service must never run as a more powerful or arbitrary account (REQ-SEC-116)
	for _, in := range []string{"system", "localsystem", "networkservice", "admin", "administrator", `DOMAIN\user`, "virtual;calc", "virtual ", "local service", `NT AUTHORITY\SYSTEM`} {
		if got, err := svc.ParseAccount(in); err == nil {
			t.Errorf("ParseAccount(%q) = %q, want an error", in, got)
		}
	}
}

func principals(a []svc.ACE) map[string]string {
	m := map[string]string{}
	for _, e := range a {
		m[strings.ToLower(e.Principal)] = e.Right
	}
	return m
}

var broadPrincipals = []string{`builtin\users`, "users", `nt authority\authenticated users`, "authenticated users", "everyone", `nt authority\interactive`, `builtin\guests`}

func TestDataACLMatchesTRD512(t *testing.T) {
	for _, acct := range []string{svc.VirtualAccount, svc.LocalServiceAccount} {
		a := svc.DataACL(acct)
		if len(a) != 3 {
			t.Fatalf("DataACL(%q) = %v, want exactly 3 entries", acct, a)
		}
		p := principals(a)
		if len(p) != 3 {
			t.Fatalf("duplicate principals in %v", a)
		}
		if p[strings.ToLower(acct)] != svc.RightModify {
			t.Errorf("service account must have modify only: %v", a)
		}
		if p[`builtin\administrators`] != svc.RightFull {
			t.Errorf("BUILTIN\\Administrators must have full: %v", a)
		}
		if p[`nt authority\system`] != svc.RightFull {
			t.Errorf("NT AUTHORITY\\SYSTEM must have full: %v", a)
		}
		for _, b := range broadPrincipals {
			if _, bad := p[b]; bad {
				t.Errorf("DataACL grants %q: no Users / Authenticated Users entries allowed", b)
			}
		}
	}
}

func TestStatusFileACLNeverReadableByUsers(t *testing.T) {
	a := svc.StatusFileACL(svc.VirtualAccount)
	p := principals(a)
	if p[`builtin\administrators`] == "" {
		t.Fatalf("Administrators must be able to read status.json: %v", a)
	}
	allowed := map[string]bool{strings.ToLower(svc.VirtualAccount): true, `builtin\administrators`: true, `nt authority\system`: true}
	for who := range p {
		if !allowed[who] {
			t.Errorf("status.json grants %q", who)
		}
	}
	if p[strings.ToLower(svc.VirtualAccount)] == "" {
		t.Error("the service must keep write access to status.json")
	}
}

func TestNewServiceConfigMatchesTRD512(t *testing.T) {
	l := svc.NewLayout(`C:\ProgramData`, `C:\Program Files`)
	c := svc.NewServiceConfig(l, svc.VirtualAccount)
	if c.Name != "LimsBridgeAgent" || c.Display != "LIMS Bridge Agent" || c.Account != svc.VirtualAccount {
		t.Fatalf("config = %+v", c)
	}
	if c.Binary != l.LauncherExe() {
		t.Fatalf("Binary = %q, want the launcher %q (not the agent exe: the agent must not replace its own supervisor)", c.Binary, l.LauncherExe())
	}
	if !c.DelayedAutoStart {
		t.Error("start type must be automatic (delayed start)")
	}
	if len(c.Recovery) != 3 || c.Recovery[0] != 60*time.Second || c.Recovery[1] != 60*time.Second || c.Recovery[2] != 300*time.Second {
		t.Errorf("Recovery = %v, want restart after 60 s, 60 s, 300 s", c.Recovery)
	}
	if got := svc.NewServiceConfig(l, svc.LocalServiceAccount).Account; got != svc.LocalServiceAccount {
		t.Errorf("fallback account = %q", got)
	}
}

func TestFirewallAddArgsAreProgramScopedLANOnly(t *testing.T) {
	exe := `C:\Program Files\LIMS\BridgeAgent\bridge-launcher.exe`
	args, err := svc.FirewallAddArgs(exe)
	if err != nil {
		t.Fatal(err)
	}
	have := map[string]bool{}
	for _, a := range args {
		have[a] = true
	}
	for _, want := range []string{"advfirewall", "firewall", "add", "rule", "name=" + svc.FirewallRuleName, "dir=in", "action=allow",
		"program=" + exe, "profile=private,domain", "remoteip=LocalSubnet", "protocol=TCP", "enable=yes"} {
		if !have[want] {
			t.Errorf("netsh args lack %q: %q", want, args)
		}
	}
	for _, a := range args {
		l := strings.ToLower(a)
		if strings.Contains(l, "public") || strings.Contains(l, "remoteip=any") || l == "profile=any" || strings.Contains(l, "remoteip=0.0.0.0") {
			t.Errorf("rule is too broad: %q", a)
		}
	}
	if svc.FirewallRuleName != "LIMS Bridge Agent LAN listener" {
		t.Errorf("FirewallRuleName = %q", svc.FirewallRuleName)
	}
}

func TestFirewallAddArgsRejectUnsafePaths(t *testing.T) {
	for _, exe := range []string{"", "bridge-launcher.exe", `..\x.exe`, `C:\a"b\x.exe`, "C:\\a\nb\\x.exe", `C:\a\x.exe" dir=out`} {
		if args, err := svc.FirewallAddArgs(exe); err == nil {
			t.Errorf("FirewallAddArgs(%q) = %q, want an error", exe, args)
		}
	}
}

func TestFirewallDeleteArgsDeleteOnlyOurRuleByName(t *testing.T) {
	a := svc.FirewallDeleteArgs()
	have := map[string]bool{}
	for _, x := range a {
		have[x] = true
	}
	for _, want := range []string{"advfirewall", "firewall", "delete", "rule", "name=" + svc.FirewallRuleName} {
		if !have[want] {
			t.Errorf("delete args lack %q: %q", want, a)
		}
	}
	for _, x := range a {
		if strings.EqualFold(x, "name=all") || strings.HasPrefix(strings.ToLower(x), "program=") {
			t.Errorf("delete args too broad: %q", x)
		}
	}
}
