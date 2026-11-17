-- T0B-13.C9 schema suite: quality catalogue properties (C9 05-SCHEMA §1, §3, §4, §5, §6, §8; AC-0B-2.1, 2.2, 2.3, 2.4, 3.6, 4.1, 4.2, 4.3, 5.1, 5.3, 6.1, 6.2, 6.3).
-- Pure pg_catalog assertions: no fixtures, no data written. One rolled-back transaction. RLS is never disabled.
-- Run from the repo root: pg_prove -d <db> db/tests/quality/T0B-13.C9_schema.test.sql   (pgTAP in schema `extensions`; migrations + seeds loaded; superuser)
-- Markers (the node test checks them): C9 check 1 inventory/owner/no sequences or enums, 2 RLS ENABLE+FORCE (G exempt), 3 policy set per table, 4 grant matrix, 5 indexes, 6 triggers + functions + audit,
-- 7 FK direction, no DEFINER, view properties (AC-0B-6.1 / 6.2 / 6.3). Checks 8-16 are in T0B-13.C9_behaviour.test.sql.
-- Scope note (as T0B-10.C5..C8): event_inbox is C0's (T0B-05) and is excluded from every count. lims_api / lims_worker INHERIT lims_app, so "no DELETE / no UPDATE" is asserted for lims_app only.
BEGIN;
SET search_path = extensions, public, pg_catalog;
SELECT * FROM no_plan();

-- t: table; i/u/d: lims_app whole-table INSERT / UPDATE / DELETE; npol: expected policies; aud: audit trigger expected (C0 §3.8 default: class M and C)
CREATE TEMP TABLE rt(t, cls, centre, i, u, d, npol, aud) AS VALUES
  ('settings','M',false,true,true,false,3,true),('cs_corrective_actions','M',false,true,true,false,3,true),('cs_exclusion_reasons','M',false,true,true,false,3,true),('control_materials','M',false,true,true,false,3,true),
  ('control_levels','M',false,true,true,false,3,true),('control_lots','M',false,true,true,false,3,true),('control_id_maps','M',false,true,true,false,3,true),('qc_plans','M',false,true,true,false,3,true),
  ('qc_plan_versions','M',false,true,false,false,2,true),('qc_targets','M',false,true,true,false,3,true),('qc_runs','C',false,true,true,false,3,true),('qc_observations','C',false,true,true,false,3,true),
  ('qc_corrective_actions','A',false,true,false,false,2,false),('qc_run_reviews','A',false,true,false,false,2,false),('qc_activity','E',false,true,true,false,3,false),('sync_state','E',false,true,true,false,3,false),
  ('autoverify_rule_sets','M',false,true,true,false,3,true),('autoverify_versions','M',false,true,true,false,3,true),('autoverify_decisions','A',false,true,false,false,2,false),('verification_log','A',false,true,false,false,2,false),
  ('tat_items','E',true,true,true,true,4,false),('tat_alert_events','A',true,true,false,false,2,false),('tat_alert_acks','A',true,true,false,false,2,false);
CREATE TEMP TABLE rg(t) AS VALUES ('g_cs_corrective_actions'),('g_cs_exclusion_reasons');
CREATE TEMP TABLE rf(f) AS VALUES ('enforce_version_frozen'),('enforce_run_frozen'),('enforce_observation_exclusion');

-- C9 check 1: inventory, owner (AC-0B-1.2, AC-0B-6.3), schema privileges, no sequences / enums
SELECT is((SELECT count(*)::int FROM pg_class c WHERE c.relnamespace = 'quality'::regnamespace AND c.relkind IN ('r','p')), 23 + 2 + 1, 'C9 check 1: quality holds 23 tenant + 2 G tables + event_inbox (25 chunk tables)');
SELECT is((SELECT array_agg(c.relname::text ORDER BY c.relname) FROM pg_class c WHERE c.relnamespace = 'quality'::regnamespace AND c.relkind IN ('v','m')), ARRAY['v_pub_qc_summary'], 'C9 check 1: the only view is v_pub_qc_summary');
SELECT is((SELECT count(*)::int FROM pg_class c WHERE c.relnamespace = 'quality'::regnamespace AND c.relkind = 'S'), 0, 'C9 check 1: no sequences');
SELECT is((SELECT count(*)::int FROM pg_type t WHERE t.typnamespace = 'quality'::regnamespace AND t.typtype = 'e'), 0, 'C9 check 1: no ENUM types');
SELECT is(pg_get_userbyid(c.relowner), 'lims_owner', 'C9 check 1: quality.' || c.relname || ' owned by lims_owner (AC-0B-1.2, AC-0B-6.3)') FROM pg_class c WHERE c.relnamespace = 'quality'::regnamespace AND c.relkind IN ('r','v');
SELECT is(has_schema_privilege('lims_app', 'quality', 'USAGE'), true, 'lims_app has USAGE on schema quality');
SELECT is(has_schema_privilege(r, 'quality', 'CREATE'), false, r || ' cannot CREATE in quality') FROM unnest(ARRAY['lims_app','lims_api','lims_worker','lims_analytics']) r;
SELECT is((SELECT count(*)::int FROM rt) + (SELECT count(*)::int FROM rg), 25, 'C9 check 1: 25 tables in the inventory (= table count of the 05-SCHEMA §8 DDL)');

