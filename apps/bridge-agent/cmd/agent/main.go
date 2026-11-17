//go:build !e2e

// Command agent is the bridge agent service entry (02-TRD §3, §5.13).
// AG-T01 skeleton: links the pinned SQLite driver so the pin is proven by the build.
// The `e2e` build tag swaps this file for e2e_main.go (INT-T01 test build).
package main

import (
	"fmt"
	"os"

	_ "modernc.org/sqlite"
)

func main() {
	fmt.Fprintln(os.Stderr, "bridge-agent: not implemented")
	os.Exit(2)
}
