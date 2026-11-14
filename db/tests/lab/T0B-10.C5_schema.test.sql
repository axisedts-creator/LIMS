-- T0B-10.C5 schema suite: lab catalogue properties (C5 05-SCHEMA §1, §3, §3.1, §4, §7; AC-0B-2.1, 2.2, 2.3, 2.4, 4.1, 4.2, 4.3, 5.1, 5.3, 6.2).
-- Pure pg_catalog assertions: no fixtures, no data written. One rolled-back transaction. RLS is never disabled.
-- Run from the repo root: pg_prove -d <db> db/tests/lab/T0B-10.C5_schema.test.sql   (pgTAP in schema `extensions`; migrations + seeds loaded; superuser)
-- Markers (the node test checks them): C5 check 1 inventory/owner, 2 no sequences/enums/defaults, 3 tenant_id-leading indexes, 4 RLS ENABLE+FORCE, 5 policy set,
-- 6 policy hygiene, 7 no DELETE, 8 no UPDATE on append-only, 9 results lock trigger + mutable_columns catalogue, 10 audit triggers, 11 views, 12 FK direction.
BEGIN;
SET search_path = extensions, public, pg_catalog;
SELECT * FROM no_plan();

CREATE TEMP TABLE lt(t, tpl, upd) AS VALUES   -- tpl: T tenant | TC tenant_centre ; upd: UPDATE granted
  ('lab_settings','T',true),('barcode_counters','T',true),('delta_check_rules','T',true),('order_readiness','T',true),('qc_holds','T',true),
  ('cs_rejection_reasons','T',true),('cs_return_reasons','T',true),('cs_amendment_reasons','T',true),('cs_exception_discard_reasons','T',true),
  ('report_releases','T',false),('module_submissions','T',false),
  ('orders','TC',true),('specimens','TC',true),('order_tests','TC',true),('results','TC',true),('result_versions','TC',true),('critical_value_log','TC',true),('worksheets','TC',true),
  ('ingest_exceptions','TC',true),('ingest_log','TC',true),('specimen_transitions','TC',false),('result_observations','TC',false),('result_attachments','TC',false),('verifications','TC',false),
  ('approvals','TC',false),('critical_notifications','TC',false),('worksheet_items','TC',false),('qc_results','TC',false);
CREATE TEMP TABLE lg(t) AS VALUES ('g_cs_rejection_reasons'),('g_cs_return_reasons'),('g_cs_amendment_reasons'),('g_cs_exception_discard_reasons');
CREATE TEMP TABLE lv(v, pub) AS VALUES ('v_result_current',false),('v_rejection_reasons',false),('v_return_reasons',false),('v_amendment_reasons',false),('v_exception_discard_reasons',false),
  ('v_pub_specimen_timeline',true),('v_pub_pending_items',true),('v_pub_result_daily',true),('v_pub_rejection_daily',true),('v_pub_critical_value_daily',true),('v_pub_qc_result',true);
CREATE TEMP TABLE ap(t) AS VALUES ('specimen_transitions'),('result_observations'),('result_attachments'),('verifications'),('approvals'),('critical_notifications'),('qc_results'),('worksheet_items'),('report_releases'),('module_submissions');

