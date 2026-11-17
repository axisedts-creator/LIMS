package queue

// AG-T04 test helpers. Spec: 02-TRD 5.6 (queue), D-02, D-07; 07-SECURITY REQ-SEC-117; AC-05.2, AC-05.7, AC-08.4.
// LD-93/LD-94 (2026-11-11): Windows 10 and 11 are the supported OS set; no Server 2016 case here.
// Windows-only DPAPI behaviour is tested in dpapi_windows_test.go (and in internal/secrets).
//
// Contract the writer must implement in package queue. Spec names only the files and the TRD 5.6 schema;
// the Go names below are the tests' contract. All agent timestamps are UTC strings in the form
// "2006-01-02T15:04:05.000Z" (RFC 3339, millisecond) so they compare in order as text and parse with time.RFC3339Nano.
//
//	type KeyProtector interface {                       // satisfied by secrets.DPAPI
//	    Protect(plain []byte) ([]byte, error)
//	    Unprotect(blob []byte) ([]byte, error)
//	}
//	type Options struct {
//	    MinFreeBytes int64                                // 0 = 500 MB (TRD 5.6); disk is low when free < MinFreeBytes
//	    FreeBytes    func(dir string) (int64, error)      // nil = real free space of dir; called with filepath.Dir(path)
//	}
//	var ErrNotFound, ErrTampered error                    // ErrTampered: AES-GCM open failed (wrong key, wrong AAD, bad tag/nonce)
//	func Open(path string, p KeyProtector, o Options) (*DB, error)   // parent dir exists; creates file, schema, data key
//	func (d *DB) Close() error
//	func (d *DB) Pragma(name string) (string, error)    // value of PRAGMA name on the live connection
//	func (d *DB) DiskLow() (bool, error)
//	type Session struct { ID, InstrumentID, Protocol, StartedAtAgent, LastFrameAtAgent string; ExpectedFN, Frames int }
//	func (d *DB) BeginSession(s Session) error
//	func (d *DB) AppendChunk(sessionID string, seq, expectedFN int, text []byte, lastFrameAt string) error // ONE committed tx: chunk + frames+1 + expected_fn + last_frame_at_agent
//	func (d *DB) GetSession(id string) (Session, error)
//	func (d *DB) OpenSessions() ([]Session, error)       // sessions not yet finalised/deleted
//	func (d *DB) Chunks(sessionID string) ([][]byte, error) // decrypted, ordered by seq
//	func (d *DB) DeleteSession(sessionID string) error   // chunks cascade
//	type ItemInput struct { ID, InstrumentID, Kind, Protocol string; Raw, Meta []byte; CapturedAtAgent string; ClockOffsetMs int64 }
//	type Item struct { ItemInput; RawSHA256 string; SizeBytes int64; State string; Attempts int; UploadedAt, ServerMessageID string }
//	func (d *DB) InsertItem(in ItemInput) error          // state 'pending'; sha256 hex lower + size computed here
//	func (d *DB) FinalizeSession(sessionID string, in ItemInput) (Item, error) // ONE tx: Raw = decrypted chunks joined by seq (in.Raw ignored); insert item; delete chunks + session
//	func (d *DB) GetItem(id string) (Item, error)        // decrypts Raw and Meta
//	func (d *DB) MarkUploaded(id, serverMessageID string, at time.Time) error
//	func (d *DB) SetItemState(id, state string) error
//	func (d *DB) CountByState() (map[string]int, error)
//	type TruncateResult struct{ ItemsDeleted, OutboundDeleted int }
//	func (d *DB) Truncate(now time.Time, retention time.Duration) (TruncateResult, error) // retention clamped to [1h, 72h]
import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"testing"

	_ "modernc.org/sqlite"
)

const tsLayout = "2006-01-02T15:04:05.000Z"

// testProtector is a reversible fake for DPAPI: AES-256-GCM under a fixed key (so a re-exec'd child can use it too).
type testProtector struct {
	lastPlain      []byte
	protectCalls   int
	unprotectCalls int
}

