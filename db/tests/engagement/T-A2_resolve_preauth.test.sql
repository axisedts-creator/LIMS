-- C16.T-A2 live-DB assertions: app.engagement_resolve_preauth(text, bytea) under FORCE RLS (05-SCHEMA §6.3, §6.6 test 4 (a)-(c), otp_challenges policies §5; 08 A12.1, A12.7, A5.5, R24; CR-C16-005/006).
-- Synthetic data only. One rolled-back transaction. RLS is never disabled for the assertions (the seed runs with session_replication_role = replica, as the isolation probes do).
-- Run: pg_prove -d <migrated db with the engagement DDL of CR-C16-006> db/tests/engagement/T-A2_resolve_preauth.test.sql   (superuser; pgTAP in schema `extensions`; run from the repo root)
-- Needs a live Postgres with C0 + C16 migrations; it is NOT part of .orchestra/notes/T-A2-verify.cmd (no database in the unit-test environment).
-- Fails now: engagement.otp_challenges and app.engagement_resolve_preauth do not exist in the migrated schema.
BEGIN;
SET search_path = extensions, public, pg_catalog;
SELECT * FROM no_plan();
\ir ../fixtures/T0B-06_identity_standin.sql

CREATE FUNCTION pg_temp.id(k int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('01950c16-0000-7000-8000-' || lpad(to_hex(k), 12, '0'))::uuid $$;
CREATE FUNCTION pg_temp.h(k int) RETURNS bytea LANGUAGE sql IMMUTABLE AS $$ SELECT sha256(convert_to('synthetic-otp-token-' || k, 'UTF8')) $$;
CREATE FUNCTION pg_temp.qh(k int) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT quote_literal('\x' || encode(pg_temp.h(k), 'hex')) || '::bytea' $$;
CREATE FUNCTION pg_temp.cl(p_type text, p_sub int, p_tenant int DEFAULT 1, p_hash int DEFAULT NULL) RETURNS text LANGUAGE sql AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object('actor_type', p_type, 'tenant_id', pg_temp.id(p_tenant), 'sub', pg_temp.id(p_sub),
         'patient_stage', CASE WHEN p_type = 'patient' THEN 'pre_auth' END, 'otp_token_sha256', encode(pg_temp.h(p_hash), 'hex')))::text $$;
