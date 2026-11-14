package simulator

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"lims/apps/bridge-agent/internal/astm"
	"lims/apps/bridge-agent/internal/drivers"
	"lims/apps/bridge-agent/internal/filedrop"
	"lims/apps/bridge-agent/internal/hl7"
	"lims/apps/bridge-agent/internal/hostquery"
	"lims/apps/bridge-agent/internal/mllp"
	"lims/apps/bridge-agent/internal/queue"
)

const (
	instrumentID = "sim-instrument"
	tsFormat     = "2006-01-02T15:04:05.000Z"
	realTimeout  = 5 * time.Second // guard against a wedged link goroutine; never part of the simulated time
)

// fakeClock is the only clock the link layers see; wait_ms steps advance it, nothing ever sleeps.
type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *fakeClock) Now() time.Time { c.mu.Lock(); defer c.mu.Unlock(); return c.t }
func (c *fakeClock) advance(d time.Duration) {
	c.mu.Lock()
	c.t = c.t.Add(d)
	c.mu.Unlock()
}

// idKeyProtector: the scratch queue holds synthetic data only and lives in a temp dir; no DPAPI in CI.
type idKeyProtector struct{}

func (idKeyProtector) Protect(p []byte) ([]byte, error)   { return p, nil }
func (idKeyProtector) Unprotect(b []byte) ([]byte, error) { return b, nil }

// env is everything one Run shares: clock, queue, id source, options.
type env struct {
	s     Session
	clk   *fakeClock
	db    *queue.DB
	dir   string
	mu    sync.Mutex
	n     int
	ids   []string
	acks  int
	state map[string]bool // file_drop_seen
}

func (e *env) newID() string {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.n++
	id := fmt.Sprintf("sim-%04d", e.n)
	e.ids = append(e.ids, id)
	return id
}

func (e *env) nextAckID() string {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.acks++
	return fmt.Sprintf("ACK%04d", e.acks)
}

// items returns every queue item the run created, in creation order (session ids are not items and are skipped).
func (e *env) items() ([]queue.Item, error) {
	e.mu.Lock()
	ids := append([]string(nil), e.ids...)
	e.mu.Unlock()
	var out []queue.Item
	for _, id := range ids {
		it, err := e.db.GetItem(id)
		if errors.Is(err, queue.ErrNotFound) {
			continue
		}
		if err != nil {
			return nil, err
		}
		out = append(out, it)
	}
	return out, nil
}

func (e *env) optNum(name string, def float64) (float64, error) {
	v, ok := e.s.Options[name]
	if !ok {
		return def, nil
	}
	f, ok := v.(float64)
	if !ok || f < 0 || f > 1e7 {
		return 0, fmt.Errorf("option %s must be a number 0..1e7", name)
	}
	return f, nil
}

// driver is one protocol's link layer. tick is called after every wait_ms step.
type driver interface {
	feed(b []byte) ([]byte, error)
	tick() ([]byte, error)
	close()
}

// Run executes s against the real link layers; scratchDir is the only place it writes. The error names the failing
// step as "step N" (1-based) and says what differed. It never panics on hostile input.
func Run(s Session, scratchDir string) (err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("simulator panic: %v", r)
		}
	}()
	if err := s.validate(); err != nil {
		return err
	}
	e := &env{s: s, clk: &fakeClock{t: time.Date(2026, 11, 11, 8, 0, 0, 0, time.UTC)}, dir: scratchDir, state: map[string]bool{}}
	e.db, err = queue.Open(filepath.Join(scratchDir, "agent.db"), idKeyProtector{},
		queue.Options{FreeBytes: func(string) (int64, error) { return 1 << 40, nil }})
	if err != nil {
		return err
	}
	defer e.db.Close()
	var d driver
	switch s.Protocol {
	case "astm":
		d, err = newASTM(e)
	case "hl7v2":
		d, err = newHL7(e)
	default:
		d, err = newFileDrop(e)
	}
	if err != nil {
		return err
	}
	defer d.close()

	var pending []byte // bytes the agent wrote that no expect step has consumed yet
	for i, st := range s.Steps {
		if err := e.step(d, st, &pending); err != nil {
			return fmt.Errorf("step %d: %w", i+1, err)
		}
	}
	if len(pending) > 0 {
		return fmt.Errorf("end of session: agent wrote %s that no step expected", show(pending))
	}
	return nil
}

