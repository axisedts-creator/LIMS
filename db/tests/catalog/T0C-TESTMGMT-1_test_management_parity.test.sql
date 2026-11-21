-- T0C-TESTMGMT-1 pgTAP suite (LD-318; founder 2026-11-17 08:48 NPT "test management first priority") for migration
-- 20261117170000_catalog__test_management_parity.sql: additive columns on catalog.tests / analytes / analyte_versions / reference_ranges / panels / comment_codes,
-- the new catalog.test_categories and catalog.test_stage_tat_targets tables, value constraints, composite tenant FKs, RLS unchanged on the old tables and FORCE-d on the new ones,
-- deactivate-never-delete, published versions still immutable on the new version-side columns, idempotent re-apply.
-- Synthetic data only. One rolled-back transaction. RLS is never disabled: fixtures are written by the superuser test session with system claims (audit context),
-- every isolation assertion runs as SET LOCAL ROLE lims_app. Seeds 010 supply tenant A/B (a001/b001).
-- Run: bash db/tests/run-suites.sh db/tests/catalog/T0C-TESTMGMT-1_test_management_parity.test.sql   (docker; migrations + seeds loaded)
-- ASSUMPTIONS (brief gives labels, not column names; a different choice needs a ruling, not a silent test edit; names equal the wire names of testmgmt1-openapi.test.ts):
--  - catalog.tests gets the 24 test fields incl. category_id (composite FK (tenant_id, category_id) -> catalog.test_categories), tags text[], nabl_processing_centres text[]; booleans NOT NULL DEFAULT false
--    or nullable; loyalty_points / display_order / alert_before_expiry_minutes integer >= 0; report_type / processing_type CHECK lists (lower snake_case of the ElabAssist labels; processing: local, branch_transfer, outsource_branch).
--  - catalog.analytes gets trend_name, specimen_type_id (composite FK to specimen_types), font, result_display_type (CHECK of the 11 values), print_on_negative (DEFAULT true, so every existing row prints negatives as before),
--    print_on_worksheet, send_in_sms, nabl, accab_logo, is_trend. catalog.analyte_versions gets default_value, long_text_value, high_low numeric, require_verification and a widened result_type CHECK
--    (old six + boolean, test_footer, space, graph, html_descriptive); published versions stay immutable on all of them (app.enforce_mutable_columns allow-list).
--  - catalog.reference_ranges gets instrument_id, laboratory_id (plain uuid, no FK: instruments / branches live in other modules), default_range, method_id (composite FK to methods), auto_approved_low,
--    auto_approved_high (low <= high); sex CHECK widened by third_gender; age unit CHECKs widened by hour (reference_ranges AND critical_limits); critical_limits keep their own columns.
--  - catalog.panels gets barcode_text, loyalty_points, display_order, is_popular. catalog.comment_codes gets category_id (composite FK), result_type, is_default_template, text_format (plain | markdown);
--    comment_codes.text and comment_code_texts.text reject raw HTML tags (a "<" followed by a letter, "/" or "!"), so "<5 mg/dL" stays legal.
--  - catalog.test_categories(id, tenant_id, department_id, name, display_order, print_footer, footer_text, is_active, version, created_*, updated_*): unique (tenant_id, department_id, name),
--    name 1..200 chars, display_order >= 0, footer_text <= 2000, SELECT / INSERT / UPDATE only (no DELETE grant, no DELETE policy).
--  - catalog.test_stage_tat_targets(tenant_id, test_id, stage, target_minutes, ...): one row per (tenant_id, test_id, stage), stage in the seven names, target_minutes >= 0.
BEGIN;
SET search_path = extensions, public, pg_catalog;
SELECT * FROM no_plan();

CREATE FUNCTION pg_temp.ta() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1a98a-ac40-7000-8000-00000000a001'::uuid $$;
CREATE FUNCTION pg_temp.tb() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1a98a-ac40-7000-8000-00000000b001'::uuid $$;
CREATE FUNCTION pg_temp.sys() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1b34e-1000-7eee-9d29-d7ca59a102b5'::uuid $$;
CREATE FUNCTION pg_temp.uid(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('0190c600-0000-7000-8000-' || lpad(n::text, 12, '0'))::uuid $$;
CREATE FUNCTION pg_temp.cl(p_tenant uuid, p_type text DEFAULT 'user') RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('actor_type', p_type, 'tenant_id', p_tenant, 'sub', CASE WHEN p_tenant = pg_temp.ta() THEN '01a1a98a-ac40-7000-8000-00000000a300' ELSE '01a1a98a-ac40-7000-8000-00000000b300' END::uuid,
    'membership_id', CASE WHEN p_tenant = pg_temp.ta() THEN '01a1a98a-ac40-7000-8000-00000000a500' ELSE '01a1a98a-ac40-7000-8000-00000000b500' END::uuid) $$;
SELECT set_config('request.jwt.claims', jsonb_build_object('tenant_id', pg_temp.ta(), 'sub', pg_temp.sys(), 'actor_type', 'system')::text, true);

-- run p_sql as p_role with claims; mode n = count of a query, w = ROW_COUNT of a statement; errors -> 'E' || SQLSTATE
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
CREATE FUNCTION pg_temp.a(p_sql text, p_mode text DEFAULT 'w') RETURNS text LANGUAGE sql AS $$ SELECT pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta()), p_sql, p_mode) $$;
CREATE FUNCTION pg_temp.b(p_sql text, p_mode text DEFAULT 'w') RETURNS text LANGUAGE sql AS $$ SELECT pg_temp.x('lims_app', pg_temp.cl(pg_temp.tb()), p_sql, p_mode) $$;
-- superuser statement under system claims of tenant A: 'ok' or SQLSTATE (the failed statement is rolled back, a good one stays)
CREATE FUNCTION pg_temp.try(p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE saved text := current_setting('request.jwt.claims', true);
BEGIN
  PERFORM set_config('request.jwt.claims', jsonb_build_object('tenant_id', pg_temp.ta(), 'sub', pg_temp.sys(), 'actor_type', 'system')::text, true);
  BEGIN
    EXECUTE p_sql;
    PERFORM set_config('request.jwt.claims', coalesce(saved, ''), true);
    RETURN 'ok';
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('request.jwt.claims', coalesce(saved, ''), true);
    RETURN SQLSTATE;
  END;
END $f$;
-- one scalar as text, or 'E' || SQLSTATE (a missing column fails one assertion, not the whole file)
CREATE FUNCTION pg_temp.q(p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE r text;
BEGIN EXECUTE p_sql INTO r; RETURN coalesce(r, 'NULL'); EXCEPTION WHEN OTHERS THEN RETURN 'E' || SQLSTATE; END $f$;
-- insert a row from jsonb (keys of p_row only; created_by / updated_by / id added when the table has them); 'ok' or SQLSTATE
CREATE FUNCTION pg_temp.ins(p_tbl_name text, p_row jsonb) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE p_tbl regclass := to_regclass(p_tbl_name); r jsonb := p_row; a text; cols text; saved text := current_setting('request.jwt.claims', true);
BEGIN
  IF p_tbl IS NULL THEN RETURN '42P01'; END IF;
  IF r ? 'tenant_id' THEN PERFORM set_config('request.jwt.claims', jsonb_build_object('tenant_id', r->>'tenant_id', 'sub', pg_temp.sys(), 'actor_type', 'system')::text, true); END IF;
  FOREACH a IN ARRAY ARRAY['created_by', 'updated_by'] LOOP
    IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = p_tbl AND attname = a AND NOT attisdropped) AND NOT (r ? a) THEN r := r || jsonb_build_object(a, pg_temp.sys()); END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = p_tbl AND attname = 'id' AND NOT attisdropped) AND NOT (r ? 'id') THEN r := r || jsonb_build_object('id', gen_random_uuid()); END IF;
  SELECT string_agg(quote_ident(k), ',') INTO cols FROM jsonb_object_keys(r) k;
  BEGIN
    EXECUTE format('INSERT INTO %1$s (%2$s) SELECT %2$s FROM jsonb_populate_record(NULL::%1$s, %3$L::jsonb)', p_tbl, cols, r::text);
    PERFORM set_config('request.jwt.claims', coalesce(saved, ''), true);
    RETURN 'ok';
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('request.jwt.claims', coalesce(saved, ''), true);
    RETURN SQLSTATE;
  END;
