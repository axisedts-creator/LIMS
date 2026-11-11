package heartbeat

import (
	"context"
	"encoding/json"
	"errors"
	"time"
	"unicode/utf8"
)

const (
	isoUTC         = "2006-01-02T15:04:05.000Z"
	maxResults     = 20            // E03 command_results[<=20]
	maxCodeLen     = 64            // result_code <= 64
	logWindow      = 24 * time.Hour // AC-24.1
	reuploadWindow = 72 * time.Hour // retention of uploaded messages (AC-24.2)
	maxLogLines    = 20000          // E07
	maxLogChars    = 1000           // E07, per line
	maxBundleBytes = 4<<20 - 4096   // E07 body <= 4 MiB, minus envelope headroom
)

// Options wires the service. Every field except Now is required.
type Options struct {
	Sender  Sender
	Store   CommandStore
	Source  Source
	Actions Actions
	Logs    LogSource
	Redact  func(string) string // log egress is impossible without it
	Now     func() time.Time
}

type Service struct{ o Options }

func New(o Options) (*Service, error) {
	if o.Sender == nil || o.Store == nil || o.Source == nil || o.Actions == nil || o.Logs == nil || o.Redact == nil {
		return nil, errors.New("heartbeat: Sender, Store, Source, Actions, Logs and Redact are all required")
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	return &Service{o: o}, nil
}

// Tick sends one heartbeat and then executes the commands in its response. Results of earlier commands ride along
// until a heartbeat carrying them succeeded. A failed send returns the error and runs nothing.
func (s *Service) Tick(ctx context.Context) error {
	pending, err := s.o.Store.Unacked(maxResults)
	if err != nil {
		return err
	}
	rep := s.o.Source.Snapshot()
	rep.SentAtAgent = s.o.Now().UTC().Format(isoUTC)
	rep.CommandResults = make([]CommandResult, 0, len(pending))
	ids := make([]string, 0, len(pending))
	for _, r := range pending {
		rep.CommandResults = append(rep.CommandResults, CommandResult{CommandID: r.CommandID, State: r.State, ResultCode: r.ResultCode})
		ids = append(ids, r.CommandID)
	}
	resp, err := s.o.Sender.Heartbeat(ctx, rep)
	if err != nil {
		return err
	}
	if len(ids) > 0 {
		if err := s.o.Store.Ack(ids); err != nil {
			return err
		}
	}
	for _, c := range resp.Commands {
		if err := s.handle(ctx, c); err != nil {
			return err
		}
	}
	return nil
}

// handle runs one delivered command at most once per command_id.
func (s *Service) handle(ctx context.Context, c Command) error {
	if c.CommandID == "" {
		return nil
	}
	rec, known, err := s.o.Store.Get(c.CommandID)
	if err != nil {
		return err
	}
	if known {
		// Re-delivery: the server has not applied our result yet. Never run again; report again.
		switch rec.State {
		case stateStarted: // the process died mid-command
			rec.State, rec.ResultCode = stateFailed, "interrupted"
		case stateCompleted, stateFailed:
		default:
			rec.State, rec.ResultCode = stateFailed, "interrupted"
		}
		rec.Acked = false
		return s.o.Store.Put(rec)
	}
	switch c.Kind {
	case "refresh_config", "restart_service", "upload_logs", "reupload_since":
	default:
		return s.o.Store.Put(CommandRecord{CommandID: c.CommandID, Kind: c.Kind, State: stateFailed, ResultCode: "unknown_kind"})
	}
	if exp, err := time.Parse(time.RFC3339Nano, c.ExpiresAt); err != nil || !s.o.Now().Before(exp) {
		return nil // expired or unverifiable: never run; the server expires it
	}
	// Persist "started" before any side effect so a crash cannot cause a second run.
	rec = CommandRecord{CommandID: c.CommandID, Kind: c.Kind, State: stateStarted}
	if err := s.o.Store.Put(rec); err != nil {
		return err
	}
	var runErr error
	switch c.Kind {
	case "refresh_config":
		runErr = s.o.Actions.RefreshConfig(ctx)
		if runErr != nil {
			runErr = codeErr("refresh_failed", runErr)
		}
	case "restart_service":
		// F-10: completed is durable BEFORE the process exits, so the post-restart re-delivery is answered, not run.
		rec.State = stateCompleted
		if err := s.o.Store.Put(rec); err != nil {
			return err
		}
		if runErr = s.o.Actions.RestartService(ctx); runErr != nil {
			runErr = codeErr("restart_failed", runErr)
		}
	case "upload_logs":
		runErr = s.uploadLogs(ctx, c.CommandID)
	case "reupload_since":
		runErr = s.reuploadSince(ctx, c.Params)
	}
	if runErr != nil {
		rec.State, rec.ResultCode = stateFailed, resultCode(runErr)
	} else {
		rec.State = stateCompleted
	}
	return s.o.Store.Put(rec)
}

// codedError carries a fixed machine code; its Error() text is never reported.
type codedError struct{ code string }

func (e codedError) Error() string { return e.code }
func (e codedError) Code() string  { return e.code }

// codeErr keeps a handler-supplied Code() when err has one, otherwise uses fallback.
func codeErr(fallback string, err error) error {
	var c interface{ Code() string }
	if errors.As(err, &c) {
		return codedError{c.Code()}
	}
	return codedError{fallback}
}

// resultCode returns a safe 1..64 char code: [a-z0-9._-] only, never free text.
func resultCode(err error) string {
	var c interface{ Code() string }
	code := "failed"
	if errors.As(err, &c) {
		code = c.Code()
	}
	out := make([]byte, 0, maxCodeLen)
	for i := 0; i < len(code) && len(out) < maxCodeLen; i++ {
		b := code[i]
		if b >= 'A' && b <= 'Z' {
			b += 'a' - 'A'
		}
		if (b >= 'a' && b <= 'z') || (b >= '0' && b <= '9') || b == '_' || b == '.' || b == '-' {
			out = append(out, b)
		} else {
			return "failed"
		}
	}
	if len(out) == 0 {
		return "failed"
	}
	return string(out)
}

func (s *Service) reuploadSince(ctx context.Context, p Params) error {
	since, err := time.Parse(time.RFC3339Nano, p.Since)
	now := s.o.Now()
	if err != nil || since.After(now) {
		return codedError{"bad_params"}
	}
	if floor := now.Add(-reuploadWindow); since.Before(floor) {
		since = floor // uploaded messages are retained 72 h only
	}
	if _, err := s.o.Actions.RequeueUploadedSince(ctx, since); err != nil {
		return codeErr("reupload_failed", err)
	}
	return nil
}

func (s *Service) uploadLogs(ctx context.Context, id string) error {
	to := s.o.Now().UTC()
	from := to.Add(-logWindow)
	raw, err := s.o.Logs.Lines(from, to)
	if err != nil {
		return codedError{"log_read_failed"}
	}
	b := LogBundle{CommandID: id, Lines: s.fit(raw), FromAtAgent: from.Format(isoUTC), ToAtAgent: to.Format(isoUTC)}
	if _, err := s.o.Sender.SubmitLogBundle(ctx, b); err != nil {
		return codedError{"upload_logs_failed"}
	}
	return nil
}

// fit redacts every line, cuts each to maxLogChars and keeps the newest lines within the E07 count and byte limits.
// Redaction comes first so a cut can never leave half a redactable token behind.
func (s *Service) fit(raw []string) []string {
	var kept []string // newest first
	size := 0
	for i := len(raw) - 1; i >= 0 && len(kept) < maxLogLines; i-- {
		l := cut(s.o.Redact(raw[i]), maxLogChars)
		enc, _ := json.Marshal(l)
		if size+len(enc)+1 > maxBundleBytes {
			break
		}
		size += len(enc) + 1
		kept = append(kept, l)
	}
	if len(kept) == 0 {
		return []string{"(no log lines in window)"} // E07 requires at least one line
	}
	for i, j := 0, len(kept)-1; i < j; i, j = i+1, j-1 {
		kept[i], kept[j] = kept[j], kept[i]
	}
	return kept
}

// cut truncates to at most n bytes without splitting a UTF-8 sequence.
func cut(s string, n int) string {
	if len(s) <= n {
		return s
	}
	for n > 0 && !utf8.RuneStart(s[n]) {
		n--
	}
	return s[:n]
}
