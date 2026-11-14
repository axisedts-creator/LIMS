APPROVE
# AN-T04 re-review (reviewer) — diff bf82f5aa..2ccd4363

Diff = refresh_tenant.test.ts:66 only (+ orchestra notes/CR renames). Change is verbatim the arbiter ruling (TESTS_WRONG): the test now forbids the write kinds `replaceDelete`, `insertRollup`, `deleteMarks`, `stateUpsert`, `runInsert`, `runUpdate`. Together with `lock`/`readMarks`/`dbNow`/`other` that covers every kind `classify()` in refreshFake.ts can return, so "nothing dirty -> resolves without writing" still holds; the test name is unchanged. Nothing was weakened beyond the ruling.

Prior CHANGES items: #3 fixed (DB_NOW `SELECT now()::text` before READ_MARKS, refresh.service.ts:26,108). #2: the fake has a savepoint/job-tx mode. #1: escalated as CR-C8-AN-T04 (`.orchestra/cr/AN-T04.nonblocking.md`, C0-owned), outside C8 paths.
No new names, paths, secrets or PHI in this diff.

RUN: worker vitest src/jobs/analytics 17/17 passed; api vitest src/modules/analytics 580 passed / 5 skipped (refresh.live.test.ts, no DB).
Still open (not blocking this diff): rollups_equal_views live test never executed; real-DB done_when depends on the C0 CR outcome.
