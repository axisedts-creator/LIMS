package uploader

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"sync"
	"time"

	"lims/apps/bridge-agent/internal/clock"
)

// Store is the uploader's view of the queue. Claim marks items uploading (oldest captured first, due only);
// Release returns them to pending (an attempt counts only when errCode != ""); Resolve records an outcome;
// RequeueRejected moves rejected items back to pending once for a newly applied config version.
type Store interface {
	Claim(now time.Time, limit int) ([]Item, error)
	Release(ids []string, next time.Time, errCode string) error
	Resolve(Resolution) error
	RequeueRejected(appliedConfigVersion int) (int, error)
}

// Resolution is the final (or retry) state of one item. State is "uploaded", "rejected" or "pending".
type Resolution struct {
	ID, State, ServerMessageID, ErrorCode string
	NextAttempt, UploadedAt               time.Time
	RejectedConfigVersion                 int
}

type Submitter interface {
	SubmitBatch(ctx context.Context, idemKey string, body []byte) (BatchResult, error)
}

// AttachmentSubmitter is an optional extension on Submitter for E06 multipart file_drop attachments.
type AttachmentSubmitter interface {
	SubmitAttachment(ctx context.Context, idemKey string, metadataJSON []byte, fileName string, fileBytes []byte) (AttachmentResult, error)
}

// Options: Store and Client are required; Budget, Clock may be nil; the rest default.
type Options struct {
	Store   Store
	Client  Submitter
	Budget  *RateBudget
	Backoff Backoff
	Now     func() time.Time
	Clock   *clock.Estimator
	NewKey  func() string
}

type TickResult struct {
	Submitted int
	Skipped   string // "", "empty", "backoff", "auth_rejected", "rate_budget"
}

const codeTooLarge = "instruments.message_too_large" // same code the server uses for >1 MiB (AC-09.10)

// Uploader runs one upload attempt per Tick; the caller owns the cadence.
type Uploader struct {
	o      Options
	tickMu sync.Mutex // serialises Tick

	mu          sync.Mutex // guards the fields below
	auth        string
	failures    int
	notBefore   time.Time
	cfgVer      int
	requeuedVer int
	maxMsgs     int
	maxBytes    int
	// last failed batch, resent byte-identical under the same key
	pendKey string
	pendIDs []string
	pendBod []byte
}

func New(o Options) *Uploader {
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.NewKey == nil {
		now := o.Now
		o.NewKey = func() string { return newUUIDv7(now()) }
	}
	return &Uploader{o: o, auth: "ok"}
}

func (u *Uploader) AuthState() string {
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.auth
}

// ClearAuthRejected resumes uploads after re-enrolment or a replaced token.
func (u *Uploader) ClearAuthRejected() {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.auth, u.failures, u.notBefore = "ok", 0, time.Time{}
}

// SetConfigVersion records the applied config version; an increase requeues rejected items.
func (u *Uploader) SetConfigVersion(v int) {
	u.mu.Lock()
	u.cfgVer = v
	again := v > u.requeuedVer
	u.mu.Unlock()
	if !again {
		return
	}
	if _, err := u.o.Store.RequeueRejected(v); err == nil { // on error stay eligible for the next call
		u.mu.Lock()
		u.requeuedVer = max(u.requeuedVer, v)
		u.mu.Unlock()
	}
}

func ids(items []Item) []string {
	out := make([]string, len(items))
	for i, it := range items {
		out[i] = it.ID
	}
	return out
}

// SetBatchLimits configures runtime upload batch caps (0 uses package defaults).
func (u *Uploader) SetBatchLimits(msgs, bytes int) {
	u.mu.Lock()
	u.maxMsgs = msgs
	u.maxBytes = bytes
	u.mu.Unlock()
}

func (u *Uploader) batchLimits() (int, int) {
	u.mu.Lock()
	m, b := u.maxMsgs, u.maxBytes
	u.mu.Unlock()
	if m <= 0 || m > MaxBatchMessages {
		m = MaxBatchMessages
	}
	if b <= 0 || b > MaxBatchBytes {
		b = MaxBatchBytes
	}
	return m, b
}