func (e *env) step(d driver, st Step, pending *[]byte) error {
	switch {
	case st.From != "":
		if len(*pending) > 0 {
			return fmt.Errorf("agent wrote %s that no earlier step expected", show(*pending))
		}
		b, _ := ParseBytes(*st.Bytes)
		out, err := d.feed(b)
		*pending = append(*pending, out...)
		return err
	case st.Expect != "":
		want, _ := ParseBytes(strings.ReplaceAll(*st.Bytes, "{now}", e.clk.Now().Format("20060102150405")))
		got := *pending
		*pending = nil
		if !bytes.Equal(got, want) {
			return fmt.Errorf("agent wrote %s, want %s", show(got), show(want))
		}
	case st.WaitMs != nil:
		e.clk.advance(time.Duration(*st.WaitMs) * time.Millisecond)
		out, err := d.tick()
		*pending = append(*pending, out...)
		return err
	case st.ExpectQueue != nil:
		return e.expectQueue(*st.ExpectQueue)
	case st.Outbound != nil:
		a, ok := d.(*astmDriver)
		if !ok {
			return errors.New("outbound needs an astm session")
		}
		recs := make([][]byte, len(st.Outbound))
		for i, r := range st.Outbound {
			recs[i], _ = ParseBytes(r)
		}
		if err := a.tx.Submit(recs); err != nil {
			return err
		}
		*pending = append(*pending, a.tx.Tick()...)
	case st.HostQuery != nil:
		if h, isHL7 := d.(*hl7Driver); isHL7 { // hl7v2: configure the stub; the instrument's QRY triggers the relay
			h.setReplies(st.HostQuery.Reply)
			return nil
		}
		a, ok := d.(*astmDriver)
		if !ok {
			return errors.New("host_query needs an astm or hl7v2 session")
		}
		out, err := a.hostQuery(e, st.HostQuery)
		*pending = append(*pending, out...)
		return err
	case st.File != nil:
		f, ok := d.(*fileDropDriver)
		if !ok {
			return errors.New("file needs a file_drop session")
		}
		return f.apply(st.File)
	}
	return nil
}

func (e *env) expectQueue(q QueueExpect) error {
	items, err := e.items()
	if err != nil {
		return err
	}
	if len(items) != *q.Items {
		return fmt.Errorf("queue has %d items, want %d", len(items), *q.Items)
	}
	hit := false
	for _, it := range items {
		if q.Kind != "" && it.Kind != q.Kind {
			return fmt.Errorf("queue item %s has kind %q, want %q", it.ID, it.Kind, q.Kind)
		}
		hit = hit || strings.EqualFold(it.RawSHA256, q.RawSHA256)
	}
	if q.RawSHA256 != "" && len(items) > 0 && !hit {
		return fmt.Errorf("no queue item has raw_sha256 %s (items: %s)", q.RawSHA256, hashes(items))
	}
	return nil
}

func hashes(items []queue.Item) string {
	var h []string
	for _, it := range items {
		h = append(h, it.RawSHA256)
	}
	return strings.Join(h, ",")
}

// ---- astm: Receiver + Sender glued the way the agent's link owner glues them ----

type astmDriver struct {
	rx *astm.Receiver
	tx *astm.Sender
}

func newASTM(e *env) (driver, error) {
	w, err := e.optNum("receiver_frame_wait_s", 0)
	if err != nil {
		return nil, err
	}
	return &astmDriver{
		rx: astm.NewReceiver(astm.ReceiverConfig{InstrumentID: instrumentID, Queue: e.db, Clock: e.clk,
			FrameWait: time.Duration(w * float64(time.Second)), NewID: e.newID}),
		tx: astm.NewSender(astm.SenderConfig{Clock: e.clk}),
	}, nil
}

// feed routes by sender state: a sender that is establishing/waiting/transferring owns the line; while deferred the
// instrument's message is the receiver's (the sender only watches for its EOT); otherwise everything is the receiver's.
func (a *astmDriver) feed(b []byte) ([]byte, error) {
	if len(b) == 0 {
		return nil, nil
	}
	switch st := a.tx.State(); st {
	case astm.SendEstablishing, astm.SendNakWait, astm.SendTransfer:
		if st == astm.SendEstablishing && b[0] == astm.ENQ {
			// contention (AC-06.3): the instrument wins. The sender answers ACK; the receiver opens its session
			// silently. ponytail: the crossing ENQ must be a step of its own; split it from later bytes.
			if len(b) != 1 {
				return nil, errors.New("a contending ENQ must be a step of its own")
			}
			out := a.tx.Feed(b)
			a.rx.Feed(b)
			return out, nil
		}
		return a.tx.Feed(b), nil
	case astm.SendDeferred:
		a.tx.Feed(b)
	}
	return a.rx.Feed(b), nil
}

func (a *astmDriver) tick() ([]byte, error) {
	a.rx.Tick()
	return a.tx.Tick(), nil
}

func (a *astmDriver) close() {}