-- C5 check 1: inventory, owner (AC-0B-1.2), schema privileges
SELECT is((SELECT count(*)::int FROM pg_class c WHERE c.relnamespace = 'lab'::regnamespace AND c.relkind IN ('r','p')), 28 + 4 + 1, 'C5 check 1: lab holds 28 tenant + 4 G tables + event_inbox');
SELECT is((SELECT count(*)::int FROM pg_class c WHERE c.relnamespace = 'lab'::regnamespace AND c.relkind = 'v'), 11, 'C5 check 1: 5 internal + 6 v_pub_* views');
SELECT is((SELECT count(*)::int FROM pg_class c WHERE c.relnamespace = 'lab'::regnamespace AND c.relkind = 'm'), 0, 'no materialised view');
SELECT is(pg_get_userbyid(c.relowner), 'lims_owner', 'C5 check 1: lab.' || c.relname || ' owned by lims_owner (AC-0B-1.2)') FROM pg_class c WHERE c.relnamespace = 'lab'::regnamespace AND c.relkind IN ('r','v');
SELECT is(has_schema_privilege('lims_app', 'lab', 'USAGE'), true, 'lims_app has USAGE on schema lab');
SELECT is(has_schema_privilege(r, 'lab', 'CREATE'), false, r || ' cannot CREATE in lab') FROM unnest(ARRAY['lims_app','lims_api','lims_worker']) r;
SELECT is((SELECT count(*)::int FROM pg_class c WHERE c.relnamespace = 'lab'::regnamespace AND c.relkind = 'r' AND c.relname = x.t), 1, 'table lab.' || x.t || ' exists') FROM (SELECT t FROM lt UNION ALL SELECT t FROM lg) x;
-- LIKE copies carry the 02-CV §3 constraint names (not the generated *_pkey / *_key / *_check)
SELECT is((SELECT array_agg(k.conname::text ORDER BY k.conname::text COLLATE "C") FROM pg_constraint k WHERE k.conrelid = ('lab.cs_' || x.s)::regclass),
  (SELECT array_agg(e ORDER BY e COLLATE "C") FROM unnest(ARRAY['cs_' || x.s || '__code__ck','cs_' || x.s || '__display__ck','cs_' || x.s || '__pk','cs_' || x.s || '__tenant__fk','cs_' || x.s || '__tenant_id_code__uq','cs_' || x.s || '__tenant_id_id__uq']) e),
  'C5 check 1: lab.cs_' || x.s || ' constraint names')
  FROM (VALUES ('rejection_reasons'),('return_reasons'),('amendment_reasons'),('exception_discard_reasons')) x(s);
SELECT is((SELECT array_agg(k.conname::text ORDER BY k.conname::text COLLATE "C") FROM pg_constraint k WHERE k.conrelid = ('lab.g_cs_' || x.s)::regclass),
  (SELECT array_agg(e ORDER BY e COLLATE "C") FROM unnest(ARRAY['g_cs_' || x.s || '__code__ck','g_cs_' || x.s || '__code__uq','g_cs_' || x.s || '__display__ck','g_cs_' || x.s || '__pk']) e),
  'C5 check 1: lab.g_cs_' || x.s || ' constraint names')
  FROM (VALUES ('rejection_reasons'),('return_reasons'),('amendment_reasons'),('exception_discard_reasons')) x(s);

-- C5 check 2: no sequences / enums / defaults on id, tenant_id (04 D9)
SELECT is((SELECT count(*)::int FROM pg_class WHERE relkind = 'S' AND relnamespace = 'lab'::regnamespace), 0, 'C5 check 2: no sequences in lab (barcode {seq} = lab.barcode_counters)');
SELECT is((SELECT count(*)::int FROM pg_type t WHERE t.typnamespace = 'lab'::regnamespace AND t.typtype = 'e'), 0, 'C5 check 2: no ENUM types');
SELECT is((SELECT count(*)::int FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid WHERE c.relnamespace = 'lab'::regnamespace AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
            AND a.attname IN ('id','tenant_id') AND a.atthasdef), 0, 'C5 check 2: no DEFAULT on id / tenant_id');

-- C5 check 3: tenant_id leads every index / unique constraint of tenant tables; PK(id) tables also have UNIQUE (tenant_id, id)
SELECT is((SELECT a.attname FROM pg_attribute a WHERE a.attrelid = i.indrelid AND a.attnum = i.indkey[0]), 'tenant_id', 'C5 check 3: ' || c.relname || ' index ' || ic.relname || ' leads with tenant_id')
  FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid JOIN pg_class ic ON ic.oid = i.indexrelid
 WHERE c.relnamespace = 'lab'::regnamespace AND c.relkind = 'r' AND c.relname NOT LIKE 'g\_%' AND c.relname <> 'event_inbox'
   AND NOT (i.indisprimary AND i.indnatts = 1 AND (SELECT a.attname FROM pg_attribute a WHERE a.attrelid = i.indrelid AND a.attnum = i.indkey[0]) = 'id');
