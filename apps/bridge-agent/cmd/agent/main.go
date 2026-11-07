// Command agent is the bridge agent service entry (02-TRD §3, §5.13).
// AG-T01 skeleton: links the pinned SQLite driver so the pin is proven by the build.
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
