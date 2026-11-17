//go:build !windows

package queue

import "errors"

// The agent runs on Windows only (LD-93/LD-94); other platforms must inject Options.FreeBytes.
func freeBytes(string) (int64, error) {
	return 0, errors.New("queue: free-space lookup is Windows-only")
}
