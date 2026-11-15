-- T0B-13.C10 behaviour suite: tenant / centre isolation, non-staff + device actors and fail-closed no-claims, append-only + immutable tables, instrument_records purge rule (D-65), guard triggers (cultures, breakpoint_sets,
-- final lock), CHECK constraints, AST category FK, cross-tenant composite FK, audit, published view micro.v_pub_report_content and the internal coded-set view (C10 05-SCHEMA §1, §2, §4, §5, §6, §8, §10;
-- AC-0B-2.4, 3.1-3.7, 4.1, 4.2, 4.3, 5.1, 5.2, 5.3, 6.1-6.3).
-- The generated per-table probes (db/tests/isolation/micro.<t>.test.sql) are the AC-0B-3.x proof for every table; this file proves what the generator cannot know (§10 items 1-11).
-- Synthetic data only (seeds 010: tenant A 01a1a98a-...-a001, tenant B ...-b001; centres a201, a202, b201; memberships a500 all-centres staff, a50a staff restricted to centre a201, b500).
-- One rolled-back transaction. RLS is never disabled. FK PARENT rows of other chunks (catalog, instruments, frontdesk, lab) are not built here: the fixtures are inserted by the superuser test session inside ONE block with
-- the replica session replication role (FK + user triggers off; RLS, CHECK and NOT NULL stay on; C9-T20 precedent) that is reset to origin before the first assertion. Every assertion runs as SET LOCAL ROLE lims_app / lims_api (pg_temp.x).
-- Run from the repo root: pg_prove -d <db> db/tests/micro/T0B-13.C10_behaviour.test.sql   (pgTAP in schema `extensions`; migrations + seeds loaded; superuser)
-- Markers: C10 check 8 fixtures + seeds, 9 tenant isolation (AC-0B-3.1/3.2/3.3/3.5), 10 centre isolation (AC-0B-3.4), 11 non-staff / device actors + no claims (AC-0B-3.6/3.7), 12 append-only + no DELETE (AC-0B-4.1/4.2/4.3),
-- 13 instrument_records purge rule (D-65, AC-0B-4.2), 14 guard triggers: cultures, breakpoint_sets, final lock, 15 CHECK constraints + AST category FK + cross-tenant FK + audit (AC-0B-5.1/5.2/5.3), 16 views (AC-0B-6.1/6.2/6.3).
-- Order matters inside the transaction: read-only checks first, state-changing statements last.
BEGIN;
SET search_path = extensions, public, pg_catalog;
SELECT * FROM no_plan();

CREATE FUNCTION pg_temp.ta() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1a98a-ac40-7000-8000-00000000a001'::uuid $$;
CREATE FUNCTION pg_temp.tb() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1a98a-ac40-7000-8000-00000000b001'::uuid $$;
CREATE FUNCTION pg_temp.sys() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1b34e-1000-7eee-9d29-d7ca59a102b5'::uuid $$;
CREATE FUNCTION pg_temp.uid(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('0190c900-0000-7000-8000-' || lpad(n::text, 12, '0'))::uuid $$;
CREATE FUNCTION pg_temp.id(s text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('01a1a98a-ac40-7000-8000-' || s)::uuid $$;
CREATE FUNCTION pg_temp.m(s text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('01a1a98a-ac40-7000-8000-00000000' || s)::uuid $$;     -- membership ids: a500, a50a, b500
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
CREATE FUNCTION pg_temp.sb(p_sql text, p_mode text DEFAULT 'w') RETURNS text LANGUAGE sql AS $$ SELECT pg_temp.x('lims_app', pg_temp.cl(pg_temp.tb()), p_sql, p_mode) $$;
CREATE FUNCTION pg_temp.ua(p_mem uuid, p_sql text, p_mode text DEFAULT 'w') RETURNS text LANGUAGE sql AS $$ SELECT pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), 'user', p_mem), p_sql, p_mode) $$;   -- tenant A staff user
CREATE TEMP TABLE tt(q) AS VALUES
  ('micro.cs_organisms'),('micro.cs_organism_groups'),('micro.cs_antibiotics'),('micro.cs_media'),('micro.cs_specimen_sites'),('micro.cs_growth_codes'),('micro.cs_culture_outcomes'),('micro.cs_isolate_withdraw_reasons'),
  ('micro.cs_culture_cancel_reasons'),('micro.cs_record_ignore_reasons'),('micro.settings'),('micro.plating_protocols'),('micro.plating_protocol_media'),('micro.plating_protocol_keys'),('micro.ast_panels'),
  ('micro.ast_panel_antibiotics'),('micro.instrument_vocab_maps'),('micro.instrument_ast_defaults'),('micro.breakpoint_sets'),('micro.breakpoint_rows'),('micro.breakpoint_bands'),('micro.breakpoint_import_issues'),
  ('micro.cultures'),('micro.culture_transitions'),('micro.culture_plates'),('micro.culture_observations'),('micro.isolates'),('micro.ast_results'),('micro.report_versions'),('micro.instrument_records'),
  ('micro.specimen_isolate_counters');
CREATE TEMP TABLE tc(q) AS VALUES ('micro.cultures'),('micro.culture_transitions'),('micro.culture_plates'),('micro.culture_observations'),('micro.isolates'),('micro.ast_results'),('micro.report_versions'),('micro.instrument_records');

