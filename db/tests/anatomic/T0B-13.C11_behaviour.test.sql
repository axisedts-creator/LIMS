-- T0B-13.C11 behaviour suite: tenant / centre isolation, non-staff + device actors and fail-closed no-claims, append-only tables + no DELETE, guard triggers (cases, blocks, synoptic_templates, addenda, report_drafts, images), CHECK constraints,
-- composite same-case FKs, accession counter, audit, published view anatomic.v_pub_report_content (C11 05-SCHEMA §1, §3, §6, §7, §8, §11 items 1-5, 7; AC-0B-2.4, 3.1-3.7, 4.1, 4.2, 4.3, 5.1, 5.2, 5.3, 6.1-6.3).
-- The generated per-table probes (db/tests/isolation/anatomic.<t>.test.sql) are the AC-0B-3.x proof for every table; this file proves what the generator cannot know (§11 items 1-5, 7).
-- Synthetic data only (seeds 010: tenant A 01a1a98a-...-a001, tenant B ...-b001; centres a201, a202, b201; memberships a500 all-centres staff, a50a staff restricted to centre a201, b500).
-- One rolled-back transaction. RLS is never disabled. FK PARENT rows of other chunks (frontdesk orders / patients / order items, lab specimens / results) are not built here: the fixtures are inserted by the superuser test session inside ONE block
-- with the replica session replication role (FK + user triggers off; RLS, CHECK and NOT NULL stay on; C9-T20 / C10 precedent) that is reset to origin before the first assertion. Every assertion runs as SET LOCAL ROLE lims_app / lims_api.
-- Run from the repo root: pg_prove -d <db> db/tests/anatomic/T0B-13.C11_behaviour.test.sql   (pgTAP in schema `extensions`; migrations + seeds loaded; superuser)
-- Markers: C11 check 8 fixtures + seed, 9 tenant isolation (AC-0B-3.1/3.2/3.3/3.5), 10 centre isolation (AC-0B-3.4), 11 non-staff / device actors + no claims (AC-0B-3.6/3.7), 12 append-only + no DELETE (AC-0B-4.1/4.2/4.3),
-- 13 guard triggers + immutability (AC-0B-4.1), 14 CHECK constraints + same-case composite FKs (AC-0B-3.5), 15 audit + counter + view (AC-0B-5.1/5.2/5.3, 6.1/6.2/6.3).
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
CREATE FUNCTION pg_temp.q(u uuid) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT quote_literal(u::text) $$;
CREATE TEMP TABLE tt(q) AS VALUES
  ('anatomic.settings'),('anatomic.accession_counters'),('anatomic.test_profiles'),('anatomic.stains'),('anatomic.assays'),('anatomic.assay_targets'),('anatomic.assay_target_values'),('anatomic.cs_cancel_reasons'),
  ('anatomic.cs_diagnoses'),('anatomic.cs_cytology_adequacy'),('anatomic.synoptic_templates'),('anatomic.text_templates'),('anatomic.batches'),('anatomic.batch_members'),
  ('anatomic.cases'),('anatomic.case_transitions'),('anatomic.case_items'),('anatomic.specimen_links'),('anatomic.parts'),('anatomic.gross_records'),('anatomic.blocks'),('anatomic.slides'),('anatomic.stain_orders'),
  ('anatomic.object_movements'),('anatomic.images'),('anatomic.report_drafts'),('anatomic.report_versions'),('anatomic.item_submissions'),('anatomic.addenda'),('anatomic.molecular_results');
CREATE TEMP TABLE tc(q) AS VALUES ('anatomic.cases'),('anatomic.case_transitions'),('anatomic.case_items'),('anatomic.specimen_links'),('anatomic.parts'),('anatomic.gross_records'),('anatomic.blocks'),('anatomic.slides'),
  ('anatomic.stain_orders'),('anatomic.object_movements'),('anatomic.images'),('anatomic.report_drafts'),('anatomic.report_versions'),('anatomic.item_submissions'),('anatomic.addenda'),('anatomic.molecular_results');

