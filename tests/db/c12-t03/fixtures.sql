-- C12 T-03 fixtures for the inventory repository integration tests (synthetic data only; fresh migrated + seeded database + inventory DDL, superuser session).
-- Technique of tests/db/c14-t02/fixtures.sql: superuser inserts, core system actor claims, SET LOCAL session_replication_role = replica so the draft-only/transition triggers
-- and FK triggers do not run while the fixture is laid down (the repositories later run as lims_api with every constraint live). CHECK constraints still apply.
-- Tenants/branches/centres come from db/seeds/010 (tenant A ...a001, B ...b001; branches a101/b101; centres a201/b201). Ids via pg_temp.uid(n).
-- Shape:
--   coded sets: global uom test/ml/piece/box, reasons wastage/spillage|damaged, po_cancel/duplicate, count_variance/count_variance, tax VAT (ON CONFLICT DO NOTHING: C0 seeds may exist)
--               tenant A cs_reasons 9801 wastage/spillage (shadows global), 9802 wastage/lab_custom, 9803 INACTIVE wastage/old_one; cs_tax_codes 9811 LOCALTAX, 9812 INACTIVE OLDTAX; tenant B 9821 wastage/spillage, 9831 LOCALTAX
--   parents:    catalog tests 7001 (A) 7101 (B); instruments 421 IN-A1, 422 IN-A2 (A, centre a201), 431 IN-B1 (B)
--   stores:     A 1001 MAIN-A (main, default consumption) 1002 BENCH-A 1003 OLD-A INACTIVE (all branch a101); B 1101 MAIN-B 1102 BENCH-B (branch b101)
--   items:      A 2001 GLU-R1 (base 'test', lot tracked) 2002 CTRL-L1 (ml) 2003 TIPS-200 (piece, NOT lot tracked) 2004 OLD-IT INACTIVE; B 2101 GLU-R1 (same code as A)
--   packs:      A 2201 BOX (item 2001, 400, purchase default) 2202 KIT (item 2001, 100) 2203 OLDBOX INACTIVE (item 2001); B 2301 BOX (item 2101)
--   barcodes:   A 2401 'BC-GLU-1' (item 2001 pack 2201) 2402 INACTIVE 'BC-OLD' (item 2001); B 2411 'BC-GLU-1' (item 2101)
--   suppliers:  A 3001 SUP-01 'Alpha Lab Supplies' 3002 SUP-02 'Beta Chemicals' 3003 SUP-03 INACTIVE 'Alphabet Old'; B 3101 SUP-01
--   supplier_items A 3201 (3001 x 2001 x 2201); B 3301.   store_item_settings: A 3401 (1001,2001, reorder 100) 3402 (1001,2002, NO reorder) 3403 (1002,2001, reorder 10, INACTIVE); B 3501 (1101,2101, reorder 5)
--   lots:       A 4001 L-001 (item 2001, expiry 2026-12-01) 4002 L-002 (2001, 2027-06-01) 4003 C-001 (item 2002, 2026-11-20); B 4101 L-001 (item 2101)
--   balances:   A 5001 (1001,2001,lot 4001, qty 100, value 50000) 5002 (1001,2001,lot 4002, qty 0) 5003 (1001,2003, lot NULL, qty 50) 5004 (1002,2001,lot 4001, qty 20); B 5101 (1101,2101,lot 4101, qty 7)
--   movements:  A 6001 receive +100 (goods_receipt doc 8001, lot 4001, -3 d) 6002 issue -10 (stock_document 9001, -2 d) 6003 consume_test -5 (consumption_fact doc 9501, instrument 421, test 7001, -1 d) 6004 receive +50 unlotted (item 2003, -3 d); B 6101
--   rules:      A 7001 per_test test 7001 any instrument item 2001 (current) 7002 per_test test 7001 instrument 421 item 2001 (current) 7003 per_test test 7001 any item 2001 SUPERSEDED (effective_to set)
--               7004 per_day instrument 421 item 2002 (current) 7005 per_qc test 7001 item 2002 INACTIVE; B 7101
--   facts:      A 7201 unresolved (occurred -2 h) 7203 unresolved (occurred -5 h) 7202 posted (store 1001); B 7301 unresolved
--   documents:  A 9001 SD-A-1 issue (store 1001, general) 9002 SD-A-2 wastage (spillage); lines 9101 (doc 9001 line 1) 9102 (doc 9001 line 2); B 9201 + line 9202
--   GRN:        A 8001 draft (store 1001, supplier 3001) 8002 posted; lines 8201 (grn 8001 line 1) 8202 (grn 8001 line 1, REMOVED) 8203 (grn 8001 line 2); B 8101 draft, line 8211
--   PO:         A 8301 draft (store 1001 sup 3001, -3 d) 8302 approved (store 1002 sup 3002, -2 d) 8303 sent (store 1001 sup 3001, -1 d); lines 8501 (po 8301 line 1) 8502 (po 8301 line 1 REMOVED) 8503 (po 8301 line 2) 8504 (po 8302 line 1); B 8401 draft, line 8601
--   transfers:  A 8701 draft (1001 -> 1002) 8702 dispatched (1001 -> 1002); lines 8711 (tr 8701 line 1) 8712 (tr 8701 line 1 REMOVED) 8713 (tr 8701 line 2); B 8801 draft (1101 -> 1102), line 8811
--   counts:     A 8901 open (store 1001) 8902 posted (store 1002) 8903 cancelled (store 1001); lines 8921 (count 8901, item 2001 lot 4001) 8922 (count 8901, item 2003 lot NULL); B 8911 open (1101), line 8931
--   containers: A 9301 open (store 1001, item 2002, lot 4003, instrument 421, opened -2 h, open_expiry +20 d) 9302 finished (opened -10 d); B 9311 open (1101, item 2101)
--   bindings:   A 9401 (421 -> 1001) active, 9402 (422 -> 1002) INACTIVE; B 9411 (431 -> 1101)
--   alerts:     A 9501 below_reorder open dedupe 'below:2001:1001' 9502 expiry_soon acknowledged 9503 reconciliation_gap resolved (expires -1 d); B 9511 below_reorder open, same dedupe key
--   settings:   A 9601 (defaults); B none (lazy).  number_counters: A (po, yy:26, next 5).  daily: consumption_daily A 9701 (instr 421, test 7001) 9702 (instr NULL, test NULL) B 9711; test_counts_daily A 9721 (instr 421) 9722 (instr NULL) B 9731
--   instrument_qc_daily: A (today-1, 421, 3), (today-1, 422, 1); B (today-1, 431, 2)
BEGIN;
SET search_path = extensions, public, pg_catalog;
SET LOCAL session_replication_role = replica;

