package astm

// AG-T05 test helpers. Spec: 03-APP-FLOW §3.1 (receiver state machine + rules 1-4), 02-TRD §5.2.3/§5.2.4/§5.2.6/§5.2.7,
// 01-PRD AC-05.1..AC-05.7, 07-SECURITY (disk-full -> NAK, agent input untrusted).
//
// The spec names only the file (internal/astm/link.go) and the behaviour. The Go names below are the tests' contract
// for the writer; everything is in package astm and uses the AG-T04 queue API unchanged.
//
//	type Clock interface{ Now() time.Time }                // fake in tests; link.go must never call time.Now / time.Sleep itself
//	type State int; const ( StateNeutral State = iota; StateReceiving )
//	type Stats struct{ Frames, Retransmits, NaksSent, DiscardedBytes int } // cumulative since NewReceiver
//	type ReceiverConfig struct {
//	    InstrumentID  string
//	    Queue         *queue.DB
//	    Clock         Clock
//	    FrameWait     time.Duration   // 0 = 30 s (receiver_frame_wait_s, TRD 5.2.4)
//	    NewID         func() string   // ids for sessions AND items; the receiver never invents ids itself
//	    ClockOffsetMs func() int64    // nil = 0; stored on each item
//	}
//	func NewReceiver(cfg ReceiverConfig) *Receiver         // does not touch the queue; starts Neutral
//	func (r *Receiver) Feed(b []byte) []byte               // bytes read from the line -> bytes to write (ACK/NAK per event, in order); synchronous;
//	                                                       // an ACK is returned only after the SQLite commit (D-02); b may hold any slice of the byte
//	                                                       // stream (partial frame, several frames, ENQ+frames+EOT); partial frames are buffered
//	func (r *Receiver) Tick()                              // owner calls it on a timer; applies the frame-wait timeout against Clock.Now()
//	func (r *Receiver) State() State
//	func (r *Receiver) Stats() Stats
//	func (r *Receiver) Recover() (int, error)              // 03-APP-FLOW §3.1 rule 4; returns number of sessions finalised
//
// Session/item contract (queue package, AG-T04): session protocol "astm", instrument_id = cfg.InstrumentID, ExpectedFN 1 at ENQ;
// item Protocol "astm", Kind data|host_query|incomplete (TRD 5.3: class "other" is stored as "data"), Meta JSON
// {"link_meta":{"frames":n,"retransmits":n,"naks_sent":n,"incomplete_reason":"frame_timeout|new_enq|process_restart"}} (TRD 7.4 Message.link_meta),
// CapturedAtAgent in "2006-01-02T15:04:05.000Z", ClockOffsetMs from cfg. One frame defect = exactly one NAK byte.

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"lims/apps/bridge-agent/internal/queue"

	_ "modernc.org/sqlite"
)

const (
	lkTS      = "2006-01-02T15:04:05.000Z"
	lkGoldSHA = "56ebd538f73ae63fd6cdc8ffc3bc2e4c948482e9570b7146c20f6c7878d0baaf" // TRD 5.2.6, frames 1-5 texts
	lkInst    = "inst-1"
)

// Texts of golden frames 1..5 (TRD 5.2.6). Frame i has FN i, terminator ETX.
var lkGoldTexts = []string{
	"H|\\^&|||SIM-ANALYSER^0.1|||||||P|1\r",
	"P|1\r",
	"O|1|E2600000042||^^^GLU\r",
	"R|1|^^^GLU|5.4|mmol/L||N||F\r",
	"L|1|N\r",
}

func lkFrame(t testing.TB, fn int, text string, term byte) []byte {
	t.Helper()
	b, err := EncodeFrame(fn, []byte(text), term)
	if err != nil {
		t.Fatalf("EncodeFrame(%d): %v", fn, err)
	}
	return b
}

func lkGoldFrame(t testing.TB, i int) []byte { return lkFrame(t, i, lkGoldTexts[i-1], ETX) } // i = 1..5

func lkAcks(n int) []byte { return bytes.Repeat([]byte{ACK}, n) }

// ---- fake clock ----

type lkClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *lkClock) Now() time.Time { c.mu.Lock(); defer c.mu.Unlock(); return c.t }
func (c *lkClock) Advance(d time.Duration) {
	c.mu.Lock()
	c.t = c.t.Add(d)
	c.mu.Unlock()
}

type lkSysClock struct{}

func (lkSysClock) Now() time.Time { return time.Now().UTC() }

// ---- reversible fake DPAPI (fixed key so a re-exec'd child and the parent share it) ----

type lkProtector struct{}

var lkKey = bytes.Repeat([]byte{0x3c}, 32)

func (lkProtector) Protect(plain []byte) ([]byte, error) {
	b, _ := aes.NewCipher(lkKey)
	g, _ := cipher.NewGCM(b)
	n := make([]byte, g.NonceSize())
	_, _ = rand.Read(n)
	return append(n, g.Seal(nil, n, plain, nil)...), nil
}

func (lkProtector) Unprotect(blob []byte) ([]byte, error) {
	b, _ := aes.NewCipher(lkKey)
	g, _ := cipher.NewGCM(b)
	if len(blob) < g.NonceSize() {
		return nil, errors.New("blob too short")
	}
	return g.Open(nil, blob[:g.NonceSize()], blob[g.NonceSize():], nil)
}

// ---- rig ----

