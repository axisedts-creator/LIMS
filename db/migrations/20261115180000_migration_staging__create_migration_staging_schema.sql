-- T0B-13.C18 (LD-202): migration_staging schema — C18 05-SCHEMA §4 DDL + grant lines + mutability triggers verbatim
-- (16 tables, 30 indexes, 3 mutable-column triggers), §2 migration grants verbatim, §5 RLS (templates (a)..(e) expanded into
-- 53 literal policies TO lims_migration with the 08 A17 P-16 guard). C0 transcription steps: the missing <t>__tenant__fk
-- (C0 05-SCHEMA §9 rule 1), migration_staging.runs_lifecycle_guard (§4 closing paragraph), row-audit triggers on runs,
-- run_files, crosswalk_entries, batches (§4 closing comment; NOT on stg_*, match_pairs, issues, samples: §1.5).
-- Not translated: Appendix B (LD-202 (b)); the bootstrap role lims_migration (§2 bootstrap part, CR-C18-001; LD-202 (a)/(c):
-- blocking CR .orchestra/cr/T0B-13.C18-lims-migration-role.md — this file needs that role to exist). No seed, no view (§10, §11).
-- Policies are copied 1:1 to db/policies/migration_staging.sql (AC-0B-2.3). Schema exists since T0B-01.

-- ===================================================== §4 DDL (verbatim)
SET LOCAL ROLE lims_owner;

