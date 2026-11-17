-- T0B-10.C5 behaviour suite: tenant / centre isolation (incl. processing_centre_id, 08 A13 D-13), non-staff actors, results lock + mutable-column triggers, append-only grants, barcode counter,
-- effective coded-set views, published views (C5 05-SCHEMA §3.1, §4, §7; AC-0B-2.4, 3.1-3.5, 3.7, 4.1, 4.2, 4.3, 5.1, 5.2, 5.3).
-- The generated per-table probes (db/tests/isolation/lab.<t>.test.sql) are the AC-0B-3.x proof for every table; this file proves what the generator cannot know.
-- Synthetic data only (seeds 010: tenant A 01a1a98a-...-a001, tenant B ...-b001; branches a101/b101; centres a201/a202/b201; memberships a500/b500). One rolled-back transaction.
-- RLS is never disabled: fixtures are inserted by the superuser test session (bypasses RLS) with the core system actor's claims set so app.tg_row_audit has an audit context;
-- every assertion runs as SET LOCAL ROLE lims_app.
-- Run from the repo root: pg_prove -d <db> db/tests/lab/T0B-10.C5_behaviour.test.sql   (pgTAP in schema `extensions`; migrations + seeds loaded; superuser)
-- Markers: C5 check 1 fixtures/controls, 2 non-staff + no claims, 3 tenant isolation, 4 centre + processing-centre scope, 5 results lock, 6 specimens / result_versions mutable columns,
-- 7 append-only + no DELETE, 8 barcode counter, 9 coded-set views, 10 published views, 11 audit rows, 12 qc_results centre scope.
BEGIN;
SET search_path = extensions, public, pg_catalog;
SELECT * FROM no_plan();

CREATE FUNCTION pg_temp.ta() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1a98a-ac40-7000-8000-00000000a001'::uuid $$;
CREATE FUNCTION pg_temp.tb() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1a98a-ac40-7000-8000-00000000b001'::uuid $$;
CREATE FUNCTION pg_temp.sys() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1b34e-1000-7eee-9d29-d7ca59a102b5'::uuid $$;
CREATE FUNCTION pg_temp.uid(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('0190c500-0000-7000-8000-' || lpad(n::text, 12, '0'))::uuid $$;
CREATE FUNCTION pg_temp.id(s text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('01a1a98a-ac40-7000-8000-' || s)::uuid $$;
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
CREATE FUNCTION pg_temp.cl(p_tenant uuid, p_type text DEFAULT 'system', p_centre uuid DEFAULT NULL) RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('actor_type', p_type, 'tenant_id', p_tenant, 'sub', pg_temp.sys(),
    'membership_id', CASE WHEN p_tenant = pg_temp.ta() THEN '01a1a98a-ac40-7000-8000-00000000a500' ELSE '01a1a98a-ac40-7000-8000-00000000b500' END::uuid)
    || CASE WHEN p_centre IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('centre_id', p_centre) END $$;
CREATE FUNCTION pg_temp.a(p_sql text, p_mode text DEFAULT 'w') RETURNS text LANGUAGE sql AS $$ SELECT pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta()), p_sql, p_mode) $$;      -- tenant A, all centres (system)
CREATE FUNCTION pg_temp.b(p_sql text, p_mode text DEFAULT 'w') RETURNS text LANGUAGE sql AS $$ SELECT pg_temp.x('lims_app', pg_temp.cl(pg_temp.tb()), p_sql, p_mode) $$;
CREATE FUNCTION pg_temp.dev(p_centre uuid, p_sql text, p_mode text DEFAULT 'n') RETURNS text LANGUAGE sql AS $$ SELECT pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), 'device', p_centre), p_sql, p_mode) $$;
CREATE FUNCTION pg_temp.cpb(p_tbl regclass, p_where text, p_over jsonb) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE j jsonb;
BEGIN
  EXECUTE format('SELECT to_jsonb(t) FROM %s t WHERE %s', p_tbl, p_where) INTO j;
  RETURN format('INSERT INTO %1$s SELECT * FROM jsonb_populate_record(NULL::%1$s, %2$L::jsonb)', p_tbl, (j || p_over)::text);
END $f$;

-- ===================================================================================================================================== fixtures (superuser, system claims)
-- C5 check 1: frontdesk parents (lab.orders.id = frontdesk.orders.id; lab.order_tests -> frontdesk.order_items)
SELECT pg_temp.ins('frontdesk.patients', jsonb_build_object('id', pg_temp.uid(1), 'tenant_id', pg_temp.ta(), 'patient_code', 'P-0001', 'full_name', 'Test Patient 0001', 'name_search', 'test patient 0001', 'sex', 'female', 'registered_centre_id', pg_temp.id('00000000a201')));
SELECT pg_temp.ins('frontdesk.patients', jsonb_build_object('id', pg_temp.uid(2), 'tenant_id', pg_temp.tb(), 'patient_code', 'P-0001', 'full_name', 'Test Patient 0002', 'name_search', 'test patient 0002', 'sex', 'male', 'registered_centre_id', pg_temp.id('00000000b201')));
SELECT pg_temp.ins('frontdesk.orders', jsonb_build_object('id', pg_temp.uid(o.n), 'tenant_id', o.t, 'branch_id', o.br, 'centre_id', o.c, 'patient_id', o.p, 'registration_no', 'R-' || o.n, 'status', 'registered', 'visit_type', 'opd',
    'billing_mode', 'cash', 'priority', 'routine', 'collection_mode', 'walk_in', 'source', 'front_desk', 'is_first_order_of_patient', true, 'catalog_revision', 1, 'registered_at', now()))
  FROM (VALUES (11, pg_temp.ta(), pg_temp.id('00000000a101'), pg_temp.id('00000000a201'), pg_temp.uid(1)), (12, pg_temp.ta(), pg_temp.id('00000000a101'), pg_temp.id('00000000a202'), pg_temp.uid(1)),
               (13, pg_temp.tb(), pg_temp.id('00000000b101'), pg_temp.id('00000000b201'), pg_temp.uid(2))) o(n, t, br, c, p);
