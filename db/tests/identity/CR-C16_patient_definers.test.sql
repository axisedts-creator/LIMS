-- CR-C16 (draft, AUTH-SENSITIVE) live-DB assertions for 20261117000000_identity__patient_provision_and_session_definers.sql:
--   app.identity_patient_create_membership(p_account_id) and app.identity_patient_open_session(p_row jsonb), plus their three owner-only INSERT policies.
-- Needs the migrated database with the seeds (tenant_a = 01a1a98a-ac40-7000-8000-00000000a001, tenant_b = ...b001). Synthetic data only; RLS is never disabled.
-- Run: pg_prove -d <migrated+seeded db> db/tests/identity/CR-C16_patient_definers.test.sql   (superuser; pgTAP in schema `extensions`; from the repo root)
BEGIN;
SET search_path = extensions, public, pg_catalog;
SELECT * FROM no_plan();

CREATE FUNCTION pg_temp.ta() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1a98a-ac40-7000-8000-00000000a001'::uuid $$;
CREATE FUNCTION pg_temp.tb() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1a98a-ac40-7000-8000-00000000b001'::uuid $$;
CREATE FUNCTION pg_temp.ch(k int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('01900000-0000-7000-8000-' || lpad(to_hex(k), 12, '0'))::uuid $$;
-- claims of a verified OTP challenge (core/resolver: sub = challenge id, patient_stage = pre_auth) for tenant t
CREATE FUNCTION pg_temp.pre(t uuid, k int) RETURNS text LANGUAGE sql AS $$
  SELECT jsonb_build_object('sub', pg_temp.ch(k), 'actor_type', 'patient', 'tenant_id', t, 'patient_stage', 'pre_auth')::text $$;
-- run p_sql as p_role with p_claims; returns the scalar as text, or 'E<SQLSTATE>:<message>' on error
CREATE FUNCTION pg_temp.x(p_role text, p_claims text, p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE r text;
BEGIN
  PERFORM set_config('request.jwt.claims', coalesce(p_claims, ''), true);
  EXECUTE format('SET LOCAL ROLE %I', p_role);
  BEGIN
    EXECUTE p_sql INTO r; r := coalesce(r, '<null>');
  EXCEPTION WHEN OTHERS THEN r := 'E' || SQLSTATE || ':' || SQLERRM;
  END;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN r;
END $f$;

-- ------------------------------------------------------------------ catalog
SELECT has_function('app', 'identity_patient_create_membership', ARRAY['uuid'], 'provision function exists');
SELECT has_function('app', 'identity_patient_open_session', ARRAY['jsonb'], 'open-session function exists');
SELECT is((SELECT prosecdef FROM pg_proc WHERE oid = 'app.identity_patient_create_membership(uuid)'::regprocedure), true, 'provision is SECURITY DEFINER');
SELECT is((SELECT prosecdef FROM pg_proc WHERE oid = 'app.identity_patient_open_session(jsonb)'::regprocedure), true, 'open-session is SECURITY DEFINER');
SELECT is((SELECT proowner::regrole::text FROM pg_proc WHERE oid = 'app.identity_patient_create_membership(uuid)'::regprocedure), 'lims_owner', 'provision owned by lims_owner');
SELECT is((SELECT proconfig FROM pg_proc WHERE oid = 'app.identity_patient_open_session(jsonb)'::regprocedure), ARRAY['search_path=""'], 'open-session pins search_path = ""');
SELECT is(has_function_privilege('lims_api', 'app.identity_patient_create_membership(uuid)', 'EXECUTE'), true, 'lims_api may EXECUTE provision');
SELECT is(has_function_privilege('lims_api', 'app.identity_patient_open_session(jsonb)', 'EXECUTE'), true, 'lims_api may EXECUTE open-session');
SELECT is(has_function_privilege('lims_app', 'app.identity_patient_create_membership(uuid)', 'EXECUTE'), false, 'lims_app may not EXECUTE provision');
SELECT is(has_function_privilege('lims_worker', 'app.identity_patient_open_session(jsonb)', 'EXECUTE'), false, 'lims_worker may not EXECUTE open-session');
SELECT is(has_function_privilege('public', 'app.identity_patient_open_session(jsonb)', 'EXECUTE'), false, 'PUBLIC may not EXECUTE open-session');
SELECT is(has_function_privilege('lims_api', 'app.identity_patient_membership(uuid)', 'EXECUTE'), true, 'lims_api may EXECUTE the membership read');
SELECT is(has_function_privilege('lims_app', 'app.identity_patient_membership(uuid)', 'EXECUTE'), false, 'lims_app may not EXECUTE the membership read');

-- ------------------------------------------------------------------ provision: happy path + idempotence
SELECT matches(pg_temp.x('lims_api', pg_temp.pre(pg_temp.ta(), 1), format('SELECT membership_id::text FROM app.identity_patient_create_membership(%L)', pg_temp.ch(1))),
  '^01900000-0000-7000-8000-000000000001$', 'provision returns membership id = account id');
SELECT is((SELECT count(*)::int FROM core.memberships WHERE tenant_id = pg_temp.ta() AND id = pg_temp.ch(1) AND actor_type = 'patient' AND status = 'active'), 1, 'one active patient membership row');
SELECT is((SELECT count(*)::int FROM core.users u JOIN core.memberships m ON m.tenant_id = u.tenant_id AND m.user_id = u.id
            WHERE m.id = pg_temp.ch(1) AND u.tenant_id = pg_temp.ta() AND u.phone_e164 IS NULL AND u.email_normalized IS NULL), 1, 'one user row, no phone and no e-mail');
SELECT is(pg_temp.x('lims_api', pg_temp.pre(pg_temp.ta(), 1), format('SELECT count(*)::text FROM app.identity_patient_create_membership(%L)', pg_temp.ch(1))), '1', 'repeat call returns the existing membership');
SELECT is((SELECT count(*)::int FROM core.memberships WHERE id = pg_temp.ch(1)), 1, 'repeat call creates no second membership');
SELECT is((SELECT count(*)::int FROM core.users u JOIN core.memberships m ON m.tenant_id = u.tenant_id AND m.user_id = u.id WHERE m.id = pg_temp.ch(1)), 1, 'repeat call creates no second user');
SELECT is(current_setting('app.maintenance', true), '', 'app.maintenance is cleared after provision');

-- ------------------------------------------------------------------ membership read
SELECT is(pg_temp.x('lims_api', pg_temp.pre(pg_temp.ta(), 1), format('SELECT status || '':'' || locked::text FROM app.identity_patient_membership(%L)', pg_temp.ch(1))), 'active:false', 'the membership read returns status and locked');
SELECT is(pg_temp.x('lims_api', pg_temp.pre(pg_temp.ta(), 1), format('SELECT count(*)::text FROM app.identity_patient_membership(%L)', pg_temp.ch(555))), '0', 'unknown membership: no row');
SELECT is(pg_temp.x('lims_api', pg_temp.pre(pg_temp.tb(), 1), format('SELECT count(*)::text FROM app.identity_patient_membership(%L)', pg_temp.ch(1))), '0', 'another tenant cannot read it');
SELECT matches(pg_temp.x('lims_api', jsonb_build_object('sub', pg_temp.ch(1), 'actor_type', 'patient', 'tenant_id', pg_temp.ta())::text,
  format('SELECT count(*)::text FROM app.identity_patient_membership(%L)', pg_temp.ch(1))), '^EP0001:identity_patient_membership_invalid_input', 'outside pre-auth: refused');

-- ------------------------------------------------------------------ provision: refusals (all P0001, nothing written)
SELECT matches(pg_temp.x('lims_api', pg_temp.pre(pg_temp.ta(), 2), format('SELECT membership_id::text FROM app.identity_patient_create_membership(%L)', pg_temp.ch(3))),
  '^EP0001:identity_patient_provision_invalid_input', 'account id must equal the verified challenge id');
SELECT matches(pg_temp.x('lims_api', jsonb_build_object('sub', pg_temp.ch(4), 'actor_type', 'patient', 'tenant_id', pg_temp.ta())::text,
  format('SELECT membership_id::text FROM app.identity_patient_create_membership(%L)', pg_temp.ch(4))),
  '^EP0001:identity_patient_provision_invalid_input', 'a patient session (no patient_stage) cannot provision');
SELECT matches(pg_temp.x('lims_api', jsonb_build_object('sub', pg_temp.ch(5), 'actor_type', 'user', 'tenant_id', pg_temp.ta(), 'patient_stage', 'pre_auth')::text,
  format('SELECT membership_id::text FROM app.identity_patient_create_membership(%L)', pg_temp.ch(5))),
  '^EP0001:identity_patient_provision_invalid_input', 'a non-patient actor cannot provision');
SELECT matches(pg_temp.x('lims_api', jsonb_build_object('sub', pg_temp.ch(6), 'actor_type', 'patient', 'patient_stage', 'pre_auth')::text,
  format('SELECT membership_id::text FROM app.identity_patient_create_membership(%L)', pg_temp.ch(6))),
  '^EP0001:identity_patient_provision_invalid_input', 'no tenant in the claims: refused');
SELECT matches(pg_temp.x('lims_api', NULL, format('SELECT membership_id::text FROM app.identity_patient_create_membership(%L)', pg_temp.ch(7))),
  '^EP0001:identity_patient_provision_invalid_input', 'no claims at all: refused');
SELECT is((SELECT count(*)::int FROM core.memberships WHERE id IN (pg_temp.ch(2), pg_temp.ch(3), pg_temp.ch(4), pg_temp.ch(5), pg_temp.ch(6), pg_temp.ch(7))), 0, 'no refused call wrote a membership');

-- ------------------------------------------------------------------ the policies do not open direct writes
SELECT matches(pg_temp.x('lims_api', pg_temp.pre(pg_temp.ta(), 1),
  format('INSERT INTO core.users (tenant_id, id, display_name, created_by, updated_by) VALUES (%L, %L, ''x'', %L, %L) RETURNING 1', pg_temp.ta(), pg_temp.ch(8), pg_temp.ch(1), pg_temp.ch(1))),
  '^E', 'lims_api cannot insert a user directly (RLS)');
SELECT matches(pg_temp.x('lims_api', pg_temp.pre(pg_temp.ta(), 1),
  format('SELECT set_config(''app.maintenance'', ''identity_patient_provision'', true)::text || (SELECT 1 FROM (INSERT INTO core.users (tenant_id, id, display_name, created_by, updated_by) VALUES (%L, %L, ''x'', %L, %L) RETURNING 1) i)', pg_temp.ta(), pg_temp.ch(9), pg_temp.ch(1), pg_temp.ch(1))),
  '^E', 'setting app.maintenance as lims_api does not help (the policy is TO lims_owner)');
SELECT is((SELECT count(*)::int FROM core.users WHERE id IN (pg_temp.ch(8), pg_temp.ch(9))), 0, 'no direct user insert got through');

-- ------------------------------------------------------------------ open session
CREATE FUNCTION pg_temp.srow(k int, over jsonb DEFAULT '{}'::jsonb) RETURNS text LANGUAGE sql AS $$
  SELECT (jsonb_build_object(
    'id', pg_temp.ch(100 + k), 'tenant_id', pg_temp.ta(), 'kind', 'patient',
    'user_id', (SELECT user_id FROM core.memberships WHERE id = pg_temp.ch(1)), 'membership_id', pg_temp.ch(1),
    'token_sha256', '\x' || lpad(to_hex(k), 64, '0'), 'state', 'active', 'aal', 'aal1',
    'access_expires_at', now() + interval '1 hour', 'idle_timeout_minutes', 1440, 'idle_expires_at', now() + interval '1 day',
    'absolute_expires_at', now() + interval '30 days', 'expires_at', now() + interval '30 days',
    'app_instance_id', pg_temp.ch(200 + k), 'app_platform', 'android', 'created_by', pg_temp.ch(1), 'updated_by', pg_temp.ch(1)) || over)::text $$;
CREATE FUNCTION pg_temp.open(k int, over jsonb DEFAULT '{}'::jsonb, claims text DEFAULT NULL) RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.x('lims_api', coalesce(claims, pg_temp.pre(pg_temp.ta(), 1)),
    format('SELECT app.identity_patient_open_session(%L::jsonb)::text', pg_temp.srow(k, over))) $$;

SELECT is(pg_temp.open(1), '', 'open-session inserts a valid patient session (void result)');
SELECT is((SELECT count(*)::int FROM identity.sessions WHERE id = pg_temp.ch(101) AND kind = 'patient' AND tenant_id = pg_temp.ta() AND membership_id = pg_temp.ch(1) AND state = 'active' AND aal = 'aal1'), 1, 'the session row exists with the patient shape');
SELECT is((SELECT enc_key_id FROM identity.sessions WHERE id = pg_temp.ch(101)), 'patient-no-gotrue', 'GoTrue placeholders are set by the function');
SELECT is((SELECT gotrue_session_id FROM identity.sessions WHERE id = pg_temp.ch(101)), pg_temp.ch(101), 'gotrue_session_id = the session id (the resolver looks sessions up by the JWT session_id claim)');
SELECT is((SELECT count(*)::int FROM app.identity_resolve_session(pg_temp.ch(101), (SELECT user_id FROM core.memberships WHERE id = pg_temp.ch(1)))), 1, 'identity_resolve_session finds the patient session by the JWT claims (session_id, sub)');
SELECT is((SELECT count(*)::int FROM identity.sessions WHERE id = pg_temp.ch(101) AND octet_length(refresh_token_enc) = 0 AND octet_length(access_token_enc) = 0), 1, 'encrypted-token placeholders are empty');
SELECT is(current_setting('app.maintenance', true), '', 'app.maintenance is cleared after open-session');

SELECT matches(pg_temp.open(2, '{"kind":"tenant_staff"}'), '^EP0001:identity_patient_open_session_invalid_input', 'a non-patient kind is refused');
SELECT matches(pg_temp.open(3, jsonb_build_object('tenant_id', pg_temp.tb())), '^EP0001:identity_patient_open_session_invalid_input', 'another tenant is refused');
SELECT matches(pg_temp.open(4, '{"state":"revoked"}'), '^EP0001:identity_patient_open_session_invalid_input', 'a non-active state is refused');
SELECT matches(pg_temp.open(5, '{"aal":"aal2"}'), '^EP0001:identity_patient_open_session_invalid_input', 'aal2 is refused');
SELECT matches(pg_temp.open(6, jsonb_build_object('user_id', pg_temp.ch(300))), '^EP0001:identity_patient_open_session_invalid_input', 'a user that is not the membership user is refused');
SELECT matches(pg_temp.open(7, jsonb_build_object('membership_id', pg_temp.ch(301))), '^EP0001:identity_patient_open_session_invalid_input', 'an unknown membership is refused');
SELECT matches(pg_temp.open(8, '{}', jsonb_build_object('sub', pg_temp.ch(1), 'actor_type', 'patient', 'tenant_id', pg_temp.ta())::text), '^EP0001:identity_patient_open_session_invalid_input', 'outside pre-auth (no patient_stage) is refused');
SELECT matches(pg_temp.open(9, '{}', jsonb_build_object('sub', pg_temp.ch(1), 'actor_type', 'user', 'tenant_id', pg_temp.ta(), 'patient_stage', 'pre_auth')::text), '^EP0001:identity_patient_open_session_invalid_input', 'a non-patient actor is refused');
SELECT is((SELECT count(*)::int FROM identity.sessions WHERE id IN (pg_temp.ch(102), pg_temp.ch(103), pg_temp.ch(104), pg_temp.ch(105), pg_temp.ch(106), pg_temp.ch(107), pg_temp.ch(108), pg_temp.ch(109))), 0, 'no refused call wrote a session');

-- a deactivated membership cannot open a session
SELECT set_config('request.jwt.claims', jsonb_build_object('sub', pg_temp.ch(1), 'actor_type', 'system', 'tenant_id', pg_temp.ta())::text, true);   -- the audit trigger needs a claims sub and tenant
UPDATE core.memberships SET status = 'deactivated', deactivated_at = now(), deactivated_by = pg_temp.ch(1) WHERE id = pg_temp.ch(1);
SELECT set_config('request.jwt.claims', '', true);
SELECT matches(pg_temp.open(10), '^EP0001:identity_patient_open_session_invalid_input', 'a deactivated membership is refused');

SELECT * FROM finish();
ROLLBACK;
