package update_test

// AC-15.3 (second half: health gate + rollback) and AC-15.4 (anti-rollback) with the launcher driven through fake processes and a fake
// clock. The launcher re-verifies everything it is about to run (02-TRD 5.11: "re-verifies the same three checks"), because the data
// root is writable by the service account and pending.json / versions\ are therefore not trusted on their own (REQ-SEC-116/119).
import (
	"context"
	"errors"
	"path/filepath"
	"reflect"
	"sync"
	"testing"
	"time"

	"lims/apps/bridge-agent/internal/update"
)

type fakeClock struct {
	mu     sync.Mutex
	now    time.Time
	timers []fakeTimer
}
type fakeTimer struct {
	at time.Time
	ch chan time.Time
}

func (c *fakeClock) Now() time.Time { c.mu.Lock(); defer c.mu.Unlock(); return c.now }
func (c *fakeClock) After(d time.Duration) <-chan time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	ch := make(chan time.Time, 1)
	if d <= 0 {
		ch <- c.now
		return ch
	}
	c.timers = append(c.timers, fakeTimer{at: c.now.Add(d), ch: ch})
	return ch
}
func (c *fakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
	rest := c.timers[:0]
	for _, tm := range c.timers {
		if !tm.at.After(c.now) {
			tm.ch <- c.now
		} else {
			rest = append(rest, tm)
		}
	}
	c.timers = rest
}

// step scripts one run of one version: exit code, or hang until killed; optionally mark healthy first (the agent's first heartbeat).
type step struct {
	exit     int
	hang     bool
	healthy  bool
	startErr error
}

type fakeProc struct {
	exit   int
	hang   bool
	killed chan struct{}
	once   sync.Once
	onKill func()
}

func (p *fakeProc) Wait() (int, error) {
	if p.hang {
		<-p.killed
		return -1, nil
	}
	return p.exit, nil
}
func (p *fakeProc) Kill() error {
	p.once.Do(func() { close(p.killed); p.onKill() })
	return nil
}

type lrig struct {
	*rig
	clk    *fakeClock
	mu     sync.Mutex
	starts []string // version of each started agent, in order
	killed []string
	script map[string][]step
	policy update.Policy
	done   chan error
	cancel context.CancelFunc
}

func newLRig(t *testing.T) *lrig {
	t.Helper()
	return &lrig{rig: newRig(t), clk: &fakeClock{now: time.Date(2026, 11, 11, 10, 0, 0, 0, time.UTC)}, script: map[string][]step{}}
}

func (l *lrig) on(version string, steps ...step) { l.script[version] = steps }

func (l *lrig) start(exe string) (update.Proc, error) {
	ver := filepath.Base(filepath.Dir(exe))
	if want := l.path("versions", ver, "agent.exe"); exe != want {
		l.t.Errorf("launcher started %q, want %q", exe, want)
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	l.starts = append(l.starts, ver)
	st := step{hang: true}
	if q := l.script[ver]; len(q) > 0 {
		st, l.script[ver] = q[0], q[1:]
	}
	if st.startErr != nil {
		return nil, st.startErr
	}
	if st.healthy {
		if err := update.MarkHealthy(l.root, ver); err != nil {
			l.t.Errorf("MarkHealthy: %v", err)
		}
	}
	return &fakeProc{exit: st.exit, hang: st.hang, killed: make(chan struct{}), onKill: func() {
		l.mu.Lock()
		l.killed = append(l.killed, ver)
		l.mu.Unlock()
	}}, nil
}

// run starts the launcher and a pump that advances the fake clock 1 s per millisecond, so deadlines and back-offs elapse quickly.
func (l *lrig) run() {
	l.t.Helper()
	lau, err := update.NewLauncher(update.LauncherOptions{
		Root: l.root, Keys: l.keys, Authenticode: l.auth, Clock: l.clk, Start: l.start,
		Policy: func() update.Policy { l.mu.Lock(); defer l.mu.Unlock(); return l.policy },
	})
	if err != nil {
		l.t.Fatalf("NewLauncher: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	l.cancel, l.done = cancel, make(chan error, 1)
	go func() { l.done <- lau.Run(ctx) }()
	stop := make(chan struct{})
	go func() {
		for {
			select {
			case <-stop:
				return
			case <-time.After(time.Millisecond):
				l.clk.Advance(time.Second)
			}
		}
	}()
	l.t.Cleanup(func() {
		close(stop)
		cancel()
		select {
		case <-l.done:
		case <-time.After(5 * time.Second):
			l.t.Error("launcher Run did not return after its context was cancelled")
		}
	})
}

func (l *lrig) startsNow() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]string(nil), l.starts...)
}
func (l *lrig) killedNow() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]string(nil), l.killed...)
}
func (l *lrig) waitStarts(n int) {
	l.t.Helper()
	eventually(l.t, "launcher to start agents", func() bool { return len(l.startsNow()) >= n })
}
func (l *lrig) waitStatus(state string) update.Status {
	l.t.Helper()
	var st update.Status
	eventually(l.t, "update status "+state, func() bool { st, _ = update.ReadStatus(l.root); return st.State == state })
	return st
}

