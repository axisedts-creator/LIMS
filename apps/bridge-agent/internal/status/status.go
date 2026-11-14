// Package status writes and reads status\status.json (02-TRD 5.13, AC-22.1). The service writes it every Interval with an atomic
// rename; the CLI reads it. The schema carries no barcodes, values, names, raw bytes or tokens.
package status

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"
)

const (
	FileName = "status.json"
	Interval = 10 * time.Second // 02-TRD 5.13
)

// ErrNotFound means the service has not written status.json yet. Any other Read error means unreadable or corrupt.
var ErrNotFound = errors.New("status: status.json not found")

type Queue struct {
	Pending                 int `json:"pending"`
	Uploading               int `json:"uploading"`
	Rejected                int `json:"rejected"`
	Oversize                int `json:"oversize"`
	UploadedRetained        int `json:"uploaded_retained"`
	OldestPendingAgeSeconds int `json:"oldest_pending_age_seconds"`
}

type Instrument struct {
	InstrumentCode     string `json:"instrument_code"`
	LinkState          string `json:"link_state"`
	LastMessageAtAgent string `json:"last_message_at_agent,omitempty"`
	MessagesToday      int    `json:"messages_today"`
	LastErrorCode      string `json:"last_error_code,omitempty"`
}

type Status struct {
	ServiceState         string           `json:"service_state"`
	AgentID              string           `json:"agent_id"`
	AgentVersion         string           `json:"agent_version"`
	LauncherVersion      string           `json:"launcher_version"`
	ServerReachable      bool             `json:"server_reachable"`
	LastHeartbeatAt      string           `json:"last_heartbeat_at"`
	LastHeartbeatOutcome string           `json:"last_heartbeat_outcome"`
	AuthState            string           `json:"auth_state"`
	ConfigVersion        int              `json:"config_version"`
	ConfigState          string           `json:"config_state"`
	UpdateState          string           `json:"update_state"`
	Queue                Queue            `json:"queue"`
	DiskFreeMB           int64            `json:"disk_free_mb"`
	Instruments          []Instrument     `json:"instruments"`
	Counters             map[string]int64 `json:"counters"`
}

// retry budget for the two Windows sharing races: rename over a file a reader holds open, and open of a file being replaced.
const (
	retryEvery = 2 * time.Millisecond
	retryFor   = 10 * time.Second // a virus scanner can hold a new file without FILE_SHARE_DELETE for seconds on a loaded PC
)

// Write stores s as dir\status.json: temp file in dir, fsync, rename. A reader never sees a torn file. The directory must exist
// (it is created with its ACL by the installer, never here).
func Write(dir string, s Status) error {
	raw, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, "status-*.tmp")
	if err != nil {
		return err
	}
	name := tmp.Name()
	_, err = tmp.Write(raw) // no fsync: the file is rewritten every 10 s, and a torn file after a power cut is just "corrupt" until then
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = renameRetry(name, filepath.Join(dir, FileName))
	}
	if err != nil {
		_ = os.Remove(name)
		return err
	}
	return nil
}

// renameRetry retries a rename that Windows refuses (access denied / sharing violation) while a reader holds the target open.
func renameRetry(from, to string) error {
	deadline := time.Now().Add(retryFor)
	for {
		err := os.Rename(from, to)
		if err == nil || time.Now().After(deadline) {
			return err
		}
		time.Sleep(retryEvery)
	}
}

// Read returns the current status. ErrNotFound when the file is absent; a parse error (not ErrNotFound) when it is corrupt.
func Read(dir string) (Status, error) {
	p := filepath.Join(dir, FileName)
	var raw []byte
	var err error
	deadline := time.Now().Add(retryFor)
	for {
		raw, err = readShared(p)
		if err == nil || errors.Is(err, os.ErrNotExist) || time.Now().After(deadline) {
			break
		}
		time.Sleep(retryEvery) // the writer is replacing the file right now
	}
	if errors.Is(err, os.ErrNotExist) {
		return Status{}, ErrNotFound
	}
	if err != nil {
		return Status{}, err
	}
	var s Status
	if err := json.Unmarshal(raw, &s); err != nil {
		return Status{}, fmt.Errorf("status: %s is corrupt: %w", FileName, err)
	}
	return s, nil
}

func readShared(p string) ([]byte, error) {
	f, err := openShared(p)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return io.ReadAll(io.LimitReader(f, 1<<20)) // the file is a few KB; the cap stops a planted huge file
}

// Run writes snapshot() at once, then every `every`, until ctx is done (returns ctx.Err()). A failed write is not fatal: the
// next tick tries again, and the CLI reports a stale or missing file.
func Run(ctx context.Context, dir string, snapshot func() Status, every time.Duration) error {
	if every <= 0 {
		every = Interval
	}
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		_ = Write(dir, snapshot())
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-t.C:
		}
	}
}
