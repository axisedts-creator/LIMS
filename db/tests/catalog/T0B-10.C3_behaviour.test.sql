-- T0B-10.C3 behaviour suite: tenant isolation, staff guard, lifecycle / immutability triggers, composite FKs, partial uniques, views (C3 05-SCHEMA §11 tests 1, 3-12; AC-0B-2.2, 3.1-3.5, 4.1).
-- The generated per-table probes (db/tests/isolation/catalog.<t>.test.sql) are the AC-0B-3.x proof for every table; this file proves the catalog-specific rules the generator cannot know.
-- Synthetic data only (seeds 010: tenant A 01a1a98a-...-a001, tenant B ...-b001; centres a201/b201). One rolled-back transaction. RLS is never disabled: fixtures are inserted by the
-- superuser test session (which bypasses RLS) with the core system actor's claims set so app.tg_row_audit has an audit context; every assertion runs as SET LOCAL ROLE lims_app.
-- Run from the repo root: pg_prove -d <db> db/tests/catalog/T0B-10.C3_behaviour.test.sql   (pgTAP in schema `extensions`; migrations + seeds loaded; superuser)
-- Coverage map (C3 05-SCHEMA §11):
-- §11 test 1: tenant A claims see 0 tenant B rows; INSERT with tenant B id fails; UPDATE / DELETE of B rows affect 0 rows
-- §11 test 3: published analyte_versions immutable; superseded -> published; reference_ranges / items / formula_dependencies of a published parent
-- §11 test 4: composite FK probes (price_list_items, price_list_assignments, instrument_code_maps)
-- §11 test 5: catalog_state.catalog_revision never decreases
-- §11 test 6: partial uniques (draft per analyte, default price list, inbound map)
-- §11 test 7: views as a tenant A reader
-- §11 test 8: cs_tax_types uniqueness + immutability, tax_rules unknown other_tax_code -> 23503
-- §11 test 9: partner / patient / portal claims see 0 rows (staff-or-system guard)
-- §11 test 10: comment_code_texts
-- §11 test 11: tax_rules / surcharge_rules immutability + uniqueness
-- §11 test 12: import_issues.expires_at NOT NULL; source_import_id frozen after publish
BEGIN;
SET search_path = extensions, public, pg_catalog;
SELECT * FROM no_plan();

CREATE FUNCTION pg_temp.ta() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1a98a-ac40-7000-8000-00000000a001'::uuid $$;
CREATE FUNCTION pg_temp.tb() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1a98a-ac40-7000-8000-00000000b001'::uuid $$;
CREATE FUNCTION pg_temp.sys() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1b34e-1000-7eee-9d29-d7ca59a102b5'::uuid $$;
CREATE FUNCTION pg_temp.uid(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('0190c300-0000-7000-8000-' || lpad(n::text, 12, '0'))::uuid $$;
SELECT set_config('request.jwt.claims', jsonb_build_object('tenant_id', pg_temp.ta(), 'sub', pg_temp.sys(), 'actor_type', 'system')::text, true);

-- insert only the keys of p_row; created_by / updated_by are added when the table has them (omitted columns take their DEFAULT)
CREATE FUNCTION pg_temp.ins(p_tbl regclass, p_row jsonb) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE r jsonb := p_row; a text; cols text; saved text := current_setting('request.jwt.claims', true);
BEGIN
  -- audit trigger (SECURITY DEFINER) writes FORCE-RLS audit.audit_log under the claims: use the row's own tenant (system actor), restore afterwards
  IF r ? 'tenant_id' THEN PERFORM set_config('request.jwt.claims', jsonb_build_object('tenant_id', r->>'tenant_id', 'sub', pg_temp.sys(), 'actor_type', 'system')::text, true); END IF;
  FOREACH a IN ARRAY ARRAY['created_by', 'updated_by'] LOOP
    IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = p_tbl AND attname = a AND NOT attisdropped) AND NOT (r ? a) THEN r := r || jsonb_build_object(a, pg_temp.sys()); END IF;
  END LOOP;
  SELECT string_agg(quote_ident(k), ',') INTO cols FROM jsonb_object_keys(r) k;
  EXECUTE format('INSERT INTO %1$s (%2$s) SELECT %2$s FROM jsonb_populate_record(NULL::%1$s, %3$L::jsonb)', p_tbl, cols, r::text);
  PERFORM set_config('request.jwt.claims', coalesce(saved, ''), true);
END $f$;
-- run p_sql as p_role with p_claims; mode n = count of a query, w = ROW_COUNT of a statement; errors -> 'E' || SQLSTATE
CREATE FUNCTION pg_temp.x(p_role text, p_claims jsonb, p_sql text, p_mode text DEFAULT 'n') RETURNS text LANGUAGE plpgsql AS $f$
DECLARE r text; n bigint; saved text := current_setting('request.jwt.claims', true);
BEGIN
  PERFORM set_config('request.jwt.claims', coalesce(p_claims::text, ''), true);
  EXECUTE format('SET LOCAL ROLE %I', p_role);
  BEGIN
    IF p_mode = 'n' THEN EXECUTE 'SELECT count(*) FROM (' || p_sql || ') t' INTO n; ELSE EXECUTE p_sql; GET DIAGNOSTICS n = ROW_COUNT; END IF;
    r := 'n=' || n;
  EXCEPTION WHEN OTHERS THEN r := 'E' || SQLSTATE; END;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', coalesce(saved, ''), true);
  RETURN r;
END $f$;
CREATE FUNCTION pg_temp.cl(p_tenant uuid, p_type text DEFAULT 'user') RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('actor_type', p_type, 'tenant_id', p_tenant, 'sub', CASE WHEN p_tenant = pg_temp.ta() THEN '01a1a98a-ac40-7000-8000-00000000a300' ELSE '01a1a98a-ac40-7000-8000-00000000b300' END::uuid,
    'membership_id', CASE WHEN p_tenant = pg_temp.ta() THEN '01a1a98a-ac40-7000-8000-00000000a500' ELSE '01a1a98a-ac40-7000-8000-00000000b500' END::uuid) $$;
-- staff of tenant A / tenant B as lims_app
CREATE FUNCTION pg_temp.a(p_sql text, p_mode text DEFAULT 'w') RETURNS text LANGUAGE sql AS $$ SELECT pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta()), p_sql, p_mode) $$;
CREATE FUNCTION pg_temp.b(p_sql text, p_mode text DEFAULT 'w') RETURNS text LANGUAGE sql AS $$ SELECT pg_temp.x('lims_app', pg_temp.cl(pg_temp.tb()), p_sql, p_mode) $$;
CREATE FUNCTION pg_temp.pub() RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT ', effective_from = now(), published_at = now(), change_reason = ''seed''' $$;

