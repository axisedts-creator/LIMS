# C18 Legacy Data Migration — 05 SCHEMA (`migration_staging`)

Status: DRAFT, 2026-11-06. This is the specification C0-0B implements (CR-C18-001). Rules: 02-CV §5 (classes, mandatory columns, composite FKs, no ENUM, RLS template, roles); C0 05-SCHEMA §2 (schema `migration_staging` exists, owner `lims_owner`, "never exposed to API roles", "C18 defines its own loader role by CR"); C0 02-TRD §4.2 (migration files for this schema come last in the DAG).

PHI classes per 03-IC §1: **P0** none · **P1** pseudonymous ids · **P2** lab-linked identifiers / personal data · **P3** health data linked to a person.

Appendix B gives the **proposed** DDL of the owner tables C18 loads into (CR-C18-002/003/004). Those tables belong to C4/C5/C6; once accepted, the owner's `05-SCHEMA.md` is authoritative and Appendix B is deleted.

## 1. Rules specific to this schema

1. Only role with any privilege on `migration_staging` objects: `lims_migration` (§2). `lims_app`, `lims_api`, `lims_worker`, `lims_analytics`, `anon`, `authenticated`: none (C0 05-SCHEMA §2 grants no USAGE). CI asserts `has_schema_privilege('<role>', 'migration_staging', 'USAGE') = false` for each of them.
2. Every table: `tenant_id uuid NOT NULL` (no default), ENABLE + FORCE RLS, policies `TO lims_migration` only, each USING / WITH CHECK also containing `(SELECT app.is_staff_or_system())` (08 A17 P-16; no staging table is shared with partner/portal/patient actors), `tenant_id` leading every index and unique constraint (REQ-SEC-023; 02-CV §5.3). **PROPOSED EXCEPTION — needs 08 acceptance after B4** (08 A19 D-136): policies `TO lims_migration` are a deliberate variant of 02-CV §5.8 ("policies target `lims_app`"): targeting `lims_app` would expose staging to the API and worker, which 01 §3 forbids. On acceptance it is recorded in `db/meta/tables.yaml` as `policy_role: lims_migration` with this reason. The related proposal `GRANT lims_app TO lims_migration` (§2) is the same kind of item (07 §4 item 3).
3. IDs: UUIDv7 from application code (`@lims/shared-ts/uuidv7`), no DEFAULT (04 D9).
4. No ENUM types; `text + CHECK` (02-CV §5.5).
5. **PROPOSED EXCEPTION — needs 08 acceptance after B4** (08 A19 D-136). **Row audit trigger exclusion** for staging row tables (`stg_*`, `match_pairs`, `issues`, `samples`): C0's generic `audit.tg_row_audit` is **not** attached. Reason: these tables hold a full copy of the package (millions of P2/P3 rows); copying them into `audit.audit_log` (retained ≥ 5 years, 04 D11) would duplicate the PHI the purge is meant to remove (REQ-SEC-139) and double the write volume. Integrity is covered by `source_row_sha256` + `run_files.sha256` and command-level audit in `run_events`. Permanent tables (`runs`, `run_files`, `crosswalk_entries`, `batches`, `signoffs`) are audited. Flagged for the security reviewer (07-SECURITY §4).
6. **PROPOSED EXCEPTION — needs 08 acceptance after B4** (08 A19 D-136). **Expiry per run, not per row** for class-E tables: 02-CV §5.2 lists `expires_at` as mandatory for class E. Staging rows instead expire with their run (`runs.purge_not_before`); writing `expires_at` on millions of rows at sign-off would be a pointless mass update. Consequently the purge DELETE policy (§5) is bound to the run's state and `purge_not_before`, not to a row `expires_at` as in 08 A17 P-18(c). On acceptance it is listed in 08 §4 / 02-CV §5.2 and `db/meta/tables.yaml`.
   **Mandatory-column exceptions** (08 A17 P-18(b) paragraph): every class-E staging table has `id`, `tenant_id`, `created_at` (all now including `issues`, which has `id` + `UNIQUE (tenant_id, id)`); none has `expires_at` (this item 6). The staging row tables also omit `version`/`is_active`/`updated_by`: users never edit them directly; only the tool's commands update their derived and lifecycle columns.
