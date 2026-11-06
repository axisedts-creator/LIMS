# C5 Lab Workflow — 06 Implementation Plan

Status: DECISION, 2026-11-05. Prerequisite: C0 has merged `lab` DDL/RLS (05-SCHEMA), `contracts/openapi/lab.yaml` (02-TRD §5), the 7 lab event schemas, `contracts/ports/LabPort.ts`, fakes for CatalogPort/FrontdeskPort/IdentityPort/QualityPort/NotificationPort, and the CRs in 02-TRD §15 (or their fakes). One task ≈ one PR (02-CV §12). Branch names `c05/<topic>`.

Paths abbreviations: **API** = `services/api/src/modules/lab/`, **WK** = `services/worker/src/jobs/lab/`, **WEB-A** = `apps/web/src/app/(staff)/lab/`, **WEB-F** = `apps/web/src/features/lab/`.

---

## 1. Tasks

| ID | Goal | Files | Depends on | Done when | Tests | ACs |
|---|---|---|---|---|---|---|
| T-01 | Module skeleton: manifest, permissions, config, empty handler map that boots against `lab.yaml` | API `index.ts`, `permissions.ts`, `config.ts`, `handlers/index.ts` (stubs returning 501 are **not** allowed — each stub throws `common.internal` and is replaced by its task); WK `index.ts` | C0 | API boots with all operationIds bound; worker manifest subscriptions equal 02-TRD §7.2 | boot test; manifest CI check | — |
| T-02 | Pure state machines + roll-up | API `domain/specimen.state.ts`, `result.state.ts`, `rollup.ts` | T-01 | every S1–S15/R1–R8 allowed transition + every forbidden example in 03-IC §10 unit-tested | unit | AC-03.4, AC-04.3, AC-05.4, AC-06.3, AC-15.3 |
| T-03 | Repositories (all tables) with explicit tenant filter; optimistic version updates | API `repository/*.repo.ts` | T-01 | integration tests on migrated DB pass; every query uses an index from 05 §5 (EXPLAIN check in test for worklist, history, lookup) | integration | — |
| T-04 | Event publishers (7 events) with idempotency keys per 02-TRD §7.1 | API `events/publish.ts` | T-01 | every payload validates against schema; keys match 03-IC | unit + event contract | AC-01.1, AC-05.1 |
| T-05 | Barcode pattern parser/renderer + counter allocation | API `domain/barcode.ts`, `service/specimen.service.ts` (alloc) | T-03 | patterns incl. `{prefix}` (from `numbering.barcodePrefix`, absent = empty), `{yy}`, `{seq:N}`, literals; `{branch}`/`{centre}`/`{fy}`/`{fyl}` rejected; overflow → `lab.barcode_pattern_invalid`; default `{prefix}{yy}{seq:8}` renders `E2600000042` for prefix `E`, counter 41 (08 A13 D-8) | unit + integration (concurrency: 50 parallel allocations unique) | AC-01.3, AC-01.4 |
| T-06 | Order consumers: created / items_changed / cancelled | WK `consumers/frontdesk.order.*.ts`; API `service/order.service.ts`, `specimen.service.ts` | T-02..T-05 | §4.1 algorithm; inbox dedupe; stale seq; unknown-order path via `getOrderSummary` + `getPatientDemographics(result_evaluation)` with `collection_mode` NULL; cancel sets `lab_status` | consumer contract (example, dup, stale, unknown fields) | AC-01.1–01.8 |
| T-07 | Specimen actions: collect, bulk collect, dispatch, receive, bulk receive, store, discard (incl. from `recollection_ordered`, D-15), lookup (barcode and registration-no body forms), get, list | API handlers + `specimen.service.ts`, mappers | T-06 | HTTP contract tests per x-error-codes; S4 copies processing centre to existing-material rows (D-13) | contract, integration, probes | AC-03.1, AC-03.3, AC-03.4, AC-04.1–04.3 |
| T-08 | Reject + recollection + aliquots | API handlers `rejectSpecimen` (Idem R), `requestRecollection`, `createAliquots`; service | T-07 | one-tx semantics of AC-05.1 (new result rows, old rows cancelled — D-12; processing centre copied — D-13); reject without recollection cancels the order tests (D-5); late recollection re-opens them; event sequence; old barcode stays on rejected specimen | integration + event spy | AC-05.1–05.9, AC-06.1–06.3 |
| T-09 | Home-collection consumer | WK `consumers/homecollection.collection.synced.v1.ts` | T-07 | S2+S3; device time clamp; unverified flag; optional `booking_id` tolerated (08 A19 D-120) | consumer contract (payload with and without `booking_id`) | AC-03.2, AC-03.2a |
| T-10 | Label data endpoint + order label-readiness operation (CR-C4-010: `requestOrderLabelPrint`, `200` / `409 common.version_conflict` with detail before specimens exist — no dedicated code, 08 A2.10; `x-idempotency: none`, no counter, no access log — 08 A13 D-4) + web label page (`@lims/ui` `BarcodeSymbol` Code 128, `LabelRenderer`, `PrintFrame`), print on open, readiness wait/poll | API `printSpecimenLabels`, `requestOrderLabelPrint`; WEB-A `orders/[order_id]/labels/`; WEB-F `components/labels/*`, `server/printSpecimenLabels.server.ts` | T-07; CR-C5-007 (route); `BarcodeSymbol` (C0-0D) | print CSS sized from the #14 response; `specimen_label.print` access_log and counter per specimen only in #14; #14a writes nothing; inactive per-id error; 409 then 200 retry path without key; page calls neither #15 nor #47 | component (MSW), contract (200/409), e2e print-preview snapshot | AC-02.1–02.5 |
| T-11 | Collect & dispatch screen; receive screen with `BarcodeInput`/`useScanCapture` (kit defaults) | WEB-A `collect/`, `receive/`; WEB-F components | T-07, T-08, UI kit | keyboard-only flows pass; scanner simulation (fast keystrokes + Enter); registration-no lookup | component + e2e | AC-03.1, AC-03.3, AC-04.1–04.4, AC-05.1 |
| T-12 | Value evaluation domain: flags, delta, critical decision, canonical value hash | API `domain/flags.ts`, `delta.ts`; `service/evaluation.service.ts` | T-03 | boundary tests (equal-to-limit not flagged; missing range → no flag; unknown age → range/critical called without `ageDays`, and `range_unavailable_age_unknown` set when either finds nothing — 08 A17.1); delta pct with prev 0; ordinal validation against `ordinalSetValues` and `A` via `normalCodes` (D-9); R7 outputs written only to `result_versions` | unit | AC-08.2, AC-08.8, AC-12.1–12.2, AC-13.1–13.3 |
| T-13 | Formula evaluation through `@lims/shared-ts/formula` (C0-0A; no local parser — 08 R12a) + dependency recompute + provenance | API `domain/formulaInputs.ts`; `service/result.service.ts` (recompute) | T-12; C0-0A formula lib | shared vectors (Friedewald incl. TG≥400, A/G ratio, NLR, division by zero, `missing_input` → `waiting_for_inputs`, transcendental → inexact) | unit + integration | AC-09.1–09.7 |
| T-14 | Manual entry: `bulkEnterResults`, `getResult`, `listOrderResults` | API handlers, `result.service.ts`, mappers | T-12, T-13 | per-row outcomes; versions; locked; ordinal validation | contract + integration + probes | AC-08.2–08.7 |
| T-15 | Critical log + notifications endpoints; status transitions open → notified → closed (02-TRD §5.5) | API `critical.service.ts`, handlers 35–37 | T-12 | append-only notifications; first confirmed timestamp; close on approve/cancel (amendment events close at first confirmed notification); `read_back_text` required when confirmed; `referrer_display_name` via `getReferrer` | integration + probes | AC-13.4–13.6 |
| T-16 | Verify / bulk verify / return; acknowledgements; auto-verify hook behind flag | API handlers 27–29, `result.service.ts` | T-14, T-15 | `lab.flag_ack_required` (CR-C5-005); verify with `unit_mismatch` acknowledged resolves the open `unit_mismatch` exception; event omits `verified_by_membership_id` for auto and `specimen_id` for specimen-less results (D-2); hook not called when flag false; with flag true it is called for every instrument-origin save regardless of the tenant switch (CR-C9-004) and fake allow → mode auto + event; never called for a result with `range_unavailable_age_unknown` (08 A17.1) | contract + integration | AC-12.3, AC-15.1–15.5 |
| T-17 | Approve / bulk approve / amend; versions; lock trigger behaviour; readiness evaluation + event | API handlers 30–33, `domain/readiness.ts`, `order.service.ts` | T-16 | self-approval forbidden; mfa passthrough; amendment cascade to formulas; amendment evaluation written only to the new `result_versions` row and read back through `v_result_current` (finding #10); readiness excludes cancelled order tests (D-5); hash equals fake spec | unit (hash) + integration + DB lock test (UPDATE as lims_api raises) | AC-09.5, AC-13.5, AC-16.1–16.6, AC-17.1–17.4 |
| T-18 | Short codes (server resolution + UI expansion) | API `result.service.ts` (resolve via CatalogPort CR-C5-001); WEB-F grid comment cell | T-14 | stored text + version; unknown code error | integration + component | AC-10.1–10.3 |
| T-19 | History + trend endpoints | API handlers 25–26 | T-14 | tenant/patient isolation; unit separation | integration + probes | AC-11.1–11.3 |
| T-20 | Result entry grid screen (keyboard-first) + history panel + trend dialog + amend/return dialogs | WEB-A `orders/[order_id]/results/`; WEB-F `components/grid/*` | T-14..T-19, UI kit `EditableGrid`, `TimeSeriesChart` | every shortcut in 04-UI-UX §3.6 works without mouse (automated keyboard test) | component + e2e | AC-08.1, AC-08.4, AC-09.2–09.3, AC-10.1, AC-11.1–11.2 |
| T-21 | Verification + approval queue screens; step-up handling | WEB-A `verification/`, `approval/` | T-16, T-17 | bulk outcome dialog; flagged-row acknowledgement | component + e2e | AC-15.2, AC-16.3 |
| T-22 | Ingest pipeline (decision table) + `instruments.result.received.v1` consumer + `ingest_log` | API `domain/matching.ts`, `service/ingest.service.ts`; WK consumer | T-12, T-14 | every row of 02-TRD §4.5 has a test; result-level key duplicates; attachment tenant check | unit + consumer contract | AC-14.1–14.4, AC-14.7–14.8 |
| T-23 | Exception queue endpoints + reapply tasks + screen | API handlers 38–42; WK `tasks/lab.reapply_*`; WEB-A `ingest-exceptions/` | T-22 | assign/reapply/discard; auto reapply on receive and catalog change; list page served at route `staff.lab.ingest_exceptions` (`/lab/ingest-exceptions`, CR-C7-014) | integration + component | AC-04.5, AC-14.3, AC-14.5 |
| T-24 | `LabPort` implementation incl. host query, replay (re-evaluation of open exceptions, CR-C7-011), holds, module submissions (`amendment` + R1 guards incl. `module_preliminary_update`, 08 A17 D-61), `getOrderItemProcessingState`, `listPendingForInstrument`, `lookupSpecimens` (three selectors), `getAnalyteHistory`; contract suite | API `ports/LabPort.impl.ts`, `service/module-result.service.ts`, `qc.service.ts` | T-17, T-22 | `runLabPortContract` cases 1–36 (03-IC §4.5 + 08 §4.14 + 08 A13 D-5/D-7 + 08 A17 D-61) and C5-local A17.2-a/b pass on the real impl; `getOrderItemProcessingState` returns `processingStatus` with the A17.2 rules (`result_entered`); `submitModuleResult` on `verified` → system R5 `module_resubmitted` + R3; `versionNo` = `current_version_no`; p95 host query ≤ 300 ms in perf test | port contract + perf | AC-05.8, AC-05.10, AC-14.6, AC-17.5, AC-17.6, AC-19.4, AC-20.1–20.2 |
| T-25 | QC capture consumer + endpoints + screen; `quality.qc_run.rejected.v1` consumer; hold release endpoint | WK consumers; API handlers 43–46; WEB-A `qc/`, settings QC holds tab | T-24 | dedupe; no enforcement copy in UI; manual capture sets `centre_id` (actor scope), `value_raw`, `received_at`, `idempotency_key = manual:<id>`; `qc_results` centre RLS | consumer contract + component | AC-19.1–19.4 |
| T-26 | Worklists, pending list, worksheets (API + screens + print) | API handlers 18–22, `worklist.service.ts`; WEB-A `worklists/`, `pending/`, `worksheets/` | T-14 | instrument filter via cached outbound map; instrument names via C7 E23 (`IdText` on 403, D-14); worksheet `centre_id` rule; items copy centre columns; `worksheet.print` access log; snapshot immutability | integration + component + perf (p95 ≤ 300 ms) | AC-07.1–07.5 |
| T-27 | Report-released consumer (A8), S10, status board API + screen | WK `consumers/reporting.report.released.v1.ts`; API handler 17; WEB-A `status-board/` | T-17 | one rule (02-TRD §7.2): final/amended/addendum/unknown → S10 for the approved specimens of `order_item_ids` (all items when absent) + `order_tests.reported_at`; partial → only listed items (absent → no change); preliminary → recorded, no S10, board "Printed (preliminary)"; `report_kind` stored without closed CHECK; board projection rules | consumer contract + component | AC-18.1–18.4 |
| T-28 | Catalog-changed consumer + port caches | WK consumer; API `service/cache.ts` | T-06 | invalidation by revision; reapply task enqueue | unit + consumer contract | — |
| T-29 | Configuration: lab settings, delta rules (versioning), coded sets; settings screen | API handlers 47–54, `config.service.ts`; WEB-A `settings/` | T-03 | versioned rules effective_from; global/tenant shadowing | integration + probes + component | AC-12.4 |
| T-30 | Specimen detail page + timeline | WEB-A `specimens/[specimen_id]/` | T-07, T-08 | actions per state & permission | component | — |
| T-31 | Observability: metrics, alert rule file `WK ops/lab.rules.yml` (C1 wires it via CR-C5-010, 08 A13 P-14), access-log coverage, PHI log scan | API/WK instrumentation | all | metrics in 02-TRD §11 exist; `promtool check rules` passes on the file; every `ctx.audit.access` action is one of the six D-11 codes; log-scan test with planted PHI passes | unit + log-scan | — |
| T-32 | Security test suite: cross-tenant + cross-centre probes for every operation and table; device-actor probes; privilege tests | API `__tests__/probes/*` | all endpoints | 07-SECURITY §5 list green | probes | 07 §5 |
| T-33 | Help + manual pages for every screen | WEB-F `help/*`; `docs/manual/lab/*` | screens | one page per screen in 04-UI-UX §3 | doc lint | — |
| T-34 | E2E journeys (nightly) | `apps/web/tests/e2e/lab/*` | all | journeys in 02-TRD §13 green on compose stack | e2e | cross-cutting |

## 2. Milestones

| M | Contents | Exit |
|---|---|---|
| M1 Specimens | T-01–T-11 | order → labels → collect → receive → reject/recollect/aliquot on fakes |
| M2 Results | T-12–T-21 | manual entry → verify → approve → amend → readiness event on fakes |
| M3 Instruments & ports | T-22–T-25, T-28 | LabPort contract suite green; ingest pipeline + exceptions |
| M4 Floor tools | T-26, T-27, T-29, T-30 | worklists, pending, worksheets, status board, settings |
| M5 Hardening | T-31–T-34 | chunk gate (05-DoD §3) |

## 3. Swapping fakes for real implementations

| Dependency | Fake until | Switch when | Integration check |
|---|---|---|---|
| `CatalogPort` (C3) | M1 | C3 passes its chunk gate (CR-C5-001 merged into CR-C3-001: `resolveCommentCodes` C3 shape + `asOf`) | specimen requirements, ranges, critical limits, code maps, comment codes on synthetic catalog |
| `FrontdeskPort` (C4) | M1 | C4 chunk gate (CR-C5-003 accepted in 08: purposes `result_evaluation`, `lab_display`, batch read) | registration no, demographics per purpose |
| `IdentityPort` (C2) | M1 | C2 chunk gate (CR-C5-004 accepted; CR-C5-009 merged into CR-C2-008: `numbering.barcodePrefix`) | permissions incl. new codes; numbering pattern + prefix |
| `QualityPort` (C9) | Phase 2 (production: phase stub — 08 R9) | C9 chunk gate | only with `LIMS_LAB_AUTOVERIFY_HOOK_ENABLED=true` in staging; called for every instrument-origin save (CR-C9-004) |
| Events from C4/C7/C17/C6/C3/C9 | synthetic events via `packages/test-fixtures` | producer chunk gate | end-to-end journeys (05-DoD §5) |
| `@lims/shared-ts/formula` | none (T-13 waits for C0-0A; 08 R12a) | C0-0A ships the lib | shared vectors pass in C3 and C5 |

## 4. Definition of done for this chunk

05-DoD §3, plus: LabPort contract suite on the real impl (T-24); every consumer has duplicate + stale tests; performance table 02-TRD §10 met at 1× and 10× seed.

## 5. Integration points needing other chunks' attention

- C4 registration page calls `requestOrderLabelPrint` (readiness) and, when `frontdesk.label_autoprint` is on, opens `staff.lab.order_labels` after `200` (CR-C5-007, 08 A13 D-4) — C4's UI change.
- C4 consumes `lab.specimen.status_changed.v1` with `to_status = recollection_ordered` (08 A13 D-6) and calls `getOrderItemProcessingState` with `frontdesk.order.read` for its derived order status (D-5).
- C2 shows the hub-lab provisioning warning of 05-SCHEMA §1 on invite/role screens (08 A13 D-13).
- C1 wires the C5 alert rule file (CR-C5-010).
- C7 must call `LabPort.getPendingTestsForBarcode` under the device context whose `centre_id` equals the receiving centre (05-SCHEMA §1 ASSUMPTION).
- C6 should add `order_item_ids` to `reporting.report.released.v1` (CR-C5-006).
- C8/C9 read `lab.v_pub_*` under system context.
- C13 and C16 read the two `lab.v_pub_specimen_timeline` columns appended by 08 A19 D-106 (CR-C16-022: `replaces_specimen_id`, `specimen_version`); C0 transcribes the view from 05-SCHEMA §4 (AC-20.3); until it merges, C16 backfills `status_seq = 0` (D-106).
- C10 sends `module_preliminary_update` automatically for a second micro preliminary (08 A17 D-61); C6 excludes it from its report-kind rule and labels the version `preliminary` (C6's half).

## 6. CR candidates foreseen (not yet raised)

| Candidate | To | Why |
|---|---|---|
| Specimen requirement grouping for multi-draw tests (GTT) — e.g. `separateContainer`/`drawCount` on `ResolvedOrderables.specimenRequirements` | C3 / C0-0C | PRD Q2 |
| `frontdesk.patient.merged.v1` event (or merge mapping port) so history/delta follow merged patients | C4 / C0-0C | PRD Q3 |
| ZPL label renderer through the bridge agent (print job channel) | C7 / C0-0C | 02-TRD §4.6 |
| Manual attachment upload for attachment tests (with scan/quarantine pipeline) | C0 / C6 | PRD §4.2 |
| QC hold release by C9 event (`quality.qc_run.accepted.v1`) instead of manual release | C9 / C0-0C | Phase 2 |
| Instrument id validation port for manual QC capture | C7 | 02-TRD §5.7 |
| Specimen `cancelled` state (instead of `is_active = false`) if consumers need to see it | C0-0C (breaking enum change) | 03-APP-FLOW §1.1 |
| Tenant timezone in `business_date` of `v_pub_*` (v1: `Asia/Kathmandu` only, 08 A13 P-15; needs stored `business_date` columns) | C0-0B | 05-SCHEMA §4 note |

## 7. Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Label printers without OS drivers or with poor browser print fidelity (ASSUMPTION in 02-TRD §4.6) | labels unreadable / delayed | site acceptance test per printer model at go-live; `LabelRenderer` interface allows a ZPL adapter via C7 CR |
| Analysers fail to read Code 128 at small sizes | instrument mismatch, manual work | minimum module width + "too small" warning; confirm with analyser vendors (B2) |
| Specimen creation is async; label page polls | front desk waits | p95 ≤ 5 s target + metric `lims_lab_specimen_creation_lag_seconds` + alert |
| Formula grammar divergence C3 vs C5 | wrong calculated results | closed by 08 R12a: one grammar (C3 text), one implementation (C0-0A), shared vectors |
| Device RLS visibility depends on centre binding ASSUMPTION | host query `not_found` | integration test with C7 early (M3); fallback: C7 calls via system context with explicit device centre check (would need C7/C0 agreement) |
| Delta thresholds are lab policy, no universal values (UNVERIFIED) | false alarms or misses | rules are data with no defaults seeded for real tenants; only synthetic tenants get example rules |
| High volume consumer backlog at peak | stale worklists | throughput target 2× peak; queue depth metric; consumer logic in one tx with bounded port calls (cached) |
| Future partitioning of `results` (04 D10) conflicts with FKs into it | migration effort | not in v1; C0 note in 05-SCHEMA; time columns present |
| Critical-value SOP undecided (B14) | blocking default may not match lab practice | tenant setting `critical_notification_blocks_approval` |
| Patient merges split history | delta/trend gaps | foreseen CR; UI shows "Previous results: this patient record only" hint |

08 Addendum A2/A3 applied 2026-11-06 (A2.10 label-print conflict = `409 common.version_conflict` with detail; no dedicated code).
Review fix pass 2026-11-06 — review/C5-lab-workflow.md + 08 Addendum A13 applied (ordinal codes now come from `AnalyteDefinition.ordinalSetValues` — D-9; UI kit names mapped per 08 R22, so the two former CR candidates are closed).
Final sweep 2026-11-06 — second touch applied (T-09 D-120; T-12/T-16 08 A17.1; T-23 CR-C7-014; T-24 D-61 cases 35–36 + A17.2; §5 D-106 / D-61 integration points).
