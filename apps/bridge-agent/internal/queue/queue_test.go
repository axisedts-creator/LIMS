package queue

import (
	"bytes"
	"errors"
	"path/filepath"
	"strings"
	"testing"
)

// 02-TRD 5.6 pragmas + schema; D-07 encryption; REQ-SEC-117.

func TestPragmas(t *testing.T) {
	d, _, _ := openNew(t)
	want := map[string]string{
		"journal_mode":  "wal",
		"synchronous":   "2", // FULL (D-02)
		"secure_delete": "1",
		"foreign_keys":  "1",
		"busy_timeout":  "5000",
		"auto_vacuum":   "2", // INCREMENTAL
	}
	for k, v := range want {
		got, err := d.Pragma(k)
		if err != nil || got != v {
			t.Errorf("PRAGMA %s = %q (err %v), want %q", k, got, err, v)
		}
	}
	if v, _ := d.Pragma("user_version"); v == "" || v == "0" {
		t.Errorf("PRAGMA user_version = %q, want >= 1 (schema is versioned)", v)
	}
}

func TestSchemaTables(t *testing.T) {
	_, path, _ := openNew(t)
	db := rawDB(t, path)
	for _, tbl := range []string{"kv", "sessions", "session_chunks", "items", "file_drop_seen", "outbound"} {
		var n int
		if err := db.QueryRow("SELECT count(*) FROM sqlite_master WHERE type='table' AND name=?", tbl).Scan(&n); err != nil || n != 1 {
			t.Errorf("table %s missing (n=%d err=%v)", tbl, n, err)
		}
	}
	var n int
	if err := db.QueryRow("SELECT count(*) FROM sqlite_master WHERE type='index' AND name='items__state_next'").Scan(&n); err != nil || n != 1 {
		t.Errorf("index items__state_next missing")
	}
}

func TestReopenKeepsDataAndReusesKey(t *testing.T) {
	path := dbPath(t)
	p := &testProtector{}
	d := openT(t, path, p, Options{})
	if err := d.InsertItem(in("it-1", "data", []byte("H|\\^&|||SYNTH\rL|1|N\r"))); err != nil {
		t.Fatal(err)
	}
	_ = d.Close()
	if p.protectCalls != 1 {
		t.Fatalf("Protect called %d times on first open, want exactly 1 (key created once)", p.protectCalls)
	}
	d2 := openT(t, path, p, Options{})
	got, err := d2.GetItem("it-1")
	if err != nil || string(got.Raw) != "H|\\^&|||SYNTH\rL|1|N\r" {
		t.Fatalf("after reopen: %v %q", err, got.Raw)
	}
	if p.protectCalls != 1 || p.unprotectCalls < 1 {
		t.Errorf("second open must Unprotect the stored key, not mint a new one (protect=%d unprotect=%d)", p.protectCalls, p.unprotectCalls)
	}
}

func TestNoPlaintextOrKeyOnDisk(t *testing.T) {
	d, path, p := openNew(t)
	marker := "SYNTH-PATIENT-MARKER-9f3a" // synthetic
	raw := []byte("P|1||" + marker + "|\rR|1|^^^GLU|5.5|mmol/L\r")
	if err := d.InsertItem(ItemInput{ID: "it-1", InstrumentID: "inst-1", Kind: "data", Protocol: "astm", Raw: raw,
		Meta: []byte(`{"file":"` + marker + `.txt"}`), CapturedAtAgent: "2026-11-11T08:00:00.000Z"}); err != nil {
		t.Fatal(err)
	}
	if err := d.BeginSession(Session{ID: "s-1", InstrumentID: "inst-1", Protocol: "astm", StartedAtAgent: "2026-11-11T08:00:00.000Z", LastFrameAtAgent: "2026-11-11T08:00:00.000Z"}); err != nil {
		t.Fatal(err)
	}
	if err := d.AppendChunk("s-1", 1, 2, []byte(marker), "2026-11-11T08:00:01.000Z"); err != nil {
		t.Fatal(err)
	}
	_ = d.Close()
	disk := diskBytes(t, path)
	if bytes.Contains(disk, []byte(marker)) {
		t.Error("plaintext marker found in db/wal file")
	}
	if len(p.lastPlain) != 32 {
		t.Fatalf("data key length = %d, want 32 (AES-256)", len(p.lastPlain))
	}
	if bytes.Contains(disk, p.lastPlain) {
		t.Error("plaintext data key found in db/wal file (must be stored only wrapped)")
	}
}

