-- T0B-05 live-DB assertions (pgTAP): platform tables, <m>.event_inbox, app.enqueue_job / queue_depth, rate limit, purges, dead-letter functions, triggers.
-- Covers 05-SCHEMA §10 schema tests 7, 9, 10, 11, 12, 14, 15 (owner SELECT predicates), 22 (enqueue part), 23, 26 (catalog), 27, 29, 31; dedupe constraints
-- (AC-0D-5.3), AC-0B-4.2 / 4.3 (grants), AC-0B-2.4 (FORCE RLS asserted before every DEFINER contract test), AC-0D-5.7 / 5.8 / 5.10 / 5.11 / 5.12 / 5.14 / 5.15 / 5.16 (DB half).
-- Not repeated here (T0B-08 owns them, db/tests/definers/T0B-08_contracts_platform.test.sql): tests 13 and 16 in full, GUC-bound owner policy suite.
-- Synthetic data only. One rolled-back transaction. RLS is never disabled. Does NOT need graphile_worker: enqueue_job / queue_depth behaviour is in T0B-05_queue.test.sql.
-- Run from the repo root: pg_prove -d <migrated db> db/tests/core/T0B-05_platform.test.sql   (superuser; pgTAP in schema `extensions`)
BEGIN;
SET search_path = extensions, public, pg_catalog;
SELECT * FROM no_plan();
\ir ../fixtures/T0B-06_identity_standin.sql

-- ---------------------------------------------------------------- helpers
CREATE FUNCTION pg_temp.id(k int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('01900000-0000-7000-8000-' || lpad(k::text, 12, '0'))::uuid $$;
-- run p_sql as p_role with claims p_claims (NULL = none); p_pre runs first in the same role (e.g. an "attacker" set_config). Modes: v scalar · n row count · w DML row count.
CREATE FUNCTION pg_temp.x(p_role text, p_claims text, p_pre text, p_sql text, p_mode text DEFAULT 'v') RETURNS text LANGUAGE plpgsql AS $f$
DECLARE r text; n bigint;
BEGIN
  PERFORM set_config('request.jwt.claims', coalesce(p_claims, ''), true);
  EXECUTE format('SET LOCAL ROLE %I', p_role);
  BEGIN
    IF p_pre IS NOT NULL THEN EXECUTE p_pre; END IF;
    IF p_mode = 'v' THEN EXECUTE p_sql INTO r; r := coalesce(r, '<null>');
    ELSIF p_mode = 'n' THEN EXECUTE 'SELECT count(*) FROM (' || p_sql || ') t' INTO n; r := n::text;
    ELSE EXECUTE p_sql; GET DIAGNOSTICS n = ROW_COUNT; r := n::text; END IF;
  EXCEPTION WHEN OTHERS THEN r := 'E' || SQLSTATE || ':' || SQLERRM; END;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN r;
END $f$;
CREATE FUNCTION pg_temp.tcl(p_tenant int, p_sub int, p_type text DEFAULT 'system') RETURNS text LANGUAGE sql AS $$
  SELECT jsonb_build_object('tenant_id', pg_temp.id(p_tenant), 'sub', pg_temp.id(p_sub), 'actor_type', p_type)::text $$;
CREATE FUNCTION pg_temp.pcl(p_staff int, p_sub int, p_aal text DEFAULT 'aal2') RETURNS text LANGUAGE sql AS $$
  SELECT jsonb_build_object('scope', 'platform', 'aal', p_aal, 'platform_staff_id', pg_temp.id(p_staff), 'sub', pg_temp.id(p_sub))::text $$;
CREATE FUNCTION pg_temp.sys() RETURNS text LANGUAGE sql AS $$ SELECT jsonb_build_object('actor_type', 'system', 'sub', pg_temp.id(90), 'scope', 'system')::text $$;
CREATE FUNCTION pg_temp.ev(p_tenant int, p_key text, p_by int, p_type text DEFAULT 'lab.sample_received') RETURNS text LANGUAGE sql AS $$
  SELECT format($q$INSERT INTO core.event_log (tenant_id, event_id, event_type, producer, idempotency_key, aggregate_type, aggregate_id, aggregate_seq, occurred_at, envelope, created_by)
    VALUES (%L, gen_random_uuid(), %L, 'lab', %L, 'sample', gen_random_uuid(), 1, now(), '{}'::jsonb, %L)$q$, pg_temp.id(p_tenant), p_type, p_key, pg_temp.id(p_by)) $$;
CREATE FUNCTION pg_temp.ik(p_tenant int, p_actor int, p_key text) RETURNS text LANGUAGE sql AS $$
  SELECT format($q$INSERT INTO core.idempotency_keys (tenant_id, actor_id, key, method, route, request_sha256, state, expires_at)
    VALUES (%s, %L, %L, 'POST', '/v1/x', decode(repeat('00', 32), 'hex'), 'in_progress', now() + interval '7 days')$q$,
    CASE WHEN p_tenant IS NULL THEN 'NULL' ELSE quote_literal(pg_temp.id(p_tenant)) END, pg_temp.id(p_actor), p_key) $$;
CREATE FUNCTION pg_temp.fp(p_role text, p_sig text) RETURNS text LANGUAGE sql AS $$
  SELECT CASE WHEN to_regprocedure(p_sig) IS NULL THEN '<missing>' ELSE has_function_privilege(p_role, to_regprocedure(p_sig), 'EXECUTE')::text END $$;

-- ---------------------------------------------------------------- 1. structure (AC-0B-2.4: FORCE RLS asserted first; AC-0B-4.2 / 4.3)
SELECT is((SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE c.relname IN ('event_log', 'dead_letters', 'idempotency_keys') AND n.nspname = 'core' AND c.relrowsecurity AND c.relforcerowsecurity), 3::bigint,
  'core.event_log, dead_letters, idempotency_keys: ENABLE + FORCE RLS');
SELECT is((SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE c.relname = 'event_inbox' AND c.relkind = 'r' AND c.relrowsecurity AND c.relforcerowsecurity
             AND n.nspname = ANY (ARRAY['identity','frontdesk','billing','lab','instruments','reporting','analytics','quality','micro','anatomic','inventory','partners','smartreport','payments','engagement','homecollection'])),
  16::bigint, '16 <m>.event_inbox tables, each ENABLE + FORCE RLS (§3.9)');
SELECT is((SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relname = 'event_inbox' AND c.relkind = 'r'), 16::bigint, 'exactly 16 event_inbox tables (no catalog, core, audit; 08 A31.4)');
SELECT is(to_regclass('catalog.event_inbox')::text, NULL, 'catalog has no event_inbox (08 A31.4)');
SELECT is((SELECT relpersistence::text FROM pg_class WHERE oid = to_regclass('core.rate_limit_counters')), 'u', 'core.rate_limit_counters is UNLOGGED');
SELECT is((SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('core.rate_limit_counters')), false, 'core.rate_limit_counters is RLS-exempt');
SELECT is((SELECT count(*) FROM pg_class WHERE oid IN (to_regclass('core.g_task_registry'), to_regclass('core.g_system_actors')) AND relrowsecurity), 0::bigint, 'class G tables have no RLS');
SELECT is((SELECT array_agg(p ORDER BY p) FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) p WHERE has_table_privilege('lims_app', 'core.event_log', p)), ARRAY['INSERT','SELECT'], 'AC-0B-4.3: lims_app has only SELECT, INSERT on core.event_log');
SELECT is((SELECT array_agg(p ORDER BY p) FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) p WHERE has_table_privilege('lims_app', 'core.dead_letters', p)), ARRAY['INSERT','SELECT','UPDATE'], 'lims_app: SELECT, INSERT, UPDATE on dead_letters (no DELETE, AC-0B-4.2)');
SELECT is((SELECT array_agg(p ORDER BY p) FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) p WHERE has_table_privilege('lims_app', 'core.idempotency_keys', p)), ARRAY['DELETE','INSERT','SELECT','UPDATE'], 'lims_app: all four on idempotency_keys');
SELECT is((SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE c.relname = 'event_inbox' AND c.relkind = 'r' AND (has_table_privilege('lims_app', c.oid, 'UPDATE') OR has_table_privilege('lims_app', c.oid, 'DELETE')
             OR NOT has_table_privilege('lims_app', c.oid, 'SELECT') OR NOT has_table_privilege('lims_app', c.oid, 'INSERT'))), 0::bigint, 'AC-0B-4.2/4.3: every event_inbox grants lims_app exactly SELECT, INSERT');
SELECT is((SELECT count(*) FROM unnest(ARRAY['lims_app','lims_api','lims_worker','lims_monitor','public']) r, unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) p
           WHERE has_table_privilege(r, 'core.rate_limit_counters', p)), 0::bigint, 'no role has any table privilege on core.rate_limit_counters');
SELECT is((SELECT has_table_privilege('lims_queue', 'core.g_task_registry', 'SELECT')), true, 'lims_queue can SELECT core.g_task_registry (enqueue_job runs as lims_queue)');
SELECT is((SELECT has_table_privilege('lims_app', 'core.g_task_registry', 'SELECT') AND NOT has_table_privilege('lims_app', 'core.g_task_registry', 'INSERT')), true, 'lims_app: SELECT only on g_task_registry');
SELECT is((SELECT count(*) FROM pg_indexes WHERE schemaname = 'core' AND indexname IN ('event_log__tenant_id_event_type_idempotency_key__uq', 'event_log__tenant_id_aggregate__idx', 'event_log__created_at__brin',
  'dead_letters__state_dead_at__idx', 'dead_letters__tenant_id_state_dead_at__idx', 'idempotency_keys__expires_at__idx', 'idempotency_keys__tenant_id_actor_id_key__uq')), 7::bigint, '§7 indexes exist');
SELECT is((SELECT count(*) FROM pg_constraint WHERE conrelid = 'core.idempotency_keys'::regclass AND contype = 'p'), 0::bigint, 'idempotency_keys has no primary key (D-213)');

-- function owners, DEFINER set, search_path (REQ-SEC-020)
SELECT is((SELECT array_agg(p.proname::text ORDER BY p.proname) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'app' AND p.proname IN ('enqueue_job','queue_depth') AND pg_get_userbyid(p.proowner) = 'lims_queue' AND p.prosecdef AND 'search_path=""' = ANY (p.proconfig)),
  ARRAY['enqueue_job','queue_depth'], 'enqueue_job and queue_depth: owner lims_queue, SECURITY DEFINER, search_path = ""');