-- ===================================================================================================================================== fixtures (superuser, replica block)
-- C10 check 8: configuration, breakpoint sets, cultures + children, instrument records of tenant A (centres a201 / a202) and tenant B (b201)
SET LOCAL session_replication_role = replica;      -- FIXTURE-ONLY: FK parents of other chunks are not built; RLS, CHECK, NOT NULL stay on; reset to origin below
SELECT pg_temp.ins('micro.settings', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', r.t)) FROM (VALUES (511, pg_temp.ta()), (512, pg_temp.tb())) r(n, t);
SELECT pg_temp.ins('micro.cs_organisms', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', r.t, 'code', r.c, 'display', r.d, 'is_alert', r.al))
  FROM (VALUES (521, pg_temp.ta(), 'escherichia_coli', 'Tenant E. coli', true), (522, pg_temp.tb(), 'b_only_organism', 'B only', false)) r(n, t, c, d, al);
SELECT pg_temp.ins('micro.plating_protocols', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', r.t, 'code', 'urine_std', 'version_no', 1, 'display', 'Synthetic urine', 'read_schedule_hours', to_jsonb(ARRAY[24, 48]), 'final_no_growth_hours', 48))
  FROM (VALUES (441, pg_temp.ta()), (442, pg_temp.tb())) r(n, t);
SELECT pg_temp.ins('micro.plating_protocol_media', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', r.t, 'protocol_id', pg_temp.uid(r.p), 'media_code', 'blood_agar', 'sort_order', 1)) FROM (VALUES (451, pg_temp.ta(), 441), (452, pg_temp.tb(), 442)) r(n, t, p);
SELECT pg_temp.ins('micro.plating_protocol_keys', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', r.t, 'protocol_code', 'urine_std')) FROM (VALUES (461, pg_temp.ta()), (462, pg_temp.tb())) r(n, t);
SELECT pg_temp.ins('micro.ast_panels', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', r.t, 'code', 'synthetic_panel_gn', 'version_no', 1, 'display', 'Synthetic panel', 'default_method', 'mic')) FROM (VALUES (471, pg_temp.ta()), (472, pg_temp.tb())) r(n, t);
SELECT pg_temp.ins('micro.ast_panel_antibiotics', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', r.t, 'panel_id', pg_temp.uid(r.p), 'antibiotic_code', 'ampicillin', 'sort_order', 1)) FROM (VALUES (481, pg_temp.ta(), 471), (482, pg_temp.tb(), 472)) r(n, t, p);
SELECT pg_temp.ins('micro.instrument_vocab_maps', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', r.t, 'instrument_id', pg_temp.uid(1001), 'kind', 'organism', 'code_raw', 'ECO', 'local_code', 'escherichia_coli')) FROM (VALUES (491, pg_temp.ta()), (492, pg_temp.tb())) r(n, t);
SELECT pg_temp.ins('micro.instrument_ast_defaults', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', r.t, 'instrument_id', pg_temp.uid(1001), 'standard', 'CLSI', 'standard_version', '2026')) FROM (VALUES (501, pg_temp.ta()), (502, pg_temp.tb())) r(n, t);
SELECT pg_temp.ins('micro.breakpoint_sets', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', r.t, 'standard', 'CLSI', 'standard_version', '2026', 'title', 'Synthetic set NOT CLINICAL', 'licence_attestation_text', 'Synthetic licence attestation text for tests only',
    'file_bucket', 'imports', 'file_object_path', 'x/' || r.n, 'file_sha256', md5(r.n::text) || md5((r.n + 1)::text), 'file_bytes', 10, 'status', r.st) || r.x)
  FROM (VALUES (401, pg_temp.ta(), 'active', jsonb_build_object('effective_from', now() - interval '30 days', 'activated_by', pg_temp.uid(9001), 'activated_at', now() - interval '30 days')),
               (402, pg_temp.ta(), 'validated', '{}'::jsonb), (403, pg_temp.tb(), 'uploaded', '{}'::jsonb)) r(n, t, st, x);
SELECT pg_temp.ins('micro.breakpoint_rows', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', r.t, 'set_id', pg_temp.uid(r.s), 'line_no', 1, 'organism_scope', 'any', 'antibiotic_code', 'ampicillin', 'method', 'mic')) FROM (VALUES (411, pg_temp.ta(), 401), (412, pg_temp.tb(), 403)) r(n, t, s);
SELECT pg_temp.ins('micro.breakpoint_bands', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', r.t, 'set_id', pg_temp.uid(r.s), 'row_id', pg_temp.uid(r.w), 'band_no', 1, 'category_code', 'S', 'upper_value', 8, 'note', 'NOT CLINICAL')) FROM (VALUES (421, pg_temp.ta(), 401, 411), (422, pg_temp.tb(), 403, 412)) r(n, t, s, w);
SELECT pg_temp.ins('micro.breakpoint_import_issues', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', r.t, 'set_id', pg_temp.uid(r.s), 'severity', 'warning', 'code', 'row.bad_value', 'message', 'Synthetic issue')) FROM (VALUES (431, pg_temp.ta(), 402), (432, pg_temp.tb(), 403)) r(n, t, s);
SELECT pg_temp.ins('micro.cultures', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', r.t, 'centre_id', r.c, 'order_id', pg_temp.uid(8000 + r.n), 'order_item_id', pg_temp.uid(8100 + r.n), 'specimen_id', pg_temp.uid(8200 + r.n), 'patient_id', pg_temp.uid(8300),
    'test_id', pg_temp.uid(2000), 'specimen_type_code', 'urine', 'status', r.st, 'received_at', now(), 'last_specimen_seq', 0) || r.x)
  FROM (VALUES (301, pg_temp.ta(), pg_temp.id('00000000a201'), 'incubating', '{}'::jsonb), (302, pg_temp.ta(), pg_temp.id('00000000a202'), 'incubating', '{}'::jsonb), (303, pg_temp.tb(), pg_temp.id('00000000b201'), 'incubating', '{}'::jsonb),
               (304, pg_temp.ta(), pg_temp.id('00000000a201'), 'final_submitted', jsonb_build_object('outcome_code', 'no_growth')),
               (305, pg_temp.ta(), pg_temp.id('00000000a201'), 'amending', jsonb_build_object('outcome_code', 'no_growth', 'amendment_reason_code', 'correction', 'current_report_version_no', 1)),
               (306, pg_temp.ta(), pg_temp.id('00000000a201'), 'awaiting_setup', '{}'::jsonb)) r(n, t, c, st, x);
SELECT pg_temp.ins('micro.culture_transitions', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', r.t, 'centre_id', r.c, 'culture_id', pg_temp.uid(r.cu), 'to_status', 'incubating', 'occurred_at', now()))
  FROM (VALUES (331, pg_temp.ta(), pg_temp.id('00000000a201'), 301), (332, pg_temp.ta(), pg_temp.id('00000000a202'), 302), (333, pg_temp.tb(), pg_temp.id('00000000b201'), 303)) r(n, t, c, cu);
SELECT pg_temp.ins('micro.culture_plates', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', r.t, 'centre_id', r.c, 'culture_id', pg_temp.uid(r.cu), 'plate_no', 1, 'media_code', 'blood_agar', 'planted_at', now()))
  FROM (VALUES (311, pg_temp.ta(), pg_temp.id('00000000a201'), 301), (312, pg_temp.ta(), pg_temp.id('00000000a202'), 302), (313, pg_temp.tb(), pg_temp.id('00000000b201'), 303), (314, pg_temp.ta(), pg_temp.id('00000000a201'), 304),
               (315, pg_temp.ta(), pg_temp.id('00000000a201'), 305)) r(n, t, c, cu);
SELECT pg_temp.ins('micro.culture_observations', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', r.t, 'centre_id', r.c, 'culture_id', pg_temp.uid(r.cu), 'kind', 'other', 'finding_text', 'Synthetic finding', 'observed_at', now()))
  FROM (VALUES (321, pg_temp.ta(), pg_temp.id('00000000a201'), 301), (322, pg_temp.ta(), pg_temp.id('00000000a202'), 302), (323, pg_temp.tb(), pg_temp.id('00000000b201'), 303)) r(n, t, c, cu);
SELECT pg_temp.ins('micro.isolates', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', r.t, 'centre_id', r.c, 'culture_id', pg_temp.uid(r.cu), 'specimen_id', pg_temp.uid(8200 + r.cu), 'isolate_seq', 1, 'status', 'pending_id'))
  FROM (VALUES (341, pg_temp.ta(), pg_temp.id('00000000a201'), 301), (342, pg_temp.ta(), pg_temp.id('00000000a202'), 302), (343, pg_temp.tb(), pg_temp.id('00000000b201'), 303), (344, pg_temp.ta(), pg_temp.id('00000000a201'), 304),
               (345, pg_temp.ta(), pg_temp.id('00000000a201'), 305)) r(n, t, c, cu);
SELECT pg_temp.ins('micro.ast_results', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', r.t, 'centre_id', r.c, 'culture_id', pg_temp.uid(r.cu), 'isolate_id', pg_temp.uid(r.i), 'antibiotic_code', 'ampicillin', 'method', 'mic', 'source', 'manual') || r.x)
  FROM (VALUES (351, pg_temp.ta(), pg_temp.id('00000000a201'), 301, 341, jsonb_build_object('instrument_record_id', pg_temp.uid(372))), (352, pg_temp.ta(), pg_temp.id('00000000a202'), 302, 342, '{}'::jsonb), (353, pg_temp.tb(), pg_temp.id('00000000b201'), 303, 343, '{}'::jsonb),
               (354, pg_temp.ta(), pg_temp.id('00000000a201'), 304, 344, '{}'::jsonb), (355, pg_temp.ta(), pg_temp.id('00000000a201'), 305, 345, '{}'::jsonb)) r(n, t, c, cu, i, x);
SELECT pg_temp.ins('micro.report_versions', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', r.t, 'centre_id', r.c, 'culture_id', pg_temp.uid(r.cu), 'order_item_id', pg_temp.uid(8100 + r.cu), 'version_no', 1, 'report_phase', 'preliminary', 'version_kind', 'initial',
    'submission_kind', 'structured', 'culture_summary_text', 'Synthetic summary', 'isolates', '[]'::jsonb, 'ast', '[]'::jsonb, 'is_critical', false, 'flag', 'N', 'signed_by_membership_id', r.m, 'signed_at', now(), 'lab_result_id', pg_temp.uid(7000 + r.n),
    'lab_result_version_no', 1, 'lab_status_at_submit', 'resulted', 'lab_replayed', false))
  FROM (VALUES (361, pg_temp.ta(), pg_temp.id('00000000a201'), 301, pg_temp.m('a500')), (362, pg_temp.ta(), pg_temp.id('00000000a202'), 302, pg_temp.m('a500')), (363, pg_temp.tb(), pg_temp.id('00000000b201'), 303, pg_temp.m('b500'))) r(n, t, c, cu, m);
SELECT pg_temp.ins('micro.instrument_records', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', r.t, 'centre_id', r.c, 'event_id', pg_temp.uid(9000 + r.n), 'idempotency_key', 'k' || r.n, 'instrument_message_id', pg_temp.uid(9100 + r.n), 'instrument_id', pg_temp.uid(1001),
    'sample_barcode', 'BC' || r.n, 'record_kind', 'organism_id', 'instrument_analyte_code', 'ORG', 'organism_code_raw', 'ECO', 'received_at', now(), 'match_status', r.st) || r.x)
  FROM (VALUES (371, pg_temp.ta(), pg_temp.id('00000000a201'), 'applied', jsonb_build_object('expires_at', now() - interval '1 day')), (372, pg_temp.ta(), pg_temp.id('00000000a201'), 'applied', jsonb_build_object('expires_at', now() - interval '1 day')),
               (373, pg_temp.ta(), pg_temp.id('00000000a201'), 'applied', jsonb_build_object('expires_at', now() + interval '300 days')), (374, pg_temp.tb(), pg_temp.id('00000000b201'), 'applied', jsonb_build_object('expires_at', now() - interval '1 day')),
               (375, pg_temp.ta(), pg_temp.id('00000000a201'), 'pending_match', '{}'::jsonb)) r(n, t, c, st, x);
SELECT pg_temp.ins('micro.specimen_isolate_counters', jsonb_build_object('tenant_id', r.t, 'specimen_id', pg_temp.uid(r.sp), 'last_seq', 1)) FROM (VALUES (pg_temp.ta(), 8301), (pg_temp.tb(), 8303)) r(t, sp);
SET LOCAL session_replication_role = origin;      -- back to normal: triggers and FKs are live for every assertion below

SELECT is((SELECT count(*)::int FROM micro.g_cs_ast_interpretations), 11, 'C10 check 8: 11 AST interpretation seeds (§3.2)');
SELECT is((SELECT count(*)::int FROM micro.g_cs_organisms), 10, 'C10 check 8: 10 global organisms seeded (§3.2)');
SELECT is((SELECT count(*)::int FROM micro.g_cs_antibiotics), 20, 'C10 check 8: 20 global antibiotics seeded (§3.2)');
SELECT is((SELECT count(*)::int FROM micro.cultures), 6, 'C10 check 8: 6 culture fixtures (superuser sees all tenants)');
SELECT is((SELECT count(*)::int FROM micro.instrument_records), 5, 'C10 check 8: 5 instrument_record fixtures');

-- ===================================================================================================================================== read-only checks first
-- C10 check 9: tenant isolation (AC-0B-3.1 / 3.2 / 3.3 / 3.5; §10 items 1, 3)
SELECT is(pg_temp.sa('SELECT 1 FROM ' || q || ' WHERE tenant_id = ' || quote_literal(pg_temp.tb()), 'n'), 'n=0', 'C10 check 9 / AC-0B-3.1: tenant A system actor sees 0 tenant B rows of ' || q) FROM tt;
SELECT is(pg_temp.ua(pg_temp.m('a500'), 'SELECT 1 FROM ' || q || ' WHERE tenant_id = ' || quote_literal(pg_temp.tb()), 'n'), 'n=0', 'C10 check 9 / AC-0B-3.1: tenant A staff user sees 0 tenant B rows of ' || q) FROM tt;
SELECT is(pg_temp.sb('SELECT 1 FROM ' || q || ' WHERE tenant_id = ' || quote_literal(pg_temp.ta()), 'n'), 'n=0', 'C10 check 9 / AC-0B-3.1: tenant B system actor sees 0 tenant A rows of ' || q) FROM tt;
SELECT is(pg_temp.sa('SELECT 1 FROM micro.cultures', 'n'), 'n=5', 'C10 check 9: tenant A sees exactly its 5 cultures');
SELECT is(pg_temp.sb('SELECT 1 FROM micro.cultures', 'n'), 'n=1', 'C10 check 9: tenant B sees exactly its culture');
SELECT is(pg_temp.sb('SELECT 1 FROM micro.report_versions', 'n'), 'n=1', 'C10 check 9: tenant B sees exactly its report version');
SELECT matches(pg_temp.sa('INSERT INTO micro.settings (id, tenant_id, created_by, updated_by) VALUES (' || quote_literal(pg_temp.uid(901)) || ', ' || quote_literal(pg_temp.tb()) || ', ' || quote_literal(pg_temp.sys()) || ', ' || quote_literal(pg_temp.sys()) || ')'),
  '^E42501\|', 'C10 check 9 / AC-0B-3.2: tenant A claims cannot INSERT a tenant B row (RLS WITH CHECK)');
SELECT matches(pg_temp.sa('INSERT INTO micro.culture_transitions (id, tenant_id, centre_id, culture_id, to_status, occurred_at, created_by) VALUES (' || quote_literal(pg_temp.uid(902)) || ', ' || quote_literal(pg_temp.tb()) || ', ' || quote_literal(pg_temp.id('00000000b201'))
  || ', ' || quote_literal(pg_temp.uid(303)) || ', ''incubating'', now(), ' || quote_literal(pg_temp.sys()) || ')'), '^E42501\|', 'C10 check 9 / AC-0B-3.2: tenant A claims cannot INSERT a tenant B centre-scoped row');
SELECT is(pg_temp.sa('UPDATE micro.settings SET recent_window_days = 9 WHERE tenant_id = ' || quote_literal(pg_temp.tb())), 'n=0', 'C10 check 9 / AC-0B-3.3: tenant A updates 0 tenant B settings');
SELECT is(pg_temp.sa('UPDATE micro.cultures SET updated_by = updated_by WHERE tenant_id = ' || quote_literal(pg_temp.tb())), 'n=0', 'C10 check 9 / AC-0B-3.3: tenant A updates 0 tenant B cultures');
SELECT is(pg_temp.sa('DELETE FROM micro.instrument_records WHERE tenant_id = ' || quote_literal(pg_temp.tb())), 'n=0', 'C10 check 9 / AC-0B-3.3: tenant A system actor deletes 0 tenant B instrument_records (even expired)');
SELECT is(pg_temp.sa('SELECT 1 FROM micro.g_cs_organisms', 'n'), 'n=10', 'C10 check 9 / AC-0B-3.5: the global coded sets are readable by every tenant');
SELECT is(pg_temp.sb('SELECT 1 FROM micro.g_cs_ast_interpretations', 'n'), 'n=11', 'C10 check 9: global AST interpretations readable by tenant B');

-- C10 check 10: centre isolation (AC-0B-3.4; §10 item 1, D-63): collection centre only, child rows follow their culture
SELECT is(pg_temp.ua(pg_temp.m('a50a'), 'SELECT 1 FROM ' || q || ' WHERE centre_id = ' || quote_literal(pg_temp.id('00000000a202')), 'n'), 'n=0', 'C10 check 10 / AC-0B-3.4: centre-A1 staff sees 0 centre A2 rows of ' || q) FROM tc;
SELECT is(pg_temp.ua(pg_temp.m('a50a'), 'SELECT 1 FROM ' || q || ' WHERE centre_id = ' || quote_literal(pg_temp.id('00000000a201')), 'n') ~ '^n=[1-9]', true, 'C10 check 10 / AC-0B-3.4: centre-A1 staff sees its own centre rows of ' || q) FROM tc;
SELECT is(pg_temp.ua(pg_temp.m('a50a'), 'SELECT 1 FROM micro.cultures', 'n'), 'n=4', 'C10 check 10: centre-A1 staff sees only the 4 centre A1 cultures (301, 304, 305, 306)');
SELECT is(pg_temp.ua(pg_temp.m('a50a'), 'SELECT 1 FROM micro.isolates', 'n'), 'n=3', 'C10 check 10: child rows follow the culture: 3 centre A1 isolates');
SELECT is(pg_temp.ua(pg_temp.m('a500'), 'SELECT 1 FROM micro.cultures', 'n'), 'n=5', 'C10 check 10: an all-centres (D-13 hub) user sees all five tenant A cultures');
SELECT is(pg_temp.sa('SELECT 1 FROM micro.cultures', 'n'), 'n=5', 'C10 check 10: the system actor (has_all_centres) sees all tenant A cultures');
SELECT is(pg_temp.ua(pg_temp.m('a50a'), 'SELECT 1 FROM micro.settings', 'n'), 'n=1', 'C10 check 10: configuration tables are tenant-scoped (no centre predicate): restricted staff still reads the settings');
SELECT is(pg_temp.ua(pg_temp.m('a50a'), 'UPDATE micro.cultures SET updated_by = updated_by WHERE centre_id = ' || quote_literal(pg_temp.id('00000000a202'))), 'n=0', 'C10 check 10 / AC-0B-3.4: centre-A1 staff updates 0 centre A2 cultures');
SELECT matches(pg_temp.ua(pg_temp.m('a50a'), 'INSERT INTO micro.culture_transitions (id, tenant_id, centre_id, culture_id, to_status, occurred_at, created_by) VALUES (' || quote_literal(pg_temp.uid(903)) || ', ' || quote_literal(pg_temp.ta()) || ', '
  || quote_literal(pg_temp.id('00000000a202')) || ', ' || quote_literal(pg_temp.uid(302)) || ', ''incubating'', now(), ' || quote_literal(pg_temp.sys()) || ')'), '^E42501\|', 'C10 check 10 / AC-0B-3.4: centre-A1 staff cannot write a row of centre A2');

-- C10 check 11: non-staff actors (AC-0B-3.6), device actors (§10 item 8, review m#30) and fail-closed without claims (AC-0B-3.7)
SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), k.t, pg_temp.m('a500')), 'SELECT 1 FROM ' || tt.q, 'n'), 'n=0', 'C10 check 11 / AC-0B-3.6: ' || k.t || ' actor sees 0 rows of ' || tt.q) FROM tt CROSS JOIN (VALUES ('partner'),('portal'),('patient')) k(t);
SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), 'device') || jsonb_build_object('centre_id', pg_temp.id('00000000a201')), 'SELECT 1 FROM ' || q, 'n'), 'n=0', 'C10 check 11 / §10 item 8: a device actor of centre A1 sees 0 rows of centre-scoped ' || q) FROM tc;
SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), 'portal', pg_temp.m('a500')), 'UPDATE micro.settings SET recent_window_days = 5'), 'n=0', 'C10 check 11 / AC-0B-3.6: a portal actor updates 0 settings');
SELECT matches(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), 'partner', pg_temp.m('a500')), 'INSERT INTO micro.specimen_isolate_counters (tenant_id, specimen_id, last_seq, created_by, updated_by) VALUES (' || quote_literal(pg_temp.ta()) || ', ' || quote_literal(pg_temp.uid(8399)) || ', 0, '
  || quote_literal(pg_temp.sys()) || ', ' || quote_literal(pg_temp.sys()) || ')'), '^E42501\|', 'C10 check 11 / AC-0B-3.6: a partner actor cannot INSERT');
