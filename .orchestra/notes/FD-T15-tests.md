# FD-T15 tests (Settings F24, codes F25, anonymise F7, possible duplicates F26)
- services/api/src/modules/frontdesk/__tests__/admin/{helpers.ts,settings.test.ts,codes.test.ts,anonymise.test.ts,duplicates.test.ts}: US-FD-16.1/16.2; F24 If-Match (428/409), F7 rules incl. TRF deletion + privileged aal2, audit_log has no demographic value, access_log patient.anonymise/patient.update changed_fields, F26 same-tenant only.
- Run: `.orchestra\notes\FD-T15-verify.cmd` -> tests/frontdesk/FD-T15.pg.sh (FD-T03's docker PG17 boot, suite path -> __tests__/admin, --no-file-parallelism --fsModuleCache=false). Pre-export LIMS_TEST_APP_URL + LIMS_TEST_SUPER_URL to reuse a migrated+seeded DB.
- Ran (no DB): all 4 suites fail at import, `LIMS_TEST_APP_URL is not set` (shared helpers need the DB). Docker verify.cmd NOT run (needs approval), so not yet seen failing against the stubs.
- Not covered: UI text, Idempotency-Key replay (core pipeline).