SELECT is((SELECT array_agg(p.proname::text ORDER BY p.proname) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'app' AND p.proname = ANY (ARRAY['ratelimit_hit','purge_event_log','purge_event_inboxes','purge_idempotency_keys','purge_dead_letters','purge_ratelimit_counters',
             'dl_insert_platform','dl_list_platform','dl_resolve','platform_list_tenants','cron_tenant_ids','core_resolve_tenant_code','identity_tenants_for_email_hmacs'])
             AND pg_get_userbyid(p.proowner) = 'lims_owner' AND p.prosecdef AND 'search_path=""' = ANY (p.proconfig)),
  ARRAY['core_resolve_tenant_code','cron_tenant_ids','dl_insert_platform','dl_list_platform','dl_resolve','identity_tenants_for_email_hmacs','platform_list_tenants','purge_dead_letters','purge_event_inboxes','purge_event_log','purge_idempotency_keys','purge_ratelimit_counters','ratelimit_hit'],
  'the 13 other T0B-05 DEFINERs: owner lims_owner, SECURITY DEFINER, search_path = ""');
SELECT is((SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'app' AND p.proname = ANY (ARRAY['enqueue_job','queue_depth','ratelimit_hit','purge_event_log','purge_event_inboxes','purge_idempotency_keys','purge_dead_letters','purge_ratelimit_counters',
             'dl_insert_platform','dl_list_platform','dl_resolve','platform_list_tenants','cron_tenant_ids','core_resolve_tenant_code','identity_tenants_for_email_hmacs'])
             AND has_function_privilege('public', p.oid, 'EXECUTE')), 0::bigint, 'PUBLIC has EXECUTE on none of the T0B-05 functions');

-- EXECUTE matrix (05-SCHEMA §4.3; schema tests 12, 22, 29)
SELECT is(pg_temp.fp('lims_app',    'app.enqueue_job(text,jsonb,text,timestamptz,int)'), 'true',  'enqueue_job: lims_app EXECUTE');
SELECT is(pg_temp.fp('lims_api',    'app.enqueue_job(text,jsonb,text,timestamptz,int)'), 'true',  'enqueue_job: lims_api (member of lims_app) EXECUTE');
SELECT is(pg_temp.fp('lims_worker', 'app.queue_depth()'), 'true', 'queue_depth: lims_worker EXECUTE');
SELECT is(pg_temp.fp('lims_api',    'app.queue_depth()'), 'false', 'queue_depth: lims_api has none');
SELECT is(pg_temp.fp('lims_api',    'app.dl_insert_platform(uuid,text,jsonb,text,text,integer,timestamptz,text)'), 'false', 'schema test 12: lims_api has no EXECUTE on dl_insert_platform');
SELECT is(pg_temp.fp('lims_worker', 'app.dl_insert_platform(uuid,text,jsonb,text,text,integer,timestamptz,text)'), 'true', 'dl_insert_platform: lims_worker EXECUTE');
SELECT is(pg_temp.fp('lims_worker', 'app.dl_list_platform(text,text,timestamptz,timestamptz,timestamptz,uuid,integer,uuid)'), 'false', 'schema test 12: lims_worker has no EXECUTE on dl_list_platform');
SELECT is(pg_temp.fp('lims_worker', 'app.dl_resolve(uuid,integer,text,text)'), 'false', 'schema test 12: lims_worker has no EXECUTE on dl_resolve');
SELECT is(pg_temp.fp('lims_api',    'app.dl_resolve(uuid,integer,text,text)'), 'true', 'dl_resolve: lims_api EXECUTE');
SELECT is(pg_temp.fp('lims_api',    'app.dl_list_platform(text,text,timestamptz,timestamptz,timestamptz,uuid,integer,uuid)'), 'true', 'dl_list_platform: lims_api EXECUTE');
SELECT is(pg_temp.fp('lims_api',    'app.ratelimit_hit(text,int,int)'), 'true', 'ratelimit_hit: lims_api EXECUTE');
SELECT is(pg_temp.fp('lims_worker', 'app.ratelimit_hit(text,int,int)'), 'true', 'ratelimit_hit: lims_worker EXECUTE');
SELECT is(pg_temp.fp('lims_app',    'app.ratelimit_hit(text,int,int)'), 'false', 'ratelimit_hit: lims_app has none');
SELECT is(pg_temp.fp('lims_worker', 'app.cron_tenant_ids()'), 'true', 'schema test 22: cron_tenant_ids: lims_worker EXECUTE');
SELECT is(pg_temp.fp('lims_api',    'app.cron_tenant_ids()'), 'false', 'schema test 22: cron_tenant_ids: lims_api has none');
SELECT is(pg_temp.fp('lims_api',    'app.core_resolve_tenant_code(text)'), 'true', 'schema test 29: core_resolve_tenant_code: lims_api EXECUTE');
SELECT is(pg_temp.fp('lims_worker', 'app.core_resolve_tenant_code(text)'), 'false', 'core_resolve_tenant_code: lims_worker has none');
SELECT is(pg_temp.fp('lims_worker', 'app.identity_tenants_for_email_hmacs(bytea[])'), 'true', 'schema test 29: identity_tenants_for_email_hmacs: lims_worker EXECUTE');
SELECT is(pg_temp.fp('lims_api',    'app.identity_tenants_for_email_hmacs(bytea[])'), 'false', 'schema test 29: identity_tenants_for_email_hmacs: lims_api has none');
SELECT is(pg_temp.fp('lims_api',    'app.platform_list_tenants(text,text,text,timestamptz,uuid,integer)'), 'true', 'platform_list_tenants: lims_api EXECUTE');
SELECT is(pg_temp.fp('lims_worker', 'app.platform_list_tenants(text,text,text,timestamptz,uuid,integer)'), 'false', 'platform_list_tenants: lims_worker has none');
SELECT is((SELECT count(*) FROM unnest(ARRAY['purge_event_log()','purge_event_inboxes()','purge_idempotency_keys()','purge_dead_letters()','purge_ratelimit_counters()']) f
           WHERE pg_temp.fp('lims_worker', 'app.' || f) = 'true' AND pg_temp.fp('lims_api', 'app.' || f) = 'false' AND pg_temp.fp('lims_app', 'app.' || f) = 'false'), 5::bigint,
  'the 5 purges: lims_worker EXECUTE only');

-- policy catalog (schema tests 14, 15, 17, 26)
SELECT is((SELECT count(*) FROM pg_policies WHERE schemaname = 'core' AND policyname IN ('dead_letters__select__platform', 'dead_letters__update__platform') AND qual LIKE '%tenant_id IS NOT NULL%'), 2::bigint,
  'schema test 14: both dead_letters __platform policies contain tenant_id IS NOT NULL');
SELECT is((SELECT count(*) FROM pg_policies WHERE (qual ~ 'app\.pre_|app\.maintenance' OR with_check ~ 'app\.pre_|app\.maintenance') AND roles <> '{lims_owner}'), 0::bigint,
  'schema test 17: every policy mentioning app.pre_ / app.maintenance is TO lims_owner only');
SELECT is((SELECT count(*) FROM pg_policies WHERE roles = '{lims_owner}' AND schemaname || '.' || tablename IN ('core.event_log', 'core.idempotency_keys') AND (qual NOT LIKE '%app.maintenance%')), 0::bigint,
  'schema test 15: event_log / idempotency_keys owner policies are ANDed with app.maintenance');
SELECT is((SELECT count(*) FROM pg_policies WHERE roles = '{lims_owner}' AND tablename = 'event_inbox' AND qual NOT LIKE '%app.maintenance%'), 0::bigint, 'schema test 15: every event_inbox owner policy is gated on app.maintenance');
SELECT is((SELECT count(*) FROM pg_policies WHERE (qual ~ 'current_centre_ids' AND qual !~ '::uuid\[\]') OR (with_check ~ 'current_centre_ids' AND with_check !~ '::uuid\[\]')), 0::bigint,
  'schema test 26: no policy uses current_centre_ids() without the ::uuid[] cast');
SELECT is((SELECT count(*) FROM pg_policies WHERE tablename = 'event_log' AND schemaname = 'core' AND cmd = 'SELECT' AND roles <> '{lims_owner}' AND policyname <> 'event_log__select__tenant'), 0::bigint, '08 A23.3: no non-staff SELECT policy on event_log');

-- ---------------------------------------------------------------- fixtures (superuser)
SET LOCAL session_replication_role = replica;   -- seed without the audit trigger (tenant rows are fixtures)
INSERT INTO core.tenants (id, tenant_code, legal_name, display_name, status, created_by, updated_by) VALUES
  (pg_temp.id(1), 'lab_a', 'Lab A Pvt Ltd', 'Lab A', 'active',      pg_temp.id(99), pg_temp.id(99)),
  (pg_temp.id(2), 'lab_b', 'Lab B Pvt Ltd', 'Lab B', 'suspended',   pg_temp.id(99), pg_temp.id(99)),
  (pg_temp.id(3), 'lab_c', 'Lab C Pvt Ltd', 'Lab C', 'offboarded',  pg_temp.id(99), pg_temp.id(99)),
  (pg_temp.id(4), 'lab_d', 'Lab D Pvt Ltd', 'Lab D', 'provisioning', pg_temp.id(99), pg_temp.id(99));
SET LOCAL session_replication_role = origin;
INSERT INTO identity.platform_staff (id, user_id, email_normalized, display_name, role_code, is_active, created_by, updated_by) VALUES
  (pg_temp.id(61), pg_temp.id(81), 'a@example.test', 'Staff A', 'platform_superadmin', true, pg_temp.id(99), pg_temp.id(99)),
  (pg_temp.id(62), pg_temp.id(82), 'b@example.test', 'Staff B', 'platform_superadmin', true, pg_temp.id(99), pg_temp.id(99)) ON CONFLICT DO NOTHING;
INSERT INTO core.g_task_registry (identifier, module, kind, scope, max_attempts, is_active) VALUES
  ('plat.task',   'core',    'task', 'platform',   3, true),
  ('plat.other',  'core',    'task', 'platform',   3, true),
  ('tenant.task', 'catalog', 'task', 'per_tenant', 5, true),
  ('off.task',    'core',    'task', 'platform',   3, false);

