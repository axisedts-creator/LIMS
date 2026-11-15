-- T0B-13.C12 (LD-202): inventory schema — C12 05-SCHEMA §8 DDL verbatim (35 tables: 3 G + 32 tenant; indexes; app.purge_inventory_alerts()),
-- C0 additions per C0 05-SCHEMA §9 rule 1 (<t>__tenant__fk / UNIQUE (tenant_id, id) where §8 omits them), the §5 INVOKER guard functions
-- and triggers, row-audit triggers (§5), the §4.1 template expanded into literal ENABLE + FORCE + policies on the 32 tenant tables,
-- the §4.3 alerts DELETE policy (+ staff guard, P-16 / gate 9 [CONV]), the §4.4 grants, and the §6.1-6.3 global seeds.
-- Policies are copied 1:1 to db/policies/inventory.sql (AC-0B-2.3). inventory.event_inbox belongs to T0B-05. Schema inventory exists
-- since T0B-01. No SECURITY DEFINER, no view (§9). Single role switch: lims_owner.
SET LOCAL ROLE lims_owner;

-- ===================== §8 DDL (verbatim) =====================
-- ===== G tables =====
CREATE TABLE inventory.g_cs_uom (
  id uuid NOT NULL, code text NOT NULL, display text NOT NULL, uom_kind text NOT NULL,
  sort_order integer NOT NULL DEFAULT 100, is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT g_cs_uom__pk PRIMARY KEY (id),
  CONSTRAINT g_cs_uom__code__uq UNIQUE (code),
  CONSTRAINT g_cs_uom__code__ck CHECK (code ~ '^[a-z][a-z0-9_]{0,31}$' AND char_length(display) BETWEEN 1 AND 32),
  CONSTRAINT g_cs_uom__kind__ck CHECK (uom_kind IN ('count','volume','mass','other'))
);
CREATE TABLE inventory.g_cs_reasons (
  id uuid NOT NULL, reason_group text NOT NULL, code text NOT NULL, display text NOT NULL,
  sort_order integer NOT NULL DEFAULT 100, system text NOT NULL DEFAULT 'lims', system_version text NOT NULL DEFAULT '1',
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT g_cs_reasons__pk PRIMARY KEY (id),
  CONSTRAINT g_cs_reasons__group_code__uq UNIQUE (reason_group, code),
  CONSTRAINT g_cs_reasons__ck CHECK (code ~ '^[a-z][a-z0-9_]{0,31}$' AND char_length(display) BETWEEN 1 AND 80
    AND reason_group IN ('wastage','adjustment','supplier_return','po_cancel','po_close','transfer_discrepancy',
                         'fact_dismiss','fact_reverse','lot_status','calibration','count_variance'))
);
CREATE TABLE inventory.g_cs_tax_codes (
  -- no rate column: rates come from C3 via CatalogPort.getTaxRate (08 R18, A2.2, CR-C12-010)
  id uuid NOT NULL, code text NOT NULL, display text NOT NULL,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT g_cs_tax_codes__pk PRIMARY KEY (id),
  CONSTRAINT g_cs_tax_codes__code__uq UNIQUE (code),
  CONSTRAINT g_cs_tax_codes__ck CHECK (code ~ '^[A-Z0-9_]{1,16}$' AND char_length(display) BETWEEN 1 AND 80)  -- C3 tax codes (08 A5.6)
);

-- ===== tenant coded sets =====
CREATE TABLE inventory.cs_reasons (
  id uuid NOT NULL, tenant_id uuid NOT NULL, reason_group text NOT NULL, code text NOT NULL, display text NOT NULL,
  sort_order integer NOT NULL DEFAULT 100, system text NOT NULL DEFAULT 'tenant', system_version text NOT NULL DEFAULT '1',
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT cs_reasons__pk PRIMARY KEY (id),
  CONSTRAINT cs_reasons__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT cs_reasons__tenant_id_group_code__uq UNIQUE (tenant_id, reason_group, code),
  CONSTRAINT cs_reasons__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT cs_reasons__ck CHECK (code ~ '^[a-z][a-z0-9_]{0,31}$' AND char_length(display) BETWEEN 1 AND 80
    AND reason_group IN ('wastage','adjustment','supplier_return','po_cancel','po_close','transfer_discrepancy',
                         'fact_dismiss','fact_reverse','lot_status','calibration','count_variance'))
);
CREATE TABLE inventory.cs_tax_codes (
  -- no rate column (08 A2.2)
  id uuid NOT NULL, tenant_id uuid NOT NULL, code text NOT NULL, display text NOT NULL,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT cs_tax_codes__pk PRIMARY KEY (id),
  CONSTRAINT cs_tax_codes__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT cs_tax_codes__tenant_id_code__uq UNIQUE (tenant_id, code),
  CONSTRAINT cs_tax_codes__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT cs_tax_codes__ck CHECK (code ~ '^[A-Z0-9_]{1,16}$' AND char_length(display) BETWEEN 1 AND 80)  -- C3 tax codes (08 A5.6)
);

-- ===== stores (needed by settings FK) =====
CREATE TABLE inventory.stores (
  id uuid NOT NULL, tenant_id uuid NOT NULL, branch_id uuid NOT NULL,
  store_code text NOT NULL, name text NOT NULL, store_kind text NOT NULL, is_default_consumption boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT stores__pk PRIMARY KEY (id),
  CONSTRAINT stores__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT stores__tenant_id_id_branch_id__uq UNIQUE (tenant_id, id, branch_id),
  CONSTRAINT stores__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT stores__branch__fk FOREIGN KEY (tenant_id, branch_id) REFERENCES core.branches (tenant_id, id),
  CONSTRAINT stores__ck CHECK (store_code ~ '^[A-Z0-9][A-Z0-9_\-]{0,15}$' AND char_length(name) BETWEEN 1 AND 120
    AND store_kind IN ('main','bench','other'))
);
CREATE UNIQUE INDEX stores__tenant_id_store_code__uq ON inventory.stores (tenant_id, store_code);
CREATE UNIQUE INDEX stores__tenant_id_branch_id_default__p_uq ON inventory.stores (tenant_id, branch_id)
  WHERE is_default_consumption AND is_active;
CREATE INDEX stores__tenant_id_branch_id__idx ON inventory.stores (tenant_id, branch_id, is_active);

CREATE TABLE inventory.settings (
  id uuid NOT NULL, tenant_id uuid NOT NULL,
  consumption_enabled_at timestamptz, vat_in_cost boolean NOT NULL DEFAULT true,
  po_self_approval_allowed boolean NOT NULL DEFAULT false, grn_without_po_allowed boolean NOT NULL DEFAULT true,
  over_receipt_tolerance_bp integer NOT NULL DEFAULT 0, expiry_alert_days integer NOT NULL DEFAULT 30,
  default_consumption_store_id uuid, count_locks_store boolean NOT NULL DEFAULT false,
  per_day_requires_activity boolean NOT NULL DEFAULT true, reconciliation_gap_alert_bp integer NOT NULL DEFAULT 200,
  backdate_max_days integer NOT NULL DEFAULT 7,
  po_no_pattern text NOT NULL DEFAULT 'PO{yy}{seq:6}', grn_no_pattern text NOT NULL DEFAULT 'GR{yy}{seq:6}',
  transfer_no_pattern text NOT NULL DEFAULT 'TR{yy}{seq:6}', count_no_pattern text NOT NULL DEFAULT 'SC{yy}{seq:5}',
  doc_no_pattern text NOT NULL DEFAULT 'SD{yy}{seq:6}',
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT settings__pk PRIMARY KEY (id),
  CONSTRAINT settings__tenant_id__uq UNIQUE (tenant_id),
  CONSTRAINT settings__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT settings__store__fk FOREIGN KEY (tenant_id, default_consumption_store_id) REFERENCES inventory.stores (tenant_id, id),
  CONSTRAINT settings__ranges__ck CHECK (over_receipt_tolerance_bp BETWEEN 0 AND 5000 AND expiry_alert_days BETWEEN 1 AND 365
    AND reconciliation_gap_alert_bp BETWEEN 0 AND 10000 AND backdate_max_days BETWEEN 0 AND 31),
  CONSTRAINT settings__patterns__ck CHECK (char_length(po_no_pattern) BETWEEN 1 AND 40 AND char_length(grn_no_pattern) BETWEEN 1 AND 40
    AND char_length(transfer_no_pattern) BETWEEN 1 AND 40 AND char_length(count_no_pattern) BETWEEN 1 AND 40
    AND char_length(doc_no_pattern) BETWEEN 1 AND 40)
);

CREATE TABLE inventory.number_counters (
  tenant_id uuid NOT NULL, series text NOT NULL, period_key text NOT NULL, next_value bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT number_counters__pk PRIMARY KEY (tenant_id, series, period_key),
  CONSTRAINT number_counters__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT number_counters__ck CHECK (series IN ('po','grn','transfer','count','doc') AND next_value >= 1
    AND char_length(period_key) BETWEEN 1 AND 16)
);

-- ===== items =====
CREATE TABLE inventory.items (
  id uuid NOT NULL, tenant_id uuid NOT NULL,
  item_code text NOT NULL, name text NOT NULL, category text NOT NULL, base_uom_code text NOT NULL,
  manufacturer text, catalogue_no text, storage_condition text,
  is_lot_tracked boolean NOT NULL DEFAULT true, requires_expiry boolean NOT NULL DEFAULT true,
  open_stability_days integer, container_qty_base numeric(18,6), hs_code text, default_tax_code text, notes text,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT items__pk PRIMARY KEY (id),
  CONSTRAINT items__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT items__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT items__uom__fk FOREIGN KEY (base_uom_code) REFERENCES inventory.g_cs_uom (code),
  CONSTRAINT items__code__ck CHECK (item_code ~ '^[A-Z0-9][A-Z0-9_.\-]{0,31}$'),
  CONSTRAINT items__text__ck CHECK (char_length(name) BETWEEN 1 AND 200 AND coalesce(char_length(manufacturer),0) <= 120
    AND coalesce(char_length(catalogue_no),0) <= 64 AND coalesce(char_length(notes),0) <= 1000),
  CONSTRAINT items__category__ck CHECK (category IN ('reagent','kit','consumable','control','calibrator','other')),
  CONSTRAINT items__storage__ck CHECK (storage_condition IS NULL OR storage_condition IN ('ambient','refrigerated','frozen','other')),
  CONSTRAINT items__expiry_requires_lot__ck CHECK (NOT requires_expiry OR is_lot_tracked),
  CONSTRAINT items__numbers__ck CHECK ((open_stability_days IS NULL OR open_stability_days BETWEEN 1 AND 3650)
    AND (container_qty_base IS NULL OR container_qty_base > 0)
    AND (hs_code IS NULL OR hs_code ~ '^[0-9]{4,10}$')
    AND (default_tax_code IS NULL OR default_tax_code ~ '^[A-Z0-9_]{1,16}$'))  -- 08 A5.6
);
CREATE UNIQUE INDEX items__tenant_id_item_code__uq ON inventory.items (tenant_id, item_code);
CREATE INDEX items__tenant_id_item_code_prefix__idx ON inventory.items (tenant_id, item_code text_pattern_ops);   -- #1 code prefix
CREATE INDEX items__tenant_id_category_active__idx ON inventory.items (tenant_id, is_active, category);
CREATE INDEX items__tenant_id_lower_name__idx ON inventory.items (tenant_id, lower(name) text_pattern_ops);   -- prefix search (02-TRD §6)

CREATE TABLE inventory.item_packs (
  id uuid NOT NULL, tenant_id uuid NOT NULL, item_id uuid NOT NULL,
  pack_code text NOT NULL, label text NOT NULL, uom_code text NOT NULL, qty_in_base numeric(18,6) NOT NULL,
  is_purchase_default boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT item_packs__pk PRIMARY KEY (id),
  CONSTRAINT item_packs__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT item_packs__tenant_id_id_item_id__uq UNIQUE (tenant_id, id, item_id),
  CONSTRAINT item_packs__tenant_id_item_code__uq UNIQUE (tenant_id, item_id, pack_code),
  CONSTRAINT item_packs__item__fk FOREIGN KEY (tenant_id, item_id) REFERENCES inventory.items (tenant_id, id),
  CONSTRAINT item_packs__uom__fk FOREIGN KEY (uom_code) REFERENCES inventory.g_cs_uom (code),
  CONSTRAINT item_packs__ck CHECK (pack_code ~ '^[A-Z0-9_]{1,16}$' AND char_length(label) BETWEEN 1 AND 60 AND qty_in_base > 0)
);
CREATE UNIQUE INDEX item_packs__tenant_id_item_id_default__p_uq ON inventory.item_packs (tenant_id, item_id)
  WHERE is_purchase_default AND is_active;

