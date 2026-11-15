-- T0B-13.C11 schema suite: anatomic catalogue properties (C11 05-SCHEMA §1, §3, §4, §6, §7, §8, §11 items 1, 4, 5; AC-0B-2.1, 2.2, 2.3, 2.4, 3.6, 4.1, 4.2, 4.3, 5.1, 5.3, 6.1, 6.2, 6.3).
-- Pure pg_catalog assertions: no fixtures, no data written. One rolled-back transaction. RLS is never disabled.
-- Run from the repo root: pg_prove -d <db> db/tests/anatomic/T0B-13.C11_schema.test.sql   (pgTAP in schema `extensions`; migrations + seeds loaded; superuser)
-- Markers (the node test checks them): C11 check 1 inventory/owner/no sequences or enums, 2 RLS ENABLE+FORCE (G exempt), 3 policy set per table, 4 grant matrix (no DELETE anywhere), 5 indexes + constraint names,
-- 6 triggers + functions + audit, 7 FK direction, no DEFINER, view, seed (AC-0B-6.1 / 6.2 / 6.3). Checks 8-15 are in T0B-13.C11_behaviour.test.sql.
-- Scope note (as T0B-10.C5..C8, T0B-13.C9, C10): event_inbox is C0's (T0B-05) and is excluded from every count. lims_api / lims_worker INHERIT lims_app, so "no DELETE / no UPDATE" is asserted for lims_app only.
-- Spec reading recorded here (tester assumption, see note T0B-13.C11-tests.md): "audited: true for every M and C table" (§3) => 25 audit triggers; the class E counter and the 4 class A tables carry none.
BEGIN;
SET search_path = extensions, public, pg_catalog;
SELECT * FROM no_plan();

-- t: table; cls: §1 class; centre: §1 scope; i/u: lims_app whole-table INSERT / UPDATE; npol: expected policies (cases: 3 explicit; others per the §7 loop); aud: audit trigger expected
CREATE TEMP TABLE rt(t, cls, centre, i, u, npol, aud) AS VALUES
  ('settings','M',false,true,true,3,true),('accession_counters','E',false,true,true,3,false),('test_profiles','M',false,true,true,3,true),('stains','M',false,true,true,3,true),
  ('assays','M',false,true,true,3,true),('assay_targets','M',false,true,true,3,true),('assay_target_values','M',false,true,true,3,true),('cs_cancel_reasons','M',false,true,true,3,true),
  ('cs_diagnoses','M',false,true,true,3,true),('cs_cytology_adequacy','M',false,true,true,3,true),('synoptic_templates','M',false,true,true,3,true),('text_templates','M',false,true,true,3,true),
  ('batches','C',false,true,true,3,true),('batch_members','C',false,true,true,3,true),
  ('cases','C',true,true,true,3,true),('case_transitions','A',true,true,false,2,false),('case_items','C',true,true,true,3,true),('specimen_links','C',true,true,true,3,true),
  ('parts','C',true,true,true,3,true),('gross_records','C',true,true,true,3,true),('blocks','C',true,true,true,3,true),('slides','C',true,true,true,3,true),('stain_orders','C',true,true,true,3,true),
  ('object_movements','A',true,true,false,2,false),('images','C',true,true,true,3,true),('report_drafts','C',true,true,true,3,true),('report_versions','A',true,true,false,2,false),
  ('item_submissions','A',true,true,false,2,false),('addenda','C',true,true,true,3,true),('molecular_results','C',true,true,true,3,true);
CREATE TEMP TABLE rg(t) AS VALUES ('g_cs_cancel_reasons');
CREATE TEMP TABLE rf(f) AS VALUES ('guard_synoptic_template'),('guard_case'),('guard_report_draft'),('guard_addendum');

