package runtime

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"strings"
	"sync"
	"time"

	"lims/apps/bridge-agent/internal/astm"
	"lims/apps/bridge-agent/internal/clock"
	"lims/apps/bridge-agent/internal/drivers"
	"lims/apps/bridge-agent/internal/filedrop"
	"lims/apps/bridge-agent/internal/heartbeat"
	"lims/apps/bridge-agent/internal/hl7"
	"lims/apps/bridge-agent/internal/hostquery"
	"lims/apps/bridge-agent/internal/mllp"
	"lims/apps/bridge-agent/internal/queue"
	"lims/apps/bridge-agent/internal/status"
	"lims/apps/bridge-agent/internal/transport/serial"
	"lims/apps/bridge-agent/internal/transport/tcp"
)

const tsUTC = "2006-01-02T15:04:05.000Z"

type instrumentRunner struct {
	cfg      InstrumentConfig
	rawHash  string
	cancel   context.CancelFunc
	done     chan struct{}
	mllpStat *mllp.Stats

	mu            sync.Mutex
	linkState     string
	lastMsgAt     string
	msgsInterval  int
	msgsTodayDay  string
	msgsToday     int
	errsInterval  int
	lastErrCode   string
	astmNaksSent  int
	astmIncomp    int
}

func newInstrumentRunner(cfg InstrumentConfig, hash string) *instrumentRunner {
	state := "disabled"
	if cfg.Enabled {
		if cfg.Transport.Kind == "tcp_server" {
			state = "listening"
		} else {
			state = "connecting"
		}
	}
	return &instrumentRunner{
		cfg:       cfg,
		rawHash:   hash,
		done:      make(chan struct{}),
		mllpStat:  &mllp.Stats{},
		linkState: state,
	}
}

func (r *instrumentRunner) setState(state, errCode string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.linkState = state
	if errCode != "" {
		r.lastErrCode = errCode
		r.errsInterval++
	}
}

func (r *instrumentRunner) noteMessage(at time.Time) {
	r.mu.Lock()
	defer r.mu.Unlock()
	utc := at.UTC()
	day := utc.Format("2006-01-02")
	if r.msgsTodayDay != day {
		r.msgsTodayDay = day
		r.msgsToday = 0
	}
	r.msgsToday++
	r.msgsInterval++
	r.lastMsgAt = utc.Format(tsUTC)
}

func (r *instrumentRunner) snapshot(resetInterval bool) (heartbeat.InstrumentLink, status.Instrument, int, int, int, int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	hb := heartbeat.InstrumentLink{
		InstrumentID:         r.cfg.InstrumentID,
		LinkState:            r.linkState,
		LastMessageAtAgent:   r.lastMsgAt,
		MessagesLastInterval: r.msgsInterval,
		ErrorsLastInterval:   r.errsInterval,
		LastErrorCode:        r.lastErrCode,
	}
	st := status.Instrument{
		InstrumentCode:     r.cfg.InstrumentCode,
		LinkState:          r.linkState,
		LastMessageAtAgent: r.lastMsgAt,
		MessagesToday:      r.msgsToday,
		LastErrorCode:      r.lastErrCode,
	}
	mllpDisc := int(r.mllpStat.DiscardedBytes())
	mllpOver := int(r.mllpStat.Oversize())
	naks := r.astmNaksSent
	incomp := r.astmIncomp
	if resetInterval {
		r.msgsInterval = 0
		r.errsInterval = 0
	}
	return hb, st, mllpDisc, mllpOver, naks, incomp
}

// Manager supervises per-instrument transport listeners/workers and collects link metrics.
type Manager struct {
	q        *queue.DB
	clk      *clock.Estimator
	relay    *hostquery.Relay
	outbound *OutboundRouter
	now      func() time.Time
	log      func(string)

	mu      sync.Mutex
	runners map[string]*instrumentRunner
}

func NewManager(q *queue.DB, clk *clock.Estimator, relay *hostquery.Relay, outbound *OutboundRouter, now func() time.Time, log func(string)) *Manager {
	if now == nil {
		now = time.Now
	}
	if log == nil {
		log = func(string) {}
	}
	return &Manager{
		q:        q,
		clk:      clk,
		relay:    relay,
		outbound: outbound,
		now:      now,
		log:      log,
		runners:  map[string]*instrumentRunner{},
	}
}

