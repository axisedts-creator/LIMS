-- T0B-13.C12 schema suite: inventory catalogue properties (C12 05-SCHEMA §1, §3, §4, §5, §8, §9, §11; AC-0B-2.1, 2.2, 2.3, 2.4, 3.6, 4.1, 4.2, 4.3, 5.1, 5.3, 6.1, 6.2, 6.3).
-- Pure pg_catalog assertions: no fixtures, no data written. One rolled-back transaction. RLS is never disabled.
-- Run from the repo root: pg_prove -d <db> db/tests/inventory/T0B-13.C12_schema.test.sql   (pgTAP in schema `extensions`; migrations + seeds loaded; superuser)
-- Markers (the node test checks them): C12 check 1 inventory/owner/no sequences, enums or views, 2 RLS ENABLE+FORCE (G exempt), 3 policy set per table + alerts DELETE policy, 4 grant matrix (DELETE on alerts only),
-- 5 indexes + constraint names, 6 triggers + functions + audit, 7 FK direction, no DEFINER, seeds (AC-0B-6.1 / 6.2 / 6.3). Checks 8-14 are in T0B-13.C12_behaviour.test.sql.
-- Scope note: event_inbox is C0's (T0B-05) and is excluded from every count. lims_api / lims_worker INHERIT lims_app, so "no DELETE / no UPDATE" is asserted for lims_app only.
-- Spec reading (tester assumption, see note T0B-13.C12-tests.md): audit triggers on the 13 M + 10 C tables (not ledger / documents / 3 projections); number_counters, instrument_qc_daily, alerts: spec silent (aud = NULL, either way).
BEGIN;
SET search_path = extensions, public, pg_catalog;
SELECT * FROM no_plan();

-- t: table; i/u/d: lims_app whole-table INSERT / UPDATE / DELETE; npol: expected policies; aud: true = audit trigger required, false = forbidden, NULL = open
CREATE TEMP TABLE rt(t, i, u, d, npol, aud) AS VALUES
  ('cs_reasons',true,true,false,3,true),('cs_tax_codes',true,true,false,3,true),('settings',true,true,false,3,true),('number_counters',true,true,false,3,NULL::boolean),('items',true,true,false,3,true),('item_packs',true,true,false,3,true),
  ('item_barcodes',true,true,false,3,true),('stores',true,true,false,3,true),('store_item_settings',true,true,false,3,true),('suppliers',true,true,false,3,true),('supplier_items',true,true,false,3,true),('lots',true,true,false,3,true),
  ('stock_balances',true,true,false,3,false),('stock_movements',true,false,false,2,false),('purchase_orders',true,true,false,3,true),('purchase_order_lines',true,true,false,3,true),('goods_receipts',true,true,false,3,true),
  ('goods_receipt_lines',true,true,false,3,true),('transfers',true,true,false,3,true),('transfer_lines',true,true,false,3,true),('stock_documents',true,false,false,2,false),('stock_document_lines',true,false,false,2,false),
  ('stock_counts',true,true,false,3,true),('stock_count_lines',true,true,false,3,true),('opened_containers',true,true,false,3,true),('instrument_bindings',true,true,false,3,true),('consumption_rules',true,true,false,3,true),
  ('consumption_facts',true,true,false,3,true),('consumption_daily',true,true,false,3,false),('test_counts_daily',true,true,false,3,false),('instrument_qc_daily',true,true,false,3,NULL::boolean),('alerts',true,true,true,4,NULL::boolean);
CREATE TEMP TABLE rg(t) AS VALUES ('g_cs_uom'),('g_cs_reasons'),('g_cs_tax_codes');
CREATE TEMP TABLE rf(f) AS VALUES ('tg_doc_guard'),('tg_line_guard'),('tg_item_base_uom_lock');