type lkRig struct {
	t     *testing.T
	path  string
	db    *queue.DB
	clk   *lkClock
	rx    *Receiver
	ids   []string
	free  atomic.Int64 // fake free disk bytes seen by the queue's disk guard
	start time.Time
}

func lkOpenDB(t *testing.T, path string, free func(string) (int64, error)) *queue.DB {
	t.Helper()
	d, err := queue.Open(path, lkProtector{}, queue.Options{FreeBytes: free})
	if err != nil {
		t.Fatalf("queue.Open: %v", err)
	}
	t.Cleanup(func() { _ = d.Close() })
	return d
}

// lkOpenDBNoT is for the re-exec'd child (no *testing.T there).
func lkOpenDBNoT(path string) (*queue.DB, error) {
	return queue.Open(path, lkProtector{}, queue.Options{FreeBytes: func(string) (int64, error) { return 100 << 30, nil }})
}

func newLkRig(t *testing.T, mut ...func(*ReceiverConfig)) *lkRig {
	t.Helper()
	return openLkRig(t, filepath.Join(t.TempDir(), "agent.db"), "", mut...)
}

// openLkRig opens (or creates) the queue at path; idPrefix keeps ids of different processes apart.
func openLkRig(t *testing.T, path, idPrefix string, mut ...func(*ReceiverConfig)) *lkRig {
	t.Helper()
	r := &lkRig{t: t, path: path, start: time.Date(2026, 11, 11, 8, 0, 0, 0, time.UTC)}
	r.clk = &lkClock{t: r.start}
	r.free.Store(100 << 30)
	r.db = lkOpenDB(t, path, func(string) (int64, error) { return r.free.Load(), nil })
	var n int
	cfg := ReceiverConfig{
		InstrumentID: lkInst, Queue: r.db, Clock: r.clk,
		NewID: func() string { n++; id := fmt.Sprintf("%sid-%03d", idPrefix, n); r.ids = append(r.ids, id); return id },
	}
	for _, m := range mut {
		m(&cfg)
	}
	r.rx = NewReceiver(cfg)
	return r
}

// feed sends b and returns the reply bytes.
func (r *lkRig) feed(b []byte) []byte { return r.rx.Feed(b) }

func (r *lkRig) mustReply(what string, b, want []byte) {
	r.t.Helper()
	if got := r.rx.Feed(b); !bytes.Equal(got, want) {
		r.t.Fatalf("%s: reply = %q, want %q", what, got, want)
	}
}

// openMsg: ENQ (expect ACK) then golden frames 1..n (expect ACK each).
func (r *lkRig) openMsg(n int) {
	r.t.Helper()
	r.mustReply("ENQ", []byte{ENQ}, []byte{ACK})
	for i := 1; i <= n; i++ {
		r.mustReply(fmt.Sprintf("frame %d", i), lkGoldFrame(r.t, i), []byte{ACK})
	}
}

// items returns every item the receiver created (looked up by the ids it was given), in id order.
func (r *lkRig) items() []queue.Item {
	r.t.Helper()
	var out []queue.Item
	for _, id := range r.ids {
		it, err := r.db.GetItem(id)
		if errors.Is(err, queue.ErrNotFound) {
			continue
		}
		if err != nil {
			r.t.Fatalf("GetItem(%s): %v", id, err)
		}
		out = append(out, it)
	}
	return out
}

func (r *lkRig) oneItem() queue.Item {
	r.t.Helper()
	its := r.items()
	if len(its) != 1 {
		r.t.Fatalf("items = %d, want exactly 1: %+v", len(its), its)
	}
	return its[0]
}

func (r *lkRig) openSessions() []queue.Session {
	r.t.Helper()
	ss, err := r.db.OpenSessions()
	if err != nil {
		r.t.Fatalf("OpenSessions: %v", err)
	}
	return ss
}

type lkLinkMeta struct {
	Frames           int    `json:"frames"`
	Retransmits      int    `json:"retransmits"`
	NaksSent         int    `json:"naks_sent"`
	IncompleteReason string `json:"incomplete_reason"`
}

func lkMeta(t testing.TB, it queue.Item) lkLinkMeta {
	t.Helper()
	var m struct {
		LinkMeta lkLinkMeta `json:"link_meta"`
	}
	if err := json.Unmarshal(it.Meta, &m); err != nil {
		t.Fatalf("item meta is not JSON {link_meta:{...}}: %q: %v", it.Meta, err)
	}
	return m.LinkMeta
}

func (r *lkRig) wantState(s State) {
	r.t.Helper()
	if got := r.rx.State(); got != s {
		r.t.Fatalf("state = %v, want %v", got, s)
	}
}

// raw opens a second connection to the same file (what a reader after a crash would see).
func (r *lkRig) rawDB() *sql.DB {
	r.t.Helper()
	db, err := sql.Open("sqlite", r.path+"?_pragma=busy_timeout(5000)")
	if err != nil {
		r.t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	r.t.Cleanup(func() { _ = db.Close() })
	return db
}

func (r *lkRig) rawCount(table string) int {
	r.t.Helper()
	var n int
	if err := r.rawDB().QueryRow("SELECT count(*) FROM " + table).Scan(&n); err != nil {
		r.t.Fatalf("count %s: %v", table, err)
	}
	return n
}

func (r *lkRig) rawExec(q string) {
	r.t.Helper()
	if _, err := r.rawDB().Exec(q); err != nil {
		r.t.Fatalf("raw exec %q: %v", q, err)
	}
}

func lkExists(path string) bool { _, err := os.Stat(path); return err == nil }
