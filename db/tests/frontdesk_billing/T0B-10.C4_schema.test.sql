-- T0B-10.C4 schema suite: frontdesk + billing catalogue properties (C4 05-SCHEMA §0, §2, §4a, §5, §6, §9 tests 1-4; AC-0B-2.1, 2.2, 2.4, 4.2, 4.3, 5.3, 6.2, 6.4).
-- Pure pg_catalog assertions: no fixtures, no data written. One rolled-back transaction. RLS is never disabled.
-- Run from the repo root: pg_prove -d <db> db/tests/frontdesk_billing/T0B-10.C4_schema.test.sql   (pgTAP in schema `extensions`; migrations + seeds loaded; superuser)
-- Coverage map (C4 05-SCHEMA §9):
-- §9 test 1: no sequences in frontdesk / billing
-- §9 test 2: every index / unique constraint leads with tenant_id (except PRIMARY KEY (id) and G tables); PK(id) tables also have UNIQUE (tenant_id, id)
-- §9 test 3: has_table_privilege(lims_app, t, DELETE) false except billing.export_jobs; purge_trf_drafts catalogue facts (behaviour: T0B-10.C4_behaviour)
-- §9 test 4: has_table_privilege(lims_app, t, UPDATE) false for the append-only tables
BEGIN;
SET search_path = extensions, public, pg_catalog;
SELECT * FROM no_plan();

CREATE TEMP TABLE tt(s, t, tpl) AS VALUES   -- tpl: T tenant | TC tenant_centre | TCN tenant_centre nullable centre
  ('frontdesk','settings','T'),('frontdesk','number_counters','T'),('frontdesk','patients','T'),('frontdesk','patient_consents','T'),('frontdesk','orders','TC'),('frontdesk','order_items','TC'),
  ('frontdesk','discount_approvals','TC'),('frontdesk','discounts','TC'),('frontdesk','trf_attachments','TC'),('frontdesk','order_flags','TC'),('frontdesk','booking_links','T'),('frontdesk','cs_reasons','T'),
  ('billing','settings','T'),('billing','fiscal_counters','T'),('billing','invoices','TCN'),('billing','invoice_lines','TCN'),('billing','credit_notes','TCN'),('billing','credit_note_lines','TCN'),
  ('billing','cash_sessions','TC'),('billing','ledger_entries','TCN'),('billing','order_balances','TC'),('billing','release_overrides','TC'),('billing','credit_accounts','T'),('billing','credit_charges','TC'),
  ('billing','credit_note_tasks','TC'),('billing','finance_review_items','TC'),('billing','refund_requests','TC'),('billing','payment_intent_refs','T'),('billing','print_log','TCN'),('billing','activity_log','T'),
  ('billing','cbms_submissions','T'),('billing','export_jobs','T'),('billing','cs_payment_methods','T'),('billing','cs_reasons','T');
CREATE TEMP TABLE gt(s, t) AS VALUES ('frontdesk','g_cs_reasons'),('billing','g_cs_payment_methods'),('billing','g_cs_reasons');
CREATE TEMP TABLE ap(s, t) AS VALUES ('billing','invoice_lines'),('billing','credit_note_lines'),('billing','ledger_entries'),('billing','print_log'),('billing','activity_log'),('billing','cbms_submissions'),
  ('billing','release_overrides'),('billing','payment_intent_refs'),('frontdesk','patient_consents');
CREATE TEMP TABLE vw(s, v) AS VALUES ('frontdesk','v_pub_order_daily'),('frontdesk','v_pub_referrer_volume'),('frontdesk','v_pub_centre_volume'),('frontdesk','v_pub_order_status'),
  ('billing','v_pub_invoice_daily'),('billing','v_pub_department_income'),('billing','v_pub_payment_collection'),('billing','v_pub_referrer_billing'),('billing','v_pub_credit_party_statement'),('billing','v_pub_order_balance');