-- ===================================================================================================================================== fixtures (superuser, system claims)
SELECT pg_temp.ins('catalog.departments', jsonb_build_object('id', pg_temp.uid(1), 'tenant_id', pg_temp.ta(), 'code', 'HAEM', 'name', 'Haematology (SYNTHETIC)'));
SELECT pg_temp.ins('catalog.departments', jsonb_build_object('id', pg_temp.uid(2), 'tenant_id', pg_temp.tb(), 'code', 'HAEM', 'name', 'Haematology B (SYNTHETIC)'));
SELECT pg_temp.ins('catalog.orderables', jsonb_build_object('id', pg_temp.uid(11), 'tenant_id', pg_temp.ta(), 'kind', 'test', 'code', 'CBC', 'name', 'CBC (SYNTHETIC)', 'department_id', pg_temp.uid(1)));
SELECT pg_temp.ins('catalog.orderables', jsonb_build_object('id', pg_temp.uid(14), 'tenant_id', pg_temp.ta(), 'kind', 'test', 'code', 'GLU', 'name', 'Glucose (SYNTHETIC)', 'department_id', pg_temp.uid(1)));
SELECT pg_temp.ins('catalog.orderables', jsonb_build_object('id', pg_temp.uid(13), 'tenant_id', pg_temp.ta(), 'kind', 'panel', 'code', 'LIPID', 'name', 'Lipid (SYNTHETIC)'));
SELECT pg_temp.ins('catalog.orderables', jsonb_build_object('id', pg_temp.uid(12), 'tenant_id', pg_temp.tb(), 'kind', 'test', 'code', 'CBC', 'name', 'CBC B (SYNTHETIC)', 'department_id', pg_temp.uid(2)));
SELECT pg_temp.ins('catalog.tests', jsonb_build_object('id', pg_temp.uid(11), 'tenant_id', pg_temp.ta(), 'workflow_type', 'standard'));
SELECT pg_temp.ins('catalog.tests', jsonb_build_object('id', pg_temp.uid(14), 'tenant_id', pg_temp.ta(), 'workflow_type', 'standard'));
SELECT pg_temp.ins('catalog.tests', jsonb_build_object('id', pg_temp.uid(12), 'tenant_id', pg_temp.tb(), 'workflow_type', 'standard'));
SELECT pg_temp.ins('catalog.panels', jsonb_build_object('id', pg_temp.uid(13), 'tenant_id', pg_temp.ta(), 'panel_kind', 'clinical'));
SELECT pg_temp.ins('catalog.analytes', jsonb_build_object('id', pg_temp.uid(21), 'tenant_id', pg_temp.ta(), 'test_id', pg_temp.uid(11), 'code', 'HB', 'name', 'Haemoglobin'));
SELECT pg_temp.ins('catalog.analytes', jsonb_build_object('id', pg_temp.uid(22), 'tenant_id', pg_temp.ta(), 'test_id', pg_temp.uid(11), 'code', 'WBC', 'name', 'WBC'));
SELECT pg_temp.ins('catalog.analytes', jsonb_build_object('id', pg_temp.uid(24), 'tenant_id', pg_temp.ta(), 'test_id', pg_temp.uid(14), 'code', 'GLU', 'name', 'Glucose'));
SELECT pg_temp.ins('catalog.analytes', jsonb_build_object('id', pg_temp.uid(23), 'tenant_id', pg_temp.tb(), 'test_id', pg_temp.uid(12), 'code', 'HB', 'name', 'Haemoglobin B'));
SELECT pg_temp.ins('catalog.imports', jsonb_build_object('id', pg_temp.uid(151), 'tenant_id', pg_temp.ta(), 'kind', 'catalog_master', 'file_name', 'a.xlsx', 'file_sha256', repeat('a', 64)));
-- analyte versions: avA1 published (anA1 v1), avA2 draft (anA2 v1), avS superseded + avD draft (anA3 v1 / v2)
SELECT pg_temp.ins('catalog.analyte_versions', jsonb_build_object('id', pg_temp.uid(31), 'tenant_id', pg_temp.ta(), 'analyte_id', pg_temp.uid(21), 'version_no', 1, 'status', 'published',
  'result_type', 'numeric', 'decimals', 1, 'unit_code', 'g_dl', 'effective_from', now(), 'published_at', now(), 'change_reason', 'seed', 'source_import_id', pg_temp.uid(151)));
SELECT pg_temp.ins('catalog.analyte_versions', jsonb_build_object('id', pg_temp.uid(32), 'tenant_id', pg_temp.ta(), 'analyte_id', pg_temp.uid(22), 'version_no', 1, 'status', 'draft', 'result_type', 'numeric', 'decimals', 1));
SELECT pg_temp.ins('catalog.analyte_versions', jsonb_build_object('id', pg_temp.uid(35), 'tenant_id', pg_temp.ta(), 'analyte_id', pg_temp.uid(24), 'version_no', 1, 'status', 'superseded',
  'result_type', 'numeric', 'decimals', 1, 'effective_from', now(), 'published_at', now(), 'change_reason', 'seed'));
SELECT pg_temp.ins('catalog.analyte_versions', jsonb_build_object('id', pg_temp.uid(36), 'tenant_id', pg_temp.ta(), 'analyte_id', pg_temp.uid(24), 'version_no', 2, 'status', 'draft', 'result_type', 'numeric', 'decimals', 1));
-- reference range set rsA1 (published, with one band), rsD (draft, no bands); critical set csA1 (published)
SELECT pg_temp.ins('catalog.reference_range_sets', jsonb_build_object('id', pg_temp.uid(41), 'tenant_id', pg_temp.ta(), 'analyte_id', pg_temp.uid(21), 'version_no', 1, 'source_import_id', pg_temp.uid(151)));
SELECT pg_temp.ins('catalog.reference_ranges', jsonb_build_object('id', pg_temp.uid(51), 'tenant_id', pg_temp.ta(), 'set_id', pg_temp.uid(41), 'sex', 'any', 'kind', 'numeric', 'low', 1, 'high', 2));
UPDATE catalog.reference_range_sets SET status = 'published', effective_from = now(), published_at = now(), change_reason = 'seed' WHERE id = pg_temp.uid(41);
SELECT pg_temp.ins('catalog.reference_range_sets', jsonb_build_object('id', pg_temp.uid(42), 'tenant_id', pg_temp.ta(), 'analyte_id', pg_temp.uid(22), 'version_no', 1));
SELECT pg_temp.ins('catalog.critical_limit_sets', jsonb_build_object('id', pg_temp.uid(45), 'tenant_id', pg_temp.ta(), 'analyte_id', pg_temp.uid(21), 'version_no', 1, 'source_import_id', pg_temp.uid(151)));
UPDATE catalog.critical_limit_sets SET status = 'published', effective_from = now(), published_at = now(), change_reason = 'seed' WHERE id = pg_temp.uid(45);
-- price lists, versions, items (pvA1 and pvX published after their items exist)
SELECT pg_temp.ins('catalog.price_lists', jsonb_build_object('id', pg_temp.uid(61), 'tenant_id', pg_temp.ta(), 'code', 'DEFAULT', 'name', 'Default (SYNTHETIC)', 'owner_kind', 'default'));
SELECT pg_temp.ins('catalog.price_lists', jsonb_build_object('id', pg_temp.uid(62), 'tenant_id', pg_temp.ta(), 'code', 'CENTRELIST', 'name', 'Centre list (SYNTHETIC)', 'owner_kind', 'centre'));
SELECT pg_temp.ins('catalog.price_lists', jsonb_build_object('id', pg_temp.uid(63), 'tenant_id', pg_temp.tb(), 'code', 'DEFAULT', 'name', 'Default B (SYNTHETIC)', 'owner_kind', 'default'));
SELECT pg_temp.ins('catalog.price_lists', jsonb_build_object('id', pg_temp.uid(64), 'tenant_id', pg_temp.ta(), 'code', 'INACT', 'name', 'Inactive referrer list (SYNTHETIC)', 'owner_kind', 'referrer', 'is_active', false));
SELECT pg_temp.ins('catalog.price_list_versions', jsonb_build_object('id', pg_temp.uid(71), 'tenant_id', pg_temp.ta(), 'price_list_id', pg_temp.uid(61), 'version_no', 1));
SELECT pg_temp.ins('catalog.price_list_versions', jsonb_build_object('id', pg_temp.uid(72), 'tenant_id', pg_temp.ta(), 'price_list_id', pg_temp.uid(62), 'version_no', 1));
SELECT pg_temp.ins('catalog.price_list_versions', jsonb_build_object('id', pg_temp.uid(73), 'tenant_id', pg_temp.tb(), 'price_list_id', pg_temp.uid(63), 'version_no', 1));
SELECT pg_temp.ins('catalog.price_list_versions', jsonb_build_object('id', pg_temp.uid(74), 'tenant_id', pg_temp.ta(), 'price_list_id', pg_temp.uid(64), 'version_no', 1));
SELECT pg_temp.ins('catalog.price_list_items', jsonb_build_object('id', pg_temp.uid(81), 'tenant_id', pg_temp.ta(), 'price_list_version_id', pg_temp.uid(71), 'orderable_id', pg_temp.uid(11), 'unit_price_paisa', 1000));
SELECT pg_temp.ins('catalog.price_list_items', jsonb_build_object('id', pg_temp.uid(83), 'tenant_id', pg_temp.ta(), 'price_list_version_id', pg_temp.uid(72), 'orderable_id', pg_temp.uid(11), 'unit_price_paisa', 2000));
SELECT pg_temp.ins('catalog.price_list_items', jsonb_build_object('id', pg_temp.uid(82), 'tenant_id', pg_temp.tb(), 'price_list_version_id', pg_temp.uid(73), 'orderable_id', pg_temp.uid(12), 'unit_price_paisa', 1500));
SELECT pg_temp.ins('catalog.price_list_items', jsonb_build_object('id', pg_temp.uid(84), 'tenant_id', pg_temp.ta(), 'price_list_version_id', pg_temp.uid(74), 'orderable_id', pg_temp.uid(11), 'unit_price_paisa', 3000));
UPDATE catalog.price_list_versions SET status = 'published', effective_from = now(), published_at = now(), change_reason = 'seed' WHERE id IN (pg_temp.uid(71), pg_temp.uid(74));
-- doctors, counters, rules, comment texts, code map
SELECT pg_temp.ins('catalog.doctors', jsonb_build_object('id', pg_temp.uid(161), 'tenant_id', pg_temp.ta(), 'doctor_code', 'DR00001', 'display_name', 'Dr Synthetic One', 'name_normalised', 'dr synthetic one', 'source', 'back_office'));
SELECT pg_temp.ins('catalog.doctors', jsonb_build_object('id', pg_temp.uid(162), 'tenant_id', pg_temp.ta(), 'doctor_code', 'DR00002', 'display_name', 'Dr Synthetic One (dup)', 'name_normalised', 'dr synthetic one dup',
  'source', 'quick_add', 'merged_into_id', pg_temp.uid(161), 'is_active', false));
