# T0B-09 impl (writer, LD-30 + LD-38 + LD-41)
- `db/bootstrap/00_roles.sql`: `GRANT lims_app TO lims_migrator WITH INHERIT FALSE, SET TRUE;` (LD-30). `db/tools/gen-seeds.ts`: 010 `SET LOCAL ROLE lims_app` after claims; 002 lims_owner + DO NOTHING.
- LD-38: `tools/codegen/gen-permissions.ts` emits `SET LOCAL ROLE lims_owner;` + `ON CONFLICT (code) DO NOTHING;` (001).
- LD-41: `tools/codegen/gen-access-actions.ts` same for 003 (spec requires no updates; changes go by migration). Regenerated via `pnpm codegen`; `codegen:check` green. CR T0B-09-003 closed.
- [CONV] gen-seeds does not write 001/003 (tools/codegen owns them).
- Node: `node --test tests/db/T0B-09.seeds.test.mjs` 15/15 pass. Codegen vitest 13/13 files, 4225 pass.
- Live pgTAP: ok 1-23 (content + idempotent re-run x3 pass); aborts at test l.93 `audit_context_missing` = test defect, see T0B-09-dispute.md.
- Open: tester fix for §5 claims; `pnpm dev:up` not run.
