-- T0B-13.C12 behaviour suite: tenant isolation, branch scope NOT in RLS, non-staff + device actors and fail-closed no-claims, append-only ledger / documents, guard triggers (tg_doc_guard, tg_line_guard, tg_item_base_uom_lock,
-- enforce_mutable_columns), CHECK constraints + composite FKs, alerts DELETE policy + app.purge_inventory_alerts(), audit (C12 05-SCHEMA §1, §4, §5, §7, §8, §11; AC-0B-2.4, 3.1-3.7, 4.1, 4.2, 4.3, 5.1, 5.2, 5.3, 6.1-6.3).
-- The generated per-table probes (db/tests/isolation/inventory.<t>.test.sql) are the AC-0B-3.x proof for every table; this file proves what the generator cannot know (§4.3 purge, §5 guards, ledger CHECKs).
-- Synthetic data only (seeds 010: tenant A 01a1a98a-...-a001 with branch a101, tenant B ...-b001 with branch b101). One rolled-back transaction. RLS is never disabled; session_replication_role is not used:
-- fixtures are inserted by the superuser test session with every FK, CHECK and trigger live (draft parents first), every assertion runs as SET LOCAL ROLE lims_app / lims_api.
-- Run from the repo root: pg_prove -d <db> db/tests/inventory/T0B-13.C12_behaviour.test.sql   (pgTAP in schema `extensions`; migrations + seeds loaded; superuser)
-- Markers: C12 check 8 fixtures + seed, 9 tenant isolation (AC-0B-3.1/3.2/3.3/3.5), 10 branch scope is not RLS (AC-0B-3.4), 11 non-staff / device actors + no claims (AC-0B-3.6/3.7), 12 append-only + no DELETE (AC-0B-4.1/4.2/4.3),
-- 13 guard triggers + immutability (AC-0B-4.1), 14 CHECKs + composite FKs + alerts purge + audit + counters (AC-0B-3.5, 5.1/5.2/5.3, 6.1/6.2/6.3).
-- Order matters inside the transaction: read-only checks first, state-changing statements last.
BEGIN;
SET search_path = extensions, public, pg_catalog;
SELECT * FROM no_plan();

CREATE FUNCTION pg_temp.ta() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1a98a-ac40-7000-8000-00000000a001'::uuid $$;
CREATE FUNCTION pg_temp.tb() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1a98a-ac40-7000-8000-00000000b001'::uuid $$;
CREATE FUNCTION pg_temp.sys() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1b34e-1000-7eee-9d29-d7ca59a102b5'::uuid $$;
CREATE FUNCTION pg_temp.uid(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('0190c900-0000-7000-8000-' || lpad(n::text, 12, '0'))::uuid $$;
CREATE FUNCTION pg_temp.br(s text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('01a1a98a-ac40-7000-8000-00000000' || s)::uuid $$;      -- branch ids a101, a102, b101
CREATE FUNCTION pg_temp.m(s text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('01a1a98a-ac40-7000-8000-00000000' || s)::uuid $$;       -- membership ids: a500, b500
SELECT set_config('request.jwt.claims', jsonb_build_object('tenant_id', pg_temp.ta(), 'sub', pg_temp.sys(), 'actor_type', 'system')::text, true);

CREATE FUNCTION pg_temp.ins(p_tbl regclass, p_row jsonb) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE r jsonb := p_row; a text; cols text; saved text := current_setting('request.jwt.claims', true);
BEGIN
  FOREACH a IN ARRAY ARRAY['created_by', 'updated_by'] LOOP
    IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = p_tbl AND attname = a AND NOT attisdropped) AND NOT (r ? a) THEN r := r || jsonb_build_object(a, pg_temp.sys()); END IF;
  END LOOP;
  SELECT string_agg(quote_ident(k), ',') INTO cols FROM jsonb_object_keys(r) k;
  -- LD-230 (2): audit_log__insert__owner_only needs tenant_id = the claims tenant; write each row under its own tenant (as db/seeds/010 does)
  IF r ? 'tenant_id' THEN
    PERFORM set_config('request.jwt.claims', jsonb_build_object('tenant_id', r ->> 'tenant_id', 'sub', pg_temp.sys(), 'actor_type', 'system')::text, true);
  END IF;
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
CREATE FUNCTION pg_temp.cl(p_tenant uuid, p_type text DEFAULT 'system', p_mem uuid DEFAULT NULL) RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('actor_type', p_type, 'tenant_id', p_tenant, 'sub', pg_temp.sys()) || CASE WHEN p_mem IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('membership_id', p_mem) END $$;
CREATE FUNCTION pg_temp.sa(p_sql text, p_mode text DEFAULT 'w') RETURNS text LANGUAGE sql AS $$ SELECT pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta()), p_sql, p_mode) $$;                  -- tenant A system actor
CREATE FUNCTION pg_temp.sb(p_sql text, p_mode text DEFAULT 'w') RETURNS text LANGUAGE sql AS $$ SELECT pg_temp.x('lims_app', pg_temp.cl(pg_temp.tb()), p_sql, p_mode) $$;
CREATE FUNCTION pg_temp.ua(p_sql text, p_mode text DEFAULT 'w') RETURNS text LANGUAGE sql AS $$ SELECT pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), 'user', pg_temp.m('a500')), p_sql, p_mode) $$;   -- tenant A staff user
CREATE FUNCTION pg_temp.q(u uuid) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT quote_literal(u::text) $$;
CREATE TEMP TABLE tt(q) AS VALUES
  ('inventory.cs_reasons'),('inventory.cs_tax_codes'),('inventory.settings'),('inventory.number_counters'),('inventory.items'),('inventory.item_packs'),('inventory.item_barcodes'),('inventory.stores'),('inventory.store_item_settings'),
  ('inventory.suppliers'),('inventory.supplier_items'),('inventory.lots'),('inventory.stock_balances'),('inventory.stock_movements'),('inventory.purchase_orders'),('inventory.purchase_order_lines'),('inventory.goods_receipts'),
  ('inventory.goods_receipt_lines'),('inventory.transfers'),('inventory.transfer_lines'),('inventory.stock_documents'),('inventory.stock_document_lines'),('inventory.stock_counts'),('inventory.stock_count_lines'),
  ('inventory.opened_containers'),('inventory.instrument_bindings'),('inventory.consumption_rules'),('inventory.consumption_facts'),('inventory.consumption_daily'),('inventory.test_counts_daily'),('inventory.instrument_qc_daily'),('inventory.alerts');
