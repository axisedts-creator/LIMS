package filedrop_test

// Shared fakes for AG-T14. They also document the API the implementation must provide (package filedrop).
// Spec: 02-TRD 5.14; 01-PRD AC-12.1, AC-12.2, AC-12.5; 07-SECURITY AB14. The Go names are the tests' contract.
//
//	type Config struct {
//	    InstrumentID, Folder string
//	    FilenamePattern      string        // Go RE2 (TRD 5.8, <=200 chars) matched against the base name; "" = match all
//	    AllowedTypes         []string      // subset of {pdf,png,jpg}; nil = all three; unknown value => New error
//	    StableFor            time.Duration // TRD stable_seconds; 0 = 5s
//	    BarcodeRegex         string        // optional; named group "barcode"
//	    MoveAfterCapture     bool
//	    CapturedSubdirectory string        // ^[A-Za-z0-9_-]{1,60}$, one segment inside Folder; "" = "captured"
//	}
//	type SeenRecord struct { InstrumentID, PathSHA256 string; SizeBytes int64; MTime time.Time; FileSHA256, ItemID string }
//	type Store interface {                  // the queue adapter; Capture = item insert + file_drop_seen row in ONE SQLite tx
//	    Seen(instrumentID, pathSHA256 string, size int64, mtime time.Time) (bool, error)
//	    Capture(in queue.ItemInput, rec SeenRecord) error
//	}
//	type Options struct {
//	    Config Config; Store Store
//	    Now func() time.Time; NewID func() string   // defaults time.Now, UUIDv7
//	    PollInterval time.Duration                  // 0 = DefaultPollInterval
//	    Log func(code string)                       // codes only; never file names, barcodes or bytes
//	}
//	const DefaultPollInterval = 5 * time.Second
//	const MaxFileBytes = 15 << 20
//	func New(Options) (*Watcher, error)     // error: empty InstrumentID/Folder/Store, bad regex (filename or barcode), unknown AllowedTypes, unsafe CapturedSubdirectory
//	func (*Watcher) Scan(ctx) error         // ONE poll pass; stability is judged across Scan calls using Now
//	func (*Watcher) Run(ctx) error          // Scan every PollInterval until ctx is done; returns nil on cancel
//
// Items handed to Store.Capture: Kind "attachment", Protocol "file_drop", Raw = the file bytes,
// Meta = JSON {"file_name","mtime"(UTC, 2006-01-02T15:04:05.000Z),"size","barcode"?}; barcode key absent when no match.
// PathSHA256 = lower-hex SHA-256 of the cleaned absolute file path.

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"lims/apps/bridge-agent/internal/filedrop"
	"lims/apps/bridge-agent/internal/queue"
)

const instID = "0196a3c0-0000-7000-8000-0000000000aa"

var t0 = time.Date(2026, 11, 11, 8, 30, 0, 0, time.UTC)

type clock struct{ t time.Time }

func (c *clock) Now() time.Time          { return c.t }
func (c *clock) Advance(d time.Duration) { c.t = c.t.Add(d) }

type fakeStore struct {
	mu       sync.Mutex
	items    []queue.ItemInput
	recs     []filedrop.SeenRecord
	failNext error
	seenErr  error
}

func (s *fakeStore) Seen(inst, ph string, size int64, mtime time.Time) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.seenErr != nil {
		return false, s.seenErr
	}
	for _, r := range s.recs {
		if r.InstrumentID == inst && r.PathSHA256 == ph && r.SizeBytes == size && r.MTime.Equal(mtime) {
			return true, nil
		}
	}
	return false, nil
}

func (s *fakeStore) Capture(in queue.ItemInput, rec filedrop.SeenRecord) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.failNext != nil {
		err := s.failNext
		s.failNext = nil
		return err
	}
	s.items = append(s.items, in)
	s.recs = append(s.recs, rec)
	return nil
}

func (s *fakeStore) count() int { s.mu.Lock(); defer s.mu.Unlock(); return len(s.items) }

type logs struct {
	mu    sync.Mutex
	codes []string
}

func (l *logs) Log(c string) { l.mu.Lock(); l.codes = append(l.codes, c); l.mu.Unlock() }

type rig struct {
	t     *testing.T
	dir   string
	clk   *clock
	store *fakeStore
	log   *logs
	w     *filedrop.Watcher
	seq   int
}

func newRig(t *testing.T, mut func(*filedrop.Config)) *rig {
	t.Helper()
	r := &rig{t: t, dir: t.TempDir(), clk: &clock{t: t0}, store: &fakeStore{}, log: &logs{}}
	cfg := filedrop.Config{InstrumentID: instID, Folder: r.dir}
	if mut != nil {
		mut(&cfg)
	}
	r.w = r.build(cfg, r.store)
	return r
}

func (r *rig) build(cfg filedrop.Config, st filedrop.Store) *filedrop.Watcher {
	r.t.Helper()
	w, err := filedrop.New(filedrop.Options{Config: cfg, Store: st, Now: r.clk.Now, Log: r.log.Log,
		NewID: func() string { r.seq++; return fmt.Sprintf("0196a3c0-0000-7000-8000-%012d", r.seq) }})
	if err != nil {
		r.t.Fatalf("New: %v", err)
	}
	return w
}

func (r *rig) write(name string, data []byte) string {
	r.t.Helper()
	p := filepath.Join(r.dir, name)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		r.t.Fatal(err)
	}
	if err := os.WriteFile(p, data, 0o644); err != nil {
		r.t.Fatal(err)
	}
	return p
}

func (r *rig) scan() {
	r.t.Helper()
	if err := r.w.Scan(t0Ctx()); err != nil {
		r.t.Fatalf("Scan: %v", err)
	}
}

// settle: first scan observes, then 5 s pass with no change, second scan may capture.
func (r *rig) settle() {
	r.t.Helper()
	r.scan()
	r.clk.Advance(5 * time.Second)
	r.scan()
}

func sum(b []byte) string { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) }

func pathSHA(p string) string {
	abs, _ := filepath.Abs(p)
	return sum([]byte(filepath.Clean(abs)))
}

func metaOf(t *testing.T, in queue.ItemInput) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(in.Meta, &m); err != nil {
		t.Fatalf("meta is not JSON: %v", err)
	}
	return m
}

var errBoom = errors.New("boom")

func cfgMove(r *rig) filedrop.Config {
	return filedrop.Config{InstrumentID: instID, Folder: r.dir, MoveAfterCapture: true, CapturedSubdirectory: "captured"}
}
