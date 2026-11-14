CHANGES
Lead ruling LD-161 (2026-11-14). One defect in this task's migration; nothing else is requested.

1. WRITER: db/migrations/20261113230000_instruments__add_truth_h80e_driver.sql has no role switch. The verify bootstrap of other lanes (C17 HC-T13 and HC-T16) dies at line 6 of this file: `psql ... ERROR: permission denied for schema instruments`. It is the only one of the 23 migrations on main without `SET LOCAL ROLE lims_owner;` (db/migrations/20261105002000_instruments__create_instruments_schema.sql line 7: "Single role switch: lims_owner"). Fix: add `SET LOCAL ROLE lims_owner;` after the header comments and before the INSERT. Nothing else in the migration changes: same row, status stays 'generic', no UPDATE.
2. TESTER: no new test is required by this note. If a C7 DB test applies the migration chain, run it.
3. VERIFY: run the full migration bootstrap, not only the C7 tests; it must pass with no error, and the c7-driver-registry-check must still pass with status generic.

Do not change any other file. Another failure is a new dispute, not part of this change.
