-- T0C-REGPARITY-2 pgTAP suite (LD-310; founder request 2026-11-17 04:49 + 05:00 NPT: "do not leave any function") for migration
-- 20261117110000_frontdesk__add_registration_parity_fields.sql:
--   (a) additive nullable columns on frontdesk.orders, frontdesk.order_items (icd_code) and billing.ledger_entries (card_holder_name, payment_remark), value CHECKs;
--   (b) six new tenant tables: frontdesk.coupons, icd_codes, reward_points_ledger, registration_drafts, favourite_tests, custom_field_definitions: shape, CHECKs, uniqueness,
--       ENABLE + FORCE RLS by tenant, grants, isolation probes (A/B, patient / partner / portal actors), composite tenant FKs;
--   (c) health text and card holder name never in audit diffs (D-27a), drafts expire after 14 days, idempotent re-apply.
-- Synthetic data only. One rolled-back transaction. RLS is never disabled: fixtures are written by the superuser test session with system claims (audit context),
-- every isolation assertion runs as SET LOCAL ROLE lims_app. Seeds supply tenant A/B (a001/b001), branches a101/b101, centres a201/b201, memberships a500/b500.
-- Run: bash db/tests/run-suites.sh db/tests/frontdesk_billing/T0C-REGPARITY-2_registration_parity.test.sql   (docker; migrations + seeds loaded)
-- ASSUMPTIONS (brief silent; a different choice needs a ruling, not a silent test edit):
--  - Column names are pinned below (NEWCOL, T tables). user_id on drafts / favourites is a plain uuid (a membership id is used in fixtures).
--  - All new columns on old tables: nullable, NO default (no data rewrite). Texts are 1..N chars (empty rejected, NULL is the only "none"); money >= 0.
--  - coupons: exactly one of amount_paisa (> 0) or percent (> 0 and <= 100); valid_to >= valid_from; usage_limit > 0 when set; used_count >= 0 and <= usage_limit; code unique per tenant, case-insensitively.
--  - reward_points_ledger is append-only (SELECT, INSERT for lims_app; no UPDATE, no DELETE); entry_kind earned|redeemed; points > 0; composite tenant FKs to patients and orders.
--  - registration_drafts: payload is a JSON object <= 1 MiB, expires_at defaults to updated_at + 14 days; lims_app may DELETE. favourite_tests: unique (tenant, user, orderable), lims_app may DELETE.
--  - RLS is by tenant (like patients); the per-user filter of drafts / favourites is a service rule (T0B-REGAPI-*), not tested here.
--  - orders__audit now excludes clinical_history and patient_history; a drafts audit trigger, if any, excludes payload.
BEGIN;
SET search_path = extensions, public, pg_catalog;
SELECT * FROM no_plan();

CREATE FUNCTION pg_temp.ta() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1a98a-ac40-7000-8000-00000000a001'::uuid $$;
CREATE FUNCTION pg_temp.tb() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1a98a-ac40-7000-8000-00000000b001'::uuid $$;
CREATE FUNCTION pg_temp.sys() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1b34e-1000-7eee-9d29-d7ca59a102b5'::uuid $$;
CREATE FUNCTION pg_temp.uid(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('0190c4f0-0000-7000-8000-' || lpad(n::text, 12, '0'))::uuid $$;
CREATE FUNCTION pg_temp.id(s text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('01a1a98a-ac40-7000-8000-' || s)::uuid $$;
CREATE FUNCTION pg_temp.branch(p_tenant uuid) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT CASE WHEN p_tenant = '01a1a98a-ac40-7000-8000-00000000a001'::uuid THEN pg_temp.id('00000000a101') ELSE pg_temp.id('00000000b101') END $$;
CREATE FUNCTION pg_temp.centre(p_tenant uuid) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT CASE WHEN p_tenant = '01a1a98a-ac40-7000-8000-00000000a001'::uuid THEN pg_temp.id('00000000a201') ELSE pg_temp.id('00000000b201') END $$;
CREATE FUNCTION pg_temp.mem(p_tenant uuid) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT CASE WHEN p_tenant = '01a1a98a-ac40-7000-8000-00000000a001'::uuid THEN pg_temp.id('00000000a500') ELSE pg_temp.id('00000000b500') END $$;
CREATE FUNCTION pg_temp.cl(p_tenant uuid, p_type text DEFAULT 'system') RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('actor_type', p_type, 'tenant_id', p_tenant, 'sub', pg_temp.sys(), 'membership_id', pg_temp.mem(p_tenant)) $$;
-- run p_sql as p_role with claims; mode n = count of a query, w = ROW_COUNT of a statement; errors -> 'E' || SQLSTATE || '|' || SQLERRM
CREATE FUNCTION pg_temp.x(p_role text, p_claims jsonb, p_sql text, p_mode text DEFAULT 'n') RETURNS text LANGUAGE plpgsql AS $f$
DECLARE r text; n bigint; saved text := current_setting('request.jwt.claims', true);
BEGIN
  PERFORM set_config('request.jwt.claims', coalesce(p_claims::text, ''), true);
  EXECUTE format('SET LOCAL ROLE %I', p_role);
  BEGIN
    IF p_mode = 'n' THEN EXECUTE 'SELECT count(*) FROM (' || p_sql || ') t' INTO n; ELSE EXECUTE p_sql; GET DIAGNOSTICS n = ROW_COUNT; END IF;
    r := 'n=' || n;
  EXCEPTION WHEN OTHERS THEN r := 'E' || SQLSTATE || '|' || SQLERRM; END;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', coalesce(saved, ''), true);
  RETURN r;
END $f$;
CREATE FUNCTION pg_temp.a(p_sql text, p_mode text DEFAULT 'w') RETURNS text LANGUAGE sql AS $$ SELECT pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta()), p_sql, p_mode) $$;
CREATE FUNCTION pg_temp.b(p_sql text, p_mode text DEFAULT 'w') RETURNS text LANGUAGE sql AS $$ SELECT pg_temp.x('lims_app', pg_temp.cl(pg_temp.tb()), p_sql, p_mode) $$;
-- superuser fixture insert of the keys of p_row (system claims of the row's tenant give app.tg_row_audit its context); created_by / updated_by added when the table has them; 'ok' or SQLSTATE
CREATE FUNCTION pg_temp.try(p_tbl text, p_row jsonb) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE r jsonb := p_row; a text; cols text; res text; saved text := current_setting('request.jwt.claims', true);
BEGIN
  PERFORM set_config('request.jwt.claims', pg_temp.cl((p_row ->> 'tenant_id')::uuid)::text, true);
  FOREACH a IN ARRAY ARRAY['created_by', 'updated_by'] LOOP
    IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass(p_tbl) AND attname = a AND NOT attisdropped) AND NOT (r ? a) THEN r := r || jsonb_build_object(a, pg_temp.sys()); END IF;
  END LOOP;
  SELECT string_agg(quote_ident(k), ',') INTO cols FROM jsonb_object_keys(r) k;
  BEGIN
    EXECUTE format('INSERT INTO %1$s (%2$s) SELECT %2$s FROM jsonb_populate_record(NULL::%1$s, %3$L::jsonb)', p_tbl, cols, r::text);
    res := 'ok';
  EXCEPTION WHEN OTHERS THEN res := SQLSTATE; END;
  PERFORM set_config('request.jwt.claims', coalesce(saved, ''), true);
  RETURN res;
