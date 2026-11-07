-- T0B-10.C2 pre-tenant lookup + bootstrap suite (C2 05-SCHEMA §6, §10.3; §11 tests 11, 17 (lookup half), 18, 19, 20, 22 (lookups, bootstrap, record_auth_event), 24 (b, c), 25 (behaviour), 34 (tail)).
-- Each DEFINER runs as its calling role (lims_api, no claims) with FORCE RLS asserted from pg_class on every table it touches (08 A10.5, A12.7, A15.3; AC-0B-2.4).
-- Single-tenant variants of §11 tests 19/20: 08 R27 allows one `user` membership per staff user (index memberships__user__one_tenant), so the two-tenant fixture of the
-- spec text cannot exist; the count and choice predicates (status = 'active' AND actor_type = 'user'; ORDER BY updated_at DESC) are exercised on one tenant.
-- Run from the repo root: pg_prove -d <db> db/tests/identity/T0B-10.C2_lookups.test.sql   (pgTAP in schema `extensions`; seeds loaded; superuser)
-- Coverage map (C2 05-SCHEMA §11):
-- §11 test 11: bootstrap_closed
-- §11 test 17: session_by_token current / previous hash
-- §11 test 18: membership_locked / membership_status
-- §11 test 19: membership_count predicate
-- §11 test 20: membership choice
-- §11 test 22: lookups, record_auth_event, bootstrap
-- §11 test 24: GUC reset and GUC-bound owner policies (b, c)
-- §11 test 25: bootstrap with no claims, no audit row
BEGIN;
SET search_path = extensions, public, pg_catalog;
SELECT * FROM no_plan();

