// Package svc holds the Windows service identity, folder layout, ACL sets, firewall rule, install/uninstall flow and the service
// control fallback (02-TRD 5.12, AC-01.4). It opens no listening socket: a listener is a per-instrument concern (REQ-SEC-114).
//
// LD-93 / LD-94 (2026-11-11, Addendum A36): the supported OS set is Windows 10 and Windows 11. Windows 10 install/uninstall is a
// pre-pilot release gate, not a build gate.
package svc

import (
	"errors"
	"fmt"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"lims/apps/bridge-agent/internal/secrets"
)

const (
	ServiceName         = "LimsBridgeAgent"
	DisplayName         = "LIMS Bridge Agent"
	VirtualAccount      = `NT SERVICE\LimsBridgeAgent`
	LocalServiceAccount = `NT AUTHORITY\LocalService`
	FirewallRuleName    = "LIMS Bridge Agent LAN listener"

	// User-defined service control codes (02-TRD 5.12). Spike S1/S2 (LD-94): 128, 129 and 255 reach the handler; 127 is refused by the SCM.
	CtlHeartbeatNow uint32 = 128
	CtlFlushNow     uint32 = 129

	RequestFile         = "request.json"
	RequestHeartbeatNow = "heartbeat_now"
	RequestFlushNow     = "flush_now"
	RequestPollInterval = 5 * time.Second

	RightFull   = "full"
	RightModify = "modify"
)

var (
	ErrNotElevated    = errors.New("svc: this command needs an elevated (Administrator) prompt")
	ErrUnsupportedOS  = errors.New("svc: unsupported Windows version (Windows 10 and Windows 11 only)")
	ErrInvalidOptions = errors.New("svc: invalid options")
)

// Layout is the folder plan of 02-TRD 5.12.
type Layout struct{ DataRoot, ProgramDir string }

func NewLayout(programData, programFiles string) Layout {
	return Layout{
		DataRoot:   filepath.Join(programData, "LIMS", "BridgeAgent"),
		ProgramDir: filepath.Join(programFiles, "LIMS", "BridgeAgent"),
	}
}

func (l Layout) sub(n string) string { return filepath.Join(l.DataRoot, n) }

// Dirs lists the six data folders in creation order.
func (l Layout) Dirs() []string {
	var d []string
	for _, n := range []string{"queue", "secrets", "logs", "versions", "config", "status"} {
		d = append(d, l.sub(n))
	}
	return d
}

func (l Layout) LauncherExe() string { return filepath.Join(l.ProgramDir, "bridge-launcher.exe") }
func (l Layout) SecretsDir() string  { return l.sub("secrets") }
func (l Layout) StatusDir() string   { return l.sub("status") }
func (l Layout) LogsDir() string     { return l.sub("logs") }
func (l Layout) ConfigDir() string   { return l.sub("config") }
func (l Layout) TokenFile() string   { return filepath.Join(l.SecretsDir(), secrets.TokenFile) }

// ConfigFile holds the server URL and optional proxy only; never the enrolment code or the token (02-TRD 5.11).
func (l Layout) ConfigFile() string  { return filepath.Join(l.ConfigDir(), "config.local.json") }
func (l Layout) StatusFile() string  { return filepath.Join(l.StatusDir(), "status.json") }
func (l Layout) RequestFile() string { return filepath.Join(l.StatusDir(), RequestFile) }

// ParseAccount maps the --account flag to the service account. Nothing more powerful or arbitrary is ever accepted (REQ-SEC-116).
func ParseAccount(kind string) (string, error) {
	switch kind {
	case "", "virtual":
		return VirtualAccount, nil
	case "localservice":
		return LocalServiceAccount, nil
	}
	return "", fmt.Errorf("%w: --account must be virtual or localservice", ErrInvalidOptions)
}

// ACE is one entry of an explicit DACL.
type ACE struct{ Principal, Right string }

// DataACL is the DACL of the data root and everything under it: service account modify, Administrators and SYSTEM full, nothing else.
func DataACL(account string) []ACE {
	return []ACE{
		{Principal: account, Right: RightModify},
		{Principal: `BUILTIN\Administrators`, Right: RightFull},
		{Principal: `NT AUTHORITY\SYSTEM`, Right: RightFull},
	}
}

// StatusFileACL is the same principal set: status.json is never readable by Users / Authenticated Users / Everyone.
func StatusFileACL(account string) []ACE { return DataACL(account) }

type ServiceConfig struct {
	Name, Display, Binary, Account string
	DelayedAutoStart               bool
	Recovery                       []time.Duration // restart delays for the 1st, 2nd and later failures
}

// NewServiceConfig registers the launcher (not the agent exe: the agent must not replace its own supervisor), delayed automatic
// start, restart after 60 s, 60 s, 300 s [CONV].
func NewServiceConfig(l Layout, account string) ServiceConfig {
	return ServiceConfig{
		Name: ServiceName, Display: DisplayName, Binary: l.LauncherExe(), Account: account,
		DelayedAutoStart: true, Recovery: []time.Duration{60 * time.Second, 60 * time.Second, 300 * time.Second},
	}
}

var winAbs = regexp.MustCompile(`^[A-Za-z]:\\`)

// FirewallAddArgs returns the netsh arguments (run without a shell) of the program-scoped inbound rule: private + domain profiles,
// remote LocalSubnet, TCP. The path is validated because it is passed on a command line by an elevated process.
func FirewallAddArgs(exe string) ([]string, error) {
	if !winAbs.MatchString(exe) || !strings.HasSuffix(strings.ToLower(exe), ".exe") {
		return nil, fmt.Errorf("%w: firewall program must be an absolute .exe path", ErrInvalidOptions)
	}
	for _, r := range exe {
		if r < 0x20 || r == 0x7f || r == '"' || r == '*' || r == '?' || r == '<' || r == '>' || r == '|' {
			return nil, fmt.Errorf("%w: firewall program path has an illegal character", ErrInvalidOptions)
		}
	}
	for _, seg := range strings.FieldsFunc(exe, func(r rune) bool { return r == '\\' || r == '/' }) {
		if seg == ".." {
			return nil, fmt.Errorf("%w: firewall program path must not contain ..", ErrInvalidOptions)
		}
	}
	return []string{"advfirewall", "firewall", "add", "rule", "name=" + FirewallRuleName, "dir=in", "action=allow",
		"program=" + exe, "profile=private,domain", "remoteip=LocalSubnet", "protocol=TCP", "enable=yes"}, nil
}

// FirewallDeleteArgs deletes only our rule, by exact name.
func FirewallDeleteArgs() []string {
	return []string{"advfirewall", "firewall", "delete", "rule", "name=" + FirewallRuleName}
}
