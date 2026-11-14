# C3 Catalog & Pricing — 01 Product Requirements (PRD)

Status: DECISION draft, 2026-11-05. Chunk: **C3** · Module/schema: `catalog` · Phase **1** (04 §12: "roles, audit, masters; per-doctor/centre price lists + Excel import/export, credit-party billing; … urgent charge"). Inputs in precedence order: `research/00-scope-baseline.md` (00) → `research/04-consolidated-decisions.md` (04) → `program/03-INTERFACE-CATALOG.md` (03-IC) → `program/01-CHUNK-MAP.md` (01-CM) / `program/02-CONVENTIONS.md` (02-CV) → this set.

Labels: **VERIFIED / UNVERIFIED / DECISION / BLOCKED (B#) / ASSUMPTION** as in `00-README.md`. **[CONV]** = value chosen in this document (engineering choice, no external fact behind it).
Change requests raised by this chunk are written in full in `02-TRD.md` §15 (CR-C3-001 … CR-C3-006) and every design in this set assumes they are accepted. Where a CR is needed, the text says "(CR-C3-00n)".

---

## 1. Purpose

C3 is the lab's **master data for what can be ordered, how it is reported, and what it costs**. Every other Phase-1 chunk reads it:

- **C4** (front desk + billing) searches orderables by short name or package (00 A6), quick-adds referring doctors (00 A5), selects credit parties/affiliations (00 E2), and asks `CatalogPort.priceFor` for server-side prices, urgent surcharges (00 A10) and tax treatment (04 L14/L15/L25).
- **C5** (lab workflow) reads tests, analytes, units, decimals, methods, formulas (00 C4), ordinal/coded value sets (04 D14), versioned reference ranges and critical limits (04 D14; 01 §2.2), comment short-codes (00 C3), specimen types and containers (00 B1), TAT targets (data only).
- **C6** (reporting) reads department grouping, package → test → sub-heading → analyte structure, `METHOD :` text, "Specimen:" line and units as the Metro Labs report shows (00 §4), and referrer display data ("Referred By").
- **C7** (instruments) maps analyser codes to analytes through C3's data (`catalog.instrument_code_maps`, binding resolution X4) and `CatalogPort.mapInstrumentCode`.
- **C8** reads `catalog.v_pub_*` labels for MIS; **C13** reads partner price lists (Phase 2).

C3 writes no clinical or billing record. It owns no patient data. Its data is **class M (master data)** under 02-CV §5.2: never hard-deleted; clinically meaningful attributes (units, decimals, method, result type, formula, reference ranges, critical limits) and prices are **versioned, effective-dated rows**, so a result or invoice line can always be explained and re-rendered (04 D14; REQ-ARCH-036).

## 2. Users and roles

Permission codes are verbatim from 03-IC §11. Codes marked **(CR)** came from CR-C3-003 (accepted in 08; no interim grants). Since 08 A13 D-18, publishing an analyte version needs `catalog.reference_range.publish` **and** `catalog.test.manage`, and `catalog.instrument_code_map.manage` is privileged (aal2).

| Role (03-IC §11 default) | What they do in C3 | Permissions used |
|---|---|---|
| `lab_manager` | Maintains departments, specimen types, containers, methods, units, value sets, tests, analytes, formulas, panels/packages, comment codes, TAT targets; drafts and publishes reference ranges and critical limits; maintains instrument code maps (from C7's screens); runs catalog-master import/export | `catalog.test.read`, `catalog.test.manage`, `catalog.reference_range.publish` (CR, privileged), `catalog.instrument_code_map.manage` (privileged, 08 A13 D-18), `catalog.referrer.manage`, `catalog.referrer.read` (CR), `catalog.referrer.export` (CR, privileged) |
| `pathologist` | Reviews and publishes reference-range and critical-limit sets (clinical sign-off); cannot publish analyte versions alone (needs `catalog.test.manage` too, D-18) | `catalog.test.read`, `catalog.reference_range.publish` (CR, privileged) |
| `finance` | Price lists, price-list Excel import/export, credit parties/affiliations, urgent-surcharge rules, tax rules and tax types | `catalog.price_list.read`, `catalog.price_list.manage` (privileged → MFA, 04 A4), `catalog.test.read`, `catalog.referrer.read` (CR) |
| `tenant_admin` | Everything finance does on pricing; doctor master clean-up (verify, merge); referrer export | `catalog.price_list.manage`, `catalog.price_list.read`, `catalog.referrer.manage`, `catalog.referrer.read` (CR), `catalog.referrer.export` (CR), `catalog.test.read` |
| `front_desk` | Searches orderables, reads price lists, quick-adds a doctor at registration (C4 screen calls C3 HTTP) | `catalog.test.read`, `catalog.price_list.read`, `catalog.referrer.manage`, `catalog.referrer.read` (CR) |
| `lab_technologist` | Reads catalog (comment codes, tests) | `catalog.test.read` |
| system actors (C4/C5/C6/C7/… via ports) | Read through `CatalogPort` inside the caller's transaction | none of their own; the caller's permission governs the caller's endpoint |

Privileged permissions re-validate membership and need aal2 (04 A4; REQ-SEC-067; 03-IC §11).

## 3. Problems this chunk solves

1. **One page registration needs instant, correct prices** for a patient whose price depends on the referring doctor, hospital/credit party or collection centre (00 E3), with an urgent surcharge (00 A10) and correct tax treatment that is still BLOCKED with the auditor (04 L15, L25; B7). The client edits price lists in Excel today (00 E4).
2. **Results need definitions that never silently change.** A haemoglobin result printed last month must still show last month's reference range and unit. Reference ranges depend on sex and age (days for neonates, months for infants, years for adults) and sometimes specimen type or method (04 D14; 01 §2.2).
3. **The Metro Labs report structure must be reproducible from data** (00 §4): package → test (e.g. CBC) → sub-headings (RBC parameters, WBC parameters, Absolute counts, Platelet parameters, Reticulocyte parameters, Special parameters such as NLR, PLR, Mentzer index) → analyte lines with `METHOD : …` beneath each, a units column, a "Biological Ref Range" column that is sometimes text, and a "Specimen:" line at the end of each test.
4. **Calculated parameters** (NLR, PLR, Mentzer index, absolute counts, LDL) are formulas in the master, not code (01 §2.2; 06-GLOSSARY "Calculated parameter"), and must never form a cycle.
5. **Analysers speak their own codes** (B2): the mapping from instrument code to analyte (with unit conversion and flag map) is catalog data (X4).
6. **The real test list has not arrived** (BLOCKED B3, 00 §6 item 1). The catalog must be loadable from the client's Excel when it comes, without code changes (07-BLOCKERS B3: "Excel import (C3) loads the real list").

## 4. Scope

### 4.1 In scope (Phase 1)

| ID | Capability | Client baseline item (00) | Notes |
|---|---|---|---|
| IS-01 | Departments (code, name, report order, heading) | 00 §4 departments; F2 "income by department" | C8 reads `catalog.v_pub_department` |
| IS-02 | Specimen types (with "Specimen:" report label) and containers (additive, cap colour as display data) | 00 §4 "Specimen:" line; B1 barcode per sample | 06-GLOSSARY Container: colour is display data only |
| IS-03 | Methods (printed `METHOD : …` text) | 00 §4 | |
| IS-04 | Units (global vocabulary + tenant additions) and value sets for ordinal/coded results (urine 1+/2+) | 00 §4 Units column; 04 D14 | |
| IS-05 | Orderables: tests, clinical panels, commercial packages (sex-restricted packages), short-name codes, search | 00 A6; 00 §4 "METRO HEALTH PACKAGE (ELITE) (MALE)" shape | Glossary: CBC is a *test* with many analytes; panel = group of tests; package = commercial bundle |
| IS-06 | Tests: department, workflow type, specimen requirements, report order | 00 §4; wishlist 2, 3, 14 | Workflow type values fixed by 03-IC §4.2 `WorkflowType` |
| IS-07 | Analytes with **versioned** clinical attributes: result type, unit, decimals, method, value set, formula; non-versioned display attributes: print name, report sub-heading, sort order, reportable flag | 00 §4; 00 C4; 04 D14 | |
| IS-08 | Formula definitions (grammar §7.1 of 02-TRD), validation, dependency graph, cycle detection | 00 C4; 01 §2.2 | Evaluation is C5's (01-CM §2 C5 scope) |
| IS-09 | Reference-range sets: versioned, effective-dated; bands by sex, age (days/weeks/months/years), optional specimen type; numeric, text-form and ordinal-expected kinds | 00 §4 "Biological Ref Range"; 04 D14; REQ-ARCH-035/036 | |
| IS-10 | Critical-limit sets, separate from reference ranges, same dimensions | 01 §2.2; 04 L21 | Detection/notification is C5 |
| IS-11 | Comment short-code library, department-scoped | 00 C3 | C5 expands and stores the text |
| IS-12 | TAT targets per test and priority (routine/urgent), with named segment | wishlist 15; 01 §2.7 | **Data only**; alerts are C9 (Phase 2) |
| IS-13 | Doctors (referrers) incl. quick-add pending back-office verification, merge of duplicates | 00 A5, E2, D4 | Never labelled "commission" (04 L19) |
| IS-14 | Credit parties / affiliations (hospital, company, clinic, partner lab …), with `allows_credit` | 00 E2, E6 | Credit limits, credit days, statements are C4 |
| IS-15 | Price lists per default / credit party / doctor / centre, versioned and effective-dated; precedence; fall-through | 00 E3 | Precedence per 03-IC §4.2 [CONV default] |
| IS-16 | Excel import/export: price lists, catalog master, referrers (+ credit-party import, CR-C18-008) — template download, validation report, dry-run then commit, idempotent | 00 E4; 07-BLOCKERS B3 | Library choice in 02-TRD §2.2 |
| IS-17 | Urgent surcharge rules (flat or percent; scope all/department/orderable; optional price-list scope) | 00 A10 | Surcharge is quoted; C4 bills it as a line |
| IS-18 | Tax configuration per orderable as data: VAT exempt/taxable, optional extra tax type with configurable rate, optional HS code | 04 L10, L14, L15, L25; B7 | No default treatment is invented (§9) |
| IS-19 | Instrument code maps (inbound/outbound, unit conversion, flag map) as catalog data + HTTP API for C7's UI | 00 C1; wishlist 3; X4 | C3 has no mapping screen; C7 owns it |
| IS-20 | `CatalogPort` implementation (all 03-IC §4.2 methods + CR-C3-001 additions) and `catalog.changed.v1` producer | 01-CM §5.1 | |
| IS-21 | Published views `catalog.v_pub_department`, `v_pub_test_directory`, `v_pub_price_list_items`, `v_pub_referrer_directory` | 03-IC §6.6 | |
| IS-22 | Staff web screens for all of the above under `/catalog/*` | — | 04-UI-UX |
| IS-23 | User-manual pages + in-app help per screen | 01-CM §2 wishlist 9 note | `docs/manual/catalog/` |

### 4.2 Out of scope (owner in brackets)

- Branches, collection centres, users, roles, tenant settings [C2]. C3 only *references* centres (`core.collection_centres`) for centre price lists.
- Registration screen, order items, discounts, invoices, credit limits/credit days/credit-party locking and monthly statements, cash reports [C4].
- Formula **evaluation**, delta-check rules, flagging, critical-value detection/notification, comment expansion at entry time, worksheets [C5].
- Report templates, letterhead, report grouping rendering, narrative report engine [C6].
- Analyser drivers, instrument registry, mapping UI screens [C7]. Instrument ids are C7's; C3 stores them as opaque references (§6).
- Referral-incentive report [C8, tenant-flagged, never "commission" — 04 L19, B13]. C3 stores referral attribution master data only; no incentive rates, no payouts.
- TAT measurement, alerts, escalations [C5/C8 measurement; C9 alerts, Phase 2]; QC targets [C9]; AST breakpoint tables and organism lists [C10]; histo templates [C11].
- Membership/loyalty pricing [C16, Phase 3; a price-list variant per 01 §1.7 — future CR].
- Automatic import of the eLabs catalog [C18, BLOCKED B4]. C18 may later produce an Excel file in C3's template.
- A "live inheritance" global test master that silently changes tenants' clinical definitions (see DECISION D-C3-01 in §8).

## 5. User stories and acceptance criteria

Each AC is written to become an automated test (05-DoD §2). Synthetic data only. "Tenant A/B" = the permanent synthetic tenants (02-CV §11.2). Monetary examples are synthetic.

### US-01 Department, specimen type, container, method masters
- **AC-01.1** Given a `lab_manager` of tenant A, When they create department `HAEM` "Hematology" with report order 10, Then `201` returns the department with `version = 1`, `is_active = true`, and a `catalog.changed.v1` event with `entity_type = department`, `change_kind = created` is published in the same transaction.
- **AC-01.2** Given department code `HAEM` already exists in tenant A, When another create uses `haem` (any case), Then `409 catalog.code_duplicate` (codes are upper-cased on write).
- **AC-01.3** Given tenant B has a department `HAEM`, When tenant A creates `HAEM`, Then it succeeds (codes unique per tenant only).
- **AC-01.4** Given a department used by an active test, When a `lab_manager` sets `is_active = false`, Then it succeeds, the department remains readable by id, and it is excluded from default list results (`is_active=true` filter).
- **AC-01.5** Given specimen type `EDTA_WB` with report label "EDTA WHOLE BLOOD", When `getTest` is called for a test requiring it, Then `specimenTypeCodes` contains `EDTA_WB` and the HTTP test view shows the report label.
- **AC-01.6** Given an update with a stale `If-Match`, Then `409 common.version_conflict`; without `If-Match`, Then `428 common.precondition_required`.

### US-02 Tests and analytes (Metro report structure)
- **AC-02.1** Given test `CBC` in `HAEM` with analytes HB, RBC, MCV, …, each with `report_subheading` ("RBC parameters", "WBC parameters", "Absolute counts", "Platelet parameters", "Special parameters"), `sort_order`, a method and unit, When `CatalogPort.getTest` is called, Then analytes are returned in `sortOrder` order with `reportSubheading`, `methodName`, `unitCode`, `decimals` from the analyte version effective at `asOf`.
- **AC-02.2** Given analyte code `hb` submitted, Then it is stored as `HB`; a code not matching `^[A-Z][A-Z0-9_]{0,31}$` after upper-casing → `400 common.validation_failed` with path `/code`.
- **AC-02.3** Given a test with `workflow_type` `microbiology`, `anatomic`, `molecular` or `narrative`, When an analyte version is published that would give the test more than one active reportable analyte of result type `narrative`, Then `400 common.validation_failed` path `/result_type`. That single narrative analyte is the "module result" analyte C10/C11 submit against (03-IC §4.5 A1) or the narrative report body (C6).
- **AC-02.4** Given such a test with **no** published narrative analyte, Then it is listed under `tests_missing_required_analyte` in `GET /v1/catalog/health-report`, and `resolveOrderables` still succeeds (ordering is not blocked; C5/C10/C11 surface the gap).
- **AC-02.5** Given a test with `workflow_type = attachment` and no published analyte of result type `attachment`, Then it is listed under `tests_missing_required_analyte` in the health report.
- **AC-02.6** Given an analyte with result type `ordinal` or `coded`, When its version is published without `value_set_code`, Then `400 common.validation_failed` path `/value_set_code`; Given result type `ordinal` with a value set whose `is_ordered = false`, Then `400 common.validation_failed` path `/value_set_code`; Given result type `numeric`, Then `decimals` (0–6) is required.
- **AC-02.7** Given a deactivated test, When `getTest` is called without `requireActive`, Then it is returned with `isActive = false`; with `requireActive: true`, Then `catalog.test_inactive` (03-IC §4.2 contract test 13).

### US-03 Versioned clinical attributes
- **AC-03.1** Given analyte HB with published version 1 (unit `g_dl`, decimals 1) effective since T0, When a `lab_manager` publishes version 2 (decimals 2) with `effective_from = T1`, Then version 1 gets `effective_to = T1` and status `superseded`, version 2 is `published`, and `getTest(asOf < T1)` returns decimals 1 while `getTest(asOf ≥ T1)` returns decimals 2.
- **AC-03.2** Given a published analyte version, When any clinical field is PATCHed, Then `409 catalog.version_in_use` and the row is unchanged (DB trigger also blocks it: `common.immutable_record`).
- **AC-03.3** Given `effective_from` earlier than the transaction time minus 300 s [CONV tolerance], Then `400 common.validation_failed` path `/effective_from` (no back-dating).
- **AC-03.4** Given a draft analyte version already exists for HB, When another draft is created, Then `409 common.version_conflict` (one open draft per analyte).
- **AC-03.5** Given version 2 changes the unit or the method, When published without a reference-range set for the new unit/method in the same publish request and without `allow_without_ranges: true`, Then `400 common.validation_failed` path `/reference_range_set_id`.
- **AC-03.6** Publishing an analyte version (unit, decimals, method, result type, value set, formula) requires `catalog.reference_range.publish` (privileged, clinical sign-off) **and** `catalog.test.manage` (08 A13 D-18): a `lab_manager` at aal1 gets `403 auth.mfa_required`; a user holding only `catalog.test.manage`, or only `catalog.reference_range.publish` (e.g. `pathologist`), gets `403 auth.forbidden`.

### US-04 Formulas, dependency graph, cycle detection
- **AC-04.1** Given analyte `MENTZER` with formula `MCV / RBC`, decimals 1, and inputs MCV = 70.0, RBC = 5.60 in the golden vector table (02-TRD §7.1), Then the shared evaluator returns `12.5` and the C3 validator accepts the formula with `inputAnalyteCodes = ["MCV","RBC"]`.
- **AC-04.2** Given formula `if(TG >= 400, invalid("tg_over_400"), TC - HDL - TG / 5)` for LDL, Then validation succeeds and `getTest` returns `formula.expression` exactly as stored and `inputAnalyteCodes = ["TC","HDL","TG"]` (order of first appearance). (Same formula as C5 AC-09.1.)
- **AC-04.3** Given `A = B + 1` published and a draft `B = A * 2`, When the draft is validated or published, Then `422 catalog.formula_invalid` with `errors[0].path = "/formula_expression"` and message containing the cycle path `B -> A -> B`.
- **AC-04.4** Given a formula referencing unknown analyte code `XYZ`, Then `422 catalog.formula_invalid` naming `XYZ`.
- **AC-04.5** Given a formula on an analyte whose result type is not `numeric`, Then `422 catalog.formula_invalid`.
- **AC-04.6** Given a formula longer than 500 characters [CONV] or a nesting depth > 32 [CONV], Then `422 catalog.formula_invalid`.
- **AC-04.7** Given a chain of formulas deeper than 5 levels [CONV] (A depends on B depends on … ), Then `422 catalog.formula_invalid` ("formula chain too deep").
- **AC-04.8** Given `POST /v1/catalog/formulas/validate` with an expression and sample inputs, Then the response returns `valid`, `input_analyte_codes`, the dependency order and the sample result computed by the shared evaluator, without writing anything.

### US-05 Reference ranges (versioned, dimensioned)
- **AC-05.1** Given HB range set v1 with bands {male, 18 y–∞: 13.0–17.0}, {female, 18 y–∞: 12.0–15.0}, {any, 0 d–18 y: 11.0–16.0} (SYNTHETIC values), When `referenceRangeFor({sex:'male', ageDays: 9000})` is called, Then the male band is returned with `low = "13.0"`, `high = "17.0"`, `version = 1`, `unitCode = "g_dl"`.
- **AC-05.2** Boundary rule: lower bound inclusive, upper bound exclusive [CONV]. Given band 0 d–18 y and a patient exactly 18 completed years old (by `birthOn` when supplied — CR-C3-001 — else by the day-count approximation in 02-TRD §7.3), Then the adult band is chosen; given age 0 days, Then the 0 d band is chosen (03-IC §4.2 contract test 9).
- **AC-05.3** Specificity: given bands for {any sex} and {female} that both match, Then the female band wins; given bands with and without specimen type `URINE` that both match and the query has `specimenTypeCode = URINE`, Then the specimen-specific band wins.
- **AC-05.4** Given `sex = 'other'` or `'unknown'`, Then only `any`-sex bands match; if none, `catalog.no_reference_range`.
- **AC-05.5** Given a text-form band for MENTZER with `kind = text` and display text "<13.0 - Thalassemia trait / >13.0 - Iron deficiency" (shape from the Metro report, lead's brief for 00 §4), Then `referenceRangeFor` returns `text` with that string, no `low`/`high`, and `kind = text` (CR-C3-001) so C5 does not compute an H/L flag.
- **AC-05.6** Given an ordinal analyte (urine nitrite) with band `kind = ordinal`, `normal_codes = ["NEG"]`, display text "Negative", Then the match returns `text = "Negative"`, `normalCodes = ["NEG"]` (CR-C3-001).
- **AC-05.7** Given a draft set where two bands of equal specificity overlap in age, When published, Then `400 common.validation_failed` listing both band indexes; no partial publish.
- **AC-05.8** Given a new set v2 published at T1, Then `referenceRangeFor(at < T1)` returns v1 bands, `at ≥ T1` returns v2 (03-IC §4.2 contract test 3); published bands are never updated or deleted (DB trigger).
- **AC-05.9** Publishing a range set requires `catalog.reference_range.publish` (privileged, CR-C3-003) and a `change_reason` (1–500 chars); a `lab_manager` without aal2 gets `403 auth.mfa_required`.
- **AC-05.10** Given no published set for the analyte at `at`, or a set whose `unit_code`/`method_id` differs from the analyte version effective at `at`, Then `catalog.no_reference_range`.
- **AC-05.11** Unknown patient age (08 A17.1, CR-C5-012). Given HB set v1 of AC-05.1 plus a band {any, no age bounds: 11.0–17.0} (SYNTHETIC), When `referenceRangeFor({sex:'male'})` is called without `ageDays` (with or without `birthOn`), Then the age-unrestricted band is returned; given the AC-05.1 set alone (every band has an age bound, including the open-ended 18 y–∞ bands), Then `catalog.no_reference_range` (02-TRD §7.3 steps 3–4; contract cases 32–33).

### US-06 Critical limits
- **AC-06.1** Given K (potassium) critical set with band {any, all ages: low 2.5, high 6.5} (SYNTHETIC), When `criticalLimitsFor` is called, Then `low = "2.5"`, `high = "6.5"`, with `criticalLimitId` and `version`.
- **AC-06.2** Given an analyte with no critical set, Then `criticalLimitsFor` returns `undefined` (contract test 10), never an error.
- **AC-06.3** Given an ordinal analyte with `abnormal_codes = ["POS"]`, Then the match returns `abnormalCodes = ["POS"]`.
- **AC-06.4** Critical-limit sets follow the same draft/publish/supersede/retire rules and permission as reference-range sets (AC-05.7–05.9).
- **AC-06.5** Given `criticalLimitsFor` without `ageDays` (08 A17.1), Then only critical bands with no age bound match; the AC-06.1 band {any, all ages} matches, a set whose bands all carry age bounds returns `undefined`.

### US-07 Panels and packages
- **AC-07.1** Given clinical panel `LIPID` = {TC test, HDL test, TG test, LDL test} and package `HP_ELITE_M` (kind `package`, `sex_restriction = male`) = {CBC, LIPID, FBS}, When `resolveOrderables([HP_ELITE_M])` is called, Then `orderables[0].testIds` lists the 6 test ids, `tests` contains each test once, and `specimenRequirements` groups tests by (preferred specimen type, container).
- **AC-07.2** Given a test present in two ordered panels, Then `tests` contains it once (contract test 4).
- **AC-07.3** Given panel P1 containing P2 and an attempt to add P1 into P2, Then `422 catalog.panel_cycle` and membership is unchanged (contract test 5).
- **AC-07.4** Given nesting depth > 4 [CONV], Then `400 common.validation_failed` path `/members`.
- **AC-07.5** Given a panel containing an inactive test, When `resolveOrderables` is called, Then `catalog.test_inactive`.
- **AC-07.6** Packages are priced as a bundle: given no price-list item for the package itself, Then `priceFor(package)` → `catalog.no_price` (component prices are never summed — 06-GLOSSARY Package).

### US-08 Orderable search
- **AC-08.1** Given front desk types `cbc`, When `GET /v1/catalog/orderables?q=cbc` is called, Then results whose code starts with `CBC` rank before name matches; each item has id, kind, code, name, department code, panel kind, sex restriction, workflow type; `limit` default 20 [CONV], max 50 [CONV].
- **AC-08.2** Given `q` contains `%` or `_`, Then they are matched literally (escaped — REQ-SEC-082).
- **AC-08.3** Given orderables of tenant B, Then they never appear in tenant A's results.
- **AC-08.4** p95 ≤ 150 ms at the reference dataset (02-TRD §12).

### US-09 Comment short-code library
- **AC-09.1** Given comment code `HYPO` in department HAEM with text "Hypochromia present." and a tenant-wide `HYPO` with different text, When `CatalogPort.resolveCommentCodes({codes:["HYPO"], departmentId: HAEM})` (CR-C3-001; = C5's CR-C5-001) is called, Then the department entry is returned with its `version`.
- **AC-09.2** Given an unknown or inactive code, Then it is listed in `unknown` (no throw); C5 turns that into its own validation error.
- **AC-09.3** Editing a code's text increments its `version`; C3 never rewrites text already stored by C5.

### US-10 TAT targets (data only)
- **AC-10.1** Given CBC routine target 4 h and urgent target 1 h (segment `within_lab`), When `getTest` is called, Then `tatTargetSeconds = { routine: 14400, urgent: 3600 }` and `tatTargetSegment = "within_lab"` (CR-C3-001). Given routine and urgent targets with different segments in one `setTestTatTargets` call, Then `400 common.validation_failed` path `/targets/1/segment`.
- **AC-10.2** Setting a new target ends the previous row (`effective_to`) and creates a new row; history stays queryable with `asOf`.
- **AC-10.3** C3 emits no alerts and runs no TAT job.

### US-11 Doctors (referrers)
- **AC-11.1** Given a `front_desk` user on the registration screen, When they quick-add "Dr Test Referrer 0007" with phone, Then `201` returns a doctor with an auto `doctor_code` (pattern `DR{seq:5}` [CONV]), `is_verified = false`, `source = quick_add`, and `Idempotency-Key` replays return the same doctor.
- **AC-11.2** Given a quick-add whose normalised name + phone equals an existing active doctor, Then `409 catalog.code_duplicate` is **not** used; instead `201` with `possible_duplicate_of: [ids]` in the response so the UI can offer the existing doctor [CONV].
- **AC-11.3** Given a `tenant_admin` merges doctor X into Y, Then X becomes inactive with `merged_into_id = Y`; `getReferrer(X)` returns `canonicalReferrerId = Y` (CR-C3-001); historic orders keep X (C3 never rewrites other modules).
- **AC-11.4** Given `CatalogPort.getReferrer({referrerId, purpose:'display'})`, Then no phone/email is returned; with `purpose:'notification'` the contact fields are returned (used only by C6 NotificationPort).
- **AC-11.5** No field, label, export column or event in C3 contains the word "commission" (04 L19). A CI grep over C3 paths enforces it.

### US-12 Credit parties / affiliations
- **AC-12.1** Given finance creates hospital "Synthetic General Hospital" with `allows_credit = true` and a blank `party_code`, Then it gets an auto `party_code` (`CP{seq:5}` [CONV]) and appears in `GET /v1/catalog/credit-parties`.
- **AC-12.4** Given a user holding `catalog.price_list.read` but not `catalog.price_list.manage` (e.g. `front_desk`), When they read a credit party, Then `pan`, `contact_phone_e164`, `contact_email` and `billing_address` are absent (REQ-SEC-081).
- **AC-12.2** Given an affiliation with `allows_credit = false` (discounted list only), Then `priceFor` with its id still applies its price list (source `credit_party`), and `getCreditParty` returns `allowsCredit = false` so C4 refuses credit billing mode.
- **AC-12.3** C3 stores no credit limit, credit days or balance (C4 owns them).

### US-13 Price lists, versions, precedence
- **AC-13.1** Precedence (03-IC §4.2 [CONV default]): explicit `priceListId` > credit party > referrer > centre > tenant default. Given CBC priced NPR 900 in the default list, NPR 800 in centre C2's list, NPR 700 in Dr X's list and NPR 600 in hospital H's list, Then `priceFor` returns 600 (`source = credit_party`) with H+X+C2, 700 with X+C2, 800 with C2, 900 with none, and the explicit list's price when `priceListId` is given (contract test 6).
- **AC-13.2** Fall-through: given H's list lacks FBS and `falls_through = true`, Then FBS is priced from the next source; given `falls_through = false`, Then `catalog.no_price`. Given an assigned active list with **no** version effective at `at` (only its draft v1), Then it is skipped as if absent, regardless of `falls_through`.
- **AC-13.3** Given a published version v3 with `effective_from = T1`, Then `priceFor(at < T1)` uses v2 and `at ≥ T1` uses v3; the quote returns `priceListId`, `priceListVersion`.
- **AC-13.4** Items of a published version cannot be changed (`409 catalog.version_in_use`); changes go to a new draft version copied from the latest.
- **AC-13.5** Publishing a price-list version requires `catalog.price_list.manage` (privileged → aal2) and `change_reason`.
- **AC-13.6** Exactly one active default price list per tenant (DB partial unique index).
- **AC-13.7** A doctor, credit party or centre has at most one assigned price list (`409 catalog.code_duplicate` on a second assignment).
- **AC-13.8** Prices are integer paisa ≥ 0 and ≤ 999,999,999 paisa (NPR 9,999,999.99) [CONV]; no floats on the wire (02-CV §4.9).

### US-14 Urgent surcharge
- **AC-14.1** Given a rule "department HAEM, percent 5000 bp (50 %)" and CBC unit price NPR 900.00, When `priceFor` has `priority = urgent`, Then `urgentSurcharge = 45000` paisa; with `priority = routine`, Then `urgentSurcharge` is absent (contract test 7).
- **AC-14.2** Specificity: orderable rule > department rule > all-tests rule; a rule scoped to the winning price list beats an unscoped rule of the same specificity.
- **AC-14.3** Percent surcharges round half-up to the paisa (02-CV §4.9).
- **AC-14.4** Given no rule matches an urgent quote, Then no surcharge (not an error).
- **AC-14.5** Given an active surcharge rule for (scope, key, price list), When a second rule with an overlapping window is created, Then `400 common.validation_failed` path `/effective_from`.

### US-15 Tax configuration (rules are data; BLOCKED B7)
- **AC-15.1** Given tenant default rule `vat_treatment = exempt` and an orderable rule `taxable` for a kit-sale orderable, Then `priceFor` returns `tax.vat = 'taxable'` with `vatRateBp = 1300` (04 L14; CR-C3-001) for that orderable and `exempt` for others.
- **AC-15.2** Given an extra tax type `HST` whose rate the tenant admin has not entered (rate is BLOCKED B7 / 04 L25), When an orderable rule references it, Then saving the rule fails `400 common.validation_failed` path `/other_tax_code` ("tax type has no rate").
- **AC-15.3** Given a tenant with no tenant-default tax rule, When `priceFor` is called, Then `422 catalog.tax_config_missing` (CR-C3-003). C3 never assumes "lab tests are exempt" (06-GLOSSARY VAT).
- **AC-15.4** The UI shows, next to every tax setting, the text "Tax treatment of lab services is pending confirmation by your auditor" (07-BLOCKERS rule: never present a default as the answer).
- **AC-15.5** Given an open tenant-default rule from T0, When a new tenant-default rule is created with `effective_from = T1 > T0`, Then the old rule gets `effective_to = T1` in the same transaction; Given a department or orderable rule whose window overlaps an existing rule of the same key, Then `400 common.validation_failed` path `/effective_from`. A panel/package uses its own `department_id` for department rules, else none.

### US-16 Excel price-list import/export (00 E4)
- **AC-16.1** Given finance downloads `GET /v1/catalog/import-templates/price_list`, Then they get an `.xlsx` with sheets `Instructions`, `Prices` and hidden `_meta` (02-TRD §8).
- **AC-16.2** Given finance exports price list PL-DRX v3, Then the file contains one row per orderable in v3 with code, kind, name, department, price in NPR (2 dp) and `_meta` carrying `price_list_id` and `base_version_no = 3`.
- **AC-16.3** Given the edited file is uploaded (`POST /v1/catalog/imports`, kind `price_list`, with `Idempotency-Key`), Then the import is created in state `uploaded`, validated asynchronously (dry run, nothing published), and reaches `validated` (0 errors) or `invalid` (≥1 error) with counts {rows, added, changed, removed, unchanged, errors, warnings}.
- **AC-16.4** Given a row with price `12.345`, Then issue `row.price_decimals` (error) at sheet `Prices`, row n, column `unit_price_npr`; given an unknown code, Then `row.orderable_unknown` (error); given an inactive orderable, Then `row.orderable_inactive` (warning); given a duplicate code, Then `row.duplicate_code` (error).
- **AC-16.5** Given the list was published as v4 after the export (base 3), Then warning `file.stale_base`; commit then requires `accept_stale_base: true`, else `409 catalog.import_stale_base` (CR-C3-003).
- **AC-16.6** Given a `validated` import, When committed with `effective_from` and `publish: true`, Then exactly one new published version v(n+1) equal to the sheet contents (full replacement semantics) exists, `catalog.changed.v1` (`price_list`, `versioned`) is emitted once, and the import is `committed` with `result_price_list_version_id`. Given the list already has an open manual draft, Then the commit ends `commit_failed` with issue `file.draft_exists` unless the request sent `replace_draft: true` (the draft is then discarded first).
- **AC-16.7** Given the same commit request is retried (same `Idempotency-Key`), Then the stored response is replayed; given a different key on an already `committed` import, Then `409 catalog.import_not_committable` (CR-C3-003); no second version is created.
- **AC-16.8** Given the same file bytes are uploaded again for the same kind and target within the import TTL (168 h [CONV]) (dedupe key: tenant, kind, target, sha256 — same bytes carry the same `_meta`), Then the existing non-failed import is returned (`200`, `deduplicated: true`) instead of a new one.
- **AC-16.9** Given a file that is not a ZIP/xlsx (magic bytes), larger than 15 MB (02-CV §10.2), whose uncompressed size exceeds 50 MB [CONV], with more than 200 ZIP entries [CONV], containing `xl/vbaProject.bin` (macro) or external links, Then the upload is rejected (`415 common.unsupported_media_type`, `413 common.payload_too_large` or import state `invalid` with `file.*` issue) and the file is never parsed by the spreadsheet library.
- **AC-16.10** Given an import `invalid`, Then `GET …/report-file` returns an `.xlsx` copy of the sheet with an added `issues` column and an `Issues` sheet; the original upload is never served back.
- **AC-16.11** Uploading and committing a price list need `catalog.price_list.manage` (privileged, aal2).
- **AC-16.12** Given a `price_list` workbook built from a fresh template whose `_meta.tenant_catalog_revision` is blank or missing (e.g. a C18 migration workbook), When it is uploaded, Then validation does not raise `file.meta_missing` for it; only `template_kind`, `template_version`, `price_list_id` and `base_version_no` are read (02-TRD §8.2; C18 hand-off).

### US-17 Catalog-master and referrer import/export (B3 swap mechanism)
- **AC-17.1** Given the synthetic starter workbook `packages/test-fixtures/catalog/starter_catalog_master.xlsx` (built by C0-0A under CR-C3-007, 08 A13 D-17; kind `catalog_master`), When imported and committed into an empty tenant, Then departments, specimen types, containers, methods, value sets, tests, analytes (with version 1), reference-range sets, critical-limit sets, panels, packages and comment codes exist exactly as in the workbook, `GET /v1/catalog/revision` advanced by exactly 1, and exactly one `catalog.changed.v1` with `entity_type = catalog_import`, `entity_id` = the import id was published (08 A13 D-21); analyte versions and sets carry `published_by` = the committing user and `source_import_id` = the import id.
- **AC-17.2** Given a re-import of the same workbook, Then validation reports 0 changes and commit creates no new versions (idempotent upsert-by-code).
- **AC-17.3** Given a workbook changing HB decimals, Then commit creates analyte version n+1 (and a range set only if the range rows changed); non-clinical changes (name, sort order, sub-heading) update in place.
- **AC-17.4** Given a workbook containing a formula cycle, Then the import is `invalid` with issue `row.formula_invalid` and nothing is written.
- **AC-17.5** Committing a catalog-master import that creates or publishes analyte versions, reference-range sets or critical-limit sets requires `catalog.reference_range.publish` (privileged) in addition to `catalog.test.manage` (08 A13 D-18).
- **AC-17.6** Referrer import (kind `referrers`) upserts by `doctor_code`; blank code → auto code; requires `catalog.referrer.manage`; referrer export requires `catalog.referrer.export` (privileged, CR-C3-003) because it contains doctors' phone/email.

### US-18 Instrument code maps (data for C7)
- **AC-18.1** Given C7's UI posts `{instrument_id, direction:'both', instrument_code:'HGB', analyte_id: HB, unit_from_raw:'g/L', unit_to_code:'g_dl', unit_factor:'0.1'}`, Then the map is created and `mapInstrumentCode({instrumentId, direction:'inbound', instrumentCode:'HGB'})` returns it, and `({direction:'outbound', analyteId: HB})` returns instrument code `HGB` (contract test 11).
- **AC-18.2** Given no active map, Then `catalog.instrument_code_unmapped` (contract test 12).
- **AC-18.3** Given two active inbound maps for the same instrument and code, Then the second create → `409 catalog.code_duplicate`.
- **AC-18.4** `analyte_id` must belong to `test_id` (else `400 common.validation_failed`); both must be in the caller's tenant (else `404 common.not_found`).
- **AC-18.5** Requires `catalog.instrument_code_map.manage` (privileged → aal2, 08 A13 D-18; at aal1 → `403 auth.mfa_required`); bulk upsert accepts ≤ 200 rows with per-row outcome (02-CV §4.1).

### US-19 CatalogPort and cache invalidation
- **AC-19.1** The real `CatalogPort` passes all 13 contract cases in 03-IC §4.2 plus the C3 cases listed in 02-TRD §14.
- **AC-19.2** Every committed catalog change increments the tenant's `catalog_revision` by exactly 1 per root entity changed and publishes one `catalog.changed.v1` per increment with idempotency key `<tenant_id>:catalog:<revision>`; a rolled-back transaction publishes nothing. Exception (08 A13 D-21): a `catalog_master`, `referrers` or `credit_parties` import commit increments once and publishes one event with `entity_type = catalog_import`, `entity_id = import_id`, `change_kind = updated`, and stamps every affected orderable's `revision`; a price-list import commit stays one `price_list` event. Draft edits and import/export bookkeeping rows bump nothing.
- **AC-19.3** Given two concurrent catalog writes in one tenant, Then revisions are strictly increasing without gaps or duplicates (row lock on `catalog.catalog_state`).
- **AC-19.4** Port p95 ≤ 20 ms with warm cache; `resolveOrderables` ≤ 50 ms for 50 orderables (03-IC §4.2).
- **AC-19.5** After a seed migration bumps the global reference release, Then within 15 min [CONV: cron every 10 min] each tenant receives one `catalog.changed.v1` with `entity_type = global_reference`.
- **AC-19.6** `CatalogPort.getPriceListStatus({priceListId})` (08 A24.1, consumer C16) returns `isActive` and the derived list status from C3's set (`published` if any version is published, else `draft` if a draft is open, else `discarded`; never `retired`, which price lists do not have — 02-TRD §7.4a); an unknown or other-tenant id → `common.not_found` (contract cases 34–35).

### US-20 Tenant isolation (cross-cutting)
- **AC-20.1** For every C3 operation, a tenant-A caller using tenant-B ids gets `404 common.not_found` (or per-item not_found in bulk), and no tenant-B row changes (02-CV §11.3).
- **AC-20.2** For every C3 table, SQL probes with tenant-A claims see zero tenant-B rows and cannot insert/update tenant-B rows.

## 6. Interfaces this chunk depends on (contracts only)

| Contract | Kind | Used for |
|---|---|---|
| `IdentityPort.assertRole`, `getActor` (C2) | port | permission + MFA checks on every handler |
| `ctx.core` repository (C0): `ctx.core.centre(ctx, {centreId})` | core read | validating `centre_id` on centre price-list assignments and quotes |
| C2 `listCentres` HTTP (`identity.centre.read`, 08 A13 D-16) | HTTP via the staff BFF | centre pickers in SCR-13 / SCR-15 |
| `events.publish` (C0 core outbox) | core | `catalog.changed.v1` |
| `@lims/shared-ts`: `uuidv7`, `money`, `errors`, `logger`, **`formula`** (CR-C3-002 = CR-C5-002) | shared lib | ids, paisa maths, formula parse/evaluate |
| C0 core multipart/file handling + mandatory malware scan in staging/prod (CR-C3-005 merged into CR-C2-011, 08 R12b) | core | xlsx upload |
| `@lims/ui` components (CR-C3-006) | UI kit | screens |
| C7 instrument ids | opaque uuid | stored on code maps without FK (01-CM §5 R3 forbids `catalog → instruments` FK) |

C3 consumes **no events** (01-CM §5.1, 03-IC §3.25).

## 7. Success metrics

| Metric | Target | How measured |
|---|---|---|
| CatalogPort contract suite | 100 % of 03-IC §4.2 cases + C3 cases pass on fake and real | CI |
| Port latency (warm) | p95 ≤ 20 ms; `resolveOrderables(50)` ≤ 50 ms | load test 02-TRD §12 |
| Price-list import (1,000 rows) | validated ≤ 10 s, committed ≤ 10 s [CONV] | integration benchmark |
| Real test list onboarding (when B3 arrives) | loaded via `catalog_master` import with **zero code changes** | manual check at onboarding |
| Cross-tenant leaks | 0 | probe suite |
| `catalog.no_price` / `no_reference_range` at go-live | 0 for active orderables/analytes (configuration completeness report) | `GET /v1/catalog/health-report` [CONV, §7 of 02-TRD] |

## 8. Decisions taken in this PRD

| ID | Decision | Rationale |
|---|---|---|
| D-C3-01 | "Global master + tenant overrides" (REQ-ARCH-035; 03-IC §4.2) is realised as **global reference vocabularies** (`catalog.g_units`, `g_value_sets`, `g_tax_types`) visible to all tenants with tenant shadow rows, plus **tenant-owned** tests/analytes/ranges/prices. A starter catalog is delivered as an importable workbook (`packages/test-fixtures/catalog/`, CR-C3-007 to C0-0A, 08 A13 D-17), copied into the tenant, never live-inherited. | A live global test definition that changes under a tenant would alter clinical definitions without that lab's sign-off and break the version/snapshot rule (04 D14). |
| D-C3-02 | One versioning axis per clinical object: analyte version (unit, decimals, method, result type, value set, formula), reference-range set, critical-limit set, price-list version. All are `draft → published → superseded/retired`; published rows are immutable. | 04 D14; 02-CV §5.2 class M; simple for C5 to snapshot. |
| D-C3-03 | Price-list import = **full replacement** of the list's next version. | Matches "edit price lists in Excel and upload back" (00 E4); deltas are reported in the validation summary. |
| D-C3-04 | No default VAT treatment; tenant must configure (AC-15.3). | 04 L15/L25 BLOCKED B7; 07-BLOCKERS "never present a default as the real answer". |
| D-C3-05 | Import files and generated exports are stored in `catalog.files` (bytea, class E, 30-day retention [CONV]), not in Supabase Storage. | Avoids needing a Storage service key (02-CV §10.2 "default: not used") and the UNVERIFIED Storage claims behaviour (04 D3); files ≤ 15 MB. |
| D-C3-06 | Doctor names/contacts are personal data (03-IC PHI class P2 analogue, non-health); search by name uses `POST …/doctors/search` (no names in URLs). | REQ-SEC-098; 02-CV §4.1. |

## 9. Phase

Phase 1 (Wave 1). TAT targets are stored in Phase 1 even though alerts are Phase 2 (C9). Membership price variants (Phase 3) are a future CR.

## 10. Blocked items and the default built meanwhile

| # | Blocked item | Default C3 builds |
|---|---|---|
| B3 | Client test list with prices and reference ranges | Synthetic starter workbooks (`packages/test-fixtures/catalog/starter_catalog_master.xlsx`, `starter_price_list.xlsx`; built by C0-0A under CR-C3-007, 08 A13 D-17) imported through the same `catalog_master` / `price_list` import; every seed value is labelled SYNTHETIC and is not a clinical reference value |
| B7 (04 L15, L25, L10) | VAT treatment of lab services; Health Service Tax rate/applicability; HS-code applicability | Tax rules as data: per tenant default + department + orderable; VAT rate 13 % from 04 L14 (VERIFIED); extra tax types with tenant-entered rate (no seeded rate); optional HS code field; no default treatment |
| B2 | Analyser models and their codes | Code maps per instrument id, any code string ≤ 64 chars; unit conversion factor and flag map as data |
| B13 / 04 L19 | Referral-incentive compliance | No incentive fields at all in C3; referral attribution (doctor master) only |
| B15 | Legal retention | Catalog master is never deleted; import/export files 30 days [CONV] (they are working copies, not records) |
| B6 | Invoice-series granularity etc. | Not C3's concern |

Final sweep 2026-11-06 — second touch applied (AC-05.11, AC-06.5 08 A17.1; AC-16.12 C18 `_meta` hand-off; AC-19.6 08 A24.1).
