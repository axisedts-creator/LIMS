Title: CR-C0-SESSRANGE-1: how the T0B-SESSRANGE-1 migration may clamp identity.tenant_settings rows under FORCE RLS
From chunk: C0 (lane C0-0B, task T0B-SESSRANGE-1)            To owner: C0-0B (lead ruling; founder for any new privilege path)
Type: schema
Blocking? yes — T0B-SESSRANGE-1 done_when (3) "clamp existing rows first, then add the CHECKs" cannot be met; contract/service parts are unaffected.
Problem (what you cannot do today, with the user story / acceptance criterion it serves):
  LD-304 (ruling on CR-C0-LOGIN-1, 04 A8, REQ-SEC-073) asks a migration to clamp out-of-range idle_timeout_minutes / absolute_session_hours rows.
  Migrations must start `SET LOCAL ROLE lims_owner` (db/tools/check-migrations.ts:36). identity.tenant_settings is FORCE ROW LEVEL SECURITY
  (20261105001300:672), lims_owner is NOBYPASSRLS (db/bootstrap/00_roles.sql:9) and has only tenant_settings__select__owner_only (20261105001300:856).
  The clamp UPDATE therefore matches 0 rows; on a DB holding bad rows the ADD CONSTRAINT then fails 23514.
  Note: tenant_settings__idle__ck (15..30) and tenant_settings__absolute__ck (1..12) already exist in 20261105001300:475-476, so a DB built from
  the migrations cannot hold out-of-range rows; the clamp only matters for a DB built some other way.
Proposed change (exact) — choose one:
  (a) RECOMMENDED: drop the clamp from done_when (3). The migration only re-asserts the two CHECKs (idempotent DROP IF EXISTS / ADD) and fails loud
      (23514) on a bad DB; the founder fixes such rows by SQL as superuser before push-cloud.ps1. No new policy, function or name.
  (b) Add `CREATE POLICY tenant_settings__update__owner_only ON identity.tenant_settings FOR UPDATE TO lims_owner
      USING (current_setting('app.maintenance', true) = 'identity_settings_clamp') WITH CHECK (same)`, the file sets that key with set_config(..., true)
      before the UPDATE. New policy name + maintenance key; the static test (session-range.migration.test.ts:57) must then allow this one CREATE POLICY.
  (c) push-cloud.ps1 runs this file as the Supabase superuser without SET LOCAL ROLE; needs a check-migrations.ts exemption.
Backward compatible? yes (same ranges as today's CHECKs; no API change).
Tenant/security impact: (a) none. (b) new permanent lims_owner UPDATE path on a tenant table, gated by a session setting (same pattern as the existing owner_only policies). (c) a migration that bypasses the role convention.
IRD/regulatory impact: none.
Alternatives considered: SET LOCAL ROLE lims_app with platform-actor claims to use tenant_settings__update__platform (20261105001300:779) — rejected: a migration impersonating a platform actor writes misleading audit rows (tenant_settings__audit, :952).
Tests that will prove it:
  (a) migration static test drops the clamp-before-ADD assertion; pgTAP part (2) asserts 23514 on planted bad rows instead of clamped values.
  (b) pgTAP part (2) as written (clamp to 30/12, 15/1, idempotent) passes when run via the migration role.
  All options: the pgTAP file must `RESET ROLE` after each EXECUTE of the migration (see .orchestra/notes/T0B-SESSRANGE-1-ruling.md item 4).
