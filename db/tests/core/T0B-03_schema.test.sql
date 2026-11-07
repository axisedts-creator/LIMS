-- T0B-03 live-DB assertions, part 1: catalog + constraints (05-SCHEMA §3.1-§3.4, §5, §6, §7, §10 schema tests 1-6, 8, 17(catalog), 24(catalog),
-- 26(catalog), 33; AC-0B-2.1, AC-0B-2.2, AC-0B-5.3 (grants)). Synthetic data only. Writes happen as lims_api with tenant claims, inside one rolled-back txn.
-- Run on a bootstrapped + migrated test DB as superuser:  pg_prove -d <db> db/tests/core/T0B-03_schema.test.sql   (pgTAP in schema `extensions`)
-- Not covered here (other tasks): test 7/9 dead_letters (T0B-05), membership_branches + tg_scope_user_only (T0B-06). No RLS is disabled in this file.
BEGIN;
SET search_path = extensions, public, pg_catalog;
SELECT * FROM no_plan();

-- ---------- helpers (temp objects; rolled back) ----------
CREATE FUNCTION pg_temp.id(k text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('01900000-0000-7000-8000-0000000000' || lpad(k, 2, '0'))::uuid $$;
CREATE FUNCTION pg_temp.cl(p_type text, p_tenant text DEFAULT NULL, p_sub text DEFAULT '99', p_mem text DEFAULT NULL, p_extra jsonb DEFAULT '{}') RETURNS text
LANGUAGE sql AS $$ SELECT (jsonb_strip_nulls(jsonb_build_object('actor_type', p_type, 'tenant_id', pg_temp.id(p_tenant), 'sub', pg_temp.id(p_sub),
  'membership_id', pg_temp.id(p_mem))) || p_extra)::text $$;
-- runs p_sql as p_role with claims p_claims; mode w = write (rowcount), n = count of a SELECT, v = first value. Returns 'n=3' | 'v=x' | 'E<sqlstate>:<message>'
CREATE FUNCTION pg_temp.as_x(p_role text, p_claims text, p_sql text, p_mode text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE r text; n bigint;
BEGIN
  PERFORM set_config('request.jwt.claims', coalesce(p_claims, ''), true);
  EXECUTE format('SET LOCAL ROLE %I', p_role);
  BEGIN
    IF p_mode = 'v' THEN EXECUTE p_sql INTO r; r := 'v=' || coalesce(r, '<null>');
    ELSIF p_mode = 'n' THEN EXECUTE 'SELECT count(*) FROM (' || p_sql || ') t' INTO n; r := 'n=' || n;
    ELSE EXECUTE p_sql; GET DIAGNOSTICS n = ROW_COUNT; r := 'n=' || n; END IF;
  EXCEPTION WHEN OTHERS THEN r := 'E' || SQLSTATE || ':' || SQLERRM;
  END;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN r;
END $f$;
CREATE FUNCTION pg_temp.w(c text, s text) RETURNS text LANGUAGE sql AS $$ SELECT pg_temp.as_x('lims_api', c, s, 'w') $$;
CREATE FUNCTION pg_temp.n(c text, s text) RETURNS text LANGUAGE sql AS $$ SELECT pg_temp.as_x('lims_api', c, s, 'n') $$;
CREATE FUNCTION pg_temp.v(c text, s text) RETURNS text LANGUAGE sql AS $$ SELECT pg_temp.as_x('lims_api', c, s, 'v') $$;
CREATE FUNCTION pg_temp.uA() RETURNS text LANGUAGE sql AS $$ SELECT pg_temp.cl('user', '01', '31', '41') $$;   -- staff of tenant A, centre A1
CREATE FUNCTION pg_temp.uB() RETURNS text LANGUAGE sql AS $$ SELECT pg_temp.cl('user', '02', '33', '43') $$;   -- staff of tenant B

-- ---------- fixtures (superuser; triggers off so nothing is audited by seeding) ----------
SET LOCAL session_replication_role = replica;
INSERT INTO core.tenants (id, tenant_code, legal_name, display_name, status, created_by, updated_by) VALUES
  (pg_temp.id('01'), 'lab_a', 'Lab A Pvt Ltd', 'Lab A', 'active', pg_temp.id('99'), pg_temp.id('99')),
  (pg_temp.id('02'), 'lab_b', 'Lab B Pvt Ltd', 'Lab B', 'active', pg_temp.id('99'), pg_temp.id('99'));
INSERT INTO core.branches (id, tenant_id, branch_code, name, created_by, updated_by) VALUES
  (pg_temp.id('11'), pg_temp.id('01'), 'BA', 'Branch A', pg_temp.id('99'), pg_temp.id('99')),
  (pg_temp.id('12'), pg_temp.id('02'), 'BB', 'Branch B', pg_temp.id('99'), pg_temp.id('99'));
INSERT INTO core.users (tenant_id, id, display_name, created_by, updated_by)
  SELECT t, pg_temp.id(u), 'User ' || u, pg_temp.id('99'), pg_temp.id('99')
  FROM (VALUES ('01','31'),('01','32'),('01','34'),('01','35'),('02','33'),('01','61'),('01','62'),('01','63'),('01','64'),('01','65'),('01','70'),('02','70')) v(t0, u),
       LATERAL (SELECT pg_temp.id(t0) AS t) x;
INSERT INTO core.memberships (id, tenant_id, user_id, actor_type, all_centres, partner_role, created_by, updated_by) VALUES
  (pg_temp.id('41'), pg_temp.id('01'), pg_temp.id('31'), 'user',    false, NULL,             pg_temp.id('99'), pg_temp.id('99')),
  (pg_temp.id('42'), pg_temp.id('01'), pg_temp.id('32'), 'user',    true,  NULL,             pg_temp.id('99'), pg_temp.id('99')),
  (pg_temp.id('43'), pg_temp.id('02'), pg_temp.id('33'), 'user',    false, NULL,             pg_temp.id('99'), pg_temp.id('99')),
  (pg_temp.id('44'), pg_temp.id('01'), pg_temp.id('34'), 'patient', false, NULL,             pg_temp.id('99'), pg_temp.id('99')),
  (pg_temp.id('45'), pg_temp.id('01'), pg_temp.id('35'), 'partner', false, 'partner_member', pg_temp.id('99'), pg_temp.id('99'));
INSERT INTO core.g_permissions (code, module, privileged, phase) VALUES ('lab.result.view', 'lab', false, '1') ON CONFLICT DO NOTHING;
SET LOCAL session_replication_role = origin;

-- ================= AC-0B-2.1 / 2.2: catalog =================
SELECT is_empty($$SELECT n.nspname || '.' || c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind = 'r' AND n.nspname IN ('core','audit') AND NOT (c.relrowsecurity AND c.relforcerowsecurity)
  EXCEPT SELECT unnest(ARRAY['core.g_permissions','core.g_system_actors','core.g_task_registry','core.rate_limit_counters','audit.g_cs_access_actions'])$$,
  'AC-0B-2.1: every core/audit table lacking ENABLE+FORCE RLS is on the rls_exempt list');
SELECT is(count(*)::int, 11, 'ENABLE + FORCE RLS on the 11 T0B-03 RLS tables')
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE (n.nspname, c.relname) IN (('core','tenants'),('core','branches'),('core','collection_centres'),('core','users'),('core','memberships'),
    ('core','membership_centres'),('core','roles'),('core','role_permissions'),('core','membership_roles'),('audit','audit_log'),('audit','access_log'))
    AND c.relrowsecurity AND c.relforcerowsecurity;
SELECT is_empty($$SELECT n.nspname || '.' || c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind = 'r' AND n.nspname IN ('core','audit') AND c.relowner <> 'lims_owner'::regrole$$, 'core/audit tables are owned by lims_owner');
SELECT is((SELECT relrowsecurity OR relforcerowsecurity FROM pg_class WHERE oid = 'core.g_permissions'::regclass), false, 'class-G core.g_permissions has no RLS');
SELECT is_empty($$SELECT schemaname || '.' || tablename || '.' || policyname FROM pg_policies WHERE schemaname IN ('core','audit')
  AND (roles && ARRAY['public','anon','authenticated']::name[])$$, 'AC-0B-2.2: no policy TO public/anon/authenticated');
SELECT is_empty($$SELECT policyname FROM pg_policies WHERE schemaname IN ('core','audit') AND (trim(qual) IN ('true','(true)') OR trim(with_check) IN ('true','(true)'))$$,
  'AC-0B-2.2: no USING (true) / WITH CHECK (true)');
SELECT is_empty($$SELECT policyname FROM pg_policies WHERE schemaname IN ('core','audit')
  AND (policyname !~ '^[a-z_]+__(select|insert|update|delete)__[a-z_]+$' OR lower(cmd) <> split_part(policyname, '__', 2))$$,
  'AC-0B-2.2: policy names are <table>__<cmd>__<scope> and match the command');
SELECT is_empty($$SELECT policyname FROM pg_policies WHERE schemaname IN ('core','audit') AND policyname ~ '__(select|insert|update|delete)__' AND policyname !~ ('^' || tablename || '__')$$,
  'policy names start with the table name');

-- schema test 17 (catalog) + P-16 / A16.1 rules
SELECT is(roles::text, '{lims_owner}', policyname || ' TO lims_owner only')
  FROM pg_policies WHERE schemaname = 'core' AND policyname IN ('memberships__select__owner_only','users__select__owner_only','tenants__select__owner_only',
    'roles__select__owner_only','membership_roles__select__owner_only');
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'core' AND policyname IN ('memberships__select__owner_only','users__select__owner_only',
  'tenants__select__owner_only','roles__select__owner_only','membership_roles__select__owner_only')), 5, 'all five GUC-bound core owner SELECT policies exist');
