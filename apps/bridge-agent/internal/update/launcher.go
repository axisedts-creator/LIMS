package update

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"time"
)

type Clock interface {
	Now() time.Time
	After(d time.Duration) <-chan time.Time
}

type Proc interface {
	Wait() (exitCode int, err error)
	Kill() error
}

// Policy is the applied signed config's update.allow_downgrade / update.target.version.
type Policy struct {
	AllowDowngrade bool
	TargetVersion  string
}

type LauncherOptions struct {
	Root         string
	Keys         ReleaseKeys
	Authenticode Authenticode
	Policy       func() Policy // nil = downgrades never allowed
	Clock        Clock         // nil = real time
	Start        func(exe string) (Proc, error)
}

type Launcher struct {
	o   LauncherOptions
	bad map[string]bool // versions rolled back: never retried (in memory + rolled-back.json on startup)
}

const (
	healthGate  = 5 * time.Minute // no healthy.json within this -> rollback [CONV]
	crashWindow = 10 * time.Minute
	crashLimit  = 3
	pollEvery   = time.Second
	backoff     = 2 * time.Second // ponytail: fixed restart delay; escalate if a healthy version crash-loops
)

type realClock struct{}

func (realClock) Now() time.Time                         { return time.Now() }
func (realClock) After(d time.Duration) <-chan time.Time { return time.After(d) }

// NewLauncher fails closed: a missing verifier or start function is an error, never a skipped check.
func NewLauncher(o LauncherOptions) (*Launcher, error) {
	if o.Root == "" || o.Authenticode == nil || o.Start == nil {
		return nil, errors.New("update: launcher needs Root, Authenticode and Start")
	}
	if o.Clock == nil {
		o.Clock = realClock{}
	}
	if o.Policy == nil {
		o.Policy = func() Policy { return Policy{} }
	}
	return &Launcher{o: o, bad: map[string]bool{}}, nil
}

type probation struct {
	deadline <-chan time.Time
	exits    []time.Time
}

func (l *Launcher) probation() *probation {
	return &probation{deadline: l.o.Clock.After(healthGate)}
}

func (l *Launcher) path(parts ...string) string {
	return filepath.Join(append([]string{l.o.Root}, parts...)...)
}

func (l *Launcher) healthy(version string) bool {
	var h struct {
		Version string `json:"version"`
	}
	return readJSON(l.path(healthyFile), &h) == nil && h.Version == version
}

func (l *Launcher) sleep(ctx context.Context, d time.Duration) bool {
	select {
	case <-ctx.Done():
		return false
	case <-l.o.Clock.After(d):
		return true
	}
}

// Run supervises root\current.json until ctx is done, then kills the child.
func (l *Launcher) Run(ctx context.Context) error {
	cur, err := readCurrent(l.o.Root)
	if err != nil {
		return err
	}
	var rb rolledBackList
	_ = readJSON(l.path(rolledBackFile), &rb)
	for _, v := range rb.Versions {
		l.bad[v] = true
	}
	var pr *probation
	if cur.Previous != "" && !l.healthy(cur.Version) {
		pr = l.probation()
	}
outer:
	for ctx.Err() == nil {
		proc, err := l.o.Start(l.path("versions", cur.Version, agentExe))
		if err != nil || proc == nil {
			if pr != nil {
				cur, pr = l.rollback(cur)
				continue
			}
			if !l.sleep(ctx, backoff) {
				return nil
			}
			continue
		}
		done := make(chan int, 1)
		go func() {
			code, err := proc.Wait()
			if err != nil && code == 0 {
				code = -1
			}
			done <- code
		}()
		var poll, deadline <-chan time.Time
		if pr != nil {
			poll, deadline = l.o.Clock.After(pollEvery), pr.deadline
		}
		code, exited := 0, false
		for !exited {
			select {
			case code = <-done:
				exited = true
			case <-ctx.Done():
				_ = proc.Kill()
				<-done
				return nil
			case <-poll:
				if l.healthy(cur.Version) {
					writeStatus(l.o.Root, StateIdle, cur.Version)
					pr, poll, deadline = nil, nil, nil
				} else {
					poll = l.o.Clock.After(pollEvery)
				}
			case <-deadline:
				_ = proc.Kill()
				<-done
				cur, pr = l.rollback(cur)
				continue outer
			}
		}
		if pr != nil && l.healthy(cur.Version) { // healthy and then exited before the first poll
			writeStatus(l.o.Root, StateIdle, cur.Version)
			pr = nil
		}
		if code == ExitApply {
			if pr == nil && l.apply(&cur) {
				pr = l.probation()
				continue
			}
		} else if pr != nil {
			now := l.o.Clock.Now()
			keep := pr.exits[:0]
			for _, t := range pr.exits {
				if now.Sub(t) < crashWindow {
					keep = append(keep, t)
				}
			}
			if pr.exits = append(keep, now); len(pr.exits) >= crashLimit {
				cur, pr = l.rollback(cur)
				continue
			}
		}
		if !l.sleep(ctx, backoff) {
			return nil
		}
	}
	return nil
}

