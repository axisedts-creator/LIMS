-- T0B-10.C4 behaviour suite: tenant / centre isolation, staff guard, immutability triggers, audit exclusion, DEFINER purge, ledger CHECKs, views (C4 05-SCHEMA §9 tests 3, 5-9;
-- AC-0B-2.4, 3.1-3.5, 3.7, 4.1, 5.1, 5.3, 6.4). The generated per-table probes (db/tests/isolation/{frontdesk,billing}.<t>.test.sql) are the AC-0B-3.x proof for every table;
-- this file proves what the generator cannot know: TCN NULL-centre rows, guard triggers, purge_trf_drafts under FORCE RLS, patients audit exclusion, ledger CHECKs, views.
-- Synthetic data only (seeds 010: tenant A 01a1a98a-...-a001, tenant B ...-b001; branches a101/b101; centres a201/a202/b201; memberships a500/b500). One rolled-back transaction.
-- RLS is never disabled: fixtures are inserted by the superuser test session (bypasses RLS) with the core system actor's claims set so app.tg_row_audit has an audit context;
-- every assertion runs as SET LOCAL ROLE lims_app (or lims_worker / lims_owner for the DEFINER tests).
-- Run from the repo root: pg_prove -d <db> db/tests/frontdesk_billing/T0B-10.C4_behaviour.test.sql   (pgTAP in schema `extensions`; migrations + seeds loaded; superuser)
-- Coverage map (C4 05-SCHEMA §9):
-- §9 test 3: purge_trf_drafts FORCE-RLS tests (a) expired drafts of the claimed tenant only, (b) lims_app that sets app.maintenance itself deletes / sees nothing, (c) app.maintenance is '' after return
-- §9 test 5: RLS probes incl. TCN NULL-centre rows invisible to a centre-scoped actor (AC-0B-3.1 .. 3.5, 3.7)
-- §9 test 6: direct UPDATE billing.invoices SET net_paisa -> immutable_row; fiscal_counters last_no + 2 -> guard error; cancelled invoice back to issued -> guard error (AC-0B-4.1)
-- §9 test 7: ledger_entries collector CHECK (08 R8); v_pub_payment_collection exposes payment_method_code (08 R4)
-- §9 test 8: partner / portal / patient claims see 0 rows in every frontdesk / billing table
-- §9 test 9: finance_review_items kind CHECK (D-128); centre-scoped SELECT without "operator does not exist: uuid = uuid[]" (08 A16.1)
BEGIN;
SET search_path = extensions, public, pg_catalog;
SELECT * FROM no_plan();

CREATE FUNCTION pg_temp.ta() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1a98a-ac40-7000-8000-00000000a001'::uuid $$;
CREATE FUNCTION pg_temp.tb() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1a98a-ac40-7000-8000-00000000b001'::uuid $$;
CREATE FUNCTION pg_temp.sys() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1b34e-1000-7eee-9d29-d7ca59a102b5'::uuid $$;
CREATE FUNCTION pg_temp.uid(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('0190c400-0000-7000-8000-' || lpad(n::text, 12, '0'))::uuid $$;
CREATE FUNCTION pg_temp.id(s text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('01a1a98a-ac40-7000-8000-' || s)::uuid $$;      -- seed ids: '00000000a101' ...
SELECT set_config('request.jwt.claims', jsonb_build_object('tenant_id', pg_temp.ta(), 'sub', pg_temp.sys(), 'actor_type', 'system')::text, true);

-- insert only the keys of p_row; created_by / updated_by added when the table has them
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
-- run p_sql as p_role with p_claims (p_pre runs first in the same role, e.g. set_config); mode n = count of a query, w = ROW_COUNT of a statement, s = the single scalar result; errors -> 'E' || SQLSTATE || '|' || SQLERRM
CREATE FUNCTION pg_temp.x(p_role text, p_claims jsonb, p_sql text, p_mode text DEFAULT 'n', p_pre text DEFAULT NULL) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE r text; n bigint; saved text := current_setting('request.jwt.claims', true);
BEGIN
  PERFORM set_config('request.jwt.claims', coalesce(p_claims::text, ''), true);
  EXECUTE format('SET LOCAL ROLE %I', p_role);
  BEGIN
    IF p_pre IS NOT NULL THEN EXECUTE p_pre; END IF;
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
-- claims: tenant staff of type p_type (user | system | device | partner | portal | patient); p_centre only for device (app.current_centre_ids reads claims.centre_id)
CREATE FUNCTION pg_temp.cl(p_tenant uuid, p_type text DEFAULT 'system', p_centre uuid DEFAULT NULL) RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('actor_type', p_type, 'tenant_id', p_tenant, 'sub', pg_temp.sys(),
    'membership_id', CASE WHEN p_tenant = pg_temp.ta() THEN '01a1a98a-ac40-7000-8000-00000000a500' ELSE '01a1a98a-ac40-7000-8000-00000000b500' END::uuid)
    || CASE WHEN p_centre IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('centre_id', p_centre) END $$;
CREATE FUNCTION pg_temp.a(p_sql text, p_mode text DEFAULT 'w') RETURNS text LANGUAGE sql AS $$ SELECT pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta()), p_sql, p_mode) $$;      -- tenant A, all centres (system)
CREATE FUNCTION pg_temp.b(p_sql text, p_mode text DEFAULT 'w') RETURNS text LANGUAGE sql AS $$ SELECT pg_temp.x('lims_app', pg_temp.cl(pg_temp.tb()), p_sql, p_mode) $$;
CREATE FUNCTION pg_temp.dev(p_centre uuid, p_sql text, p_mode text DEFAULT 'n') RETURNS text LANGUAGE sql AS $$ SELECT pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), 'device', p_centre), p_sql, p_mode) $$;
-- INSERT text copying tenant-B row (selected by p_where) with overrides, to be run as tenant A (cross-tenant insert probe); evaluated by the superuser BEFORE the role switch
CREATE FUNCTION pg_temp.cpb(p_tbl regclass, p_where text, p_over jsonb) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE j jsonb;
BEGIN
  EXECUTE format('SELECT to_jsonb(t) FROM %s t WHERE %s', p_tbl, p_where) INTO j;
  RETURN format('INSERT INTO %1$s SELECT * FROM jsonb_populate_record(NULL::%1$s, %2$L::jsonb)', p_tbl, (j || p_over)::text);