SELECT pg_temp.ins('catalog.catalog_state', jsonb_build_object('tenant_id', pg_temp.ta(), 'catalog_root_id', pg_temp.uid(95), 'catalog_revision', 5));
SELECT pg_temp.ins('catalog.catalog_state', jsonb_build_object('tenant_id', pg_temp.tb(), 'catalog_root_id', pg_temp.uid(96), 'catalog_revision', 7));
SELECT pg_temp.ins('catalog.cs_tax_types', jsonb_build_object('id', pg_temp.uid(101), 'tenant_id', pg_temp.ta(), 'code', 'LUX', 'display', 'Synthetic levy', 'rate_bp', 500, 'effective_from', '2026-01-01T00:00:00Z'::timestamptz));
SELECT pg_temp.ins('catalog.tax_rules', jsonb_build_object('id', pg_temp.uid(111), 'tenant_id', pg_temp.ta(), 'scope', 'tenant_default', 'vat_treatment', 'exempt', 'effective_from', '2026-01-01T00:00:00Z'::timestamptz));
SELECT pg_temp.ins('catalog.surcharge_rules', jsonb_build_object('id', pg_temp.uid(121), 'tenant_id', pg_temp.ta(), 'scope', 'all', 'amount_kind', 'flat', 'amount_paisa', 500, 'effective_from', '2026-01-01T00:00:00Z'::timestamptz));
SELECT pg_temp.ins('catalog.comment_codes', jsonb_build_object('id', pg_temp.uid(131), 'tenant_id', pg_temp.ta(), 'code', 'NOTE1', 'text', 'Synthetic comment'));
SELECT pg_temp.ins('catalog.comment_code_texts', jsonb_build_object('id', pg_temp.uid(141), 'tenant_id', pg_temp.ta(), 'comment_code_id', pg_temp.uid(131), 'text_version', 1, 'text', 'Synthetic comment', 'effective_from', '2026-01-01T00:00:00Z'::timestamptz));
SELECT pg_temp.ins('catalog.instrument_code_maps', jsonb_build_object('id', pg_temp.uid(91), 'tenant_id', pg_temp.ta(), 'instrument_id', pg_temp.uid(99), 'direction', 'inbound', 'instrument_code', 'HGB',
  'analyte_id', pg_temp.uid(21), 'test_id', pg_temp.uid(11)));
SELECT cmp_ok((SELECT count(*)::int FROM catalog.departments WHERE tenant_id IN (pg_temp.ta(), pg_temp.tb())), '=', 2, 'fixtures: one department per synthetic tenant');

-- ===================================================================================================================================== §11 test 1
-- §11 test 1 (generated probes cover all 38 tables; these add explicit cases on tables of every shape)
SELECT is(pg_temp.a(format('SELECT 1 FROM catalog.%I WHERE tenant_id = %L', t, pg_temp.tb()), 'n'), 'n=0', 'tenant A claims see zero tenant B rows of catalog.' || t)
  FROM unnest(ARRAY['departments', 'orderables', 'tests', 'analytes', 'reference_range_sets', 'price_lists', 'price_list_versions', 'price_list_items', 'catalog_state']) t;
SELECT is(pg_temp.a(format('SELECT 1 FROM catalog.%I WHERE tenant_id = %L', t, pg_temp.ta()), 'n') <> 'n=0', true, 'positive control: tenant A claims DO see tenant A rows of catalog.' || t)
  FROM unnest(ARRAY['departments', 'orderables', 'tests', 'analytes', 'reference_range_sets', 'price_lists', 'price_list_versions', 'price_list_items', 'catalog_state']) t;
SELECT is(pg_temp.a(format($$INSERT INTO catalog.departments (id, tenant_id, code, name, created_by, updated_by) VALUES (%L, %L, 'XTEN', 'x', %L, %L)$$, pg_temp.uid(901), pg_temp.tb(), pg_temp.sys(), pg_temp.sys())),
  'E42501', 'INSERT of a tenant B department by tenant A claims fails the policy');
SELECT is(pg_temp.a(format($$UPDATE catalog.departments SET name = 'hijack' WHERE tenant_id = %L$$, pg_temp.tb())), 'n=0', 'UPDATE of tenant B departments affects 0 rows');
SELECT is(pg_temp.a(format($$UPDATE catalog.departments SET tenant_id = %L WHERE tenant_id = %L$$, pg_temp.tb(), pg_temp.ta())), 'E42501', 'moving a department to tenant B violates WITH CHECK');
SELECT is(pg_temp.a(format($$DELETE FROM catalog.price_list_items WHERE tenant_id = %L$$, pg_temp.tb())), 'n=0', 'DELETE of tenant B price items affects 0 rows');
SELECT is(pg_temp.a(format($$DELETE FROM catalog.departments WHERE tenant_id = %L$$, pg_temp.ta())), 'E42501', 'DELETE on a master table is not granted (permission denied)');
SELECT is(pg_temp.b(format($$SELECT 1 FROM catalog.departments WHERE tenant_id = %L$$, pg_temp.ta()), 'n'), 'n=0', 'tenant B claims see zero tenant A departments');
SELECT is(pg_temp.x('lims_app', NULL, 'SELECT 1 FROM catalog.departments', 'n'), 'n=0', 'no claims: zero rows (fail-closed)');

-- ===================================================================================================================================== §11 test 9
-- §11 test 9: partner / patient / portal claims carrying the tenant id see 0 rows (app.is_staff_or_system())
SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), a), format('SELECT 1 FROM catalog.%I', t), 'n'), 'n=0', a || ' claims see 0 rows of catalog.' || t)
  FROM unnest(ARRAY['partner', 'patient', 'portal']) a CROSS JOIN unnest(ARRAY['departments', 'orderables', 'tests', 'analytes', 'analyte_versions', 'reference_range_sets', 'reference_ranges',
    'price_lists', 'price_list_versions', 'price_list_items', 'doctors', 'credit_parties', 'cs_tax_types', 'tax_rules', 'surcharge_rules', 'comment_codes', 'comment_code_texts',
    'instrument_code_maps', 'imports', 'catalog_state']) t;
SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), a), format($$INSERT INTO catalog.departments (id, tenant_id, code, name, created_by, updated_by) VALUES (%L, %L, 'XACT', 'x', %L, %L)$$,
  pg_temp.uid(902), pg_temp.ta(), pg_temp.sys(), pg_temp.sys()), 'w'), 'E42501', a || ' claims cannot INSERT a department')
  FROM unnest(ARRAY['partner', 'patient', 'portal']) a;
SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), a), format($$UPDATE catalog.departments SET name = 'x' WHERE tenant_id = %L$$, pg_temp.ta()), 'w'), 'n=0', a || ' claims cannot UPDATE a department')
  FROM unnest(ARRAY['partner', 'patient', 'portal']) a;
SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), 'system'), 'SELECT 1 FROM catalog.departments', 'n') <> 'n=0', true, 'a system actor of the tenant reads (positive control, 08 R8)');
SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), 'partner'), 'SELECT 1 FROM catalog.v_pub_department', 'n'), 'n=0', 'partner claims see 0 rows through the published view too (security_invoker)');

-- ===================================================================================================================================== §11 test 3
-- §11 test 3: published analyte_versions are immutable; superseded -> published rejected; children of a published parent frozen
SELECT is(pg_temp.a(format($$UPDATE catalog.analyte_versions SET unit_code = 'mg_dl' WHERE id = %L$$, pg_temp.uid(31))), 'EP0001', 'clinical column of a published analyte_versions row cannot change');
SELECT is(pg_temp.a(format($$UPDATE catalog.analyte_versions SET decimals = 3 WHERE id = %L$$, pg_temp.uid(31))), 'EP0001', 'decimals of a published analyte_versions row cannot change');
SELECT is(pg_temp.a(format($$UPDATE catalog.analyte_versions SET effective_to = now() + interval '1 day', change_reason = 'changed', version = version + 1 WHERE id = %L$$, pg_temp.uid(31))), 'EP0001',
  'change_reason is not on the mutable list of a published row');
SELECT is(pg_temp.a(format($$UPDATE catalog.analyte_versions SET effective_to = now() + interval '1 day', updated_at = now(), updated_by = %L, version = version + 1 WHERE id = %L$$, pg_temp.sys(), pg_temp.uid(31))), 'n=1',
  'effective_to / updated_* / version stay mutable on a published row');
SELECT is(pg_temp.a(format($$UPDATE catalog.analyte_versions SET status = 'published' WHERE id = %L$$, pg_temp.uid(35))), 'EP0001', 'superseded -> published is rejected');
SELECT is(pg_temp.a(format($$UPDATE catalog.analyte_versions SET status = 'draft' WHERE id = %L$$, pg_temp.uid(31))), 'EP0001', 'published -> draft is rejected');
SELECT is(pg_temp.a(format($$UPDATE catalog.analyte_versions SET status = 'superseded' WHERE id = %L$$, pg_temp.uid(35))), 'EP0001', 'superseded -> superseded is rejected (nothing out of superseded)');
SELECT is(pg_temp.a(format($$UPDATE catalog.analyte_versions SET unit_code = 'mg_dl' WHERE id = %L$$, pg_temp.uid(32))), 'n=1', 'a draft analyte_versions row is editable');
SELECT is(pg_temp.a(format($$UPDATE catalog.analyte_versions SET status = 'published'%s WHERE id = %L$$, pg_temp.pub(), pg_temp.uid(36))), 'n=1', 'draft -> published is allowed (with published fields)');
SELECT is(pg_temp.a(format($$UPDATE catalog.analyte_versions SET status = 'draft' WHERE id = %L$$, pg_temp.uid(36))), 'EP0001', 'published -> draft is rejected after a legal publish');
SELECT is(pg_temp.a(format($$INSERT INTO catalog.reference_ranges (id, tenant_id, set_id, sex, kind, low, high, created_by) VALUES (%L, %L, %L, 'any', 'numeric', 1, 2, %L)$$,
  pg_temp.uid(52), pg_temp.ta(), pg_temp.uid(41), pg_temp.sys())), 'EP0001', 'INSERT into reference_ranges of a published set is rejected');
SELECT is(pg_temp.a(format($$UPDATE catalog.reference_ranges SET high = 3 WHERE id = %L$$, pg_temp.uid(51))), 'EP0001', 'UPDATE of a band of a published set is rejected');
SELECT is(pg_temp.a(format($$DELETE FROM catalog.reference_ranges WHERE id = %L$$, pg_temp.uid(51))), 'EP0001', 'DELETE of a band of a published set is rejected');
SELECT is(pg_temp.a(format($$INSERT INTO catalog.critical_limits (id, tenant_id, set_id, sex, low, created_by) VALUES (%L, %L, %L, 'any', 1, %L)$$, pg_temp.uid(53), pg_temp.ta(), pg_temp.uid(45), pg_temp.sys())),
  'EP0001', 'INSERT into critical_limits of a published set is rejected');
SELECT is(pg_temp.a(format($$DELETE FROM catalog.price_list_items WHERE id = %L$$, pg_temp.uid(81))), 'EP0001', 'DELETE of an item of a published price version is rejected');
SELECT is(pg_temp.a(format($$UPDATE catalog.price_list_items SET unit_price_paisa = 1 WHERE id = %L$$, pg_temp.uid(81))), 'EP0001', 'UPDATE of an item of a published price version is rejected');
SELECT is(pg_temp.a(format($$UPDATE catalog.price_list_versions SET change_reason = 'x' WHERE id = %L$$, pg_temp.uid(71))), 'EP0001', 'clinical/money columns of a published price version are frozen');
SELECT is(pg_temp.a(format($$INSERT INTO catalog.formula_dependencies (tenant_id, analyte_version_id, analyte_id, input_analyte_id, created_by) VALUES (%L, %L, %L, %L, %L)$$,
  pg_temp.ta(), pg_temp.uid(31), pg_temp.uid(21), pg_temp.uid(22), pg_temp.sys())), 'EP0001', 'INSERT into formula_dependencies of a published version is rejected');
-- draft children stay writable
SELECT is(pg_temp.a(format($$INSERT INTO catalog.reference_ranges (id, tenant_id, set_id, sex, kind, low, high, created_by) VALUES (%L, %L, %L, 'any', 'numeric', 1, 2, %L)$$,
  pg_temp.uid(54), pg_temp.ta(), pg_temp.uid(42), pg_temp.sys())), 'n=1', 'INSERT into reference_ranges of a DRAFT set works');
SELECT is(pg_temp.a(format($$UPDATE catalog.price_list_items SET unit_price_paisa = 2500 WHERE id = %L$$, pg_temp.uid(83))), 'n=1', 'UPDATE of an item of a DRAFT price version works');
SELECT is(pg_temp.a(format($$DELETE FROM catalog.reference_ranges WHERE id = %L$$, pg_temp.uid(54))), 'n=1', 'DELETE of a band of a DRAFT set works');
SELECT is(pg_temp.a(format($$INSERT INTO catalog.formula_dependencies (tenant_id, analyte_version_id, analyte_id, input_analyte_id, created_by) VALUES (%L, %L, %L, %L, %L)$$,
  pg_temp.ta(), pg_temp.uid(32), pg_temp.uid(22), pg_temp.uid(21), pg_temp.sys())), 'n=1', 'INSERT into formula_dependencies of a DRAFT version works');
SELECT is(pg_temp.a(format($$INSERT INTO catalog.formula_dependencies (tenant_id, analyte_version_id, analyte_id, input_analyte_id, created_by) VALUES (%L, %L, %L, %L, %L)$$,
  pg_temp.ta(), pg_temp.uid(32), pg_temp.uid(22), pg_temp.uid(22), pg_temp.sys())), 'E23514', 'a formula analyte cannot depend on itself (not_self check)');
-- a draft parent of ANOTHER tenant must not satisfy the draft test (parent lookup is tenant-scoped and RLS-bound)
SELECT is(pg_temp.a(format($$INSERT INTO catalog.price_list_items (id, tenant_id, price_list_version_id, orderable_id, unit_price_paisa, created_by, updated_by) VALUES (%L, %L, %L, %L, 1, %L, %L)$$,
  pg_temp.uid(85), pg_temp.ta(), pg_temp.uid(73), pg_temp.uid(11), pg_temp.sys(), pg_temp.sys())) IN ('EP0001', 'E23503'), true, 'an item cannot hang under a tenant B version (draft test or FK rejects)');

