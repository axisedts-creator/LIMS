-- C14 T02 fixtures for the smartreport repository integration tests (synthetic data only; fresh migrated + seeded database + smartreport DDL, superuser session).
-- Technique of tests/db/c5-t03/fixtures.sql: superuser inserts, core system actor claims, SET LOCAL session_replication_role = replica so the draft-only/transition triggers
-- and cross-schema FK triggers do not run while the fixture is laid down (the repositories later run as lims_api with every constraint live).
-- Tenants/branches/centres/memberships come from db/seeds/010 (tenant A ...a001, B ...b001; branches a101/b101; centres a201/a202/b201; memberships a500/b500).
-- Shape (ids via pg_temp.uid(n)):
--   tenant A: patient 1; frontdesk orders 11 (a201) 12 (a202) 13 (a201) 14 (a201) 15 (a201, NO summary); catalog tests 7001 7002, analytes 5001 5002 5003
--             library v1 uid(101) retired, v2 uid(102) approved, v3 uid(103) draft (open)
--             blocks: draft 301 deranged 'der.glucose.high', 302 advice 'adv.glucose.diet', 303 followup 'fup.glucose.repeat', 304 INACTIVE advice 'adv.old.text'; approved lib 311 deranged, 312 advice
--             rules: draft 401 deranged/analyte 5001, 402 advice/group glucose, 403 followup (test 7001, 90 d), 404 INACTIVE deranged; approved lib 411 deranged
--             analyte_groups: draft 501 (5001->glucose) 502 (5002->lipids) 503 INACTIVE (5003->kidney); approved lib 511; group_settings: draft 601 glucose, 602 lipids; approved lib 611
--             deny terms: 701 'miracle' en, 702 'cure-all' en INACTIVE
--             summaries: 801 order 11 a201 draft (built -5 min), 802 order 12 a202 approved (-4), 803 order 13 a201 rejected (-3), 804 order 14 a201 draft (-1), 805 order 11 superseded (-10)
--             bindings 901 902 (summary 802, report versions 1, 2); summary_reviews 911 912 (802); library_reviews 921 922 (lib 102); llm_runs 931 (summary 801)
--   tenant B: patient 2; order 21 (b201); test 7101, analyte 5101; library uid(201) approved (NO open draft); block 3201; rule 4201; mapping 5201; group_setting 6201; deny term 7201 'miracle' en;
--             summary 8101 order 21 draft; binding 9101; summary_review 9111; library_review 9121; llm_run 9131
BEGIN;
SET search_path = extensions, public, pg_catalog;
SET LOCAL session_replication_role = replica;

