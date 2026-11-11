package hostquery_test

// Shared fakes for AG-T13. They also document the API the implementation must provide (package hostquery):
//
//	type Request struct {                         // one E05 call (02-TRD 7; contracts/openapi/instruments.yaml submitHostQuery)
//	    InstrumentID, AgentMessageID, Protocol string   // protocol "astm"|"hl7v2"; AgentMessageID = the queue item id (UUIDv7)
//	    Raw []byte; CapturedAt time.Time; ClockOffsetMs int64
//	}
//	type Response struct { ServerTime time.Time; InstrumentMessageID string; ReplyMessages [][]byte }   // decoded raw_base64
//	type Sender interface { SubmitHostQuery(ctx, idemKey string, Request) (Response, error) }          // *Client implements it
//	func NewClient(uploader.Config) (*Client, error)    // same TLS rules as uploader.NewClient; non-200 -> *uploader.HTTPError
//	type Outbound interface { Enqueue(instrumentID string, msg []byte, expiresAt time.Time) error }   // encrypted outbound row + sender
//	type Items interface { MarkUploaded(id, serverMessageID string, at time.Time) error }              // *queue.DB implements it
//	type Query struct {                                // a finalised host_query item (03-APP-FLOW 3.1/3.3)
//	    ItemID, InstrumentID, Protocol string; Raw []byte; CapturedAt time.Time
//	    ReplyTimeout time.Duration; ClockOffsetMs int64
//	}
//	type Options struct {
//	    Sender Sender; Outbound Outbound; Items Items
//	    Auth   interface{ AuthState() string }          // *uploader.Uploader implements it
//	    Budget interface{ Allow(uploader.Class) bool }  // *uploader.RateBudget implements it; nil = unlimited
//	    Log    func(code string)                        // codes only; never message content
//	    Now    func() time.Time; NewKey func() string   // defaults: time.Now, uploader-style UUIDv7
//	}
//	func New(Options) (*Relay, error)                   // error when Sender, Outbound, Items or Auth is nil
//	func (*Relay) Handle(ctx, Query) Outcome            // synchronous; never returns an error, never panics
//	const OutcomeReplied, OutcomeUnavailable, OutcomeNoReply, OutcomeExpired Outcome   // "replied","unavailable","no_reply","expired"
//	func (*Relay) Unavailable() int                     // heartbeat counter host_query_unavailable

import (
	"context"
	"crypto/x509"
	"encoding/base64"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"lims/apps/bridge-agent/internal/hostquery"
	"lims/apps/bridge-agent/internal/uploader"
)

var t0 = time.Date(2026, 11, 11, 8, 30, 0, 0, time.UTC)

const (
	instID   = "0196a3c0-0000-7000-8000-0000000000aa"
	itemA    = "0196a3c0-0000-7000-8000-0000000000a1"
	itemB    = "0196a3c0-0000-7000-8000-0000000000b2"
	tok      = "dev-token-synthetic-0001"
	barcode  = "E2600000042" // synthetic; must never reach a log code
	replyTTL = 30 * time.Second
)

// ASTM query: H, Q (starting range id = barcode), L. Synthetic.
var astmQuery = []byte("H|\\^&|||LIS-SIM|||||||P|1\rQ|1|^" + barcode + "||||||||||O\rL|1|N\r")

func query(item string) hostquery.Query {
	return hostquery.Query{ItemID: item, InstrumentID: instID, Protocol: "astm", Raw: astmQuery, CapturedAt: t0,
		ReplyTimeout: replyTTL, ClockOffsetMs: -400}
}

// ---- fakes -------------------------------------------------------------------------------------------------------

type call struct {
	key      string
	req      hostquery.Request
	deadline time.Time // zero when the context had none
}

type fakeSender struct {
	mu    sync.Mutex
	calls []call
	resp  hostquery.Response
	err   error
	hook  func() // runs inside SubmitHostQuery (e.g. to advance the clock)
}

func (s *fakeSender) SubmitHostQuery(ctx context.Context, key string, r hostquery.Request) (hostquery.Response, error) {
	s.mu.Lock()
	dl, _ := ctx.Deadline()
	s.calls = append(s.calls, call{key, r, dl})
	resp, err, hook := s.resp, s.err, s.hook
	s.mu.Unlock()
	if hook != nil {
		hook()
	}
	return resp, err
}

