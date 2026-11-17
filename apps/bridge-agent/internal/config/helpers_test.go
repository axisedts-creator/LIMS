package config

// AG-T11 test helpers. Fixtures: the shared golden vector (02-TRD 5.10, API-T08).
// LD-73 (2026-11-08): the golden key pair is the SYNTHETIC pair derived from SHA-256("cfg-test-1");
// it is public by construction, so it must never be a trusted key in a shipped build (see keys_test.go).
//
// Contract the writer must implement (names are the tests' contract; spec names only the files and AC-15.1 states):
//
//	type Envelope struct{ Alg, KeyID, Signature string; Document json.RawMessage }   // json: alg,key_id,signature,document
//	type TrustedKeys map[string]ed25519.PublicKey                                    // key_id -> public key
//	type Error struct{ State, Reason string }                                        // implements error
//	type Document struct{ KeyID, AgentID, CanonicalSHA256 string; ConfigVersion int64; Raw json.RawMessage }
//	type Outcome struct{ State string; ConfigVersion int64; Applied, NoOp bool }
//	type Report struct{ ConfigVersionApplied int64 `json:"config_version_applied"`; ConfigState string `json:"config_state"` }
//	const StateOK, StateSignatureInvalid, StateAgentMismatch, StateRollbackRejected, StateSchemaInvalid
//	func Canonicalize(raw []byte) ([]byte, error)
//	func CanonicalSHA256(raw []byte) (string, error)
//	func Verify(envelope []byte, keys TrustedKeys, agentID string) (*Document, error)  // never checks config_version
//	func NewApplier(dir string, keys TrustedKeys, agentID string) (*Applier, error)
//	func (a *Applier) Apply(envelope []byte) (Outcome, error)
//	func (a *Applier) Report() Report
//	func (a *Applier) Current() (json.RawMessage, bool)
//	func EmbeddedKeys() TrustedKeys
import (
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const (
	testKeyID    = "cfg-test-1"
	testAgentID  = "01a1a98a-ac40-7000-8000-0000000d0101"
	otherAgentID = "01a1a98a-ac40-7000-8000-0000000d0102"
)

// fixtureDir prefers the Go copy (apps/bridge-agent/testdata/config, byte-identical per c7-fixture-copy-check)
// and falls back to the API fixtures, which are the source of truth until the copy exists.
func fixtureDir(t *testing.T) string {
	t.Helper()
	for _, d := range []string{
		filepath.Join("..", "..", "testdata", "config"),
		filepath.Join("..", "..", "..", "..", "services", "api", "src", "modules", "instruments", "__tests__", "fixtures", "config"),
	} {
		if _, err := os.Stat(filepath.Join(d, "canonical.vector.json")); err == nil {
			return d
		}
	}
	t.Fatal("golden fixtures not found (services/api/src/modules/instruments/__tests__/fixtures/config)")
	return ""
}

func fixture(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(fixtureDir(t), name))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func pemBlock(t *testing.T, name string) []byte {
	t.Helper()
	blk, _ := pem.Decode(fixture(t, name))
	if blk == nil {
		t.Fatalf("%s: not PEM", name)
	}
	return blk.Bytes
}

func goldenPriv(t *testing.T) ed25519.PrivateKey {
	t.Helper()
	k, err := x509.ParsePKCS8PrivateKey(pemBlock(t, "test-key.pkcs8.pem"))
	if err != nil {
		t.Fatal(err)
	}
	return k.(ed25519.PrivateKey)
}

func goldenPub(t *testing.T) ed25519.PublicKey {
	t.Helper()
	k, err := x509.ParsePKIXPublicKey(pemBlock(t, "test-key.spki.pem"))
	if err != nil {
		t.Fatal(err)
	}
	return k.(ed25519.PublicKey)
}

func newKey(t *testing.T, label string) (ed25519.PublicKey, ed25519.PrivateKey) {
	t.Helper()
	seed := sha256.Sum256([]byte(label)) // synthetic, deterministic
	priv := ed25519.NewKeyFromSeed(seed[:])
	return priv.Public().(ed25519.PublicKey), priv
}

func trusted(t *testing.T) TrustedKeys { return TrustedKeys{testKeyID: goldenPub(t)} }

// docJSON returns a document already in canonical form (keys sorted, no whitespace), so tests can sign it
// without using the code under test.
func docJSON(agent string, version int, code string) string {
	return fmt.Sprintf(`{"agent_id":%q,"config_version":%d,"instruments":[{"instrument_code":%q}],`+
		`"issued_at":"2026-11-06T04:00:00.000Z","schema":"lims.bridge.config.v1","tls":{"spki_pins_sha256":[]},`+
		`"update":{"allow_downgrade":false,"channel":"stable","target":null,"window":null}}`, agent, version, code)
}

func b64(sig []byte) string { return base64.RawURLEncoding.EncodeToString(sig) }

func b64d(s string) ([]byte, error) { return base64.RawURLEncoding.DecodeString(s) }

// envelopeRaw builds a wire envelope with an explicit alg/key_id/signature and a verbatim document.
func envelopeRaw(alg, keyID, sig, doc string) []byte {
	return []byte(fmt.Sprintf(`{"alg":%q,"key_id":%q,"signature":%q,"document":%s}`, alg, keyID, sig, doc))
}

func signedSig(priv ed25519.PrivateKey, canonicalDoc string) []byte {
	return ed25519.Sign(priv, []byte(canonicalDoc))
}

// signed signs canonicalDoc (must already be canonical) with priv.
func signed(priv ed25519.PrivateKey, keyID, canonicalDoc string) []byte {
	return envelopeRaw("Ed25519", keyID, b64(signedSig(priv, canonicalDoc)), canonicalDoc)
}

func goldenEnvelope(t *testing.T) []byte {
	t.Helper()
	sig := strings.TrimSpace(string(fixture(t, "signature.b64url.txt")))
	return envelopeRaw("Ed25519", testKeyID, sig, string(fixture(t, "canonical.vector.json")))
}

func wantState(t *testing.T, err error, state string) {
	t.Helper()
	var ce *Error
	if !errors.As(err, &ce) {
		t.Fatalf("want *config.Error with State %q, got %T: %v", state, err, err)
	}
	if ce.State != state {
		t.Fatalf("State = %q, want %q (%v)", ce.State, state, err)
	}
}

func isRejectState(s string) bool {
	switch s {
	case StateSignatureInvalid, StateAgentMismatch, StateRollbackRejected, StateSchemaInvalid:
		return true
	}
	return false
}

// snapshot returns every file under dir (relative path -> bytes), to prove a rejection changes nothing on disk.
func snapshot(t *testing.T, dir string) map[string]string {
	t.Helper()
	out := map[string]string{}
	err := filepath.Walk(dir, func(p string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return err
		}
		b, rerr := os.ReadFile(p)
		if rerr != nil {
			return rerr
		}
		rel, _ := filepath.Rel(dir, p)
		out[rel] = string(b)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func sameSnapshot(t *testing.T, a, b map[string]string) {
	t.Helper()
	if len(a) != len(b) {
		t.Fatalf("config dir changed: %d files before, %d after", len(a), len(b))
	}
	for k, v := range a {
		if w, ok := b[k]; !ok || w != v {
			t.Fatalf("config dir file %q changed by a rejected config", k)
		}
	}
}