-- ---------------------------------------------------------------- 2. dedupe constraints (AC-0D-5.3, schema test 27)
SELECT lives_ok(pg_temp.ev(1, 'k1', 70), 'event_log: first publish accepted');
SELECT throws_ok(pg_temp.ev(1, 'k1', 70), '23505', NULL, 'AC-0D-5.3: same (tenant, event_type, idempotency_key) rejected');
SELECT lives_ok(pg_temp.ev(2, 'k1', 70), 'AC-0D-5.3: same (event_type, key) in another tenant accepted');
SELECT lives_ok(pg_temp.ev(1, 'k1', 70, 'lab.other_event'), 'same key, different event_type accepted');
SELECT throws_ok(pg_temp.ev(1, '', 70), '23514', NULL, 'event_log: empty idempotency_key rejected (event_log__idem__ck)');
SELECT lives_ok(pg_temp.ik(NULL, 81, 'pk1'), 'idempotency_keys: NULL-tenant platform key accepted');
SELECT throws_ok(pg_temp.ik(NULL, 81, 'pk1'), '23505', NULL, 'schema test 27: second NULL-tenant row with same (actor, key) rejected (NULLS NOT DISTINCT)');
SELECT lives_ok(pg_temp.ik(NULL, 82, 'pk1'), 'schema test 27: a second platform actor gets its own row for the same key');
SELECT lives_ok(pg_temp.ik(1, 71, 'tk1'), 'tenant key accepted');
SELECT throws_ok(pg_temp.ik(1, 71, 'tk1'), '23505', NULL, 'duplicate tenant key rejected');
SELECT lives_ok(pg_temp.ik(2, 71, 'tk1'), 'same actor + key in another tenant accepted');
SELECT throws_ok(pg_temp.ik(1, 71, 'bad key!'), '23514', NULL, 'idempotency key charset check (idempotency_keys__key__ck)');
SELECT throws_ok($q$INSERT INTO core.idempotency_keys (tenant_id, actor_id, key, method, route, request_sha256, state, expires_at)
  VALUES (NULL, '01900000-0000-7000-8000-000000000071', 'sha', 'POST', '/x', decode('00', 'hex'), 'in_progress', now())$q$, '23514', NULL, 'request_sha256 must be 32 bytes');
SELECT throws_ok($q$INSERT INTO core.idempotency_keys (tenant_id, actor_id, key, method, route, request_sha256, state, response_status, expires_at)
  VALUES (NULL, '01900000-0000-7000-8000-000000000071', 'cmp', 'POST', '/x', decode(repeat('00', 32), 'hex'), 'completed', NULL, now())$q$, '23514', NULL, 'completed requires response_status');

-- ---------------------------------------------------------------- 3. dead letters: constraints + transition trigger (schema tests 7, 9)
INSERT INTO core.dead_letters (id, tenant_id, task_identifier, job_payload, last_error_code, last_error_message_redacted, attempts, first_failed_at, dead_at, state, resolved_by, resolved_at, resolution_note, job_key, created_by) VALUES
  (pg_temp.id(501), NULL, 'plat.task',   '{"ids":[1]}', 'E1', 'm', 3, now() - interval '4 hours', now() - interval '3 hours',   'open',      NULL, NULL, NULL, 'jk-501', pg_temp.id(90)),
  (pg_temp.id(502), NULL, 'plat.task',   '{"ids":[2]}', 'E1', 'm', 3, now() - interval '4 hours', now() - interval '2 hours',   'open',      NULL, NULL, NULL, NULL,     pg_temp.id(90)),
  (pg_temp.id(503), NULL, 'plat.task',   '{"ids":[3]}', 'E2', 'm', 3, now() - interval '4 hours', now() - interval '1 hour',    'discarded', pg_temp.id(81), now() - interval '30 minutes', 'seed', NULL, pg_temp.id(90)),
  (pg_temp.id(504), NULL, 'plat.other',  '{"ids":[4]}', 'E1', 'm', 3, now() - interval '4 hours', now() - interval '30 minutes', 'open',     NULL, NULL, NULL, NULL,     pg_temp.id(90)),
  (pg_temp.id(511), pg_temp.id(1), 'tenant.task', '{"tenant_id":"01900000-0000-7000-8000-000000000001"}', 'E1', 'm', 5, now() - interval '4 hours', now() - interval '5 hours', 'open', NULL, NULL, NULL, 'jk-511', pg_temp.id(90)),
  (pg_temp.id(512), pg_temp.id(2), 'tenant.task', '{"tenant_id":"01900000-0000-7000-8000-000000000002"}', 'E1', 'm', 5, now() - interval '4 hours', now() - interval '5 hours', 'open', NULL, NULL, NULL, NULL, pg_temp.id(90));
