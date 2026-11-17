# T0B-ASYNC-3 tests (tester)
- NEW services/worker/src/core/__tests__/registry-sync.cli.test.ts: static (no graphile-worker in code, pg Client, pg pinned to lockfile version, lock importer block), runbook step 1, and the REAL CLI in a child process with an empty env against a fake Postgres (wire protocol, records statements): success via URL and via PG*, no graphile_worker statement, 42501 -> rollback + exit 1, unreachable DB -> exit 1.
- EDITED registry-sync.all.test.ts: payments env stub removed (done_when 5: sync with no module variables).
- Run: `.orchestra/notes/T0B-ASYNC-3-verify.cmd` (pnpm --dir services/worker exec vitest run ...cli, ...all, registry-sync.test).
- Needs after impl: `pg` in services/worker/package.json = 8.23.1 + lockfile importer entry (pnpm install --lockfile-only scope), else the child cannot resolve pg. @types/pg is not in the brief; typecheck may need it (writer's call, raise a CR if so).
- Runbook asserts: step 1 states no graphile_worker rights needed and no payments variables needed; has `$env:LIMS_MIGRATOR_DATABASE_URL` PowerShell line (names only).
- Not tested: real Supabase, SET LOCAL ROLE lims_owner for lims_migrator (LD-281 unverified), PGSSLMODE=require against a TLS server.
