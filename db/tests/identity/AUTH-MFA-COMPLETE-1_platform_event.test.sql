-- AUTH-MFA-COMPLETE-1 (LD-221, AUTH-SENSITIVE LD-189; C2 03-APP-FLOW SS7, 05-SCHEMA s4.10 platform_events / s5.4; 08 A28.1, A25 D-215, A12.1 app.pre_* GUCs) live-DB assertions for
--   app.identity_platform_auth_write_mfa_enrolled_event(p_user_id uuid, p_row jsonb) RETURNS integer   (plpgsql SECURITY DEFINER, owner lims_owner, search_path '', EXECUTE lims_api only)
--     writes ONE identity.platform_events row, ONLY event_type 'platform_mfa_enrolled', target_type 'platform_staff', target_id = actor_platform_staff_id = the platform_staff row of p_user_id;
--     sets app.pre_user_id = p_user_id and resets it to '' before returning; anything else RAISES P0001 identity_platform_auth_write_invalid_input; returns the row count (1).
--   policy platform_events__insert__owner_mfa_enrolled ON identity.platform_events FOR INSERT TO lims_owner WITH CHECK (event_type = 'platform_mfa_enrolled' AND target_type = 'platform_staff'
--     AND target_id = actor_platform_staff_id AND the platform_staff row with that id belongs to nullif(current_setting('app.pre_user_id', true), '')::uuid)   - the ONLY policy this task adds.
-- (i) REPRODUCTION of the live defect (Postgres log: new row violates row-level security policy for table "platform_events", 16:58:17/21/25 NPT): as lims_api with the identityAuthTx claims
--     {sub: system actor, actor_type: 'system'} a PLAIN INSERT of the platform_mfa_enrolled row is refused (E42501) while the function inserts it (1 row).
-- Same style as AUTH-PLATFORM-SESSION-1_platform_reads.test.sql (stand-in fixture only when C2's tables are absent; RLS is never disabled; the migration alone creates the function and the policy,
-- so on a stand-in without it every assertion about them FAILS, as it must). Synthetic data only. The p_row seam: detail is a nested JSON object (see mfa.repo.platform-event.test.ts).
-- Run: pg_prove -d <migrated db> db/tests/identity/AUTH-MFA-COMPLETE-1_platform_event.test.sql   (superuser; pgTAP in schema `extensions`; run from the repo root)
-- The lane has no psql / docker: this file and the migration 20261115157000_identity__add_platform_mfa_event_definer.sql have NOT been run by their author (see .orchestra/notes/AUTH-MFA-COMPLETE-1-tests.md).
BEGIN;
SET search_path = extensions, public, pg_catalog;
SELECT * FROM no_plan();

\ir ../fixtures/T0B-06_identity_standin.sql

