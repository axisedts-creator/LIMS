//go:build e2e

// INT-T01 test build of the agent core: real link layers (ASTM receiver, MLLP), queue, uploader and verified-TLS client,
// driven by a JSON file instead of the Windows service/config pipeline. Never shipped (release builds have no `e2e` tag).
// Usage: agent -config <file.json>; env AGENT_E2E_DEVICE_TOKEN; prints READY once every listener/connection is up.
package main

import (
	"context"
	"crypto/rand"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"slices"
	"strconv"
	"sync"
	"syscall"
	"time"

	"lims/apps/bridge-agent/internal/astm"
	"lims/apps/bridge-agent/internal/drivers"
	"lims/apps/bridge-agent/internal/hl7"
	"lims/apps/bridge-agent/internal/hostquery"
	"lims/apps/bridge-agent/internal/mllp"
	"lims/apps/bridge-agent/internal/queue"
	"lims/apps/bridge-agent/internal/transport/tcp"
	"lims/apps/bridge-agent/internal/uploader"
)

type instrumentCfg struct {
	InstrumentID string `json:"instrument_id"`
	Protocol     string `json:"protocol"`  // astm | hl7v2
	Transport    string `json:"transport"` // serial_pipe | tcp_listen
	PipePath     string `json:"pipe_path"`
	Listen       string `json:"listen"`
	// Profile (optional driver code; H80-T05, LD-139): take that SessionProfile (internal/drivers) and relay its host queries
	// to the API (E05). Empty = today's behaviour (the C5 e2e).
	Profile string `json:"profile"`
}

type agentCfg struct {
	APIBaseURL      string          `json:"api_base_url"`
	TLSRootCAPath   string          `json:"tls_root_ca_pem_path"`
	StateDir        string          `json:"state_dir"`
	FlushIntervalMs int             `json:"flush_interval_ms"`
	Instruments     []instrumentCfg `json:"instruments"`
}

const tsFmt = "2006-01-02T15:04:05.000Z" // agent timestamps, same text form as the queue

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "agent:", err)
		os.Exit(1)
	}
}

func run() error {
	path := flag.String("config", "", "path to the e2e config JSON")
	flag.Parse()
	raw, err := os.ReadFile(*path)
	if err != nil {
		return err
	}
	var cfg agentCfg
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return fmt.Errorf("config: %w", err)
	}
	token := os.Getenv("AGENT_E2E_DEVICE_TOKEN")
	if token == "" || cfg.StateDir == "" || len(cfg.Instruments) == 0 {
		return errors.New("config: AGENT_E2E_DEVICE_TOKEN, state_dir and instruments are required")
	}
	if cfg.FlushIntervalMs <= 0 {
		cfg.FlushIntervalMs = 1000
	}

	var pool *x509.CertPool // nil = system roots; the test passes its throwaway CA
	if cfg.TLSRootCAPath != "" {
		pem, err := os.ReadFile(cfg.TLSRootCAPath)
		if err != nil {
			return err
		}
		pool = x509.NewCertPool()
		if !pool.AppendCertsFromPEM(pem) {
			return errors.New("config: tls_root_ca_pem_path holds no certificate")
		}
	}
	client, err := uploader.NewClient(uploader.Config{BaseURL: cfg.APIBaseURL, Token: func() string { return token }, RootCAs: pool})
	if err != nil {
		return err
	}
	// MinFreeBytes lowered so a nearly full CI disk does not NAK the simulator; the 500 MB guard is exercised by AG-T04.
	db, err := queue.Open(filepath.Join(cfg.StateDir, "queue.db"), noWrap{}, queue.Options{MinFreeBytes: 16 << 20})
	if err != nil {
		return err
	}
	defer db.Close()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	ready := make(chan error, len(cfg.Instruments))
	var wg sync.WaitGroup
	for _, in := range cfg.Instruments {
		wg.Add(1)
		go func() {
			defer wg.Done()
			switch {
			case in.Protocol == "astm" && in.Transport == "serial_pipe":
				serveASTM(ctx, db, in, ready)
			case in.Protocol == "hl7v2" && in.Transport == "tcp_listen":
				serveHL7(ctx, db, in, hqEnv{cfg.APIBaseURL, token, pool}, ready)
			default:
				ready <- fmt.Errorf("config: unsupported instrument %s/%s", in.Protocol, in.Transport)
			}
		}()
	}
	for range cfg.Instruments {
		select {
		case err := <-ready:
			if err != nil {
				return err
			}
		case <-ctx.Done():
			return nil
		}
	}

	up := uploader.New(uploader.Options{Store: queue.NewUploadStore(db), Client: client})
	wg.Add(1)
	go func() {
		defer wg.Done()
		t := time.NewTicker(time.Duration(cfg.FlushIntervalMs) * time.Millisecond)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				if _, err := up.Tick(ctx); err != nil && ctx.Err() == nil {
					log.Printf("upload: %v", err) // error text only, never message bytes (PHI)
				}
			}
		}
	}()
	fmt.Println("READY")
	<-ctx.Done()
	wg.Wait()
	return nil
}