CREATE TABLE inventory.item_barcodes (
  id uuid NOT NULL, tenant_id uuid NOT NULL, item_id uuid NOT NULL, pack_id uuid, barcode_value text NOT NULL,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT item_barcodes__pk PRIMARY KEY (id),
  CONSTRAINT item_barcodes__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT item_barcodes__item__fk FOREIGN KEY (tenant_id, item_id) REFERENCES inventory.items (tenant_id, id),
  CONSTRAINT item_barcodes__pack__fk FOREIGN KEY (tenant_id, pack_id, item_id) REFERENCES inventory.item_packs (tenant_id, id, item_id),
  CONSTRAINT item_barcodes__ck CHECK (barcode_value ~ '^[\x21-\x7E]{1,64}$' AND barcode_value = upper(barcode_value))
);
CREATE UNIQUE INDEX item_barcodes__tenant_id_value__p_uq ON inventory.item_barcodes (tenant_id, barcode_value) WHERE is_active;
CREATE INDEX item_barcodes__tenant_id_item_id__idx ON inventory.item_barcodes (tenant_id, item_id);

-- ===== suppliers =====
CREATE TABLE inventory.suppliers (
  id uuid NOT NULL, tenant_id uuid NOT NULL,
  supplier_code text NOT NULL, name text NOT NULL, pan_text text, contact_name text, phone_display text, email text,
  address_text text, payment_terms_days integer, notes text,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT suppliers__pk PRIMARY KEY (id),
  CONSTRAINT suppliers__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT suppliers__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT suppliers__ck CHECK (supplier_code ~ '^[A-Z0-9][A-Z0-9_\-]{0,15}$' AND char_length(name) BETWEEN 1 AND 200
    AND (pan_text IS NULL OR pan_text ~ '^[A-Za-z0-9]{1,20}$')
    AND coalesce(char_length(contact_name),0) <= 120 AND coalesce(char_length(phone_display),0) <= 40
    AND coalesce(char_length(email),0) <= 254 AND coalesce(char_length(address_text),0) <= 500
    AND coalesce(char_length(notes),0) <= 1000
    AND (payment_terms_days IS NULL OR payment_terms_days BETWEEN 0 AND 365))
);
CREATE UNIQUE INDEX suppliers__tenant_id_supplier_code__uq ON inventory.suppliers (tenant_id, supplier_code);
CREATE INDEX suppliers__tenant_id_active__idx ON inventory.suppliers (tenant_id, is_active, name);
CREATE INDEX suppliers__tenant_id_lower_name__idx ON inventory.suppliers (tenant_id, lower(name) text_pattern_ops);   -- #17 name prefix

CREATE TABLE inventory.supplier_items (
  id uuid NOT NULL, tenant_id uuid NOT NULL, supplier_id uuid NOT NULL, item_id uuid NOT NULL, pack_id uuid NOT NULL,
  supplier_item_code text, last_unit_price_paisa bigint, lead_time_days integer, default_tax_code text,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT supplier_items__pk PRIMARY KEY (id),
  CONSTRAINT supplier_items__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT supplier_items__key__uq UNIQUE (tenant_id, supplier_id, item_id, pack_id),
  CONSTRAINT supplier_items__supplier__fk FOREIGN KEY (tenant_id, supplier_id) REFERENCES inventory.suppliers (tenant_id, id),
  CONSTRAINT supplier_items__pack__fk FOREIGN KEY (tenant_id, pack_id, item_id) REFERENCES inventory.item_packs (tenant_id, id, item_id),
  CONSTRAINT supplier_items__ck CHECK (coalesce(char_length(supplier_item_code),0) <= 64
    AND (last_unit_price_paisa IS NULL OR last_unit_price_paisa >= 0)
    AND (lead_time_days IS NULL OR lead_time_days BETWEEN 0 AND 365)
    AND (default_tax_code IS NULL OR default_tax_code ~ '^[A-Z0-9_]{1,16}$'))  -- 08 A5.6
);
CREATE INDEX supplier_items__tenant_id_item_id__idx ON inventory.supplier_items (tenant_id, item_id);

CREATE TABLE inventory.store_item_settings (
  id uuid NOT NULL, tenant_id uuid NOT NULL, store_id uuid NOT NULL, item_id uuid NOT NULL,
  reorder_level_base numeric(18,6), reorder_qty_base numeric(18,6), max_level_base numeric(18,6),
  preferred_supplier_id uuid, is_stocked boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT store_item_settings__pk PRIMARY KEY (id),
  CONSTRAINT store_item_settings__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT store_item_settings__key__uq UNIQUE (tenant_id, store_id, item_id),
  CONSTRAINT store_item_settings__store__fk FOREIGN KEY (tenant_id, store_id) REFERENCES inventory.stores (tenant_id, id),
  CONSTRAINT store_item_settings__item__fk FOREIGN KEY (tenant_id, item_id) REFERENCES inventory.items (tenant_id, id),
  CONSTRAINT store_item_settings__supplier__fk FOREIGN KEY (tenant_id, preferred_supplier_id) REFERENCES inventory.suppliers (tenant_id, id),
  CONSTRAINT store_item_settings__ck CHECK ((reorder_level_base IS NULL OR reorder_level_base >= 0)
    AND (reorder_qty_base IS NULL OR reorder_qty_base > 0)
    AND (max_level_base IS NULL OR reorder_level_base IS NULL OR max_level_base >= reorder_level_base))
);
CREATE INDEX store_item_settings__tenant_id_reorder__p_idx ON inventory.store_item_settings (tenant_id, store_id)
  WHERE reorder_level_base IS NOT NULL AND is_active;

-- ===== lots and balances =====
CREATE TABLE inventory.lots (
  id uuid NOT NULL, tenant_id uuid NOT NULL, item_id uuid NOT NULL, lot_no text NOT NULL,
  expiry_on date, manufactured_on date, status text NOT NULL DEFAULT 'available', status_reason_code text,
  last_receipt_qty_base numeric(18,6), last_receipt_value_paisa bigint,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT lots__pk PRIMARY KEY (id),
  CONSTRAINT lots__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT lots__tenant_id_id_item_id__uq UNIQUE (tenant_id, id, item_id),
  CONSTRAINT lots__tenant_id_item_lot__uq UNIQUE (tenant_id, item_id, lot_no),
  CONSTRAINT lots__item__fk FOREIGN KEY (tenant_id, item_id) REFERENCES inventory.items (tenant_id, id),
  CONSTRAINT lots__ck CHECK (lot_no ~ '^[\x21-\x7E]{1,64}$' AND status IN ('available','quarantined','blocked')
    AND (manufactured_on IS NULL OR expiry_on IS NULL OR manufactured_on <= expiry_on)
    AND (last_receipt_qty_base IS NULL OR last_receipt_qty_base > 0)
    AND (last_receipt_value_paisa IS NULL OR last_receipt_value_paisa >= 0))
);
CREATE INDEX lots__tenant_id_expiry_on__idx ON inventory.lots (tenant_id, expiry_on) WHERE expiry_on IS NOT NULL;

CREATE TABLE inventory.stock_balances (
  id uuid NOT NULL, tenant_id uuid NOT NULL, store_id uuid NOT NULL, item_id uuid NOT NULL, lot_id uuid,
  qty_base numeric(18,6) NOT NULL DEFAULT 0, value_paisa bigint NOT NULL DEFAULT 0, last_movement_at timestamptz NOT NULL,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT stock_balances__pk PRIMARY KEY (id),
  CONSTRAINT stock_balances__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT stock_balances__key__uq UNIQUE NULLS NOT DISTINCT (tenant_id, store_id, item_id, lot_id),
  CONSTRAINT stock_balances__store__fk FOREIGN KEY (tenant_id, store_id) REFERENCES inventory.stores (tenant_id, id),
  CONSTRAINT stock_balances__item__fk FOREIGN KEY (tenant_id, item_id) REFERENCES inventory.items (tenant_id, id),
  CONSTRAINT stock_balances__lot__fk FOREIGN KEY (tenant_id, lot_id, item_id) REFERENCES inventory.lots (tenant_id, id, item_id),
  CONSTRAINT stock_balances__lot_nonneg__ck CHECK (lot_id IS NULL OR qty_base >= 0)
);
CREATE INDEX stock_balances__tenant_id_item_id__idx ON inventory.stock_balances (tenant_id, item_id, store_id);
CREATE INDEX stock_balances__tenant_id_store_nonzero__p_idx ON inventory.stock_balances (tenant_id, store_id, item_id)
  WHERE qty_base <> 0;

-- ===== consumption rules (needed by movements FK) =====
CREATE TABLE inventory.consumption_rules (
  id uuid NOT NULL, tenant_id uuid NOT NULL, rule_kind text NOT NULL,
  test_id uuid, analyte_id uuid, instrument_id uuid, item_id uuid NOT NULL,
  qty_base numeric(18,6) NOT NULL, entered_qty numeric(18,6) NOT NULL, entered_pack_id uuid,
  effective_from timestamptz NOT NULL, effective_to timestamptz, supersedes_rule_id uuid, notes text,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT consumption_rules__pk PRIMARY KEY (id),
  CONSTRAINT consumption_rules__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT consumption_rules__item__fk FOREIGN KEY (tenant_id, item_id) REFERENCES inventory.items (tenant_id, id),
  CONSTRAINT consumption_rules__pack__fk FOREIGN KEY (tenant_id, entered_pack_id, item_id) REFERENCES inventory.item_packs (tenant_id, id, item_id),
  CONSTRAINT consumption_rules__test__fk FOREIGN KEY (tenant_id, test_id) REFERENCES catalog.tests (tenant_id, id),
  CONSTRAINT consumption_rules__analyte__fk FOREIGN KEY (tenant_id, analyte_id) REFERENCES catalog.analytes (tenant_id, id),
  CONSTRAINT consumption_rules__instrument__fk FOREIGN KEY (tenant_id, instrument_id) REFERENCES instruments.instruments (tenant_id, id),
  CONSTRAINT consumption_rules__supersedes__fk FOREIGN KEY (tenant_id, supersedes_rule_id) REFERENCES inventory.consumption_rules (tenant_id, id),
  CONSTRAINT consumption_rules__kind__ck CHECK (rule_kind IN ('per_test','per_analyte','per_rerun','per_qc','per_calibration','per_day')),
  CONSTRAINT consumption_rules__shape__ck CHECK (
       (rule_kind = 'per_test'        AND test_id IS NOT NULL AND analyte_id IS NULL)
    OR (rule_kind = 'per_analyte'     AND test_id IS NOT NULL AND analyte_id IS NOT NULL)
    OR (rule_kind = 'per_rerun'       AND test_id IS NOT NULL AND analyte_id IS NULL)
    OR (rule_kind = 'per_qc'          AND test_id IS NOT NULL)
    OR (rule_kind = 'per_calibration' AND test_id IS NOT NULL AND analyte_id IS NULL)
    OR (rule_kind = 'per_day'         AND test_id IS NULL AND analyte_id IS NULL AND instrument_id IS NOT NULL)),
  CONSTRAINT consumption_rules__qty__ck CHECK (qty_base > 0 AND entered_qty > 0
    AND (effective_to IS NULL OR effective_to > effective_from) AND coalesce(char_length(notes),0) <= 500)
);
CREATE UNIQUE INDEX consumption_rules__current__p_uq ON inventory.consumption_rules
  (tenant_id, rule_kind, test_id, analyte_id, instrument_id, item_id) NULLS NOT DISTINCT
  WHERE effective_to IS NULL AND is_active;
CREATE INDEX consumption_rules__tenant_id_match__idx ON inventory.consumption_rules
  (tenant_id, rule_kind, test_id, analyte_id, instrument_id, effective_from);
CREATE INDEX consumption_rules__tenant_id_instrument__idx ON inventory.consumption_rules (tenant_id, instrument_id, rule_kind);
CREATE INDEX consumption_rules__tenant_id_item_id__idx ON inventory.consumption_rules (tenant_id, item_id);   -- #69 item filter, uom lock
-- NOTE for C0: "NULLS NOT DISTINCT" on a CREATE UNIQUE INDEX goes after the column list (PG 15+ syntax):
-- CREATE UNIQUE INDEX ... ON t (cols) NULLS NOT DISTINCT WHERE ...;

