package runtime

import (
	"context"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	mrand "math/rand/v2"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"lims/apps/bridge-agent/internal/clock"
	"lims/apps/bridge-agent/internal/config"
	"lims/apps/bridge-agent/internal/heartbeat"
	"lims/apps/bridge-agent/internal/hostquery"
	"lims/apps/bridge-agent/internal/queue"
	"lims/apps/bridge-agent/internal/secrets"
	"lims/apps/bridge-agent/internal/status"
	"lims/apps/bridge-agent/internal/svc"
	"lims/apps/bridge-agent/internal/update"
	"lims/apps/bridge-agent/internal/uploader"
)

type Options struct {
	Layout          svc.Layout
	AgentVersion    string
	LauncherVersion string
	OSVersion       string
	Out             io.Writer
	OnReady         func(control func(uint32) bool)

	// Unexported test hooks (accessible only within package runtime tests; release/external callers cannot set them).
	trustedKeys config.TrustedKeys
	rootCAs     *x509.CertPool
}

type Runner struct {
	opts          Options
	local         svc.LocalConfig
	token         string
	db            *queue.DB
	clk           *clock.Estimator
	cfgCli        *config.Client
	applier       *config.Applier
	upCli         *uploader.Client
	hqCli         *hostquery.Client
	hbCli         *heartbeat.Client
	budget        *uploader.RateBudget
	up            *uploader.Uploader
	hqRelay       *hostquery.Relay
	outbound      *OutboundRouter
	hbSvc         *heartbeat.Service
	mgr           *Manager
	logs          *fileLogger
	statusMu      sync.Mutex
	docMu         sync.RWMutex
	doc           Document
	refreshMu     sync.Mutex
	refreshQueued atomic.Bool
	wg            sync.WaitGroup
	rootCtx       context.Context
	healthyOnce   sync.Once
	hbState       hbSnapshot
	triggers      svc.Triggers
	cancel        context.CancelFunc
	restart       atomic.Bool
}

type hbSnapshot struct {
	reachable bool
	lastAt    string
	outcome   string
	health    string
	updState  string
	updVer    string
	updErr    string
}

