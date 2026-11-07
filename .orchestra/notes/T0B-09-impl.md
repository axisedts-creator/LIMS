# T0B-09 impl (writer, LD-30 + LD-38 + LD-41)
- `db/bootstrap/00_roles.sql`: `GRANT lims_app TO lims_migrator WITH INHERIT FALSE, SET TRUE;` (LD-30). `db/tools/gen-seeds.ts`: 010 `SET LOCAL ROLE lims_app` after claims; 002 lims_owner + DO NOTHING.
- LD-38/LD-41: `tools/codegen/gen-permissions.ts` + `gen-access-actions.ts` emit `SET LOCAL ROLE lims_owner;` + `ON CONFLICT (code) DO NOTHING;` (001, 003); regenerated via `pnpm codegen`. CR T0B-09-003 closed.
- Round 2: [CONV] gen-seeds writes fixed `created_at` ('2026-11-07 00:00:00+00') on insert-only link tables (role_permissions, membership_roles, membership_centres), so a healed row equals the original (was now() of the re-run tx; §5 test 25 failed). 010 regenerated; `gen-seeds --check` green.
- [CONV] gen-seeds does not write 001/003 (tools/codegen owns them).
- Node: `node --test tests/db/T0B-09.seeds.test.mjs` 15/15 pass. Live: `bash db/tests/run-suites.sh db/tests/seeds/T0B-09_seeds.test.sql` passes (no `not ok`).
- Open: `pnpm dev:up` not run; tables with updated_at keep now() defaults (not healed byte-identical, untested).