END $f$;
CREATE FUNCTION pg_temp.ord(n int, p_tenant uuid, p_over jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('id', pg_temp.uid(n), 'tenant_id', p_tenant, 'branch_id', pg_temp.branch(p_tenant), 'centre_id', pg_temp.centre(p_tenant),
    'patient_id', CASE WHEN p_tenant = pg_temp.ta() THEN pg_temp.uid(1) ELSE pg_temp.uid(2) END, 'registration_no', 'RP2-' || n, 'status', 'registered', 'visit_type', 'opd', 'billing_mode', 'cash',
    'priority', 'routine', 'collection_mode', 'walk_in', 'source', 'front_desk', 'is_first_order_of_patient', true, 'catalog_revision', 1, 'registered_at', now()) || p_over $$;

CREATE TEMP TABLE newcol(tbl, name, typ) AS VALUES
  ('frontdesk.orders','collection_at','timestamp with time zone'),('frontdesk.orders','collected_by_membership_id','uuid'),('frontdesk.orders','collected_by_name','text'),
  ('frontdesk.orders','sample_not_collected','boolean'),('frontdesk.orders','sample_remark','text'),('frontdesk.orders','remark_description','text'),
  ('frontdesk.orders','clinical_history','text'),('frontdesk.orders','patient_history','text'),('frontdesk.orders','mr_number','text'),('frontdesk.orders','external_reference','text'),
  ('frontdesk.orders','insurance_code','text'),('frontdesk.orders','insurance_claim_amount_paisa','bigint'),('frontdesk.orders','visiting_charge_paisa','bigint'),
  ('frontdesk.orders','coupon_code','text'),('frontdesk.orders','coupon_amount_paisa','bigint'),
  ('frontdesk.order_items','icd_code','text'),
  ('billing.ledger_entries','card_holder_name','text'),('billing.ledger_entries','payment_remark','text');
CREATE TEMP TABLE nt(t) AS VALUES ('coupons'),('icd_codes'),('reward_points_ledger'),('registration_drafts'),('favourite_tests'),('custom_field_definitions');

-- ===================================================================================================================================== (a) additive columns on old tables
SELECT is((SELECT format_type(a.atttypid, a.atttypmod) FROM pg_attribute a WHERE a.attrelid = n.tbl::regclass AND a.attname = n.name AND NOT a.attisdropped), n.typ, n.tbl || '.' || n.name || ' exists as ' || n.typ) FROM newcol n;
SELECT is((SELECT NOT a.attnotnull AND NOT a.atthasdef FROM pg_attribute a WHERE a.attrelid = n.tbl::regclass AND a.attname = n.name AND NOT a.attisdropped), true,
  n.tbl || '.' || n.name || ' is nullable with no default (additive, no data rewrite)') FROM newcol n;
SELECT is((SELECT count(*)::int FROM pg_attribute a WHERE a.attrelid = 'frontdesk.orders'::regclass AND a.attnum > 0 AND NOT a.attisdropped
            AND a.attname IN ('id','tenant_id','branch_id','centre_id','patient_id','registration_no','status','visit_type','billing_mode','credit_party_id','referrer_id','priority','collection_mode','source','source_ref_id',
              'partner_id','age_years','age_months','age_days','is_first_order_of_patient','catalog_revision','items_version','scheduled_at','registered_at','requires_credit_note','cancelled_at','cancelled_by',
              'cancel_reason_code','cancel_reason_text','version','is_active','created_at','created_by','updated_at','updated_by')), 35, 'all 35 old orders columns are untouched');
SELECT is((SELECT count(*)::int FROM pg_attribute a WHERE a.attrelid = 'frontdesk.orders'::regclass AND a.attnum > 0 AND NOT a.attisdropped), 35 + 15, 'orders has exactly the 35 old + 15 new columns');
SELECT is((SELECT count(*)::int FROM pg_type t WHERE t.typnamespace = 'frontdesk'::regnamespace AND t.typtype = 'e'), 0, 'no ENUM type in frontdesk');
SELECT is((SELECT count(*)::int FROM pg_class WHERE relkind = 'S' AND relnamespace IN ('frontdesk'::regnamespace, 'billing'::regnamespace)), 0, 'no sequences in frontdesk / billing (05-SCHEMA §9 test 1)');

-- fixtures: one patient per tenant, one plain order each
SELECT is(pg_temp.try('frontdesk.patients', jsonb_build_object('id', pg_temp.uid(1), 'tenant_id', pg_temp.ta(), 'patient_code', 'RP2-1', 'full_name', 'Synthetic Parity 1', 'name_search', 'synthetic parity 1', 'sex', 'female',
  'registered_centre_id', pg_temp.centre(pg_temp.ta()))), 'ok', 'fixture: patient A');
SELECT is(pg_temp.try('frontdesk.patients', jsonb_build_object('id', pg_temp.uid(2), 'tenant_id', pg_temp.tb(), 'patient_code', 'RP2-2', 'full_name', 'Synthetic Parity 2', 'name_search', 'synthetic parity 2', 'sex', 'male',
  'registered_centre_id', pg_temp.centre(pg_temp.tb()))), 'ok', 'fixture: patient B');
SELECT is(pg_temp.try('frontdesk.orders', pg_temp.ord(10, pg_temp.ta())), 'ok', 'an order without any new column still inserts (old shape works)');
SELECT is(pg_temp.try('frontdesk.orders', pg_temp.ord(11, pg_temp.tb())), 'ok', 'fixture: order B');

-- values
SELECT is(pg_temp.try('frontdesk.orders', pg_temp.ord(12, pg_temp.ta(), jsonb_build_object('collection_at', now(), 'collected_by_membership_id', pg_temp.mem(pg_temp.ta()), 'collected_by_name', 'Synthetic Collector',
  'sample_not_collected', false, 'sample_remark', 'ok', 'remark_description', 'synthetic remark', 'clinical_history', 'synthetic clinical history SYN-CLIN-0001', 'patient_history', 'synthetic patient history SYN-PHIS-0001',
  'mr_number', 'MR-SYN-0001', 'external_reference', 'EXT-SYN-0001', 'insurance_code', 'INS-SYN-1', 'insurance_claim_amount_paisa', 5000, 'visiting_charge_paisa', 20000, 'coupon_code', 'SAVE10', 'coupon_amount_paisa', 1000))),
  'ok', 'an order with every new column inserts');
SELECT is(pg_temp.try('frontdesk.orders', pg_temp.ord(13, pg_temp.ta(), jsonb_build_object('sample_not_collected', true, 'sample_remark', 'refused', 'collected_by_name', 'Outside Courier (synthetic)'))), 'ok',
  'sample not collected with a free-text outside collector and no staff reference');
SELECT is(pg_temp.try('frontdesk.orders', pg_temp.ord(14, pg_temp.ta(), jsonb_build_object('clinical_history', repeat('c', 2000), 'patient_history', repeat('p', 2000)))), 'ok', 'a 2000 character history is accepted');
SELECT isnt(pg_temp.try('frontdesk.orders', pg_temp.ord(15, pg_temp.ta(), jsonb_build_object('clinical_history', repeat('c', 100000)))), 'ok', 'a 100000 character clinical_history is rejected');
SELECT isnt(pg_temp.try('frontdesk.orders', pg_temp.ord(16, pg_temp.ta(), jsonb_build_object('patient_history', repeat('p', 100000)))), 'ok', 'a 100000 character patient_history is rejected');
SELECT isnt(pg_temp.try('frontdesk.orders', pg_temp.ord(17 + t.i, pg_temp.ta(), jsonb_build_object(t.col, ''))), 'ok', 'empty ' || t.col || ' rejected (NULL is the only "none")')
  FROM (VALUES (1,'collected_by_name'),(2,'sample_remark'),(3,'remark_description'),(4,'clinical_history'),(5,'patient_history'),(6,'mr_number'),(7,'external_reference'),(8,'insurance_code'),(9,'coupon_code')) t(i, col);
SELECT isnt(pg_temp.try('frontdesk.orders', pg_temp.ord(30 + t.i, pg_temp.ta(), jsonb_build_object(t.col, repeat('x', 5000)))), 'ok', 'oversize ' || t.col || ' rejected')
  FROM (VALUES (1,'collected_by_name'),(2,'sample_remark'),(3,'mr_number'),(4,'external_reference'),(5,'insurance_code'),(6,'coupon_code')) t(i, col);
SELECT isnt(pg_temp.try('frontdesk.orders', pg_temp.ord(40 + t.i, pg_temp.ta(), jsonb_build_object(t.col, -1))), 'ok', 'negative ' || t.col || ' rejected')
  FROM (VALUES (1,'insurance_claim_amount_paisa'),(2,'visiting_charge_paisa'),(3,'coupon_amount_paisa')) t(i, col);
SELECT is(pg_temp.try('frontdesk.orders', pg_temp.ord(50 + t.i, pg_temp.ta(), jsonb_build_object(t.col, 0))), 'ok', 'zero ' || t.col || ' accepted')
  FROM (VALUES (1,'insurance_claim_amount_paisa'),(2,'visiting_charge_paisa'),(3,'coupon_amount_paisa')) t(i, col);

-- icd_code per order line
SELECT is(pg_temp.try('frontdesk.order_items', jsonb_build_object('id', pg_temp.uid(60), 'tenant_id', pg_temp.ta(), 'order_id', pg_temp.uid(10), 'centre_id', pg_temp.centre(pg_temp.ta()), 'orderable_id', pg_temp.uid(99),
  'orderable_kind', 'test', 'code', 'CBC', 'name', 'CBC (SYNTHETIC)', 'test_ids', jsonb_build_array(pg_temp.uid(99)), 'priority', 'routine', 'unit_price_paisa', 1000, 'price_list_id', pg_temp.uid(98), 'price_list_version', 1,
  'price_source', 'tenant_default', 'vat_treatment', 'exempt', 'added_in_items_version', 1, 'icd_code', 'A09')), 'ok', 'order line with icd_code A09 inserts');
SELECT is(pg_temp.try('frontdesk.order_items', jsonb_build_object('id', pg_temp.uid(61), 'tenant_id', pg_temp.ta(), 'order_id', pg_temp.uid(10), 'centre_id', pg_temp.centre(pg_temp.ta()), 'orderable_id', pg_temp.uid(99),
  'orderable_kind', 'test', 'code', 'CBC', 'name', 'CBC (SYNTHETIC)', 'test_ids', jsonb_build_array(pg_temp.uid(99)), 'priority', 'routine', 'unit_price_paisa', 1000, 'price_list_id', pg_temp.uid(98), 'price_list_version', 1,
  'price_source', 'tenant_default', 'vat_treatment', 'exempt', 'added_in_items_version', 1)), 'ok', 'order line without icd_code still inserts');
SELECT isnt(pg_temp.try('frontdesk.order_items', jsonb_build_object('id', pg_temp.uid(62 + t.i), 'tenant_id', pg_temp.ta(), 'order_id', pg_temp.uid(10), 'centre_id', pg_temp.centre(pg_temp.ta()), 'orderable_id', pg_temp.uid(99),
  'orderable_kind', 'test', 'code', 'CBC', 'name', 'CBC (SYNTHETIC)', 'test_ids', jsonb_build_array(pg_temp.uid(99)), 'priority', 'routine', 'unit_price_paisa', 1000, 'price_list_id', pg_temp.uid(98), 'price_list_version', 1,
  'price_source', 'tenant_default', 'vat_treatment', 'exempt', 'added_in_items_version', 1, 'icd_code', t.v)), 'ok', 'icd_code ' || t.lbl || ' rejected')
  FROM (VALUES (1, '', 'empty'), (2, repeat('X', 40), 'oversize')) t(i, v, lbl);
-- a foreign key from order_items.icd_code to the master, if there is one, must be tenant-composite (no cross-tenant reference)
SELECT is((SELECT count(*)::int FROM pg_constraint c WHERE c.conrelid = 'frontdesk.order_items'::regclass AND c.contype = 'f'
            AND (SELECT a.attnum FROM pg_attribute a WHERE a.attrelid = c.conrelid AND a.attname = 'icd_code') = ANY (c.conkey)
            AND NOT ((SELECT a.attnum FROM pg_attribute a WHERE a.attrelid = c.conrelid AND a.attname = 'tenant_id') = ANY (c.conkey))), 0, 'any FK on order_items.icd_code includes tenant_id');

-- payment fields on the ledger
SELECT is(pg_temp.try('billing.ledger_entries', jsonb_build_object('id', pg_temp.uid(70), 'tenant_id', pg_temp.ta(), 'branch_id', pg_temp.branch(pg_temp.ta()), 'centre_id', pg_temp.centre(pg_temp.ta()), 'order_id', pg_temp.uid(10),
  'entry_kind', 'payment', 'capture_kind', 'manual', 'method_code', 'card', 'amount_paisa', 500, 'fiscal_year_bs', '2083/84', 'collected_by_membership_id', pg_temp.mem(pg_temp.ta()), 'business_date', current_date,
  'card_holder_name', 'Synthetic Holder SYN-HOLDER-0001', 'payment_remark', 'synthetic payment remark')), 'ok', 'ledger payment with card_holder_name and payment_remark inserts');
SELECT is(pg_temp.try('billing.ledger_entries', jsonb_build_object('id', pg_temp.uid(71), 'tenant_id', pg_temp.ta(), 'branch_id', pg_temp.branch(pg_temp.ta()), 'centre_id', pg_temp.centre(pg_temp.ta()), 'order_id', pg_temp.uid(10),
  'entry_kind', 'payment', 'capture_kind', 'manual', 'method_code', 'cash', 'amount_paisa', 100, 'fiscal_year_bs', '2083/84', 'collected_by_membership_id', pg_temp.mem(pg_temp.ta()), 'business_date', current_date)), 'ok',
  'ledger payment without the new fields still inserts');
SELECT isnt(pg_temp.try('billing.ledger_entries', jsonb_build_object('id', pg_temp.uid(72 + t.i), 'tenant_id', pg_temp.ta(), 'branch_id', pg_temp.branch(pg_temp.ta()), 'centre_id', pg_temp.centre(pg_temp.ta()), 'order_id', pg_temp.uid(10),
  'entry_kind', 'payment', 'capture_kind', 'manual', 'method_code', 'card', 'amount_paisa', 100, 'fiscal_year_bs', '2083/84', 'collected_by_membership_id', pg_temp.mem(pg_temp.ta()), 'business_date', current_date) || t.o), 'ok', t.lbl)
  FROM (VALUES (1, '{"card_holder_name":""}'::jsonb, 'empty card_holder_name rejected'), (2, jsonb_build_object('card_holder_name', repeat('h', 2000)), 'oversize card_holder_name rejected'),
               (3, '{"payment_remark":""}'::jsonb, 'empty payment_remark rejected'), (4, jsonb_build_object('payment_remark', repeat('r', 5000)), 'oversize payment_remark rejected')) t(i, o, lbl);
SELECT is(has_table_privilege('lims_app', 'billing.ledger_entries', 'UPDATE') OR has_table_privilege('lims_app', 'billing.ledger_entries', 'DELETE'), false, 'ledger stays append-only: no UPDATE / DELETE for lims_app');

-- ===================================================================================================================================== (b) the six new tables: shape
SELECT is((SELECT count(*)::int FROM pg_class c WHERE c.relnamespace = 'frontdesk'::regnamespace AND c.relname = n.t AND c.relkind = 'r'), 1, 'frontdesk.' || n.t || ' exists') FROM nt n;
SELECT is((SELECT c.relrowsecurity AND c.relforcerowsecurity FROM pg_class c WHERE c.oid = to_regclass('frontdesk.' || n.t)), true, 'frontdesk.' || n.t || ' ENABLE + FORCE row level security') FROM nt n;
SELECT is((SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = 'frontdesk' AND p.tablename = n.t AND p.roles <> ARRAY['lims_app']::name[]), 0, 'every policy on ' || n.t || ' is TO lims_app only') FROM nt n;
SELECT is((SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = to_regclass('frontdesk.' || n.t)
            AND (coalesce(pg_get_expr(p.polqual, p.polrelid), '') || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')) !~ 'tenant_id = '), 0, 'every ' || n.t || ' policy is tenant_id-scoped') FROM nt n;
SELECT is((SELECT array_agg(cmd ORDER BY cmd) FROM pg_policies WHERE schemaname = 'frontdesk' AND tablename = x.t), x.cmds, x.t || ' has exactly the expected policy commands')
  FROM (VALUES ('coupons', ARRAY['INSERT','SELECT','UPDATE']), ('icd_codes', ARRAY['INSERT','SELECT','UPDATE']), ('custom_field_definitions', ARRAY['INSERT','SELECT','UPDATE']),
               ('reward_points_ledger', ARRAY['INSERT','SELECT']), ('registration_drafts', ARRAY['DELETE','INSERT','SELECT','UPDATE']), ('favourite_tests', ARRAY['DELETE','INSERT','SELECT'])) x(t, cmds);
SELECT is(has_table_privilege('lims_app', to_regclass('frontdesk.' || x.t), x.priv), x.want, 'lims_app ' || x.priv || ' on ' || x.t || ' = ' || x.want)
  FROM (VALUES ('coupons','SELECT',true),('coupons','INSERT',true),('coupons','UPDATE',true),('coupons','DELETE',false),
               ('icd_codes','SELECT',true),('icd_codes','INSERT',true),('icd_codes','UPDATE',true),('icd_codes','DELETE',false),
               ('custom_field_definitions','SELECT',true),('custom_field_definitions','INSERT',true),('custom_field_definitions','UPDATE',true),('custom_field_definitions','DELETE',false),
               ('reward_points_ledger','SELECT',true),('reward_points_ledger','INSERT',true),('reward_points_ledger','UPDATE',false),('reward_points_ledger','DELETE',false),
               ('registration_drafts','SELECT',true),('registration_drafts','INSERT',true),('registration_drafts','UPDATE',true),('registration_drafts','DELETE',true),
               ('favourite_tests','SELECT',true),('favourite_tests','INSERT',true),('favourite_tests','DELETE',true)) x(t, priv, want);
SELECT is(coalesce(has_table_privilege(r.role, to_regclass('frontdesk.' || n.t), 'SELECT'), false), false, r.role || ' has no grant on ' || n.t) FROM nt n CROSS JOIN (VALUES ('anon'),('authenticated'),('lims_monitor')) r(role) WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r.role);
-- §9 test 2: tenant_id leads every index; PRIMARY KEY (id) + UNIQUE (tenant_id, id); tenant FK; no default on id / tenant_id
SELECT is((SELECT a.attname FROM pg_attribute a WHERE a.attrelid = i.indrelid AND a.attnum = i.indkey[0]), 'tenant_id', '§9 test 2: ' || c.relname || ' index ' || ic.relname || ' leads with tenant_id')
  FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid JOIN pg_class ic ON ic.oid = i.indexrelid
 WHERE c.relnamespace = 'frontdesk'::regnamespace AND c.relname IN (SELECT t FROM nt) AND NOT (i.indisprimary AND i.indnatts = 1 AND (SELECT a.attname FROM pg_attribute a WHERE a.attrelid = i.indrelid AND a.attnum = i.indkey[0]) = 'id');
SELECT ok(EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid = to_regclass('frontdesk.' || n.t) AND k.contype = 'u' AND (SELECT array_agg(a.attname::text ORDER BY x.ord) FROM unnest(k.conkey) WITH ORDINALITY x(attnum, ord)
            JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = x.attnum) = ARRAY['tenant_id','id']), n.t || ' has UNIQUE (tenant_id, id) next to PRIMARY KEY (id)') FROM nt n;
SELECT ok(EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid = to_regclass('frontdesk.' || n.t) AND k.contype = 'f' AND k.confrelid = 'core.tenants'::regclass), n.t || ' references core.tenants') FROM nt n;
SELECT is((SELECT count(*)::int FROM pg_attribute a WHERE a.attrelid = to_regclass('frontdesk.' || n.t) AND a.attname IN ('id','tenant_id') AND a.atthasdef AND NOT a.attisdropped), 0, n.t || ': no DEFAULT on id / tenant_id (UUIDv7 in app code)') FROM nt n;
SELECT is((SELECT count(*)::int FROM pg_attribute a WHERE a.attrelid = to_regclass('frontdesk.' || n.t) AND a.attname IN ('id','tenant_id') AND a.attnotnull AND NOT a.attisdropped), 2, n.t || ': id and tenant_id are NOT NULL') FROM nt n;

-- ===================================================================================================================================== (b) coupons
SELECT is(pg_temp.try('frontdesk.coupons', jsonb_build_object('id', pg_temp.uid(100), 'tenant_id', pg_temp.ta(), 'code', 'SAVE10', 'percent', 10, 'valid_from', '2026-11-01', 'valid_to', '2026-12-31', 'usage_limit', 100)), 'ok', 'percent coupon with dates and limit');
SELECT is(pg_temp.try('frontdesk.coupons', jsonb_build_object('id', pg_temp.uid(101), 'tenant_id', pg_temp.ta(), 'code', 'FLAT500', 'amount_paisa', 50000)), 'ok', 'amount coupon without dates or limit (unlimited, always valid)');
SELECT is(pg_temp.try('frontdesk.coupons', jsonb_build_object('id', pg_temp.uid(102), 'tenant_id', pg_temp.ta(), 'code', 'FULL100', 'percent', 100)), 'ok', 'percent 100 accepted');
SELECT is((SELECT used_count FROM frontdesk.coupons WHERE id = pg_temp.uid(100)), 0, 'used_count starts at 0');
SELECT is((SELECT is_active FROM frontdesk.coupons WHERE id = pg_temp.uid(100)), true, 'a coupon is active by default');
SELECT isnt(pg_temp.try('frontdesk.coupons', jsonb_build_object('id', pg_temp.uid(110 + t.i), 'tenant_id', pg_temp.ta(), 'code', 'BAD' || t.i) || t.o), 'ok', t.lbl)
  FROM (VALUES (1, '{"percent":10,"amount_paisa":500}'::jsonb, 'coupon with both amount and percent rejected'), (2, '{}'::jsonb, 'coupon with neither amount nor percent rejected'),
               (3, '{"amount_paisa":0}'::jsonb, 'amount 0 rejected'), (4, '{"amount_paisa":-5}'::jsonb, 'negative amount rejected'), (5, '{"percent":0}'::jsonb, 'percent 0 rejected'),
               (6, '{"percent":101}'::jsonb, 'percent 101 rejected'), (7, '{"percent":-1}'::jsonb, 'negative percent rejected'),
               (8, '{"percent":10,"valid_from":"2026-12-31","valid_to":"2026-11-01"}'::jsonb, 'valid_to before valid_from rejected'),
               (9, '{"percent":10,"usage_limit":0}'::jsonb, 'usage_limit 0 rejected'), (10, '{"percent":10,"usage_limit":-3}'::jsonb, 'negative usage_limit rejected'),
               (11, '{"percent":10,"usage_limit":5,"used_count":6}'::jsonb, 'used_count above usage_limit rejected (race-safe cap in the database)'),
               (12, '{"percent":10,"used_count":-1}'::jsonb, 'negative used_count rejected')) t(i, o, lbl);
SELECT isnt(pg_temp.try('frontdesk.coupons', jsonb_build_object('id', pg_temp.uid(130 + t.i), 'tenant_id', pg_temp.ta(), 'code', t.c, 'percent', 5)), 'ok', 'coupon code ' || t.lbl || ' rejected')
  FROM (VALUES (1, '', 'empty'), (2, repeat('Z', 200), 'oversize'), (3, 'BAD CODE;--', 'with spaces and punctuation')) t(i, c, lbl);
SELECT is(pg_temp.try('frontdesk.coupons', jsonb_build_object('id', pg_temp.uid(135), 'tenant_id', pg_temp.ta(), 'code', 'SAVE10', 'percent', 5)), '23505', 'same coupon code in the same tenant -> unique_violation');
SELECT isnt(pg_temp.try('frontdesk.coupons', jsonb_build_object('id', pg_temp.uid(136), 'tenant_id', pg_temp.ta(), 'code', 'save10', 'percent', 5)), 'ok', 'coupon code differing only by case collides (unique or format check)');
SELECT is(pg_temp.try('frontdesk.coupons', jsonb_build_object('id', pg_temp.uid(137), 'tenant_id', pg_temp.tb(), 'code', 'SAVE10', 'percent', 5)), 'ok', 'the same coupon code in another tenant is allowed');

-- ===================================================================================================================================== (b) icd master
SELECT is(pg_temp.try('frontdesk.icd_codes', jsonb_build_object('id', pg_temp.uid(150), 'tenant_id', pg_temp.ta(), 'code', 'A09', 'description', 'Synthetic: infectious gastroenteritis and colitis')), 'ok', 'icd code A09');
SELECT is(pg_temp.try('frontdesk.icd_codes', jsonb_build_object('id', pg_temp.uid(151), 'tenant_id', pg_temp.ta(), 'code', 'E11.9', 'description', 'Synthetic: type 2 diabetes mellitus', 'is_active', false)), 'ok', 'icd code with a dot, inactive');
SELECT is((SELECT is_active FROM frontdesk.icd_codes WHERE id = pg_temp.uid(150)), true, 'an icd code is active by default');
SELECT is(pg_temp.try('frontdesk.icd_codes', jsonb_build_object('id', pg_temp.uid(152), 'tenant_id', pg_temp.ta(), 'code', 'A09', 'description', 'dup')), '23505', 'same icd code in the same tenant -> unique_violation');
SELECT isnt(pg_temp.try('frontdesk.icd_codes', jsonb_build_object('id', pg_temp.uid(153), 'tenant_id', pg_temp.ta(), 'code', 'a09', 'description', 'case dup')), 'ok', 'icd code differing only by case collides (unique or format check)');
SELECT is(pg_temp.try('frontdesk.icd_codes', jsonb_build_object('id', pg_temp.uid(154), 'tenant_id', pg_temp.tb(), 'code', 'A09', 'description', 'Synthetic B')), 'ok', 'the same icd code in another tenant is allowed');
SELECT isnt(pg_temp.try('frontdesk.icd_codes', jsonb_build_object('id', pg_temp.uid(155 + t.i), 'tenant_id', pg_temp.ta(), 'code', t.c, 'description', t.d)), 'ok', 'icd ' || t.lbl || ' rejected')
  FROM (VALUES (1, '', 'x', 'empty code'), (2, repeat('A', 40), 'x', 'oversize code'), (3, 'B01', '', 'empty description'), (4, 'B02', repeat('d', 600), 'oversize description')) t(i, c, d, lbl);

-- ===================================================================================================================================== (b) custom field definitions
SELECT is(pg_temp.try('frontdesk.custom_field_definitions', jsonb_build_object('id', pg_temp.uid(170 + t.i), 'tenant_id', pg_temp.ta(), 'field_key', 'f_' || t.v, 'label', 'Synthetic ' || t.v, 'field_type', t.v, 'required', false)), 'ok',
  'field_type ' || t.v || ' accepted') FROM (VALUES (1,'text'),(2,'number'),(3,'date'),(4,'choice')) t(i, v);
SELECT isnt(pg_temp.try('frontdesk.custom_field_definitions', jsonb_build_object('id', pg_temp.uid(180), 'tenant_id', pg_temp.ta(), 'field_key', 'f_blob', 'label', 'x', 'field_type', 'blob', 'required', false)), 'ok', 'field_type outside the four is rejected');
SELECT isnt(pg_temp.try('frontdesk.custom_field_definitions', jsonb_build_object('id', pg_temp.uid(181 + t.i), 'tenant_id', pg_temp.ta(), 'field_key', t.k, 'label', 'x', 'field_type', 'text', 'required', false)), 'ok', 'field_key ' || t.lbl || ' rejected')
  FROM (VALUES (1, 'Bad Key', 'with space and capitals'), (2, '1abc', 'starting with a digit'), (3, 'a;drop table x', 'with punctuation'), (4, '', 'empty'), (5, repeat('k', 100), 'oversize')) t(i, k, lbl);
SELECT isnt(pg_temp.try('frontdesk.custom_field_definitions', jsonb_build_object('id', pg_temp.uid(190), 'tenant_id', pg_temp.ta(), 'field_key', 'f_label', 'label', '', 'field_type', 'text', 'required', false)), 'ok', 'empty label rejected');
SELECT is(pg_temp.try('frontdesk.custom_field_definitions', jsonb_build_object('id', pg_temp.uid(191), 'tenant_id', pg_temp.ta(), 'field_key', 'f_text', 'label', 'dup', 'field_type', 'text', 'required', false)), '23505', 'same field_key in the same tenant -> unique_violation');
SELECT is(pg_temp.try('frontdesk.custom_field_definitions', jsonb_build_object('id', pg_temp.uid(192), 'tenant_id', pg_temp.tb(), 'field_key', 'f_text', 'label', 'B', 'field_type', 'text', 'required', true)), 'ok', 'the same field_key in another tenant is allowed');
SELECT is((SELECT is_active FROM frontdesk.custom_field_definitions WHERE id = pg_temp.uid(171)), true, 'a definition is active by default');

-- ===================================================================================================================================== (b) reward points ledger
SELECT is(pg_temp.try('frontdesk.reward_points_ledger', jsonb_build_object('id', pg_temp.uid(200), 'tenant_id', pg_temp.ta(), 'patient_id', pg_temp.uid(1), 'order_id', pg_temp.uid(10), 'entry_kind', 'earned', 'points', 25)), 'ok', 'earned points for an order');
SELECT is(pg_temp.try('frontdesk.reward_points_ledger', jsonb_build_object('id', pg_temp.uid(201), 'tenant_id', pg_temp.ta(), 'patient_id', pg_temp.uid(1), 'order_id', pg_temp.uid(12), 'entry_kind', 'redeemed', 'points', 10)), 'ok', 'redeemed points for an order');
SELECT isnt(pg_temp.try('frontdesk.reward_points_ledger', jsonb_build_object('id', pg_temp.uid(202 + t.i), 'tenant_id', pg_temp.ta(), 'patient_id', pg_temp.uid(1), 'order_id', pg_temp.uid(10), 'entry_kind', t.k, 'points', t.p)), 'ok', t.lbl)
  FROM (VALUES (1, 'bonus', 5, 'entry_kind outside earned|redeemed rejected'), (2, 'earned', 0, 'zero points rejected'), (3, 'earned', -5, 'negative points rejected'), (4, 'redeemed', -1, 'negative redeemed rejected')) t(i, k, p, lbl);
SELECT is(pg_temp.try('frontdesk.reward_points_ledger', jsonb_build_object('id', pg_temp.uid(210), 'tenant_id', pg_temp.ta(), 'patient_id', pg_temp.uid(2), 'order_id', pg_temp.uid(10), 'entry_kind', 'earned', 'points', 5)), '23503', 'cross-tenant patient reference -> foreign_key_violation');
SELECT is(pg_temp.try('frontdesk.reward_points_ledger', jsonb_build_object('id', pg_temp.uid(211), 'tenant_id', pg_temp.ta(), 'patient_id', pg_temp.uid(1), 'order_id', pg_temp.uid(11), 'entry_kind', 'earned', 'points', 5)), '23503', 'cross-tenant order reference -> foreign_key_violation');
SELECT is(pg_temp.try('frontdesk.reward_points_ledger', jsonb_build_object('id', pg_temp.uid(212), 'tenant_id', pg_temp.ta(), 'patient_id', pg_temp.uid(404), 'order_id', pg_temp.uid(10), 'entry_kind', 'earned', 'points', 5)), '23503', 'unknown patient -> foreign_key_violation');
SELECT alike(pg_temp.a('UPDATE frontdesk.reward_points_ledger SET points = 9999'), 'E42501|%', 'lims_app cannot UPDATE the reward ledger (append-only)');
SELECT alike(pg_temp.a('DELETE FROM frontdesk.reward_points_ledger'), 'E42501|%', 'lims_app cannot DELETE from the reward ledger (append-only)');
SELECT is((SELECT sum(CASE entry_kind WHEN 'earned' THEN points ELSE -points END)::int FROM frontdesk.reward_points_ledger WHERE tenant_id = pg_temp.ta() AND patient_id = pg_temp.uid(1)), 15, 'balance = earned - redeemed is derivable from the ledger (25 - 10)');

-- ===================================================================================================================================== (b) registration drafts (14 day expiry)
SELECT is(pg_temp.try('frontdesk.registration_drafts', jsonb_build_object('id', pg_temp.uid(300), 'tenant_id', pg_temp.ta(), 'user_id', pg_temp.mem(pg_temp.ta()), 'centre_id', pg_temp.centre(pg_temp.ta()),
  'payload', jsonb_build_object('patient', 'SYN-DRAFT-MARKER', 'items', jsonb_build_array()))), 'ok', 'draft inserts');
SELECT ok((SELECT expires_at - updated_at BETWEEN interval '13 days 23 hours' AND interval '14 days 1 hour' FROM frontdesk.registration_drafts WHERE id = pg_temp.uid(300)), 'expires_at defaults to updated_at + 14 days');
SELECT ok((SELECT expires_at > now() + interval '13 days' FROM frontdesk.registration_drafts WHERE id = pg_temp.uid(300)), 'a new draft is not yet expired (more than 13 days left)');
SELECT is(pg_temp.try('frontdesk.registration_drafts', jsonb_build_object('id', pg_temp.uid(301), 'tenant_id', pg_temp.ta(), 'user_id', pg_temp.mem(pg_temp.ta()), 'centre_id', pg_temp.centre(pg_temp.ta()), 'payload', '{}'::jsonb)), 'ok',
  'a second draft for the same user and centre is allowed (several drafts)');
SELECT isnt(pg_temp.try('frontdesk.registration_drafts', jsonb_build_object('id', pg_temp.uid(302 + t.i), 'tenant_id', pg_temp.ta(), 'user_id', pg_temp.mem(pg_temp.ta()), 'centre_id', pg_temp.centre(pg_temp.ta()), 'payload', t.p)), 'ok', t.lbl)
  FROM (VALUES (1, '[]'::jsonb, 'array payload rejected'), (2, '"x"'::jsonb, 'string payload rejected'), (3, '1'::jsonb, 'number payload rejected'),
               (4, jsonb_build_object('blob', repeat('x', 1200000)), 'payload above 1 MiB rejected (no unbounded rows)')) t(i, p, lbl);
SELECT is(pg_temp.try('frontdesk.registration_drafts', jsonb_build_object('id', pg_temp.uid(306), 'tenant_id', pg_temp.ta(), 'user_id', pg_temp.mem(pg_temp.ta()), 'centre_id', pg_temp.centre(pg_temp.ta()))), '23502', 'draft without payload -> not_null_violation');
SELECT is(pg_temp.try('frontdesk.registration_drafts', jsonb_build_object('id', pg_temp.uid(307), 'tenant_id', pg_temp.ta(), 'centre_id', pg_temp.centre(pg_temp.ta()), 'payload', '{}'::jsonb)), '23502', 'draft without user_id -> not_null_violation');
SELECT is(pg_temp.try('frontdesk.registration_drafts', jsonb_build_object('id', pg_temp.uid(308), 'tenant_id', pg_temp.ta(), 'user_id', pg_temp.mem(pg_temp.ta()), 'payload', '{}'::jsonb)), '23502', 'draft without centre_id -> not_null_violation');
SELECT is(pg_temp.try('frontdesk.registration_drafts', jsonb_build_object('id', pg_temp.uid(309), 'tenant_id', pg_temp.ta(), 'user_id', pg_temp.mem(pg_temp.ta()), 'centre_id', pg_temp.centre(pg_temp.tb()), 'payload', '{}'::jsonb)), '23503',
  'draft for another tenant''s centre -> foreign_key_violation (composite tenant FK)');
SELECT is(pg_temp.try('frontdesk.registration_drafts', jsonb_build_object('id', pg_temp.uid(310), 'tenant_id', pg_temp.tb(), 'user_id', pg_temp.mem(pg_temp.tb()), 'centre_id', pg_temp.centre(pg_temp.tb()), 'payload', '{}'::jsonb)), 'ok', 'fixture: draft B');
SELECT ok(EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = to_regclass('frontdesk.registration_drafts') AND i.indkey[0] = (SELECT attnum FROM pg_attribute WHERE attrelid = i.indrelid AND attname = 'tenant_id')
            AND (SELECT attnum FROM pg_attribute WHERE attrelid = i.indrelid AND attname = 'expires_at') = ANY (i.indkey::int2[])), 'an index (tenant_id first) covers expires_at for the 14 day purge scan');

