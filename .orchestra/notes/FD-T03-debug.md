# FD-T03 debug
- Cause: verify fails at `Cannot find package 'pg'` (__tests__/integration/helpers.ts:24). `pg` not a dep of services/api; no node_modules/pg. Not an implementation defect (repo code passed 83/83 on PG17 per impl/review notes).
- Fix needs devDependency `pg 8.23.1` in services/api/package.json + pnpm-lock.yaml: owned by C0-0D/C0-0A (01-CHUNK-MAP §3), not C4. Cannot fix in C4 impl code; no test/spec dispute.
- Action: CR `.orchestra/cr/FD-T03.md` already filed; FD-T03 stays blocked until C0-0D lands it, then rerun verify.
- Round 2: re-checked. Same cause: `pg` absent from services/api/package.json (grep: no match); pg@8.23.1 only in .pnpm store, not linked. No impl edit can fix. Still blocked on CR `.orchestra/cr/FD-T03.md` (C0-0D devDependency). No dispute.