-- ---------------------------------------------------------------- helpers (same shapes as AUTH-PLATFORM-SESSION-1_platform_reads.test.sql)
CREATE FUNCTION pg_temp.id(k int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('01900000-0000-7000-8000-' || lpad(to_hex(k), 12, '0'))::uuid $$;
CREATE FUNCTION pg_temp.q(k int) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT quote_literal(pg_temp.id(k)::text) || '::uuid' $$;
CREATE FUNCTION pg_temp.sysclaims() RETURNS text LANGUAGE sql AS $$ SELECT jsonb_build_object('sub', pg_temp.id(99), 'actor_type', 'system')::text $$;   -- identityAuthTx (core/db/tx.ts)
-- run p_sql as p_role with p_claims (NULL = none); optional p_pre runs first in the same role/transaction (e.g. a GUC the "attacker" sets).
-- modes: v scalar text, n row count of a SELECT, w rows affected of a DML ('n=<k>'). Errors come back as 'E<SQLSTATE>:<message>'.
CREATE FUNCTION pg_temp.x(p_role text, p_claims text, p_pre text, p_sql text, p_mode text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE r text; n bigint;
BEGIN
  PERFORM set_config('request.jwt.claims', coalesce(p_claims, ''), true);
  EXECUTE format('SET LOCAL ROLE %I', p_role);
  BEGIN
    IF p_pre IS NOT NULL THEN EXECUTE p_pre; END IF;
    IF p_mode = 'v' THEN EXECUTE p_sql INTO r; r := coalesce(r, '<null>');
    ELSIF p_mode = 'n' THEN EXECUTE 'SELECT count(*) FROM (' || p_sql || ') t' INTO n; r := n::text;
    ELSE EXECUTE p_sql; GET DIAGNOSTICS n = ROW_COUNT; r := 'n=' || n;
    END IF;
  EXCEPTION WHEN OTHERS THEN r := 'E' || SQLSTATE || ':' || SQLERRM;
  END;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN r;
END $f$;
CREATE FUNCTION pg_temp.guc(p_name text) RETURNS text LANGUAGE sql AS $$ SELECT coalesce(current_setting(p_name, true), '<unset>') $$;
-- the p_row of the repo (mfa.repo.ts recordPlatformMfaEnrolledEvent): event id, type, target type, target id (fixture k), actor staff id (fixture k), optional target tenant (fixture k, 0 = NULL)
CREATE FUNCTION pg_temp.evrow(p_id int, p_type text, p_ttype text, p_target int, p_actor int, p_tenant int DEFAULT 0) RETURNS text LANGUAGE sql AS $$
  SELECT jsonb_build_object('id', pg_temp.id(p_id), 'event_type', p_type, 'target_type', p_ttype, 'target_id', pg_temp.id(p_target),
    'target_tenant_id', CASE p_tenant WHEN 0 THEN NULL ELSE pg_temp.id(p_tenant) END, 'detail', jsonb_build_object('factor_id', pg_temp.id(300)),
    'actor_platform_staff_id', pg_temp.id(p_actor), 'request_id', pg_temp.id(400), 'client_ip', '203.0.113.9', 'created_by', pg_temp.id(99))::text $$;
-- call the function as lims_api under the system claims; u = user fixture (0 = NULL), p_row NULL = SQL NULL; returns '1' or 'E<sqlstate>:<message>'
CREATE FUNCTION pg_temp.w(u int, p_row text, p_pre text DEFAULT NULL) RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.x('lims_api', pg_temp.sysclaims(), p_pre, 'SELECT app.identity_platform_auth_write_mfa_enrolled_event(' || CASE u WHEN 0 THEN 'NULL::uuid' ELSE pg_temp.q(u) END || ', '
    || CASE WHEN p_row IS NULL THEN 'NULL::jsonb' ELSE quote_literal(p_row) || '::jsonb' END || ')', 'v') $$;
CREATE FUNCTION pg_temp.nev() RETURNS bigint LANGUAGE sql AS $$ SELECT count(*) FROM identity.platform_events $$;
CREATE FUNCTION pg_temp.nev(p_id int) RETURNS bigint LANGUAGE sql AS $$ SELECT count(*) FROM identity.platform_events WHERE id = pg_temp.id(p_id) $$;

-- ---------------------------------------------------------------- fixtures (superuser; triggers / FK checks off while seeding)
-- the stand-in platform_events carries only some columns; add what the function writes (a no-op on the real C2 table)
ALTER TABLE identity.platform_events ADD COLUMN IF NOT EXISTS target_tenant_id uuid;
ALTER TABLE identity.platform_events ADD COLUMN IF NOT EXISTS detail jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE identity.platform_events ADD COLUMN IF NOT EXISTS actor_platform_staff_id uuid;
ALTER TABLE identity.platform_events ADD COLUMN IF NOT EXISTS request_id uuid;
ALTER TABLE identity.platform_events ADD COLUMN IF NOT EXISTS client_ip inet;
SET LOCAL session_replication_role = replica;
INSERT INTO core.tenants (id, tenant_code, legal_name, display_name, status, created_by, updated_by) VALUES
  (pg_temp.id(1), 'lab_a', 'Lab A Pvt Ltd', 'Lab A', 'active', pg_temp.id(99), pg_temp.id(99));
-- staff 61 = user 32 (the founder-like platform admin enrolling); staff 62 = user 33 (a second admin); user 34 has NO platform_staff row
INSERT INTO identity.platform_staff (id, user_id, email_normalized, display_name, role_code, is_active, created_by, updated_by) VALUES
  (pg_temp.id(61), pg_temp.id(32), 'staff32@example.test', 'Staff 32', 'platform_admin', true, pg_temp.id(99), pg_temp.id(99)),
  (pg_temp.id(62), pg_temp.id(33), 'staff33@example.test', 'Staff 33', 'platform_admin', true, pg_temp.id(99), pg_temp.id(99));
SET LOCAL session_replication_role = origin;
CREATE TEMP TABLE before_n AS SELECT pg_temp.nev() AS n;

-- ================================================================ catalog: function attributes + grants (08 A10.5; C0 05-SCHEMA s4.3)
SELECT ok(to_regprocedure('app.identity_platform_auth_write_mfa_enrolled_event(uuid,jsonb)') IS NOT NULL, 'exists: app.identity_platform_auth_write_mfa_enrolled_event(uuid,jsonb)');
CREATE TEMP TABLE fn AS SELECT p.* FROM pg_proc p WHERE p.oid = to_regprocedure('app.identity_platform_auth_write_mfa_enrolled_event(uuid,jsonb)');
SELECT ok((SELECT prosecdef FROM fn), 'SECURITY DEFINER');
SELECT is((SELECT pg_get_userbyid(proowner) FROM fn), 'lims_owner', 'owner lims_owner');
SELECT is((SELECT l.lanname FROM fn JOIN pg_language l ON l.oid = fn.prolang), 'plpgsql', 'language plpgsql');
SELECT ok((SELECT proconfig @> ARRAY['search_path=""'] OR proconfig @> ARRAY['search_path='] FROM fn), 'search_path is empty');
SELECT is((SELECT prorettype::regtype::text FROM fn), 'integer', 'RETURNS integer');
SELECT ok(NOT (SELECT proretset FROM fn), 'returns a scalar, not a set');
SELECT is((SELECT provolatile FROM fn), 'v', 'VOLATILE');
SELECT is((SELECT proargnames FROM fn), ARRAY['p_user_id', 'p_row'], 'argument names p_user_id, p_row');
SELECT ok((SELECT proacl IS NOT NULL AND NOT EXISTS (SELECT 1 FROM aclexplode(proacl) a WHERE a.grantee = 0) FROM fn), 'no EXECUTE for PUBLIC');
SELECT ok(NOT EXISTS (SELECT 1 FROM pg_roles r, fn WHERE r.rolname IN ('anon', 'authenticated') AND has_function_privilege(r.oid, fn.oid, 'EXECUTE')), 'no EXECUTE for anon / authenticated');
SELECT ok((SELECT has_function_privilege('lims_api', oid, 'EXECUTE') AND NOT has_function_privilege('lims_worker', oid, 'EXECUTE') AND NOT has_function_privilege('lims_app', oid, 'EXECUTE')
                  AND NOT has_function_privilege('lims_queue', oid, 'EXECUTE') FROM fn), 'EXECUTE only for lims_api');
SELECT ok(pg_temp.x('lims_worker', NULL, NULL, 'SELECT app.identity_platform_auth_write_mfa_enrolled_event(' || pg_temp.q(32) || ', ''{}''::jsonb)', 'v') LIKE 'E42501:%', 'lims_worker cannot call it (42501)');
SELECT ok(pg_temp.x('lims_app',    NULL, NULL, 'SELECT app.identity_platform_auth_write_mfa_enrolled_event(' || pg_temp.q(32) || ', ''{}''::jsonb)', 'v') LIKE 'E42501:%', 'lims_app cannot call it (42501)');
SELECT ok(pg_get_functiondef((SELECT oid FROM fn)) ~ 'app\.pre_user_id', 'body uses app.pre_user_id (08 A12.1)');
SELECT ok(pg_get_functiondef((SELECT oid FROM fn)) ~ 'platform_mfa_enrolled' AND pg_get_functiondef((SELECT oid FROM fn)) ~ 'platform_staff', 'body names the one event type and the platform_staff target');
SELECT ok(pg_get_functiondef((SELECT oid FROM fn)) !~* '(update\s+[a-z_."]+\s+set|delete\s+from|truncate)', 'body has no UPDATE / DELETE / TRUNCATE');

-- ================================================================ catalog: the ONE new policy (and only it)
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'identity' AND tablename = 'platform_events' AND policyname = 'platform_events__insert__owner_mfa_enrolled'), 1, 'policy platform_events__insert__owner_mfa_enrolled exists');
SELECT is((SELECT roles FROM pg_policies WHERE schemaname = 'identity' AND tablename = 'platform_events' AND policyname = 'platform_events__insert__owner_mfa_enrolled'), ARRAY['lims_owner']::name[], 'the new policy is TO lims_owner only');
SELECT is((SELECT cmd FROM pg_policies WHERE schemaname = 'identity' AND tablename = 'platform_events' AND policyname = 'platform_events__insert__owner_mfa_enrolled'), 'INSERT', 'the new policy is FOR INSERT');
SELECT ok((SELECT qual IS NULL FROM pg_policies WHERE policyname = 'platform_events__insert__owner_mfa_enrolled'), 'the new policy has no USING (an INSERT policy)');
SELECT ok((SELECT with_check ~ 'platform_mfa_enrolled' AND with_check ~ 'platform_staff' AND with_check ~ 'actor_platform_staff_id' AND with_check ~ 'app\.pre_user_id' AND with_check !~ '\mOR\M'
             FROM pg_policies WHERE policyname = 'platform_events__insert__owner_mfa_enrolled'), 'the WITH CHECK names the event type, the platform_staff row, actor = target and app.pre_user_id (no OR)');
