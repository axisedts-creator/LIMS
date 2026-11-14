-- T0B-05 live-DB assertions (pgTAP): app.enqueue_job + app.queue_depth (05-SCHEMA §10 schema tests 22, 23; AC-0D-5.14 / 5.15).
-- Split out of T0B-05_platform.test.sql: needs the real graphile_worker schema, which the migration runner installs inside the D-201 window
-- (SP-2 step 2: PGOPTIONS='-c role=lims_queue' graphile-worker --schema-only). Without it this file fails at the first graphile_worker.jobs read — by design.
-- Synthetic data only. One rolled-back transaction. RLS is never disabled.
-- Run from the repo root: bash db/tests/run-suites.sh db/tests/core/T0B-05_queue.test.sql
BEGIN;
SET search_path = extensions, public, pg_catalog;
SELECT * FROM no_plan();

-- ---------------------------------------------------------------- helpers (same contract as T0B-05_platform.test.sql)
CREATE FUNCTION pg_temp.id(k int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('01900000-0000-7000-8000-' || lpad(k::text, 12, '0'))::uuid $$;
-- run p_sql as p_role with claims p_claims (NULL = none); p_pre runs first in the same role. Modes: v scalar · n row count · w DML row count.
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

-- ---------------------------------------------------------------- fixtures (superuser)
SET LOCAL session_replication_role = replica;
INSERT INTO core.tenants (id, tenant_code, legal_name, display_name, status, created_by, updated_by) VALUES
  (pg_temp.id(1), 'lab_a', 'Lab A Pvt Ltd', 'Lab A', 'active',    pg_temp.id(99), pg_temp.id(99)),
  (pg_temp.id(2), 'lab_b', 'Lab B Pvt Ltd', 'Lab B', 'suspended', pg_temp.id(99), pg_temp.id(99));
SET LOCAL session_replication_role = origin;
INSERT INTO core.g_task_registry (identifier, module, kind, scope, max_attempts, is_active) VALUES
  ('plat.task',   'core',    'task', 'platform',   3, true),
  ('tenant.task', 'catalog', 'task', 'per_tenant', 5, true),
  ('off.task',    'core',    'task', 'platform',   3, false);

-- ---------------------------------------------------------------- 9. app.enqueue_job + queue_depth (schema tests 22, 23; AC-0D-5.14 / 5.15)
SELECT is(pg_temp.x('lims_api', pg_temp.tcl(1, 90), NULL, $q$SELECT app.enqueue_job('tenant.task', '{"tenant_id":"01900000-0000-7000-8000-000000000001"}', 'tenant.task:t1:2026-11-07T09:00')::text$q$), '', 'enqueue per_tenant job with matching tenant claims');
SELECT is((SELECT count(*) FROM graphile_worker.jobs WHERE key = 'tenant.task:t1:2026-11-07T09:00'), 1::bigint, 'one job enqueued');
SELECT is(pg_temp.x('lims_api', pg_temp.tcl(1, 90), NULL, $q$SELECT app.enqueue_job('tenant.task', '{"tenant_id":"01900000-0000-7000-8000-000000000001"}', 'tenant.task:t1:2026-11-07T09:00')::text$q$), '', 'second call with the same key succeeds');
SELECT is((SELECT count(*) FROM graphile_worker.jobs WHERE key = 'tenant.task:t1:2026-11-07T09:00'), 1::bigint, 'AC-0D-5.15: same key enqueues nothing new (dedupe)');
SELECT is((SELECT max_attempts::int FROM graphile_worker.jobs WHERE key = 'tenant.task:t1:2026-11-07T09:00'), 5, 'max_attempts defaults to the registry value');
SELECT is(pg_temp.x('lims_api', NULL, NULL, $q$SELECT app.enqueue_job('tenant.task', '{"tenant_id":"01900000-0000-7000-8000-000000000001"}', 'nokey1')::text$q$), 'EP0001:job_tenant_mismatch', 'schema test 22: per_tenant enqueue without tenant claims -> job_tenant_mismatch');
SELECT is(pg_temp.x('lims_api', pg_temp.tcl(1, 90), NULL, $q$SELECT app.enqueue_job('tenant.task', '{"tenant_id":"01900000-0000-7000-8000-000000000002"}', 'nokey2')::text$q$), 'EP0001:job_tenant_mismatch', 'schema test 22: another tenant''s id in the payload -> job_tenant_mismatch');
SELECT is(pg_temp.x('lims_api', pg_temp.tcl(1, 90), NULL, $q$SELECT app.enqueue_job('tenant.task', '{}', 'nokey3')::text$q$), 'EP0001:job_tenant_mismatch', 'missing payload tenant_id -> job_tenant_mismatch');
SELECT is(pg_temp.x('lims_api', pg_temp.pcl(61, 81), NULL, $q$SELECT app.enqueue_job('tenant.task', '{"tenant_id":"01900000-0000-7000-8000-000000000001"}', 'nokey4')::text$q$), 'EP0001:job_tenant_mismatch', 'schema test 23: platform claims only (no tenant) -> job_tenant_mismatch');
SELECT is(pg_temp.x('lims_api', pg_temp.tcl(1, 90), NULL, $q$SELECT app.enqueue_job('plat.task', '{"x":1}', 'plat1')::text$q$), '', 'platform-scope identifier does not need a matching tenant');
SELECT is(pg_temp.x('lims_api', pg_temp.tcl(1, 90), NULL, $q$SELECT app.enqueue_job('nope.task', '{}', 'nokey5')::text$q$), 'EP0001:unknown_task_identifier', 'unknown identifier refused');
SELECT is(pg_temp.x('lims_api', pg_temp.tcl(1, 90), NULL, $q$SELECT app.enqueue_job('off.task', '{}', 'nokey6')::text$q$), 'EP0001:unknown_task_identifier', 'inactive identifier refused');
SELECT is((SELECT count(*) FROM graphile_worker.jobs WHERE key LIKE 'nokey%'), 0::bigint, 'no refused call enqueued anything');
SELECT is(pg_temp.x('lims_api', pg_temp.tcl(1, 90), NULL, $q$SELECT app.enqueue_job('plat.task', '{}', 'rn1', now() + interval '1 day', 9)::text$q$), '', 'run_at / max_attempts overrides accepted');
SELECT is((SELECT max_attempts || ':' || (run_at > now() + interval '23 hours')::text FROM graphile_worker.jobs WHERE key = 'rn1'), '9:true', 'overrides applied');
SELECT is(pg_temp.x('lims_api', pg_temp.tcl(1, 90), NULL, $q$SELECT graphile_worker.add_job('plat.task', '{}'::json)::text$q$), 'E42501:permission denied for schema graphile_worker', 'lims_api cannot call add_job directly (SP-2)');
SELECT is(pg_temp.x('lims_api', pg_temp.tcl(1, 90), NULL, $q$SELECT count(*) FROM graphile_worker.jobs$q$), 'E42501:permission denied for schema graphile_worker', 'lims_api cannot read the queue');
-- schema test 23: tenant-row replay key under the owning module's system actor
SELECT is(pg_temp.x('lims_api', pg_temp.tcl(1, 90), NULL, format($q$SELECT app.enqueue_job('tenant.task', '{"tenant_id":"01900000-0000-7000-8000-000000000001"}', %L)::text$q$, 'jk-511:replay:2')), '', 'schema test 23: replay enqueue inside the tenant scope succeeds');
SELECT is((SELECT count(*) FROM graphile_worker.jobs WHERE key = 'jk-511:replay:2'), 1::bigint, 'schema test 23: exactly one job with the replay key');
SELECT is(pg_temp.x('lims_worker', NULL, NULL, $q$SELECT ready || ':' || locked || ':' || failed FROM app.queue_depth() WHERE task_identifier = 'tenant.task'$q$), '2:0:0', 'queue_depth counts ready jobs per task (counts only)');
SELECT is(pg_temp.x('lims_api', NULL, NULL, $q$SELECT * FROM app.queue_depth()$q$, 'n'), 'E42501:permission denied for function queue_depth', 'lims_api cannot call queue_depth');
SELECT is((SELECT pg_get_function_result(to_regprocedure('app.queue_depth()'))), 'TABLE(task_identifier text, ready bigint, locked bigint, failed bigint)', 'queue_depth result shape (counts only)');

SELECT * FROM finish();
ROLLBACK;