-- C12 check 1: inventory, owner (AC-0B-1.2, AC-0B-6.3), schema privileges, no sequences / enums / views (§9)
SELECT is((SELECT count(*)::int FROM pg_class c WHERE c.relnamespace = 'inventory'::regnamespace AND c.relkind IN ('r','p')), 32 + 3 + 1, 'C12 check 1: inventory holds 32 tenant + 3 G tables + event_inbox (35 chunk tables)');
SELECT is((SELECT count(*)::int FROM pg_class c WHERE c.relnamespace = 'inventory'::regnamespace AND c.relkind IN ('v','m')), 0, 'C12 check 1 / §9: no view and no materialized view (C12 publishes none in v1)');
SELECT is((SELECT count(*)::int FROM pg_class c WHERE c.relnamespace = 'inventory'::regnamespace AND c.relkind = 'S'), 0, 'C12 check 1: no sequences');
SELECT is((SELECT count(*)::int FROM pg_type t WHERE t.typnamespace = 'inventory'::regnamespace AND t.typtype = 'e'), 0, 'C12 check 1: no ENUM types');
SELECT is(pg_get_userbyid(c.relowner), 'lims_owner', 'C12 check 1: inventory.' || c.relname || ' owned by lims_owner (AC-0B-1.2, AC-0B-6.3)') FROM pg_class c WHERE c.relnamespace = 'inventory'::regnamespace AND c.relkind = 'r';
SELECT is(has_schema_privilege('lims_app', 'inventory', 'USAGE'), true, 'lims_app has USAGE on schema inventory');
SELECT is(has_schema_privilege(r, 'inventory', 'CREATE'), false, r || ' cannot CREATE in inventory') FROM unnest(ARRAY['lims_app','lims_api','lims_worker','lims_analytics']) r;
SELECT is((SELECT count(*)::int FROM rt) + (SELECT count(*)::int FROM rg), 35, 'C12 check 1: 35 tables in the inventory (= table count of the 05-SCHEMA §8 DDL)');
SELECT is((SELECT array_agg(relname::text ORDER BY relname) FROM pg_class WHERE relnamespace = 'inventory'::regnamespace AND relkind = 'r' AND relname <> 'event_inbox'), (SELECT array_agg(t ORDER BY t) FROM (SELECT t FROM rt UNION ALL SELECT t FROM rg) x), 'C12 check 1: the table set equals the §1 inventory');

-- C12 check 2: RLS ENABLE + FORCE on the 32 tenant tables, none on the 3 G tables (AC-0B-2.1, 2.4)
SELECT is((SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = ('inventory.' || t)::regclass), true, 'C12 check 2 / AC-0B-2.1: ENABLE + FORCE RLS on inventory.' || t) FROM rt;
SELECT is((SELECT relrowsecurity OR relforcerowsecurity FROM pg_class WHERE oid = ('inventory.' || t)::regclass), false, 'C12 check 2 / AC-0B-2.1: inventory.' || t || ' is RLS-exempt (global coded set, listed in rls_exempt.txt)') FROM rg;
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'inventory' AND tablename = g.t), 0, 'C12 check 2: no policy on ' || g.t) FROM rg g;
SELECT is(NOT EXISTS (SELECT 1 FROM pg_class WHERE relnamespace = 'inventory'::regnamespace AND relkind = 'r' AND relname <> 'event_inbox' AND relname NOT LIKE 'g\_%' AND NOT (relrowsecurity AND relforcerowsecurity)), true, 'C12 check 2 / AC-0B-2.2 / AC-0B-2.4: every non-exempt inventory table has ENABLE + FORCE (RLS is never off)');

