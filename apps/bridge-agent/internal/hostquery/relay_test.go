package hostquery_test

import (
	"bytes"
	"context"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"lims/apps/bridge-agent/internal/hostquery"
	"lims/apps/bridge-agent/internal/uploader"
)

func httpErr(status int, code string) error { return &uploader.HTTPError{Status: status, Code: code} }

// ---- AC-10.3: 200 -> replies are queued for the link layer, verbatim and in order ----------------------------------

func TestRelay_200EnqueuesEveryReplyVerbatimInOrder(t *testing.T) {
	r := newRig(t)
	r.snd.resp = ok("REPLY-1\r", "REPLY-2\r", "REPLY-3\r")
	if got := r.handle(query(itemA)); got != hostquery.OutcomeReplied {
		t.Fatalf("outcome = %q, want replied", got)
	}
	if r.out.n() != 3 {
		t.Fatalf("enqueued %d replies, want 3", r.out.n())
	}
	for i, want := range []string{"REPLY-1\r", "REPLY-2\r", "REPLY-3\r"} {
		m := r.out.msgs[i]
		if string(m.msg) != want || m.inst != instID {
			t.Errorf("reply %d = %q for %q, want %q for %q", i, m.msg, m.inst, want, instID)
		}
	}
	if r.rel.Unavailable() != 0 {
		t.Error("a served query must not count as host_query_unavailable")
	}
}

func TestRelay_RequestCarriesTheQueryAndItemIDAsAgentMessageID(t *testing.T) {
	r := newRig(t)
	r.handle(query(itemA))
	if r.snd.n() != 1 {
		t.Fatalf("E05 called %d times, want 1", r.snd.n())
	}
	c := r.snd.calls[0]
	if c.req.AgentMessageID != itemA { // same id later uploaded as kind=host_query -> server dedupes (TRD 5.7 / 6.6)
		t.Errorf("agent_message_id = %q, want the queue item id %q", c.req.AgentMessageID, itemA)
	}
	if c.req.InstrumentID != instID || c.req.Protocol != "astm" || !bytes.Equal(c.req.Raw, astmQuery) ||
		!c.req.CapturedAt.Equal(t0) || c.req.ClockOffsetMs != -400 {
		t.Errorf("request fields wrong: %+v", c.req)
	}
	if c.key == "" {
		t.Error("Idempotency-Key is required on E05 (08 A13 P-8)")
	}
}

func TestRelay_RepliesExpireWhenTheInstrumentStopsWaiting(t *testing.T) {
	r := newRig(t)
	r.handle(query(itemA))
	if got := r.out.msgs[0].expires; !got.Equal(t0.Add(replyTTL)) {
		t.Errorf("expiresAt = %v, want captured_at + ReplyTimeout = %v (03-APP-FLOW 3.2 reply_expired)", got, t0.Add(replyTTL))
	}
}

func TestRelay_TimeoutIsReplyTimeoutMinusOneSecond(t *testing.T) {
	r := newRig(t)
	before := time.Now()
	r.handle(query(itemA)) // ReplyTimeout 30 s
	dl := r.snd.calls[0].deadline
	if dl.IsZero() {
		t.Fatal("E05 call has no deadline; a hung server would block the relay forever")
	}
	if d := dl.Sub(before); d < 28*time.Second || d > 29500*time.Millisecond {
		t.Errorf("deadline in %v, want about ReplyTimeout-1s = 29 s", d)
	}
}

func TestRelay_ReplyArrivingAfterTheInstrumentGaveUpIsNotQueued(t *testing.T) {
	r := newRig(t)
	r.snd.hook = func() { r.now = t0.Add(replyTTL + time.Second) } // server answered too late
	if got := r.handle(query(itemA)); got != hostquery.OutcomeExpired {
		t.Fatalf("outcome = %q, want expired", got)
	}
	if r.out.n() != 0 {
		t.Error("a stale reply must not be sent to an instrument that stopped waiting")
	}
	if !r.items.done(itemA) {
		t.Error("the server archived the query (200) so the item is uploaded")
	}
}

func TestRelay_200WithNoReplyMessagesSendsNothingButCompletesItem(t *testing.T) {
	r := newRig(t)
	r.snd.resp = ok()
	r.handle(query(itemA))
	if r.out.n() != 0 || !r.items.done(itemA) {
		t.Errorf("enqueued=%d uploaded=%v, want 0 and true", r.out.n(), r.items.done(itemA))
	}
}