END $f$;
CREATE FUNCTION pg_temp.inv(p_id uuid, p_tenant uuid, p_branch uuid, p_centre uuid, p_seq int, p_over jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('id', p_id, 'tenant_id', p_tenant, 'branch_id', p_branch, 'centre_id', p_centre, 'series', 'INV', 'fiscal_year_bs', '2083/84', 'invoice_seq', p_seq, 'invoice_no', 'INV-' || p_seq,
    'invoice_kind', 'tax_invoice', 'purpose', 'registration', 'buyer_name', 'Test Patient (SYNTHETIC)', 'seller_name', 'Synthetic Lab', 'issued_at', now() - (4 - p_seq) * interval '1 hour', 'invoice_date_bs', '2083-07-22',
    'gross_paisa', 1000, 'discount_paisa', 0, 'exempt_paisa', 1000, 'taxable_paisa', 0, 'vat_paisa', 0, 'other_tax_paisa', 0, 'net_paisa', 1000, 'prices_include_tax', false,
    'quote_fingerprint', repeat('a', 64), 'cbms_state', 'not_required') || p_over $$;

-- ===================================================================================================================================== fixtures (superuser, system claims)
SELECT pg_temp.ins('frontdesk.patients', jsonb_build_object('id', pg_temp.uid(1), 'tenant_id', pg_temp.ta(), 'patient_code', 'P-0001', 'full_name', 'Test Patient 0001', 'name_search', 'test patient 0001', 'sex', 'female', 'registered_centre_id', pg_temp.id('00000000a201')));
SELECT pg_temp.ins('frontdesk.patients', jsonb_build_object('id', pg_temp.uid(2), 'tenant_id', pg_temp.tb(), 'patient_code', 'P-0001', 'full_name', 'Test Patient 0002', 'name_search', 'test patient 0002', 'sex', 'male', 'registered_centre_id', pg_temp.id('00000000b201')));
-- orders: oA1 registered @a201, oA2 registered @a202, oB1 @b201, oC cancelled @a201, oP pre_registered @a201
SELECT pg_temp.ins('frontdesk.orders', jsonb_build_object('id', pg_temp.uid(o.n), 'tenant_id', o.t, 'branch_id', o.br, 'centre_id', o.c, 'patient_id', o.p, 'registration_no', 'R-' || o.n, 'status', o.st, 'visit_type', 'opd', 'billing_mode', 'cash',
    'priority', 'routine', 'collection_mode', 'walk_in', 'source', 'front_desk', 'is_first_order_of_patient', true, 'catalog_revision', 1)
  || CASE WHEN o.st = 'registered' THEN jsonb_build_object('registered_at', now()) WHEN o.st = 'cancelled' THEN jsonb_build_object('cancelled_at', now(), 'cancel_reason_code', 'other') ELSE '{}'::jsonb END)
  FROM (VALUES (11, pg_temp.ta(), pg_temp.id('00000000a101'), pg_temp.id('00000000a201'), pg_temp.uid(1), 'registered'), (12, pg_temp.ta(), pg_temp.id('00000000a101'), pg_temp.id('00000000a202'), pg_temp.uid(1), 'registered'),
         (13, pg_temp.tb(), pg_temp.id('00000000b101'), pg_temp.id('00000000b201'), pg_temp.uid(2), 'registered'), (14, pg_temp.ta(), pg_temp.id('00000000a101'), pg_temp.id('00000000a201'), pg_temp.uid(1), 'cancelled'),
         (15, pg_temp.ta(), pg_temp.id('00000000a101'), pg_temp.id('00000000a201'), pg_temp.uid(1), 'pre_registered')) o(n, t, br, c, p, st);
SELECT pg_temp.ins('frontdesk.order_items', jsonb_build_object('id', pg_temp.uid(21 + i.k), 'tenant_id', pg_temp.ta(), 'order_id', pg_temp.uid(11), 'centre_id', pg_temp.id('00000000a201'), 'orderable_id', pg_temp.uid(99), 'orderable_kind', 'test',
    'code', 'CBC', 'name', 'CBC (SYNTHETIC)', 'test_ids', jsonb_build_array(pg_temp.uid(99)), 'priority', 'routine', 'unit_price_paisa', 1000, 'price_list_id', pg_temp.uid(98), 'price_list_version', 1,
    'price_source', 'tenant_default', 'vat_treatment', 'exempt', 'added_in_items_version', 1)
  || CASE WHEN i.k = 1 THEN jsonb_build_object('status', 'removed', 'removed_at', now(), 'removal_reason_code', 'other') ELSE '{}'::jsonb END) FROM (VALUES (0), (1)) i(k);   -- 21 active, 22 removed
-- TRF attachments: 31 old draft A, 32 recent draft A, 33 old draft B, 34 old LINKED A, 35 quarantined A, 36 clean A, 37 recent draft A (for the link test)
SELECT pg_temp.ins('frontdesk.trf_attachments', jsonb_build_object('id', pg_temp.uid(t.n), 'tenant_id', t.tn, 'centre_id', t.c, 'object_path', t.tn::text || '/2026/11/' || pg_temp.uid(t.n)::text, 'mime_type', 'application/pdf',
    'size_bytes', 100, 'sha256', repeat('a', 64), 'scan_state', t.ss, 'created_at', now() - t.age) || CASE WHEN t.linked THEN jsonb_build_object('order_id', pg_temp.uid(11)) ELSE '{}'::jsonb END)
  FROM (VALUES (31, pg_temp.ta(), pg_temp.id('00000000a201'), 'pending', interval '3 days', false), (32, pg_temp.ta(), pg_temp.id('00000000a201'), 'pending', interval '1 minute', false),
               (33, pg_temp.tb(), pg_temp.id('00000000b201'), 'pending', interval '3 days', false), (34, pg_temp.ta(), pg_temp.id('00000000a201'), 'pending', interval '3 days', true),
               (35, pg_temp.ta(), pg_temp.id('00000000a201'), 'quarantined', interval '1 minute', false), (36, pg_temp.ta(), pg_temp.id('00000000a201'), 'clean', interval '1 minute', false),
               (37, pg_temp.ta(), pg_temp.id('00000000a201'), 'pending', interval '1 minute', false)) t(n, tn, c, ss, age, linked);
-- billing: counters, invoices (i1 @a201 issued, i2 periodic NULL centre, i3 cancelled @a202, iB tenant B), ledger (l1 A manual cash 500, lB B), balance, export jobs
SELECT pg_temp.ins('billing.fiscal_counters', jsonb_build_object('tenant_id', pg_temp.ta(), 'series', 'INV', 'fiscal_year_bs', '2083/84', 'last_no', 1));
SELECT pg_temp.ins('billing.fiscal_counters', jsonb_build_object('tenant_id', pg_temp.tb(), 'series', 'INV', 'fiscal_year_bs', '2083/84', 'last_no', 1));
SELECT pg_temp.ins('billing.invoices', pg_temp.inv(pg_temp.uid(41), pg_temp.ta(), pg_temp.id('00000000a101'), pg_temp.id('00000000a201'), 1, jsonb_build_object('order_id', pg_temp.uid(11), 'patient_id', pg_temp.uid(1))));
SELECT pg_temp.ins('billing.invoices', pg_temp.inv(pg_temp.uid(44), pg_temp.tb(), pg_temp.id('00000000b101'), pg_temp.id('00000000b201'), 1, jsonb_build_object('order_id', pg_temp.uid(13), 'patient_id', pg_temp.uid(2))));
UPDATE billing.fiscal_counters SET last_no = 2 WHERE tenant_id = pg_temp.ta();
SELECT pg_temp.ins('billing.invoices', pg_temp.inv(pg_temp.uid(42), pg_temp.ta(), pg_temp.id('00000000a101'), NULL, 2, jsonb_build_object('purpose', 'periodic_credit', 'credit_party_id', pg_temp.uid(77), 'is_periodic_credit_bill', true, 'period_month', '2026-11-01')));
UPDATE billing.fiscal_counters SET last_no = 3 WHERE tenant_id = pg_temp.ta();
SELECT pg_temp.ins('billing.invoices', pg_temp.inv(pg_temp.uid(43), pg_temp.ta(), pg_temp.id('00000000a101'), pg_temp.id('00000000a202'), 3, jsonb_build_object('order_id', pg_temp.uid(12), 'patient_id', pg_temp.uid(1),
  'status', 'cancelled', 'is_active', false, 'cancelled_at', now(), 'cancel_reason_code', 'billing_error', 'credit_note_id', pg_temp.uid(78), 'cbms_cancel_state', 'not_required')));
SELECT pg_temp.ins('billing.ledger_entries', jsonb_build_object('id', pg_temp.uid(51), 'tenant_id', pg_temp.ta(), 'branch_id', pg_temp.id('00000000a101'), 'centre_id', pg_temp.id('00000000a201'), 'order_id', pg_temp.uid(11), 'invoice_id', pg_temp.uid(41),
  'entry_kind', 'payment', 'capture_kind', 'manual', 'method_code', 'cash', 'amount_paisa', 500, 'fiscal_year_bs', '2083/84', 'collected_by_membership_id', pg_temp.id('00000000a500'), 'business_date', current_date));
SELECT pg_temp.ins('billing.ledger_entries', jsonb_build_object('id', pg_temp.uid(52), 'tenant_id', pg_temp.tb(), 'branch_id', pg_temp.id('00000000b101'), 'centre_id', pg_temp.id('00000000b201'), 'order_id', pg_temp.uid(13), 'invoice_id', pg_temp.uid(44),
  'entry_kind', 'payment', 'capture_kind', 'manual', 'method_code', 'cash', 'amount_paisa', 700, 'fiscal_year_bs', '2083/84', 'collected_by_membership_id', pg_temp.id('00000000b500'), 'business_date', current_date));
SELECT pg_temp.ins('billing.order_balances', jsonb_build_object('tenant_id', pg_temp.ta(), 'order_id', pg_temp.uid(11), 'centre_id', pg_temp.id('00000000a201'), 'billing_mode', 'cash', 'invoiced_paisa', 1000, 'paid_paisa', 500));
SELECT pg_temp.ins('billing.export_jobs', jsonb_build_object('id', pg_temp.uid(61), 'tenant_id', pg_temp.ta(), 'kind', 'daily_cash', 'format', 'xlsx', 'filters', '{}'::jsonb, 'requested_by_membership_id', pg_temp.id('00000000a500')));
SELECT pg_temp.ins('billing.export_jobs', jsonb_build_object('id', pg_temp.uid(62), 'tenant_id', pg_temp.tb(), 'kind', 'daily_cash', 'format', 'xlsx', 'filters', '{}'::jsonb, 'requested_by_membership_id', pg_temp.id('00000000b500')));
CREATE TEMP TABLE tt(q) AS VALUES ('frontdesk.settings'),('frontdesk.number_counters'),('frontdesk.patients'),('frontdesk.patient_consents'),('frontdesk.orders'),('frontdesk.order_items'),('frontdesk.discount_approvals'),
  ('frontdesk.discounts'),('frontdesk.trf_attachments'),('frontdesk.order_flags'),('frontdesk.booking_links'),('frontdesk.cs_reasons'),('billing.settings'),('billing.fiscal_counters'),('billing.invoices'),('billing.invoice_lines'),
  ('billing.credit_notes'),('billing.credit_note_lines'),('billing.cash_sessions'),('billing.ledger_entries'),('billing.order_balances'),('billing.release_overrides'),('billing.credit_accounts'),('billing.credit_charges'),
  ('billing.credit_note_tasks'),('billing.finance_review_items'),('billing.refund_requests'),('billing.payment_intent_refs'),('billing.print_log'),('billing.activity_log'),('billing.cbms_submissions'),('billing.export_jobs'),
  ('billing.cs_payment_methods'),('billing.cs_reasons');
-- positive controls: the fixtures are visible to tenant A staff (an isolation test on empty data proves nothing)
SELECT is(pg_temp.a('SELECT 1 FROM frontdesk.patients WHERE id = ' || quote_literal(pg_temp.uid(1)), 'n'), 'n=1', 'control: tenant A staff sees its patient');
SELECT is(pg_temp.a('SELECT 1 FROM billing.invoices', 'n'), 'n=3', 'control: tenant A (system, all centres) sees its 3 invoices incl. the NULL-centre periodic one');
SELECT is(pg_temp.a('SELECT 1 FROM frontdesk.trf_attachments', 'n'), 'n=6', 'control: tenant A sees its 6 TRF rows');

-- ===================================================================================================================================== §9 test 8 (AC-0B-3.6a / 3.6b): non-staff actors see nothing
-- §9 test 8: claims with actor_type partner / portal / patient and the tenant id see 0 rows in every frontdesk / billing table
SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), k.t), 'SELECT 1 FROM ' || tt.q, 'n'), 'n=0', '§9 test 8: ' || k.t || ' sees 0 rows of ' || tt.q) FROM tt CROSS JOIN (VALUES ('partner'),('portal'),('patient')) k(t);
SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), 'patient'), $$ SELECT 1 FROM billing.v_pub_order_balance UNION ALL SELECT 1 FROM frontdesk.v_pub_order_status UNION ALL SELECT 1 FROM billing.v_pub_payment_collection $$, 'n'), 'n=0',
  '§9 test 8: patient actor sees 0 rows through the published views (security_invoker)');
