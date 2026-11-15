-- T0B-13.C14 behaviour suite: tenant / centre isolation, staff/system-only actor guard (device, patient, portal, partner, no claims), no DELETE anywhere, draft-only children, library + summary transitions, supersede chain,
-- partial uniques, composite FKs, CHECKs, deactivation, audit (C14 05-SCHEMA §4, §5, §6, §9, §10 tests 1-13; AC-0B-2.4, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 4.1, 4.2, 4.3, 5.1, 5.2, 5.3, 6.1, 6.2, 6.3).
-- The generated per-table probes (db/tests/isolation/smartreport.<t>.test.sql) are the AC-0B-3.x proof for every table; this file proves what the generator cannot know (guards, transitions, uniques, FKs, CHECKs, actor guard).
-- Synthetic data only (seeds 010: tenant A 01a1a98a-...-a001, tenant B ...-b001; centres a201, a202, b201; memberships a500 all-centres staff, a50a staff restricted to centre a201, b500).
-- One rolled-back transaction. RLS is never disabled. FK PARENT rows of other chunks (catalog tests / analytes, frontdesk patients / orders) and every smartreport fixture are inserted by the superuser test session inside ONE block
-- with the replica session replication role (FK + user triggers off; RLS, CHECK and NOT NULL stay on; C9..C11 precedent) that is reset to origin before the first assertion. Every assertion runs as SET LOCAL ROLE lims_app / lims_api.
-- Run from the repo root: pg_prove -d <db> db/tests/smartreport/T0B-13.C14_behaviour.test.sql   (pgTAP in schema `extensions`; migrations + seeds loaded; superuser)
-- Markers: C14 check 8 fixtures; "C14 test N" = 05-SCHEMA §10 test N: 1 tenant isolation (AC-0B-3.1/3.2/3.3/3.5), 2 centre probe (AC-0B-3.4), 3 no DELETE grant (AC-0B-4.2), 4 child edit when parent in_review, 5 summary content immutable,
-- 6 invalid transitions (AC-0B-4.1), 7 partial uniques, 8 composite FKs (AC-0B-3.5), 9 rules__followup_fields__ck, 10 supersede chain (D-107), 11 actor guard (D-109; AC-0B-3.6/3.7), 12 deactivation (P-18(a)), 13 summaries__inputs__ck; audit (AC-0B-5.x) + no view (AC-0B-6.x) at the end.
-- Order matters inside the transaction: read-only checks first, failing statements next, state-changing statements last (fixtures are shared; each mutation is listed in its section).
BEGIN;
SET search_path = extensions, public, pg_catalog;
SELECT * FROM no_plan();

CREATE FUNCTION pg_temp.ta() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1a98a-ac40-7000-8000-00000000a001'::uuid $$;
CREATE FUNCTION pg_temp.tb() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1a98a-ac40-7000-8000-00000000b001'::uuid $$;
CREATE FUNCTION pg_temp.sys() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1b34e-1000-7eee-9d29-d7ca59a102b5'::uuid $$;
CREATE FUNCTION pg_temp.uid(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('0190c900-0000-7000-8000-' || lpad(n::text, 12, '0'))::uuid $$;
CREATE FUNCTION pg_temp.id(s text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('01a1a98a-ac40-7000-8000-' || s)::uuid $$;
CREATE FUNCTION pg_temp.m(s text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('01a1a98a-ac40-7000-8000-00000000' || s)::uuid $$;     -- membership ids: a500, a50a, b500
CREATE FUNCTION pg_temp.q(u uuid) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT quote_literal(u::text) $$;
CREATE FUNCTION pg_temp.u(n int) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT quote_literal(pg_temp.uid(n)::text) $$;
SELECT set_config('request.jwt.claims', jsonb_build_object('tenant_id', pg_temp.ta(), 'sub', pg_temp.sys(), 'actor_type', 'system')::text, true);

-- fixture insert: only the keys given are written (defaults apply to the rest); created_by / updated_by default to the system actor
CREATE FUNCTION pg_temp.ins(p_tbl regclass, p_row jsonb) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE r jsonb := p_row; a text; cols text;
BEGIN
  FOREACH a IN ARRAY ARRAY['created_by', 'updated_by'] LOOP
    IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = p_tbl AND attname = a AND NOT attisdropped) AND NOT (r ? a) THEN r := r || jsonb_build_object(a, pg_temp.sys()); END IF;
  END LOOP;
  SELECT string_agg(quote_ident(k), ',') INTO cols FROM jsonb_object_keys(r) k;
  EXECUTE format('INSERT INTO %1$s (%2$s) SELECT %2$s FROM jsonb_populate_record(NULL::%1$s, %3$L::jsonb)', p_tbl, cols, r::text);
END $f$;
-- run p_sql as p_role with p_claims; mode n = count of a query, w = ROW_COUNT of a statement, s = the single scalar; errors -> 'E' || SQLSTATE || '|' || SQLERRM
CREATE FUNCTION pg_temp.x(p_role text, p_claims jsonb, p_sql text, p_mode text DEFAULT 'n') RETURNS text LANGUAGE plpgsql AS $f$
DECLARE r text; n bigint; saved text := current_setting('request.jwt.claims', true);
BEGIN
  PERFORM set_config('request.jwt.claims', coalesce(p_claims::text, ''), true);
  EXECUTE format('SET LOCAL ROLE %I', p_role);
  BEGIN
    IF p_mode = 's' THEN EXECUTE p_sql INTO r; r := coalesce(r, '<null>');
    ELSE
      IF p_mode = 'n' THEN EXECUTE 'SELECT count(*) FROM (' || p_sql || ') t' INTO n; ELSE EXECUTE p_sql; GET DIAGNOSTICS n = ROW_COUNT; END IF;
      r := 'n=' || n;
    END IF;
  EXCEPTION WHEN OTHERS THEN r := 'E' || SQLSTATE || '|' || SQLERRM; END;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', coalesce(saved, ''), true);
  RETURN r;
END $f$;
CREATE FUNCTION pg_temp.cl(p_tenant uuid, p_type text DEFAULT 'system', p_mem uuid DEFAULT NULL) RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('actor_type', p_type, 'tenant_id', p_tenant, 'sub', pg_temp.sys()) || CASE WHEN p_mem IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('membership_id', p_mem) END $$;
CREATE FUNCTION pg_temp.sa(p_sql text, p_mode text DEFAULT 'w') RETURNS text LANGUAGE sql AS $$ SELECT pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta()), p_sql, p_mode) $$;                  -- tenant A system actor
CREATE FUNCTION pg_temp.sb(p_sql text, p_mode text DEFAULT 'w') RETURNS text LANGUAGE sql AS $$ SELECT pg_temp.x('lims_app', pg_temp.cl(pg_temp.tb()), p_sql, p_mode) $$;                  -- tenant B system actor
CREATE FUNCTION pg_temp.ua(p_mem uuid, p_sql text, p_mode text DEFAULT 'w') RETURNS text LANGUAGE sql AS $$ SELECT pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), 'user', p_mem), p_sql, p_mode) $$;   -- tenant A staff user
-- copy statement: INSERT of an existing row (by id) with overrides; the row is read NOW (superuser) and embedded as a literal, so it runs under any claims without reading the table
CREATE FUNCTION pg_temp.cps(p_q text, p_aid int, p_over jsonb DEFAULT '{}'::jsonb) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE j jsonb;
BEGIN
  EXECUTE format('SELECT to_jsonb(t) FROM %s t WHERE id = %L', p_q, pg_temp.uid(p_aid)) INTO j;
  IF j IS NULL THEN RAISE EXCEPTION 'cps: no row % in %', p_aid, p_q; END IF;
  RETURN format('INSERT INTO %1$s SELECT (jsonb_populate_record(NULL::%1$s, %2$L::jsonb)).*', p_q, (j || p_over)::text);
END $f$;
-- tt: 11 tenant tables with one tenant A row id each; tc: the 4 centre-scoped tables; tg: 3 G tables; ts: tables with a lims_app UPDATE grant; tk: the 4 draft-only children
CREATE TEMP TABLE tt(q, aid) AS VALUES ('smartreport.library_versions',3001),('smartreport.template_blocks',3101),('smartreport.rules',3201),('smartreport.analyte_groups',3301),('smartreport.group_settings',3401),
  ('smartreport.wording_deny_terms',3501),('smartreport.library_reviews',3601),('smartreport.summaries',3701),('smartreport.summary_report_bindings',3802),('smartreport.summary_reviews',3901),('smartreport.llm_runs',4001);
