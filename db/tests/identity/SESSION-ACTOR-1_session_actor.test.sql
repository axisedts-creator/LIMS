-- SESSION-ACTOR-1 (LD-208, 2026-11-15) live-DB assertions for app.identity_session_actor(p_user_id uuid, p_tenant_id uuid, p_membership_id uuid)
--   RETURNS TABLE (display_name text, role_codes text[], tenant_code text): plpgsql SECURITY DEFINER, owner lims_owner, search_path '', read-only, EXECUTE lims_api only.
-- Contract: p_tenant_id NULL -> the ACTIVE identity.platform_staff row of p_user_id (role_codes = ARRAY[role_code], tenant_code NULL).
--           otherwise core.users.display_name of p_user_id in that tenant + the role_code of the ACTIVE roles of membership p_membership_id (<= 20, ORDER BY role_code)
--           + core.tenants.tenant_code. No row when the user, membership or tenant is unknown or inactive. app.pre_user_id / app.pre_tenant_id are '' after the call.
-- Same style as T0B-06_definers.test.sql (stand-in fixture when C2's tables are absent; RLS is never disabled). Synthetic data only. One rolled-back transaction.
-- Run: pg_prove -d <migrated db> db/tests/identity/SESSION-ACTOR-1_session_actor.test.sql   (superuser; pgTAP in schema `extensions`; run from the repo root)
-- The lane has no psql / docker: this file has NOT been run by its author (see .orchestra/notes/SESSION-ACTOR-1-tests.md).
BEGIN;
SET search_path = extensions, public, pg_catalog;
SELECT * FROM no_plan();

\ir ../fixtures/T0B-06_identity_standin.sql

-- ---------------------------------------------------------------- helpers (same shapes as T0B-06)
CREATE FUNCTION pg_temp.id(k int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('01900000-0000-7000-8000-' || lpad(to_hex(k), 12, '0'))::uuid $$;
CREATE FUNCTION pg_temp.q(k int) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT quote_literal(pg_temp.id(k)::text) || '::uuid' $$;
-- run p_sql as p_role; modes: v scalar text, j jsonb array of the SELECT's rows. Errors come back as 'E<SQLSTATE>:<message>'.
CREATE FUNCTION pg_temp.x(p_role text, p_sql text, p_mode text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE r text;
BEGIN
  PERFORM set_config('request.jwt.claims', '', true);
  EXECUTE format('SET LOCAL ROLE %I', p_role);
  BEGIN
    IF p_mode = 'v' THEN EXECUTE p_sql INTO r; r := coalesce(r, '<null>');
    ELSE EXECUTE 'SELECT coalesce(jsonb_agg(to_jsonb(t)), ''[]''::jsonb)::text FROM (' || p_sql || ') t' INTO r;
    END IF;
  EXCEPTION WHEN OTHERS THEN r := 'E' || SQLSTATE || ':' || SQLERRM;
  END;
  RESET ROLE;
  RETURN r;
END $f$;
CREATE FUNCTION pg_temp.apij(p_sql text) RETURNS jsonb LANGUAGE sql AS $$ SELECT CASE WHEN r LIKE 'E%' THEN to_jsonb(r) ELSE r::jsonb END FROM (SELECT pg_temp.x('lims_api', p_sql, 'j') r) s $$;
-- SELECT * FROM app.identity_session_actor(user, tenant, membership); k = fixture number, 0 = NULL
CREATE FUNCTION pg_temp.sa(u int, t int, m int) RETURNS jsonb LANGUAGE sql AS $$
  SELECT pg_temp.apij('SELECT * FROM app.identity_session_actor(' || CASE u WHEN 0 THEN 'NULL::uuid' ELSE pg_temp.q(u) END || ',' || CASE t WHEN 0 THEN 'NULL::uuid' ELSE pg_temp.q(t) END
                      || ',' || CASE m WHEN 0 THEN 'NULL::uuid' ELSE pg_temp.q(m) END || ')') $$;

-- ---------------------------------------------------------------- fixtures (superuser; triggers / FK checks off while seeding)
SET LOCAL session_replication_role = replica;
INSERT INTO core.tenants (id, tenant_code, legal_name, display_name, status, created_by, updated_by) VALUES
  (pg_temp.id(1), 'lab_a', 'Lab A Pvt Ltd', 'Lab A', 'active',    pg_temp.id(99), pg_temp.id(99)),
  (pg_temp.id(2), 'lab_b', 'Lab B Pvt Ltd', 'Lab B', 'suspended', pg_temp.id(99), pg_temp.id(99));
INSERT INTO core.users (tenant_id, id, display_name, created_by, updated_by) VALUES
  (pg_temp.id(1), pg_temp.id(31), 'Ana Demo',     pg_temp.id(99), pg_temp.id(99)),   -- tenant 1, two active roles + one inactive role
  (pg_temp.id(1), pg_temp.id(36), 'Dormant Demo', pg_temp.id(99), pg_temp.id(99)),   -- tenant 1, deactivated membership
  (pg_temp.id(2), pg_temp.id(33), 'Beta Demo',    pg_temp.id(99), pg_temp.id(99)),   -- tenant 2 (suspended)
  (pg_temp.id(1), pg_temp.id(38), 'Other Demo',   pg_temp.id(99), pg_temp.id(99)),   -- tenant 1, a different membership (one role: viewer)
  (pg_temp.id(1), pg_temp.id(40), 'Many Demo',    pg_temp.id(99), pg_temp.id(99));   -- tenant 1, 22 active roles (cap 20)
INSERT INTO core.memberships (id, tenant_id, user_id, actor_type, status, partner_role, locked_at, locked_by, updated_at, created_by, updated_by) VALUES
  (pg_temp.id(41), pg_temp.id(1), pg_temp.id(31), 'user', 'active',      NULL, NULL, NULL, now(), pg_temp.id(99), pg_temp.id(99)),
  (pg_temp.id(46), pg_temp.id(1), pg_temp.id(36), 'user', 'deactivated', NULL, NULL, NULL, now(), pg_temp.id(99), pg_temp.id(99)),
  (pg_temp.id(43), pg_temp.id(2), pg_temp.id(33), 'user', 'active',      NULL, NULL, NULL, now(), pg_temp.id(99), pg_temp.id(99)),
  (pg_temp.id(50), pg_temp.id(1), pg_temp.id(38), 'user', 'active',      NULL, NULL, NULL, now(), pg_temp.id(99), pg_temp.id(99)),
  (pg_temp.id(60), pg_temp.id(1), pg_temp.id(40), 'user', 'active',      NULL, NULL, NULL, now(), pg_temp.id(99), pg_temp.id(99));
INSERT INTO core.roles (id, tenant_id, role_code, display_name, mfa_required, is_active, created_by, updated_by) VALUES
  (pg_temp.id(56), pg_temp.id(1), 'lab_manager', 'Lab Manager', false, true,  pg_temp.id(99), pg_temp.id(99)),   -- inserted before 'admin' on purpose: the order is by role_code, not insertion
  (pg_temp.id(57), pg_temp.id(1), 'admin',       'Admin',       true,  true,  pg_temp.id(99), pg_temp.id(99)),
  (pg_temp.id(58), pg_temp.id(1), 'zeta_retired', 'Zeta Retired', false, false, pg_temp.id(99), pg_temp.id(99)),  -- inactive: never in the actor
  (pg_temp.id(59), pg_temp.id(1), 'viewer',      'Viewer',      false, true,  pg_temp.id(99), pg_temp.id(99)),
  (pg_temp.id(70), pg_temp.id(2), 'b_admin',     'B Admin',     false, true,  pg_temp.id(99), pg_temp.id(99));
INSERT INTO core.roles (id, tenant_id, role_code, display_name, mfa_required, is_active, created_by, updated_by)
  SELECT pg_temp.id(100 + n), pg_temp.id(1), 'role_' || lpad(n::text, 2, '0'), 'Role ' || n, false, true, pg_temp.id(99), pg_temp.id(99) FROM generate_series(1, 22) n;
INSERT INTO core.membership_roles (tenant_id, membership_id, role_id, created_by) VALUES
  (pg_temp.id(1), pg_temp.id(41), pg_temp.id(56), pg_temp.id(99)),
  (pg_temp.id(1), pg_temp.id(41), pg_temp.id(57), pg_temp.id(99)),
  (pg_temp.id(1), pg_temp.id(41), pg_temp.id(58), pg_temp.id(99)),
  (pg_temp.id(1), pg_temp.id(46), pg_temp.id(57), pg_temp.id(99)),
  (pg_temp.id(1), pg_temp.id(50), pg_temp.id(59), pg_temp.id(99)),
  (pg_temp.id(2), pg_temp.id(43), pg_temp.id(70), pg_temp.id(99));
INSERT INTO core.membership_roles (tenant_id, membership_id, role_id, created_by)
  SELECT pg_temp.id(1), pg_temp.id(60), pg_temp.id(100 + n), pg_temp.id(99) FROM generate_series(1, 22) n;
INSERT INTO identity.platform_staff (id, user_id, email_normalized, display_name, role_code, is_active, created_by, updated_by) VALUES
  (pg_temp.id(61), pg_temp.id(32), 'staff32@example.test', 'Staff 32', 'platform_superadmin',   true,  pg_temp.id(99), pg_temp.id(99)),
  (pg_temp.id(63), pg_temp.id(42), 'staff42@example.test', 'Staff 42', 'platform_support', false, pg_temp.id(99), pg_temp.id(99));
SET LOCAL session_replication_role = origin;

-- ================================================================ catalog: attributes + grants (C0 05-SCHEMA §4.3, 08 A10.5)
SELECT ok(to_regprocedure('app.identity_session_actor(uuid,uuid,uuid)') IS NOT NULL, 'exists: app.identity_session_actor(uuid,uuid,uuid)');
SELECT ok(p.prosecdef, 'SECURITY DEFINER') FROM pg_proc p WHERE p.oid = to_regprocedure('app.identity_session_actor(uuid,uuid,uuid)');
SELECT is(pg_get_userbyid(p.proowner)::text, 'lims_owner', 'owner lims_owner') FROM pg_proc p WHERE p.oid = to_regprocedure('app.identity_session_actor(uuid,uuid,uuid)');
SELECT is(l.lanname::text, 'plpgsql', 'language plpgsql') FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang WHERE p.oid = to_regprocedure('app.identity_session_actor(uuid,uuid,uuid)');
SELECT ok(array_to_string(p.proconfig, ',') ~ 'search_path=("")?$', 'proconfig search_path is empty (SET search_path = '''')') FROM pg_proc p WHERE p.oid = to_regprocedure('app.identity_session_actor(uuid,uuid,uuid)');
SELECT ok(p.proacl IS NOT NULL AND NOT EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0), 'no EXECUTE for PUBLIC') FROM pg_proc p WHERE p.oid = to_regprocedure('app.identity_session_actor(uuid,uuid,uuid)');
SELECT ok(NOT EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname IN ('anon', 'authenticated') AND has_function_privilege(r.oid, p.oid, 'EXECUTE')), 'no EXECUTE for anon / authenticated')
  FROM pg_proc p WHERE p.oid = to_regprocedure('app.identity_session_actor(uuid,uuid,uuid)');
SELECT ok(has_function_privilege('lims_api', p.oid, 'EXECUTE') AND NOT has_function_privilege('lims_worker', p.oid, 'EXECUTE')
          AND NOT has_function_privilege('lims_app', p.oid, 'EXECUTE') AND NOT has_function_privilege('lims_queue', p.oid, 'EXECUTE'),
          'EXECUTE only for lims_api (not lims_worker, lims_app, lims_queue)') FROM pg_proc p WHERE p.oid = to_regprocedure('app.identity_session_actor(uuid,uuid,uuid)');
-- LD-230 (3): pgTAP has no like()/unlike(); matches()/doesnt_match() with the anchored regex of the same LIKE pattern (% -> .*, _ -> .)
SELECT matches(pg_temp.x('lims_worker', 'SELECT count(*) FROM app.identity_session_actor(' || pg_temp.q(31) || ',' || pg_temp.q(1) || ',' || pg_temp.q(41) || ')', 'v'), '^E42501:.*$', 'lims_worker cannot call it (42501)');
SELECT matches(pg_temp.x('lims_queue',  'SELECT count(*) FROM app.identity_session_actor(' || pg_temp.q(31) || ',' || pg_temp.q(1) || ',' || pg_temp.q(41) || ')', 'v'), '^E42501:.*$', 'lims_queue cannot call it (42501)');
-- result shape: exactly (display_name text, role_codes text[], tenant_code text): nothing like an e-mail, an id or a token can leave the function
SELECT is(pg_get_function_result(to_regprocedure('app.identity_session_actor(uuid,uuid,uuid)')), 'TABLE(display_name text, role_codes text[], tenant_code text)',
          'RETURNS TABLE (display_name text, role_codes text[], tenant_code text) and nothing else');
-- read-only: no DML in the body (the function only SELECTs and sets/resets the two app.pre_* GUCs)
SELECT ok(pg_get_functiondef(p.oid) !~* '(insert\s+into|update\s+[a-z_."]+\s+set|delete\s+from|truncate)', 'body has no INSERT / UPDATE / DELETE / TRUNCATE')
  FROM pg_proc p WHERE p.oid = to_regprocedure('app.identity_session_actor(uuid,uuid,uuid)');
SELECT ok(pg_get_functiondef(p.oid) ~ 'app\.pre_user_id' AND pg_get_functiondef(p.oid) ~ 'app\.pre_tenant_id', 'body uses the app.pre_user_id / app.pre_tenant_id owner-policy GUCs (08 A12.1), like identity_login_context')
  FROM pg_proc p WHERE p.oid = to_regprocedure('app.identity_session_actor(uuid,uuid,uuid)');
-- no RLS weakening: the single USING (true) of the database (platform_staff__select__owner_only) stays the only one; FORCE RLS everywhere the function reads
SELECT is((SELECT count(*) FROM pg_policies WHERE qual = 'true' OR with_check = 'true'), 1::bigint, 'USING (true) / WITH CHECK (true) still appears exactly once (no policy was weakened)');
SELECT ok(NOT EXISTS (SELECT 1 FROM pg_policies WHERE (qual ~ 'app\.(pre_|maintenance)' OR with_check ~ 'app\.(pre_|maintenance)') AND roles <> '{lims_owner}'
                      AND NOT (schemaname = 'reporting' AND roles = '{lims_reporting_lookup}')),   -- STALE T0B-GREEN-3: C6 lookup policies are TO lims_reporting_lookup (08-CR-REGISTER C6-002, A10.5, D-30; as db/tests/policy, T0B-GREEN-2)
          'every policy mentioning app.pre_* is still TO lims_owner only (reporting lookup policies: TO lims_reporting_lookup only)');
SELECT ok((SELECT bool_and(c.relforcerowsecurity AND c.relrowsecurity) FROM pg_class c WHERE c.oid IN
           ('identity.platform_staff'::regclass, 'core.users'::regclass, 'core.tenants'::regclass, 'core.memberships'::regclass, 'core.roles'::regclass, 'core.membership_roles'::regclass)),
          'FORCE + ENABLE RLS on every table the function reads');

-- ================================================================ platform staff (p_tenant_id NULL)
SELECT is(jsonb_array_length(pg_temp.sa(32, 0, 0)), 1, 'platform: active staff user -> exactly one row');
SELECT is(pg_temp.sa(32, 0, 0) -> 0 ->> 'display_name', 'Staff 32', 'platform: display_name from identity.platform_staff (the user has no core.users row)');
SELECT is(pg_temp.sa(32, 0, 0) -> 0 -> 'role_codes', '["platform_superadmin"]'::jsonb, 'platform: role_codes = ARRAY[platform_staff.role_code]');
SELECT is(pg_temp.sa(32, 0, 0) -> 0 -> 'tenant_code', 'null'::jsonb, 'platform: tenant_code is NULL (a platform session is not a tenant session)');
SELECT is(jsonb_array_length(pg_temp.sa(42, 0, 0)), 0, 'platform: INACTIVE staff row -> no row');
SELECT is(jsonb_array_length(pg_temp.sa(31, 0, 0)), 0, 'platform: a tenant user without a platform_staff row, NULL tenant -> no row (never falls back to core.users)');
SELECT is(jsonb_array_length(pg_temp.sa(555, 0, 0)), 0, 'platform: unknown user -> no row');
SELECT is(jsonb_array_length(pg_temp.sa(0, 0, 0)), 0, 'NULL, NULL, NULL -> no row, no error');
SELECT is(jsonb_array_length(pg_temp.sa(0, 1, 41)), 0, 'NULL user with a real tenant and membership -> no row, no error');

-- ================================================================ tenant sessions
SELECT is(jsonb_array_length(pg_temp.sa(31, 1, 41)), 1, 'tenant: active user + active membership + active tenant -> exactly one row');
SELECT is(pg_temp.sa(31, 1, 41) -> 0 ->> 'display_name', 'Ana Demo', 'tenant: display_name from core.users in that tenant');
SELECT is(pg_temp.sa(31, 1, 41) -> 0 -> 'role_codes', '["admin", "lab_manager"]'::jsonb, 'tenant: the two ACTIVE roles of the membership, ORDER BY role_code (inactive role zeta_retired and other memberships'' roles excluded)');
SELECT is(pg_temp.sa(31, 1, 41) -> 0 ->> 'tenant_code', 'lab_a', 'tenant: tenant_code from core.tenants');
SELECT is(pg_temp.sa(38, 1, 50) -> 0 -> 'role_codes', '["viewer"]'::jsonb, 'tenant: another membership of the same tenant gets only its own role');
SELECT is((SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(pg_temp.sa(31, 1, 41) -> 0) k), ARRAY['display_name', 'role_codes', 'tenant_code'],
          'tenant: the row has exactly display_name, role_codes, tenant_code (no e-mail, no id, no token column)');
SELECT is(jsonb_array_length(pg_temp.sa(40, 1, 60)), 1, 'tenant: 22 active roles -> still one row');
SELECT is(jsonb_array_length(pg_temp.sa(40, 1, 60) -> 0 -> 'role_codes'), 20, 'tenant: role_codes capped at 20 (SessionState.actor.roles maxItems 20)');
SELECT is(pg_temp.sa(40, 1, 60) -> 0 -> 'role_codes' -> 0, '"role_01"'::jsonb, 'tenant: cap keeps the first by role_code');
SELECT is(pg_temp.sa(40, 1, 60) -> 0 -> 'role_codes' -> 19, '"role_20"'::jsonb, 'tenant: cap drops role_21 and role_22');

-- ================================================================ no row (the service then fails closed with common.internal)
SELECT is(jsonb_array_length(pg_temp.sa(36, 1, 46)), 0, 'no row: DEACTIVATED membership');
SELECT is(jsonb_array_length(pg_temp.sa(555, 1, 41)), 0, 'no row: unknown user');
SELECT is(jsonb_array_length(pg_temp.sa(31, 1, 999)), 0, 'no row: unknown membership');
SELECT is(jsonb_array_length(pg_temp.sa(31, 1, 50)), 0, 'no row: membership belongs to another user (u31 with u38''s membership)');
SELECT is(jsonb_array_length(pg_temp.sa(31, 2, 41)), 0, 'no row: membership is in another tenant than p_tenant_id');
SELECT is(jsonb_array_length(pg_temp.sa(31, 999, 41)), 0, 'no row: unknown tenant');
SELECT is(jsonb_array_length(pg_temp.sa(33, 2, 43)), 0, 'no row: SUSPENDED tenant (tenant is not active)');
SELECT is(jsonb_array_length(pg_temp.sa(31, 1, 0)), 0, 'no row: tenant given but membership NULL');
SELECT is(jsonb_array_length(pg_temp.sa(32, 1, 41)), 0, 'no row: a platform staff user id with someone else''s tenant membership');

-- ================================================================ GUCs are '' after every call (08 A12.1; AC-0D-2.3 DB half)
CREATE FUNCTION pg_temp.gucs_after(p_u int, p_t int, p_m int) RETURNS text LANGUAGE plpgsql AS $$
DECLARE r jsonb; g text; bad text := '';
BEGIN
  PERFORM set_config('app.pre_user_id', '', true); PERFORM set_config('app.pre_tenant_id', '', true);
  r := pg_temp.sa(p_u, p_t, p_m);
  FOREACH g IN ARRAY ARRAY['app.pre_user_id', 'app.pre_tenant_id'] LOOP
    IF coalesce(current_setting(g, true), '<unset>') <> '' THEN bad := bad || g || '=' || coalesce(current_setting(g, true), '<unset>') || ' '; END IF;
  END LOOP;
  RETURN CASE WHEN jsonb_typeof(r) = 'string' THEN r #>> '{}' ELSE 'ok:' || bad END;
END $$;
SELECT is(pg_temp.gucs_after(31, 1, 41), 'ok:', 'GUCs reset after a tenant call');
SELECT is(pg_temp.gucs_after(32, 0, 0), 'ok:', 'GUCs reset after a platform call');
SELECT is(pg_temp.gucs_after(555, 1, 41), 'ok:', 'GUCs reset after a no-row call');
SELECT is(pg_temp.gucs_after(0, 0, 0), 'ok:', 'GUCs reset after an all-NULL call');

-- ================================================================ lims_api (no claims) really needs the definer: the tables are invisible to it directly
SELECT is(pg_temp.x('lims_api', 'SELECT count(*) FROM identity.platform_staff', 'v'), '0', 'lims_api without the DEFINER sees no platform_staff row (owner policy is TO lims_owner only)');
SELECT is(pg_temp.x('lims_api', 'SELECT count(*) FROM core.tenants', 'v'), '0', 'lims_api without the DEFINER sees no core.tenants row');

SELECT * FROM finish();
ROLLBACK;
