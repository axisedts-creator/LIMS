# C12 Inventory — 05 Schema (`inventory`)

Status: DECISION, 2026-11-06. This document specifies the DDL that C0-0B implements for the `inventory` schema (CM §0, §3). C12 never edits `db/`.

Conventions (CV §5):
- table classes M/C/A/E/G (CV §5.2);
- mandatory columns (CV §5.3);
- composite `(tenant_id, id)` FKs (04 D8);
- no ENUM types (CV §5.5);
- `tenant_id` leads every index and unique constraint (REQ-SEC-023);
- RLS template (CV §5.8);
- naming (CV §3).

Cross-schema FKs follow CM §5 R3: `inventory` is a Wave-2 schema and may reference `core`, `catalog` and `instruments` (all upstream). Nothing references `inventory`. No FK points into `billing` (CV §5.4).

Quantities are `numeric(18,6)` in the item's base unit and travel on the wire as `DecimalString` (IC §2.1). Money is `bigint` paisa (CV §4.9).

---

## 1. Table inventory

| # | Table | Class | Centre/branch scoped? | Purpose |
|---|---|---|---|---|
| 1 | `inventory.g_cs_uom` | G | — | global units of measure |
| 2 | `inventory.g_cs_reasons` | G | — | global reason codes by group |
| 3 | `inventory.cs_reasons` | M | tenant | tenant reason codes (shadow global by group+code) |
| 4 | `inventory.g_cs_tax_codes` | G | — | global purchase tax codes (code + display only; rates from C3 via `CatalogPort.getTaxRate`, 08 A2.2) |
| 5 | `inventory.cs_tax_codes` | M | tenant | tenant purchase tax codes |
| 6 | `inventory.settings` | M | tenant (one row) | module settings |
| 7 | `inventory.number_counters` | counter (like `billing.fiscal_counters`, IC §9.1) | tenant | human number counters (gaps allowed) |
| 8 | `inventory.items` | M | tenant | item master |
| 9 | `inventory.item_packs` | M | tenant | pack conversions |
| 10 | `inventory.item_barcodes` | M | tenant | scan values → item/pack |
| 11 | `inventory.stores` | M | branch (app-enforced) | stores per branch |
| 12 | `inventory.store_item_settings` | M | branch (via store) | reorder levels etc. |
| 13 | `inventory.suppliers` | M | tenant | supplier master |
| 14 | `inventory.supplier_items` | M | tenant | supplier prices/lead time per item pack |
| 15 | `inventory.lots` | M | tenant | lot master per item |
| 16 | `inventory.stock_balances` | M (projection) | branch (via store) | current qty/value per store × item × lot |
| 17 | `inventory.stock_movements` | A | branch (via store) | append-only ledger |
| 18 | `inventory.purchase_orders` | C (document) | branch | PO header |
| 19 | `inventory.purchase_order_lines` | C (document lines; soft-removed in draft, D-71) | branch (via header) | PO lines |
| 20 | `inventory.goods_receipts` | C | branch (via store) | GRN header |
| 21 | `inventory.goods_receipt_lines` | C (soft-removed in draft, D-71) | via header | GRN lines with lot capture |
| 22 | `inventory.transfers` | C | two branches | transfer header |
| 23 | `inventory.transfer_lines` | C (soft-removed in draft, D-71) | via header | transfer lines |
| 24 | `inventory.stock_documents` | A | branch (via store) | posted issue / return / supplier return / wastage / adjustment / expiry write-off |
| 25 | `inventory.stock_document_lines` | A | via header | lines |
| 26 | `inventory.stock_counts` | C | branch (via store) | stock count header |
| 27 | `inventory.stock_count_lines` | C | via header | count lines |
| 28 | `inventory.opened_containers` | C | branch (via store) | opened container / in-use lot |
| 29 | `inventory.instrument_bindings` | M | branch (via store) | instrument → consumption store |
| 30 | `inventory.consumption_rules` | M (versioned by supersede) | tenant | consumption models |
| 31 | `inventory.consumption_facts` | C | tenant | one row per consumption trigger (dedupe, status) |
| 32 | `inventory.consumption_daily` | M (projection) | branch (via store) | daily consumption aggregate |
| 33 | `inventory.test_counts_daily` | M (projection) | tenant | daily test counts per instrument × test |
| 34 | `inventory.alerts` | E | tenant/branch | alert state |
| 35 | `inventory.event_inbox` | A | tenant | consumer dedupe (C0 platform table, IC §12; already created by C0 05-SCHEMA §3) |
| 36 | `inventory.instrument_qc_daily` | counter (M projection, P-18(b) exception) | tenant | daily QC observations per instrument for reconciliation (08 A17 D-74) |

"Document" C class here means "state transitions only; content frozen after leaving draft/open; never deleted". These are not clinical records, but the C semantics (CV §5.2) are the right fit. Lines of draft documents are **never deleted** (08 A17 D-71, P-18(a)): a line removed from a draft gets `removed_at`/`removed_by` (allowed only while the header is `draft`), line uniques are partial `WHERE removed_at IS NULL`, and reads filter `removed_at IS NULL`. The class stays C with no CV exception. The only DELETE grant in the schema is on `alerts` (class E), used by the per-tenant system purge (§4.3, 08 A17 D-72).

**Mandatory-column exceptions** (08 A17 P-18(b); copied to `db/meta/tables.yaml`):
- `number_counters` — one row per (tenant, series, period); natural key = PK `(tenant_id, series, period_key)`; no `id`, `version`, `is_active`, `created_*`, `updated_by` (users never edit it; it never expires). Created lazily on first allocation (P-22).
- `instrument_qc_daily` — one counter row per (tenant, business_date, instrument); natural key = PK `(tenant_id, business_date, instrument_id)`; no `id`, `version`, `is_active`, `expires_at` (users never edit it; kept with the other projections, §11). Created on first use (P-22).

Centre scoping: inventory rows hold no PHI (all P0/P1, §3). Every table uses the `__tenant` RLS variant. Branch scope is enforced in the application through `IdentityPort.assertRole({ branchId })` and branch-filtered queries (DECISION D-SCOPE, `07-SECURITY.md` §2). CV §5.8 leaves the scoping choice to the chunk ("chunk decides with C2's membership model").