SELECT is(pg_temp.x('lims_api', NULL, 'SELECT 1 FROM ' || q, 'n'), 'n=0', 'C10 check 11 / AC-0B-3.7: no claims -> lims_api sees 0 rows of ' || q) FROM tt;
SELECT is(pg_temp.x('lims_api', '{}'::jsonb, 'SELECT 1 FROM ' || q, 'n'), 'n=0', 'C10 check 11 / AC-0B-3.7: empty claims -> 0 rows of ' || q) FROM tt;
SELECT is(pg_temp.x('lims_api', NULL, 'SELECT 1 FROM micro.v_pub_report_content', 'n'), 'n=0', 'C10 check 11 / AC-0B-3.7: no claims -> the invoker view returns 0 rows');

-- C10 check 12: append-only tables (AC-0B-4.1 / 4.2 / 4.3; §10 item 2): INSERT + SELECT only; no DELETE grant outside instrument_records
SELECT matches(pg_temp.sa('UPDATE ' || q || ' SET created_by = created_by'), '^E42501\|', 'C10 check 12 / AC-0B-4.1 / 4.3: even the system actor has no UPDATE grant on ' || q)
  FROM (VALUES ('micro.report_versions'),('micro.culture_observations'),('micro.culture_transitions'),('micro.breakpoint_rows'),('micro.breakpoint_bands'),('micro.breakpoint_import_issues')) v(q);