func (s *fakeSender) n() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.calls)
}

type enq struct {
	inst    string
	msg     []byte
	expires time.Time
}

type fakeOut struct {
	mu   sync.Mutex
	msgs []enq
	err  error
}

func (o *fakeOut) Enqueue(inst string, msg []byte, exp time.Time) error {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.err != nil {
		return o.err
	}
	o.msgs = append(o.msgs, enq{inst, append([]byte(nil), msg...), exp})
	return nil
}

func (o *fakeOut) n() int {
	o.mu.Lock()
	defer o.mu.Unlock()
	return len(o.msgs)
}

type fakeItems struct {
	mu       sync.Mutex
	uploaded map[string]string // item id -> server message id
}

func (f *fakeItems) MarkUploaded(id, srv string, _ time.Time) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.uploaded == nil {
		f.uploaded = map[string]string{}
	}
	f.uploaded[id] = srv
	return nil
}

func (f *fakeItems) done(id string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	_, ok := f.uploaded[id]
	return ok
}

type fakeAuth struct{ state string }

func (a *fakeAuth) AuthState() string { return a.state }

type budget struct {
	allow   bool
	classes []uploader.Class
}

func (b *budget) Allow(c uploader.Class) bool { b.classes = append(b.classes, c); return b.allow }

type logs struct {
	mu    sync.Mutex
	codes []string
}

func (l *logs) log(c string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.codes = append(l.codes, c)
}

func (l *logs) has(c string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, x := range l.codes {
		if x == c {
			return true
		}
	}
	return false
}

type rig struct {
	t      *testing.T
	snd    *fakeSender
	out    *fakeOut
	items  *fakeItems
	auth   *fakeAuth
	budget *budget
	logs   *logs
	now    time.Time
	keySeq int
	rel    *hostquery.Relay
}

func ok(msgs ...string) hostquery.Response {
	var rm [][]byte
	for _, m := range msgs {
		rm = append(rm, []byte(m))
	}
	return hostquery.Response{ServerTime: t0, InstrumentMessageID: "0196a3c0-0000-7000-8000-0000000000ee", ReplyMessages: rm}
}

func newRig(t *testing.T) *rig {
	t.Helper()
	r := &rig{t: t, snd: &fakeSender{resp: ok("H|\\^&|||LIS|||||||P|1\rP|1\rO|1|" + "SPEC1" + "||^^^WBC\rL|1|N\r")},
		out: &fakeOut{}, items: &fakeItems{}, auth: &fakeAuth{state: "ok"}, budget: &budget{allow: true}, logs: &logs{}, now: t0}
	rel, err := hostquery.New(hostquery.Options{Sender: r.snd, Outbound: r.out, Items: r.items, Auth: r.auth, Budget: r.budget,
		Log: r.logs.log, Now: func() time.Time { return r.now },
		NewKey: func() string { r.keySeq++; return "key-" + string(rune('0'+r.keySeq)) }})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	r.rel = rel
	return r
}

func (r *rig) handle(q hostquery.Query) hostquery.Outcome {
	r.t.Helper()
	return r.rel.Handle(context.Background(), q)
}

// ---- TLS stub for the real Client -----------------------------------------------------------------------------------

type stub struct {
	srv    *httptest.Server
	pool   *x509.CertPool
	mu     sync.Mutex
	status int
	reply  string
	hdr    http.Header
	method string
	path   string
	body   []byte
	hits   int
}

func b64(s string) string { return base64.StdEncoding.EncodeToString([]byte(s)) }

func replyBody(msgs ...string) string {
	var parts []string
	for _, m := range msgs {
		parts = append(parts, `{"raw_base64":"`+b64(m)+`"}`)
	}
	return `{"server_time":"2026-11-11T08:30:00.200Z","instrument_message_id":"0196a3c0-0000-7000-8000-0000000000ee","reply_messages":[` +
		strings.Join(parts, ",") + `],"answer_summary":[{"index":0,"status":"found","test_count":1}]}`
}

var errBoom = errors.New("boom")