7. **PROPOSED EXCEPTION — needs 08 acceptance after B4** (08 A19 D-136). **Class "C-legacy"** for the owner legacy tables of Appendix B (`frontdesk.patient_legacy_refs`, `lab.legacy_results`, `reporting.legacy_documents`): defined as **class C (content immutable, never deleted by `lims_app`) whose only mutable columns are the lifecycle columns listed in each table's `app.enforce_mutable_columns` trigger** (supersede/void/state columns, `is_active`, `updated_*`, `version`). It is not a 02-CV class today; on acceptance the owner records it in its 05-SCHEMA and 08 §4 / 02-CV §5.2.
8. No FK from any staging table into another module schema, except `→ core.tenants` and `→ core.collection_centres` (core is upstream of everything, 01 §5 R3). Target ids of owner rows (`target_patient_id`, …) are plain `uuid` without FK: staging is purged independently and must never block owner writes.
9. No `event_inbox` (C0 05-SCHEMA §3.9 excludes this schema).
10. No published views.

## 2. Role and grants (`db/bootstrap/00_roles.sql` addition + migration `…_migration_staging__grants.sql`)

```sql
-- bootstrap (provisioning superuser; C1 runbook step) — CR-C18-001
CREATE ROLE lims_migration LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD :'lims_migration_pw';
GRANT lims_app TO lims_migration WITH INHERIT TRUE, SET FALSE;   -- runs owner port code under lims_app grants + RLS — PROPOSED EXCEPTION, needs 08 acceptance after B4 (D-136)
ALTER ROLE lims_migration SET search_path = '';
ALTER ROLE lims_migration SET idle_in_transaction_session_timeout = '300s';   -- [CONV] dry-run transactions hold work between port calls
ALTER ROLE lims_migration SET statement_timeout = '30min';                    -- [CONV] set-based validation on 10 M rows
ALTER ROLE lims_migration NOLOGIN;   -- C1 playbook migration-window.yml toggles LOGIN for approved windows only (CR-C18-006)
GRANT CONNECT ON DATABASE :"dbname" TO lims_migration;

-- migration (lims_migrator → SET LOCAL ROLE lims_owner)
GRANT USAGE ON SCHEMA migration_staging TO lims_migration;
-- existing C0 DEFINERs used by the tool (08 A19 D-134; added to their 08 §4.7 / 03-IC §13.3 EXECUTE lists on acceptance of CR-C18-001):
GRANT EXECUTE ON FUNCTION app.core_resolve_tenant_code(text) TO lims_migration;   -- resolve --tenant <code> (D-121)
GRANT EXECUTE ON FUNCTION app.cron_tenant_ids() TO lims_migration;                -- status --metrics tenant list (A13 P-6)
-- per-table grants: §4 grant lines
```

CI assertions (C0 `db/tests/roles/` additions): `lims_migration` has `rolbypassrls = false`, `rolsuper = false`, owns no object, is not a member of `lims_owner`, `lims_queue` (the auth-hook role of CR-C0-007 is not created — 08 R10); `rolcanlogin = false` in the committed bootstrap state.

## 3. Table inventory

| Table | Class (02-CV §5.2) | Lifetime | Max PHI | Audited | Purpose |
|---|---|---|---|---|---|
| `runs` | M (lifecycle `status`) | permanent | P1 | yes | one migration run |
| `run_events` | A | permanent | P1 | — (A) | command audit trail |
| `run_files` | M (progress columns) | permanent | P0 | yes | package files, hashes, counts |
| `crosswalk_entries` | M | permanent (tenant-level) | P2 (doctor display names) | yes | legacy code → target |
| `batches` | M (lifecycle) | permanent | P1 | yes | load/void batch ledger |
| `reports` | A | permanent | P0 | — (A) | reconciliation reports (JSON) |
| `signoffs` | A | permanent | P2 (signatory display name) | — (A) | approvals and lab sign-off |
| `stg_patients` | E | purged with run | P2 | no (§1.5) | staged patients |
| `stg_visits` | E | purged | P2 | no | staged visits |
| `stg_results` | E | purged | P3 | no | staged results |
| `stg_documents` | E | purged | P3 (title) | no | staged document metadata |
| `stg_financial` | E | purged | P2 + financial | no | dues, balances, invoice refs |
| `stg_masters` | E | purged | P2 (doctor contact) | no | masters for workbooks |
| `match_pairs` | E | purged | P1 | no | duplicate candidates + decisions |
| `issues` | E | purged | P0 | no | validation issues |
| `samples` | E | purged | P1 | no | sample checks and verdicts |