END $f$;
-- fixture insert that must work (old tables, old columns only): raises when it does not
CREATE FUNCTION pg_temp.fx(p_tbl text, p_row jsonb) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE s text := pg_temp.ins(p_tbl, p_row);
BEGIN IF s <> 'ok' THEN RAISE EXCEPTION 'fixture % failed with %', p_tbl, s; END IF; END $f$;

-- ===================================================================================================================================== fixtures (old columns only: proves existing rows)
SELECT pg_temp.fx('catalog.departments', jsonb_build_object('id', pg_temp.uid(1), 'tenant_id', pg_temp.ta(), 'code', 'HAEM', 'name', 'Haematology (SYNTHETIC)'));
SELECT pg_temp.fx('catalog.departments', jsonb_build_object('id', pg_temp.uid(2), 'tenant_id', pg_temp.tb(), 'code', 'HAEM', 'name', 'Haematology B (SYNTHETIC)'));
SELECT pg_temp.fx('catalog.departments', jsonb_build_object('id', pg_temp.uid(3), 'tenant_id', pg_temp.ta(), 'code', 'BIOC', 'name', 'Biochemistry (SYNTHETIC)'));
SELECT pg_temp.fx('catalog.specimen_types', jsonb_build_object('id', pg_temp.uid(61), 'tenant_id', pg_temp.ta(), 'code', 'SER', 'name', 'Serum (SYNTHETIC)', 'report_label', 'Serum'));
SELECT pg_temp.fx('catalog.specimen_types', jsonb_build_object('id', pg_temp.uid(62), 'tenant_id', pg_temp.tb(), 'code', 'SER', 'name', 'Serum B (SYNTHETIC)', 'report_label', 'Serum'));
SELECT pg_temp.fx('catalog.methods', jsonb_build_object('id', pg_temp.uid(63), 'tenant_id', pg_temp.ta(), 'code', 'DIRECT', 'name', 'Direct (SYNTHETIC)'));
SELECT pg_temp.fx('catalog.methods', jsonb_build_object('id', pg_temp.uid(64), 'tenant_id', pg_temp.tb(), 'code', 'DIRECT', 'name', 'Direct B (SYNTHETIC)'));
-- tests 11 (untouched: proves defaults of an existing row), 14 (mutated by the constraint probes), 12 (tenant B)
SELECT pg_temp.fx('catalog.orderables', jsonb_build_object('id', pg_temp.uid(11), 'tenant_id', pg_temp.ta(), 'kind', 'test', 'code', 'CBC', 'name', 'CBC (SYNTHETIC)', 'department_id', pg_temp.uid(1)));
SELECT pg_temp.fx('catalog.orderables', jsonb_build_object('id', pg_temp.uid(14), 'tenant_id', pg_temp.ta(), 'kind', 'test', 'code', 'GLU', 'name', 'Glucose (SYNTHETIC)', 'department_id', pg_temp.uid(3)));
SELECT pg_temp.fx('catalog.orderables', jsonb_build_object('id', pg_temp.uid(12), 'tenant_id', pg_temp.tb(), 'kind', 'test', 'code', 'CBC', 'name', 'CBC B (SYNTHETIC)', 'department_id', pg_temp.uid(2)));
SELECT pg_temp.fx('catalog.orderables', jsonb_build_object('id', pg_temp.uid(13), 'tenant_id', pg_temp.ta(), 'kind', 'panel', 'code', 'LIPID', 'name', 'Lipid (SYNTHETIC)'));
SELECT pg_temp.fx('catalog.orderables', jsonb_build_object('id', pg_temp.uid(15), 'tenant_id', pg_temp.ta(), 'kind', 'panel', 'code', 'DIAB', 'name', 'Diabetes (SYNTHETIC)'));
SELECT pg_temp.fx('catalog.tests', jsonb_build_object('id', pg_temp.uid(11), 'tenant_id', pg_temp.ta(), 'workflow_type', 'standard'));
SELECT pg_temp.fx('catalog.tests', jsonb_build_object('id', pg_temp.uid(14), 'tenant_id', pg_temp.ta(), 'workflow_type', 'standard'));
SELECT pg_temp.fx('catalog.tests', jsonb_build_object('id', pg_temp.uid(12), 'tenant_id', pg_temp.tb(), 'workflow_type', 'standard'));
SELECT pg_temp.fx('catalog.panels', jsonb_build_object('id', pg_temp.uid(13), 'tenant_id', pg_temp.ta(), 'panel_kind', 'clinical'));
SELECT pg_temp.fx('catalog.panels', jsonb_build_object('id', pg_temp.uid(15), 'tenant_id', pg_temp.ta(), 'panel_kind', 'package'));
-- analytes 21 (untouched, published version), 22 (mutated, draft version), 23 (tenant B)
SELECT pg_temp.fx('catalog.analytes', jsonb_build_object('id', pg_temp.uid(21), 'tenant_id', pg_temp.ta(), 'test_id', pg_temp.uid(11), 'code', 'HB', 'name', 'Haemoglobin'));
SELECT pg_temp.fx('catalog.analytes', jsonb_build_object('id', pg_temp.uid(22), 'tenant_id', pg_temp.ta(), 'test_id', pg_temp.uid(11), 'code', 'WBC', 'name', 'WBC'));
SELECT pg_temp.fx('catalog.analytes', jsonb_build_object('id', pg_temp.uid(23), 'tenant_id', pg_temp.tb(), 'test_id', pg_temp.uid(12), 'code', 'HB', 'name', 'Haemoglobin B'));
SELECT pg_temp.fx('catalog.analyte_versions', jsonb_build_object('id', pg_temp.uid(31), 'tenant_id', pg_temp.ta(), 'analyte_id', pg_temp.uid(21), 'version_no', 1, 'status', 'published',
  'result_type', 'numeric', 'decimals', 1, 'unit_code', 'g_dl', 'effective_from', now(), 'published_at', now(), 'change_reason', 'seed'));
SELECT pg_temp.fx('catalog.analyte_versions', jsonb_build_object('id', pg_temp.uid(32), 'tenant_id', pg_temp.ta(), 'analyte_id', pg_temp.uid(22), 'version_no', 1, 'status', 'draft', 'result_type', 'numeric', 'decimals', 1));
-- a draft range set with two old-shape bands (51 untouched, 52 mutated) and a draft critical set with one old-shape band
SELECT pg_temp.fx('catalog.reference_range_sets', jsonb_build_object('id', pg_temp.uid(42), 'tenant_id', pg_temp.ta(), 'analyte_id', pg_temp.uid(22), 'version_no', 1));
SELECT pg_temp.fx('catalog.reference_ranges', jsonb_build_object('id', pg_temp.uid(51), 'tenant_id', pg_temp.ta(), 'set_id', pg_temp.uid(42), 'sex', 'any', 'kind', 'numeric', 'low', 1, 'high', 2,
  'age_low_value', 1, 'age_low_unit', 'year', 'age_high_value', 50, 'age_high_unit', 'year'));
