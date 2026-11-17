Title: CR-C0-0B-T0B-05-merge: main's db/seeds/001_core__g_permissions.sql kept; lane C0-0B seed generator/test now disagree with it
From chunk: C0-0B            To owner: C0-0B (with C0-0C for tools/codegen)
Type: shared-lib
Blocking? no
Problem: merging main into lane/C0-0B hit an add/add conflict on `db/seeds/001_core__g_permissions.sql` with incompatible decisions; main's version was kept per merger rule.
  - Main (T0C-05, `tools/codegen/codegen.ts` / `gen-permissions.ts`): no `SET LOCAL ROLE lims_owner`, columns `(code, module, privileged, phase)`, rows sorted by code, `ON CONFLICT (code) DO UPDATE SET module, privileged, phase, is_active = true`.
  - Lane (T0B-09, `db/tools/gen-seeds.ts` seed001()): `SET LOCAL ROLE lims_owner;`, columns incl. `description` (NULL), yaml order, `ON CONFLICT DO NOTHING`, provenance header citing 02-TRD §4.6 / 05-SCHEMA §11.
  Lost lane intent: the seed running as `lims_owner` (lims_app has SELECT only on core.g_permissions) and the "re-run inserts nothing" idempotency form.
  Effects now: `tests/db/T0B-09.seeds.test.mjs` "every seed is idempotent, owner-role scoped and destructive-free" fails (expects /SET\s+LOCAL\s+ROLE\s+lims_owner/ in 001); 14/15 pass. `node db/tools/gen-seeds.ts` still writes 001 and would overwrite main's file; `--check` reports 001 stale. Two generators own one file.
Proposed change (exact): (1) remove the `db/seeds/001_core__g_permissions.sql` entry from `out` in `db/tools/gen-seeds.ts` (its own [CONV] note already hands 001 to T0C-05); (2) C0-0C adds `SET LOCAL ROLE lims_owner;` to the 001 output of `tools/codegen/gen-permissions.ts`, matching 003 from gen-access-actions.ts; or, if the owner rules otherwise, T0B-09 test drops the owner-role assertion for 001.
Backward compatible? yes (generator/test alignment only)
Tenant/security impact: none new; class G table, RLS-exempt. SYNTHETIC data only.
Alternatives considered: keep lane file — rejected (merger rule: main wins on incompatible decisions).
Tests that will prove it: tests/db/T0B-09.seeds.test.mjs, tools/codegen/__tests__/codegen.test.ts, `node db/tools/gen-seeds.ts --check`.