-- ===================================================================================================================================== inventory
SELECT is((SELECT count(*)::int FROM pg_class c WHERE c.relnamespace = 'frontdesk'::regnamespace AND c.relkind IN ('r','p')), 13 + 1, 'frontdesk holds 12 tenant + 1 G table + event_inbox');
SELECT is((SELECT count(*)::int FROM pg_class c WHERE c.relnamespace = 'billing'::regnamespace AND c.relkind IN ('r','p')), 24 + 1, 'billing holds 22 tenant + 2 G tables + event_inbox');
SELECT is((SELECT count(*)::int FROM pg_class c WHERE c.relnamespace IN ('frontdesk'::regnamespace, 'billing'::regnamespace) AND c.relkind = 'm'), 0, 'no materialised view');
SELECT is(pg_get_userbyid(c.relowner), 'lims_owner', c.relnamespace::regnamespace || '.' || c.relname || ' owned by lims_owner (AC-0B-1.2)')
  FROM pg_class c WHERE c.relnamespace IN ('frontdesk'::regnamespace, 'billing'::regnamespace) AND c.relkind IN ('r','v');
SELECT is(has_schema_privilege('lims_app', s, 'USAGE'), true, 'lims_app has USAGE on schema ' || s) FROM (VALUES ('frontdesk'),('billing')) x(s);
SELECT is(has_schema_privilege(r, s, 'CREATE'), false, r || ' cannot CREATE in ' || s) FROM (VALUES ('frontdesk'),('billing')) x(s) CROSS JOIN unnest(ARRAY['lims_app','lims_api','lims_worker']) r;

-- ===================================================================================================================================== §9 test 1 (§0.2)
-- §9 test 1: no sequences in frontdesk / billing
SELECT is((SELECT count(*)::int FROM pg_class WHERE relkind = 'S' AND relnamespace IN ('frontdesk'::regnamespace, 'billing'::regnamespace)), 0, '§9 test 1: no sequences in frontdesk / billing');
SELECT is((SELECT count(*)::int FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid WHERE c.relnamespace IN ('frontdesk'::regnamespace, 'billing'::regnamespace) AND c.relkind = 'r'
            AND a.attnum > 0 AND NOT a.attisdropped AND a.attname IN ('id','tenant_id') AND a.atthasdef), 0, 'no DEFAULT on id / tenant_id (UUIDv7 in app code, 04 D9)');
SELECT is((SELECT count(*)::int FROM pg_type t WHERE t.typnamespace IN ('frontdesk'::regnamespace, 'billing'::regnamespace) AND t.typtype = 'e'), 0, 'no ENUM types (§0.3)');

-- ===================================================================================================================================== §9 test 2
-- §9 test 2: tenant_id leads every index and unique constraint of a tenant table; PRIMARY KEY (id) is the single allowed exception and then UNIQUE (tenant_id, id) exists
SELECT is((SELECT a.attname FROM pg_attribute a WHERE a.attrelid = i.indrelid AND a.attnum = i.indkey[0]), 'tenant_id',
  '§9 test 2: ' || c.relnamespace::regnamespace || '.' || c.relname || ' index ' || ic.relname || ' leads with tenant_id')
  FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid JOIN pg_class ic ON ic.oid = i.indexrelid
 WHERE c.relnamespace IN ('frontdesk'::regnamespace, 'billing'::regnamespace) AND c.relkind = 'r' AND c.relname NOT LIKE 'g\_%' AND c.relname <> 'event_inbox'
   AND NOT (i.indisprimary AND i.indnatts = 1 AND (SELECT a.attname FROM pg_attribute a WHERE a.attrelid = i.indrelid AND a.attnum = i.indkey[0]) = 'id');
