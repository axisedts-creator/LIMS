CHANGES

Scope reviewed: `git diff d5575c4e..HEAD` (hl7/{msh,ack}.go, mllp/{codec,session}.go + tests) against 02-TRD §5.4, §(E04 Message), 03-APP-FLOW §3.3, PRD AC-07.1–07.5.
Ran: `go test -count=1 ./internal/mllp/... ./internal/hl7/...` → both ok. Not run: go vet / gofmt (blocked in this session) — writer must run both.

1. apps/bridge-agent/internal/mllp/codec.go:23 (+ codec.go:82,92; session.go:56) — invented name `connection_closed`. The only spec enum for an incomplete reason is E04 `link_meta.incomplete_reason` = `frame_timeout|new_enq|new_start_block|msh_unparseable|process_restart` (02-TRD Message DTO); 03-APP-FLOW §3.3 says only "Connection closed mid-block → partial stored as `incomplete`" with no reason value. Shipping `connection_closed` makes the later uploader send a value the server schema rejects (`common.validation_failed`) or forces another lane to invent a mapping.
   Fix: delete `ReasonConnectionClosed`; emit the mid-block-close event with `Reason: ""` (incomplete_reason is optional, uploader omits it when empty). Update tests accordingly: codec_test.go:7 and :52 (drop the constant from the contract/assert), codec_test.go:162 and session_test.go:397,408 (expect `Reason == ""`). If a distinct reason is wanted, file `.orchestra/cr/AG-T07.md` (CR template, 04-CHANGE-REQUESTS.md) to add a value to the E04 enum instead of coding it.

Checked, no defect:
- Framing / discard count / new_start_block / oversize (limit on message bytes, exactly-max ok, sticky ErrOversize, conn closed, no ACK, `mllp_oversize` counter) match §3.3 and AC-07.1/07.5.
- ACK text matches TRD §5.4 template; AA/AR/CA/CR table; ACK only after CommitMessage returns (D-02); `ack_mode` none/original/enhanced/auto; `ack_message_type_format` `ACK^{trigger}^ACK`; default `LIMS`.
- MSH unparseable → no ACK, stored `incomplete` (`msh_unparseable`), session continues (AC-07.4).
- MSH field indexing correct (parts[n-1] = MSH-n); input bounded (SplitN 17); instrument values sanitised in ACK (no segment/framing injection).
- No logging (no PHI), no secrets, files only within `internal/mllp/*`, `internal/hl7/*` + own notes. RLS/permissions/idempotency/rate tier N/A (agent-local code).
- Tests cover done_when: original/enhanced ACK, garbage, oversize, MSH-unparseable sessions over loopback TCP, plus fuzz and 8 concurrent connections.