CREATE FUNCTION pg_temp.ta() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1a98a-ac40-7000-8000-00000000a001'::uuid $$;
CREATE FUNCTION pg_temp.tb() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1a98a-ac40-7000-8000-00000000b001'::uuid $$;
CREATE FUNCTION pg_temp.sys() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1b34e-1000-7eee-9d29-d7ca59a102b5'::uuid $$;
CREATE FUNCTION pg_temp.uid(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('0190c514-0000-7000-8000-' || lpad(n::text, 12, '0'))::uuid $$;
CREATE FUNCTION pg_temp.id(s text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('01a1a98a-ac40-7000-8000-' || s)::uuid $$;
CREATE FUNCTION pg_temp.h(n int) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT lpad(to_hex(n), 64, '0') $$;
SELECT set_config('request.jwt.claims', jsonb_build_object('tenant_id', pg_temp.ta(), 'sub', pg_temp.sys(), 'actor_type', 'system')::text, true);

CREATE FUNCTION pg_temp.ins(p_tbl regclass, p_row jsonb) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE r jsonb := p_row; a text; cols text; saved text := current_setting('request.jwt.claims', true);
BEGIN
  IF r ? 'tenant_id' THEN PERFORM set_config('request.jwt.claims', jsonb_build_object('tenant_id', r->>'tenant_id', 'sub', pg_temp.sys(), 'actor_type', 'system')::text, true); END IF;
  FOREACH a IN ARRAY ARRAY['created_by', 'updated_by'] LOOP
    IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = p_tbl AND attname = a AND NOT attisdropped) AND NOT (r ? a) THEN r := r || jsonb_build_object(a, pg_temp.sys()); END IF;
  END LOOP;
  SELECT string_agg(quote_ident(k), ',') INTO cols FROM jsonb_object_keys(r) k;
  EXECUTE format('INSERT INTO %1$s (%2$s) SELECT %2$s FROM jsonb_populate_record(NULL::%1$s, %3$L::jsonb)', p_tbl, cols, r::text);
  PERFORM set_config('request.jwt.claims', coalesce(saved, ''), true);
END $f$;

-- ---------------------------------------------------------------- frontdesk + catalog parents
SELECT pg_temp.ins('frontdesk.patients', jsonb_build_object('id', pg_temp.uid(1), 'tenant_id', pg_temp.ta(), 'patient_code', 'P-0001', 'full_name', 'Test Patient 0001', 'name_search', 'test patient 0001', 'sex', 'female', 'registered_centre_id', pg_temp.id('00000000a201')));
SELECT pg_temp.ins('frontdesk.patients', jsonb_build_object('id', pg_temp.uid(2), 'tenant_id', pg_temp.tb(), 'patient_code', 'P-0001', 'full_name', 'Test Patient 0002', 'name_search', 'test patient 0002', 'sex', 'male', 'registered_centre_id', pg_temp.id('00000000b201')));
SELECT pg_temp.ins('frontdesk.orders', jsonb_build_object('id', pg_temp.uid(o.n), 'tenant_id', o.t, 'branch_id', o.br, 'centre_id', o.c, 'patient_id', o.p, 'registration_no', 'R-' || o.n, 'status', 'registered', 'visit_type', 'opd',
    'billing_mode', 'cash', 'priority', 'routine', 'collection_mode', 'walk_in', 'source', 'front_desk', 'is_first_order_of_patient', true, 'catalog_revision', 1, 'registered_at', now()))
  FROM (VALUES (11, pg_temp.ta(), pg_temp.id('00000000a101'), pg_temp.id('00000000a201'), pg_temp.uid(1)),
               (12, pg_temp.ta(), pg_temp.id('00000000a101'), pg_temp.id('00000000a202'), pg_temp.uid(1)),
               (13, pg_temp.ta(), pg_temp.id('00000000a101'), pg_temp.id('00000000a201'), pg_temp.uid(1)),
               (14, pg_temp.ta(), pg_temp.id('00000000a101'), pg_temp.id('00000000a201'), pg_temp.uid(1)),
               (15, pg_temp.ta(), pg_temp.id('00000000a101'), pg_temp.id('00000000a201'), pg_temp.uid(1)),
               (21, pg_temp.tb(), pg_temp.id('00000000b101'), pg_temp.id('00000000b201'), pg_temp.uid(2))) o(n, t, br, c, p);
SELECT pg_temp.ins('catalog.tests', jsonb_build_object('id', pg_temp.uid(t.n), 'tenant_id', t.t, 'workflow_type', 'standard')) FROM (VALUES (7001, pg_temp.ta()), (7002, pg_temp.ta()), (7101, pg_temp.tb())) t(n, t);
SELECT pg_temp.ins('catalog.analytes', jsonb_build_object('id', pg_temp.uid(a.n), 'tenant_id', a.t, 'test_id', pg_temp.uid(a.tn), 'code', a.code, 'name', 'Analyte ' || a.code))
  FROM (VALUES (5001, pg_temp.ta(), 7001, 'GLU'), (5002, pg_temp.ta(), 7001, 'CHOL'), (5003, pg_temp.ta(), 7002, 'CREA'), (5101, pg_temp.tb(), 7101, 'GLU')) a(n, t, tn, code);

-- ---------------------------------------------------------------- library versions
SELECT pg_temp.ins('smartreport.library_versions', jsonb_build_object('id', pg_temp.uid(101), 'tenant_id', pg_temp.ta(), 'version_no', 1, 'status', 'retired', 'content_sha256', pg_temp.h(101),
  'approved_at', now() - interval '60 days', 'approved_by_membership_id', pg_temp.id('00000000a500'), 'retired_at', now() - interval '30 days'));
SELECT pg_temp.ins('smartreport.library_versions', jsonb_build_object('id', pg_temp.uid(102), 'tenant_id', pg_temp.ta(), 'version_no', 2, 'status', 'approved', 'content_sha256', pg_temp.h(102),
  'approved_at', now() - interval '30 days', 'approved_by_membership_id', pg_temp.id('00000000a500')));
SELECT pg_temp.ins('smartreport.library_versions', jsonb_build_object('id', pg_temp.uid(103), 'tenant_id', pg_temp.ta(), 'version_no', 3, 'status', 'draft', 'change_summary', 'fixture draft'));
SELECT pg_temp.ins('smartreport.library_versions', jsonb_build_object('id', pg_temp.uid(201), 'tenant_id', pg_temp.tb(), 'version_no', 1, 'status', 'approved', 'content_sha256', pg_temp.h(201),
  'approved_at', now() - interval '30 days', 'approved_by_membership_id', pg_temp.id('00000000b500')));

-- ---------------------------------------------------------------- blocks, rules, mappings, group settings, deny terms
SELECT pg_temp.ins('smartreport.template_blocks', jsonb_build_object('id', pg_temp.uid(b.n), 'tenant_id', b.t, 'library_version_id', pg_temp.uid(b.l), 'block_key', b.k, 'kind', b.kind, 'text_en', 'Fixture text ' || b.k, 'is_active', b.act))
  FROM (VALUES (301, pg_temp.ta(), 103, 'der.glucose.high', 'deranged', true), (302, pg_temp.ta(), 103, 'adv.glucose.diet', 'advice', true),
               (303, pg_temp.ta(), 103, 'fup.glucose.repeat', 'followup', true), (304, pg_temp.ta(), 103, 'adv.old.text', 'advice', false),
               (311, pg_temp.ta(), 102, 'der.glucose.high', 'deranged', true), (312, pg_temp.ta(), 102, 'adv.glucose.diet', 'advice', true),
               (3201, pg_temp.tb(), 201, 'der.glucose.high', 'deranged', true)) b(n, t, l, k, kind, act);
SELECT pg_temp.ins('smartreport.rules', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', r.t, 'library_version_id', pg_temp.uid(r.l), 'rule_kind', r.k, 'trigger_kind', r.tk, 'direction', r.d,
    'block_id', pg_temp.uid(r.b), 'block_kind', r.k, 'priority', r.pr, 'is_active', r.act) || r.x)
  FROM (VALUES (401, pg_temp.ta(), 103, 'deranged', 'analyte', 'high', 301, 100, true, jsonb_build_object('analyte_id', pg_temp.uid(5001), 'min_severity', 'borderline')),
               (402, pg_temp.ta(), 103, 'advice', 'group', 'abnormal', 302, 200, true, jsonb_build_object('group_code', 'glucose', 'min_severity', 'out_of_range')),
               (403, pg_temp.ta(), 103, 'followup', 'analyte', 'high', 303, 300, true, jsonb_build_object('analyte_id', pg_temp.uid(5001), 'min_severity', 'out_of_range', 'suggested_test_id', pg_temp.uid(7001), 'interval_days', 90)),
               (404, pg_temp.ta(), 103, 'deranged', 'any', 'any', 301, 400, false, jsonb_build_object('min_severity', 'critical')),
               (411, pg_temp.ta(), 102, 'deranged', 'analyte', 'high', 311, 100, true, jsonb_build_object('analyte_id', pg_temp.uid(5001), 'min_severity', 'borderline')),
               (4201, pg_temp.tb(), 201, 'deranged', 'analyte', 'high', 3201, 100, true, jsonb_build_object('analyte_id', pg_temp.uid(5101), 'min_severity', 'borderline'))) r(n, t, l, k, tk, d, b, pr, act, x);
