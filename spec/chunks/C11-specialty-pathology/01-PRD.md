# C11 Specialty Pathology — 01 PRD (module `anatomic`)

Status: DECISION, 2026-11-06. Chunk C11, **Phase 2** (04 §12: "molecular; histopathology/cytology/IHC"). Module `anatomic` = Postgres schema `anatomic` = API module `services/api/src/modules/anatomic` = OpenAPI `contracts/openapi/anatomic.yaml` = staff web feature `apps/web/src/{app/(staff),features}/anatomic` (01-CM §2, §3).

Names of events, ports, views, permissions, error codes and routes are used verbatim from `program/03-INTERFACE-CATALOG.md` (03-IC). Anything 03-IC lacks is raised in `02-TRD.md` §16 "Change requests raised" and marked **(CR-C11-nnn)** wherever it is used. All examples are synthetic.

---

## 1. Purpose

C11 gives the lab a real anatomic-pathology and molecular workspace instead of "a big text box" (01 research §2.4):

1. **Histopathology:** a case with its own accession number (separate series from the lab registration number — 01 research §2.4; 03-IC §9.3), specimen parts, gross description (with images), cassettes/blocks, slides, stains (H&E by default; special stains and IHC as added orders on existing blocks), microscopy, diagnosis (narrative plus optional synoptic template), sign-out, revisions, amendments and addenda.
2. **Cytology** (Pap, FNAC, fluids): the same case model; specimen → smears and/or cell block; slide-level assessment that can appear in the report (01 research §2.4).
3. **IHC / special stains:** ordered on a block (IHC **must** be on a block — 03-IC §8 `anatomic.ihc_requires_block`), creating new slides and an addendum report section (01 research §2.4; glossary "IHC").
4. **Molecular** (wishlist item 2, 00 §3): generic structured result fields (assay, target, coded result, optional quantitative value + unit, method, kit name/lot/expiry, run/batch) plus a narrative interpretation. No assay-specific clinical rules are built in.
5. **Block and slide registry with location history**, so the lab can answer "where is block A3 of S26-1234" (01 research §2.4).
6. **Hand-off into the common result chain:** every signed report version is handed to C5 through `LabPort.submitModuleResult` (03-IC §4.5, A1), so technologist verification → pathologist approval → `lab.order.ready_for_report.v1` → C6 release work as for every other department. C6 renders the anatomic section from the published view `anatomic.v_pub_report_content` (03-IC §6.8).

## 2. Users and roles

Role codes are the default tenant roles of 03-IC §11. Permission codes marked (CR) are added by CR-C11-002.

| Role (default) | What they do in C11 | Permissions |
|---|---|---|
| `lab_technologist` (histotechnologist, cytotechnologist, molecular technologist) | accession cases, record parts and gross, create blocks/slides, record stains and movements, upload images, enter molecular results, manage batches, prepare report drafts | `anatomic.case.read`, `anatomic.case.work` (CR) |
| `pathologist` | everything a technologist does, plus write microscopy/diagnosis, synoptic fields, sign out, revise, amend, sign addenda, manage templates | `anatomic.case.read`, `anatomic.case.work` (CR), `anatomic.case.signout` (privileged, aal2), `anatomic.config.manage` (CR, privileged) |
| `lab_manager` | configure stains, assays, test profiles, coded lists, settings; read cases for tracking | `anatomic.case.read` (CR adds `lab_manager` to its default roles), `anatomic.config.manage` (CR, privileged) |
| C5 verifier / approver (technologist / pathologist) | verify and approve the module result in C5's screens after C11 sign-out | `lab.result.verify`, `lab.result.approve` (C5) — not C11 permissions |
| system actor `anatomic` (worker) | consume `lab.specimen.status_changed.v1`, `lab.result.approved.v1`, `lab.result.amended.v1`; re-scan uploaded images | `ModuleManifest.systemPermissions` (C0 02-TRD; declared in `services/api/src/modules/anatomic/index.ts`): `anatomic.case.work`, `frontdesk.order.read`, `catalog.test.read` (02-CV §2.3; 03-IC §11 `system`) |

Privileged permissions require membership re-validation and aal2 (TOTP) — 04 A4; REQ-SEC-067; 03-IC §11.

## 3. Problems solved

