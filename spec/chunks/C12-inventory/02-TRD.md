# C12 Inventory — 02 Technical Requirements (TRD)

Status: DECISION, 2026-11-06. Inputs: 00, 04, CM (`01-CHUNK-MAP.md`), CV (`02-CONVENTIONS.md`), IC (`03-INTERFACE-CATALOG.md`), C0/C3/C5/C7 chunk documents (exact ids, view SQL and event behaviour), this chunk's `01-PRD.md` (stories, §8 formulas) and `05-SCHEMA.md` (tables).

Everything this chunk needs that is not in IC is listed in §17 as a CR. Until a CR merges, the design below treats it as accepted, and each such item is marked **(CR-C12-0nn)**.

---

## 1. Owned paths (CM §3)

| Path | Content |
|---|---|
| `services/api/src/modules/inventory/**` | API module (manifest, handlers, services, domain, repositories, mappers, tests) |
| `services/worker/src/jobs/inventory/**` | event consumers, tasks, cron |
| `apps/web/src/app/(staff)/inventory/**` | route segment (pages, `loading.tsx`, `error.tsx`) |
| `apps/web/src/features/inventory/**` | nav manifest, BFF server functions, components, hooks, forms, help, tests |
| `docs/manual/inventory/**` | user manual pages |

C0 implements from this chunk's documents:
- schema `inventory` DDL/RLS (`05-SCHEMA.md`);
- `contracts/openapi/inventory.yaml` (§5);
- the permission, route, error and event additions in §17.

C12 never edits `db/`, `contracts/`, `packages/*` or `*/core/`.

## 2. Stack and libraries

| Concern | Choice | Source |
|---|---|---|
| Runtime | Node.js 26.x LTS (exact patch: C0 pins) | CV §1.1 |
| API | Fastify (C0 pins) + `fastify-openapi-glue` 4.12.0 | 04 T7; CV §1.1 |
| Worker | Graphile Worker 0.18.0 | 04 S10, T7 |
| DB | PostgreSQL 17 (`supabase/postgres:17.6.1.136`); uses `UNIQUE NULLS NOT DISTINCT` (a PostgreSQL ≥ 15 feature per the PostgreSQL documentation for CREATE TABLE / CREATE INDEX — not in research, UNVERIFIED-in-research; verified by the T-03 migration test on the pinned image) | 04 D9 |
| Web | Next.js App Router (C0 pins), server-only BFF; components from `@lims/ui` only | 04 S4; CV §2.4, §14 |
| Decimal quantities | `numeric` in SQL. In TS, quantities are `DecimalString` (IC §2.1); validation uses `@lims/shared-ts/decimal` (CM §3 lists it in `packages/shared-ts`); arithmetic stays in SQL (see note below) | CV §4.9; CM §3 |
| Money | `@lims/shared-ts/money` (integer paisa, half-up) | CV §4.9 |
| B.S. dates (fiscal-year token `{fy}`) | `@lims/shared-ts/bsdate` | 04 D13; CV §13 |
| IDs | `@lims/shared-ts/uuidv7` | 04 D9 |
| CSV export | in-module RFC 4180 writer `domain/csv.ts` (UTF-8 BOM); every text cell passes `neutraliseFormula` from `@lims/shared-ts/spreadsheet` (no module-local neutraliser) | 08 A13 P-9 |

Note on decimal arithmetic. CV does not name a decimal library, and C12 adds no dependency. Every quantity × cost computation that needs more than integer arithmetic runs **in SQL** (`numeric`) inside the posting transaction:
- `round(q * V / Q)`. Per the PostgreSQL documentation (Mathematical Functions; not in research — UNVERIFIED-in-research) `round(numeric)` rounds ties away from zero, which equals half-up for the non-negative magnitudes used here (signs are applied after rounding). The verification is the T-05 rounding golden test, which pins this behaviour on the pinned image;
- pack × quantity products.

TS code passes DecimalStrings straight through. It never parses quantities into JS `number`, except in UI display formatting. The domain layer uses `@lims/shared-ts/decimal` (CM §3) for validation only; arithmetic stays in SQL. No dependency is added by C12.

New dependencies: **none**.

## 3. Module architecture

### 3.1 API module `services/api/src/modules/inventory/`

```
index.ts                       # ModuleManifest { name:'inventory', openapi:'contracts/openapi/inventory.yaml', handlers, ports:{}, produces:[] }
permissions.ts                 # the codes of §5 (IC §11 + CR-C12-001)
config.ts                      # LIMS_INVENTORY_* (§11)
handlers/index.ts              # operationId → handler (every operationId of §5)
handlers/<operationId>.ts      # one per operation: load (RLS) → branch authz → service → mapper
service/
  items.service.ts             # items, packs, barcodes
  stores.service.ts            # stores, store item settings, bindings
  suppliers.service.ts         # suppliers, supplier items
  lots.service.ts              # lots, status, expiry correction, containers
  ledger.service.ts            # THE ONLY writer of stock_movements / stock_balances / consumption_daily (post())
  documents.service.ts         # issues, returns, supplier returns, wastage, adjustments, expiry write-off
  receipts.service.ts          # GRN draft/post/cancel
  purchasing.service.ts        # PO lifecycle, reorder → draft POs
  transfers.service.ts         # transfer lifecycle
  counts.service.ts            # stock counts
  consumption.service.ts       # rule CRUD/supersede/preview; fact recording; resolution; reversal
  consumers.service.ts         # event handlers' logic (called by worker consumers)
  alerts.service.ts            # raise/resolve/ack
  reports.service.ts           # report queries, CSV export
  settings.service.ts          # settings + coded sets
  numbering.service.ts         # po/grn/transfer/count/doc numbers
  scope.service.ts             # branch-scope helpers (assertStoreAccess, assertTransferAccess, listVisibleBranchIds; §5 Scope)
domain/
  quantity.ts                  # DecimalString validation (pattern, >0), pack conversion request shapes
  money.ts                     # line computation (net/vat/total) — integer paisa
  valuation.ts                 # pure description of §4.3 used to build SQL; golden tests
  fefo.ts                      # ordering rule (§4.4) — pure comparator over candidate rows
  rules.ts                     # rule shape validation per kind; precedence (§8.3)
  basis.ts                     # basis_key builders (§8.1)
  po.state.ts, grn.state.ts, transfer.state.ts, count.state.ts, container.state.ts, fact.state.ts   # tables of 03-APP-FLOW §3
  numbering.ts                 # pattern parser: tokens {yy}, {fy}, {fyl}, {seq:N} and literal text [A-Z0-9\-/] (§4.6)
  csv.ts                       # RFC 4180 writer; cells via @lims/shared-ts/spreadsheet neutraliseFormula (P-9)
repository/
  <table-group>.repo.ts        # SQL on schema inventory only; explicit tenant filter (REQ-SEC-024)
  views.repo.ts                # SELECTs on catalog.v_pub_test_directory, lab.v_pub_result_daily,
                               # instruments.v_pub_message_daily, instruments.v_pub_instrument_directory (CR-C9-006 + CR-C12-005, 08 R12d)
mappers/<aggregate>.dto.ts     # explicit field allowlists; cost fields only with inventory.cost.read (§6.3)
__tests__/{unit,integration,contract,probes}/
```

Layer rules (CV §2.2):
- Handlers contain no SQL.
- `ledger.service.post()` is the single function that inserts movements and changes balances. Every other service calls it inside its own transaction.
- Repositories never call ports.

### 3.2 Worker `services/worker/src/jobs/inventory/`

```
index.ts                                   # WorkerManifest (§9)
consumers/lab.result.verified.v1.ts
consumers/instruments.qc.received.v1.ts
consumers/instruments.result.received.v1.ts
consumers/instruments.calibration.received.v1.ts   # 03-IC §3.26 (CR-C12-006, 08 R13)
tasks/inventory.resolve_unresolved.ts
tasks/inventory.daily_fixed_consumption.ts
tasks/inventory.daily_alert_scan.ts
tasks/inventory.balance_integrity_check.ts
tasks/inventory.reconciliation_scan.ts
tasks/inventory.purge_alerts.ts
cron.ts
```