-- C12 check 3: policy set per table (AC-0B-2.3): count, role, UPDATE only where §4.2 allows, staff guard, tenant predicate, ONE DELETE policy (alerts)
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'inventory' AND tablename = rt.t), npol, 'C12 check 3 / AC-0B-2.3: inventory.' || t || ' has ' || npol || ' policies') FROM rt;
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'inventory' AND tablename <> 'event_inbox'), 94, 'C12 check 3: 94 policies in inventory (ex event_inbox)');
SELECT is((SELECT array_agg(DISTINCT r) FROM pg_policies p, unnest(p.roles) r WHERE schemaname = 'inventory' AND tablename <> 'event_inbox'), ARRAY['lims_app'::name], 'C12 check 3: every policy is TO lims_app only (no PUBLIC / anon / owner policy)');
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'inventory' AND tablename = rt.t AND cmd = 'UPDATE'), CASE WHEN u THEN 1 ELSE 0 END, 'C12 check 3: UPDATE policy on inventory.' || t || ' iff §4.2 (the 3 class A tables: none)') FROM rt;
-- T0B-GREEN-1 STALE: migration 20261105001000 (core__create_event_inboxes) adds event_inbox__delete__owner_only to every schema's event_inbox (purge by lims_owner); alerts__delete__tenant stays the only DELETE policy of every other table and the inbox policy is pinned to lims_owner
SELECT is((SELECT array_agg(tablename::text || '.' || policyname::text) FROM pg_policies WHERE schemaname = 'inventory' AND tablename <> 'event_inbox' AND cmd = 'DELETE'), ARRAY['alerts.alerts__delete__tenant'], 'C12 check 3 / D-72: alerts__delete__tenant is the only DELETE policy (draft lines are soft-removed, D-71)');
SELECT is((SELECT array_agg(policyname::text || '|' || roles::text) FROM pg_policies WHERE schemaname = 'inventory' AND tablename = 'event_inbox' AND cmd = 'DELETE'), ARRAY['event_inbox__delete__owner_only|{lims_owner}'], 'C12 check 3 / T0B-GREEN-1: the event_inbox DELETE policy is the owner-only purge policy, TO lims_owner only');
SELECT matches((SELECT qual FROM pg_policies WHERE schemaname = 'inventory' AND policyname = 'alerts__delete__tenant'), 'actor_type.*system', 'C12 check 3 / D-72: the alerts DELETE policy admits the system actor only');
SELECT matches((SELECT qual FROM pg_policies WHERE schemaname = 'inventory' AND policyname = 'alerts__delete__tenant'), 'expires_at < now\(\)', 'C12 check 3 / D-72: the alerts DELETE policy admits expired rows only');
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'inventory' AND tablename <> 'event_inbox' AND NOT (coalesce(qual, '') || coalesce(with_check, '')) LIKE '%is_staff_or_system%'), 0, 'C12 check 3 / P-16: staff-actor guard in every inventory policy (gate 9)');
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'inventory' AND tablename <> 'event_inbox' AND (coalesce(qual, '') || coalesce(with_check, '')) NOT LIKE '%current_tenant_id%'), 0, 'C12 check 3: tenant predicate in every policy');
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'inventory' AND (policyname LIKE '%\_\_tenant\_centre' OR (coalesce(qual, '') || coalesce(with_check, '')) LIKE '%current_centre_ids%')), 0, 'C12 check 3 / §1: no centre scoping (branch scope is app-enforced)');