-- ===================================================================================================================================== §11 test 4
-- §11 test 4: composite FK probes (tenant_id leads every reference)
SELECT is(pg_temp.a(format($$INSERT INTO catalog.price_list_items (id, tenant_id, price_list_version_id, orderable_id, unit_price_paisa, created_by, updated_by) VALUES (%L, %L, %L, %L, 1, %L, %L)$$,
  pg_temp.uid(86), pg_temp.ta(), pg_temp.uid(72), pg_temp.uid(12), pg_temp.sys(), pg_temp.sys())), 'E23503', 'price_list_items (tenant A) -> tenant B orderable: FK violation');
SELECT is(pg_temp.a(format($$INSERT INTO catalog.price_list_assignments (id, tenant_id, price_list_id, owner_kind, centre_id, created_by) VALUES (%L, %L, %L, 'centre', %L, %L)$$,
  pg_temp.uid(171), pg_temp.ta(), pg_temp.uid(62), '01a1a98a-ac40-7000-8000-00000000b201', pg_temp.sys())), 'E23503', 'price_list_assignments (tenant A) -> tenant B centre: FK violation');
SELECT is(pg_temp.a(format($$INSERT INTO catalog.price_list_assignments (id, tenant_id, price_list_id, owner_kind, centre_id, created_by) VALUES (%L, %L, %L, 'centre', %L, %L)$$,
  pg_temp.uid(172), pg_temp.ta(), pg_temp.uid(62), '01a1a98a-ac40-7000-8000-00000000a201', pg_temp.sys())), 'n=1', 'price_list_assignments (tenant A) -> tenant A centre works (positive control)');
SELECT is(pg_temp.a(format($$INSERT INTO catalog.price_list_assignments (id, tenant_id, price_list_id, owner_kind, centre_id, created_by) VALUES (%L, %L, %L, 'centre', %L, %L)$$,
  pg_temp.uid(173), pg_temp.ta(), pg_temp.uid(62), '01a1a98a-ac40-7000-8000-00000000a201', pg_temp.sys())), 'E23505', 'one assignment per centre (partial unique)');
SELECT is(pg_temp.a(format($$INSERT INTO catalog.price_list_assignments (id, tenant_id, price_list_id, owner_kind, credit_party_id, created_by) VALUES (%L, %L, %L, 'centre', %L, %L)$$,
  pg_temp.uid(174), pg_temp.ta(), pg_temp.uid(62), pg_temp.uid(161), pg_temp.sys())), 'E23514', 'assignment owner_kind must match the populated owner column (one_owner check)');
SELECT is(pg_temp.a(format($$INSERT INTO catalog.instrument_code_maps (id, tenant_id, instrument_id, direction, instrument_code, analyte_id, test_id, created_by, updated_by)
  VALUES (%L, %L, %L, 'outbound', 'GLUX', %L, %L, %L, %L)$$, pg_temp.uid(92), pg_temp.ta(), pg_temp.uid(99), pg_temp.uid(24), pg_temp.uid(11), pg_temp.sys(), pg_temp.sys())),
  'E23503', 'instrument_code_maps: analyte of a DIFFERENT test: FK violation');
SELECT is(pg_temp.a(format($$INSERT INTO catalog.instrument_code_maps (id, tenant_id, instrument_id, direction, instrument_code, analyte_id, test_id, created_by, updated_by)
  VALUES (%L, %L, %L, 'outbound', 'GLUX', %L, %L, %L, %L)$$, pg_temp.uid(92), pg_temp.ta(), pg_temp.uid(99), pg_temp.uid(24), pg_temp.uid(14), pg_temp.sys(), pg_temp.sys())),
  'n=1', 'instrument_code_maps: analyte of its own test works (positive control; instrument_id has no FK)');
SELECT is(pg_temp.a(format($$INSERT INTO catalog.instrument_code_maps (id, tenant_id, instrument_id, direction, instrument_code, analyte_id, test_id, created_by, updated_by)
  VALUES (%L, %L, %L, 'inbound', 'ZZ', %L, %L, %L, %L)$$, pg_temp.uid(93), pg_temp.ta(), pg_temp.uid(99), pg_temp.uid(23), pg_temp.uid(12), pg_temp.sys(), pg_temp.sys())),
  'E23503', 'instrument_code_maps (tenant A) -> tenant B analyte/test: FK violation');
SELECT is(pg_temp.a(format($$INSERT INTO catalog.analytes (id, tenant_id, test_id, code, name, created_by, updated_by) VALUES (%L, %L, %L, 'XX', 'x', %L, %L)$$,
  pg_temp.uid(25), pg_temp.ta(), pg_temp.uid(12), pg_temp.sys(), pg_temp.sys())), 'E23503', 'analytes (tenant A) -> tenant B test: FK violation');
SELECT is(pg_temp.a(format($$INSERT INTO catalog.panel_members (tenant_id, panel_id, member_orderable_id, sort_order, created_by) VALUES (%L, %L, %L, 1, %L)$$,
  pg_temp.ta(), pg_temp.uid(13), pg_temp.uid(12), pg_temp.sys())), 'E23503', 'panel_members (tenant A) -> tenant B member orderable: FK violation');
SELECT is(pg_temp.a(format($$INSERT INTO catalog.panel_members (tenant_id, panel_id, member_orderable_id, sort_order, created_by) VALUES (%L, %L, %L, 1, %L)$$,
  pg_temp.ta(), pg_temp.uid(13), pg_temp.uid(13), pg_temp.sys())), 'E23514', 'a panel cannot contain itself');

-- ===================================================================================================================================== §11 test 5
-- §11 test 5: catalog_state.catalog_revision only increases
SELECT is(pg_temp.a(format($$UPDATE catalog.catalog_state SET catalog_revision = 4 WHERE tenant_id = %L$$, pg_temp.ta())), 'EP0001', 'catalog_revision decrease -> P0001');
SELECT is(pg_temp.a(format($$UPDATE catalog.catalog_state SET catalog_root_id = %L WHERE tenant_id = %L$$, pg_temp.uid(97), pg_temp.ta())), 'EP0001', 'catalog_root_id cannot change');
SELECT is(pg_temp.a(format($$UPDATE catalog.catalog_state SET catalog_revision = 6 WHERE tenant_id = %L$$, pg_temp.ta())), 'n=1', 'catalog_revision increase works');
SELECT is(pg_temp.a(format($$UPDATE catalog.catalog_state SET catalog_revision = 6 WHERE tenant_id = %L$$, pg_temp.ta())), 'n=1', 'catalog_revision unchanged is allowed (non-decreasing)');
SELECT is((SELECT catalog_revision FROM catalog.catalog_state WHERE tenant_id = pg_temp.ta()), 6::bigint, 'revision is 6 after the legal updates');
SELECT is(pg_temp.a(format($$UPDATE catalog.catalog_state SET catalog_revision = 99 WHERE tenant_id = %L$$, pg_temp.tb())), 'n=0', 'tenant A cannot bump tenant B revision');

-- ===================================================================================================================================== §11 test 6
-- §11 test 6: partial uniques
SELECT is(pg_temp.a(format($$INSERT INTO catalog.analyte_versions (id, tenant_id, analyte_id, version_no, result_type, decimals, created_by, updated_by) VALUES (%L, %L, %L, 2, 'numeric', 1, %L, %L)$$,
  pg_temp.uid(37), pg_temp.ta(), pg_temp.uid(22), pg_temp.sys(), pg_temp.sys())), 'E23505', 'second draft analyte_versions row for one analyte: unique violation');
SELECT is(pg_temp.a(format($$INSERT INTO catalog.reference_range_sets (id, tenant_id, analyte_id, version_no, created_by, updated_by) VALUES (%L, %L, %L, 2, %L, %L)$$,
  pg_temp.uid(43), pg_temp.ta(), pg_temp.uid(22), pg_temp.sys(), pg_temp.sys())), 'E23505', 'second draft reference_range_sets row for one analyte: unique violation');