// Tick sends at most one batch.
func (u *Uploader) Tick(ctx context.Context) (TickResult, error) {
	u.tickMu.Lock()
	defer u.tickMu.Unlock()
	now := u.o.Now()

	u.mu.Lock()
	auth, wait, cfgVer := u.auth, u.notBefore, u.cfgVer
	u.mu.Unlock()
	if auth != "ok" {
		return TickResult{Skipped: "auth_rejected"}, nil
	}
	if now.Before(wait) {
		return TickResult{Skipped: "backoff"}, nil
	}

	maxMsgs, maxBytes := u.batchLimits()
	claimed, err := u.o.Store.Claim(now, maxMsgs)
	if err != nil {
		return TickResult{}, err
	}
	if len(claimed) == 0 {
		return TickResult{Skipped: "empty"}, nil
	}
	// Route attachment items exclusively to E06 (/attachments), never into E04 /message-batches.
	if claimed[0].Kind == "attachment" {
		if len(claimed) > 1 {
			_ = u.o.Store.Release(ids(claimed[1:]), now, "")
		}
		return u.tickAttachment(ctx, claimed[0], now, cfgVer)
	}
	var batchItems, releaseAtt []Item
	for _, it := range claimed {
		if it.Kind == "attachment" {
			releaseAtt = append(releaseAtt, it)
		} else {
			batchItems = append(batchItems, it)
		}
	}
	if len(releaseAtt) > 0 {
		if err := u.o.Store.Release(ids(releaseAtt), now, ""); err != nil {
			return TickResult{}, errors.Join(err, u.o.Store.Release(ids(batchItems), now, ""))
		}
	}
	claimed = batchItems
	if len(claimed) == 0 {
		return TickResult{Skipped: "empty"}, nil
	}
	if u.o.Budget != nil && !u.o.Budget.Allow(ClassUpload) {
		return TickResult{Skipped: "rate_budget"}, u.o.Store.Release(ids(claimed), now, "")
	}

	var off int64
	if u.o.Clock != nil {
		off, _, _ = u.o.Clock.Current(now)
	}
	b, err := BuildBatchLimit(claimed, now, off, maxMsgs, maxBytes)
	if errors.Is(err, ErrItemTooLarge) {
		// The oldest item can never be sent; reject it locally so it does not block the queue head.
		oldest := slices.MinFunc(claimed, func(a, b Item) int { return a.CapturedAtAgent.Compare(b.CapturedAtAgent) })
		rest := ids(slices.DeleteFunc(slices.Clone(claimed), func(it Item) bool { return it.ID == oldest.ID }))
		return TickResult{}, errors.Join(
			u.o.Store.Resolve(Resolution{ID: oldest.ID, State: "rejected", ErrorCode: codeTooLarge, RejectedConfigVersion: cfgVer}),
			u.o.Store.Release(rest, now, ""))
	}
	if err != nil {
		return TickResult{}, errors.Join(err, u.o.Store.Release(ids(claimed), now, ""))
	}
	if len(b.Rest) > 0 { // byte-cap leftovers: not a failure
		if err := u.o.Store.Release(ids(b.Rest), now, ""); err != nil {
			return TickResult{}, errors.Join(err, u.o.Store.Release(ids(b.Items), now, ""))
		}
	}

	sentIDs := ids(b.Items)
	key, body := u.batchKey(sentIDs, b.Body)
	res, err := u.o.Client.SubmitBatch(ctx, key, body)
	if err != nil {
		return TickResult{}, u.onFailure(err, b.Items, now)
	}

	u.mu.Lock()
	u.failures, u.notBefore, u.pendKey, u.pendIDs, u.pendBod = 0, time.Time{}, "", nil, nil
	u.mu.Unlock()
	if u.o.Clock != nil && !res.TSend.IsZero() {
		u.o.Clock.Observe(res.TSend, res.TRecv, res.ServerTime)
	}
	return TickResult{Submitted: len(b.Items)}, u.resolve(b.Items, res, now, cfgVer)
}

// batchKey reuses the previous key and body when the very same items are being retried.
func (u *Uploader) batchKey(sentIDs []string, body []byte) (string, []byte) {
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.pendKey == "" || !slices.Equal(u.pendIDs, sentIDs) {
		u.pendKey, u.pendIDs, u.pendBod = u.o.NewKey(), sentIDs, body
	}
	return u.pendKey, u.pendBod
}

func (u *Uploader) onFailure(err error, items []Item, now time.Time) error {
	if errors.Is(err, ErrUnauthorized) {
		u.mu.Lock()
		u.auth = "rejected"
		u.mu.Unlock()
		return u.o.Store.Release(ids(items), now, "") // data stays pending, no attempt burned
	}
	code, ra := "network_error", time.Duration(0)
	var he *HTTPError
	if errors.As(err, &he) {
		code, ra = fmt.Sprintf("http_%d", he.Status), he.RetryAfter
	}
	u.mu.Lock()
	d := u.o.Backoff.Delay(u.failures, ra)
	u.failures++
	u.notBefore = now.Add(d)
	next := u.notBefore
	u.mu.Unlock()
	return u.o.Store.Release(ids(items), next, code)
}