SELECT set_eq($$SELECT policyname::text FROM pg_policies WHERE schemaname = 'identity' AND tablename = 'platform_events' AND roles = ARRAY['lims_owner']::name[]$$,
  $$VALUES ('platform_events__insert__owner_only'), ('platform_events__insert__owner_mfa_enrolled')$$, 'identity.platform_events has exactly two lims_owner policies');
-- the existing policies are untouched
SELECT is((SELECT with_check FROM pg_policies WHERE schemaname = 'identity' AND tablename = 'platform_events' AND policyname = 'platform_events__insert__owner_only'), '(event_type = ''bootstrap_admin_created''::text)',
  'platform_events__insert__owner_only is unchanged (bootstrap_admin_created only)');
SELECT ok(EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'identity' AND tablename = 'platform_events' AND policyname = 'platform_events__insert__platform'), 'platform_events__insert__platform still exists');

-- ================================================================ (i) REPRODUCTION of the live defect
SELECT is(pg_temp.x('lims_api', pg_temp.sysclaims(), NULL,
          format($$INSERT INTO identity.platform_events (id, event_type, target_type, target_id, actor_platform_staff_id, created_by) VALUES (%L, 'platform_mfa_enrolled', 'platform_staff', %L, %L, %L)$$,
                 pg_temp.id(501), pg_temp.id(61), pg_temp.id(61), pg_temp.id(99)), 'w') LIKE 'E42501:%', true,
          'REPRODUCTION: a PLAIN INSERT of the platform_mfa_enrolled row as lims_api under the system claims is refused (42501) - this is what PLATFORM_EVENT_SQL did live');