func configHash(ic InstrumentConfig) string {
	b, _ := json.Marshal(ic)
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

// Apply reconciles running instrument listeners to match the signed configuration.
func (m *Manager) Apply(parent context.Context, list []InstrumentConfig) {
	desired := make(map[string]InstrumentConfig, len(list))
	hashes := make(map[string]string, len(list))
	for _, ic := range list {
		desired[ic.InstrumentID] = ic
		hashes[ic.InstrumentID] = configHash(ic)
	}

	m.mu.Lock()
	var toStop []*instrumentRunner
	for id, r := range m.runners {
		h, ok := hashes[id]
		if !ok || r.rawHash != h {
			delete(m.runners, id)
			toStop = append(toStop, r)
		}
	}
	var toStart []*instrumentRunner
	for id, ic := range desired {
		if _, exists := m.runners[id]; !exists {
			r := newInstrumentRunner(ic, hashes[id])
			m.runners[id] = r
			toStart = append(toStart, r)
		}
	}
	m.mu.Unlock()

	for _, r := range toStop {
		if r.cancel != nil {
			r.cancel()
		}
		<-r.done
	}
	for _, r := range toStart {
		cctx, cancel := context.WithCancel(parent)
		r.cancel = cancel
		go m.runOne(cctx, r)
	}
}

// Stop stops all running instruments and waits for exit.
func (m *Manager) Stop() {
	m.mu.Lock()
	list := make([]*instrumentRunner, 0, len(m.runners))
	for id, r := range m.runners {
		delete(m.runners, id)
		list = append(list, r)
	}
	m.mu.Unlock()
	for _, r := range list {
		if r.cancel != nil {
			r.cancel()
		}
		<-r.done
	}
}

// Snapshot collects current link telemetry for heartbeat and status.json.
func (m *Manager) Snapshot(resetInterval bool) ([]heartbeat.InstrumentLink, []status.Instrument, heartbeat.Counters) {
	m.mu.Lock()
	list := make([]*instrumentRunner, 0, len(m.runners))
	for _, r := range m.runners {
		list = append(list, r)
	}
	m.mu.Unlock()

	hbs := make([]heartbeat.InstrumentLink, 0, len(list))
	sts := make([]status.Instrument, 0, len(list))
	var cnt heartbeat.Counters
	for _, r := range list {
		hb, st, disc, over, naks, inc := r.snapshot(resetInterval)
		hbs = append(hbs, hb)
		sts = append(sts, st)
		cnt.MllpDiscardedBytes += disc
		cnt.MllpOversize += over
		cnt.AstmNaksSent += naks
		cnt.AstmIncompleteSessions += inc
	}
	if m.relay != nil {
		cnt.HostQueryUnavailable = m.relay.Unavailable()
	}
	return hbs, sts, cnt
}

func (m *Manager) offsetMs(now time.Time) int64 {
	if m.clk == nil {
		return 0
	}
	off, _, ok := m.clk.Current(now)
	if !ok {
		return 0
	}
	return off
}

func (m *Manager) runOne(ctx context.Context, r *instrumentRunner) {
	defer close(r.done)
	if !r.cfg.Enabled {
		r.setState("disabled", "")
		<-ctx.Done()
		return
	}
	res := drivers.Resolve(r.cfg.DriverCode, r.cfg.Protocol)
	if res.HeartbeatError != "" {
		r.setState("error", res.HeartbeatError)
	}

	switch r.cfg.Protocol {
	case "file_drop":
		m.runFileDrop(ctx, r, r.cfg.EffectiveFileDrop(), true)
	case "hl7v2":
		var secWG sync.WaitGroup
		if secFD := r.cfg.FileDrop; secFD != nil && strings.TrimSpace(secFD.Directory) != "" {
			secWG.Add(1)
			go func() {
				defer secWG.Done()
				m.runFileDrop(ctx, r, secFD, false)
			}()
		}
		m.runStreamProtocol(ctx, r, func(conn io.ReadWriteCloser) {
			m.serveMLLP(ctx, r, res.Profile, conn)
		})
		secWG.Wait()
	case "astm":
		m.recoverASTM(r, res.Profile)
		var secWG sync.WaitGroup
		if secFD := r.cfg.FileDrop; secFD != nil && strings.TrimSpace(secFD.Directory) != "" {
			secWG.Add(1)
			go func() {
				defer secWG.Done()
				m.runFileDrop(ctx, r, secFD, false)
			}()
		}
		m.runStreamProtocol(ctx, r, func(conn io.ReadWriteCloser) {
			m.serveASTM(ctx, r, res.Profile, conn)
		})
		secWG.Wait()
	default:
		r.setState("error", "unsupported_protocol")
		<-ctx.Done()
	}
}

func (m *Manager) runFileDrop(ctx context.Context, r *instrumentRunner, fd *FileDropConfig, primary bool) {
	if fd == nil || strings.TrimSpace(fd.Directory) == "" {
		if primary {
			r.setState("error", "file_drop_unconfigured")
			<-ctx.Done()
		}
		return
	}
	w, err := filedrop.New(filedrop.Options{
		Config: filedrop.Config{
			InstrumentID:         r.cfg.InstrumentID,
			Folder:               fd.Directory,
			FilenamePattern:      fd.FilenamePattern,
			AllowedTypes:         fd.AllowedTypes,
			StableFor:            time.Duration(fd.StableSeconds) * time.Second,
			BarcodeRegex:         fd.BarcodeRegex,
			MoveAfterCapture:     fd.MoveAfterCapture,
			CapturedSubdirectory: fd.CapturedSubdirectory,
		},
		Store: fileDropStore{db: m.q, offsetFn: m.offsetMs, note: func() { r.noteMessage(m.now()) }},
		Now:   m.now,
		NewID: func() string { return queue.NewUUIDv7(m.now()) },
		Log:   m.log,
	})
	if err != nil {
		if primary {
			r.setState("error", "file_drop_invalid")
			<-ctx.Done()
		} else {
			m.log("secondary_file_drop_invalid")
		}
		return
	}
	if primary {
		r.setState("up", "")
	}
	_ = w.Run(ctx)
}

func (m *Manager) runStreamProtocol(ctx context.Context, r *instrumentRunner, serve func(io.ReadWriteCloser)) {
	switch r.cfg.Transport.Kind {
	case "tcp_server":
		lcfg := tcp.ListenConfig{
			BindAddress:  r.cfg.Transport.BindAddress,
			Port:         r.cfg.Transport.Port,
			AllowedPeers: r.cfg.Transport.AllowedPeers,
		}
		if err := tcp.ValidateListenConfig(lcfg); err != nil {
			r.setState("error", "tcp_listen_invalid")
			<-ctx.Done()
			return
		}
		ln, err := tcp.Listen(lcfg)
		if err != nil {
			r.setState("error", "tcp_listen_failed")
			<-ctx.Done()
			return
		}
		go func() {
			<-ctx.Done()
			_ = ln.Close()
		}()
		r.setState("listening", "")
		var prevDone chan struct{}
		defer func() {
			if prevDone != nil {
				<-prevDone
			}
		}()
		for {
			conn, err := ln.Accept(ctx)
			if err != nil {
				if ctx.Err() != nil {
					return
				}
				r.setState("error", "tcp_accept_failed")
				select {
				case <-ctx.Done():
					return
				case <-time.After(time.Second):
				}
				continue
			}
			if tc, ok := conn.(*net.TCPConn); ok {
				_ = tc.SetKeepAlive(true)
				_ = tc.SetKeepAlivePeriod(30 * time.Second)
			}
			if prevDone != nil {
				<-prevDone
			}
			r.setState("up", "")
			done := make(chan struct{})
			prevDone = done
			c := conn
			go func() {
				select {
				case <-ctx.Done():
					_ = c.Close()
				case <-done:
				}
			}()
			go func() {
				defer close(done)
				serve(c)
				_ = c.Close()
				if ctx.Err() == nil {
					r.setState("listening", "")
				}
			}()
		}

	case "tcp_client":
		ct := time.Duration(r.cfg.Transport.ConnectTimeoutS) * time.Second
		if ct <= 0 {
			ct = 5 * time.Second
		}
		maxBack := time.Duration(r.cfg.Transport.ReconnectMaxBackoffS) * time.Second
		if maxBack <= 0 {
			maxBack = 30 * time.Second
		}
		cc := tcp.ClientConfig{
			Host:                r.cfg.Transport.Host,
			Port:                r.cfg.Transport.Port,
			ConnectTimeout:      ct,
			ReconnectMaxBackoff: maxBack,
		}
		if err := tcp.ValidateClientConfig(cc); err != nil {
			r.setState("error", "tcp_client_invalid")
			<-ctx.Done()
			return
		}
		attempt := 0
		for ctx.Err() == nil {
			r.setState("connecting", "")
			conn, err := tcp.Dial(ctx, cc)
			if err != nil {
				r.setState("down", "tcp_dial_failed")
				d := tcp.Backoff(attempt, maxBack)
				attempt++
				select {
				case <-ctx.Done():
					return
				case <-time.After(d):
				}
				continue
			}
			attempt = 0
			r.setState("up", "")
			connDone := make(chan struct{})
			go func() {
				select {
				case <-ctx.Done():
					_ = conn.Close()
				case <-connDone:
				}
			}()
			serve(conn)
			close(connDone)
			_ = conn.Close()
		}

	case "serial":
		sc := serial.Config{
			PortName: r.cfg.Transport.PortName,
			BaudRate: r.cfg.Transport.BaudRate,
			DataBits: r.cfg.Transport.DataBits,
			Parity:   r.cfg.Transport.Parity,
			StopBits: r.cfg.Transport.StopBits,
			DTR:      r.cfg.Transport.DTR,
			RTS:      r.cfg.Transport.RTS,
		}
		if err := serial.ValidateConfig(sc); err != nil {
			r.setState("error", "serial_config_invalid")
			<-ctx.Done()
			return
		}
		for ctx.Err() == nil {
			r.setState("connecting", "")
			port, err := serial.Open(sc)
			if err != nil {
				r.setState("error", "serial_open_failed")
				select {
				case <-ctx.Done():
					return
				case <-time.After(5 * time.Second):
				}
				continue
			}
			r.setState("up", "")
			portDone := make(chan struct{})
			go func() {
				select {
				case <-ctx.Done():
					_ = port.Close()
				case <-portDone:
				}
			}()
			serve(port)
			close(portDone)
			_ = port.Close()
		}

	default:
		r.setState("error", "unsupported_transport")
		<-ctx.Done()
	}
}

type hqCapture struct {
	id         string
	capturedAt time.Time
	offsetMs   int64
}

type mllpSink struct {
	instID   string
	q        *queue.DB
	now      func() time.Time
	offsetFn func(time.Time) int64
	hqTypes  []string
	onMsg    func(time.Time)
	mu       sync.Mutex
	lastHQ   hqCapture
}

func (s *mllpSink) isHostQueryType(t string) bool {
	for _, x := range s.hqTypes {
		if x == t {
			return true
		}
	}
	return false
}

func (s *mllpSink) CommitMessage(raw []byte, msh hl7.MSH) error {
	if low, lerr := s.q.DiskLow(); lerr != nil || low {
		return errors.New("runtime: queue volume low on disk space")
	}
	now := s.now().UTC()
	id := queue.NewUUIDv7(now)
	off := s.offsetFn(now)
	kind := "data"
	if s.isHostQueryType(msh.MessageType) {
		kind = "host_query"
	}
	meta, _ := json.Marshal(map[string]any{
		"link_meta": map[string]any{
			"msh10": msh.ControlID,
		},
	})
	if err := s.q.InsertItem(queue.ItemInput{
		ID:              id,
		InstrumentID:    s.instID,
		Kind:            kind,
		Protocol:        "hl7v2",
		Raw:             raw,
		Meta:            meta,
		CapturedAtAgent: now.Format(tsUTC),
		ClockOffsetMs:   off,
	}); err != nil {
		return err
	}
	if kind == "host_query" {
		s.mu.Lock()
		s.lastHQ = hqCapture{id: id, capturedAt: now, offsetMs: off}
		s.mu.Unlock()
	}
	s.onMsg(now)
	return nil
}

func (s *mllpSink) CommitIncomplete(raw []byte, reason string) error {
	now := s.now().UTC()
	metaObj := map[string]any{}
	if reason != "" {
		metaObj["incomplete_reason"] = reason
	}
	meta, _ := json.Marshal(map[string]any{"link_meta": metaObj})
	return s.q.InsertItem(queue.ItemInput{
		ID:              queue.NewUUIDv7(now),
		InstrumentID:    s.instID,
		Kind:            "incomplete",
		Protocol:        "hl7v2",
		Raw:             raw,
		Meta:            meta,
		CapturedAtAgent: now.Format(tsUTC),
		ClockOffsetMs:   s.offsetFn(now),
	})
}

func (m *Manager) serveMLLP(ctx context.Context, r *instrumentRunner, prof drivers.SessionProfile, conn io.ReadWriteCloser) {
	ackMode := prof.HL7AckMode
	ackApp := ""
	ackFac := ""
	if !prof.HL7AckFullForm {
		ackApp = "LIMS"
		ackFac = "LIMS"
	}
	replyTimeout := prof.ReplyTimeout
	sendRetries := 0
	if prof.ExpectAckOnReply {
		sendRetries = 3
	}
	maxBytes := 0
	if h := r.cfg.ProtocolOptions.HL7v2; h != nil {
		if h.AckMode != "" {
			ackMode = h.AckMode
		}
		if h.AckSendingApp != "" {
			ackApp = h.AckSendingApp
		}
		if h.AckSendingFacility != "" {
			ackFac = h.AckSendingFacility
		}
		if h.AckTimeoutS > 0 {
			replyTimeout = time.Duration(h.AckTimeoutS) * time.Second
		}
		if h.SendRetries != nil {
			sendRetries = *h.SendRetries
		}
		if h.MaxMessageBytes > 0 {
			maxBytes = h.MaxMessageBytes
		}
	}

	var hqTypes []string
	if r.cfg.Capabilities.HostQuery {
		hqTypes = prof.HostQueryMessageTypes
	}
	sink := &mllpSink{
		instID:   r.cfg.InstrumentID,
		q:        m.q,
		now:      m.now,
		offsetFn: m.offsetMs,
		hqTypes:  hqTypes,
		onMsg:    r.noteMessage,
	}

	var (
		hqMu      sync.Mutex
		lastIDsMu sync.Mutex
		lastIDs   []string
		hqFn      mllp.HostQueryFunc
	)
	if r.cfg.Capabilities.HostQuery && len(hqTypes) > 0 && m.relay != nil && m.outbound != nil {
		hqFn = func(raw []byte, _ hl7.MSH) [][]byte {
			hqMu.Lock()
			defer hqMu.Unlock()
			sink.mu.Lock()
			cap := sink.lastHQ
			sink.mu.Unlock()
			m.outbound.Clear(r.cfg.InstrumentID)
			res := m.relay.Handle(ctx, hostquery.Query{
				ItemID:        cap.id,
				InstrumentID:  r.cfg.InstrumentID,
				Protocol:      "hl7v2",
				Raw:           raw,
				CapturedAt:    cap.capturedAt,
				ReplyTimeout:  replyTimeout,
				ClockOffsetMs: cap.offsetMs,
			})
			if res != hostquery.OutcomeReplied {
				m.outbound.Clear(r.cfg.InstrumentID)
				return nil
			}
			msgs, ids := m.outbound.TakeTracked(r.cfg.InstrumentID)
			lastIDsMu.Lock()
			lastIDs = ids
			lastIDsMu.Unlock()
			return msgs
		}
	}

	_ = mllp.Serve(conn, mllp.Config{
		Sink:                   sink,
		MaxMessageBytes:        maxBytes,
		AckMode:                ackMode,
		AckSendingApp:          ackApp,
		AckSendingFacility:     ackFac,
		AckTypeFormat:          prof.HL7AckMessageTypeFormat,
		AckFullForm:            prof.HL7AckFullForm,
		Now:                    m.now,
		Stats:                  r.mllpStat,
		HostQueryTypes:         hqTypes,
		HostQuery:              hqFn,
		ExpectAckOnReply:       prof.ExpectAckOnReply,
		ReplyAckPolicy:         prof.ReplyAckPolicy,
		ReplyAckMatchControlId: prof.ReplyAckMatchControlId,
		ReplyTimeout:           replyTimeout,
		SendRetries:            sendRetries,
		OnHostQueryOutcome: func(idx int, sent bool) {
			lastIDsMu.Lock()
			var oid string
			if idx >= 0 && idx < len(lastIDs) {
				oid = lastIDs[idx]
			}
			lastIDsMu.Unlock()
			if oid != "" && m.outbound != nil {
				st := "failed"
				if sent {
					st = "sent"
				}
				m.outbound.Mark(oid, st)
			}
		},
	})
}

func (m *Manager) astmFrameWait(r *instrumentRunner, prof drivers.SessionProfile) time.Duration {
	wait := 30 * time.Second
	if prof.ASTMDefaults != nil && prof.ASTMDefaults.ReceiverFrameWait > 0 {
		wait = prof.ASTMDefaults.ReceiverFrameWait
	}
	if a := r.cfg.ProtocolOptions.ASTM; a != nil {
		if a.ReceiverFrameWaitS > 0 {
			wait = time.Duration(a.ReceiverFrameWaitS) * time.Second
		} else if a.ReceiveIdleTimeoutS > 0 {
			wait = time.Duration(a.ReceiveIdleTimeoutS) * time.Second
		}
	}
	return wait
}

func (m *Manager) recoverASTM(r *instrumentRunner, prof drivers.SessionProfile) {
	rx := astm.NewReceiver(astm.ReceiverConfig{
		InstrumentID:  r.cfg.InstrumentID,
		Queue:         m.q,
		Clock:         funcClock(m.now),
		FrameWait:     m.astmFrameWait(r, prof),
		NewID:         func() string { return queue.NewUUIDv7(m.now()) },
		ClockOffsetMs: func() int64 { return m.offsetMs(m.now()) },
	})
	if n, err := rx.Recover(); err != nil {
		m.log("astm_recover_failed")
	} else if n > 0 {
		for i := 0; i < n; i++ {
			r.noteMessage(m.now())
		}
	}
}

func (m *Manager) serveASTM(ctx context.Context, r *instrumentRunner, prof drivers.SessionProfile, conn io.ReadWriteCloser) {
	rx := astm.NewReceiver(astm.ReceiverConfig{
		InstrumentID:  r.cfg.InstrumentID,
		Queue:         m.q,
		Clock:         funcClock(m.now),
		FrameWait:     m.astmFrameWait(r, prof),
		NewID:         func() string { return queue.NewUUIDv7(m.now()) },
		ClockOffsetMs: func() int64 { return m.offsetMs(m.now()) },
	})

	connCtx, connCancel := context.WithCancel(ctx)
	defer connCancel()

	type chunk struct {
		data []byte
		err  error
	}
	ch := make(chan chunk, 8)
	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := conn.Read(buf)
			if n > 0 {
				cp := make([]byte, n)
				copy(cp, buf[:n])
				select {
				case ch <- chunk{data: cp}:
				case <-connCtx.Done():
					return
				}
			}
			if err != nil {
				select {
				case ch <- chunk{err: err}:
				case <-connCtx.Done():
				}
				return
			}
		}
	}()

	tick := time.NewTicker(time.Second)
	defer tick.Stop()
	lastNaks := 0
	recordStats := func(st astm.Stats, finalized, incomp int) {
		deltaNaks := st.NaksSent - lastNaks
		lastNaks = st.NaksSent
		if finalized > 0 {
			for i := 0; i < finalized; i++ {
				r.noteMessage(m.now())
			}
		}
		if deltaNaks > 0 || incomp > 0 {
			r.mu.Lock()
			r.astmNaksSent += deltaNaks
			r.astmIncomp += incomp
			r.mu.Unlock()
		}
	}
	for {
		select {
		case <-ctx.Done():
			wasRx := rx.State() == astm.StateReceiving
			rx.Tick()
			incomp := 0
			if wasRx && rx.State() != astm.StateReceiving {
				incomp = 1
			}
			recordStats(rx.Stats(), 0, incomp)
			return
		case <-tick.C:
			wasRx := rx.State() == astm.StateReceiving
			rx.Tick()
			incomp := 0
			if wasRx && rx.State() != astm.StateReceiving {
				incomp = 1
			}
			recordStats(rx.Stats(), 0, incomp)
		case c := <-ch:
			if len(c.data) > 0 {
				wasRx := rx.State() == astm.StateReceiving
				resp := rx.Feed(c.data)
				fin := 0
				if wasRx && rx.State() != astm.StateReceiving {
					fin = 1
				}
				recordStats(rx.Stats(), fin, 0)
				if len(resp) > 0 {
					if _, werr := conn.Write(resp); werr != nil {
						return
					}
				}
			}
			if c.err != nil {
				if !errors.Is(c.err, io.EOF) {
					r.setState("down", "astm_read_error")
				}
				return
			}
		}
	}
}