SELECT ok(EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid = c.oid AND k.contype = 'u' AND (SELECT array_agg(a.attname::text ORDER BY x.ord) FROM unnest(k.conkey) WITH ORDINALITY x(attnum, ord)
            JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = x.attnum) = ARRAY['tenant_id','id']),
  '§9 test 2: ' || c.relnamespace::regnamespace || '.' || c.relname || ' has UNIQUE (tenant_id, id) next to PRIMARY KEY (id)')
  FROM pg_class c JOIN pg_constraint p ON p.conrelid = c.oid AND p.contype = 'p' AND p.conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = c.oid AND attname = 'id')]
 WHERE c.relnamespace IN ('frontdesk'::regnamespace, 'billing'::regnamespace) AND c.relkind = 'r' AND c.relname NOT LIKE 'g\_%' AND c.relname <> 'event_inbox';

-- ===================================================================================================================================== RLS + policies (AC-0B-2.1 / 2.2 / 2.3)
SELECT is(c.relrowsecurity AND c.relforcerowsecurity, true, 'AC-0B-2.1 ' || x.s || '.' || x.t || ' ENABLE + FORCE RLS')
  FROM tt x JOIN pg_class c ON c.relname = x.t AND c.relnamespace = x.s::regnamespace;
SELECT is(c.relrowsecurity, false, 'AC-0B-2.1 ' || x.s || '.' || x.t || ' (class G) is RLS-exempt') FROM gt x JOIN pg_class c ON c.relname = x.t AND c.relnamespace = x.s::regnamespace;
SELECT is((SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = x.s AND p.tablename = x.t AND p.policyname = x.t || '__' || k.cmd || CASE x.tpl WHEN 'T' THEN '__tenant' ELSE '__tenant_centre' END
            AND p.cmd = upper(k.cmd) AND p.roles = ARRAY['lims_app']::name[]), 1, 'policy ' || x.s || '.' || x.t || '__' || k.cmd || ' (TO lims_app)')
  FROM tt x CROSS JOIN (VALUES ('select'),('insert'),('update')) k(cmd)
 WHERE NOT (k.cmd = 'update' AND (x.s || '.' || x.t) IN (SELECT s || '.' || t FROM ap));
SELECT is((SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = x.s AND p.tablename = x.t AND p.cmd = 'UPDATE'), 0, x.s || '.' || x.t || ' has no UPDATE policy (append-only)') FROM ap x;
SELECT is((SELECT count(*)::int FROM pg_policies p WHERE p.schemaname IN ('frontdesk','billing') AND p.cmd = 'DELETE' AND p.roles = ARRAY['lims_app']::name[]), 1, 'exactly one lims_app DELETE policy in C4: billing.export_jobs');
SELECT is((SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = 'billing' AND p.tablename = 'export_jobs' AND p.policyname = 'export_jobs__delete__tenant' AND p.cmd = 'DELETE'), 1, 'export_jobs__delete__tenant');
SELECT is((SELECT count(*)::int FROM pg_policies p WHERE p.schemaname IN ('frontdesk','billing') AND p.tablename IN (SELECT t FROM gt)), 0, 'G tables carry no policy');
SELECT is((SELECT count(*)::int FROM pg_policies p WHERE p.schemaname IN ('frontdesk','billing') AND p.tablename <> 'event_inbox'), 96, 'C4 has exactly the §4a policy count: 34 x 3 - 9 append-only UPDATEs + export_jobs DELETE + 2 trf_attachments owner policies = 96');
-- AC-0B-2.2: no PUBLIC / anon / authenticated, no USING (true), names <table>__<cmd>__<scope>
SELECT is((SELECT count(*)::int FROM pg_policies p WHERE p.schemaname IN ('frontdesk','billing') AND (p.roles && ARRAY['public','anon','authenticated']::name[])), 0, 'AC-0B-2.2: no policy for public / anon / authenticated');
SELECT is((SELECT count(*)::int FROM pg_policies p WHERE p.schemaname IN ('frontdesk','billing') AND (p.qual = 'true' OR p.with_check = 'true')), 0, 'AC-0B-2.2: no USING (true) / WITH CHECK (true)');
SELECT ok(p.policyname ~ ('^' || p.tablename || '__(select|insert|update|delete)__(tenant|tenant_centre|owner_only)$'), 'AC-0B-2.2: policy name shape ' || p.policyname) FROM pg_policies p WHERE p.schemaname IN ('frontdesk','billing');
-- P-16 staff guard + A16.1 cast
SELECT ok(coalesce(p.qual, '') ~ 'is_staff_or_system' OR p.cmd = 'INSERT', 'USING of ' || p.tablename || '.' || p.policyname || ' has the staff guard (P-16)') FROM pg_policies p WHERE p.schemaname IN ('frontdesk','billing') AND p.policyname !~ 'owner_only|event_inbox';
SELECT ok(coalesce(p.with_check, '') ~ 'is_staff_or_system' OR p.cmd IN ('SELECT','DELETE'), 'WITH CHECK of ' || p.tablename || '.' || p.policyname || ' has the staff guard (P-16)') FROM pg_policies p WHERE p.schemaname IN ('frontdesk','billing') AND p.policyname !~ 'owner_only';
SELECT ok(coalesce(p.qual, '') || coalesce(p.with_check, '') ~ 'current_centre_ids\(\)( AS current_centre_ids)?\)::uuid\[\]', 'A16.1 cast in ' || p.policyname || ' on ' || p.tablename)
  FROM pg_policies p JOIN tt x ON x.s = p.schemaname AND x.t = p.tablename WHERE x.tpl IN ('TC','TCN') AND p.policyname !~ 'owner_only';
