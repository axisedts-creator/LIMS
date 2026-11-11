-- T0B-09 live-DB assertions: seeds 001/002/003/010 load (AC-0A-6.1), are idempotent on re-run (done_when/tests), and carry the fixed synthetic fixtures
-- (02-TRD §3.5, §4.6; 05-SCHEMA §3.5, §3.7; REQ-SEC-040/044). Precondition: db/tests/run-suites.sh already loaded migrations + seeds once.
-- Run: bash db/tests/run-suites.sh db/tests/seeds/T0B-09_seeds.test.sql   (cwd = repo root, psql superuser; pgTAP in schema `extensions`).
-- Synthetic data only; one rolled-back txn; RLS is never disabled (the seeds themselves run SET LOCAL ROLE lims_owner + FORCE RLS).
BEGIN;
SET search_path = extensions, public, pg_catalog;
SELECT * FROM no_plan();

\i db/tests/seeds/_expected.sql

CREATE FUNCTION pg_temp.tenants() RETURNS uuid[] LANGUAGE sql IMMUTABLE AS
$$ SELECT ARRAY['01a1a98a-ac40-7000-8000-00000000a001', '01a1a98a-ac40-7000-8000-00000000b001']::uuid[] $$;
-- Whole-row text hash per seeded table (g-tables whole; tenant tables restricted to the two synthetic tenants). Superuser: sees past FORCE RLS.
CREATE FUNCTION pg_temp.snap() RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE r jsonb := '{}';
  t text; q text;
BEGIN
  FOREACH t IN ARRAY ARRAY['core.g_permissions', 'core.g_system_actors', 'audit.g_cs_access_actions'] LOOP
    EXECUTE format('SELECT jsonb_build_object(%L, jsonb_build_array(count(*), coalesce(md5(string_agg(x::text, ''|'' ORDER BY x::text)), ''''))) FROM %s x', t, t) INTO q;
    r := r || q::jsonb;
  END LOOP;
  FOREACH t IN ARRAY ARRAY['core.branches', 'core.collection_centres', 'core.roles', 'core.role_permissions', 'core.users', 'core.memberships',
                           'core.membership_roles', 'core.membership_centres', 'core.membership_branches'] LOOP
    EXECUTE format('SELECT jsonb_build_object(%L, jsonb_build_array(count(*), coalesce(md5(string_agg(x::text, ''|'' ORDER BY x::text)), ''''))) FROM %s x WHERE x.tenant_id = ANY (pg_temp.tenants())', t, t) INTO q;
    r := r || q::jsonb;
  END LOOP;
  SELECT r || jsonb_build_object('core.tenants', jsonb_build_array(count(*), coalesce(md5(string_agg(x::text, '|' ORDER BY x::text)), ''))) INTO r
    FROM core.tenants x WHERE x.id = ANY (pg_temp.tenants());
  RETURN r || jsonb_build_object('audit.audit_log.n', (SELECT count(*) FROM audit.audit_log));
END $f$;
CREATE FUNCTION pg_temp.rerun_done() RETURNS void LANGUAGE sql AS $$ RESET ROLE; SELECT set_config('request.jwt.claims', '', true) $$;

-- ---------- 1. initial load (what `pnpm dev:up` produced) ----------
SELECT set_eq($$ SELECT code, privileged FROM core.g_permissions $$, $$ SELECT code, privileged FROM exp_permissions $$, '001: g_permissions = permissions.yaml (code, privileged), nothing extra');
SELECT is((SELECT count(*) FROM core.g_permissions WHERE code LIKE 'platform.%'), (SELECT count(*) FROM exp_permissions WHERE code LIKE 'platform.%'), '001: platform.* codes seeded (granted to no tenant role)');
SELECT set_eq($$ SELECT module, actor_id FROM core.g_system_actors $$, $$ SELECT module, actor_id FROM exp_system_actors $$, '002: g_system_actors = system-actors.yaml (fixed UUIDs)');
SELECT cmp_ok((SELECT count(*) FROM audit.g_cs_access_actions), '>=', 40::bigint, '003: access-action coded set loaded');
SELECT is((SELECT count(*) FROM core.tenants WHERE id = ANY (pg_temp.tenants())), 2::bigint, '010: exactly the two permanent synthetic tenants');
SELECT results_eq($$ SELECT id, tenant_code FROM core.tenants WHERE id = ANY (pg_temp.tenants()) ORDER BY id $$,
  $$ VALUES ('01a1a98a-ac40-7000-8000-00000000a001'::uuid, 'tenant_a'), ('01a1a98a-ac40-7000-8000-00000000b001'::uuid, 'tenant_b') $$, '010: fixed ids + tenant_a/tenant_b');
