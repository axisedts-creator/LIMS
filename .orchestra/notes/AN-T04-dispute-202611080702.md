# AN-T04 dispute (writer) — worker test contradicts the revised api test (review #3)
- services/worker/src/jobs/analytics/__tests__/refresh_tenant.test.ts:66 ("nothing dirty -> resolves without writing") asserts every logged statement is `readMarks` or `other`.
- Review #3 + the tester's revised refresh.service.test.ts (≈:228, "guard value is the DB run start") REQUIRE a `SELECT now()::text AS run_started_at` before READ_MARKS; refreshFake.classify now labels it `dbNow` (new kind added in 1090ae63), so :66 fails even with zero marks. The api test also requires it to be a separate statement before `readMarks` (iNow < iRead), so it cannot be merged into READ_MARKS or skipped when nothing is dirty (marks unknown until read).
- `SELECT now()` is not a write: the test's intent ("without writing") holds. Change (tester): at :66 also allow `l.kind !== 'dbNow'` (or assert no kind in replaceDelete/insertRollup/deleteMarks/stateUpsert/runInsert/runUpdate).
- Impl already changed for review #3 (refresh.service.ts: DB_NOW in the marks-read tx; `$n::timestamptz` on the guard). Results: api analytics vitest 580 passed / 5 skipped; worker analytics 16 passed / 1 failed (only :66).

## Debugger confirmation
- Verify failure: worker refresh_tenant.test.ts:66 only. Cause: refreshFake.classify labels `SELECT now()` as `dbNow`; the test whitelists only `readMarks`/`other`.
- Spec: 03-APP-FLOW.md:271-272 (X3/X4) + 02-TRD.md:532,541 need run_started_at (DB time) vs last_marked_at; it must be read before the marks, so it is issued even with nothing dirty. It is a read, so "without writing" still holds.
- Not fixable in impl without breaking the api test (iNow < iRead). Tester: at :66 assert no kind in replaceDelete/insertRollup/deleteMarks/stateUpsert/runInsert/runUpdate (or also allow dbNow). Impl unchanged.