// Run starts the production bridge agent daemon and blocks until ctx is cancelled or restart is requested.
func Run(ctx context.Context, opts Options) error {
	if opts.Out == nil {
		opts.Out = os.Stderr
	}
	for _, d := range opts.Layout.Dirs() {
		if err := os.MkdirAll(d, 0o700); err != nil {
			return fmt.Errorf("runtime: create dir %s: %w", d, err)
		}
	}

	lc, err := svc.ReadLocalConfig(opts.Layout)
	if err != nil {
		return fmt.Errorf("runtime: not installed (%w)", err)
	}
	if lc.AgentID == "" {
		return errors.New("runtime: config.local.json missing agent_id; re-run enrol")
	}

	token, protector, err := loadTokenAndProtector(opts.Layout.SecretsDir(), lc.AgentID)
	if err != nil {
		return fmt.Errorf("runtime: load token: %w", err)
	}

	dbPath := filepath.Join(opts.Layout.DataRoot, "queue", "agent.db")
	db, err := queue.Open(dbPath, protector, queue.Options{})
	if err != nil {
		return fmt.Errorf("runtime: open queue: %w", err)
	}

	roots, err := loadRuntimeRootCAs()
	if err != nil {
		_ = db.Close()
		return err
	}
	if opts.rootCAs != nil {
		roots = opts.rootCAs
	}

	trusted := config.RuntimeTrustedKeys()
	if len(opts.trustedKeys) > 0 {
		trusted = opts.trustedKeys
	}
	applier, err := config.NewApplier(opts.Layout.ConfigDir(), trusted, lc.AgentID)
	if err != nil {
		_ = db.Close()
		return fmt.Errorf("runtime: config applier: %w", err)
	}

	rctx, cancel := context.WithCancel(ctx)
	logs := newFileLogger(opts.Layout.LogsDir(), opts.Out)
	budget := uploader.NewRateBudget(time.Now)
	r := &Runner{
		opts:    opts,
		local:   lc,
		token:   token,
		db:      db,
		clk:     clock.NewEstimator(),
		applier: applier,
		budget:  budget,
		logs:    logs,
		rootCtx: rctx,
		cancel:  cancel,
		hbState: hbSnapshot{outcome: "unknown", health: "unknown", updState: "idle"},
	}

	tokenFn := func() string { return token }
	pinFn := r.currentSPKIPins
	upCfg := uploader.Config{
		BaseURL:       lc.ServerURL,
		Token:         tokenFn,
		ProxyURL:      lc.ProxyURL,
		RootCAs:       roots,
		SPKIPinSource: pinFn,
	}
	upCli, err := uploader.NewClient(upCfg)
	if err != nil {
		cancel()
		_ = db.Close()
		return fmt.Errorf("runtime: uploader client: %w", err)
	}
	cfgCli, err := config.NewClient(config.ClientConfig{
		BaseURL:       lc.ServerURL,
		Token:         tokenFn,
		ProxyURL:      lc.ProxyURL,
		RootCAs:       roots,
		SPKIPinSource: pinFn,
	})
	if err != nil {
		cancel()
		_ = db.Close()
		return fmt.Errorf("runtime: config client: %w", err)
	}
	hqCli, err := hostquery.NewClient(upCfg)
	if err != nil {
		cancel()
		_ = db.Close()
		return fmt.Errorf("runtime: hostquery client: %w", err)
	}
	hbCli, err := heartbeat.NewClient(upCfg)
	if err != nil {
		cancel()
		_ = db.Close()
		return fmt.Errorf("runtime: heartbeat client: %w", err)
	}

	up := uploader.New(uploader.Options{
		Store:   queue.NewUploadStore(db),
		Client:  upCli,
		Clock:   r.clk,
		Backoff: uploader.NewBackoff(mrand.Float64),
		Budget:  budget,
		Now:     time.Now,
		NewKey:  func() string { return queue.NewUUIDv7(time.Now().UTC()) },
	})
	outbound := NewOutboundRouter(db)
	relay, err := hostquery.New(hostquery.Options{
		Sender:   hqCli,
		Outbound: outbound,
		Items:    db,
		Auth:     up,
		Budget:   budget,
		Log:      logs.Code,
		Now:      time.Now,
		NewKey:   func() string { return queue.NewUUIDv7(time.Now().UTC()) },
	})
	if err != nil {
		cancel()
		_ = db.Close()
		return fmt.Errorf("runtime: hostquery relay: %w", err)
	}

	r.cfgCli = cfgCli
	r.upCli = upCli
	r.hqCli = hqCli
	r.hbCli = hbCli
	r.up = up
	r.hqRelay = relay
	r.outbound = outbound
	r.mgr = NewManager(db, r.clk, relay, outbound, time.Now, logs.Code)

	hbSvc, err := heartbeat.New(heartbeat.Options{
		Sender:  &heartbeatSenderAdapter{cli: hbCli, clk: r.clk, r: r},
		Store:   kvCmdAdapter{db: db, s: queue.NewKVCommandStore(db)},
		Source:  r,
		Actions: r,
		Logs:    logs,
		Redact:  svc.RedactSecrets,
		Now:     time.Now,
	})
	if err != nil {
		cancel()
		_ = db.Close()
		return fmt.Errorf("runtime: heartbeat service: %w", err)
	}
	r.hbSvc = hbSvc

	// Apply cached signed config first (offline startup resilience), then fetch latest from server.
	if rawDoc, ok := applier.Current(); ok {
		if d, perr := ParseDocument(rawDoc); perr == nil {
			r.applyParsedDoc(rctx, d)
		}
	}
	_ = r.RefreshConfig(rctx)
	r.writeStatusFile()

	flushNow := make(chan struct{}, 1)
	hbNow := make(chan struct{}, 1)
	r.triggers = svc.Triggers{
		FlushNow: func() {
			select {
			case flushNow <- struct{}{}:
			default:
			}
		},
		HeartbeatNow: func() {
			select {
			case hbNow <- struct{}{}:
			default:
			}
		},
	}

	// Perform initial heartbeat immediately on startup (marks healthy on first 200 OK).
	_ = r.runHeartbeat(rctx)
	r.writeStatusFile()
	if opts.OnReady != nil {
		opts.OnReady(r.HandleServiceControl)
	}

	reqTick := time.NewTicker(svc.RequestPollInterval)
	statusTick := time.NewTicker(10 * time.Second)
	pruneTick := time.NewTicker(10 * time.Minute)
	defer reqTick.Stop()
	defer statusTick.Stop()
	defer pruneTick.Stop()

	r.wg.Add(2)
	go func() {
		defer r.wg.Done()
		r.uploadLoop(rctx, flushNow)
	}()
	go func() {
		defer r.wg.Done()
		r.heartbeatLoop(rctx, hbNow)
	}()

	for {
		select {
		case <-rctx.Done():
			cancel()
			r.mgr.Stop()
			r.wg.Wait()
			r.writeStoppedStatus()
			_ = db.Close()
			return nil
		case <-reqTick.C:
			_, _ = svc.ConsumeRequest(opts.Layout.StatusDir(), r.triggers)
		case <-statusTick.C:
			r.writeStatusFile()
		case <-pruneTick.C:
			r.docMu.RLock()
			retHours := r.doc.Upload.UploadedRetentionHours
			r.docMu.RUnlock()
			if retHours <= 0 {
				retHours = 24
			}
			_, _ = db.Truncate(time.Now().UTC(), time.Duration(retHours)*time.Hour)
		}
	}
}

