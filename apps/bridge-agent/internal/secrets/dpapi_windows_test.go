package secrets

// DPAPI wrap/unwrap (02-TRD 9 "Go Windows-only": DPAPI wrap/unwrap). LD-93/LD-94: Windows 10/11. User scope is the primary
// path (spike S1: round trip OK as the virtual account and after a service restart); machine scope
// (CRYPTPROTECT_LOCAL_MACHINE) is the documented fallback only, where the file ACL is the only protection.
import (
	"bytes"
	"testing"
)

func scopes() map[string]Scope { return map[string]Scope{"user": ScopeUser, "machine": ScopeMachine} }

func TestDPAPIRoundTrip(t *testing.T) {
	for name, sc := range scopes() {
		t.Run(name, func(t *testing.T) {
			d := NewDPAPI(sc, []byte("agent-id-synthetic"))
			plain := bytes.Repeat([]byte{0x42}, 32)
			blob, err := d.Protect(plain)
			if err != nil {
				t.Fatalf("Protect: %v", err)
			}
			if bytes.Contains(blob, plain) {
				t.Error("blob contains the plaintext")
			}
			got, err := d.Unprotect(blob)
			if err != nil || !bytes.Equal(got, plain) {
				t.Fatalf("Unprotect = %x, %v", got, err)
			}
		})
	}
}

func TestDPAPIEntropyMustMatch(t *testing.T) {
	for name, sc := range scopes() {
		t.Run(name, func(t *testing.T) {
			blob, err := NewDPAPI(sc, []byte("entropy-A")).Protect([]byte("secret"))
			if err != nil {
				t.Fatal(err)
			}
			if got, err := NewDPAPI(sc, []byte("entropy-B")).Unprotect(blob); err == nil {
				t.Errorf("different entropy unwrapped to %q", got)
			}
			if got, err := NewDPAPI(sc, nil).Unprotect(blob); err == nil {
				t.Errorf("missing entropy unwrapped to %q", got)
			}
		})
	}
}

func TestDPAPIBlobTamperAndGarbage(t *testing.T) {
	d := NewDPAPI(ScopeUser, nil)
	blob, err := d.Protect([]byte("secret"))
	if err != nil {
		t.Fatal(err)
	}
	bad := append([]byte(nil), blob...)
	bad[len(bad)-3] ^= 0xff
	if got, err := d.Unprotect(bad); err == nil {
		t.Errorf("tampered blob unwrapped to %q", got)
	}
	for _, g := range [][]byte{nil, {}, []byte("not a dpapi blob")} {
		if got, err := d.Unprotect(g); err == nil {
			t.Errorf("garbage %q unwrapped to %q", g, got)
		}
	}
}

func TestDPAPIHoldsDeviceToken(t *testing.T) {
	dir := t.TempDir()
	d := NewDPAPI(ScopeUser, []byte("agent-id-synthetic")) // REQ-SEC-118: optional entropy = agent id
	if err := SaveToken(dir, testToken, d); err != nil {
		t.Fatal(err)
	}
	got, err := LoadToken(dir, NewDPAPI(ScopeUser, []byte("agent-id-synthetic")))
	if err != nil || got != testToken {
		t.Fatalf("LoadToken = %q %v", got, err)
	}
	if _, err := LoadToken(dir, NewDPAPI(ScopeUser, []byte("another-agent"))); err == nil {
		t.Error("token for agent A must not load with agent B's entropy")
	}
}
