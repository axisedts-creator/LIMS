-- C16.T-Q3 live-DB assertions: app.engagement_resolve_display(bytea) under FORCE RLS (05-SCHEMA §6.3, §6.6 test 4 (a)-(c), §4 device guard, DISP policy; 08 A12.7, R24; CR-C16-005/006).
-- Synthetic data only. One rolled-back transaction. RLS is never disabled for the assertions (the seed runs with session_replication_role = replica, as the isolation probes do).
-- Run: pg_prove -d <migrated db with the engagement DDL of CR-C16-006> db/tests/engagement/T-Q3_resolve_display.test.sql   (superuser; pgTAP in schema `extensions`; run from the repo root)
-- Needs a live Postgres with C0 + C16 migrations; it is NOT part of .orchestra/notes/T-Q3-verify.cmd (no database in the unit-test environment).
-- Fails now: engagement.queue_displays and app.engagement_resolve_display do not exist in the migrated schema.
BEGIN;
SET search_path = extensions, public, pg_catalog;
SELECT * FROM no_plan();
\ir ../fixtures/T0B-06_identity_standin.sql

CREATE FUNCTION pg_temp.id(k int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('01950c16-0000-7000-8000-' || lpad(to_hex(k), 12, '0'))::uuid $$;
CREATE FUNCTION pg_temp.h(k int) RETURNS bytea LANGUAGE sql IMMUTABLE AS $$ SELECT sha256(convert_to('synthetic-display-token-' || k, 'UTF8')) $$;
CREATE FUNCTION pg_temp.qh(k int) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT quote_literal('\x' || encode(pg_temp.h(k), 'hex')) || '::bytea' $$;
CREATE FUNCTION pg_temp.cl(p_type text, p_sub int, p_centre int DEFAULT NULL, p_kind text DEFAULT NULL) RETURNS text LANGUAGE sql AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object('actor_type', p_type, 'tenant_id', pg_temp.id(1), 'sub', pg_temp.id(p_sub), 'centre_id', pg_temp.id(p_centre), 'device_kind', p_kind))::text $$;
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

-- ---------------------------------------------------------------- fixtures: tenants A (active), B (active), S (suspended); centres A1, A2, B1
SET LOCAL session_replication_role = replica;
INSERT INTO core.tenants (id, tenant_code, legal_name, display_name, status, created_by, updated_by) VALUES
  (pg_temp.id(1), 'tq3_a', 'Lab A', 'Lab A', 'active', pg_temp.id(99), pg_temp.id(99)),
  (pg_temp.id(2), 'tq3_b', 'Lab B', 'Lab B', 'active', pg_temp.id(99), pg_temp.id(99)),
  (pg_temp.id(3), 'tq3_s', 'Lab S', 'Lab S', 'suspended', pg_temp.id(99), pg_temp.id(99));
INSERT INTO core.branches (id, tenant_id, branch_code, name, created_by, updated_by) VALUES
  (pg_temp.id(11), pg_temp.id(1), 'A', 'Branch A', pg_temp.id(99), pg_temp.id(99)),
  (pg_temp.id(12), pg_temp.id(2), 'B', 'Branch B', pg_temp.id(99), pg_temp.id(99)),
  (pg_temp.id(13), pg_temp.id(3), 'S', 'Branch S', pg_temp.id(99), pg_temp.id(99));
INSERT INTO core.collection_centres (id, tenant_id, branch_id, centre_code, name, centre_kind, created_by, updated_by) VALUES
  (pg_temp.id(21), pg_temp.id(1), pg_temp.id(11), 'A1', 'Centre A1', 'own', pg_temp.id(99), pg_temp.id(99)),
  (pg_temp.id(22), pg_temp.id(1), pg_temp.id(11), 'A2', 'Centre A2', 'own', pg_temp.id(99), pg_temp.id(99)),
  (pg_temp.id(23), pg_temp.id(2), pg_temp.id(12), 'B1', 'Centre B1', 'own', pg_temp.id(99), pg_temp.id(99)),
  (pg_temp.id(24), pg_temp.id(3), pg_temp.id(13), 'S1', 'Centre S1', 'own', pg_temp.id(99), pg_temp.id(99));
