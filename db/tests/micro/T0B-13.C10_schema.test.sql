-- T0B-13.C10 schema suite: micro catalogue properties (C10 05-SCHEMA §1, §4, §5, §6, §8, §9, §10 items 2, 7, 12; AC-0B-2.1, 2.2, 2.3, 2.4, 3.6, 4.1, 4.2, 4.3, 5.1, 5.3, 6.1, 6.2, 6.3).
-- Pure pg_catalog assertions: no fixtures, no data written. One rolled-back transaction. RLS is never disabled.
-- Run from the repo root: pg_prove -d <db> db/tests/micro/T0B-13.C10_schema.test.sql   (pgTAP in schema `extensions`; migrations + seeds loaded; superuser)
-- Markers (the node test checks them): C10 check 1 inventory/owner/no sequences or enums, 2 RLS ENABLE+FORCE (G exempt), 3 policy set per table, 4 grant matrix, 5 indexes + constraint names, 6 triggers + functions + audit,
-- 7 FK direction, no DEFINER, views, seeds (AC-0B-6.1 / 6.2 / 6.3). Checks 8-16 are in T0B-13.C10_behaviour.test.sql.
-- Scope note (as T0B-10.C5..C8, T0B-13.C9): event_inbox is C0's (T0B-05) and is excluded from every count. lims_api / lims_worker INHERIT lims_app, so "no DELETE / no UPDATE" is asserted for lims_app only.
BEGIN;
SET search_path = extensions, public, pg_catalog;
SELECT * FROM no_plan();

-- t: table; i/u/d: lims_app whole-table INSERT / UPDATE / DELETE; npol: expected policies; aud: audit trigger expected (spec §1 "Audited (C0 trigger)")
CREATE TEMP TABLE rt(t, cls, centre, i, u, d, npol, aud) AS VALUES
  ('cs_organisms','M',false,true,true,false,3,true),('cs_organism_groups','M',false,true,true,false,3,true),('cs_antibiotics','M',false,true,true,false,3,true),
  ('cs_media','M',false,true,true,false,3,true),('cs_specimen_sites','M',false,true,true,false,3,true),('cs_growth_codes','M',false,true,true,false,3,true),
  ('cs_culture_outcomes','M',false,true,true,false,3,true),('cs_isolate_withdraw_reasons','M',false,true,true,false,3,true),('cs_culture_cancel_reasons','M',false,true,true,false,3,true),
  ('cs_record_ignore_reasons','M',false,true,true,false,3,true),('settings','M',false,true,true,false,3,true),('plating_protocols','M',false,true,true,false,3,true),
  ('plating_protocol_media','M',false,true,true,false,3,true),('plating_protocol_keys','M',false,true,true,false,3,true),('ast_panels','M',false,true,true,false,3,true),
  ('ast_panel_antibiotics','M',false,true,true,false,3,true),('instrument_vocab_maps','M',false,true,true,false,3,true),('instrument_ast_defaults','M',false,true,true,false,3,true),
  ('breakpoint_sets','M',false,true,true,false,3,true),('breakpoint_rows','A',false,true,false,false,2,false),('breakpoint_bands','A',false,true,false,false,2,false),
  ('breakpoint_import_issues','A',false,true,false,false,2,false),('cultures','C',true,true,true,false,3,true),('culture_transitions','A',true,true,false,false,2,false),
  ('culture_plates','C',true,true,true,false,3,true),('culture_observations','A',true,true,false,false,2,false),('isolates','C',true,true,true,false,3,true),
  ('ast_results','C',true,true,true,false,3,true),('report_versions','A',true,true,false,false,2,false),('instrument_records','E',true,true,true,true,4,true),
  ('specimen_isolate_counters','M',false,true,true,false,3,false);
