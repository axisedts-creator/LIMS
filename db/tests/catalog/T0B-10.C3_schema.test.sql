-- T0B-10.C3 schema suite: catalog catalogue properties (C3 05-SCHEMA §9, §10.3, §10.4, §11 tests 2, 7 (security_invoker half), 13; AC-0B-2.1, 2.2, 4.2, 4.3).
-- Pure catalog (pg_catalog) assertions: no fixtures, no data written. One rolled-back transaction. RLS is never disabled.
-- Run from the repo root: pg_prove -d <db> db/tests/catalog/T0B-10.C3_schema.test.sql   (pgTAP in schema `extensions`; migrations + seeds loaded; superuser)
-- Coverage map (C3 05-SCHEMA §11):
-- §11 test 2: has_table_privilege(lims_app, t, 'DELETE') = false for every rw_tables table (and every master / G table)
-- §11 test 7: published views have security_invoker = true (behaviour half: T0B-10.C3_behaviour.test.sql)
-- §11 test 13: relrowsecurity + relforcerowsecurity and the __select/__insert/__update(/__delete)__tenant policies on every table of the §10.3 arrays
BEGIN;
SET search_path = extensions, public, pg_catalog;
SELECT * FROM no_plan();

CREATE TEMP TABLE rw(t) AS VALUES ('catalog_state'),('code_counters'),('departments'),('specimen_types'),('containers'),('methods'),('cs_units'),('cs_value_sets'),
  ('cs_value_set_values'),('orderables'),('tests'),('panels'),('analytes'),('analyte_versions'),('reference_range_sets'),('critical_limit_sets'),('tat_targets'),
  ('comment_codes'),('comment_code_texts'),('doctors'),('credit_parties'),('price_lists'),('price_list_versions'),('surcharge_rules'),('cs_tax_types'),('tax_rules'),
  ('instrument_code_maps'),('imports'),('exports');
CREATE TEMP TABLE rwd(t) AS VALUES ('panel_members'),('test_specimen_types'),('price_list_assignments'),('reference_ranges'),('critical_limits'),('price_list_items'),
  ('formula_dependencies'),('files'),('import_issues');
CREATE TEMP TABLE gt(t) AS VALUES ('g_units'),('g_value_sets'),('g_value_set_values'),('g_tax_types'),('g_reference_release');
CREATE TEMP TABLE vw(v) AS VALUES ('v_pub_department'),('v_pub_test_directory'),('v_pub_price_list_items'),('v_pub_referrer_directory');

-- ===================================================================================================================================== inventory
SELECT is((SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'catalog' AND c.relkind = 'r'), 43, 'catalog holds exactly 43 tables (5 G + 29 rw + 9 rwd)');
SELECT is((SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'catalog' AND c.relkind = 'r' AND c.relname = 'event_inbox'), 0, 'C3 consumes no events: no catalog.event_inbox');
SELECT is((SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'catalog' AND c.relkind = 'm'), 0, 'no materialised view in catalog');
SELECT is(pg_get_userbyid(c.relowner), 'lims_owner', 'catalog.' || c.relname || ' owned by lims_owner') FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'catalog' AND c.relkind IN ('r', 'v');

-- ===================================================================================================================================== §11 test 13 (and AC-0B-2.1)
-- §11 test 13: ENABLE + FORCE RLS on every table of the arrays
SELECT is(c.relrowsecurity AND c.relforcerowsecurity, true, 'AC-0B-2.1 catalog.' || x.t || ' ENABLE + FORCE RLS')
  FROM (SELECT t FROM rw UNION ALL SELECT t FROM rwd) x JOIN pg_class c ON c.relname = x.t AND c.relnamespace = 'catalog'::regnamespace;
-- §11 test 13: the three policies (and DELETE on rwd), TO lims_app only, with the staff guard in USING / WITH CHECK
SELECT is((SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = 'catalog' AND p.tablename = x.t AND p.policyname = x.t || '__' || k.cmd || '__tenant'
            AND p.cmd = upper(k.cmd) AND p.roles = ARRAY['lims_app']::name[]), 1, 'policy catalog.' || x.t || '__' || k.cmd || '__tenant (TO lims_app)')
  FROM (SELECT t FROM rw UNION ALL SELECT t FROM rwd) x CROSS JOIN (VALUES ('select'), ('insert'), ('update')) k(cmd);
