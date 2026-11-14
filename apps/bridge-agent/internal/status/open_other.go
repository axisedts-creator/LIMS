//go:build !windows

package status

import "os"

func openShared(p string) (*os.File, error) { return os.Open(p) }