func TestNonceUniqueAndSize(t *testing.T) {
	d, path, _ := openNew(t)
	raw := []byte("same plaintext")
	for _, id := range []string{"a", "b"} {
		if err := d.InsertItem(in(id, "data", raw)); err != nil {
			t.Fatal(err)
		}
	}
	na := rawBlob(t, path, "SELECT nonce FROM items WHERE id='a'")
	nb := rawBlob(t, path, "SELECT nonce FROM items WHERE id='b'")
	if len(na) != 12 || len(nb) != 12 {
		t.Fatalf("nonce length %d/%d, want 12 (96-bit)", len(na), len(nb))
	}
	if bytes.Equal(na, nb) {
		t.Error("two rows share a nonce")
	}
	ca := rawBlob(t, path, "SELECT ct FROM items WHERE id='a'")
	cb := rawBlob(t, path, "SELECT ct FROM items WHERE id='b'")
	if bytes.Equal(ca, cb) {
		t.Error("same plaintext produced same ciphertext")
	}
	if len(ca) != len(raw)+16 {
		t.Errorf("ct length %d, want plaintext+16-byte GCM tag = %d", len(ca), len(raw)+16)
	}
}

// ---- AAD tamper detection: table || ":" || row id || ":" || seq (TRD 5.6) ----

func seedTwoItems(t *testing.T) (*DB, string) {
	t.Helper()
	d, path, _ := openNew(t)
	if err := d.InsertItem(in("A", "data", []byte("payload-A-0123456789"))); err != nil {
		t.Fatal(err)
	}
	if err := d.InsertItem(in("B", "data", []byte("payload-B-0123456789"))); err != nil {
		t.Fatal(err)
	}
	return d, path
}

func mustTamper(t *testing.T, err error) {
	t.Helper()
	if !errors.Is(err, ErrTampered) {
		t.Fatalf("err = %v, want ErrTampered", err)
	}
}

func TestTamperFlippedCiphertextBit(t *testing.T) {
	d, path := seedTwoItems(t)
	rawExec(t, path, "UPDATE items SET ct = substr(ct,1,length(ct)-1) || x'00' WHERE id='A' AND substr(ct,-1,1) <> x'00'")
	rawExec(t, path, "UPDATE items SET ct = substr(ct,1,length(ct)-1) || x'01' WHERE id='A' AND substr(ct,-1,1) = x'00'")
	_, err := d.GetItem("A")
	mustTamper(t, err)
	if _, err := d.GetItem("B"); err != nil {
		t.Errorf("untouched item B must still read: %v", err)
	}
}

func TestTamperMetaCiphertext(t *testing.T) {
	d, path := seedTwoItems(t)
	rawExec(t, path, "UPDATE items SET meta_ct = x'00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff0011' WHERE id='A'")
	_, err := d.GetItem("A")
	mustTamper(t, err)
}

func TestTamperRowIDChanged(t *testing.T) {
	d, path := seedTwoItems(t)
	rawExec(t, path, "UPDATE items SET id='C' WHERE id='A'")
	_, err := d.GetItem("C")
	mustTamper(t, err) // AAD carries the row id: a row renamed or copied under another id must not decrypt
}

