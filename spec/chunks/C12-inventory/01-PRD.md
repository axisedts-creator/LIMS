# C12 Inventory — 01 Product Requirements (PRD)

Status: DECISION, 2026-11-06. Phase 2 (04 §12). Wave 2 (01-CHUNK-MAP §1).
Inputs, in precedence order: `research/00-scope-baseline.md` (00), `research/04-consolidated-decisions.md` (04), `program/01-CHUNK-MAP.md` (CM), `program/03-INTERFACE-CATALOG.md` (IC), `program/02-CONVENTIONS.md` (CV), `research/01-features-workflow.md` §1.7 and §2.6 (01 research), and the C3/C5/C7 chunk documents (for the exact ids and event fields C12 consumes).
Labels: **VERIFIED / UNVERIFIED / DECISION / BLOCKED (B#) / ASSUMPTION / [CONV]** as defined in `program/00-README.md`. CR ids `CR-C12-0nn` are specified in `02-TRD.md` §17.

---

## 1. Purpose

C12 gives each tenant lab one inventory record for reagents, kits, consumables, QC controls and calibrators, per branch store. The record covers:
- what is in stock, by lot and expiry;
- what was received from suppliers, against which purchase order;
- what was consumed, and on which analyser, for which test;
- what was wasted or expired;
- what a test costs in materials (cost per test, "CPT");
- what must be reordered.

Consumption is counted automatically from LIS facts that already exist in the system:
- verified results (`lab.result.verified.v1`, C5);
- QC observations (`instruments.qc.received.v1`, C7);
- analyser reruns (`instruments.result.received.v1` with `is_rerun = true`, C7).

Facts the LIS does not see (calibrations, manual QC, daily start-up washes) are logged manually or by a scheduled rule. C12 never reads analyser reagent levels (see §1.1).

### 1.1 Client wishlist item 7 — what we build instead of "real-time analyser-connected" inventory

The client's wishlist (00 §3 item 7) asks for a "complete real-time analyser-connected Inventory module (stock, CPT calculation, real-time consumption, expiry, per test/cal/QC consumption, daily consumption, wastage, PO, analyser-wise consumption), supply management".

Decision (04 N15, 01 research §1.7 and §2.6; 04 §12 DROP list "real-time reagent telemetry"):
- **Not built:** live reading of on-board reagent levels from the analysers. Onboard-reagent telemetry is not assumed available over the ASTM/HL7 result stream, and needs vendor middleware where it exists. This is **UNVERIFIED per model** (04 N15; B2: exact models and manuals not received).
- **Built instead:** LIS-count consumption models. Every verified test, QC observation, rerun and calibration deducts a configured reagent quantity from the analyser's store within about a minute (target in `02-TRD.md` §12). This covers every other item in the wishlist line: stock, CPT, per-test/cal/QC consumption, daily consumption, wastage, PO, analyser-wise consumption, supply management.

Client-facing explanation (copy for the sales/onboarding deck and the in-app help page `inventory.help.consumption_model`; synthetic numbers only):

> "Your analysers send us patient results and QC results, but they do not tell us how much reagent is left in the bottle. That information stays inside the analyser or the vendor's own software. So LIMS counts usage the way your staff would. You tell us once, for example 'one glucose test on analyser BIO-1 uses 1 test of glucose reagent' and 'each QC run uses 1 test of reagent plus 0.1 mL of control'. From then on, every verified result, QC run and rerun is deducted automatically, normally within a minute. Calibrations are logged with one click. At a stock count, any difference between the counted stock and the system stock is shown as wastage, so leaks, spillage and unrecorded repeats become visible. If your analyser vendor can later give us an official interface for reagent levels, we can add it as an extra check. The counting model stays the record either way."

The help page and onboarding material must not claim analyser-level reagent telemetry (CV §0 rule "never present a default as the real answer").

## 2. Users and roles

Roles are the default roles in IC §11 (C2 lets tenants re-map them). The `inventory.*` permission codes beyond the two in IC §11 are requested in **CR-C12-001**. Everything is designed as if that CR were accepted.

| Role (IC §11) | What they do in C12 | Permissions (IC §11 + CR-C12-001) |
|---|---|---|
| `lab_manager` | Sets up items, packs, stores, suppliers, consumption rules and analyser bindings. Approves POs, posts stock counts and adjustments, reads every report. | `inventory.item.read`, `inventory.stock.manage`, `inventory.master.manage`, `inventory.stock.adjust` (privileged), `inventory.po.manage`, `inventory.po.approve` (privileged), `inventory.cost.read`, `inventory.report.export` (privileged), `inventory.bench.record` |
| `lab_technologist` | Opens and finishes reagent containers on the bench, logs calibrations and manual QC runs, looks up stock and lots | `inventory.item.read`, `inventory.bench.record` |
| `finance` | Raises and approves POs, reads costs, valuation and CPT, exports | `inventory.item.read` (CR adds `finance` to its roles), `inventory.po.manage`, `inventory.po.approve`, `inventory.cost.read`, `inventory.report.export` |
| `owner_viewer` | Reads consumption, wastage, valuation and CPT reports | `inventory.item.read` (CR adds `owner_viewer`), `inventory.cost.read`, `inventory.report.export` |
| Store keeper (no default role) | Receives goods, issues, transfers, records wastage | Tenants grant `inventory.stock.manage` + `inventory.item.read` to a custom role through C2 |
| System actor `inventory` (worker) | Consumes events, writes consumption, runs alert/cron jobs | Declared in the worker manifest (CV §2.3); CR-C12-008 |

Branch scope: every store belongs to one branch (`core.branches`). A user acts on a store only when `IdentityPort.assertRole(ctx, { permission, branchId: store.branch_id })` passes. That is the case when `ActorProfile.branchIds` contains the branch (explicit grant in `core.membership_branches`, 08 R3), or the user has all centres (C2 02-TRD §7 rule 6). This is DECISION D-SCOPE in `07-SECURITY.md` §2: inventory data is P0 (no PHI), so RLS is tenant-only and branch scope is enforced in the application (08 R3: branch scope is application-level only and may guard only P0/P1 data).

Cost visibility: money fields are returned only to holders of `inventory.cost.read`. This covers unit prices, values, CPT and valuation (REQ-SEC-081 field allowlist; `02-TRD.md` §6.3).

## 3. Problems this chunk solves

| # | Problem today (00 §3 item 7, 01 research §2.6) | C12 answer |
|---|---|---|
| P1 | Reagent use per analyser is unknown; nobody can say whether 1,000 glucose tests used 1,000 or 1,300 tests of reagent | Automatic deduction per verified test, rerun, QC and calibration, by analyser; reconciliation against LIS counts; count variance = wastage |
| P2 | Expired reagents are found on the shelf, or used | Lots with expiry and open-stability; FEFO suggestions; expiry alerts; expired-lot-in-use alert |
| P3 | Stock-outs stop testing | Reorder levels per store; alerts; one-click draft PO from reorder |
| P4 | Purchases are untracked: no approved PO, no link between invoice, lot and expiry | PO workflow with approval; goods receipt with lot capture against the PO; supplier master |
| P5 | Cost per test is guessed | CPT formulas from actual valued consumption (§8), by analyser |
| P6 | Wastage is invisible | Wastage with coded reasons; expiry write-off; count variance report |
| P7 | Several branches each hold stock | Stores per branch; transfers with in-transit state |

## 4. Scope

### 4.1 In scope (mapped to client baseline)

| ID | Capability | Baseline item | Notes |
|---|---|---|---|
| IS-01 | Item master: items in five categories (reagent, kit, consumable, control, calibrator) plus `other`; codes; manufacturer; catalogue no.; storage condition label; lot-tracked and expiry-required flags; open-stability days; container size | 00 §3 item 7 ("stock", "expiry") | |
| IS-02 | Units of measure (global coded set) and pack conversions per item (e.g. 1 box = 4 kits = 400 tests) | 00 §3 item 7 | `inventory.uom_mismatch` |
| IS-03 | Item barcodes (supplier or in-house) for scanner lookup | 00 §3 item 7 | GS1 AI parsing out of scope (§4.2) |
| IS-04 | Stores per branch (main/bench/other); one default consumption store per branch | 00 §3 item 7; 00 G3 (20 branches + centres) | 06-GLOSSARY "Branch" |
| IS-05 | Lots with expiry, manufactured-on date and status (available/quarantined/blocked) | 00 §3 item 7 ("expiry") | |
| IS-06 | Opened containers: opened-on, open-expiry = earlier of the lot expiry and opened-on + open-stability; in-use lot per analyser | 00 §3 item 7 | |
| IS-07 | Append-only stock ledger with movements: receive, supplier return, issue, return to store, transfer out/in, consumption (test/analyte/rerun/QC/calibration/fixed), consumption reversal, wastage, expiry write-off, adjustment in/out, count adjustment, opening balance | 00 §3 item 7 ("stock") | ledger never edited |
| IS-08 | Consumption models: per test, per analyte, per rerun, per QC observation, per calibration, per analyser-day | 00 §3 item 7 ("per test/cal/QC consumption", "real-time consumption"); 01 research §2.6 | from `lab.result.verified.v1`, `instruments.qc.received.v1`, `instruments.result.received.v1` (IC §3.9, §3.14, §3.15; A2) |
| IS-09 | Manual consumption log for calibration and manual QC (automatic calibration consumption uses `instruments.calibration.received.v1` — CR-C12-006, accepted in 08 R13 — only where a C7 driver classifies calibrator records, B2; the manual log covers every other analyser) | 00 §3 item 7 ("per cal") | |
| IS-10 | Analyser → store binding; store resolution chain; unresolved-consumption queue | 00 §3 item 7 ("analyser-wise") | |
| IS-11 | FEFO picking suggestion for issues, transfers and consumption lot selection | 01 research §2.6 ("FEFO issue") | `inventory.lot_expired` |
| IS-12 | Supplier master + supplier item prices and lead times | 00 §3 item 7 ("supply management") | |
| IS-13 | Purchase orders: draft → approved → sent → partially_received → received → closed (+ cancelled) | 00 §3 item 7 ("PO") | `inventory.po_invalid_transition` |
| IS-14 | Goods receipt (GRN) with lot capture (lot no., expiry), against a PO or direct; opening balances | 00 §3 item 7 | |
| IS-15 | VAT on purchases as data: per-line tax code (per item and supplier) whose rate is read from C3 through `CatalogPort.getTaxRate` and snapshotted in basis points on the line; C12 stores no rate values (08 R18, A2.2, CR-C12-010); tax codes are C3's (`^[A-Z0-9_]{1,16}$`, e.g. `VAT`; 08 A5.6) — `VAT` seeded; exemption is a treatment, not a code: an exempt line has no tax code and C12 never calls `getTaxRate` for it (08 A4.1); tenant-extensible codes; tenant switch "VAT in cost" (BLOCKED B7) | 04 L14, L15, B7, 08 A2.2 | rates are C3 data; C12 asserts none |
| IS-16 | Transfers between stores (draft → dispatched → received), with discrepancy capture | 00 G3 | |
| IS-17 | Wastage with coded reason; expiry write-off; container discard | 00 §3 item 7 ("wastage") | |
| IS-18 | Stock count (cycle count): snapshot, count entry, variance posting (variance = wastage per 01 research §2.6) | 01 research §2.6 | |
| IS-19 | Reorder levels per store × item; alerts (below reorder, expiring soon, expired on hand, open stability exceeded, negative/unlotted stock, unresolved consumption, expired lot in use, balance drift, reconciliation gap); draft PO from reorder | 00 §3 item 7; 01 research §2.6 ("reorder level → draft purchase order") | in-app only (§4.2) |
| IS-20 | Reports: daily consumption, analyser-wise consumption, cost per test, wastage, expiry, stock valuation, consumption reconciliation; CSV export | 00 §3 item 7 ("CPT calculation", "daily consumption", "analyser-wise consumption") | |
| IS-21 | Settings per tenant (feature switch with go-live instant, numbering patterns, tolerances, alert horizons) | — | |
| IS-22 | User manual pages + in-app help for every screen | CM §2 wishlist item 9 note | |

### 4.2 Out of scope

| Item | Why | Where it goes |
|---|---|---|
| Live analyser reagent-level telemetry | 04 N15, 04 §12 DROP list, CM §2 | CR + founder approval, per vendor, if an official interface ever appears |
| Statutory purchase register / accounting ledgers / supplier payments | Accounting is not a chunk (CM §2); 04 L6 lists purchase-register columns for IRD software, but C12 is not IRD billing software | C12 offers a CSV of posted GRNs (supplier PAN, invoice no., taxable/exempt/VAT columns) as input for the tenant's accountant. It is never labelled "purchase register" or "IRD" |
| Sales of reagents/kits to third parties | Not asked; 04 L15 note on kit sales applies to C4 invoicing | C4 (taxable lines) |
| GS1 barcode Application-Identifier parsing (GTIN/lot/expiry in one scan) | AI semantics not verified in this research set → UNVERIFIED | CR candidate (06 §6) |
| Emailing POs to suppliers; supplier portal | NotificationPort is for patient/staff messaging and C12 is not a consumer (CM §5.1); any supplier email channel needs a CR | PO is printed/exported; "sent" is recorded manually |
| Push/SMS/email alerts | C12 is not a NotificationPort consumer | In-app alert list + home-page banner; CR candidate |
| PDF rendering of POs | Renderer is C6's | Browser print view (HTML print CSS) |
| XLSX exports | No spreadsheet library is pinned in 04/CV | CSV (RFC 4180, UTF-8 BOM, in-module) |
| Margin per test (price − CPT) | Needs price lists (C3) joined with CPT; not asked explicitly | CR candidate |
| HR, assets, equipment maintenance logs | 04 §12 DROP (HR) / not asked | — |
| QC evaluation, Westgard, lot target setup for controls | C9 | C9 (control *material* stock is C12; control *targets* are C9) |

## 5. Phase

Phase 2 (04 §12 "inventory (consumption models, lots/expiry, PO, wastage)"). REQ-SEC §1, §3, §4, §6, §7 apply (04 §12 rule). The feature switch `settings.consumption_enabled_at` lets a tenant run master data, purchasing and stock first, then turn on automatic consumption at a chosen instant. Events that occurred before that instant are never deducted (US-12 AC-12.5).

## 6. User stories and acceptance criteria

AC numbering `AC-<story>.<n>`; each becomes at least one automated test (05-DEFINITION-OF-DONE §2). Quantities are DecimalStrings in base units unless stated. All data is synthetic.

### US-01 Item master (IS-01)
As a lab manager I record every reagent, kit, consumable, control and calibrator once, so stock and consumption are counted against one item.
- **AC-01.1** Given `inventory.master.manage`, when I create an item with code `GLU-R1`, category `reagent`, base unit `test`, then it is saved active with `version = 1`, and the response omits money fields unless I hold `inventory.cost.read`.
- **AC-01.2** Given an item `GLU-R1` exists in my tenant, when I create another item `GLU-R1`, then `409 inventory.code_duplicate` (CR-C12-003). Given the same code exists only in tenant B, then creation in tenant A succeeds.
- **AC-01.3** Given an item with stock movements, when I deactivate it, then it is hidden from pickers but stays readable in history and reports, and new receipts/issues of it fail `409 inventory.item_inactive`.
- **AC-01.4** Given `is_lot_tracked = true` and `requires_expiry = true`, when a goods receipt line for it lacks `lot_no` or `expiry_on`, then posting fails `400 common.validation_failed` with `errors[].path` pointing at the line field.
- **AC-01.5** Given an item that has any pack, consumption rule or stock movement, when I try to change `base_uom_code`, then `409 common.immutable_record` (same lock condition as the DB trigger, `05-SCHEMA.md` §5, and the S2 tooltip).

### US-02 Units and pack conversions (IS-02)
- **AC-02.1** Given item `GLU-R1` (base `test`) with pack `BOX` = 400 test, when I order 2 `BOX`, then the PO line stores `qty_base = 800`.
- **AC-02.2** Given a pack that a PO, GRN or rule references, sending `qty_in_base` in the PATCH returns `400 common.validation_failed` (the field is not in the request schema); the DB trigger also rejects a direct change with `409 common.immutable_record` (DB test). Changing `label` or `is_active` succeeds.
- **AC-02.3** Given a consumption rule or movement line that names a `pack_id` of another item, then `422 inventory.uom_mismatch`.
- **AC-02.4** Given a base-unit quantity with more than 6 decimal places, a pack quantity (`qty_packs`) with more than 3 decimal places or more than 9 integer digits, or ≤ 0 where a positive quantity is required, then `400 common.validation_failed` (`02-TRD.md` §6.1).

### US-03 Stores per branch (IS-04)
- **AC-03.1** Given branch BR-1, when I create store `BR1-MAIN` (kind `main`) and mark it default consumption, then it is the only default consumption store of BR-1. Marking a second store default in one call moves the flag (`If-Match` on both is not required; the service does it in one transaction).
- **AC-03.2** Given a user whose branch scope is BR-1 only, when they list stores, then they see only BR-1 stores. When they `GET` a BR-2 store id, then `404 common.not_found`.
- **AC-03.3** Given a store with a non-zero balance, when I deactivate it, then `409 inventory.store_not_empty` (CR-C12-003).

### US-04 Suppliers and supplier items (IS-12)
- **AC-04.1** Given `inventory.master.manage`, when I create supplier `SUP-01` with name and optional PAN text, then it is saved. Contact fields are personal data and never logged (07 §5).
- **AC-04.2** When I set supplier item (SUP-01, GLU-R1, BOX) with last price 450000 paisa and lead time 7 days, then PO drafts for that supplier/item default to that pack and price.

### US-05 Purchase orders (IS-13, IS-15)
- **AC-05.1** Given `inventory.po.manage`, when I create a draft PO for SUP-01 to store BR1-MAIN with lines, then line amounts are computed by the server: `net = round_half_up(qty_packs × unit_price) − discount`, `vat = round_half_up(net × tax_rate_bp / 10000)` with `tax_rate_bp` = `ratePercentBasisPoints` from `CatalogPort.getTaxRate` (08 A2.2) — or `0` for an exempt line (`is_exempt: true`, no tax code), which never calls `getTaxRate` (08 A4.1, A17 D-70) [CONV: 0 snapshot] — `line_total = net + vat`, and the totals equal the sum of the lines. A client-sent total is not accepted (the field is not in the request schema — CV §4.7).
- **AC-05.2** Given a draft PO, when a holder of `inventory.po.approve` approves it, then status = `approved`, `approved_by`/`approved_at` are set, and the content is frozen. A later edit returns `409 inventory.po_invalid_transition`.
- **AC-05.3** Given `po_self_approval_allowed = false` (default), when the creator approves their own PO, then `403 inventory.po_self_approval_forbidden` (CR-C12-003).
- **AC-05.4** Given an approved PO, when I mark it sent with channel `email` and a reference, then status = `sent`. Sending is recorded only; C12 sends nothing (§4.2).
- **AC-05.5** Given an approved or sent PO with no posted receipts, when I cancel it with a reason code, then status = `cancelled`. Given a PO with a posted receipt, cancel returns `409 inventory.po_invalid_transition`.
- **AC-05.6** Given a partially received PO, when I close it with reason `short_supply`, then status = `closed` and open quantities are marked closed-short.
- **AC-05.7** Every forbidden transition listed in `03-APP-FLOW.md` §3.1 returns `409 inventory.po_invalid_transition`.
- **AC-05.8** The tax code `VAT` (C3's code, 08 A5.6) is seeded (code and display only; C12 stores no rate — 08 A2.2). Its rate comes from C3 via `CatalogPort.getTaxRate(ctx, {taxCode, on})`; the 04 L14 rate (13 %) corresponds to 1300 basis points. Tenants may add codes; every code is a C3 tax-code value (`^[A-Z0-9_]{1,16}$`, 08 A5.6). An exempt line is sent with `is_exempt: true` and no `tax_code` (no `null` on the wire, 02-CV §4.2; 08 A17 D-70); it has no tax code and does not call `getTaxRate` (08 A4.1). `is_exempt: true` together with a `tax_code` → `400 common.validation_failed` at `/lines/n/tax_code`. `is_exempt: false` (default) with `tax_code` absent → the supplier item / item default code. Responses carry `is_exempt` and omit `tax_code` on exempt lines. A tax code inactive at draft time is rejected `400 common.validation_failed` (08 A13 P-1). A code for which C3 has no rate → `422 catalog.tax_config_missing` (propagated from CatalogPort, 08 R18).

### US-06 Goods receipt with lot capture (IS-14)
- **AC-06.1** Given a sent PO with line GLU-R1 2 BOX, when I post a GRN receiving 1 BOX lot `L-SYN-001` expiry 2027-06-30, then: lot `L-SYN-001` exists for GLU-R1; a `receive` movement of +400 is in BR1-MAIN; the balance (BR1-MAIN, GLU-R1, L-SYN-001) = 400; the PO line `received_qty_base = 400`; the PO status = `partially_received`.
- **AC-06.2** Given the rest is received later, then the PO status = `received`. The PO can then be closed.
- **AC-06.3** Given `over_receipt_tolerance_bp = 0`, when a GRN line exceeds the open PO quantity, then posting fails `422 inventory.over_receipt` (CR-C12-003).
- **AC-06.4** The capitalised value of a GRN line = `net_paisa + vat_paisa` when `vat_in_cost = true` (default), else `net_paisa`. The lot-store balance value increases by exactly that amount.
- **AC-06.5** Given a posted GRN, any edit returns `409 common.immutable_record`. Corrections are a supplier return (US-09) or an adjustment (US-11).
- **AC-06.6** Given `grn_without_po_allowed = false`, when a GRN of kind `purchase` has no PO, then `400 common.validation_failed` at `/po_id` (08 A13 P-1).
- **AC-06.7** Given an opening-balance GRN (kind `opening_balance`, no supplier), posting needs `inventory.stock.adjust` (privileged → aal2). Without it: `403 auth.forbidden`.
- **AC-06.8** Posting the same GRN twice (retry with the same `Idempotency-Key`) replays the first response. A second post with a new key returns `409 inventory.document_invalid_transition` (CR-C12-003); no duplicate movements are written.
- **AC-06.9** Given a receipt for a lot whose `expiry_on` is before the receipt date, then posting fails `409 inventory.lot_expired`.

### US-07 Lots, expiry and open stability (IS-05, IS-06)
- **AC-07.1** Given lot L-SYN-001 (expiry 2027-06-30) of an item with `open_stability_days = 30`, when I open a container on 2027-06-10 for analyser BIO-1, then `open_expiry_at` = end of 2027-06-30 in tenant time (the earlier date). For an opening at 2027-05-01 10:00 it is 2027-05-31 10:00 (opened-on + 30 days).
- **AC-07.2** Given an open container, the latest open container for (BIO-1, item) is the "in-use lot" used for automatic consumption (US-12 AC-12.3).
- **AC-07.3** Given a lot set to `quarantined`, FEFO suggestions skip it, and manual issue from it fails `409 inventory.lot_unavailable` (CR-C12-003).
- **AC-07.4** Given a lot past its expiry, manual issue/transfer from it fails `409 inventory.lot_expired`.

### US-08 Manual issue and return to store (IS-07, IS-11)
- **AC-08.1** Given `inventory.stock.manage` for BR-1, when I issue 10 `piece` of `TIPS-200` from BR1-MAIN to department Biochemistry without naming a lot, then the server picks lots by FEFO, writes one `issue` movement per lot used, and returns them.
- **AC-08.2** Given the requested quantity exceeds available non-expired, available-status stock, then `409 inventory.insufficient_stock`, with nothing written.
- **AC-08.3** Given a return to store of 2 pieces of a named lot, then a `return_to_store` movement of +2 is written, valued at the lot-store average cost (§8.1).

### US-09 Supplier return (IS-07)
- **AC-09.1** Given a posted GRN lot, when I return 1 BOX (400 test) to the supplier with reason `damaged_on_arrival`, then a `supplier_return` movement of −400 is written, and the GRN link is recorded.

### US-10 Transfers between stores (IS-16)
- **AC-10.1** Given a draft transfer BR1-MAIN → BR2-MAIN of 100 test of lot L-SYN-001, when it is dispatched, then a `transfer_out` of −100 is written at the source, and the quantity shows as in transit.
- **AC-10.2** (08 A17 D-69) When BR-2 receives 98 of 100 dispatched (dispatched value V), then a `transfer_in` of +98 is written at the destination with value `round_half_up(98 / 100 × V)`. At the source, on the same (store, item, lot) row as the `transfer_out` and in the same transaction (doc_type `transfer`), a `transfer_in` of +2 at the remaining value is written, followed by a `wastage` of −2 at the same value with reason = the line's discrepancy code (default `transit_loss`). The source nets −100; the loss appears in the wastage report at the source; the `wastage` row never raises `inventory.insufficient_stock` and never violates the lot non-negative CHECK.
- **AC-10.3** Receiving needs `inventory.stock.manage` on the destination branch. Dispatching needs it on the source branch. A user scoped to BR-1 only cannot receive at BR-2 (`404 common.not_found` on the transfer if it is not visible in their branch scope; `403 auth.forbidden` if visible but the action is outside scope).
- **AC-10.4** Forbidden transitions (e.g. `received → dispatched`, `cancelled → *`) return `409 inventory.document_invalid_transition` (CR-C12-003).

### US-11 Wastage, expiry write-off, adjustments (IS-17)
- **AC-11.1** When I record wastage without a reason code, then `422 inventory.reason_required` (CR-C12-003). With reason `spillage`, a `wastage` movement is written and the wastage report shows it.
- **AC-11.2** Given expired lots with stock, when I write them off, then one `expiry_writeoff` per (lot, store) clears the full remaining quantity and value. A non-expired lot in the request returns a per-line `400 common.validation_failed` (08 A13 P-1), and nothing is written.
- **AC-11.3** An adjustment (in or out) needs `inventory.stock.adjust` (privileged) and a reason. Without aal2: `403 auth.mfa_required`.

### US-12 Automatic per-test consumption (IS-08, IS-10)
As a lab manager I want each verified test to deduct reagent from its analyser's store automatically.
- **AC-12.1** Given rule (per_test, test GLU, instrument BIO-1, item GLU-R1, qty 1), BIO-1 bound to BR1-MAIN, and `consumption_enabled_at` in the past, when `lab.result.verified.v1` arrives for test GLU with `instrument_id = BIO-1`, then one `consume_test` movement of −1 is written in BR1-MAIN, attributed to test GLU and instrument BIO-1, within the latency target (`02-TRD.md` §12).
- **AC-12.2** Given a multi-analyte test CBC with 20 analytes each producing a verified event, then the per-test rules of CBC deduct **once** per (order item, test). Per-analyte rules deduct once per result, on its first verification only, also for every analyte after the first (the analyte fact is evaluated independently of the test fact, `02-TRD.md` §8.1). Test: CBC with 20 analyte events and a per-analyte rule on every analyte → 20 `consume_analyte` movements + 1 `consume_test`.
- **AC-12.3** Given an open container of lot L-SYN-002 on BIO-1 for GLU-R1, then consumption is taken from L-SYN-002 even if another lot expires earlier. Without an open container, consumption takes the FEFO lot.
- **AC-12.4** Given the same event delivered twice, or a later re-verification of the same result (IC §10.2 R5 → R4), then no second deduction happens (inbox dedupe + basis key).
- **AC-12.5** Given an event whose `verified_at` is before `consumption_enabled_at`, or a tenant with consumption disabled, then no fact and no movement is written; only the inbox row and the event-level reconciliation counters (`verified_result_events`, `instrument_qc_daily.qc_observations`) are written, so the reconciliation report works while consumption is off (08 A17 D-73).
- **AC-12.6** Given both an instrument-specific rule and a generic rule (instrument null) for the same (test, item), then only the instrument-specific rule applies for events from that instrument. Events from other instruments use the generic rule.
- **AC-12.7** Given no rule matches, then a `test` fact with status `no_rule` is still recorded, so test counts for CPT and reconciliation are complete.
- **AC-12.8** Given the in-use and FEFO lots together hold less than the required quantity, then the available quantity is taken from them and the remainder is written as an **unlotted** movement (lot null). A `negative_stock` alert opens. The consumer never fails because of stock level.
- **AC-12.9** Given an event that cannot be assigned to a store (step 6 of `02-TRD.md` §8.2), then the fact is stored `unresolved` and an `unresolved_consumption` alert opens. When an admin later resolves it to a store, the movements are written with the original business date.

### US-13 Rerun consumption (IS-08)
- **AC-13.1** Given rule (per_rerun, test GLU, BIO-1, GLU-R1, 1), when `instruments.result.received.v1` arrives with `is_rerun = true`, `mapping_status = mapped`, `test_id = GLU`, then one `consume_rerun` movement is written per (instrument message, test).
- **AC-13.2** Given `is_rerun` false or absent, `mapping_status = unmapped`, or no `test_id`, then nothing is written (metric `lims_inventory_events_skipped_total{reason}`).
- **AC-13.3** The PRD states, and the help page shows, that rerun detection depends on the analyser driver reporting reruns. This is UNVERIFIED per model (B2).

### US-14 QC consumption (IS-08)
- **AC-14.1** Given rule (per_qc, instrument BIO-1, analyte GLU-A, test GLU, item CTRL-L1, qty 0.1 ml) and rule (per_qc, BIO-1, GLU-A, GLU, item GLU-R1, qty 1), when `instruments.qc.received.v1` arrives for BIO-1 analyte GLU-A, then two `consume_qc` movements are written, both attributed to test GLU.
- **AC-14.2** Given a QC rule with `analyte_id` null on BIO-1, then it applies to every mapped QC observation of BIO-1. The rule form warns that this deducts once per analyte observation (guidance in 04-UI-UX §S13).
- **AC-14.3** Given `mapping_status = unmapped`, then nothing is deducted (metric reason `qc_unmapped`).
- **AC-14.4** A duplicate QC event (same envelope `idempotency_key`) deducts nothing.

### US-15 Calibration and manual QC log (IS-09)
- **AC-15.1** Given `inventory.bench.record`, when I log a calibration for (BIO-1, test GLU) at a time within the back-dating window (`backdate_max_days`), then the per_calibration rules for (GLU, BIO-1 or generic) deduct, attributed to GLU.
- **AC-15.2** A calibration time older than `backdate_max_days` (tenant setting, default 7) or more than 5 minutes in the future returns `400 common.validation_failed` [CONV back-dating window].
- **AC-15.3** Given a manual QC log with `observations = 3` for (test, analyte), the matching per_qc rules deduct 3 × qty.
- **AC-15.4** Given a manual fact logged in error, when a holder of `inventory.stock.adjust` reverses it with a reason, then `consume_reversal` movements restore exactly the quantities and values of the original movements, and the fact status = `reversed`. Event-sourced facts cannot be reversed (`409 inventory.fact_not_reversible`, CR-C12-003); correct them by adjustment.

### US-16 Analyser-day fixed consumption (IS-08)
- **AC-16.1** Given rule (per_day, BIO-1, item WASH-01, qty 50 ml) and `per_day_requires_activity = true`, when the nightly job runs for business date D and `instruments.v_pub_message_daily` shows BIO-1 had `messages > 0` on D, then one `consume_fixed` movement of −50 ml is written for D.
- **AC-16.2** Running the job twice for D writes nothing new (basis key `fixed:<rule>:<instrument>:<D>`).

### US-17 Analyser bindings and unresolved queue (IS-10)
- **AC-17.1** Given `inventory.master.manage`, when I bind instrument BIO-1 to BR1-BENCH, then later events from BIO-1 deduct from BR1-BENCH.
- **AC-17.2** Given unresolved facts for BIO-1, when I bind BIO-1, then a re-processing task posts those facts to the new store automatically.
- **AC-17.3** Given an unresolved fact, when I dismiss it with a reason, then its status = `dismissed`, nothing is deducted, and it still appears in the reconciliation report as dismissed.

### US-18 FEFO suggestion (IS-11)
- **AC-18.1** Given lots A (expiry 2027-01-31, sealed), B (expiry 2026-12-31, sealed), C (expiry 2027-03-31, one open container whose open expiry is 2026-12-20), when I ask for 50 units, then the suggestion orders C (open, by open expiry), then B, then A. It covers the quantity and lists the expiry and quantity per lot.
- **AC-18.2** Expired, quarantined and blocked lots never appear. If available stock is short, the response shows `shortfall_qty_base`.

### US-19 Stock count (IS-18)
- **AC-19.1** When I open a count for BR1-MAIN, then lines are created for every (item, lot) with a non-zero balance, or for the selected category, each with `book_qty_base` snapshotted.
- **AC-19.2** Given automatic consumption continues during the count, when I enter a counted quantity at time t, then the variance at posting = `counted − (snapshot + Σ movements between the snapshot and t)` for that line.
- **AC-19.3** When a holder of `inventory.stock.adjust` posts the count, then each non-zero variance becomes `count_adjust_in`/`count_adjust_out` with reason `count_variance` (or the line's reason). Negative variances appear in the wastage report as "count variance". If a negative variance of magnitude v exceeds the lot row's current quantity Q at posting (consumption continued after counting, AC-19.4), `count_adjust_out` takes −Q on the lot row and the remainder −(v − Q) on the unlotted row (same split as `consume_*`), and a `negative_stock` alert opens; posting never fails on the lot CHECK.
- **AC-19.4** Given `count_locks_store = true`, manual movements (issue, transfer dispatch, wastage, adjustment, GRN post) in that store fail `409 inventory.store_locked_for_count` (CR-C12-003) while the count is open. Automatic consumption is never blocked.

### US-20 Reorder and alerts (IS-19)
- **AC-20.1** Given reorder level 200 for (BR1-MAIN, GLU-R1), when the on-hand available quantity falls below 200, then one open `below_reorder` alert exists for that pair. Further movements update `last_raised_at`/`occurrences` but do not create a second alert.
- **AC-20.2** When stock returns to or above the level, the alert auto-resolves.
- **AC-20.3** Lots expiring within `expiry_alert_days` (default 30 [CONV]) with stock raise `expiry_soon`. Expired lots with stock raise `expired_on_hand`. Consumption from an expired in-use lot raises `expired_lot_in_use`.
- **AC-20.4** When I run "draft POs from reorder" for BR1-MAIN, then one draft PO per preferred supplier is created, with line qty = `reorder_qty_base` rounded up to whole packs of the chosen supplier item. The supplier item is the (preferred supplier, item) row whose pack is the item's `is_purchase_default` pack, if active; else the active supplier item with the largest `qty_in_base`; none → `skipped` with reason `no_pack`. Items without a preferred supplier are returned in `skipped[]`.

### US-21 Reports (IS-20)
- **AC-21.1** Daily consumption: for a store and date range, per day × item × kind: quantity and (with `inventory.cost.read`) value. The totals equal the sum of the ledger movements of those kinds (golden test).
- **AC-21.2** Analyser-wise consumption: per instrument × item × kind × period, plus test counts per test.
- **AC-21.3** CPT report returns, per (test, instrument, period): `tests_counted`, `direct_value_paisa`, `fixed_share_paisa`, `cpt_direct_paisa`, `cpt_loaded_paisa`, `cpt_standard_paisa`, with breakdown by kind, computed exactly per §8. Golden tests cover the rounding rules.
- **AC-21.4** Wastage report: recorded wastage by reason, expiry write-offs and count variance, with quantity and value.
- **AC-21.5** Expiry report: lots expiring within N days or expired, with stock, by store.
- **AC-21.6** Stock valuation: per store × item × lot: quantity, value, average unit cost, at "now" or at a past instant (as-of recomputed from the ledger).
- **AC-21.7** Reconciliation: per (test, business date): C12 `verified_result_events` vs `lab.v_pub_result_daily.results_verified`. Per (instrument, date): `instrument_qc_daily.qc_observations` (every non-duplicate QC event, mapped or not, counted before the mapping filter and the switch gate — 08 A17 D-74) vs `instruments.v_pub_message_daily.qc_records`. Differences are listed. A test-block difference above `reconciliation_gap_alert_bp` [CONV default 200 = 2 %] on a day with ≥ 50 events raises `reconciliation_gap`; the instrument block is listed without alerts [CONV, D-74]. The interactive report needs a user with all centres, because `lab.v_pub_result_daily` is centre-scoped for the caller; otherwise `403 auth.forbidden` [CONV]. The nightly scan runs as the system actor and is unaffected.
- **AC-21.8** CSV export of any report needs `inventory.report.export` (privileged). It writes an `access_log` entry with action `data.export`, and caps rows at 50,000 [CONV] (`422 inventory.export_too_large`, CR-C12-003). Every text cell passes `neutraliseFormula` from `@lims/shared-ts/spreadsheet` (08 A13 P-9): a cell starting with `=`, `+`, `-`, `@`, TAB (0x09), CR (0x0D) or `'` is prefixed with `'`.
- **AC-21.9** A user without `inventory.cost.read` gets the same reports with every `*_paisa` field omitted.

### US-22 Tenant isolation and branch scope (cross-cutting)
- **AC-22.1** For every endpoint: a tenant-A user using tenant-B ids gets `404 common.not_found` and no side effect (CV §11.3).
- **AC-22.2** For every store-bound action, a user without the store's branch in scope gets `404 common.not_found` (object not visible in list/get) or `403 auth.forbidden` (action on a visible object), per `07-SECURITY.md` §6.
- **AC-22.3** Bulk endpoints mixing A and B ids return per-id `common.not_found` for B ids.

## 7. Success metrics

| Metric | Target | Source |
|---|---|---|
| Consumption latency (event `occurred_at` → movement committed), p95 | ≤ 60 s [CONV] | `lims_inventory_consumption_lag_seconds` |
| Reconciliation gap (C12 verified events vs C5 view) per tenant-day | ≤ 0.5 % after the first month [CONV] | reconciliation report |
| Count variance value / consumption value per month | reported, no target (baseline unknown — ASSUMPTION) | wastage report |
| Expired stock written off vs expired on hand | 100 % of expired lots written off or flagged within 7 days [CONV] | alerts |
| Stock-out events (available = 0 for an item with a reorder level) | trend down quarter on quarter | alerts history |
| Unresolved facts older than 24 h | 0 [CONV] | unresolved queue |

## 8. Cost-per-test (CPT) and valuation definitions (binding for TRD and tests)

### 8.1 Valuation (moving average per store × lot)
- Each balance row `(store, item, lot)` carries `qty_base` and `value_paisa` (integer).
- **Inbound** movements add their value. Receive: capitalised GRN value. Transfer in: the dispatched value. Return to store, adjustment in and count adjustment in: the current average of the row, or, if the row has qty ≤ 0, the lot's last receipt unit cost (`last_receipt_value_paisa / last_receipt_qty_base`); for the unlotted row (no lot), the item's average cost in the store (unlotted rule below). If none exists, 0 with `value_basis = 'none'`.
- **Inbound into a negative row** (08 A17 D-75; only the unlotted row can be negative). Inbound q into a row with Q < 0 and value V: if q ≥ −Q, the first −Q units take value −V (clearing it) and the remainder q + Q is valued by the normal rule above; if q < −Q, value = `round_half_up(q × V / Q)`. This applies to the row-valued kinds (`return_to_store`, `adjust_in`, `count_adjust_in`). Kinds whose value is fixed by their source (`receive`, `opening_balance` = capitalised value; `transfer_in` = dispatched value; `consume_reversal` = negated original) keep that value [CONV: AC-06.4 and the transfer/reversal values stay exact]. Golden cases cover both branches.
- **Outbound** movement of quantity q from a row with quantity Q > 0 and value V:
  - if q = Q → value = V (the row clears exactly);
  - if q < Q → value = round_half_up(q × V / Q);
  - if q > Q (only possible for automatic consumption) → the movement is split: the first part takes Q at V; the excess goes to the unlotted row (rule below).
- **Unlotted row** (`lot_id` null) of a lot-tracked item = consumption beyond book stock. Its outbound value = round_half_up(q × item average cost in the store), where item average cost = Σ value / Σ qty over that store's lot rows with qty > 0. Fallbacks: the item's latest lot `last_receipt` unit cost in the tenant, else 0 (`value_basis = 'none'`). The row may go negative in quantity and value. Non-lot-tracked items always use the unlotted row as their normal stock.
- All arithmetic is exact decimal (Postgres `numeric`); results are rounded half-up to integer paisa once per movement (CV §4.9).

### 8.2 Test counts
- `N(T, I, P)` = number of distinct (order item, test) pairs of test T whose **first** verified event in C12 had `instrument_id = I` (I may be "none"), with business date in period P. Business date = `verified_at` in the tenant timezone.

### 8.3 CPT
For test T, instrument I (or none), period P (a set of business dates):
- `D(T,I,P)` = Σ of consumption values (positive = consumed; reversals subtract) of kinds `consume_test`, `consume_analyte`, `consume_rerun`, `consume_qc`, `consume_calibration`, `consume_reversal` attributed to T on I in P.
- `F(I,P)` = Σ of consumption values of kind `consume_fixed` on I in P (not attributed to a test).
- `Ntot(I,P)` = Σ over all tests T' of `N(T',I,P)`.
- `cpt_direct_paisa` = round_half_up(D / N). Null when N = 0.
- `fixed_share_paisa` = round_half_up(F × N / Ntot). 0 when Ntot = 0.
- `cpt_loaded_paisa` = round_half_up((D + F × N / Ntot) / N). Null when N = 0.
- Wastage, expiry write-offs and count variance are **not** part of CPT. They are reported separately (DECISION: allocating them to tests would be arbitrary; the wastage report shows them in full).
- `cpt_standard_paisa(T, I, as_of)` = Σ over the matching active `per_test` rules of `qty_base × avg_cost(item, store(I))` + Σ over the matching active `per_analyte` rules for the reportable analytes of T (`CatalogPort.getTest`) of `qty_base × avg_cost`, rounded half-up once at the end. `store(I)` = the binding store of I, else the tenant default consumption store. `avg_cost` as in §8.1. When any item has no cost, the result carries `is_complete = false` and `missing_item_ids[]`.

## 9. Dependencies (contracts only)

| Dependency | Kind | Use | Fake until real |
|---|---|---|---|
| `IdentityPort.assertRole`, `getActor`, `getTenantSettings` (C2) | port | authz with `branchId`; timezone | `packages/fakes` IdentityPort |
| `CatalogPort.getTest` (C3) | port | validate rule test/analyte; analytes for standard CPT; department | CatalogPort fake |
| `CatalogPort.getTaxRate` (C3; CR-C12-010, 08 A2.2) | port | purchase-tax rate for a PO/GRN line's tax code on a date | CatalogPort fake (seeded `VAT` 1300, `kind 'vat'`, `effectiveFrom: null`; 08 A4.1/A5.6) |
| `lab.result.verified.v1` (C5) | event | per-test/per-analyte consumption; test counts | event fixtures from IC §3.9 |
| `instruments.qc.received.v1` (C7) | event | per-QC consumption | IC §3.15 example |
| `instruments.result.received.v1` (C7) | event | rerun consumption | IC §3.14 example |
| `catalog.v_pub_test_directory` | view | test code/name labels | seeded view rows |
| `lab.v_pub_result_daily` | view | reconciliation | seeded |
| `instruments.v_pub_message_daily` | view | per-day activity, QC reconciliation | seeded |
| `ctx.core` (C0): branches, centres, tenant | core repo | store branch; centre → branch | C0 test DB seeds |
| C3 HTTP catalog search, C7 HTTP instrument list (BFF, user token) | HTTP | pickers in the UI | MSW/Prism mocks |
| CR-C12-004 `processing_branch_id` on `lab.result.verified.v1` (accepted in 08) | event (additive) | store resolution for manual results | until C5 emits it: chain without it |
| `instruments.v_pub_instrument_directory` (CR-C9-006; CR-C12-005 merged, 08 R12d — columns `tenant_id, instrument_id, centre_id, instrument_code, display_name, vendor, model, state, is_active`) | view | instrument names; centre → store fallback | until C0 creates it: show instrument id; skip step 4 |
| CR-C12-006 `instruments.calibration.received.v1` (accepted in 08 R13; 03-IC §3.26) | event (new) | automatic calibration consumption | manual log (US-15) for analysers whose driver does not emit it (B2) |

## 10. Blocked items and defaults built meanwhile

| B# | Effect on C12 | Default built |
|---|---|---|
| B2 (analyser models/manuals) | Unknown which analysers report reruns, QC record structure, calibration records | Rerun and QC consumption work when the driver emits the fields; calibration automatic only where the driver emits `instruments.calibration.received.v1` (08 R13), else manual; per-model behaviour is UNVERIFIED and noted in help |
| B3 (test list) | No real tests to attach rules to | Synthetic catalog from `packages/test-fixtures`; rules are data |
| B7 (VAT treatment) | Whether purchase VAT is recoverable for the lab | `vat_in_cost` tenant switch, default `true` (cost includes VAT); tax codes are data; rates are not stored in C12 — they are read from C3 via `CatalogPort.getTaxRate` (08 A2.2) |
| B15 (retention) | Ledger retention | Ledger and documents kept for the tenant retention setting, minimum 5 years (CV §5.11); no purge job in v1 |
| B1 (priority) | Could move C12 later/earlier | No code impact |
