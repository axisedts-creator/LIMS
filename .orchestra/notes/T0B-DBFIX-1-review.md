APPROVE

Reviewer, T0B-DBFIX-1, range ee9ff17a..1cc65dbd (27 files: db/tests/**, db/tests/run-suites.sh, tests/db/T0B-DBFIX-1.fixtures.test.mjs, notes).

Checked against LD-230 (1)-(9), LD-243/244/245:
- (1) every platform_staff fixture now uses platform_superadmin or platform_support (CHECK list); no platform_admin literal left; dependent expectations (role_codes, platform_role) updated consistently.
- (2)/(4) C12/C13/T9-A38 ins() set the row tenant's system claims and restore the saved claims; T-A2/T-Q3 audited fixture UPDATEs wrapped in tenant-A system claims, then cleared. Policy untouched.
- (3) like()/unlike() -> matches()/doesnt_match() with anchored regexes equivalent to the LIKE patterns (`_` -> `.`, literal `.` escaped); C6-T43 is() moved after RESET ROLE (lims_app has no USAGE on schema extensions, db/bootstrap/01_database.sql:13). Same assertion count, same messages, none conditional.
- (5) C16 regprocedure arg lists are types only; C18 DECLARE uses `;`.
- (6) tenant_settings NOT NULL columns, lock_reason_code 'other', 32-byte email_hmac (expected output updated to match), T0B-03 subquery narrowed to the row of that INSERT.
- (8) run-suites.sh storage stub (superuser, IF NOT EXISTS, RLS enabled, no rows) before the suite loop; covers the columns T0B-12_storage.test.sql reads (id, name, public, objects RLS). Bucket rows still absent by design (LD-54), CR filed.
- (9) roles test 17 adds lims_app|lims_migrator|false|true; T0B-02 test 57 now is_empty on PUBLIC entries (per LD-230, not weaker).
- Out-of-scope tests untouched; 5 non-blocking CRs listed in impl notes. No migration, policy, grant, seed, spec change. Synthetic data only, no secrets, no PHI.

Ran: node --test tests/db/T0B-DBFIX-1.fixtures.test.mjs = 47 pass, 0 fail; gen-isolation-probes --check = ok (438 files current).
Not verified: SQL suites (lane cannot run SQL). Founder rerun per impl notes line 7: LIMS_SKIP_GEN=1 bash db/tests/run-suites.sh <21 patched suites + 7 partners probes + storage/T0B-12_storage>.
