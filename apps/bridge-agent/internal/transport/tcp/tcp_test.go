package tcp_test

import (
	"bytes"
	"context"
	"io"
	"net"
	"strconv"
	"testing"
	"time"

	"lims/apps/bridge-agent/internal/transport/tcp"
)

// ---- helpers ----

func listenLoopback(t *testing.T, peers ...string) *tcp.Listener {
	t.Helper()
	// Listen() does not apply ValidateListenConfig (the config layer does);
	// tests need loopback + ephemeral port, which validation forbids.
	l, err := tcp.Listen(tcp.ListenConfig{BindAddress: "127.0.0.1", Port: 0, AllowedPeers: peers})
	if err != nil {
		t.Fatalf("Listen: %v", err)
	}
	t.Cleanup(func() { l.Close() })
	return l
}

func port(t *testing.T, a net.Addr) int {
	t.Helper()
	return a.(*net.TCPAddr).Port
}

func acceptCtx(t *testing.T, l *tcp.Listener, d time.Duration) (net.Conn, error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), d)
	defer cancel()
	return l.Accept(ctx)
}

func eventually(t *testing.T, what string, f func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if f() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timeout waiting for %s", what)
}

func readN(t *testing.T, c net.Conn, n int) []byte {
	t.Helper()
	c.SetReadDeadline(time.Now().Add(5 * time.Second))
	buf := make([]byte, n)
	if _, err := io.ReadFull(c, buf); err != nil {
		t.Fatalf("ReadFull(%d): %v", n, err)
	}
	return buf
}

// expectClosed: the peer must see EOF/reset quickly (connection closed on us).
func expectClosed(t *testing.T, c net.Conn) {
	t.Helper()
	c.SetReadDeadline(time.Now().Add(3 * time.Second))
	_, err := c.Read(make([]byte, 1))
	if err == nil {
		t.Fatal("expected connection to be closed, but read succeeded")
	}
	if ne, ok := err.(net.Error); ok && ne.Timeout() {
		t.Fatalf("connection was not closed (read timed out): %v", err)
	}
}

func freePort(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	p := ln.Addr().(*net.TCPAddr).Port
	ln.Close()
	return p
}

// ---- ValidateListenConfig (02-TRD §5.8 tcp_server; REQ-SEC-114) ----

func TestValidateListenConfig(t *testing.T) {
	ok := tcp.ListenConfig{BindAddress: "192.168.1.10", Port: 5000, AllowedPeers: []string{"192.168.1.20"}}
	if err := tcp.ValidateListenConfig(ok); err != nil {
		t.Fatalf("valid config rejected: %v", err)
	}
	nine := []string{"10.0.0.1", "10.0.0.2", "10.0.0.3", "10.0.0.4", "10.0.0.5", "10.0.0.6", "10.0.0.7", "10.0.0.8", "10.0.0.9"}
	cases := []struct {
		name string
		mut  func(c *tcp.ListenConfig)
	}{
		{"wildcard bind", func(c *tcp.ListenConfig) { c.BindAddress = "0.0.0.0" }},
		{"loopback bind", func(c *tcp.ListenConfig) { c.BindAddress = "127.0.0.1" }},
		{"other loopback bind", func(c *tcp.ListenConfig) { c.BindAddress = "127.5.5.5" }},
		{"ipv6 bind", func(c *tcp.ListenConfig) { c.BindAddress = "::1" }},
		{"ipv6 wildcard bind", func(c *tcp.ListenConfig) { c.BindAddress = "::" }},
		{"hostname bind", func(c *tcp.ListenConfig) { c.BindAddress = "lab-pc" }},
		{"empty bind", func(c *tcp.ListenConfig) { c.BindAddress = "" }},
		{"port below 1024", func(c *tcp.ListenConfig) { c.Port = 1023 }},
		{"port zero", func(c *tcp.ListenConfig) { c.Port = 0 }},
		{"port above 65535", func(c *tcp.ListenConfig) { c.Port = 65536 }},
		{"no peers", func(c *tcp.ListenConfig) { c.AllowedPeers = nil }},
		{"nine peers", func(c *tcp.ListenConfig) { c.AllowedPeers = nine }},
		{"peer is CIDR", func(c *tcp.ListenConfig) { c.AllowedPeers = []string{"10.0.0.0/8"} }},
		{"peer is hostname", func(c *tcp.ListenConfig) { c.AllowedPeers = []string{"analyser.lab"} }},
		{"peer is ipv6", func(c *tcp.ListenConfig) { c.AllowedPeers = []string{"::1"} }},
		{"peer is wildcard", func(c *tcp.ListenConfig) { c.AllowedPeers = []string{"0.0.0.0"} }},
		{"one bad peer among good", func(c *tcp.ListenConfig) { c.AllowedPeers = []string{"10.0.0.1", "nope"} }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c := ok
			c.AllowedPeers = append([]string(nil), ok.AllowedPeers...)
			tc.mut(&c)
			if err := tcp.ValidateListenConfig(c); err == nil {
				t.Fatalf("expected error for %+v", c)
			}
		})
	}
	c := ok
	c.AllowedPeers = nine[:8]
	if err := tcp.ValidateListenConfig(c); err != nil {
		t.Fatalf("8 peers must be accepted: %v", err)
	}
}