-- C11 check 1: inventory, owner (AC-0B-1.2, AC-0B-6.3), schema privileges, no sequences / enums
SELECT is((SELECT count(*)::int FROM pg_class c WHERE c.relnamespace = 'anatomic'::regnamespace AND c.relkind IN ('r','p')), 30 + 1 + 1, 'C11 check 1: anatomic holds 30 tenant + 1 G table + event_inbox (31 chunk tables)');
SELECT is((SELECT array_agg(c.relname::text ORDER BY c.relname) FROM pg_class c WHERE c.relnamespace = 'anatomic'::regnamespace AND c.relkind IN ('v','m')), ARRAY['v_pub_report_content'], 'C11 check 1: the only view is v_pub_report_content (no materialized view)');
SELECT is((SELECT count(*)::int FROM pg_class c WHERE c.relnamespace = 'anatomic'::regnamespace AND c.relkind = 'S'), 0, 'C11 check 1: no sequences');
SELECT is((SELECT count(*)::int FROM pg_type t WHERE t.typnamespace = 'anatomic'::regnamespace AND t.typtype = 'e'), 0, 'C11 check 1: no ENUM types');
SELECT is(pg_get_userbyid(c.relowner), 'lims_owner', 'C11 check 1: anatomic.' || c.relname || ' owned by lims_owner (AC-0B-1.2, AC-0B-6.3)') FROM pg_class c WHERE c.relnamespace = 'anatomic'::regnamespace AND c.relkind IN ('r','v');
SELECT is(has_schema_privilege('lims_app', 'anatomic', 'USAGE'), true, 'lims_app has USAGE on schema anatomic');
SELECT is(has_schema_privilege(r, 'anatomic', 'CREATE'), false, r || ' cannot CREATE in anatomic') FROM unnest(ARRAY['lims_app','lims_api','lims_worker','lims_analytics']) r;
SELECT is((SELECT count(*)::int FROM rt) + (SELECT count(*)::int FROM rg), 31, 'C11 check 1: 31 tables in the inventory (= table count of the 05-SCHEMA §6 DDL)');
SELECT is((SELECT array_agg(relname::text ORDER BY relname) FROM pg_class WHERE relnamespace = 'anatomic'::regnamespace AND relkind = 'r' AND relname <> 'event_inbox'), (SELECT array_agg(t ORDER BY t) FROM (SELECT t FROM rt UNION ALL SELECT t FROM rg) x), 'C11 check 1: the table set equals the §1 inventory');

-- C11 check 2: RLS ENABLE + FORCE on the 30 tenant tables, none on g_cs_cancel_reasons (AC-0B-2.1, 2.4)
SELECT is((SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = ('anatomic.' || t)::regclass), true, 'C11 check 2 / AC-0B-2.1: ENABLE + FORCE RLS on anatomic.' || t) FROM rt;
SELECT is((SELECT relrowsecurity OR relforcerowsecurity FROM pg_class WHERE oid = ('anatomic.' || t)::regclass), false, 'C11 check 2 / AC-0B-2.1: anatomic.' || t || ' is RLS-exempt (global coded set, listed in rls_exempt.txt)') FROM rg;
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'anatomic' AND tablename = g.t), 0, 'C11 check 2: no policy on ' || g.t) FROM rg g;
SELECT is(NOT EXISTS (SELECT 1 FROM pg_class WHERE relnamespace = 'anatomic'::regnamespace AND relkind = 'r' AND relname <> 'event_inbox' AND relname NOT LIKE 'g\_%' AND NOT (relrowsecurity AND relforcerowsecurity)), true, 'C11 check 2 / AC-0B-2.2 / AC-0B-2.4: every non-exempt anatomic table has ENABLE + FORCE (RLS is never off)');