-- ===================================================================================================================================== fixtures (superuser, replica block)
-- C11 check 8: tenant A cases 301 (centre a201, accessioned), 302 (a202, received), 304 (a201, accessioned) and tenant B case 303 (b201) with children
SET LOCAL session_replication_role = replica;      -- FIXTURE-ONLY: FK parents of other chunks are not built; RLS, CHECK, NOT NULL stay on; reset to origin below
-- FK parents of other chunks do not exist here; PostgreSQL re-checks a foreign key on UPDATE for rows inserted by the same transaction, so the six constraints towards frontdesk / lab are dropped for this rolled-back test
-- transaction only (every anatomic-internal and core FK stays and is probed below).
ALTER TABLE anatomic.cases DROP CONSTRAINT IF EXISTS cases__order__fk, DROP CONSTRAINT IF EXISTS cases__patient__fk;
ALTER TABLE anatomic.case_items DROP CONSTRAINT IF EXISTS case_items__order_item__fk;
ALTER TABLE anatomic.specimen_links DROP CONSTRAINT IF EXISTS specimen_links__specimen__fk;
ALTER TABLE anatomic.parts DROP CONSTRAINT IF EXISTS parts__specimen__fk;
ALTER TABLE anatomic.item_submissions DROP CONSTRAINT IF EXISTS item_submissions__lab_result__fk;
SELECT pg_temp.ins('anatomic.settings', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', r.t)) FROM (VALUES (511, pg_temp.ta()), (512, pg_temp.tb())) r(n, t);
SELECT pg_temp.ins('anatomic.accession_counters', jsonb_build_object('tenant_id', r.t, 'series_key', 'histology', 'year_ad', 2026, 'last_value', 1)) FROM (VALUES (pg_temp.ta()), (pg_temp.tb())) r(t);
SELECT pg_temp.ins('anatomic.stains', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', r.t, 'code', 'HE', 'display', 'Haematoxylin and eosin', 'kind', 'routine')) FROM (VALUES (351, pg_temp.ta()), (352, pg_temp.tb())) r(n, t);
SELECT pg_temp.ins('anatomic.assays', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', r.t, 'code', 'SYN_PCR_A', 'display', 'Synthetic PCR A')) FROM (VALUES (441, pg_temp.ta()), (444, pg_temp.tb())) r(n, t);
SELECT pg_temp.ins('anatomic.assay_targets', jsonb_build_object('id', pg_temp.uid(442), 'tenant_id', pg_temp.ta(), 'assay_id', pg_temp.uid(441), 'code', 'T1', 'display', 'Target 1'));
SELECT pg_temp.ins('anatomic.assay_target_values', jsonb_build_object('id', pg_temp.uid(443), 'tenant_id', pg_temp.ta(), 'target_id', pg_temp.uid(442), 'code', 'detected', 'display', 'Detected', 'is_abnormal', true));
SELECT pg_temp.ins('anatomic.synoptic_templates', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', pg_temp.ta(), 'template_key', 'synthetic_example', 'version_no', r.v, 'status', r.st, 'title', 'Example checklist (synthetic)',
    'applies_to_case_kinds', to_jsonb(ARRAY['histology']), 'definition', '{}'::jsonb) || r.x)
  FROM (VALUES (481, 1, 'published', jsonb_build_object('published_at', now())), (482, 2, 'draft', '{}'::jsonb)) r(n, v, st, x);
SELECT pg_temp.ins('anatomic.cases', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', r.t, 'centre_id', r.c, 'order_id', pg_temp.uid(8000 + r.n), 'patient_id', pg_temp.uid(8300), 'case_kind', 'histology', 'status', r.st, 'received_at', now()) || r.x)
  FROM (VALUES (301, pg_temp.ta(), pg_temp.id('00000000a201'), 'accessioned', jsonb_build_object('accession_no', 'H26-1', 'accessioned_at', now())),
               (302, pg_temp.ta(), pg_temp.id('00000000a202'), 'received', '{}'::jsonb),
               (303, pg_temp.tb(), pg_temp.id('00000000b201'), 'received', '{}'::jsonb),
               (304, pg_temp.ta(), pg_temp.id('00000000a201'), 'accessioned', jsonb_build_object('accession_no', 'H26-2', 'accessioned_at', now()))) r(n, t, c, st, x);
SELECT pg_temp.ins('anatomic.case_transitions', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', r.t, 'centre_id', r.c, 'case_id', pg_temp.uid(r.cs), 'to_status', 'received'))
  FROM (VALUES (431, pg_temp.ta(), pg_temp.id('00000000a201'), 301), (432, pg_temp.ta(), pg_temp.id('00000000a202'), 302), (433, pg_temp.tb(), pg_temp.id('00000000b201'), 303)) r(n, t, c, cs);
SELECT pg_temp.ins('anatomic.case_items', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', r.t, 'centre_id', r.c, 'case_id', pg_temp.uid(r.cs), 'order_item_id', pg_temp.uid(8100 + r.n), 'test_id', pg_temp.uid(2000)))
  FROM (VALUES (401, pg_temp.ta(), pg_temp.id('00000000a201'), 301), (403, pg_temp.ta(), pg_temp.id('00000000a202'), 302), (404, pg_temp.tb(), pg_temp.id('00000000b201'), 303), (405, pg_temp.ta(), pg_temp.id('00000000a201'), 304)) r(n, t, c, cs);
SELECT pg_temp.ins('anatomic.specimen_links', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', r.t, 'centre_id', r.c, 'specimen_id', pg_temp.uid(8200 + r.n), 'link_kind', 'aliquot_ignored', 'last_seq', 1, 'last_status', 'received'))
  FROM (VALUES (501, pg_temp.ta(), pg_temp.id('00000000a201')), (502, pg_temp.ta(), pg_temp.id('00000000a202')), (503, pg_temp.tb(), pg_temp.id('00000000b201'))) r(n, t, c);
SELECT pg_temp.ins('anatomic.parts', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', r.t, 'centre_id', r.c, 'case_id', pg_temp.uid(r.cs), 'letter', 'A', 'letter_seq', 1))
  FROM (VALUES (311, pg_temp.ta(), pg_temp.id('00000000a201'), 301), (312, pg_temp.ta(), pg_temp.id('00000000a202'), 302), (313, pg_temp.tb(), pg_temp.id('00000000b201'), 303), (314, pg_temp.ta(), pg_temp.id('00000000a201'), 304)) r(n, t, c, cs);
SELECT pg_temp.ins('anatomic.gross_records', jsonb_build_object('id', pg_temp.uid(411), 'tenant_id', pg_temp.ta(), 'centre_id', pg_temp.id('00000000a201'), 'case_id', pg_temp.uid(301), 'part_id', pg_temp.uid(311), 'gross_text', 'Synthetic gross', 'grossed_by_membership_id', pg_temp.m('a500')));
SELECT pg_temp.ins('anatomic.blocks', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', r.t, 'centre_id', r.c, 'case_id', pg_temp.uid(r.cs), 'part_id', pg_temp.uid(r.p), 'seq', 1, 'label', r.l))
  FROM (VALUES (321, pg_temp.ta(), pg_temp.id('00000000a201'), 301, 311, 'H26-1-A1'), (322, pg_temp.ta(), pg_temp.id('00000000a202'), 302, 312, 'H26-3-A1'), (323, pg_temp.tb(), pg_temp.id('00000000b201'), 303, 313, 'H26-9-A1'), (324, pg_temp.ta(), pg_temp.id('00000000a201'), 304, 314, 'H26-2-A1')) r(n, t, c, cs, p, l);
SELECT pg_temp.ins('anatomic.stain_orders', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', pg_temp.ta(), 'centre_id', pg_temp.id('00000000a201'), 'case_id', pg_temp.uid(r.cs), 'stain_id', pg_temp.uid(351), 'stain_code', 'HE', 'stain_kind', 'special',
    'block_id', pg_temp.uid(r.b), 'requested_at', now(), 'requested_by_membership_id', pg_temp.m('a500'))) FROM (VALUES (341, 301, 321), (342, 304, 324)) r(n, cs, b);
SELECT pg_temp.ins('anatomic.slides', jsonb_build_object('id', pg_temp.uid(331), 'tenant_id', pg_temp.ta(), 'centre_id', pg_temp.id('00000000a201'), 'case_id', pg_temp.uid(301), 'part_id', pg_temp.uid(311), 'block_id', pg_temp.uid(321), 'seq', 1, 'label', 'H26-1-A1-S1',
    'stain_id', pg_temp.uid(351), 'stain_code', 'HE'));
SELECT pg_temp.ins('anatomic.object_movements', jsonb_build_object('id', pg_temp.uid(421), 'tenant_id', pg_temp.ta(), 'centre_id', pg_temp.id('00000000a201'), 'case_id', pg_temp.uid(301), 'object_kind', 'block', 'object_id', pg_temp.uid(321),
    'movement', 'stored', 'from_location_status', 'in_lab', 'to_location_status', 'stored', 'location_text', 'Shelf 1'));
SELECT pg_temp.ins('anatomic.images', jsonb_build_object('id', pg_temp.uid(361), 'tenant_id', pg_temp.ta(), 'centre_id', pg_temp.id('00000000a201'), 'case_id', pg_temp.uid(301), 'kind', 'gross',
    'object_path', pg_temp.ta()::text || '/2026/11/' || pg_temp.uid(361)::text || '.jpg', 'scan_state', 'pending'));
SELECT pg_temp.ins('anatomic.report_drafts', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', pg_temp.ta(), 'centre_id', pg_temp.id('00000000a201'), 'case_id', pg_temp.uid(r.cs), 'kind', 'initial') || r.x)
  FROM (VALUES (371, 301, jsonb_build_object('status', 'open')), (372, 304, jsonb_build_object('status', 'consumed', 'consumed_at', now(), 'consumed_version_no', 1))) r(n, cs, x);
SELECT pg_temp.ins('anatomic.addenda', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', pg_temp.ta(), 'centre_id', pg_temp.id('00000000a201'), 'case_id', pg_temp.uid(301), 'seq', r.s, 'kind', 'other', 'text', 'Synthetic addendum') || r.x)
  FROM (VALUES (381, 1, jsonb_build_object('status', 'draft')), (382, 2, jsonb_build_object('status', 'signed', 'signed_at', now(), 'signed_by_membership_id', pg_temp.m('a500'), 'report_version_no', 2))) r(n, s, x);
SELECT pg_temp.ins('anatomic.report_versions', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', r.t, 'centre_id', r.c, 'case_id', pg_temp.uid(r.cs), 'version_no', 1, 'version_kind', 'original', 'gross_text', 'Synthetic', 'impression_text', 'Synthetic impression',
    'signed_by_membership_id', r.mm, 'signed_at', now()))
  FROM (VALUES (391, pg_temp.ta(), pg_temp.id('00000000a201'), 301, pg_temp.m('a500')), (392, pg_temp.ta(), pg_temp.id('00000000a202'), 302, pg_temp.m('a500')), (393, pg_temp.tb(), pg_temp.id('00000000b201'), 303, pg_temp.m('b500'))) r(n, t, c, cs, mm);
SELECT pg_temp.ins('anatomic.item_submissions', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', r.t, 'centre_id', r.c, 'case_id', pg_temp.uid(r.cs), 'case_item_id', pg_temp.uid(r.ci), 'item_version_no', 1, 'report_version_id', pg_temp.uid(r.rv),
    'idempotency_key', 'anatomic:' || pg_temp.uid(r.ci)::text || ':1', 'lab_result_id', pg_temp.uid(7000 + r.n), 'lab_version_no', 1, 'lab_status', 'resulted', 'replayed', false, 'submitted_at', now()))
  FROM (VALUES (601, pg_temp.ta(), pg_temp.id('00000000a201'), 301, 401, 391), (602, pg_temp.ta(), pg_temp.id('00000000a202'), 302, 403, 392), (603, pg_temp.tb(), pg_temp.id('00000000b201'), 303, 404, 393)) r(n, t, c, cs, ci, rv);
SELECT pg_temp.ins('anatomic.molecular_results', jsonb_build_object('id', pg_temp.uid(451), 'tenant_id', pg_temp.ta(), 'centre_id', pg_temp.id('00000000a201'), 'case_id', pg_temp.uid(301), 'assay_id', pg_temp.uid(441), 'assay_code', 'SYN_PCR_A', 'target_id', pg_temp.uid(442),
    'target_code', 'T1', 'result_value_id', pg_temp.uid(443), 'result_code', 'detected'));
SELECT pg_temp.ins('anatomic.batches', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', r.t, 'batch_no', 'B-1', 'assay_id', pg_temp.uid(r.a))) FROM (VALUES (461, pg_temp.ta(), 441), (462, pg_temp.tb(), 444)) r(n, t, a);
SELECT pg_temp.ins('anatomic.batch_members', jsonb_build_object('id', pg_temp.uid(471), 'tenant_id', pg_temp.ta(), 'batch_id', pg_temp.uid(461), 'case_id', pg_temp.uid(301), 'position', 1));
SET LOCAL session_replication_role = origin;      -- back to normal: triggers and FKs are live for every assertion below

SELECT is((SELECT count(*)::int FROM anatomic.g_cs_cancel_reasons), 5, 'C11 check 8: 5 global cancel reasons seeded (§2.2)');
SELECT is((SELECT count(*)::int FROM anatomic.cases), 4, 'C11 check 8: 4 case fixtures (superuser sees all tenants)');
SELECT is((SELECT count(*)::int FROM anatomic.item_submissions), 3, 'C11 check 8: 3 item_submission fixtures');
SELECT is((SELECT count(*)::int FROM anatomic.synoptic_templates), 2, 'C11 check 8: 2 synoptic template fixtures (published + draft)');

-- ===================================================================================================================================== read-only checks first
-- C11 check 9: tenant isolation (AC-0B-3.1 / 3.2 / 3.3 / 3.5; §11 items 1, 3)
SELECT is(pg_temp.sa('SELECT 1 FROM ' || q || ' WHERE tenant_id = ' || pg_temp.q(pg_temp.tb()), 'n'), 'n=0', 'C11 check 9 / AC-0B-3.1: tenant A system actor sees 0 tenant B rows of ' || q) FROM tt;
SELECT is(pg_temp.ua(pg_temp.m('a500'), 'SELECT 1 FROM ' || q || ' WHERE tenant_id = ' || pg_temp.q(pg_temp.tb()), 'n'), 'n=0', 'C11 check 9 / AC-0B-3.1: tenant A staff user sees 0 tenant B rows of ' || q) FROM tt;
SELECT is(pg_temp.sb('SELECT 1 FROM ' || q || ' WHERE tenant_id = ' || pg_temp.q(pg_temp.ta()), 'n'), 'n=0', 'C11 check 9 / AC-0B-3.1: tenant B system actor sees 0 tenant A rows of ' || q) FROM tt;
SELECT is(pg_temp.sa('SELECT 1 FROM anatomic.cases', 'n'), 'n=3', 'C11 check 9: tenant A sees exactly its 3 cases');
SELECT is(pg_temp.sb('SELECT 1 FROM anatomic.cases', 'n'), 'n=1', 'C11 check 9: tenant B sees exactly its case');
SELECT is(pg_temp.sb('SELECT 1 FROM anatomic.report_versions', 'n'), 'n=1', 'C11 check 9: tenant B sees exactly its report version');
SELECT is(pg_temp.sb('SELECT 1 FROM anatomic.batches', 'n'), 'n=1', 'C11 check 9: tenant B sees exactly its batch (batches share batch_no B-1 across tenants: unique per tenant)');
SELECT matches(pg_temp.sa('INSERT INTO anatomic.stains (id, tenant_id, code, display, kind, created_by, updated_by) VALUES (' || pg_temp.q(pg_temp.uid(901)) || ', ' || pg_temp.q(pg_temp.tb()) || ', ''SYN_X'', ''X'', ''special'', ' || pg_temp.q(pg_temp.sys()) || ', ' || pg_temp.q(pg_temp.sys()) || ')'),
  '^E42501\|', 'C11 check 9 / AC-0B-3.2: tenant A claims cannot INSERT a tenant B row (RLS WITH CHECK)');
SELECT matches(pg_temp.sa('INSERT INTO anatomic.case_transitions (id, tenant_id, centre_id, case_id, to_status, created_by) VALUES (' || pg_temp.q(pg_temp.uid(902)) || ', ' || pg_temp.q(pg_temp.tb()) || ', ' || pg_temp.q(pg_temp.id('00000000b201'))
  || ', ' || pg_temp.q(pg_temp.uid(303)) || ', ''received'', ' || pg_temp.q(pg_temp.sys()) || ')'), '^E42501\|', 'C11 check 9 / AC-0B-3.2: tenant A claims cannot INSERT a tenant B centre-scoped row');
SELECT is(pg_temp.sa('UPDATE anatomic.settings SET max_images_per_case = 9 WHERE tenant_id = ' || pg_temp.q(pg_temp.tb())), 'n=0', 'C11 check 9 / AC-0B-3.3: tenant A updates 0 tenant B settings');
SELECT is(pg_temp.sa('UPDATE anatomic.cases SET updated_by = updated_by WHERE tenant_id = ' || pg_temp.q(pg_temp.tb())), 'n=0', 'C11 check 9 / AC-0B-3.3: tenant A updates 0 tenant B cases');
SELECT is(pg_temp.sa('UPDATE anatomic.accession_counters SET last_value = last_value + 1 WHERE tenant_id = ' || pg_temp.q(pg_temp.tb())), 'n=0', 'C11 check 9 / AC-0B-3.3: tenant A cannot bump tenant B''s accession counter');
SELECT is(pg_temp.sa('SELECT 1 FROM anatomic.g_cs_cancel_reasons', 'n'), 'n=5', 'C11 check 9 / AC-0B-3.5: the global coded set is readable by every tenant');
SELECT is(pg_temp.sb('SELECT 1 FROM anatomic.g_cs_cancel_reasons', 'n'), 'n=5', 'C11 check 9: global cancel reasons readable by tenant B');

-- C11 check 10: centre isolation (AC-0B-3.4; §1 centre decision, §11 item 2): collection centre only; hub staff (all_centres) and the system actor see every centre
SELECT is(pg_temp.ua(pg_temp.m('a50a'), 'SELECT 1 FROM ' || q || ' WHERE centre_id = ' || pg_temp.q(pg_temp.id('00000000a202')), 'n'), 'n=0', 'C11 check 10 / AC-0B-3.4: centre-A1 staff sees 0 centre A2 rows of ' || q) FROM tc;
SELECT is(pg_temp.ua(pg_temp.m('a50a'), 'SELECT 1 FROM ' || q || ' WHERE centre_id = ' || pg_temp.q(pg_temp.id('00000000a201')), 'n') ~ '^n=[1-9]', true, 'C11 check 10 / AC-0B-3.4: centre-A1 staff sees its own centre rows of ' || q) FROM tc;
SELECT is(pg_temp.ua(pg_temp.m('a50a'), 'SELECT 1 FROM anatomic.cases', 'n'), 'n=2', 'C11 check 10: centre-A1 staff sees only the 2 centre A1 cases (301, 304)');
SELECT is(pg_temp.ua(pg_temp.m('a50a'), 'SELECT 1 FROM anatomic.parts', 'n'), 'n=2', 'C11 check 10: child rows follow their case: 2 centre A1 parts');
SELECT is(pg_temp.ua(pg_temp.m('a500'), 'SELECT 1 FROM anatomic.cases', 'n'), 'n=3', 'C11 check 10: an all-centres (hub) user sees all three tenant A cases');
SELECT is(pg_temp.sa('SELECT 1 FROM anatomic.cases', 'n'), 'n=3', 'C11 check 10: the system actor (has_all_centres) sees all tenant A cases');
SELECT is(pg_temp.ua(pg_temp.m('a50a'), 'SELECT 1 FROM anatomic.batches', 'n'), 'n=1', 'C11 check 10 / §7: batches are tenant-scoped (a lab run mixes centres): restricted staff still reads the batch');
SELECT is(pg_temp.ua(pg_temp.m('a50a'), 'SELECT 1 FROM anatomic.stains', 'n'), 'n=1', 'C11 check 10: configuration tables are tenant-scoped (no centre predicate)');
SELECT is(pg_temp.ua(pg_temp.m('a50a'), 'UPDATE anatomic.cases SET updated_by = updated_by WHERE centre_id = ' || pg_temp.q(pg_temp.id('00000000a202'))), 'n=0', 'C11 check 10 / AC-0B-3.4: centre-A1 staff updates 0 centre A2 cases');
SELECT matches(pg_temp.ua(pg_temp.m('a50a'), 'INSERT INTO anatomic.parts (id, tenant_id, centre_id, case_id, letter, letter_seq, created_by, updated_by) VALUES (' || pg_temp.q(pg_temp.uid(903)) || ', ' || pg_temp.q(pg_temp.ta()) || ', '
  || pg_temp.q(pg_temp.id('00000000a202')) || ', ' || pg_temp.q(pg_temp.uid(302)) || ', ''B'', 2, ' || pg_temp.q(pg_temp.sys()) || ', ' || pg_temp.q(pg_temp.sys()) || ')'), '^E42501\|', 'C11 check 10 / §11 item 2: centre-A1 staff cannot add a part to a centre A2 case (policy)');

-- C11 check 11: non-staff actors (AC-0B-3.6), device actors and fail-closed without claims (AC-0B-3.7)
SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), k.t, pg_temp.m('a500')), 'SELECT 1 FROM ' || tt.q, 'n'), 'n=0', 'C11 check 11 / AC-0B-3.6: ' || k.t || ' actor sees 0 rows of ' || tt.q) FROM tt CROSS JOIN (VALUES ('partner'),('portal'),('patient'),('device')) k(t);
SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), 'portal', pg_temp.m('a500')), 'UPDATE anatomic.settings SET max_images_per_case = 5'), 'n=0', 'C11 check 11 / AC-0B-3.6: a portal actor updates 0 settings');
SELECT matches(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), 'partner', pg_temp.m('a500')), 'INSERT INTO anatomic.accession_counters (tenant_id, series_key, year_ad, created_by, updated_by) VALUES (' || pg_temp.q(pg_temp.ta()) || ', ''cytology'', 2026, '
  || pg_temp.q(pg_temp.sys()) || ', ' || pg_temp.q(pg_temp.sys()) || ')'), '^E42501\|', 'C11 check 11 / AC-0B-3.6: a partner actor cannot INSERT');