// ---- ValidateClientConfig (02-TRD §5.8 tcp_client) ----

func TestValidateClientConfig(t *testing.T) {
	ok := tcp.ClientConfig{Host: "192.168.1.30", Port: 4001, ConnectTimeout: 10 * time.Second, ReconnectMaxBackoff: 60 * time.Second}
	if err := tcp.ValidateClientConfig(ok); err != nil {
		t.Fatalf("valid config rejected: %v", err)
	}
	long := bytes.Repeat([]byte("a"), 254)
	cases := []struct {
		name string
		mut  func(c *tcp.ClientConfig)
	}{
		{"empty host", func(c *tcp.ClientConfig) { c.Host = "" }},
		{"host with space", func(c *tcp.ClientConfig) { c.Host = "a b" }},
		{"host with slash", func(c *tcp.ClientConfig) { c.Host = "evil/host" }},
		{"host with port", func(c *tcp.ClientConfig) { c.Host = "10.0.0.1:80" }},
		{"host too long", func(c *tcp.ClientConfig) { c.Host = string(long) }},
		{"port zero", func(c *tcp.ClientConfig) { c.Port = 0 }},
		{"port too high", func(c *tcp.ClientConfig) { c.Port = 65536 }},
		{"connect timeout below 1s", func(c *tcp.ClientConfig) { c.ConnectTimeout = 500 * time.Millisecond }},
		{"connect timeout above 60s", func(c *tcp.ClientConfig) { c.ConnectTimeout = 61 * time.Second }},
		{"backoff below 1s", func(c *tcp.ClientConfig) { c.ReconnectMaxBackoff = 500 * time.Millisecond }},
		{"backoff above 300s", func(c *tcp.ClientConfig) { c.ReconnectMaxBackoff = 301 * time.Second }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c := ok
			tc.mut(&c)
			if err := tcp.ValidateClientConfig(c); err == nil {
				t.Fatalf("expected error for %+v", c)
			}
		})
	}
	for _, c := range []tcp.ClientConfig{
		{Host: "a", Port: 1, ConnectTimeout: time.Second, ReconnectMaxBackoff: time.Second},
		{Host: "Lab-Analyser.example.org", Port: 65535, ConnectTimeout: 60 * time.Second, ReconnectMaxBackoff: 300 * time.Second},
	} {
		if err := tcp.ValidateClientConfig(c); err != nil {
			t.Fatalf("boundary config %+v rejected: %v", c, err)
		}
	}
}