CREATE TEMP TABLE tc(q, aid) AS VALUES ('smartreport.summaries',3701),('smartreport.summary_report_bindings',3802),('smartreport.summary_reviews',3901),('smartreport.llm_runs',4001);
CREATE TEMP TABLE tg(q) AS VALUES ('smartreport.g_cs_organ_groups'),('smartreport.g_cs_summary_reject_reasons'),('smartreport.g_cs_wording_deny_terms');
CREATE TEMP TABLE ts(q) AS VALUES ('smartreport.library_versions'),('smartreport.template_blocks'),('smartreport.rules'),('smartreport.analyte_groups'),('smartreport.group_settings'),('smartreport.wording_deny_terms'),('smartreport.summaries');
CREATE TEMP TABLE tk(q) AS VALUES ('smartreport.template_blocks'),('smartreport.rules'),('smartreport.analyte_groups'),('smartreport.group_settings');
-- base override of a deranged rule copied from the followup rule 3201 (valid on its own)
CREATE FUNCTION pg_temp.rbase() RETURNS jsonb LANGUAGE sql AS $$ SELECT jsonb_build_object('rule_kind', 'deranged', 'trigger_kind', 'any', 'direction', 'high', 'min_severity', 'out_of_range', 'block_id', pg_temp.uid(3103), 'block_kind', 'deranged', 'suggested_test_id', NULL::text, 'interval_days', NULL::int) $$;
CREATE FUNCTION pg_temp.hx(c text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT repeat(c, 64) $$;

-- ===================================================================================================================================== fixtures (superuser, replica block)
-- C14 check 8: tenant A library 3001 (approved v1) + 3002 (draft v2) with children; tenant B library 3003 (approved); summaries 3701 draft, 3702 approved, 3703 superseded, 3704 draft, 3707 rejected (A) and 3706 (B)
SET LOCAL session_replication_role = replica;
SELECT pg_temp.ins('catalog.tests', jsonb_build_object('id', pg_temp.uid(2001), 'tenant_id', pg_temp.ta(), 'workflow_type', 'standard'));
SELECT pg_temp.ins('catalog.tests', jsonb_build_object('id', pg_temp.uid(2002), 'tenant_id', pg_temp.tb(), 'workflow_type', 'standard'));
SELECT pg_temp.ins('catalog.analytes', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', r.t, 'test_id', pg_temp.uid(r.te), 'code', r.c, 'name', r.c || ' (SYNTHETIC)'))
  FROM (VALUES (2101, pg_temp.ta(), 2001, 'HB'), (2102, pg_temp.ta(), 2001, 'GLU'), (2103, pg_temp.tb(), 2002, 'HB')) r(n, t, te, c);
SELECT pg_temp.ins('frontdesk.patients', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', r.t, 'patient_code', 'P-' || r.n, 'full_name', 'Test Patient ' || r.n, 'name_search', 'test patient ' || r.n, 'sex', 'female', 'registered_centre_id', pg_temp.id(r.c)))
  FROM (VALUES (2201, pg_temp.ta(), '00000000a201'), (2202, pg_temp.tb(), '00000000b201')) r(n, t, c);
SELECT pg_temp.ins('frontdesk.orders', jsonb_build_object('id', pg_temp.uid(o.n), 'tenant_id', o.t, 'branch_id', pg_temp.id(o.br), 'centre_id', pg_temp.id(o.c), 'patient_id', pg_temp.uid(o.p), 'registration_no', 'R-' || o.n, 'status', 'registered', 'visit_type', 'opd', 'billing_mode', 'cash',
    'priority', 'routine', 'collection_mode', 'walk_in', 'source', 'front_desk', 'is_first_order_of_patient', true, 'catalog_revision', 1, 'registered_at', now()))
  FROM (VALUES (2301, pg_temp.ta(), '00000000a101', '00000000a201', 2201), (2302, pg_temp.ta(), '00000000a102', '00000000a202', 2201), (2303, pg_temp.ta(), '00000000a101', '00000000a201', 2201), (2304, pg_temp.ta(), '00000000a101', '00000000a201', 2201),
    (2305, pg_temp.tb(), '00000000b101', '00000000b201', 2202), (2306, pg_temp.ta(), '00000000a101', '00000000a201', 2201), (2307, pg_temp.ta(), '00000000a101', '00000000a201', 2201), (2308, pg_temp.ta(), '00000000a101', '00000000a201', 2201)) o(n, t, br, c, p);
SELECT pg_temp.ins('smartreport.library_versions', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', r.t, 'version_no', r.v, 'status', r.st) || r.x)
  FROM (VALUES (3001, pg_temp.ta(), 1, 'approved', jsonb_build_object('content_sha256', pg_temp.hx('a'), 'approved_at', now(), 'approved_by_membership_id', pg_temp.m('a500'))),
    (3002, pg_temp.ta(), 2, 'draft', '{}'::jsonb),
    (3003, pg_temp.tb(), 1, 'approved', jsonb_build_object('content_sha256', pg_temp.hx('a'), 'approved_at', now(), 'approved_by_membership_id', pg_temp.m('b500')))) r(n, t, v, st, x);
SELECT pg_temp.ins('smartreport.template_blocks', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', r.t, 'library_version_id', pg_temp.uid(r.l), 'block_key', r.k, 'kind', r.kd, 'text_en', 'Synthetic template text'))
  FROM (VALUES (3101, pg_temp.ta(), 3002, 'advice.general', 'advice'), (3102, pg_temp.ta(), 3002, 'followup.cbc', 'followup'), (3103, pg_temp.ta(), 3002, 'deranged.hb', 'deranged'),
    (3104, pg_temp.ta(), 3001, 'advice.old', 'advice'), (3105, pg_temp.tb(), 3003, 'advice.b', 'advice')) r(n, t, l, k, kd);
SELECT pg_temp.ins('smartreport.rules', jsonb_build_object('id', pg_temp.uid(3201), 'tenant_id', pg_temp.ta(), 'library_version_id', pg_temp.uid(3002), 'rule_kind', 'followup', 'trigger_kind', 'any', 'direction', 'any', 'min_severity', 'borderline',
  'block_id', pg_temp.uid(3102), 'block_kind', 'followup', 'suggested_test_id', pg_temp.uid(2001), 'interval_days', 90));
SELECT pg_temp.ins('smartreport.rules', jsonb_build_object('id', pg_temp.uid(3202), 'tenant_id', pg_temp.ta(), 'library_version_id', pg_temp.uid(3002), 'rule_kind', 'advice', 'trigger_kind', 'all_in_range', 'direction', 'any',
  'block_id', pg_temp.uid(3101), 'block_kind', 'advice'));
SELECT pg_temp.ins('smartreport.analyte_groups', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', r.t, 'library_version_id', pg_temp.uid(r.l), 'analyte_id', pg_temp.uid(r.a), 'group_code', 'blood_counts'))
  FROM (VALUES (3301, pg_temp.ta(), 3002, 2101), (3302, pg_temp.ta(), 3001, 2101), (3303, pg_temp.tb(), 3003, 2103)) r(n, t, l, a);
SELECT pg_temp.ins('smartreport.group_settings', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', r.t, 'library_version_id', pg_temp.uid(r.l), 'group_code', 'blood_counts', 'display_en', 'Blood counts', 'sort_order', 10))
  FROM (VALUES (3401, pg_temp.ta(), 3002), (3402, pg_temp.tb(), 3003)) r(n, t, l);
SELECT pg_temp.ins('smartreport.wording_deny_terms', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', r.t, 'term', 'cure-all', 'term_folded', 'cure-all', 'language', 'en'))
  FROM (VALUES (3501, pg_temp.ta()), (3502, pg_temp.tb())) r(n, t);
SELECT pg_temp.ins('smartreport.library_reviews', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', r.t, 'library_version_id', pg_temp.uid(r.l), 'action', 'approved'))
  FROM (VALUES (3601, pg_temp.ta(), 3001), (3602, pg_temp.tb(), 3003)) r(n, t, l);
SELECT pg_temp.ins('smartreport.summaries', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', r.t, 'centre_id', pg_temp.id(r.c), 'order_id', pg_temp.uid(r.o), 'patient_id', pg_temp.uid(r.p), 'library_version_id', pg_temp.uid(r.l),
    'template_library_version', '1', 'formula_version', 'hs-1', 'language', 'en', 'approved_set_hash', pg_temp.hx(r.h), 'input_result_versions', jsonb_build_array(pg_temp.uid(9001)::text || ':1'), 'status', r.st,
    'content', '{"x":1}'::jsonb, 'content_sha256', pg_temp.hx('b'), 'built_at', now()) || r.x)
  FROM (VALUES (3701, pg_temp.ta(), '00000000a201', 2301, 2201, 3001, '1', 'draft', '{}'::jsonb),
    (3702, pg_temp.ta(), '00000000a202', 2302, 2201, 3001, '2', 'approved', jsonb_build_object('approved_at', now(), 'approved_by_membership_id', pg_temp.m('a500'))),
    (3703, pg_temp.ta(), '00000000a201', 2303, 2201, 3001, '3', 'superseded', jsonb_build_object('superseded_at', now(), 'superseded_reason', 'results_changed')),
    (3704, pg_temp.ta(), '00000000a201', 2304, 2201, 3001, '4', 'draft', '{}'::jsonb),
    (3707, pg_temp.ta(), '00000000a201', 2306, 2201, 3001, '5', 'rejected', jsonb_build_object('rejected_at', now(), 'rejected_by_membership_id', pg_temp.m('a500'), 'reject_reason_code', 'other')),
    (3706, pg_temp.tb(), '00000000b201', 2305, 2202, 3003, '6', 'draft', '{}'::jsonb)) r(n, t, c, o, p, l, h, st, x);
SELECT pg_temp.ins('smartreport.summary_report_bindings', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', r.t, 'centre_id', pg_temp.id(r.c), 'summary_id', pg_temp.uid(r.s), 'order_id', pg_temp.uid(r.o), 'report_version_no', 1, 'bound_at', now()))
  FROM (VALUES (3801, pg_temp.ta(), '00000000a202', 3702, 2302), (3802, pg_temp.ta(), '00000000a201', 3701, 2301), (3803, pg_temp.tb(), '00000000b201', 3706, 2305)) r(n, t, c, s, o);
SELECT pg_temp.ins('smartreport.summary_reviews', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', r.t, 'centre_id', pg_temp.id(r.c), 'summary_id', pg_temp.uid(r.s), 'action', 'approved'))
  FROM (VALUES (3901, pg_temp.ta(), '00000000a201', 3701), (3902, pg_temp.ta(), '00000000a202', 3702), (3903, pg_temp.tb(), '00000000b201', 3706)) r(n, t, c, s);
SELECT pg_temp.ins('smartreport.llm_runs', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', r.t, 'centre_id', pg_temp.id(r.c), 'summary_id', pg_temp.uid(r.s), 'status', 'succeeded', 'prompt_template_version', 'p1', 'model_ref', 'syn-model',
    'input_sha256', pg_temp.hx('d'), 'items', '[]'::jsonb))
  FROM (VALUES (4001, pg_temp.ta(), '00000000a201', 3701), (4002, pg_temp.ta(), '00000000a202', 3702), (4003, pg_temp.tb(), '00000000b201', 3706)) r(n, t, c, s);
SET LOCAL session_replication_role = origin;      -- back to normal: triggers and FKs are live for every assertion below

SELECT is((SELECT count(*)::int FROM smartreport.library_versions), 3, 'C14 check 8: 3 library version fixtures (A approved + draft, B approved)');
SELECT is((SELECT count(*)::int FROM smartreport.summaries), 6, 'C14 check 8: 6 summary fixtures (5 tenant A, 1 tenant B)');
SELECT is((SELECT count(*)::int FROM smartreport.g_cs_organ_groups), 16, 'C14 check 8: 16 global organ groups seeded (§3.1)');
SELECT is((SELECT count(*)::int FROM smartreport.g_cs_summary_reject_reasons), 5, 'C14 check 8: 5 global reject reasons seeded (§3.2)');
SELECT is((SELECT count(*)::int FROM smartreport.g_cs_wording_deny_terms), 23, 'C14 check 8: 23 global deny terms seeded (§3.3)');

-- ===================================================================================================================================== read-only checks first
-- C14 test 1: tenant isolation (AC-0B-3.1 / 3.2 / 3.3 / 3.5; §10 test 1) - reads
SELECT is(pg_temp.sa('SELECT 1 FROM ' || q || ' WHERE tenant_id = ' || pg_temp.q(pg_temp.tb()), 'n'), 'n=0', 'C14 test 1 / AC-0B-3.1: tenant A system actor sees 0 tenant B rows of ' || q) FROM tt;
SELECT is(pg_temp.ua(pg_temp.m('a500'), 'SELECT 1 FROM ' || q || ' WHERE tenant_id = ' || pg_temp.q(pg_temp.tb()), 'n'), 'n=0', 'C14 test 1 / AC-0B-3.1: tenant A staff user sees 0 tenant B rows of ' || q) FROM tt;
SELECT is(pg_temp.sb('SELECT 1 FROM ' || q || ' WHERE tenant_id = ' || pg_temp.q(pg_temp.ta()), 'n'), 'n=0', 'C14 test 1 / AC-0B-3.1: tenant B system actor sees 0 tenant A rows of ' || q) FROM tt;
SELECT is(pg_temp.sa('SELECT 1 FROM ' || q, 'n') ~ '^n=[1-9]', true, 'C14 test 1: tenant A system actor sees its own rows of ' || q) FROM tt;
SELECT is(pg_temp.sa('SELECT 1 FROM smartreport.library_versions', 'n'), 'n=2', 'C14 test 1: tenant A sees exactly its 2 library versions');
SELECT is(pg_temp.sb('SELECT 1 FROM smartreport.library_versions', 'n'), 'n=1', 'C14 test 1: tenant B sees exactly its library version');
SELECT is(pg_temp.sa('SELECT 1 FROM smartreport.summaries', 'n'), 'n=5', 'C14 test 1: tenant A sees exactly its 5 summaries');
SELECT is(pg_temp.sb('SELECT 1 FROM smartreport.summaries', 'n'), 'n=1', 'C14 test 1: tenant B sees exactly its summary');
SELECT is(pg_temp.sa('SELECT 1 FROM ' || q, 'n'), 'n=' || (SELECT count(*) FROM smartreport.g_cs_organ_groups), 'C14 test 1 / AC-0B-3.5: the global coded sets are readable by every tenant (' || q || ')') FROM (VALUES ('smartreport.g_cs_organ_groups')) v(q);
SELECT is(pg_temp.sb('SELECT 1 FROM ' || q, 'n') ~ '^n=[1-9]', true, 'C14 test 1 / AC-0B-3.5: tenant B reads the global set ' || q) FROM tg;

-- C14 test 2: centre probe on the four centre-scoped tables (AC-0B-3.4; §10 test 2): centre-A1 staff (a50a) sees no A2 row; hub staff (a500, all_centres) and the system actor see both
SELECT is(pg_temp.ua(pg_temp.m('a50a'), 'SELECT 1 FROM ' || q || ' WHERE centre_id = ' || pg_temp.q(pg_temp.id('00000000a202')), 'n'), 'n=0', 'C14 test 2 / AC-0B-3.4: centre-A1 staff sees 0 centre A2 rows of ' || q) FROM tc;
SELECT is(pg_temp.ua(pg_temp.m('a50a'), 'SELECT 1 FROM ' || q || ' WHERE centre_id = ' || pg_temp.q(pg_temp.id('00000000a201')), 'n') ~ '^n=[1-9]', true, 'C14 test 2 / AC-0B-3.4: centre-A1 staff sees its own centre rows of ' || q) FROM tc;
SELECT is(pg_temp.ua(pg_temp.m('a500'), 'SELECT 1 FROM ' || q || ' WHERE centre_id = ' || pg_temp.q(pg_temp.id('00000000a202')), 'n'), 'n=1', 'C14 test 2 / AC-0B-3.4: a hub user with all_centres sees the centre A2 row of ' || q) FROM tc;
SELECT is(pg_temp.sa('SELECT 1 FROM ' || q || ' WHERE centre_id = ' || pg_temp.q(pg_temp.id('00000000a202')), 'n'), 'n=1', 'C14 test 2: the system actor (has_all_centres) sees the centre A2 row of ' || q) FROM tc;
SELECT is(pg_temp.ua(pg_temp.m('a50a'), 'SELECT 1 FROM smartreport.summaries', 'n'), 'n=4', 'C14 test 2: centre-A1 staff sees only the 4 centre A1 summaries (3701, 3703, 3704, 3707)');
SELECT is(pg_temp.ua(pg_temp.m('a500'), 'SELECT 1 FROM smartreport.summaries', 'n'), 'n=5', 'C14 test 2: a hub user sees all 5 tenant A summaries');
SELECT is(pg_temp.ua(pg_temp.m('a50a'), 'SELECT 1 FROM smartreport.library_versions', 'n'), 'n=2', 'C14 test 2 / §6: library tables are tenant-only: restricted staff still reads both library versions');
SELECT is(pg_temp.ua(pg_temp.m('a50a'), 'SELECT 1 FROM smartreport.wording_deny_terms', 'n'), 'n=1', 'C14 test 2 / §6: deny terms are tenant-only');
SELECT is(pg_temp.ua(pg_temp.m('a50a'), 'UPDATE smartreport.summaries SET updated_by = updated_by WHERE centre_id = ' || pg_temp.q(pg_temp.id('00000000a202'))), 'n=0', 'C14 test 2 / AC-0B-3.4: centre-A1 staff updates 0 centre A2 summaries');

-- C14 test 3: no DELETE grant anywhere (AC-0B-4.2; §10 test 3)
SELECT is(has_table_privilege('lims_app', q, 'DELETE'), false, 'C14 test 3 / AC-0B-4.2: lims_app has no DELETE on ' || q) FROM (SELECT q FROM tt UNION ALL SELECT q FROM tg) x(q);
SELECT matches(pg_temp.sa('DELETE FROM ' || q), '^E42501\|', 'C14 test 3 / AC-0B-4.2: DELETE by the system actor is refused on ' || q) FROM (SELECT q FROM tt UNION ALL SELECT q FROM tg) x(q);
SELECT matches(pg_temp.sa('UPDATE ' || q || ' SET created_by = created_by'), '^E42501\|', 'C14 test 3 / AC-0B-4.1 / 4.3: no UPDATE grant on the class-A table ' || q)
  FROM (VALUES ('smartreport.library_reviews'),('smartreport.summary_report_bindings'),('smartreport.summary_reviews'),('smartreport.llm_runs')) v(q);
SELECT matches(pg_temp.sa('INSERT INTO ' || q || ' SELECT * FROM ' || q || ' LIMIT 0 ON CONFLICT DO NOTHING') , '^n=0$', 'C14 test 3: INSERT is granted on ' || q) FROM (VALUES ('smartreport.library_reviews')) v(q);
SELECT matches(pg_temp.sa('INSERT INTO ' || q || ' (code, display, sort_order) VALUES (''x_test'', ''X'', 1)'), '^E42501\|', 'C14 test 3: the global coded set ' || q || ' is not writable by lims_app')
  FROM (VALUES ('smartreport.g_cs_organ_groups'),('smartreport.g_cs_summary_reject_reasons')) v(q);
SELECT matches(pg_temp.sa('UPDATE smartreport.g_cs_organ_groups SET is_active = false'), '^E42501\|', 'C14 test 3: the global coded set is not updatable by lims_app');

-- C14 test 11 (reads): actor guard (AC-0B-3.6, 08 A19 D-109): device, patient, portal and partner claims of the same tenant read 0 rows of every smartreport tenant table; user and system see their rows
SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), k.t, pg_temp.m('a500')), 'SELECT 1 FROM ' || tt.q, 'n'), 'n=0', 'C14 test 11 / AC-0B-3.6: ' || k.t || ' actor sees 0 rows of ' || tt.q) FROM tt CROSS JOIN (VALUES ('device'),('patient'),('portal'),('partner')) k(t);
SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), k.t, pg_temp.m('a500')), 'SELECT 1 FROM ' || tt.q, 'n') ~ '^n=[1-9]', true, 'C14 test 11: ' || k.t || ' actor sees its rows of ' || tt.q) FROM tt CROSS JOIN (VALUES ('user'),('system')) k(t);
SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), k.t, pg_temp.m('a500')), 'UPDATE smartreport.library_versions SET updated_by = updated_by'), 'n=0', 'C14 test 11 / AC-0B-3.6: a ' || k.t || ' actor updates 0 library versions') FROM (VALUES ('device'),('patient'),('portal'),('partner')) k(t);
SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), 'device', NULL), 'SELECT 1 FROM ' || tt.q, 'n'), 'n=0', 'C14 test 11 / 08 A19.1: a bridge-agent (device) claim without membership sees 0 rows of ' || tt.q) FROM tt;
SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), 'device', pg_temp.m('a500')), 'SELECT 1 FROM ' || tg.q, 'n') ~ '^n=[1-9]', true, 'C14 test 11 / AC-0B-3.5: global coded sets stay readable for a device claim (no tenant data): ' || tg.q) FROM tg;
-- AC-0B-3.7: no claims / empty claims fail closed
SELECT is(pg_temp.x('lims_api', NULL, 'SELECT 1 FROM ' || q, 'n'), 'n=0', 'C14 test 11 / AC-0B-3.7: no claims -> lims_api sees 0 rows of ' || q) FROM tt;
SELECT is(pg_temp.x('lims_api', '{}'::jsonb, 'SELECT 1 FROM ' || q, 'n'), 'n=0', 'C14 test 11 / AC-0B-3.7: empty claims -> 0 rows of ' || q) FROM tt;