// rollback restores the previous version and records rolled_back with the failed version as target.
func (l *Launcher) rollback(cur current) (current, *probation) {
	l.bad[cur.Version] = true
	_ = markRolledBack(l.o.Root, cur.Version) // best effort: the in-memory block still holds until restart
	if cur.Previous == "" {
		writeStatus(l.o.Root, StateFailed, cur.Version)
		return cur, nil
	}
	if _, err := os.Stat(l.path("versions", cur.Previous, agentExe)); err != nil {
		writeStatus(l.o.Root, StateFailed, cur.Version)
		return cur, nil
	}
	prev := current{Version: cur.Previous}
	if err := writeJSON(l.path(currentFile), prev); err != nil {
		writeStatus(l.o.Root, StateFailed, cur.Version)
		return cur, nil
	}
	writeStatus(l.o.Root, StateRolledBack, cur.Version)
	return prev, nil
}

// apply consumes pending.json: it re-verifies everything (the data root is writable by the service account), enforces anti-rollback,
// and switches current.json. A rejected pending.json is removed and recorded as verify_failed. Reports whether it switched.
func (l *Launcher) apply(cur *current) bool {
	var rel Release
	if err := readJSON(l.path(pendingFile), &rel); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return false
		}
		return l.refuse("")
	}
	if err := l.accept(rel, *cur); err != nil {
		return l.refuse(rel.Version)
	}
	// healthy.json goes BEFORE the switch so a stale file can never satisfy the new version's gate.
	if err := os.Remove(l.path(healthyFile)); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return l.refuse(rel.Version)
	}
	next := current{Version: rel.Version, Previous: cur.Version}
	if err := writeJSON(l.path(currentFile), next); err != nil {
		return l.refuse(rel.Version)
	}
	_ = os.Remove(l.path(pendingFile))
	writeStatus(l.o.Root, StateApplying, rel.Version)
	*cur = next
	return true
}

func (l *Launcher) accept(rel Release, cur current) error {
	if !validVersion(rel.Version) {
		return verr("invalid version")
	}
	if l.bad[rel.Version] {
		return verr("version was rolled back")
	}
	switch c := cmpVersion(rel.Version, cur.Version); {
	case c == 0:
		return verr("version is the running version")
	case c < 0:
		if p := l.o.Policy(); !p.AllowDowngrade || p.TargetVersion != rel.Version {
			return verr("anti-rollback: lower version refused")
		}
	}
	return verifyStaged(l.o.Root, rel, l.o.Keys, l.o.Authenticode)
}

func (l *Launcher) refuse(version string) bool {
	_ = os.Remove(l.path(pendingFile))
	if !validVersion(version) {
		version = ""
	}
	writeStatus(l.o.Root, StateVerifyFailed, version)
	return false
}