-- C11 check 3: policy set per table (AC-0B-2.3): count, role, UPDATE only where the §7 loop marks u, staff guard, ::uuid[] cast, no DELETE policy
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'anatomic' AND tablename = rt.t), npol, 'C11 check 3 / AC-0B-2.3: anatomic.' || t || ' has ' || npol || ' policies') FROM rt;
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'anatomic' AND tablename <> 'event_inbox'), 86, 'C11 check 3: 86 policies in anatomic (ex event_inbox)');
SELECT is((SELECT array_agg(DISTINCT r) FROM pg_policies p, unnest(p.roles) r WHERE schemaname = 'anatomic' AND tablename <> 'event_inbox'), ARRAY['lims_app'::name], 'C11 check 3: every policy is TO lims_app only (no PUBLIC / anon / owner_only / lookup)');
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'anatomic' AND tablename = rt.t AND cmd = 'UPDATE'), CASE WHEN u THEN 1 ELSE 0 END, 'C11 check 3: UPDATE policy on anatomic.' || t || ' iff the §7 loop marks u (class A tables: none)') FROM rt;
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'anatomic' AND cmd = 'DELETE'), 0, 'C11 check 3 / §6: no DELETE policy on any anatomic table (counter included: never purged)');
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'anatomic' AND tablename <> 'event_inbox' AND NOT (coalesce(qual, '') || coalesce(with_check, '')) LIKE '%is_staff_or_system%'), 0, 'C11 check 3 / P-16: staff-actor guard in every anatomic policy (gate 9)');
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'anatomic' AND policyname LIKE '%\_\_tenant\_centre' AND (coalesce(qual, '') || coalesce(with_check, '')) NOT LIKE '%::uuid[]%'), 0, 'C11 check 3 / A16.1: centre policies carry the ::uuid[] cast');
SELECT is((SELECT array_agg(DISTINCT tablename::text ORDER BY tablename::text) FROM pg_policies WHERE schemaname = 'anatomic' AND policyname LIKE '%\_\_tenant\_centre'), (SELECT array_agg(t ORDER BY t) FROM rt WHERE centre), 'C11 check 3: centre scope exactly on the 16 centre tables (batches / batch_members are tenant-scoped, §7)');
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'anatomic' AND tablename <> 'event_inbox' AND (coalesce(qual, '') || coalesce(with_check, '')) NOT LIKE '%current_tenant_id%'), 0, 'C11 check 3: tenant predicate in every policy');

-- C11 check 4: grant matrix (AC-0B-4.2 / 4.3; §7 loops, §11 item 1: lims_app has no DELETE on any table)
SELECT is(has_table_privilege('lims_app', 'anatomic.' || t, 'SELECT'), true, 'C11 check 4: lims_app SELECT on anatomic.' || t) FROM rt;
SELECT is(has_table_privilege('lims_app', 'anatomic.' || t, 'INSERT'), i, 'C11 check 4 / AC-0B-4.2: lims_app INSERT on anatomic.' || t) FROM rt;
SELECT is(has_table_privilege('lims_app', 'anatomic.' || t, 'UPDATE'), u, 'C11 check 4 / AC-0B-4.1 / AC-0B-4.3: lims_app UPDATE on anatomic.' || t || ' (none on report_versions, item_submissions, case_transitions, object_movements)') FROM rt;
SELECT is(has_table_privilege('lims_app', 'anatomic.' || t, 'DELETE'), false, 'C11 check 4 / AC-0B-4.2 / §11 item 1: lims_app has no DELETE on anatomic.' || t) FROM (SELECT t FROM rt UNION ALL SELECT t FROM rg) x(t);
SELECT is(has_table_privilege('lims_app', 'anatomic.' || t, 'TRUNCATE') OR has_table_privilege('lims_app', 'anatomic.' || t, 'REFERENCES') OR has_table_privilege('lims_app', 'anatomic.' || t, 'TRIGGER'), false, 'C11 check 4: no TRUNCATE / REFERENCES / TRIGGER on anatomic.' || t) FROM rt;
SELECT is(ARRAY[has_table_privilege('lims_app', 'anatomic.' || t, 'SELECT'), has_table_privilege('lims_app', 'anatomic.' || t, 'INSERT'), has_table_privilege('lims_app', 'anatomic.' || t, 'UPDATE'), has_table_privilege('lims_app', 'anatomic.' || t, 'DELETE')], ARRAY[true, false, false, false], 'C11 check 4: lims_app only SELECTs ' || t) FROM rg;
SELECT is(has_table_privilege('lims_app', 'anatomic.v_pub_report_content', 'SELECT') AND has_table_privilege('lims_analytics', 'anatomic.v_pub_report_content', 'SELECT') AND NOT has_table_privilege('lims_app', 'anatomic.v_pub_report_content', 'INSERT, UPDATE, DELETE'), true, 'C11 check 4 / §8 GRANT: the view is SELECT-only for lims_app and lims_analytics');
SELECT is(has_table_privilege('lims_analytics', 'anatomic.' || x.t, p), false, 'C11 check 4: lims_analytics has no ' || p || ' on anatomic.' || x.t) FROM (SELECT t FROM rt UNION ALL SELECT t FROM rg) x, unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) p;
SELECT is((SELECT count(*)::int FROM information_schema.role_table_grants WHERE table_schema = 'anatomic' AND grantee IN ('PUBLIC','anon','authenticated','service_role')), 0, 'C11 check 4: nothing granted to PUBLIC / anon / authenticated / service_role');