SELECT ok(EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid = c.oid AND k.contype = 'u' AND (SELECT array_agg(a.attname::text ORDER BY x.ord) FROM unnest(k.conkey) WITH ORDINALITY x(attnum, ord)
            JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = x.attnum) = ARRAY['tenant_id','id']), 'C5 check 3: lab.' || c.relname || ' has UNIQUE (tenant_id, id)')
  FROM pg_class c JOIN pg_constraint p ON p.conrelid = c.oid AND p.contype = 'p' AND p.conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = c.oid AND attname = 'id')]
 WHERE c.relnamespace = 'lab'::regnamespace AND c.relkind = 'r' AND c.relname NOT LIKE 'g\_%' AND c.relname <> 'event_inbox';

-- C5 check 4: RLS (AC-0B-2.1)
SELECT is(c.relrowsecurity AND c.relforcerowsecurity, true, 'C5 check 4 / AC-0B-2.1: lab.' || x.t || ' ENABLE + FORCE RLS') FROM lt x JOIN pg_class c ON c.relname = x.t AND c.relnamespace = 'lab'::regnamespace;
SELECT is(c.relrowsecurity, false, 'C5 check 4 / AC-0B-2.1: lab.' || x.t || ' (class G) is RLS-exempt') FROM lg x JOIN pg_class c ON c.relname = x.t AND c.relnamespace = 'lab'::regnamespace;

-- C5 check 5: exact policy set (AC-0B-2.2 / 2.3); 74 = 35 + 31 + 8
SELECT is((SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = 'lab' AND p.tablename = x.t AND p.cmd = upper(k.cmd) AND p.roles = ARRAY['lims_app']::name[]
            AND p.policyname = x.t || '__' || k.cmd || '__' || CASE WHEN x.tpl = 'T' OR (x.t = 'orders' AND k.cmd <> 'select') THEN 'tenant' ELSE 'tenant_centre' END), 1,
  'C5 check 5 / AC-0B-2.2: policy lab.' || x.t || '__' || k.cmd)
  FROM lt x CROSS JOIN (VALUES ('select'),('insert'),('update')) k(cmd) WHERE k.cmd <> 'update' OR x.upd;
SELECT is((SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = 'lab' AND p.tablename <> 'event_inbox'), 74, 'C5 check 5: exactly 74 lab policies (35 centre DO list + 31 tenant DO list + 8 literal)');
SELECT is((SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = 'lab' AND p.tablename IN (SELECT t FROM lg)), 0, 'G tables carry no policy');
SELECT is((SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = 'lab' AND p.tablename = x.t AND p.cmd = 'UPDATE'), 0, 'C5 check 5: lab.' || x.t || ' has no UPDATE policy (append-only, §7)') FROM ap x;
SELECT is((SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = 'lab' AND p.tablename <> 'event_inbox' AND p.cmd IN ('DELETE','ALL')), 0, 'C5 check 5: no DELETE / ALL policy anywhere in lab (02-CV §5.6)');

-- C5 check 6: policy hygiene (AC-0B-2.2, A16.1, CR-C13-011)
SELECT is((SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = 'lab' AND (p.roles && ARRAY['public','anon','authenticated']::name[])), 0, 'C5 check 6 / AC-0B-2.2: no policy for public / anon / authenticated');
SELECT is((SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = 'lab' AND (p.qual = 'true' OR p.with_check = 'true')), 0, 'C5 check 6 / AC-0B-2.2: no USING (true) / WITH CHECK (true)');
SELECT ok(p.policyname ~ ('^' || p.tablename || '__(select|insert|update)__(tenant|tenant_centre)$'), 'C5 check 6: policy name shape ' || p.policyname) FROM pg_policies p WHERE p.schemaname = 'lab' AND p.tablename <> 'event_inbox';
SELECT ok(coalesce(p.qual, '') || coalesce(p.with_check, '') ~ 'current_centre_ids\(\)( AS current_centre_ids)?\)::uuid\[\]', 'C5 check 6: A16.1 cast in ' || p.policyname)
  FROM pg_policies p WHERE p.schemaname = 'lab' AND coalesce(p.qual, '') || coalesce(p.with_check, '') ~ 'current_centre_ids';
