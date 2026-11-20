-- AUTH-PLATFORM-SESSION-1 (LD-216, AUTH-SENSITIVE LD-189; C2 05-SCHEMA s5.4/s6; 08 A12.1, A28.1, A25 D-212/D-215) live-DB assertions for the two READ DEFINERs:
--   app.identity_platform_auth_load_session(p_user_id uuid, p_session_id uuid)
--     RETURNS TABLE (aal, access_token_enc, refresh_token_enc, enc_key_id, mfa_failed_attempts, access_expires_at, idle_expires_at, absolute_expires_at,
--                    email, state, last_seen_at, idle_timeout_minutes, app_instance_id, app_platform): the tenant-less platform session of p_user_id, row-locked (FOR UPDATE);
--     email = identity.platform_staff.email_normalized; wrong user / other session / tenant session / unknown id = no row, never an error.
--   app.identity_platform_auth_read_mfa_factors(p_user_id uuid) RETURNS TABLE (id, gotrue_factor_id, status, verified_at, friendly_name):
--     tenant-less factors of p_user_id with status <> 'removed'.
-- Both: plpgsql SECURITY DEFINER, owner lims_owner, search_path '', read-only, EXECUTE lims_api only, app.pre_user_id (and app.pre_tenant_id) '' after the call.
-- (i) REPRODUCTION of the live bug: as lims_api with the identityAuthTx claims {sub: system actor, actor_type: 'system'} a plain SELECT of the platform session
--     returns 0 rows (FORCE RLS; the owner-only policies are TO lims_owner and need app.pre_user_id) while the function returns 1.
-- Same style as T0B-06_definers.test.sql / SESSION-ACTOR-1_session_actor.test.sql (stand-in fixture when C2's tables are absent; RLS is never disabled). Synthetic data only.
-- Row lock (iii) is asserted in ONE transaction through the tuple's xmax (set by FOR UPDATE) plus the function body / volatility; a second-session blocking
--   test needs two connections and is not possible in a single pg_prove file.
-- Run: pg_prove -d <migrated db> db/tests/identity/AUTH-PLATFORM-SESSION-1_platform_reads.test.sql   (superuser; pgTAP in schema `extensions`; run from the repo root)
-- The lane has no psql / docker: this file and the migration have NOT been run by their author (see .orchestra/notes/AUTH-PLATFORM-SESSION-1-tests.md).
BEGIN;
SET search_path = extensions, public, pg_catalog;
SELECT * FROM no_plan();

\ir ../fixtures/T0B-06_identity_standin.sql

-- ---------------------------------------------------------------- helpers (same shapes as T0B-06)
CREATE FUNCTION pg_temp.id(k int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('01900000-0000-7000-8000-' || lpad(to_hex(k), 12, '0'))::uuid $$;
CREATE FUNCTION pg_temp.h(k int) RETURNS bytea LANGUAGE sql IMMUTABLE AS $$ SELECT decode(lpad(to_hex(k), 64, '0'), 'hex') $$;
CREATE FUNCTION pg_temp.q(k int) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT quote_literal(pg_temp.id(k)::text) || '::uuid' $$;
CREATE FUNCTION pg_temp.sysclaims() RETURNS text LANGUAGE sql AS $$ SELECT jsonb_build_object('sub', pg_temp.id(99), 'actor_type', 'system')::text $$;   -- identityAuthTx (core/db/tx.ts)
-- run p_sql as p_role with p_claims (NULL = none); optional p_pre runs first in the same role/transaction (e.g. a GUC set by the "attacker").
-- modes: v scalar text, n row count of a SELECT, j jsonb array of the SELECT's rows. Errors come back as 'E<SQLSTATE>:<message>'.
CREATE FUNCTION pg_temp.x(p_role text, p_claims text, p_pre text, p_sql text, p_mode text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE r text; n bigint;
BEGIN
  PERFORM set_config('request.jwt.claims', coalesce(p_claims, ''), true);
  EXECUTE format('SET LOCAL ROLE %I', p_role);
  BEGIN
    IF p_pre IS NOT NULL THEN EXECUTE p_pre; END IF;
    IF p_mode = 'v' THEN EXECUTE p_sql INTO r; r := coalesce(r, '<null>');
    ELSIF p_mode = 'n' THEN EXECUTE 'SELECT count(*) FROM (' || p_sql || ') t' INTO n; r := n::text;
    ELSE EXECUTE 'SELECT coalesce(jsonb_agg(to_jsonb(t)), ''[]''::jsonb)::text FROM (' || p_sql || ') t' INTO r;
    END IF;
  EXCEPTION WHEN OTHERS THEN r := 'E' || SQLSTATE || ':' || SQLERRM;
  END;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN r;
END $f$;
CREATE FUNCTION pg_temp.apij(p_claims text, p_pre text, p_sql text) RETURNS jsonb LANGUAGE sql AS $$
  SELECT CASE WHEN r LIKE 'E%' THEN to_jsonb(r) ELSE r::jsonb END FROM (SELECT pg_temp.x('lims_api', p_claims, p_pre, p_sql, 'j') r) s $$;
CREATE FUNCTION pg_temp.guc(p_name text) RETURNS text LANGUAGE sql AS $$ SELECT coalesce(current_setting(p_name, true), '<unset>') $$;
-- SELECT * FROM app.identity_platform_auth_load_session(user, session) as lims_api under the system claims; k = fixture number, 0 = NULL
CREATE FUNCTION pg_temp.ls(u int, s int, p_pre text DEFAULT NULL) RETURNS jsonb LANGUAGE sql AS $$
  SELECT pg_temp.apij(pg_temp.sysclaims(), p_pre, 'SELECT * FROM app.identity_platform_auth_load_session('
    || CASE u WHEN 0 THEN 'NULL::uuid' ELSE pg_temp.q(u) END || ',' || CASE s WHEN 0 THEN 'NULL::uuid' ELSE pg_temp.q(s) END || ')') $$;
CREATE FUNCTION pg_temp.mf(u int, p_pre text DEFAULT NULL) RETURNS jsonb LANGUAGE sql AS $$
  SELECT pg_temp.apij(pg_temp.sysclaims(), p_pre, 'SELECT * FROM app.identity_platform_auth_read_mfa_factors(' || CASE u WHEN 0 THEN 'NULL::uuid' ELSE pg_temp.q(u) END || ')') $$;
CREATE FUNCTION pg_temp.ids(j jsonb) RETURNS text[] LANGUAGE sql AS $$ SELECT coalesce(array_agg(e ->> 'id' ORDER BY e ->> 'id'), '{}') FROM jsonb_array_elements(j) e $$;

-- ---------------------------------------------------------------- fixtures (superuser; triggers / FK checks off while seeding)
-- the stand-in tables carry only some columns; add what the functions return (a no-op on the real C2 tables)
ALTER TABLE identity.sessions    ADD COLUMN IF NOT EXISTS idle_timeout_minutes integer NOT NULL DEFAULT 20;
ALTER TABLE identity.sessions    ADD COLUMN IF NOT EXISTS app_instance_id uuid;
ALTER TABLE identity.sessions    ADD COLUMN IF NOT EXISTS app_platform text;
ALTER TABLE identity.mfa_factors ADD COLUMN IF NOT EXISTS gotrue_factor_id uuid;
ALTER TABLE identity.mfa_factors ADD COLUMN IF NOT EXISTS factor_type text NOT NULL DEFAULT 'totp';
SET LOCAL session_replication_role = replica;
INSERT INTO core.tenants (id, tenant_code, legal_name, display_name, status, created_by, updated_by) VALUES
  (pg_temp.id(1), 'lab_a', 'Lab A Pvt Ltd', 'Lab A', 'active', pg_temp.id(99), pg_temp.id(99));
-- staff 61 = user 32 (the founder-like platform admin); staff 62 = user 33 (a second admin); user 34 has NO platform_staff row
INSERT INTO identity.platform_staff (id, user_id, email_normalized, display_name, role_code, is_active, created_by, updated_by) VALUES
  (pg_temp.id(61), pg_temp.id(32), 'staff32@example.test', 'Staff 32', 'platform_superadmin', true, pg_temp.id(99), pg_temp.id(99)),
  (pg_temp.id(62), pg_temp.id(33), 'staff33@example.test', 'Staff 33', 'platform_superadmin', true, pg_temp.id(99), pg_temp.id(99));
-- sessions: 101 platform user 32 (aal1, the live case) · 102 platform user 33 (another user) · 103 TENANT session of user 32 (kind tenant_staff, tenant 1)
--           104 platform user 34 (no staff row -> e-mail NULL) · 105 platform user 32, revoked (returned as stored; the service decides) · 106 untouched control (user 33)
INSERT INTO identity.sessions (id, tenant_id, user_id, kind, state, aal, membership_id, platform_staff_id, gotrue_session_id, token_sha256,
                               access_token_enc, refresh_token_enc, enc_key_id, access_expires_at, last_seen_at, idle_expires_at, absolute_expires_at, expires_at,
                               mfa_failed_attempts, idle_timeout_minutes, revoked_at, created_by, updated_by) VALUES
  (pg_temp.id(101), NULL,          pg_temp.id(32), 'platform',     'active',  'aal1', NULL,           pg_temp.id(61), pg_temp.id(201), pg_temp.h(1), '\xa101', '\xb101', 'k1', now() + interval '5 minutes', now() - interval '1 minute', now() + interval '20 minutes', now() + interval '10 hours', now() + interval '1 day', 2, 20, NULL,  pg_temp.id(99), pg_temp.id(99)),
  (pg_temp.id(102), NULL,          pg_temp.id(33), 'platform',     'active',  'aal2', NULL,           pg_temp.id(62), pg_temp.id(202), pg_temp.h(2), '\xa102', '\xb102', 'k1', now() + interval '5 minutes', now(),                      now() + interval '20 minutes', now() + interval '10 hours', now() + interval '1 day', 0, 15, NULL,  pg_temp.id(99), pg_temp.id(99)),
  (pg_temp.id(103), pg_temp.id(1), pg_temp.id(32), 'tenant_staff', 'active',  'aal1', pg_temp.id(41), NULL,            pg_temp.id(203), pg_temp.h(3), '\xa103', '\xb103', 'k1', now() + interval '5 minutes', now(),                      now() + interval '20 minutes', now() + interval '10 hours', now() + interval '1 day', 0, 20, NULL,  pg_temp.id(99), pg_temp.id(99)),
  -- HARNESS fix T0B-GREEN-3 (psql abort sessions__kind_shape__ck, migration 20261105001300): a platform session must carry platform_staff_id; 104 now points at a staff id (63) that has NO platform_staff row, which still proves "no staff row for the user -> email NULL" (the LEFT JOIN is on staff id AND user id)
  (pg_temp.id(104), NULL,          pg_temp.id(34), 'platform',     'active',  'aal1', NULL,           pg_temp.id(63),  pg_temp.id(204), pg_temp.h(4), '\xa104', '\xb104', 'k1', now() + interval '5 minutes', now(),                      now() + interval '20 minutes', now() + interval '10 hours', now() + interval '1 day', 0, 20, NULL,  pg_temp.id(99), pg_temp.id(99)),
  (pg_temp.id(106), NULL,          pg_temp.id(33), 'platform',     'active',  'aal1', NULL,           pg_temp.id(62), pg_temp.id(206), pg_temp.h(6), '\xa106', '\xb106', 'k1', now() + interval '5 minutes', now(),                      now() + interval '20 minutes', now() + interval '10 hours', now() + interval '1 day', 0, 20, NULL,  pg_temp.id(99), pg_temp.id(99));
-- 105 (revoked): HARNESS fix T0B-GREEN-3, sessions__revoke__ck (state = 'revoked') = (revoked_at AND revoke_reason NOT NULL) needs a revoke_reason; own INSERT
INSERT INTO identity.sessions (id, tenant_id, user_id, kind, state, aal, membership_id, platform_staff_id, gotrue_session_id, token_sha256,
                               access_token_enc, refresh_token_enc, enc_key_id, access_expires_at, last_seen_at, idle_expires_at, absolute_expires_at, expires_at,
                               mfa_failed_attempts, idle_timeout_minutes, revoked_at, revoke_reason, created_by, updated_by) VALUES
  (pg_temp.id(105), NULL,          pg_temp.id(32), 'platform',     'revoked', 'aal1', NULL,           pg_temp.id(61), pg_temp.id(205), pg_temp.h(5), '\xa105', '\xb105', 'k1', now() + interval '5 minutes', now(),                      now() + interval '20 minutes', now() + interval '10 hours', now() + interval '1 day', 0, 20, now(), 'logout', pg_temp.id(99), pg_temp.id(99));
-- factors: 301 user 32 unverified · 302 user 32 verified · 303 user 32 REMOVED · 304 user 32 TENANT factor (tenant 1) · 305 user 33 verified · 306 user 34 unverified
INSERT INTO identity.mfa_factors (id, tenant_id, user_id, gotrue_factor_id, factor_type, status, verified_at, friendly_name, removed_at, created_by, updated_by) VALUES
  (pg_temp.id(301), NULL,          pg_temp.id(32), pg_temp.id(401), 'totp', 'unverified', NULL,  NULL,       NULL,  pg_temp.id(99), pg_temp.id(99)),
  (pg_temp.id(302), NULL,          pg_temp.id(32), pg_temp.id(402), 'totp', 'verified',   now(), 'Phone',    NULL,  pg_temp.id(99), pg_temp.id(99)),
  (pg_temp.id(303), NULL,          pg_temp.id(32), pg_temp.id(403), 'totp', 'removed',    now(), 'Old',      now(), pg_temp.id(99), pg_temp.id(99)),
  (pg_temp.id(304), pg_temp.id(1), pg_temp.id(32), pg_temp.id(404), 'totp', 'verified',   now(), 'Tenant',   NULL,  pg_temp.id(99), pg_temp.id(99)),
  (pg_temp.id(305), NULL,          pg_temp.id(33), pg_temp.id(405), 'totp', 'verified',   now(), 'Other',    NULL,  pg_temp.id(99), pg_temp.id(99)),
  (pg_temp.id(306), NULL,          pg_temp.id(34), pg_temp.id(406), 'totp', 'unverified', NULL,  NULL,       NULL,  pg_temp.id(99), pg_temp.id(99));
SET LOCAL session_replication_role = origin;

-- ================================================================ catalog: attributes + grants (08 A10.5; C0 05-SCHEMA s4.3)
CREATE TEMP TABLE sigs (sig text PRIMARY KEY);
INSERT INTO sigs VALUES ('identity_platform_auth_load_session(uuid,uuid)'), ('identity_platform_auth_read_mfa_factors(uuid)');
SELECT ok(to_regprocedure('app.' || sig) IS NOT NULL, 'exists: app.' || sig) FROM sigs ORDER BY sig;
SELECT ok(p.prosecdef, 'SECURITY DEFINER: app.' || s.sig) FROM sigs s JOIN pg_proc p ON p.oid = to_regprocedure('app.' || s.sig) ORDER BY s.sig;
SELECT ok(pg_get_userbyid(p.proowner) = 'lims_owner', 'owner lims_owner: app.' || s.sig) FROM sigs s JOIN pg_proc p ON p.oid = to_regprocedure('app.' || s.sig) ORDER BY s.sig;
SELECT ok(l.lanname = 'plpgsql', 'language plpgsql: app.' || s.sig) FROM sigs s JOIN pg_proc p ON p.oid = to_regprocedure('app.' || s.sig) JOIN pg_language l ON l.oid = p.prolang ORDER BY s.sig;
SELECT ok(p.proconfig @> ARRAY['search_path=""'] OR p.proconfig @> ARRAY['search_path='], 'search_path is empty: app.' || s.sig)
  FROM sigs s JOIN pg_proc p ON p.oid = to_regprocedure('app.' || s.sig) ORDER BY s.sig;
SELECT ok(p.proretset, 'returns a set (RETURNS TABLE): app.' || s.sig) FROM sigs s JOIN pg_proc p ON p.oid = to_regprocedure('app.' || s.sig) ORDER BY s.sig;
SELECT ok(p.provolatile = 'v', 'VOLATILE (a STABLE function cannot take FOR UPDATE): app.' || s.sig) FROM sigs s JOIN pg_proc p ON p.oid = to_regprocedure('app.' || s.sig) ORDER BY s.sig;
SELECT ok(p.proacl IS NOT NULL AND NOT EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0), 'no EXECUTE for PUBLIC: app.' || s.sig)
  FROM sigs s JOIN pg_proc p ON p.oid = to_regprocedure('app.' || s.sig) ORDER BY s.sig;
SELECT ok(NOT EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname IN ('anon', 'authenticated') AND has_function_privilege(r.oid, p.oid, 'EXECUTE')), 'no EXECUTE for anon/authenticated: app.' || s.sig)
  FROM sigs s JOIN pg_proc p ON p.oid = to_regprocedure('app.' || s.sig) ORDER BY s.sig;
-- (vi) EXECUTE only for lims_api
SELECT ok(has_function_privilege('lims_api', p.oid, 'EXECUTE') AND NOT has_function_privilege('lims_worker', p.oid, 'EXECUTE') AND NOT has_function_privilege('lims_app', p.oid, 'EXECUTE')
          AND NOT has_function_privilege('lims_queue', p.oid, 'EXECUTE'), 'EXECUTE only for lims_api: app.' || s.sig)
  FROM sigs s JOIN pg_proc p ON p.oid = to_regprocedure('app.' || s.sig) ORDER BY s.sig;
SELECT ok(pg_temp.x('lims_worker', NULL, NULL, 'SELECT * FROM app.identity_platform_auth_load_session(' || pg_temp.q(32) || ',' || pg_temp.q(101) || ')', 'n') LIKE 'E42501:%', 'lims_worker cannot call load_session (42501, not an empty result)');
SELECT ok(pg_temp.x('lims_app',    NULL, NULL, 'SELECT * FROM app.identity_platform_auth_load_session(' || pg_temp.q(32) || ',' || pg_temp.q(101) || ')', 'n') LIKE 'E42501:%', 'lims_app cannot call load_session');
SELECT ok(pg_temp.x('lims_worker', NULL, NULL, 'SELECT * FROM app.identity_platform_auth_read_mfa_factors(' || pg_temp.q(32) || ')', 'n') LIKE 'E42501:%', 'lims_worker cannot call read_mfa_factors');
SELECT ok(pg_temp.x('lims_app',    NULL, NULL, 'SELECT * FROM app.identity_platform_auth_read_mfa_factors(' || pg_temp.q(32) || ')', 'n') LIKE 'E42501:%', 'lims_app cannot call read_mfa_factors');
-- shape: the exact output columns, in the order LOAD_SQL / FACTORS_SQL select them
SELECT is((SELECT array_agg(u.n ORDER BY u.o) FROM pg_proc p, unnest(p.proargnames, p.proargmodes) WITH ORDINALITY AS u(n, m, o)
            WHERE p.oid = to_regprocedure('app.identity_platform_auth_load_session(uuid,uuid)') AND u.m = 't'),
          ARRAY['aal','access_token_enc','refresh_token_enc','enc_key_id','mfa_failed_attempts','access_expires_at','idle_expires_at','absolute_expires_at','email','state',
                'last_seen_at','idle_timeout_minutes','app_instance_id','app_platform'], 'load_session: the 14 LOAD_SQL columns, in order');
SELECT is((SELECT array_agg(u.n ORDER BY u.o) FROM pg_proc p, unnest(p.proargnames, p.proargmodes) WITH ORDINALITY AS u(n, m, o)
            WHERE p.oid = to_regprocedure('app.identity_platform_auth_read_mfa_factors(uuid)') AND u.m = 't'),
          ARRAY['id','gotrue_factor_id','status','verified_at','friendly_name'], 'read_mfa_factors: id, gotrue_factor_id, status, verified_at, friendly_name, in order');
-- body: read-only; uses the owner-policy GUCs (08 A12.1); the session read takes the row lock
SELECT ok(pg_get_functiondef(p.oid) !~* '(insert\s+into|update\s+[a-z_."]+\s+set|delete\s+from|truncate)', 'body has no INSERT / UPDATE / DELETE / TRUNCATE: app.' || s.sig)
  FROM sigs s JOIN pg_proc p ON p.oid = to_regprocedure('app.' || s.sig) ORDER BY s.sig;
SELECT ok(pg_get_functiondef(p.oid) ~ 'app\.pre_user_id', 'body uses app.pre_user_id: app.' || s.sig) FROM sigs s JOIN pg_proc p ON p.oid = to_regprocedure('app.' || s.sig) ORDER BY s.sig;
SELECT ok(pg_get_functiondef(to_regprocedure('app.identity_platform_auth_read_mfa_factors(uuid)')) ~ 'app\.pre_tenant_id', 'read_mfa_factors body sets app.pre_tenant_id (tenant-less factors only, as write_mfa_factor)');
SELECT ok(pg_get_functiondef(to_regprocedure('app.identity_platform_auth_load_session(uuid,uuid)')) ~* 'for update', 'load_session body takes the row lock (FOR UPDATE), as LOAD_SQL does');
SELECT ok(pg_get_functiondef(to_regprocedure('app.identity_platform_auth_load_session(uuid,uuid)')) ~* 'kind\s*=\s*''platform''' AND pg_get_functiondef(to_regprocedure('app.identity_platform_auth_load_session(uuid,uuid)')) ~* 'tenant_id\s+is\s+null',
          'load_session body filters kind = platform AND tenant_id IS NULL');

-- ================================================================ (i) REPRODUCTION of the live defect (08 A28.1 blind spot; startMfaEnrolment 401 auth.session_expired)
-- The identityAuthTx claims are {sub: identity system actor, actor_type: 'system'}: no tenant, no scope, no aal2, no lims_session_id.
SELECT is(pg_temp.x('lims_api', pg_temp.sysclaims(), NULL, 'SELECT count(*) FROM identity.sessions WHERE id = ' || pg_temp.q(101), 'v'), '0',
          'REPRODUCTION: a PLAIN SELECT of the platform session as lims_api under the system claims returns 0 rows (this is what LOAD_SQL does today)');
SELECT is(jsonb_array_length(pg_temp.ls(32, 101)), 1, 'REPRODUCTION: the new function returns exactly 1 row for the same session under the same claims');
SELECT is(pg_temp.x('lims_api', pg_temp.sysclaims(), NULL, 'SELECT count(*) FROM identity.mfa_factors WHERE user_id = ' || pg_temp.q(32) || ' AND tenant_id IS NULL', 'v'), '0',
          'REPRODUCTION: a PLAIN SELECT of the platform factors under the system claims returns 0 rows (FACTORS_SQL today)');
SELECT is(jsonb_array_length(pg_temp.mf(32)), 2, 'REPRODUCTION: the new function returns the 2 live factors (unverified + verified) under the same claims');
SELECT is(pg_temp.x('lims_api', pg_temp.sysclaims(), NULL, 'SELECT count(*) FROM identity.platform_staff', 'v'), '0',
          'platform_staff stays invisible to a plain lims_api SELECT (the e-mail needs the DEFINER)');

-- ================================================================ load_session behaviour
SELECT is(pg_temp.ls(32, 101) -> 0 ->> 'email', 'staff32@example.test', 'load_session: email = identity.platform_staff.email_normalized of the user');
SELECT is(pg_temp.ls(32, 101) -> 0 ->> 'aal', 'aal1', 'load_session: aal');
SELECT is(pg_temp.ls(32, 101) -> 0 ->> 'state', 'active', 'load_session: state');
SELECT is(pg_temp.ls(32, 101) -> 0 ->> 'mfa_failed_attempts', '2', 'load_session: mfa_failed_attempts');
SELECT is(pg_temp.ls(32, 101) -> 0 ->> 'idle_timeout_minutes', '20', 'load_session: idle_timeout_minutes');
SELECT is(pg_temp.ls(32, 101) -> 0 ->> 'enc_key_id', 'k1', 'load_session: enc_key_id');
SELECT is(pg_temp.ls(32, 101) -> 0 ->> 'access_token_enc', '\xa101', 'load_session: access_token_enc bytes (sealed, returned as stored)');
SELECT is(pg_temp.ls(32, 101) -> 0 ->> 'refresh_token_enc', '\xb101', 'load_session: refresh_token_enc bytes (sealed, returned as stored)');
SELECT ok(pg_temp.ls(32, 101) -> 0 ->> 'access_expires_at' IS NOT NULL AND pg_temp.ls(32, 101) -> 0 ->> 'idle_expires_at' IS NOT NULL
          AND pg_temp.ls(32, 101) -> 0 ->> 'absolute_expires_at' IS NOT NULL AND pg_temp.ls(32, 101) -> 0 ->> 'last_seen_at' IS NOT NULL, 'load_session: the four timestamps are returned');
SELECT is(pg_temp.ls(32, 101) -> 0 -> 'app_instance_id', 'null'::jsonb, 'load_session: app_instance_id NULL for a platform session');
SELECT is(pg_temp.ls(32, 101) -> 0 -> 'app_platform', 'null'::jsonb, 'load_session: app_platform NULL for a platform session');
SELECT is(pg_temp.ls(33, 102) -> 0 ->> 'aal', 'aal2', 'load_session: another platform user reads their own session (aal2, idle 15)');
SELECT is(pg_temp.ls(33, 102) -> 0 ->> 'idle_timeout_minutes', '15', 'load_session: idle_timeout_minutes of that session');
SELECT is(pg_temp.ls(32, 105) -> 0 ->> 'state', 'revoked', 'load_session: a revoked session is RETURNED as stored (the service decides), not hidden');
SELECT is(pg_temp.ls(34, 104) -> 0 -> 'email', 'null'::jsonb, 'load_session: no platform_staff row for the user -> the session row with email NULL (LEFT JOIN), no error');
-- (ii) no row, never an error
SELECT is(pg_temp.ls(33, 101), '[]'::jsonb, '(ii) wrong user (user 33 asks for user 32''s session) -> no row, no error');
SELECT is(pg_temp.ls(32, 102), '[]'::jsonb, '(ii) other session id (user 32 asks for user 33''s session 102) -> no row, no error');
SELECT is(pg_temp.ls(32, 103), '[]'::jsonb, '(ii) a TENANT-kind session of the same user (kind tenant_staff, tenant 1) -> no row, no error');
SELECT is(pg_temp.ls(32, 555), '[]'::jsonb, '(ii) unknown session id -> no row, no error');
SELECT is(pg_temp.ls(555, 101), '[]'::jsonb, '(ii) unknown user id -> no row, no error');
SELECT is(pg_temp.ls(0, 101), '[]'::jsonb, '(ii) NULL user -> no row, no error');
SELECT is(pg_temp.ls(32, 0), '[]'::jsonb, '(ii) NULL session -> no row, no error');
SELECT is(pg_temp.ls(0, 0), '[]'::jsonb, '(ii) NULL, NULL -> no row, no error');
-- an attacker-set GUC cannot widen the read: the function overrides app.pre_user_id with its own argument
SELECT is(pg_temp.ls(33, 101, $$SELECT set_config('app.pre_user_id', '$$ || pg_temp.id(32) || $$', true)$$), '[]'::jsonb, 'a pre-set app.pre_user_id of the owner does not widen the read: wrong user still no row');
SELECT is(pg_temp.ls(32, 101, $$SELECT set_config('app.pre_user_id', '$$ || pg_temp.id(33) || $$', true)$$) -> 0 ->> 'email', 'staff32@example.test', 'a pre-set app.pre_user_id of another user is overridden: the caller''s own row is returned');
-- (iii) the row is locked until the transaction ends: FOR UPDATE leaves the locker's xid in xmax (control rows stay 0)
SELECT is((SELECT xmax::text FROM identity.sessions WHERE id = pg_temp.id(106)), '0', '(iii) control: an untouched session row has xmax 0');
SELECT is(jsonb_array_length(pg_temp.ls(32, 101)), 1, '(iii) load_session again for the locking check');
SELECT isnt((SELECT xmax::text FROM identity.sessions WHERE id = pg_temp.id(101)), '0', '(iii) the platform session row carries a row lock (xmax set by FOR UPDATE) after load_session, held until the transaction ends');
SELECT is((SELECT xmax::text FROM identity.sessions WHERE id = pg_temp.id(106)), '0', '(iii) another session row is NOT locked by the call');
-- (iv) GUCs are '' after each call (same transaction, checked right after)
SELECT is(pg_temp.ls(32, 101) -> 0 ->> 'aal', 'aal1', '(iv) call to load_session (found)');
SELECT is(pg_temp.guc('app.pre_user_id'), '', '(iv) app.pre_user_id is empty after load_session (found)');
SELECT is(pg_temp.ls(32, 555), '[]'::jsonb, '(iv) call to load_session (not found)');
SELECT is(pg_temp.guc('app.pre_user_id'), '', '(iv) app.pre_user_id is empty after load_session (not found)');
SELECT is(pg_temp.guc('app.pre_tenant_id'), '', '(iv) app.pre_tenant_id is empty after load_session (never set to a tenant)');

-- ================================================================ read_mfa_factors behaviour
SELECT is(pg_temp.ids(pg_temp.mf(32)), ARRAY[pg_temp.id(301)::text, pg_temp.id(302)::text], '(v) user 32: the unverified (301) and the verified (302) factor are listed');
SELECT ok(NOT (pg_temp.id(303)::text = ANY (pg_temp.ids(pg_temp.mf(32)))), '(v) a REMOVED factor (303) is excluded (status <> removed)');
SELECT ok(NOT (pg_temp.id(304)::text = ANY (pg_temp.ids(pg_temp.mf(32)))), '(v) a TENANT factor (304, tenant 1) of the same user is never returned');
SELECT ok(NOT (pg_temp.id(305)::text = ANY (pg_temp.ids(pg_temp.mf(32)))) AND NOT (pg_temp.id(306)::text = ANY (pg_temp.ids(pg_temp.mf(32)))), '(v) another user''s factors (305, 306) are excluded');
SELECT is(pg_temp.ids(pg_temp.mf(33)), ARRAY[pg_temp.id(305)::text], '(v) user 33 sees only their own factor');
SELECT is(pg_temp.mf(555), '[]'::jsonb, '(v) unknown user -> no rows, no error');
SELECT is(pg_temp.mf(0), '[]'::jsonb, '(v) NULL user -> no rows, no error');
SELECT is((SELECT e ->> 'gotrue_factor_id' FROM jsonb_array_elements(pg_temp.mf(32)) e WHERE e ->> 'id' = pg_temp.id(301)::text), pg_temp.id(401)::text, 'read_mfa_factors: gotrue_factor_id of the unverified factor');
SELECT is((SELECT e ->> 'status' FROM jsonb_array_elements(pg_temp.mf(32)) e WHERE e ->> 'id' = pg_temp.id(301)::text), 'unverified', 'read_mfa_factors: status unverified');
SELECT is((SELECT e ->> 'status' FROM jsonb_array_elements(pg_temp.mf(32)) e WHERE e ->> 'id' = pg_temp.id(302)::text), 'verified', 'read_mfa_factors: status verified');
SELECT ok((SELECT e ->> 'verified_at' FROM jsonb_array_elements(pg_temp.mf(32)) e WHERE e ->> 'id' = pg_temp.id(302)::text) IS NOT NULL, 'read_mfa_factors: verified_at of the verified factor');
SELECT is((SELECT e ->> 'friendly_name' FROM jsonb_array_elements(pg_temp.mf(32)) e WHERE e ->> 'id' = pg_temp.id(302)::text), 'Phone', 'read_mfa_factors: friendly_name');
-- a pre-set app.pre_tenant_id (attacker) does not make tenant factors appear: the function forces ''
SELECT ok(NOT (pg_temp.id(304)::text = ANY (pg_temp.ids(pg_temp.mf(32, $$SELECT set_config('app.pre_tenant_id', '$$ || pg_temp.id(1) || $$', true)$$)))),
          '(v) a pre-set app.pre_tenant_id does not expose the tenant factor (the function sets app.pre_tenant_id to empty)');
SELECT is(pg_temp.ids(pg_temp.mf(33, $$SELECT set_config('app.pre_user_id', '$$ || pg_temp.id(32) || $$', true)$$)), ARRAY[pg_temp.id(305)::text], '(v) a pre-set app.pre_user_id of another user is overridden by the argument');
-- (iv) GUCs after
SELECT is(jsonb_array_length(pg_temp.mf(32)), 2, '(iv) call to read_mfa_factors');
SELECT is(pg_temp.guc('app.pre_user_id'), '', '(iv) app.pre_user_id is empty after read_mfa_factors');
SELECT is(pg_temp.guc('app.pre_tenant_id'), '', '(iv) app.pre_tenant_id is empty after read_mfa_factors');
SELECT is(pg_temp.mf(555), '[]'::jsonb, '(iv) call to read_mfa_factors (no rows)');
SELECT is(pg_temp.guc('app.pre_user_id') || pg_temp.guc('app.pre_tenant_id'), '', '(iv) both GUCs empty after a call that found nothing');

-- ================================================================ read-only: the calls changed no data
SELECT is((SELECT count(*) FROM identity.sessions WHERE id IN (SELECT pg_temp.id(k) FROM generate_series(101, 106) k)), 6::bigint, 'no session row was added or removed');
SELECT is((SELECT count(*) FROM identity.mfa_factors WHERE id IN (SELECT pg_temp.id(k) FROM generate_series(301, 306) k)), 6::bigint, 'no factor row was added or removed');
SELECT is((SELECT version FROM identity.sessions WHERE id = pg_temp.id(101)), 1, 'the session row was not updated (version still 1)');
SELECT is((SELECT mfa_failed_attempts FROM identity.sessions WHERE id = pg_temp.id(101)), 2, 'the session row was not updated (mfa_failed_attempts still 2)');

-- ================================================================ (vii) no RLS or grant weakening
SELECT is((SELECT count(*) FROM pg_policies WHERE qual = 'true' OR with_check = 'true'), 1::bigint, '(vii) USING (true) / WITH CHECK (true) still appears exactly once in the database (platform_staff__select__owner_only)');
SELECT ok(NOT EXISTS (SELECT 1 FROM pg_policies WHERE (qual ~ 'app\.(pre_|maintenance)' OR with_check ~ 'app\.(pre_|maintenance)') AND roles <> '{lims_owner}'
                      AND NOT (schemaname = 'reporting' AND roles = '{lims_reporting_lookup}')),   -- STALE T0B-GREEN-3: C6 lookup policies are TO lims_reporting_lookup (08-CR-REGISTER C6-002, A10.5, D-30; as db/tests/policy, T0B-GREEN-2)
          '(vii) every policy mentioning app.pre_* / app.maintenance is still TO lims_owner only (reporting lookup policies: TO lims_reporting_lookup only)');
SELECT ok((SELECT bool_and(c.relforcerowsecurity AND c.relrowsecurity) FROM pg_class c WHERE c.oid IN
           ('identity.sessions'::regclass, 'identity.mfa_factors'::regclass, 'identity.platform_staff'::regclass)), '(vii) FORCE + ENABLE RLS on identity.sessions, mfa_factors, platform_staff');
SELECT ok(EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'identity' AND tablename = 'sessions' AND policyname = 'sessions__select__owner_only' AND roles = '{lims_owner}'
                  AND qual ~ 'app\.pre_user_id' AND qual ~ 'platform'), '(vii) sessions__select__owner_only is still TO lims_owner with the platform + app.pre_user_id predicate');
