Title: CR-C17-HC-T16: db/migrations/20261113230000_instruments__add_truth_h80e_driver.sql missing `SET LOCAL ROLE lims_owner;` — breaks migration chain
From chunk: C17            To owner: C7 (H80-T05 / CR-C7-019)
Type: bug
Blocking? yes (HC-T16 live suites cannot run: tests/homecollection/HC-T16.pg.sh aborts in migrations)
Problem: verify log `.orchestra/out/HC-T16-verify.log` ends with
  `20261113230000_instruments__add_truth_h80e_driver.sql:6: ERROR:  permission denied for schema instruments`
  The file runs as `lims_migrator` (no USAGE on schema instruments). The sibling `20261105002000_instruments__create_instruments_schema.sql:7`
  starts with `SET LOCAL ROLE lims_owner;`; the H80E migration does not. Not caused by HC-T16 code.
Proposed change (exact): insert `SET LOCAL ROLE lims_owner;` as first statement of 20261113230000_instruments__add_truth_h80e_driver.sql (files run with --single-transaction, so LOCAL is correct).
Backward compatible? yes
Tenant/security impact: none (g_drivers is a global reference table, no RLS).
Alternatives considered: editing it from C17 — rejected, path not owned by C17 (CLAUDE.md).
Tests that will prove it: `tests/homecollection/HC-T16.pg.sh` gets past the migration loop; same for any other lane's PG bootstrap.