SELECT is(pg_temp.nev(501), 0::bigint, 'REPRODUCTION: the refused plain INSERT left no row');
SELECT is(pg_temp.w(32, pg_temp.evrow(502, 'platform_mfa_enrolled', 'platform_staff', 61, 61)), '1', 'REPRODUCTION: the function writes the same row under the same claims and returns 1');
SELECT is(pg_temp.nev(502), 1::bigint, 'REPRODUCTION: exactly one platform_events row exists for it');

-- ================================================================ the written row
SELECT is((SELECT event_type FROM identity.platform_events WHERE id = pg_temp.id(502)), 'platform_mfa_enrolled', 'row: event_type');
SELECT is((SELECT target_type FROM identity.platform_events WHERE id = pg_temp.id(502)), 'platform_staff', 'row: target_type');
SELECT is((SELECT target_id FROM identity.platform_events WHERE id = pg_temp.id(502)), pg_temp.id(61), 'row: target_id = the staff row of the user');
SELECT is((SELECT actor_platform_staff_id FROM identity.platform_events WHERE id = pg_temp.id(502)), pg_temp.id(61), 'row: actor_platform_staff_id = the same staff row');
SELECT is((SELECT target_tenant_id FROM identity.platform_events WHERE id = pg_temp.id(502)), NULL::uuid, 'row: target_tenant_id NULL');
SELECT is((SELECT detail FROM identity.platform_events WHERE id = pg_temp.id(502)), jsonb_build_object('factor_id', pg_temp.id(300)), 'row: detail = {factor_id}');
SELECT is((SELECT request_id FROM identity.platform_events WHERE id = pg_temp.id(502)), pg_temp.id(400), 'row: request_id');
SELECT is((SELECT client_ip FROM identity.platform_events WHERE id = pg_temp.id(502)), '203.0.113.9'::inet, 'row: client_ip cast to inet');
SELECT is((SELECT created_by FROM identity.platform_events WHERE id = pg_temp.id(502)), pg_temp.id(99), 'row: created_by = the system actor');
SELECT ok((SELECT created_at IS NOT NULL FROM identity.platform_events WHERE id = pg_temp.id(502)), 'row: created_at defaulted');
SELECT is(pg_temp.w(33, pg_temp.evrow(503, 'platform_mfa_enrolled', 'platform_staff', 62, 62)), '1', 'a second admin (user 33 -> staff 62) enrols the same way: 1');
SELECT is(pg_temp.w(32, replace(pg_temp.evrow(504, 'platform_mfa_enrolled', 'platform_staff', 61, 61), '203.0.113.9', '')), '1', 'an empty client_ip is accepted (stored as NULL by the nullif cast)');
SELECT is((SELECT client_ip FROM identity.platform_events WHERE id = pg_temp.id(504)), NULL::inet, 'row: empty client_ip -> NULL');

