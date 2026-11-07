-- T0B-06 live-DB assertions: identity DEFINER functions (C2 05-SCHEMA §10.3) + grants + GUC-bound owner policies, all under FORCE RLS.
-- Covers C2 05-SCHEMA §11 tests 10(part), 18-22, 24, 25, 28-term(not here: T0B-05), 31, 34, 35; C0 05-SCHEMA §4.3 inventory, §10 schema tests 13, 17, 19, 21;
-- 08 A6.6, A8.1, A10.5, A12.1, A12.2, A12.5, A12.7, A15.1-A15.3, A17 P-18(c), A20.1, A28.1, A28.4, A28.5(not here: needs audit triggers on identity tables, C2).
-- Synthetic data only. One rolled-back transaction. RLS is never disabled: identity stand-ins (when C2's tables are absent) are FORCE-RLS with the real
-- owner policies (db/tests/fixtures/T0B-06_identity_standin.sql).
-- Run: pg_prove -d <migrated db> db/tests/identity/T0B-06_definers.test.sql   (superuser; pgTAP in schema `extensions`; run from the repo root)
-- Not covered here: identity_load_breached_batch / identity_finish_breached_import behaviour (class G table `identity.g_breached_passwords` is C2 DDL; only
-- existence, attributes and grants are asserted); the AC-0D-2.x request-pipeline ACs are TypeScript (T0D-02/03) — only their DB half (AC-0D-2.3: GUCs are
-- transaction-local, '' after every DEFINER, NULL claims outside a claims transaction) is asserted.
BEGIN;
SET search_path = extensions, public, pg_catalog;
SELECT * FROM no_plan();

\ir ../fixtures/T0B-06_identity_standin.sql

-- ---------------------------------------------------------------- helpers
CREATE FUNCTION pg_temp.id(k int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('01900000-0000-7000-8000-' || lpad(to_hex(k), 12, '0'))::uuid $$;
CREATE FUNCTION pg_temp.h(k int) RETURNS bytea LANGUAGE sql IMMUTABLE AS $$ SELECT decode(lpad(to_hex(k), 64, '0'), 'hex') $$;
CREATE FUNCTION pg_temp.q(k int) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT quote_literal(pg_temp.id(k)::text) || '::uuid' $$;
CREATE FUNCTION pg_temp.qh(k int) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT quote_literal('\x' || encode(pg_temp.h(k), 'hex')) || '::bytea' $$;
-- run p_sql as p_role with p_claims (NULL = none); optional p_pre runs first in the same role/transaction (e.g. a GUC set by the "attacker").
-- modes: v scalar text · n row count of a SELECT · w DML row count · j jsonb array of the SELECT's rows. Errors come back as 'E<SQLSTATE>:<message>'.
CREATE FUNCTION pg_temp.x(p_role text, p_claims text, p_pre text, p_sql text, p_mode text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE r text; n bigint;
BEGIN
  PERFORM set_config('request.jwt.claims', coalesce(p_claims, ''), true);
  EXECUTE format('SET LOCAL ROLE %I', p_role);
  BEGIN
    IF p_pre IS NOT NULL THEN EXECUTE p_pre; END IF;
    IF p_mode = 'v' THEN EXECUTE p_sql INTO r; r := coalesce(r, '<null>');
    ELSIF p_mode = 'n' THEN EXECUTE 'SELECT count(*) FROM (' || p_sql || ') t' INTO n; r := n::text;
    ELSIF p_mode = 'j' THEN EXECUTE 'SELECT coalesce(jsonb_agg(to_jsonb(t)), ''[]''::jsonb)::text FROM (' || p_sql || ') t' INTO r;
    ELSE EXECUTE p_sql; GET DIAGNOSTICS n = ROW_COUNT; r := n::text; END IF;
  EXCEPTION WHEN OTHERS THEN r := 'E' || SQLSTATE || ':' || SQLERRM;
  END;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN r;
END $f$;
CREATE FUNCTION pg_temp.api(p_sql text, p_mode text DEFAULT 'v') RETURNS text LANGUAGE sql AS $$ SELECT pg_temp.x('lims_api', NULL, NULL, p_sql, p_mode) $$;
CREATE FUNCTION pg_temp.wrk(p_sql text, p_mode text DEFAULT 'v') RETURNS text LANGUAGE sql AS $$ SELECT pg_temp.x('lims_worker', NULL, NULL, p_sql, p_mode) $$;
CREATE FUNCTION pg_temp.apij(p_sql text) RETURNS jsonb LANGUAGE sql AS $$ SELECT CASE WHEN r LIKE 'E%' THEN to_jsonb(r) ELSE r::jsonb END FROM (SELECT pg_temp.x('lims_api', NULL, NULL, p_sql, 'j') r) s $$;
CREATE FUNCTION pg_temp.wrkj(p_sql text) RETURNS jsonb LANGUAGE sql AS $$ SELECT CASE WHEN r LIKE 'E%' THEN to_jsonb(r) ELSE r::jsonb END FROM (SELECT pg_temp.x('lims_worker', NULL, NULL, p_sql, 'j') r) s $$;
CREATE FUNCTION pg_temp.guc(p_name text) RETURNS text LANGUAGE sql AS $$ SELECT coalesce(current_setting(p_name, true), '<unset>') $$;

-- ---------------------------------------------------------------- fixtures (superuser; triggers and FK checks off while seeding)
SET LOCAL session_replication_role = replica;
INSERT INTO core.tenants (id, tenant_code, legal_name, display_name, status, created_by, updated_by) VALUES
  (pg_temp.id(1), 'lab_a', 'Lab A Pvt Ltd', 'Lab A', 'active', pg_temp.id(99), pg_temp.id(99)),
  (pg_temp.id(2), 'lab_b', 'Lab B Pvt Ltd', 'Lab B', 'suspended', pg_temp.id(99), pg_temp.id(99)),
  (pg_temp.id(3), 'lab_c', 'Lab C Pvt Ltd', 'Lab C', 'active', pg_temp.id(99), pg_temp.id(99));
INSERT INTO core.users (tenant_id, id, display_name, created_by, updated_by) VALUES
  (pg_temp.id(1), pg_temp.id(31), 'User 31', pg_temp.id(99), pg_temp.id(99)),
  (pg_temp.id(2), pg_temp.id(33), 'User 33', pg_temp.id(99), pg_temp.id(99)),
  (pg_temp.id(1), pg_temp.id(36), 'User 36', pg_temp.id(99), pg_temp.id(99)),
  (pg_temp.id(2), pg_temp.id(36), 'User 36', pg_temp.id(99), pg_temp.id(99)),
  (pg_temp.id(1), pg_temp.id(37), 'User 37', pg_temp.id(99), pg_temp.id(99)),
  (pg_temp.id(2), pg_temp.id(37), 'User 37', pg_temp.id(99), pg_temp.id(99)),
  (pg_temp.id(1), pg_temp.id(38), 'User 38', pg_temp.id(99), pg_temp.id(99)),
  (pg_temp.id(2), pg_temp.id(38), 'User 38', pg_temp.id(99), pg_temp.id(99)),
  (pg_temp.id(1), pg_temp.id(41), 'User 41', pg_temp.id(99), pg_temp.id(99));
INSERT INTO core.memberships (id, tenant_id, user_id, actor_type, status, partner_role, locked_at, locked_by, updated_at, created_by, updated_by) VALUES
  (pg_temp.id(41), pg_temp.id(1), pg_temp.id(31), 'user',    'active',      NULL,             NULL,  NULL,             now(),                     pg_temp.id(99), pg_temp.id(99)),
  (pg_temp.id(43), pg_temp.id(2), pg_temp.id(33), 'user',    'active',      NULL,             NULL,  NULL,             now(),                     pg_temp.id(99), pg_temp.id(99)),
  (pg_temp.id(46), pg_temp.id(1), pg_temp.id(36), 'user',    'deactivated', NULL,             NULL,  NULL,             now() - interval '1 hour', pg_temp.id(99), pg_temp.id(99)),
  (pg_temp.id(47), pg_temp.id(2), pg_temp.id(36), 'user',    'active',      NULL,             NULL,  NULL,             now() - interval '1 day',  pg_temp.id(99), pg_temp.id(99)),
  (pg_temp.id(48), pg_temp.id(1), pg_temp.id(37), 'user',    'deactivated', NULL,             NULL,  NULL,             now() - interval '1 day',  pg_temp.id(99), pg_temp.id(99)),
  (pg_temp.id(49), pg_temp.id(2), pg_temp.id(37), 'user',    'deactivated', NULL,             NULL,  NULL,             now() - interval '1 hour', pg_temp.id(99), pg_temp.id(99)),
  (pg_temp.id(50), pg_temp.id(1), pg_temp.id(38), 'user',    'active',      NULL,             NULL,  NULL,             now(),                     pg_temp.id(99), pg_temp.id(99)),
  (pg_temp.id(51), pg_temp.id(2), pg_temp.id(38), 'user',    'deactivated', NULL,             NULL,  NULL,             now(),                     pg_temp.id(99), pg_temp.id(99)),
  (pg_temp.id(52), pg_temp.id(1), pg_temp.id(38), 'patient', 'active',      NULL,             NULL,  NULL,             now(),                     pg_temp.id(99), pg_temp.id(99)),
  (pg_temp.id(53), pg_temp.id(2), pg_temp.id(38), 'partner', 'active',      'partner_member', NULL,  NULL,             now(),                     pg_temp.id(99), pg_temp.id(99)),
  (pg_temp.id(54), pg_temp.id(1), pg_temp.id(41), 'user',    'active',      NULL,             now(), pg_temp.id(99),   now(),                     pg_temp.id(99), pg_temp.id(99));
INSERT INTO core.roles (id, tenant_id, role_code, display_name, mfa_required, created_by, updated_by) VALUES
  (pg_temp.id(56), pg_temp.id(1), 'admin', 'Admin', true, pg_temp.id(99), pg_temp.id(99));
INSERT INTO core.membership_roles (tenant_id, membership_id, role_id, created_by) VALUES (pg_temp.id(1), pg_temp.id(41), pg_temp.id(56), pg_temp.id(99));
INSERT INTO identity.tenant_settings (tenant_id, retention_audit_years, idle_timeout_minutes, absolute_session_hours) VALUES
  (pg_temp.id(1), 5, 20, 10), (pg_temp.id(2), 7, 30, 12);
INSERT INTO identity.platform_staff (id, user_id, email_normalized, display_name, role_code, is_active, created_by, updated_by) VALUES
  (pg_temp.id(61), pg_temp.id(32), 'staff32@example.test', 'Staff 32', 'platform_admin', true,  pg_temp.id(99), pg_temp.id(99)),
  (pg_temp.id(62), pg_temp.id(39), 'staff39@example.test', 'Staff 39', 'platform_admin', true,  pg_temp.id(99), pg_temp.id(99)),
  (pg_temp.id(63), pg_temp.id(42), 'staff42@example.test', 'Staff 42', 'platform_admin', false, pg_temp.id(99), pg_temp.id(99));
INSERT INTO identity.mfa_factors (id, tenant_id, user_id, status, created_by, updated_by) VALUES
  (pg_temp.id(71), pg_temp.id(1), pg_temp.id(31), 'verified', pg_temp.id(99), pg_temp.id(99)),
  (pg_temp.id(72), NULL,          pg_temp.id(32), 'verified', pg_temp.id(99), pg_temp.id(99)),
  (pg_temp.id(73), NULL,          pg_temp.id(39), 'pending',  pg_temp.id(99), pg_temp.id(99)),
  (pg_temp.id(74), pg_temp.id(1), pg_temp.id(39), 'verified', pg_temp.id(99), pg_temp.id(99));
INSERT INTO identity.support_sessions (id, tenant_id, status, end_reason, scope, requested_at, decided_at, expires_at) VALUES
  (pg_temp.id(91), pg_temp.id(3), 'active',    NULL,      'read_only', now() - interval '2 hours',  now() - interval '1 hour',    now() + interval '1 hour'),
  (pg_temp.id(92), pg_temp.id(3), 'active',    NULL,      'read_only', now() - interval '3 hours',  now() - interval '2 hours',   now() - interval '1 hour'),
  (pg_temp.id(93), pg_temp.id(3), 'expired',   'expired', 'read_only', now() - interval '5 hours',  now() - interval '4 hours',   now() - interval '3 hours'),
  (pg_temp.id(94), pg_temp.id(3), 'requested', NULL,      'read_only', now() - interval '25 hours', NULL,                         NULL),
  (pg_temp.id(95), pg_temp.id(3), 'approved',  NULL,      'read_only', now() - interval '3 hours',  now() - interval '61 minutes', NULL),
  (pg_temp.id(96), pg_temp.id(3), 'requested', NULL,      'read_only', now() - interval '1 hour',   NULL,                         NULL);
INSERT INTO identity.sessions (id, tenant_id, user_id, kind, state, aal, membership_id, platform_staff_id, support_session_id, gotrue_session_id,
                               token_sha256, previous_token_sha256, idle_expires_at, absolute_expires_at, expires_at, revoked_at, created_by, updated_by) VALUES
  (pg_temp.id(101), pg_temp.id(1), pg_temp.id(31), 'tenant_staff', 'active',  'aal1', pg_temp.id(41), NULL,            NULL,           pg_temp.id(201), pg_temp.h(1), pg_temp.h(2), now() + interval '20 minutes', now() + interval '10 hours', now() + interval '1 day', NULL, pg_temp.id(99), pg_temp.id(99)),
  (pg_temp.id(102), NULL,          pg_temp.id(32), 'platform',     'active',  'aal2', NULL,           pg_temp.id(61), pg_temp.id(91), pg_temp.id(202), pg_temp.h(3), NULL,         now() + interval '20 minutes', now() + interval '10 hours', now() + interval '1 day', NULL, pg_temp.id(99), pg_temp.id(99)),
  (pg_temp.id(103), NULL,          pg_temp.id(32), 'platform',     'active',  'aal2', NULL,           pg_temp.id(61), pg_temp.id(92), pg_temp.id(203), pg_temp.h(4), NULL,         now() + interval '20 minutes', now() + interval '10 hours', now() + interval '1 day', NULL, pg_temp.id(99), pg_temp.id(99)),
  (pg_temp.id(104), NULL,          pg_temp.id(32), 'platform',     'active',  'aal2', NULL,           pg_temp.id(61), pg_temp.id(93), pg_temp.id(204), pg_temp.h(11), NULL,        now() + interval '20 minutes', now() + interval '10 hours', now() + interval '1 day', NULL, pg_temp.id(99), pg_temp.id(99)),
  (pg_temp.id(105), pg_temp.id(1), pg_temp.id(31), 'tenant_staff', 'revoked', 'aal1', pg_temp.id(41), NULL,            NULL,           pg_temp.id(205), pg_temp.h(5), pg_temp.h(6), now() + interval '20 minutes', now() + interval '10 hours', now() + interval '1 day', now(), pg_temp.id(99), pg_temp.id(99)),
  (pg_temp.id(106), pg_temp.id(1), pg_temp.id(31), 'tenant_staff', 'expired', 'aal1', pg_temp.id(41), NULL,            NULL,           pg_temp.id(206), pg_temp.h(7), NULL,         now() - interval '1 hour',     now() + interval '10 hours', now() + interval '1 day', NULL, pg_temp.id(99), pg_temp.id(99)),
  (pg_temp.id(107), pg_temp.id(1), pg_temp.id(41), 'tenant_staff', 'active',  'aal1', pg_temp.id(54), NULL,            NULL,           pg_temp.id(207), pg_temp.h(8), NULL,         now() + interval '20 minutes', now() + interval '10 hours', now() + interval '1 day', NULL, pg_temp.id(99), pg_temp.id(99)),
  (pg_temp.id(108), pg_temp.id(2), pg_temp.id(33), 'tenant_staff', 'active',  'aal1', pg_temp.id(43), NULL,            NULL,           pg_temp.id(208), pg_temp.h(9), NULL,         now() + interval '20 minutes', now() + interval '10 hours', now() + interval '1 day', NULL, pg_temp.id(99), pg_temp.id(99)),
  (pg_temp.id(109), pg_temp.id(1), pg_temp.id(31), 'tenant_staff', 'expired', 'aal1', pg_temp.id(41), NULL,            NULL,           pg_temp.id(209), pg_temp.h(10), NULL,        now() - interval '2 days',     now() - interval '1 day',    now() - interval '1 day', NULL, pg_temp.id(99), pg_temp.id(99));
INSERT INTO identity.admin_notices (id, tenant_id, kind, expires_at) VALUES
  (pg_temp.id(301), pg_temp.id(1), 'info', now() - interval '1 day'), (pg_temp.id(302), pg_temp.id(1), 'info', now() + interval '1 day');
INSERT INTO identity.invitations (id, tenant_id, user_id, email, status, expires_at, updated_at) VALUES
  (pg_temp.id(311), pg_temp.id(1), NULL,           'a1@example.test', 'pending',  now() - interval '1 day',  now() - interval '1 day'),
  (pg_temp.id(312), pg_temp.id(1), NULL,           'a2@example.test', 'sent',     now() - interval '2 days', now() - interval '2 days'),
  (pg_temp.id(313), pg_temp.id(1), NULL,           'a3@example.test', 'pending',  now() + interval '5 days', now() - interval '1 day'),
  (pg_temp.id(314), pg_temp.id(1), NULL,           'a4@example.test', 'accepted', now() + interval '1 day',  now() - interval '31 days'),
  (pg_temp.id(315), pg_temp.id(1), NULL,           'a5@example.test', 'revoked',  now() + interval '1 day',  now() - interval '5 days'),
  (pg_temp.id(316), pg_temp.id(1), NULL,           NULL,              'expired',  now() - interval '40 days', now() - interval '40 days'),
  (pg_temp.id(317), NULL,          pg_temp.id(32), NULL,              'sent',     now() + interval '5 days', now() - interval '1 day');
INSERT INTO identity.audit_exports (id, tenant_id, status, object_path, expires_at, downloads_remaining, created_at) VALUES
  (pg_temp.id(321), pg_temp.id(1), 'ready',   'tenant-a/x1', now() - interval '1 hour',  3,    now()),
  (pg_temp.id(322), pg_temp.id(1), 'ready',   'tenant-a/x2', now() + interval '1 day',   0,    now()),
  (pg_temp.id(323), pg_temp.id(1), 'ready',   'tenant-a/x3', now() + interval '1 day',   3,    now()),
  (pg_temp.id(324), pg_temp.id(1), 'expired', 'tenant-a/x4', now() - interval '2 years', 0,    now() - interval '2 years'),
  (pg_temp.id(325), pg_temp.id(1), 'failed',  'tenant-a/x5', NULL,                       NULL, now() - interval '13 months'),
  (pg_temp.id(326), pg_temp.id(1), 'expired', 'tenant-a/x6', now() - interval '1 month', 0,    now() - interval '1 month'),
  (pg_temp.id(327), pg_temp.id(1), 'queued',  'tenant-a/x7', NULL,                       NULL, now() - interval '2 years');
INSERT INTO identity.auth_events (id, tenant_id, user_id, event_type, email_hmac, client_ip, occurred_at, created_by) VALUES
  (pg_temp.id(341), NULL,          NULL, 'login_failed', pg_temp.h(20), '10.0.0.9', now() - interval '6 years', pg_temp.id(99)),
  (pg_temp.id(342), NULL,          NULL, 'login_failed', pg_temp.h(21), '10.0.0.9', now() - interval '4 years', pg_temp.id(99)),
  (pg_temp.id(343), pg_temp.id(1), NULL, 'login_ok',     NULL,          '10.0.0.9', now() - interval '6 years', pg_temp.id(99)),
  (pg_temp.id(344), pg_temp.id(2), NULL, 'login_ok',     NULL,          '10.0.0.9', now() - interval '6 years', pg_temp.id(99)),
  (pg_temp.id(345), pg_temp.id(2), NULL, 'login_ok',     NULL,          '10.0.0.9', now() - interval '8 years', pg_temp.id(99)),
  (pg_temp.id(346), pg_temp.id(1), NULL, 'login_ok',     NULL,          '10.0.0.9', now() - interval '1 year',  pg_temp.id(99)),
  (pg_temp.id(351), NULL,          NULL, 'login_failed', pg_temp.h(31), '10.0.0.7', now() - interval '1 hour',  pg_temp.id(99)),
  (pg_temp.id(352), NULL,          NULL, 'login_failed', pg_temp.h(31), '10.0.0.7', now() - interval '2 hours', pg_temp.id(99)),
  (pg_temp.id(353), NULL,          NULL, 'login_failed', pg_temp.h(32), '10.0.0.7', now() - interval '3 hours', pg_temp.id(99)),
  (pg_temp.id(354), NULL,          NULL, 'login_failed', pg_temp.h(33), '10.0.0.7', now() - interval '3 days',  pg_temp.id(99)),
  (pg_temp.id(355), NULL,          NULL, 'login_failed', pg_temp.h(34), '10.0.0.8', now() - interval '1 hour',  pg_temp.id(99)),
  (pg_temp.id(356), pg_temp.id(1), NULL, 'login_failed', pg_temp.h(35), '10.0.0.7', now() - interval '1 hour',  pg_temp.id(99)),
  (pg_temp.id(357), NULL,          NULL, 'login_ok',     pg_temp.h(36), '10.0.0.7', now() - interval '1 hour',  pg_temp.id(99)),
  (pg_temp.id(358), NULL,          NULL, 'login_failed', NULL,          '10.0.0.7', now() - interval '1 hour',  pg_temp.id(99));
SET LOCAL session_replication_role = origin;

-- ================================================================ catalog: inventory, attributes, grants (C0 §4.3; C2 §11 test 10; AC-0B-2.2/2.4)
CREATE TEMP TABLE sigs (sig text PRIMARY KEY, grantee text);
INSERT INTO sigs VALUES
  ('identity_resolve_session(uuid,uuid)', 'lims_api'), ('identity_session_by_token(bytea)', 'lims_api'), ('identity_login_context(uuid)', 'lims_api'),
  ('identity_user_exists(uuid)', 'lims_api'), ('identity_record_auth_event(jsonb)', 'lims_api'),
  ('identity_bootstrap_platform_admin(uuid,uuid,text,text,uuid)', 'lims_api'),
  ('identity_platform_auth_write_session_insert(uuid,jsonb)', 'lims_api'), ('identity_platform_auth_write_session_update(uuid,uuid,jsonb)', 'lims_api'),
  ('identity_platform_auth_write_mfa_factor(uuid,uuid,jsonb)', 'lims_api'), ('identity_platform_auth_write_invitation_accept(uuid,uuid)', 'lims_api'),
  ('identity_platform_auth_write_staff_login(uuid)', 'lims_api'),
  ('identity_purge_sessions()', 'lims_worker'), ('identity_expire_support_sessions()', 'lims_worker'), ('identity_expire_invitations()', 'lims_worker'),
  ('identity_expire_audit_exports()', 'lims_worker'), ('identity_purge_auth_events()', 'lims_worker'),
  ('identity_load_breached_batch(bytea[],text)', 'lims_worker'), ('identity_finish_breached_import(text)', 'lims_worker'),
  ('identity_notify_ip_throttle_hmacs(inet,timestamptz)', 'lims_worker');
SELECT is((SELECT count(*) FROM sigs), 19::bigint, 'inventory: 19 identity DEFINERs of C2 05-SCHEMA §6/§10.3 (excl. identity_tenants_for_email_hmacs = T0B-05, identity_is_breached = INVOKER)');
SELECT ok(to_regprocedure('app.' || sig) IS NOT NULL, 'exists: app.' || sig) FROM sigs ORDER BY sig;
SELECT ok(p.prosecdef, 'prosecdef: app.' || s.sig) FROM sigs s JOIN pg_proc p ON p.oid = to_regprocedure('app.' || s.sig) ORDER BY s.sig;
SELECT ok(pg_get_userbyid(p.proowner) = 'lims_owner', 'owner lims_owner: app.' || s.sig) FROM sigs s JOIN pg_proc p ON p.oid = to_regprocedure('app.' || s.sig) ORDER BY s.sig;
SELECT ok(array_to_string(p.proconfig, ',') LIKE '%search_path=%', 'proconfig has search_path (empty): app.' || s.sig)
  FROM sigs s JOIN pg_proc p ON p.oid = to_regprocedure('app.' || s.sig) ORDER BY s.sig;
SELECT ok(p.proacl IS NOT NULL AND NOT EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0), 'no EXECUTE for PUBLIC: app.' || s.sig)
  FROM sigs s JOIN pg_proc p ON p.oid = to_regprocedure('app.' || s.sig) ORDER BY s.sig;
SELECT ok(NOT EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname IN ('anon', 'authenticated') AND has_function_privilege(r.oid, p.oid, 'EXECUTE')),
          'no EXECUTE for anon/authenticated: app.' || s.sig)
  FROM sigs s JOIN pg_proc p ON p.oid = to_regprocedure('app.' || s.sig) ORDER BY s.sig;
-- granted exactly to the §10.3 role: lims_api set vs lims_worker set are disjoint, and lims_app (whose members include both) holds none
SELECT ok(has_function_privilege(s.grantee, p.oid, 'EXECUTE')
          AND NOT has_function_privilege(CASE s.grantee WHEN 'lims_api' THEN 'lims_worker' ELSE 'lims_api' END, p.oid, 'EXECUTE')
          AND NOT has_function_privilege('lims_app', p.oid, 'EXECUTE')
          AND NOT has_function_privilege('lims_queue', p.oid, 'EXECUTE'),
          'EXECUTE only for ' || s.grantee || ': app.' || s.sig)
  FROM sigs s JOIN pg_proc p ON p.oid = to_regprocedure('app.' || s.sig) ORDER BY s.sig;
SELECT is((SELECT array_agg(proname::text ORDER BY proname) FROM pg_proc WHERE pronamespace = 'app'::regnamespace AND prosecdef AND proname LIKE 'identity\_%'
             AND proname <> 'identity_tenants_for_email_hmacs'),
          (SELECT array_agg(split_part(sig, '(', 1) ORDER BY split_part(sig, '(', 1)) FROM sigs),
          'prosecdef set (app.identity_*) = inventory exactly (no extra DEFINER)');
SELECT ok(NOT p.prosecdef, 'app.identity_is_breached is INVOKER (when created)') FROM pg_proc p WHERE p.oid = to_regprocedure('app.identity_is_breached(bytea)');
SELECT ok(NOT p.prosecdef, 'app.tg_scope_user_only is INVOKER') FROM pg_proc p WHERE p.oid = to_regprocedure('app.tg_scope_user_only()');
-- lims_app cannot call the DEFINERs except as granted; an ungranted role gets 42501 (not a silent empty result)
SELECT ok(pg_temp.api($$SELECT app.identity_purge_sessions()$$) LIKE 'E42501:%', 'lims_api cannot call a lims_worker DEFINER (purge_sessions)');
SELECT ok(pg_temp.wrk($$SELECT app.identity_user_exists('$$ || pg_temp.id(31) || $$'::uuid)$$) LIKE 'E42501:%', 'lims_worker cannot call a lims_api DEFINER (user_exists)');
SELECT ok(pg_temp.x('lims_queue', NULL, NULL, $$SELECT app.identity_user_exists('$$ || pg_temp.id(31) || $$'::uuid)$$, 'v') LIKE 'E42501:%', 'lims_queue cannot call identity DEFINERs');

-- ================================================================ owner policies are lims_owner-only (C0 §4.3 GUC rule; C2 §11 test 24 last sentence; schema test 17)
SELECT ok(NOT EXISTS (SELECT 1 FROM pg_policies WHERE (qual ~ 'app\.(pre_|maintenance)' OR with_check ~ 'app\.(pre_|maintenance)') AND roles <> '{lims_owner}'),
          'every policy mentioning app.pre_* / app.maintenance is TO lims_owner only');
SELECT ok(EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'identity' AND tablename = 'platform_staff' AND policyname = 'platform_staff__select__owner_only' AND roles = '{lims_owner}' AND qual = 'true'),
          'platform_staff__select__owner_only TO lims_owner USING (true) (08 A10.5 - the single allowlisted USING (true))');
