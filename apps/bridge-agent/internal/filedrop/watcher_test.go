package filedrop_test

// AG-T14 unit tests: stability (AC-12.1), barcode (AC-12.2), dedupe + move option (AC-12.5), path safety (AB14).

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"lims/apps/bridge-agent/internal/filedrop"
)

func t0Ctx() context.Context { return context.Background() }

var pdf = append([]byte("%PDF-1.4\n"), bytes.Repeat([]byte("x"), 2048)...)

func TestConstants(t *testing.T) {
	if filedrop.DefaultPollInterval != 5*time.Second {
		t.Fatalf("poll interval = %v, want 5s (TRD 5.14)", filedrop.DefaultPollInterval)
	}
	if filedrop.MaxFileBytes != 15<<20 {
		t.Fatalf("MaxFileBytes = %d, want 15 MiB", filedrop.MaxFileBytes)
	}
}

func TestNewValidates(t *testing.T) {
	st := &fakeStore{}
	dir := t.TempDir()
	cases := map[string]filedrop.Options{
		"no instrument": {Config: filedrop.Config{Folder: dir}, Store: st},
		"no folder":     {Config: filedrop.Config{InstrumentID: instID}, Store: st},
		"no store":      {Config: filedrop.Config{InstrumentID: instID, Folder: dir}},
		"bad regex":     {Config: filedrop.Config{InstrumentID: instID, Folder: dir, BarcodeRegex: "(["}, Store: st},
		"bad filename regex":  {Config: filedrop.Config{InstrumentID: instID, Folder: dir, FilenamePattern: "(["}, Store: st},
		"unknown type":        {Config: filedrop.Config{InstrumentID: instID, Folder: dir, AllowedTypes: []string{"pdf", "exe"}}, Store: st},
	}
	for name, o := range cases {
		if _, err := filedrop.New(o); err == nil {
			t.Errorf("%s: New must fail", name)
		}
	}
}

// AC-12.1: stored only once size+mtime are unchanged for 5 s.
func TestStableFileCapturedAfterFiveSeconds(t *testing.T) {
	r := newRig(t, nil)
	p := r.write("E2600000042.pdf", pdf)
	r.scan()
	if r.store.count() != 0 {
		t.Fatal("captured on first sight; must wait for stability")
	}
	r.clk.Advance(4900 * time.Millisecond)
	r.scan()
	if r.store.count() != 0 {
		t.Fatal("captured before 5 s of stability")
	}
	r.clk.Advance(200 * time.Millisecond)
	r.scan()
	if r.store.count() != 1 {
		t.Fatalf("captured %d items after 5.1 s stable, want 1", r.store.count())
	}
	in, rec := r.store.items[0], r.store.recs[0]
	if in.Kind != "attachment" || in.Protocol != "file_drop" || in.InstrumentID != instID {
		t.Fatalf("item = kind %q protocol %q instrument %q", in.Kind, in.Protocol, in.InstrumentID)
	}
	if !bytes.Equal(in.Raw, pdf) {
		t.Fatal("Raw differs from file bytes")
	}
	m := metaOf(t, in)
	if m["file_name"] != "E2600000042.pdf" || int(m["size"].(float64)) != len(pdf) {
		t.Fatalf("meta = %v", m)
	}
	if _, ok := m["mtime"].(string); !ok {
		t.Fatalf("meta has no mtime: %v", m)
	}
	if rec.FileSHA256 != sum(pdf) || rec.ItemID != in.ID || rec.PathSHA256 != pathSHA(p) || rec.SizeBytes != int64(len(pdf)) || rec.InstrumentID != instID {
		t.Fatalf("seen record = %+v", rec)
	}
	if _, err := os.Stat(p); err != nil {
		t.Fatal("file was removed although move_after_capture is false (AC-12.5)")
	}
}