SELECT is_empty($$SELECT policyname FROM pg_policies WHERE (coalesce(qual,'') || coalesce(with_check,'')) ~ 'app\.pre_|app\.maintenance' AND roles::text <> '{lims_owner}'$$,
  'schema test 17: every policy mentioning app.pre_ / app.maintenance is TO lims_owner only');
SELECT is_empty($$SELECT policyname FROM pg_policies WHERE schemaname IN ('core','audit') AND policyname ~ '__(tenant|tenant_centre)$'
  AND ((cmd IN ('SELECT','UPDATE','DELETE') AND qual !~ 'is_staff_or_system') OR (cmd IN ('INSERT','UPDATE') AND with_check !~ 'is_staff_or_system'))$$,
  'schema test 24: every __tenant policy carries the staff guard in USING and WITH CHECK');
SELECT is_empty($$SELECT tablename || '.' || policyname FROM pg_policies WHERE schemaname IN ('core','audit') AND policyname ~ '__(partner|portal|patient)$'
  AND tablename NOT IN ('event_log','idempotency_keys','access_log')$$, 'schema test 24: actor policies exist only on the three shared_with tables');
SELECT is_empty($$SELECT policyname FROM pg_policies WHERE (coalesce(qual,'') || coalesce(with_check,'')) ~ 'current_centre_ids\(\)' AND (coalesce(qual,'') || coalesce(with_check,'')) !~ '::uuid\[\]'$$,
  'schema test 26: no centre predicate without the ::uuid[] cast');