SELECT is(pg_temp.a(format($$INSERT INTO catalog.price_list_versions (id, tenant_id, price_list_id, version_no, created_by, updated_by) VALUES (%L, %L, %L, 2, %L, %L)$$,
  pg_temp.uid(75), pg_temp.ta(), pg_temp.uid(62), pg_temp.sys(), pg_temp.sys())), 'E23505', 'second draft price_list_versions row for one list: unique violation');
SELECT is(pg_temp.a(format($$INSERT INTO catalog.price_lists (id, tenant_id, code, name, owner_kind, created_by, updated_by) VALUES (%L, %L, 'DEF2', 'second default', 'default', %L, %L)$$,
  pg_temp.uid(65), pg_temp.ta(), pg_temp.sys(), pg_temp.sys())), 'E23505', 'second default price list: unique violation');
SELECT is(pg_temp.a(format($$UPDATE catalog.price_lists SET is_active = false WHERE id = %L$$, pg_temp.uid(61))), 'E23514', 'the default price list cannot be deactivated (default_active check)');
SELECT is(pg_temp.a(format($$INSERT INTO catalog.instrument_code_maps (id, tenant_id, instrument_id, direction, instrument_code, analyte_id, test_id, created_by, updated_by)
  VALUES (%L, %L, %L, 'both', 'HGB', %L, %L, %L, %L)$$, pg_temp.uid(94), pg_temp.ta(), pg_temp.uid(99), pg_temp.uid(22), pg_temp.uid(11), pg_temp.sys(), pg_temp.sys())),
  'E23505', 'second active inbound map for the same (instrument, code): unique violation');
SELECT is(pg_temp.a(format($$INSERT INTO catalog.instrument_code_maps (id, tenant_id, instrument_id, direction, instrument_code, analyte_id, test_id, is_active, created_by, updated_by)
  VALUES (%L, %L, %L, 'inbound', 'HGB', %L, %L, false, %L, %L)$$, pg_temp.uid(95), pg_temp.ta(), pg_temp.uid(99), pg_temp.uid(22), pg_temp.uid(11), pg_temp.sys(), pg_temp.sys())),
  'n=1', 'an INACTIVE duplicate inbound map is allowed (partial index is WHERE is_active)');
SELECT is(pg_temp.a(format($$INSERT INTO catalog.tat_targets (id, tenant_id, test_id, priority, target_seconds, effective_from, created_by, updated_by) VALUES (%L, %L, %L, 'routine', 3600, now(), %L, %L)$$,
  pg_temp.uid(181), pg_temp.ta(), pg_temp.uid(11), pg_temp.sys(), pg_temp.sys())), 'n=1', 'first open tat_targets row works');
SELECT is(pg_temp.a(format($$INSERT INTO catalog.tat_targets (id, tenant_id, test_id, priority, target_seconds, effective_from, created_by, updated_by) VALUES (%L, %L, %L, 'routine', 7200, now(), %L, %L)$$,
  pg_temp.uid(182), pg_temp.ta(), pg_temp.uid(11), pg_temp.sys(), pg_temp.sys())), 'E23505', 'second open tat_targets row for (test, priority): unique violation');
SELECT is(pg_temp.a(format($$INSERT INTO catalog.orderables (id, tenant_id, kind, code, name, created_by, updated_by) VALUES (%L, %L, 'test', 'NODEPT', 'x', %L, %L)$$,
  pg_temp.uid(15), pg_temp.ta(), pg_temp.sys(), pg_temp.sys())), 'E23514', 'a test orderable needs a department');
SELECT is(pg_temp.a(format($$INSERT INTO catalog.doctors (id, tenant_id, doctor_code, display_name, name_normalised, source, merged_into_id, is_active, created_by, updated_by)
  VALUES (%L, %L, 'DR00003', 'x', 'x', 'import', %L, true, %L, %L)$$, pg_temp.uid(163), pg_temp.ta(), pg_temp.uid(161), pg_temp.sys(), pg_temp.sys())), 'E23514', 'a merged doctor must be inactive');

-- ===================================================================================================================================== §11 test 7
-- §11 test 7: views as a tenant A reader (security_invoker catalogue check: T0B-10.C3_schema.test.sql)
SELECT is(pg_temp.a('SELECT 1 FROM catalog.v_pub_department', 'n'), 'n=1', 'tenant A reader sees only its department through v_pub_department');
SELECT is(pg_temp.b('SELECT 1 FROM catalog.v_pub_department', 'n'), 'n=1', 'tenant B reader sees only its department through v_pub_department');
SELECT is(pg_temp.a(format('SELECT 1 FROM catalog.v_pub_department WHERE tenant_id = %L', pg_temp.tb()), 'n'), 'n=0', 'tenant A reader sees no tenant B row through v_pub_department');
SELECT is(pg_temp.a(format('SELECT 1 FROM catalog.v_pub_test_directory WHERE tenant_id = %L', pg_temp.tb()), 'n'), 'n=0', 'tenant A reader sees no tenant B row through v_pub_test_directory');
SELECT is(pg_temp.a('SELECT 1 FROM catalog.v_pub_test_directory', 'n'), 'n=2', 'v_pub_test_directory lists the two tenant A tests (panel excluded)');
SELECT is(pg_temp.a(format('SELECT 1 FROM catalog.v_pub_test_directory WHERE test_id = %L', pg_temp.uid(13)), 'n'), 'n=0', 'a panel is not a test_directory row');
SELECT is(pg_temp.a(format('SELECT 1 FROM catalog.v_pub_test_directory WHERE test_id = %L AND workflow_type = ''standard'' AND department_id = %L', pg_temp.uid(11), pg_temp.uid(1)), 'n'), 'n=1', 'test_directory carries workflow_type and department_id');
SELECT is(pg_temp.a('SELECT 1 FROM catalog.v_pub_price_list_items', 'n'), 'n=1', 'v_pub_price_list_items: only published/superseded versions of ACTIVE lists (draft pvA2 and inactive-list pvX excluded)');
SELECT is(pg_temp.a(format('SELECT 1 FROM catalog.v_pub_price_list_items WHERE price_list_id = %L AND price_list_version = 1 AND owner_kind = ''default'' AND owner_id IS NULL AND orderable_id = %L AND unit_price_paisa = 1000 AND falls_through',
  pg_temp.uid(61), pg_temp.uid(11)), 'n'), 'n=1', 'default list row: owner_id NULL, unit_price_paisa, falls_through true (08 A13 D-19)');
SELECT is(pg_temp.a(format('SELECT 1 FROM catalog.v_pub_price_list_items WHERE price_list_id = %L', pg_temp.uid(64)), 'n'), 'n=0', 'an inactive list is excluded from v_pub_price_list_items');
SELECT is(pg_temp.a(format('SELECT 1 FROM catalog.v_pub_price_list_items WHERE tenant_id = %L', pg_temp.tb()), 'n'), 'n=0', 'tenant A reader sees no tenant B price row');
SELECT is(pg_temp.a('SELECT 1 FROM catalog.v_pub_referrer_directory', 'n'), 'n=2', 'v_pub_referrer_directory lists both tenant A doctor rows (merged one included, inactive)');
SELECT is(pg_temp.a(format('SELECT 1 FROM catalog.v_pub_referrer_directory WHERE referrer_id = %L AND canonical_referrer_id = %L AND NOT is_active', pg_temp.uid(162), pg_temp.uid(161)), 'n'), 'n=1',
  'merged doctor resolves to its canonical referrer (CR-C3-004)');
SELECT is(pg_temp.a(format('SELECT 1 FROM catalog.v_pub_referrer_directory WHERE referrer_id = %L AND canonical_referrer_id = referrer_id', pg_temp.uid(161)), 'n'), 'n=1', 'an unmerged doctor is its own canonical referrer');
SELECT is(pg_temp.b('SELECT 1 FROM catalog.v_pub_referrer_directory', 'n'), 'n=0', 'tenant B reader sees no tenant A doctor');
SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), 'patient'), 'SELECT 1 FROM catalog.v_pub_test_directory', 'n'), 'n=0', 'patient claims see no row through v_pub_test_directory');

