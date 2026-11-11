APPROVE
Scope: a979d1ec..HEAD (messages.service.ts, messages.repo.ts, messages.handlers.ts, handlers/index.ts, test line 173 per ruling). All paths under services/api/src/modules/instruments (C7-owned).
- Names verbatim: operationIds E33-E36/E42, `instruments.message.read`, `instrument_message.raw_view` / `instrument_message` (TRD §7.5), DTO fields match TRD MessageSummary/MessageDetail/RecordView/ProcessingRun/MessageRejection; reject reasons match 05-SCHEMA §2.14.
- Tenant/centre: explicit `tenant_id = $1` on every statement + tenant re-filter in service; detail/raw: 404 then assertRole at message centre. No new tables, so no RLS DDL in scope.
- AC-18.1: range required, ≤ 31 d, list DTO has no barcode; E34 barcode only from POST body, field-only validation errors, ≤ 50. AC-18.2: latest-run records, records_expired at 90 d (D-11), preview parse in memory, no writes. AC-18.3: audit sink required (fails closed), one access_log row via ctx.audit.access on the request tx before raw is returned; Cache-Control no-store.
- No logging, no secrets; E42 never selects raw_bytes; attachment exposes no bucket/object_path/sha256.
Checks run: vitest messages tests 116/116 pass; tsc no errors in messages files.
Not verified: real SQL/RLS against a live DB (LATERAL latest_run, core.users join) — db tests, as the writer notes.
