-- T0B-10.C8 schema suite: analytics catalogue properties (C8 05-SCHEMA §1, §3, §5, §6, §7; AC-0B-2.1, 2.2, 2.3, 2.4, 3.6, 4.1, 4.2, 4.3, 5.1, 5.3, 6.2, 6.3).
-- Pure pg_catalog assertions: no fixtures, no data written. One rolled-back transaction. RLS is never disabled.
-- Run from the repo root: pg_prove -d <db> db/tests/analytics/T0B-10.C8_schema.test.sql   (pgTAP in schema `extensions`; migrations + seeds loaded; superuser)
-- Markers (the node test checks them): C8 check 1 inventory/owner/no views, 2 RLS ENABLE+FORCE (G exempt), 3 policy set + hygiene, 4 grant matrix (class R no UPDATE, M no DELETE, lims_analytics none),
-- 5 tenant_id-leading indexes + class R keys, 6 triggers (mutable columns, guards, audit), 7 FK direction + functions INVOKER + no DEFINER (AC-0B-6.2 / 6.3).
-- (checks 8-14 are in T0B-10.C8_behaviour.test.sql)
-- Scope note (as T0B-10.C5..C7): event_inbox is C0's (T0B-05) and is excluded from every count. lims_api / lims_worker INHERIT lims_app, so "no DELETE / no UPDATE" is asserted for lims_app only.
BEGIN;
SET search_path = extensions, public, pg_catalog;
SELECT * FROM no_plan();

CREATE TEMP TABLE rt(t, cls, centre, i, u, d, npol) AS VALUES        -- i/u/d: lims_app whole-table INSERT / UPDATE / DELETE granted ; npol: expected policies on the table
  ('daily_orders','R',true,true,false,true,3),('daily_centre_volume','R',true,true,false,true,3),('daily_referrer_volume','R',true,true,false,true,3),('daily_income','R',true,true,false,true,3),
  ('daily_department_income','R',true,true,false,true,3),('daily_collections','R',true,true,false,true,3),('daily_referrer_billing','R',true,true,false,true,3),('daily_results','R',true,true,false,true,3),
  ('daily_specimens','R',true,true,false,true,3),('daily_rejections','R',true,true,false,true,3),('daily_critical_values','R',true,true,false,true,3),('tat_facts','R',true,true,false,true,3),
  ('daily_releases','R',true,true,false,true,3),('daily_deliveries','R',true,true,false,true,3),('daily_interface_messages','R',true,true,false,true,3),('report_backlog','R',true,true,false,true,3),
  ('refresh_state','E',false,true,true,false,5),('dirty_partitions','E',false,true,true,true,4),('refresh_runs','E',false,true,true,true,4),('order_index','E',false,true,true,true,4),
  ('exports','E',false,true,true,true,4),('export_files','E',false,true,false,true,3),('report_runs','E',false,true,true,true,4),('report_run_recipients','E',false,true,false,true,3),
  ('schedules','M',false,true,true,false,3),('schedule_recipients','M',false,true,true,false,3);
CREATE TEMP TABLE rg(t) AS VALUES ('g_cs_families'),('g_cs_report_codes');
CREATE TEMP TABLE rf(f) AS VALUES ('exports_transition_guard'),('schedules_codes_guard'),('schedule_recipients_cap');

