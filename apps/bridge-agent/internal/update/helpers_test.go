package update_test

// AG-T16 test helpers. Contract the writer must implement in package update (names are the tests' contract; the spec names
// only the files, the sequence of 02-TRD 5.11, the states of 03-APP-FLOW 3.6 and AC-15.2..15.4):
//
//	const StateIdle, StateDownloading, StateVerifying, StateStaged, StateApplying, StateRolledBack, StateVerifyFailed, StateFailed
//	      = "idle","downloading","verifying","staged","applying","rolled_back","verify_failed","failed"   // 05-SCHEMA agent_status CHECK
//	const ExitApply = 75                                                  // 02-TRD 5.11: agent exits 75 to ask the launcher to switch
//	type Release struct{ Version, PackageSHA256, Signature, KeyID, AuthenticodePublisher string; PackageSize int64 }
//	type ReleaseKeys map[string]ed25519.PublicKey                         // key_id -> release public key
//	func EmbeddedReleaseKeys() ReleaseKeys                                // EMPTY until the release pipeline provisions keys (fail closed)
//	type Authenticode interface{ Publisher(exePath string) (string, error) } // signer subject CN; error when the signature is not valid
//	func NewAuthenticode() Authenticode                                   // windows: WinVerifyTrustEx WINTRUST_ACTION_GENERIC_VERIFY_V2
//	type Error struct{ State, Reason string }                             // implements error; State is one of the states above
//	type Status struct{ State, TargetVersion, ErrorCode string }          // json: state, target_version, error_code (= heartbeat.UpdateState)
//	func ReadStatus(root string) (Status, error)                          // root\update-state.json, written by Stage and by the launcher
//	func Download(ctx, c *http.Client, rawURL, token, root string, rel Release) (partPath string, err error) // root\versions\<version>.zip.part
//	func Stage(root, partPath string, rel Release, keys ReleaseKeys, av Authenticode) error
//	      // size + SHA-256 + Ed25519 over the raw SHA-256 bytes (key_id in keys) -> unzip to root\versions\<version>\ -> Authenticode of
//	      // agent.exe, signer == rel.AuthenticodePublisher -> pending.json. Keeps the zip as root\versions\<version>.zip. Failure -> *Error
//	      // State verify_failed, status verify_failed, no versions\<version>\ dir, no pending.json. Success -> status staged.
//	type Window struct{ From, To, Timezone string }                       // "HH:MM", "HH:MM", IANA; to < from spans midnight; from inclusive, to exclusive
//	func ReadyToApply(now, lastLinkActivity time.Time, activeSessions int, w *Window) (bool, error) // AC-15.3: idle >= 60 s and in the window
//	type Policy struct{ AllowDowngrade bool; TargetVersion string }       // the applied signed config's update.allow_downgrade / update.target.version
//	type Clock interface{ Now() time.Time; After(d time.Duration) <-chan time.Time }
//	type Proc interface{ Wait() (exitCode int, err error); Kill() error }
//	type LauncherOptions struct{ Root string; Keys ReleaseKeys; Authenticode Authenticode; Policy func() Policy; Clock Clock; Start func(exe string) (Proc, error) }
//	func NewLauncher(o LauncherOptions) (*Launcher, error)
//	func (l *Launcher) Run(ctx context.Context) error                     // supervise root\current.json until ctx is done; kills the child on exit
//	func MarkHealthy(root, version string) error                          // agent: writes root\healthy.json {"version": ...} after its first heartbeat
//
// pending.json = the staged Release as snake_case JSON: version, package_sha256, package_size, signature, key_id, authenticode_publisher
// (see pendingJSON in launcher_helpers_test.go). The launcher trusts none of it: it re-checks zip size/SHA-256/Ed25519 against ITS keys,
// Authenticode of versions\<v>\agent.exe against the publisher, and the version string, then the anti-rollback policy.
// Files in root (the data root): versions\<v>\agent.exe, versions\<v>.zip, current.json {"version","previous"}, pending.json,
// healthy.json, update-state.json. The launcher: deletes healthy.json BEFORE starting a switched-to version; health gate 5 min, or 3 exits
// within 10 min; rollback = restore previous, status rolled_back (target_version = the failed version), never retries that version.
import (
	"archive/zip"
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"lims/apps/bridge-agent/internal/update"
)

const (
	relKeyID = "rel-test-1"
	goodPub  = "LIMS Test Publisher"
	evilPub  = "Evil Corp"
)

// relPair is the SYNTHETIC release key pair (seed = SHA-256(label)); public by construction, never a shipped key.
func relPair(label string) (ed25519.PublicKey, ed25519.PrivateKey) {
	seed := sha256.Sum256([]byte(label))
	priv := ed25519.NewKeyFromSeed(seed[:])
	return priv.Public().(ed25519.PublicKey), priv
}

func agentBytes(version string) []byte { return []byte("MZ synthetic agent.exe " + version) }

type entry struct {
	name string
	data []byte
}

