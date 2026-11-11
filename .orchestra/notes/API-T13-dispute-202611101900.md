# API-T13 dispute (writer) — 5 of 62 tests are wrong; the other 57 pass (run with --testTimeout=90000, see 3)
Files: `__tests__/reprocess.service.test.ts` (tests may not be edited by the writer).

1. TEST BUG, 2 tests — `undefined` id never reaches the service. `reprocess = (body = BODY, id: unknown = MSG)` / `rematch = (body = REMATCH, id: unknown = REC)` use default parameters, so `s.reprocess(BODY, undefined)` and `s.rematch(REMATCH, undefined)` silently use the valid id and succeed -> "expected rejection, got success".
   Tests: "unknown record id / not a uuid / expired record -> 404" (line 250, the `undefined` entry) and "unknown / invalid-uuid message -> 404 ..." (line 308, the `undefined` entry).
   Fix: pass the id through without a default (e.g. `id: unknown` + `arguments.length`, or build the input directly for those cases). The service already answers 404 for a non-uuid / undefined id (the `'nope'`, `42`, `'not-a-uuid'` entries pass).

2. TEST CONTRADICTION, 3 tests — chained `reprocess()` then `rematch()` on the SAME world, re-matching a record of run 1 after run 2 exists.
   Tests: "assertRole ... at the MESSAGE centre" (line 293), "logs and metrics carry no barcode ..." (line 321), "response DTOs expose no tenant_id ..." (line 329).
   The reprocess inserts run 2 (fake insertRun updates `latest_run` to run_no 2, kind reprocess, outcome parsed). `recordRow(1, MSG)` is `run_no: 1`. The rematch then has: source record of run 1, latest run 2 — exactly the state of the 409 test "a record of an older run (latest run is 2)" (line 240), which requires `instruments.reprocess_not_allowed`. TRD §6.7: "source record must be ... of the latest run". Both cannot pass; the spec backs the 409 test.
   Fix: in the 3 chained tests re-match first, or use a second world, or give the record `run_no` = the latest run (`recordRow(1, MSG, { run_no: 2 })` with `latest_run.run_no: 2`), or reprocess a different message.

3. Not a bug, FYI: without a warm-up the first publishing test pays the one-off core event-schema compile (~11 s here) and hits vitest's 5 s default (also seen in the existing ingest.service.test.ts, boot.test.ts). Suggest `eventValidators()` in a `beforeAll` with a long hook timeout, or a `testTimeout` in the config.