-- AC-0B-3.7: no claims at all -> fail closed
SELECT is(pg_temp.x('lims_app', NULL, 'SELECT 1 FROM ' || tt.q, 'n'), 'n=0', 'AC-0B-3.7: no claims -> 0 rows of ' || tt.q) FROM tt;

-- ===================================================================================================================================== §9 test 5: tenant isolation (AC-0B-3.1 .. 3.3, 3.5)
SELECT is(pg_temp.a('SELECT 1 FROM ' || tt.q || ' WHERE tenant_id = ' || quote_literal(pg_temp.tb()), 'n'), 'n=0', 'AC-0B-3.1: tenant A sees 0 tenant-B rows of ' || tt.q) FROM tt;
SELECT is(pg_temp.b('SELECT 1 FROM ' || tt.q || ' WHERE tenant_id = ' || quote_literal(pg_temp.ta()), 'n'), 'n=0', 'AC-0B-3.1: tenant B sees 0 tenant-A rows of ' || tt.q) FROM tt;
SELECT is(pg_temp.b('SELECT 1 FROM billing.invoices', 'n'), 'n=1', 'tenant B sees exactly its own invoice');
-- AC-0B-3.2: INSERT of a row carrying tenant B's id as tenant A -> 42501 (copies of real B rows with fresh keys)
SELECT alike(pg_temp.a(pg_temp.cpb('frontdesk.patients', 'id = ' || quote_literal(pg_temp.uid(2)), jsonb_build_object('id', pg_temp.uid(201), 'patient_code', 'P-X')), 'w'), 'E42501|%', 'AC-0B-3.2: A cannot insert a patient for B');
SELECT alike(pg_temp.a(pg_temp.cpb('frontdesk.orders', 'id = ' || quote_literal(pg_temp.uid(13)), jsonb_build_object('id', pg_temp.uid(202), 'registration_no', 'R-X')), 'w'), 'E42501|%', 'AC-0B-3.2: A cannot insert an order for B');
SELECT alike(pg_temp.a(pg_temp.cpb('billing.ledger_entries', 'id = ' || quote_literal(pg_temp.uid(52)), jsonb_build_object('id', pg_temp.uid(203))), 'w'), 'E42501|%', 'AC-0B-3.2: A cannot insert a ledger entry for B');
SELECT alike(pg_temp.a(pg_temp.cpb('billing.export_jobs', 'id = ' || quote_literal(pg_temp.uid(62)), jsonb_build_object('id', pg_temp.uid(204))), 'w'), 'E42501|%', 'AC-0B-3.2: A cannot insert an export job for B');
-- AC-0B-3.3: UPDATE / DELETE of B rows by A affect 0 rows
SELECT is(pg_temp.a('UPDATE frontdesk.patients SET is_active = false WHERE id = ' || quote_literal(pg_temp.uid(2))), 'n=0', 'AC-0B-3.3: A updates 0 B patients');
SELECT is(pg_temp.a('UPDATE billing.invoices SET print_count = print_count + 1 WHERE id = ' || quote_literal(pg_temp.uid(44))), 'n=0', 'AC-0B-3.3: A updates 0 B invoices');
SELECT is(pg_temp.a('DELETE FROM billing.export_jobs WHERE id = ' || quote_literal(pg_temp.uid(62))), 'n=0', 'AC-0B-3.3: A deletes 0 B export jobs');
SELECT is(pg_temp.a('DELETE FROM billing.export_jobs WHERE id = ' || quote_literal(pg_temp.uid(61))), 'n=1', 'A may DELETE its own export job (class E)');
SELECT alike(pg_temp.a('DELETE FROM billing.invoices WHERE id = ' || quote_literal(pg_temp.uid(41))), 'E42501|%', 'no DELETE grant on invoices (AC-0B-4.2)');
SELECT alike(pg_temp.a('DELETE FROM frontdesk.patients WHERE id = ' || quote_literal(pg_temp.uid(1))), 'E42501|%', 'no DELETE grant on patients (anonymise instead)');
SELECT alike(pg_temp.a('UPDATE billing.ledger_entries SET reason_text = ''x'' WHERE id = ' || quote_literal(pg_temp.uid(51))), 'E42501|%', 'no UPDATE grant on ledger_entries (REQ-SEC-057)');
-- AC-0B-3.5: a child referencing the other tenant's parent id fails (composite FK)
SELECT alike(pg_temp.a(format($$ INSERT INTO frontdesk.order_items (id, tenant_id, order_id, centre_id, orderable_id, orderable_kind, code, name, test_ids, priority, unit_price_paisa, price_list_id, price_list_version, price_source,
  vat_treatment, added_in_items_version, created_by, updated_by) VALUES (%L, %L, %L, %L, %L, 'test', 'X', 'X', ARRAY[%L]::uuid[], 'routine', 1, %L, 1, 'tenant_default', 'exempt', 1, %L, %L) $$,
  pg_temp.uid(205), pg_temp.ta(), pg_temp.uid(13), pg_temp.id('00000000a201'), pg_temp.uid(99), pg_temp.uid(99), pg_temp.uid(98), pg_temp.sys(), pg_temp.sys())), 'E23503|%', 'AC-0B-3.5: order item of A referencing B''s order -> composite FK violation');