SELECT ok(EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'identity' AND tablename = 'mfa_factors' AND policyname = 'mfa_factors__select__owner_only' AND roles = '{lims_owner}'
                  AND qual ~ 'app\.pre_user_id' AND qual ~ 'app\.pre_tenant_id'), '(vii) mfa_factors__select__owner_only is still TO lims_owner with app.pre_user_id + app.pre_tenant_id');
SELECT ok(EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'identity' AND tablename = 'platform_staff' AND policyname = 'platform_staff__select__owner_only' AND roles = '{lims_owner}' AND qual = 'true'),
          '(vii) platform_staff__select__owner_only is still TO lims_owner USING (true) (the single allowlisted one)');
SELECT ok(NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'identity' AND tablename IN ('sessions', 'mfa_factors', 'platform_staff') AND roles && ARRAY['public', 'anon', 'authenticated']::name[]),
          '(vii) no policy of the three tables is granted to PUBLIC, anon or authenticated');
SELECT ok(NOT EXISTS (SELECT 1 FROM pg_class c, LATERAL aclexplode(c.relacl) a WHERE c.oid IN ('identity.sessions'::regclass, 'identity.mfa_factors'::regclass, 'identity.platform_staff'::regclass)
                       AND (a.grantee = 0 OR a.grantee IN (SELECT oid FROM pg_roles WHERE rolname IN ('anon', 'authenticated')))),
          '(vii) no table grant of the three tables to PUBLIC, anon or authenticated (the functions read as the owner; no grant was added for them)');
-- STALE T0B-GREEN-3 (assertion 104): lims_app has held SELECT, INSERT, UPDATE on identity.platform_staff since migration 20261105001300 (class M, grants block) and the 20261115191000 __platform policies (PLATFORM-DDL-1, LD-223)
-- use it, so "no INSERT / UPDATE grant" was never true. The property this task needs is that its read definers added no write path: no DELETE, and every INSERT / UPDATE policy that applies to lims_app is guarded by the platform actor.
SELECT ok(NOT has_table_privilege('lims_app', 'identity.platform_staff', 'DELETE')
          AND (SELECT count(*) > 0 AND bool_and(coalesce(qual, '') || coalesce(with_check, '') ~ 'is_platform_actor') FROM pg_policies
                WHERE schemaname = 'identity' AND tablename = 'platform_staff' AND cmd IN ('INSERT', 'UPDATE', 'ALL') AND (roles && ARRAY['lims_app', 'public']::name[])),
          '(vii) lims_app has no DELETE on identity.platform_staff and every INSERT / UPDATE policy that applies to lims_app requires app.is_platform_actor()');

SELECT * FROM finish();
ROLLBACK;