The consumers are thin. Each validates the known payload fields, then calls `consumers.service.*` through the module manifest (CV §2.3: shared logic lives in the API module's `service/`).

### 3.3 Web

```
apps/web/src/app/(staff)/inventory/
  page.tsx                     # S1 home
  items/ , items/[item_id]/ , stores/ , stores/[store_id]/ , suppliers/ , suppliers/[supplier_id]/
  stock/ , movements/ , issue/ , wastage/ , adjustments/ , expiry/
  purchase-orders/ , purchase-orders/new/ , purchase-orders/[po_id]/ , purchase-orders/[po_id]/print/
  receipts/ , receipts/new/ , receipts/[grn_id]/
  transfers/ , transfers/[transfer_id]/
  counts/ , counts/[count_id]/
  bench/                       # containers + manual consumption log
  rules/ , bindings/ , unresolved/ , alerts/
  reports/[report_code]/
  settings/
  (every page has loading.tsx + error.tsx — CV §2.4)
apps/web/src/features/inventory/{nav.manifest.ts, server/*.server.ts, components/**, hooks/**, forms/**, help/**, __tests__/**}
```

## 4. Domain rules (binding)

### 4.1 Quantities and units
- Wire type: `DecimalString` (IC §2.1, `^-?[0-9]{1,12}(\.[0-9]{1,6})?$`). For positive-only fields, the spec adds a pattern without the leading `-`. Pack quantities (`qty_packs`) use the narrower `DecimalStringPacks` (§6.1), matching `numeric(12,3)`.
- Every stored quantity is in the item's **base unit**. Requests may give `{ qty, pack_id? }`. With a `pack_id`, the server computes `qty_base = round(qty × pack.qty_in_base, 6)` in SQL. A `pack_id` whose `item_id` differs from the line's item → `422 inventory.uom_mismatch`. A request field `uom_code` that differs from the item base unit when no pack is given → `422 inventory.uom_mismatch`.
- There are no unit conversions other than packs (`05-SCHEMA.md` §6.1).

### 4.2 Money on PO/GRN lines (integer paisa; CV §4.9)
```
gross    = round_half_up(qty_packs × unit_price_paisa)        -- SQL numeric, then ::bigint
net      = gross − discount_paisa                              -- discount ≤ gross, else 400 common.validation_failed (P-1)
vat      = round_half_up(net × tax_rate_bp / 10000)
total    = net + vat
header: subtotal = Σ gross, discount = Σ discount, net = Σ net, vat = Σ vat, total = Σ total
capitalised_value (GRN line, at post) = net + (vat if settings.vat_in_cost else 0)
```
`tax_rate_bp` is snapshotted when the line is written from `CatalogPort.getTaxRate(ctx, { taxCode: line.tax_code, on })` → `ratePercentBasisPoints` (08 R18, A2.2, CR-C12-010). `on` = the tenant business date (tenant timezone) on which the line is written (accepted in 08 A5.3). An exempt purchase line is sent as `is_exempt: true` with `tax_code` absent (08 A17 D-70; 02-CV §4.2 "no `null` on the wire" stands). It is stored with `tax_code` NULL, C12 never calls `getTaxRate` for it (08 A4.1), its `tax_rate_bp` is `0` and `vat` = 0 [CONV: 0 snapshot]. `is_exempt: true` with a `tax_code` → `400 common.validation_failed` at `/lines/n/tax_code`; `is_exempt: false` (default) with `tax_code` absent → the supplier item, then item default code, then `VAT`. Responses carry `is_exempt` and omit `tax_code` on exempt lines. (08 A7.6 "exempt purchase lines carry `tax_code: null`" describes the stored column.) Tax codes are C3 tax-code values (`^[A-Z0-9_]{1,16}$`, e.g. `VAT`; 08 A5.6). The tax code itself (tenant code shadows global, CV §5.5) must exist and be active in `inventory.*`; C12 stores no rate values. `catalog.tax_config_missing` from the port propagates unchanged as `422` (08 A17 P-23: the handler rethrows the port's `LimsError`, never constructs it) and nothing is written. A later rate change in C3 never changes existing lines.

`supplier_invoice_total_paisa` is informational. When it differs from the computed GRN total, the response carries `invoice_total_mismatch_paisa`, and the UI warns. This is not an error (DECISION: supplier rounding conventions vary; the posted value is the line computation).

### 4.3 Valuation (`ledger.service.post`; PRD §8.1)

Input: a list of intended movements `{store_id, item_id, lot_id|null, kind, qty_base (signed), value_hint?, …}`, plus the transaction.

Algorithm, per movement, in this order:
1. Lock the balance rows involved. `SELECT … FOR UPDATE` on `stock_balances` for every `(store, item, lot)` key in the batch, ordered by `(store_id, item_id, lot_id NULLS FIRST)`, to avoid deadlocks. Missing rows are inserted first with `INSERT … ON CONFLICT DO NOTHING`, then locked.
2. **Inbound** (qty > 0):
   - `receive` / `opening_balance`: value = capitalised value.
   - `transfer_in` at the destination: value = round_half_up(r / d × V) for r received of d dispatched with dispatched value V. **Transit loss (08 A17 D-69)**, when r < d: at the source, on the same (store, item, lot) row as the `transfer_out`, in the same transaction, doc_type `transfer`: `transfer_in` +(d − r) at the remaining value V − round_half_up(r / d × V) (`value_basis = 'transfer'`), then `wastage` −(d − r) at the same value, reason = the line's `discrepancy_reason_code` (default `transit_loss`). The source nets −d; the paired `transfer_in` means the `wastage` row never raises `insufficient_stock` and never violates `stock_balances__lot_nonneg__ck`.
   - `return_to_store` / `adjust_in` / `count_adjust_in`: value = round_half_up(q × V/Q) when the row has Q > 0. Else, for a lot row, the lot's `last_receipt_value_paisa / last_receipt_qty_base` × q; for the unlotted row (no lot), q × the item's average cost in the store (step 4 avg_cost). Else 0 with `value_basis = 'none'`.
   - **Inbound into a negative row (08 A17 D-75)** — only the unlotted row can have Q < 0. For the row-valued kinds above (`return_to_store`, `adjust_in`, `count_adjust_in`), inbound q into a row with Q < 0 and value V: if q ≥ −Q, the first −Q units take value −V (clearing it) and the remainder q + Q is valued by the rule above; if q < −Q, value = round_half_up(q × V / Q). `receive` / `opening_balance` / `transfer_in` / `consume_reversal` keep their source-fixed value [CONV: the capitalised, dispatched and reversal values stay exact]. Golden cases cover both branches.
   - `consume_reversal`: value = exactly the negated value of the reversed movement (`value_basis = 'reversal'`).
3. **Outbound** (qty < 0, magnitude q) from a lot row (Q, V):
   - q = Q → value = −V;
   - q < Q → value = −round_half_up(q × V / Q);
   - q > Q is allowed **only** for `consume_*` kinds: split into −Q at −V on the lot row, plus the remainder on the unlotted row.
   - `count_adjust_out` with q > Q (a negative count variance larger than the lot row's quantity at posting, because consumption continued after counting — AC-19.4): split the same way (−Q on the lot row, the remainder on the unlotted row) and raise `negative_stock`; count posting never fails on the lot CHECK.
   - For every other kind, q > Q → `409 inventory.insufficient_stock`.
4. **Unlotted row** outbound (lot null, any quantity):
   - value = −round_half_up(q × avg_cost(item, store)), where avg_cost = Σ value / Σ qty over that store's lot rows with qty > 0 (the non-lot-tracked item's own unlotted row counts when its qty > 0);
   - fallback: the item's most recent `lots.last_receipt_*` in the tenant;
   - else 0 (`'none'`).
5. Update the balance (`qty_base += qty`, `value_paisa += value`, `version + 1`, `last_movement_at`). Insert the `stock_movements` row with `balance_qty_after`.
6. For kinds listed in `05-SCHEMA.md` §6.4, upsert `consumption_daily` (`INSERT … ON CONFLICT (key) DO UPDATE SET qty_consumed = qty_consumed + EXCLUDED…`).
7. After the batch, run the alert checks for the touched (store, item) pairs:
   - `below_reorder` raise/resolve;
   - `negative_stock` when an unlotted row of a lot-tracked item is < 0, or any unlotted row of a non-tracked item is < 0;
   - `expired_lot_in_use` (`alerts.service`, same transaction).

All arithmetic in steps 2–4 is one SQL statement per movement using `numeric`. TS never computes it.

### 4.4 FEFO ordering (`domain/fefo.ts`; PRD AC-18.1)

Candidates are lot rows in the store with qty > 0, lot `status = 'available'`, and `expiry_on IS NULL OR expiry_on ≥ today (tenant tz)`. Sort key, ascending:
1. `has_open_container` (open containers first: `0` if ∃ an open container of this lot in this store whose open_expiry_at is null or > now, else `1`);
2. `effective_expiry` = least(open container open_expiry_at (earliest open one), end of `expiry_on` day); null last;
3. `expiry_on` (nulls last);
4. `lots.created_at`;
5. `lot_id`.

The suggestion takes rows in order until the quantity is covered. The response gives `lines[] {lot_id, lot_no, expiry_on, effective_expiry_at, has_open_container, take_qty_base, available_qty_base}` and `shortfall_qty_base`.

Manual issue/transfer/wastage without an explicit lot uses the same ordering. With an explicit lot, the lot must be a candidate: an expired lot gives `inventory.lot_expired`; a quarantined or blocked lot gives `inventory.lot_unavailable` (CR-C12-003). Wastage and expiry write-off are allowed from expired lots (that is their purpose). Wastage from quarantined/blocked lots is also allowed.

### 4.5 Consumption lot selection (`consumers.service`)

For a consumption need (store S, item X, qty q):
1. **In-use lot.** Take the latest open container with `instrument_id = fact.instrument_id`, `item_id = X`, `store_id = S` (`opened_containers__tenant_id_in_use__p_idx`). If it exists and its lot row in S has qty > 0, take min(q, Q) from it. This applies **even if the lot is expired or quarantined**: the analyser physically used it. If the lot is past expiry, an `expired_lot_in_use` alert is raised.
2. The remainder comes from FEFO candidates (§4.4).
3. Anything still left goes to the unlotted row (§4.3 step 4), and a `negative_stock` alert is raised.

### 4.6 Numbering (`numbering.service`)
- Patterns are parsed by `domain/numbering.ts`. Tokens: `{yy}`, `{fy}`, `{fyl}`, `{seq:N}` (N 1–9), plus literal text matching `[A-Z0-9\-/]`. `{prefix}`, `{branch}` and `{centre}` are **not** supported in v1. Invalid patterns are rejected at settings update (`400 common.validation_failed`, 08 A13 P-1).
- The period key is derived from the pattern: `fy:<fyl>` if `{fy}` or `{fyl}` is present (fiscal year from `bsdate`, Shrawan 1 boundary — 04 L16); else `yy:<yy>` if `{yy}`; else `all`.
- Allocation is the counter-row SQL in `05-SCHEMA.md` §2.5, inside the document's transaction. Gaps are allowed: a rolled-back transaction may skip a number (DECISION: these are not fiscal numbers; IC §9.3 registry addition CR-C12-007; per the 03-IC §9.3 rule as amended by 08 §4.5, module-internal non-fiscal numbers live in the module's own settings table — `inventory.settings`).

### 4.7 Back-dating
Manual movements, documents and logs accept `occurred_at`. It must lie in [now − `backdate_max_days`, now + 300 s] (default 7 days [CONV]); otherwise `400 common.validation_failed`. `business_date` = `occurred_at` in the tenant timezone (`IdentityPort.getTenantSettings({keys:['timezone']})`).

## 5. Endpoints (`contracts/openapi/inventory.yaml`, prefix `/v1/inventory`)

Common to all operations:
- `security: [bearerJwt]`;
- `tags: [inventory]`;
- `x-rate-limit-tier: general` (CV §10.3: 10 req/s/user, burst 20);
- every response may also return `400 common.validation_failed`, `401 auth.*`, `403 auth.forbidden`, `404 common.not_found`, `429 common.rate_limited`, `500 common.internal` (listed once here, also present in every operation's `x-error-codes`);
- lists use cursor pagination (`limit` default 50, max 200) and `sort` enums (CV §4.3/4.4);
- `If-Match` is required on every PATCH/PUT of an existing record and on every action (`428 common.precondition_required` if missing, `409 common.version_conflict` on mismatch);
- `Idempotency-Key` (CV §4.5, 08 A13 P-8): **required** (R) on every POST that creates a row (master-data creates included), writes stock or commits money (#84 approve, #86 cancel, #87 close). Optional (O) only on two kinds of POST, each with this justification in the spec: (a) read-only POSTs (#10 lookup, #74 preview — no state written); (b) state transitions or flag changes on one existing row that require `If-Match` (#5, #9, #25, #32, #33, #39, #54, #62, #68, #73, #78, #85, #91) — a duplicate submit fails `409 common.version_conflict` or an invalid-transition code, and no row is created. No C12 operation uses `x-idempotency: none` (neither P-8 exception applies).

"Scope" column (`scope.service`, in this order):
- `branch(store)` = `assertStoreAccess(ctx, store, permission)`: (1) load the store (or the object, then its store) via RLS; unknown → `404 common.not_found`; (2) if `store.branch_id` ∉ `visibleBranchIds(getActor())` (`centreScope.all` ⇒ every branch) → `404 common.not_found` (the object is not visible, 07-SECURITY P-B1/P-B2); (3) `assertRole({permission, branchId: store.branch_id})` → `403 auth.forbidden` / `auth.mfa_required` on a missing permission or MFA.
- Transfers (`assertTransferAccess`): the transfer is **visible** when its `from` or `to` store's branch is visible (#56, #58); invisible → `404`. Each action then asserts the branch of the end it acts on: `branch(from)` for #59, #60, #62; `branch(to)` for #61 → `403 auth.forbidden` when that end is outside scope (P-B3).
- `tenant` = `assertRole({permission})` only.
- `+ <code> when <condition>` in the Permission column (08 A13 P-10): `x-permission` is the first code (the floor on every call); the extra code is checked in the handler with `IdentityPort.assertRole` right after loading the target, has a hand-written permission test, and `auth.forbidden` / `auth.mfa_required` are in the operation's `x-error-codes`.

### 5.1 Master data

| # | operationId | Method + path | Permission | Scope | Idem | Request (body/query) | Response | Extra error codes |
|---|---|---|---|---|---|---|---|---|
| 1 | listInventoryItems | GET `/items` | inventory.item.read | tenant | – | q: `category`, `is_active`, `q` (prefix ≤ 60, matches `item_code` or `lower(name)`; both have `text_pattern_ops` indexes), `barcode` not allowed (use #10), `sort` ∈ {`item_code`,`name`,`-updated_at`} | `{data: ItemSummary[], page}` | – |
| 2 | createInventoryItem | POST `/items` | inventory.master.manage | tenant | R | `ItemCreate` | 201 `Item` | `inventory.code_duplicate` |
| 3 | getInventoryItem | GET `/items/{item_id}` | inventory.item.read | tenant | – | – | `Item` (incl. packs, barcodes) | – |
| 4 | updateInventoryItem | PATCH `/items/{item_id}` | inventory.master.manage | tenant | – | `ItemPatch` + `unset[]` | `Item` | `common.immutable_record`, `common.version_conflict` |
| 5 | setInventoryItemActive | POST `/items/{item_id}/set-active` | inventory.master.manage | tenant | O | `{is_active: boolean}` | `Item` | `inventory.item_in_use` (deactivate with open PO lines or non-zero stock → 409; CR-C12-003) |
| 6 | createInventoryItemPack | POST `/items/{item_id}/packs` | inventory.master.manage | tenant | R | `{pack_code, label, uom_code, qty_in_base, is_purchase_default?}` | 201 `Pack` | `inventory.code_duplicate` |
| 7 | updateInventoryItemPack | PATCH `/items/{item_id}/packs/{pack_id}` | inventory.master.manage | tenant | – | `{label?, uom_code?, is_purchase_default?, is_active?}` (`qty_in_base` is not in the schema → `400 common.validation_failed`) | `Pack` | `common.immutable_record` (DB trigger on a direct change) |
| 8 | addInventoryItemBarcode | POST `/items/{item_id}/barcodes` | inventory.master.manage | tenant | R | `{barcode_value, pack_id?}` — the server upper-cases `barcode_value` before the insert (DB CHECK requires upper case) | 201 `Barcode` | `inventory.code_duplicate` |
| 9 | deactivateInventoryItemBarcode | POST `/items/{item_id}/barcodes/{barcode_id}/deactivate` | inventory.master.manage | tenant | O | – | `Barcode` | – |
| 10 | lookupInventoryBarcode | POST `/barcodes/lookup` | inventory.item.read | tenant | O | `{barcode_value}` — upper-cased by the server before the lookup | `{item: ItemSummary, pack?: Pack}` | – (unknown → 404) |
| 11 | listInventoryStores | GET `/stores` | inventory.item.read | visible branches; `purpose=transfer_target` → all active stores of the tenant | – | q: `branch_id`, `is_active`, `store_kind`, `purpose` ∈ {`manage` (default), `transfer_target`} | `{data: Store[], page}`; with `transfer_target` only `id, store_code, name, branch_id, branch_name` (DECISION: senders must see where they can send; no stock data exposed) | – |
| 12 | createInventoryStore | POST `/stores` | inventory.master.manage | branch(body.branch_id) | O | `{branch_id, store_code, name, store_kind, is_default_consumption?}` | 201 `Store` | `inventory.code_duplicate`; inactive or unknown branch → `400 common.validation_failed` at `/branch_id` (P-1) |
| 13 | getInventoryStore | GET `/stores/{store_id}` | inventory.item.read | branch(store) | – | – | `Store` | – |
| 14 | updateInventoryStore | PATCH `/stores/{store_id}` | inventory.master.manage | branch(store) | – | `{name?, store_kind?, is_default_consumption?, is_active?}` | `Store` | `inventory.store_not_empty` (deactivate) |
| 15 | listStoreItemSettings | GET `/stores/{store_id}/item-settings` | inventory.item.read | branch(store) | – | q: `below_reorder` (bool), `item_id` | `{data: StoreItemSetting[], page}` | – |
| 16 | putStoreItemSetting | PUT `/stores/{store_id}/item-settings/{item_id}` | inventory.master.manage | branch(store) | – | `{reorder_level_base?, reorder_qty_base?, max_level_base?, preferred_supplier_id?, is_stocked}` (If-Match only when the row exists) | `StoreItemSetting` | – |
| 17 | listInventorySuppliers | GET `/suppliers` | inventory.item.read | tenant | – | q: `q`, `is_active` | `{data: SupplierSummary[], page}` | – |
| 18 | createInventorySupplier | POST `/suppliers` | inventory.master.manage | tenant | R | `SupplierCreate` | 201 `Supplier` | `inventory.code_duplicate` |
| 19 | getInventorySupplier | GET `/suppliers/{supplier_id}` | inventory.item.read | tenant | – | – | `Supplier` | – |
| 20 | updateInventorySupplier | PATCH `/suppliers/{supplier_id}` | inventory.master.manage | tenant | – | `SupplierPatch` + `unset[]` | `Supplier` | – |
| 21 | listSupplierItems | GET `/suppliers/{supplier_id}/items` | inventory.item.read | tenant | – | q: `item_id` | `{data: SupplierItem[], page}` | – |
| 22 | putSupplierItem | PUT `/suppliers/{supplier_id}/items/{item_id}/packs/{pack_id}` | inventory.master.manage | tenant | – | `{supplier_item_code?, last_unit_price_paisa?, lead_time_days?, default_tax_code?, is_active}` | `SupplierItem` | `inventory.uom_mismatch` (pack of other item) |
| 23 | listInstrumentBindings | GET `/instrument-bindings` | inventory.item.read | visible branches | – | q: `store_id` | `{data: Binding[], page}` | – |
| 24 | putInstrumentBinding | PUT `/instrument-bindings/{instrument_id}` | inventory.master.manage | branch(body.store) | – | `{store_id}` | `Binding` | instrument unknown/other tenant → 404 (FK violation mapped) |
| 25 | deactivateInstrumentBinding | POST `/instrument-bindings/{instrument_id}/deactivate` | inventory.master.manage | branch(store) | O | – | `Binding` | – |
| 26 | getInventorySettings | GET `/settings` | inventory.item.read | tenant | – | – | `Settings` | – |
| 27 | updateInventorySettings | PUT `/settings` | inventory.master.manage | tenant | – | `SettingsUpdate` (all mutable fields). `consumption_enabled_at`, when it changes from NULL to a value, must be ≥ now − 3600 s (no retroactive deduction; UI S18) | `Settings` | `common.validation_failed` (pattern, ranges, `consumption_enabled_at` < now − 3600 s at `/consumption_enabled_at`) |
| 28 | listInventoryCodedSet | GET `/coded-sets/{set_name}` | inventory.item.read | tenant | – | path `set_name` ∈ {`uom`,`reasons`,`tax_codes`}; q: `reason_group` | `{data: Code[]}` (global ∪ tenant, tenant shadows) | – |
| 29 | putInventoryTenantCode | PUT `/coded-sets/{set_name}/codes/{code}` | inventory.master.manage | tenant | – | reasons: `{reason_group, display, sort_order?, is_active}`; tax_codes: `{display, is_active}` (no rate — 08 A2.2); `uom` → 404 (global only) | `Code` | – |

### 5.2 Stock, lots, containers

| # | operationId | Method + path | Permission | Scope | Idem | Request | Response | Extra errors |
|---|---|---|---|---|---|---|---|---|
| 30 | listInventoryLots | GET `/lots` | inventory.item.read | tenant | – | q: `item_id` (required), `status`, `expiring_before` (date) | `{data: Lot[], page}` | – |
| 31 | getInventoryLot | GET `/lots/{lot_id}` | inventory.item.read | tenant | – | – | `Lot` + balances in visible stores | – |
| 32 | setInventoryLotStatus | POST `/lots/{lot_id}/set-status` | inventory.stock.adjust (privileged) | tenant | O | `{status, reason_code}` | `Lot` | `inventory.reason_required` |
| 33 | correctInventoryLotExpiry | POST `/lots/{lot_id}/correct-expiry` | inventory.stock.adjust | tenant | O | `{expiry_on, reason_code}` (reason group `adjustment`) | `Lot` | `inventory.reason_required` |
| 34 | listStockBalances | GET `/stock` | inventory.item.read | branch(store) when `store_id`; else visible branches | – | q: `store_id`, `item_id`, `category`, `below_reorder`, `expiring_within_days` (1–365), `expired_only` (boolean, default false: lots with `expiry_on` < today in tenant time), `include_zero` (default false) | `{data: BalanceRow[], page}` (`BalanceRow`: store_id, item_id, item_code, item_name, lot_id?, lot_no?, expiry_on?, lot_status?, qty_base, available_qty_base, has_open_container, reorder_level_base?, value_paisa†, avg_unit_cost_paisa_x1e6† (integer: average cost per base unit × 10⁶, i.e. micro-paisa)) | – |
| 35 | listStockMovements | GET `/movements` | inventory.item.read | as #34 | – | q: `store_id`, `item_id`, `lot_id`, `movement_kind` (csv), `occurred_at_from/_to`, `doc_type`, `doc_id`, `instrument_id`, `attributed_test_id`; sort `-occurred_at` | `{data: Movement[], page}` | – |
| 36 | getFefoSuggestion | GET `/fefo-suggestions` | inventory.item.read | branch(store) | – | q: `store_id`, `item_id`, `qty_base` | `FefoSuggestion` (§4.4) | – |
| 37 | listOpenedContainers | GET `/containers` | inventory.item.read | branch(store) | – | q: `store_id` (required), `instrument_id`, `status` (default `open`) | `{data: Container[], page}` | – |
| 38 | openContainer | POST `/containers` | inventory.bench.record | branch(store) | R | `{store_id, item_id, lot_id?, instrument_id?, opened_at?, notes?}` | 201 `Container` | `inventory.lot_expired` (opening an expired lot is refused), `inventory.lot_unavailable`, `inventory.insufficient_stock` (lot row qty ≤ 0) |
| 39 | finishContainer | POST `/containers/{container_id}/finish` | inventory.bench.record | branch(store) | O | `{finished_at?}` | `Container` | `inventory.document_invalid_transition` |
| 40 | discardContainer | POST `/containers/{container_id}/discard` | inventory.bench.record | branch(store) | R | `{qty_base, reason_code (wastage group), reason_text?}` | `{container, document: StockDocument}` | `inventory.reason_required`, `inventory.document_invalid_transition` |

† money field, returned only with `inventory.cost.read` (§6.3).

### 5.3 Documents

| # | operationId | Method + path | Permission | Scope | Idem | Request | Response | Extra errors |
|---|---|---|---|---|---|---|---|---|
| 41 | listStockDocuments | GET `/stock-documents` | inventory.item.read | as #34 | – | q: `store_id`, `doc_kind`, `occurred_at_from/_to` | `{data: StockDocumentSummary[], page}` | – |
| 42 | getStockDocument | GET `/stock-documents/{document_id}` | inventory.item.read | branch(store) | – | – | `StockDocument` (+ lines, movements) | – |
| 43 | createStockIssue | POST `/issues` | inventory.stock.manage | branch(store) | R | `{store_id, occurred_at?, issued_to_kind, department_id?, instrument_id?, reason_text?, lines[1..200]: {item_id, lot_id?, qty, pack_id?}}` | 201 `StockDocument` | `inventory.insufficient_stock`, `inventory.lot_expired`, `inventory.lot_unavailable`, `inventory.item_inactive`, `inventory.uom_mismatch`, `inventory.store_locked_for_count` |
| 44 | createStoreReturn | POST `/store-returns` | inventory.stock.manage | branch(store) | R | `{store_id, occurred_at?, reason_text?, lines: {item_id, lot_id?, qty, pack_id?}}` | 201 `StockDocument` | as #43 minus insufficient |
| 45 | createSupplierReturn | POST `/supplier-returns` | inventory.stock.manage | branch(store) | R | `{store_id, supplier_id, grn_id?, reason_code, reason_text?, lines: {item_id, lot_id, qty, pack_id?}}` | 201 `StockDocument` | `inventory.insufficient_stock`, `inventory.reason_required` |
| 46 | recordWastage | POST `/wastage` | inventory.stock.manage | branch(store) | R | `{store_id, occurred_at?, reason_code, reason_text?, lines: {item_id, lot_id?, qty, pack_id?, reason_code?}}` | 201 `StockDocument` | `inventory.reason_required`, `inventory.insufficient_stock` |
| 47 | writeOffExpiredStock | POST `/expiry-writeoffs` | inventory.stock.manage | branch(store) | R | `{store_id, lot_ids[1..200]}` | 201 `StockDocument` | per-line `common.validation_failed` (lot not expired / no stock) |
| 48 | createStockAdjustment | POST `/adjustments` | inventory.stock.adjust (privileged) | branch(store) | R | `{store_id, occurred_at?, reason_code, reason_text?, lines: {item_id, lot_id?, direction, qty, pack_id?}}` | 201 `StockDocument` | `inventory.reason_required`, `inventory.insufficient_stock` (out), `inventory.store_locked_for_count` |

### 5.4 Goods receipts

| # | operationId | Method + path | Permission | Scope | Idem | Request | Response | Extra errors |
|---|---|---|---|---|---|---|---|---|
| 49 | listGoodsReceipts | GET `/goods-receipts` | inventory.item.read | as #34 | – | q: `store_id`, `status`, `supplier_id`, `po_id`, `received_at_from/_to` | `{data: GrnSummary[], page}` | – |
| 50 | createGoodsReceipt | POST `/goods-receipts` | inventory.stock.manage + `inventory.stock.adjust` (privileged) when `kind = opening_balance` | branch(store) | R | `GrnDraft` = `{kind, store_id, supplier_id?, po_id?, received_at?, supplier_invoice_no?, supplier_invoice_on?, supplier_invoice_total_paisa?, notes?, lines[1..200]: {po_line_id?, item_id, pack_id, qty_packs, lot_no?, expiry_on?, manufactured_on?, unit_price_paisa?, discount_paisa?, tax_code?, is_exempt? (default false; D-70)}}`. `x-permission` is `inventory.stock.manage` (P-10) | 201 `Grn` (status draft) | `inventory.po_invalid_transition` (PO not approved/sent/partially_received), `common.validation_failed` |
| 51 | getGoodsReceipt | GET `/goods-receipts/{grn_id}` | inventory.item.read | branch(store) | – | – | `Grn` | – |
| 52 | replaceGoodsReceiptDraft | PUT `/goods-receipts/{grn_id}` | inventory.stock.manage | branch(store) | – | `GrnDraft` minus `kind`, `store_id` (lines incl. `is_exempt`; replace per §5.11) | `Grn` | `inventory.document_invalid_transition` |
| 53 | postGoodsReceipt | POST `/goods-receipts/{grn_id}/post` | inventory.stock.manage + `inventory.stock.adjust` when the GRN `kind = opening_balance` | branch(store) | R | – | `Grn` (posted, with lot ids + movements) | `inventory.document_invalid_transition`, `inventory.over_receipt`, `inventory.lot_expired`, `inventory.store_locked_for_count`, `common.validation_failed` (lot/expiry missing) |
| 54 | cancelGoodsReceipt | POST `/goods-receipts/{grn_id}/cancel` | inventory.stock.manage | branch(store) | O | `{reason_text}` | `Grn` | `inventory.document_invalid_transition` |
| 55 | exportGoodsReceiptsCsv | GET `/goods-receipts/export.csv` | inventory.report.export (privileged) + `inventory.cost.read` (always; the export is money-only) | visible branches | – | q: `posted_at_from/_to` (≤ 366 days), `store_id?` | `text/csv` attachment; `access_log` `data.export` (§5.10) | `inventory.export_too_large` |

### 5.5 Transfers

| # | operationId | Method + path | Permission | Scope | Idem | Request | Response | Extra errors |
|---|---|---|---|---|---|---|---|---|
| 56 | listTransfers | GET `/transfers` | inventory.item.read | from or to store visible | – | q: `from_store_id`, `to_store_id`, `status` | `{data: TransferSummary[], page}` | – |
| 57 | createTransfer | POST `/transfers` | inventory.stock.manage | branch(from) | R | `{from_store_id, to_store_id, notes?, lines[1..200]: {item_id, lot_id?, qty, pack_id?}}` | 201 `Transfer` (draft) | `inventory.uom_mismatch` |
| 58 | getTransfer | GET `/transfers/{transfer_id}` | inventory.item.read | from or to visible | – | – | `Transfer` | – |
| 59 | replaceTransferDraft | PUT `/transfers/{transfer_id}` | inventory.stock.manage | branch(from) | – | as create minus stores; current lines are marked removed and the request lines inserted (D-71, §5.11) | `Transfer` | `inventory.document_invalid_transition` |
| 60 | dispatchTransfer | POST `/transfers/{transfer_id}/dispatch` | inventory.stock.manage | branch(from) | R | – | `Transfer` | `inventory.insufficient_stock`, `inventory.lot_expired`, `inventory.lot_unavailable`, `inventory.store_locked_for_count`, `inventory.document_invalid_transition` |
| 61 | receiveTransfer | POST `/transfers/{transfer_id}/receive` | inventory.stock.manage | branch(to) | R | `{lines: {line_id, received_qty_base, discrepancy_reason_code?}[]}` (all lines required) | `Transfer` | `inventory.reason_required`, `inventory.document_invalid_transition`, `inventory.store_locked_for_count` |
| 62 | cancelTransfer | POST `/transfers/{transfer_id}/cancel` | inventory.stock.manage | branch(from) | O | `{reason_text}` | `Transfer` | `inventory.document_invalid_transition` |

### 5.6 Stock counts

| # | operationId | Method + path | Permission | Scope | Idem | Request | Response | Extra errors |
|---|---|---|---|---|---|---|---|---|
| 63 | listStockCounts | GET `/stock-counts` | inventory.item.read | as #34 | – | q: `store_id`, `status` | `{data: CountSummary[], page}` | – |
| 64 | openStockCount | POST `/stock-counts` | inventory.stock.manage | branch(store) | R | `{store_id, scope_category?, notes?}` | 201 `Count` (lines with snapshot) | `inventory.count_already_open` (CR-C12-003) |
| 65 | getStockCount | GET `/stock-counts/{count_id}` | inventory.item.read | branch(store) | – | q: `limit/cursor` for lines | `Count` | – |
| 66 | recordStockCountLines | PUT `/stock-counts/{count_id}/lines` | inventory.stock.manage | branch(store) | – | `{lines[1..200]: {line_id?, item_id, lot_id?, counted_qty_base, counted_at?, reason_code?}}` (new item/lot pairs found on the shelf create lines with `book_qty_snapshot` = current balance, or 0 if none) | `{updated: n, lines: CountLine[]}` | `inventory.document_invalid_transition` |
| 67 | postStockCount | POST `/stock-counts/{count_id}/post` | inventory.stock.adjust (privileged) | branch(store) | R | `{uncounted_policy: 'skip' \| 'zero'}` | `Count` (posted, variances) | `inventory.document_invalid_transition` |
| 68 | cancelStockCount | POST `/stock-counts/{count_id}/cancel` | inventory.stock.manage | branch(store) | O | – | `Count` | `inventory.document_invalid_transition` |

### 5.7 Consumption

| # | operationId | Method + path | Permission | Scope | Idem | Request | Response | Extra errors |
|---|---|---|---|---|---|---|---|---|
| 69 | listConsumptionRules | GET `/consumption-rules` | inventory.item.read | tenant | – | q: `rule_kind`, `test_id`, `instrument_id`, `item_id`, `current_only` (default true) | `{data: Rule[], page}` | – |
| 70 | createConsumptionRule | POST `/consumption-rules` | inventory.master.manage | tenant | R | `{rule_kind, test_id?, analyte_id?, instrument_id?, item_id, qty, pack_id?, notes?}` | 201 `Rule` | `inventory.rule_conflict` (CR-C12-003: a current rule exists for the key → use supersede), `inventory.uom_mismatch`, `common.validation_failed` (shape; analyte not of test — checked via `CatalogPort.getTest`) |
| 71 | getConsumptionRule | GET `/consumption-rules/{rule_id}` | inventory.item.read | tenant | – | – | `Rule` (+ history chain) | – |
| 72 | supersedeConsumptionRule | POST `/consumption-rules/{rule_id}/supersede` | inventory.master.manage | tenant | R | `{qty, pack_id?, notes?}` | 201 `Rule` (new) | `inventory.document_invalid_transition` (rule not current) |
| 73 | deactivateConsumptionRule | POST `/consumption-rules/{rule_id}/deactivate` | inventory.master.manage | tenant | O | – | `Rule` | – |
| 74 | previewConsumption | POST `/consumption-rules/preview` | inventory.item.read | tenant | O | `{fact_kind, test_id?, analyte_id?, instrument_id?, at?}` | `{store_id?, store_resolution_step, lines: {rule_id, item_id, qty_base, lot_id?, est_value_paisa†}[]}` (dry run; no writes) | – |
| 75 | listConsumptionFacts | GET `/consumption-facts` | inventory.item.read | visible branches: facts whose `store_id` is in a visible branch, plus facts with `store_id` NULL (`no_rule`/`unresolved`); embedded `movements[]` follow the same rule | – | q: `status`, `fact_kind`, `instrument_id`, `test_id`, `business_date_from/_to` | `{data: Fact[], page}` | – |
| 76 | logConsumptionEvent | POST `/consumption-events` | inventory.bench.record | tenant; when rules match and a store is resolved, that store's branch must be in the caller's scope, else `403 auth.forbidden` and nothing is written; `no_rule` and `unresolved` facts need tenant scope only | R | `{fact_kind: 'calibration' \| 'qc', instrument_id?, test_id, analyte_id?, occurred_at, observations? (qc, 1–50), reason_code? (calibration group, required for calibration), note?}` | 201 `Fact` (posted / no_rule / unresolved) | `common.validation_failed` |
| 77 | resolveConsumptionFact | POST `/consumption-facts/{fact_id}/resolve` | inventory.master.manage | branch(body.store) | R | `{store_id}` | `Fact` (posted) | `inventory.document_invalid_transition` |
| 78 | dismissConsumptionFact | POST `/consumption-facts/{fact_id}/dismiss` | inventory.master.manage | tenant | O | `{reason_code}` (group `fact_dismiss`) | `Fact` | `inventory.document_invalid_transition`, `inventory.reason_required` |
| 79 | reverseConsumptionFact | POST `/consumption-facts/{fact_id}/reverse` | inventory.stock.adjust (privileged) | branch(fact store) | R | `{reason_code}` (group `fact_reverse`) | `Fact` (reversed) | `inventory.fact_not_reversible` (source ≠ manual), `inventory.document_invalid_transition` |

### 5.8 Purchase orders

| # | operationId | Method + path | Permission | Scope | Idem | Request | Response | Extra errors |
|---|---|---|---|---|---|---|---|---|
| 80 | listPurchaseOrders | GET `/purchase-orders` | inventory.item.read | visible branches | – | q: `status`, `supplier_id`, `branch_id`, `created_at_from/_to` | `{data: PoSummary[], page}` | – |
| 81 | createPurchaseOrder | POST `/purchase-orders` | inventory.po.manage | branch(store) | R | `{supplier_id, store_id, expected_on?, notes?, lines[1..200]: {item_id, pack_id, qty_packs, unit_price_paisa?, discount_paisa?, tax_code?, is_exempt? (default false)}}` (unit price defaults to the supplier item price; with `is_exempt` false and `tax_code` absent the code defaults to supplier item → item → `VAT`; `is_exempt: true` = exempt line: `tax_code` must be absent, no `getTaxRate` call — 08 A4.1, A17 D-70, §4.2) | 201 `Po` (draft) | `inventory.uom_mismatch`, `inventory.item_inactive` |
| 82 | getPurchaseOrder | GET `/purchase-orders/{po_id}` | inventory.item.read | branch(PO) | – | – | `Po` (+ receipts summary) | – |
| 83 | replacePurchaseOrderDraft | PUT `/purchase-orders/{po_id}` | inventory.po.manage | branch(PO) | – | as create (store and supplier changeable in draft; lines incl. `is_exempt`; replace per §5.11) | `Po` | `inventory.po_invalid_transition` |
| 84 | approvePurchaseOrder | POST `/purchase-orders/{po_id}/approve` | inventory.po.approve (privileged) | branch(PO) | R | – | `Po` | `inventory.po_invalid_transition`, `inventory.po_self_approval_forbidden`, `common.validation_failed` (no lines) |
| 85 | markPurchaseOrderSent | POST `/purchase-orders/{po_id}/mark-sent` | inventory.po.manage | branch(PO) | O | `{sent_channel, sent_reference?}` | `Po` | `inventory.po_invalid_transition` |
| 86 | cancelPurchaseOrder | POST `/purchase-orders/{po_id}/cancel` | inventory.po.manage + `inventory.po.approve` (privileged) when the PO status ∈ {`approved`, `sent`} | branch(PO) | R | `{reason_code, reason_text?}` | `Po` | `inventory.po_invalid_transition`, `inventory.reason_required` |
| 87 | closePurchaseOrder | POST `/purchase-orders/{po_id}/close` | inventory.po.manage | branch(PO) | R | `{reason_code?, reason_text?}` (reason required when open quantity > 0) | `Po` | `inventory.po_invalid_transition`, `inventory.reason_required` |
| 88 | createPurchaseOrdersFromReorder | POST `/purchase-orders/from-reorder` | inventory.po.manage | branch(store) | R | `{store_id, item_ids?[≤200]}`; per item the supplier item is the (preferred supplier, item) row with the item's `is_purchase_default` pack if active, else the active one with the largest `qty_in_base`; qty = `reorder_qty_base` rounded up to whole packs (AC-20.4) | 201 `{created: PoSummary[], skipped: {item_id, reason: 'no_preferred_supplier' \| 'no_pack' \| 'not_below_reorder' \| 'open_po_exists'}[]}` | – |
| 89 | getPurchaseOrderPrintView | GET `/purchase-orders/{po_id}/print-view` | inventory.cost.read + `inventory.item.read` (always) | branch(PO) | – | – | `PoPrintView` (header, tenant display name via `ctx.core.tenant`, branch, supplier, lines with prices) | – (draft → returned with `is_draft: true`, UI watermarks "DRAFT") |

### 5.9 Alerts and reports

| # | operationId | Method + path | Permission | Scope | Idem | Request | Response | Extra errors |
|---|---|---|---|---|---|---|---|---|
| 90 | listInventoryAlerts | GET `/alerts` | inventory.item.read | visible branches (+ tenant-wide alerts without store) | – | q: `status` (default `open,acknowledged`), `alert_kind`, `store_id` | `{data: Alert[], page}` | – |
| 91 | acknowledgeInventoryAlert | POST `/alerts/{alert_id}/acknowledge` | inventory.stock.manage | branch(store) or tenant | O | – | `Alert` | `inventory.document_invalid_transition` |
| 92 | getInventoryReport | GET `/reports/{report_code}` | inventory.item.read + `inventory.cost.read` when `report_code = cost_per_test` (other reports: cost fields only with it, §6.3) | visible branches; `consumption_reconciliation` additionally needs `centreScope.all`, else `403 auth.forbidden` [CONV: `lab.v_pub_result_daily` is centre-scoped for the caller, so a partial lab side would show false differences] | – | path `report_code` ∈ {`daily_consumption`, `analyser_consumption`, `cost_per_test`, `wastage`, `expiry`, `stock_valuation`, `consumption_reconciliation`}; q: `business_date_from`, `business_date_to` (inclusive from, exclusive to — CV §4.4; ≤ 366 days), `store_id?`, `branch_id?`, `instrument_id?`, `test_id?`, `item_id?`, `as_of?` (stock_valuation), `within_days?` (expiry, default `expiry_alert_days`), `group_by?` (per report, enum) | `ReportResult` = `{report_code, params, columns: ColumnMeta[], rows: object[], totals: object, generated_at, truncated: boolean}`; rows capped at 5,000 on screen [CONV] (CSV up to 50,000) | `inventory.range_too_large` (CR-C12-003) |
| 93 | exportInventoryReport | GET `/reports/{report_code}/export.csv` | inventory.report.export (privileged) + `inventory.cost.read` when `report_code = cost_per_test` | visible branches (same `centreScope.all` rule as #92 for `consumption_reconciliation`) | – | same as #92 | `text/csv` attachment; `access_log` `data.export` | `inventory.export_too_large`, `inventory.range_too_large` |

`cost_per_test` without `inventory.cost.read` → `403 auth.forbidden` (the report is money-only). `stock_valuation` without cost → quantities only.

### 5.10 Access-log calls (08 A13 P-3)

| Operation | `ctx.audit.access` action | entityType |
|---|---|---|
| #93 exportInventoryReport | `data.export` | `inventory_report` |
| #55 exportGoodsReceiptsCsv | `data.export` | `inventory_grn_export` [CONV] |

No other C12 operation writes an access-log row (C12 holds no PHI). `data.export` is an existing 03-IC §13.1 code.

### 5.11 Draft-line replace (08 A17 D-71)

`replacePurchaseOrderDraft` (#83), `replaceGoodsReceiptDraft` (#52) and `replaceTransferDraft` (#59) never delete. In one transaction, every current line (`removed_at IS NULL`) of the draft is marked removed (`removed_at = now()`, `removed_by = actor`), then the request lines are inserted (new ids, `line_no` 1…n; the line uniques are partial `WHERE removed_at IS NULL`) [CONV: the request carries no line ids, so every current line is "absent"]. Reads and totals filter `removed_at IS NULL`.

Report row definitions (columns are fixed; the spec enumerates them):

| report_code | Row grain | Columns (cost columns †) | Source |
|---|---|---|---|
| daily_consumption | business_date × store × item × movement_kind | business_date, store_id, store_code, item_id, item_code, item_name, base_uom_code, movement_kind, qty_consumed, value_consumed_paisa†, movements | `consumption_daily` |
| analyser_consumption | instrument × item × movement_kind (period) + per-test count block | instrument_id, instrument_label (`display_name` from `instruments.v_pub_instrument_directory`, CR-C9-006; else id), item_id, item_code, movement_kind, qty_consumed, value_consumed_paisa†; `tests[]`: test_id, test_code, tests_counted, rerun_events, qc_events | `consumption_daily`, `test_counts_daily`, `catalog.v_pub_test_directory` |
| cost_per_test | test × instrument (period) | test_id, test_code, test_name, instrument_id, tests_counted, direct_value_paisa, fixed_value_on_instrument_paisa, fixed_share_paisa, cpt_direct_paisa, cpt_loaded_paisa, cpt_standard_paisa, standard_is_complete, breakdown{consume_test, consume_analyte, consume_rerun, consume_qc, consume_calibration} (all †) | §8.6 |
| wastage | store × item × category (`recorded:<reason>`, `expiry_writeoff`, `count_variance`) | store_id, item_id, item_code, category, qty, value_paisa† | `consumption_daily` (wastage/expiry/count kinds) + `stock_movements` (reason codes for wastage) |
| expiry | store × lot | store_id, item_id, item_code, lot_id, lot_no, expiry_on, days_to_expiry, qty_base, value_paisa†, lot_status, has_open_container | `stock_balances` + `lots` |
| stock_valuation | store × item × lot (as_of) | store_id, item_id, item_code, lot_id, lot_no, qty_base, value_paisa†, avg_unit_cost_paisa_x1e6† | now: `stock_balances`; as_of: Σ `stock_movements` with `occurred_at < as_of` |
| consumption_reconciliation | business_date × test (+ instrument block) | business_date, test_id, test_code, c12_verified_result_events, lab_results_verified, diff, diff_bp; instrument block (D-74): instrument_id, business_date, c12_qc_observations (`instrument_qc_daily.qc_observations`), instrument_qc_records (`v_pub_message_daily.qc_records`), diff; unresolved/dismissed fact counts | `test_counts_daily`, `instrument_qc_daily`, `lab.v_pub_result_daily`, `instruments.v_pub_message_daily`, `consumption_facts` |

## 6. DTOs, validation, field allowlists

### 6.1 Validation rules (spec-level; CV §4.7)
- Every object has `additionalProperties: false`. Strings have `maxLength` equal to the DB limit in `05-SCHEMA.md` §2. Arrays have `maxItems` (lines ≤ 200 per request; DB allows 500 lines per document so that two edits can merge [CONV]).
- Base-unit quantities use the `DecimalStringPositive` pattern `^[0-9]{1,12}(\.[0-9]{1,6})?$` plus a server check > 0.
- Pack quantities (`qty_packs` on #50, #52, #81, #83) use `DecimalStringPacks` = `^[0-9]{1,9}(\.[0-9]{1,3})?$` plus a server check > 0, matching the DB type `numeric(12,3)` (no silent rounding, no overflow).
- Purchase lines: `is_exempt: boolean` (default false); `is_exempt: true` with `tax_code` present → `400 common.validation_failed` at `/lines/n/tax_code` (D-70). `tax_code` is never `null` on the wire (CV §4.2).
- Money: `integer`, `minimum: 0`, `maximum: 9007199254740991`.
- Dates: `format: date`. Instants: the `IsoUtc` pattern.
- The request schemas declare none of these fields: `tenant_id`, `created_by`, `status`, totals, `net_paisa`, `vat_paisa`, `line_total_paisa`, `capitalised_value_paisa`, `lot_id` on GRN lines, `value_paisa` on movement lines (CV §4.7: server authority).

### 6.2 Response DTO core fields (abbreviated; C0 writes full schemas from these)
- `Item`: id, item_code, name, category, base_uom_code, manufacturer?, catalogue_no?, storage_condition?, is_lot_tracked, requires_expiry, open_stability_days?, container_qty_base?, hs_code?, default_tax_code?, notes?, is_active, version, packs[], barcodes[], updated_at.
- `Store`: id, branch_id, branch_name (from `ctx.core.branch`), store_code, name, store_kind, is_default_consumption, is_active, version.
- `Lot`: id, item_id, lot_no, expiry_on?, manufactured_on?, status, status_reason_code?, version, `last_receipt_unit_cost_paisa_x1e6`†.
- `Movement`: id, occurred_at, business_date, store_id, item_id, lot_id?, lot_no?, movement_kind, qty_base, balance_qty_after, value_paisa†, value_basis†, doc_type, doc_id, doc_no?, instrument_id?, attributed_test_id?, rule_id?, reason_code?, created_by_display (from `ctx.core.user`).
- `Po` / `Grn`: header + lines (non-removed only); amounts†; `version`; for `Po`: `open_qty_base` per line. Each line carries `is_exempt`; `tax_code` is omitted on exempt lines (D-70).
- `Fact`: id, fact_kind, source, status, instrument_id?, test_id?, analyte_id?, occurred_at, business_date, multiplier, store_id?, rules_applied, value_paisa_total†, reason_code?, note?, movements[]. **`basis_key` and `source_event_id` are never returned** (P1, internal).
- `Alert`: id, alert_kind, status, store_id?, item_id?, lot_id?, instrument_id?, test_id?, first_raised_at, last_raised_at, occurrences, details (numbers/codes), version.

### 6.3 Cost field allowlist (REQ-SEC-081)
Mappers take `ctx.actorProfile.permissions`. When `inventory.cost.read` is absent:
- omit every property ending in `_paisa` or `_paisa_x1e6`, and `value_basis`;
- `previewConsumption` omits `est_value_paisa`;
- report `columns` drop † columns;
- `cost_per_test` / PO print view / GRN export → `403 auth.forbidden`.

Unit test: every DTO with a cost field has a test with and without the permission.

## 7. Ports

### 7.1 Implemented
None. C12 owns no port (CM §5.1).

### 7.2 Consumed (signatures verbatim from IC §4)

```ts
// IdentityPort (IC §4.6)
getActor(ctx: RequestContext): Promise<ActorProfile>;
assertRole(ctx: RequestContext, requirement: { permission: PermissionCode; centreId?: Uuidv7; branchId?: Uuidv7 }): Promise<void>;
getTenantSettings<K extends TenantSettingKey>(ctx: RequestContext, input?: { keys?: readonly K[] }): Promise<Pick<TenantSettings, K>>;
// CatalogPort (IC §4.2)
getTest(ctx: RequestContext, input: { testId: Uuidv7; asOf?: IsoUtc; requireActive?: boolean }): Promise<TestDefinition>;
/** @throws catalog.tax_config_missing — 08 A2.2, CR-C12-010; signature per 08 A4.1 (03-IC §4.2). No 'exempt' kind: exemption is a
 *  treatment — C12 never calls getTaxRate for an exempt line (no tax code). effectiveFrom is null for the global VAT row. */
getTaxRate(ctx: RequestContext, input: { taxCode: string; on: string /* ISO date, tenant timezone */ }): Promise<{ taxCode: string; ratePercentBasisPoints: number; kind: 'vat' | 'other'; effectiveFrom: string | null }>;
```

| Call site | Purpose | Failure handling |
|---|---|---|
| every handler | `assertRole` with `branchId` for store-bound operations, after the visibility check (§5 Scope: invisible branch → 404 first) | `auth.forbidden` / `auth.mfa_required` pass through |
| list handlers | `getActor().branchIds` (explicit `core.membership_branches` grants, 08 R3) and `centreScope.all` (implies all branches) → visible branch set for filters | — |
| business-date computation | `getTenantSettings({keys:['timezone']})` (cached per request/job) | errors propagate (fail closed: a wrong business date would corrupt reports); consumers retry per CV §7.5 |
| rule create/supersede/preview | `getTest({testId, requireActive: false})`; check `analyteId ∈ test.analytes` (for per_analyte / per_qc with analyte) | `common.not_found` → `400 common.validation_failed` at `/test_id` (P-1) |
| standard CPT | `getTest({testId, asOf})` → reportable analytes | missing → report row `standard_is_complete = false` |
| PO/GRN line write (#50, #52, #81, #83) | `getTaxRate({taxCode, on})` → `ratePercentBasisPoints` snapshotted into `tax_rate_bp` (§4.2); not called for an exempt line (`is_exempt: true`, stored `tax_code` NULL, 08 A4.1, D-70) | `catalog.tax_config_missing` → `422` rethrown unchanged (P-23), request rejected, nothing written |

`ctx.core` (C0 02-TRD §6.8): `branch`, `branches`, `centre` (centre → branch for QC/rerun events), `tenant` (display name for the PO print view), `user` (display names for `created_by_display` and the print view's approved-by name, memoised per request — 08 A17 P-17; C12 has no staff picker and never reads `core.memberships`). Fakes come from `packages/fakes` (IdentityPort, CatalogPort). `ctx.core` uses the seeded test DB.

## 8. Events

### 8.0 Produced
None (CM §5.1 lists no `inventory.*` event; manifest `produces: []`).

### 8.1 Consumed — common wrapper

All four follow CV §7.4. Each runs in the worker with system claims, has an inbox row in `inventory.event_inbox`, uses `max_attempts` 10, and consumers validate only the fields they use. Absent optional fields are tolerated: C12 never reads `specimen_id` or `verified_by_membership_id` of `lab.result.verified.v1` (08 A13 D-2), and an absent `instrument_id` / `processing_branch_id` only changes store resolution (§8.2).

Steps common to all four handlers (order per 08 A17 D-73 / D-74; one transaction):
1. **Inbox insert.** If it conflicts → return (duplicate).
2. **Business date** = the occurrence time in the tenant timezone. Occurrence time: `payload.verified_at` for `lab.result.verified.v1`; `payload.received_at` for QC, rerun and calibration events.
3. **Event-level counters**, for every non-duplicate event, **before** the filter and the switch gate (D-73, D-74):
   - `lab.result.verified.v1`: `test_counts_daily.verified_result_events += 1` for (business_date, `instrument_id` ?? null, `test_id`) (each verification is an event in `lab.v_pub_result_daily`, so re-verifications count on both sides);
   - `instruments.qc.received.v1`: `instrument_qc_daily.qc_observations += 1` for (business_date, `instrument_id`), mapped or not.
   Both are `INSERT … ON CONFLICT (<key>) DO UPDATE SET <counter> = <counter> + 1` (P-22: the row is created on first use).
4. **Filter** (table below). Not passed → return (metric `lims_inventory_events_skipped_total{reason}`).
5. **Switch gate.** If `settings.consumption_enabled_at` is null, or the occurrence time < `consumption_enabled_at` → return (AC-12.5). The gate applies to steps 6–7 only; steps 1–3 have already been written, so the reconciliation report works while consumption is off (PLAN §5 trial week).
6. **Facts.** For each candidate fact of the event (table below), in this order (fixes the insert-status ambiguity):
   1. match rules (§8.3) at the occurrence time; if at least one rule matched, resolve the store (§8.2);
   2. INSERT the `consumption_facts` row **with its final status** (`posted` when rules matched and a store resolved; `no_rule` when no rule matched; `unresolved` when rules matched but no store resolved), `rules_applied`, `store_id` and `value_paisa_total = 0`: `INSERT … ON CONFLICT (tenant_id, basis_key) DO NOTHING RETURNING id`;
   3. no row returned → the fact already exists → nothing more for this fact;
   4. row returned and status `posted` → post the movements (§4.3/§4.5/§8.4), then `UPDATE … SET value_paisa_total = <sum>` (same status; a same-status update of a mutable column is allowed, `05-SCHEMA.md` §7).
   For `lab.result.verified.v1` the two facts are evaluated **independently**: fact (a) is always attempted; fact (b) is attempted whenever an active `per_analyte` rule exists for (test_id, analyte_id) at the occurrence time, **whether or not fact (a) was newly inserted**. Steps 6.2–6.4 run for each fact that was newly inserted; the handler returns only when neither was inserted. Contract test: CBC with 20 analyte events and a `per_analyte` rule on each analyte → 20 `consume_analyte` movements + 1 `consume_test` (AC-12.2).
7. **Fact-level counters** in `test_counts_daily` (written only for a newly inserted fact, so never while the switch is off): `tests_counted` (fact (a)), `rerun_events` (rerun fact), `qc_events` (+1 per **distinct** attributed test of a newly inserted QC fact; none when no rule matched — D-74).
8. Commit. Thrown errors roll back everything, and Graphile Worker retries (CV §7.5). After the final failure the job goes to `core.dead_letters` (C0), and the metric `lims_inventory_consumer_failures_total` increments.

| Event | Filter (step 4) | Facts and basis keys (step 6) | Payload fields read |
|---|---|---|---|
| `lab.result.verified.v1` (IC §3.9) | none | (a) `test:<order_item_id>:<test_id>` — fact_kind `test`, instrument_id = `payload.instrument_id` (may be absent), test_id, department_id, processing_branch_id; (b) when an active `per_analyte` rule exists for (test_id, analyte_id): `analyte:<result_id>` — fact_kind `analyte` | `result_id`, `order_item_id`, `test_id`, `analyte_id`, `department_id`, `instrument_id?`, `processing_branch_id?` (CR-C12-004; §8.2 step 3), `verified_at` |
| `instruments.result.received.v1` (IC §3.14) | `is_rerun = true` AND `mapping_status = 'mapped'` AND `test_id` present | `rerun:<instrument_message_id>:<test_id>` — fact_kind `rerun`, instrument_id, centre_id | `instrument_message_id`, `instrument_id`, `centre_id`, `test_id?`, `mapping_status`, `is_rerun?`, `received_at` |
| `instruments.calibration.received.v1` (IC §3.26; CR-C12-006, 08 R13) | `mapping_status = 'mapped'` AND `test_id` present | `cal:<sha256_hex(envelope.idempotency_key)>` — fact_kind `calibration`, instrument_id, centre_id, test_id; same rules as a manual calibration (`per_calibration`). Emitted only by C7 drivers whose official manual classifies calibrator records (B2); the manual log (US-15) stays for all other analysers | `instrument_message_id`, `instrument_id`, `centre_id`, `test_id?`, `mapping_status`, `received_at` |
| `instruments.qc.received.v1` (IC §3.15) | `mapping_status = 'mapped'` AND `analyte_id` present (the step-3 instrument counter is written before this filter) | `qc:<sha256_hex(envelope.idempotency_key)>` — fact_kind `qc`, instrument_id, analyte_id, centre_id. `test_id` is set from the matched rule(s) (attribution) | `instrument_message_id`, `instrument_id`, `centre_id`, `analyte_id?`, `mapping_status`, `received_at` |

The payload fields read are exactly those in the last column. `sample_barcode`, `value_raw`, `value_numeric`, `instrument_flags`, `control_*` and `unit_*` are **never** read or stored (P2/P3 data minimisation — `07-SECURITY.md` §5); nor are `calibrator_id_raw`/`calibrator_lot_raw` of the calibration event.

Ordering independence:
- If an analyte-level verified event arrives after its order item's test fact exists, fact (a) is a no-op, the counters of step 3 change, and fact (b) is still evaluated.
- If a rerun event arrives before the verified event, it creates its own fact independently.
- No event depends on another's arrival order.

### 8.2 Store resolution (first match wins)

| Step | Condition | Store |
|---|---|---|
| 1 | `fact.instrument_id` set and an active `instrument_bindings` row exists | binding.store_id |
| 2 | `fact.centre_id` set (QC/rerun) | default consumption store of `ctx.core.centre(centre_id).branchId` |
| 3 | `fact.processing_branch_id` set (verified events carrying it — **CR-C12-004**, accepted in 08) | default consumption store of that branch |
| 4 | `fact.instrument_id` set and `instruments.v_pub_instrument_directory` (**CR-C9-006**, CR-C12-005 merged; 08 R12d) gives its `centre_id` | default consumption store of that centre's branch |
| 5 | `settings.default_consumption_store_id` set and that store active | it |
| 6 | otherwise | fact `status = 'unresolved'`, no movements; alert `unresolved_consumption` (dedupe key `unresolved:<instrument_id or 'none'>`) |

Resolution happens **only if at least one rule matched**. With no matching rule, the fact is `no_rule` and no store is needed. Resolution for facts with matching rules never fails the job.

Step 4 reads `instruments.v_pub_instrument_directory` and §8.5 reads `instruments.v_pub_message_daily` in worker-side projections (consumers and cron) for which 03-IC §6 lists C12 as a consumer; 08 R25 allows this (08 A17 P-21). No HTTP request handler of C12 makes an operational read of another module's view.

### 8.3 Rule matching (`domain/rules.ts`)

For a fact with kind k (mapping `test→per_test`, `analyte→per_analyte`, `rerun→per_rerun`, `qc→per_qc`, `calibration→per_calibration`, `fixed→per_day`), occurrence time t, instrument I (may be null), test T, analyte A:
1. Candidates: active rules of that kind with `effective_from ≤ t < coalesce(effective_to, ∞)`, matching the key fields:
   - per_test / per_rerun / per_calibration: `test_id = T`;
   - per_analyte: `test_id = T AND analyte_id = A`;
   - per_qc: `analyte_id = A OR analyte_id IS NULL`;
   - per_day: `rule_id` given by the cron.
   - In all cases: `instrument_id = I OR instrument_id IS NULL`.
2. Group candidates by `item_id` (and for per_qc also by `analyte_id IS NULL`). Within each group, if any candidate has `instrument_id = I` (non-null), drop the candidates with `instrument_id IS NULL` (instrument-specific overrides generic, AC-12.6).
3. Each remaining rule produces one need: `qty = rule.qty_base × fact.multiplier`. The attribution test is the rule's `test_id`.
4. Rules are evaluated at time t. A rule superseded after t still applies to a late event whose t falls in its window, and an unresolved fact resolved later re-evaluates with its original t.

### 8.4 Posting a fact
`ledger.service.post()` with `doc_type = 'consumption_fact'` and `doc_id = fact.id`; one need → one or more movements (lot split, §4.5). Movement kinds: `consume_test`, `consume_analyte`, `consume_rerun`, `consume_qc`, `consume_calibration`, `consume_fixed`. Each movement records `instrument_id`, `attributed_test_id`, `rule_id`, `business_date` = the fact's business date, and `occurred_at` = the fact's occurred_at.

### 8.5 Manual and cron facts
- `logConsumptionEvent` (calibration/qc): basis key `manual:<uuidv7>` (new per request; the API idempotency key covers retries). It runs the same §8.2–8.4. A manual fact without an instrument skips step 1 and resolves through step 5; if that fails it is `unresolved` (DECISION: the request carries no `store_id`, so there is one resolution path for every fact).
- `inventory.daily_fixed_consumption` (cron): for each active `per_day` rule × business date D (D = yesterday in the tenant timezone; plus catch-up for up to 7 missing days [CONV]), it creates fact `fixed:<rule_id>:<D>` when activity holds (`settings.per_day_requires_activity = false`, or `instruments.v_pub_message_daily.messages > 0` for (I, D)). `occurred_at` = D 23:59:59.999 in the tenant timezone, converted to UTC.

### 8.6 CPT computation (report `cost_per_test`; PRD §8.3)

In one SQL query per request (CTEs):
```
N(T,I)   = Σ test_counts_daily.tests_counted        WHERE date ∈ P [AND instrument filter]
D(T,I)   = Σ consumption_daily.value_consumed_paisa WHERE kind IN (consume_test, consume_analyte, consume_rerun, consume_qc, consume_calibration)
                                                       AND attributed_test_id = T AND instrument_id IS NOT DISTINCT FROM I AND date ∈ P
F(I)     = Σ consumption_daily.value_consumed_paisa WHERE kind = consume_fixed AND instrument_id = I AND date ∈ P
Ntot(I)  = Σ_T N(T,I)
cpt_direct = round(D / N)               (numeric; NULL when N = 0)
fixed_share = CASE WHEN Ntot = 0 THEN 0 ELSE round(F * N / Ntot) END
cpt_loaded = round((D + F * N / Ntot) / N)   (NULL when N = 0)
```
`consume_reversal` rows are stored in `consumption_daily` under the reversed kind with a negative value (`05-SCHEMA.md` §6.4), so the sums net them. Golden test fixtures cover these cases: N = 0; Ntot = 0; exact .5 paisa rounding; a negative reversal; fixed consumption on an instrument with three tests.

`cpt_standard`:
- current rules × `avg_cost` per §4.3 step 4, store = binding(I) else tenant default;
- `per_analyte` rules are included for the reportable analytes of T from `CatalogPort.getTest({ testId: T, asOf: now })`;
- rounded once.

## 9. Background jobs (worker manifest)

```ts
export const manifest: WorkerManifest = {
  module: 'inventory',
  tasks: {
    'inventory.resolve_unresolved': resolveUnresolved,
    'inventory.daily_fixed_consumption': dailyFixedConsumption,
    'inventory.daily_alert_scan': dailyAlertScan,
    'inventory.balance_integrity_check': balanceIntegrityCheck,
    'inventory.reconciliation_scan': reconciliationScan,
    'inventory.purge_alerts': purgeAlerts,
  },
  subscriptions: {
    'lab.result.verified.v1': onResultVerified,          // IC §3.9 consumer (A2)
    'instruments.qc.received.v1': onQcReceived,          // IC §3.15 consumer (A2)
    'instruments.result.received.v1': onResultReceived,  // IC §3.14 / CM §5.1 consumer
    'instruments.calibration.received.v1': onCalibrationReceived,  // IC §3.26 consumer (CR-C12-006, 08 R13)
  },
  crontab: [/* cron.ts */],
};
```

| Task | Trigger | tenantScope | Behaviour | Retries |
|---|---|---|---|---|
| consumers (4) | fan-out | event tenant | §8.1 | `max_attempts` 10 (CV §7.5) |
| `inventory.resolve_unresolved` | enqueued by `putInstrumentBinding`, `updateInventoryStore` (default flag set), `updateInventorySettings` (default store set); `job_key = resolve:<tenant>:<instrument or 'all'>` | tenant (job payload `{tenant_id}`, system actor) | re-runs §8.2–8.4 for `unresolved` facts (≤ 1,000 per run, oldest first; re-enqueues itself if more remain) | 10 |
| `inventory.daily_fixed_consumption` | cron `15 19 * * *` UTC (= 01:00 Asia/Kathmandu, UTC+05:45 per CV §4.8) [CONV] | `per_tenant` (08 A13 P-6, A17 D-72) | §8.5 | 5 |
| `inventory.daily_alert_scan` | cron `30 19 * * *` UTC (01:15 NPT) | `per_tenant` | expiry_soon / expired_on_hand per (store, lot) with qty > 0; open_stability_exceeded per open container past open_expiry_at; below_reorder re-evaluation; auto-resolve alerts whose condition is gone | 5 |
| `inventory.balance_integrity_check` | cron `45 19 * * *` UTC | `per_tenant` | compares `stock_balances` with Σ `stock_movements` grouped by (store, item, lot); any difference → `balance_drift` alert + metric. **Never auto-corrects** | 3 |
| `inventory.reconciliation_scan` | cron `0 20 * * *` UTC | `per_tenant` | yesterday's reconciliation; **test block only** (D-74): diff_bp > `reconciliation_gap_alert_bp` on rows with ≥ 50 events → `reconciliation_gap` alert. The instrument block (`instrument_qc_daily` vs `qc_records`) is computed for the report but raises no alert [CONV] | 3 |
| `inventory.purge_alerts` | cron `0 21 * * 0` UTC (weekly) | `per_tenant` (08 A17 D-72, P-18(c)) | calls `app.purge_inventory_alerts()` (SECURITY INVOKER, CR-C12-008 as amended by D-72) under the tenant's claims as the `inventory` system actor; it deletes `WHERE tenant_id = app.current_tenant_id() AND expires_at < now()` through policy `alerts__delete__tenant` (system actor only). No DEFINER, no index exception (`05-SCHEMA.md` §4.2, §11) | 3 |

Cron entries live in code (`cron.ts`; REQ-ARCH-042). Every cron task declares `tenantScope: 'per_tenant'` (08 A13 P-6): at each tick the worker core enqueues one job per tenant from `app.cron_tenant_ids()`, payload `{tenant_id}`, `job_key = '<identifier>:<tenant_id>:<tick, ISO minute>'`, and the job runs under that tenant's claims for the `inventory` system actor. No C12 task is `platform`. Timezone note: crons run on UTC; the task computes "yesterday" in the tenant timezone, which is `Asia/Kathmandu` for every tenant in v1 (08 A13 P-15).

## 10. Data integrity invariants (tested)

1. For every (store, item, lot): `stock_balances.qty_base = Σ stock_movements.qty_base` and `value_paisa = Σ value_paisa` (integrity job + integration test after every service test).
2. Lot rows never have qty < 0 (DB CHECK).
3. Every posted document's movements sum to its lines (test).
4. `consumption_daily` totals equal the ledger sums for the same keys (golden).
5. No two facts share a basis key (DB unique).
6. Re-delivering an event (same `event_id`) any number of times changes nothing, counters included: duplicates stop at the inbox (§8.1 step 1). Only a distinct verification event (new `event_id`, e.g. a re-verification after IC §10.2 R5) increments `verified_result_events`.
7. Draft lines are never deleted: `lims_app` has no DELETE on any line table (08 A17 D-71); removed lines carry `removed_at`/`removed_by`.

## 11. Configuration keys (`config.ts`; env `LIMS_INVENTORY_*`; global)

| Key | Default | Meaning |
|---|---|---|
| `LIMS_INVENTORY_REPORT_MAX_DAYS` | 366 | max report range (`inventory.range_too_large`) [CONV] |
| `LIMS_INVENTORY_REPORT_SCREEN_ROWS` | 5000 | on-screen row cap [CONV] |
| `LIMS_INVENTORY_EXPORT_MAX_ROWS` | 50000 | CSV cap [CONV] |
| `LIMS_INVENTORY_RESOLVE_BATCH` | 1000 | facts per resolve run [CONV] |
| `LIMS_INVENTORY_FIXED_CATCHUP_DAYS` | 7 | per_day catch-up [CONV] |
| `LIMS_INVENTORY_RESOLUTION_STEPS` | `1,2,5` | store-resolution steps enabled (§8.2); add `3` once C5 emits `processing_branch_id` (CR-C12-004, accepted), `4` once C0 creates `instruments.v_pub_instrument_directory` (CR-C9-006, accepted); step 6 (unresolved) always applies [CONV] |

Tenant settings live in `inventory.settings` (`05-SCHEMA.md` §2.4) and are edited via #27.

No rule cache: consumers match rules with the indexed lookup (`consumption_rules__tenant_id_match__idx`) on every event, because rule writes happen in the API process and a worker-side cache would ignore a new rule for up to its TTL, and rules are not retroactive (03-APP-FLOW §3.6) [DECISION, review C12 m#20]. The former `LIMS_INVENTORY_RULE_CACHE_TTL_SECONDS` key is removed.

## 12. Performance targets (derived from 04 §14; inputs are ASSUMPTION, targets [CONV])

Load arithmetic (per lab, then N = 10 labs):

| Input (04 §14) | Value | Derived event rate |
|---|---|---|
| Result rows/day/lab | 15,000–25,000 | `lab.result.verified.v1` ≈ 25,000/day (upper) |
| Peak hour = 25 % of daily volume | — | 6,250/h ≈ 1.74 events/s/lab; ×10 labs ≈ 17.4/s |
| Billable orders (order items)/day/lab | 5,000 | per-test facts ≈ 5,000–8,000/day (panels expand to tests; ASSUMPTION ≤ 8,000) → peak ≈ 0.56/s/lab, 5.6/s at N=10 |
| Analyser messages/day/lab | 1,500–3,000 | result records ≈ verified results; `instruments.result.received.v1` ≈ 25,000/day → 17.4/s peak at N=10 (≥ 95 % skipped: not reruns) |
| QC events | not in 04 | ASSUMPTION ≤ 500/day/lab → negligible |

Write load at N = 10 peak:
- posting path ≈ 5.6/s × ~8 row writes (fact, 1–3 movements, balance updates, daily upserts, counters);
- skip paths ≈ 29/s × 2 writes (inbox + counter). The skip-path rate is 17.4 (verified) + 17.4 (result received) − 5.6 (verified events that post) ≈ 29/s.

Total ≈ 45 + 58 ≈ **103 row writes/s**. This is above 04 §14's "≲50 writes/s derived" API figure but inside its 250 writes/s headroom target. It is recorded as risk R2 in `06-IMPLEMENTATION-PLAN.md` §7. Mitigation: the skip path does no balance work; on it the writes are the inbox row and, for verified/QC events, one counter upsert (§8.1 step 3); counters for reruns are written only for rerun facts.

| Target | Value |
|---|---|
| Consumer handler p95 (posting path, warm) | ≤ 100 ms |
| Consumer handler p95 (skip path) | ≤ 20 ms |
| Worker concurrency for `evt.inventory.*` | ≥ 4 (C1 sizes). Busy time at N = 10 peak ≈ 5.6/s × 0.1 s (posting) + ≈ 29/s × 0.02 s (skip) ≈ 1.2 worker-seconds per second → 4 workers give > 3× headroom |
| Consumption lag (`occurred_at` → commit) p95 | ≤ 60 s (PRD §7) |
| Interactive reads (lists, get) p95 | ≤ 300 ms at 10× seed |
| Document post (≤ 200 lines) p95 | ≤ 1.5 s |
| Reports, 31-day range, one branch, p95 | ≤ 2 s; 366-day range ≤ 8 s |
| CSV export 50,000 rows | ≤ 20 s, streamed |
| Integrity check per tenant (≈ 7 M movements/year/lab: 20k/day × 365) | ≤ 5 min at 1 year of data (grouped aggregate on `stock_movements__tenant_id_store_item__idx`) |

## 13. Observability

Logs (CV §9.1): `module=inventory`, `operation_id`/`task`, plus `fact_kind`, `status`, `rules_applied`, `store_resolution_step`, `doc_type`, `doc_id`. **Never logged:** event payload, barcode, `basis_key` (contains P1 ids — allowed by CV §9.2, but omitted [CONV] to keep logs minimal), supplier contact fields, prices.

Metrics:

| Metric | Type | Labels |
|---|---|---|
| `lims_inventory_events_total` | counter | `event_type`, `outcome` ∈ {posted, no_rule, unresolved, duplicate, disabled, skipped} |
| `lims_inventory_events_skipped_total` | counter | `reason` ∈ {not_rerun, unmapped, no_test, qc_unmapped, before_enable} |
| `lims_inventory_consumption_lag_seconds` | histogram | `event_type` |
| `lims_inventory_consumer_failures_total` | counter | `event_type`, `error_code` |
| `lims_inventory_unresolved_facts` | gauge | `tenant_id` (low cardinality — CV §9.4) |
| `lims_inventory_unresolved_oldest_age_seconds` | gauge | `tenant_id` — age of the oldest `unresolved` fact, 0 when none [CONV, needed by the backlog alert] |
| `lims_inventory_negative_unlotted_rows` | gauge | `tenant_id` |
| `lims_inventory_balance_drift_rows` | gauge | `tenant_id` |
| `lims_inventory_documents_posted_total` | counter | `doc_kind` |
| `lims_inventory_report_duration_seconds` | histogram | `report_code` |

#### Alert rules for C1 (08 A13 P-14)

C12 keeps the rule file in its own path, `services/worker/src/jobs/inventory/ops/inventory.rules.yml` [CONV], and C1 wires it into `infra/` through **CR-C12-011** (§17). C1 adds only `team` and `runbook_url` (C1 02-TRD §11.3). Thresholds are the ones this TRD already stated; `for`, severity and route are [CONV].

| Alert | expr | for | severity | route (C1 receiver) |
|---|---|---|---|---|
| `InventoryConsumerFailing` | `sum by (event_type) (increase(lims_inventory_consumer_failures_total[15m])) > 0` | 15m | page | `oncall-email` |
| `InventoryConsumptionLagHigh` | `histogram_quantile(0.95, sum by (le, event_type) (rate(lims_inventory_consumption_lag_seconds_bucket[5m]))) > 300` | 15m | warn | `ops-digest-email` |
| `InventoryBalanceDrift` | `max by (tenant_id) (lims_inventory_balance_drift_rows) > 0` | 0m | page (indicates a bug) | `oncall-email` |
| `InventoryUnresolvedBacklog` | `max by (tenant_id) (lims_inventory_unresolved_oldest_age_seconds) > 86400` | 5m | warn (ops only; the tenant sees the in-app `unresolved_consumption` alert) | `ops-digest-email` |

#### CI jobs for C0-0A (08 A13 P-14)

None. C12 adds no CI gate script; its checks (D-SCOPE handler lint, D-EVT typed-input test, cost allowlist tests) run inside the module's own test suites.

## 14. Error codes used

- From CatalogPort (08 R18, A2.2): `catalog.tax_config_missing` (422) on PO/GRN line writes. It propagates unchanged per 08 A17 P-23 (the handler rethrows the port's `LimsError` and never constructs it) and is listed in the `x-error-codes` of #50, #52, #81, #83.
- From IC §8: `inventory.insufficient_stock`, `inventory.lot_expired`, `inventory.po_invalid_transition`, `inventory.uom_mismatch`; `common.*` (validation_failed, not_found, version_conflict, precondition_required, immutable_record, idempotency_*, rate_limited, internal); `auth.forbidden`, `auth.mfa_required`, `auth.*` session codes.
- New (**CR-C12-003**): `inventory.code_duplicate`, `inventory.item_inactive`, `inventory.item_in_use`, `inventory.store_not_empty`, `inventory.po_self_approval_forbidden`, `inventory.over_receipt`, `inventory.document_invalid_transition`, `inventory.lot_unavailable`, `inventory.reason_required`, `inventory.fact_not_reversible`, `inventory.store_locked_for_count`, `inventory.count_already_open`, `inventory.rule_conflict`, `inventory.export_too_large`, `inventory.range_too_large`.

Per CV §11.4, every listed code has a test.

## 15. Test strategy

| Layer | What | Fakes / tools |
|---|---|---|
| Unit | domain: money line computation (golden table: 30 cases incl. .5 rounding, discount = gross, rate 0; rate input is the `getTaxRate` value), FEFO comparator, rule precedence, basis keys, numbering patterns (yy/fy boundaries via shared bsdate golden table), state machines (every allowed + representative forbidden transition), mappers (cost allowlist) | none |
| Integration | PO/GRN line writes: `tax_rate_bp` equals the CatalogPort fake's `ratePercentBasisPoints` for (code, business date); exempt line (`is_exempt: true`, no `tax_code`) → fake records **no** `getTaxRate` call, stored `tax_code` NULL, `tax_rate_bp = 0`, `vat_paisa = 0`, response has `is_exempt: true` and no `tax_code` (08 A4.1, D-70); `is_exempt: true` with a `tax_code` → `400 common.validation_failed` at `/lines/0/tax_code`; lowercase code (`vat`) → `400 common.validation_failed` / DB CHECK `23514` (08 A5.6); fake throwing `catalog.tax_config_missing` → `422`, no row written; changing the fake's rate afterwards leaves existing lines unchanged (08 A2.2); services + repositories on migrated PG 17 with seed tenants; ledger invariants (§10) asserted after every test; concurrency: 20 parallel consumer jobs on the same item → balances exact, no deadlock (lock ordering); 2 parallel issues of the last stock → one `insufficient_stock`; transit loss (D-69): dispatch 100, receive 98 → destination +98 at pro-rata value, source `transfer_in` +2 then `wastage` −2 on the same lot row, source nets −100, also when the lot row dispatched its last units; count variance larger than the lot row at posting → lot −Q + unlotted remainder (AC-19.3); inbound into a negative unlotted row, both D-75 branches (golden); draft replace marks lines removed and never deletes (D-71) | C0 compose stack; IdentityPort + CatalogPort fakes |
| Consumer contract | each consumer: IC example payload; unknown extra fields; absent optional fields (`specimen_id`, `verified_by_membership_id`, `instrument_id`, `processing_branch_id`); duplicate delivery; event before `consumption_enabled_at` → no fact, but `verified_result_events` / `qc_observations` counted (D-73); out-of-order (rerun before verified); unresolved → binding → resolved; unmapped QC → `qc_observations` +1, no fact (D-74); QC fact with two rules on one test → `qc_events` +1; 20-analyte CBC with a per-analyte rule on each analyte → 20 `consume_analyte` + 1 `consume_test` (AC-12.2); fact inserted with its final status (`no_rule` / `unresolved` / `posted`) — no status transition at insert | event fixtures validated against `contracts/events/*.schema.json` |
| HTTP contract | every operationId: request/response validation; every `x-error-codes` entry | fastify-openapi-glue runtime validation |
| Probes | cross-tenant for every operation and table (AC-22.1); mixed-id bulk inputs (AC-22.3); branch-scope probes for every store-bound operation incl. #75 facts (`07-SECURITY.md` §6) | C0 probe generator + hand-written |
| Reports | golden datasets for daily consumption, CPT (PRD §8 examples), wastage, valuation as-of | seeded ledger |
| Performance | §12 targets at 1× and 10× seed (DoD chunk gate 5) | seed generator |
| UI | component tests with MSW for every screen state (04-UI-UX); e2e: receive → consume (simulated event) → count → report | MSW 3.0.3, Prism 5.16.0 |

Fakes switch to real implementations when C2 (IdentityPort), C3 (CatalogPort) and C5/C7 (real events in staging) pass their chunk gates (DoD §5).

## 16. Dependencies table (CV §15.1)

No new runtime dependency. CSV is written in-module. Decimal arithmetic happens in SQL.

## 17. Change requests raised

> Status per `program/08-CR-REGISTER.md` (2026-11-06). CR texts below are kept as history.

| CR | Status |
|---|---|
| CR-C12-001 | ACCEPTED in 08 |
| CR-C12-002 | ACCEPTED in 08 |
| CR-C12-003 | ACCEPTED in 08 |
| CR-C12-004 | ACCEPTED in 08 |
| CR-C12-005 | MERGED in 08 into CR-C9-006 |
| CR-C12-006 | ACCEPTED in 08 |
| CR-C12-007 | ACCEPTED-MODIFIED in 08 — 03-IC §9.3 rule amended for module-internal non-fiscal numbers. |
| CR-C12-008 | ACCEPTED in 08 |
| CR-C12-009 | ACCEPTED in 08 |
| CR-C12-010 | ACCEPTED in 08 Addendum A2.2 (additive) — `CatalogPort.getTaxRate(ctx, {taxCode, on})` implemented by C3; rate columns removed from `inventory.g_cs_tax_codes` / `cs_tax_codes`. |
| 08 Addendum A2/A3 | 08 Addendum A2/A3 applied 2026-11-06 (A2.2; A3 has no C12 impact). |
| CR-C12-011 | RAISED 2026-11-06 (08 A13 P-14) — C1 wires `services/worker/src/jobs/inventory/ops/inventory.rules.yml` (§13 "Alert rules for C1"); awaiting 08 register row |
| CR-C12-008 amendment | 08 A17 D-72 — the purge function stays SECURITY INVOKER; it runs `per_tenant` under tenant claims as the `inventory` system actor via `alerts__delete__tenant` and `GRANT DELETE ON inventory.alerts TO lims_app`; it is not an owner-run purge and needs no C0 purge-inventory entry |
| Review fix pass 2026-11-06 | Review fix pass 2026-11-06 — review/C12-inventory.md + 08 Addendum A17 (plus A13 rules P-1…P-15 that apply to you) applied: P-1, P-3 (§5.10), P-6, P-8, P-9, P-10, P-14 (§13, CR-C12-011), P-15, P-16 (already in the policy template), P-18, P-21, P-22, P-23; D-2, D-57 (handed off), D-69, D-70, D-71, D-72, D-73, D-74, D-75; A16.1 not applicable (no centre-scoped policy in `inventory`). |
| 08 Addendum A4/A5 | 08 Addendum A4/A5 applied 2026-11-06 — A4.1: `getTaxRate(ctx: RequestContext, …)` → `kind 'vat' \| 'other'`, `effectiveFrom string \| null`; exempt lines have no tax code and never call `getTaxRate`. A5.3: `on` = tenant business date of the line write (accepted). A5.6: tax codes are C3 values, CHECK `^[A-Z0-9_]{1,16}$`, seed `VAT` (was `vat_standard`; `exempt` seed removed). |

**08 Addenda applied (08 A25 P-60: one row per addendum A1–A29; final check 2026-11-06)**

| Addendum | Status for C12 |
|---|---|
| A1 | not applicable |
| A2 | applied 2026-11-06 — A2.2 (PRD, TRD, AF, SCH, PLAN) |
| A3 | not applicable |
| A4 | applied 2026-11-06 — A4.1 (PRD, TRD, AF, UI, SCH, PLAN) |
| A5 | applied 2026-11-06 — A5.3, A5.6 (PRD, TRD, AF, SCH, PLAN) |
| A6 | not applicable |
| A7 | applied 2026-11-06 — A7.6 (TRD) |
| A8 | not applicable |
| A9 | not applicable |
| A10 | not applicable |
| A11 | not applicable |
| A12 | not applicable |
| A13 | applied 2026-11-06 — P-1, P-3, P-6, P-8, P-9, P-10, P-14, P-15, D-2 (PRD, TRD, AF, UI, PLAN, SEC) |
| A14 | not applicable |
| A15 | not applicable |
| A16 | applied 2026-11-06 — A16.1 (TRD) |
| A17 | applied 2026-11-06 — P-16, P-17, P-18, P-21, P-22, P-23, D-57, D-69, D-70, D-71, D-72, D-73, D-74, D-75 (PRD, TRD, AF, UI, SCH, PLAN, SEC) |
| A18 | not applicable |
| A19 | not applicable (A19 P-40 cites this chunk's existing port idempotency keys as already compliant; D-106/D-109/D-110/D-123 change other chunks or program docs) |
| A20 | not applicable |
| A21 | not applicable |
| A22 | not applicable |
| A23 | not applicable |
| A24 | not applicable |
| A25 | not applicable |
| A26 | not applicable |
| A27 | not applicable |
| A28 | not applicable |
| A29 | not applicable |


Every CR below is designed as if accepted and is non-blocking unless stated. The default built meanwhile is named in each.

```
Title: CR-C12-001: inventory permission codes and role grants
From chunk: C12            To owner: C0-0C (contracts/permissions.yaml)
Type: api                   Blocking? no — default: fake IdentityPort registry seeded with these codes in C12 tests
Problem: IC §11 has only inventory.item.read and inventory.stock.manage. PRD §2 needs separation of master data,
  privileged adjustments (can hide loss — REQ-SEC-055 analogue), PO approval (money commitment), cost visibility
  (REQ-SEC-081) and data export (privileged per 04 A4 "data-export roles").
Proposed (all phase: 2):
  - { code: inventory.master.manage,  privileged: false, roles: [lab_manager] }
  - { code: inventory.stock.adjust,   privileged: true,  roles: [lab_manager] }
  - { code: inventory.po.manage,      privileged: false, roles: [lab_manager, finance] }
  - { code: inventory.po.approve,     privileged: true,  roles: [lab_manager, finance] }
  - { code: inventory.cost.read,      privileged: false, roles: [lab_manager, finance, owner_viewer] }
  - { code: inventory.report.export,  privileged: true,  roles: [lab_manager, finance, owner_viewer] }
  - { code: inventory.bench.record,   privileged: false, roles: [lab_technologist, lab_manager] }
  - change: inventory.item.read roles [lab_manager, lab_technologist] → [lab_manager, lab_technologist, finance, owner_viewer]
Backward compatible? yes (additive; the role-list change only widens read access).
Tenant/security impact: privileged codes force aal2 (04 A4). Tests: role matrix in probes.
```
```
Title: CR-C12-002: staff routes for inventory screens
From chunk: C12            To owner: C0-0C (contracts/routes.yaml)
Type: api                   Blocking? no — default: nav built from these ids in C12's local test manifest
Problem: IC §7 has only staff.inventory.item (a detail route; not a nav entry — C0 04-UI-UX §3).
Proposed (origin staff_web, owner C12):
  staff.inventory.home         /inventory                                  inventory.item.read
  staff.inventory.items        /inventory/items                            inventory.item.read
  staff.inventory.stock        /inventory/stock                            inventory.item.read
  staff.inventory.purchase_orders /inventory/purchase-orders               inventory.item.read
  staff.inventory.purchase_order  /inventory/purchase-orders/{po_id}       inventory.item.read
  staff.inventory.receipts     /inventory/receipts                         inventory.item.read
  staff.inventory.receipt      /inventory/receipts/{grn_id}                inventory.item.read
  staff.inventory.transfers    /inventory/transfers                        inventory.item.read
  staff.inventory.transfer     /inventory/transfers/{transfer_id}          inventory.item.read
  staff.inventory.counts       /inventory/counts                           inventory.item.read
  staff.inventory.count        /inventory/counts/{count_id}                inventory.item.read
  staff.inventory.bench        /inventory/bench                            inventory.bench.record
  staff.inventory.rules        /inventory/rules                            inventory.item.read
  staff.inventory.unresolved   /inventory/unresolved                       inventory.item.read
  staff.inventory.alerts       /inventory/alerts                           inventory.item.read
  staff.inventory.reports      /inventory/reports                          inventory.item.read
  staff.inventory.suppliers    /inventory/suppliers                        inventory.item.read
  staff.inventory.stores       /inventory/stores                           inventory.item.read
  staff.inventory.settings     /inventory/settings                         inventory.master.manage
Params are UUIDs only (REQ-SEC-098). Backward compatible: yes.
```
```
Title: CR-C12-003: inventory error codes
From chunk: C12            To owner: C0-0C (contracts/errors.yaml)
Type: api                   Blocking? no
Proposed (owner C12):
- { code: inventory.code_duplicate,            http: 409, title: "Code already used", meaning: "item/pack/store/supplier/barcode code exists in the tenant" }
- { code: inventory.item_inactive,             http: 409, title: "Item inactive", meaning: "" }
- { code: inventory.item_in_use,               http: 409, title: "Item in use", meaning: "Deactivation blocked: stock or open PO lines" }
- { code: inventory.store_not_empty,           http: 409, title: "Store not empty", meaning: "Deactivation blocked: non-zero balance" }
- { code: inventory.po_self_approval_forbidden,http: 403, title: "Approver must differ from creator", meaning: "Tenant setting" }
- { code: inventory.over_receipt,              http: 422, title: "Received quantity exceeds order", meaning: "Beyond tolerance" }
- { code: inventory.document_invalid_transition,http: 409, title: "Document state change not allowed", meaning: "GRN/transfer/count/container/fact/alert" }
- { code: inventory.lot_unavailable,           http: 409, title: "Lot not available", meaning: "Quarantined or blocked" }
- { code: inventory.reason_required,           http: 422, title: "Reason required", meaning: "" }
- { code: inventory.fact_not_reversible,       http: 409, title: "Consumption cannot be reversed", meaning: "Only manual facts are reversible" }
- { code: inventory.store_locked_for_count,    http: 409, title: "Store is being counted", meaning: "Tenant setting count_locks_store" }
- { code: inventory.count_already_open,        http: 409, title: "A count is already open for this store", meaning: "" }
- { code: inventory.rule_conflict,             http: 409, title: "A current rule exists", meaning: "Supersede the existing rule instead" }
- { code: inventory.export_too_large,          http: 422, title: "Export too large", meaning: "Row cap exceeded; narrow the range" }
- { code: inventory.range_too_large,           http: 422, title: "Date range too large", meaning: "" }
Backward compatible: yes.
```
```
Title: CR-C12-004: optional processing_branch_id on lab.result.verified.v1
From chunk: C12            To owner: C0-0C (producer C5 must agree; consumers C8, C9 informed)
Type: event (additive)       Blocking? no — default: store resolution skips step 3 (02-TRD §8.2); multi-branch tenants with
  manual (non-instrument) results fall back to the tenant default store or to the unresolved queue.
Problem: verified events carry no branch, so C12 cannot pick the consuming branch's store for results without an instrument.
  C5 already holds results.processing_branch_id (C5 05-SCHEMA; lab.v_pub_result_daily exposes it).
Proposed: Payload property "processing_branch_id": { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" } (optional).
Backward compatible? yes (CV §7.2). PHI: none added (P1 id of a branch).
```
```
Title: CR-C12-005: published view instruments.v_pub_instrument_directory
From chunk: C12            To owner: C0-0B (C7 must agree)
Type: schema (view)          Blocking? no — default: UI shows instrument ids and uses C7's HTTP list (user token) for pickers;
  store resolution skips step 4.
Problem: C12 stores instrument ids (bindings, rules, movements) and must label them in server-built reports and CSV exports
  (no user-facing HTTP call inside a report query). CM §5 R1 forbids reading instruments tables.
Proposed: CREATE VIEW instruments.v_pub_instrument_directory WITH (security_invoker = true) AS
  SELECT tenant_id, id AS instrument_id, instrument_code, display_name, centre_id, state, is_active FROM instruments.instruments;
  GRANT SELECT … TO lims_app; consumers C12 (and C8 if wanted).
Security: P0 (no PHI). Backward compatible: yes.
```
```
Title: CR-C12-006: new event instruments.calibration.received.v1
From chunk: C12            To owner: C0-0C + C7 (producer)
Type: event (new)            Blocking? no — default: manual calibration log (PRD US-15). Also depends on B2 (manuals), since a
  driver must classify calibrator records (C7 06-IMPLEMENTATION-PLAN §6 already foresees this CR).
Problem: per-calibration consumption (00 §3 item 7 "per cal"; 01 research §2.6 "inferred from calibrator-flagged interface
  records") has no LIS fact. C5 discards calibrator samples as ingest exceptions (C5 05-SCHEMA exception_discard_reasons
  qc_or_calibrator_sample).
Proposed payload (P0): instrument_message_id, instrument_id, centre_id, instrument_analyte_code, mapping_status,
  analyte_id?, test_id?, calibrator_id_raw? (≤64), calibrator_lot_raw? (≤64), instrument_result_time?, received_at.
  Idempotency key: <instrument_id>:cal:<instrument_analyte_code>:<instrument_result_time or sha256(raw)>.
  Consumer: C12 → fact_kind 'calibration', basis key 'cal:<sha256(idempotency_key)>', same rules as manual.
Backward compatible: yes (new event).
```
```
Title: CR-C12-007: numbering registry entries (IC §9.3)
From chunk: C12            To owner: doc owner (IC §9.3) — no code change in C0
Type: api (documentation)    Blocking? no
Proposed rows: po_no (C12, PO{yy}{seq:6}, tenant + period, gaps allowed), grn_no (GR{yy}{seq:6}), transfer_no (TR{yy}{seq:6}),
  count_no (SC{yy}{seq:5}), doc_no (SD{yy}{seq:6}). Patterns are tenant settings in inventory.settings (not TenantSettings.numbering:
  these are module-internal, non-fiscal). Never in URLs or logs except as display (IC §9.3 rule).
```
```
Title: CR-C12-008: inventory system actor and alert purge function
From chunk: C12            To owner: C0-0B (db/meta/system-actors.yaml, purge inventory)
Type: schema                 Blocking? no — default: worker tests use the fake system actor
Proposed: system actor 'inventory' with permissions [inventory.item.read, inventory.stock.manage] (consumer writes are
  service-level and do not call assertRole, but the declaration is required by IC §11 "system: declared per worker manifest");
  function app.purge_inventory_alerts() RETURNS integer — LANGUAGE sql, SECURITY INVOKER, owned by lims_owner, deletes
  inventory.alerts rows with expires_at < now() in batches of 10,000 (CV §5.11 purge pattern). Called by inventory.purge_alerts.
Amended by 08 A17 D-72 (binding): inventory.purge_alerts is per_tenant; the INVOKER function runs under the tenant's claims as the
  inventory system actor and deletes WHERE tenant_id = app.current_tenant_id() AND expires_at < now() through policy
  alerts__delete__tenant (FOR DELETE TO lims_app, system actor, expires_at < now()); GRANT DELETE ON inventory.alerts TO lims_app.
  No DEFINER, no owner policy, no index exception, no C0 purge-inventory entry.
```
```
Title: CR-C12-011: inventory alert rules wiring (08 A13 P-14)
From chunk: C12            To owner: C1 (infra/ Prometheus rules)
Type: alert                 Blocking? no — default: rules file kept in the C12 path, not loaded until wired
Problem: C12 alerts must live in C12's own paths (P-14); C1 owns infra/ and the rule loading.
Proposed: C1 includes services/worker/src/jobs/inventory/ops/inventory.rules.yml (the four rules of §13 "Alert rules for C1",
  thresholds verbatim) in its Prometheus rule set, adding team and runbook_url (infra/runbooks/inventory.md#<alert>).
Backward compatible: yes.
```
```
Title: CR-C12-010: CatalogPort.getTaxRate for purchase-side tax rates (R18 single source)
From chunk: C12            To owner: C0-0C (C3 implements)
Type: port                  Blocking? no — default: CatalogPort fake returns seeded VAT 1300 (08 A5.6; no exempt rate, 08 A4.1)
Status: ACCEPTED in 08 Addendum A2.2 (additive).
Problem: R18 makes C3 the single source of tax rates on the sales and purchase sides; C12 held its own rate_bp
  in inventory.g_cs_tax_codes / cs_tax_codes.
Proposed (signature per 08 A4.1 / 03-IC §4.2): getTaxRate(ctx: RequestContext, input: { taxCode: string; on: string /* ISO date, tenant timezone */ }):
  Promise<{ taxCode: string; ratePercentBasisPoints: number; kind: 'vat' | 'other'; effectiveFrom: string | null }>,
  throws catalog.tax_config_missing. C12 keeps tax code per item/supplier and vat_in_cost; rate columns removed.
Backward compatible? yes (additive method).
```
```
Title: CR-C12-009: DecimalField suffix (unit) prop in @lims/ui
From chunk: C12            To owner: C0-0D
Type: ui-kit                 Blocking? no — default: unit shown as a separate text element after the field
Problem: every quantity input needs its unit visible inside the field ("400 test", "0.1 mL") for accessibility of the label.
Proposed: DecimalFieldProps.suffix?: string (same behaviour as TextFieldProps.suffix).
```
