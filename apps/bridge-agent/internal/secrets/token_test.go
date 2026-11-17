package secrets

// AG-T04 tests for token.go. Spec: 02-TRD 5.12 (secrets\device-token.bin = DPAPI blob, never plaintext), REQ-SEC-118, AC-01.4.
//
// Contract the writer must implement in package secrets (names are the tests' contract):
//
//	type Protector interface {                         // satisfied by *DPAPI (dpapi_windows.go) and by test fakes
//	    Protect(plain []byte) ([]byte, error)
//	    Unprotect(blob []byte) ([]byte, error)
//	}
//	const TokenFile = "device-token.bin"
//	var ErrNoToken error                               // no file yet (not enrolled)
//	func SaveToken(dir, token string, p Protector) error   // dir exists; writes dir\TokenFile atomically (temp file + rename), no temp file left
//	func LoadToken(dir string, p Protector) (string, error)
//
// Windows only (dpapi_windows.go):
//
//	type Scope int ; const ( ScopeUser Scope = iota; ScopeMachine )   // ScopeMachine = CRYPTPROTECT_LOCAL_MACHINE (fallback only, LD-94 / spike S1)
//	func NewDPAPI(scope Scope, entropy []byte) *DPAPI                // entropy may be nil
//	func (*DPAPI) Protect / Unprotect                                // CryptProtectData / CryptUnprotectData
import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Synthetic token with the lmsd_ prefix shape (AC-01.4); not a real credential.
var testToken = "lmsd_" + strings.Repeat("A1b2", 11)[:43]

type fakeProtector struct{ key []byte }

func newFake(b byte) fakeProtector { return fakeProtector{key: bytes.Repeat([]byte{b}, 32)} }

func (f fakeProtector) gcm() cipher.AEAD {
	b, _ := aes.NewCipher(f.key)
	g, _ := cipher.NewGCM(b)
	return g
}

func (f fakeProtector) Protect(plain []byte) ([]byte, error) {
	g := f.gcm()
	n := make([]byte, g.NonceSize())
	_, _ = rand.Read(n)
	return append(n, g.Seal(nil, n, plain, nil)...), nil
}

func (f fakeProtector) Unprotect(blob []byte) ([]byte, error) {
	g := f.gcm()
	if len(blob) < g.NonceSize() {
		return nil, errors.New("short blob")
	}
	return g.Open(nil, blob[:g.NonceSize()], blob[g.NonceSize():], nil)
}

func TestTokenRoundTrip(t *testing.T) {
	dir := t.TempDir()
	p := newFake(1)
	if err := SaveToken(dir, testToken, p); err != nil {
		t.Fatal(err)
	}
	got, err := LoadToken(dir, p)
	if err != nil || got != testToken {
		t.Fatalf("LoadToken = %q, %v", got, err)
	}
}

func TestTokenFileHoldsNoPlaintext(t *testing.T) {
	dir := t.TempDir()
	if err := SaveToken(dir, testToken, newFake(1)); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(filepath.Join(dir, TokenFile))
	if err != nil {
		t.Fatal(err)
	}
	if TokenFile != "device-token.bin" {
		t.Errorf("TokenFile = %q", TokenFile)
	}
	if bytes.Contains(b, []byte(testToken)) || bytes.Contains(b, []byte("lmsd_")) {
		t.Error("token plaintext (or its prefix) found in device-token.bin (REQ-SEC-118)")
	}
}

func TestLoadTokenMissing(t *testing.T) {
	if _, err := LoadToken(t.TempDir(), newFake(1)); !errors.Is(err, ErrNoToken) {
		t.Errorf("err = %v, want ErrNoToken", err)
	}
}

func TestLoadTokenCorruptIsNotNoToken(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, TokenFile), []byte("garbage-not-a-blob"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := LoadToken(dir, newFake(1))
	if err == nil || errors.Is(err, ErrNoToken) {
		t.Errorf("err = %v, want a decrypt error distinct from ErrNoToken (a corrupt file is not 'not enrolled')", err)
	}
}

func TestLoadTokenBitFlipFails(t *testing.T) {
	dir := t.TempDir()
	p := newFake(1)
	if err := SaveToken(dir, testToken, p); err != nil {
		t.Fatal(err)
	}
	f := filepath.Join(dir, TokenFile)
	b, _ := os.ReadFile(f)
	b[len(b)/2] ^= 0xff
	_ = os.WriteFile(f, b, 0o600)
	if got, err := LoadToken(dir, p); err == nil {
		t.Errorf("tampered blob decrypted to %q", got)
	}
}

func TestLoadTokenWrongProtectorFails(t *testing.T) {
	dir := t.TempDir()
	if err := SaveToken(dir, testToken, newFake(1)); err != nil {
		t.Fatal(err)
	}
	if got, err := LoadToken(dir, newFake(2)); err == nil {
		t.Errorf("wrong protector returned %q", got)
	}
}

func TestSaveTokenReplacesAndLeavesNoTempFiles(t *testing.T) {
	dir := t.TempDir()
	p := newFake(1)
	for _, tok := range []string{testToken, "lmsd_" + strings.Repeat("Z9y8", 11)[:43]} {
		if err := SaveToken(dir, tok, p); err != nil {
			t.Fatal(err)
		}
		if got, err := LoadToken(dir, p); err != nil || got != tok {
			t.Fatalf("LoadToken = %q, %v, want %q", got, err, tok)
		}
	}
	ents, _ := os.ReadDir(dir)
	if len(ents) != 1 || ents[0].Name() != TokenFile {
		t.Errorf("dir holds %d entries (%v), want only %s", len(ents), ents, TokenFile)
	}
}

func TestSaveTokenRejectsEmptyAndProtectError(t *testing.T) {
	dir := t.TempDir()
	if err := SaveToken(dir, "", newFake(1)); err == nil {
		t.Error("empty token must be rejected")
	}
	failing := failProtector{}
	if err := SaveToken(dir, testToken, failing); err == nil {
		t.Error("Protect failure must fail SaveToken")
	}
	if _, err := os.Stat(filepath.Join(dir, TokenFile)); err == nil {
		t.Error("no file may be left behind when Protect fails (never write plaintext as a fallback)")
	}
	ents, _ := os.ReadDir(dir)
	if len(ents) != 0 {
		t.Errorf("leftover files: %v", ents)
	}
}

func TestFailedSaveKeepsPreviousToken(t *testing.T) {
	dir := t.TempDir()
	p := newFake(1)
	if err := SaveToken(dir, testToken, p); err != nil {
		t.Fatal(err)
	}
	if err := SaveToken(dir, "lmsd_new", failProtector{}); err == nil {
		t.Fatal("want error")
	}
	if got, err := LoadToken(dir, p); err != nil || got != testToken {
		t.Errorf("previous token lost after a failed save: %q %v", got, err)
	}
}

type failProtector struct{}

func (failProtector) Protect([]byte) ([]byte, error)   { return nil, errors.New("dpapi down") }
func (failProtector) Unprotect([]byte) ([]byte, error) { return nil, errors.New("dpapi down") }