SELECT matches(pg_temp.sa('DELETE FROM ' || tt.q), '^E42501\|', 'C10 check 12 / AC-0B-4.2: no DELETE grant on ' || tt.q) FROM tt WHERE tt.q <> 'micro.instrument_records';
SELECT matches(pg_temp.sa('INSERT INTO micro.g_cs_media (code, display) VALUES (''x_test'', ''X'')'), '^E42501\|', 'C10 check 12: global coded sets are not writable by lims_app');
SELECT matches(pg_temp.sa('UPDATE micro.g_ast_category_restrictions SET is_active = false'), '^E42501\|', 'C10 check 12: global AST restrictions are not updatable by lims_app');
SELECT is(pg_temp.sa('INSERT INTO micro.breakpoint_import_issues (id, tenant_id, set_id, severity, code, message, created_by) VALUES (' || quote_literal(pg_temp.uid(904)) || ', ' || quote_literal(pg_temp.ta()) || ', ' || quote_literal(pg_temp.uid(402))
  || ', ''error'', ''file.bad_header'', ''Synthetic'', ' || quote_literal(pg_temp.sys()) || ')'), 'n=1', 'C10 check 12: an append-only table accepts INSERT');
SELECT matches(pg_temp.sa('INSERT INTO micro.breakpoint_import_issues (id, tenant_id, set_id, severity, code, message, created_by) VALUES (' || quote_literal(pg_temp.uid(905)) || ', ' || quote_literal(pg_temp.ta()) || ', ' || quote_literal(pg_temp.uid(402))
  || ', ''fatal'', ''file.bad_header'', ''Synthetic'', ' || quote_literal(pg_temp.sys()) || ')'), '^E23514\|', 'C10 check 12 / §8: severity is error or warning (breakpoint_import_issues__severity__ck)');