// ---- TRD 5.7 single rule for the query item ---------------------------------------------------------------------

func TestRelay_200MarksItemUploadedWithServerMessageID(t *testing.T) {
	r := newRig(t)
	r.handle(query(itemA))
	if got := r.items.uploaded[itemA]; got != "0196a3c0-0000-7000-8000-0000000000ee" {
		t.Errorf("item not marked uploaded with instrument_message_id, got %q", got)
	}
}

func TestRelay_Other4xxSendsNoReplyAndMarksUploaded(t *testing.T) {
	cases := []struct {
		status int
		code   string
	}{
		{422, "instruments.capability_not_supported"}, // AC-10.4 as seen by the agent
		{404, "common.not_found"},
		{403, "instruments.device_mismatch"},
		{400, "common.validation_failed"},
	}
	for _, c := range cases {
		t.Run(fmt.Sprint(c.status), func(t *testing.T) {
			r := newRig(t)
			r.snd.err = httpErr(c.status, c.code)
			if got := r.handle(query(itemA)); got != hostquery.OutcomeNoReply {
				t.Errorf("outcome = %q, want no_reply", got)
			}
			if r.out.n() != 0 {
				t.Error("an invented reply was sent")
			}
			if !r.items.done(itemA) {
				t.Error("4xx other than 401/429: the server archived or rejected it, item becomes uploaded")
			}
			if !r.logs.has(c.code) {
				t.Errorf("server error code %q not logged (03-APP-FLOW 3.4 step 4); got %v", c.code, r.logs.codes)
			}
			if r.rel.Unavailable() != 0 {
				t.Error("the server answered; this is not host_query_unavailable")
			}
		})
	}
}

// ---- AC-10.6: server unreachable -> no invented reply, item stays pending ----------------------------------------------

func TestRelay_NoResponseSendsNoReplyAndKeepsItemPending(t *testing.T) {
	cases := map[string]error{
		"network error": errBoom,
		"timeout":       context.DeadlineExceeded,
		"500":           httpErr(500, "common.internal"),
		"503":           httpErr(503, ""),
		"429":           httpErr(429, "common.rate_limited"),
		"401":           httpErr(401, "auth.device_token_invalid"), // TRD 5.7 auth rule: stays pending
	}
	for name, e := range cases {
		t.Run(name, func(t *testing.T) {
			r := newRig(t)
			r.snd.err = e
			if got := r.handle(query(itemA)); got != hostquery.OutcomeUnavailable {
				t.Errorf("outcome = %q, want unavailable", got)
			}
			if r.out.n() != 0 {
				t.Error("agent sent a reply without a server answer (AC-10.6)")
			}
			if r.items.done(itemA) {
				t.Error("item must stay pending so it is uploaded later as kind=host_query")
			}
			if !r.logs.has("host_query_unavailable") || r.rel.Unavailable() != 1 {
				t.Errorf("host_query_unavailable not logged/counted: logs=%v counter=%d", r.logs.codes, r.rel.Unavailable())
			}
		})
	}
}

func TestRelay_AuthRejectedMakesNoCallAtAll(t *testing.T) {
	r := newRig(t)
	r.auth.state = "rejected"
	if got := r.handle(query(itemA)); got != hostquery.OutcomeUnavailable {
		t.Fatalf("outcome = %q, want unavailable", got)
	}
	if r.snd.n() != 0 {
		t.Error("with auth_state=rejected no request may be sent")
	}
	if r.out.n() != 0 || r.items.done(itemA) || r.rel.Unavailable() != 1 || !r.logs.has("host_query_unavailable") {
		t.Errorf("out=%d done=%v counter=%d logs=%v", r.out.n(), r.items.done(itemA), r.rel.Unavailable(), r.logs.codes)
	}
}

