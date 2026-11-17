package queue

import (
	"bytes"
	"crypto/rand"
	"errors"
	"os"
	"testing"
	"time"
)

// AC-08.4 + 02-TRD 5.6 Truncation + REQ-SEC-117 (secure_delete, <= 72 h after upload).

var now = time.Date(2026, 11, 11, 12, 0, 0, 0, time.UTC)

func ago(h float64) time.Time { return now.Add(-time.Duration(h * float64(time.Hour))) }

func addUploaded(t *testing.T, d *DB, id string, uploadedAgoH float64) {
	t.Helper()
	if err := d.InsertItem(in(id, "data", []byte("raw-"+id))); err != nil {
		t.Fatal(err)
	}
	if err := d.MarkUploaded(id, "srv-"+id, ago(uploadedAgoH)); err != nil {
		t.Fatal(err)
	}
}

func exists(t *testing.T, d *DB, id string) bool {
	t.Helper()
	_, err := d.GetItem(id)
	if err == nil {
		return true
	}
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("GetItem %s: %v", id, err)
	}
	return false
}

func TestTruncateDeletesOnlyOldUploaded(t *testing.T) {
	d, _, _ := openNew(t)
	addUploaded(t, d, "old", 25)   // older than the 24 h default
	addUploaded(t, d, "fresh", 23) // younger
	res, err := d.Truncate(now, 24*time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if exists(t, d, "old") || !exists(t, d, "fresh") || res.ItemsDeleted != 1 {
		t.Errorf("old gone=%v fresh kept=%v deleted=%d", !exists(t, d, "old"), exists(t, d, "fresh"), res.ItemsDeleted)
	}
}

func TestTruncateNeverDeletesNonUploaded(t *testing.T) {
	d, _, _ := openNew(t)
	old := in("x", "data", []byte("x"))
	old.CapturedAtAgent = "2026-01-01T00:00:00.000Z" // months old
	for _, s := range []string{"pending", "uploading", "rejected", "oversize"} {
		x := old
		x.ID = "it-" + s
		if err := d.InsertItem(x); err != nil {
			t.Fatal(err)
		}
		if s != "pending" {
			if err := d.SetItemState(x.ID, s); err != nil {
				t.Fatal(err)
			}
		}
	}
	res, err := d.Truncate(now.Add(1000*time.Hour), 24*time.Hour)
	if err != nil || res.ItemsDeleted != 0 {
		t.Fatalf("Truncate = %+v %v", res, err)
	}
	for _, s := range []string{"pending", "uploading", "rejected", "oversize"} {
		if !exists(t, d, "it-"+s) {
			t.Errorf("%s item was deleted automatically (AC-08.4: only uploaded rows go)", s)
		}
	}
}

func TestTruncateRetentionIsClamped(t *testing.T) {
	d, _, _ := openNew(t)
	addUploaded(t, d, "a80", 80) // beyond the 72 h max
	addUploaded(t, d, "a60", 60)
	addUploaded(t, d, "a2", 2)
	addUploaded(t, d, "a05", 0.5)
	// retention 100 h is clamped to 72 h: 80 h-old goes, 60 h-old stays.
	if _, err := d.Truncate(now, 100*time.Hour); err != nil {
		t.Fatal(err)
	}
	if exists(t, d, "a80") || !exists(t, d, "a60") {
		t.Errorf("max clamp: a80 kept=%v a60 kept=%v", exists(t, d, "a80"), exists(t, d, "a60"))
	}
	// retention 10 minutes is clamped up to 1 h: 2 h-old goes, 30 min-old stays.
	if _, err := d.Truncate(now, 10*time.Minute); err != nil {
		t.Fatal(err)
	}
	if exists(t, d, "a2") || !exists(t, d, "a05") {
		t.Errorf("min clamp: a2 kept=%v a05 kept=%v", exists(t, d, "a2"), exists(t, d, "a05"))
	}
}

func TestTruncateRetentionBoundaries(t *testing.T) {
	d, _, _ := openNew(t)
	addUploaded(t, d, "u", 72.5)
	addUploaded(t, d, "v", 71.5)
	if _, err := d.Truncate(now, 72*time.Hour); err != nil {
		t.Fatal(err)
	}
	if exists(t, d, "u") || !exists(t, d, "v") {
		t.Errorf("72 h retention: u kept=%v v kept=%v", exists(t, d, "u"), exists(t, d, "v"))
	}
}

func insertOutbound(t *testing.T, path, id, state string, createdAgoH float64) {
	t.Helper()
	rawExec(t, path, `INSERT INTO outbound (id, instrument_id, nonce, ct, created_at, attempts, state) VALUES (?, 'inst-1', x'000000000000000000000000', x'00', ?, 0, ?)`,
		id, ago(createdAgoH).Format(tsLayout), state)
}

func TestTruncateOutbound(t *testing.T) {
	d, path, _ := openNew(t)
	insertOutbound(t, path, "sent-old", "sent", 25)
	insertOutbound(t, path, "failed-old", "failed", 30)
	insertOutbound(t, path, "sent-new", "sent", 1)
	insertOutbound(t, path, "failed-new", "failed", 23)
	insertOutbound(t, path, "pending-old", "pending", 100)
	res, err := d.Truncate(now, 72*time.Hour) // outbound uses a fixed 24 h, not upload.uploaded_retention_hours
	if err != nil || res.OutboundDeleted != 2 {
		t.Fatalf("Truncate = %+v %v", res, err)
	}
	var left []string
	rows, err := rawDB(t, path).Query("SELECT id FROM outbound ORDER BY id")
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		_ = rows.Scan(&id)
		left = append(left, id)
	}
	if len(left) != 3 || left[0] != "failed-new" || left[1] != "pending-old" || left[2] != "sent-new" {
		t.Errorf("outbound left = %v", left)
	}
}