func TestTamperSwapCiphertextBetweenRows(t *testing.T) {
	d, path := seedTwoItems(t)
	// Read both rows first: a single UPDATE with subselects on items sees its own earlier writes.
	nonceA := rawBlob(t, path, "SELECT nonce FROM items WHERE id='A'")
	ctA := rawBlob(t, path, "SELECT ct FROM items WHERE id='A'")
	nonceB := rawBlob(t, path, "SELECT nonce FROM items WHERE id='B'")
	ctB := rawBlob(t, path, "SELECT ct FROM items WHERE id='B'")
	rawExec(t, path, "UPDATE items SET nonce=?, ct=? WHERE id='A'", nonceB, ctB)
	rawExec(t, path, "UPDATE items SET nonce=?, ct=? WHERE id='B'", nonceA, ctA)
	if !bytes.Equal(rawBlob(t, path, "SELECT ct FROM items WHERE id='A'"), ctB) ||
		!bytes.Equal(rawBlob(t, path, "SELECT ct FROM items WHERE id='B'"), ctA) {
		t.Fatal("test setup: ciphertexts were not exchanged")
	}
	_, errA := d.GetItem("A")
	_, errB := d.GetItem("B")
	mustTamper(t, errA)
	mustTamper(t, errB)
}

func TestTamperBadNonceLengthDoesNotPanic(t *testing.T) {
	d, path := seedTwoItems(t)
	rawExec(t, path, "UPDATE items SET nonce = x'00' WHERE id='A'")
	if _, err := d.GetItem("A"); err == nil {
		t.Fatal("want error for a 1-byte nonce")
	}
	rawExec(t, path, "UPDATE items SET ct = x'0102' WHERE id='B'") // shorter than the GCM tag
	if _, err := d.GetItem("B"); err == nil {
		t.Fatal("want error for a ciphertext shorter than the tag")
	}
}

func seedSession(t *testing.T, d *DB, id string, frames int) {
	t.Helper()
	if err := d.BeginSession(Session{ID: id, InstrumentID: "inst-1", Protocol: "astm",
		StartedAtAgent: "2026-11-11T08:00:00.000Z", LastFrameAtAgent: "2026-11-11T08:00:00.000Z"}); err != nil {
		t.Fatal(err)
	}
	for i := 1; i <= frames; i++ {
		if err := d.AppendChunk(id, i, (i+1)%8, []byte(strings.Repeat("x", i)+"|chunk"), "2026-11-11T08:00:01.000Z"); err != nil {
			t.Fatal(err)
		}
	}
}

func TestTamperChunkSeqChanged(t *testing.T) {
	d, path, _ := openNew(t)
	seedSession(t, d, "S1", 2)
	rawExec(t, path, "UPDATE session_chunks SET seq=99 WHERE session_id='S1' AND seq=1")
	_, err := d.Chunks("S1")
	mustTamper(t, err) // AAD carries seq
}

func TestTamperChunkMovedToOtherSession(t *testing.T) {
	d, path, _ := openNew(t)
	seedSession(t, d, "S1", 1)
	seedSession(t, d, "S2", 0)
	rawExec(t, path, "UPDATE session_chunks SET session_id='S2' WHERE session_id='S1'")
	_, err := d.Chunks("S2")
	mustTamper(t, err)
}

func TestFinalizeWithTamperedChunkFailsAndKeepsSession(t *testing.T) {
	d, path, _ := openNew(t)
	seedSession(t, d, "S1", 2)
	rawExec(t, path, "UPDATE session_chunks SET ct = x'00000000000000000000000000000000000000' WHERE session_id='S1' AND seq=2")
	_, err := d.FinalizeSession("S1", in("it-1", "data", nil))
	mustTamper(t, err)
	if _, err := d.GetItem("it-1"); !errors.Is(err, ErrNotFound) {
		t.Errorf("no item may be created from a tampered session, got %v", err)
	}
	if _, err := d.GetSession("S1"); err != nil {
		t.Errorf("session must remain after a failed finalise: %v", err)
	}
}

// ---- data key handling ----

func TestWrongDataKeyCannotDecrypt(t *testing.T) {
	path := dbPath(t)
	good := &testProtector{}
	d := openT(t, path, good, Options{})
	if err := d.InsertItem(in("A", "data", []byte("secret payload"))); err != nil {
		t.Fatal(err)
	}
	_ = d.Close()
	bad := funcProtector{
		protect:   good.Protect,
		unprotect: func([]byte) ([]byte, error) { return bytes.Repeat([]byte{7}, 32), nil }, // a valid-length but wrong key
	}
	d2 := openT(t, path, bad, Options{})
	_, err := d2.GetItem("A")
	mustTamper(t, err)
}