-- ===================================================================================================================================== failing statements (no state change)
-- C14 test 1 (writes): INSERT with tenant B's tenant_id fails the policy (children: the draft-only guard may answer first), UPDATE of B rows affects 0 rows
SELECT matches(pg_temp.sa(pg_temp.cps(q, aid, jsonb_build_object('id', pg_temp.uid(5000 + aid), 'tenant_id', pg_temp.tb()))), '^E(42501|P0001)\|', 'C14 test 1 / AC-0B-3.2: tenant A claims cannot INSERT a tenant B row into ' || q) FROM tt;
SELECT matches(pg_temp.sa(pg_temp.cps(q, aid, jsonb_build_object('id', pg_temp.uid(5000 + aid), 'tenant_id', pg_temp.tb()))), '^E42501\|', 'C14 test 1 / AC-0B-3.2: RLS WITH CHECK (42501) on ' || q) FROM tt WHERE q NOT IN (SELECT q FROM tk);
SELECT is(pg_temp.sa('UPDATE ' || q || ' SET updated_by = updated_by WHERE tenant_id = ' || pg_temp.q(pg_temp.tb())), 'n=0', 'C14 test 1 / AC-0B-3.3: tenant A updates 0 tenant B rows of ' || q) FROM ts;
SELECT matches(pg_temp.sa('DELETE FROM ' || q || ' WHERE tenant_id = ' || pg_temp.q(pg_temp.tb())), '^(E42501\||n=0$)', 'C14 test 1 / AC-0B-3.3: tenant A deletes 0 tenant B rows of ' || q) FROM tt;
-- C14 test 2 (writes): centre-A1 staff cannot create a row in centre A2
SELECT matches(pg_temp.ua(pg_temp.m('a50a'), pg_temp.cps(q, aid, jsonb_build_object('id', pg_temp.uid(5100 + aid), 'centre_id', pg_temp.id('00000000a202')))), '^E42501\|', 'C14 test 2 / AC-0B-3.4: centre-A1 staff cannot INSERT a centre A2 row into ' || q) FROM tc;
-- C14 test 11 (writes): every INSERT by a non-staff actor fails the policy (children: guard first)
SELECT matches(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), k.t, pg_temp.m('a500')), pg_temp.cps(tt.q, tt.aid, jsonb_build_object('id', pg_temp.uid(5200 + tt.aid))), 'w'), '^E(42501|P0001)\|', 'C14 test 11 / AC-0B-3.6: a ' || k.t || ' actor cannot INSERT into ' || tt.q)
  FROM tt CROSS JOIN (VALUES ('device'),('patient'),('portal'),('partner')) k(t);