-- ===================================================================== runs
CREATE TABLE migration_staging.runs (
  id                       uuid        NOT NULL,
  tenant_id                uuid        NOT NULL,
  run_code                 text        NOT NULL,                       -- P0 'MR-<tenant_code>-<yyyymmdd>-<n>'
  source_system            text        NOT NULL,                       -- P0
  kind                     text        NOT NULL,
  is_rehearsal             boolean     NOT NULL DEFAULT false,
  parent_run_id            uuid,
  status                   text        NOT NULL DEFAULT 'created',
  canonical_format_version text,
  extract_id               uuid,                                       -- P0 from manifest
  manifest_sha256          text,
  extracted_at             timestamptz,
  data_as_of               timestamptz,
  source_timezone          text,
  transformer_name         text,
  transformer_version      text,
  staged_by                uuid,                                       -- P1 platform staff id
  counts                   jsonb       NOT NULL DEFAULT '{}'::jsonb,   -- P0 per-entity counters
  last_progress_at         timestamptz,
  signed_off_at            timestamptz,
  purge_not_before         timestamptz,
  purged_at                timestamptz,
  end_reason_code          text,                                       -- abandon/void reason
  version                  integer     NOT NULL DEFAULT 1,
  is_active                boolean     NOT NULL DEFAULT true,
  created_at               timestamptz NOT NULL DEFAULT now(),
  created_by               uuid        NOT NULL,                       -- operator (platform staff id)
  updated_at               timestamptz NOT NULL DEFAULT now(),
  updated_by               uuid        NOT NULL,
  CONSTRAINT runs__pk PRIMARY KEY (id),
  CONSTRAINT runs__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT runs__tenant_id_run_code__uq UNIQUE (tenant_id, run_code),
  CONSTRAINT runs__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT runs__parent__fk FOREIGN KEY (tenant_id, parent_run_id) REFERENCES migration_staging.runs (tenant_id, id),
  CONSTRAINT runs__source__ck CHECK (source_system ~ '^[a-z][a-z0-9_]{1,31}$'),
  CONSTRAINT runs__kind__ck CHECK (kind IN ('full','delta')),
  CONSTRAINT runs__delta_parent__ck CHECK ((kind = 'delta') = (parent_run_id IS NOT NULL)),
  CONSTRAINT runs__status__ck CHECK (status IN ('created','staging','staged','validating','validated','validation_failed',
     'dry_running','dry_run_passed','dry_run_failed','approved_for_load','loading','loaded','load_failed','verifying',
     'verified','verify_failed','signed_off','voiding','voided','voided_partial','abandoned','purged')),
  CONSTRAINT runs__rehearsal_no_load__ck CHECK (NOT is_rehearsal OR status IN ('created','staging','staged','validating',
     'validated','validation_failed','dry_running','dry_run_passed','dry_run_failed','abandoned','purged')),
  CONSTRAINT runs__sha__ck CHECK (manifest_sha256 IS NULL OR manifest_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT runs__code__ck CHECK (char_length(run_code) BETWEEN 5 AND 80),
  CONSTRAINT runs__reason__ck CHECK (end_reason_code IS NULL OR end_reason_code ~ '^[a-z_]{1,64}$'),
  CONSTRAINT runs__signed__ck CHECK (status NOT IN ('signed_off','purged') OR signed_off_at IS NOT NULL
                                     OR end_reason_code IS NOT NULL)
);
CREATE UNIQUE INDEX runs__tenant_id_active_writer__p_uq ON migration_staging.runs (tenant_id)
  WHERE status IN ('loading','voiding');                                       -- one writing run per tenant (03-APP-FLOW E2)
CREATE INDEX runs__tenant_id_status__idx ON migration_staging.runs (tenant_id, status, created_at);
CREATE INDEX runs__tenant_id_purge__p_idx ON migration_staging.runs (tenant_id, purge_not_before)
  WHERE status IN ('signed_off','voided','voided_partial','abandoned');
GRANT SELECT, INSERT, UPDATE ON migration_staging.runs TO lims_migration;

-- ===================================================================== run_events (A)
CREATE TABLE migration_staging.run_events (
  id            uuid        NOT NULL,
  tenant_id     uuid        NOT NULL,
  run_id        uuid,                                    -- NULL for tenant-level commands (crosswalk import without run is not allowed; kept for 'run create' failures)
  kind          text        NOT NULL,
  command       text        NOT NULL,                    -- P0 e.g. 'load'
  args_sha256   text        NOT NULL,                    -- digest of normalised argv (argv itself may contain codes)
  outcome       text        NOT NULL,
  exit_code     smallint    NOT NULL,
  error_code    text,
  counts        jsonb       NOT NULL DEFAULT '{}'::jsonb, -- P0
  staging_row_ids uuid[]    NOT NULL DEFAULT '{}',        -- P1 rows revealed (kind *_reveal), ≤ 500
  tool_version  text        NOT NULL,
  host_name     text        NOT NULL,                     -- P0
  operator_unix_user text   NOT NULL,                     -- P0 ops account name
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid        NOT NULL,                     -- platform staff id
  CONSTRAINT run_events__pk PRIMARY KEY (id),
  CONSTRAINT run_events__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT run_events__run__fk FOREIGN KEY (tenant_id, run_id) REFERENCES migration_staging.runs (tenant_id, id),
  CONSTRAINT run_events__kind__ck CHECK (kind IN ('run_create','stage','crosswalk_export','crosswalk_import','validate',
     'issues_view','match_view','match_decide','patient_reveal','row_reveal','dryrun','sample_review','sample_confirm_ui',
     'report_view','approve','load','verify_load','signoff','void_request','void_approve','void','purge_early_request',
     'purge_early_approve','purge','masters_build','finance_list','run_show','run_list','run_abandon','status')),
     -- package_verify, transform, --help/--version and status --metrics write no run_events row (PRD AC-17.3)
  CONSTRAINT run_events__outcome__ck CHECK (outcome IN ('ok','refused','failed','findings')),
  CONSTRAINT run_events__exit__ck CHECK (exit_code IN (0,1,2,3)),
  CONSTRAINT run_events__sha__ck CHECK (args_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT run_events__ids__ck CHECK (cardinality(staging_row_ids) <= 500)
);
CREATE INDEX run_events__tenant_id_run_id_created_at__idx ON migration_staging.run_events (tenant_id, run_id, created_at);
GRANT SELECT, INSERT ON migration_staging.run_events TO lims_migration;

-- ===================================================================== run_files
CREATE TABLE migration_staging.run_files (
  id             uuid        NOT NULL,
  tenant_id      uuid        NOT NULL,
  run_id         uuid        NOT NULL,
  path           text        NOT NULL,                    -- P0 canonical relative path ('results.csv', 'documents/')
  file_kind      text        NOT NULL,
  sha256         text,                                    -- NULL for 'documents_dir'
  rows_expected  bigint,
  rows_staged    bigint      NOT NULL DEFAULT 0,
  bytes          bigint      NOT NULL DEFAULT 0,
  state          text        NOT NULL DEFAULT 'staging',
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT run_files__pk PRIMARY KEY (id),
  CONSTRAINT run_files__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT run_files__run_path__uq UNIQUE (tenant_id, run_id, path),
  CONSTRAINT run_files__run__fk FOREIGN KEY (tenant_id, run_id) REFERENCES migration_staging.runs (tenant_id, id),
  CONSTRAINT run_files__kind__ck CHECK (file_kind IN ('manifest','csv','documents_dir','checksums')),
  CONSTRAINT run_files__state__ck CHECK (state IN ('staging','staged')),
  CONSTRAINT run_files__path__ck CHECK (path ~ '^[a-z_]+(/[a-z_]+)?(\.csv|\.json|/)?$|^SHA256SUMS$'),
  CONSTRAINT run_files__sha__ck CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT run_files__rows__ck CHECK (rows_staged >= 0 AND (rows_expected IS NULL OR rows_staged <= rows_expected))
);
GRANT SELECT, INSERT, UPDATE ON migration_staging.run_files TO lims_migration;

-- ===================================================================== crosswalk_entries (tenant-level)
CREATE TABLE migration_staging.crosswalk_entries (
  id                       uuid        NOT NULL,
  tenant_id                uuid        NOT NULL,
  source_system            text        NOT NULL,
  entity_kind              text        NOT NULL,
  legacy_code              text        NOT NULL,         -- P0 (codes of masters / vocabularies)
  legacy_context           text        NOT NULL DEFAULT '', -- e.g. legacy_test_code for kind 'analyte', legacy analyte key for 'ordinal'
  legacy_display           text,                         -- P0; P2 for kind 'doctor' (doctor name)
  target_id                uuid,                         -- centre / analyte / test (plain uuid, validated by the tool)
  target_test_id           uuid,                         -- kind 'analyte' only
  target_code              text,                         -- sex, flag, unit code, ordinal code, result_status, document_kind, doctor/credit-party code
  unit_factor              numeric,                      -- kind 'unit': multiply legacy value by this to get target unit
  decided_by_membership_id uuid,                         -- P1 lab lead
  operator_id              uuid        NOT NULL,         -- P1 platform staff
  note_code                text,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT crosswalk_entries__pk PRIMARY KEY (id),
  CONSTRAINT crosswalk_entries__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT crosswalk_entries__key__uq UNIQUE (tenant_id, source_system, entity_kind, legacy_code, legacy_context),
  CONSTRAINT crosswalk_entries__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT crosswalk_entries__kind__ck CHECK (entity_kind IN ('centre','doctor','credit_party','credit_party_kind','analyte','unit','ordinal',
     'sex','flag','result_status','document_kind')),
  CONSTRAINT crosswalk_entries__code__ck CHECK (char_length(legacy_code) BETWEEN 1 AND 128 AND char_length(legacy_context) <= 128),
  CONSTRAINT crosswalk_entries__display__ck CHECK (legacy_display IS NULL OR char_length(legacy_display) <= 200),
  CONSTRAINT crosswalk_entries__target__ck CHECK (
       (entity_kind = 'centre'   AND target_id IS NOT NULL)
    OR (entity_kind = 'analyte'  AND target_id IS NOT NULL AND target_test_id IS NOT NULL)
    OR (entity_kind = 'unit'     AND target_code IS NOT NULL AND unit_factor IS NOT NULL AND unit_factor > 0)
    OR (entity_kind = 'sex'      AND target_code IN ('male','female','other','unknown'))
    OR (entity_kind = 'flag'     AND target_code IN ('N','L','H','LL','HH','A','none'))
    OR (entity_kind = 'result_status' AND target_code IN ('final','amended_final','preliminary','cancelled','other'))
    OR (entity_kind = 'document_kind' AND target_code IN ('lab_report','radiology_report','outsourced_report','other_report'))
    OR (entity_kind = 'credit_party_kind' AND target_code IN ('hospital','company','clinic','partner_lab','insurer','other'))   -- C3 CreditParty.kind
    OR (entity_kind IN ('doctor','credit_party','ordinal') AND target_code IS NOT NULL)
    OR (is_active = false))
);
GRANT SELECT, INSERT, UPDATE ON migration_staging.crosswalk_entries TO lims_migration;

-- ===================================================================== batches
CREATE TABLE migration_staging.batches (
  id                  uuid        NOT NULL,              -- = batchId sent to owners
  tenant_id           uuid        NOT NULL,
  run_id              uuid        NOT NULL,
  entity              text        NOT NULL,
  seq                 integer     NOT NULL,
  row_count           integer     NOT NULL,
  content_sha256      text        NOT NULL,
  status              text        NOT NULL DEFAULT 'planned',
  attempts            integer     NOT NULL DEFAULT 0,
  outcome_counts      jsonb       NOT NULL DEFAULT '{}'::jsonb,   -- P0 {created: n, linked: n, …, rejected: {code: n}}
  committed_at        timestamptz,
  owner_row_count     integer,
  owner_digest_sha256 text,
  verified_at         timestamptz,
  verify_ok           boolean,
  voided_at           timestamptz,
  not_voidable        jsonb       NOT NULL DEFAULT '[]'::jsonb,   -- P1 [{target_id, reason_code}]
  last_error_code     text,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT batches__pk PRIMARY KEY (id),
  CONSTRAINT batches__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT batches__seq__uq UNIQUE (tenant_id, run_id, entity, seq),
  CONSTRAINT batches__run__fk FOREIGN KEY (tenant_id, run_id) REFERENCES migration_staging.runs (tenant_id, id),
  CONSTRAINT batches__entity__ck CHECK (entity IN ('patients','results','documents')),
  CONSTRAINT batches__status__ck CHECK (status IN ('planned','committed','failed','voided','partially_voided')),
  CONSTRAINT batches__rows__ck CHECK (row_count BETWEEN 1 AND 200 AND (entity <> 'documents' OR row_count = 1)),
  CONSTRAINT batches__sha__ck CHECK (content_sha256 ~ '^[0-9a-f]{64}$'
     AND (owner_digest_sha256 IS NULL OR owner_digest_sha256 ~ '^[0-9a-f]{64}$')),
  CONSTRAINT batches__committed__ck CHECK (status = 'planned' OR status = 'failed' OR committed_at IS NOT NULL)
);
CREATE INDEX batches__tenant_id_run_status__idx ON migration_staging.batches (tenant_id, run_id, status, entity, seq);
GRANT SELECT, INSERT, UPDATE ON migration_staging.batches TO lims_migration;

-- ===================================================================== reports (A)
CREATE TABLE migration_staging.reports (
  id           uuid        NOT NULL,
  tenant_id    uuid        NOT NULL,
  run_id       uuid        NOT NULL,
  report_kind  text        NOT NULL,
  invariant_ok boolean     NOT NULL,
  body         jsonb       NOT NULL,                     -- P0, schema report.schema.json (02-TRD §10.1)
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid        NOT NULL,
  CONSTRAINT reports__pk PRIMARY KEY (id),
  CONSTRAINT reports__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT reports__run__fk FOREIGN KEY (tenant_id, run_id) REFERENCES migration_staging.runs (tenant_id, id),
  CONSTRAINT reports__kind__ck CHECK (report_kind IN ('dry_run','post_load','void','purge')),
  CONSTRAINT reports__size__ck CHECK (pg_column_size(body) <= 1048576)
);
CREATE INDEX reports__tenant_id_run_id_created_at__idx ON migration_staging.reports (tenant_id, run_id, created_at);
GRANT SELECT, INSERT ON migration_staging.reports TO lims_migration;

-- ===================================================================== signoffs (A)
CREATE TABLE migration_staging.signoffs (
  id                    uuid        NOT NULL,
  tenant_id             uuid        NOT NULL,
  run_id                uuid        NOT NULL,
  kind                  text        NOT NULL,
  platform_staff_id     uuid        NOT NULL,            -- P1 operator/approver
  lab_membership_id     uuid,                            -- P1 lab signatory (tenant_admin)
  lab_signatory_display text,                            -- P2 staff name snapshot (≤ 120)
  reference_text        text,                            -- P0 paper form / ticket reference (≤ 120)
  decision_payload      jsonb       NOT NULL DEFAULT '{}'::jsonb,   -- P0 e.g. accepted exclusion codes + counts
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by            uuid        NOT NULL,
  CONSTRAINT signoffs__pk PRIMARY KEY (id),
  CONSTRAINT signoffs__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT signoffs__run__fk FOREIGN KEY (tenant_id, run_id) REFERENCES migration_staging.runs (tenant_id, id),
  CONSTRAINT signoffs__kind__ck CHECK (kind IN ('load_approval','void_approval','early_purge_approval','exclusion_acceptance','lab_signoff')),
  CONSTRAINT signoffs__lab__ck CHECK (kind NOT IN ('lab_signoff','exclusion_acceptance')
                                      OR (lab_membership_id IS NOT NULL AND lab_signatory_display IS NOT NULL)),
  CONSTRAINT signoffs__text__ck CHECK (coalesce(char_length(lab_signatory_display),0) <= 120 AND coalesce(char_length(reference_text),0) <= 120)
);
CREATE INDEX signoffs__tenant_id_run_id__idx ON migration_staging.signoffs (tenant_id, run_id, kind);
GRANT SELECT, INSERT ON migration_staging.signoffs TO lims_migration;

-- ===================================================================== stg_patients (E)
CREATE TABLE migration_staging.stg_patients (
  id                         uuid        NOT NULL,
  tenant_id                  uuid        NOT NULL,
  run_id                     uuid        NOT NULL,
  row_no                     bigint      NOT NULL,
  source_row_sha256                 text        NOT NULL,
  -- canonical cells (02-TRD §6.4)
  legacy_patient_key         text        NOT NULL,                      -- P2
  legacy_patient_code        text,                                      -- P2
  full_name                  text,                                      -- P2 (NULL only if the cell was empty → row invalid)
  sex_raw                    text,                                      -- P2
  birth_on                   date,                                      -- P2
  birth_on_is_estimated      boolean     NOT NULL DEFAULT false,
  age_years_at_reference     integer,
  age_reference_on           date,
  phone_raw                  text,                                      -- P2
  email                      text,                                      -- P2
  address_text               text,                                      -- P2
  centre_legacy_code         text,                                      -- P0
  first_seen_at              timestamptz,
  last_visit_at              timestamptz,
  merged_into_legacy_key     text,                                      -- P2
  is_deleted_in_source       boolean     NOT NULL DEFAULT false,
  -- derived by validate
  name_norm                  text,                                      -- P2
  phone_e164_norm            text,                                      -- P2
  sex                        text,
  birth_on_effective         date,                                      -- P2
  birth_on_effective_estimated boolean,
  centre_id                  uuid,
  group_id                   uuid,                                      -- merge group (union-find root row id)
  is_survivor                boolean,
  -- lifecycle
  status                     text        NOT NULL DEFAULT 'staged',
  exclusion_code             text,
  dry_run_outcome            text,
  dry_run_reason_code        text,
  batch_id                   uuid,
  load_outcome               text,
  load_reason_code           text,
  target_patient_id          uuid,                                      -- P1
  port_row_sha256            text,                                      -- rowSha256 of the port row (02-TRD §10.3), written at batch planning
  changed_fields             text[]      NOT NULL DEFAULT '{}',
  created_at                 timestamptz NOT NULL DEFAULT now(),
  created_by                 uuid        NOT NULL,
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stg_patients__pk PRIMARY KEY (id),
  CONSTRAINT stg_patients__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT stg_patients__row__uq UNIQUE (tenant_id, run_id, row_no),
  CONSTRAINT stg_patients__run__fk FOREIGN KEY (tenant_id, run_id) REFERENCES migration_staging.runs (tenant_id, id),
  CONSTRAINT stg_patients__centre__fk FOREIGN KEY (tenant_id, centre_id) REFERENCES core.collection_centres (tenant_id, id),
  CONSTRAINT stg_patients__status__ck CHECK (status IN ('staged','valid','invalid','excluded','merged','unchanged',
     'loaded','already_imported','rejected','voided')),
  CONSTRAINT stg_patients__outcome__ck CHECK ((dry_run_outcome IS NULL OR dry_run_outcome IN ('created','linked','already_imported','rejected'))
     AND (load_outcome IS NULL OR load_outcome IN ('created','linked','already_imported','rejected'))),
  CONSTRAINT stg_patients__sex__ck CHECK (sex IS NULL OR sex IN ('male','female','other','unknown')),
  CONSTRAINT stg_patients__sha__ck CHECK (source_row_sha256 ~ '^[0-9a-f]{64}$' AND (port_row_sha256 IS NULL OR port_row_sha256 ~ '^[0-9a-f]{64}$')),
  CONSTRAINT stg_patients__len__ck CHECK (char_length(legacy_patient_key) BETWEEN 1 AND 128
     AND coalesce(char_length(legacy_patient_code),0) <= 40 AND coalesce(char_length(full_name),0) <= 4000
     AND coalesce(char_length(address_text),0) <= 4000 AND coalesce(char_length(email),0) <= 4000)
);
CREATE INDEX stg_patients__tenant_id_run_status__idx ON migration_staging.stg_patients (tenant_id, run_id, status);
CREATE INDEX stg_patients__tenant_id_run_key__idx ON migration_staging.stg_patients (tenant_id, run_id, legacy_patient_key);
CREATE INDEX stg_patients__tenant_id_key_run__idx ON migration_staging.stg_patients (tenant_id, legacy_patient_key, run_id);  -- prior-run lookups
CREATE INDEX stg_patients__tenant_id_match_name__idx ON migration_staging.stg_patients (tenant_id, run_id, name_norm, birth_on_effective);
CREATE INDEX stg_patients__tenant_id_match_phone__p_idx ON migration_staging.stg_patients (tenant_id, run_id, phone_e164_norm)
  WHERE phone_e164_norm IS NOT NULL;
CREATE INDEX stg_patients__tenant_id_batch__p_idx ON migration_staging.stg_patients (tenant_id, batch_id) WHERE batch_id IS NOT NULL;
GRANT SELECT, INSERT, UPDATE, DELETE ON migration_staging.stg_patients TO lims_migration;

-- ===================================================================== stg_visits (E)
CREATE TABLE migration_staging.stg_visits (
  id                       uuid        NOT NULL,
  tenant_id                uuid        NOT NULL,
  run_id                   uuid        NOT NULL,
  row_no                   bigint      NOT NULL,
  source_row_sha256               text        NOT NULL,
  legacy_visit_key         text        NOT NULL,     -- P2
  legacy_patient_key       text        NOT NULL,     -- P2
  legacy_registration_no   text,                     -- P2
  visit_at                 timestamptz,
  centre_legacy_code       text,
  referrer_legacy_code     text,
  credit_party_legacy_code text,
  visit_type_raw           text,
  centre_id                uuid,                     -- derived
  status                   text        NOT NULL DEFAULT 'staged',
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stg_visits__pk PRIMARY KEY (id),
  CONSTRAINT stg_visits__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT stg_visits__row__uq UNIQUE (tenant_id, run_id, row_no),
  CONSTRAINT stg_visits__run__fk FOREIGN KEY (tenant_id, run_id) REFERENCES migration_staging.runs (tenant_id, id),
  CONSTRAINT stg_visits__centre__fk FOREIGN KEY (tenant_id, centre_id) REFERENCES core.collection_centres (tenant_id, id),
  CONSTRAINT stg_visits__status__ck CHECK (status IN ('staged','valid','invalid','excluded')),
  CONSTRAINT stg_visits__sha__ck CHECK (source_row_sha256 ~ '^[0-9a-f]{64}$')
);
CREATE INDEX stg_visits__tenant_id_run_key__idx ON migration_staging.stg_visits (tenant_id, run_id, legacy_visit_key);
CREATE INDEX stg_visits__tenant_id_run_patient__idx ON migration_staging.stg_visits (tenant_id, run_id, legacy_patient_key);
GRANT SELECT, INSERT, UPDATE, DELETE ON migration_staging.stg_visits TO lims_migration;

-- ===================================================================== stg_results (E)
CREATE TABLE migration_staging.stg_results (
  id                     uuid        NOT NULL,
  tenant_id              uuid        NOT NULL,
  run_id                 uuid        NOT NULL,
  row_no                 bigint      NOT NULL,
  source_row_sha256             text        NOT NULL,
  legacy_result_key      text        NOT NULL,       -- P2
  legacy_version_no      integer     NOT NULL DEFAULT 1,
  legacy_visit_key       text,                       -- P2
  legacy_patient_key     text        NOT NULL,       -- P2
  legacy_test_code       text        NOT NULL,       -- P3 (with patient)
  legacy_analyte_code    text        NOT NULL,       -- P3
  analyte_display_name   text        NOT NULL,       -- P3
  result_status_raw      text        NOT NULL,
  value_raw              text,                       -- P3
  value_numeric          numeric,                    -- P3 exact as received
  value_text             text,                       -- P3
  ordinal_raw            text,                       -- P3
  unit_raw               text,
  ref_low                numeric, ref_high numeric,  -- P3
  ref_text               text,                       -- P3
  flag_raw               text,                       -- P3
  comment_text           text,                       -- P3
  method_text            text,
  specimen_type_raw      text,
  collected_at           timestamptz,
  reported_at            timestamptz,
  -- derived
  analyte_id             uuid, test_id uuid, unit_code text, unit_factor numeric,
  value_numeric_target   numeric,                    -- value_numeric × unit_factor (exact numeric)
  ref_low_target         numeric,                    -- ref_low × unit_factor (P3; same unit as value_numeric_target)
  ref_high_target        numeric,                    -- ref_high × unit_factor (P3)
  ordinal_code           text, flag text, result_status text, centre_id uuid,
  status                 text        NOT NULL DEFAULT 'staged',
  exclusion_code         text,
  dry_run_outcome        text, dry_run_reason_code text,
  batch_id               uuid,
  load_outcome           text, load_reason_code text,
  target_legacy_result_id uuid,                      -- P1
  port_row_sha256        text,                       -- rowSha256 of the port row (02-TRD §10.3)
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stg_results__pk PRIMARY KEY (id),
  CONSTRAINT stg_results__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT stg_results__row__uq UNIQUE (tenant_id, run_id, row_no),
  CONSTRAINT stg_results__run__fk FOREIGN KEY (tenant_id, run_id) REFERENCES migration_staging.runs (tenant_id, id),
  CONSTRAINT stg_results__centre__fk FOREIGN KEY (tenant_id, centre_id) REFERENCES core.collection_centres (tenant_id, id),
  CONSTRAINT stg_results__status__ck CHECK (status IN ('staged','valid','invalid','excluded','unchanged','loaded',
     'already_imported','superseded_previous','rejected','voided')),
  CONSTRAINT stg_results__outcome__ck CHECK ((dry_run_outcome IS NULL OR dry_run_outcome IN ('created','superseded_previous','already_imported','rejected'))
     AND (load_outcome IS NULL OR load_outcome IN ('created','superseded_previous','already_imported','rejected'))),
  CONSTRAINT stg_results__flag__ck CHECK (flag IS NULL OR flag IN ('N','L','H','LL','HH','A')),
  CONSTRAINT stg_results__rstatus__ck CHECK (result_status IS NULL OR result_status IN ('final','amended_final','preliminary','cancelled','other')),
  CONSTRAINT stg_results__version__ck CHECK (legacy_version_no >= 1),
  CONSTRAINT stg_results__sha__ck CHECK (source_row_sha256 ~ '^[0-9a-f]{64}$' AND (port_row_sha256 IS NULL OR port_row_sha256 ~ '^[0-9a-f]{64}$'))
);
CREATE INDEX stg_results__tenant_id_run_status__idx ON migration_staging.stg_results (tenant_id, run_id, status);
CREATE INDEX stg_results__tenant_id_run_patient__idx ON migration_staging.stg_results (tenant_id, run_id, legacy_patient_key);
CREATE INDEX stg_results__tenant_id_run_key__idx ON migration_staging.stg_results (tenant_id, run_id, legacy_result_key, legacy_version_no);
CREATE INDEX stg_results__tenant_id_key_run__idx ON migration_staging.stg_results (tenant_id, legacy_result_key, legacy_version_no, run_id);
CREATE INDEX stg_results__tenant_id_run_codes__idx ON migration_staging.stg_results (tenant_id, run_id, legacy_test_code, legacy_analyte_code);
CREATE INDEX stg_results__tenant_id_batch__p_idx ON migration_staging.stg_results (tenant_id, batch_id) WHERE batch_id IS NOT NULL;
GRANT SELECT, INSERT, UPDATE, DELETE ON migration_staging.stg_results TO lims_migration;

-- ===================================================================== stg_documents (E)
CREATE TABLE migration_staging.stg_documents (
  id                   uuid        NOT NULL,
  tenant_id            uuid        NOT NULL,
  run_id               uuid        NOT NULL,
  row_no               bigint      NOT NULL,
  source_row_sha256           text        NOT NULL,
  legacy_document_key  text        NOT NULL,         -- P2
  legacy_patient_key   text        NOT NULL,         -- P2
  legacy_visit_key     text,                         -- P2
  centre_legacy_code   text,
  document_kind_raw    text        NOT NULL,
  document_date        date,
  title                text,                         -- P3
  file_path            text        NOT NULL,         -- P2 relative path on the host volume
  sha256               text        NOT NULL,
  size_bytes           bigint      NOT NULL,
  host_sha256_ok       boolean,
  magic_ok             boolean,
  document_kind        text, centre_id uuid,
  status               text        NOT NULL DEFAULT 'staged',
  dry_run_outcome      text, dry_run_reason_code text,
  batch_id             uuid,
  load_outcome         text, load_reason_code text,
  target_document_id   uuid,                         -- P1
  owner_state          text,                         -- from getBatchSummary
  port_row_sha256      text,                         -- rowSha256 of the port row (02-TRD §10.3)
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stg_documents__pk PRIMARY KEY (id),
  CONSTRAINT stg_documents__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT stg_documents__row__uq UNIQUE (tenant_id, run_id, row_no),
  CONSTRAINT stg_documents__run__fk FOREIGN KEY (tenant_id, run_id) REFERENCES migration_staging.runs (tenant_id, id),
  CONSTRAINT stg_documents__centre__fk FOREIGN KEY (tenant_id, centre_id) REFERENCES core.collection_centres (tenant_id, id),
  CONSTRAINT stg_documents__status__ck CHECK (status IN ('staged','valid','invalid','excluded','unchanged','loaded',
     'already_imported','rejected','voided')),
  CONSTRAINT stg_documents__kind__ck CHECK (document_kind IS NULL OR document_kind IN ('lab_report','radiology_report','outsourced_report','other_report')),
  CONSTRAINT stg_documents__owner_state__ck CHECK (owner_state IS NULL OR owner_state IN ('pending_scan','scanning','quarantined','sanitizing','ready','rejected')),
  CONSTRAINT stg_documents__path__ck CHECK (file_path ~ '^[A-Za-z0-9._/-]{1,240}$' AND file_path !~ '(^/|\.\.)'),
  CONSTRAINT stg_documents__sha__ck CHECK (source_row_sha256 ~ '^[0-9a-f]{64}$' AND sha256 ~ '^[0-9a-f]{64}$'
     AND (port_row_sha256 IS NULL OR port_row_sha256 ~ '^[0-9a-f]{64}$')),
  CONSTRAINT stg_documents__size__ck CHECK (size_bytes BETWEEN 1 AND 15728640)
);
CREATE INDEX stg_documents__tenant_id_run_status__idx ON migration_staging.stg_documents (tenant_id, run_id, status);
CREATE INDEX stg_documents__tenant_id_run_patient__idx ON migration_staging.stg_documents (tenant_id, run_id, legacy_patient_key);
CREATE INDEX stg_documents__tenant_id_key_run__idx ON migration_staging.stg_documents (tenant_id, legacy_document_key, run_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON migration_staging.stg_documents TO lims_migration;

-- ===================================================================== stg_financial (E) — never loaded (BLOCKED B6/B7)
CREATE TABLE migration_staging.stg_financial (
  id                       uuid        NOT NULL,
  tenant_id                uuid        NOT NULL,
  run_id                   uuid        NOT NULL,
  row_no                   bigint      NOT NULL,
  source_row_sha256               text        NOT NULL,
  item_kind                text        NOT NULL,
  legacy_item_key          text        NOT NULL,     -- P2
  legacy_patient_key       text,                     -- P2
  credit_party_legacy_code text,
  legacy_invoice_no        text,                     -- fiscal number of the previous software (P0 per 02-CV §9.2 "invoice_no allowed")
  invoice_date             date,
  fiscal_year_bs           text,
  amount_paisa             bigint,                   -- due / balance / net (financial, restricted)
  gross_paisa              bigint,
  status_raw               text,
  as_of                    timestamptz,
  document_file_path       text,                     -- P2
  status                   text        NOT NULL DEFAULT 'staged',
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stg_financial__pk PRIMARY KEY (id),
  CONSTRAINT stg_financial__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT stg_financial__row__uq UNIQUE (tenant_id, run_id, item_kind, row_no),
  CONSTRAINT stg_financial__run__fk FOREIGN KEY (tenant_id, run_id) REFERENCES migration_staging.runs (tenant_id, id),
  CONSTRAINT stg_financial__kind__ck CHECK (item_kind IN ('patient_due','credit_party_balance','invoice_ref')),
  CONSTRAINT stg_financial__status__ck CHECK (status IN ('staged','valid','invalid','reported')),
  CONSTRAINT stg_financial__fy__ck CHECK (fiscal_year_bs IS NULL OR fiscal_year_bs ~ '^[0-9]{4}/[0-9]{2}$'),
  CONSTRAINT stg_financial__sha__ck CHECK (source_row_sha256 ~ '^[0-9a-f]{64}$')
);
CREATE INDEX stg_financial__tenant_id_run_kind__idx ON migration_staging.stg_financial (tenant_id, run_id, item_kind, status);
GRANT SELECT, INSERT, UPDATE, DELETE ON migration_staging.stg_financial TO lims_migration;

-- ===================================================================== stg_masters (E)
CREATE TABLE migration_staging.stg_masters (
  id           uuid        NOT NULL,
  tenant_id    uuid        NOT NULL,
  run_id       uuid        NOT NULL,
  entity_kind  text        NOT NULL,
  row_no       bigint      NOT NULL,
  source_row_sha256   text        NOT NULL,
  legacy_code  text        NOT NULL,
  payload      jsonb       NOT NULL,                 -- canonical cells; P2 for doctors/centres/credit parties (contact data)
  status       text        NOT NULL DEFAULT 'staged',
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stg_masters__pk PRIMARY KEY (id),
  CONSTRAINT stg_masters__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT stg_masters__row__uq UNIQUE (tenant_id, run_id, entity_kind, row_no),
  CONSTRAINT stg_masters__run__fk FOREIGN KEY (tenant_id, run_id) REFERENCES migration_staging.runs (tenant_id, id),
  CONSTRAINT stg_masters__kind__ck CHECK (entity_kind IN ('test','analyte','reference_range','panel','panel_member','doctor',
     'centre','credit_party','price_list','price_list_item')),
  CONSTRAINT stg_masters__status__ck CHECK (status IN ('staged','valid','invalid')),
  CONSTRAINT stg_masters__payload__ck CHECK (jsonb_typeof(payload) = 'object' AND pg_column_size(payload) <= 65536)
);
CREATE INDEX stg_masters__tenant_id_run_kind__idx ON migration_staging.stg_masters (tenant_id, run_id, entity_kind, legacy_code);
GRANT SELECT, INSERT, UPDATE, DELETE ON migration_staging.stg_masters TO lims_migration;

-- ===================================================================== match_pairs (E)
CREATE TABLE migration_staging.match_pairs (
  id                       uuid        NOT NULL,
  tenant_id                uuid        NOT NULL,
  run_id                   uuid        NOT NULL,
  match_class              text        NOT NULL,
  row_a_id                 uuid        NOT NULL,     -- stg_patients.id
  row_b_id                 uuid,                     -- stg_patients.id (NULL for target_possible)
  target_patient_id        uuid,                     -- existing frontdesk patient (target_possible), P1
  row_a_sha256             text        NOT NULL,
  row_b_sha256             text,
  status                   text        NOT NULL DEFAULT 'pending',
  decision                 text,
  decided_by_membership_id uuid,                     -- P1 lab lead
  operator_id              uuid,                     -- P1
  decided_at               timestamptz,
  lab_form_reference       text,                     -- P0 paper sign-off form reference the lab lead's decision rests on (08 A19 D-133)
  note_code                text,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT match_pairs__pk PRIMARY KEY (id),
  CONSTRAINT match_pairs__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT match_pairs__run__fk FOREIGN KEY (tenant_id, run_id) REFERENCES migration_staging.runs (tenant_id, id),
  CONSTRAINT match_pairs__a__fk FOREIGN KEY (tenant_id, row_a_id) REFERENCES migration_staging.stg_patients (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT match_pairs__b__fk FOREIGN KEY (tenant_id, row_b_id) REFERENCES migration_staging.stg_patients (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT match_pairs__class__ck CHECK (match_class IN ('strong','possible','target_possible')),
  CONSTRAINT match_pairs__shape__ck CHECK ((match_class = 'target_possible') = (row_b_id IS NULL AND target_patient_id IS NOT NULL)),
  CONSTRAINT match_pairs__order__ck CHECK (row_b_id IS NULL OR row_a_id < row_b_id),
  CONSTRAINT match_pairs__status__ck CHECK (status IN ('pending','decided','obsolete')),
  CONSTRAINT match_pairs__decision__ck CHECK (
       (status <> 'decided' AND decision IS NULL)
    OR (status = 'decided' AND decided_at IS NOT NULL AND decided_by_membership_id IS NOT NULL AND lab_form_reference IS NOT NULL AND (
         (match_class IN ('strong','possible') AND decision IN ('merge','keep_separate'))
      OR (match_class = 'target_possible' AND decision IN ('link','create_new')))))
);
ALTER TABLE migration_staging.match_pairs ADD CONSTRAINT match_pairs__form_ref__ck
  CHECK (lab_form_reference IS NULL OR char_length(lab_form_reference) BETWEEN 1 AND 120);
CREATE UNIQUE INDEX match_pairs__pair__uq ON migration_staging.match_pairs (tenant_id, run_id, row_a_id, coalesce(row_b_id, target_patient_id));
CREATE INDEX match_pairs__tenant_id_run_status__idx ON migration_staging.match_pairs (tenant_id, run_id, status, match_class);
GRANT SELECT, INSERT, UPDATE, DELETE ON migration_staging.match_pairs TO lims_migration;

-- ===================================================================== issues (E)
CREATE TABLE migration_staging.issues (
  id             uuid        NOT NULL,                -- 02-CV §5.2 class E mandatory column (review m#21)
  tenant_id      uuid        NOT NULL,
  run_id         uuid        NOT NULL,
  seq            bigint      NOT NULL,
  entity         text        NOT NULL,
  staging_row_id uuid,                               -- NULL for file/run-level issues
  rule_code      text        NOT NULL,
  severity       text        NOT NULL,
  column_key     text,
  message        text        NOT NULL,               -- P0: never contains a cell value of a PHI column (PRD AC-04.7)
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid        NOT NULL,
  CONSTRAINT issues__pk PRIMARY KEY (tenant_id, run_id, seq),
  CONSTRAINT issues__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT issues__run__fk FOREIGN KEY (tenant_id, run_id) REFERENCES migration_staging.runs (tenant_id, id),
  CONSTRAINT issues__entity__ck CHECK (entity IN ('run','file','patients','visits','results','documents','financial','masters','match')),
  CONSTRAINT issues__rule__ck CHECK (rule_code ~ '^mig\.[a-z_]+\.[a-z_]+$'),
  CONSTRAINT issues__sev__ck CHECK (severity IN ('error','warning','info')),
  CONSTRAINT issues__len__ck CHECK (char_length(message) <= 300 AND coalesce(char_length(column_key),0) <= 64)
);
CREATE INDEX issues__tenant_id_run_rule__idx ON migration_staging.issues (tenant_id, run_id, rule_code, severity);
GRANT SELECT, INSERT, DELETE ON migration_staging.issues TO lims_migration;

-- ===================================================================== samples (E)
CREATE TABLE migration_staging.samples (
  id                  uuid        NOT NULL,
  tenant_id           uuid        NOT NULL,
  run_id              uuid        NOT NULL,
  seed_sha256         text        NOT NULL,           -- digest of the seed (seed itself in reports.body)
  stratum             text        NOT NULL,           -- P0 e.g. 'first_visit_year:2024'
  stg_patient_id      uuid        NOT NULL,
  verdict             text        NOT NULL DEFAULT 'pending',
  verdict_reason_code text,
  ui_confirmed        boolean     NOT NULL DEFAULT false,
  operator_id         uuid,
  lab_membership_id   uuid,
  reviewed_at         timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT samples__pk PRIMARY KEY (id),
  CONSTRAINT samples__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT samples__run__fk FOREIGN KEY (tenant_id, run_id) REFERENCES migration_staging.runs (tenant_id, id),
  CONSTRAINT samples__patient__fk FOREIGN KEY (tenant_id, stg_patient_id) REFERENCES migration_staging.stg_patients (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT samples__verdict__ck CHECK (verdict IN ('pending','pass','fail')),
  CONSTRAINT samples__reviewed__ck CHECK (verdict = 'pending' OR (reviewed_at IS NOT NULL AND operator_id IS NOT NULL))
);
CREATE UNIQUE INDEX samples__run_patient__uq ON migration_staging.samples (tenant_id, run_id, seed_sha256, stg_patient_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON migration_staging.samples TO lims_migration;

-- ===================================================== §4 mutability triggers (verbatim)
CREATE TRIGGER runs__mutable_columns BEFORE UPDATE ON migration_staging.runs FOR EACH ROW EXECUTE FUNCTION
  app.enforce_mutable_columns('status','canonical_format_version','extract_id','manifest_sha256','extracted_at','data_as_of',
    'source_timezone','transformer_name','transformer_version','staged_by','counts','last_progress_at','signed_off_at',
    'purge_not_before','purged_at','end_reason_code','is_active','updated_at','updated_by','version');
CREATE TRIGGER batches__mutable_columns BEFORE UPDATE ON migration_staging.batches FOR EACH ROW EXECUTE FUNCTION
  app.enforce_mutable_columns('status','attempts','outcome_counts','committed_at','owner_row_count','owner_digest_sha256',
    'verified_at','verify_ok','voided_at','not_voidable','last_error_code','updated_at','updated_by','version');
CREATE TRIGGER run_files__mutable_columns BEFORE UPDATE ON migration_staging.run_files FOR EACH ROW EXECUTE FUNCTION
  app.enforce_mutable_columns('rows_staged','bytes','state','updated_at','updated_by','version');
-- audit.tg_row_audit attached to runs, run_files, crosswalk_entries, batches (C0 standard); NOT to stg_*, match_pairs, issues, samples (§1.5)

-- ===================================================== C0 tenant FK (C0 05-SCHEMA §9 rule 1; the 14 tables whose DDL lacks it)
ALTER TABLE migration_staging.run_events ADD CONSTRAINT run_events__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id);
ALTER TABLE migration_staging.run_files ADD CONSTRAINT run_files__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id);
ALTER TABLE migration_staging.batches ADD CONSTRAINT batches__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id);
ALTER TABLE migration_staging.reports ADD CONSTRAINT reports__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id);
ALTER TABLE migration_staging.signoffs ADD CONSTRAINT signoffs__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id);
ALTER TABLE migration_staging.stg_patients ADD CONSTRAINT stg_patients__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id);
ALTER TABLE migration_staging.stg_visits ADD CONSTRAINT stg_visits__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id);
ALTER TABLE migration_staging.stg_results ADD CONSTRAINT stg_results__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id);
ALTER TABLE migration_staging.stg_documents ADD CONSTRAINT stg_documents__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id);
ALTER TABLE migration_staging.stg_financial ADD CONSTRAINT stg_financial__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id);
ALTER TABLE migration_staging.stg_masters ADD CONSTRAINT stg_masters__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id);
ALTER TABLE migration_staging.match_pairs ADD CONSTRAINT match_pairs__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id);
ALTER TABLE migration_staging.issues ADD CONSTRAINT issues__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id);
ALTER TABLE migration_staging.samples ADD CONSTRAINT samples__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id);

