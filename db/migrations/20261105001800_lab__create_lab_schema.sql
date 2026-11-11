-- T0B-10.C5: lab schema — C5 05-SCHEMA §3 verbatim (the six LIKE … INCLUDING ALL copies written out), then §3.1 RLS/policies/grants
-- as literal statements (the spec DO block expanded; staff guard added per 08 A17 P-16 / check-registry), row-audit triggers on the
-- class C/M tables (§3.1 note; class A and g_* not audited), and the §4 v_pub_* views (03-IC §6.3). Policies are copied 1:1 to
-- db/policies/lab.sql (AC-0B-2.3). g_* seed rows (§2/§9) belong to db/seeds. lab.event_inbox is C0's (T0B-05).
SET LOCAL ROLE lims_owner;

-- =====================================================================
-- Schema lab — C5. Owner lims_owner. All ids UUIDv7 from app code (04 D9).
-- =====================================================================
CREATE SCHEMA IF NOT EXISTS lab AUTHORIZATION lims_owner;

-- ---------- Global coded sets (class G, no tenant_id, no RLS) ----------
CREATE TABLE lab.g_cs_rejection_reasons (
  id uuid NOT NULL, code text NOT NULL, display text NOT NULL,
  system text NOT NULL DEFAULT 'lims', system_version text NOT NULL DEFAULT '1',
  sort_order integer NOT NULL DEFAULT 0, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT g_cs_rejection_reasons__pk PRIMARY KEY (id),
  CONSTRAINT g_cs_rejection_reasons__code__uq UNIQUE (code),
  CONSTRAINT g_cs_rejection_reasons__code__ck CHECK (code ~ '^[a-z0-9_]{1,64}$'),
  CONSTRAINT g_cs_rejection_reasons__display__ck CHECK (char_length(display) BETWEEN 1 AND 120)
);
CREATE TABLE lab.g_cs_return_reasons (
  id uuid NOT NULL, code text NOT NULL, display text NOT NULL,
  system text NOT NULL DEFAULT 'lims', system_version text NOT NULL DEFAULT '1',
  sort_order integer NOT NULL DEFAULT 0, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT g_cs_return_reasons__pk PRIMARY KEY (id),
  CONSTRAINT g_cs_return_reasons__code__uq UNIQUE (code),
  CONSTRAINT g_cs_return_reasons__code__ck CHECK (code ~ '^[a-z0-9_]{1,64}$'),
  CONSTRAINT g_cs_return_reasons__display__ck CHECK (char_length(display) BETWEEN 1 AND 120)
);
CREATE TABLE lab.g_cs_amendment_reasons (
  id uuid NOT NULL, code text NOT NULL, display text NOT NULL,
  system text NOT NULL DEFAULT 'lims', system_version text NOT NULL DEFAULT '1',
  sort_order integer NOT NULL DEFAULT 0, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT g_cs_amendment_reasons__pk PRIMARY KEY (id),
  CONSTRAINT g_cs_amendment_reasons__code__uq UNIQUE (code),
  CONSTRAINT g_cs_amendment_reasons__code__ck CHECK (code ~ '^[a-z0-9_]{1,64}$'),
  CONSTRAINT g_cs_amendment_reasons__display__ck CHECK (char_length(display) BETWEEN 1 AND 120)
);
CREATE TABLE lab.g_cs_exception_discard_reasons (
  id uuid NOT NULL, code text NOT NULL, display text NOT NULL,
  system text NOT NULL DEFAULT 'lims', system_version text NOT NULL DEFAULT '1',
  sort_order integer NOT NULL DEFAULT 0, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT g_cs_exception_discard_reasons__pk PRIMARY KEY (id),
  CONSTRAINT g_cs_exception_discard_reasons__code__uq UNIQUE (code),
  CONSTRAINT g_cs_exception_discard_reasons__code__ck CHECK (code ~ '^[a-z0-9_]{1,64}$'),
  CONSTRAINT g_cs_exception_discard_reasons__display__ck CHECK (char_length(display) BETWEEN 1 AND 120)
);
-- (C0: the spec's LIKE … INCLUDING ALL copies are written out with the 02-CV §3 constraint names [CONV].)

-- ---------- Tenant coded sets (class M) ----------
CREATE TABLE lab.cs_rejection_reasons (
  id uuid NOT NULL, tenant_id uuid NOT NULL,
  code text NOT NULL, display text NOT NULL,
  system text NOT NULL DEFAULT 'tenant', system_version text NOT NULL DEFAULT '1',
  sort_order integer NOT NULL DEFAULT 0,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT cs_rejection_reasons__pk PRIMARY KEY (id),
  CONSTRAINT cs_rejection_reasons__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT cs_rejection_reasons__tenant_id_code__uq UNIQUE (tenant_id, code),
  CONSTRAINT cs_rejection_reasons__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT cs_rejection_reasons__code__ck CHECK (code ~ '^[a-z0-9_]{1,64}$'),
  CONSTRAINT cs_rejection_reasons__display__ck CHECK (char_length(display) BETWEEN 1 AND 120)
);
CREATE TABLE lab.cs_return_reasons (
  id uuid NOT NULL, tenant_id uuid NOT NULL,
  code text NOT NULL, display text NOT NULL,
  system text NOT NULL DEFAULT 'tenant', system_version text NOT NULL DEFAULT '1',
  sort_order integer NOT NULL DEFAULT 0,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT cs_return_reasons__pk PRIMARY KEY (id),
  CONSTRAINT cs_return_reasons__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT cs_return_reasons__tenant_id_code__uq UNIQUE (tenant_id, code),
  CONSTRAINT cs_return_reasons__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT cs_return_reasons__code__ck CHECK (code ~ '^[a-z0-9_]{1,64}$'),
  CONSTRAINT cs_return_reasons__display__ck CHECK (char_length(display) BETWEEN 1 AND 120)
);
CREATE TABLE lab.cs_amendment_reasons (
  id uuid NOT NULL, tenant_id uuid NOT NULL,
  code text NOT NULL, display text NOT NULL,
  system text NOT NULL DEFAULT 'tenant', system_version text NOT NULL DEFAULT '1',
  sort_order integer NOT NULL DEFAULT 0,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT cs_amendment_reasons__pk PRIMARY KEY (id),
  CONSTRAINT cs_amendment_reasons__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT cs_amendment_reasons__tenant_id_code__uq UNIQUE (tenant_id, code),
  CONSTRAINT cs_amendment_reasons__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT cs_amendment_reasons__code__ck CHECK (code ~ '^[a-z0-9_]{1,64}$'),
  CONSTRAINT cs_amendment_reasons__display__ck CHECK (char_length(display) BETWEEN 1 AND 120)
);
CREATE TABLE lab.cs_exception_discard_reasons (
  id uuid NOT NULL, tenant_id uuid NOT NULL,
  code text NOT NULL, display text NOT NULL,
  system text NOT NULL DEFAULT 'tenant', system_version text NOT NULL DEFAULT '1',
  sort_order integer NOT NULL DEFAULT 0,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT cs_exception_discard_reasons__pk PRIMARY KEY (id),
  CONSTRAINT cs_exception_discard_reasons__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT cs_exception_discard_reasons__tenant_id_code__uq UNIQUE (tenant_id, code),
  CONSTRAINT cs_exception_discard_reasons__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT cs_exception_discard_reasons__code__ck CHECK (code ~ '^[a-z0-9_]{1,64}$'),
  CONSTRAINT cs_exception_discard_reasons__display__ck CHECK (char_length(display) BETWEEN 1 AND 120)
);
-- (C0: written out explicitly, constraint names per 02-CV §3, tenant FK included [CONV].)

-- Effective set view (internal): tenant rows shadow global rows by code
CREATE VIEW lab.v_rejection_reasons WITH (security_invoker = true) AS
SELECT t.tenant_id, t.code, t.display, t.sort_order, t.is_active, 'tenant'::text AS source
FROM lab.cs_rejection_reasons t
UNION ALL
SELECT tn.id AS tenant_id, g.code, g.display, g.sort_order, g.is_active, 'global'::text
FROM lab.g_cs_rejection_reasons g CROSS JOIN core.tenants tn
WHERE tn.id = (SELECT app.current_tenant_id())
  AND NOT EXISTS (SELECT 1 FROM lab.cs_rejection_reasons t
                  WHERE t.tenant_id = tn.id AND t.code = g.code);
-- Same pattern for the other three sets (written out, final sweep 2026-11-06):
CREATE VIEW lab.v_return_reasons WITH (security_invoker = true) AS
SELECT t.tenant_id, t.code, t.display, t.sort_order, t.is_active, 'tenant'::text AS source
FROM lab.cs_return_reasons t
UNION ALL
SELECT tn.id AS tenant_id, g.code, g.display, g.sort_order, g.is_active, 'global'::text
FROM lab.g_cs_return_reasons g CROSS JOIN core.tenants tn
WHERE tn.id = (SELECT app.current_tenant_id())
  AND NOT EXISTS (SELECT 1 FROM lab.cs_return_reasons t
                  WHERE t.tenant_id = tn.id AND t.code = g.code);
CREATE VIEW lab.v_amendment_reasons WITH (security_invoker = true) AS
SELECT t.tenant_id, t.code, t.display, t.sort_order, t.is_active, 'tenant'::text AS source
FROM lab.cs_amendment_reasons t
UNION ALL
SELECT tn.id AS tenant_id, g.code, g.display, g.sort_order, g.is_active, 'global'::text
FROM lab.g_cs_amendment_reasons g CROSS JOIN core.tenants tn
WHERE tn.id = (SELECT app.current_tenant_id())
  AND NOT EXISTS (SELECT 1 FROM lab.cs_amendment_reasons t
                  WHERE t.tenant_id = tn.id AND t.code = g.code);
CREATE VIEW lab.v_exception_discard_reasons WITH (security_invoker = true) AS
SELECT t.tenant_id, t.code, t.display, t.sort_order, t.is_active, 'tenant'::text AS source
FROM lab.cs_exception_discard_reasons t
UNION ALL
SELECT tn.id AS tenant_id, g.code, g.display, g.sort_order, g.is_active, 'global'::text
FROM lab.g_cs_exception_discard_reasons g CROSS JOIN core.tenants tn
WHERE tn.id = (SELECT app.current_tenant_id())
  AND NOT EXISTS (SELECT 1 FROM lab.cs_exception_discard_reasons t
                  WHERE t.tenant_id = tn.id AND t.code = g.code);

-- ---------- Settings (class M) ----------
CREATE TABLE lab.lab_settings (
  tenant_id uuid NOT NULL,
  label_width_mm integer NOT NULL DEFAULT 50,
  label_height_mm integer NOT NULL DEFAULT 25,
  label_copies_default integer NOT NULL DEFAULT 1,
  label_renderer text NOT NULL DEFAULT 'html_svg',
  -- auto_print_labels removed (08 A13 D-4: C4 frontdesk.label_autoprint is the only auto-print setting)
  host_query_requires_received boolean NOT NULL DEFAULT true,
  ingest_auto_receive boolean NOT NULL DEFAULT false,
  critical_notification_blocks_approval boolean NOT NULL DEFAULT true,
  recollection_default boolean NOT NULL DEFAULT true,
  delta_check_enabled boolean NOT NULL DEFAULT true,
  history_days integer NOT NULL DEFAULT 730,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT lab_settings__pk PRIMARY KEY (tenant_id),
  CONSTRAINT lab_settings__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT lab_settings__label_size__ck CHECK (label_width_mm BETWEEN 20 AND 100 AND label_height_mm BETWEEN 10 AND 60),
  CONSTRAINT lab_settings__copies__ck CHECK (label_copies_default BETWEEN 1 AND 5),
  CONSTRAINT lab_settings__renderer__ck CHECK (label_renderer IN ('html_svg')),
  CONSTRAINT lab_settings__history_days__ck CHECK (history_days BETWEEN 30 AND 3650)
);
-- Missing row = defaults (service reads with COALESCE to the column defaults above).

-- ---------- Barcode counter ----------
CREATE TABLE lab.barcode_counters (
  tenant_id uuid NOT NULL,
  last_value bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT barcode_counters__pk PRIMARY KEY (tenant_id),
  CONSTRAINT barcode_counters__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT barcode_counters__nonneg__ck CHECK (last_value >= 0)
);

-- ---------- Delta rules (class M, versioned rows) ----------
CREATE TABLE lab.delta_check_rules (
  id uuid NOT NULL, tenant_id uuid NOT NULL,
  rule_id uuid NOT NULL,                       -- stable id across versions
  rule_version integer NOT NULL,
  analyte_id uuid NOT NULL,                    -- catalog analyte (no FK: global/tenant catalog rows — validated via CatalogPort)
  unit_code text NOT NULL,
  window_seconds integer NOT NULL,
  abs_threshold numeric,
  pct_threshold numeric,
  effective_from timestamptz NOT NULL,
  effective_to timestamptz,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT delta_check_rules__pk PRIMARY KEY (id),
  CONSTRAINT delta_check_rules__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT delta_check_rules__rule_version__uq UNIQUE (tenant_id, rule_id, rule_version),
  CONSTRAINT delta_check_rules__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT delta_check_rules__window__ck CHECK (window_seconds BETWEEN 3600 AND 31536000),
  CONSTRAINT delta_check_rules__threshold__ck CHECK (abs_threshold IS NOT NULL OR pct_threshold IS NOT NULL),
  CONSTRAINT delta_check_rules__abs__ck CHECK (abs_threshold IS NULL OR abs_threshold > 0),
  CONSTRAINT delta_check_rules__pct__ck CHECK (pct_threshold IS NULL OR (pct_threshold > 0 AND pct_threshold <= 1000)),
  CONSTRAINT delta_check_rules__effective__ck CHECK (effective_to IS NULL OR effective_to > effective_from)
);
CREATE UNIQUE INDEX delta_check_rules__tenant_id_analyte__p_uq ON lab.delta_check_rules (tenant_id, analyte_id)
  WHERE effective_to IS NULL AND is_active;
CREATE INDEX delta_check_rules__tenant_id_analyte_from__idx ON lab.delta_check_rules (tenant_id, analyte_id, effective_from DESC);

-- ---------- Orders (lab read model, class C) ----------
CREATE TABLE lab.orders (
  id uuid NOT NULL,                            -- = frontdesk.orders.id
  tenant_id uuid NOT NULL,
  centre_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  patient_id uuid NOT NULL,
  registration_no text NOT NULL,
  visit_type text NOT NULL,
  priority text NOT NULL,
  referrer_id uuid,
  collection_mode text,                        -- NULL when the row was built from getOrderSummary (out-of-order events, 03-APP-FLOW E2/E3); filled by order.created
  source text NOT NULL,
  registered_at timestamptz NOT NULL,
  patient_sex text NOT NULL,
  patient_age_days integer,
  lab_status text NOT NULL DEFAULT 'active',
  last_order_seq integer NOT NULL,
  items_version integer NOT NULL DEFAULT 1,
  cancelled_at timestamptz,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT orders__pk PRIMARY KEY (id),
  CONSTRAINT orders__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT orders__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT orders__frontdesk_order__fk FOREIGN KEY (tenant_id, id) REFERENCES frontdesk.orders (tenant_id, id),
  CONSTRAINT orders__patient__fk FOREIGN KEY (tenant_id, patient_id) REFERENCES frontdesk.patients (tenant_id, id),
  CONSTRAINT orders__centre__fk FOREIGN KEY (tenant_id, centre_id) REFERENCES core.collection_centres (tenant_id, id),
  CONSTRAINT orders__branch__fk FOREIGN KEY (tenant_id, branch_id) REFERENCES core.branches (tenant_id, id),
  CONSTRAINT orders__visit_type__ck CHECK (visit_type IN ('opd','ipd')),
  CONSTRAINT orders__priority__ck CHECK (priority IN ('routine','urgent')),
  CONSTRAINT orders__collection_mode__ck CHECK (collection_mode IS NULL OR collection_mode IN ('walk_in','home','centre','partner')),
  CONSTRAINT orders__source__ck CHECK (source IN ('front_desk','engagement_booking','home_collection','partner_manifest')),
  CONSTRAINT orders__sex__ck CHECK (patient_sex IN ('male','female','other','unknown')),
  CONSTRAINT orders__lab_status__ck CHECK (lab_status IN ('active','cancelled')),
  CONSTRAINT orders__age__ck CHECK (patient_age_days IS NULL OR patient_age_days BETWEEN 0 AND 60000),
  CONSTRAINT orders__registration_no__ck CHECK (char_length(registration_no) BETWEEN 1 AND 40)
);
CREATE INDEX orders__tenant_id_centre_registered__idx ON lab.orders (tenant_id, centre_id, registered_at DESC);
CREATE INDEX orders__tenant_id_registered__idx ON lab.orders (tenant_id, registered_at DESC);
CREATE INDEX orders__tenant_id_patient__idx ON lab.orders (tenant_id, patient_id);
CREATE INDEX orders__tenant_id_registration_no__idx ON lab.orders (tenant_id, registration_no);   -- lookup by registration no (02-TRD #1)

-- ---------- Specimens (class C) ----------
CREATE TABLE lab.specimens (
  id uuid NOT NULL, tenant_id uuid NOT NULL,
  centre_id uuid NOT NULL,                     -- order's collection centre
  processing_centre_id uuid,                   -- set at receive (S4)
  processing_branch_id uuid,                   -- branch of processing_centre_id
  order_id uuid NOT NULL,
  patient_id uuid NOT NULL,
  barcode text NOT NULL,
  creation_key text NOT NULL,                  -- idempotent creation (03-APP-FLOW E2)
  specimen_type_code text NOT NULL,
  container_code text,
  priority text NOT NULL,
  patient_sex text NOT NULL,                   -- snapshot for host query (device RLS cannot read lab.orders of other centres)
  patient_age_days integer,
  status text NOT NULL,
  parent_specimen_id uuid,
  replaces_specimen_id uuid,
  ordered_at timestamptz NOT NULL,
  collected_at timestamptz,
  collected_at_device timestamptz,
  collected_by_membership_id uuid,
  collected_via_visit_id uuid,
  collection_barcode_unverified boolean NOT NULL DEFAULT false,
  in_transit_at timestamptz,
  received_at timestamptz,
  received_by_membership_id uuid,
  in_process_at timestamptz,
  first_resulted_at timestamptz,
  first_verified_at timestamptz,
  all_approved_at timestamptz,
  reported_at timestamptz,
  rejected_at timestamptz,
  rejection_reason_code text,
  rejection_comment text,
  rejected_by_membership_id uuid,
  recollection_ordered_at timestamptz,
  stored_at timestamptz,
  storage_location text,
  discarded_at timestamptz,
  discard_reason text,
  label_print_count integer NOT NULL DEFAULT 0,
  last_label_printed_at timestamptz,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT specimens__pk PRIMARY KEY (id),
  CONSTRAINT specimens__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT specimens__tenant_id_barcode__uq UNIQUE (tenant_id, barcode),
  CONSTRAINT specimens__tenant_id_creation_key__uq UNIQUE (tenant_id, creation_key),
  CONSTRAINT specimens__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT specimens__centre__fk FOREIGN KEY (tenant_id, centre_id) REFERENCES core.collection_centres (tenant_id, id),
  CONSTRAINT specimens__processing_centre__fk FOREIGN KEY (tenant_id, processing_centre_id) REFERENCES core.collection_centres (tenant_id, id),
  CONSTRAINT specimens__processing_branch__fk FOREIGN KEY (tenant_id, processing_branch_id) REFERENCES core.branches (tenant_id, id),
  CONSTRAINT specimens__order__fk FOREIGN KEY (tenant_id, order_id) REFERENCES lab.orders (tenant_id, id),
  CONSTRAINT specimens__patient__fk FOREIGN KEY (tenant_id, patient_id) REFERENCES frontdesk.patients (tenant_id, id),
  CONSTRAINT specimens__parent__fk FOREIGN KEY (tenant_id, parent_specimen_id) REFERENCES lab.specimens (tenant_id, id),
  CONSTRAINT specimens__replaces__fk FOREIGN KEY (tenant_id, replaces_specimen_id) REFERENCES lab.specimens (tenant_id, id),
  CONSTRAINT specimens__barcode__ck CHECK (barcode ~ '^[A-Z0-9]{1,20}$'),
  CONSTRAINT specimens__priority__ck CHECK (priority IN ('routine','urgent')),
  CONSTRAINT specimens__sex__ck CHECK (patient_sex IN ('male','female','other','unknown')),
  CONSTRAINT specimens__status__ck CHECK (status IN ('ordered','collected','in_transit','received','aliquoted',
             'in_process','resulted','verified','approved','reported','rejected','recollection_ordered','stored','discarded')),
  CONSTRAINT specimens__received_has_centre__ck CHECK (received_at IS NULL OR processing_centre_id IS NOT NULL),
  CONSTRAINT specimens__rejected_has_reason__ck CHECK (rejected_at IS NULL OR rejection_reason_code IS NOT NULL),
  CONSTRAINT specimens__rejection_comment__ck CHECK (rejection_comment IS NULL OR char_length(rejection_comment) <= 500),
  CONSTRAINT specimens__storage_location__ck CHECK (storage_location IS NULL OR char_length(storage_location) <= 120),
  CONSTRAINT specimens__discard_reason__ck CHECK (discard_reason IS NULL OR char_length(discard_reason) <= 200),
  CONSTRAINT specimens__not_self_parent__ck CHECK (parent_specimen_id IS NULL OR parent_specimen_id <> id),
  CONSTRAINT specimens__label_count__ck CHECK (label_print_count >= 0)
);
CREATE INDEX specimens__tenant_id_order__idx ON lab.specimens (tenant_id, order_id);
CREATE INDEX specimens__tenant_id_created__idx ON lab.specimens (tenant_id, created_at DESC);   -- listSpecimens sort=-created_at (#2)
CREATE INDEX specimens__tenant_id_status__p_idx ON lab.specimens (tenant_id, status, received_at)
  WHERE status IN ('received','aliquoted','in_process','resulted','verified');
CREATE INDEX specimens__tenant_id_centre_collect__p_idx ON lab.specimens (tenant_id, centre_id, status, ordered_at)
  WHERE status IN ('ordered','collected','in_transit') AND is_active;
CREATE INDEX specimens__tenant_id_replaces__idx ON lab.specimens (tenant_id, replaces_specimen_id) WHERE replaces_specimen_id IS NOT NULL;
CREATE INDEX specimens__tenant_id_parent__idx ON lab.specimens (tenant_id, parent_specimen_id) WHERE parent_specimen_id IS NOT NULL;
CREATE INDEX specimens__tenant_id_rejected__p_idx ON lab.specimens (tenant_id, rejected_at) WHERE rejected_at IS NOT NULL;

CREATE TRIGGER specimens__mutable_columns BEFORE UPDATE ON lab.specimens
  FOR EACH ROW EXECUTE FUNCTION app.enforce_mutable_columns(
    'processing_centre_id','processing_branch_id','status','collected_at','collected_at_device',
    'collected_by_membership_id','collected_via_visit_id','collection_barcode_unverified','in_transit_at',
    'received_at','received_by_membership_id','in_process_at','first_resulted_at','first_verified_at',
    'all_approved_at','reported_at','rejected_at','rejection_reason_code','rejection_comment',
    'rejected_by_membership_id','recollection_ordered_at','stored_at','storage_location','discarded_at',
    'discard_reason','label_print_count','last_label_printed_at','is_active','updated_at','updated_by','version');
-- Frozen after insert: id, tenant_id, centre_id, order_id, patient_id, barcode, creation_key, specimen_type_code,
-- container_code, priority, patient_sex, patient_age_days, parent_specimen_id, replaces_specimen_id, ordered_at, created_*.

-- ---------- Specimen transitions (class A) ----------
CREATE TABLE lab.specimen_transitions (
  id uuid NOT NULL, tenant_id uuid NOT NULL,
  centre_id uuid NOT NULL, processing_centre_id uuid,
  specimen_id uuid NOT NULL,
  transition_code text NOT NULL,
  from_status text,
  to_status text NOT NULL,
  specimen_version integer NOT NULL,
  occurred_at timestamptz NOT NULL,
  actor_type text NOT NULL,
  actor_id uuid NOT NULL,
  membership_id uuid,
  reason_code text,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  CONSTRAINT specimen_transitions__pk PRIMARY KEY (id),
  CONSTRAINT specimen_transitions__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT specimen_transitions__specimen__fk FOREIGN KEY (tenant_id, specimen_id) REFERENCES lab.specimens (tenant_id, id),
  CONSTRAINT specimen_transitions__code__ck CHECK (transition_code ~ '^S([1-9]|1[0-5])$'),
  CONSTRAINT specimen_transitions__actor_type__ck CHECK (actor_type IN ('user','system','device')),
  CONSTRAINT specimen_transitions__seq__uq UNIQUE (tenant_id, specimen_id, specimen_version)
);
CREATE INDEX specimen_transitions__tenant_id_specimen__idx ON lab.specimen_transitions (tenant_id, specimen_id, occurred_at);

-- ---------- Order tests (class C) ----------
CREATE TABLE lab.order_tests (
  id uuid NOT NULL, tenant_id uuid NOT NULL,
  centre_id uuid NOT NULL, processing_centre_id uuid, processing_branch_id uuid,
  order_id uuid NOT NULL,
  order_item_id uuid NOT NULL,
  test_id uuid NOT NULL,                       -- catalog test (no FK; see delta rules note)
  test_code text NOT NULL,
  test_revision integer NOT NULL,
  catalog_revision integer NOT NULL,
  department_id uuid NOT NULL,
  workflow_type text NOT NULL,
  priority text NOT NULL,
  specimen_id uuid,                            -- NULL until assigned, and always NULL when uses_existing_material
  uses_existing_material boolean NOT NULL DEFAULT false,   -- CR-C11-009: add-on test on existing material, no specimen requirement
  status text NOT NULL,
  approved_at timestamptz,                     -- set when status becomes 'approved' (v_pub_result_daily.tests_approved, CR-C8-004)
  reported_at timestamptz,                     -- set by the reporting.report.released.v1 consumer when a release covers this test's item
                                               -- (feeds LabPort.getOrderItemProcessingState 'reported', 08 A13 D-5) [CONV: column, because
                                               -- existing-material tests have no specimen to carry S10]
  tat_target_seconds integer,
  ordered_at timestamptz NOT NULL,
  received_at timestamptz,
  cancelled_at timestamptz,
  cancel_reason text,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT order_tests__pk PRIMARY KEY (id),
  CONSTRAINT order_tests__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT order_tests__item_test__uq UNIQUE (tenant_id, order_item_id, test_id),
  CONSTRAINT order_tests__order__fk FOREIGN KEY (tenant_id, order_id) REFERENCES lab.orders (tenant_id, id),
  CONSTRAINT order_tests__order_item__fk FOREIGN KEY (tenant_id, order_item_id) REFERENCES frontdesk.order_items (tenant_id, id),
  CONSTRAINT order_tests__specimen__fk FOREIGN KEY (tenant_id, specimen_id) REFERENCES lab.specimens (tenant_id, id),
  CONSTRAINT order_tests__centre__fk FOREIGN KEY (tenant_id, centre_id) REFERENCES core.collection_centres (tenant_id, id),
  CONSTRAINT order_tests__processing_centre__fk FOREIGN KEY (tenant_id, processing_centre_id) REFERENCES core.collection_centres (tenant_id, id),
  CONSTRAINT order_tests__processing_branch__fk FOREIGN KEY (tenant_id, processing_branch_id) REFERENCES core.branches (tenant_id, id),
  CONSTRAINT order_tests__workflow__ck CHECK (workflow_type IN ('standard','narrative','microbiology','anatomic','molecular','attachment','outsourced')),
  CONSTRAINT order_tests__priority__ck CHECK (priority IN ('routine','urgent')),
  CONSTRAINT order_tests__status__ck CHECK (status IN ('awaiting_collection','awaiting_receipt','in_process','resulted',
             'verified','approved','cancelled','excluded','outsourced')),
  CONSTRAINT order_tests__tat__ck CHECK (tat_target_seconds IS NULL OR tat_target_seconds > 0),
  CONSTRAINT order_tests__existing_material__ck CHECK (NOT uses_existing_material OR specimen_id IS NULL)
);
CREATE INDEX order_tests__tenant_id_worklist__p_idx ON lab.order_tests (tenant_id, department_id, status, priority, received_at)
  WHERE status IN ('in_process','resulted','verified');
CREATE INDEX order_tests__tenant_id_pending__p_idx ON lab.order_tests (tenant_id, status, ordered_at)
  WHERE status IN ('awaiting_collection','awaiting_receipt','in_process','resulted','verified');
CREATE INDEX order_tests__tenant_id_order__idx ON lab.order_tests (tenant_id, order_id);
CREATE INDEX order_tests__tenant_id_specimen__idx ON lab.order_tests (tenant_id, specimen_id);

-- ---------- QC holds (class C) — before results (FK target) ----------
CREATE TABLE lab.qc_holds (
  id uuid NOT NULL, tenant_id uuid NOT NULL,
  qc_run_id uuid NOT NULL,
  instrument_id uuid NOT NULL,                 -- instruments schema is downstream of lab (01 §5 R3): no FK
  analyte_ids uuid[] NOT NULL,
  since timestamptz NOT NULL,
  reason_code text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  held_result_ids uuid[] NOT NULL DEFAULT '{}',
  review_flagged_result_ids uuid[] NOT NULL DEFAULT '{}',
  released_at timestamptz, released_by_membership_id uuid, release_comment text,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT qc_holds__pk PRIMARY KEY (id),
  CONSTRAINT qc_holds__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT qc_holds__qc_run__uq UNIQUE (tenant_id, qc_run_id),
  CONSTRAINT qc_holds__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT qc_holds__status__ck CHECK (status IN ('active','released')),
  CONSTRAINT qc_holds__analytes__ck CHECK (cardinality(analyte_ids) BETWEEN 1 AND 100),
  CONSTRAINT qc_holds__release__ck CHECK ((status = 'released') = (released_at IS NOT NULL))
);
CREATE INDEX qc_holds__tenant_id_instrument_active__p_idx ON lab.qc_holds (tenant_id, instrument_id) WHERE status = 'active';

-- ---------- Results (class C, lock trigger) ----------
CREATE TABLE lab.results (
  id uuid NOT NULL, tenant_id uuid NOT NULL,
  centre_id uuid NOT NULL, processing_centre_id uuid, processing_branch_id uuid,
  order_id uuid NOT NULL,
  order_item_id uuid NOT NULL,
  order_test_id uuid NOT NULL,
  specimen_id uuid,                            -- NULL only for results of a uses_existing_material order test (CR-C11-009)
  patient_id uuid NOT NULL,
  test_id uuid NOT NULL,
  analyte_id uuid NOT NULL,
  analyte_code text NOT NULL,
  department_id uuid NOT NULL,
  is_reportable boolean NOT NULL,
  result_type text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  origin text,
  value_numeric numeric,
  value_text text,
  ordinal_code text,
  unit_code text,
  manual_abnormal boolean NOT NULL DEFAULT false,
  flag text,
  ref_range_id uuid, ref_range_version integer, ref_low numeric, ref_high numeric, ref_text text, ref_unit_code text,
  range_unavailable_age_unknown boolean NOT NULL DEFAULT false,   -- 08 A17.1: age unknown and no age-unrestricted range/critical band; never auto-verified
  delta_status text NOT NULL DEFAULT 'not_applicable',
  delta_rule_id uuid, delta_rule_version integer, delta_prev_result_id uuid, delta_prev_value numeric,
  delta_prev_at timestamptz, delta_abs numeric, delta_pct numeric,
  is_critical boolean NOT NULL DEFAULT false,
  critical_event_id uuid,                       -- no FK (circular with critical_value_log); integrity by service + test
  calc_status text NOT NULL DEFAULT 'not_applicable',
  calc_reason text,
  formula_provenance jsonb,
  comment_codes text[] NOT NULL DEFAULT '{}',
  comment_lib_versions jsonb,
  comment_text text,
  unit_mismatch boolean NOT NULL DEFAULT false,
  instrument_id uuid,
  instrument_flags text[] NOT NULL DEFAULT '{}',
  instrument_result_time timestamptz,
  on_hold boolean NOT NULL DEFAULT false,
  hold_id uuid,
  qc_review_required boolean NOT NULL DEFAULT false,
  module_payload_module text, module_payload_entity_id uuid, module_payload_version_no integer,
  module_report_phase text, module_summary_text text, module_flag text,
  current_version_no integer NOT NULL DEFAULT 1,
  resulted_at timestamptz, first_resulted_at timestamptz,
  verified_at timestamptz, verified_by_membership_id uuid,
  approved_at timestamptz, approved_by_membership_id uuid,
  cancelled_at timestamptz, cancel_reason text,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT results__pk PRIMARY KEY (id),
  CONSTRAINT results__tenant_id_id__uq UNIQUE (tenant_id, id),
  -- (results__test_analyte__uq replaced by the partial unique index below — 08 A13 D-12)
  CONSTRAINT results__order__fk FOREIGN KEY (tenant_id, order_id) REFERENCES lab.orders (tenant_id, id),
  CONSTRAINT results__processing_centre__fk FOREIGN KEY (tenant_id, processing_centre_id) REFERENCES core.collection_centres (tenant_id, id),
  CONSTRAINT results__processing_branch__fk FOREIGN KEY (tenant_id, processing_branch_id) REFERENCES core.branches (tenant_id, id),
  CONSTRAINT results__order_test__fk FOREIGN KEY (tenant_id, order_test_id) REFERENCES lab.order_tests (tenant_id, id),
  CONSTRAINT results__specimen__fk FOREIGN KEY (tenant_id, specimen_id) REFERENCES lab.specimens (tenant_id, id),
  CONSTRAINT results__patient__fk FOREIGN KEY (tenant_id, patient_id) REFERENCES frontdesk.patients (tenant_id, id),
  CONSTRAINT results__hold__fk FOREIGN KEY (tenant_id, hold_id) REFERENCES lab.qc_holds (tenant_id, id),
  CONSTRAINT results__status__ck CHECK (status IN ('pending','resulted','verified','approved','cancelled')),
  CONSTRAINT results__origin__ck CHECK (origin IS NULL OR origin IN ('instrument','manual','calculated','module')),
  CONSTRAINT results__result_type__ck CHECK (result_type IN ('numeric','text','ordinal','coded','attachment','narrative')),
  CONSTRAINT results__flag__ck CHECK (flag IS NULL OR flag IN ('N','L','H','LL','HH','A')),
  CONSTRAINT results__delta_status__ck CHECK (delta_status IN ('not_applicable','no_rule','no_previous','pass','fail')),
  CONSTRAINT results__calc_status__ck CHECK (calc_status IN ('not_applicable','computed','waiting_for_inputs','not_computable')),
  CONSTRAINT results__value_text__ck CHECK (value_text IS NULL OR char_length(value_text) <= 2000),
  CONSTRAINT results__comment_text__ck CHECK (comment_text IS NULL OR char_length(comment_text) <= 1000),
  CONSTRAINT results__comment_codes__ck CHECK (cardinality(comment_codes) <= 10),
  CONSTRAINT results__module_summary__ck CHECK (module_summary_text IS NULL OR char_length(module_summary_text) <= 4000),
  CONSTRAINT results__module_module__ck CHECK (module_payload_module IS NULL OR module_payload_module IN ('micro','anatomic')),
  CONSTRAINT results__module_phase__ck CHECK (module_report_phase IS NULL OR module_report_phase IN ('preliminary','final')),
  CONSTRAINT results__has_value__ck CHECK (status IN ('pending','cancelled') OR origin IS NOT NULL),
  CONSTRAINT results__approved_by__ck CHECK (status <> 'approved' OR (approved_at IS NOT NULL AND approved_by_membership_id IS NOT NULL)),
  CONSTRAINT results__version_no__ck CHECK (current_version_no >= 1),
  CONSTRAINT results__specimen_or_module__ck CHECK (specimen_id IS NOT NULL OR origin IS NULL OR origin IN ('module','manual'))
);
-- One live result per (order test, analyte); a recollection inserts new pending rows while the old rows stay
-- 'cancelled' with cancel_reason = 'specimen_rejected' (08 A13 D-12; no re-pointing of result rows).
CREATE UNIQUE INDEX results__tenant_id_test_analyte__p_uq ON lab.results (tenant_id, order_test_id, analyte_id)
  WHERE status <> 'cancelled';
CREATE INDEX results__tenant_id_specimen__idx ON lab.results (tenant_id, specimen_id);
CREATE INDEX results__tenant_id_order__idx ON lab.results (tenant_id, order_id);
CREATE INDEX results__tenant_id_history__p_idx ON lab.results (tenant_id, patient_id, analyte_id, approved_at DESC)
  WHERE status = 'approved';
CREATE INDEX results__tenant_id_queue__p_idx ON lab.results (tenant_id, status, department_id, resulted_at)
  WHERE status IN ('resulted','verified');
CREATE INDEX results__tenant_id_hold__p_idx ON lab.results (tenant_id, instrument_id, analyte_id, resulted_at)
  WHERE status IN ('resulted','verified','approved') AND instrument_id IS NOT NULL;
CREATE INDEX results__tenant_id_module__p_idx ON lab.results (tenant_id, module_payload_module, module_payload_entity_id)
  WHERE module_payload_module IS NOT NULL;

-- Lock: after approval only these columns may change (03-IC §10.2; 04 R1). Before approval the generic
-- trigger is not used (values are editable via R3), status transitions are checked by the service + CHECKs.
CREATE FUNCTION lab.enforce_result_lock() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF OLD.status = 'approved' THEN
    IF NEW.status <> 'approved'
       OR (to_jsonb(OLD) - ARRAY['current_version_no','qc_review_required','updated_at','updated_by','version'])
          IS DISTINCT FROM
          (to_jsonb(NEW) - ARRAY['current_version_no','qc_review_required','updated_at','updated_by','version']) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'lab.results';
    END IF;
  ELSIF OLD.status = 'cancelled' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'lab.results';
  END IF;
  IF (OLD.tenant_id, OLD.order_id, OLD.order_item_id, OLD.order_test_id, OLD.patient_id, OLD.test_id, OLD.analyte_id)
     IS DISTINCT FROM (NEW.tenant_id, NEW.order_id, NEW.order_item_id, NEW.order_test_id, NEW.patient_id, NEW.test_id, NEW.analyte_id) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'lab.results';
  END IF;
  RETURN NEW;
END $$;
ALTER FUNCTION lab.enforce_result_lock() OWNER TO lims_owner;
CREATE TRIGGER results__lock BEFORE UPDATE ON lab.results FOR EACH ROW EXECUTE FUNCTION lab.enforce_result_lock();
-- Note: specimen_id may change before approval (aliquot re-point); cancelled rows are fully frozen.

-- ---------- Result observations (class A) ----------
CREATE TABLE lab.result_observations (
  id uuid NOT NULL, tenant_id uuid NOT NULL,
  centre_id uuid NOT NULL, processing_centre_id uuid,
  result_id uuid NOT NULL,
  source text NOT NULL,
  value_numeric numeric, value_text text, ordinal_code text, unit_code text,
  value_raw text, unit_raw text,
  instrument_id uuid, instrument_message_id uuid,
  instrument_flags text[] NOT NULL DEFAULT '{}',
  instrument_result_time timestamptz, received_at timestamptz,
  result_key text, is_rerun boolean,
  entered_by_membership_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  CONSTRAINT result_observations__pk PRIMARY KEY (id),
  CONSTRAINT result_observations__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT result_observations__result__fk FOREIGN KEY (tenant_id, result_id) REFERENCES lab.results (tenant_id, id),
  CONSTRAINT result_observations__source__ck CHECK (source IN ('instrument','manual','calculated','module')),
  CONSTRAINT result_observations__value_raw__ck CHECK (value_raw IS NULL OR char_length(value_raw) <= 200),
  CONSTRAINT result_observations__value_text__ck CHECK (value_text IS NULL OR char_length(value_text) <= 2000)
);
CREATE INDEX result_observations__tenant_id_result__idx ON lab.result_observations (tenant_id, result_id, created_at);

-- ---------- Result versions (class C, immutable except supersede columns) ----------
CREATE TABLE lab.result_versions (
  id uuid NOT NULL, tenant_id uuid NOT NULL,
  centre_id uuid NOT NULL, processing_centre_id uuid,
  result_id uuid NOT NULL,
  version_no integer NOT NULL,
  origin text NOT NULL,
  value_numeric numeric, value_text text, ordinal_code text, unit_code text, flag text,
  ref_range_id uuid, ref_range_version integer, ref_low numeric, ref_high numeric, ref_text text,
  range_unavailable_age_unknown boolean NOT NULL DEFAULT false,   -- 08 A17.1 (copied at R6; written by R7 evaluation)
  is_critical boolean NOT NULL,
  -- Evaluation outputs of this version (02-TRD §4.3): for v1 copied from the result row at approval; for an
  -- amendment (R7) written only here, because the approved lab.results row is locked (finding C5 #10).
  delta_status text NOT NULL DEFAULT 'not_applicable',
  delta_rule_id uuid, delta_rule_version integer, delta_prev_result_id uuid, delta_prev_value numeric,
  delta_prev_at timestamptz, delta_abs numeric, delta_pct numeric,
  critical_event_id uuid,                       -- no FK (same rule as results.critical_event_id; §3 FK exceptions)
  comment_codes text[] NOT NULL DEFAULT '{}', comment_lib_versions jsonb, comment_text text,
  formula_provenance jsonb,
  module_payload_module text, module_payload_entity_id uuid, module_payload_version_no integer,
  module_report_phase text, module_summary_text text,
  approved_at timestamptz NOT NULL,
  approved_by_membership_id uuid NOT NULL,
  previous_version_no integer,
  amendment_reason_code text, amendment_reason_text text,
  superseded_at timestamptz, superseded_by_version_no integer,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT result_versions__pk PRIMARY KEY (id),
  CONSTRAINT result_versions__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT result_versions__result_version__uq UNIQUE (tenant_id, result_id, version_no),
  CONSTRAINT result_versions__result__fk FOREIGN KEY (tenant_id, result_id) REFERENCES lab.results (tenant_id, id),
  CONSTRAINT result_versions__version_no__ck CHECK (version_no >= 1),
  CONSTRAINT result_versions__amend__ck CHECK (version_no = 1 OR (amendment_reason_code IS NOT NULL AND previous_version_no = version_no - 1)),
  CONSTRAINT result_versions__flag__ck CHECK (flag IS NULL OR flag IN ('N','L','H','LL','HH','A')),
  CONSTRAINT result_versions__delta_status__ck CHECK (delta_status IN ('not_applicable','no_rule','no_previous','pass','fail')),
  CONSTRAINT result_versions__origin__ck CHECK (origin IN ('instrument','manual','calculated','module')),
  CONSTRAINT result_versions__reason_text__ck CHECK (amendment_reason_text IS NULL OR char_length(amendment_reason_text) <= 500)
);
CREATE INDEX result_versions__tenant_id_approved__idx ON lab.result_versions (tenant_id, approved_at);
CREATE TRIGGER result_versions__mutable_columns BEFORE UPDATE ON lab.result_versions
  FOR EACH ROW EXECUTE FUNCTION app.enforce_mutable_columns(
    'superseded_at','superseded_by_version_no','updated_at','updated_by','version');

-- Internal current-value view (approved rows read the latest version). Mappers build ResultDto value, flag,
-- range, delta and critical fields from the cur_* columns when status = 'approved' (finding C5 #10).
CREATE VIEW lab.v_result_current WITH (security_invoker = true) AS
SELECT r.*, rv.value_numeric AS cur_value_numeric, rv.value_text AS cur_value_text,
       rv.ordinal_code AS cur_ordinal_code, rv.unit_code AS cur_unit_code, rv.flag AS cur_flag,
       rv.ref_range_id AS cur_ref_range_id, rv.ref_range_version AS cur_ref_range_version,
       rv.ref_low AS cur_ref_low, rv.ref_high AS cur_ref_high, rv.ref_text AS cur_ref_text,
       rv.range_unavailable_age_unknown AS cur_range_unavailable_age_unknown,          -- 08 A17.1
       rv.is_critical AS cur_is_critical, rv.critical_event_id AS cur_critical_event_id,
       rv.delta_status AS cur_delta_status, rv.delta_rule_id AS cur_delta_rule_id,
       rv.delta_rule_version AS cur_delta_rule_version, rv.delta_prev_result_id AS cur_delta_prev_result_id,
       rv.delta_prev_value AS cur_delta_prev_value, rv.delta_prev_at AS cur_delta_prev_at,
       rv.delta_abs AS cur_delta_abs, rv.delta_pct AS cur_delta_pct,
       rv.approved_at AS cur_approved_at
FROM lab.results r
LEFT JOIN lab.result_versions rv
  ON rv.tenant_id = r.tenant_id AND rv.result_id = r.id AND rv.version_no = r.current_version_no
  AND r.status = 'approved';

-- ---------- Result attachments (class A) ----------
CREATE TABLE lab.result_attachments (
  id uuid NOT NULL, tenant_id uuid NOT NULL,
  centre_id uuid NOT NULL, processing_centre_id uuid,
  result_id uuid NOT NULL,
  bucket text NOT NULL, object_path text NOT NULL, sha256 text NOT NULL, mime_type text NOT NULL,
  instrument_message_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  CONSTRAINT result_attachments__pk PRIMARY KEY (id),
  CONSTRAINT result_attachments__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT result_attachments__result__fk FOREIGN KEY (tenant_id, result_id) REFERENCES lab.results (tenant_id, id),
  CONSTRAINT result_attachments__mime__ck CHECK (mime_type IN ('application/pdf','image/png','image/jpeg')),
  CONSTRAINT result_attachments__sha__ck CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT result_attachments__path_tenant__ck CHECK (split_part(object_path, '/', 1) = tenant_id::text),
  CONSTRAINT result_attachments__sha__uq UNIQUE (tenant_id, result_id, sha256)
);

-- ---------- Verifications / approvals (class A) ----------
CREATE TABLE lab.verifications (
  id uuid NOT NULL, tenant_id uuid NOT NULL,
  centre_id uuid NOT NULL, processing_centre_id uuid,
  result_id uuid NOT NULL,
  kind text NOT NULL,
  mode text NOT NULL,
  result_row_version integer NOT NULL,
  acknowledged_flags text[] NOT NULL DEFAULT '{}',
  reason_code text, comment text,
  membership_id uuid,                          -- NULL only for mode auto / system return
  autoverify_rule_set_version text,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  CONSTRAINT verifications__pk PRIMARY KEY (id),
  CONSTRAINT verifications__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT verifications__result__fk FOREIGN KEY (tenant_id, result_id) REFERENCES lab.results (tenant_id, id),
  CONSTRAINT verifications__kind__ck CHECK (kind IN ('verified','returned')),
  CONSTRAINT verifications__mode__ck CHECK (mode IN ('manual','auto','system')),
  CONSTRAINT verifications__ack__ck CHECK (acknowledged_flags <@ ARRAY['delta','critical','unit_mismatch','instrument_flag']::text[]),
  CONSTRAINT verifications__return_reason__ck CHECK (kind <> 'returned' OR reason_code IS NOT NULL),
  CONSTRAINT verifications__comment__ck CHECK (comment IS NULL OR char_length(comment) <= 500)
);
CREATE INDEX verifications__tenant_id_result__idx ON lab.verifications (tenant_id, result_id, occurred_at);
CREATE INDEX verifications__tenant_id_occurred__idx ON lab.verifications (tenant_id, occurred_at);

CREATE TABLE lab.approvals (
  id uuid NOT NULL, tenant_id uuid NOT NULL,
  centre_id uuid NOT NULL, processing_centre_id uuid,
  result_id uuid NOT NULL,
  version_no integer NOT NULL,
  kind text NOT NULL,
  membership_id uuid NOT NULL,
  aal text NOT NULL,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  CONSTRAINT approvals__pk PRIMARY KEY (id),
  CONSTRAINT approvals__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT approvals__result_version__uq UNIQUE (tenant_id, result_id, version_no),
  CONSTRAINT approvals__result__fk FOREIGN KEY (tenant_id, result_id) REFERENCES lab.results (tenant_id, id),
  CONSTRAINT approvals__kind__ck CHECK (kind IN ('approval','amendment')),
  CONSTRAINT approvals__aal__ck CHECK (aal IN ('aal2'))
);
CREATE INDEX approvals__tenant_id_occurred__idx ON lab.approvals (tenant_id, occurred_at);

-- ---------- Critical values ----------
CREATE TABLE lab.critical_value_log (
  id uuid NOT NULL,                            -- = critical_event_id in lab.critical_value.detected.v1
  tenant_id uuid NOT NULL,
  centre_id uuid NOT NULL, processing_centre_id uuid,
  result_id uuid NOT NULL,
  result_version_no integer NOT NULL,
  order_id uuid NOT NULL,
  patient_id uuid NOT NULL,
  analyte_id uuid NOT NULL,
  referrer_id uuid,
  direction text NOT NULL,
  value_sha256_prefix16 text NOT NULL,
  value_numeric numeric, value_text text, ordinal_code text, unit_code text,
  critical_limit_id uuid, critical_limit_version integer, limit_low numeric, limit_high numeric,
  detected_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'open',
  first_confirmed_notification_at timestamptz,
  value_changed_after_detection boolean NOT NULL DEFAULT false,
  closed_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT critical_value_log__pk PRIMARY KEY (id),
  CONSTRAINT critical_value_log__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT critical_value_log__dedupe__uq UNIQUE (tenant_id, result_id, result_version_no, value_sha256_prefix16),
  CONSTRAINT critical_value_log__result__fk FOREIGN KEY (tenant_id, result_id) REFERENCES lab.results (tenant_id, id),
  CONSTRAINT critical_value_log__order__fk FOREIGN KEY (tenant_id, order_id) REFERENCES lab.orders (tenant_id, id),
  CONSTRAINT critical_value_log__patient__fk FOREIGN KEY (tenant_id, patient_id) REFERENCES frontdesk.patients (tenant_id, id),
  CONSTRAINT critical_value_log__direction__ck CHECK (direction IN ('low','high','abnormal')),
  CONSTRAINT critical_value_log__status__ck CHECK (status IN ('open','notified','closed')),
  CONSTRAINT critical_value_log__hash__ck CHECK (value_sha256_prefix16 ~ '^[0-9a-f]{16}$')
);
CREATE INDEX critical_value_log__tenant_id_status__idx ON lab.critical_value_log (tenant_id, status, detected_at);
CREATE INDEX critical_value_log__tenant_id_result__idx ON lab.critical_value_log (tenant_id, result_id);
CREATE INDEX critical_value_log__tenant_id_detected__idx ON lab.critical_value_log (tenant_id, detected_at);
CREATE TRIGGER critical_value_log__mutable_columns BEFORE UPDATE ON lab.critical_value_log
  FOR EACH ROW EXECUTE FUNCTION app.enforce_mutable_columns(
    'status','first_confirmed_notification_at','value_changed_after_detection','closed_at','updated_at','updated_by','version');

CREATE TABLE lab.critical_notifications (
  id uuid NOT NULL, tenant_id uuid NOT NULL,
  centre_id uuid NOT NULL, processing_centre_id uuid,
  critical_event_id uuid NOT NULL,
  notified_party_kind text NOT NULL,
  notified_party_name text NOT NULL,
  contact_method text NOT NULL,
  contact_detail text,
  notified_at timestamptz NOT NULL,
  outcome text NOT NULL,
  read_back_confirmed boolean NOT NULL,
  read_back_text text,
  comment text,
  notified_by_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  CONSTRAINT critical_notifications__pk PRIMARY KEY (id),
  CONSTRAINT critical_notifications__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT critical_notifications__event__fk FOREIGN KEY (tenant_id, critical_event_id) REFERENCES lab.critical_value_log (tenant_id, id),
  CONSTRAINT critical_notifications__party__ck CHECK (notified_party_kind IN ('referrer','clinician','ward','patient','other')),
  CONSTRAINT critical_notifications__method__ck CHECK (contact_method IN ('phone','sms','in_person','whatsapp','other')),
  CONSTRAINT critical_notifications__outcome__ck CHECK (outcome IN ('reached','not_reached','left_message')),
  CONSTRAINT critical_notifications__name__ck CHECK (char_length(notified_party_name) BETWEEN 1 AND 120),
  CONSTRAINT critical_notifications__detail__ck CHECK (contact_detail IS NULL OR char_length(contact_detail) <= 60),
  CONSTRAINT critical_notifications__readback__ck CHECK (NOT read_back_confirmed OR char_length(coalesce(read_back_text,'')) BETWEEN 1 AND 300),
  CONSTRAINT critical_notifications__comment__ck CHECK (comment IS NULL OR char_length(comment) <= 500)
);
CREATE INDEX critical_notifications__tenant_id_event__idx ON lab.critical_notifications (tenant_id, critical_event_id, notified_at);

-- ---------- Readiness and releases ----------
CREATE TABLE lab.order_readiness (
  tenant_id uuid NOT NULL, order_id uuid NOT NULL,
  readiness_seq integer NOT NULL DEFAULT 0,
  last_emitted_hash text,
  last_completeness text,
  department_hashes jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_emitted_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT order_readiness__pk PRIMARY KEY (tenant_id, order_id),
  CONSTRAINT order_readiness__order__fk FOREIGN KEY (tenant_id, order_id) REFERENCES lab.orders (tenant_id, id),
  CONSTRAINT order_readiness__hash__ck CHECK (last_emitted_hash IS NULL OR last_emitted_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT order_readiness__completeness__ck CHECK (last_completeness IS NULL OR last_completeness IN ('complete','partial'))
);

CREATE TABLE lab.report_releases (
  id uuid NOT NULL, tenant_id uuid NOT NULL,
  order_id uuid NOT NULL,
  report_id uuid NOT NULL,                     -- reporting is downstream of lab (01 §5 R3): no FK
  version_no integer NOT NULL,
  report_kind text NOT NULL,                   -- x-extensible in 03-IC §3.17: stored as received, no closed CHECK (08 A13 P-4)
  released_at timestamptz NOT NULL,
  release_basis text NOT NULL,
  order_item_ids uuid[],                       -- from the payload (CR-C5-006, accepted); NULL when the event omits it
  event_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  CONSTRAINT report_releases__pk PRIMARY KEY (id),
  CONSTRAINT report_releases__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT report_releases__report_version__uq UNIQUE (tenant_id, report_id, version_no),
  CONSTRAINT report_releases__order__fk FOREIGN KEY (tenant_id, order_id) REFERENCES lab.orders (tenant_id, id),
  CONSTRAINT report_releases__kind__ck CHECK (char_length(report_kind) BETWEEN 1 AND 32)
);
CREATE INDEX report_releases__tenant_id_order__idx ON lab.report_releases (tenant_id, order_id, released_at DESC);

-- ---------- Worksheets ----------
CREATE TABLE lab.worksheets (
  id uuid NOT NULL, tenant_id uuid NOT NULL,
  centre_id uuid NOT NULL, processing_centre_id uuid,   -- centre_id = body centre_id (in actor scope), default = processing_centre_id
                                                        -- of the first row; processing_centre_id = that of the first row (02-TRD #20)
  title text NOT NULL,
  department_id uuid, instrument_id uuid,
  item_count integer NOT NULL,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT worksheets__pk PRIMARY KEY (id),
  CONSTRAINT worksheets__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT worksheets__centre__fk FOREIGN KEY (tenant_id, centre_id) REFERENCES core.collection_centres (tenant_id, id),
  CONSTRAINT worksheets__title__ck CHECK (char_length(title) BETWEEN 1 AND 80),
  CONSTRAINT worksheets__count__ck CHECK (item_count BETWEEN 1 AND 200)
);
CREATE INDEX worksheets__tenant_id_created__idx ON lab.worksheets (tenant_id, created_at DESC);

CREATE TABLE lab.worksheet_items (
  id uuid NOT NULL, tenant_id uuid NOT NULL,
  centre_id uuid NOT NULL, processing_centre_id uuid,   -- copied from the worksheet (08 R3: snapshot holds P2)
  worksheet_id uuid NOT NULL,
  position integer NOT NULL,
  order_test_id uuid NOT NULL,
  specimen_id uuid,
  snapshot jsonb NOT NULL,                     -- barcode, registration_no, test_code, priority, received_at (P2/P3); no patient name (fetched at print)
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  CONSTRAINT worksheet_items__pk PRIMARY KEY (id),
  CONSTRAINT worksheet_items__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT worksheet_items__position__uq UNIQUE (tenant_id, worksheet_id, position),
  CONSTRAINT worksheet_items__worksheet__fk FOREIGN KEY (tenant_id, worksheet_id) REFERENCES lab.worksheets (tenant_id, id),
  CONSTRAINT worksheet_items__order_test__fk FOREIGN KEY (tenant_id, order_test_id) REFERENCES lab.order_tests (tenant_id, id),
  CONSTRAINT worksheet_items__specimen__fk FOREIGN KEY (tenant_id, specimen_id) REFERENCES lab.specimens (tenant_id, id),
  CONSTRAINT worksheet_items__centre__fk FOREIGN KEY (tenant_id, centre_id) REFERENCES core.collection_centres (tenant_id, id)
);

-- ---------- Ingest ----------
CREATE TABLE lab.ingest_log (
  id uuid NOT NULL, tenant_id uuid NOT NULL,
  centre_id uuid NOT NULL,                     -- instrument's centre (payload centre_id / centreId); 08 R3: result_key is P2
  processing_centre_id uuid,                   -- NULL at insert; set from the matched specimen when the pipeline matches one
  result_key text NOT NULL,                    -- 04 N10 result-level key (contains barcode → P2)
  first_source text NOT NULL,
  first_event_id uuid,
  last_outcome text NOT NULL,
  result_id uuid, specimen_id uuid, exception_id uuid,
  attempts integer NOT NULL DEFAULT 1,
  last_attempt_at timestamptz NOT NULL,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT ingest_log__pk PRIMARY KEY (id),
  CONSTRAINT ingest_log__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT ingest_log__key__uq UNIQUE (tenant_id, result_key),
  CONSTRAINT ingest_log__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT ingest_log__centre__fk FOREIGN KEY (tenant_id, centre_id) REFERENCES core.collection_centres (tenant_id, id),
  CONSTRAINT ingest_log__result__fk FOREIGN KEY (tenant_id, result_id) REFERENCES lab.results (tenant_id, id),
  CONSTRAINT ingest_log__specimen__fk FOREIGN KEY (tenant_id, specimen_id) REFERENCES lab.specimens (tenant_id, id),
  CONSTRAINT ingest_log__source__ck CHECK (first_source IN ('event','port','exception')),
  CONSTRAINT ingest_log__outcome__ck CHECK (last_outcome IN ('applied','duplicate','unmatched','rejected_state','held','not_applicable')),
  CONSTRAINT ingest_log__key_len__ck CHECK (char_length(result_key) <= 300)
);
CREATE TRIGGER ingest_log__mutable_columns BEFORE UPDATE ON lab.ingest_log
  FOR EACH ROW EXECUTE FUNCTION app.enforce_mutable_columns(
    'last_outcome','result_id','specimen_id','processing_centre_id','exception_id','attempts','last_attempt_at',
    'updated_at','updated_by','version');
-- Duplicate rule: a key whose last_outcome is applied/held/not_applicable → 'duplicate'; unmatched/rejected_state → re-evaluate.

CREATE TABLE lab.ingest_exceptions (
  id uuid NOT NULL, tenant_id uuid NOT NULL,
  centre_id uuid NOT NULL,                     -- instrument's centre (event centre_id)
  processing_centre_id uuid,
  result_key text NOT NULL,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'open',
  instrument_id uuid NOT NULL, instrument_message_id uuid NOT NULL, agent_id uuid,
  protocol text,
  sample_barcode text NOT NULL,
  record_kind text NOT NULL,
  instrument_analyte_code text NOT NULL,
  analyte_id uuid, test_id uuid,
  value_raw text, value_numeric numeric, unit_raw text, unit_code text,
  instrument_flags text[] NOT NULL DEFAULT '{}',
  instrument_result_time timestamptz, received_at timestamptz NOT NULL,
  is_rerun boolean,
  attachment jsonb,
  specimen_id uuid, result_id uuid,
  attempts integer NOT NULL DEFAULT 1,
  last_attempt_at timestamptz NOT NULL,
  resolution text,
  resolved_at timestamptz, resolved_by_membership_id uuid,
  discard_reason_code text, comment text,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT ingest_exceptions__pk PRIMARY KEY (id),
  CONSTRAINT ingest_exceptions__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT ingest_exceptions__centre__fk FOREIGN KEY (tenant_id, centre_id) REFERENCES core.collection_centres (tenant_id, id),
  CONSTRAINT ingest_exceptions__specimen__fk FOREIGN KEY (tenant_id, specimen_id) REFERENCES lab.specimens (tenant_id, id),
  CONSTRAINT ingest_exceptions__result__fk FOREIGN KEY (tenant_id, result_id) REFERENCES lab.results (tenant_id, id),
  CONSTRAINT ingest_exceptions__reason__ck CHECK (reason IN ('unmapped_code','unknown_barcode','specimen_rejected','specimen_not_received',
             'analyte_not_ordered','result_locked','result_already_verified','unit_mismatch','attachment_tenant_mismatch')),
  CONSTRAINT ingest_exceptions__status__ck CHECK (status IN ('open','resolved','discarded')),
  CONSTRAINT ingest_exceptions__resolution__ck CHECK (resolution IS NULL OR resolution IN ('applied','assigned','discarded')),
  CONSTRAINT ingest_exceptions__closed__ck CHECK ((status = 'open') = (resolved_at IS NULL)),
  CONSTRAINT ingest_exceptions__discard__ck CHECK (status <> 'discarded' OR discard_reason_code IS NOT NULL),
  CONSTRAINT ingest_exceptions__record_kind__ck CHECK (record_kind IN ('quantitative','qualitative','ordinal','text','organism_id','ast','attachment')),
  CONSTRAINT ingest_exceptions__barcode__ck CHECK (char_length(sample_barcode) BETWEEN 1 AND 40)
);
CREATE UNIQUE INDEX ingest_exceptions__tenant_id_key_open__p_uq ON lab.ingest_exceptions (tenant_id, result_key) WHERE status = 'open';
CREATE INDEX ingest_exceptions__tenant_id_status__idx ON lab.ingest_exceptions (tenant_id, status, reason, created_at);
CREATE INDEX ingest_exceptions__tenant_id_barcode_open__p_idx ON lab.ingest_exceptions (tenant_id, sample_barcode) WHERE status = 'open';
ALTER TABLE lab.ingest_log ADD CONSTRAINT ingest_log__exception__fk
  FOREIGN KEY (tenant_id, exception_id) REFERENCES lab.ingest_exceptions (tenant_id, id);   -- added after both tables exist

-- ---------- QC raw data (class A) ----------
CREATE TABLE lab.qc_results (
  id uuid NOT NULL, tenant_id uuid NOT NULL,
  centre_id uuid NOT NULL,
  instrument_id uuid NOT NULL,
  instrument_message_id uuid,
  analyte_id uuid,
  instrument_analyte_code text,
  mapping_status text,
  control_id_raw text NOT NULL, control_lot_raw text, control_level text,
  value_raw text NOT NULL,
  value_numeric numeric,
  unit_raw text, unit_code text,
  instrument_flags text[] NOT NULL DEFAULT '{}',
  instrument_result_time timestamptz,
  received_at timestamptz NOT NULL,
  source text NOT NULL,
  idempotency_key text NOT NULL,
  entered_by_membership_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  CONSTRAINT qc_results__pk PRIMARY KEY (id),
  CONSTRAINT qc_results__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT qc_results__idem__uq UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT qc_results__centre__fk FOREIGN KEY (tenant_id, centre_id) REFERENCES core.collection_centres (tenant_id, id),
  CONSTRAINT qc_results__source__ck CHECK (source IN ('instrument','manual')),
  CONSTRAINT qc_results__mapping__ck CHECK (mapping_status IS NULL OR mapping_status IN ('mapped','unmapped')),
  CONSTRAINT qc_results__manual__ck CHECK (source <> 'manual' OR (entered_by_membership_id IS NOT NULL AND analyte_id IS NOT NULL)),
  CONSTRAINT qc_results__lens__ck CHECK (char_length(control_id_raw) <= 64 AND char_length(coalesce(control_lot_raw,'')) <= 64
                                         AND char_length(coalesce(control_level,'')) <= 16 AND char_length(value_raw) <= 64)
);
CREATE INDEX qc_results__tenant_id_instrument_analyte__idx ON lab.qc_results (tenant_id, instrument_id, analyte_id, instrument_result_time);
CREATE INDEX qc_results__tenant_id_created_at__idx ON lab.qc_results (tenant_id, created_at, id);   -- CR-C9-005 (C9 incremental reads)
CREATE INDEX qc_results__tenant_id_result_time__idx ON lab.qc_results (tenant_id, instrument_result_time DESC);   -- listQcResults without instrument_id (#43)

-- ---------- Module submissions (class A, A1 idempotency) ----------
CREATE TABLE lab.module_submissions (
  id uuid NOT NULL, tenant_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  result_id uuid NOT NULL,
  payload_module text NOT NULL, payload_entity_id uuid NOT NULL, payload_version_no integer NOT NULL,
  output_version_no integer NOT NULL,
  output_status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  CONSTRAINT module_submissions__pk PRIMARY KEY (id),
  CONSTRAINT module_submissions__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT module_submissions__key__uq UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT module_submissions__payload__uq UNIQUE (tenant_id, payload_module, payload_entity_id, payload_version_no),
  CONSTRAINT module_submissions__result__fk FOREIGN KEY (tenant_id, result_id) REFERENCES lab.results (tenant_id, id),
  CONSTRAINT module_submissions__module__ck CHECK (payload_module IN ('micro','anatomic')),
  CONSTRAINT module_submissions__status__ck CHECK (output_status IN ('pending','resulted','verified','approved','cancelled'))
);

-- ---------- Event inbox ----------
-- lab.event_inbox (03-IC §12 standard shape) is generated by C0 only, with its RLS, grants and purge policies
-- (C0 05-SCHEMA §3.9; 08 A30.2); this chunk creates no inbox DDL.

-- =====================================================================
-- §3.1 RLS, policies and grants (literal; ownership = lims_owner via the role switch above)
-- =====================================================================
ALTER TABLE lab.specimens ENABLE ROW LEVEL SECURITY;  ALTER TABLE lab.specimens FORCE ROW LEVEL SECURITY;
CREATE POLICY specimens__select__tenant_centre ON lab.specimens FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]) OR processing_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY specimens__insert__tenant_centre ON lab.specimens FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]) OR processing_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY specimens__update__tenant_centre ON lab.specimens FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]) OR processing_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]) OR processing_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
GRANT SELECT, INSERT, UPDATE ON lab.specimens TO lims_app;
ALTER TABLE lab.order_tests ENABLE ROW LEVEL SECURITY;  ALTER TABLE lab.order_tests FORCE ROW LEVEL SECURITY;
CREATE POLICY order_tests__select__tenant_centre ON lab.order_tests FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]) OR processing_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY order_tests__insert__tenant_centre ON lab.order_tests FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]) OR processing_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY order_tests__update__tenant_centre ON lab.order_tests FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]) OR processing_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]) OR processing_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
GRANT SELECT, INSERT, UPDATE ON lab.order_tests TO lims_app;
ALTER TABLE lab.results ENABLE ROW LEVEL SECURITY;  ALTER TABLE lab.results FORCE ROW LEVEL SECURITY;
CREATE POLICY results__select__tenant_centre ON lab.results FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]) OR processing_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY results__insert__tenant_centre ON lab.results FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]) OR processing_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY results__update__tenant_centre ON lab.results FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]) OR processing_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]) OR processing_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
GRANT SELECT, INSERT, UPDATE ON lab.results TO lims_app;
ALTER TABLE lab.result_versions ENABLE ROW LEVEL SECURITY;  ALTER TABLE lab.result_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY result_versions__select__tenant_centre ON lab.result_versions FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]) OR processing_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY result_versions__insert__tenant_centre ON lab.result_versions FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]) OR processing_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY result_versions__update__tenant_centre ON lab.result_versions FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]) OR processing_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]) OR processing_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
GRANT SELECT, INSERT, UPDATE ON lab.result_versions TO lims_app;
ALTER TABLE lab.critical_value_log ENABLE ROW LEVEL SECURITY;  ALTER TABLE lab.critical_value_log FORCE ROW LEVEL SECURITY;
CREATE POLICY critical_value_log__select__tenant_centre ON lab.critical_value_log FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]) OR processing_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY critical_value_log__insert__tenant_centre ON lab.critical_value_log FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]) OR processing_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY critical_value_log__update__tenant_centre ON lab.critical_value_log FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]) OR processing_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]) OR processing_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
GRANT SELECT, INSERT, UPDATE ON lab.critical_value_log TO lims_app;
ALTER TABLE lab.worksheets ENABLE ROW LEVEL SECURITY;  ALTER TABLE lab.worksheets FORCE ROW LEVEL SECURITY;
CREATE POLICY worksheets__select__tenant_centre ON lab.worksheets FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]) OR processing_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY worksheets__insert__tenant_centre ON lab.worksheets FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]) OR processing_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY worksheets__update__tenant_centre ON lab.worksheets FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]) OR processing_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]) OR processing_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
GRANT SELECT, INSERT, UPDATE ON lab.worksheets TO lims_app;
ALTER TABLE lab.ingest_exceptions ENABLE ROW LEVEL SECURITY;  ALTER TABLE lab.ingest_exceptions FORCE ROW LEVEL SECURITY;
CREATE POLICY ingest_exceptions__select__tenant_centre ON lab.ingest_exceptions FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]) OR processing_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY ingest_exceptions__insert__tenant_centre ON lab.ingest_exceptions FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]) OR processing_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY ingest_exceptions__update__tenant_centre ON lab.ingest_exceptions FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]) OR processing_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]) OR processing_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
GRANT SELECT, INSERT, UPDATE ON lab.ingest_exceptions TO lims_app;
ALTER TABLE lab.ingest_log ENABLE ROW LEVEL SECURITY;  ALTER TABLE lab.ingest_log FORCE ROW LEVEL SECURITY;
CREATE POLICY ingest_log__select__tenant_centre ON lab.ingest_log FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]) OR processing_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY ingest_log__insert__tenant_centre ON lab.ingest_log FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]) OR processing_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY ingest_log__update__tenant_centre ON lab.ingest_log FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]) OR processing_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]) OR processing_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
GRANT SELECT, INSERT, UPDATE ON lab.ingest_log TO lims_app;
ALTER TABLE lab.specimen_transitions ENABLE ROW LEVEL SECURITY;  ALTER TABLE lab.specimen_transitions FORCE ROW LEVEL SECURITY;
CREATE POLICY specimen_transitions__select__tenant_centre ON lab.specimen_transitions FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]) OR processing_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY specimen_transitions__insert__tenant_centre ON lab.specimen_transitions FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]) OR processing_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
GRANT SELECT, INSERT ON lab.specimen_transitions TO lims_app;
ALTER TABLE lab.result_observations ENABLE ROW LEVEL SECURITY;  ALTER TABLE lab.result_observations FORCE ROW LEVEL SECURITY;
CREATE POLICY result_observations__select__tenant_centre ON lab.result_observations FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]) OR processing_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY result_observations__insert__tenant_centre ON lab.result_observations FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]) OR processing_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
GRANT SELECT, INSERT ON lab.result_observations TO lims_app;
ALTER TABLE lab.result_attachments ENABLE ROW LEVEL SECURITY;  ALTER TABLE lab.result_attachments FORCE ROW LEVEL SECURITY;
CREATE POLICY result_attachments__select__tenant_centre ON lab.result_attachments FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]) OR processing_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY result_attachments__insert__tenant_centre ON lab.result_attachments FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]) OR processing_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
GRANT SELECT, INSERT ON lab.result_attachments TO lims_app;
ALTER TABLE lab.verifications ENABLE ROW LEVEL SECURITY;  ALTER TABLE lab.verifications FORCE ROW LEVEL SECURITY;
CREATE POLICY verifications__select__tenant_centre ON lab.verifications FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]) OR processing_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY verifications__insert__tenant_centre ON lab.verifications FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]) OR processing_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
GRANT SELECT, INSERT ON lab.verifications TO lims_app;
ALTER TABLE lab.approvals ENABLE ROW LEVEL SECURITY;  ALTER TABLE lab.approvals FORCE ROW LEVEL SECURITY;
CREATE POLICY approvals__select__tenant_centre ON lab.approvals FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]) OR processing_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY approvals__insert__tenant_centre ON lab.approvals FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]) OR processing_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
GRANT SELECT, INSERT ON lab.approvals TO lims_app;
ALTER TABLE lab.critical_notifications ENABLE ROW LEVEL SECURITY;  ALTER TABLE lab.critical_notifications FORCE ROW LEVEL SECURITY;
CREATE POLICY critical_notifications__select__tenant_centre ON lab.critical_notifications FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]) OR processing_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY critical_notifications__insert__tenant_centre ON lab.critical_notifications FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]) OR processing_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
GRANT SELECT, INSERT ON lab.critical_notifications TO lims_app;
ALTER TABLE lab.worksheet_items ENABLE ROW LEVEL SECURITY;  ALTER TABLE lab.worksheet_items FORCE ROW LEVEL SECURITY;
CREATE POLICY worksheet_items__select__tenant_centre ON lab.worksheet_items FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]) OR processing_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY worksheet_items__insert__tenant_centre ON lab.worksheet_items FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]) OR processing_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
GRANT SELECT, INSERT ON lab.worksheet_items TO lims_app;
ALTER TABLE lab.lab_settings ENABLE ROW LEVEL SECURITY;  ALTER TABLE lab.lab_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY lab_settings__select__tenant ON lab.lab_settings FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY lab_settings__insert__tenant ON lab.lab_settings FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY lab_settings__update__tenant ON lab.lab_settings FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
GRANT SELECT, INSERT, UPDATE ON lab.lab_settings TO lims_app;
ALTER TABLE lab.barcode_counters ENABLE ROW LEVEL SECURITY;  ALTER TABLE lab.barcode_counters FORCE ROW LEVEL SECURITY;
CREATE POLICY barcode_counters__select__tenant ON lab.barcode_counters FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY barcode_counters__insert__tenant ON lab.barcode_counters FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY barcode_counters__update__tenant ON lab.barcode_counters FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
GRANT SELECT, INSERT, UPDATE ON lab.barcode_counters TO lims_app;
ALTER TABLE lab.delta_check_rules ENABLE ROW LEVEL SECURITY;  ALTER TABLE lab.delta_check_rules FORCE ROW LEVEL SECURITY;
CREATE POLICY delta_check_rules__select__tenant ON lab.delta_check_rules FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY delta_check_rules__insert__tenant ON lab.delta_check_rules FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY delta_check_rules__update__tenant ON lab.delta_check_rules FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
GRANT SELECT, INSERT, UPDATE ON lab.delta_check_rules TO lims_app;
ALTER TABLE lab.order_readiness ENABLE ROW LEVEL SECURITY;  ALTER TABLE lab.order_readiness FORCE ROW LEVEL SECURITY;
CREATE POLICY order_readiness__select__tenant ON lab.order_readiness FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY order_readiness__insert__tenant ON lab.order_readiness FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY order_readiness__update__tenant ON lab.order_readiness FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
GRANT SELECT, INSERT, UPDATE ON lab.order_readiness TO lims_app;
ALTER TABLE lab.qc_holds ENABLE ROW LEVEL SECURITY;  ALTER TABLE lab.qc_holds FORCE ROW LEVEL SECURITY;
CREATE POLICY qc_holds__select__tenant ON lab.qc_holds FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY qc_holds__insert__tenant ON lab.qc_holds FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY qc_holds__update__tenant ON lab.qc_holds FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
GRANT SELECT, INSERT, UPDATE ON lab.qc_holds TO lims_app;
ALTER TABLE lab.cs_rejection_reasons ENABLE ROW LEVEL SECURITY;  ALTER TABLE lab.cs_rejection_reasons FORCE ROW LEVEL SECURITY;
CREATE POLICY cs_rejection_reasons__select__tenant ON lab.cs_rejection_reasons FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY cs_rejection_reasons__insert__tenant ON lab.cs_rejection_reasons FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY cs_rejection_reasons__update__tenant ON lab.cs_rejection_reasons FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
GRANT SELECT, INSERT, UPDATE ON lab.cs_rejection_reasons TO lims_app;
ALTER TABLE lab.cs_return_reasons ENABLE ROW LEVEL SECURITY;  ALTER TABLE lab.cs_return_reasons FORCE ROW LEVEL SECURITY;
CREATE POLICY cs_return_reasons__select__tenant ON lab.cs_return_reasons FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY cs_return_reasons__insert__tenant ON lab.cs_return_reasons FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY cs_return_reasons__update__tenant ON lab.cs_return_reasons FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
GRANT SELECT, INSERT, UPDATE ON lab.cs_return_reasons TO lims_app;
ALTER TABLE lab.cs_amendment_reasons ENABLE ROW LEVEL SECURITY;  ALTER TABLE lab.cs_amendment_reasons FORCE ROW LEVEL SECURITY;
CREATE POLICY cs_amendment_reasons__select__tenant ON lab.cs_amendment_reasons FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY cs_amendment_reasons__insert__tenant ON lab.cs_amendment_reasons FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY cs_amendment_reasons__update__tenant ON lab.cs_amendment_reasons FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
GRANT SELECT, INSERT, UPDATE ON lab.cs_amendment_reasons TO lims_app;
ALTER TABLE lab.cs_exception_discard_reasons ENABLE ROW LEVEL SECURITY;  ALTER TABLE lab.cs_exception_discard_reasons FORCE ROW LEVEL SECURITY;
CREATE POLICY cs_exception_discard_reasons__select__tenant ON lab.cs_exception_discard_reasons FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY cs_exception_discard_reasons__insert__tenant ON lab.cs_exception_discard_reasons FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY cs_exception_discard_reasons__update__tenant ON lab.cs_exception_discard_reasons FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
GRANT SELECT, INSERT, UPDATE ON lab.cs_exception_discard_reasons TO lims_app;
ALTER TABLE lab.report_releases ENABLE ROW LEVEL SECURITY;  ALTER TABLE lab.report_releases FORCE ROW LEVEL SECURITY;
CREATE POLICY report_releases__select__tenant ON lab.report_releases FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY report_releases__insert__tenant ON lab.report_releases FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
GRANT SELECT, INSERT ON lab.report_releases TO lims_app;
ALTER TABLE lab.module_submissions ENABLE ROW LEVEL SECURITY;  ALTER TABLE lab.module_submissions FORCE ROW LEVEL SECURITY;
CREATE POLICY module_submissions__select__tenant ON lab.module_submissions FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY module_submissions__insert__tenant ON lab.module_submissions FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
GRANT SELECT, INSERT ON lab.module_submissions TO lims_app;
ALTER TABLE lab.qc_results ENABLE ROW LEVEL SECURITY;  ALTER TABLE lab.qc_results FORCE ROW LEVEL SECURITY;
CREATE POLICY qc_results__select__tenant_centre ON lab.qc_results FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY qc_results__insert__tenant_centre ON lab.qc_results FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
GRANT SELECT, INSERT ON lab.qc_results TO lims_app;
ALTER TABLE lab.orders ENABLE ROW LEVEL SECURITY;  ALTER TABLE lab.orders FORCE ROW LEVEL SECURITY;
CREATE POLICY orders__select__tenant_centre ON lab.orders FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])
         OR EXISTS (SELECT 1 FROM lab.specimens s
                    WHERE s.tenant_id = orders.tenant_id AND s.order_id = orders.id
                      AND s.processing_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]))) AND (SELECT app.is_staff_or_system()));