SELECT matches(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), k.t, pg_temp.m('a500')), pg_temp.cps(tt.q, tt.aid, jsonb_build_object('id', pg_temp.uid(5300 + tt.aid))), 'w'), '^E42501\|', 'C14 test 11 / D-109: RLS WITH CHECK refuses a ' || k.t || ' actor on ' || tt.q)
  FROM tt CROSS JOIN (VALUES ('device'),('patient'),('portal'),('partner')) k(t) WHERE tt.q NOT IN (SELECT q FROM tk);
-- C14 test 7: partial uniques (§5)
SELECT matches(pg_temp.sa(pg_temp.cps('smartreport.summaries', 3701, jsonb_build_object('id', pg_temp.uid(5401), 'approved_set_hash', pg_temp.hx('9')))), '^E23505\|.*summaries__tenant_id_order_id__live__p_uq', 'C14 test 7: a second live summary for the same order fails');
SELECT matches(pg_temp.sa(pg_temp.cps('smartreport.summaries', 3701, jsonb_build_object('id', pg_temp.uid(5402), 'status', 'superseded', 'superseded_at', now(), 'superseded_reason', 'library_rebuild'))), '^E23505\|.*summaries__tenant_id_order_id_hash_library__uq', 'C14 test 7: the determinism key (order, approved_set_hash, library) is unique even for a superseded copy');
SELECT matches(pg_temp.sa(pg_temp.cps('smartreport.library_versions', 3001, jsonb_build_object('id', pg_temp.uid(5403), 'version_no', 9))), '^E23505\|.*library_versions__tenant_id__approved__p_uq', 'C14 test 7: a second approved library for the tenant fails');
SELECT matches(pg_temp.sa(pg_temp.cps('smartreport.library_versions', 3002, jsonb_build_object('id', pg_temp.uid(5404), 'version_no', 9))), '^E23505\|.*library_versions__tenant_id__open__p_uq', 'C14 test 7: a second open (draft / in_review) library for the tenant fails');
SELECT matches(pg_temp.sa(pg_temp.cps('smartreport.library_versions', 3001, jsonb_build_object('id', pg_temp.uid(5405), 'status', 'retired', 'retired_at', now()))), '^E23505\|.*library_versions__tenant_id_version_no__uq', 'C14 test 7: version_no is unique per tenant');
SELECT matches(pg_temp.sa(pg_temp.cps('smartreport.summary_report_bindings', 3802, jsonb_build_object('id', pg_temp.uid(5406)))), '^E23505\|.*summary_report_bindings__tenant_id_summary_id_version_no__uq', 'C14 test 7: one binding per (summary, report version)');
SELECT matches(pg_temp.sa(pg_temp.cps('smartreport.wording_deny_terms', 3501, jsonb_build_object('id', pg_temp.uid(5407)))), '^E23505\|.*wording_deny_terms__tenant_id_term_folded_language__p_uq', 'C14 test 7: an active deny term is unique per tenant, folded term and language');
SELECT matches(pg_temp.sa(pg_temp.cps('smartreport.template_blocks', 3101, jsonb_build_object('id', pg_temp.uid(5408)))), '^E23505\|.*template_blocks__tenant_id_lib_key__p_uq', 'C14 test 7: an active block key is unique per library version');
-- C14 test 8: composite FKs (AC-0B-3.5; §10 test 8)
SELECT matches(pg_temp.sa(pg_temp.cps('smartreport.rules', 3201, pg_temp.rbase() || jsonb_build_object('id', pg_temp.uid(5501), 'trigger_kind', 'analyte', 'analyte_id', pg_temp.uid(2103), 'min_severity', 'borderline'))), '^E23503\|.*rules__analyte__fk', 'C14 test 8 / AC-0B-3.5: a rule cannot reference tenant B''s analyte');
SELECT is(pg_temp.sa(pg_temp.cps('smartreport.rules', 3201, pg_temp.rbase() || jsonb_build_object('id', pg_temp.uid(5502), 'trigger_kind', 'analyte', 'analyte_id', pg_temp.uid(2101), 'min_severity', 'borderline'))), 'n=1', 'C14 test 8: control - the same rule with tenant A''s analyte inserts (draft parent)');
SELECT matches(pg_temp.sa(pg_temp.cps('smartreport.rules', 3202, jsonb_build_object('id', pg_temp.uid(5503), 'trigger_kind', 'any', 'min_severity', 'borderline', 'block_id', pg_temp.uid(3104)))), '^E23503\|.*rules__block__fk', 'C14 test 8: a rule cannot use a block of another library version (3104 belongs to 3001)');
SELECT matches(pg_temp.sa(pg_temp.cps('smartreport.rules', 3202, jsonb_build_object('id', pg_temp.uid(5504), 'trigger_kind', 'any', 'min_severity', 'borderline', 'block_id', pg_temp.uid(3102)))), '^E23503\|.*rules__block__fk', 'C14 test 8: a rule cannot use a block of a different kind (block_kind is part of the FK)');
SELECT matches(pg_temp.sa(pg_temp.cps('smartreport.rules', 3201, jsonb_build_object('id', pg_temp.uid(5505), 'suggested_test_id', pg_temp.uid(2002)))), '^E23503\|.*rules__test__fk', 'C14 test 8: a follow-up rule cannot suggest tenant B''s test');
SELECT matches(pg_temp.sa(pg_temp.cps('smartreport.rules', 3201, pg_temp.rbase() || jsonb_build_object('id', pg_temp.uid(5506), 'trigger_kind', 'group', 'group_code', 'nope', 'min_severity', 'borderline'))), '^E23503\|.*rules__group__fk', 'C14 test 8: an unknown organ group code is refused');
SELECT matches(pg_temp.sa(pg_temp.cps('smartreport.analyte_groups', 3301, jsonb_build_object('id', pg_temp.uid(5507), 'analyte_id', pg_temp.uid(2103)))), '^E23503\|.*analyte_groups__analyte__fk', 'C14 test 8: a mapping cannot reference tenant B''s analyte');
SELECT matches(pg_temp.sa(pg_temp.cps('smartreport.template_blocks', 3101, jsonb_build_object('id', pg_temp.uid(5508), 'block_key', 'x.other', 'library_version_id', pg_temp.uid(3003)))), '^E(23503|P0001)\|', 'C14 test 8: a block cannot point at tenant B''s library version');
SELECT matches(pg_temp.sa(pg_temp.cps('smartreport.summaries', 3704, jsonb_build_object('id', pg_temp.uid(5509), 'order_id', pg_temp.uid(2308), 'approved_set_hash', pg_temp.hx('8'), 'patient_id', pg_temp.uid(2202)))), '^E23503\|.*summaries__patient__fk', 'C14 test 8: a summary cannot reference tenant B''s patient');
SELECT matches(pg_temp.sa(pg_temp.cps('smartreport.summaries', 3704, jsonb_build_object('id', pg_temp.uid(5510), 'order_id', pg_temp.uid(2305), 'approved_set_hash', pg_temp.hx('7')))), '^E23503\|.*summaries__order__fk', 'C14 test 8: a summary cannot reference tenant B''s order');
SELECT matches(pg_temp.sa(pg_temp.cps('smartreport.summaries', 3704, jsonb_build_object('id', pg_temp.uid(5511), 'order_id', pg_temp.uid(2308), 'approved_set_hash', pg_temp.hx('7'), 'centre_id', pg_temp.id('00000000b201')))), '^E(23503|42501)\|', 'C14 test 8: a summary cannot name another tenant''s centre');
SELECT matches(pg_temp.sa(pg_temp.cps('smartreport.summary_report_bindings', 3802, jsonb_build_object('id', pg_temp.uid(5512), 'order_id', pg_temp.uid(2305), 'report_version_no', 2))), '^E23503\|.*summary_report_bindings__order__fk', 'C14 test 8: a binding cannot reference tenant B''s order');
SELECT matches(pg_temp.sa(pg_temp.cps('smartreport.summary_reviews', 3901, jsonb_build_object('id', pg_temp.uid(5513), 'summary_id', pg_temp.uid(3706)))), '^E23503\|.*summary_reviews__summary__fk', 'C14 test 8: a review cannot reference tenant B''s summary');
SELECT matches(pg_temp.sa(pg_temp.cps('smartreport.llm_runs', 4001, jsonb_build_object('id', pg_temp.uid(5514), 'summary_id', pg_temp.uid(3706)))), '^E23503\|.*llm_runs__summary__fk', 'C14 test 8: an LLM run cannot reference tenant B''s summary');
SELECT matches(pg_temp.sa(pg_temp.cps('smartreport.library_reviews', 3601, jsonb_build_object('id', pg_temp.uid(5515), 'actor_membership_id', pg_temp.m('b500')))), '^E23503\|.*library_reviews__actor__fk', 'C14 test 8: a review actor membership of another tenant is refused');
SELECT matches(pg_temp.sa(pg_temp.cps('smartreport.summaries', 3704, jsonb_build_object('id', pg_temp.uid(5516), 'order_id', pg_temp.uid(2308), 'approved_set_hash', pg_temp.hx('7'), 'library_version_id', pg_temp.uid(3003)))), '^E23503\|.*summaries__library__fk', 'C14 test 8: a summary cannot reference tenant B''s library version');
-- C14 test 9: rules__followup_fields__ck (§10 test 9) and the other CHECKs
SELECT matches(pg_temp.sa(pg_temp.cps('smartreport.rules', 3201, jsonb_build_object('id', pg_temp.uid(5601), 'interval_days', NULL::int))), '^E23514\|.*rules__followup_fields__ck', 'C14 test 9: a follow-up rule without interval_days fails (no default)');
SELECT matches(pg_temp.sa(pg_temp.cps('smartreport.rules', 3201, jsonb_build_object('id', pg_temp.uid(5602), 'interval_days', 731))), '^E23514\|.*rules__followup_fields__ck', 'C14 test 9: interval_days 731 fails (1-730)');
SELECT matches(pg_temp.sa(pg_temp.cps('smartreport.rules', 3201, jsonb_build_object('id', pg_temp.uid(5603), 'suggested_test_id', NULL::text))), '^E23514\|.*rules__followup_fields__ck', 'C14 test 9: a follow-up rule without suggested_test_id fails');
SELECT matches(pg_temp.sa(pg_temp.cps('smartreport.rules', 3202, jsonb_build_object('id', pg_temp.uid(5604), 'interval_days', 30))), '^E23514\|.*rules__followup_fields__ck', 'C14 test 9: an advice rule with interval_days fails');
SELECT matches(pg_temp.sa(pg_temp.cps('smartreport.rules', 3202, jsonb_build_object('id', pg_temp.uid(5605), 'suggested_test_id', pg_temp.uid(2001)))), '^E23514\|.*rules__followup_fields__ck', 'C14 test 9: an advice rule with suggested_test_id fails');
SELECT matches(pg_temp.sa(pg_temp.cps('smartreport.rules', 3202, pg_temp.rbase() || jsonb_build_object('id', pg_temp.uid(5606), 'trigger_kind', 'all_in_range', 'direction', 'any', 'min_severity', NULL::text))), '^E23514\|.*rules__trigger_fields__ck', 'C14 test 9: all_in_range is only valid for advice rules');
SELECT matches(pg_temp.sa(pg_temp.cps('smartreport.rules', 3201, jsonb_build_object('id', pg_temp.uid(5607), 'rule_kind', 'advice', 'suggested_test_id', NULL::text, 'interval_days', NULL::int))), '^E23514\|.*rules__kind__ck', 'C14 test 9: block_kind must equal rule_kind');
SELECT matches(pg_temp.sa(pg_temp.cps('smartreport.template_blocks', 3101, jsonb_build_object('id', pg_temp.uid(5608), 'block_key', 'x.empty', 'text_en', NULL::text, 'text_ne', NULL::text))), '^E23514\|.*template_blocks__text__ck', 'C14 CHECK: a block needs text_en or text_ne');
SELECT matches(pg_temp.sa(pg_temp.cps('smartreport.template_blocks', 3101, jsonb_build_object('id', pg_temp.uid(5609), 'block_key', 'Bad Key'))), '^E23514\|.*template_blocks__key__ck', 'C14 CHECK: block_key pattern');
SELECT matches(pg_temp.sa(pg_temp.cps('smartreport.library_versions', 3002, jsonb_build_object('id', pg_temp.uid(5610), 'version_no', 9, 'status', 'bogus', 'content_sha256', pg_temp.hx('a')))), '^E23514\|.*library_versions__status__ck', 'C14 CHECK: library status list');
SELECT matches(pg_temp.sa(pg_temp.cps('smartreport.library_versions', 3002, jsonb_build_object('id', pg_temp.uid(5611), 'version_no', 9, 'credit_borderline_bp', 10001))), '^E23514\|.*library_versions__credits__ck', 'C14 CHECK: credits are 0-10000 and ordered in >= borderline >= out >= critical');
SELECT matches(pg_temp.sa(pg_temp.cps('smartreport.library_versions', 3002, jsonb_build_object('id', pg_temp.uid(5612), 'version_no', 9, 'band_fair_min', 80))), '^E23514\|.*library_versions__bands__ck', 'C14 CHECK: band_fair_min < band_good_min');
SELECT matches(pg_temp.sa(pg_temp.cps('smartreport.library_versions', 3002, jsonb_build_object('id', pg_temp.uid(5613), 'version_no', 9, 'min_groups_scored', 0))), '^E23514\|.*library_versions__params__ck', 'C14 CHECK: min_groups_scored 1-20');
SELECT matches(pg_temp.sa(pg_temp.cps('smartreport.library_versions', 3002, jsonb_build_object('id', pg_temp.uid(5614), 'version_no', 9, 'status', 'in_review'))), '^E23514\|.*library_versions__hash__ck', 'C14 CHECK: content_sha256 is required once the library leaves draft');
SELECT matches(pg_temp.sa(pg_temp.cps('smartreport.library_versions', 3002, jsonb_build_object('id', pg_temp.uid(5615), 'version_no', 9, 'status', 'retired', 'content_sha256', pg_temp.hx('a')))), '^E23514\|.*library_versions__approved_fields__ck', 'C14 CHECK: approved / retired needs approved_at + approved_by');
SELECT matches(pg_temp.sa(pg_temp.cps('smartreport.summaries', 3704, jsonb_build_object('id', pg_temp.uid(5616), 'order_id', pg_temp.uid(2308), 'approved_set_hash', 'zz'))), '^E23514\|.*summaries__hashes__ck', 'C14 CHECK: approved_set_hash is 64 lowercase hex');
SELECT matches(pg_temp.sa(pg_temp.cps('smartreport.summaries', 3704, jsonb_build_object('id', pg_temp.uid(5617), 'order_id', pg_temp.uid(2308), 'approved_set_hash', pg_temp.hx('7'), 'health_score_value', 50))), '^E23514\|.*summaries__score__ck', 'C14 CHECK: a score value needs a band (NULL iff NULL)');
SELECT matches(pg_temp.sa(pg_temp.cps('smartreport.summaries', 3704, jsonb_build_object('id', pg_temp.uid(5618), 'order_id', pg_temp.uid(2308), 'approved_set_hash', pg_temp.hx('7'), 'status', 'approved'))), '^E23514\|.*summaries__approved_fields__ck', 'C14 CHECK: an approved summary needs approved_at + approved_by');
SELECT matches(pg_temp.sa(pg_temp.cps('smartreport.summaries', 3704, jsonb_build_object('id', pg_temp.uid(5619), 'order_id', pg_temp.uid(2308), 'approved_set_hash', pg_temp.hx('7'), 'status', 'rejected'))), '^E23514\|.*summaries__rejected_fields__ck', 'C14 CHECK: a rejected summary needs rejected_at + by + reason');
SELECT matches(pg_temp.sa(pg_temp.cps('smartreport.summaries', 3704, jsonb_build_object('id', pg_temp.uid(5620), 'order_id', pg_temp.uid(2308), 'approved_set_hash', pg_temp.hx('7'), 'use_llm_text', true))), '^E23514\|.*summaries__llm__ck', 'C14 CHECK: use_llm_text requires llm_overlay');
SELECT matches(pg_temp.sa(pg_temp.cps('smartreport.llm_runs', 4001, jsonb_build_object('id', pg_temp.uid(5621), 'status', 'bogus'))), '^E23514\|.*llm_runs__status__ck', 'C14 CHECK: llm_runs status list');
SELECT matches(pg_temp.sa(pg_temp.cps('smartreport.llm_runs', 4001, jsonb_build_object('id', pg_temp.uid(5622), 'prompt_template_version', 'x1'))), '^E23514\|.*llm_runs__prompt__ck', 'C14 CHECK: prompt_template_version ^p[0-9]{1,3}$');
SELECT matches(pg_temp.sa(pg_temp.cps('smartreport.llm_runs', 4001, jsonb_build_object('id', pg_temp.uid(5623), 'input_sha256', 'abc'))), '^E23514\|.*llm_runs__hash__ck', 'C14 CHECK: input_sha256 is 64 hex');
SELECT matches(pg_temp.sa(pg_temp.cps('smartreport.summary_reviews', 3901, jsonb_build_object('id', pg_temp.uid(5624), 'action', 'deleted'))), '^E23514\|.*summary_reviews__action__ck', 'C14 CHECK: summary_reviews action list');
SELECT matches(pg_temp.sa(pg_temp.cps('smartreport.group_settings', 3401, jsonb_build_object('id', pg_temp.uid(5625), 'group_code', 'liver', 'score_weight', 11))), '^E23514\|.*group_settings__weight__ck', 'C14 CHECK: score_weight 0-10');
SELECT matches(pg_temp.sa(pg_temp.cps('smartreport.wording_deny_terms', 3501, jsonb_build_object('id', pg_temp.uid(5626), 'term_folded', 'other', 'language', 'fr'))), '^E23514\|.*wording_deny_terms__language__ck', 'C14 CHECK: deny term language en / ne / any');
-- C14 test 13: summaries__inputs__ck (§10 test 13): 2,000 accepted, 2,001 rejected, 0 rejected (rows copied from the pristine draft 3701, fresh orders 2307 / 2308)
SELECT is(pg_temp.sa(pg_temp.cps('smartreport.summaries', 3701, jsonb_build_object('id', pg_temp.uid(5701), 'order_id', pg_temp.uid(2307), 'approved_set_hash', pg_temp.hx('e'), 'input_result_versions', (SELECT jsonb_agg(pg_temp.uid(9001)::text || ':' || g) FROM generate_series(1, 2000) g)))), 'n=1', 'C14 test 13: 2,000 input_result_versions elements are accepted');
SELECT matches(pg_temp.sa(pg_temp.cps('smartreport.summaries', 3701, jsonb_build_object('id', pg_temp.uid(5702), 'order_id', pg_temp.uid(2308), 'approved_set_hash', pg_temp.hx('f'), 'input_result_versions', (SELECT jsonb_agg(pg_temp.uid(9001)::text || ':' || g) FROM generate_series(1, 2001) g)))), '^E23514\|.*summaries__inputs__ck', 'C14 test 13: 2,001 elements are rejected');
SELECT matches(pg_temp.sa(pg_temp.cps('smartreport.summaries', 3701, jsonb_build_object('id', pg_temp.uid(5703), 'order_id', pg_temp.uid(2308), 'approved_set_hash', pg_temp.hx('f'), 'input_result_versions', '[]'::jsonb))), '^E23514\|.*summaries__inputs__ck', 'C14 test 13: an empty array is rejected (1-2,000)');

