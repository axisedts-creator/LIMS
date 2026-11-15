Title: CR-C17-nnn: migration 20261115180000_migration_staging__create_migration_staging_schema.sql GRANTs to role lims_migration, which db/bootstrap/00_roles.sql does not create; DB bootstrap fails
From chunk: C17            To owner: C18 (T0B-13.C18) / C0-0B
Type: bug
Blocking? yes (HC-T13 review.test.ts, and every live-PG suite via HC-T03.pg.sh, cannot bootstrap)
Problem: HC-T13-verify.log now gets past the C7 migration and stops at `psql:/repo/db/migrations/20261115180000_migration_staging__create_migration_staging_schema.sql:68: ERROR:  role "lims_migration" does not exist`. The migration has 74 references to lims_migration (GRANT line 68 first). db/bootstrap/00_roles.sql line 6 says lims_migration is reserved (DEFER B4), not created, and db/tests/roles/00_bootstrap_roles.test.sql asserts it is not created. Migration header (lines 3-6) says the bootstrap role part is not translated (CR-C18-001, LD-202). So the migration and the bootstrap contradict each other.
Proposed change (exact): C18/C0 decides one of: (a) create lims_migration in 00_roles.sql and update the roles test; (b) guard/remove the lims_migration GRANTs and policies in the C18 migration until the role exists. Not C17b's choice.
Backward compatible? yes.
Tenant/security impact: none from C17; C18 policies TO lims_migration need the role to exist.
Alternatives considered: none in C17b scope (db/ and the C18 migration are not C17b-owned; HC-T13 code unaffected).
Tests that will prove it: HC-T13-verify.cmd bootstraps past migrations and runs review.test.ts.