-- ================================================================ refusals: anything else RAISES P0001 identity_platform_auth_write_invalid_input; no row is written
SELECT is(pg_temp.w(32, pg_temp.evrow(511, 'bootstrap_admin_created', 'platform_staff', 61, 61)), 'EP0001:identity_platform_auth_write_invalid_input', 'refused: event_type bootstrap_admin_created (the other owner policy''s type)');
SELECT is(pg_temp.w(32, pg_temp.evrow(512, 'platform_staff_invited', 'platform_staff', 61, 61)), 'EP0001:identity_platform_auth_write_invalid_input', 'refused: event_type platform_staff_invited');
SELECT is(pg_temp.w(32, pg_temp.evrow(513, 'platform_mfa_reset', 'platform_staff', 61, 61)), 'EP0001:identity_platform_auth_write_invalid_input', 'refused: event_type platform_mfa_reset (another real type)');
SELECT is(pg_temp.w(32, pg_temp.evrow(514, 'x', 'platform_staff', 61, 61)), 'EP0001:identity_platform_auth_write_invalid_input', 'refused: an unknown event_type');
SELECT is(pg_temp.w(32, pg_temp.evrow(515, 'platform_mfa_enrolled', 'tenant', 61, 61)), 'EP0001:identity_platform_auth_write_invalid_input', 'refused: target_type tenant');
SELECT is(pg_temp.w(32, pg_temp.evrow(516, 'platform_mfa_enrolled', 'mfa_factor', 61, 61)), 'EP0001:identity_platform_auth_write_invalid_input', 'refused: target_type mfa_factor (C2 test uses it for the platform policy, not for this path)');
SELECT is(pg_temp.w(32, pg_temp.evrow(517, 'platform_mfa_enrolled', 'platform_staff', 62, 62)), 'EP0001:identity_platform_auth_write_invalid_input', 'refused: another staff row (user 32 writes for staff 62 / user 33)');
SELECT is(pg_temp.w(32, pg_temp.evrow(518, 'platform_mfa_enrolled', 'platform_staff', 61, 62)), 'EP0001:identity_platform_auth_write_invalid_input', 'refused: actor_platform_staff_id differs from the target');
SELECT is(pg_temp.w(32, pg_temp.evrow(519, 'platform_mfa_enrolled', 'platform_staff', 62, 61)), 'EP0001:identity_platform_auth_write_invalid_input', 'refused: target differs from the actor');
SELECT is(pg_temp.w(33, pg_temp.evrow(520, 'platform_mfa_enrolled', 'platform_staff', 61, 61)), 'EP0001:identity_platform_auth_write_invalid_input', 'refused: user 33 writes the event of staff 61 (user 32)');
SELECT is(pg_temp.w(34, pg_temp.evrow(521, 'platform_mfa_enrolled', 'platform_staff', 61, 61)), 'EP0001:identity_platform_auth_write_invalid_input', 'refused: a user with no platform_staff row (34)');
SELECT is(pg_temp.w(34, pg_temp.evrow(522, 'platform_mfa_enrolled', 'platform_staff', 34, 34)), 'EP0001:identity_platform_auth_write_invalid_input', 'refused: a user with no staff row naming a made-up staff id');
SELECT is(pg_temp.w(555, pg_temp.evrow(523, 'platform_mfa_enrolled', 'platform_staff', 61, 61)), 'EP0001:identity_platform_auth_write_invalid_input', 'refused: an unknown user');
SELECT is(pg_temp.w(32, pg_temp.evrow(524, 'platform_mfa_enrolled', 'platform_staff', 61, 61, 1)), 'EP0001:identity_platform_auth_write_invalid_input', 'refused: a target_tenant_id (platform events here are tenant-less)');
SELECT ok(pg_temp.w(0, pg_temp.evrow(525, 'platform_mfa_enrolled', 'platform_staff', 61, 61)) LIKE 'E%', 'refused: NULL user (an error, not a row)');
SELECT ok(pg_temp.w(32, NULL) LIKE 'E%', 'refused: NULL row (an error, not a row)');
SELECT ok(pg_temp.w(32, '{}') LIKE 'E%', 'refused: an empty row');
SELECT ok(pg_temp.w(32, '[]') LIKE 'E%', 'refused: a JSON array instead of an object');
SELECT ok(pg_temp.w(32, (pg_temp.evrow(526, 'platform_mfa_enrolled', 'platform_staff', 61, 61)::jsonb - 'event_type')::text) LIKE 'E%', 'refused: event_type missing');
SELECT ok(pg_temp.w(32, (pg_temp.evrow(527, 'platform_mfa_enrolled', 'platform_staff', 61, 61)::jsonb - 'actor_platform_staff_id')::text) LIKE 'E%', 'refused: actor_platform_staff_id missing');
SELECT is((SELECT count(*) FROM generate_series(511, 527) k WHERE pg_temp.nev(k) > 0), 0::bigint, 'none of the refused calls wrote a row');
SELECT is(pg_temp.nev(), (SELECT n FROM before_n) + 3, 'the table gained exactly the 3 accepted rows (502, 503, 504)');
SELECT is((SELECT count(*) FROM identity.platform_events WHERE event_type <> 'platform_mfa_enrolled'), 0::bigint, 'no row of any other event_type exists');