-- ===================================================================================================================================== (b) favourite tests
SELECT is(pg_temp.try('frontdesk.favourite_tests', jsonb_build_object('id', pg_temp.uid(400), 'tenant_id', pg_temp.ta(), 'user_id', pg_temp.mem(pg_temp.ta()), 'orderable_id', pg_temp.uid(99))), 'ok', 'favourite added');
SELECT is(pg_temp.try('frontdesk.favourite_tests', jsonb_build_object('id', pg_temp.uid(401), 'tenant_id', pg_temp.ta(), 'user_id', pg_temp.mem(pg_temp.ta()), 'orderable_id', pg_temp.uid(99))), '23505', 'the same favourite twice for one user -> unique_violation (add is idempotent in the service)');
SELECT is(pg_temp.try('frontdesk.favourite_tests', jsonb_build_object('id', pg_temp.uid(402), 'tenant_id', pg_temp.ta(), 'user_id', pg_temp.uid(5000), 'orderable_id', pg_temp.uid(99))), 'ok', 'another user may favourite the same test');
SELECT is(pg_temp.try('frontdesk.favourite_tests', jsonb_build_object('id', pg_temp.uid(403), 'tenant_id', pg_temp.tb(), 'user_id', pg_temp.mem(pg_temp.tb()), 'orderable_id', pg_temp.uid(99))), 'ok', 'fixture: favourite B (same orderable id, other tenant)');