-- C12 check 4: grant matrix (AC-0B-4.2 / 4.3; §4.4): DELETE on alerts only
SELECT is(has_table_privilege('lims_app', 'inventory.' || t, 'SELECT'), true, 'C12 check 4: lims_app SELECT on inventory.' || t) FROM rt;
SELECT is(has_table_privilege('lims_app', 'inventory.' || t, 'INSERT'), i, 'C12 check 4 / AC-0B-4.2: lims_app INSERT on inventory.' || t) FROM rt;
SELECT is(has_table_privilege('lims_app', 'inventory.' || t, 'UPDATE'), u, 'C12 check 4 / AC-0B-4.1 / AC-0B-4.3: lims_app UPDATE on inventory.' || t || ' (none on stock_movements, stock_documents, stock_document_lines)') FROM rt;
SELECT is(has_table_privilege('lims_app', 'inventory.' || t, 'DELETE'), d, 'C12 check 4 / AC-0B-4.2 / §4.4: lims_app DELETE on inventory.' || t || ' only for alerts (class E purge)') FROM rt;
SELECT is(has_table_privilege('lims_app', 'inventory.' || t, 'TRUNCATE') OR has_table_privilege('lims_app', 'inventory.' || t, 'REFERENCES') OR has_table_privilege('lims_app', 'inventory.' || t, 'TRIGGER'), false, 'C12 check 4: no TRUNCATE / REFERENCES / TRIGGER on inventory.' || t) FROM rt;
SELECT is(ARRAY[has_table_privilege('lims_app', 'inventory.' || t, 'SELECT'), has_table_privilege('lims_app', 'inventory.' || t, 'INSERT'), has_table_privilege('lims_app', 'inventory.' || t, 'UPDATE'), has_table_privilege('lims_app', 'inventory.' || t, 'DELETE')], ARRAY[true, false, false, false], 'C12 check 4: lims_app only SELECTs ' || t) FROM rg;
SELECT is(has_table_privilege('lims_analytics', 'inventory.' || x.t, p), false, 'C12 check 4: lims_analytics has no ' || p || ' on inventory.' || x.t) FROM (SELECT t FROM rt UNION ALL SELECT t FROM rg) x, unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) p;
SELECT is((SELECT count(*)::int FROM information_schema.role_table_grants WHERE table_schema = 'inventory' AND grantee IN ('PUBLIC','anon','authenticated','service_role')), 0, 'C12 check 4: nothing granted to PUBLIC / anon / authenticated / service_role');
SELECT is(has_function_privilege('lims_app', 'app.purge_inventory_alerts()', 'EXECUTE'), true, 'C12 check 4 / §4.4: lims_app may EXECUTE app.purge_inventory_alerts()');
SELECT is(has_function_privilege('lims_analytics', 'app.purge_inventory_alerts()', 'EXECUTE'), false, 'C12 check 4: lims_analytics may not purge alerts');

-- C12 check 5: indexes and constraint names: tenant_id leads every index; every __p_ index is partial; UNIQUE (tenant_id, id) where the table has an id; tenant FK on every tenant table
SELECT is((regexp_match(pg_get_indexdef(i.indexrelid), '\(([^,)]+)'))[1], 'tenant_id', 'C12 check 5: index ' || c.relname || ' leads with tenant_id') FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_class t ON t.oid = i.indrelid
  WHERE t.relnamespace = 'inventory'::regnamespace AND t.relname NOT LIKE 'g\_%' AND t.relname <> 'event_inbox' AND NOT i.indisprimary;
SELECT is((SELECT count(*)::int FROM pg_indexes WHERE schemaname = 'inventory' AND indexname = n), 1, 'C12 check 5: index ' || n || ' exists (§8 / §10)')
  FROM unnest(ARRAY['stores__tenant_id_store_code__uq','stores__tenant_id_branch_id_default__p_uq','items__tenant_id_item_code__uq','items__tenant_id_item_code_prefix__idx','items__tenant_id_lower_name__idx','item_packs__tenant_id_item_id_default__p_uq',
    'item_barcodes__tenant_id_value__p_uq','suppliers__tenant_id_lower_name__idx','store_item_settings__tenant_id_reorder__p_idx','lots__tenant_id_expiry_on__idx','stock_balances__tenant_id_store_nonzero__p_idx','stock_balances__tenant_id_item_id__idx',
    'consumption_rules__current__p_uq','consumption_rules__tenant_id_match__idx','consumption_rules__tenant_id_item_id__idx','purchase_order_lines__tenant_id_po_line__p_uq','stock_movements__tenant_id_store_item__idx',
    'stock_movements__tenant_id_store_occurred__idx','stock_movements__tenant_id_lot__p_idx','alerts__tenant_id_dedupe__p_uq','alerts__tenant_id_status_kind__idx','alerts__tenant_id_expires__p_idx']) n;