SELECT is((SELECT count(*) FROM pg_policies WHERE qual = 'true' OR with_check = 'true'), 1::bigint, 'USING (true) / WITH CHECK (true) appears exactly once in the database (AC-0B-2.2)');
SELECT ok((SELECT bool_and(c.relforcerowsecurity AND c.relrowsecurity) FROM pg_class c WHERE c.oid IN
           ('identity.platform_staff'::regclass, 'identity.platform_events'::regclass, 'identity.auth_events'::regclass, 'identity.tenant_settings'::regclass,
            'identity.sessions'::regclass, 'identity.admin_notices'::regclass, 'identity.mfa_factors'::regclass, 'identity.support_sessions'::regclass,
            'identity.invitations'::regclass, 'identity.audit_exports'::regclass, 'core.memberships'::regclass, 'core.users'::regclass,
            'core.tenants'::regclass, 'core.roles'::regclass, 'core.membership_roles'::regclass)),
          'FORCE + ENABLE RLS on every table the DEFINERs touch (asserted from pg_class, C2 §11 test 22)');

-- ================================================================ test 21: app.is_platform_actor() under FORCE RLS (08 A10.5)
SELECT ok((SELECT relforcerowsecurity FROM pg_class WHERE oid = 'identity.platform_staff'::regclass), 'is_platform_actor: relforcerowsecurity on identity.platform_staff');
SELECT ok(has_function_privilege('lims_api', 'app.is_platform_actor()', 'EXECUTE') AND has_function_privilege('lims_worker', 'app.is_platform_actor()', 'EXECUTE')
          AND has_function_privilege('lims_app', 'app.is_platform_actor()', 'EXECUTE'), 'is_platform_actor: EXECUTE for lims_app, lims_api, lims_worker');
