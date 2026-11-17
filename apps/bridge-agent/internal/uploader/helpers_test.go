package uploader_test

// AG-T10 tester: this file fixes the Go API the implementation must provide (names are the tester's;
// the spec fixes only files and TRD 5.7 / 5.9 behaviour). Package lims/apps/bridge-agent/internal/uploader:
//
//	const MaxBatchMessages = 100; MaxBatchBytes = 3 << 20; var ErrItemTooLarge, ErrUnauthorized error
//	type Item struct { ID, InstrumentID, Kind, Protocol string; Raw []byte; RawSHA256 string
//	    CapturedAtAgent time.Time; ClockOffsetMs int64; LinkMeta json.RawMessage; Attempts int }
//	type Batch struct { Body []byte; Items, Rest []Item }
//	func BuildBatch(items []Item, sentAt time.Time, offsetMs int64) (Batch, error)
//	type Backoff; func NewBackoff(rnd func() float64) Backoff; func (Backoff) Delay(attempt int, retryAfter time.Duration) time.Duration
//	func ParseRetryAfter(h string, now time.Time) (time.Duration, bool)
//	type Class; ClassUpload, ClassHostQuery, ClassHeartbeat; func NewRateBudget(now func() time.Time) *RateBudget; (*RateBudget).Allow(Class) bool
//	type Store interface { Claim(now time.Time, limit int) ([]Item, error); Release(ids []string, next time.Time, errCode string) error;
//	    Resolve(Resolution) error; RequeueRejected(appliedConfigVersion int) (int, error) }
//	type Resolution struct { ID, State, ServerMessageID, ErrorCode string; NextAttempt, UploadedAt time.Time; RejectedConfigVersion int }
//	type Submitter interface { SubmitBatch(ctx context.Context, idemKey string, body []byte) (BatchResult, error) }
//	type BatchResult struct { Results []MessageResult; ServerTime, TSend, TRecv time.Time }
//	type MessageResult struct { AgentMessageID, Outcome, InstrumentMessageID, ErrorCode string }
//	type HTTPError struct { Status int; Code string; RetryAfter time.Duration }  // errors.Is(err, ErrUnauthorized) when Status==401
//	type Options struct { Store Store; Client Submitter; Budget *RateBudget; Backoff Backoff; Now func() time.Time; Clock *clock.Estimator; NewKey func() string }
//	func New(Options) *Uploader; (*Uploader).Tick(ctx) (TickResult, error); .AuthState() string ("ok"|"rejected"); .ClearAuthRejected(); .SetConfigVersion(int)
//	type TickResult struct { Submitted int; Skipped string }  // Skipped: ""|"empty"|"backoff"|"auth_rejected"|"rate_budget"
//	type Config struct { BaseURL string; Token func() string; ProxyURL string; RootCAs *x509.CertPool; SPKIPins []string /*hex sha256 of SPKI*/; Timeout time.Duration }
//	func NewClient(Config) (*Client, error); (*Client).SubmitBatch(ctx, idemKey string, body []byte) (BatchResult, error)
//
// Package lims/apps/bridge-agent/internal/clock:
//	func Compute(tSend, tRecv, serverTime time.Time) (offsetMs, uncertaintyMs int64)
//	func NewEstimator() *Estimator; Observe(tSend, tRecv, serverTime time.Time); Current(now time.Time) (offsetMs, uncertaintyMs int64, ok bool)

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"sync"
	"time"

	"lims/apps/bridge-agent/internal/uploader"
)

var t0 = time.Date(2026, 11, 6, 4, 0, 0, 0, time.UTC)

func mkItem(i int, rawLen int) uploader.Item {
	return uploader.Item{
		ID:              fmt.Sprintf("01a1a98a-ac40-7000-8000-%012d", i),
		InstrumentID:    "01a1a98a-ac40-7000-8000-0000000e0001",
		Kind:            "data",
		Protocol:        "astm",
		Raw:             make([]byte, rawLen),
		RawSHA256:       fmt.Sprintf("%064x", i),
		CapturedAtAgent: t0.Add(time.Duration(i) * time.Second),
		ClockOffsetMs:   int64(i),
	}
}

type wireMessage struct {
	AgentMessageID  string `json:"agent_message_id"`
	InstrumentID    string `json:"instrument_id"`
	Protocol        string `json:"protocol"`
	Kind            string `json:"kind"`
	RawBase64       string `json:"raw_base64"`
	RawSHA256       string `json:"raw_sha256"`
	CapturedAtAgent string `json:"captured_at_agent"`
	ClockOffsetMs   int64  `json:"clock_offset_ms"`
}

