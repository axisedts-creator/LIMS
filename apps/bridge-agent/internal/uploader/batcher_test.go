package uploader_test

import (
	"encoding/base64"
	"errors"
	"testing"

	"lims/apps/bridge-agent/internal/uploader"
)

// AC-08.1: batches <=100 messages and <=3 MiB of JSON body; oldest captured first.
func TestBuildBatch_CapsAtHundredMessages(t *testing.T) {
	var items []uploader.Item
	for i := 0; i < 250; i++ {
		items = append(items, mkItem(i, 100))
	}
	b, err := uploader.BuildBatch(items, t0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(b.Items) != 100 || len(b.Rest) != 150 {
		t.Fatalf("items=%d rest=%d, want 100/150", len(b.Items), len(b.Rest))
	}
	if w := (call{body: b.Body}).wire(); len(w.Messages) != 100 {
		t.Fatalf("body has %d messages", len(w.Messages))
	}
	if uploader.MaxBatchMessages != 100 || uploader.MaxBatchBytes != 3<<20 {
		t.Fatal("constants must be 100 / 3 MiB")
	}
}

func TestBuildBatch_CapsAtThreeMiBOfJSON(t *testing.T) {
	// 1 MiB raw -> ~1.33 MiB base64: two fit (2.67 MiB), three would be 4 MiB.
	items := []uploader.Item{mkItem(1, 1<<20), mkItem(2, 1<<20), mkItem(3, 1<<20), mkItem(4, 1<<20)}
	b, err := uploader.BuildBatch(items, t0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(b.Body) > 3<<20 {
		t.Fatalf("body %d bytes > 3 MiB", len(b.Body))
	}
	if len(b.Items) != 2 || len(b.Rest) != 2 {
		t.Fatalf("items=%d rest=%d, want 2/2", len(b.Items), len(b.Rest))
	}
}

func TestBuildBatch_SingleMaxSizeMessageStillFits(t *testing.T) {
	b, err := uploader.BuildBatch([]uploader.Item{mkItem(1, 1<<20)}, t0, 0)
	if err != nil || len(b.Items) != 1 || len(b.Rest) != 0 {
		t.Fatalf("err=%v items=%d rest=%d", err, len(b.Items), len(b.Rest))
	}
}

func TestBuildBatch_SingleItemOverCapIsAnErrorNotAnEmptyBatch(t *testing.T) {
	_, err := uploader.BuildBatch([]uploader.Item{mkItem(1, 3<<20)}, t0, 0)
	if !errors.Is(err, uploader.ErrItemTooLarge) {
		t.Fatalf("err = %v, want ErrItemTooLarge", err)
	}
}

func TestBuildBatch_EmptyInput(t *testing.T) {
	b, err := uploader.BuildBatch(nil, t0, 0)
	if err != nil || len(b.Items) != 0 || len(b.Body) != 0 {
		t.Fatalf("empty input must give empty batch, got err=%v items=%d body=%d", err, len(b.Items), len(b.Body))
	}
}

// Order: oldest captured_at_agent first (TRD 5.7), regardless of input order.
func TestBuildBatch_OldestCapturedFirst(t *testing.T) {
	b, err := uploader.BuildBatch([]uploader.Item{mkItem(3, 10), mkItem(1, 10), mkItem(2, 10)}, t0, 0)
	if err != nil {
		t.Fatal(err)
	}
	w := (call{body: b.Body}).wire()
	for i, want := range []string{mkItem(1, 0).ID, mkItem(2, 0).ID, mkItem(3, 0).ID} {
		if w.Messages[i].AgentMessageID != want || b.Items[i].ID != want {
			t.Fatalf("position %d: got %s want %s", i, w.Messages[i].AgentMessageID, want)
		}
	}
}

// AC-14.2: each message carries agent capture time + the offset in force at capture (not the current one);
// the envelope carries sent_at_agent and the current offset. Wire format per TRD 7.4 Message.
func TestBuildBatch_WireFormatAndPerMessageOffset(t *testing.T) {
	it := mkItem(7, 5)
	it.Raw = []byte("H|\\^&|||")
	it.ClockOffsetMs = 1234
	b, err := uploader.BuildBatch([]uploader.Item{it}, t0, 9999)
	if err != nil {
		t.Fatal(err)
	}
	w := (call{body: b.Body}).wire()
	m := w.Messages[0]
	if w.SentAtAgent != "2026-11-06T04:00:00.000Z" || w.ClockOffsetMs != 9999 {
		t.Fatalf("envelope %+v", w)
	}
	if m.ClockOffsetMs != 1234 {
		t.Fatalf("message offset %d, want the capture-time 1234", m.ClockOffsetMs)
	}
	if m.CapturedAtAgent != "2026-11-06T04:00:07.000Z" || m.AgentMessageID != it.ID || m.InstrumentID != it.InstrumentID ||
		m.Protocol != "astm" || m.Kind != "data" || m.RawSHA256 != it.RawSHA256 {
		t.Fatalf("message %+v", m)
	}
	if raw, err := base64.StdEncoding.DecodeString(m.RawBase64); err != nil || string(raw) != string(it.Raw) {
		t.Fatalf("raw_base64 round trip failed: %v", err)
	}
}
