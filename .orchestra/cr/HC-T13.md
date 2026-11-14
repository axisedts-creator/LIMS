Title: CR-C17-nnn: migration 20261113230000_instruments__add_truth_h80e_driver.sql lacks `SET LOCAL ROLE lims_owner;` and breaks DB bootstrap
From chunk: C17            To owner: C7 (H80-T05)
Type: bug
Blocking? yes (HC-T13 review.test.ts, and every live-PG suite via HC-T03.pg.sh, cannot bootstrap)
Problem: bootstrap applies migrations as `lims_migrator` (HC-T03.pg.sh MIG). Migration fails with `ERROR: permission denied for schema instruments` at line 6. Every other schema migration (e.g. 20261105002000_instruments__create_instruments_schema.sql line 7) starts with `SET LOCAL ROLE lims_owner;`.
Proposed change (exact): add `SET LOCAL ROLE lims_owner;` as first statement of db/migrations/20261113230000_instruments__add_truth_h80e_driver.sql.
Backward compatible? yes.
Tenant/security impact: none (global g_drivers row).
Alternatives considered: none in C17b scope (file is C7's; HC-T13 code unaffected).
Tests that will prove it: HC-T13-verify.cmd bootstraps past migrations and runs review.test.ts.