SELECT ok(coalesce(p.qual, '') || coalesce(p.with_check, '') ~ 'is_staff_or_system', 'C5 check 6: staff guard in ' || p.policyname || ' (08 A17 P-16, check-registry; every lab policy)')
  FROM pg_policies p WHERE p.schemaname = 'lab' AND p.tablename <> 'event_inbox';
-- AC-0B-2.3: db/policies/lab.sql is the canonical copy of the DDL policies (the CI diff is in the node test and gate 9); here: the live catalogue has all 74
SELECT is((SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = 'lab' AND p.tablename <> 'event_inbox'), 74, 'AC-0B-2.3: the 74 policies of db/policies/lab.sql are the live policies');
SELECT is((SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = 'lab' AND p.tablename = 'qc_results' AND coalesce(p.qual, '') || coalesce(p.with_check, '') ~ 'processing_centre_id'), 0, 'qc_results policies use centre_id only');
SELECT is((SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = 'lab' AND p.tablename = 'specimens' AND coalesce(p.qual, '') || coalesce(p.with_check, '') ~ 'processing_centre_id'), 3, 'specimens policies: centre_id OR processing_centre_id (D-13)');
SELECT ok((SELECT p.qual ~ 'lab\.specimens' AND p.qual ~ 'processing_centre_id' FROM pg_policies p WHERE p.schemaname = 'lab' AND p.policyname = 'orders__select__tenant_centre'), 'orders SELECT also admits processing-centre staff through specimens');

-- C5 check 7: no DELETE (AC-0B-4.2)
SELECT is(has_table_privilege('lims_app', 'lab.' || x.t, 'DELETE'), false, 'C5 check 7 / AC-0B-4.2: lims_app has no DELETE on lab.' || x.t) FROM (SELECT t FROM lt UNION ALL SELECT t FROM lg UNION ALL SELECT 'event_inbox') x;
SELECT is(has_table_privilege(r, c.oid, 'DELETE'), false, 'C5 check 7: ' || r || ' has no DELETE on lab.' || c.relname) FROM pg_class c CROSS JOIN unnest(ARRAY['lims_api','lims_worker','anon','authenticated']) r
 WHERE c.relnamespace = 'lab'::regnamespace AND c.relkind = 'r' AND c.relname <> 'event_inbox' AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r);
SELECT is(has_table_privilege('lims_app', c.oid, 'TRUNCATE') OR has_table_privilege('lims_app', c.oid, 'REFERENCES') OR has_table_privilege('lims_app', c.oid, 'TRIGGER'), false, 'lims_app has no TRUNCATE/REFERENCES/TRIGGER on lab.' || c.relname)
  FROM pg_class c WHERE c.relnamespace = 'lab'::regnamespace AND c.relkind = 'r';
SELECT is(has_table_privilege('lims_app', 'lab.' || x.t, p), true, 'lims_app has ' || p || ' on lab.' || x.t) FROM lt x CROSS JOIN unnest(ARRAY['SELECT','INSERT']) p;
SELECT is(has_table_privilege('lims_app', 'lab.' || x.t, 'UPDATE'), x.upd, 'lims_app UPDATE on lab.' || x.t || ' = ' || x.upd) FROM lt x;
SELECT is(has_table_privilege('lims_app', 'lab.' || x.t, p), p = 'SELECT', 'lims_app ' || p || ' on G table lab.' || x.t || ' = ' || (p = 'SELECT')) FROM lg x CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) p;

-- C5 check 8: no UPDATE on the 10 append-only tables (§7, AC-0B-4.3)
SELECT is(has_table_privilege('lims_app', 'lab.' || x.t, 'UPDATE'), false, 'C5 check 8 / AC-0B-4.3: lims_app has no UPDATE on lab.' || x.t) FROM ap x;
SELECT is(has_table_privilege('lims_app', 'lab.event_inbox', 'UPDATE'), false, 'AC-0B-4.3: lims_app has no UPDATE on lab.event_inbox');
SELECT is((SELECT count(*)::int FROM information_schema.column_privileges WHERE table_schema = 'lab' AND grantee = 'lims_app' AND privilege_type = 'UPDATE' AND table_name IN (SELECT t FROM ap)), 0, 'no column-level UPDATE grant on append-only tables');

