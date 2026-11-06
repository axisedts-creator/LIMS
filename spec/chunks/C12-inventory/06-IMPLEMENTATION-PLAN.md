# C12 Inventory — 06 Implementation Plan

Status: DECISION, 2026-11-06.

Prerequisites (or their fakes):
- C0 has merged the `inventory` DDL/RLS (`05-SCHEMA.md`) and `contracts/openapi/inventory.yaml` (`02-TRD.md` §5);
- event schemas for `lab.result.verified.v1`, `instruments.qc.received.v1`, `instruments.result.received.v1` (IC §3);
- fakes for IdentityPort and CatalogPort (incl. `getTaxRate`, CR-C12-010 / 08 A2.2);
- the CRs in `02-TRD.md` §17, or the defaults named there.

One task ≈ one PR (CV §12). Branch names `c12/<topic>`.

Path abbreviations:
- **API** = `services/api/src/modules/inventory/`
- **WK** = `services/worker/src/jobs/inventory/`
- **WEB-A** = `apps/web/src/app/(staff)/inventory/`
- **WEB-F** = `apps/web/src/features/inventory/`
- **MAN** = `docs/manual/inventory/`

## 1. Tasks

| ID | Goal | Files | Depends on | Done when | Tests | ACs |
|---|---|---|---|---|---|---|
| T-01 | Module skeleton: manifest, permissions, config, handler map bound to every operationId (stubs throw `common.internal` until their task) | API `index.ts`, `permissions.ts`, `config.ts`, `handlers/index.ts`; WK `index.ts` (subscriptions declared, handlers no-op behind a test flag) | C0 contracts | API and worker boot; the manifest CI check (subscriptions ⊆ IC §3 consumer lists) passes | boot test | — |
| T-02 | Domain: quantity, money line computation, numbering parser, state tables, basis keys, FEFO comparator, rule precedence | API `domain/*` | T-01 | every allowed transition + one forbidden per state (03-APP-FLOW §3) tested; money golden table (≥ 30 cases); numbering with `{yy}`, `{fy}` at the Shrawan 1 boundary using the shared bsdate golden table | unit | AC-02.4, AC-05.1, AC-05.7, AC-18.1 |
| T-03 | Repositories for all tables; explicit tenant filter; optimistic version updates; reads of line tables filter `removed_at IS NULL` | API `repository/*` | T-01 | integration tests on migrated DB (`UNIQUE NULLS NOT DISTINCT` verified on the pinned image); EXPLAIN checks for the queries in 05 §10 use the listed indexes | integration | — |
| T-04 | Scope service + mappers with cost allowlist | API `service/scope.service.ts`, `mappers/*` | T-03 | visible-branch computation from `getActor()`; `assertStoreAccess` order (invisible branch → 404, then `assertRole` → 403) and `assertTransferAccess` (TRD §5 Scope); every DTO with cost fields tested with/without `inventory.cost.read` | unit + integration | AC-21.9, AC-22.2 |
| T-05 | **Ledger core** `ledger.service.post()`: locking order, valuation (§4.3), unlotted handling, `consumption_daily` upserts, alert hooks | API `service/ledger.service.ts`, `service/alerts.service.ts` | T-03 | invariants of TRD §10 hold after every test; concurrency test (20 parallel posts, same item) exact, no deadlock; rounding golden pinned on the PG image | unit (valuation golden) + integration (concurrency) | AC-06.4, AC-08.3, AC-12.8, AC-20.1–20.2 |
| T-06 | Settings + coded sets (#26–#29) | API handlers/services | T-03 | lazy settings row (`INSERT … ON CONFLICT DO NOTHING`, P-22); pattern validation (`400`, P-1); `consumption_enabled_at` ≥ now − 3600 s when set from NULL; tenant code shadowing; tax codes carry no rate, seed display `VAT` (08 A2.2) | contract + probes | AC-05.8 |
| T-07 | Items, packs, barcodes (#1–#10) | API handlers, `items.service.ts` | T-04 | code uniqueness; base unit lock (any pack, rule or movement); pack size immutability (`400` from the schema, `409` from the trigger); barcode upper-casing before insert and lookup; deactivate rules | contract + integration + probes | AC-01.1–01.5, AC-02.1–02.3 |
| T-08 | Stores, store item settings, suppliers, supplier items, bindings (#11–#25) | API | T-04 | default-store single flag; `store_not_empty`; binding triggers `resolve_unresolved` enqueue (task stubbed until T-15) | contract + integration + probes (branch scope) | AC-03.1–03.3, AC-04.1–04.2, AC-17.1 |
| T-09 | Lots, FEFO suggestion, containers (#30–#39) | API `lots.service.ts` | T-05, T-07, T-08 | open-expiry computation in tenant timezone; in-use lot query; `expired_only` filter on #34 | unit + integration | AC-07.1–07.4, AC-18.1–18.2 |
| T-10 | Stock documents: issue, store return, supplier return, wastage, adjustment, expiry write-off (#41–#48); container discard #40 (creates a wastage document) | API `documents.service.ts`, `lots.service.ts` (discard) | T-05, T-09 | FEFO split server-side; reasons; privileged adjustment; count lock; inbound into a negative unlotted row (D-75 goldens) | contract + integration + probes | AC-08.1–08.3, AC-09.1, AC-11.1–11.3 |
| T-11 | Purchase orders (#80–#89) incl. from-reorder and print view | API `purchasing.service.ts` | T-05, T-07, T-08 | state machine; self-approval rule; totals server-side; line `tax_rate_bp` from `CatalogPort.getTaxRate` (CR-C12-010, 08 A2.2), `catalog.tax_config_missing` rethrown unchanged (P-23); `is_exempt` wire field (D-70); draft replace by soft removal (D-71); `DecimalStringPacks`; reorder grouping by preferred supplier, supplier-item pack choice (AC-20.4) and rounding up to whole packs; Idempotency-Key required on #84/#86/#87 (P-8) | contract + integration + probes | AC-05.1–05.8, AC-20.4 |
| T-12 | Goods receipts (#49–#55) incl. CSV export | API `receipts.service.ts`, `domain/csv.ts` | T-11 | posting algorithm 03-APP-FLOW §4.2; line `tax_rate_bp` from `CatalogPort.getTaxRate` (08 A2.2); `is_exempt` (D-70); draft replace by soft removal (D-71); replay safety; over-receipt; lot upsert conflicts; CSV cells via `@lims/shared-ts/spreadsheet` `neutraliseFormula` (P-9); export access log (§5.10) | contract + integration + probes | AC-06.1–06.9 |
| T-13 | Transfers (#56–#62) | API `transfers.service.ts` | T-05, T-07, T-08, T-09 | FEFO split at dispatch; pro-rata value; transit loss per D-69 (source `transfer_in` + `wastage` pair, source nets −d, also on a lot row that dispatched its last units); draft replace by soft removal (D-71); two-branch scope (`assertTransferAccess`) | integration + probes | AC-10.1–10.4 |
| T-14 | Stock counts (#63–#68) | API `counts.service.ts` | T-05, T-07, T-08 | variance formula with movements up to counted_at; negative variance larger than the lot row → lot/unlotted split + `negative_stock` (AC-19.3); blind count; uncounted policy | integration | AC-19.1–19.4 |
| T-15 | Consumption rules + preview (#69–#74); consumption service (rule matching, store resolution, fact posting); manual log, resolve, dismiss, reverse (#75–#79); `inventory.resolve_unresolved` task | API `consumption.service.ts`, `consumers.service.ts`; WK `tasks/inventory.resolve_unresolved.ts` | T-05, T-08, T-09 | shape checks via CatalogPort fake; precedence; supersede; no rule cache (indexed lookup per event); fact inserted with its final status; resolution chain steps 1, 2, 5, 6 (3/4 behind CR flags); #75 branch-filtered; #76 resolved-store scope (403); reversal exactness | unit + integration + probes | AC-15.1–15.4, AC-17.2–17.3 |
| T-16 | Consumer `lab.result.verified.v1` | WK `consumers/lab.result.verified.v1.ts` | T-15 | TRD §8.1 steps and table; facts (a)/(b) evaluated independently; fact inserted with its final status; event counter written while consumption is off (D-73); enable instant; concurrent analyte events | consumer contract (IC example, extra fields, absent optional fields, duplicate, before-enable, concurrency, 20-analyte CBC with per-analyte rules → 20 `consume_analyte` + 1 `consume_test`) | AC-12.1–12.7, AC-12.9 |
| T-17 | Consumers `instruments.result.received.v1` (reruns), `instruments.qc.received.v1` and `instruments.calibration.received.v1` (CR-C12-006, 08 R13) | WK consumers | T-15 | filters; `instrument_qc_daily.qc_observations` before the mapping filter and the switch gate (D-74); `qc_events` per distinct attributed test; analyte-null QC rules; centre → branch store; calibration → `per_calibration` facts | consumer contract | AC-13.1–13.3, AC-14.1–14.4, AC-21.7 (counter part) |
| T-18 | Crons: daily fixed consumption, alert scan, integrity check, reconciliation scan, alert purge; alert rules file `ops/inventory.rules.yml` (CR-C12-011) | WK `tasks/*`, `cron.ts`, `ops/inventory.rules.yml` | T-15, T-05 | all five crons `tenantScope: 'per_tenant'` (P-6, D-72); catch-up ≤ 7 days; integrity never auto-corrects; reconciliation alerts on the test block only (D-74); purge calls the INVOKER `app.purge_inventory_alerts()` as the system actor via `alerts__delete__tenant` (D-72); a user actor deletes nothing | integration | AC-16.1–16.2, AC-20.3, AC-21.7 (alert part) |
| T-19 | Reports + CSV export (#90–#93) | API `reports.service.ts`, `views.repo.ts` | T-16, T-17 | golden datasets per report; CPT formulas exactly per PRD §8.3 (N = 0, Ntot = 0, .5 rounding, reversal); reconciliation instrument block from `instrument_qc_daily` (D-74) and `centreScope.all` rule; access_log on export; row caps; `neutraliseFormula` on every cell (P-9) | integration (golden) + contract | AC-21.1–21.9 |
| T-20 | Web shell: nav manifest, layout, home S1, alerts S16, settings S18 | WEB-A, WEB-F | T-06, T-19 | nav builds (route ids from CR-C12-002); loading/error per page | component (MSW) | AC-20.1 (UI), AC-22.2 (UI hides) |
| T-21 | Web master data: S2–S5, S14 | WEB-A, WEB-F | T-07, T-08 | forms mirror spec validation; scanner add-barcode | component + e2e | AC-01.x, AC-03.x, AC-04.x |
| T-22 | Web purchasing + receiving: S6 (incl. print), S7 | WEB-A, WEB-F | T-11, T-12 | line editor keyboard flows; step-up on approve; scan to add lines | component + e2e | AC-05.x, AC-06.x |
| T-23 | Web stock operations: S8, S9, S10, S11, S12 | WEB-A, WEB-F | T-09, T-10, T-13, T-14 | FEFO preview; blind count; bench forms | component + e2e | AC-08.x, AC-10.x, AC-11.x, AC-19.x, AC-07.x, AC-15.x |
| T-24 | Web rules, unresolved, reports: S13, S15, S17 | WEB-A, WEB-F | T-15, T-19 | kind guidance copy; preview drawer; report tabs; export | component + e2e | AC-12.x (config), AC-21.x |
| T-25 | Manual + in-app help | MAN, WEB-F `help/` | T-20..T-24 | one page per screen + the four topic pages (04 §7); the consumption-model text matches PRD §1.1 verbatim | review checklist | PRD §1.1 |
| T-26 | Performance + chunk gate | tests | all | TRD §12 targets at 1× and 10× seed; probes complete (cross-tenant P-T1–P-T6 for every operation, mixed-id bulk inputs, branch P-B1–P-B8); security checklist (07 §8) green | perf + probes | DoD §3, AC-22.1, AC-22.2, AC-22.3 |

## 2. Milestones

| M | Contents | Exit |
|---|---|---|
| M1 Ledger foundation | T-01–T-06 | ledger invariants and valuation goldens green |
| M2 Master data + stock operations | T-07–T-10, T-13, T-14 | manual stock life-cycle works end-to-end via API |
| M3 Purchasing | T-11, T-12 | PO → GRN → stock with lots |
| M4 Automatic consumption | T-15–T-18 | consumer contract suites green on fakes; staging run against real C5/C7 events |
| M5 Reports + UI | T-19–T-25 | e2e journey receive → consume (simulated events) → count → reports |
| M6 Chunk gate | T-26 | DoD §3 + security sign-off |

## 3. Integration points: fakes → real

| Dependency | Fake until | Switch when | Check after switch |
|---|---|---|---|
| IdentityPort (C2) | `packages/fakes` | C2 passes its chunk gate | branch-scope probes rerun against real memberships (explicit branch grants (08 R3)) |
| CatalogPort (C3) | fake catalog with GLU/CBC; `getTaxRate` fake (`VAT` 1300, `kind 'vat'`, `effectiveFrom: null`; no exempt entry — exempt lines never call it, 08 A4.1/A5.6) | C3 chunk gate | rule validation with real analytes; standard CPT; PO/GRN `tax_rate_bp` equals C3 `getTaxRate` (08 A2.2) |
| `lab.result.verified.v1` (C5) | IC §3.9 fixtures | C5 in staging | reconciliation report ≈ 0 difference on synthetic day |
| `instruments.*` events (C7) | IC §3.14/3.15 fixtures | C7 in staging with the simulator | rerun/QC deduction from replayed sessions |
| Views (`catalog`, `lab`, `instruments`) | seeded rows in test DB | owners' migrations merged | report goldens unchanged |
| CR-C12-004/006 (accepted), CR-C9-006 view (CR-C12-005 merged) — 08 | resolution steps 3/4 disabled; calibration via manual log | C5 emits `processing_branch_id`; C0 creates the view; C7 driver emits calibration events (B2) | enable the step by config `LIMS_INVENTORY_RESOLUTION_STEPS` [CONV, default `1,2,5`]; calibration consumer is always subscribed |

## 4. Definition of done mapping
Every AC in `01-PRD.md` maps to at least one task above (AC-22.1 and AC-22.3 via T-26 and the probe step of every API task T-06–T-19). A task closes only when its AC tests pass (DoD §2).

## 5. Rollout per tenant (runbook)
1. Create stores per branch; set the default consumption store per branch.
2. Import or create items and packs; link barcodes.
3. Enter opening balances (GRN kind `opening_balance`, stock.adjust).
4. Configure rules per test/analyser; bind analysers to stores.
5. Run 3–7 days with consumption **off**, using the preview and the reconciliation report to compare against the LIS (the event counters are written while consumption is off — 08 A17 D-73).
6. Turn consumption on from a chosen instant (S18).
7. First stock count after 2–4 weeks [CONV]; review the variance.

08 Addendum A2/A3 applied 2026-11-06 (A2.2: rates via `CatalogPort.getTaxRate`, CR-C12-010 accepted).

08 Addendum A4/A5 applied 2026-11-06 (A4.1 `getTaxRate` signature, exempt lines = no tax code, no port call; A5.3 `on` = tenant business date accepted; A5.6 uppercase C3 tax codes, seed `VAT`).

Review fix pass 2026-11-06 applied (review/C12-inventory.md; 08 A17 D-69…D-75, P-18, P-21, P-22, P-23; A13 P-1, P-3, P-6, P-8, P-9, P-10, P-14, P-15): task dependencies of T-09/T-10/T-11/T-13/T-14 corrected, AC-22.1/22.3 mapped to T-26, decimal-helper CR candidate dropped (CM §3 already lists `@lims/shared-ts/decimal`).

## 6. CR candidates foreseen (not raised yet)
- `inventory.v_pub_consumption_daily` for a C8 inventory MIS tile.
- XLSX export once a spreadsheet writer is pinned repo-wide (C8's CR-C8-014 proposes `write-excel-file` 4.1.1).
- GS1 barcode parsing (GTIN + lot + expiry in one scan). Needs a verified GS1 source first; UNVERIFIED today.
- Reorder/expiry alert e-mail via NotificationPort (C12 would need to become a consumer — CM §5.1 change).
- Margin per test (CPT vs price list via `CatalogPort.priceFor`).
- Per-control-run QC deduction (one deduction per control level run instead of per analyte observation). It needs an analyser-verified grouping key; B2.

## 7. Risks

| # | Risk | L/I | Mitigation |
|---|---|---|---|
| R1 | Analysers do not report reruns or classify QC reliably (B2) | H/M | Rerun/QC rules are optional; count variance captures the gap; reconciliation report; help text states the dependency |
| R2 | Write load above the 04 §14 derived ≲ 50 writes/s (TRD §12 estimate ≈ 103 row writes/s at N = 10 peak) | M/M | skip path with 1–2 writes; indexed rule lookup (no cache, TRD §11); load test at 10× seed; C1 sizes worker concurrency; within the 250 writes/s headroom target |
| R3 | Hot balance rows (one reagent row per busy analyser) serialise consumers | M/L | ≈ 0.5 posting events/s/lab; lock held ≪ 100 ms; measured in T-26 |
| R4 | Labs configure rules wrongly (e.g. analyte-null QC rules on large panels) | H/M | kind guidance copy; preview; consumption-off trial week; reversal of manual facts; adjustments |
| R5 | Unlotted negative stock accumulates silently | M/M | `negative_stock` alert on first occurrence; S1 tile; count reconciles |
| R6 | Branch scope semantics differ between C0 (derived) and C2 (explicit `branch_ids`) | M/M | Closed by 08 R3: explicit `core.membership_branches`; probes test that model only. |
| R7 | VAT-in-cost choice wrong for a tenant (B7) | M/L | per-tenant switch; changes affect only future receipts (help says so) |
| R8 | Client expects analyser reagent telemetry | M/H | PRD §1.1 explanation in onboarding and help; S1 and S13 link to it |