SELECT is((SELECT with_check ~ 'schema_name = ''core''' FROM pg_policies WHERE policyname = 'audit_log__insert__owner_only'), true, 'audit_log insert owner policy has the platform-context core.tenants branch (08 A12.5)');
SELECT is_empty($$SELECT policyname FROM pg_policies WHERE schemaname = 'audit' AND tablename = 'audit_log' AND cmd IN ('UPDATE','DELETE','ALL')$$, 'audit_log has no UPDATE/DELETE policy');

-- ================= grants (§5; AC-0B-5.3) =================
SELECT is(has_table_privilege('lims_app', t, 'SELECT') AND has_table_privilege('lims_app', t, 'INSERT') AND has_table_privilege('lims_app', t, 'UPDATE')
          AND NOT has_table_privilege('lims_app', t, 'DELETE'), true, 'lims_app SELECT/INSERT/UPDATE (no DELETE) on ' || t)
  FROM unnest(ARRAY['core.tenants','core.branches','core.collection_centres','core.users','core.memberships','core.roles']) t;
SELECT is(has_table_privilege('lims_app', t, 'SELECT') AND has_table_privilege('lims_app', t, 'INSERT') AND has_table_privilege('lims_app', t, 'DELETE')
          AND NOT has_table_privilege('lims_app', t, 'UPDATE'), true, 'lims_app SELECT/INSERT/DELETE (no UPDATE) on ' || t)
  FROM unnest(ARRAY['core.membership_centres','core.role_permissions','core.membership_roles']) t;
SELECT is(has_table_privilege('lims_app', 'audit.audit_log', 'SELECT'), true, 'lims_app SELECT audit_log');
SELECT is(has_table_privilege('lims_app', 'audit.audit_log', p), false, 'AC-0B-5.3: lims_app has no ' || p || ' on audit_log') FROM unnest(ARRAY['INSERT','UPDATE','DELETE','TRUNCATE']) p;
SELECT is(has_table_privilege('lims_api', 'audit.audit_log', 'INSERT'), false, 'lims_api has no INSERT on audit_log (inherits lims_app)');
SELECT is(has_table_privilege('lims_app', 'audit.access_log', 'SELECT') AND has_table_privilege('lims_app', 'audit.access_log', 'INSERT')
          AND NOT has_table_privilege('lims_app', 'audit.access_log', 'UPDATE') AND NOT has_table_privilege('lims_app', 'audit.access_log', 'DELETE'), true, 'access_log SELECT, INSERT only');
SELECT is(has_table_privilege('lims_app', t, 'SELECT') AND NOT has_table_privilege('lims_app', t, 'INSERT') AND NOT has_table_privilege('lims_app', t, 'UPDATE'), true, 'class G ' || t || ' is SELECT-only')
  FROM unnest(ARRAY['core.g_permissions','audit.g_cs_access_actions']) t;
SELECT is_empty($$SELECT c.oid::regclass::text FROM pg_class c, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
  WHERE c.relnamespace IN ('core'::regnamespace, 'audit'::regnamespace) AND c.relkind = 'r' AND a.grantee = 0$$, 'PUBLIC has no privilege on any core/audit table');
SELECT is_empty($$SELECT c.oid::regclass::text || ' -> ' || r.rolname FROM pg_class c, pg_roles r
  WHERE c.relnamespace IN ('core'::regnamespace, 'audit'::regnamespace) AND c.relkind = 'r'
    AND r.rolname IN ('lims_analytics','lims_monitor','lims_reporting_lookup') AND has_table_privilege(r.rolname, c.oid, 'SELECT')$$, 'analytics/monitor/lookup roles read nothing in core/audit');

-- ================= functions, triggers, indexes (catalog) =================
SELECT is((SELECT prosecdef FROM pg_proc WHERE oid = sig::regprocedure), d, sig || ' prosecdef = ' || d)
  FROM (VALUES ('app.has_all_centres()', true), ('app.current_centre_ids()', true), ('app.tg_row_audit()', true), ('app.enforce_mutable_columns()', false)) v(sig, d);
SELECT is((SELECT proowner::regrole::text FROM pg_proc WHERE oid = sig::regprocedure), 'lims_owner', sig || ' owned by lims_owner')
  FROM unnest(ARRAY['app.has_all_centres()','app.current_centre_ids()','app.tg_row_audit()','app.enforce_mutable_columns()']) sig;
SELECT ok((SELECT proconfig::text FROM pg_proc WHERE oid = sig::regprocedure) LIKE '%search_path=%', sig || ' pins search_path')
  FROM unnest(ARRAY['app.has_all_centres()','app.current_centre_ids()','app.tg_row_audit()','app.enforce_mutable_columns()']) sig;
SELECT is(has_function_privilege(r, sig, 'EXECUTE'), true, r || ' EXECUTE ' || sig)
  FROM unnest(ARRAY['lims_app','lims_queue']) r, unnest(ARRAY['app.has_all_centres()','app.current_centre_ids()']) sig;
SELECT is_empty($$SELECT p.oid::regprocedure::text FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
  WHERE p.pronamespace = 'app'::regnamespace AND p.proname IN ('has_all_centres','current_centre_ids','tg_row_audit','enforce_mutable_columns') AND a.grantee = 0$$,
  'PUBLIC has no EXECUTE on the C0 DEFINER helpers / trigger functions');
SELECT is(count(*)::int, 9, 'tg_row_audit trigger on the 9 audited class-M core tables (incl. core.tenants)')
  FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
  WHERE NOT t.tgisinternal AND p.oid = 'app.tg_row_audit()'::regprocedure
    AND t.tgrelid IN ('core.tenants'::regclass,'core.branches'::regclass,'core.collection_centres'::regclass,'core.users'::regclass,'core.memberships'::regclass,
      'core.membership_centres'::regclass,'core.roles'::regclass,'core.role_permissions'::regclass,'core.membership_roles'::regclass)
    AND (t.tgtype & 1) = 1 AND (t.tgtype & 2) = 0 AND (t.tgtype & 4) = 4 AND (t.tgtype & 8) = 8 AND (t.tgtype & 16) = 16;   -- ROW, AFTER, INSERT+DELETE+UPDATE