SELECT pg_temp.fx('catalog.reference_ranges', jsonb_build_object('id', pg_temp.uid(52), 'tenant_id', pg_temp.ta(), 'set_id', pg_temp.uid(42), 'sex', 'male', 'kind', 'numeric', 'low', 3, 'high', 4));
SELECT pg_temp.fx('catalog.critical_limit_sets', jsonb_build_object('id', pg_temp.uid(45), 'tenant_id', pg_temp.ta(), 'analyte_id', pg_temp.uid(22), 'version_no', 1));
SELECT pg_temp.fx('catalog.critical_limits', jsonb_build_object('id', pg_temp.uid(53), 'tenant_id', pg_temp.ta(), 'set_id', pg_temp.uid(45), 'sex', 'any', 'low', 1));
SELECT pg_temp.fx('catalog.comment_codes', jsonb_build_object('id', pg_temp.uid(131), 'tenant_id', pg_temp.ta(), 'code', 'NOTE1', 'text', 'Synthetic comment'));
SELECT pg_temp.fx('catalog.comment_codes', jsonb_build_object('id', pg_temp.uid(132), 'tenant_id', pg_temp.ta(), 'code', 'NOTE2', 'text', 'Synthetic comment two'));
SELECT pg_temp.fx('catalog.comment_code_texts', jsonb_build_object('id', pg_temp.uid(141), 'tenant_id', pg_temp.ta(), 'comment_code_id', pg_temp.uid(131), 'text_version', 1, 'text', 'Synthetic comment',
  'effective_from', '2026-01-01T00:00:00Z'::timestamptz));

-- ===================================================================================================================================== (1) columns exist, nullable or defaulted, right types
CREATE TEMP TABLE new_cols (t text, c text, typ text);
INSERT INTO new_cols VALUES
  ('tests','short_name','text'),('tests','display_name','text'),('tests','tags','text[]'),('tests','barcode_text','text'),('tests','loyalty_points','integer'),('tests','display_order','integer'),
  ('tests','description','text'),('tests','report_type','text'),('tests','processing_type','text'),('tests','template_ref','text'),('tests','outsource_name','text'),('tests','is_outsourced','boolean'),
  ('tests','is_popular','boolean'),('tests','smart_report','boolean'),('tests','print_category_wise','boolean'),('tests','nabl','boolean'),('tests','accab_logo','boolean'),
  ('tests','auto_approval_enabled','boolean'),('tests','use_normal_range_for_auto_approval','boolean'),('tests','template_test','boolean'),('tests','nabl_processing_centres','text[]'),
  ('tests','font','text'),('tests','alert_before_expiry_minutes','integer'),('tests','category_id','uuid'),
  ('analytes','trend_name','text'),('analytes','specimen_type_id','uuid'),('analytes','font','text'),('analytes','result_display_type','text'),('analytes','print_on_negative','boolean'),
  ('analytes','print_on_worksheet','boolean'),('analytes','send_in_sms','boolean'),('analytes','nabl','boolean'),('analytes','accab_logo','boolean'),('analytes','is_trend','boolean'),
  ('analyte_versions','default_value','text'),('analyte_versions','long_text_value','text'),('analyte_versions','high_low','numeric'),('analyte_versions','require_verification','boolean'),
  ('reference_ranges','instrument_id','uuid'),('reference_ranges','laboratory_id','uuid'),('reference_ranges','default_range','boolean'),('reference_ranges','method_id','uuid'),
  ('reference_ranges','auto_approved_low','numeric'),('reference_ranges','auto_approved_high','numeric'),
  ('panels','barcode_text','text'),('panels','loyalty_points','integer'),('panels','display_order','integer'),('panels','is_popular','boolean'),
  ('comment_codes','category_id','uuid'),('comment_codes','result_type','text'),('comment_codes','is_default_template','boolean'),('comment_codes','text_format','text');
SELECT is((SELECT count(*)::int FROM new_cols), 52, 'fixture list: 52 new columns across 6 tables');
SELECT is((SELECT coalesce(string_agg(n.t || '.' || n.c, ', ' ORDER BY n.t, n.c), '') FROM new_cols n
           WHERE NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = to_regclass('catalog.' || n.t) AND a.attname = n.c AND a.attnum > 0 AND NOT a.attisdropped)),
          '', 'every new column exists');
SELECT is((SELECT coalesce(string_agg(n.t || '.' || n.c || ':' || format_type(a.atttypid, a.atttypmod), ', ' ORDER BY n.t, n.c), '') FROM new_cols n
           JOIN pg_attribute a ON a.attrelid = to_regclass('catalog.' || n.t) AND a.attname = n.c AND a.attnum > 0 AND NOT a.attisdropped
           WHERE format_type(a.atttypid, a.atttypmod) <> n.typ), '', 'every new column has the pinned type (tags text[], high_low numeric, no float)');
SELECT is((SELECT coalesce(string_agg(n.t || '.' || n.c, ', ' ORDER BY n.t, n.c), '') FROM new_cols n
           JOIN pg_attribute a ON a.attrelid = to_regclass('catalog.' || n.t) AND a.attname = n.c AND a.attnum > 0 AND NOT a.attisdropped
           WHERE a.attnotnull AND NOT a.atthasdef), '', 'every new column is nullable or defaulted (no existing row needs a rewrite decision)');
SELECT is((SELECT coalesce(string_agg(n.t || '.' || n.c, ', ' ORDER BY n.t, n.c), '') FROM new_cols n
           JOIN pg_attribute a ON a.attrelid = to_regclass('catalog.' || n.t) AND a.attname = n.c AND a.attnum > 0 AND NOT a.attisdropped
           JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
           WHERE pg_get_expr(d.adbin, d.adrelid) ~* 'now\(\)|random|nextval|gen_random'), '', 'no volatile default on a new column (ADD COLUMN stays metadata-only)');

-- ===================================================================================================================================== (2) existing rows still read and keep their meaning
SELECT is(pg_temp.a($q$SELECT 1 FROM catalog.tests WHERE id = '0190c600-0000-7000-8000-000000000011'$q$, 'n'), 'n=1', 'existing test row reads as tenant A');
SELECT is(pg_temp.a($q$SELECT 1 FROM catalog.analytes WHERE id = '0190c600-0000-7000-8000-000000000021'$q$, 'n'), 'n=1', 'existing analyte row reads as tenant A');
SELECT is(pg_temp.a($q$SELECT 1 FROM catalog.analyte_versions WHERE id = '0190c600-0000-7000-8000-000000000031'$q$, 'n'), 'n=1', 'existing published analyte version reads as tenant A');
SELECT is(pg_temp.a($q$SELECT 1 FROM catalog.reference_ranges WHERE id = '0190c600-0000-7000-8000-000000000051'$q$, 'n'), 'n=1', 'existing band reads as tenant A');
SELECT is(pg_temp.a($q$SELECT 1 FROM catalog.panels WHERE id = '0190c600-0000-7000-8000-000000000013'$q$, 'n'), 'n=1', 'existing panel reads as tenant A');
SELECT is(pg_temp.a($q$SELECT 1 FROM catalog.comment_codes WHERE id = '0190c600-0000-7000-8000-000000000131'$q$, 'n'), 'n=1', 'existing comment code reads as tenant A');
SELECT is(pg_temp.q($q$SELECT print_on_negative::text FROM catalog.analytes WHERE id = '0190c600-0000-7000-8000-000000000021'$q$), 'true', 'existing analyte keeps printing negative values (print_on_negative defaults true)');
SELECT is(pg_temp.q($q$SELECT coalesce(is_popular, false)::text FROM catalog.tests WHERE id = '0190c600-0000-7000-8000-000000000011'$q$), 'false', 'existing test is not popular');
SELECT is(pg_temp.q($q$SELECT coalesce(is_outsourced, false)::text FROM catalog.tests WHERE id = '0190c600-0000-7000-8000-000000000011'$q$), 'false', 'existing test is not outsourced (its workflow_type is untouched)');
SELECT is(pg_temp.q($q$SELECT coalesce(loyalty_points, 0)::text FROM catalog.tests WHERE id = '0190c600-0000-7000-8000-000000000011'$q$), '0', 'existing test has zero loyalty points');
SELECT is(pg_temp.q($q$SELECT coalesce(loyalty_points, 0)::text FROM catalog.panels WHERE id = '0190c600-0000-7000-8000-000000000013'$q$), '0', 'existing panel has zero loyalty points');
SELECT is(pg_temp.q($q$SELECT coalesce(default_range, false)::text FROM catalog.reference_ranges WHERE id = '0190c600-0000-7000-8000-000000000051'$q$), 'false', 'existing band is not flagged default');
SELECT is(pg_temp.q($q$SELECT (age_low_value || age_low_unit || age_high_value || age_high_unit || sex) FROM catalog.reference_ranges WHERE id = '0190c600-0000-7000-8000-000000000051'$q$), '1year50yearany', 'existing band keeps its age and sex meaning');
SELECT is(pg_temp.q($q$SELECT coalesce(text_format, 'plain') FROM catalog.comment_codes WHERE id = '0190c600-0000-7000-8000-000000000131'$q$), 'plain', 'existing comment code is plain text');
SELECT is(pg_temp.q($q$SELECT count(*)::text FROM catalog.tests WHERE workflow_type IS NOT NULL$q$), '3', 'the three fixture tests keep their workflow_type');