CREATE TEMP TABLE rg(t) AS VALUES
  ('g_cs_organisms'),('g_cs_organism_groups'),('g_cs_antibiotics'),('g_cs_media'),
  ('g_cs_specimen_sites'),('g_cs_growth_codes'),('g_cs_culture_outcomes'),('g_cs_isolate_withdraw_reasons'),
  ('g_cs_culture_cancel_reasons'),('g_cs_record_ignore_reasons'),('g_cs_ast_interpretations'),('g_ast_category_restrictions');
CREATE TEMP TABLE rv(v) AS VALUES ('v_organisms'),('v_organism_groups'),('v_antibiotics'),('v_media'),('v_specimen_sites'),('v_growth_codes'),('v_culture_outcomes'),('v_isolate_withdraw_reasons'),
  ('v_culture_cancel_reasons'),('v_record_ignore_reasons'),('v_pub_report_content');
CREATE TEMP TABLE rf(f) AS VALUES ('tg_child_final_lock'),('cultures_guard'),('breakpoint_sets_guard');

-- C10 check 1: inventory, owner (AC-0B-1.2, AC-0B-6.3), schema privileges, no sequences / enums
SELECT is((SELECT count(*)::int FROM pg_class c WHERE c.relnamespace = 'micro'::regnamespace AND c.relkind IN ('r','p')), 31 + 12 + 1, 'C10 check 1: micro holds 31 tenant + 12 G tables + event_inbox (43 chunk tables)');
SELECT is((SELECT array_agg(c.relname::text ORDER BY c.relname) FROM pg_class c WHERE c.relnamespace = 'micro'::regnamespace AND c.relkind IN ('v','m')), (SELECT array_agg(v ORDER BY v) FROM rv), 'C10 check 1: the only views are the 10 internal v_<set> views and v_pub_report_content (no materialized view)');
SELECT is((SELECT count(*)::int FROM pg_class c WHERE c.relnamespace = 'micro'::regnamespace AND c.relkind = 'S'), 0, 'C10 check 1: no sequences');
SELECT is((SELECT count(*)::int FROM pg_type t WHERE t.typnamespace = 'micro'::regnamespace AND t.typtype = 'e'), 0, 'C10 check 1: no ENUM types');
SELECT is(pg_get_userbyid(c.relowner), 'lims_owner', 'C10 check 1: micro.' || c.relname || ' owned by lims_owner (AC-0B-1.2, AC-0B-6.3)') FROM pg_class c WHERE c.relnamespace = 'micro'::regnamespace AND c.relkind IN ('r','v');
SELECT is(has_schema_privilege('lims_app', 'micro', 'USAGE'), true, 'lims_app has USAGE on schema micro');
SELECT is(has_schema_privilege(r, 'micro', 'CREATE'), false, r || ' cannot CREATE in micro') FROM unnest(ARRAY['lims_app','lims_api','lims_worker','lims_analytics']) r;
SELECT is((SELECT count(*)::int FROM rt) + (SELECT count(*)::int FROM rg), 43, 'C10 check 1: 43 tables in the inventory (= table count of the 05-SCHEMA §8 DDL)');

-- C10 check 2: RLS ENABLE + FORCE on the 31 tenant tables, none on the 12 g_* tables (AC-0B-2.1, 2.4)
SELECT is((SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = ('micro.' || t)::regclass), true, 'C10 check 2 / AC-0B-2.1: ENABLE + FORCE RLS on micro.' || t) FROM rt;
SELECT is((SELECT relrowsecurity OR relforcerowsecurity FROM pg_class WHERE oid = ('micro.' || t)::regclass), false, 'C10 check 2 / AC-0B-2.1: micro.' || t || ' is RLS-exempt (global coded set, listed in rls_exempt.txt)') FROM rg;
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'micro' AND tablename = g.t), 0, 'C10 check 2: no policy on ' || g.t) FROM rg g;
SELECT is(NOT EXISTS (SELECT 1 FROM pg_class WHERE relnamespace = 'micro'::regnamespace AND relkind = 'r' AND relname <> 'event_inbox' AND relname NOT LIKE 'g\_%' AND NOT (relrowsecurity AND relforcerowsecurity)), true, 'C10 check 2 / AC-0B-2.2 / AC-0B-2.4: every non-exempt micro table has ENABLE + FORCE (RLS is never off)');

