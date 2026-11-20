-- T0B-ASYNC-1 (audit RS-11; LD-189 AUTH-SENSITIVE; LD-277) live-DB assertions for the one grant of the task:
--   EXECUTE on app.identity_login_context(uuid) for lims_worker (identity.send_recovery runs as lims_worker and calls it; today EXECUTE is lims_api only).
-- Asserted: lims_worker and lims_api may execute it; PUBLIC, lims_app (the group both logins inherit from), lims_queue, anon, authenticated may not;
--   the ACL names exactly {owner, lims_api, lims_worker}; the function itself is unchanged (SECURITY DEFINER, lims_owner, search_path ''),
--   the other api-only identity definers stay closed to lims_worker, and no policy changed.
-- Catalog test: every app.* function that worker SQL calls exists and lims_worker may execute every overload of it. The list below is kept
--   equal to the worker sources by services/worker/src/core/__tests__/worker-sql-functions.test.ts (a call added there fails that test until it is added here).
-- Run: pg_prove -d <migrated db> db/tests/identity/T0B-ASYNC-1_worker_grants.test.sql   (superuser; pgTAP in schema `extensions`)  or  db/tests/run-suites.sh
-- NOT run by its author (the lane has no psql / docker): the lead runs it on the machine. Catalog reads only; synthetic: nothing is written. One rolled-back transaction.
BEGIN;
SET search_path = extensions, public, pg_catalog;
SELECT * FROM no_plan();

CREATE FUNCTION pg_temp.x(p_role text, p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE r text;
BEGIN
  PERFORM set_config('request.jwt.claims', '', true);
  EXECUTE format('SET LOCAL ROLE %I', p_role);
  BEGIN EXECUTE p_sql INTO r; r := coalesce(r, '<null>');
  EXCEPTION WHEN OTHERS THEN r := 'E' || SQLSTATE || ':' || SQLERRM;
  END;
  RESET ROLE;
  RETURN r;
END $f$;

-- ================================================================ the function and its grant
SELECT ok(to_regprocedure('app.identity_login_context(uuid)') IS NOT NULL, 'exists: app.identity_login_context(uuid)');
SELECT ok(has_function_privilege('lims_worker', 'app.identity_login_context(uuid)', 'EXECUTE'), 'lims_worker MAY execute app.identity_login_context (send_recovery)');
SELECT ok(has_function_privilege('lims_api',    'app.identity_login_context(uuid)', 'EXECUTE'), 'lims_api still may execute it (login)');
SELECT ok(NOT has_function_privilege('lims_app',   'app.identity_login_context(uuid)', 'EXECUTE'), 'lims_app (group role) still may NOT execute it');
SELECT ok(NOT has_function_privilege('lims_queue', 'app.identity_login_context(uuid)', 'EXECUTE'), 'lims_queue may NOT execute it');
SELECT ok(NOT EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname IN ('anon', 'authenticated') AND has_function_privilege(r.oid, 'app.identity_login_context(uuid)', 'EXECUTE')),
          'anon / authenticated may NOT execute it');
SELECT ok(p.proacl IS NOT NULL AND NOT EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0), 'PUBLIC has no EXECUTE (proacl is explicit and has no PUBLIC entry)')
  FROM pg_proc p WHERE p.oid = to_regprocedure('app.identity_login_context(uuid)');
SELECT is((SELECT array_agg(DISTINCT pg_get_userbyid(a.grantee)::text ORDER BY pg_get_userbyid(a.grantee)::text)
             FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = to_regprocedure('app.identity_login_context(uuid)') AND a.privilege_type = 'EXECUTE'),
          ARRAY['lims_api', 'lims_owner', 'lims_worker']::text[], 'EXECUTE grantees are exactly lims_owner (owner), lims_api, lims_worker: nothing else was granted');
SELECT is((SELECT count(*) FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = to_regprocedure('app.identity_login_context(uuid)') AND a.is_grantable), 0::bigint, 'no grantee has WITH GRANT OPTION');

-- the function is not changed by the grant
SELECT ok(p.prosecdef, 'still SECURITY DEFINER') FROM pg_proc p WHERE p.oid = to_regprocedure('app.identity_login_context(uuid)');
SELECT is(pg_get_userbyid(p.proowner)::text, 'lims_owner', 'owner is still lims_owner') FROM pg_proc p WHERE p.oid = to_regprocedure('app.identity_login_context(uuid)');
SELECT ok(array_to_string(p.proconfig, ',') ~ 'search_path=("")?$', 'search_path is still empty') FROM pg_proc p WHERE p.oid = to_regprocedure('app.identity_login_context(uuid)');

