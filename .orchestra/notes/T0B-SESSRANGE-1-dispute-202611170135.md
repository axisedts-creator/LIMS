# T0B-SESSRANGE-1 dispute (writer): the migration clamp cannot run under the migration conventions; the pgTAP suite leaks the migration role
Done (vitest 5 files / 297 pass): contracts/openapi/identity.yaml 3 carriers narrowed to idle 15..30 / absolute 1..12 (LD-304); migration
db/migrations/20261117010000_identity__narrow_tenant_settings_session_ranges.sql written (static test green; check-migrations clean for this file).
BLOCKER 1 (design, not code): check-migrations.ts:35 requires the first statement `SET LOCAL ROLE lims_owner`. identity.tenant_settings is FORCE ROW LEVEL SECURITY
(20261105001300:672) and lims_owner is NOBYPASSRLS (db/bootstrap/00_roles.sql:9) with NO UPDATE policy on that table (only tenant_settings__select__owner_only).
So the clamp UPDATE matches 0 rows when run by the runner (lims_migrator -> lims_owner); on a DB with out-of-range rows the ADD CONSTRAINT then fails (23514) instead of clamping.
The test forbids CREATE POLICY / CREATE FUNCTION / NO FORCE, so the writer cannot add a bypass. Options for the lead: (a) accept "fail loud" (no clamp on a bad cloud DB; founder fixes rows by SQL as superuser first),
(b) allow a lims_owner UPDATE policy gated on current_setting('app.maintenance') = 'identity_settings_clamp' (pattern of tenant_settings__select__owner_only), set in the file, or
(c) push-cloud.ps1 runs this file as the Supabase superuser (bypasses RLS) - then the file must skip SET LOCAL ROLE, which check-migrations rejects.
BLOCKER 2 (test): the pgTAP suite runs the file inside its own transaction via EXECUTE; the file's `SET LOCAL ROLE lims_owner` stays active, so the next pg_temp.mig_sql()
(pg_read_file, superuser only) and the later asserts run as lims_owner and fail; and the clamp asserts (30/12, 15/1) fail per blocker 1. Suggest the test RESET ROLE after each EXECUTE.
Not run: pgTAP (no docker). Pre-existing unrelated lint error: 20261115130000 partners.manifest_lines GRANT DELETE.
