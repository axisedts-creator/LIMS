-- T0B-10.C2 maintenance + platform-auth DEFINER suite (C2 05-SCHEMA §6, §10.3; §11 tests 22 (maintenance), 23, 24 (b, d), 28, 31, 33, 34, 35).
-- Each function runs as its calling role (lims_worker for maintenance / import / notify / hmacs, lims_api for platform-auth writes) with no tenant claims and
-- FORCE RLS asserted from pg_class on every table it touches (08 A10.5, A12.7, A15.3). RLS is never disabled; fixtures are inserted by the superuser with
-- system-actor claims so the audit triggers have a context. Synthetic data only; one rolled-back transaction.
-- Run from the repo root: pg_prove -d <db> db/tests/identity/T0B-10.C2_maintenance.test.sql   (pgTAP in schema `extensions`; seeds loaded; superuser)
-- Coverage map (C2 05-SCHEMA §11):
-- §11 test 22: maintenance functions
-- §11 test 23: lims_api cannot call maintenance functions (platform dead_letters policies live in T0B-05/T0B-08 suites)
-- §11 test 24: owner policies admit nothing without their GUC (d)
-- §11 test 28: identity_tenants_for_email_hmacs, admin_notices subject check
-- §11 test 31: audit_exports 1-year purge
-- §11 test 33: audit inside maintenance DEFINERs
-- §11 test 34: platform-staff auth DEFINERs
-- §11 test 35: identity_notify_ip_throttle_hmacs
BEGIN;
SET search_path = extensions, public, pg_catalog;
SELECT * FROM no_plan();