-- run p_sql as p_role with p_claims; optional p_pre runs first in the same role/transaction (the "attacker" setting a GUC itself).
-- modes: v scalar text, n row count of a SELECT, w DML row count. Errors come back as 'E<SQLSTATE>:<message>'.
CREATE FUNCTION pg_temp.x(p_role text, p_claims text, p_pre text, p_sql text, p_mode text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE r text; n bigint;
BEGIN
  PERFORM set_config('request.jwt.claims', coalesce(p_claims, ''), true);
  EXECUTE format('SET LOCAL ROLE %I', p_role);
  BEGIN
    IF p_pre IS NOT NULL THEN EXECUTE p_pre; END IF;
    IF p_mode = 'v' THEN EXECUTE p_sql INTO r; r := coalesce(r, '<null>');
    ELSIF p_mode = 'n' THEN EXECUTE 'SELECT count(*) FROM (' || p_sql || ') t' INTO n; r := n::text;
    ELSE EXECUTE p_sql; GET DIAGNOSTICS n = ROW_COUNT; r := n::text; END IF;
  EXCEPTION WHEN OTHERS THEN r := 'E' || SQLSTATE || ':' || SQLERRM;
  END;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN r;
END $f$;
CREATE FUNCTION pg_temp.api(p_sql text, p_mode text DEFAULT 'v') RETURNS text LANGUAGE sql AS $$ SELECT pg_temp.x('lims_api', NULL, NULL, p_sql, p_mode) $$;

-- ---------------------------------------------------------------- fixtures: tenants A (tpa_a, active), B (tpa_b, active), S (tpa_s, suspended)
SET LOCAL session_replication_role = replica;
INSERT INTO core.tenants (id, tenant_code, legal_name, display_name, status, created_by, updated_by) VALUES
  (pg_temp.id(1), 'tpa_a', 'Lab A', 'Lab A', 'active', pg_temp.id(99), pg_temp.id(99)),
  (pg_temp.id(2), 'tpa_b', 'Lab B', 'Lab B', 'active', pg_temp.id(99), pg_temp.id(99)),
  (pg_temp.id(3), 'tpa_s', 'Lab S', 'Lab S', 'suspended', pg_temp.id(99), pg_temp.id(99));
-- challenges: 101 pending A, 102 sent B, 103 pending in the suspended tenant, 104 expired 2 h ago (still resolvable: expires_at > now() - 24 h), 105 expired 25 h ago (not resolvable)
INSERT INTO engagement.otp_challenges (id, tenant_id, token_sha256, phone_e164, phone_hmac, app_instance_id, app_platform, code_hmac, status, created_at, created_by, expires_at, updated_at) VALUES
  (pg_temp.id(101), pg_temp.id(1), pg_temp.h(1), '+99001000001', sha256('p1'), pg_temp.id(901), 'android', sha256('c1'), 'pending', now(),                      pg_temp.id(98), now() + interval '5 minutes', now()),
  (pg_temp.id(102), pg_temp.id(2), pg_temp.h(2), '+99001000002', sha256('p2'), pg_temp.id(902), 'ios',     sha256('c2'), 'sent',    now(),                      pg_temp.id(98), now() + interval '5 minutes', now()),
  (pg_temp.id(103), pg_temp.id(3), pg_temp.h(3), '+99001000003', sha256('p3'), pg_temp.id(903), 'android', sha256('c3'), 'pending', now(),                      pg_temp.id(98), now() + interval '5 minutes', now()),
  (pg_temp.id(104), pg_temp.id(1), pg_temp.h(4), '+99001000004', sha256('p4'), pg_temp.id(904), 'android', sha256('c4'), 'sent',    now() - interval '2 hours 5 minutes',  pg_temp.id(98), now() - interval '2 hours', now()),
  (pg_temp.id(105), pg_temp.id(1), pg_temp.h(5), '+99001000005', sha256('p5'), pg_temp.id(905), 'android', sha256('c5'), 'sent',    now() - interval '25 hours 5 minutes', pg_temp.id(98), now() - interval '25 hours', now());
SET LOCAL session_replication_role = origin;

-- ---------------------------------------------------------------- the function: owner, DEFINER, search_path, grants (05-SCHEMA §6.6 inventory row)
SELECT is((SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid = 'app.engagement_resolve_preauth(text,bytea)'::regprocedure), 'lims_owner', 'resolve_preauth is owned by lims_owner');
SELECT ok((SELECT prosecdef FROM pg_proc WHERE oid = 'app.engagement_resolve_preauth(text,bytea)'::regprocedure), 'resolve_preauth is SECURITY DEFINER');
SELECT ok((SELECT proconfig @> ARRAY['search_path='] FROM pg_proc WHERE oid = 'app.engagement_resolve_preauth(text,bytea)'::regprocedure), 'resolve_preauth pins search_path = ''''');
SELECT ok(has_function_privilege('lims_api', 'app.engagement_resolve_preauth(text,bytea)', 'EXECUTE'), 'lims_api may execute resolve_preauth');
SELECT ok(NOT has_function_privilege('lims_app', 'app.engagement_resolve_preauth(text,bytea)', 'EXECUTE'), 'lims_app may NOT execute resolve_preauth (only the anonymous pre-tenant transaction, lims_api)');
SELECT ok(NOT has_function_privilege('public', 'app.engagement_resolve_preauth(text,bytea)', 'EXECUTE'), 'PUBLIC may not execute resolve_preauth');
SELECT is((SELECT count(*)::int FROM pg_proc WHERE pronamespace = 'app'::regnamespace AND proname = 'engagement_resolve_preauth'), 1, 'exactly one overload (the old text-hash signature is gone, 08 R24)');
SELECT is((SELECT count(*)::int FROM pg_proc WHERE pronamespace = 'app'::regnamespace AND proname = 'engagement_resolve_tenant_code'), 0, 'app.engagement_resolve_tenant_code is removed (08 A19 D-121)');

-- ---------------------------------------------------------------- (a) returns the row for the presented hash; wrong tenant_code / suspended tenant / unknown / bad length -> no row
SELECT is(pg_temp.api('SELECT challenge_id::text || ''|'' || tenant_id::text FROM app.engagement_resolve_preauth(''tpa_a'', ' || pg_temp.qh(1) || ')'),
          pg_temp.id(101)::text || '|' || pg_temp.id(1)::text, 'live challenge of tenant A + its tenant code: challenge id and tenant id');
SELECT is(pg_temp.api('SELECT challenge_id::text || ''|'' || tenant_id::text FROM app.engagement_resolve_preauth(''tpa_b'', ' || pg_temp.qh(2) || ')'),
          pg_temp.id(102)::text || '|' || pg_temp.id(2)::text, 'a status=sent challenge of tenant B resolves to tenant B (tenant comes from the row)');
SELECT is(pg_temp.api('SELECT count(*) FROM app.engagement_resolve_preauth(''tpa_a'', ' || pg_temp.qh(4) || ')'), '1', 'expired 2 h ago: still resolvable (verify answers auth.otp_invalid itself, TRD §4.1 step 3)');
SELECT is(pg_temp.api('SELECT * FROM app.engagement_resolve_preauth(''tpa_a'', ' || pg_temp.qh(5) || ')', 'n'), '0', 'expired 25 h ago -> no row (expires_at > now() - 24 h)');
SELECT is(pg_temp.api('SELECT * FROM app.engagement_resolve_preauth(''tpa_b'', ' || pg_temp.qh(1) || ')', 'n'), '0', 'right token, WRONG tenant_code (tenant B for a tenant-A challenge) -> no row');
SELECT is(pg_temp.api('SELECT * FROM app.engagement_resolve_preauth(''tpa_a'', ' || pg_temp.qh(2) || ')', 'n'), '0', 'tenant-B token under tenant A''s code -> no row');
SELECT is(pg_temp.api('SELECT * FROM app.engagement_resolve_preauth(''tpa_s'', ' || pg_temp.qh(3) || ')', 'n'), '0', 'challenge of a suspended tenant -> no row');
SELECT is(pg_temp.api('SELECT * FROM app.engagement_resolve_preauth(''TPA_A'', ' || pg_temp.qh(1) || ')', 'n'), '0', 'tenant code is matched exactly (case-sensitive)');
SELECT is(pg_temp.api('SELECT * FROM app.engagement_resolve_preauth(''tpa_zzz'', ' || pg_temp.qh(1) || ')', 'n'), '0', 'unknown tenant code -> no row');
SELECT is(pg_temp.api('SELECT * FROM app.engagement_resolve_preauth(''tpa_a'', ' || pg_temp.qh(99) || ')', 'n'), '0', 'unknown hash -> no row');
SELECT is(pg_temp.api('SELECT * FROM app.engagement_resolve_preauth(''tpa_a'', NULL)', 'n'), '0', 'NULL hash -> no row');
SELECT is(pg_temp.api('SELECT * FROM app.engagement_resolve_preauth(NULL, ' || pg_temp.qh(1) || ')', 'n'), '0', 'NULL tenant code -> no row');
SELECT is(pg_temp.api('SELECT * FROM app.engagement_resolve_preauth(''tpa_a'', ''\x00''::bytea)', 'n'), '0', 'hash of the wrong length (1 byte) -> no row');
SELECT is(pg_temp.api('SELECT * FROM app.engagement_resolve_preauth(''tpa_a'', ''\x' || repeat('ab', 33) || '''::bytea)', 'n'), '0', 'hash of the wrong length (33 bytes) -> no row');
SELECT is(pg_temp.api('SELECT * FROM app.engagement_resolve_preauth(''tpa_a'', ''\x' || encode(pg_temp.h(1), 'hex') || '00''::bytea)', 'n'), '0', 'the right hash plus a trailing byte -> no row (no prefix matching)');
UPDATE core.tenants SET status = 'suspended' WHERE id = pg_temp.id(1);
SELECT is(pg_temp.api('SELECT * FROM app.engagement_resolve_preauth(''tpa_a'', ' || pg_temp.qh(1) || ')', 'n'), '0', 'the same credential stops resolving the moment its tenant is suspended');
UPDATE core.tenants SET status = 'active' WHERE id = pg_temp.id(1);

-- ---------------------------------------------------------------- (b) a lims_app / lims_api session that sets the GUC itself sees nothing (owner-only policies, FORCE RLS)
SELECT is(pg_temp.x('lims_api', NULL, 'SELECT set_config(''app.pre_engagement_otp_token_sha256'', encode(' || pg_temp.qh(1) || ', ''hex''), true)',
                    'SELECT * FROM engagement.otp_challenges', 'n'), '0', 'lims_api, no claims, own otp-token GUC set -> 0 rows of otp_challenges');
SELECT is(pg_temp.x('lims_app', NULL, 'SELECT set_config(''app.pre_engagement_otp_token_sha256'', encode(' || pg_temp.qh(1) || ', ''hex''), true)',
                    'SELECT * FROM engagement.otp_challenges', 'n'), '0', 'lims_app, no claims, own otp-token GUC set -> 0 rows of otp_challenges');
SELECT is(pg_temp.x('lims_app', pg_temp.cl('patient', 41), 'SELECT set_config(''app.pre_engagement_otp_token_sha256'', encode(' || pg_temp.qh(1) || ', ''hex''), true)',
                    'SELECT * FROM engagement.otp_challenges', 'n'), '0', 'lims_app, pre-auth patient claims WITHOUT otp_token_sha256, own GUC set -> 0 rows');
SELECT is(pg_temp.x('lims_app', NULL, 'SELECT set_config(''app.pre_tenant_id'', ' || quote_literal(pg_temp.id(1)::text) || ', true)', 'SELECT * FROM core.tenants', 'n'), '0',
          'lims_app, no claims, own app.pre_tenant_id set -> 0 rows of core.tenants');
SELECT is(pg_temp.x('lims_api', NULL, 'SELECT set_config(''app.pre_tenant_id'', ' || quote_literal(pg_temp.id(1)::text) || ', true)', 'SELECT * FROM core.tenants', 'n'), '0',
          'lims_api, no claims, own app.pre_tenant_id set -> 0 rows of core.tenants');
SELECT is(pg_temp.x('lims_api', NULL, 'SELECT set_config(''app.pre_engagement_otp_token_sha256'', encode(' || pg_temp.qh(1) || ', ''hex''), true)',
                    'UPDATE engagement.otp_challenges SET status = ''verified''', 'w'), '0', 'the own GUC does not allow a write either (0 rows updated)');

-- ---------------------------------------------------------------- (c) both GUCs are '' after return: hit, miss, wrong tenant code, suspended tenant, NULL
CREATE FUNCTION pg_temp.gucs_after(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE r text; g text; bad text := '';
BEGIN
  PERFORM set_config('app.pre_engagement_otp_token_sha256', '', true); PERFORM set_config('app.pre_tenant_id', '', true);
  r := pg_temp.api(p_sql);
  FOREACH g IN ARRAY ARRAY['app.pre_engagement_otp_token_sha256', 'app.pre_tenant_id'] LOOP
    IF coalesce(current_setting(g, true), '<unset>') <> '' THEN bad := bad || g || '=' || coalesce(current_setting(g, true), '<unset>') || ' '; END IF;
  END LOOP;
  RETURN CASE WHEN r LIKE 'E%' THEN r ELSE 'ok:' || bad END;
END $$;
SELECT is(pg_temp.gucs_after('SELECT count(*) FROM app.engagement_resolve_preauth(''tpa_a'', ' || pg_temp.qh(1) || ')'), 'ok:', 'GUCs empty after a hit');
SELECT is(pg_temp.gucs_after('SELECT count(*) FROM app.engagement_resolve_preauth(''tpa_a'', ' || pg_temp.qh(99) || ')'), 'ok:', 'GUCs empty after a miss');
SELECT is(pg_temp.gucs_after('SELECT count(*) FROM app.engagement_resolve_preauth(''tpa_b'', ' || pg_temp.qh(1) || ')'), 'ok:', 'GUCs empty after a wrong tenant code');
SELECT is(pg_temp.gucs_after('SELECT count(*) FROM app.engagement_resolve_preauth(''tpa_s'', ' || pg_temp.qh(3) || ')'), 'ok:', 'GUCs empty after a suspended tenant');
SELECT is(pg_temp.gucs_after('SELECT count(*) FROM app.engagement_resolve_preauth(''tpa_a'', NULL)'), 'ok:', 'GUCs empty after NULL');

-- ---------------------------------------------------------------- pre-auth policies of otp_challenges (05-SCHEMA §5): the caller's own challenge and nothing else
SELECT is(pg_temp.x('lims_app', pg_temp.cl('patient', 101, 1, 1), NULL, 'SELECT * FROM engagement.otp_challenges', 'n'), '1', 'pre-auth claims with otp_token_sha256 of challenge 101 read exactly that row');
SELECT is(pg_temp.x('lims_app', pg_temp.cl('patient', 101, 1, 2), NULL, 'SELECT * FROM engagement.otp_challenges', 'n'), '0', 'tenant-A claims carrying the hash of a tenant-B challenge read nothing');
SELECT is(pg_temp.x('lims_app', pg_temp.cl('patient', 101, 1, 1), NULL, 'UPDATE engagement.otp_challenges SET attempts = attempts + 1', 'w'), '1', 'the verify path may bump attempts of its own challenge');
SELECT is(pg_temp.x('lims_app', pg_temp.cl('patient', 101, 1, 1), NULL, 'DELETE FROM engagement.otp_challenges', 'w'), '0', 'a patient cannot delete challenges');
SELECT is(pg_temp.x('lims_app', pg_temp.cl('patient', 101, 1, NULL), NULL, 'SELECT * FROM engagement.otp_challenges', 'n'), '0', 'pre-auth claims WITHOUT otp_token_sha256 (the t.<code> context) read no challenge at all');
SELECT ok(pg_temp.x('lims_app', pg_temp.cl('patient', 101, 1, NULL), NULL,
          'INSERT INTO engagement.otp_challenges (id, tenant_id, token_sha256, phone_e164, phone_hmac, app_instance_id, app_platform, code_hmac, created_by, expires_at) VALUES (gen_random_uuid(), ' || quote_literal(pg_temp.id(1)::text) || ', ' || pg_temp.qh(60) || ', ''+99001000060'', sha256(''p60''), gen_random_uuid(), ''ios'', sha256(''c60''), gen_random_uuid(), now() + interval ''5 minutes'')', 'w') = '1',
          'the t.<code> context may INSERT a challenge of its own tenant (requestPatientOtp)');
SELECT ok(pg_temp.x('lims_app', pg_temp.cl('patient', 101, 1, NULL), NULL,
          'INSERT INTO engagement.otp_challenges (id, tenant_id, token_sha256, phone_e164, phone_hmac, app_instance_id, app_platform, code_hmac, created_by, expires_at) VALUES (gen_random_uuid(), ' || quote_literal(pg_temp.id(2)::text) || ', ' || pg_temp.qh(61) || ', ''+99001000061'', sha256(''p61''), gen_random_uuid(), ''ios'', sha256(''c61''), gen_random_uuid(), now() + interval ''5 minutes'')', 'w') ~ '^E',
          'the t.<code> context cannot INSERT a challenge for ANOTHER tenant (WITH CHECK)');
SELECT ok(pg_temp.x('lims_app', pg_temp.cl('patient', 101, 1, NULL), NULL,
          'INSERT INTO engagement.otp_challenges (id, tenant_id, token_sha256, phone_e164, phone_hmac, app_instance_id, app_platform, code_hmac, created_by, expires_at) VALUES (gen_random_uuid(), ' || quote_literal(pg_temp.id(1)::text) || ', ''\x00''::bytea, ''+99001000062'', sha256(''p62''), gen_random_uuid(), ''ios'', sha256(''c62''), gen_random_uuid(), now() + interval ''5 minutes'')', 'w') ~ '^E',
          'a 1-byte token hash is refused by otp_challenges__hashes__ck (08 A5.5)');
SELECT ok(pg_temp.x('lims_app', pg_temp.cl('patient', 101, 1, NULL), NULL,
          'INSERT INTO engagement.otp_challenges (id, tenant_id, token_sha256, phone_e164, phone_hmac, app_instance_id, app_platform, code_hmac, created_by, expires_at) VALUES (gen_random_uuid(), ' || quote_literal(pg_temp.id(1)::text) || ', ' || pg_temp.qh(63) || ', ''+99001000063'', sha256(''p63''), gen_random_uuid(), ''ios'', sha256(''c63''), gen_random_uuid(), now() + interval ''11 minutes'')', 'w') ~ '^E',
          'a challenge living > 10 minutes is refused by otp_challenges__ttl__ck (04 A9)');

-- ---------------------------------------------------------------- number_counters: the daily-cap key (CR-C16-006, 02-TRD §4.1 step 1)
SELECT lives_ok($$INSERT INTO engagement.number_counters (tenant_id, counter_key, last_value, expires_at) VALUES ('01950c16-0000-7000-8000-000000000001', 'otp_day:20260301', 1, now() + interval '2 days')$$,
                'counter_key otp_day:<yyyymmdd> satisfies number_counters__key__ck');
SELECT throws_ok($$INSERT INTO engagement.number_counters (tenant_id, counter_key, last_value, expires_at) VALUES ('01950c16-0000-7000-8000-000000000001', 'otp_day:2026-03-01', 1, now() + interval '2 days')$$,
                 '23514', NULL, 'a dashed date is refused by number_counters__key__ck');
SELECT throws_ok($$INSERT INTO engagement.number_counters (tenant_id, counter_key, last_value, expires_at) VALUES ('01950c16-0000-7000-8000-000000000001', 'otp_day:2026030', 1, now() + interval '2 days')$$,
                 '23514', NULL, 'a 7-digit day is refused by number_counters__key__ck');

SELECT * FROM finish();
ROLLBACK;
