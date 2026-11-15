-- T0B-13.C11 (LD-202): anatomic schema — C11 05-SCHEMA §6 DDL verbatim (31 tables, 35 indexes, 4 guard functions, 7 triggers),
-- §8 view v_pub_report_content + its GRANT, the §7 RLS (cases example + DO block expanded into literal statements: ENABLE + FORCE
-- on the 30 tenant tables, 86 policies, grants), row-audit triggers on the 25 M + C tables (§3) and the §2.2 global seed.
-- Policies are copied 1:1 to db/policies/anatomic.sql (AC-0B-2.3). anatomic.event_inbox belongs to T0B-05. Schema anatomic exists
-- since T0B-01. No SECURITY DEFINER. No Storage SQL (LD-54). Single role switch: lims_owner.
SET LOCAL ROLE lims_owner;

-- ===================== §6 DDL (verbatim) =====================
-- ============================================================================
-- anatomic schema (C0 creates the schema itself — C0 05-SCHEMA §1). Owner lims_owner.
-- Every M/C table gets C0's tg_row_audit trigger (04 D11). All ids are app-generated UUIDv7 (04 D9).
-- ============================================================================

-- ---------- settings (M) ----------
CREATE TABLE anatomic.settings (
  id uuid NOT NULL, tenant_id uuid NOT NULL,
  auto_accession_on_receipt boolean NOT NULL DEFAULT false,
  require_gross_complete_for_processing boolean NOT NULL DEFAULT true,
  default_routine_stain_code text NOT NULL DEFAULT 'HE',
  max_images_per_case integer NOT NULL DEFAULT 50,
  max_report_images integer NOT NULL DEFAULT 12,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT settings__pk PRIMARY KEY (id),
  CONSTRAINT settings__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT settings__tenant_id__uq UNIQUE (tenant_id),
  CONSTRAINT settings__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT settings__max_images__ck CHECK (max_images_per_case BETWEEN 1 AND 200),
  CONSTRAINT settings__max_report_images__ck CHECK (max_report_images BETWEEN 0 AND 24),
  CONSTRAINT settings__stain_code__ck CHECK (default_routine_stain_code ~ '^[A-Z0-9_]{1,32}$')
);

-- ---------- accession / batch counters ----------
CREATE TABLE anatomic.accession_counters (
  tenant_id uuid NOT NULL,
  series_key text NOT NULL,                 -- histology | cytology | ihc | molecular | batch
  year_ad integer NOT NULL,                 -- A.D. year in tenant tz; 0 when the pattern has no {yy}
  last_value bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  -- class E counter; P-18(b) exception: no id/version/is_active/expires_at (§1 "Mandatory-column exceptions")
  CONSTRAINT accession_counters__pk PRIMARY KEY (tenant_id, series_key, year_ad),
  CONSTRAINT accession_counters__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT accession_counters__series__ck CHECK (series_key IN ('histology','cytology','ihc','molecular','batch')),
  CONSTRAINT accession_counters__year__ck CHECK (year_ad = 0 OR year_ad BETWEEN 2000 AND 2199),
  CONSTRAINT accession_counters__value__ck CHECK (last_value >= 0)
);

-- ---------- test profiles (M) ----------
CREATE TABLE anatomic.test_profiles (
  id uuid NOT NULL, tenant_id uuid NOT NULL,
  test_id uuid NOT NULL,                    -- catalog test id; validated via CatalogPort (no cross-schema FK, §1)
  case_kind text NOT NULL,
  is_addon boolean NOT NULL DEFAULT false,
  requires_gross boolean NOT NULL DEFAULT true,
  default_stain_code text,
  default_synoptic_template_keys text[] NOT NULL DEFAULT '{}',
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT test_profiles__pk PRIMARY KEY (id),
  CONSTRAINT test_profiles__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT test_profiles__tenant_id_test_id__uq UNIQUE (tenant_id, test_id),
  CONSTRAINT test_profiles__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT test_profiles__case_kind__ck CHECK (case_kind IN ('histology','cytology','ihc','molecular')),
  CONSTRAINT test_profiles__stain__ck CHECK (default_stain_code IS NULL OR default_stain_code ~ '^[A-Z0-9_]{1,32}$'),
  CONSTRAINT test_profiles__templates__ck CHECK (cardinality(default_synoptic_template_keys) <= 5)
);

-- ---------- stains (M) ----------
CREATE TABLE anatomic.stains (
  id uuid NOT NULL, tenant_id uuid NOT NULL,
  code text NOT NULL, display text NOT NULL, kind text NOT NULL,
  addon_test_id uuid,                       -- optional billable add-on test (catalog id, validated via CatalogPort)
  sort_order integer NOT NULL DEFAULT 0,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT stains__pk PRIMARY KEY (id),
  CONSTRAINT stains__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT stains__tenant_id_code__uq UNIQUE (tenant_id, code),
  CONSTRAINT stains__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT stains__code__ck CHECK (code ~ '^[A-Z0-9_]{1,32}$'),
  CONSTRAINT stains__display__ck CHECK (char_length(display) BETWEEN 1 AND 120),
  CONSTRAINT stains__kind__ck CHECK (kind IN ('routine','special','ihc')),
  CONSTRAINT stains__sort__ck CHECK (sort_order BETWEEN 0 AND 9999)
);

-- ---------- molecular assay definitions (M) ----------
CREATE TABLE anatomic.assays (
  id uuid NOT NULL, tenant_id uuid NOT NULL,
  code text NOT NULL, display text NOT NULL, method_text_default text,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT assays__pk PRIMARY KEY (id),
  CONSTRAINT assays__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT assays__tenant_id_code__uq UNIQUE (tenant_id, code),
  CONSTRAINT assays__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT assays__code__ck CHECK (code ~ '^[A-Z0-9_]{1,32}$'),
  CONSTRAINT assays__lens__ck CHECK (char_length(display) BETWEEN 1 AND 120 AND char_length(coalesce(method_text_default,'')) <= 200)
);
CREATE TABLE anatomic.assay_targets (
  id uuid NOT NULL, tenant_id uuid NOT NULL, assay_id uuid NOT NULL,
  code text NOT NULL, display text NOT NULL,
  allows_quantitative boolean NOT NULL DEFAULT false, unit_code text, decimals integer,
  sort_order integer NOT NULL DEFAULT 0,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT assay_targets__pk PRIMARY KEY (id),
  CONSTRAINT assay_targets__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT assay_targets__tenant_id_assay_code__uq UNIQUE (tenant_id, assay_id, code),
  CONSTRAINT assay_targets__assay__fk FOREIGN KEY (tenant_id, assay_id) REFERENCES anatomic.assays (tenant_id, id),
  CONSTRAINT assay_targets__code__ck CHECK (code ~ '^[A-Z0-9_]{1,32}$'),
  CONSTRAINT assay_targets__lens__ck CHECK (char_length(display) BETWEEN 1 AND 120 AND char_length(coalesce(unit_code,'')) <= 32),
  CONSTRAINT assay_targets__decimals__ck CHECK (decimals IS NULL OR decimals BETWEEN 0 AND 6),
  CONSTRAINT assay_targets__quant__ck CHECK (allows_quantitative OR (unit_code IS NULL AND decimals IS NULL))
);
CREATE TABLE anatomic.assay_target_values (
  id uuid NOT NULL, tenant_id uuid NOT NULL, target_id uuid NOT NULL,
  code text NOT NULL, display text NOT NULL, is_abnormal boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT assay_target_values__pk PRIMARY KEY (id),
  CONSTRAINT assay_target_values__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT assay_target_values__tenant_id_target_code__uq UNIQUE (tenant_id, target_id, code),
  CONSTRAINT assay_target_values__target__fk FOREIGN KEY (tenant_id, target_id) REFERENCES anatomic.assay_targets (tenant_id, id),
  CONSTRAINT assay_target_values__code__ck CHECK (code ~ '^[a-z0-9_]{1,32}$'),
  CONSTRAINT assay_target_values__display__ck CHECK (char_length(display) BETWEEN 1 AND 120)
);

-- ---------- coded sets (02-CV §5.5 shape) ----------
CREATE TABLE anatomic.g_cs_cancel_reasons (
  id uuid NOT NULL, code text NOT NULL, display text NOT NULL, system text NOT NULL DEFAULT 'lims',
  system_version text NOT NULL DEFAULT '1', sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT g_cs_cancel_reasons__pk PRIMARY KEY (id),
  CONSTRAINT g_cs_cancel_reasons__code__uq UNIQUE (code)
);
-- (no g_cs_change_reasons / cs_change_reasons: change reasons are C5 amendment reasons — 08 A17 D-62, §1)