-- ===== documents =====
CREATE TABLE inventory.purchase_orders (
  id uuid NOT NULL, tenant_id uuid NOT NULL, po_no text NOT NULL, branch_id uuid NOT NULL, store_id uuid NOT NULL, supplier_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'draft', source text NOT NULL DEFAULT 'manual', expected_on date, notes text,
  subtotal_paisa bigint NOT NULL DEFAULT 0, discount_paisa bigint NOT NULL DEFAULT 0, net_paisa bigint NOT NULL DEFAULT 0,
  vat_paisa bigint NOT NULL DEFAULT 0, total_paisa bigint NOT NULL DEFAULT 0,
  approved_at timestamptz, approved_by uuid, sent_at timestamptz, sent_by uuid, sent_channel text, sent_reference text,
  cancelled_at timestamptz, cancelled_by uuid, cancel_reason_code text, cancel_reason_text text,
  closed_at timestamptz, closed_by uuid, close_reason_code text, close_reason_text text,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT purchase_orders__pk PRIMARY KEY (id),
  CONSTRAINT purchase_orders__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT purchase_orders__store__fk FOREIGN KEY (tenant_id, store_id, branch_id) REFERENCES inventory.stores (tenant_id, id, branch_id),
  CONSTRAINT purchase_orders__supplier__fk FOREIGN KEY (tenant_id, supplier_id) REFERENCES inventory.suppliers (tenant_id, id),
  CONSTRAINT purchase_orders__status__ck CHECK (status IN ('draft','approved','sent','partially_received','received','closed','cancelled')),
  CONSTRAINT purchase_orders__ck CHECK (source IN ('manual','reorder')
    AND subtotal_paisa >= 0 AND discount_paisa >= 0 AND net_paisa >= 0 AND vat_paisa >= 0 AND total_paisa = net_paisa + vat_paisa
    AND (sent_channel IS NULL OR sent_channel IN ('email','phone','in_person','portal','other'))
    AND coalesce(char_length(sent_reference),0) <= 120 AND coalesce(char_length(notes),0) <= 1000
    AND coalesce(char_length(cancel_reason_text),0) <= 500 AND coalesce(char_length(close_reason_text),0) <= 500),
  CONSTRAINT purchase_orders__lifecycle__ck CHECK ((status IN ('draft','cancelled') OR approved_at IS NOT NULL)
    AND (status <> 'sent' OR sent_at IS NOT NULL) AND (status <> 'closed' OR closed_at IS NOT NULL)
    AND (status <> 'cancelled' OR (cancelled_at IS NOT NULL AND cancel_reason_code IS NOT NULL)))
);
CREATE UNIQUE INDEX purchase_orders__tenant_id_po_no__uq ON inventory.purchase_orders (tenant_id, po_no);
CREATE INDEX purchase_orders__tenant_id_status__idx ON inventory.purchase_orders (tenant_id, status, created_at DESC);
CREATE INDEX purchase_orders__tenant_id_supplier__idx ON inventory.purchase_orders (tenant_id, supplier_id, created_at DESC);
CREATE INDEX purchase_orders__tenant_id_branch__idx ON inventory.purchase_orders (tenant_id, branch_id, status);

CREATE TABLE inventory.purchase_order_lines (
  id uuid NOT NULL, tenant_id uuid NOT NULL, po_id uuid NOT NULL, line_no integer NOT NULL,
  item_id uuid NOT NULL, pack_id uuid NOT NULL, qty_packs numeric(12,3) NOT NULL, qty_in_base_snapshot numeric(18,6) NOT NULL,
  qty_base numeric(18,6) NOT NULL, unit_price_paisa bigint NOT NULL, discount_paisa bigint NOT NULL DEFAULT 0,
  tax_code text NULL /* NULL = exempt line, 08 A4.1 */, tax_rate_bp integer NOT NULL, net_paisa bigint NOT NULL, vat_paisa bigint NOT NULL, line_total_paisa bigint NOT NULL,
  received_qty_base numeric(18,6) NOT NULL DEFAULT 0, is_closed_short boolean NOT NULL DEFAULT false,
  removed_at timestamptz NULL, removed_by uuid NULL,   -- soft removal in draft (08 A17 D-71)
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT purchase_order_lines__pk PRIMARY KEY (id),
  CONSTRAINT purchase_order_lines__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT purchase_order_lines__removed__ck CHECK ((removed_at IS NULL) = (removed_by IS NULL)),
  CONSTRAINT purchase_order_lines__po__fk FOREIGN KEY (tenant_id, po_id) REFERENCES inventory.purchase_orders (tenant_id, id),
  CONSTRAINT purchase_order_lines__pack__fk FOREIGN KEY (tenant_id, pack_id, item_id) REFERENCES inventory.item_packs (tenant_id, id, item_id),
  CONSTRAINT purchase_order_lines__ck CHECK (line_no BETWEEN 1 AND 500 AND qty_packs > 0 AND qty_in_base_snapshot > 0
    AND qty_base = round(qty_packs * qty_in_base_snapshot, 6) AND unit_price_paisa >= 0 AND discount_paisa >= 0
    AND tax_rate_bp BETWEEN 0 AND 10000 AND net_paisa >= 0 AND vat_paisa >= 0 AND line_total_paisa = net_paisa + vat_paisa
    AND (tax_code IS NULL OR tax_code ~ '^[A-Z0-9_]{1,16}$') AND (tax_code IS NOT NULL OR tax_rate_bp = 0)  -- 08 A4.1/A5.6 [CONV: 0]
    AND received_qty_base >= 0)
);
CREATE UNIQUE INDEX purchase_order_lines__tenant_id_po_line__p_uq ON inventory.purchase_order_lines (tenant_id, po_id, line_no)
  WHERE removed_at IS NULL;
CREATE INDEX purchase_order_lines__tenant_id_item__idx ON inventory.purchase_order_lines (tenant_id, item_id);

CREATE TABLE inventory.goods_receipts (
  id uuid NOT NULL, tenant_id uuid NOT NULL, grn_no text NOT NULL, kind text NOT NULL, store_id uuid NOT NULL,
  supplier_id uuid, po_id uuid, status text NOT NULL DEFAULT 'draft', received_at timestamptz NOT NULL,
  supplier_invoice_no text, supplier_invoice_on date, supplier_invoice_total_paisa bigint,
  subtotal_paisa bigint NOT NULL DEFAULT 0, discount_paisa bigint NOT NULL DEFAULT 0, net_paisa bigint NOT NULL DEFAULT 0,
  vat_paisa bigint NOT NULL DEFAULT 0, total_paisa bigint NOT NULL DEFAULT 0,
  posted_at timestamptz, posted_by uuid, cancelled_at timestamptz, cancelled_by uuid, cancel_reason_text text, notes text,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT goods_receipts__pk PRIMARY KEY (id),
  CONSTRAINT goods_receipts__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT goods_receipts__store__fk FOREIGN KEY (tenant_id, store_id) REFERENCES inventory.stores (tenant_id, id),
  CONSTRAINT goods_receipts__supplier__fk FOREIGN KEY (tenant_id, supplier_id) REFERENCES inventory.suppliers (tenant_id, id),
  CONSTRAINT goods_receipts__po__fk FOREIGN KEY (tenant_id, po_id) REFERENCES inventory.purchase_orders (tenant_id, id),
  CONSTRAINT goods_receipts__ck CHECK (kind IN ('purchase','opening_balance') AND status IN ('draft','posted','cancelled')
    AND ((kind = 'purchase') = (supplier_id IS NOT NULL)) AND (kind = 'purchase' OR po_id IS NULL)
    AND coalesce(char_length(supplier_invoice_no),0) <= 64 AND (supplier_invoice_total_paisa IS NULL OR supplier_invoice_total_paisa >= 0)
    AND total_paisa = net_paisa + vat_paisa AND coalesce(char_length(notes),0) <= 1000
    AND coalesce(char_length(cancel_reason_text),0) <= 500
    AND (status <> 'posted' OR (posted_at IS NOT NULL AND posted_by IS NOT NULL)))
);
CREATE UNIQUE INDEX goods_receipts__tenant_id_grn_no__uq ON inventory.goods_receipts (tenant_id, grn_no);
CREATE INDEX goods_receipts__tenant_id_store_status__idx ON inventory.goods_receipts (tenant_id, store_id, status, received_at DESC);
CREATE INDEX goods_receipts__tenant_id_po__p_idx ON inventory.goods_receipts (tenant_id, po_id) WHERE po_id IS NOT NULL;
CREATE INDEX goods_receipts__tenant_id_posted__idx ON inventory.goods_receipts (tenant_id, posted_at) WHERE status = 'posted';
CREATE INDEX goods_receipts__tenant_id_supplier__idx ON inventory.goods_receipts (tenant_id, supplier_id, received_at DESC);   -- #49 supplier filter

CREATE TABLE inventory.goods_receipt_lines (
  id uuid NOT NULL, tenant_id uuid NOT NULL, grn_id uuid NOT NULL, line_no integer NOT NULL, po_line_id uuid,
  item_id uuid NOT NULL, pack_id uuid NOT NULL, qty_packs numeric(12,3) NOT NULL, qty_in_base_snapshot numeric(18,6) NOT NULL,
  qty_base numeric(18,6) NOT NULL, lot_no text, expiry_on date, manufactured_on date, lot_id uuid,
  unit_price_paisa bigint NOT NULL, discount_paisa bigint NOT NULL DEFAULT 0, tax_code text NULL /* NULL = exempt line, 08 A4.1 */, tax_rate_bp integer NOT NULL,
  net_paisa bigint NOT NULL, vat_paisa bigint NOT NULL, line_total_paisa bigint NOT NULL, capitalised_value_paisa bigint,
  removed_at timestamptz NULL, removed_by uuid NULL,   -- soft removal in draft (08 A17 D-71)
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT goods_receipt_lines__pk PRIMARY KEY (id),
  CONSTRAINT goods_receipt_lines__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT goods_receipt_lines__removed__ck CHECK ((removed_at IS NULL) = (removed_by IS NULL)),
  CONSTRAINT goods_receipt_lines__grn__fk FOREIGN KEY (tenant_id, grn_id) REFERENCES inventory.goods_receipts (tenant_id, id),
  CONSTRAINT goods_receipt_lines__po_line__fk FOREIGN KEY (tenant_id, po_line_id) REFERENCES inventory.purchase_order_lines (tenant_id, id),
  CONSTRAINT goods_receipt_lines__pack__fk FOREIGN KEY (tenant_id, pack_id, item_id) REFERENCES inventory.item_packs (tenant_id, id, item_id),
  CONSTRAINT goods_receipt_lines__lot__fk FOREIGN KEY (tenant_id, lot_id, item_id) REFERENCES inventory.lots (tenant_id, id, item_id),
  CONSTRAINT goods_receipt_lines__ck CHECK (line_no BETWEEN 1 AND 500 AND qty_packs > 0 AND qty_in_base_snapshot > 0
    AND qty_base = round(qty_packs * qty_in_base_snapshot, 6) AND unit_price_paisa >= 0 AND discount_paisa >= 0
    AND tax_rate_bp BETWEEN 0 AND 10000 AND net_paisa >= 0 AND vat_paisa >= 0 AND line_total_paisa = net_paisa + vat_paisa
    AND (tax_code IS NULL OR tax_code ~ '^[A-Z0-9_]{1,16}$') AND (tax_code IS NOT NULL OR tax_rate_bp = 0)  -- 08 A4.1/A5.6 [CONV: 0]
    AND (lot_no IS NULL OR lot_no ~ '^[\x21-\x7E]{1,64}$')
    AND (capitalised_value_paisa IS NULL OR capitalised_value_paisa >= 0))
);
CREATE UNIQUE INDEX goods_receipt_lines__tenant_id_grn_line__p_uq ON inventory.goods_receipt_lines (tenant_id, grn_id, line_no)
  WHERE removed_at IS NULL;

CREATE TABLE inventory.transfers (
  id uuid NOT NULL, tenant_id uuid NOT NULL, transfer_no text NOT NULL, from_store_id uuid NOT NULL, to_store_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'draft', dispatched_at timestamptz, dispatched_by uuid, received_at timestamptz, received_by uuid,
  cancelled_at timestamptz, cancelled_by uuid, cancel_reason_text text, notes text,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT transfers__pk PRIMARY KEY (id),
  CONSTRAINT transfers__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT transfers__from__fk FOREIGN KEY (tenant_id, from_store_id) REFERENCES inventory.stores (tenant_id, id),
  CONSTRAINT transfers__to__fk FOREIGN KEY (tenant_id, to_store_id) REFERENCES inventory.stores (tenant_id, id),
  CONSTRAINT transfers__ck CHECK (from_store_id <> to_store_id AND status IN ('draft','dispatched','received','cancelled')
    AND coalesce(char_length(notes),0) <= 1000 AND coalesce(char_length(cancel_reason_text),0) <= 500
    AND (status NOT IN ('dispatched','received') OR dispatched_at IS NOT NULL)
    AND (status <> 'received' OR received_at IS NOT NULL))
);
CREATE UNIQUE INDEX transfers__tenant_id_transfer_no__uq ON inventory.transfers (tenant_id, transfer_no);
CREATE INDEX transfers__tenant_id_from__idx ON inventory.transfers (tenant_id, from_store_id, status);
CREATE INDEX transfers__tenant_id_to__idx ON inventory.transfers (tenant_id, to_store_id, status);