-- C11 check 5: indexes (§4, §6) and constraint names: tenant_id leads every index (GIN trigram included); the 35 named indexes exist; every __p_ index is partial; UNIQUE (tenant_id, id) where the table has an id
SELECT is((regexp_match(pg_get_indexdef(i.indexrelid), '\(([^,)]+)'))[1], 'tenant_id', 'C11 check 5: index ' || c.relname || ' leads with tenant_id') FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_class t ON t.oid = i.indrelid
  WHERE t.relnamespace = 'anatomic'::regnamespace AND t.relname NOT LIKE 'g\_%' AND t.relname <> 'event_inbox' AND NOT i.indisprimary;
SELECT is((SELECT count(*)::int FROM pg_indexes WHERE schemaname = 'anatomic' AND indexname = n), 1, 'C11 check 5: index ' || n || ' exists (§6)')
  FROM unnest(ARRAY['cs_diagnoses__tenant_id_display__trgm_idx','synoptic_templates__tenant_id_key_published__p_uq','cases__tenant_id_accession_no__p_uq','cases__open_case__p_uq','cases__tenant_id_status_received__p_idx',
  'cases__tenant_id_received__idx','cases__tenant_id_accessioned__idx','cases__tenant_id_pathologist_status__idx','cases__tenant_id_order__idx','case_transitions__tenant_id_case__idx','case_items__tenant_id_case__idx',
  'parts__tenant_id_case__idx','parts__tenant_id_specimen__idx','blocks__tenant_id_case__idx','blocks__tenant_id_location__idx','stain_orders__tenant_id_case__idx','stain_orders__tenant_id_open__p_idx',
  'slides__tenant_id_block_seq__p_uq','slides__tenant_id_part_seq__p_uq','slides__tenant_id_case__idx','slides__tenant_id_pending__p_idx','object_movements__tenant_id_object__idx','images__tenant_id_case__idx',
  'report_drafts__tenant_id_case_open__p_uq','report_drafts__tenant_id_case_initial__p_uq','report_drafts__tenant_id_case__idx','addenda__tenant_id_case__idx','report_versions__tenant_id_case__idx',
  'item_submissions__tenant_id_lab_result__idx','item_submissions__tenant_id_case__idx','molecular_results__tenant_id_case_target__p_uq','molecular_results__tenant_id_case__idx','batches__tenant_id_status__idx',
  'batch_members__tenant_id_batch_position__p_uq','batch_members__tenant_id_batch_case__p_uq']) n;
SELECT is((SELECT count(*)::int FROM pg_indexes WHERE schemaname = 'anatomic' AND indexname ~ '__p_(uq|idx)$' AND indexdef NOT LIKE '% WHERE %'), 0, 'C11 check 5: every __p_ index is partial');
SELECT is((SELECT count(*)::int FROM pg_indexes WHERE schemaname = 'anatomic' AND indexname = 'cs_diagnoses__tenant_id_display__trgm_idx' AND indexdef LIKE '%gin_trgm_ops%'), 1, 'C11 check 5 / 08 A31.1: the diagnosis display index is a GIN trigram index');
SELECT is((SELECT count(*)::int FROM pg_constraint WHERE conrelid = ('anatomic.' || t)::regclass AND contype = 'u' AND conkey @> ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = ('anatomic.' || t)::regclass AND attname = 'tenant_id'), (SELECT attnum FROM pg_attribute WHERE attrelid = ('anatomic.' || t)::regclass AND attname = 'id')] AND cardinality(conkey) = 2), 1, 'C11 check 5: UNIQUE (tenant_id, id) on anatomic.' || t || ' (04 D8)') FROM rt
  WHERE t <> 'accession_counters';