-- displays: 101 active A1, 102 active A2, 103 REVOKED A1, 104 active B1, 105 active in the suspended tenant
INSERT INTO engagement.queue_displays (id, tenant_id, centre_id, display_name, queue_ids, token_sha256, status, paired_at, paired_by, revoked_at, revoked_by, created_by, updated_by) VALUES
  (pg_temp.id(101), pg_temp.id(1), pg_temp.id(21), 'TV A1',  ARRAY[pg_temp.id(31)], pg_temp.h(1), 'active',  now(), pg_temp.id(99), NULL, NULL, pg_temp.id(99), pg_temp.id(99)),
  (pg_temp.id(102), pg_temp.id(1), pg_temp.id(22), 'TV A2',  ARRAY[pg_temp.id(32)], pg_temp.h(2), 'active',  now(), pg_temp.id(99), NULL, NULL, pg_temp.id(99), pg_temp.id(99)),
  (pg_temp.id(103), pg_temp.id(1), pg_temp.id(21), 'TV old', ARRAY[pg_temp.id(31)], pg_temp.h(3), 'revoked', now(), pg_temp.id(99), now(), pg_temp.id(99), pg_temp.id(99), pg_temp.id(99)),
  (pg_temp.id(104), pg_temp.id(2), pg_temp.id(23), 'TV B1',  ARRAY[pg_temp.id(33)], pg_temp.h(4), 'active',  now(), pg_temp.id(99), NULL, NULL, pg_temp.id(99), pg_temp.id(99)),
  (pg_temp.id(105), pg_temp.id(3), pg_temp.id(24), 'TV S1',  ARRAY[pg_temp.id(34)], pg_temp.h(5), 'active',  now(), pg_temp.id(99), NULL, NULL, pg_temp.id(99), pg_temp.id(99));
INSERT INTO engagement.booking_centres (id, tenant_id, centre_id, branch_id, display_name, is_active, synced_at, created_by, updated_by) VALUES
  (pg_temp.id(201), pg_temp.id(1), pg_temp.id(21), pg_temp.id(11), 'Synthetic Centre A1', true, now(), pg_temp.id(99), pg_temp.id(99)),
  (pg_temp.id(202), pg_temp.id(1), pg_temp.id(22), pg_temp.id(11), 'Synthetic Centre A2', true, now(), pg_temp.id(99), pg_temp.id(99)),
  (pg_temp.id(203), pg_temp.id(2), pg_temp.id(23), pg_temp.id(12), 'Synthetic Centre B1', true, now(), pg_temp.id(99), pg_temp.id(99));
SET LOCAL session_replication_role = origin;