CREATE TABLE inventory.transfer_lines (
  id uuid NOT NULL, tenant_id uuid NOT NULL, transfer_id uuid NOT NULL, line_no integer NOT NULL,
  item_id uuid NOT NULL, lot_id uuid, qty_base numeric(18,6) NOT NULL, dispatched_value_paisa bigint,
  received_qty_base numeric(18,6), discrepancy_reason_code text,
  removed_at timestamptz NULL, removed_by uuid NULL,   -- soft removal in draft (08 A17 D-71)
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT transfer_lines__pk PRIMARY KEY (id),
  CONSTRAINT transfer_lines__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT transfer_lines__removed__ck CHECK ((removed_at IS NULL) = (removed_by IS NULL)),
  CONSTRAINT transfer_lines__transfer__fk FOREIGN KEY (tenant_id, transfer_id) REFERENCES inventory.transfers (tenant_id, id),
  CONSTRAINT transfer_lines__item__fk FOREIGN KEY (tenant_id, item_id) REFERENCES inventory.items (tenant_id, id),
  CONSTRAINT transfer_lines__lot__fk FOREIGN KEY (tenant_id, lot_id, item_id) REFERENCES inventory.lots (tenant_id, id, item_id),
  CONSTRAINT transfer_lines__ck CHECK (line_no BETWEEN 1 AND 500 AND qty_base > 0
    AND (received_qty_base IS NULL OR (received_qty_base >= 0 AND received_qty_base <= qty_base))
    AND (received_qty_base IS NULL OR received_qty_base = qty_base OR discrepancy_reason_code IS NOT NULL))
);
CREATE UNIQUE INDEX transfer_lines__tenant_id_transfer_line__p_uq ON inventory.transfer_lines (tenant_id, transfer_id, line_no)
  WHERE removed_at IS NULL;

CREATE TABLE inventory.stock_documents (
  id uuid NOT NULL, tenant_id uuid NOT NULL, doc_no text NOT NULL, doc_kind text NOT NULL, store_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL, issued_to_kind text, department_id uuid, instrument_id uuid, supplier_id uuid, grn_id uuid,
  reason_code text, reason_text text, container_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  CONSTRAINT stock_documents__pk PRIMARY KEY (id),
  CONSTRAINT stock_documents__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT stock_documents__store__fk FOREIGN KEY (tenant_id, store_id) REFERENCES inventory.stores (tenant_id, id),
  CONSTRAINT stock_documents__department__fk FOREIGN KEY (tenant_id, department_id) REFERENCES catalog.departments (tenant_id, id),
  CONSTRAINT stock_documents__instrument__fk FOREIGN KEY (tenant_id, instrument_id) REFERENCES instruments.instruments (tenant_id, id),
  CONSTRAINT stock_documents__supplier__fk FOREIGN KEY (tenant_id, supplier_id) REFERENCES inventory.suppliers (tenant_id, id),
  CONSTRAINT stock_documents__grn__fk FOREIGN KEY (tenant_id, grn_id) REFERENCES inventory.goods_receipts (tenant_id, id),
  CONSTRAINT stock_documents__kind__ck CHECK (doc_kind IN ('issue','return_to_store','supplier_return','wastage','adjustment','expiry_writeoff')),
  CONSTRAINT stock_documents__shape__ck CHECK ((   -- outer group: (issue shape OR non-issue) AND …
        (doc_kind = 'issue' AND issued_to_kind IN ('department','instrument','general')
           AND (issued_to_kind <> 'department' OR department_id IS NOT NULL) AND (issued_to_kind <> 'instrument' OR instrument_id IS NOT NULL))
     OR (doc_kind <> 'issue' AND issued_to_kind IS NULL))
    AND (doc_kind <> 'supplier_return' OR supplier_id IS NOT NULL)
    AND (doc_kind NOT IN ('wastage','adjustment','supplier_return') OR reason_code IS NOT NULL)
    AND coalesce(char_length(reason_text),0) <= 500)
);
CREATE UNIQUE INDEX stock_documents__tenant_id_doc_no__uq ON inventory.stock_documents (tenant_id, doc_no);
CREATE INDEX stock_documents__tenant_id_store_kind__idx ON inventory.stock_documents (tenant_id, store_id, doc_kind, occurred_at DESC);

CREATE TABLE inventory.stock_document_lines (
  id uuid NOT NULL, tenant_id uuid NOT NULL, document_id uuid NOT NULL, line_no integer NOT NULL,
  item_id uuid NOT NULL, lot_id uuid, direction text NOT NULL, qty_base numeric(18,6) NOT NULL, value_paisa bigint NOT NULL,
  reason_code text,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  CONSTRAINT stock_document_lines__pk PRIMARY KEY (id),
  CONSTRAINT stock_document_lines__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT stock_document_lines__line__uq UNIQUE (tenant_id, document_id, line_no),
  CONSTRAINT stock_document_lines__doc__fk FOREIGN KEY (tenant_id, document_id) REFERENCES inventory.stock_documents (tenant_id, id),
  CONSTRAINT stock_document_lines__item__fk FOREIGN KEY (tenant_id, item_id) REFERENCES inventory.items (tenant_id, id),
  CONSTRAINT stock_document_lines__lot__fk FOREIGN KEY (tenant_id, lot_id, item_id) REFERENCES inventory.lots (tenant_id, id, item_id),
  CONSTRAINT stock_document_lines__ck CHECK (line_no BETWEEN 1 AND 500 AND direction IN ('in','out') AND qty_base > 0 AND value_paisa >= 0)
);

CREATE TABLE inventory.stock_counts (
  id uuid NOT NULL, tenant_id uuid NOT NULL, count_no text NOT NULL, store_id uuid NOT NULL, status text NOT NULL DEFAULT 'open',
  scope_category text, snapshot_at timestamptz NOT NULL, posted_at timestamptz, posted_by uuid,
  cancelled_at timestamptz, cancelled_by uuid, notes text,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT stock_counts__pk PRIMARY KEY (id),
  CONSTRAINT stock_counts__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT stock_counts__store__fk FOREIGN KEY (tenant_id, store_id) REFERENCES inventory.stores (tenant_id, id),
  CONSTRAINT stock_counts__ck CHECK (status IN ('open','posted','cancelled')
    AND (scope_category IS NULL OR scope_category IN ('reagent','kit','consumable','control','calibrator','other'))
    AND coalesce(char_length(notes),0) <= 1000)
);
CREATE UNIQUE INDEX stock_counts__tenant_id_count_no__uq ON inventory.stock_counts (tenant_id, count_no);
CREATE UNIQUE INDEX stock_counts__tenant_id_store_open__p_uq ON inventory.stock_counts (tenant_id, store_id) WHERE status = 'open';
CREATE INDEX stock_counts__tenant_id_store_status__idx ON inventory.stock_counts (tenant_id, store_id, status);   -- #63 list

CREATE TABLE inventory.stock_count_lines (
  id uuid NOT NULL, tenant_id uuid NOT NULL, count_id uuid NOT NULL, item_id uuid NOT NULL, lot_id uuid,
  book_qty_snapshot numeric(18,6) NOT NULL, counted_qty_base numeric(18,6), counted_at timestamptz, counted_by uuid,
  book_qty_at_count numeric(18,6), variance_qty_base numeric(18,6), variance_value_paisa bigint, reason_code text,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT stock_count_lines__pk PRIMARY KEY (id),
  CONSTRAINT stock_count_lines__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT stock_count_lines__key__uq UNIQUE NULLS NOT DISTINCT (tenant_id, count_id, item_id, lot_id),
  CONSTRAINT stock_count_lines__count__fk FOREIGN KEY (tenant_id, count_id) REFERENCES inventory.stock_counts (tenant_id, id),
  CONSTRAINT stock_count_lines__item__fk FOREIGN KEY (tenant_id, item_id) REFERENCES inventory.items (tenant_id, id),
  CONSTRAINT stock_count_lines__lot__fk FOREIGN KEY (tenant_id, lot_id, item_id) REFERENCES inventory.lots (tenant_id, id, item_id),
  CONSTRAINT stock_count_lines__ck CHECK ((counted_qty_base IS NULL OR counted_qty_base >= 0)
    AND ((counted_qty_base IS NULL) = (counted_at IS NULL)))
);

CREATE TABLE inventory.opened_containers (
  id uuid NOT NULL, tenant_id uuid NOT NULL, store_id uuid NOT NULL, item_id uuid NOT NULL, lot_id uuid, instrument_id uuid,
  opened_at timestamptz NOT NULL, opened_by uuid NOT NULL, open_expiry_at timestamptz, status text NOT NULL DEFAULT 'open',
  finished_at timestamptz, finished_by uuid, discard_document_id uuid, notes text,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT opened_containers__pk PRIMARY KEY (id),
  CONSTRAINT opened_containers__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT opened_containers__store__fk FOREIGN KEY (tenant_id, store_id) REFERENCES inventory.stores (tenant_id, id),
  CONSTRAINT opened_containers__lot__fk FOREIGN KEY (tenant_id, lot_id, item_id) REFERENCES inventory.lots (tenant_id, id, item_id),
  CONSTRAINT opened_containers__item__fk FOREIGN KEY (tenant_id, item_id) REFERENCES inventory.items (tenant_id, id),
  CONSTRAINT opened_containers__instrument__fk FOREIGN KEY (tenant_id, instrument_id) REFERENCES instruments.instruments (tenant_id, id),
  CONSTRAINT opened_containers__discard__fk FOREIGN KEY (tenant_id, discard_document_id) REFERENCES inventory.stock_documents (tenant_id, id),
  CONSTRAINT opened_containers__ck CHECK (status IN ('open','finished','discarded') AND coalesce(char_length(notes),0) <= 500
    AND (status = 'open' OR finished_at IS NOT NULL) AND (status <> 'discarded' OR discard_document_id IS NOT NULL))
);
CREATE INDEX opened_containers__tenant_id_in_use__p_idx ON inventory.opened_containers
  (tenant_id, instrument_id, item_id, store_id, opened_at DESC) WHERE status = 'open';
CREATE INDEX opened_containers__tenant_id_store_open__p_idx ON inventory.opened_containers
  (tenant_id, store_id, item_id, lot_id) WHERE status = 'open';
CREATE INDEX opened_containers__tenant_id_open_expiry__p_idx ON inventory.opened_containers (tenant_id, open_expiry_at)
  WHERE status = 'open' AND open_expiry_at IS NOT NULL;
-- stock_documents.container_id FK added after opened_containers exists:
ALTER TABLE inventory.stock_documents ADD CONSTRAINT stock_documents__container__fk
  FOREIGN KEY (tenant_id, container_id) REFERENCES inventory.opened_containers (tenant_id, id);

CREATE TABLE inventory.instrument_bindings (
  id uuid NOT NULL, tenant_id uuid NOT NULL, instrument_id uuid NOT NULL, store_id uuid NOT NULL,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT instrument_bindings__pk PRIMARY KEY (id),
  CONSTRAINT instrument_bindings__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT instrument_bindings__instrument__fk FOREIGN KEY (tenant_id, instrument_id) REFERENCES instruments.instruments (tenant_id, id),
  CONSTRAINT instrument_bindings__store__fk FOREIGN KEY (tenant_id, store_id) REFERENCES inventory.stores (tenant_id, id)
);
CREATE UNIQUE INDEX instrument_bindings__tenant_id_instrument__p_uq ON inventory.instrument_bindings (tenant_id, instrument_id) WHERE is_active;
CREATE INDEX instrument_bindings__tenant_id_store__p_idx ON inventory.instrument_bindings (tenant_id, store_id) WHERE is_active;   -- #23, #14