All class-E rows above are **PROPOSED EXCEPTION** items for `expires_at` and row audit (§1.5, §1.6). `match_pairs` stores `lab_form_reference` (P0, the paper form number) for every decision (08 A19 D-133).

## 4. DDL

```sql
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
```

Mutability triggers (C0 generic `app.enforce_mutable_columns`, 02-CV §5.7) on permanent tables:
```sql
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
```
`runs.status` transitions are additionally guarded by a C0-written `migration_staging.runs_lifecycle_guard()` (`SECURITY INVOKER`, `SET search_path = ''`) that encodes the transition table of 03-APP-FLOW §2 (T1–T22, G4) [CR-C18-001].

## 5. RLS (exact SQL; template = 02-CV §5.8 `__tenant` with the 08 A17 P-16 staff/system guard, role `lims_migration`)

Predicate used everywhere below (no staging table has `centre_id`-scoped policies, so the 08 A16.1 centre cast does not arise; staging rows carry `centre_id` only as a derived crosswalk value):
`pred_t` = `tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())`

```sql
-- (a) for each <t> in runs, run_files, crosswalk_entries, batches, stg_patients, stg_visits, stg_results, stg_documents,
--     stg_financial, stg_masters, match_pairs, samples, issues, run_events, reports, signoffs:
ALTER TABLE migration_staging.<t> ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration_staging.<t> FORCE ROW LEVEL SECURITY;
CREATE POLICY <t>__select__tenant ON migration_staging.<t> FOR SELECT TO lims_migration
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY <t>__insert__tenant ON migration_staging.<t> FOR INSERT TO lims_migration
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));

-- (b) UPDATE: every table of (a) except the append-only run_events, reports, signoffs and except issues
CREATE POLICY <t>__update__tenant ON migration_staging.<t> FOR UPDATE TO lims_migration
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));

-- (c) DELETE (purge): class E tables stg_*, match_pairs, samples
CREATE POLICY <t>__delete__tenant ON migration_staging.<t> FOR DELETE TO lims_migration
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND EXISTS (SELECT 1 FROM migration_staging.runs r
                     WHERE r.tenant_id = <t>.tenant_id AND r.id = <t>.run_id
                       AND r.status IN ('signed_off','voided','voided_partial','abandoned')
                       AND (r.purge_not_before IS NULL OR r.purge_not_before <= now()
                            OR EXISTS (SELECT 1 FROM migration_staging.signoffs s
                                       WHERE s.tenant_id = r.tenant_id AND s.run_id = r.id AND s.kind = 'early_purge_approval'))));

-- (d) issues: SELECT, INSERT (a) and DELETE without the run-status condition (validate recomputes the issues of a run)
CREATE POLICY issues__delete__tenant ON migration_staging.issues FOR DELETE TO lims_migration
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));

-- (e) append-only run_events, reports, signoffs: SELECT + INSERT of (a) only; no UPDATE/DELETE policy → default deny
```

Policies `TO lims_migration` are a **PROPOSED EXCEPTION** (§1.2). The guard admits only the migration system actor in practice (the tool runtime always sets `actor_type = 'system'`); a probe asserts that partner, portal and patient claims of the same tenant read 0 rows (§12 test 9, P-16).

`app.current_tenant_id()` is set by the tool runtime from the run's tenant (CR-C18-005). `lims_migration` needs `EXECUTE` on `app.current_tenant_id()`, which it inherits from `lims_app` (C0 05-SCHEMA §4).

## 6. Data classification summary (REQ-SEC-004)

