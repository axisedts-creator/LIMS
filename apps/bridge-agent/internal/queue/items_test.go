package queue

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"testing"
	"time"
)

func TestItemRoundTrip(t *testing.T) {
	d, _, _ := openNew(t)
	raw := []byte("MSH|^~\\&|SYNTH|LAB|||20261111080000||ORU^R01|1|P|2.5\rOBX|1|NM|GLU||5.5\r")
	meta := []byte(`{"link_meta":{"frames":3},"file":"synthetic.txt"}`)
	if err := d.InsertItem(ItemInput{ID: "it-1", InstrumentID: "inst-1", Kind: "data", Protocol: "hl7v2", Raw: raw, Meta: meta,
		CapturedAtAgent: "2026-11-11T08:00:00.000Z", ClockOffsetMs: -1500}); err != nil {
		t.Fatal(err)
	}
	got, err := d.GetItem("it-1")
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(raw)
	if !bytes.Equal(got.Raw, raw) || !bytes.Equal(got.Meta, meta) {
		t.Errorf("payload/meta not round-tripped: %q / %q", got.Raw, got.Meta)
	}
	if got.RawSHA256 != hex.EncodeToString(sum[:]) || got.SizeBytes != int64(len(raw)) {
		t.Errorf("sha/size = %s / %d", got.RawSHA256, got.SizeBytes)
	}
	if got.State != "pending" || got.Attempts != 0 || got.UploadedAt != "" || got.ServerMessageID != "" {
		t.Errorf("new item must be pending/0 attempts/not uploaded: %+v", got)
	}
	if got.InstrumentID != "inst-1" || got.Kind != "data" || got.Protocol != "hl7v2" ||
		got.CapturedAtAgent != "2026-11-11T08:00:00.000Z" || got.ClockOffsetMs != -1500 {
		t.Errorf("fields = %+v", got.ItemInput)
	}
}

func TestItemLargeAttachment(t *testing.T) {
	d, _, _ := openNew(t)
	raw := make([]byte, 3<<20) // 3 MiB: at the upload batch ceiling (AC-08.1)
	_, _ = rand.Read(raw)
	in1 := in("big", "attachment", raw)
	in1.Protocol = "file_drop"
	if err := d.InsertItem(in1); err != nil {
		t.Fatal(err)
	}
	got, err := d.GetItem("big")
	if err != nil || !bytes.Equal(got.Raw, raw) {
		t.Fatalf("large payload round trip failed: %v", err)
	}
}

func TestItemEmptyMeta(t *testing.T) {
	d, _, _ := openNew(t)
	x := in("it-1", "data", []byte("raw"))
	x.Meta = nil
	if err := d.InsertItem(x); err != nil {
		t.Fatalf("nil meta must be accepted (meta_ct is NOT NULL, so it is stored encrypted-empty): %v", err)
	}
	got, err := d.GetItem("it-1")
	if err != nil || len(got.Meta) != 0 {
		t.Errorf("%v %q", err, got.Meta)
	}
}

func TestItemValidation(t *testing.T) {
	d, _, _ := openNew(t)
	if err := d.InsertItem(in("it-1", "data", []byte("a"))); err != nil {
		t.Fatal(err)
	}
	if err := d.InsertItem(in("it-1", "data", []byte("b"))); err == nil {
		t.Error("duplicate id must fail")
	}
	if err := d.InsertItem(in("it-2", "bogus", []byte("a"))); err == nil {
		t.Error("kind outside data|incomplete|host_query|attachment must fail")
	}
	bad := in("it-3", "data", []byte("a"))
	bad.Protocol = "serial"
	if err := d.InsertItem(bad); err == nil {
		t.Error("protocol outside astm|hl7v2|file_drop must fail")
	}
	for _, k := range []string{"data", "incomplete", "host_query", "attachment"} {
		if err := d.InsertItem(in("k-"+k, k, []byte("a"))); err != nil {
			t.Errorf("kind %s: %v", k, err)
		}
	}
}

func TestGetItemMissing(t *testing.T) {
	d, _, _ := openNew(t)
	if _, err := d.GetItem("nope"); !errors.Is(err, ErrNotFound) {
		t.Errorf("err = %v, want ErrNotFound", err)
	}
}

func TestMarkUploaded(t *testing.T) {
	d, _, _ := openNew(t)
	if err := d.InsertItem(in("it-1", "data", []byte("a"))); err != nil {
		t.Fatal(err)
	}
	at := time.Date(2026, 11, 11, 9, 30, 15, 250_000_000, time.UTC)
	if err := d.MarkUploaded("it-1", "srv-msg-1", at); err != nil {
		t.Fatal(err)
	}
	got, _ := d.GetItem("it-1")
	up, err := time.Parse(time.RFC3339Nano, got.UploadedAt)
	if got.State != "uploaded" || got.ServerMessageID != "srv-msg-1" || err != nil || !up.Equal(at) {
		t.Errorf("after MarkUploaded: %+v (uploaded_at parse err %v)", got, err)
	}
	if err := d.MarkUploaded("nope", "x", at); !errors.Is(err, ErrNotFound) {
		t.Errorf("err = %v, want ErrNotFound", err)
	}
}

func TestSetItemStateAndCounts(t *testing.T) {
	d, _, _ := openNew(t)
	for i, s := range []string{"pending", "uploading", "rejected", "oversize", "pending"} {
		id := string(rune('a' + i))
		if err := d.InsertItem(in(id, "data", []byte(id))); err != nil {
			t.Fatal(err)
		}
		if s != "pending" {
			if err := d.SetItemState(id, s); err != nil {
				t.Fatalf("SetItemState %s: %v", s, err)
			}
		}
	}
	c, err := d.CountByState()
	if err != nil || c["pending"] != 2 || c["uploading"] != 1 || c["rejected"] != 1 || c["oversize"] != 1 || c["uploaded"] != 0 {
		t.Errorf("counts = %v %v", c, err)
	}
	if err := d.SetItemState("a", "bogus"); err == nil {
		t.Error("state outside the CHECK list must fail")
	}
	if err := d.SetItemState("nope", "pending"); !errors.Is(err, ErrNotFound) {
		t.Errorf("err = %v, want ErrNotFound", err)
	}
}