SELECT throws_ok($q$INSERT INTO core.dead_letters (id, tenant_id, task_identifier, job_payload, last_error_code, last_error_message_redacted, attempts, first_failed_at, dead_at, job_key, created_by) VALUES ('01900000-0000-7000-8000-000000000561', '01900000-0000-7000-8000-000000000001', 'tenant.task', '{}', 'E', 'm', 1, now(), now(), '', '01900000-0000-7000-8000-000000000090')$q$, '23514', NULL, 'schema test 7: job_key '''' rejected (dead_letters__job_key__ck)');
SELECT lives_ok($q$INSERT INTO core.dead_letters (id, tenant_id, task_identifier, job_payload, last_error_code, last_error_message_redacted, attempts, first_failed_at, dead_at, job_key, created_by) VALUES ('01900000-0000-7000-8000-000000000562', '01900000-0000-7000-8000-000000000001', 'tenant.task', '{}', 'E', 'm', 1, now(), now(), NULL, '01900000-0000-7000-8000-000000000090')$q$, 'schema test 7: job_key NULL accepted');
SELECT lives_ok($q$INSERT INTO core.dead_letters (id, tenant_id, task_identifier, job_payload, last_error_code, last_error_message_redacted, attempts, first_failed_at, dead_at, job_key, created_by) VALUES ('01900000-0000-7000-8000-000000000563', '01900000-0000-7000-8000-000000000001', 'tenant.task', '{}', 'E', 'm', 1, now(), now(), 'x', '01900000-0000-7000-8000-000000000090')$q$, 'schema test 7: 1-char job_key accepted');
SELECT lives_ok($q$INSERT INTO core.dead_letters (id, tenant_id, task_identifier, job_payload, last_error_code, last_error_message_redacted, attempts, first_failed_at, dead_at, job_key, created_by) VALUES ('01900000-0000-7000-8000-000000000564', '01900000-0000-7000-8000-000000000001', 'tenant.task', '{}', 'E', 'm', 1, now(), now(), repeat('k', 400), '01900000-0000-7000-8000-000000000090')$q$, 'schema test 7: 400-char job_key accepted');
SELECT throws_ok($q$INSERT INTO core.dead_letters (id, tenant_id, task_identifier, job_payload, last_error_code, last_error_message_redacted, attempts, first_failed_at, dead_at, job_key, created_by) VALUES ('01900000-0000-7000-8000-000000000565', '01900000-0000-7000-8000-000000000001', 'tenant.task', '{}', 'E', 'm', 1, now(), now(), repeat('k', 401), '01900000-0000-7000-8000-000000000090')$q$, '23514', NULL, 'schema test 7: job_key of 401 chars rejected');
SELECT throws_ok($q$UPDATE core.dead_letters SET job_key = 'zz' WHERE id = '01900000-0000-7000-8000-000000000502'$q$, 'P0001', 'immutable_row', 'job_key is not in the transition allowed-change list');
SELECT throws_ok($q$UPDATE core.dead_letters SET job_payload = '{}' WHERE id = '01900000-0000-7000-8000-000000000502'$q$, 'P0001', 'immutable_row', 'schema test 7: changing job_payload raises immutable_row');
SELECT throws_ok($q$UPDATE core.dead_letters SET task_identifier = 'x' WHERE id = '01900000-0000-7000-8000-000000000502'$q$, 'P0001', 'immutable_row', 'schema test 7: changing task_identifier raises immutable_row');
SELECT throws_ok($q$UPDATE core.dead_letters SET state = 'open', version = version + 1 WHERE id = '01900000-0000-7000-8000-000000000503'$q$, 'P0001', 'immutable_row', 'discarded -> open refused');
SELECT throws_ok($q$UPDATE core.dead_letters SET state = 'replayed', resolved_by = '01900000-0000-7000-8000-000000000081', resolved_at = now() WHERE id = '01900000-0000-7000-8000-000000000503'$q$, 'P0001', 'immutable_row', 'discarded -> replayed refused');
SELECT lives_ok($q$UPDATE core.dead_letters SET state = 'replayed', version = version + 1, resolved_by = '01900000-0000-7000-8000-000000000081', resolved_at = now() WHERE id = '01900000-0000-7000-8000-000000000502'$q$,
  'schema test 7: open -> replayed with version + 1 passes the transition trigger');
SELECT lives_ok($q$UPDATE core.dead_letters SET state = 'discarded', version = version + 1, resolution_note = 'x', resolved_by = '01900000-0000-7000-8000-000000000081', resolved_at = now() WHERE id = '01900000-0000-7000-8000-000000000504'$q$,
  'schema test 7: open -> discarded with note, resolved_*, version + 1 passes');
SELECT is((SELECT resolution_note FROM core.dead_letters WHERE id = pg_temp.id(504)), 'x', 'resolution_note stored');
-- schema test 9: note length 1 / 500 ok, 0 / 501 -> 23514, NULL ok
INSERT INTO core.dead_letters (id, tenant_id, task_identifier, job_payload, last_error_code, last_error_message_redacted, attempts, first_failed_at, dead_at, created_by) VALUES
  (pg_temp.id(521), pg_temp.id(1), 'tenant.task', '{}', 'E', 'm', 1, now(), now(), pg_temp.id(90)), (pg_temp.id(522), pg_temp.id(1), 'tenant.task', '{}', 'E', 'm', 1, now(), now(), pg_temp.id(90)),
  (pg_temp.id(523), pg_temp.id(1), 'tenant.task', '{}', 'E', 'm', 1, now(), now(), pg_temp.id(90)), (pg_temp.id(524), pg_temp.id(1), 'tenant.task', '{}', 'E', 'm', 1, now(), now(), pg_temp.id(90));
SELECT lives_ok(format($q$UPDATE core.dead_letters SET state = 'discarded', version = version + 1, resolution_note = 'a', resolved_by = %L, resolved_at = now() WHERE id = %L$q$, pg_temp.id(81), pg_temp.id(521)), 'schema test 9: 1-char note accepted');
SELECT lives_ok(format($q$UPDATE core.dead_letters SET state = 'discarded', version = version + 1, resolution_note = repeat('a', 500), resolved_by = %L, resolved_at = now() WHERE id = %L$q$, pg_temp.id(81), pg_temp.id(522)), 'schema test 9: 500-char note accepted');
SELECT is((SELECT char_length(resolution_note) FROM core.dead_letters WHERE id = pg_temp.id(522)), 500, 'schema test 9: stored value equals the input');
SELECT throws_ok(format($q$UPDATE core.dead_letters SET state = 'discarded', version = version + 1, resolution_note = '', resolved_by = %L, resolved_at = now() WHERE id = %L$q$, pg_temp.id(81), pg_temp.id(523)), '23514', NULL, 'schema test 9: 0-char note rejected (dead_letters__resolution_note__ck)');
SELECT throws_ok(format($q$UPDATE core.dead_letters SET state = 'discarded', version = version + 1, resolution_note = repeat('a', 501), resolved_by = %L, resolved_at = now() WHERE id = %L$q$, pg_temp.id(81), pg_temp.id(524)), '23514', NULL, 'schema test 9: 501-char note rejected');
SELECT lives_ok(format($q$UPDATE core.dead_letters SET state = 'replayed', version = version + 1, resolved_by = %L, resolved_at = now() WHERE id = %L$q$, pg_temp.id(81), pg_temp.id(524)), 'schema test 9: replay without a note accepted (NULL)');
-- reopen fixture rows used below: 502 and 504 are resolved now; add fresh open platform rows for the function tests
INSERT INTO core.dead_letters (id, tenant_id, task_identifier, job_payload, last_error_code, last_error_message_redacted, attempts, first_failed_at, dead_at, job_key, created_by) VALUES
  (pg_temp.id(531), NULL, 'plat.task',  '{"ids":[31]}', 'E1', 'm', 3, now() - interval '4 hours', now() - interval '20 minutes', 'jk-531', pg_temp.id(90)),
  (pg_temp.id(532), NULL, 'plat.task',  '{"ids":[32]}', 'E1', 'm', 3, now() - interval '4 hours', now() - interval '19 minutes', NULL,     pg_temp.id(90)),
  (pg_temp.id(533), NULL, 'plat.task',  '{"ids":[33]}', 'E1', 'm', 3, now() - interval '4 hours', now() - interval '18 minutes', NULL,     pg_temp.id(90));

-- ---------------------------------------------------------------- 4. app.dl_insert_platform (schema test 12)
SELECT is(pg_temp.x('lims_worker', pg_temp.sys(), NULL, format($q$SELECT app.dl_insert_platform(%L, 'plat.task', '{"ids":[9]}', 'E9', 'boom', 3, now() - interval '1 hour', 'jk-9')::text$q$, pg_temp.id(541))), '',
  'schema test 12: lims_worker with system claims inserts a platform-task dead letter');
SELECT is((SELECT (tenant_id IS NULL AND state = 'open' AND version = 1 AND job_key = 'jk-9' AND dead_at <= now() AND dead_at > now() - interval '1 minute' AND created_by = pg_temp.id(90))
           FROM core.dead_letters WHERE id = pg_temp.id(541)), true, 'row: tenant_id NULL, open, version 1, job_key = p_job_key, dead_at = now(), created_by = claims sub');
SELECT is(pg_temp.x('lims_worker', pg_temp.sys(), NULL, format($q$SELECT app.dl_insert_platform(%L, 'tenant.task', '{}', 'E', 'm', 1, now())::text$q$, pg_temp.id(542))), 'EP0001:job_tenant_mismatch', 'schema test 12: per_tenant identifier -> job_tenant_mismatch');
SELECT is(pg_temp.x('lims_worker', pg_temp.sys(), NULL, format($q$SELECT app.dl_insert_platform(%L, 'nope.task', '{}', 'E', 'm', 1, now())::text$q$, pg_temp.id(543))), 'EP0001:unknown_task_identifier', 'schema test 12: unknown identifier -> unknown_task_identifier');
SELECT is(pg_temp.x('lims_api', pg_temp.sys(), NULL, format($q$SELECT app.dl_insert_platform(%L, 'plat.task', '{}', 'E', 'm', 1, now())::text$q$, pg_temp.id(544))), 'E42501:permission denied for function dl_insert_platform', 'schema test 12: lims_api cannot call dl_insert_platform');
SELECT is((SELECT count(*) FROM core.dead_letters WHERE id IN (pg_temp.id(542), pg_temp.id(543), pg_temp.id(544))), 0::bigint, 'refused calls inserted nothing');

-- ---------------------------------------------------------------- 5. app.dl_list_platform (schema test 10, AC-0D-5.10/5.11)
SELECT is(pg_temp.x('lims_api', pg_temp.pcl(61, 81), NULL, $q$SELECT * FROM app.dl_list_platform(p_limit => 200)$q$, 'n'),
  (SELECT count(*)::text FROM core.dead_letters WHERE tenant_id IS NULL), 'schema test 10: returns exactly the tenant_id IS NULL rows');
SELECT is(pg_temp.x('lims_api', pg_temp.pcl(61, 81), NULL, $q$SELECT * FROM app.dl_list_platform(p_state => 'discarded') WHERE tenant_id IS NOT NULL$q$, 'n'), '0', 'no tenant row ever listed');
SELECT is(pg_temp.x('lims_api', pg_temp.pcl(61, 81), NULL, $q$SELECT * FROM app.dl_list_platform(p_task_identifier => 'plat.other')$q$, 'n'), '1', 'AC-0D-5.11: p_task_identifier narrows');
SELECT is(pg_temp.x('lims_api', pg_temp.pcl(61, 81), NULL, $q$SELECT * FROM app.dl_list_platform(p_state => 'open', p_task_identifier => 'plat.task')$q$, 'n'),
  (SELECT count(*)::text FROM core.dead_letters WHERE tenant_id IS NULL AND state = 'open' AND task_identifier = 'plat.task'), 'AC-0D-5.11: filters combine');
SELECT is(pg_temp.x('lims_api', pg_temp.pcl(61, 81), NULL, format($q$SELECT * FROM app.dl_list_platform(p_dead_at_from => %L)$q$, (SELECT dead_at FROM core.dead_letters WHERE id = pg_temp.id(531))), 'n'),
  (SELECT count(*)::text FROM core.dead_letters WHERE tenant_id IS NULL AND dead_at >= (SELECT dead_at FROM core.dead_letters WHERE id = pg_temp.id(531))), 'p_dead_at_from is inclusive');
SELECT is(pg_temp.x('lims_api', pg_temp.pcl(61, 81), NULL, format($q$SELECT * FROM app.dl_list_platform(p_dead_at_to => %L)$q$, (SELECT dead_at FROM core.dead_letters WHERE id = pg_temp.id(531))), 'n'),
  (SELECT count(*)::text FROM core.dead_letters WHERE tenant_id IS NULL AND dead_at < (SELECT dead_at FROM core.dead_letters WHERE id = pg_temp.id(531))), 'p_dead_at_to is exclusive');
SELECT is(pg_temp.x('lims_api', pg_temp.pcl(61, 81), NULL, format($q$SELECT id::text FROM app.dl_list_platform(p_dead_letter_id => %L)$q$, pg_temp.id(531))), pg_temp.id(531)::text, 'AC-0D-5.10: p_dead_letter_id returns exactly that row');
SELECT is(pg_temp.x('lims_api', pg_temp.pcl(61, 81), NULL, format($q$SELECT * FROM app.dl_list_platform(p_dead_letter_id => %L)$q$, pg_temp.id(511)), 'n'), '0', 'AC-0D-5.10: a tenant row id returns 0 rows');
SELECT is(pg_temp.x('lims_api', pg_temp.pcl(61, 81), NULL, format($q$SELECT * FROM app.dl_list_platform(p_dead_letter_id => %L)$q$, pg_temp.id(999)), 'n'), '0', 'AC-0D-5.10: an unknown id returns 0 rows');
SELECT is(pg_temp.x('lims_api', pg_temp.pcl(61, 81), NULL, $q$SELECT array_agg(id ORDER BY ord)::text FROM (SELECT id, row_number() OVER () ord FROM app.dl_list_platform(p_limit => 200)) s$q$),
  (SELECT array_agg(id ORDER BY dead_at DESC, id DESC)::text FROM core.dead_letters WHERE tenant_id IS NULL), 'order is dead_at DESC, id DESC');
SELECT is(pg_temp.x('lims_api', pg_temp.pcl(61, 81), NULL, $q$SELECT string_agg(id::text, ',') FROM (SELECT id FROM app.dl_list_platform(p_limit => 2)) s$q$),
  (SELECT string_agg(id::text, ',') FROM (SELECT id FROM core.dead_letters WHERE tenant_id IS NULL ORDER BY dead_at DESC, id DESC LIMIT 2) s), 'p_limit pages');
SELECT is(pg_temp.x('lims_api', pg_temp.pcl(61, 81), NULL, format($q$SELECT string_agg(id::text, ',') FROM (SELECT id FROM app.dl_list_platform(p_after_dead_at => %L, p_after_id => %L, p_limit => 200)) s$q$,
    (SELECT dead_at FROM core.dead_letters WHERE id = pg_temp.id(533)), pg_temp.id(533))),
  (SELECT string_agg(id::text, ',' ORDER BY dead_at DESC, id DESC) FROM core.dead_letters WHERE tenant_id IS NULL AND (dead_at, id) < ((SELECT dead_at FROM core.dead_letters WHERE id = pg_temp.id(533)), pg_temp.id(533))),
  'AC-0D-5.11: keyset (after_dead_at, after_id) returns the next page without overlap');
SELECT is(pg_temp.x('lims_api', pg_temp.pcl(61, 81), NULL, $q$SELECT count(*) FROM app.dl_list_platform(p_limit => 100000)$q$), (SELECT least(count(*), 201)::text FROM core.dead_letters WHERE tenant_id IS NULL), 'limit capped at 201');
SELECT is((SELECT count(*) FROM information_schema.parameters WHERE specific_schema = 'app' AND specific_name LIKE 'dl_list_platform%' AND parameter_mode = 'OUT' AND parameter_name IN ('job_payload', 'job_key')), 0::bigint, 'dl_list_platform has no job_payload / job_key column');
SELECT is(pg_temp.x('lims_api', pg_temp.tcl(1, 71, 'user'), NULL, $q$SELECT * FROM app.dl_list_platform()$q$, 'n'), '0', 'schema test 10: tenant claims -> 0 rows');
SELECT is(pg_temp.x('lims_api', pg_temp.pcl(61, 81, 'aal1'), NULL, $q$SELECT * FROM app.dl_list_platform()$q$, 'n'), '0', 'schema test 10: platform claims with aal1 -> 0 rows');
SELECT is(pg_temp.x('lims_api', NULL, NULL, $q$SELECT * FROM app.dl_list_platform()$q$, 'n'), '0', 'no claims -> 0 rows');

-- ---------------------------------------------------------------- 6. app.dl_resolve (schema test 11, AC-0D-5.7 / 5.8 / 5.12)
SELECT is(pg_temp.x('lims_api', pg_temp.pcl(61, 81), NULL, format($q$SELECT version::text || ':' || state || ':' || (job_payload ->> 'ids') || ':' || coalesce(job_key, '<null>') || ':' || coalesce(resolution_note, '<null>') || ':' || (resolved_by = %L)::text
    FROM app.dl_resolve(%L, 1, 'replayed', NULL)$q$, pg_temp.id(81), pg_temp.id(531))), '2:replayed:[31]:jk-531:<null>:true',
  'schema test 11: replay (note NULL) -> version 2, resolved_by = sub, job_payload and job_key returned, note NULL (AC-0D-5.12)');
SELECT is((SELECT state || ':' || version || ':' || (resolved_at IS NOT NULL)::text FROM core.dead_letters WHERE id = pg_temp.id(531)), 'replayed:2:true', 'row persisted');
SELECT is(pg_temp.x('lims_api', pg_temp.pcl(61, 81), NULL, format($q$SELECT resolution_note || ':' || (job_payload ->> 'ids') FROM app.dl_resolve(%L, 1, 'replayed', %L)$q$, pg_temp.id(532), 'replay because X')), 'replay because X:[32]',
  'AC-0D-5.12: replay with a note stores it');
SELECT is(pg_temp.x('lims_api', pg_temp.pcl(61, 81), NULL, format($q$SELECT state || ':' || resolution_note || ':' || coalesce(job_payload::text, '<null>') FROM app.dl_resolve(%L, 1, 'discarded', 'not needed')$q$, pg_temp.id(533))), 'discarded:not needed:<null>',
  'AC-0D-5.8 / A10.1: discard stores the note and returns NULL job_payload');
SELECT is(pg_temp.x('lims_api', pg_temp.pcl(61, 81), NULL, format($q$SELECT * FROM app.dl_resolve(%L, 7, 'replayed', NULL)$q$, pg_temp.id(541)), 'n'), '0', 'AC-0D-5.7: stale expected version -> 0 rows');
SELECT is((SELECT state || ':' || version FROM core.dead_letters WHERE id = pg_temp.id(541)), 'open:1', 'AC-0D-5.7: row unchanged after the stale call');
SELECT is(pg_temp.x('lims_api', pg_temp.pcl(61, 81), NULL, format($q$SELECT * FROM app.dl_resolve(%L, 2, 'replayed', NULL)$q$, pg_temp.id(531)), 'n'), '0', 'already replayed row -> 0 rows');
SELECT is(pg_temp.x('lims_api', pg_temp.pcl(61, 81), NULL, format($q$SELECT * FROM app.dl_resolve(%L, 1, 'replayed', NULL)$q$, pg_temp.id(511)), 'n'), '0', 'tenant row -> 0 rows (only app.dl_* NULL-tenant rows)');
SELECT is(pg_temp.x('lims_api', pg_temp.tcl(1, 71, 'user'), NULL, format($q$SELECT * FROM app.dl_resolve(%L, 1, 'replayed', NULL)$q$, pg_temp.id(541)), 'n'), '0', 'tenant claims -> 0 rows');
SELECT is(pg_temp.x('lims_api', pg_temp.pcl(61, 81, 'aal1'), NULL, format($q$SELECT * FROM app.dl_resolve(%L, 1, 'replayed', NULL)$q$, pg_temp.id(541)), 'n'), '0', 'platform claims with aal1 -> 0 rows');
SELECT is(pg_temp.x('lims_api', NULL, NULL, format($q$SELECT * FROM app.dl_resolve(%L, 1, 'replayed', NULL)$q$, pg_temp.id(541)), 'n'), '0', 'no claims -> 0 rows');
SELECT is((SELECT state || ':' || version FROM core.dead_letters WHERE id = pg_temp.id(541)), 'open:1', 'row 541 still untouched after all refused calls');
SELECT is(pg_temp.x('lims_api', pg_temp.pcl(61, 81), NULL, format($q$SELECT * FROM app.dl_resolve(%L, 1, 'discarded', NULL)$q$, pg_temp.id(541)), 'n'), 'EP0001:dl_resolve_invalid_input', 'discard without a reason -> dl_resolve_invalid_input');
SELECT is(pg_temp.x('lims_api', pg_temp.pcl(61, 81), NULL, format($q$SELECT * FROM app.dl_resolve(%L, 1, 'bogus', 'x')$q$, pg_temp.id(541)), 'n'), 'EP0001:dl_resolve_invalid_input', 'unknown p_state -> dl_resolve_invalid_input');
SELECT is(pg_temp.x('lims_api', pg_temp.pcl(61, 81), NULL, format($q$SELECT * FROM app.dl_resolve(%L, 1, NULL, 'x')$q$, pg_temp.id(541)), 'n'), 'EP0001:dl_resolve_invalid_input', 'NULL p_state -> dl_resolve_invalid_input');
SELECT alike(pg_temp.x('lims_api', pg_temp.pcl(61, 81), NULL, format($q$SELECT * FROM app.dl_resolve(%L, 1, 'discarded', repeat('a', 501))$q$, pg_temp.id(541)), 'n'), 'E23514:%', 'schema test 11: 501-char note -> 23514');
SELECT is((SELECT state || ':' || version FROM core.dead_letters WHERE id = pg_temp.id(541)), 'open:1', 'row 541 unchanged after the failed note');
SELECT is((SELECT count(*) FROM information_schema.routines WHERE routine_schema = 'app' AND routine_name = 'dl_resolve'), 1::bigint, 'single dl_resolve overload');

-- ---------------------------------------------------------------- 7. __platform policies on tenant rows (schema tests 14, 23)
SELECT is(pg_temp.x('lims_api', pg_temp.pcl(61, 81), NULL, 'SELECT id FROM core.dead_letters', 'n'), (SELECT count(*)::text FROM core.dead_letters WHERE tenant_id IS NOT NULL), 'schema test 14: platform claims see tenant rows only');
SELECT is(pg_temp.x('lims_api', pg_temp.pcl(61, 81), NULL, 'SELECT id FROM core.dead_letters WHERE tenant_id IS NULL', 'n'), '0', 'schema test 14: NULL-tenant rows are invisible to a direct SELECT');
SELECT is(pg_temp.x('lims_api', pg_temp.pcl(61, 81), NULL, format($q$UPDATE core.dead_letters SET state = 'discarded', version = version + 1, resolution_note = 'x', resolved_by = %L, resolved_at = now() WHERE id = %L$q$, pg_temp.id(81), pg_temp.id(541)), 'w'), '0',
  'schema test 14: a direct UPDATE cannot change a NULL-tenant row');
SELECT is(pg_temp.x('lims_api', pg_temp.pcl(61, 81, 'aal1'), NULL, 'SELECT id FROM core.dead_letters', 'n'), '0', 'aal1 platform claims see nothing');
SELECT is(pg_temp.x('lims_api', pg_temp.pcl(61, 81), NULL, format($q$UPDATE core.dead_letters SET state = 'replayed', version = version + 1, resolved_by = %L, resolved_at = now() WHERE id = %L AND state = 'open' AND version = 1$q$, pg_temp.id(81), pg_temp.id(511)), 'w'), '1',
  'schema test 23: version-guarded __platform UPDATE open -> replayed (n -> n + 1) succeeds');
SELECT is(pg_temp.x('lims_api', pg_temp.pcl(61, 81), NULL, format($q$UPDATE core.dead_letters SET state = 'replayed', version = version + 1, resolved_by = %L, resolved_at = now() WHERE id = %L AND state = 'open' AND version = 1$q$, pg_temp.id(81), pg_temp.id(512)), 'w'), '1', 'tenant 2 row updated by platform too');
SELECT is(pg_temp.x('lims_api', pg_temp.pcl(61, 81), NULL, format($q$UPDATE core.dead_letters SET state = 'replayed', version = version + 1, resolved_by = %L, resolved_at = now() WHERE id = %L AND state = 'open' AND version = 1$q$, pg_temp.id(81), pg_temp.id(511)), 'w'), '0', 'schema test 23: stale version changes 0 rows');
SELECT is(pg_temp.x('lims_api', pg_temp.tcl(1, 90, 'system'), NULL, 'SELECT id FROM core.dead_letters', 'n'), (SELECT count(*)::text FROM core.dead_letters WHERE tenant_id = pg_temp.id(1)), 'tenant claims see their own tenant rows only (isolation)');

-- ---------------------------------------------------------------- 8. owner SELECT predicates (schema test 15, 08 A10.5 / A15.3)
INSERT INTO core.event_log (tenant_id, event_id, event_type, producer, idempotency_key, aggregate_type, aggregate_id, aggregate_seq, occurred_at, envelope, created_at, created_by) VALUES
  (pg_temp.id(1), gen_random_uuid(), 'lab.old', 'lab', 'old1', 's', gen_random_uuid(), 1, now(), '{}', now() - interval '91 days', pg_temp.id(70)),
  (pg_temp.id(2), gen_random_uuid(), 'lab.old', 'lab', 'old2', 's', gen_random_uuid(), 1, now(), '{}', now() - interval '200 days', pg_temp.id(70)),
  (pg_temp.id(1), gen_random_uuid(), 'lab.new', 'lab', 'new1', 's', gen_random_uuid(), 1, now(), '{}', now() - interval '89 days', pg_temp.id(70));
INSERT INTO lab.event_inbox (tenant_id, event_id, event_type, received_at, created_by) VALUES
  (pg_temp.id(1), gen_random_uuid(), 'lab.old', now() - interval '91 days', pg_temp.id(90)), (pg_temp.id(1), gen_random_uuid(), 'lab.new', now() - interval '1 day', pg_temp.id(90));
INSERT INTO core.idempotency_keys (tenant_id, actor_id, key, method, route, request_sha256, state, expires_at) VALUES
  (pg_temp.id(1), pg_temp.id(71), 'exp1', 'POST', '/x', decode(repeat('00', 32), 'hex'), 'in_progress', now() - interval '1 hour'),
  (NULL, pg_temp.id(81), 'exp2', 'POST', '/x', decode(repeat('00', 32), 'hex'), 'in_progress', now() - interval '1 hour');
INSERT INTO core.dead_letters (id, tenant_id, task_identifier, job_payload, last_error_code, last_error_message_redacted, attempts, first_failed_at, dead_at, state, resolved_by, resolved_at, created_by) VALUES
  (pg_temp.id(551), pg_temp.id(1), 'tenant.task', '{}', 'E', 'm', 1, now() - interval '200 days', now() - interval '200 days', 'discarded', pg_temp.id(81), now() - interval '100 days', pg_temp.id(90)),
  (pg_temp.id(552), pg_temp.id(1), 'tenant.task', '{}', 'E', 'm', 1, now() - interval '200 days', now() - interval '200 days', 'open', NULL, NULL, pg_temp.id(90));
SELECT is(pg_temp.x('lims_owner', NULL, NULL, 'SELECT 1 FROM core.event_log', 'n'), '0', 'schema test 15: event_log owner SELECT admits nothing when app.maintenance is unset');
SELECT is(pg_temp.x('lims_owner', NULL, $q$SELECT set_config('app.maintenance', '', true)$q$, 'SELECT 1 FROM core.event_log', 'n'), '0', 'event_log: app.maintenance = '''' admits nothing');
SELECT is(pg_temp.x('lims_owner', NULL, $q$SELECT set_config('app.maintenance', 'purge_dead_letters', true)$q$, 'SELECT 1 FROM core.event_log', 'n'), '0', 'event_log: another function''s name admits nothing');
SELECT is(pg_temp.x('lims_owner', NULL, $q$SELECT set_config('app.maintenance', 'purge_event_log', true)$q$, 'SELECT 1 FROM core.event_log', 'n'),
  (SELECT count(*)::text FROM core.event_log WHERE created_at < now() - interval '90 days'), 'event_log: purge_event_log admits exactly the expired rows');