SELECT is((SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = 'catalog' AND p.tablename = x.t AND p.policyname = x.t || '__delete__tenant' AND p.cmd = 'DELETE'
            AND p.roles = ARRAY['lims_app']::name[]), 1, 'policy catalog.' || x.t || '__delete__tenant')
  FROM rwd x;
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'catalog'), 38 * 3 + 9, 'catalog has exactly 123 policies (no extra policy widens access)');
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'catalog' AND tablename IN (SELECT t FROM rw) AND cmd = 'DELETE'), 0, 'no DELETE policy on a master / E-like table (§5 rule 3)');
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'catalog' AND tablename IN (SELECT t FROM gt)), 0, 'G tables carry no policy');
SELECT ok(coalesce(p.qual, '') ~ 'is_staff_or_system' OR p.cmd = 'INSERT', 'USING of ' || p.policyname || ' has the staff guard (P-16)') FROM pg_policies p WHERE p.schemaname = 'catalog';
SELECT ok(coalesce(p.with_check, '') ~ 'is_staff_or_system' OR p.cmd IN ('SELECT', 'DELETE'), 'WITH CHECK of ' || p.policyname || ' has the staff guard (P-16)') FROM pg_policies p WHERE p.schemaname = 'catalog';
SELECT is((SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = 'catalog' AND p.policyname ~ '__(owner_only|platform|own)$'), 0, 'C3 has no owner / platform / own policy (no DEFINER)');
SELECT is(c.relrowsecurity, false, 'catalog.' || x.t || ' (class G) is RLS-exempt') FROM gt x JOIN pg_class c ON c.relname = x.t AND c.relnamespace = 'catalog'::regnamespace;

-- ===================================================================================================================================== §11 test 2 (and AC-0B-4.2 / 4.3)
-- §11 test 2: no DELETE for lims_app on any rw_tables table; also none on G tables
SELECT is(has_table_privilege('lims_app', 'catalog.' || x.t, 'DELETE'), false, 'lims_app has no DELETE on catalog.' || x.t) FROM (SELECT t FROM rw UNION ALL SELECT t FROM gt) x;
SELECT is(has_table_privilege('lims_app', 'catalog.' || x.t, 'DELETE'), true, 'lims_app has DELETE on catalog.' || x.t || ' (association / draft child / E class)') FROM rwd x;
SELECT is(has_table_privilege('lims_app', 'catalog.' || x.t, p), true, 'lims_app has ' || p || ' on catalog.' || x.t)
  FROM (SELECT t FROM rw UNION ALL SELECT t FROM rwd) x CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE']) p;
SELECT is(has_table_privilege('lims_app', 'catalog.' || x.t, 'SELECT'), true, 'lims_app can read G table catalog.' || x.t) FROM gt x;
SELECT is(has_table_privilege('lims_app', 'catalog.' || x.t, p), false, 'lims_app cannot ' || p || ' G table catalog.' || x.t) FROM gt x CROSS JOIN unnest(ARRAY['INSERT', 'UPDATE', 'DELETE']) p;
SELECT is(has_table_privilege('lims_app', c.oid, 'TRUNCATE') OR has_table_privilege('lims_app', c.oid, 'REFERENCES') OR has_table_privilege('lims_app', c.oid, 'TRIGGER'), false,
  'lims_app has no TRUNCATE/REFERENCES/TRIGGER on catalog.' || c.relname) FROM pg_class c WHERE c.relnamespace = 'catalog'::regnamespace AND c.relkind = 'r';
SELECT is(has_table_privilege(r, c.oid, p), false, r || ' has no ' || p || ' on catalog.' || c.relname)
  FROM pg_class c CROSS JOIN unnest(ARRAY['anon', 'authenticated']) r CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) p
 WHERE c.relnamespace = 'catalog'::regnamespace AND c.relkind IN ('r', 'v') AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r);
SELECT is(has_table_privilege(r, c.oid, 'DELETE'), false, r || ' has no DELETE on catalog.' || c.relname)
  FROM pg_class c CROSS JOIN unnest(ARRAY['lims_api', 'lims_worker']) r WHERE c.relnamespace = 'catalog'::regnamespace AND c.relkind = 'r' AND c.relname IN (SELECT t FROM rw);
SELECT is((SELECT count(*)::int FROM information_schema.column_privileges WHERE table_schema = 'catalog' AND grantee = 'lims_app' AND privilege_type = 'UPDATE'
            AND table_name IN (SELECT t FROM gt)), 0, 'no column-level UPDATE grant on G tables');

-- ===================================================================================================================================== views
-- §11 test 7 (catalogue half): security_invoker on every view in catalog
SELECT is(coalesce(c.reloptions @> ARRAY['security_invoker=true'] OR c.reloptions @> ARRAY['security_invoker=on'], false), true, 'catalog.' || c.relname || ' has security_invoker = true')
  FROM pg_class c WHERE c.relnamespace = 'catalog'::regnamespace AND c.relkind = 'v';