-- tenant coded sets: identical shape; C0 may expand this template literally for each name
--   cs_cancel_reasons, cs_diagnoses, cs_cytology_adequacy
CREATE TABLE anatomic.cs_diagnoses (
  id uuid NOT NULL, tenant_id uuid NOT NULL,
  code text NOT NULL, display text NOT NULL,
  system text NOT NULL DEFAULT 'local', system_version text,
  sort_order integer NOT NULL DEFAULT 0,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT cs_diagnoses__pk PRIMARY KEY (id),
  CONSTRAINT cs_diagnoses__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT cs_diagnoses__tenant_id_code__uq UNIQUE (tenant_id, code),
  CONSTRAINT cs_diagnoses__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT cs_diagnoses__code__ck CHECK (code ~ '^[A-Za-z0-9_.:-]{1,64}$'),
  CONSTRAINT cs_diagnoses__lens__ck CHECK (char_length(display) BETWEEN 1 AND 300 AND char_length(system) BETWEEN 1 AND 32
                                           AND char_length(coalesce(system_version,'')) <= 32),
  CONSTRAINT cs_diagnoses__sort__ck CHECK (sort_order BETWEEN 0 AND 9999)
);
-- cs_diagnoses display search (listAnatomicCodedValues q): tenant-leading trigram index (02-CV §5.3); needs pg_trgm
-- (REQ-ARCH-023) and btree_gin, as C4 05-SCHEMA §0.9. Presence in the image is UNVERIFIED → C0 checks; if btree_gin is
-- missing, the index is created on (display extensions.gin_trgm_ops) alone and listed in db/meta/index-exceptions.yaml with this reason.
CREATE INDEX cs_diagnoses__tenant_id_display__trgm_idx ON anatomic.cs_diagnoses USING gin (tenant_id, display extensions.gin_trgm_ops);   -- 08 A31.1
-- cs_cancel_reasons, cs_cytology_adequacy: same columns/constraints with their own names; no trgm index (template expanded
-- literally, smoke-load 2026-11-06: the RLS loop below references both tables).
CREATE TABLE anatomic.cs_cancel_reasons (
  id uuid NOT NULL, tenant_id uuid NOT NULL,
  code text NOT NULL, display text NOT NULL,
  system text NOT NULL DEFAULT 'local', system_version text,
  sort_order integer NOT NULL DEFAULT 0,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT cs_cancel_reasons__pk PRIMARY KEY (id),
  CONSTRAINT cs_cancel_reasons__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT cs_cancel_reasons__tenant_id_code__uq UNIQUE (tenant_id, code),
  CONSTRAINT cs_cancel_reasons__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT cs_cancel_reasons__code__ck CHECK (code ~ '^[A-Za-z0-9_.:-]{1,64}$'),
  CONSTRAINT cs_cancel_reasons__lens__ck CHECK (char_length(display) BETWEEN 1 AND 300 AND char_length(system) BETWEEN 1 AND 32
                                           AND char_length(coalesce(system_version,'')) <= 32),
  CONSTRAINT cs_cancel_reasons__sort__ck CHECK (sort_order BETWEEN 0 AND 9999)
);
CREATE TABLE anatomic.cs_cytology_adequacy (
  id uuid NOT NULL, tenant_id uuid NOT NULL,
  code text NOT NULL, display text NOT NULL,
  system text NOT NULL DEFAULT 'local', system_version text,
  sort_order integer NOT NULL DEFAULT 0,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT cs_cytology_adequacy__pk PRIMARY KEY (id),
  CONSTRAINT cs_cytology_adequacy__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT cs_cytology_adequacy__tenant_id_code__uq UNIQUE (tenant_id, code),
  CONSTRAINT cs_cytology_adequacy__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT cs_cytology_adequacy__code__ck CHECK (code ~ '^[A-Za-z0-9_.:-]{1,64}$'),
  CONSTRAINT cs_cytology_adequacy__lens__ck CHECK (char_length(display) BETWEEN 1 AND 300 AND char_length(system) BETWEEN 1 AND 32
                                           AND char_length(coalesce(system_version,'')) <= 32),
  CONSTRAINT cs_cytology_adequacy__sort__ck CHECK (sort_order BETWEEN 0 AND 9999)
);

-- ---------- synoptic templates (M, versioned) ----------
CREATE TABLE anatomic.synoptic_templates (
  id uuid NOT NULL, tenant_id uuid NOT NULL,
  template_key text NOT NULL, version_no integer NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  title text NOT NULL,                      -- copy of definition.title for listing
  applies_to_case_kinds text[] NOT NULL,
  definition jsonb NOT NULL,                -- SynopticDefinitionV1 (02-TRD §4.5.1), validated by the API
  published_at timestamptz, published_by uuid, retired_at timestamptz,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT synoptic_templates__pk PRIMARY KEY (id),
  CONSTRAINT synoptic_templates__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT synoptic_templates__tenant_id_key_version__uq UNIQUE (tenant_id, template_key, version_no),
  CONSTRAINT synoptic_templates__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT synoptic_templates__key__ck CHECK (template_key ~ '^[a-z][a-z0-9_]{0,39}$'),
  CONSTRAINT synoptic_templates__status__ck CHECK (status IN ('draft','published','retired')),
  CONSTRAINT synoptic_templates__kinds__ck CHECK (cardinality(applies_to_case_kinds) BETWEEN 1 AND 4
       AND applies_to_case_kinds <@ ARRAY['histology','cytology','ihc','molecular']),
  CONSTRAINT synoptic_templates__title__ck CHECK (char_length(title) BETWEEN 1 AND 200),
  CONSTRAINT synoptic_templates__size__ck CHECK (pg_column_size(definition) <= 262144),          -- 256 KiB [CONV]
  CONSTRAINT synoptic_templates__published__ck CHECK ((status = 'draft') = (published_at IS NULL) OR status = 'retired')
);
CREATE UNIQUE INDEX synoptic_templates__tenant_id_key_published__p_uq
  ON anatomic.synoptic_templates (tenant_id, template_key) WHERE status = 'published';     -- one published version per key

CREATE FUNCTION anatomic.guard_synoptic_template() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF OLD.status <> 'draft' THEN
    -- published/retired: only retirement columns + bookkeeping may change
    IF (to_jsonb(OLD) - ARRAY['status','retired_at','updated_at','updated_by','version','is_active'])
       IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['status','retired_at','updated_at','updated_by','version','is_active'])
       OR NOT (OLD.status = NEW.status OR (OLD.status = 'published' AND NEW.status = 'retired')) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'anatomic.synoptic_templates';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER synoptic_templates__guard BEFORE UPDATE ON anatomic.synoptic_templates
  FOR EACH ROW EXECUTE FUNCTION anatomic.guard_synoptic_template();

-- ---------- text templates (M) ----------
CREATE TABLE anatomic.text_templates (
  id uuid NOT NULL, tenant_id uuid NOT NULL,
  short_code text NOT NULL, section text NOT NULL, title text NOT NULL, body text NOT NULL,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT text_templates__pk PRIMARY KEY (id),
  CONSTRAINT text_templates__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT text_templates__tenant_id_section_code__uq UNIQUE (tenant_id, section, short_code),
  CONSTRAINT text_templates__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT text_templates__code__ck CHECK (short_code ~ '^[a-z0-9_]{1,16}$'),
  CONSTRAINT text_templates__section__ck CHECK (section IN ('gross','microscopy','impression','comment','addendum')),
  CONSTRAINT text_templates__lens__ck CHECK (char_length(title) BETWEEN 1 AND 120 AND char_length(body) BETWEEN 1 AND 8000)
);

-- ============================================================================
-- Case-derived tables (centre-scoped)
-- ============================================================================

-- ---------- cases (C) ----------
CREATE TABLE anatomic.cases (
  id uuid NOT NULL, tenant_id uuid NOT NULL, centre_id uuid NOT NULL,
  branch_id uuid,                           -- processing branch from the event (optional)
  order_id uuid NOT NULL, patient_id uuid NOT NULL,
  case_kind text NOT NULL, status text NOT NULL DEFAULT 'received',
  priority text NOT NULL DEFAULT 'routine',
  accession_no text, accession_series text, accession_year integer,
  clinical_history_text text,
  assigned_pathologist_membership_id uuid,
  profile_missing boolean NOT NULL DEFAULT false,
  current_version_no integer NOT NULL DEFAULT 0,
  molecular_rev integer NOT NULL DEFAULT 0,
  received_at timestamptz NOT NULL, accessioned_at timestamptz, accessioned_by uuid,
  signed_out_at timestamptz, cancelled_at timestamptz, cancel_reason_code text, cancel_reason_text text,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT cases__pk PRIMARY KEY (id),
  CONSTRAINT cases__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT cases__tenant_id_id_centre__uq UNIQUE (tenant_id, id, centre_id),          -- parent for centre-consistency FKs
  CONSTRAINT cases__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT cases__centre__fk FOREIGN KEY (tenant_id, centre_id) REFERENCES core.collection_centres (tenant_id, id),
  CONSTRAINT cases__branch__fk FOREIGN KEY (tenant_id, branch_id) REFERENCES core.branches (tenant_id, id),
  CONSTRAINT cases__order__fk FOREIGN KEY (tenant_id, order_id) REFERENCES frontdesk.orders (tenant_id, id),
  CONSTRAINT cases__patient__fk FOREIGN KEY (tenant_id, patient_id) REFERENCES frontdesk.patients (tenant_id, id),
  CONSTRAINT cases__pathologist__fk FOREIGN KEY (tenant_id, assigned_pathologist_membership_id) REFERENCES core.memberships (tenant_id, id),
  CONSTRAINT cases__kind__ck CHECK (case_kind IN ('histology','cytology','ihc','molecular')),
  CONSTRAINT cases__status__ck CHECK (status IN ('received','accessioned','in_processing','ready_for_reporting','signed_out','cancelled')),
  CONSTRAINT cases__priority__ck CHECK (priority IN ('routine','urgent')),
  CONSTRAINT cases__accession__ck CHECK ((accession_no IS NULL) = (status = 'received')
                                         OR (status = 'cancelled')),
  CONSTRAINT cases__accession_fmt__ck CHECK (accession_no IS NULL OR accession_no ~ '^[A-Z0-9-]{1,20}$'),
  CONSTRAINT cases__history__ck CHECK (char_length(coalesce(clinical_history_text,'')) <= 4000),
  CONSTRAINT cases__cancel__ck CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)
                                      AND char_length(coalesce(cancel_reason_text,'')) <= 500),
  CONSTRAINT cases__signed__ck CHECK (status <> 'signed_out' OR (signed_out_at IS NOT NULL AND current_version_no >= 1))
);
CREATE UNIQUE INDEX cases__tenant_id_accession_no__p_uq ON anatomic.cases (tenant_id, accession_no) WHERE accession_no IS NOT NULL;
CREATE UNIQUE INDEX cases__open_case__p_uq ON anatomic.cases (tenant_id, order_id, case_kind)
  WHERE status NOT IN ('signed_out','cancelled');
CREATE INDEX cases__tenant_id_status_received__p_idx ON anatomic.cases (tenant_id, status, priority, received_at, id)
  WHERE status IN ('received','accessioned','in_processing','ready_for_reporting');