-- C10 check 3: policy set per table (AC-0B-2.3): count, role, UPDATE only where the §8 loop marks u, staff guard, ::uuid[] cast, single DELETE policy
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'micro' AND tablename = rt.t), npol, 'C10 check 3 / AC-0B-2.3: micro.' || t || ' has ' || npol || ' policies') FROM rt;
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'micro' AND tablename <> 'event_inbox'), 88, 'C10 check 3: 88 policies in micro (ex event_inbox)');
SELECT is((SELECT array_agg(DISTINCT r) FROM pg_policies p, unnest(p.roles) r WHERE schemaname = 'micro' AND tablename <> 'event_inbox'), ARRAY['lims_app'::name], 'C10 check 3: every policy is TO lims_app only (no PUBLIC / anon / owner_only / lookup)');
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'micro' AND tablename = rt.t AND cmd = 'UPDATE'), CASE WHEN u THEN 1 ELSE 0 END, 'C10 check 3: UPDATE policy on micro.' || t || ' iff the §8 loop marks u (A tables: none)') FROM rt;
-- T0B-GREEN-1 STALE: migration 20261105001000 (core__create_event_inboxes) adds event_inbox__delete__owner_only to every schema's event_inbox (purge by lims_owner); instrument_records__delete__tenant_centre stays the only DELETE policy of every other table and the inbox policy is pinned to lims_owner
SELECT is((SELECT array_agg(tablename::text || '.' || policyname::text) FROM pg_policies WHERE schemaname = 'micro' AND tablename <> 'event_inbox' AND cmd = 'DELETE'), ARRAY['instrument_records.instrument_records__delete__tenant_centre'], 'C10 check 3 / P-18(c), D-65: the only DELETE policy is instrument_records__delete__tenant_centre');
SELECT is((SELECT array_agg(policyname::text || '|' || roles::text) FROM pg_policies WHERE schemaname = 'micro' AND tablename = 'event_inbox' AND cmd = 'DELETE'), ARRAY['event_inbox__delete__owner_only|{lims_owner}'], 'C10 check 3 / T0B-GREEN-1: the event_inbox DELETE policy is the owner-only purge policy, TO lims_owner only');
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'micro' AND tablename <> 'event_inbox' AND NOT (coalesce(qual, '') || coalesce(with_check, '')) LIKE '%is_staff_or_system%'), 0, 'C10 check 3 / P-16: staff-actor guard in every micro policy (gate 9)');
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'micro' AND policyname LIKE '%\_\_tenant\_centre' AND cmd <> 'DELETE' AND (coalesce(qual, '') || coalesce(with_check, '')) NOT LIKE '%::uuid[]%'), 0, 'C10 check 3 / A16.1: centre policies carry the ::uuid[] cast');
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'micro' AND policyname LIKE '%\_\_tenant\_centre' AND cmd <> 'DELETE' AND (coalesce(qual, '') || coalesce(with_check, '')) NOT LIKE '%''user''%''system''%'), 0, 'C10 check 3 / review m#30: centre policies restrict the actor type to user / system (devices excluded)');
SELECT is((SELECT array_agg(DISTINCT tablename::text ORDER BY tablename::text) FROM pg_policies WHERE schemaname = 'micro' AND policyname LIKE '%\_\_tenant\_centre'),
  ARRAY['ast_results','culture_observations','culture_plates','culture_transitions','cultures','instrument_records','isolates','report_versions'], 'C10 check 3: centre scope exactly on the 8 centre tables (D-63)');
SELECT matches((SELECT qual FROM pg_policies WHERE schemaname = 'micro' AND policyname = 'instrument_records__delete__tenant_centre'), 'system.*expires_at < now\(\)', 'C10 check 3 / D-65: purge delete = system actor and expired rows only');