-- it really runs as lims_worker now (no 42501); an unknown user returns no row, it does not raise
-- HARNESS T0B-GREEN-3 (assertion 13; the suite was never run by its author): app.identity_login_context (20261105000800) is `FROM (SELECT 1) x LEFT JOIN ...`, so it ALWAYS returns exactly one row; for an unknown user that row has
-- membership_count = 0 and NULL platform_staff_id / tenant_id / membership_id. Still proved: no permission error (42501) for lims_worker, and no identity data (no staff, tenant or membership) for an unknown user.
SELECT is(pg_temp.x('lims_worker', $q$SELECT count(*)::text || '|' || coalesce(max(membership_count), -1)::text || '|' || count(platform_staff_id)::text || '|' || count(tenant_id)::text || '|' || count(membership_id)::text FROM app.identity_login_context('01900000-0000-7000-8000-00000000dead'::uuid)$q$), '1|0|0|0|0', 'lims_worker calls it: no permission error, a single row with membership_count 0 and no staff / tenant / membership for an unknown user');
SELECT matches(pg_temp.x('lims_queue', $q$SELECT count(*)::text FROM app.identity_login_context('01900000-0000-7000-8000-00000000dead'::uuid)$q$), '^E42501:', 'lims_queue is still refused (42501)');

-- the grant is for this one function: the other api-only identity definers stay closed to lims_worker
SELECT ok(NOT has_function_privilege('lims_worker', p.oid, 'EXECUTE'), 'lims_worker may NOT execute ' || p.oid::regprocedure::text)
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'app' AND p.proname IN ('identity_resolve_session', 'identity_session_by_token', 'identity_user_exists', 'identity_record_auth_event',
                                            'identity_bootstrap_platform_admin', 'identity_session_actor');

-- no policy was added, dropped or weakened by this task (LD-189): the one USING (true) of the database stays the only one
SELECT is((SELECT count(*) FROM pg_policies WHERE qual = 'true' OR with_check = 'true'), 1::bigint, 'USING (true) / WITH CHECK (true) still appears exactly once');
SELECT ok(NOT EXISTS (SELECT 1 FROM pg_policies WHERE (qual ~ 'app\.(pre_|maintenance)' OR with_check ~ 'app\.(pre_|maintenance)') AND roles <> '{lims_owner}'
                      AND NOT (schemaname = 'reporting' AND roles = '{lims_reporting_lookup}')),   -- STALE T0B-GREEN-3: C6 lookup policies are TO lims_reporting_lookup (08-CR-REGISTER C6-002, A10.5, D-30; as db/tests/policy, T0B-GREEN-2)
          'every policy mentioning app.pre_* is still TO lims_owner only (reporting lookup policies: TO lims_reporting_lookup only)');

-- ================================================================ catalog: every app.* function the worker SQL calls may be executed by lims_worker
CREATE TEMP TABLE worker_app_fns(fn) AS VALUES
  ('cron_tenant_ids'), ('current_actor_id'), ('dl_insert_platform'), ('enqueue_job'), ('homecollection_anonymise_retired_visits'),
  ('identity_expire_audit_exports'), ('identity_expire_invitations'), ('identity_expire_support_sessions'),
  ('identity_finish_breached_import'), ('identity_load_breached_batch'), ('identity_login_context'),
  ('identity_purge_auth_events'), ('identity_purge_sessions'), ('instruments_agent_state_snapshot'),
  ('purge_instruments_archive'), ('purge_inventory_alerts'), ('queue_depth'), ('uuidv7');

-- REAL T0B-GREEN-3 (stays red on purpose; CR .orchestra/cr/T0B-GREEN-3.identity-worker-uuidv7.nonblocking.md): app.uuidv7() has EXECUTE for lims_owner only, so 58 (uuidv7 row) and 59 (summary) fail while worker SQL calls it.
SELECT ok(EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'app' AND p.proname = w.fn),
          'worker calls app.' || w.fn || ' and it exists') FROM worker_app_fns w;
SELECT ok(NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                       WHERE n.nspname = 'app' AND p.proname = w.fn AND NOT has_function_privilege('lims_worker', p.oid, 'EXECUTE')),
          'lims_worker may execute every overload of app.' || w.fn) FROM worker_app_fns w;
SELECT is(coalesce((SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text)
                      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN worker_app_fns w ON w.fn = p.proname
                     WHERE n.nspname = 'app' AND NOT has_function_privilege('lims_worker', p.oid, 'EXECUTE')), ''), '',
          'summary: no app.* function called by worker SQL is closed to lims_worker');

SELECT * FROM finish();
ROLLBACK;