// stubServer is the E05 server stub: it checks the request carries the item's bytes and answers one reply message.
type stubServer struct {
	want, reply []byte
	err         error
}

func (s *stubServer) SubmitHostQuery(_ context.Context, key string, r hostquery.Request) (hostquery.Response, error) {
	if key == "" || r.Protocol != "astm" || r.InstrumentID != instrumentID || !bytes.Equal(r.Raw, s.want) {
		s.err = errors.New("host query request does not carry the captured item")
	}
	return hostquery.Response{InstrumentMessageID: "sim-imsg-0001", ReplyMessages: [][]byte{s.reply}}, nil
}

type outbox struct{ msgs [][]byte }

func (o *outbox) Enqueue(_ string, msg []byte, _ time.Time) error {
	o.msgs = append(o.msgs, append([]byte(nil), msg...))
	return nil
}

type authOK struct{}

func (authOK) AuthState() string { return "ok" }

// hostQuery relays the newest pending host_query item through the real relay and hands the queued reply to the sender.
func (a *astmDriver) hostQuery(e *env, hq *HostQuery) ([]byte, error) {
	items, err := e.items()
	if err != nil {
		return nil, err
	}
	var it *queue.Item
	for i := range items {
		if items[i].Kind == "host_query" && items[i].State == "pending" {
			it = &items[i]
		}
	}
	if it == nil {
		return nil, errors.New("no pending host_query item in the queue")
	}
	captured, err := time.Parse(tsFormat, it.CapturedAtAgent)
	if err != nil {
		return nil, err
	}
	reply, _ := ParseBytes(hq.Reply[0])
	srv, out := &stubServer{want: it.Raw, reply: reply}, &outbox{}
	relay, err := hostquery.New(hostquery.Options{Sender: srv, Outbound: out, Items: e.db, Auth: authOK{}, Now: e.clk.Now})
	if err != nil {
		return nil, err
	}
	// 30 s is the generic reply wait; the per-model value is UNVERIFIED (02-TRD §5.7).
	oc := relay.Handle(context.Background(), hostquery.Query{ItemID: it.ID, InstrumentID: it.InstrumentID, Protocol: it.Protocol,
		Raw: it.Raw, CapturedAt: captured, ReplyTimeout: 30 * time.Second, ClockOffsetMs: it.ClockOffsetMs})
	if srv.err != nil {
		return nil, srv.err
	}
	if oc != hostquery.OutcomeReplied || len(out.msgs) != 1 {
		return nil, fmt.Errorf("host query outcome %q with %d queued replies, want replied with 1", oc, len(out.msgs))
	}
	if err := a.tx.Submit(splitRecords(out.msgs[0])); err != nil {
		return nil, err
	}
	return a.tx.Tick(), nil
}

// splitRecords cuts a message into CR-terminated records.
func splitRecords(msg []byte) [][]byte {
	var recs [][]byte
	for _, r := range bytes.SplitAfter(msg, []byte{'\r'}) {
		if len(r) > 0 {
			recs = append(recs, r)
		}
	}
	return recs
}

// ---- hl7v2: mllp.Serve over a duplex that reports when the agent has gone idle ----

type hl7Driver struct {
	c       *duplex
	done    chan error
	mu      sync.Mutex
	replies [][]byte // what the server stub answers to a host query; none = API unreachable (AC-10.6)
}

func newHL7(e *env) (driver, error) {
	max, err := e.optNum("max_message_bytes", 0)
	if err != nil {
		return nil, err
	}
	mode, _ := e.s.Options["ack_mode"].(string)
	d := &hl7Driver{c: newDuplex(), done: make(chan error, 1)}
	cfg := mllp.Config{Sink: sink{e}, MaxMessageBytes: int(max), AckMode: mode, Now: e.clk.Now, NewControlID: e.nextAckID}
	// A registered agent profile (CR-C7-016) supplies the host-query settings; an unknown one changes nothing.
	if res := drivers.Resolve(e.s.InstrumentProfile, "hl7v2"); res.Known {
		p := res.Profile
		if mode == "" {
			cfg.AckMode = p.HL7AckMode
		}
		cfg.AckFullForm = p.HL7AckFullForm // MET-T01
		if len(p.HostQueryMessageTypes) > 0 {
			cfg.HostQueryTypes, cfg.HostQuery = p.HostQueryMessageTypes, d.hostQuery
			cfg.ExpectAckOnReply, cfg.ReplyAckPolicy = p.ExpectAckOnReply, p.ReplyAckPolicy
			cfg.ReplyAckMatchControlId, cfg.ReplyTimeout = p.ReplyAckMatchControlId, p.ReplyTimeout
		}
	}
	go func() { d.done <- mllp.Serve(d.c, cfg) }()
	return d, nil
}

