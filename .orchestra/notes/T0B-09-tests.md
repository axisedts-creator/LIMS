# T0B-09 tests (tester)
- `tests/db/T0B-09.seeds.test.mjs` (node, no DB): seed names, idempotent form (ON CONFLICT DO NOTHING, SET LOCAL ROLE lims_owner, no DELETE/DO UPDATE/now()/RLS bypass), 001 = permissions.yaml codes, 002 = system-actors.yaml UUIDs, 010 = fixed tenant ids/names, per-tenant claims, no `is_active` on memberships, synthetic-only, prod subset (prefix < 010 = 001-003, class-G only), run-suites load order.
- `db/tests/seeds/T0B-09_seeds.test.sql` (pgTAP, live): loaded content vs `_expected.sql`; idempotent re-run (row hash of every seeded table + audit_log count unchanged, 3 runs); partial state healed.
- `db/tests/seeds/_expected.sql`: generated fixture (yaml -> temp tables); regenerate via `node -e "process.env.T0B09_WRITE='1'; import('./tests/db/T0B-09.seeds.test.mjs')"`. Stale = node test fails.
- Run: `.orchestra\notes\T0B-09-verify.cmd` (node). Live: `bash db/tests/run-suites.sh db/tests/seeds/T0B-09_seeds.test.sql`.
- Now: 2 pass / 10 fail; fails only because `db/seeds/001`, `002`, `010` are absent (right reason). pgTAP NOT executed (no docker run here).
- Tester-defined: prod subset = numeric prefix < 010; 010 must hold users/memberships/membership_roles/membership_centres for fixture actors (per 02-TRD §3.5: 10 roles, centre-scoped centre_staff, locked user, partner_admin/member, patient); no staff user in both tenants.
- Not covered: `pnpm dev:up` itself (tools/devstack/up.ts, T0A-09), seedAuthUsers, GoTrue users for actors.