-- C8 check 1: inventory, owner (AC-0B-1.2), schema privileges, no views, no sequences / enums
SELECT is((SELECT count(*)::int FROM pg_class c WHERE c.relnamespace = 'analytics'::regnamespace AND c.relkind IN ('r','p')), 26 + 2 + 1, 'C8 check 1: analytics holds 26 tenant + 2 G tables + event_inbox');
SELECT is((SELECT count(*)::int FROM pg_class c WHERE c.relnamespace = 'analytics'::regnamespace AND c.relkind IN ('v','m')), 0, 'C8 check 1: analytics has no view / materialised view (IC §6 has no analytics section)');
SELECT is((SELECT count(*)::int FROM pg_class c WHERE c.relnamespace = 'analytics'::regnamespace AND c.relkind = 'S'), 0, 'C8 check 1: no sequences');
SELECT is((SELECT count(*)::int FROM pg_type t WHERE t.typnamespace = 'analytics'::regnamespace AND t.typtype = 'e'), 0, 'C8 check 1: no ENUM types');
SELECT is(pg_get_userbyid(c.relowner), 'lims_owner', 'C8 check 1: analytics.' || c.relname || ' owned by lims_owner (AC-0B-1.2, AC-0B-6.3)') FROM pg_class c WHERE c.relnamespace = 'analytics'::regnamespace AND c.relkind = 'r';
SELECT is(has_schema_privilege('lims_app', 'analytics', 'USAGE'), true, 'lims_app has USAGE on schema analytics');
SELECT is(has_schema_privilege(r, 'analytics', 'CREATE'), false, r || ' cannot CREATE in analytics') FROM unnest(ARRAY['lims_app','lims_api','lims_worker','lims_analytics']) r;
SELECT is((SELECT count(*)::int FROM pg_class c WHERE c.relnamespace = 'analytics'::regnamespace AND c.relkind = 'r' AND c.relname = x.t), 1, 'table analytics.' || x.t || ' exists') FROM (SELECT t FROM rt UNION ALL SELECT t FROM rg) x;
SELECT is((SELECT count(*)::int FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid WHERE c.relnamespace = 'analytics'::regnamespace AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
            AND a.attname IN ('id','tenant_id') AND a.atthasdef), 0, 'C8 check 1: no DEFAULT on id / tenant_id (04 D9)');
SELECT is((SELECT count(*)::int FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid WHERE c.relnamespace = 'analytics'::regnamespace AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
            AND a.attname ~ '(patient_id|phone|barcode|registration|result_value|test_name|password|secret|token)'), 0, 'C8 check 1: no personal / credential column (§8)');

-- C8 check 2: RLS (AC-0B-2.1)
SELECT is(c.relrowsecurity AND c.relforcerowsecurity, true, 'C8 check 2 / AC-0B-2.1: analytics.' || x.t || ' ENABLE + FORCE RLS') FROM rt x JOIN pg_class c ON c.relname = x.t AND c.relnamespace = 'analytics'::regnamespace;
SELECT is(c.relrowsecurity, false, 'C8 check 2 / AC-0B-2.1: analytics.' || x.t || ' (class G) is RLS-exempt') FROM rg x JOIN pg_class c ON c.relname = x.t AND c.relnamespace = 'analytics'::regnamespace;
SELECT is((SELECT count(*)::int FROM pg_class c WHERE c.relnamespace = 'analytics'::regnamespace AND c.relkind = 'r' AND NOT (c.relrowsecurity AND c.relforcerowsecurity)), 2, 'C8 check 2 / AC-0B-2.1: exactly the 2 g_cs_* tables lack ENABLE + FORCE RLS (= db/tests/rls_exempt.txt)');