SELECT is((SELECT count(*)::int FROM pg_class c WHERE c.relnamespace = 'catalog'::regnamespace AND c.relkind = 'v'), 4, 'catalog publishes exactly the four v_pub_* views');
SELECT is((SELECT count(*)::int FROM pg_class c WHERE c.relnamespace = 'catalog'::regnamespace AND c.relkind = 'v' AND c.relname = v.v), 1, 'view catalog.' || v.v || ' exists') FROM vw v;
SELECT is(has_table_privilege('lims_app', 'catalog.' || v.v, 'SELECT'), true, 'lims_app can SELECT catalog.' || v.v) FROM vw v;
SELECT is(has_table_privilege('lims_app', 'catalog.' || v.v, p), false, 'lims_app cannot ' || p || ' catalog.' || v.v) FROM vw v CROSS JOIN unnest(ARRAY['INSERT', 'UPDATE', 'DELETE']) p;
SELECT is(has_table_privilege(r, 'catalog.' || v.v, 'SELECT'), false, r || ' cannot SELECT catalog.' || v.v) FROM vw v CROSS JOIN unnest(ARRAY['anon', 'authenticated']) r WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r);
-- IC §6.6 column contract (names + order); the node test compares the same lists with the spec
SELECT results_eq($$SELECT a.attname::text COLLATE "default" FROM pg_attribute a WHERE a.attrelid = 'catalog.v_pub_department'::regclass AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum$$,
  $$VALUES ('tenant_id'),('department_id'),('code'),('name'),('is_active')$$, 'v_pub_department columns (IC §6.6)');
SELECT results_eq($$SELECT a.attname::text COLLATE "default" FROM pg_attribute a WHERE a.attrelid = 'catalog.v_pub_test_directory'::regclass AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum$$,
  $$VALUES ('tenant_id'),('test_id'),('code'),('name'),('department_id'),('workflow_type'),('is_active')$$, 'v_pub_test_directory columns (IC §6.6)');
SELECT results_eq($$SELECT a.attname::text COLLATE "default" FROM pg_attribute a WHERE a.attrelid = 'catalog.v_pub_price_list_items'::regclass AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum$$,
  $$VALUES ('tenant_id'),('price_list_id'),('price_list_version'),('owner_kind'),('owner_id'),('orderable_id'),('unit_price_paisa'),('effective_from'),('effective_to'),('falls_through')$$,
  'v_pub_price_list_items columns (IC §6.6 + D-19 falls_through)');
SELECT results_eq($$SELECT a.attname::text COLLATE "default" FROM pg_attribute a WHERE a.attrelid = 'catalog.v_pub_referrer_directory'::regclass AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum$$,
  $$VALUES ('tenant_id'),('referrer_id'),('display_name'),('is_active'),('canonical_referrer_id')$$, 'v_pub_referrer_directory columns (IC §6.6 + CR-C3-004)');
SELECT is(format_type(a.atttypid, a.atttypmod), 'boolean', 'v_pub_price_list_items.falls_through is boolean') FROM pg_attribute a WHERE a.attrelid = 'catalog.v_pub_price_list_items'::regclass AND a.attname = 'falls_through';
SELECT is((SELECT count(*)::int FROM pg_attribute a WHERE a.attrelid = 'catalog.v_pub_referrer_directory'::regclass AND a.attnum > 0 AND a.attname ~ '(phone|email|registration|qualification|notes)'), 0,
  'referrer view exposes no contact columns (P2-personal, §10.4 note)');

-- ===================================================================================================================================== no DEFINER, triggers
SELECT is((SELECT count(*)::int FROM pg_proc p WHERE p.pronamespace = 'catalog'::regnamespace AND p.prosecdef), 0, 'C3 has no SECURITY DEFINER function (§10.3 notes)');
SELECT is((SELECT count(*)::int FROM pg_proc p WHERE p.pronamespace = 'catalog'::regnamespace), 4, 'exactly the four catalog.tg_* functions');
SELECT ok(EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}'::text[])) c WHERE c IN ('search_path=""', 'search_path=')), 'catalog.' || p.proname || ' pins search_path (empty)') FROM pg_proc p WHERE p.pronamespace = 'catalog'::regnamespace;
SELECT is((SELECT count(*)::int FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relnamespace = 'catalog'::regnamespace AND NOT t.tgisinternal AND t.tgname !~ '__audit$'), 18,
  'eighteen lifecycle triggers (§10, §10.2)');
SELECT is((SELECT count(*)::int FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relnamespace = 'catalog'::regnamespace AND NOT t.tgisinternal AND t.tgname ~ '__audit$'), 34,
  'audit trigger on the 34 audited tables (§5 rule 6)');
SELECT is((SELECT count(*)::int FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relnamespace = 'catalog'::regnamespace AND NOT t.tgisinternal AND t.tgenabled <> 'O'), 0, 'every catalog trigger is enabled');
SELECT is((SELECT count(*)::int FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relnamespace = 'catalog'::regnamespace AND NOT t.tgisinternal AND t.tgname ~ '__audit$'
            AND c.relname IN ('files', 'import_issues', 'catalog_state', 'code_counters')), 0, 'files / import_issues / catalog_state / code_counters are not audited');

SELECT * FROM finish();
ROLLBACK;
