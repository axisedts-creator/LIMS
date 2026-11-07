# FD-T03 debug
- Cause: verify fails at `Cannot find package 'pg'` (__tests__/integration/helpers.ts:24). `pg` not a dep of services/api; no node_modules/pg. Not an implementation defect (repo code passed 83/83 on PG17 per impl/review notes).
- Fix needs devDependency `pg 8.23.1` in services/api/package.json + pnpm-lock.yaml: owned by C0-0D/C0-0A (01-CHUNK-MAP §3), not C4. Cannot fix in C4 impl code; no test/spec dispute.
- Action: CR `.orchestra/cr/FD-T03.md` already filed; FD-T03 stays blocked until C0-0D lands it, then rerun verify.
- Round 2: re-checked. Same cause: `pg` absent from services/api/package.json (grep: no match); pg@8.23.1 only in .pnpm store, not linked. No impl edit can fix. Still blocked on CR `.orchestra/cr/FD-T03.md` (C0-0D devDependency). No dispute.
- Round 3: re-checked. `pg` still absent from services/api/package.json and node_modules; same cause. No impl edit can fix. Still blocked on CR `.orchestra/cr/FD-T03.md` (C0-0D). No dispute.
- Round 4: `pg` blocker resolved (LD-60: pg 8.23.1 in services/api/package.json, linked in node_modules). New verify failure is environmental: Docker Desktop engine returns 500 on `_ping`/`docker ps` (pipe dockerDesktopLinuxEngine), so FD-T03.pg.sh cannot boot PG17. No impl/test defect; no code edit made.
- Action: restart Docker Desktop (or pre-export LIMS_TEST_APP_URL + LIMS_TEST_SUPER_URL to a migrated PG17), then rerun FD-T03-verify.cmd; expect 83/83.