SELECT is_empty($$SELECT t.tgrelid::regclass::text FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgfoid = 'app.tg_row_audit()'::regprocedure
  AND (t.tgrelid::regclass::text ~ '^(audit\.|core\.g_)' OR t.tgrelid::regclass::text ~ 'platform_(staff|events)')$$, 'schema test 19: no audit trigger on audit/class-G/platform-only tables');
SELECT is_empty($$SELECT t.tgrelid::regclass::text FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgfoid = 'app.tg_row_audit()'::regprocedure
  AND t.tgnargs <> 0 AND t.tgrelid::regclass::text LIKE 'core.%'$$, 'core audit triggers take no arguments');
SELECT is((SELECT attgenerated FROM pg_attribute WHERE attrelid = 'core.memberships'::regclass AND attname = 'is_active'), 's', 'memberships.is_active is GENERATED STORED');
SELECT is((SELECT count(*)::int FROM pg_attribute WHERE attrelid = ANY (ARRAY['core.tenants','core.branches','core.collection_centres','core.users','core.roles']::regclass[])
  AND attname = 'is_active' AND attgenerated = ''), 5, 'every other class-M is_active is a plain column');

-- schema test 8 + 33 (indexes lead with tenant_id)
SELECT is((SELECT a.attname::text FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0] WHERE i.indexrelid = ('core.' || ix)::regclass),
          'tenant_id', ix || ' leads with tenant_id')
  FROM unnest(ARRAY['role_permissions__tenant_id_permission_code__idx','membership_roles__tenant_id_role_id__idx','users__tenant_id_email_normalized__uq',
    'branches__tenant_id_branch_code__uq','collection_centres__tenant_id_centre_code__uq','memberships__tenant_id_user_id_actor_type__p_uq','roles__tenant_id_role_code__uq']) ix;
SELECT is((SELECT a.attname::text FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[1] WHERE i.indexrelid = ('core.' || ix)::regclass),
          col, ix || ' second column ' || col)
  FROM (VALUES ('role_permissions__tenant_id_permission_code__idx','permission_code'), ('membership_roles__tenant_id_role_id__idx','role_id'),
               ('users__tenant_id_email_normalized__uq','email_normalized')) v(ix, col);
SELECT is((SELECT indisunique FROM pg_index WHERE indexrelid = 'core.users__tenant_id_email_normalized__uq'::regclass), true, 'users email index is UNIQUE');
-- (partial-index predicate text is version-dependent; it is asserted behaviourally by tests 3 and 4 below and textually by the node suite)
SELECT is((SELECT indisunique AND indpred IS NOT NULL FROM pg_index WHERE indexrelid = 'core.memberships__user_id__p_uq'::regclass), true, 'memberships__user_id__p_uq is partial unique');
SELECT is((SELECT count(*)::int FROM pg_index WHERE indexrelid IN ('audit.audit_log__tenant_id_request_id__idx'::regclass, 'audit.access_log__tenant_id_request_id__idx'::regclass)), 2,
  'request_id indexes on audit_log and access_log (08 A28.6)');
SELECT is((SELECT count(*)::int FROM pg_index WHERE indexrelid IN ('audit.audit_log__tenant_id_support_session__p_idx'::regclass, 'audit.access_log__tenant_id_support_session__p_idx'::regclass)
  AND indpred IS NOT NULL), 2, 'partial support_session indexes on both audit tables (08 A28.6)');

-- ================= behavioural constraints (lims_api, tenant A claims) =================
-- schema test 1: is_active is generated
SELECT is(left(pg_temp.w(pg_temp.uA(), format($$INSERT INTO core.memberships (id, tenant_id, user_id, actor_type, is_active, created_by, updated_by)
  VALUES (%L, %L, %L, 'user', false, %L, %L)$$, pg_temp.id('c1'), pg_temp.id('01'), pg_temp.id('61'), pg_temp.id('31'), pg_temp.id('31'))), 6), 'E428C9', 'test 1: INSERT with is_active -> 428C9');
SELECT is(left(pg_temp.w(pg_temp.uA(), format($$UPDATE core.memberships SET is_active = false WHERE id = %L$$, pg_temp.id('41'))), 6), 'E428C9', 'test 1: UPDATE is_active -> 428C9');
SELECT is(pg_temp.w(pg_temp.uA(), format($$INSERT INTO core.memberships (id, tenant_id, user_id, actor_type, created_by, updated_by) VALUES (%L, %L, %L, 'user', %L, %L)$$,
  pg_temp.id('c1'), pg_temp.id('01'), pg_temp.id('61'), pg_temp.id('31'), pg_temp.id('31'))), 'n=1', 'valid membership insert (status default active)');