// settle gives the launcher time to (wrongly) do more; the pump makes 1 s of fake time pass per millisecond.
func (l *lrig) settle() { time.Sleep(300 * time.Millisecond) }

func (l *lrig) currentVersion() string { return jsonField(l.t, l.read("current.json"), "version") }

func sameStarts(t *testing.T, got []string, want ...string) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("started agents = %v, want %v", got, want)
	}
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Switch
// ---------------------------------------------------------------------------------------------------------------------------------

func TestLauncherStartsCurrentVersion(t *testing.T) {
	l := newLRig(t)
	l.installed("1.0.0")
	l.run()
	l.waitStarts(1)
	l.settle()
	sameStarts(t, l.startsNow(), "1.0.0")
}

func TestLauncherSwitchesOnExit75AndReportsIdleWhenHealthy(t *testing.T) {
	l := newLRig(t)
	l.installed("1.0.0")
	l.stage("1.1.0")
	l.on("1.0.0", step{exit: update.ExitApply})
	l.on("1.1.0", step{healthy: true, hang: true})
	l.run()
	l.waitStarts(2)
	sameStarts(t, l.startsNow(), "1.0.0", "1.1.0")
	if l.currentVersion() != "1.1.0" || jsonField(t, l.read("current.json"), "previous") != "1.0.0" {
		t.Fatalf("current.json = %s, want version 1.1.0 previous 1.0.0", l.read("current.json"))
	}
	if l.exists("pending.json") {
		t.Fatal("pending.json must be consumed by the switch")
	}
	l.waitStatus(update.StateIdle)
	l.settle()
	if len(l.killedNow()) != 0 {
		t.Fatalf("a healthy new version was killed: %v", l.killedNow())
	}
	sameStarts(t, l.startsNow(), "1.0.0", "1.1.0")
}

