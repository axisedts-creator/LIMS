# AG-T05 impl (writer)
- Files: apps/bridge-agent/internal/astm/link.go (new; Receiver, ReceiverConfig, Clock, State, Stats, Feed/Tick/Recover). No test files edited.
- Tests: `go vet ./internal/astm/` clean; `go test -count=1 ./internal/astm/...` ok (incl. kill test).
- [CONV] ENQ and each frame check queue.DiskLow(); low or error -> NAK (07-SECURITY disk guard). Frame > 247 bytes is bounded (discard to LF, one NAK).
- [CONV] Sessions with 0 frames (ENQ-only timeout, EOT without frames, new ENQ) are deleted, no item (spec silent).
- [CONV] If finalize fails at EOT/timeout/new_enq, the receiver goes Neutral and the session stays in the queue; Recover finalises it as process_restart.
- [CONV] Recover: last chunk is an L record ending in CR (=ETX-terminated, review fix; ETB chunk never ends in CR) -> normal item, else incomplete/process_restart; unreadable session stays open and its error is returned (errors.Join); captured_at = session last_frame_at_agent.
- Open: Clock is required (no default, link.go never calls time.Now); caller must run Tick on a timer and call Recover once at start. Not tested here: Feed/Tick concurrency (single-goroutine contract).
