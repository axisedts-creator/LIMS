# T0B-09 impl (writer)
- Added `db/tools/gen-seeds.ts` (writes 001, 002, 010; `--check` for staleness) and generated `db/seeds/001_core__g_permissions.sql`, `002_core__g_system_actors.sql`, `010_core__synthetic_tenants.sql`. 003 unchanged (T0B-04).
- [CONV] 001 generated here until T0C-05 owns it; phase default '1', module = first code segment, description NULL.
- [CONV] 010 ids from @lims/test-fixtures (tenants/actors); role id `<n>4<nn>`, membership id `<n>5<nn>`, branch codes `A-B1`..; locked user `locked_at` fixed '2026-11-07 00:00:00+00', reason 'other'; claims = core system actor, actor_type system.
- Node: `node --test tests/db/T0B-09.seeds.test.mjs` 15/15 pass. Live pgTAP: 001-003 load; 010 FAILS `new row violates row-level security policy for table "tenants"`.
- BLOCKED: `.orchestra/cr/T0B-09.md` — seeds as lims_owner have no INSERT policy on FORCE-RLS tables; proposed `GRANT lims_app TO lims_migrator WITH INHERIT FALSE, SET TRUE` + 010 `SET LOCAL ROLE lims_app`.
- Open: membership_branches not seeded (not required); GoTrue users (seedAuthUsers) out of scope.