CREATE TEMP TABLE ta3(q) AS VALUES ('inventory.stock_movements'),('inventory.stock_documents'),('inventory.stock_document_lines');

-- ===================================================================================================================================== fixtures (superuser; FKs, CHECKs and triggers all live)
-- C12 check 8: tenant A: stores 901 (branch a101), 902 (branch a102); tenant B: store 903 (branch b101); items 911 (pack + balance + lot: uom locked), 912 (free), B item 913; PO drafts; ledger; alerts; counters
SELECT pg_temp.ins('inventory.stores', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', r.t, 'branch_id', r.b, 'store_code', r.c, 'name', 'Synthetic store', 'store_kind', 'main'))
  FROM (VALUES (901, pg_temp.ta(), pg_temp.br('a101'), 'A-MAIN'), (902, pg_temp.ta(), pg_temp.br('a102'), 'A-EAST'), (903, pg_temp.tb(), pg_temp.br('b101'), 'B-MAIN')) r(n, t, b, c);
SELECT pg_temp.ins('inventory.items', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', r.t, 'item_code', r.c, 'name', 'Synthetic item', 'category', 'reagent', 'base_uom_code', 'test'))
  FROM (VALUES (911, pg_temp.ta(), 'GLU-R1'), (912, pg_temp.ta(), 'TIPS-200'), (913, pg_temp.tb(), 'GLU-R1')) r(n, t, c);
SELECT pg_temp.ins('inventory.item_packs', jsonb_build_object('id', pg_temp.uid(921), 'tenant_id', pg_temp.ta(), 'item_id', pg_temp.uid(911), 'pack_code', 'BOX', 'label', 'Box of 400', 'uom_code', 'box', 'qty_in_base', 400));
SELECT pg_temp.ins('inventory.lots', jsonb_build_object('id', pg_temp.uid(931), 'tenant_id', pg_temp.ta(), 'item_id', pg_temp.uid(911), 'lot_no', 'L-0001', 'expiry_on', current_date + 200));
SELECT pg_temp.ins('inventory.lots', jsonb_build_object('id', pg_temp.uid(932), 'tenant_id', pg_temp.ta(), 'item_id', pg_temp.uid(912), 'lot_no', 'L-0002'));
SELECT pg_temp.ins('inventory.stock_balances', jsonb_build_object('id', pg_temp.uid(941), 'tenant_id', pg_temp.ta(), 'store_id', pg_temp.uid(901), 'item_id', pg_temp.uid(911), 'lot_id', pg_temp.uid(931), 'qty_base', 5, 'value_paisa', 500, 'last_movement_at', now()));
SELECT pg_temp.ins('inventory.suppliers', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', r.t, 'supplier_code', 'SUP-01', 'name', 'Synthetic supplier')) FROM (VALUES (951, pg_temp.ta()), (952, pg_temp.tb())) r(n, t);
SELECT pg_temp.ins('inventory.settings', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', r.t)) FROM (VALUES (961, pg_temp.ta()), (962, pg_temp.tb())) r(n, t);
SELECT pg_temp.ins('inventory.number_counters', jsonb_build_object('tenant_id', r.t, 'series', 'po', 'period_key', '26', 'next_value', 3)) FROM (VALUES (pg_temp.ta()), (pg_temp.tb())) r(t);
SELECT pg_temp.ins('inventory.instrument_qc_daily', jsonb_build_object('tenant_id', r.t, 'business_date', current_date, 'instrument_id', pg_temp.uid(8800), 'qc_observations', 2)) FROM (VALUES (pg_temp.ta()), (pg_temp.tb())) r(t);
SELECT pg_temp.ins('inventory.purchase_orders', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', r.t, 'po_no', r.p, 'branch_id', r.b, 'store_id', pg_temp.uid(r.s), 'supplier_id', pg_temp.uid(r.sp)))
  FROM (VALUES (971, pg_temp.ta(), 'PO26000001', pg_temp.br('a101'), 901, 951), (972, pg_temp.ta(), 'PO26000002', pg_temp.br('a101'), 901, 951), (973, pg_temp.ta(), 'PO26000003', pg_temp.br('a101'), 901, 951),
               (974, pg_temp.tb(), 'PO26000001', pg_temp.br('b101'), 903, 952)) r(n, t, p, b, s, sp);
SELECT pg_temp.ins('inventory.purchase_order_lines', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', pg_temp.ta(), 'po_id', pg_temp.uid(r.po), 'line_no', 1, 'item_id', pg_temp.uid(911), 'pack_id', pg_temp.uid(921), 'qty_packs', 1,
    'qty_in_base_snapshot', 400, 'qty_base', 400, 'unit_price_paisa', 100, 'tax_rate_bp', 0, 'net_paisa', 100, 'vat_paisa', 0, 'line_total_paisa', 100)) FROM (VALUES (981, 971), (982, 972), (983, 973)) r(n, po);
SELECT pg_temp.ins('inventory.stock_movements', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', r.t, 'business_date', current_date, 'occurred_at', now(), 'store_id', pg_temp.uid(r.s), 'item_id', pg_temp.uid(r.i),
    'movement_kind', 'receive', 'qty_base', 5, 'value_paisa', 500, 'value_basis', 'receipt', 'doc_type', 'goods_receipt', 'doc_id', pg_temp.uid(7000 + r.n), 'balance_qty_after', 5)) FROM (VALUES (991, pg_temp.ta(), 901, 911), (992, pg_temp.tb(), 903, 913)) r(n, t, s, i);
SELECT pg_temp.ins('inventory.alerts', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', r.t, 'alert_kind', 'below_reorder', 'dedupe_key', r.k, 'first_raised_at', now(), 'last_raised_at', now()) || r.x)
  FROM (VALUES (1001, pg_temp.ta(), 'open-1', '{}'::jsonb),
               (1002, pg_temp.ta(), 'exp-1', jsonb_build_object('status', 'resolved', 'resolved_at', now() - interval '400 days', 'expires_at', now() - interval '35 days')),
               (1003, pg_temp.ta(), 'exp-2', jsonb_build_object('status', 'resolved', 'resolved_at', now() - interval '400 days', 'expires_at', now() - interval '35 days')),
               (1004, pg_temp.ta(), 'exp-3', jsonb_build_object('status', 'resolved', 'resolved_at', now() - interval '400 days', 'expires_at', now() - interval '35 days')),
               (1005, pg_temp.ta(), 'fresh-1', jsonb_build_object('status', 'resolved', 'resolved_at', now(), 'expires_at', now() + interval '365 days')),
               (1006, pg_temp.tb(), 'exp-b1', jsonb_build_object('status', 'resolved', 'resolved_at', now() - interval '400 days', 'expires_at', now() - interval '35 days'))) r(n, t, k, x);

SELECT is((SELECT count(*)::int FROM inventory.g_cs_uom), 19, 'C12 check 8: 19 global units seeded (§6.1)');
SELECT is((SELECT count(*)::int FROM inventory.g_cs_reasons), 50, 'C12 check 8: 50 global reasons seeded (§6.2)');
SELECT is((SELECT count(*)::int FROM inventory.items), 3, 'C12 check 8: 3 item fixtures (superuser sees all tenants)');
SELECT is((SELECT count(*)::int FROM inventory.alerts), 6, 'C12 check 8: 6 alert fixtures');

-- ===================================================================================================================================== read-only checks first
-- C12 check 9: tenant isolation (AC-0B-3.1 / 3.2 / 3.3 / 3.5)
SELECT is(pg_temp.sa('SELECT 1 FROM ' || q || ' WHERE tenant_id = ' || pg_temp.q(pg_temp.tb()), 'n'), 'n=0', 'C12 check 9 / AC-0B-3.1: tenant A system actor sees 0 tenant B rows of ' || q) FROM tt;
SELECT is(pg_temp.sb('SELECT 1 FROM ' || q || ' WHERE tenant_id = ' || pg_temp.q(pg_temp.ta()), 'n'), 'n=0', 'C12 check 9 / AC-0B-3.1: tenant B system actor sees 0 tenant A rows of ' || q) FROM tt;
SELECT is(pg_temp.sa('SELECT 1 FROM inventory.items', 'n'), 'n=2', 'C12 check 9: tenant A sees its 2 items');
SELECT is(pg_temp.sa('SELECT 1 FROM inventory.stock_movements', 'n'), 'n=1', 'C12 check 9: tenant A sees its 1 ledger row');
SELECT is(pg_temp.sa('UPDATE inventory.items SET name = ''Hijack'' WHERE id = ' || pg_temp.q(pg_temp.uid(913))), 'n=0', 'C12 check 9 / AC-0B-3.2: tenant A cannot UPDATE a tenant B item (0 rows)');
SELECT matches(pg_temp.sa('INSERT INTO inventory.suppliers (id, tenant_id, supplier_code, name, created_by, updated_by) VALUES (' || pg_temp.q(pg_temp.uid(9101)) || ', ' || pg_temp.q(pg_temp.tb()) || ', ''X-1'', ''X'', ' || pg_temp.q(pg_temp.sys()) || ', ' || pg_temp.q(pg_temp.sys()) || ')'),
  '^E42501\|', 'C12 check 9 / AC-0B-3.3: tenant A cannot INSERT a row for tenant B (WITH CHECK)');
SELECT matches(pg_temp.sa('UPDATE inventory.items SET tenant_id = ' || pg_temp.q(pg_temp.tb()) || ' WHERE id = ' || pg_temp.q(pg_temp.uid(912))), '^E', 'C12 check 9 / AC-0B-3.3: a row cannot be moved to another tenant');
SELECT is(pg_temp.sa('SELECT count(*) FROM inventory.alerts WHERE tenant_id = ' || pg_temp.q(pg_temp.tb()), 's'), '0', 'C12 check 9: the alert list never leaks tenant B');

-- C12 check 10: branch scope is application-enforced, NOT RLS (§1 DECISION D-SCOPE; AC-0B-3.4): a tenant staff user sees the stores of every branch of its own tenant, never another tenant's
SELECT is(pg_temp.ua('SELECT 1 FROM inventory.stores', 'n'), 'n=2', 'C12 check 10 / AC-0B-3.4: a staff user sees both branches'' stores of its tenant (no centre / branch predicate in RLS)');
SELECT is(pg_temp.ua('SELECT 1 FROM inventory.stores WHERE branch_id = ' || pg_temp.q(pg_temp.br('a102')), 'n'), 'n=1', 'C12 check 10: the east-branch store is visible to the tenant staff user');
SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), 'user', pg_temp.m('a500')) || '{"centre_ids": []}'::jsonb, 'SELECT 1 FROM inventory.stores', 'n'), 'n=2', 'C12 check 10: centre claims do not narrow inventory rows');