-- C8 check 3: exact policy set (AC-0B-2.2 / 2.3): 85 = 48 class R + 5 refresh_state + 4 dirty_partitions + 4 refresh_runs + 4 order_index + 4 exports + 3 export_files + 3 schedules + 3 schedule_recipients + 4 report_runs + 3 report_run_recipients
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'analytics' AND tablename <> 'event_inbox'), 85, 'C8 check 3 / AC-0B-2.3: 85 policies in analytics');
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'analytics' AND tablename = x.t), x.npol, 'C8 check 3: analytics.' || x.t || ' has ' || x.npol || ' policies') FROM rt x;
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'analytics' AND tablename = x.t), 0, 'C8 check 3: G table analytics.' || x.t || ' has no policy') FROM rg x;
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'analytics' AND tablename <> 'event_inbox' AND roles <> ARRAY['lims_app']::name[]), 0, 'C8 check 3 / AC-0B-2.2: every analytics policy is TO lims_app only (no PUBLIC / anon / authenticated / lims_owner)');
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'analytics' AND tablename <> 'event_inbox' AND (trim(qual) = 'true' OR trim(with_check) = 'true')), 0, 'C8 check 3 / AC-0B-2.2: no policy with a literal true predicate');
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'analytics' AND tablename <> 'event_inbox' AND policyname !~ ('^' || tablename || '__(select|insert|update|delete)__(tenant|tenant_centre|tenant_manual)$')), 0, 'C8 check 3 / AC-0B-2.2: policy names <table>__<command>__<scope>');
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'analytics' AND tablename <> 'event_inbox' AND coalesce(qual,'') !~ 'is_staff_or_system' AND cmd <> 'INSERT'), 0, 'C8 check 3 / 08 A17 P-16: staff guard in every USING');
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'analytics' AND tablename <> 'event_inbox' AND coalesce(with_check,'') !~ 'is_staff_or_system' AND cmd IN ('INSERT','UPDATE')), 0, 'C8 check 3 / 08 A17 P-16: staff guard in every WITH CHECK');
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'analytics' AND tablename <> 'event_inbox' AND (coalesce(qual,'') || coalesce(with_check,'')) ~ 'current_centre_ids' AND (coalesce(qual,'') || coalesce(with_check,'')) !~ '::uuid\[\]'), 0, 'C8 check 3 / 08 A16.1: ::uuid[] cast on every centre predicate');
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'analytics' AND tablename = x.t AND cmd = 'UPDATE'), 0, 'C8 check 3: class R table analytics.' || x.t || ' has no UPDATE policy') FROM rt x WHERE x.cls = 'R';
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'analytics' AND tablename IN ('schedules','schedule_recipients','refresh_state') AND cmd = 'DELETE'), 0, 'C8 check 3: no DELETE policy on schedules / schedule_recipients / refresh_state');
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'analytics' AND tablename = 'refresh_state' AND policyname LIKE '%\_manual' AND (coalesce(qual, '') || coalesce(with_check, '')) ~ 'family = ''_manual''::text'), 2, 'C8 check 3 / P-22: two _manual policies restricted to family = _manual');

-- C8 check 4: grant matrix (AC-0B-4.2 / 4.3; §3 grants paragraph)
SELECT is(has_table_privilege('lims_app', 'analytics.' || x.t, 'SELECT'), true, 'C8 check 4: lims_app SELECT on analytics.' || x.t) FROM rt x;
SELECT is(has_table_privilege('lims_app', 'analytics.' || x.t, 'INSERT'), x.i, 'C8 check 4: lims_app INSERT on analytics.' || x.t || ' = ' || x.i) FROM rt x;
SELECT is(has_table_privilege('lims_app', 'analytics.' || x.t, 'UPDATE'), x.u, 'C8 check 4: lims_app UPDATE on analytics.' || x.t || ' = ' || x.u) FROM rt x;
SELECT is(has_table_privilege('lims_app', 'analytics.' || x.t, 'DELETE'), x.d, 'C8 check 4: lims_app DELETE on analytics.' || x.t || ' = ' || x.d) FROM rt x;
SELECT is(has_table_privilege('lims_app', 'analytics.schedule_recipients', 'DELETE'), false, 'C8 check 4 / D-45: schedule_recipients DELETE = false (deactivate only)');
SELECT is(has_table_privilege('lims_app', 'analytics.' || x.t, 'SELECT'), true, 'C8 check 4: lims_app SELECT on G analytics.' || x.t) FROM rg x;
SELECT is(has_table_privilege('lims_app', 'analytics.' || x.t, 'INSERT') OR has_table_privilege('lims_app', 'analytics.' || x.t, 'UPDATE') OR has_table_privilege('lims_app', 'analytics.' || x.t, 'DELETE'), false, 'C8 check 4: no write on G analytics.' || x.t) FROM rg x;
SELECT is(has_table_privilege('lims_app', 'analytics.' || x.t, p), false, 'C8 check 4: lims_app has no ' || p || ' on analytics.' || x.t) FROM (SELECT t FROM rt UNION ALL SELECT t FROM rg) x CROSS JOIN unnest(ARRAY['TRUNCATE','REFERENCES','TRIGGER']) p;
SELECT is(has_table_privilege('lims_analytics', 'analytics.' || x.t, 'SELECT'), false, 'C8 check 4 / §3: lims_analytics has no grant on analytics.' || x.t) FROM (SELECT t FROM rt UNION ALL SELECT t FROM rg) x;
SELECT is((SELECT count(*)::int FROM information_schema.role_table_grants g WHERE g.table_schema = 'analytics' AND g.table_name <> 'event_inbox' AND g.grantee NOT IN ('lims_app','lims_owner')), 0, 'C8 check 4: no table grant to any other role (PUBLIC, anon, authenticated, lims_api, lims_worker)');
SELECT is(has_table_privilege('lims_app', 'analytics.' || x.t, 'DELETE'), false, 'C8 check 4 / AC-0B-4.2: class M analytics.' || x.t || ' has no DELETE (never hard-deleted)') FROM rt x WHERE x.cls = 'M';