func TestLauncherExit75WithoutPendingRestartsSameVersion(t *testing.T) {
	l := newLRig(t)
	l.installed("1.0.0")
	l.on("1.0.0", step{exit: update.ExitApply})
	l.run()
	l.waitStarts(2)
	sameStarts(t, l.startsNow()[:2], "1.0.0", "1.0.0")
	if l.currentVersion() != "1.0.0" {
		t.Fatalf("current changed to %s", l.currentVersion())
	}
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Health gate and rollback (AC-15.3)
// ---------------------------------------------------------------------------------------------------------------------------------

func (l *lrig) wantRolledBack(failed, previous string) {
	l.t.Helper()
	st := l.waitStatus(update.StateRolledBack)
	if st.TargetVersion != failed {
		l.t.Fatalf("rolled_back target_version = %q, want %q", st.TargetVersion, failed)
	}
	if l.currentVersion() != previous {
		l.t.Fatalf("current.json version = %s after rollback, want %s", l.currentVersion(), previous)
	}
}

func TestLauncherRollsBackAfterThreeCrashes(t *testing.T) {
	l := newLRig(t)
	l.installed("1.0.0")
	l.stage("1.1.0")
	l.on("1.0.0", step{exit: update.ExitApply})
	l.on("1.1.0", step{exit: 1}, step{exit: 1}, step{exit: 1}) // never healthy
	l.run()
	l.wantRolledBack("1.1.0", "1.0.0")
	l.waitStarts(5)
	l.settle()
	sameStarts(t, l.startsNow(), "1.0.0", "1.1.0", "1.1.0", "1.1.0", "1.0.0") // 3 crashes of 1.1.0, then the previous version, never 1.1.0 again
}

func TestLauncherTwoCrashesThenHealthyDoesNotRollBack(t *testing.T) {
	l := newLRig(t)
	l.installed("1.0.0")
	l.stage("1.1.0")
	l.on("1.0.0", step{exit: update.ExitApply})
	l.on("1.1.0", step{exit: 1}, step{exit: 1}, step{healthy: true, hang: true})
	l.run()
	l.waitStarts(4)
	l.waitStatus(update.StateIdle)
	l.settle()
	sameStarts(t, l.startsNow(), "1.0.0", "1.1.0", "1.1.0", "1.1.0")
	if l.currentVersion() != "1.1.0" {
		t.Fatalf("rolled back after only two crashes: current = %s", l.currentVersion())
	}
}

func TestLauncherRollsBackWhenNoHeartbeatWithinFiveMinutes(t *testing.T) {
	l := newLRig(t)
	l.installed("1.0.0")
	l.stage("1.1.0")
	l.on("1.0.0", step{exit: update.ExitApply})
	l.on("1.1.0", step{hang: true}) // alive, never reports healthy
	l.run()
	l.wantRolledBack("1.1.0", "1.0.0")
	l.waitStarts(3)
	sameStarts(t, l.startsNow()[:3], "1.0.0", "1.1.0", "1.0.0")
	found := false
	for _, v := range l.killedNow() {
		found = found || v == "1.1.0"
	}
	if !found {
		t.Fatalf("the unhealthy 1.1.0 process was not killed (killed: %v)", l.killedNow())
	}
}

func TestLauncherHealthGateNotBeforeFiveMinutes(t *testing.T) {
	l := newLRig(t)
	l.installed("1.0.0")
	l.stage("1.1.0")
	l.on("1.0.0", step{exit: update.ExitApply})
	l.on("1.1.0", step{hang: true})
	// No pump: time only moves when the test says so.
	lau, err := update.NewLauncher(update.LauncherOptions{Root: l.root, Keys: l.keys, Authenticode: l.auth, Clock: l.clk, Start: l.start,
		Policy: func() update.Policy { return update.Policy{} }})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- lau.Run(ctx) }()
	defer func() { cancel(); <-done }()
	l.waitStarts(2)
	l.clk.Advance(4*time.Minute + 59*time.Second)
	l.settle()
	if st, _ := update.ReadStatus(l.root); st.State == update.StateRolledBack || len(l.killedNow()) != 0 {
		t.Fatalf("rolled back / killed before 5 min (status %q, killed %v)", st.State, l.killedNow())
	}
	eventually(t, "rollback after 5 min", func() bool {
		l.clk.Advance(2 * time.Second)
		st, _ := update.ReadStatus(l.root)
		return st.State == update.StateRolledBack
	})
}

// A healthy.json left by the previous version must not satisfy the gate of the new one.
func TestLauncherIgnoresStaleHealthyFile(t *testing.T) {
	l := newLRig(t)
	l.installed("1.0.0")
	l.stage("1.1.0")
	if err := update.MarkHealthy(l.root, "1.0.0"); err != nil {
		t.Fatal(err)
	}
	l.on("1.0.0", step{exit: update.ExitApply})
	l.on("1.1.0", step{hang: true})
	l.run()
	l.wantRolledBack("1.1.0", "1.0.0")
}