SELECT is((SELECT count(*)::int FROM pg_constraint c JOIN pg_class r ON r.oid = c.conrelid WHERE r.relnamespace = 'anatomic'::regnamespace AND r.relkind = 'r' AND r.relname <> 'event_inbox' AND c.conname NOT LIKE r.relname || '\_\_%'), 0, 'C11 check 5: every constraint in anatomic is prefixed <table>__');
SELECT is((SELECT count(*)::int FROM pg_constraint WHERE conrelid = ('anatomic.' || t)::regclass AND conname = t || '__tenant__fk' AND contype = 'f'), 1, 'C11 check 5: ' || t || '__tenant__fk exists') FROM rt WHERE t LIKE 'cs\_%';
SELECT is((SELECT count(*)::int FROM pg_constraint WHERE conrelid = 'anatomic.accession_counters'::regclass AND contype = 'p' AND cardinality(conkey) = 3), 1, 'C11 check 5 / P-18(b): accession_counters PK is (tenant_id, series_key, year_ad), no id column');
SELECT is((SELECT count(*)::int FROM pg_attribute WHERE attrelid = 'anatomic.accession_counters'::regclass AND attname IN ('id','version','is_active','expires_at') AND NOT attisdropped), 0, 'C11 check 5 / §1: accession_counters has no id / version / is_active / expires_at');
SELECT is((SELECT count(*)::int FROM pg_constraint c WHERE c.contype = 'f' AND c.conrelid = ('anatomic.' || t)::regclass AND c.confrelid = 'anatomic.cases'::regclass AND cardinality(c.conkey) = 3), 1, 'C11 check 5 / §1 centre decision: composite FK (tenant_id, case_id, centre_id) -> cases on anatomic.' || t)
  FROM rt WHERE centre AND t <> 'cases';

-- C11 check 6: triggers, functions, audit (AC-0B-5.1, 5.3)
SELECT is((SELECT count(*)::int FROM pg_trigger tg WHERE tg.tgrelid = ('anatomic.' || t)::regclass AND NOT tg.tgisinternal AND tg.tgname = t || '__audit'), CASE WHEN aud THEN 1 ELSE 0 END, 'C11 check 6 / AC-0B-5.1: audit trigger on anatomic.' || t || ' iff §3 says audited (M and C tables)') FROM rt;
SELECT is((SELECT count(*)::int FROM pg_trigger tg WHERE tg.tgrelid = ('anatomic.' || t)::regclass AND tg.tgname = t || '__audit' AND tg.tgfoid = 'app.tg_row_audit'::regproc), CASE WHEN aud THEN 1 ELSE 0 END, 'C11 check 6: audit trigger of anatomic.' || t || ' runs app.tg_row_audit') FROM rt;
SELECT is((SELECT count(*)::int FROM pg_trigger tg WHERE tg.tgrelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'anatomic'::regnamespace) AND NOT tg.tgisinternal AND tg.tgname LIKE '%\_\_audit'), 25, 'C11 check 6: 25 audit triggers (11 M, 14 C)');
SELECT is((SELECT array_agg(tgname::text ORDER BY tgname::text) FROM pg_trigger WHERE tgrelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'anatomic'::regnamespace) AND NOT tgisinternal AND tgname NOT LIKE '%\_\_audit' AND tgname NOT LIKE '%event_inbox%'),
  ARRAY['addenda__guard','blocks__mutable_columns','cases__guard','images__mutable_columns','report_drafts__guard','slides__mutable_columns','synoptic_templates__guard'], 'C11 check 6: exactly the 7 spec triggers by name');