CREATE FUNCTION pg_temp.pc(p_staff int, p_sub int, p_aal text DEFAULT 'aal2', p_scope text DEFAULT 'platform') RETURNS text LANGUAGE sql AS $$
  SELECT jsonb_build_object('scope', p_scope, 'aal', p_aal, 'platform_staff_id', pg_temp.id(p_staff), 'sub', pg_temp.id(p_sub))::text $$;
SELECT is(pg_temp.x('lims_api', pg_temp.pc(61, 32), NULL, 'SELECT app.is_platform_actor()', 'v'), 'true', 'is_platform_actor: active staff row, aal2, scope platform -> true (lims_api)');
SELECT is(pg_temp.x('lims_worker', pg_temp.pc(61, 32), NULL, 'SELECT app.is_platform_actor()', 'v'), 'true', 'is_platform_actor: true as lims_worker too');
SELECT is(pg_temp.x('lims_api', pg_temp.pc(63, 42), NULL, 'SELECT app.is_platform_actor()', 'v'), 'false', 'is_platform_actor: inactive staff row -> false');
SELECT is(pg_temp.x('lims_api', pg_temp.pc(61, 32, 'aal1'), NULL, 'SELECT app.is_platform_actor()', 'v'), 'false', 'is_platform_actor: aal1 -> false');
SELECT is(pg_temp.x('lims_api', pg_temp.pc(61, 32, 'aal2', 'tenant'), NULL, 'SELECT app.is_platform_actor()', 'v'), 'false', 'is_platform_actor: scope <> platform -> false');
SELECT is(pg_temp.x('lims_api', pg_temp.pc(61, 39), NULL, 'SELECT app.is_platform_actor()', 'v'), 'false', 'is_platform_actor: staff id of another user (sub mismatch) -> false');
SELECT is(pg_temp.x('lims_api', NULL, NULL, 'SELECT app.is_platform_actor()', 'v'), 'false', 'is_platform_actor: no claims -> false');
SELECT is(pg_temp.x('lims_api', pg_temp.pc(61, 32), NULL, 'SELECT count(*) FROM identity.platform_staff', 'v'), '0',
          'platform_staff stays invisible to a lims_app session (owner policy is TO lims_owner only)');

