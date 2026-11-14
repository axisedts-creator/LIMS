-- T0B-10.C3: catalog schema (C3 05-SCHEMA §10, §10.2, §10.4 verbatim; the §10.3 DO loop written out as literal statements [CONV],
-- as T0B-10.C2 did, so check-migrations sees ENABLE+FORCE and policies are 1:1 with db/policies/catalog.sql; row-audit triggers per §5 rule 6).
-- g_* seed rows (§8) belong to db/seeds, not here. C3 has no SECURITY DEFINER function (§10.3 notes).
SET LOCAL ROLE lims_owner;

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

-- ---------- §10.2 lifecycle triggers ----------
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

-- ---------- §10.3 RLS (literal expansion of the spec DO loop) ----------
ALTER TABLE catalog.catalog_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog.catalog_state FORCE ROW LEVEL SECURITY;
ALTER TABLE catalog.code_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog.code_counters FORCE ROW LEVEL SECURITY;
ALTER TABLE catalog.departments ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog.departments FORCE ROW LEVEL SECURITY;
ALTER TABLE catalog.specimen_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog.specimen_types FORCE ROW LEVEL SECURITY;
ALTER TABLE catalog.containers ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog.containers FORCE ROW LEVEL SECURITY;
ALTER TABLE catalog.methods ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog.methods FORCE ROW LEVEL SECURITY;
ALTER TABLE catalog.cs_units ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog.cs_units FORCE ROW LEVEL SECURITY;
ALTER TABLE catalog.cs_value_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog.cs_value_sets FORCE ROW LEVEL SECURITY;
ALTER TABLE catalog.cs_value_set_values ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog.cs_value_set_values FORCE ROW LEVEL SECURITY;
ALTER TABLE catalog.orderables ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog.orderables FORCE ROW LEVEL SECURITY;
ALTER TABLE catalog.tests ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog.tests FORCE ROW LEVEL SECURITY;
ALTER TABLE catalog.panels ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog.panels FORCE ROW LEVEL SECURITY;
ALTER TABLE catalog.analytes ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog.analytes FORCE ROW LEVEL SECURITY;
ALTER TABLE catalog.analyte_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog.analyte_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE catalog.reference_range_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog.reference_range_sets FORCE ROW LEVEL SECURITY;
ALTER TABLE catalog.critical_limit_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog.critical_limit_sets FORCE ROW LEVEL SECURITY;
ALTER TABLE catalog.tat_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog.tat_targets FORCE ROW LEVEL SECURITY;
ALTER TABLE catalog.comment_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog.comment_codes FORCE ROW LEVEL SECURITY;
ALTER TABLE catalog.comment_code_texts ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog.comment_code_texts FORCE ROW LEVEL SECURITY;
ALTER TABLE catalog.doctors ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog.doctors FORCE ROW LEVEL SECURITY;
ALTER TABLE catalog.credit_parties ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog.credit_parties FORCE ROW LEVEL SECURITY;
ALTER TABLE catalog.price_lists ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog.price_lists FORCE ROW LEVEL SECURITY;
ALTER TABLE catalog.price_list_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog.price_list_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE catalog.surcharge_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog.surcharge_rules FORCE ROW LEVEL SECURITY;
ALTER TABLE catalog.cs_tax_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog.cs_tax_types FORCE ROW LEVEL SECURITY;
ALTER TABLE catalog.tax_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog.tax_rules FORCE ROW LEVEL SECURITY;
ALTER TABLE catalog.instrument_code_maps ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog.instrument_code_maps FORCE ROW LEVEL SECURITY;
ALTER TABLE catalog.imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog.imports FORCE ROW LEVEL SECURITY;
ALTER TABLE catalog.exports ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog.exports FORCE ROW LEVEL SECURITY;
ALTER TABLE catalog.panel_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog.panel_members FORCE ROW LEVEL SECURITY;
ALTER TABLE catalog.test_specimen_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog.test_specimen_types FORCE ROW LEVEL SECURITY;
ALTER TABLE catalog.price_list_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog.price_list_assignments FORCE ROW LEVEL SECURITY;
ALTER TABLE catalog.reference_ranges ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog.reference_ranges FORCE ROW LEVEL SECURITY;
ALTER TABLE catalog.critical_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog.critical_limits FORCE ROW LEVEL SECURITY;
ALTER TABLE catalog.price_list_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog.price_list_items FORCE ROW LEVEL SECURITY;
ALTER TABLE catalog.formula_dependencies ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog.formula_dependencies FORCE ROW LEVEL SECURITY;
ALTER TABLE catalog.files ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog.files FORCE ROW LEVEL SECURITY;
ALTER TABLE catalog.import_issues ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog.import_issues FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE ON catalog.catalog_state TO lims_app;
GRANT SELECT, INSERT, UPDATE ON catalog.code_counters TO lims_app;
GRANT SELECT, INSERT, UPDATE ON catalog.departments TO lims_app;
GRANT SELECT, INSERT, UPDATE ON catalog.specimen_types TO lims_app;
GRANT SELECT, INSERT, UPDATE ON catalog.containers TO lims_app;
GRANT SELECT, INSERT, UPDATE ON catalog.methods TO lims_app;
GRANT SELECT, INSERT, UPDATE ON catalog.cs_units TO lims_app;
GRANT SELECT, INSERT, UPDATE ON catalog.cs_value_sets TO lims_app;
GRANT SELECT, INSERT, UPDATE ON catalog.cs_value_set_values TO lims_app;
GRANT SELECT, INSERT, UPDATE ON catalog.orderables TO lims_app;
GRANT SELECT, INSERT, UPDATE ON catalog.tests TO lims_app;
GRANT SELECT, INSERT, UPDATE ON catalog.panels TO lims_app;
GRANT SELECT, INSERT, UPDATE ON catalog.analytes TO lims_app;
GRANT SELECT, INSERT, UPDATE ON catalog.analyte_versions TO lims_app;
GRANT SELECT, INSERT, UPDATE ON catalog.reference_range_sets TO lims_app;
GRANT SELECT, INSERT, UPDATE ON catalog.critical_limit_sets TO lims_app;
GRANT SELECT, INSERT, UPDATE ON catalog.tat_targets TO lims_app;
GRANT SELECT, INSERT, UPDATE ON catalog.comment_codes TO lims_app;
GRANT SELECT, INSERT, UPDATE ON catalog.comment_code_texts TO lims_app;
GRANT SELECT, INSERT, UPDATE ON catalog.doctors TO lims_app;
GRANT SELECT, INSERT, UPDATE ON catalog.credit_parties TO lims_app;
GRANT SELECT, INSERT, UPDATE ON catalog.price_lists TO lims_app;
GRANT SELECT, INSERT, UPDATE ON catalog.price_list_versions TO lims_app;
GRANT SELECT, INSERT, UPDATE ON catalog.surcharge_rules TO lims_app;
GRANT SELECT, INSERT, UPDATE ON catalog.cs_tax_types TO lims_app;
GRANT SELECT, INSERT, UPDATE ON catalog.tax_rules TO lims_app;
GRANT SELECT, INSERT, UPDATE ON catalog.instrument_code_maps TO lims_app;
GRANT SELECT, INSERT, UPDATE ON catalog.imports TO lims_app;
GRANT SELECT, INSERT, UPDATE ON catalog.exports TO lims_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON catalog.panel_members TO lims_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON catalog.test_specimen_types TO lims_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON catalog.price_list_assignments TO lims_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON catalog.reference_ranges TO lims_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON catalog.critical_limits TO lims_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON catalog.price_list_items TO lims_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON catalog.formula_dependencies TO lims_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON catalog.files TO lims_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON catalog.import_issues TO lims_app;