-- ===================================================== C0 lifecycle guard (§4 closing paragraph; 03-APP-FLOW §2 T1..T22 + G4) [CR-C18-001]
-- SECURITY INVOKER, search_path ''. Allowed OLD.status -> NEW.status pairs; anything else raises P0001 'immutable_row' (02-CV §5.7).
-- T1 is the INSERT ('created' is the column default); a same-status UPDATE (T12 stale 'loading' re-entry, column updates) passes.
-- [CONV] G4 (crosswalk import / match decide: validated / dry_run_passed / approved_for_load -> staged) is admitted.
CREATE FUNCTION migration_staging.runs_lifecycle_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;
  IF NOT (CASE OLD.status
      WHEN 'created'           THEN NEW.status IN ('staging', 'abandoned')                        -- T2, T22
      WHEN 'staging'           THEN NEW.status IN ('staged', 'abandoned')                         -- T3, T22
      WHEN 'staged'            THEN NEW.status IN ('validating', 'abandoned')                     -- T4, T22
      WHEN 'validating'        THEN NEW.status IN ('validated', 'validation_failed', 'abandoned') -- T5, T6, T22
      WHEN 'validated'         THEN NEW.status IN ('dry_running', 'staged', 'abandoned')          -- T7, G4, T22
      WHEN 'validation_failed' THEN NEW.status IN ('validating', 'abandoned')                     -- T4, T22
      WHEN 'dry_running'       THEN NEW.status IN ('dry_run_passed', 'dry_run_failed', 'abandoned') -- T8, T9, T22
      WHEN 'dry_run_passed'    THEN NEW.status IN ('approved_for_load', 'staged', 'abandoned')    -- T11, G4, T22
      WHEN 'dry_run_failed'    THEN NEW.status IN ('validating', 'abandoned')                     -- T10, T22
      WHEN 'approved_for_load' THEN NEW.status IN ('loading', 'staged', 'abandoned')              -- T12, G4, T22
      WHEN 'loading'           THEN NEW.status IN ('loaded', 'load_failed')                       -- T13, T14
      WHEN 'loaded'            THEN NEW.status IN ('verifying', 'voiding')                        -- T15, T19
      WHEN 'load_failed'       THEN NEW.status IN ('loading', 'voiding')                          -- T12, T19
      WHEN 'verifying'         THEN NEW.status IN ('verified', 'verify_failed')                   -- T16, T17
      WHEN 'verified'          THEN NEW.status IN ('signed_off', 'voiding')                       -- T18, T19
      WHEN 'verify_failed'     THEN NEW.status IN ('verifying', 'voiding')                        -- T15, T19
      WHEN 'signed_off'        THEN NEW.status IN ('purged')                                      -- T21
      WHEN 'voiding'           THEN NEW.status IN ('voided', 'voided_partial')                    -- T20
      WHEN 'voided'            THEN NEW.status IN ('purged')                                      -- T21
      WHEN 'voided_partial'    THEN NEW.status IN ('purged')                                      -- T21
      WHEN 'abandoned'         THEN NEW.status IN ('purged')                                      -- T21
      WHEN 'purged'            THEN false                                                         -- terminal
      ELSE false
    END) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row',
      DETAIL = format('migration_staging.runs: status %s -> %s is not a transition of 03-APP-FLOW §2', OLD.status, NEW.status);
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER runs__lifecycle_guard BEFORE UPDATE OF status ON migration_staging.runs
  FOR EACH ROW EXECUTE FUNCTION migration_staging.runs_lifecycle_guard();