SELECT pg_temp.ins('frontdesk.order_items', jsonb_build_object('id', pg_temp.uid(21), 'tenant_id', pg_temp.ta(), 'order_id', pg_temp.uid(11), 'centre_id', pg_temp.id('00000000a201'), 'orderable_id', pg_temp.uid(99), 'orderable_kind', 'test',
    'code', 'CBC', 'name', 'CBC (SYNTHETIC)', 'test_ids', jsonb_build_array(pg_temp.uid(99)), 'priority', 'routine', 'unit_price_paisa', 1000, 'price_list_id', pg_temp.uid(98), 'price_list_version', 1,
    'price_source', 'tenant_default', 'vat_treatment', 'exempt', 'added_in_items_version', 1));
-- lab.orders: LO1 (order 11, centre a201), LO2 (order 12, centre a202), LOB (tenant B)
SELECT pg_temp.ins('lab.orders', jsonb_build_object('id', pg_temp.uid(o.n), 'tenant_id', o.t, 'centre_id', o.c, 'branch_id', o.br, 'patient_id', o.p, 'registration_no', 'R-' || o.n, 'visit_type', 'opd', 'priority', 'routine',
    'source', 'front_desk', 'registered_at', now(), 'patient_sex', 'female', 'last_order_seq', 1))
  FROM (VALUES (11, pg_temp.ta(), pg_temp.id('00000000a101'), pg_temp.id('00000000a201'), pg_temp.uid(1)), (12, pg_temp.ta(), pg_temp.id('00000000a101'), pg_temp.id('00000000a202'), pg_temp.uid(1)),
               (13, pg_temp.tb(), pg_temp.id('00000000b101'), pg_temp.id('00000000b201'), pg_temp.uid(2))) o(n, t, br, c, p);
-- specimens: S1 order 11 collected at a201, RECEIVED at a202 (processing centre); S2 order 11 at a201 not received; S3 order 12 at a202; S4 order 12 at a202 rejected; SB tenant B
SELECT pg_temp.ins('lab.specimens', jsonb_build_object('id', pg_temp.uid(s.n), 'tenant_id', s.t, 'centre_id', s.c, 'order_id', s.o, 'patient_id', s.p, 'barcode', 'E26' || lpad(s.n::text, 8, '0'), 'creation_key', 'ck-' || s.n,
    'specimen_type_code', 'serum', 'priority', 'routine', 'patient_sex', 'female', 'status', s.st, 'ordered_at', now()) || s.x)
  FROM (VALUES (31, pg_temp.ta(), pg_temp.id('00000000a201'), pg_temp.uid(11), pg_temp.uid(1), 'received', jsonb_build_object('processing_centre_id', pg_temp.id('00000000a202'), 'processing_branch_id', pg_temp.id('00000000a101'), 'received_at', now())),
               (32, pg_temp.ta(), pg_temp.id('00000000a201'), pg_temp.uid(11), pg_temp.uid(1), 'ordered', '{}'::jsonb),
               (33, pg_temp.ta(), pg_temp.id('00000000a202'), pg_temp.uid(12), pg_temp.uid(1), 'ordered', '{}'::jsonb),
               (34, pg_temp.ta(), pg_temp.id('00000000a202'), pg_temp.uid(12), pg_temp.uid(1), 'rejected', jsonb_build_object('rejected_at', now(), 'rejection_reason_code', 'haemolysed', 'recollection_ordered_at', now())),
               (35, pg_temp.tb(), pg_temp.id('00000000b201'), pg_temp.uid(13), pg_temp.uid(2), 'ordered', '{}'::jsonb)) s(n, t, c, o, p, st, x);
SELECT pg_temp.ins('lab.order_tests', jsonb_build_object('id', pg_temp.uid(41), 'tenant_id', pg_temp.ta(), 'centre_id', pg_temp.id('00000000a201'), 'processing_centre_id', pg_temp.id('00000000a202'), 'processing_branch_id', pg_temp.id('00000000a101'),
  'order_id', pg_temp.uid(11), 'order_item_id', pg_temp.uid(21), 'test_id', pg_temp.uid(99), 'test_code', 'CBC', 'test_revision', 1, 'catalog_revision', 1, 'department_id', pg_temp.uid(97), 'workflow_type', 'standard',
  'priority', 'routine', 'specimen_id', pg_temp.uid(31), 'status', 'awaiting_receipt', 'ordered_at', now()));
-- results: R1 approved (analyte 1), R2 cancelled (analyte 2), R3 pending (analyte 3); all of order test 41
SELECT pg_temp.ins('lab.results', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', pg_temp.ta(), 'centre_id', pg_temp.id('00000000a201'), 'processing_centre_id', pg_temp.id('00000000a202'), 'processing_branch_id', pg_temp.id('00000000a101'),
    'order_id', pg_temp.uid(11), 'order_item_id', pg_temp.uid(21), 'order_test_id', pg_temp.uid(41), 'specimen_id', pg_temp.uid(31), 'patient_id', pg_temp.uid(1), 'test_id', pg_temp.uid(99), 'analyte_id', pg_temp.uid(r.n + 50),
    'analyte_code', 'AN' || r.n, 'department_id', pg_temp.uid(97), 'is_reportable', true, 'result_type', 'numeric', 'status', r.st) || r.x)
  FROM (VALUES (51, 'approved', jsonb_build_object('origin', 'manual', 'value_numeric', 5.1, 'flag', 'N', 'first_resulted_at', now(), 'resulted_at', now(), 'approved_at', now(), 'approved_by_membership_id', pg_temp.id('00000000a500'))),
               (52, 'cancelled', jsonb_build_object('cancelled_at', now(), 'cancel_reason', 'specimen_rejected')),
               (53, 'pending', '{}'::jsonb)) r(n, st, x);