SELECT is(pg_temp.x('lims_owner', NULL, NULL, 'SELECT 1 FROM lab.event_inbox', 'n'), '0', 'event_inbox: nothing when unset');
SELECT is(pg_temp.x('lims_owner', NULL, $q$SELECT set_config('app.maintenance', 'purge_event_inboxes', true)$q$, 'SELECT 1 FROM lab.event_inbox', 'n'),
  (SELECT count(*)::text FROM lab.event_inbox WHERE received_at < now() - interval '90 days'), 'event_inbox: purge_event_inboxes admits exactly the expired rows');
SELECT is(pg_temp.x('lims_owner', NULL, NULL, 'SELECT 1 FROM core.idempotency_keys', 'n'), '0', 'idempotency_keys: nothing when unset');
SELECT is(pg_temp.x('lims_owner', NULL, $q$SELECT set_config('app.maintenance', 'purge_idempotency_keys', true)$q$, 'SELECT 1 FROM core.idempotency_keys', 'n'),
  (SELECT count(*)::text FROM core.idempotency_keys WHERE expires_at < now()), 'idempotency_keys: purge_idempotency_keys admits exactly the expired rows (incl. NULL tenant)');
SELECT is(pg_temp.x('lims_owner', NULL, NULL, 'SELECT 1 FROM core.dead_letters', 'n'), (SELECT count(*)::text FROM core.dead_letters WHERE tenant_id IS NULL), 'dead_letters: unset -> the NULL-tenant rows only');
SELECT is(pg_temp.x('lims_owner', NULL, $q$SELECT set_config('app.maintenance', 'purge_event_log', true)$q$, 'SELECT 1 FROM core.dead_letters', 'n'), (SELECT count(*)::text FROM core.dead_letters WHERE tenant_id IS NULL), 'dead_letters: another name -> NULL-tenant rows only');
SELECT is(pg_temp.x('lims_owner', NULL, $q$SELECT set_config('app.maintenance', 'purge_dead_letters', true)$q$, 'SELECT 1 FROM core.dead_letters', 'n'),
  (SELECT count(*)::text FROM core.dead_letters WHERE tenant_id IS NULL OR (state <> 'open' AND resolved_at < now() - interval '90 days')), 'dead_letters: purge_dead_letters -> NULL-tenant rows plus the expired resolved ones');
