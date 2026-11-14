APPROVE

Reviewer: HC-T17 round 3 (LD-162), diff b1672baa..be6d543c.
Check run (services/api): `npx vitest run src/core/observability/__tests__/metrics.test.ts` = 18 passed (18).

Checked OK:
- core/observability/metrics.ts:121-128 DEFS: eight rows match 02-TRD §14 lines 589-596 verbatim (names, types, labels; tenant_id only on the three gauges; no PHI label). Nothing else in DEFS or createMetrics changed. LD-162 cited.
- core/observability/__tests__/metrics.test.ts:119-126 EXPECTED: same eight names and types, LD-162 cited. Round-2 item 1 resolved.
- .orchestra/notes/HC-T17-impl.md: now states the real rerun (18/18 at cd0fd333). Round-2 item 2 resolved.
- homecollection/metrics.ts: comment-only change. No PHI in logs, no secrets, no RLS/permission/route/error-code surface touched; paths per LD-162.

Not HC-T17 (outside this diff, reported for the lead only): running the whole homecollection folder shows 5 failures in files this diff does not touch — boot.test.ts (HC-T01 stub map vs implemented listHomeVisits; `module lab: index.ts exports no manifest`; a 30 s boot timeout) and repository static.test.ts (`${values.length}` in handovers.repo.ts SQL). The 23 other failing files need LIMS_TEST_APP_URL (live PG17), not run here.
