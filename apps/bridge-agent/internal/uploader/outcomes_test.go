package uploader_test

import (
	"context"
	"errors"
	"regexp"
	"testing"
	"time"

	"lims/apps/bridge-agent/internal/clock"
	"lims/apps/bridge-agent/internal/uploader"
)

var uuidv7 = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

type rig struct {
	store *fakeStore
	sub   *fakeSubmitter
	fc    *fakeClock
	up    *uploader.Uploader
	est   *clock.Estimator
}

func newRig(items []uploader.Item, budget *uploader.RateBudget, script ...func(call) (uploader.BatchResult, error)) *rig {
	r := &rig{store: newStore(items...), sub: &fakeSubmitter{script: script}, fc: &fakeClock{t: t0}, est: clock.NewEstimator()}
	r.up = uploader.New(uploader.Options{
		Store: r.store, Client: r.sub, Budget: budget, Backoff: uploader.NewBackoff(mid),
		Now: r.fc.Now, Clock: r.est,
	})
	return r
}

func items(n int) []uploader.Item {
	var out []uploader.Item
	for i := 1; i <= n; i++ {
		out = append(out, mkItem(i, 20))
	}
	return out
}

func tick(t *testing.T, r *rig) uploader.TickResult {
	t.Helper()
	res, err := r.up.Tick(context.Background())
	if err != nil {
		t.Fatalf("Tick: %v", err)
	}
	return res
}

// AC-08.1: a tick sends <=100 items with an Idempotency-Key; items are in flight (uploading) while the call runs.
func TestTick_SendsBatchOfAtMostHundredWithIdempotencyKey(t *testing.T) {
	r := newRig(items(130), nil, answer("accepted"))
	res := tick(t, r)
	if res.Submitted != 100 || r.sub.n() != 1 {
		t.Fatalf("submitted=%d calls=%d", res.Submitted, r.sub.n())
	}
	if k := r.sub.calls[0].key; !uuidv7.MatchString(k) {
		t.Fatalf("Idempotency-Key %q is not a UUIDv7", k)
	}
	if r.store.count("uploaded") != 100 || r.store.count("pending") != 30 {
		t.Fatalf("uploaded=%d pending=%d", r.store.count("uploaded"), r.store.count("pending"))
	}
	tick(t, r)
	if r.sub.calls[0].key == r.sub.calls[1].key {
		t.Fatal("a new batch must get a new Idempotency-Key")
	}
}

// Byte-capped leftovers go back to pending untouched (not a failure: no error code, no attempt counted).
func TestTick_ByteCapLeftoversReturnToPending(t *testing.T) {
	big := []uploader.Item{mkItem(1, 1<<20), mkItem(2, 1<<20), mkItem(3, 1<<20)}
	r := newRig(big, nil, answer("accepted"))
	res := tick(t, r)
	if res.Submitted != 2 || len(r.sub.calls[0].body) > 3<<20 {
		t.Fatalf("submitted=%d body=%d", res.Submitted, len(r.sub.calls[0].body))
	}
	if st := r.store.row(big[2].ID); st.state != "pending" || st.it.Attempts != 0 || st.err != "" {
		t.Fatalf("leftover row %+v", st)
	}
	if r.store.count("uploading") != 0 {
		t.Fatal("nothing may stay uploading after a tick")
	}
}

func TestTick_NothingPending(t *testing.T) {
	r := newRig(nil, nil, answer("accepted"))
	if res := tick(t, r); res.Skipped != "empty" || r.sub.n() != 0 {
		t.Fatalf("res=%+v calls=%d", res, r.sub.n())
	}
}