SELECT alike(pg_temp.a(format($$ INSERT INTO frontdesk.orders (id, tenant_id, branch_id, centre_id, patient_id, registration_no, status, visit_type, billing_mode, priority, collection_mode, source, is_first_order_of_patient, catalog_revision,
  registered_at, created_by, updated_by) VALUES (%L, %L, %L, %L, %L, 'R-Y', 'registered', 'opd', 'cash', 'routine', 'walk_in', 'front_desk', true, 1, now(), %L, %L) $$,
  pg_temp.uid(206), pg_temp.ta(), pg_temp.id('00000000a101'), pg_temp.id('00000000a201'), pg_temp.uid(2), pg_temp.sys(), pg_temp.sys())), 'E23503|%', 'AC-0B-3.5: order of A for B''s patient -> composite FK violation');

-- ===================================================================================================================================== §9 test 5 / AC-0B-3.4: centre scope, TC and TCN
SELECT is(pg_temp.dev(pg_temp.id('00000000a201'), 'SELECT 1 FROM frontdesk.orders WHERE centre_id = ' || quote_literal(pg_temp.id('00000000a202'))), 'n=0', 'AC-0B-3.4: centre a201 actor sees no a202 order');
SELECT is(pg_temp.dev(pg_temp.id('00000000a201'), 'SELECT 1 FROM frontdesk.orders'), 'n=3', 'centre a201 actor sees its orders (registered, cancelled, pre_registered)');
SELECT is(pg_temp.dev(pg_temp.id('00000000a202'), 'SELECT 1 FROM frontdesk.orders'), 'n=1', 'centre a202 actor sees only its order');
SELECT is(pg_temp.dev(pg_temp.id('00000000a201'), 'SELECT 1 FROM frontdesk.order_items'), 'n=2', 'TC child rows follow the centre');
SELECT is(pg_temp.dev(pg_temp.id('00000000a202'), 'SELECT 1 FROM frontdesk.order_items'), 'n=0', 'TC child rows of another centre are invisible');
SELECT is(pg_temp.dev(pg_temp.id('00000000a201'), 'SELECT 1 FROM frontdesk.patients'), 'n=1', 'patients are tenant-wide (D-PATIENT-SCOPE): visible to a centre-scoped actor');
-- TCN: the NULL-centre periodic invoice is visible only to actors with app.has_all_centres()
SELECT is(pg_temp.dev(pg_temp.id('00000000a201'), 'SELECT 1 FROM billing.invoices WHERE centre_id IS NULL'), 'n=0', '§9 test 5: TCN NULL-centre invoice invisible to a centre-scoped actor');
SELECT is(pg_temp.dev(pg_temp.id('00000000a201'), 'SELECT 1 FROM billing.invoices'), 'n=1', 'centre a201 actor sees only i1');
SELECT is(pg_temp.a('SELECT 1 FROM billing.invoices WHERE centre_id IS NULL', 'n'), 'n=1', '§9 test 5: all-centres actor (system) sees the NULL-centre invoice');
SELECT alike(pg_temp.dev(pg_temp.id('00000000a201'), format($$ INSERT INTO billing.print_log SELECT * FROM jsonb_populate_record(NULL::billing.print_log, jsonb_build_object('tenant_id', %L, 'centre_id', NULL)) $$, pg_temp.ta()), 'w'),
  'E%', 'a centre-scoped actor cannot write a NULL-centre TCN row (rejected: RLS 42501 or NOT NULL, never accepted)');
