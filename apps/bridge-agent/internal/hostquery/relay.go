package hostquery

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"sync"
	"time"

	"lims/apps/bridge-agent/internal/uploader"
)

type Outcome string

const (
	OutcomeReplied     Outcome = "replied"     // every reply queued for the instrument
	OutcomeUnavailable Outcome = "unavailable" // no server answer; item stays pending (AC-10.6)
	OutcomeNoReply     Outcome = "no_reply"    // server answered without a usable reply
	OutcomeExpired     Outcome = "expired"     // the instrument stopped waiting
)

const (
	failFast     = 30 * time.Second // after an unreachable server, do not call again for this long
	replyMargin  = time.Second      // give up this long before the instrument does
	codeUnavail  = "host_query_unavailable"
	codeEnqueue  = "host_query_enqueue_failed"
	codeMarkFail = "host_query_mark_failed"
)

// Outbound queues an encrypted reply for the link layer; Items is the item store (*queue.DB implements it).
type Outbound interface {
	Enqueue(instrumentID string, msg []byte, expiresAt time.Time) error
}
type Items interface {
	MarkUploaded(id, serverMessageID string, at time.Time) error
}

// Query is a finalised host_query item.
type Query struct {
	ItemID, InstrumentID, Protocol string
	Raw                            []byte
	CapturedAt                     time.Time
	ReplyTimeout                   time.Duration
	ClockOffsetMs                  int64
}

type Options struct {
	Sender   Sender
	Outbound Outbound
	Items    Items
	Auth     interface{ AuthState() string }
	Budget   interface{ Allow(uploader.Class) bool } // nil = unlimited
	Log      func(code string)                       // codes only, never message content
	Now      func() time.Time
	NewKey   func() string
}

type Relay struct {
	o           Options
	mu          sync.Mutex // guards the fields below and serialises Budget/NewKey calls
	keys        map[string]string
	unreachable time.Time
	unavailable int
}

func New(o Options) (*Relay, error) {
	if o.Sender == nil || o.Outbound == nil || o.Items == nil || o.Auth == nil {
		return nil, errors.New("hostquery: Sender, Outbound, Items and Auth are required")
	}
	if o.Log == nil {
		o.Log = func(string) {}
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.NewKey == nil {
		o.NewKey = func() string { return newUUIDv7(o.Now()) }
	}
	return &Relay{o: o, keys: map[string]string{}}, nil
}

// Unavailable is the heartbeat counter host_query_unavailable.
func (r *Relay) Unavailable() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.unavailable
}

func (r *Relay) fail() Outcome {
	r.mu.Lock()
	r.unavailable++
	r.mu.Unlock()
	r.o.Log(codeUnavail)
	return OutcomeUnavailable
}

// Handle relays one query. It never invents a reply: without a server answer nothing is queued (AC-10.6).
func (r *Relay) Handle(ctx context.Context, q Query) Outcome {
	now := r.o.Now()
	if r.o.Auth.AuthState() == "rejected" {
		return r.fail()
	}
	expires := q.CapturedAt.Add(q.ReplyTimeout)
	wait := q.ReplyTimeout - replyMargin
	if wait <= 0 {
		wait = replyMargin
	}

	r.mu.Lock()
	if !r.unreachable.IsZero() && now.Sub(r.unreachable) < failFast {
		r.mu.Unlock()
		return r.fail()
	}
	if r.o.Budget != nil && !r.o.Budget.Allow(uploader.ClassHostQuery) {
		r.mu.Unlock()
		return r.fail()
	}
	key, ok := r.keys[q.ItemID]
	if !ok {
		key = r.o.NewKey()
		r.keys[q.ItemID] = key
	}
	r.mu.Unlock()

	cctx, cancel := context.WithTimeout(ctx, wait)
	defer cancel()
	resp, err := r.o.Sender.SubmitHostQuery(cctx, key, Request{InstrumentID: q.InstrumentID, AgentMessageID: q.ItemID,
		Protocol: q.Protocol, Raw: q.Raw, CapturedAt: q.CapturedAt, ClockOffsetMs: q.ClockOffsetMs})
	if err != nil {
		var he *uploader.HTTPError
		if !errors.As(err, &he) || he.Status == http.StatusUnauthorized || he.Status == http.StatusTooManyRequests || he.Status >= 500 {
			r.mu.Lock()
			r.unreachable = r.o.Now() // every failed probe re-arms the 30 s window (03-APP-FLOW §3.4 step 2)
			r.mu.Unlock()
			return r.fail()
		}
		r.reachable()
		// Other 4xx: the server answered and archived/rejected the query. No reply; item is done (TRD 5.7).
		r.o.Log(safeCode(he))
		r.done(q.ItemID, "")
		return OutcomeNoReply
	}

	r.reachable()
	r.done(q.ItemID, resp.InstrumentMessageID)
	if r.o.Now().Sub(now) > q.ReplyTimeout {
		return OutcomeExpired // the call outlived the instrument's wait; the link layer would drop it anyway
	}
	for _, m := range resp.ReplyMessages {
		if err := r.o.Outbound.Enqueue(q.InstrumentID, m, expires); err != nil {
			r.o.Log(codeEnqueue)
			return OutcomeNoReply
		}
	}
	if len(resp.ReplyMessages) == 0 {
		return OutcomeNoReply
	}
	return OutcomeReplied
}

func (r *Relay) reachable() {
	r.mu.Lock()
	r.unreachable = time.Time{}
	r.mu.Unlock()
}

func (r *Relay) done(item, serverID string) {
	r.mu.Lock()
	delete(r.keys, item)
	r.mu.Unlock()
	if err := r.o.Items.MarkUploaded(item, serverID, r.o.Now()); err != nil {
		r.o.Log(codeMarkFail)
	}
}

var codeRE = regexp.MustCompile(`^[a-z0-9_.]{1,64}$`)

// safeCode logs the server's error code only if it looks like one; never free text.
func safeCode(he *uploader.HTTPError) string {
	if codeRE.MatchString(he.Code) {
		return he.Code
	}
	return fmt.Sprintf("http_%d", he.Status)
}

// newUUIDv7 is RFC 9562 UUIDv7 (the uploader's copy is unexported).
func newUUIDv7(t time.Time) string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	ms := uint64(t.UnixMilli())
	for i := 0; i < 6; i++ {
		b[i] = byte(ms >> (40 - 8*i))
	}
	b[6] = b[6]&0x0f | 0x70
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}