func (r *Runner) HandleServiceControl(code uint32) bool {
	return svc.HandleControl(code, r.triggers)
}

func (r *Runner) uploadLoop(ctx context.Context, wake <-chan struct{}) {
	for {
		interval := r.flushInterval()
		select {
		case <-ctx.Done():
			return
		case <-wake:
		case <-time.After(interval):
		}
		for i := 0; i < 10 && ctx.Err() == nil; i++ {
			res, err := r.up.Tick(ctx)
			if err != nil || res.Submitted == 0 {
				break
			}
		}
	}
}

func (r *Runner) heartbeatLoop(ctx context.Context, wake <-chan struct{}) {
	for {
		interval := r.heartbeatInterval()
		select {
		case <-ctx.Done():
			return
		case <-wake:
		case <-time.After(interval):
		}
		_ = r.runHeartbeat(ctx)
		r.writeStatusFile()
	}
}

func (r *Runner) runHeartbeat(ctx context.Context) error {
	if err := r.hbSvc.Tick(ctx); err != nil {
		r.logs.Code("heartbeat_failed: " + err.Error())
		r.statusMu.Lock()
		r.hbState.reachable = false
		r.hbState.outcome = "failed"
		r.statusMu.Unlock()
		return err
	}
	return nil
}

func (r *Runner) flushInterval() time.Duration {
	r.docMu.RLock()
	s := r.doc.Upload.FlushIntervalSeconds
	r.docMu.RUnlock()
	if s <= 0 {
		s = 5
	}
	return time.Duration(s) * time.Second
}

func (r *Runner) heartbeatInterval() time.Duration {
	r.docMu.RLock()
	s := r.doc.HeartbeatIntervalSeconds
	r.docMu.RUnlock()
	if s <= 0 {
		s = 60
	}
	return time.Duration(s) * time.Second
}

func (r *Runner) currentSPKIPins() []string {
	r.docMu.RLock()
	pins := slices.Clone(r.doc.TLS.SPKIPinsSHA256)
	r.docMu.RUnlock()
	return pins
}

