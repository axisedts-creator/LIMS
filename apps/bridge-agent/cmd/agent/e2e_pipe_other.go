//go:build e2e && !windows

package main

import (
	"io"
	"net"
)

// dialPipe connects to the simulator's unix socket (the Linux stand-in for a COM port).
func dialPipe(path string) (io.ReadWriteCloser, error) { return net.Dial("unix", path) }