CREATE INDEX cases__tenant_id_received__idx ON anatomic.cases (tenant_id, received_at DESC, id);
CREATE INDEX cases__tenant_id_accessioned__idx ON anatomic.cases (tenant_id, accessioned_at DESC, id);   -- A1 sort=accessioned_at
CREATE INDEX cases__tenant_id_pathologist_status__idx ON anatomic.cases (tenant_id, assigned_pathologist_membership_id, status);
CREATE INDEX cases__tenant_id_order__idx ON anatomic.cases (tenant_id, order_id);

CREATE FUNCTION anatomic.guard_case() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  -- identity columns never change; accession number is write-once (AC-02.1)
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.centre_id IS DISTINCT FROM OLD.centre_id
     OR NEW.order_id IS DISTINCT FROM OLD.order_id OR NEW.patient_id IS DISTINCT FROM OLD.patient_id
     OR NEW.case_kind IS DISTINCT FROM OLD.case_kind OR NEW.received_at IS DISTINCT FROM OLD.received_at
     OR (OLD.accession_no IS NOT NULL AND NEW.accession_no IS DISTINCT FROM OLD.accession_no)
     OR OLD.status = 'cancelled'
     OR NEW.current_version_no < OLD.current_version_no THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'anatomic.cases';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cases__guard BEFORE UPDATE ON anatomic.cases FOR EACH ROW EXECUTE FUNCTION anatomic.guard_case();

-- ---------- case transitions (A) ----------
CREATE TABLE anatomic.case_transitions (
  id uuid NOT NULL, tenant_id uuid NOT NULL, centre_id uuid NOT NULL, case_id uuid NOT NULL,
  from_status text, to_status text NOT NULL, reason_code text,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  CONSTRAINT case_transitions__pk PRIMARY KEY (id),
  CONSTRAINT case_transitions__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT case_transitions__case__fk FOREIGN KEY (tenant_id, case_id, centre_id) REFERENCES anatomic.cases (tenant_id, id, centre_id),
  CONSTRAINT case_transitions__to__ck CHECK (to_status IN ('received','accessioned','in_processing','ready_for_reporting','signed_out','cancelled'))
);
CREATE INDEX case_transitions__tenant_id_case__idx ON anatomic.case_transitions (tenant_id, case_id, created_at DESC);

-- ---------- case items (C) = A1 payloadRef.entityId ----------
CREATE TABLE anatomic.case_items (
  id uuid NOT NULL, tenant_id uuid NOT NULL, centre_id uuid NOT NULL, case_id uuid NOT NULL,
  order_item_id uuid NOT NULL, test_id uuid NOT NULL,
  role text NOT NULL DEFAULT 'primary',
  lab_approved_version_no integer NOT NULL DEFAULT 0,  -- CR-C11-011 consumer; 0 until then
  lab_approved_at timestamptz,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT case_items__pk PRIMARY KEY (id),
  CONSTRAINT case_items__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT case_items__tenant_id_id_case__uq UNIQUE (tenant_id, id, case_id),          -- parent for same-case FKs
  CONSTRAINT case_items__tenant_id_order_item_id__uq UNIQUE (tenant_id, order_item_id),
  CONSTRAINT case_items__case__fk FOREIGN KEY (tenant_id, case_id, centre_id) REFERENCES anatomic.cases (tenant_id, id, centre_id),
  CONSTRAINT case_items__order_item__fk FOREIGN KEY (tenant_id, order_item_id) REFERENCES frontdesk.order_items (tenant_id, id),
  CONSTRAINT case_items__role__ck CHECK (role IN ('primary','addon'))
);
CREATE INDEX case_items__tenant_id_case__idx ON anatomic.case_items (tenant_id, case_id);

-- ---------- specimen links (C) ----------
CREATE TABLE anatomic.specimen_links (
  id uuid NOT NULL, tenant_id uuid NOT NULL, centre_id uuid NOT NULL,
  specimen_id uuid NOT NULL,
  case_id uuid, part_id uuid,
  link_kind text NOT NULL,                  -- part | addon (add-on items joined an open case, no part) | aliquot_ignored | not_anatomic; always explicit (02-TRD §4.1)
  last_seq integer NOT NULL, last_status text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT specimen_links__pk PRIMARY KEY (id),
  CONSTRAINT specimen_links__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT specimen_links__tenant_id_specimen_id__uq UNIQUE (tenant_id, specimen_id),
  CONSTRAINT specimen_links__specimen__fk FOREIGN KEY (tenant_id, specimen_id) REFERENCES lab.specimens (tenant_id, id),
  CONSTRAINT specimen_links__centre__fk FOREIGN KEY (tenant_id, centre_id) REFERENCES core.collection_centres (tenant_id, id),
  CONSTRAINT specimen_links__kind__ck CHECK (link_kind IN ('part','addon','aliquot_ignored','not_anatomic')),
  CONSTRAINT specimen_links__case__ck CHECK ((link_kind IN ('part','addon')) = (case_id IS NOT NULL)
                                             AND (link_kind = 'part') = (part_id IS NOT NULL)),
  CONSTRAINT specimen_links__seq__ck CHECK (last_seq >= 1)
);

-- ---------- parts (C) ----------
CREATE TABLE anatomic.parts (
  id uuid NOT NULL, tenant_id uuid NOT NULL, centre_id uuid NOT NULL, case_id uuid NOT NULL,
  letter text NOT NULL, letter_seq integer NOT NULL,
  specimen_id uuid, specimen_type_code text, specimen_state text NOT NULL DEFAULT 'none',
  site_text text, description_text text,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT parts__pk PRIMARY KEY (id),
  CONSTRAINT parts__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT parts__tenant_id_id_case__uq UNIQUE (tenant_id, id, case_id),
  CONSTRAINT parts__tenant_id_case_letter__uq UNIQUE (tenant_id, case_id, letter),
  CONSTRAINT parts__case__fk FOREIGN KEY (tenant_id, case_id, centre_id) REFERENCES anatomic.cases (tenant_id, id, centre_id),
  CONSTRAINT parts__specimen__fk FOREIGN KEY (tenant_id, specimen_id) REFERENCES lab.specimens (tenant_id, id),
  CONSTRAINT parts__letter__ck CHECK (letter ~ '^[A-Z]{1,2}$' AND letter_seq BETWEEN 1 AND 702),
  CONSTRAINT parts__state__ck CHECK (specimen_state IN ('received','rejected','none')),
  CONSTRAINT parts__lens__ck CHECK (char_length(coalesce(site_text,'')) <= 200 AND char_length(coalesce(description_text,'')) <= 1000)
);
CREATE INDEX parts__tenant_id_case__idx ON anatomic.parts (tenant_id, case_id);
CREATE INDEX parts__tenant_id_specimen__idx ON anatomic.parts (tenant_id, specimen_id);
ALTER TABLE anatomic.specimen_links
  ADD CONSTRAINT specimen_links__case__fk FOREIGN KEY (tenant_id, case_id, centre_id) REFERENCES anatomic.cases (tenant_id, id, centre_id),
  ADD CONSTRAINT specimen_links__part__fk FOREIGN KEY (tenant_id, part_id) REFERENCES anatomic.parts (tenant_id, id);

-- ---------- gross records (C) ----------
CREATE TABLE anatomic.gross_records (
  id uuid NOT NULL, tenant_id uuid NOT NULL, centre_id uuid NOT NULL, case_id uuid NOT NULL, part_id uuid NOT NULL,
  gross_text text NOT NULL DEFAULT '',
  pieces_count integer, dimensions_mm text[], weight_g text,
  is_complete boolean NOT NULL DEFAULT false, completed_at timestamptz, grossed_by_membership_id uuid NOT NULL,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT gross_records__pk PRIMARY KEY (id),
  CONSTRAINT gross_records__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT gross_records__tenant_id_part__uq UNIQUE (tenant_id, part_id),
  CONSTRAINT gross_records__case__fk FOREIGN KEY (tenant_id, case_id, centre_id) REFERENCES anatomic.cases (tenant_id, id, centre_id),
  CONSTRAINT gross_records__part__fk FOREIGN KEY (tenant_id, part_id, case_id) REFERENCES anatomic.parts (tenant_id, id, case_id),
  CONSTRAINT gross_records__grossed_by__fk FOREIGN KEY (tenant_id, grossed_by_membership_id) REFERENCES core.memberships (tenant_id, id),
  CONSTRAINT gross_records__text__ck CHECK (char_length(gross_text) <= 20000),
  CONSTRAINT gross_records__pieces__ck CHECK (pieces_count IS NULL OR pieces_count BETWEEN 0 AND 999),
  CONSTRAINT gross_records__dims__ck CHECK (dimensions_mm IS NULL OR (cardinality(dimensions_mm) BETWEEN 1 AND 3
       AND array_to_string(dimensions_mm, ',') ~ '^[0-9]{1,4}(\.[0-9])?(,[0-9]{1,4}(\.[0-9])?){0,2}$')),   -- API also rejects 0
  CONSTRAINT gross_records__weight__ck CHECK (weight_g IS NULL OR weight_g ~ '^[0-9]{1,5}(\.[0-9]{1,2})?$'),
  CONSTRAINT gross_records__complete__ck CHECK (is_complete = (completed_at IS NOT NULL))
);