-- ===================================================================================================================================== (b) isolation: tenant A / B probes on every new table
CREATE TEMP TABLE probe(t, own_a) AS VALUES ('coupons', pg_temp.uid(100)), ('icd_codes', pg_temp.uid(150)), ('custom_field_definitions', pg_temp.uid(171)), ('reward_points_ledger', pg_temp.uid(200)),
  ('registration_drafts', pg_temp.uid(300)), ('favourite_tests', pg_temp.uid(400));
SELECT is(pg_temp.a('SELECT 1 FROM frontdesk.' || p.t || ' WHERE id = ' || quote_literal(p.own_a), 'n'), 'n=1', 'control: tenant A staff reads its own ' || p.t || ' row') FROM probe p;
SELECT cmp_ok((SELECT count(*) FROM frontdesk.coupons WHERE tenant_id = pg_temp.tb()), '>=', 1, 'fixture: tenant B has coupons');
SELECT is(pg_temp.a('SELECT 1 FROM frontdesk.' || p.t || ' WHERE tenant_id = ' || quote_literal(pg_temp.tb()), 'n'), 'n=0', 'tenant A sees 0 tenant B rows in ' || p.t) FROM probe p;
SELECT is(pg_temp.b('SELECT 1 FROM frontdesk.' || p.t || ' WHERE tenant_id = ' || quote_literal(pg_temp.ta()), 'n'), 'n=0', 'tenant B sees 0 tenant A rows in ' || p.t) FROM probe p;
SELECT is(pg_temp.a('UPDATE frontdesk.' || t || ' SET version = version + 1 WHERE tenant_id = ' || quote_literal(pg_temp.tb())), 'n=0', 'tenant A updates 0 tenant B rows in ' || t)
  FROM (VALUES ('coupons'),('icd_codes'),('custom_field_definitions'),('registration_drafts')) v(t);
