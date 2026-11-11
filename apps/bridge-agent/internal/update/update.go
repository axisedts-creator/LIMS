// Package update is the signed self-update path of the bridge agent (02-TRD 5.11, REQ-SEC-119): download, verify, stage, and the
// launcher that switches, health-gates and rolls back. It opens no listener and never weakens TLS.
package update

import (
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
)

// update_state values = 05-SCHEMA agent_status__update_state__ck.
const (
	StateIdle         = "idle"
	StateDownloading  = "downloading"
	StateVerifying    = "verifying"
	StateStaged       = "staged"
	StateApplying     = "applying"
	StateRolledBack   = "rolled_back"
	StateVerifyFailed = "verify_failed"
	StateFailed       = "failed"
)

// ExitApply: the agent exits 75 to ask the launcher to switch to the staged version [CONV] (02-TRD 5.11).
const ExitApply = 75

// Release is the g_agent_releases row the agent staged. Signature = base64url (no padding) Ed25519 over the raw SHA-256 bytes of the zip.
type Release struct {
	Version               string `json:"version"`
	PackageSHA256         string `json:"package_sha256"`
	PackageSize           int64  `json:"package_size"`
	Signature             string `json:"signature"`
	KeyID                 string `json:"key_id"`
	AuthenticodePublisher string `json:"authenticode_publisher"`
}

// ReleaseKeys maps key_id -> release public key.
type ReleaseKeys map[string]ed25519.PublicKey

// EmbeddedReleaseKeys is empty until the release pipeline provisions keys, so every verification fails closed. Returns a fresh map.
func EmbeddedReleaseKeys() ReleaseKeys { return ReleaseKeys{} }

// Authenticode returns the signer subject CN of a PE file, or an error when its signature is not valid.
type Authenticode interface {
	Publisher(exePath string) (string, error)
}

// Error carries the update_state the failure maps to.
type Error struct{ State, Reason string }

func (e *Error) Error() string { return "update " + e.State + ": " + e.Reason }

// Status is root\update-state.json (= heartbeat.UpdateState).
type Status struct {
	State         string `json:"state"`
	TargetVersion string `json:"target_version,omitempty"`
	ErrorCode     string `json:"error_code,omitempty"`
}

const (
	statusFile  = "update-state.json"
	pendingFile = "pending.json"
	currentFile = "current.json"
	healthyFile = "healthy.json"

	// rolledBackFile lists versions the launcher rolled back; only the launcher writes it, so the agent cannot clobber the block [CONV].
	rolledBackFile = "rolled-back.json"
	attemptsFile   = "download-attempts.json" // version -> download attempt times, for the 3/day cap [CONV]
	maxJSON        = 64 << 10
)

// Now is the clock Download uses for the retry cap (tests replace it).
var Now = time.Now

type rolledBackList struct {
	Versions []string `json:"versions"`
}

func isRolledBack(root, version string) bool {
	var r rolledBackList
	_ = readJSON(filepath.Join(root, rolledBackFile), &r)
	return slices.Contains(r.Versions, version)
}

func markRolledBack(root, version string) error {
	var r rolledBackList
	_ = readJSON(filepath.Join(root, rolledBackFile), &r)
	if slices.Contains(r.Versions, version) {
		return nil
	}
	r.Versions = append(r.Versions, version)
	return writeJSON(filepath.Join(root, rolledBackFile), r)
}

func ReadStatus(root string) (Status, error) {
	var s Status
	err := readJSON(filepath.Join(root, statusFile), &s)
	return s, err
}

func writeStatus(root, state, target string) {
	_ = writeJSON(filepath.Join(root, statusFile), Status{State: state, TargetVersion: target}) // best effort: status is informational
}

func readJSON(path string, v any) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, maxJSON+1))
	if err != nil {
		return err
	}
	if len(b) > maxJSON {
		return errors.New("update: " + filepath.Base(path) + " too large")
	}
	return json.Unmarshal(b, v)
}

// writeJSON replaces path by rename so a reader never sees a half-written file.
func writeJSON(path string, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	// Windows refuses to rename over a file another process has open (CLI/status readers): retry briefly.
	for i := 0; ; i++ {
		if err = os.Rename(tmp, path); err == nil {
			return nil
		}
		if i >= 100 {
			_ = os.Remove(tmp)
			return err
		}
		time.Sleep(5 * time.Millisecond)
	}
}

var versionRE = regexp.MustCompile(`^[0-9]{1,9}\.[0-9]{1,9}\.[0-9]{1,9}$`)

// validVersion guards every path built from a version string (path traversal, REQ-SEC-119).
func validVersion(v string) bool { return versionRE.MatchString(v) }

// cmpVersion compares numerically (1.10.0 > 1.9.0). Both must be validVersion.
func cmpVersion(a, b string) int {
	pa, pb := strings.Split(a, "."), strings.Split(b, ".")
	for i := range pa {
		x, _ := strconv.Atoi(pa[i])
		y, _ := strconv.Atoi(pb[i])
		if x != y {
			if x < y {
				return -1
			}
			return 1
		}
	}
	return 0
}

type current struct {
	Version  string `json:"version"`
	Previous string `json:"previous"`
}

func readCurrent(root string) (current, error) {
	var c current
	if err := readJSON(filepath.Join(root, currentFile), &c); err != nil {
		return c, err
	}
	if !validVersion(c.Version) || (c.Previous != "" && !validVersion(c.Previous)) {
		return c, fmt.Errorf("update: %s has an invalid version", currentFile)
	}
	return c, nil
}

// MarkHealthy is called by the agent after its first successful heartbeat; the launcher's health gate reads it.
func MarkHealthy(root, version string) error {
	return writeJSON(filepath.Join(root, healthyFile), map[string]string{"version": version})
}

// Window is the tenant update window; To < From spans midnight; From inclusive, To exclusive.
type Window struct{ From, To, Timezone string }

const idleBeforeApply = 60 * time.Second // AC-15.3 [CONV]

// ReadyToApply: no active link session for 60 s and, if w is set, now inside the window. A bad window fails closed.
func ReadyToApply(now, lastLinkActivity time.Time, activeSessions int, w *Window) (bool, error) {
	var in bool
	if w != nil {
		loc, err := time.LoadLocation(w.Timezone)
		if err != nil {
			return false, fmt.Errorf("update window timezone: %w", err)
		}
		from, err := hhmm(w.From)
		if err != nil {
			return false, err
		}
		to, err := hhmm(w.To)
		if err != nil {
			return false, err
		}
		l := now.In(loc)
		m := l.Hour()*60 + l.Minute()
		if from <= to {
			in = m >= from && m < to
		} else {
			in = m >= from || m < to
		}
	} else {
		in = true
	}
	if activeSessions > 0 || !in {
		return false, nil
	}
	return lastLinkActivity.IsZero() || now.Sub(lastLinkActivity) >= idleBeforeApply, nil
}

func hhmm(s string) (int, error) {
	if len(s) != 5 || s[2] != ':' {
		return 0, fmt.Errorf("update window time %q is not HH:MM", s)
	}
	h, e1 := strconv.Atoi(s[:2])
	m, e2 := strconv.Atoi(s[3:])
	if e1 != nil || e2 != nil || h < 0 || h > 23 || m < 0 || m > 59 {
		return 0, fmt.Errorf("update window time %q is not HH:MM", s)
	}
	return h*60 + m, nil
}
