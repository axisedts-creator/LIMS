package svc

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"lims/apps/bridge-agent/internal/secrets"
)

// OSVersion is what the platform reports. Name is "Windows 10" or "Windows 11" for display and for the enrol request.
type OSVersion struct {
	Major, Minor, Build uint32
	Name                string
}

// Platform is every machine-changing or machine-probing call of install/uninstall/CLI, so the flow is testable without admin rights.
// The real implementation is NewWindowsPlatform.
type Platform interface {
	OSVersion() (OSVersion, error)
	IsElevated() bool
	PrepareFolders(l Layout, account string) error // creates the six folders with DataACL, replacing any existing DACL
	RegisterService(c ServiceConfig) error         // create, or update when it already exists
	StartService() error
	StopService() error   // a service that is not installed or not running is not an error
	RemoveService() error // a service that is not installed is not an error
	AddFirewallRule(exe string) error
	RemoveFirewallRule() error // a missing rule is not an error
	SendControl(code uint32) error
}

type EnrolRequest struct {
	Server, Code, HostFingerprintSHA256, AgentVersion, LauncherVersion, OSVersion string
}

type EnrolResult struct {
	AgentID, CentreID, DeviceToken, ServerTime string
	ConfigVersion                              int
}

// Enroller performs E01 enrolAgent. The real one is an HTTPS client; its errors may echo the code, so the installer redacts them.
type Enroller interface {
	Enrol(ctx context.Context, r EnrolRequest) (EnrolResult, error)
}

type Env struct {
	Platform Platform
	Enroller Enroller
	Layout   Layout
	// NewProtector wraps secrets. entropy = []byte(agent id) (02-TRD 5.12).
	NewProtector                  func(entropy []byte) secrets.Protector
	AgentVersion, LauncherVersion string
	HostFingerprint               func() (string, error)
}

type InstallOptions struct {
	Server, EnrolmentCode, Proxy, Account string
	AllowLANListener                      bool
}

var (
	codeRe    = regexp.MustCompile(`^lmse_[A-Za-z0-9_-]{22}$`)
	tokenRe   = regexp.MustCompile(`^lmsd_[A-Za-z0-9_-]{43}$`)
	agentIDRe = regexp.MustCompile(`^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$`)
	secretRe  = regexp.MustCompile(`lms[de]_[A-Za-z0-9_-]*`)
)

// RedactSecrets replaces every enrolment-code or device-token shaped string. Used for every error and log line that leaves the
// installer, and for the diagnostics archive.
func RedactSecrets(s string) string { return secretRe.ReplaceAllString(s, "[redacted]") }

// ValidCode reports whether s has the enrolment-code shape (lmse_ + 22 base64url).
func ValidCode(s string) bool { return codeRe.MatchString(s) }

func invalid(msg string) error { return fmt.Errorf("%w: %s", ErrInvalidOptions, msg) }

// ValidateOptions checks the install options without touching the machine. Messages never echo a value.
func ValidateOptions(o InstallOptions) error {
	u, err := url.Parse(o.Server)
	switch {
	case o.Server == "" || err != nil || strings.ContainsAny(o.Server, " \t\r\n"):
		return invalid("--server must be an https URL")
	case u.Scheme != "https":
		return invalid("--server must use https")
	case u.Hostname() == "":
		return invalid("--server has no host")
	case u.User != nil:
		return invalid("--server must not contain credentials")
	case u.RawQuery != "" || u.Fragment != "" || u.Opaque != "":
		return invalid("--server must be a plain https URL")
	}
	if !codeRe.MatchString(o.EnrolmentCode) {
		return invalid("--enrolment-code does not have the enrolment code format")
	}
	if _, err := ParseAccount(o.Account); err != nil {
		return err
	}
	if o.Proxy != "" {
		p, err := url.Parse(o.Proxy)
		switch {
		case err != nil || strings.ContainsAny(o.Proxy, " \t\r\n"):
			return invalid("--proxy must be an http or https URL")
		case p.Scheme != "http" && p.Scheme != "https":
			return invalid("--proxy must be an http or https URL")
		case p.Hostname() == "":
			return invalid("--proxy has no host")
		case p.User != nil:
			return invalid("--proxy must not contain credentials (they would be stored in a file)")
		}
	}
	return nil
}

func supported(v OSVersion) bool { return v.Major >= 10 } // LD-93: Windows 10 and 11

// redactedError keeps the error chain (errors.Is/As) but hides the text, which may echo the code or a token.
type redactedError struct {
	msg   string
	inner error
}

func (e *redactedError) Error() string { return e.msg }
func (e *redactedError) Unwrap() error { return e.inner }

func redact(prefix string, err error, hide ...string) error {
	m := err.Error()
	for _, s := range hide {
		if s != "" {
			m = strings.ReplaceAll(m, s, "[redacted]")
		}
	}
	return &redactedError{msg: prefix + ": " + RedactSecrets(m), inner: err}
}

func step(out io.Writer, n int, format string, a ...any) {
	fmt.Fprintf(out, "[%d/5] "+format+"\n", append([]any{n}, a...)...)
}