CREATE FUNCTION pg_temp.ta() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1a98a-ac40-7000-8000-00000000a001'::uuid $$;
CREATE FUNCTION pg_temp.sys() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1b34e-1000-7eee-9d29-d7ca59a102b5'::uuid $$;
CREATE FUNCTION pg_temp.uid(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('0190c200-0000-7000-8000-' || lpad(n::text, 12, '0'))::uuid $$;
CREATE FUNCTION pg_temp.h32(s text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT '\x' || encode(sha256(convert_to(s, 'UTF8')), 'hex') $$;
CREATE FUNCTION pg_temp.sysc(p_tenant uuid) RETURNS void LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claims', jsonb_build_object('tenant_id', p_tenant, 'sub', pg_temp.sys(), 'actor_type', 'system')::text, true) $$;
CREATE FUNCTION pg_temp.ins(p_tbl regclass, p_row jsonb) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE cols text := (SELECT string_agg(quote_ident(k), ',') FROM jsonb_object_keys(p_row) k);
BEGIN EXECUTE format('INSERT INTO %1$s (%2$s) SELECT %2$s FROM jsonb_populate_record(NULL::%1$s, %3$L::jsonb)', p_tbl, cols, p_row::text); END $f$;
-- first column of the first row of p_sql, run as p_role with p_claims ('<none>' when no row, 'E<sqlstate>:<message>' on error)
CREATE FUNCTION pg_temp.v(p_role text, p_claims jsonb, p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE r text; saved text := current_setting('request.jwt.claims', true);
BEGIN
  PERFORM set_config('request.jwt.claims', coalesce(p_claims::text, ''), true);
  EXECUTE format('SET LOCAL ROLE %I', p_role);
  BEGIN EXECUTE p_sql INTO r; r := coalesce(r, '<none>'); EXCEPTION WHEN OTHERS THEN r := 'E' || SQLSTATE || ':' || SQLERRM; END;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', coalesce(saved, ''), true);
  RETURN r;
END $f$;
CREATE FUNCTION pg_temp.sess(p_over jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('id', pg_temp.uid(1100), 'tenant_id', pg_temp.ta(), 'kind', 'tenant_staff', 'user_id', '01a1a98a-ac40-7000-8000-00000000a300',
    'membership_id', '01a1a98a-ac40-7000-8000-00000000a500', 'gotrue_session_id', pg_temp.uid(1200), 'token_sha256', pg_temp.h32('cur'), 'previous_token_sha256', pg_temp.h32('prev'),
    'state', 'active', 'aal', 'aal1', 'refresh_token_enc', '\x01', 'access_token_enc', '\x01', 'enc_key_id', 'k1', 'access_expires_at', now() + interval '1 hour',
    'idle_timeout_minutes', 30, 'idle_expires_at', now() + interval '30 minutes', 'absolute_expires_at', now() + interval '11 hours', 'expires_at', now() + interval '12 hours',
    'created_by', pg_temp.sys(), 'updated_by', pg_temp.sys()) || p_over $$;

-- ===================================================================================================================================== FORCE RLS on every touched table
SELECT is(c.relforcerowsecurity, true, 'FORCE RLS on ' || t) FROM unnest(ARRAY['identity.sessions', 'identity.mfa_factors', 'identity.tenant_settings', 'identity.support_sessions', 'identity.auth_events',
  'identity.platform_staff', 'identity.platform_events', 'core.memberships', 'core.users', 'core.tenants', 'core.roles', 'core.membership_roles']) t JOIN pg_class c ON c.oid = t::regclass;

-- ===================================================================================================================================== fixtures
SELECT pg_temp.sysc(pg_temp.ta());
SELECT pg_temp.ins('identity.tenant_settings', jsonb_build_object('tenant_id', pg_temp.ta(), 'legal_name_snapshot', 'Synthetic Lab Alpha', 'display_name', 'Synthetic Lab Alpha',
  'idle_timeout_minutes', 20, 'absolute_session_hours', 10, 'created_by', pg_temp.sys(), 'updated_by', pg_temp.sys()));
SELECT pg_temp.ins('identity.platform_staff', jsonb_build_object('id', pg_temp.uid(1), 'user_id', pg_temp.uid(101), 'email_normalized', 'platform.support@synthetic.example', 'display_name', 'Synthetic Support',
  'role_code', 'platform_support', 'created_by', pg_temp.sys(), 'updated_by', pg_temp.sys()));
SELECT pg_temp.ins('identity.sessions', pg_temp.sess());
SELECT pg_temp.ins('identity.support_sessions', jsonb_build_object('id', pg_temp.uid(2), 'tenant_id', pg_temp.ta(), 'platform_staff_id', pg_temp.uid(1), 'scope', 'read_only',
  'reason_text', 'Synthetic ticket investigation', 'ticket_ref', 'SYN-1', 'duration_minutes', 30, 'status', 'active', 'started_at', now(), 'expires_at', now() + interval '30 minutes',
  'created_by', pg_temp.sys(), 'updated_by', pg_temp.sys()));
SELECT pg_temp.ins('identity.sessions', pg_temp.sess(jsonb_build_object('id', pg_temp.uid(1101), 'tenant_id', NULL, 'kind', 'platform', 'user_id', pg_temp.uid(101), 'membership_id', NULL,
  'platform_staff_id', pg_temp.uid(1), 'support_session_id', pg_temp.uid(2), 'gotrue_session_id', pg_temp.uid(1201), 'token_sha256', pg_temp.h32('plat'), 'previous_token_sha256', NULL, 'aal', 'aal2')));
SELECT pg_temp.ins('identity.sessions', pg_temp.sess(jsonb_build_object('id', pg_temp.uid(1102), 'state', 'revoked', 'revoked_at', now(), 'revoke_reason', 'logout', 'gotrue_session_id', pg_temp.uid(1202),
  'token_sha256', pg_temp.h32('dead'), 'previous_token_sha256', pg_temp.h32('deadprev'))));
SELECT pg_temp.ins('identity.mfa_factors', jsonb_build_object('id', pg_temp.uid(31), 'tenant_id', pg_temp.ta(), 'user_id', '01a1a98a-ac40-7000-8000-00000000a300', 'gotrue_factor_id', pg_temp.uid(131),
  'status', 'verified', 'created_by', pg_temp.sys(), 'updated_by', pg_temp.sys()));
SELECT pg_temp.ins('identity.mfa_factors', jsonb_build_object('id', pg_temp.uid(32), 'tenant_id', NULL, 'user_id', pg_temp.uid(101), 'gotrue_factor_id', pg_temp.uid(132),
  'status', 'verified', 'created_by', pg_temp.sys(), 'updated_by', pg_temp.sys()));

-- ===================================================================================================================================== §11 test 17 (lookup half) / 22
-- §11 test 17 / 22: app.identity_session_by_token
SELECT is(pg_temp.v('lims_api', NULL, format($$SELECT token_reused::text FROM app.identity_session_by_token(%L::bytea)$$, pg_temp.h32('cur'))), 'false', 'session_by_token(current hash): token_reused = false');
SELECT is(pg_temp.v('lims_api', NULL, format($$SELECT token_reused::text FROM app.identity_session_by_token(%L::bytea)$$, pg_temp.h32('prev'))), 'true', 'session_by_token(previous hash): same session, token_reused = true');
SELECT is(pg_temp.v('lims_api', NULL, format($$SELECT session_id::text FROM app.identity_session_by_token(%L::bytea)$$, pg_temp.h32('prev'))), pg_temp.uid(1100)::text, 'previous hash resolves the same session id');
SELECT is(pg_temp.v('lims_api', NULL, format($$SELECT session_id::text FROM app.identity_session_by_token(%L::bytea)$$, pg_temp.h32('dead'))), '<none>', 'revoked session: no row for the current hash');
SELECT is(pg_temp.v('lims_api', NULL, format($$SELECT session_id::text FROM app.identity_session_by_token(%L::bytea)$$, pg_temp.h32('deadprev'))), '<none>', 'revoked session: no row for the previous hash');
SELECT is(pg_temp.v('lims_api', NULL, format($$SELECT session_id::text FROM app.identity_session_by_token(%L::bytea)$$, pg_temp.h32('unknown'))), '<none>', 'unknown hash: no row');
UPDATE identity.sessions SET state = 'expired' WHERE id = pg_temp.uid(1100);
SELECT is(pg_temp.v('lims_api', NULL, format($$SELECT session_id::text FROM app.identity_session_by_token(%L::bytea)$$, pg_temp.h32('cur'))), '<none>', 'expired session: no row');
UPDATE identity.sessions SET state = 'active' WHERE id = pg_temp.uid(1100);
-- §11 test 24 (c): GUCs reset to '' after return; (b) a caller that sets the GUC itself sees no rows
SELECT is(pg_temp.v('lims_api', NULL, format($$SELECT (SELECT count(*) FROM app.identity_session_by_token(%L::bytea))::text || '|' || coalesce(current_setting('app.pre_session_token_sha256', true), 'NULL')$$, pg_temp.h32('cur'))),
  '1|', '-- §11 test 24(c) app.pre_session_token_sha256 is empty again after session_by_token returns');
SELECT is(pg_temp.v('lims_api', NULL, format($$SELECT set_config('app.pre_session_token_sha256', %L, true) || '|' || (SELECT count(*) FROM identity.sessions)::text$$, replace(pg_temp.h32('cur'), '\x', ''))),
  replace(pg_temp.h32('cur'), '\x', '') || '|0', '-- §11 test 24(b) lims_api setting the pre-session GUC itself sees 0 identity.sessions rows');
SELECT is(pg_temp.v('lims_worker', NULL, format($$SELECT set_config('app.pre_session_token_sha256', %L, true) || '|' || (SELECT count(*) FROM identity.sessions)::text$$, replace(pg_temp.h32('cur'), '\x', ''))),
  replace(pg_temp.h32('cur'), '\x', '') || '|0', 'lims_worker setting the pre-session GUC itself sees 0 identity.sessions rows');
SELECT is(pg_temp.v('lims_api', NULL, format($$SELECT set_config('app.pre_user_id', %L, true) || '|' || (SELECT count(*) FROM core.memberships)::text || '|' || (SELECT count(*) FROM core.users)::text$$, '01a1a98a-ac40-7000-8000-00000000a300')),
  '01a1a98a-ac40-7000-8000-00000000a300|0|0', 'lims_api setting app.pre_user_id itself sees 0 core.memberships / core.users rows (08 A12.7)') ;
SELECT is(pg_temp.v('lims_api', NULL, format($$SELECT set_config('app.pre_tenant_id', %L, true) || '|' || (SELECT count(*) FROM core.tenants)::text || '|' || (SELECT count(*) FROM core.roles)::text || '|' || (SELECT count(*) FROM identity.tenant_settings)::text$$, pg_temp.ta()::text)),
  pg_temp.ta()::text || '|0|0|0', 'lims_api setting app.pre_tenant_id itself sees 0 tenants / roles / tenant_settings rows');
SELECT is(pg_temp.v('lims_api', NULL, format($$SELECT set_config('app.pre_gotrue_session_id', %L, true) || '|' || (SELECT count(*) FROM identity.support_sessions)::text || '|' || (SELECT count(*) FROM identity.mfa_factors)::text || '|' || (SELECT count(*) FROM identity.auth_events)::text$$, pg_temp.uid(1200)::text)),
  pg_temp.uid(1200)::text || '|0|0|0', 'lims_api setting app.pre_gotrue_session_id itself sees 0 support_sessions / mfa_factors / auth_events rows');
SELECT is(pg_temp.v('lims_api', NULL, format($$SELECT set_config('app.pre_support_session_id', %L, true) || '|' || (SELECT count(*) FROM identity.support_sessions)::text$$, pg_temp.uid(2)::text)),
  pg_temp.uid(2)::text || '|0', 'lims_api setting app.pre_support_session_id itself sees 0 support_sessions rows');
SELECT is(pg_temp.v('lims_api', NULL, format($$SELECT set_config('app.maintenance', %L, true) || '|' || (SELECT count(*) FROM identity.sessions)::text || '|' || (SELECT count(*) FROM identity.invitations)::text$$, 'identity_purge_sessions')),
  'identity_purge_sessions|0|0', 'lims_api setting app.maintenance itself sees 0 sessions / invitations rows (08 A15.3)');

-- §11 test 22 / 18: app.identity_resolve_session
SELECT is(pg_temp.v('lims_api', NULL, format($$SELECT tenant_status || '|' || membership_status || '|' || membership_locked::text FROM app.identity_resolve_session(%L::uuid, %L::uuid)$$, pg_temp.uid(1200), '01a1a98a-ac40-7000-8000-00000000a300')),
  (SELECT status FROM core.tenants WHERE id = pg_temp.ta()) || '|active|false', '-- §11 test 22 resolve_session returns tenant_status, membership_status = active and membership_locked = false');
SELECT is(pg_temp.v('lims_api', NULL, format($$SELECT session_id::text FROM app.identity_resolve_session(%L::uuid, %L::uuid)$$, pg_temp.uid(1200), pg_temp.uid(999))), '<none>', 'resolve_session: no row for a wrong sub');
SELECT is(pg_temp.v('lims_api', NULL, format($$SELECT (SELECT count(*) FROM app.identity_resolve_session(%L::uuid, %L::uuid))::text || '|' || coalesce(current_setting('app.pre_user_id', true), 'NULL') || '|' || coalesce(current_setting('app.pre_gotrue_session_id', true), 'NULL') || '|' || coalesce(current_setting('app.pre_tenant_id', true), 'NULL')$$,
  pg_temp.uid(1200), '01a1a98a-ac40-7000-8000-00000000a300')), '1|||', 'resolve_session leaves app.pre_user_id / pre_gotrue_session_id / pre_tenant_id empty (08 A15.1)');
UPDATE core.memberships SET locked_at = now(), locked_by = pg_temp.sys(), lock_reason_code = 'admin_lock' WHERE id = '01a1a98a-ac40-7000-8000-00000000a500';
SELECT is(pg_temp.v('lims_api', NULL, format($$SELECT membership_locked::text FROM app.identity_resolve_session(%L::uuid, %L::uuid)$$, pg_temp.uid(1200), '01a1a98a-ac40-7000-8000-00000000a300')), 'true', '-- §11 test 18 membership_locked = true exactly when locked_at IS NOT NULL');
SELECT is(pg_temp.v('lims_api', NULL, format($$SELECT membership_locked::text FROM app.identity_login_context(%L::uuid)$$, '01a1a98a-ac40-7000-8000-00000000a300')), 'true', 'login_context: membership_locked = true for a locked membership');
UPDATE core.memberships SET locked_at = NULL, locked_by = NULL, lock_reason_code = NULL WHERE id = '01a1a98a-ac40-7000-8000-00000000a500';
SELECT is(pg_temp.v('lims_api', NULL, format($$SELECT membership_locked::text FROM app.identity_login_context(%L::uuid)$$, '01a1a98a-ac40-7000-8000-00000000a300')), 'false', 'login_context: membership_locked = false when unlocked');
-- platform session with an active support session (08 A20.1)
SELECT is(pg_temp.v('lims_api', NULL, format($$SELECT platform_staff_id::text || '|' || platform_role || '|' || support_session_id::text || '|' || support_tenant_id::text || '|' || support_scope || '|' || support_tenant_status FROM app.identity_resolve_session(%L::uuid, %L::uuid)$$,
  pg_temp.uid(1201), pg_temp.uid(101))),
  pg_temp.uid(1)::text || '|platform_support|' || pg_temp.uid(2)::text || '|' || pg_temp.ta()::text || '|read_only|' || (SELECT status FROM core.tenants WHERE id = pg_temp.ta()),
  'resolve_session(platform session): staff id, role and the active support session with support_tenant_status');
SELECT is(pg_temp.v('lims_api', NULL, format($$SELECT support_expires_at IS NOT NULL FROM app.identity_resolve_session(%L::uuid, %L::uuid)$$, pg_temp.uid(1201), pg_temp.uid(101))), 'true', 'support_expires_at returned for an active support session');
UPDATE identity.support_sessions SET status = 'ended', ended_at = now(), end_reason = 'ended_by_staff' WHERE id = pg_temp.uid(2);
SELECT is(pg_temp.v('lims_api', NULL, format($$SELECT (support_session_id IS NULL AND support_tenant_id IS NULL AND support_tenant_status IS NULL AND support_scope IS NULL AND support_expires_at IS NULL)::text FROM app.identity_resolve_session(%L::uuid, %L::uuid)$$,
  pg_temp.uid(1201), pg_temp.uid(101))), 'true', 'ended support session: the five support columns are NULL');
UPDATE identity.support_sessions SET status = 'active', ended_at = NULL, end_reason = NULL, expires_at = now() - interval '1 minute' WHERE id = pg_temp.uid(2);
SELECT is(pg_temp.v('lims_api', NULL, format($$SELECT (support_session_id IS NULL AND support_tenant_id IS NULL)::text FROM app.identity_resolve_session(%L::uuid, %L::uuid)$$, pg_temp.uid(1201), pg_temp.uid(101))),
  'true', 'active but expired support session: support columns NULL');

-- §11 test 22 / 19 / 20: app.identity_login_context
SELECT is(pg_temp.v('lims_api', NULL, format($$SELECT tenant_id::text || '|' || membership_id::text || '|' || membership_status || '|' || membership_count::text FROM app.identity_login_context(%L::uuid)$$, '01a1a98a-ac40-7000-8000-00000000a300')),
  pg_temp.ta()::text || '|01a1a98a-ac40-7000-8000-00000000a500|active|1', '-- §11 test 22 login_context(staff): tenant, membership, membership_status = active, membership_count = 1');
SELECT is(pg_temp.v('lims_api', NULL, format($$SELECT has_verified_factor::text || '|' || idle_timeout_minutes::text || '|' || absolute_session_hours::text FROM app.identity_login_context(%L::uuid)$$, '01a1a98a-ac40-7000-8000-00000000a300')),
  'true|20|10', 'login_context: verified factor seen; idle / absolute come from the tenant settings');
SELECT is(pg_temp.v('lims_api', NULL, format($$SELECT mfa_required::text FROM app.identity_login_context(%L::uuid)$$, '01a1a98a-ac40-7000-8000-00000000a300')),
  (SELECT bool_or(r.mfa_required)::text FROM core.membership_roles mr JOIN core.roles r ON r.tenant_id = mr.tenant_id AND r.id = mr.role_id WHERE mr.tenant_id = pg_temp.ta() AND mr.membership_id = '01a1a98a-ac40-7000-8000-00000000a500'),
  'login_context: mfa_required derives from the membership''s roles');
UPDATE identity.mfa_factors SET status = 'unverified' WHERE id = pg_temp.uid(31);
SELECT is(pg_temp.v('lims_api', NULL, format($$SELECT has_verified_factor::text FROM app.identity_login_context(%L::uuid)$$, '01a1a98a-ac40-7000-8000-00000000a300')), 'false', 'unverified factor: has_verified_factor = false');
UPDATE identity.mfa_factors SET status = 'verified' WHERE id = pg_temp.uid(31);
-- platform staff user, no membership
SELECT is(pg_temp.v('lims_api', NULL, format($$SELECT platform_staff_id::text || '|' || platform_role || '|' || membership_count::text || '|' || coalesce(tenant_id::text, 'NULL') || '|' || mfa_required::text || '|' || has_verified_factor::text FROM app.identity_login_context(%L::uuid)$$, pg_temp.uid(101))),
  pg_temp.uid(1)::text || '|platform_support|0|NULL|true|true', 'login_context(platform staff): staff id, role, membership_count 0, no tenant, mfa_required, verified tenant-less factor (08 A15.2)');
UPDATE identity.mfa_factors SET tenant_id = pg_temp.ta() WHERE id = pg_temp.uid(32);
SELECT is(pg_temp.v('lims_api', NULL, format($$SELECT has_verified_factor::text FROM app.identity_login_context(%L::uuid)$$, pg_temp.uid(101))), 'false', 'a tenant-bound factor does not count for platform staff');
-- §11 test 19: membership_count predicate (status = 'active' AND actor_type = 'user')
-- §11 test 20: choice of membership (ORDER BY updated_at DESC), deactivated membership reported as such
UPDATE core.memberships SET status = 'deactivated', deactivated_at = now(), deactivated_by = pg_temp.sys(), deactivation_reason_code = 'admin_deactivate' WHERE id = '01a1a98a-ac40-7000-8000-00000000a500';
SELECT is(pg_temp.v('lims_api', NULL, format($$SELECT membership_id::text || '|' || membership_status || '|' || membership_count::text FROM app.identity_login_context(%L::uuid)$$, '01a1a98a-ac40-7000-8000-00000000a300')),
  '01a1a98a-ac40-7000-8000-00000000a500|deactivated|0', 'only deactivated user membership: returned with membership_status = deactivated and membership_count = 0 (loginStaff -> 403 identity.membership_inactive)');
SELECT is(pg_temp.v('lims_api', NULL, format($$SELECT (SELECT count(*) FROM app.identity_login_context(%L::uuid))::text$$, '01a1a98a-ac40-7000-8000-00000000a300')), '1', 'login_context returns one row');
UPDATE core.memberships SET status = 'active', deactivated_at = NULL, deactivated_by = NULL, deactivation_reason_code = NULL WHERE id = '01a1a98a-ac40-7000-8000-00000000a500';
SELECT is((SELECT count(*)::int FROM pg_proc p WHERE p.oid = 'app.identity_login_context(uuid)'::regprocedure AND pg_get_functiondef(p.oid) ~* 'order by[^;]*updated_at\s+desc'), 1, 'login_context body orders by updated_at DESC');
SELECT is((SELECT pg_get_functiondef(p.oid) ~* 'limit\s+1' AND pg_get_functiondef(p.oid) !~* 'order by' FROM pg_proc p WHERE p.oid = 'app.identity_login_context(uuid)'::regprocedure), false, 'login_context has no LIMIT 1 without ORDER BY (08 A8.1)');
-- patient / partner memberships of the same user leave membership_count at 1 (08 A6.6): the predicate is part of the function body
SELECT matches((SELECT pg_get_functiondef('app.identity_login_context(uuid)'::regprocedure)), 'actor_type\s*=\s*''user''', 'login_context counts only actor_type = ''user'' memberships');
SELECT matches((SELECT pg_get_functiondef('app.identity_login_context(uuid)'::regprocedure)), 'status\s*=\s*''active''', 'login_context counts only status = ''active'' memberships');

-- app.identity_user_exists
SELECT is(pg_temp.v('lims_api', NULL, format($$SELECT app.identity_user_exists(%L::uuid)::text$$, '01a1a98a-ac40-7000-8000-00000000a300')), 'true', 'user_exists: core.users row');
SELECT is(pg_temp.v('lims_api', NULL, format($$SELECT app.identity_user_exists(%L::uuid)::text$$, pg_temp.uid(101))), 'true', 'user_exists: platform staff user');
SELECT is(pg_temp.v('lims_api', NULL, format($$SELECT app.identity_user_exists(%L::uuid)::text$$, pg_temp.uid(998))), 'false', 'user_exists: unknown id');
SELECT is(pg_temp.v('lims_api', NULL, format($$SELECT app.identity_user_exists(%L::uuid)::text || '|' || coalesce(current_setting('app.pre_user_id', true), 'NULL')$$, pg_temp.uid(101))), 'true|', 'user_exists resets app.pre_user_id to empty');

-- ===================================================================================================================================== §11 test 22: record_auth_event
SELECT is(pg_temp.v('lims_api', jsonb_build_object('sub', pg_temp.sys(), 'actor_type', 'system'), format($$SELECT app.identity_record_auth_event(%L::jsonb)::text$$,
  jsonb_build_object('id', pg_temp.uid(2301), 'event_type', 'login_failed', 'reason_code', 'unknown_account', 'email_hmac_hex', repeat('ab', 32), 'client_ip', '192.0.2.10', 'created_by', pg_temp.sys())::text)), '',
  'record_auth_event inserts a tenant-less row');
SELECT is((SELECT count(*)::int FROM identity.auth_events WHERE id = pg_temp.uid(2301) AND tenant_id IS NULL), 1, 'the recorded auth event is tenant-less');
SELECT is(pg_temp.v('lims_api', jsonb_build_object('sub', pg_temp.sys(), 'actor_type', 'system'), format($$SELECT app.identity_record_auth_event(%L::jsonb)::text$$,
  jsonb_build_object('id', pg_temp.uid(2302), 'tenant_id', pg_temp.ta(), 'event_type', 'login_failed', 'created_by', pg_temp.sys())::text)), 'EP0001:tenant_events_use_rls_path',
  'record_auth_event refuses a tenant-bound event (tenant_events_use_rls_path)');

-- ===================================================================================================================================== §11 test 11 / 25: bootstrap
-- §11 test 11 / 25: app.identity_bootstrap_platform_admin: no claims (CLI path), inserts staff + event, no audit_log row, closes once a superadmin exists
CREATE TEMP TABLE audit_before AS SELECT count(*)::int AS n FROM audit.audit_log;
DELETE FROM identity.sessions WHERE platform_staff_id = pg_temp.uid(1);
DELETE FROM identity.support_sessions WHERE platform_staff_id = pg_temp.uid(1);
DELETE FROM identity.platform_staff WHERE id = pg_temp.uid(1);
SELECT is(pg_temp.v('lims_api', NULL, format($$SELECT app.identity_bootstrap_platform_admin(%L::uuid, %L::uuid, 'root@synthetic.example', 'Synthetic Root', %L::uuid)::text$$, pg_temp.uid(3001), pg_temp.uid(3101), pg_temp.uid(3201))), '',
  '-- §11 test 25 bootstrap succeeds with no claims (no audit_context_missing)');
SELECT is((SELECT count(*)::int FROM identity.platform_staff WHERE id = pg_temp.uid(3001) AND role_code = 'platform_superadmin' AND is_active), 1, 'bootstrap inserted the active superadmin');
SELECT is((SELECT count(*)::int FROM identity.platform_events WHERE id = pg_temp.uid(3201) AND event_type = 'bootstrap_admin_created'), 1, 'bootstrap inserted the bootstrap_admin_created event');
SELECT is((SELECT count(*)::int FROM audit.audit_log) - (SELECT n FROM audit_before), 0, 'bootstrap wrote no audit.audit_log row (platform-only tables are not audited, 08 A12.5)');
SELECT is(pg_temp.v('lims_api', NULL, format($$SELECT app.identity_bootstrap_platform_admin(%L::uuid, %L::uuid, 'second@synthetic.example', 'Second Root', %L::uuid)::text$$, pg_temp.uid(3002), pg_temp.uid(3102), pg_temp.uid(3202))),
  'EP0001:bootstrap_closed', '-- §11 test 11 bootstrap raises bootstrap_closed when an active superadmin exists');
SELECT is((SELECT count(*)::int FROM identity.platform_staff WHERE id = pg_temp.uid(3002)), 0, 'no second superadmin was created');

SELECT * FROM finish();
ROLLBACK;