SELECT is(pg_temp.a('DELETE FROM frontdesk.' || t || ' WHERE tenant_id = ' || quote_literal(pg_temp.tb())), 'n=0', 'tenant A deletes 0 tenant B rows in ' || t) FROM (VALUES ('registration_drafts'),('favourite_tests')) v(t);
SELECT alike(pg_temp.a(format($$ INSERT INTO frontdesk.coupons (id, tenant_id, code, percent, created_by, updated_by) VALUES (%L, %L, 'HIJACK', 5, %L, %L) $$, pg_temp.uid(500), pg_temp.tb(), pg_temp.sys(), pg_temp.sys())), 'E42501|%',
  'tenant A cannot insert a coupon for tenant B');
SELECT alike(pg_temp.a(format($$ INSERT INTO frontdesk.registration_drafts (id, tenant_id, user_id, centre_id, payload, created_by, updated_by) VALUES (%L, %L, %L, %L, '{}', %L, %L) $$,
  pg_temp.uid(501), pg_temp.tb(), pg_temp.mem(pg_temp.tb()), pg_temp.centre(pg_temp.tb()), pg_temp.sys(), pg_temp.sys())), 'E42501|%', 'tenant A cannot insert a draft for tenant B');
SELECT alike(pg_temp.a(format($$ INSERT INTO frontdesk.favourite_tests (id, tenant_id, user_id, orderable_id, created_by, updated_by) VALUES (%L, %L, %L, %L, %L, %L) $$,
  pg_temp.uid(502), pg_temp.tb(), pg_temp.mem(pg_temp.tb()), pg_temp.uid(99), pg_temp.sys(), pg_temp.sys())), 'E42501|%', 'tenant A cannot insert a favourite for tenant B');