-- ===================================================== row audit (C0 app.tg_row_audit; §4 closing comment, §12.8)
CREATE TRIGGER runs__audit AFTER INSERT OR UPDATE OR DELETE ON migration_staging.runs FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER run_files__audit AFTER INSERT OR UPDATE OR DELETE ON migration_staging.run_files FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER crosswalk_entries__audit AFTER INSERT OR UPDATE OR DELETE ON migration_staging.crosswalk_entries FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER batches__audit AFTER INSERT OR UPDATE OR DELETE ON migration_staging.batches FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();

-- ===================================================== §2 grants (migration part, verbatim)
GRANT USAGE ON SCHEMA migration_staging TO lims_migration;
GRANT EXECUTE ON FUNCTION app.core_resolve_tenant_code(text) TO lims_migration;   -- resolve --tenant <code> (D-121)
GRANT EXECUTE ON FUNCTION app.cron_tenant_ids() TO lims_migration;                -- status --metrics tenant list (A13 P-6)

-- ===================================================== §5 RLS (a): ENABLE + FORCE on all 16 tables
ALTER TABLE migration_staging.runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration_staging.run_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration_staging.run_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration_staging.crosswalk_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration_staging.batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration_staging.reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration_staging.signoffs ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration_staging.stg_patients ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration_staging.stg_visits ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration_staging.stg_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration_staging.stg_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration_staging.stg_financial ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration_staging.stg_masters ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration_staging.match_pairs ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration_staging.issues ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration_staging.samples ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration_staging.runs FORCE ROW LEVEL SECURITY;
ALTER TABLE migration_staging.run_events FORCE ROW LEVEL SECURITY;
ALTER TABLE migration_staging.run_files FORCE ROW LEVEL SECURITY;
ALTER TABLE migration_staging.crosswalk_entries FORCE ROW LEVEL SECURITY;
ALTER TABLE migration_staging.batches FORCE ROW LEVEL SECURITY;
ALTER TABLE migration_staging.reports FORCE ROW LEVEL SECURITY;
ALTER TABLE migration_staging.signoffs FORCE ROW LEVEL SECURITY;
ALTER TABLE migration_staging.stg_patients FORCE ROW LEVEL SECURITY;
ALTER TABLE migration_staging.stg_visits FORCE ROW LEVEL SECURITY;
ALTER TABLE migration_staging.stg_results FORCE ROW LEVEL SECURITY;
ALTER TABLE migration_staging.stg_documents FORCE ROW LEVEL SECURITY;
ALTER TABLE migration_staging.stg_financial FORCE ROW LEVEL SECURITY;
ALTER TABLE migration_staging.stg_masters FORCE ROW LEVEL SECURITY;
ALTER TABLE migration_staging.match_pairs FORCE ROW LEVEL SECURITY;
ALTER TABLE migration_staging.issues FORCE ROW LEVEL SECURITY;
ALTER TABLE migration_staging.samples FORCE ROW LEVEL SECURITY;