// ---- Backoff (03-APP-FLOW §3.3: 1 s -> reconnect_max_backoff_s) ----

func TestBackoff(t *testing.T) {
	max := 10 * time.Second
	want := []time.Duration{1, 2, 4, 8, 10, 10, 10}
	for i, w := range want {
		if got := tcp.Backoff(i, max); got != w*time.Second {
			t.Errorf("Backoff(%d,%v)=%v want %v", i, max, got, w*time.Second)
		}
	}
	if got := tcp.Backoff(10_000, 300*time.Second); got != 300*time.Second {
		t.Errorf("Backoff(10000)=%v want 300s (overflow?)", got)
	}
	if got := tcp.Backoff(0, time.Second); got != time.Second {
		t.Errorf("Backoff(0,1s)=%v", got)
	}
}

// ---- Client: Dial + Reconnect ----

func TestDialLoopbackRoundTrip(t *testing.T) {
	l := listenLoopback(t, "127.0.0.1")
	type res struct {
		c   net.Conn
		err error
	}
	ch := make(chan res, 1)
	go func() { c, err := acceptCtx(t, l, 5*time.Second); ch <- res{c, err} }()

	cc, err := tcp.Dial(context.Background(), tcp.ClientConfig{Host: "127.0.0.1", Port: port(t, l.Addr()), ConnectTimeout: 2 * time.Second})
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	defer cc.Close()
	r := <-ch
	if r.err != nil {
		t.Fatalf("Accept: %v", r.err)
	}
	defer r.c.Close()

	cc.Write([]byte("ping"))
	if got := readN(t, r.c, 4); string(got) != "ping" {
		t.Fatalf("server got %q", got)
	}
	r.c.Write([]byte("pong"))
	if got := readN(t, cc, 4); string(got) != "pong" {
		t.Fatalf("client got %q", got)
	}
}

func TestDialRefusedReturnsErrorWithinConnectTimeout(t *testing.T) {
	start := time.Now()
	_, err := tcp.Dial(context.Background(), tcp.ClientConfig{Host: "127.0.0.1", Port: freePort(t), ConnectTimeout: 2 * time.Second})
	if err == nil {
		t.Fatal("expected error dialing closed port")
	}
	if time.Since(start) > 4*time.Second {
		t.Fatalf("Dial took %v, exceeds connect timeout", time.Since(start))
	}
}

func TestDialHonoursContextCancel(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	// 192.0.2.1 is TEST-NET-1 (unroutable); a cancelled ctx must return promptly.
	start := time.Now()
	_, err := tcp.Dial(ctx, tcp.ClientConfig{Host: "192.0.2.1", Port: 9, ConnectTimeout: 30 * time.Second})
	if err == nil {
		t.Fatal("expected error")
	}
	if time.Since(start) > 2*time.Second {
		t.Fatalf("Dial ignored cancelled context (%v)", time.Since(start))
	}
}

