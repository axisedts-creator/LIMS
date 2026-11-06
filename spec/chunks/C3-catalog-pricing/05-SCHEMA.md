# C3 Catalog & Pricing — 05 Schema Specification (schema `catalog`)

Status: DECISION draft, 2026-11-05. **This is the specification C0-0B implements as DDL** (01-CM §0). Conventions: 02-CV §5 (classes, mandatory columns, composite FKs per 04 D8, no ENUM types, tenant-leading indexes, RLS template, immutability trigger, published views). Ids are UUIDv7 generated in application code — no DB defaults on `id` (04 D9).

Cross-schema references (01-CM §5 R3, downstream → upstream only): `catalog → core` (`core.tenants`, `core.collection_centres`). **No FK** from `catalog` to `instruments` (instrument ids on code maps are opaque — X4 + R3) and none to any downstream schema. No schema may FK into `billing` (02-CV §5.4) — not relevant here.

---

## 1. Table inventory

| Table | Class (02-CV §5.2) | Tenant | Purpose |
|---|---|---|---|
| `catalog.g_units` | G | no | global unit vocabulary |
| `catalog.g_value_sets`, `catalog.g_value_set_values` | G | no | global ordinal/coded value sets |
| `catalog.g_tax_types` | G | no | VAT (04 L14) |
| `catalog.g_reference_release` | G (singleton) | no | release counter for global fan-out |
| `catalog.catalog_state` | counter (E-like, UPDATE only) | yes | per-tenant `catalog_revision`, root id |
| `catalog.code_counters` | counter | yes | auto codes (`DR00001`, `CP00001`) |
| `catalog.departments`, `specimen_types`, `containers`, `methods` | M | yes | masters |
| `catalog.cs_units`, `cs_value_sets`, `cs_value_set_values` | M (coded sets, tenant shadow) | yes | tenant additions |
| `catalog.orderables` | M | yes | supertype of tests and panels (code uniqueness, search) |
| `catalog.tests`, `catalog.panels` | M | yes | subtypes |
| `catalog.test_specimen_types`, `catalog.panel_members` | M association (DELETE allowed) | yes | |
| `catalog.analytes` | M | yes | analyte identity + display attributes |
| `catalog.analyte_versions` | M versioned (immutable after draft) | yes | clinical attributes |
| `catalog.formula_dependencies` | M child of version (draft-only writes) | yes | graph edges |
| `catalog.reference_range_sets`, `catalog.critical_limit_sets` | M versioned | yes | |
| `catalog.reference_ranges`, `catalog.critical_limits` | M child of set (draft-only writes) | yes | bands |
| `catalog.tat_targets` | M effective-dated | yes | |
| `catalog.comment_codes` | M | yes | |
| `catalog.comment_code_texts` | M effective-dated history (INSERT + close `effective_to` only) | yes | text versions for `CatalogPort.resolveCommentCodes({asOf})` (08 §4.14) |
| `catalog.doctors`, `catalog.credit_parties` | M | yes | |
| `catalog.price_lists` | M | yes | |
| `catalog.price_list_assignments` | M association | yes | |
| `catalog.price_list_versions` | M versioned | yes | |
| `catalog.price_list_items` | M child of version (draft-only writes) | yes | |
| `catalog.surcharge_rules`, `catalog.tax_rules` | M effective-dated | yes | |
| `catalog.cs_tax_types` | M coded set, effective-dated versions per code (08 R18) | yes | extra tax types and their rates (04 L25); C3 is the only owner of tax rates — C4 has no tax table |
| `catalog.instrument_code_maps` | M | yes | X4 |
| `catalog.files` | E | yes | import uploads, reports, exports (bytea) |
| `catalog.imports` | M-like work record (UPDATE status; never deleted) | yes | |
| `catalog.import_issues` | E | yes | |
| `catalog.exports` | M-like work record | yes | |

C3 consumes no events → **no** `catalog.event_inbox` is needed (03-IC §12 creates one per *consuming* module).

## 2. Coded values (text + CHECK; no ENUM)

| Column | Values |
|---|---|
| `orderables.kind` | `test`, `panel` |
| `tests.workflow_type` | `standard`, `narrative`, `microbiology`, `anatomic`, `molecular`, `attachment`, `outsourced` (03-IC §4.2 `WorkflowType`) |
| `analyte_versions.result_type` | `numeric`, `text`, `ordinal`, `coded`, `attachment`, `narrative` (03-IC §4.2 `ResultType`) |
| version `status` (analyte_versions, reference_range_sets, critical_limit_sets, price_list_versions) | `draft`, `published`, `superseded`, `retired`, `discarded` (`retired` not used by analyte/price versions — CHECK per table) |
| `panels.panel_kind` | `clinical`, `package` |
| `orderables.sex_restriction` | `male`, `female` (NULL = none) |
| band `sex` | `any`, `male`, `female` |
| band age units | `day`, `week`, `month`, `year` |
| `reference_ranges.kind` | `numeric`, `text`, `ordinal` |
| `tat_targets.priority` | `routine`, `urgent`; `segment`: `within_lab`, `total` |
| `doctors.source` | `back_office`, `quick_add`, `import` |
| `credit_parties.kind` | `hospital`, `company`, `clinic`, `partner_lab`, `insurer`, `other` |
| `price_lists.owner_kind` / `price_list_assignments.owner_kind` | `default`, `credit_party`, `referrer`, `centre` |
| `surcharge_rules.scope` | `all`, `department`, `orderable`; `amount_kind`: `flat`, `percent` |
| `tax_rules.scope` | `tenant_default`, `department`, `orderable`; `vat_treatment`: `exempt`, `taxable` |
| `instrument_code_maps.direction` | `inbound`, `outbound`, `both` |
| `files.purpose` | `import_upload`, `import_report`, `export` |
| `imports.kind` | `price_list`, `catalog_master`, `referrers`, `credit_parties` (CR-C18-008) |
| `exports.kind` | `price_list`, `catalog_master`, `referrers` |
| `imports.status` | `uploaded`, `scanning`, `validating`, `validated`, `invalid`, `quarantined`, `committing`, `committed`, `commit_failed`, `discarded`, `expired`, `failed` |
| `exports.status` | `queued`, `building`, `ready`, `failed`, `expired` |
| `import_issues.severity` | `error`, `warning`; `issue_code` = coded set `catalog_import_issue_codes` (02-TRD §8.6), stored as text without CHECK (extensible) |

## 3. Data classification (03-IC §1 PHI classes; REQ-SEC-004)

| Data | Class | Notes |
|---|---|---|
| All catalog definitions, prices, rules, maps, revisions | **P0** | no personal data |
| `doctors.display_name`, `qualification`, `registration_no`, `phone_e164`, `email`, `notes` | **P2-personal** (personal data of doctors; not health data) | contacts only via `purpose:'notification'` / `catalog.referrer.manage`; never logged |
| `credit_parties.contact_phone_e164`, `contact_email`, `pan`, `billing_address` | P2-personal / business | same handling |
| `files.content` | P2 (referrer imports/exports contain doctor contacts; price files P0) — treated as P2 | never logged, never re-served (uploads) |
| `imports`, `exports`, `import_issues` metadata | P0 (`message` is template text; no cell values stored [CONV]) | |
| `created_by`/`updated_by` | P1 (actor uuids) | |

No patient data (P3) exists in this schema.

## 4. Query → index map (every TRD query)

| Query (02-TRD) | Index |
|---|---|
| revision read per request (§6.3) | `catalog_state` PK `(tenant_id)` |
| list masters by tenant/status/code | `<t>__tenant_id_code__uq`, `<t>__tenant_id_is_active__idx` |
| orderable search (§7.9) | `orderables__tenant_id_is_active_kind__idx` (+ heap filter; ≤ 5,000 rows/tenant ASSUMPTION) |
| test bundle load | `analytes__tenant_id_test_id__idx`, `analyte_versions__tenant_id_analyte_id_version_no__uq`, `tat_targets__tenant_id_test_id__idx`, `test_specimen_types` PK |
| range/critical sets per analyte | `reference_range_sets__tenant_id_analyte_id_version_no__uq`, bands `reference_ranges__tenant_id_set_id__idx` (same for critical) |
| one draft per parent | partial unique `…__tenant_id_<parent>_id__draft__p_uq` |
| formula graph | `formula_dependencies__tenant_id_input_analyte_id__idx`, PK |
| panel graph | `panel_members` PK + `panel_members__tenant_id_member_orderable_id__idx` |
| price-list index (assignment → list) | `price_list_assignments__tenant_id_credit_party_id__p_uq`, `…doctor_id…`, `…centre_id…`, `price_lists__tenant_id__default__p_uq` |
| price versions per list | `price_list_versions__tenant_id_price_list_id_version_no__uq` |
| `getPriceListStatus` (02-TRD §7.4a, 08 A24.1) | `price_lists__tenant_id_id__uq` (list + `is_active`), `price_list_versions__tenant_id_price_list_id_version_no__uq` (statuses of its versions); no new index or column |
| price item lookup | `price_list_items__tenant_id_version_id_orderable_id__uq` |
| surcharge/tax rules per tenant | `surcharge_rules__tenant_id_effective_from__idx`, `tax_rules__tenant_id_scope__idx`; open tax rule per (scope, key) `tax_rules__tenant_id_scope_key__open__p_uq` |
| comment resolution | `comment_codes__tenant_id_code_dept__uq` (expression); `asOf` text lookup `comment_code_texts__tenant_id_code_id_from__uq` |
| tax-type rate at `at` | `cs_tax_types__tenant_id_code_effective_from__uq` |
| code maps inbound/outbound | `instrument_code_maps__inbound__p_uq`, `instrument_code_maps__outbound__p_uq`, `instrument_code_maps__tenant_id_instrument_id__idx` |
| doctors lists/search/verify queue | `doctors__tenant_id_doctor_code__uq`, `doctors__tenant_id_is_verified_created_at__idx`, `doctors__tenant_id_is_active__idx` |
| import dedupe | `imports__dedupe__p_idx` |
| imports list / active count | `imports__tenant_id_status_created_at__idx` |
| purge files | `files__tenant_id_expires_at__idx` |

## 5. Immutability and lifecycle rules

