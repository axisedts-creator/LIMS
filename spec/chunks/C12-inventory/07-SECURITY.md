# C12 Inventory — 07 Security

Status: DECISION, 2026-11-06. REQ-SEC IDs are from `research/02-security.md` and are cited, not copied. They apply from Phase 1 rules per 04 §12, and C12 ships in Phase 2.

## 1. Applicable requirements

| REQ-SEC | How it applies to C12 |
|---|---|
| 001, 002 | ASVS L2 target; BOLA is the main threat: every id in path/body is loaded through RLS + an explicit tenant filter, then branch-checked |
| 004 | Data inventory: `05-SCHEMA.md` §3 classifies every column (P0/P1/P2-personal/financial) |
| 011, 012, 014, 015, 016 | RLS ENABLE + FORCE on all 32 tenant tables (incl. `instrument_qc_daily`, 08 A17 D-74; plus the C0 `event_inbox`); per-command policies `TO lims_app`; the only DELETE policy is `alerts__delete__tenant` (class E, system actor, expired rows — 08 A17 D-72); draft lines are soft-removed, never deleted (D-71); default deny |
| 013, 027 | `tenant_id` only from verified claims; never a request field (`02-TRD.md` §6.1) |
| 017 | Centre/branch scoping: DECISION D-SCOPE (§2). Branch scope is enforced in the application via `IdentityPort.assertRole({branchId})`, not in RLS; branch grants are explicit `core.membership_branches` rows and are application-level only (08 R3). Every `__tenant` policy also requires `app.is_staff_or_system()`, so partner/portal/patient actors see no inventory rows (CR-C13-011, 08 R10) |
| 019–021 | No new SECURITY DEFINER. All C12 triggers are INVOKER with `search_path = ''`. The alert purge `app.purge_inventory_alerts()` is SECURITY INVOKER (CR-C12-008 as amended by 08 A17 D-72): it runs in the `per_tenant` task as the `inventory` system actor and can delete only that tenant's expired alerts through `alerts__delete__tenant`; no owner policy, no index exception, no 08 §4.7 DEFINER row |
| 022, 023 | Helpers wrapped in `(SELECT …)`; `tenant_id` leads every index |
| 024 | Repositories add `tenant_id = $tenant` to every query |
| 026 | Composite `(tenant_id, id)` FKs everywhere, including the cross-schema FKs to `catalog.tests/analytes/departments`, `instruments.instruments`, `core.branches` |
| 028 | UUIDv7 ids; human numbers (`po_no` etc.) are never in URLs |
| 031 | C12 reads `v_pub_*` views (security_invoker) and defines none |
| 039, 131 | `lims_app` gets no UPDATE/DELETE on ledger/documents (A class) and no DELETE on any C table, draft lines included; DELETE only on `alerts` (E); CI asserts |
| 040, 041, 042, 044 | Cross-tenant and cross-branch probes for every operation and table (§6); mixed-id bulk inputs |
| 045, 133 | `auth.forbidden` spikes on inventory endpoints feed C1 alerting (standard metrics); balance-drift alert |
| 046 | Server authority on amounts: PO/GRN totals, VAT and capitalised values are computed server-side; request schemas do not declare them |
| 055 (analogue) | Privileged `inventory.stock.adjust` (aal2) for adjustments, count posting, lot status/expiry correction, opening balances, fact reversal: these can hide loss or theft. `inventory.po.approve` (aal2) for money commitment. Optional four-eyes on PO approval (`po_self_approval_allowed = false` default) |
| 057 (analogue) | The stock ledger is append-only; corrections are reversing/adjusting movements, never edits |
| 062 | MFA for privileged inventory permissions (04 A4), via the C2 step-up |
| 078, 079 | `general` tier on all operations (10 req/s/user, burst 20; 04 §4) |
| 080 | Strict spec validation, `additionalProperties: false`, max lengths/items, DecimalString patterns |
| 081 | Cost fields only with `inventory.cost.read`; `basis_key`/`source_event_id` never returned; supplier contact fields only in supplier endpoints |
| 082 | Parameterised SQL only; the `q` prefix search escapes `%`/`_` |
| 088 | React text nodes only; no rich text in C12 |
| 091, 092 | State changes only via POST/PUT/PATCH through the BFF (C0 CSRF/Origin checks) |
| 095 | Problem+json with registry titles; no SQL/stack in `detail` |
| 096, 097 | Data changes → audit trigger on M/C tables (C0). CSV exports (#55, #93) → `access_log` `data.export` (`02-TRD.md` §5.10, 08 A13 P-3). The ledger itself is append-only |
| 098 | No PHI in logs/URLs. C12 stores no sample barcodes, patient ids, order ids, result values or analyser raw text; item barcodes (`item_barcodes`, P0 product codes) are stored but never logged |
| 099 | Every route is in `inventory.yaml`; no public routes |
| 100 | Abuse controls: row caps on exports/reports; date range ≤ 366 days; bulk lines ≤ 200 |
| 128 | No secrets used by C12 |
| 136 | Synthetic data only (`05-SCHEMA.md` §6.5) |
| 139 | Retention via tenant setting (B15); no PHI → no anonymisation duties |

## 2. Design decisions with security impact

| ID | Decision | Rationale | Compensating controls |
|---|---|---|---|
| D-SCOPE | RLS is tenant-only on all inventory tables. Branch scope is enforced by `assertRole({branchId})` and branch-filtered queries | Inventory rows are P0/P1 (no PHI). Stores are branch-bound while RLS helpers expose centres, not branches (CV §5.8). CV §5.8 leaves the scoping choice to the chunk | Every store-bound handler loads the store first and asserts the branch. Probes P-B1…P-B6 (§6). Lists filter by `getActor().branchIds`. A lint test checks that every handler under `handlers/` calls `scope.assertStoreAccess` or is listed in a tenant-scope allowlist matching `02-TRD.md` §5 "Scope" |
| D-EVT | Consumers read only the needed payload fields of P3+P2 events (`instruments.result.received.v1` carries `sample_barcode` and values); the read list is the last column of `02-TRD.md` §8.1 | Data minimisation (REQ-SEC-004, 098) | Code review checklist + a unit test that the consumer's typed input contains exactly that list (incl. `processing_branch_id`, `verified_at`) and omits these fields; the `event_inbox` stores only `event_id`/type |
| D-NOTE | Free-text notes (bench log, documents) are staff text | Any free text could receive PHI | UI help "Do not enter patient details"; ≤ 500 chars; never logged; never sent to other modules |

## 3. Threat model (STRIDE per asset / entry point)

| Asset / entry point | S (spoof) | T (tamper) | R (repudiation) | I (info disclosure) | D (DoS) | E (elevation) |
|---|---|---|---|---|---|---|
| Stock ledger & balances | forged system actor writing movements → only the worker with system claims and the API module write; no direct DB access | edit/delete movements to hide loss → no UPDATE/DELETE grants; integrity job detects drift between balances and ledger | "I didn't adjust" → `created_by` on every movement + audit on documents; privileged ops need aal2 | value data visible to bench staff → cost allowlist | mass tiny movements → rate limit; lines ≤ 200 | technologist posts adjustments → `stock.adjust` privileged |
| Consumer jobs (C5/C7 events) | forged event → events come only from `core.event_log` written in producer transactions (C0); no HTTP ingress | replayed events inflate consumption → inbox dedupe + basis-key unique | — | payload PHI (barcode, values) → not read/stored (D-EVT) | event flood (e.g. a C7 reprocess) → skip path ≤ 20 ms; worker concurrency bounded; fact dedupe | — |
| PO / GRN (money) | — | client-side totals → server-computed; immutable after approve/post (trigger) | approver identity → approved_by, aal2, optional four-eyes | supplier prices to non-cost roles → allowlist | — | self-approval → `po_self_approval_forbidden` (default) |
| Stock count / adjustments | — | inflate a count to hide theft → privileged post; blind count by default; variance report | posted_by + audit | — | — | — |
| Reports / CSV export | — | CSV formula injection in Excel → every text cell through `neutraliseFormula` (`@lims/shared-ts/spreadsheet`, 08 A13 P-9: `'` prefix for `=`, `+`, `-`, `@`, TAB, CR or `'` at cell start; no module-local copy) | export logged (`data.export`) | cross-branch data in reports → branch filter; cross-tenant → RLS + explicit filter | huge ranges → 366-day cap, 50,000 rows | export by a non-privileged user → `report.export` privileged |
| Rules / bindings | — | malicious rule (huge qty) inflates consumption → `master.manage` (lab manager); rule history immutable; preview; reconciliation | created_by, supersede chain | — | — | — |
| Supplier master | — | — | — | contact personal data → only supplier endpoints; not in logs | — | — |
| Barcode lookup | — | — | — | enumeration of item codes → tenant-scoped, rate-limited, non-PHI | scanner loops → rate limit | — |

## 4. Abuse cases and required behaviour

| # | Abuse | Required behaviour | Test |
|---|---|---|---|
| A1 | User of tenant A posts a GRN line referencing tenant B's item/pack/lot ids | composite FK + RLS → `404 common.not_found` (mapped FK violation), nothing written | probe |
| A2 | User scoped to BR-1 dispatches a transfer from BR-2's store | `404 common.not_found` (store not visible) | branch probe |
| A3 | Store keeper hides a stolen box via "wastage: other" repeatedly | allowed (they hold `stock.manage`), but every wastage needs a reason and appears in the wastage report by user. The privileged count variance shows unexplained loss. **Detective control, not preventive** — stated in the manual | report test |
| A4 | Technologist reverses event-sourced consumption to make stock look higher | `inventory.fact_not_reversible`; manual reversals need `stock.adjust` (aal2) | contract |
| A5 | Creator approves their own large PO | `inventory.po_self_approval_forbidden` unless the tenant allows it | contract |
| A6 | Client sends `total_paisa`, `vat_paisa`, `status` or `tenant_id` in a body | `400 common.validation_failed` (unknown field) | contract |
| A7 | Replay of a GRN post with a new Idempotency-Key | `inventory.document_invalid_transition` | contract |
| A8 | Export of a whole year, every day, by automation | rate limit + row cap + access log; C1 alert on export spikes (REQ-SEC-133 pattern) | integration |
| A9 | Bench note containing a patient name | UI warning; text never leaves C12, never logged; retention as tenant setting | review |
| A10 | Fabricated calibration logs to inflate CPT | `bench.record` required; created_by on the fact; reversal privileged; reconciliation and count variance expose unusual consumption | report test |
| A11 | Mixed-tenant ids in `lot_ids[]` (#47) | per-line not found for B ids; nothing written for B | probe |
| A12 | Changing `qty_in_base` of a pack after receipts to revalue stock | field not in the request schema; DB trigger rejects | contract + DB test |

## 5. PHI handling and logging rules

- C12 stores **no PHI** (`05-SCHEMA.md` §3). The only person-linked data are pseudonymous UUIDs inside `consumption_facts.basis_key` (order_item_id / result_id) and `source_event_id` (P1). Both are never returned by the API and never logged [CONV].
- Event payload fields `sample_barcode`, `value_raw`, `value_numeric`, `unit_raw`, `instrument_flags`, `control_id_raw`, `control_lot_raw`, `control_level` are never read into variables, stored or logged (D-EVT).
- Logs carry ids, codes, counts and durations only (CV §9.1–9.2). Prices and values are not logged (financial data stays in the DB and the audit trail).
- Supplier contact fields (P2-personal) are never logged and appear only in supplier DTOs.
- Exports carry no PHI. They are still treated as data exports (privileged + access log) because they contain commercial data.

## 6. Required security tests

### 6.1 Cross-tenant probes (every operation in `inventory.yaml`; CV §11.3)
- P-T1 For each of #1–#93: tenant-A user with tenant-B ids in path/body/query → `404 common.not_found`, no B data in the body, and no row change in B (verified as owner in the test harness).
- P-T2 List endpoints with B data present → zero B rows.
- P-T3 Write/FK probes: create PO/GRN/transfer/issue/rule/binding in A referencing a B store, item, pack, lot, supplier, test, analyte, instrument or department → rejected (404 mapping of FK/RLS failure).
- P-T4 Bulk/array inputs mixing A and B ids (`lines[]`, `lot_ids[]`, `item_ids[]`) → B ids yield per-item not found and A ids are not partially applied (the whole document fails; DECISION: documents are atomic).
- P-T5 SQL probes per table (all 32 tenant tables + inbox): claims of A → SELECT sees 0 B rows; INSERT with B tenant fails; UPDATE/DELETE of B rows affect 0 rows. Partner, portal and patient claims of tenant A read 0 rows of every table (P-16 generated probe). `alerts`: a user actor's DELETE (or `app.purge_inventory_alerts()` call) deletes 0 rows; the system actor deletes only A's rows with `expires_at < now()`.
- P-T6 Consumers: an event with tenant B's envelope never touches A rows (worker claims built from the envelope `tenant_id` — CV §6).

### 6.2 Branch-scope probes
- P-B1 User scoped to BR-1: GET store/stock/movements/documents/counts/containers of a BR-2 store → 404; lists exclude BR-2. `listConsumptionFacts` (#75) returns no fact (and no embedded movement) whose `store_id` is in BR-2; facts with `store_id` NULL are returned.
- P-B2 Actions on BR-2 objects (issue, wastage, adjust, GRN post, count post, container open, PO approve for a BR-2 PO) → 404.
- P-B3 Transfer BR-1 → BR-2: a BR-1 user can create, dispatch and cancel, but receiving returns `403 auth.forbidden`, because the transfer is visible to them as its source. A BR-2 user can view and receive, but dispatching returns `403`.
- P-B4 An all-centres user sees every branch.
- P-B5 `purpose=transfer_target` returns all active stores with minimal fields only (no stock or value fields).
- P-B6 Reports with `store_id` outside scope → 404; reports without a store filter aggregate only the visible branches. `consumption_reconciliation` (#92, #93) by a user without all centres → `403 auth.forbidden`.
- P-B7 `logConsumptionEvent` (#76) by a BR-1 user whose matched rules resolve to a BR-2 store → `403 auth.forbidden`, nothing written; a `no_rule` or `unresolved` outcome needs tenant scope only.
- P-B8 Order of checks (`assertStoreAccess`): an object in an invisible branch → 404 even when the permission is also missing; a visible object with a missing permission → 403.

### 6.3 Privilege-escalation tests
- PE-1 Every privileged operation (#32, #33, #48, #53 opening balance, #67, #79, #84, #86 for approved/sent, #55, #93) at aal1 → `403 auth.mfa_required`; without the permission → `403 auth.forbidden`.
- PE-2 A technologist (`item.read`, `bench.record`) cannot call any `stock.manage`, `master.manage`, `po.*`, `stock.adjust` or `report.export` operation.
- PE-3 Cost fields are absent for a user without `inventory.cost.read` in every DTO and report; `cost_per_test` → 403.
- PE-4 Membership revoked after token issue → privileged operations fail (IdentityPort re-validation).
- PE-5 Self-approval blocked by default.

### 6.4 Integrity tests
- IT-1 `has_table_privilege('lims_app', …, 'UPDATE'|'DELETE') = false` for `stock_movements`, `stock_documents`, `stock_document_lines`; `DELETE` = false on every C table, including `purchase_order_lines`, `goods_receipt_lines`, `transfer_lines` (D-71); `alerts` is the only table with DELETE = true.
- IT-1a Draft replace (#52, #59, #83) marks lines removed; setting `removed_at` on a line of a non-draft parent → `P0001` (`tg_line_guard`).
- IT-2 The trigger rejects edits of posted GRNs/approved POs, pack size changes and rule quantity changes (`P0001 immutable_row`).
- IT-3 The balance-vs-ledger invariant holds after randomised operation sequences (property test, 1,000 operations, fixed seed).
- IT-4 A duplicate event (same `event_id`) and a duplicate logical fact (same basis key) cause no change.

### 6.5 Logging tests
- LT-1 The planted-PHI log scan (DoD §1.8): run the consumers with IC example payloads containing a synthetic barcode → the barcode never appears in log output.
- LT-2 Supplier contact values never appear in logs.

## 7. Secrets
None. C12 uses no external service, key or token beyond the platform JWT handled by C0/C2.

## 8. Security checklist (chunk gate)
- [ ] §6.1–6.5 tests present and green
- [ ] D-SCOPE lint test (every handler asserts store access or is on the tenant-scope allowlist)
- [ ] No new SECURITY DEFINER; triggers and `app.purge_inventory_alerts()` INVOKER with `search_path=''`
- [ ] No foreign touchpoint (04 §11); no new dependency
- [ ] Privileged permissions match CR-C12-001 and require aal2
- [ ] Cost allowlist unit tests for every DTO with money
- [ ] CSV formula-injection test
- [ ] Consumers' typed inputs exclude P2/P3 fields (D-EVT test)
