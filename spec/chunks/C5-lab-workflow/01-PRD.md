# C5 Lab Workflow — 01 Product Requirements (PRD)

Status: DECISION, 2026-11-05. Chunk C5, Phase 1 (04 §12). Module `lab` (schema, API module, worker jobs, web feature).
Precedence: `research/00` > `research/04` > `program/03-INTERFACE-CATALOG.md` (03-IC) > `program/01`/`02` > this file. Where this file needed something those documents do not provide, it says DECISION, [CONV], ASSUMPTION, UNVERIFIED or BLOCKED, and any contract gap is raised as a CR in `02-TRD.md` §15.

Labels: **DECISION** = engineering choice made here (change by CR). **[CONV]** = value chosen here with no external fact behind it. **ASSUMPTION** = planning assumption to validate. **UNVERIFIED** / **BLOCKED (B#)** as in 04.

---

## 1. Purpose

C5 is the laboratory floor of the LIMS. It takes an order that front desk registered (C4), turns it into physical specimens with barcodes, follows every specimen from collection to disposal, gathers a value for every analyte (from analysers via C7, by manual entry, by formula, or from the micro/anatomic modules via `LabPort.submitModuleResult`), checks each value (reference range, delta, critical), and moves each result through technologist verification and pathologist approval. After approval a result is locked; changes happen only as amendments (new versions). C5 tells C6 when an order (or a releasable part of it) is ready for its report, and records the TAT timestamps that C8/C9 report on.

C5 is the owner of two state machines that the whole system depends on (03-IC §10.1 specimen, §10.2 result) and of the `LabPort` (03-IC §4.5).

## 2. Users and roles

Role codes and permission codes are from 03-IC §11 (`contracts/permissions.yaml`). Codes marked **(CR)** are requested in `02-TRD.md` CR-C5-004 and are designed as if accepted.

| Role (default) | What they do in C5 | Permissions used |
|---|---|---|
| `front_desk` | Print labels right after registration; mark walk-in specimens collected (collect screen looks specimens up); see the patient status board | `lab.specimen.label_print`, `lab.specimen.collect`, `lab.specimen.read` (08 A13 D-4; RLS keeps centre scope), `lab.status_board.read` |
| `centre_staff` | Collect at a collection centre, print labels, dispatch specimens to the processing lab, see status | `lab.specimen.collect`, `lab.specimen.label_print`, `lab.specimen.read`, `lab.status_board.read` |
| `phlebotomist` | Collects (home collection arrives by event from C17; web collect action allowed) | `lab.specimen.collect`, `lab.specimen.read` (08 A13 D-4) |
| `lab_technologist` | Receive (scan), accept/reject, recollection, aliquots, worklists, worksheets, manual entry, short codes, history/trend, first verification, critical-value notification log, QC raw capture, resolve instrument exceptions | `lab.specimen.read`, `lab.specimen.receive`, `lab.specimen.reject`, `lab.specimen.label_print`, `lab.worklist.read`, `lab.worksheet.manage` (CR), `lab.result.read`, `lab.result.enter`, `lab.result.verify`, `lab.critical_value.read`, `lab.critical_value.log_notification`, `lab.qc.capture` |
| `pathologist` | Approve (privileged), return for correction, amend (privileged), critical-value sign-off, configure delta rules | `lab.result.read`, `lab.result.verify`, `lab.result.approve`, `lab.result.amend`, `lab.critical_value.read`, `lab.critical_value.log_notification`, `lab.worklist.read`, `lab.config.manage` (CR), `lab.qc_hold.release` (CR) |
| `lab_manager` | Worklists overview, lab settings, delta-check rules, coded sets, QC hold release (Phase 2) | `lab.worklist.read`, `lab.result.read`, `lab.specimen.read`, `lab.status_board.read`, `lab.worksheet.manage` (CR), `lab.config.manage` (CR), `lab.qc_hold.release` (CR) |
| Device actor (C7 bridge, host query) | `LabPort.getPendingTestsForBarcode` under its centre | fixed device permissions (03-IC §11) — C5 checks nothing extra for port calls; the C7 handler has already asserted `instruments.ingest.host_query` |
| System actor (worker) | Event consumers | declared in the `lab` worker manifest (02-CV §2.3) |

## 3. Problems this chunk solves

1. Specimens get lost or mislabelled when barcodes are hand-written; the client wants a sticker printed automatically for each sample (00 B1).
2. Technicians must accept or reject a sample with a reason (clotted, haemolysed — 00 B2), and a rejected sample must lead to a new collection without reusing its barcode (01 §2.1).
3. Front desk and centres need to see each patient's status: collected, in lab, ready, printed (00 B3).
4. Results must arrive from machines without typing (00 C1), with previous results beside the entry (00 C2), short codes for comments (00 C3), automatic formulas (00 C4), and graphs for repeat patients (00 C7).
5. Two-step approval (technician, then pathologist — 00 C5); after approval only the pathologist can change a result (00 C6).
6. Critical values must be notified and the notification must be logged (ISO 15189 requires a critical-result notification protocol — 04 L21, VERIFIED).
7. Technicians need pending lists and printable worksheets (00 F4); TAT must be measurable (00 wishlist 15; 04 §12 "TAT timestamps + pending list").
8. QC results from analysers must be captured from day one even though the rule engine comes in Phase 2 (04 §12; 01 §1.7).

## 4. Scope

### 4.1 In scope (mapped to client baseline)

| # | Capability | Baseline item(s) | Notes |
|---|---|---|---|
| IS-01 | Specimen creation from orders (one specimen per specimen-type + container requirement), barcode allocation per tenant numbering pattern | 00 B1; 03-IC §9.3 | from `frontdesk.order.created.v1` / `items_changed.v1` |
| IS-02 | Barcode label printing (browser print, Code 128 via `@lims/ui` `BarcodeSymbol`, behind a renderer interface); the label page prints on open; order label-readiness operation for C4 (CR-C4-010; C4's `frontdesk.label_autoprint` decides whether C4 opens the page — 08 A13 D-4) | 00 B1, A12 (letterhead receipt is C4) | DECISION in 02-TRD §4.6 |
| IS-03 | Collection (manual and from `homecollection.collection.synced.v1`), dispatch (in transit), receive by scan | 00 B1–B3; 01 §2.1 | |
| IS-04 | Accept / reject with coded reason + free text; recollection request (new barcode) emitting `lab.specimen.rejected.v1` | 00 B2; 01 §2.1 | |
| IS-05 | Aliquots (child specimens, own barcode, tests re-assignable) | wishlist 2 (specialty segments need aliquots); 01 §2.1 | |
| IS-06 | Store / discard specimens | 01 §2.1 | |
| IS-07 | Worklists by department / analyser / priority, urgent star | 00 A10 (urgent mark for the lab), F4 | |
| IS-08 | Pending list (incl. not yet received) with age vs TAT target | 00 F1 ("reports pending"), F4 | |
| IS-09 | Worksheets (snapshot of worklist rows) and their print | 00 F4 | |
| IS-10 | Manual result entry grid (keyboard-first) for numeric, ordinal, coded, text results | 00 C1–C3 | |
| IS-11 | Formula evaluation from catalog formulas, recompute on input change, provenance | 00 C4; 01 §2.2 | |
| IS-12 | Short-code comment expansion (text stored with the result) | 00 C3 | needs CR-C5-001 |
| IS-13 | Previous results beside entry + trend graph | 00 C2, C7 | |
| IS-14 | Reference-range flags (range snapshot), delta checks (rules per analyte as data), critical-value detection | 01 §2.2; 04 R2 | |
| IS-15 | Critical-value log + notification log with read-back fields | 04 L21; 01 §2.2 | |
| IS-16 | Instrument result application (bulk path from `instruments.result.received.v1`; port replay path) with barcode + code-map matching and an exception queue screen | 00 C1; 03-IC X2 | |
| IS-17 | Technologist verification (single + bulk) and return-for-correction | 00 C5 | |
| IS-18 | Pathologist approval (single + bulk), lock, amendments as versions with reason | 00 C5, C6; 04 R1 | |
| IS-19 | Order readiness evaluation → `lab.order.ready_for_report.v1` (complete / partial) | 00 D1/D8 support | |
| IS-20 | TAT timestamps (ordered, collected, in transit, received, first resulted, first verified, all approved, reported, rejected) | wishlist 15; 01 §2.7 | |
| IS-21 | Patient status board: collected / in lab / ready / printed (via `reporting.report.released.v1`, A8) | 00 B3 | |
| IS-22 | QC raw data capture (instrument + manual), no rules | wishlist 16 (Phase-1 part); 04 §12 | |
| IS-23 | QC hold handling (`quality.qc_run.rejected.v1`, `LabPort.holdResultsSince`) — wired and tested now, exercised in Phase 2 | wishlist 16 | |
| IS-24 | `LabPort` implementation: `getOrderResults`, `getPendingTestsForBarcode`, `ingestInstrumentResult`, `holdResultsSince`, `submitModuleResult` (A1, with `amendment` — 08 R1), `getOrderItemProcessingState`, `listPendingForInstrument`, `lookupSpecimens`, `getAnalyteHistory` (08 §4.14) | 03-IC §4.5; 08 R11 | |
| IS-25 | Auto-verification **hook** (`QualityPort.canAutoVerify`) behind a flag; Phase-1 behaviour = always manual | 04 R2 | |
| IS-26 | Published views for C8/C9/C12/C13/C16 (03-IC §6.3) | 00 F1, F4 | |
| IS-27 | Lab configuration: delta-check rules, lab settings, lab coded sets (rejection, return, amendment, exception-discard reasons) | 01 §2.1/§2.2 | |
| IS-28 | User-manual pages + in-app help for every C5 screen | 01 §2 training note; wishlist 9 | |

### 4.2 Out of scope (with owner)

| Item | Owner / reason |
|---|---|
| Registration page, orders, invoices, patient demographics, recollection patient contact | C4 (C4 consumes `lab.specimen.rejected.v1`) |
| Catalog: tests, analytes, formulas (storage + validation), reference ranges, critical limits, comment-code library, TAT targets, instrument code maps | C3 |
| Report rendering, release, hold-till-paid, delivery, critical-value **message dispatch** to clinicians | C6 (consumes `lab.critical_value.detected.v1`) |
| Bridge agent, ingest API, message archive, code-mapping UI, re-match UI | C7 |
| Westgard engine, LJ charts, QC acceptance, auto-verification rules, TAT alerts | C9 (Phase 2) |
| Microbiology and anatomic/molecular detailed workflows | C10 / C11 (they hand results in via A1) |
| Narrative report authoring (radiology/USG/endoscopy) | C6 narrative engine; C5 creates **no** specimen/result for `workflow_type = narrative` tests (DECISION; see §10 Q1) |
| TAT reports, dashboards, rejection-rate MIS | C8 (reads C5's `v_pub_*`) |
| ZPL / direct thermal printing through the bridge agent | not in Phase 1; behind `LabelRenderer` interface (02-TRD §4.6); needs a C7 CR when wanted |
| Manual upload of attachment results (images/PDFs) by staff | not in Phase 1 (upload/scan pipeline REQ-SEC-083/084 lives in C4/C6); attachment results arrive via C7 `record_kind = attachment` only. CR candidate (06 §6) |
| Patient merge handling | C4; foreseen CR (06 §6) |

## 5. User stories and acceptance criteria

Each AC is a test (05-DoD §2). IDs are stable; tests reference them as `AC-<story>.<n>`.

### US-01 Specimens are created from an order
As the lab, I want each new order to produce the specimens it needs, each with a unique barcode, so labels can be printed immediately.
- **AC-01.1** Given `frontdesk.order.created.v1` with items whose tests resolve (via `CatalogPort.resolveOrderables`) to two specimen requirements (EDTA_WB, SERUM), When the consumer runs, Then exactly two `lab.specimens` rows exist in status `ordered`, each with a barcode rendered from `TenantSettings.numbering.barcodePattern`, and two `lab.specimen.status_changed.v1` events with `from_status` absent and `to_status = ordered`.
- **AC-01.2** Given the same event is delivered twice (same `event_id`), When the consumer runs again, Then no new rows or events are created.
- **AC-01.3** Given a pattern `E{yy}{seq:8}` (08 A13 D-8; client shape `E1100001677`) and counter value 41 in 2026, When the next barcode is allocated, Then it is `E2600000042`, matches `^[A-Z0-9]{1,20}$`, and is unique within the tenant.
- **AC-01.4** Given a rendered pattern that would contain characters outside `[A-Z0-9]` or exceed 20 characters, When allocation runs, Then the consumer fails with `lab.barcode_pattern_invalid` (CR-C5-005), the event goes to retry/dead-letter, and no specimen is created.
- **AC-01.5** Given an order item whose test has `workflow_type = narrative`, When the consumer runs, Then no specimen and no result rows are created for that item, and the item is recorded as `excluded` in `lab.order_tests`.
- **AC-01.5b** Given an add-on test with `TestDefinition.usesExistingMaterial = true` (CR-C11-009), When the consumer runs, Then its `order_tests` row and `pending` results exist without a specimen (`specimen_id` NULL) and no specimen or barcode is created for it.
- **AC-01.6** Given every reportable analyte of each test, When the consumer runs, Then one `lab.results` row per reportable analyte (plus one per non-reportable formula-input analyte) exists in status `pending`, linked to the specimen whose requirement lists that test.
- **AC-01.7** Given `frontdesk.order.items_changed.v1` adding an urgent test with an existing `ordered` specimen of the same type and container, When processed, Then the test's results attach to that specimen (no new barcode); Given one removed item, Then its results become `cancelled` (R8).
- **AC-01.8** Given `frontdesk.order.cancelled.v1`, When processed, Then all `pending/resulted/verified` results of the order become `cancelled`, specimens that are not yet `received` get `is_active = false` and disappear from collection/receive lists, and no specimen status event is emitted for those (no state exists for it).

### US-02 Labels print automatically
As front-desk or centre staff, I want the barcode stickers to print as soon as registration finishes.
- **AC-02.1** Given an order whose specimens exist, When the label page `/lab/orders/{order_id}/labels` opens (route CR-C5-007; C4 opens it after `requestOrderLabelPrint` returns `200` when `frontdesk.label_autoprint` is on — 08 A13 D-4), Then it calls `printSpecimenLabels` once, renders one label per active specimen (copies = `label_copies_default` from that response) and opens the browser print dialog once without further clicks. The page calls neither `getLabOrder` nor `getLabSettings`.
- **AC-02.2** Given the specimens are not yet created (consumer still running), When the page opens, Then it shows "Preparing labels…" and polls `requestOrderLabelPrint` (readiness only: `409 common.version_conflict` until ready; no counter, no access log) every 1 s [CONV] for up to `LIMS_LAB_LABEL_WAIT_SECONDS` (default 15) [CONV]; on timeout it shows "Labels are not ready yet. Try again in a moment." with a Retry button.
- **AC-02.3** Given a label print, When `printSpecimenLabels` is called, Then each specimen's `label_print_count` increments, `last_label_printed_at` is set, and one `access_log` row with action `specimen_label.print` is written per specimen (04 D11; 08 A13 D-11). `requestOrderLabelPrint` changes neither (08 A13 D-4).
- **AC-02.4** Each label contains: Code 128 barcode of the barcode value, the human-readable barcode, patient name truncated to 24 characters [CONV], age/sex, registration number, specimen type code, container code, collection date if collected, up to 4 test codes [CONV] then "+n", and `★ URGENT` when any test on the specimen is urgent.
- **AC-02.5** Given an inactive specimen (cancelled order), When labels are requested for it, Then the API returns per-id `lab.specimen_inactive` (CR-C5-005) and the label is not rendered.

### US-03 Collect and dispatch
- **AC-03.1** Given an `ordered` specimen, When a user with `lab.specimen.collect` collects it, Then status becomes `collected`, `collected_at` = server time, `collected_by_membership_id` = actor, and `status_changed` (ordered → collected) is emitted.
- **AC-03.2** Given `homecollection.collection.synced.v1` with a collection for an `ordered` specimen, When processed, Then the specimen goes `ordered → collected → in_transit` in one transaction with two status events, `collected_at` = `collected_at_device` clamped to ≤ `synced_at`, `collected_via_visit_id` = `visit_id`; Given `barcode_verified = false`, Then `collection_barcode_unverified = true` and the receive screen shows a warning.
- **AC-03.2a** Given the same event carrying the optional `booking_id` (visit of kind `booking`, 08 A19 D-120), Then it is processed exactly as without it (field ignored by C5; consumer contract test with and without the field).
- **AC-03.3** Given `collected` specimens scanned on the dispatch screen, When dispatched, Then each becomes `in_transit` with `in_transit_at`.
- **AC-03.4** Given a `received` specimen, When collect is attempted, Then `409 lab.specimen_invalid_transition`.

### US-04 Receive and accept by scan
- **AC-04.1** Given a `collected` or `in_transit` specimen, When a technologist scans its barcode on the receive screen and accepts, Then status `received`, `received_at`, `processing_centre_id` (selected receiving location, must be in the actor's centre scope) and `processing_branch_id` (branch of that centre) are stored and `status_changed` is emitted.
- **AC-04.2** Given an unknown barcode, When scanned, Then the screen shows "No specimen with this barcode in your lab." and nothing changes (API `404 common.not_found` from lookup).
- **AC-04.3** Given a rejected or discarded specimen's barcode, When scanned for receive, Then `409 lab.specimen_not_receivable`.
- **AC-04.4** Given "auto-accept on scan" is on, When five barcodes are scanned in a row, Then five receives are submitted in scan order and each row shows its own outcome.
- **AC-04.5** Given a specimen received, When open ingest exceptions with reason `specimen_not_received` exist for its barcode, Then they are re-applied automatically (task `lab.reapply_exceptions_for_specimen`).

### US-05 Reject and request recollection
- **AC-05.1** Given a specimen in any state from `ordered` to `verified`, When rejected with `reason_code = haemolysed` and `recollection_required = true`, Then in one transaction: specimen → `rejected` → `recollection_ordered`; a new specimen (new barcode, `replaces_specimen_id` = old) is created in `ordered`; the old specimen's non-approved results become `cancelled` (`cancel_reason = 'specimen_rejected'`); the order tests are re-pointed to the new specimen and **new** `pending` result rows are inserted for them (the old rows stay `cancelled`; partial unique index `results__tenant_id_test_analyte__p_uq` — 08 A13 D-12); the new specimen copies the old one's `processing_centre_id`/`processing_branch_id` (D-13); events: `status_changed` (→rejected), `lab.specimen.rejected.v1` (recollection_required true), `status_changed` (→recollection_ordered), `status_changed` (new: absent → ordered).
- **AC-05.2** Given no `reason_code`, When rejecting, Then `422 lab.rejection_reason_required`.
- **AC-05.3** Given a `reason_code` not in the tenant's active rejection reasons, Then `400 common.validation_failed` with `errors[0].path = /reason_code` (08 A13 P-1).
- **AC-05.4** Given an `approved` specimen, When rejecting, Then `409 lab.specimen_invalid_transition`.
- **AC-05.5** Given a rejection with `recollection_required = false`, When later a user calls recollect on it, Then the recollection transition and new specimen are created as in AC-05.1 (the order tests cancelled with `specimen_rejected` are re-pointed and re-opened), `status_changed` (→ `recollection_ordered`) is emitted — C4 consumes it to raise its recollection flag (08 A13 D-6) — and no second `lab.specimen.rejected.v1` is emitted (idempotency key `<specimen_id>:rejected`).
- **AC-05.6** The free-text rejection comment is never in any event payload (03-IC §3.8).
- **AC-05.7** The old barcode never resolves to the new specimen: lookup of the old barcode returns the rejected specimen.
- **AC-05.8** Given a specimen rejected with `recollection_required = false`, Then its order tests become `cancelled` (`cancel_reason = 'specimen_rejected'`), their pending results `cancelled` (R8), readiness ignores them, and `LabPort.getOrderItemProcessingState` returns `removable: true` and `processingStatus: 'cancelled'` for an item whose only specimen it was (08 A13 D-5).
- **AC-05.9** Given a specimen in `recollection_ordered` (the rejected tube), When discarded with a reason, Then it becomes `discarded` (S14 — 08 A13 D-15).
- **AC-05.10** (08 A17.2) Given an existing-material item (no specimen) whose result is `resulted`, Then `getOrderItemProcessingState` returns `removable: false`, `reasonCode: 'result_entered'` and `processingStatus: 'in_progress'` (not `not_started`); given an item with a received specimen, Then `reasonCode: 'specimen_received'`; given no received specimen and only `pending` results, Then `removable: true`, `processingStatus: 'not_started'`.

### US-06 Aliquots
- **AC-06.1** Given a `received` specimen, When 2 aliquots are created with test assignments, Then 2 child specimens exist (`parent_specimen_id` set, own barcodes, status `received`), the parent goes `received → aliquoted`, assigned tests' results move to the aliquots, and events: parent status_changed + one (absent → received) per aliquot.
- **AC-06.2** Given an aliquot request assigning a test not on the parent, Then `400 common.validation_failed` (08 A13 P-1).
- **AC-06.3** Given a parent whose results all moved to aliquots, Then the parent's status stays `aliquoted` (no roll-up) until stored/discarded.

### US-07 Worklists, urgent star, pending list, worksheets
- **AC-07.1** Given received specimens for two departments, When a technologist opens the worklist filtered by department D, Then only D's pending/resulted tests appear, urgent rows first (then by `received_at` ascending), each urgent row shows `★` and the text "Urgent".
- **AC-07.2** Given filter `instrument_id = I`, Then only tests with at least one analyte that has an outbound code map for I (`CatalogPort.mapInstrumentCode` outbound) appear.
- **AC-07.3** Given the pending list, Then it includes tests not yet received (status `awaiting_collection` / `awaiting_receipt`) and shows `age` and `TAT target` when a target exists; it never shows a TAT number without naming its start point (06-GLOSSARY TAT rule): column header "Age since received" or "Age since registered".
- **AC-07.4** Given 30 selected worklist rows, When "Create worksheet" is used, Then a worksheet snapshot with those 30 rows is stored and its print view lists them with barcode, registration no, test code, priority, and blank result columns; later status changes do not change the worksheet rows.
- **AC-07.5** A user without `lab.worklist.read` gets `403 auth.forbidden` for worklist endpoints.

### US-08 Manual result entry (keyboard-first)
- **AC-08.1** Given an order's result grid, When the technologist types `13.4` in Hb and presses Enter, Then focus moves to the next result row without the mouse, and Ctrl+S saves all edited rows in one `bulkEnterResults` call.
- **AC-08.2** Given a saved numeric value, Then the result is `resulted`, has `origin = manual`, a reference-range snapshot (id + version + low/high/text), a flag (`N/L/H/LL/HH`), and the specimen rolls up per §10.1 (S6/S7).
- **AC-08.3** Given a value with more decimals than the analyte's `decimals`, Then `422 lab.result_value_invalid` for that row (per-row outcome); other rows in the batch still save.
- **AC-08.4** Given a row whose `If-Match` version is stale, Then that row returns `common.version_conflict` and the grid shows "Changed by someone else — reload this row".
- **AC-08.5** Given an `approved` result, When entry is attempted, Then `409 lab.result_locked`.
- **AC-08.6** Given an ordinal analyte, Then only codes in `AnalyteDefinition.ordinalSetValues` are accepted (select list in `sortOrder`, display text shown); any other code or free text is rejected with `lab.result_value_invalid`; a code outside the range match's `normalCodes` is flagged `A` (08 A13 D-9).
- **AC-08.7** Given a result on QC hold, When verified, Then `409 lab.result_on_hold`.
- **AC-08.8** (08 A17.1, clinical safety) Given a patient with no date of birth and no age (`patient_age_days` NULL), When a value is saved, Then C5 calls `referenceRangeFor` / `criticalLimitsFor` without `ageDays`; given age-unrestricted range and critical bands exist, Then flag and critical check run normally; given either is missing, Then the result has `range_unavailable_age_unknown = true`, is never auto-verified (no `QualityPort.canAutoVerify` call), and the grid and verification screen show "Age unknown — reference range and critical check not applied".

### US-09 Formulas
- **AC-09.1** Given LDL with formula `if(TG >= 400, invalid("tg_over_400"), TC - HDL - TG / 5)` and inputs TC 200, HDL 50, TG 150 (mg/dL), When the last input is saved, Then LDL = 120 with analyte decimals applied (half-up), `origin = calculated`, and provenance lists the expression, the catalog revision, and each input's result id, version and value.
- **AC-09.2** Given TG = 450, Then LDL stays `pending`, `calc_status = not_computable`, reason `tg_over_400` shown as "Not calculated: tg_over_400".
- **AC-09.3** Given a missing input, Then no value is computed (missing is never 0) and the grid shows "Waiting for: HDL".
- **AC-09.4** Given an input value changes before verification, Then the calculated result is recomputed in the same transaction (R3); given the calculated result was `verified`, Then it returns to `resulted` (R5, system, reason `input_changed`).
- **AC-09.5** Given an input result is amended after approval, Then the calculated result gets a new approved version in the same transaction with the same amendment reason and `lab.result.amended.v1` is emitted for both.
- **AC-09.6** Given an input whose stored unit differs from the input analyte's catalog unit, Then `calc_status = not_computable`, reason `unit_mismatch`.
- **AC-09.7** A user cannot type a value into a calculated result (API `422 lab.result_value_invalid`).

### US-10 Short codes
- **AC-10.1** Given comment field text `:HYPO ` (colon, code, space), When typed, Then the UI replaces it with the library text for `HYPO` (resolved by `CatalogPort.resolveCommentCodes`, CR-C5-001).
- **AC-10.2** Given a save with `comment_codes: ["HYPO"]`, Then the server re-resolves the code and stores code, library version and expanded text on the result; later library edits do not change stored text (06-GLOSSARY short code).
- **AC-10.3** Given an unknown code, Then `400 common.validation_failed` path `/entries/n/comment_codes/k` (08 A13 P-1).

### US-11 Previous results and trend
- **AC-11.1** Given the patient has 3 earlier approved Hb results, When the grid row for Hb is focused, Then the side panel shows the last 5 [CONV] approved values with date, value, unit and flag, newest first.
- **AC-11.2** Given F3 on a numeric row, Then a trend chart of up to 50 [CONV] approved values over time is shown, with the current reference range as a band, and points with a different unit are listed separately and not plotted on the same axis.
- **AC-11.3** History never includes results of another tenant or another patient id.

### US-12 Delta checks
- **AC-12.1** Given rule for K+ (window 7 days, abs threshold 1.0, pct threshold empty) and a previous approved K+ 4.0 three days earlier, When the new value 5.2 is saved, Then `delta_status = fail`, `delta_abs = 1.2`, and the grid shows "Δ +1.2 vs 4.0 (3 d ago)" with text, not colour only.
- **AC-12.2** Given no previous value in the window, Then `delta_status = no_previous`.
- **AC-12.3** Given a delta failure, When verifying without `acknowledged_flags: ["delta"]`, Then `409 lab.flag_ack_required` (CR-C5-005); with it, verification succeeds and the acknowledgement is stored on the verification record.
- **AC-12.4** Rules are data: creating a new rule version takes effect for results saved after `effective_from`; each result stores the rule id + version used.

### US-13 Critical values and notification log
- **AC-13.1** Given critical limits high 6.5 for K+, When 7.0 is saved (any origin), Then a `lab.critical_value_log` row and `lab.critical_value.detected.v1` (direction `high`, no value in payload) are produced in the same transaction, and the result flag is `HH`.
- **AC-13.2** Given the same value re-saved, Then no second event (idempotency key includes the value hash); given a different critical value, Then a new log row and event.
- **AC-13.3** Given a critical result corrected to a non-critical value before verification, Then the log row is kept, marked `value_changed_after_detection = true`, and no retraction event is sent.
- **AC-13.4** Given a technologist records a notification (notified party kind, party name, contact method, notified at, read-back confirmed, read-back text), Then a `lab.critical_notifications` row is appended with `notified_by_membership_id` = actor; rows are never updated or deleted.
- **AC-13.5** Given lab setting `critical_notification_blocks_approval = true` (default) and an open critical event without a notification marked `outcome = reached` and `read_back_confirmed = true`, When approving, Then `409 lab.critical_ack_required`.
- **AC-13.6** `lab.v_pub_critical_value_daily` reports detected, notified, median and max notify seconds (detected_at → first reached+confirmed notification).

### US-14 Instrument results and exception queue
- **AC-14.1** Given `instruments.result.received.v1` (mapped, barcode of a received specimen, pending HGB result), When consumed, Then the result is `resulted`, `origin = instrument`, `instrument_id` set, raw value/flags stored in `lab.result_observations`, and outcome `applied` logged under the 04 N10 result-level key.
- **AC-14.2** Given the same result-level key again, Then outcome `duplicate` and nothing else changes.
- **AC-14.3** Given `mapping_status = unmapped` and `CatalogPort.mapInstrumentCode` still throws `catalog.instrument_code_unmapped`, Then an open exception `unmapped_code` exists and is visible on `/lab/ingest-exceptions`.
- **AC-14.4** Given an unknown barcode → exception `unknown_barcode`; rejected specimen → outcome `rejected_state`, exception `specimen_rejected`; approved target result → outcome `rejected_state`, exception `result_locked`, value unchanged; verified target → exception `result_already_verified`; specimen `ordered` → exception `specimen_not_received` (always; S4 from `ordered` is forbidden); specimen `collected`/`in_transit` and `ingest_auto_receive = false` → exception `specimen_not_received`; analyte not ordered on the specimen → exception `analyte_not_ordered`.
- **AC-14.5** Given an open exception, When a technologist assigns it to a specimen/result (or re-applies after the mapping is fixed), Then the normal apply pipeline runs and the exception becomes `resolved` with resolver and time; When discarded with a reason, Then `discarded`.
- **AC-14.6** Given `LabPort.ingestInstrumentResult` is called by C7's re-match UI for an input that matches an open exception's key, When it applies, Then that exception is resolved in the same transaction.
- **AC-14.7** Given an active QC hold for (instrument, analyte), When a result arrives, Then it is applied with `on_hold = true` and outcome `held`.
- **AC-14.8** No auto-verification in Phase 1: ingested results always stop at `resulted`.

### US-15 Verification (technologist)
- **AC-15.1** Given a `resulted` result not on hold, When a user with `lab.result.verify` verifies, Then status `verified`, a `lab.verifications` row (mode `manual`), and `lab.result.verified.v1` with `mode = manual`.
- **AC-15.2** Bulk verify of 50 ids returns per-id outcomes; ids from another tenant/centre return `common.not_found` per id.
- **AC-15.3** Given a `pending` result, When verifying, Then `409 lab.result_invalid_transition`.
- **AC-15.4** Given a `verified` result, When returned with reason code, Then status `resulted`, a verification record of kind `returned`, and the specimen roll-up drops (S15).
- **AC-15.5** Given `LIMS_LAB_AUTOVERIFY_HOOK_ENABLED = false` (Phase-1 default), Then `QualityPort.canAutoVerify` is not called; Given it is `true` and the fake returns `deny/feature_disabled`, Then the result stays `resulted`.

### US-16 Approval (pathologist) and lock
- **AC-16.1** Given a `verified` result, When a user with `lab.result.approve` at `aal2` approves, Then status `approved`, a `lab.approvals` row, an immutable `lab.result_versions` row v1, and `lab.result.approved.v1` (result_version_no 1).
- **AC-16.2** Given the approver is the same membership that verified it, Then `403 lab.self_approval_forbidden` (rule confirmed: always enforced, not configurable — DECISION based on 00 C5 two-step approval).
- **AC-16.3** Given a session at `aal1`, Then `403 auth.mfa_required` (privileged permission, 04 A4).
- **AC-16.4** Given an approved result, When any value column is updated through SQL as `lims_api`, Then the DB raises `immutable_row` (`409 common.immutable_record` at the API).
- **AC-16.5** Given all reportable results of an order's non-excluded items are approved, Then `lab.order.ready_for_report.v1` with `completeness = complete` and the specified `approved_set_hash` is emitted once; a second approval transaction that does not change the set emits nothing.
- **AC-16.6** Given `partialReleaseAllowed = true` and one department fully approved, Then an event with `completeness = partial` and that department's item ids is emitted.

### US-17 Amendments
- **AC-17.1** Given an approved result, When a pathologist amends with value and `amendment_reason_code`, Then a `lab.result_versions` row v2 (approved at creation), the previous version marked superseded, `lab.result.amended.v1` (previous 1, new 2) and a new `lab.order.ready_for_report.v1` with `contains_amendment = true`.
- **AC-17.2** Given a user without `lab.result.amend` (e.g. technologist), Then `403 lab.amend_requires_pathologist`.
- **AC-17.3** Given no reason, Then `422 lab.amendment_reason_required`.
- **AC-17.4** `LabPort.getOrderResults(scope: approved)` returns version 2 and the hash changes.
- **AC-17.5** Given `LabPort.submitModuleResult` on an `approved` result, Then `amendment.reasonCode` is required (`lab.amendment_reason_required` otherwise); `module_phase_progression` is accepted only for a micro final replacing an approved preliminary, `module_preliminary_update` only for a micro preliminary replacing an approved preliminary (08 A17 D-61; contract cases 35–36), and `supplementary_report` only from `anatomic`, else `lab.module_result_invalid`; the reason appears in `lab.result.amended.v1` (08 R1). `amendResult` refuses all three codes (`400 common.validation_failed`, 08 A13 P-1).
- **AC-17.6** Given `LabPort.submitModuleResult` on a `verified` result, Then in one transaction the result is returned (system R5, reason `module_resubmitted`) and re-resulted (R3), its verification is cleared, no `result_versions` row is created, and the output `versionNo` equals `results.current_version_no` (1 before first approval; n+1 after an amendment) (08 A13 D-7).

### US-18 Status board
- **AC-18.1** Given an order with specimens collected but none received, Then board status "Collected"; with ≥1 received and not all approved: "In lab"; all lab items approved and no release seen: "Ready"; after `reporting.report.released.v1` for the order: "Printed" with release time; any rejected specimen without recollection shows the badge "Sample rejected".
- **AC-18.2** Given a released event delivered twice, Then the board and specimens change once.
- **AC-18.3** Given a release event with `report_kind` `final`, `amended`, `addendum` or an unknown value (treated as `amended`, 02-CV §7.2), Then every `approved` specimen of the payload's `order_item_ids` (all items of the order when the field is absent) goes `approved → reported` (S10) with `reported_at`; given `partial`, Then specimens change only for the listed `order_item_ids` (CR-C5-006), and without that field none changes (board "Printed (partial)"); given `preliminary`, Then the release is recorded, no specimen changes, and the board shows "Printed (preliminary)". `report_kind` is stored as received (no closed list — 08 A13 P-4).
- **AC-18.4** A centre-scoped user sees only orders of their centres.

### US-19 QC raw data capture and holds
- **AC-19.1** Given `instruments.qc.received.v1`, Then one `lab.qc_results` row (source `instrument`) exists and is exposed in `lab.v_pub_qc_result`; duplicates (same idempotency key) do nothing.
- **AC-19.2** Given a technologist enters a QC value manually (instrument, analyte, control id/lot/level, value, time), Then a row with source `manual` is stored.
- **AC-19.3** No UI text implies QC acceptance, rejection or enforcement in Phase 1 (06-GLOSSARY "QC data capture"); the screen header reads "QC results (captured — rules arrive with the QC module)".
- **AC-19.4** Given `quality.qc_run.rejected.v1` (or `holdResultsSince`) twice with the same `qc_run_id`, Then non-approved matching results are `on_hold` once and approved ones `qc_review_required` once; identical id lists are returned.

### US-20 LabPort contract
- **AC-20.1** The real `LabPort` implementation passes every case of `packages/fakes/contract-tests/LabPort.contract.ts` (03-IC §4.5 cases 1–20 + 08 §4.14 cases 21–30 + 08 A13 cases 31–34: D-5, D-7 + 08 A17 D-61 cases 35–36 + C5-local A17.2 cases).
- **AC-20.2** `getPendingTestsForBarcode` p95 ≤ 300 ms in-process at reference load (02-TRD §10).
- **AC-20.3** `lab.v_pub_specimen_timeline` exposes, after its existing columns, `replaces_specimen_id` (set on a recollection specimen, NULL otherwise) and `specimen_version` (= `lab.specimens.version`, the `aggregate.seq` of the specimen's status events) (08 A19 D-106, CR-C16-022).

## 6. Success metrics

| Metric | Target | How measured |
|---|---|---|
| Instrument results applied without manual touch (mapped + matched) | ≥ 95% of `instruments.result.received.v1` per lab per week after go-live mapping is complete [CONV] | `lims_lab_results_ingested_total{outcome}` |
| Open ingest exceptions older than 24 h | 0 at end of each day [CONV] | exception queue age metric |
| Critical events with a confirmed notification | 100% before approval when the blocking setting is on | `lab.v_pub_critical_value_daily` |
| Result entry keyboard completeness | every grid action has a shortcut (04-UI-UX §3.6 checklist) | UI test |
| Specimens with a barcode within 5 s of order commit | p95 ≤ 5 s [CONV] | `lims_lab_specimen_creation_lag_seconds` |
| Cross-tenant/centre probe failures | 0 | CI probes |

## 7. Phase

Phase 1 (04 §12: "barcodes, accept/reject, specimen state machine; … results entry, formulas, short codes, previous results; two-step verification, lock, amended reports; delta checks + critical-value log; … TAT timestamps + pending list; QC data capture (no engine)"). Phase-2 hooks (auto-verification, QC hold release by C9) are wired but inactive.

## 8. Dependencies (contracts only)

| Dependency | Kind | Used for |
|---|---|---|
| `CatalogPort` (C3): `getTest` (incl. `ordinalSetValues`, 08 A13 D-9), `resolveOrderables`, `referenceRangeFor`, `criticalLimitsFor`, `mapInstrumentCode`, `getReferrer` (display name on the critical-value screen); **`resolveCommentCodes` (CR-C5-001)** | port | specimen requirements, analytes, formulas, ranges, critical limits, code maps, comment codes, referrer name |
| `FrontdeskPort` (C4): `getOrderSummary`, `getPatientDemographics` (+ purposes `result_evaluation`, `lab_display` and batch read — CR-C5-003, accepted) | port | registration no, sex/age for ranges, names for labels/screens |
| `IdentityPort` (C2): `assertRole`, `getActor`, `getTenantSettings` | port | authz, numbering pattern, partial release flag, autoVerificationEnabled, timezone |
| `QualityPort` (C9): `canAutoVerify` | port (fake in Phase 1) | auto-verification hook |
| Events consumed | events | `frontdesk.order.created.v1`, `frontdesk.order.items_changed.v1`, `frontdesk.order.cancelled.v1`, `instruments.result.received.v1`, `instruments.qc.received.v1`, `catalog.changed.v1`, `quality.qc_run.rejected.v1`, `homecollection.collection.synced.v1`, `reporting.report.released.v1` (A8) |
| `ctx.core` (C0) | core repo | centres → branch lookup, memberships display names |
| `@lims/shared-ts` formula + decimal (CR-C5-002) | shared lib | one formula grammar for C3 validation and C5 evaluation |
| `@lims/ui` components | UI kit | see 04-UI-UX §2 (all from the published kit, C0 04-UI-UX §2 / 08 R22; no missing component) |

## 9. Blocked items and defaults built meanwhile

| B# | What C5 cannot finalise | Default built now |
|---|---|---|
| B2 | Which fields each analyser sends (flags, units, result times, QC markers) | Pipeline accepts every optional field of `instruments.result.received.v1` as optional; matching needs only barcode + code; missing `instrument_result_time` uses key part `'none'` (04 N10) |
| B3 | Real test list, formulas, ranges, critical limits | Synthetic catalog from `packages/test-fixtures` via the CatalogPort fake |
| B14 | Named pathologist owning the critical-value SOP | Notification log fields + blocking setting; default blocking on; SOP text is tenant content outside the code |
| B15 | Legal retention | Clinical records never deleted in v1; retention years read from `TenantSettings.retentionYears` for any later archive job (none in Phase 1) |
| B1 | Phlebotomy app timing | `homecollection.collection.synced.v1` consumer is built and tested against synthetic events now |

## 10. Open questions (recorded, not blocking)

- **Q1** Narrative (`workflow_type = narrative`) and outsourced tests: 03-IC gives no result path into C5. DECISION: C5 creates no results for `narrative`; for `outsourced` items (item flag or workflow) C5 creates the specimen (it is still collected and sent) but no results; both are excluded from readiness. C6 owns their report content. Confirm with C6 at integration.
- **Q2** One specimen per (specimen type, container) requirement merges timed draws (e.g. GTT) into one tube; foreseen CR to C3 (06 §6).
- **Q3** Patient merges in C4 split history (delta/trend) across patient ids; foreseen CR (06 §6).

Final sweep 2026-11-06 — second touch applied (AC-03.2a D-120; AC-05.10 08 A17.2; AC-08.8 08 A17.1; AC-17.5 D-61; AC-20.1 cases 35–36; AC-20.3 D-106).