func (r *Runner) RefreshConfig(ctx context.Context) error {
	r.refreshMu.Lock()
	defer r.refreshMu.Unlock()
	raw, err := r.cfgCli.Fetch(ctx)
	if err != nil {
		r.logs.Code("config_fetch_failed")
		return err
	}
	out, err := r.applier.Apply(raw)
	if err != nil {
		r.logs.Code("config_apply_rejected")
		return err
	}
	if cur, ok := r.applier.Current(); ok {
		d, perr := ParseDocument(cur)
		if perr != nil {
			r.logs.Code("config_invalid")
			return perr
		}
		r.applyParsedDoc(ctx, d)
		if out.Applied && !out.NoOp {
			_, _ = queue.NewUploadStore(r.db).RequeueRejected(int(d.ConfigVersion))
			r.logs.Code("config_applied")
		}
	}
	return nil
}

func (r *Runner) applyParsedDoc(ctx context.Context, d Document) {
	r.docMu.Lock()
	pinsChanged := !slices.Equal(r.doc.TLS.SPKIPinsSHA256, d.TLS.SPKIPinsSHA256)
	r.doc = d
	r.docMu.Unlock()
	if pinsChanged {
		r.cfgCli.CloseIdleConnections()
		r.upCli.CloseIdleConnections()
		r.hqCli.CloseIdleConnections()
		r.hbCli.CloseIdleConnections()
	}
	if d.RateBudget.RequestsPerMinute > 0 {
		r.budget.SetRates(d.RateBudget.RequestsPerMinute, d.RateBudget.ReservedHostQueryPerMinute, d.RateBudget.ReservedHeartbeatPerMinute)
	}
	r.up.SetBatchLimits(d.Upload.MaxBatchMessages, d.Upload.MaxBatchBytes)
	r.up.SetConfigVersion(int(d.ConfigVersion))
	r.mgr.Apply(ctx, d.Instruments)
}

func (r *Runner) RestartService(_ context.Context) error {
	r.restart.Store(true)
	r.cancel()
	return nil
}

func (r *Runner) RequeueUploadedSince(_ context.Context, since time.Time) (int, error) {
	return r.db.RequeueUploadedSince(since)
}

func (r *Runner) Snapshot() heartbeat.Report {
	now := time.Now().UTC()
	qs, _ := r.db.QueueStats(now)
	freeBytes, _ := r.db.FreeBytes()
	offMs, uncMs, ok := r.clk.Current(now)
	if !ok {
		offMs, uncMs = 0, 0
	}
	cfgRep := r.applier.Report()
	hbs, _, cnt := r.mgr.Snapshot(true)

	r.statusMu.Lock()
	upd := heartbeat.UpdateState{
		State:         r.hbState.updState,
		TargetVersion: r.hbState.updVer,
		ErrorCode:     r.hbState.updErr,
	}
	r.statusMu.Unlock()
	if upd.State == "" {
		upd.State = "idle"
	}

	return heartbeat.Report{
		SentAtAgent:              now.Format(tsUTC),
		AgentVersion:             r.opts.AgentVersion,
		LauncherVersion:          r.opts.LauncherVersion,
		OSVersion:                r.opts.OSVersion,
		Queue: heartbeat.Queue{
			Pending:                 qs.Pending,
			Uploading:               qs.Uploading,
			Rejected:                qs.Rejected,
			Oversize:                qs.Oversize,
			UploadedRetained:        qs.UploadedRetained,
			OldestPendingAgeSeconds: qs.OldestPendingAgeSeconds,
		},
		DiskFreeMB:               freeBytes / (1 << 20),
		ClockOffsetMs:            offMs,
		ClockOffsetUncertaintyMs: uncMs,
		Config: heartbeat.ConfigState{
			AppliedVersion: int(cfgRep.ConfigVersionApplied),
			State:          cfgRep.ConfigState,
		},
		Update:      upd,
		AuthState:   r.up.AuthState(),
		Instruments: hbs,
		Counters:    cnt,
	}
}

