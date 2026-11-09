TESTS_WRONG — refresh_tenant.test.ts:66 forbids every non-`readMarks`/`other` statement, including the `SELECT now()` (`dbNow`) read; the spec only requires that a nothing-dirty run does not write.
Change in the test at services/worker/src/jobs/analytics/__tests__/refresh_tenant.test.ts:66: assert that no logged kind is one of the write kinds, e.g.
`expect(f.log.some((l) => ['replaceDelete','insertRollup','deleteMarks','stateUpsert','runInsert','runUpdate'].includes(l.kind))).toBe(false);`
(Allowing `dbNow` in the existing whitelist is also fine.) Keep the test name "nothing dirty -> resolves without writing".

Reasons:
- spec/chunks/C8-analytics-mis/02-TRD.md:532 — mark delete is guarded by `last_marked_at <= $run_started_at`, so the run must hold a run-start value.
- 02-TRD.md:541 and 03-APP-FLOW.md:271 (X3) — marks arriving during the run (`last_marked_at > run_started_at`) must survive, so `run_started_at` has to be captured before the marks are read. That means it is captured even when no marks turn out to be dirty.
- 03-APP-FLOW.md:272 (X4) — marks are deleted only when `last_marked_at <= run_started_at`, so run start must be DB time to compare with the DB-set `last_marked_at`.
- No cited spec line forbids reads on an empty run. `SELECT now()` writes nothing, so the test's intent still holds. The implementation (DB_NOW before READ_MARKS) is correct and does not change.
