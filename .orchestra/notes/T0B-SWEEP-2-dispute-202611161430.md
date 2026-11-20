# T0B-SWEEP-2 dispute (writer)

Test: `services/api/test-sweep/__tests__/summary.test.ts`, `summarize > counts per depth and per module` (line 31) and `renderResults > states the depth counts` (line 50).

Why it is wrong: the fixture has 6 rows; `row()` defaults `depth: 'DEEP'`, so a, b, e, listWidgets are DEEP (4), c SHALLOW (1), d NOT EXERCISED (1).
- line 31 expects `byDepth` = `{ DEEP: 3, SHALLOW: 1, 'NOT EXERCISED': 1 }` (sum 5) while line 30 expects `total` 6 and line 38 asserts `DEEP + SHALLOW + NOT EXERCISED === total`. No implementation can pass both.
- the same test's per-module expectations (lab 2 + billing 1 + identity 1) give DEEP = 4.
- line 50 `/DEEP\D{0,12}3\b/` inherits the same miscount.

Proposed fix (tester): line 31 `DEEP: 4`; line 50 `/DEEP\D{0,12}4\b/`.

State when stopped: classify.ts, pace.ts, request.ts, summary.ts, gate.ts, ops.ts (bodySchema), sessions.ts (active partner seed) written;
depth, pace, request, partner-seed, classifier, gate, route-table, sessions tests pass (87/89); only the 2 tests above fail.
Not done yet: run.ts wiring (pacer, retry, ids, LimsError stack capture, SWEEP-2 results files), the real sweep, known-failures.json rewrite, impl note.