-- ===== consumption facts =====
CREATE TABLE inventory.consumption_facts (
  id uuid NOT NULL, tenant_id uuid NOT NULL, fact_kind text NOT NULL, basis_key text NOT NULL, source text NOT NULL,
  source_event_id uuid, source_event_type text, instrument_id uuid, test_id uuid, analyte_id uuid, department_id uuid,
  centre_id uuid, processing_branch_id uuid, occurred_at timestamptz NOT NULL, business_date date NOT NULL,
  multiplier integer NOT NULL DEFAULT 1, store_id uuid, status text NOT NULL, rules_applied integer NOT NULL DEFAULT 0,
  value_paisa_total bigint NOT NULL DEFAULT 0, reason_code text, note text, resolved_at timestamptz, resolved_by uuid,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT consumption_facts__pk PRIMARY KEY (id),
  CONSTRAINT consumption_facts__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT consumption_facts__basis__uq UNIQUE (tenant_id, basis_key),
  CONSTRAINT consumption_facts__store__fk FOREIGN KEY (tenant_id, store_id) REFERENCES inventory.stores (tenant_id, id),
  CONSTRAINT consumption_facts__instrument__fk FOREIGN KEY (tenant_id, instrument_id) REFERENCES instruments.instruments (tenant_id, id),
  CONSTRAINT consumption_facts__test__fk FOREIGN KEY (tenant_id, test_id) REFERENCES catalog.tests (tenant_id, id),
  CONSTRAINT consumption_facts__ck CHECK (fact_kind IN ('test','analyte','rerun','qc','calibration','fixed')
    AND source IN ('event','manual','cron') AND status IN ('posted','no_rule','unresolved','dismissed','reversed')
    AND char_length(basis_key) BETWEEN 1 AND 200 AND multiplier BETWEEN 1 AND 50 AND rules_applied >= 0
    AND coalesce(char_length(note),0) <= 500 AND (source = 'event') = (source_event_id IS NOT NULL)
    AND (status <> 'posted' OR store_id IS NOT NULL OR rules_applied = 0))
);
-- instrument/test FKs: events may carry ids of rows the C7/C3 tables always keep (never deleted — CV §5.6).
-- NOTE for C0: analyte_id, department_id, centre_id, processing_branch_id carry no FK (opaque copies from events, like C7 05-SCHEMA).
CREATE INDEX consumption_facts__tenant_id_status__p_idx ON inventory.consumption_facts (tenant_id, status, occurred_at)
  WHERE status = 'unresolved';
CREATE INDEX consumption_facts__tenant_id_instrument_date__idx ON inventory.consumption_facts (tenant_id, instrument_id, business_date, fact_kind);
CREATE INDEX consumption_facts__tenant_id_date_kind__idx ON inventory.consumption_facts (tenant_id, business_date, fact_kind);

-- ===== ledger =====
CREATE TABLE inventory.stock_movements (
  id uuid NOT NULL, tenant_id uuid NOT NULL, business_date date NOT NULL, occurred_at timestamptz NOT NULL,
  store_id uuid NOT NULL, item_id uuid NOT NULL, lot_id uuid, movement_kind text NOT NULL,
  qty_base numeric(18,6) NOT NULL, value_paisa bigint NOT NULL, value_basis text NOT NULL,
  doc_type text NOT NULL, doc_id uuid NOT NULL, doc_line_id uuid,
  instrument_id uuid, attributed_test_id uuid, rule_id uuid, reason_code text, reverses_movement_id uuid,
  balance_qty_after numeric(18,6) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  CONSTRAINT stock_movements__pk PRIMARY KEY (id),
  CONSTRAINT stock_movements__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT stock_movements__store__fk FOREIGN KEY (tenant_id, store_id) REFERENCES inventory.stores (tenant_id, id),
  CONSTRAINT stock_movements__item__fk FOREIGN KEY (tenant_id, item_id) REFERENCES inventory.items (tenant_id, id),
  CONSTRAINT stock_movements__lot__fk FOREIGN KEY (tenant_id, lot_id, item_id) REFERENCES inventory.lots (tenant_id, id, item_id),
  CONSTRAINT stock_movements__instrument__fk FOREIGN KEY (tenant_id, instrument_id) REFERENCES instruments.instruments (tenant_id, id),
  CONSTRAINT stock_movements__test__fk FOREIGN KEY (tenant_id, attributed_test_id) REFERENCES catalog.tests (tenant_id, id),
  CONSTRAINT stock_movements__rule__fk FOREIGN KEY (tenant_id, rule_id) REFERENCES inventory.consumption_rules (tenant_id, id),
  CONSTRAINT stock_movements__reverses__fk FOREIGN KEY (tenant_id, reverses_movement_id) REFERENCES inventory.stock_movements (tenant_id, id),
  CONSTRAINT stock_movements__kind__ck CHECK (movement_kind IN ('receive','opening_balance','supplier_return','issue','return_to_store',
    'transfer_out','transfer_in','consume_test','consume_analyte','consume_rerun','consume_qc','consume_calibration','consume_fixed',
    'consume_reversal','wastage','expiry_writeoff','adjust_in','adjust_out','count_adjust_in','count_adjust_out')),
  CONSTRAINT stock_movements__sign__ck CHECK (qty_base <> 0 AND (
       (movement_kind IN ('receive','opening_balance','return_to_store','transfer_in','consume_reversal','adjust_in','count_adjust_in') AND qty_base > 0 AND value_paisa >= 0)
    OR (movement_kind IN ('supplier_return','issue','transfer_out','consume_test','consume_analyte','consume_rerun','consume_qc',
                          'consume_calibration','consume_fixed','wastage','expiry_writeoff','adjust_out','count_adjust_out')
        AND qty_base < 0 AND value_paisa <= 0))),
  CONSTRAINT stock_movements__doc__ck CHECK (doc_type IN ('goods_receipt','stock_document','transfer','stock_count','consumption_fact')
    AND value_basis IN ('receipt','average','last_receipt','transfer','reversal','none')
    AND (movement_kind <> 'consume_reversal' OR reverses_movement_id IS NOT NULL))
);
-- Unlotted consumption with unknown item cost carries value 0 (value_basis 'none'); that satisfies value_paisa <= 0.
CREATE INDEX stock_movements__tenant_id_store_item__idx ON inventory.stock_movements (tenant_id, store_id, item_id, occurred_at DESC);
CREATE INDEX stock_movements__tenant_id_store_occurred__idx ON inventory.stock_movements (tenant_id, store_id, occurred_at DESC, id DESC);
CREATE INDEX stock_movements__tenant_id_date_kind__idx ON inventory.stock_movements (tenant_id, business_date, movement_kind);
CREATE INDEX stock_movements__tenant_id_doc__idx ON inventory.stock_movements (tenant_id, doc_type, doc_id);
CREATE INDEX stock_movements__tenant_id_lot__p_idx ON inventory.stock_movements (tenant_id, lot_id, occurred_at) WHERE lot_id IS NOT NULL;
CREATE INDEX stock_movements__tenant_id_instrument_date__p_idx ON inventory.stock_movements (tenant_id, instrument_id, business_date)
  WHERE instrument_id IS NOT NULL;

-- ===== projections =====
CREATE TABLE inventory.consumption_daily (
  id uuid NOT NULL, tenant_id uuid NOT NULL, business_date date NOT NULL, store_id uuid NOT NULL, item_id uuid NOT NULL,
  movement_kind text NOT NULL, instrument_id uuid, attributed_test_id uuid,
  qty_consumed numeric(18,6) NOT NULL DEFAULT 0, value_consumed_paisa bigint NOT NULL DEFAULT 0, movements integer NOT NULL DEFAULT 0,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT consumption_daily__pk PRIMARY KEY (id),
  CONSTRAINT consumption_daily__key__uq UNIQUE NULLS NOT DISTINCT
    (tenant_id, business_date, store_id, item_id, movement_kind, instrument_id, attributed_test_id),
  CONSTRAINT consumption_daily__store__fk FOREIGN KEY (tenant_id, store_id) REFERENCES inventory.stores (tenant_id, id),
  CONSTRAINT consumption_daily__item__fk FOREIGN KEY (tenant_id, item_id) REFERENCES inventory.items (tenant_id, id),
  CONSTRAINT consumption_daily__kind__ck CHECK (movement_kind IN ('issue','consume_test','consume_analyte','consume_rerun','consume_qc',
    'consume_calibration','consume_fixed','wastage','expiry_writeoff','count_adjust_out'))
);
-- return_to_store is recorded under 'issue' with negative qty; count_adjust_in under 'count_adjust_out' with negative qty;
-- consume_reversal under the reversed kind with negative qty (§6.4).
CREATE INDEX consumption_daily__tenant_id_date__idx ON inventory.consumption_daily (tenant_id, business_date, store_id);
CREATE INDEX consumption_daily__tenant_id_instrument__p_idx ON inventory.consumption_daily (tenant_id, instrument_id, business_date)
  WHERE instrument_id IS NOT NULL;
CREATE INDEX consumption_daily__tenant_id_test__p_idx ON inventory.consumption_daily (tenant_id, attributed_test_id, business_date)
  WHERE attributed_test_id IS NOT NULL;

CREATE TABLE inventory.test_counts_daily (
  id uuid NOT NULL, tenant_id uuid NOT NULL, business_date date NOT NULL, instrument_id uuid, test_id uuid NOT NULL,
  tests_counted integer NOT NULL DEFAULT 0, verified_result_events integer NOT NULL DEFAULT 0,
  rerun_events integer NOT NULL DEFAULT 0, qc_events integer NOT NULL DEFAULT 0,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT test_counts_daily__pk PRIMARY KEY (id),
  CONSTRAINT test_counts_daily__key__uq UNIQUE NULLS NOT DISTINCT (tenant_id, business_date, instrument_id, test_id),
  CONSTRAINT test_counts_daily__ck CHECK (tests_counted >= 0 AND verified_result_events >= 0 AND rerun_events >= 0 AND qc_events >= 0)
);
CREATE INDEX test_counts_daily__tenant_id_test__idx ON inventory.test_counts_daily (tenant_id, test_id, business_date);

CREATE TABLE inventory.instrument_qc_daily (   -- 08 A17 D-74; P-18(b) exception: no id/version/is_active (§1)
  tenant_id uuid NOT NULL, business_date date NOT NULL, instrument_id uuid NOT NULL,
  qc_observations integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT instrument_qc_daily__pk PRIMARY KEY (tenant_id, business_date, instrument_id),
  CONSTRAINT instrument_qc_daily__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT instrument_qc_daily__ck CHECK (qc_observations >= 0)
);
-- instrument_id: no FK, same rule as test_counts_daily.instrument_id (opaque copy from the event).

-- ===== alerts =====
CREATE TABLE inventory.alerts (
  id uuid NOT NULL, tenant_id uuid NOT NULL, alert_kind text NOT NULL,
  store_id uuid, item_id uuid, lot_id uuid, instrument_id uuid, test_id uuid,
  dedupe_key text NOT NULL, status text NOT NULL DEFAULT 'open',
  first_raised_at timestamptz NOT NULL, last_raised_at timestamptz NOT NULL, occurrences integer NOT NULL DEFAULT 1,
  details jsonb NOT NULL DEFAULT '{}', acknowledged_at timestamptz, acknowledged_by uuid, resolved_at timestamptz, expires_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT alerts__pk PRIMARY KEY (id),
  CONSTRAINT alerts__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT alerts__store__fk FOREIGN KEY (tenant_id, store_id) REFERENCES inventory.stores (tenant_id, id),
  CONSTRAINT alerts__item__fk FOREIGN KEY (tenant_id, item_id) REFERENCES inventory.items (tenant_id, id),
  CONSTRAINT alerts__ck CHECK (alert_kind IN ('below_reorder','expiry_soon','expired_on_hand','open_stability_exceeded','negative_stock',
    'unresolved_consumption','expired_lot_in_use','balance_drift','reconciliation_gap')
    AND status IN ('open','acknowledged','resolved') AND occurrences >= 1 AND char_length(dedupe_key) BETWEEN 1 AND 200
    AND jsonb_typeof(details) = 'object' AND pg_column_size(details) <= 2048
    AND ((status = 'resolved') = (resolved_at IS NOT NULL)))
);
CREATE UNIQUE INDEX alerts__tenant_id_dedupe__p_uq ON inventory.alerts (tenant_id, dedupe_key) WHERE status <> 'resolved';
CREATE INDEX alerts__tenant_id_status_kind__idx ON inventory.alerts (tenant_id, status, alert_kind, last_raised_at DESC);
CREATE INDEX alerts__tenant_id_expires__p_idx ON inventory.alerts (tenant_id, expires_at) WHERE expires_at IS NOT NULL;

-- ===== tenant FKs for every tenant table not shown above (C0 template) =====
-- Each tenant table additionally has CONSTRAINT <t>__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id).