SELECT is(pg_temp.x('lims_api', NULL, 'SELECT 1 FROM ' || q, 'n'), 'n=0', 'C11 check 11 / AC-0B-3.7: no claims -> lims_api sees 0 rows of ' || q) FROM tt;
SELECT is(pg_temp.x('lims_api', '{}'::jsonb, 'SELECT 1 FROM ' || q, 'n'), 'n=0', 'C11 check 11 / AC-0B-3.7: empty claims -> 0 rows of ' || q) FROM tt;
SELECT is(pg_temp.x('lims_api', NULL, 'SELECT 1 FROM anatomic.v_pub_report_content', 'n'), 'n=0', 'C11 check 11 / AC-0B-3.7: no claims -> the invoker view returns 0 rows');

-- C11 check 12: append-only tables (AC-0B-4.1 / 4.2 / 4.3; §6 immutability summary, §11 items 1, 4): INSERT + SELECT only; no DELETE grant anywhere
SELECT matches(pg_temp.sa('UPDATE ' || q || ' SET created_by = created_by'), '^E42501\|', 'C11 check 12 / AC-0B-4.1 / 4.3: even the system actor has no UPDATE grant on ' || q)
  FROM (VALUES ('anatomic.report_versions'),('anatomic.item_submissions'),('anatomic.case_transitions'),('anatomic.object_movements')) v(q);