SELECT is((SELECT count(*)::int FROM pg_trigger WHERE tgrelid = ('anatomic.' || t)::regclass AND tgname = t || '__guard' AND (tgtype & 2) = 2 AND (tgtype & 16) = 16 AND (tgtype & 1) = 1), 1, 'C11 check 6: anatomic.' || t || ' guard is BEFORE UPDATE FOR EACH ROW')
  FROM unnest(ARRAY['synoptic_templates','cases','report_drafts','addenda']) t;
SELECT is((SELECT count(*)::int FROM pg_trigger WHERE tgrelid = ('anatomic.' || t)::regclass AND tgname = t || '__mutable_columns' AND tgfoid = 'app.enforce_mutable_columns'::regproc AND (tgtype & 2) = 2 AND (tgtype & 16) = 16), 1, 'C11 check 6: anatomic.' || t || ' mutable_columns is BEFORE UPDATE via app.enforce_mutable_columns')
  FROM unnest(ARRAY['blocks','slides','images']) t;
SELECT is((SELECT count(*)::int FROM pg_proc p WHERE p.pronamespace = 'anatomic'::regnamespace AND p.proname = f), 1, 'C11 check 6: anatomic.' || f || '() exists') FROM rf;
SELECT is((SELECT prosecdef FROM pg_proc WHERE pronamespace = 'anatomic'::regnamespace AND proname = f), false, 'C11 check 6 / AC-0B-4.1: anatomic.' || f || ' is SECURITY INVOKER (no DEFINER, no inventory row)') FROM rf;
SELECT is((SELECT proconfig FROM pg_proc WHERE pronamespace = 'anatomic'::regnamespace AND proname = f), ARRAY['search_path=""'], 'C11 check 6: anatomic.' || f || ' has search_path = empty') FROM rf;
SELECT is((SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE pronamespace = 'anatomic'::regnamespace AND proname = f), 'lims_owner', 'C11 check 6: anatomic.' || f || ' owned by lims_owner (AC-0B-6.3)') FROM rf;
SELECT is((SELECT count(*)::int FROM pg_proc WHERE pronamespace = 'anatomic'::regnamespace), 4, 'C11 check 6: no function in anatomic beyond the 4 guard functions');

-- C11 check 7: FK direction, no DEFINER, view, seed (AC-0B-6.1 / 6.2 / 6.3; REQ-SEC-031)
SELECT is((SELECT array_agg(DISTINCT n.nspname::text ORDER BY n.nspname::text) FROM pg_constraint c JOIN pg_class r ON r.oid = c.confrelid JOIN pg_namespace n ON n.oid = r.relnamespace WHERE c.contype = 'f' AND c.conrelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'anatomic'::regnamespace)),
  ARRAY['anatomic','core','frontdesk','lab'], 'C11 check 7 / AC-0B-6.2: anatomic FKs point into anatomic, core, frontdesk, lab only (01 §5 R3; no catalog FK, §1)');
SELECT is((SELECT count(*)::int FROM pg_constraint c JOIN pg_class r ON r.oid = c.confrelid WHERE c.contype = 'f' AND r.relnamespace = 'anatomic'::regnamespace AND c.conrelid NOT IN (SELECT oid FROM pg_class WHERE relnamespace = 'anatomic'::regnamespace)), 0, 'C11 check 7 / AC-0B-6.2: nothing references anatomic from another schema');
SELECT is((SELECT count(*)::int FROM pg_constraint c WHERE c.contype = 'f' AND c.conrelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'anatomic'::regnamespace AND relkind = 'r') AND c.confrelid IN (SELECT oid FROM pg_class WHERE relnamespace IN ('billing'::regnamespace, 'reporting'::regnamespace, 'analytics'::regnamespace, 'catalog'::regnamespace))), 0, 'C11 check 7: no FK into billing / reporting / analytics / catalog');
SELECT is((SELECT count(*)::int FROM pg_constraint c WHERE c.contype = 'f' AND c.conrelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'anatomic'::regnamespace AND relname NOT LIKE 'g\_%' AND relname <> 'event_inbox')
  AND cardinality(c.conkey) = 1 AND c.confrelid <> 'core.tenants'::regclass), 0, 'C11 check 7: every FK except the tenant FK is composite (tenant_id, x) (02-CV §5.4)');