-- C10 check 4: grant matrix (AC-0B-4.2 / 4.3; §4, §8 loops, §10 item 2)
SELECT is(has_table_privilege('lims_app', 'micro.' || t, 'SELECT'), true, 'C10 check 4: lims_app SELECT on micro.' || t) FROM rt;
SELECT is(has_table_privilege('lims_app', 'micro.' || t, 'INSERT'), i, 'C10 check 4 / AC-0B-4.2: lims_app INSERT on micro.' || t) FROM rt;
SELECT is(has_table_privilege('lims_app', 'micro.' || t, 'UPDATE'), u, 'C10 check 4 / AC-0B-4.1 / AC-0B-4.3: lims_app UPDATE on micro.' || t || ' (none on report_versions, culture_observations, culture_transitions, breakpoint_rows / bands / import_issues)') FROM rt;
SELECT is(has_table_privilege('lims_app', 'micro.' || t, 'DELETE'), d, 'C10 check 4 / AC-0B-4.2: lims_app DELETE on micro.' || t || ' (instrument_records only, class E)') FROM rt;
SELECT is(has_table_privilege('lims_app', 'micro.' || t, 'TRUNCATE') OR has_table_privilege('lims_app', 'micro.' || t, 'REFERENCES') OR has_table_privilege('lims_app', 'micro.' || t, 'TRIGGER'), false, 'C10 check 4: no TRUNCATE / REFERENCES / TRIGGER on micro.' || t) FROM rt;
SELECT is(ARRAY[has_table_privilege('lims_app', 'micro.' || t, 'SELECT'), has_table_privilege('lims_app', 'micro.' || t, 'INSERT'), has_table_privilege('lims_app', 'micro.' || t, 'UPDATE'), has_table_privilege('lims_app', 'micro.' || t, 'DELETE')], ARRAY[true, false, false, false], 'C10 check 4: lims_app only SELECTs ' || t) FROM rg;
SELECT is(has_table_privilege('lims_app', 'micro.' || v, 'SELECT') AND NOT has_table_privilege('lims_app', 'micro.' || v, 'INSERT, UPDATE, DELETE'), true, 'C10 check 4: lims_app SELECT only on micro.' || v) FROM rv;
SELECT is(has_table_privilege('lims_analytics', 'micro.' || x.t, p), false, 'C10 check 4: lims_analytics has no ' || p || ' on micro.' || x.t) FROM (SELECT t FROM rt UNION ALL SELECT t FROM rg) x, unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) p;
SELECT is((SELECT count(*)::int FROM information_schema.role_table_grants WHERE table_schema = 'micro' AND grantee IN ('PUBLIC','anon','authenticated','service_role')), 0, 'C10 check 4: nothing granted to PUBLIC / anon / authenticated / service_role');

-- C10 check 5: indexes (§8, §9) and constraint names (§10 item 12): tenant_id leads every index; the 27 named indexes exist; every __p_ index is partial; UNIQUE (tenant_id, id) where the table has an id
SELECT is((regexp_match(pg_get_indexdef(i.indexrelid), '\(([^,)]+)'))[1], 'tenant_id', 'C10 check 5: index ' || c.relname || ' leads with tenant_id') FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_class t ON t.oid = i.indrelid
  WHERE t.relnamespace = 'micro'::regnamespace AND t.relname NOT LIKE 'g\_%' AND t.relname <> 'event_inbox' AND NOT i.indisprimary;