-- C9 check 2: RLS ENABLE + FORCE on the 23 tenant tables, none on the g_cs_* tables (AC-0B-2.1, 2.4)
SELECT is((SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = ('quality.' || t)::regclass), true, 'C9 check 2 / AC-0B-2.1: ENABLE + FORCE RLS on quality.' || t) FROM rt;
SELECT is((SELECT relrowsecurity OR relforcerowsecurity FROM pg_class WHERE oid = ('quality.' || t)::regclass), false, 'C9 check 2 / AC-0B-2.1: quality.' || t || ' is RLS-exempt (global coded set, listed in rls_exempt.txt)') FROM rg;
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'quality' AND tablename = g.t), 0, 'C9 check 2: no policy on ' || g.t) FROM rg g;
SELECT is(NOT EXISTS (SELECT 1 FROM pg_class WHERE relnamespace = 'quality'::regnamespace AND relkind = 'r' AND relname <> 'event_inbox' AND relname NOT LIKE 'g\_cs\_%' AND NOT (relrowsecurity AND relforcerowsecurity)), true, 'C9 check 2 / AC-0B-2.2 / AC-0B-2.4: every non-exempt quality table has ENABLE + FORCE (RLS is never off)');

-- C9 check 3: policy set per table (AC-0B-2.3): count, role, UPDATE only where §5 allows, staff guard, ::uuid[] cast, single DELETE policy
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'quality' AND tablename = rt.t), npol, 'C9 check 3 / AC-0B-2.3: quality.' || t || ' has ' || npol || ' policies') FROM rt;
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'quality' AND tablename <> 'event_inbox'), 63, 'C9 check 3: 63 policies in quality (ex event_inbox)');
SELECT is((SELECT array_agg(DISTINCT r) FROM pg_policies p, unnest(p.roles) r WHERE schemaname = 'quality' AND tablename <> 'event_inbox'), ARRAY['lims_app'::name], 'C9 check 3: every policy is TO lims_app only (no PUBLIC / anon / owner_only / lookup)');
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'quality' AND tablename = rt.t AND cmd = 'UPDATE'), CASE WHEN u THEN 1 ELSE 0 END, 'C9 check 3: UPDATE policy on quality.' || t || ' iff §5 allows UPDATE (A tables and qc_plan_versions: none)') FROM rt;
-- T0B-GREEN-1 STALE: migration 20261105001000 (core__create_event_inboxes) adds event_inbox__delete__owner_only to every schema's event_inbox (purge by lims_owner); tat_items__delete__tenant stays the only DELETE policy of every other table and the inbox policy is pinned to lims_owner
SELECT is((SELECT array_agg(tablename::text || '.' || policyname::text) FROM pg_policies WHERE schemaname = 'quality' AND tablename <> 'event_inbox' AND cmd = 'DELETE'), ARRAY['tat_items.tat_items__delete__tenant'], 'C9 check 3 / P-18(c): the only DELETE policy is tat_items__delete__tenant');
SELECT is((SELECT array_agg(policyname::text || '|' || roles::text) FROM pg_policies WHERE schemaname = 'quality' AND tablename = 'event_inbox' AND cmd = 'DELETE'), ARRAY['event_inbox__delete__owner_only|{lims_owner}'], 'C9 check 3 / T0B-GREEN-1: the event_inbox DELETE policy is the owner-only purge policy, TO lims_owner only');
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'quality' AND tablename <> 'event_inbox' AND cmd <> 'DELETE' AND NOT (coalesce(qual, '') || coalesce(with_check, '')) LIKE '%is_staff_or_system%'), 0, 'C9 check 3 / P-16: staff-actor guard in every SELECT / INSERT / UPDATE policy');
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'quality' AND policyname LIKE '%\_\_tenant\_centre' AND (coalesce(qual, '') || coalesce(with_check, '')) NOT LIKE '%::uuid[]%'), 0, 'C9 check 3 / A16.1: centre policies carry the ::uuid[] cast');
SELECT is((SELECT array_agg(DISTINCT tablename::text ORDER BY tablename::text) FROM pg_policies WHERE schemaname = 'quality' AND policyname LIKE '%\_\_tenant\_centre'), ARRAY['tat_alert_acks','tat_alert_events','tat_items'], 'C9 check 3: centre scope exactly on the three tat_* tables');
SELECT matches((SELECT qual FROM pg_policies WHERE schemaname = 'quality' AND policyname = 'tat_items__delete__tenant'), 'system.*expires_at < now\(\)', 'C9 check 3 / P-18(c): purge delete = system actor and expired rows only');