SELECT ok(pg_temp.x('lims_worker', NULL, $q$SELECT set_config('app.maintenance', 'purge_event_log', true)$q$, 'SELECT 1 FROM core.event_log', 'n') IN ('0') OR pg_temp.x('lims_worker', NULL, $q$SELECT set_config('app.maintenance', 'purge_event_log', true)$q$, 'SELECT 1 FROM core.event_log', 'n') LIKE 'E42501%',
  'schema test 15: lims_worker setting the GUC itself reads no expired event_log row (TO lims_owner only)');
SELECT ok(pg_temp.x('lims_api', NULL, $q$SELECT set_config('app.maintenance', 'purge_event_log', true)$q$, 'SELECT 1 FROM core.event_log', 'n') = '0', 'lims_api setting the GUC gains nothing on event_log');
SELECT ok(pg_temp.x('lims_api', NULL, $q$SELECT set_config('app.maintenance', 'purge_idempotency_keys', true)$q$, 'SELECT 1 FROM core.idempotency_keys', 'n') = '0', 'lims_api setting the GUC gains nothing on idempotency_keys');
SELECT ok(pg_temp.x('lims_api', NULL, $q$SELECT set_config('app.maintenance', 'purge_dead_letters', true)$q$, 'SELECT 1 FROM core.dead_letters', 'n') = '0', 'lims_api setting the GUC gains nothing on dead_letters');
SELECT ok(pg_temp.x('lims_api', NULL, $q$SELECT set_config('app.maintenance', 'purge_event_inboxes', true)$q$, 'SELECT 1 FROM lab.event_inbox', 'n') = '0', 'lims_api setting the GUC gains nothing on event_inbox');

-- 9. app.enqueue_job + queue_depth (schema tests 22, 23; AC-0D-5.14 / 5.15) live in T0B-05_queue.test.sql (needs the real graphile_worker schema, SP-2).

-- ---------------------------------------------------------------- 10. cron fan-out (schema test 22, AC-0D-5.15), tenant resolver and hmac lookup (test 29), platform_list_tenants (test 16)
SELECT is(pg_temp.x('lims_worker', pg_temp.sys(), NULL, $q$SELECT string_agg(c::text, ',' ORDER BY c) FROM app.cron_tenant_ids() c$q$), pg_temp.id(1)::text || ',' || pg_temp.id(2)::text,
  'schema test 22: cron_tenant_ids returns exactly the active and suspended tenants (not provisioning / offboarded)');
SELECT is(pg_temp.x('lims_worker', pg_temp.sys(), $q$SELECT 1$q$, $q$SELECT count(*) FROM app.cron_tenant_ids() c WHERE current_setting('app.maintenance', true) IS NOT DISTINCT FROM ''$q$), '2', 'app.maintenance is '''' while/after the rows are consumed (reset in body)');
SELECT is(pg_temp.x('lims_worker', NULL, $q$SELECT set_config('app.maintenance', 'cron_tenant_ids', true)$q$, 'SELECT 1 FROM core.tenants', 'n'), '0', 'schema test 22: lims_worker setting app.maintenance itself sees 0 core.tenants rows');
SELECT is(pg_temp.x('lims_api', NULL, NULL, $q$SELECT 1 FROM app.cron_tenant_ids()$q$, 'n'), 'E42501:permission denied for function cron_tenant_ids', 'lims_api cannot call cron_tenant_ids');
SELECT is(pg_temp.x('lims_api', NULL, NULL, $q$SELECT tenant_id::text || ':' || status FROM app.core_resolve_tenant_code('lab_b')$q$), pg_temp.id(2)::text || ':suspended', 'schema test 29: known code resolves (any status)');
SELECT is(pg_temp.x('lims_api', NULL, NULL, $q$SELECT 1 FROM app.core_resolve_tenant_code('nope')$q$, 'n'), '0', 'schema test 29: unknown code -> 0 rows');
SELECT is(pg_temp.x('lims_api', NULL, NULL, $q$SELECT 1 FROM app.core_resolve_tenant_code(NULL)$q$, 'n'), '0', 'schema test 29: NULL code -> 0 rows');
SELECT is(pg_temp.x('lims_api', NULL, NULL, $q$SELECT (SELECT count(*) FROM app.core_resolve_tenant_code('lab_a'))::text || ':' || coalesce(current_setting('app.pre_tenant_code', true), '<null>')$q$), '1:', 'schema test 29: app.pre_tenant_code is '''' afterwards');
SELECT is(pg_temp.x('lims_api', NULL, $q$SELECT set_config('app.pre_tenant_code', 'lab_a', true)$q$, 'SELECT 1 FROM core.tenants', 'n'), '0', 'schema test 29: lims_api setting app.pre_tenant_code itself sees 0 tenants');
SELECT is(pg_temp.x('lims_worker', NULL, NULL, $q$SELECT 1 FROM app.identity_tenants_for_email_hmacs(ARRAY[]::bytea[])$q$, 'n'), '0', 'hmac lookup: empty array -> 0 rows');
SELECT is(pg_temp.x('lims_worker', NULL, NULL, $q$SELECT 1 FROM app.identity_tenants_for_email_hmacs((SELECT array_agg(decode(repeat('ab', 32), 'hex')) FROM generate_series(1, 101)))$q$, 'n'),
  'EP0001:identity_tenants_for_email_hmacs_invalid_input', 'schema test 29: more than 100 values -> identity_tenants_for_email_hmacs_invalid_input');
