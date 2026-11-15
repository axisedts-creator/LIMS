APPROVE

SESSION-ACTOR-1 review (reviewer, 2026-11-15). Range: `f7d8b443..HEAD` is empty (HEAD = f7d8b443); reviewed the task commits `3fb9ae34..HEAD` (e827ff6b tester, 0e8bc495 writer) against LD-208 / LD-209.

LD-209 checklist:
- Scope: no table, column, policy, FORCE RLS, trigger, other-role grant or existing-function change. Only paths: db/migrations (1 new), db/meta/definer-inventory.yaml (+1 row), db/tests/identity (new pgTAP + T0B-06 count 19->20), services/api/src/modules/identity, plus db/tests/isolation/_registry.sql (+1 generated row, mirror of the inventory; required by T0B-08 inventory tests; read as LD-208 (2) "any existing test that lists the identity definers").
- Migration timestamp 20261115155000: OK. `SET LOCAL ROLE lims_owner`, plpgsql SECURITY DEFINER, `SET search_path = ''`, read-only (SELECT only), sets app.pre_user_id / app.pre_tenant_id and resets both to '' before RETURN: OK. REVOKE ALL FROM PUBLIC; EXECUTE to lims_api only: OK.
- Reads satisfied by existing owner policies (checked in migrations): users (pre_user_id), memberships (pre_user_id), tenants (pre_tenant_id), roles (pre_tenant_id), membership_roles (pre_tenant_id + membership of pre_user_id), platform_staff (USING true). No RLS weakening needed. Column names (display_name, role_code, is_active, status, tenant_code) match the schema and app.identity_login_context.
- No row (or unusable display_name / role_codes) => LimsError common.internal + log "session actor missing" with request_id only: OK (session-actor.ts). Login reads actor before any session write; resolve reads it after lapse/blocked and BEFORE the GoTrue refresh: OK.
- Actor carries only display_name, roles, tenant_code (tenant sessions only); no e-mail, id, token, no support_session: OK (tests assert it). SQL uses bind parameters only.
- Contract: 200 bodies of loginStaff/loginPartner/openMobileSession(staff)/resolveSession validated against identity.yaml SessionState with RESPONSE_AJV_OPTIONS-equivalent options.
- Ran here: `vitest run` of the 3 SESSION-ACTOR-1 files: 44/44 pass. Not re-run: full identity/core suite (writer reports 6258 pass, 1 pre-existing role-packs/route-guard fail).
- The migration and SESSION-ACTOR-1_session_actor.test.sql were NOT run in the lane (no psql/docker); stated in impl and tests notes. Must run on a migrated DB (push-cloud.ps1 / pg_prove) before relying on it.

Observations (non-blocking, for the lead):
- File count: 16 non-.orchestra files vs LD-208 "at most 14" (extra: _registry.sql generated mirror, plus 2 test helpers auth.helpers.ts / session.helpers.ts). All are test/derived files in the authorised areas; no production-path file outside scope. Lead to confirm this is within the founder's authority.
- Partner memberships with no membership_roles get `roles: []` (schema allows; no minItems).
- s10.3 transcription CR is non-blocking per LD-209.