CREATE FUNCTION pg_temp.ta() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1a98a-ac40-7000-8000-00000000a001'::uuid $$;
CREATE FUNCTION pg_temp.tb() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1a98a-ac40-7000-8000-00000000b001'::uuid $$;
CREATE FUNCTION pg_temp.sys() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1b34e-1000-7eee-9d29-d7ca59a102b5'::uuid $$;
CREATE FUNCTION pg_temp.uid(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('0190c514-0000-7000-8000-' || lpad(n::text, 12, '0'))::uuid $$;
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
-- one commercial line body (qty_packs 1 x 400 base, price 500.00, no tax): shared by PO / GRN lines
CREATE FUNCTION pg_temp.line(n int) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object('line_no', n, 'qty_packs', 1, 'qty_in_base_snapshot', 400, 'qty_base', 400, 'unit_price_paisa', 50000, 'discount_paisa', 0,
    'tax_rate_bp', 0, 'net_paisa', 50000, 'vat_paisa', 0, 'line_total_paisa', 50000) $$;

-- ---------------------------------------------------------------- global coded sets (C0 seeds may already hold them)
INSERT INTO inventory.g_cs_uom (id, code, display, uom_kind) VALUES
  (pg_temp.uid(9901), 'test', 'test', 'count'), (pg_temp.uid(9902), 'ml', 'mL', 'volume'), (pg_temp.uid(9903), 'piece', 'piece', 'count'), (pg_temp.uid(9904), 'box', 'box', 'count')
  ON CONFLICT (code) DO NOTHING;
INSERT INTO inventory.g_cs_reasons (id, reason_group, code, display) VALUES
  (pg_temp.uid(9911), 'wastage', 'spillage', 'Spillage'), (pg_temp.uid(9912), 'wastage', 'damaged', 'Damaged'), (pg_temp.uid(9913), 'po_cancel', 'duplicate', 'Duplicate'),
  (pg_temp.uid(9914), 'count_variance', 'count_variance', 'Count variance')
  ON CONFLICT (reason_group, code) DO NOTHING;
INSERT INTO inventory.g_cs_tax_codes (id, code, display) VALUES (pg_temp.uid(9921), 'VAT', 'VAT') ON CONFLICT (code) DO NOTHING;

-- ---------------------------------------------------------------- catalog + instruments parents
SELECT pg_temp.ins('catalog.tests', jsonb_build_object('id', pg_temp.uid(t.n), 'tenant_id', t.t, 'workflow_type', 'standard')) FROM (VALUES (7001, pg_temp.ta()), (7101, pg_temp.tb())) t(n, t);
SELECT pg_temp.ins('instruments.instruments', jsonb_build_object('id', pg_temp.uid(i.n), 'tenant_id', i.t, 'centre_id', i.c, 'agent_id', pg_temp.uid(i.n + 1000), 'instrument_code', i.code,
    'display_name', 'Instrument ' || i.code, 'vendor', 'Synthetic', 'model', 'SX-1', 'protocol', 'astm', 'driver_code', 'astm_generic_e1394',
    'transport', jsonb_build_object('kind', 'tcp_client'), 'timezone', 'Asia/Kathmandu', 'state', 'draft'))
  FROM (VALUES (421, pg_temp.ta(), pg_temp.id('00000000a201'), 'IN-A1'), (422, pg_temp.ta(), pg_temp.id('00000000a201'), 'IN-A2'), (431, pg_temp.tb(), pg_temp.id('00000000b201'), 'IN-B1')) i(n, t, c, code);

-- ---------------------------------------------------------------- tenant coded sets
SELECT pg_temp.ins('inventory.cs_reasons', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', r.t, 'reason_group', r.g, 'code', r.c, 'display', r.d, 'is_active', r.a))
  FROM (VALUES (9801, pg_temp.ta(), 'wastage', 'spillage', 'Spillage (tenant label)', true), (9802, pg_temp.ta(), 'wastage', 'lab_custom', 'Lab custom', true),
               (9803, pg_temp.ta(), 'wastage', 'old_one', 'Old one', false), (9821, pg_temp.tb(), 'wastage', 'spillage', 'Spillage B', true)) r(n, t, g, c, d, a);
SELECT pg_temp.ins('inventory.cs_tax_codes', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', r.t, 'code', r.c, 'display', r.c, 'is_active', r.a))
  FROM (VALUES (9811, pg_temp.ta(), 'LOCALTAX', true), (9812, pg_temp.ta(), 'OLDTAX', false), (9831, pg_temp.tb(), 'LOCALTAX', true)) r(n, t, c, a);

-- ---------------------------------------------------------------- stores, items, packs, barcodes
SELECT pg_temp.ins('inventory.stores', jsonb_build_object('id', pg_temp.uid(s.n), 'tenant_id', s.t, 'branch_id', s.b, 'store_code', s.c, 'name', 'Store ' || s.c, 'store_kind', s.k,
    'is_default_consumption', s.d, 'is_active', s.a))
  FROM (VALUES (1001, pg_temp.ta(), pg_temp.id('00000000a101'), 'MAIN-A', 'main', true, true), (1002, pg_temp.ta(), pg_temp.id('00000000a101'), 'BENCH-A', 'bench', false, true),
               (1003, pg_temp.ta(), pg_temp.id('00000000a101'), 'OLD-A', 'bench', false, false),
               (1101, pg_temp.tb(), pg_temp.id('00000000b101'), 'MAIN-B', 'main', true, true), (1102, pg_temp.tb(), pg_temp.id('00000000b101'), 'BENCH-B', 'bench', false, true)) s(n, t, b, c, k, d, a);
SELECT pg_temp.ins('inventory.items', jsonb_build_object('id', pg_temp.uid(i.n), 'tenant_id', i.t, 'item_code', i.c, 'name', i.nm, 'category', i.cat, 'base_uom_code', i.u,
    'is_lot_tracked', i.lt, 'requires_expiry', i.lt, 'is_active', i.a))
  FROM (VALUES (2001, pg_temp.ta(), 'GLU-R1', 'Glucose reagent', 'reagent', 'test', true, true), (2002, pg_temp.ta(), 'CTRL-L1', 'Control level 1', 'control', 'ml', true, true),
               (2003, pg_temp.ta(), 'TIPS-200', 'Tips 200', 'consumable', 'piece', false, true), (2004, pg_temp.ta(), 'OLD-IT', 'Old item', 'other', 'piece', false, false),
               (2101, pg_temp.tb(), 'GLU-R1', 'Glucose reagent', 'reagent', 'test', true, true)) i(n, t, c, nm, cat, u, lt, a);
SELECT pg_temp.ins('inventory.item_packs', jsonb_build_object('id', pg_temp.uid(p.n), 'tenant_id', p.t, 'item_id', pg_temp.uid(p.i), 'pack_code', p.c, 'label', 'Pack ' || p.c, 'uom_code', 'box',
    'qty_in_base', p.q, 'is_purchase_default', p.d, 'is_active', p.a))
  FROM (VALUES (2201, pg_temp.ta(), 2001, 'BOX', 400, true, true), (2202, pg_temp.ta(), 2001, 'KIT', 100, false, true), (2203, pg_temp.ta(), 2001, 'OLDBOX', 50, false, false),
               (2301, pg_temp.tb(), 2101, 'BOX', 400, true, true)) p(n, t, i, c, q, d, a);
SELECT pg_temp.ins('inventory.item_barcodes', jsonb_build_object('id', pg_temp.uid(b.n), 'tenant_id', b.t, 'item_id', pg_temp.uid(b.i), 'pack_id', b.p, 'barcode_value', b.v, 'is_active', b.a))
  FROM (VALUES (2401, pg_temp.ta(), 2001, pg_temp.uid(2201), 'BC-GLU-1', true), (2402, pg_temp.ta(), 2001, NULL::uuid, 'BC-OLD', false), (2411, pg_temp.tb(), 2101, pg_temp.uid(2301), 'BC-GLU-1', true)) b(n, t, i, p, v, a);

-- ---------------------------------------------------------------- suppliers, supplier items, store item settings
SELECT pg_temp.ins('inventory.suppliers', jsonb_build_object('id', pg_temp.uid(s.n), 'tenant_id', s.t, 'supplier_code', s.c, 'name', s.nm, 'is_active', s.a))
  FROM (VALUES (3001, pg_temp.ta(), 'SUP-01', 'Alpha Lab Supplies', true), (3002, pg_temp.ta(), 'SUP-02', 'Beta Chemicals', true), (3003, pg_temp.ta(), 'SUP-03', 'Alphabet Old', false),
               (3101, pg_temp.tb(), 'SUP-01', 'Alpha Lab Supplies', true)) s(n, t, c, nm, a);
SELECT pg_temp.ins('inventory.supplier_items', jsonb_build_object('id', pg_temp.uid(s.n), 'tenant_id', s.t, 'supplier_id', pg_temp.uid(s.s), 'item_id', pg_temp.uid(s.i), 'pack_id', pg_temp.uid(s.p),
    'last_unit_price_paisa', 50000))
  FROM (VALUES (3201, pg_temp.ta(), 3001, 2001, 2201), (3301, pg_temp.tb(), 3101, 2101, 2301)) s(n, t, s, i, p);
SELECT pg_temp.ins('inventory.store_item_settings', jsonb_build_object('id', pg_temp.uid(s.n), 'tenant_id', s.t, 'store_id', pg_temp.uid(s.st), 'item_id', pg_temp.uid(s.i),
    'reorder_level_base', s.rl, 'reorder_qty_base', s.rq, 'is_active', s.a))
  FROM (VALUES (3401, pg_temp.ta(), 1001, 2001, 100, 400, true), (3402, pg_temp.ta(), 1001, 2002, NULL::int, NULL::int, true), (3403, pg_temp.ta(), 1002, 2001, 10, 100, false),
               (3501, pg_temp.tb(), 1101, 2101, 5, 100, true)) s(n, t, st, i, rl, rq, a);

-- ---------------------------------------------------------------- lots and balances
SELECT pg_temp.ins('inventory.lots', jsonb_build_object('id', pg_temp.uid(l.n), 'tenant_id', l.t, 'item_id', pg_temp.uid(l.i), 'lot_no', l.no, 'expiry_on', l.e))
  FROM (VALUES (4001, pg_temp.ta(), 2001, 'L-001', '2026-12-01'), (4002, pg_temp.ta(), 2001, 'L-002', '2027-06-01'), (4003, pg_temp.ta(), 2002, 'C-001', '2026-11-20'),
               (4101, pg_temp.tb(), 2101, 'L-001', '2026-12-01')) l(n, t, i, no, e);
SELECT pg_temp.ins('inventory.stock_balances', jsonb_build_object('id', pg_temp.uid(b.n), 'tenant_id', b.t, 'store_id', pg_temp.uid(b.s), 'item_id', pg_temp.uid(b.i), 'lot_id', b.l,
    'qty_base', b.q, 'value_paisa', b.v, 'last_movement_at', now() - interval '1 hour'))
  FROM (VALUES (5001, pg_temp.ta(), 1001, 2001, pg_temp.uid(4001), 100, 50000), (5002, pg_temp.ta(), 1001, 2001, pg_temp.uid(4002), 0, 0), (5003, pg_temp.ta(), 1001, 2003, NULL::uuid, 50, 0),
               (5004, pg_temp.ta(), 1002, 2001, pg_temp.uid(4001), 20, 10000), (5101, pg_temp.tb(), 1101, 2101, pg_temp.uid(4101), 7, 3500)) b(n, t, s, i, l, q, v);

-- ---------------------------------------------------------------- consumption rules, facts
SELECT pg_temp.ins('inventory.consumption_rules', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', r.t, 'rule_kind', r.k, 'test_id', r.te, 'instrument_id', r.ins, 'item_id', pg_temp.uid(r.i),
    'qty_base', 1, 'entered_qty', 1, 'effective_from', now() - interval '30 days', 'effective_to', r.et, 'is_active', r.a))
  FROM (VALUES (7001, pg_temp.ta(), 'per_test', pg_temp.uid(7001), NULL::uuid, 2001, NULL::timestamptz, true), (7002, pg_temp.ta(), 'per_test', pg_temp.uid(7001), pg_temp.uid(421), 2001, NULL::timestamptz, true),
               (7003, pg_temp.ta(), 'per_test', pg_temp.uid(7001), NULL::uuid, 2001, now() - interval '1 day', true), (7004, pg_temp.ta(), 'per_day', NULL::uuid, pg_temp.uid(421), 2002, NULL::timestamptz, true),
               (7005, pg_temp.ta(), 'per_qc', pg_temp.uid(7001), NULL::uuid, 2002, NULL::timestamptz, false), (7101, pg_temp.tb(), 'per_test', pg_temp.uid(7101), NULL::uuid, 2101, NULL::timestamptz, true)) r(n, t, k, te, ins, i, et, a);
SELECT pg_temp.ins('inventory.consumption_facts', jsonb_build_object('id', pg_temp.uid(f.n), 'tenant_id', f.t, 'fact_kind', 'test', 'basis_key', 'basis-' || f.n, 'source', 'manual',
    'instrument_id', f.ins, 'test_id', f.te, 'occurred_at', now() - f.age, 'business_date', current_date, 'status', f.st, 'store_id', f.s, 'rules_applied', f.ra))
  FROM (VALUES (7201, pg_temp.ta(), pg_temp.uid(421), pg_temp.uid(7001), interval '2 hours', 'unresolved', NULL::uuid, 0), (7203, pg_temp.ta(), pg_temp.uid(421), pg_temp.uid(7001), interval '5 hours', 'unresolved', NULL::uuid, 0),
               (7202, pg_temp.ta(), pg_temp.uid(421), pg_temp.uid(7001), interval '3 hours', 'posted', pg_temp.uid(1001), 1), (7301, pg_temp.tb(), pg_temp.uid(431), pg_temp.uid(7101), interval '1 hour', 'unresolved', NULL::uuid, 0)) f(n, t, ins, te, age, st, s, ra);

-- ---------------------------------------------------------------- documents (A tables) and ledger
SELECT pg_temp.ins('inventory.stock_documents', jsonb_build_object('id', pg_temp.uid(d.n), 'tenant_id', d.t, 'doc_no', d.no, 'doc_kind', d.k, 'store_id', pg_temp.uid(d.s), 'occurred_at', now() - d.age,
    'issued_to_kind', d.it, 'reason_code', d.rc))
  FROM (VALUES (9001, pg_temp.ta(), 'SD-A-1', 'issue', 1001, interval '2 days', 'general', NULL::text), (9002, pg_temp.ta(), 'SD-A-2', 'wastage', 1001, interval '1 day', NULL::text, 'spillage'),
               (9201, pg_temp.tb(), 'SD-B-1', 'issue', 1101, interval '2 days', 'general', NULL::text)) d(n, t, no, k, s, age, it, rc);
SELECT pg_temp.ins('inventory.stock_document_lines', jsonb_build_object('id', pg_temp.uid(l.n), 'tenant_id', l.t, 'document_id', pg_temp.uid(l.d), 'line_no', l.ln, 'item_id', pg_temp.uid(l.i),
    'lot_id', pg_temp.uid(l.lot), 'direction', 'out', 'qty_base', 10, 'value_paisa', 5000))
  FROM (VALUES (9101, pg_temp.ta(), 9001, 1, 2001, 4001), (9102, pg_temp.ta(), 9001, 2, 2001, 4002), (9202, pg_temp.tb(), 9201, 1, 2101, 4101)) l(n, t, d, ln, i, lot);
SELECT pg_temp.ins('inventory.stock_movements', jsonb_build_object('id', pg_temp.uid(m.n), 'tenant_id', m.t, 'business_date', (now() - m.age)::date, 'occurred_at', now() - m.age,
    'store_id', pg_temp.uid(m.s), 'item_id', pg_temp.uid(m.i), 'lot_id', m.lot, 'movement_kind', m.k, 'qty_base', m.q, 'value_paisa', m.v, 'value_basis', m.vb,
    'doc_type', m.dt, 'doc_id', pg_temp.uid(m.d), 'instrument_id', m.ins, 'attributed_test_id', m.te, 'balance_qty_after', m.ba))
  FROM (VALUES (6001, pg_temp.ta(), interval '3 days', 1001, 2001, pg_temp.uid(4001), 'receive', 100, 50000, 'receipt', 'goods_receipt', 8001, NULL::uuid, NULL::uuid, 100),
               (6002, pg_temp.ta(), interval '2 days', 1001, 2001, pg_temp.uid(4001), 'issue', -10, -5000, 'average', 'stock_document', 9001, NULL::uuid, NULL::uuid, 90),
               (6003, pg_temp.ta(), interval '1 day', 1001, 2001, pg_temp.uid(4001), 'consume_test', -5, -2500, 'average', 'consumption_fact', 9501, pg_temp.uid(421), pg_temp.uid(7001), 85),
               (6004, pg_temp.ta(), interval '3 days', 1001, 2003, NULL::uuid, 'receive', 50, 0, 'none', 'goods_receipt', 8002, NULL::uuid, NULL::uuid, 50),
               (6101, pg_temp.tb(), interval '3 days', 1101, 2101, pg_temp.uid(4101), 'receive', 7, 3500, 'receipt', 'goods_receipt', 8101, NULL::uuid, NULL::uuid, 7)) m(n, t, age, s, i, lot, k, q, v, vb, dt, d, ins, te, ba);

-- ---------------------------------------------------------------- goods receipts, purchase orders, transfers (+ lines; REMOVED lines carry removed_at/removed_by)
SELECT pg_temp.ins('inventory.goods_receipts', jsonb_build_object('id', pg_temp.uid(g.n), 'tenant_id', g.t, 'grn_no', g.no, 'kind', 'purchase', 'store_id', pg_temp.uid(g.s), 'supplier_id', pg_temp.uid(g.sup),
    'status', g.st, 'received_at', now() - g.age, 'posted_at', g.pa, 'posted_by', g.pb))
  FROM (VALUES (8001, pg_temp.ta(), 'GR260000001', 1001, 3001, 'draft', interval '2 days', NULL::timestamptz, NULL::uuid), (8002, pg_temp.ta(), 'GR260000002', 1001, 3002, 'posted', interval '5 days', now() - interval '5 days', pg_temp.sys()),
               (8101, pg_temp.tb(), 'GR260000001', 1101, 3101, 'draft', interval '2 days', NULL::timestamptz, NULL::uuid)) g(n, t, no, s, sup, st, age, pa, pb);
SELECT pg_temp.ins('inventory.goods_receipt_lines', jsonb_build_object('id', pg_temp.uid(l.n), 'tenant_id', l.t, 'grn_id', pg_temp.uid(l.g), 'item_id', pg_temp.uid(l.i), 'pack_id', pg_temp.uid(l.p),
    'removed_at', l.ra, 'removed_by', l.rb) || pg_temp.line(l.ln))
  FROM (VALUES (8201, pg_temp.ta(), 8001, 2001, 2201, 1, NULL::timestamptz, NULL::uuid), (8202, pg_temp.ta(), 8001, 2001, 2201, 1, now() - interval '1 day', pg_temp.sys()),
               (8203, pg_temp.ta(), 8001, 2001, 2201, 2, NULL::timestamptz, NULL::uuid), (8211, pg_temp.tb(), 8101, 2101, 2301, 1, NULL::timestamptz, NULL::uuid)) l(n, t, g, i, p, ln, ra, rb);
SELECT pg_temp.ins('inventory.purchase_orders', jsonb_build_object('id', pg_temp.uid(p.n), 'tenant_id', p.t, 'po_no', p.no, 'branch_id', p.b, 'store_id', pg_temp.uid(p.s), 'supplier_id', pg_temp.uid(p.sup),
    'status', p.st, 'created_at', now() - p.age, 'approved_at', p.aa, 'approved_by', p.ab, 'sent_at', p.sa, 'sent_by', p.sb))
  FROM (VALUES (8301, pg_temp.ta(), 'PO260000001', pg_temp.id('00000000a101'), 1001, 3001, 'draft', interval '3 days', NULL::timestamptz, NULL::uuid, NULL::timestamptz, NULL::uuid),
               (8302, pg_temp.ta(), 'PO260000002', pg_temp.id('00000000a101'), 1002, 3002, 'approved', interval '2 days', now() - interval '2 days', pg_temp.sys(), NULL::timestamptz, NULL::uuid),
               (8303, pg_temp.ta(), 'PO260000003', pg_temp.id('00000000a101'), 1001, 3001, 'sent', interval '1 day', now() - interval '1 day', pg_temp.sys(), now() - interval '1 day', pg_temp.sys()),
               (8401, pg_temp.tb(), 'PO260000001', pg_temp.id('00000000b101'), 1101, 3101, 'draft', interval '3 days', NULL::timestamptz, NULL::uuid, NULL::timestamptz, NULL::uuid)) p(n, t, no, b, s, sup, st, age, aa, ab, sa, sb);
SELECT pg_temp.ins('inventory.purchase_order_lines', jsonb_build_object('id', pg_temp.uid(l.n), 'tenant_id', l.t, 'po_id', pg_temp.uid(l.p), 'item_id', pg_temp.uid(l.i), 'pack_id', pg_temp.uid(l.pk),
    'removed_at', l.ra, 'removed_by', l.rb) || pg_temp.line(l.ln))
  FROM (VALUES (8501, pg_temp.ta(), 8301, 2001, 2201, 1, NULL::timestamptz, NULL::uuid), (8502, pg_temp.ta(), 8301, 2001, 2201, 1, now() - interval '1 day', pg_temp.sys()),
               (8503, pg_temp.ta(), 8301, 2001, 2201, 2, NULL::timestamptz, NULL::uuid), (8504, pg_temp.ta(), 8302, 2001, 2201, 1, NULL::timestamptz, NULL::uuid),
               (8601, pg_temp.tb(), 8401, 2101, 2301, 1, NULL::timestamptz, NULL::uuid)) l(n, t, p, i, pk, ln, ra, rb);
SELECT pg_temp.ins('inventory.transfers', jsonb_build_object('id', pg_temp.uid(x.n), 'tenant_id', x.t, 'transfer_no', x.no, 'from_store_id', pg_temp.uid(x.f), 'to_store_id', pg_temp.uid(x.to_s),
    'status', x.st, 'dispatched_at', x.da, 'dispatched_by', x.db))
  FROM (VALUES (8701, pg_temp.ta(), 'TR260000001', 1001, 1002, 'draft', NULL::timestamptz, NULL::uuid), (8702, pg_temp.ta(), 'TR260000002', 1001, 1002, 'dispatched', now() - interval '1 day', pg_temp.sys()),
               (8801, pg_temp.tb(), 'TR260000001', 1101, 1102, 'draft', NULL::timestamptz, NULL::uuid)) x(n, t, no, f, to_s, st, da, db);
SELECT pg_temp.ins('inventory.transfer_lines', jsonb_build_object('id', pg_temp.uid(l.n), 'tenant_id', l.t, 'transfer_id', pg_temp.uid(l.tr), 'line_no', l.ln, 'item_id', pg_temp.uid(l.i),
    'lot_id', pg_temp.uid(l.lot), 'qty_base', 5, 'removed_at', l.ra, 'removed_by', l.rb))
  FROM (VALUES (8711, pg_temp.ta(), 8701, 1, 2001, 4001, NULL::timestamptz, NULL::uuid), (8712, pg_temp.ta(), 8701, 1, 2001, 4001, now() - interval '1 day', pg_temp.sys()),
               (8713, pg_temp.ta(), 8701, 2, 2002, 4003, NULL::timestamptz, NULL::uuid), (8811, pg_temp.tb(), 8801, 1, 2101, 4101, NULL::timestamptz, NULL::uuid)) l(n, t, tr, ln, i, lot, ra, rb);

-- ---------------------------------------------------------------- stock counts, containers, bindings
SELECT pg_temp.ins('inventory.stock_counts', jsonb_build_object('id', pg_temp.uid(c.n), 'tenant_id', c.t, 'count_no', c.no, 'store_id', pg_temp.uid(c.s), 'status', c.st, 'snapshot_at', now() - interval '1 hour',
    'posted_at', c.pa, 'posted_by', c.pb, 'cancelled_at', c.ca, 'cancelled_by', c.cb))
  FROM (VALUES (8901, pg_temp.ta(), 'SC2600001', 1001, 'open', NULL::timestamptz, NULL::uuid, NULL::timestamptz, NULL::uuid),
               (8902, pg_temp.ta(), 'SC2600002', 1002, 'posted', now() - interval '1 day', pg_temp.sys(), NULL::timestamptz, NULL::uuid),
               (8903, pg_temp.ta(), 'SC2600003', 1001, 'cancelled', NULL::timestamptz, NULL::uuid, now() - interval '2 days', pg_temp.sys()),
               (8911, pg_temp.tb(), 'SC2600001', 1101, 'open', NULL::timestamptz, NULL::uuid, NULL::timestamptz, NULL::uuid)) c(n, t, no, s, st, pa, pb, ca, cb);
SELECT pg_temp.ins('inventory.stock_count_lines', jsonb_build_object('id', pg_temp.uid(l.n), 'tenant_id', l.t, 'count_id', pg_temp.uid(l.c), 'item_id', pg_temp.uid(l.i), 'lot_id', l.lot, 'book_qty_snapshot', l.q))
  FROM (VALUES (8921, pg_temp.ta(), 8901, 2001, pg_temp.uid(4001), 100), (8922, pg_temp.ta(), 8901, 2003, NULL::uuid, 50), (8931, pg_temp.tb(), 8911, 2101, pg_temp.uid(4101), 7)) l(n, t, c, i, lot, q);
SELECT pg_temp.ins('inventory.opened_containers', jsonb_build_object('id', pg_temp.uid(c.n), 'tenant_id', c.t, 'store_id', pg_temp.uid(c.s), 'item_id', pg_temp.uid(c.i), 'lot_id', c.lot, 'instrument_id', c.ins,
    'opened_at', now() - c.age, 'opened_by', pg_temp.sys(), 'open_expiry_at', c.oe, 'status', c.st, 'finished_at', c.fa, 'finished_by', c.fb))
  FROM (VALUES (9301, pg_temp.ta(), 1001, 2002, pg_temp.uid(4003), pg_temp.uid(421), interval '2 hours', now() + interval '20 days', 'open', NULL::timestamptz, NULL::uuid),
               (9302, pg_temp.ta(), 1001, 2002, pg_temp.uid(4003), pg_temp.uid(421), interval '10 days', now() - interval '3 days', 'finished', now() - interval '3 days', pg_temp.sys()),
               (9311, pg_temp.tb(), 1101, 2101, pg_temp.uid(4101), NULL::uuid, interval '2 hours', now() + interval '20 days', 'open', NULL::timestamptz, NULL::uuid)) c(n, t, s, i, lot, ins, age, oe, st, fa, fb);
SELECT pg_temp.ins('inventory.instrument_bindings', jsonb_build_object('id', pg_temp.uid(b.n), 'tenant_id', b.t, 'instrument_id', pg_temp.uid(b.i), 'store_id', pg_temp.uid(b.s), 'is_active', b.a))
  FROM (VALUES (9401, pg_temp.ta(), 421, 1001, true), (9402, pg_temp.ta(), 422, 1002, false), (9411, pg_temp.tb(), 431, 1101, true)) b(n, t, i, s, a);

-- ---------------------------------------------------------------- alerts, settings, counters, projections
SELECT pg_temp.ins('inventory.alerts', jsonb_build_object('id', pg_temp.uid(a.n), 'tenant_id', a.t, 'alert_kind', a.k, 'store_id', a.s, 'item_id', a.i, 'dedupe_key', a.dk, 'status', a.st,
    'first_raised_at', now() - a.age, 'last_raised_at', now() - a.age, 'resolved_at', a.ra, 'expires_at', a.ex))
  FROM (VALUES (9501, pg_temp.ta(), 'below_reorder', pg_temp.uid(1001), pg_temp.uid(2001), 'below:2001:1001', 'open', interval '3 hours', NULL::timestamptz, NULL::timestamptz),
               (9502, pg_temp.ta(), 'expiry_soon', pg_temp.uid(1001), pg_temp.uid(2001), 'expiry:4001', 'acknowledged', interval '2 hours', NULL::timestamptz, NULL::timestamptz),
               (9503, pg_temp.ta(), 'reconciliation_gap', NULL::uuid, NULL::uuid, 'gap:421:old', 'resolved', interval '400 days', now() - interval '366 days', now() - interval '1 day'),
               (9511, pg_temp.tb(), 'below_reorder', pg_temp.uid(1101), pg_temp.uid(2101), 'below:2001:1001', 'open', interval '3 hours', NULL::timestamptz, NULL::timestamptz)) a(n, t, k, s, i, dk, st, age, ra, ex);
SELECT pg_temp.ins('inventory.settings', jsonb_build_object('id', pg_temp.uid(9601), 'tenant_id', pg_temp.ta()));
SELECT pg_temp.ins('inventory.number_counters', jsonb_build_object('tenant_id', pg_temp.ta(), 'series', 'po', 'period_key', 'yy:26', 'next_value', 5));
SELECT pg_temp.ins('inventory.consumption_daily', jsonb_build_object('id', pg_temp.uid(d.n), 'tenant_id', d.t, 'business_date', current_date - 1, 'store_id', pg_temp.uid(d.s), 'item_id', pg_temp.uid(d.i),
    'movement_kind', 'consume_test', 'instrument_id', d.ins, 'attributed_test_id', d.te, 'qty_consumed', 5, 'value_consumed_paisa', 2500, 'movements', 1))
  FROM (VALUES (9701, pg_temp.ta(), 1001, 2001, pg_temp.uid(421), pg_temp.uid(7001)), (9702, pg_temp.ta(), 1001, 2001, NULL::uuid, NULL::uuid), (9711, pg_temp.tb(), 1101, 2101, NULL::uuid, NULL::uuid)) d(n, t, s, i, ins, te);
SELECT pg_temp.ins('inventory.test_counts_daily', jsonb_build_object('id', pg_temp.uid(d.n), 'tenant_id', d.t, 'business_date', current_date - 1, 'instrument_id', d.ins, 'test_id', d.te, 'tests_counted', 12))
  FROM (VALUES (9721, pg_temp.ta(), pg_temp.uid(421), pg_temp.uid(7001)), (9722, pg_temp.ta(), NULL::uuid, pg_temp.uid(7001)), (9731, pg_temp.tb(), pg_temp.uid(431), pg_temp.uid(7101))) d(n, t, ins, te);
SELECT pg_temp.ins('inventory.instrument_qc_daily', jsonb_build_object('tenant_id', q.t, 'business_date', current_date - 1, 'instrument_id', pg_temp.uid(q.i), 'qc_observations', q.n))
  FROM (VALUES (pg_temp.ta(), 421, 3), (pg_temp.ta(), 422, 1), (pg_temp.tb(), 431, 2)) q(t, i, n);

COMMIT;
