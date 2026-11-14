// Package tcp implements the agent's TCP transports (TRD §5.8 tcp_client /
// tcp_server): a dialer with capped exponential reconnect back-off and a
// listener that only hands out connections from allow-listed IPv4 peers.
// It moves raw bytes only; framing (MLLP/ASTM) lives in the protocol packages.
package tcp

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"regexp"
	"strconv"
	"sync"
	"sync/atomic"
	"time"
)

// ---- listener (tcp_server) ----

// ListenConfig is the decoded transport for kind=tcp_server.
type ListenConfig struct {
	BindAddress  string
	Port         int
	AllowedPeers []string
}

const maxAllowedPeers = 8

// ValidateListenConfig applies the TRD §5.8 tcp_server rules.
func ValidateListenConfig(c ListenConfig) error {
	a, err := netip.ParseAddr(c.BindAddress)
	if err != nil || !a.Is4() {
		return fmt.Errorf("tcp_server: bind_address %q must be an IPv4 address", c.BindAddress)
	}
	if a.IsUnspecified() || a.IsLoopback() {
		return fmt.Errorf("tcp_server: bind_address %q must not be wildcard or loopback", c.BindAddress)
	}
	if c.Port < 1024 || c.Port > 65535 {
		return fmt.Errorf("tcp_server: port %d out of range 1024-65535", c.Port)
	}
	if n := len(c.AllowedPeers); n < 1 || n > maxAllowedPeers {
		return fmt.Errorf("tcp_server: allowed_peers must hold 1-%d addresses, got %d", maxAllowedPeers, n)
	}
	for _, p := range c.AllowedPeers {
		pa, err := netip.ParseAddr(p)
		if err != nil || !pa.Is4() || pa.IsUnspecified() {
			return fmt.Errorf("tcp_server: allowed peer %q must be a specific IPv4 address", p)
		}
	}
	return nil
}

// Listener accepts connections only from allowed peers. At most one accepted
// connection is live: accepting a new one closes the previous.
type Listener struct {
	ln       *net.TCPListener
	allowed  map[netip.Addr]struct{}
	rejected atomic.Uint64

	acceptMu  sync.Mutex // serialises Accept (deadline trick below is per-listener)
	mu        sync.Mutex
	cur       net.Conn
	closeOnce sync.Once
}

// Listen binds cfg.BindAddress:cfg.Port. It does NOT run ValidateListenConfig
// (the config layer does) but always refuses an unparsable or wildcard bind and
// treats an empty allowlist as "reject everyone".
func Listen(cfg ListenConfig) (*Listener, error) {
	a, err := netip.ParseAddr(cfg.BindAddress)
	if err != nil || a.IsUnspecified() {
		return nil, fmt.Errorf("tcp_server: unusable bind_address %q", cfg.BindAddress)
	}
	if cfg.Port < 0 || cfg.Port > 65535 {
		return nil, fmt.Errorf("tcp_server: port %d out of range", cfg.Port)
	}
	allowed := make(map[netip.Addr]struct{}, len(cfg.AllowedPeers))
	for _, p := range cfg.AllowedPeers {
		pa, err := netip.ParseAddr(p)
		if err != nil {
			return nil, fmt.Errorf("tcp_server: allowed peer %q is not an IP address", p)
		}
		allowed[pa.Unmap()] = struct{}{}
	}
	ln, err := net.ListenTCP("tcp", net.TCPAddrFromAddrPort(netip.AddrPortFrom(a, uint16(cfg.Port))))
	if err != nil {
		return nil, err
	}
	return &Listener{ln: ln, allowed: allowed}, nil
}

// Addr is the bound address.
func (l *Listener) Addr() net.Addr { return l.ln.Addr() }

// Rejected counts connections closed because the peer was not allow-listed.
func (l *Listener) Rejected() uint64 { return l.rejected.Load() }