func TestGrowingFileRestartsStability(t *testing.T) {
	r := newRig(t, nil)
	p := r.write("run.pdf", pdf)
	r.scan()
	r.clk.Advance(4 * time.Second)
	if err := os.WriteFile(p, append(pdf, 'y'), 0o644); err != nil { // size change
		t.Fatal(err)
	}
	r.scan()
	r.clk.Advance(4 * time.Second) // 8 s since first sight, 4 s since the change
	r.scan()
	if r.store.count() != 0 {
		t.Fatal("captured while the file changed within the last 5 s")
	}
	r.clk.Advance(2 * time.Second)
	r.scan()
	if r.store.count() != 1 || len(r.store.items[0].Raw) != len(pdf)+1 {
		t.Fatalf("want one capture of the final bytes, got %d", r.store.count())
	}
}

func TestMtimeOnlyChangeRestartsStability(t *testing.T) {
	r := newRig(t, nil)
	p := r.write("run.pdf", pdf)
	r.scan()
	r.clk.Advance(4 * time.Second)
	if err := os.Chtimes(p, t0.Add(time.Hour), t0.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	r.scan()
	r.clk.Advance(4 * time.Second)
	r.scan()
	if r.store.count() != 0 {
		t.Fatal("mtime change must restart the stability window")
	}
}

func TestConfiguredStableFor(t *testing.T) {
	r := newRig(t, func(c *filedrop.Config) { c.StableFor = 20 * time.Second })
	r.write("a.pdf", pdf)
	r.settle() // only 5 s
	if r.store.count() != 0 {
		t.Fatal("stable_seconds = 20 ignored")
	}
	r.clk.Advance(15 * time.Second)
	r.scan()
	if r.store.count() != 1 {
		t.Fatal("not captured after 20 s")
	}
}

func TestFilterExtensionPatternAndSize(t *testing.T) {
	r := newRig(t, func(c *filedrop.Config) { c.FilenamePattern = `^scan-\d+\.[A-Za-z]+$` })
	for _, n := range []string{"scan-1.pdf", "scan-2.PNG", "scan-3.jpg"} {
		r.write(n, []byte("data-"+n))
	}
	for _, n := range []string{"scan-4.txt", "scan-5.exe", "scan-6.pdf.lnk", "other-7.pdf", "scan-8"} {
		r.write(n, []byte("nope"))
	}
	big := r.write("scan-9.pdf", nil)
	if err := os.Truncate(big, 16<<20); err != nil { // sparse; > 15 MB
		t.Fatal(err)
	}
	r.settle()
	got := map[string]bool{}
	for _, in := range r.store.items {
		got[metaOf(t, in)["file_name"].(string)] = true
	}
	if len(got) != 3 || !got["scan-1.pdf"] || !got["scan-2.PNG"] || !got["scan-3.jpg"] {
		t.Fatalf("captured %v, want exactly scan-1.pdf scan-2.PNG scan-3.jpg", got)
	}
}

// AC-12.1: filename_pattern is an RE2 regex (TRD 5.8), anchors honoured.
func TestFilenamePatternIsAnchoredRegex(t *testing.T) {
	r := newRig(t, func(c *filedrop.Config) { c.FilenamePattern = `^SMP\d+\.pdf$` })
	r.write("SMP12.pdf", pdf)
	r.write("xSMP12.pdf", pdf)
	r.write("SMP12.pdf.png", pdf)
	r.settle()
	if r.store.count() != 1 || metaOf(t, r.store.items[0])["file_name"] != "SMP12.pdf" {
		t.Fatalf("captured %d items, want only SMP12.pdf", r.store.count())
	}
}

// AC-12.1: allowed_types restricts the captured extensions.
func TestAllowedTypesRestrictsExtensions(t *testing.T) {
	r := newRig(t, func(c *filedrop.Config) { c.AllowedTypes = []string{"pdf"} })
	r.write("a.pdf", pdf)
	r.write("b.PDF", pdf)
	r.write("c.png", pdf)
	r.write("d.jpg", pdf)
	r.settle()
	got := map[string]bool{}
	for _, in := range r.store.items {
		got[metaOf(t, in)["file_name"].(string)] = true
	}
	if len(got) != 2 || !got["a.pdf"] || !got["b.PDF"] {
		t.Fatalf("captured %v, want exactly a.pdf b.PDF", got)
	}
}

// AC-12.5: captured_subdirectory defaults to "captured" when omitted.
func TestMoveDefaultsCapturedSubdirectory(t *testing.T) {
	r := newRig(t, func(c *filedrop.Config) { c.MoveAfterCapture = true })
	p := r.write("a.pdf", pdf)
	r.settle()
	if r.store.count() != 1 {
		t.Fatal("not captured")
	}
	if _, err := os.Stat(p); !os.IsNotExist(err) {
		t.Fatal("source still in the watched folder after move")
	}
	if b, err := os.ReadFile(filepath.Join(r.dir, "captured", "a.pdf")); err != nil || !bytes.Equal(b, pdf) {
		t.Fatalf("moved file missing in default captured/: %v", err)
	}
}

// AC-12.2
func TestBarcodeFromFileName(t *testing.T) {
	r := newRig(t, func(c *filedrop.Config) { c.BarcodeRegex = `^(?P<barcode>E\d{10})_` })
	r.write("E2600000042_chrom.pdf", pdf)
	r.write("unlabelled.pdf", append([]byte("%PDF-1.4\n"), 'z'))
	r.settle()
	if r.store.count() != 2 {
		t.Fatalf("captured %d, want 2 (unmatched file is still stored)", r.store.count())
	}
	for _, in := range r.store.items {
		m := metaOf(t, in)
		switch m["file_name"] {
		case "E2600000042_chrom.pdf":
			if m["barcode"] != "E2600000042" {
				t.Fatalf("barcode = %v", m["barcode"])
			}
		case "unlabelled.pdf":
			if v, ok := m["barcode"]; ok && v != "" && v != nil {
				t.Fatalf("unmatched file carries barcode %v; must have none", v)
			}
		default:
			t.Fatalf("unexpected %v", m["file_name"])
		}
	}
}

// AC-12.5 agent side: same path+size+mtime+sha is never captured twice.
func TestSameFileNeverCapturedTwice(t *testing.T) {
	r := newRig(t, nil)
	r.write("a.pdf", pdf)
	r.settle()
	for i := 0; i < 5; i++ {
		r.clk.Advance(6 * time.Second)
		r.scan()
	}
	if r.store.count() != 1 {
		t.Fatalf("captured %d times, want 1", r.store.count())
	}
	// agent restart: a new watcher over the same store (the queue file_drop_seen table) also skips it.
	w2 := r.build(filedrop.Config{InstrumentID: instID, Folder: r.dir}, r.store)
	for i := 0; i < 2; i++ {
		if err := w2.Scan(t0Ctx()); err != nil {
			t.Fatal(err)
		}
		r.clk.Advance(6 * time.Second)
	}
	if r.store.count() != 1 {
		t.Fatalf("after restart captured %d, want 1", r.store.count())
	}
}

func TestRedroppedFileWithNewMtimeIsReuploadedForServerDedupe(t *testing.T) {
	r := newRig(t, nil)
	p := r.write("a.pdf", pdf)
	r.settle()
	if err := os.Chtimes(p, t0.Add(2*time.Hour), t0.Add(2*time.Hour)); err != nil {
		t.Fatal(err)
	}
	r.settle()
	if r.store.count() != 2 {
		t.Fatalf("captured %d, want 2: key includes mtime, the server dedupes by file_sha256", r.store.count())
	}
	if r.store.recs[0].FileSHA256 != r.store.recs[1].FileSHA256 {
		t.Fatal("file_sha256 must be identical so the server can dedupe")
	}
}

func TestCaptureFailureIsRetriedAndLeavesNoSeenRow(t *testing.T) {
	r := newRig(t, func(c *filedrop.Config) { c.MoveAfterCapture = true; c.CapturedSubdirectory = "done" })
	p := r.write("a.pdf", pdf)
	r.store.failNext = errBoom
	r.settle()
	if r.store.count() != 0 {
		t.Fatal("capture reported success")
	}
	if _, err := os.Stat(p); err != nil {
		t.Fatal("file moved although the item commit failed")
	}
	r.clk.Advance(6 * time.Second)
	r.scan()
	if r.store.count() != 1 {
		t.Fatal("not retried on the next poll")
	}
}

func TestStoreSeenErrorDoesNotPanicOrCapture(t *testing.T) {
	r := newRig(t, nil)
	r.write("a.pdf", pdf)
	r.store.seenErr = errBoom
	r.settle()
	if r.store.count() != 0 {
		t.Fatal("captured although dedupe state is unknown")
	}
}

// AC-12.5: never delete unless move_after_capture.
func TestMoveAfterCapture(t *testing.T) {
	r := newRig(t, func(c *filedrop.Config) { c.MoveAfterCapture = true; c.CapturedSubdirectory = "done" })
	p := r.write("a.pdf", pdf)
	r.settle()
	if r.store.count() != 1 {
		t.Fatal("not captured")
	}
	if _, err := os.Stat(p); !os.IsNotExist(err) {
		t.Fatal("source still in the watched folder after move")
	}
	b, err := os.ReadFile(filepath.Join(r.dir, "done", "a.pdf"))
	if err != nil || !bytes.Equal(b, pdf) {
		t.Fatalf("moved file missing or altered: %v", err)
	}
	r.clk.Advance(10 * time.Second)
	r.scan()
	if r.store.count() != 1 {
		t.Fatal("moved file captured again (captured subdirectory must not be scanned)")
	}
}

func TestMoveNeverOverwritesExistingCapturedFile(t *testing.T) {
	r := newRig(t, func(c *filedrop.Config) { c.MoveAfterCapture = true; c.CapturedSubdirectory = "done" })
	old := []byte("OLD-CAPTURE")
	r.write(filepath.Join("done", "a.pdf"), old)
	r.write("a.pdf", pdf)
	r.settle()
	if b, _ := os.ReadFile(filepath.Join(r.dir, "done", "a.pdf")); !bytes.Equal(b, old) {
		t.Fatal("existing captured file was overwritten")
	}
	found := false
	ents, _ := os.ReadDir(filepath.Join(r.dir, "done"))
	for _, e := range ents {
		if b, _ := os.ReadFile(filepath.Join(r.dir, "done", e.Name())); bytes.Equal(b, pdf) {
			found = true
		}
	}
	if !found {
		t.Fatal("captured bytes lost: not in the captured subdirectory")
	}
}

func TestNoDeleteWhenMoveDisabled(t *testing.T) {
	r := newRig(t, nil)
	p := r.write("a.pdf", pdf)
	r.settle()
	r.clk.Advance(time.Hour)
	r.scan()
	if b, err := os.ReadFile(p); err != nil || !bytes.Equal(b, pdf) {
		t.Fatal("file changed or deleted with move_after_capture = false")
	}
	if ents, _ := os.ReadDir(r.dir); len(ents) != 1 {
		t.Fatalf("watched folder gained or lost entries: %d", len(ents))
	}
}

// AB14 path safety.
func TestUnsafeCapturedSubdirectoryRejected(t *testing.T) {
	dir := t.TempDir()
	for _, sub := range []string{"..", "../escape", `..\escape`, "a/../../b", "a/b", `a\b`, filepath.Join(dir, "abs"), `C:\Windows`, `\\srv\share`, ".", "done/..",
		"my dir", "café", "a.b", strings.Repeat("a", 61)} {
		_, err := filedrop.New(filedrop.Options{Store: &fakeStore{},
			Config: filedrop.Config{InstrumentID: instID, Folder: dir, MoveAfterCapture: true, CapturedSubdirectory: sub}})
		if err == nil {
			t.Errorf("CapturedSubdirectory %q accepted", sub)
		}
	}
}

func TestSubdirectoriesAndDirectoriesNamedLikeFilesAreIgnored(t *testing.T) {
	r := newRig(t, nil)
	if err := os.MkdirAll(filepath.Join(r.dir, "dir.pdf"), 0o755); err != nil {
		t.Fatal(err)
	}
	r.write(filepath.Join("sub", "inner.pdf"), pdf)
	r.write("top.pdf", pdf)
	r.settle()
	if r.store.count() != 1 || metaOf(t, r.store.items[0])["file_name"] != "top.pdf" {
		t.Fatalf("captured %d items; only top.pdf is in scope (no recursion, no directories)", r.store.count())
	}
}

func TestSymlinkOutOfFolderIsNotFollowed(t *testing.T) {
	r := newRig(t, nil)
	outside := t.TempDir()
	secret := filepath.Join(outside, "secret.pdf")
	if err := os.WriteFile(secret, []byte("OUTSIDE-FOLDER"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(secret, filepath.Join(r.dir, "link.pdf")); err != nil {
		t.Skipf("cannot create symlink here: %v", err)
	}
	if err := os.Symlink(outside, filepath.Join(r.dir, "linkdir")); err != nil {
		t.Skipf("cannot create dir symlink here: %v", err)
	}
	r.settle()
	for _, in := range r.store.items {
		if strings.Contains(string(in.Raw), "OUTSIDE-FOLDER") {
			t.Fatal("file outside the watched folder was captured through a symlink")
		}
	}
	if r.store.count() != 0 {
		t.Fatalf("captured %d items via links", r.store.count())
	}
}

func TestLogsCarryCodesOnly(t *testing.T) {
	r := newRig(t, func(c *filedrop.Config) { c.BarcodeRegex = `(?P<barcode>E\d{10})` })
	r.write("E2600000042.pdf", pdf)
	r.store.seenErr = errBoom
	r.settle()
	r.store.seenErr = nil
	r.store.failNext = errBoom
	r.clk.Advance(6 * time.Second)
	r.scan()
	for _, c := range r.log.codes {
		if strings.Contains(c, "E2600000042") || strings.Contains(c, "pdf") || strings.Contains(c, "boom") || strings.ContainsAny(c, " /\\") {
			t.Fatalf("log code leaks file name/barcode/error text: %q", c)
		}
	}
	if len(r.log.codes) == 0 {
		t.Fatal("store failures must be logged as a code")
	}
}

func TestRunPollsAndStopsOnCancel(t *testing.T) {
	dir := t.TempDir()
	st := &fakeStore{}
	w, err := filedrop.New(filedrop.Options{Store: st, PollInterval: 10 * time.Millisecond,
		Config: filedrop.Config{InstrumentID: instID, Folder: dir, StableFor: 30 * time.Millisecond}})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "a.pdf"), pdf, 0o644); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- w.Run(ctx) }()
	deadline := time.After(3 * time.Second)
	for st.count() == 0 {
		select {
		case <-deadline:
			cancel()
			t.Fatal("Run did not capture a stable file")
		case <-time.After(10 * time.Millisecond):
		}
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Run returned %v on cancel", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Run did not stop on cancel")
	}
	if st.count() != 1 {
		t.Fatalf("captured %d, want 1", st.count())
	}
}

func TestMissingFolderIsNotFatal(t *testing.T) {
	r := newRig(t, nil)
	if err := os.RemoveAll(r.dir); err != nil {
		t.Fatal(err)
	}
	// An unreachable share must not panic or crash the service; an error or nil are both acceptable.
	_ = r.w.Scan(t0Ctx())
	if r.store.count() != 0 {
		t.Fatal("captured from a missing folder")
	}
}