SELECT is((SELECT count(*)::int FROM pg_indexes WHERE schemaname = 'micro' AND indexname = n), 1, 'C10 check 5: index ' || n || ' exists (§8)')
  FROM unnest(ARRAY['plating_protocols__tenant_id_code__p_uq','plating_protocol_keys__tenant_id_key__p_uq','ast_panels__tenant_id_code__p_uq',
  'ast_panels__tenant_id_scope__p_idx','instrument_vocab_maps__tenant_id_key__p_uq','breakpoint_sets__tenant_id_standard_sha__p_uq',
  'breakpoint_sets__tenant_id_standard_effective__p_idx','breakpoint_sets__tenant_id_created__idx','breakpoint_rows__tenant_id_key__uq',
  'breakpoint_rows__tenant_id_lookup__idx','breakpoint_import_issues__tenant_id_set__idx','cultures__tenant_id_status_received__p_idx',
  'cultures__tenant_id_next_read__p_idx','cultures__tenant_id_specimen__idx','cultures__tenant_id_order__idx',
  'cultures__tenant_id_updated__idx','cultures__tenant_id_centre__idx','cultures__tenant_id_barcode__p_idx',
  'culture_transitions__tenant_id_culture__idx','culture_observations__tenant_id_culture__idx','isolates__tenant_id_culture__idx',
  'ast_results__tenant_id_culture__idx','report_versions__tenant_id_order_item__idx','instrument_records__tenant_id_open__p_idx',
  'instrument_records__tenant_id_culture__idx','instrument_records__tenant_id_barcode__p_idx','instrument_records__tenant_id_expires__p_idx']) n;
SELECT is((SELECT count(*)::int FROM pg_indexes WHERE schemaname = 'micro' AND indexname ~ '__p_(uq|idx)$' AND indexdef NOT LIKE '% WHERE %'), 0, 'C10 check 5: every __p_ index is partial');
SELECT is((SELECT count(*)::int FROM pg_constraint WHERE conrelid = ('micro.' || t)::regclass AND contype = 'u' AND conkey @> ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = ('micro.' || t)::regclass AND attname = 'tenant_id'), (SELECT attnum FROM pg_attribute WHERE attrelid = ('micro.' || t)::regclass AND attname = 'id')] AND cardinality(conkey) = 2), 1, 'C10 check 5: UNIQUE (tenant_id, id) on micro.' || t || ' (04 D8)') FROM rt
  WHERE EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = ('micro.' || t)::regclass AND attname = 'id' AND NOT attisdropped);
SELECT is((SELECT count(*)::int FROM pg_constraint c JOIN pg_class r ON r.oid = c.conrelid WHERE r.relnamespace = 'micro'::regnamespace AND r.relkind = 'r' AND r.relname <> 'event_inbox' AND c.conname NOT LIKE r.relname || '\_\_%'), 0, 'C10 check 5 / §10 item 12: every constraint in micro is prefixed <table>__');
SELECT is((SELECT count(*)::int FROM pg_constraint WHERE conrelid = ('micro.' || t)::regclass AND conname = t || '__tenant__fk' AND contype = 'f'), 1, 'C10 check 5 / §10 item 12: ' || t || '__tenant__fk exists') FROM rt WHERE t LIKE 'cs\_%';
SELECT is((SELECT count(*)::int FROM pg_constraint WHERE conrelid = 'micro.ast_results'::regclass AND conname = 'ast_results__category__fk' AND contype = 'f' AND confrelid = 'micro.g_cs_ast_interpretations'::regclass), 1, 'C10 check 5 / §10 item 4: ast_results__category__fk -> g_cs_ast_interpretations (standard, code)');