SELECT matches(pg_temp.sa('DELETE FROM ' || tt.q), '^E42501\|', 'C11 check 12 / AC-0B-4.2: no DELETE grant on ' || tt.q) FROM tt;
SELECT matches(pg_temp.sa('DELETE FROM anatomic.accession_counters WHERE tenant_id = ' || pg_temp.q(pg_temp.ta())), '^E42501\|', 'C11 check 12 / P-18(a): the class E counter is updatable but never deleted');
SELECT matches(pg_temp.sa('INSERT INTO anatomic.g_cs_cancel_reasons (id, code, display) VALUES (' || pg_temp.q(pg_temp.uid(904)) || ', ''x_test'', ''X'')'), '^E42501\|', 'C11 check 12: the global coded set is not writable by lims_app');
SELECT matches(pg_temp.sa('UPDATE anatomic.g_cs_cancel_reasons SET is_active = false'), '^E42501\|', 'C11 check 12: the global coded set is not updatable by lims_app');
SELECT is(pg_temp.sa('INSERT INTO anatomic.case_transitions (id, tenant_id, centre_id, case_id, from_status, to_status, created_by) VALUES (' || pg_temp.q(pg_temp.uid(905)) || ', ' || pg_temp.q(pg_temp.ta()) || ', ' || pg_temp.q(pg_temp.id('00000000a201'))
  || ', ' || pg_temp.q(pg_temp.uid(301)) || ', ''received'', ''accessioned'', ' || pg_temp.q(pg_temp.sys()) || ')'), 'n=1', 'C11 check 12: an append-only table accepts INSERT');
SELECT matches(pg_temp.sa('INSERT INTO anatomic.case_transitions (id, tenant_id, centre_id, case_id, to_status, created_by) VALUES (' || pg_temp.q(pg_temp.uid(906)) || ', ' || pg_temp.q(pg_temp.ta()) || ', ' || pg_temp.q(pg_temp.id('00000000a201'))
  || ', ' || pg_temp.q(pg_temp.uid(301)) || ', ''archived'', ' || pg_temp.q(pg_temp.sys()) || ')'), '^E23514\|', 'C11 check 12 / §2.1: to_status outside the case status list rejected (case_transitions__to__ck)');