// AC-08.3: accepted / duplicate / quarantined -> uploaded; rejected -> rejected (+config version); retry -> pending with backoff.
func TestTick_OutcomeMapping(t *testing.T) {
	its := items(6)
	mixed := func(c call) (uploader.BatchResult, error) {
		outs := []string{"accepted", "duplicate", "quarantined", "rejected", "retry", "accepted"}
		r := uploader.BatchResult{ServerTime: t0}
		for i, m := range c.wire().Messages {
			mr := uploader.MessageResult{AgentMessageID: m.AgentMessageID, Outcome: outs[i], InstrumentMessageID: "srv-" + m.AgentMessageID}
			if outs[i] == "rejected" {
				mr.ErrorCode = "instruments.message_malformed"
			}
			if outs[i] == "retry" {
				mr.ErrorCode = "common.try_later"
			}
			r.Results = append(r.Results, mr)
		}
		return r, nil
	}
	r := newRig(its, nil, mixed)
	r.up.SetConfigVersion(7)
	tick(t, r)
	for i, want := range []string{"uploaded", "uploaded", "uploaded", "rejected", "pending", "uploaded"} {
		if got := r.store.state(its[i].ID); got != want {
			t.Errorf("item %d (%s): %s, want %s", i+1, []string{"accepted", "duplicate", "quarantined", "rejected", "retry", "accepted"}[i], got, want)
		}
	}
	up := r.store.row(its[0].ID).res
	if up.ServerMessageID != "srv-"+its[0].ID || !up.UploadedAt.Equal(t0) {
		t.Errorf("uploaded resolution %+v", up)
	}
	rej := r.store.row(its[3].ID).res
	if rej.RejectedConfigVersion != 7 || rej.ErrorCode != "instruments.message_malformed" {
		t.Errorf("rejected resolution %+v", rej)
	}
	retry := r.store.row(its[4].ID)
	if !retry.next.Equal(t0.Add(time.Second)) || retry.err != "common.try_later" {
		t.Errorf("retry item: next=%v err=%q, want now+1s (first backoff step)", retry.next, retry.err)
	}
	// not picked up again before its backoff expires
	if res := tick(t, r); res.Skipped != "empty" {
		t.Errorf("retry item re-sent too early: %+v", res)
	}
	r.fc.Advance(time.Second)
	if res := tick(t, r); res.Submitted != 1 {
		t.Errorf("retry item not re-sent after backoff: %+v", res)
	}
}

func TestTick_RetryBackoffGrowsWithAttempts(t *testing.T) {
	its := items(1)
	r := newRig(its, nil, func(c call) (uploader.BatchResult, error) {
		m := c.wire().Messages[0]
		return uploader.BatchResult{ServerTime: t0, Results: []uploader.MessageResult{{AgentMessageID: m.AgentMessageID, Outcome: "retry"}}}, nil
	})
	var gaps []time.Duration
	for i := 0; i < 3; i++ {
		before := r.fc.Now()
		tick(t, r)
		gaps = append(gaps, r.store.row(its[0].ID).next.Sub(before))
		r.fc.Advance(gaps[i])
	}
	if gaps[0] != time.Second || gaps[1] != 2*time.Second || gaps[2] != 4*time.Second {
		t.Fatalf("per-item retry delays %v, want 1s,2s,4s", gaps)
	}
}

// Rejected items are retried only when the applied config version changes (store does the "once"; uploader must call it
// on every increase and never otherwise).
func TestSetConfigVersion_RequeuesRejectedOnlyOnIncrease(t *testing.T) {
	r := newRig(nil, nil, answer("accepted"))
	r.up.SetConfigVersion(3)
	r.up.SetConfigVersion(3)
	r.up.SetConfigVersion(2) // rollback is not an increase
	r.up.SetConfigVersion(4)
	if got := r.store.requeued; len(got) != 2 || got[0] != 3 || got[1] != 4 {
		t.Fatalf("RequeueRejected calls %v, want [3 4]", got)
	}
}

// AC-08.2: network failure / 5xx / 429 -> exponential backoff for the whole uploader; items stay pending, nothing is lost.
func TestTick_FailureBacksOffAndKeepsItems(t *testing.T) {
	for name, err := range map[string]error{
		"network": errors.New("dial tcp: connection refused"),
		"500":     &uploader.HTTPError{Status: 500},
		"503":     &uploader.HTTPError{Status: 503},
		"429":     &uploader.HTTPError{Status: 429},
	} {
		t.Run(name, func(t *testing.T) {
			r := newRig(items(3), nil, fail(err), fail(err), fail(err), answer("accepted"))
			tick(t, r) // fail #1 -> wait 1 s
			if r.store.count("pending") != 3 || r.store.count("uploading") != 0 {
				t.Fatalf("pending=%d uploading=%d", r.store.count("pending"), r.store.count("uploading"))
			}
			r.fc.Advance(500 * time.Millisecond)
			if res := tick(t, r); res.Skipped != "backoff" || r.sub.n() != 1 {
				t.Fatalf("called during backoff: %+v calls=%d", res, r.sub.n())
			}
			r.fc.Advance(500 * time.Millisecond)
			tick(t, r) // fail #2 -> wait 2 s
			r.fc.Advance(1999 * time.Millisecond)
			if res := tick(t, r); res.Skipped != "backoff" {
				t.Fatalf("second backoff step must be 2 s: %+v", res)
			}
			r.fc.Advance(time.Millisecond)
			tick(t, r) // fail #3 -> wait 4 s
			r.fc.Advance(4 * time.Second)
			if res := tick(t, r); res.Submitted != 3 {
				t.Fatalf("recovered tick: %+v", res)
			}
			// success resets the backoff
			r2 := newRig(items(2), nil, fail(err), answer("accepted"), fail(err))
			tick(t, r2)
			r2.fc.Advance(time.Second)
			tick(t, r2)
			r2.store.add(mkItem(99, 5))
			tick(t, r2) // fails again: first step is 1 s again, not 2 s / 4 s
			r2.fc.Advance(time.Second)
			if res := tick(t, r2); res.Skipped == "backoff" {
				t.Fatal("backoff did not reset after a success")
			}
		})
	}
}

