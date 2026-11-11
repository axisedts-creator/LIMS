-- C5 T-03 fixtures for the repository integration tests (synthetic data only; fresh migrated + seeded database, superuser session).
-- Same technique as db/tests/lab/T0B-10.C5_behaviour.test.sql: rows are inserted by the superuser (RLS bypassed) with the core system actor's claims set so the audit triggers have a context.
-- Tenants/branches/centres/memberships come from db/seeds/010 (tenant A ...a001, tenant B ...b001; branches a101/b101; centres a201/a202/b201; memberships a500/b500).
-- Shape (ids via pg_temp.uid(n)):
--   tenant A: patient 1; frontdesk orders 11 (a201), 12 (a202), 14 (a201, registration 'R-REG-777'); item 21; lab.orders 11,12,14
--             specimens 31 'E2600000001' received, 32 'E2600000002' ordered, 33 'E2600000003' ordered (order 12), created_at 3 min apart (31 oldest)
--             order_tests 41 (dept 97) + 400 bulk ids 1001..1400 over 20 departments uid(100..119), status cycles by i%6, test ids 7001..7400
--             results 400 bulk ids 2001..2400 (order_test 1000+i, analyte uid(5001 + i%40), patient 1): i%3=0 approved (approved_at = now - i hours), =1 resulted, =2 pending
--             delta rule 8001 (analyte 5001, active), lab_settings, barcode_counters last_value 5
--   tenant B: patient 2; order 13; item 22; specimen 35 with the SAME barcode 'E2600000001'; order_test 42 (dept 97) and bulk-free; approved result 4001 (analyte 5001, patient 2)
--             delta rule 8002 (same analyte 5001), lab_settings; NO barcode_counters row (first use)
BEGIN;
SET search_path = extensions, public, pg_catalog;