// serveASTM connects to the pipe the simulator serves (reconnecting while it is absent) and feeds the E1381 receiver.
// One goroutine reads, feeds and writes the reply, so there is never a concurrent read and write on the pipe handle.
func serveASTM(ctx context.Context, db *queue.DB, in instrumentCfg, ready chan<- error) {
	rcv := astm.NewReceiver(astm.ReceiverConfig{InstrumentID: in.InstrumentID, Queue: db, Clock: wallClock{}, NewID: newID})
	var mu sync.Mutex // Receiver is single-goroutine: reads and the frame-wait Tick share it
	if _, err := rcv.Recover(); err != nil {
		log.Printf("astm recover: %v", err)
	}
	go func() {
		t := time.NewTicker(time.Second)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				mu.Lock()
				rcv.Tick()
				mu.Unlock()
			}
		}
	}()
	first := true
	for ctx.Err() == nil {
		conn, err := dialPipe(in.PipePath)
		if err != nil {
			time.Sleep(200 * time.Millisecond)
			continue
		}
		if first {
			first = false
			ready <- nil
		}
		buf := make([]byte, 4096)
		for {
			n, err := conn.Read(buf)
			if n > 0 {
				mu.Lock()
				out := rcv.Feed(buf[:n])
				mu.Unlock()
				if len(out) > 0 {
					if _, werr := conn.Write(out); werr != nil {
						err = werr
					}
				}
			}
			if err != nil {
				break
			}
		}
		_ = conn.Close()
	}
}

// serveHL7 listens for the analyser (MLLP over TCP); ACK is written only after the message is durable (mllp.Serve).
func serveHL7(ctx context.Context, db *queue.DB, in instrumentCfg, env hqEnv, ready chan<- error) {
	var prof *drivers.SessionProfile
	var relay *hostquery.Relay
	if in.Profile != "" {
		res := drivers.Resolve(in.Profile, in.Protocol)
		if !res.Known {
			ready <- fmt.Errorf("config: no agent profile %q for %s", in.Profile, in.Protocol)
			return
		}
		prof = &res.Profile
		c, err := hostquery.NewClient(uploader.Config{BaseURL: env.baseURL, Token: func() string { return env.token }, RootCAs: env.pool})
		if err == nil {
			relay, err = hostquery.New(hostquery.Options{Sender: c, Outbound: replies, Items: db, Auth: authOK{}})
		}
		if err != nil {
			ready <- err
			return
		}
	}
	host, ps, err := net.SplitHostPort(in.Listen)
	port, perr := strconv.Atoi(ps)
	if err != nil || perr != nil {
		ready <- fmt.Errorf("config: listen %q is not host:port", in.Listen)
		return
	}
	ln, err := tcp.Listen(tcp.ListenConfig{BindAddress: host, Port: port, AllowedPeers: []string{"127.0.0.1"}}) // the simulator is local
	if err != nil {
		ready <- err
		return
	}
	defer ln.Close()
	go func() { <-ctx.Done(); _ = ln.Close() }()
	ready <- nil
	for {
		conn, err := ln.Accept(ctx)
		if err != nil {
			return
		}
		sink := &hl7Sink{db: db, instrumentID: in.InstrumentID}
		cfg := mllp.Config{Sink: sink, AckSendingApp: "LIMS-BRIDGE"}
		if prof != nil { // LD-139: the analyser's profile; a host query is committed as kind host_query, then relayed (E05)
			sink.hqTypes = prof.HostQueryMessageTypes
			cfg.AckMode, cfg.AckTypeFormat = prof.HL7AckMode, prof.HL7AckMessageTypeFormat
			if prof.HL7AckFullForm { // MET-T01: §6 ACK; sender names LIS/LIMS (U3) instead of the e2e's LIMS-BRIDGE
				cfg.AckFullForm, cfg.AckSendingApp = true, ""
			}
			cfg.HostQueryTypes, cfg.ExpectAckOnReply, cfg.ReplyAckPolicy = prof.HostQueryMessageTypes, prof.ExpectAckOnReply, prof.ReplyAckPolicy
			cfg.ReplyAckMatchControlId, cfg.ReplyTimeout = prof.ReplyAckMatchControlId, prof.ReplyTimeout
			cfg.HostQuery = func(raw []byte, _ hl7.MSH) [][]byte {
				relay.Handle(ctx, hostquery.Query{ItemID: sink.hqItem, InstrumentID: in.InstrumentID, Protocol: "hl7v2",
					Raw: raw, CapturedAt: time.Now(), ReplyTimeout: prof.ReplyTimeout})
				return replies.drain() // empty when the API was unreachable: write nothing (AC-10.6)
			}
		}
		go func() { _ = mllp.Serve(conn, cfg) }()
	}
}

