// Command launcher is bridge-launcher.exe, the binary registered with the SCM (02-TRD 5.11/5.12). It is the trust anchor of the
// self-update: it re-verifies, switches, health-gates and rolls back agent versions through internal/update, and opens no listener.
package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"

	"lims/apps/bridge-agent/internal/update"
)

const serviceName = "LimsBridgeAgent"

func main() {
	pd := os.Getenv("ProgramData")
	if pd == "" {
		pd = `C:\ProgramData`
	}
	l, err := update.NewLauncher(update.LauncherOptions{
		Root:         filepath.Join(pd, "LIMS", "BridgeAgent"),
		Keys:         update.EmbeddedReleaseKeys(),
		Authenticode: update.NewAuthenticode(),
		Start:        startAgent,
		// Policy nil: downgrades are never allowed until the applied signed config is wired in (open point, AG-T16 notes).
	})
	if err != nil {
		fmt.Fprintln(os.Stderr, "bridge-launcher:", err)
		os.Exit(2)
	}
	os.Exit(runService(l.Run))
}

// runConsole supervises in the foreground (debugging, non-service runs).
func runConsole(run func(context.Context) error) int {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	if err := run(ctx); err != nil {
		fmt.Fprintln(os.Stderr, "bridge-launcher:", err)
		return 1
	}
	return 0
}

type agentProc struct{ cmd *exec.Cmd }

func startAgent(exe string) (update.Proc, error) {
	cmd := exec.Command(exe)
	cmd.Dir = filepath.Dir(exe)
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	return agentProc{cmd}, nil
}

func (p agentProc) Wait() (int, error) {
	err := p.cmd.Wait()
	return p.cmd.ProcessState.ExitCode(), err
}

func (p agentProc) Kill() error { return p.cmd.Process.Kill() }