SELECT is(pg_temp.v(pg_temp.uA(), format($$SELECT is_active::text FROM core.memberships WHERE id = %L$$, pg_temp.id('c1'))), 'v=true', 'status active -> is_active true');
SELECT is(pg_temp.w(pg_temp.uA(), format($$UPDATE core.memberships SET status = 'deactivated' WHERE id = %L$$, pg_temp.id('c1'))), 'n=1', 'UPDATE status = deactivated');
SELECT is(pg_temp.v(pg_temp.uA(), format($$SELECT is_active::text FROM core.memberships WHERE id = %L$$, pg_temp.id('c1'))), 'v=false', 'status deactivated -> is_active false');
SELECT is(pg_temp.w(pg_temp.uA(), format($$UPDATE core.memberships SET status = 'active' WHERE id = %L$$, pg_temp.id('c1'))), 'n=1', 'reactivate');
SELECT is(pg_temp.v(pg_temp.uA(), format($$SELECT is_active::text FROM core.memberships WHERE id = %L$$, pg_temp.id('c1'))), 'v=true', 'status active -> is_active true (again)');
SELECT is(pg_temp.w(pg_temp.uA(), format($$UPDATE core.memberships SET status = 'invited' WHERE id = %L$$, pg_temp.id('c1'))), 'n=1', 'status invited');
SELECT is(pg_temp.v(pg_temp.uA(), format($$SELECT is_active::text FROM core.memberships WHERE id = %L$$, pg_temp.id('c1'))), 'v=false', 'status invited -> is_active false');

-- schema test 2: status / lock / deactivation CHECKs
SELECT is(left(pg_temp.w(pg_temp.uA(), format($$UPDATE core.memberships SET status = %L WHERE id = %L$$, s, pg_temp.id('c1'))), 6), 'E23514', 'test 2: status ' || s || ' -> 23514')
  FROM unnest(ARRAY['locked','','Active','pending']) s;
SELECT is(left(pg_temp.w(pg_temp.uA(), format($$UPDATE core.memberships SET lock_reason_code = 'foo', locked_at = now(), locked_by = %L WHERE id = %L$$, pg_temp.id('31'), pg_temp.id('c1'))), 6),
  'E23514', 'test 2: lock_reason_code foo -> 23514');
SELECT is(pg_temp.w(pg_temp.uA(), format($$UPDATE core.memberships SET lock_reason_code = %L, locked_at = now(), locked_by = %L WHERE id = %L$$, c, pg_temp.id('31'), pg_temp.id('c1'))),
  'n=1', 'test 2: lock_reason_code ' || c || ' accepted') FROM unnest(ARRAY['left_organisation','security_concern','policy_violation','other']) c;
SELECT is(pg_temp.w(pg_temp.uA(), format($$UPDATE core.memberships SET lock_reason_code = NULL, locked_at = NULL, locked_by = NULL WHERE id = %L$$, pg_temp.id('c1'))), 'n=1', 'test 2: lock cleared (NULL accepted)');
SELECT is(left(pg_temp.w(pg_temp.uA(), format($$UPDATE core.memberships SET locked_at = now() WHERE id = %L$$, pg_temp.id('c1'))), 6), 'E23514', 'locked_at without locked_by -> 23514 (memberships__lock__ck)');
SELECT is(left(pg_temp.w(pg_temp.uA(), format($$UPDATE core.memberships SET status = 'deactivated', deactivation_reason_code = 'foo' WHERE id = %L$$, pg_temp.id('c1'))), 6), 'E23514', 'test 2: deactivation_reason_code foo -> 23514');
SELECT is(pg_temp.w(pg_temp.uA(), format($$UPDATE core.memberships SET status = 'deactivated', deactivated_at = now(), deactivated_by = %L, deactivation_reason_code = %L WHERE id = %L$$,
  pg_temp.id('31'), c, pg_temp.id('c1'))), 'n=1', 'test 2: deactivation_reason_code ' || c || ' accepted') FROM unnest(ARRAY['left_organisation','security_concern','policy_violation','other']) c;
SELECT is(pg_temp.w(pg_temp.uA(), format($$UPDATE core.memberships SET status = 'active', deactivated_at = NULL, deactivated_by = NULL, deactivation_reason_code = NULL WHERE id = %L$$, pg_temp.id('c1'))),
  'n=1', 'test 2: reactivate clears the deactivation columns');
SELECT is(left(pg_temp.w(pg_temp.uA(), format($$UPDATE core.memberships SET lock_reason_text = repeat('x', 501) WHERE id = %L$$, pg_temp.id('c1'))), 6), 'E23514', 'test 2: lock_reason_text 501 chars -> 23514');
SELECT is(pg_temp.w(pg_temp.uA(), format($$UPDATE core.memberships SET lock_reason_text = repeat('x', 500) WHERE id = %L$$, pg_temp.id('c1'))), 'n=1', 'test 2: lock_reason_text 500 chars accepted');

-- schema test 3: duplicate pending invite (user 62, tenant A)
SELECT is(pg_temp.w(pg_temp.uA(), format($$INSERT INTO core.memberships (id, tenant_id, user_id, actor_type, status, created_by, updated_by) VALUES (%L, %L, %L, 'user', 'invited', %L, %L)$$,
  pg_temp.id('c2'), pg_temp.id('01'), pg_temp.id('62'), pg_temp.id('31'), pg_temp.id('31'))), 'n=1', 'test 3: first invited membership');
SELECT is(left(pg_temp.w(pg_temp.uA(), format($$INSERT INTO core.memberships (id, tenant_id, user_id, actor_type, status, created_by, updated_by) VALUES (%L, %L, %L, 'user', %L, %L, %L)$$,
  pg_temp.id('c3'), pg_temp.id('01'), pg_temp.id('62'), s, pg_temp.id('31'), pg_temp.id('31'))), 6), 'E23505', 'test 3: second ' || s || ' row for the same triple -> 23505') FROM unnest(ARRAY['invited','active']) s;
SELECT matches(pg_temp.w(pg_temp.uA(), format($$INSERT INTO core.memberships (id, tenant_id, user_id, actor_type, status, created_by, updated_by) VALUES (%L, %L, %L, 'user', 'active', %L, %L)$$,
  pg_temp.id('c3'), pg_temp.id('01'), pg_temp.id('62'), pg_temp.id('31'), pg_temp.id('31'))), 'memberships__tenant_id_user_id_actor_type__p_uq', 'test 3: violated index is memberships__tenant_id_user_id_actor_type__p_uq');
