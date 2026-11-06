# C10 Microbiology — 01 Product Requirements (PRD)

Status: DECISION, 2026-11-06. Chunk C10, **Phase 2** (04 §12: "microbiology (isolates, AST, prelim/final)"). Module `micro` (Postgres schema, API module, worker jobs, staff-web feature).
Precedence: `research/00` > `research/04` > `program/03-INTERFACE-CATALOG.md` (03-IC) > `program/01`/`02` > this file. Contract gaps are raised as CRs in `02-TRD.md` §15 and designed as if accepted (marked **(CR-C10-nnn)**).

Labels: **DECISION** = engineering choice made here (change by CR). **[CONV]** = value chosen here with no external fact behind it. **ASSUMPTION** = planning assumption to validate. **UNVERIFIED** / **BLOCKED (B#)** as in 04.

---

## 1. Purpose

Microbiology "culture and sensitivity" (C/S) does not fit the one-value-per-analyte model of C5. One specimen produces a **culture** (media, incubation, periodic reads), 0..n **isolates**, an **organism identification** per isolate and an **AST panel** per isolate, each antibiotic carrying a raw measurement (MIC or zone diameter) and an **interpretive category** (01 §2.3). Reports go out several times for one order: preliminary (Gram stain, "no growth at 24 h", growth with identification pending) and final, and later amended (01 §2.3; 06-GLOSSARY "Preliminary vs final report").

C10:
1. Starts a culture when C5 reports that a microbiology specimen was received (`lab.specimen.status_changed.v1`, `to_status = received` — 03-IC §3.7, accepted addition A4).
2. Records plates/media, incubation, reads, stains, isolates (numbered per specimen), organism identification, AST panels and AST values.
3. Stores AST interpretation as an **extensible coded set**: category code + breakpoint standard (CLSI / EUCAST / ECOFF) + standard version, plus the raw value as received — never a 3-value enum (04 D14).
4. Accepts organism-ID and AST records from ID/AST instruments through `instruments.result.received.v1` (03-IC §3.14) without assuming any vendor payload (B2).
5. Hands each preliminary/final/amended report version into the common verify → approve → release chain through `LabPort.submitModuleResult` (03-IC §4.5, A1), and publishes the immutable report content through `micro.v_pub_report_content` (03-IC §6.8) so C6 renders micro sections without reading C10 tables.
6. Lets a lab import **its own licensed** breakpoint tables (versioned, effective-dated) to **suggest** categories for manual disk-diffusion entry. The LIMS provider ships **no** CLSI/EUCAST breakpoint values (01 §2.3; 04 L24).

C10 does **not** verify, approve, release, render or deliver reports. Those stay in C5 (verify/approve/lock/amend) and C6 (render/release/deliver).

## 2. Users and roles

Role and permission codes from 03-IC §11. Codes marked **(CR)** are requested in CR-C10-004.

| Role (default) | What they do in C10 | Permissions used |
|---|---|---|
| `lab_technologist` | Worklist, culture setup, plates, reads, Gram stain, isolates, identification, AST entry, instrument-record matching, preliminary and final report submission | `micro.culture.read`, `micro.culture.work` |
| `pathologist` | Reviews cultures; submits finals; **amends approved micro results** (the amendment path needs C5's `lab.result.amend`); verifies/approves in C5 (not in C10) | `micro.culture.read`, `micro.culture.work` (granted by CR-C10-004 to `pathologist` as well), `lab.result.amend` (C5's, checked by C5 inside `submitModuleResult`), `micro.breakpoint.manage` (CR) |
| `lab_manager` | Dictionaries (organisms, antibiotics, media, sites…), plating protocols, AST panels, instrument vocabulary maps, settings, breakpoint imports; reads cultures and configuration | `micro.culture.read` (08 A17 D-64), `micro.config.manage` (CR), `micro.breakpoint.manage` (CR, privileged) |
| System actor (worker) | Event consumers, import validation job, chain reconciliation job | declared in the `micro` worker manifest (02-CV §2.3): `micro.culture.read`, `micro.culture.work`, `lab.result.read` |

Verification (`lab.result.verify`) and approval (`lab.result.approve`) of micro results happen on C5's screens, exactly like every other department (A1 semantics, 03-IC §4.5).

## 3. Problems this chunk solves

1. The client needs "Complete lab software with Microbiology…" (00 §3 wishlist 2) and an interface to a "microbiology ID/AST system" (00 §3 wishlist 3). Metro Labs runs microbiology, so it is needed to replace eLabs (01 §1.7).
2. Microbiology data does not fit one result per analyte: isolates, organisms, antibiotic panels, preliminary/final reports (01 §1.7, §2.3).
3. AST interpretation is **not** S/I/R: CLSI uses S, SDD, I, I^, R, NS (colistin/polymyxin B: I/R only); EUCAST uses S, I ("susceptible, increased exposure"), R; ECOFF uses WT/NWT. The standard and its version must be stored with each interpretation (04 D14, VERIFIED from the CLSI primary blog; M100 text not opened).
4. Breakpoints change between editions (CLSI M100 Ed36, 26 Jan 2026 — 04 L24, VERIFIED) and are a licensing and maintenance burden (01 §2.3), so the product must not embed them.
5. Clinicians need early information (Gram stain, growth) long before the final AST (01 §2.3 timeline).

## 4. In scope

Baseline item ids: 00 §2 (A–F features), 00 §3 (wishlist). Research references: 01 §2.3.

| ID | Capability | Baseline | Notes |
|---|---|---|---|
| IS-01 | Consume `lab.specimen.status_changed.v1`; create one culture per (micro order item, specimen) on `to_status = received`; cancel on `rejected` | wishlist 2; A4 | §7 US-01 |
| IS-02 | Micro worklist with barcode scan, tabs by culture state, "reads due" ordering | wishlist 2; F4 (pending list for technicians) | US-02 |
| IS-03 | Culture setup from a plating protocol (media per specimen type/test, incubation text, read schedule, no-growth final time) | 01 §2.3 "plated (media per specimen-type SOP)" | US-03 |
| IS-04 | Observations: plate reads (growth code, quantity), Gram stain, direct microscopy, other; append-only with corrections | 01 §2.3 Day 0/Day 1 | US-04 |
| IS-05 | Isolates numbered per specimen; organism identification from the local dictionary; withdraw isolate | 01 §2.3; prompt | US-05 |
| IS-06 | AST panels (antibiotic list chosen by organism group + specimen site), manual AST entry: raw MIC (with qualifier) or zone diameter, category + standard + version | 01 §2.3; 04 D14 | US-06 |
| IS-07 | Breakpoint **suggestion** for manual disk-diffusion entry from a lab-imported, versioned, effective-dated table; lookup key includes specimen site (04 L24 site dimension UNVERIFIED → kept); MIC suggestion behind a tenant flag, default off (KEEP-LATER, 01 §2.3) | 01 §2.3 | US-07 |
| IS-08 | ID/AST instrument records via `instruments.result.received.v1` (`record_kind ∈ {organism_id, ast}`): store as received, map vocabulary, auto-apply, conflicts, late records | wishlist 3; 03-IC §3.14 | US-08; driver BLOCKED B2 |
| IS-09 | Preliminary report versions → `LabPort.submitModuleResult` (`reportPhase: preliminary`) | 01 §2.3 "Preliminary vs final reports" | US-09 |
| IS-10 | Final report version with completeness guards → `submitModuleResult` (`final`) | 01 §2.3 | US-10 |
| IS-11 | Amendment after final (reopen with reason, new version; C5 decides re-submission vs amendment) | 00 C6 (only pathologist changes after approval); 04 R1 | US-11 |
| IS-12 | Breakpoint table import (CSV, lab-licensed data, licence attestation, validation report) | 01 §2.3 "manual breakpoint table"; prompt | US-12 |
| IS-13 | Breakpoint set lifecycle: validated → active (effective-dated, four-eyes) → retired | 01 §2.3; 04 L24 | US-13 |
| IS-14 | Configuration: tenant extensions of global dictionaries (organisms, organism groups, antibiotics, media, specimen sites, growth codes, culture outcomes, reason sets), plating protocols, AST panels, instrument vocabulary maps, per-instrument default standard, settings | 01 §2.3 | US-14 |
| IS-15 | Published view `micro.v_pub_report_content` with the exact 03-IC §6.8 columns and JSON shapes | A1 | US-15 |
| IS-16 | Phase-3 hook for cascade/selective reporting: per-AST-row `report_visibility` (default `shown`), no rule engine | 04 §12 Phase 3; 01 §2.3 | US-16 |
| IS-17 | Chain reconciliation: detect order items cancelled in C5 and close their cultures | — (consistency) | US-17 |
| IS-18 | In-app help + user manual pages for every screen | 01 §2 training note; 05-DoD §3.8 | — |

## 5. Out of scope

| Item | Where it lives / why |
|---|---|
| Verification, approval, locking, amendment versioning of the result line | C5 (03-IC §10.2; A1) |
| PDF rendering, report kind labels, release, delivery | C6 (C6 renders from `micro.v_pub_report_content`) |
| Instrument drivers, ASTM/HL7 parsing, bridge agent | C7; the ID/AST driver itself is BLOCKED B2 (VITEK BCI payload UNVERIFIED — 01 §2.3, §3.2) |
| Built-in CLSI or EUCAST breakpoint values, expert rules, intrinsic-resistance rules | Never shipped (licensing + annual maintenance — 01 §2.3). Labs import their own data (IS-12) |
| Automatic category assignment without a human confirming it | KEEP-LATER (01 §2.3 "LIS applies CLSI breakpoints automatically for manual AST") |
| Cascade / selective reporting rule engine | Phase 3 (04 §12); only the IS-16 hook here |
| Cumulative antibiogram export (organism × antibiotic %S per year) | 01 §2.3 "MIS must support"; C8 owns MIS. C10 lists a published-view CR candidate (06-IMPLEMENTATION-PLAN §4); not built in this chunk |
| SNOMED CT content import | Licensing for Nepal UNVERIFIED (01 §2.4; 06-GLOSSARY "Organism") — only an optional mapping field |
| TAT targets and alerts for micro | C9 (Phase 2) from C5's published views |
| Molecular / PCR | C11 (`workflowType: molecular`) |
| Patient demographics storage | C4; C10 stores ids only and shows names through C4's HTTP API in the BFF |
| ID/AST instrument graphs (00 §3 wishlist 3 "with graphs") | C7: stored as `attachment`-kind records and shown in the C7 message viewer (08 A13 D-40). C10 ignores `record_kind = attachment` (AC-08.1); printing on reports is a later C6 CR |

## 6. Definitions used here

- **Culture**: workflow object for one micro order item on one specimen; produces 0..n isolates and ≥1 report versions (06-GLOSSARY "Culture").
- **Isolate number** (`isolate_seq`): integer ≥1, unique per **specimen** (prompt; matches the instrument payload's `isolate_seq` per sample — 03-IC §3.14 — and the `<isolate_seq>` segment of `instrument_analyte_code`, `ORG:<n>` / `AST:<n>:…`, C7 driver rule, 08 R13).
- **Report version**: immutable snapshot of what C10 hands to C5 (`payloadRef = { module: 'micro', entityId: culture_id, versionNo }`) and publishes in `micro.v_pub_report_content`.
- **Interpretation**: `(category_code, standard, standard_version)` + `raw_value` as entered/received + `interpretation_raw` as received (04 D14).

## 7. User stories and acceptance criteria

Every AC becomes at least one automated test (05-DoD §2). Ids of entities are synthetic.

### US-01 Start a culture when a micro specimen is received (IS-01)
As a micro technologist, I want a culture to appear on my worklist as soon as the specimen is received, so that I do not re-key orders.
- **AC-01.1** Given a `lab.specimen.status_changed.v1` with `to_status = received` whose `order_item_ids` include an item whose test has `workflowType = microbiology` (via `LabPort.getOrderResults` + `CatalogPort.getTest`), When the consumer runs, Then exactly one `micro.cultures` row exists for `(order_item_id, specimen_id)` with `status = awaiting_setup`, `received_at = changed_at`, `centre_id`, `patient_id`, `order_id`, `test_id`, `specimen_type_code` from the event/port, and a `culture_transitions` row `∅ → awaiting_setup`.
- **AC-01.2** Given the same event delivered twice (same `event_id`), Then the second delivery is a no-op (inbox) and no second culture exists.
- **AC-01.3** Given a second event with a different `event_id` but the same `(order_item_id, specimen_id)`, Then no second culture is created (creation key unique) and the consumer succeeds.
- **AC-01.4** Given an event whose `order_item_ids` contain no microbiology item, Then no culture is created and the inbox row is written.
- **AC-01.4a** Given an event **without** `order_item_ids` for an order with urine C/S and blood culture on two specimens, When the urine specimen's `received` arrives, Then a culture is created only for the item whose test `specimenTypeCodes` contains `urine`; given the order has two non-rejected specimens of the event's specimen type, Then no culture is created and `lims_micro_unmapped_received_total` increments (alerted) (review #12).
- **AC-01.5** Given an event with `aggregate.seq` ≤ the culture's `last_specimen_seq`, Then it is ignored (stale).
- **AC-01.6** Given a culture in `awaiting_setup`, `incubating` or `growth_detected` with **no submitted report version**, When `to_status = rejected` arrives for its specimen, Then the culture becomes `cancelled` with `cancel_reason_code = specimen_rejected`.
- **AC-01.7** Given a culture with ≥1 submitted report version, When `to_status = rejected` arrives, Then the culture is not changed and metric `lims_micro_specimen_rejected_after_report_total` increments (C5 handles the result via R8).
- **AC-01.8** Given an aliquot event (`from_status` absent, `to_status = received`, `parent_specimen_id = P`) whose items include micro item `I`, and a culture for `(I, P)` still in `awaiting_setup`, Then that culture's `specimen_id` is re-pointed to the aliquot (audited), `last_specimen_seq` is set to the aliquot event's `aggregate.seq`, and no new culture is created; a later `rejected` event of the aliquot then cancels the culture (AC-01.6). If the culture has left `awaiting_setup`, Then nothing changes, no culture is ever created for `(I, aliquot)`, and `lims_micro_aliquot_after_setup_total` increments (review m#17, m#18).
- **AC-01.9** Given a recollection specimen (`replaces_specimen_id` set) received for micro item `I`, Then a new culture is created for `(I, new specimen)`; the old culture is unaffected by this event.

### US-02 Micro worklist and barcode scan (IS-02)
- **AC-02.1** Given cultures in several states, When a user with `micro.culture.read` opens `/micro/worklist`, Then tabs show counts and rows for: Awaiting setup, Incubating, Growth / work-up, Amending, Recently submitted (last 7 days [CONV]); default sort per tab is in 04-UI-UX §2.
- **AC-02.2** Given the user scans a barcode, When the BFF resolves it through C5 `lookupSpecimenByBarcode` and C10 finds exactly one non-cancelled culture for that specimen, Then the culture page opens; given several cultures, Then a chooser lists them; given none, Then the message "No microbiology culture for this specimen" appears and nothing else is disclosed.
- **AC-02.3** Given a user scoped to centre A1 only, When listing cultures, Then only cultures (and their child rows) whose `centre_id` (collection centre) is A1 are returned; a hub user with `all_centres` (08 A13 D-13(2), extended to micro permissions by 08 A17 D-63) sees all (RLS, 05-SCHEMA §4).
- **AC-02.4** Given a culture in `incubating` whose `next_read_due_at` < now, Then the row shows "Read overdue" (text, not colour only).

### US-03 Set up a culture (IS-03)
- **AC-03.1** Given a culture in `awaiting_setup`, When the user posts `setupCulture` with ≥1 plate (media code active) and optional protocol, Then the culture becomes `incubating`, `planted_at` is set (default now; ≤ now and ≥ now − 72 h [CONV]), plates are numbered 1..n, `next_read_due_at = planted_at + first read_schedule_hours`, `final_due_at = planted_at + final_no_growth_hours`, and a transition row is written.
- **AC-03.2** Given no protocol is given, Then the protocol is resolved by key precedence (test + specimen type) > (test) > (specimen type) > tenant default; if none, Then the request needs explicit plates and `final_no_growth_hours` falls back to `micro.settings.default_final_no_growth_hours` (default 48 [CONV], from the 01 §2.3 example "No growth after 48h/72h/5d").
- **AC-03.3** Given a culture not in `awaiting_setup`, When `setupCulture` is called, Then `409 micro.culture_invalid_transition`.
- **AC-03.4** Given a stale `If-Match`, Then `409 common.version_conflict`.

### US-04 Record reads and stains (IS-04)
- **AC-04.1** Given an `incubating` culture, When a `plate_read` with a growth code whose `indicates_growth = true` is recorded, Then the culture becomes `growth_detected`.
- **AC-04.2** Given a `plate_read` with `no_growth`, Then the culture stays `incubating` and `next_read_due_at` moves to the next scheduled hour after `planted_at` that is later than `observed_at`, or is cleared when the schedule is exhausted.
- **AC-04.3** Given a `gram_stain` or `microscopy` observation, Then `finding_text` (1..2000) is required and the culture state does not change.
- **AC-04.4** Observations are never updated: a correction is a new observation with `corrects_observation_id`; the UI shows the corrected one struck through with "Corrected".
- **AC-04.5** Given a culture in `final_submitted` or `cancelled`, When an observation is posted, Then `409 micro.report_final_locked` (final) or `409 micro.culture_invalid_transition` (cancelled).

### US-05 Isolates and identification (IS-05)
- **AC-05.1** Given a culture of specimen S with existing isolates 1 and 2 (possibly on another culture of S), When `createIsolate` runs, Then the new isolate gets `isolate_seq = 3` (per-specimen counter) and the culture becomes `growth_detected` if it was `incubating`.
- **AC-05.2** Given `identifyIsolate` with an active organism code, Then the isolate becomes `identified` with `organism_source = manual`; with an unknown or inactive code, Then `422 micro.organism_code_unknown`.
- **AC-05.3** Given an identified isolate, When re-identified before final, Then the organism changes and the audit log keeps old/new.
- **AC-05.4** Given `withdrawIsolate` with a reason code, Then status `withdrawn`, the isolate and its AST rows are excluded from report snapshots.
- **AC-05.5** Isolates are never keyed by organism: two isolates of the same organism are allowed (06-GLOSSARY "Isolate").

### US-06 AST panel and manual AST entry (IS-06)
- **AC-06.1** Given an identified isolate, When `assignAstPanel` is called without a panel id, Then the panel is chosen by precedence (organism + site) > (organism) > (organism group + site) > (organism group) > (site) > none, and one pending AST row per panel antibiotic is created with the panel's method.
- **AC-06.2** Given `recordAstResults` with `raw_value = "<=0.25"` and method `mic`, Then `raw_qualifier = '<='`, `raw_numeric = 0.25`, `raw_value` is stored exactly as entered, `unit_code = ug_ml`; given method `zone_diameter` with `"18"`, Then `unit_code = mm`. Invalid syntax → per-entry `micro.ast_value_invalid`.
- **AC-06.3** Given an entry with a category but no standard or no standard version, Then per-entry `422 micro.ast_standard_required`.
- **AC-06.3a** Given an entry with a category but no raw value (in the entry or already stored), Then per-entry `micro.ast_value_invalid`; nothing is stored for that entry (review #11).
- **AC-06.4** Given `standard = CLSI`, antibiotic `colistin` (or `polymyxin_b`) and category `S`, Then per-entry `422 micro.ast_category_not_allowed` (seeded restriction: I/R only — 04 D14).
- **AC-06.5** Given a category code that does not exist for the given standard (e.g. `SDD` with `EUCAST`), Then per-entry `422 micro.ast_category_not_allowed`.
- **AC-06.6** Given an antibiotic not in the isolate's panel, Then per-entry `422 micro.antibiotic_not_in_panel` unless the entry sets `add_to_isolate: true` (then stored with `off_panel = true`).
- **AC-06.7** The interpretation field is never constrained to three values: a test inserts every seeded code (CLSI S/SDD/I/I^/R/NS, EUCAST S/I/R, ECOFF WT/NWT) and one newly seeded synthetic code without code changes.

### US-07 Breakpoint suggestion for manual entry (IS-07)
- **AC-07.1** Given tenant setting `manual_ast_standard = CLSI`, an active CLSI breakpoint set effective at `now`, and a manual zone entry for (organism, antibiotic, `zone_diameter`, site), When `previewAstInterpretation` runs, Then it returns the category of the band containing the value, the `breakpoint_set_id`, `breakpoint_band_id`, `standard`, `standard_version`; nothing is saved.
- **AC-07.2** Lookup precedence: organism-specific row > organism-group row > `any`; within that, site-specific row > site-less row. A test covers each level.
- **AC-07.3** Given a value in a gap between bands, or an MIC qualifier whose interval spans more than one band (e.g. `<=4` when the lowest band has a lower bound), Then the response is `suggestion: none` with reason `indeterminate`.
- **AC-07.4** Given method `mic` and `mic_suggestion_enabled = false` (default), Then no suggestion (`reason: disabled`).
- **AC-07.5** Given the user saves with the suggested category, Then `interpretation_source = breakpoint_suggestion`, and the set/band ids are stored; given the user saves a different category, Then `interpretation_source = manual` and `suggestion_overridden = true`.
- **AC-07.6** Given two active sets for the same standard whose effective periods would overlap, When activating the second, Then the first's `effective_to` is set to the second's `effective_from` in the same transaction; lookups at a time inside the first period use the first set.
- **AC-07.7** No breakpoint value exists in seeds, fixtures, code or docs except synthetic values in tests whose organism/antibiotic codes start with `synthetic_` (CI grep).

### US-08 ID/AST instrument records (IS-08; driver BLOCKED B2)
- **AC-08.1** Given `instruments.result.received.v1` with `record_kind` not in {`organism_id`, `ast`}, Then the consumer only writes the inbox row.
- **AC-08.2** Given an `organism_id`/`ast` record, Then exactly one `micro.instrument_records` row exists per event `idempotency_key`, storing exactly: `event_id`, `idempotency_key`, `instrument_message_id`, `instrument_id`, `centre_id`, `sample_barcode`, `record_kind`, `instrument_analyte_code`, `isolate_seq`, `organism_code_raw`, `organism_code` (mapped, if sent), `antibiotic_code_raw`, `antibiotic_code` (mapped, if sent), `method`, `raw_value`, `interpretation_raw`, `standard`, `standard_version`, `instrument_result_time`, `received_at`, `is_rerun` (review m#24).
- **AC-08.3** Given the specimen can be resolved (CR-C10-003 `LabPort.lookupSpecimens` by barcode) to exactly one non-cancelled culture, and the vocabulary map resolves the raw organism/antibiotic code, Then the record is applied: organism → isolate with that `isolate_seq` (created if absent and the per-specimen counter is advanced to at least that number); AST → upsert of `(isolate, antibiotic, method)` with `source = instrument`, `interpretation_source = instrument`; `match_status = applied`.
- **AC-08.4** Until `LabPort.lookupSpecimens` (CR-C10-003, accepted in 08) is enabled, or when resolution finds 0 or >1 cultures, Then `match_status = pending_match`; a user assigns it to a culture (`assignMicroInstrumentRecord`), which applies it as in AC-08.3.
- **AC-08.5** Given an unmapped raw code, Then `match_status = needs_mapping`; after a map is created, `applyMicroInstrumentRecord` applies it.
- **AC-08.6** Given an existing **manual** value for the same `(isolate, antibiotic, method)`, or a different manually identified organism, Then `match_status = conflict`; apply with `resolution = use_instrument` replaces it (audited), `keep_existing` closes the record as `ignored` with reason `kept_manual`.
- **AC-08.7** Given an AST record with `standard = unknown` or absent and a per-instrument default `(standard, version)` configured, Then the row stores the default with `standard_source = instrument_default`; without a default it stores `standard = unknown` and the row blocks final submission (`micro.ast_standard_required`).
- **AC-08.8** Given `interpretation_raw` not equal to a code of that standard, Then `category_code` stays empty and the row needs manual review.
- **AC-08.9** Given the target culture is `final_submitted`, Then `match_status = late_after_final` and a banner on the culture says "Instrument data arrived after the final report"; nothing is applied until the culture is reopened.
- **AC-08.10** Barcodes in instrument records are never logged and never appear in URLs (02-CV §9.2).
- **AC-08.11** Given an instrument record whose isolate number is > 99, Then `match_status = pending_match` with reason `isolate_seq_out_of_range` (no retry, no dead letter) (review m#28).
- **AC-08.12** Given a record that became `applied`/`ignored` at time t, Then `expires_at = t + TenantSettings.retention.rawInstrumentYears` years, and `micro.purge_instrument_records` deletes it after `expires_at` unless an AST row references it (08 A17 D-65).

### US-09 Preliminary report (IS-09)
- **AC-09.1** Given a culture with ≥1 observation or isolate and not `cancelled`, When `submitCultureReport` with `report_phase = preliminary` runs, Then in one transaction: `version_no = previous + 1`, a `micro.report_versions` snapshot is written, and `LabPort.submitModuleResult` is called with `payloadRef { module: 'micro', entityId: culture_id, versionNo }`, `reportPhase: 'preliminary'`, `summaryText` = snapshot summary, `flag` per outcome, `isCritical`, `idempotencyKey = micro:<culture_id>:<version_no>`.
- **AC-09.2** Given `submitModuleResult` throws (e.g. `lab.result_invalid_transition` because C5 cancelled the item), Then nothing is persisted in C10 and the error code is returned unchanged.
- **AC-09.3** Given the same `Idempotency-Key` replayed, Then the stored response is replayed (core) and no new version exists.
- **AC-09.4** Given a culture with nothing recorded, Then `422 micro.report_incomplete`.
- **AC-09.5** Report versions are immutable: `UPDATE`/`DELETE` on `micro.report_versions` is impossible for `lims_app` (grant test).
- **AC-09.6** Given a culture not `amending` whose C5 line is `approved` with a `preliminary` as the last approved version, When a new **preliminary** is submitted, Then C10 sends `amendment: { reasonCode: 'module_preliminary_update' }` automatically; with `lab.result.amend` C5 creates version n+1 and `lab.result.amended.v1` carries that code; without it `lab.result_locked` (409) is passed through; the stored report version has `version_kind = amendment` and `amendment_reason_code = module_preliminary_update` (08 A17 D-61). A preliminary from `amending` stays `409 micro.culture_invalid_transition`.
- **AC-09.7** Given the snapshot would contain more than 20 isolates or more than 600 AST rows, Then `422 micro.report_incomplete` with `errors[]` and nothing is submitted (review m#28).

### US-10 Final report (IS-10)
- **AC-10.1** Given `report_phase = final`, Then `outcome_code` is required (coded set `culture_outcomes`).
- **AC-10.2** Given an outcome with `requires_isolate = true`, Then ≥1 reportable, identified isolate is required; every reportable AST row of a reportable isolate must have `raw_value`, `category_code`, a standard ∈ {CLSI, EUCAST, ECOFF} and a version, else `422 micro.report_incomplete` / `micro.ast_standard_required` with `errors[]` paths per offending row.
- **AC-10.3** Given a no-growth outcome before `final_due_at`, Then `early_final_reason` (1..500) is required when `micro.settings.early_final_requires_reason = true` (default), else `422 micro.report_incomplete`.
- **AC-10.4** On success the culture becomes `final_submitted`, `outcome_code` is stored, and further edits of plates/observations/isolates/AST return `409 micro.report_final_locked`.
- **AC-10.5** The snapshot `isolates` contains only identified, reportable, non-withdrawn isolates; `ast` contains only rows with `is_reportable = true`, `report_visibility = shown` and a category.
- **AC-10.6** Given a final that follows an approved preliminary (auto `module_phase_progression`), Then the stored report version has `version_kind = amendment` and `amendment_reason_code = module_phase_progression` (review #35).
- **AC-10.7** Given a `final_submitted` culture, When any write reaches `isolates`, `ast_results`, `culture_plates` or `culture_observations` (also bypassing the service), Then the DB trigger refuses it and the API returns `409 micro.report_final_locked` (review #7).

### US-11 Amend after final (IS-11)
- **AC-11.1** Given a `final_submitted` culture, When `reopenCulture` is called with an amendment reason code (from C5's `lab.amendment_reasons` set; the UI offers it without the system codes `module_phase_progression`, `module_preliminary_update`, `supplementary_report` — 08 A17 D-62) and optional text, Then the culture becomes `amending` and working rows are editable again. C10 checks the code's format only; C5 validates it at submission.
- **AC-11.2** Given an `amending` culture whose C5 result is `approved`, When the user submits a new version, Then C10 requires the amendment reason, sends it as `amendment: { reasonCode, reasonText? }` (CR-C10-001, 08 R1), and C5's rule applies: without `lab.result.amend` C5 throws `lab.result_locked` (passed through as 409); with it, C5 creates version n+1 and emits `lab.result.amended.v1`.
- **AC-11.3** Given an `amending` culture whose C5 result is not yet approved, Then submission is an ordinary re-submission (A1: result stays/returns to `resulted`).
- **AC-11.4** Given `reopenCulture` without a reason, Then `422 micro.amendment_reason_required`.
- **AC-11.5** Previous report versions remain readable in `listCultureReportVersions` and in `micro.v_pub_report_content`.
- **AC-11.6** Given an `amending` culture reopened with a reason code that C5 rejects, When the user submits, Then `422 lab.module_result_invalid` is passed through unchanged, nothing is persisted, and the culture stays `amending` (D-62).

### US-12 Import a breakpoint table (IS-12)
- **AC-12.1** Given a user with `micro.breakpoint.manage` at aal2, When uploading a CSV ≤ 5 MiB (5,242,880 bytes) [CONV] in the template format with metadata (standard, version, title, licence attestation 20..500 chars, intended effective_from — stored as `intended_effective_from`), Then a set is created with `status = uploaded`, the file stored under `micro-imports/{tenant_id}/breakpoints/{set_id}.csv`, and job `micro.breakpoint_import_validate` is enqueued; the API never parses the file.
- **AC-12.2** Given the job runs (a retry leaves the status `validating` unchanged), Then each line is validated (header exact, codes exist in the tenant's dictionaries, category valid for the standard, numbers as DecimalString, bands per key non-overlapping, ≤ 6 bands per key [CONV], category restrictions); errors/warnings are stored per line; status becomes `validated` (0 errors) or `invalid`.
- **AC-12.3** Given the same file (sha256) already uploaded for the same standard and not discarded/invalid, Then `422 micro.breakpoint_import_invalid` with detail "duplicate file" (the code's registered status; review #10).
- **AC-12.4** Given a file > 20,000 lines [CONV] or parsing beyond 60 s [CONV], Then status `invalid` with issue code `file.too_many_rows` / `file.parse_timeout`.
- **AC-12.5** Given aal1, Then `403 auth.mfa_required`.

### US-13 Activate, retire, discard breakpoint sets (IS-13)
- **AC-13.1** Given a `validated` set, When a **different** user than the importer activates it with `effective_from ≥ now − 60 s` [CONV: not back-dated], Then status `active`; without `effective_from` the default is the set's `intended_effective_from` when it is not earlier than now − 60 s, else now; the importer activating gets `403 micro.breakpoint_four_eyes_required`.
- **AC-13.2** Activation closes the currently active set of the same standard at the new `effective_from` (AC-07.6).
- **AC-13.3** Given an `active` set, When retired, Then `effective_to = greatest(now, effective_from)` and status `retired`; existing AST rows keep their `breakpoint_set_id`.
- **AC-13.4** Rows and bands of a set are never updated or deleted (grant test); a correction is a new import.
- **AC-13.5** `discard` is allowed only from `uploaded`, `validated`, `invalid`.

### US-14 Configuration (IS-14)
- **AC-14.1** Tenant codes shadow global codes by `code`; deactivating a global code for a tenant is a tenant row with `is_active = false`.
- **AC-14.2** Plating protocols and AST panels are versioned: a new version supersedes the previous; cultures/isolates keep the version they used.
- **AC-14.3** `organism.snomed_ct_concept_id` is optional, `^[0-9]{6,18}$` [CONV], empty in every seed (SNOMED CT licensing for Nepal UNVERIFIED).
- **AC-14.4** An instrument vocabulary map is unique per `(instrument_id, kind, code_raw)`; `local_code` must exist and be active.
- **AC-14.5** Settings writes require `micro.config.manage`; ranges are validated (`default_final_no_growth_hours` 1..720 [CONV]).

### US-15 Report content for C6 (IS-15)
- **AC-15.1** `micro.v_pub_report_content` has exactly the 03-IC §6.8 columns in that order; `entity_id = culture_id`.
- **AC-15.2** `isolates` and `ast` JSON validate against the schemas in 05-SCHEMA §6 (every key present; no extra keys).
- **AC-15.3** The view returns zero rows of another tenant and respects centre scope (`security_invoker = true`).
- **AC-15.4** For every `(entity_id, version_no)` submitted through A1 the row never changes (immutability test).

### US-16 Cascade-reporting hook (IS-16, Phase 3 later)
- **AC-16.1** Every AST row has `report_visibility = shown` unless a future rule sets `suppressed_by_rule`; v1 offers no API to set it; snapshots exclude suppressed rows but the rows stay stored (06-GLOSSARY "Cascade reporting").

### US-17 Chain reconciliation (IS-17)
- **AC-17.1** Given an active culture whose C5 result for the order item is `cancelled`, When job `micro.reconcile_chain_status` runs (daily [CONV]), Then the culture becomes `cancelled` with reason `order_item_cancelled`; cultures with submitted versions are only flagged (`chain_cancelled = true`).
- **AC-17.2** The detail page shows the live C5 status (`LabPort.getOrderResults`, scope `all_visible`) when the viewer holds `lab.result.read`.

## 8. Success metrics

| Metric | Target | Source |
|---|---|---|
| Reported AST rows without `(category_code, standard, standard_version)` | 0 (enforced by guard + CHECK) | final guard (AC-10.2) + snapshot JSON Schema (ajv, 05-SCHEMA §6) + CHECKs `ast_results__category_needs_std__ck` / `__category_needs_value__ck` (review m#32: no nightly job) |
| Duplicate cultures per `(order_item, specimen)` | 0 | unique key |
| Instrument records left `pending_match`/`needs_mapping` > 24 h | tracked; alert > 50 per tenant [CONV] | `lims_micro_instrument_records_open` |
| Time from final AST entry to final submission | reported (no target; lab KPI) | report_versions vs ast_results timestamps |
| p95 latency of `recordAstResults` (60 entries) | ≤ 300 ms [CONV] | 02-TRD §10 |
| Breakpoint values shipped by the LIMS provider | 0 | CI grep (AC-07.7) |

## 9. Phase

Phase 2 (04 §12). Wave 2 (01 §1). Depends only on C0 contracts + fakes; C5's real `submitModuleResult` and C6's renderer section are integration-gate dependencies, not build dependencies.

## 10. Dependencies (contracts only)

| Contract | Use | Until real |
|---|---|---|
| Event `lab.specimen.status_changed.v1` (C5) | create/cancel cultures (A4) | fake events from `packages/fakes` |
| Event `instruments.result.received.v1` (C7) | organism/AST records | synthetic events |
| `LabPort.getOrderResults`, `submitModuleResult` (C5) | item → test; chain status; hand-off | `LabPort` fake (seeded micro order item — 03-IC §4.5) |
| `LabPort.lookupSpecimens` (CR-C10-003) | barcode → specimen for instrument records; barcode snapshot | fake; default = manual matching |
| `CatalogPort.getTest` (C3) | `workflowType`, test name, specimen types | fake (seeded microbiology test — 03-IC §4.2) |
| `IdentityPort.assertRole`, `getActor`, `getTenantSettings` (C2) | authz, permission hints, timezone, `retention.rawInstrumentYears` | fake |
| `ctx.core.memberships.list`, `ctx.core.user` (C0, 08 A17 D-47) | staff display names | core fake |
| C5 HTTP `lookupSpecimenByBarcode`, `getSpecimen`, `listLabCodedSet(amendment_reasons)`; C4 HTTP `getPatient`; C2 HTTP `listCentres` (`identity.centre.read`, 08 A13 D-16) | BFF-only display data | Prism/MSW mocks |
| Core upload/storage API `ctx.uploads`/`ctx.storage` (08 §4.13; CR-C10-008 merged into CR-C2-011) + bucket `micro-imports` | breakpoint CSV | local fake storage |
| `micro.v_pub_report_content` consumers C6, C14 | — | — |

## 11. Blocked and unverified items (build against the default)

| Item | Default built meanwhile |
|---|---|
| **B2** ID/AST system model and official interface manual (VITEK BCI payload UNVERIFIED — 01 §2.3, §3.2; 04 N8; Autobio also sells an ID/AST line) | C10 consumes the generic `organism_id`/`ast` record shape of 03-IC §3.14 only; C7 driver requirements in CR-C10-007; manual entry covers every workflow |
| CLSI M100 specimen-site breakpoint dimension (04 L24 UNVERIFIED) | `specimen_site_code` kept in the lookup key (nullable = any site) |
| CLSI M100 text not opened; category list VERIFIED from the CLSI blog only (04 D14) | categories are data (global coded set), extendable by seed CR |
| Licensing terms of CLSI/EUCAST tables for redistribution (01 §2.3 cites licensing burden; EUCAST terms not researched → UNVERIFIED) | no values shipped; import requires a licence attestation by the tenant |
| SNOMED CT licensing for Nepal (UNVERIFIED — 01 §2.4) | local dictionary; optional concept-id field left empty |
| Micro volume per lab (01 §7 question 6 unanswered) | capacity ASSUMPTION in 02-TRD §10 |
| B15 legal retention | clinical rows never deleted; `micro.instrument_records` is class E and is purged `TenantSettings.retention.rawInstrumentYears` (default 1, floor 1 — 04 I8) after it becomes `applied`/`ignored`, except rows referenced by an AST row (08 A17 D-65, D-42) |
| B3 test list | synthetic micro test from `packages/test-fixtures` |