-- ===== alerts purge (SECURITY INVOKER; 08 A17 D-72; CR-C12-008 as amended) =====
CREATE FUNCTION app.purge_inventory_alerts() RETURNS integer
  LANGUAGE sql SECURITY INVOKER SET search_path = '' AS $$
  WITH d AS (
    DELETE FROM inventory.alerts a
    WHERE a.id IN (SELECT x.id FROM inventory.alerts x
                   WHERE x.tenant_id = (SELECT app.current_tenant_id()) AND x.expires_at < now()
                   LIMIT 10000)
    RETURNING 1)
  SELECT count(*)::integer FROM d;
$$;
-- Owner lims_owner (CV §5.9). Called by the per_tenant task inventory.purge_alerts as the inventory system actor;
-- RLS policy alerts__delete__tenant (§4.3) restricts it to the caller's tenant, system actor, expired rows.
-- The task repeats the call while it returns 10000.

-- ===== RLS: §4.1 template on every tenant table (instrument_qc_daily included); §4.3 alerts delete policy; §4.4 grants =====

-- ===================== C0 additions (C0 05-SCHEMA §9 rule 1) =====================
ALTER TABLE inventory.settings ADD CONSTRAINT settings__tenant_id_id__uq UNIQUE (tenant_id, id);
ALTER TABLE inventory.item_packs ADD CONSTRAINT item_packs__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id);
ALTER TABLE inventory.item_barcodes ADD CONSTRAINT item_barcodes__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id);
ALTER TABLE inventory.supplier_items ADD CONSTRAINT supplier_items__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id);
ALTER TABLE inventory.store_item_settings ADD CONSTRAINT store_item_settings__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id);
ALTER TABLE inventory.lots ADD CONSTRAINT lots__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id);
ALTER TABLE inventory.stock_balances ADD CONSTRAINT stock_balances__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id);
ALTER TABLE inventory.consumption_rules ADD CONSTRAINT consumption_rules__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id);
ALTER TABLE inventory.purchase_orders ADD CONSTRAINT purchase_orders__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id);
ALTER TABLE inventory.purchase_order_lines ADD CONSTRAINT purchase_order_lines__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id);
ALTER TABLE inventory.goods_receipts ADD CONSTRAINT goods_receipts__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id);
ALTER TABLE inventory.goods_receipt_lines ADD CONSTRAINT goods_receipt_lines__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id);
ALTER TABLE inventory.transfers ADD CONSTRAINT transfers__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id);
ALTER TABLE inventory.transfer_lines ADD CONSTRAINT transfer_lines__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id);
ALTER TABLE inventory.stock_documents ADD CONSTRAINT stock_documents__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id);
ALTER TABLE inventory.stock_document_lines ADD CONSTRAINT stock_document_lines__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id);
ALTER TABLE inventory.stock_counts ADD CONSTRAINT stock_counts__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id);
ALTER TABLE inventory.stock_count_lines ADD CONSTRAINT stock_count_lines__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id);
ALTER TABLE inventory.opened_containers ADD CONSTRAINT opened_containers__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id);
ALTER TABLE inventory.instrument_bindings ADD CONSTRAINT instrument_bindings__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id);
ALTER TABLE inventory.consumption_facts ADD CONSTRAINT consumption_facts__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id);
ALTER TABLE inventory.stock_movements ADD CONSTRAINT stock_movements__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id);
ALTER TABLE inventory.consumption_daily ADD CONSTRAINT consumption_daily__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id);
ALTER TABLE inventory.consumption_daily ADD CONSTRAINT consumption_daily__tenant_id_id__uq UNIQUE (tenant_id, id);
ALTER TABLE inventory.test_counts_daily ADD CONSTRAINT test_counts_daily__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id);
ALTER TABLE inventory.test_counts_daily ADD CONSTRAINT test_counts_daily__tenant_id_id__uq UNIQUE (tenant_id, id);
ALTER TABLE inventory.alerts ADD CONSTRAINT alerts__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id);

-- ===================== §5 trigger functions (SECURITY INVOKER, search_path = '') =====================
-- inventory.tg_doc_guard: (a) allowed status pairs per header table (§7) -> P0001 invalid_transition; (b) when OLD.status is not
-- the editable state (draft / open / unresolved) only the §7 lifecycle columns may change -> else P0001 immutable_row.
-- A same-status UPDATE is not a transition (§7 last paragraph).
CREATE FUNCTION inventory.tg_doc_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  v_ok boolean; v_editable text; v_life text[];
  v_changed text[];
BEGIN
  CASE TG_TABLE_NAME
    WHEN 'purchase_orders' THEN
      v_editable := 'draft';
      v_ok := (OLD.status, NEW.status) IN (('draft','approved'), ('draft','cancelled'), ('approved','sent'),
        ('approved','partially_received'), ('approved','received'), ('approved','cancelled'), ('sent','partially_received'),
        ('sent','received'), ('sent','cancelled'), ('partially_received','partially_received'), ('partially_received','received'),
        ('partially_received','closed'), ('received','closed'));
      v_life := ARRAY['status','approved_at','approved_by','sent_at','sent_by','sent_channel','sent_reference','cancelled_at',
        'cancelled_by','cancel_reason_code','cancel_reason_text','closed_at','closed_by','close_reason_code','close_reason_text',
        'updated_at','updated_by','version'];
    WHEN 'goods_receipts' THEN
      v_editable := 'draft';
      v_ok := (OLD.status, NEW.status) IN (('draft','posted'), ('draft','cancelled'));
      v_life := ARRAY['status','posted_at','posted_by','cancelled_at','cancelled_by','cancel_reason_text','updated_at','updated_by','version'];
    WHEN 'transfers' THEN
      v_editable := 'draft';
      v_ok := (OLD.status, NEW.status) IN (('draft','dispatched'), ('draft','cancelled'), ('dispatched','received'));
      v_life := ARRAY['status','dispatched_at','dispatched_by','received_at','received_by','cancelled_at','cancelled_by',
        'cancel_reason_text','updated_at','updated_by','version'];
    WHEN 'stock_counts' THEN
      v_editable := 'open';
      v_ok := (OLD.status, NEW.status) IN (('open','posted'), ('open','cancelled'));
      v_life := ARRAY['status','posted_at','posted_by','cancelled_at','cancelled_by','updated_at','updated_by','version'];
    WHEN 'opened_containers' THEN
      v_editable := 'open';
      v_ok := (OLD.status, NEW.status) IN (('open','finished'), ('open','discarded'));
      v_life := ARRAY['status','finished_at','finished_by','discard_document_id','updated_at','updated_by','version'];
    WHEN 'consumption_facts' THEN
      v_editable := 'unresolved';
      v_ok := (OLD.status, NEW.status) IN (('unresolved','posted'), ('unresolved','dismissed'), ('posted','reversed'));
      v_life := ARRAY['status','store_id','rules_applied','value_paisa_total','reason_code','resolved_at','resolved_by',
        'updated_at','updated_by','version'];
    ELSE
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME;
  END CASE;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT coalesce(v_ok, false) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'invalid_transition',
      DETAIL = TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME || ': ' || OLD.status || ' -> ' || coalesce(NEW.status, '<null>');
  END IF;
  IF OLD.status <> v_editable THEN
    SELECT coalesce(array_agg(n.key), '{}') INTO v_changed
      FROM jsonb_each(to_jsonb(NEW)) n
     WHERE n.value IS DISTINCT FROM (to_jsonb(OLD) -> n.key);
    IF NOT (v_changed <@ v_life) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME;
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- inventory.tg_line_guard: soft removal (removed_at / removed_by) only while the parent is draft, never cleared (D-71); a removed line
-- is frozen; otherwise the parent must be in its editable state, except the §5 lifecycle columns while the parent is in the listed
-- states [CONV: transfer lines while 'dispatched', count lines while 'posted' (the posting step may update the header first)].
-- The parent row is read FOR SHARE so a concurrent header transition cannot interleave with the line write.
CREATE FUNCTION inventory.tg_line_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  v_new jsonb := to_jsonb(NEW); v_old jsonb;
  v_status text; v_editable text := 'draft'; v_life text[] := '{}'; v_life_states text[] := '{}';
  v_changed text[];
BEGIN
  CASE TG_TABLE_NAME
    WHEN 'purchase_order_lines' THEN
      SELECT p.status INTO v_status FROM inventory.purchase_orders p
       WHERE p.tenant_id = NEW.tenant_id AND p.id = (v_new ->> 'po_id')::uuid FOR SHARE;
      v_life := ARRAY['received_qty_base','is_closed_short'];
      v_life_states := ARRAY['approved','sent','partially_received'];
    WHEN 'goods_receipt_lines' THEN
      SELECT p.status INTO v_status FROM inventory.goods_receipts p
       WHERE p.tenant_id = NEW.tenant_id AND p.id = (v_new ->> 'grn_id')::uuid FOR SHARE;
    WHEN 'transfer_lines' THEN
      SELECT p.status INTO v_status FROM inventory.transfers p
       WHERE p.tenant_id = NEW.tenant_id AND p.id = (v_new ->> 'transfer_id')::uuid FOR SHARE;
      v_life := ARRAY['received_qty_base','discrepancy_reason_code','dispatched_value_paisa'];
      v_life_states := ARRAY['dispatched'];
    WHEN 'stock_count_lines' THEN
      v_editable := 'open';
      SELECT p.status INTO v_status FROM inventory.stock_counts p
       WHERE p.tenant_id = NEW.tenant_id AND p.id = (v_new ->> 'count_id')::uuid FOR SHARE;
      v_life := ARRAY['book_qty_at_count','variance_qty_base','variance_value_paisa','reason_code'];
      v_life_states := ARRAY['posted'];
    ELSE
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME;
  END CASE;
  -- parent not visible / missing: let the composite FK report it on INSERT; on UPDATE refuse
  IF TG_OP = 'INSERT' THEN
    IF v_status IS NOT NULL AND v_status <> v_editable THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME || ': parent not editable';
    END IF;
    IF (v_new ->> 'removed_at') IS NOT NULL OR (v_new ->> 'removed_by') IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME || ': inserted as removed';
    END IF;
    RETURN NEW;
  END IF;
  v_old := to_jsonb(OLD);
  SELECT coalesce(array_agg(n.key), '{}') INTO v_changed
    FROM jsonb_each(v_new) n
   WHERE n.value IS DISTINCT FROM (v_old -> n.key);
  IF v_changed <@ ARRAY['updated_at','updated_by','version'] THEN
    RETURN NEW;
  END IF;
  IF (v_old ->> 'removed_at') IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME || ': removed line';
  END IF;
  IF v_status IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME || ': parent not found';
  END IF;
  IF v_status = v_editable THEN
    RETURN NEW;
  END IF;
  IF v_status = ANY (v_life_states) AND v_changed <@ (v_life || ARRAY['updated_at','updated_by','version']) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME || ': parent ' || v_status;
END $$;

-- inventory.tg_item_base_uom_lock: the base unit cannot change once the item has a pack, a rule or a movement; a balance row exists for
-- every (store, item, lot) that ever had a movement, so balances stand for the ledger (§5).
CREATE FUNCTION inventory.tg_item_base_uom_lock() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  IF NEW.base_uom_code IS DISTINCT FROM OLD.base_uom_code AND (
       EXISTS (SELECT 1 FROM inventory.item_packs p WHERE p.tenant_id = OLD.tenant_id AND p.item_id = OLD.id)
    OR EXISTS (SELECT 1 FROM inventory.consumption_rules r WHERE r.tenant_id = OLD.tenant_id AND r.item_id = OLD.id)
    OR EXISTS (SELECT 1 FROM inventory.stock_balances b WHERE b.tenant_id = OLD.tenant_id AND b.item_id = OLD.id)) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'inventory.items.base_uom_code';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION inventory.tg_doc_guard(), inventory.tg_line_guard(), inventory.tg_item_base_uom_lock() FROM PUBLIC;   -- trigger functions: no direct EXECUTE


-- ===================== §5 triggers =====================
CREATE TRIGGER item_packs__mutable_columns BEFORE UPDATE ON inventory.item_packs
  FOR EACH ROW EXECUTE FUNCTION app.enforce_mutable_columns('label','uom_code','is_purchase_default','is_active','updated_at','updated_by','version');
CREATE TRIGGER lots__mutable_columns BEFORE UPDATE ON inventory.lots
  FOR EACH ROW EXECUTE FUNCTION app.enforce_mutable_columns('expiry_on','manufactured_on','status','status_reason_code','last_receipt_qty_base','last_receipt_value_paisa','is_active','updated_at','updated_by','version');
CREATE TRIGGER consumption_rules__mutable_columns BEFORE UPDATE ON inventory.consumption_rules
  FOR EACH ROW EXECUTE FUNCTION app.enforce_mutable_columns('effective_to','is_active','notes','updated_at','updated_by','version');