CREATE POLICY catalog_state__select__tenant ON catalog.catalog_state FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY catalog_state__insert__tenant ON catalog.catalog_state FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY catalog_state__update__tenant ON catalog.catalog_state FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY code_counters__select__tenant ON catalog.code_counters FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY code_counters__insert__tenant ON catalog.code_counters FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY code_counters__update__tenant ON catalog.code_counters FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY departments__select__tenant ON catalog.departments FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY departments__insert__tenant ON catalog.departments FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY departments__update__tenant ON catalog.departments FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY specimen_types__select__tenant ON catalog.specimen_types FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY specimen_types__insert__tenant ON catalog.specimen_types FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY specimen_types__update__tenant ON catalog.specimen_types FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY containers__select__tenant ON catalog.containers FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY containers__insert__tenant ON catalog.containers FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY containers__update__tenant ON catalog.containers FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY methods__select__tenant ON catalog.methods FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY methods__insert__tenant ON catalog.methods FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY methods__update__tenant ON catalog.methods FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY cs_units__select__tenant ON catalog.cs_units FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY cs_units__insert__tenant ON catalog.cs_units FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY cs_units__update__tenant ON catalog.cs_units FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY cs_value_sets__select__tenant ON catalog.cs_value_sets FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY cs_value_sets__insert__tenant ON catalog.cs_value_sets FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY cs_value_sets__update__tenant ON catalog.cs_value_sets FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY cs_value_set_values__select__tenant ON catalog.cs_value_set_values FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY cs_value_set_values__insert__tenant ON catalog.cs_value_set_values FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY cs_value_set_values__update__tenant ON catalog.cs_value_set_values FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY orderables__select__tenant ON catalog.orderables FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY orderables__insert__tenant ON catalog.orderables FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY orderables__update__tenant ON catalog.orderables FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY tests__select__tenant ON catalog.tests FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY tests__insert__tenant ON catalog.tests FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY tests__update__tenant ON catalog.tests FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY panels__select__tenant ON catalog.panels FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY panels__insert__tenant ON catalog.panels FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY panels__update__tenant ON catalog.panels FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY analytes__select__tenant ON catalog.analytes FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY analytes__insert__tenant ON catalog.analytes FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY analytes__update__tenant ON catalog.analytes FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY analyte_versions__select__tenant ON catalog.analyte_versions FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY analyte_versions__insert__tenant ON catalog.analyte_versions FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY analyte_versions__update__tenant ON catalog.analyte_versions FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY reference_range_sets__select__tenant ON catalog.reference_range_sets FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY reference_range_sets__insert__tenant ON catalog.reference_range_sets FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY reference_range_sets__update__tenant ON catalog.reference_range_sets FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY critical_limit_sets__select__tenant ON catalog.critical_limit_sets FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY critical_limit_sets__insert__tenant ON catalog.critical_limit_sets FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY critical_limit_sets__update__tenant ON catalog.critical_limit_sets FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY tat_targets__select__tenant ON catalog.tat_targets FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY tat_targets__insert__tenant ON catalog.tat_targets FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY tat_targets__update__tenant ON catalog.tat_targets FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY comment_codes__select__tenant ON catalog.comment_codes FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY comment_codes__insert__tenant ON catalog.comment_codes FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY comment_codes__update__tenant ON catalog.comment_codes FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY comment_code_texts__select__tenant ON catalog.comment_code_texts FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY comment_code_texts__insert__tenant ON catalog.comment_code_texts FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY comment_code_texts__update__tenant ON catalog.comment_code_texts FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY doctors__select__tenant ON catalog.doctors FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY doctors__insert__tenant ON catalog.doctors FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY doctors__update__tenant ON catalog.doctors FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY credit_parties__select__tenant ON catalog.credit_parties FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY credit_parties__insert__tenant ON catalog.credit_parties FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY credit_parties__update__tenant ON catalog.credit_parties FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY price_lists__select__tenant ON catalog.price_lists FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY price_lists__insert__tenant ON catalog.price_lists FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY price_lists__update__tenant ON catalog.price_lists FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY price_list_versions__select__tenant ON catalog.price_list_versions FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY price_list_versions__insert__tenant ON catalog.price_list_versions FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY price_list_versions__update__tenant ON catalog.price_list_versions FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY surcharge_rules__select__tenant ON catalog.surcharge_rules FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY surcharge_rules__insert__tenant ON catalog.surcharge_rules FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY surcharge_rules__update__tenant ON catalog.surcharge_rules FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY cs_tax_types__select__tenant ON catalog.cs_tax_types FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY cs_tax_types__insert__tenant ON catalog.cs_tax_types FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY cs_tax_types__update__tenant ON catalog.cs_tax_types FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY tax_rules__select__tenant ON catalog.tax_rules FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY tax_rules__insert__tenant ON catalog.tax_rules FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY tax_rules__update__tenant ON catalog.tax_rules FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY instrument_code_maps__select__tenant ON catalog.instrument_code_maps FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY instrument_code_maps__insert__tenant ON catalog.instrument_code_maps FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY instrument_code_maps__update__tenant ON catalog.instrument_code_maps FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY imports__select__tenant ON catalog.imports FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY imports__insert__tenant ON catalog.imports FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY imports__update__tenant ON catalog.imports FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY exports__select__tenant ON catalog.exports FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY exports__insert__tenant ON catalog.exports FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY exports__update__tenant ON catalog.exports FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY panel_members__select__tenant ON catalog.panel_members FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY panel_members__insert__tenant ON catalog.panel_members FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY panel_members__update__tenant ON catalog.panel_members FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY test_specimen_types__select__tenant ON catalog.test_specimen_types FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY test_specimen_types__insert__tenant ON catalog.test_specimen_types FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY test_specimen_types__update__tenant ON catalog.test_specimen_types FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY price_list_assignments__select__tenant ON catalog.price_list_assignments FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY price_list_assignments__insert__tenant ON catalog.price_list_assignments FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY price_list_assignments__update__tenant ON catalog.price_list_assignments FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY reference_ranges__select__tenant ON catalog.reference_ranges FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY reference_ranges__insert__tenant ON catalog.reference_ranges FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY reference_ranges__update__tenant ON catalog.reference_ranges FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY critical_limits__select__tenant ON catalog.critical_limits FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY critical_limits__insert__tenant ON catalog.critical_limits FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY critical_limits__update__tenant ON catalog.critical_limits FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY price_list_items__select__tenant ON catalog.price_list_items FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY price_list_items__insert__tenant ON catalog.price_list_items FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY price_list_items__update__tenant ON catalog.price_list_items FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY formula_dependencies__select__tenant ON catalog.formula_dependencies FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY formula_dependencies__insert__tenant ON catalog.formula_dependencies FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY formula_dependencies__update__tenant ON catalog.formula_dependencies FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY files__select__tenant ON catalog.files FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY files__insert__tenant ON catalog.files FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY files__update__tenant ON catalog.files FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY import_issues__select__tenant ON catalog.import_issues FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY import_issues__insert__tenant ON catalog.import_issues FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY import_issues__update__tenant ON catalog.import_issues FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY panel_members__delete__tenant ON catalog.panel_members FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY test_specimen_types__delete__tenant ON catalog.test_specimen_types FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY price_list_assignments__delete__tenant ON catalog.price_list_assignments FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY reference_ranges__delete__tenant ON catalog.reference_ranges FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY critical_limits__delete__tenant ON catalog.critical_limits FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY price_list_items__delete__tenant ON catalog.price_list_items FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY formula_dependencies__delete__tenant ON catalog.formula_dependencies FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY files__delete__tenant ON catalog.files FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY import_issues__delete__tenant ON catalog.import_issues FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));