SELECT ok(coalesce(p.qual, '') || coalesce(p.with_check, '') ~ 'centre_id IS NOT NULL', 'TCN ' || p.policyname || ' on ' || p.tablename || ' hides NULL-centre rows from centre-scoped actors')
  FROM pg_policies p JOIN tt x ON x.s = p.schemaname AND x.t = p.tablename WHERE x.tpl = 'TCN';
SELECT is((SELECT count(*)::int FROM pg_policies p JOIN tt x ON x.s = p.schemaname AND x.t = p.tablename WHERE x.tpl IN ('T') AND p.qual ~ 'current_centre_ids'), 0, 'tenant-scoped tables carry no centre predicate');
-- owner policies of the purge DEFINER (08 A10.5)
SELECT is((SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = 'frontdesk' AND p.tablename = 'trf_attachments' AND p.policyname IN ('trf_attachments__select__owner_only','trf_attachments__delete__owner_only')
            AND p.roles = ARRAY['lims_owner']::name[] AND p.qual ~ 'frontdesk_purge_trf_drafts' AND p.qual ~ 'order_id IS NULL'), 2, 'AC-0B-2.4: the two narrow trf_attachments owner_only policies exist');
SELECT is((SELECT count(*)::int FROM pg_policies p WHERE p.schemaname IN ('frontdesk','billing') AND p.policyname ~ '__owner_only$' AND p.tablename <> 'event_inbox'), 2, 'no other owner_only policy in C4');

-- ===================================================================================================================================== §9 tests 3 + 4 (AC-0B-4.2 / 4.3)
-- §9 test 3: no DELETE for lims_app except billing.export_jobs
SELECT is(has_table_privilege('lims_app', x.s || '.' || x.t, 'DELETE'), false, '§9 test 3 / AC-0B-4.2: lims_app has no DELETE on ' || x.s || '.' || x.t)
  FROM (SELECT s, t FROM tt UNION ALL SELECT s, t FROM gt) x WHERE x.s || '.' || x.t <> 'billing.export_jobs';
SELECT is(has_table_privilege('lims_app', 'billing.export_jobs', 'DELETE'), true, '§9 test 3: lims_app has DELETE on billing.export_jobs (class E purge job)');
SELECT is(has_table_privilege('lims_app', x.s || '.' || x.t, p), true, 'lims_app has ' || p || ' on ' || x.s || '.' || x.t)
  FROM tt x CROSS JOIN unnest(ARRAY['SELECT','INSERT']) p;