-- C5 check 9: lock + mutable-columns triggers (AC-0B-4.1 catalogue half; behaviour in T0B-10.C5_behaviour)
SELECT is((SELECT count(*)::int FROM pg_trigger t WHERE t.tgrelid = 'lab.results'::regclass AND t.tgname = 'results__lock' AND NOT t.tgisinternal AND t.tgenabled = 'O'
            AND t.tgfoid = 'lab.enforce_result_lock'::regproc AND (t.tgtype & 2) = 2 AND (t.tgtype & 16) = 16), 1, 'C5 check 9: results__lock BEFORE UPDATE FOR EACH ROW enabled');
SELECT is((SELECT count(*)::int FROM pg_trigger t WHERE t.tgrelid = ('lab.' || x.t)::regclass AND t.tgname = x.t || '__mutable_columns' AND NOT t.tgisinternal AND t.tgenabled = 'O' AND t.tgfoid = 'app.enforce_mutable_columns'::regproc), 1,
  'C5 check 9: lab.' || x.t || ' mutable_columns trigger enabled') FROM (VALUES ('specimens'),('result_versions'),('critical_value_log'),('ingest_log')) x(t);
SELECT is(pg_get_userbyid(p.proowner), 'lims_owner', 'enforce_result_lock owned by lims_owner') FROM pg_proc p WHERE p.oid = 'lab.enforce_result_lock()'::regprocedure;
SELECT ok(NOT p.prosecdef AND p.proconfig @> ARRAY['search_path=""'], 'enforce_result_lock is SECURITY INVOKER with search_path pinned') FROM pg_proc p WHERE p.oid = 'lab.enforce_result_lock()'::regprocedure;
SELECT is((SELECT count(*)::int FROM pg_proc p WHERE p.pronamespace = 'lab'::regnamespace), 1, 'lab has exactly one function');
SELECT is((SELECT count(*)::int FROM pg_proc p WHERE p.pronamespace = 'lab'::regnamespace AND p.prosecdef), 0, 'no SECURITY DEFINER function in lab');
SELECT is((SELECT count(*)::int FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgenabled <> 'O' AND t.tgrelid IN (SELECT c.oid FROM pg_class c WHERE c.relnamespace = 'lab'::regnamespace)), 0, 'no lab trigger disabled');

-- C5 check 10: audit triggers (AC-0B-5.1, 5.3)
SELECT is((SELECT count(*)::int FROM pg_trigger t WHERE t.tgrelid = ('lab.' || x.t)::regclass AND t.tgname = x.t || '__audit' AND t.tgenabled = 'O' AND t.tgfoid = 'app.tg_row_audit'::regproc), 1, 'C5 check 10 / AC-0B-5.1: lab.' || x.t || ' audit trigger')
  FROM (VALUES ('lab_settings'),('cs_rejection_reasons'),('cs_return_reasons'),('cs_amendment_reasons'),('cs_exception_discard_reasons'),('delta_check_rules'),('orders'),('specimens'),('order_tests'),('results'),
    ('result_versions'),('critical_value_log'),('order_readiness'),('worksheets'),('ingest_log'),('ingest_exceptions'),('qc_holds')) x(t);
SELECT is((SELECT count(*)::int FROM pg_trigger t WHERE t.tgrelid = ('lab.' || x.t)::regclass AND t.tgfoid = 'app.tg_row_audit'::regproc), 0, 'C5 check 10: class A / G lab.' || x.t || ' has no audit trigger') FROM (SELECT t FROM ap UNION ALL SELECT t FROM lg) x;
SELECT is(has_table_privilege('lims_app', 'audit.audit_log', 'INSERT'), false, 'AC-0B-5.3: lims_app has no INSERT on audit.audit_log');