-- C12 check 11: non-staff actors (AC-0B-3.6), device actors and fail-closed without claims (AC-0B-3.7)
SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), k.t, pg_temp.m('a500')), 'SELECT 1 FROM ' || tt.q, 'n'), 'n=0', 'C12 check 11 / AC-0B-3.6: ' || k.t || ' actor sees 0 rows of ' || tt.q) FROM tt CROSS JOIN (VALUES ('partner'),('portal'),('patient')) k(t);
SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), 'device', NULL), 'SELECT 1 FROM inventory.items', 'n'), 'n=2', 'C12 check 11 / §4.1: a device actor (staff, system or device) sees the tenant''s rows');
SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), 'portal', pg_temp.m('a500')), 'UPDATE inventory.settings SET backdate_max_days = 5'), 'n=0', 'C12 check 11 / AC-0B-3.6: a portal actor updates 0 settings');
SELECT matches(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), 'partner', pg_temp.m('a500')), 'INSERT INTO inventory.suppliers (id, tenant_id, supplier_code, name, created_by, updated_by) VALUES (' || pg_temp.q(pg_temp.uid(9102)) || ', ' || pg_temp.q(pg_temp.ta()) || ', ''X-2'', ''X'', '
  || pg_temp.q(pg_temp.sys()) || ', ' || pg_temp.q(pg_temp.sys()) || ')'), '^E42501\|', 'C12 check 11 / AC-0B-3.6: a partner actor cannot INSERT');