-- ===================================================================================================================================== (3) new CHECK constraints reject bad values, accept good ones
-- tests
SELECT is(pg_temp.try($q$UPDATE catalog.tests SET loyalty_points = -1 WHERE id = '0190c600-0000-7000-8000-000000000014'$q$), '23514', 'tests: negative loyalty points rejected');
SELECT is(pg_temp.try($q$UPDATE catalog.tests SET loyalty_points = 5 WHERE id = '0190c600-0000-7000-8000-000000000014'$q$), 'ok', 'tests: loyalty points 5 accepted');
SELECT is(pg_temp.try($q$UPDATE catalog.tests SET display_order = -1 WHERE id = '0190c600-0000-7000-8000-000000000014'$q$), '23514', 'tests: negative display_order rejected');
SELECT is(pg_temp.try($q$UPDATE catalog.tests SET alert_before_expiry_minutes = -5 WHERE id = '0190c600-0000-7000-8000-000000000014'$q$), '23514', 'tests: negative alert_before_expiry_minutes rejected');
SELECT is(pg_temp.try($q$UPDATE catalog.tests SET report_type = 'five_column' WHERE id = '0190c600-0000-7000-8000-000000000014'$q$), '23514', 'tests: unknown report_type rejected');
SELECT is(pg_temp.try($q$UPDATE catalog.tests SET processing_type = 'courier' WHERE id = '0190c600-0000-7000-8000-000000000014'$q$), '23514', 'tests: unknown processing_type rejected');
SELECT is((SELECT string_agg(pg_temp.try(format($f$UPDATE catalog.tests SET report_type = %L WHERE id = '0190c600-0000-7000-8000-000000000014'$f$, v)), ',' ORDER BY v)
           FROM unnest(ARRAY['four_column','three_column','two_column','graph','template_based_html','micro_automated','cbc_four_column','micro_manual','histo','four_column_10_font']) v),
          'ok,ok,ok,ok,ok,ok,ok,ok,ok,ok', 'tests: the ten ElabAssist report types are all accepted');
SELECT is((SELECT string_agg(pg_temp.try(format($f$UPDATE catalog.tests SET processing_type = %L WHERE id = '0190c600-0000-7000-8000-000000000014'$f$, v)), ',' ORDER BY v)
           FROM unnest(ARRAY['local','branch_transfer','outsource_branch']) v), 'ok,ok,ok', 'tests: local, branch_transfer, outsource_branch accepted');
SELECT is(pg_temp.try($q$UPDATE catalog.tests SET short_name = 'HM011', display_name = 'COMPLETE BLOOD COUNT, EDTA WB(HM011)', tags = ARRAY['cbc','haematology'], barcode_text = 'CBC', description = 'Synthetic',
  is_popular = true, smart_report = true, nabl = true, nabl_processing_centres = ARRAY['Synthetic Centre A'], font = 'Arial', alert_before_expiry_minutes = 120 WHERE id = '0190c600-0000-7000-8000-000000000014'$q$),
  'ok', 'tests: a fully filled parity row is accepted');
SELECT is(pg_temp.try($q$UPDATE catalog.tests SET workflow_type = 'outsourced', is_outsourced = true, processing_type = 'outsource_branch', outsource_name = 'Synthetic Outsource Lab' WHERE id = '0190c600-0000-7000-8000-000000000014'$q$),
  'ok', 'tests: outsourced flag and name accepted next to workflow_type outsourced');
-- panels
SELECT is(pg_temp.try($q$UPDATE catalog.panels SET loyalty_points = -1 WHERE id = '0190c600-0000-7000-8000-000000000015'$q$), '23514', 'panels: negative loyalty points rejected');
SELECT is(pg_temp.try($q$UPDATE catalog.panels SET display_order = -1 WHERE id = '0190c600-0000-7000-8000-000000000015'$q$), '23514', 'panels: negative display_order rejected');
SELECT is(pg_temp.try($q$UPDATE catalog.panels SET barcode_text = 'ADS', loyalty_points = 3, display_order = 2, is_popular = true WHERE id = '0190c600-0000-7000-8000-000000000015'$q$), 'ok', 'panels: parity fields accepted');
SELECT is(pg_temp.try($q$UPDATE catalog.panels SET panel_kind = 'profile' WHERE id = '0190c600-0000-7000-8000-000000000015'$q$), '23514', 'panels: panel_kind still only clinical | package');
-- analytes
SELECT is(pg_temp.try($q$UPDATE catalog.analytes SET result_display_type = 'five_column' WHERE id = '0190c600-0000-7000-8000-000000000022'$q$), '23514', 'analytes: unknown result_display_type rejected');
SELECT is((SELECT string_agg(pg_temp.try(format($f$UPDATE catalog.analytes SET result_display_type = %L WHERE id = '0190c600-0000-7000-8000-000000000022'$f$, v)), ',' ORDER BY v)
           FROM unnest(ARRAY['table','note_value_only','list_note','one_column','two_column','three_column','four_column','comment','hidden','table_with_subheader','merge_two_column']) v),
          'ok,ok,ok,ok,ok,ok,ok,ok,ok,ok,ok', 'analytes: the eleven ElabAssist display types are accepted');
SELECT is(pg_temp.try($q$UPDATE catalog.analytes SET trend_name = 'WBC trend', font = 'Arial', print_on_negative = false, print_on_worksheet = true, send_in_sms = true, nabl = true, accab_logo = true, is_trend = true
  WHERE id = '0190c600-0000-7000-8000-000000000022'$q$), 'ok', 'analytes: display flags accepted');
