# C14 Smart Report — 05 Schema (spec for C0-0B)

Status: DECISION, 2026-11-06. Schema `smartreport` (already created by C0 — C0 05-SCHEMA §1; `event_inbox` already listed for `smartreport` — C0 05-SCHEMA §3.9). Conventions: 02-CV §5 (classes, mandatory columns, composite FKs, RLS template, no ENUM types, `tenant_id` leading in every index). Cross-schema FKs point only upstream (01-CM §5 R3): `smartreport → core, catalog, frontdesk`. The FKs to `frontdesk.orders` / `frontdesk.patients` and the `FrontdeskPort` calls (`getOrderSummary`, `getPatientDemographicsBatch` purpose `lab_display`) make C14 a declared C4 consumer (CR-C14-009, 08 A19 D-110 / P-46). No FK into `billing` (02-CV §5.4). No schema references `smartreport`.

PHI classes (03-IC §1): P0 no personal data · P1 pseudonymous ids · P2 lab-linked identifiers/personal data · P3 health data.

---

## 1. Table inventory

| Table | Class (02-CV §5.2) | Scope | Purpose |
|---|---|---|---|
| `smartreport.g_cs_organ_groups` | G | global | body-system / organ group codes |
| `smartreport.g_cs_summary_reject_reasons` | G | global | reject reasons |
| `smartreport.g_cs_wording_deny_terms` | G | global | global deny terms (cannot be removed by tenants) |
| `smartreport.library_versions` | M (versioned; content frozen outside `draft`) | tenant | template library version + score/trend parameters |
| `smartreport.template_blocks` | M (draft-only edits) | tenant | patient-facing text blocks |
| `smartreport.rules` | M (draft-only edits) | tenant | deranged/advice/follow-up rules |
| `smartreport.analyte_groups` | M (draft-only edits) | tenant | analyte → organ group mapping (catalog-linked) |
| `smartreport.group_settings` | M (draft-only edits) | tenant | per-group display names, weights, visibility |
| `smartreport.wording_deny_terms` | M | tenant | tenant deny terms |
| `smartreport.library_reviews` | A | tenant | submit/return/approve/retire history |
| `smartreport.summaries` | C | tenant + centre | built summaries |
| `smartreport.summary_report_bindings` | A | tenant + centre | which report versions requested a summary |
| `smartreport.summary_reviews` | A | tenant + centre | approve/reject/supersede/LLM-request history |
| `smartreport.llm_runs` | A | tenant + centre | LLM rephrase runs (Phase 3) |
| `smartreport.event_inbox` | A | tenant | C0 standard inbox (03-IC §12) |

Class M rows (library tables, deny terms) are never deleted: an author's "remove" sets `is_active = false` (02-CV §5.2/§5.6; 08 A17 P-18(a)). Readers (engine, validation, clone, content hash, list endpoints) use active rows only. Mandatory-column exceptions (08 A17 P-18(b)): none.

## 2. Tenant tables — columns

Mandatory columns per class (02-CV §5.3) are included and marked "std". `created_by`/`updated_by` = actor id (no FK). All `*_membership_id` columns have composite FKs to `core.memberships (tenant_id, id)`.

### 2.1 `library_versions`

| Column | Type | Null | Default | Check / note | PHI |
|---|---|---|---|---|---|
| id, tenant_id | uuid | N | — | std | P0 |
| version_no | integer | N | — | ≥ 1; unique per tenant | P0 |
| status | text | N | `'draft'` | `draft, in_review, approved, retired` | P0 |
| language | text | N | `'en'` | `en, ne` | P0 |
| formula_version | text | N | `'hs-1'` | `hs-1` | P0 |
| score_enabled | boolean | N | true | | P0 |
| credit_in_range_bp / credit_borderline_bp / credit_out_of_range_bp / credit_critical_bp | integer | N | 10000 / 5000 / 0 / 0 | each 0–10000; in ≥ borderline ≥ out ≥ critical | P0 |
| min_groups_scored | integer | N | 2 | 1–20 | P0 |
| band_good_min / band_fair_min | integer | N | 80 / 60 | good 1–100; fair 0–99; fair < good | P0 |
| critical_forces_needs_attention | boolean | N | true | | P0 |
| borderline_fraction_bp | integer | N | 0 | 0–2500 | P0 |
| min_mapped_results | integer | N | 3 | 1–50 | P0 |
| trend_enabled | boolean | N | true | | P0 |
| trend_max_points | integer | N | 4 | 2–6 | P0 |
| trend_lookback_days | integer | N | 730 | 30–3650 | P0 |
| trend_stable_bp | integer | N | 1000 | 0–5000 | P0 |
| trends_max | integer | N | 6 | 0–12 | P0 |
| advice_max_blocks | integer | N | 5 | 0–10 | P0 |
| followup_max | integer | N | 3 | 0–5 | P0 |
| source_version_id | uuid | Y | — | FK self | P0 |
| change_summary | text | Y | — | ≤ 500 | P0 |
| content_sha256 | text | Y | — | `^[0-9a-f]{64}$`; required when status ≠ draft | P0 |
| submitted_at, submitted_by_membership_id | timestamptz, uuid | Y | — | | P0 |
| approved_at, approved_by_membership_id | timestamptz, uuid | Y | — | required for `approved`/`retired` | P0 |
| approval_note | text | Y | — | ≤ 500 | P0 |
| returned_at, returned_by_membership_id | timestamptz, uuid | Y | — | | P0 |
| return_comment | text | Y | — | ≤ 1000 | P0 |
| retired_at | timestamptz | Y | — | required for `retired` | P0 |
| version, is_active, created_at, created_by, updated_at, updated_by | | N | std | | P0 |

### 2.2 `template_blocks`

| Column | Type | Null | Check | PHI |
|---|---|---|---|---|
| id, tenant_id, library_version_id | uuid | N | FK parent | P0 |
| block_key | text | N | `^[a-z][a-z0-9_.]{2,79}$`; unique per version among active rows (partial unique index) | P0 |
| kind | text | N | `deranged, advice, followup, disclaimer, score_explanation` | P0 |
| text_en | text | Y | ≤ 600 | P0 (template, no patient data) |
| text_ne | text | Y | ≤ 600 | P0 |
| note | text | Y | ≤ 500 | P0 |
| (row) | | | `text_en IS NOT NULL OR text_ne IS NOT NULL` | |
| version, is_active, created_*, updated_* | | N | std | P0 |

### 2.3 `rules`

| Column | Type | Null | Check | PHI |
|---|---|---|---|---|
| id, tenant_id, library_version_id | uuid | N | | P0 |
| rule_kind | text | N | `deranged, advice, followup` | P0 |
| trigger_kind | text | N | `analyte, group, any, all_in_range` | P0 |
| analyte_id | uuid | Y | FK `catalog.analytes (tenant_id, id)`; required iff `analyte` | P0 |
| group_code | text | Y | FK `g_cs_organ_groups`; required iff `group` | P0 |
| direction | text | N | `low, high, abnormal, any`; `any` when `all_in_range` | P0 |
| min_severity | text | Y | `borderline, out_of_range, critical`; NULL iff `all_in_range` | P0 |
| priority | integer | N | 1–999, default 100 | P0 |
| block_id | uuid | N | FK `(tenant_id, library_version_id, block_id, block_kind)` → blocks | P0 |
| block_kind | text | N | = `rule_kind` | P0 |
| suggested_test_id | uuid | Y | FK `catalog.tests (tenant_id, id)`; required iff `followup` | P0 |
| interval_days | integer | Y | 1–730; required iff `followup`; **no default** | P0 |
| (row) | | | `all_in_range` only for `advice`; `deranged` never `all_in_range` | |
| version, is_active, created_*, updated_* | | N | std | P0 |

### 2.4 `analyte_groups`

| Column | Type | Null | Check | PHI |
|---|---|---|---|---|
| id, tenant_id, library_version_id | uuid | N | | P0 |
| analyte_id | uuid | N | FK `catalog.analytes (tenant_id, id)`; unique per version among active rows (partial unique index) | P0 |
| group_code | text | N | FK `g_cs_organ_groups` | P0 |
| include_in_score | boolean | N | default true | P0 |
| trend_enabled | boolean | N | default false | P0 |
| borderline_fraction_bp | integer | Y | 0–2500 | P0 |
| trend_stable_bp | integer | Y | 0–5000 | P0 |
| sort_order | integer | N | 0–9999, default 100 | P0 |
| version, is_active, created_*, updated_* | | N | std | P0 |