SELECT is(pg_temp.x('lims_api', NULL, 'SELECT 1 FROM ' || q, 'n'), 'n=0', 'C12 check 11 / AC-0B-3.7: no claims -> lims_api sees 0 rows of ' || q) FROM tt;
SELECT is(pg_temp.x('lims_api', '{}'::jsonb, 'SELECT 1 FROM ' || q, 'n'), 'n=0', 'C12 check 11 / AC-0B-3.7: empty claims -> 0 rows of ' || q) FROM tt;
SELECT is(pg_temp.x('lims_api', NULL, 'SELECT 1 FROM inventory.g_cs_uom', 'n'), 'n=19', 'C12 check 11: the global coded sets stay readable without claims (no tenant data)');
SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), 'partner', NULL), 'SELECT app.purge_inventory_alerts()', 's'), '0', 'C12 check 11 / D-72: a non-staff actor purges nothing');

-- C12 check 12: append-only ledger / documents and no DELETE (AC-0B-4.1 / 4.2 / 4.3; §4.2, §4.4)
SELECT matches(pg_temp.sa('UPDATE ' || q || ' SET created_by = created_by'), '^E42501\|', 'C12 check 12 / AC-0B-4.1 / 4.3: even the system actor has no UPDATE grant on ' || q) FROM ta3;
SELECT matches(pg_temp.sa('DELETE FROM ' || tt.q), '^E42501\|', 'C12 check 12 / AC-0B-4.2: no DELETE grant on ' || tt.q) FROM tt WHERE q <> 'inventory.alerts';
SELECT matches(pg_temp.sa('DELETE FROM inventory.purchase_order_lines'), '^E42501\|', 'C12 check 12 / D-71: draft lines are never deleted (soft removal only)');
SELECT matches(pg_temp.sa('DELETE FROM inventory.number_counters'), '^E42501\|', 'C12 check 12 / P-18: the counter is updatable but never deleted');
SELECT matches(pg_temp.sa('INSERT INTO inventory.g_cs_uom (id, code, display, uom_kind) VALUES (' || pg_temp.q(pg_temp.uid(9103)) || ', ''x_test'', ''X'', ''count'')'), '^E42501\|', 'C12 check 12: the global coded set is not writable by lims_app');
SELECT matches(pg_temp.sa('UPDATE inventory.g_cs_reasons SET is_active = false'), '^E42501\|', 'C12 check 12: the global coded set is not updatable by lims_app');
SELECT matches(pg_temp.sa('DELETE FROM inventory.g_cs_tax_codes'), '^E42501\|', 'C12 check 12: the global coded set is not deletable by lims_app');
SELECT matches(pg_temp.sa('TRUNCATE inventory.stock_movements'), '^E42501\|', 'C12 check 12: no TRUNCATE');
SELECT is(pg_temp.sa('INSERT INTO inventory.stock_movements (id, tenant_id, business_date, occurred_at, store_id, item_id, movement_kind, qty_base, value_paisa, value_basis, doc_type, doc_id, balance_qty_after, created_by) VALUES ('
  || pg_temp.q(pg_temp.uid(9201)) || ', ' || pg_temp.q(pg_temp.ta()) || ', current_date, now(), ' || pg_temp.q(pg_temp.uid(901)) || ', ' || pg_temp.q(pg_temp.uid(911)) || ', ''issue'', -2, -200, ''average'', ''stock_document'', ' || pg_temp.q(pg_temp.uid(9202)) || ', 3, ' || pg_temp.q(pg_temp.sys()) || ')'),
  'n=1', 'C12 check 12 / AC-0B-4.1: the ledger accepts INSERT (append) for the tenant''s own system actor');