-- ===================================================================================================================================== state-changing checks
-- C14 test 9 (control) + the class-A insert: valid follow-up rule, an append-only row; library child inserts while draft
SELECT is(pg_temp.sa(pg_temp.cps('smartreport.rules', 3201, jsonb_build_object('id', pg_temp.uid(5801), 'interval_days', 730))), 'n=1', 'C14 test 9: a follow-up rule with interval_days 730 and a suggested test inserts');
SELECT is(pg_temp.sa(pg_temp.cps('smartreport.summary_reviews', 3901, jsonb_build_object('id', pg_temp.uid(5802), 'action', 'rejected'))), 'n=1', 'C14 test 3 / AC-0B-4.2: a class-A table accepts INSERT');
SELECT is(pg_temp.sa(pg_temp.cps('smartreport.template_blocks', 3101, jsonb_build_object('id', pg_temp.uid(5803), 'block_key', 'advice.extra'))), 'n=1', 'C14 test 4: control - a block inserts while the library is draft');

-- C14 test 12: deactivation instead of delete (08 A17 P-18(a); §10 test 12)
SELECT is(pg_temp.sa('UPDATE smartreport.template_blocks SET is_active = false WHERE id = ' || pg_temp.u(3101)), 'n=1', 'C14 test 12: a block is deactivated (is_active = false) while the parent is draft');
SELECT is(pg_temp.sa(pg_temp.cps('smartreport.template_blocks', 3101, jsonb_build_object('id', pg_temp.uid(5901), 'is_active', true))), 'n=1', 'C14 test 12: a new ACTIVE block with the same block_key in the same version now succeeds');
SELECT matches(pg_temp.sa(pg_temp.cps('smartreport.template_blocks', 3101, jsonb_build_object('id', pg_temp.uid(5902), 'is_active', true))), '^E23505\|.*template_blocks__tenant_id_lib_key__p_uq', 'C14 test 12: a second ACTIVE duplicate key fails');
SELECT is(pg_temp.sa('UPDATE smartreport.analyte_groups SET is_active = false WHERE id = ' || pg_temp.u(3301)), 'n=1', 'C14 test 12: a mapping is deactivated');
SELECT is(pg_temp.sa(pg_temp.cps('smartreport.analyte_groups', 3301, jsonb_build_object('id', pg_temp.uid(5903), 'is_active', true))), 'n=1', 'C14 test 12: a new ACTIVE mapping for the same analyte succeeds');
SELECT matches(pg_temp.sa(pg_temp.cps('smartreport.analyte_groups', 3301, jsonb_build_object('id', pg_temp.uid(5904), 'is_active', true))), '^E23505\|.*analyte_groups__tenant_id_lib_analyte__p_uq', 'C14 test 12: a second ACTIVE mapping for the analyte fails');
SELECT is(pg_temp.sa('UPDATE smartreport.rules SET is_active = false WHERE id = ' || pg_temp.u(5801)), 'n=1', 'C14 test 12: a rule is deactivated (class M, never deleted)');
SELECT is(pg_temp.sa('UPDATE smartreport.wording_deny_terms SET is_active = false WHERE id = ' || pg_temp.u(3501)), 'n=1', 'C14 test 12: a tenant deny term is deactivated');
SELECT is(pg_temp.sa(pg_temp.cps('smartreport.wording_deny_terms', 3501, jsonb_build_object('id', pg_temp.uid(5905), 'is_active', true))), 'n=1', 'C14 test 12: the term can be added again once the old row is inactive');
SELECT is(has_table_privilege('lims_app', q, 'DELETE'), false, 'C14 test 12 / AC-0B-4.2: lims_app has no DELETE on the child table ' || q) FROM tk;