CREATE POLICY orders__insert__tenant ON lab.orders FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.has_all_centres()));   -- only system consumers create
CREATE POLICY orders__update__tenant ON lab.orders FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.has_all_centres()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.has_all_centres()));
GRANT SELECT, INSERT, UPDATE ON lab.orders TO lims_app;

-- Global coded sets: no RLS (db/tests/rls_exempt.txt: global seed vocabulary, no tenant data)
GRANT SELECT ON lab.g_cs_rejection_reasons, lab.g_cs_return_reasons, lab.g_cs_amendment_reasons,
                lab.g_cs_exception_discard_reasons TO lims_app;
-- Internal views
GRANT SELECT ON lab.v_result_current, lab.v_rejection_reasons, lab.v_return_reasons, lab.v_amendment_reasons,
                lab.v_exception_discard_reasons TO lims_app;
GRANT EXECUTE ON FUNCTION lab.enforce_result_lock() TO lims_app;
-- No DELETE on any lab table (02-CV §5.6).

-- Row audit (C0 app.tg_row_audit; AC-0B-5.x): class C/M tables only (§3.1 note)
CREATE TRIGGER specimens__audit AFTER INSERT OR UPDATE OR DELETE ON lab.specimens FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER order_tests__audit AFTER INSERT OR UPDATE OR DELETE ON lab.order_tests FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER results__audit AFTER INSERT OR UPDATE OR DELETE ON lab.results FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER result_versions__audit AFTER INSERT OR UPDATE OR DELETE ON lab.result_versions FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER critical_value_log__audit AFTER INSERT OR UPDATE OR DELETE ON lab.critical_value_log FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER worksheets__audit AFTER INSERT OR UPDATE OR DELETE ON lab.worksheets FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER ingest_exceptions__audit AFTER INSERT OR UPDATE OR DELETE ON lab.ingest_exceptions FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER ingest_log__audit AFTER INSERT OR UPDATE OR DELETE ON lab.ingest_log FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER lab_settings__audit AFTER INSERT OR UPDATE OR DELETE ON lab.lab_settings FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER barcode_counters__audit AFTER INSERT OR UPDATE OR DELETE ON lab.barcode_counters FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER delta_check_rules__audit AFTER INSERT OR UPDATE OR DELETE ON lab.delta_check_rules FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER order_readiness__audit AFTER INSERT OR UPDATE OR DELETE ON lab.order_readiness FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER qc_holds__audit AFTER INSERT OR UPDATE OR DELETE ON lab.qc_holds FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER cs_rejection_reasons__audit AFTER INSERT OR UPDATE OR DELETE ON lab.cs_rejection_reasons FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER cs_return_reasons__audit AFTER INSERT OR UPDATE OR DELETE ON lab.cs_return_reasons FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER cs_amendment_reasons__audit AFTER INSERT OR UPDATE OR DELETE ON lab.cs_amendment_reasons FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER cs_exception_discard_reasons__audit AFTER INSERT OR UPDATE OR DELETE ON lab.cs_exception_discard_reasons FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER orders__audit AFTER INSERT OR UPDATE OR DELETE ON lab.orders FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();