// Install checks, prepares folders, enrols, stores the token (DPAPI blob keyed by the agent id), registers and starts the service
// (AC-01.4). Nothing is stored and the service is not started unless enrolment returned a well-formed token. The first heartbeat
// and the configuration download are done by the service after it starts (AG-T11 / AG-T12), so they are not install steps.
func Install(ctx context.Context, e Env, o InstallOptions, out io.Writer) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := ValidateOptions(o); err != nil {
		return err
	}
	account, _ := ParseAccount(o.Account)
	if !e.Platform.IsElevated() {
		return ErrNotElevated
	}
	v, err := e.Platform.OSVersion()
	if err != nil {
		return fmt.Errorf("svc: cannot determine the Windows version: %w", err) // fail closed
	}
	if !supported(v) {
		return ErrUnsupportedOS
	}
	if e.NewProtector == nil || e.Enroller == nil || e.HostFingerprint == nil {
		return errors.New("svc: install is not wired (protector, enroller, host fingerprint)")
	}
	step(out, 1, "Checking Windows version ........ %s (build %d)  OK", v.Name, v.Build)

	if err := ctx.Err(); err != nil {
		return err
	}
	if err := e.Platform.PrepareFolders(e.Layout, account); err != nil {
		return fmt.Errorf("svc: creating folders and permissions: %w", err)
	}
	step(out, 2, "Creating folders and permissions  OK")

	fp, err := e.HostFingerprint()
	if err != nil {
		return fmt.Errorf("svc: host fingerprint: %w", err)
	}
	osv := fmt.Sprintf("%s %d.%d.%d", v.Name, v.Major, v.Minor, v.Build)
	if len(osv) > 64 {
		osv = osv[:64]
	}
	res, err := e.Enroller.Enrol(ctx, EnrolRequest{Server: o.Server, Code: o.EnrolmentCode, HostFingerprintSHA256: fp,
		AgentVersion: e.AgentVersion, LauncherVersion: e.LauncherVersion, OSVersion: osv})
	if err != nil {
		return redact("svc: enrolment failed", err, o.EnrolmentCode)
	}
	if !tokenRe.MatchString(res.DeviceToken) || !agentIDRe.MatchString(res.AgentID) {
		return errors.New("svc: enrolment failed: the server reply is malformed") // never echo it
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := secrets.SaveToken(e.Layout.SecretsDir(), res.DeviceToken, e.NewProtector([]byte(res.AgentID))); err != nil {
		return redact("svc: storing the device token", err, res.DeviceToken)
	}
	if err := WriteConfigLocal(e.Layout, o.Server, o.Proxy); err != nil {
		return fmt.Errorf("svc: writing config.local.json: %w", err)
	}
	step(out, 3, "Enrolling with %s ...  OK  agent %s", o.Server, res.AgentID)

	if err := e.Platform.RegisterService(NewServiceConfig(e.Layout, account)); err != nil {
		return fmt.Errorf("svc: registering the service: %w", err)
	}
	step(out, 4, "Registering service %s (%s)  OK", ServiceName, account)
	if o.AllowLANListener {
		if err := e.Platform.AddFirewallRule(e.Layout.LauncherExe()); err != nil {
			return fmt.Errorf("svc: adding the firewall rule: %w", err)
		}
		fmt.Fprintf(out, "      Firewall rule %q added (private and domain networks, local subnet only)\n", FirewallRuleName)
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := e.Platform.StartService(); err != nil {
		return fmt.Errorf("svc: starting the service: %w", err)
	}
	step(out, 5, "Starting service  OK")
	fmt.Fprintln(out, `Installed. Check "bridge-agent status" or the Agents page.`)
	return nil
}

type localConfig struct {
	ServerURL string `json:"server_url"`
	ProxyURL  string `json:"proxy_url,omitempty"`
}

// WriteConfigLocal writes config\config.local.json (server URL and optional proxy only) atomically. The server URL lives only here, so
// a signed server configuration cannot redirect the agent (02-TRD 5.11).
func WriteConfigLocal(l Layout, server, proxy string) error {
	raw, err := json.MarshalIndent(localConfig{ServerURL: server, ProxyURL: proxy}, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(l.ConfigDir(), "config-*.tmp")
	if err != nil {
		return err
	}
	name := tmp.Name()
	_, err = tmp.Write(raw)
	if err == nil {
		err = tmp.Sync()
	}
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Rename(name, l.ConfigFile())
	}
	if err != nil {
		_ = os.Remove(name)
	}
	return err
}

// ReadServerURL returns the install-time server URL from config.local.json (used by `enrol`).
func ReadServerURL(l Layout) (string, error) {
	raw, err := os.ReadFile(l.ConfigFile())
	if err != nil {
		return "", err
	}
	var c localConfig
	if err := json.Unmarshal(raw, &c); err != nil || c.ServerURL == "" {
		return "", errors.New("svc: config.local.json has no server_url")
	}
	return c.ServerURL, nil
}

// Enrol re-enrols an installed agent (new PC token / after revocation). The existing token is replaced only after a well-formed reply;
// a failed attempt leaves it untouched. The agent id of the reply is the entropy of the new blob.
func Enrol(ctx context.Context, e Env, code string, out io.Writer) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if !codeRe.MatchString(code) {
		return invalid("--enrolment-code does not have the enrolment code format")
	}
	if !e.Platform.IsElevated() {
		return ErrNotElevated
	}
	server, err := ReadServerURL(e.Layout)
	if err != nil {
		return errors.New("svc: the agent is not installed (no config.local.json); run install first")
	}
	v, err := e.Platform.OSVersion()
	if err != nil {
		return fmt.Errorf("svc: cannot determine the Windows version: %w", err)
	}
	fp, err := e.HostFingerprint()
	if err != nil {
		return fmt.Errorf("svc: host fingerprint: %w", err)
	}
	osv := fmt.Sprintf("%s %d.%d.%d", v.Name, v.Major, v.Minor, v.Build)
	if len(osv) > 64 {
		osv = osv[:64]
	}
	res, err := e.Enroller.Enrol(ctx, EnrolRequest{Server: server, Code: code, HostFingerprintSHA256: fp,
		AgentVersion: e.AgentVersion, LauncherVersion: e.LauncherVersion, OSVersion: osv})
	if err != nil {
		return redact("svc: enrolment failed", err, code)
	}
	if !tokenRe.MatchString(res.DeviceToken) || !agentIDRe.MatchString(res.AgentID) {
		return errors.New("svc: enrolment failed: the server reply is malformed")
	}
	if err := secrets.SaveToken(e.Layout.SecretsDir(), res.DeviceToken, e.NewProtector([]byte(res.AgentID))); err != nil {
		return redact("svc: storing the device token", err, res.DeviceToken)
	}
	fmt.Fprintf(out, "Enrolled agent %s with %s  OK\n", res.AgentID, server)
	return nil
}