SELECT is(pg_temp.dev(pg_temp.id('00000000a201'), 'SELECT 1 FROM billing.ledger_entries'), 'n=1', 'ledger entry of centre a201 visible to a201 actor');
SELECT is(pg_temp.dev(pg_temp.id('00000000a202'), 'SELECT 1 FROM billing.ledger_entries'), 'n=0', 'ledger entry of centre a201 invisible to an a202 actor');
-- §9 test 9: the ::uuid[] cast (08 A16.1): a centre-scoped SELECT on every TC / TCN table runs without "operator does not exist: uuid = uuid[]"
SELECT unalike(pg_temp.dev(pg_temp.id('00000000a201'), 'SELECT 1 FROM ' || t.q), 'E%', '§9 test 9: centre-scoped SELECT on ' || t.q || ' raises no operator error')
  FROM (VALUES ('frontdesk.orders'),('frontdesk.order_items'),('frontdesk.discounts'),('frontdesk.discount_approvals'),('frontdesk.trf_attachments'),('frontdesk.order_flags'),('billing.invoices'),('billing.invoice_lines'),
    ('billing.credit_notes'),('billing.credit_note_lines'),('billing.cash_sessions'),('billing.ledger_entries'),('billing.order_balances'),('billing.release_overrides'),('billing.credit_charges'),('billing.credit_note_tasks'),
    ('billing.finance_review_items'),('billing.refund_requests'),('billing.print_log')) t(q);
-- §9 test 9: finance_review_items kind CHECK (D-128)
SELECT is(pg_temp.a(format($$ INSERT INTO billing.finance_review_items (id, tenant_id, centre_id, order_id, kind, ledger_entry_id, amount_paisa, created_by, updated_by)
  VALUES (%L, %L, %L, %L, 'home_payment_method_inactive', %L, 100, %L, %L) $$, pg_temp.uid(301), pg_temp.ta(), pg_temp.id('00000000a201'), pg_temp.uid(11), pg_temp.uid(51), pg_temp.sys(), pg_temp.sys())), 'n=1',
  '§9 test 9: kind = home_payment_method_inactive is accepted (D-128)');
SELECT alike(pg_temp.a(format($$ INSERT INTO billing.finance_review_items (id, tenant_id, centre_id, order_id, kind, ledger_entry_id, amount_paisa, created_by, updated_by)
  VALUES (%L, %L, %L, %L, 'unknown_kind', %L, 100, %L, %L) $$, pg_temp.uid(302), pg_temp.ta(), pg_temp.id('00000000a201'), pg_temp.uid(11), pg_temp.uid(51), pg_temp.sys(), pg_temp.sys())),
  'E23514|%finance_review_items__kind__ck%', '§9 test 9: unknown kind -> CHECK violation finance_review_items__kind__ck');

-- ===================================================================================================================================== §9 test 6 / AC-0B-4.1: immutability triggers
-- §9 test 6: direct UPDATE billing.invoices SET net_paisa = ... as lims_app -> immutable_row; fiscal_counters last_no + 2 -> guard error; cancelled -> issued -> guard error
SELECT alike(pg_temp.a('UPDATE billing.invoices SET net_paisa = net_paisa + 1 WHERE id = ' || quote_literal(pg_temp.uid(41))), 'EP0001|immutable_row%', '§9 test 6 / AC-0B-4.1: UPDATE invoices.net_paisa -> P0001 immutable_row');
SELECT alike(pg_temp.a('UPDATE billing.invoices SET buyer_name = ''Someone Else'' WHERE id = ' || quote_literal(pg_temp.uid(41))), 'EP0001|immutable_row%', 'AC-0B-4.1: UPDATE invoices.buyer_name -> immutable_row');
SELECT alike(pg_temp.a('UPDATE billing.fiscal_counters SET last_no = last_no + 2 WHERE tenant_id = ' || quote_literal(pg_temp.ta())), 'EP0001|immutable_row%', '§9 test 6: fiscal_counters last_no + 2 -> guard error');
SELECT alike(pg_temp.a('UPDATE billing.fiscal_counters SET last_no = last_no - 1 WHERE tenant_id = ' || quote_literal(pg_temp.ta())), 'EP0001|immutable_row%', 'fiscal_counters cannot go backwards (gapless, 04 L7)');
SELECT alike(pg_temp.a('UPDATE billing.invoices SET status = ''issued'', is_active = true WHERE id = ' || quote_literal(pg_temp.uid(43))), 'EP0001|immutable_row%', '§9 test 6: cancelled invoice back to issued -> guard error');
SELECT alike(pg_temp.a('UPDATE billing.invoices SET cancel_reason_code = ''other'' WHERE id = ' || quote_literal(pg_temp.uid(43))), 'EP0001|immutable_row%', 'cancellation columns frozen after the transition');
SELECT alike(pg_temp.a('UPDATE billing.invoices SET print_count = print_count + 2 WHERE id = ' || quote_literal(pg_temp.uid(41))), 'EP0001|immutable_row%', 'print_count may only grow by 1');
SELECT is(pg_temp.a('UPDATE billing.invoices SET print_count = print_count + 1, last_printed_at = now() WHERE id = ' || quote_literal(pg_temp.uid(41))), 'n=1', 'print_count + 1 is the allowed lifecycle update');
SELECT is(pg_temp.a('UPDATE billing.invoices SET cbms_state = ''pending'' WHERE id = ' || quote_literal(pg_temp.uid(41))), 'n=1', 'cbms_state not_required -> pending allowed');
SELECT alike(pg_temp.a('UPDATE billing.invoices SET cbms_state = ''not_required'' WHERE id = ' || quote_literal(pg_temp.uid(41))), 'EP0001|immutable_row%', 'cbms_state pending -> not_required refused');
SELECT is(pg_temp.a('UPDATE billing.fiscal_counters SET last_no = last_no + 1 WHERE tenant_id = ' || quote_literal(pg_temp.ta())), 'n=1', 'fiscal_counters last_no + 1 is allowed');
-- chronology guard (insert-time): a seq that is not the counter's value, or a lower issued_at, raises chronology_violation
SELECT throws_ok(format($$ SELECT pg_temp.ins('billing.invoices', %L::jsonb) $$, pg_temp.inv(pg_temp.uid(45), pg_temp.ta(), pg_temp.id('00000000a101'), pg_temp.id('00000000a201'), 9,
  jsonb_build_object('order_id', pg_temp.uid(14), 'patient_id', pg_temp.uid(1)))::text), 'P0001', 'chronology_violation', 'invoice with a seq that differs from the counter -> chronology_violation');