-- ================================================================ attacker-set GUCs gain nothing (the function overrides app.pre_user_id with its own argument)
SELECT is(pg_temp.w(33, pg_temp.evrow(531, 'platform_mfa_enrolled', 'platform_staff', 61, 61), $$SELECT set_config('app.pre_user_id', '$$ || pg_temp.id(32) || $$', true)$$), 'EP0001:identity_platform_auth_write_invalid_input',
  'a pre-set app.pre_user_id of user 32 does not let user 33 write staff 61''s event');
SELECT is(pg_temp.w(32, pg_temp.evrow(532, 'platform_mfa_enrolled', 'platform_staff', 61, 61), $$SELECT set_config('app.pre_user_id', '$$ || pg_temp.id(33) || $$', true)$$), '1',
  'a pre-set app.pre_user_id of another user is overridden: the caller''s own event is written');
SELECT is(pg_temp.nev(531), 0::bigint, 'the GUC-assisted attempt left no row');

-- ================================================================ (iv) GUCs are '' after the call
SELECT is(pg_temp.w(32, pg_temp.evrow(541, 'platform_mfa_enrolled', 'platform_staff', 61, 61)), '1', '(iv) call (accepted)');
SELECT is(pg_temp.guc('app.pre_user_id'), '', '(iv) app.pre_user_id is empty after an accepted call');
SELECT is(pg_temp.w(32, pg_temp.evrow(542, 'x', 'platform_staff', 61, 61)), 'EP0001:identity_platform_auth_write_invalid_input', '(iv) call (refused)');
SELECT ok(pg_temp.guc('app.pre_user_id') IN ('', '<unset>'), '(iv) app.pre_user_id is empty (or unset) after a refused call');
SELECT ok(pg_temp.guc('app.pre_tenant_id') IN ('', '<unset>'), '(iv) app.pre_tenant_id was never set to a tenant');