func (u *Uploader) tickAttachment(ctx context.Context, it Item, now time.Time, cfgVer int) (TickResult, error) {
	attCli, ok := u.o.Client.(AttachmentSubmitter)
	if !ok {
		return TickResult{}, u.o.Store.Release([]string{it.ID}, now, "attachments_unsupported")
	}
	if u.o.Budget != nil && !u.o.Budget.Allow(ClassUpload) {
		return TickResult{Skipped: "rate_budget"}, u.o.Store.Release([]string{it.ID}, now, "")
	}
	var src struct {
		FileName string `json:"file_name"`
		MTime    string `json:"mtime"`
		Size     int64  `json:"size"`
		Barcode  string `json:"barcode,omitempty"`
	}
	_ = json.Unmarshal(it.LinkMeta, &src)
	if src.FileName == "" {
		src.FileName = "attachment.bin"
	}
	if src.Size == 0 {
		src.Size = int64(len(it.Raw))
	}
	metaObj := map[string]any{
		"agent_message_id":  it.ID,
		"instrument_id":     it.InstrumentID,
		"file_name":         src.FileName,
		"file_sha256":       it.RawSHA256,
		"file_size":         src.Size,
		"file_mtime_agent":  src.MTime,
		"captured_at_agent": it.CapturedAtAgent.UTC().Format(isoUTC),
		"clock_offset_ms":   it.ClockOffsetMs,
	}
	if src.MTime == "" {
		metaObj["file_mtime_agent"] = it.CapturedAtAgent.UTC().Format(isoUTC)
	}
	if src.Barcode != "" {
		metaObj["barcode"] = src.Barcode
	}
	metaJSON, err := json.Marshal(metaObj)
	if err != nil {
		return TickResult{}, u.o.Store.Release([]string{it.ID}, now, "attachment_meta_error")
	}
	key, _ := u.batchKey([]string{it.ID}, metaJSON)
	res, err := attCli.SubmitAttachment(ctx, key, metaJSON, src.FileName, it.Raw)
	if err != nil {
		var he *HTTPError
		if errors.As(err, &he) && (he.Status == http.StatusBadRequest || he.Status == http.StatusRequestEntityTooLarge ||
			he.Status == http.StatusUnsupportedMediaType || he.Status == http.StatusUnprocessableEntity) {
			u.mu.Lock()
			u.failures, u.notBefore, u.pendKey, u.pendIDs, u.pendBod = 0, time.Time{}, "", nil, nil
			u.mu.Unlock()
			code := he.Code
			if code == "" {
				code = fmt.Sprintf("http_%d", he.Status)
			}
			return TickResult{Submitted: 1}, u.o.Store.Resolve(Resolution{
				ID: it.ID, State: "rejected", ErrorCode: code, RejectedConfigVersion: cfgVer,
			})
		}
		return TickResult{}, u.onFailure(err, []Item{it}, now)
	}
	u.mu.Lock()
	u.failures, u.notBefore, u.pendKey, u.pendIDs, u.pendBod = 0, time.Time{}, "", nil, nil
	u.mu.Unlock()
	return TickResult{Submitted: 1}, u.o.Store.Resolve(Resolution{
		ID: it.ID, State: "uploaded", ServerMessageID: res.InstrumentMessageID, UploadedAt: now,
	})
}

// resolve maps per-message outcomes (AC-08.3). Anything unknown or missing goes back to pending with backoff.
func (u *Uploader) resolve(items []Item, res BatchResult, now time.Time, cfgVer int) error {
	byID := make(map[string]MessageResult, len(res.Results))
	for _, r := range res.Results {
		byID[r.AgentMessageID] = r
	}
	var errs []error
	for _, it := range items {
		r, found := byID[it.ID]
		out := Resolution{ID: it.ID}
		switch {
		case found && (r.Outcome == "accepted" || r.Outcome == "duplicate" || r.Outcome == "quarantined"):
			out.State, out.ServerMessageID, out.UploadedAt = "uploaded", r.InstrumentMessageID, now
		case found && r.Outcome == "rejected":
			out.State, out.ErrorCode, out.RejectedConfigVersion = "rejected", r.ErrorCode, cfgVer
		default: // "retry", an unknown outcome, or no result at all
			out.State, out.ErrorCode = "pending", r.ErrorCode
			if out.ErrorCode == "" {
				out.ErrorCode = "result_" + map[bool]string{true: "unknown", false: "missing"}[found]
			}
			out.NextAttempt = now.Add(u.o.Backoff.Delay(it.Attempts, 0))
		}
		if err := u.o.Store.Resolve(out); err != nil {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

// newUUIDv7 is RFC 9562 UUIDv7: 48-bit ms timestamp, version 7, variant 10, 74 random bits.
func newUUIDv7(t time.Time) string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err) // crypto/rand does not fail on supported platforms
	}
	ms := uint64(t.UnixMilli())
	for i := 0; i < 6; i++ {
		b[i] = byte(ms >> (40 - 8*i))
	}
	b[6] = b[6]&0x0f | 0x70
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}