SELECT is((SELECT count(*)::int FROM pg_indexes WHERE schemaname = 'inventory' AND indexname ~ '__p_(uq|idx)$' AND indexdef NOT LIKE '% WHERE %'), 0, 'C12 check 5: every __p_ index is partial');
SELECT is((SELECT count(*)::int FROM pg_indexes WHERE schemaname = 'inventory' AND indexname = 'consumption_rules__current__p_uq' AND indexdef LIKE '%NULLS NOT DISTINCT%'), 1, 'C12 check 5: consumption_rules__current__p_uq is NULLS NOT DISTINCT');
SELECT is((SELECT count(*)::int FROM pg_constraint WHERE conrelid = ('inventory.' || t)::regclass AND contype = 'u' AND conkey @> ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = ('inventory.' || t)::regclass AND attname = 'tenant_id'), (SELECT attnum FROM pg_attribute WHERE attrelid = ('inventory.' || t)::regclass AND attname = 'id')] AND cardinality(conkey) = 2), 1, 'C12 check 5: UNIQUE (tenant_id, id) on inventory.' || t || ' (04 D8)') FROM rt
  WHERE t NOT IN ('number_counters','instrument_qc_daily');
SELECT is((SELECT count(*)::int FROM pg_constraint c JOIN pg_class r ON r.oid = c.conrelid WHERE r.relnamespace = 'inventory'::regnamespace AND r.relkind = 'r' AND r.relname <> 'event_inbox' AND c.conname NOT LIKE r.relname || '\_\_%'), 0, 'C12 check 5: every constraint in inventory is prefixed <table>__');
SELECT is((SELECT count(*)::int FROM pg_constraint WHERE conrelid = ('inventory.' || t)::regclass AND conname = t || '__tenant__fk' AND contype = 'f' AND confrelid = 'core.tenants'::regclass), 1, 'C12 check 5: ' || t || '__tenant__fk exists') FROM rt;
SELECT is((SELECT count(*)::int FROM pg_constraint WHERE conrelid = 'inventory.number_counters'::regclass AND contype = 'p' AND cardinality(conkey) = 3), 1, 'C12 check 5 / P-18(b): number_counters PK is (tenant_id, series, period_key), no id column');
SELECT is((SELECT count(*)::int FROM pg_constraint WHERE conrelid = 'inventory.instrument_qc_daily'::regclass AND contype = 'p' AND cardinality(conkey) = 3), 1, 'C12 check 5 / P-18(b): instrument_qc_daily PK is (tenant_id, business_date, instrument_id), no id column');
SELECT is((SELECT count(*)::int FROM pg_attribute WHERE attrelid = (('inventory.' || t))::regclass AND attname IN ('id','version','is_active') AND NOT attisdropped), 0, 'C12 check 5 / §1: ' || t || ' has no id / version / is_active') FROM unnest(ARRAY['number_counters','instrument_qc_daily']) t;

-- C12 check 6: triggers, functions, audit (AC-0B-5.1, 5.3; §5)
SELECT is((SELECT count(*)::int FROM pg_trigger tg WHERE tg.tgrelid = ('inventory.' || t)::regclass AND NOT tg.tgisinternal AND tg.tgname = t || '__audit'), CASE WHEN aud THEN 1 ELSE 0 END, 'C12 check 6 / AC-0B-5.1: audit trigger on inventory.' || t || ' iff §5 (M and C tables; not the ledger, documents or projections)') FROM rt WHERE aud IS NOT NULL;
SELECT is((SELECT count(*)::int FROM pg_trigger tg WHERE tg.tgrelid = ('inventory.' || t)::regclass AND tg.tgname = t || '__audit' AND tg.tgfoid = 'app.tg_row_audit'::regproc), CASE WHEN aud THEN 1 ELSE 0 END, 'C12 check 6: audit trigger of inventory.' || t || ' runs app.tg_row_audit') FROM rt WHERE aud IS NOT NULL;
SELECT is((SELECT count(*)::int FROM pg_trigger tg WHERE tg.tgrelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'inventory'::regnamespace) AND NOT tg.tgisinternal AND tg.tgname LIKE '%\_\_audit' AND tg.tgrelid::regclass::text NOT IN ('inventory.number_counters','inventory.instrument_qc_daily','inventory.alerts')), 23, 'C12 check 6: 23 audit triggers (13 M, 10 C) outside the three open tables');
SELECT is((SELECT count(*)::int FROM pg_trigger tg WHERE tg.tgrelid = ('inventory.' || t)::regclass AND tg.tgfoid = 'app.enforce_mutable_columns'::regproc AND (tg.tgtype & 2) = 2 AND (tg.tgtype & 16) = 16 AND (tg.tgtype & 1) = 1), 1, 'C12 check 6: inventory.' || t || ' has one BEFORE UPDATE FOR EACH ROW app.enforce_mutable_columns trigger (§5)')
  FROM unnest(ARRAY['item_packs','lots','consumption_rules','stock_balances']) t;
