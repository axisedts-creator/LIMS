//go:build windows

package update_test

// Windows integration (AG-T16 "tests"): the REAL WinVerifyTrustEx verifier, real file renames, the real go-test binary as an unsigned PE.
// A genuinely Authenticode-signed fixture needs a certificate trusted by the machine, which CI/dev boxes do not have by default, so the
// positive case is opt-in: set LIMS_AG_T16_SIGNED_EXE (path to a validly signed PE) and LIMS_AG_T16_SIGNED_CN (its signer subject CN).
import (
	"os"
	"path/filepath"
	"testing"

	"lims/apps/bridge-agent/internal/update"
)

func copyExe(t *testing.T, dst string) {
	t.Helper()
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(self)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(dst, b, 0o700); err != nil {
		t.Fatal(err)
	}
}

func TestRealAuthenticodeRejectsUnsignedExe(t *testing.T) {
	p := filepath.Join(t.TempDir(), "agent.exe")
	copyExe(t, p)
	if pub, err := update.NewAuthenticode().Publisher(p); err == nil {
		t.Fatalf("WinVerifyTrustEx accepted an unsigned PE (publisher %q)", pub)
	}
}

func TestRealAuthenticodeRejectsMissingAndNonPEFile(t *testing.T) {
	dir := t.TempDir()
	av := update.NewAuthenticode()
	if _, err := av.Publisher(filepath.Join(dir, "nope.exe")); err == nil {
		t.Fatal("missing file accepted")
	}
	junk := filepath.Join(dir, "agent.exe")
	if err := os.WriteFile(junk, []byte("not a PE"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := av.Publisher(junk); err == nil {
		t.Fatal("non-PE file accepted")
	}
}

// End to end with the real verifier: a package that is perfectly signed by the release key but whose agent.exe is not Authenticode
// signed must be refused (AC-15.2). The Ed25519 check alone is not enough.
func TestStageWithRealAuthenticodeRefusesUnsignedAgent(t *testing.T) {
	r := newRig(t)
	self, _ := os.Executable()
	exe, err := os.ReadFile(self)
	if err != nil {
		t.Fatal(err)
	}
	z := buildZip(t, entry{"agent.exe", exe}, entry{"manifest.json", []byte(`{}`)})
	rel := signRelease("1.1.0", z, r.priv, relKeyID, goodPub)
	wantVerifyFailed(t, update.Stage(r.root, r.part("1.1.0", z), rel, r.keys, update.NewAuthenticode()))
	r.notStaged("1.1.0")
}

func TestRealAuthenticodeAcceptsSignedExeAndRejectsItOnceModified(t *testing.T) {
	src, cn := os.Getenv("LIMS_AG_T16_SIGNED_EXE"), os.Getenv("LIMS_AG_T16_SIGNED_CN")
	if src == "" || cn == "" {
		t.Skip("set LIMS_AG_T16_SIGNED_EXE and LIMS_AG_T16_SIGNED_CN to run against a validly signed PE")
	}
	b, err := os.ReadFile(src)
	if err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(t.TempDir(), "agent.exe")
	if err := os.WriteFile(p, b, 0o700); err != nil {
		t.Fatal(err)
	}
	av := update.NewAuthenticode()
	if got, err := av.Publisher(p); err != nil || got != cn {
		t.Fatalf("Publisher = %q, %v; want %q", got, err, cn)
	}
	b[len(b)-1] ^= 0xff // appended/overlay or section byte change invalidates the hash
	b[len(b)/2] ^= 0xff
	if err := os.WriteFile(p, b, 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := av.Publisher(p); err == nil {
		t.Fatal("modified signed exe still verifies")
	}
}

// The switch must be atomic on a real NTFS volume: current.json is replaced by rename, never left half-written.
func TestLauncherCurrentJSONReplacedAtomically(t *testing.T) {
	l := newLRig(t)
	l.installed("1.0.0")
	l.stage("1.1.0")
	l.on("1.0.0", step{exit: update.ExitApply})
	l.on("1.1.0", step{healthy: true, hang: true})
	l.run()
	l.waitStarts(2)
	if m, _ := filepath.Glob(l.path("current.json*")); len(m) != 1 {
		t.Fatalf("temp files left next to current.json: %v", m)
	}
	if v := l.currentVersion(); v != "1.1.0" {
		t.Fatalf("current = %s", v)
	}
}
