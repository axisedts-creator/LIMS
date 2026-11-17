-- T0B-04 live-DB assertions: access-action seed loaded + FK-enforced, class-A grants (AC-0B-4.3, AC-0B-5.3), audit indexes (08 A28.6),
-- app-role writes denied. Synthetic data only, one rolled-back txn, no RLS disabled.
-- Run on a bootstrapped + migrated + SEEDED (db/seeds/001-003) test DB as superuser:  pg_prove -d <db> db/tests/audit/T0B-04_audit.test.sql  (pgTAP in `extensions`)
BEGIN;
SET search_path = extensions, public, pg_catalog;
SELECT * FROM no_plan();

CREATE FUNCTION pg_temp.id(k text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('01900000-0000-7000-8000-0000000000' || lpad(k, 2, '0'))::uuid $$;
CREATE FUNCTION pg_temp.as_x(p_role text, p_claims text, p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE r text; n bigint;
BEGIN
  PERFORM set_config('request.jwt.claims', coalesce(p_claims, ''), true);
  EXECUTE format('SET LOCAL ROLE %I', p_role);
  BEGIN EXECUTE p_sql; GET DIAGNOSTICS n = ROW_COUNT; r := 'n=' || n;
  EXCEPTION WHEN OTHERS THEN r := 'E' || SQLSTATE;
  END;
  RESET ROLE; PERFORM set_config('request.jwt.claims', '', true);
  RETURN r;
END $f$;
CREATE FUNCTION pg_temp.cl(p_type text, p_tenant text, p_sub text) RETURNS text LANGUAGE sql AS
$$ SELECT jsonb_build_object('actor_type', p_type, 'tenant_id', pg_temp.id(p_tenant), 'sub', pg_temp.id(p_sub))::text $$;

-- ---------- seed (05-SCHEMA §3.7) ----------
SELECT has_table('audit', 'g_cs_access_actions', 'coded set exists');
SELECT cmp_ok((SELECT count(*) FROM audit.g_cs_access_actions), '>=', 90::bigint, 'seed loaded: base list + 03-IC §13.1');
SELECT is((SELECT count(*) FROM audit.g_cs_access_actions WHERE code !~ '^[a-z_]+\.[a-z_]+$'), 0::bigint, 'every seeded code matches ^[a-z_]+\.[a-z_]+$');
SELECT is((SELECT count(*) FROM audit.g_cs_access_actions WHERE NOT is_active OR system <> 'lims' OR system_version <> '1' OR btrim(display) = ''), 0::bigint, 'defaults: active, system lims/1, non-empty display');
SELECT is((SELECT count(*) FROM audit.g_cs_access_actions WHERE code IN ('report.view', 'dead_letter.discard', 'support_session.open', 'auth.login_failure', 'audit_entry.view', 'report.release', 'home_visit.view', 'patient_account.delete')), 8::bigint, 'base and 03-IC §13.1 codes present');
SELECT is((SELECT count(*) FROM audit.g_cs_access_actions WHERE code IN ('patient.demographics_access', 'tenant_egress_ip.change', 'legacy_document.download')), 0::bigint, 'removed / withdrawn / reserved codes not seeded');

-- ---------- FK access_log.action -> g_cs_access_actions.code, written by the real writer role ----------
SET LOCAL session_replication_role = replica;
INSERT INTO core.tenants (id, tenant_code, legal_name, display_name, status, created_by, updated_by)
  VALUES (pg_temp.id('01'), 'lab_a', 'Lab A Pvt Ltd', 'Lab A', 'active', pg_temp.id('99'), pg_temp.id('99'));
SET LOCAL session_replication_role = origin;
SELECT is(pg_temp.as_x('lims_api', pg_temp.cl('user', '01', '31'), format($$INSERT INTO audit.access_log (id, tenant_id, actor_id, actor_type, action, entity_type, outcome, created_by)
  VALUES (%L, %L, %L, 'user', 'report.view', 'report', 'allowed', %L)$$, pg_temp.id('a1'), pg_temp.id('01'), pg_temp.id('31'), pg_temp.id('31'))), 'n=1', 'access_log insert with a seeded action succeeds (lims_api)');
SELECT is(pg_temp.as_x('lims_api', pg_temp.cl('user', '01', '31'), format($$INSERT INTO audit.access_log (id, tenant_id, actor_id, actor_type, action, entity_type, outcome, created_by)
  VALUES (%L, %L, %L, 'user', 'report.exfiltrate', 'report', 'allowed', %L)$$, pg_temp.id('a2'), pg_temp.id('01'), pg_temp.id('31'), pg_temp.id('31'))), 'E23503', 'unknown action -> 23503 (FK to the coded set)');
SELECT is(pg_temp.as_x('lims_app', NULL, $$INSERT INTO audit.g_cs_access_actions (code, display) VALUES ('x.y', 'X')$$), 'E42501', 'lims_app cannot add a coded value (class G, read-only)');
SELECT is(pg_temp.as_x('lims_api', NULL, $$UPDATE audit.g_cs_access_actions SET is_active = false$$), 'E42501', 'lims_api cannot UPDATE the coded set');
SELECT is(pg_temp.as_x('lims_api', NULL, $$DELETE FROM audit.g_cs_access_actions$$), 'E42501', 'lims_api cannot DELETE from the coded set');

-- ---------- AC-0B-5.3: lims_app cannot insert audit.audit_log; AC-0B-4.3: UPDATE false on class A ----------
SELECT is(has_table_privilege('lims_app', 'audit.audit_log', 'INSERT'), false, 'AC-0B-5.3: lims_app has no INSERT on audit.audit_log');
SELECT is(pg_temp.as_x('lims_app', pg_temp.cl('user', '01', '31'), format($$INSERT INTO audit.audit_log (id, tenant_id, schema_name, table_name, action, actor_id, actor_type, created_by)
  VALUES (%L, %L, 'core', 'users', 'INSERT', %L, 'user', %L)$$, pg_temp.id('b1'), pg_temp.id('01'), pg_temp.id('31'), pg_temp.id('31'))), 'E42501', 'AC-0B-5.3: direct INSERT INTO audit.audit_log as lims_app -> 42501');
SELECT is(pg_temp.as_x('lims_api', pg_temp.cl('user', '01', '31'), format($$INSERT INTO audit.audit_log (id, tenant_id, schema_name, table_name, action, actor_id, actor_type, created_by)
  VALUES (%L, %L, 'core', 'users', 'INSERT', %L, 'user', %L)$$, pg_temp.id('b2'), pg_temp.id('01'), pg_temp.id('31'), pg_temp.id('31'))), 'E42501', 'lims_api direct INSERT -> 42501');
SELECT is(pg_temp.as_x('lims_worker', pg_temp.cl('system', '01', '31'), format($$INSERT INTO audit.audit_log (id, tenant_id, schema_name, table_name, action, actor_id, actor_type, created_by)
  VALUES (%L, %L, 'core', 'users', 'INSERT', %L, 'system', %L)$$, pg_temp.id('b3'), pg_temp.id('01'), pg_temp.id('31'), pg_temp.id('31'))), 'E42501', 'lims_worker direct INSERT -> 42501');
SELECT results_eq($$SELECT r, t, p, has_table_privilege(r, t, p) FROM unnest(ARRAY['lims_app','lims_api','lims_worker']) r, unnest(ARRAY['audit.audit_log','audit.access_log']) t,
  unnest(ARRAY['UPDATE','DELETE','TRUNCATE']) p ORDER BY 1, 2, 3$$,
  $$SELECT r, t, p, false FROM unnest(ARRAY['lims_app','lims_api','lims_worker']) r, unnest(ARRAY['audit.audit_log','audit.access_log']) t,
  unnest(ARRAY['UPDATE','DELETE','TRUNCATE']) p ORDER BY 1, 2, 3$$, 'AC-0B-4.3: no UPDATE/DELETE/TRUNCATE privilege for app roles on audit_log / access_log');
SELECT is(has_table_privilege('lims_app', 'audit.access_log', 'INSERT'), true, 'access_log: lims_app may INSERT (ctx.audit.access)');
SELECT is(has_table_privilege('lims_app', 'audit.audit_log', 'SELECT') AND has_table_privilege('lims_app', 'audit.access_log', 'SELECT'), true, 'lims_app may SELECT both (policy-filtered)');
SELECT is(pg_temp.as_x('lims_api', pg_temp.cl('user', '01', '31'), $$UPDATE audit.access_log SET outcome = 'denied'$$), 'E42501', 'access_log UPDATE -> 42501 (append-only)');
SELECT is(pg_temp.as_x('lims_api', pg_temp.cl('user', '01', '31'), $$DELETE FROM audit.access_log$$), 'E42501', 'access_log DELETE -> 42501');
SELECT is((SELECT count(*) FROM information_schema.role_table_grants WHERE table_schema = 'audit' AND table_name IN ('audit_log', 'access_log') AND grantee = 'PUBLIC'), 0::bigint, 'no PUBLIC grant on the audit tables');
SELECT is((SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'audit' AND c.relname IN ('audit_log', 'access_log') AND c.relrowsecurity AND c.relforcerowsecurity), 2::bigint, 'ENABLE + FORCE RLS on both audit tables');

-- ---------- indexes (08 A28.6) ----------
SELECT has_index('audit', 'audit_log', 'audit_log__tenant_id_request_id__idx', ARRAY['tenant_id', 'request_id'], 'audit_log request_id index');
SELECT has_index('audit', 'access_log', 'access_log__tenant_id_request_id__idx', ARRAY['tenant_id', 'request_id'], 'access_log request_id index');
SELECT is((SELECT count(*) FROM pg_indexes WHERE schemaname = 'audit' AND indexname IN ('audit_log__tenant_id_support_session__p_idx', 'access_log__tenant_id_support_session__p_idx')
  AND indexdef ILIKE '%(tenant_id, support_session_id, occurred_at DESC)%' AND indexdef ILIKE '%WHERE (support_session_id IS NOT NULL)%'), 2::bigint, 'support_session partial indexes on both tables');

-- ---------- policy catalog mirrors db/policies/audit.sql ----------
SELECT is(ARRAY(SELECT tablename::text || '|' || policyname::text || '|' || cmd::text FROM pg_policies WHERE schemaname = 'audit' AND tablename IN ('audit_log', 'access_log') ORDER BY tablename::text || '|' || policyname::text || '|' || cmd::text COLLATE "C"),
  ARRAY['access_log|access_log__insert__partner|INSERT', 'access_log|access_log__insert__patient|INSERT', 'access_log|access_log__insert__portal|INSERT',
  'access_log|access_log__insert__tenant|INSERT', 'access_log|access_log__select__tenant|SELECT',
  'audit_log|audit_log__insert__owner_only|INSERT', 'audit_log|audit_log__select__tenant|SELECT']::text[], 'policy inventory on audit.* (no UPDATE/DELETE policy)');
SELECT is((SELECT count(*) FROM pg_policies WHERE schemaname = 'audit' AND cmd = 'SELECT' AND qual ILIKE '%has_all_centres%' AND qual ILIKE '%current_centre_ids%'), 2::bigint, 'CR-C2-010 centre clause in both SELECT policies');

SELECT * FROM finish();
ROLLBACK;
