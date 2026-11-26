//go:build windows

package queue

import "testing"

// The real free-space lookup exists only on Windows (diskfree_windows.go; diskfree_other.go returns an error by design),
// so this test lives in a Windows-only file, like dpapi_windows_test.go. Moved unchanged from queue_test.go.
func TestDiskGuardDefaultFreeBytesWorksOnTempDir(t *testing.T) {
	d := openT(t, dbPath(t), &testProtector{}, Options{})
	if _, err := d.DiskLow(); err != nil {
		t.Fatalf("real free-space lookup failed: %v", err)
	}
}