-- ===================================================================================================================================== §11 test 8
-- §11 test 8: cs_tax_types
SELECT is(pg_temp.a(format($$INSERT INTO catalog.cs_tax_types (id, tenant_id, code, display, rate_bp, effective_from, created_by, updated_by) VALUES (%L, %L, 'LUX', 'again', 600, '2026-06-01T00:00:00Z', %L, %L)$$,
  pg_temp.uid(102), pg_temp.ta(), pg_temp.sys(), pg_temp.sys())), 'E23505', 'second OPEN version of one tax-type code: unique violation');
SELECT is(pg_temp.a(format($$UPDATE catalog.cs_tax_types SET rate_bp = 900 WHERE id = %L$$, pg_temp.uid(101))), 'EP0001', 'UPDATE of rate_bp -> P0001 (a rate change is a new row)');
SELECT is(pg_temp.a(format($$UPDATE catalog.cs_tax_types SET effective_from = '2026-02-01T00:00:00Z' WHERE id = %L$$, pg_temp.uid(101))), 'EP0001', 'UPDATE of effective_from -> P0001');
SELECT is(pg_temp.a(format($$UPDATE catalog.cs_tax_types SET code = 'LUX2' WHERE id = %L$$, pg_temp.uid(101))), 'EP0001', 'UPDATE of code -> P0001');
SELECT is(pg_temp.a(format($$UPDATE catalog.cs_tax_types SET display = 'Renamed', sort_order = 5 WHERE id = %L$$, pg_temp.uid(101))), 'n=1', 'display / sort_order stay mutable');
SELECT is(pg_temp.a(format($$INSERT INTO catalog.cs_tax_types (id, tenant_id, code, display, rate_bp, effective_from, created_by, updated_by) VALUES (%L, %L, 'VAT', 'no', 1300, now(), %L, %L)$$,
  pg_temp.uid(103), pg_temp.ta(), pg_temp.sys(), pg_temp.sys())), 'E23514', 'tenant tax type code VAT is reserved for g_tax_types (not_vat check)');
SELECT is(pg_temp.a(format($$UPDATE catalog.cs_tax_types SET effective_to = '2026-06-01T00:00:00Z' WHERE id = %L$$, pg_temp.uid(101))), 'n=1', 'closing the open version (effective_to) works');
SELECT is(pg_temp.a(format($$INSERT INTO catalog.cs_tax_types (id, tenant_id, code, display, rate_bp, effective_from, created_by, updated_by) VALUES (%L, %L, 'LUX', 'new rate', 600, '2026-06-01T00:00:00Z', %L, %L)$$,
  pg_temp.uid(104), pg_temp.ta(), pg_temp.sys(), pg_temp.sys())), 'n=1', 'after closing, a new open version of the same code works (rate change = new row)');
SELECT is(pg_temp.a(format($$INSERT INTO catalog.tax_rules (id, tenant_id, scope, department_id, vat_treatment, other_tax_code, effective_from, created_by, updated_by)
  VALUES (%L, %L, 'department', %L, 'taxable', 'NOPE', now(), %L, %L)$$, pg_temp.uid(112), pg_temp.ta(), pg_temp.uid(1), pg_temp.sys(), pg_temp.sys())), 'E23503', 'tax_rules with an unknown other_tax_code -> 23503 (08 R18)');
SELECT is(pg_temp.a(format($$INSERT INTO catalog.tax_rules (id, tenant_id, scope, department_id, vat_treatment, other_tax_code, effective_from, created_by, updated_by)
  VALUES (%L, %L, 'department', %L, 'taxable', 'LUX', now(), %L, %L)$$, pg_temp.uid(113), pg_temp.ta(), pg_temp.uid(1), pg_temp.sys(), pg_temp.sys())), 'n=1', 'tax_rules with a known other_tax_code works');
SELECT is(pg_temp.b(format($$INSERT INTO catalog.tax_rules (id, tenant_id, scope, department_id, vat_treatment, other_tax_code, effective_from, created_by, updated_by)
  VALUES (%L, %L, 'tenant_default', NULL, 'taxable', 'LUX', now(), %L, %L)$$, pg_temp.uid(114), pg_temp.tb(), pg_temp.sys(), pg_temp.sys())), 'E23503',
  'tenant B cannot reference the tax-type code of tenant A (lookup is tenant-scoped)');

-- ===================================================================================================================================== §11 test 10
-- §11 test 10: comment_code_texts
SELECT is(pg_temp.a(format($$UPDATE catalog.comment_code_texts SET text = 'edited' WHERE id = %L$$, pg_temp.uid(141))), 'EP0001', 'UPDATE of comment text -> P0001 (history row)');
SELECT is(pg_temp.a(format($$UPDATE catalog.comment_code_texts SET effective_from = '2026-02-01T00:00:00Z' WHERE id = %L$$, pg_temp.uid(141))), 'EP0001', 'UPDATE of effective_from -> P0001');
SELECT is(pg_temp.a(format($$INSERT INTO catalog.comment_code_texts (id, tenant_id, comment_code_id, text_version, text, effective_from, created_by, updated_by) VALUES (%L, %L, %L, 2, 'dup', '2026-01-01T00:00:00Z', %L, %L)$$,
  pg_temp.uid(142), pg_temp.ta(), pg_temp.uid(131), pg_temp.sys(), pg_temp.sys())), 'E23505', 'second text row with the same (comment_code_id, effective_from): unique violation');
SELECT is(pg_temp.a(format($$UPDATE catalog.comment_code_texts SET effective_to = '2026-03-01T00:00:00Z' WHERE id = %L$$, pg_temp.uid(141))), 'n=1', 'closing a text version (effective_to) works');
SELECT is(pg_temp.a(format($$INSERT INTO catalog.comment_code_texts (id, tenant_id, comment_code_id, text_version, text, effective_from, created_by, updated_by) VALUES (%L, %L, %L, 2, 'next', '2026-03-01T00:00:00Z', %L, %L)$$,
  pg_temp.uid(143), pg_temp.ta(), pg_temp.uid(131), pg_temp.sys(), pg_temp.sys())), 'n=1', 'the successor text version is a new INSERT');
SELECT is(pg_temp.a(format($$UPDATE catalog.comment_code_texts SET effective_to = '2025-01-01T00:00:00Z' WHERE id = %L$$, pg_temp.uid(143))), 'E23514', 'effective_to before effective_from violates the window check');

-- ===================================================================================================================================== §11 test 11
-- §11 test 11: tax_rules / surcharge_rules
SELECT is(pg_temp.a(format($$INSERT INTO catalog.tax_rules (id, tenant_id, scope, vat_treatment, effective_from, created_by, updated_by) VALUES (%L, %L, 'tenant_default', 'taxable', now(), %L, %L)$$,
  pg_temp.uid(115), pg_temp.ta(), pg_temp.sys(), pg_temp.sys())), 'E23505', 'second open tenant_default tax rule: unique violation');
SELECT is(pg_temp.a(format($$INSERT INTO catalog.tax_rules (id, tenant_id, scope, department_id, vat_treatment, effective_from, created_by, updated_by) VALUES (%L, %L, 'department', %L, 'exempt', now(), %L, %L)$$,
  pg_temp.uid(116), pg_temp.ta(), pg_temp.uid(1), pg_temp.sys(), pg_temp.sys())), 'E23505', 'second open rule for the same department (trA2 from test 8 is open): unique violation');