SELECT pg_temp.ins('smartreport.analyte_groups', jsonb_build_object('id', pg_temp.uid(g.n), 'tenant_id', g.t, 'library_version_id', pg_temp.uid(g.l), 'analyte_id', pg_temp.uid(g.a), 'group_code', g.gc, 'is_active', g.act))
  FROM (VALUES (501, pg_temp.ta(), 103, 5001, 'glucose', true), (502, pg_temp.ta(), 103, 5002, 'lipids', true), (503, pg_temp.ta(), 103, 5003, 'kidney', false),
               (511, pg_temp.ta(), 102, 5001, 'glucose', true), (5201, pg_temp.tb(), 201, 5101, 'glucose', true)) g(n, t, l, a, gc, act);
SELECT pg_temp.ins('smartreport.group_settings', jsonb_build_object('id', pg_temp.uid(g.n), 'tenant_id', g.t, 'library_version_id', pg_temp.uid(g.l), 'group_code', g.gc, 'display_en', g.d, 'sort_order', g.so))
  FROM (VALUES (601, pg_temp.ta(), 103, 'glucose', 'Blood sugar', 20), (602, pg_temp.ta(), 103, 'lipids', 'Cholesterol and lipids', 30),
               (611, pg_temp.ta(), 102, 'glucose', 'Blood sugar', 20), (6201, pg_temp.tb(), 201, 'glucose', 'Blood sugar', 20)) g(n, t, l, gc, d, so);
SELECT pg_temp.ins('smartreport.wording_deny_terms', jsonb_build_object('id', pg_temp.uid(d.n), 'tenant_id', d.t, 'term', d.term, 'term_folded', d.term, 'language', 'en', 'is_active', d.act))
  FROM (VALUES (701, pg_temp.ta(), 'miracle', true), (702, pg_temp.ta(), 'cure-all', false), (7201, pg_temp.tb(), 'miracle', true)) d(n, t, term, act);