-- ---------- blocks (C) ----------
CREATE TABLE anatomic.blocks (
  id uuid NOT NULL, tenant_id uuid NOT NULL, centre_id uuid NOT NULL, case_id uuid NOT NULL, part_id uuid NOT NULL,
  seq integer NOT NULL, label text NOT NULL, note text,
  location_status text NOT NULL DEFAULT 'in_lab', location_text text,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT blocks__pk PRIMARY KEY (id),
  CONSTRAINT blocks__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT blocks__tenant_id_id_case__uq UNIQUE (tenant_id, id, case_id),
  CONSTRAINT blocks__tenant_id_label__uq UNIQUE (tenant_id, label),
  CONSTRAINT blocks__tenant_id_part_seq__uq UNIQUE (tenant_id, part_id, seq),
  CONSTRAINT blocks__case__fk FOREIGN KEY (tenant_id, case_id, centre_id) REFERENCES anatomic.cases (tenant_id, id, centre_id),
  CONSTRAINT blocks__part__fk FOREIGN KEY (tenant_id, part_id, case_id) REFERENCES anatomic.parts (tenant_id, id, case_id),
  CONSTRAINT blocks__seq__ck CHECK (seq BETWEEN 1 AND 999),
  CONSTRAINT blocks__label__ck CHECK (label ~ '^[A-Z0-9-]{1,32}$'),
  CONSTRAINT blocks__location__ck CHECK (location_status IN ('in_lab','stored','sent_out','discarded')),
  CONSTRAINT blocks__lens__ck CHECK (char_length(coalesce(note,'')) <= 200 AND char_length(coalesce(location_text,'')) <= 200)
);
CREATE INDEX blocks__tenant_id_case__idx ON anatomic.blocks (tenant_id, case_id);
CREATE INDEX blocks__tenant_id_location__idx ON anatomic.blocks (tenant_id, location_status, updated_at, id);
CREATE TRIGGER blocks__mutable_columns BEFORE UPDATE ON anatomic.blocks
  FOR EACH ROW EXECUTE FUNCTION app.enforce_mutable_columns('note','location_status','location_text','updated_at','updated_by','version');

-- ---------- stain orders (C) ----------
CREATE TABLE anatomic.stain_orders (
  id uuid NOT NULL, tenant_id uuid NOT NULL, centre_id uuid NOT NULL, case_id uuid NOT NULL,
  stain_id uuid NOT NULL, stain_code text NOT NULL, stain_kind text NOT NULL,
  block_id uuid, part_id uuid,
  status text NOT NULL DEFAULT 'requested', note text, reagent_lot text,
  addon_case_item_id uuid,
  requested_at timestamptz NOT NULL, requested_by_membership_id uuid NOT NULL,
  started_at timestamptz, completed_at timestamptz, performed_at timestamptz,
  cancelled_at timestamptz, cancel_reason_text text,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT stain_orders__pk PRIMARY KEY (id),
  CONSTRAINT stain_orders__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT stain_orders__tenant_id_id_case__uq UNIQUE (tenant_id, id, case_id),        -- parent for slides.stain_order_id
  CONSTRAINT stain_orders__case__fk FOREIGN KEY (tenant_id, case_id, centre_id) REFERENCES anatomic.cases (tenant_id, id, centre_id),
  CONSTRAINT stain_orders__stain__fk FOREIGN KEY (tenant_id, stain_id) REFERENCES anatomic.stains (tenant_id, id),
  CONSTRAINT stain_orders__block__fk FOREIGN KEY (tenant_id, block_id, case_id) REFERENCES anatomic.blocks (tenant_id, id, case_id),
  CONSTRAINT stain_orders__part__fk FOREIGN KEY (tenant_id, part_id, case_id) REFERENCES anatomic.parts (tenant_id, id, case_id),
  CONSTRAINT stain_orders__addon__fk FOREIGN KEY (tenant_id, addon_case_item_id, case_id) REFERENCES anatomic.case_items (tenant_id, id, case_id),
  CONSTRAINT stain_orders__requester__fk FOREIGN KEY (tenant_id, requested_by_membership_id) REFERENCES core.memberships (tenant_id, id),
  CONSTRAINT stain_orders__kind__ck CHECK (stain_kind IN ('special','ihc')),             -- routine stains are not ordered (02-TRD M5)
  CONSTRAINT stain_orders__target__ck CHECK ((block_id IS NULL) <> (part_id IS NULL)),
  CONSTRAINT stain_orders__ihc_block__ck CHECK (stain_kind <> 'ihc' OR block_id IS NOT NULL),      -- anatomic.ihc_requires_block
  CONSTRAINT stain_orders__status__ck CHECK (status IN ('requested','in_progress','completed','cancelled')),
  CONSTRAINT stain_orders__lens__ck CHECK (char_length(coalesce(note,'')) <= 500 AND char_length(coalesce(reagent_lot,'')) <= 64
                                           AND char_length(coalesce(cancel_reason_text,'')) <= 500)
);
CREATE INDEX stain_orders__tenant_id_case__idx ON anatomic.stain_orders (tenant_id, case_id);
CREATE INDEX stain_orders__tenant_id_open__p_idx ON anatomic.stain_orders (tenant_id, status, requested_at, id)
  WHERE status IN ('requested','in_progress');

-- ---------- slides (C) ----------
CREATE TABLE anatomic.slides (
  id uuid NOT NULL, tenant_id uuid NOT NULL, centre_id uuid NOT NULL, case_id uuid NOT NULL,
  part_id uuid NOT NULL, block_id uuid,      -- block_id NULL = slide made directly from the part (smear)
  seq integer NOT NULL, label text NOT NULL,
  stain_id uuid NOT NULL, stain_code text NOT NULL, stain_order_id uuid,
  status text NOT NULL DEFAULT 'pending_stain', ready_at timestamptz,
  location_status text NOT NULL DEFAULT 'in_lab', location_text text,
  adequacy_code text, finding_text text, include_in_report boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT slides__pk PRIMARY KEY (id),
  CONSTRAINT slides__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT slides__tenant_id_label__uq UNIQUE (tenant_id, label),
  CONSTRAINT slides__case__fk FOREIGN KEY (tenant_id, case_id, centre_id) REFERENCES anatomic.cases (tenant_id, id, centre_id),
  CONSTRAINT slides__part__fk FOREIGN KEY (tenant_id, part_id, case_id) REFERENCES anatomic.parts (tenant_id, id, case_id),
  CONSTRAINT slides__block__fk FOREIGN KEY (tenant_id, block_id, case_id) REFERENCES anatomic.blocks (tenant_id, id, case_id),
  CONSTRAINT slides__stain__fk FOREIGN KEY (tenant_id, stain_id) REFERENCES anatomic.stains (tenant_id, id),
  CONSTRAINT slides__stain_order__fk FOREIGN KEY (tenant_id, stain_order_id, case_id) REFERENCES anatomic.stain_orders (tenant_id, id, case_id),
  CONSTRAINT slides__seq__ck CHECK (seq BETWEEN 1 AND 999),
  CONSTRAINT slides__label__ck CHECK (label ~ '^[A-Z0-9-]{1,32}$'),
  CONSTRAINT slides__status__ck CHECK (status IN ('pending_stain','ready') AND ((status = 'ready') = (ready_at IS NOT NULL))),
  CONSTRAINT slides__location__ck CHECK (location_status IN ('in_lab','stored','sent_out','discarded')),
  CONSTRAINT slides__lens__ck CHECK (char_length(coalesce(finding_text,'')) <= 2000 AND char_length(coalesce(location_text,'')) <= 200
                                     AND char_length(coalesce(adequacy_code,'')) <= 64)
);
CREATE UNIQUE INDEX slides__tenant_id_block_seq__p_uq ON anatomic.slides (tenant_id, block_id, seq) WHERE block_id IS NOT NULL;
CREATE UNIQUE INDEX slides__tenant_id_part_seq__p_uq ON anatomic.slides (tenant_id, part_id, seq) WHERE block_id IS NULL;
CREATE INDEX slides__tenant_id_case__idx ON anatomic.slides (tenant_id, case_id);
CREATE INDEX slides__tenant_id_pending__p_idx ON anatomic.slides (tenant_id, created_at, id) WHERE status = 'pending_stain';
CREATE TRIGGER slides__mutable_columns BEFORE UPDATE ON anatomic.slides
  FOR EACH ROW EXECUTE FUNCTION app.enforce_mutable_columns('status','ready_at','location_status','location_text',
    'adequacy_code','finding_text','include_in_report','updated_at','updated_by','version');

-- ---------- object movements (A) ----------
CREATE TABLE anatomic.object_movements (
  id uuid NOT NULL, tenant_id uuid NOT NULL, centre_id uuid NOT NULL, case_id uuid NOT NULL,
  object_kind text NOT NULL, object_id uuid NOT NULL,
  movement text NOT NULL, from_location_status text NOT NULL, to_location_status text NOT NULL,
  location_text text, destination_text text, reason_code text, note text,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  CONSTRAINT object_movements__pk PRIMARY KEY (id),
  CONSTRAINT object_movements__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT object_movements__case__fk FOREIGN KEY (tenant_id, case_id, centre_id) REFERENCES anatomic.cases (tenant_id, id, centre_id),
  CONSTRAINT object_movements__kind__ck CHECK (object_kind IN ('block','slide')),
  CONSTRAINT object_movements__movement__ck CHECK (movement IN ('stored','retrieved','sent_out','returned','discarded')),
  CONSTRAINT object_movements__loc__ck CHECK (from_location_status IN ('in_lab','stored','sent_out','discarded')
                                              AND to_location_status IN ('in_lab','stored','sent_out','discarded')),
  CONSTRAINT object_movements__reason__ck CHECK (reason_code IS NULL OR reason_code IN ('second_opinion','external_stain','consultation','retention_expired','other')),
  CONSTRAINT object_movements__lens__ck CHECK (char_length(coalesce(location_text,'')) <= 120 AND char_length(coalesce(destination_text,'')) <= 200
                                               AND char_length(coalesce(note,'')) <= 500),
  CONSTRAINT object_movements__stored__ck CHECK (movement <> 'stored' OR location_text IS NOT NULL),
  CONSTRAINT object_movements__sent__ck CHECK (movement <> 'sent_out' OR destination_text IS NOT NULL),
  CONSTRAINT object_movements__reason_req__ck CHECK (movement NOT IN ('sent_out','discarded') OR reason_code IS NOT NULL)
);
-- object_id points to blocks or slides (polymorphic; validated by the service in the same tx — no FK by design)
CREATE INDEX object_movements__tenant_id_object__idx ON anatomic.object_movements (tenant_id, object_kind, object_id, created_at DESC);