-- C10 check 6: triggers, functions, audit (AC-0B-5.1, 5.3)
SELECT is((SELECT count(*)::int FROM pg_trigger tg WHERE tg.tgrelid = ('micro.' || t)::regclass AND NOT tg.tgisinternal AND tg.tgname = t || '__audit'), CASE WHEN aud THEN 1 ELSE 0 END, 'C10 check 6 / AC-0B-5.1: audit trigger on micro.' || t || ' iff §1 says audited') FROM rt;
SELECT is((SELECT count(*)::int FROM pg_trigger tg WHERE tg.tgrelid = ('micro.' || t)::regclass AND tg.tgname = t || '__audit' AND tg.tgfoid = 'app.tg_row_audit'::regproc), CASE WHEN aud THEN 1 ELSE 0 END, 'C10 check 6: audit trigger of micro.' || t || ' runs app.tg_row_audit') FROM rt;
SELECT is((SELECT count(*)::int FROM pg_trigger tg WHERE tg.tgrelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'micro'::regnamespace) AND NOT tg.tgisinternal AND tg.tgname LIKE '%\_\_audit'), 24, 'C10 check 6: 24 audit triggers (19 M, 4 C, instrument_records)');
SELECT is((SELECT count(*)::int FROM pg_trigger WHERE tgrelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'micro'::regnamespace) AND NOT tgisinternal AND tgname NOT LIKE '%\_\_audit' AND tgname NOT LIKE '%event_inbox%'), 8, 'C10 check 6: exactly 8 guard triggers (2 mutable_columns, 4 final_lock, cultures_guard, breakpoint_sets_guard)');
SELECT is((SELECT array_agg(tgname::text ORDER BY tgname::text) FROM pg_trigger WHERE tgrelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'micro'::regnamespace) AND NOT tgisinternal AND (tgname LIKE '%\_\_final\_lock' OR tgname LIKE '%\_\_mutable\_columns')),
  ARRAY['ast_results__final_lock','breakpoint_sets__mutable_columns','culture_observations__final_lock','culture_plates__final_lock','cultures__mutable_columns','isolates__final_lock'], 'C10 check 6: the 6 spec triggers by name');
SELECT is((SELECT (tgtype & 2) = 2 AND (tgtype & 16) = 16 AND (tgtype & 1) = 1 FROM pg_trigger WHERE tgrelid = 'micro.cultures'::regclass AND tgfoid = 'micro.cultures_guard'::regproc), true, 'C10 check 6: cultures guard is BEFORE UPDATE FOR EACH ROW');
SELECT is((SELECT (tgtype & 2) = 2 AND (tgtype & 16) = 16 AND (tgtype & 1) = 1 FROM pg_trigger WHERE tgrelid = 'micro.breakpoint_sets'::regclass AND tgfoid = 'micro.breakpoint_sets_guard'::regproc), true, 'C10 check 6: breakpoint_sets guard is BEFORE UPDATE FOR EACH ROW');
SELECT is((SELECT count(*)::int FROM pg_trigger WHERE tgrelid IN ('micro.culture_plates'::regclass, 'micro.isolates'::regclass, 'micro.ast_results'::regclass) AND tgname LIKE '%\_\_final\_lock' AND (tgtype & 2) = 2 AND (tgtype & 4) = 4 AND (tgtype & 16) = 16), 3, 'C10 check 6: plates / isolates / ast_results final locks fire BEFORE INSERT OR UPDATE');
SELECT is((SELECT (tgtype & 2) = 2 AND (tgtype & 4) = 4 AND (tgtype & 16) = 0 FROM pg_trigger WHERE tgrelid = 'micro.culture_observations'::regclass AND tgname = 'culture_observations__final_lock'), true, 'C10 check 6: culture_observations final lock fires BEFORE INSERT only');
SELECT is((SELECT count(*)::int FROM pg_proc p WHERE p.pronamespace = 'micro'::regnamespace AND p.proname = f), 1, 'C10 check 6: micro.' || f || '() exists') FROM rf;
SELECT is((SELECT prosecdef FROM pg_proc WHERE pronamespace = 'micro'::regnamespace AND proname = f), false, 'C10 check 6 / AC-0B-4.1: micro.' || f || ' is SECURITY INVOKER (no DEFINER, no inventory row)') FROM rf;
SELECT is((SELECT proconfig FROM pg_proc WHERE pronamespace = 'micro'::regnamespace AND proname = f), ARRAY['search_path=""'], 'C10 check 6: micro.' || f || ' has search_path = empty') FROM rf;
SELECT is((SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE pronamespace = 'micro'::regnamespace AND proname = f), 'lims_owner', 'C10 check 6: micro.' || f || ' owned by lims_owner (AC-0B-6.3)') FROM rf;
SELECT is((SELECT count(*)::int FROM pg_proc WHERE pronamespace = 'micro'::regnamespace), 3, 'C10 check 6: no function in micro beyond the 3 trigger functions (purge is a worker task, not a function)');