-- ---------------------------------------------------------------- summaries
SELECT pg_temp.ins('smartreport.summaries', jsonb_build_object('id', pg_temp.uid(s.n), 'tenant_id', s.t, 'centre_id', s.c, 'order_id', pg_temp.uid(s.o), 'patient_id', s.p, 'library_version_id', pg_temp.uid(s.l),
    'template_library_version', s.lv, 'formula_version', 'hs-1', 'language', 'en', 'approved_set_hash', pg_temp.h(s.n), 'input_result_versions', jsonb_build_array('r' || s.n || ':1'), 'status', s.st,
    'content', jsonb_build_object('fixture', s.n), 'content_sha256', pg_temp.h(s.n + 5000), 'built_at', now() - make_interval(mins => s.age)) || s.x)
  FROM (VALUES (801, pg_temp.ta(), pg_temp.id('00000000a201'), 11, pg_temp.uid(1), 102, '2', 'draft', 5, '{}'::jsonb),
               (802, pg_temp.ta(), pg_temp.id('00000000a202'), 12, pg_temp.uid(1), 102, '2', 'approved', 4, jsonb_build_object('approved_at', now(), 'approved_by_membership_id', pg_temp.id('00000000a500'))),
               (803, pg_temp.ta(), pg_temp.id('00000000a201'), 13, pg_temp.uid(1), 102, '2', 'rejected', 3, jsonb_build_object('rejected_at', now(), 'rejected_by_membership_id', pg_temp.id('00000000a500'), 'reject_reason_code', 'other')),
               (804, pg_temp.ta(), pg_temp.id('00000000a201'), 14, pg_temp.uid(1), 102, '2', 'draft', 1, '{}'::jsonb),
               (805, pg_temp.ta(), pg_temp.id('00000000a201'), 11, pg_temp.uid(1), 101, '1', 'superseded', 10, jsonb_build_object('superseded_at', now(), 'superseded_reason', 'library_rebuild', 'superseded_by_summary_id', pg_temp.uid(801))),
               (8101, pg_temp.tb(), pg_temp.id('00000000b201'), 21, pg_temp.uid(2), 201, '1', 'draft', 2, '{}'::jsonb)) s(n, t, c, o, p, l, lv, st, age, x);

-- ---------------------------------------------------------------- class A children
SELECT pg_temp.ins('smartreport.summary_report_bindings', jsonb_build_object('id', pg_temp.uid(b.n), 'tenant_id', b.t, 'centre_id', b.c, 'summary_id', pg_temp.uid(b.s), 'order_id', pg_temp.uid(b.o), 'report_version_no', b.v, 'bound_at', now()))
  FROM (VALUES (901, pg_temp.ta(), pg_temp.id('00000000a202'), 802, 12, 1), (902, pg_temp.ta(), pg_temp.id('00000000a202'), 802, 12, 2), (9101, pg_temp.tb(), pg_temp.id('00000000b201'), 8101, 21, 1)) b(n, t, c, s, o, v);
SELECT pg_temp.ins('smartreport.summary_reviews', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', r.t, 'centre_id', r.c, 'summary_id', pg_temp.uid(r.s), 'action', r.a, 'actor_membership_id', r.m, 'created_at', now() - make_interval(mins => r.age)))
  FROM (VALUES (911, pg_temp.ta(), pg_temp.id('00000000a202'), 802, 'approved', pg_temp.id('00000000a500'), 3), (912, pg_temp.ta(), pg_temp.id('00000000a202'), 802, 'llm_rephrase_requested', pg_temp.id('00000000a500'), 2),
               (9111, pg_temp.tb(), pg_temp.id('00000000b201'), 8101, 'approved', pg_temp.id('00000000b500'), 1)) r(n, t, c, s, a, m, age);
SELECT pg_temp.ins('smartreport.library_reviews', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', r.t, 'library_version_id', pg_temp.uid(r.l), 'action', r.a, 'actor_membership_id', r.m, 'created_at', now() - make_interval(mins => r.age)))
  FROM (VALUES (921, pg_temp.ta(), 102, 'submitted', pg_temp.id('00000000a500'), 20), (922, pg_temp.ta(), 102, 'approved', pg_temp.id('00000000a500'), 10), (9121, pg_temp.tb(), 201, 'approved', pg_temp.id('00000000b500'), 10)) r(n, t, l, a, m, age);
SELECT pg_temp.ins('smartreport.llm_runs', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', r.t, 'centre_id', r.c, 'summary_id', pg_temp.uid(r.s), 'status', 'succeeded', 'prompt_template_version', 'p1',
    'model_ref', 'fixture-model', 'input_sha256', pg_temp.h(r.n), 'items', '[]'::jsonb))
  FROM (VALUES (931, pg_temp.ta(), pg_temp.id('00000000a201'), 801), (9131, pg_temp.tb(), pg_temp.id('00000000b201'), 8101)) r(n, t, c, s);

ANALYZE smartreport.summaries;
COMMIT;