| # | Problem | Source |
|---|---|---|
| P1 | The client wants "Molecular, Histo, IHC" in the same software (wishlist item 2) | 00 §3 item 2 |
| P2 | Histo cases need their own number series and block/slide identities derived from it | 01 research §2.4; 03-IC §9.3 |
| P3 | Labs must locate blocks and slides (storage, retrieval, send-out for IHC or second opinion) | 01 research §2.4 |
| P4 | IHC/special stains are added later on existing blocks and reported as addenda without re-collection | 01 research §2.4; glossary "IHC", "Addendum" |
| P5 | Anatomic results must pass the same two-step approval and lock as all results (only a pathologist changes a result after approval) | 00 §2 C5, C6; 04 R1 |
| P6 | Reports need gross + microscopy + impression ± synoptic fields, with images | 01 research §2.4; 01-CM §2 C11 row |
| P7 | Diagnosis coding is wanted, but SNOMED CT licensing for Nepal is unverified | 01 research §2.4; 01 log #18 |

## 4. Scope

### 4.1 In scope

| ID | Capability | Client item | Notes |
|---|---|---|---|
| IS-01 | Case creation from `lab.specimen.status_changed.v1` (`to_status = received`) for order items whose test `workflowType ∈ {anatomic, molecular}` | 00 §3 item 2; A4 | one open case per (order, case kind) |
| IS-02 | Accession number per tenant + series + year, configurable pattern (default `{prefix}{yy}-{seq:4}`, example `S26-0042`) | 01 research §2.4; 03-IC §9.3 | manual accession by default; optional auto-accession on receipt |
| IS-03 | Specimen parts (A, B, C …), clinical history, site/description per part | 01 research §2.4 | |
| IS-04 | Gross record per part: text + pieces, three dimensions (mm), weight (g); gross images | 01 research §2.4; glossary "Gross" | |
| IS-05 | Blocks (cassettes) per part, label `{accession}-{part}{n}` (example `S26-0042-A1`, 01 research §2.4) | 01 research §2.4 | |
| IS-06 | Slides per block (or per part for cytology smears), each with a stain; status `pending_stain → ready` | 01 research §2.4 | |
| IS-07 | Stain master (routine / special / IHC); stain orders on blocks (IHC block-only), optionally linked to a billed add-on order item | 01 research §2.4 | billing of the add-on is done by front desk in C4 |
| IS-08 | Block and slide location history: stored, retrieved, sent out, returned, discarded; lookup by label | 01 research §2.4 | |
| IS-09 | Report draft: gross text, microscopy, impression/diagnosis, comment, ancillary (stain) results, cytology slide assessments, synoptic instances, selected images, optional local diagnosis codes, abnormal marker, critical-finding marker | 01 research §2.4 | plain text (no HTML) — DECISION, see 02-TRD §4.6 |
| IS-10 | Synoptic templates as data (sections, fields, value sets), versioned draft → published → retired, authored by each lab | 01-CM §2; glossary "Synoptic report" | **no CAP or other third-party protocol content is shipped** |
| IS-11 | Text templates (canned text per section) with short codes | 01 research §2.4 ("template library") | |
| IS-12 | Sign-out (privileged) → immutable report version → `LabPort.submitModuleResult` per case item | A1; 00 §2 C5 | |
| IS-13 | Revision before C5 approval; amendment after approval (pathologist only, reason required); addenda after sign-out | 00 §2 C6; 04 R1; 01 research §2.4 | amendment reason transport: CR-C11-004 → 08 R1 |
| IS-14 | Molecular: assays/targets master, coded result value sets per target, results with method + kit lot, batches (runs) with positions, narrative interpretation | 00 §3 item 2; glossary "Molecular", "Batch" | manual entry only in v1 |
| IS-15 | Images: upload (PNG/JPEG ≤15 MB), malware scan + re-encode via the C0 upload pipeline, private bucket with tenant-prefixed paths, no PHI in object names | 02-CV §10.2; 04 D15 pattern; REQ-SEC-083/084/085 | |
| IS-16 | Published view `anatomic.v_pub_report_content` (03-IC §6.8 columns + additive CR-C11-001 columns) | A1 | consumers C6, C14 |
| IS-17 | Worklists (to accession, grossing, bench, reporting, awaiting lab approval), labels page (block/slide labels), tracking screen | 00 §2 F4 (worksheets for technicians, by analogy) | |
| IS-18 | Configuration: settings, stains, assays, test profiles (test → case kind, series, defaults), coded lists (diagnoses, cytology adequacy, molecular result values, cancel reasons) | — | |
| IS-19 | In-app help and user-manual pages for every screen | 01-CM §2 wishlist item 9 note | |

### 4.2 Out of scope