SELECT is(pg_temp.try($q$UPDATE catalog.analytes SET specimen_type_id = '0190c600-0000-7000-8000-000000000061' WHERE id = '0190c600-0000-7000-8000-000000000022'$q$), 'ok', 'analytes: own tenant specimen type accepted');
SELECT is(pg_temp.try($q$UPDATE catalog.analytes SET specimen_type_id = '0190c600-0000-7000-8000-000000000062' WHERE id = '0190c600-0000-7000-8000-000000000022'$q$), '23503', 'analytes: another tenant specimen type rejected (composite FK)');
-- analyte versions (draft 32 mutated, published 31 must stay immutable)
SELECT is(pg_temp.try($q$UPDATE catalog.analyte_versions SET result_type = 'float' WHERE id = '0190c600-0000-7000-8000-000000000032'$q$), '23514', 'analyte_versions: result_type float is not a LIMS value (maps to numeric)');
SELECT is((SELECT string_agg(pg_temp.try(format($f$UPDATE catalog.analyte_versions SET result_type = %L WHERE id = '0190c600-0000-7000-8000-000000000032'$f$, v)), ',' ORDER BY v)
           FROM unnest(ARRAY['numeric','text','ordinal','coded','attachment','narrative','boolean','test_footer','space','graph','html_descriptive']) v),
          'ok,ok,23514,ok,ok,ok,ok,23514,ok,ok,ok'::text,  -- sorted: attachment, boolean, coded*, graph, html_descriptive, narrative, numeric, ordinal*, space, test_footer, text; *needs a value_set_code (existing check)
          'analyte_versions: old six + five new result types accepted (ordinal / coded still need a value set)');
SELECT is(pg_temp.try($q$UPDATE catalog.analyte_versions SET result_type = 'numeric', decimals = 1, default_value = '0', long_text_value = 'Synthetic long text', high_low = 9.5, require_verification = true
  WHERE id = '0190c600-0000-7000-8000-000000000032'$q$), 'ok', 'analyte_versions: version side fields accepted on a draft');
SELECT is(pg_temp.try($q$UPDATE catalog.analyte_versions SET default_value = 'changed' WHERE id = '0190c600-0000-7000-8000-000000000031'$q$), 'P0001', 'published analyte version: default_value is immutable (changes what a result means)');
SELECT is(pg_temp.try($q$UPDATE catalog.analyte_versions SET high_low = 1 WHERE id = '0190c600-0000-7000-8000-000000000031'$q$), 'P0001', 'published analyte version: high_low is immutable');
SELECT is(pg_temp.try($q$UPDATE catalog.analyte_versions SET require_verification = true WHERE id = '0190c600-0000-7000-8000-000000000031'$q$), 'P0001', 'published analyte version: require_verification is immutable');
SELECT is(pg_temp.try($q$UPDATE catalog.analyte_versions SET long_text_value = 'changed' WHERE id = '0190c600-0000-7000-8000-000000000031'$q$), 'P0001', 'published analyte version: long_text_value is immutable');
SELECT is(pg_temp.try($q$UPDATE catalog.analyte_versions SET result_type = 'text' WHERE id = '0190c600-0000-7000-8000-000000000031'$q$), 'P0001', 'published analyte version: result_type is still immutable');
-- reference bands
SELECT is(pg_temp.try($q$UPDATE catalog.reference_ranges SET low = 9, high = 1 WHERE id = '0190c600-0000-7000-8000-000000000052'$q$), '23514', 'reference_ranges: low above high rejected');
SELECT is(pg_temp.try($q$UPDATE catalog.reference_ranges SET sex = 'third_gender' WHERE id = '0190c600-0000-7000-8000-000000000052'$q$), 'ok', 'reference_ranges: sex third_gender accepted');
SELECT is(pg_temp.try($q$UPDATE catalog.reference_ranges SET sex = 'other' WHERE id = '0190c600-0000-7000-8000-000000000052'$q$), '23514', 'reference_ranges: sex other still rejected');
SELECT is(pg_temp.try($q$UPDATE catalog.reference_ranges SET age_low_value = 0, age_low_unit = 'hour', age_high_value = 72, age_high_unit = 'hour' WHERE id = '0190c600-0000-7000-8000-000000000052'$q$), 'ok', 'reference_ranges: age unit hour accepted');
SELECT is(pg_temp.try($q$UPDATE catalog.reference_ranges SET age_high_value = 5, age_high_unit = 'minute' WHERE id = '0190c600-0000-7000-8000-000000000052'$q$), '23514', 'reference_ranges: age unit minute rejected');
SELECT is((SELECT string_agg(pg_temp.try(format($f$UPDATE catalog.reference_ranges SET age_low_value = 0, age_low_unit = %L, age_high_value = 10, age_high_unit = %L WHERE id = '0190c600-0000-7000-8000-000000000052'$f$, v, v)), ',' ORDER BY v)
           FROM unnest(ARRAY['hour','day','week','month','year']) v), 'ok,ok,ok,ok,ok', 'reference_ranges: all five age units accepted');
SELECT is(pg_temp.try($q$UPDATE catalog.reference_ranges SET instrument_id = '0190c600-0000-7000-8000-0000000000e1', laboratory_id = '0190c600-0000-7000-8000-0000000000e2', default_range = true,
  auto_approved_low = 1.5, auto_approved_high = 1.8, display_text = 'Synthetic display range' WHERE id = '0190c600-0000-7000-8000-000000000052'$q$), 'ok', 'reference_ranges: machine, laboratory, default flag, auto approved range, display text accepted');
SELECT is(pg_temp.try($q$UPDATE catalog.reference_ranges SET auto_approved_low = 5, auto_approved_high = 1 WHERE id = '0190c600-0000-7000-8000-000000000052'$q$), '23514', 'reference_ranges: auto approved low above high rejected');
SELECT is(pg_temp.try($q$UPDATE catalog.reference_ranges SET auto_approved_low = 1, auto_approved_high = NULL WHERE id = '0190c600-0000-7000-8000-000000000052'$q$), 'ok', 'reference_ranges: one sided auto approved range accepted');
SELECT is(pg_temp.try($q$UPDATE catalog.reference_ranges SET method_id = '0190c600-0000-7000-8000-000000000063' WHERE id = '0190c600-0000-7000-8000-000000000052'$q$), 'ok', 'reference_ranges: own tenant method accepted');
SELECT is(pg_temp.try($q$UPDATE catalog.reference_ranges SET method_id = '0190c600-0000-7000-8000-000000000064' WHERE id = '0190c600-0000-7000-8000-000000000052'$q$), '23503', 'reference_ranges: another tenant method rejected (composite FK)');
-- critical bands keep their own set: third gender and hour only
SELECT is(pg_temp.try($q$UPDATE catalog.critical_limits SET sex = 'third_gender' WHERE id = '0190c600-0000-7000-8000-000000000053'$q$), 'ok', 'critical_limits: sex third_gender accepted');
SELECT is(pg_temp.try($q$UPDATE catalog.critical_limits SET age_low_value = 0, age_low_unit = 'hour', age_high_value = 48, age_high_unit = 'hour' WHERE id = '0190c600-0000-7000-8000-000000000053'$q$), 'ok', 'critical_limits: age unit hour accepted');
SELECT is(pg_temp.try($q$UPDATE catalog.critical_limits SET sex = 'other' WHERE id = '0190c600-0000-7000-8000-000000000053'$q$), '23514', 'critical_limits: sex other rejected');
SELECT is((SELECT count(*)::int FROM pg_attribute WHERE attrelid = 'catalog.critical_limits'::regclass AND attname IN ('auto_approved_low','auto_approved_high','default_range','instrument_id','laboratory_id') AND NOT attisdropped), 0,
          'critical_limits has no auto approved range, default flag, machine or laboratory column (keeps its own set)');
-- notes
SELECT is(pg_temp.try($q$UPDATE catalog.comment_codes SET text_format = 'html' WHERE id = '0190c600-0000-7000-8000-000000000132'$q$), '23514', 'comment_codes: text_format html rejected');
SELECT is(pg_temp.try($q$UPDATE catalog.comment_codes SET text_format = 'markdown', result_type = 'narrative', is_default_template = true WHERE id = '0190c600-0000-7000-8000-000000000132'$q$), 'ok', 'comment_codes: markdown, result type, default template accepted');
SELECT is(pg_temp.try($q$UPDATE catalog.comment_codes SET result_type = 'rich' WHERE id = '0190c600-0000-7000-8000-000000000132'$q$), '23514', 'comment_codes: unknown result_type rejected');
SELECT is((SELECT string_agg(pg_temp.try(format($f$UPDATE catalog.comment_codes SET text = %L WHERE id = '0190c600-0000-7000-8000-000000000132'$f$, v)), ',' ORDER BY v)
           FROM unnest(ARRAY['<script>alert(1)</script>','<b>bold</b>','<img src=x onerror=alert(1)>','see <a href="x">link</a>','</p>','<!-- c -->','<SCRIPT>x</SCRIPT>']) v),
          '23514,23514,23514,23514,23514,23514,23514', 'comment_codes.text: raw HTML tags are rejected');