-- ===================================================================================================================================== state-changing checks
-- C11 check 13: guard triggers (§6; §11 item 4): SQLSTATE P0001 + message immutable_row
SELECT matches(pg_temp.sa('UPDATE anatomic.cases SET accession_no = ''H26-99'' WHERE id = ' || pg_temp.q(pg_temp.uid(301))), '^EP0001\|immutable_row', 'C11 check 13 / §11 item 4 / AC-0B-4.1: cases.accession_no is write-once');
SELECT matches(pg_temp.sa('UPDATE anatomic.cases SET centre_id = ' || pg_temp.q(pg_temp.id('00000000a202')) || ' WHERE id = ' || pg_temp.q(pg_temp.uid(301))), '^EP0001\|immutable_row', 'C11 check 13: cases.centre_id never changes (child visibility cannot diverge)');
SELECT matches(pg_temp.sa('UPDATE anatomic.cases SET case_kind = ''cytology'' WHERE id = ' || pg_temp.q(pg_temp.uid(301))), '^EP0001\|immutable_row', 'C11 check 13: cases.case_kind never changes');
SELECT matches(pg_temp.sa('UPDATE anatomic.cases SET order_id = ' || pg_temp.q(pg_temp.uid(1)) || ' WHERE id = ' || pg_temp.q(pg_temp.uid(301))), '^EP0001\|immutable_row', 'C11 check 13: cases.order_id never changes');
SELECT is(pg_temp.sa('UPDATE anatomic.cases SET priority = ''urgent'' WHERE id = ' || pg_temp.q(pg_temp.uid(301))), 'n=1', 'C11 check 13: a mutable case column (priority) updates');
SELECT is(pg_temp.sa('UPDATE anatomic.cases SET status = ''cancelled'', cancelled_at = now(), cancel_reason_code = ''other'' WHERE id = ' || pg_temp.q(pg_temp.uid(304))), 'n=1', 'C11 check 13: accessioned -> cancelled is allowed');
SELECT matches(pg_temp.sa('UPDATE anatomic.cases SET priority = ''urgent'' WHERE id = ' || pg_temp.q(pg_temp.uid(304))), '^EP0001\|immutable_row', 'C11 check 13: a cancelled case is frozen (guard_case)');
SELECT matches(pg_temp.sa('UPDATE anatomic.blocks SET label = ''H26-1-A9'' WHERE id = ' || pg_temp.q(pg_temp.uid(321))), '^EP0001\|', 'C11 check 13 / §11 item 4: blocks.label is immutable (enforce_mutable_columns)');
SELECT is(pg_temp.sa('UPDATE anatomic.blocks SET location_status = ''stored'', location_text = ''Shelf 2'' WHERE id = ' || pg_temp.q(pg_temp.uid(321))), 'n=1', 'C11 check 13: blocks.location_status / location_text are mutable');
SELECT matches(pg_temp.sa('UPDATE anatomic.slides SET label = ''X1'' WHERE id = ' || pg_temp.q(pg_temp.uid(331))), '^EP0001\|', 'C11 check 13: slides.label is immutable');
SELECT is(pg_temp.sa('UPDATE anatomic.slides SET status = ''ready'', ready_at = now() WHERE id = ' || pg_temp.q(pg_temp.uid(331))), 'n=1', 'C11 check 13: slides.status pending_stain -> ready (with ready_at) updates');
SELECT matches(pg_temp.sa('UPDATE anatomic.images SET sha256 = repeat(''a'', 64) WHERE id = ' || pg_temp.q(pg_temp.uid(361))), '^EP0001\|', 'C11 check 13: images.sha256 is written once at insert (not in the mutable list)');
SELECT matches(pg_temp.sa('UPDATE anatomic.images SET object_path = object_path || ''x'' WHERE id = ' || pg_temp.q(pg_temp.uid(361))), '^EP0001\|', 'C11 check 13: images.object_path is immutable');
SELECT is(pg_temp.sa('UPDATE anatomic.images SET caption = ''Synthetic caption'' WHERE id = ' || pg_temp.q(pg_temp.uid(361))), 'n=1', 'C11 check 13: images.caption is mutable');
SELECT matches(pg_temp.sa('UPDATE anatomic.synoptic_templates SET definition = ''{"x":1}''::jsonb WHERE id = ' || pg_temp.q(pg_temp.uid(481))), '^EP0001\|immutable_row', 'C11 check 13 / §11 item 4: a published synoptic template definition is frozen');
SELECT matches(pg_temp.sa('UPDATE anatomic.synoptic_templates SET title = ''Other'' WHERE id = ' || pg_temp.q(pg_temp.uid(481))), '^EP0001\|immutable_row', 'C11 check 13: a published synoptic template title is frozen');
SELECT is(pg_temp.sa('UPDATE anatomic.synoptic_templates SET status = ''retired'', retired_at = now() WHERE id = ' || pg_temp.q(pg_temp.uid(481))), 'n=1', 'C11 check 13: published -> retired (retirement columns only) is allowed');
SELECT matches(pg_temp.sa('UPDATE anatomic.synoptic_templates SET status = ''published'', published_at = now() WHERE id = ' || pg_temp.q(pg_temp.uid(481))), '^EP0001\|immutable_row', 'C11 check 13: retired -> published is not a transition');
SELECT is(pg_temp.sa('UPDATE anatomic.synoptic_templates SET definition = ''{"x":1}''::jsonb WHERE id = ' || pg_temp.q(pg_temp.uid(482))), 'n=1', 'C11 check 13: a draft synoptic template definition is editable');
SELECT matches(pg_temp.sa('UPDATE anatomic.addenda SET text = ''Changed'' WHERE id = ' || pg_temp.q(pg_temp.uid(382))), '^EP0001\|immutable_row', 'C11 check 13 / §11 item 4: a signed addendum is immutable');
SELECT is(pg_temp.sa('UPDATE anatomic.addenda SET text = ''Changed draft'' WHERE id = ' || pg_temp.q(pg_temp.uid(381))), 'n=1', 'C11 check 13: a draft addendum is editable');
SELECT matches(pg_temp.sa('UPDATE anatomic.report_drafts SET comment_text = ''x'' WHERE id = ' || pg_temp.q(pg_temp.uid(372))), '^EP0001\|immutable_row', 'C11 check 13: a consumed report draft is frozen');
SELECT matches(pg_temp.sa('UPDATE anatomic.report_drafts SET kind = ''revision'' WHERE id = ' || pg_temp.q(pg_temp.uid(371))), '^EP0001\|immutable_row', 'C11 check 13: report_drafts.kind never changes');
SELECT is(pg_temp.sa('UPDATE anatomic.report_drafts SET comment_text = ''Synthetic comment'' WHERE id = ' || pg_temp.q(pg_temp.uid(371))), 'n=1', 'C11 check 13: an open report draft is editable');

-- C11 check 14: CHECK constraints (§11 item 7) and same-case composite FKs (AC-0B-3.5; §11 item 3). Insert helpers use the centre-A1 case 301 unless stated.
SELECT matches(pg_temp.sa('INSERT INTO anatomic.object_movements (id, tenant_id, centre_id, case_id, object_kind, object_id, movement, from_location_status, to_location_status, destination_text, created_by) VALUES (' || pg_temp.q(pg_temp.uid(911)) || ', '
  || pg_temp.q(pg_temp.ta()) || ', ' || pg_temp.q(pg_temp.id('00000000a201')) || ', ' || pg_temp.q(pg_temp.uid(301)) || ', ''block'', ' || pg_temp.q(pg_temp.uid(321)) || ', ''sent_out'', ''stored'', ''sent_out'', ''External lab'', ' || pg_temp.q(pg_temp.sys()) || ')'),
  '^E23514\|.*object_movements__reason_req__ck', 'C11 check 14 / §11 item 7: sent_out without reason_code rejected (object_movements__reason_req__ck)');
SELECT matches(pg_temp.sa('INSERT INTO anatomic.specimen_links (id, tenant_id, centre_id, specimen_id, last_seq, last_status, created_by, updated_by) VALUES (' || pg_temp.q(pg_temp.uid(912)) || ', ' || pg_temp.q(pg_temp.ta()) || ', ' || pg_temp.q(pg_temp.id('00000000a201'))
  || ', ' || pg_temp.q(pg_temp.uid(8299)) || ', 1, ''received'', ' || pg_temp.q(pg_temp.sys()) || ', ' || pg_temp.q(pg_temp.sys()) || ')'), '^E23502\|', 'C11 check 14 / §11 item 7: specimen_links without link_kind rejected (NOT NULL, no default)');