SELECT is(has_table_privilege('lims_app', x.s || '.' || x.t, 'UPDATE'), true, 'lims_app has UPDATE on ' || x.s || '.' || x.t) FROM tt x WHERE (x.s || '.' || x.t) NOT IN (SELECT s || '.' || t FROM ap);
-- §9 test 4: no UPDATE on the append-only tables (also 4.3: class A event_inbox)
SELECT is(has_table_privilege('lims_app', x.s || '.' || x.t, 'UPDATE'), false, '§9 test 4 / AC-0B-4.3: lims_app has no UPDATE on ' || x.s || '.' || x.t) FROM ap x;
SELECT is(has_table_privilege('lims_app', x.s || '.event_inbox', 'UPDATE'), false, 'AC-0B-4.3: lims_app has no UPDATE on ' || x.s || '.event_inbox') FROM (VALUES ('frontdesk'),('billing')) x(s);
SELECT is(has_table_privilege('lims_app', x.s || '.' || x.t, p), false, 'lims_app cannot ' || p || ' G table ' || x.s || '.' || x.t) FROM gt x CROSS JOIN unnest(ARRAY['INSERT','UPDATE','DELETE']) p;
SELECT is(has_table_privilege('lims_app', x.s || '.' || x.t, 'SELECT'), true, 'lims_app can read G table ' || x.s || '.' || x.t) FROM gt x;
SELECT is(has_table_privilege('lims_app', c.oid, 'TRUNCATE') OR has_table_privilege('lims_app', c.oid, 'REFERENCES') OR has_table_privilege('lims_app', c.oid, 'TRIGGER'), false,
  'lims_app has no TRUNCATE/REFERENCES/TRIGGER on ' || c.relnamespace::regnamespace || '.' || c.relname) FROM pg_class c WHERE c.relnamespace IN ('frontdesk'::regnamespace, 'billing'::regnamespace) AND c.relkind = 'r';
SELECT is(has_table_privilege(r, c.oid, p), false, r || ' has no ' || p || ' on ' || c.relnamespace::regnamespace || '.' || c.relname)
  FROM pg_class c CROSS JOIN unnest(ARRAY['anon','authenticated']) r CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) p
 WHERE c.relnamespace IN ('frontdesk'::regnamespace, 'billing'::regnamespace) AND c.relkind IN ('r','v') AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r);
SELECT is(has_table_privilege(r, c.oid, 'DELETE'), false, r || ' has no DELETE on ' || c.relnamespace::regnamespace || '.' || c.relname)
  FROM pg_class c CROSS JOIN unnest(ARRAY['lims_api','lims_worker']) r WHERE c.relnamespace IN ('frontdesk'::regnamespace, 'billing'::regnamespace) AND c.relkind = 'r' AND c.relname NOT IN ('event_inbox', 'export_jobs');   -- lims_api / lims_worker inherit lims_app, whose only DELETE is export_jobs
SELECT is((SELECT count(*)::int FROM information_schema.column_privileges WHERE table_schema IN ('frontdesk','billing') AND grantee = 'lims_app' AND privilege_type IN ('UPDATE','INSERT')
            AND table_name IN (SELECT t FROM ap)  AND privilege_type = 'UPDATE'), 0, 'no column-level UPDATE grant on append-only tables');