SELECT is(pg_temp.x('lims_worker', NULL, $q$SELECT set_config('app.maintenance', 'identity_tenants_for_email_hmacs', true)$q$, 'SELECT 1 FROM core.users', 'n'), '0', 'schema test 29: lims_worker setting the GUC itself sees 0 core.users rows');
SELECT is(pg_temp.x('lims_api', pg_temp.pcl(61, 81), NULL, $q$SELECT count(*) FROM app.platform_list_tenants('code')$q$), (SELECT count(*)::text FROM core.tenants), 'schema test 16: platform claims list every tenant');
SELECT is(pg_temp.x('lims_api', pg_temp.tcl(1, 71, 'user'), NULL, $q$SELECT 1 FROM app.platform_list_tenants('code')$q$, 'n'), '0', 'schema test 16: tenant claims -> 0 rows');
SELECT is(pg_temp.x('lims_api', pg_temp.pcl(61, 81), NULL, $q$SELECT 1 FROM app.platform_list_tenants('name')$q$, 'n'), 'EP0001:platform_list_tenants_invalid_input', 'schema test 16: bad sort -> platform_list_tenants_invalid_input');

-- ---------------------------------------------------------------- 11. non-staff writes on the shared tables (schema test 24, T0B-05 part)
SELECT is(pg_temp.x('lims_api', pg_temp.tcl(1, 70, 'patient'), NULL, pg_temp.ev(1, 'pt1', 70), 'w'), '1', 'schema test 24: patient INSERT into event_log (own created_by) succeeds');
SELECT is(pg_temp.x('lims_api', pg_temp.tcl(1, 70, 'partner'), NULL, pg_temp.ev(1, 'pa1', 70), 'w'), '1', 'partner INSERT into event_log succeeds');
SELECT is(pg_temp.x('lims_api', pg_temp.tcl(1, 70, 'portal'), NULL, pg_temp.ev(1, 'po1', 70), 'w'), '1', 'portal INSERT into event_log succeeds');
SELECT alike(pg_temp.x('lims_api', pg_temp.tcl(1, 70, 'patient'), NULL, pg_temp.ev(1, 'pt2', 71), 'w'), 'E42501:%', 'patient INSERT with another actor id refused');
SELECT alike(pg_temp.x('lims_api', pg_temp.tcl(1, 70, 'patient'), NULL, pg_temp.ev(2, 'pt3', 70), 'w'), 'E42501:%', 'patient INSERT into another tenant refused');
SELECT is(pg_temp.x('lims_api', pg_temp.tcl(1, 70, 'patient'), NULL, 'SELECT 1 FROM core.event_log', 'n'), '0', 'schema test 24: patient SELECT of event_log returns 0 rows');
SELECT cmp_ok(pg_temp.x('lims_api', pg_temp.tcl(1, 90, 'system'), NULL, $q$SELECT 1 FROM core.event_log WHERE idempotency_key IN ('pt1', 'pa1', 'po1')$q$, 'n')::int, '=', 3, 'staff/system claims see the inserted events');
SELECT is(pg_temp.x('lims_api', pg_temp.tcl(1, 70, 'patient'), NULL, pg_temp.ik(1, 70, 'pat-k1'), 'w'), '1', 'patient INSERT of own idempotency key succeeds');
SELECT is(pg_temp.x('lims_api', pg_temp.tcl(1, 70, 'patient'), NULL, 'SELECT 1 FROM core.idempotency_keys', 'n'), '1', 'patient SELECT sees only the own idempotency row');
SELECT is(pg_temp.x('lims_api', pg_temp.tcl(1, 70, 'patient'), NULL, $q$UPDATE core.idempotency_keys SET state = 'completed', response_status = 200 WHERE key = 'pat-k1'$q$, 'w'), '1', 'patient UPDATE of own key affects 1 row');
SELECT is(pg_temp.x('lims_api', pg_temp.tcl(1, 70, 'patient'), NULL, pg_temp.ik(1, 71, 'pat-k2'), 'w'), 'E42501:new row violates row-level security policy for table "idempotency_keys"', 'patient INSERT with another actor id refused');
SELECT is(pg_temp.x('lims_api', pg_temp.tcl(1, 70, 'patient'), NULL, $q$DELETE FROM core.idempotency_keys WHERE key = 'pat-k1'$q$, 'w'), '0', 'patient DELETE of a completed row affects 0 rows (in_progress only)');
SELECT is(pg_temp.x('lims_api', pg_temp.tcl(1, 70, 'patient'), NULL, 'SELECT 1 FROM core.dead_letters', 'n'), '0', 'patient sees no dead letters');
SELECT alike(pg_temp.x('lims_api', pg_temp.tcl(1, 70, 'patient'), NULL, $q$INSERT INTO core.dead_letters (id, tenant_id, task_identifier, job_payload, last_error_code, last_error_message_redacted, attempts, first_failed_at, dead_at, created_by)
  VALUES (gen_random_uuid(), '01900000-0000-7000-8000-000000000001', 'tenant.task', '{}', 'E', 'm', 1, now(), now(), '01900000-0000-7000-8000-000000000070')$q$, 'w'), 'E42501:%', 'patient cannot write dead_letters (no non-staff policy)');
SELECT alike(pg_temp.x('lims_api', pg_temp.tcl(1, 70, 'patient'), NULL, $q$INSERT INTO lab.event_inbox (tenant_id, event_id, event_type, created_by) VALUES ('01900000-0000-7000-8000-000000000001', gen_random_uuid(), 'x', '01900000-0000-7000-8000-000000000070')$q$, 'w'), 'E42501:%',
  'patient cannot write event_inbox (staff guard)');
SELECT is(pg_temp.x('lims_api', pg_temp.tcl(1, 90, 'device'), NULL, pg_temp.ev(1, 'dev1', 90), 'w'), '1', 'device claims still pass the staff guard (08 A19.1)');
SELECT is(pg_temp.x('lims_api', pg_temp.tcl(1, 90, 'system'), NULL, 'UPDATE core.event_log SET event_type = event_type', 'w'), 'E42501:permission denied for table event_log', 'AC-0B-4.3: lims_app cannot UPDATE event_log');
SELECT is(pg_temp.x('lims_api', pg_temp.tcl(1, 90, 'system'), NULL, 'DELETE FROM core.event_log', 'w'), 'E42501:permission denied for table event_log', 'AC-0B-4.2: lims_app cannot DELETE event_log');
SELECT is(pg_temp.x('lims_api', pg_temp.tcl(1, 90, 'system'), NULL, 'DELETE FROM core.dead_letters', 'w'), 'E42501:permission denied for table dead_letters', 'AC-0B-4.2: lims_app cannot DELETE dead_letters');
SELECT is(pg_temp.x('lims_api', pg_temp.tcl(1, 90, 'system'), NULL, 'SELECT 1 FROM core.rate_limit_counters', 'n'), 'E42501:permission denied for table rate_limit_counters', 'rate_limit_counters not readable by lims_api');
SELECT is(pg_temp.x('lims_worker', NULL, NULL, 'SELECT 1 FROM core.rate_limit_counters', 'n'), 'E42501:permission denied for table rate_limit_counters', 'rate_limit_counters not readable by lims_worker');

-- ---------------------------------------------------------------- 12. platform idempotency keys (schema test 27)
SELECT is(pg_temp.x('lims_api', pg_temp.pcl(61, 81), NULL, $q$INSERT INTO core.idempotency_keys (tenant_id, actor_id, key, method, route, request_sha256, state, expires_at)
  VALUES (NULL, '01900000-0000-7000-8000-000000000081', 'plat-1', 'POST', '/platform/tenants', decode(repeat('00', 32), 'hex'), 'in_progress', now() + interval '7 days')
  ON CONFLICT (tenant_id, actor_id, key) DO NOTHING RETURNING key$q$), 'plat-1', 'schema test 27: platform INSERT ... ON CONFLICT DO NOTHING RETURNING returns the key');
SELECT is(pg_temp.x('lims_api', pg_temp.pcl(61, 81), NULL, $q$INSERT INTO core.idempotency_keys (tenant_id, actor_id, key, method, route, request_sha256, state, expires_at)
  VALUES (NULL, '01900000-0000-7000-8000-000000000081', 'plat-1', 'POST', '/platform/tenants', decode(repeat('00', 32), 'hex'), 'in_progress', now() + interval '7 days')
  ON CONFLICT (tenant_id, actor_id, key) DO NOTHING RETURNING key$q$), '<null>', 'schema test 27: replay returns nothing');
SELECT is(pg_temp.x('lims_api', pg_temp.pcl(62, 82), NULL, $q$INSERT INTO core.idempotency_keys (tenant_id, actor_id, key, method, route, request_sha256, state, expires_at)
  VALUES (NULL, '01900000-0000-7000-8000-000000000082', 'plat-1', 'POST', '/platform/tenants', decode(repeat('00', 32), 'hex'), 'in_progress', now() + interval '7 days')
  ON CONFLICT (tenant_id, actor_id, key) DO NOTHING RETURNING key$q$), 'plat-1', 'schema test 27: a second platform actor gets its own row');
SELECT is(pg_temp.x('lims_api', pg_temp.pcl(61, 81), NULL, $q$SELECT 1 FROM core.idempotency_keys WHERE tenant_id IS NULL$q$, 'n'), (SELECT count(*)::text FROM core.idempotency_keys WHERE tenant_id IS NULL AND actor_id = pg_temp.id(81)), 'platform actor sees only its own NULL-tenant rows');
SELECT is(pg_temp.x('lims_api', pg_temp.pcl(61, 81, 'aal1'), NULL, $q$SELECT 1 FROM core.idempotency_keys WHERE tenant_id IS NULL$q$, 'n'), '0', 'schema test 27: platform claims with aal1 see no NULL-tenant row');
SELECT is(pg_temp.x('lims_api', pg_temp.tcl(1, 81, 'user'), NULL, $q$SELECT 1 FROM core.idempotency_keys WHERE tenant_id IS NULL$q$, 'n'), '0', 'schema test 27: tenant claims see no NULL-tenant row');
SELECT is(pg_temp.x('lims_api', pg_temp.pcl(61, 81), NULL, $q$DELETE FROM core.idempotency_keys WHERE key = 'plat-1'$q$, 'w'), '1', 'platform actor releases its own in_progress key');