// hostQuery is the E05 server stub for hl7v2: the replies the session configured, nil when it configured none.
func (d *hl7Driver) hostQuery(raw []byte, _ hl7.MSH) [][]byte {
	d.mu.Lock()
	defer d.mu.Unlock()
	if len(raw) == 0 {
		return nil
	}
	return d.replies
}

// setReplies is the hl7v2 host_query step: it configures the stub's answer to the next host queries.
func (d *hl7Driver) setReplies(reply []string) {
	out := make([][]byte, len(reply))
	for i, r := range reply {
		out[i], _ = ParseBytes(r)
	}
	d.mu.Lock()
	d.replies = out
	d.mu.Unlock()
}

func (d *hl7Driver) feed(b []byte) ([]byte, error) {
	if d.c.isClosed() {
		return nil, errors.New("the agent closed the connection earlier")
	}
	return d.c.exchange(b)
}

func (d *hl7Driver) tick() ([]byte, error) { return nil, nil }

func (d *hl7Driver) close() {
	d.c.Close()
	select {
	case <-d.done:
	case <-time.After(realTimeout):
	}
}

// sink stores what mllp.Serve hands over as queue items (kind data / incomplete, protocol hl7v2).
type sink struct{ e *env }

func (s sink) put(kind string, raw []byte, meta string) error {
	return s.e.db.InsertItem(queue.ItemInput{ID: s.e.newID(), InstrumentID: instrumentID, Kind: kind, Protocol: "hl7v2",
		Raw: raw, Meta: []byte(meta), CapturedAtAgent: s.e.clk.Now().UTC().Format(tsFormat)})
}

func (s sink) CommitMessage(raw []byte, _ hl7.MSH) error { return s.put("data", raw, "{}") }
func (s sink) CommitIncomplete(raw []byte, reason string) error {
	meta := "{}"
	if reason != "" {
		meta = `{"incomplete_reason":"` + reason + `"}`
	}
	return s.put("incomplete", raw, meta)
}

// ---- file_drop: the real watcher over a folder in the scratch dir ----

type fileDropDriver struct {
	w   *filedrop.Watcher
	dir string
}

type fdStore struct{ e *env }

func (s fdStore) key(inst, ph string, size int64, m time.Time) string {
	return fmt.Sprintf("%s|%s|%d|%d", inst, ph, size, m.UnixMilli())
}

func (s fdStore) Seen(inst, ph string, size int64, m time.Time) (bool, error) {
	s.e.mu.Lock()
	defer s.e.mu.Unlock()
	return s.e.state[s.key(inst, ph, size, m)], nil
}

func (s fdStore) Capture(in queue.ItemInput, r filedrop.SeenRecord) error {
	if err := s.e.db.InsertItem(in); err != nil {
		return err
	}
	s.e.mu.Lock()
	s.e.state[s.key(r.InstrumentID, r.PathSHA256, r.SizeBytes, r.MTime)] = true
	s.e.mu.Unlock()
	return nil
}

func newFileDrop(e *env) (driver, error) {
	stable, err := e.optNum("stable_seconds", 5)
	if err != nil {
		return nil, err
	}
	dir := filepath.Join(e.dir, "drop")
	if err := os.Mkdir(dir, 0o700); err != nil {
		return nil, err
	}
	w, err := filedrop.New(filedrop.Options{
		Config: filedrop.Config{InstrumentID: instrumentID, Folder: dir, StableFor: time.Duration(stable * float64(time.Second))},
		Store:  fdStore{e}, Now: e.clk.Now, NewID: e.newID,
	})
	if err != nil {
		return nil, err
	}
	return &fileDropDriver{w: w, dir: dir}, nil
}

func (f *fileDropDriver) feed([]byte) ([]byte, error) {
	return nil, errors.New("file_drop sessions take no instrument bytes")
}

func (f *fileDropDriver) tick() ([]byte, error) { return nil, f.w.Scan(context.Background()) }
func (f *fileDropDriver) close()                {}

// apply writes or appends in the watched folder; file names were validated as plain names at load.
func (f *fileDropDriver) apply(op *FileOp) error {
	flag, name := os.O_CREATE|os.O_WRONLY|os.O_TRUNC, op.Write
	if op.Append != "" {
		flag, name = os.O_CREATE|os.O_WRONLY|os.O_APPEND, op.Append
	}
	fh, err := os.OpenFile(filepath.Join(f.dir, name), flag, 0o600)
	if err != nil {
		return err
	}
	if _, err := fh.WriteString(op.Text); err != nil {
		_ = fh.Close()
		return err
	}
	return fh.Close()
}