SELECT pg_temp.ins('lab.result_versions', jsonb_build_object('id', pg_temp.uid(61), 'tenant_id', pg_temp.ta(), 'centre_id', pg_temp.id('00000000a201'), 'processing_centre_id', pg_temp.id('00000000a202'), 'result_id', pg_temp.uid(51),
  'version_no', 1, 'origin', 'manual', 'value_numeric', 5.1, 'flag', 'N', 'is_critical', false, 'approved_at', now(), 'approved_by_membership_id', pg_temp.id('00000000a500')));
SELECT pg_temp.ins('lab.qc_results', jsonb_build_object('id', pg_temp.uid(81), 'tenant_id', pg_temp.ta(), 'centre_id', pg_temp.id('00000000a201'), 'instrument_id', pg_temp.uid(96), 'control_id_raw', 'QC-L1', 'value_raw', '4.9',
  'value_numeric', 4.9, 'received_at', now(), 'source', 'instrument', 'idempotency_key', 'qc-a-1'));
SELECT pg_temp.ins('lab.qc_results', jsonb_build_object('id', pg_temp.uid(82), 'tenant_id', pg_temp.ta(), 'centre_id', pg_temp.id('00000000a202'), 'instrument_id', pg_temp.uid(96), 'control_id_raw', 'QC-L2', 'value_raw', '5.0',
  'value_numeric', 5.0, 'received_at', now(), 'source', 'instrument', 'idempotency_key', 'qc-a-2'));
SELECT pg_temp.ins('lab.qc_results', jsonb_build_object('id', pg_temp.uid(83), 'tenant_id', pg_temp.tb(), 'centre_id', pg_temp.id('00000000b201'), 'instrument_id', pg_temp.uid(95), 'control_id_raw', 'QC-L1', 'value_raw', '4.8',
  'value_numeric', 4.8, 'received_at', now(), 'source', 'instrument', 'idempotency_key', 'qc-b-1'));
SELECT pg_temp.ins('lab.barcode_counters', jsonb_build_object('tenant_id', pg_temp.ta(), 'last_value', 5));
SELECT pg_temp.ins('lab.barcode_counters', jsonb_build_object('tenant_id', pg_temp.tb(), 'last_value', 9));
SELECT pg_temp.ins('lab.lab_settings', jsonb_build_object('tenant_id', pg_temp.ta()));
SELECT pg_temp.ins('lab.lab_settings', jsonb_build_object('tenant_id', pg_temp.tb()));
-- coded sets: two synthetic global codes, tenant A overrides zz_g2 and adds zz_t1
INSERT INTO lab.g_cs_rejection_reasons (id, code, display) VALUES (pg_temp.uid(91), 'zz_g1', 'Global one'), (pg_temp.uid(92), 'zz_g2', 'Global two');
SELECT pg_temp.ins('lab.cs_rejection_reasons', jsonb_build_object('id', pg_temp.uid(93), 'tenant_id', pg_temp.ta(), 'code', 'zz_g2', 'display', 'Tenant override'));
SELECT pg_temp.ins('lab.cs_rejection_reasons', jsonb_build_object('id', pg_temp.uid(94), 'tenant_id', pg_temp.ta(), 'code', 'zz_t1', 'display', 'Tenant only'));
CREATE TEMP TABLE tt(q) AS VALUES ('lab.lab_settings'),('lab.barcode_counters'),('lab.delta_check_rules'),('lab.order_readiness'),('lab.qc_holds'),('lab.cs_rejection_reasons'),('lab.cs_return_reasons'),('lab.cs_amendment_reasons'),
  ('lab.cs_exception_discard_reasons'),('lab.report_releases'),('lab.module_submissions'),('lab.orders'),('lab.specimens'),('lab.order_tests'),('lab.results'),('lab.result_versions'),('lab.critical_value_log'),('lab.worksheets'),
  ('lab.ingest_exceptions'),('lab.ingest_log'),('lab.specimen_transitions'),('lab.result_observations'),('lab.result_attachments'),('lab.verifications'),('lab.approvals'),('lab.critical_notifications'),('lab.worksheet_items'),('lab.qc_results');
-- positive controls: an isolation test on empty data proves nothing
SELECT is(pg_temp.a('SELECT 1 FROM lab.orders', 'n'), 'n=2', 'C5 check 1: control: tenant A (system) sees its 2 lab orders');
SELECT is(pg_temp.a('SELECT 1 FROM lab.specimens', 'n'), 'n=4', 'C5 check 1: control: tenant A sees its 4 specimens');
SELECT is(pg_temp.a('SELECT 1 FROM lab.results', 'n'), 'n=3', 'C5 check 1: control: tenant A sees its 3 results');
SELECT is(pg_temp.a('SELECT 1 FROM lab.qc_results', 'n'), 'n=2', 'C5 check 1: control: tenant A sees its 2 QC results');
SELECT is(pg_temp.b('SELECT 1 FROM lab.specimens', 'n'), 'n=1', 'C5 check 1: control: tenant B sees its 1 specimen');

-- ===================================================================================================================================== C5 check 2: non-staff actors + no claims (AC-0B-3.7; CR-C13-011, 08 R3)
SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), k.t), 'SELECT 1 FROM ' || tt.q, 'n'), 'n=0', 'C5 check 2: ' || k.t || ' sees 0 rows of ' || tt.q) FROM tt CROSS JOIN (VALUES ('partner'),('portal'),('patient')) k(t);
SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), 'patient'), $$ SELECT 1 FROM lab.v_pub_specimen_timeline UNION ALL SELECT 1 FROM lab.v_pub_pending_items UNION ALL SELECT 1 FROM lab.v_pub_result_daily
  UNION ALL SELECT 1 FROM lab.v_pub_qc_result UNION ALL SELECT 1 FROM lab.v_result_current $$, 'n'), 'n=0', 'C5 check 2: patient actor sees 0 rows through the views (security_invoker)');