| PHI | Columns |
|---|---|
| P3 | `stg_results`: legacy test/analyte codes and names (linked to a patient key), values, ranges, flags, comments; `stg_documents.title`; the PDF bytes on the host volume |
| P2 | all `legacy_*_key`, `legacy_patient_code`, `legacy_registration_no`; `stg_patients` demographics and derived `name_norm`, `phone_e164_norm`, `birth_on_effective`; `stg_documents.file_path`, `stg_financial.document_file_path`; `stg_masters.payload` for doctors/centres/credit parties; `signoffs.lab_signatory_display`; `crosswalk_entries.legacy_display` for kind `doctor` |
| Financial (restricted, 02-CV §9.2) | `stg_financial.amount_paisa`, `gross_paisa` |
| P1 | ids: `target_*`, `batch_id`, membership/staff ids, `match_pairs.target_patient_id`, `batches.not_voidable` |
| P0 | everything else (codes of vocabularies, counts, hashes, statuses, reports) |

## 7. Coded values

All closed lists are `CHECK`s in §4 (statuses, kinds, decisions, outcomes, severities). Rule codes `mig.<area>.<reason>` are a code-owned list (02-TRD §8) validated by pattern. Void/abandon reasons (04-UI-UX §3) are stored in `runs.end_reason_code` validated by pattern; the list lives in `tools/migration/src/domain/codes.ts` [CONV].

## 8. Query → index map

| Query (02-TRD / 03-APP-FLOW) | Index |
|---|---|
| active writing run per tenant (T1/T12 guard) | `runs__tenant_id_active_writer__p_uq` |
| runs due for purge (alert, `status --metrics`) | `runs__tenant_id_purge__p_idx` |
| validate: rows by status per run | `stg_*__tenant_id_run_status__idx` |
| ref checks patient/visit within run | `stg_patients__tenant_id_run_key__idx`, `stg_visits__tenant_id_run_key__idx`, `stg_results__tenant_id_run_patient__idx`, `stg_documents__tenant_id_run_patient__idx` |
| prior-run lookups — the run's ancestor chain via `parent_run_id` in `verified`/`signed_off`, or any `signed_off` run of the tenant (delta `unchanged`, `mig.dup.legacy_key_prior_run`, `mig.ref.patient_unknown`, patient id resolution — 02-TRD §8, §11.6) | `stg_*__tenant_id_key_run__idx` joined with `runs` (`runs__tenant_id_id__uq`, `runs__tenant_id_status__idx`) |
| crosswalk export distinct codes | `stg_results__tenant_id_run_codes__idx` |
| match candidates | `stg_patients__tenant_id_match_name__idx`, `…_match_phone__p_idx` |
| batch planning / apply outcomes | `batches__tenant_id_run_status__idx`, `stg_*__tenant_id_batch__p_idx` |
| issues by rule | `issues__tenant_id_run_rule__idx` |

## 9. Retention and purge

| Data | Retention | Mechanism |
|---|---|---|
| class E staging rows | until `purge` (sign-off + 30 days [CONV], or earlier with approval) | `purge` command; DELETE policy §5 |
| host run directory (package, PDFs, crosswalk CSVs, finance lists) | same as E rows | `purge`: overwrite-then-unlink each file (best effort on SSD/LUKS; the LUKS volume itself is destroyed by C1 when the project closes — CR-C18-006) |
| `runs`, `run_files`, `crosswalk_entries`, `batches`, `reports`, `signoffs`, `run_events` | permanent (P0/P1/P2-minimal), as evidence of what was migrated | no purge in v1; follows audit retention ≥ 5 years (04 I8) |
| PostgreSQL WAL / base backups containing staging rows | until C1 backup retention rotates them out | stated in `purge.md`; staging data in backups is protected like all production data (REQ-SEC-126) |

## 10. Published views

None. Nothing outside C18 reads `migration_staging`.

## 11. Seed data

None in production. `packages/test-fixtures`/C18's synthetic generator produce canonical packages, never staging rows directly. The `migration` system actor row in `core.g_system_actors` (CR-C18-001).

## 12. DB tests C0 adds (`db/tests`, REQ-SEC-042)

