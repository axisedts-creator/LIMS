APPROVE

Round 11. Reviewed `git diff 854782b..HEAD` (7f9da0b). The round-10 item is fixed: `db/tests/billing_isolatable/T0B-11_billing_isolatable.sh:139` now has `GRANT CONNECT ON DATABASE $DB TO t0b11_reader` in the same `SU -c` statement. The assertion after it is unchanged, and `db/bootstrap/01_database.sql` is untouched.
The LD-52 storage skip is still in place on BOTH `$DB` and `$RDB` (build_db, with a comment that names CR-C0-T0B-12). The LD-51 helpers and the one-line `.orchestra/notes/T0B-11-verify.cmd` (node test `&&` run-live.cmd) still hold.
The diff touches only owned paths. No change to the tool, RLS, tenant scope or billing behaviour. No PHI and no secrets.
Live proof: `.orchestra/out/T0B-11-verify.log` (19:45:50, written after HEAD at 19:41) line 27 reads `ok - AC-0B-6.4: 9 tenant-A table fingerprints match after restore into a migrated empty billing schema, no other tenant's row restored, source unchanged`. The `&&` chain means the node test passed before the live run started.
Still open, outside T0B-11: CR-C0-T0B-12 (storage migration grant) and the unproven live run of the T0B-12 storage test (see LD-52).