-- ---------- images (C) ----------
CREATE TABLE anatomic.images (
  id uuid NOT NULL, tenant_id uuid NOT NULL, centre_id uuid NOT NULL, case_id uuid NOT NULL,
  part_id uuid, kind text NOT NULL, caption text,
  bucket text NOT NULL DEFAULT 'anatomic-images', object_path text NOT NULL,
  state text NOT NULL DEFAULT 'processing', quarantine_reason_code text,
  scan_state text NOT NULL, scan_attempts smallint NOT NULL DEFAULT 0,      -- 08 A17 P-19 (AcceptedUpload.scanState, re-scan job)
  mime_type text, byte_size bigint, sha256 text, width_px integer, height_px integer,
  is_active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT images__pk PRIMARY KEY (id),
  CONSTRAINT images__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT images__tenant_id_object_path__uq UNIQUE (tenant_id, object_path),
  CONSTRAINT images__case__fk FOREIGN KEY (tenant_id, case_id, centre_id) REFERENCES anatomic.cases (tenant_id, id, centre_id),
  CONSTRAINT images__part__fk FOREIGN KEY (tenant_id, part_id, case_id) REFERENCES anatomic.parts (tenant_id, id, case_id),
  CONSTRAINT images__kind__ck CHECK (kind IN ('gross','microscopy','other')),
  CONSTRAINT images__bucket__ck CHECK (bucket = 'anatomic-images'),
  CONSTRAINT images__path__ck CHECK (object_path ~ '^[0-9a-f-]{36}/[0-9]{4}/[0-9]{2}/[0-9a-f-]{36}\.(png|jpg)$'
                                     AND split_part(object_path, '/', 1) = tenant_id::text),       -- 04 D15 pattern; no PHI
  CONSTRAINT images__state__ck CHECK (state IN ('processing','ready','quarantined')),
  CONSTRAINT images__scan__ck CHECK (scan_state IN ('pending','clean','infected','unavailable')
       AND ((state = 'ready') = (scan_state = 'clean'))
       AND ((state = 'quarantined') = (scan_state = 'infected'))
       AND scan_attempts BETWEEN 0 AND 5),
  CONSTRAINT images__quarantine__ck CHECK ((state = 'quarantined') = (quarantine_reason_code IS NOT NULL)
       AND (quarantine_reason_code IS NULL OR quarantine_reason_code ~ '^[a-z_]{1,32}$')),
  CONSTRAINT images__ready__ck CHECK (state <> 'ready' OR (sha256 ~ '^[0-9a-f]{64}$' AND mime_type IN ('image/png','image/jpeg')
                                      AND byte_size BETWEEN 1 AND 15728640)),
  CONSTRAINT images__caption__ck CHECK (char_length(coalesce(caption,'')) <= 200)
);
CREATE INDEX images__tenant_id_case__idx ON anatomic.images (tenant_id, case_id) WHERE is_active;
CREATE TRIGGER images__mutable_columns BEFORE UPDATE ON anatomic.images
  FOR EACH ROW EXECUTE FUNCTION app.enforce_mutable_columns('part_id','kind','caption','state','quarantine_reason_code',
    'scan_state','scan_attempts','is_active','updated_at','updated_by','version');
-- sha256/mime/size/dimensions are written once at insert from AcceptedUpload (02-TRD §4.9) and never change.
-- service rule (not DB): state/scan_state change only processing → ready|quarantined (re-scan job).

-- ---------- report drafts (C) ----------
CREATE TABLE anatomic.report_drafts (
  id uuid NOT NULL, tenant_id uuid NOT NULL, centre_id uuid NOT NULL, case_id uuid NOT NULL,
  kind text NOT NULL, status text NOT NULL DEFAULT 'open',
  change_reason_code text, change_reason_text text,
  gross_text text NOT NULL DEFAULT '', microscopy_text text NOT NULL DEFAULT '',
  impression_text text NOT NULL DEFAULT '', comment_text text NOT NULL DEFAULT '',
  flag text, is_critical boolean NOT NULL DEFAULT false,
  synoptic jsonb NOT NULL DEFAULT '[]', ancillary jsonb NOT NULL DEFAULT '[]',
  image_ids uuid[] NOT NULL DEFAULT '{}', diagnosis_codes text[] NOT NULL DEFAULT '{}',
  base_version_no integer NOT NULL DEFAULT 0,          -- version the change draft was prefilled from
  consumed_version_no integer, consumed_at timestamptz, discarded_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT report_drafts__pk PRIMARY KEY (id),
  CONSTRAINT report_drafts__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT report_drafts__case__fk FOREIGN KEY (tenant_id, case_id, centre_id) REFERENCES anatomic.cases (tenant_id, id, centre_id),
  CONSTRAINT report_drafts__kind__ck CHECK (kind IN ('initial','revision','amendment')),
  CONSTRAINT report_drafts__status__ck CHECK (status IN ('open','consumed','discarded')
       AND ((status = 'consumed') = (consumed_at IS NOT NULL)) AND ((status = 'discarded') = (discarded_at IS NOT NULL))),
  CONSTRAINT report_drafts__reason__ck CHECK (kind = 'initial' OR change_reason_code IS NOT NULL),
  CONSTRAINT report_drafts__reason_fmt__ck CHECK (change_reason_code IS NULL OR change_reason_code ~ '^[a-z0-9_]{1,64}$'),   -- C5 amendment reason (D-62)
  CONSTRAINT report_drafts__flag__ck CHECK (flag IS NULL OR flag IN ('N','A')),
  CONSTRAINT report_drafts__lens__ck CHECK (char_length(gross_text) <= 20000 AND char_length(microscopy_text) <= 20000
       AND char_length(impression_text) <= 8000 AND char_length(comment_text) <= 8000
       AND char_length(coalesce(change_reason_text,'')) <= 500
       AND cardinality(image_ids) <= 24 AND cardinality(diagnosis_codes) <= 20
       AND jsonb_typeof(synoptic) = 'array' AND jsonb_array_length(synoptic) <= 5
       AND jsonb_typeof(ancillary) = 'array' AND jsonb_array_length(ancillary) <= 50)
);
CREATE UNIQUE INDEX report_drafts__tenant_id_case_open__p_uq ON anatomic.report_drafts (tenant_id, case_id) WHERE status = 'open';
CREATE UNIQUE INDEX report_drafts__tenant_id_case_initial__p_uq ON anatomic.report_drafts (tenant_id, case_id) WHERE kind = 'initial';
CREATE INDEX report_drafts__tenant_id_case__idx ON anatomic.report_drafts (tenant_id, case_id);
CREATE FUNCTION anatomic.guard_report_draft() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF OLD.status <> 'open' THEN                       -- consumed/discarded drafts are frozen
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'anatomic.report_drafts';
  END IF;
  IF NEW.kind IS DISTINCT FROM OLD.kind OR NEW.case_id IS DISTINCT FROM OLD.case_id THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'anatomic.report_drafts';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER report_drafts__guard BEFORE UPDATE ON anatomic.report_drafts FOR EACH ROW EXECUTE FUNCTION anatomic.guard_report_draft();

-- ---------- addenda (C, immutable once signed) ----------
CREATE TABLE anatomic.addenda (
  id uuid NOT NULL, tenant_id uuid NOT NULL, centre_id uuid NOT NULL, case_id uuid NOT NULL,
  seq integer NOT NULL, kind text NOT NULL, text text NOT NULL,
  stain_order_ids uuid[] NOT NULL DEFAULT '{}', addon_case_item_id uuid,
  status text NOT NULL DEFAULT 'draft', signed_at timestamptz, signed_by_membership_id uuid, report_version_no integer,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT addenda__pk PRIMARY KEY (id),
  CONSTRAINT addenda__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT addenda__tenant_id_id_case__uq UNIQUE (tenant_id, id, case_id),              -- parent for report_versions.addendum_id
  CONSTRAINT addenda__tenant_id_case_seq__uq UNIQUE (tenant_id, case_id, seq),
  CONSTRAINT addenda__case__fk FOREIGN KEY (tenant_id, case_id, centre_id) REFERENCES anatomic.cases (tenant_id, id, centre_id),
  CONSTRAINT addenda__addon__fk FOREIGN KEY (tenant_id, addon_case_item_id, case_id) REFERENCES anatomic.case_items (tenant_id, id, case_id),
  CONSTRAINT addenda__signer__fk FOREIGN KEY (tenant_id, signed_by_membership_id) REFERENCES core.memberships (tenant_id, id),
  CONSTRAINT addenda__kind__ck CHECK (kind IN ('ihc','special_stain','molecular','other')),
  CONSTRAINT addenda__status__ck CHECK (status IN ('draft','signed')
       AND ((status = 'signed') = (signed_at IS NOT NULL AND signed_by_membership_id IS NOT NULL AND report_version_no IS NOT NULL))),
  CONSTRAINT addenda__lens__ck CHECK (char_length(text) BETWEEN 1 AND 8000 AND cardinality(stain_order_ids) <= 20)
);
CREATE INDEX addenda__tenant_id_case__idx ON anatomic.addenda (tenant_id, case_id);
CREATE FUNCTION anatomic.guard_addendum() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF OLD.status = 'signed' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'anatomic.addenda';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER addenda__guard BEFORE UPDATE ON anatomic.addenda FOR EACH ROW EXECUTE FUNCTION anatomic.guard_addendum();