-- ================================================================ defence in depth: the POLICY alone, without the function (SET ROLE lims_owner inside the superuser test session)
-- as the table owner (FORCE RLS applies): only the exact row under the exact GUC passes
CREATE FUNCTION pg_temp.ins(p_pre text, p_id int, p_type text, p_ttype text, p_target int, p_actor int) RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.x('lims_owner', NULL, p_pre, format($i$INSERT INTO identity.platform_events (id, event_type, target_type, target_id, actor_platform_staff_id, created_by) VALUES (%L, %L, %L, %L, %L, %L)$i$,
    pg_temp.id(p_id), p_type, p_ttype, pg_temp.id(p_target), pg_temp.id(p_actor), pg_temp.id(99)), 'w') $$;
CREATE FUNCTION pg_temp.pre(u int) RETURNS text LANGUAGE sql AS $$ SELECT format('SELECT set_config(''app.pre_user_id'', %L, true)', pg_temp.id(u)::text) $$;
SELECT is(pg_temp.ins(pg_temp.pre(32), 601, 'platform_mfa_enrolled', 'platform_staff', 61, 61), 'n=1', 'policy: lims_owner + app.pre_user_id = the staff user + the exact row -> 1 row');
SELECT is(pg_temp.ins(NULL, 602, 'platform_mfa_enrolled', 'platform_staff', 61, 61), 'E42501:' || 'new row violates row-level security policy for table "platform_events"', 'policy: no GUC set -> refused');
SELECT is(pg_temp.ins($$SELECT set_config('app.pre_user_id', '', true)$$, 603, 'platform_mfa_enrolled', 'platform_staff', 61, 61), 'E42501:' || 'new row violates row-level security policy for table "platform_events"', 'policy: GUC set to the empty string -> refused');
SELECT like(pg_temp.ins(pg_temp.pre(33), 604, 'platform_mfa_enrolled', 'platform_staff', 61, 61), 'E42501:%', 'policy: the GUC names another user -> refused');
SELECT like(pg_temp.ins(pg_temp.pre(32), 605, 'platform_mfa_enrolled', 'platform_staff', 62, 62), 'E42501:%', 'policy: the row targets another staff row -> refused');
SELECT like(pg_temp.ins(pg_temp.pre(32), 606, 'platform_mfa_enrolled', 'platform_staff', 61, 62), 'E42501:%', 'policy: actor differs from target -> refused');
SELECT like(pg_temp.ins(pg_temp.pre(32), 608, 'platform_staff_invited', 'platform_staff', 61, 61), 'E42501:%', 'policy: another event_type (platform_staff_invited) -> refused');
SELECT like(pg_temp.ins(pg_temp.pre(32), 609, 'platform_mfa_enrolled', 'tenant', 61, 61), 'E42501:%', 'policy: another target_type -> refused');
SELECT like(pg_temp.ins(pg_temp.pre(34), 610, 'platform_mfa_enrolled', 'platform_staff', 34, 34), 'E42501:%', 'policy: a user without a staff row -> refused');
SELECT is(pg_temp.nev(601), 1::bigint, 'policy: the accepted row exists'); SELECT is((SELECT count(*) FROM generate_series(602, 606) k WHERE pg_temp.nev(k) > 0) + pg_temp.nev(608) + pg_temp.nev(609) + pg_temp.nev(610), 0::bigint, 'policy: no refused row exists');
-- other roles setting the GUC themselves gain nothing (08 A12.7: the policy is TO lims_owner only)
SELECT like(pg_temp.x('lims_app', pg_temp.sysclaims(), pg_temp.pre(32), format($$INSERT INTO identity.platform_events (id, event_type, target_type, target_id, actor_platform_staff_id, created_by) VALUES (%L, 'platform_mfa_enrolled', 'platform_staff', %L, %L, %L)$$,
            pg_temp.id(620), pg_temp.id(61), pg_temp.id(61), pg_temp.id(99)), 'w'), 'E42501:%', 'lims_app that sets app.pre_user_id itself cannot insert the row (42501)');
