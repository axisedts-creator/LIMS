// Command simulator is the CI session runner (02-TRD §15.3, AC-21.1): `simulator -sessions <dir>` runs every
// *.session.json in dir against the agent's link layers over an in-memory duplex. It opens no sockets.
// Exit 0 only if at least one session exists and all pass.
package main

import (
	"flag"
	"fmt"
	"io"
	"os"

	"lims/apps/bridge-agent/internal/simulator"
)

func main() { os.Exit(run(os.Args[1:], os.Stdout, os.Stderr)) }

func run(args []string, out, errw io.Writer) int {
	fs := flag.NewFlagSet("simulator", flag.ContinueOnError)
	fs.SetOutput(errw)
	dir := fs.String("sessions", "", "directory with *.session.json files")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if *dir == "" {
		fmt.Fprintln(errw, "usage: simulator -sessions <dir>")
		return 2
	}
	sessions, err := simulator.LoadDir(*dir)
	if err != nil {
		fmt.Fprintf(out, "FAIL load: %v\n", err)
		return 1
	}
	failed := 0
	for _, s := range sessions {
		scratch, err := os.MkdirTemp("", "simulator-")
		if err == nil {
			err = simulator.Run(s, scratch)
			_ = os.RemoveAll(scratch)
		}
		if err != nil {
			failed++
			fmt.Fprintf(out, "FAIL %q: %v\n", s.Name, err)
			continue
		}
		fmt.Fprintf(out, "PASS %q\n", s.Name)
	}
	fmt.Fprintf(out, "%d sessions, %d failed\n", len(sessions), failed)
	if failed > 0 {
		return 1
	}
	return 0
}