SELECT is(pg_temp.w(pg_temp.uA(), format($$UPDATE core.memberships SET status = 'deactivated' WHERE id = %L$$, pg_temp.id('c2'))), 'n=1', 'test 3: first set to deactivated');
SELECT is(pg_temp.w(pg_temp.uA(), format($$INSERT INTO core.memberships (id, tenant_id, user_id, actor_type, status, created_by, updated_by) VALUES (%L, %L, %L, 'user', 'invited', %L, %L)$$,
  pg_temp.id('c3'), pg_temp.id('01'), pg_temp.id('62'), pg_temp.id('31'), pg_temp.id('31'))), 'n=1', 'test 3: after deactivation a new row is accepted');

-- schema test 4: R27 — one tenant per staff user, counting pending invites (user 70 has a profile in A and B)
SELECT is(pg_temp.w(pg_temp.uA(), format($$INSERT INTO core.memberships (id, tenant_id, user_id, actor_type, status, created_by, updated_by) VALUES (%L, %L, %L, 'user', 'invited', %L, %L)$$,
  pg_temp.id('c4'), pg_temp.id('01'), pg_temp.id('70'), pg_temp.id('31'), pg_temp.id('31'))), 'n=1', 'test 4: invited staff membership of U in tenant A');
SELECT is(left(pg_temp.w(pg_temp.uB(), format($$INSERT INTO core.memberships (id, tenant_id, user_id, actor_type, status, created_by, updated_by) VALUES (%L, %L, %L, 'user', %L, %L, %L)$$,
  pg_temp.id('c5'), pg_temp.id('02'), pg_temp.id('70'), s, pg_temp.id('33'), pg_temp.id('33'))), 6), 'E23505', 'test 4: ' || s || ' staff membership of U in tenant B -> 23505') FROM unnest(ARRAY['invited','active']) s;
SELECT matches(pg_temp.w(pg_temp.uB(), format($$INSERT INTO core.memberships (id, tenant_id, user_id, actor_type, status, created_by, updated_by) VALUES (%L, %L, %L, 'user', 'active', %L, %L)$$,
  pg_temp.id('c5'), pg_temp.id('02'), pg_temp.id('70'), pg_temp.id('33'), pg_temp.id('33'))), 'memberships__user_id__p_uq', 'test 4: violated index is memberships__user_id__p_uq');
SELECT is(pg_temp.w(pg_temp.uB(), format($$INSERT INTO core.memberships (id, tenant_id, user_id, actor_type, status, created_by, updated_by) VALUES (%L, %L, %L, 'user', 'deactivated', %L, %L)$$,
  pg_temp.id('c5'), pg_temp.id('02'), pg_temp.id('70'), pg_temp.id('33'), pg_temp.id('33'))), 'n=1', 'test 4: a deactivated one in B does not collide');
SELECT is(pg_temp.w(pg_temp.uA(), format($$INSERT INTO core.memberships (id, tenant_id, user_id, actor_type, created_by, updated_by) VALUES (%L, %L, %L, 'patient', %L, %L)$$,
  pg_temp.id('c6'), pg_temp.id('01'), pg_temp.id('70'), pg_temp.id('31'), pg_temp.id('31'))), 'n=1', 'test 4: patient membership of U in A');
SELECT is(pg_temp.w(pg_temp.uB(), format($$INSERT INTO core.memberships (id, tenant_id, user_id, actor_type, created_by, updated_by) VALUES (%L, %L, %L, 'patient', %L, %L)$$,
  pg_temp.id('c7'), pg_temp.id('02'), pg_temp.id('70'), pg_temp.id('33'), pg_temp.id('33'))), 'n=1', 'test 4: patient membership of U in B accepted (multi-tenant capable)');
SELECT is(pg_temp.w(pg_temp.uA(), format($$INSERT INTO core.memberships (id, tenant_id, user_id, actor_type, partner_role, created_by, updated_by) VALUES (%L, %L, %L, 'partner', 'partner_admin', %L, %L)$$,
  pg_temp.id('c8'), pg_temp.id('01'), pg_temp.id('70'), pg_temp.id('31'), pg_temp.id('31'))), 'n=1', 'test 4: partner membership of U in A');
SELECT is(pg_temp.w(pg_temp.uB(), format($$INSERT INTO core.memberships (id, tenant_id, user_id, actor_type, partner_role, created_by, updated_by) VALUES (%L, %L, %L, 'partner', 'partner_member', %L, %L)$$,
  pg_temp.id('c9'), pg_temp.id('02'), pg_temp.id('70'), pg_temp.id('33'), pg_temp.id('33'))), 'n=1', 'test 4: partner membership of U in B accepted');

-- schema test 5: core.users
SELECT is(pg_temp.w(pg_temp.uA(), format($$INSERT INTO core.users (tenant_id, id, display_name, email_normalized, created_by, updated_by) VALUES (%L, gen_random_uuid(), 'E1', 'dup@example.test', %L, %L)$$,
  pg_temp.id('01'), pg_temp.id('31'), pg_temp.id('31'))), 'n=1', 'test 5: first row with an email');
SELECT is(left(pg_temp.w(pg_temp.uA(), format($$INSERT INTO core.users (tenant_id, id, display_name, email_normalized, created_by, updated_by) VALUES (%L, gen_random_uuid(), 'E2', 'dup@example.test', %L, %L)$$,
  pg_temp.id('01'), pg_temp.id('31'), pg_temp.id('31'))), 6), 'E23505', 'test 5: same email, same tenant -> 23505');