type UninstallOptions struct{ Purge, ForceDiscardPending bool }

// PendingError refuses a purge while pending or rejected items exist (04-UI-UX §2).
type PendingError struct{ Count int }

func (e *PendingError) Error() string {
	return fmt.Sprintf("refusing to purge: %d pending or rejected queue item(s) would be lost; run again with --force-discard-pending to discard them", e.Count)
}

// purgeRootOK allows only <anything>\LIMS\BridgeAgent, absolute, and not a link: a purge must never delete an arbitrary folder.
func purgeRootOK(root string) error {
	c := filepath.Clean(root)
	if root == "" || !filepath.IsAbs(c) ||
		!strings.EqualFold(filepath.Base(c), "BridgeAgent") || !strings.EqualFold(filepath.Base(filepath.Dir(c)), "LIMS") {
		return errors.New("svc: refusing to purge: the data folder is not <ProgramData>\\LIMS\\BridgeAgent")
	}
	if fi, err := os.Lstat(c); err == nil && (!fi.IsDir() || fi.Mode()&(os.ModeSymlink|os.ModeIrregular) != 0) {
		return errors.New("svc: refusing to purge: the data folder is a link or not a folder")
	}
	return nil
}

// Uninstall stops and removes the service and the firewall rule. Data (queue, secrets) is kept unless Purge. A purge is refused
// before anything is changed when the data root is wrong, when items are pending/rejected (unless ForceDiscardPending), or when the
// pending count cannot be read (fail closed).
func Uninstall(ctx context.Context, e Env, o UninstallOptions, pending func() (int, error), out io.Writer) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if !e.Platform.IsElevated() {
		return ErrNotElevated
	}
	if o.Purge {
		if err := purgeRootOK(e.Layout.DataRoot); err != nil {
			return err
		}
		if !o.ForceDiscardPending {
			if pending == nil {
				return errors.New("svc: refusing to purge: the pending count is unknown")
			}
			n, err := pending()
			if err != nil {
				return fmt.Errorf("svc: refusing to purge: the pending count is unknown: %w", err)
			}
			if n > 0 {
				return &PendingError{Count: n}
			}
		}
	}
	if err := e.Platform.StopService(); err != nil {
		return fmt.Errorf("svc: stopping the service: %w", err)
	}
	if err := e.Platform.RemoveService(); err != nil {
		return fmt.Errorf("svc: removing the service: %w", err)
	}
	if err := e.Platform.RemoveFirewallRule(); err != nil {
		return fmt.Errorf("svc: removing the firewall rule: %w", err)
	}
	fmt.Fprintf(out, "Service %s removed.\n", ServiceName)
	if o.Purge {
		if err := os.RemoveAll(filepath.Clean(e.Layout.DataRoot)); err != nil {
			return fmt.Errorf("svc: purging the data folder: %w", err)
		}
		fmt.Fprintln(out, "Data folder deleted.")
	} else {
		fmt.Fprintln(out, "Data folder kept (queue and secrets). Use --purge to delete it.")
	}
	return nil
}
