// Package cli is the bridge-agent command line (04-UI-UX §2, DECISION: CLI, no tray app, no local web page: no listener, REQ-SEC-114).
// Exit codes: 0 success, 1 usage error, 2 operation failed, 3 not elevated. Every command except `version` needs an elevated prompt.
// No command ever prints a device token or an enrolment code, not even inside an error.
package cli

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"strings"
	"time"

	"lims/apps/bridge-agent/internal/status"
	"lims/apps/bridge-agent/internal/svc"
)

const (
	ExitOK          = 0
	ExitUsage       = 1
	ExitFailed      = 2
	ExitNotElevated = 3
)

type VersionInfo struct{ Agent, Launcher, Build string }

type Deps struct {
	Out, Err io.Writer
	Env      svc.Env
	Pending  func() (int, error) // pending + rejected queue items, for `uninstall --purge`
	Version  VersionInfo
	Now      func() time.Time
}

const usageText = `usage: bridge-agent <command> [options]
  install --server <https-url> --enrolment-code <code> [--proxy <url>] [--account virtual|localservice] [--allow-lan-listener]
  enrol --enrolment-code <code>
  status [--json]
  instruments
  flush
  diagnostics --out <file.zip>
  firewall enable|disable
  uninstall [--purge] [--force-discard-pending]
  version
All commands except "version" need an elevated (Administrator) prompt.
`

// usageError is a mistake in the command line. It never carries a value the user typed.
type usageError struct{ msg string }

func (e usageError) Error() string { return e.msg }

// Run executes one command. args exclude the program name.
func Run(args []string, d Deps) int {
	if d.Out == nil {
		d.Out = io.Discard
	}
	if d.Err == nil {
		d.Err = io.Discard
	}
	if d.Now == nil {
		d.Now = time.Now
	}
	if len(args) == 0 {
		fmt.Fprint(d.Err, "bridge-agent: a command is required\n"+usageText)
		return ExitUsage
	}
	name, rest := args[0], args[1:]
	switch name {
	case "help", "-h", "--help":
		fmt.Fprint(d.Out, usageText)
		return ExitOK
	case "version":
		return cmdVersion(d, rest)
	}
	c, ok := commands[name]
	if !ok {
		fmt.Fprintf(d.Err, "bridge-agent: unknown command\n%s", usageText)
		return ExitUsage
	}
	// 1. parse and validate: a usage error never touches the machine.
	act, err := c(d, rest)
	if err != nil {
		return usageFail(d, name, err)
	}
	// 2. elevation before anything else runs.
	if !d.Env.Platform.IsElevated() {
		fmt.Fprintf(d.Err, "bridge-agent %s: this command needs an elevated (Administrator) prompt\n", name)
		return ExitNotElevated
	}
	// 3. act.
	return finish(d, name, act())
}

func usageFail(d Deps, name string, err error) int {
	fmt.Fprintf(d.Err, "bridge-agent %s: %s\n", name, svc.RedactSecrets(err.Error()))
	return ExitUsage
}

func finish(d Deps, name string, err error) int {
	switch {
	case err == nil:
		return ExitOK
	case errors.Is(err, svc.ErrNotElevated):
		fmt.Fprintf(d.Err, "bridge-agent %s: %s\n", name, svc.RedactSecrets(err.Error()))
		return ExitNotElevated
	case errors.Is(err, svc.ErrInvalidOptions):
		fmt.Fprintf(d.Err, "bridge-agent %s: %s\n", name, svc.RedactSecrets(err.Error()))
		return ExitUsage
	}
	fmt.Fprintf(d.Err, "bridge-agent %s: %s\n", name, svc.RedactSecrets(err.Error()))
	return ExitFailed
}

// A command parses its arguments (returning a usage error) and returns the action to run once elevation is confirmed.
type commandFunc func(d Deps, args []string) (func() error, error)

var commands map[string]commandFunc

func init() {
	commands = map[string]commandFunc{
		"install":         cmdInstall,
		"enrol":           cmdEnrol,
		"status":          cmdStatus,
		"instruments":     cmdInstruments,
		"flush":           cmdFlush,
		"diagnostics":     cmdDiagnostics,
		"firewall":        cmdFirewall,
		"uninstall":       cmdUninstall,
		"queue":           notImplemented,
		"test-connection": notImplemented,
	}
}

func notImplemented(Deps, []string) (func() error, error) {
	return func() error { return errors.New("this command is not available in this build") }, nil
}

