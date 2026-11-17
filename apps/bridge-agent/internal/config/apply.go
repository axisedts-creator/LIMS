package config

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
)

// Outcome of one Apply call.
type Outcome struct {
	State         string
	ConfigVersion int64
	Applied, NoOp bool
}

// Report is what the next heartbeat carries (05-SCHEMA agent_status).
type Report struct {
	ConfigVersionApplied int64  `json:"config_version_applied"`
	ConfigState          string `json:"config_state"`
}

const appliedFile = "applied-config.json"

// Applier keeps the applied config and anti-rollback state (AC-15.1). A rejected config changes nothing
// but the reported state. Safe for concurrent use.
type Applier struct {
	dir     string
	keys    TrustedKeys
	agentID string

	mu      sync.Mutex
	version int64
	doc     json.RawMessage
	state   string
}

// NewApplier restores the last applied config from dir. The stored envelope is re-verified, so a
// tampered file is ignored rather than trusted. ponytail: deleting the file resets the rollback counter
// (needs local access); a monotonic store in the agent DB would close that if the threat model asks.
func NewApplier(dir string, keys TrustedKeys, agentID string) (*Applier, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	a := &Applier{dir: dir, keys: keys, agentID: agentID}
	b, err := os.ReadFile(filepath.Join(dir, appliedFile))
	if errors.Is(err, os.ErrNotExist) {
		return a, nil
	}
	if err != nil {
		return nil, err
	}
	if d, verr := Verify(b, keys, agentID); verr == nil {
		a.version, a.doc, a.state = d.ConfigVersion, d.Raw, StateOK
	}
	return a, nil
}

// Apply verifies envelope and swaps it in if newer. Lower version = rollback_rejected; equal = no-op.
func (a *Applier) Apply(envelope []byte) (Outcome, error) {
	d, err := Verify(envelope, a.keys, a.agentID)
	a.mu.Lock()
	defer a.mu.Unlock()
	if err != nil {
		var ce *Error
		if errors.As(err, &ce) {
			a.state = ce.State
			return Outcome{State: ce.State, ConfigVersion: a.version}, err
		}
		return Outcome{ConfigVersion: a.version}, err
	}
	switch {
	case d.ConfigVersion < a.version:
		a.state = StateRollbackRejected
		return Outcome{State: a.state, ConfigVersion: a.version}, reject(a.state, "config_version is lower than the applied one")
	case d.ConfigVersion == a.version:
		a.state = StateOK
		return Outcome{State: StateOK, ConfigVersion: a.version, NoOp: true}, nil
	}
	if err := a.persist(envelope); err != nil {
		return Outcome{ConfigVersion: a.version}, err // keep current; not a config_state
	}
	a.version, a.doc, a.state = d.ConfigVersion, d.Raw, StateOK
	return Outcome{State: StateOK, ConfigVersion: a.version, Applied: true}, nil
}

// persist writes atomically: temp file, fsync, rename.
func (a *Applier) persist(envelope []byte) error {
	f, err := os.CreateTemp(a.dir, "applied-*.tmp")
	if err != nil {
		return err
	}
	_, werr := f.Write(envelope)
	if werr == nil {
		werr = f.Sync()
	}
	if cerr := f.Close(); werr == nil {
		werr = cerr
	}
	if werr == nil {
		werr = os.Rename(f.Name(), filepath.Join(a.dir, appliedFile))
	}
	if werr != nil {
		os.Remove(f.Name())
	}
	return werr
}

// Report returns the values for the next heartbeat.
func (a *Applier) Report() Report {
	a.mu.Lock()
	defer a.mu.Unlock()
	return Report{ConfigVersionApplied: a.version, ConfigState: a.state}
}

// Current returns the applied document (canonical JSON), if any.
func (a *Applier) Current() (json.RawMessage, bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.doc == nil {
		return nil, false
	}
	return append(json.RawMessage(nil), a.doc...), true
}
