APPROVE

Reviewed `git diff 9ed4c4f6..HEAD` against 02-TRD §6.4/§6.5, 01-PRD AC-09.1–09.12, AC-11.1/11.1a/11.2, AC-14.2/14.3, 05-SCHEMA column names.
- Steps 1–13 in spec order; class-A compute-then-insert ordering respected; per-message savepoint (core tx.savepoint, rollback covers outbox); 8 s budget -> `retry`; run counters match §6.4 definitions (skipped_no_barcode counted only when mapped).
- Keys verbatim: result `<instrument_id>:<sample_barcode>:<code>:<time|'none'>`, QC `<instrument_id>:qc:<control_id_raw>:<code>:<time|raw_sha256>`, D-12 `MSH-10:left(sha,16)`; key ≤ 220 holds (cid ≤ 199).
- QC `control_id_raw` 1–64 / `value_raw` 1–64 -> `skipped_invalid`, warnings carry field names only. Logs: request_id + agent_message_id + error code only; metric label = outcome only.
- Tenant predicate on every statement; centre isolation relies on device RLS (spec-sanctioned); rejection row centre derived from the agent (review #6). No migrations in this diff, so no RLS DDL to check. No secrets.
- Tests run: 4 ingest files 89/89 pass. Whole instruments suite: 7 failures, none caused by a T09 code defect (see notes).

Notes (non-blocking, for tester/arbiter):
1. `__tests__/boot.test.ts` "stub submitMessageBatch throws common.internal" is now stale (E04 implemented); same stale pattern as enrolAgent/getAgentConfig/heartbeat/logbundle/downloadAgentRelease from T06. Tester must update boot.test.ts to drop implemented ops from the stub list.
2. `releases.service.test.ts` E02 getAgentConfig fails (T06 area, not touched by this diff) — check separately.
3. Integrity-mismatch archive key `<sha>:<agent_message_id>` with kind `sha256_repeat` is a [CONV] (spec §6.4 step 5/6 silent on the key; §6.5 defines sha256_repeat for host query). Reasonable (avoids a later good copy deduping onto the quarantined one) but should be confirmed by a CR/arbiter note.
4. `handlers/ingest.handlers.ts` + `handlers/index.ts` are outside the brief's file list but inside the chunk's module path; needed to wire E04.
5. Not verified: real Postgres (RLS, unique-index races, SQL syntax of ingest.repo.ts), core Idempotency-Key replay (AC-09.11 only probed).