| Item | Where it lives / why |
|---|---|
| Dedicated cytogenetics module | DROP (04 §12; 01-CM §2). Cytogenetics is a C6 narrative report (`workflowType = narrative`); C11 never creates a case for it |
| Radiology/USG/endoscopy narratives | C6 narrative engine |
| Specimen collection, receipt, rejection, recollection, barcodes | C5 (C11 only reacts to C5 events) |
| Verification and approval of the module result; release, PDF rendering, delivery | C5 (verify/approve), C6 (render/release/deliver) |
| Adding a billable add-on (IHC) item to an order | C4 registration/order edit; C11 only links an existing item |
| Molecular instrument interfacing | not in v1: C11 is not a consumer of `instruments.result.received.v1` (03-IC §3.25); manual entry only. Future CR |
| Preliminary anatomic reports (e.g. intra-operative frozen section) | 03-IC §4.5 says anatomic submissions are always `final` |
| Bundled clinical vocabularies (ICD-O, SNOMED CT, Bethesda category lists, CAP protocols) | licensing/copyright UNVERIFIED (01 research §2.4, log #18); labs author their own lists and templates |
| Automatic interpretation rules for molecular assays or IHC scoring | no verified source; lab policy; outside v1 |
| PACS/DICOM | DROP (04 §12: "PACS/DICOM (for now)") |
| Whole-slide imaging, digital microscopy viewers | out of scope in v1 (DECISION; not in the 01-CM §2 C11 row) |
| Cassette/slide printer drivers | browser print of label sheets only (as C5 §4.6) |
| Retention purge of anatomic records/images | retention defaults 04 I8 / B15; archival is a platform task, not C11 |

## 5. User stories and acceptance criteria

Numbering: US-nn / AC-nn.m. Every AC becomes at least one automated test (05-DoD §2).

### US-01 Case created when an anatomic specimen is received (IS-01)
As a histotechnologist, I want a case to appear in my "To accession" queue as soon as C5 receives the specimen, so that I never re-type the order.
1. **AC-01.1** Given an order with one order item whose test has `workflowType = anatomic` and test profile `case_kind = histology`, When `lab.specimen.status_changed.v1` with `to_status = received` for that specimen is consumed, Then one `anatomic.cases` row exists with status `received`, `case_kind = histology`, no `accession_no`, one part `A` linked to the specimen, and one `case_items` row for the order item.
2. **AC-01.2** Given the same event is delivered twice (same `event_id`), When the consumer runs the second time, Then no new rows are created and the job succeeds.
3. **AC-01.3** Given a second specimen of the same order and case kind is received while the case is not `signed_out`/`cancelled`, When its event is consumed, Then it is added to the existing case as part `B`.
4. **AC-01.4** Given an event for a specimen whose order items have only `standard` or `narrative` tests, When consumed, Then no C11 row is written except the inbox row and one `specimen_links` row with `link_kind = 'not_anatomic'` (no case, no part), and `lims_anatomic_consumer_ignored_total{reason="no_anatomic_items"}` increments.
5. **AC-01.5** Given an event with `aggregate.seq` lower than or equal to the last applied seq for that specimen, When consumed, Then it is ignored (stale).
6. **AC-01.6** Given an order item whose test has `workflowType = molecular`, When received, Then the case has `case_kind = molecular`.
7. **AC-01.7** Given an anatomic test with no test profile configured, When received, Then a case is created with `case_kind = histology` (for `anatomic`) or `molecular` (for `molecular`), and the case carries `profile_missing = true` shown as a warning banner.
8. **AC-01.8** Given tenant setting `auto_accession_on_receipt = true`, When the case is created, Then it is accessioned in the same transaction (status `accessioned`, number assigned).
9. **AC-01.9** Given `to_status = rejected` for a specimen already linked to a part, When consumed, Then the part gets `specimen_state = rejected` and the case shows "Specimen rejected in the lab — recollection may follow".
10. **AC-01.10** Given a recollected specimen (`replaces_specimen_id` = the rejected one) is received, When consumed, Then it is linked to the same part (part `specimen_id` updated, previous kept in `specimen_links` history) and `specimen_state` returns to `received`.

### US-02 Accession a case (IS-02, IS-03)
1. **AC-02.1** Given a `received` histology case, When I accession it with clinical history and part sites, Then it gets the next number of its series (e.g. `S26-0042` with pattern `{prefix}{yy}-{seq:4}`, prefix `S`, year 2026 in the tenant time zone), status `accessioned`, and the number never changes afterwards.
2. **AC-02.2** Given two technologists accession two cases concurrently, When both commit, Then the numbers are distinct and consecutive.
3. **AC-02.3** Given the counter would exceed the `{seq:N}` width, When I accession, Then `500 anatomic.accession_pattern_invalid` (CR) is returned and nothing changes.
4. **AC-02.4** Given the year changes (01 Jan, tenant time zone), When the first case of the new year is accessioned, Then the sequence restarts at 1 for that series.
5. **AC-02.5** Given an already accessioned case, When `accession` is called again, Then `409 anatomic.case_invalid_transition` (CR).
6. **AC-02.6** Given the rendered number already exists in the tenant (pattern without `{yy}` and a manually reset counter), When I accession, Then `409 anatomic.accession_duplicate`.
7. **AC-02.7** Given I lack `anatomic.case.work`, When I accession, Then `403 auth.forbidden`.

### US-03 Gross description (IS-04)
1. **AC-03.1** Given an accessioned case, When I save part A's gross with text, 3 pieces, dimensions 12 × 8 × 4 mm and weight 0.6 g, Then the record is stored with my membership and time; `If-Match` mismatch returns `409 common.version_conflict`.
2. **AC-03.2** Given a dimension with more than 1 decimal place or ≤ 0, When I save, Then `400 common.validation_failed` with the field path.
3. **AC-03.3** Given part A's gross is marked complete, When I edit it before sign-out, Then the edit is allowed and `completed_at` stays (audit trail keeps old/new via trigger — 04 D11).
4. **AC-03.4** Given the case is `signed_out` with no open revision/amendment draft, When I edit a gross record, a part's site/description, molecular results or a slide assessment, Then `409 anatomic.signout_locked` (08 A17 D-66 (b) without a draft).
5. **AC-03.5** Given the case is `signed_out` and a revision/amendment draft is open, When I edit a gross record or a part's site/description, Then the edit is saved; adding a new part still returns `409 anatomic.signout_locked` (08 A17 D-66 (b), (c)).

### US-04 Blocks and slides (IS-05, IS-06)
1. **AC-04.1** Given an accessioned case with part A, When I create 3 blocks for part A, Then labels `S26-0042-A1`, `-A2`, `-A3` exist; creating 2 more yields `-A4`, `-A5`.
2. **AC-04.2** Given a `received` (not accessioned) case, When I create blocks, Then `409 anatomic.case_invalid_transition`.
3. **AC-04.3** Given block A1, When I create 2 H&E slides, Then labels `S26-0042-A1-1` and `-A1-2` exist with stain `HE`, status `pending_stain`.
4. **AC-04.4** Given a cytology case part A without blocks, When I create 4 slides with stain `PAP` from the part, Then labels `C26-0007-A-1` … `-A-4` exist.
5. **AC-04.5** Given a block whose location status is `discarded` or `sent_out`, When I create slides from it, Then `409 anatomic.block_not_available` (CR).
6. **AC-04.6** Given slides in `pending_stain`, When I mark them ready (bulk, ≤200 ids), Then each returns a per-id outcome and slides of another tenant return per-id `common.not_found`.
7. **AC-04.7** Given the same `Idempotency-Key` is replayed for block creation, When the request body is identical, Then the stored response is replayed (`Idempotent-Replayed: true`) and no extra blocks exist.

### US-05 Special stains and IHC on blocks (IS-07)
1. **AC-05.1** Given block A2, When I order IHC stain `IHC_ER` (synthetic code) on it, Then a stain order `requested` exists linked to block A2.
2. **AC-05.2** Given an IHC stain order without `block_id`, When submitted, Then `422 anatomic.ihc_requires_block`.
3. **AC-05.3** Given a requested stain order, When I complete it with 1 slide and reagent lot `L-TEST-01`, Then slide `S26-0042-A2-3` exists with stain `IHC_ER`, status `ready`, and the order is `completed`.
4. **AC-05.4** Given the order has an add-on order item whose test profile has `is_addon = true` and is not yet linked, When I link it to the stain order, Then a `case_items` row with role `addon` exists for it.
5. **AC-05.5** Given a stain order linked to an add-on item is cancelled, When I cancel it, Then the add-on case item stays (the billed item still needs a result) and a banner says "Billed add-on still needs a result or cancellation at front desk".
6. **AC-05.6** Given block A3 is `sent_out`, When I order IHC on it, Then the stain order is created; completing it returns `409 anatomic.block_not_available` (CR) until the block is `returned`; ordering on a `discarded` block returns `409 anatomic.block_not_available` at once.
7. **AC-05.7** Given a `routine` stain (e.g. `HE`), When I submit it as a stain order, Then `400 common.validation_failed` at `/stain_code` (routine slides are created directly).

### US-06 Block/slide tracking (IS-08)
1. **AC-06.1** Given block A3 is in the lab, When I record `sent_out` to "Synthetic Referral Lab" with reason `second_opinion`, Then the block's location status is `sent_out` and a movement row exists.
2. **AC-06.2** Given I scan `S26-0042-A3` on the tracking screen, When the lookup runs, Then I see its case, current location and the full movement history, newest first.
3. **AC-06.3** Given the label belongs to another tenant, When I look it up, Then `404 common.not_found`.
4. **AC-06.4** Given a block is `discarded`, When I record any further movement for it, Then its per-id outcome is `invalid_state` and no movement row is written; creating slides from it returns `409 anatomic.block_not_available` (CR).
5. **AC-06.5** Given I record `sent_out` or `discarded` without a reason, When submitted, Then `400 common.validation_failed` at `/reason_code` and no movement row is written.

### US-07 Report draft (IS-09, IS-11)
1. **AC-07.1** Given an accessioned case, When I save a draft with microscopy, impression and comment, Then the draft version increments; a stale `If-Match` returns `409 common.version_conflict`.
2. **AC-07.2** Given a text template with short code `nm1` (synthetic) and I type `;nm1` (`;` is the typing trigger, not part of the code) and choose "insert", Then the template text is inserted at the cursor (client side) and nothing is sent until I save.
3. **AC-07.3** Given the case has two parts with completed gross, When I choose "Insert gross from parts", Then gross text is composed as "A. <part A site>: <gross text>" then "B. …".
4. **AC-07.4** Given impression text longer than 8,000 characters, When I save, Then `400 common.validation_failed`.
5. **AC-07.5** Given I select 13 images for the report while `max_report_images = 12`, When I save, Then `422 anatomic.image_limit_reached` (CR).
6. **AC-07.6** Given a diagnosis code not in the tenant's `diagnoses` list or inactive, When I save, Then `400 common.validation_failed` at `/diagnosis_codes/0/code`.

### US-08 Synoptic templates (IS-10)
1. **AC-08.1** Given I hold `anatomic.config.manage`, When I create a template draft with 2 sections and 5 fields, Then it is stored with `status = draft`, `version_no = 1`.
2. **AC-08.2** Given a definition with duplicate field keys, a `single_select` without options, or a `show_if` pointing to an unknown field, When I save, Then `422 anatomic.template_invalid` (CR) with `errors[]` paths.
3. **AC-08.3** Given a published template, When I try to edit it, Then `409 common.immutable_record`; "New version" creates `version_no = 2` as draft.
4. **AC-08.4** Given a report draft uses template v1 and v2 gets published, When I sign out, Then the report keeps v1 (the version used is stored).
5. **AC-08.5** Given a draft synoptic instance with a required field empty, When I save the draft, Then it saves; When I sign out, Then `422 anatomic.report_incomplete` (CR) listing the field path.
6. **AC-08.6** Given a retired template, When I add a new synoptic instance from it, Then `409 anatomic.template_not_published` (CR).

### US-09 Sign-out and hand-off to C5 (IS-12)
1. **AC-09.1** Given a histology case in `ready_for_reporting` with gross text and impression, When a pathologist at aal2 signs out, Then report version 1 is stored immutably, the case is `signed_out`, and `LabPort.submitModuleResult` is called once per active primary case item with `kind = 'narrative'`, `reportPhase = 'final'`, `payloadRef = { module: 'anatomic', entityId: <case_item_id>, versionNo: 1 }`, `idempotencyKey = 'anatomic:<case_item_id>:1'`.
2. **AC-09.2** Given the pathologist is at aal1, When signing out, Then `403 auth.mfa_required` and nothing changes.
3. **AC-09.3** Given a technologist without `anatomic.case.signout`, When signing out, Then `403 auth.forbidden`.
4. **AC-09.4** Given `LabPort.submitModuleResult` throws `lab.module_result_invalid` for one item, When I sign out, Then the whole transaction rolls back (no version, case unchanged) and the error is returned unchanged.
5. **AC-09.5** Given the same sign-out request is retried with the same `Idempotency-Key`, When replayed, Then the stored response is returned and no second version exists.
6. **AC-09.6** Given a molecular case, When signed out, Then `kind = 'structured'` and the view row has a non-empty `molecular` array (CR-C11-001).
7. **AC-09.7** Given "Critical finding" is ticked, When signed out, Then `isCritical = true` is passed (C5 emits `lab.critical_value.detected.v1`).
8. **AC-09.8** Given sign-out succeeded, When C6 reads `anatomic.v_pub_report_content` for `(entity_id, version_no)`, Then exactly one row with the 03-IC §6.8 columns is returned, matching the signed content.
9. **AC-09.9** Given the order item was cancelled at front desk (FrontdeskPort item status `cancelled`/`removed`), When I sign out, Then `409 anatomic.order_item_inactive` (CR) names the item and nothing changes.
10. **AC-09.10** Given the case's content exceeds 4,000 characters of impression, When submitted, Then `summaryText` is the first 3,990 characters of the impression followed by " […]" and the full text is in the view.

### US-10 Revision, amendment and addendum (IS-13)
1. **AC-10.1** Given a signed-out case whose C5 result is `resulted` or `verified` (not approved), When the pathologist starts a revision with reason `transcription_error`, edits and signs, Then version 2 exists with `version_kind = revision` and C5 receives `versionNo = 2` (A1 "later final submission while not approved").
2. **AC-10.2** Given the C5 result is `approved`, When the pathologist starts a change, Then it is an `amendment` (reason required, chosen from C5's amendment reasons — 08 A17 D-62) and on signing C5 receives version n+1 with `amendment: { reasonCode, reasonText? }` (08 R1) (C5 emits `lab.result.amended.v1`).
3. **AC-10.3** Given an amendment is signed by an actor without `lab.result.amend`, When C5 is called, Then `409 lab.result_locked` propagates and nothing changes.
4. **AC-10.4** Given a signed-out case, When I create an addendum (kind `ihc`) not linked to an add-on item and sign it, Then a new cumulative report version (`version_kind = addendum`, scope `full`) is submitted on every active primary item; original sections are unchanged in the new version; its `addenda` holds every signed addendum of the case not linked to an add-on item, oldest first; every submission carries `amendment.reasonCode = supplementary_report` (used by C5 only where the target result is approved) and C6 labels the report "Addendum" (08 R1).
5. **AC-10.5** Given an addendum linked to an add-on case item, When signed, Then only that add-on item is submitted, with a version whose scope is `addendum_only` (gross/microscopy/impression columns empty, `addenda` holds every signed addendum linked to that add-on item, oldest first — so a second addendum on the item keeps the first one's text); primary items get no new version.
6. **AC-10.6** Given a case that is not signed out, When I create an addendum, Then `409 anatomic.case_invalid_transition`.
7. **AC-10.7** Given an open revision/amendment draft exists, When another user starts one, Then `409 anatomic.case_invalid_transition` (one open change draft per case).
8. **AC-10.8** Given a revision draft is open and C5 approves the result before the pathologist signs (03-APP-FLOW E10), When the pathologist signs, Then the submission carries the draft's reason as `amendment`, C5 accepts it as an amendment, and the stored version has `version_kind = amendment` (no `lab.amendment_reason_required`).

### US-11 Molecular results and batches (IS-14)
1. **AC-11.1** Given assay `SYN_PCR_A` (synthetic) with target `T1` whose result set has codes `detected`, `not_detected`, `invalid`, When I record `T1 = detected`, method text, kit name, kit lot and kit expiry, Then the result is stored on the case.
2. **AC-11.2** Given a result code not in the target's result set, When I save, Then `400 common.validation_failed`.
3. **AC-11.3** Given a target with `allows_quantitative = true`, When I record value `"1250"` with unit code `copies_per_ml` (synthetic unit code from catalog units), Then it is stored as text decimal; a non-decimal value is rejected.
4. **AC-11.4** Given an open batch, When I add 3 molecular cases with positions 1–3, Then members are listed in position order; a duplicate position returns `409 anatomic.batch_position_taken` (CR).
5. **AC-11.5** Given a closed batch, When I add a member, Then `409 anatomic.batch_closed` (CR).
6. **AC-11.6** Given a molecular case without any result, When I mark it ready for reporting, Then `409 anatomic.case_invalid_transition`.

### US-12 Images (IS-15)
1. **AC-12.1** Given a PNG of 2 MB that the pipeline scans `clean`, When I upload it as a gross image of part A, Then I get `201` with `state = ready`, and it is viewable through `GET …/content` with `Content-Disposition: inline`, `Content-Type` = the stored mime, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, `Cache-Control: no-store`, and an access-log row `anatomic_image.view` (08 A17 D-67). If the scan is `pending`/`unavailable` I get `state = processing`, the re-scan job sets `ready` or `quarantined` (08 A17 P-19), and until then `GET …/content` returns `422 common.upload_quarantined`.
2. **AC-12.2** Given a 16 MB file, When uploaded, Then `413 common.payload_too_large`.
3. **AC-12.3** Given a file named `patient-name.png` whose bytes are a PDF, When uploaded, Then `415 common.unsupported_media_type`.
4. **AC-12.4** Given the scanner flags the file (`infected`, at upload or at re-scan), Then the image is `quarantined`, never served (`422 common.upload_quarantined`), and cannot be included in a report.
5. **AC-12.5** Given any upload, When stored, Then the object path is `{tenant_id}/{yyyy}/{mm}/{image_id}.{png|jpg}` in bucket `anatomic-images` and the original filename is stored nowhere.
6. **AC-12.6** Given the case already has `max_images_per_case` active images, When I upload another, Then `422 anatomic.image_limit_reached` (CR).
7. **AC-12.7** Given an image included in a signed version, When I deactivate it, Then it disappears from the working gallery but the signed version still references it and C6 can still read it; editing its kind, part or caption returns `409 anatomic.signout_locked` (08 A17 D-66 (c)).
8. **AC-12.8** Given a `signed_out` case with no open change draft, When I upload a microscopy image (e.g. an IHC photo for an addendum), Then the upload succeeds (08 A17 D-66 (a)).

### US-13 Worklists, labels and lookup (IS-17)
1. **AC-13.1** Given cases in every status, When I open the "To accession" queue, Then only `received` cases of centres I can see are listed, oldest first, urgent first.
2. **AC-13.2** Given a centre-scoped user of centre A1, When listing, Then cases with `centre_id` A2 are not returned (no all-centres membership).
3. **AC-13.3** Given an accessioned case with 3 blocks, When I open the labels page for blocks, Then 3 labels with label text and (once CR-C11-007 merges) a Code 128 symbol are rendered, and an `access_log` row `anatomic_label.print` is written (08 A17 D-53).
4. **AC-13.4** Given I scan an accession number on the worklist, When it matches a case, Then the case opens.

### US-14 Configuration (IS-18)
1. **AC-14.1** Given I hold `anatomic.config.manage` at aal2, When I set test profile for test X to `case_kind = cytology`, series `cytology`, default stain `PAP`, Then new cases for test X use it; existing cases are unchanged.
2. **AC-14.2** Given I deactivate stain `HE` while it is the default routine stain, When I save, Then `400 common.validation_failed` ("Choose another default routine stain first").
3. **AC-14.3** Given I add a diagnosis code `LOC-0001` (synthetic) with system `local`, When saving a report draft, Then it can be selected; deactivated codes remain displayed on existing reports.
4. **AC-14.4** Given a `lab_technologist`, When opening configuration, Then the nav entry is hidden and direct calls to the configuration write operations (K2, K4, K5, K7, K9, K10, K12, K14, K16–K19, K21, K22) return `403 auth.forbidden`; the configuration reads (K1, K3, K6, K8, K11, K13, K15, K20) need only `anatomic.case.read` and succeed.

### US-15 Case cancellation (IS-01)
1. **AC-15.1** Given a case with no submission, When I cancel it with reason `duplicate_case`, Then status `cancelled`; blocks/slides remain listed (physical material still exists).
2. **AC-15.2** Given a case with any item submission, When I cancel, Then `409 anatomic.case_invalid_transition` ("Signed-out cases cannot be cancelled; amend instead").

## 6. Success metrics

| Metric | Target | How measured |
|---|---|---|
| Re-typing of order data for anatomic cases | 0 fields (case header from events/ports) | e2e test + UAT observation |
| "Where is block X" answered | ≤ 1 scan, ≤ 2 s p95 lookup | `lookupAnatomicObject` latency metric |
| Sign-out → C5 `resulted` | same transaction (atomic) | integration test |
| Cross-tenant/centre leaks | 0 in probe suite | CI probes |
| Synoptic required-field completeness at sign-out | 100 % enforced | AC-08.5 test |
| Image upload processing | p95 ≤ 30 s from upload to `ready` [CONV] | `lims_anatomic_image_processing_seconds` |

## 7. Phase

Phase 2 (04 §12). Wave 2 (01-CM §1). Builds against C0 contracts and fakes from day one; no code dependency on C5/C6 beyond their contracts.

## 8. Dependencies (contracts only)

| Contract | Use | Status |
|---|---|---|
| `lab.specimen.status_changed.v1` (C5) | create cases/parts on `received`; part state on `rejected` | 03-IC §3.7 (A4: C11 is a listed consumer) |
| `LabPort.submitModuleResult` (C5) | hand signed versions into verify/approve/release | 03-IC §4.5 (A1); amendment reason per 08 R1 (CR-C11-004 merged into CR-C10-001) |
| `LabPort.getOrderResults` (C5, `all_visible`) | show C5 chain status of each case item | 03-IC §4.5 |
| `FrontdeskPort.getOrderSummary`, `getPatientDemographics` / `getPatientDemographicsBatch` purpose `lab_display` (C4) | items, priority, item status; patient header | 03-IC §4.3; purpose + batch from CR-C5-003 (acknowledged) |
| `CatalogPort.getTest` (C3) | `workflowType`, test name; validate test profile ids | 03-IC §4.2 |
| `IdentityPort.assertRole`, `getActor` (caller only), `getTenantSettings` (C2) | authorisation; timezone; numbering (CR-C11-005) | 03-IC §4.6 |
| `ctx.core.memberships.list`, `ctx.core.user`, `ctx.core.branch` (C0) | staff display names, assignee picker, `{branch}` token | C0 02-TRD §6.8; 08 A17 P-17 / D-47 |
| C5 BFF `listLabCodedSet('amendment_reasons')` | change/amendment reason picker | C5 02-TRD #53; 08 A17 D-62 |
| `anatomic.v_pub_report_content` (C11 → C6, C14) | C6 renders anatomic sections | 03-IC §6.8 |
| C0 upload pipeline + storage adapter (`ctx.uploads`, `ctx.storage`) | images | CR-C2-011 (acknowledged); bucket CR-C11-008 |
| `@lims/ui` kit | all screens | C0 04-UI-UX; CR-C6-010 `ImageThumbnailGrid` (acknowledged), CR-C11-007 `BarcodeSymbol` |

## 9. Blocked and unverified items (build against the default)

| Item | Status | Default built meanwhile |
|---|---|---|
| B3 test list (which anatomic/molecular tests exist) | BLOCKED B3 | synthetic catalog with anatomic, cytology, IHC add-on and molecular tests from `packages/test-fixtures` |
| B15 legal retention | BLOCKED B15 | 5-year default via tenant `retentionYears` (04 I8); no purge in C11 |
| B16 Privacy Regulation 2077 content | BLOCKED B16 | controls per 02-security |
| SNOMED CT / ICD-O licensing for Nepal | UNVERIFIED (01 research §2.4; log #18) | local tenant-authored diagnosis list; no bundled codes |
| CAP (or other) synoptic protocol content/licence | UNVERIFIED — not researched | template system as data; labs author their own; no third-party protocol text shipped |
| Bethesda category list | concept CONFIRMED only via Wikipedia (01 log #17) | not seeded; labs author adequacy/category lists |
| Storage claims behaviour (04 D3) | UNVERIFIED (SP-4 in C0) | all image IO server-side via `ctx.storage`; no browser Storage access |
| Upload pipeline API (`ctx.uploads`) | CR-C2-011 accepted (08 §4.13); not yet built by C0-0D | fake upload pipeline from `@lims/fakes` |
| Anatomic case volume | ASSUMPTION ≤ 5 % of patients (02-TRD §11) | performance budget derived from it |
| Label printers / Code 128 readability for block/slide labels | ASSUMPTION (as C5 §4.6) | text labels until C0-0D ships `BarcodeSymbol` (CR-C11-007, accepted); validate per site |
| "Speciality segment" in wishlist item 2 | meaning UNVERIFIED (00 §3 item 2 gives no detail) | not interpreted; ask client |

## 10. Open questions for the client (via founder)

1. Q1: Which anatomic/molecular tests and volumes per month (B3)?
2. Q2: Accession series: one series for histology and cytology, or separate (default: separate prefixes `S`, `C`, `I`, `M` — DECISION)?
3. Q3: Should IHC add-ons be billed as separate order items (then C11 links them) or included in the histology price (default: link optional)?
4. Q4: Who verifies anatomic results in C5 after pathologist sign-out (default: any holder of `lab.result.verify`, then a different holder of `lab.result.approve`, per 03-IC §10.2 R6)? Sign-out locks the C11 report version and is not C5 approval (06-GLOSSARY "Sign-out", 08 R2); whether a sign-out may also count as C5 verification is client decision C-02 (08 §5.2), default **no**.
5. Q5: Which diagnosis coding system, if any, does the lab hold rights to?