SELECT is(pg_temp.x('lims_app', NULL, 'SELECT 1 FROM ' || tt.q, 'n'), 'n=0', 'AC-0B-3.7: no claims -> 0 rows of ' || tt.q) FROM tt;
SELECT is(pg_temp.x('lims_app', NULL, 'SELECT 1 FROM lab.specimens', 'n'), 'n=0', 'AC-0B-3.7: no claims -> 0 specimens');

-- ===================================================================================================================================== C5 check 3: tenant isolation (AC-0B-3.1 .. 3.5)
SELECT is(pg_temp.a('SELECT 1 FROM ' || tt.q || ' WHERE tenant_id = ' || quote_literal(pg_temp.tb()), 'n'), 'n=0', 'AC-0B-3.1: tenant A sees 0 tenant-B rows of ' || tt.q) FROM tt;
SELECT is(pg_temp.b('SELECT 1 FROM ' || tt.q || ' WHERE tenant_id = ' || quote_literal(pg_temp.ta()), 'n'), 'n=0', 'AC-0B-3.1: tenant B sees 0 tenant-A rows of ' || tt.q) FROM tt;
SELECT alike(pg_temp.a(pg_temp.cpb('lab.orders', 'id = ' || quote_literal(pg_temp.uid(13)), jsonb_build_object('id', pg_temp.uid(201), 'registration_no', 'R-X')), 'w'), 'E42501|%', 'AC-0B-3.2: A cannot insert a lab order for B');
SELECT alike(pg_temp.a(pg_temp.cpb('lab.specimens', 'id = ' || quote_literal(pg_temp.uid(35)), jsonb_build_object('id', pg_temp.uid(202), 'barcode', 'E2600000X', 'creation_key', 'ck-x')), 'w'), 'E42501|%', 'AC-0B-3.2: A cannot insert a specimen for B');
SELECT alike(pg_temp.a(pg_temp.cpb('lab.qc_results', 'id = ' || quote_literal(pg_temp.uid(83)), jsonb_build_object('id', pg_temp.uid(203), 'idempotency_key', 'qc-x')), 'w'), 'E42501|%', 'AC-0B-3.2: A cannot insert a QC result for B');
SELECT alike(pg_temp.a(pg_temp.cpb('lab.barcode_counters', 'tenant_id = ' || quote_literal(pg_temp.tb()), '{}'::jsonb), 'w'), 'E42501|%', 'AC-0B-3.2: A cannot insert a barcode counter for B');
SELECT is(pg_temp.a('UPDATE lab.specimens SET label_print_count = label_print_count + 1 WHERE id = ' || quote_literal(pg_temp.uid(35))), 'n=0', 'AC-0B-3.3: A updates 0 B specimens');
SELECT is(pg_temp.a('UPDATE lab.barcode_counters SET last_value = last_value + 1 WHERE tenant_id = ' || quote_literal(pg_temp.tb())), 'n=0', 'AC-0B-3.3: A bumps 0 B barcode counters');
SELECT is(pg_temp.a('UPDATE lab.orders SET lab_status = ''cancelled'' WHERE id = ' || quote_literal(pg_temp.uid(13))), 'n=0', 'AC-0B-3.3: A updates 0 B lab orders');
-- AC-0B-3.5: composite FK refuses a child pointing to the other tenant's parent
SELECT alike(pg_temp.a(format($$ INSERT INTO lab.specimens (id, tenant_id, centre_id, order_id, patient_id, barcode, creation_key, specimen_type_code, priority, patient_sex, status, ordered_at, created_by, updated_by)
  VALUES (%L, %L, %L, %L, %L, 'E2600000Y', 'ck-y', 'serum', 'routine', 'female', 'ordered', now(), %L, %L) $$, pg_temp.uid(204), pg_temp.ta(), pg_temp.id('00000000a201'), pg_temp.uid(13), pg_temp.uid(1), pg_temp.sys(), pg_temp.sys())),
  'E23503|%', 'AC-0B-3.5: A specimen pointing at B''s lab order -> composite FK violation');
SELECT alike(pg_temp.a(format($$ INSERT INTO lab.order_tests (id, tenant_id, centre_id, order_id, order_item_id, test_id, test_code, test_revision, catalog_revision, department_id, workflow_type, priority, status, ordered_at, created_by, updated_by)
  VALUES (%L, %L, %L, %L, %L, %L, 'X', 1, 1, %L, 'standard', 'routine', 'awaiting_receipt', now(), %L, %L) $$, pg_temp.uid(205), pg_temp.ta(), pg_temp.id('00000000a201'), pg_temp.uid(13), pg_temp.uid(21), pg_temp.uid(98), pg_temp.uid(97), pg_temp.sys(), pg_temp.sys())),
  'E23503|%', 'AC-0B-3.5: order test of A for B''s order -> composite FK violation');