---

## 2. Columns

Mandatory columns are listed once per class and not repeated:
- **M** = `id uuid NOT NULL, tenant_id uuid NOT NULL, version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL`
- **C** = M without `is_active` (documents carry `status`)
- **A** = `id, tenant_id, created_at, created_by`
- **E** = `id, tenant_id, created_at, created_by, expires_at`

The full DDL is in §8. These tables state meaning, the PHI class (IC §1: P0 none · P1 pseudonymous ids · P2 identifiers/personal · P3 health) and constraints.

### 2.1 `g_cs_uom` (G)
| Column | Type | Null | Notes |
|---|---|---|---|
| id | uuid | no | fixed seed ids |
| code | text | no | `^[a-z][a-z0-9_]{0,31}$`, unique |
| display | text | no | ≤ 32 |
| uom_kind | text | no | `count`, `volume`, `mass`, `other` |
| sort_order | integer | no | default 100 |
| is_active | boolean | no | |
| created_at | timestamptz | no | |

### 2.2 `g_cs_reasons` (G) / `cs_reasons` (M)
`reason_group` ∈ `wastage`, `adjustment`, `supplier_return`, `po_cancel`, `po_close`, `transfer_discrepancy`, `fact_dismiss`, `fact_reverse`, `lot_status`, `calibration`, `count_variance`. Columns `code` (`^[a-z][a-z0-9_]{0,31}$`), `display` (≤ 80), `sort_order`, `is_active`, `system` (default `lims`), `system_version` (default `1`). Unique `(reason_group, code)` (global), `(tenant_id, reason_group, code)` (tenant). A tenant row shadows the global row with the same group+code (CV §5.5). P0.

### 2.3 `g_cs_tax_codes` (G) / `cs_tax_codes` (M)
`code` (C3 tax-code value, `^[A-Z0-9_]{1,16}$`, e.g. `VAT`; 08 A5.6), `display` (≤ 80), `is_active`. Seeds are listed in §6. P0. These tables hold C3 tax-code values plus C12's purchase treatment only (08 A5.6); a code with no C3 rate → `catalog.tax_config_missing`. Exemption is not a code: an exempt line has `tax_code` NULL (08 A4.1). **No rate column** (08 R18, A2.2, CR-C12-010): rates are C3 tax-rule data read through `CatalogPort.getTaxRate(ctx, {taxCode, on})`; C12 keeps only the tax code per item (`items.default_tax_code`) and per supplier item (`supplier_items.default_tax_code`), and `settings.vat_in_cost`. The PO/GRN line column `tax_rate_bp` is the per-document snapshot of the value returned by the port (02-TRD §4.2).

### 2.4 `settings` (M, one row per tenant)
| Column | Type | Default | Notes |
|---|---|---|---|
| consumption_enabled_at | timestamptz | NULL | NULL = automatic consumption off; events with occurrence time < value are ignored |
| vat_in_cost | boolean | true | BLOCKED B7 default |
| po_self_approval_allowed | boolean | false | |
| grn_without_po_allowed | boolean | true | |
| over_receipt_tolerance_bp | integer | 0 | 0–5000 |
| expiry_alert_days | integer | 30 | 1–365 [CONV] |
| default_consumption_store_id | uuid | NULL | FK stores |
| count_locks_store | boolean | false | |
| per_day_requires_activity | boolean | true | |
| reconciliation_gap_alert_bp | integer | 200 | 0–10000 (200 = 2 %) [CONV] |
| backdate_max_days | integer | 7 | 0–31 [CONV] — manual movements/logs |
| po_no_pattern | text | `PO{yy}{seq:6}` | tokens per IC §9.3 |
| grn_no_pattern | text | `GR{yy}{seq:6}` | |
| transfer_no_pattern | text | `TR{yy}{seq:6}` | |
| count_no_pattern | text | `SC{yy}{seq:5}` | |
| doc_no_pattern | text | `SD{yy}{seq:6}` | stock documents |

Unique `(tenant_id)`. The row is created lazily on first use in any path (first `GET/PUT /settings`, first consumer run, first cron run) with `INSERT … ON CONFLICT (tenant_id) DO NOTHING` and the defaults above; a read that finds no row uses the defaults (08 A17 P-22). No provisioning hook.

### 2.5 `number_counters`
`tenant_id`, `series` (`po`, `grn`, `transfer`, `count`, `doc`), `period_key` text (`yy:26`, `fy:2082/83`, or `all`, derived from the tokens in the pattern), `next_value bigint` (≥ 1), `updated_at`. PK `(tenant_id, series, period_key)`. Allocation: `UPDATE … SET next_value = next_value + 1 RETURNING next_value - 1`, with `INSERT … ON CONFLICT DO NOTHING` first. **Gaps allowed** (these are not fiscal numbers; IC §9.3 registry addition CR-C12-007).

### 2.6 `items` (M)
| Column | Type | Null | Notes / constraint |
|---|---|---|---|
| item_code | text | no | `^[A-Z0-9][A-Z0-9_.\-]{0,31}$`; unique `(tenant_id, item_code)` |
| name | text | no | 1–200 |
| category | text | no | `reagent`, `kit`, `consumable`, `control`, `calibrator`, `other` |
| base_uom_code | text | no | FK `g_cs_uom(code)`; immutable once any movement/rule/pack exists (service check + trigger §5) |
| manufacturer | text | yes | ≤ 120 |
| catalogue_no | text | yes | ≤ 64 |
| storage_condition | text | yes | `ambient`, `refrigerated`, `frozen`, `other` [CONV labels; no temperature facts asserted] |
| is_lot_tracked | boolean | no | default true |
| requires_expiry | boolean | no | default true; CHECK `NOT requires_expiry OR is_lot_tracked` |
| open_stability_days | integer | yes | 1–3650 |
| container_qty_base | numeric(18,6) | yes | > 0; size of one container (bottle/cartridge) in base units |
| hs_code | text | yes | `^[0-9]{4,10}$` — stored only (04 L10 applicability UNVERIFIED) |
| default_tax_code | text | yes | code in tax codes (`^[A-Z0-9_]{1,16}$`, 08 A5.6) |
| notes | text | yes | ≤ 1000 |