SELECT is((SELECT string_agg(pg_temp.try(format($f$UPDATE catalog.comment_codes SET text = %L WHERE id = '0190c600-0000-7000-8000-000000000132'$f$, v)), ',' ORDER BY v)
           FROM unnest(ARRAY['<5 mg/dL is low','Value > 10 and < 20','**bold** and _italic_','- item one' || chr(10) || '- item two','1 < 2']) v),
          'ok,ok,ok,ok,ok', 'comment_codes.text: plain text with < or > and safe Markdown is accepted');
SELECT is(pg_temp.ins('catalog.comment_code_texts', jsonb_build_object('tenant_id', pg_temp.ta(), 'comment_code_id', pg_temp.uid(131), 'text_version', 2, 'text', '<script>alert(1)</script>',
  'effective_from', '2026-02-01T00:00:00Z'::timestamptz)), '23514', 'comment_code_texts.text: raw HTML rejected in the history table too');
SELECT is(pg_temp.ins('catalog.comment_code_texts', jsonb_build_object('tenant_id', pg_temp.ta(), 'comment_code_id', pg_temp.uid(131), 'text_version', 3, 'text', '<5 mg/dL',
  'effective_from', '2026-03-01T00:00:00Z'::timestamptz)), 'ok', 'comment_code_texts.text: "<5 mg/dL" accepted');

-- ===================================================================================================================================== (4) catalog.test_categories
SELECT has_table('catalog'::name, 'test_categories'::name, 'catalog.test_categories exists');
SELECT is((SELECT coalesce(string_agg(c, ', ' ORDER BY c), '') FROM unnest(ARRAY['id','tenant_id','department_id','name','display_order','print_footer','footer_text','is_active','version','created_at','created_by','updated_at','updated_by']) c
           WHERE NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = to_regclass('catalog.test_categories') AND a.attname = c AND NOT a.attisdropped AND a.attnum > 0)), '', 'test_categories has the 13 columns');
SELECT is((SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = to_regclass('catalog.test_categories')), true, 'test_categories: RLS enabled and FORCE-d');
SELECT is((SELECT count(*)::int FROM pg_policy WHERE polrelid = to_regclass('catalog.test_categories') AND polcmd = 'd'), 0, 'test_categories: no DELETE policy (deactivate, never delete)');
SELECT is((SELECT count(*)::int FROM pg_policy WHERE polrelid = to_regclass('catalog.test_categories') AND polcmd IN ('r','a','w')), 3, 'test_categories: one SELECT, one INSERT, one UPDATE policy');
SELECT is((SELECT count(*)::int FROM pg_policy WHERE polrelid = to_regclass('catalog.test_categories') AND (pg_get_expr(polqual, polrelid) !~ 'tenant_id' AND pg_get_expr(polwithcheck, polrelid) !~ 'tenant_id')), 0, 'test_categories: every policy is tenant scoped');
SELECT is(pg_temp.q($$SELECT (has_table_privilege('lims_app', 'catalog.test_categories', 'SELECT') AND has_table_privilege('lims_app', 'catalog.test_categories', 'INSERT')
  AND has_table_privilege('lims_app', 'catalog.test_categories', 'UPDATE') AND NOT has_table_privilege('lims_app', 'catalog.test_categories', 'DELETE'))::text$$), 'true', 'test_categories: lims_app has SELECT, INSERT, UPDATE and no DELETE');
SELECT is(pg_temp.ins('catalog.test_categories', jsonb_build_object('id', pg_temp.uid(71), 'tenant_id', pg_temp.ta(), 'department_id', pg_temp.uid(1), 'name', 'Hematology', 'display_order', 1, 'print_footer', true, 'footer_text', 'Synthetic footer')), 'ok', 'category insert: tenant A / haematology');
SELECT is(pg_temp.ins('catalog.test_categories', jsonb_build_object('id', pg_temp.uid(72), 'tenant_id', pg_temp.ta(), 'department_id', pg_temp.uid(1), 'name', 'Biochemistry')), 'ok', 'category insert: only name and department (everything else defaulted)');
SELECT is(pg_temp.ins('catalog.test_categories', jsonb_build_object('id', pg_temp.uid(73), 'tenant_id', pg_temp.ta(), 'department_id', pg_temp.uid(3), 'name', 'Hematology')), 'ok', 'category insert: same name under another department of the tenant is allowed');
SELECT is(pg_temp.ins('catalog.test_categories', jsonb_build_object('id', pg_temp.uid(74), 'tenant_id', pg_temp.tb(), 'department_id', pg_temp.uid(2), 'name', 'Hematology')), 'ok', 'category insert: same name in tenant B is allowed');
SELECT is(pg_temp.ins('catalog.test_categories', jsonb_build_object('id', pg_temp.uid(75), 'tenant_id', pg_temp.ta(), 'department_id', pg_temp.uid(1), 'name', 'Hematology')), '23505', 'category insert: duplicate (tenant, department, name) rejected');
SELECT is(pg_temp.ins('catalog.test_categories', jsonb_build_object('id', pg_temp.uid(76), 'tenant_id', pg_temp.ta(), 'department_id', pg_temp.uid(2), 'name', 'Cross')), '23503', 'category insert: department of tenant B rejected (composite FK)');
SELECT is(pg_temp.ins('catalog.test_categories', jsonb_build_object('id', pg_temp.uid(77), 'tenant_id', pg_temp.ta(), 'department_id', pg_temp.uid(1), 'name', '')), '23514', 'category insert: empty name rejected');
SELECT is(pg_temp.ins('catalog.test_categories', jsonb_build_object('id', pg_temp.uid(77), 'tenant_id', pg_temp.ta(), 'department_id', pg_temp.uid(1), 'name', repeat('x', 201))), '23514', 'category insert: name over 200 characters rejected');
SELECT is(pg_temp.ins('catalog.test_categories', jsonb_build_object('id', pg_temp.uid(77), 'tenant_id', pg_temp.ta(), 'department_id', pg_temp.uid(1), 'name', 'Neg', 'display_order', -1)), '23514', 'category insert: negative display_order rejected');
SELECT is(pg_temp.ins('catalog.test_categories', jsonb_build_object('id', pg_temp.uid(77), 'tenant_id', pg_temp.ta(), 'department_id', pg_temp.uid(1), 'name', 'Long', 'footer_text', repeat('x', 2001))), '23514', 'category insert: footer_text over 2000 characters rejected');
SELECT is(pg_temp.ins('catalog.test_categories', jsonb_build_object('id', pg_temp.uid(77), 'tenant_id', pg_temp.ta(), 'department_id', pg_temp.uid(1), 'name', 'NoDept')) , 'ok', 'category insert: control row ok');
SELECT is(pg_temp.try($q$UPDATE catalog.test_categories SET department_id = NULL WHERE id = '0190c600-0000-7000-8000-000000000077'$q$), '23502', 'category: department is mandatory (NOT NULL)');
SELECT is(pg_temp.q($q$SELECT (is_active::text || '/' || print_footer::text || '/' || display_order::text || '/' || version::text) FROM catalog.test_categories WHERE id = '0190c600-0000-7000-8000-000000000072'$q$), 'true/false/0/1', 'category defaults: active, no footer, order 0, version 1');
-- tests.category_id composite FK
SELECT is(pg_temp.try($q$UPDATE catalog.tests SET category_id = '0190c600-0000-7000-8000-000000000071' WHERE id = '0190c600-0000-7000-8000-000000000014'$q$), 'ok', 'tests.category_id: own tenant category accepted');
SELECT is(pg_temp.try($q$UPDATE catalog.tests SET category_id = '0190c600-0000-7000-8000-000000000074' WHERE id = '0190c600-0000-7000-8000-000000000014'$q$), '23503', 'tests.category_id: tenant B category rejected (composite FK)');
SELECT is(pg_temp.try($q$UPDATE catalog.tests SET category_id = '0190c600-0000-7000-8000-0000000000ff' WHERE id = '0190c600-0000-7000-8000-000000000014'$q$), '23503', 'tests.category_id: unknown category rejected');
SELECT is(pg_temp.try($q$UPDATE catalog.comment_codes SET category_id = '0190c600-0000-7000-8000-000000000071' WHERE id = '0190c600-0000-7000-8000-000000000132'$q$), 'ok', 'comment_codes.category_id: own tenant category accepted');
SELECT is(pg_temp.try($q$UPDATE catalog.comment_codes SET category_id = '0190c600-0000-7000-8000-000000000074' WHERE id = '0190c600-0000-7000-8000-000000000132'$q$), '23503', 'comment_codes.category_id: tenant B category rejected');
-- a category that tests use cannot be deleted by the app and can be deactivated
SELECT is(pg_temp.a($q$DELETE FROM catalog.test_categories WHERE id = '0190c600-0000-7000-8000-000000000071'$q$), 'E42501', 'tenant A staff cannot DELETE a category (no grant)');
SELECT is(pg_temp.a($q$UPDATE catalog.test_categories SET is_active = false, version = version + 1 WHERE id = '0190c600-0000-7000-8000-000000000071'$q$), 'n=1', 'tenant A staff can deactivate a category');
SELECT is(pg_temp.q($q$SELECT is_active::text FROM catalog.test_categories WHERE id = '0190c600-0000-7000-8000-000000000071'$q$), 'false', 'deactivated category is still in the table');
SELECT is(pg_temp.q($q$SELECT category_id::text FROM catalog.tests WHERE id = '0190c600-0000-7000-8000-000000000014'$q$), '0190c600-0000-7000-8000-000000000071', 'a deactivated category keeps its tests linked');
-- isolation (RLS on the new table)
SELECT is(pg_temp.a($q$SELECT 1 FROM catalog.test_categories$q$, 'n'), 'n=4', 'tenant A staff sees its 4 categories');
SELECT is(pg_temp.b($q$SELECT 1 FROM catalog.test_categories$q$, 'n'), 'n=1', 'tenant B staff sees its 1 category');
SELECT is(pg_temp.a($q$SELECT 1 FROM catalog.test_categories WHERE tenant_id = '01a1a98a-ac40-7000-8000-00000000b001'$q$, 'n'), 'n=0', 'tenant A cannot read tenant B categories by filter');
SELECT is(pg_temp.a($q$INSERT INTO catalog.test_categories (id, tenant_id, department_id, name, created_by, updated_by) VALUES ('0190c600-0000-7000-8000-000000000078', '01a1a98a-ac40-7000-8000-00000000b001',
  '0190c600-0000-7000-8000-000000000002', 'Injected', '01a1b34e-1000-7eee-9d29-d7ca59a102b5', '01a1b34e-1000-7eee-9d29-d7ca59a102b5')$q$), 'E42501', 'tenant A cannot insert a category for tenant B (RLS WITH CHECK)');