SELECT is((SELECT count(*)::int FROM pg_proc WHERE pronamespace = 'anatomic'::regnamespace AND prosecdef), 0, 'C11 check 7: no SECURITY DEFINER function in anatomic');
SELECT has_view('anatomic', 'v_pub_report_content', 'C11 check 7: view anatomic.v_pub_report_content exists');
SELECT is((SELECT coalesce(c.reloptions @> ARRAY['security_invoker=true'] OR c.reloptions @> ARRAY['security_invoker=on'], false) FROM pg_class c WHERE c.oid = 'anatomic.v_pub_report_content'::regclass), true, 'C11 check 7 / §11 item 5 / REQ-SEC-031: anatomic.v_pub_report_content security_invoker = true');
SELECT columns_are('anatomic', 'v_pub_report_content', ARRAY['tenant_id','entity_id','version_no','order_item_id','accession_no','case_kind','gross_text','microscopy_text','impression_text','synoptic','images','signed_by_membership_id','signed_at',
  'version_kind','scope','change_reason_code','clinical_history_text','comment_text','specimen_parts','slides','ancillary','molecular','addenda','diagnosis_codes'], 'C11 check 7 / §11 item 5: exactly the 03-IC §6.8 + CR-C11-001 columns');
SELECT col_type_is('anatomic', 'v_pub_report_content', c, ty, 'C11 check 7: v_pub_report_content.' || c || ' is ' || ty)
  FROM (VALUES ('tenant_id','uuid'),('entity_id','uuid'),('version_no','integer'),('order_item_id','uuid'),('accession_no','text'),('case_kind','text'),('gross_text','text'),('microscopy_text','text'),('impression_text','text'),
    ('synoptic','jsonb'),('images','jsonb'),('signed_by_membership_id','uuid'),('signed_at','timestamp with time zone'),('version_kind','text'),('scope','text'),('change_reason_code','text'),('clinical_history_text','text'),
    ('comment_text','text'),('specimen_parts','jsonb'),('slides','jsonb'),('ancillary','jsonb'),('molecular','jsonb'),('addenda','jsonb'),('diagnosis_codes','jsonb')) x(c, ty);
SELECT is((SELECT count(*)::int FROM pg_class c WHERE c.relnamespace = 'anatomic'::regnamespace AND c.relkind = 'r' AND c.relname IN (SELECT t FROM rt)), 30, 'C11 check 7 / AC-0B-6.1: all 30 tenant tables exist after the migrations applied in order');
SELECT is((SELECT array_agg(code || ':' || display ORDER BY code) FROM anatomic.g_cs_cancel_reasons), ARRAY['duplicate_case:Duplicate case','entered_in_error:Entered in error','order_cancelled:Order cancelled','other:Other','specimen_not_received:Specimen not received'], 'C11 check 7 / §2.2: g_cs_cancel_reasons seeded with the 5 spec rows');
SELECT is((SELECT count(*)::int FROM anatomic.g_cs_cancel_reasons WHERE system = 'lims' AND system_version = '1' AND is_active), 5, 'C11 check 7 / §2.2: seeds carry system = lims, system_version = 1, active');
SELECT is((SELECT count(*)::int FROM anatomic.cs_diagnoses) + (SELECT count(*)::int FROM anatomic.cs_cytology_adequacy) + (SELECT count(*)::int FROM anatomic.cs_cancel_reasons) + (SELECT count(*)::int FROM anatomic.settings) + (SELECT count(*)::int FROM anatomic.stains), 0, 'C11 check 7 / §2.2-2.3: no seeded diagnoses / adequacy / tenant defaults (settings and the H&E stain are created lazily by the service)');
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'storage' AND policyname LIKE 'anatomic%'), 0, 'C11 check 7 / LD-54, §9: no storage.objects policy is created by SQL (only after SP-4)');

SELECT * FROM finish();
ROLLBACK;