SELECT is(pg_temp.a(format($$ INSERT INTO frontdesk.icd_codes (id, tenant_id, code, description, created_by, updated_by) VALUES (%L, %L, 'Z99', 'Synthetic own', %L, %L) $$, pg_temp.uid(503), pg_temp.ta(), pg_temp.sys(), pg_temp.sys())), 'n=1',
  'tenant A staff inserts its own icd code');
SELECT is(pg_temp.a('DELETE FROM frontdesk.registration_drafts WHERE id = ' || quote_literal(pg_temp.uid(301))), 'n=1', 'tenant A staff deletes its own draft');
SELECT is(pg_temp.a('DELETE FROM frontdesk.favourite_tests WHERE id = ' || quote_literal(pg_temp.uid(402))), 'n=1', 'tenant A staff removes a favourite');
SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta()), 'SELECT 1 FROM frontdesk.' || p.t, 'n') <> 'n=0', true, 'control: a staff actor sees rows of ' || p.t) FROM probe p;
SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), r.k), 'SELECT 1 FROM frontdesk.' || p.t, 'n'), 'n=0', 'a ' || r.k || '-actor sees 0 rows of ' || p.t) FROM probe p CROSS JOIN (VALUES ('patient'),('partner'),('portal')) r(k);
SELECT alike(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), r.k), format($$ INSERT INTO frontdesk.coupons (id, tenant_id, code, percent, created_by, updated_by) VALUES (%L, %L, 'PORTALX', 5, %L, %L) $$,
  pg_temp.uid(510), pg_temp.ta(), pg_temp.sys(), pg_temp.sys()), 'w'), 'E42501|%', 'a ' || r.k || '-actor cannot insert a coupon') FROM (VALUES ('patient'),('partner'),('portal')) r(k);