-- =====================================================================
-- §4 Published views (03-IC §6.3, exact columns)
-- =====================================================================
CREATE VIEW lab.v_pub_specimen_timeline WITH (security_invoker = true) AS
SELECT s.tenant_id, s.id AS specimen_id, s.order_id, s.centre_id, s.processing_branch_id, s.specimen_type_code,
       s.priority, s.status, s.ordered_at, s.collected_at, s.in_transit_at, s.received_at, s.first_resulted_at,
       s.first_verified_at, s.all_approved_at, s.reported_at, s.rejected_at, s.rejection_reason_code,
       s.parent_specimen_id,                                                 -- appended (CR-C8-004, 08 §4.9)
       s.replaces_specimen_id,                                               -- appended (CR-C16-022, 08 A19 D-106): recollection link, C13 reconcile
       s.version AS specimen_version                                         -- appended (CR-C16-022, D-106): = event aggregate seq (03-IC §3.5), C16 status_seq
FROM lab.specimens s;

CREATE VIEW lab.v_pub_pending_items WITH (security_invoker = true) AS
SELECT ot.tenant_id, ot.centre_id, ot.processing_branch_id, ot.department_id, ot.test_id, ot.order_id,
       ot.order_item_id, ot.specimen_id, ot.priority, ot.status AS item_status, ot.received_at,
       ot.tat_target_seconds,
       floor(extract(epoch FROM (now() - coalesce(ot.received_at, ot.ordered_at))))::bigint AS age_seconds