var testProtectorKey = bytes.Repeat([]byte{0x5a}, 32)

func (p *testProtector) Protect(plain []byte) ([]byte, error) {
	p.protectCalls++
	p.lastPlain = append([]byte(nil), plain...)
	return sealFixed(plain), nil
}

func (p *testProtector) Unprotect(blob []byte) ([]byte, error) {
	p.unprotectCalls++
	b, _ := aes.NewCipher(testProtectorKey)
	g, _ := cipher.NewGCM(b)
	if len(blob) < g.NonceSize() {
		return nil, errors.New("blob too short")
	}
	return g.Open(nil, blob[:g.NonceSize()], blob[g.NonceSize():], nil)
}

func sealFixed(plain []byte) []byte {
	b, _ := aes.NewCipher(testProtectorKey)
	g, _ := cipher.NewGCM(b)
	n := make([]byte, g.NonceSize())
	_, _ = rand.Read(n)
	return append(n, g.Seal(nil, n, plain, nil)...)
}

// funcProtector lets a test choose Unprotect's behaviour (wrong key, error, wrong length).
type funcProtector struct {
	protect   func([]byte) ([]byte, error)
	unprotect func([]byte) ([]byte, error)
}

func (f funcProtector) Protect(p []byte) ([]byte, error)   { return f.protect(p) }
func (f funcProtector) Unprotect(b []byte) ([]byte, error) { return f.unprotect(b) }

func dbPath(t *testing.T) string {
	t.Helper()
	return filepath.Join(t.TempDir(), "agent.db")
}

func openT(t *testing.T, path string, p KeyProtector, o Options) *DB {
	t.Helper()
	d, err := Open(path, p, o)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { _ = d.Close() })
	return d
}

// openNew opens a fresh queue with the fake protector and a roomy fake disk.
func openNew(t *testing.T) (*DB, string, *testProtector) {
	t.Helper()
	path := dbPath(t)
	p := &testProtector{}
	return openT(t, path, p, Options{FreeBytes: func(string) (int64, error) { return 100 << 30, nil }}), path, p
}

// rawDB opens a second connection to the same file, for tampering and for reading stored bytes.
func rawDB(t *testing.T, path string) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatalf("raw open: %v", err)
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec("PRAGMA busy_timeout=5000"); err != nil {
		t.Fatalf("raw busy_timeout: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

func rawExec(t *testing.T, path, q string, args ...any) {
	t.Helper()
	if _, err := rawDB(t, path).Exec(q, args...); err != nil {
		t.Fatalf("raw exec %q: %v", q, err)
	}
}

func rawBlob(t *testing.T, path, q string, args ...any) []byte {
	t.Helper()
	var b []byte
	if err := rawDB(t, path).QueryRow(q, args...).Scan(&b); err != nil {
		t.Fatalf("raw query %q: %v", q, err)
	}
	return b
}

func checkpoint(t *testing.T, path string) {
	t.Helper()
	if _, err := rawDB(t, path).Exec("PRAGMA wal_checkpoint(TRUNCATE)"); err != nil {
		t.Fatalf("checkpoint: %v", err)
	}
}

// diskBytes returns the main db file plus any -wal file content.
func diskBytes(t *testing.T, path string) []byte {
	t.Helper()
	out, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read db: %v", err)
	}
	if w, err := os.ReadFile(path + "-wal"); err == nil {
		out = append(out, w...)
	}
	return out
}

func in(id, kind string, raw []byte) ItemInput {
	return ItemInput{
		ID: id, InstrumentID: "inst-1", Kind: kind, Protocol: "astm",
		Raw: raw, Meta: []byte(`{"link_meta":{"frames":3}}`),
		CapturedAtAgent: "2026-11-11T08:00:00.000Z", ClockOffsetMs: -120,
	}
}
