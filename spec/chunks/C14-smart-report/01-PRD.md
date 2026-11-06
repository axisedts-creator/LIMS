# C14 Smart Report — 01 Product Requirements (PRD)

Status: DECISION, 2026-11-06. Chunk C14, Phase 2–3 (04 §12: "smart report (rules-based) starts (2–3)"; "optional LLM smart-report fluency layer" = Phase 3). Module `smartreport` (Postgres schema, API module, worker jobs, staff web feature) plus the renderer section templates in `services/renderer/templates/smart/` (01-CM §3).

Precedence: `research/00` > `research/04` > `program/03-INTERFACE-CATALOG.md` (03-IC) > `program/01`/`02` > this file. Contract gaps are raised as CRs in `02-TRD.md` §15 ("Change requests raised") and designed here as if accepted, marked **(CR-C14-00n)**.

Labels: **DECISION** = engineering choice made in this document set (change by CR). **[CONV]** = value chosen here with no external fact behind it. **UNVERIFIED** / **BLOCKED (B#)** as in 04. Short references: 01-CM = `program/01-CHUNK-MAP.md`, 02-CV = `program/02-CONVENTIONS.md`, 03-IC = interface catalog, R01 = `research/01-features-workflow.md`.

All examples are synthetic (00 §7.5; 02-CV §11.2). No name, registration number or value from the client's sample PDFs (Metro Labs report or the Healthians sample) appears in this document set.

---

## 1. Purpose

The client's own product formula ends with "+ Smart AI report" (00 §1 header note), and wishlist items 5, 8 and 12 ask for a smart report "as per provided sample" in the website and the app (00 §3). The sample is a Healthians Smart Report 3.0 (00 §5).

C14 builds a **patient-friendly summary layer** on top of approved results. It never replaces the clinical report (06-GLOSSARY "Smart report"). Per 04 R8 and R01 §5.2 it is:
- **rules-based** — every number, status and analyte name comes from approved structured data (results, flags, reference-range snapshots, history);
- built only from a **pathologist-approved, versioned template library** — every sentence a patient reads was written or approved by the tenant's named pathologist (B14); nothing is generated freely;
- **non-diagnostic**, with mandatory disclaimers and no product promotion (supplement upsell excluded — 04 R8, 01-CM §2 DROP list);
- optionally polished by an **LLM fluency layer** that may only rephrase approved text, runs only on a self-hosted model in Nepal, is off by default and needs founder approval (04 R8, §11, B11; Phase 3).

C14 owns `SmartReportPort` (03-IC §4.10). C6 calls it during report assembly and renders the result through C14's section templates. C16 (patient app) does **not** call it: patient, portal and partner readers get the approved summary only from the snapshot C6 stores on the report version, via `ReportingPort` (08 A2.3). C14 consumes `lab.result.approved.v1` and `lab.result.amended.v1` so that a summary built on superseded results is never shown (03-IC §3.10, §3.11). C14 produces no events.

## 2. Users and roles

Permission codes are verbatim from 03-IC §11. Codes marked **(CR)** are requested in CR-C14-003.

| Role (default) | What they do in C14 | Permissions |
|---|---|---|
| `pathologist` (the tenant's named smart-report owner — B14) | Author and approve the template library; review, approve or reject each patient summary; request/accept LLM rephrasing (Phase 3) | `smartreport.template.manage` (CR), `smartreport.template.approve` (privileged), `smartreport.summary.read`, `smartreport.summary.approve` (CR, privileged), `lab.result.read` (C5, for preview against a real order) |
| `lab_manager` | Author library drafts (groups, analyte mapping, rules, blocks); cannot approve | `smartreport.template.manage` (CR), `lab.result.read` |
| `front_desk` | See whether a summary exists and its status for an order (to answer patients; to trigger C6 Regenerate) | `smartreport.summary.read` |
| `tenant_admin` | Turns the tenant feature on/off (C2 screen, flag `smart_report`, CR-C14-005). Not a C14 permission | `identity.settings.manage` (C2) |
| Platform admin (the LIMS provider) | Enables the LLM flag `smart_report_llm` after founder approval (C2 registry: `settable_by platform`, `requires_founder_approval`) | C2 platform permissions |
| System actor (`smartreport` worker) | Event consumers, pre-build of draft summaries, LLM rephrase task (Phase 3) | worker manifest: `lab.result.read`, `frontdesk.order.read` |
| Caller module actors | C6 assembly (system actor) and staff paths call `SmartReportPort.buildSummary` in-process; patient/portal/partner actors never call it (08 A2.3) | port rules in 02-TRD §7.1 |

## 3. Problems this chunk solves

1. The client wants a "Smart AI report" like the Healthians sample (00 §1, §3 items 5/8/12, §5), but a diagnostic lab must not let software invent medical statements, and must not upsell products from a patient's abnormal flags (R01 §5.2 "Supplement upsell"; 04 R8).
2. Patients struggle to read a 20-page classical report (the Metro Labs sample is 22 pages — 00 §4); they need "what is out of range, which body systems are fine, what should I discuss with my doctor".
3. Every patient-facing sentence must be traceable to a pathologist's approval, with versions, so that a complaint can be answered with "this exact text, approved by Dr X on date Y" (B14; REQ-SEC-096).
4. When a result is amended (04 R1), any summary built on the old value must stop being shown immediately and a new summary must be produced.
5. Data and processing stay in Nepal (00 §7.1); an LLM must not be a foreign API without founder approval (04 §11, B11).

## 4. Healthians sample sections (00 §5): kept / changed / dropped

The Healthians official section list is UNVERIFIED (R01 §5.1); the observed sample in 00 §5 is the spec basis. Prior art used only for the verified parts: CrelioHealth Smart Reports shows a score out of 100 labelled "Fair", "4 of 7 health areas in range", per-result In range / Borderline / Out of range, a trends page (only HbA1c spans 4 visits; others 2), "General guidance only" recommendations, and human review of AI content (R01 §5.1, verified Pass 1). Dr Lal PathLabs shows organ/profile groups, diet do's/don'ts and follow-up intervals (R01 §5.1, verified).

| # | Observed section (00 §5) | Verdict | What C14 does and why |
|---|---|---|---|
| 1 | Cover: brand, booking ID, NABL/CAP badges, QR "credibility check … with machine data" | **Changed → not C14** | The report cover, letterhead, branding and QR verify belong to C6 (C6 IS-03, QR 04 R3). Accreditation badges appear only if the tenant puts them in its own branding (C2/C6). The claim "credibility check with machine data" is **dropped**: the QR proves report authenticity only (04 R3). |
| 2a | Health Score "NN out of 100, calculated from test reports" | **Kept, changed** | Transparent, published formula `hs-1` (§US-09); labelled "not a diagnosis"; shown only when ≥ `min_groups_scored` body systems were measured; formula explanation printed with it (R01 §5.2 "publish the formula"). |
| 2b | 10 organ/parameter tiles with key value + status ("Everything looks good" / "Concern") | **Kept, changed** | One tile per **measured** organ group (analyte → group mapping is library data linked to catalog analytes). Tile shows group name + status word (In range / Borderline / Out of range / Critical — fixed wording, §US-18). No fixed count of tiles; no tile for an unmeasured group. |
| 2c | Vital parameter tiles | **Dropped unless data exists** (DECISION) | No chunk captures vitals (height, weight, BMI, BP) in v1. A vitals tile appears only if the tenant catalogs such a measurement as an analyte and maps it to a group, and an approved result exists. No "No Data" padding. |
| 3a | Narrative patient summary | **Changed** | Rules mode prints no free narrative. The list of findings + advice blocks carries the content. Phase 3 LLM layer may rephrase approved blocks for fluency only (§US-20). |
| 3b | "Summary of Deranged Parameters" grouped | **Kept** | Every non-in-range mapped result, grouped by organ group, each with a pathologist-written sentence keyed by (analyte or group, direction, severity) (R01 §5.2). |
| 3c | "Suggestions for Improvement" (diet, activity, hydration, monitoring) | **Kept as advice blocks** | Advice template blocks keyed by findings; de-duplicated; capped (R01 §5.2). |
| 4 | Department-wise classical results pages with interpretations and signature | **Not C14** | These are the clinical report pages (C6 assembly from C5 approved results and comments). C14 never alters them. |
| 5a | BMI/height/weight tiles; lifestyle data tiles (mostly "No Data") | **Dropped** (DECISION) | No data source; "No Data" tiles are padding. |
| 5b | Nutrition do's/don'ts; suggested lifestyle | **Kept as advice blocks** | Same mechanism as 3c. |
| 5c | "Suggested Future Tests" with re-test intervals | **Kept, changed** | Rule table: finding → suggested catalog test + interval. Intervals are **tenant-authored data**, never hard-coded; rules visible and pathologist-approved because this is the conflict-of-interest hot zone (R01 §5.2). No prices, no booking links. |
| 6 | Wellness pages (activity, balanced diet, stress) | **Dropped as standalone pages** (DECISION) | Generic wellness text not triggered by a finding is padding; findings-triggered advice covers the need. |
| 7 | Supplement Suggestions with order hotline | **Dropped** | 04 R8; 01-CM §2 DROP list; R01 §5.2 (conflict of interest, NMC concerns). Enforced by the wording validator (§US-18). |
| 8 | App/services promo pages | **Dropped** (DECISION) | Same reason as 7; CrelioHealth's "Promote Lab Services" pages (R01 §5.1) are likewise excluded. |
| + | Trends across previous visits (not in the Healthians list; present in CrelioHealth prior art) | **Kept** | Up to `trend_max_points` approved values of the same analyte and unit (default 4 points [CONV]), with improved / worsened / stable from a published rule (§US-13). |

## 5. Scope

### 5.1 In scope (mapped to client baseline)

| ID | Item | Client baseline | Notes |
|---|---|---|---|
| IS-01 | `SmartReportPort.buildSummary` implementation (03-IC §4.10) returning structured `SmartSummary` | 00 §1 "Smart AI report"; §3 items 5, 8, 12 | + display fields (CR-C14-001), actor rules (CR-C14-006) |
| IS-02 | Template library: versioned (draft → in review → approved → retired), one active approved version per tenant | 00 §3 item 8 "as per provided sample"; B14 | starter draft shipped; nothing used before approval |
| IS-03 | Template blocks (deranged, advice, follow-up, disclaimer, score explanation) in English and/or Devanagari (Nepali) | 00 §5 sections 3, 5; 02-CV §13 | NFC; no digits; no URLs; deny-list check |
| IS-04 | Organ groups (global coded set) + tenant analyte → group mapping (catalog-linked) + group display names/weights | 00 §5 section 2 tiles | FK to `catalog.analytes` |
| IS-05 | Per-result band status (in range / borderline / out of range / critical) from C5 flags and range snapshots | 00 §5 section 2; R01 §5.2 | borderline off by default |
| IS-06 | Health score formula `hs-1` (non-diagnostic) | 00 §5 section 2 | §US-09 |
| IS-07 | Deranged-parameter summary | 00 §5 section 3 | |
| IS-08 | Advice blocks | 00 §5 sections 3, 5 | |
| IS-09 | Suggested follow-up tests (rule table, tenant-authored intervals) | 00 §5 section 5 | |
| IS-10 | Trends across previous visits | 00 §3 item 3 "with graphs"; 00 C7 (graphs for repeat patients) | needs `LabPort.getAnalyteHistory` (CR-C14-002) |
| IS-11 | Summary review queue; pathologist approve/reject per summary | 03-IC §4.10 invariant "approved only after a pathologist approves the summary" | |
| IS-12 | Supersede on `lab.result.approved.v1` / `lab.result.amended.v1`; never serve a summary built on superseded results | 04 R1; 03-IC §3.10/3.11 | |
| IS-13 | Renderer section templates `services/renderer/templates/smart/` implementing C6's `SmartSectionRenderer` | 00 §3 item 8 (website/app) | C6 renders PDF; C16 renders app view from structured content |
| IS-14 | Wording rules: mandatory disclaimer, fixed non-diagnostic notice, deny-list (global + tenant), no promotion | 04 R8 | |
| IS-15 | Library preview against a synthetic fixture or a real order (not stored) | B14 workflow | |
| IS-16 | Optional LLM fluency layer: interface, guardrails, validator, logging; disabled by default; model BLOCKED | 00 "Smart **AI** report"; 04 R8; B11 | Phase 3 |
| IS-17 | Staff web screens (queue, review, library editor, wording terms) + in-app help + user manual pages | 05-DoD §3 item 8 | |

### 5.2 Out of scope

| Item | Owner / reason |
|---|---|
| Clinical report pages, report versions, release, delivery, portal PDF download, QR verify | C6 |
| Regenerating a report version after a summary is approved | C6 (manual Regenerate, reason `smart_summary_added` — C6 03-APP-FLOW E23) |
| Patient app screens | C16 (C14 provides the display contract, 04-UI-UX §5) |
| Result values, flags, reference ranges, amendments | C5 / C3 (C14 never computes a flag) |
| Test catalogue, analyte definitions | C3 |
| Tenant feature switch UI | C2 (flag registry, CR-C14-005) |
| Supplement / product suggestions, promo pages, booking or price links inside the summary | DROP (04 R8; §4 rows 7–8) |
| Vitals capture (height/weight/BP) | not in any v1 chunk; no tiles without data (§4 row 2c) |
| Free-text LLM generation, diagnosis wording, translation by LLM | excluded (04 R8; R01 §5.3); Nepali text is authored by humans |
| A foreign LLM API | needs founder approval (B11, 04 §11); not built |
| Auto-generated summaries reaching patients without pathologist approval | forbidden (03-IC §4.10 invariant; B14) |
| Events announcing an approved summary | not in 03-IC; foreseen CR (06 §5) |

## 6. User stories and acceptance criteria

Every criterion is a test (05-DoD §2). Synthetic data: tenant `tenant_a` "Synthetic Lab Alpha", tenant `tenant_b` "Synthetic Lab Beta", patient "Test Patient 0042", order with registration no. `0001SY000001`, centre `C000000099`. Analytes (synthetic catalog): `HGB`, `WBC`, `PLT` (group `blood_counts`), `ALT`, `AST` (group `liver`), `CREAT` (group `kidney`), `GLUF` (group `glucose`).

### US-01 Tenant feature switch
1. **AC-01.1** Given `featureFlags.smart_report = false` for `tenant_a` (CR-C14-005), when C6 calls `buildSummary({orderId, version: 1})`, then `smartreport.feature_disabled` is thrown and no row is written in `smartreport`.
2. **AC-01.2** Given the flag is `true` and no library version is `approved`, when `buildSummary` is called for an order with approved results, then `smartreport.template_not_approved` is thrown.
3. **AC-01.3** Given the flag is `false`, when any `POST /v1/smartreport/orders/{order_id}/summaries` is called, then `403 smartreport.feature_disabled`. Library endpoints stay usable (labs prepare the library before switching on).

### US-02 Start a library draft
1. **AC-02.1** Given no library version exists, when a `pathologist` calls `createSmartLibraryVersion` with `source: "starter"`, then version 1 is created with `status = draft`, the starter blocks (02-TRD §9.3), one group setting per active organ group, no analyte mappings and no follow-up rules.
2. **AC-02.2** Given version 3 is `approved`, when `createSmartLibraryVersion` with `source: "clone_active"` is called, then version 4 `draft` contains copies of every active block, rule, mapping and group setting of version 3 with new ids, and `source_version_id` = version 3.
3. **AC-02.3** Given a version in `draft` or `in_review` already exists, when another create is called, then `409 smartreport.library_invalid_transition` (CR-C14-004).
4. **AC-02.4** Given the same `Idempotency-Key` is replayed, then the same version is returned with `Idempotent-Replayed: true`.
5. **AC-02.5** Given a fresh starter draft, when `validateSmartLibraryVersion` runs, then the only error is `no_mappings` (V14); in particular the starter score explanation passes the global deny term `diagnos` (08 A19 D-108).

### US-03 Author template blocks
1. **AC-03.1** Given a draft library with `language = en`, when a block `deranged.alt.high` of kind `deranged` is created with text "{analyte_name} is above the reference range of your laboratory.", then it is stored NFC-normalised and returned with `placeholders = ["analyte_name"]`.
2. **AC-03.2** Given a text longer than 600 characters [CONV], then `400 common.validation_failed` with `errors[0].path = "/text_en"`.
3. **AC-03.3** Given a block text containing a digit (`0–9` or Devanagari `०–९`), when the library is validated, then issue `digits_not_allowed` is reported for that block (03-IC §4.10 invariant "never includes … a number not present in input").
4. **AC-03.4** Given a block text containing `{dose}` (not an allowed placeholder for its kind, 02-TRD §9.4), then validation reports `placeholder_unknown`.
5. **AC-03.5** Given a draft with `language = ne` and a block with `text_ne` in Devanagari, when rendered in preview, then the Devanagari text is returned unchanged (NFC) and the fragment marks it `lang="ne"`.
6. **AC-03.6** Given the library version is `in_review` or `approved`, when any block create/replace/delete is attempted, then `409 smartreport.library_invalid_transition` and the DB trigger also rejects a direct UPDATE (`immutable_row`).
7. **AC-03.7** Given a draft, when a block, rule or analyte mapping is removed (`DELETE` #8/#12/#15), then the row is deactivated (`is_active = false`), never deleted (no DELETE grant — 02-CV §5.6; 08 A17 P-18(a)); it disappears from lists, validation, the engine and clones, and a new block with the same `block_key` (or a new mapping for the same analyte) can be created.

### US-04 Map analytes to organ groups
1. **AC-04.1** Given a draft, when `putSmartAnalyteGroup` maps analyte `ALT` to `liver` with `include_in_score = true`, then the mapping is stored with a composite FK to `catalog.analytes (tenant_id, id)`.
2. **AC-04.2** Given an analyte id of `tenant_b`, when `tenant_a` maps it, then `404 common.not_found` (FK + RLS; cross-tenant probe).
3. **AC-04.3** Given `ALT` is already mapped to `liver`, when it is mapped to `kidney`, then the mapping is replaced (one group per analyte per version — DECISION).
4. **AC-04.4** Given group `iron` has `is_shown = false`, then no `iron` tile appears and its members are not scored, but its deranged members are still listed.

### US-05 Rules (deranged, advice, follow-up)
1. **AC-05.1** Given a follow-up rule without `interval_days`, then `400 common.validation_failed` (`/interval_days` required for `rule_kind = followup`). There is no default interval anywhere in code (DECISION: intervals are tenant data).
2. **AC-05.2** Given a follow-up rule whose `suggested_test_id` is inactive in the catalog, when the library is validated, then issue `followup_test_inactive`.
3. **AC-05.3** Given a follow-up rule with `trigger_kind = all_in_range`, then `400 common.validation_failed` (follow-ups only on findings — conflict-of-interest guard, 07-SECURITY AB-3).
4. **AC-05.4** Given a rule references a block of a different kind, then `400 common.validation_failed` (`/block_id` kind mismatch).

### US-06 Validate and submit
1. **AC-06.1** Given a draft without a `disclaimer` block, when `validateSmartLibraryVersion` runs, then `valid = false` with issue `disclaimer_missing`.
2. **AC-06.2** Given `score_enabled = true` and no `score_explanation` block, then issue `score_explanation_missing`.
3. **AC-06.3** Given no `deranged` rule with `trigger_kind = any` for one of the directions `low`, `high`, `abnormal`, then issue `generic_deranged_missing` naming the direction.
4. **AC-06.4** Given a block containing the global deny term "supplement", then issue `deny_term` with the block key and the term.
5. **AC-06.5** Given a valid draft, when `submitSmartLibraryVersion` is called with the current `If-Match`, then status becomes `in_review`, `content_sha256` is stored and a `library_reviews` row `submitted` is written. Given an invalid draft, then `422 smartreport.library_invalid` with the issues in `errors[]`.

### US-07 Approve or return a library version
1. **AC-07.1** Given version 4 `in_review` and version 3 `approved`, when a `pathologist` at aal2 calls `approveSmartLibraryVersion` with `attestation: true`, then version 4 becomes `approved` (with `approved_by_membership_id`, `approved_at`), version 3 becomes `retired` in the same transaction, and a `library_reviews` row is written.
2. **AC-07.2** Given the caller is at aal1, then `403 auth.mfa_required`. Given a `lab_manager`, then `403 auth.forbidden`.
3. **AC-07.3** Given the content changed after submit (content hash differs), then `409 smartreport.library_invalid_transition` (cannot happen through the API; the test edits the DB as owner).
4. **AC-07.4** Given `returnSmartLibraryVersion` with a comment, then status returns to `draft` and the comment is stored.
5. **AC-07.5** Given summaries built with version 3 exist, when version 4 is approved, then those summaries are unchanged (pinned) and new approved sets use version 4.

### US-08 Build a summary through the port
1. **AC-08.1** Given an order whose approved results are `HGB` (flag `L`), `WBC` (`N`), `PLT` (`N`), `ALT` (`N`), `AST` (`N`), `CREAT` (`N`), all mapped, when `buildSummary({orderId, version: 1})` is called by the C6 system actor, then a summary row `draft` is created and returned with `status = "draft"`, `reportVersionNo = 1`, panels `blood_counts: out_of_range`, `liver: in_range`, `kidney: in_range`, and one deranged entry for `HGB` direction `low`, severity `out_of_range`.
2. **AC-08.2** Given the same call again (same approved set, same library), then the same `summaryId` and identical content are returned (determinism, 03-IC §4.10 contract test 2), and a second binding row `report_version_no = 2` is added only when `version = 2`.
3. **AC-08.3** Given an order with no approved results, then `smartreport.no_eligible_results`.
4. **AC-08.4** Given approved results of which fewer than `min_mapped_results` (library parameter, default 3 [CONV]) are mapped in the library, then `smartreport.no_eligible_results` (nothing worth summarising; also keeps the pathologist queue to package-like orders) and the staff preview reports `unmapped_result_count`.
5. **AC-08.5** Given an order of `tenant_b`, when called in `tenant_a`'s context, then `common.not_found`.
6. **AC-08.6** Every `deranged[].resultId` and every `panels[].resultIds[]` element is a result id present in `LabPort.getOrderResults({scope: 'approved'})` (contract test 3).
7. **AC-08.7** Given a result whose flag is absent and that has no reference-range snapshot, then it is excluded from tiles, score and deranged list.

### US-09 Health score (non-diagnostic)
1. **AC-09.1** Given library defaults (credits in range 10000 bp, borderline 5000, out 0, critical 0; equal weights 1; `min_groups_scored = 2`) with `borderline_fraction_bp` set to 500 by the author, and groups `blood_counts` (in, in, out), `liver` (in, borderline), `kidney` (in), when built, then subscores are 6667, 7500, 10000 bp and `healthScore = { value: 81, band: "good", formulaVersion: "hs-1", panelsScored: 3 }` (golden vector G-01 in 02-TRD §9.6).
2. **AC-09.2** Given any scored member is `critical` and `critical_forces_needs_attention = true`, then `band = "needs_attention"` regardless of value.
3. **AC-09.3** Given only one group is measured, then `healthScore` is omitted (not 0, not 100).
4. **AC-09.4** Given `score_enabled = false`, then `healthScore` is omitted and no score explanation is printed.
5. **AC-09.5** The renderer prints the score with the fixed label "Health score (not a diagnosis)" and the approved `score_explanation` text (CR-C14-001 `healthScore.explanationText`).

### US-10 Deranged-parameter summary
1. **AC-10.1** Given `HGB` flag `L` and an analyte rule for `HGB`/`low` and a generic `any`/`low` rule, then the analyte rule's block text is used, with `{analyte_name}` filled from the catalog print name.
2. **AC-10.2** Given flag `HH`, then severity `critical`, direction `high`.
3. **AC-10.3** Given flag `A` (abnormal non-numeric), then direction `abnormal`, severity `out_of_range`.
4. **AC-10.4** Entries are ordered critical → out of range → borderline, then by group `sort_order`, then catalog analyte `sortOrder`, then `resultId`.
5. **AC-10.5** Given `borderline_fraction_bp = 500` and `HGB` in range but within 5 % of the range width from the low limit, then a `borderline` entry with direction `low` is listed; with the default 0 no borderline entry exists.

### US-11 Advice
1. **AC-11.1** Given two deranged entries whose rules both point to advice block `advice.iron_rich_foods`, then the block appears once.
2. **AC-11.2** Given `advice_max_blocks = 2` and four matching advice blocks, then the two with the highest severity, then lowest priority number, are returned.
3. **AC-11.3** Given no deranged entries and an `all_in_range` advice rule, then exactly that advice block is returned.

### US-12 Suggested follow-up tests
1. **AC-12.1** Given rule `GLUF high ≥ out_of_range → test HBA1C, interval_days 90` (tenant-authored, synthetic) and `GLUF` flag `H`, then `followUps = [{ ruleId, suggestedTestCode: "HBA1C", intervalDays: 90, text }]`.
2. **AC-12.2** Given the suggested test was deactivated after library approval, then the suggestion is skipped at build and `lims_smartreport_followup_skipped_total` increments.
3. **AC-12.3** Given two rules suggest the same test with 90 and 180 days, then one suggestion with 90 days is returned.
4. **AC-12.4** No follow-up text, field or rendering contains a price, a booking link or a phone number (validator + renderer test).

### US-13 Trends across previous visits
1. **AC-13.1** Given `GLUF` is `trend_enabled`, the patient has two earlier approved `GLUF` results with the same unit within `trend_lookback_days`, then `trends` has one entry with three `pointResultIds` (oldest first) and points with values (CR-C14-001).
2. **AC-13.2** Given the previous value is outside the range and the current is inside, then `direction = "improved"`; the reverse gives `"worsened"`; both inside gives `"stable"`.
3. **AC-13.3** Given `|current − previous| ≤ |previous| × trend_stable_bp / 10000`, then `"stable"`.
4. **AC-13.4** Given earlier results in a different unit, then they are not used.
5. **AC-13.5** Given `LabPort.getAnalyteHistory` is not available (CR-C14-002 not merged), then `trends = []` and the summary still builds.
6. **AC-13.6** History never contains another patient's or another tenant's results (port contract + probe).

### US-14 Review queue and per-summary approval
1. **AC-14.1** Given three draft summaries, when a pathologist opens the queue, then they are listed oldest first with status, centre, built time, deranged and critical counts; a centre-scoped `front_desk` user sees only their centre's rows.
2. **AC-14.2** Given a draft whose approved set is still current, when `approveSmartSummary` is called at aal2 with `attestation: true` and the current `If-Match`, then status becomes `approved`, `approved_by_membership_id` is set, a `summary_reviews` row is written, and later `buildSummary` calls return `status = "approved"` with `approvedAt`.
3. **AC-14.3** Given a newer result approval or an amendment changed the order's approved set after the draft was built, when approve is called, then the draft is superseded and `409 smartreport.summary_superseded` is returned (CR-C14-004).
4. **AC-14.4** Given `rejectSmartSummary` with reason `wording_problem`, then status `rejected`; `buildSummary` returns `status = "draft"` for it (CR-C14-006), so C6 omits the section.
5. **AC-14.5** Given an approved summary, when approve or reject is called again, then `409 smartreport.summary_invalid_transition`.
6. **AC-14.6** There is no bulk approval endpoint (DECISION: every summary is reviewed individually).
7. **AC-14.7** Given an approved summary that was later superseded by an amendment (AC-15.1), when SR-02 opens it through `getSmartSummary`, then the response carries `reviews[]` oldest first — `{action: approved, actor_display_name: <approver>, at}` then `{action: superseded, at}` with no actor (system) — each item limited to `action`, `actor_display_name`, `reason_code`, `at` (no `comment`); a rejected summary's item carries its `reason_code`; and SR-02 shows them in the History timeline; no other endpoint is called (08 A22.1).

### US-15 Superseded results are never shown
1. **AC-15.1** Given an approved summary built on `HGB` version 1, when `lab.result.amended.v1` (HGB, new_version_no 2) is consumed, then the summary becomes `superseded` (`superseded_reason = results_changed`) in the consumer transaction.
2. **AC-15.2** Given the same event delivered twice, then the second delivery is a no-op (inbox dedupe).
3. **AC-15.3** Given `lab.result.approved.v1` for a result already contained in the live summary (event arrived late), then nothing changes.
4. **AC-15.4** Given the amended event has not yet been consumed, when `buildSummary` is called, then it recomputes the approved-set hash from LabPort, finds no live summary for that hash, supersedes the old one and builds a new draft. A summary built on superseded results is never returned (both paths tested).
5. **AC-15.5** Given a new draft is built after a supersede, then a pre-build job is enqueued so the pathologist queue shows it (when `LIMS_SMARTREPORT_PREBUILD_ENABLED`).

### US-16 Rendered section in the PDF (C6)
1. **AC-16.1** Given an approved summary, when C6 calls `smartSectionRenderer.renderSections({summary, calendarDisplay, timezone})`, then the fragment contains, in order: section title, fixed non-diagnostic notice, health score (if present), tiles, deranged list, trends table, advice, follow-ups, tenant disclaimer — and no `<script>`, no `<img>`, no `style` attribute, no URL (snapshot test).
2. **AC-16.2** Given block text containing `<b>` or `&`, then it is escaped as text.
3. **AC-16.3** Given a `draft` summary is passed by mistake, then the renderer returns an empty string and logs `smart_render_not_approved` (defence in depth; C6 already filters).

### US-17 Patient-facing read (C16 / portal / partner) — via C6 snapshot (08 A2.3)
1. **AC-17.1** Given patient, portal, partner or device claims, then every `smartreport.*` table returns zero rows (no non-staff RLS policy exists; policies admit only `user`/`system` — 08 A19 D-109) and these actors make no `SmartReportPort` call (fake asserts zero calls).
2. **AC-17.2** Given an approved summary attached by C6 at first assembly or at Regenerate (reason `smart_summary_added`) — 08 A4.4 — then the non-staff reader receives that approved `SmartSummary` snapshot from the report version through `ReportingPort` — never a `draft`.
3. **AC-17.3** Given no snapshot on the report version (none attached, or superseded and not re-attached), then the C16 app shows "not available yet" (C16's wording); the C6 portal hides its "Health summary" section (08 A4.7).
4. **AC-17.4** Given a summary approved before the report's first assembly, then that first report version carries the snapshot (08 A4.4).

### US-18 Wording rules, disclaimers, no promotion
1. **AC-18.1** Every rendered summary contains the fixed notice (04-UI-UX §4.3) and the approved tenant disclaimer text; a library without a disclaimer cannot be submitted (AC-06.1).
2. **AC-18.2** Global deny terms (02-TRD §9.5) cannot be deactivated by a tenant; tenant terms can be added and deactivated.
3. **AC-18.3** Deny-term matching ignores case, NFC differences and zero-width characters (U+200B–U+200D, U+FEFF).
4. **AC-18.4** Block texts containing `http`, `www.`, `@` or a phone-number shape are rejected at validation (`contact_or_link_not_allowed`).

### US-19 Preview
1. **AC-19.1** Given a draft and `fixture_code = "synthetic_basic"`, when `previewSmartLibraryVersion` is called, then a summary DTO is returned, nothing is stored, and placeholders are filled from the synthetic fixture.
2. **AC-19.2** Given `order_id` and a caller without `lab.result.read`, then `403 auth.forbidden`. With it, an access-log entry `ctx.audit.access({action: 'smart_summary.view', entityType: 'smart_summary_preview', …})` is written (08 §4.4).

### US-20 Optional LLM fluency layer (Phase 3, off by default)
1. **AC-20.1** Given `featureFlags.smart_report_llm = false` (default), when `requestSmartLlmRephrase` is called, then `403 smartreport.feature_disabled` and no network call is made (outbound-call spy).
2. **AC-20.2** Given the flag is on (C2 requires `approval_ref` — founder approval) and the endpoint host is in `LIMS_SMARTREPORT_LLM_ALLOWED_HOSTS`, when a rephrase runs, then the request contains only approved block texts with **unfilled** placeholders (no patient values, no names), and an `llm_runs` row stores input hash, output, validator report, prompt version and configured model reference.
3. **AC-20.3** Given an output that adds a digit, drops or adds a placeholder, contains a deny term, or contains a content word absent from the input and from the bundled function-word list, then that item fails validation and the approved template text is kept (`smartreport.validator_failed` recorded on the run, not thrown to the reviewer).
4. **AC-20.4** Given validated LLM text, when the pathologist approves with `use_llm_text: true` after seeing the side-by-side diff, then the port returns the LLM text; with `false` (default) the template text.
5. **AC-20.5** Given the endpoint host is not on the allowlist, then the worker refuses to start the LLM client and alerts `SmartLlmEndpointNotAllowed`.

### US-21 Audit
1. **AC-21.1** Library approvals, returns, summary approvals and rejections each create an append-only review row and an `audit.audit_log` entry (C0 trigger).
2. **AC-21.2** Viewing a summary detail writes `ctx.audit.access({action: 'smart_summary.view', entityType: 'smart_summary', entityId, outcome})` (action code registered in 08 §4.4).
3. **AC-21.3** No log line contains block text, filled text, values, patient names or registration numbers (log-scan test, 02-CV §9.2).

## 7. Success metrics

| Metric | Target | Measured by |
|---|---|---|
| Summaries served built on superseded results | 0 (hard invariant) | contract + integration tests with the consumer switched off (AC-15.4); no nightly job (02-TRD §12) |
| Unapproved text in any released PDF smart section | 0 | renderer guard + C6 filter + E2E |
| `buildSummary` p95 | ≤ 300 ms (03-IC §4.10) | `lims_smartreport_build_duration_seconds` |
| Drafts approved within 24 h of build (feature-on tenants) | ≥ 90 % [CONV] | `lims_smartreport_draft_age_seconds` |
| LLM items passing the validator (Phase 3, if enabled) | reported, not gated | `lims_smartreport_llm_items_total{outcome}` |

## 8. Phase

- **Phase 2–3 (rules engine):** IS-01 … IS-15, IS-17.
- **Phase 3:** IS-16 (LLM layer). Interface, validator and fake are built in Phase 3 tasks only; the adapter to a concrete model server waits for the founder decision (BLOCKED, B11).
- Until C14 merges, C0's phase stub throws `smartreport.feature_disabled` (C0 02-TRD §9 phase stubs). C14's first module PR (T01) removes the stub and registers its own implementation returning the same result until `buildSummary` is built (08 A17 P-20).

## 9. Dependencies (contracts only)

| Dependency | What C14 uses | Until real |
|---|---|---|
| `LabPort` (C5) | `getOrderResults({scope: 'approved' | 'all_visible'})`; `getAnalyteHistory` (CR-C14-002, accepted in 08; C14 passes `includeLegacy: false`) | fake; trends empty until the method is merged |
| `FrontdeskPort` (C4) | C14 is a declared consumer by CR-C14-009 (08 A19 D-110). `getOrderSummary` (patient id, centre id, registration no.); `getPatientDemographicsBatch({purpose: 'lab_display'})` (existing purpose) for names in the review queue only (CR-C5-003, raised by C5; until merged, or for callers without `lab.worklist.read`/`lab.status_board.read`, the queue shows registration no. only). The summary build itself reads no demographics (DECISION: rules do not branch on age/sex in v1; ranges already carry age/sex via C5 snapshots) | fake |
| `CatalogPort` (C3) | `getTest` (analyte names/print names, decimals, sortOrder, test code for follow-ups) | fake |
| `IdentityPort` (C2) | `assertRole`, `getActor`, `getTenantSettings(['featureFlags','calendarDisplay','timezone'])` (CR-C2-008) | fake |
| Events | `lab.result.approved.v1`, `lab.result.amended.v1` (03-IC §3.10, §3.11) | fake producer in tests |
| C6 renderer contract | `SmartSectionRenderer` (C6 02-TRD §5.3); print classes `smart-*` (CR-C14-007) | local stylesheet fixture |
| C0 core | `ctx.db.tx`, `events` inbox wrapper, `app.enqueue_job`, `ctx.audit.access`, idempotency hook, `ctx.rateLimit` | C0 |
| UI kit | `@lims/ui` components (04-UI-UX §2); `TextDiff` (CR-C14-008, Phase 3) | — |

## 10. Blocked and unverified items (build the default meanwhile)

| Item | Status | Default built |
|---|---|---|
| Named pathologist owning templates (B14) | BLOCKED — client | Starter library ships as `draft`; no summary can be built until a user with `smartreport.template.approve` approves a version; per-summary approval also required |
| LLM model and serving software | BLOCKED/DECISION — founder (B11 for any foreign API; model choice not decided) | `LlmRephraser` interface + `DisabledRephraser` + test fake; no adapter; flag off |
| Foreign LLM API | BLOCKED — founder (B11, 04 §11) | Not used; endpoint host allowlist must name an internal Nepal host |
| Real test list / analytes (B3) | BLOCKED — client | Synthetic catalogue; analyte mapping done per tenant after import |
| Retention period (B15) | BLOCKED — counsel | Summaries follow tenant clinical retention (default 5 y); no purge in v1 |
| Privacy Regulation 2077 content (B16) | BLOCKED — counsel | Controls of 02-security; summary shown to the same audiences as the report |
| Healthians official section list | UNVERIFIED (R01 §5.1) | 00 §5 observed list is the basis (§4) |
| Nepali text of fixed notices | not provided (no verified translation) | Fixed notice is English; tenant authors the Nepali disclaimer block |
| Graphile Worker 0.18.0 `job_key` replacement semantics | UNVERIFIED here (C0 verifies) | Pre-build job is idempotent, so duplicates are harmless |