SELECT is((SELECT count(*)::int FROM pg_trigger tg WHERE tg.tgrelid = ('inventory.' || t)::regclass AND tg.tgfoid = 'inventory.tg_doc_guard'::regproc AND (tg.tgtype & 2) = 2 AND (tg.tgtype & 16) = 16 AND (tg.tgtype & 1) = 1 AND (tg.tgtype & 4) = 0), 1, 'C12 check 6: inventory.' || t || ' has tg_doc_guard BEFORE UPDATE FOR EACH ROW')
  FROM unnest(ARRAY['purchase_orders','goods_receipts','transfers','stock_counts','opened_containers','consumption_facts']) t;
SELECT is((SELECT count(*)::int FROM pg_trigger tg WHERE tg.tgrelid = ('inventory.' || t)::regclass AND tg.tgfoid = 'inventory.tg_line_guard'::regproc AND (tg.tgtype & 2) = 2 AND (tg.tgtype & 16) = 16 AND (tg.tgtype & 4) = 4 AND (tg.tgtype & 1) = 1), 1, 'C12 check 6: inventory.' || t || ' has tg_line_guard BEFORE INSERT OR UPDATE FOR EACH ROW')
  FROM unnest(ARRAY['purchase_order_lines','goods_receipt_lines','transfer_lines','stock_count_lines']) t;
SELECT is((SELECT count(*)::int FROM pg_trigger tg WHERE tg.tgrelid = 'inventory.items'::regclass AND tg.tgfoid = 'inventory.tg_item_base_uom_lock'::regproc AND (tg.tgtype & 2) = 2 AND (tg.tgtype & 16) = 16 AND tg.tgattr::text <> ''), 1, 'C12 check 6: tg_item_base_uom_lock is BEFORE UPDATE OF base_uom_code on items');
SELECT is((SELECT count(*)::int FROM pg_proc p WHERE p.pronamespace = 'inventory'::regnamespace AND p.proname = f), 1, 'C12 check 6: inventory.' || f || '() exists') FROM rf;
SELECT is((SELECT prosecdef FROM pg_proc WHERE pronamespace = 'inventory'::regnamespace AND proname = f), false, 'C12 check 6 / AC-0B-4.1: inventory.' || f || ' is SECURITY INVOKER') FROM rf;
SELECT is((SELECT proconfig FROM pg_proc WHERE pronamespace = 'inventory'::regnamespace AND proname = f), ARRAY['search_path=""'], 'C12 check 6: inventory.' || f || ' has search_path = empty') FROM rf;
SELECT is((SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE pronamespace = 'inventory'::regnamespace AND proname = f), 'lims_owner', 'C12 check 6: inventory.' || f || ' owned by lims_owner (AC-0B-6.3)') FROM rf;
SELECT is((SELECT count(*)::int FROM pg_proc WHERE pronamespace = 'inventory'::regnamespace), 3, 'C12 check 6: no function in inventory beyond the 3 guard functions');
SELECT is((SELECT array_agg(prosecdef::text || '|' || coalesce((proconfig = ARRAY['search_path=""'])::text, 'null') || '|' || pg_get_userbyid(proowner) || '|' || prorettype::regtype::text) FROM pg_proc WHERE pronamespace = 'app'::regnamespace AND proname = 'purge_inventory_alerts'), ARRAY['false|true|lims_owner|integer'], 'C12 check 6 / §8: app.purge_inventory_alerts() is SECURITY INVOKER, search_path empty, owned by lims_owner, returns integer');

