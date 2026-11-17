//go:build e2e && windows

package main

import (
	"io"
	"os"
)

// dialPipe opens the simulator's named pipe (\\.\pipe\name). ASTM is half-duplex and the caller never reads and writes at once.
func dialPipe(path string) (io.ReadWriteCloser, error) { return os.OpenFile(path, os.O_RDWR, 0) }