SELECT like(pg_temp.x('lims_api', pg_temp.sysclaims(), pg_temp.pre(32), format($$INSERT INTO identity.platform_events (id, event_type, target_type, target_id, actor_platform_staff_id, created_by) VALUES (%L, 'platform_mfa_enrolled', 'platform_staff', %L, %L, %L)$$,
            pg_temp.id(621), pg_temp.id(61), pg_temp.id(61), pg_temp.id(99)), 'w'), 'E42501:%', 'lims_api that sets app.pre_user_id itself cannot insert the row either (the plain INSERT stays refused)');
SELECT is(pg_temp.nev(620) + pg_temp.nev(621), 0::bigint, 'no row from the non-owner attempts');

-- ================================================================ no RLS or grant weakening (LD-189)
SELECT is((SELECT count(*) FROM pg_policies WHERE qual = 'true' OR with_check = 'true'), 1::bigint, 'USING (true) / WITH CHECK (true) still appears exactly once in the database (platform_staff__select__owner_only)');
SELECT ok(NOT EXISTS (SELECT 1 FROM pg_policies WHERE (qual ~ 'app\.(pre_|maintenance)' OR with_check ~ 'app\.(pre_|maintenance)') AND roles <> '{lims_owner}'), 'every policy mentioning app.pre_* / app.maintenance is still TO lims_owner only');
SELECT ok((SELECT relforcerowsecurity AND relrowsecurity FROM pg_class WHERE oid = 'identity.platform_events'::regclass), 'FORCE + ENABLE RLS still on identity.platform_events');
SELECT ok(NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'identity' AND tablename = 'platform_events' AND roles && ARRAY['public', 'anon', 'authenticated']::name[]), 'no platform_events policy for PUBLIC / anon / authenticated');
SELECT ok(NOT EXISTS (SELECT 1 FROM pg_class c, LATERAL aclexplode(c.relacl) a WHERE c.oid = 'identity.platform_events'::regclass
                       AND (a.grantee = 0 OR a.grantee IN (SELECT oid FROM pg_roles WHERE rolname IN ('anon', 'authenticated')))), 'no table grant on platform_events to PUBLIC / anon / authenticated');
SELECT ok(NOT has_table_privilege('lims_api', 'identity.platform_events', 'UPDATE') AND NOT has_table_privilege('lims_api', 'identity.platform_events', 'DELETE')
          AND NOT has_table_privilege('lims_app', 'identity.platform_events', 'UPDATE') AND NOT has_table_privilege('lims_app', 'identity.platform_events', 'DELETE'), 'platform_events stays append-only: no UPDATE / DELETE privilege for lims_api / lims_app');
SELECT is((SELECT count(*) FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgrelid = 'identity.platform_events'::regclass AND t.tgfoid = 'app.tg_row_audit()'::regprocedure), 0::bigint,
          'no app.tg_row_audit trigger on identity.platform_events (unchanged)');

SELECT * FROM finish();
ROLLBACK;