-- ===================================================================================================================================== C5 check 4: centre + processing-centre scope (AC-0B-3.4; 08 A13 D-13)
SELECT is(pg_temp.dev(pg_temp.id('00000000a201'), 'SELECT 1 FROM lab.specimens'), 'n=2', 'C5 check 4: centre a201 actor sees S1 + S2 (collection centre)');
SELECT is(pg_temp.dev(pg_temp.id('00000000a202'), 'SELECT 1 FROM lab.specimens'), 'n=3', 'C5 check 4: centre a202 actor sees S1 (processing centre) + S3 + S4 (own collection centre)');
SELECT is(pg_temp.dev(pg_temp.id('00000000a202'), 'SELECT 1 FROM lab.specimens WHERE id = ' || quote_literal(pg_temp.uid(32))), 'n=0', 'AC-0B-3.4: a202 actor does not see the a201 specimen not yet received (before receipt only centre_id matches)');
SELECT is(pg_temp.dev(pg_temp.id('00000000a202'), 'SELECT 1 FROM lab.specimens WHERE id = ' || quote_literal(pg_temp.uid(31))), 'n=1', 'C5 check 4: host-query visibility: a202 actor sees the specimen received at a202');
SELECT is(pg_temp.dev(pg_temp.id('00000000a201'), 'SELECT 1 FROM lab.orders'), 'n=1', 'C5 check 4: a201 actor sees order 11 only');
SELECT is(pg_temp.dev(pg_temp.id('00000000a202'), 'SELECT 1 FROM lab.orders'), 'n=2', 'C5 check 4: a202 actor sees order 12 (own) + order 11 through the specimen received at a202');
SELECT is(pg_temp.dev(pg_temp.id('00000000a201'), 'SELECT 1 FROM lab.order_tests'), 'n=1', 'order test follows centre_id');
SELECT is(pg_temp.dev(pg_temp.id('00000000a202'), 'SELECT 1 FROM lab.order_tests'), 'n=1', 'order test follows processing_centre_id');
SELECT is(pg_temp.dev(pg_temp.id('00000000a202'), 'SELECT 1 FROM lab.results'), 'n=3', 'results of the received specimen visible at the processing centre');
SELECT is(pg_temp.dev(pg_temp.id('00000000b201'), 'SELECT 1 FROM lab.results'), 'n=0', 'a tenant-A device claim for a B centre sees nothing');
SELECT is(pg_temp.dev(pg_temp.id('00000000a201'), 'SELECT 1 FROM lab.lab_settings'), 'n=1', 'tenant-scoped (T) tables are visible to a centre-scoped staff actor');
-- cross-centre writes: a201 actor cannot create a specimen / order for a202
SELECT alike(pg_temp.dev(pg_temp.id('00000000a201'), format($$ INSERT INTO lab.specimens (id, tenant_id, centre_id, order_id, patient_id, barcode, creation_key, specimen_type_code, priority, patient_sex, status, ordered_at, created_by, updated_by)
  VALUES (%L, %L, %L, %L, %L, 'E2600000Z', 'ck-z', 'serum', 'routine', 'female', 'ordered', now(), %L, %L) $$, pg_temp.uid(206), pg_temp.ta(), pg_temp.id('00000000a202'), pg_temp.uid(12), pg_temp.uid(1), pg_temp.sys(), pg_temp.sys()), 'w'),
  'E42501|%', 'AC-0B-3.4: a201 actor cannot insert a specimen for centre a202');
SELECT alike(pg_temp.dev(pg_temp.id('00000000a201'), pg_temp.cpb('lab.orders', 'id = ' || quote_literal(pg_temp.uid(12)), jsonb_build_object('id', pg_temp.uid(207), 'registration_no', 'R-Q')), 'w'), 'E42501|%',
  'lab.orders INSERT only by actors with all centres (system consumers)');
SELECT is(pg_temp.dev(pg_temp.id('00000000a201'), 'UPDATE lab.orders SET lab_status = ''cancelled'' WHERE id = ' || quote_literal(pg_temp.uid(11)), 'w'), 'n=0', 'lab.orders UPDATE only by actors with all centres');
SELECT is(pg_temp.dev(pg_temp.id('00000000a202'), 'UPDATE lab.specimens SET label_print_count = label_print_count + 1 WHERE id = ' || quote_literal(pg_temp.uid(31)), 'w'), 'n=1', 'processing-centre actor may update the specimen received at its centre');
SELECT is(pg_temp.dev(pg_temp.id('00000000a202'), 'UPDATE lab.specimens SET label_print_count = label_print_count + 1 WHERE id = ' || quote_literal(pg_temp.uid(32)), 'w'), 'n=0', 'but not an unreceived specimen of another centre');
-- A16.1: the ::uuid[] cast - a centre-scoped SELECT on every table raises no "operator does not exist: uuid = uuid[]"
SELECT unalike(pg_temp.dev(pg_temp.id('00000000a201'), 'SELECT 1 FROM ' || tt.q), 'E%', 'AC-0B-3.4 / A16.1: centre-scoped SELECT on ' || tt.q || ' raises no operator error') FROM tt;

-- ===================================================================================================================================== C5 check 5: results lock (AC-0B-4.1; lab.enforce_result_lock)
SELECT alike(pg_temp.a('UPDATE lab.results SET value_numeric = 9.9 WHERE id = ' || quote_literal(pg_temp.uid(51))), 'EP0001|immutable_row%', 'C5 check 5 / AC-0B-4.1: approved result value cannot change');
SELECT alike(pg_temp.a('UPDATE lab.results SET flag = ''H'' WHERE id = ' || quote_literal(pg_temp.uid(51))), 'EP0001|immutable_row%', 'C5 check 5: approved result flag frozen');
SELECT alike(pg_temp.a('UPDATE lab.results SET status = ''resulted'' WHERE id = ' || quote_literal(pg_temp.uid(51))), 'EP0001|immutable_row%', 'C5 check 5: approved result cannot go back');
SELECT alike(pg_temp.a('UPDATE lab.results SET comment_text = ''x'' WHERE id = ' || quote_literal(pg_temp.uid(51))), 'EP0001|immutable_row%', 'C5 check 5: approved result comment frozen');
SELECT is(pg_temp.a('UPDATE lab.results SET current_version_no = 2, qc_review_required = true, version = version + 1 WHERE id = ' || quote_literal(pg_temp.uid(51))), 'n=1', 'C5 check 5: after approval only current_version_no, qc_review_required, updated_*, version may change');
SELECT alike(pg_temp.a('UPDATE lab.results SET cancel_reason = ''x'' WHERE id = ' || quote_literal(pg_temp.uid(52))), 'EP0001|immutable_row%', 'C5 check 5: cancelled result is fully frozen');
SELECT alike(pg_temp.a('UPDATE lab.results SET current_version_no = 2 WHERE id = ' || quote_literal(pg_temp.uid(52))), 'EP0001|immutable_row%', 'C5 check 5: cancelled result frozen even for current_version_no');
SELECT alike(pg_temp.a('UPDATE lab.results SET analyte_id = ' || quote_literal(pg_temp.uid(199)) || ' WHERE id = ' || quote_literal(pg_temp.uid(53))), 'EP0001|immutable_row%', 'C5 check 5: identity columns (analyte_id) frozen before approval too');
SELECT alike(pg_temp.a('UPDATE lab.results SET patient_id = ' || quote_literal(pg_temp.uid(1)) || ', order_id = ' || quote_literal(pg_temp.uid(12)) || ' WHERE id = ' || quote_literal(pg_temp.uid(53))), 'EP0001|immutable_row%', 'C5 check 5: order_id frozen');
SELECT is(pg_temp.a('UPDATE lab.results SET status = ''resulted'', origin = ''manual'', value_numeric = 4.4, flag = ''N'', resulted_at = now(), first_resulted_at = now() WHERE id = ' || quote_literal(pg_temp.uid(53))), 'n=1', 'C5 check 5: pending result is editable (pending -> resulted)');
SELECT is(pg_temp.a('UPDATE lab.results SET specimen_id = ' || quote_literal(pg_temp.uid(32)) || ' WHERE id = ' || quote_literal(pg_temp.uid(53))), 'n=1', 'C5 check 5: specimen_id may change before approval (aliquot re-point)');
SELECT alike(pg_temp.a('UPDATE lab.results SET status = ''approved'', approved_at = now() WHERE id = ' || quote_literal(pg_temp.uid(53))), 'E23514|%results__approved_by__ck%', 'approved without approver -> CHECK results__approved_by__ck');
SELECT alike(pg_temp.a('UPDATE lab.results SET flag = ''ZZ'' WHERE id = ' || quote_literal(pg_temp.uid(53))), 'E23514|%results__flag__ck%', 'flag CHECK (N,L,H,LL,HH,A)');