-- ---------- report versions (A: insert-only, immutable) ----------
CREATE TABLE anatomic.report_versions (
  id uuid NOT NULL, tenant_id uuid NOT NULL, centre_id uuid NOT NULL, case_id uuid NOT NULL,
  version_no integer NOT NULL,
  version_kind text NOT NULL, scope text NOT NULL DEFAULT 'full',
  addon_case_item_id uuid, addendum_id uuid,
  change_reason_code text, change_reason_text text,
  clinical_history_text text NOT NULL DEFAULT '',
  gross_text text NOT NULL DEFAULT '', microscopy_text text NOT NULL DEFAULT '',
  impression_text text NOT NULL DEFAULT '', comment_text text NOT NULL DEFAULT '',
  flag text, is_critical boolean NOT NULL DEFAULT false,
  synoptic jsonb NOT NULL DEFAULT '[]', images jsonb NOT NULL DEFAULT '[]',
  specimen_parts jsonb NOT NULL DEFAULT '[]', slides jsonb NOT NULL DEFAULT '[]',
  ancillary jsonb NOT NULL DEFAULT '[]', molecular jsonb NOT NULL DEFAULT '[]',
  addenda jsonb NOT NULL DEFAULT '[]', diagnosis_codes jsonb NOT NULL DEFAULT '[]',
  signed_by_membership_id uuid NOT NULL, signed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  CONSTRAINT report_versions__pk PRIMARY KEY (id),
  CONSTRAINT report_versions__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT report_versions__tenant_id_id_case__uq UNIQUE (tenant_id, id, case_id),      -- parent for item_submissions
  CONSTRAINT report_versions__tenant_id_case_version__uq UNIQUE (tenant_id, case_id, version_no),
  CONSTRAINT report_versions__case__fk FOREIGN KEY (tenant_id, case_id, centre_id) REFERENCES anatomic.cases (tenant_id, id, centre_id),
  CONSTRAINT report_versions__addon__fk FOREIGN KEY (tenant_id, addon_case_item_id, case_id) REFERENCES anatomic.case_items (tenant_id, id, case_id),
  CONSTRAINT report_versions__addendum__fk FOREIGN KEY (tenant_id, addendum_id, case_id) REFERENCES anatomic.addenda (tenant_id, id, case_id),
  CONSTRAINT report_versions__signer__fk FOREIGN KEY (tenant_id, signed_by_membership_id) REFERENCES core.memberships (tenant_id, id),
  CONSTRAINT report_versions__no__ck CHECK (version_no >= 1),
  CONSTRAINT report_versions__kind__ck CHECK (version_kind IN ('original','revision','amendment','addendum')),
  CONSTRAINT report_versions__scope__ck CHECK (scope IN ('full','addendum_only')
       AND ((scope = 'addendum_only') = (addon_case_item_id IS NOT NULL))
       AND (scope = 'full' OR version_kind = 'addendum')),
  CONSTRAINT report_versions__original__ck CHECK ((version_kind = 'original') = (version_no = 1)),
  CONSTRAINT report_versions__reason__ck CHECK (version_kind IN ('original','addendum') OR change_reason_code IS NOT NULL),
  CONSTRAINT report_versions__reason_fmt__ck CHECK ((change_reason_code IS NULL OR change_reason_code ~ '^[a-z0-9_]{1,64}$')
       AND char_length(coalesce(change_reason_text,'')) <= 500),
  CONSTRAINT report_versions__flag__ck CHECK (flag IS NULL OR flag IN ('N','A')),
  CONSTRAINT report_versions__json__ck CHECK (jsonb_typeof(synoptic) = 'array' AND jsonb_typeof(images) = 'array'
       AND jsonb_typeof(specimen_parts) = 'array' AND jsonb_typeof(slides) = 'array' AND jsonb_typeof(ancillary) = 'array'
       AND jsonb_typeof(molecular) = 'array' AND jsonb_typeof(addenda) = 'array' AND jsonb_typeof(diagnosis_codes) = 'array'
       AND jsonb_array_length(images) <= 24 AND jsonb_array_length(synoptic) <= 5)
);
CREATE INDEX report_versions__tenant_id_case__idx ON anatomic.report_versions (tenant_id, case_id, version_no DESC);

-- ---------- item submissions (A) ----------
CREATE TABLE anatomic.item_submissions (
  id uuid NOT NULL, tenant_id uuid NOT NULL, centre_id uuid NOT NULL, case_id uuid NOT NULL,
  case_item_id uuid NOT NULL, item_version_no integer NOT NULL,       -- = A1 payloadRef.versionNo
  report_version_id uuid NOT NULL,
  idempotency_key text NOT NULL,                                     -- 'anatomic:<case_item_id>:<item_version_no>'
  lab_result_id uuid NOT NULL, lab_version_no integer NOT NULL, lab_status text NOT NULL, replayed boolean NOT NULL,
  submitted_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  CONSTRAINT item_submissions__pk PRIMARY KEY (id),
  CONSTRAINT item_submissions__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT item_submissions__tenant_id_item_version__uq UNIQUE (tenant_id, case_item_id, item_version_no),
  CONSTRAINT item_submissions__tenant_id_key__uq UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT item_submissions__case__fk FOREIGN KEY (tenant_id, case_id, centre_id) REFERENCES anatomic.cases (tenant_id, id, centre_id),
  CONSTRAINT item_submissions__item__fk FOREIGN KEY (tenant_id, case_item_id, case_id) REFERENCES anatomic.case_items (tenant_id, id, case_id),
  CONSTRAINT item_submissions__version__fk FOREIGN KEY (tenant_id, report_version_id, case_id) REFERENCES anatomic.report_versions (tenant_id, id, case_id),
  CONSTRAINT item_submissions__lab_result__fk FOREIGN KEY (tenant_id, lab_result_id) REFERENCES lab.results (tenant_id, id),
  CONSTRAINT item_submissions__no__ck CHECK (item_version_no >= 1 AND lab_version_no >= 1),
  CONSTRAINT item_submissions__status__ck CHECK (lab_status IN ('pending','resulted','verified','approved','cancelled')),
  CONSTRAINT item_submissions__key__ck CHECK (idempotency_key = 'anatomic:' || case_item_id::text || ':' || item_version_no::text)
);
CREATE INDEX item_submissions__tenant_id_lab_result__idx ON anatomic.item_submissions (tenant_id, lab_result_id);
CREATE INDEX item_submissions__tenant_id_case__idx ON anatomic.item_submissions (tenant_id, case_id);

-- ---------- molecular results (C) ----------
CREATE TABLE anatomic.molecular_results (
  id uuid NOT NULL, tenant_id uuid NOT NULL, centre_id uuid NOT NULL, case_id uuid NOT NULL,
  assay_id uuid NOT NULL, assay_code text NOT NULL, target_id uuid NOT NULL, target_code text NOT NULL,
  result_value_id uuid NOT NULL, result_code text NOT NULL,
  value_decimal text, unit_code text, method_text text, kit_name text, kit_lot text, kit_expiry_on date,
  batch_id uuid, comment_text text,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT molecular_results__pk PRIMARY KEY (id),
  CONSTRAINT molecular_results__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT molecular_results__case__fk FOREIGN KEY (tenant_id, case_id, centre_id) REFERENCES anatomic.cases (tenant_id, id, centre_id),
  CONSTRAINT molecular_results__assay__fk FOREIGN KEY (tenant_id, assay_id) REFERENCES anatomic.assays (tenant_id, id),
  CONSTRAINT molecular_results__target__fk FOREIGN KEY (tenant_id, target_id) REFERENCES anatomic.assay_targets (tenant_id, id),
  CONSTRAINT molecular_results__value__fk FOREIGN KEY (tenant_id, result_value_id) REFERENCES anatomic.assay_target_values (tenant_id, id),
  CONSTRAINT molecular_results__decimal__ck CHECK (value_decimal IS NULL OR value_decimal ~ '^-?[0-9]{1,12}(\.[0-9]{1,6})?$'),
  CONSTRAINT molecular_results__lens__ck CHECK (char_length(coalesce(unit_code,'')) <= 32 AND char_length(coalesce(method_text,'')) <= 200
       AND char_length(coalesce(kit_name,'')) <= 120 AND char_length(coalesce(kit_lot,'')) <= 64
       AND char_length(coalesce(comment_text,'')) <= 1000)
);
CREATE UNIQUE INDEX molecular_results__tenant_id_case_target__p_uq ON anatomic.molecular_results (tenant_id, case_id, target_id) WHERE is_active;
CREATE INDEX molecular_results__tenant_id_case__idx ON anatomic.molecular_results (tenant_id, case_id);

-- ---------- batches (C, tenant-scoped) ----------
CREATE TABLE anatomic.batches (
  id uuid NOT NULL, tenant_id uuid NOT NULL,
  batch_no text NOT NULL, assay_id uuid NOT NULL, status text NOT NULL DEFAULT 'open',
  kit_name text, kit_lot text, kit_expiry_on date, instrument_text text, run_at timestamptz,
  capacity integer NOT NULL DEFAULT 96, closed_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT batches__pk PRIMARY KEY (id),
  CONSTRAINT batches__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT batches__tenant_id_batch_no__uq UNIQUE (tenant_id, batch_no),
  CONSTRAINT batches__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT batches__assay__fk FOREIGN KEY (tenant_id, assay_id) REFERENCES anatomic.assays (tenant_id, id),
  CONSTRAINT batches__status__ck CHECK (status IN ('open','closed') AND ((status = 'closed') = (closed_at IS NOT NULL))),
  CONSTRAINT batches__no__ck CHECK (batch_no ~ '^[A-Z0-9-]{1,20}$'),
  CONSTRAINT batches__capacity__ck CHECK (capacity BETWEEN 1 AND 384),
  CONSTRAINT batches__lens__ck CHECK (char_length(coalesce(kit_name,'')) <= 120 AND char_length(coalesce(kit_lot,'')) <= 64
                                      AND char_length(coalesce(instrument_text,'')) <= 120)
);
CREATE INDEX batches__tenant_id_status__idx ON anatomic.batches (tenant_id, status, created_at DESC);
CREATE TABLE anatomic.batch_members (
  id uuid NOT NULL, tenant_id uuid NOT NULL, batch_id uuid NOT NULL, case_id uuid NOT NULL,
  position integer NOT NULL, is_active boolean NOT NULL DEFAULT true, removed_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT batch_members__pk PRIMARY KEY (id),
  CONSTRAINT batch_members__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT batch_members__batch__fk FOREIGN KEY (tenant_id, batch_id) REFERENCES anatomic.batches (tenant_id, id),
  CONSTRAINT batch_members__case__fk FOREIGN KEY (tenant_id, case_id) REFERENCES anatomic.cases (tenant_id, id),
  CONSTRAINT batch_members__position__ck CHECK (position BETWEEN 1 AND 384),
  CONSTRAINT batch_members__active__ck CHECK (is_active = (removed_at IS NULL))
);
CREATE UNIQUE INDEX batch_members__tenant_id_batch_position__p_uq ON anatomic.batch_members (tenant_id, batch_id, position) WHERE is_active;
CREATE UNIQUE INDEX batch_members__tenant_id_batch_case__p_uq ON anatomic.batch_members (tenant_id, batch_id, case_id) WHERE is_active;
ALTER TABLE anatomic.molecular_results
  ADD CONSTRAINT molecular_results__batch__fk FOREIGN KEY (tenant_id, batch_id) REFERENCES anatomic.batches (tenant_id, id);