-- ================================================================ test 22 + plan: resolver cases (identity_resolve_session)
CREATE TEMP TABLE res (k text PRIMARY KEY, j jsonb);
INSERT INTO res VALUES
  ('staff',      pg_temp.apij('SELECT * FROM app.identity_resolve_session(' || pg_temp.q(201) || ',' || pg_temp.q(31) || ')')),
  ('wrong_sub',  pg_temp.apij('SELECT * FROM app.identity_resolve_session(' || pg_temp.q(201) || ',' || pg_temp.q(33) || ')')),
  ('no_row',     pg_temp.apij('SELECT * FROM app.identity_resolve_session(' || pg_temp.q(999) || ',' || pg_temp.q(31) || ')')),
  ('null_args',  pg_temp.apij('SELECT * FROM app.identity_resolve_session(NULL, NULL)')),
  ('revoked',    pg_temp.apij('SELECT * FROM app.identity_resolve_session(' || pg_temp.q(205) || ',' || pg_temp.q(31) || ')')),
  ('expired',    pg_temp.apij('SELECT * FROM app.identity_resolve_session(' || pg_temp.q(206) || ',' || pg_temp.q(31) || ')')),
  ('locked',     pg_temp.apij('SELECT * FROM app.identity_resolve_session(' || pg_temp.q(207) || ',' || pg_temp.q(41) || ')')),
  ('suspended',  pg_temp.apij('SELECT * FROM app.identity_resolve_session(' || pg_temp.q(208) || ',' || pg_temp.q(33) || ')')),
  ('plat_sup',   pg_temp.apij('SELECT * FROM app.identity_resolve_session(' || pg_temp.q(202) || ',' || pg_temp.q(32) || ')')),
  ('plat_late',  pg_temp.apij('SELECT * FROM app.identity_resolve_session(' || pg_temp.q(203) || ',' || pg_temp.q(32) || ')')),
  ('plat_ended', pg_temp.apij('SELECT * FROM app.identity_resolve_session(' || pg_temp.q(204) || ',' || pg_temp.q(32) || ')'));
SELECT is(jsonb_array_length(j), 1, 'resolve: tenant-staff session -> one row') FROM res WHERE k = 'staff';
SELECT is(j -> 0 ->> 'session_id', pg_temp.id(101)::text, 'resolve: session_id') FROM res WHERE k = 'staff';
SELECT is(j -> 0 ->> 'tenant_status', 'active', 'resolve: tenant_status') FROM res WHERE k = 'staff';
SELECT is(j -> 0 ->> 'membership_status', 'active', 'resolve: membership_status = active') FROM res WHERE k = 'staff';
SELECT is(j -> 0 ->> 'membership_locked', 'false', 'resolve: membership_locked = false when locked_at IS NULL (08 A3.4)') FROM res WHERE k = 'staff';
SELECT is(j -> 0 ->> 'membership_id', pg_temp.id(41)::text, 'resolve: membership_id') FROM res WHERE k = 'staff';
SELECT is(jsonb_array_length(j), 0, 'resolve: wrong sub -> no row') FROM res WHERE k = 'wrong_sub';
SELECT is(jsonb_array_length(j), 0, 'resolve: unknown gotrue session id -> no row') FROM res WHERE k = 'no_row';
SELECT is(jsonb_array_length(j), 0, 'resolve: NULL arguments -> no row, no error') FROM res WHERE k = 'null_args';
SELECT is(j -> 0 ->> 'state', 'revoked', 'resolve: revoked session is returned with state revoked (the claims resolver refuses it)') FROM res WHERE k = 'revoked';
SELECT ok(j -> 0 ->> 'revoked_at' IS NOT NULL, 'resolve: revoked session carries revoked_at') FROM res WHERE k = 'revoked';
SELECT is(j -> 0 ->> 'state', 'expired', 'resolve: expired session is returned with state expired') FROM res WHERE k = 'expired';
SELECT is(j -> 0 ->> 'membership_locked', 'true', 'resolve: locked membership -> membership_locked = true (08 A3.4)') FROM res WHERE k = 'locked';
SELECT is(j -> 0 ->> 'tenant_status', 'suspended', 'resolve: suspended tenant -> tenant_status suspended') FROM res WHERE k = 'suspended';
SELECT is(j -> 0 ->> 'platform_staff_id', pg_temp.id(61)::text, 'resolve: platform session -> platform_staff_id') FROM res WHERE k = 'plat_sup';
SELECT is(j -> 0 ->> 'platform_role', 'platform_admin', 'resolve: platform session -> platform_role') FROM res WHERE k = 'plat_sup';
SELECT is(j -> 0 ->> 'support_session_id', pg_temp.id(91)::text, 'resolve: active unexpired support session -> support_session_id (08 A15.1)') FROM res WHERE k = 'plat_sup';
SELECT is(j -> 0 ->> 'support_tenant_id', pg_temp.id(3)::text, 'resolve: support_tenant_id') FROM res WHERE k = 'plat_sup';
SELECT is(j -> 0 ->> 'support_scope', 'read_only', 'resolve: support_scope') FROM res WHERE k = 'plat_sup';
SELECT ok(j -> 0 ->> 'support_expires_at' IS NOT NULL, 'resolve: support_expires_at') FROM res WHERE k = 'plat_sup';
SELECT is(j -> 0 ->> 'support_tenant_status', 'active', 'resolve: support_tenant_status = core.tenants.status of the support tenant, read via app.pre_tenant_id (08 A20.1)') FROM res WHERE k = 'plat_sup';
SELECT is(j -> 0 ->> 'tenant_id', NULL, 'resolve: platform session has no tenant_id') FROM res WHERE k = 'plat_sup';
SELECT ok(j -> 0 ->> 'support_session_id' IS NULL AND j -> 0 ->> 'support_tenant_id' IS NULL AND j -> 0 ->> 'support_scope' IS NULL
          AND j -> 0 ->> 'support_expires_at' IS NULL AND j -> 0 ->> 'support_tenant_status' IS NULL,
          'resolve: support session active but past expires_at -> the five support columns are NULL') FROM res WHERE k = 'plat_late';
SELECT ok(j -> 0 ->> 'support_session_id' IS NULL AND j -> 0 ->> 'support_tenant_id' IS NULL AND j -> 0 ->> 'support_scope' IS NULL
          AND j -> 0 ->> 'support_expires_at' IS NULL AND j -> 0 ->> 'support_tenant_status' IS NULL,
          'resolve: support session not active -> the five support columns are NULL') FROM res WHERE k = 'plat_ended';
SELECT is(j -> 0 ->> 'platform_staff_id', pg_temp.id(61)::text, 'resolve: platform columns still filled when the support session is not usable') FROM res WHERE k = 'plat_late';

-- identity_session_by_token (test 17 function half; 08 A12.1)
CREATE FUNCTION pg_temp.tok(k int) RETURNS jsonb LANGUAGE sql AS $$ SELECT pg_temp.apij('SELECT * FROM app.identity_session_by_token(' || pg_temp.qh(k) || ')') $$;
SELECT is(pg_temp.tok(1) -> 0 ->> 'session_id', pg_temp.id(101)::text, 'by_token: current hash -> the session');
SELECT is(pg_temp.tok(1) -> 0 ->> 'token_reused', 'false', 'by_token: current hash -> token_reused = false');
SELECT is(jsonb_array_length(pg_temp.tok(1)), 1, 'by_token: current hash -> exactly one row');
SELECT is(pg_temp.tok(2) -> 0 ->> 'session_id', pg_temp.id(101)::text, 'by_token: previous hash -> the same session');
SELECT is(pg_temp.tok(2) -> 0 ->> 'token_reused', 'true', 'by_token: previous hash -> token_reused = true (CR-C2-018)');
SELECT is(jsonb_array_length(pg_temp.tok(5)), 0, 'by_token: current hash of a revoked session -> no row');
SELECT is(jsonb_array_length(pg_temp.tok(6)), 0, 'by_token: previous hash of a revoked session -> no row');
SELECT is(jsonb_array_length(pg_temp.tok(7)), 0, 'by_token: hash of an expired session -> no row');
SELECT is(jsonb_array_length(pg_temp.tok(777)), 0, 'by_token: unknown hash -> no row');
SELECT is(jsonb_array_length(pg_temp.apij('SELECT * FROM app.identity_session_by_token(NULL)')), 0, 'by_token: NULL -> no row, no error');
SELECT is(pg_temp.tok(3) -> 0 ->> 'platform_staff_id', pg_temp.id(61)::text, 'by_token: platform session -> platform_staff_id');
SELECT is(pg_temp.tok(3) -> 0 ->> 'support_session_id', pg_temp.id(91)::text, 'by_token: platform session -> support_session_id');