### 2.5 `group_settings`

| Column | Type | Null | Check | PHI |
|---|---|---|---|---|
| id, tenant_id, library_version_id | uuid | N | | P0 |
| group_code | text | N | FK `g_cs_organ_groups`; unique per version | P0 |
| display_en | text | N | 1–60 | P0 |
| display_ne | text | Y | ≤ 60 | P0 |
| score_weight | integer | N | 0–10, default 1 | P0 |
| sort_order | integer | N | 0–9999 | P0 |
| is_shown | boolean | N | default true | P0 |
| version, is_active, created_*, updated_* | | N | std | P0 |

### 2.6 `wording_deny_terms`

| Column | Type | Null | Check | PHI |
|---|---|---|---|---|
| id, tenant_id | uuid | N | | P0 |
| term | text | N | 2–60 | P0 |
| term_folded | text | N | normalised (02-TRD §9.5) | P0 |
| language | text | N | `en, ne, any` | P0 |
| reason | text | Y | ≤ 200 | P0 |
| version, is_active, created_*, updated_* | | N | std | P0 |

### 2.7 `library_reviews` (A)

id, tenant_id, library_version_id (FK), action (`submitted, returned, approved, retired`), comment (≤ 1000, Y), content_sha256 (Y), actor_membership_id (Y, FK memberships), created_at, created_by. PHI P0.

### 2.8 `summaries` (C, centre-scoped)