-- ---------- §5 rule 6: row-audit triggers (not on files, import_issues, catalog_state, code_counters, g_*) ----------
CREATE TRIGGER departments__audit AFTER INSERT OR UPDATE OR DELETE ON catalog.departments FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER specimen_types__audit AFTER INSERT OR UPDATE OR DELETE ON catalog.specimen_types FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER containers__audit AFTER INSERT OR UPDATE OR DELETE ON catalog.containers FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER methods__audit AFTER INSERT OR UPDATE OR DELETE ON catalog.methods FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER cs_units__audit AFTER INSERT OR UPDATE OR DELETE ON catalog.cs_units FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER cs_value_sets__audit AFTER INSERT OR UPDATE OR DELETE ON catalog.cs_value_sets FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER cs_value_set_values__audit AFTER INSERT OR UPDATE OR DELETE ON catalog.cs_value_set_values FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER orderables__audit AFTER INSERT OR UPDATE OR DELETE ON catalog.orderables FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER tests__audit AFTER INSERT OR UPDATE OR DELETE ON catalog.tests FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER panels__audit AFTER INSERT OR UPDATE OR DELETE ON catalog.panels FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER analytes__audit AFTER INSERT OR UPDATE OR DELETE ON catalog.analytes FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER analyte_versions__audit AFTER INSERT OR UPDATE OR DELETE ON catalog.analyte_versions FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER reference_range_sets__audit AFTER INSERT OR UPDATE OR DELETE ON catalog.reference_range_sets FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER critical_limit_sets__audit AFTER INSERT OR UPDATE OR DELETE ON catalog.critical_limit_sets FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER tat_targets__audit AFTER INSERT OR UPDATE OR DELETE ON catalog.tat_targets FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER comment_codes__audit AFTER INSERT OR UPDATE OR DELETE ON catalog.comment_codes FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER comment_code_texts__audit AFTER INSERT OR UPDATE OR DELETE ON catalog.comment_code_texts FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER doctors__audit AFTER INSERT OR UPDATE OR DELETE ON catalog.doctors FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER credit_parties__audit AFTER INSERT OR UPDATE OR DELETE ON catalog.credit_parties FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER price_lists__audit AFTER INSERT OR UPDATE OR DELETE ON catalog.price_lists FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER price_list_versions__audit AFTER INSERT OR UPDATE OR DELETE ON catalog.price_list_versions FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER surcharge_rules__audit AFTER INSERT OR UPDATE OR DELETE ON catalog.surcharge_rules FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER cs_tax_types__audit AFTER INSERT OR UPDATE OR DELETE ON catalog.cs_tax_types FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER tax_rules__audit AFTER INSERT OR UPDATE OR DELETE ON catalog.tax_rules FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER instrument_code_maps__audit AFTER INSERT OR UPDATE OR DELETE ON catalog.instrument_code_maps FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER imports__audit AFTER INSERT OR UPDATE OR DELETE ON catalog.imports FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER exports__audit AFTER INSERT OR UPDATE OR DELETE ON catalog.exports FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER panel_members__audit AFTER INSERT OR UPDATE OR DELETE ON catalog.panel_members FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER test_specimen_types__audit AFTER INSERT OR UPDATE OR DELETE ON catalog.test_specimen_types FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER price_list_assignments__audit AFTER INSERT OR UPDATE OR DELETE ON catalog.price_list_assignments FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER reference_ranges__audit AFTER INSERT OR UPDATE OR DELETE ON catalog.reference_ranges FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER critical_limits__audit AFTER INSERT OR UPDATE OR DELETE ON catalog.critical_limits FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER price_list_items__audit AFTER INSERT OR UPDATE OR DELETE ON catalog.price_list_items FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER formula_dependencies__audit AFTER INSERT OR UPDATE OR DELETE ON catalog.formula_dependencies FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();

-- ---------- §10.4 published views (IC §6.6) ----------
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