SELECT matches(pg_temp.sa('UPDATE anatomic.images SET state = ''ready'' WHERE id = ' || pg_temp.q(pg_temp.uid(361))), '^E23514\|.*images__', 'C11 check 14 / §11 item 7: state ready with scan_state pending rejected (images__scan__ck / images__ready__ck)');
SELECT matches(pg_temp.sa('INSERT INTO anatomic.stain_orders (id, tenant_id, centre_id, case_id, stain_id, stain_code, stain_kind, block_id, requested_at, requested_by_membership_id, created_by, updated_by) VALUES (' || pg_temp.q(pg_temp.uid(913)) || ', '
  || pg_temp.q(pg_temp.ta()) || ', ' || pg_temp.q(pg_temp.id('00000000a201')) || ', ' || pg_temp.q(pg_temp.uid(301)) || ', ' || pg_temp.q(pg_temp.uid(351)) || ', ''HE'', ''routine'', ' || pg_temp.q(pg_temp.uid(321)) || ', now(), ' || pg_temp.q(pg_temp.m('a500')) || ', '
  || pg_temp.q(pg_temp.sys()) || ', ' || pg_temp.q(pg_temp.sys()) || ')'), '^E23514\|.*stain_orders__kind__ck', 'C11 check 14 / §11 item 7: stain_kind routine rejected (stain_orders__kind__ck)');
SELECT matches(pg_temp.sa('INSERT INTO anatomic.stain_orders (id, tenant_id, centre_id, case_id, stain_id, stain_code, stain_kind, part_id, requested_at, requested_by_membership_id, created_by, updated_by) VALUES (' || pg_temp.q(pg_temp.uid(914)) || ', '
  || pg_temp.q(pg_temp.ta()) || ', ' || pg_temp.q(pg_temp.id('00000000a201')) || ', ' || pg_temp.q(pg_temp.uid(301)) || ', ' || pg_temp.q(pg_temp.uid(351)) || ', ''IHC_ER'', ''ihc'', ' || pg_temp.q(pg_temp.uid(311)) || ', now(), ' || pg_temp.q(pg_temp.m('a500')) || ', '
  || pg_temp.q(pg_temp.sys()) || ', ' || pg_temp.q(pg_temp.sys()) || ')'), '^E23514\|.*stain_orders__ihc_block__ck', 'C11 check 14: an IHC order needs a block (stain_orders__ihc_block__ck)');
SELECT matches(pg_temp.sa('UPDATE anatomic.cases SET status = ''accessioned'' WHERE id = ' || pg_temp.q(pg_temp.uid(302))), '^E23514\|.*cases__accession__ck', 'C11 check 14: accessioned needs an accession number (cases__accession__ck)');
SELECT matches(pg_temp.sa('UPDATE anatomic.images SET kind = ''xray'' WHERE id = ' || pg_temp.q(pg_temp.uid(361))), '^E23514\|.*images__kind__ck', 'C11 check 14: images.kind outside gross / microscopy / other rejected');
SELECT matches(pg_temp.sa('INSERT INTO anatomic.images (id, tenant_id, centre_id, case_id, kind, object_path, scan_state, created_by, updated_by) VALUES (' || pg_temp.q(pg_temp.uid(915)) || ', ' || pg_temp.q(pg_temp.ta()) || ', ' || pg_temp.q(pg_temp.id('00000000a201')) || ', '
  || pg_temp.q(pg_temp.uid(301)) || ', ''gross'', ' || quote_literal(pg_temp.tb()::text || '/2026/11/' || pg_temp.uid(915)::text || '.jpg') || ', ''pending'', ' || pg_temp.q(pg_temp.sys()) || ', ' || pg_temp.q(pg_temp.sys()) || ')'), '^E23514\|.*images__path__ck',
  'C11 check 14 / AC-0B-3.5: an object path under another tenant''s prefix is rejected (images__path__ck)');
SELECT matches(pg_temp.sa('INSERT INTO anatomic.item_submissions (id, tenant_id, centre_id, case_id, case_item_id, item_version_no, report_version_id, idempotency_key, lab_result_id, lab_version_no, lab_status, replayed, submitted_at, created_by) VALUES ('
  || pg_temp.q(pg_temp.uid(916)) || ', ' || pg_temp.q(pg_temp.ta()) || ', ' || pg_temp.q(pg_temp.id('00000000a201')) || ', ' || pg_temp.q(pg_temp.uid(301)) || ', ' || pg_temp.q(pg_temp.uid(401)) || ', 2, ' || pg_temp.q(pg_temp.uid(391))
  || ', ''anatomic:wrong:2'', ' || pg_temp.q(pg_temp.uid(7916)) || ', 1, ''resulted'', false, now(), ' || pg_temp.q(pg_temp.sys()) || ')'), '^E23514\|.*item_submissions__key__ck', 'C11 check 14: idempotency_key must equal anatomic:<case_item_id>:<item_version_no>');
SELECT matches(pg_temp.sa('UPDATE anatomic.settings SET max_images_per_case = 999 WHERE tenant_id = ' || pg_temp.q(pg_temp.ta())), '^E23514\|.*settings__max_images__ck', 'C11 check 14: settings ranges (max_images_per_case 1..200)');
SELECT matches(pg_temp.sa('INSERT INTO anatomic.settings (id, tenant_id, created_by, updated_by) VALUES (' || pg_temp.q(pg_temp.uid(917)) || ', ' || pg_temp.q(pg_temp.ta()) || ', ' || pg_temp.q(pg_temp.sys()) || ', ' || pg_temp.q(pg_temp.sys()) || ')'), '^E23505\|', 'C11 check 14: one settings row per tenant (settings__tenant_id__uq)');
SELECT matches(pg_temp.sa('INSERT INTO anatomic.accession_counters (tenant_id, series_key, year_ad, created_by, updated_by) VALUES (' || pg_temp.q(pg_temp.ta()) || ', ''histology'', 2026, ' || pg_temp.q(pg_temp.sys()) || ', ' || pg_temp.q(pg_temp.sys()) || ')'), '^E23505\|', 'C11 check 14: one counter row per (tenant, series, year) (PK)');
SELECT matches(pg_temp.sa('INSERT INTO anatomic.accession_counters (tenant_id, series_key, year_ad, created_by, updated_by) VALUES (' || pg_temp.q(pg_temp.ta()) || ', ''surgical'', 2026, ' || pg_temp.q(pg_temp.sys()) || ', ' || pg_temp.q(pg_temp.sys()) || ')'), '^E23514\|', 'C11 check 14: series_key outside histology / cytology / ihc / molecular / batch rejected');
SELECT matches(pg_temp.sa('INSERT INTO anatomic.batch_members (id, tenant_id, batch_id, case_id, position, created_by, updated_by) VALUES (' || pg_temp.q(pg_temp.uid(918)) || ', ' || pg_temp.q(pg_temp.ta()) || ', ' || pg_temp.q(pg_temp.uid(461)) || ', ' || pg_temp.q(pg_temp.uid(302))
  || ', 1, ' || pg_temp.q(pg_temp.sys()) || ', ' || pg_temp.q(pg_temp.sys()) || ')'), '^E23505\|', 'C11 check 14: one active member per batch position (batch_members__tenant_id_batch_position__p_uq)');
