-- T0B-08 DEFINER contract tests, platform stage (T0B-05 objects; AC-0B-2.4; 05-SCHEMA §4.3 owner-policy rule; §10 schema tests 13, 16, 22, 27, 29, 31):
--   app.purge_event_log / purge_event_inboxes / purge_idempotency_keys / purge_dead_letters, app.dl_list_platform, app.platform_list_tenants,
--   app.cron_tenant_ids, app.core_resolve_tenant_code, app.identity_tenants_for_email_hmacs.
-- Every test asserts relforcerowsecurity = true on the touched tables first, then non-empty results where the fixture expects rows, and that
-- current_setting('app.maintenance', true) / app.pre_tenant_code is '' after the function returns (08 A12.7, A15.3).
-- Objects that do not exist yet (T0B-05 not merged) are reported with an explicit skip(); this file must be green with nothing skipped once T0B-05 lands.
-- Re-run on the pinned supabase/postgres:17.6.1.136 image by db/tests/run-suites.sh (review C0 m#33).
-- Run from the repo root: pg_prove -d <db> db/tests/definers/T0B-08_contracts_platform.test.sql   (superuser; pgTAP in schema `extensions`)
BEGIN;
SET search_path = extensions, public, pg_catalog;
SELECT * FROM no_plan();
\ir ../fixtures/T0B-06_identity_standin.sql

CREATE FUNCTION pg_temp.id(k text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('01900000-0000-7000-8000-0000000000' || lpad(k, 2, '0'))::uuid $$;
CREATE FUNCTION pg_temp.x(p_role text, p_claims text, p_sql text, p_mode text DEFAULT 'v') RETURNS text LANGUAGE plpgsql AS $f$
DECLARE r text; n bigint;
BEGIN
  PERFORM set_config('request.jwt.claims', coalesce(p_claims, ''), true);
  EXECUTE format('SET LOCAL ROLE %I', p_role);
  BEGIN
    IF p_mode = 'v' THEN EXECUTE p_sql INTO r; r := coalesce(r, '<null>');
    ELSIF p_mode = 'n' THEN EXECUTE 'SELECT count(*) FROM (' || p_sql || ') t' INTO n; r := 'n=' || n;
    ELSE EXECUTE p_sql; GET DIAGNOSTICS n = ROW_COUNT; r := 'n=' || n; END IF;
  EXCEPTION WHEN OTHERS THEN r := 'E' || SQLSTATE || ':' || SQLERRM; END;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN r;
END $f$;
CREATE FUNCTION pg_temp.chk(p_exists boolean, p_got text, p_want text, p_descr text) RETURNS text LANGUAGE plpgsql AS $f$
BEGIN
  IF NOT p_exists THEN RETURN skip('object not present yet: ' || p_descr, 1); END IF;
  RETURN is(p_got, p_want, p_descr);
END $f$;
CREATE FUNCTION pg_temp.pcl(p_staff text, p_sub text, p_aal text DEFAULT 'aal2') RETURNS text LANGUAGE sql AS $$
  SELECT jsonb_build_object('scope','platform','aal',p_aal,'platform_staff_id',pg_temp.id(p_staff),'sub',pg_temp.id(p_sub))::text $$;
CREATE FUNCTION pg_temp.sys() RETURNS text LANGUAGE sql AS $$   -- core system actor, no tenant (cron fan-out / purge callers)
  SELECT jsonb_build_object('actor_type','system','sub',pg_temp.id('90'),'scope','system')::text $$;

-- ---------- fixtures: tenants A (active) B (suspended) C (offboarded), platform staff, tenant users with email_hmac ----------
SET LOCAL session_replication_role = replica;
INSERT INTO core.tenants (id, tenant_code, legal_name, display_name, status, created_by, updated_by) VALUES
  (pg_temp.id('01'), 'lab_a', 'Lab A Pvt Ltd', 'Lab A', 'active',     pg_temp.id('99'), pg_temp.id('99')),
  (pg_temp.id('02'), 'lab_b', 'Lab B Pvt Ltd', 'Lab B', 'suspended',  pg_temp.id('99'), pg_temp.id('99')),
  (pg_temp.id('03'), 'lab_c', 'Lab C Pvt Ltd', 'Lab C', 'offboarded', pg_temp.id('99'), pg_temp.id('99'));
INSERT INTO core.users (tenant_id, id, display_name, email_hmac, created_by, updated_by) VALUES
  (pg_temp.id('01'), pg_temp.id('31'), 'User 31', decode(repeat('ab', 32), 'hex'), pg_temp.id('99'), pg_temp.id('99')),
  (pg_temp.id('02'), pg_temp.id('33'), 'User 33', decode(repeat('ab', 32), 'hex'), pg_temp.id('99'), pg_temp.id('99'));
INSERT INTO identity.platform_staff (id, user_id, email_normalized, display_name, role_code, is_active, created_by, updated_by) VALUES
  (pg_temp.id('61'), pg_temp.id('81'), 'a@example.test', 'Staff A', 'platform_admin', true, pg_temp.id('99'), pg_temp.id('99')) ON CONFLICT DO NOTHING;
SET LOCAL session_replication_role = origin;

-- ======================================================================== app.cron_tenant_ids (schema test 22)
SELECT pg_temp.chk(to_regprocedure('app.cron_tenant_ids()') IS NOT NULL, (SELECT relforcerowsecurity::text FROM pg_class WHERE oid = 'core.tenants'::regclass), 'true',
  'schema test 22: core.tenants has relforcerowsecurity = true before app.cron_tenant_ids runs');
SELECT pg_temp.chk(to_regprocedure('app.cron_tenant_ids()') IS NOT NULL,
  pg_temp.x('lims_worker', pg_temp.sys(), format($q$WITH r AS MATERIALIZED (SELECT array_agg(c ORDER BY c) a FROM app.cron_tenant_ids() c)
     SELECT (a = ARRAY[%L, %L]::uuid[])::text || ':' || coalesce(current_setting('app.maintenance', true), '<null>') FROM r$q$, pg_temp.id('01'), pg_temp.id('02'))),
  'true:', 'schema test 22: cron_tenant_ids returns exactly the active and suspended ids, and app.maintenance is '''' afterwards');
SELECT pg_temp.chk(to_regprocedure('app.cron_tenant_ids()') IS NOT NULL,
  (SELECT has_function_privilege('lims_api', to_regprocedure('app.cron_tenant_ids()'), 'EXECUTE')::text), 'false', 'schema test 22: lims_api has no EXECUTE on cron_tenant_ids');
SELECT pg_temp.chk(to_regprocedure('app.cron_tenant_ids()') IS NOT NULL,
  (SELECT has_function_privilege('public', to_regprocedure('app.cron_tenant_ids()'), 'EXECUTE')::text), 'false', 'schema test 22: PUBLIC has no EXECUTE on cron_tenant_ids');

-- ======================================================================== app.core_resolve_tenant_code / app.identity_tenants_for_email_hmacs (schema test 29)
SELECT pg_temp.chk(to_regprocedure('app.core_resolve_tenant_code(text)') IS NOT NULL,
  pg_temp.x('lims_api', NULL, format($$SELECT t.tenant_id || ':' || t.status || ':' || coalesce(nullif(current_setting('app.pre_tenant_code', true), ''), 'reset') FROM app.core_resolve_tenant_code(%L) t$$, 'lab_b')),
  pg_temp.id('02') || ':suspended:reset', 'schema test 29: core_resolve_tenant_code returns (tenant_id, status) for a known code of any status and resets app.pre_tenant_code');
SELECT pg_temp.chk(to_regprocedure('app.core_resolve_tenant_code(text)') IS NOT NULL,
  pg_temp.x('lims_api', NULL, $$SELECT * FROM app.core_resolve_tenant_code('nope')$$, 'n'), 'n=0', 'schema test 29: unknown code -> 0 rows');
SELECT pg_temp.chk(to_regprocedure('app.core_resolve_tenant_code(text)') IS NOT NULL,
  pg_temp.x('lims_api', NULL, $$SELECT * FROM app.core_resolve_tenant_code(NULL)$$, 'n'), 'n=0', 'schema test 29: NULL code -> 0 rows');
SELECT pg_temp.chk(to_regprocedure('app.identity_tenants_for_email_hmacs(bytea[])') IS NOT NULL,
  pg_temp.x('lims_worker', pg_temp.sys(), format($$SELECT count(*) || ':' || coalesce(current_setting('app.maintenance', true), '<null>') FROM app.identity_tenants_for_email_hmacs(ARRAY[decode(repeat('ab', 32), 'hex')])$$)),
  '2:', 'schema test 29: identity_tenants_for_email_hmacs returns the distinct tenants of matching users and resets app.maintenance');
SELECT pg_temp.chk(to_regprocedure('app.identity_tenants_for_email_hmacs(bytea[])') IS NOT NULL,
  pg_temp.x('lims_worker', pg_temp.sys(), $$SELECT * FROM app.identity_tenants_for_email_hmacs((SELECT array_agg(decode(lpad(to_hex(g), 64, '0'), 'hex')) FROM generate_series(1, 101) g))$$, 'n'),
  'EP0001:identity_tenants_for_email_hmacs_invalid_input', 'schema test 29: more than 100 values raises identity_tenants_for_email_hmacs_invalid_input');
SELECT pg_temp.chk(to_regprocedure('app.identity_tenants_for_email_hmacs(bytea[])') IS NOT NULL,
  (SELECT has_function_privilege('lims_api', to_regprocedure('app.identity_tenants_for_email_hmacs(bytea[])'), 'EXECUTE')::text), 'false', 'schema test 29: lims_api has no EXECUTE on identity_tenants_for_email_hmacs');

-- ======================================================================== app.platform_list_tenants (schema test 16)
SELECT pg_temp.chk(to_regprocedure('app.platform_list_tenants(text,text,text,timestamptz,uuid,integer)') IS NOT NULL,
  (SELECT (c.relforcerowsecurity AND s.relforcerowsecurity)::text FROM pg_class c, pg_class s WHERE c.oid = 'core.tenants'::regclass AND s.oid = 'identity.platform_staff'::regclass), 'true',
  'schema test 16: core.tenants and identity.platform_staff have relforcerowsecurity = true');
SELECT pg_temp.chk(to_regprocedure('app.platform_list_tenants(text,text,text,timestamptz,uuid,integer)') IS NOT NULL,
  pg_temp.x('lims_api', pg_temp.pcl('61','81'), $$SELECT * FROM app.platform_list_tenants('code')$$, 'n'), 'n=3', 'schema test 16(a): platform claims list every seeded tenant once');
SELECT pg_temp.chk(to_regprocedure('app.platform_list_tenants(text,text,text,timestamptz,uuid,integer)') IS NOT NULL,
  pg_temp.x('lims_api', pg_temp.pcl('61','81'), $$SELECT * FROM app.platform_list_tenants('code', 'active')$$, 'n'), 'n=1', 'schema test 16(a): p_status narrows');
SELECT pg_temp.chk(to_regprocedure('app.platform_list_tenants(text,text,text,timestamptz,uuid,integer)') IS NOT NULL,
  pg_temp.x('lims_api', pg_temp.pcl('61','81'), $$SELECT string_agg(tenant_code, ',' ORDER BY ordinality) FROM app.platform_list_tenants('code') WITH ORDINALITY$$), 'lab_a,lab_b,lab_c', 'schema test 16(a): code order ascending');
SELECT pg_temp.chk(to_regprocedure('app.platform_list_tenants(text,text,text,timestamptz,uuid,integer)') IS NOT NULL,
  pg_temp.x('lims_api', pg_temp.pcl('61','81', 'aal1'), $$SELECT * FROM app.platform_list_tenants('code')$$, 'n'), 'n=0', 'schema test 16: aal1 platform claims -> 0 rows');
SELECT pg_temp.chk(to_regprocedure('app.platform_list_tenants(text,text,text,timestamptz,uuid,integer)') IS NOT NULL,
  pg_temp.x('lims_api', jsonb_build_object('actor_type','user','tenant_id',pg_temp.id('01'),'sub',pg_temp.id('31'))::text, $$SELECT * FROM app.platform_list_tenants('code')$$, 'n'), 'n=0',
  'schema test 16: tenant claims -> 0 rows');
SELECT pg_temp.chk(to_regprocedure('app.platform_list_tenants(text,text,text,timestamptz,uuid,integer)') IS NOT NULL,
  pg_temp.x('lims_api', pg_temp.pcl('61','81'), $$SELECT * FROM app.platform_list_tenants('name')$$, 'n'), 'EP0001:platform_list_tenants_invalid_input', 'schema test 16: p_sort = ''name'' raises platform_list_tenants_invalid_input');
SELECT pg_temp.chk(to_regprocedure('app.platform_list_tenants(text,text,text,timestamptz,uuid,integer)') IS NOT NULL,
  pg_temp.x('lims_api', pg_temp.pcl('61','81'), $$SELECT count(*) FROM (SELECT * FROM app.platform_list_tenants('code', NULL, NULL, NULL, NULL, 1000)) q WHERE to_jsonb(q) ?| ARRAY['status_reason','created_by','updated_by']$$), '0',
  'schema test 16(a): the result has no status_reason / created_by / updated_by column');

-- ======================================================================== platform tables: dl_list_platform, purges, platform idempotency keys (schema tests 13, 27, 31)
DO $do$ BEGIN
  IF to_regclass('core.dead_letters') IS NOT NULL AND to_regclass('core.event_log') IS NOT NULL AND to_regclass('core.idempotency_keys') IS NOT NULL THEN
    SET LOCAL session_replication_role = replica;
    -- 10,050 expired + 5 unexpired rows per table (schema test 31: more than one 10,000-row batch)
    INSERT INTO core.event_log (tenant_id, event_id, event_type, producer, idempotency_key, aggregate_type, aggregate_id, aggregate_seq, occurred_at, envelope, created_at, created_by)
      SELECT pg_temp.id('01'), gen_random_uuid(), 't.e', 'p', 'k' || g, 'x', gen_random_uuid(), 1, now(), '{}',
             CASE WHEN g <= 10050 THEN now() - interval '100 days' ELSE now() END, pg_temp.id('99') FROM generate_series(1, 10055) g;
    INSERT INTO core.idempotency_keys (tenant_id, actor_id, key, method, route, request_sha256, state, created_at, expires_at)
      SELECT pg_temp.id('01'), pg_temp.id('99'), 'k' || g, 'POST', '/x', decode(repeat('00', 32), 'hex'), 'in_progress', now() - interval '3 days',
             CASE WHEN g <= 10050 THEN now() - interval '1 day' ELSE now() + interval '1 day' END FROM generate_series(1, 10055) g;
    INSERT INTO core.idempotency_keys (tenant_id, actor_id, key, method, route, request_sha256, state, created_at, expires_at)
      VALUES (NULL, pg_temp.id('98'), 'platexp', 'POST', '/p', decode(repeat('00', 32), 'hex'), 'in_progress', now() - interval '3 days', now() - interval '1 day');
    INSERT INTO core.dead_letters (id, tenant_id, task_identifier, job_payload, last_error_code, last_error_message_redacted, attempts, first_failed_at, dead_at, state, resolved_by, resolved_at, created_by)
      SELECT gen_random_uuid(), pg_temp.id('01'), 'lab.t', '{}', 'E', 'm', 1, now() - interval '200 days', now() - interval '200 days',
             CASE WHEN g <= 10050 THEN 'discarded' ELSE 'open' END,
             CASE WHEN g <= 10050 THEN pg_temp.id('99') END, CASE WHEN g <= 10050 THEN now() - interval '100 days' END, pg_temp.id('99') FROM generate_series(1, 10055) g;
    INSERT INTO core.dead_letters (id, tenant_id, task_identifier, job_payload, last_error_code, last_error_message_redacted, attempts, first_failed_at, dead_at, state, resolved_by, resolved_at, created_by) VALUES
      (pg_temp.id('61'), NULL, 'core.t', '{}', 'E', 'm', 1, now(), now(), 'open', NULL, NULL, pg_temp.id('99')),
      (pg_temp.id('62'), NULL, 'core.t', '{}', 'E', 'm', 1, now() - interval '200 days', now() - interval '200 days', 'discarded', pg_temp.id('99'), now() - interval '100 days', pg_temp.id('99')),
      (pg_temp.id('63'), pg_temp.id('01'), 'lab.t', '{}', 'E', 'm', 1, now(), now(), 'discarded', pg_temp.id('99'), now(), pg_temp.id('99'));
    SET LOCAL session_replication_role = origin;
  END IF;
END $do$;
SET LOCAL statement_timeout = 300000;   -- schema test 31: purges run under the worker's statement timeout

-- app.dl_list_platform: returns its seeded platform rows (2 NULL-tenant rows) to platform claims only; lims_worker has no EXECUTE
SELECT pg_temp.chk(to_regprocedure('app.dl_list_platform(text,text,timestamptz,timestamptz,timestamptz,uuid,integer,uuid)') IS NOT NULL,
  (SELECT relforcerowsecurity::text FROM pg_class WHERE oid = to_regclass('core.dead_letters')), 'true', 'schema test 13: core.dead_letters has relforcerowsecurity = true before dl_list_platform runs');
SELECT pg_temp.chk(to_regprocedure('app.dl_list_platform(text,text,timestamptz,timestamptz,timestamptz,uuid,integer,uuid)') IS NOT NULL,
  pg_temp.x('lims_api', pg_temp.pcl('61','81'), 'SELECT * FROM app.dl_list_platform()', 'n'), 'n=2', 'schema test 13: dl_list_platform returns its seeded platform rows (non-empty under FORCE RLS)');
SELECT pg_temp.chk(to_regprocedure('app.dl_list_platform(text,text,timestamptz,timestamptz,timestamptz,uuid,integer,uuid)') IS NOT NULL,
  pg_temp.x('lims_api', pg_temp.pcl('61','81'), $$SELECT * FROM app.dl_list_platform(p_state => 'open')$$, 'n'), 'n=1', 'schema test 10: p_state narrows');
SELECT pg_temp.chk(to_regprocedure('app.dl_list_platform(text,text,timestamptz,timestamptz,timestamptz,uuid,integer,uuid)') IS NOT NULL,
  pg_temp.x('lims_api', pg_temp.pcl('61','81', 'aal1'), 'SELECT * FROM app.dl_list_platform()', 'n'), 'n=0', 'schema test 10: aal1 platform claims -> 0 rows');
SELECT pg_temp.chk(to_regprocedure('app.dl_list_platform(text,text,timestamptz,timestamptz,timestamptz,uuid,integer,uuid)') IS NOT NULL,
  pg_temp.x('lims_api', jsonb_build_object('actor_type','user','tenant_id',pg_temp.id('01'),'sub',pg_temp.id('31'))::text, 'SELECT * FROM app.dl_list_platform()', 'n'), 'n=0', 'schema test 10: tenant claims -> 0 rows');
SELECT pg_temp.chk(to_regprocedure('app.dl_list_platform(text,text,timestamptz,timestamptz,timestamptz,uuid,integer,uuid)') IS NOT NULL,
  (SELECT has_function_privilege('lims_worker', to_regprocedure('app.dl_list_platform(text,text,timestamptz,timestamptz,timestamptz,uuid,integer,uuid)'), 'EXECUTE')::text), 'false', 'schema test 12: lims_worker has no EXECUTE on dl_list_platform');

-- platform idempotency keys (schema test 27): replay path, aal1 / tenant claims see no NULL-tenant row
SELECT pg_temp.chk(to_regclass('core.idempotency_keys') IS NOT NULL,
  pg_temp.x('lims_api', pg_temp.pcl('61','81'), $$INSERT INTO core.idempotency_keys (tenant_id, actor_id, key, method, route, request_sha256, state, expires_at)
    VALUES (NULL, app.current_actor_id(), 'plat1', 'POST', '/p', decode(repeat('00', 32), 'hex'), 'in_progress', now() + interval '1 day')
    ON CONFLICT (tenant_id, actor_id, key) DO NOTHING RETURNING key$$), 'plat1', 'schema test 27: first NULL-tenant insert returns the key');
SELECT pg_temp.chk(to_regclass('core.idempotency_keys') IS NOT NULL,
  pg_temp.x('lims_api', pg_temp.pcl('61','81'), $$INSERT INTO core.idempotency_keys (tenant_id, actor_id, key, method, route, request_sha256, state, expires_at)
    VALUES (NULL, app.current_actor_id(), 'plat1', 'POST', '/p', decode(repeat('00', 32), 'hex'), 'in_progress', now() + interval '1 day')
    ON CONFLICT (tenant_id, actor_id, key) DO NOTHING RETURNING key$$), '<null>', 'schema test 27: the replay returns nothing');
SELECT pg_temp.chk(to_regclass('core.idempotency_keys') IS NOT NULL,
  pg_temp.x('lims_api', pg_temp.pcl('61','81', 'aal1'), 'SELECT 1 FROM core.idempotency_keys WHERE tenant_id IS NULL', 'n'), 'n=0', 'schema test 27: aal1 platform claims see no NULL-tenant key');
SELECT pg_temp.chk(to_regclass('core.idempotency_keys') IS NOT NULL,
  pg_temp.x('lims_api', jsonb_build_object('actor_type','user','tenant_id',pg_temp.id('01'),'sub',pg_temp.id('99'))::text, 'SELECT 1 FROM core.idempotency_keys WHERE tenant_id IS NULL', 'n'), 'n=0',
  'schema test 27: tenant claims see no NULL-tenant key');

-- purges: FORCE RLS on, delete exactly the 10,050 expired rows in one call (capped = false), keep the unexpired, GUC '' afterwards
SELECT pg_temp.chk(to_regprocedure('app.purge_event_log()') IS NOT NULL,
  (SELECT relforcerowsecurity::text FROM pg_class WHERE oid = to_regclass('core.event_log')), 'true', 'schema test 13: core.event_log has relforcerowsecurity = true before purge_event_log runs');
SELECT pg_temp.chk(to_regprocedure('app.purge_event_log()') IS NOT NULL,
  pg_temp.x('lims_worker', pg_temp.sys(), $$SELECT deleted || ',' || capped || ',' || coalesce(current_setting('app.maintenance', true), '<null>') FROM app.purge_event_log()$$),
  '10050,false,', 'schema tests 13/31: purge_event_log deletes its 10,050 seeded expired rows, capped = false, app.maintenance is empty afterwards');
SELECT pg_temp.chk(to_regclass('core.event_log') IS NOT NULL, (SELECT CASE WHEN to_regclass('core.event_log') IS NULL THEN NULL ELSE (xpath('/row/c/text()', query_to_xml('SELECT count(*) AS c FROM core.event_log', false, true, '')))[1]::text END), '5', 'schema test 31: the 5 unexpired event_log rows remain');

SELECT pg_temp.chk(to_regprocedure('app.purge_idempotency_keys()') IS NOT NULL,
  (SELECT relforcerowsecurity::text FROM pg_class WHERE oid = to_regclass('core.idempotency_keys')), 'true', 'schema test 13: core.idempotency_keys has relforcerowsecurity = true before purge_idempotency_keys runs');
SELECT pg_temp.chk(to_regprocedure('app.purge_idempotency_keys()') IS NOT NULL,
  pg_temp.x('lims_worker', pg_temp.sys(), $$SELECT deleted || ',' || capped || ',' || coalesce(current_setting('app.maintenance', true), '<null>') FROM app.purge_idempotency_keys()$$),
  '10051,false,', 'schema tests 13/27/31: purge_idempotency_keys deletes 10,050 tenant rows and the expired NULL-tenant row, capped = false, GUC reset');
SELECT pg_temp.chk(to_regclass('core.idempotency_keys') IS NOT NULL, (SELECT CASE WHEN to_regclass('core.idempotency_keys') IS NULL THEN NULL ELSE (xpath('/row/c/text()', query_to_xml('SELECT count(*) AS c FROM core.idempotency_keys', false, true, '')))[1]::text END), '6', 'schema test 31: 5 unexpired tenant keys and the platform key remain');

SELECT pg_temp.chk(to_regprocedure('app.purge_dead_letters()') IS NOT NULL,
  (SELECT relforcerowsecurity::text FROM pg_class WHERE oid = to_regclass('core.dead_letters')), 'true', 'schema test 13: core.dead_letters has relforcerowsecurity = true before purge_dead_letters runs');
SELECT pg_temp.chk(to_regprocedure('app.purge_dead_letters()') IS NOT NULL,
  pg_temp.x('lims_worker', pg_temp.sys(), $$SELECT deleted || ',' || capped || ',' || coalesce(current_setting('app.maintenance', true), '<null>') FROM app.purge_dead_letters()$$),
  '10051,false,', 'schema tests 13/31: purge_dead_letters deletes 10,050 tenant rows and the old NULL-tenant row, capped = false, GUC reset');
SELECT pg_temp.chk(to_regclass('core.dead_letters') IS NOT NULL, (SELECT CASE WHEN to_regclass('core.dead_letters') IS NULL THEN NULL ELSE (xpath('/row/c/text()', query_to_xml('SELECT count(*) AS c FROM core.dead_letters', false, true, '')))[1]::text END), '7', 'schema test 31: open rows and the recently resolved row remain (5 + 1 + 1)');

-- purge_event_inboxes needs all 16 <m>.event_inbox tables (05-SCHEMA §3.9); explicit skip until they exist
SELECT pg_temp.chk((SELECT count(*) = 16 FROM pg_class c WHERE c.relname = 'event_inbox' AND c.relkind = 'r') AND to_regprocedure('app.purge_event_inboxes()') IS NOT NULL,
  pg_temp.x('lims_worker', pg_temp.sys(), $$SELECT deleted || ',' || capped || ',' || coalesce(current_setting('app.maintenance', true), '<null>') FROM app.purge_event_inboxes()$$),
  '0,false,', 'schema test 13: purge_event_inboxes runs over the 16 inbox tables under FORCE RLS and resets the GUC');

-- schema test 23 (DB half): version-guarded __platform UPDATE open -> replayed on a tenant dead letter; a stale version changes 0 rows.
-- (The enqueue_job half, job_tenant_mismatch under platform claims and the withTenantScope switch, needs graphile_worker (SP-2) and is asserted by T0D-08/T0D-09.)
CREATE TEMP TABLE dl_open(id uuid);
DO $do$ BEGIN
  IF to_regclass('core.dead_letters') IS NOT NULL THEN
    INSERT INTO dl_open SELECT id FROM core.dead_letters WHERE tenant_id IS NOT NULL AND state = 'open' LIMIT 1;
  END IF;
END $do$;
SELECT pg_temp.chk(to_regclass('core.dead_letters') IS NOT NULL,
  pg_temp.x('lims_api', pg_temp.pcl('61','81'), format($$UPDATE core.dead_letters SET state = 'replayed', resolved_by = app.current_actor_id(), resolved_at = now(), version = version + 1
    WHERE id = %L AND version = 1 AND state = 'open'$$, (SELECT id FROM dl_open)), 'w'), 'n=1', 'schema test 23: platform claims replay an open tenant dead letter at version 1');
SELECT pg_temp.chk(to_regclass('core.dead_letters') IS NOT NULL,
  pg_temp.x('lims_api', pg_temp.pcl('61','81'), format($$UPDATE core.dead_letters SET state = 'replayed', resolved_by = app.current_actor_id(), resolved_at = now(), version = version + 1
    WHERE id = %L AND version = 1 AND state = 'open'$$, (SELECT id FROM dl_open)), 'w'), 'n=0', 'schema test 23: the stale version changes 0 rows');
SELECT pg_temp.chk(to_regclass('core.dead_letters') IS NOT NULL,
  pg_temp.x('lims_api', pg_temp.pcl('61','81', 'aal1'), format($$UPDATE core.dead_letters SET state = 'discarded' WHERE id = %L$$, (SELECT id FROM dl_open)), 'w'), 'n=0',
  'schema test 23/14: aal1 platform claims change no dead letter');

-- the purges are worker-only
SELECT pg_temp.chk(to_regprocedure('app.' || f || '()') IS NOT NULL, (SELECT has_function_privilege('lims_api', to_regprocedure('app.' || f || '()'), 'EXECUTE')::text), 'false', 'lims_api has no EXECUTE on app.' || f)
  FROM unnest(ARRAY['purge_event_log','purge_event_inboxes','purge_idempotency_keys','purge_dead_letters']) f;

SELECT * FROM finish();
ROLLBACK;