-- C8 check 5: tenant_id leads every index / unique constraint of tenant tables; class R natural keys (02-CV §5.2 R)
SELECT is((SELECT a.attname FROM pg_attribute a WHERE a.attrelid = i.indrelid AND a.attnum = i.indkey[0]), 'tenant_id', 'C8 check 5: ' || c.relname || ' index ' || ic.relname || ' leads with tenant_id')
  FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid JOIN pg_class ic ON ic.oid = i.indexrelid
 WHERE c.relnamespace = 'analytics'::regnamespace AND c.relkind = 'r' AND c.relname NOT LIKE 'g\_%' AND c.relname <> 'event_inbox'
   AND NOT (i.indisprimary AND i.indnatts = 1 AND (SELECT a.attname FROM pg_attribute a WHERE a.attrelid = i.indrelid AND a.attnum = i.indkey[0]) = 'id');
SELECT is((SELECT count(*)::int FROM pg_index i WHERE i.indrelid = ('analytics.' || x.t)::regclass AND (i.indisprimary OR (i.indisunique AND i.indnullsnotdistinct))), 1,
          'C8 check 5: class R analytics.' || x.t || ' has exactly one natural key (PRIMARY KEY or UNIQUE NULLS NOT DISTINCT)') FROM rt x WHERE x.cls = 'R' AND x.t NOT IN ('daily_orders');
SELECT is((SELECT count(*)::int FROM pg_index i WHERE i.indrelid = 'analytics.daily_orders'::regclass AND i.indisprimary), 1, 'C8 check 5: daily_orders has a PRIMARY KEY (tenant_id, business_date, branch_id, centre_id)');
SELECT is((SELECT count(*)::int FROM pg_attribute a WHERE a.attrelid = ('analytics.' || x.t)::regclass AND a.attname IN ('tenant_id','refresh_run_id','refreshed_at') AND NOT a.attisdropped), 3, 'C8 check 5: class R analytics.' || x.t || ' carries tenant_id, refresh_run_id, refreshed_at') FROM rt x WHERE x.cls = 'R';
SELECT is((SELECT count(*)::int FROM pg_index i WHERE i.indexrelid = ('analytics.' || n)::regclass AND i.indpred IS NOT NULL), 1, 'C8 check 5: analytics.' || n || ' is a partial index')
  FROM unnest(ARRAY['order_index__tenant_id_open__p_idx','exports__tenant_id_expiry__p_idx','schedules__tenant_id_due__p_idx']) n;

-- C8 check 6: triggers (AC-0B-4.1 static part, AC-0B-5.1)
SELECT is((SELECT count(*)::int FROM pg_trigger t WHERE t.tgrelid = ('analytics.' || x.t)::regclass AND NOT t.tgisinternal AND t.tgenabled = 'O' AND t.tgfoid = 'app.enforce_mutable_columns'::regproc), 1, 'C8 check 6 / AC-0B-4.1: analytics.' || x.t || ' has an enabled app.enforce_mutable_columns trigger')
  FROM (VALUES ('exports'),('refresh_runs'),('report_runs')) x(t);