-- frontdesk.orders
SELECT alike(pg_temp.a('UPDATE frontdesk.orders SET status = ''registered'', registered_at = now() WHERE id = ' || quote_literal(pg_temp.uid(14))), 'EP0001|immutable_row%', 'AC-0B-4.1: cancelled order cannot be re-registered');
SELECT alike(pg_temp.a('UPDATE frontdesk.orders SET registration_no = ''R-HACK'' WHERE id = ' || quote_literal(pg_temp.uid(11))), 'EP0001|immutable_row%', 'AC-0B-4.1: registration_no is not a mutable column');
SELECT alike(pg_temp.a('UPDATE frontdesk.orders SET patient_id = ' || quote_literal(pg_temp.uid(1)) || ', branch_id = ' || quote_literal(pg_temp.id('00000000a102')) || ' WHERE id = ' || quote_literal(pg_temp.uid(11))), 'EP0001|immutable_row%', 'branch_id is immutable');
SELECT alike(pg_temp.a('UPDATE frontdesk.orders SET priority = ''urgent'' WHERE id = ' || quote_literal(pg_temp.uid(11))), 'EP0001|immutable_row%', 'priority frozen once registered');
SELECT is(pg_temp.a('UPDATE frontdesk.orders SET priority = ''urgent'' WHERE id = ' || quote_literal(pg_temp.uid(15))), 'n=1', 'priority editable while pre_registered');
SELECT is(pg_temp.a('UPDATE frontdesk.orders SET status = ''registered'', registered_at = now() WHERE id = ' || quote_literal(pg_temp.uid(15))), 'n=1', 'pre_registered -> registered allowed');
SELECT is(pg_temp.a('UPDATE frontdesk.orders SET status = ''cancelled'', cancelled_at = now(), cancel_reason_code = ''patient_left'' WHERE id = ' || quote_literal(pg_temp.uid(12))), 'n=1', 'registered -> cancelled allowed');
SELECT alike(pg_temp.a('UPDATE frontdesk.orders SET cancel_reason_code = ''other'' WHERE id = ' || quote_literal(pg_temp.uid(12))), 'EP0001|immutable_row%', 'cancelled_* frozen after the transition');
-- order_items, trf_attachments
SELECT alike(pg_temp.a('UPDATE frontdesk.order_items SET status = ''active'', removed_at = NULL, removal_reason_code = NULL WHERE id = ' || quote_literal(pg_temp.uid(22))), 'EP0001|immutable_row%', 'order item removed -> active refused');
SELECT alike(pg_temp.a('UPDATE frontdesk.order_items SET unit_price_paisa = 1 WHERE id = ' || quote_literal(pg_temp.uid(21))), 'EP0001|immutable_row%', 'price snapshot frozen');
SELECT is(pg_temp.a('UPDATE frontdesk.order_items SET status = ''removed'', removed_at = now(), removal_reason_code = ''wrong_test'' WHERE id = ' || quote_literal(pg_temp.uid(21))), 'n=1', 'order item active -> removed allowed');
SELECT alike(pg_temp.a('UPDATE frontdesk.trf_attachments SET order_id = NULL WHERE id = ' || quote_literal(pg_temp.uid(34))), 'EP0001|immutable_row%', 'trf: order_id set once, never cleared');
SELECT alike(pg_temp.a('UPDATE frontdesk.trf_attachments SET scan_state = ''clean'' WHERE id = ' || quote_literal(pg_temp.uid(35))), 'EP0001|immutable_row%', 'trf: quarantined is terminal');
SELECT alike(pg_temp.a('UPDATE frontdesk.trf_attachments SET scan_state = ''pending'' WHERE id = ' || quote_literal(pg_temp.uid(36))), 'EP0001|immutable_row%', 'trf: clean -> pending refused');
SELECT alike(pg_temp.a('UPDATE frontdesk.trf_attachments SET sha256 = repeat(''b'', 64) WHERE id = ' || quote_literal(pg_temp.uid(32))), 'EP0001|immutable_row%', 'trf: sha256 frozen');
SELECT is(pg_temp.a('UPDATE frontdesk.trf_attachments SET scan_state = ''clean'', scanned_at = now() WHERE id = ' || quote_literal(pg_temp.uid(32))), 'n=1', 'trf: pending -> clean allowed');
SELECT is(pg_temp.a('UPDATE frontdesk.trf_attachments SET order_id = ' || quote_literal(pg_temp.uid(11)) || ' WHERE id = ' || quote_literal(pg_temp.uid(37))), 'n=1', 'trf: draft linked to an order once');

-- ===================================================================================================================================== §9 test 7: ledger CHECKs, view column (08 R8, R4)
SELECT throws_ok(format($$ SELECT pg_temp.ins('billing.ledger_entries', %L::jsonb) $$, jsonb_build_object('id', pg_temp.uid(53), 'tenant_id', pg_temp.ta(), 'branch_id', pg_temp.id('00000000a101'), 'order_id', pg_temp.uid(11),
  'entry_kind', 'payment', 'capture_kind', 'gateway', 'gateway', 'esewa', 'gateway_txn_ref', 'T-1', 'intent_id', pg_temp.uid(60), 'method_code', 'esewa', 'amount_paisa', 100, 'fiscal_year_bs', '2083/84',
  'collected_by_membership_id', pg_temp.id('00000000a500'), 'business_date', current_date)::text), '23514', 'new row for relation "ledger_entries" violates check constraint "ledger_entries__collector__ck"',
  '§9 test 7: gateway row with a collector -> ledger_entries__collector__ck');
SELECT throws_ok(format($$ SELECT pg_temp.ins('billing.ledger_entries', %L::jsonb) $$, jsonb_build_object('id', pg_temp.uid(54), 'tenant_id', pg_temp.ta(), 'branch_id', pg_temp.id('00000000a101'), 'order_id', pg_temp.uid(11),
  'entry_kind', 'payment', 'capture_kind', 'manual', 'method_code', 'cash', 'amount_paisa', 100, 'fiscal_year_bs', '2083/84', 'business_date', current_date)::text), '23514',
  'new row for relation "ledger_entries" violates check constraint "ledger_entries__collector__ck"', '§9 test 7: manual row without a collector -> ledger_entries__collector__ck');