-- C10 check 13: instrument_records purge rule (D-65, P-18(c); §10 item 11): DELETE only by the system actor on expired, unreferenced rows of its tenant
SELECT is(pg_temp.ua(pg_temp.m('a500'), 'DELETE FROM micro.instrument_records WHERE id = ' || quote_literal(pg_temp.uid(371))), 'n=0', 'C10 check 13 / AC-0B-4.2: a staff user (not system actor) deletes 0 instrument_records, even an expired one');
SELECT is(pg_temp.sa('DELETE FROM micro.instrument_records WHERE id = ' || quote_literal(pg_temp.uid(373))), 'n=0', 'C10 check 13 / D-65: the system actor does not delete a row that has not expired');
SELECT is(pg_temp.sa('DELETE FROM micro.instrument_records WHERE id = ' || quote_literal(pg_temp.uid(375))), 'n=0', 'C10 check 13 / D-65: an open record (expires_at NULL) is never deleted');
SELECT matches(pg_temp.sa('DELETE FROM micro.instrument_records WHERE id = ' || quote_literal(pg_temp.uid(372))), '^E23503\|', 'C10 check 13: an expired record referenced by ast_results.instrument_record_id is kept by the FK (the task predicate skips it, §8 Purge)');
SELECT is(pg_temp.sa('DELETE FROM micro.instrument_records r WHERE r.tenant_id = ' || quote_literal(pg_temp.ta()) || ' AND r.expires_at < now() AND NOT EXISTS (SELECT 1 FROM micro.ast_results a WHERE a.tenant_id = r.tenant_id AND a.instrument_record_id = r.id)'), 'n=1',
  'C10 check 13 / D-65: the purge task predicate deletes exactly the one expired, unreferenced record of tenant A (371)');