func buildZip(t *testing.T, entries ...entry) []byte {
	t.Helper()
	var b bytes.Buffer
	w := zip.NewWriter(&b)
	for _, e := range entries {
		f, err := w.Create(e.name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := f.Write(e.data); err != nil {
			t.Fatal(err)
		}
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

func signRelease(version string, zipBytes []byte, priv ed25519.PrivateKey, keyID, publisher string) update.Release {
	sum := sha256.Sum256(zipBytes)
	return update.Release{
		Version: version, PackageSHA256: hex.EncodeToString(sum[:]), PackageSize: int64(len(zipBytes)),
		Signature: base64.RawURLEncoding.EncodeToString(ed25519.Sign(priv, sum[:])), KeyID: keyID, AuthenticodePublisher: publisher,
	}
}

// fakeAuth stands in for WinVerifyTrustEx: a file is "signed" only when its exact content was registered.
type fakeAuth struct {
	mu     sync.Mutex
	signed map[string]string // sha256 hex of file content -> signer CN
}

func (f *fakeAuth) trust(content []byte, signer string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.signed == nil {
		f.signed = map[string]string{}
	}
	s := sha256.Sum256(content)
	f.signed[hex.EncodeToString(s[:])] = signer
}

func (f *fakeAuth) Publisher(path string) (string, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	s := sha256.Sum256(b)
	f.mu.Lock()
	defer f.mu.Unlock()
	if p, ok := f.signed[hex.EncodeToString(s[:])]; ok {
		return p, nil
	}
	return "", errors.New("TRUST_E_NOSIGNATURE (fake)")
}

type rig struct {
	t    *testing.T
	root string
	auth *fakeAuth
	keys update.ReleaseKeys
	priv ed25519.PrivateKey
}

func newRig(t *testing.T) *rig {
	t.Helper()
	pub, priv := relPair(relKeyID)
	r := &rig{t: t, root: t.TempDir(), auth: &fakeAuth{}, keys: update.ReleaseKeys{relKeyID: pub}, priv: priv}
	if err := os.MkdirAll(filepath.Join(r.root, "versions"), 0o700); err != nil {
		t.Fatal(err)
	}
	return r
}

func (r *rig) path(parts ...string) string {
	return filepath.Join(append([]string{r.root}, parts...)...)
}

func (r *rig) write(rel string, b []byte) {
	r.t.Helper()
	p := r.path(rel)
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		r.t.Fatal(err)
	}
	if err := os.WriteFile(p, b, 0o600); err != nil {
		r.t.Fatal(err)
	}
}

func (r *rig) read(rel string) []byte {
	r.t.Helper()
	b, err := os.ReadFile(r.path(rel))
	if err != nil {
		r.t.Fatal(err)
	}
	return b
}

func (r *rig) exists(rel string) bool { _, err := os.Stat(r.path(rel)); return err == nil }

// installed lays out an already-running version (as the installer / a previous update would have) and makes it current.
func (r *rig) installed(version string) {
	r.t.Helper()
	r.write(filepath.Join("versions", version, "agent.exe"), agentBytes(version))
	r.auth.trust(agentBytes(version), goodPub)
	r.write("current.json", []byte(`{"version":"`+version+`","previous":""}`))
}

// pkg builds a correctly signed package whose agent.exe the fake Authenticode accepts as goodPub.
func (r *rig) pkg(version string) ([]byte, update.Release) {
	r.t.Helper()
	z := buildZip(r.t, entry{"agent.exe", agentBytes(version)}, entry{"manifest.json", []byte(`{"version":"` + version + `"}`)})
	r.auth.trust(agentBytes(version), goodPub)
	return z, signRelease(version, z, r.priv, relKeyID, goodPub)
}

func (r *rig) part(version string, zipBytes []byte) string {
	r.t.Helper()
	rel := filepath.Join("versions", version+".zip.part")
	r.write(rel, zipBytes)
	return r.path(rel)
}

// stage downloads-and-stages a good package; it must succeed.
func (r *rig) stage(version string) update.Release {
	r.t.Helper()
	z, rel := r.pkg(version)
	if err := update.Stage(r.root, r.part(version, z), rel, r.keys, r.auth); err != nil {
		r.t.Fatalf("Stage(%s) = %v, want nil", version, err)
	}
	return rel
}

func wantVerifyFailed(t *testing.T, err error) {
	t.Helper()
	var ue *update.Error
	if !errors.As(err, &ue) {
		t.Fatalf("want *update.Error State %q, got %T: %v", update.StateVerifyFailed, err, err)
	}
	if ue.State != update.StateVerifyFailed {
		t.Fatalf("State = %q, want %q (%v)", ue.State, update.StateVerifyFailed, err)
	}
}

// notStaged asserts AC-15.2's "not installed": no pending.json, no unpacked dir, status verify_failed.
func (r *rig) notStaged(version string) {
	t := r.t
	t.Helper()
	if r.exists("pending.json") {
		t.Fatal("pending.json exists after a failed verification")
	}
	if r.exists(filepath.Join("versions", version)) {
		t.Fatalf("versions\\%s\\ exists after a failed verification (must be removed)", version)
	}
	st, err := update.ReadStatus(r.root)
	if err != nil {
		t.Fatalf("ReadStatus: %v", err)
	}
	if st.State != update.StateVerifyFailed {
		t.Fatalf("update status = %q, want %q", st.State, update.StateVerifyFailed)
	}
}

func jsonField(t *testing.T, b []byte, key string) string {
	t.Helper()
	m := map[string]any{}
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("not JSON: %v: %s", err, b)
	}
	s, _ := m[key].(string)
	return s
}

func eventually(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(8 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for: %s", what)
}