CREATE TRIGGER stock_balances__mutable_columns BEFORE UPDATE ON inventory.stock_balances
  FOR EACH ROW EXECUTE FUNCTION app.enforce_mutable_columns('qty_base','value_paisa','last_movement_at','updated_at','updated_by','version');
CREATE TRIGGER purchase_orders__doc_guard BEFORE UPDATE ON inventory.purchase_orders FOR EACH ROW EXECUTE FUNCTION inventory.tg_doc_guard();
CREATE TRIGGER goods_receipts__doc_guard BEFORE UPDATE ON inventory.goods_receipts FOR EACH ROW EXECUTE FUNCTION inventory.tg_doc_guard();
CREATE TRIGGER transfers__doc_guard BEFORE UPDATE ON inventory.transfers FOR EACH ROW EXECUTE FUNCTION inventory.tg_doc_guard();
CREATE TRIGGER stock_counts__doc_guard BEFORE UPDATE ON inventory.stock_counts FOR EACH ROW EXECUTE FUNCTION inventory.tg_doc_guard();
CREATE TRIGGER opened_containers__doc_guard BEFORE UPDATE ON inventory.opened_containers FOR EACH ROW EXECUTE FUNCTION inventory.tg_doc_guard();
CREATE TRIGGER consumption_facts__doc_guard BEFORE UPDATE ON inventory.consumption_facts FOR EACH ROW EXECUTE FUNCTION inventory.tg_doc_guard();
CREATE TRIGGER purchase_order_lines__line_guard BEFORE INSERT OR UPDATE ON inventory.purchase_order_lines FOR EACH ROW EXECUTE FUNCTION inventory.tg_line_guard();
CREATE TRIGGER goods_receipt_lines__line_guard BEFORE INSERT OR UPDATE ON inventory.goods_receipt_lines FOR EACH ROW EXECUTE FUNCTION inventory.tg_line_guard();
CREATE TRIGGER transfer_lines__line_guard BEFORE INSERT OR UPDATE ON inventory.transfer_lines FOR EACH ROW EXECUTE FUNCTION inventory.tg_line_guard();
CREATE TRIGGER stock_count_lines__line_guard BEFORE INSERT OR UPDATE ON inventory.stock_count_lines FOR EACH ROW EXECUTE FUNCTION inventory.tg_line_guard();
CREATE TRIGGER items__base_uom_lock BEFORE UPDATE OF base_uom_code ON inventory.items FOR EACH ROW EXECUTE FUNCTION inventory.tg_item_base_uom_lock();

-- ===================== row audit (04 D11; §5: M + C tables, not the ledger, documents, projections; counters and class E alerts not audited [CONV]) =====================
CREATE TRIGGER cs_reasons__audit AFTER INSERT OR UPDATE OR DELETE ON inventory.cs_reasons FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER cs_tax_codes__audit AFTER INSERT OR UPDATE OR DELETE ON inventory.cs_tax_codes FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER stores__audit AFTER INSERT OR UPDATE OR DELETE ON inventory.stores FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER settings__audit AFTER INSERT OR UPDATE OR DELETE ON inventory.settings FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER items__audit AFTER INSERT OR UPDATE OR DELETE ON inventory.items FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER item_packs__audit AFTER INSERT OR UPDATE OR DELETE ON inventory.item_packs FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER item_barcodes__audit AFTER INSERT OR UPDATE OR DELETE ON inventory.item_barcodes FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER suppliers__audit AFTER INSERT OR UPDATE OR DELETE ON inventory.suppliers FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER supplier_items__audit AFTER INSERT OR UPDATE OR DELETE ON inventory.supplier_items FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER store_item_settings__audit AFTER INSERT OR UPDATE OR DELETE ON inventory.store_item_settings FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER lots__audit AFTER INSERT OR UPDATE OR DELETE ON inventory.lots FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER consumption_rules__audit AFTER INSERT OR UPDATE OR DELETE ON inventory.consumption_rules FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER purchase_orders__audit AFTER INSERT OR UPDATE OR DELETE ON inventory.purchase_orders FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER purchase_order_lines__audit AFTER INSERT OR UPDATE OR DELETE ON inventory.purchase_order_lines FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER goods_receipts__audit AFTER INSERT OR UPDATE OR DELETE ON inventory.goods_receipts FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER goods_receipt_lines__audit AFTER INSERT OR UPDATE OR DELETE ON inventory.goods_receipt_lines FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER transfers__audit AFTER INSERT OR UPDATE OR DELETE ON inventory.transfers FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER transfer_lines__audit AFTER INSERT OR UPDATE OR DELETE ON inventory.transfer_lines FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER stock_counts__audit AFTER INSERT OR UPDATE OR DELETE ON inventory.stock_counts FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER stock_count_lines__audit AFTER INSERT OR UPDATE OR DELETE ON inventory.stock_count_lines FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER opened_containers__audit AFTER INSERT OR UPDATE OR DELETE ON inventory.opened_containers FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER instrument_bindings__audit AFTER INSERT OR UPDATE OR DELETE ON inventory.instrument_bindings FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER consumption_facts__audit AFTER INSERT OR UPDATE OR DELETE ON inventory.consumption_facts FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();

-- ===================== RLS (§4.1 template, literal) =====================
ALTER TABLE inventory.cs_reasons ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory.cs_reasons FORCE ROW LEVEL SECURITY;
ALTER TABLE inventory.cs_tax_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory.cs_tax_codes FORCE ROW LEVEL SECURITY;
ALTER TABLE inventory.stores ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory.stores FORCE ROW LEVEL SECURITY;
ALTER TABLE inventory.settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory.settings FORCE ROW LEVEL SECURITY;
ALTER TABLE inventory.number_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory.number_counters FORCE ROW LEVEL SECURITY;
ALTER TABLE inventory.items ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory.items FORCE ROW LEVEL SECURITY;
ALTER TABLE inventory.item_packs ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory.item_packs FORCE ROW LEVEL SECURITY;
ALTER TABLE inventory.item_barcodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory.item_barcodes FORCE ROW LEVEL SECURITY;
ALTER TABLE inventory.suppliers ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory.suppliers FORCE ROW LEVEL SECURITY;
ALTER TABLE inventory.supplier_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory.supplier_items FORCE ROW LEVEL SECURITY;
ALTER TABLE inventory.store_item_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory.store_item_settings FORCE ROW LEVEL SECURITY;
ALTER TABLE inventory.lots ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory.lots FORCE ROW LEVEL SECURITY;
ALTER TABLE inventory.stock_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory.stock_balances FORCE ROW LEVEL SECURITY;
ALTER TABLE inventory.consumption_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory.consumption_rules FORCE ROW LEVEL SECURITY;
ALTER TABLE inventory.purchase_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory.purchase_orders FORCE ROW LEVEL SECURITY;
ALTER TABLE inventory.purchase_order_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory.purchase_order_lines FORCE ROW LEVEL SECURITY;
ALTER TABLE inventory.goods_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory.goods_receipts FORCE ROW LEVEL SECURITY;
ALTER TABLE inventory.goods_receipt_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory.goods_receipt_lines FORCE ROW LEVEL SECURITY;
ALTER TABLE inventory.transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory.transfers FORCE ROW LEVEL SECURITY;
ALTER TABLE inventory.transfer_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory.transfer_lines FORCE ROW LEVEL SECURITY;
ALTER TABLE inventory.stock_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory.stock_documents FORCE ROW LEVEL SECURITY;
ALTER TABLE inventory.stock_document_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory.stock_document_lines FORCE ROW LEVEL SECURITY;
ALTER TABLE inventory.stock_counts ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory.stock_counts FORCE ROW LEVEL SECURITY;
ALTER TABLE inventory.stock_count_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory.stock_count_lines FORCE ROW LEVEL SECURITY;
ALTER TABLE inventory.opened_containers ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory.opened_containers FORCE ROW LEVEL SECURITY;
ALTER TABLE inventory.instrument_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory.instrument_bindings FORCE ROW LEVEL SECURITY;
ALTER TABLE inventory.consumption_facts ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory.consumption_facts FORCE ROW LEVEL SECURITY;
ALTER TABLE inventory.stock_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory.stock_movements FORCE ROW LEVEL SECURITY;
ALTER TABLE inventory.consumption_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory.consumption_daily FORCE ROW LEVEL SECURITY;
ALTER TABLE inventory.test_counts_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory.test_counts_daily FORCE ROW LEVEL SECURITY;
ALTER TABLE inventory.instrument_qc_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory.instrument_qc_daily FORCE ROW LEVEL SECURITY;
ALTER TABLE inventory.alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory.alerts FORCE ROW LEVEL SECURITY;

-- ===================== policies (§4.1 x 32 tables; no UPDATE on the 3 A tables; §4.3 alerts DELETE) =====================
CREATE POLICY cs_reasons__select__tenant ON inventory.cs_reasons FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY cs_reasons__insert__tenant ON inventory.cs_reasons FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY cs_reasons__update__tenant ON inventory.cs_reasons FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY cs_tax_codes__select__tenant ON inventory.cs_tax_codes FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY cs_tax_codes__insert__tenant ON inventory.cs_tax_codes FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY cs_tax_codes__update__tenant ON inventory.cs_tax_codes FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY stores__select__tenant ON inventory.stores FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY stores__insert__tenant ON inventory.stores FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY stores__update__tenant ON inventory.stores FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY settings__select__tenant ON inventory.settings FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY settings__insert__tenant ON inventory.settings FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY settings__update__tenant ON inventory.settings FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY number_counters__select__tenant ON inventory.number_counters FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY number_counters__insert__tenant ON inventory.number_counters FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY number_counters__update__tenant ON inventory.number_counters FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY items__select__tenant ON inventory.items FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY items__insert__tenant ON inventory.items FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY items__update__tenant ON inventory.items FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY item_packs__select__tenant ON inventory.item_packs FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY item_packs__insert__tenant ON inventory.item_packs FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY item_packs__update__tenant ON inventory.item_packs FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY item_barcodes__select__tenant ON inventory.item_barcodes FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY item_barcodes__insert__tenant ON inventory.item_barcodes FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY item_barcodes__update__tenant ON inventory.item_barcodes FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY suppliers__select__tenant ON inventory.suppliers FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY suppliers__insert__tenant ON inventory.suppliers FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY suppliers__update__tenant ON inventory.suppliers FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY supplier_items__select__tenant ON inventory.supplier_items FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY supplier_items__insert__tenant ON inventory.supplier_items FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY supplier_items__update__tenant ON inventory.supplier_items FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY store_item_settings__select__tenant ON inventory.store_item_settings FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY store_item_settings__insert__tenant ON inventory.store_item_settings FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY store_item_settings__update__tenant ON inventory.store_item_settings FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY lots__select__tenant ON inventory.lots FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY lots__insert__tenant ON inventory.lots FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY lots__update__tenant ON inventory.lots FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY stock_balances__select__tenant ON inventory.stock_balances FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY stock_balances__insert__tenant ON inventory.stock_balances FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY stock_balances__update__tenant ON inventory.stock_balances FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY consumption_rules__select__tenant ON inventory.consumption_rules FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY consumption_rules__insert__tenant ON inventory.consumption_rules FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY consumption_rules__update__tenant ON inventory.consumption_rules FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY purchase_orders__select__tenant ON inventory.purchase_orders FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY purchase_orders__insert__tenant ON inventory.purchase_orders FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY purchase_orders__update__tenant ON inventory.purchase_orders FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY purchase_order_lines__select__tenant ON inventory.purchase_order_lines FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY purchase_order_lines__insert__tenant ON inventory.purchase_order_lines FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY purchase_order_lines__update__tenant ON inventory.purchase_order_lines FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY goods_receipts__select__tenant ON inventory.goods_receipts FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY goods_receipts__insert__tenant ON inventory.goods_receipts FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY goods_receipts__update__tenant ON inventory.goods_receipts FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY goods_receipt_lines__select__tenant ON inventory.goods_receipt_lines FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY goods_receipt_lines__insert__tenant ON inventory.goods_receipt_lines FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY goods_receipt_lines__update__tenant ON inventory.goods_receipt_lines FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY transfers__select__tenant ON inventory.transfers FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY transfers__insert__tenant ON inventory.transfers FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY transfers__update__tenant ON inventory.transfers FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY transfer_lines__select__tenant ON inventory.transfer_lines FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY transfer_lines__insert__tenant ON inventory.transfer_lines FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY transfer_lines__update__tenant ON inventory.transfer_lines FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY stock_documents__select__tenant ON inventory.stock_documents FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY stock_documents__insert__tenant ON inventory.stock_documents FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY stock_document_lines__select__tenant ON inventory.stock_document_lines FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY stock_document_lines__insert__tenant ON inventory.stock_document_lines FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY stock_counts__select__tenant ON inventory.stock_counts FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY stock_counts__insert__tenant ON inventory.stock_counts FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY stock_counts__update__tenant ON inventory.stock_counts FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY stock_count_lines__select__tenant ON inventory.stock_count_lines FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY stock_count_lines__insert__tenant ON inventory.stock_count_lines FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY stock_count_lines__update__tenant ON inventory.stock_count_lines FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY opened_containers__select__tenant ON inventory.opened_containers FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY opened_containers__insert__tenant ON inventory.opened_containers FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY opened_containers__update__tenant ON inventory.opened_containers FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY instrument_bindings__select__tenant ON inventory.instrument_bindings FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY instrument_bindings__insert__tenant ON inventory.instrument_bindings FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY instrument_bindings__update__tenant ON inventory.instrument_bindings FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY consumption_facts__select__tenant ON inventory.consumption_facts FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY consumption_facts__insert__tenant ON inventory.consumption_facts FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY consumption_facts__update__tenant ON inventory.consumption_facts FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY stock_movements__select__tenant ON inventory.stock_movements FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY stock_movements__insert__tenant ON inventory.stock_movements FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY consumption_daily__select__tenant ON inventory.consumption_daily FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY consumption_daily__insert__tenant ON inventory.consumption_daily FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY consumption_daily__update__tenant ON inventory.consumption_daily FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY test_counts_daily__select__tenant ON inventory.test_counts_daily FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY test_counts_daily__insert__tenant ON inventory.test_counts_daily FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY test_counts_daily__update__tenant ON inventory.test_counts_daily FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY instrument_qc_daily__select__tenant ON inventory.instrument_qc_daily FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY instrument_qc_daily__insert__tenant ON inventory.instrument_qc_daily FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY instrument_qc_daily__update__tenant ON inventory.instrument_qc_daily FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY alerts__select__tenant ON inventory.alerts FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY alerts__insert__tenant ON inventory.alerts FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY alerts__update__tenant ON inventory.alerts FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY alerts__delete__tenant ON inventory.alerts FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system' AND expires_at < now());