-- C9 check 4: grant matrix (AC-0B-4.2 / 4.3; §5 grants paragraph)
SELECT is(has_table_privilege('lims_app', 'quality.' || t, 'SELECT'), true, 'C9 check 4: lims_app SELECT on quality.' || t) FROM rt;
SELECT is(has_table_privilege('lims_app', 'quality.' || t, 'INSERT'), i, 'C9 check 4 / AC-0B-4.2: lims_app INSERT on quality.' || t) FROM rt;
SELECT is(has_table_privilege('lims_app', 'quality.' || t, 'UPDATE'), u, 'C9 check 4 / AC-0B-4.1: lims_app UPDATE on quality.' || t || ' (none on A tables and qc_plan_versions)') FROM rt;
SELECT is(has_table_privilege('lims_app', 'quality.' || t, 'DELETE'), d, 'C9 check 4 / AC-0B-4.3: lims_app DELETE on quality.' || t || ' (tat_items only)') FROM rt;
SELECT is(has_table_privilege('lims_app', 'quality.' || t, 'TRUNCATE') OR has_table_privilege('lims_app', 'quality.' || t, 'REFERENCES') OR has_table_privilege('lims_app', 'quality.' || t, 'TRIGGER'), false, 'C9 check 4: no TRUNCATE / REFERENCES / TRIGGER on quality.' || t) FROM rt;
SELECT is(ARRAY[has_table_privilege('lims_app', 'quality.' || t, 'SELECT'), has_table_privilege('lims_app', 'quality.' || t, 'INSERT'), has_table_privilege('lims_app', 'quality.' || t, 'UPDATE'), has_table_privilege('lims_app', 'quality.' || t, 'DELETE')], ARRAY[true, false, false, false], 'C9 check 4: lims_app only SELECTs ' || t) FROM rg;
SELECT is(has_table_privilege('lims_app', 'quality.v_pub_qc_summary', 'SELECT') AND NOT has_table_privilege('lims_app', 'quality.v_pub_qc_summary', 'INSERT, UPDATE, DELETE'), true, 'C9 check 4: lims_app SELECT only on v_pub_qc_summary');
SELECT is(has_table_privilege('lims_analytics', 'quality.' || x.t, p), false, 'C9 check 4: lims_analytics has no ' || p || ' on quality.' || x.t) FROM (SELECT t FROM rt UNION ALL SELECT t FROM rg) x, unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) p;
SELECT is((SELECT count(*)::int FROM information_schema.role_table_grants WHERE table_schema = 'quality' AND grantee IN ('PUBLIC','anon','authenticated','service_role')), 0, 'C9 check 4: nothing granted to PUBLIC / anon / authenticated / service_role');

-- C9 check 5: indexes (§3): tenant_id leads every index; the named indexes exist; every __p_ index is partial; UNIQUE (tenant_id, id)
SELECT is((regexp_match(pg_get_indexdef(i.indexrelid), '\(([^,)]+)'))[1], 'tenant_id', 'C9 check 5: index ' || c.relname || ' leads with tenant_id') FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_class t ON t.oid = i.indrelid
  WHERE t.relnamespace = 'quality'::regnamespace AND t.relname NOT LIKE 'g\_cs\_%' AND t.relname <> 'event_inbox' AND NOT i.indisprimary;