SELECT is((SELECT count(*)::int FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgrelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'analytics'::regnamespace) AND t.tgfoid = 'app.enforce_mutable_columns'::regproc), 3, 'C8 check 6: mutable-column triggers on exactly exports, refresh_runs, report_runs');
SELECT is((SELECT count(*)::int FROM pg_trigger t WHERE t.tgrelid = 'analytics.exports'::regclass AND NOT t.tgisinternal AND t.tgfoid = 'analytics.exports_transition_guard'::regproc AND (t.tgtype & 2) = 2 AND (t.tgtype & 16) = 16), 1, 'C8 check 6: exports_transition_guard is a BEFORE UPDATE trigger on exports');
SELECT is((SELECT count(*)::int FROM pg_trigger t WHERE t.tgrelid = 'analytics.schedules'::regclass AND NOT t.tgisinternal AND t.tgfoid = 'analytics.schedules_codes_guard'::regproc AND (t.tgtype & 2) = 2 AND (t.tgtype & 4) = 4 AND (t.tgtype & 16) = 16), 1, 'C8 check 6: schedules_codes_guard is BEFORE INSERT OR UPDATE on schedules');
SELECT is((SELECT count(*)::int FROM pg_trigger t WHERE t.tgrelid = 'analytics.schedule_recipients'::regclass AND NOT t.tgisinternal AND t.tgfoid = 'analytics.schedule_recipients_cap'::regproc AND (t.tgtype & 2) = 2 AND (t.tgtype & 4) = 4 AND (t.tgtype & 16) = 16), 1, 'C8 check 6: schedule_recipients_cap is BEFORE INSERT OR UPDATE on schedule_recipients');
SELECT is((SELECT count(*)::int FROM pg_trigger t WHERE t.tgrelid = ('analytics.' || x.t)::regclass AND NOT t.tgisinternal AND t.tgfoid = 'app.tg_row_audit'::regproc AND t.tgenabled = 'O'), CASE WHEN x.t IN ('schedules','schedule_recipients') THEN 1 ELSE 0 END,
          'C8 check 6 / AC-0B-5.1: audit trigger on analytics.' || x.t || ' only for schedules and schedule_recipients') FROM (SELECT t FROM rt UNION ALL SELECT t FROM rg) x;
SELECT is((SELECT count(*)::int FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgenabled <> 'O' AND t.tgrelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'analytics'::regnamespace)), 0, 'C8 check 6: no trigger disabled');

-- C8 check 7: FK direction (AC-0B-6.2) + functions
SELECT is((SELECT count(*)::int FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_class p ON p.oid = k.confrelid
            WHERE k.contype = 'f' AND c.relnamespace = 'analytics'::regnamespace AND p.relnamespace NOT IN ('analytics'::regnamespace, 'core'::regnamespace)), 0, 'C8 check 7 / AC-0B-6.2: analytics FKs point only to analytics / core');
SELECT is((SELECT count(*)::int FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_class p ON p.oid = k.confrelid
            WHERE k.contype = 'f' AND c.relnamespace = 'analytics'::regnamespace AND p.relnamespace = 'core'::regnamespace AND p.relname NOT IN ('tenants','memberships')), 0, 'C8 check 7: core FK targets are tenants and memberships only (no centre / branch FK on rollups)');
SELECT is((SELECT count(*)::int FROM pg_constraint k JOIN pg_class p ON p.oid = k.confrelid
            WHERE k.contype = 'f' AND p.relnamespace = 'analytics'::regnamespace AND k.connamespace <> 'analytics'::regnamespace), 0, 'C8 check 7 / AC-0B-6.2: nothing outside analytics references analytics (analytics is last in the DAG)');
SELECT is((SELECT count(*)::int FROM pg_constraint k JOIN pg_class p ON p.oid = k.confrelid WHERE k.contype = 'f' AND p.relnamespace = 'billing'::regnamespace AND k.connamespace = 'analytics'::regnamespace), 0, 'C8 check 7 / CV §5.4: no FK into billing');
SELECT is((SELECT count(*)::int FROM pg_proc p WHERE p.pronamespace = 'analytics'::regnamespace AND p.proname = x.f AND NOT p.prosecdef AND p.prorettype = 'trigger'::regtype AND pg_get_userbyid(p.proowner) = 'lims_owner'
            AND p.proconfig @> ARRAY['search_path=""']), 1, 'C8 check 7 / AC-0B-2.4: analytics.' || x.f || ' is an INVOKER trigger function owned by lims_owner with search_path = ''''') FROM rf x;
SELECT is((SELECT count(*)::int FROM pg_proc p WHERE p.pronamespace = 'analytics'::regnamespace AND p.prosecdef), 0, 'C8 check 7: no SECURITY DEFINER function in analytics (04 D7)');
SELECT is((SELECT count(*)::int FROM pg_proc p WHERE p.prosecdef AND p.proname ~ 'analytics'), 0, 'C8 check 7: no analytics-named DEFINER in app (retention deletes run as the system actor)');

SELECT * FROM finish();
ROLLBACK;