1. Versioned tables (`analyte_versions`, `reference_range_sets`, `critical_limit_sets`, `price_list_versions`): when `OLD.status <> 'draft'`, only `status`, `effective_to`, `updated_at`, `updated_by`, `version` may change (C0's `app.enforce_mutable_columns`, attached with a `WHEN` clause); allowed status transitions enforced by `catalog.tg_version_status()` (draft→draft|published|discarded; published→superseded|retired; nothing out of superseded/retired/discarded).
2. Child tables (`reference_ranges`, `critical_limits`, `price_list_items`, `formula_dependencies`): INSERT/UPDATE/DELETE only while the parent row's `status = 'draft'` — `catalog.tg_parent_is_draft(parent_table, fk_column)`.
3. Master rows are never deleted (no DELETE grant/policy). Associations (`test_specimen_types`, `panel_members`, `price_list_assignments`) and E-class tables allow DELETE.
4. `catalog_state.catalog_revision` only increases (`CHECK` via trigger `catalog.tg_revision_monotonic`).
5. Doctor merge flattens chains: when Y is merged into Z, every doctor with `merged_into_id = Y` is updated to Z in the same transaction, so `merged_into_id` is always one hop [CONV].
6. C0 attaches its JSONB audit trigger (04 D11; REQ-ARCH-025) to every tenant table in this schema **except** `files`, `import_issues`, `catalog_state`, `code_counters` (high-volume or content-bearing; their effects are captured by the audited parent rows) [CONV].

## 6. Published views (03-IC §6.6 — columns are a contract)

| View | Columns (exact, in order) |
|---|---|
| `catalog.v_pub_department` | tenant_id, department_id, code, name, is_active |
| `catalog.v_pub_test_directory` | tenant_id, test_id, code, name, department_id, workflow_type, is_active |
| `catalog.v_pub_price_list_items` | tenant_id, price_list_id, price_list_version, owner_kind, owner_id, orderable_id, unit_price_paisa, effective_from, effective_to **+ falls_through (08 A13 D-19, additive)** |
| `catalog.v_pub_referrer_directory` | tenant_id, referrer_id, display_name, is_active **+ canonical_referrer_id (CR-C3-004)** |

`v_pub_price_list_items` emits one row per (assignment × item) of every `published`/`superseded` version of an **active** list (`owner_id` NULL for the default list); inactive lists are excluded (08 A13 D-19, matching "inactive lists are skipped", 03-APP-FLOW §2.5); consumers filter by `effective_from ≤ t < coalesce(effective_to, ∞)` and apply fall-through to the tenant default list themselves using `falls_through`.

## 7. Retention

| Table | Retention |
|---|---|
| Master, versioned, rules, maps, doctors, parties, price lists | forever (never deleted; reports must re-render — 02-CV §5.6) |
| `imports`, `exports` rows | forever [CONV] (small; evidence of who changed prices/ranges, complements audit log) |
| `files` | `expires_at` (NOT NULL, set at insert): upload = `created_at` + 168 h + 30 d at insert; the validate task rewrites the upload's and sets the report's to import `expires_at` + 30 d; exports = created + 30 d [CONV]; purged by `catalog.purge_files` (02-TRD §8.1, §8.3, §10) |
| `import_issues` | `expires_at` = the import's upload-file `expires_at`, set when the issues are written; `catalog.purge_files` deletes rows with `expires_at < now()` [CONV] |
| `catalog_state`, `code_counters` | forever |

## 8. Seed data (C0 `db/seeds`, synthetic; global rows are real vocabulary only where stated)

Global (all environments):
- `g_tax_types`: `('VAT','VAT',1300)` — 13 % (04 L14 VERIFIED).
- `g_units` [CONV vocabulary, not clinical facts]: `g_dl` "g/dL", `g_l` "g/L", `mg_dl` "mg/dL", `mmol_l` "mmol/L", `umol_l` "µmol/L", `u_l` "U/L", `iu_l` "IU/L", `pct` "%", `fl` "fL", `pg` "pg", `x10e3_ul` "10^3/µL", `x10e6_ul` "10^6/µL", `mm_hr` "mm/hr", `ratio` "ratio", `ng_ml` "ng/mL", `pg_ml` "pg/mL", `uiu_ml` "µIU/mL", `meq_l` "mEq/L", `sec` "sec", `none` "" (unitless index).
- `g_value_sets`: `URINE_SEMIQ` ordered {`NEG` Negative, `TRACE` Trace, `1+`, `2+`, `3+`, `4+`}; `POS_NEG` unordered {`NEG` Negative, `POS` Positive}; `PRESENT_ABSENT` unordered {`ABSENT` Absent, `PRESENT` Present}.
- `g_reference_release`: `(1, 1, now())`. **Rule for C0:** every migration/seed that changes a `g_*` table increments `release_no` in the same migration.

Synthetic tenants A and B (non-prod only; `packages/test-fixtures/catalog/starter_catalog_master.xlsx` + `starter_price_list.xlsx`, built by C0-0A under CR-C3-007 — 08 A13 D-17 — from 02-TRD §8.2 and this list; every value labelled SYNTHETIC in the workbook's Instructions sheet; values are not clinical reference values): ≥3 departments (HAEM, BIOCHEM, CLINPATH, MICRO); specimen types EDTA_WB, SERUM, FL_PLASMA ("FASTING PLASMA FL."), URINE; CBC-style test with sub-headed analytes incl. calculated MENTZER/NLR/PLR/absolute counts and a text-kind Mentzer band; LIPID clinical panel with LDL formula (G5); package `HP_ELITE_M` with `sex_restriction = male`; ordinal urine nitrite; attachment test (HbA1c chromatogram); microbiology test with one narrative module-result analyte; age/sex-banded HB ranges incl. a 0-day band; K critical limits; default price list + a doctor list + a centre list + a credit-party list with different prices (precedence fixture for 03-IC §4.2 test 6); one surcharge rule; tenant-default tax rule `exempt` and one `taxable` orderable rule (synthetic, not a tax position); comment codes in HAEM and tenant-wide; one merged doctor; one affiliation with `allows_credit = false`. This matches the fake's seeding requirements in 03-IC §4.2.

## 9. RLS summary

Every tenant table: `ENABLE` + `FORCE ROW LEVEL SECURITY`; policies `__select__tenant`, `__insert__tenant`, `__update__tenant` to `lims_app`, each also requiring `(SELECT app.is_staff_or_system())` (CR-C13-011; no catalog table is shared with partner/portal/patient actors); `__delete__tenant` only on DELETE-allowed tables (associations, draft children, E class). No centre-scoped tables (catalog is tenant-wide master data; centre assignments are data, not scope). G tables: no RLS, `SELECT` granted to `lims_app`, listed in `db/tests/rls_exempt.txt` with reason "global reference vocabulary, no tenant data". Views `security_invoker = true`.

## 10. DDL

```sql
-- =====================================================================
-- Schema catalog (owner lims_owner). Migration files per 02-CV §5.12, e.g.
-- 20261105090000_catalog__create_schema.sql … one logical change per file; policies in the same file as the table.
-- =====================================================================
CREATE SCHEMA IF NOT EXISTS catalog AUTHORIZATION lims_owner;
GRANT USAGE ON SCHEMA catalog TO lims_app;

-- ---------- Global (G) tables: no tenant_id, no RLS (rls_exempt.txt) ----------
CREATE TABLE catalog.g_units (
  id          uuid        NOT NULL,
  code        text        NOT NULL CONSTRAINT g_units__code__ck CHECK (code ~ '^[A-Za-z0-9_]{1,32}$'),
  display     text        NOT NULL CONSTRAINT g_units__display__ck CHECK (length(display) <= 32),
  sort_order  integer     NOT NULL DEFAULT 100,
  is_active   boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT g_units__pk PRIMARY KEY (id),
  CONSTRAINT g_units__code__uq UNIQUE (code)
);
CREATE TABLE catalog.g_value_sets (
  id          uuid        NOT NULL,
  code        text        NOT NULL CONSTRAINT g_value_sets__code__ck CHECK (code ~ '^[A-Z0-9_]{1,32}$'),
  display     text        NOT NULL CONSTRAINT g_value_sets__display__ck CHECK (length(display) BETWEEN 1 AND 80),
  is_ordered  boolean     NOT NULL,
  is_active   boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT g_value_sets__pk PRIMARY KEY (id),
  CONSTRAINT g_value_sets__code__uq UNIQUE (code)
);
CREATE TABLE catalog.g_value_set_values (
  id              uuid        NOT NULL,
  value_set_code  text        NOT NULL,
  code            text        NOT NULL CONSTRAINT g_value_set_values__code__ck CHECK (code ~ '^[A-Z0-9_+\-]{1,16}$'),
  display         text        NOT NULL CONSTRAINT g_value_set_values__display__ck CHECK (length(display) <= 40),
  system          text,
  system_version  text,
  sort_order      integer     NOT NULL,
  is_active       boolean     NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT g_value_set_values__pk PRIMARY KEY (id),
  CONSTRAINT g_value_set_values__set_code__uq UNIQUE (value_set_code, code),
  CONSTRAINT g_value_set_values__set__fk FOREIGN KEY (value_set_code) REFERENCES catalog.g_value_sets (code)
);
CREATE TABLE catalog.g_tax_types (
  id          uuid        NOT NULL,
  code        text        NOT NULL CONSTRAINT g_tax_types__code__ck CHECK (code ~ '^[A-Z0-9_]{1,16}$'),
  display     text        NOT NULL,
  rate_bp     integer     NOT NULL CONSTRAINT g_tax_types__rate__ck CHECK (rate_bp BETWEEN 0 AND 10000),
  is_active   boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT g_tax_types__pk PRIMARY KEY (id),
  CONSTRAINT g_tax_types__code__uq UNIQUE (code)
);
CREATE TABLE catalog.g_reference_release (
  id          smallint    NOT NULL CONSTRAINT g_reference_release__singleton__ck CHECK (id = 1),
  release_no  integer     NOT NULL CONSTRAINT g_reference_release__no__ck CHECK (release_no >= 1),
  released_at timestamptz NOT NULL DEFAULT now(),
  is_active   boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT g_reference_release__pk PRIMARY KEY (id)
);
GRANT SELECT ON catalog.g_units, catalog.g_value_sets, catalog.g_value_set_values,
                catalog.g_tax_types, catalog.g_reference_release TO lims_app;

-- ---------- Per-tenant counters ----------
CREATE TABLE catalog.catalog_state (
  tenant_id           uuid        NOT NULL,
  catalog_root_id     uuid        NOT NULL,                 -- aggregate id for catalog.changed.v1
  catalog_revision    bigint      NOT NULL DEFAULT 0 CONSTRAINT catalog_state__rev__ck CHECK (catalog_revision >= 0),
  global_release_seen integer     NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid        NOT NULL,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT catalog_state__pk PRIMARY KEY (tenant_id),
  CONSTRAINT catalog_state__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id)
);
CREATE FUNCTION catalog.tg_revision_monotonic() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.catalog_revision < OLD.catalog_revision OR NEW.tenant_id <> OLD.tenant_id
     OR NEW.catalog_root_id <> OLD.catalog_root_id THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'catalog.catalog_state';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER catalog_state__monotonic BEFORE UPDATE ON catalog.catalog_state
  FOR EACH ROW EXECUTE FUNCTION catalog.tg_revision_monotonic();

CREATE TABLE catalog.code_counters (
  tenant_id   uuid        NOT NULL,
  counter_key text        NOT NULL CONSTRAINT code_counters__key__ck CHECK (counter_key IN ('doctor_code','party_code')),
  next_value  bigint      NOT NULL DEFAULT 1 CONSTRAINT code_counters__next__ck CHECK (next_value >= 1),
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid        NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT code_counters__pk PRIMARY KEY (tenant_id, counter_key),
  CONSTRAINT code_counters__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id)
);

-- ---------- Masters ----------
CREATE TABLE catalog.departments (
  id             uuid        NOT NULL,
  tenant_id      uuid        NOT NULL,
  code           text        NOT NULL CONSTRAINT departments__code__ck CHECK (code ~ '^[A-Z0-9][A-Z0-9_]{0,31}$'),
  name           text        NOT NULL CONSTRAINT departments__name__ck CHECK (length(name) BETWEEN 1 AND 100),
  report_order   integer     NOT NULL DEFAULT 100 CONSTRAINT departments__order__ck CHECK (report_order BETWEEN 0 AND 9999),
  report_heading text        CONSTRAINT departments__heading__ck CHECK (length(report_heading) <= 100),
  version        integer     NOT NULL DEFAULT 1,
  is_active      boolean     NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid        NOT NULL,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid        NOT NULL,
  CONSTRAINT departments__pk PRIMARY KEY (id),
  CONSTRAINT departments__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT departments__tenant_id_code__uq UNIQUE (tenant_id, code),
  CONSTRAINT departments__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id)
);
CREATE INDEX departments__tenant_id_is_active__idx ON catalog.departments (tenant_id, is_active);

CREATE TABLE catalog.specimen_types (
  id           uuid        NOT NULL,
  tenant_id    uuid        NOT NULL,
  code         text        NOT NULL CONSTRAINT specimen_types__code__ck CHECK (code ~ '^[A-Z0-9][A-Z0-9_]{0,31}$'),
  name         text        NOT NULL CONSTRAINT specimen_types__name__ck CHECK (length(name) BETWEEN 1 AND 100),
  report_label text        NOT NULL CONSTRAINT specimen_types__label__ck CHECK (length(report_label) BETWEEN 1 AND 100),
  version      integer     NOT NULL DEFAULT 1,
  is_active    boolean     NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid        NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   uuid        NOT NULL,
  CONSTRAINT specimen_types__pk PRIMARY KEY (id),
  CONSTRAINT specimen_types__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT specimen_types__tenant_id_code__uq UNIQUE (tenant_id, code),
  CONSTRAINT specimen_types__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id)
);
CREATE INDEX specimen_types__tenant_id_is_active__idx ON catalog.specimen_types (tenant_id, is_active);

CREATE TABLE catalog.containers (
  id                       uuid        NOT NULL,
  tenant_id                uuid        NOT NULL,
  code                     text        NOT NULL CONSTRAINT containers__code__ck CHECK (code ~ '^[A-Z0-9][A-Z0-9_]{0,31}$'),
  name                     text        NOT NULL CONSTRAINT containers__name__ck CHECK (length(name) BETWEEN 1 AND 100),
  additive                 text        CONSTRAINT containers__additive__ck CHECK (length(additive) <= 60),
  cap_colour_display       text        CONSTRAINT containers__colour__ck CHECK (length(cap_colour_display) <= 40),
  default_specimen_type_id uuid,
  version                  integer     NOT NULL DEFAULT 1,
  is_active                boolean     NOT NULL DEFAULT true,
  created_at               timestamptz NOT NULL DEFAULT now(),
  created_by               uuid        NOT NULL,
  updated_at               timestamptz NOT NULL DEFAULT now(),
  updated_by               uuid        NOT NULL,
  CONSTRAINT containers__pk PRIMARY KEY (id),
  CONSTRAINT containers__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT containers__tenant_id_code__uq UNIQUE (tenant_id, code),
  CONSTRAINT containers__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT containers__specimen_type__fk FOREIGN KEY (tenant_id, default_specimen_type_id)
    REFERENCES catalog.specimen_types (tenant_id, id)
);
CREATE INDEX containers__tenant_id_is_active__idx ON catalog.containers (tenant_id, is_active);

CREATE TABLE catalog.methods (
  id         uuid        NOT NULL,
  tenant_id  uuid        NOT NULL,
  code       text        NOT NULL CONSTRAINT methods__code__ck CHECK (code ~ '^[A-Z0-9][A-Z0-9_]{0,31}$'),
  name       text        NOT NULL CONSTRAINT methods__name__ck CHECK (length(name) BETWEEN 1 AND 120),
  version    integer     NOT NULL DEFAULT 1,
  is_active  boolean     NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid        NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid        NOT NULL,
  CONSTRAINT methods__pk PRIMARY KEY (id),
  CONSTRAINT methods__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT methods__tenant_id_code__uq UNIQUE (tenant_id, code),
  CONSTRAINT methods__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id)
);
CREATE INDEX methods__tenant_id_is_active__idx ON catalog.methods (tenant_id, is_active);

-- Tenant coded sets (shadow global rows by code; service rejects a tenant code equal to a global code)
CREATE TABLE catalog.cs_units (
  id             uuid        NOT NULL,
  tenant_id      uuid        NOT NULL,
  code           text        NOT NULL CONSTRAINT cs_units__code__ck CHECK (code ~ '^[A-Za-z0-9_]{1,32}$'),
  display        text        NOT NULL CONSTRAINT cs_units__display__ck CHECK (length(display) <= 32),
  system         text,
  system_version text,
  sort_order     integer     NOT NULL DEFAULT 100,
  version        integer     NOT NULL DEFAULT 1,
  is_active      boolean     NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid        NOT NULL,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid        NOT NULL,
  CONSTRAINT cs_units__pk PRIMARY KEY (id),
  CONSTRAINT cs_units__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT cs_units__tenant_id_code__uq UNIQUE (tenant_id, code),
  CONSTRAINT cs_units__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id)
);
CREATE TABLE catalog.cs_value_sets (
  id         uuid        NOT NULL,
  tenant_id  uuid        NOT NULL,
  code       text        NOT NULL CONSTRAINT cs_value_sets__code__ck CHECK (code ~ '^[A-Z0-9_]{1,32}$'),
  display    text        NOT NULL CONSTRAINT cs_value_sets__display__ck CHECK (length(display) BETWEEN 1 AND 80),
  is_ordered boolean     NOT NULL,
  version    integer     NOT NULL DEFAULT 1,
  is_active  boolean     NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid        NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid        NOT NULL,
  CONSTRAINT cs_value_sets__pk PRIMARY KEY (id),
  CONSTRAINT cs_value_sets__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT cs_value_sets__tenant_id_code__uq UNIQUE (tenant_id, code),
  CONSTRAINT cs_value_sets__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id)
);
CREATE TABLE catalog.cs_value_set_values (
  id             uuid        NOT NULL,
  tenant_id      uuid        NOT NULL,
  value_set_id   uuid        NOT NULL,
  code           text        NOT NULL CONSTRAINT cs_value_set_values__code__ck CHECK (code ~ '^[A-Z0-9_+\-]{1,16}$'),
  display        text        NOT NULL CONSTRAINT cs_value_set_values__display__ck CHECK (length(display) <= 40),
  system         text,
  system_version text,
  sort_order     integer     NOT NULL,
  version        integer     NOT NULL DEFAULT 1,
  is_active      boolean     NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid        NOT NULL,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid        NOT NULL,
  CONSTRAINT cs_value_set_values__pk PRIMARY KEY (id),
  CONSTRAINT cs_value_set_values__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT cs_value_set_values__set_code__uq UNIQUE (tenant_id, value_set_id, code),
  CONSTRAINT cs_value_set_values__set__fk FOREIGN KEY (tenant_id, value_set_id) REFERENCES catalog.cs_value_sets (tenant_id, id)
);

-- ---------- Orderables (supertype), tests, panels ----------
CREATE TABLE catalog.orderables (
  id              uuid        NOT NULL,
  tenant_id       uuid        NOT NULL,
  kind            text        NOT NULL CONSTRAINT orderables__kind__ck CHECK (kind IN ('test','panel')),
  code            text        NOT NULL CONSTRAINT orderables__code__ck CHECK (code ~ '^[A-Z0-9][A-Z0-9_\-+.]{0,31}$'),
  name            text        NOT NULL CONSTRAINT orderables__name__ck CHECK (length(name) BETWEEN 1 AND 200),
  department_id   uuid,
  sex_restriction text        CONSTRAINT orderables__sex__ck CHECK (sex_restriction IN ('male','female')),
  is_orderable    boolean     NOT NULL DEFAULT true,
  revision        bigint      NOT NULL DEFAULT 0,       -- catalog_revision of last change (TestDefinition/PanelDefinition.revision)
  version         integer     NOT NULL DEFAULT 1,
  is_active       boolean     NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid        NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid        NOT NULL,
  CONSTRAINT orderables__pk PRIMARY KEY (id),
  CONSTRAINT orderables__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT orderables__tenant_id_id_kind__uq UNIQUE (tenant_id, id, kind),
  CONSTRAINT orderables__tenant_id_code__uq UNIQUE (tenant_id, code),
  CONSTRAINT orderables__test_has_department__ck CHECK (kind <> 'test' OR department_id IS NOT NULL),
  CONSTRAINT orderables__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT orderables__department__fk FOREIGN KEY (tenant_id, department_id) REFERENCES catalog.departments (tenant_id, id)
);
CREATE INDEX orderables__tenant_id_is_active_kind__idx ON catalog.orderables (tenant_id, is_active, kind);

CREATE TABLE catalog.tests (
  id            uuid        NOT NULL,
  tenant_id     uuid        NOT NULL,
  kind          text        NOT NULL DEFAULT 'test' CONSTRAINT tests__kind__ck CHECK (kind = 'test'),
  workflow_type text        NOT NULL CONSTRAINT tests__workflow__ck CHECK (workflow_type IN
                  ('standard','narrative','microbiology','anatomic','molecular','attachment','outsourced')),
  report_order  integer     NOT NULL DEFAULT 100 CONSTRAINT tests__order__ck CHECK (report_order BETWEEN 0 AND 9999),
  uses_existing_material boolean NOT NULL DEFAULT false,   -- CR-C11-009: add-on test on existing material (no specimen requirement in C5)
  version       integer     NOT NULL DEFAULT 1,
  is_active     boolean     NOT NULL DEFAULT true,    -- mirrors orderables.is_active (service keeps equal)
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid        NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid        NOT NULL,
  CONSTRAINT tests__pk PRIMARY KEY (id),
  CONSTRAINT tests__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT tests__orderable__fk FOREIGN KEY (tenant_id, id, kind) REFERENCES catalog.orderables (tenant_id, id, kind)
);
CREATE INDEX tests__tenant_id_workflow_type__idx ON catalog.tests (tenant_id, workflow_type);

CREATE TABLE catalog.panels (
  id         uuid        NOT NULL,
  tenant_id  uuid        NOT NULL,
  kind       text        NOT NULL DEFAULT 'panel' CONSTRAINT panels__kind__ck CHECK (kind = 'panel'),
  panel_kind text        NOT NULL CONSTRAINT panels__panel_kind__ck CHECK (panel_kind IN ('clinical','package')),
  version    integer     NOT NULL DEFAULT 1,
  is_active  boolean     NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid        NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid        NOT NULL,
  CONSTRAINT panels__pk PRIMARY KEY (id),
  CONSTRAINT panels__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT panels__orderable__fk FOREIGN KEY (tenant_id, id, kind) REFERENCES catalog.orderables (tenant_id, id, kind)
);

CREATE TABLE catalog.panel_members (
  tenant_id           uuid        NOT NULL,
  panel_id            uuid        NOT NULL,
  member_orderable_id uuid        NOT NULL,
  sort_order          integer     NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid        NOT NULL,
  CONSTRAINT panel_members__pk PRIMARY KEY (tenant_id, panel_id, member_orderable_id),
  CONSTRAINT panel_members__not_self__ck CHECK (panel_id <> member_orderable_id),
  CONSTRAINT panel_members__panel__fk FOREIGN KEY (tenant_id, panel_id) REFERENCES catalog.panels (tenant_id, id),
  CONSTRAINT panel_members__member__fk FOREIGN KEY (tenant_id, member_orderable_id) REFERENCES catalog.orderables (tenant_id, id)
);
CREATE INDEX panel_members__tenant_id_member_orderable_id__idx ON catalog.panel_members (tenant_id, member_orderable_id);

CREATE TABLE catalog.test_specimen_types (
  tenant_id        uuid        NOT NULL,
  test_id          uuid        NOT NULL,
  specimen_type_id uuid        NOT NULL,
  container_id     uuid,
  is_preferred     boolean     NOT NULL DEFAULT false,
  min_volume_ul    integer     CONSTRAINT test_specimen_types__vol__ck CHECK (min_volume_ul BETWEEN 1 AND 100000),
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid        NOT NULL,
  CONSTRAINT test_specimen_types__pk PRIMARY KEY (tenant_id, test_id, specimen_type_id),
  CONSTRAINT test_specimen_types__test__fk FOREIGN KEY (tenant_id, test_id) REFERENCES catalog.tests (tenant_id, id),
  CONSTRAINT test_specimen_types__type__fk FOREIGN KEY (tenant_id, specimen_type_id) REFERENCES catalog.specimen_types (tenant_id, id),
  CONSTRAINT test_specimen_types__container__fk FOREIGN KEY (tenant_id, container_id) REFERENCES catalog.containers (tenant_id, id)
);
CREATE UNIQUE INDEX test_specimen_types__tenant_id_test_id__preferred__p_uq
  ON catalog.test_specimen_types (tenant_id, test_id) WHERE is_preferred;

-- ---------- Analytes and versions ----------
CREATE TABLE catalog.analytes (
  id                uuid        NOT NULL,
  tenant_id         uuid        NOT NULL,
  test_id           uuid        NOT NULL,
  code              text        NOT NULL CONSTRAINT analytes__code__ck CHECK (code ~ '^[A-Z][A-Z0-9_]{0,31}$'),
  name              text        NOT NULL CONSTRAINT analytes__name__ck CHECK (length(name) BETWEEN 1 AND 120),
  print_name        text        CONSTRAINT analytes__print_name__ck CHECK (length(print_name) <= 120),
  report_subheading text        CONSTRAINT analytes__subheading__ck CHECK (length(report_subheading) <= 80),
  sort_order        integer     NOT NULL DEFAULT 100,
  is_reportable     boolean     NOT NULL DEFAULT true,
  version           integer     NOT NULL DEFAULT 1,
  is_active         boolean     NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid        NOT NULL,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  updated_by        uuid        NOT NULL,
  CONSTRAINT analytes__pk PRIMARY KEY (id),
  CONSTRAINT analytes__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT analytes__tenant_id_id_test_id__uq UNIQUE (tenant_id, id, test_id),   -- for code-map FK (analyte ∈ test)
  CONSTRAINT analytes__tenant_id_code__uq UNIQUE (tenant_id, code),
  CONSTRAINT analytes__test__fk FOREIGN KEY (tenant_id, test_id) REFERENCES catalog.tests (tenant_id, id)
);
CREATE INDEX analytes__tenant_id_test_id__idx ON catalog.analytes (tenant_id, test_id, sort_order);

CREATE TABLE catalog.analyte_versions (
  id                  uuid        NOT NULL,
  tenant_id           uuid        NOT NULL,
  analyte_id          uuid        NOT NULL,
  version_no          integer     NOT NULL CONSTRAINT analyte_versions__no__ck CHECK (version_no >= 1),
  status              text        NOT NULL DEFAULT 'draft'
                        CONSTRAINT analyte_versions__status__ck CHECK (status IN ('draft','published','superseded','discarded')),
  result_type         text        NOT NULL CONSTRAINT analyte_versions__result_type__ck CHECK (result_type IN
                        ('numeric','text','ordinal','coded','attachment','narrative')),
  unit_code           text        CONSTRAINT analyte_versions__unit__ck CHECK (unit_code ~ '^[A-Za-z0-9_]{1,32}$'),
  decimals            smallint    CONSTRAINT analyte_versions__decimals__ck CHECK (decimals BETWEEN 0 AND 6),
  method_id           uuid,
  value_set_code      text        CONSTRAINT analyte_versions__vs__ck CHECK (value_set_code ~ '^[A-Z0-9_]{1,32}$'),
  formula_expression  text        CONSTRAINT analyte_versions__formula__ck CHECK (length(formula_expression) <= 500),
  formula_inputs      text[]      NOT NULL DEFAULT '{}',
  formula_input_units jsonb,
  effective_from      timestamptz,
  effective_to        timestamptz,
  change_reason       text        CONSTRAINT analyte_versions__reason__ck CHECK (length(change_reason) <= 500),
  published_at        timestamptz,
  published_by        uuid,
  source_import_id    uuid,       -- catalog_master import that created it; plain uuid, no FK (02-TRD §8.5)
  version             integer     NOT NULL DEFAULT 1,
  is_active           boolean     NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid        NOT NULL,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          uuid        NOT NULL,
  CONSTRAINT analyte_versions__pk PRIMARY KEY (id),
  CONSTRAINT analyte_versions__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT analyte_versions__tenant_id_analyte_id_version_no__uq UNIQUE (tenant_id, analyte_id, version_no),
  CONSTRAINT analyte_versions__analyte__fk FOREIGN KEY (tenant_id, analyte_id) REFERENCES catalog.analytes (tenant_id, id),
  CONSTRAINT analyte_versions__method__fk FOREIGN KEY (tenant_id, method_id) REFERENCES catalog.methods (tenant_id, id),
  CONSTRAINT analyte_versions__numeric_decimals__ck CHECK (result_type <> 'numeric' OR decimals IS NOT NULL),
  CONSTRAINT analyte_versions__valueset__ck CHECK (result_type NOT IN ('ordinal','coded') OR value_set_code IS NOT NULL),
  CONSTRAINT analyte_versions__formula_numeric__ck CHECK (formula_expression IS NULL OR result_type = 'numeric'),
  CONSTRAINT analyte_versions__published_fields__ck CHECK (status IN ('draft','discarded')
             OR (effective_from IS NOT NULL AND published_at IS NOT NULL AND change_reason IS NOT NULL)),
  CONSTRAINT analyte_versions__window__ck CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
CREATE UNIQUE INDEX analyte_versions__tenant_id_analyte_id__draft__p_uq
  ON catalog.analyte_versions (tenant_id, analyte_id) WHERE status = 'draft';
CREATE INDEX analyte_versions__tenant_id_analyte_id_effective_from__idx
  ON catalog.analyte_versions (tenant_id, analyte_id, effective_from);

CREATE TABLE catalog.formula_dependencies (
  tenant_id          uuid        NOT NULL,
  analyte_version_id uuid        NOT NULL,
  analyte_id         uuid        NOT NULL,          -- the formula analyte (denormalised for graph queries)
  input_analyte_id   uuid        NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid        NOT NULL,
  CONSTRAINT formula_dependencies__pk PRIMARY KEY (tenant_id, analyte_version_id, input_analyte_id),
  CONSTRAINT formula_dependencies__not_self__ck CHECK (analyte_id <> input_analyte_id),
  CONSTRAINT formula_dependencies__version__fk FOREIGN KEY (tenant_id, analyte_version_id) REFERENCES catalog.analyte_versions (tenant_id, id),
  CONSTRAINT formula_dependencies__analyte__fk FOREIGN KEY (tenant_id, analyte_id) REFERENCES catalog.analytes (tenant_id, id),
  CONSTRAINT formula_dependencies__input__fk FOREIGN KEY (tenant_id, input_analyte_id) REFERENCES catalog.analytes (tenant_id, id)
);
CREATE INDEX formula_dependencies__tenant_id_input_analyte_id__idx ON catalog.formula_dependencies (tenant_id, input_analyte_id);
CREATE INDEX formula_dependencies__tenant_id_analyte_id__idx ON catalog.formula_dependencies (tenant_id, analyte_id);

-- ---------- Reference-range and critical-limit sets + bands ----------
CREATE TABLE catalog.reference_range_sets (
  id             uuid        NOT NULL,
  tenant_id      uuid        NOT NULL,
  analyte_id     uuid        NOT NULL,
  version_no     integer     NOT NULL CONSTRAINT reference_range_sets__no__ck CHECK (version_no >= 1),
  status         text        NOT NULL DEFAULT 'draft'
                   CONSTRAINT reference_range_sets__status__ck CHECK (status IN ('draft','published','superseded','retired','discarded')),
  unit_code      text        CONSTRAINT reference_range_sets__unit__ck CHECK (unit_code ~ '^[A-Za-z0-9_]{1,32}$'),
  method_id      uuid,
  effective_from timestamptz,
  effective_to   timestamptz,
  change_reason  text        CONSTRAINT reference_range_sets__reason__ck CHECK (length(change_reason) <= 500),
  published_at   timestamptz,
  published_by   uuid,
  source_import_id uuid,          -- catalog_master import that created it; plain uuid, no FK (02-TRD §8.5)
  version        integer     NOT NULL DEFAULT 1,
  is_active      boolean     NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid        NOT NULL,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid        NOT NULL,
  CONSTRAINT reference_range_sets__pk PRIMARY KEY (id),
  CONSTRAINT reference_range_sets__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT reference_range_sets__tenant_id_analyte_id_version_no__uq UNIQUE (tenant_id, analyte_id, version_no),
  CONSTRAINT reference_range_sets__analyte__fk FOREIGN KEY (tenant_id, analyte_id) REFERENCES catalog.analytes (tenant_id, id),
  CONSTRAINT reference_range_sets__method__fk FOREIGN KEY (tenant_id, method_id) REFERENCES catalog.methods (tenant_id, id),
  CONSTRAINT reference_range_sets__published_fields__ck CHECK (status IN ('draft','discarded')
             OR (effective_from IS NOT NULL AND published_at IS NOT NULL AND change_reason IS NOT NULL)),
  CONSTRAINT reference_range_sets__window__ck CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
CREATE UNIQUE INDEX reference_range_sets__tenant_id_analyte_id__draft__p_uq
  ON catalog.reference_range_sets (tenant_id, analyte_id) WHERE status = 'draft';

CREATE TABLE catalog.reference_ranges (
  id               uuid        NOT NULL,
  tenant_id        uuid        NOT NULL,
  set_id           uuid        NOT NULL,
  sex              text        NOT NULL CONSTRAINT reference_ranges__sex__ck CHECK (sex IN ('any','male','female')),
  age_low_value    integer     CONSTRAINT reference_ranges__age_low__ck CHECK (age_low_value BETWEEN 0 AND 200),
  age_low_unit     text        CONSTRAINT reference_ranges__age_low_unit__ck CHECK (age_low_unit IN ('day','week','month','year')),
  age_high_value   integer     CONSTRAINT reference_ranges__age_high__ck CHECK (age_high_value BETWEEN 1 AND 200),
  age_high_unit    text        CONSTRAINT reference_ranges__age_high_unit__ck CHECK (age_high_unit IN ('day','week','month','year')),
  specimen_type_id uuid,
  kind             text        NOT NULL CONSTRAINT reference_ranges__kind__ck CHECK (kind IN ('numeric','text','ordinal')),
  low              numeric,
  high             numeric,
  normal_codes     text[],
  display_text     text        CONSTRAINT reference_ranges__text__ck CHECK (length(display_text) <= 500),
  sort_order       integer     NOT NULL DEFAULT 100,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid        NOT NULL,
  CONSTRAINT reference_ranges__pk PRIMARY KEY (id),
  CONSTRAINT reference_ranges__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT reference_ranges__set__fk FOREIGN KEY (tenant_id, set_id) REFERENCES catalog.reference_range_sets (tenant_id, id),
  CONSTRAINT reference_ranges__specimen__fk FOREIGN KEY (tenant_id, specimen_type_id) REFERENCES catalog.specimen_types (tenant_id, id),
  CONSTRAINT reference_ranges__age_low_pair__ck CHECK ((age_low_value IS NULL) = (age_low_unit IS NULL)),
  CONSTRAINT reference_ranges__age_high_pair__ck CHECK ((age_high_value IS NULL) = (age_high_unit IS NULL)),
  CONSTRAINT reference_ranges__numeric__ck CHECK (kind <> 'numeric' OR low IS NOT NULL OR high IS NOT NULL),
  CONSTRAINT reference_ranges__low_le_high__ck CHECK (low IS NULL OR high IS NULL OR low <= high),
  CONSTRAINT reference_ranges__text__req__ck CHECK (kind = 'numeric' OR display_text IS NOT NULL),
  CONSTRAINT reference_ranges__ordinal__ck CHECK (kind <> 'ordinal' OR cardinality(normal_codes) BETWEEN 1 AND 20),
  CONSTRAINT reference_ranges__nonnumeric_values__ck CHECK (kind = 'numeric' OR (low IS NULL AND high IS NULL))
);
CREATE INDEX reference_ranges__tenant_id_set_id__idx ON catalog.reference_ranges (tenant_id, set_id, sort_order);

CREATE TABLE catalog.critical_limit_sets (
  id             uuid        NOT NULL,
  tenant_id      uuid        NOT NULL,
  analyte_id     uuid        NOT NULL,
  version_no     integer     NOT NULL CONSTRAINT critical_limit_sets__no__ck CHECK (version_no >= 1),
  status         text        NOT NULL DEFAULT 'draft'
                   CONSTRAINT critical_limit_sets__status__ck CHECK (status IN ('draft','published','superseded','retired','discarded')),
  unit_code      text        CONSTRAINT critical_limit_sets__unit__ck CHECK (unit_code ~ '^[A-Za-z0-9_]{1,32}$'),
  method_id      uuid,
  effective_from timestamptz,
  effective_to   timestamptz,
  change_reason  text        CONSTRAINT critical_limit_sets__reason__ck CHECK (length(change_reason) <= 500),
  published_at   timestamptz,
  published_by   uuid,
  source_import_id uuid,          -- catalog_master import that created it; plain uuid, no FK (02-TRD §8.5)
  version        integer     NOT NULL DEFAULT 1,
  is_active      boolean     NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid        NOT NULL,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid        NOT NULL,
  CONSTRAINT critical_limit_sets__pk PRIMARY KEY (id),
  CONSTRAINT critical_limit_sets__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT critical_limit_sets__tenant_id_analyte_id_version_no__uq UNIQUE (tenant_id, analyte_id, version_no),
  CONSTRAINT critical_limit_sets__analyte__fk FOREIGN KEY (tenant_id, analyte_id) REFERENCES catalog.analytes (tenant_id, id),
  CONSTRAINT critical_limit_sets__method__fk FOREIGN KEY (tenant_id, method_id) REFERENCES catalog.methods (tenant_id, id),
  CONSTRAINT critical_limit_sets__published_fields__ck CHECK (status IN ('draft','discarded')
             OR (effective_from IS NOT NULL AND published_at IS NOT NULL AND change_reason IS NOT NULL)),
  CONSTRAINT critical_limit_sets__window__ck CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
CREATE UNIQUE INDEX critical_limit_sets__tenant_id_analyte_id__draft__p_uq
  ON catalog.critical_limit_sets (tenant_id, analyte_id) WHERE status = 'draft';

CREATE TABLE catalog.critical_limits (
  id               uuid        NOT NULL,
  tenant_id        uuid        NOT NULL,
  set_id           uuid        NOT NULL,
  sex              text        NOT NULL CONSTRAINT critical_limits__sex__ck CHECK (sex IN ('any','male','female')),
  age_low_value    integer     CONSTRAINT critical_limits__age_low__ck CHECK (age_low_value BETWEEN 0 AND 200),
  age_low_unit     text        CONSTRAINT critical_limits__age_low_unit__ck CHECK (age_low_unit IN ('day','week','month','year')),
  age_high_value   integer     CONSTRAINT critical_limits__age_high__ck CHECK (age_high_value BETWEEN 1 AND 200),
  age_high_unit    text        CONSTRAINT critical_limits__age_high_unit__ck CHECK (age_high_unit IN ('day','week','month','year')),
  specimen_type_id uuid,
  low              numeric,
  high             numeric,
  abnormal_codes   text[],
  sort_order       integer     NOT NULL DEFAULT 100,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid        NOT NULL,
  CONSTRAINT critical_limits__pk PRIMARY KEY (id),
  CONSTRAINT critical_limits__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT critical_limits__set__fk FOREIGN KEY (tenant_id, set_id) REFERENCES catalog.critical_limit_sets (tenant_id, id),
  CONSTRAINT critical_limits__specimen__fk FOREIGN KEY (tenant_id, specimen_type_id) REFERENCES catalog.specimen_types (tenant_id, id),
  CONSTRAINT critical_limits__age_low_pair__ck CHECK ((age_low_value IS NULL) = (age_low_unit IS NULL)),
  CONSTRAINT critical_limits__age_high_pair__ck CHECK ((age_high_value IS NULL) = (age_high_unit IS NULL)),
  CONSTRAINT critical_limits__something__ck CHECK (low IS NOT NULL OR high IS NOT NULL OR cardinality(abnormal_codes) >= 1),
  CONSTRAINT critical_limits__low_le_high__ck CHECK (low IS NULL OR high IS NULL OR low <= high),
  CONSTRAINT critical_limits__codes_max__ck CHECK (abnormal_codes IS NULL OR cardinality(abnormal_codes) <= 20)
);
CREATE INDEX critical_limits__tenant_id_set_id__idx ON catalog.critical_limits (tenant_id, set_id, sort_order);

-- ---------- TAT targets ----------
CREATE TABLE catalog.tat_targets (
  id             uuid        NOT NULL,
  tenant_id      uuid        NOT NULL,
  test_id        uuid        NOT NULL,
  priority       text        NOT NULL CONSTRAINT tat_targets__priority__ck CHECK (priority IN ('routine','urgent')),
  segment        text        NOT NULL DEFAULT 'within_lab' CONSTRAINT tat_targets__segment__ck CHECK (segment IN ('within_lab','total')),
  target_seconds integer     NOT NULL CONSTRAINT tat_targets__seconds__ck CHECK (target_seconds BETWEEN 60 AND 2592000),
  effective_from timestamptz NOT NULL,
  effective_to   timestamptz,
  version        integer     NOT NULL DEFAULT 1,
  is_active      boolean     NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid        NOT NULL,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid        NOT NULL,
  CONSTRAINT tat_targets__pk PRIMARY KEY (id),
  CONSTRAINT tat_targets__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT tat_targets__test__fk FOREIGN KEY (tenant_id, test_id) REFERENCES catalog.tests (tenant_id, id),
  CONSTRAINT tat_targets__window__ck CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
CREATE INDEX tat_targets__tenant_id_test_id__idx ON catalog.tat_targets (tenant_id, test_id, priority, effective_from);
CREATE UNIQUE INDEX tat_targets__open__p_uq ON catalog.tat_targets (tenant_id, test_id, priority) WHERE effective_to IS NULL;

-- ---------- Comment codes ----------
CREATE TABLE catalog.comment_codes (
  id            uuid        NOT NULL,
  tenant_id     uuid        NOT NULL,
  code          text        NOT NULL CONSTRAINT comment_codes__code__ck CHECK (code ~ '^[A-Z0-9_]{1,16}$'),
  department_id uuid,
  text          text        NOT NULL CONSTRAINT comment_codes__text__ck CHECK (length(text) BETWEEN 1 AND 2000),
  version       integer     NOT NULL DEFAULT 1,
  is_active     boolean     NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid        NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid        NOT NULL,
  CONSTRAINT comment_codes__pk PRIMARY KEY (id),
  CONSTRAINT comment_codes__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT comment_codes__department__fk FOREIGN KEY (tenant_id, department_id) REFERENCES catalog.departments (tenant_id, id)
);
CREATE UNIQUE INDEX comment_codes__tenant_id_code_dept__uq ON catalog.comment_codes
  (tenant_id, code, coalesce(department_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- Text history for resolveCommentCodes({asOf}) (08 §4.14). One row per text version; written in the same
-- transaction as the comment_codes INSERT / text UPDATE (service rule); predecessor gets effective_to = new effective_from.
CREATE TABLE catalog.comment_code_texts (
  id              uuid        NOT NULL,
  tenant_id       uuid        NOT NULL,
  comment_code_id uuid        NOT NULL,
  text_version    integer     NOT NULL CONSTRAINT comment_code_texts__version__ck CHECK (text_version >= 1),  -- = comment_codes.version at write
  text            text        NOT NULL CONSTRAINT comment_code_texts__text__ck CHECK (length(text) BETWEEN 1 AND 2000),
  effective_from  timestamptz NOT NULL,
  effective_to    timestamptz,
  version         integer     NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid        NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid        NOT NULL,
  CONSTRAINT comment_code_texts__pk PRIMARY KEY (id),
  CONSTRAINT comment_code_texts__code__fk FOREIGN KEY (tenant_id, comment_code_id) REFERENCES catalog.comment_codes (tenant_id, id),
  CONSTRAINT comment_code_texts__tenant_id_code_id_from__uq UNIQUE (tenant_id, comment_code_id, effective_from),
  CONSTRAINT comment_code_texts__window__ck CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
CREATE TRIGGER comment_code_texts__mutable_columns BEFORE UPDATE ON catalog.comment_code_texts
  FOR EACH ROW EXECUTE FUNCTION app.enforce_mutable_columns('effective_to','updated_at','updated_by','version');

-- ---------- Doctors and credit parties ----------
CREATE TABLE catalog.doctors (
  id                   uuid        NOT NULL,
  tenant_id            uuid        NOT NULL,
  doctor_code          text        NOT NULL CONSTRAINT doctors__code__ck CHECK (doctor_code ~ '^[A-Z0-9_\-]{1,20}$'),
  display_name         text        NOT NULL CONSTRAINT doctors__name__ck CHECK (length(display_name) BETWEEN 1 AND 120),
  name_normalised      text        NOT NULL,      -- lower, NFC, single spaces; duplicate hints (service-computed)
  qualification        text        CONSTRAINT doctors__qual__ck CHECK (length(qualification) <= 120),
  registration_council text        CONSTRAINT doctors__council__ck CHECK (length(registration_council) <= 20),
  registration_no      text        CONSTRAINT doctors__regno__ck CHECK (length(registration_no) <= 30),
  phone_e164           text        CONSTRAINT doctors__phone__ck CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  email                text        CONSTRAINT doctors__email__ck CHECK (length(email) <= 254),
  notes                text        CONSTRAINT doctors__notes__ck CHECK (length(notes) <= 500),
  is_verified          boolean     NOT NULL DEFAULT false,
  verified_at          timestamptz,
  verified_by          uuid,
  source               text        NOT NULL CONSTRAINT doctors__source__ck CHECK (source IN ('back_office','quick_add','import')),
  merged_into_id       uuid,
  version              integer     NOT NULL DEFAULT 1,
  is_active            boolean     NOT NULL DEFAULT true,
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_by           uuid        NOT NULL,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  updated_by           uuid        NOT NULL,
  CONSTRAINT doctors__pk PRIMARY KEY (id),
  CONSTRAINT doctors__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT doctors__tenant_id_doctor_code__uq UNIQUE (tenant_id, doctor_code),
  CONSTRAINT doctors__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT doctors__merged__fk FOREIGN KEY (tenant_id, merged_into_id) REFERENCES catalog.doctors (tenant_id, id),
  CONSTRAINT doctors__not_self__ck CHECK (merged_into_id IS NULL OR merged_into_id <> id),
  CONSTRAINT doctors__merged_inactive__ck CHECK (merged_into_id IS NULL OR is_active = false)
);
CREATE INDEX doctors__tenant_id_is_verified_created_at__idx ON catalog.doctors (tenant_id, is_verified, created_at);
CREATE INDEX doctors__tenant_id_is_active__idx ON catalog.doctors (tenant_id, is_active);
CREATE INDEX doctors__tenant_id_name_normalised__idx ON catalog.doctors (tenant_id, name_normalised);

CREATE TABLE catalog.credit_parties (
  id                 uuid        NOT NULL,
  tenant_id          uuid        NOT NULL,
  party_code         text        NOT NULL CONSTRAINT credit_parties__code__ck CHECK (party_code ~ '^[A-Z0-9_\-]{1,20}$'),
  name               text        NOT NULL CONSTRAINT credit_parties__name__ck CHECK (length(name) BETWEEN 1 AND 160),
  kind               text        NOT NULL CONSTRAINT credit_parties__kind__ck CHECK (kind IN ('hospital','company','clinic','partner_lab','insurer','other')),
  allows_credit      boolean     NOT NULL DEFAULT true,
  pan                text        CONSTRAINT credit_parties__pan__ck CHECK (length(pan) <= 20),
  contact_phone_e164 text        CONSTRAINT credit_parties__phone__ck CHECK (contact_phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  contact_email      text        CONSTRAINT credit_parties__email__ck CHECK (length(contact_email) <= 254),
  billing_address    text        CONSTRAINT credit_parties__addr__ck CHECK (length(billing_address) <= 500),
  version            integer     NOT NULL DEFAULT 1,
  is_active          boolean     NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid        NOT NULL,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         uuid        NOT NULL,
  CONSTRAINT credit_parties__pk PRIMARY KEY (id),
  CONSTRAINT credit_parties__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT credit_parties__tenant_id_party_code__uq UNIQUE (tenant_id, party_code),
  CONSTRAINT credit_parties__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id)
);
CREATE INDEX credit_parties__tenant_id_is_active__idx ON catalog.credit_parties (tenant_id, is_active);

-- ---------- Price lists ----------
CREATE TABLE catalog.price_lists (
  id            uuid        NOT NULL,
  tenant_id     uuid        NOT NULL,
  code          text        NOT NULL CONSTRAINT price_lists__code__ck CHECK (code ~ '^[A-Z0-9][A-Z0-9_\-]{0,31}$'),
  name          text        NOT NULL CONSTRAINT price_lists__name__ck CHECK (length(name) BETWEEN 1 AND 120),
  owner_kind    text        NOT NULL CONSTRAINT price_lists__owner_kind__ck CHECK (owner_kind IN ('default','credit_party','referrer','centre')),
  falls_through boolean     NOT NULL DEFAULT true,
  version       integer     NOT NULL DEFAULT 1,
  is_active     boolean     NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid        NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid        NOT NULL,
  CONSTRAINT price_lists__pk PRIMARY KEY (id),
  CONSTRAINT price_lists__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT price_lists__tenant_id_id_owner_kind__uq UNIQUE (tenant_id, id, owner_kind),
  CONSTRAINT price_lists__tenant_id_code__uq UNIQUE (tenant_id, code),
  CONSTRAINT price_lists__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT price_lists__default_active__ck CHECK (owner_kind <> 'default' OR is_active)
);
CREATE UNIQUE INDEX price_lists__tenant_id__default__p_uq ON catalog.price_lists (tenant_id) WHERE owner_kind = 'default';

CREATE TABLE catalog.price_list_assignments (
  id              uuid        NOT NULL,
  tenant_id       uuid        NOT NULL,
  price_list_id   uuid        NOT NULL,
  owner_kind      text        NOT NULL CONSTRAINT pla__owner_kind__ck CHECK (owner_kind IN ('credit_party','referrer','centre')),
  credit_party_id uuid,
  doctor_id       uuid,
  centre_id       uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid        NOT NULL,
  CONSTRAINT price_list_assignments__pk PRIMARY KEY (id),
  CONSTRAINT price_list_assignments__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT price_list_assignments__list__fk FOREIGN KEY (tenant_id, price_list_id, owner_kind)
    REFERENCES catalog.price_lists (tenant_id, id, owner_kind),
  CONSTRAINT price_list_assignments__party__fk FOREIGN KEY (tenant_id, credit_party_id) REFERENCES catalog.credit_parties (tenant_id, id),
  CONSTRAINT price_list_assignments__doctor__fk FOREIGN KEY (tenant_id, doctor_id) REFERENCES catalog.doctors (tenant_id, id),
  CONSTRAINT price_list_assignments__centre__fk FOREIGN KEY (tenant_id, centre_id) REFERENCES core.collection_centres (tenant_id, id),
  CONSTRAINT price_list_assignments__one_owner__ck CHECK (
       (owner_kind = 'credit_party' AND credit_party_id IS NOT NULL AND doctor_id IS NULL AND centre_id IS NULL)
    OR (owner_kind = 'referrer'     AND doctor_id IS NOT NULL AND credit_party_id IS NULL AND centre_id IS NULL)
    OR (owner_kind = 'centre'       AND centre_id IS NOT NULL AND credit_party_id IS NULL AND doctor_id IS NULL))
);
CREATE UNIQUE INDEX price_list_assignments__tenant_id_credit_party_id__p_uq ON catalog.price_list_assignments (tenant_id, credit_party_id) WHERE credit_party_id IS NOT NULL;
CREATE UNIQUE INDEX price_list_assignments__tenant_id_doctor_id__p_uq       ON catalog.price_list_assignments (tenant_id, doctor_id)       WHERE doctor_id IS NOT NULL;
CREATE UNIQUE INDEX price_list_assignments__tenant_id_centre_id__p_uq       ON catalog.price_list_assignments (tenant_id, centre_id)       WHERE centre_id IS NOT NULL;
CREATE INDEX price_list_assignments__tenant_id_price_list_id__idx ON catalog.price_list_assignments (tenant_id, price_list_id);

CREATE TABLE catalog.price_list_versions (
  id               uuid        NOT NULL,
  tenant_id        uuid        NOT NULL,
  price_list_id    uuid        NOT NULL,
  version_no       integer     NOT NULL CONSTRAINT price_list_versions__no__ck CHECK (version_no >= 1),
  status           text        NOT NULL DEFAULT 'draft'
                     CONSTRAINT price_list_versions__status__ck CHECK (status IN ('draft','published','superseded','discarded')),
  effective_from   timestamptz,
  effective_to     timestamptz,
  item_count       integer     NOT NULL DEFAULT 0,
  source_import_id uuid,
  change_reason    text        CONSTRAINT price_list_versions__reason__ck CHECK (length(change_reason) <= 500),
  published_at     timestamptz,
  published_by     uuid,
  version          integer     NOT NULL DEFAULT 1,
  is_active        boolean     NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid        NOT NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid        NOT NULL,
  CONSTRAINT price_list_versions__pk PRIMARY KEY (id),
  CONSTRAINT price_list_versions__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT price_list_versions__tenant_id_price_list_id_version_no__uq UNIQUE (tenant_id, price_list_id, version_no),
  CONSTRAINT price_list_versions__list__fk FOREIGN KEY (tenant_id, price_list_id) REFERENCES catalog.price_lists (tenant_id, id),
  CONSTRAINT price_list_versions__published_fields__ck CHECK (status IN ('draft','discarded')
             OR (effective_from IS NOT NULL AND published_at IS NOT NULL AND change_reason IS NOT NULL)),
  CONSTRAINT price_list_versions__window__ck CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
CREATE UNIQUE INDEX price_list_versions__tenant_id_price_list_id__draft__p_uq
  ON catalog.price_list_versions (tenant_id, price_list_id) WHERE status = 'draft';

CREATE TABLE catalog.price_list_items (
  id                    uuid        NOT NULL,
  tenant_id             uuid        NOT NULL,
  price_list_version_id uuid        NOT NULL,
  orderable_id          uuid        NOT NULL,
  unit_price_paisa      bigint      NOT NULL CONSTRAINT price_list_items__price__ck CHECK (unit_price_paisa BETWEEN 0 AND 999999999),
  version               integer     NOT NULL DEFAULT 1,
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by            uuid        NOT NULL,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  updated_by            uuid        NOT NULL,
  CONSTRAINT price_list_items__pk PRIMARY KEY (id),
  CONSTRAINT price_list_items__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT price_list_items__tenant_id_version_id_orderable_id__uq UNIQUE (tenant_id, price_list_version_id, orderable_id),
  CONSTRAINT price_list_items__version__fk FOREIGN KEY (tenant_id, price_list_version_id) REFERENCES catalog.price_list_versions (tenant_id, id),
  CONSTRAINT price_list_items__orderable__fk FOREIGN KEY (tenant_id, orderable_id) REFERENCES catalog.orderables (tenant_id, id)
);

-- ---------- Surcharge and tax ----------
CREATE TABLE catalog.surcharge_rules (
  id             uuid        NOT NULL,
  tenant_id      uuid        NOT NULL,
  scope          text        NOT NULL CONSTRAINT surcharge_rules__scope__ck CHECK (scope IN ('all','department','orderable')),
  department_id  uuid,
  orderable_id   uuid,
  price_list_id  uuid,
  amount_kind    text        NOT NULL CONSTRAINT surcharge_rules__kind__ck CHECK (amount_kind IN ('flat','percent')),
  amount_paisa   bigint      CONSTRAINT surcharge_rules__amount__ck CHECK (amount_paisa BETWEEN 1 AND 999999999),
  percent_bp     integer     CONSTRAINT surcharge_rules__bp__ck CHECK (percent_bp BETWEEN 1 AND 100000),
  effective_from timestamptz NOT NULL,
  effective_to   timestamptz,
  version        integer     NOT NULL DEFAULT 1,
  is_active      boolean     NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid        NOT NULL,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid        NOT NULL,
  CONSTRAINT surcharge_rules__pk PRIMARY KEY (id),
  CONSTRAINT surcharge_rules__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT surcharge_rules__department__fk FOREIGN KEY (tenant_id, department_id) REFERENCES catalog.departments (tenant_id, id),
  CONSTRAINT surcharge_rules__orderable__fk FOREIGN KEY (tenant_id, orderable_id) REFERENCES catalog.orderables (tenant_id, id),
  CONSTRAINT surcharge_rules__list__fk FOREIGN KEY (tenant_id, price_list_id) REFERENCES catalog.price_lists (tenant_id, id),
  CONSTRAINT surcharge_rules__scope_key__ck CHECK (
       (scope = 'all' AND department_id IS NULL AND orderable_id IS NULL)
    OR (scope = 'department' AND department_id IS NOT NULL AND orderable_id IS NULL)
    OR (scope = 'orderable' AND orderable_id IS NOT NULL AND department_id IS NULL)),
  CONSTRAINT surcharge_rules__amount_kind__ck CHECK (
       (amount_kind = 'flat' AND amount_paisa IS NOT NULL AND percent_bp IS NULL)
    OR (amount_kind = 'percent' AND percent_bp IS NOT NULL AND amount_paisa IS NULL)),
  CONSTRAINT surcharge_rules__window__ck CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
CREATE INDEX surcharge_rules__tenant_id_effective_from__idx ON catalog.surcharge_rules (tenant_id, effective_from);

CREATE TABLE catalog.cs_tax_types (
  id         uuid        NOT NULL,
  tenant_id  uuid        NOT NULL,
  code       text        NOT NULL CONSTRAINT cs_tax_types__code__ck CHECK (code ~ '^[A-Z0-9_]{1,16}$'),
  display    text        NOT NULL CONSTRAINT cs_tax_types__display__ck CHECK (length(display) BETWEEN 1 AND 60),
  rate_bp    integer     CONSTRAINT cs_tax_types__rate__ck CHECK (rate_bp BETWEEN 0 AND 10000),   -- NULL = not configured (B7)
  effective_from timestamptz NOT NULL,                       -- 08 R18: rates are effective-dated; a rate change = new row
  effective_to   timestamptz,
  sort_order integer     NOT NULL DEFAULT 100,
  version    integer     NOT NULL DEFAULT 1,
  is_active  boolean     NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid        NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid        NOT NULL,
  CONSTRAINT cs_tax_types__pk PRIMARY KEY (id),
  CONSTRAINT cs_tax_types__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT cs_tax_types__tenant_id_code_effective_from__uq UNIQUE (tenant_id, code, effective_from),
  CONSTRAINT cs_tax_types__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT cs_tax_types__not_vat__ck CHECK (code <> 'VAT'),
  CONSTRAINT cs_tax_types__window__ck CHECK (effective_to IS NULL OR effective_to > effective_from)
);
CREATE UNIQUE INDEX cs_tax_types__tenant_id_code__open__p_uq ON catalog.cs_tax_types (tenant_id, code) WHERE effective_to IS NULL;
-- A stored rate is never edited in place: only display, sort_order, is_active, effective_to and bookkeeping columns may change.
CREATE TRIGGER cs_tax_types__mutable_columns BEFORE UPDATE ON catalog.cs_tax_types
  FOR EACH ROW EXECUTE FUNCTION app.enforce_mutable_columns('display','sort_order','is_active','effective_to','updated_at','updated_by','version');

CREATE TABLE catalog.tax_rules (
  id             uuid        NOT NULL,
  tenant_id      uuid        NOT NULL,
  scope          text        NOT NULL CONSTRAINT tax_rules__scope__ck CHECK (scope IN ('tenant_default','department','orderable')),
  department_id  uuid,
  orderable_id   uuid,
  vat_treatment  text        NOT NULL CONSTRAINT tax_rules__vat__ck CHECK (vat_treatment IN ('exempt','taxable')),
  other_tax_code text        CONSTRAINT tax_rules__other__ck CHECK (other_tax_code ~ '^[A-Z0-9_]{1,16}$'),
  hs_code        text        CONSTRAINT tax_rules__hs__ck CHECK (hs_code ~ '^[0-9]{4,8}$'),
  effective_from timestamptz NOT NULL,
  effective_to   timestamptz,
  version        integer     NOT NULL DEFAULT 1,
  is_active      boolean     NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid        NOT NULL,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid        NOT NULL,
  CONSTRAINT tax_rules__pk PRIMARY KEY (id),
  CONSTRAINT tax_rules__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT tax_rules__department__fk FOREIGN KEY (tenant_id, department_id) REFERENCES catalog.departments (tenant_id, id),
  CONSTRAINT tax_rules__orderable__fk FOREIGN KEY (tenant_id, orderable_id) REFERENCES catalog.orderables (tenant_id, id),
  CONSTRAINT tax_rules__scope_key__ck CHECK (
       (scope = 'tenant_default' AND department_id IS NULL AND orderable_id IS NULL)
    OR (scope = 'department' AND department_id IS NOT NULL AND orderable_id IS NULL)
    OR (scope = 'orderable' AND orderable_id IS NOT NULL AND department_id IS NULL)),
  CONSTRAINT tax_rules__window__ck CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
CREATE INDEX tax_rules__tenant_id_scope__idx ON catalog.tax_rules (tenant_id, scope, effective_from);
-- One open rule per (scope, key) — backstop for the overlap rule in 02-TRD §7.6 (deterministic tax output).
CREATE UNIQUE INDEX tax_rules__tenant_id_scope_key__open__p_uq ON catalog.tax_rules
  (tenant_id, scope, coalesce(department_id, orderable_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE effective_to IS NULL;
-- other_tax_code references a tax-type *code* whose rows are effective-dated (no unique (tenant_id, code) to FK to):
-- existence is checked by trigger (SECURITY INVOKER, RLS-scoped lookup).
CREATE FUNCTION catalog.tg_tax_rule_other_type() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.other_tax_code IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM catalog.cs_tax_types t
       WHERE t.tenant_id = NEW.tenant_id AND t.code = NEW.other_tax_code AND t.is_active) THEN
    RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'tax_rules__other_type__fk', DETAIL = NEW.other_tax_code;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tax_rules__other_type BEFORE INSERT OR UPDATE OF other_tax_code ON catalog.tax_rules
  FOR EACH ROW EXECUTE FUNCTION catalog.tg_tax_rule_other_type();

-- ---------- Instrument code maps (X4) ----------
CREATE TABLE catalog.instrument_code_maps (
  id              uuid        NOT NULL,
  tenant_id       uuid        NOT NULL,
  instrument_id   uuid        NOT NULL,     -- C7 instruments.instruments id; NO FK (01-CM §5 R3)
  direction       text        NOT NULL CONSTRAINT icm__direction__ck CHECK (direction IN ('inbound','outbound','both')),
  instrument_code text        NOT NULL CONSTRAINT icm__code__ck CHECK (length(instrument_code) BETWEEN 1 AND 64),
  analyte_id      uuid        NOT NULL,
  test_id         uuid        NOT NULL,
  unit_from_raw   text        CONSTRAINT icm__unit_from__ck CHECK (length(unit_from_raw) <= 32),
  unit_to_code    text        CONSTRAINT icm__unit_to__ck CHECK (unit_to_code ~ '^[A-Za-z0-9_]{1,32}$'),
  unit_factor     numeric     CONSTRAINT icm__factor__ck CHECK (unit_factor > 0),
  flag_map        jsonb       CONSTRAINT icm__flag_map__ck CHECK (flag_map IS NULL OR jsonb_typeof(flag_map) = 'object'),
  version         integer     NOT NULL DEFAULT 1,
  is_active       boolean     NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid        NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid        NOT NULL,
  CONSTRAINT instrument_code_maps__pk PRIMARY KEY (id),
  CONSTRAINT instrument_code_maps__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT instrument_code_maps__analyte_test__fk FOREIGN KEY (tenant_id, analyte_id, test_id)
    REFERENCES catalog.analytes (tenant_id, id, test_id),
  CONSTRAINT instrument_code_maps__unit_triple__ck CHECK (
       (unit_from_raw IS NULL AND unit_to_code IS NULL AND unit_factor IS NULL)
    OR (unit_from_raw IS NOT NULL AND unit_to_code IS NOT NULL AND unit_factor IS NOT NULL))
);
CREATE UNIQUE INDEX instrument_code_maps__inbound__p_uq ON catalog.instrument_code_maps (tenant_id, instrument_id, instrument_code)
  WHERE is_active AND direction IN ('inbound','both');
CREATE UNIQUE INDEX instrument_code_maps__outbound__p_uq ON catalog.instrument_code_maps (tenant_id, instrument_id, analyte_id)
  WHERE is_active AND direction IN ('outbound','both');
CREATE INDEX instrument_code_maps__tenant_id_instrument_id__idx ON catalog.instrument_code_maps (tenant_id, instrument_id, is_active);

-- ---------- Files, imports, exports ----------
CREATE TABLE catalog.files (
  id           uuid        NOT NULL,
  tenant_id    uuid        NOT NULL,
  purpose      text        NOT NULL CONSTRAINT files__purpose__ck CHECK (purpose IN ('import_upload','import_report','export')),
  file_name    text        NOT NULL CONSTRAINT files__name__ck CHECK (length(file_name) BETWEEN 1 AND 200),  -- sanitised, metadata only
  content_type text        NOT NULL CONSTRAINT files__ct__ck CHECK (content_type = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
  byte_size    integer     NOT NULL CONSTRAINT files__size__ck CHECK (byte_size BETWEEN 1 AND 15728640),
  sha256       text        NOT NULL CONSTRAINT files__sha__ck CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  content      bytea       NOT NULL,
  expires_at   timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid        NOT NULL,
  CONSTRAINT files__pk PRIMARY KEY (id),
  CONSTRAINT files__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT files__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id)
);
CREATE INDEX files__tenant_id_expires_at__idx ON catalog.files (tenant_id, expires_at);

CREATE TABLE catalog.imports (
  id                           uuid        NOT NULL,
  tenant_id                    uuid        NOT NULL,
  kind                         text        NOT NULL CONSTRAINT imports__kind__ck CHECK (kind IN ('price_list','catalog_master','referrers','credit_parties')),
  target_price_list_id         uuid,
  base_version_no              integer,
  status                       text        NOT NULL DEFAULT 'uploaded' CONSTRAINT imports__status__ck CHECK (status IN
                                 ('uploaded','scanning','validating','validated','invalid','quarantined','committing',
                                  'committed','commit_failed','discarded','expired','failed')),
  upload_file_id               uuid,       -- plain uuid, no FK: files are purged, imports kept (§10.1)
  report_file_id               uuid,       -- plain uuid, no FK (§10.1)
  file_name                    text        NOT NULL CONSTRAINT imports__name__ck CHECK (length(file_name) BETWEEN 1 AND 200),
  file_sha256                  text        NOT NULL CONSTRAINT imports__sha__ck CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
  summary                      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  error_count                  integer     NOT NULL DEFAULT 0,
  warning_count                integer     NOT NULL DEFAULT 0,
  commit_effective_from        timestamptz,
  commit_change_reason         text        CONSTRAINT imports__reason__ck CHECK (length(commit_change_reason) <= 500),
  commit_publish               boolean,
  commit_accept_stale_base     boolean,
  result_price_list_version_id uuid,
  validated_at                 timestamptz,
  committed_at                 timestamptz,
  committed_by                 uuid,
  expires_at                   timestamptz,
  last_error_code              text,
  version                      integer     NOT NULL DEFAULT 1,
  is_active                    boolean     NOT NULL DEFAULT true,
  created_at                   timestamptz NOT NULL DEFAULT now(),
  created_by                   uuid        NOT NULL,
  updated_at                   timestamptz NOT NULL DEFAULT now(),
  updated_by                   uuid        NOT NULL,
  CONSTRAINT imports__pk PRIMARY KEY (id),
  CONSTRAINT imports__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT imports__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT imports__target__fk FOREIGN KEY (tenant_id, target_price_list_id) REFERENCES catalog.price_lists (tenant_id, id),
  CONSTRAINT imports__result__fk FOREIGN KEY (tenant_id, result_price_list_version_id) REFERENCES catalog.price_list_versions (tenant_id, id),
  CONSTRAINT imports__target_kind__ck CHECK ((kind = 'price_list') = (target_price_list_id IS NOT NULL))
);
CREATE INDEX imports__tenant_id_status_created_at__idx ON catalog.imports (tenant_id, status, created_at);
CREATE INDEX imports__dedupe__p_idx ON catalog.imports (tenant_id, kind, target_price_list_id, file_sha256)
  WHERE status NOT IN ('invalid','quarantined','commit_failed','discarded','expired','failed');

CREATE TABLE catalog.import_issues (
  tenant_id  uuid        NOT NULL,
  import_id  uuid        NOT NULL,
  seq        integer     NOT NULL,
  severity   text        NOT NULL CONSTRAINT import_issues__sev__ck CHECK (severity IN ('error','warning')),
  sheet      text        NOT NULL CONSTRAINT import_issues__sheet__ck CHECK (length(sheet) <= 31),
  row_no     integer,
  column_key text        CONSTRAINT import_issues__col__ck CHECK (length(column_key) <= 40),
  issue_code text        NOT NULL CONSTRAINT import_issues__code__ck CHECK (issue_code ~ '^[a-z_]+\.[a-z_]+$'),
  message    text        NOT NULL CONSTRAINT import_issues__msg__ck CHECK (length(message) <= 300),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid        NOT NULL,
  expires_at timestamptz NOT NULL,   -- = upload file expires_at (02-TRD §8.3 step 6)
  CONSTRAINT import_issues__pk PRIMARY KEY (tenant_id, import_id, seq),
  CONSTRAINT import_issues__import__fk FOREIGN KEY (tenant_id, import_id) REFERENCES catalog.imports (tenant_id, id)
);

CREATE TABLE catalog.exports (
  id         uuid        NOT NULL,
  tenant_id  uuid        NOT NULL,
  kind       text        NOT NULL CONSTRAINT exports__kind__ck CHECK (kind IN ('price_list','catalog_master','referrers')),
  params     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  status     text        NOT NULL DEFAULT 'queued' CONSTRAINT exports__status__ck CHECK (status IN ('queued','building','ready','failed','expired')),
  file_id    uuid,       -- plain uuid, no FK (§10.1)
  expires_at timestamptz,
  last_error_code text,
  version    integer     NOT NULL DEFAULT 1,
  is_active  boolean     NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid        NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid        NOT NULL,
  CONSTRAINT exports__pk PRIMARY KEY (id),
  CONSTRAINT exports__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT exports__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id)
);
CREATE INDEX exports__tenant_id_created_at__idx ON catalog.exports (tenant_id, created_at);
```

### 10.1 File references from `imports`/`exports`

Because `catalog.files` rows are purged after 30 days while `imports`/`exports` rows stay forever, `imports.upload_file_id`, `imports.report_file_id` and `exports.file_id` are nullable **plain uuid columns without FK** to `catalog.files`; the purge job sets them to NULL in the same transaction that deletes the file. Service invariant: `upload_file_id IS NOT NULL` while `status ∈ {uploaded, scanning, validating, validated, committing}`; after purge, downloads of a purged file return `404 common.not_found`.

### 10.2 Lifecycle triggers

```sql
-- Allowed status transitions on versioned tables (V1–V6 in 03-APP-FLOW §2.1)
CREATE FUNCTION catalog.tg_version_status() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF OLD.status = NEW.status AND OLD.status = 'draft' THEN RETURN NEW; END IF;
  IF (OLD.status = 'draft'     AND NEW.status IN ('published','discarded'))
  OR (OLD.status = 'published' AND NEW.status IN ('superseded','retired'))
  OR (OLD.status = NEW.status AND OLD.status = 'published') THEN      -- effective_to set on a scheduled/current version
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME;
END $$;

-- Children may change only while the parent is a draft
CREATE FUNCTION catalog.tg_parent_is_draft() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  parent_table text := TG_ARGV[0];          -- e.g. 'reference_range_sets'
  fk_column    text := TG_ARGV[1];          -- e.g. 'set_id'
  r            record;
  parent_id    uuid;
  parent_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN r := OLD; ELSE r := NEW; END IF;
  parent_id := (to_jsonb(r) ->> fk_column)::uuid;
  EXECUTE format('SELECT status FROM catalog.%I WHERE tenant_id = $1 AND id = $2', parent_table)
    INTO parent_status USING r.tenant_id, parent_id;
  IF parent_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'catalog.' || TG_TABLE_NAME;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

-- analyte_versions
CREATE TRIGGER analyte_versions__status BEFORE UPDATE ON catalog.analyte_versions
  FOR EACH ROW EXECUTE FUNCTION catalog.tg_version_status();
CREATE TRIGGER analyte_versions__mutable_columns BEFORE UPDATE ON catalog.analyte_versions
  FOR EACH ROW WHEN (OLD.status <> 'draft')
  EXECUTE FUNCTION app.enforce_mutable_columns('status','effective_to','updated_at','updated_by','version');
-- reference_range_sets, critical_limit_sets, price_list_versions: identical pair of triggers
CREATE TRIGGER reference_range_sets__status BEFORE UPDATE ON catalog.reference_range_sets
  FOR EACH ROW EXECUTE FUNCTION catalog.tg_version_status();
CREATE TRIGGER reference_range_sets__mutable_columns BEFORE UPDATE ON catalog.reference_range_sets
  FOR EACH ROW WHEN (OLD.status <> 'draft')
  EXECUTE FUNCTION app.enforce_mutable_columns('status','effective_to','updated_at','updated_by','version');
CREATE TRIGGER critical_limit_sets__status BEFORE UPDATE ON catalog.critical_limit_sets
  FOR EACH ROW EXECUTE FUNCTION catalog.tg_version_status();
CREATE TRIGGER critical_limit_sets__mutable_columns BEFORE UPDATE ON catalog.critical_limit_sets
  FOR EACH ROW WHEN (OLD.status <> 'draft')
  EXECUTE FUNCTION app.enforce_mutable_columns('status','effective_to','updated_at','updated_by','version');
CREATE TRIGGER price_list_versions__status BEFORE UPDATE ON catalog.price_list_versions
  FOR EACH ROW EXECUTE FUNCTION catalog.tg_version_status();
CREATE TRIGGER price_list_versions__mutable_columns BEFORE UPDATE ON catalog.price_list_versions
  FOR EACH ROW WHEN (OLD.status <> 'draft')
  EXECUTE FUNCTION app.enforce_mutable_columns('status','effective_to','updated_at','updated_by','version');
-- CHECK on analyte_versions/price_list_versions already forbids 'retired' (status CHECK lists no 'retired').

-- Effective-dated money rules: never edited after creation except ending/deactivation (07-SECURITY §3 A2; review C3 #47)
CREATE TRIGGER surcharge_rules__mutable_columns BEFORE UPDATE ON catalog.surcharge_rules
  FOR EACH ROW EXECUTE FUNCTION app.enforce_mutable_columns('effective_to','is_active','updated_at','updated_by','version');
CREATE TRIGGER tax_rules__mutable_columns BEFORE UPDATE ON catalog.tax_rules
  FOR EACH ROW EXECUTE FUNCTION app.enforce_mutable_columns('effective_to','is_active','updated_at','updated_by','version');

-- children
CREATE TRIGGER reference_ranges__parent_draft BEFORE INSERT OR UPDATE OR DELETE ON catalog.reference_ranges
  FOR EACH ROW EXECUTE FUNCTION catalog.tg_parent_is_draft('reference_range_sets','set_id');
CREATE TRIGGER critical_limits__parent_draft BEFORE INSERT OR UPDATE OR DELETE ON catalog.critical_limits
  FOR EACH ROW EXECUTE FUNCTION catalog.tg_parent_is_draft('critical_limit_sets','set_id');
CREATE TRIGGER price_list_items__parent_draft BEFORE INSERT OR UPDATE OR DELETE ON catalog.price_list_items
  FOR EACH ROW EXECUTE FUNCTION catalog.tg_parent_is_draft('price_list_versions','price_list_version_id');
CREATE TRIGGER formula_dependencies__parent_draft BEFORE INSERT OR UPDATE OR DELETE ON catalog.formula_dependencies
  FOR EACH ROW EXECUTE FUNCTION catalog.tg_parent_is_draft('analyte_versions','analyte_version_id');
```

`catalog.tg_parent_is_draft` is **SECURITY INVOKER** (default): it runs as `lims_app` and its lookup is subject to RLS (same tenant), so it needs no DEFINER inventory entry (04 D7). The parent lookup is by primary key. `format('%I')` is used for the identifier (REQ-SEC-082).

### 10.3 RLS policies and grants

```sql
DO $$
DECLARE
  t text;
  rw_tables text[] := ARRAY[   -- SELECT / INSERT / UPDATE, no DELETE
    'catalog_state','code_counters','departments','specimen_types','containers','methods',
    'cs_units','cs_value_sets','cs_value_set_values','orderables','tests','panels',
    'analytes','analyte_versions','reference_range_sets','critical_limit_sets','tat_targets','comment_codes','comment_code_texts',
    'doctors','credit_parties','price_lists','price_list_versions','surcharge_rules','cs_tax_types','tax_rules',
    'instrument_code_maps','imports','exports'];
  rwd_tables text[] := ARRAY[  -- plus DELETE (associations, draft children, E class)
    'panel_members','test_specimen_types','price_list_assignments',
    'reference_ranges','critical_limits','price_list_items','formula_dependencies',
    'files','import_issues'];
BEGIN
  FOREACH t IN ARRAY rw_tables || rwd_tables LOOP
    EXECUTE format('ALTER TABLE catalog.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE catalog.%I FORCE ROW LEVEL SECURITY', t);
    -- every __tenant policy also requires app.is_staff_or_system(): catalog tables are not shared with
    -- partner/portal/patient actors (CR-C13-011; 08 R10 item 5) — their reads run as system actors (08 R8).
    EXECUTE format('CREATE POLICY %I ON catalog.%I FOR SELECT TO lims_app USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))',
                   t || '__select__tenant', t);
    EXECUTE format('CREATE POLICY %I ON catalog.%I FOR INSERT TO lims_app WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))',
                   t || '__insert__tenant', t);
    EXECUTE format('CREATE POLICY %I ON catalog.%I FOR UPDATE TO lims_app USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())) '
                   'WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))', t || '__update__tenant', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON catalog.%I TO lims_app', t);
  END LOOP;
  FOREACH t IN ARRAY rwd_tables LOOP
    EXECUTE format('CREATE POLICY %I ON catalog.%I FOR DELETE TO lims_app USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))',
                   t || '__delete__tenant', t);
    EXECUTE format('GRANT DELETE ON catalog.%I TO lims_app', t);
  END LOOP;
END $$;
-- C0 expands this loop into explicit statements in db/policies/catalog.sql for review/diff (02-CV §5.12).
```

Notes:
- Exemptions from the 02-CV §5.2 mandatory column template (C0 lists each in `db/meta/tables.yaml` exemptions with the reason given here):

| Table | Missing template columns | Reason |
|---|---|---|
| `catalog_state` | `id`, `updated_by`, `version`, `is_active` | per-tenant counter row (PK `tenant_id`), UPDATE by `bumpRevision` only |
| `code_counters` | `id`, `updated_by`, `version`, `is_active` | per-tenant counter (PK `tenant_id, counter_key`) |
| `panel_members`, `test_specimen_types` | `id`, `updated_at`, `updated_by`, `version`, `is_active` | association rows, replaced as a set (DELETE allowed) |
| `price_list_assignments` | `updated_at`, `updated_by`, `version`, `is_active` | association rows, replaced as a set (DELETE allowed) |
| `formula_dependencies` | `id`, `updated_at`, `updated_by`, `version`, `is_active` | draft child / graph edge, written only while the parent version is draft |
| `reference_ranges`, `critical_limits` | `updated_at`, `updated_by`, `version`, `is_active` | draft children; immutable once the parent set is published (§10.2) |
| `price_list_items` | `is_active` | draft child; removal = DELETE while draft |
| `comment_code_texts` | `is_active` | effective-dated history row (INSERT + close `effective_to`) |
| `files` | — (E class: `id`, `tenant_id`, `created_at`, `expires_at` present) | E class |
| `import_issues` | `id` | E class; natural PK `(tenant_id, import_id, seq)` |

- `files` and `import_issues` DELETE is used only by `catalog.purge_files` and by the validate task (rewrite of issues for a re-run).
- `catalog.purge_files`, `catalog.expire_imports` and `catalog.global_release_fanout` are `tenantScope: 'per_tenant'` cron tasks (08 A13 P-6): the worker core enqueues one job per tenant and runs it under that tenant's claims, so the tenant policies above suffice. C3 has **no** SECURITY DEFINER function and therefore no `__<cmd>__owner_only` policy (08 A10.5 / A12.2 do not apply).

### 10.4 Published views

```sql
CREATE VIEW catalog.v_pub_department WITH (security_invoker = true) AS
SELECT d.tenant_id, d.id AS department_id, d.code, d.name, d.is_active
FROM catalog.departments d;

CREATE VIEW catalog.v_pub_test_directory WITH (security_invoker = true) AS
SELECT o.tenant_id, o.id AS test_id, o.code, o.name, o.department_id, t.workflow_type, o.is_active
FROM catalog.orderables o
JOIN catalog.tests t ON t.tenant_id = o.tenant_id AND t.id = o.id;

CREATE VIEW catalog.v_pub_price_list_items WITH (security_invoker = true) AS
SELECT i.tenant_id, l.id AS price_list_id, v.version_no AS price_list_version, l.owner_kind,
       coalesce(a.credit_party_id, a.doctor_id, a.centre_id) AS owner_id,
       i.orderable_id, i.unit_price_paisa, v.effective_from, v.effective_to,
       l.falls_through                                                   -- 08 A13 D-19 (additive column)
FROM catalog.price_list_items i
JOIN catalog.price_list_versions v ON v.tenant_id = i.tenant_id AND v.id = i.price_list_version_id
JOIN catalog.price_lists l        ON l.tenant_id = v.tenant_id AND l.id = v.price_list_id
LEFT JOIN catalog.price_list_assignments a ON a.tenant_id = l.tenant_id AND a.price_list_id = l.id
WHERE v.status IN ('published','superseded') AND l.is_active;      -- 08 A13 D-19: inactive lists excluded

CREATE VIEW catalog.v_pub_referrer_directory WITH (security_invoker = true) AS
SELECT d.tenant_id, d.id AS referrer_id, d.display_name, d.is_active,
       coalesce(d.merged_into_id, d.id) AS canonical_referrer_id          -- CR-C3-004 (additive)
FROM catalog.doctors d;

GRANT SELECT ON catalog.v_pub_department, catalog.v_pub_test_directory,
                catalog.v_pub_price_list_items, catalog.v_pub_referrer_directory TO lims_app;
```

`v_pub_referrer_directory.display_name` exposes doctor names (P2-personal) to C8 for MIS labels, as 03-IC §6.6 defines; no contacts are exposed in any view.

## 11. DB tests C0 adds (`db/tests`, REQ-SEC-042)

1. For every tenant table above: tenant-A claims see 0 tenant-B rows; INSERT with tenant B id fails; UPDATE/DELETE of B rows affect 0 rows.
2. `has_table_privilege('lims_app', t, 'DELETE') = false` for every table in `rw_tables`.
3. UPDATE of a clinical column on a published `analyte_versions` row → SQLSTATE P0001 `immutable_row`; status `superseded → published` → P0001; INSERT into `reference_ranges` of a published set → P0001; DELETE of an item of a published price version → P0001.
4. Composite FK probe: `price_list_items` row in tenant A referencing tenant B orderable id → FK violation; `price_list_assignments` with tenant-B centre id → FK violation; `instrument_code_maps` with analyte of a different test → FK violation.
5. `catalog_state.catalog_revision` decrease → P0001.
6. Partial unique: second draft per analyte → unique violation; second default price list → unique violation; second active inbound map for same (instrument, code) → unique violation.
7. Views: `security_invoker` set; tenant-A reader sees only A rows.
8. `cs_tax_types`: second open version of one code → unique violation; UPDATE of `rate_bp` or `effective_from` → P0001; `tax_rules` with an unknown `other_tax_code` → SQLSTATE 23503 (08 R18).
9. Claims with `actor_type` `partner`/`patient`/`portal` and the tenant id see 0 rows of every catalog table (`app.is_staff_or_system()`).
10. `comment_code_texts`: UPDATE of `text`/`effective_from` → P0001; second row with the same `(comment_code_id, effective_from)` → unique violation.
11. `tax_rules`: a second open (`effective_to IS NULL`) rule with the same `(scope, department_id/orderable_id)` → unique violation; UPDATE of `vat_treatment`, `other_tax_code`, `hs_code` or `effective_from` → P0001; `surcharge_rules`: UPDATE of `amount_paisa`, `percent_bp`, `scope` or `effective_from` → P0001; UPDATE of `effective_to` succeeds on both (review C3 #5, #47).
12. `import_issues` INSERT without `expires_at` → NOT NULL violation; `analyte_versions` / `reference_range_sets` / `critical_limit_sets` accept `source_import_id` on INSERT and reject a change of it after publish → P0001.
13. Every table in the §10.3 arrays has `relrowsecurity` and `relforcerowsecurity` true and its `__select__tenant` / `__insert__tenant` / `__update__tenant` policies (plus `__delete__tenant` for `rwd_tables`).

Final sweep 2026-11-06 — second touch applied (§4 index row for `getPriceListStatus`; no DDL change).