-- C12 check 13: guard triggers + immutability (AC-0B-4.1; §5, §7). State-changing, so after the read-only checks.
SELECT is(pg_temp.sa('UPDATE inventory.item_packs SET label = ''Box (400 tests)'' WHERE id = ' || pg_temp.q(pg_temp.uid(921))), 'n=1', 'C12 check 13 / §5: item_packs.label is a mutable column');
SELECT matches(pg_temp.sa('UPDATE inventory.item_packs SET qty_in_base = 1 WHERE id = ' || pg_temp.q(pg_temp.uid(921))), '^EP0001\|', 'C12 check 13 / §5: item_packs.qty_in_base is frozen (immutable_row)');
SELECT is(pg_temp.sa('UPDATE inventory.lots SET expiry_on = current_date + 300 WHERE id = ' || pg_temp.q(pg_temp.uid(931))), 'n=1', 'C12 check 13 / §5: lots.expiry_on is mutable');
SELECT matches(pg_temp.sa('UPDATE inventory.lots SET lot_no = ''L-9999'' WHERE id = ' || pg_temp.q(pg_temp.uid(931))), '^EP0001\|', 'C12 check 13 / §5: lots.lot_no is frozen');
SELECT is(pg_temp.sa('UPDATE inventory.stock_balances SET qty_base = 4, value_paisa = 400, last_movement_at = now() WHERE id = ' || pg_temp.q(pg_temp.uid(941))), 'n=1', 'C12 check 13 / §5: stock_balances qty / value / last_movement_at are mutable (the projection is rewritten by the ledger poster)');
SELECT matches(pg_temp.sa('UPDATE inventory.stock_balances SET store_id = ' || pg_temp.q(pg_temp.uid(902)) || ' WHERE id = ' || pg_temp.q(pg_temp.uid(941))), '^EP0001\|', 'C12 check 13 / §5: stock_balances.store_id is frozen');
-- tg_item_base_uom_lock: item 911 has a pack, a lot balance and a ledger row -> locked; item 912 has none of them -> free
SELECT matches(pg_temp.sa('UPDATE inventory.items SET base_uom_code = ''piece'' WHERE id = ' || pg_temp.q(pg_temp.uid(911))), '^EP0001\|', 'C12 check 13 / §5: the base unit of an item with packs / rules / balances cannot change (immutable_row)');
SELECT is(pg_temp.sa('UPDATE inventory.items SET base_uom_code = ''piece'' WHERE id = ' || pg_temp.q(pg_temp.uid(912))), 'n=1', 'C12 check 13 / §5: the base unit of a never-used item can change');
SELECT is(pg_temp.sa('UPDATE inventory.items SET name = ''Renamed'' WHERE id = ' || pg_temp.q(pg_temp.uid(911))), 'n=1', 'C12 check 13: other item columns are not affected by the uom lock');
-- tg_doc_guard: allowed pairs (§7) and invalid ones
SELECT matches(pg_temp.sa('UPDATE inventory.purchase_orders SET status = ''received'', approved_at = now(), approved_by = ' || pg_temp.q(pg_temp.sys()) || ' WHERE id = ' || pg_temp.q(pg_temp.uid(972))), '^EP0001\|invalid_transition', 'C12 check 13 / §7: draft -> received is not an allowed purchase order pair (invalid_transition)');
SELECT matches(pg_temp.sa('UPDATE inventory.purchase_orders SET status = ''closed'', approved_at = now(), closed_at = now() WHERE id = ' || pg_temp.q(pg_temp.uid(972))), '^EP0001\|invalid_transition', 'C12 check 13 / §7: draft -> closed is not allowed');
SELECT is(pg_temp.sa('UPDATE inventory.purchase_orders SET notes = ''edited in draft'' WHERE id = ' || pg_temp.q(pg_temp.uid(972))), 'n=1', 'C12 check 13 / §5: a draft purchase order is editable');
SELECT is(pg_temp.sa('UPDATE inventory.purchase_orders SET status = ''approved'', approved_at = now(), approved_by = ' || pg_temp.q(pg_temp.sys()) || ' WHERE id = ' || pg_temp.q(pg_temp.uid(971))), 'n=1', 'C12 check 13 / §7: draft -> approved is allowed');
SELECT matches(pg_temp.sa('UPDATE inventory.purchase_orders SET notes = ''edited after approval'' WHERE id = ' || pg_temp.q(pg_temp.uid(971))), '^EP0001\|immutable_row', 'C12 check 13 / §5: an approved purchase order is frozen except its lifecycle columns (immutable_row)');
SELECT matches(pg_temp.sa('UPDATE inventory.purchase_orders SET status = ''draft'' WHERE id = ' || pg_temp.q(pg_temp.uid(971))), '^EP0001\|invalid_transition', 'C12 check 13 / §7: approved -> draft is not allowed');
SELECT is(pg_temp.sa('UPDATE inventory.purchase_orders SET status = ''sent'', sent_at = now(), sent_by = ' || pg_temp.q(pg_temp.sys()) || ', sent_channel = ''email'' WHERE id = ' || pg_temp.q(pg_temp.uid(971))), 'n=1', 'C12 check 13 / §7: approved -> sent is allowed (lifecycle columns change)');
SELECT is(pg_temp.sa('UPDATE inventory.purchase_orders SET status = ''partially_received'' WHERE id = ' || pg_temp.q(pg_temp.uid(971))), 'n=1', 'C12 check 13 / §7: sent -> partially_received is allowed');
SELECT is(pg_temp.sa('UPDATE inventory.purchase_orders SET status = ''partially_received'', version = version + 1 WHERE id = ' || pg_temp.q(pg_temp.uid(971))), 'n=1', 'C12 check 13 / §7: partially_received -> partially_received (receipt counter) is allowed');
SELECT matches(pg_temp.sa('UPDATE inventory.purchase_orders SET status = ''cancelled'', cancelled_at = now(), cancel_reason_code = ''duplicate'' WHERE id = ' || pg_temp.q(pg_temp.uid(971))), '^EP0001\|invalid_transition', 'C12 check 13 / §7: partially_received -> cancelled is not allowed');
SELECT is(pg_temp.sa('UPDATE inventory.purchase_orders SET status = ''closed'', closed_at = now(), closed_by = ' || pg_temp.q(pg_temp.uid(1)) || ', close_reason_code = ''short_supply'' WHERE id = ' || pg_temp.q(pg_temp.uid(971))), 'n=1', 'C12 check 13 / §7: partially_received -> closed is allowed');
SELECT matches(pg_temp.sa('UPDATE inventory.purchase_orders SET status = ''received'' WHERE id = ' || pg_temp.q(pg_temp.uid(971))), '^EP0001\|', 'C12 check 13 / §7: a closed purchase order has no way out');
-- tg_line_guard: soft removal while the parent is draft (D-71); frozen once the parent left draft
SELECT is(pg_temp.sa('UPDATE inventory.purchase_order_lines SET removed_at = now(), removed_by = ' || pg_temp.q(pg_temp.sys()) || ' WHERE id = ' || pg_temp.q(pg_temp.uid(983))), 'n=1', 'C12 check 13 / D-71: a line of a draft purchase order can be soft-removed');
SELECT matches(pg_temp.sa('UPDATE inventory.purchase_order_lines SET removed_at = NULL, removed_by = NULL WHERE id = ' || pg_temp.q(pg_temp.uid(983))), '^EP0001\|', 'C12 check 13 / D-71: a removed line is never restored');
SELECT matches(pg_temp.sa('UPDATE inventory.purchase_order_lines SET qty_packs = 2, qty_base = 800, net_paisa = 200, line_total_paisa = 200 WHERE id = ' || pg_temp.q(pg_temp.uid(983))), '^EP0001\|', 'C12 check 13 / D-71: a removed line is otherwise frozen');
SELECT is(pg_temp.sa('UPDATE inventory.purchase_order_lines SET unit_price_paisa = 120, net_paisa = 120, line_total_paisa = 120 WHERE id = ' || pg_temp.q(pg_temp.uid(982))), 'n=1', 'C12 check 13: a line of a draft purchase order is editable');
SELECT matches(pg_temp.sa('UPDATE inventory.purchase_order_lines SET unit_price_paisa = 130, net_paisa = 130, line_total_paisa = 130 WHERE id = ' || pg_temp.q(pg_temp.uid(981))), '^EP0001\|', 'C12 check 13 / §5: a line of a closed purchase order is frozen (parent not editable)');
SELECT matches(pg_temp.sa('UPDATE inventory.purchase_order_lines SET removed_at = now(), removed_by = ' || pg_temp.q(pg_temp.sys()) || ' WHERE id = ' || pg_temp.q(pg_temp.uid(981))), '^EP0001\|', 'C12 check 13 / D-71: removal is allowed only while the parent is draft');
SELECT matches(pg_temp.sa('INSERT INTO inventory.purchase_order_lines (id, tenant_id, po_id, line_no, item_id, pack_id, qty_packs, qty_in_base_snapshot, qty_base, unit_price_paisa, tax_rate_bp, net_paisa, vat_paisa, line_total_paisa, created_by, updated_by) VALUES ('
  || pg_temp.q(pg_temp.uid(9301)) || ', ' || pg_temp.q(pg_temp.ta()) || ', ' || pg_temp.q(pg_temp.uid(971)) || ', 2, ' || pg_temp.q(pg_temp.uid(911)) || ', ' || pg_temp.q(pg_temp.uid(921)) || ', 1, 400, 400, 100, 0, 100, 0, 100, ' || pg_temp.q(pg_temp.sys()) || ', ' || pg_temp.q(pg_temp.sys()) || ')'),
  '^EP0001\|', 'C12 check 13 / §5: a line cannot be added to a purchase order that left draft');