-- ===================================================== §5 policies (a)..(d) expanded; (e) append-only tables get no UPDATE / DELETE policy
CREATE POLICY runs__select__tenant ON migration_staging.runs FOR SELECT TO lims_migration
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY runs__insert__tenant ON migration_staging.runs FOR INSERT TO lims_migration
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY runs__update__tenant ON migration_staging.runs FOR UPDATE TO lims_migration
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY run_events__select__tenant ON migration_staging.run_events FOR SELECT TO lims_migration
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY run_events__insert__tenant ON migration_staging.run_events FOR INSERT TO lims_migration
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY run_files__select__tenant ON migration_staging.run_files FOR SELECT TO lims_migration
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY run_files__insert__tenant ON migration_staging.run_files FOR INSERT TO lims_migration
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY run_files__update__tenant ON migration_staging.run_files FOR UPDATE TO lims_migration
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY crosswalk_entries__select__tenant ON migration_staging.crosswalk_entries FOR SELECT TO lims_migration
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY crosswalk_entries__insert__tenant ON migration_staging.crosswalk_entries FOR INSERT TO lims_migration
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY crosswalk_entries__update__tenant ON migration_staging.crosswalk_entries FOR UPDATE TO lims_migration
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY batches__select__tenant ON migration_staging.batches FOR SELECT TO lims_migration
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY batches__insert__tenant ON migration_staging.batches FOR INSERT TO lims_migration
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY batches__update__tenant ON migration_staging.batches FOR UPDATE TO lims_migration
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY reports__select__tenant ON migration_staging.reports FOR SELECT TO lims_migration
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY reports__insert__tenant ON migration_staging.reports FOR INSERT TO lims_migration
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY signoffs__select__tenant ON migration_staging.signoffs FOR SELECT TO lims_migration
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY signoffs__insert__tenant ON migration_staging.signoffs FOR INSERT TO lims_migration
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY stg_patients__select__tenant ON migration_staging.stg_patients FOR SELECT TO lims_migration
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY stg_patients__insert__tenant ON migration_staging.stg_patients FOR INSERT TO lims_migration
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY stg_patients__update__tenant ON migration_staging.stg_patients FOR UPDATE TO lims_migration
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY stg_patients__delete__tenant ON migration_staging.stg_patients FOR DELETE TO lims_migration
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND EXISTS (SELECT 1 FROM migration_staging.runs r
                     WHERE r.tenant_id = stg_patients.tenant_id AND r.id = stg_patients.run_id
                       AND r.status IN ('signed_off','voided','voided_partial','abandoned')
                       AND (r.purge_not_before IS NULL OR r.purge_not_before <= now()
                            OR EXISTS (SELECT 1 FROM migration_staging.signoffs s
                                       WHERE s.tenant_id = r.tenant_id AND s.run_id = r.id AND s.kind = 'early_purge_approval'))));