// hqEnv is what the relay's E05 client needs (same https client settings as the uploader).
type hqEnv struct {
	baseURL, token string
	pool           *x509.CertPool
}

// replies collects the relay's reply messages for the in-flight query (the test build answers one query at a time).
var replies = &replyCollector{}

type replyCollector struct {
	mu   sync.Mutex
	msgs [][]byte
}

func (c *replyCollector) Enqueue(_ string, msg []byte, _ time.Time) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.msgs = append(c.msgs, append([]byte(nil), msg...))
	return nil
}

func (c *replyCollector) drain() [][]byte {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := c.msgs
	c.msgs = nil
	return out
}

type authOK struct{}

func (authOK) AuthState() string { return "ok" }

type hl7Sink struct {
	db           *queue.DB
	instrumentID string
	hqTypes      []string
	hqItem       string // item id of the host query being answered (one Serve per connection, reads are serial)
}

func (s *hl7Sink) CommitMessage(raw []byte, msh hl7.MSH) error {
	if slices.Contains(s.hqTypes, msh.MessageType) {
		s.hqItem = newID()
		return s.putID(s.hqItem, "host_query", raw, "")
	}
	return s.put("data", raw, "")
}

func (s *hl7Sink) CommitIncomplete(raw []byte, reason string) error {
	return s.put("incomplete", raw, reason)
}

func (s *hl7Sink) put(kind string, raw []byte, reason string) error {
	return s.putID(newID(), kind, raw, reason)
}

func (s *hl7Sink) putID(id, kind string, raw []byte, reason string) error {
	meta := []byte(`{}`)
	if reason != "" {
		meta, _ = json.Marshal(map[string]any{"link_meta": map[string]string{"incomplete_reason": reason}})
	}
	return s.db.InsertItem(queue.ItemInput{ID: id, InstrumentID: s.instrumentID, Kind: kind, Protocol: "hl7v2",
		Raw: raw, Meta: meta, CapturedAtAgent: time.Now().UTC().Format(tsFmt)})
}

type wallClock struct{}

func (wallClock) Now() time.Time { return time.Now() }

// noWrap is the test build's data-key protector: no DPAPI off Windows, and the e2e queue holds synthetic data only.
type noWrap struct{}

func (noWrap) Protect(p []byte) ([]byte, error)   { return append([]byte(nil), p...), nil }
func (noWrap) Unprotect(b []byte) ([]byte, error) { return append([]byte(nil), b...), nil }

// newID is a random UUID (v4); the API takes any UUID as agent_message_id.
func newID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6], b[8] = b[6]&0x0f|0x40, b[8]&0x3f|0x80
	h := hex.EncodeToString(b[:])
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:]
}
