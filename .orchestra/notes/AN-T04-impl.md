# AN-T04 impl (writer)
- New: api `repository/refresh.repo.ts` (replacePartition x16 families, markDirty, loadFamilyStates + validators), `repository/orderIndex.repo.ts`, `service/refresh.service.ts` (refreshTenant); worker `jobs/analytics/tasks/refresh_tenant.ts`; edited `jobs/analytics/index.ts` (real task replaces the stub).
- [CONV] `sourceViews.repo.ts` NOT created: brief lists it but tests give no contract and live pending/agents belong to AN-T13.
- [CONV] chunk 7 d / lookback 30 d are code defaults (inputs `chunkDays`, `backlogLookbackDays`); env wiring left to the callers (AN-T05/sweeps). Run row (`succeeded`) is written in the same tx as the data after the replace (needs rows_written); `expires_at = now() + 90 d` = `started_at + 90 d`.
- [CONV] one failing range does not stop the other ranges; the first error is rethrown after all ranges were tried (no starvation behind a poisoned family). Failure tx stores the error CODE only (`refresh_error` if none).
- NOT RUN: no node_modules here (vitest/tsc/eslint never executed); SQL shapes checked by reading against the tests. Live DB test untested.
- Open: 1 test disputed (concurrent-runs span check unsatisfiable, see AN-T04-dispute.md); `$n::uuid` casts added on bound run id/tenant in SELECT lists (pg cannot infer them there).