func (r *Runner) writeStatusFile() {
	r.writeStatus("running")
}

func (r *Runner) writeStoppedStatus() {
	r.writeStatus("stopped")
}

func (r *Runner) writeStatus(serviceState string) {
	now := time.Now().UTC()
	qs, _ := r.db.QueueStats(now)
	freeBytes, _ := r.db.FreeBytes()
	cfgRep := r.applier.Report()
	_, sts, cnt := r.mgr.Snapshot(false)

	r.statusMu.Lock()
	hb := r.hbState
	r.statusMu.Unlock()

	st := status.Status{
		ServiceState:         serviceState,
		AgentID:              r.local.AgentID,
		AgentVersion:         r.opts.AgentVersion,
		LauncherVersion:      r.opts.LauncherVersion,
		ServerReachable:      hb.reachable,
		LastHeartbeatAt:      hb.lastAt,
		LastHeartbeatOutcome: hb.outcome,
		AuthState:            r.up.AuthState(),
		ConfigVersion:        int(cfgRep.ConfigVersionApplied),
		ConfigState:          cfgRep.ConfigState,
		UpdateState:          hb.updState,
		Queue: status.Queue{
			Pending:                 qs.Pending,
			Uploading:               qs.Uploading,
			Rejected:                qs.Rejected,
			Oversize:                qs.Oversize,
			UploadedRetained:        qs.UploadedRetained,
			OldestPendingAgeSeconds: qs.OldestPendingAgeSeconds,
		},
		DiskFreeMB:  freeBytes / (1 << 20),
		Instruments: sts,
		Counters: map[string]int64{
			"astm_naks_sent":           int64(cnt.AstmNaksSent),
			"astm_naks_received":       int64(cnt.AstmNaksReceived),
			"astm_incomplete_sessions": int64(cnt.AstmIncompleteSessions),
			"mllp_discarded_bytes":     int64(cnt.MllpDiscardedBytes),
			"mllp_oversize":            int64(cnt.MllpOversize),
			"host_query_unavailable":   int64(cnt.HostQueryUnavailable),
		},
	}
	_ = status.Write(r.opts.Layout.StatusDir(), st)
}

func (r *Runner) writeHealthyMarker() {
	if r.opts.AgentVersion == "" {
		return
	}
	_ = update.MarkHealthy(r.opts.Layout.DataRoot, r.opts.AgentVersion)
}

func loadTokenAndProtector(secretsDir, agentID string) (string, secrets.Protector, error) {
	ent := []byte(agentID)
	pu := secrets.NewDPAPI(secrets.ScopeUser, ent)
	if tok, err := secrets.LoadToken(secretsDir, pu); err == nil {
		return tok, pu, nil
	}
	pm := secrets.NewDPAPI(secrets.ScopeMachine, ent)
	tok, err := secrets.LoadToken(secretsDir, pm)
	if err != nil {
		return "", nil, err
	}
	return tok, pm, nil
}

type heartbeatSenderAdapter struct {
	cli *heartbeat.Client
	clk *clock.Estimator
	r   *Runner
}

func (a *heartbeatSenderAdapter) Heartbeat(ctx context.Context, rep heartbeat.Report) (heartbeat.Response, error) {
	tSend := time.Now().UTC()
	resp, err := a.cli.Heartbeat(ctx, rep)
	tRecv := time.Now().UTC()
	if err != nil {
		return heartbeat.Response{}, err
	}
	if st, perr := time.Parse(time.RFC3339Nano, resp.ServerTime); perr == nil && a.clk != nil {
		a.clk.Observe(tSend, tRecv, st)
	}
	a.r.statusMu.Lock()
	a.r.hbState.reachable = true
	a.r.hbState.lastAt = tRecv.Format(tsUTC)
	a.r.hbState.outcome = "ok"
	a.r.hbState.health = resp.HealthState
	a.r.statusMu.Unlock()

	a.r.healthyOnce.Do(func() {
		a.r.writeHealthyMarker()
	})
	if int64(resp.LatestConfigVersion) > a.r.applier.Report().ConfigVersionApplied {
		if a.r.refreshQueued.CompareAndSwap(false, true) {
			a.r.wg.Add(1)
			go func() {
				defer a.r.wg.Done()
				defer a.r.refreshQueued.Store(false)
				_ = a.r.RefreshConfig(a.r.rootCtx)
			}()
		}
	}
	return resp, nil
}