SELECT throws_ok(format($$ SELECT pg_temp.ins('billing.ledger_entries', %L::jsonb) $$, jsonb_build_object('id', pg_temp.uid(55), 'tenant_id', pg_temp.ta(), 'branch_id', pg_temp.id('00000000a101'), 'order_id', pg_temp.uid(11),
  'entry_kind', 'payment', 'capture_kind', 'home_collection', 'method_code', 'cash', 'amount_paisa', 100, 'fiscal_year_bs', '2083/84', 'business_date', current_date)::text), '23514',
  'new row for relation "ledger_entries" violates check constraint "ledger_entries__collector__ck"', '§9 test 7: home_collection row without a collector -> ledger_entries__collector__ck');
SELECT throws_ok(format($$ SELECT pg_temp.ins('billing.ledger_entries', %L::jsonb) $$, jsonb_build_object('id', pg_temp.uid(56), 'tenant_id', pg_temp.ta(), 'branch_id', pg_temp.id('00000000a101'), 'order_id', pg_temp.uid(11),
  'entry_kind', 'reversal', 'reverses_entry_id', pg_temp.uid(51), 'reason_code', 'wrong_amount', 'capture_kind', 'manual', 'method_code', 'cash', 'amount_paisa', -499, 'fiscal_year_bs', '2083/84',
  'collected_by_membership_id', pg_temp.id('00000000a500'), 'business_date', current_date)::text), 'P0001', 'reversal_mismatch', 'a reversal that does not mirror its payment -> reversal_mismatch');
SELECT is(pg_temp.a($$ SELECT 1 FROM billing.v_pub_payment_collection WHERE payment_method_code = 'cash' AND gross_collected_paisa = 500 AND net_collected_paisa = 500 AND entries = 1 AND reversals = 0 $$, 'n'), 'n=1',
  '§9 test 7: v_pub_payment_collection exposes payment_method_code and aggregates the fixture payment');
SELECT is(pg_temp.a($$ SELECT 1 FROM billing.v_pub_payment_collection WHERE tenant_id <> '01a1a98a-ac40-7000-8000-00000000a001' $$, 'n'), 'n=0', 'view isolation: tenant A sees no tenant-B collection rows');
SELECT is(pg_temp.dev(pg_temp.id('00000000a202'), 'SELECT 1 FROM billing.v_pub_payment_collection'), 'n=0', 'view isolation: an a202 actor sees no a201 collection');
SELECT is(pg_temp.a('SELECT 1 FROM billing.v_pub_order_balance WHERE paid_paisa = 500 AND balance_due_paisa = 500', 'n'), 'n=1', 'v_pub_order_balance shows the projection with the generated balance_due_paisa');
SELECT is(pg_temp.a('SELECT 1 FROM billing.v_pub_invoice_daily WHERE invoices_issued >= 1', 'n') <> 'n=0', true, 'v_pub_invoice_daily returns rows for tenant A staff');
SELECT is(pg_temp.b('SELECT 1 FROM billing.v_pub_invoice_daily', 'n'), 'n=1', 'v_pub_invoice_daily: tenant B sees its own single day only');
SELECT is(pg_temp.a('SELECT 1 FROM frontdesk.v_pub_order_status', 'n'), 'n=4', 'v_pub_order_status: tenant A sees its 4 orders, none of B');

-- ===================================================================================================================================== AC-0B-5.1 / 5.2: patients audit never copies demographics (08 A13 D-27a)
SELECT is(pg_temp.a('UPDATE frontdesk.patients SET full_name = ''Changed Name'', phone_e164 = ''+9779800000001'', last_visit_at = now() WHERE id = ' || quote_literal(pg_temp.uid(1))), 'n=1', 'patient update (demographics + last_visit_at) succeeds');
SELECT is((SELECT count(*)::int FROM audit.audit_log WHERE schema_name = 'frontdesk' AND table_name = 'patients' AND row_id = pg_temp.uid(1) AND action = 'UPDATE'), 1, 'AC-0B-5.1: exactly one audit row for the update');
SELECT ok((SELECT 'last_visit_at' = ANY (changed_columns) FROM audit.audit_log WHERE schema_name = 'frontdesk' AND table_name = 'patients' AND row_id = pg_temp.uid(1) AND action = 'UPDATE'), 'AC-0B-5.2: last_visit_at is recorded as changed');
SELECT is((SELECT count(*)::int FROM audit.audit_log a WHERE a.schema_name = 'frontdesk' AND a.table_name = 'patients' AND a.row_id = pg_temp.uid(1)
            AND (a.changed_columns && ARRAY['full_name','name_search','birth_on','phone_e164','email','address_text'] OR a.old_values ?| ARRAY['full_name','name_search','birth_on','phone_e164','email','address_text']
                 OR a.new_values ?| ARRAY['full_name','name_search','birth_on','phone_e164','email','address_text'])), 0, 'D-27a: no demographic column in changed_columns / old_values / new_values of any patients audit row');
SELECT is((SELECT count(*)::int FROM audit.audit_log a WHERE a.schema_name = 'frontdesk' AND a.table_name = 'patients' AND (a.old_values::text || coalesce(a.new_values::text, '')) ~ 'Changed Name|Test Patient 000|9779800000001'), 0, 'no demographic VALUE leaks into audit.audit_log');
SELECT is((SELECT count(*)::int FROM audit.audit_log WHERE schema_name = 'frontdesk' AND table_name = 'patients' AND row_id = pg_temp.uid(1) AND action = 'INSERT'), 1, 'patient INSERT audited once (fixture)');
SELECT is((SELECT count(*)::int FROM audit.audit_log WHERE schema_name = 'frontdesk' AND table_name = 'patient_consents'), 0, 'class A patient_consents is not audited');
SELECT is((SELECT count(*)::int FROM audit.audit_log WHERE schema_name = 'billing' AND table_name = 'print_log'), 0, 'class A print_log is not audited');
SELECT cmp_ok((SELECT count(*)::int FROM audit.audit_log WHERE schema_name = 'billing' AND table_name = 'invoices'), '>=', 4, 'invoices are audited (class B)');
-- AC-0B-5.3: lims_app cannot insert audit rows directly
SELECT alike(pg_temp.a(format($$ INSERT INTO audit.audit_log (id, tenant_id, schema_name, table_name, action, actor_type) VALUES (%L, %L, 'x', 'y', 'INSERT', 'user') $$, pg_temp.uid(401), pg_temp.ta())), 'E42501|%', 'AC-0B-5.3: lims_app INSERT INTO audit.audit_log fails');