SELECT matches(pg_temp.w(pg_temp.uA(), format($$INSERT INTO core.users (tenant_id, id, display_name, email_normalized, created_by, updated_by) VALUES (%L, gen_random_uuid(), 'E2', 'dup@example.test', %L, %L)$$,
  pg_temp.id('01'), pg_temp.id('31'), pg_temp.id('31'))), 'users__tenant_id_email_normalized__uq', 'test 5: index name users__tenant_id_email_normalized__uq');
SELECT is(pg_temp.w(pg_temp.uB(), format($$INSERT INTO core.users (tenant_id, id, display_name, email_normalized, created_by, updated_by) VALUES (%L, gen_random_uuid(), 'E3', 'dup@example.test', %L, %L)$$,
  pg_temp.id('02'), pg_temp.id('33'), pg_temp.id('33'))), 'n=1', 'test 5: same email in another tenant accepted');
SELECT is(pg_temp.w(pg_temp.uA(), format($$INSERT INTO core.users (tenant_id, id, display_name, created_by, updated_by) SELECT %L, gen_random_uuid(), 'N' || g, %L, %L FROM generate_series(1, 3) g$$,
  pg_temp.id('01'), pg_temp.id('31'), pg_temp.id('31'))), 'n=3', 'test 5: many NULL emails accepted');
SELECT is(left(pg_temp.w(pg_temp.uA(), format($$INSERT INTO core.users (tenant_id, id, display_name, email_normalized, created_by, updated_by) VALUES (%L, gen_random_uuid(), 'L', repeat('a', 255), %L, %L)$$,
  pg_temp.id('01'), pg_temp.id('31'), pg_temp.id('31'))), 6), 'E23514', 'test 5: 255-char email -> 23514');
SELECT is(pg_temp.w(pg_temp.uA(), format($$INSERT INTO core.users (tenant_id, id, display_name, email_normalized, created_by, updated_by) VALUES (%L, gen_random_uuid(), 'L', repeat('a', 254), %L, %L)$$,
  pg_temp.id('01'), pg_temp.id('31'), pg_temp.id('31'))), 'n=1', 'test 5: 254-char email accepted');
SELECT is(left(pg_temp.w(pg_temp.uA(), format($$INSERT INTO core.users (tenant_id, id, display_name, phone_e164, created_by, updated_by) VALUES (%L, gen_random_uuid(), 'P', %L, %L, %L)$$,
  pg_temp.id('01'), p, pg_temp.id('31'), pg_temp.id('31'))), 6), 'E23514', 'test 5: phone ' || p || ' -> 23514') FROM unnest(ARRAY['9779841000000','+0123456789','+1234567','+97798410000001234','+977 9841000000']) p;
SELECT is(pg_temp.w(pg_temp.uA(), format($$INSERT INTO core.users (tenant_id, id, display_name, phone_e164, created_by, updated_by) VALUES (%L, gen_random_uuid(), 'P', '+9779841000000', %L, %L)$$,
  pg_temp.id('01'), pg_temp.id('31'), pg_temp.id('31'))), 'n=1', 'test 5: +9779841000000 accepted');
SELECT is(pg_temp.w(pg_temp.uA(), format($$INSERT INTO core.users (tenant_id, id, display_name, phone_e164, created_by, updated_by) VALUES (%L, gen_random_uuid(), 'P', NULL, %L, %L)$$,
  pg_temp.id('01'), pg_temp.id('31'), pg_temp.id('31'))), 'n=1', 'test 5: NULL phone accepted');
SELECT is(pg_temp.w(pg_temp.uA(), format($$INSERT INTO core.users (tenant_id, id, display_name, email_hmac, created_by, updated_by) VALUES (%L, gen_random_uuid(), 'H', decode(repeat('ab', 32), 'hex'), %L, %L)$$,
  pg_temp.id('01'), pg_temp.id('31'), pg_temp.id('31'))), 'n=1', 'D-217: 32-byte email_hmac accepted');
SELECT is(left(pg_temp.w(pg_temp.uA(), format($$INSERT INTO core.users (tenant_id, id, display_name, email_hmac, created_by, updated_by) VALUES (%L, gen_random_uuid(), 'H', decode(%L, 'hex'), %L, %L)$$,
  pg_temp.id('01'), repeat('ab', n), pg_temp.id('31'), pg_temp.id('31'))), 6), 'E23514', 'D-217: email_hmac of ' || n || ' bytes -> 23514') FROM unnest(ARRAY[0, 31, 33]) n;

-- schema test 6: tenants.status_reason
SELECT is(left(pg_temp.w(pg_temp.uA(), format($$UPDATE core.tenants SET status_reason = repeat('x', 501) WHERE id = %L$$, pg_temp.id('01'))), 6), 'E23514', 'test 6: status_reason 501 chars -> 23514');
SELECT is(pg_temp.w(pg_temp.uA(), format($$UPDATE core.tenants SET status_reason = repeat('x', 500) WHERE id = %L$$, pg_temp.id('01'))), 'n=1', 'test 6: status_reason 500 chars accepted');

-- schema test 33: partner_role presence / value
SELECT is(left(pg_temp.w(pg_temp.uA(), format($$INSERT INTO core.memberships (id, tenant_id, user_id, actor_type, created_by, updated_by) VALUES (%L, %L, %L, 'partner', %L, %L)$$,
  pg_temp.id('d1'), pg_temp.id('01'), pg_temp.id('63'), pg_temp.id('31'), pg_temp.id('31'))), 6), 'E23514', 'test 33: partner without partner_role -> 23514');
SELECT matches(pg_temp.w(pg_temp.uA(), format($$INSERT INTO core.memberships (id, tenant_id, user_id, actor_type, created_by, updated_by) VALUES (%L, %L, %L, 'partner', %L, %L)$$,
  pg_temp.id('d1'), pg_temp.id('01'), pg_temp.id('63'), pg_temp.id('31'), pg_temp.id('31'))), 'memberships__partner_role_presence__ck', 'test 33: constraint memberships__partner_role_presence__ck');