SELECT ok(EXISTS (SELECT 1 FROM core.tenants WHERE id = (pg_temp.tenants())[1] AND 'Synthetic Lab Alpha' IN (legal_name, display_name))
      AND EXISTS (SELECT 1 FROM core.tenants WHERE id = (pg_temp.tenants())[2] AND 'Synthetic Lab Beta' IN (legal_name, display_name)), '010: names Synthetic Lab Alpha / Beta');
SELECT results_eq($$ SELECT tenant_id, count(*) FROM core.branches WHERE tenant_id = ANY (pg_temp.tenants()) GROUP BY 1 ORDER BY 1 $$,
  $$ VALUES ((pg_temp.tenants())[1], 2::bigint), ((pg_temp.tenants())[2], 2::bigint) $$, '010: 2 branches per tenant');
SELECT results_eq($$ SELECT tenant_id, count(*), count(*) FILTER (WHERE centre_kind = 'home_collection') FROM core.collection_centres WHERE tenant_id = ANY (pg_temp.tenants()) GROUP BY 1 ORDER BY 1 $$,
  $$ VALUES ((pg_temp.tenants())[1], 3::bigint, 1::bigint), ((pg_temp.tenants())[2], 3::bigint, 1::bigint) $$, '010: 3 centres per tenant, exactly one home_collection pseudo-centre');

-- ---------- 2. default roles + role permissions (copied from permissions.yaml defaults) ----------
SELECT set_eq($$ SELECT tenant_id, role_code, mfa_required FROM core.roles WHERE tenant_id = ANY (pg_temp.tenants()) $$,
  $$ SELECT t, r.role_code, r.mfa_required FROM exp_roles r CROSS JOIN unnest(pg_temp.tenants()) t $$, '010: the 10 default roles per tenant with yaml mfa_required');
SELECT is((SELECT count(*) FROM core.roles WHERE tenant_id = ANY (pg_temp.tenants()) AND NOT is_system_default), 0::bigint, '010: default roles flagged is_system_default');
SELECT set_eq($$ SELECT r.tenant_id, r.role_code, rp.permission_code FROM core.role_permissions rp JOIN core.roles r ON r.tenant_id = rp.tenant_id AND r.id = rp.role_id WHERE rp.tenant_id = ANY (pg_temp.tenants()) $$,
  $$ SELECT t, e.role_code, e.permission_code FROM exp_role_perms e CROSS JOIN unnest(pg_temp.tenants()) t $$, '010: role_permissions = yaml defaults for both tenants (no more, no less)');
SELECT is((SELECT count(*) FROM core.role_permissions WHERE tenant_id = ANY (pg_temp.tenants()) AND permission_code LIKE 'platform.%'), 0::bigint, '010: no platform.* in any tenant role (REQ-SEC-063)');
SELECT is((SELECT count(*) FROM core.role_permissions rp JOIN core.roles r ON r.id = rp.role_id WHERE rp.tenant_id <> r.tenant_id), 0::bigint, '010: no cross-tenant role_permissions row');

-- ---------- 3. memberships for every fixture actor ----------
SELECT set_eq($$ SELECT r.tenant_id, r.role_code FROM core.membership_roles mr JOIN core.roles r ON r.tenant_id = mr.tenant_id AND r.id = mr.role_id
                  JOIN core.memberships m ON m.tenant_id = mr.tenant_id AND m.id = mr.membership_id WHERE m.actor_type = 'user' AND m.status = 'active' AND m.locked_at IS NULL AND mr.tenant_id = ANY (pg_temp.tenants()) $$,
  $$ SELECT t, role_code FROM exp_roles CROSS JOIN unnest(pg_temp.tenants()) t $$, '010: per tenant every default role has an active, unlocked staff member');
SELECT results_eq($$ SELECT tenant_id, count(*) > 0 FROM core.memberships WHERE tenant_id = ANY (pg_temp.tenants()) AND actor_type = 'user' AND NOT all_centres
                      AND EXISTS (SELECT 1 FROM core.membership_centres mc WHERE mc.tenant_id = memberships.tenant_id AND mc.membership_id = memberships.id) GROUP BY 1 ORDER BY 1 $$,
  $$ VALUES ((pg_temp.tenants())[1], true), ((pg_temp.tenants())[2], true) $$, '010: a centre-scoped (not all_centres) staff actor per tenant');