-- ===================================================================================================================================== C5 check 6: mutable-column triggers (§7)
SELECT alike(pg_temp.a('UPDATE lab.specimens SET barcode = ''E26HACK'' WHERE id = ' || quote_literal(pg_temp.uid(31))), 'EP0001|immutable_row%', 'C5 check 6 / AC-0B-4.1: specimens.barcode frozen');
SELECT alike(pg_temp.a('UPDATE lab.specimens SET order_id = ' || quote_literal(pg_temp.uid(12)) || ' WHERE id = ' || quote_literal(pg_temp.uid(31))), 'EP0001|immutable_row%', 'C5 check 6: specimens.order_id frozen');
SELECT alike(pg_temp.a('UPDATE lab.specimens SET centre_id = ' || quote_literal(pg_temp.id('00000000a202')) || ' WHERE id = ' || quote_literal(pg_temp.uid(32))), 'EP0001|immutable_row%', 'C5 check 6: specimens.centre_id frozen');
SELECT alike(pg_temp.a('UPDATE lab.specimens SET creation_key = ''ck-new'' WHERE id = ' || quote_literal(pg_temp.uid(32))), 'EP0001|immutable_row%', 'C5 check 6: specimens.creation_key frozen');
SELECT is(pg_temp.a('UPDATE lab.specimens SET status = ''collected'', collected_at = now(), version = version + 1 WHERE id = ' || quote_literal(pg_temp.uid(32))), 'n=1', 'C5 check 6: lifecycle columns of specimens are updatable');
SELECT alike(pg_temp.a('UPDATE lab.specimens SET status = ''bogus'' WHERE id = ' || quote_literal(pg_temp.uid(32))), 'E23514|%specimens__status__ck%', 'specimens.status CHECK');
SELECT alike(pg_temp.a('UPDATE lab.specimens SET received_at = now() WHERE id = ' || quote_literal(pg_temp.uid(32))), 'E23514|%specimens__received_has_centre__ck%', 'received without processing centre -> CHECK');
SELECT alike(pg_temp.a('UPDATE lab.result_versions SET value_numeric = 1 WHERE id = ' || quote_literal(pg_temp.uid(61))), 'EP0001|immutable_row%', 'C5 check 6: result_versions value frozen (evaluation columns written at insert only)');
SELECT alike(pg_temp.a('UPDATE lab.result_versions SET approved_at = now() + interval ''1 second'' WHERE id = ' || quote_literal(pg_temp.uid(61))), 'EP0001|immutable_row%', 'C5 check 6: result_versions.approved_at frozen');
SELECT is(pg_temp.a('UPDATE lab.result_versions SET superseded_at = now(), superseded_by_version_no = 2, version = version + 1 WHERE id = ' || quote_literal(pg_temp.uid(61))), 'n=1', 'C5 check 6: result_versions supersede columns are updatable');
SELECT alike(pg_temp.a(format($$ INSERT INTO lab.result_versions (id, tenant_id, centre_id, result_id, version_no, origin, is_critical, approved_at, approved_by_membership_id, created_by, updated_by)
  VALUES (%L, %L, %L, %L, 2, 'manual', false, now(), %L, %L, %L) $$, pg_temp.uid(62), pg_temp.ta(), pg_temp.id('00000000a201'), pg_temp.uid(51), pg_temp.id('00000000a500'), pg_temp.sys(), pg_temp.sys())), 'E23514|%result_versions__amend__ck%',
  'version 2 without amendment reason / previous_version_no -> result_versions__amend__ck');

-- ===================================================================================================================================== C5 check 7: append-only + no DELETE (AC-0B-4.2 / 4.3)
SELECT alike(pg_temp.a('UPDATE lab.' || t || ' SET created_by = created_by'), 'E42501|%', 'C5 check 7 / AC-0B-4.3: no UPDATE grant on lab.' || t)
  FROM unnest(ARRAY['specimen_transitions','result_observations','result_attachments','verifications','approvals','critical_notifications','qc_results','worksheet_items','report_releases','module_submissions','event_inbox']) t;
SELECT alike(pg_temp.a('DELETE FROM ' || tt.q), 'E42501|%', 'C5 check 7 / AC-0B-4.2: no DELETE grant on ' || tt.q) FROM tt;
SELECT alike(pg_temp.a('DELETE FROM lab.g_cs_rejection_reasons'), 'E42501|%', 'no DELETE on G tables');
SELECT alike(pg_temp.a('INSERT INTO lab.g_cs_rejection_reasons (id, code, display) VALUES (gen_random_uuid(), ''zz_hack'', ''x'')'), 'E42501|%', 'lims_app cannot write global coded sets');
SELECT alike(pg_temp.a('UPDATE lab.g_cs_rejection_reasons SET display = ''x'''), 'E42501|%', 'lims_app cannot update global coded sets');