-- C5 check 11: views (IC §6.3 column contract in the node test; behaviour in T0B-10.C5_behaviour)
SELECT is((SELECT count(*)::int FROM pg_class c WHERE c.relnamespace = 'lab'::regnamespace AND c.relkind = 'v' AND c.relname = x.v), 1, 'C5 check 11: view lab.' || x.v || ' exists') FROM lv x;
SELECT ok(coalesce(c.reloptions @> ARRAY['security_invoker=true'] OR c.reloptions @> ARRAY['security_invoker=on'], false), 'C5 check 11: lab.' || x.v || ' has security_invoker = true') FROM lv x JOIN pg_class c ON c.relname = x.v AND c.relnamespace = 'lab'::regnamespace;
SELECT is(has_table_privilege('lims_app', 'lab.' || x.v, 'SELECT'), true, 'lims_app can SELECT lab.' || x.v) FROM lv x;
SELECT is(has_table_privilege('lims_app', 'lab.' || x.v, p), false, 'lims_app cannot ' || p || ' lab.' || x.v) FROM lv x CROSS JOIN unnest(ARRAY['INSERT','UPDATE','DELETE']) p;
SELECT is((SELECT array_agg(a.attname::text ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid = 'lab.v_pub_specimen_timeline'::regclass AND a.attnum > 0 AND NOT a.attisdropped)[19:21],
  ARRAY['parent_specimen_id','replaces_specimen_id','specimen_version'], 'C5 check 11: v_pub_specimen_timeline appended columns (CR-C8-004, CR-C16-022)');
SELECT is((SELECT data_type FROM information_schema.columns WHERE table_schema = 'lab' AND table_name = 'v_pub_qc_result' AND column_name = 'value_numeric'), 'text', 'v_pub_qc_result.value_numeric is text decimal');

-- C5 check 12: FK direction / relocatability (AC-0B-6.2)
SELECT is((SELECT count(*)::int FROM pg_constraint k JOIN pg_class s ON s.oid = k.conrelid JOIN pg_class t ON t.oid = k.confrelid
            WHERE k.contype = 'f' AND s.relnamespace = 'lab'::regnamespace AND t.relnamespace NOT IN ('lab'::regnamespace, 'core'::regnamespace, 'frontdesk'::regnamespace)), 0,
  'C5 check 12 / AC-0B-6.2: lab FKs point only into lab / core / frontdesk (never billing, catalog)');
SELECT is((SELECT count(*)::int FROM pg_constraint k JOIN pg_class s ON s.oid = k.conrelid JOIN pg_class t ON t.oid = k.confrelid
            WHERE k.contype = 'f' AND t.relnamespace = 'lab'::regnamespace AND s.relnamespace <> 'lab'::regnamespace), 0, 'C5 check 12: no FK into lab from another schema yet');
SELECT is((SELECT count(*)::int FROM pg_constraint k WHERE k.contype = 'f' AND k.conrelid = 'lab.ingest_log'::regclass AND k.conname = 'ingest_log__exception__fk'), 1, 'ingest_log__exception__fk added after both tables exist');
SELECT is((SELECT count(*)::int FROM pg_constraint k WHERE k.contype = 'f' AND k.conrelid IN (SELECT c.oid FROM pg_class c WHERE c.relnamespace = 'lab'::regnamespace) AND k.conname !~ '__fk$'), 0, 'all lab FK names end __fk');
SELECT is((SELECT count(*)::int FROM pg_constraint k WHERE k.contype = 'f' AND k.conrelid IN (SELECT c.oid FROM pg_class c WHERE c.relnamespace = 'lab'::regnamespace) AND k.conkey[1] <> (SELECT attnum FROM pg_attribute WHERE attrelid = k.conrelid AND attname = 'tenant_id')
            AND array_length(k.conkey, 1) > 1), 0, 'composite FKs lead with tenant_id (AC-0B-3.5)');
SELECT is((SELECT count(*)::int FROM pg_depend d JOIN pg_rewrite r ON r.oid = d.objid JOIN pg_class v ON v.oid = r.ev_class
            WHERE v.relnamespace = 'lab'::regnamespace AND v.relkind = 'v' AND d.refclassid = 'pg_class'::regclass AND (SELECT relnamespace FROM pg_class WHERE oid = d.refobjid) = 'billing'::regnamespace), 0, 'no lab view reads billing');

SELECT * FROM finish();
ROLLBACK;
