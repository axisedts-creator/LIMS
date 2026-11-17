# T0B-ASYNC-3 tests (tester, round 2, LD-341)
- core/__tests__/registry-sync.cli.test.ts (round 1, unchanged): static (no graphile-worker, pg Client, pg pinned to lockfile), runbook step 1, real CLI in a child process with empty env against fake Postgres.
- core/__tests__/registry-sync.all.test.ts: no payments env (done_when 5); NEW static scan: no top-level load/validate/parse*Config() call in any services/worker/src/jobs file (finding: payments/index.ts is the only one; others run at task time).
- jobs/payments/__tests__/unit/manifest.test.ts: "import throws" -> "startWorker rejects". NEW: import succeeds with empty/invalid env, no top-level loadPaymentsConfig (static). graphile-worker run() is a double.
- SEAM (writer, dispute if wrong): startWorker() in core/bootstrap.ts runs loadPaymentsConfig() before run() when the manifests include module 'payments' (main.ts passes MANIFESTS). bootstrap.test.ts (no payments manifest) must stay green. `config` export of payments/index.ts has no user.
- Run: `.orchestra/notes/T0B-ASYNC-3-verify.cmd` (cli, all, registry-sync, bootstrap, payments manifest tests).
- Needs after impl: `pg` in services/worker/package.json = lockfile version + importer entry. @types/pg not in brief (typecheck may need it: CR).
- Not tested: real Supabase, SET LOCAL ROLE lims_owner for lims_migrator (LD-281 unverified), PGSSLMODE=require on TLS. async-manifests.test.ts still stubs payments env (harmless; its runbook test still holds: worker start needs those names).