-- ===================================================================================================================================== C5 check 8: barcode counter (atomic last_value + 1; no DELETE)
SELECT is(pg_temp.a('UPDATE lab.barcode_counters SET last_value = last_value + 1 WHERE tenant_id = ' || quote_literal(pg_temp.ta()) || ' RETURNING last_value', 's'), '6', 'C5 check 8: UPDATE ... last_value + 1 RETURNING gives the next sequence value');
SELECT is(pg_temp.a('UPDATE lab.barcode_counters SET last_value = last_value + 1 WHERE tenant_id = ' || quote_literal(pg_temp.ta()) || ' RETURNING last_value', 's'), '7', 'C5 check 8: second bump gives 7 (no gap, same tenant)');
SELECT is((SELECT last_value::int FROM lab.barcode_counters WHERE tenant_id = pg_temp.tb()), 9, 'C5 check 8: tenant B counter untouched');
SELECT alike(pg_temp.a('UPDATE lab.barcode_counters SET last_value = -1 WHERE tenant_id = ' || quote_literal(pg_temp.ta())), 'E23514|%barcode_counters__nonneg__ck%', 'last_value >= 0 CHECK');
SELECT alike(pg_temp.a('DELETE FROM lab.barcode_counters'), 'E42501|%', 'barcode_counters: no DELETE');

-- ===================================================================================================================================== C5 check 9: effective coded-set views (tenant rows shadow global rows by code)
SELECT is(pg_temp.a($$ SELECT string_agg(code || ':' || source || ':' || display, ',' ORDER BY code) FROM lab.v_rejection_reasons WHERE code LIKE 'zz\_%' $$, 's'),
  'zz_g1:global:Global one,zz_g2:tenant:Tenant override,zz_t1:tenant:Tenant only', 'C5 check 9: tenant A sees zz_g1 (global), zz_g2 (shadowed by the tenant row), zz_t1 (tenant)');
SELECT is(pg_temp.b($$ SELECT string_agg(code || ':' || source || ':' || display, ',' ORDER BY code) FROM lab.v_rejection_reasons WHERE code LIKE 'zz\_%' $$, 's'),
  'zz_g1:global:Global one,zz_g2:global:Global two', 'C5 check 9: tenant B sees only global rows, never A''s tenant rows');
SELECT is(pg_temp.x('lims_app', NULL, $$ SELECT 1 FROM lab.v_rejection_reasons $$, 'n'), 'n=0', 'AC-0B-3.7: no claims -> effective set view is empty');
SELECT is(pg_temp.a('SELECT 1 FROM lab.v_return_reasons WHERE source = ''tenant''', 'n'), 'n=0', 'the other three sets are independent');
SELECT alike(pg_temp.a(format($$ INSERT INTO lab.cs_rejection_reasons (id, tenant_id, code, display, created_by, updated_by) VALUES (%L, %L, 'Bad Code!', 'x', %L, %L) $$, pg_temp.uid(210), pg_temp.ta(), pg_temp.sys(), pg_temp.sys())),
  'E23514|%cs_rejection_reasons__code__ck%', 'coded-set code CHECK ^[a-z0-9_]{1,64}$');
SELECT alike(pg_temp.a(format($$ INSERT INTO lab.cs_rejection_reasons (id, tenant_id, code, display, created_by, updated_by) VALUES (%L, %L, 'zz_t1', 'dup', %L, %L) $$, pg_temp.uid(211), pg_temp.ta(), pg_temp.sys(), pg_temp.sys())),
  'E23505|%cs_rejection_reasons__tenant_id_code__uq%', 'unique (tenant_id, code)');