CREATE FUNCTION pg_temp.ta() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1a98a-ac40-7000-8000-00000000a001'::uuid $$;
CREATE FUNCTION pg_temp.tb() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1a98a-ac40-7000-8000-00000000b001'::uuid $$;
CREATE FUNCTION pg_temp.sys() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1b34e-1000-7eee-9d29-d7ca59a102b5'::uuid $$;
CREATE FUNCTION pg_temp.uid(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('0190c503-0000-7000-8000-' || lpad(n::text, 12, '0'))::uuid $$;
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

-- ---------------------------------------------------------------- frontdesk parents
SELECT pg_temp.ins('frontdesk.patients', jsonb_build_object('id', pg_temp.uid(1), 'tenant_id', pg_temp.ta(), 'patient_code', 'P-0001', 'full_name', 'Test Patient 0001', 'name_search', 'test patient 0001', 'sex', 'female', 'registered_centre_id', pg_temp.id('00000000a201')));
SELECT pg_temp.ins('frontdesk.patients', jsonb_build_object('id', pg_temp.uid(2), 'tenant_id', pg_temp.tb(), 'patient_code', 'P-0001', 'full_name', 'Test Patient 0002', 'name_search', 'test patient 0002', 'sex', 'male', 'registered_centre_id', pg_temp.id('00000000b201')));
SELECT pg_temp.ins('frontdesk.orders', jsonb_build_object('id', pg_temp.uid(o.n), 'tenant_id', o.t, 'branch_id', o.br, 'centre_id', o.c, 'patient_id', o.p, 'registration_no', o.reg, 'status', 'registered', 'visit_type', 'opd',
    'billing_mode', 'cash', 'priority', 'routine', 'collection_mode', 'walk_in', 'source', 'front_desk', 'is_first_order_of_patient', true, 'catalog_revision', 1, 'registered_at', now()))
  FROM (VALUES (11, pg_temp.ta(), pg_temp.id('00000000a101'), pg_temp.id('00000000a201'), pg_temp.uid(1), 'R-11'),
               (12, pg_temp.ta(), pg_temp.id('00000000a101'), pg_temp.id('00000000a202'), pg_temp.uid(1), 'R-12'),
               (14, pg_temp.ta(), pg_temp.id('00000000a101'), pg_temp.id('00000000a201'), pg_temp.uid(1), 'R-REG-777'),
               (13, pg_temp.tb(), pg_temp.id('00000000b101'), pg_temp.id('00000000b201'), pg_temp.uid(2), 'R-13')) o(n, t, br, c, p, reg);
SELECT pg_temp.ins('frontdesk.order_items', jsonb_build_object('id', pg_temp.uid(i.n), 'tenant_id', i.t, 'order_id', pg_temp.uid(i.o), 'centre_id', i.c, 'orderable_id', pg_temp.uid(99), 'orderable_kind', 'test',
    'code', 'CBC', 'name', 'CBC (SYNTHETIC)', 'test_ids', jsonb_build_array(pg_temp.uid(99)), 'priority', 'routine', 'unit_price_paisa', 1000, 'price_list_id', pg_temp.uid(98), 'price_list_version', 1,
    'price_source', 'tenant_default', 'vat_treatment', 'exempt', 'added_in_items_version', 1))
  FROM (VALUES (21, pg_temp.ta(), 11, pg_temp.id('00000000a201')), (22, pg_temp.tb(), 13, pg_temp.id('00000000b201'))) i(n, t, o, c);

-- ---------------------------------------------------------------- lab.orders
SELECT pg_temp.ins('lab.orders', jsonb_build_object('id', pg_temp.uid(o.n), 'tenant_id', o.t, 'centre_id', o.c, 'branch_id', o.br, 'patient_id', o.p, 'registration_no', o.reg, 'visit_type', 'opd', 'priority', 'routine',
    'source', 'front_desk', 'registered_at', now() - make_interval(mins => o.n), 'patient_sex', 'female', 'last_order_seq', 1))
  FROM (VALUES (11, pg_temp.ta(), pg_temp.id('00000000a101'), pg_temp.id('00000000a201'), pg_temp.uid(1), 'R-11'),
               (12, pg_temp.ta(), pg_temp.id('00000000a101'), pg_temp.id('00000000a202'), pg_temp.uid(1), 'R-12'),
               (14, pg_temp.ta(), pg_temp.id('00000000a101'), pg_temp.id('00000000a201'), pg_temp.uid(1), 'R-REG-777'),
               (13, pg_temp.tb(), pg_temp.id('00000000b101'), pg_temp.id('00000000b201'), pg_temp.uid(2), 'R-13')) o(n, t, br, c, p, reg);

-- ---------------------------------------------------------------- specimens (31 is the oldest by created_at)
SELECT pg_temp.ins('lab.specimens', jsonb_build_object('id', pg_temp.uid(s.n), 'tenant_id', s.t, 'centre_id', s.c, 'order_id', s.o, 'patient_id', s.p, 'barcode', s.bc, 'creation_key', 'ck-' || s.n,
    'specimen_type_code', 'serum', 'priority', 'routine', 'patient_sex', 'female', 'status', s.st, 'ordered_at', now(), 'created_at', now() - make_interval(mins => s.age)) || s.x)
  FROM (VALUES (31, pg_temp.ta(), pg_temp.id('00000000a201'), pg_temp.uid(11), pg_temp.uid(1), 'E2600000001', 'received', 3, jsonb_build_object('processing_centre_id', pg_temp.id('00000000a202'), 'processing_branch_id', pg_temp.id('00000000a101'), 'received_at', now())),
               (32, pg_temp.ta(), pg_temp.id('00000000a201'), pg_temp.uid(11), pg_temp.uid(1), 'E2600000002', 'ordered', 2, '{}'::jsonb),
               (33, pg_temp.ta(), pg_temp.id('00000000a202'), pg_temp.uid(12), pg_temp.uid(1), 'E2600000003', 'ordered', 1, '{}'::jsonb),
               (35, pg_temp.tb(), pg_temp.id('00000000b201'), pg_temp.uid(13), pg_temp.uid(2), 'E2600000001', 'ordered', 1, '{}'::jsonb)) s(n, t, c, o, p, bc, st, age, x);

-- ---------------------------------------------------------------- order tests: 41 (A), 42 (B), 400 bulk (A)
SELECT pg_temp.ins('lab.order_tests', jsonb_build_object('id', pg_temp.uid(41), 'tenant_id', pg_temp.ta(), 'centre_id', pg_temp.id('00000000a201'), 'processing_centre_id', pg_temp.id('00000000a202'), 'processing_branch_id', pg_temp.id('00000000a101'),
  'order_id', pg_temp.uid(11), 'order_item_id', pg_temp.uid(21), 'test_id', pg_temp.uid(99), 'test_code', 'CBC', 'test_revision', 1, 'catalog_revision', 1, 'department_id', pg_temp.uid(97), 'workflow_type', 'standard',
  'priority', 'routine', 'specimen_id', pg_temp.uid(31), 'status', 'in_process', 'ordered_at', now()));
SELECT pg_temp.ins('lab.order_tests', jsonb_build_object('id', pg_temp.uid(42), 'tenant_id', pg_temp.tb(), 'centre_id', pg_temp.id('00000000b201'), 'processing_centre_id', pg_temp.id('00000000b201'), 'processing_branch_id', pg_temp.id('00000000b101'),
  'order_id', pg_temp.uid(13), 'order_item_id', pg_temp.uid(22), 'test_id', pg_temp.uid(99), 'test_code', 'CBC', 'test_revision', 1, 'catalog_revision', 1, 'department_id', pg_temp.uid(100), 'workflow_type', 'standard',
  'priority', 'routine', 'specimen_id', pg_temp.uid(35), 'status', 'in_process', 'ordered_at', now()));
SELECT pg_temp.ins('lab.order_tests', jsonb_build_object('id', pg_temp.uid(1000 + i), 'tenant_id', pg_temp.ta(), 'centre_id', pg_temp.id('00000000a201'), 'processing_centre_id', pg_temp.id('00000000a202'), 'processing_branch_id', pg_temp.id('00000000a101'),
  'order_id', pg_temp.uid(11), 'order_item_id', pg_temp.uid(21), 'test_id', pg_temp.uid(7000 + i), 'test_code', 'T' || i, 'test_revision', 1, 'catalog_revision', 1, 'department_id', pg_temp.uid(100 + i % 20), 'workflow_type', 'standard',
  'priority', CASE WHEN i % 7 = 0 THEN 'urgent' ELSE 'routine' END, 'specimen_id', pg_temp.uid(31),
  'status', (ARRAY['awaiting_receipt', 'in_process', 'resulted', 'verified', 'approved', 'cancelled'])[i % 6 + 1],
  'ordered_at', now() - make_interval(mins => i), 'received_at', now() - make_interval(mins => i)))
  FROM generate_series(1, 400) i;

-- ---------------------------------------------------------------- results: 400 bulk (A) + 4001 (B, approved)
SELECT pg_temp.ins('lab.results', jsonb_build_object('id', pg_temp.uid(2000 + i), 'tenant_id', pg_temp.ta(), 'centre_id', pg_temp.id('00000000a201'), 'processing_centre_id', pg_temp.id('00000000a202'), 'processing_branch_id', pg_temp.id('00000000a101'),
    'order_id', pg_temp.uid(11), 'order_item_id', pg_temp.uid(21), 'order_test_id', pg_temp.uid(1000 + i), 'specimen_id', pg_temp.uid(31), 'patient_id', pg_temp.uid(1), 'test_id', pg_temp.uid(7000 + i),
    'analyte_id', pg_temp.uid(5001 + i % 40), 'analyte_code', 'AN' || (i % 40), 'department_id', pg_temp.uid(100 + i % 20), 'is_reportable', true, 'result_type', 'numeric',
    'status', (ARRAY['approved', 'resulted', 'pending'])[i % 3 + 1])
    || CASE i % 3
         WHEN 0 THEN jsonb_build_object('origin', 'manual', 'value_numeric', 5.1, 'flag', 'N', 'first_resulted_at', now(), 'resulted_at', now() - make_interval(mins => i), 'approved_at', now() - make_interval(hours => i), 'approved_by_membership_id', pg_temp.id('00000000a500'))
         WHEN 1 THEN jsonb_build_object('origin', 'manual', 'value_numeric', 4.2, 'flag', 'L', 'first_resulted_at', now(), 'resulted_at', now() - make_interval(mins => i))
         ELSE '{}'::jsonb END)
  FROM generate_series(1, 400) i;
SELECT pg_temp.ins('lab.results', jsonb_build_object('id', pg_temp.uid(4001), 'tenant_id', pg_temp.tb(), 'centre_id', pg_temp.id('00000000b201'), 'processing_centre_id', pg_temp.id('00000000b201'), 'processing_branch_id', pg_temp.id('00000000b101'),
    'order_id', pg_temp.uid(13), 'order_item_id', pg_temp.uid(22), 'order_test_id', pg_temp.uid(42), 'specimen_id', pg_temp.uid(35), 'patient_id', pg_temp.uid(2), 'test_id', pg_temp.uid(99),
    'analyte_id', pg_temp.uid(5001), 'analyte_code', 'AN0', 'department_id', pg_temp.uid(100), 'is_reportable', true, 'result_type', 'numeric', 'status', 'approved', 'origin', 'manual', 'value_numeric', 9.9, 'flag', 'H',
    'first_resulted_at', now(), 'resulted_at', now(), 'approved_at', now(), 'approved_by_membership_id', pg_temp.id('00000000b500')));

-- ---------------------------------------------------------------- delta rules, settings, counters
SELECT pg_temp.ins('lab.delta_check_rules', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', r.t, 'rule_id', pg_temp.uid(r.n + 100), 'rule_version', 1, 'analyte_id', pg_temp.uid(5001), 'unit_code', 'g/dL',
    'window_seconds', 86400, 'abs_threshold', 2, 'effective_from', now() - interval '1 day'))
  FROM (VALUES (8001, pg_temp.ta()), (8002, pg_temp.tb())) r(n, t);
SELECT pg_temp.ins('lab.lab_settings', jsonb_build_object('tenant_id', pg_temp.ta()));
SELECT pg_temp.ins('lab.lab_settings', jsonb_build_object('tenant_id', pg_temp.tb()));
SELECT pg_temp.ins('lab.barcode_counters', jsonb_build_object('tenant_id', pg_temp.ta(), 'last_value', 5));

ANALYZE lab.orders; ANALYZE lab.specimens; ANALYZE lab.order_tests; ANALYZE lab.results; ANALYZE lab.delta_check_rules;
COMMIT;