func TestUnprotectFailureFailsOpenAndKeepsKey(t *testing.T) {
	path := dbPath(t)
	good := &testProtector{}
	d := openT(t, path, good, Options{})
	if err := d.InsertItem(in("A", "data", []byte("secret payload"))); err != nil {
		t.Fatal(err)
	}
	_ = d.Close()
	broken := funcProtector{protect: good.Protect, unprotect: func([]byte) ([]byte, error) { return nil, errors.New("dpapi: key not valid") }}
	if d2, err := Open(path, broken, Options{}); err == nil {
		_ = d2.Close()
		t.Fatal("Open must fail when the data key cannot be unwrapped (never mint a new key over existing data)")
	}
	d3 := openT(t, path, good, Options{})
	if got, err := d3.GetItem("A"); err != nil || string(got.Raw) != "secret payload" {
		t.Fatalf("existing data lost after a failed open: %v %q", err, got.Raw)
	}
}

func TestUnprotectWrongLengthKeyFailsOpen(t *testing.T) {
	path := dbPath(t)
	good := &testProtector{}
	_ = openT(t, path, good, Options{}).Close()
	short := funcProtector{protect: good.Protect, unprotect: func([]byte) ([]byte, error) { return make([]byte, 16), nil }}
	if d, err := Open(path, short, Options{}); err == nil {
		_ = d.Close()
		t.Fatal("Open must reject a data key that is not 32 bytes")
	}
}

func TestProtectFailureFailsFirstOpen(t *testing.T) {
	p := funcProtector{protect: func([]byte) ([]byte, error) { return nil, errors.New("dpapi down") },
		unprotect: func([]byte) ([]byte, error) { return nil, errors.New("n/a") }}
	if d, err := Open(dbPath(t), p, Options{}); err == nil {
		_ = d.Close()
		t.Fatal("Open must fail when the key cannot be wrapped (never store a plaintext key)")
	}
}

// ---- disk guard (TRD 5.6: free < 500 MB => receivers NAK / AR; heartbeat disk_low) ----

func TestDiskGuard(t *testing.T) {
	const MiB = 1 << 20
	cases := []struct {
		name string
		free int64
		min  int64
		low  bool
	}{
		{"default threshold, 400e6 free", 400_000_000, 0, true},
		{"default threshold, 600 MiB free", 600 * MiB, 0, false},
		{"default threshold, 0 free", 0, 0, true},
		{"custom min, free below", 999, 1000, true},
		{"custom min, free equal (not below)", 1000, 1000, false},
		{"custom min, free above", 1001, 1000, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			path := dbPath(t)
			var gotDir string
			free := c.free
			d := openT(t, path, &testProtector{}, Options{MinFreeBytes: c.min,
				FreeBytes: func(dir string) (int64, error) { gotDir = dir; return free, nil }})
			low, err := d.DiskLow()
			if err != nil || low != c.low {
				t.Fatalf("DiskLow = %v, %v; want %v", low, err, c.low)
			}
			if gotDir != filepath.Dir(path) {
				t.Errorf("FreeBytes called with %q, want the queue volume dir (dir of %q)", gotDir, path)
			}
		})
	}
}

func TestDiskGuardDefaultFreeBytesWorksOnTempDir(t *testing.T) {
	d := openT(t, dbPath(t), &testProtector{}, Options{})
	if _, err := d.DiskLow(); err != nil {
		t.Fatalf("real free-space lookup failed: %v", err)
	}
}

func TestDiskLowDoesNotBlockPersist(t *testing.T) {
	// The guard decides NAK at ENQ; frames of a session already open must still persist (persist-before-ACK, AC-05.2).
	path := dbPath(t)
	d := openT(t, path, &testProtector{}, Options{FreeBytes: func(string) (int64, error) { return 1, nil }})
	seedSession(t, d, "S1", 2)
	if low, _ := d.DiskLow(); !low {
		t.Fatal("expected low")
	}
	ch, err := d.Chunks("S1")
	if err != nil || len(ch) != 2 {
		t.Fatalf("chunks %v %v", len(ch), err)
	}
}
