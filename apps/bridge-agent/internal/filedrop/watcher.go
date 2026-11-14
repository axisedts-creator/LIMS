// Package filedrop is the poll-based file-drop watcher (02-TRD 5.14, AC-12.1/12.2/12.5, AB14).
package filedrop

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"lims/apps/bridge-agent/internal/queue"
)

const (
	DefaultPollInterval = 5 * time.Second
	MaxFileBytes        = 15 << 20
	defaultStableFor    = 5 * time.Second
	tsFormat            = "2006-01-02T15:04:05.000Z"
)

// AC-12.1: only these extensions are captured (compared case-insensitively).
var allowedExt = map[string]bool{".pdf": true, ".png": true, ".jpg": true}

type Config struct {
	InstrumentID, Folder string
	FilenamePattern      string        // Go RE2 (TRD 5.8, <=200 chars) on the base name; "" = match all
	AllowedTypes         []string      // subset of {pdf,png,jpg}; nil = all three
	StableFor            time.Duration // TRD stable_seconds; <=0 = 5s
	BarcodeRegex         string        // optional; must contain the named group "barcode"
	MoveAfterCapture     bool
	CapturedSubdirectory string // ^[A-Za-z0-9_-]{1,60}$, one segment inside Folder; "" = "captured"
}

var subdirRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,60}$`)

type SeenRecord struct {
	InstrumentID, PathSHA256 string
	SizeBytes                int64
	MTime                    time.Time
	FileSHA256, ItemID       string
}

// Store is the queue adapter: Capture must insert the item and the file_drop_seen row in ONE SQLite tx.
type Store interface {
	Seen(instrumentID, pathSHA256 string, size int64, mtime time.Time) (bool, error)
	Capture(in queue.ItemInput, rec SeenRecord) error
}

type Options struct {
	Config       Config
	Store        Store
	Now          func() time.Time
	NewID        func() string
	PollInterval time.Duration
	Log          func(code string) // codes only; never file names, barcodes or bytes
}

type obs struct {
	size  int64
	mtime time.Time
	since time.Time // first scan that saw this size+mtime
	done  bool      // captured (or already in file_drop_seen); do not look again until it changes
}

type Watcher struct {
	cfg     Config
	folder  string // absolute, cleaned
	nameRe  *regexp.Regexp // nil = match all
	exts    map[string]bool
	stable  time.Duration
	poll    time.Duration
	barcode *regexp.Regexp
	barIdx  int
	st      Store
	now     func() time.Time
	newID   func() string
	log     func(string)

	mu  sync.Mutex
	obs map[string]*obs
}

func New(o Options) (*Watcher, error) {
	c := o.Config
	switch {
	case c.InstrumentID == "":
		return nil, errors.New("filedrop: empty InstrumentID")
	case c.Folder == "":
		return nil, errors.New("filedrop: empty Folder")
	case o.Store == nil:
		return nil, errors.New("filedrop: nil Store")
	}
	folder, err := filepath.Abs(c.Folder)
	if err != nil {
		return nil, fmt.Errorf("filedrop: folder: %w", err)
	}
	w := &Watcher{cfg: c, folder: folder, st: o.Store, now: o.Now, newID: o.NewID, log: o.Log,
		stable: c.StableFor, poll: o.PollInterval, obs: map[string]*obs{}}
	if w.now == nil {
		w.now = time.Now
	}
	if w.newID == nil {
		w.newID = func() string { return newUUIDv7(w.now()) }
	}
	if w.log == nil {
		w.log = func(string) {}
	}
	if w.stable <= 0 {
		w.stable = defaultStableFor
	}
	if w.poll <= 0 {
		w.poll = DefaultPollInterval
	}
	if c.FilenamePattern != "" {
		if len(c.FilenamePattern) > 200 {
			return nil, errors.New("filedrop: filename pattern longer than 200 chars")
		}
		if w.nameRe, err = regexp.Compile(c.FilenamePattern); err != nil {
			return nil, fmt.Errorf("filedrop: filename pattern: %w", err)
		}
	}
	w.exts = allowedExt
	if len(c.AllowedTypes) > 0 {
		w.exts = map[string]bool{}
		for _, t := range c.AllowedTypes {
			if !allowedExt["."+t] {
				return nil, errors.New("filedrop: unknown allowed type")
			}
			w.exts["."+t] = true
		}
	}
	if c.BarcodeRegex != "" {
		if w.barcode, err = regexp.Compile(c.BarcodeRegex); err != nil {
			return nil, fmt.Errorf("filedrop: barcode regex: %w", err)
		}
		if w.barIdx = w.barcode.SubexpIndex("barcode"); w.barIdx < 0 {
			return nil, errors.New(`filedrop: barcode regex needs a named group "barcode"`)
		}
	}
	if w.cfg.CapturedSubdirectory == "" {
		w.cfg.CapturedSubdirectory = "captured" // TRD 5.8 default
	}
	// AB14: the spec pattern admits no separators, dots, colons or spaces, so no traversal or device tricks.
	if !subdirRe.MatchString(w.cfg.CapturedSubdirectory) {
		return nil, errors.New("filedrop: unsafe CapturedSubdirectory")
	}
	return w, nil
}

// Run scans every PollInterval until ctx is done; per-pass errors are already logged as codes.
func (w *Watcher) Run(ctx context.Context) error {
	t := time.NewTicker(w.poll)
	defer t.Stop()
	for {
		_ = w.Scan(ctx)
		select {
		case <-ctx.Done():
			return nil
		case <-t.C:
		}
	}
}

// Scan is ONE poll pass over the top level of the folder (no recursion). Stability is judged across calls.
func (w *Watcher) Scan(ctx context.Context) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	ents, err := os.ReadDir(w.cfg.Folder)
	if err != nil {
		w.log("folder_unreadable")
		return fmt.Errorf("filedrop: read folder: %w", err)
	}
	now := w.now()
	present := make(map[string]bool, len(ents))
	for _, e := range ents {
		if ctx.Err() != nil {
			return nil
		}
		// Regular files only: directories, symlinks, junctions (irregular) are never followed.
		if !e.Type().IsRegular() || !w.wanted(e.Name()) {
			continue
		}
		present[e.Name()] = true
		w.visit(e.Name(), now)
	}
	for n := range w.obs {
		if !present[n] {
			delete(w.obs, n)
		}
	}
	return nil
}

func (w *Watcher) wanted(name string) bool {
	return w.exts[strings.ToLower(filepath.Ext(name))] && (w.nameRe == nil || w.nameRe.MatchString(name))
}

func (w *Watcher) visit(name string, now time.Time) {
	path := filepath.Join(w.folder, name)
	fi, err := os.Lstat(path)
	if err != nil || !fi.Mode().IsRegular() || fi.Size() == 0 || fi.Size() > MaxFileBytes {
		return
	}
	o := w.obs[name]
	if o == nil || o.size != fi.Size() || !o.mtime.Equal(fi.ModTime()) {
		w.obs[name] = &obs{size: fi.Size(), mtime: fi.ModTime(), since: now}
		return
	}
	if o.done || now.Sub(o.since) < w.stable {
		return
	}
	w.capture(name, path, fi, o)
}

func (w *Watcher) capture(name, path string, fi os.FileInfo, o *obs) {
	sum := sha256.Sum256([]byte(filepath.Clean(path)))
	pathSHA := hex.EncodeToString(sum[:])
	mtime := fi.ModTime().UTC().Truncate(time.Millisecond) // matches the TEXT form stored in file_drop_seen
	seen, err := w.st.Seen(w.cfg.InstrumentID, pathSHA, fi.Size(), mtime)
	if err != nil {
		w.log("seen_failed")
		return
	}
	if seen {
		o.done = true
		return
	}
	raw, err := readStable(path, fi)
	if err != nil { // still locked by the instrument, or changed under us: retry next poll
		w.log("read_failed")
		return
	}
	fileSum := sha256.Sum256(raw)
	meta := struct {
		FileName string `json:"file_name"`
		MTime    string `json:"mtime"`
		Size     int64  `json:"size"`
		Barcode  string `json:"barcode,omitempty"`
	}{FileName: name, MTime: mtime.Format(tsFormat), Size: fi.Size()}
	if w.barcode != nil {
		if m := w.barcode.FindStringSubmatch(name); m != nil {
			meta.Barcode = m[w.barIdx]
		}
	}
	metaJSON, _ := json.Marshal(meta)
	in := queue.ItemInput{ID: w.newID(), InstrumentID: w.cfg.InstrumentID, Kind: "attachment", Protocol: "file_drop",
		Raw: raw, Meta: metaJSON, CapturedAtAgent: w.now().UTC().Format(tsFormat)}
	rec := SeenRecord{InstrumentID: w.cfg.InstrumentID, PathSHA256: pathSHA, SizeBytes: fi.Size(), MTime: mtime,
		FileSHA256: hex.EncodeToString(fileSum[:]), ItemID: in.ID}
	if err := w.st.Capture(in, rec); err != nil {
		w.log("capture_failed")
		return
	}
	o.done = true
	if w.cfg.MoveAfterCapture {
		w.move(name, path) // only after the commit; failure cannot cause a re-capture (seen row exists)
	}
}

// readStable reads the file and proves it is the same regular file and unchanged since observed.
func readStable(path string, want os.FileInfo) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	got, err := f.Stat()
	if err != nil {
		return nil, err
	}
	// ponytail: Lstat→Open is not atomic; SameFile narrows the symlink-swap window, a handle-based open would close it.
	if !got.Mode().IsRegular() || !os.SameFile(want, got) || got.Size() != want.Size() || !got.ModTime().Equal(want.ModTime()) {
		return nil, errors.New("changed")
	}
	b, err := io.ReadAll(io.LimitReader(f, want.Size()+1))
	if err != nil {
		return nil, err
	}
	if int64(len(b)) != want.Size() {
		return nil, errors.New("changed")
	}
	return b, nil
}

// move renames into the captured subdirectory and never overwrites: the destination name is reserved with O_EXCL first
// (os.Rename replaces an existing file on Windows).
func (w *Watcher) move(name, src string) {
	dir := filepath.Join(w.folder, w.cfg.CapturedSubdirectory)
	if err := os.Mkdir(dir, 0o755); err != nil && !os.IsExist(err) {
		w.log("move_failed")
		return
	}
	if fi, err := os.Lstat(dir); err != nil || fi.Mode()&(os.ModeDir|os.ModeSymlink|os.ModeIrregular) != os.ModeDir {
		w.log("move_failed") // not a real directory (link/junction): refuse
		return
	}
	ext := filepath.Ext(name)
	base := strings.TrimSuffix(name, ext)
	for i := 0; i < 100; i++ {
		dst := filepath.Join(dir, name)
		if i > 0 {
			dst = filepath.Join(dir, fmt.Sprintf("%s-%d%s", base, i, ext))
		}
		f, err := os.OpenFile(dst, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
		if os.IsExist(err) {
			continue
		}
		if err != nil {
			w.log("move_failed")
			return
		}
		_ = f.Close()
		if err := os.Rename(src, dst); err != nil {
			_ = os.Remove(dst) // our own empty placeholder
			w.log("move_failed")
		}
		return
	}
	w.log("move_failed")
}

// newUUIDv7 is RFC 9562 UUIDv7 (copy: the uploader's and hostquery's helpers are unexported in packages this task does not own).
func newUUIDv7(t time.Time) string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	ms := uint64(t.UnixMilli())
	for i := 0; i < 6; i++ {
		b[i] = byte(ms >> (40 - 8*i))
	}
	b[6] = b[6]&0x0f | 0x70
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}