func newFlags(name string) *flag.FlagSet {
	fs := flag.NewFlagSet(name, flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	return fs
}

// parse parses fs and rejects positional arguments (their text is never echoed: it may be a pasted secret).
func parse(fs *flag.FlagSet, args []string, positional int) error {
	if err := fs.Parse(args); err != nil {
		return errors.New(svc.RedactSecrets(err.Error()))
	}
	if fs.NArg() != positional {
		return usageError{"unexpected arguments"}
	}
	return nil
}

func cmdVersion(d Deps, args []string) int {
	if len(args) != 0 {
		fmt.Fprint(d.Err, "bridge-agent version: unexpected arguments\n")
		return ExitUsage
	}
	fmt.Fprintf(d.Out, "bridge-agent %s (launcher %s, build %s)\n", clean(d.Version.Agent), clean(d.Version.Launcher), clean(d.Version.Build))
	return ExitOK
}

func cmdInstall(d Deps, args []string) (func() error, error) {
	fs := newFlags("install")
	var o svc.InstallOptions
	fs.StringVar(&o.Server, "server", "", "")
	fs.StringVar(&o.EnrolmentCode, "enrolment-code", "", "")
	fs.StringVar(&o.Proxy, "proxy", "", "")
	fs.StringVar(&o.Account, "account", "", "")
	fs.BoolVar(&o.AllowLANListener, "allow-lan-listener", false, "")
	if err := parse(fs, args, 0); err != nil {
		return nil, err
	}
	if err := svc.ValidateOptions(o); err != nil {
		return nil, err
	}
	return func() error { return svc.Install(context.Background(), d.Env, o, d.Out) }, nil
}

func cmdEnrol(d Deps, args []string) (func() error, error) {
	fs := newFlags("enrol")
	var code string
	fs.StringVar(&code, "enrolment-code", "", "")
	if err := parse(fs, args, 0); err != nil {
		return nil, err
	}
	if !svc.ValidCode(code) {
		return nil, usageError{"--enrolment-code is required and must have the enrolment code format"}
	}
	return func() error { return svc.Enrol(context.Background(), d.Env, code, d.Out) }, nil
}

func cmdStatus(d Deps, args []string) (func() error, error) {
	fs := newFlags("status")
	asJSON := fs.Bool("json", false, "")
	if err := parse(fs, args, 0); err != nil {
		return nil, err
	}
	return func() error {
		st, err := readStatus(d)
		if err != nil {
			return err
		}
		if *asJSON {
			raw, err := json.MarshalIndent(st, "", "  ")
			if err != nil {
				return err
			}
			fmt.Fprintln(d.Out, string(raw))
			return nil
		}
		printStatus(d, st)
		return nil
	}, nil
}

func cmdInstruments(d Deps, args []string) (func() error, error) {
	if err := parse(newFlags("instruments"), args, 0); err != nil {
		return nil, err
	}
	return func() error {
		st, err := readStatus(d)
		if err != nil {
			return err
		}
		printInstruments(d, st)
		return nil
	}, nil
}

func cmdFlush(d Deps, args []string) (func() error, error) {
	if err := parse(newFlags("flush"), args, 0); err != nil {
		return nil, err
	}
	return func() error {
		// custom control 129; fallback status\request.json that the service polls every 5 s (02-TRD 5.12)
		if err := d.Env.Platform.SendControl(svc.CtlFlushNow); err == nil {
			fmt.Fprintln(d.Out, "Upload requested.")
			return nil
		}
		if err := svc.WriteRequest(d.Env.Layout.StatusDir(), svc.RequestFlushNow); err != nil {
			return fmt.Errorf("could not reach the service and could not write the request file: %w", err)
		}
		fmt.Fprintf(d.Out, "Upload requested (request file written; the service reads it within %d s).\n", int(svc.RequestPollInterval/time.Second))
		return nil
	}, nil
}

func cmdFirewall(d Deps, args []string) (func() error, error) {
	fs := newFlags("firewall")
	bad := usageError{"usage: firewall enable|disable"}
	if err := parse(fs, args, 1); err != nil {
		return nil, bad
	}
	switch fs.Arg(0) {
	case "enable":
		return func() error {
			if err := d.Env.Platform.AddFirewallRule(d.Env.Layout.LauncherExe()); err != nil {
				return err
			}
			fmt.Fprintf(d.Out, "Firewall rule %q enabled (private and domain networks, local subnet only).\n", svc.FirewallRuleName)
			return nil
		}, nil
	case "disable":
		return func() error {
			if err := d.Env.Platform.RemoveFirewallRule(); err != nil {
				return err
			}
			fmt.Fprintf(d.Out, "Firewall rule %q removed.\n", svc.FirewallRuleName)
			return nil
		}, nil
	}
	return nil, bad
}

func cmdUninstall(d Deps, args []string) (func() error, error) {
	fs := newFlags("uninstall")
	var o svc.UninstallOptions
	fs.BoolVar(&o.Purge, "purge", false, "")
	fs.BoolVar(&o.ForceDiscardPending, "force-discard-pending", false, "")
	if err := parse(fs, args, 0); err != nil {
		return nil, err
	}
	return func() error { return svc.Uninstall(context.Background(), d.Env, o, d.Pending, d.Out) }, nil
}

func readStatus(d Deps) (status.Status, error) {
	st, err := status.Read(d.Env.Layout.StatusDir())
	switch {
	case errors.Is(err, status.ErrNotFound):
		return st, errors.New("status.json does not exist yet: the service is not running or has not written its first status")
	case err != nil:
		return st, fmt.Errorf("status.json is unreadable: %w", err)
	}
	return st, nil
}

// clean makes a value safe to print on a terminal: control characters (escape sequences) become '?'.
func clean(s string) string {
	return strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f || (r >= 0x80 && r < 0xa0) {
			return '?'
		}
		return r
	}, s)
}