SELECT matches(pg_temp.sa('INSERT INTO anatomic.molecular_results (id, tenant_id, centre_id, case_id, assay_id, assay_code, target_id, target_code, result_value_id, result_code, created_by, updated_by) VALUES (' || pg_temp.q(pg_temp.uid(919)) || ', ' || pg_temp.q(pg_temp.ta()) || ', '
  || pg_temp.q(pg_temp.id('00000000a201')) || ', ' || pg_temp.q(pg_temp.uid(301)) || ', ' || pg_temp.q(pg_temp.uid(441)) || ', ''SYN_PCR_A'', ' || pg_temp.q(pg_temp.uid(442)) || ', ''T1'', ' || pg_temp.q(pg_temp.uid(443)) || ', ''detected'', ' || pg_temp.q(pg_temp.sys()) || ', ' || pg_temp.q(pg_temp.sys()) || ')'),
  '^E23505\|', 'C11 check 14: one active molecular result per (case, target) (molecular_results__tenant_id_case_target__p_uq)');
-- composite FK probes (§11 item 3): every child reference must stay inside the same tenant AND the same case
SELECT matches(pg_temp.sa('INSERT INTO anatomic.parts (id, tenant_id, centre_id, case_id, letter, letter_seq, created_by, updated_by) VALUES (' || pg_temp.q(pg_temp.uid(921)) || ', ' || pg_temp.q(pg_temp.ta()) || ', ' || pg_temp.q(pg_temp.id('00000000b201'))
  || ', ' || pg_temp.q(pg_temp.uid(303)) || ', ''B'', 2, ' || pg_temp.q(pg_temp.sys()) || ', ' || pg_temp.q(pg_temp.sys()) || ')'), '^E23503\|', 'C11 check 14 / AC-0B-3.5 / §11 item 3: a tenant A part cannot reference tenant B''s case (composite FK)');
SELECT matches(pg_temp.sa('INSERT INTO anatomic.parts (id, tenant_id, centre_id, case_id, letter, letter_seq, created_by, updated_by) VALUES (' || pg_temp.q(pg_temp.uid(922)) || ', ' || pg_temp.q(pg_temp.ta()) || ', ' || pg_temp.q(pg_temp.id('00000000a202'))
  || ', ' || pg_temp.q(pg_temp.uid(301)) || ', ''B'', 2, ' || pg_temp.q(pg_temp.sys()) || ', ' || pg_temp.q(pg_temp.sys()) || ')'), '^E23503\|', 'C11 check 14 / §1: a denormalised centre_id that differs from the case''s centre is rejected (cases (tenant_id, id, centre_id) FK)');
SELECT matches(pg_temp.sa('INSERT INTO anatomic.slides (id, tenant_id, centre_id, case_id, part_id, block_id, seq, label, stain_id, stain_code, created_by, updated_by) VALUES (' || pg_temp.q(pg_temp.uid(923)) || ', ' || pg_temp.q(pg_temp.ta()) || ', '
  || pg_temp.q(pg_temp.id('00000000a201')) || ', ' || pg_temp.q(pg_temp.uid(301)) || ', ' || pg_temp.q(pg_temp.uid(311)) || ', ' || pg_temp.q(pg_temp.uid(324)) || ', 5, ''H26-1-A1-S5'', ' || pg_temp.q(pg_temp.uid(351)) || ', ''HE'', '
  || pg_temp.q(pg_temp.sys()) || ', ' || pg_temp.q(pg_temp.sys()) || ')'), '^E23503\|', 'C11 check 14 / §11 item 3: slides.block_id from another case of the same tenant -> FK violation (tenant_id, block_id, case_id)');
SELECT matches(pg_temp.sa('INSERT INTO anatomic.slides (id, tenant_id, centre_id, case_id, part_id, block_id, seq, label, stain_id, stain_code, stain_order_id, created_by, updated_by) VALUES (' || pg_temp.q(pg_temp.uid(924)) || ', ' || pg_temp.q(pg_temp.ta()) || ', '
  || pg_temp.q(pg_temp.id('00000000a201')) || ', ' || pg_temp.q(pg_temp.uid(301)) || ', ' || pg_temp.q(pg_temp.uid(311)) || ', ' || pg_temp.q(pg_temp.uid(321)) || ', 6, ''H26-1-A1-S6'', ' || pg_temp.q(pg_temp.uid(351)) || ', ''HE'', ' || pg_temp.q(pg_temp.uid(342)) || ', '
  || pg_temp.q(pg_temp.sys()) || ', ' || pg_temp.q(pg_temp.sys()) || ')'), '^E23503\|', 'C11 check 14 / §11 item 3: slides.stain_order_id from another case -> FK violation');
SELECT matches(pg_temp.sa('INSERT INTO anatomic.stain_orders (id, tenant_id, centre_id, case_id, stain_id, stain_code, stain_kind, block_id, addon_case_item_id, requested_at, requested_by_membership_id, created_by, updated_by) VALUES (' || pg_temp.q(pg_temp.uid(925)) || ', '
  || pg_temp.q(pg_temp.ta()) || ', ' || pg_temp.q(pg_temp.id('00000000a201')) || ', ' || pg_temp.q(pg_temp.uid(301)) || ', ' || pg_temp.q(pg_temp.uid(351)) || ', ''SYN_SPECIAL_1'', ''special'', ' || pg_temp.q(pg_temp.uid(321)) || ', ' || pg_temp.q(pg_temp.uid(405)) || ', now(), '
  || pg_temp.q(pg_temp.m('a500')) || ', ' || pg_temp.q(pg_temp.sys()) || ', ' || pg_temp.q(pg_temp.sys()) || ')'), '^E23503\|', 'C11 check 14 / §11 item 3: stain_orders.addon_case_item_id from another case -> FK violation');
SELECT matches(pg_temp.sa('INSERT INTO anatomic.addenda (id, tenant_id, centre_id, case_id, seq, kind, text, addon_case_item_id, created_by, updated_by) VALUES (' || pg_temp.q(pg_temp.uid(926)) || ', ' || pg_temp.q(pg_temp.ta()) || ', ' || pg_temp.q(pg_temp.id('00000000a201')) || ', '
  || pg_temp.q(pg_temp.uid(301)) || ', 9, ''ihc'', ''Synthetic'', ' || pg_temp.q(pg_temp.uid(405)) || ', ' || pg_temp.q(pg_temp.sys()) || ', ' || pg_temp.q(pg_temp.sys()) || ')'), '^E23503\|', 'C11 check 14 / §11 item 3: addenda.addon_case_item_id from another case -> FK violation');
SELECT matches(pg_temp.sa('INSERT INTO anatomic.report_versions (id, tenant_id, centre_id, case_id, version_no, version_kind, scope, addon_case_item_id, signed_by_membership_id, signed_at, created_by) VALUES (' || pg_temp.q(pg_temp.uid(927)) || ', ' || pg_temp.q(pg_temp.ta()) || ', '
  || pg_temp.q(pg_temp.id('00000000a201')) || ', ' || pg_temp.q(pg_temp.uid(301)) || ', 3, ''addendum'', ''addendum_only'', ' || pg_temp.q(pg_temp.uid(405)) || ', ' || pg_temp.q(pg_temp.m('a500')) || ', now(), ' || pg_temp.q(pg_temp.sys()) || ')'), '^E23503\|',
  'C11 check 14 / §11 item 3: report_versions.addon_case_item_id from another case -> FK violation');
SELECT matches(pg_temp.sa('INSERT INTO anatomic.report_versions (id, tenant_id, centre_id, case_id, version_no, version_kind, scope, addendum_id, signed_by_membership_id, signed_at, created_by) VALUES (' || pg_temp.q(pg_temp.uid(928)) || ', ' || pg_temp.q(pg_temp.ta()) || ', '
  || pg_temp.q(pg_temp.id('00000000a201')) || ', ' || pg_temp.q(pg_temp.uid(304)) || ', 3, ''addendum'', ''full'', ' || pg_temp.q(pg_temp.uid(382)) || ', ' || pg_temp.q(pg_temp.m('a500')) || ', now(), ' || pg_temp.q(pg_temp.sys()) || ')'), '^E23503\|',
  'C11 check 14 / §11 item 3: report_versions.addendum_id from another case -> FK violation');