SELECT is(pg_temp.a(format($$UPDATE catalog.tax_rules SET vat_treatment = 'taxable' WHERE id = %L$$, pg_temp.uid(111))), 'EP0001', 'UPDATE of vat_treatment -> P0001');
SELECT is(pg_temp.a(format($$UPDATE catalog.tax_rules SET other_tax_code = 'LUX' WHERE id = %L$$, pg_temp.uid(111))), 'EP0001', 'UPDATE of other_tax_code -> P0001');
SELECT is(pg_temp.a(format($$UPDATE catalog.tax_rules SET hs_code = '3002' WHERE id = %L$$, pg_temp.uid(111))), 'EP0001', 'UPDATE of hs_code -> P0001');
SELECT is(pg_temp.a(format($$UPDATE catalog.tax_rules SET effective_from = '2025-12-01T00:00:00Z' WHERE id = %L$$, pg_temp.uid(111))), 'EP0001', 'UPDATE of effective_from -> P0001');
SELECT is(pg_temp.a(format($$UPDATE catalog.tax_rules SET scope = 'department', department_id = %L WHERE id = %L$$, pg_temp.uid(1), pg_temp.uid(111))), 'EP0001', 'UPDATE of scope / key -> P0001');
SELECT is(pg_temp.a(format($$UPDATE catalog.surcharge_rules SET amount_paisa = 900 WHERE id = %L$$, pg_temp.uid(121))), 'EP0001', 'UPDATE of amount_paisa -> P0001');
SELECT is(pg_temp.a(format($$UPDATE catalog.surcharge_rules SET amount_kind = 'percent', percent_bp = 5, amount_paisa = NULL WHERE id = %L$$, pg_temp.uid(121))), 'EP0001', 'UPDATE of amount_kind / percent_bp -> P0001');
SELECT is(pg_temp.a(format($$UPDATE catalog.surcharge_rules SET scope = 'department', department_id = %L WHERE id = %L$$, pg_temp.uid(1), pg_temp.uid(121))), 'EP0001', 'UPDATE of surcharge scope -> P0001');
SELECT is(pg_temp.a(format($$UPDATE catalog.surcharge_rules SET effective_from = '2025-12-01T00:00:00Z' WHERE id = %L$$, pg_temp.uid(121))), 'EP0001', 'UPDATE of surcharge effective_from -> P0001');
SELECT is(pg_temp.a(format($$UPDATE catalog.surcharge_rules SET effective_to = '2026-12-31T00:00:00Z' WHERE id = %L$$, pg_temp.uid(121))), 'n=1', 'UPDATE of surcharge effective_to succeeds');
SELECT is(pg_temp.a(format($$UPDATE catalog.surcharge_rules SET is_active = false WHERE id = %L$$, pg_temp.uid(121))), 'n=1', 'deactivating a surcharge rule succeeds');
SELECT is(pg_temp.a(format($$UPDATE catalog.tax_rules SET effective_to = '2026-12-31T00:00:00Z' WHERE id = %L$$, pg_temp.uid(111))), 'n=1', 'UPDATE of tax_rules effective_to succeeds');
SELECT is(pg_temp.a(format($$UPDATE catalog.tax_rules SET is_active = false WHERE id = %L$$, pg_temp.uid(113))), 'n=1', 'deactivating a tax rule succeeds');

-- ===================================================================================================================================== §11 test 12
-- §11 test 12: import_issues.expires_at NOT NULL; source_import_id accepted on INSERT, frozen after publish
SELECT is(pg_temp.a(format($$INSERT INTO catalog.import_issues (tenant_id, import_id, seq, severity, sheet, issue_code, message, created_by) VALUES (%L, %L, 1, 'error', 'Prices', 'price.negative', 'm', %L)$$,
  pg_temp.ta(), pg_temp.uid(151), pg_temp.sys())), 'E23502', 'import_issues INSERT without expires_at -> NOT NULL violation');
SELECT is(pg_temp.a(format($$INSERT INTO catalog.import_issues (tenant_id, import_id, seq, severity, sheet, issue_code, message, created_by, expires_at) VALUES (%L, %L, 1, 'error', 'Prices', 'price.negative', 'm', %L, now() + interval '30 days')$$,
  pg_temp.ta(), pg_temp.uid(151), pg_temp.sys())), 'n=1', 'import_issues INSERT with expires_at works');
SELECT is(pg_temp.a(format($$DELETE FROM catalog.import_issues WHERE import_id = %L$$, pg_temp.uid(151))), 'n=1', 'import_issues DELETE (purge / re-validate) is granted');
SELECT is(pg_temp.a(format($$INSERT INTO catalog.reference_range_sets (id, tenant_id, analyte_id, version_no, source_import_id, created_by, updated_by) VALUES (%L, %L, %L, 1, %L, %L, %L)$$,
  pg_temp.uid(44), pg_temp.ta(), pg_temp.uid(24), pg_temp.uid(151), pg_temp.sys(), pg_temp.sys())), 'n=1', 'reference_range_sets accepts source_import_id on INSERT');
SELECT is(pg_temp.a(format($$INSERT INTO catalog.analyte_versions (id, tenant_id, analyte_id, version_no, result_type, decimals, source_import_id, created_by, updated_by) VALUES (%L, %L, %L, 3, 'numeric', 1, %L, %L, %L)$$,
  pg_temp.uid(38), pg_temp.ta(), pg_temp.uid(21), pg_temp.uid(151), pg_temp.sys(), pg_temp.sys())), 'n=1', 'analyte_versions accepts source_import_id on INSERT');
SELECT is(pg_temp.a(format($$UPDATE catalog.analyte_versions SET source_import_id = %L WHERE id = %L$$, pg_temp.uid(152), pg_temp.uid(31))), 'EP0001', 'source_import_id of a published analyte_versions row cannot change');
SELECT is(pg_temp.a(format($$UPDATE catalog.reference_range_sets SET source_import_id = %L WHERE id = %L$$, pg_temp.uid(152), pg_temp.uid(41))), 'EP0001', 'source_import_id of a published reference_range_sets row cannot change');
SELECT is(pg_temp.a(format($$UPDATE catalog.critical_limit_sets SET source_import_id = %L WHERE id = %L$$, pg_temp.uid(152), pg_temp.uid(45))), 'EP0001', 'source_import_id of a published critical_limit_sets row cannot change');
SELECT is(pg_temp.a(format($$UPDATE catalog.reference_range_sets SET source_import_id = NULL WHERE id = %L$$, pg_temp.uid(41))), 'EP0001', 'source_import_id cannot be cleared after publish either');
SELECT is(pg_temp.a(format($$UPDATE catalog.imports SET status = 'validating' WHERE id = %L$$, pg_temp.uid(151))), 'n=1', 'imports.status is updatable (work record)');
SELECT is(pg_temp.a(format($$DELETE FROM catalog.imports WHERE id = %L$$, pg_temp.uid(151))), 'E42501', 'imports are never deleted (no DELETE grant)');
SELECT is(pg_temp.a(format($$INSERT INTO catalog.files (id, tenant_id, purpose, file_name, content_type, byte_size, sha256, content, created_by) VALUES (%L, %L, 'import_upload', 'a.xlsx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 3, %L, '\x010203', %L)$$, pg_temp.uid(191), pg_temp.ta(), repeat('b', 64), pg_temp.sys())), 'E23502', 'files INSERT without expires_at -> NOT NULL violation');
SELECT is(pg_temp.a(format($$INSERT INTO catalog.files (id, tenant_id, purpose, file_name, content_type, byte_size, sha256, content, expires_at, created_by) VALUES (%L, %L, 'import_upload', 'a.xlsx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 3, %L, '\x010203', now() + interval '30 days', %L)$$, pg_temp.uid(191), pg_temp.ta(), repeat('b', 64), pg_temp.sys())), 'n=1', 'files INSERT with expires_at works');
SELECT is(pg_temp.a(format($$DELETE FROM catalog.files WHERE id = %L$$, pg_temp.uid(191))), 'n=1', 'files DELETE (catalog.purge_files) is granted');
SELECT is((SELECT count(*)::int FROM audit.audit_log WHERE schema_name = 'catalog' AND table_name IN ('files', 'import_issues', 'catalog_state', 'code_counters')), 0, 'no audit row for the four non-audited tables (§5 rule 6)');
SELECT cmp_ok((SELECT count(*)::int FROM audit.audit_log WHERE schema_name = 'catalog' AND table_name = 'departments' AND action = 'INSERT'), '>=', 2, 'audited tables write audit rows (departments fixtures)');

SELECT * FROM finish();
ROLLBACK;