// Accept blocks for the next allow-listed connection. Other peers are closed
// at once without reading a byte. A cancelled ctx returns ctx.Err() and leaves
// the listener usable; Close makes Accept return an error.
func (l *Listener) Accept(ctx context.Context) (net.Conn, error) {
	l.acceptMu.Lock()
	defer l.acceptMu.Unlock()

	stop := context.AfterFunc(ctx, func() { _ = l.ln.SetDeadline(time.Now()) })
	defer func() {
		stop()
		_ = l.ln.SetDeadline(time.Time{})
	}()

	for {
		c, err := l.ln.Accept()
		if err != nil {
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			return nil, err
		}
		if !l.peerAllowed(c.RemoteAddr()) {
			l.rejected.Add(1)
			_ = c.Close()
			continue
		}
		l.mu.Lock()
		prev := l.cur
		l.cur = c
		l.mu.Unlock()
		if prev != nil {
			_ = prev.Close() // one connection per instrument: newest wins [CONV]
		}
		return c, nil
	}
}

func (l *Listener) peerAllowed(a net.Addr) bool {
	ta, ok := a.(*net.TCPAddr)
	if !ok {
		return false
	}
	ip, ok := netip.AddrFromSlice(ta.IP)
	if !ok {
		return false
	}
	_, ok = l.allowed[ip.Unmap()]
	return ok
}

// Close stops listening, closes the live connection and unblocks Accept. Idempotent.
func (l *Listener) Close() error {
	var err error
	l.closeOnce.Do(func() {
		err = l.ln.Close()
		l.mu.Lock()
		if l.cur != nil {
			_ = l.cur.Close()
			l.cur = nil
		}
		l.mu.Unlock()
	})
	return err
}

// ---- client (tcp_client) ----

// ClientConfig is the decoded transport for kind=tcp_client.
type ClientConfig struct {
	Host                string
	Port                int
	ConnectTimeout      time.Duration
	ReconnectMaxBackoff time.Duration
}

var hostRE = regexp.MustCompile(`^[A-Za-z0-9.-]{1,253}$`)

// ValidateClientConfig applies the TRD §5.8 tcp_client rules.
func ValidateClientConfig(c ClientConfig) error {
	if !hostRE.MatchString(c.Host) {
		return fmt.Errorf("tcp_client: host %q invalid", c.Host)
	}
	if c.Port < 1 || c.Port > 65535 {
		return fmt.Errorf("tcp_client: port %d out of range 1-65535", c.Port)
	}
	if c.ConnectTimeout < time.Second || c.ConnectTimeout > 60*time.Second {
		return fmt.Errorf("tcp_client: connect_timeout_s must be 1-60")
	}
	if c.ReconnectMaxBackoff < time.Second || c.ReconnectMaxBackoff > 300*time.Second {
		return fmt.Errorf("tcp_client: reconnect_max_backoff_s must be 1-300")
	}
	return nil
}

// Dial makes one connection attempt bounded by ConnectTimeout and ctx.
func Dial(ctx context.Context, cfg ClientConfig) (net.Conn, error) {
	d := net.Dialer{Timeout: cfg.ConnectTimeout}
	return d.DialContext(ctx, "tcp", net.JoinHostPort(cfg.Host, strconv.Itoa(cfg.Port)))
}

// Backoff is 1s, 2s, 4s, ... capped at max (03-APP-FLOW §3.3).
func Backoff(attempt int, max time.Duration) time.Duration {
	if attempt < 0 {
		attempt = 0
	}
	if attempt >= 30 { // 1s<<30 would overflow Duration on 32-bit shifts; max wins anyway
		return max
	}
	if d := time.Second << uint(attempt); d < max {
		return d
	}
	return max
}

// Reconnect dials until it connects or ctx ends, waiting Backoff(n) between
// attempts. A nil sleep uses a real, ctx-aware timer.
func Reconnect(ctx context.Context, cfg ClientConfig, sleep func(context.Context, time.Duration) error) (net.Conn, error) {
	if sleep == nil {
		sleep = ctxSleep
	}
	for attempt := 0; ; attempt++ {
		c, err := Dial(ctx, cfg)
		if err == nil {
			return c, nil
		}
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if serr := sleep(ctx, Backoff(attempt, cfg.ReconnectMaxBackoff)); serr != nil {
			return nil, errors.Join(serr, err)
		}
	}
}

func ctxSleep(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}