-- C12 check 14: CHECK constraints, composite FKs, alerts purge, audit, counters (AC-0B-3.5, 5.1, 5.2, 5.3, 6.1, 6.2, 6.3)
CREATE FUNCTION pg_temp.mv(p_id int, p_kind text, p_qty numeric, p_val bigint, p_extra text DEFAULT '', p_item int DEFAULT 911, p_lot text DEFAULT 'NULL') RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.sa('INSERT INTO inventory.stock_movements (id, tenant_id, business_date, occurred_at, store_id, item_id, lot_id, movement_kind, qty_base, value_paisa, value_basis, doc_type, doc_id, balance_qty_after, created_by' || p_extra || ') VALUES ('
    || pg_temp.q(pg_temp.uid(p_id)) || ', ' || pg_temp.q(pg_temp.ta()) || ', current_date, now(), ' || pg_temp.q(pg_temp.uid(901)) || ', ' || pg_temp.q(pg_temp.uid(p_item)) || ', ' || p_lot || ', ''' || p_kind || ''', ' || p_qty || ', ' || p_val
    || ', ''average'', ''stock_document'', ' || pg_temp.q(pg_temp.uid(p_id + 1)) || ', 1, ' || pg_temp.q(pg_temp.sys()) || ')') $$;
SELECT matches(pg_temp.mv(9401, 'receive', -3, 300), '^E23514\|', 'C12 check 14 / §6.4: a receive with a negative quantity violates stock_movements__sign__ck');
SELECT matches(pg_temp.mv(9403, 'issue', 3, -300), '^E23514\|', 'C12 check 14 / §6.4: an issue with a positive quantity violates the sign CHECK');
SELECT matches(pg_temp.mv(9405, 'issue', 0, 0), '^E23514\|', 'C12 check 14 / §6.4: a zero quantity violates the sign CHECK');
SELECT matches(pg_temp.mv(9407, 'issue', -1, 100), '^E23514\|', 'C12 check 14 / §6.4: an issue with a positive value violates the sign CHECK (value_paisa <= 0)');
SELECT matches(pg_temp.mv(9409, 'consume_reversal', 1, 100), '^E23514\|', 'C12 check 14: a consume_reversal without reverses_movement_id violates stock_movements__doc__ck');
SELECT matches(pg_temp.mv(9411, 'sell', -1, -100), '^E23514\|', 'C12 check 14: an unknown movement_kind violates the CHECK');
SELECT matches(pg_temp.mv(9413, 'issue', -1, -100, '', 912, pg_temp.q(pg_temp.uid(931))), '^E23503\|', 'C12 check 14 / AC-0B-3.5: the composite lot FK (tenant_id, lot_id, item_id) refuses a lot of another item');
SELECT matches(pg_temp.sa('INSERT INTO inventory.purchase_orders (id, tenant_id, po_no, branch_id, store_id, supplier_id, created_by, updated_by) VALUES (' || pg_temp.q(pg_temp.uid(9501)) || ', ' || pg_temp.q(pg_temp.ta()) || ', ''PO26000099'', '
  || pg_temp.q(pg_temp.br('a101')) || ', ' || pg_temp.q(pg_temp.uid(903)) || ', ' || pg_temp.q(pg_temp.uid(951)) || ', ' || pg_temp.q(pg_temp.sys()) || ', ' || pg_temp.q(pg_temp.sys()) || ')'), '^E23503\|', 'C12 check 14 / AC-0B-3.5: a tenant A purchase order cannot point at a tenant B store (composite FK)');
SELECT matches(pg_temp.sa('INSERT INTO inventory.purchase_orders (id, tenant_id, po_no, branch_id, store_id, supplier_id, created_by, updated_by) VALUES (' || pg_temp.q(pg_temp.uid(9502)) || ', ' || pg_temp.q(pg_temp.ta()) || ', ''PO26000098'', '
  || pg_temp.q(pg_temp.br('a102')) || ', ' || pg_temp.q(pg_temp.uid(901)) || ', ' || pg_temp.q(pg_temp.uid(951)) || ', ' || pg_temp.q(pg_temp.sys()) || ', ' || pg_temp.q(pg_temp.sys()) || ')'), '^E23503\|', 'C12 check 14: the store must belong to the PO branch (FK (tenant_id, store_id, branch_id))');
SELECT matches(pg_temp.sa('INSERT INTO inventory.items (id, tenant_id, item_code, name, category, base_uom_code, created_by, updated_by) VALUES (' || pg_temp.q(pg_temp.uid(9503)) || ', ' || pg_temp.q(pg_temp.ta()) || ', ''BAD-UOM'', ''x'', ''reagent'', ''parsec'', '
  || pg_temp.q(pg_temp.sys()) || ', ' || pg_temp.q(pg_temp.sys()) || ')'), '^E23503\|', 'C12 check 14: an unknown base unit violates items__uom__fk');
SELECT matches(pg_temp.sa('INSERT INTO inventory.items (id, tenant_id, item_code, name, category, base_uom_code, requires_expiry, is_lot_tracked, created_by, updated_by) VALUES (' || pg_temp.q(pg_temp.uid(9504)) || ', ' || pg_temp.q(pg_temp.ta()) || ', ''BAD-EXP'', ''x'', ''reagent'', ''test'', true, false, '
  || pg_temp.q(pg_temp.sys()) || ', ' || pg_temp.q(pg_temp.sys()) || ')'), '^E23514\|', 'C12 check 14: requires_expiry without lot tracking violates items__expiry_requires_lot__ck');
SELECT matches(pg_temp.sa('INSERT INTO inventory.number_counters (tenant_id, series, period_key, next_value) VALUES (' || pg_temp.q(pg_temp.ta()) || ', ''invoice'', ''26'', 1)'), '^E23514\|', 'C12 check 14 / §8: number_counters.series is one of po, grn, transfer, count, doc');
SELECT matches(pg_temp.sa('INSERT INTO inventory.alerts (id, tenant_id, alert_kind, dedupe_key, first_raised_at, last_raised_at, details, created_by, updated_by) VALUES (' || pg_temp.q(pg_temp.uid(9505)) || ', ' || pg_temp.q(pg_temp.ta())
  || ', ''below_reorder'', ''big'', now(), now(), jsonb_build_object(''k'', repeat(''x'', 3000)), ' || pg_temp.q(pg_temp.sys()) || ', ' || pg_temp.q(pg_temp.sys()) || ')'), '^E23514\|', 'C12 check 14 / §2.27: alert details are capped at 2 KB (pg_column_size CHECK)');
SELECT matches(pg_temp.sa('INSERT INTO inventory.alerts (id, tenant_id, alert_kind, dedupe_key, first_raised_at, last_raised_at, created_by, updated_by) VALUES (' || pg_temp.q(pg_temp.uid(9506)) || ', ' || pg_temp.q(pg_temp.ta())
  || ', ''below_reorder'', ''open-1'', now(), now(), ' || pg_temp.q(pg_temp.sys()) || ', ' || pg_temp.q(pg_temp.sys()) || ')'), '^E23505\|', 'C12 check 14: only one open alert per dedupe key (alerts__tenant_id_dedupe__p_uq)');
-- alerts purge (§4.3, D-72, P-18(c)): system actor + expired rows + own tenant only
SELECT is(pg_temp.ua('DELETE FROM inventory.alerts WHERE expires_at < now()'), 'n=0', 'C12 check 14 / D-72: a staff USER cannot purge alerts (the DELETE policy admits the system actor only)');
SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), 'device', NULL), 'DELETE FROM inventory.alerts WHERE expires_at < now()'), 'n=0', 'C12 check 14 / D-72: a device actor cannot purge alerts');
SELECT is(pg_temp.sa('DELETE FROM inventory.alerts WHERE id = ' || pg_temp.q(pg_temp.uid(1001))), 'n=0', 'C12 check 14 / D-72: an open (not expired) alert cannot be deleted');
SELECT is(pg_temp.sa('DELETE FROM inventory.alerts WHERE id = ' || pg_temp.q(pg_temp.uid(1005))), 'n=0', 'C12 check 14 / D-72: a resolved alert inside its 365 days cannot be deleted');
SELECT is(pg_temp.sa('DELETE FROM inventory.alerts WHERE id = ' || pg_temp.q(pg_temp.uid(1006))), 'n=0', 'C12 check 14 / D-72: tenant A cannot delete tenant B''s expired alert');
SELECT is(pg_temp.ua('SELECT app.purge_inventory_alerts()', 's'), '0', 'C12 check 14 / D-72: the purge function run by a staff user deletes nothing');
SELECT is(pg_temp.sa('DELETE FROM inventory.alerts WHERE id = ' || pg_temp.q(pg_temp.uid(1002))), 'n=1', 'C12 check 14 / D-72: the system actor deletes an expired alert of its own tenant');
SELECT is(pg_temp.sb('SELECT app.purge_inventory_alerts()', 's'), '1', 'C12 check 14 / §8: the purge function returns the number of deleted rows of the caller''s tenant only (B: 1)');
SELECT is((SELECT count(*)::int FROM inventory.alerts WHERE tenant_id = pg_temp.ta() AND expires_at < now()), 2, 'C12 check 14: tenant B''s purge left tenant A''s expired alerts alone');
SELECT is(pg_temp.sa('SELECT app.purge_inventory_alerts()', 's'), '2', 'C12 check 14 / §8: the purge function deletes the remaining 2 expired alerts of tenant A');
SELECT is((SELECT count(*)::int FROM inventory.alerts WHERE tenant_id = pg_temp.ta()), 2, 'C12 check 14: the open alert and the fresh resolved alert survive the purge');
SELECT is(pg_temp.sa('UPDATE inventory.alerts SET status = ''acknowledged'', acknowledged_at = now(), acknowledged_by = ' || pg_temp.q(pg_temp.sys()) || ' WHERE id = ' || pg_temp.q(pg_temp.uid(1001))), 'n=1', 'C12 check 14: alerts are updatable (class E state)');
-- audit (AC-0B-5.1 / 5.2 / 5.3)
SELECT is((SELECT count(*)::int FROM audit.audit_log WHERE schema_name = 'inventory' AND table_name = 'item_packs' AND row_id = pg_temp.uid(921) AND tenant_id = pg_temp.ta()) >= 1, true, 'C12 check 14 / AC-0B-5.1: an audited class M update wrote an audit_log row');
SELECT is((SELECT bool_or(changed_columns @> ARRAY['label']) FROM audit.audit_log WHERE schema_name = 'inventory' AND table_name = 'item_packs' AND row_id = pg_temp.uid(921)), true, 'C12 check 14 / AC-0B-5.2: the changed column is recorded');
SELECT is((SELECT count(*)::int FROM audit.audit_log WHERE schema_name = 'inventory' AND table_name = 'purchase_orders' AND tenant_id = pg_temp.ta()) >= 1, true, 'C12 check 14 / AC-0B-5.1: purchase orders (class C) are audited');
SELECT is((SELECT count(*)::int FROM audit.audit_log WHERE schema_name = 'inventory' AND table_name IN ('stock_movements', 'stock_documents', 'stock_document_lines', 'stock_balances', 'consumption_daily', 'test_counts_daily')), 0, 'C12 check 14 / AC-0B-5.3: the ledger, documents and projections are not audited (the earlier writes left no audit row)');
-- counters (P-18(b)) and owner / order (AC-0B-6.x)
SELECT is(pg_temp.sa('UPDATE inventory.number_counters SET next_value = next_value + 1, updated_at = now() WHERE series = ''po'' AND period_key = ''26'''), 'n=1', 'C12 check 14 / P-18(b): the human-number counter is updated in place (one row per tenant, series, period)');
SELECT is(pg_temp.sa('SELECT next_value FROM inventory.number_counters WHERE series = ''po'' AND period_key = ''26''', 's'), '4', 'C12 check 14: the counter advanced from 3 to 4 and tenant B''s counter is untouched');
SELECT is((SELECT next_value::int FROM inventory.number_counters WHERE tenant_id = pg_temp.tb() AND series = 'po'), 3, 'C12 check 14: tenant B counter unchanged');
SELECT matches(pg_temp.sa('INSERT INTO inventory.number_counters (tenant_id, series, period_key, next_value) VALUES (' || pg_temp.q(pg_temp.ta()) || ', ''po'', ''26'', 1)'), '^E23505\|', 'C12 check 14: a second counter row for the same (tenant, series, period) is refused');
SELECT is(pg_temp.sa('UPDATE inventory.instrument_qc_daily SET qc_observations = qc_observations + 1 WHERE business_date = current_date'), 'n=1', 'C12 check 14 / D-74: the daily QC observation counter is updated in place');
SELECT is((SELECT count(*)::int FROM pg_class WHERE relnamespace = 'inventory'::regnamespace AND relkind = 'r' AND relname <> 'event_inbox' AND pg_get_userbyid(relowner) <> 'lims_owner'), 0, 'C12 check 14 / AC-0B-6.3: every inventory table is owned by lims_owner');
SELECT is((SELECT count(*)::int FROM pg_proc WHERE pronamespace = 'inventory'::regnamespace AND prosecdef), 0, 'C12 check 14 / AC-0B-6.1 / 6.2: no SECURITY DEFINER function in inventory; the migrations applied in order on the database under test');
SELECT is(pg_temp.sa('SELECT count(*) FROM inventory.g_cs_reasons WHERE reason_group = ''wastage''', 's'), '9', 'C12 check 14: the wastage reason group is readable by lims_app (9 codes, §6.2)');

SELECT * FROM finish();
ROLLBACK;