-- ===================================================================================================================================== (c) audit (D-27a): health text and draft payload never in audit diffs
SELECT is(pg_temp.a('UPDATE frontdesk.orders SET priority = ''urgent'' WHERE id = ' || quote_literal(pg_temp.uid(12))), 'n=1', 'update a mutable column of the fully populated order');
SELECT is((SELECT count(*)::int FROM audit.audit_log a WHERE a.schema_name = 'frontdesk' AND a.table_name = 'orders'
            AND (a.changed_columns && ARRAY['clinical_history','patient_history'] OR a.old_values ?| ARRAY['clinical_history','patient_history'] OR a.new_values ?| ARRAY['clinical_history','patient_history'])), 0,
  'D-27a / LD-310: clinical_history and patient_history never in changed_columns / old_values / new_values of an orders audit row');
SELECT is((SELECT count(*)::int FROM audit.audit_log a WHERE (coalesce(a.old_values::text, '') || coalesce(a.new_values::text, '') || coalesce(a.changed_columns::text, '')) ~ 'SYN-CLIN-0001|SYN-PHIS-0001|SYN-HOLDER-0001|SYN-DRAFT-MARKER'), 0,
  'no clinical text, card holder name or draft payload value anywhere in audit.audit_log');
SELECT is((SELECT count(*)::int FROM audit.audit_log WHERE schema_name = 'frontdesk' AND table_name = 'orders' AND row_id = pg_temp.uid(12) AND action = 'INSERT'), 1, 'control: the INSERT of the order was audited (trigger still fires)');
SELECT ok((SELECT 'priority' = ANY (changed_columns) FROM audit.audit_log WHERE schema_name = 'frontdesk' AND table_name = 'orders' AND row_id = pg_temp.uid(12) AND action = 'UPDATE'),
  'control: priority still recorded as changed (exclusion list extended, not an all-columns filter)');