SELECT results_eq($$ SELECT tenant_id, count(*) FILTER (WHERE locked_at IS NOT NULL) > 0 FROM core.memberships WHERE tenant_id = ANY (pg_temp.tenants()) GROUP BY 1 ORDER BY 1 $$,
  $$ VALUES ((pg_temp.tenants())[1], true), ((pg_temp.tenants())[2], true) $$, '010: a locked fixture user per tenant');
SELECT results_eq($$ SELECT tenant_id, array_agg(DISTINCT actor_type ORDER BY actor_type) FROM core.memberships WHERE tenant_id = ANY (pg_temp.tenants()) GROUP BY 1 ORDER BY 1 $$,
  $$ VALUES ((pg_temp.tenants())[1], ARRAY['partner', 'patient', 'user']), ((pg_temp.tenants())[2], ARRAY['partner', 'patient', 'user']) $$, '010: user, partner and patient memberships per tenant');
SELECT results_eq($$ SELECT tenant_id, array_agg(partner_role ORDER BY partner_role) FROM core.memberships WHERE tenant_id = ANY (pg_temp.tenants()) AND actor_type = 'partner' GROUP BY 1 ORDER BY 1 $$,
  $$ VALUES ((pg_temp.tenants())[1], ARRAY['partner_admin', 'partner_member']), ((pg_temp.tenants())[2], ARRAY['partner_admin', 'partner_member']) $$, '010: partner_admin + partner_member per tenant');
SELECT is((SELECT count(*) FROM core.memberships WHERE tenant_id = ANY (pg_temp.tenants()) AND status = 'active' AND NOT is_active), 0::bigint, '010: status active => generated is_active true');
SELECT is((SELECT count(*) FROM (SELECT user_id FROM core.memberships WHERE actor_type = 'user' AND status IN ('invited', 'active') GROUP BY 1 HAVING count(DISTINCT tenant_id) > 1) x), 0::bigint, '010: no staff user in both tenants (08 R27)');

-- ---------- 4. idempotent re-run (the task test) ----------
CREATE TEMP TABLE s0 AS SELECT pg_temp.snap() AS j;
\i db/seeds/001_core__g_permissions.sql
SELECT pg_temp.rerun_done();
\i db/seeds/002_core__g_system_actors.sql
SELECT pg_temp.rerun_done();
\i db/seeds/003_audit__g_cs_access_actions.sql
SELECT pg_temp.rerun_done();
\i db/seeds/010_core__synthetic_tenants.sql
SELECT pg_temp.rerun_done();
SELECT is((SELECT pg_temp.snap() FROM (SELECT 1) _), (SELECT j FROM s0), 're-running 001+002+003+010 changes no row (count + whole-row hash of every seeded table) and writes no audit_log row');

-- twice more, each file on its own, same result (order independence within the numeric order)
\i db/seeds/010_core__synthetic_tenants.sql
SELECT pg_temp.rerun_done();
\i db/seeds/001_core__g_permissions.sql
SELECT pg_temp.rerun_done();
SELECT is(pg_temp.snap(), (SELECT j FROM s0), 'third run: still identical');

-- ---------- 5. partial state is healed, never duplicated ----------
-- ruling T0B-09: audited DELETE needs actor context (tg_row_audit, A28.5); same system actor as seed 010, no app.maintenance
SELECT set_config('request.jwt.claims', json_build_object('tenant_id',(pg_temp.tenants())[1],'sub','01a1b34e-1000-7eee-9d29-d7ca59a102b5','actor_type','system')::text, true);
DELETE FROM core.role_permissions WHERE tenant_id = (pg_temp.tenants())[1] AND permission_code = (SELECT permission_code FROM exp_role_perms WHERE role_code = 'tenant_admin' ORDER BY 1 LIMIT 1)
  AND role_id = (SELECT id FROM core.roles WHERE tenant_id = (pg_temp.tenants())[1] AND role_code = 'tenant_admin');
SELECT pg_temp.rerun_done();
SELECT is((SELECT count(*) FROM core.role_permissions WHERE tenant_id = ANY (pg_temp.tenants())), (SELECT (j -> 'core.role_permissions' ->> 0)::bigint - 1 FROM s0), 'precondition: one default grant removed');
\i db/seeds/010_core__synthetic_tenants.sql
SELECT pg_temp.rerun_done();
SELECT is((SELECT j -> 'core.role_permissions' FROM (SELECT pg_temp.snap() AS j) _), (SELECT j -> 'core.role_permissions' FROM s0), 're-run restores the removed default grant (and only it)');

SELECT * FROM finish();
ROLLBACK;
