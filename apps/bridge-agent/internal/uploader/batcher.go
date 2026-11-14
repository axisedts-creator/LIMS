// Package uploader sends queued instrument messages to the LIMS (TRD 5.7): batching, backoff, rate budget, TLS.
package uploader

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"sort"
	"time"
)

const (
	MaxBatchMessages = 100
	MaxBatchBytes    = 3 << 20 // JSON body; the route limit is 4 MiB (CR-C7-009)
)

var (
	ErrItemTooLarge = errors.New("uploader: single message exceeds the batch byte cap")
	ErrUnauthorized = errors.New("uploader: device token rejected (401)")
	batchTail       = []byte(`]}`)
)

const isoUTC = "2006-01-02T15:04:05.000Z"

// Item is one queued message as the uploader sees it.
type Item struct {
	ID, InstrumentID, Kind, Protocol string
	Raw                              []byte
	RawSHA256                        string
	CapturedAtAgent                  time.Time
	ClockOffsetMs                    int64
	LinkMeta                         json.RawMessage
	Attempts                         int
}

// Batch is a request body plus the items it carries and the leftovers that did not fit.
type Batch struct {
	Body        []byte
	Items, Rest []Item
}

type wireMessage struct {
	AgentMessageID  string          `json:"agent_message_id"`
	InstrumentID    string          `json:"instrument_id"`
	Protocol        string          `json:"protocol"`
	Kind            string          `json:"kind"`
	RawBase64       string          `json:"raw_base64"`
	RawSHA256       string          `json:"raw_sha256"`
	CapturedAtAgent string          `json:"captured_at_agent"`
	ClockOffsetMs   int64           `json:"clock_offset_ms"`
	LinkMeta        json.RawMessage `json:"link_meta,omitempty"`
}

// BuildBatch takes the oldest-captured items that fit in <=100 messages and <=3 MiB of JSON.
// The message offset is the one stored at capture; offsetMs is the current estimate for the envelope.
func BuildBatch(items []Item, sentAt time.Time, offsetMs int64) (Batch, error) {
	if len(items) == 0 {
		return Batch{}, nil
	}
	sorted := append([]Item(nil), items...)
	sort.SliceStable(sorted, func(i, j int) bool { return sorted[i].CapturedAtAgent.Before(sorted[j].CapturedAtAgent) })

	head, _ := json.Marshal(struct {
		S string `json:"sent_at_agent"`
		O int64  `json:"clock_offset_ms"`
	}{sentAt.UTC().Format(isoUTC), offsetMs})
	body := append(head[:len(head)-1], `,"messages":[`...) // drop the closing brace

	n := 0
	for n < len(sorted) && n < MaxBatchMessages {
		it := sorted[n]
		m, err := json.Marshal(wireMessage{it.ID, it.InstrumentID, it.Protocol, it.Kind, base64.StdEncoding.EncodeToString(it.Raw),
			it.RawSHA256, it.CapturedAtAgent.UTC().Format(isoUTC), it.ClockOffsetMs, it.LinkMeta})
		if err != nil {
			return Batch{}, err
		}
		add := len(m)
		if n > 0 {
			add++
		}
		if len(body)+add+len(batchTail) > MaxBatchBytes {
			break
		}
		if n > 0 {
			body = append(body, ',')
		}
		body = append(body, m...)
		n++
	}
	if n == 0 {
		return Batch{}, ErrItemTooLarge
	}
	return Batch{Body: append(body, batchTail...), Items: sorted[:n], Rest: sorted[n:]}, nil
}