func TestLauncherRollsBackWhenNewAgentCannotStart(t *testing.T) {
	l := newLRig(t)
	l.installed("1.0.0")
	l.stage("1.1.0")
	l.on("1.0.0", step{exit: update.ExitApply})
	l.on("1.1.0", step{startErr: errors.New("The specified executable is not a valid application")})
	l.run()
	l.wantRolledBack("1.1.0", "1.0.0")
	l.waitStarts(3)
	if got := l.startsNow(); got[len(got)-1] != "1.0.0" {
		t.Fatalf("after the failed start the previous version must run again, started %v", got)
	}
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Re-verification by the launcher (AC-15.2 enforced again at apply time, REQ-SEC-119)
// ---------------------------------------------------------------------------------------------------------------------------------

func TestLauncherRefusesTamperedStagedPackage(t *testing.T) {
	flipByte := func(l *lrig, rel string) {
		b := l.read(rel)
		b[len(b)/2] ^= 0x01
		l.write(rel, b)
	}
	cases := []struct {
		name   string
		tamper func(l *lrig)
	}{
		{"agent.exe replaced after staging", func(l *lrig) {
			l.write(filepath.Join("versions", "1.1.0", "agent.exe"), []byte("MZ attacker agent"))
		}},
		{"agent.exe bit flipped after staging", func(l *lrig) { flipByte(l, filepath.Join("versions", "1.1.0", "agent.exe")) }},
		{"kept zip bit flipped after staging", func(l *lrig) { flipByte(l, filepath.Join("versions", "1.1.0.zip")) }},
		{"kept zip deleted", func(l *lrig) {
			if err := removeFile(l.path("versions", "1.1.0.zip")); err != nil {
				l.t.Fatal(err)
			}
		}},
		{"pending.json signature swapped for another key's", func(l *lrig) {
			_, other := relPair("attacker-key")
			z := l.read(filepath.Join("versions", "1.1.0.zip"))
			rel := signRelease("1.1.0", z, other, relKeyID, goodPub)
			l.write("pending.json", pendingJSON(rel))
		}},
		{"pending.json names an unknown key_id", func(l *lrig) {
			z := l.read(filepath.Join("versions", "1.1.0.zip"))
			rel := signRelease("1.1.0", z, l.priv, "rel-unknown", goodPub)
			l.write("pending.json", pendingJSON(rel))
		}},
		{"pending.json names a different expected publisher", func(l *lrig) {
			z := l.read(filepath.Join("versions", "1.1.0.zip"))
			rel := signRelease("1.1.0", z, l.priv, relKeyID, evilPub)
			l.write("pending.json", pendingJSON(rel))
		}},
		{"pending.json version points outside versions\\", func(l *lrig) {
			z := l.read(filepath.Join("versions", "1.1.0.zip"))
			rel := signRelease("..\\..\\1.1.0", z, l.priv, relKeyID, goodPub)
			l.write("pending.json", pendingJSON(rel))
		}},
		{"pending.json is not JSON", func(l *lrig) { l.write("pending.json", []byte("\x00\xff garbage")) }},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			l := newLRig(t)
			l.installed("1.0.0")
			l.stage("1.1.0")
			c.tamper(l)
			l.on("1.0.0", step{exit: update.ExitApply})
			l.run()
			l.waitStarts(2)
			l.settle()
			if l.currentVersion() != "1.0.0" {
				t.Fatalf("launcher switched to %s despite tampering", l.currentVersion())
			}
			for _, v := range l.startsNow() {
				if v != "1.0.0" {
					t.Fatalf("launcher started %s despite tampering (starts %v)", v, l.startsNow())
				}
			}
			st := l.waitStatus(update.StateVerifyFailed)
			_ = st
			if l.exists("pending.json") {
				t.Fatal("rejected pending.json must be removed so the launcher does not loop on it")
			}
		})
	}
}