SELECT matches(pg_temp.sa('INSERT INTO anatomic.item_submissions (id, tenant_id, centre_id, case_id, case_item_id, item_version_no, report_version_id, idempotency_key, lab_result_id, lab_version_no, lab_status, replayed, submitted_at, created_by) VALUES ('
  || pg_temp.q(pg_temp.uid(929)) || ', ' || pg_temp.q(pg_temp.ta()) || ', ' || pg_temp.q(pg_temp.id('00000000a201')) || ', ' || pg_temp.q(pg_temp.uid(301)) || ', ' || pg_temp.q(pg_temp.uid(405)) || ', 1, ' || pg_temp.q(pg_temp.uid(391)) || ', ''anatomic:'' || '
  || pg_temp.q(pg_temp.uid(405)) || ' || '':1'', ' || pg_temp.q(pg_temp.uid(7929)) || ', 1, ''resulted'', false, now(), ' || pg_temp.q(pg_temp.sys()) || ')'), '^E23503\|', 'C11 check 14 / §11 item 3: item_submissions.case_item_id from another case -> FK violation');
SELECT matches(pg_temp.sa('INSERT INTO anatomic.item_submissions (id, tenant_id, centre_id, case_id, case_item_id, item_version_no, report_version_id, idempotency_key, lab_result_id, lab_version_no, lab_status, replayed, submitted_at, created_by) VALUES ('
  || pg_temp.q(pg_temp.uid(930)) || ', ' || pg_temp.q(pg_temp.ta()) || ', ' || pg_temp.q(pg_temp.id('00000000a201')) || ', ' || pg_temp.q(pg_temp.uid(301)) || ', ' || pg_temp.q(pg_temp.uid(401)) || ', 2, ' || pg_temp.q(pg_temp.uid(392)) || ', ''anatomic:'' || '
  || pg_temp.q(pg_temp.uid(401)) || ' || '':2'', ' || pg_temp.q(pg_temp.uid(7930)) || ', 1, ''resulted'', false, now(), ' || pg_temp.q(pg_temp.sys()) || ')'), '^E23503\|', 'C11 check 14 / §11 item 3: item_submissions.report_version_id from another case -> FK violation');
SELECT matches(pg_temp.sa('INSERT INTO anatomic.batches (id, tenant_id, batch_no, assay_id, created_by, updated_by) VALUES (' || pg_temp.q(pg_temp.uid(931)) || ', ' || pg_temp.q(pg_temp.ta()) || ', ''B-2'', ' || pg_temp.q(pg_temp.uid(444)) || ', ' || pg_temp.q(pg_temp.sys()) || ', ' || pg_temp.q(pg_temp.sys()) || ')'),
  '^E23503\|', 'C11 check 14 / AC-0B-3.5: a tenant A batch cannot reference tenant B''s assay (composite FK (tenant_id, assay_id))');

-- C11 check 15: audit (AC-0B-5.1 / 5.2 / 5.3), the accession counter (P-18(a)) and the published view (§8; AC-0B-6.1 / 6.2 / 6.3). v_pub_report_content is security_invoker: the caller's RLS (tenant + centre) applies
SELECT is(pg_temp.sa('UPDATE anatomic.stains SET display = ''Haematoxylin & eosin'' WHERE id = ' || pg_temp.q(pg_temp.uid(351))), 'n=1', 'C11 check 15 / AC-0B-5.1: an audited class M update succeeds');
SELECT is((SELECT count(*)::int FROM audit.audit_log WHERE schema_name = 'anatomic' AND table_name = 'stains' AND row_id = pg_temp.uid(351) AND tenant_id = pg_temp.ta()), 1, 'C11 check 15 / AC-0B-5.1: the update wrote one audit_log row');
SELECT is((SELECT changed_columns @> ARRAY['display'] FROM audit.audit_log WHERE schema_name = 'anatomic' AND table_name = 'stains' AND row_id = pg_temp.uid(351)), true, 'C11 check 15 / AC-0B-5.2: only the changed columns are recorded');
SELECT is((SELECT count(*)::int FROM audit.audit_log WHERE schema_name = 'anatomic' AND table_name = 'cases' AND tenant_id = pg_temp.ta()) >= 1, true, 'C11 check 15 / AC-0B-5.1: cases (class C) updates are audited');
SELECT is(pg_temp.sa('UPDATE anatomic.accession_counters SET last_value = last_value + 1, updated_at = now() WHERE tenant_id = ' || pg_temp.q(pg_temp.ta()) || ' AND series_key = ''histology'' AND year_ad = 2026'), 'n=1', 'C11 check 15 / P-18(a): the counter row is updatable (atomic last_value + 1)');
SELECT is(pg_temp.sa('SELECT last_value::text FROM anatomic.accession_counters WHERE series_key = ''histology''', 's'), '2', 'C11 check 15: the counter advanced to 2');
SELECT is((SELECT count(*)::int FROM audit.audit_log WHERE schema_name = 'anatomic' AND table_name IN ('accession_counters', 'case_transitions', 'object_movements', 'report_versions', 'item_submissions')), 0,
  'C11 check 15 / AC-0B-5.3: class A tables and the counter are not audited (the earlier writes left no audit row)');
SELECT is(pg_temp.sa('SELECT count(*)::text FROM anatomic.v_pub_report_content', 's'), '2', 'C11 check 15 / §8: tenant A system actor reads its 2 submitted versions through the view');
SELECT is(pg_temp.sa('SELECT count(*)::text FROM anatomic.v_pub_report_content WHERE tenant_id = ' || pg_temp.q(pg_temp.tb()), 's'), '0', 'C11 check 15 / AC-0B-6.2: the invoker view applies the caller''s RLS: tenant A sees no tenant B report');
SELECT is(pg_temp.sb('SELECT count(*)::text FROM anatomic.v_pub_report_content', 's'), '1', 'C11 check 15: tenant B sees only its own report');
SELECT is(pg_temp.ua(pg_temp.m('a50a'), 'SELECT count(*)::text FROM anatomic.v_pub_report_content', 's'), '1', 'C11 check 15 / §8: centre-A1 staff sees only the centre A1 submission through the view');
SELECT is(pg_temp.sa('SELECT entity_id::text || '','' || version_no || '','' || accession_no || '','' || case_kind || '','' || version_kind || '','' || scope FROM anatomic.v_pub_report_content WHERE entity_id = ' || pg_temp.q(pg_temp.uid(401)), 's'),
  pg_temp.uid(401)::text || ',1,H26-1,histology,original,full', 'C11 check 15 / §8: entity_id = case_items.id, version_no = item_version_no, accession_no / case_kind from the case, version_kind / scope from the report version');
SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), 'portal', pg_temp.m('a500')), 'SELECT count(*)::text FROM anatomic.v_pub_report_content', 's'), '0', 'C11 check 15 / AC-0B-3.6: a portal actor reads no report content through the view');
SELECT matches(pg_temp.sa('INSERT INTO anatomic.v_pub_report_content (tenant_id) VALUES (' || pg_temp.q(pg_temp.ta()) || ')'), '^E', 'C11 check 15 / AC-0B-6.3: the published view is read-only');
SELECT is(pg_temp.x('lims_analytics', pg_temp.cl(pg_temp.ta()), 'SELECT count(*)::text FROM anatomic.v_pub_report_content', 's') !~ '^E42501', true, 'C11 check 15 / §8 GRANT: lims_analytics may SELECT the view (no permission denied)');

SELECT * FROM finish();
ROLLBACK;