1. For every table: RLS probe — claims tenant A: `SELECT` 0 rows of B; `INSERT` with B's tenant_id fails; `UPDATE`/`DELETE` of B rows affect 0 rows.
2. `lims_api`, `lims_worker`, `lims_app` (directly), `lims_analytics`, `anon`, `authenticated`: `has_table_privilege(..., 'SELECT')` = false on every staging table; `has_schema_privilege(..., 'migration_staging', 'USAGE')` = false.
3. `lims_migration` DELETE on `stg_patients` of a run in `loaded` affects 0 rows; of a `signed_off` run before `purge_not_before` without early approval affects 0 rows; after → succeeds.
4. Append-only: UPDATE on `run_events`, `reports`, `signoffs` by `lims_migration` → permission denied.
5. `runs` lifecycle guard rejects a representative forbidden transition (`validated → loading`) and accepts T1–T22.
6. Mutability trigger: UPDATE of `runs.tenant_id` / `kind` → `immutable_row`.
7. `runs__tenant_id_active_writer__p_uq`: second run of the tenant entering `loading` fails.
8. No `audit.tg_row_audit` trigger on `stg_*`, `match_pairs`, `issues`, `samples` (registry check matches §1.5).
9. P-16 guard probe: partner, portal and patient claims of tenant A read 0 rows of every staging table and cannot insert (08 A17 P-16).
10. `match_pairs` with `status = 'decided'` and no `lab_form_reference` → CHECK violation (D-133).
11. `lims_migration` can EXECUTE `app.core_resolve_tenant_code` and `app.cron_tenant_ids` and no other DEFINER (D-134).

---

## Appendix A — Target mapping (canonical → owner, via ports)