-- C12 check 7: FK direction, no DEFINER, seeds (AC-0B-6.1 / 6.2 / 6.3; REQ-SEC-031)
SELECT is((SELECT array_agg(DISTINCT n.nspname::text ORDER BY n.nspname::text) FROM pg_constraint c JOIN pg_class r ON r.oid = c.confrelid JOIN pg_namespace n ON n.oid = r.relnamespace WHERE c.contype = 'f' AND c.conrelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'inventory'::regnamespace)),
  ARRAY['catalog','core','instruments','inventory'], 'C12 check 7 / AC-0B-6.2: inventory FKs point into inventory, core, catalog, instruments only (01 §5 R3; none into billing)');
SELECT is((SELECT count(*)::int FROM pg_constraint c JOIN pg_class r ON r.oid = c.confrelid WHERE c.contype = 'f' AND r.relnamespace = 'inventory'::regnamespace AND c.conrelid NOT IN (SELECT oid FROM pg_class WHERE relnamespace = 'inventory'::regnamespace)), 0, 'C12 check 7 / AC-0B-6.2: nothing references inventory from another schema');
SELECT is((SELECT count(*)::int FROM pg_constraint c WHERE c.contype = 'f' AND c.conrelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'inventory'::regnamespace AND relname NOT LIKE 'g\_%' AND relname <> 'event_inbox')
  AND cardinality(c.conkey) = 1 AND c.confrelid <> 'core.tenants'::regclass AND c.conname NOT IN ('items__uom__fk','item_packs__uom__fk')), 0, 'C12 check 7: every FK except the tenant FK and the two g_cs_uom code FKs is composite (tenant_id, x) (02-CV §5.4)');
SELECT is((SELECT count(*)::int FROM pg_proc WHERE pronamespace IN ('inventory'::regnamespace) AND prosecdef) + (SELECT count(*)::int FROM pg_proc WHERE proname = 'purge_inventory_alerts' AND prosecdef), 0, 'C12 check 7 / §11: no SECURITY DEFINER function (no DEFINER, no owner policy)');
SELECT is((SELECT count(*)::int FROM inventory.g_cs_uom), 19, 'C12 check 7 / §6.1: 19 units of measure seeded');
SELECT is((SELECT count(*)::int FROM inventory.g_cs_uom WHERE (code IN ('ml','ul','l') AND uom_kind = 'volume') OR (code IN ('g','mg') AND uom_kind = 'mass') OR (code NOT IN ('ml','ul','l','g','mg') AND uom_kind = 'count')), 19, 'C12 check 7 / §6.1: unit kinds');
SELECT is((SELECT count(*)::int FROM inventory.g_cs_reasons), 50, 'C12 check 7 / §6.2: 50 reason codes seeded');
SELECT is((SELECT count(DISTINCT reason_group)::int FROM inventory.g_cs_reasons), 11, 'C12 check 7 / §6.2: 11 reason groups');
SELECT is((SELECT array_agg(code || ':' || display ORDER BY code) FROM inventory.g_cs_tax_codes), ARRAY['VAT:VAT'], 'C12 check 7 / §6.3: g_cs_tax_codes seeded with VAT only (no exempt row, no rate)');
SELECT is((SELECT count(*)::int FROM inventory.g_cs_reasons WHERE system = 'lims' AND system_version = '1' AND is_active), 50, 'C12 check 7: reason seeds carry system = lims, system_version = 1, active');
SELECT is((SELECT count(*)::int FROM inventory.cs_reasons) + (SELECT count(*)::int FROM inventory.cs_tax_codes) + (SELECT count(*)::int FROM inventory.settings) + (SELECT count(*)::int FROM inventory.items) + (SELECT count(*)::int FROM inventory.number_counters), 0, 'C12 check 7: no seeded tenant rows (settings and counters are created lazily, P-22)');
SELECT is((SELECT count(*)::int FROM pg_class c WHERE c.relnamespace = 'inventory'::regnamespace AND c.relkind = 'r' AND c.relname IN (SELECT t FROM rt)), 32, 'C12 check 7 / AC-0B-6.1: all 32 tenant tables exist after the migrations applied in order');

SELECT * FROM finish();
ROLLBACK;