-- C14 test 10: supersede chain (08 A19 D-107; §10 test 10) on summary 3704 (draft -> superseded, successor 5906, pointer set once)
SELECT is(pg_temp.sa('UPDATE smartreport.summaries SET status = ''superseded'', superseded_at = now(), superseded_reason = ''results_changed'' WHERE id = ' || pg_temp.u(3704)), 'n=1', 'C14 test 10: a live draft summary becomes superseded without a successor');
SELECT is(pg_temp.sa(pg_temp.cps('smartreport.summaries', 3704, jsonb_build_object('id', pg_temp.uid(5906), 'status', 'draft', 'approved_set_hash', pg_temp.hx('c'), 'superseded_at', NULL::text, 'superseded_reason', NULL::text, 'superseded_by_summary_id', NULL::text))), 'n=1', 'C14 test 10: the successor (draft, new hash) inserts');
SELECT matches(pg_temp.sa('UPDATE smartreport.summaries SET superseded_reason = ''library_rebuild'' WHERE id = ' || pg_temp.u(3704)), '^EP0001\|invalid_transition', 'C14 test 10: any other column change on a superseded row fails (superseded_reason)');
SELECT matches(pg_temp.sa('UPDATE smartreport.summaries SET reject_comment = ''x'' WHERE id = ' || pg_temp.u(3704)), '^EP0001\|(invalid_transition|immutable_row)', 'C14 test 10: a content-adjacent column change on a superseded row fails');
SELECT is(pg_temp.sa('UPDATE smartreport.summaries SET superseded_by_summary_id = ' || pg_temp.u(5906) || ' WHERE id = ' || pg_temp.u(3704)), 'n=1', 'C14 test 10 / D-107: superseded -> superseded sets superseded_by_summary_id NULL -> successor id once');
SELECT matches(pg_temp.sa('UPDATE smartreport.summaries SET superseded_by_summary_id = ' || pg_temp.u(5906) || ' WHERE id = ' || pg_temp.u(3704)), '^EP0001\|invalid_transition', 'C14 test 10 / D-107: a second update of superseded_by_summary_id fails');
SELECT matches(pg_temp.sa('UPDATE smartreport.summaries SET superseded_reason = ''library_rebuild'' WHERE id = ' || pg_temp.u(3704)), '^EP0001\|invalid_transition', 'C14 test 10 / D-107: superseded_reason cannot change after the pointer is set');
SELECT is(pg_temp.sa('UPDATE smartreport.summaries SET superseded_by_summary_id = ' || pg_temp.u(5906) || ' WHERE id = ' || pg_temp.u(3703)), 'n=1', 'C14 test 10 / D-107: the guarded pointer update also works on a row that was inserted already superseded (NULL -> id once)');