| Canonical (02-TRD §6.4) | Staging | Port field | Owner table.column (Appendix B / existing) |
|---|---|---|---|
| patients.legacy_patient_key / legacy_patient_code | stg_patients.* | `legacyRefs[].legacyPatientKey/legacyPatientCode` | `frontdesk.patient_legacy_refs.legacy_patient_key/legacy_patient_code` |
| full_name | full_name | `fullName` | `frontdesk.patients.full_name` (C4 normalises `name_search`) |
| sex_raw → crosswalk sex | sex | `sex` | `frontdesk.patients.sex` |
| birth_on / age_* | birth_on_effective (+ estimated) | `birthOn`, `isBirthOnEstimated` | `frontdesk.patients.birth_on`, `is_birth_on_estimated` |
| phone_raw | phone_e164_norm | `phoneE164` | `frontdesk.patients.phone_e164` |
| email, address_text | same | `email`, `addressText` | `frontdesk.patients.email`, `address_text` |
| centre_legacy_code → crosswalk centre | centre_id | `registeredCentreId` | `frontdesk.patients.registered_centre_id` |
| last_visit_at | same | `lastVisitAt` | `frontdesk.patients.last_visit_at` |
| (decision) | match_pairs | `decision`, `reviewedDuplicates` | `patients.duplicate_override_reason_code = 'legacy_import_reviewed'` |
| (none) | — | — | `frontdesk.patient_consents` row: `source = 'legacy_import'`, all flags false |
| results.* | stg_results.* | `LegacyResultRow` (02-TRD §5.1) | `lab.legacy_results.*` (B.2), same names in snake_case; `value_numeric` = `value_numeric_target`, `ref_low` = `ref_low_target`, `ref_high` = `ref_high_target` (all in `unit_code` units) |
| documents.* + file bytes | stg_documents.* + host file | `LegacyDocumentInput` | `reporting.legacy_documents.*` (B.3) + bucket `reporting-legacy` (08 R26) |
| visits.legacy_registration_no | stg_visits | `legacyRegistrationNo` on result/document rows | `lab.legacy_results.legacy_registration_no`, `reporting.legacy_documents.legacy_registration_no` |
| masters/* | stg_masters | — (workbook) | C3 import (`catalog.*` via C3 code), C2 screens (`core.collection_centres`) |
| financial/* | stg_financial | — | none (BLOCKED B6/B7) |

## Appendix B — Proposed owner DDL (CR proposals; owners' 05-SCHEMA becomes authoritative on acceptance)

### B.1 `frontdesk` (C4, CR-C18-002)

```sql
CREATE TABLE frontdesk.legacy_import_batches (            -- class A + lifecycle (status/void columns)
  id uuid NOT NULL, tenant_id uuid NOT NULL,
  migration_run_id uuid NOT NULL,                         -- P1 plain uuid (no FK into migration_staging: staging is downstream)
  source_system text NOT NULL, content_sha256 text NOT NULL, row_count integer NOT NULL,
  outcomes jsonb NOT NULL,                                -- P1 [{row_ref, outcome, target_id?, reason_code?}]
  digest_sha256 text NOT NULL,
  status text NOT NULL DEFAULT 'committed',
  committed_at timestamptz NOT NULL, voided_at timestamptz, voided_by uuid, void_reason_code text,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT legacy_import_batches__pk PRIMARY KEY (id),
  CONSTRAINT legacy_import_batches__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT legacy_import_batches__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT legacy_import_batches__status__ck CHECK (status IN ('committed','voided','partially_voided')),
  CONSTRAINT legacy_import_batches__sha__ck CHECK (content_sha256 ~ '^[0-9a-f]{64}$' AND digest_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT legacy_import_batches__rows__ck CHECK (row_count BETWEEN 0 AND 200)
);
-- same table shape in lab.legacy_import_batches and reporting.legacy_import_batches (B.2, B.3)

CREATE TABLE frontdesk.patient_legacy_refs (              -- class C-legacy (PROPOSED EXCEPTION, §1.7; content immutable; void columns mutable)
  id uuid NOT NULL, tenant_id uuid NOT NULL, patient_id uuid NOT NULL,
  source_system text NOT NULL,                            -- P0
  legacy_patient_key text NOT NULL,                       -- P2
  legacy_patient_code text,                               -- P2
  legacy_code_search text,                                -- P2 upper(NFC(trim(code)))
  migration_run_id uuid NOT NULL, migration_batch_id uuid NOT NULL, row_sha256 text NOT NULL,   -- = port rowSha256 (02-TRD §10.3)
  voided_at timestamptz, voided_by uuid, void_reason_code text,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT patient_legacy_refs__pk PRIMARY KEY (id),
  CONSTRAINT patient_legacy_refs__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT patient_legacy_refs__patient__fk FOREIGN KEY (tenant_id, patient_id) REFERENCES frontdesk.patients (tenant_id, id),
  CONSTRAINT patient_legacy_refs__batch__fk FOREIGN KEY (tenant_id, migration_batch_id) REFERENCES frontdesk.legacy_import_batches (tenant_id, id),
  CONSTRAINT patient_legacy_refs__source__ck CHECK (source_system ~ '^[a-z][a-z0-9_]{1,31}$'),
  CONSTRAINT patient_legacy_refs__len__ck CHECK (char_length(legacy_patient_key) BETWEEN 1 AND 128 AND coalesce(char_length(legacy_patient_code),0) <= 40)
);
CREATE UNIQUE INDEX patient_legacy_refs__key__p_uq ON frontdesk.patient_legacy_refs (tenant_id, source_system, legacy_patient_key) WHERE voided_at IS NULL;
CREATE INDEX patient_legacy_refs__tenant_id_code__p_idx ON frontdesk.patient_legacy_refs (tenant_id, legacy_code_search) WHERE voided_at IS NULL;
CREATE INDEX patient_legacy_refs__tenant_id_patient__idx ON frontdesk.patient_legacy_refs (tenant_id, patient_id);
CREATE TRIGGER patient_legacy_refs__mutable_columns BEFORE UPDATE ON frontdesk.patient_legacy_refs FOR EACH ROW EXECUTE FUNCTION
  app.enforce_mutable_columns('voided_at','voided_by','void_reason_code','is_active','updated_at','updated_by','version');
-- RLS: C4 template T (tenant) — patients are tenant-scoped (C4 D-PATIENT-SCOPE); grants SELECT, INSERT, UPDATE to lims_app
-- frontdesk.patient_consents: patient_consents__source__ck adds 'legacy_import'
```

### B.2 `lab` (C5, CR-C18-003)

```sql
CREATE TABLE lab.legacy_results (                          -- class C-legacy (PROPOSED EXCEPTION, §1.7)
  id uuid NOT NULL, tenant_id uuid NOT NULL, centre_id uuid NOT NULL,
  patient_id uuid NOT NULL, analyte_id uuid NOT NULL, test_id uuid,
  source_system text NOT NULL,
  legacy_result_key text NOT NULL, legacy_version_no integer NOT NULL,              -- P2 / P0
  legacy_test_code text NOT NULL, legacy_analyte_code text NOT NULL, legacy_display_name text NOT NULL,   -- P3
  result_type text NOT NULL,
  value_numeric numeric, value_text text, ordinal_code text,                        -- P3
  unit_code text, unit_raw text, unit_factor_applied numeric,
  ref_low numeric, ref_high numeric, ref_text text,                                 -- P3
  flag text, flag_raw text, comment_text text, method_text text, specimen_type_raw text,   -- P3
  collected_at timestamptz, reported_at timestamptz NOT NULL,
  legacy_visit_key text, legacy_registration_no text,                               -- P2
  migration_run_id uuid NOT NULL, migration_batch_id uuid NOT NULL, row_sha256 text NOT NULL,   -- = port rowSha256 (02-TRD §10.3)
  superseded_at timestamptz, superseded_by_id uuid,
  voided_at timestamptz, voided_by uuid, void_reason_code text,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT legacy_results__pk PRIMARY KEY (id),
  CONSTRAINT legacy_results__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT legacy_results__patient__fk FOREIGN KEY (tenant_id, patient_id) REFERENCES frontdesk.patients (tenant_id, id),
  CONSTRAINT legacy_results__centre__fk FOREIGN KEY (tenant_id, centre_id) REFERENCES core.collection_centres (tenant_id, id),
  CONSTRAINT legacy_results__analyte__fk FOREIGN KEY (tenant_id, analyte_id) REFERENCES catalog.analytes (tenant_id, id),
  CONSTRAINT legacy_results__test__fk FOREIGN KEY (tenant_id, test_id) REFERENCES catalog.tests (tenant_id, id),
  CONSTRAINT legacy_results__batch__fk FOREIGN KEY (tenant_id, migration_batch_id) REFERENCES lab.legacy_import_batches (tenant_id, id),
  CONSTRAINT legacy_results__type__ck CHECK (result_type IN ('numeric','text','ordinal')),
  CONSTRAINT legacy_results__value__ck CHECK ((result_type = 'numeric' AND value_numeric IS NOT NULL)
     OR (result_type = 'text' AND value_text IS NOT NULL) OR (result_type = 'ordinal' AND ordinal_code IS NOT NULL)),
  CONSTRAINT legacy_results__flag__ck CHECK (flag IS NULL OR flag IN ('N','L','H','LL','HH','A')),
  CONSTRAINT legacy_results__version__ck CHECK (legacy_version_no >= 1),
  CONSTRAINT legacy_results__len__ck CHECK (coalesce(char_length(value_text),0) <= 2000 AND coalesce(char_length(comment_text),0) <= 1000
     AND char_length(legacy_display_name) <= 200 AND coalesce(char_length(ref_text),0) <= 200)
);
CREATE UNIQUE INDEX legacy_results__key__p_uq ON lab.legacy_results (tenant_id, source_system, legacy_result_key, legacy_version_no) WHERE voided_at IS NULL;
CREATE INDEX legacy_results__tenant_id_history__p_idx ON lab.legacy_results (tenant_id, patient_id, analyte_id, reported_at DESC)
  WHERE voided_at IS NULL AND superseded_at IS NULL;                 -- getResultHistory / getAnalyteTrend
CREATE INDEX legacy_results__tenant_id_batch__idx ON lab.legacy_results (tenant_id, migration_batch_id);
CREATE TRIGGER legacy_results__mutable_columns BEFORE UPDATE ON lab.legacy_results FOR EACH ROW EXECUTE FUNCTION
  app.enforce_mutable_columns('superseded_at','superseded_by_id','voided_at','voided_by','void_reason_code','is_active','updated_at','updated_by','version');
-- RLS: 02-CV §5.8 tenant_centre template on centre_id; grants SELECT, INSERT, UPDATE to lims_app; no DELETE (class C)
-- lab.lab_settings: ADD legacy_in_history boolean NOT NULL DEFAULT false (08 A19 D-135; C5 routes #25/#26 pass it as includeLegacy),
--                   ADD legacy_in_delta boolean NOT NULL DEFAULT false
```

### B.3 `reporting` (C6, CR-C18-004)

```sql
CREATE TABLE reporting.legacy_documents (                  -- class C-legacy (PROPOSED EXCEPTION, §1.7; state lifecycle)
  id uuid NOT NULL, tenant_id uuid NOT NULL, centre_id uuid NOT NULL, patient_id uuid NOT NULL,
  source_system text NOT NULL, legacy_document_key text NOT NULL,                   -- P2
  document_kind text NOT NULL, document_date date NOT NULL, title text,             -- title P3
  legacy_visit_key text, legacy_registration_no text,                               -- P2
  mime_type text NOT NULL, size_bytes bigint NOT NULL, sha256_original text NOT NULL,
  quarantine_object_path text NOT NULL, sanitized_object_path text, sanitized_sha256 text, page_count integer,
  state text NOT NULL DEFAULT 'pending_scan', last_error_code text,
  migration_run_id uuid NOT NULL, migration_batch_id uuid NOT NULL, row_sha256 text NOT NULL,   -- = port rowSha256 (02-TRD §10.3)
  voided_at timestamptz, voided_by uuid, void_reason_code text,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT legacy_documents__pk PRIMARY KEY (id),
  CONSTRAINT legacy_documents__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT legacy_documents__patient__fk FOREIGN KEY (tenant_id, patient_id) REFERENCES frontdesk.patients (tenant_id, id),
  CONSTRAINT legacy_documents__centre__fk FOREIGN KEY (tenant_id, centre_id) REFERENCES core.collection_centres (tenant_id, id),
  CONSTRAINT legacy_documents__batch__fk FOREIGN KEY (tenant_id, migration_batch_id) REFERENCES reporting.legacy_import_batches (tenant_id, id),
  CONSTRAINT legacy_documents__kind__ck CHECK (document_kind IN ('lab_report','radiology_report','outsourced_report','other_report')),
  CONSTRAINT legacy_documents__mime__ck CHECK (mime_type = 'application/pdf'),
  CONSTRAINT legacy_documents__size__ck CHECK (size_bytes BETWEEN 1 AND 15728640),
  CONSTRAINT legacy_documents__state__ck CHECK (state IN ('pending_scan','scanning','quarantined','sanitizing','ready','rejected')),
  CONSTRAINT legacy_documents__ready__ck CHECK (state <> 'ready' OR (sanitized_object_path IS NOT NULL AND sanitized_sha256 IS NOT NULL)),
  CONSTRAINT legacy_documents__qpath__ck CHECK (quarantine_object_path LIKE tenant_id::text || '/quarantine/%'),
  CONSTRAINT legacy_documents__spath__ck CHECK (sanitized_object_path IS NULL OR sanitized_object_path LIKE tenant_id::text || '/legacy/%'),
  CONSTRAINT legacy_documents__title__ck CHECK (title IS NULL OR char_length(title) <= 200)
);
CREATE UNIQUE INDEX legacy_documents__key__p_uq ON reporting.legacy_documents (tenant_id, source_system, legacy_document_key) WHERE voided_at IS NULL;
CREATE INDEX legacy_documents__tenant_id_patient__p_idx ON reporting.legacy_documents (tenant_id, patient_id, document_date DESC)
  WHERE voided_at IS NULL;                                             -- listLegacyDocuments
CREATE INDEX legacy_documents__tenant_id_state__p_idx ON reporting.legacy_documents (tenant_id, state, created_at)
  WHERE state IN ('pending_scan','scanning','sanitizing');             -- scan pipeline
CREATE TRIGGER legacy_documents__mutable_columns BEFORE UPDATE ON reporting.legacy_documents FOR EACH ROW EXECUTE FUNCTION
  app.enforce_mutable_columns('state','sanitized_object_path','sanitized_sha256','page_count','last_error_code',
    'voided_at','voided_by','void_reason_code','is_active','updated_at','updated_by','version');
-- RLS: tenant_centre template on centre_id; grants SELECT, INSERT, UPDATE to lims_app
```
Retention of B.1–B.3: same as the owner's clinical records (tenant `retentionYears`, default 5 — 04 I8, B15); no purge in v1.