-- ================================================================ tests 18-20, 22: identity_login_context
CREATE FUNCTION pg_temp.lc(u int) RETURNS jsonb LANGUAGE sql AS $$ SELECT pg_temp.apij('SELECT * FROM app.identity_login_context(' || pg_temp.q(u) || ')') $$;
SELECT is(pg_temp.lc(31) -> 0 ->> 'membership_count', '1', 'login_context: staff with one active user membership -> membership_count 1');
SELECT is(pg_temp.lc(31) -> 0 ->> 'tenant_id', pg_temp.id(1)::text, 'login_context: tenant_id of the active membership');
SELECT is(pg_temp.lc(31) -> 0 ->> 'membership_id', pg_temp.id(41)::text, 'login_context: membership_id');
SELECT is(pg_temp.lc(31) -> 0 ->> 'membership_status', 'active', 'login_context: membership_status active');
SELECT is(pg_temp.lc(31) -> 0 ->> 'membership_locked', 'false', 'login_context: membership_locked false');
SELECT is(pg_temp.lc(31) -> 0 ->> 'tenant_status', 'active', 'login_context: tenant_status');
SELECT is(pg_temp.lc(31) -> 0 ->> 'mfa_required', 'true', 'login_context: mfa_required from the membership''s roles (core.roles.mfa_required via membership_roles)');
SELECT is(pg_temp.lc(31) -> 0 ->> 'has_verified_factor', 'true', 'login_context: verified tenant factor -> has_verified_factor true');
SELECT is(pg_temp.lc(31) -> 0 ->> 'idle_timeout_minutes', '20', 'login_context: tenant idle_timeout_minutes');
SELECT is(pg_temp.lc(31) -> 0 ->> 'absolute_session_hours', '10', 'login_context: tenant absolute_session_hours');
SELECT is(pg_temp.lc(41) -> 0 ->> 'membership_locked', 'true', 'login_context: locked membership -> membership_locked true (test 18)');
-- test 19 (08 A6.6): count predicate is status = active AND actor_type = user
SELECT is(pg_temp.lc(38) -> 0 ->> 'membership_count', '1', 'test 19: active user A + deactivated user B + patient + partner memberships -> membership_count 1');
SELECT is(pg_temp.lc(38) -> 0 ->> 'membership_id', pg_temp.id(50)::text, 'test 19: the chosen membership is the active user membership');
SELECT is(pg_temp.lc(37) -> 0 ->> 'membership_count', '0', 'test 19: only deactivated user memberships -> membership_count 0');
SELECT is(pg_temp.lc(36) -> 0 ->> 'membership_count', '1', 'test 19: deactivated never produces membership_count > 1');
-- test 20 (08 A8.1): the active membership wins over a more recently updated deactivated one
SELECT is(pg_temp.lc(36) -> 0 ->> 'tenant_id', pg_temp.id(2)::text, 'test 20: deactivated (A, updated later) + active (B) -> returns tenant B');
SELECT is(pg_temp.lc(36) -> 0 ->> 'membership_id', pg_temp.id(47)::text, 'test 20: membership_id of the active one');
SELECT is(pg_temp.lc(36) -> 0 ->> 'membership_status', 'active', 'test 20: membership_status active');
SELECT is(pg_temp.lc(37) -> 0 ->> 'membership_id', pg_temp.id(49)::text, 'test 20: only deactivated -> the most recently updated one (ORDER BY updated_at DESC)');
SELECT is(pg_temp.lc(37) -> 0 ->> 'membership_status', 'deactivated', 'test 20: membership_status deactivated (loginStaff -> 403 identity.membership_inactive)');
SELECT is(pg_temp.lc(37) -> 0 ->> 'tenant_id', pg_temp.id(2)::text, 'test 20: tenant of the most recently updated deactivated membership');
SELECT is(jsonb_array_length(pg_temp.lc(36)), 1, 'login_context: exactly one row per user (no fan-out from the platform_staff left join)');
-- platform staff with no membership (08 A15.2)
SELECT is(pg_temp.lc(32) -> 0 ->> 'platform_staff_id', pg_temp.id(61)::text, 'login_context: platform staff user -> platform_staff_id');
SELECT is(pg_temp.lc(32) -> 0 ->> 'platform_role', 'platform_admin', 'login_context: platform_role');
SELECT is(pg_temp.lc(32) -> 0 ->> 'platform_active', 'true', 'login_context: platform_active');
SELECT is(pg_temp.lc(32) -> 0 ->> 'membership_count', '0', 'login_context: platform staff, no membership -> membership_count 0');
SELECT is(pg_temp.lc(32) -> 0 ->> 'tenant_id', NULL, 'login_context: platform staff -> tenant_id NULL');
SELECT is(pg_temp.lc(32) -> 0 ->> 'mfa_required', 'true', 'login_context: platform staff -> mfa_required true');
SELECT is(pg_temp.lc(32) -> 0 ->> 'has_verified_factor', 'true', 'login_context: verified tenant-less factor -> has_verified_factor true (08 A15.2)');
SELECT is(pg_temp.lc(39) -> 0 ->> 'has_verified_factor', 'false', 'login_context: only an unverified tenant-less factor (the verified one belongs to a tenant) -> false');
SELECT is(pg_temp.lc(42) -> 0 ->> 'platform_active', 'false', 'login_context: inactive platform staff -> platform_active false');
SELECT is(pg_temp.lc(555) -> 0 ->> 'membership_count', '0', 'login_context: unknown user -> membership_count 0 (not an error, not a tenant leak)');
SELECT is(pg_temp.lc(555) -> 0 ->> 'tenant_id', NULL, 'login_context: unknown user -> tenant_id NULL');

-- identity_user_exists
SELECT is(pg_temp.api('SELECT app.identity_user_exists(' || pg_temp.q(31) || ')'), 'true', 'user_exists: core.users row in tenant A');
SELECT is(pg_temp.api('SELECT app.identity_user_exists(' || pg_temp.q(33) || ')'), 'true', 'user_exists: core.users row in tenant B (any tenant, no tenant revealed)');
SELECT is(pg_temp.api('SELECT app.identity_user_exists(' || pg_temp.q(32) || ')'), 'true', 'user_exists: platform staff user without core.users row');
SELECT is(pg_temp.api('SELECT app.identity_user_exists(' || pg_temp.q(555) || ')'), 'false', 'user_exists: unknown id -> false');
SELECT is(pg_temp.api('SELECT app.identity_user_exists(NULL)'), 'false', 'user_exists: NULL -> false');

-- ================================================================ test 24(c) (+AC-0D-2.3 DB half): GUCs are '' after every pre-tenant DEFINER returns
CREATE FUNCTION pg_temp.reset_gucs() RETURNS void LANGUAGE sql AS $$
  SELECT set_config(g, '', true) FROM unnest(ARRAY['app.pre_session_token_sha256','app.pre_gotrue_session_id','app.pre_user_id','app.pre_tenant_id',
    'app.pre_support_session_id','app.maintenance']) g $$;
CREATE FUNCTION pg_temp.gucs_after(p_sql text, p_names text[]) RETURNS text LANGUAGE plpgsql AS $$
DECLARE r text; g text; bad text := '';
BEGIN
  PERFORM pg_temp.reset_gucs();
  r := pg_temp.api(p_sql);
  FOREACH g IN ARRAY p_names LOOP IF coalesce(current_setting(g, true), '<unset>') <> '' THEN bad := bad || g || '=' || coalesce(current_setting(g, true), '<unset>') || ' '; END IF; END LOOP;
  RETURN CASE WHEN r LIKE 'E%' THEN r ELSE 'ok:' || bad END;
END $$;
SELECT is(pg_temp.gucs_after('SELECT count(*) FROM app.identity_resolve_session(' || pg_temp.q(202) || ',' || pg_temp.q(32) || ')', ARRAY['app.pre_gotrue_session_id','app.pre_user_id','app.pre_tenant_id','app.pre_support_session_id']),
          'ok:', 'GUCs reset to empty string after identity_resolve_session (platform session with support tenant)');
SELECT is(pg_temp.gucs_after('SELECT count(*) FROM app.identity_resolve_session(' || pg_temp.q(201) || ',' || pg_temp.q(31) || ')', ARRAY['app.pre_gotrue_session_id','app.pre_user_id','app.pre_tenant_id','app.pre_support_session_id']),
          'ok:', 'GUCs reset after identity_resolve_session (tenant session)');
SELECT is(pg_temp.gucs_after('SELECT count(*) FROM app.identity_resolve_session(' || pg_temp.q(999) || ',' || pg_temp.q(31) || ')', ARRAY['app.pre_gotrue_session_id','app.pre_user_id','app.pre_tenant_id','app.pre_support_session_id']),
          'ok:', 'GUCs reset after identity_resolve_session (no row)');
SELECT is(pg_temp.gucs_after('SELECT count(*) FROM app.identity_session_by_token(' || pg_temp.qh(1) || ')', ARRAY['app.pre_session_token_sha256']), 'ok:', 'GUC reset after identity_session_by_token');
SELECT is(pg_temp.gucs_after('SELECT count(*) FROM app.identity_login_context(' || pg_temp.q(36) || ')', ARRAY['app.pre_user_id','app.pre_tenant_id']), 'ok:', 'GUCs reset after identity_login_context (membership user)');
SELECT is(pg_temp.gucs_after('SELECT count(*) FROM app.identity_login_context(' || pg_temp.q(32) || ')', ARRAY['app.pre_user_id','app.pre_tenant_id']), 'ok:', 'GUCs reset after identity_login_context (platform staff)');
SELECT is(pg_temp.gucs_after('SELECT app.identity_user_exists(' || pg_temp.q(31) || ')', ARRAY['app.pre_user_id']), 'ok:', 'GUC reset after identity_user_exists');
-- claims are never left behind: outside a claims transaction the claims are empty and app.current_tenant_id() is NULL (AC-0D-2.3)
SELECT is(pg_temp.api('SELECT app.current_tenant_id()'), '<null>', 'AC-0D-2.3 (DB half): a statement with no claims sees app.current_tenant_id() NULL after the DEFINERs ran');