-- ===================================================================================================================================== §9 test 3 / AC-0B-2.4: purge_trf_drafts under FORCE RLS (08 A10.5)
SELECT is((SELECT relforcerowsecurity FROM pg_class WHERE oid = 'frontdesk.trf_attachments'::regclass), true, 'AC-0B-2.4: trf_attachments has relforcerowsecurity = true during the test');
-- (b) a lims_app session that sets app.maintenance itself deletes / sees nothing through the owner policies
SELECT alike(pg_temp.a($$ SELECT set_config('app.maintenance', 'frontdesk_purge_trf_drafts', true); DELETE FROM frontdesk.trf_attachments WHERE order_id IS NULL $$, 'w'), 'E42501|%', '§9 test 3 (b): lims_app with app.maintenance set still cannot DELETE (no grant)');
SELECT is((SELECT count(*)::int FROM frontdesk.trf_attachments WHERE order_id IS NULL AND tenant_id = pg_temp.ta()), 4, 'the 4 drafts of A (31, 32, 35, 36) are still there after the refused DELETE (superuser count)');
-- lims_owner sees draft rows only with the flag set, only its claimed tenant, only order_id IS NULL
SELECT is(pg_temp.x('lims_owner', pg_temp.cl(pg_temp.ta()), 'SELECT 1 FROM frontdesk.trf_attachments', 'n'), 'n=0', '§9 test 3: lims_owner without app.maintenance sees 0 rows (FORCE RLS applies to the owner)');
SELECT is(pg_temp.x('lims_owner', pg_temp.cl(pg_temp.ta()), 'SELECT 1 FROM frontdesk.trf_attachments', 'n', $$ SELECT set_config('app.maintenance', 'frontdesk_purge_trf_drafts', true) $$), 'n=4',
  'lims_owner with the flag sees exactly the 4 draft rows of the claimed tenant (not linked rows 34/37, not tenant B''s 33)');
SELECT is(pg_temp.x('lims_owner', pg_temp.cl(pg_temp.ta()), 'SELECT 1 FROM frontdesk.trf_attachments WHERE order_id IS NOT NULL', 'n', $$ SELECT set_config('app.maintenance', 'frontdesk_purge_trf_drafts', true) $$), 'n=0',
  'lims_owner with the flag sees no LINKED attachment (order_id IS NULL in the policy)');
SELECT is(pg_temp.x('lims_owner', pg_temp.cl(pg_temp.tb()), 'SELECT 1 FROM frontdesk.trf_attachments', 'n', $$ SELECT set_config('app.maintenance', 'frontdesk_purge_trf_drafts', true) $$), 'n=1',
  'with tenant-B claims the owner sees only B''s draft');
SELECT is(pg_temp.x('lims_owner', pg_temp.cl(pg_temp.ta()), 'SELECT 1 FROM frontdesk.trf_attachments', 'n', $$ SELECT set_config('app.maintenance', 'wrong_flag', true) $$), 'n=0', 'a different maintenance flag opens nothing');
SELECT is(pg_temp.x('lims_owner', NULL, 'SELECT 1 FROM frontdesk.trf_attachments', 'n', $$ SELECT set_config('app.maintenance', 'frontdesk_purge_trf_drafts', true) $$), 'n=0', 'no tenant claim: the owner policy admits nothing even with the flag');
-- invalid input
SELECT alike(pg_temp.x('lims_worker', pg_temp.cl(pg_temp.ta()), format($$ SELECT frontdesk.purge_trf_drafts(interval '5 minutes', ARRAY[%L]::uuid[]) $$, pg_temp.uid(31)), 'w'), 'E%purge_trf_drafts_invalid_input%', 'older_than < 1 hour -> purge_trf_drafts_invalid_input');
SELECT alike(pg_temp.x('lims_worker', pg_temp.cl(pg_temp.ta()), $$ SELECT frontdesk.purge_trf_drafts(interval '24 hours', NULL) $$, 'w'), 'E%purge_trf_drafts_invalid_input%', 'NULL id list -> purge_trf_drafts_invalid_input');
SELECT alike(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta()), format($$ SELECT frontdesk.purge_trf_drafts(interval '24 hours', ARRAY[%L]::uuid[]) $$, pg_temp.uid(31)), 'w'), 'E42501|%', 'lims_app may not EXECUTE purge_trf_drafts');
-- (a) the function deletes only EXPIRED DRAFTS of the CLAIMED tenant, even when handed other ids: 31 (old draft A) goes; 32 (clean, recent), 33 (old draft B), 34 (old linked A), 35, 36, 37 (linked now) stay
SELECT is(pg_temp.x('lims_worker', pg_temp.cl(pg_temp.ta()), format($$ SELECT frontdesk.purge_trf_drafts(interval '24 hours', ARRAY[%L,%L,%L,%L,%L,%L,%L]::uuid[]) $$,
  pg_temp.uid(31), pg_temp.uid(32), pg_temp.uid(33), pg_temp.uid(34), pg_temp.uid(35), pg_temp.uid(36), pg_temp.uid(37)), 's'), '1',
  '§9 test 3 (a): purge_trf_drafts as lims_worker with tenant-A claims returns 1 (only the expired draft of the claimed tenant)');
SELECT is((SELECT count(*)::int FROM frontdesk.trf_attachments WHERE id = pg_temp.uid(31)), 0, 'expired draft of A is gone');
SELECT is((SELECT count(*)::int FROM frontdesk.trf_attachments WHERE id IN (pg_temp.uid(32), pg_temp.uid(34), pg_temp.uid(35), pg_temp.uid(36), pg_temp.uid(37))), 5, 'recent, linked, quarantined and clean rows of A survive');
SELECT is((SELECT count(*)::int FROM frontdesk.trf_attachments WHERE id = pg_temp.uid(33)), 1, 'the expired draft of tenant B survives a tenant-A purge even when its id is passed');
-- (c) app.maintenance is '' after the call (it is transaction-local and reset by the function)
SELECT is(coalesce(current_setting('app.maintenance', true), ''), '', '§9 test 3 (c): app.maintenance is empty after purge_trf_drafts returned');
SELECT is((SELECT count(*)::int FROM audit.audit_log WHERE schema_name = 'frontdesk' AND table_name = 'trf_attachments' AND row_id = pg_temp.uid(31) AND action = 'DELETE'), 1, 'the purge DELETE is audited (class C/E table)');
-- B's purge removes B's draft (tenant claim decides)
SELECT is(pg_temp.x('lims_worker', pg_temp.cl(pg_temp.tb()), format($$ SELECT frontdesk.purge_trf_drafts(interval '24 hours', ARRAY[%L]::uuid[]) $$, pg_temp.uid(33)), 's'), '1', 'tenant-B purge returns 1');
SELECT is((SELECT count(*)::int FROM frontdesk.trf_attachments WHERE id = pg_temp.uid(33)), 0, 'B''s own expired draft is purged under B''s claims');

SELECT * FROM finish();
ROLLBACK;