-- ===================================================================================================================================== C5 check 10: published views
SELECT is(pg_temp.a('SELECT 1 FROM lab.v_pub_specimen_timeline', 'n'), 'n=4', 'C5 check 10: v_pub_specimen_timeline: tenant A sees its 4 specimens');
SELECT is(pg_temp.b('SELECT 1 FROM lab.v_pub_specimen_timeline', 'n'), 'n=1', 'C5 check 10: v_pub_specimen_timeline: tenant B sees its own only');
SELECT is(pg_temp.dev(pg_temp.id('00000000a201'), 'SELECT 1 FROM lab.v_pub_specimen_timeline'), 'n=2', 'C5 check 10: views follow the centre RLS (security_invoker)');
SELECT is(pg_temp.a($$ SELECT 1 FROM lab.v_pub_specimen_timeline WHERE specimen_id = '$$ || pg_temp.uid(31) || $$' AND status = 'received' AND specimen_version = 1 AND replaces_specimen_id IS NULL $$, 'n'), 'n=1', 'specimen_version = specimens.version');
SELECT is(pg_temp.a('SELECT 1 FROM lab.v_pub_pending_items WHERE item_status = ''awaiting_receipt'' AND age_seconds >= 0', 'n'), 'n=1', 'v_pub_pending_items lists the awaiting_receipt order test');
SELECT is(pg_temp.a($$ SELECT 1 FROM lab.v_pub_rejection_daily WHERE reason_code = 'haemolysed' AND rejections = 1 AND recollections_ordered = 1 AND centre_id = '$$ || pg_temp.id('00000000a202') || $$' $$, 'n'), 'n=1', 'v_pub_rejection_daily aggregates the rejected specimen');
SELECT is(pg_temp.a('SELECT 1 FROM lab.v_pub_result_daily WHERE results_resulted >= 1 AND results_approved = 0 AND centre_id = ''' || pg_temp.id('00000000a201') || '''', 'n') <> 'n=0', true, 'v_pub_result_daily counts resulted results');
SELECT is(pg_temp.b('SELECT 1 FROM lab.v_pub_result_daily', 'n'), 'n=0', 'v_pub_result_daily: tenant B sees none of A''s results');
SELECT is(pg_temp.a($$ SELECT value_numeric FROM lab.v_pub_qc_result WHERE control_id_raw = 'QC-L1' $$, 's'), '4.9', 'v_pub_qc_result.value_numeric is a text decimal');
SELECT is(pg_temp.dev(pg_temp.id('00000000a201'), 'SELECT 1 FROM lab.v_pub_qc_result'), 'n=1', 'v_pub_qc_result follows centre RLS');
SELECT pg_temp.a('UPDATE lab.results SET current_version_no = 1 WHERE id = ' || quote_literal(pg_temp.uid(51)));
SELECT is(pg_temp.a('SELECT 1 FROM lab.v_result_current WHERE id = ''' || pg_temp.uid(51) || ''' AND cur_value_numeric = 5.1 AND cur_approved_at IS NOT NULL', 'n'), 'n=1', 'v_result_current joins the current version of an approved result');
SELECT is(pg_temp.a('SELECT 1 FROM lab.v_result_current WHERE id = ''' || pg_temp.uid(53) || ''' AND cur_value_numeric IS NULL', 'n'), 'n=1', 'v_result_current: non-approved result has no current version columns');

-- ===================================================================================================================================== C5 check 11: audit rows (AC-0B-5.1)
SELECT cmp_ok((SELECT count(*)::int FROM audit.audit_log WHERE schema_name = 'lab' AND table_name = 'results' AND row_id = pg_temp.uid(51)), '>=', 2, 'C5 check 11 / AC-0B-5.1: results INSERT + UPDATE audited');
SELECT is((SELECT count(*)::int FROM audit.audit_log WHERE schema_name = 'lab' AND table_name = 'specimens' AND row_id = pg_temp.uid(32) AND action = 'UPDATE' AND 'status' = ANY (changed_columns)), 1, 'C5 check 11: specimen status change audited');
SELECT is((SELECT array_agg(c ORDER BY c) FROM audit.audit_log a, unnest(a.changed_columns) c WHERE a.schema_name = 'lab' AND a.table_name = 'specimens' AND a.row_id = pg_temp.uid(32) AND a.action = 'UPDATE'),
  ARRAY['collected_at','status'], 'C5 check 11 / AC-0B-5.2: changed_columns lists exactly the changed columns (version / updated_* excluded)');
SELECT is((SELECT array_agg(k ORDER BY k) FROM audit.audit_log a, jsonb_object_keys(a.old_values) k WHERE a.schema_name = 'lab' AND a.table_name = 'specimens' AND a.row_id = pg_temp.uid(32) AND a.action = 'UPDATE'),
  ARRAY['collected_at','status'], 'C5 check 11 / AC-0B-5.2: old_values contains only the changed columns');
SELECT is((SELECT count(*)::int FROM audit.audit_log WHERE schema_name = 'lab' AND table_name IN ('qc_results','specimen_transitions','result_observations','verifications','approvals','report_releases','module_submissions')), 0, 'C5 check 11: class A tables are not audited');
SELECT is((SELECT count(*)::int FROM audit.audit_log WHERE schema_name = 'lab' AND table_name = 'lab_settings'), 2, 'C5 check 11: lab_settings (no id column) audited without error');
SELECT alike(pg_temp.a(format($$ INSERT INTO audit.audit_log (id, tenant_id, schema_name, table_name, action, actor_type) VALUES (%L, %L, 'x', 'y', 'INSERT', 'user') $$, pg_temp.uid(401), pg_temp.ta())), 'E42501|%', 'AC-0B-5.3: lims_app INSERT INTO audit.audit_log fails');

-- ===================================================================================================================================== C5 check 12: qc_results centre scope (own policy set, centre_id only)
SELECT is(pg_temp.dev(pg_temp.id('00000000a201'), 'SELECT 1 FROM lab.qc_results'), 'n=1', 'C5 check 12: a201 actor sees its QC result only');
SELECT is(pg_temp.dev(pg_temp.id('00000000a202'), 'SELECT 1 FROM lab.qc_results'), 'n=1', 'C5 check 12: a202 actor sees its QC result only');
SELECT alike(pg_temp.dev(pg_temp.id('00000000a201'), format($$ INSERT INTO lab.qc_results (id, tenant_id, centre_id, instrument_id, control_id_raw, value_raw, received_at, source, idempotency_key, created_by)
  VALUES (%L, %L, %L, %L, 'QC-L1', '1', now(), 'instrument', 'qc-new', %L) $$, pg_temp.uid(212), pg_temp.ta(), pg_temp.id('00000000a202'), pg_temp.uid(96), pg_temp.sys()), 'w'), 'E42501|%', 'C5 check 12: a201 actor cannot insert a QC result for a202');
SELECT is(pg_temp.dev(pg_temp.id('00000000a201'), format($$ INSERT INTO lab.qc_results (id, tenant_id, centre_id, instrument_id, control_id_raw, value_raw, received_at, source, idempotency_key, created_by)
  VALUES (%L, %L, %L, %L, 'QC-L1', '1', now(), 'instrument', 'qc-new2', %L) $$, pg_temp.uid(213), pg_temp.ta(), pg_temp.id('00000000a201'), pg_temp.uid(96), pg_temp.sys()), 'w'), 'n=1', 'C5 check 12: a201 actor inserts a QC result for its own centre');
SELECT alike(pg_temp.a(format($$ INSERT INTO lab.qc_results (id, tenant_id, centre_id, instrument_id, control_id_raw, value_raw, received_at, source, idempotency_key, created_by)
  VALUES (%L, %L, %L, %L, 'QC-L1', '1', now(), 'manual', 'qc-m', %L) $$, pg_temp.uid(214), pg_temp.ta(), pg_temp.id('00000000a201'), pg_temp.uid(96), pg_temp.sys())), 'E23514|%qc_results__manual__ck%', 'manual QC result needs the entering membership and analyte');

SELECT * FROM finish();
ROLLBACK;