CREATE POLICY stg_visits__select__tenant ON migration_staging.stg_visits FOR SELECT TO lims_migration
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY stg_visits__insert__tenant ON migration_staging.stg_visits FOR INSERT TO lims_migration
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY stg_visits__update__tenant ON migration_staging.stg_visits FOR UPDATE TO lims_migration
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY stg_visits__delete__tenant ON migration_staging.stg_visits FOR DELETE TO lims_migration
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND EXISTS (SELECT 1 FROM migration_staging.runs r
                     WHERE r.tenant_id = stg_visits.tenant_id AND r.id = stg_visits.run_id
                       AND r.status IN ('signed_off','voided','voided_partial','abandoned')
                       AND (r.purge_not_before IS NULL OR r.purge_not_before <= now()
                            OR EXISTS (SELECT 1 FROM migration_staging.signoffs s
                                       WHERE s.tenant_id = r.tenant_id AND s.run_id = r.id AND s.kind = 'early_purge_approval'))));
CREATE POLICY stg_results__select__tenant ON migration_staging.stg_results FOR SELECT TO lims_migration
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY stg_results__insert__tenant ON migration_staging.stg_results FOR INSERT TO lims_migration
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY stg_results__update__tenant ON migration_staging.stg_results FOR UPDATE TO lims_migration
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY stg_results__delete__tenant ON migration_staging.stg_results FOR DELETE TO lims_migration
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND EXISTS (SELECT 1 FROM migration_staging.runs r
                     WHERE r.tenant_id = stg_results.tenant_id AND r.id = stg_results.run_id
                       AND r.status IN ('signed_off','voided','voided_partial','abandoned')
                       AND (r.purge_not_before IS NULL OR r.purge_not_before <= now()
                            OR EXISTS (SELECT 1 FROM migration_staging.signoffs s
                                       WHERE s.tenant_id = r.tenant_id AND s.run_id = r.id AND s.kind = 'early_purge_approval'))));