type funcClock func() time.Time

func (f funcClock) Now() time.Time { return f() }

type fileDropStore struct {
	db       *queue.DB
	offsetFn func(time.Time) int64
	note     func()
}

func (s fileDropStore) Seen(instrumentID, pathSHA256 string, size int64, mtime time.Time) (bool, error) {
	return s.db.FileDropSeen(instrumentID, pathSHA256, size, mtime)
}

func (s fileDropStore) Capture(in queue.ItemInput, rec filedrop.SeenRecord) error {
	now := time.Now().UTC()
	if in.ClockOffsetMs == 0 && s.offsetFn != nil {
		in.ClockOffsetMs = s.offsetFn(now)
	}
	if err := s.db.CaptureFileDrop(in, rec.InstrumentID, rec.PathSHA256, rec.SizeBytes, rec.MTime, rec.FileSHA256, rec.ItemID, now); err != nil {
		return err
	}
	if s.note != nil {
		s.note()
	}
	return nil
}

// OutboundRouter captures host-query replies queued synchronously during relay.Handle while also persisting audit rows.
type OutboundRouter struct {
	db  *queue.DB
	mu  sync.Mutex
	buf map[string][][]byte
	ids map[string][]string
}

func NewOutboundRouter(db *queue.DB) *OutboundRouter {
	return &OutboundRouter{db: db, buf: map[string][][]byte{}, ids: map[string][]string{}}
}