// AC-08.2: Retry-After honoured (429 and 503), also beyond the 5 min cap.
func TestTick_RetryAfterHonoured(t *testing.T) {
	for _, secs := range []int{30, 600} {
		r := newRig(items(1), nil, fail(&uploader.HTTPError{Status: 429, RetryAfter: time.Duration(secs) * time.Second}), answer("accepted"))
		tick(t, r)
		r.fc.Advance(time.Duration(secs)*time.Second - time.Millisecond)
		if res := tick(t, r); res.Skipped != "backoff" || r.sub.n() != 1 {
			t.Fatalf("Retry-After %d s not honoured: %+v", secs, res)
		}
		r.fc.Advance(time.Millisecond)
		if res := tick(t, r); res.Submitted != 1 {
			t.Fatalf("not resumed after Retry-After %d s: %+v", secs, res)
		}
	}
}

// TRD 5.7 Idempotency: the same key is reused when the same batch is retried unchanged; a changed batch gets a new key.
func TestTick_SameBatchRetriedReusesIdempotencyKey(t *testing.T) {
	r := newRig(items(3), nil, fail(&uploader.HTTPError{Status: 503}), fail(errors.New("timeout")), answer("accepted"))
	tick(t, r)
	r.fc.Advance(time.Second)
	tick(t, r)
	r.fc.Advance(2 * time.Second)
	tick(t, r)
	if r.sub.n() != 3 || r.sub.calls[0].key != r.sub.calls[1].key || r.sub.calls[1].key != r.sub.calls[2].key {
		t.Fatalf("keys across retries: %v", []string{r.sub.calls[0].key, r.sub.calls[1].key, r.sub.calls[2].key})
	}
	if string(r.sub.calls[0].body) == "" || len(r.sub.calls[0].body) == 0 {
		t.Fatal("empty body")
	}
}

func TestTick_ChangedBatchGetsNewIdempotencyKey(t *testing.T) {
	r := newRig(items(2), nil, fail(&uploader.HTTPError{Status: 503}), answer("accepted"))
	tick(t, r)
	// an older message arrives while the first batch is waiting: the next batch is not the same batch
	older := mkItem(0, 20)
	r.store.add(older)
	r.fc.Advance(time.Second)
	tick(t, r)
	if r.sub.calls[0].key == r.sub.calls[1].key {
		t.Fatal("different batch content must not reuse the Idempotency-Key")
	}
}

// AC-08 / done_when: 401 stops uploads; data stays pending; no further calls until re-enrolment.
func TestTick_401StopsAllUploads(t *testing.T) {
	r := newRig(items(5), nil, fail(&uploader.HTTPError{Status: 401, Code: "auth.device_token_invalid"}), answer("accepted"))
	tick(t, r)
	if r.up.AuthState() != "rejected" {
		t.Fatalf("auth_state %q, want rejected", r.up.AuthState())
	}
	if r.store.count("pending") != 5 || r.store.count("uploading") != 0 || r.store.count("rejected") != 0 {
		t.Fatalf("items must stay pending: pending=%d", r.store.count("pending"))
	}
	for i := 0; i < 5; i++ {
		r.fc.Advance(10 * time.Minute)
		if res := tick(t, r); res.Skipped != "auth_rejected" {
			t.Fatalf("tick %d after 401: %+v", i, res)
		}
	}
	if r.sub.n() != 1 {
		t.Fatalf("%d calls after 401, want exactly the one that was rejected", r.sub.n())
	}
	r.up.ClearAuthRejected() // after re-enrolment / token replaced
	if r.up.AuthState() != "ok" {
		t.Fatal("auth_state not cleared")
	}
	if res := tick(t, r); res.Submitted != 5 {
		t.Fatalf("uploads must resume after ClearAuthRejected: %+v", res)
	}
}