-- ===================== grants (§4.4 verbatim) =====================
GRANT SELECT, INSERT, UPDATE ON inventory.cs_reasons, inventory.cs_tax_codes, inventory.settings, inventory.number_counters,
  inventory.items, inventory.item_packs, inventory.item_barcodes, inventory.stores, inventory.store_item_settings,
  inventory.suppliers, inventory.supplier_items, inventory.lots, inventory.stock_balances,
  inventory.purchase_orders, inventory.goods_receipts, inventory.transfers, inventory.stock_counts, inventory.stock_count_lines,
  inventory.opened_containers, inventory.instrument_bindings, inventory.consumption_rules, inventory.consumption_facts,
  inventory.consumption_daily, inventory.test_counts_daily, inventory.instrument_qc_daily, inventory.alerts,
  inventory.purchase_order_lines, inventory.goods_receipt_lines, inventory.transfer_lines TO lims_app;
GRANT DELETE ON inventory.alerts TO lims_app;   -- class E only (P-18(c), D-72)
GRANT EXECUTE ON FUNCTION app.purge_inventory_alerts() TO lims_app;
GRANT SELECT, INSERT ON inventory.stock_movements, inventory.stock_documents, inventory.stock_document_lines TO lims_app;
GRANT SELECT ON inventory.g_cs_uom, inventory.g_cs_reasons, inventory.g_cs_tax_codes TO lims_app;
-- event_inbox grants are C0's (05-SCHEMA §3 of C0).

-- ===================== §6 global coded sets (seed; fixed UUIDv7-shaped ids, sort_order 10.. [CONV]) =====================
INSERT INTO inventory.g_cs_uom (id, code, display, uom_kind, sort_order) VALUES
  ('019a0000-c012-7000-8001-000000001001', 'test', 'test', 'count', 10),
  ('019a0000-c012-7000-8001-000000001002', 'ml', 'mL', 'volume', 20),
  ('019a0000-c012-7000-8001-000000001003', 'ul', 'µL', 'volume', 30),
  ('019a0000-c012-7000-8001-000000001004', 'l', 'L', 'volume', 40),
  ('019a0000-c012-7000-8001-000000001005', 'g', 'g', 'mass', 50),
  ('019a0000-c012-7000-8001-000000001006', 'mg', 'mg', 'mass', 60),
  ('019a0000-c012-7000-8001-000000001007', 'piece', 'piece', 'count', 70),
  ('019a0000-c012-7000-8001-000000001008', 'vial', 'vial', 'count', 80),
  ('019a0000-c012-7000-8001-000000001009', 'bottle', 'bottle', 'count', 90),
  ('019a0000-c012-7000-8001-000000001010', 'kit', 'kit', 'count', 100),
  ('019a0000-c012-7000-8001-000000001011', 'box', 'box', 'count', 110),
  ('019a0000-c012-7000-8001-000000001012', 'pack', 'pack', 'count', 120),
  ('019a0000-c012-7000-8001-000000001013', 'strip', 'strip', 'count', 130),
  ('019a0000-c012-7000-8001-000000001014', 'cartridge', 'cartridge', 'count', 140),
  ('019a0000-c012-7000-8001-000000001015', 'slide', 'slide', 'count', 150),
  ('019a0000-c012-7000-8001-000000001016', 'tube', 'tube', 'count', 160),
  ('019a0000-c012-7000-8001-000000001017', 'roll', 'roll', 'count', 170),
  ('019a0000-c012-7000-8001-000000001018', 'pair', 'pair', 'count', 180),
  ('019a0000-c012-7000-8001-000000001019', 'sheet', 'sheet', 'count', 190)
ON CONFLICT (code) DO NOTHING;
-- reason displays: sentence case of the §6.2 code [CONV]
INSERT INTO inventory.g_cs_reasons (id, reason_group, code, display, sort_order) VALUES
  ('019a0000-c012-7000-8001-000000002001', 'wastage', 'spillage', 'Spillage', 10),
  ('019a0000-c012-7000-8001-000000002002', 'wastage', 'damaged', 'Damaged', 20),
  ('019a0000-c012-7000-8001-000000002003', 'wastage', 'contaminated', 'Contaminated', 30),
  ('019a0000-c012-7000-8001-000000002004', 'wastage', 'temperature_excursion', 'Temperature excursion', 40),
  ('019a0000-c012-7000-8001-000000002005', 'wastage', 'open_stability_exceeded', 'Open stability exceeded', 50),
  ('019a0000-c012-7000-8001-000000002006', 'wastage', 'transit_loss', 'Transit loss', 60),
  ('019a0000-c012-7000-8001-000000002007', 'wastage', 'instrument_failure', 'Instrument failure', 70),
  ('019a0000-c012-7000-8001-000000002008', 'wastage', 'training_or_test_run', 'Training or test run', 80),
  ('019a0000-c012-7000-8001-000000002009', 'wastage', 'other', 'Other', 90),
  ('019a0000-c012-7000-8001-000000002010', 'adjustment', 'opening_correction', 'Opening correction', 100),
  ('019a0000-c012-7000-8001-000000002011', 'adjustment', 'found_stock', 'Found stock', 110),
  ('019a0000-c012-7000-8001-000000002012', 'adjustment', 'data_entry_error', 'Data entry error', 120),
  ('019a0000-c012-7000-8001-000000002013', 'adjustment', 'unlotted_reconciliation', 'Unlotted reconciliation', 130),
  ('019a0000-c012-7000-8001-000000002014', 'adjustment', 'other', 'Other', 140),
  ('019a0000-c012-7000-8001-000000002015', 'supplier_return', 'damaged_on_arrival', 'Damaged on arrival', 150),
  ('019a0000-c012-7000-8001-000000002016', 'supplier_return', 'wrong_item', 'Wrong item', 160),
  ('019a0000-c012-7000-8001-000000002017', 'supplier_return', 'short_expiry', 'Short expiry', 170),
  ('019a0000-c012-7000-8001-000000002018', 'supplier_return', 'recall', 'Recall', 180),
  ('019a0000-c012-7000-8001-000000002019', 'supplier_return', 'other', 'Other', 190),
  ('019a0000-c012-7000-8001-000000002020', 'po_cancel', 'no_longer_needed', 'No longer needed', 200),
  ('019a0000-c012-7000-8001-000000002021', 'po_cancel', 'supplier_unavailable', 'Supplier unavailable', 210),
  ('019a0000-c012-7000-8001-000000002022', 'po_cancel', 'price_changed', 'Price changed', 220),
  ('019a0000-c012-7000-8001-000000002023', 'po_cancel', 'duplicate', 'Duplicate', 230),
  ('019a0000-c012-7000-8001-000000002024', 'po_cancel', 'other', 'Other', 240),
  ('019a0000-c012-7000-8001-000000002025', 'po_close', 'short_supply', 'Short supply', 250),
  ('019a0000-c012-7000-8001-000000002026', 'po_close', 'item_discontinued', 'Item discontinued', 260),
  ('019a0000-c012-7000-8001-000000002027', 'po_close', 'no_longer_needed', 'No longer needed', 270),
  ('019a0000-c012-7000-8001-000000002028', 'po_close', 'other', 'Other', 280),
  ('019a0000-c012-7000-8001-000000002029', 'transfer_discrepancy', 'transit_loss', 'Transit loss', 290),
  ('019a0000-c012-7000-8001-000000002030', 'transfer_discrepancy', 'damaged_in_transit', 'Damaged in transit', 300),
  ('019a0000-c012-7000-8001-000000002031', 'transfer_discrepancy', 'count_error', 'Count error', 310),
  ('019a0000-c012-7000-8001-000000002032', 'transfer_discrepancy', 'other', 'Other', 320),
  ('019a0000-c012-7000-8001-000000002033', 'fact_dismiss', 'not_consumed', 'Not consumed', 330),
  ('019a0000-c012-7000-8001-000000002034', 'fact_dismiss', 'duplicate_entry', 'Duplicate entry', 340),
  ('019a0000-c012-7000-8001-000000002035', 'fact_dismiss', 'test_instrument', 'Test instrument', 350),
  ('019a0000-c012-7000-8001-000000002036', 'fact_dismiss', 'other', 'Other', 360),
  ('019a0000-c012-7000-8001-000000002037', 'fact_reverse', 'logged_in_error', 'Logged in error', 370),
  ('019a0000-c012-7000-8001-000000002038', 'fact_reverse', 'wrong_instrument', 'Wrong instrument', 380),
  ('019a0000-c012-7000-8001-000000002039', 'fact_reverse', 'wrong_test', 'Wrong test', 390),
  ('019a0000-c012-7000-8001-000000002040', 'fact_reverse', 'other', 'Other', 400),
  ('019a0000-c012-7000-8001-000000002041', 'lot_status', 'pending_acceptance', 'Pending acceptance', 410),
  ('019a0000-c012-7000-8001-000000002042', 'lot_status', 'recall', 'Recall', 420),
  ('019a0000-c012-7000-8001-000000002043', 'lot_status', 'failed_acceptance', 'Failed acceptance', 430),
  ('019a0000-c012-7000-8001-000000002044', 'lot_status', 'other', 'Other', 440),
  ('019a0000-c012-7000-8001-000000002045', 'calibration', 'scheduled', 'Scheduled', 450),
  ('019a0000-c012-7000-8001-000000002046', 'calibration', 'new_reagent_lot', 'New reagent lot', 460),
  ('019a0000-c012-7000-8001-000000002047', 'calibration', 'qc_failure', 'Qc failure', 470),
  ('019a0000-c012-7000-8001-000000002048', 'calibration', 'after_maintenance', 'After maintenance', 480),
  ('019a0000-c012-7000-8001-000000002049', 'calibration', 'other', 'Other', 490),
  ('019a0000-c012-7000-8001-000000002050', 'count_variance', 'count_variance', 'Count variance', 500)
ON CONFLICT (reason_group, code) DO NOTHING;
INSERT INTO inventory.g_cs_tax_codes (id, code, display) VALUES
  ('019a0000-c012-7000-8001-000000003001', 'VAT', 'VAT')
ON CONFLICT (code) DO NOTHING;