-- ===================================================================================================================================== DEFINER purge_trf_drafts (catalogue facts; AC-0B-2.4)
SELECT is((SELECT count(*)::int FROM pg_proc p WHERE p.pronamespace IN ('frontdesk'::regnamespace, 'billing'::regnamespace) AND p.prosecdef), 1, 'exactly one SECURITY DEFINER function in C4');
SELECT is(pg_get_userbyid(p.proowner), 'lims_owner', 'purge_trf_drafts owned by lims_owner') FROM pg_proc p WHERE p.oid = 'frontdesk.purge_trf_drafts(interval, uuid[])'::regprocedure;
SELECT ok(p.prosecdef AND p.proconfig @> ARRAY['search_path=""'], 'purge_trf_drafts is SECURITY DEFINER with search_path pinned to ""') FROM pg_proc p WHERE p.oid = 'frontdesk.purge_trf_drafts(interval, uuid[])'::regprocedure;
SELECT is(has_function_privilege('lims_worker', 'frontdesk.purge_trf_drafts(interval, uuid[])', 'EXECUTE'), true, 'lims_worker may EXECUTE purge_trf_drafts');
SELECT is(has_function_privilege(r, 'frontdesk.purge_trf_drafts(interval, uuid[])', 'EXECUTE'), false, r || ' may not EXECUTE purge_trf_drafts') FROM unnest(ARRAY['lims_app','lims_api','anon','authenticated']) r WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r);
SELECT is((SELECT count(*)::int FROM pg_proc p WHERE p.pronamespace IN ('frontdesk'::regnamespace, 'billing'::regnamespace) AND p.prosecdef = false AND p.proconfig @> ARRAY['search_path=""']), 14, 'the 14 guard functions are INVOKER with search_path pinned');
SELECT is(pg_get_userbyid(p.proowner), 'lims_owner', p.proname || ' owned by lims_owner') FROM pg_proc p WHERE p.pronamespace IN ('frontdesk'::regnamespace, 'billing'::regnamespace);

-- ===================================================================================================================================== triggers present (AC-0B-4.1 catalogue half; behaviour in T0B-10.C4_behaviour)
SELECT is((SELECT count(*)::int FROM pg_trigger t WHERE t.tgrelid = ('billing.' || x.t)::regclass AND t.tgname = x.t || '__mutable_columns' AND NOT t.tgisinternal AND t.tgenabled = 'O'), 1, 'billing.' || x.t || ' mutable_columns trigger enabled')
  FROM (VALUES ('invoices'),('credit_notes'),('fiscal_counters'),('cash_sessions'),('credit_charges'),('refund_requests')) x(t);
SELECT is((SELECT count(*)::int FROM pg_trigger t WHERE t.tgrelid = ('frontdesk.' || x.t)::regclass AND t.tgname = x.t || '__mutable_columns' AND NOT t.tgisinternal AND t.tgenabled = 'O'), 1, 'frontdesk.' || x.t || ' mutable_columns trigger enabled')
  FROM (VALUES ('orders'),('order_items'),('discounts'),('discount_approvals'),('trf_attachments')) x(t);
SELECT is((SELECT count(*)::int FROM pg_trigger t WHERE t.tgrelid = 'frontdesk.patients'::regclass AND t.tgname = 'patients__audit' AND t.tgenabled = 'O'), 1, 'patients audit trigger enabled (AC-0B-5.1)');
SELECT is((SELECT count(*)::int FROM pg_trigger t WHERE t.tgrelid = x.r::regclass AND t.tgfoid = 'app.tg_row_audit'::regproc), 0, x.r || ' (class A) has no audit trigger')
  FROM (VALUES ('frontdesk.patient_consents'),('billing.print_log'),('billing.activity_log'),('billing.cbms_submissions'),('billing.release_overrides'),('billing.payment_intent_refs')) x(r);
SELECT is((SELECT count(*)::int FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgenabled <> 'O' AND t.tgrelid IN (SELECT c.oid FROM pg_class c WHERE c.relnamespace IN ('frontdesk'::regnamespace, 'billing'::regnamespace))), 0, 'no trigger disabled');
-- AC-0B-5.3: lims_app cannot write the audit log directly
SELECT is(has_table_privilege('lims_app', 'audit.audit_log', 'INSERT'), false, 'AC-0B-5.3: lims_app has no INSERT on audit.audit_log');

-- ===================================================================================================================================== relocatability (AC-0B-6.2 / 6.4; §0.5)
SELECT is((SELECT count(*)::int FROM pg_constraint k JOIN pg_class s ON s.oid = k.conrelid JOIN pg_class t ON t.oid = k.confrelid
            WHERE k.contype = 'f' AND s.relnamespace = 'billing'::regnamespace AND t.relnamespace NOT IN ('billing'::regnamespace, 'core'::regnamespace)), 0, 'AC-0B-6.4: billing FKs point only into billing / core (no FK to frontdesk, catalog ...)');