CREATE POLICY stg_documents__select__tenant ON migration_staging.stg_documents FOR SELECT TO lims_migration
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY stg_documents__insert__tenant ON migration_staging.stg_documents FOR INSERT TO lims_migration
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY stg_documents__update__tenant ON migration_staging.stg_documents FOR UPDATE TO lims_migration
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY stg_documents__delete__tenant ON migration_staging.stg_documents FOR DELETE TO lims_migration
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND EXISTS (SELECT 1 FROM migration_staging.runs r
                     WHERE r.tenant_id = stg_documents.tenant_id AND r.id = stg_documents.run_id
                       AND r.status IN ('signed_off','voided','voided_partial','abandoned')
                       AND (r.purge_not_before IS NULL OR r.purge_not_before <= now()
                            OR EXISTS (SELECT 1 FROM migration_staging.signoffs s
                                       WHERE s.tenant_id = r.tenant_id AND s.run_id = r.id AND s.kind = 'early_purge_approval'))));
CREATE POLICY stg_financial__select__tenant ON migration_staging.stg_financial FOR SELECT TO lims_migration
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY stg_financial__insert__tenant ON migration_staging.stg_financial FOR INSERT TO lims_migration
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY stg_financial__update__tenant ON migration_staging.stg_financial FOR UPDATE TO lims_migration
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY stg_financial__delete__tenant ON migration_staging.stg_financial FOR DELETE TO lims_migration
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND EXISTS (SELECT 1 FROM migration_staging.runs r
                     WHERE r.tenant_id = stg_financial.tenant_id AND r.id = stg_financial.run_id
                       AND r.status IN ('signed_off','voided','voided_partial','abandoned')
                       AND (r.purge_not_before IS NULL OR r.purge_not_before <= now()
                            OR EXISTS (SELECT 1 FROM migration_staging.signoffs s
                                       WHERE s.tenant_id = r.tenant_id AND s.run_id = r.id AND s.kind = 'early_purge_approval'))));