func TestLauncherWithNoTrustedKeysNeverSwitches(t *testing.T) {
	l := newLRig(t)
	l.installed("1.0.0")
	l.stage("1.1.0")
	l.keys = update.ReleaseKeys{} // e.g. EmbeddedReleaseKeys before provisioning
	l.on("1.0.0", step{exit: update.ExitApply})
	l.run()
	l.waitStarts(2)
	l.settle()
	if l.currentVersion() != "1.0.0" {
		t.Fatal("launcher switched with an empty trust list")
	}
	l.waitStatus(update.StateVerifyFailed)
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Anti-rollback (AC-15.4, AB7)
// ---------------------------------------------------------------------------------------------------------------------------------

func TestLauncherAntiRollback(t *testing.T) {
	cases := []struct {
		name         string
		current, to  string
		policy       update.Policy
		wantSwitched bool
	}{
		{"upgrade, default policy", "1.0.0", "1.1.0", update.Policy{}, true},
		{"numeric not lexical: 1.9.0 -> 1.10.0", "1.9.0", "1.10.0", update.Policy{}, true},
		{"patch upgrade 1.0.9 -> 1.0.10", "1.0.9", "1.0.10", update.Policy{}, true},
		{"lower minor refused, default policy", "1.1.0", "1.0.0", update.Policy{}, false},
		{"numeric not lexical: 1.10.0 -> 1.9.0 refused", "1.10.0", "1.9.0", update.Policy{}, false},
		{"lower major refused", "2.0.0", "1.9.9", update.Policy{}, false},
		{"downgrade allowed only with allow_downgrade AND the matching target", "1.1.0", "1.0.0", update.Policy{AllowDowngrade: true, TargetVersion: "1.0.0"}, true},
		{"allow_downgrade but target is another version", "1.1.0", "1.0.0", update.Policy{AllowDowngrade: true, TargetVersion: "0.9.0"}, false},
		{"allow_downgrade but no target", "1.1.0", "1.0.0", update.Policy{AllowDowngrade: true}, false},
		{"target matches but allow_downgrade false", "1.1.0", "1.0.0", update.Policy{AllowDowngrade: false, TargetVersion: "1.0.0"}, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			l := newLRig(t)
			l.installed(c.current)
			l.stage(c.to) // a genuine, validly signed and Authenticode-signed older release: only the launcher's policy can stop it
			l.policy = c.policy
			l.on(c.current, step{exit: update.ExitApply})
			l.on(c.to, step{healthy: true, hang: true})
			l.run()
			l.waitStarts(2)
			l.settle()
			if c.wantSwitched {
				sameStarts(t, l.startsNow(), c.current, c.to)
				if l.currentVersion() != c.to {
					t.Fatalf("current = %s, want %s", l.currentVersion(), c.to)
				}
				return
			}
			sameStarts(t, l.startsNow(), c.current, c.current) // refused: the running version is restarted
			if l.currentVersion() != c.current {
				t.Fatalf("launcher moved to %s; AC-15.4 says refuse", l.currentVersion())
			}
			l.waitStatus(update.StateVerifyFailed)
			if l.exists("pending.json") {
				t.Fatal("refused pending.json must be removed")
			}
		})
	}
}

// ---------------------------------------------------------------------------------------------------------------------------------

func TestNewLauncherValidatesOptions(t *testing.T) {
	r := newRig(t)
	ok := update.LauncherOptions{Root: r.root, Keys: r.keys, Authenticode: r.auth, Clock: &fakeClock{}, Start: func(string) (update.Proc, error) { return nil, nil },
		Policy: func() update.Policy { return update.Policy{} }}
	for name, mut := range map[string]func(o *update.LauncherOptions){
		"no root":         func(o *update.LauncherOptions) { o.Root = "" },
		"no authenticode": func(o *update.LauncherOptions) { o.Authenticode = nil },
		"no start":        func(o *update.LauncherOptions) { o.Start = nil },
	} {
		o := ok
		mut(&o)
		if _, err := update.NewLauncher(o); err == nil {
			t.Errorf("%s: NewLauncher accepted the options (a missing verifier must fail closed, not skip the check)", name)
		}
	}
}