SELECT is((SELECT count(*)::int FROM pg_indexes WHERE schemaname = 'quality' AND indexname = n), 1, 'C9 check 5: index ' || n || ' exists (§3)')
  FROM unnest(ARRAY['qc_plans__tenant_instrument_analyte__uq','qc_runs__tenant_plan_collecting__p_uq','qc_runs__tenant_plan_runat__idx','qc_runs__tenant_plan_open_rejected__p_idx','qc_runs__tenant_collecting_assembled__p_idx','qc_runs__tenant_runat__idx',
    'qc_observations__tenant_source__uq','qc_observations__tenant_plan_observed__idx','qc_observations__tenant_run__idx','qc_observations__tenant_status_observed__p_idx','control_id_maps__tenant_key__p_uq','control_id_maps__tenant_instrument__idx',
    'qc_targets__tenant_plan_lot_from__idx','qc_targets__tenant_plan_lot_active__p_uq','autoverify_decisions__tenant_result__idx','autoverify_decisions__tenant_version_mode_time__idx','autoverify_decisions__tenant_time__idx',
    'verification_log__tenant_result_version__uq','tat_items__tenant_item_test__uq','tat_items__tenant_running__p_idx','tat_items__tenant_open_alerts__p_idx','tat_items__tenant_order__idx','tat_items__tenant_expires__idx',
    'autoverify_versions__tenant_active__p_uq','autoverify_versions__tenant_simulating__p_uq']) n;
SELECT is((SELECT count(*)::int FROM pg_indexes WHERE schemaname = 'quality' AND indexname ~ '__p_(uq|idx)$' AND indexdef NOT LIKE '% WHERE %'), 0, 'C9 check 5: every __p_ index is partial');
SELECT is((SELECT count(*)::int FROM pg_constraint WHERE conrelid = ('quality.' || t)::regclass AND contype = 'u' AND conkey @> ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = ('quality.' || t)::regclass AND attname = 'tenant_id'), (SELECT attnum FROM pg_attribute WHERE attrelid = ('quality.' || t)::regclass AND attname = 'id')] AND cardinality(conkey) = 2), 1, 'C9 check 5: UNIQUE (tenant_id, id) on quality.' || t || ' (04 D8)') FROM rt;

-- C9 check 6: triggers, functions, audit (AC-0B-5.1, 5.3)
SELECT is((SELECT count(*)::int FROM pg_trigger tg WHERE tg.tgrelid = ('quality.' || t)::regclass AND NOT tg.tgisinternal AND tg.tgname = t || '__audit'), CASE WHEN aud THEN 1 ELSE 0 END, 'C9 check 6 / AC-0B-5.1: audit trigger on quality.' || t || ' iff class M/C (C0 §3.8 default)') FROM rt;
SELECT is((SELECT count(*)::int FROM pg_trigger tg WHERE tg.tgrelid = ('quality.' || t)::regclass AND tg.tgname = t || '__audit' AND tg.tgfoid = 'app.tg_row_audit'::regproc), CASE WHEN aud THEN 1 ELSE 0 END, 'C9 check 6: audit trigger of quality.' || t || ' runs app.tg_row_audit') FROM rt;
SELECT is((SELECT array_agg(tgname::text ORDER BY tgname::text) FROM pg_trigger WHERE tgrelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'quality'::regnamespace) AND NOT tgisinternal AND tgname NOT LIKE '%\_\_audit' AND tgname NOT LIKE '%event_inbox%'),
  ARRAY['autoverify_versions__frozen','qc_observations__exclusion','qc_observations__mutable_columns','qc_runs__frozen','qc_targets__mutable_columns'], 'C9 check 6: exactly the 5 guard triggers');
