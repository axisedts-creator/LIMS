// Package heartbeat sends the agent heartbeat (E03), executes the commands the server hands back exactly once per
// command_id (refresh_config, restart_service, upload_logs, reupload_since) and uploads redacted log bundles (E07).
package heartbeat

import (
	"context"
	"time"
)

// Report is the E03 request body (02-TRD 7.4). Optional fields are omitted when empty; nothing is ever null.
type Report struct {
	SentAtAgent              string           `json:"sent_at_agent"`
	AgentVersion             string           `json:"agent_version"`
	LauncherVersion          string           `json:"launcher_version"`
	OSVersion                string           `json:"os_version"`
	Queue                    Queue            `json:"queue"`
	DiskFreeMB               int64            `json:"disk_free_mb"`
	ClockOffsetMs            int64            `json:"clock_offset_ms"`
	ClockOffsetUncertaintyMs int64            `json:"clock_offset_uncertainty_ms"`
	Config                   ConfigState      `json:"config"`
	Update                   UpdateState      `json:"update"`
	AuthState                string           `json:"auth_state"`
	Instruments              []InstrumentLink `json:"instruments"`
	Counters                 Counters         `json:"counters"`
	CommandResults           []CommandResult  `json:"command_results"`
}

type Queue struct {
	Pending                 int `json:"pending"`
	Uploading               int `json:"uploading"`
	Rejected                int `json:"rejected"`
	Oversize                int `json:"oversize"`
	UploadedRetained        int `json:"uploaded_retained"`
	OldestPendingAgeSeconds int `json:"oldest_pending_age_seconds"`
}

type ConfigState struct {
	AppliedVersion int    `json:"applied_version"`
	State          string `json:"state"`
}

type UpdateState struct {
	State         string `json:"state"`
	TargetVersion string `json:"target_version,omitempty"`
	ErrorCode     string `json:"error_code,omitempty"`
}

type InstrumentLink struct {
	InstrumentID         string `json:"instrument_id"`
	LinkState            string `json:"link_state"`
	LastMessageAtAgent   string `json:"last_message_at_agent,omitempty"`
	MessagesLastInterval int    `json:"messages_last_interval"`
	ErrorsLastInterval   int    `json:"errors_last_interval"`
	LastErrorCode        string `json:"last_error_code,omitempty"`
}

type Counters struct {
	AstmNaksSent           int `json:"astm_naks_sent"`
	AstmNaksReceived       int `json:"astm_naks_received"`
	AstmIncompleteSessions int `json:"astm_incomplete_sessions"`
	MllpDiscardedBytes     int `json:"mllp_discarded_bytes"`
	MllpOversize           int `json:"mllp_oversize"`
	HostQueryUnavailable   int `json:"host_query_unavailable"`
}

// CommandResult State is "completed" or "failed". ResultCode is a short machine code (<= 64), never error text.
type CommandResult struct {
	CommandID  string `json:"command_id"`
	State      string `json:"state"`
	ResultCode string `json:"result_code,omitempty"`
}

type Params struct {
	Since string `json:"since,omitempty"`
}

type Command struct {
	CommandID string `json:"command_id"`
	Kind      string `json:"kind"`
	Params    Params `json:"params"`
	ExpiresAt string `json:"expires_at"`
}

// Response is the E03 200 body.
type Response struct {
	ServerTime          string    `json:"server_time"`
	LatestConfigVersion int       `json:"latest_config_version"`
	HealthState         string    `json:"health_state"`
	Commands            []Command `json:"commands"`
}

// LogBundle is the E07 request body.
type LogBundle struct {
	CommandID   string   `json:"command_id"`
	Lines       []string `json:"lines"`
	FromAtAgent string   `json:"from_at_agent"`
	ToAtAgent   string   `json:"to_at_agent"`
}

// Command record states in the CommandStore.
const (
	stateStarted   = "started"
	stateCompleted = "completed"
	stateFailed    = "failed"
)

// CommandRecord is the durable per-command_id state that makes execution at-most-once.
type CommandRecord struct {
	CommandID  string
	Kind       string
	State      string // started | completed | failed
	ResultCode string
	Acked      bool // a heartbeat carrying the result was accepted by the server
}

// CommandStore must persist across process restarts (fsync'd): restart_service relies on it.
type CommandStore interface {
	Get(id string) (CommandRecord, bool, error)
	Put(CommandRecord) error
	// Unacked returns up to limit finished (completed|failed) records not yet acked, oldest first.
	Unacked(limit int) ([]CommandRecord, error)
	Ack(ids []string) error
}

type Sender interface {
	Heartbeat(ctx context.Context, r Report) (Response, error)
	SubmitLogBundle(ctx context.Context, b LogBundle) (string, error)
}

// Source supplies everything in a Report except SentAtAgent and CommandResults.
type Source interface{ Snapshot() Report }

type Actions interface {
	RefreshConfig(ctx context.Context) error
	RestartService(ctx context.Context) error
	// RequeueUploadedSince moves uploaded messages with captured_at_agent >= since back to pending; returns the count.
	RequeueUploadedSince(ctx context.Context, since time.Time) (int, error)
}

// LogSource returns the (already redacted at source, redacted again on egress) log lines in [from, to].
type LogSource interface {
	Lines(from, to time.Time) ([]string, error)
}