### 2.7 `item_packs` (M)
`item_id` (FK items), `pack_code` (`^[A-Z0-9_]{1,16}$`, unique per item), `label` (≤ 60), `uom_code` (FK g_cs_uom — the pack's own display unit, e.g. `box`), `qty_in_base numeric(18,6)` (> 0, immutable — trigger), `is_purchase_default boolean` (at most one per item: partial unique). Unique `(tenant_id, id, item_id)` = parent of composite FKs, so a line's pack always belongs to the line's item.

### 2.8 `item_barcodes` (M)
`item_id`, `pack_id` (nullable; composite FK `(tenant_id, pack_id, item_id)`), `barcode_value` (`^[\x21-\x7E]{1,64}$`, stored upper-cased: the server upper-cases it before insert and before lookup, `02-TRD.md` #8/#10; the DB CHECK rejects lower case). Partial unique `(tenant_id, barcode_value) WHERE is_active`.

### 2.9 `stores` (M)
`branch_id` (FK `core.branches (tenant_id, id)`), `store_code` (`^[A-Z0-9][A-Z0-9_\-]{0,15}$`, unique per tenant), `name` (1–120), `store_kind` (`main`, `bench`, `other`), `is_default_consumption boolean`. Partial unique `(tenant_id, branch_id) WHERE is_default_consumption AND is_active`. Unique `(tenant_id, id, branch_id)`.

### 2.10 `store_item_settings` (M)
`store_id`, `item_id`, `reorder_level_base` (≥ 0, nullable = no reorder), `reorder_qty_base` (> 0, nullable), `max_level_base` (nullable; ≥ reorder level), `preferred_supplier_id` (nullable FK suppliers), `is_stocked` (default true). Unique `(tenant_id, store_id, item_id)`.

### 2.11 `suppliers` (M)
`supplier_code` (`^[A-Z0-9][A-Z0-9_\-]{0,15}$`, unique), `name` (1–200), `pan_text` (`^[A-Za-z0-9]{1,20}$`, nullable — not validated against any IRD format), `contact_name` (≤ 120), `phone_display` (≤ 40), `email` (≤ 254), `address_text` (≤ 500), `payment_terms_days` (0–365), `notes` (≤ 1000). Contact columns are **P2-personal** (supplier staff, not patients; REQ-SEC-004 inventory).

### 2.12 `supplier_items` (M)
`supplier_id`, `item_id`, `pack_id` (composite FK with item), `supplier_item_code` (≤ 64), `last_unit_price_paisa` (≥ 0, per pack, nullable), `lead_time_days` (0–365, nullable), `default_tax_code` (nullable). Unique `(tenant_id, supplier_id, item_id, pack_id)`.

### 2.13 `lots` (M)
`item_id`, `lot_no` (`^[\x21-\x7E]{1,64}$`), `expiry_on date` (nullable), `manufactured_on date` (nullable; ≤ expiry), `status` (`available`, `quarantined`, `blocked`; default `available`), `status_reason_code` (nullable), `last_receipt_qty_base numeric(18,6)` (nullable, > 0), `last_receipt_value_paisa bigint` (nullable, ≥ 0). Unique `(tenant_id, item_id, lot_no)`, unique `(tenant_id, id, item_id)`. `item_id` and `lot_no` are immutable (trigger). `expiry_on` may be corrected (privileged endpoint, audited).

### 2.14 `stock_balances` (M projection)
`store_id`, `item_id`, `lot_id` (nullable = unlotted row), `qty_base numeric(18,6)`, `value_paisa bigint`, `last_movement_at timestamptz`. Unique **NULLS NOT DISTINCT** `(tenant_id, store_id, item_id, lot_id)` (PostgreSQL 15+ feature; PG 17 per 04 D9). CHECK `lot_id IS NULL OR qty_base >= 0` (real lots never go negative). Written only in the same transaction as the ledger insert that changes it. A nightly integrity job compares it with the ledger (02-TRD §10). `is_active` is kept for the M template and is always true.

### 2.15 `stock_movements` (A)
| Column | Type | Null | Notes |
|---|---|---|---|
| business_date | date | no | in the tenant timezone, of `occurred_at` |
| occurred_at | timestamptz | no | physical time (receipt time, verified_at, QC received_at, manual entry time) |
| store_id, item_id | uuid | no | |
| lot_id | uuid | yes | null = unlotted row |
| movement_kind | text | no | see §6 list; sign CHECK per kind |
| qty_base | numeric(18,6) | no | signed, ≠ 0 |
| value_paisa | bigint | no | signed; same sign as qty or 0 |
| value_basis | text | no | `receipt`, `average`, `last_receipt`, `transfer`, `reversal`, `none` |
| doc_type | text | no | `goods_receipt`, `stock_document`, `transfer`, `stock_count`, `consumption_fact` |
| doc_id | uuid | no | header id |
| doc_line_id | uuid | yes | |
| instrument_id | uuid | yes | FK `instruments.instruments (tenant_id, id)` |
| attributed_test_id | uuid | yes | FK `catalog.tests (tenant_id, id)` |
| rule_id | uuid | yes | FK consumption_rules |
| reason_code | text | yes | |
| reverses_movement_id | uuid | yes | for `consume_reversal` |
| balance_qty_after | numeric(18,6) | no | row balance after this movement |

No UPDATE, no DELETE (grants). P1 at most (instrument/test ids are master data, not patient-linked).

### 2.16 `purchase_orders` / `purchase_order_lines` (C)
Header: `po_no` (unique per tenant), `branch_id`, `store_id` (receiving store; composite FK `(tenant_id, store_id, branch_id)` → stores), `supplier_id`, `status` (`draft`, `approved`, `sent`, `partially_received`, `received`, `closed`, `cancelled`), `source` (`manual`, `reorder`), `expected_on date`, `notes` (≤ 1000), totals `subtotal_paisa, discount_paisa, net_paisa, vat_paisa, total_paisa` (all ≥ 0; server-computed), lifecycle columns `approved_at/by`, `sent_at/by`, `sent_channel` (`email`, `phone`, `in_person`, `portal`, `other`), `sent_reference` (≤ 120), `cancelled_at/by`, `cancel_reason_code`, `cancel_reason_text` (≤ 500), `closed_at/by`, `close_reason_code`, `close_reason_text`.

Lines: `po_id`, `line_no` (1–500, unique per PO), `item_id`, `pack_id` (composite FK with item), `qty_packs numeric(12,3)` (> 0), `qty_in_base_snapshot numeric(18,6)`, `qty_base numeric(18,6)` (= packs × snapshot), `unit_price_paisa` (≥ 0, per pack), `discount_paisa` (≥ 0, ≤ gross), `tax_code` (nullable: NULL = exempt line, 08 A4.1), `tax_rate_bp` (snapshot of `CatalogPort.getTaxRate` at line write, 08 A2.2; 0 when `tax_code` is NULL [CONV]), `net_paisa`, `vat_paisa`, `line_total_paisa`, `received_qty_base` (default 0; lifecycle), `is_closed_short` (default false; lifecycle), `removed_at timestamptz NULL`, `removed_by uuid NULL` (CHECK both null or both set; settable only while the PO is `draft` — D-71). `tax_code` NULL ⇔ exempt; the wire uses `is_exempt` instead of `null` (D-70). Line unique `(tenant_id, po_id, line_no) WHERE removed_at IS NULL`.

### 2.17 `goods_receipts` / `goods_receipt_lines` (C)
Header: `grn_no`, `kind` (`purchase`, `opening_balance`), `store_id`, `supplier_id` (required iff kind `purchase`), `po_id` (nullable), `status` (`draft`, `posted`, `cancelled`), `received_at timestamptz`, `supplier_invoice_no` (≤ 64), `supplier_invoice_on date`, `supplier_invoice_total_paisa` (nullable), totals as PO, `posted_at/by`, `cancelled_at/by`, `cancel_reason_text`, `notes`.

Lines: `grn_id`, `line_no`, `po_line_id` (nullable; FK), `item_id`, `pack_id`, `qty_packs`, `qty_in_base_snapshot`, `qty_base`, `lot_no` (nullable text), `expiry_on`, `manufactured_on`, `lot_id` (set at post), `unit_price_paisa`, `discount_paisa`, `tax_code` (nullable: NULL = exempt line, 08 A4.1; wire field `is_exempt`, D-70), `tax_rate_bp` (0 when `tax_code` is NULL [CONV]), `net_paisa`, `vat_paisa`, `line_total_paisa`, `capitalised_value_paisa` (set at post), `removed_at`, `removed_by` (D-71, as PO lines). Line unique `(tenant_id, grn_id, line_no) WHERE removed_at IS NULL`.

### 2.18 `transfers` / `transfer_lines` (C)
Header: `transfer_no`, `from_store_id`, `to_store_id` (CHECK different), `status` (`draft`, `dispatched`, `received`, `cancelled`), `dispatched_at/by`, `received_at/by`, `cancelled_at/by`, `cancel_reason_text`, `notes`.
Lines: `transfer_id`, `line_no`, `item_id`, `lot_id` (nullable only for non-lot-tracked items — service check), `qty_base` (> 0), `dispatched_value_paisa` (set at dispatch), `received_qty_base` (set at receipt; 0 ≤ x ≤ qty), `discrepancy_reason_code` (required when received < qty), `removed_at`, `removed_by` (D-71, as PO lines). Line unique `(tenant_id, transfer_id, line_no) WHERE removed_at IS NULL`.

### 2.19 `stock_documents` / `stock_document_lines` (A)
Header: `doc_no`, `doc_kind` (`issue`, `return_to_store`, `supplier_return`, `wastage`, `adjustment`, `expiry_writeoff`), `store_id`, `occurred_at`, `issued_to_kind` (`department`, `instrument`, `general`; issue only), `department_id` (FK `catalog.departments`), `instrument_id` (FK instruments), `supplier_id` (supplier_return), `grn_id` (supplier_return, optional), `reason_code` (required for wastage, adjustment, supplier_return), `reason_text` (≤ 500), `container_id` (wastage from a discarded container, optional).
Lines: `document_id`, `line_no`, `item_id`, `lot_id`, `direction` (`in`, `out`; `in` only for return_to_store and adjustment), `qty_base` (> 0), `value_paisa` (computed at insert), `reason_code` (optional per line).

### 2.20 `stock_counts` / `stock_count_lines` (C)
Header: `count_no`, `store_id`, `status` (`open`, `posted`, `cancelled`), `scope_category` (nullable item category), `snapshot_at`, `posted_at/by`, `cancelled_at/by`, `notes`.
Lines: `count_id`, `item_id`, `lot_id` (nullable), `book_qty_snapshot`, `counted_qty_base` (nullable until counted; ≥ 0), `counted_at`, `counted_by`, `book_qty_at_count` (set at post), `variance_qty_base` (set at post), `variance_value_paisa` (set at post), `reason_code` (nullable; default `count_variance` at post). Unique NULLS NOT DISTINCT `(tenant_id, count_id, item_id, lot_id)`.

### 2.21 `opened_containers` (C)
`store_id`, `item_id`, `lot_id` (nullable for non-lot-tracked), `instrument_id` (nullable), `opened_at`, `opened_by`, `open_expiry_at` (nullable; computed: least(lot expiry end-of-day in tenant tz, opened_at + open_stability_days)), `status` (`open`, `finished`, `discarded`), `finished_at/by`, `discard_document_id` (FK stock_documents), `notes` (≤ 500).

### 2.22 `instrument_bindings` (M)
`instrument_id` (FK `instruments.instruments (tenant_id, id)`), `store_id`. Partial unique `(tenant_id, instrument_id) WHERE is_active`.

### 2.23 `consumption_rules` (M, versioned by supersede)
| Column | Type | Null | Notes |
|---|---|---|---|
| rule_kind | text | no | `per_test`, `per_analyte`, `per_rerun`, `per_qc`, `per_calibration`, `per_day` |
| test_id | uuid | yes | FK `catalog.tests`; required for all kinds except `per_day` (for `per_qc` it is the **attribution** test, required) |
| analyte_id | uuid | yes | FK `catalog.analytes`; required for `per_analyte`; optional for `per_qc` (null = every QC observation of the instrument); null otherwise |
| instrument_id | uuid | yes | FK instruments; null = any instrument (not allowed for `per_day`) |
| item_id | uuid | no | |
| qty_base | numeric(18,6) | no | > 0 |
| entered_qty | numeric(18,6) | no | as typed |
| entered_pack_id | uuid | yes | null = base unit; composite FK with item |
| effective_from | timestamptz | no | |
| effective_to | timestamptz | yes | set by supersede/deactivate |
| supersedes_rule_id | uuid | yes | |
| notes | text | yes | ≤ 500 |

Partial unique **NULLS NOT DISTINCT** `(tenant_id, rule_kind, test_id, analyte_id, instrument_id, item_id) WHERE effective_to IS NULL AND is_active` (one current rule per key). Immutable columns: everything except `effective_to`, `is_active`, `notes`, `updated_*`, `version` (trigger).

### 2.24 `consumption_facts` (C)
| Column | Type | Null | Notes |
|---|---|---|---|
| fact_kind | text | no | `test`, `analyte`, `rerun`, `qc`, `calibration`, `fixed` |
| basis_key | text | no | dedupe key (02-TRD §8.1); unique `(tenant_id, basis_key)`; ≤ 200; contains only UUIDs, kinds, dates, and a SHA-256 hex digest |
| source | text | no | `event`, `manual`, `cron` |
| source_event_id | uuid | yes | envelope `event_id` |
| source_event_type | text | yes | |
| instrument_id | uuid | yes | |
| test_id | uuid | yes | |
| analyte_id | uuid | yes | |
| department_id | uuid | yes | from event (verified) |
| centre_id | uuid | yes | from event (QC/rerun/calibration) |
| processing_branch_id | uuid | yes | from `lab.result.verified.v1` (CR-C12-004, accepted in 08; absent on older events) |
| occurred_at | timestamptz | no | |
| business_date | date | no | |
| multiplier | integer | no | default 1; 1–50 |
| store_id | uuid | yes | resolved store |
| status | text | no | `posted`, `no_rule`, `unresolved`, `dismissed`, `reversed` |
| rules_applied | integer | no | default 0 |
| value_paisa_total | bigint | no | default 0 |
| reason_code | text | yes | manual: calibration reason; dismiss/reverse reason |
| note | text | yes | ≤ 500 (manual only; staff text, no PHI by UI rule) |
| resolved_at, resolved_by | | yes | |

Insert: the row is inserted with its **final** initial status (`posted`, `no_rule` or `unresolved`) after rule matching and store resolution (`02-TRD.md` §8.1 step 6); the DDL has no status default. Allowed status transitions (trigger): `unresolved → posted | dismissed`; `posted → reversed` (manual facts only, service check). A same-status UPDATE of mutable columns (e.g. `value_paisa_total` after posting) is not a transition and is allowed (§7). Mutable columns: `status`, `store_id`, `rules_applied`, `value_paisa_total`, `reason_code`, `resolved_at`, `resolved_by`, `updated_*`, `version`. Facts carry no barcode, order id or result value. `basis_key` embeds an `order_item_id` or `result_id` (P1 pseudonymous); the table is P1.

### 2.25 `consumption_daily` (M projection)
`business_date`, `store_id`, `item_id`, `movement_kind` (consumption, wastage and count kinds only), `instrument_id` (nullable), `attributed_test_id` (nullable), `qty_consumed numeric(18,6)` (positive = consumed/lost; reversals and count-adjust-in subtract), `value_consumed_paisa bigint`, `movements integer`. Unique NULLS NOT DISTINCT `(tenant_id, business_date, store_id, item_id, movement_kind, instrument_id, attributed_test_id)`. Upserted in the movement transaction.

### 2.26 `test_counts_daily` (M projection)
`business_date`, `instrument_id` (nullable), `test_id`, `tests_counted integer`, `verified_result_events integer`, `rerun_events integer`, `qc_events integer`. Unique NULLS NOT DISTINCT `(tenant_id, business_date, instrument_id, test_id)`. `verified_result_events` is written for every non-duplicate verified event, also while consumption is off (D-73); `tests_counted`, `rerun_events` and `qc_events` only for newly inserted facts; `qc_events` = +1 per **distinct** attributed test of a newly inserted QC fact (D-74). `instrument_id` carries no FK (opaque copy from the event, like `consumption_facts`).

### 2.26a `instrument_qc_daily` (counter; 08 A17 D-74)
`tenant_id`, `business_date` (bd(`received_at`), tenant timezone), `instrument_id` (no FK — same rule as `test_counts_daily.instrument_id`), `qc_observations integer NOT NULL DEFAULT 0` (≥ 0), `created_at`, `created_by`, `updated_at`, `updated_by`. PK `(tenant_id, business_date, instrument_id)`. Every non-duplicate `instruments.qc.received.v1` adds 1, **before** the mapping filter and the switch gate. Compared with `instruments.v_pub_message_daily.qc_records` in the reconciliation report (AC-21.7). P0. Mandatory-column exception (§1).

### 2.27 `alerts` (E)
`alert_kind` (`below_reorder`, `expiry_soon`, `expired_on_hand`, `open_stability_exceeded`, `negative_stock`, `unresolved_consumption`, `expired_lot_in_use`, `balance_drift`, `reconciliation_gap`), `store_id`, `item_id`, `lot_id`, `instrument_id`, `test_id` (all nullable), `dedupe_key` (≤ 200), `status` (`open`, `acknowledged`, `resolved`), `first_raised_at`, `last_raised_at`, `occurrences` (≥ 1), `details jsonb` (numbers/codes only; object ≤ 2 KB — CHECK on `pg_column_size`), `acknowledged_at/by`, `resolved_at`, `expires_at` (= resolved_at + 365 days; NULL while open — CV §5.2 E requires the column; the purge job uses it), `version`, `updated_at/by`. Partial unique `(tenant_id, dedupe_key) WHERE status <> 'resolved'`.

---

## 3. Data classification (REQ-SEC-004)

| Class | Columns |
|---|---|
| P0 | everything not listed below |
| P1 (pseudonymous ids) | `consumption_facts.basis_key` (contains order_item_id / result_id / instrument_message_id), `consumption_facts.source_event_id`; `inventory.event_inbox.event_id` |
| P2-personal (non-patient) | `suppliers.contact_name`, `phone_display`, `email`, `address_text` |
| Financial (business, not personal) | all `*_paisa` columns — returned only with `inventory.cost.read` (02-TRD §6.3) |
| Never stored | sample barcodes, patient ids, order ids, result values, any analyser raw text (item barcodes in `item_barcodes` are supplier/in-house product codes, P0) |

---

## 4. RLS policies

### 4.1 Template applied to every tenant table (`__tenant` variant of CV §5.8)

```sql
ALTER TABLE inventory.<t> ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory.<t> FORCE ROW LEVEL SECURITY;
CREATE POLICY <t>__select__tenant ON inventory.<t> FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY <t>__insert__tenant ON inventory.<t> FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY <t>__update__tenant ON inventory.<t> FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
```

`app.is_staff_or_system()` (actor type `user`, `system` or `device`) is required on every `__tenant` policy (CR-C13-011, 08 R10); no inventory table is shared with partner/portal/patient actors.

### 4.2 Per-table command matrix

| Table(s) | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|
| M tables (`cs_reasons`, `cs_tax_codes`, `settings`, `items`, `item_packs`, `item_barcodes`, `stores`, `store_item_settings`, `suppliers`, `supplier_items`, `lots`, `instrument_bindings`, `consumption_rules`, `stock_balances`, `consumption_daily`, `test_counts_daily`) | tenant | tenant | tenant | — |
| Counters (`number_counters`, `instrument_qc_daily`) | tenant | tenant | tenant | — |
| C headers (`purchase_orders`, `goods_receipts`, `transfers`, `stock_counts`, `opened_containers`, `consumption_facts`) | tenant | tenant | tenant (triggers restrict columns/transitions) | — |
| Draft-line tables (`purchase_order_lines`, `goods_receipt_lines`, `transfer_lines`) | tenant | tenant | tenant (`tg_line_guard`: `removed_*` only while the parent is draft) | — (soft removal, D-71) |
| `stock_count_lines` | tenant | tenant | tenant | — |
| A tables (`stock_movements`, `stock_documents`, `stock_document_lines`, `event_inbox`) | tenant | tenant | — (no grant) | — |
| `alerts` (E) | tenant | tenant | tenant | `alerts__delete__tenant`: tenant AND system actor AND `expires_at < now()` (§4.3; D-72, P-18(c)) |
| G tables | granted SELECT, no RLS (listed in `db/tests/rls_exempt.txt`: "global vocabulary, no tenant data") | — | — | — |

### 4.3 DELETE policy (alerts purge only; 08 A17 D-72, P-18(c))

Draft lines have no DELETE policy (soft removal, D-71). The only DELETE policy in the schema:

```sql
CREATE POLICY alerts__delete__tenant ON inventory.alerts FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'system' AND expires_at < now());
```

It is used only by `app.purge_inventory_alerts()` (SECURITY INVOKER, §5) called by the `per_tenant` task `inventory.purge_alerts` under the tenant's claims as the `inventory` system actor. `app.current_actor_type() = 'system'` implies the `app.is_staff_or_system()` guard (P-16).

### 4.4 Grants

```sql
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
```

CI assertions (C0 `db/tests`): `has_table_privilege('lims_app','inventory.stock_movements','UPDATE') = false`, `…'DELETE') = false`; the same for `stock_documents`, `stock_document_lines`. `has_table_privilege('lims_app', <t>, 'DELETE') = false` for every C and A table, draft-line tables included (CV §5.6); `alerts` (E) is the only table with DELETE = true.

---

## 5. Triggers and functions (all SECURITY INVOKER, `SET search_path = ''`)

| Name | On | Rule |
|---|---|---|
| `app.enforce_mutable_columns(...)` (C0 generic, CV §5.7) | `item_packs` (`label, uom_code, is_purchase_default, is_active, updated_at, updated_by, version`); `lots` (`expiry_on, manufactured_on, status, status_reason_code, last_receipt_qty_base, last_receipt_value_paisa, is_active, updated_at, updated_by, version`); `consumption_rules` (`effective_to, is_active, notes, updated_at, updated_by, version`); `stock_balances` (`qty_base, value_paisa, last_movement_at, updated_at, updated_by, version`) | frozen columns |
| `inventory.tg_doc_guard()` | BEFORE UPDATE on `purchase_orders`, `goods_receipts`, `transfers`, `stock_counts`, `opened_containers`, `consumption_facts` | (a) allowed status pairs per table (§7); violation → `P0001` `invalid_transition`; (b) when `OLD.status` is not an editable state (`draft` / `open` / `unresolved`), only the lifecycle columns of that table may change, else `P0001` `immutable_row` |
| `inventory.tg_line_guard()` | BEFORE INSERT/UPDATE on `purchase_order_lines`, `goods_receipt_lines`, `transfer_lines`, `stock_count_lines` | `removed_at`/`removed_by` may be set only while the parent is `draft` and never cleared once set (D-71; 08 D-71 names `tg_doc_guard`, the line-level check belongs in this line trigger); a removed line is otherwise frozen. Parent must be in an editable state, except the lifecycle columns `received_qty_base`, `is_closed_short` (PO lines, while the parent is `approved/sent/partially_received`), `received_qty_base`, `discrepancy_reason_code`, `dispatched_value_paisa` (transfer lines during dispatch/receive), `book_qty_at_count`, `variance_*`, `reason_code` (count lines during posting) |
| `inventory.tg_item_base_uom_lock()` | BEFORE UPDATE OF `base_uom_code` on `items` | rejects the change when the item has any pack, rule or movement (`P0001` `immutable_row`; same condition as PRD AC-01.5 and the S2 tooltip). Lookups: `item_packs__tenant_id_item_code__uq` (packs), `consumption_rules__tenant_id_item_id__idx` (rules), and `stock_balances__tenant_id_item_id__idx` for movements — a balance row exists for every (store, item, lot) that ever had a movement, so the trigger checks balances, not the ledger |
| C0 audit trigger (`audit_log`, 04 D11) | all M and C tables | standard; **not** on `stock_movements`, `stock_documents*`, `consumption_daily`, `test_counts_daily`, `stock_balances` (the ledger is the record; projections are derived) [CONV] |

The module maps `P0001 invalid_transition` to the per-table code (`inventory.po_invalid_transition` for POs, `inventory.document_invalid_transition` otherwise) and `P0001 immutable_row` to `409 common.immutable_record` (CV §5.7).

---

## 6. Coded sets and seed data

### 6.1 `g_cs_uom` [CONV vocabulary]
`test` "test", `ml` "mL", `ul` "µL", `l` "L", `g` "g", `mg` "mg", `piece` "piece", `vial` "vial", `bottle` "bottle", `kit` "kit", `box` "box", `pack` "pack", `strip` "strip", `cartridge` "cartridge", `slide` "slide", `tube` "tube", `roll` "roll", `pair` "pair", `sheet` "sheet". Kinds: `ml/ul/l` volume; `g/mg` mass; `test, piece, vial, bottle, kit, box, pack, strip, cartridge, slide, tube, roll, pair, sheet` count. There are no automatic conversions between units. Conversions are only the per-item packs (DECISION: avoids silent mL↔µL errors; an item's rules and stock use its one base unit).

### 6.2 `g_cs_reasons` [CONV]
| Group | Codes |
|---|---|
| wastage | `spillage`, `damaged`, `contaminated`, `temperature_excursion`, `open_stability_exceeded`, `transit_loss`, `instrument_failure`, `training_or_test_run`, `other` |
| adjustment | `opening_correction`, `found_stock`, `data_entry_error`, `unlotted_reconciliation`, `other` |
| supplier_return | `damaged_on_arrival`, `wrong_item`, `short_expiry`, `recall`, `other` |
| po_cancel | `no_longer_needed`, `supplier_unavailable`, `price_changed`, `duplicate`, `other` |
| po_close | `short_supply`, `item_discontinued`, `no_longer_needed`, `other` |
| transfer_discrepancy | `transit_loss`, `damaged_in_transit`, `count_error`, `other` |
| fact_dismiss | `not_consumed`, `duplicate_entry`, `test_instrument`, `other` |
| fact_reverse | `logged_in_error`, `wrong_instrument`, `wrong_test`, `other` |
| lot_status | `pending_acceptance`, `recall`, `failed_acceptance`, `other` |
| calibration | `scheduled`, `new_reagent_lot`, `qc_failure`, `after_maintenance`, `other` |
| count_variance | `count_variance` |

### 6.3 `g_cs_tax_codes`
| code | display | Source |
|---|---|---|
| `VAT` | VAT | 04 L14 (VAT Act s.7(1), VERIFIED); C3's code (08 A5.6); the rate is C3 tax-rule data, read via `CatalogPort.getTaxRate` (08 A2.2). The display holds no rate; the UI appends the rate from the line's `tax_rate_bp` snapshot |

No `exempt` row (08 A4.1): exemption is a treatment — an exempt purchase line has no tax code (`tax_code` NULL); whether a given purchase is exempt is the supplier's invoice fact (04 L15, B7). No rate is seeded in C12 (08 A2.2). Tenants add codes in `cs_tax_codes`; a code with no C3 rate fails line writes with `catalog.tax_config_missing`.

### 6.4 Movement kinds and signs (CHECK in DDL)

| movement_kind | Sign of qty | doc_type | In `consumption_daily`? |
|---|---|---|---|
| `receive`, `opening_balance` | + | goods_receipt | no |
| `supplier_return` | − | stock_document | no |
| `issue` | − | stock_document | yes (issues are departmental usage) |
| `return_to_store` | + | stock_document | yes (subtracts from `issue`) |
| `transfer_out` | − | transfer | no |
| `transfer_in` | + | transfer (at the destination; and at the source for a receipt shortfall, paired with `wastage` — D-69) | no |
| `consume_test`, `consume_analyte`, `consume_rerun`, `consume_qc`, `consume_calibration`, `consume_fixed` | − | consumption_fact | yes |
| `consume_reversal` | + | consumption_fact | yes (subtracts, recorded under the kind of the reversed movement) |
| `wastage`, `expiry_writeoff` | − | stock_document; `wastage` also `transfer` for a receipt shortfall at the source, after the paired source `transfer_in` (D-69) | yes |
| `adjust_in` / `adjust_out` | + / − | stock_document | no |
| `count_adjust_in` / `count_adjust_out` | + / − | stock_count | yes (count variance; `in` subtracts) |

A `consume_reversal` row stores in `consumption_daily` under the original movement's kind with negative `qty_consumed`. This is how D(T,I,P) in PRD §8.3 nets reversals.

### 6.5 Test seeds (`packages/test-fixtures`, synthetic)
Two tenants (`tenant_a`, `tenant_b`), each with 2 branches × 2 stores; items `GLU-R1` (reagent, base `test`, pack `BOX` = 400), `CTRL-L1` (control, base `ml`, open stability 30 d), `CAL-GLU` (calibrator, `ml`), `TIPS-200` (consumable, `piece`, not lot-tracked), `WASH-01` (reagent, `ml`); supplier `SUP-01`; rules for the synthetic tests `GLU` and `CBC` of the C3 fixture catalog; instruments `BIO-1`, `HEM-1` from the C7 fixture registry.

---

## 7. Allowed status transitions (enforced in the domain and by `tg_doc_guard`)

| Table | Pairs |
|---|---|
| purchase_orders | draft→approved, draft→cancelled, approved→sent, approved→partially_received, approved→received, approved→cancelled, sent→partially_received, sent→received, sent→cancelled, partially_received→partially_received (receipt counter), partially_received→received, partially_received→closed, received→closed |
| goods_receipts | draft→posted, draft→cancelled |
| transfers | draft→dispatched, draft→cancelled, dispatched→received |
| stock_counts | open→posted, open→cancelled |
| opened_containers | open→finished, open→discarded |
| consumption_facts | unresolved→posted, unresolved→dismissed, posted→reversed |

Lifecycle (mutable after leaving the editable state) columns per header:
- purchase_orders: `status, approved_at, approved_by, sent_at, sent_by, sent_channel, sent_reference, cancelled_at, cancelled_by, cancel_reason_code, cancel_reason_text, closed_at, closed_by, close_reason_code, close_reason_text, updated_at, updated_by, version`.
- goods_receipts: `status, posted_at, posted_by, cancelled_at, cancelled_by, cancel_reason_text, updated_*, version`.
- transfers: `status, dispatched_at, dispatched_by, received_at, received_by, cancelled_at, cancelled_by, cancel_reason_text, updated_*, version`.
- stock_counts: `status, posted_at, posted_by, cancelled_at, cancelled_by, updated_*, version`.
- opened_containers: `status, finished_at, finished_by, discard_document_id, updated_*, version`.
- consumption_facts: as §2.24.

A same-status UPDATE (status unchanged) that changes only mutable/lifecycle columns is not a transition: `tg_doc_guard` allows it (e.g. `consumption_facts.value_paisa_total` set after posting, `02-TRD.md` §8.1 step 6).

---

## 8. DDL (C0 transcribes into `db/migrations/<ts>_inventory__*.sql`; RLS in the same migration as each table — CV §5.12)

```sql
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
```

`purchase_orders__lifecycle__ck` only checks that the timestamps matching a state are present. Which columns may change in which state is enforced by `tg_doc_guard` (§5).

---

## 9. Published views

IC §6 defines **no** `inventory.v_pub_*` view, and C12 publishes none in v1. A future C8 inventory MIS tile would need `inventory.v_pub_consumption_daily`; this is a CR candidate (`06-IMPLEMENTATION-PLAN.md` §6).

C12 **reads** these views (grants already exist per IC §6):

| View | Columns used | Purpose |
|---|---|---|
| `catalog.v_pub_test_directory` | tenant_id, test_id, code, name, department_id, is_active | test labels in rules/reports |
| `lab.v_pub_result_daily` | tenant_id, business_date, test_id, results_verified | reconciliation (summed over processing_branch_id, department_id) |
| `instruments.v_pub_message_daily` | tenant_id, instrument_id, business_date, messages, qc_records | per-day activity (US-16), QC reconciliation |
| `instruments.v_pub_instrument_directory` (CR-C9-006; CR-C12-005 merged, 08 R12d — view columns `tenant_id, instrument_id, centre_id, instrument_code, display_name, vendor, model, state, is_active`) | tenant_id, instrument_id, instrument_code, display_name, centre_id, state, is_active | instrument labels; store fallback |

---

## 10. Query → index map

| Query (02-TRD) | Index |
|---|---|
| balances by store (stock screen, FEFO, count snapshot) | `stock_balances__tenant_id_store_nonzero__p_idx`, `stock_balances__key__uq` |
| balances by item (item detail, avg cost) | `stock_balances__tenant_id_item_id__idx` |
| ledger by store+item | `stock_movements__tenant_id_store_item__idx` |
| ledger since snapshot (count) | same |
| movements of a document | `stock_movements__tenant_id_doc__idx` |
| lot history | `stock_movements__tenant_id_lot__p_idx` |
| rule match in consumers | `consumption_rules__tenant_id_match__idx` |
| in-use lot | `opened_containers__tenant_id_in_use__p_idx` |
| fact dedupe | `consumption_facts__basis__uq` |
| unresolved queue | `consumption_facts__tenant_id_status__p_idx` |
| reports (daily, analyser, CPT, wastage) | `consumption_daily__*`, `test_counts_daily__*` |
| expiry scan | `lots__tenant_id_expiry_on__idx` + balances |
| open-stability scan | `opened_containers__tenant_id_open_expiry__p_idx` |
| reorder scan | `store_item_settings__tenant_id_reorder__p_idx` |
| alert list / dedupe | `alerts__tenant_id_status_kind__idx`, `alerts__tenant_id_dedupe__p_uq` |
| PO list | `purchase_orders__tenant_id_status__idx`, `…_supplier__idx`, `…_branch__idx` |
| GRN list / GRN CSV | `goods_receipts__tenant_id_store_status__idx`, `…_posted__idx`; supplier filter (#49) `goods_receipts__tenant_id_supplier__idx` |
| item list prefix (#1) | `items__tenant_id_item_code_prefix__idx`, `items__tenant_id_lower_name__idx` |
| supplier list prefix (#17) | `suppliers__tenant_id_lower_name__idx` |
| rules by item (#69, uom lock) | `consumption_rules__tenant_id_item_id__idx` |
| counts by store + status (#63) | `stock_counts__tenant_id_store_status__idx` |
| bindings by store (#23, #14 default-store change) | `instrument_bindings__tenant_id_store__p_idx` |
| draft lines (non-removed) | `purchase_order_lines__tenant_id_po_line__p_uq`, `goods_receipt_lines__tenant_id_grn_line__p_uq`, `transfer_lines__tenant_id_transfer_line__p_uq` |
| QC reconciliation instrument block | `instrument_qc_daily__pk` |
| alert purge | `alerts__tenant_id_expires__p_idx` |

---

## 11. Retention

| Table | Retention |
|---|---|
| Ledger, documents, facts, projections, master data | Kept forever in v1, with a floor of the tenant `retentionYears` (default 5, BLOCKED B15). No purge job. Rationale: valuation as-of and audit need the full ledger. Volume ≈ 7 M movements/lab/year (02-TRD §12), ~1 GB/lab/year ASSUMPTION |
| `alerts` | resolved + 365 days [CONV]. Class E purge per 08 A17 P-18(c) / D-72: the weekly `per_tenant` task `inventory.purge_alerts` calls the INVOKER `app.purge_inventory_alerts()` as the `inventory` system actor; policy `alerts__delete__tenant`, `GRANT DELETE … TO lims_app`. No DEFINER, no owner policy, no index exception (08 §4.7 INVOKER row unchanged) |
| `instrument_qc_daily` | as the other projections (kept in v1) |
| `event_inbox` | 90 days (C0, CV §5.11) |

---

## 12. Partition readiness (04 D10)

No partitioning in v1. `stock_movements` carries `business_date` and `occurred_at`. If C0 ever partitions it by `business_date`, the PK becomes `(tenant_id, business_date, id)`; the only FK into it is the self-reference `reverses_movement_id`, which C0 would then drop to a service-checked column. Recorded as a known future change, not a v1 requirement.