func TestRelay_RecentUnreachableServerFailsFastFor30Seconds(t *testing.T) {
	r := newRig(t)
	r.snd.err = errBoom
	r.handle(query(itemA))
	r.now = t0.Add(29 * time.Second)
	r.snd.err = nil
	if got := r.handle(query(itemB)); got != hostquery.OutcomeUnavailable {
		t.Errorf("within 30 s of an unreachable server: outcome = %q, want unavailable", got)
	}
	if r.snd.n() != 1 {
		t.Errorf("E05 called %d times, want 1 (no call inside the 30 s window)", r.snd.n())
	}
	if r.rel.Unavailable() != 2 {
		t.Errorf("counter = %d, want 2", r.rel.Unavailable())
	}
	// a probe after the window that fails again must re-arm the 30 s window (03-APP-FLOW 3.4 step 2)
	r.now = t0.Add(31 * time.Second)
	r.snd.err = errBoom
	if got := r.handle(query(itemB)); got != hostquery.OutcomeUnavailable {
		t.Errorf("failed probe after the window: outcome = %q, want unavailable", got)
	}
	if r.snd.n() != 2 {
		t.Fatalf("E05 called %d times, want 2 (one probe after the window)", r.snd.n())
	}
	r.snd.err = nil
	r.now = t0.Add(45 * time.Second)
	if got := r.handle(query(itemB)); got != hostquery.OutcomeUnavailable {
		t.Errorf("14 s after a failed probe: outcome = %q, want unavailable (window re-armed)", got)
	}
	if r.snd.n() != 2 {
		t.Errorf("E05 called %d times, want 2 (no call inside the re-armed window)", r.snd.n())
	}
	r.now = t0.Add(62 * time.Second)
	if got := r.handle(query(itemB)); got != hostquery.OutcomeReplied {
		t.Errorf("after the re-armed window the relay must try again, outcome = %q", got)
	}
}

func TestRelay_ExhaustedHostQueryBudgetMeansNoCallAndPendingItem(t *testing.T) {
	r := newRig(t)
	r.budget.allow = false
	if got := r.handle(query(itemA)); got != hostquery.OutcomeUnavailable {
		t.Errorf("outcome = %q, want unavailable", got)
	}
	if r.snd.n() != 0 || r.out.n() != 0 || r.items.done(itemA) {
		t.Errorf("calls=%d out=%d done=%v, want none", r.snd.n(), r.out.n(), r.items.done(itemA))
	}
	if len(r.budget.classes) == 0 || r.budget.classes[0] != uploader.ClassHostQuery {
		t.Errorf("budget class = %v, want the reserved ClassHostQuery (20/min)", r.budget.classes)
	}
}

func TestRelay_EnqueueFailureStillCompletesItemAndReportsNoReply(t *testing.T) {
	r := newRig(t)
	r.out.err = fmt.Errorf("disk full")
	if got := r.handle(query(itemA)); got == hostquery.OutcomeReplied {
		t.Error("outcome must not claim replied when nothing was queued")
	}
	if !r.items.done(itemA) {
		t.Error("the server archived the query; item is uploaded regardless of the local queue failure")
	}
}

// ---- Idempotency-Key ---------------------------------------------------------------------------------------------------

func TestRelay_SameItemRetryReusesKeyDifferentItemGetsNewKey(t *testing.T) {
	r := newRig(t)
	r.snd.err = errBoom
	r.handle(query(itemA))
	r.now = t0.Add(40 * time.Second)
	r.snd.err = nil // retry succeeds: server reachable again, so itemB is not failed fast
	r.handle(query(itemA))
	r.handle(query(itemB))
	k := r.snd.calls
	if len(k) != 3 {
		t.Fatalf("calls = %d, want 3", len(k))
	}
	if k[0].key != k[1].key {
		t.Errorf("retry of the same query changed the Idempotency-Key (%q -> %q); the server could archive it twice", k[0].key, k[1].key)
	}
	if k[2].key == k[0].key {
		t.Error("a different query must use a different Idempotency-Key (else common.idempotency_key_reused)")
	}
}

func TestRelay_DefaultKeyIsNonEmptyAndUnique(t *testing.T) {
	snd := &fakeSender{resp: ok()}
	rel, err := hostquery.New(hostquery.Options{Sender: snd, Outbound: &fakeOut{}, Items: &fakeItems{}, Auth: &fakeAuth{state: "ok"}})
	if err != nil {
		t.Fatal(err)
	}
	rel.Handle(context.Background(), query(itemA))
	rel.Handle(context.Background(), query(itemB))
	if len(snd.calls) != 2 || snd.calls[0].key == "" || snd.calls[0].key == snd.calls[1].key {
		t.Errorf("default keys: %+v", snd.calls)
	}
}

// ---- Security / robustness ------------------------------------------------------------------------------------------------

