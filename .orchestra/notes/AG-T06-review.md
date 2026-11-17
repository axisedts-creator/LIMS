APPROVE

AG-T06 review (diff 665a7726..HEAD; link.go + link_send_test.go).
- Matches 03-APP-FLOW §3.2 transitions and rules (defer from contention ENQ, early end on EOT, retained message restarts at frame 1, interrupt backoff, Terminate/Giveup) and 02-TRD §5.2.4 defaults/names (establish_reply_s, nak_retry_delay_s, host_contention_defer_s, transfer_reply_s, receiver_interrupt_backoff_s, outbound_retry_cycle_s, max_frame_sends, max_establish_attempts, max_outbound_cycles).
- AC-06.1..06.5 each covered by tests; arbiter ruling applied (contention test now 21 s after yield).
- Only owned paths (apps/bridge-agent/internal/astm/); pure state machine, no I/O, no logging, no PHI, no secrets. Tenant/RLS, permissions, rate tier, error codes: N/A (agent-side link layer).
- Verified: `go vet ./internal/astm/` clean; `go test -count=1 ./internal/astm/...` ok.
- Not a defect, note for later tasks: config range validation (TRD §5.2.4, 1–300 s etc.) is not enforced here; belongs to config loading.
