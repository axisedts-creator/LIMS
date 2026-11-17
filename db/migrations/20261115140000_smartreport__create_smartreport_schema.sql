-- T0B-13.C14 (LD-202): smartreport schema — C14 05-SCHEMA §9 DDL verbatim (14 tables: 3 G + 11 tenant; 14 indexes; 3 SECURITY INVOKER
-- trigger functions; 9 triggers; 29 written-out policies; grants; §3 seeds), plus the C0 transcription steps: the missing <t>__tenant__fk
-- (C0 05-SCHEMA §9 rule 1) on 8 tables and the generic row-audit trigger on the 7 class M / C tables (§9 closing comment, 04 D11).
-- Policies are copied 1:1 to db/policies/smartreport.sql (AC-0B-2.3). smartreport.event_inbox belongs to T0B-05. Schema exists since
-- T0B-01. No view (§8). No DEFINER (§4). No DELETE grant anywhere. Single role switch: lims_owner.
SET LOCAL ROLE lims_owner;

-- ===================== §9 DDL (verbatim) =====================
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

-- ===================== C0 05-SCHEMA §9 rule 1: tenant FK on every tenant table (the spec DDL lacks it on 8) =====================
ALTER TABLE smartreport.template_blocks ADD CONSTRAINT template_blocks__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id);
ALTER TABLE smartreport.rules ADD CONSTRAINT rules__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id);
ALTER TABLE smartreport.analyte_groups ADD CONSTRAINT analyte_groups__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id);
ALTER TABLE smartreport.group_settings ADD CONSTRAINT group_settings__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id);
ALTER TABLE smartreport.library_reviews ADD CONSTRAINT library_reviews__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id);
ALTER TABLE smartreport.summary_report_bindings ADD CONSTRAINT summary_report_bindings__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id);
ALTER TABLE smartreport.summary_reviews ADD CONSTRAINT summary_reviews__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id);
ALTER TABLE smartreport.llm_runs ADD CONSTRAINT llm_runs__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id);

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

-- ===================== C0 generic row-audit trigger (04 D11): class M / C tables; not class A, not G =====================
CREATE TRIGGER library_versions__audit AFTER INSERT OR UPDATE OR DELETE ON smartreport.library_versions FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER template_blocks__audit AFTER INSERT OR UPDATE OR DELETE ON smartreport.template_blocks FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER rules__audit AFTER INSERT OR UPDATE OR DELETE ON smartreport.rules FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER analyte_groups__audit AFTER INSERT OR UPDATE OR DELETE ON smartreport.analyte_groups FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER group_settings__audit AFTER INSERT OR UPDATE OR DELETE ON smartreport.group_settings FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER wording_deny_terms__audit AFTER INSERT OR UPDATE OR DELETE ON smartreport.wording_deny_terms FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER summaries__audit AFTER INSERT OR UPDATE OR DELETE ON smartreport.summaries FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();

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