-- C10 check 7: FK direction, no DEFINER, views, seeds (AC-0B-6.1 / 6.2 / 6.3; REQ-SEC-031)
SELECT is((SELECT array_agg(DISTINCT n.nspname::text ORDER BY n.nspname::text) FROM pg_constraint c JOIN pg_class r ON r.oid = c.confrelid JOIN pg_namespace n ON n.oid = r.relnamespace WHERE c.contype = 'f' AND c.conrelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'micro'::regnamespace)),
  ARRAY['catalog','core','frontdesk','instruments','lab','micro'], 'C10 check 7 / AC-0B-6.2: micro FKs point into micro, core, catalog, frontdesk, lab, instruments only (01 §5 R3)');
SELECT is((SELECT count(*)::int FROM pg_constraint c JOIN pg_class r ON r.oid = c.confrelid WHERE c.contype = 'f' AND r.relnamespace = 'micro'::regnamespace AND c.conrelid NOT IN (SELECT oid FROM pg_class WHERE relnamespace = 'micro'::regnamespace)), 0, 'C10 check 7 / AC-0B-6.2: nothing references micro from another schema');
SELECT is((SELECT count(*)::int FROM pg_constraint c WHERE c.contype = 'f' AND c.conrelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'micro'::regnamespace AND relkind = 'r') AND c.confrelid IN (SELECT oid FROM pg_class WHERE relnamespace IN ('billing'::regnamespace, 'reporting'::regnamespace, 'analytics'::regnamespace, 'quality'::regnamespace))), 0, 'C10 check 7: no FK into billing / reporting / analytics / quality');
SELECT is((SELECT count(*)::int FROM pg_constraint c WHERE c.contype = 'f' AND c.conrelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'micro'::regnamespace AND relname NOT LIKE 'g\_%' AND relname <> 'event_inbox')
  AND cardinality(c.conkey) = 1 AND c.confrelid <> 'core.tenants'::regclass), 0, 'C10 check 7: every FK except the tenant FK is composite (tenant_id, x) (02-CV §5.4)');
SELECT is((SELECT count(*)::int FROM pg_proc WHERE pronamespace = 'micro'::regnamespace AND prosecdef), 0, 'C10 check 7: no SECURITY DEFINER function in micro');
SELECT has_view('micro', v, 'C10 check 7: view micro.' || v || ' exists') FROM rv;
SELECT is((SELECT coalesce(c.reloptions @> ARRAY['security_invoker=true'] OR c.reloptions @> ARRAY['security_invoker=on'], false) FROM pg_class c WHERE c.oid = ('micro.' || v)::regclass), true, 'C10 check 7 / §10 item 7 / REQ-SEC-031: micro.' || v || ' security_invoker = true') FROM rv;
SELECT columns_are('micro', 'v_pub_report_content', ARRAY['tenant_id','entity_id','version_no','order_item_id','report_phase','culture_summary_text','isolates','ast','comments_text','signed_by_membership_id','signed_at'], 'C10 check 7 / §10 item 7: exactly the 03-IC §6.8 columns');
SELECT col_type_is('micro', 'v_pub_report_content', c, ty, 'C10 check 7: v_pub_report_content.' || c || ' is ' || ty)
  FROM (VALUES ('tenant_id','uuid'),('entity_id','uuid'),('version_no','integer'),('order_item_id','uuid'),('report_phase','text'),('culture_summary_text','text'),('isolates','jsonb'),('ast','jsonb'),('comments_text','text'),
    ('signed_by_membership_id','uuid'),('signed_at','timestamp with time zone')) x(c, ty);