CREATE POLICY stg_masters__select__tenant ON migration_staging.stg_masters FOR SELECT TO lims_migration
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY stg_masters__insert__tenant ON migration_staging.stg_masters FOR INSERT TO lims_migration
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY stg_masters__update__tenant ON migration_staging.stg_masters FOR UPDATE TO lims_migration
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY stg_masters__delete__tenant ON migration_staging.stg_masters FOR DELETE TO lims_migration
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND EXISTS (SELECT 1 FROM migration_staging.runs r
                     WHERE r.tenant_id = stg_masters.tenant_id AND r.id = stg_masters.run_id
                       AND r.status IN ('signed_off','voided','voided_partial','abandoned')
                       AND (r.purge_not_before IS NULL OR r.purge_not_before <= now()
                            OR EXISTS (SELECT 1 FROM migration_staging.signoffs s
                                       WHERE s.tenant_id = r.tenant_id AND s.run_id = r.id AND s.kind = 'early_purge_approval'))));
CREATE POLICY match_pairs__select__tenant ON migration_staging.match_pairs FOR SELECT TO lims_migration
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY match_pairs__insert__tenant ON migration_staging.match_pairs FOR INSERT TO lims_migration
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY match_pairs__update__tenant ON migration_staging.match_pairs FOR UPDATE TO lims_migration
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY match_pairs__delete__tenant ON migration_staging.match_pairs FOR DELETE TO lims_migration
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND EXISTS (SELECT 1 FROM migration_staging.runs r
                     WHERE r.tenant_id = match_pairs.tenant_id AND r.id = match_pairs.run_id
                       AND r.status IN ('signed_off','voided','voided_partial','abandoned')
                       AND (r.purge_not_before IS NULL OR r.purge_not_before <= now()
                            OR EXISTS (SELECT 1 FROM migration_staging.signoffs s
                                       WHERE s.tenant_id = r.tenant_id AND s.run_id = r.id AND s.kind = 'early_purge_approval'))));
CREATE POLICY issues__select__tenant ON migration_staging.issues FOR SELECT TO lims_migration
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY issues__insert__tenant ON migration_staging.issues FOR INSERT TO lims_migration
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY issues__delete__tenant ON migration_staging.issues FOR DELETE TO lims_migration
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY samples__select__tenant ON migration_staging.samples FOR SELECT TO lims_migration
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY samples__insert__tenant ON migration_staging.samples FOR INSERT TO lims_migration
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY samples__update__tenant ON migration_staging.samples FOR UPDATE TO lims_migration
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY samples__delete__tenant ON migration_staging.samples FOR DELETE TO lims_migration
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND EXISTS (SELECT 1 FROM migration_staging.runs r
                     WHERE r.tenant_id = samples.tenant_id AND r.id = samples.run_id
                       AND r.status IN ('signed_off','voided','voided_partial','abandoned')
                       AND (r.purge_not_before IS NULL OR r.purge_not_before <= now()
                            OR EXISTS (SELECT 1 FROM migration_staging.signoffs s
                                       WHERE s.tenant_id = r.tenant_id AND s.run_id = r.id AND s.kind = 'early_purge_approval'))));