SELECT is((SELECT count(*)::int FROM pg_trigger WHERE tgrelid = 'frontdesk.orders'::regclass AND tgname = 'orders__audit' AND NOT tgisinternal), 1, 'exactly one orders__audit trigger');
SELECT is((SELECT count(*)::int FROM audit.audit_log WHERE schema_name = 'frontdesk' AND table_name = 'coupons' AND row_id = pg_temp.uid(100) AND action = 'INSERT'), 1, 'control: coupon INSERT is audited (admin master data)');
SELECT is((SELECT count(*)::int FROM pg_trigger WHERE tgrelid = to_regclass('frontdesk.registration_drafts') AND NOT tgisinternal AND pg_get_triggerdef(oid) ~ 'tg_row_audit' AND pg_get_triggerdef(oid) !~ '''payload'''), 0,
  'a drafts audit trigger, if present, excludes payload');
-- exposure: no view / other table carries the sensitive columns
SELECT is((SELECT count(*)::int FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid WHERE a.attname IN ('card_holder_name','clinical_history','patient_history') AND NOT a.attisdropped AND a.attnum > 0 AND c.relkind IN ('v','m')), 0,
  'no view or materialised view exposes card_holder_name, clinical_history or patient_history');
SELECT is((SELECT count(*)::int FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid WHERE a.attname = 'card_holder_name' AND NOT a.attisdropped AND a.attnum > 0 AND c.relkind IN ('r','p')), 1, 'card_holder_name lives only on billing.ledger_entries');
SELECT is((SELECT count(*)::int FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid WHERE a.attname IN ('clinical_history','patient_history') AND NOT a.attisdropped AND a.attnum > 0 AND c.relkind IN ('r','p') AND c.oid <> 'frontdesk.orders'::regclass), 0,
  'clinical_history and patient_history live only on frontdesk.orders');

-- ===================================================================================================================================== idempotent re-apply: second run changes nothing
CREATE FUNCTION pg_temp.colcount() RETURNS bigint LANGUAGE sql AS $$
  SELECT count(*) FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid WHERE a.attnum > 0 AND NOT a.attisdropped
     AND (c.oid IN ('frontdesk.orders'::regclass, 'frontdesk.order_items'::regclass, 'billing.ledger_entries'::regclass)
          OR (c.relnamespace = 'frontdesk'::regnamespace AND c.relname IN (SELECT t FROM nt))) $$;
CREATE TEMP TABLE before_state AS
  SELECT pg_temp.colcount() AS cols,
         (SELECT count(*) FROM pg_constraint WHERE conrelid IN (SELECT oid FROM pg_class WHERE relnamespace IN ('frontdesk'::regnamespace, 'billing'::regnamespace))) AS cons,
         (SELECT count(*) FROM pg_index WHERE indrelid IN (SELECT oid FROM pg_class WHERE relnamespace IN ('frontdesk'::regnamespace, 'billing'::regnamespace))) AS idxs,
         (SELECT count(*) FROM pg_policy WHERE polrelid IN (SELECT oid FROM pg_class WHERE relnamespace IN ('frontdesk'::regnamespace, 'billing'::regnamespace))) AS pols,
         (SELECT string_agg(pg_get_triggerdef(oid), '|' ORDER BY tgrelid::regclass::text, tgname) FROM pg_trigger WHERE tgrelid IN (SELECT oid FROM pg_class WHERE relnamespace IN ('frontdesk'::regnamespace, 'billing'::regnamespace)) AND NOT tgisinternal) AS trg,
         (SELECT count(*) FROM frontdesk.orders) AS n_orders, (SELECT count(*) FROM frontdesk.coupons) AS n_coupons, (SELECT count(*) FROM frontdesk.registration_drafts) AS n_drafts,
         (SELECT count(*) FROM frontdesk.reward_points_ledger) AS n_rewards, (SELECT count(*) FROM billing.ledger_entries) AS n_ledger;
\ir ../../migrations/20261117110000_frontdesk__add_registration_parity_fields.sql
RESET ROLE;
SELECT is((SELECT count(*) FROM pg_constraint WHERE conrelid IN (SELECT oid FROM pg_class WHERE relnamespace IN ('frontdesk'::regnamespace, 'billing'::regnamespace))), (SELECT cons FROM before_state), 're-apply: constraint count unchanged');
SELECT is((SELECT count(*) FROM pg_index WHERE indrelid IN (SELECT oid FROM pg_class WHERE relnamespace IN ('frontdesk'::regnamespace, 'billing'::regnamespace))), (SELECT idxs FROM before_state), 're-apply: index count unchanged');
SELECT is((SELECT count(*) FROM pg_policy WHERE polrelid IN (SELECT oid FROM pg_class WHERE relnamespace IN ('frontdesk'::regnamespace, 'billing'::regnamespace))), (SELECT pols FROM before_state), 're-apply: policy count unchanged');
SELECT is((SELECT string_agg(pg_get_triggerdef(oid), '|' ORDER BY tgrelid::regclass::text, tgname) FROM pg_trigger WHERE tgrelid IN (SELECT oid FROM pg_class WHERE relnamespace IN ('frontdesk'::regnamespace, 'billing'::regnamespace)) AND NOT tgisinternal),
  (SELECT trg FROM before_state), 're-apply: triggers unchanged');
SELECT is(pg_temp.colcount(), (SELECT cols FROM before_state), 're-apply: column count unchanged');
SELECT is((SELECT count(*) FROM frontdesk.orders), (SELECT n_orders FROM before_state), 're-apply: no order row added or removed');
SELECT is((SELECT count(*) FROM frontdesk.coupons), (SELECT n_coupons FROM before_state), 're-apply: no coupon row added or removed');
SELECT is((SELECT count(*) FROM frontdesk.registration_drafts), (SELECT n_drafts FROM before_state), 're-apply: no draft row added or removed');
SELECT is((SELECT count(*) FROM frontdesk.reward_points_ledger), (SELECT n_rewards FROM before_state), 're-apply: no reward row added or removed');
SELECT is((SELECT count(*) FROM billing.ledger_entries), (SELECT n_ledger FROM before_state), 're-apply: no ledger row added or removed');
SELECT is((SELECT clinical_history FROM frontdesk.orders WHERE id = pg_temp.uid(12)), 'synthetic clinical history SYN-CLIN-0001', 're-apply: no data rewrite (order text intact)');
SELECT is((SELECT card_holder_name FROM billing.ledger_entries WHERE id = pg_temp.uid(70)), 'Synthetic Holder SYN-HOLDER-0001', 're-apply: no data rewrite (ledger card holder intact)');
SELECT is((SELECT used_count FROM frontdesk.coupons WHERE id = pg_temp.uid(100)), 0, 're-apply: coupon row intact');

SELECT * FROM finish();
ROLLBACK;