-- ---------- event inbox (A) — created by C0 with its policies (C0 05-SCHEMA §3.9); shown for reference only, C11 emits no DDL ----------
-- CREATE TABLE anatomic.event_inbox (tenant_id uuid NOT NULL, event_id uuid NOT NULL, event_type text NOT NULL,
--   received_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL, CONSTRAINT event_inbox__pk PRIMARY KEY (tenant_id, event_id));

-- ===================== §8 published view (verbatim) =====================
CREATE VIEW anatomic.v_pub_report_content WITH (security_invoker = true) AS   -- REQ-SEC-031
SELECT
  s.tenant_id                     AS tenant_id,                 -- uuid
  s.case_item_id                  AS entity_id,                 -- uuid = A1 payloadRef.entityId
  s.item_version_no               AS version_no,                -- integer = A1 payloadRef.versionNo
  ci.order_item_id                AS order_item_id,             -- uuid
  c.accession_no                  AS accession_no,              -- text
  c.case_kind                     AS case_kind,                 -- text: histology|cytology|ihc|molecular
  rv.gross_text                   AS gross_text,                -- text ('' when not applicable)
  rv.microscopy_text              AS microscopy_text,           -- text
  rv.impression_text              AS impression_text,           -- text
  rv.synoptic                     AS synoptic,                  -- jsonb (§5)
  rv.images                       AS images,                    -- jsonb: bucket, object_path, sha256, caption
  rv.signed_by_membership_id      AS signed_by_membership_id,   -- uuid
  rv.signed_at                    AS signed_at,                 -- timestamptz
  -- ---- CR-C11-001 additive columns ----
  rv.version_kind                 AS version_kind,              -- text: original|revision|amendment|addendum
  rv.scope                        AS scope,                     -- text: full|addendum_only
  rv.change_reason_code           AS change_reason_code,        -- text (null for original/addendum)
  rv.clinical_history_text        AS clinical_history_text,     -- text
  rv.comment_text                 AS comment_text,              -- text
  rv.specimen_parts               AS specimen_parts,            -- jsonb (§5)
  rv.slides                       AS slides,                    -- jsonb (§5)
  rv.ancillary                    AS ancillary,                 -- jsonb (§5)
  rv.molecular                    AS molecular,                 -- jsonb (§5)
  rv.addenda                      AS addenda,                   -- jsonb (§5)
  rv.diagnosis_codes              AS diagnosis_codes            -- jsonb (§5)
FROM anatomic.item_submissions s
JOIN anatomic.case_items      ci ON ci.tenant_id = s.tenant_id AND ci.id = s.case_item_id
JOIN anatomic.report_versions rv ON rv.tenant_id = s.tenant_id AND rv.id = s.report_version_id
JOIN anatomic.cases           c  ON c.tenant_id  = s.tenant_id AND c.id  = s.case_id;
GRANT SELECT ON anatomic.v_pub_report_content TO lims_app, lims_analytics;   -- C0 §9 rule 3

-- ===================== RLS (§7 cases example + DO block expanded) =====================
ALTER TABLE anatomic.cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE anatomic.cases FORCE ROW LEVEL SECURITY;
ALTER TABLE anatomic.case_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE anatomic.case_items FORCE ROW LEVEL SECURITY;
ALTER TABLE anatomic.specimen_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE anatomic.specimen_links FORCE ROW LEVEL SECURITY;
ALTER TABLE anatomic.parts ENABLE ROW LEVEL SECURITY;
ALTER TABLE anatomic.parts FORCE ROW LEVEL SECURITY;
ALTER TABLE anatomic.gross_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE anatomic.gross_records FORCE ROW LEVEL SECURITY;
ALTER TABLE anatomic.blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE anatomic.blocks FORCE ROW LEVEL SECURITY;
ALTER TABLE anatomic.slides ENABLE ROW LEVEL SECURITY;
ALTER TABLE anatomic.slides FORCE ROW LEVEL SECURITY;
ALTER TABLE anatomic.stain_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE anatomic.stain_orders FORCE ROW LEVEL SECURITY;
ALTER TABLE anatomic.images ENABLE ROW LEVEL SECURITY;
ALTER TABLE anatomic.images FORCE ROW LEVEL SECURITY;
ALTER TABLE anatomic.report_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE anatomic.report_drafts FORCE ROW LEVEL SECURITY;
ALTER TABLE anatomic.addenda ENABLE ROW LEVEL SECURITY;
ALTER TABLE anatomic.addenda FORCE ROW LEVEL SECURITY;
ALTER TABLE anatomic.molecular_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE anatomic.molecular_results FORCE ROW LEVEL SECURITY;
ALTER TABLE anatomic.case_transitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE anatomic.case_transitions FORCE ROW LEVEL SECURITY;
ALTER TABLE anatomic.object_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE anatomic.object_movements FORCE ROW LEVEL SECURITY;
ALTER TABLE anatomic.report_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE anatomic.report_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE anatomic.item_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE anatomic.item_submissions FORCE ROW LEVEL SECURITY;
ALTER TABLE anatomic.settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE anatomic.settings FORCE ROW LEVEL SECURITY;
ALTER TABLE anatomic.accession_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE anatomic.accession_counters FORCE ROW LEVEL SECURITY;
ALTER TABLE anatomic.test_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE anatomic.test_profiles FORCE ROW LEVEL SECURITY;
ALTER TABLE anatomic.stains ENABLE ROW LEVEL SECURITY;
ALTER TABLE anatomic.stains FORCE ROW LEVEL SECURITY;
ALTER TABLE anatomic.assays ENABLE ROW LEVEL SECURITY;
ALTER TABLE anatomic.assays FORCE ROW LEVEL SECURITY;
ALTER TABLE anatomic.assay_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE anatomic.assay_targets FORCE ROW LEVEL SECURITY;
ALTER TABLE anatomic.assay_target_values ENABLE ROW LEVEL SECURITY;
ALTER TABLE anatomic.assay_target_values FORCE ROW LEVEL SECURITY;
ALTER TABLE anatomic.cs_cancel_reasons ENABLE ROW LEVEL SECURITY;
ALTER TABLE anatomic.cs_cancel_reasons FORCE ROW LEVEL SECURITY;
ALTER TABLE anatomic.cs_diagnoses ENABLE ROW LEVEL SECURITY;
ALTER TABLE anatomic.cs_diagnoses FORCE ROW LEVEL SECURITY;
ALTER TABLE anatomic.cs_cytology_adequacy ENABLE ROW LEVEL SECURITY;
ALTER TABLE anatomic.cs_cytology_adequacy FORCE ROW LEVEL SECURITY;
ALTER TABLE anatomic.synoptic_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE anatomic.synoptic_templates FORCE ROW LEVEL SECURITY;
ALTER TABLE anatomic.text_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE anatomic.text_templates FORCE ROW LEVEL SECURITY;
ALTER TABLE anatomic.batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE anatomic.batches FORCE ROW LEVEL SECURITY;
ALTER TABLE anatomic.batch_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE anatomic.batch_members FORCE ROW LEVEL SECURITY;