FROM lab.order_tests ot
WHERE ot.status IN ('awaiting_collection','awaiting_receipt','in_process','resulted','verified') AND ot.is_active;
-- age_seconds anchor: received_at when received, else ordered_at (registration). Consumers must label it (06-GLOSSARY TAT).

CREATE VIEW lab.v_pub_result_daily WITH (security_invoker = true) AS
WITH ev AS (
  SELECT r.tenant_id, r.processing_branch_id, r.department_id, r.test_id, r.centre_id,
         (r.first_resulted_at AT TIME ZONE 'Asia/Kathmandu')::date AS business_date,
         1 AS resulted, 0 AS verified, 0 AS approved, 0 AS amended, 0 AS auto_verified, 0 AS critical,
         CASE WHEN r.flag IN ('L','H','LL','HH','A') THEN 1 ELSE 0 END AS abnormal, 0 AS tests_approved
  FROM lab.results r WHERE r.first_resulted_at IS NOT NULL
  UNION ALL
  SELECT r.tenant_id, r.processing_branch_id, r.department_id, r.test_id, r.centre_id,
         (v.occurred_at AT TIME ZONE 'Asia/Kathmandu')::date, 0, 1, 0, 0, CASE WHEN v.mode = 'auto' THEN 1 ELSE 0 END, 0, 0, 0
  FROM lab.verifications v JOIN lab.results r ON r.tenant_id = v.tenant_id AND r.id = v.result_id
  WHERE v.kind = 'verified'
  UNION ALL
  SELECT r.tenant_id, r.processing_branch_id, r.department_id, r.test_id, r.centre_id,
         (a.occurred_at AT TIME ZONE 'Asia/Kathmandu')::date, 0, 0,
         CASE WHEN a.kind = 'approval' THEN 1 ELSE 0 END, CASE WHEN a.kind = 'amendment' THEN 1 ELSE 0 END, 0, 0, 0, 0
  FROM lab.approvals a JOIN lab.results r ON r.tenant_id = a.tenant_id AND r.id = a.result_id
  UNION ALL
  SELECT r.tenant_id, r.processing_branch_id, r.department_id, r.test_id, r.centre_id,
         (c.detected_at AT TIME ZONE 'Asia/Kathmandu')::date, 0, 0, 0, 0, 0, 1, 0, 0
  FROM lab.critical_value_log c JOIN lab.results r ON r.tenant_id = c.tenant_id AND r.id = c.result_id
  UNION ALL
  SELECT ot.tenant_id, ot.processing_branch_id, ot.department_id, ot.test_id, ot.centre_id,      -- CR-C8-004: order tests approved
         (ot.approved_at AT TIME ZONE 'Asia/Kathmandu')::date, 0, 0, 0, 0, 0, 0, 0, 1
  FROM lab.order_tests ot WHERE ot.approved_at IS NOT NULL
)
SELECT tenant_id, processing_branch_id, business_date, department_id, test_id,
       sum(resulted)::bigint AS results_resulted, sum(verified)::bigint AS results_verified,
       sum(approved)::bigint AS results_approved, sum(amended)::bigint AS results_amended,
       sum(auto_verified)::bigint AS auto_verified, sum(critical)::bigint AS critical_count,
       sum(abnormal)::bigint AS abnormal_count,
       centre_id,                                                             -- appended (order's collection centre; grouping key — CR-C8-004, 08 §4.9)
       sum(tests_approved)::bigint AS tests_approved                          -- appended (CR-C8-004)
FROM ev GROUP BY tenant_id, processing_branch_id, business_date, department_id, test_id, centre_id;

CREATE VIEW lab.v_pub_rejection_daily WITH (security_invoker = true) AS
SELECT s.tenant_id, s.centre_id, (s.rejected_at AT TIME ZONE 'Asia/Kathmandu')::date AS business_date,
       s.specimen_type_code, s.rejection_reason_code AS reason_code,
       count(*)::bigint AS rejections,
       count(*) FILTER (WHERE s.recollection_ordered_at IS NOT NULL)::bigint AS recollections_ordered
FROM lab.specimens s WHERE s.rejected_at IS NOT NULL
GROUP BY 1, 2, 3, 4, 5;

CREATE VIEW lab.v_pub_critical_value_daily WITH (security_invoker = true) AS
SELECT c.tenant_id, (c.detected_at AT TIME ZONE 'Asia/Kathmandu')::date AS business_date, c.analyte_id,
       count(*)::bigint AS detected,
       count(*) FILTER (WHERE c.first_confirmed_notification_at IS NOT NULL)::bigint AS notified,
       (percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (c.first_confirmed_notification_at - c.detected_at)))
          FILTER (WHERE c.first_confirmed_notification_at IS NOT NULL))::bigint AS median_notify_seconds,
       max(extract(epoch FROM (c.first_confirmed_notification_at - c.detected_at)))::bigint AS max_notify_seconds,
       c.centre_id                                                            -- appended (grouping key — CR-C8-004, 08 §4.9)
FROM lab.critical_value_log c
GROUP BY 1, 2, 3, c.centre_id;
-- "notified" = first notification with outcome 'reached' AND read_back_confirmed (service sets first_confirmed_notification_at).

CREATE VIEW lab.v_pub_qc_result WITH (security_invoker = true) AS
SELECT q.tenant_id, q.id AS qc_result_id, q.instrument_id, q.analyte_id, q.control_id_raw, q.control_lot_raw,
       q.control_level, q.value_numeric::text AS value_numeric, q.unit_code, q.instrument_result_time,
       q.received_at, q.source,
       q.created_at                                                           -- appended (CR-C9-005, 08 §4.9)
FROM lab.qc_results q;

GRANT SELECT ON lab.v_pub_specimen_timeline, lab.v_pub_pending_items, lab.v_pub_result_daily,
                lab.v_pub_rejection_daily, lab.v_pub_critical_value_daily, lab.v_pub_qc_result TO lims_app;