SELECT is((SELECT count(*)::int FROM pg_constraint k JOIN pg_class s ON s.oid = k.conrelid JOIN pg_class t ON t.oid = k.confrelid
            WHERE k.contype = 'f' AND t.relnamespace = 'billing'::regnamespace AND s.relnamespace <> 'billing'::regnamespace), 0, 'AC-0B-6.2: no FK points into billing from another schema (CV §5.4)');
SELECT is((SELECT count(*)::int FROM pg_constraint k JOIN pg_class s ON s.oid = k.conrelid JOIN pg_class t ON t.oid = k.confrelid
            WHERE k.contype = 'f' AND s.relnamespace = 'frontdesk'::regnamespace AND t.relnamespace NOT IN ('frontdesk'::regnamespace, 'core'::regnamespace)), 0, 'frontdesk FKs point only into frontdesk / core');
SELECT is((SELECT count(*)::int FROM pg_constraint k JOIN pg_class s ON s.oid = k.conrelid
            WHERE k.contype = 'f' AND s.relnamespace = 'billing'::regnamespace AND k.confrelid = 'billing.invoices'::regclass), (SELECT count(*)::int FROM pg_constraint k WHERE k.contype = 'f' AND k.confrelid = 'billing.invoices'::regclass),
  'every FK onto billing.invoices originates in billing');
SELECT is((SELECT count(*)::int FROM pg_depend d JOIN pg_rewrite r ON r.oid = d.objid JOIN pg_class v ON v.oid = r.ev_class
            WHERE v.relnamespace = 'billing'::regnamespace AND v.relkind = 'v' AND d.refclassid = 'pg_class'::regclass AND (SELECT relnamespace FROM pg_class WHERE oid = d.refobjid) = 'frontdesk'::regnamespace), 0,
  'AC-0B-6.4: no billing view reads frontdesk (billing schema isolatable)');

-- ===================================================================================================================================== views (§6; IC §6.1/§6.2 column contract in the node test, behaviour in T0B-10.C4_behaviour)
SELECT is((SELECT count(*)::int FROM pg_class c WHERE c.relnamespace IN ('frontdesk'::regnamespace, 'billing'::regnamespace) AND c.relkind = 'v'), 10, 'C4 publishes exactly the ten v_pub_* views');
SELECT is((SELECT count(*)::int FROM pg_class c WHERE c.relnamespace = x.s::regnamespace AND c.relkind = 'v' AND c.relname = x.v), 1, 'view ' || x.s || '.' || x.v || ' exists') FROM vw x;
SELECT is(coalesce(c.reloptions @> ARRAY['security_invoker=true'] OR c.reloptions @> ARRAY['security_invoker=on'], false), true, x.s || '.' || x.v || ' has security_invoker = true')
  FROM vw x JOIN pg_class c ON c.relname = x.v AND c.relnamespace = x.s::regnamespace;
SELECT is(has_table_privilege('lims_app', x.s || '.' || x.v, 'SELECT'), true, 'lims_app can SELECT ' || x.s || '.' || x.v) FROM vw x;
SELECT is(has_table_privilege('lims_app', x.s || '.' || x.v, p), false, 'lims_app cannot ' || p || ' ' || x.s || '.' || x.v) FROM vw x CROSS JOIN unnest(ARRAY['INSERT','UPDATE','DELETE']) p;
SELECT is((SELECT array_agg(a.attname::text ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid = 'billing.v_pub_payment_collection'::regclass AND a.attnum > 0 AND NOT a.attisdropped),
  ARRAY['tenant_id','branch_id','centre_id','business_date','collected_by_membership_id','payment_method_code','entries','reversals','gross_collected_paisa','reversed_paisa','net_collected_paisa'], '§9 test 7 (catalogue): v_pub_payment_collection exposes payment_method_code (08 R4)');

SELECT * FROM finish();
ROLLBACK;