type wireBatch struct {
	SentAtAgent   string        `json:"sent_at_agent"`
	ClockOffsetMs int64         `json:"clock_offset_ms"`
	Messages      []wireMessage `json:"messages"`
}

// fakeStore mimics the queue adapter: Claim returns due pending items oldest captured first and marks them uploading.
type fakeStore struct {
	mu       sync.Mutex
	items    map[string]*fakeRow
	requeued []int
}
type fakeRow struct {
	it    uploader.Item
	state string
	next  time.Time
	res   uploader.Resolution
	err   string
}

func newStore(items ...uploader.Item) *fakeStore {
	s := &fakeStore{items: map[string]*fakeRow{}}
	for _, it := range items {
		s.items[it.ID] = &fakeRow{it: it, state: "pending"}
	}
	return s
}

func (s *fakeStore) add(it uploader.Item) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.items[it.ID] = &fakeRow{it: it, state: "pending"}
}

func (s *fakeStore) Claim(now time.Time, limit int) ([]uploader.Item, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var due []*fakeRow
	for _, r := range s.items {
		if r.state == "pending" && !r.next.After(now) {
			due = append(due, r)
		}
	}
	sort.Slice(due, func(i, j int) bool { return due[i].it.CapturedAtAgent.Before(due[j].it.CapturedAtAgent) })
	if len(due) > limit {
		due = due[:limit]
	}
	out := make([]uploader.Item, 0, len(due))
	for _, r := range due {
		r.state = "uploading"
		out = append(out, r.it)
	}
	return out, nil
}

// Release returns items to pending; attempts only count when errCode != "" (a byte-cap leftover is not a failure).
func (s *fakeStore) Release(ids []string, next time.Time, errCode string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, id := range ids {
		r := s.items[id]
		r.state, r.next, r.err = "pending", next, errCode
		if errCode != "" {
			r.it.Attempts++
		}
	}
	return nil
}

func (s *fakeStore) Resolve(res uploader.Resolution) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	r := s.items[res.ID]
	r.state, r.res, r.err, r.next = res.State, res, res.ErrorCode, res.NextAttempt
	if res.State == "pending" {
		r.it.Attempts++
	}
	return nil
}

func (s *fakeStore) RequeueRejected(v int) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.requeued = append(s.requeued, v)
	return 0, nil
}

func (s *fakeStore) state(id string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.items[id].state
}
func (s *fakeStore) row(id string) fakeRow {
	s.mu.Lock()
	defer s.mu.Unlock()
	return *s.items[id]
}
func (s *fakeStore) count(state string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := 0
	for _, r := range s.items {
		if r.state == state {
			n++
		}
	}
	return n
}

type call struct {
	key  string
	body []byte
}

func (c call) wire() wireBatch {
	var w wireBatch
	if err := json.Unmarshal(c.body, &w); err != nil {
		panic(err)
	}
	return w
}

// fakeSubmitter records calls and answers from a script (the last entry repeats).
type fakeSubmitter struct {
	mu     sync.Mutex
	calls  []call
	script []func(c call) (uploader.BatchResult, error)
}

func (f *fakeSubmitter) SubmitBatch(_ context.Context, key string, body []byte) (uploader.BatchResult, error) {
	f.mu.Lock()
	c := call{key, append([]byte(nil), body...)}
	f.calls = append(f.calls, c)
	i := len(f.calls) - 1
	if i >= len(f.script) {
		i = len(f.script) - 1
	}
	fn := f.script[i]
	f.mu.Unlock()
	return fn(c)
}
func (f *fakeSubmitter) n() int { f.mu.Lock(); defer f.mu.Unlock(); return len(f.calls) }

func answer(outcome string) func(call) (uploader.BatchResult, error) {
	return func(c call) (uploader.BatchResult, error) {
		r := uploader.BatchResult{ServerTime: t0}
		for _, m := range c.wire().Messages {
			r.Results = append(r.Results, uploader.MessageResult{AgentMessageID: m.AgentMessageID, Outcome: outcome, InstrumentMessageID: "srv-" + m.AgentMessageID})
		}
		return r, nil
	}
}
func fail(err error) func(call) (uploader.BatchResult, error) {
	return func(call) (uploader.BatchResult, error) { return uploader.BatchResult{}, err }
}

type fakeClock struct{ t time.Time }

func (c *fakeClock) Now() time.Time          { return c.t }
func (c *fakeClock) Advance(d time.Duration) { c.t = c.t.Add(d) }