SELECT is(pg_temp.a($q$UPDATE catalog.test_categories SET name = 'Hijacked' WHERE id = '0190c600-0000-7000-8000-000000000074'$q$), 'n=0', 'tenant A cannot update a tenant B category');
SELECT is(pg_temp.b($q$UPDATE catalog.test_categories SET name = 'Own rename' WHERE id = '0190c600-0000-7000-8000-000000000074'$q$), 'n=1', 'tenant B can update its own category');
SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), 'patient'), 'SELECT 1 FROM catalog.test_categories', 'n'), 'n=0', 'patient claims see 0 categories');
SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), 'partner'), 'SELECT 1 FROM catalog.test_categories', 'n'), 'n=0', 'partner claims see 0 categories');
SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), 'portal'), 'SELECT 1 FROM catalog.test_categories', 'n'), 'n=0', 'portal claims see 0 categories');

-- ===================================================================================================================================== (5) catalog.test_stage_tat_targets (seven stages, minutes)
SELECT has_table('catalog'::name, 'test_stage_tat_targets'::name, 'catalog.test_stage_tat_targets exists');
SELECT is((SELECT coalesce(string_agg(c, ', ' ORDER BY c), '') FROM unnest(ARRAY['tenant_id','test_id','stage','target_minutes']) c
           WHERE NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = to_regclass('catalog.test_stage_tat_targets') AND a.attname = c AND NOT a.attisdropped AND a.attnum > 0)), '', 'stage targets have tenant_id, test_id, stage, target_minutes');
SELECT is((SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = to_regclass('catalog.test_stage_tat_targets')), true, 'stage targets: RLS enabled and FORCE-d');
SELECT is((SELECT count(*)::int FROM pg_policy WHERE polrelid = to_regclass('catalog.test_stage_tat_targets') AND polcmd IN ('r','a','w')), 3, 'stage targets: SELECT, INSERT, UPDATE policies');
SELECT is((SELECT count(*)::int FROM pg_policy WHERE polrelid = to_regclass('catalog.test_stage_tat_targets') AND polcmd = 'd'), 0, 'stage targets: no DELETE policy (replace = update in place, history is the audit log)');
SELECT is((SELECT string_agg(pg_temp.ins('catalog.test_stage_tat_targets', jsonb_build_object('tenant_id', pg_temp.ta(), 'test_id', pg_temp.uid(11), 'stage', s, 'target_minutes', 15)), ',' ORDER BY s)
           FROM unnest(ARRAY['registration','sample_collection','accession','result','approval_1','approval_2','release']) s), 'ok,ok,ok,ok,ok,ok,ok', 'the seven stages insert for test 11');
SELECT is(pg_temp.ins('catalog.test_stage_tat_targets', jsonb_build_object('tenant_id', pg_temp.ta(), 'test_id', pg_temp.uid(11), 'stage', 'result', 'target_minutes', 20)), '23505', 'a stage appears once per test');
SELECT is(pg_temp.ins('catalog.test_stage_tat_targets', jsonb_build_object('tenant_id', pg_temp.ta(), 'test_id', pg_temp.uid(14), 'stage', 'packing', 'target_minutes', 5)), '23514', 'unknown stage rejected');
SELECT is(pg_temp.ins('catalog.test_stage_tat_targets', jsonb_build_object('tenant_id', pg_temp.ta(), 'test_id', pg_temp.uid(14), 'stage', 'result', 'target_minutes', -1)), '23514', 'negative minutes rejected');
SELECT is(pg_temp.ins('catalog.test_stage_tat_targets', jsonb_build_object('tenant_id', pg_temp.ta(), 'test_id', pg_temp.uid(12), 'stage', 'result', 'target_minutes', 5)), '23503', 'a tenant A target cannot point at a tenant B test (composite FK)');
SELECT is(pg_temp.ins('catalog.test_stage_tat_targets', jsonb_build_object('tenant_id', pg_temp.tb(), 'test_id', pg_temp.uid(12), 'stage', 'result', 'target_minutes', 30)), 'ok', 'tenant B target for its own test');
SELECT is(pg_temp.a($q$SELECT 1 FROM catalog.test_stage_tat_targets$q$, 'n'), 'n=7', 'tenant A staff sees its 7 stage targets');
SELECT is(pg_temp.b($q$SELECT 1 FROM catalog.test_stage_tat_targets$q$, 'n'), 'n=1', 'tenant B staff sees its 1 stage target');
SELECT is(pg_temp.a($q$UPDATE catalog.test_stage_tat_targets SET target_minutes = 99 WHERE tenant_id = '01a1a98a-ac40-7000-8000-00000000b001'$q$), 'n=0', 'tenant A cannot update tenant B stage targets');
SELECT is(pg_temp.a($q$UPDATE catalog.test_stage_tat_targets SET target_minutes = 25 WHERE test_id = '0190c600-0000-7000-8000-000000000011' AND stage = 'result'$q$), 'n=1', 'tenant A can update its stage target');
SELECT is(pg_temp.a($q$DELETE FROM catalog.test_stage_tat_targets$q$), 'E42501', 'no DELETE grant on stage targets');
SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), 'patient'), 'SELECT 1 FROM catalog.test_stage_tat_targets', 'n'), 'n=0', 'patient claims see 0 stage targets');
SELECT is((SELECT count(*)::int FROM pg_attribute WHERE attrelid = 'catalog.tat_targets'::regclass AND attnum > 0 AND NOT attisdropped), 14, 'the existing catalog.tat_targets (routine / urgent, seconds) is untouched');