SELECT is((SELECT count(*)::int FROM pg_trigger tg WHERE tg.tgrelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'quality'::regnamespace) AND NOT tg.tgisinternal AND tg.tgname LIKE '%\_\_audit'), 14, 'C9 check 6: 14 audit triggers (12 M + 2 C)');
SELECT is((SELECT (tgtype & 2) = 2 AND (tgtype & 16) = 16 AND (tgtype & 1) = 1 FROM pg_trigger WHERE tgrelid = 'quality.qc_runs'::regclass AND tgname = 'qc_runs__frozen'), true, 'C9 check 6: qc_runs__frozen is BEFORE UPDATE FOR EACH ROW');
SELECT is((SELECT count(*)::int FROM pg_proc p WHERE p.pronamespace = 'quality'::regnamespace AND p.proname = f), 1, 'C9 check 6: quality.' || f || '() exists') FROM rf;
SELECT is((SELECT prosecdef FROM pg_proc WHERE pronamespace = 'quality'::regnamespace AND proname = f), false, 'C9 check 6 / AC-0B-4.1: quality.' || f || ' is SECURITY INVOKER (no DEFINER, no inventory row)') FROM rf;
SELECT is((SELECT proconfig FROM pg_proc WHERE pronamespace = 'quality'::regnamespace AND proname = f), ARRAY['search_path=""'], 'C9 check 6: quality.' || f || ' has search_path = empty') FROM rf;
SELECT is((SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE pronamespace = 'quality'::regnamespace AND proname = f), 'lims_owner', 'C9 check 6: quality.' || f || ' owned by lims_owner (AC-0B-6.3)') FROM rf;
SELECT is((SELECT count(*)::int FROM pg_proc WHERE pronamespace = 'quality'::regnamespace), 3, 'C9 check 6: no function in quality beyond the 3 trigger functions');

-- C9 check 7: FK direction, no DEFINER, view (AC-0B-6.1 / 6.2 / 6.3; REQ-SEC-031)
SELECT is((SELECT array_agg(DISTINCT n.nspname::text ORDER BY n.nspname::text) FROM pg_constraint c JOIN pg_class r ON r.oid = c.confrelid JOIN pg_namespace n ON n.oid = r.relnamespace WHERE c.contype = 'f' AND c.conrelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'quality'::regnamespace)),
  ARRAY['catalog','core','frontdesk','instruments','lab','quality'], 'C9 check 7 / AC-0B-6.2: quality FKs point into quality, core, catalog, frontdesk, lab, instruments only (01 §5 R3)');
SELECT is((SELECT count(*)::int FROM pg_constraint c JOIN pg_class r ON r.oid = c.confrelid WHERE c.contype = 'f' AND r.relnamespace = 'quality'::regnamespace AND c.conrelid NOT IN (SELECT oid FROM pg_class WHERE relnamespace = 'quality'::regnamespace)), 0, 'C9 check 7 / AC-0B-6.2: nothing references quality from another schema');
SELECT is((SELECT count(*)::int FROM pg_constraint c WHERE c.contype = 'f' AND c.conrelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'quality'::regnamespace AND relkind = 'r') AND c.confrelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'billing'::regnamespace)), 0, 'C9 check 7: no FK into billing (02-CV §5.4)');
SELECT is((SELECT count(*)::int FROM pg_constraint c WHERE c.contype = 'f' AND c.conrelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'quality'::regnamespace AND relname NOT LIKE 'g\_cs\_%' AND relname <> 'event_inbox') AND cardinality(c.conkey) = 1 AND c.confrelid <> 'core.tenants'::regclass), 0, 'C9 check 7: every FK except the tenant FK is composite (tenant_id, x) (02-CV §5.4)');
SELECT is((SELECT count(*)::int FROM pg_proc WHERE pronamespace = 'quality'::regnamespace AND prosecdef), 0, 'C9 check 7: no SECURITY DEFINER function in quality');
SELECT has_view('quality', 'v_pub_qc_summary', 'C9 check 7: the published view exists');
SELECT is((SELECT coalesce(c.reloptions @> ARRAY['security_invoker=true'] OR c.reloptions @> ARRAY['security_invoker=on'], false) FROM pg_class c WHERE c.oid = 'quality.v_pub_qc_summary'::regclass), true, 'C9 check 7 / REQ-SEC-031: v_pub_qc_summary security_invoker = true');
SELECT columns_are('quality', 'v_pub_qc_summary', ARRAY['tenant_id','instrument_id','analyte_id','business_date','runs','accepted_runs','rejected_runs','warnings','last_in_control_run_at'], 'C9 check 7: exactly the 03-IC §6.7 columns');
SELECT is((SELECT count(*)::int FROM pg_class c WHERE c.relnamespace = 'quality'::regnamespace AND c.relkind = 'r' AND c.relname IN (SELECT t FROM rt)), 23, 'C9 check 7 / AC-0B-6.1: all 23 tenant tables exist after the migrations applied in order');
SELECT is((SELECT count(*)::int FROM quality.g_cs_corrective_actions), 7, 'C9 check 7: g_cs_corrective_actions seeded (7)');
SELECT is((SELECT count(*)::int FROM quality.g_cs_exclusion_reasons), 6, 'C9 check 7: g_cs_exclusion_reasons seeded (6)');

SELECT * FROM finish();
ROLLBACK;
