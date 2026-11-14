//go:build windows

package filedrop_test

// AG-T14 Windows integration: real NTFS semantics (junctions, exclusive locks, case-insensitive names).

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestWindowsJunctionOutOfFolderIsNotFollowed(t *testing.T) {
	r := newRig(t, nil)
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret.pdf"), []byte("OUTSIDE-FOLDER"), 0o644); err != nil {
		t.Fatal(err)
	}
	out, err := exec.Command("cmd", "/c", "mklink", "/J", filepath.Join(r.dir, "junc"), outside).CombinedOutput()
	if err != nil {
		t.Skipf("mklink /J failed: %v %s", err, out)
	}
	r.write("ok.pdf", pdf)
	r.settle()
	for _, in := range r.store.items {
		if strings.Contains(string(in.Raw), "OUTSIDE-FOLDER") {
			t.Fatal("captured a file through a directory junction")
		}
	}
	if r.store.count() != 1 {
		t.Fatalf("captured %d, want only ok.pdf", r.store.count())
	}
}

func TestWindowsShortcutIgnored(t *testing.T) {
	r := newRig(t, nil)
	r.write("target.pdf.lnk", []byte("L\x00\x00\x00shortcut"))
	r.settle()
	if r.store.count() != 0 {
		t.Fatal(".lnk shortcut captured")
	}
}

func TestWindowsExclusivelyLockedFileWaitsThenCaptured(t *testing.T) {
	r := newRig(t, nil)
	p := r.write("busy.pdf", pdf)
	name, _ := syscall.UTF16PtrFromString(p)
	h, err := syscall.CreateFile(name, syscall.GENERIC_READ|syscall.GENERIC_WRITE, 0, nil, syscall.OPEN_EXISTING, syscall.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		t.Fatalf("lock: %v", err)
	}
	released := false
	defer func() {
		if !released {
			_ = syscall.CloseHandle(h)
		}
	}()
	r.settle() // instrument still holds the file: read fails, no panic, no capture, no seen row
	if r.store.count() != 0 {
		t.Fatal("captured a file the instrument still holds open")
	}
	_ = syscall.CloseHandle(h)
	released = true
	r.clk.Advance(6 * time.Second)
	r.scan()
	r.clk.Advance(6 * time.Second)
	r.scan()
	if r.store.count() != 1 || !bytes.Equal(r.store.items[0].Raw, pdf) {
		t.Fatalf("captured %d after the lock was released, want 1", r.store.count())
	}
}

func TestWindowsExtensionCaseInsensitiveAndMoveRealFile(t *testing.T) {
	r := newRig(t, nil)
	r.w = r.build(cfgMove(r), r.store)
	p := r.write("SCAN.JPG", []byte("\xff\xd8\xff\xe0jpeg-bytes"))
	r.settle()
	if r.store.count() != 1 {
		t.Fatalf("captured %d, want 1 (.JPG)", r.store.count())
	}
	if _, err := os.Stat(p); !os.IsNotExist(err) {
		t.Fatal("source not moved")
	}
	if _, err := os.Stat(filepath.Join(r.dir, "captured", "SCAN.JPG")); err != nil {
		t.Fatalf("moved file missing: %v", err)
	}
}