func (o *OutboundRouter) Enqueue(instrumentID string, msg []byte, expiresAt time.Time) error {
	cp := append([]byte(nil), msg...)
	var oid string
	var err error
	if o.db != nil {
		oid, err = o.db.OutboundEnqueue(instrumentID, cp, expiresAt)
	}
	o.mu.Lock()
	o.buf[instrumentID] = append(o.buf[instrumentID], cp)
	o.ids[instrumentID] = append(o.ids[instrumentID], oid)
	o.mu.Unlock()
	return err
}

func (o *OutboundRouter) Mark(id, state string) {
	if o.db != nil && id != "" {
		_ = o.db.OutboundMark(id, state)
	}
}

func (o *OutboundRouter) Clear(instrumentID string) {
	o.mu.Lock()
	delete(o.buf, instrumentID)
	delete(o.ids, instrumentID)
	o.mu.Unlock()
}

func (o *OutboundRouter) Take(instrumentID string) [][]byte {
	msgs, _ := o.TakeTracked(instrumentID)
	return msgs
}

func (o *OutboundRouter) TakeTracked(instrumentID string) ([][]byte, []string) {
	o.mu.Lock()
	defer o.mu.Unlock()
	out := o.buf[instrumentID]
	ids := o.ids[instrumentID]
	delete(o.buf, instrumentID)
	delete(o.ids, instrumentID)
	return out, ids
}

var _ net.Conn
