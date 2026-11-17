# API-T16 tests (tester)
Files (under services/api/src/modules/instruments/__tests__/): `unit/micro-code.test.ts` + `fixtures/micro-code.golden.json` (AC-11.4 golden), `calibration.events.test.ts` (event contract, 03-IC 3.26),
`calibration.service.test.ts` (AC-11.3 + B2 + two-isolate session through real E04 ingest), `unit/directory-view.contract.test.ts` (view columns + bucket; already green = regression guard).
Run: `.orchestra\notes\API-T16-verify.cmd` (pnpm --dir services/api exec vitest run <the 4 files>). Live view RLS stays in db/tests T0B-10 (unchanged).
SEAMS the writer must implement (spec silent; headers of the test files are authoritative):
- `drivers/micro-code.ts`: `MAX_ANALYTE_CODE_LENGTH=64`, `orgCode(seq?)`, `astCode({isolateSeq?,antibioticCodeRaw,method})` -> `{ok:true,code}|{ok:false,warning:'instrument_analyte_code_too_long'}`, `applyMicroCode(record)` (too long => code left unset + warning appended, never truncated).
- `events/publish.ts`: `CALIBRATION_EVENT`, `calibrationIdempotencyKey(payload, rawSha256)`, `createInstrumentEvents(..).calibrationReceived(ctx, payload, {rawSha256})`.
- `service/ingest.service.ts` step 11: calibrator + `driver.capabilities.calibration` + live => publish (payload: IC 3.26 fields, calibrator_id_raw/lot from calibratorIdRaw/LotRaw, no barcode rule), counters/emit_status as for qc; not live => `shadow`; flag-off => `not_applicable` (as now); IC-limit breach => `skipped_invalid`.
Not covered: reprocess (E38) of calibrators (schema has no processing_kind; spec silent), `agent.health_changed` publisher (not in the T16 row; API-T14), observed_codes upsert for calibrators. Stub used to validate tests was deleted; 14 AC-11.3 tests fail now (no event published), micro-code/events tests fail on the missing exports.