SELECT is(left(pg_temp.w(pg_temp.uA(), format($$INSERT INTO core.memberships (id, tenant_id, user_id, actor_type, partner_role, created_by, updated_by) VALUES (%L, %L, %L, %L, 'partner_member', %L, %L)$$,
  pg_temp.id('d2'), pg_temp.id('01'), pg_temp.id('63'), t, pg_temp.id('31'), pg_temp.id('31'))), 6), 'E23514', 'test 33: ' || t || ' membership with a partner_role -> 23514') FROM unnest(ARRAY['user','patient']) t;
SELECT matches(pg_temp.w(pg_temp.uA(), format($$INSERT INTO core.memberships (id, tenant_id, user_id, actor_type, partner_role, created_by, updated_by) VALUES (%L, %L, %L, 'partner', 'owner', %L, %L)$$,
  pg_temp.id('d3'), pg_temp.id('01'), pg_temp.id('63'), pg_temp.id('31'), pg_temp.id('31'))), 'memberships__partner_role__ck', 'test 33: unknown partner_role -> memberships__partner_role__ck');
SELECT is(pg_temp.w(pg_temp.uA(), format($$INSERT INTO core.memberships (id, tenant_id, user_id, actor_type, partner_role, created_by, updated_by) VALUES (%L, %L, %L, 'partner', %L, %L, %L)$$,
  pg_temp.id(i), pg_temp.id('01'), pg_temp.id(u), r, pg_temp.id('31'), pg_temp.id('31'))), 'n=1', 'test 33: partner_role ' || r || ' accepted')
  FROM (VALUES ('d4', '63', 'partner_member'), ('d5', '64', 'partner_admin')) v(i, u, r);
SELECT is(left(pg_temp.w(pg_temp.uA(), format($$INSERT INTO core.memberships (id, tenant_id, user_id, actor_type, all_centres, partner_role, created_by, updated_by) VALUES (%L, %L, %L, 'partner', true, 'partner_admin', %L, %L)$$,
  pg_temp.id('d6'), pg_temp.id('01'), pg_temp.id('65'), pg_temp.id('31'), pg_temp.id('31'))), 6), 'E23514', 'R3: all_centres on a non-user membership -> 23514 (memberships__all_centres_user_only__ck)');

-- other CHECKs (constraint-only; superuser, so RLS is not involved)
SELECT throws_ok(format($$INSERT INTO core.tenants (id, tenant_code, legal_name, display_name, created_by, updated_by) VALUES (%L, %L, 'L', 'D', %L, %L)$$,
  pg_temp.id('f1'), c, pg_temp.id('99'), pg_temp.id('99')), '23514', NULL, 'tenants__tenant_code__ck rejects ' || c)
  FROM unnest(ARRAY['Bad','ab','1abc','abc-def','abc def', repeat('a', 33)]) c;
SELECT throws_ok(format($$INSERT INTO core.tenants (id, tenant_code, legal_name, display_name, status, created_by, updated_by) VALUES (%L, 'okcode', 'L', 'D', 'gone', %L, %L)$$,
  pg_temp.id('f1'), pg_temp.id('99'), pg_temp.id('99')), '23514', NULL, 'tenants__status__ck rejects an unknown status');
SELECT throws_ok(format($$INSERT INTO core.branches (id, tenant_id, branch_code, name, created_by, updated_by) VALUES (%L, %L, %L, 'N', %L, %L)$$,
  pg_temp.id('f2'), pg_temp.id('01'), c, pg_temp.id('99'), pg_temp.id('99')), '23514', NULL, 'branches__branch_code__ck rejects ' || c)
  FROM unnest(ARRAY['', 'a b', 'a_b', repeat('a', 17)]) c;
SELECT throws_ok(format($$INSERT INTO core.collection_centres (id, tenant_id, branch_id, centre_code, name, centre_kind, created_by, updated_by) VALUES (%L, %L, %L, 'C1', 'N', 'kiosk', %L, %L)$$,
  pg_temp.id('f3'), pg_temp.id('01'), pg_temp.id('11'), pg_temp.id('99'), pg_temp.id('99')), '23514', NULL, 'collection_centres__kind__ck rejects an unknown centre_kind');
SELECT throws_ok(format($$INSERT INTO core.roles (id, tenant_id, role_code, display_name, created_by, updated_by) VALUES (%L, %L, %L, 'R', %L, %L)$$,
  pg_temp.id('f4'), pg_temp.id('01'), c, pg_temp.id('99'), pg_temp.id('99')), '23514', NULL, 'roles__role_code__ck rejects ' || c)
  FROM unnest(ARRAY['A', '1ab', 'a', 'ab-c', repeat('a', 41)]) c;
SELECT throws_ok($$INSERT INTO core.g_permissions (code, module, privileged, phase) VALUES ('bad code', 'x', false, '1')$$, '23514', NULL, 'g_permissions__code__ck');
SELECT throws_ok($$INSERT INTO core.g_permissions (code, module, privileged, phase) VALUES ('lab.result.edit', 'lab', false, '4')$$, '23514', NULL, 'g_permissions__phase__ck');
SELECT throws_ok(format($$INSERT INTO core.role_permissions (tenant_id, role_id, permission_code, created_by) VALUES (%L, %L, 'platform.tenant.manage', %L)$$,
  pg_temp.id('01'), pg_temp.id('f4'), pg_temp.id('99')), '23514', NULL, 'role_permissions__no_platform__ck: tenant roles cannot hold platform.*');

SELECT * FROM finish();
ROLLBACK;
