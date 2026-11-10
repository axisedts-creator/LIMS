# API-T13 impl (writer) — implemented; 57/62 pass, 5 disputed (see API-T13-dispute.md)
Files: service/reprocess.service.ts (E38/E39), repo/reprocess.repo.ts (INSERT-only), handlers/reprocess.handlers.ts + handlers/index.ts; `export` added to within/fit/qcPatterns/mapOrganism/mapAst (ingest.service.ts) and toRun/toRecord (messages.service.ts).
[CONV] order 404 -> assertRole(instruments.message.rematch, message centre) -> 409 -> 400 -> 422 -> raw read -> work; one savepoint per patient record: port, then event; access_log last, same tx.
[CONV] port LimsError: record row gets port_reason_code=code, emit_status `not_applicable` (no CHECK value fits better), no event; metric port_outcome label `error`.
[CONV] non-live instrument = run.outcome `shadow`, no port/event (reprocess and re-match); parse failure/throw = run `quarantined` + instruments.message_malformed, 200.
Open: attachment-record re-match -> 409 until attachments repo exists; no observed_codes upsert on reprocess; calibration event is API-T16; concurrent reprocess of one message ends in the (message_id, run_no) unique violation (db test).
Checks: vitest reprocess.service+handlers --testTimeout=90000 -> 57 pass / 5 fail (disputed). Full suite, lint, tsc NOT run yet. Default 5 s timeout fails 2 tests on cold event-schema compile (same as ingest tests).