-- ---------------------------------------------------------------- the function: owner, DEFINER, search_path, grants (05-SCHEMA §6.6 inventory row)
SELECT is((SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid = 'app.engagement_resolve_display(bytea)'::regprocedure), 'lims_owner', 'resolve_display is owned by lims_owner');
SELECT ok((SELECT prosecdef FROM pg_proc WHERE oid = 'app.engagement_resolve_display(bytea)'::regprocedure), 'resolve_display is SECURITY DEFINER');
SELECT ok((SELECT proconfig @> ARRAY['search_path='] FROM pg_proc WHERE oid = 'app.engagement_resolve_display(bytea)'::regprocedure), 'resolve_display pins search_path = ''''');
SELECT ok(has_function_privilege('lims_api', 'app.engagement_resolve_display(bytea)', 'EXECUTE'), 'lims_api may execute resolve_display');
SELECT ok(NOT has_function_privilege('public', 'app.engagement_resolve_display(bytea)', 'EXECUTE'), 'PUBLIC may not execute resolve_display');

-- ---------------------------------------------------------------- (a) returns the row for the presented hash (and only for an active display of an active tenant)
SELECT is(pg_temp.api('SELECT display_id::text || ''|'' || centre_id::text || ''|'' || tenant_id::text FROM app.engagement_resolve_display(' || pg_temp.qh(1) || ')'),
          pg_temp.id(101)::text || '|' || pg_temp.id(21)::text || '|' || pg_temp.id(1)::text, 'active display of tenant A: display id, centre id, tenant id');
SELECT is(pg_temp.api('SELECT display_id::text || ''|'' || tenant_id::text FROM app.engagement_resolve_display(' || pg_temp.qh(4) || ')'),
          pg_temp.id(104)::text || '|' || pg_temp.id(2)::text, 'the hash of a tenant-B display resolves to tenant B (tenant comes from the row)');
SELECT is(pg_temp.api('SELECT * FROM app.engagement_resolve_display(' || pg_temp.qh(3) || ')', 'n'), '0', 'REVOKED display -> no row (the 401 of US-EN-22.4)');
SELECT is(pg_temp.api('SELECT * FROM app.engagement_resolve_display(' || pg_temp.qh(5) || ')', 'n'), '0', 'display of a suspended tenant -> no row');
SELECT is(pg_temp.api('SELECT * FROM app.engagement_resolve_display(' || pg_temp.qh(99) || ')', 'n'), '0', 'unknown hash -> no row');
SELECT is(pg_temp.api('SELECT * FROM app.engagement_resolve_display(NULL)', 'n'), '0', 'NULL hash -> no row');
SELECT is(pg_temp.api('SELECT * FROM app.engagement_resolve_display(''\x00''::bytea)', 'n'), '0', 'hash of the wrong length (1 byte) -> no row');
SELECT is(pg_temp.api('SELECT * FROM app.engagement_resolve_display(''\x' || repeat('ab', 33) || '''::bytea)', 'n'), '0', 'hash of the wrong length (33 bytes) -> no row');
UPDATE engagement.queue_displays SET status = 'revoked', revoked_at = now(), revoked_by = pg_temp.id(99) WHERE id = pg_temp.id(101);
SELECT is(pg_temp.api('SELECT * FROM app.engagement_resolve_display(' || pg_temp.qh(1) || ')', 'n'), '0', 'the same hash stops resolving the moment the display is revoked');
UPDATE engagement.queue_displays SET status = 'active', revoked_at = NULL, revoked_by = NULL WHERE id = pg_temp.id(101);

-- ---------------------------------------------------------------- (b) a lims_app / lims_api session that sets the GUC itself sees nothing (owner-only policies, FORCE RLS)
SELECT is(pg_temp.x('lims_api', NULL, 'SELECT set_config(''app.pre_engagement_display_token_sha256'', encode(' || pg_temp.qh(1) || ', ''hex''), true)',
                    'SELECT * FROM engagement.queue_displays', 'n'), '0', 'lims_api, no claims, own display-token GUC set -> 0 rows of queue_displays');
SELECT is(pg_temp.x('lims_app', NULL, 'SELECT set_config(''app.pre_engagement_display_token_sha256'', encode(' || pg_temp.qh(1) || ', ''hex''), true)',
                    'SELECT * FROM engagement.queue_displays', 'n'), '0', 'lims_app, no claims, own display-token GUC set -> 0 rows of queue_displays');
SELECT is(pg_temp.x('lims_api', pg_temp.cl('patient', 41), 'SELECT set_config(''app.pre_engagement_display_token_sha256'', encode(' || pg_temp.qh(1) || ', ''hex''), true)',
                    'SELECT * FROM engagement.queue_displays', 'n'), '0', 'lims_api, patient claims of tenant A, own GUC set -> 0 rows of queue_displays');
SELECT is(pg_temp.x('lims_app', NULL, 'SELECT set_config(''app.pre_tenant_id'', ' || quote_literal(pg_temp.id(1)::text) || ', true)', 'SELECT * FROM core.tenants', 'n'), '0',
          'lims_app, no claims, own app.pre_tenant_id set -> 0 rows of core.tenants');
SELECT is(pg_temp.x('lims_api', NULL, 'SELECT set_config(''app.pre_tenant_id'', ' || quote_literal(pg_temp.id(1)::text) || ', true)', 'SELECT * FROM core.tenants', 'n'), '0',
          'lims_api, no claims, own app.pre_tenant_id set -> 0 rows of core.tenants');
SELECT is(pg_temp.x('lims_api', NULL, 'SELECT set_config(''app.pre_engagement_display_token_sha256'', encode(' || pg_temp.qh(1) || ', ''hex''), true)',
                    'UPDATE engagement.queue_displays SET status = ''revoked'', revoked_at = now(), revoked_by = id', 'w'), '0', 'the own GUC does not allow a write either (0 rows updated)');

