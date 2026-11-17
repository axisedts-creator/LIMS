APPROVE

T0B-ASYNC-3 review (diff 7c0cc6761..HEAD).
- done_when (1): CLI block uses plain `pg.Client` (LIMS_MIGRATOR_DATABASE_URL else PG*/PGSSLMODE), `client.end()` in finally; syncRegistry/syncAllManifests unchanged; no graphile-worker on the path.
- (2) static no-graphile-worker test present (registry-sync.cli.test.ts). (3) pg 8.23.1 = lockfile version; lockfile diff is the 3-line importer entry only.
- (4) runbook step 1: no graphile_worker rights needed, PowerShell line with names only, no values.
- (5)/LD-341: loadPaymentsConfig moved from import of jobs/payments/index.ts to startWorker (bootstrap.ts), before run(); removed `config` export has no users. Static scan finds no other import-time config check in jobs/. manifest.test.ts converted to "startWorker rejects, run() never called".
- (6) no SQL, grants, roles, API or contract change. 8 product files, all inside the widened brief. No secrets, no PHI in logs.
- Checks run: verify set (5 files, 56 tests) pass; `pnpm --filter @lims/worker typecheck` clean.
- Non-blocking: stale "validates at import" comments in services/worker/src/manifests.ts:3, core/__tests__/async-env.ts:1, async-manifests.test.ts:196 (outside scope). Worker start now opens the DB pool and metrics server before the payments check fails; the process still exits before taking any job. Not verified: real Supabase run, SET LOCAL ROLE lims_owner as lims_migrator (LD-281), PGSSLMODE=require.
