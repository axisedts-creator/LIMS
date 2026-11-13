-- C16.T-A3 live-DB assertions: engagement.accounts PRE_ACC policy under FORCE RLS (05-SCHEMA §5.2 table row "accounts", §5.3 PRE_ACC; 07-SECURITY E3 row "pre-auth claims reading data"; 02-TRD §4.1 step 3).
-- Probe: pre-auth claims cannot SELECT / INSERT / UPDATE another phone's account; an INSERT works only for the phone of the caller's OWN VERIFIED challenge.
-- Synthetic data only. One rolled-back transaction. RLS is never disabled for the assertions (the seed runs with session_replication_role = replica).
-- Run: pg_prove -d <migrated db with the engagement DDL of CR-C16-006> db/tests/engagement/T-A3_pre_acc.test.sql   (superuser; pgTAP in schema `extensions`; run from the repo root)
-- Needs a live Postgres with C0 + C16 migrations; it is NOT part of .orchestra/notes/T-A3-verify.cmd (no database in the unit-test environment).
-- Fails now: the migrated schema has no engagement.accounts PRE_ACC policy / engagement.otp_challenges (C16 DDL not merged into the test database).
BEGIN;
SET search_path = extensions, public, pg_catalog;
SELECT * FROM no_plan();
\ir ../fixtures/T0B-06_identity_standin.sql

CREATE FUNCTION pg_temp.id(k int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('01950c16-0000-7000-8000-' || lpad(to_hex(k), 12, '0'))::uuid $$;
CREATE FUNCTION pg_temp.h(k int) RETURNS bytea LANGUAGE sql IMMUTABLE AS $$ SELECT sha256(convert_to('synthetic-otp-token-a3-' || k, 'UTF8')) $$;
CREATE FUNCTION pg_temp.cl(p_type text, p_sub int, p_tenant int DEFAULT 1, p_hash int DEFAULT NULL) RETURNS text LANGUAGE sql AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object('actor_type', p_type, 'tenant_id', pg_temp.id(p_tenant), 'sub', pg_temp.id(p_sub),
         'patient_stage', CASE WHEN p_type = 'patient' THEN 'pre_auth' END, 'otp_token_sha256', encode(pg_temp.h(p_hash), 'hex')))::text $$;
-- run p_sql as p_role with p_claims. modes: v scalar text, n row count of a SELECT, w DML row count. Errors come back as 'E<SQLSTATE>:<message>'.
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
-- the verify request: lims_app, pre-auth patient claims of challenge p_chal carrying the token hash p_hash
CREATE FUNCTION pg_temp.pre(p_chal int, p_tenant int, p_hash int, p_sql text, p_mode text) RETURNS text LANGUAGE sql AS $$ SELECT pg_temp.x('lims_app', pg_temp.cl('patient', p_chal, p_tenant, p_hash), NULL, p_sql, p_mode) $$;
CREATE FUNCTION pg_temp.ins(p_tenant int, p_phone text, p_actor int) RETURNS text LANGUAGE sql AS $$
  SELECT format('INSERT INTO engagement.accounts (id, tenant_id, phone_e164, phone_hmac, created_by, updated_by) VALUES (gen_random_uuid(), %L, %L, sha256(%L), %L, %L)',
                pg_temp.id(p_tenant), p_phone, 'hmac' || p_phone, pg_temp.id(p_actor), pg_temp.id(p_actor)) $$;

-- ---------------------------------------------------------------- fixtures: tenants A, B; challenges: 201 verified (A, phone ...01), 202 sent (A, ...02), 203 verified (B, ...03), 204 verified (A, ...05, no account yet)
SET LOCAL session_replication_role = replica;
INSERT INTO core.tenants (id, tenant_code, legal_name, display_name, status, created_by, updated_by) VALUES
  (pg_temp.id(1), 'tpa_a', 'Lab A', 'Lab A', 'active', pg_temp.id(99), pg_temp.id(99)),
  (pg_temp.id(2), 'tpa_b', 'Lab B', 'Lab B', 'active', pg_temp.id(99), pg_temp.id(99));
INSERT INTO engagement.otp_challenges (id, tenant_id, token_sha256, phone_e164, phone_hmac, app_instance_id, app_platform, code_hmac, status, created_at, created_by, expires_at, updated_at) VALUES
  (pg_temp.id(201), pg_temp.id(1), pg_temp.h(11), '+99002000001', sha256('hmac+99002000001'), pg_temp.id(901), 'android', sha256('c1'), 'verified', now(), pg_temp.id(98), now() + interval '5 minutes', now()),
  (pg_temp.id(202), pg_temp.id(1), pg_temp.h(12), '+99002000002', sha256('hmac+99002000002'), pg_temp.id(902), 'android', sha256('c2'), 'sent',     now(), pg_temp.id(98), now() + interval '5 minutes', now()),
  (pg_temp.id(203), pg_temp.id(2), pg_temp.h(13), '+99002000003', sha256('hmac+99002000003'), pg_temp.id(903), 'ios',     sha256('c3'), 'verified', now(), pg_temp.id(98), now() + interval '5 minutes', now()),
  (pg_temp.id(204), pg_temp.id(1), pg_temp.h(14), '+99002000005', sha256('hmac+99002000005'), pg_temp.id(904), 'android', sha256('c4'), 'verified', now(), pg_temp.id(98), now() + interval '5 minutes', now());