func TestTick_401IsNotTreatedAsBackoffOrRetry(t *testing.T) {
	r := newRig(items(1), nil, fail(&uploader.HTTPError{Status: 401}))
	tick(t, r)
	if r.store.row(items(1)[0].ID).it.Attempts != 0 {
		t.Fatal("401 must not burn the item's attempts")
	}
}

// TRD 5.7 request budget: no budget token -> no request, items untouched.
func TestTick_RespectsRateBudget(t *testing.T) {
	fc := &fakeClock{t: t0}
	rb := uploader.NewRateBudget(fc.Now)
	for rb.Allow(uploader.ClassUpload) {
	}
	r := newRig(items(2), rb, answer("accepted"))
	r.fc = fc
	r.up = uploader.New(uploader.Options{Store: r.store, Client: r.sub, Budget: rb, Backoff: uploader.NewBackoff(mid), Now: fc.Now})
	if res := tick(t, r); res.Skipped != "rate_budget" || r.sub.n() != 0 || r.store.count("pending") != 2 {
		t.Fatalf("res=%+v calls=%d pending=%d", res, r.sub.n(), r.store.count("pending"))
	}
	fc.Advance(2 * time.Second)
	if res := tick(t, r); res.Submitted != 2 {
		t.Fatalf("after refill: %+v", res)
	}
}

// AC-14.1: the agent estimates its offset from every successful response, and the batch envelope reports it.
func TestTick_FeedsClockEstimatorAndReportsOffset(t *testing.T) {
	r := newRig(items(1), nil, func(c call) (uploader.BatchResult, error) {
		res, _ := answer("accepted")(c)
		res.TSend, res.TRecv, res.ServerTime = t0, t0.Add(200*time.Millisecond), t0.Add(5100*time.Millisecond)
		return res, nil
	}, answer("accepted"))
	tick(t, r)
	off, unc, ok := r.est.Current(r.fc.Now())
	if !ok || off != 5000 || unc != 100 {
		t.Fatalf("estimator after first call: off=%d unc=%d ok=%v", off, unc, ok)
	}
	r.store.add(mkItem(50, 5))
	tick(t, r)
	if w := r.sub.calls[1].wire(); w.ClockOffsetMs != 5000 {
		t.Fatalf("envelope clock_offset_ms = %d, want 5000", w.ClockOffsetMs)
	}
}

// AC-14.2: message offset is the one stored at capture, even when the current estimate differs.
func TestTick_MessageKeepsCaptureTimeOffset(t *testing.T) {
	r := newRig(items(1), nil, answer("accepted"))
	r.est.Observe(t0, t0.Add(100*time.Millisecond), t0.Add(7050*time.Millisecond)) // current = 7000
	tick(t, r)
	w := r.sub.calls[0].wire()
	if w.ClockOffsetMs != 7000 || w.Messages[0].ClockOffsetMs != 1 {
		t.Fatalf("envelope=%d message=%d, want 7000 / the item's own 1", w.ClockOffsetMs, w.Messages[0].ClockOffsetMs)
	}
}

// A result for an id we never sent, or a missing result, must not mark anything uploaded by accident.
func TestTick_UnknownOrMissingResultsNeverMarkUploaded(t *testing.T) {
	its := items(2)
	r := newRig(its, nil, func(c call) (uploader.BatchResult, error) {
		return uploader.BatchResult{ServerTime: t0, Results: []uploader.MessageResult{
			{AgentMessageID: "not-ours", Outcome: "accepted"},
			{AgentMessageID: its[0].ID, Outcome: "who-knows"},
		}}, nil
	})
	tick(t, r)
	if r.store.count("uploaded") != 0 || r.store.count("uploading") != 0 {
		t.Fatalf("uploaded=%d uploading=%d: unknown outcome, unknown id and missing result must all end pending", r.store.count("uploaded"), r.store.count("uploading"))
	}
}
