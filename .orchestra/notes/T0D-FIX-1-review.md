APPROVE
Scope reviewed: the stated range ffa92d301..HEAD holds only the ruling-2 delta (statement budget 4 -> 5 in orderables.search.test.ts:214 and perf/orderables.search.perf.test.ts:51, matching T0D-FIX-1-ruling.md 3a/3b). The whole task was also reviewed: 5292ed4b5..354a2f017 (first parent, excludes the merge of main).
Checks run: verify set + orderables.search + perf = 11 files, 141 tests pass; `tsc --noEmit` for services/api is clean.
- Item 1 core/openapi.ts:296-304,320-328: splits only `in: query` + `explode: false` + `type: array` params, in preValidation (so enum/maxLength/maxItems are checked per element); repeated and single values arrive as arrays; empty elements are kept and rejected. Tests cover comma, repeated and single forms.
- Item 2 alerts.schemas.ts:10-15: accepts a string or an array; checks 1..3 elements and the enum. Item 3 chain.service.ts:52-57 clockOf. Item 4 summaries.ts:129-131. Item 5: worklist.service.ts:217-219, reports-read.handlers.ts:206. tests.repo.ts:29-42 binds tenant_id on all three tables, casts `$2::uuid[]` and runs one statement per page.
- Names verbatim: default_price_paisa is defined at catalog.yaml:10485. No new route, permission, error code or contract change. No PHI and no secrets in the code or tests.
Non-blocking:
1. Item 6a is strict only for this task's files. The other 80 clock sites in 31 files are held by a ratchet (ctx-clock-baseline.json), not emptied. This is recorded in T0D-FIX-1-left.md as the brief allows, and the lead must rule on it. Item 6b (limit) is empty across the whole tree.
2. tests.service.ts:200 `String(nowIso(ctx))`: if a caller's ctx.now() returns a Date, this gives a non-ISO string. The pipeline returns ISO, so production is unaffected. `new Date(nowIso(ctx)).toISOString()` would be more robust.
3. The task touches about 22 non-note files against the 16-file cap. The extra files are test fixtures and helpers (csvq/**, the baseline file, catalogDb.ts/testsDb.ts per ruling 1).