-- ================================================================ test 24(b): a lims_api / lims_worker session setting the GUCs itself sees 0 rows
CREATE TEMP TABLE gucs (pre text, val text);
INSERT INTO gucs VALUES
  ($$SELECT set_config('app.pre_session_token_sha256', '$$ || encode(pg_temp.h(1), 'hex') || $$', true)$$, 'x'),
  ($$SELECT set_config('app.pre_gotrue_session_id', '$$ || pg_temp.id(201) || $$', true)$$, 'x'),
  ($$SELECT set_config('app.pre_user_id', '$$ || pg_temp.id(31) || $$', true), set_config('app.pre_tenant_id', '$$ || pg_temp.id(1) || $$', true)$$, 'x'),
  ($$SELECT set_config('app.pre_user_id', '$$ || pg_temp.id(32) || $$', true), set_config('app.pre_tenant_id', '', true)$$, 'x'),
  ($$SELECT set_config('app.pre_support_session_id', '$$ || pg_temp.id(91) || $$', true), set_config('app.pre_tenant_id', '$$ || pg_temp.id(3) || $$', true)$$, 'x'),
  ($$SELECT set_config('app.maintenance', 'identity_purge_auth_events', true)$$, 'x'),
  ($$SELECT set_config('app.maintenance', 'identity_purge_sessions', true)$$, 'x'),
  ($$SELECT set_config('app.maintenance', 'identity_expire_support_sessions', true)$$, 'x'),
  ($$SELECT set_config('app.maintenance', 'identity_expire_invitations', true)$$, 'x'),
  ($$SELECT set_config('app.maintenance', 'identity_expire_audit_exports', true)$$, 'x'),
  ($$SELECT set_config('app.maintenance', 'identity_notify_ip_throttle', true)$$, 'x'),
  ($$SELECT set_config('app.maintenance', 'identity_tenants_for_email_hmacs', true)$$, 'x');
SELECT is(pg_temp.x(r, NULL, g.pre, 'SELECT (SELECT count(*) FROM identity.sessions) + (SELECT count(*) FROM core.memberships) + (SELECT count(*) FROM core.users)'
          || ' + (SELECT count(*) FROM core.tenants) + (SELECT count(*) FROM core.roles) + (SELECT count(*) FROM core.membership_roles) + (SELECT count(*) FROM identity.mfa_factors)'
          || ' + (SELECT count(*) FROM identity.tenant_settings) + (SELECT count(*) FROM identity.support_sessions) + (SELECT count(*) FROM identity.auth_events)'
          || ' + (SELECT count(*) FROM identity.invitations) + (SELECT count(*) FROM identity.audit_exports) + (SELECT count(*) FROM identity.admin_notices)', 'v'),
          '0', 'test 24(b): ' || r || ' sets the GUC itself (' || left(g.pre, 60) || '...) and sees 0 rows in all 13 tables')
  FROM gucs g CROSS JOIN (VALUES ('lims_api'), ('lims_worker')) roles(r);

SELECT pg_temp.reset_gucs();   -- the probes above set GUCs in this transaction; start the next blocks clean
-- ================================================================ test 24(d): owner policies admit nothing without their GUC, and the seeded due rows with it
CREATE FUNCTION pg_temp.own(p_pre text, p_sql text) RETURNS text LANGUAGE sql AS $$ SELECT pg_temp.x('lims_owner', NULL, p_pre, p_sql, 'n') $$;
CREATE TEMP TABLE due (tbl text, pred text, fn text, expect bigint);
INSERT INTO due VALUES
  ('identity.sessions',         'expires_at < now()',                                                                      'identity_purge_sessions',          1),
  ('identity.admin_notices',    'expires_at < now()',                                                                      'identity_purge_sessions',          1),
  ('identity.support_sessions', 'true',                                                                                    'identity_expire_support_sessions', 4),
  ('identity.invitations',      'true',                                                                                    'identity_expire_invitations',      4),
  ('identity.audit_exports',    'true',                                                                                    'identity_expire_audit_exports',    5),
  ('identity.auth_events',      'true',                                                                                    'identity_purge_auth_events',       4);
