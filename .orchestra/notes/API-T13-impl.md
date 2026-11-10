# API-T13 impl (writer) — review CHANGES 1+2 applied; reprocess tests 63/63 pass
Files: service/reprocess.service.ts (E38/E39), repo/reprocess.repo.ts (INSERT-only; findRecord now also selects run driver_code/driver_version), handlers/reprocess.handlers.ts + handlers/index.ts; exports added in ingest.service.ts / messages.service.ts.
Review fixes: E38 200 body adds `preview: !live`; E39 no longer needs a registered driver — rematch run carries the source run's driver_code/driver_version (`execute` takes `{ code, version }`); driverOf is E38-only.
[CONV] order 404 -> assertRole(instruments.message.rematch, message centre) -> 409 -> 400 -> 422 -> raw read -> work; one savepoint per patient record: port, then event; access_log last, same tx.
[CONV] port LimsError: port_reason_code=code, emit_status `not_applicable`, no event; metric port_outcome `error`. Non-live = run `shadow`, nothing sent; parse failure = run `quarantined` + instruments.message_malformed, 200.
Open: attachment-record re-match -> 409; no observed_codes upsert on reprocess; concurrent reprocess of one message -> (message_id, run_no) unique violation -> 500 not 409.
Checks: instruments suite 1511/1513; 2 fails outside T13 files: boot.test "boots and mounts…" (pre-existing hardcoded 30 s timeout, ~44 s cold boot), signing.test Go-fixture copy (AG-T11 owns). tsc: no errors under src/modules/instruments.