func TestRelay_NewRefusesMissingDependencies(t *testing.T) {
	full := hostquery.Options{Sender: &fakeSender{}, Outbound: &fakeOut{}, Items: &fakeItems{}, Auth: &fakeAuth{state: "ok"}}
	if _, err := hostquery.New(full); err != nil {
		t.Fatalf("valid options refused: %v", err)
	}
	for name, mut := range map[string]func(*hostquery.Options){
		"Sender":   func(o *hostquery.Options) { o.Sender = nil },
		"Outbound": func(o *hostquery.Options) { o.Outbound = nil },
		"Items":    func(o *hostquery.Options) { o.Items = nil },
		"Auth":     func(o *hostquery.Options) { o.Auth = nil }, // without it the auth_state=rejected rule could not be enforced
	} {
		o := full
		mut(&o)
		if _, err := hostquery.New(o); err == nil {
			t.Errorf("New accepted nil %s", name)
		}
	}
}

func TestRelay_LogsCarryCodesNeverContent(t *testing.T) {
	for _, e := range []error{errBoom, httpErr(422, "instruments.capability_not_supported"), httpErr(500, "")} {
		r := newRig(t)
		r.snd.err = e
		r.handle(query(itemA))
		for _, c := range r.logs.codes {
			if strings.Contains(c, barcode) || strings.Contains(c, "LIS-SIM") || strings.Contains(c, "boom") || len(c) > 96 {
				t.Errorf("log code leaks content or free text: %q (AC-09.12)", c)
			}
		}
	}
}

func TestRelay_NeverFabricatesAReplyOnAnyFailure(t *testing.T) {
	for _, e := range []error{errBoom, context.Canceled, httpErr(401, ""), httpErr(404, ""), httpErr(422, ""), httpErr(429, ""), httpErr(502, "")} {
		r := newRig(t)
		r.snd.err = e
		r.handle(query(itemA))
		if r.out.n() != 0 {
			t.Errorf("error %v produced %d outbound messages", e, r.out.n())
		}
	}
}

func TestRelay_HL7QueryIsRelayedWithItsProtocol(t *testing.T) {
	r := newRig(t)
	q := query(itemA)
	q.Protocol, q.Raw = "hl7v2", []byte("MSH|^~\\&|ANALYZER|LAB|LIS|LAB|20261111083000||ORM^O01|CTRL1|P|2.3.1\rQRD|||||||||"+barcode+"\r")
	r.handle(q)
	if r.snd.calls[0].req.Protocol != "hl7v2" || !bytes.Equal(r.snd.calls[0].req.Raw, q.Raw) {
		t.Errorf("HL7 query altered in transit: %+v", r.snd.calls[0].req)
	}
}

func TestRelay_ConcurrentQueriesAllServedUnderRace(t *testing.T) {
	r := newRig(t)
	const n = 20
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			r.rel.Handle(context.Background(), query(fmt.Sprintf("0196a3c0-0000-7000-8000-%012d", i)))
		}(i)
	}
	wg.Wait()
	if r.snd.n() != n || r.out.n() != n*len(r.snd.resp.ReplyMessages) {
		t.Errorf("calls=%d enqueued=%d, want %d and %d", r.snd.n(), r.out.n(), n, n*len(r.snd.resp.ReplyMessages))
	}
	if len(r.items.uploaded) != n {
		t.Errorf("uploaded %d items, want %d", len(r.items.uploaded), n)
	}
}

func TestRelay_RealRateBudgetCapsHostQueryCallsAt20PerMinute(t *testing.T) {
	snd := &fakeSender{resp: ok("R\r")}
	now := t0
	rb := uploader.NewRateBudget(func() time.Time { return now })
	rel, err := hostquery.New(hostquery.Options{Sender: snd, Outbound: &fakeOut{}, Items: &fakeItems{}, Auth: &fakeAuth{state: "ok"},
		Budget: rb, Now: func() time.Time { return now }})
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 25; i++ {
		rel.Handle(context.Background(), query(fmt.Sprintf("0196a3c0-0000-7000-8000-%012d", i)))
	}
	if snd.n() != 20 || rel.Unavailable() != 5 {
		t.Errorf("calls=%d unavailable=%d, want 20 and 5 (reserved budget, R5)", snd.n(), rel.Unavailable())
	}
}