-- C14 test 5: summary content immutable (§10 test 5; AC-0B-4.1)
SELECT matches(pg_temp.sa('UPDATE smartreport.summaries SET content = ''{"y":2}''::jsonb WHERE id = ' || pg_temp.u(3702)), '^EP0001\|immutable_row', 'C14 test 5 / AC-0B-4.1: summaries.content is immutable on an approved row');
SELECT matches(pg_temp.sa('UPDATE smartreport.summaries SET content = ''{"y":2}''::jsonb WHERE id = ' || pg_temp.u(3701)), '^EP0001\|immutable_row', 'C14 test 5: summaries.content is immutable from insert, even on a draft');
SELECT matches(pg_temp.sa('UPDATE smartreport.summaries SET approved_set_hash = ' || quote_literal(pg_temp.hx('0')) || ' WHERE id = ' || pg_temp.u(3702)), '^EP0001\|immutable_row', 'C14 test 5: approved_set_hash is immutable');
SELECT matches(pg_temp.sa('UPDATE smartreport.summaries SET input_result_versions = ARRAY[''x:1''] WHERE id = ' || pg_temp.u(3701)), '^EP0001\|immutable_row', 'C14 test 5: input_result_versions is immutable');
SELECT matches(pg_temp.sa('UPDATE smartreport.summaries SET library_version_id = ' || pg_temp.u(3002) || ' WHERE id = ' || pg_temp.u(3701)), '^EP0001\|immutable_row', 'C14 test 5: library_version_id is immutable');
SELECT matches(pg_temp.sa('UPDATE smartreport.summaries SET llm_overlay = ''{"run_id":"x","items":{}}''::jsonb WHERE id = ' || pg_temp.u(3702)), '^EP0001\|immutable_row', 'C14 test 5: llm_overlay on an approved row is immutable');
SELECT matches(pg_temp.sa('UPDATE smartreport.summaries SET use_llm_text = true WHERE id = ' || pg_temp.u(3702)), '^EP0001\|immutable_row', 'C14 test 5: use_llm_text on an approved row is immutable');
SELECT is(pg_temp.sa('UPDATE smartreport.summaries SET llm_overlay = ''{"run_id":"x","items":{}}''::jsonb, use_llm_text = true WHERE id = ' || pg_temp.u(5906)), 'n=1', 'C14 test 5: llm_overlay / use_llm_text change while the summary is draft');
SELECT matches(pg_temp.sa('UPDATE smartreport.summaries SET updated_by = updated_by, version = version + 1 WHERE id = ' || pg_temp.u(3702)), '^EP0001\|invalid_transition', 'C14 test 5 / §4: approved -> approved is not in the transition list, so an approved row only changes by superseding (lifecycle columns alone are refused)');

-- C14 test 6: invalid transitions -> invalid_transition (§10 test 6; AC-0B-4.1); valid ones succeed
SELECT matches(pg_temp.sa('UPDATE smartreport.summaries SET status = ''draft'' WHERE id = ' || pg_temp.u(3703)), '^EP0001\|invalid_transition', 'C14 test 6: superseded -> draft is invalid');
SELECT matches(pg_temp.sa('UPDATE smartreport.summaries SET status = ''approved'', approved_at = now(), approved_by_membership_id = ' || pg_temp.q(pg_temp.m('a500')) || ' WHERE id = ' || pg_temp.u(3707)), '^EP0001\|invalid_transition', 'C14 test 6: rejected -> approved is invalid');
SELECT matches(pg_temp.sa('UPDATE smartreport.summaries SET status = ''draft'' WHERE id = ' || pg_temp.u(3702)), '^EP0001\|invalid_transition', 'C14 test 6: approved -> draft is invalid');
SELECT matches(pg_temp.sa('UPDATE smartreport.summaries SET status = ''rejected'', rejected_at = now(), rejected_by_membership_id = ' || pg_temp.q(pg_temp.m('a500')) || ', reject_reason_code = ''other'' WHERE id = ' || pg_temp.u(3702)), '^EP0001\|invalid_transition', 'C14 test 6: approved -> rejected is invalid');
SELECT matches(pg_temp.sa('UPDATE smartreport.library_versions SET status = ''approved'', approved_at = now(), approved_by_membership_id = ' || pg_temp.q(pg_temp.m('a500')) || ', content_sha256 = ' || quote_literal(pg_temp.hx('a')) || ' WHERE id = ' || pg_temp.u(3002)), '^EP0001\|invalid_transition', 'C14 test 6: draft -> approved on a library is invalid (must pass in_review)');
SELECT matches(pg_temp.sa('UPDATE smartreport.library_versions SET status = ''draft'' WHERE id = ' || pg_temp.u(3001)), '^EP0001\|invalid_transition', 'C14 test 6: approved -> draft on a library is invalid');
SELECT matches(pg_temp.sa('UPDATE smartreport.library_versions SET status = ''in_review'' WHERE id = ' || pg_temp.u(3001)), '^EP0001\|invalid_transition', 'C14 test 6: approved -> in_review on a library is invalid');
SELECT is(pg_temp.sa('UPDATE smartreport.summaries SET status = ''approved'', approved_at = now(), approved_by_membership_id = ' || pg_temp.q(pg_temp.m('a500')) || ' WHERE id = ' || pg_temp.u(3701)), 'n=1', 'C14 test 6: draft -> approved (with approved_at / by) is valid');
SELECT is(pg_temp.sa('UPDATE smartreport.summaries SET status = ''superseded'', superseded_at = now(), superseded_reason = ''library_rebuild'' WHERE id = ' || pg_temp.u(3701)), 'n=1', 'C14 test 6: approved -> superseded is valid');
SELECT is(pg_temp.sa('UPDATE smartreport.summaries SET status = ''superseded'', superseded_at = now(), superseded_reason = ''results_changed'' WHERE id = ' || pg_temp.u(3707)), 'n=1', 'C14 test 6: rejected -> superseded is valid');
SELECT matches(pg_temp.sa('UPDATE smartreport.summaries SET status = ''bogus'' WHERE id = ' || pg_temp.u(3702)), '^EP0001\|invalid_transition', 'C14 test 6: an unknown target status is an invalid transition');