-- ===================================================================================================================================== (6) row level security unchanged on the altered tables
SELECT is((SELECT string_agg(c.relname || '=' || (c.relrowsecurity AND c.relforcerowsecurity)::text || '/' || (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid)::text, ', ' ORDER BY c.relname)
           FROM pg_class c WHERE c.oid IN ('catalog.tests'::regclass, 'catalog.analytes'::regclass, 'catalog.analyte_versions'::regclass, 'catalog.panels'::regclass, 'catalog.comment_codes'::regclass,
             'catalog.comment_code_texts'::regclass, 'catalog.reference_ranges'::regclass, 'catalog.critical_limits'::regclass)),
          'analyte_versions=true/3, analytes=true/3, comment_code_texts=true/3, comment_codes=true/3, critical_limits=true/4, panels=true/3, reference_ranges=true/4, tests=true/3',
          'RLS FORCE and policy counts of the eight altered tables are exactly as in C3 (3 / 3 / 3 / 3 / 3 / 3 / 4 / 4)');
SELECT is(pg_temp.a($q$SELECT 1 FROM catalog.tests$q$, 'n'), 'n=2', 'tenant A staff still sees only its 2 tests');
SELECT is(pg_temp.b($q$SELECT 1 FROM catalog.tests$q$, 'n'), 'n=1', 'tenant B staff still sees only its 1 test');
SELECT is(pg_temp.a($q$UPDATE catalog.tests SET short_name = 'X' WHERE id = '0190c600-0000-7000-8000-000000000012'$q$), 'n=0', 'tenant A cannot write the new test fields of a tenant B test');
SELECT is(pg_temp.a($q$UPDATE catalog.analytes SET trend_name = 'X' WHERE id = '0190c600-0000-7000-8000-000000000023'$q$), 'n=0', 'tenant A cannot write the new analyte fields of a tenant B analyte');
SELECT is(pg_temp.a($q$UPDATE catalog.panels SET loyalty_points = 9 WHERE id = '0190c600-0000-7000-8000-000000000013' AND tenant_id = '01a1a98a-ac40-7000-8000-00000000b001'$q$), 'n=0', 'tenant A cannot write panel parity fields of tenant B');
SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), 'patient'), 'SELECT 1 FROM catalog.tests', 'n'), 'n=0', 'patient claims still see 0 tests');
SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), 'partner'), 'SELECT 1 FROM catalog.reference_ranges', 'n'), 'n=0', 'partner claims still see 0 bands');

-- ===================================================================================================================================== (7) idempotent re-apply: second run changes nothing
CREATE TEMP TABLE before_state AS
  SELECT (SELECT count(*) FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid WHERE c.relnamespace = 'catalog'::regnamespace AND c.relkind IN ('r','p') AND a.attnum > 0 AND NOT a.attisdropped) AS cols,
         (SELECT count(*) FROM pg_constraint k WHERE k.connamespace = 'catalog'::regnamespace) AS cons,
         (SELECT count(*) FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid WHERE c.relnamespace = 'catalog'::regnamespace) AS idxs,
         (SELECT count(*) FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid WHERE c.relnamespace = 'catalog'::regnamespace) AS pols,
         (SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relnamespace = 'catalog'::regnamespace AND NOT t.tgisinternal) AS trgs,
         (SELECT count(*) FROM pg_class c WHERE c.relnamespace = 'catalog'::regnamespace AND c.relkind IN ('r','p')) AS tbls,
         (SELECT string_agg(conname || ':' || pg_get_constraintdef(oid), '|' ORDER BY conname) FROM pg_constraint WHERE connamespace = 'catalog'::regnamespace AND contype = 'c') AS checks,
         (SELECT count(*) FROM catalog.tests) AS n_tests, pg_temp.q('SELECT count(*) FROM catalog.test_categories') AS n_cats, pg_temp.q('SELECT count(*) FROM catalog.test_stage_tat_targets') AS n_stages,
         pg_temp.q('SELECT short_name FROM catalog.tests WHERE id = ''0190c600-0000-7000-8000-000000000014''') AS short_14;
\ir ../../migrations/20261117170000_catalog__test_management_parity.sql
RESET ROLE;
SELECT is((SELECT count(*) FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid WHERE c.relnamespace = 'catalog'::regnamespace AND c.relkind IN ('r','p') AND a.attnum > 0 AND NOT a.attisdropped), (SELECT cols FROM before_state), 're-apply: column count unchanged');
SELECT is((SELECT count(*) FROM pg_constraint k WHERE k.connamespace = 'catalog'::regnamespace), (SELECT cons FROM before_state), 're-apply: constraint count unchanged');
SELECT is((SELECT count(*) FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid WHERE c.relnamespace = 'catalog'::regnamespace), (SELECT idxs FROM before_state), 're-apply: index count unchanged');
SELECT is((SELECT count(*) FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid WHERE c.relnamespace = 'catalog'::regnamespace), (SELECT pols FROM before_state), 're-apply: policy count unchanged');
SELECT is((SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relnamespace = 'catalog'::regnamespace AND NOT t.tgisinternal), (SELECT trgs FROM before_state), 're-apply: trigger count unchanged');
SELECT is((SELECT count(*) FROM pg_class c WHERE c.relnamespace = 'catalog'::regnamespace AND c.relkind IN ('r','p')), (SELECT tbls FROM before_state), 're-apply: table count unchanged');
SELECT is((SELECT string_agg(conname || ':' || pg_get_constraintdef(oid), '|' ORDER BY conname) FROM pg_constraint WHERE connamespace = 'catalog'::regnamespace AND contype = 'c'), (SELECT checks FROM before_state), 're-apply: every CHECK definition unchanged');
SELECT is((SELECT count(*) FROM catalog.tests), (SELECT n_tests FROM before_state), 're-apply: no test row added or removed');
SELECT is(pg_temp.q('SELECT count(*) FROM catalog.test_categories'), (SELECT n_cats FROM before_state), 're-apply: no category row added or removed');
SELECT is(pg_temp.q('SELECT count(*) FROM catalog.test_stage_tat_targets'), (SELECT n_stages FROM before_state), 're-apply: no stage target row added or removed');
SELECT is(pg_temp.q('SELECT short_name FROM catalog.tests WHERE id = ''0190c600-0000-7000-8000-000000000014'''), (SELECT short_14 FROM before_state), 're-apply: no data rewrite (filled value intact)');

SELECT * FROM finish();
ROLLBACK;