-- ---------------------------------------------------------------- 13. rate limit (REQ-SEC-078 / 079 DB fallback)
SELECT is(pg_temp.x('lims_api', NULL, NULL, $q$SELECT allowed::text || ':' || retry_after_seconds FROM app.ratelimit_hit('rl-key-1', 60, 3)$q$), 'true:0', 'ratelimit_hit: first hit allowed');
SELECT is(pg_temp.x('lims_api', NULL, NULL, $q$SELECT allowed::text FROM app.ratelimit_hit('rl-key-1', 60, 3)$q$), 'true', 'second hit allowed');
SELECT is(pg_temp.x('lims_api', NULL, NULL, $q$SELECT allowed::text FROM app.ratelimit_hit('rl-key-1', 60, 3)$q$), 'true', 'third hit allowed (limit is inclusive)');
SELECT is(pg_temp.x('lims_api', NULL, NULL, $q$SELECT allowed::text || ':' || (retry_after_seconds BETWEEN 1 AND 60)::text FROM app.ratelimit_hit('rl-key-1', 60, 3)$q$), 'false:true', 'fourth hit refused with 1..60 s retry-after');
SELECT is(pg_temp.x('lims_worker', NULL, NULL, $q$SELECT allowed::text FROM app.ratelimit_hit('rl-key-other', 60, 3)$q$), 'true', 'other keys are independent');
SELECT is((SELECT sum(hits)::int FROM core.rate_limit_counters WHERE key_hash = 'rl-key-1'), 4, 'hits are counted (refused hits too)');
SELECT is(pg_temp.x('lims_app', NULL, NULL, $q$SELECT allowed::text FROM app.ratelimit_hit('rl-key-x', 60, 3)$q$), 'E42501:permission denied for function ratelimit_hit', 'lims_app cannot call ratelimit_hit');
SELECT is(pg_temp.x('lims_api', NULL, NULL, $q$SELECT allowed::text FROM app.ratelimit_hit('rl-key-z', 60, 0)$q$), 'false', 'limit 0 refuses the first hit');

-- ---------------------------------------------------------------- 14. retention purges (schema test 31; AC-0D-5.16): 10,000+ expired rows per table, unexpired kept, GUC '' afterwards
INSERT INTO core.event_log (tenant_id, event_id, event_type, producer, idempotency_key, aggregate_type, aggregate_id, aggregate_seq, occurred_at, envelope, created_at, created_by)
  SELECT pg_temp.id(1 + (g % 2)), gen_random_uuid(), 'bulk.old', 'lab', 'bulk' || g, 's', gen_random_uuid(), 1, now(), '{}', now() - interval '120 days', pg_temp.id(70) FROM generate_series(1, 10500) g;
INSERT INTO lab.event_inbox (tenant_id, event_id, event_type, received_at, created_by) SELECT pg_temp.id(1), gen_random_uuid(), 'bulk.old', now() - interval '120 days', pg_temp.id(90) FROM generate_series(1, 10500);
INSERT INTO frontdesk.event_inbox (tenant_id, event_id, event_type, received_at, created_by) SELECT pg_temp.id(2), gen_random_uuid(), 'bulk.old', now() - interval '120 days', pg_temp.id(90) FROM generate_series(1, 3);
INSERT INTO frontdesk.event_inbox (tenant_id, event_id, event_type, received_at, created_by) SELECT pg_temp.id(2), gen_random_uuid(), 'bulk.new', now(), pg_temp.id(90) FROM generate_series(1, 4);
INSERT INTO core.idempotency_keys (tenant_id, actor_id, key, method, route, request_sha256, state, expires_at)
  SELECT CASE WHEN g % 100 = 0 THEN NULL ELSE pg_temp.id(1) END, pg_temp.id(71), 'bulk' || g, 'POST', '/x', decode(repeat('00', 32), 'hex'), 'in_progress', now() - interval '1 day' FROM generate_series(1, 10500) g;
INSERT INTO core.idempotency_keys (tenant_id, actor_id, key, method, route, request_sha256, state, expires_at) VALUES (pg_temp.id(1), pg_temp.id(71), 'fresh1', 'POST', '/x', decode(repeat('00', 32), 'hex'), 'in_progress', now() + interval '1 day');
INSERT INTO core.dead_letters (id, tenant_id, task_identifier, job_payload, last_error_code, last_error_message_redacted, attempts, first_failed_at, dead_at, state, resolved_by, resolved_at, created_by)
  SELECT gen_random_uuid(), pg_temp.id(1), 'tenant.task', '{}', 'E', 'm', 1, now() - interval '200 days', now() - interval '200 days', 'discarded', pg_temp.id(81), now() - interval '100 days', pg_temp.id(90) FROM generate_series(1, 10500);
INSERT INTO core.rate_limit_counters (key_hash, window_start, hits) SELECT 'old' || g, now() - interval '72 hours', 1 FROM generate_series(1, 10500) g;
INSERT INTO core.rate_limit_counters (key_hash, window_start, hits) VALUES ('recent', now() - interval '1 hour', 1);
CREATE TEMP TABLE pg_temp_expect AS SELECT
  (SELECT count(*) FROM core.event_log WHERE created_at < now() - interval '90 days') ev,
  (SELECT count(*) FROM lab.event_inbox WHERE received_at < now() - interval '90 days') + (SELECT count(*) FROM frontdesk.event_inbox WHERE received_at < now() - interval '90 days') inbox,
  (SELECT count(*) FROM core.idempotency_keys WHERE expires_at < now()) idem,
  (SELECT count(*) FROM core.dead_letters WHERE state <> 'open' AND resolved_at < now() - interval '90 days') dl,
  (SELECT count(*) FROM core.rate_limit_counters WHERE window_start < now() - interval '48 hours') rl;
SELECT cmp_ok((SELECT ev FROM pg_temp_expect), '>=', 10500::bigint, 'seed: 10,500+ expired event_log rows');
SELECT is(pg_temp.x('lims_worker', NULL, 'SET LOCAL statement_timeout = 300000', $q$SELECT deleted::text || ':' || capped::text || ':' || coalesce(current_setting('app.maintenance', true), '<null>') FROM app.purge_event_log()$q$), (SELECT ev || ':false:' FROM pg_temp_expect), 'schema test 31: purge_event_log deletes every expired row, capped = false, app.maintenance = ''''');
SELECT is((SELECT count(*) FROM core.event_log WHERE created_at < now() - interval '90 days'), 0::bigint, 'no expired event_log row remains');
SELECT is((SELECT count(*) FROM core.event_log WHERE idempotency_key = 'new1'), 1::bigint, 'unexpired event_log row kept');
SELECT is(pg_temp.x('lims_worker', NULL, 'SET LOCAL statement_timeout = 300000', $q$SELECT deleted::text || ':' || capped::text || ':' || coalesce(current_setting('app.maintenance', true), '<null>') FROM app.purge_event_inboxes()$q$), (SELECT inbox || ':false:' FROM pg_temp_expect), 'purge_event_inboxes: expired rows of every inbox schema deleted');
SELECT is((SELECT count(*) FROM frontdesk.event_inbox) + (SELECT count(*) FROM lab.event_inbox WHERE received_at >= now() - interval '90 days'), 5::bigint, 'unexpired inbox rows kept (4 frontdesk + 1 lab)');
SELECT is(pg_temp.x('lims_worker', NULL, 'SET LOCAL statement_timeout = 300000', $q$SELECT deleted::text || ':' || capped::text || ':' || coalesce(current_setting('app.maintenance', true), '<null>') FROM app.purge_idempotency_keys()$q$), (SELECT idem || ':false:' FROM pg_temp_expect),
  'schema test 27/31: purge_idempotency_keys deletes expired rows incl. NULL-tenant ones');
SELECT is((SELECT count(*) FROM core.idempotency_keys WHERE tenant_id IS NULL AND expires_at < now()), 0::bigint, 'no expired NULL-tenant key remains');
SELECT is((SELECT count(*) FROM core.idempotency_keys WHERE key = 'fresh1'), 1::bigint, 'unexpired idempotency key kept');
SELECT is(pg_temp.x('lims_worker', NULL, 'SET LOCAL statement_timeout = 300000', $q$SELECT deleted::text || ':' || capped::text || ':' || coalesce(current_setting('app.maintenance', true), '<null>') FROM app.purge_dead_letters()$q$), (SELECT dl || ':false:' FROM pg_temp_expect),
  'purge_dead_letters deletes expired resolved rows (tenant rows included)');
SELECT is((SELECT count(*) FROM core.dead_letters WHERE id IN (pg_temp.id(552), pg_temp.id(501))), 2::bigint, 'open dead letters are never purged');
SELECT is((SELECT count(*) FROM core.dead_letters WHERE state <> 'open' AND resolved_at < now() - interval '90 days'), 0::bigint, 'no expired resolved dead letter remains');
SELECT is(pg_temp.x('lims_worker', NULL, 'SET LOCAL statement_timeout = 300000', $q$SELECT deleted::text || ':' || capped::text FROM app.purge_ratelimit_counters()$q$), (SELECT rl || ':false' FROM pg_temp_expect), 'purge_ratelimit_counters deletes counters older than 48 h');
SELECT is((SELECT count(*) FROM core.rate_limit_counters WHERE key_hash = 'recent'), 1::bigint, 'recent counter kept');
SELECT is(pg_temp.x('lims_worker', NULL, NULL, $q$SELECT deleted::text || ':' || capped::text FROM app.purge_event_log()$q$), '0:false', 'a second run deletes nothing');
SELECT is(pg_temp.x('lims_api', NULL, NULL, $q$SELECT deleted FROM app.purge_event_log()$q$), 'E42501:permission denied for function purge_event_log', 'lims_api cannot run a purge');
SELECT is(pg_temp.x('lims_app', NULL, NULL, $q$SELECT deleted FROM app.purge_dead_letters()$q$), 'E42501:permission denied for function purge_dead_letters', 'lims_app cannot run a purge');

SELECT * FROM finish();
ROLLBACK;