-- C14 test 4: child edit while the parent is in_review -> immutable_row (§10 test 4); the parent is submitted, checked, returned to draft
SELECT is(pg_temp.sa('UPDATE smartreport.library_versions SET status = ''in_review'', submitted_at = now(), submitted_by_membership_id = ' || pg_temp.q(pg_temp.m('a500')) || ', content_sha256 = ' || quote_literal(pg_temp.hx('c')) || ' WHERE id = ' || pg_temp.u(3002)), 'n=1', 'C14 test 4: draft -> in_review (submit) is valid');
SELECT matches(pg_temp.sa('UPDATE smartreport.template_blocks SET note = ''x'' WHERE id = ' || pg_temp.u(5901)), '^EP0001\|immutable_row', 'C14 test 4 / AC-0B-4.1: a block edit while the parent is in_review fails');
SELECT matches(pg_temp.sa('UPDATE smartreport.template_blocks SET is_active = false WHERE id = ' || pg_temp.u(5901)), '^EP0001\|immutable_row', 'C14 test 4: even deactivation of a block is blocked while in_review');
SELECT matches(pg_temp.sa(pg_temp.cps('smartreport.template_blocks', 3103, jsonb_build_object('id', pg_temp.uid(6001), 'block_key', 'deranged.new'))), '^EP0001\|immutable_row', 'C14 test 4: a block INSERT while in_review fails');
SELECT matches(pg_temp.sa('UPDATE smartreport.rules SET priority = 5 WHERE id = ' || pg_temp.u(3202)), '^EP0001\|immutable_row', 'C14 test 4: a rule edit while in_review fails');
SELECT matches(pg_temp.sa(pg_temp.cps('smartreport.rules', 3202, jsonb_build_object('id', pg_temp.uid(6002)))), '^EP0001\|immutable_row', 'C14 test 4: a rule INSERT while in_review fails');
SELECT matches(pg_temp.sa('UPDATE smartreport.analyte_groups SET sort_order = 5 WHERE id = ' || pg_temp.u(5903)), '^EP0001\|immutable_row', 'C14 test 4: a mapping edit while in_review fails');
SELECT matches(pg_temp.sa('UPDATE smartreport.group_settings SET display_en = ''X'' WHERE id = ' || pg_temp.u(3401)), '^EP0001\|immutable_row', 'C14 test 4: a group setting edit while in_review fails');
SELECT matches(pg_temp.sa('UPDATE smartreport.library_versions SET language = ''ne'' WHERE id = ' || pg_temp.u(3002)), '^EP0001\|immutable_row', 'C14 test 4: library content (language) is frozen outside draft');
SELECT matches(pg_temp.sa('UPDATE smartreport.library_versions SET min_groups_scored = 3 WHERE id = ' || pg_temp.u(3001)), '^EP0001\|immutable_row', 'C14 test 4: an approved library''s parameters are frozen');
SELECT is(pg_temp.sa('UPDATE smartreport.library_versions SET approval_note = ''Synthetic note'' WHERE id = ' || pg_temp.u(3002)), 'n=1', 'C14 test 4: a lifecycle column (approval_note) of an in_review library may change (in_review -> in_review)');
SELECT is(pg_temp.sa('UPDATE smartreport.library_versions SET status = ''draft'', returned_at = now(), returned_by_membership_id = ' || pg_temp.q(pg_temp.m('a500')) || ', return_comment = ''Synthetic'' WHERE id = ' || pg_temp.u(3002)), 'n=1', 'C14 test 4: in_review -> draft (return) is valid');
SELECT is(pg_temp.sa('UPDATE smartreport.template_blocks SET note = ''x'' WHERE id = ' || pg_temp.u(5901)), 'n=1', 'C14 test 4: control - the block edit works again once the library is back in draft');
SELECT matches(pg_temp.sa('UPDATE smartreport.template_blocks SET library_version_id = ' || pg_temp.u(3001) || ' WHERE id = ' || pg_temp.u(5901)), '^EP0001\|immutable_row', 'C14 test 4: a child cannot be moved to another library version');
SELECT matches(pg_temp.sa('UPDATE smartreport.template_blocks SET note = ''x'' WHERE id = ' || pg_temp.u(3104)), '^EP0001\|immutable_row', 'C14 test 4: a child of the APPROVED library 3001 is frozen too');
-- library retirement last (frees the approved slot; the retired row is frozen)
SELECT is(pg_temp.sa('UPDATE smartreport.library_versions SET status = ''retired'', retired_at = now() WHERE id = ' || pg_temp.u(3001)), 'n=1', 'C14 test 6: approved -> retired is valid');
SELECT matches(pg_temp.sa('UPDATE smartreport.library_versions SET status = ''approved'' WHERE id = ' || pg_temp.u(3001)), '^EP0001\|invalid_transition', 'C14 test 6: retired -> approved is invalid');
SELECT matches(pg_temp.sa('UPDATE smartreport.library_versions SET status = ''draft'' WHERE id = ' || pg_temp.u(3001)), '^EP0001\|invalid_transition', 'C14 test 6: retired -> draft is invalid');
SELECT matches(pg_temp.sa('UPDATE smartreport.library_versions SET change_summary = ''x'' WHERE id = ' || pg_temp.u(3001)), '^EP0001\|immutable_row', 'C14 test 4: a retired library is frozen');

-- C14 check 9: audit (AC-0B-5.1 / 5.2 / 5.3) and no view (AC-0B-6.1 / 6.2 / 6.3)
SELECT is(pg_temp.sa('UPDATE smartreport.library_versions SET change_summary = ''Synthetic change'' WHERE id = ' || pg_temp.u(3002)), 'n=1', 'C14 check 9 / AC-0B-5.1: an audited class M update succeeds');
SELECT is((SELECT count(*)::int FROM audit.audit_log WHERE schema_name = 'smartreport' AND table_name = 'library_versions' AND row_id = pg_temp.uid(3002) AND tenant_id = pg_temp.ta()) >= 1, true, 'C14 check 9 / AC-0B-5.1: the update wrote an audit_log row');
SELECT is((SELECT bool_or(changed_columns @> ARRAY['change_summary']) FROM audit.audit_log WHERE schema_name = 'smartreport' AND table_name = 'library_versions' AND row_id = pg_temp.uid(3002)), true, 'C14 check 9 / AC-0B-5.2: the changed column is recorded');
SELECT is((SELECT count(*)::int FROM audit.audit_log WHERE schema_name = 'smartreport' AND table_name = 'summaries' AND tenant_id = pg_temp.ta()) >= 1, true, 'C14 check 9 / AC-0B-5.1: summaries (class C) updates are audited');
SELECT is((SELECT count(*)::int FROM audit.audit_log WHERE schema_name = 'smartreport' AND table_name IN ('library_reviews', 'summary_report_bindings', 'summary_reviews', 'llm_runs', 'g_cs_organ_groups', 'g_cs_summary_reject_reasons', 'g_cs_wording_deny_terms')), 0,
  'C14 check 9 / AC-0B-5.3: class A and G tables are not audited (the summary_reviews INSERT above left no audit row)');
SELECT is((SELECT count(*)::int FROM pg_class WHERE relnamespace = 'smartreport'::regnamespace AND relkind IN ('v', 'm')), 0, 'C14 check 9 / AC-0B-6.1 / 6.2 / 6.3: smartreport has no view (§8; the invoker-view contract tests are vacuous)');
SELECT is((SELECT count(*)::int FROM pg_constraint c JOIN pg_class r ON r.oid = c.confrelid WHERE c.contype = 'f' AND r.relnamespace = 'smartreport'::regnamespace AND c.conrelid NOT IN (SELECT oid FROM pg_class WHERE relnamespace = 'smartreport'::regnamespace)), 0, 'C14 check 9 / AC-0B-6.2: nothing outside smartreport references it');

SELECT * FROM finish();
ROLLBACK;
