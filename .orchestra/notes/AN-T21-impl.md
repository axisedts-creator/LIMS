# AN-T21 impl (writer)
- Changed: `services/api/src/modules/analytics/handlers/exports.ts` only (no test files touched).
- createAnalyticsExport now calls `assertFilterIdsKnown` after periodAndScope, before quota/insert: `params.filters.department_id` / `processing_branch_id` must exist in the caller's tenant (departmentLabels / branchLabels from labels.service, as pending.service checkKnown does) else `common.not_found` 404, id not echoed. [CONV] 07-SECURITY P1, same shape as report GETs.
- Run: `vitest run src/modules/analytics` -> 56 files pass, 2383 tests pass (incl. all probes, the formerly failing exports.probe case).
- Open: `__tests__/boot.test.ts` 2 fails, unrelated to this change: one 30 s timeout under parallel load; one `module billing: index.ts exports no manifest` (other chunk's module in this worktree).
- Not run: linter/tsc, live-PG pgTAP.