func (a *heartbeatSenderAdapter) SubmitLogBundle(ctx context.Context, b heartbeat.LogBundle) (string, error) {
	return a.cli.SubmitLogBundle(ctx, b)
}

type kvCmdAdapter struct {
	db *queue.DB
	s  *queue.KVCommandStore
}

func (a kvCmdAdapter) Get(id string) (heartbeat.CommandRecord, bool, error) {
	rec, ok, err := a.s.Get(id)
	return heartbeat.CommandRecord{
		CommandID: rec.CommandID, Kind: rec.Kind, State: rec.State, ResultCode: rec.ResultCode, Acked: rec.Acked,
	}, ok, err
}

func (a kvCmdAdapter) Put(r heartbeat.CommandRecord) error {
	return a.s.Put(queue.KVCommandRecord{
		CommandID: r.CommandID, Kind: r.Kind, State: r.State, ResultCode: r.ResultCode, Acked: r.Acked,
	})
}

func (a kvCmdAdapter) Unacked(limit int) ([]heartbeat.CommandRecord, error) {
	recs, err := a.s.Unacked(limit)
	if err != nil {
		return nil, err
	}
	out := make([]heartbeat.CommandRecord, 0, len(recs))
	for _, r := range recs {
		out = append(out, heartbeat.CommandRecord{
			CommandID: r.CommandID, Kind: r.Kind, State: r.State, ResultCode: r.ResultCode, Acked: r.Acked,
		})
	}
	return out, nil
}

func (a kvCmdAdapter) Ack(ids []string) error { return a.s.Ack(ids) }

type fileLogger struct {
	dir string
	out io.Writer
	mu  sync.Mutex
}

func newFileLogger(dir string, out io.Writer) *fileLogger {
	return &fileLogger{dir: dir, out: out}
}

func (l *fileLogger) Code(code string) {
	clean := strings.NewReplacer("\r", " ", "\n", " ").Replace(svc.RedactSecrets(strings.TrimSpace(code)))
	if clean == "" {
		return
	}
	now := time.Now().UTC()
	line := now.Format(tsUTC) + " " + clean
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.out != nil {
		_, _ = fmt.Fprintln(l.out, line)
	}
	p := filepath.Join(l.dir, "agent-"+now.Format("2006-01-02")+".log")
	f, err := os.OpenFile(p, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err == nil {
		_, _ = fmt.Fprintln(f, line)
		_ = f.Close()
	}
}

func (l *fileLogger) Lines(from, to time.Time) ([]string, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	ents, err := os.ReadDir(l.dir)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var out []string
	for _, e := range ents {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".log") {
			continue
		}
		raw, rerr := os.ReadFile(filepath.Join(l.dir, e.Name()))
		if rerr != nil {
			continue
		}
		for _, ln := range strings.Split(string(raw), "\n") {
			ln = strings.TrimSpace(ln)
			if ln == "" {
				continue
			}
			sp := strings.IndexByte(ln, ' ')
			if sp > 0 {
				if ts, perr := time.Parse(tsUTC, ln[:sp]); perr == nil {
					if ts.Before(from) || ts.After(to) {
						continue
					}
				}
			}
			out = append(out, svc.RedactSecrets(ln))
		}
	}
	return out, nil
}

