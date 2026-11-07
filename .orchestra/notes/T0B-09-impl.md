# T0B-09 impl (writer, LD-30 + LD-38)
- `db/bootstrap/00_roles.sql`: `GRANT lims_app TO lims_migrator WITH INHERIT FALSE, SET TRUE;` (LD-30). `db/tools/gen-seeds.ts`: 010 runs `SET LOCAL ROLE lims_app` after claims; 002 keeps lims_owner.
- LD-38: `tools/codegen/gen-permissions.ts` SQL now starts `SET LOCAL ROLE lims_owner;` and ends `ON CONFLICT (code) DO NOTHING;` (CR-C0-T0B-09b; test forbids DO UPDATE). Regenerated 001 via `pnpm codegen`; `pnpm codegen:check` green.
- [CONV] gen-seeds does not write 001 (tools/codegen owns it).
- BLOCKER: `pnpm codegen` also rewrote `db/seeds/003` from `gen-access-actions.ts`, whose output differs from committed 003 (T0B-04): no `SET LOCAL ROLE lims_owner`, DO UPDATE, humanised display lost. Pre-existing generator drift, outside LD-38. Also touched `pnpm-lock.yaml` (pnpm auto-install). Restore both with `git checkout -- db/seeds/003_audit__g_cs_access_actions.sql pnpm-lock.yaml` (the sandbox blocked git checkout here).
- Node: `node --test tests/db/T0B-09.seeds.test.mjs` 1 fail (role-scoped test, on 003 only); 001 passes. Codegen vitest: 12/13 files pass (1 file failed; not looked into).
- Open: lead ruling for gen-access-actions.ts (same fix as 001, or C0-0C syncs it with T0B-04's 003), otherwise drift check and T0B-09 can't both be green. Live pgTAP (`bash db/tests/run-suites.sh db/tests/seeds/T0B-09_seeds.test.sql`) not run.