-- ===================================================================================================================================== state-changing checks
-- C10 check 14: guard triggers (§5, §10 items 5, 6, 9); SQLSTATE P0001 + message
SELECT matches(pg_temp.sa('UPDATE micro.cultures SET order_id = ' || quote_literal(pg_temp.uid(1)) || ' WHERE id = ' || quote_literal(pg_temp.uid(301))), '^EP0001\|', 'C10 check 14: cultures.order_id is immutable (enforce_mutable_columns)');
SELECT matches(pg_temp.sa('UPDATE micro.cultures SET centre_id = ' || quote_literal(pg_temp.id('00000000a202')) || ' WHERE id = ' || quote_literal(pg_temp.uid(301))), '^EP0001\|', 'C10 check 14: cultures.centre_id never changes (§1: child visibility cannot diverge)');
SELECT matches(pg_temp.sa('UPDATE micro.cultures SET specimen_id = ' || quote_literal(pg_temp.uid(1)) || ' WHERE id = ' || quote_literal(pg_temp.uid(301))), '^EP0001\|immutable_row', 'C10 check 14 / §10 item 6: specimen_id change after awaiting_setup rejected');
SELECT matches(pg_temp.sa('UPDATE micro.cultures SET specimen_id = ' || quote_literal(pg_temp.uid(1)) || ' WHERE id = ' || quote_literal(pg_temp.uid(306))), '^E23503\|', 'C10 check 14: while awaiting_setup the guard lets specimen_id change (aliquot re-point); only the missing lab.specimens parent (FK, no fixture here) stops the statement');
SELECT matches(pg_temp.sa('UPDATE micro.cultures SET status = ''awaiting_setup'' WHERE id = ' || quote_literal(pg_temp.uid(304))), '^EP0001\|culture_invalid_transition', 'C10 check 14 / §10 item 6: final_submitted -> awaiting_setup rejected (culture_invalid_transition)');
SELECT matches(pg_temp.sa('UPDATE micro.cultures SET status = ''growth_detected'' WHERE id = ' || quote_literal(pg_temp.uid(306))), '^EP0001\|culture_invalid_transition', 'C10 check 14: awaiting_setup -> growth_detected skips C2 and is rejected');
SELECT matches(pg_temp.sa('UPDATE micro.cultures SET current_report_version_no = 0 WHERE id = ' || quote_literal(pg_temp.uid(305))), '^EP0001\|immutable_row', 'C10 check 14: current_report_version_no never decreases');
SELECT is(pg_temp.sa('UPDATE micro.cultures SET status = ''growth_detected'' WHERE id = ' || quote_literal(pg_temp.uid(301))), 'n=1', 'C10 check 14: incubating -> growth_detected (C3) is allowed');
-- final lock (review #7, §10 item 9): culture 304 is final_submitted
SELECT matches(pg_temp.sa('INSERT INTO micro.isolates (id, tenant_id, centre_id, culture_id, specimen_id, isolate_seq, status, created_by, updated_by) VALUES (' || quote_literal(pg_temp.uid(911)) || ', ' || quote_literal(pg_temp.ta()) || ', ' || quote_literal(pg_temp.id('00000000a201')) || ', '
  || quote_literal(pg_temp.uid(304)) || ', ' || quote_literal(pg_temp.uid(8504)) || ', 2, ''pending_id'', ' || quote_literal(pg_temp.sys()) || ', ' || quote_literal(pg_temp.sys()) || ')'), '^EP0001\|immutable_row', 'C10 check 14 / §10 item 9: INSERT isolate under a final_submitted culture rejected');
SELECT matches(pg_temp.sa('UPDATE micro.isolates SET colony_description = ''x'' WHERE id = ' || quote_literal(pg_temp.uid(344))), '^EP0001\|immutable_row', 'C10 check 14 / §10 item 9: UPDATE isolate under a final_submitted culture rejected');
SELECT matches(pg_temp.sa('INSERT INTO micro.ast_results (id, tenant_id, centre_id, culture_id, isolate_id, antibiotic_code, method, source, created_by, updated_by) VALUES (' || quote_literal(pg_temp.uid(912)) || ', ' || quote_literal(pg_temp.ta()) || ', '
  || quote_literal(pg_temp.id('00000000a201')) || ', ' || quote_literal(pg_temp.uid(304)) || ', ' || quote_literal(pg_temp.uid(344)) || ', ''amikacin'', ''mic'', ''manual'', ' || quote_literal(pg_temp.sys()) || ', ' || quote_literal(pg_temp.sys()) || ')'), '^EP0001\|immutable_row',
  'C10 check 14 / §10 item 9: INSERT ast_result under a final_submitted culture rejected');
SELECT matches(pg_temp.sa('UPDATE micro.ast_results SET raw_value = ''4'' WHERE id = ' || quote_literal(pg_temp.uid(354))), '^EP0001\|immutable_row', 'C10 check 14 / §10 item 9: UPDATE ast_result under a final_submitted culture rejected');
SELECT matches(pg_temp.sa('INSERT INTO micro.culture_plates (id, tenant_id, centre_id, culture_id, plate_no, media_code, planted_at, created_by, updated_by) VALUES (' || quote_literal(pg_temp.uid(913)) || ', ' || quote_literal(pg_temp.ta()) || ', '
  || quote_literal(pg_temp.id('00000000a201')) || ', ' || quote_literal(pg_temp.uid(304)) || ', 2, ''blood_agar'', now(), ' || quote_literal(pg_temp.sys()) || ', ' || quote_literal(pg_temp.sys()) || ')'), '^EP0001\|immutable_row', 'C10 check 14 / §10 item 9: INSERT plate under a final_submitted culture rejected');
SELECT matches(pg_temp.sa('UPDATE micro.culture_plates SET incubation_text = ''x'' WHERE id = ' || quote_literal(pg_temp.uid(314))), '^EP0001\|immutable_row', 'C10 check 14 / §10 item 9: UPDATE plate under a final_submitted culture rejected');
SELECT matches(pg_temp.sa('INSERT INTO micro.culture_observations (id, tenant_id, centre_id, culture_id, kind, finding_text, observed_at, created_by) VALUES (' || quote_literal(pg_temp.uid(914)) || ', ' || quote_literal(pg_temp.ta()) || ', '
  || quote_literal(pg_temp.id('00000000a201')) || ', ' || quote_literal(pg_temp.uid(304)) || ', ''other'', ''Synthetic'', now(), ' || quote_literal(pg_temp.sys()) || ')'), '^EP0001\|immutable_row', 'C10 check 14 / §10 item 9: INSERT observation under a final_submitted culture rejected');
SELECT is(pg_temp.sa('INSERT INTO micro.culture_transitions (id, tenant_id, centre_id, culture_id, to_status, occurred_at, created_by) VALUES (' || quote_literal(pg_temp.uid(915)) || ', ' || quote_literal(pg_temp.ta()) || ', ' || quote_literal(pg_temp.id('00000000a201')) || ', '
  || quote_literal(pg_temp.uid(304)) || ', ''amending'', now(), ' || quote_literal(pg_temp.sys()) || ')'), 'n=1', 'C10 check 14: the state history stays writable on a final culture (no final lock on culture_transitions)');
-- same writes succeed once the culture is amending (C8)
SELECT is(pg_temp.sa('UPDATE micro.cultures SET status = ''amending'', amendment_reason_code = ''correction'' WHERE id = ' || quote_literal(pg_temp.uid(304))), 'n=1', 'C10 check 14: final_submitted -> amending (C8 reopen) is allowed');
SELECT is(pg_temp.sa('INSERT INTO micro.isolates (id, tenant_id, centre_id, culture_id, specimen_id, isolate_seq, status, created_by, updated_by) VALUES (' || quote_literal(pg_temp.uid(911)) || ', ' || quote_literal(pg_temp.ta()) || ', ' || quote_literal(pg_temp.id('00000000a201')) || ', '
  || quote_literal(pg_temp.uid(304)) || ', ' || quote_literal(pg_temp.uid(8504)) || ', 2, ''pending_id'', ' || quote_literal(pg_temp.sys()) || ', ' || quote_literal(pg_temp.sys()) || ')'), 'n=1', 'C10 check 14 / §10 item 9: the same isolate INSERT succeeds while the culture is amending');
SELECT is(pg_temp.sa('UPDATE micro.ast_results SET raw_value = ''4'' WHERE id = ' || quote_literal(pg_temp.uid(354))), 'n=1', 'C10 check 14 / §10 item 9: ast_result UPDATE succeeds while amending');
SELECT is(pg_temp.sa('INSERT INTO micro.culture_plates (id, tenant_id, centre_id, culture_id, plate_no, media_code, planted_at, created_by, updated_by) VALUES (' || quote_literal(pg_temp.uid(913)) || ', ' || quote_literal(pg_temp.ta()) || ', '
  || quote_literal(pg_temp.id('00000000a201')) || ', ' || quote_literal(pg_temp.uid(304)) || ', 2, ''blood_agar'', now(), ' || quote_literal(pg_temp.sys()) || ', ' || quote_literal(pg_temp.sys()) || ')'), 'n=1', 'C10 check 14 / §10 item 9: plate INSERT succeeds while amending');
SELECT is(pg_temp.sa('INSERT INTO micro.culture_observations (id, tenant_id, centre_id, culture_id, kind, finding_text, observed_at, created_by) VALUES (' || quote_literal(pg_temp.uid(914)) || ', ' || quote_literal(pg_temp.ta()) || ', '
  || quote_literal(pg_temp.id('00000000a201')) || ', ' || quote_literal(pg_temp.uid(304)) || ', ''other'', ''Synthetic'', now(), ' || quote_literal(pg_temp.sys()) || ')'), 'n=1', 'C10 check 14 / §10 item 9: observation INSERT succeeds while amending');
-- breakpoint_sets (§5, §10 item 5): 401 active, 402 validated
SELECT matches(pg_temp.sa('UPDATE micro.breakpoint_sets SET status = ''validated'' WHERE id = ' || quote_literal(pg_temp.uid(401))), '^EP0001\|immutable_row', 'C10 check 14 / §10 item 5: active -> validated rejected (03-APP-FLOW §2.5)');
SELECT matches(pg_temp.sa('UPDATE micro.breakpoint_sets SET effective_from = now() WHERE id = ' || quote_literal(pg_temp.uid(401))), '^EP0001\|immutable_row', 'C10 check 14 / §10 item 5: effective_from of an active set is frozen');
SELECT matches(pg_temp.sa('UPDATE micro.breakpoint_sets SET title = ''Other title'' WHERE id = ' || quote_literal(pg_temp.uid(402))), '^EP0001\|', 'C10 check 14: breakpoint_sets.title is immutable (enforce_mutable_columns)');
SELECT matches(pg_temp.sa('UPDATE micro.breakpoint_sets SET status = ''uploaded'' WHERE id = ' || quote_literal(pg_temp.uid(402))), '^EP0001\|immutable_row', 'C10 check 14: validated -> uploaded is not a transition');
SELECT is(pg_temp.sa('UPDATE micro.breakpoint_sets SET status = ''active'', effective_from = now(), activated_by = ' || quote_literal(pg_temp.uid(9002)) || ', activated_at = now() WHERE id = ' || quote_literal(pg_temp.uid(402))), 'n=1', 'C10 check 14: validated -> active (B4) is allowed');
SELECT is(pg_temp.sa('UPDATE micro.breakpoint_sets SET status = ''retired'', effective_to = now(), retired_by = ' || quote_literal(pg_temp.uid(9003)) || ', retired_at = now() WHERE id = ' || quote_literal(pg_temp.uid(401))), 'n=1', 'C10 check 14: active -> retired (B5) is allowed');

-- C10 check 15: CHECK constraints, AST category FK (§10 items 4, 10), cross-tenant composite FK (AC-0B-3.5; §10 item 3), audit (AC-0B-5.1 / 5.2 / 5.3)
SELECT matches(pg_temp.sa('INSERT INTO micro.ast_results (id, tenant_id, centre_id, culture_id, isolate_id, antibiotic_code, method, raw_value, standard, standard_version, category_code, source, created_by, updated_by) VALUES (' || quote_literal(pg_temp.uid(921)) || ', '
  || quote_literal(pg_temp.ta()) || ', ' || quote_literal(pg_temp.id('00000000a201')) || ', ' || quote_literal(pg_temp.uid(301)) || ', ' || quote_literal(pg_temp.uid(341)) || ', ''amikacin'', ''mic'', ''4'', ''EUCAST'', ''2026'', ''SDD'', ''manual'', '
  || quote_literal(pg_temp.sys()) || ', ' || quote_literal(pg_temp.sys()) || ')'), '^E23503\|', 'C10 check 15 / §10 item 4: (EUCAST, SDD) rejected by ast_results__category__fk');
SELECT is(pg_temp.sa('INSERT INTO micro.ast_results (id, tenant_id, centre_id, culture_id, isolate_id, antibiotic_code, method, raw_value, standard, standard_version, category_code, source, created_by, updated_by) VALUES (' || quote_literal(pg_temp.uid(922)) || ', '
  || quote_literal(pg_temp.ta()) || ', ' || quote_literal(pg_temp.id('00000000a201')) || ', ' || quote_literal(pg_temp.uid(301)) || ', ' || quote_literal(pg_temp.uid(341)) || ', ''gentamicin'', ''mic'', ''4'', ''CLSI'', ''2026'', ''I^'', ''manual'', '
  || quote_literal(pg_temp.sys()) || ', ' || quote_literal(pg_temp.sys()) || ')'), 'n=1', 'C10 check 15 / §10 item 4: (CLSI, I^) accepted');
SELECT matches(pg_temp.sa('INSERT INTO micro.ast_results (id, tenant_id, centre_id, culture_id, isolate_id, antibiotic_code, method, raw_value, standard, standard_version, category_code, source, created_by, updated_by) VALUES (' || quote_literal(pg_temp.uid(923)) || ', '
  || quote_literal(pg_temp.ta()) || ', ' || quote_literal(pg_temp.id('00000000a201')) || ', ' || quote_literal(pg_temp.uid(301)) || ', ' || quote_literal(pg_temp.uid(341)) || ', ''cefepime'', ''mic'', ''4'', ''unknown'', ''2026'', ''S'', ''manual'', '
  || quote_literal(pg_temp.sys()) || ', ' || quote_literal(pg_temp.sys()) || ')'), '^E23514\|', 'C10 check 15 / §10 item 4: standard = unknown with a category rejected (ast_results__unknown__ck)');
SELECT matches(pg_temp.sa('INSERT INTO micro.ast_results (id, tenant_id, centre_id, culture_id, isolate_id, antibiotic_code, method, standard, standard_version, category_code, source, created_by, updated_by) VALUES (' || quote_literal(pg_temp.uid(924)) || ', '
  || quote_literal(pg_temp.ta()) || ', ' || quote_literal(pg_temp.id('00000000a201')) || ', ' || quote_literal(pg_temp.uid(301)) || ', ' || quote_literal(pg_temp.uid(341)) || ', ''cefoxitin'', ''mic'', ''CLSI'', ''2026'', ''S'', ''manual'', '
  || quote_literal(pg_temp.sys()) || ', ' || quote_literal(pg_temp.sys()) || ')'), '^E23514\|', 'C10 check 15 / §10 item 10: a category without raw_value rejected (ast_results__category_needs_value__ck)');
SELECT matches(pg_temp.sa('INSERT INTO micro.isolates (id, tenant_id, centre_id, culture_id, specimen_id, isolate_seq, status, created_by, updated_by) VALUES (' || quote_literal(pg_temp.uid(925)) || ', ' || quote_literal(pg_temp.ta()) || ', ' || quote_literal(pg_temp.id('00000000a201')) || ', '
  || quote_literal(pg_temp.uid(303)) || ', ' || quote_literal(pg_temp.uid(8203)) || ', 1, ''pending_id'', ' || quote_literal(pg_temp.sys()) || ', ' || quote_literal(pg_temp.sys()) || ')'), '^E23503\|', 'C10 check 15 / AC-0B-3.5 / §10 item 3: a tenant A isolate cannot reference a tenant B culture (composite FK (tenant_id, culture_id))');
SELECT matches(pg_temp.sa('UPDATE micro.cultures SET status = ''cancelled'' WHERE id = ' || quote_literal(pg_temp.uid(302))), '^E23514\|', 'C10 check 15: a cancelled culture needs cancel_reason_code + cancelled_at (cultures__cancel__ck)');
SELECT matches(pg_temp.sa('UPDATE micro.isolates SET status = ''identified'' WHERE id = ' || quote_literal(pg_temp.uid(342))), '^E23514\|', 'C10 check 15: an identified isolate needs organism_code + source (isolates__identified__ck)');
SELECT matches(pg_temp.sa('UPDATE micro.instrument_records SET match_status = ''applied'' WHERE id = ' || quote_literal(pg_temp.uid(375))), '^E23514\|', 'C10 check 15: applied needs expires_at (instrument_records__expires__ck, D-65)');
SELECT matches(pg_temp.sa('UPDATE micro.settings SET recent_window_days = 99 WHERE tenant_id = ' || quote_literal(pg_temp.ta())), '^E23514\|', 'C10 check 15: settings ranges (recent_window_days 1..31)');
SELECT matches(pg_temp.sa('INSERT INTO micro.settings (id, tenant_id, created_by, updated_by) VALUES (' || quote_literal(pg_temp.uid(926)) || ', ' || quote_literal(pg_temp.ta()) || ', ' || quote_literal(pg_temp.sys()) || ', ' || quote_literal(pg_temp.sys()) || ')'), '^E23505\|', 'C10 check 15: one settings row per tenant (settings__tenant__uq)');
SELECT matches(pg_temp.sa('INSERT INTO micro.report_versions (id, tenant_id, centre_id, culture_id, order_item_id, version_no, report_phase, version_kind, submission_kind, culture_summary_text, isolates, ast, is_critical, flag, signed_by_membership_id, signed_at, lab_result_id, lab_result_version_no, lab_status_at_submit, lab_replayed, created_by) VALUES ('
  || quote_literal(pg_temp.uid(927)) || ', ' || quote_literal(pg_temp.ta()) || ', ' || quote_literal(pg_temp.id('00000000a201')) || ', ' || quote_literal(pg_temp.uid(301)) || ', ' || quote_literal(pg_temp.uid(8401)) || ', 2, ''final'', ''update'', ''structured'', ''S'', ''[]'', ''[]'', false, ''N'', '
  || quote_literal(pg_temp.m('a500')) || ', now(), ' || quote_literal(pg_temp.uid(7777)) || ', 1, ''resulted'', false, ' || quote_literal(pg_temp.sys()) || ')'), '^E23514\|', 'C10 check 15: a final report version needs an outcome_code (report_versions__final_outcome__ck)');
-- audit (AC-0B-5.x): audited M / C / E tables write audit_log, class A tables and the counter do not
SELECT is(pg_temp.sa('UPDATE micro.settings SET recent_window_days = 10 WHERE tenant_id = ' || quote_literal(pg_temp.ta())), 'n=1', 'C10 check 15 / AC-0B-5.1: an audited class M update succeeds');
SELECT is((SELECT count(*)::int FROM audit.audit_log WHERE schema_name = 'micro' AND table_name = 'settings' AND row_id = pg_temp.uid(511) AND tenant_id = pg_temp.ta()), 1, 'C10 check 15 / AC-0B-5.1: the update wrote one audit_log row');
SELECT is((SELECT changed_columns @> ARRAY['recent_window_days'] FROM audit.audit_log WHERE schema_name = 'micro' AND table_name = 'settings' AND row_id = pg_temp.uid(511)), true, 'C10 check 15 / AC-0B-5.2: only the changed columns are recorded');
SELECT is((SELECT count(*)::int FROM audit.audit_log WHERE schema_name = 'micro' AND table_name = 'cultures' AND tenant_id = pg_temp.ta()) >= 1, true, 'C10 check 15 / AC-0B-5.1: cultures (class C) updates are audited');
SELECT is(pg_temp.sa('UPDATE micro.instrument_records SET match_status = ''ignored'', ignore_reason_code = ''wrong_sample'', expires_at = now() + interval ''1 year'' WHERE id = ' || quote_literal(pg_temp.uid(375))), 'n=1', 'C10 check 15: an open instrument record is ignored (expires_at set, D-65)');
SELECT is((SELECT count(*)::int FROM audit.audit_log WHERE schema_name = 'micro' AND table_name = 'instrument_records' AND row_id = pg_temp.uid(375)), 1, 'C10 check 15 / AC-0B-5.1: instrument_records (class E, §1 audited = yes) is audited');
SELECT is(pg_temp.sa('UPDATE micro.specimen_isolate_counters SET last_seq = 2 WHERE specimen_id = ' || quote_literal(pg_temp.uid(8301))), 'n=1', 'C10 check 15: the counter row is updatable (isolate numbering)');
SELECT is((SELECT count(*)::int FROM audit.audit_log WHERE schema_name = 'micro' AND table_name IN ('specimen_isolate_counters', 'breakpoint_import_issues', 'culture_transitions', 'culture_observations', 'report_versions', 'breakpoint_rows', 'breakpoint_bands')), 0,
  'C10 check 15 / AC-0B-5.3: class A tables and the counter are not audited (the earlier writes left no audit row)');

-- C10 check 16: views (§3.3, §6; AC-0B-6.1 / 6.2 / 6.3). v_pub_report_content is security_invoker: the caller's RLS (tenant + centre) applies
SELECT is(pg_temp.sa('SELECT count(*)::text FROM micro.v_pub_report_content', 's'), '2', 'C10 check 16 / §6: tenant A system actor reads its 2 report versions through the view');
SELECT is(pg_temp.sa('SELECT count(*)::text FROM micro.v_pub_report_content WHERE tenant_id = ' || quote_literal(pg_temp.tb()), 's'), '0', 'C10 check 16 / AC-0B-6.2: the invoker view applies the caller''s RLS: tenant A sees no tenant B report');
SELECT is(pg_temp.sb('SELECT count(*)::text FROM micro.v_pub_report_content', 's'), '1', 'C10 check 16: tenant B sees only its own report');
SELECT is(pg_temp.ua(pg_temp.m('a50a'), 'SELECT count(*)::text FROM micro.v_pub_report_content', 's'), '1', 'C10 check 16 / D-63: centre-A1 staff sees only the centre A1 report through the view');
SELECT is(pg_temp.sa('SELECT entity_id::text || '','' || version_no || '','' || report_phase FROM micro.v_pub_report_content WHERE entity_id = ' || quote_literal(pg_temp.uid(301)), 's'), pg_temp.uid(301)::text || ',1,preliminary', 'C10 check 16 / §6: entity_id = cultures.id, version_no, report_phase');
SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), 'portal', pg_temp.m('a500')), 'SELECT count(*)::text FROM micro.v_pub_report_content', 's'), '0', 'C10 check 16 / AC-0B-3.6: a portal actor reads no report content through the view');
SELECT matches(pg_temp.sa('INSERT INTO micro.v_pub_report_content (tenant_id) VALUES (' || quote_literal(pg_temp.ta()) || ')'), '^E', 'C10 check 16 / AC-0B-6.3: the published view is read-only');
SELECT is(pg_temp.sa('SELECT count(*)::text FROM micro.v_organisms', 's'), '10', 'C10 check 16 / §3.3: v_organisms = 10 global rows with the tenant row replacing the same code (no duplicate)');
SELECT is(pg_temp.sa('SELECT source || '','' || display || '','' || is_alert FROM micro.v_organisms WHERE code = ''escherichia_coli''', 's'), 'tenant,Tenant E. coli,true', 'C10 check 16 / §3.3: the tenant row shadows the global one (source = tenant)');
SELECT is(pg_temp.sb('SELECT source FROM micro.v_organisms WHERE code = ''escherichia_coli''', 's'), 'global', 'C10 check 16 / §3.3: tenant B has no override: the global row is served (source = global)');
SELECT is(pg_temp.sb('SELECT count(*)::text FROM micro.v_organisms', 's'), '11', 'C10 check 16 / §3.3: tenant B sees 10 global + its own additional organism');
SELECT is(pg_temp.sa('SELECT count(*)::text FROM micro.v_organisms WHERE code = ''b_only_organism''', 's'), '0', 'C10 check 16 / AC-0B-6.2: tenant A does not see a tenant B coded-set row through the view');

SELECT * FROM finish();
ROLLBACK;