INSERT INTO engagement.accounts (id, tenant_id, phone_e164, phone_hmac, created_by, updated_by) VALUES
  (pg_temp.id(301), pg_temp.id(1), '+99002000001', sha256('hmac+99002000001'), pg_temp.id(98), pg_temp.id(98)),
  (pg_temp.id(302), pg_temp.id(1), '+99002000002', sha256('hmac+99002000002'), pg_temp.id(98), pg_temp.id(98)),
  (pg_temp.id(303), pg_temp.id(1), '+99002000009', sha256('hmac+99002000009'), pg_temp.id(98), pg_temp.id(98)),
  (pg_temp.id(304), pg_temp.id(2), '+99002000003', sha256('hmac+99002000003'), pg_temp.id(98), pg_temp.id(98));
SET LOCAL session_replication_role = origin;

-- ---------------------------------------------------------------- SELECT: exactly the account of the verified challenge's phone
SELECT is(pg_temp.pre(201, 1, 11, 'SELECT * FROM engagement.accounts', 'n'), '1', 'claims of VERIFIED challenge 201 read exactly one account (tenant A has three)');
SELECT is(pg_temp.pre(201, 1, 11, 'SELECT id::text FROM engagement.accounts', 'v'), pg_temp.id(301)::text, 'and it is the account of the challenge''s own phone');
SELECT is(pg_temp.pre(201, 1, 11, 'SELECT * FROM engagement.accounts WHERE phone_e164 = ''+99002000002''', 'n'), '0', 'another phone of the same tenant: 0 rows (the probe of 06-PLAN T-A3)');
SELECT is(pg_temp.pre(201, 1, 11, 'SELECT * FROM engagement.accounts WHERE id = ' || quote_literal(pg_temp.id(303)::text), 'n'), '0', 'another account by id: 0 rows');
SELECT is(pg_temp.pre(202, 1, 12, 'SELECT * FROM engagement.accounts', 'n'), '0', 'claims of a challenge that is only `sent` (not yet verified): no account at all, not even its own phone''s');
SELECT is(pg_temp.pre(201, 1, NULL, 'SELECT * FROM engagement.accounts', 'n'), '0', 'pre-auth claims WITHOUT otp_token_sha256 (the t.<code> context): no account');
SELECT is(pg_temp.pre(201, 1, 13, 'SELECT * FROM engagement.accounts', 'n'), '0', 'tenant-A claims carrying the token hash of a tenant-B verified challenge: no account');
SELECT is(pg_temp.pre(203, 2, 13, 'SELECT id::text FROM engagement.accounts', 'v'), pg_temp.id(304)::text, 'tenant B''s verified challenge reads tenant B''s own account only');
SELECT is(pg_temp.pre(201, 1, 11, 'SELECT * FROM engagement.accounts WHERE tenant_id = ' || quote_literal(pg_temp.id(2)::text), 'n'), '0', 'cross-tenant account of the same phone family: 0 rows');

-- ---------------------------------------------------------------- INSERT: only the verified phone (WITH CHECK)
SELECT is(pg_temp.pre(204, 1, 14, pg_temp.ins(1, '+99002000005', 204), 'w'), '1', 'INSERT for the phone of the caller''s verified challenge works (first sign-in)');
SELECT like(pg_temp.pre(201, 1, 11, pg_temp.ins(1, '+99002000008', 201), 'w'), 'E42501:%', 'INSERT for ANOTHER phone is refused by WITH CHECK (42501)');
SELECT like(pg_temp.pre(202, 1, 12, pg_temp.ins(1, '+99002000002', 202), 'w'), 'E42501:%', 'INSERT for the phone of a challenge that is only `sent` is refused');
SELECT like(pg_temp.pre(201, 1, NULL, pg_temp.ins(1, '+99002000001', 201), 'w'), 'E42501:%', 'INSERT without otp_token_sha256 is refused');
SELECT like(pg_temp.pre(201, 1, 11, pg_temp.ins(2, '+99002000001', 201), 'w'), 'E42501:%', 'INSERT into ANOTHER tenant with the right phone is refused');

-- ---------------------------------------------------------------- UPDATE / DELETE
SELECT is(pg_temp.pre(201, 1, 11, 'UPDATE engagement.accounts SET last_app_platform = ''android'' WHERE phone_e164 = ''+99002000001''', 'w'), '1', 'the verify path may update the verified phone''s account (membership_id, last_login_at, last_app_*)');
SELECT is(pg_temp.pre(201, 1, 11, 'UPDATE engagement.accounts SET reminders_opt_out = true WHERE id = ' || quote_literal(pg_temp.id(302)::text), 'w'), '0', 'UPDATE of another phone''s account: 0 rows');
SELECT ok(pg_temp.pre(201, 1, 11, 'UPDATE engagement.accounts SET phone_e164 = ''+99002000002'', phone_hmac = sha256(''hmac+99002000002'') WHERE phone_e164 = ''+99002000001''', 'w') ~ '^(E42501|E23505):', 'moving the own account onto another phone is refused (WITH CHECK or unique)');
SELECT ok(pg_temp.pre(201, 1, 11, 'DELETE FROM engagement.accounts', 'w') IN ('0') OR pg_temp.pre(201, 1, 11, 'DELETE FROM engagement.accounts', 'w') LIKE 'E42501:%', 'pre-auth claims cannot delete accounts');
SELECT is((SELECT count(*)::int FROM engagement.accounts WHERE tenant_id = pg_temp.id(1)), 4, 'tenant A has its three seeded accounts plus the one legitimate first-sign-in insert (superuser view) after all probes');

SELECT * FROM finish();
ROLLBACK;