| Column | Type | Null | Check / note | PHI |
|---|---|---|---|---|
| id, tenant_id | uuid | N | std | P1 |
| centre_id | uuid | N | FK `core.collection_centres`; from `OrderSummary.centreId` | P1 |
| order_id | uuid | N | FK `frontdesk.orders (tenant_id, id)` | P1 |
| patient_id | uuid | N | FK `frontdesk.patients (tenant_id, id)` | P1 |
| library_version_id | uuid | N | FK `library_versions` | P0 |
| template_library_version | text | N | `^[0-9]{1,6}$` (= version_no as text) | P0 |
| formula_version | text | N | `hs-1` | P0 |
| language | text | N | `en, ne` | P0 |
| approved_set_hash | text | N | `^[0-9a-f]{64}$` | P1 |
| input_result_versions | text[] | N | every `result_id:version_no` of `LabPort.getOrderResults({scope: 'approved'})` — exactly the set hashed into `approved_set_hash`, sorted ascending (not only eligible or mapped results; triage C14 #6). 1–2,000 elements [CONV: covers the largest approved set; 03-APP-FLOW E19], each `<uuid>:<n>` (app-validated) | P1 |
| status | text | N | `draft, approved, rejected, superseded` | P3 (status of a health summary) |
| content | jsonb | N | SmartSummary body (camelCase, 02-TRD §7.1 mapping), canonical | **P3** |
| content_sha256 | text | N | `^[0-9a-f]{64}$` | P1 |
| health_score_value | integer | Y | 0–100; NULL iff band NULL | P3 |
| health_score_band | text | Y | `good, fair, needs_attention` | P3 |
| panels_scored, deranged_count, critical_count, unmapped_result_count, ignored_duplicate_count | integer | N | ≥ 0 | P3 (counts of findings) |
| built_at | timestamptz | N | | P1 |
| approved_at, approved_by_membership_id | timestamptz, uuid | Y | required iff `approved` (kept after supersede) | P1 |
| use_llm_text | boolean | N | default false; true ⇒ `llm_overlay` NOT NULL | P0 |
| llm_overlay | jsonb | Y | `{ run_id, items: { <itemRef>: text } }` — changeable only while `draft` | **P3** |
| rejected_at, rejected_by_membership_id | timestamptz, uuid | Y | required iff `rejected` | P1 |
| reject_reason_code | text | Y | FK `g_cs_summary_reject_reasons` | P0 |
| reject_comment | text | Y | ≤ 500 | P3 (may mention findings) |
| superseded_at | timestamptz | Y | required iff `superseded` | P1 |
| superseded_reason | text | Y | `results_changed, library_rebuild` | P0 |
| superseded_by_summary_id | uuid | Y | FK self | P1 |
| version, created_at, created_by, updated_at, updated_by | | N | std | P1 |

### 2.9 `summary_report_bindings` (A)

id, tenant_id, centre_id, summary_id (FK), order_id (FK orders), report_version_no (integer ≥ 1), bound_at (timestamptz), created_at, created_by. Unique `(tenant_id, summary_id, report_version_no)`. PHI P1.

### 2.10 `summary_reviews` (A)

id, tenant_id, centre_id, summary_id (FK), action (`approved, rejected, superseded, llm_rephrase_requested`), reason_code (Y), comment (Y, ≤ 500, P3), actor_membership_id (Y; NULL for system supersede), created_at, created_by.

Read for `SmartSummaryView.reviews[]` (02-TRD §5.1; 08 A22.1): `action`, `reason_code`, `actor_membership_id` (→ display name), `created_at`, by `summary_reviews__tenant_id_summary_id_created_at__idx`; no schema change.

### 2.11 `llm_runs` (A, Phase 3)

id, tenant_id, centre_id, summary_id (FK), status (`succeeded, partially_passed, validator_failed, failed`), prompt_template_version (`p1`), model_ref (≤ 100), input_sha256 (`^[0-9a-f]{64}$`), items (jsonb: `[{ item_ref, template_text, output_text?, passed, failure_codes[] }]`, P3 by linkage), latency_ms (Y), error_code (Y), created_at, created_by. Inserted once when the run finishes.

## 3. Global tables and seeds

### 3.1 `g_cs_organ_groups` (seed, DECISION; names follow departments/sections observed in 00 §4 and 00 §5)

| code | display | sort |
|---|---|---|
| blood_counts | Blood counts | 10 |
| glucose | Blood sugar | 20 |
| lipids | Cholesterol and lipids | 30 |
| liver | Liver | 40 |
| kidney | Kidney | 50 |
| electrolytes | Electrolytes | 60 |
| thyroid | Thyroid | 70 |
| iron | Iron studies | 80 |
| vitamins | Vitamins | 90 |
| inflammation | Inflammation | 100 |
| hormones | Hormones | 110 |
| immunology | Immunology and serology | 120 |
| urine | Urine examination | 130 |
| stool | Stool examination | 140 |
| vitals | Body measurements | 150 |
| other | Other | 900 |

### 3.2 `g_cs_summary_reject_reasons`

`wording_problem` "Wording not appropriate" (10) · `library_error` "Library rule or text error" (20) · `not_appropriate_for_patient` "Not appropriate for this patient" (30) · `results_under_review` "Results under review" (40) · `other` "Other" (90).

### 3.3 `g_cs_wording_deny_terms`

The 23 English terms of 02-TRD §9.5, `language = 'en'` (`http`, `www.` with `any`), reason "global wording rule (04 R8)".

## 4. Immutability and transition rules

| Table | Rule | Mechanism |
|---|---|---|
| `library_versions` | outside `draft` only lifecycle columns change | `app.enforce_mutable_columns(...)` trigger `WHEN (OLD.status <> 'draft')` |
| `library_versions` | allowed status transitions: draft→draft, draft→in_review, in_review→draft, in_review→approved, approved→retired, and identical-status lifecycle updates | trigger `smartreport.check_library_transition()` |
| `template_blocks`, `rules`, `analyte_groups`, `group_settings` | INSERT/UPDATE (incl. deactivation `is_active = false`) only while parent is `draft`; no DELETE grant (08 A17 P-18(a)) | trigger `smartreport.assert_library_draft()` (also fires on DELETE as defence in depth) |
| `summaries` | content columns immutable from insert; only lifecycle columns change | `app.enforce_mutable_columns(...)` (always) |
| `summaries` | `llm_overlay`, `use_llm_text` change only while `draft` | second `app.enforce_mutable_columns(...)` trigger `WHEN (OLD.status <> 'draft')` without those two columns |
| `summaries` | transitions per 03-APP-FLOW §1.2, incl. the guarded `superseded → superseded` update that only sets `superseded_by_summary_id` once (NULL → id) and changes nothing else except `updated_at`/`updated_by`/`version` (08 A19 D-107) | trigger `smartreport.check_summary_transition()` |
| A tables | no UPDATE/DELETE grant | grants |
| `summaries` | never deleted (class C) | no DELETE grant / policy |
| class M tables | never deleted; removal = `is_active = false` | no DELETE grant / policy |

All errors raise SQLSTATE `P0001` message `immutable_row` (02-CV §5.7) or `invalid_transition` (mapped by the module to `smartreport.library_invalid_transition` / `smartreport.summary_invalid_transition`). The three `smartreport.*` trigger functions are SECURITY INVOKER (not DEFINER — no inventory entry needed, 04 D7), `SET search_path = ''`, schema-qualified.

## 5. Indexes (every query in 02-TRD)

| Query | Index |
|---|---|
| open draft / active version per tenant | partial unique `library_versions__tenant_id__open__p_uq`, `library_versions__tenant_id__approved__p_uq` |
| list versions by number | unique `library_versions__tenant_id_version_no__uq` |
| blocks/rules/mappings/groups of a version | unique keys leading `(tenant_id, library_version_id, …)`; active-row uniqueness `template_blocks__tenant_id_lib_key__p_uq`, `analyte_groups__tenant_id_lib_analyte__p_uq` |
| rules by kind | `rules__tenant_id_library_version_id_rule_kind__idx` |
| live summary of an order (port, consumers) | partial unique `summaries__tenant_id_order_id__live__p_uq` |
| determinism key | unique `summaries__tenant_id_order_id_hash_library__uq` |
| review queue (#27) | `summaries__tenant_id_status_built_at__idx`, `summaries__tenant_id_centre_id_status_built_at__idx` |
| summaries of an order (history) | `summaries__tenant_id_order_id_built_at__idx` |
| bindings by summary | unique `summary_report_bindings__tenant_id_summary_id_version_no__uq` |
| reviews / runs by summary | `summary_reviews__tenant_id_summary_id_created_at__idx`, `llm_runs__tenant_id_summary_id_created_at__idx` |
| deny terms | partial unique `wording_deny_terms__tenant_id_term_folded_language__p_uq` |

## 6. RLS and grants

Every tenant table: ENABLE + FORCE RLS, per-command policies `TO lims_app` (02-CV §5.8, binding X9). Library tables and deny terms are tenant-only (`__tenant`); summary tables are centre-scoped (`__tenant_centre`) because front-desk and centre staff hold `smartreport.summary.read` and are centre-scoped; pathologists at hub labs have `all_centres` (02-CV §5.8 note). System actors (worker) are tenant-wide via `app.has_all_centres()`.

Grants to `lims_app`:

| Table | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|
| library_versions, wording_deny_terms | ✓ | ✓ | ✓ | — |
| template_blocks, rules, analyte_groups, group_settings | ✓ | ✓ | ✓ (draft only, trigger; removal = deactivation) | — (08 A17 P-18(a)) |
| library_reviews, summary_report_bindings, summary_reviews, llm_runs | ✓ | ✓ | — | — |
| summaries | ✓ | ✓ | ✓ | — |
| g_cs_* | ✓ | — | — | — |

`event_inbox` per C0. Global tables are listed in `db/tests/rls_exempt.txt` with reason "global reference, no tenant data".

**`smartreport.*` is staff/system-only (08 A2.3).** No policy on any `smartreport.*` table admits patient, portal, partner or device actors, and none will be added. Non-staff actors do not call `SmartReportPort`; non-staff readers (patient C16, portal C6, partner C13) receive smart-summary content only from the approved `SmartSummary` JSON snapshot C6 stores on every report version assembled with an approved summary — at first assembly or at Regenerate (reason `smart_summary_added`), 08 A4.4 — via `ReportingPort` / portal reads (08 A2.3). C6 05-SCHEMA adds `smart_summary_json jsonb NULL`, `smart_summary_id`, `smart_summary_version` to its report-version table (08 A2.3/A2.8).

Every `__tenant` / `__tenant_centre` policy above requires `(SELECT app.is_staff_or_system())` (CR-C13-011; 08 R10 item 5; 08 A17 P-16) **and** `(SELECT app.current_actor_type()) IN ('user','system')` (08 A19 D-109). `app.is_staff_or_system()` alone admits `device` actors (02-CV §5.8); the positive list excludes them, so device (bridge-agent) claims see no `smartreport.*` row (08 A19.1: `smartreport.*` additionally excludes devices). Centre predicates use `centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])` (08 A16.1). `app.has_all_centres()` is false for non-staff actors (08 R3). Under non-staff or device claims every `smartreport.*` table is therefore invisible (fail-closed). The former read-only `buildSummary` path for patient/portal/partner actors and the open CR for patient SELECT policies on `summaries` are withdrawn (08 A2.3).

## 7. Retention

| Table | Retention | Mechanism |
|---|---|---|
| summaries, summary_report_bindings, summary_reviews, llm_runs | tenant clinical retention (`TenantSettings.retention.clinicalYears`, default 5 y — 04 I8, BLOCKED B15) | no purge in v1 (class C/A; archive handled with reports by the platform) |
| library tables, library_reviews | kept for the life of the tenant (they explain approved texts) | never deleted (M/A) |
| event_inbox | 90 days (C0) | `app.purge_event_inboxes()` |

## 8. Published views

None. 03-IC §6 defines no `smartreport.v_pub_*` view and no consumer reads C14 tables. (A C8 view such as daily summary counts would be a later CR.)

## 9. DDL

```sql
-- =====================================================================
-- smartreport — C14 (spec for C0-0B). Schema exists (C0). Order: G tables,
-- library, children, summaries, A tables, functions/triggers, RLS, grants.
-- =====================================================================

-- ---------- global coded sets (class G, no RLS) ----------
CREATE TABLE smartreport.g_cs_organ_groups (
  code           text        NOT NULL,
  display        text        NOT NULL,
  system         text        NOT NULL DEFAULT 'lims',
  system_version text        NOT NULL DEFAULT '1',
  sort_order     integer     NOT NULL,
  is_active      boolean     NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT g_cs_organ_groups__pk PRIMARY KEY (code),
  CONSTRAINT g_cs_organ_groups__code__ck CHECK (code ~ '^[a-z][a-z0-9_]{1,39}$'),
  CONSTRAINT g_cs_organ_groups__display__ck CHECK (length(display) BETWEEN 1 AND 60)
);
INSERT INTO smartreport.g_cs_organ_groups (code, display, sort_order) VALUES
 ('blood_counts','Blood counts',10),('glucose','Blood sugar',20),('lipids','Cholesterol and lipids',30),
 ('liver','Liver',40),('kidney','Kidney',50),('electrolytes','Electrolytes',60),('thyroid','Thyroid',70),
 ('iron','Iron studies',80),('vitamins','Vitamins',90),('inflammation','Inflammation',100),
 ('hormones','Hormones',110),('immunology','Immunology and serology',120),('urine','Urine examination',130),
 ('stool','Stool examination',140),('vitals','Body measurements',150),('other','Other',900);

CREATE TABLE smartreport.g_cs_summary_reject_reasons (
  code           text        NOT NULL,
  display        text        NOT NULL,
  system         text        NOT NULL DEFAULT 'lims',
  system_version text        NOT NULL DEFAULT '1',
  sort_order     integer     NOT NULL,
  is_active      boolean     NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT g_cs_summary_reject_reasons__pk PRIMARY KEY (code),
  CONSTRAINT g_cs_summary_reject_reasons__code__ck CHECK (code ~ '^[a-z][a-z0-9_]{1,39}$')
);
INSERT INTO smartreport.g_cs_summary_reject_reasons (code, display, sort_order) VALUES
 ('wording_problem','Wording not appropriate',10),('library_error','Library rule or text error',20),
 ('not_appropriate_for_patient','Not appropriate for this patient',30),
 ('results_under_review','Results under review',40),('other','Other',90);

CREATE TABLE smartreport.g_cs_wording_deny_terms (
  term_folded text        NOT NULL,
  term        text        NOT NULL,
  language    text        NOT NULL,
  reason      text        NOT NULL,
  is_active   boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT g_cs_wording_deny_terms__pk PRIMARY KEY (term_folded, language),
  CONSTRAINT g_cs_wording_deny_terms__language__ck CHECK (language IN ('en','ne','any'))
);
INSERT INTO smartreport.g_cs_wording_deny_terms (term_folded, term, language, reason)
SELECT t, t, CASE WHEN t IN ('http','www.') THEN 'any' ELSE 'en' END, 'global wording rule (04 R8)'
FROM unnest(ARRAY['diagnos','cure','guarantee','buy','order now','discount','offer','supplement','capsule',
  'tablet','dose','prescri','medicine','herbal','ayurved','price','rs.','npr','call us','hotline','whatsapp',
  'http','www.']) AS t;

-- ---------- library versions (class M) ----------
CREATE TABLE smartreport.library_versions (
  id                              uuid        NOT NULL,
  tenant_id                       uuid        NOT NULL,
  version_no                      integer     NOT NULL,
  status                          text        NOT NULL DEFAULT 'draft',
  language                        text        NOT NULL DEFAULT 'en',
  formula_version                 text        NOT NULL DEFAULT 'hs-1',
  score_enabled                   boolean     NOT NULL DEFAULT true,
  credit_in_range_bp              integer     NOT NULL DEFAULT 10000,
  credit_borderline_bp            integer     NOT NULL DEFAULT 5000,
  credit_out_of_range_bp          integer     NOT NULL DEFAULT 0,
  credit_critical_bp              integer     NOT NULL DEFAULT 0,
  min_groups_scored               integer     NOT NULL DEFAULT 2,
  band_good_min                   integer     NOT NULL DEFAULT 80,
  band_fair_min                   integer     NOT NULL DEFAULT 60,
  critical_forces_needs_attention boolean     NOT NULL DEFAULT true,
  borderline_fraction_bp          integer     NOT NULL DEFAULT 0,
  min_mapped_results              integer     NOT NULL DEFAULT 3,
  trend_enabled                   boolean     NOT NULL DEFAULT true,
  trend_max_points                integer     NOT NULL DEFAULT 4,
  trend_lookback_days             integer     NOT NULL DEFAULT 730,
  trend_stable_bp                 integer     NOT NULL DEFAULT 1000,
  trends_max                      integer     NOT NULL DEFAULT 6,
  advice_max_blocks               integer     NOT NULL DEFAULT 5,
  followup_max                    integer     NOT NULL DEFAULT 3,
  source_version_id               uuid,
  change_summary                  text,
  content_sha256                  text,
  submitted_at                    timestamptz,
  submitted_by_membership_id      uuid,
  approved_at                     timestamptz,
  approved_by_membership_id       uuid,
  approval_note                   text,
  returned_at                     timestamptz,
  returned_by_membership_id       uuid,
  return_comment                  text,
  retired_at                      timestamptz,
  version                         integer     NOT NULL DEFAULT 1,
  is_active                       boolean     NOT NULL DEFAULT true,
  created_at                      timestamptz NOT NULL DEFAULT now(),
  created_by                      uuid        NOT NULL,
  updated_at                      timestamptz NOT NULL DEFAULT now(),
  updated_by                      uuid        NOT NULL,
  CONSTRAINT library_versions__pk PRIMARY KEY (id),
  CONSTRAINT library_versions__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT library_versions__tenant_id_version_no__uq UNIQUE (tenant_id, version_no),
  CONSTRAINT library_versions__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT library_versions__source__fk FOREIGN KEY (tenant_id, source_version_id) REFERENCES smartreport.library_versions (tenant_id, id),
  CONSTRAINT library_versions__submitted_by__fk FOREIGN KEY (tenant_id, submitted_by_membership_id) REFERENCES core.memberships (tenant_id, id),
  CONSTRAINT library_versions__approved_by__fk FOREIGN KEY (tenant_id, approved_by_membership_id) REFERENCES core.memberships (tenant_id, id),
  CONSTRAINT library_versions__returned_by__fk FOREIGN KEY (tenant_id, returned_by_membership_id) REFERENCES core.memberships (tenant_id, id),
  CONSTRAINT library_versions__version_no__ck CHECK (version_no >= 1),
  CONSTRAINT library_versions__status__ck CHECK (status IN ('draft','in_review','approved','retired')),
  CONSTRAINT library_versions__language__ck CHECK (language IN ('en','ne')),
  CONSTRAINT library_versions__formula__ck CHECK (formula_version IN ('hs-1')),
  CONSTRAINT library_versions__credits__ck CHECK (
    credit_in_range_bp BETWEEN 0 AND 10000 AND credit_borderline_bp BETWEEN 0 AND 10000 AND
    credit_out_of_range_bp BETWEEN 0 AND 10000 AND credit_critical_bp BETWEEN 0 AND 10000 AND
    credit_in_range_bp >= credit_borderline_bp AND credit_borderline_bp >= credit_out_of_range_bp AND
    credit_out_of_range_bp >= credit_critical_bp),
  CONSTRAINT library_versions__bands__ck CHECK (band_good_min BETWEEN 1 AND 100 AND band_fair_min BETWEEN 0 AND 99 AND band_fair_min < band_good_min),
  CONSTRAINT library_versions__params__ck CHECK (
    min_groups_scored BETWEEN 1 AND 20 AND borderline_fraction_bp BETWEEN 0 AND 2500 AND
    min_mapped_results BETWEEN 1 AND 50 AND trend_max_points BETWEEN 2 AND 6 AND
    trend_lookback_days BETWEEN 30 AND 3650 AND trend_stable_bp BETWEEN 0 AND 5000 AND
    trends_max BETWEEN 0 AND 12 AND advice_max_blocks BETWEEN 0 AND 10 AND followup_max BETWEEN 0 AND 5),
  CONSTRAINT library_versions__texts__ck CHECK (length(change_summary) <= 500 AND length(approval_note) <= 500 AND length(return_comment) <= 1000),
  CONSTRAINT library_versions__hash__ck CHECK (
    (status = 'draft') OR (content_sha256 ~ '^[0-9a-f]{64}$')),
  CONSTRAINT library_versions__approved_fields__ck CHECK (
    status NOT IN ('approved','retired') OR (approved_at IS NOT NULL AND approved_by_membership_id IS NOT NULL)),
  CONSTRAINT library_versions__retired_fields__ck CHECK (status <> 'retired' OR retired_at IS NOT NULL)
);
CREATE UNIQUE INDEX library_versions__tenant_id__open__p_uq ON smartreport.library_versions (tenant_id)
  WHERE status IN ('draft','in_review');
CREATE UNIQUE INDEX library_versions__tenant_id__approved__p_uq ON smartreport.library_versions (tenant_id)
  WHERE status = 'approved';

-- ---------- template blocks ----------
CREATE TABLE smartreport.template_blocks (
  id                 uuid        NOT NULL,
  tenant_id          uuid        NOT NULL,
  library_version_id uuid        NOT NULL,
  block_key          text        NOT NULL,
  kind               text        NOT NULL,
  text_en            text,
  text_ne            text,
  note               text,
  version            integer     NOT NULL DEFAULT 1,
  is_active          boolean     NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid        NOT NULL,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         uuid        NOT NULL,
  CONSTRAINT template_blocks__pk PRIMARY KEY (id),
  CONSTRAINT template_blocks__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT template_blocks__tenant_id_lib_id_kind__uq UNIQUE (tenant_id, library_version_id, id, kind),
  CONSTRAINT template_blocks__library__fk FOREIGN KEY (tenant_id, library_version_id) REFERENCES smartreport.library_versions (tenant_id, id),
  CONSTRAINT template_blocks__key__ck CHECK (block_key ~ '^[a-z][a-z0-9_.]{2,79}$'),
  CONSTRAINT template_blocks__kind__ck CHECK (kind IN ('deranged','advice','followup','disclaimer','score_explanation')),
  CONSTRAINT template_blocks__text__ck CHECK ((text_en IS NOT NULL OR text_ne IS NOT NULL)
    AND coalesce(length(text_en), 0) <= 600 AND coalesce(length(text_ne), 0) <= 600 AND coalesce(length(note), 0) <= 500)
);
-- 08 A17 P-18(a) / 02-CV §5.2: a removed block is deactivated (is_active = false), never deleted; the key is unique among active rows
CREATE UNIQUE INDEX template_blocks__tenant_id_lib_key__p_uq ON smartreport.template_blocks (tenant_id, library_version_id, block_key)
  WHERE is_active;

-- ---------- rules ----------
CREATE TABLE smartreport.rules (
  id                 uuid        NOT NULL,
  tenant_id          uuid        NOT NULL,
  library_version_id uuid        NOT NULL,
  rule_kind          text        NOT NULL,
  trigger_kind       text        NOT NULL,
  analyte_id         uuid,
  group_code         text,
  direction          text        NOT NULL,
  min_severity       text,
  priority           integer     NOT NULL DEFAULT 100,
  block_id           uuid        NOT NULL,
  block_kind         text        NOT NULL,
  suggested_test_id  uuid,
  interval_days      integer,
  version            integer     NOT NULL DEFAULT 1,
  is_active          boolean     NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid        NOT NULL,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         uuid        NOT NULL,
  CONSTRAINT rules__pk PRIMARY KEY (id),
  CONSTRAINT rules__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT rules__library__fk FOREIGN KEY (tenant_id, library_version_id) REFERENCES smartreport.library_versions (tenant_id, id),
  CONSTRAINT rules__block__fk FOREIGN KEY (tenant_id, library_version_id, block_id, block_kind)
    REFERENCES smartreport.template_blocks (tenant_id, library_version_id, id, kind),
  CONSTRAINT rules__analyte__fk FOREIGN KEY (tenant_id, analyte_id) REFERENCES catalog.analytes (tenant_id, id),
  CONSTRAINT rules__group__fk FOREIGN KEY (group_code) REFERENCES smartreport.g_cs_organ_groups (code),
  CONSTRAINT rules__test__fk FOREIGN KEY (tenant_id, suggested_test_id) REFERENCES catalog.tests (tenant_id, id),
  CONSTRAINT rules__kind__ck CHECK (rule_kind IN ('deranged','advice','followup') AND block_kind = rule_kind),
  CONSTRAINT rules__trigger__ck CHECK (trigger_kind IN ('analyte','group','any','all_in_range')),
  CONSTRAINT rules__direction__ck CHECK (direction IN ('low','high','abnormal','any')),
  CONSTRAINT rules__severity__ck CHECK (min_severity IS NULL OR min_severity IN ('borderline','out_of_range','critical')),
  CONSTRAINT rules__priority__ck CHECK (priority BETWEEN 1 AND 999),
  CONSTRAINT rules__trigger_fields__ck CHECK (
       (trigger_kind = 'analyte'      AND analyte_id IS NOT NULL AND group_code IS NULL AND min_severity IS NOT NULL)
    OR (trigger_kind = 'group'        AND group_code IS NOT NULL AND analyte_id IS NULL AND min_severity IS NOT NULL)
    OR (trigger_kind = 'any'          AND analyte_id IS NULL AND group_code IS NULL AND min_severity IS NOT NULL)
    OR (trigger_kind = 'all_in_range' AND analyte_id IS NULL AND group_code IS NULL AND min_severity IS NULL
        AND direction = 'any' AND rule_kind = 'advice')),
  CONSTRAINT rules__followup_fields__ck CHECK (
       (rule_kind = 'followup' AND suggested_test_id IS NOT NULL AND interval_days BETWEEN 1 AND 730)
    OR (rule_kind <> 'followup' AND suggested_test_id IS NULL AND interval_days IS NULL))
);
CREATE INDEX rules__tenant_id_library_version_id_rule_kind__idx ON smartreport.rules (tenant_id, library_version_id, rule_kind, trigger_kind);
CREATE INDEX rules__tenant_id_block__idx ON smartreport.rules (tenant_id, library_version_id, block_id);

-- ---------- analyte → group mapping ----------
CREATE TABLE smartreport.analyte_groups (
  id                     uuid        NOT NULL,
  tenant_id              uuid        NOT NULL,
  library_version_id     uuid        NOT NULL,
  analyte_id             uuid        NOT NULL,
  group_code             text        NOT NULL,
  include_in_score       boolean     NOT NULL DEFAULT true,
  trend_enabled          boolean     NOT NULL DEFAULT false,
  borderline_fraction_bp integer,
  trend_stable_bp        integer,
  sort_order             integer     NOT NULL DEFAULT 100,
  version                integer     NOT NULL DEFAULT 1,
  is_active              boolean     NOT NULL DEFAULT true,
  created_at             timestamptz NOT NULL DEFAULT now(),
  created_by             uuid        NOT NULL,
  updated_at             timestamptz NOT NULL DEFAULT now(),
  updated_by             uuid        NOT NULL,
  CONSTRAINT analyte_groups__pk PRIMARY KEY (id),
  CONSTRAINT analyte_groups__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT analyte_groups__library__fk FOREIGN KEY (tenant_id, library_version_id) REFERENCES smartreport.library_versions (tenant_id, id),
  CONSTRAINT analyte_groups__analyte__fk FOREIGN KEY (tenant_id, analyte_id) REFERENCES catalog.analytes (tenant_id, id),
  CONSTRAINT analyte_groups__group__fk FOREIGN KEY (group_code) REFERENCES smartreport.g_cs_organ_groups (code),
  CONSTRAINT analyte_groups__params__ck CHECK (
    (borderline_fraction_bp IS NULL OR borderline_fraction_bp BETWEEN 0 AND 2500) AND
    (trend_stable_bp IS NULL OR trend_stable_bp BETWEEN 0 AND 5000) AND sort_order BETWEEN 0 AND 9999)
);
-- one active mapping per analyte per version; a removed mapping stays as an inactive row (08 A17 P-18(a))
CREATE UNIQUE INDEX analyte_groups__tenant_id_lib_analyte__p_uq ON smartreport.analyte_groups (tenant_id, library_version_id, analyte_id)
  WHERE is_active;

-- ---------- group settings ----------
CREATE TABLE smartreport.group_settings (
  id                 uuid        NOT NULL,
  tenant_id          uuid        NOT NULL,
  library_version_id uuid        NOT NULL,
  group_code         text        NOT NULL,
  display_en         text        NOT NULL,
  display_ne         text,
  score_weight       integer     NOT NULL DEFAULT 1,
  sort_order         integer     NOT NULL,
  is_shown           boolean     NOT NULL DEFAULT true,
  version            integer     NOT NULL DEFAULT 1,
  is_active          boolean     NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid        NOT NULL,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         uuid        NOT NULL,
  CONSTRAINT group_settings__pk PRIMARY KEY (id),
  CONSTRAINT group_settings__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT group_settings__tenant_id_lib_group__uq UNIQUE (tenant_id, library_version_id, group_code),
  CONSTRAINT group_settings__library__fk FOREIGN KEY (tenant_id, library_version_id) REFERENCES smartreport.library_versions (tenant_id, id),
  CONSTRAINT group_settings__group__fk FOREIGN KEY (group_code) REFERENCES smartreport.g_cs_organ_groups (code),
  CONSTRAINT group_settings__display__ck CHECK (length(display_en) BETWEEN 1 AND 60 AND coalesce(length(display_ne), 0) <= 60),
  CONSTRAINT group_settings__weight__ck CHECK (score_weight BETWEEN 0 AND 10 AND sort_order BETWEEN 0 AND 9999)
);

-- ---------- tenant deny terms ----------
CREATE TABLE smartreport.wording_deny_terms (
  id          uuid        NOT NULL,
  tenant_id   uuid        NOT NULL,
  term        text        NOT NULL,
  term_folded text        NOT NULL,
  language    text        NOT NULL,
  reason      text,
  version     integer     NOT NULL DEFAULT 1,
  is_active   boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid        NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid        NOT NULL,
  CONSTRAINT wording_deny_terms__pk PRIMARY KEY (id),
  CONSTRAINT wording_deny_terms__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT wording_deny_terms__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT wording_deny_terms__term__ck CHECK (length(term) BETWEEN 2 AND 60 AND length(term_folded) BETWEEN 1 AND 60
    AND coalesce(length(reason), 0) <= 200),
  CONSTRAINT wording_deny_terms__language__ck CHECK (language IN ('en','ne','any'))
);
CREATE UNIQUE INDEX wording_deny_terms__tenant_id_term_folded_language__p_uq
  ON smartreport.wording_deny_terms (tenant_id, term_folded, language) WHERE is_active;

-- ---------- library reviews (class A) ----------
CREATE TABLE smartreport.library_reviews (
  id                  uuid        NOT NULL,
  tenant_id           uuid        NOT NULL,
  library_version_id  uuid        NOT NULL,
  action              text        NOT NULL,
  comment             text,
  content_sha256      text,
  actor_membership_id uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid        NOT NULL,
  CONSTRAINT library_reviews__pk PRIMARY KEY (id),
  CONSTRAINT library_reviews__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT library_reviews__library__fk FOREIGN KEY (tenant_id, library_version_id) REFERENCES smartreport.library_versions (tenant_id, id),
  CONSTRAINT library_reviews__actor__fk FOREIGN KEY (tenant_id, actor_membership_id) REFERENCES core.memberships (tenant_id, id),
  CONSTRAINT library_reviews__action__ck CHECK (action IN ('submitted','returned','approved','retired')),
  CONSTRAINT library_reviews__comment__ck CHECK (coalesce(length(comment), 0) <= 1000)
);
CREATE INDEX library_reviews__tenant_id_library_version_id_created_at__idx
  ON smartreport.library_reviews (tenant_id, library_version_id, created_at);

-- ---------- summaries (class C, centre-scoped) ----------
CREATE TABLE smartreport.summaries (
  id                        uuid        NOT NULL,
  tenant_id                 uuid        NOT NULL,
  centre_id                 uuid        NOT NULL,
  order_id                  uuid        NOT NULL,
  patient_id                uuid        NOT NULL,
  library_version_id        uuid        NOT NULL,
  template_library_version  text        NOT NULL,
  formula_version           text        NOT NULL,
  language                  text        NOT NULL,
  approved_set_hash         text        NOT NULL,
  input_result_versions     text[]      NOT NULL,
  status                    text        NOT NULL DEFAULT 'draft',
  content                   jsonb       NOT NULL,
  content_sha256            text        NOT NULL,
  health_score_value        integer,
  health_score_band         text,
  panels_scored             integer     NOT NULL DEFAULT 0,
  deranged_count            integer     NOT NULL DEFAULT 0,
  critical_count            integer     NOT NULL DEFAULT 0,
  unmapped_result_count     integer     NOT NULL DEFAULT 0,
  ignored_duplicate_count   integer     NOT NULL DEFAULT 0,
  built_at                  timestamptz NOT NULL,
  approved_at               timestamptz,
  approved_by_membership_id uuid,
  use_llm_text              boolean     NOT NULL DEFAULT false,
  llm_overlay               jsonb,
  rejected_at               timestamptz,
  rejected_by_membership_id uuid,
  reject_reason_code        text,
  reject_comment            text,
  superseded_at             timestamptz,
  superseded_reason         text,
  superseded_by_summary_id  uuid,
  version                   integer     NOT NULL DEFAULT 1,
  created_at                timestamptz NOT NULL DEFAULT now(),
  created_by                uuid        NOT NULL,
  updated_at                timestamptz NOT NULL DEFAULT now(),
  updated_by                uuid        NOT NULL,
  CONSTRAINT summaries__pk PRIMARY KEY (id),
  CONSTRAINT summaries__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT summaries__tenant_id_order_id_hash_library__uq UNIQUE (tenant_id, order_id, approved_set_hash, library_version_id),
  CONSTRAINT summaries__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT summaries__centre__fk FOREIGN KEY (tenant_id, centre_id) REFERENCES core.collection_centres (tenant_id, id),
  CONSTRAINT summaries__order__fk FOREIGN KEY (tenant_id, order_id) REFERENCES frontdesk.orders (tenant_id, id),
  CONSTRAINT summaries__patient__fk FOREIGN KEY (tenant_id, patient_id) REFERENCES frontdesk.patients (tenant_id, id),
  CONSTRAINT summaries__library__fk FOREIGN KEY (tenant_id, library_version_id) REFERENCES smartreport.library_versions (tenant_id, id),
  CONSTRAINT summaries__approved_by__fk FOREIGN KEY (tenant_id, approved_by_membership_id) REFERENCES core.memberships (tenant_id, id),
  CONSTRAINT summaries__rejected_by__fk FOREIGN KEY (tenant_id, rejected_by_membership_id) REFERENCES core.memberships (tenant_id, id),
  CONSTRAINT summaries__superseded_by__fk FOREIGN KEY (tenant_id, superseded_by_summary_id) REFERENCES smartreport.summaries (tenant_id, id),
  CONSTRAINT summaries__reject_reason__fk FOREIGN KEY (reject_reason_code) REFERENCES smartreport.g_cs_summary_reject_reasons (code),
  CONSTRAINT summaries__status__ck CHECK (status IN ('draft','approved','rejected','superseded')),
  CONSTRAINT summaries__formula__ck CHECK (formula_version IN ('hs-1')),
  CONSTRAINT summaries__language__ck CHECK (language IN ('en','ne')),
  CONSTRAINT summaries__lib_version_text__ck CHECK (template_library_version ~ '^[0-9]{1,6}$'),
  CONSTRAINT summaries__hashes__ck CHECK (approved_set_hash ~ '^[0-9a-f]{64}$' AND content_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT summaries__inputs__ck CHECK (cardinality(input_result_versions) BETWEEN 1 AND 2000),  -- [CONV] 2,000 (triage C14 #6/m#15)
  CONSTRAINT summaries__score__ck CHECK (
       (health_score_value IS NULL AND health_score_band IS NULL)
    OR (health_score_value BETWEEN 0 AND 100 AND health_score_band IN ('good','fair','needs_attention'))),
  CONSTRAINT summaries__counts__ck CHECK (panels_scored >= 0 AND deranged_count >= 0 AND critical_count >= 0
    AND unmapped_result_count >= 0 AND ignored_duplicate_count >= 0),
  CONSTRAINT summaries__approved_fields__ck CHECK (status <> 'approved' OR (approved_at IS NOT NULL AND approved_by_membership_id IS NOT NULL)),
  CONSTRAINT summaries__rejected_fields__ck CHECK (status <> 'rejected' OR (rejected_at IS NOT NULL AND rejected_by_membership_id IS NOT NULL AND reject_reason_code IS NOT NULL)),
  CONSTRAINT summaries__superseded_fields__ck CHECK (status <> 'superseded' OR (superseded_at IS NOT NULL AND superseded_reason IN ('results_changed','library_rebuild'))),
  CONSTRAINT summaries__llm__ck CHECK (NOT use_llm_text OR llm_overlay IS NOT NULL),
  CONSTRAINT summaries__reject_comment__ck CHECK (coalesce(length(reject_comment), 0) <= 500)
);
CREATE UNIQUE INDEX summaries__tenant_id_order_id__live__p_uq ON smartreport.summaries (tenant_id, order_id)
  WHERE status IN ('draft','approved','rejected');
CREATE INDEX summaries__tenant_id_status_built_at__idx ON smartreport.summaries (tenant_id, status, built_at, id);
CREATE INDEX summaries__tenant_id_centre_id_status_built_at__idx ON smartreport.summaries (tenant_id, centre_id, status, built_at, id);
CREATE INDEX summaries__tenant_id_order_id_built_at__idx ON smartreport.summaries (tenant_id, order_id, built_at DESC);

-- ---------- bindings, reviews, LLM runs (class A, centre-scoped) ----------
CREATE TABLE smartreport.summary_report_bindings (
  id                uuid        NOT NULL,
  tenant_id         uuid        NOT NULL,
  centre_id         uuid        NOT NULL,
  summary_id        uuid        NOT NULL,
  order_id          uuid        NOT NULL,
  report_version_no integer     NOT NULL,
  bound_at          timestamptz NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid        NOT NULL,
  CONSTRAINT summary_report_bindings__pk PRIMARY KEY (id),
  CONSTRAINT summary_report_bindings__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT summary_report_bindings__tenant_id_summary_id_version_no__uq UNIQUE (tenant_id, summary_id, report_version_no),
  CONSTRAINT summary_report_bindings__summary__fk FOREIGN KEY (tenant_id, summary_id) REFERENCES smartreport.summaries (tenant_id, id),
  CONSTRAINT summary_report_bindings__order__fk FOREIGN KEY (tenant_id, order_id) REFERENCES frontdesk.orders (tenant_id, id),
  CONSTRAINT summary_report_bindings__centre__fk FOREIGN KEY (tenant_id, centre_id) REFERENCES core.collection_centres (tenant_id, id),
  CONSTRAINT summary_report_bindings__version__ck CHECK (report_version_no >= 1)
);

CREATE TABLE smartreport.summary_reviews (
  id                  uuid        NOT NULL,
  tenant_id           uuid        NOT NULL,
  centre_id           uuid        NOT NULL,
  summary_id          uuid        NOT NULL,
  action              text        NOT NULL,
  reason_code         text,
  comment             text,
  actor_membership_id uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid        NOT NULL,
  CONSTRAINT summary_reviews__pk PRIMARY KEY (id),
  CONSTRAINT summary_reviews__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT summary_reviews__summary__fk FOREIGN KEY (tenant_id, summary_id) REFERENCES smartreport.summaries (tenant_id, id),
  CONSTRAINT summary_reviews__centre__fk FOREIGN KEY (tenant_id, centre_id) REFERENCES core.collection_centres (tenant_id, id),
  CONSTRAINT summary_reviews__actor__fk FOREIGN KEY (tenant_id, actor_membership_id) REFERENCES core.memberships (tenant_id, id),
  CONSTRAINT summary_reviews__action__ck CHECK (action IN ('approved','rejected','superseded','llm_rephrase_requested')),
  CONSTRAINT summary_reviews__comment__ck CHECK (coalesce(length(comment), 0) <= 500)
);
CREATE INDEX summary_reviews__tenant_id_summary_id_created_at__idx ON smartreport.summary_reviews (tenant_id, summary_id, created_at);

CREATE TABLE smartreport.llm_runs (
  id                      uuid        NOT NULL,
  tenant_id               uuid        NOT NULL,
  centre_id               uuid        NOT NULL,
  summary_id              uuid        NOT NULL,
  status                  text        NOT NULL,
  prompt_template_version text        NOT NULL,
  model_ref               text        NOT NULL,
  input_sha256            text        NOT NULL,
  items                   jsonb       NOT NULL,
  latency_ms              integer,
  error_code              text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  created_by              uuid        NOT NULL,
  CONSTRAINT llm_runs__pk PRIMARY KEY (id),
  CONSTRAINT llm_runs__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT llm_runs__summary__fk FOREIGN KEY (tenant_id, summary_id) REFERENCES smartreport.summaries (tenant_id, id),
  CONSTRAINT llm_runs__centre__fk FOREIGN KEY (tenant_id, centre_id) REFERENCES core.collection_centres (tenant_id, id),
  CONSTRAINT llm_runs__status__ck CHECK (status IN ('succeeded','partially_passed','validator_failed','failed')),
  CONSTRAINT llm_runs__prompt__ck CHECK (prompt_template_version ~ '^p[0-9]{1,3}$'),
  CONSTRAINT llm_runs__model__ck CHECK (length(model_ref) BETWEEN 1 AND 100),
  CONSTRAINT llm_runs__hash__ck CHECK (input_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT llm_runs__latency__ck CHECK (latency_ms IS NULL OR latency_ms >= 0)
);
CREATE INDEX llm_runs__tenant_id_summary_id_created_at__idx ON smartreport.llm_runs (tenant_id, summary_id, created_at);

-- ---------- trigger functions (SECURITY INVOKER) ----------
CREATE FUNCTION smartreport.assert_library_draft() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE v_status text;
BEGIN
  SELECT lv.status INTO v_status FROM smartreport.library_versions lv
   WHERE lv.tenant_id = (CASE WHEN TG_OP = 'DELETE' THEN OLD.tenant_id ELSE NEW.tenant_id END)
     AND lv.id = (CASE WHEN TG_OP = 'DELETE' THEN OLD.library_version_id ELSE NEW.library_version_id END);
  IF v_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME;
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.library_version_id <> OLD.library_version_id OR NEW.tenant_id <> OLD.tenant_id) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;

CREATE FUNCTION smartreport.check_library_transition() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NOT ((OLD.status, NEW.status) IN (('draft','draft'),('draft','in_review'),('in_review','draft'),
          ('in_review','approved'),('approved','retired'),('in_review','in_review'),('approved','approved'),('retired','retired'))) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'invalid_transition', DETAIL = 'smartreport.library_versions';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION smartreport.check_summary_transition() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NOT ((OLD.status, NEW.status) IN (('draft','draft'),('draft','approved'),('draft','rejected'),('draft','superseded'),
          ('approved','superseded'),('rejected','superseded'),('superseded','superseded'))) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'invalid_transition', DETAIL = 'smartreport.summaries';
  END IF;
  -- 08 A19 D-107: superseded → superseded only sets superseded_by_summary_id once (NULL → id); nothing else changes
  IF OLD.status = 'superseded' AND NEW.status = 'superseded' AND (OLD.superseded_by_summary_id IS NOT NULL
     OR (to_jsonb(NEW) - ARRAY['superseded_by_summary_id','updated_at','updated_by','version'])
        IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['superseded_by_summary_id','updated_at','updated_by','version'])) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'invalid_transition', DETAIL = 'smartreport.summaries';
  END IF;
  RETURN NEW;
END $$;

-- ---------- triggers ----------
CREATE TRIGGER library_versions__transition BEFORE UPDATE ON smartreport.library_versions
  FOR EACH ROW EXECUTE FUNCTION smartreport.check_library_transition();
CREATE TRIGGER library_versions__mutable_columns BEFORE UPDATE ON smartreport.library_versions
  FOR EACH ROW WHEN (OLD.status <> 'draft') EXECUTE FUNCTION app.enforce_mutable_columns(
    'status','submitted_at','submitted_by_membership_id','approved_at','approved_by_membership_id','approval_note',
    'returned_at','returned_by_membership_id','return_comment','retired_at','updated_at','updated_by','version');

CREATE TRIGGER template_blocks__draft_only BEFORE INSERT OR UPDATE OR DELETE ON smartreport.template_blocks
  FOR EACH ROW EXECUTE FUNCTION smartreport.assert_library_draft();
CREATE TRIGGER rules__draft_only BEFORE INSERT OR UPDATE OR DELETE ON smartreport.rules
  FOR EACH ROW EXECUTE FUNCTION smartreport.assert_library_draft();
CREATE TRIGGER analyte_groups__draft_only BEFORE INSERT OR UPDATE OR DELETE ON smartreport.analyte_groups
  FOR EACH ROW EXECUTE FUNCTION smartreport.assert_library_draft();
CREATE TRIGGER group_settings__draft_only BEFORE INSERT OR UPDATE OR DELETE ON smartreport.group_settings
  FOR EACH ROW EXECUTE FUNCTION smartreport.assert_library_draft();

CREATE TRIGGER summaries__transition BEFORE UPDATE ON smartreport.summaries
  FOR EACH ROW EXECUTE FUNCTION smartreport.check_summary_transition();
CREATE TRIGGER summaries__mutable_columns BEFORE UPDATE ON smartreport.summaries
  FOR EACH ROW EXECUTE FUNCTION app.enforce_mutable_columns(
    'status','approved_at','approved_by_membership_id','use_llm_text','llm_overlay','rejected_at',
    'rejected_by_membership_id','reject_reason_code','reject_comment','superseded_at','superseded_reason',
    'superseded_by_summary_id','updated_at','updated_by','version');
CREATE TRIGGER summaries__llm_draft_only BEFORE UPDATE ON smartreport.summaries
  FOR EACH ROW WHEN (OLD.status <> 'draft') EXECUTE FUNCTION app.enforce_mutable_columns(
    'status','approved_at','approved_by_membership_id','rejected_at','rejected_by_membership_id','reject_reason_code',
    'reject_comment','superseded_at','superseded_reason','superseded_by_summary_id','updated_at','updated_by','version');
-- C0 attaches its generic audit trigger (04 D11) to every table above except the class-A tables and event_inbox.

-- ---------- RLS: tenant-only tables ----------
-- 08 A2.3 + CR-C13-011 (08 R10 item 5) + 08 A17 P-16: every policy carries app.is_staff_or_system(); 08 A19 D-109: every policy
-- also carries app.current_actor_type() IN ('user','system') (no device, patient, portal or partner access); 08 A16.1: ::uuid[] cast.
-- Template for each T in (library_versions, template_blocks, rules, analyte_groups, group_settings,
--                         wording_deny_terms, library_reviews); written out in full below.
ALTER TABLE smartreport.library_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE smartreport.library_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY library_versions__select__tenant ON smartreport.library_versions FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system'));
CREATE POLICY library_versions__insert__tenant ON smartreport.library_versions FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system'));
CREATE POLICY library_versions__update__tenant ON smartreport.library_versions FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system')) WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system'));

ALTER TABLE smartreport.template_blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE smartreport.template_blocks FORCE ROW LEVEL SECURITY;
CREATE POLICY template_blocks__select__tenant ON smartreport.template_blocks FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system'));
CREATE POLICY template_blocks__insert__tenant ON smartreport.template_blocks FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system'));
CREATE POLICY template_blocks__update__tenant ON smartreport.template_blocks FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system')) WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system'));

ALTER TABLE smartreport.rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE smartreport.rules FORCE ROW LEVEL SECURITY;
CREATE POLICY rules__select__tenant ON smartreport.rules FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system'));
CREATE POLICY rules__insert__tenant ON smartreport.rules FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system'));
CREATE POLICY rules__update__tenant ON smartreport.rules FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system')) WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system'));

ALTER TABLE smartreport.analyte_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE smartreport.analyte_groups FORCE ROW LEVEL SECURITY;
CREATE POLICY analyte_groups__select__tenant ON smartreport.analyte_groups FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system'));
CREATE POLICY analyte_groups__insert__tenant ON smartreport.analyte_groups FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system'));
CREATE POLICY analyte_groups__update__tenant ON smartreport.analyte_groups FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system')) WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system'));

ALTER TABLE smartreport.group_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE smartreport.group_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY group_settings__select__tenant ON smartreport.group_settings FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system'));
CREATE POLICY group_settings__insert__tenant ON smartreport.group_settings FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system'));
CREATE POLICY group_settings__update__tenant ON smartreport.group_settings FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system')) WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system'));

ALTER TABLE smartreport.wording_deny_terms ENABLE ROW LEVEL SECURITY;
ALTER TABLE smartreport.wording_deny_terms FORCE ROW LEVEL SECURITY;
CREATE POLICY wording_deny_terms__select__tenant ON smartreport.wording_deny_terms FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system'));
CREATE POLICY wording_deny_terms__insert__tenant ON smartreport.wording_deny_terms FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system'));
CREATE POLICY wording_deny_terms__update__tenant ON smartreport.wording_deny_terms FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system')) WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system'));

ALTER TABLE smartreport.library_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE smartreport.library_reviews FORCE ROW LEVEL SECURITY;
CREATE POLICY library_reviews__select__tenant ON smartreport.library_reviews FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system'));
CREATE POLICY library_reviews__insert__tenant ON smartreport.library_reviews FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system'));

-- ---------- RLS: centre-scoped tables ----------
ALTER TABLE smartreport.summaries ENABLE ROW LEVEL SECURITY;
ALTER TABLE smartreport.summaries FORCE ROW LEVEL SECURITY;
CREATE POLICY summaries__select__tenant_centre ON smartreport.summaries FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system')
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY summaries__insert__tenant_centre ON smartreport.summaries FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system')
              AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY summaries__update__tenant_centre ON smartreport.summaries FOR UPDATE TO lims_app
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system')
              AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system')
              AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));

ALTER TABLE smartreport.summary_report_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE smartreport.summary_report_bindings FORCE ROW LEVEL SECURITY;
CREATE POLICY summary_report_bindings__select__tenant_centre ON smartreport.summary_report_bindings FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system')
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY summary_report_bindings__insert__tenant_centre ON smartreport.summary_report_bindings FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system')
              AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));

ALTER TABLE smartreport.summary_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE smartreport.summary_reviews FORCE ROW LEVEL SECURITY;
CREATE POLICY summary_reviews__select__tenant_centre ON smartreport.summary_reviews FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system')
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY summary_reviews__insert__tenant_centre ON smartreport.summary_reviews FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system')
              AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));

ALTER TABLE smartreport.llm_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE smartreport.llm_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY llm_runs__select__tenant_centre ON smartreport.llm_runs FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system')
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY llm_runs__insert__tenant_centre ON smartreport.llm_runs FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system')
              AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
-- no DELETE policy on any smartreport table (default deny, REQ-SEC-016; class M rows are deactivated — 08 A17 P-18(a))

-- ---------- grants ----------
GRANT SELECT ON smartreport.g_cs_organ_groups, smartreport.g_cs_summary_reject_reasons,
                smartreport.g_cs_wording_deny_terms TO lims_app;
GRANT SELECT, INSERT, UPDATE ON smartreport.library_versions, smartreport.wording_deny_terms,
                                smartreport.summaries, smartreport.template_blocks, smartreport.rules,
                                smartreport.analyte_groups, smartreport.group_settings TO lims_app;
-- no DELETE grant on any smartreport table (class M rows are deactivated — 08 A17 P-18(a), 02-CV §5.6)
GRANT SELECT, INSERT ON smartreport.library_reviews, smartreport.summary_report_bindings,
                        smartreport.summary_reviews, smartreport.llm_runs TO lims_app;
```

## 10. Tests C0 adds in `db/tests` (REQ-SEC-042)

1. RLS probe per tenant table: tenant A claims see zero tenant B rows; INSERT with B's `tenant_id` fails; UPDATE/DELETE of B rows affect 0 rows.
2. Centre probe on the four centre-scoped tables: centre-A1 user sees no A2 rows; hub user with `all_centres` sees both.
3. `has_table_privilege('lims_app', 'smartreport.summaries', 'DELETE') = false`; same for the four A tables, `library_versions`, `wording_deny_terms` and the four child tables (no DELETE grant anywhere).
4. Child-table edit when parent is `in_review` → `immutable_row`.
5. Summary content UPDATE (`content`, `approved_set_hash`) → `immutable_row`; `llm_overlay` update on an approved row → `immutable_row`.
6. Invalid transitions (`superseded → draft`, `rejected → approved`, `draft → approved` on a library) → `invalid_transition`.
7. Partial unique: second live summary for the same order fails; second approved library fails.
8. Composite FK: a rule referencing tenant B's analyte or a block of another library version fails.
9. `rules__followup_fields__ck`: follow-up without `interval_days` fails; advice with `interval_days` fails.
10. Supersede chain (08 A19 D-107): live `draft` → `superseded` (no successor), insert the successor, then one UPDATE setting `superseded_by_summary_id` NULL → successor id succeeds; a second UPDATE of `superseded_by_summary_id`, or any other column change on a `superseded` row (e.g. `superseded_reason`), → `invalid_transition`.
11. Actor guard (08 A19 D-109): `device`, `patient`, `portal` and `partner` claims of the same tenant read 0 rows from every `smartreport.*` tenant table and every INSERT fails the policy; `user` and `system` claims see their rows.
12. Deactivation (08 A17 P-18(a)): `has_table_privilege('lims_app', t, 'DELETE') = false` for the four child tables; after a block or mapping is set `is_active = false`, a new active row with the same `block_key` / `analyte_id` in the same version succeeds and a second active duplicate fails (`*__p_uq`).
13. `summaries__inputs__ck`: 2,000 elements accepted; 2,001 rejected.
