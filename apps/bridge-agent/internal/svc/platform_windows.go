//go:build windows

package svc

import (
	"crypto/sha1" // #nosec G505 -- the Windows service-SID derivation is defined as SHA-1 of the upper-cased service name
	"encoding/binary"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unicode/utf16"
	"unsafe"

	"golang.org/x/sys/windows"
	wsvc "golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

// Access masks written into explicit ACEs. Numeric (not GENERIC_*) so the stored ACE is what icacls prints as (F) and (M).
const (
	maskFull   = 0x1F01FF // FILE_ALL_ACCESS
	maskModify = 0x1301BF // DELETE | FILE_GENERIC_READ | FILE_GENERIC_WRITE | FILE_GENERIC_EXECUTE
)

const serviceWait = 30 * time.Second

// serviceSID derives the service-specific SID S-1-5-80-<5 x uint32 of SHA-1(UTF-16LE(UPPER(name)))>. It is needed because the
// installer sets the folder ACL BEFORE the service is registered, and NT SERVICE\<name> does not resolve until then.
func serviceSID(name string) (*windows.SID, error) {
	u := utf16.Encode([]rune(strings.ToUpper(name)))
	b := make([]byte, 2*len(u))
	for i, c := range u {
		binary.LittleEndian.PutUint16(b[2*i:], c)
	}
	h := sha1.Sum(b) // #nosec G401
	s := "S-1-5-80"
	for i := 0; i < 5; i++ {
		s += "-" + strconv.FormatUint(uint64(binary.LittleEndian.Uint32(h[4*i:])), 10)
	}
	return windows.StringToSid(s)
}

func principalSID(name string) (*windows.SID, error) {
	switch strings.ToLower(name) {
	case `builtin\administrators`:
		return windows.CreateWellKnownSid(windows.WinBuiltinAdministratorsSid)
	case `nt authority\system`:
		return windows.CreateWellKnownSid(windows.WinLocalSystemSid)
	case `nt authority\localservice`:
		return windows.CreateWellKnownSid(windows.WinLocalServiceSid)
	}
	if i := len(`NT SERVICE\`); len(name) > i && strings.EqualFold(name[:i], `NT SERVICE\`) {
		return serviceSID(name[i:])
	}
	sid, _, _, err := windows.LookupSID("", name)
	if err != nil {
		return nil, fmt.Errorf("svc: cannot resolve account %q: %w", name, err)
	}
	return sid, nil
}

func isLink(fi fs.FileInfo) bool { return fi.Mode()&(os.ModeSymlink|os.ModeIrregular) != 0 }

// ApplyACL replaces the DACL of path with exactly aces: protected (inheritance off), existing ACEs dropped, container+object inherit
// on folders. An empty list is refused: it would give an empty (deny all) or null (allow all) DACL.
func ApplyACL(path string, aces []ACE) error {
	if len(aces) == 0 {
		return errors.New("svc: ApplyACL needs at least one entry")
	}
	fi, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if isLink(fi) {
		return errors.New("svc: refusing to set an ACL through a link")
	}
	inherit := uint32(windows.NO_INHERITANCE)
	if fi.IsDir() {
		inherit = windows.SUB_CONTAINERS_AND_OBJECTS_INHERIT
	}
	var pin runtime.Pinner
	defer pin.Unpin()
	entries := make([]windows.EXPLICIT_ACCESS, 0, len(aces))
	for _, a := range aces {
		var mask windows.ACCESS_MASK
		switch a.Right {
		case RightFull:
			mask = maskFull
		case RightModify:
			mask = maskModify
		default:
			return fmt.Errorf("svc: unknown right %q", a.Right)
		}
		sid, err := principalSID(a.Principal)
		if err != nil {
			return err
		}
		pin.Pin(sid)
		entries = append(entries, windows.EXPLICIT_ACCESS{
			AccessPermissions: mask, AccessMode: windows.GRANT_ACCESS, Inheritance: inherit,
			Trustee: windows.TRUSTEE{TrusteeForm: windows.TRUSTEE_IS_SID, TrusteeType: windows.TRUSTEE_IS_UNKNOWN, TrusteeValue: windows.TrusteeValueFromSID(sid)},
		})
	}
	acl, err := windows.ACLFromEntries(entries, nil)
	if err != nil {
		return fmt.Errorf("svc: building the DACL: %w", err)
	}
	return windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT,
		windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, acl, nil)
}

// resetToInherited makes BUILTIN\Administrators the owner of path, drops every explicit ACE and turns inheritance back on, so the
// object carries only what the data root gives it and no earlier creator keeps the owner's implicit WRITE_DAC (AG-T15 review item 1).
func resetToInherited(path string, owner *windows.SID) error {
	// x/sys cannot build an empty ACL (ACLFromEntries(nil, nil) panics): an ACL header with revision 2, size 8, zero ACEs is one.
	hdr := [2]uint32{0x00080002, 0}
	empty := (*windows.ACL)(unsafe.Pointer(&hdr[0]))
	return windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT,
		windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION|windows.UNPROTECTED_DACL_SECURITY_INFORMATION,
		owner, nil, empty, nil)
}

// setOwner makes sid the owner of path. Assigning BUILTIN\Administrators needs an elevated token; without it Windows refuses
// (ERROR_INVALID_OWNER) and the caller fails closed.
func setOwner(path string, sid *windows.SID) error {
	if err := windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION, sid, nil, nil, nil); err != nil {
		return fmt.Errorf(`svc: cannot make BUILTIN\Administrators the owner of %s (the installer must run elevated): %w`, path, err)
	}
	return nil
}

// trustedOwner reports whether path is owned by Administrators, SYSTEM or TrustedInstaller (the owners that may keep WRITE_DAC).
func trustedOwner(path string) (bool, error) {
	sd, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION)
	if err != nil {
		return false, err
	}
	owner, _, err := sd.Owner()
	if err != nil || owner == nil {
		return false, fmt.Errorf("svc: reading the owner of %s: %v", path, err)
	}
	for _, k := range []windows.WELL_KNOWN_SID_TYPE{windows.WinBuiltinAdministratorsSid, windows.WinLocalSystemSid} {
		if owner.IsWellKnown(k) {
			return true, nil
		}
	}
	// NT SERVICE\TrustedInstaller has no well-known SID constant in x/sys; it is a fixed service SID.
	ti, err := windows.StringToSid("S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464")
	return err == nil && owner.Equals(ti), nil
}

type winPlatform struct {
	l    Layout
	name string
}

// NewWindowsPlatform is the real Platform. serviceName "" means ServiceName.
func NewWindowsPlatform(l Layout, serviceName string) Platform {
	if serviceName == "" {
		serviceName = ServiceName
	}
	return &winPlatform{l: l, name: serviceName}
}

func (p *winPlatform) OSVersion() (OSVersion, error) {
	v := windows.RtlGetVersion()
	if v == nil {
		return OSVersion{}, errors.New("svc: RtlGetVersion returned nothing")
	}
	o := OSVersion{Major: v.MajorVersion, Minor: v.MinorVersion, Build: v.BuildNumber}
	switch {
	case o.Major == 10 && o.Build >= 22000:
		o.Name = "Windows 11"
	case o.Major == 10:
		o.Name = "Windows 10"
	default:
		o.Name = fmt.Sprintf("Windows %d.%d", o.Major, o.Minor)
	}
	return o, nil
}

func (p *winPlatform) IsElevated() bool { return windows.GetCurrentProcessToken().IsElevated() }

// PrepareFolders creates the data root and the six folders. The root gets the explicit protected DACL; children inherit it, and
// anything that already existed is reset so no older, broader ACE survives (idempotent, also a repair).
func (p *winPlatform) PrepareFolders(l Layout, account string) error {
	root := filepath.Clean(l.DataRoot)
	if root == "." || !filepath.IsAbs(root) {
		return errors.New("svc: data root must be an absolute path")
	}
	if err := os.MkdirAll(root, 0o700); err != nil {
		return err
	}
	if fi, err := os.Lstat(root); err != nil || !fi.IsDir() || isLink(fi) {
		return errors.New("svc: the data root is a link or not a folder; refusing to set permissions on it")
	}
	admins, err := windows.CreateWellKnownSid(windows.WinBuiltinAdministratorsSid)
	if err != nil {
		return err
	}
	// AG-T15 review item 1: a user who pre-created the parent (C:\ProgramData\LIMS) could rename BridgeAgent away and plant their
	// own folder. Take ownership of the parent when its owner is not Administrators, SYSTEM or TrustedInstaller; fail closed otherwise.
	parent := filepath.Dir(root)
	ok, err := trustedOwner(parent)
	if err != nil {
		return fmt.Errorf("svc: checking the owner of %s: %w", parent, err)
	}
	if !ok {
		if err := setOwner(parent, admins); err != nil {
			return err
		}
	}
	// The owner keeps implicit WRITE_DAC whatever the DACL says, so the root is owned by Administrators before its DACL is set.
	if err := setOwner(root, admins); err != nil {
		return err
	}
	if err := ApplyACL(root, DataACL(account)); err != nil {
		return fmt.Errorf("svc: setting the data root ACL: %w", err)
	}
	for _, d := range l.Dirs() {
		if err := os.MkdirAll(d, 0o700); err != nil {
			return err
		}
	}
	return filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if path == root {
			return nil
		}
		if d.Type()&(fs.ModeSymlink|fs.ModeIrregular) != 0 {
			// never set an ACL through a link. Return nil, not fs.SkipDir: on a non-directory entry SkipDir skips every later
			// sibling (AG-T15 review item 2). WalkDir does not follow links, so nothing below the link is visited.
			return nil
		}
		if err := resetToInherited(path, admins); err != nil {
			return fmt.Errorf("svc: resetting the ACL of %s: %w", path, err)
		}
		return nil
	})
}

func (p *winPlatform) open(m *mgr.Mgr) (*mgr.Service, error) { return m.OpenService(p.name) }

func notExist(err error) bool { return errors.Is(err, windows.ERROR_SERVICE_DOES_NOT_EXIST) }

func (p *winPlatform) RegisterService(c ServiceConfig) error {
	m, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer m.Disconnect()
	cfg := mgr.Config{
		ServiceType: windows.SERVICE_WIN32_OWN_PROCESS, StartType: mgr.StartAutomatic, ErrorControl: mgr.ErrorNormal,
		DelayedAutoStart: c.DelayedAutoStart, ServiceStartName: c.Account, DisplayName: c.Display,
		Description: "Captures instrument messages and uploads them to LIMS.",
	}
	s, err := m.OpenService(p.name)
	switch {
	case err == nil:
		defer s.Close()
		cfg.BinaryPathName = syscall.EscapeArg(c.Binary) // quoted: the path has spaces
		if err := s.UpdateConfig(cfg); err != nil {
			return err
		}
	case notExist(err):
		s, err = m.CreateService(p.name, c.Binary, cfg)
		if err != nil {
			return err
		}
		defer s.Close()
	default:
		return err
	}
	acts := make([]mgr.RecoveryAction, 0, len(c.Recovery))
	for _, d := range c.Recovery {
		acts = append(acts, mgr.RecoveryAction{Type: mgr.ServiceRestart, Delay: d})
	}
	const resetPeriodSeconds = 24 * 60 * 60 // [CONV] failure count resets after a quiet day
	if err := s.SetRecoveryActions(acts, resetPeriodSeconds); err != nil {
		return err
	}
	return s.SetRecoveryActionsOnNonCrashFailures(true)
}

func (p *winPlatform) waitState(s *mgr.Service, want wsvc.State) error {
	deadline := time.Now().Add(serviceWait)
	for {
		st, err := s.Query()
		if err != nil {
			return err
		}
		if st.State == want {
			return nil
		}
		if want == wsvc.Running && st.State == wsvc.Stopped {
			return errors.New("the service stopped right after it started; see the log folder")
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("timed out waiting for the service (state %d)", st.State)
		}
		time.Sleep(250 * time.Millisecond)
	}
}

func (p *winPlatform) StartService() error {
	m, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer m.Disconnect()
	s, err := p.open(m)
	if err != nil {
		return err
	}
	defer s.Close()
	if err := s.Start(); err != nil && !errors.Is(err, windows.ERROR_SERVICE_ALREADY_RUNNING) {
		return err
	}
	return p.waitState(s, wsvc.Running)
}

func (p *winPlatform) StopService() error {
	m, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer m.Disconnect()
	s, err := p.open(m)
	if notExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	defer s.Close()
	if _, err := s.Control(wsvc.Stop); err != nil && !errors.Is(err, windows.ERROR_SERVICE_NOT_ACTIVE) {
		return err
	}
	return p.waitState(s, wsvc.Stopped)
}

func (p *winPlatform) RemoveService() error {
	m, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer m.Disconnect()
	s, err := p.open(m)
	if notExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	defer s.Close()
	if err := s.Delete(); err != nil && !errors.Is(err, windows.ERROR_SERVICE_MARKED_FOR_DELETE) {
		return err
	}
	return nil
}

// SendControl sends a user-defined control code to the service (spike S2: 128, 129 and 255 reach the handler from an elevated caller).
func (p *winPlatform) SendControl(code uint32) error {
	m, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer m.Disconnect()
	s, err := p.open(m)
	if err != nil {
		return err
	}
	defer s.Close()
	_, err = s.Control(wsvc.Cmd(code))
	return err
}

func netsh(args ...string) (string, error) {
	dir, err := windows.GetSystemDirectory()
	if err != nil {
		return "", err
	}
	out, err := exec.Command(filepath.Join(dir, "netsh.exe"), args...).CombinedOutput() // no shell, absolute path
	return strings.TrimSpace(string(out)), err
}

func (p *winPlatform) AddFirewallRule(exe string) error {
	args, err := FirewallAddArgs(exe)
	if err != nil {
		return err
	}
	_ = p.RemoveFirewallRule() // idempotent: never two rules with our name
	if out, err := netsh(args...); err != nil {
		return fmt.Errorf("netsh: %v: %s", err, out)
	}
	return nil
}

func (p *winPlatform) RemoveFirewallRule() error {
	out, err := netsh(FirewallDeleteArgs()...)
	if err == nil {
		return nil
	}
	// A missing rule is fine. Decide by asking whether the rule exists (exit code, not localised text).
	if _, showErr := netsh("advfirewall", "firewall", "show", "rule", "name="+FirewallRuleName); showErr != nil {
		return nil
	}
	return fmt.Errorf("netsh: %v: %s", err, out)
}