SELECT is((SELECT array_agg(a.attname::text ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid = 'micro.v_organisms'::regclass AND a.attnum > 0 AND NOT a.attisdropped),
  ARRAY['code','display','sort_order','is_active','organism_group_code','gram_class','is_alert','snomed_ct_concept_id','source'], 'C10 check 7 / §3.3: v_organisms columns');
SELECT is((SELECT array_agg(a.attname::text ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid = 'micro.v_culture_outcomes'::regclass AND a.attnum > 0 AND NOT a.attisdropped),
  ARRAY['code','display','sort_order','is_active','result_flag','requires_isolate','source'], 'C10 check 7 / §3.3: v_culture_outcomes columns');
SELECT is((SELECT count(*)::int FROM pg_class c WHERE c.relnamespace = 'micro'::regnamespace AND c.relkind = 'r' AND c.relname IN (SELECT t FROM rt)), 31, 'C10 check 7 / AC-0B-6.1: all 31 tenant tables exist after the migrations applied in order');
SELECT is((SELECT count(*)::int FROM micro.g_cs_ast_interpretations), 11, 'C10 check 7: g_cs_ast_interpretations seeded (CLSI 6 + EUCAST 3 + ECOFF 2)');
SELECT is((SELECT count(*)::int FROM micro.g_ast_category_restrictions WHERE standard = 'CLSI' AND antibiotic_code IN ('colistin','polymyxin_b') AND allowed_codes @> ARRAY['I','R'] AND cardinality(allowed_codes) = 2), 2, 'C10 check 7 / 04 D14: CLSI colistin + polymyxin B restricted to I, R');
SELECT is((SELECT count(*)::int FROM micro.g_ast_category_restrictions), 2, 'C10 check 7: g_ast_category_restrictions seeded (2)');
SELECT is((SELECT count(*)::int FROM micro.g_cs_organism_groups), 8, 'C10 check 7 / §3.2: 8 organism groups');
SELECT is((SELECT count(*)::int FROM micro.g_cs_organisms), 10, 'C10 check 7 / §3.2: 10 organisms');
SELECT is((SELECT count(*)::int FROM micro.g_cs_antibiotics), 20, 'C10 check 7 / §3.2: 20 antibiotics');
SELECT is((SELECT count(*)::int FROM micro.g_cs_media), 6, 'C10 check 7 / §3.2: 6 media');
SELECT is((SELECT count(*)::int FROM micro.g_cs_specimen_sites), 8, 'C10 check 7 / §3.2: 8 specimen sites');
SELECT is((SELECT count(*)::int FROM micro.g_cs_growth_codes), 5, 'C10 check 7 / §3.2: 5 growth codes');
SELECT is((SELECT count(*)::int FROM micro.g_cs_culture_outcomes), 4, 'C10 check 7 / §3.2: 4 culture outcomes');
SELECT is((SELECT count(*)::int FROM micro.g_cs_isolate_withdraw_reasons), 4, 'C10 check 7 / §3.2: 4 isolate withdraw reasons');
SELECT is((SELECT count(*)::int FROM micro.g_cs_culture_cancel_reasons), 4, 'C10 check 7 / §3.2: 4 culture cancel reasons');
SELECT is((SELECT count(*)::int FROM micro.g_cs_record_ignore_reasons), 5, 'C10 check 7 / §3.2: 5 record ignore reasons');
SELECT is((SELECT count(*)::int FROM micro.g_cs_organisms WHERE is_alert OR snomed_ct_concept_id IS NOT NULL), 0, 'C10 check 7 / §3.2: no seeded organism is an alert or carries a SNOMED code');
SELECT is((SELECT count(*)::int FROM micro.breakpoint_rows) + (SELECT count(*)::int FROM micro.breakpoint_bands) + (SELECT count(*)::int FROM micro.breakpoint_sets), 0, 'C10 check 7 / §3.2: no seeded breakpoint content');

SELECT * FROM finish();
ROLLBACK;