-- ===================== policies (§7; pred_c carries the staff guard [CONV] P-16, gate 9; copied to db/policies/anatomic.sql) =====================
CREATE POLICY cases__select__tenant_centre ON anatomic.cases FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY cases__insert__tenant_centre ON anatomic.cases FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY cases__update__tenant_centre ON anatomic.cases FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY case_items__select__tenant_centre ON anatomic.case_items FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY case_items__insert__tenant_centre ON anatomic.case_items FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY case_items__update__tenant_centre ON anatomic.case_items FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY specimen_links__select__tenant_centre ON anatomic.specimen_links FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY specimen_links__insert__tenant_centre ON anatomic.specimen_links FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY specimen_links__update__tenant_centre ON anatomic.specimen_links FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY parts__select__tenant_centre ON anatomic.parts FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY parts__insert__tenant_centre ON anatomic.parts FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY parts__update__tenant_centre ON anatomic.parts FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY gross_records__select__tenant_centre ON anatomic.gross_records FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY gross_records__insert__tenant_centre ON anatomic.gross_records FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY gross_records__update__tenant_centre ON anatomic.gross_records FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY blocks__select__tenant_centre ON anatomic.blocks FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY blocks__insert__tenant_centre ON anatomic.blocks FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY blocks__update__tenant_centre ON anatomic.blocks FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY slides__select__tenant_centre ON anatomic.slides FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY slides__insert__tenant_centre ON anatomic.slides FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY slides__update__tenant_centre ON anatomic.slides FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY stain_orders__select__tenant_centre ON anatomic.stain_orders FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY stain_orders__insert__tenant_centre ON anatomic.stain_orders FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY stain_orders__update__tenant_centre ON anatomic.stain_orders FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY images__select__tenant_centre ON anatomic.images FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY images__insert__tenant_centre ON anatomic.images FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY images__update__tenant_centre ON anatomic.images FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY report_drafts__select__tenant_centre ON anatomic.report_drafts FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY report_drafts__insert__tenant_centre ON anatomic.report_drafts FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY report_drafts__update__tenant_centre ON anatomic.report_drafts FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY addenda__select__tenant_centre ON anatomic.addenda FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY addenda__insert__tenant_centre ON anatomic.addenda FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY addenda__update__tenant_centre ON anatomic.addenda FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY molecular_results__select__tenant_centre ON anatomic.molecular_results FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY molecular_results__insert__tenant_centre ON anatomic.molecular_results FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY molecular_results__update__tenant_centre ON anatomic.molecular_results FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY case_transitions__select__tenant_centre ON anatomic.case_transitions FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY case_transitions__insert__tenant_centre ON anatomic.case_transitions FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY object_movements__select__tenant_centre ON anatomic.object_movements FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY object_movements__insert__tenant_centre ON anatomic.object_movements FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY report_versions__select__tenant_centre ON anatomic.report_versions FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY report_versions__insert__tenant_centre ON anatomic.report_versions FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY item_submissions__select__tenant_centre ON anatomic.item_submissions FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY item_submissions__insert__tenant_centre ON anatomic.item_submissions FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY settings__select__tenant ON anatomic.settings FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY settings__insert__tenant ON anatomic.settings FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY settings__update__tenant ON anatomic.settings FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY accession_counters__select__tenant ON anatomic.accession_counters FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY accession_counters__insert__tenant ON anatomic.accession_counters FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY accession_counters__update__tenant ON anatomic.accession_counters FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY test_profiles__select__tenant ON anatomic.test_profiles FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY test_profiles__insert__tenant ON anatomic.test_profiles FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY test_profiles__update__tenant ON anatomic.test_profiles FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY stains__select__tenant ON anatomic.stains FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY stains__insert__tenant ON anatomic.stains FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY stains__update__tenant ON anatomic.stains FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY assays__select__tenant ON anatomic.assays FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY assays__insert__tenant ON anatomic.assays FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY assays__update__tenant ON anatomic.assays FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY assay_targets__select__tenant ON anatomic.assay_targets FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY assay_targets__insert__tenant ON anatomic.assay_targets FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY assay_targets__update__tenant ON anatomic.assay_targets FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY assay_target_values__select__tenant ON anatomic.assay_target_values FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY assay_target_values__insert__tenant ON anatomic.assay_target_values FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY assay_target_values__update__tenant ON anatomic.assay_target_values FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY cs_cancel_reasons__select__tenant ON anatomic.cs_cancel_reasons FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY cs_cancel_reasons__insert__tenant ON anatomic.cs_cancel_reasons FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY cs_cancel_reasons__update__tenant ON anatomic.cs_cancel_reasons FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY cs_diagnoses__select__tenant ON anatomic.cs_diagnoses FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY cs_diagnoses__insert__tenant ON anatomic.cs_diagnoses FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY cs_diagnoses__update__tenant ON anatomic.cs_diagnoses FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY cs_cytology_adequacy__select__tenant ON anatomic.cs_cytology_adequacy FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY cs_cytology_adequacy__insert__tenant ON anatomic.cs_cytology_adequacy FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY cs_cytology_adequacy__update__tenant ON anatomic.cs_cytology_adequacy FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY synoptic_templates__select__tenant ON anatomic.synoptic_templates FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY synoptic_templates__insert__tenant ON anatomic.synoptic_templates FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY synoptic_templates__update__tenant ON anatomic.synoptic_templates FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY text_templates__select__tenant ON anatomic.text_templates FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY text_templates__insert__tenant ON anatomic.text_templates FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY text_templates__update__tenant ON anatomic.text_templates FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY batches__select__tenant ON anatomic.batches FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY batches__insert__tenant ON anatomic.batches FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY batches__update__tenant ON anatomic.batches FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY batch_members__select__tenant ON anatomic.batch_members FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY batch_members__insert__tenant ON anatomic.batch_members FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY batch_members__update__tenant ON anatomic.batch_members FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));

-- ===================== grants (§7; no DELETE anywhere) =====================
GRANT SELECT, INSERT, UPDATE ON anatomic.cases TO lims_app;
GRANT SELECT, INSERT, UPDATE ON anatomic.case_items TO lims_app;
GRANT SELECT, INSERT, UPDATE ON anatomic.specimen_links TO lims_app;
GRANT SELECT, INSERT, UPDATE ON anatomic.parts TO lims_app;
GRANT SELECT, INSERT, UPDATE ON anatomic.gross_records TO lims_app;
GRANT SELECT, INSERT, UPDATE ON anatomic.blocks TO lims_app;
GRANT SELECT, INSERT, UPDATE ON anatomic.slides TO lims_app;
GRANT SELECT, INSERT, UPDATE ON anatomic.stain_orders TO lims_app;
GRANT SELECT, INSERT, UPDATE ON anatomic.images TO lims_app;
GRANT SELECT, INSERT, UPDATE ON anatomic.report_drafts TO lims_app;
GRANT SELECT, INSERT, UPDATE ON anatomic.addenda TO lims_app;
GRANT SELECT, INSERT, UPDATE ON anatomic.molecular_results TO lims_app;
GRANT SELECT, INSERT ON anatomic.case_transitions TO lims_app;
GRANT SELECT, INSERT ON anatomic.object_movements TO lims_app;
GRANT SELECT, INSERT ON anatomic.report_versions TO lims_app;
GRANT SELECT, INSERT ON anatomic.item_submissions TO lims_app;
GRANT SELECT, INSERT, UPDATE ON anatomic.settings TO lims_app;
GRANT SELECT, INSERT, UPDATE ON anatomic.accession_counters TO lims_app;
GRANT SELECT, INSERT, UPDATE ON anatomic.test_profiles TO lims_app;
GRANT SELECT, INSERT, UPDATE ON anatomic.stains TO lims_app;
GRANT SELECT, INSERT, UPDATE ON anatomic.assays TO lims_app;
GRANT SELECT, INSERT, UPDATE ON anatomic.assay_targets TO lims_app;
GRANT SELECT, INSERT, UPDATE ON anatomic.assay_target_values TO lims_app;
GRANT SELECT, INSERT, UPDATE ON anatomic.cs_cancel_reasons TO lims_app;
GRANT SELECT, INSERT, UPDATE ON anatomic.cs_diagnoses TO lims_app;
GRANT SELECT, INSERT, UPDATE ON anatomic.cs_cytology_adequacy TO lims_app;
GRANT SELECT, INSERT, UPDATE ON anatomic.synoptic_templates TO lims_app;
GRANT SELECT, INSERT, UPDATE ON anatomic.text_templates TO lims_app;
GRANT SELECT, INSERT, UPDATE ON anatomic.batches TO lims_app;
GRANT SELECT, INSERT, UPDATE ON anatomic.batch_members TO lims_app;
GRANT SELECT ON anatomic.g_cs_cancel_reasons TO lims_app;

-- ===================== row audit (§3: every M and C table) =====================
CREATE TRIGGER settings__audit AFTER INSERT OR UPDATE OR DELETE ON anatomic.settings FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER test_profiles__audit AFTER INSERT OR UPDATE OR DELETE ON anatomic.test_profiles FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER stains__audit AFTER INSERT OR UPDATE OR DELETE ON anatomic.stains FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER assays__audit AFTER INSERT OR UPDATE OR DELETE ON anatomic.assays FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER assay_targets__audit AFTER INSERT OR UPDATE OR DELETE ON anatomic.assay_targets FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER assay_target_values__audit AFTER INSERT OR UPDATE OR DELETE ON anatomic.assay_target_values FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER cs_cancel_reasons__audit AFTER INSERT OR UPDATE OR DELETE ON anatomic.cs_cancel_reasons FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER cs_diagnoses__audit AFTER INSERT OR UPDATE OR DELETE ON anatomic.cs_diagnoses FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER cs_cytology_adequacy__audit AFTER INSERT OR UPDATE OR DELETE ON anatomic.cs_cytology_adequacy FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER synoptic_templates__audit AFTER INSERT OR UPDATE OR DELETE ON anatomic.synoptic_templates FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER text_templates__audit AFTER INSERT OR UPDATE OR DELETE ON anatomic.text_templates FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER cases__audit AFTER INSERT OR UPDATE OR DELETE ON anatomic.cases FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER case_items__audit AFTER INSERT OR UPDATE OR DELETE ON anatomic.case_items FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER specimen_links__audit AFTER INSERT OR UPDATE OR DELETE ON anatomic.specimen_links FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER parts__audit AFTER INSERT OR UPDATE OR DELETE ON anatomic.parts FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER gross_records__audit AFTER INSERT OR UPDATE OR DELETE ON anatomic.gross_records FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER blocks__audit AFTER INSERT OR UPDATE OR DELETE ON anatomic.blocks FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER slides__audit AFTER INSERT OR UPDATE OR DELETE ON anatomic.slides FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER stain_orders__audit AFTER INSERT OR UPDATE OR DELETE ON anatomic.stain_orders FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER images__audit AFTER INSERT OR UPDATE OR DELETE ON anatomic.images FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER report_drafts__audit AFTER INSERT OR UPDATE OR DELETE ON anatomic.report_drafts FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER addenda__audit AFTER INSERT OR UPDATE OR DELETE ON anatomic.addenda FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER molecular_results__audit AFTER INSERT OR UPDATE OR DELETE ON anatomic.molecular_results FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER batches__audit AFTER INSERT OR UPDATE OR DELETE ON anatomic.batches FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER batch_members__audit AFTER INSERT OR UPDATE OR DELETE ON anatomic.batch_members FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();

-- ===================== §2.2 global seed =====================
INSERT INTO anatomic.g_cs_cancel_reasons (id, code, display, sort_order, is_active) VALUES
  ('019a0000-c011-7000-8001-000000000001', 'duplicate_case', 'Duplicate case', 10, true),
  ('019a0000-c011-7000-8001-000000000002', 'entered_in_error', 'Entered in error', 20, true),
  ('019a0000-c011-7000-8001-000000000003', 'specimen_not_received', 'Specimen not received', 30, true),
  ('019a0000-c011-7000-8001-000000000004', 'order_cancelled', 'Order cancelled', 40, true),
  ('019a0000-c011-7000-8001-000000000005', 'other', 'Other', 50, true);