SELECT is(pg_temp.own('SELECT set_config(''app.maintenance'', '''', true)', 'SELECT 1 FROM ' || tbl || ' WHERE ' || pred), '0',
          'test 24(d): lims_owner, app.maintenance unset -> 0 rows of ' || tbl) FROM due;
SELECT is(pg_temp.own('SELECT set_config(''app.maintenance'', ''some_other_function'', true)', 'SELECT 1 FROM ' || tbl || ' WHERE ' || pred), '0',
          'test 24(d): lims_owner, another function''s name in app.maintenance -> 0 rows of ' || tbl) FROM due;
SELECT is(pg_temp.own('SELECT set_config(''app.maintenance'', ''' || fn || ''', true)', 'SELECT 1 FROM ' || tbl || ' WHERE ' || pred)::bigint, expect,
          'test 24(d): lims_owner with app.maintenance = ' || fn || ' -> sees exactly the ' || expect || ' due rows of ' || tbl) FROM due;
SELECT is(pg_temp.own('SELECT set_config(''app.maintenance'', ''identity_purge_sessions'', true)', 'SELECT 1 FROM identity.sessions WHERE expires_at < now()'), '1',
          'test 24(d): identity_purge_sessions admits exactly the one expired session (not the 8 live ones)');
SELECT is(pg_temp.own('SELECT set_config(''app.maintenance'', ''identity_purge_sessions'', true)', 'SELECT 1 FROM identity.sessions'), '1',
          'test 24(d): the maintenance branch of sessions__select__owner_only admits only expires_at < now() rows');
SELECT is(pg_temp.own('SELECT set_config(''app.maintenance'', ''identity_purge_auth_events'', true)', 'SELECT 1 FROM identity.auth_events'), '4',
          'test 24(d): identity_purge_auth_events admits only the 4 rows older than 5 years (never the newer ones)');

SELECT pg_temp.reset_gucs();
-- ================================================================ test 22: maintenance functions run as lims_worker, no claims, FORCE RLS
SELECT is(pg_temp.guc('app.maintenance'), '', 'maintenance GUC is empty before the maintenance run');
-- purge_sessions
SELECT is(pg_temp.wrk('SELECT app.identity_purge_sessions()'), '2', 'purge_sessions: deletes exactly the 1 expired session + 1 expired admin notice (returns 2)');
SELECT is((SELECT count(*) FROM identity.sessions WHERE id = pg_temp.id(109)), 0::bigint, 'purge_sessions: the expired session is gone');
SELECT is((SELECT count(*) FROM identity.sessions), 8::bigint, 'purge_sessions: the 8 unexpired sessions stay');
SELECT is((SELECT count(*) FROM identity.admin_notices), 1::bigint, 'purge_sessions: the unexpired admin notice stays');
SELECT is(pg_temp.guc('app.maintenance'), '', 'purge_sessions: app.maintenance is empty on return (08 A15.3)');
-- expire_support_sessions
SELECT is(pg_temp.wrk('SELECT app.identity_expire_support_sessions()'), '3', 'expire_support_sessions: requested>24h, approved>60min, active past expires_at -> 3');
SELECT is((SELECT array_agg(id ORDER BY id) FROM identity.support_sessions WHERE status = 'expired' AND end_reason = 'expired' AND ended_at IS NOT NULL AND id IN (pg_temp.id(92), pg_temp.id(94), pg_temp.id(95))),
          ARRAY[pg_temp.id(92), pg_temp.id(94), pg_temp.id(95)], 'expire_support_sessions: exactly the due rows are now expired with end_reason expired and ended_at');
SELECT is((SELECT status FROM identity.support_sessions WHERE id = pg_temp.id(91)), 'active', 'expire_support_sessions: the unexpired active session is untouched');
SELECT is((SELECT status FROM identity.support_sessions WHERE id = pg_temp.id(96)), 'requested', 'expire_support_sessions: a recent request is untouched');
SELECT is((SELECT version FROM identity.support_sessions WHERE id = pg_temp.id(94)), 2, 'expire_support_sessions: version bumped');
SELECT is(pg_temp.guc('app.maintenance'), '', 'expire_support_sessions: app.maintenance empty on return');
-- expire_invitations (one UPDATE, 08 A12.6)
SELECT is(pg_temp.wrk('SELECT app.identity_expire_invitations()'), '3', 'expire_invitations: 2 expired + 1 email cleared = 3 (sum of both branches)');
SELECT is((SELECT status FROM identity.invitations WHERE id = pg_temp.id(311)), 'expired', 'expire_invitations: pending past expires_at -> expired');
SELECT is((SELECT status FROM identity.invitations WHERE id = pg_temp.id(312)), 'expired', 'expire_invitations: sent past expires_at -> expired');
SELECT is((SELECT email FROM identity.invitations WHERE id = pg_temp.id(311)), 'a1@example.test', 'expire_invitations: a row expired in this run keeps its email');
SELECT ok((SELECT email IS NULL FROM identity.invitations WHERE id = pg_temp.id(314)), 'expire_invitations: terminal row older than 30 days -> email cleared');
SELECT is((SELECT status FROM identity.invitations WHERE id = pg_temp.id(314)), 'accepted', 'expire_invitations: a cleared terminal row keeps its status');
SELECT is((SELECT email FROM identity.invitations WHERE id = pg_temp.id(315)), 'a5@example.test', 'expire_invitations: terminal row younger than 30 days keeps its email');
SELECT is((SELECT status FROM identity.invitations WHERE id = pg_temp.id(313)), 'pending', 'expire_invitations: an unexpired pending invitation is untouched');
SELECT is((SELECT status FROM identity.invitations WHERE id = pg_temp.id(317)), 'sent', 'expire_invitations: the tenant-less platform invitation is untouched');
SELECT is(pg_temp.guc('app.maintenance'), '', 'expire_invitations: app.maintenance empty on return');
SELECT is(pg_temp.wrk('SELECT app.identity_expire_invitations()'), '0', 'expire_invitations: second run changes nothing (idempotent)');
-- expire_audit_exports (+ test 31: 1-year purge)
SELECT is(pg_temp.wrkj('SELECT * FROM app.identity_expire_audit_exports() ORDER BY 1'), '[{"object_path":"tenant-a/x1"},{"object_path":"tenant-a/x2"}]'::jsonb,
          'expire_audit_exports: returns exactly the object paths of the due ready rows');
SELECT is((SELECT array_agg(id ORDER BY id) FROM identity.audit_exports), ARRAY[pg_temp.id(321), pg_temp.id(322), pg_temp.id(323), pg_temp.id(326), pg_temp.id(327)],
          'test 31: expired/failed rows older than 1 year deleted; younger and every queued/ready row kept');
SELECT is((SELECT array_agg(status ORDER BY id) FROM identity.audit_exports WHERE id IN (pg_temp.id(321), pg_temp.id(322), pg_temp.id(323))), ARRAY['expired','expired','ready'],
          'expire_audit_exports: due rows expired, the unexpired ready row stays ready');
SELECT is(pg_temp.guc('app.maintenance'), '', 'expire_audit_exports: app.maintenance empty on return');
-- purge_auth_events (per-tenant retention: A 5y, B 7y; tenant-less 5y)
SELECT is(pg_temp.wrk('SELECT app.identity_purge_auth_events()'), '3', 'purge_auth_events: tenant-less 6y + tenant A 6y + tenant B 8y = 3');
SELECT is((SELECT array_agg(id ORDER BY id) FROM identity.auth_events WHERE id IN (pg_temp.id(341), pg_temp.id(342), pg_temp.id(343), pg_temp.id(344), pg_temp.id(345), pg_temp.id(346))),
          ARRAY[pg_temp.id(342), pg_temp.id(344), pg_temp.id(346)],
          'purge_auth_events: tenant-B 6y row stays (retention 7y); tenant-A 6y and tenant-less 6y go; 4y and 1y rows stay');
SELECT is(pg_temp.guc('app.maintenance'), '', 'purge_auth_events: app.maintenance empty on return');
-- notify_ip_throttle_hmacs (test 35)
SELECT is(pg_temp.wrkj($$SELECT encode(h, 'hex') AS h FROM app.identity_notify_ip_throttle_hmacs('10.0.0.7'::inet, now() - interval '1 day') h ORDER BY 1$$),
          jsonb_build_array(jsonb_build_object('h', encode(pg_temp.h(31), 'hex')), jsonb_build_object('h', encode(pg_temp.h(32), 'hex'))),
          'test 35: distinct HMACs of tenant-less login_failed events of that IP since p_since (not other IPs, older events, tenant rows, other event types, NULL hmac)');
SELECT is(pg_temp.guc('app.maintenance'), '', 'test 35: app.maintenance empty after notify_ip_throttle_hmacs');
SELECT ok(pg_temp.api($$SELECT app.identity_notify_ip_throttle_hmacs('10.0.0.7'::inet, now())$$) LIKE 'E42501:%', 'test 35: EXECUTE for lims_worker only (lims_api -> 42501)');
-- every maintenance function: empty-GUC check also holds when nothing matched
SELECT is(pg_temp.wrk('SELECT app.identity_purge_sessions()'), '0', 'purge_sessions: second run -> 0');
SELECT is(pg_temp.guc('app.maintenance'), '', 'app.maintenance empty after a no-op maintenance run');

-- ================================================================ test 22: record_auth_event and bootstrap_platform_admin (no claims, FORCE RLS)
SELECT is(pg_temp.api($$SELECT app.identity_record_auth_event(jsonb_build_object('id', '$$ || pg_temp.id(361) || $$', 'event_type', 'login_failed', 'reason_code', 'unknown_account',
          'email_hmac_hex', '$$ || encode(pg_temp.h(40), 'hex') || $$', 'client_ip', '10.0.0.5', 'user_agent', 'test-agent', 'request_id', '$$ || pg_temp.id(362) || $$',
          'created_by', '$$ || pg_temp.id(99) || $$'))::text$$), '', 'record_auth_event: succeeds with no claims');
SELECT is((SELECT count(*) FROM identity.auth_events WHERE id = pg_temp.id(361) AND tenant_id IS NULL AND event_type = 'login_failed' AND client_ip = '10.0.0.5'::inet), 1::bigint,
          'record_auth_event: inserts exactly one tenant-less row');
SELECT ok(pg_temp.api($$SELECT app.identity_record_auth_event(jsonb_build_object('id', '$$ || pg_temp.id(363) || $$', 'tenant_id', '$$ || pg_temp.id(1) || $$', 'event_type', 'login_ok',
          'created_by', '$$ || pg_temp.id(99) || $$'))$$) LIKE 'EP0001:tenant_events_use_rls_path%', 'record_auth_event: a tenant_id in the payload -> P0001 tenant_events_use_rls_path');
SELECT is((SELECT count(*) FROM identity.auth_events WHERE id = pg_temp.id(363)), 0::bigint, 'record_auth_event: the refused tenant row was not written');
SELECT is((SELECT count(*) FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgrelid IN ('identity.platform_staff'::regclass, 'identity.platform_events'::regclass)
            AND t.tgfoid = 'app.tg_row_audit()'::regprocedure), 0::bigint, 'test 25 / schema test 19: no app.tg_row_audit trigger on identity.platform_staff or identity.platform_events');
CREATE TEMP TABLE audit_before AS SELECT count(*) AS n FROM audit.audit_log;
SELECT is(pg_temp.api('SELECT app.identity_bootstrap_platform_admin(' || pg_temp.q(401) || ',' || pg_temp.q(402) || ', ''  Boot@Example.test '', ''Boot Admin'', ' || pg_temp.q(403) || ')::text'), '',
          'test 25: bootstrap_platform_admin succeeds with FORCE RLS and no claims (no audit_context_missing)');
SELECT is((SELECT count(*) FROM identity.platform_staff WHERE id = pg_temp.id(401) AND user_id = pg_temp.id(402) AND role_code = 'platform_superadmin' AND is_active
            AND email_normalized = 'boot@example.test'), 1::bigint, 'test 25: superadmin row inserted (email lower-cased and trimmed)');
SELECT is((SELECT count(*) FROM identity.platform_events WHERE id = pg_temp.id(403) AND event_type = 'bootstrap_admin_created' AND target_id = pg_temp.id(401)), 1::bigint,
          'test 25: bootstrap_admin_created event inserted');
SELECT is((SELECT count(*) FROM audit.audit_log), (SELECT n FROM audit_before), 'test 25: bootstrap writes no audit.audit_log row');
SELECT ok(pg_temp.api('SELECT app.identity_bootstrap_platform_admin(' || pg_temp.q(404) || ',' || pg_temp.q(405) || ', ''second@example.test'', ''Second'', ' || pg_temp.q(406) || ')::text') LIKE 'EP0001:bootstrap_closed%', 'test 11: a second bootstrap while an active superadmin exists -> P0001 bootstrap_closed');
SELECT is((SELECT count(*) FROM identity.platform_staff WHERE role_code = 'platform_superadmin'), 1::bigint, 'bootstrap_closed: no second superadmin was written');
SELECT ok(pg_temp.api('SELECT app.identity_bootstrap_platform_admin(' || pg_temp.q(404) || ',' || pg_temp.q(405) || ', ''x@example.test'', ''X'', ' || pg_temp.q(406) || ')::text') LIKE 'E%', 'bootstrap: the refused call raises (never a silent success)');
SELECT ok(pg_temp.x('lims_api', NULL, NULL, $$INSERT INTO identity.platform_staff (id, user_id, email_normalized, display_name, role_code, created_by, updated_by) VALUES
          ('$$ || pg_temp.id(407) || $$', '$$ || pg_temp.id(408) || $$', 'z@example.test', 'Z', 'platform_superadmin', '$$ || pg_temp.id(99) || $$', '$$ || pg_temp.id(99) || $$')$$, 'w') LIKE 'E42501:%', 'lims_api cannot INSERT into identity.platform_staff directly (owner policy is TO lims_owner; no grant)');

-- ================================================================ test 34: platform-staff auth DEFINERs (08 A28.1)
CREATE FUNCTION pg_temp.sysclaims() RETURNS text LANGUAGE sql AS $$ SELECT jsonb_build_object('sub', pg_temp.id(99), 'actor_type', 'system')::text $$;
SELECT ok(pg_temp.x('lims_api', pg_temp.sysclaims(), NULL, $$INSERT INTO identity.sessions (id, user_id, kind, expires_at, created_by, updated_by) VALUES
          ('$$ || pg_temp.id(410) || $$', '$$ || pg_temp.id(32) || $$', 'platform', now() + interval '1 day', '$$ || pg_temp.id(99) || $$', '$$ || pg_temp.id(99) || $$')$$, 'w') LIKE 'E42501:%', 'test 34: a direct INSERT of a platform session by lims_api (system claims, no tenant) is refused');
SELECT is(pg_temp.x('lims_api', pg_temp.sysclaims(), NULL, $$SELECT app.identity_platform_auth_write_session_insert('$$ || pg_temp.id(32) || $$',
          jsonb_build_object('id', '$$ || pg_temp.id(410) || $$', 'user_id', '$$ || pg_temp.id(32) || $$', 'kind', 'platform', 'state', 'active', 'aal', 'aal1',
          'expires_at', (now() + interval '1 day')::text, 'mfa_failed_attempts', 0, 'version', 1, 'created_at', now()::text, 'updated_at', now()::text,
          'created_by', '$$ || pg_temp.id(32) || $$', 'updated_by', '$$ || pg_temp.id(32) || $$'))::text$$, 'v'), '',
          'test 34: session_insert DEFINER inserts the platform session');
SELECT is((SELECT count(*) FROM identity.sessions WHERE id = pg_temp.id(410) AND tenant_id IS NULL AND kind = 'platform'), 1::bigint, 'test 34: the platform session exists');
SELECT is(pg_temp.guc('app.pre_user_id'), '', 'test 34: app.pre_user_id empty after session_insert');
SELECT ok(pg_temp.x('lims_api', pg_temp.sysclaims(), NULL, $$SELECT app.identity_platform_auth_write_session_insert('$$ || pg_temp.id(32) || $$',
          jsonb_build_object('id', '$$ || pg_temp.id(411) || $$', 'user_id', '$$ || pg_temp.id(32) || $$', 'kind', 'tenant_staff', 'tenant_id', '$$ || pg_temp.id(1) || $$',
          'expires_at', (now() + interval '1 day')::text, 'created_by', '$$ || pg_temp.id(32) || $$', 'updated_by', '$$ || pg_temp.id(32) || $$'))::text$$, 'v') LIKE 'EP0001:identity_platform_auth_write_invalid_input%', 'test 34: session_insert refuses a non-platform kind / a tenant_id');
SELECT ok(pg_temp.x('lims_api', pg_temp.sysclaims(), NULL, $$SELECT app.identity_platform_auth_write_session_insert('$$ || pg_temp.id(39) || $$',
          jsonb_build_object('id', '$$ || pg_temp.id(412) || $$', 'user_id', '$$ || pg_temp.id(32) || $$', 'kind', 'platform',
          'expires_at', (now() + interval '1 day')::text, 'created_by', '$$ || pg_temp.id(32) || $$', 'updated_by', '$$ || pg_temp.id(32) || $$'))::text$$, 'v') LIKE 'EP0001:identity_platform_auth_write_invalid_input%', 'test 34: session_insert refuses a row of another user');
SELECT is(pg_temp.x('lims_api', pg_temp.sysclaims(), NULL, $$SELECT app.identity_platform_auth_write_session_update('$$ || pg_temp.id(32) || $$', '$$ || pg_temp.id(410) || $$',
          jsonb_build_object('aal', 'aal2', 'mfa_failed_attempts', 2, 'updated_by', '$$ || pg_temp.id(32) || $$'))$$, 'v'), '1', 'test 34: session_update changes an allowed column set and returns 1');
SELECT is((SELECT aal || ':' || mfa_failed_attempts FROM identity.sessions WHERE id = pg_temp.id(410)), 'aal2:2', 'test 34: aal and mfa_failed_attempts updated');
SELECT is(pg_temp.x('lims_api', pg_temp.sysclaims(), NULL, $$SELECT app.identity_platform_auth_write_session_update('$$ || pg_temp.id(39) || $$', '$$ || pg_temp.id(410) || $$',
          jsonb_build_object('aal', 'aal1'))$$, 'v'), '0', 'test 34: session_update for another user''s session id returns 0');
SELECT ok(pg_temp.x('lims_api', pg_temp.sysclaims(), NULL, $$SELECT app.identity_platform_auth_write_session_update('$$ || pg_temp.id(32) || $$', '$$ || pg_temp.id(410) || $$',
          jsonb_build_object('tenant_id', '$$ || pg_temp.id(1) || $$'))$$, 'v') LIKE 'EP0001:identity_platform_auth_write_invalid_input%', 'test 34: session_update with an unlisted key (tenant_id) -> invalid_input');
SELECT ok(pg_temp.x('lims_api', pg_temp.sysclaims(), NULL, $$SELECT app.identity_platform_auth_write_session_update('$$ || pg_temp.id(32) || $$', '$$ || pg_temp.id(410) || $$',
          jsonb_build_object('kind', 'tenant_staff'))$$, 'v') LIKE 'EP0001:identity_platform_auth_write_invalid_input%', 'test 34: session_update with an unlisted key (kind) -> invalid_input');
SELECT is(pg_temp.x('lims_api', pg_temp.sysclaims(), NULL, $$SELECT app.identity_platform_auth_write_session_update('$$ || pg_temp.id(32) || $$', '$$ || pg_temp.id(101) || $$',
          jsonb_build_object('aal', 'aal2'))$$, 'v'), '0', 'test 34: session_update cannot touch a tenant session (returns 0)');
SELECT is(pg_temp.guc('app.pre_user_id'), '', 'test 34: app.pre_user_id empty after session_update');
SELECT is(pg_temp.x('lims_api', pg_temp.sysclaims(), NULL, $$SELECT app.identity_platform_auth_write_mfa_factor('$$ || pg_temp.id(32) || $$', NULL,
          jsonb_build_object('id', '$$ || pg_temp.id(420) || $$', 'user_id', '$$ || pg_temp.id(32) || $$', 'status', 'pending', 'is_active', true, 'version', 1,
          'created_at', now()::text, 'updated_at', now()::text, 'created_by', '$$ || pg_temp.id(32) || $$', 'updated_by', '$$ || pg_temp.id(32) || $$'))$$, 'v'),
          '1', 'test 34: mfa_factor inserts a tenant-less factor');
SELECT is(pg_temp.x('lims_api', pg_temp.sysclaims(), NULL, $$SELECT app.identity_platform_auth_write_mfa_factor('$$ || pg_temp.id(32) || $$', '$$ || pg_temp.id(420) || $$',
          jsonb_build_object('status', 'verified', 'verified_at', now()::text, 'updated_by', '$$ || pg_temp.id(32) || $$'))$$, 'v'), '1', 'test 34: mfa_factor verifies it');
SELECT is((SELECT status FROM identity.mfa_factors WHERE id = pg_temp.id(420)), 'verified', 'test 34: factor status verified');
SELECT ok(pg_temp.x('lims_api', pg_temp.sysclaims(), NULL, $$SELECT app.identity_platform_auth_write_mfa_factor('$$ || pg_temp.id(32) || $$', NULL,
          jsonb_build_object('id', '$$ || pg_temp.id(421) || $$', 'user_id', '$$ || pg_temp.id(32) || $$', 'tenant_id', '$$ || pg_temp.id(1) || $$', 'status', 'pending',
          'created_by', '$$ || pg_temp.id(32) || $$', 'updated_by', '$$ || pg_temp.id(32) || $$'))$$, 'v') LIKE 'EP0001:identity_platform_auth_write_invalid_input%', 'test 34: mfa_factor refuses a row with a tenant_id');
SELECT is(pg_temp.x('lims_api', pg_temp.sysclaims(), NULL, $$SELECT app.identity_platform_auth_write_mfa_factor('$$ || pg_temp.id(32) || $$', '$$ || pg_temp.id(71) || $$',
          jsonb_build_object('status', 'removed'))$$, 'v'), '0', 'test 34: mfa_factor cannot update a tenant factor (returns 0)');
SELECT is((SELECT status FROM identity.mfa_factors WHERE id = pg_temp.id(71)), 'verified', 'test 34: the tenant factor is unchanged');
SELECT is(pg_temp.x('lims_api', pg_temp.sysclaims(), NULL, $$SELECT app.identity_platform_auth_write_invitation_accept('$$ || pg_temp.id(32) || $$', '$$ || pg_temp.id(317) || $$')$$, 'v'), '1',
          'test 34: invitation_accept accepts the user''s sent platform invitation');
SELECT is((SELECT status FROM identity.invitations WHERE id = pg_temp.id(317)), 'accepted', 'test 34: invitation accepted');
SELECT is(pg_temp.x('lims_api', pg_temp.sysclaims(), NULL, $$SELECT app.identity_platform_auth_write_invitation_accept('$$ || pg_temp.id(32) || $$', '$$ || pg_temp.id(313) || $$')$$, 'v'), '0',
          'test 34: invitation_accept refuses a tenant invitation (returns 0)');
SELECT is(pg_temp.x('lims_api', pg_temp.sysclaims(), NULL, $$SELECT app.identity_platform_auth_write_invitation_accept('$$ || pg_temp.id(39) || $$', '$$ || pg_temp.id(317) || $$')$$, 'v'), '0',
          'test 34: invitation_accept for another user returns 0');
SELECT is(pg_temp.x('lims_api', pg_temp.sysclaims(), NULL, $$SELECT app.identity_platform_auth_write_staff_login('$$ || pg_temp.id(32) || $$')$$, 'v'), '1', 'test 34: staff_login updates one row');
SELECT ok((SELECT last_login_at IS NOT NULL FROM identity.platform_staff WHERE id = pg_temp.id(61)), 'test 34: platform_staff.last_login_at set');
SELECT is((SELECT last_login_at IS NULL FROM identity.platform_staff WHERE id = pg_temp.id(62)), true, 'test 34: other staff rows untouched');
SELECT is(pg_temp.x('lims_api', pg_temp.sysclaims(), NULL, $$SELECT app.identity_platform_auth_write_staff_login('$$ || pg_temp.id(42) || $$')$$, 'v'), '0', 'test 34: staff_login for an inactive staff row returns 0');
SELECT is(pg_temp.guc('app.pre_user_id'), '', 'test 34: app.pre_user_id empty after the last write');
SELECT ok(pg_temp.x('lims_api', pg_temp.sysclaims(), $$SELECT set_config('app.pre_user_id', '$$ || pg_temp.id(32) || $$', true)$$,
          $$INSERT INTO identity.sessions (id, user_id, kind, expires_at, created_by, updated_by) VALUES
          ('$$ || pg_temp.id(413) || $$', '$$ || pg_temp.id(32) || $$', 'platform', now() + interval '1 day', '$$ || pg_temp.id(99) || $$', '$$ || pg_temp.id(99) || $$')$$, 'w') LIKE 'E42501:%', 'test 34: lims_api setting app.pre_user_id itself still cannot insert a platform session (policies TO lims_owner)');
SELECT ok(pg_temp.x('lims_api', pg_temp.sysclaims(), $$SELECT set_config('app.pre_user_id', '$$ || pg_temp.id(32) || $$', true)$$,
          $$UPDATE identity.platform_staff SET last_login_at = NULL$$, 'w') LIKE 'E42501:%', 'test 34: lims_api setting app.pre_user_id itself cannot update platform_staff');

-- ================================================================ AC-0D-2.3 (DB half): no GUC leaks into the next transaction
-- (set_config(..., true) is transaction-local; verified by the grep of the migration in the static suite and by the '' checks above)
SELECT * FROM finish();
ROLLBACK;