func TestReconnectBacksOffThenConnects(t *testing.T) {
	p := freePort(t)
	var delays []time.Duration
	var late net.Listener
	t.Cleanup(func() {
		if late != nil {
			late.Close()
		}
	})
	sleep := func(ctx context.Context, d time.Duration) error {
		delays = append(delays, d)
		if len(delays) == 3 { // instrument comes up after the 3rd wait
			ln, err := net.Listen("tcp", "127.0.0.1:"+strconv.Itoa(p))
			if err != nil {
				t.Fatalf("late listen: %v", err)
			}
			late = ln
			go func() {
				c, err := ln.Accept()
				if err == nil {
					c.Write([]byte("hi"))
					time.Sleep(200 * time.Millisecond)
					c.Close()
				}
			}()
		}
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	c, err := tcp.Reconnect(ctx, tcp.ClientConfig{Host: "127.0.0.1", Port: p, ConnectTimeout: time.Second, ReconnectMaxBackoff: 60 * time.Second}, sleep)
	if err != nil {
		t.Fatalf("Reconnect: %v", err)
	}
	defer c.Close()
	want := []time.Duration{time.Second, 2 * time.Second, 4 * time.Second}
	if len(delays) != 3 || delays[0] != want[0] || delays[1] != want[1] || delays[2] != want[2] {
		t.Fatalf("delays=%v want %v", delays, want)
	}
	if got := readN(t, c, 2); string(got) != "hi" {
		t.Fatalf("got %q", got)
	}
}

func TestReconnectCapsBackoffAtConfiguredMax(t *testing.T) {
	p := freePort(t)
	var delays []time.Duration
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	sleep := func(_ context.Context, d time.Duration) error {
		delays = append(delays, d)
		if len(delays) == 5 {
			cancel()
			return ctx.Err()
		}
		return nil
	}
	_, err := tcp.Reconnect(ctx, tcp.ClientConfig{Host: "127.0.0.1", Port: p, ConnectTimeout: time.Second, ReconnectMaxBackoff: 3 * time.Second}, sleep)
	if err == nil {
		t.Fatal("expected error after cancel")
	}
	want := []time.Duration{1, 2, 3, 3, 3}
	if len(delays) != len(want) {
		t.Fatalf("delays=%v", delays)
	}
	for i := range want {
		if delays[i] != want[i]*time.Second {
			t.Fatalf("delays=%v want %vs", delays, want)
		}
	}
}

func TestReconnectStopsOnContextDeadlineWithDefaultSleep(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	start := time.Now()
	// nil sleep = real, ctx-aware sleep
	_, err := tcp.Reconnect(ctx, tcp.ClientConfig{Host: "127.0.0.1", Port: freePort(t), ConnectTimeout: time.Second, ReconnectMaxBackoff: 60 * time.Second}, nil)
	if err == nil {
		t.Fatal("expected error")
	}
	if time.Since(start) > 3*time.Second {
		t.Fatalf("Reconnect did not honour ctx deadline (%v)", time.Since(start))
	}
}

// ---- Listener: peer allowlist (REQ-SEC-114, 03-APP-FLOW §3.3) ----

func TestListenerAcceptsAllowedPeer(t *testing.T) {
	l := listenLoopback(t, "127.0.0.1")
	go func() {
		c, err := net.Dial("tcp", l.Addr().String())
		if err == nil {
			c.Write([]byte("x"))
			time.Sleep(300 * time.Millisecond)
			c.Close()
		}
	}()
	c, err := acceptCtx(t, l, 5*time.Second)
	if err != nil {
		t.Fatalf("Accept: %v", err)
	}
	defer c.Close()
	if got := readN(t, c, 1); string(got) != "x" {
		t.Fatalf("got %q", got)
	}
	if l.Rejected() != 0 {
		t.Fatalf("Rejected=%d want 0", l.Rejected())
	}
}

func TestListenerClosesDisallowedPeerImmediately(t *testing.T) {
	l := listenLoopback(t, "10.9.9.9") // our loopback dialer is NOT on the list
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	accepted := make(chan net.Conn, 1)
	go func() {
		c, err := l.Accept(ctx)
		if err == nil {
			accepted <- c
		}
	}()

	c, err := net.Dial("tcp", l.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	expectClosed(t, c)
	eventually(t, "Rejected()==1", func() bool { return l.Rejected() == 1 })
	select {
	case <-accepted:
		t.Fatal("Accept returned a connection from a disallowed peer")
	case <-time.After(200 * time.Millisecond):
	}
}

func TestListenerDisallowedPeerCannotInjectData(t *testing.T) {
	l := listenLoopback(t, "10.9.9.9")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go l.Accept(ctx)
	c, err := net.Dial("tcp", l.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	c.Write([]byte{0x0B, 'M', 'S', 'H', 0x1C, 0x0D})
	eventually(t, "Rejected()>=1", func() bool { return l.Rejected() >= 1 })
	cancel()
	if _, err := acceptCtx(t, l, 300*time.Millisecond); err == nil {
		t.Fatal("Accept yielded a connection although only a disallowed peer connected")
	}
}

func TestListenerFloodOfDisallowedPeersAllRejected(t *testing.T) {
	// threat table: flooding a listener.
	l := listenLoopback(t, "10.9.9.9")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go l.Accept(ctx)
	const n = 50
	for i := 0; i < n; i++ {
		c, err := net.Dial("tcp", l.Addr().String())
		if err != nil {
			t.Fatalf("dial %d: %v", i, err)
		}
		defer c.Close()
	}
	eventually(t, "all rejected", func() bool { return l.Rejected() == n })
}

func TestListenerCancelledAcceptReturnsCtxErrorAndStaysUsable(t *testing.T) {
	l := listenLoopback(t, "127.0.0.1")
	start := time.Now()
	if _, err := acceptCtx(t, l, 200*time.Millisecond); err == nil {
		t.Fatal("expected ctx error")
	}
	if time.Since(start) > 2*time.Second {
		t.Fatalf("Accept ignored ctx (%v)", time.Since(start))
	}
	go func() {
		c, err := net.Dial("tcp", l.Addr().String())
		if err == nil {
			time.Sleep(300 * time.Millisecond)
			c.Close()
		}
	}()
	c, err := acceptCtx(t, l, 5*time.Second)
	if err != nil {
		t.Fatalf("Accept after cancelled Accept: %v", err)
	}
	c.Close()
}

func TestListenerCloseUnblocksAcceptAndFreesPort(t *testing.T) {
	l := listenLoopback(t, "127.0.0.1")
	p := port(t, l.Addr())
	done := make(chan error, 1)
	go func() { _, err := l.Accept(context.Background()); done <- err }()
	time.Sleep(50 * time.Millisecond)
	l.Close()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("Accept returned nil error after Close")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("Close did not unblock Accept")
	}
	ln, err := net.Listen("tcp", "127.0.0.1:"+strconv.Itoa(p))
	if err != nil {
		t.Fatalf("port not released: %v", err)
	}
	ln.Close()
	if err := l.Close(); err != nil { // idempotent
		t.Fatalf("second Close: %v", err)
	}
}

func TestListenBindsOnlyConfiguredAddress(t *testing.T) {
	l := listenLoopback(t, "127.0.0.1")
	host, _, err := net.SplitHostPort(l.Addr().String())
	if err != nil || host != "127.0.0.1" {
		t.Fatalf("Addr()=%q, want host 127.0.0.1 (never wildcard)", l.Addr())
	}
}

func TestListenRejectsUnbindableOrWildcardAddress(t *testing.T) {
	for _, b := range []string{"", "not-an-ip", "0.0.0.0", "::"} {
		l, err := tcp.Listen(tcp.ListenConfig{BindAddress: b, Port: 0, AllowedPeers: []string{"127.0.0.1"}})
		if err == nil {
			l.Close()
			t.Errorf("Listen accepted bind %q", b)
		}
	}
}

func TestListenWithoutPeersRejectsEveryone(t *testing.T) {
	// fail closed: an empty allowlist must never mean "allow all".
	l, err := tcp.Listen(tcp.ListenConfig{BindAddress: "127.0.0.1", Port: 0})
	if err != nil {
		return // refusing to listen is also fail-closed
	}
	defer l.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	got := make(chan struct{}, 1)
	go func() {
		if c, err := l.Accept(ctx); err == nil {
			c.Close()
			got <- struct{}{}
		}
	}()
	c, err := net.Dial("tcp", l.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	expectClosed(t, c)
	select {
	case <-got:
		t.Fatal("empty allowlist accepted a peer")
	case <-time.After(200 * time.Millisecond):
	}
}

func TestListenFailsWhenPortInUse(t *testing.T) {
	l := listenLoopback(t, "127.0.0.1")
	l2, err := tcp.Listen(tcp.ListenConfig{BindAddress: "127.0.0.1", Port: port(t, l.Addr()), AllowedPeers: []string{"127.0.0.1"}})
	if err == nil {
		l2.Close()
		t.Fatal("expected bind error on port in use")
	}
}

// ---- one connection per instrument: second replaces first [CONV] ----

func TestSecondConnectionReplacesFirst(t *testing.T) {
	l := listenLoopback(t, "127.0.0.1")
	d1, err := net.Dial("tcp", l.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer d1.Close()
	s1, err := acceptCtx(t, l, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer s1.Close()

	d2, err := net.Dial("tcp", l.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer d2.Close()
	s2, err := acceptCtx(t, l, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer s2.Close()

	expectClosed(t, d1) // agent closed the first connection
	s1.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, err := s1.Read(make([]byte, 1)); err == nil {
		t.Fatal("old server-side conn still readable")
	}
	d2.Write([]byte("ok"))
	if got := readN(t, s2, 2); string(got) != "ok" {
		t.Fatalf("got %q", got)
	}
}

// ---- AC-07.1 at the transport layer: bytes pass through untouched ----
// Framing (extract <message>, discard + count bytes before 0x0B) is internal/mllp.
// The transport must hand the codec the exact byte stream.

var ac071Stream = append(append([]byte("junk"), 0x0B),
	append([]byte("MSH|^~\\&|A|B|C|D|20260101||ORU^R01|1|P|2.3.1\rPID|1||SYN1"), 0x1C, 0x0D)...)

func TestAC071_TCPServerDeliversMLLPBytesVerbatimUnderFragmentation(t *testing.T) {
	l := listenLoopback(t, "127.0.0.1")
	go func() {
		c, err := net.Dial("tcp", l.Addr().String())
		if err != nil {
			return
		}
		defer c.Close()
		for _, b := range ac071Stream { // worst-case fragmentation: 1 byte per write
			c.Write([]byte{b})
		}
		time.Sleep(200 * time.Millisecond)
	}()
	s, err := acceptCtx(t, l, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if got := readN(t, s, len(ac071Stream)); !bytes.Equal(got, ac071Stream) {
		t.Fatalf("stream altered:\n got %q\nwant %q", got, ac071Stream)
	}
}

func TestAC071_TCPClientReceivesMLLPBytesVerbatim(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		c.Write(ac071Stream)
		time.Sleep(200 * time.Millisecond)
	}()
	c, err := tcp.Dial(context.Background(), tcp.ClientConfig{Host: "127.0.0.1", Port: ln.Addr().(*net.TCPAddr).Port, ConnectTimeout: 2 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if got := readN(t, c, len(ac071Stream)); !bytes.Equal(got, ac071Stream) {
		t.Fatalf("stream altered:\n got %q\nwant %q", got, ac071Stream)
	}
}

func TestLargeStreamNotTruncatedByTransport(t *testing.T) {
	// Oversize policy (1 MiB, connection reset) belongs to the MLLP codec; the
	// transport must not impose its own cap or lose bytes.
	const size = 2 << 20
	payload := make([]byte, size)
	for i := range payload {
		payload[i] = byte(i * 31)
	}
	l := listenLoopback(t, "127.0.0.1")
	go func() {
		c, err := net.Dial("tcp", l.Addr().String())
		if err != nil {
			return
		}
		defer c.Close()
		c.Write(payload)
		time.Sleep(500 * time.Millisecond)
	}()
	s, err := acceptCtx(t, l, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	s.SetReadDeadline(time.Now().Add(10 * time.Second))
	got := make([]byte, size)
	if _, err := io.ReadFull(s, got); err != nil {
		t.Fatalf("ReadFull: %v", err)
	}
	if !bytes.Equal(got, payload) {
		t.Fatal("payload corrupted")
	}
}
