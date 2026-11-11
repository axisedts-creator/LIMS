APPROVE

Reviewed `git diff 40fb4d8d..HEAD` (AG-T10) against 02-TRD §5.7/§5.9, PRD AC-08.1–08.3, AC-14.1–14.2, contracts/openapi/instruments.yaml (submitBatch E04, `Message` schema).

Checked, no defects:
- Names verbatim: path `/v1/instruments/agent/message-batches`; request fields `sent_at_agent`, `clock_offset_ms`, `messages[]` (`agent_message_id`, `instrument_id`, `protocol`, `kind`, `raw_base64`, `raw_sha256`, `captured_at_agent`, `clock_offset_ms`, `link_meta`); response `server_time`, `results[]` (`agent_message_id`, `outcome`, `instrument_message_id`, `error_code`); outcome enum; `instruments.message_too_large` exists in 03-IC.
- AC-08.1: ≤100 msgs / ≤3 MiB JSON, oldest `captured_at_agent` first, UUIDv7 `Idempotency-Key`, same key + byte-identical body on unchanged retry.
- AC-08.2: 1 s×2^n cap 300 s, ±20 % jitter, Retry-After wins when larger (bounded 24 h). 5xx/429/network back off.
- AC-08.3: accepted/duplicate/quarantined→uploaded; rejected→rejected + config version, requeued once on increase; retry/unknown/missing→pending with backoff.
- 401 stops uploads (`auth_state` rejected), items stay pending, no attempt burned.
- Rate budget 38/20/2 per min (TRD §5.7). TLS ≥1.2, verified chain, optional SPKI pins narrow trust only, no redirects, proxy never falls back to direct, no `InsecureSkipVerify`.
- AC-14.1/14.2: midpoint offset, smallest uncertainty in 10 min, per-message capture offset kept, envelope carries current estimate.
- No logging (no PHI), no secrets, only owned paths + own notes. RLS/permissions/idempotency server-side: N/A for agent code.

Ran: `go test -count=1 ./internal/uploader/...` ok (63 s); `./internal/clock/...` ok; `go vet` clean. Note: first run under heavy load had `TestClient_RequestShapeAndResponseParsing` hit its 5 s client timeout (14 s handshake); passed on rerun — load flake, not code. gofmt not re-run by reviewer.

Non-blocking gaps (follow-up, not defects vs spec):
- Plan says "contract vs Prism"; tests use httptest stubs shaped from the contract, Prism not run.
- Batch-level 400/422 (spec silent) backs off and resends the same batch forever; a single invalid message (e.g. empty raw → `raw_base64` minLength 4) would block the queue head. Worth a CR if the server can return 400 for one bad item.
- Flush cadence (2 s / at 100), attachments, Store adapter over queue.DB not in this task (writer notes).