-- ---------------------------------------------------------------- (c) both GUCs are '' after return: hit, miss, suspended tenant, NULL
CREATE FUNCTION pg_temp.gucs_after(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE r text; g text; bad text := '';
BEGIN
  PERFORM set_config('app.pre_engagement_display_token_sha256', '', true); PERFORM set_config('app.pre_tenant_id', '', true);
  r := pg_temp.api(p_sql);
  FOREACH g IN ARRAY ARRAY['app.pre_engagement_display_token_sha256', 'app.pre_tenant_id'] LOOP
    IF coalesce(current_setting(g, true), '<unset>') <> '' THEN bad := bad || g || '=' || coalesce(current_setting(g, true), '<unset>') || ' '; END IF;
  END LOOP;
  RETURN CASE WHEN r LIKE 'E%' THEN r ELSE 'ok:' || bad END;
END $$;
SELECT is(pg_temp.gucs_after('SELECT count(*) FROM app.engagement_resolve_display(' || pg_temp.qh(1) || ')'), 'ok:', 'GUCs empty after a hit');
SELECT is(pg_temp.gucs_after('SELECT count(*) FROM app.engagement_resolve_display(' || pg_temp.qh(99) || ')'), 'ok:', 'GUCs empty after a miss');
SELECT is(pg_temp.gucs_after('SELECT count(*) FROM app.engagement_resolve_display(' || pg_temp.qh(3) || ')'), 'ok:', 'GUCs empty after a revoked display');
SELECT is(pg_temp.gucs_after('SELECT count(*) FROM app.engagement_resolve_display(' || pg_temp.qh(5) || ')'), 'ok:', 'GUCs empty after a suspended tenant');
SELECT is(pg_temp.gucs_after('SELECT count(*) FROM app.engagement_resolve_display(NULL)'), 'ok:', 'GUCs empty after NULL');

-- ---------------------------------------------------------------- DISP policy + device guard (05-SCHEMA §4, §5.1): the display's own claims
SELECT is(pg_temp.x('lims_api', pg_temp.cl('device', 101, 21, 'queue_display'), NULL, 'SELECT * FROM engagement.queue_displays', 'n'), '1', 'display 101 reads exactly its own queue_displays row (id = actor id)');
SELECT is(pg_temp.x('lims_api', pg_temp.cl('device', 101, 21, 'queue_display'), NULL, 'SELECT * FROM engagement.queue_displays WHERE tenant_id = ' || quote_literal(pg_temp.id(2)::text) || '::uuid', 'n'), '0', 'display 101 sees no tenant-B display');
SELECT is(pg_temp.x('lims_api', pg_temp.cl('device', 101, 21, 'queue_display'), NULL, 'SELECT * FROM engagement.booking_centres', 'n'), '1', 'display 101 reads only the booking_centres row of its own centre (centre name for the board)');
SELECT is(pg_temp.x('lims_api', pg_temp.cl('device', 101, 21, 'queue_display'), NULL, 'UPDATE engagement.queue_displays SET last_seen_at = now(), updated_at = now()', 'w'), '1', 'display may update last_seen_at / updated_at');
SELECT like(pg_temp.x('lims_api', pg_temp.cl('device', 101, 21, 'queue_display'), NULL, 'UPDATE engagement.queue_displays SET display_name = ''renamed''', 'w'), 'EP0001:immutable_row%', 'display cannot change display_name (guard trigger immutable_row)');
SELECT like(pg_temp.x('lims_api', pg_temp.cl('device', 101, 21, 'queue_display'), NULL, 'UPDATE engagement.queue_displays SET status = ''active'', token_sha256 = ' || pg_temp.qh(77), 'w'), 'EP0001:immutable_row%', 'display cannot swap its own token hash');
SELECT ok(pg_temp.x('lims_api', pg_temp.cl('device', 101, 21, 'queue_display'), NULL, 'INSERT INTO engagement.queue_displays (id, tenant_id, centre_id, display_name, queue_ids, token_sha256, paired_at, paired_by, created_by, updated_by) SELECT gen_random_uuid(), tenant_id, centre_id, ''x'', queue_ids, ' || pg_temp.qh(78) || ', now(), id, id, id FROM engagement.queue_displays', 'w') ~ '^E', 'display cannot INSERT displays (RLS/privilege error)');

SELECT * FROM finish();
ROLLBACK;
