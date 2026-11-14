-- T9-A38: platform-staff set-password DEFINERs (08 A38-1 / LD-99, C2-T9). Real identity schema + seeds; superuser; one rolled-back transaction.
--   app.identity_platform_auth_write_revoke_other_sessions(p_user_id uuid, p_except_session_id uuid, p_reason text) RETURNS uuid[]
--   app.identity_platform_auth_write_invitation_accept_by_user(p_user_id uuid) RETURNS integer
-- Each is called as lims_api with the identity system-actor claims and NO tenant (what ctx.db.identityAuthTx sends). FORCE RLS is never disabled.
-- Run from the repo root: pg_prove -d <migrated db with seeds> db/tests/identity/T9-A38_platform_set_password.test.sql
-- Expected before the writer adds the two functions: every function assertion fails with "function ... does not exist" (42883).
BEGIN;
SET search_path = extensions, public, pg_catalog;
SELECT * FROM no_plan();

CREATE FUNCTION pg_temp.ta() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1a98a-ac40-7000-8000-00000000a001'::uuid $$;
CREATE FUNCTION pg_temp.sys() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1b34e-1000-7eee-9d29-d7ca59a102b5'::uuid $$;
CREATE FUNCTION pg_temp.uid(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('0190c900-0000-7000-8000-' || lpad(n::text, 12, '0'))::uuid $$;
CREATE FUNCTION pg_temp.h32(s text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT '\x' || encode(sha256(convert_to(s, 'UTF8')), 'hex') $$;
CREATE FUNCTION pg_temp.sysclaims() RETURNS jsonb LANGUAGE sql AS $$ SELECT jsonb_build_object('sub', pg_temp.sys(), 'actor_type', 'system') $$;
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
-- DML as lims_api (system claims, no tenant): row count, or 'E<sqlstate>:<message>'
CREATE FUNCTION pg_temp.w(p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE r text; n bigint; saved text := current_setting('request.jwt.claims', true);
BEGIN
  PERFORM set_config('request.jwt.claims', pg_temp.sysclaims()::text, true);
  EXECUTE 'SET LOCAL ROLE lims_api';
  BEGIN EXECUTE p_sql; GET DIAGNOSTICS n = ROW_COUNT; r := n::text; EXCEPTION WHEN OTHERS THEN r := 'E' || SQLSTATE || ':' || SQLERRM; END;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', coalesce(saved, ''), true);
  RETURN r;
END $f$;
CREATE FUNCTION pg_temp.rev(p_user uuid, p_except uuid, p_reason text) RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.v('lims_api', pg_temp.sysclaims(),
    format($q$SELECT coalesce((SELECT array_agg(x ORDER BY x)::text FROM unnest(app.identity_platform_auth_write_revoke_other_sessions(%L::uuid, %L::uuid, %L)) x), '{}')$q$, p_user, p_except, p_reason)) $$;
CREATE FUNCTION pg_temp.acc(p_user uuid) RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.v('lims_api', pg_temp.sysclaims(), format('SELECT app.identity_platform_auth_write_invitation_accept_by_user(%L::uuid)::text', p_user)) $$;
CREATE FUNCTION pg_temp.sess(p_over jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('id', pg_temp.uid(1300), 'tenant_id', NULL, 'kind', 'platform', 'user_id', pg_temp.uid(101), 'membership_id', NULL, 'platform_staff_id', pg_temp.uid(1),
    'gotrue_session_id', pg_temp.uid(1400), 'token_sha256', pg_temp.h32('t0'), 'state', 'active', 'aal', 'aal2', 'refresh_token_enc', '\x01', 'access_token_enc', '\x01', 'enc_key_id', 'k1',
    'access_expires_at', now() + interval '1 hour', 'idle_timeout_minutes', 30, 'idle_expires_at', now() + interval '30 minutes', 'absolute_expires_at', now() + interval '11 hours',
    'expires_at', now() + interval '12 hours', 'created_by', pg_temp.sys(), 'updated_by', pg_temp.sys()) || p_over $$;
-- session n of user u (platform staff s unless a tenant override is given)
CREATE FUNCTION pg_temp.ps(n int, u int, st text, p_over jsonb DEFAULT '{}') RETURNS void LANGUAGE sql AS $$
  SELECT pg_temp.ins('identity.sessions', pg_temp.sess(jsonb_build_object('id', pg_temp.uid(1300 + n), 'user_id', pg_temp.uid(u), 'platform_staff_id', pg_temp.uid(u - 100),
    'gotrue_session_id', pg_temp.uid(1400 + n), 'token_sha256', pg_temp.h32('t' || n), 'state', st) || p_over)) $$;
CREATE FUNCTION pg_temp.inv(n int, u int, st text, p_over jsonb DEFAULT '{}') RETURNS void LANGUAGE sql AS $$
  SELECT pg_temp.ins('identity.invitations', jsonb_build_object('id', pg_temp.uid(1500 + n), 'tenant_id', NULL, 'user_id', pg_temp.uid(u), 'membership_id', NULL,
    'platform_staff_id', pg_temp.uid(u - 100), 'email', 'staff' || u || '@synthetic.example', 'status', st, 'issued_at', now() - interval '1 day', 'expires_at', now() + interval '3 days',
    'invited_by', pg_temp.sys(), 'created_by', pg_temp.sys(), 'updated_by', pg_temp.sys()) || p_over) $$;
CREATE FUNCTION pg_temp.st(n int) RETURNS text LANGUAGE sql AS $$ SELECT state || '|' || coalesce(revoke_reason, '-') || '|' || (revoked_at IS NOT NULL)::text || '|' || version FROM identity.sessions WHERE id = pg_temp.uid(1300 + n) $$;
CREATE FUNCTION pg_temp.ist(n int) RETURNS text LANGUAGE sql AS $$ SELECT status || '|' || (accepted_at IS NOT NULL)::text || '|' || version FROM identity.invitations WHERE id = pg_temp.uid(1500 + n) $$;

-- ================================================================ fixtures (superuser)
SELECT pg_temp.ins('identity.platform_staff', jsonb_build_object('id', pg_temp.uid(1), 'user_id', pg_temp.uid(101), 'email_normalized', 'staff101@synthetic.example', 'display_name', 'Synthetic Staff 1',
  'role_code', 'platform_support', 'created_by', pg_temp.sys(), 'updated_by', pg_temp.sys()));
SELECT pg_temp.ins('identity.platform_staff', jsonb_build_object('id', pg_temp.uid(2), 'user_id', pg_temp.uid(102), 'email_normalized', 'staff102@synthetic.example', 'display_name', 'Synthetic Staff 2',
  'role_code', 'platform_support', 'created_by', pg_temp.sys(), 'updated_by', pg_temp.sys()));
SELECT pg_temp.ins('identity.support_sessions', jsonb_build_object('id', pg_temp.uid(3), 'tenant_id', pg_temp.ta(), 'platform_staff_id', pg_temp.uid(1), 'scope', 'read_only',
  'reason_text', 'Synthetic ticket investigation', 'ticket_ref', 'SYN-9', 'duration_minutes', 30, 'status', 'active', 'started_at', now(), 'expires_at', now() + interval '30 minutes',
  'created_by', pg_temp.sys(), 'updated_by', pg_temp.sys()));
-- user 101 (staff 1): 1 = the current password_setup session, 2/3 other live ones (2 bound to a support session), 4 already revoked, 5 expired
SELECT pg_temp.ps(1, 101, 'password_setup');
SELECT pg_temp.ps(2, 101, 'active', jsonb_build_object('support_session_id', pg_temp.uid(3)));
SELECT pg_temp.ps(3, 101, 'mfa_pending');
SELECT pg_temp.ps(4, 101, 'revoked', jsonb_build_object('revoked_at', now() - interval '1 hour', 'revoked_by', pg_temp.uid(101), 'revoke_reason', 'logout'));
SELECT pg_temp.ps(5, 101, 'expired');
-- user 102 (staff 2): one live platform session; user 101 also has a tenant session (id 7) that must never be touched
SELECT pg_temp.ps(6, 102, 'active');
SELECT pg_temp.ps(7, 101, 'active', jsonb_build_object('tenant_id', pg_temp.ta(), 'kind', 'tenant_staff', 'membership_id', '01a1a98a-ac40-7000-8000-00000000a500', 'platform_staff_id', NULL));
-- invitations: 1 = user 101 sent+valid, 2 = user 101 sent but expired, 3 pending, 4 accepted, 5 revoked, 6 = tenant invitation of user 101 (sent), 7 = user 102 sent+valid
SELECT pg_temp.inv(1, 101, 'sent');
SELECT pg_temp.inv(2, 101, 'sent', jsonb_build_object('expires_at', now() - interval '1 hour'));
SELECT pg_temp.inv(3, 101, 'pending');
SELECT pg_temp.inv(4, 101, 'accepted', jsonb_build_object('accepted_at', now() - interval '2 days'));
SELECT pg_temp.inv(5, 101, 'revoked');
SELECT pg_temp.inv(6, 101, 'sent', jsonb_build_object('tenant_id', pg_temp.ta(), 'membership_id', '01a1a98a-ac40-7000-8000-00000000a500', 'platform_staff_id', NULL));
SELECT pg_temp.inv(7, 102, 'sent');

CREATE TEMP TABLE before AS SELECT n, pg_temp.st(n) AS s FROM generate_series(1, 7) n;
CREATE TEMP TABLE before_inv AS SELECT n, pg_temp.ist(n) AS s FROM generate_series(1, 7) n;
CREATE TEMP TABLE support_before AS SELECT status, version FROM identity.support_sessions WHERE id = pg_temp.uid(3);

-- ================================================================ catalog: both functions exist, SECURITY DEFINER, empty search_path, no PUBLIC, lims_api only
SELECT is((SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'app'
            AND p.proname IN ('identity_platform_auth_write_revoke_other_sessions', 'identity_platform_auth_write_invitation_accept_by_user')), 2::bigint, 'A38-1: both functions exist in schema app');
SELECT is((SELECT pg_get_function_result(p.oid) FROM pg_proc p WHERE p.oid = to_regprocedure('app.identity_platform_auth_write_revoke_other_sessions(uuid,uuid,text)')), 'uuid[]', 'A38-1(a): returns uuid[]');
SELECT is((SELECT pg_get_function_result(p.oid) FROM pg_proc p WHERE p.oid = to_regprocedure('app.identity_platform_auth_write_invitation_accept_by_user(uuid)')), 'integer', 'A38-1(b): returns integer');
SELECT is((SELECT count(*) FROM pg_proc p WHERE p.oid IN (to_regprocedure('app.identity_platform_auth_write_revoke_other_sessions(uuid,uuid,text)'),
            to_regprocedure('app.identity_platform_auth_write_invitation_accept_by_user(uuid)')) AND p.prosecdef AND p.proconfig @> ARRAY['search_path=""']), 2::bigint,
          'A38-1: both are SECURITY DEFINER with SET search_path = ''''');
SELECT is((SELECT count(*) FROM pg_proc p WHERE p.oid IN (to_regprocedure('app.identity_platform_auth_write_revoke_other_sessions(uuid,uuid,text)'),
            to_regprocedure('app.identity_platform_auth_write_invitation_accept_by_user(uuid)')) AND p.proacl IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0)), 2::bigint, 'A38-1: REVOKE ALL FROM PUBLIC done (no PUBLIC entry in proacl) on both');
SELECT ok(has_function_privilege('lims_api', to_regprocedure('app.identity_platform_auth_write_revoke_other_sessions(uuid,uuid,text)'), 'EXECUTE'), 'A38-1(a): lims_api can EXECUTE');
SELECT ok(has_function_privilege('lims_api', to_regprocedure('app.identity_platform_auth_write_invitation_accept_by_user(uuid)'), 'EXECUTE'), 'A38-1(b): lims_api can EXECUTE');
SELECT ok(NOT has_function_privilege('lims_worker', to_regprocedure('app.identity_platform_auth_write_revoke_other_sessions(uuid,uuid,text)'), 'EXECUTE'), 'A38-1(a): lims_worker cannot EXECUTE');
SELECT ok(NOT has_function_privilege('lims_worker', to_regprocedure('app.identity_platform_auth_write_invitation_accept_by_user(uuid)'), 'EXECUTE'), 'A38-1(b): lims_worker cannot EXECUTE');
SELECT is((SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'app' AND p.proname = 'identity_platform_auth_write_invitation_accept'), 1::bigint,
          'A38-1: the two-argument invitation_accept of A28.1 is kept');

-- ================================================================ revoke_other_sessions: invalid reason is refused and writes nothing
SELECT ok(pg_temp.rev(pg_temp.uid(101), pg_temp.uid(1301), 'logout') LIKE 'EP0001:identity_platform_auth_write_invalid_input%', 'A38-1(a): p_reason other than password_change -> P0001 identity_platform_auth_write_invalid_input');
SELECT ok(pg_temp.rev(pg_temp.uid(101), pg_temp.uid(1301), 'PASSWORD_CHANGE') LIKE 'EP0001:identity_platform_auth_write_invalid_input%', 'A38-1(a): reason is case-sensitive');
SELECT ok(pg_temp.rev(pg_temp.uid(101), pg_temp.uid(1301), '') LIKE 'EP0001:identity_platform_auth_write_invalid_input%', 'A38-1(a): empty reason -> invalid_input');
SELECT ok(pg_temp.v('lims_api', pg_temp.sysclaims(), format('SELECT app.identity_platform_auth_write_revoke_other_sessions(%L::uuid, %L::uuid, NULL)::text', pg_temp.uid(101), pg_temp.uid(1301)))
          LIKE 'EP0001:identity_platform_auth_write_invalid_input%', 'A38-1(a): NULL reason -> invalid_input (never a revoke with no reason)');
SELECT is((SELECT count(*) FROM before b WHERE pg_temp.st(b.n) IS DISTINCT FROM b.s), 0::bigint, 'A38-1(a): the refused calls changed no session row');

-- ================================================================ revoke_other_sessions: the main call
SELECT is(pg_temp.rev(pg_temp.uid(101), pg_temp.uid(1301), 'password_change'), '{' || pg_temp.uid(1302) || ',' || pg_temp.uid(1303) || '}',
          'A38-1(a): returns exactly the ids of the user''s other live platform sessions (not the excepted one, not revoked/expired, not another user''s, not tenant)');
SELECT is(pg_temp.st(2), 'revoked|password_change|true|' || ((SELECT split_part(s, '|', 4) FROM before WHERE n = 2)::int + 1), 'A38-1(a): session 2 -> revoked, reason password_change, revoked_at set, version + 1');
SELECT is(pg_temp.st(3), 'revoked|password_change|true|' || ((SELECT split_part(s, '|', 4) FROM before WHERE n = 3)::int + 1), 'A38-1(a): session 3 (mfa_pending) -> revoked, reason password_change');
SELECT is((SELECT revoked_by::text || '|' || updated_by::text FROM identity.sessions WHERE id = pg_temp.uid(1302)), pg_temp.uid(101) || '|' || pg_temp.uid(101), 'A38-1(a): revoked_by and updated_by = p_user_id');
SELECT is(pg_temp.st(1), (SELECT s FROM before WHERE n = 1), 'A38-1(a): the excepted (current) session is untouched and stays password_setup');
SELECT is(pg_temp.st(4), (SELECT s FROM before WHERE n = 4), 'A38-1(a): an already revoked session keeps its reason (logout) and revoked_at');
SELECT is(pg_temp.st(5), (SELECT s FROM before WHERE n = 5), 'A38-1(a): an expired session is skipped');
SELECT is(pg_temp.st(6), (SELECT s FROM before WHERE n = 6), 'A38-1(a): another user''s platform session is untouched');
SELECT is(pg_temp.st(7), (SELECT s FROM before WHERE n = 7), 'A38-1(a): the same user''s TENANT session is untouched (kind = platform AND tenant_id IS NULL)');
SELECT is((SELECT status || '|' || version FROM identity.support_sessions WHERE id = pg_temp.uid(3)), (SELECT status || '|' || version FROM support_before),
          'A38-4: the support session bound to a revoked platform session is not touched');
SELECT is(pg_temp.rev(pg_temp.uid(101), pg_temp.uid(1301), 'password_change'), '{}', 'A38-1(a): nothing left to revoke -> empty array (not NULL, no error)');
SELECT is(pg_temp.rev(pg_temp.uid(103), pg_temp.uid(1301), 'password_change'), '{}', 'A38-1(a): unknown user -> empty array');
SELECT is(pg_temp.v('lims_api', pg_temp.sysclaims(), format($q$SELECT (SELECT count(*) FROM unnest(app.identity_platform_auth_write_revoke_other_sessions(%L::uuid, %L::uuid, 'password_change')))::text || '|' || coalesce(current_setting('app.pre_user_id', true), 'NULL')$q$,
          pg_temp.uid(102), pg_temp.uid(1301))), '1|', 'A38-1(a): app.pre_user_id is empty again after the call; user 102''s own session is revoked only for user 102');
SELECT is(pg_temp.st(1), (SELECT s FROM before WHERE n = 1), 'A38-1(a): user 101''s session is still untouched after the call for user 102 (p_except of another user is irrelevant)');
SELECT is(pg_temp.st(6), 'revoked|password_change|true|' || ((SELECT split_part(s, '|', 4) FROM before WHERE n = 6)::int + 1), 'A38-1(a): user 102''s session was revoked by the call for user 102');

-- ================================================================ invitation_accept_by_user
SELECT is(pg_temp.acc(pg_temp.uid(101)), '1', 'A38-1(b): accepts the user''s tenant-less sent invitation with a future expiry and returns the count (1)');
SELECT is(pg_temp.ist(1), 'accepted|true|' || ((SELECT split_part(s, '|', 3) FROM before_inv WHERE n = 1)::int + 1), 'A38-1(b): invitation 1 -> accepted, accepted_at set, version + 1');
SELECT is((SELECT updated_by::text FROM identity.invitations WHERE id = pg_temp.uid(1501)), pg_temp.uid(101)::text, 'A38-1(b): updated_by = p_user_id');
SELECT is(pg_temp.ist(2), (SELECT s FROM before_inv WHERE n = 2), 'A38-1(b): a sent but expired invitation is untouched');
SELECT is(pg_temp.ist(3), (SELECT s FROM before_inv WHERE n = 3), 'A38-1(b): a pending invitation is untouched');
SELECT is(pg_temp.ist(4), (SELECT s FROM before_inv WHERE n = 4), 'A38-1(b): an accepted invitation is untouched (accepted_at not overwritten)');
SELECT is(pg_temp.ist(5), (SELECT s FROM before_inv WHERE n = 5), 'A38-1(b): a revoked invitation is untouched');
SELECT is(pg_temp.ist(6), (SELECT s FROM before_inv WHERE n = 6), 'A38-1(b): the user''s TENANT invitation is untouched (tenant_id IS NULL)');
SELECT is(pg_temp.ist(7), (SELECT s FROM before_inv WHERE n = 7), 'A38-1(b): another user''s invitation is untouched');
SELECT is(pg_temp.acc(pg_temp.uid(101)), '0', 'A38-1(b): a second call finds nothing to accept -> 0');
SELECT is(pg_temp.acc(pg_temp.uid(103)), '0', 'A38-1(b): unknown user -> 0');
SELECT is(pg_temp.v('lims_api', pg_temp.sysclaims(), format($q$SELECT app.identity_platform_auth_write_invitation_accept_by_user(%L::uuid)::text || '|' || coalesce(current_setting('app.pre_user_id', true), 'NULL')$q$, pg_temp.uid(102))),
          '1|', 'A38-1(b): user 102''s invitation accepted (count 1) and app.pre_user_id is empty again');
SELECT is(pg_temp.ist(6), (SELECT s FROM before_inv WHERE n = 6), 'A38-1(b): the tenant invitation is still untouched after the call for user 102');

-- ================================================================ no policy change: lims_api still cannot write identity.sessions / invitations directly
SELECT ok(pg_temp.w(format($$UPDATE identity.sessions SET state = 'revoked' WHERE id = %L$$, pg_temp.uid(1301))) ~ '^(E42501:.*|0)$', 'A38: a direct UPDATE of identity.sessions as lims_api is refused by RLS / grants (error or 0 rows)');
SELECT ok(pg_temp.w(format($$UPDATE identity.invitations SET status = 'accepted' WHERE id = %L$$, pg_temp.uid(1503))) ~ '^(E42501:.*|0)$', 'A38: a direct UPDATE of identity.invitations as lims_api is refused by RLS / grants (error or 0 rows)');
SELECT is(pg_temp.st(1), (SELECT s FROM before WHERE n = 1), 'A38: the refused direct UPDATE changed nothing (session 1)');
SELECT is(pg_temp.ist(3), (SELECT s FROM before_inv WHERE n = 3), 'A38: the refused direct UPDATE changed nothing (invitation 3)');
SELECT ok(pg_temp.v('lims_api', pg_temp.sysclaims(), format($q$SELECT set_config('app.pre_user_id', %L, true) || '|' || (SELECT count(*) FROM identity.sessions)::text$q$, pg_temp.uid(101))) ~ '\|0$',
          'A38: lims_api setting app.pre_user_id itself still sees 0 identity.sessions rows (the owner policies are TO lims_owner)');
SELECT is(pg_temp.st(1), (SELECT s FROM before WHERE n = 1), 'A38: session 1 still password_setup at the end');

SELECT * FROM finish();
ROLLBACK;