func TestTruncateIdempotentOnEmptyQueue(t *testing.T) {
	d, _, _ := openNew(t)
	for i := 0; i < 2; i++ {
		if res, err := d.Truncate(now, 24*time.Hour); err != nil || res.ItemsDeleted != 0 || res.OutboundDeleted != 0 {
			t.Fatalf("%+v %v", res, err)
		}
	}
}

// REQ-SEC-117 / AC-08.4: deleted rows are overwritten (secure_delete), not left in free pages or the WAL.
func TestTruncateSecureDeleteLeavesNoCiphertextOnDisk(t *testing.T) {
	d, path, _ := openNew(t)
	raw := make([]byte, 400)
	_, _ = rand.Read(raw)
	if err := d.InsertItem(in("gone", "data", raw)); err != nil {
		t.Fatal(err)
	}
	if err := d.MarkUploaded("gone", "srv-gone", ago(30)); err != nil {
		t.Fatal(err)
	}
	ct := rawBlob(t, path, "SELECT ct FROM items WHERE id='gone'")
	checkpoint(t, path)
	if !bytes.Contains(diskBytes(t, path), ct) {
		t.Fatal("sanity: ciphertext should be in the file before truncation")
	}
	if res, err := d.Truncate(now, 24*time.Hour); err != nil || res.ItemsDeleted != 1 {
		t.Fatalf("Truncate = %+v %v", res, err)
	}
	checkpoint(t, path)
	if bytes.Contains(diskBytes(t, path), ct) {
		t.Error("deleted item's ciphertext is still in the db/wal file (secure_delete not effective)")
	}
}

// TRD 5.6: auto_vacuum=INCREMENTAL + PRAGMA incremental_vacuum after deletes returns the space.
func TestTruncateShrinksFile(t *testing.T) {
	d, path, _ := openNew(t)
	raw := make([]byte, 3<<20)
	_, _ = rand.Read(raw)
	if err := d.InsertItem(in("big", "attachment", raw)); err != nil {
		t.Fatal(err)
	}
	if err := d.MarkUploaded("big", "srv-big", ago(30)); err != nil {
		t.Fatal(err)
	}
	checkpoint(t, path)
	before, _ := os.Stat(path)
	if before.Size() < 3<<20 {
		t.Fatalf("sanity: file %d bytes, want >= 3 MiB", before.Size())
	}
	if _, err := d.Truncate(now, 24*time.Hour); err != nil {
		t.Fatal(err)
	}
	checkpoint(t, path)
	after, _ := os.Stat(path)
	if after.Size() > 1<<20 {
		t.Errorf("file still %d bytes after deleting the only item (incremental_vacuum missing?)", after.Size())
	}
}