CREATE FUNCTION pg_temp.ta() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1a98a-ac40-7000-8000-00000000a001'::uuid $$;
CREATE FUNCTION pg_temp.tb() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1a98a-ac40-7000-8000-00000000b001'::uuid $$;
CREATE FUNCTION pg_temp.sys() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1b34e-1000-7eee-9d29-d7ca59a102b5'::uuid $$;
CREATE FUNCTION pg_temp.uid(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('0190c200-0000-7000-8000-' || lpad(n::text, 12, '0'))::uuid $$;
CREATE FUNCTION pg_temp.h32(s text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT '\x' || encode(sha256(convert_to(s, 'UTF8')), 'hex') $$;
CREATE FUNCTION pg_temp.sysc(p_tenant uuid) RETURNS void LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claims', jsonb_build_object('tenant_id', p_tenant, 'sub', pg_temp.sys(), 'actor_type', 'system')::text, true) $$;
CREATE FUNCTION pg_temp.ins(p_tbl regclass, p_row jsonb) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE cols text := (SELECT string_agg(quote_ident(k), ',') FROM jsonb_object_keys(p_row) k);
BEGIN EXECUTE format('INSERT INTO %1$s (%2$s) SELECT %2$s FROM jsonb_populate_record(NULL::%1$s, %3$L::jsonb)', p_tbl, cols, p_row::text); END $f$;
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
    'membership_id', '01a1a98a-ac40-7000-8000-00000000a500', 'gotrue_session_id', pg_temp.uid(1200), 'token_sha256', pg_temp.h32('t1'),
    'state', 'active', 'aal', 'aal1', 'refresh_token_enc', '\x01', 'access_token_enc', '\x01', 'enc_key_id', 'k1', 'access_expires_at', now() + interval '1 hour',
    'idle_timeout_minutes', 30, 'idle_expires_at', now() + interval '30 minutes', 'absolute_expires_at', now() + interval '11 hours', 'expires_at', now() + interval '12 hours',
    'created_by', pg_temp.sys(), 'updated_by', pg_temp.sys()) || p_over $$;

SELECT is(c.relforcerowsecurity, true, 'FORCE RLS on ' || t) FROM unnest(ARRAY['identity.sessions', 'identity.admin_notices', 'identity.support_sessions', 'identity.invitations',
  'identity.audit_exports', 'identity.auth_events', 'identity.tenant_settings', 'identity.platform_staff', 'identity.mfa_factors', 'core.users']) t JOIN pg_class c ON c.oid = t::regclass;

-- ===================================================================================================================================== fixtures (tenant A unless stated)
SELECT pg_temp.sysc(pg_temp.ta());
SELECT pg_temp.ins('identity.tenant_settings', jsonb_build_object('tenant_id', pg_temp.ta(), 'legal_name_snapshot', 'Synthetic Lab Alpha', 'display_name', 'Synthetic Lab Alpha', 'created_by', pg_temp.sys(), 'updated_by', pg_temp.sys()));
SELECT pg_temp.ins('identity.platform_staff', jsonb_build_object('id', pg_temp.uid(1), 'user_id', pg_temp.uid(101), 'email_normalized', 'platform.admin@synthetic.example', 'display_name', 'Synthetic Platform Admin',
  'role_code', 'platform_support', 'created_by', pg_temp.sys(), 'updated_by', pg_temp.sys()));
-- sessions: S1 due (expired yesterday), S2 not due
SELECT pg_temp.ins('identity.sessions', pg_temp.sess(jsonb_build_object('id', pg_temp.uid(1101), 'gotrue_session_id', pg_temp.uid(1201), 'token_sha256', pg_temp.h32('s1'), 'state', 'expired',
  'created_at', now() - interval '3 days', 'absolute_expires_at', now() - interval '2 days 12 hours', 'expires_at', now() - interval '1 day')));
SELECT pg_temp.ins('identity.sessions', pg_temp.sess(jsonb_build_object('id', pg_temp.uid(1102), 'gotrue_session_id', pg_temp.uid(1202), 'token_sha256', pg_temp.h32('s2'))));
-- admin notices: N1 due, N2 not due
SELECT pg_temp.ins('identity.admin_notices', jsonb_build_object('id', pg_temp.uid(1301), 'tenant_id', pg_temp.ta(), 'kind', 'audit_export_created', 'subject_type', 'audit_export', 'subject_id', pg_temp.uid(9),
  'expires_at', now() - interval '1 day', 'created_by', pg_temp.sys(), 'updated_by', pg_temp.sys()));
SELECT pg_temp.ins('identity.admin_notices', jsonb_build_object('id', pg_temp.uid(1302), 'tenant_id', pg_temp.ta(), 'kind', 'audit_export_created', 'subject_type', 'audit_export', 'subject_id', pg_temp.uid(9),
  'expires_at', now() + interval '1 day', 'created_by', pg_temp.sys(), 'updated_by', pg_temp.sys()));
-- support sessions: P1 active+due, P2 active+not due
SELECT pg_temp.ins('identity.support_sessions', jsonb_build_object('id', pg_temp.uid(1401), 'tenant_id', pg_temp.ta(), 'platform_staff_id', pg_temp.uid(1), 'scope', 'read_only', 'reason_text', 'Synthetic ticket investigation',
  'ticket_ref', 'SYN-1', 'duration_minutes', 30, 'status', 'active', 'started_at', now() - interval '2 hours', 'expires_at', now() - interval '1 hour', 'created_by', pg_temp.sys(), 'updated_by', pg_temp.sys()));
SELECT pg_temp.ins('identity.support_sessions', jsonb_build_object('id', pg_temp.uid(1402), 'tenant_id', pg_temp.ta(), 'platform_staff_id', pg_temp.uid(1), 'scope', 'read_only', 'reason_text', 'Synthetic ticket investigation',
  'ticket_ref', 'SYN-2', 'duration_minutes', 30, 'status', 'active', 'started_at', now(), 'expires_at', now() + interval '30 minutes', 'created_by', pg_temp.sys(), 'updated_by', pg_temp.sys()));
-- invitations: I1 sent+due (expires, email kept), I2 accepted 40 days ago with email (redacted), I3 sent+not due
SELECT pg_temp.ins('identity.invitations', jsonb_build_object('id', pg_temp.uid(1501), 'tenant_id', pg_temp.ta(), 'user_id', '01a1a98a-ac40-7000-8000-00000000a301', 'membership_id', '01a1a98a-ac40-7000-8000-00000000a501',
  'email', 'due@synthetic.example', 'status', 'sent', 'expires_at', now() - interval '1 hour', 'invited_by', pg_temp.sys(), 'created_by', pg_temp.sys(), 'updated_by', pg_temp.sys()));
SELECT pg_temp.ins('identity.invitations', jsonb_build_object('id', pg_temp.uid(1502), 'tenant_id', pg_temp.ta(), 'user_id', '01a1a98a-ac40-7000-8000-00000000a302', 'membership_id', '01a1a98a-ac40-7000-8000-00000000a502',
  'email', 'old@synthetic.example', 'status', 'accepted', 'expires_at', now() - interval '41 days', 'accepted_at', now() - interval '40 days', 'invited_by', pg_temp.sys(),
  'created_at', now() - interval '42 days', 'updated_at', now() - interval '40 days', 'created_by', pg_temp.sys(), 'updated_by', pg_temp.sys()));
SELECT pg_temp.ins('identity.invitations', jsonb_build_object('id', pg_temp.uid(1503), 'tenant_id', pg_temp.ta(), 'user_id', '01a1a98a-ac40-7000-8000-00000000a303', 'membership_id', '01a1a98a-ac40-7000-8000-00000000a503',
  'email', 'live@synthetic.example', 'status', 'sent', 'expires_at', now() + interval '3 days', 'invited_by', pg_temp.sys(), 'created_by', pg_temp.sys(), 'updated_by', pg_temp.sys()));
-- audit exports (§11 test 31)
CREATE FUNCTION pg_temp.exp(p_n int, p_status text, p_created interval, p_over jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('id', pg_temp.uid(1600 + p_n), 'tenant_id', pg_temp.ta(), 'requested_by_membership_id', '01a1a98a-ac40-7000-8000-00000000a500', 'source', 'audit_log', 'filters', '{}'::jsonb,
    'range_from', now() - p_created - interval '2 days', 'range_to', now() - p_created - interval '1 day', 'status', p_status, 'created_at', now() - p_created, 'updated_at', now() - p_created,
    'created_by', pg_temp.sys(), 'updated_by', pg_temp.sys()) || p_over $$;
SELECT pg_temp.ins('identity.audit_exports', pg_temp.exp(1, 'ready', interval '1 hour', jsonb_build_object('object_path', pg_temp.ta()::text || '/e1.csv', 'sha256', pg_temp.h32('e1'), 'expires_at', now() - interval '5 minutes')));
SELECT pg_temp.ins('identity.audit_exports', pg_temp.exp(2, 'expired', interval '400 days'));
SELECT pg_temp.ins('identity.audit_exports', pg_temp.exp(3, 'failed', interval '400 days'));
SELECT pg_temp.ins('identity.audit_exports', pg_temp.exp(4, 'expired', interval '100 days'));
SELECT pg_temp.ins('identity.audit_exports', pg_temp.exp(5, 'queued', interval '400 days'));
SELECT pg_temp.ins('identity.audit_exports', pg_temp.exp(6, 'ready', interval '400 days', jsonb_build_object('object_path', pg_temp.ta()::text || '/e6.csv', 'sha256', pg_temp.h32('e6'), 'expires_at', now() + interval '1 hour')));

-- ===================================================================================================================================== §11 test 24 (d): owner policies admit nothing without their GUC
-- §11 test 24(d): as lims_owner with no claims and app.maintenance unset, due rows are invisible; with the matching function name they are visible
SELECT is(pg_temp.v('lims_owner', NULL, 'SELECT (SELECT count(*) FROM identity.sessions)::text || ''|'' || (SELECT count(*) FROM identity.admin_notices) || ''|'' || (SELECT count(*) FROM identity.support_sessions) || ''|'' || (SELECT count(*) FROM identity.invitations) || ''|'' || (SELECT count(*) FROM identity.audit_exports) || ''|'' || (SELECT count(*) FROM identity.auth_events)'),
  '0|0|0|0|0|0', '-- §11 test 24(d) lims_owner without GUC sees 0 rows in sessions / admin_notices / support_sessions / invitations / audit_exports / auth_events');
SELECT is(pg_temp.v('lims_owner', NULL, $$SELECT set_config('app.maintenance', 'identity_purge_sessions', true) || '|' || (SELECT count(*) FROM identity.sessions WHERE expires_at < now()) || '|' || (SELECT count(*) FROM identity.admin_notices WHERE expires_at < now())$$),
  'identity_purge_sessions|1|1', 'with app.maintenance = identity_purge_sessions the due sessions and notices are visible');
SELECT is(pg_temp.v('lims_owner', NULL, $$SELECT set_config('app.maintenance', 'identity_expire_support_sessions', true) || '|' || (SELECT count(*) FROM identity.support_sessions WHERE expires_at < now())$$),
  'identity_expire_support_sessions|1', 'with app.maintenance = identity_expire_support_sessions the due support session is visible');
SELECT matches(pg_temp.v('lims_owner', NULL, $$SELECT set_config('app.maintenance', 'identity_expire_invitations', true) || '|' || (SELECT count(*) FROM identity.invitations)$$),
  '^identity_expire_invitations[|][1-9]', 'with app.maintenance = identity_expire_invitations the due and redactable invitations are visible');
SELECT is(pg_temp.v('lims_owner', NULL, $$SELECT set_config('app.maintenance', 'some_other_function', true) || '|' || (SELECT count(*) FROM identity.sessions) || '|' || (SELECT count(*) FROM identity.audit_exports)$$),
  'some_other_function|0|0', 'an unrelated app.maintenance value admits nothing');
-- §11 test 31: audit_exports__delete__owner_only admits nothing without the GUC
SELECT is(pg_temp.v('lims_owner', NULL, 'WITH d AS (DELETE FROM identity.audit_exports RETURNING 1) SELECT count(*)::text FROM d'), '0', '-- §11 test 31 audit_exports__delete__owner_only deletes nothing without app.maintenance');

-- ===================================================================================================================================== §11 test 22 / 31 / 33: maintenance functions as lims_worker, no claims
CREATE TEMP TABLE audit_before AS SELECT count(*)::int AS n FROM audit.audit_log;
-- identity_purge_sessions
SELECT is(pg_temp.v('lims_worker', NULL, 'SELECT app.identity_purge_sessions()::text'), '2', '-- §11 test 22 identity_purge_sessions returns the number of deleted sessions + notices (1 + 1)');
SELECT is((SELECT count(*)::int FROM identity.sessions WHERE id IN (pg_temp.uid(1101), pg_temp.uid(1102))), 1, 'identity_purge_sessions deleted exactly the due session');
SELECT is((SELECT count(*)::int FROM identity.sessions WHERE id = pg_temp.uid(1102)), 1, 'the not-due session survives');
SELECT is((SELECT count(*)::int FROM identity.admin_notices WHERE id IN (pg_temp.uid(1301), pg_temp.uid(1302))), 1, 'identity_purge_sessions deleted exactly the due notice');
SELECT is(pg_temp.v('lims_worker', NULL, $$SELECT coalesce(current_setting('app.maintenance', true), 'NULL')$$), '', 'app.maintenance is empty after identity_purge_sessions (08 A15.3)');
-- identity_expire_support_sessions (+ §11 test 33 audit)
SELECT is(pg_temp.v('lims_worker', NULL, 'SELECT app.identity_expire_support_sessions()::text'), '1', 'identity_expire_support_sessions returns 1');
SELECT is((SELECT status FROM identity.support_sessions WHERE id = pg_temp.uid(1401)), 'expired', 'the due support session is expired');
SELECT is((SELECT status FROM identity.support_sessions WHERE id = pg_temp.uid(1402)), 'active', 'the not-due support session is untouched');
SELECT is((SELECT count(*)::int FROM audit.audit_log WHERE detail ->> 'maintenance' = 'identity_expire_support_sessions' AND actor_type = 'system' AND actor_id IS NULL AND tenant_id = pg_temp.ta()), 1,
  '-- §11 test 33 one audit_log row (actor_type system, actor_id NULL, detail.maintenance = function name) per changed support session');
-- identity_expire_invitations
SELECT is(pg_temp.v('lims_worker', NULL, 'SELECT app.identity_expire_invitations()::text'), '2', 'identity_expire_invitations returns expired (I1) + redacted (I2) = 2');
SELECT is((SELECT status || '|' || coalesce(email, 'NULL') FROM identity.invitations WHERE id = pg_temp.uid(1501)), 'expired|due@synthetic.example', 'a row expired in this run keeps its email');
SELECT is((SELECT status || '|' || coalesce(email, 'NULL') FROM identity.invitations WHERE id = pg_temp.uid(1502)), 'accepted|NULL', 'a terminal row older than 30 days has its email cleared');
SELECT is((SELECT status FROM identity.invitations WHERE id = pg_temp.uid(1503)), 'sent', 'a live invitation is untouched');
SELECT is((SELECT count(*)::int FROM audit.audit_log WHERE detail ->> 'maintenance' = 'identity_expire_invitations' AND actor_type = 'system' AND actor_id IS NULL AND tenant_id = pg_temp.ta()), 2,
  '-- §11 test 33 one audit_log row per changed tenant invitation (I1 expired, I2 redacted)');
SELECT is(pg_temp.v('lims_worker', NULL, $$SELECT coalesce(current_setting('app.maintenance', true), 'NULL')$$), '', 'app.maintenance empty after identity_expire_invitations');
-- identity_expire_audit_exports (+ §11 test 31)
SELECT is(pg_temp.v('lims_worker', NULL, 'SELECT string_agg(object_path, '','') FROM app.identity_expire_audit_exports()'), pg_temp.ta()::text || '/e1.csv', 'identity_expire_audit_exports returns the object path of the export it expired');
SELECT is((SELECT status FROM identity.audit_exports WHERE id = pg_temp.uid(1601)), 'expired', 'the due ready export is now expired');
SELECT is((SELECT count(*)::int FROM identity.audit_exports WHERE id IN (pg_temp.uid(1602), pg_temp.uid(1603))), 0, '-- §11 test 31 expired and failed rows created more than 1 year ago are deleted');
SELECT is((SELECT count(*)::int FROM identity.audit_exports WHERE id IN (pg_temp.uid(1604), pg_temp.uid(1605), pg_temp.uid(1606))), 3, 'younger expired row and every queued/ready row are kept');
SELECT is(pg_temp.v('lims_worker', NULL, $$SELECT coalesce(current_setting('app.maintenance', true), 'NULL')$$), '', 'app.maintenance empty after identity_expire_audit_exports');
-- identity_purge_auth_events: tenant A retention 5 years (default), tenant B 7 years, tenant-less 5 years
SELECT pg_temp.sysc(pg_temp.tb());
SELECT pg_temp.ins('identity.tenant_settings', jsonb_build_object('tenant_id', pg_temp.tb(), 'legal_name_snapshot', 'Synthetic Lab Beta', 'display_name', 'Synthetic Lab Beta', 'retention_audit_years', 7, 'created_by', pg_temp.sys(), 'updated_by', pg_temp.sys()));
SELECT pg_temp.ins('identity.auth_events', jsonb_build_object('id', pg_temp.uid(1701), 'tenant_id', pg_temp.tb(), 'event_type', 'login_succeeded', 'occurred_at', now() - interval '6 years', 'created_at', now() - interval '6 years', 'created_by', pg_temp.sys()));
SELECT pg_temp.ins('identity.auth_events', jsonb_build_object('id', pg_temp.uid(1702), 'tenant_id', pg_temp.tb(), 'event_type', 'login_succeeded', 'occurred_at', now() - interval '8 years', 'created_at', now() - interval '8 years', 'created_by', pg_temp.sys()));
SELECT pg_temp.sysc(pg_temp.ta());
SELECT pg_temp.ins('identity.auth_events', jsonb_build_object('id', pg_temp.uid(1703), 'tenant_id', pg_temp.ta(), 'event_type', 'login_succeeded', 'occurred_at', now() - interval '6 years', 'created_at', now() - interval '6 years', 'created_by', pg_temp.sys()));
SELECT pg_temp.ins('identity.auth_events', jsonb_build_object('id', pg_temp.uid(1704), 'tenant_id', pg_temp.ta(), 'event_type', 'login_succeeded', 'occurred_at', now() - interval '1 year', 'created_at', now() - interval '1 year', 'created_by', pg_temp.sys()));
SELECT pg_temp.ins('identity.auth_events', jsonb_build_object('id', pg_temp.uid(1705), 'tenant_id', NULL, 'event_type', 'login_failed', 'occurred_at', now() - interval '6 years', 'created_at', now() - interval '6 years', 'created_by', pg_temp.sys()));
SELECT pg_temp.ins('identity.auth_events', jsonb_build_object('id', pg_temp.uid(1706), 'tenant_id', NULL, 'event_type', 'login_failed', 'occurred_at', now() - interval '4 years', 'created_at', now() - interval '4 years', 'created_by', pg_temp.sys()));
SELECT is(pg_temp.v('lims_worker', NULL, 'SELECT app.identity_purge_auth_events()::text'), '3', '-- §11 test 22 identity_purge_auth_events deletes A-6y, B-8y and tenant-less-6y (3 rows)');
SELECT is((SELECT array_agg(id ORDER BY id) FROM identity.auth_events WHERE id BETWEEN pg_temp.uid(1701) AND pg_temp.uid(1706)), ARRAY[pg_temp.uid(1701), pg_temp.uid(1704), pg_temp.uid(1706)],
  'kept: tenant-B 6-year row (B retains 7 y), tenant-A 1-year row, tenant-less 4-year row');
SELECT is(pg_temp.v('lims_worker', NULL, $$SELECT coalesce(current_setting('app.maintenance', true), 'NULL')$$), '', 'app.maintenance empty after identity_purge_auth_events');
-- the maintenance functions themselves are VOLATILE plpgsql DEFINERs that reset their GUC even on the empty path
SELECT is(pg_temp.v('lims_worker', NULL, 'SELECT app.identity_purge_sessions()::text'), '0', 'second identity_purge_sessions run finds nothing');
-- lims_api may not call a maintenance function
SELECT matches(pg_temp.v('lims_api', NULL, 'SELECT app.identity_purge_sessions()::text'), '^E42501', '-- §11 test 23 lims_api cannot execute a maintenance function (permission denied)');

-- ===================================================================================================================================== §11 test 28: identity_tenants_for_email_hmacs
CREATE TEMP TABLE u_h AS SELECT id, tenant_id FROM core.users WHERE tenant_id IN (pg_temp.ta(), pg_temp.tb()) ORDER BY tenant_id, id;
SELECT pg_temp.sysc(pg_temp.ta());
UPDATE core.users SET email_hmac = '\x1111111111111111111111111111111111111111111111111111111111111111' WHERE id = '01a1a98a-ac40-7000-8000-00000000a300';
UPDATE core.users SET email_hmac = '\x2222222222222222222222222222222222222222222222222222222222222222' WHERE id = '01a1a98a-ac40-7000-8000-00000000a301';
SELECT pg_temp.sysc(pg_temp.tb());
UPDATE core.users SET email_hmac = '\x3333333333333333333333333333333333333333333333333333333333333333' WHERE id = '01a1a98a-ac40-7000-8000-00000000b300';
SELECT pg_temp.sysc(pg_temp.ta());
SELECT is(c.relforcerowsecurity, true, 'FORCE RLS on core.users (asserted from pg_class)') FROM pg_class c WHERE c.oid = 'core.users'::regclass;
SELECT is(pg_temp.v('lims_worker', NULL, $$SELECT array_to_string(array_agg(t ORDER BY t), ',') FROM app.identity_tenants_for_email_hmacs(ARRAY['\x1111111111111111111111111111111111111111111111111111111111111111'::bytea,
  '\x2222222222222222222222222222222222222222222222222222222222222222'::bytea, '\x3333333333333333333333333333333333333333333333333333333333333333'::bytea,
  '\x4444444444444444444444444444444444444444444444444444444444444444'::bytea]) t$$), pg_temp.ta()::text || ',' || pg_temp.tb()::text, '-- §11 test 28 two users in A, one in B, one unknown HMAC -> {A, B}');
SELECT is(pg_temp.v('lims_worker', NULL, $$SELECT count(*)::text FROM app.identity_tenants_for_email_hmacs(ARRAY['\x4444444444444444444444444444444444444444444444444444444444444444'::bytea])$$), '0', 'unknown HMAC alone -> no tenant');
SELECT is(pg_temp.v('lims_worker', NULL, $$SELECT count(*)::text FROM app.identity_tenants_for_email_hmacs((SELECT array_agg(decode(lpad(to_hex(g), 64, '0'), 'hex')) FROM generate_series(1, 101) g))$$),
  'EP0001:identity_tenants_for_email_hmacs_invalid_input', '101 values -> P0001 identity_tenants_for_email_hmacs_invalid_input');
SELECT is(pg_temp.v('lims_worker', NULL, $$SELECT count(*)::text FROM app.identity_tenants_for_email_hmacs((SELECT array_agg(decode(lpad(to_hex(g), 64, '0'), 'hex')) FROM generate_series(1, 100) g))$$), '0', '100 values accepted');
SELECT is(pg_temp.v('lims_worker', NULL, $$SELECT coalesce(current_setting('app.maintenance', true), 'NULL')$$), '', 'app.maintenance is empty after identity_tenants_for_email_hmacs');
SELECT is(pg_temp.v('lims_worker', NULL, $$SELECT set_config('app.maintenance', 'identity_tenants_for_email_hmacs', true) || '|' || (SELECT count(*) FROM core.users)$$), 'identity_tenants_for_email_hmacs|0',
  'a lims_worker session setting app.maintenance itself sees 0 core.users rows');
SELECT matches(pg_temp.v('lims_api', NULL, $$SELECT count(*)::text FROM app.identity_tenants_for_email_hmacs(ARRAY['\x1111111111111111111111111111111111111111111111111111111111111111'::bytea])$$), '^E42501', 'lims_api: permission denied');
-- admin_notices subject check
SELECT is((SELECT count(*)::int FROM pg_constraint WHERE conrelid = 'identity.admin_notices'::regclass AND conname = 'admin_notices__subject__ck'), 1, 'admin_notices__subject__ck exists');
SELECT is((SELECT pg_get_constraintdef(oid) ~ 'login_ip_throttled' FROM pg_constraint WHERE conrelid = 'identity.admin_notices'::regclass AND conname = 'admin_notices__subject__ck'), true, 'subject_id may be NULL only for login_ip_throttled');
CREATE FUNCTION pg_temp.st(p_sql text) RETURNS text LANGUAGE plpgsql AS $f$ BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE; END $f$;
SELECT is(pg_temp.st(format($$SELECT pg_temp.ins('identity.admin_notices', %L::jsonb)$$, jsonb_build_object('id', pg_temp.uid(1801), 'tenant_id', pg_temp.ta(), 'kind', 'login_ip_throttled', 'subject_type', 'auth_event',
  'expires_at', now() + interval '1 day', 'created_by', pg_temp.sys(), 'updated_by', pg_temp.sys())::text)), 'ok', 'login_ip_throttled accepts subject_id NULL');
SELECT is(pg_temp.st(format($$SELECT pg_temp.ins('identity.admin_notices', %L::jsonb)$$, jsonb_build_object('id', pg_temp.uid(1802), 'tenant_id', pg_temp.ta(), 'kind', 'audit_export_created', 'subject_type', 'audit_export',
  'expires_at', now() + interval '1 day', 'created_by', pg_temp.sys(), 'updated_by', pg_temp.sys())::text)), '23514', 'every other kind rejects subject_id NULL');

-- ===================================================================================================================================== §11 test 35: identity_notify_ip_throttle_hmacs
SELECT pg_temp.ins('identity.auth_events', jsonb_build_object('id', pg_temp.uid(1901), 'tenant_id', NULL, 'event_type', 'login_failed', 'email_hmac', '\xaa01', 'client_ip', '192.0.2.10', 'occurred_at', now() - interval '1 hour', 'created_by', pg_temp.sys()));
SELECT pg_temp.ins('identity.auth_events', jsonb_build_object('id', pg_temp.uid(1902), 'tenant_id', NULL, 'event_type', 'login_failed', 'email_hmac', '\xaa01', 'client_ip', '192.0.2.10', 'occurred_at', now() - interval '50 minutes', 'created_by', pg_temp.sys()));
SELECT pg_temp.ins('identity.auth_events', jsonb_build_object('id', pg_temp.uid(1903), 'tenant_id', NULL, 'event_type', 'login_failed', 'email_hmac', '\xaa02', 'client_ip', '192.0.2.10', 'occurred_at', now() - interval '40 minutes', 'created_by', pg_temp.sys()));
SELECT pg_temp.ins('identity.auth_events', jsonb_build_object('id', pg_temp.uid(1904), 'tenant_id', NULL, 'event_type', 'login_failed', 'email_hmac', '\xbb01', 'client_ip', '192.0.2.99', 'occurred_at', now() - interval '30 minutes', 'created_by', pg_temp.sys()));
SELECT pg_temp.ins('identity.auth_events', jsonb_build_object('id', pg_temp.uid(1905), 'tenant_id', NULL, 'event_type', 'login_failed', 'email_hmac', '\xcc01', 'client_ip', '192.0.2.10', 'occurred_at', now() - interval '5 hours', 'created_by', pg_temp.sys()));
SELECT pg_temp.ins('identity.auth_events', jsonb_build_object('id', pg_temp.uid(1906), 'tenant_id', pg_temp.ta(), 'event_type', 'login_failed', 'email_hmac', '\xdd01', 'client_ip', '192.0.2.10', 'occurred_at', now() - interval '20 minutes', 'created_by', pg_temp.sys()));
SELECT is(pg_temp.v('lims_worker', NULL, $$SELECT string_agg(encode(h, 'hex'), ',' ORDER BY h) FROM app.identity_notify_ip_throttle_hmacs('192.0.2.10'::inet, now() - interval '2 hours') h$$), 'aa01,aa02',
  '-- §11 test 35 distinct tenant-less login_failed HMACs of that IP since p_since (not other IPs, not older events, not tenant rows)');
SELECT is(pg_temp.v('lims_worker', NULL, $$SELECT coalesce(current_setting('app.maintenance', true), 'NULL')$$), '', 'app.maintenance empty after identity_notify_ip_throttle_hmacs');
SELECT matches(pg_temp.v('lims_api', NULL, $$SELECT count(*)::text FROM app.identity_notify_ip_throttle_hmacs('192.0.2.10'::inet, now() - interval '2 hours')$$), '^E42501', 'lims_api: permission denied (lims_worker only)');
SELECT is(pg_temp.v('lims_worker', NULL, $$SELECT set_config('app.maintenance', 'identity_notify_ip_throttle_hmacs', true) || '|' || (SELECT count(*) FROM identity.auth_events)$$), 'identity_notify_ip_throttle_hmacs|0',
  'a worker setting the notify GUC itself sees 0 auth_events rows');

-- ===================================================================================================================================== breached-password import (G table, owner functions; §4.9)
SELECT is(pg_temp.v('lims_worker', NULL, $$SELECT app.identity_load_breached_batch(ARRAY[decode(repeat('01', 20), 'hex'), decode(repeat('02', 20), 'hex')], 'v1')::text$$), '2', 'load_breached_batch v1 inserts 2 hashes');
SELECT is(pg_temp.v('lims_worker', NULL, $$SELECT app.identity_load_breached_batch(ARRAY[decode(repeat('03', 20), 'hex')], 'v2')::text$$), '1', 'load_breached_batch v2 inserts 1 hash');
SELECT is(pg_temp.v('lims_app', NULL, $$SELECT app.identity_is_breached(decode(repeat('01', 20), 'hex'))::text$$), 'true', 'is_breached: known hash (lims_app holds SELECT on the G table)');
SELECT is(pg_temp.v('lims_app', NULL, $$SELECT app.identity_is_breached(decode(repeat('ff', 20), 'hex'))::text$$), 'false', 'is_breached: unknown hash');
SELECT is(pg_temp.v('lims_worker', NULL, $$SELECT app.identity_finish_breached_import('v2')::text$$), '2', 'finish_breached_import(v2) deletes the older list_version rows');
SELECT is(pg_temp.v('lims_app', NULL, $$SELECT app.identity_is_breached(decode(repeat('01', 20), 'hex'))::text$$), 'false', 'older list version is gone after finish');
SELECT is(pg_temp.v('lims_app', NULL, $$SELECT app.identity_is_breached(decode(repeat('03', 20), 'hex'))::text$$), 'true', 'current list version stays');
SELECT matches(pg_temp.v('lims_app', NULL, $$SELECT app.identity_load_breached_batch(ARRAY[decode(repeat('04', 20), 'hex')], 'v3')::text$$), '^E42501', 'lims_app cannot import the breached list');
SELECT matches(pg_temp.v('lims_app', NULL, $$INSERT INTO identity.g_breached_passwords (sha1, list_version) VALUES (decode(repeat('05', 20), 'hex'), 'v9')$$), '^E42501', 'lims_app cannot write the G table directly');

-- ===================================================================================================================================== §11 test 34: platform-staff auth DEFINERs (identityAuthTx claims, no tenant_id)
CREATE FUNCTION pg_temp.psess(p_over jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE sql AS $$
  SELECT pg_temp.sess(jsonb_build_object('id', pg_temp.uid(2101), 'tenant_id', NULL, 'kind', 'platform', 'user_id', pg_temp.uid(101), 'membership_id', NULL, 'platform_staff_id', pg_temp.uid(1),
    'gotrue_session_id', pg_temp.uid(2201), 'token_sha256', pg_temp.h32('p1'), 'state', 'mfa_pending', 'last_seen_at', now(), 'mfa_failed_attempts', 0, 'version', 1, 'created_at', now(), 'updated_at', now())) || p_over $$;
SELECT matches(pg_temp.v('lims_api', jsonb_build_object('sub', pg_temp.sys(), 'actor_type', 'system'), format($$WITH i AS (INSERT INTO identity.sessions SELECT * FROM jsonb_populate_record(NULL::identity.sessions, %L::jsonb) RETURNING 1) SELECT count(*)::text FROM i$$, pg_temp.psess()::text)),
  '^E42501', '-- §11 test 34 a direct INSERT of a platform session by the identity system actor is refused by RLS');
SELECT is(pg_temp.v('lims_api', jsonb_build_object('sub', pg_temp.sys(), 'actor_type', 'system'), format($$SELECT app.identity_platform_auth_write_session_insert(%L::uuid, %L::jsonb)::text$$, pg_temp.uid(101), pg_temp.psess()::text)),
  '', 'identity_platform_auth_write_session_insert inserts the platform session');
SELECT is((SELECT state FROM identity.sessions WHERE id = pg_temp.uid(2101)), 'mfa_pending', 'the platform session row exists');
SELECT is(pg_temp.v('lims_api', jsonb_build_object('sub', pg_temp.sys(), 'actor_type', 'system'), format($$SELECT app.identity_platform_auth_write_session_insert(%L::uuid, %L::jsonb)::text$$, pg_temp.uid(101),
  pg_temp.psess(jsonb_build_object('id', pg_temp.uid(2102), 'kind', 'tenant_staff'))::text)), 'EP0001:identity_platform_auth_write_invalid_input', 'session_insert refuses kind <> platform');
SELECT is(pg_temp.v('lims_api', jsonb_build_object('sub', pg_temp.sys(), 'actor_type', 'system'), format($$SELECT app.identity_platform_auth_write_session_insert(%L::uuid, %L::jsonb)::text$$, pg_temp.uid(101),
  pg_temp.psess(jsonb_build_object('id', pg_temp.uid(2103), 'tenant_id', pg_temp.ta()))::text)), 'EP0001:identity_platform_auth_write_invalid_input', 'session_insert refuses a row with a tenant_id');
SELECT is(pg_temp.v('lims_api', jsonb_build_object('sub', pg_temp.sys(), 'actor_type', 'system'), format($$SELECT app.identity_platform_auth_write_session_insert(%L::uuid, %L::jsonb)::text$$, pg_temp.uid(555),
  pg_temp.psess(jsonb_build_object('id', pg_temp.uid(2104)))::text)), 'EP0001:identity_platform_auth_write_invalid_input', 'session_insert refuses a row of another user');
SELECT is(pg_temp.v('lims_api', jsonb_build_object('sub', pg_temp.sys(), 'actor_type', 'system'), format($$SELECT app.identity_platform_auth_write_session_update(%L::uuid, %L::uuid, '{"state":"active","aal":"aal2","mfa_failed_attempts":1}'::jsonb)::text$$, pg_temp.uid(101), pg_temp.uid(2101))),
  '1', 'session_update changes state / aal / mfa_failed_attempts of the user''s platform session');
SELECT is((SELECT state || '|' || aal || '|' || mfa_failed_attempts::text FROM identity.sessions WHERE id = pg_temp.uid(2101)), 'active|aal2|1', 'the update landed');
SELECT is(pg_temp.v('lims_api', jsonb_build_object('sub', pg_temp.sys(), 'actor_type', 'system'), format($$SELECT app.identity_platform_auth_write_session_update(%L::uuid, %L::uuid, '{"state":"revoked"}'::jsonb)::text$$, pg_temp.uid(777), pg_temp.uid(2101))),
  '0', 'session_update returns 0 for another user''s session id');
SELECT is(pg_temp.v('lims_api', jsonb_build_object('sub', pg_temp.sys(), 'actor_type', 'system'), format($$SELECT app.identity_platform_auth_write_session_update(%L::uuid, %L::uuid, '{"tenant_id":"01a1a98a-ac40-7000-8000-00000000a001"}'::jsonb)::text$$, pg_temp.uid(101), pg_temp.uid(2101))),
  'EP0001:identity_platform_auth_write_invalid_input', 'session_update refuses an unlisted key (tenant_id)');
SELECT is(pg_temp.v('lims_api', jsonb_build_object('sub', pg_temp.sys(), 'actor_type', 'system'), format($$SELECT app.identity_platform_auth_write_session_update(%L::uuid, %L::uuid, '{"kind":"tenant_staff"}'::jsonb)::text$$, pg_temp.uid(101), pg_temp.uid(2101))),
  'EP0001:identity_platform_auth_write_invalid_input', 'session_update refuses an unlisted key (kind)');
SELECT is(pg_temp.v('lims_api', jsonb_build_object('sub', pg_temp.sys(), 'actor_type', 'system'), format($$SELECT app.identity_platform_auth_write_session_update(%L::uuid, %L::uuid, '{"state":"revoked"}'::jsonb)::text || '|' || coalesce(current_setting('app.pre_user_id', true), 'NULL')$$, pg_temp.uid(101), pg_temp.uid(2101))),
  '1|', 'app.pre_user_id is empty after session_update');
-- mfa factor
SELECT is(pg_temp.v('lims_api', jsonb_build_object('sub', pg_temp.sys(), 'actor_type', 'system'), format($$SELECT app.identity_platform_auth_write_mfa_factor(%L::uuid, NULL, %L::jsonb)::text$$, pg_temp.uid(101),
  jsonb_build_object('id', pg_temp.uid(2301), 'tenant_id', NULL, 'user_id', pg_temp.uid(101), 'gotrue_factor_id', pg_temp.uid(2401), 'factor_type', 'totp', 'status', 'unverified', 'is_active', true, 'version', 1,
    'created_at', now(), 'created_by', pg_temp.sys(), 'updated_at', now(), 'updated_by', pg_temp.sys())::text)), '1', 'mfa_factor insert: a tenant-less factor of the user');
SELECT is(pg_temp.v('lims_api', jsonb_build_object('sub', pg_temp.sys(), 'actor_type', 'system'), format($$SELECT app.identity_platform_auth_write_mfa_factor(%L::uuid, %L::uuid, '{"status":"verified","verified_at":"2026-11-07T00:00:00Z"}'::jsonb)::text$$, pg_temp.uid(101), pg_temp.uid(2301))),
  '1', 'mfa_factor update verifies the factor');
SELECT is((SELECT status FROM identity.mfa_factors WHERE id = pg_temp.uid(2301)), 'verified', 'the factor is verified');
SELECT is(pg_temp.v('lims_api', jsonb_build_object('sub', pg_temp.sys(), 'actor_type', 'system'), format($$SELECT app.identity_platform_auth_write_mfa_factor(%L::uuid, NULL, %L::jsonb)::text$$, pg_temp.uid(101),
  jsonb_build_object('id', pg_temp.uid(2302), 'tenant_id', pg_temp.ta(), 'user_id', pg_temp.uid(101), 'gotrue_factor_id', pg_temp.uid(2402), 'factor_type', 'totp', 'status', 'unverified', 'is_active', true, 'version', 1,
    'created_at', now(), 'created_by', pg_temp.sys(), 'updated_at', now(), 'updated_by', pg_temp.sys())::text)), 'EP0001:identity_platform_auth_write_invalid_input', 'mfa_factor refuses a row with a tenant_id');
-- invitation accept
SELECT pg_temp.sysc(pg_temp.ta());
SELECT pg_temp.ins('identity.invitations', jsonb_build_object('id', pg_temp.uid(2501), 'tenant_id', NULL, 'user_id', pg_temp.uid(101), 'platform_staff_id', pg_temp.uid(1), 'email', 'platform.admin@synthetic.example',
  'status', 'sent', 'expires_at', now() + interval '3 days', 'invited_by', pg_temp.sys(), 'created_by', pg_temp.sys(), 'updated_by', pg_temp.sys()));
SELECT pg_temp.ins('identity.invitations', jsonb_build_object('id', pg_temp.uid(2502), 'tenant_id', NULL, 'user_id', pg_temp.uid(101), 'platform_staff_id', pg_temp.uid(1), 'email', 'platform.admin@synthetic.example',
  'status', 'pending', 'expires_at', now() + interval '3 days', 'invited_by', pg_temp.sys(), 'created_by', pg_temp.sys(), 'updated_by', pg_temp.sys()));
SELECT is(pg_temp.v('lims_api', jsonb_build_object('sub', pg_temp.sys(), 'actor_type', 'system'), format($$SELECT app.identity_platform_auth_write_invitation_accept(%L::uuid, %L::uuid)::text$$, pg_temp.uid(101), pg_temp.uid(2502))), '0', 'invitation_accept: only a `sent` invitation is accepted (pending -> 0)');
SELECT is(pg_temp.v('lims_api', jsonb_build_object('sub', pg_temp.sys(), 'actor_type', 'system'), format($$SELECT app.identity_platform_auth_write_invitation_accept(%L::uuid, %L::uuid)::text$$, pg_temp.uid(999), pg_temp.uid(2501))), '0', 'invitation_accept: another user''s invitation -> 0');
SELECT is(pg_temp.v('lims_api', jsonb_build_object('sub', pg_temp.sys(), 'actor_type', 'system'), format($$SELECT app.identity_platform_auth_write_invitation_accept(%L::uuid, %L::uuid)::text$$, pg_temp.uid(101), pg_temp.uid(2501))), '1', 'invitation_accept: the user''s sent platform invitation is accepted');
SELECT is((SELECT status FROM identity.invitations WHERE id = pg_temp.uid(2501)), 'accepted', 'invitation status is accepted');
-- staff login
SELECT is(pg_temp.v('lims_api', jsonb_build_object('sub', pg_temp.sys(), 'actor_type', 'system'), format($$SELECT app.identity_platform_auth_write_staff_login(%L::uuid)::text$$, pg_temp.uid(101))), '1', 'staff_login updates the staff row');
SELECT is((SELECT last_login_at IS NOT NULL FROM identity.platform_staff WHERE id = pg_temp.uid(1)), true, 'platform_staff.last_login_at is set');
SELECT is(pg_temp.v('lims_api', jsonb_build_object('sub', pg_temp.sys(), 'actor_type', 'system'), format($$SELECT app.identity_platform_auth_write_staff_login(%L::uuid)::text || '|' || coalesce(current_setting('app.pre_user_id', true), 'NULL')$$, pg_temp.uid(101))), '1|', 'app.pre_user_id empty after staff_login');
-- a lims_api session that sets app.pre_user_id itself still cannot insert or update a platform session (owner policies are TO lims_owner)
SELECT matches(pg_temp.v('lims_api', jsonb_build_object('sub', pg_temp.sys(), 'actor_type', 'system'), format($$SELECT set_config('app.pre_user_id', %L, true) || '|' || (WITH i AS (INSERT INTO identity.sessions SELECT * FROM jsonb_populate_record(NULL::identity.sessions, %L::jsonb) RETURNING 1) SELECT count(*)::text FROM i)$$,
  pg_temp.uid(101)::text, pg_temp.psess(jsonb_build_object('id', pg_temp.uid(2105), 'gotrue_session_id', pg_temp.uid(2205), 'token_sha256', pg_temp.h32('p2')))::text)), '^E42501', 'lims_api setting app.pre_user_id itself cannot INSERT a platform session');
SELECT is(pg_temp.v('lims_api', jsonb_build_object('sub', pg_temp.sys(), 'actor_type', 'system'), format($$SELECT set_config('app.pre_user_id', %L, true) || '|' || (WITH u AS (UPDATE identity.sessions SET state = 'revoked' WHERE id = %L RETURNING 1) SELECT count(*)::text FROM u)$$,
  pg_temp.uid(101)::text, pg_temp.uid(2101)::text)), pg_temp.uid(101)::text || '|0', 'lims_api setting app.pre_user_id itself updates 0 platform sessions');

SELECT * FROM finish();
ROLLBACK;
