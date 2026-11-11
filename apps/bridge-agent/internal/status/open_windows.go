//go:build windows

package status

import (
	"os"

	"golang.org/x/sys/windows"
)

// openShared opens p for reading with FILE_SHARE_DELETE, which Go's os.Open does not set. Without it a reader makes the service's
// atomic rename fail (access denied) for as long as the file is open; with it the rename always goes through.
func openShared(p string) (*os.File, error) {
	name, err := windows.UTF16PtrFromString(p)
	if err != nil {
		return nil, err
	}
	h, err := windows.CreateFile(name, windows.GENERIC_READ,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil, windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		return nil, &os.PathError{Op: "open", Path: p, Err: err}
	}
	return os.NewFile(uintptr(h), p), nil
}
