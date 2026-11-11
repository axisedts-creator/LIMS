-- T0B-10.C4: frontdesk schema — C4 05-SCHEMA §3 verbatim, then §4a RLS/policies/grants for frontdesk (literal statements),
-- row-audit triggers (§0.6: every table except class A, g_* and event_inbox; 08 A13 D-27a exclusion list on patients),
-- and the frontdesk v_pub_* views of §6 (03-IC §6). Policies are copied 1:1 to db/policies/frontdesk.sql (AC-0B-2.3).
-- g_* seed rows (§7) belong to db/seeds. event_inbox is C0's (T0B-05).
SET LOCAL ROLE lims_owner;

CREATE SCHEMA IF NOT EXISTS frontdesk AUTHORIZATION lims_owner;   -- C0 creates every module schema (C0 05-SCHEMA §1); kept idempotent like C2/C3/C5

-- ---------- settings ----------
CREATE TABLE frontdesk.settings (
  tenant_id                 uuid        NOT NULL,                     -- P0
  discount_self_limit_bp    integer     NOT NULL DEFAULT 0,           -- P0
  discount_self_limit_paisa bigint      NOT NULL DEFAULT 0,
  discount_absolute_max_bp  integer     NOT NULL DEFAULT 10000,
  require_referrer          boolean     NOT NULL DEFAULT false,
  consent_text_version      text        NOT NULL,
  registration_sms_enabled  boolean     NOT NULL DEFAULT true,
  label_autoprint           boolean     NOT NULL DEFAULT true,
  buyer_pan_pattern         text        NOT NULL DEFAULT '^[0-9]{9}$', -- UNVERIFIED default
  patient_search_min_chars  integer     NOT NULL DEFAULT 3,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT settings__pk PRIMARY KEY (tenant_id),
  CONSTRAINT settings__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT settings__limits__ck CHECK (discount_self_limit_bp BETWEEN 0 AND 10000
     AND discount_absolute_max_bp BETWEEN 0 AND 10000 AND discount_self_limit_bp <= discount_absolute_max_bp
     AND discount_self_limit_paisa >= 0 AND patient_search_min_chars BETWEEN 2 AND 10),
  CONSTRAINT settings__consent_ver__ck CHECK (char_length(consent_text_version) BETWEEN 1 AND 32)
);

-- ---------- counters (registration_no per branch, patient_code per tenant; gaps allowed, 03-IC §9.3) ----------
CREATE TABLE frontdesk.number_counters (
  tenant_id    uuid   NOT NULL,
  counter_kind text   NOT NULL,          -- patient_code | registration_no
  scope_key    text   NOT NULL,          -- '' for tenant scope; branch_id::text for registration_no
  last_value   bigint NOT NULL DEFAULT 0,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT number_counters__pk PRIMARY KEY (tenant_id, counter_kind, scope_key),
  CONSTRAINT number_counters__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT number_counters__kind__ck CHECK (counter_kind IN ('patient_code','registration_no')),
  CONSTRAINT number_counters__value__ck CHECK (last_value >= 0)
);

-- ---------- patients ----------
CREATE TABLE frontdesk.patients (
  id                    uuid        NOT NULL,
  tenant_id             uuid        NOT NULL,
  patient_code          text        NOT NULL,                 -- P2 ("lab code", 00 A2)
  full_name             text,                                 -- P2 (NULL only after anonymisation)
  name_search           text,                                 -- P2 NFC-normalised, case-folded, single-spaced
  sex                   text        NOT NULL,                 -- P2
  birth_on              date,                                 -- P2
  is_birth_on_estimated boolean     NOT NULL DEFAULT false,
  phone_e164            text,                                 -- P2
  email                 text,                                 -- P2
  address_text          text,                                 -- P2
  source                text        NOT NULL DEFAULT 'front_desk',  -- P0 how the patient row was created
  registered_centre_id  uuid,                                 -- P1 informational; NULL only for self_service (FrontdeskPort.createSelfRegisteredPatient has no centre)
  last_visit_at         timestamptz,                          -- P1
  duplicate_override_reason_code text,                        -- P0
  anonymised_at         timestamptz,
  anonymised_by         uuid,
  anonymise_reason_code text,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT patients__pk PRIMARY KEY (id),
  CONSTRAINT patients__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT patients__tenant_id_patient_code__uq UNIQUE (tenant_id, patient_code),
  CONSTRAINT patients__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT patients__centre__fk FOREIGN KEY (tenant_id, registered_centre_id) REFERENCES core.collection_centres (tenant_id, id),
  CONSTRAINT patients__sex__ck CHECK (sex IN ('male','female','other','unknown')),
  CONSTRAINT patients__source__ck CHECK (source IN ('front_desk','engagement_booking','home_collection','partner_manifest','self_service')),
  CONSTRAINT patients__centre__ck CHECK (source = 'self_service' OR registered_centre_id IS NOT NULL),
  CONSTRAINT patients__name__ck CHECK ((anonymised_at IS NULL AND full_name IS NOT NULL AND char_length(full_name) BETWEEN 1 AND 200)
                                       OR anonymised_at IS NOT NULL),
  CONSTRAINT patients__phone__ck CHECK (phone_e164 IS NULL OR phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  CONSTRAINT patients__email__ck CHECK (email IS NULL OR char_length(email) <= 254),
  CONSTRAINT patients__address__ck CHECK (address_text IS NULL OR char_length(address_text) <= 300)
);
CREATE INDEX patients__tenant_id_name_search__trgm_idx ON frontdesk.patients
  USING gin (tenant_id, name_search extensions.gin_trgm_ops) WHERE anonymised_at IS NULL;   -- needs btree_gin (§0.9); opclass schema-qualified (08 A31.1)
CREATE INDEX patients__tenant_id_phone__p_idx ON frontdesk.patients (tenant_id, phone_e164) WHERE phone_e164 IS NOT NULL;
CREATE INDEX patients__tenant_id_birth_on__idx ON frontdesk.patients (tenant_id, birth_on);   -- dedupe predicate
CREATE INDEX patients__tenant_id_created_at__idx ON frontdesk.patients (tenant_id, created_at);  -- F26 possible duplicates created on a date
-- Audit (08 A13 D-27a; 02-CV §5.7 excluded-column argument, CR-C15-013): C0 attaches the generic audit trigger
-- app.tg_row_audit() to this table with the excluded-column argument list
--   ('full_name','name_search','birth_on','phone_e164','email','address_text')
-- (trigger name/timing per the C0 template), so demographic values are never copied into audit.audit_log.
-- Compensating control: every demographic change (F4, anonymisation) writes access_log `patient.update` / `patient.anonymise`
-- with detail.changed_fields = column names only.

-- ---------- consents (append-only, REQ-SEC-005) ----------
CREATE TABLE frontdesk.patient_consents (
  id uuid NOT NULL, tenant_id uuid NOT NULL, patient_id uuid NOT NULL,
  processing boolean NOT NULL, sms boolean NOT NULL, whatsapp boolean NOT NULL, email boolean NOT NULL,
  share_with_referrer boolean NOT NULL,
  consent_text_version text NOT NULL,
  source text NOT NULL,                         -- front_desk | engagement_booking | home_collection | partner_manifest | self_service | anonymisation
  captured_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  CONSTRAINT patient_consents__pk PRIMARY KEY (id),
  CONSTRAINT patient_consents__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT patient_consents__patient__fk FOREIGN KEY (tenant_id, patient_id) REFERENCES frontdesk.patients (tenant_id, id),
  CONSTRAINT patient_consents__source__ck CHECK (source IN ('front_desk','engagement_booking','home_collection','partner_manifest','self_service','anonymisation'))
);
CREATE INDEX patient_consents__tenant_id_patient_id_captured_at__idx ON frontdesk.patient_consents (tenant_id, patient_id, captured_at DESC);

-- ---------- orders ----------
CREATE TABLE frontdesk.orders (
  id uuid NOT NULL, tenant_id uuid NOT NULL, branch_id uuid NOT NULL, centre_id uuid NOT NULL,
  patient_id        uuid NOT NULL,                     -- P1
  registration_no   text NOT NULL,                     -- P2
  status            text NOT NULL,
  visit_type        text NOT NULL,
  billing_mode      text NOT NULL,
  credit_party_id   uuid,                              -- P1 (catalog id, no FK: catalog FK optional — see note)
  referrer_id       uuid,                              -- P1; NULL = SELF
  priority          text NOT NULL,
  collection_mode   text NOT NULL,
  source            text NOT NULL,
  source_ref_id     uuid,
  partner_id        uuid,                              -- CR-C4-006
  age_years smallint, age_months smallint, age_days smallint,  -- P2 snapshot at order
  is_first_order_of_patient boolean NOT NULL,
  catalog_revision  integer NOT NULL,
  items_version     integer NOT NULL DEFAULT 1,
  scheduled_at      timestamptz,
  registered_at     timestamptz,
  requires_credit_note boolean NOT NULL DEFAULT false,
  cancelled_at timestamptz, cancelled_by uuid, cancel_reason_code text, cancel_reason_text text,  -- reason text P3-possible
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT orders__pk PRIMARY KEY (id),
  CONSTRAINT orders__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT orders__tenant_id_registration_no__uq UNIQUE (tenant_id, registration_no),
  CONSTRAINT orders__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT orders__branch__fk FOREIGN KEY (tenant_id, branch_id) REFERENCES core.branches (tenant_id, id),
  CONSTRAINT orders__centre__fk FOREIGN KEY (tenant_id, centre_id) REFERENCES core.collection_centres (tenant_id, id),
  CONSTRAINT orders__patient__fk FOREIGN KEY (tenant_id, patient_id) REFERENCES frontdesk.patients (tenant_id, id),
  CONSTRAINT orders__status__ck CHECK (status IN ('pre_registered','registered','in_progress','completed','cancelled')),
  CONSTRAINT orders__visit_type__ck CHECK (visit_type IN ('opd','ipd')),
  CONSTRAINT orders__billing_mode__ck CHECK (billing_mode IN ('cash','credit')),
  CONSTRAINT orders__credit_party__ck CHECK ((billing_mode = 'credit') = (credit_party_id IS NOT NULL)),
  CONSTRAINT orders__priority__ck CHECK (priority IN ('routine','urgent')),
  CONSTRAINT orders__collection_mode__ck CHECK (collection_mode IN ('walk_in','home','centre','partner')),
  CONSTRAINT orders__source__ck CHECK (source IN ('front_desk','engagement_booking','home_collection','partner_manifest')),
  CONSTRAINT orders__source_ref__ck CHECK ((source = 'front_desk') = (source_ref_id IS NULL)),
  CONSTRAINT orders__registered__ck CHECK ((status = 'pre_registered') OR registered_at IS NOT NULL OR status = 'cancelled'),
  CONSTRAINT orders__cancel__ck CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL AND cancel_reason_code IS NOT NULL)),
  CONSTRAINT orders__cancel_text__ck CHECK (cancel_reason_text IS NULL OR char_length(cancel_reason_text) <= 500)
);
-- Note: 'in_progress'/'completed' are derived on read (03-IC §10.4); the stored column only ever holds
-- pre_registered | registered | cancelled. The CHECK lists all five so a future CR can store them.
CREATE INDEX orders__tenant_id_centre_id_registered_at__idx ON frontdesk.orders (tenant_id, centre_id, registered_at DESC);
CREATE INDEX orders__tenant_id_registered_at__idx ON frontdesk.orders (tenant_id, registered_at DESC);   -- F10 without centre_id (all-centre users)
CREATE INDEX orders__tenant_id_patient_id_registered_at__idx ON frontdesk.orders (tenant_id, patient_id, registered_at DESC);
CREATE INDEX orders__tenant_id_status__p_idx ON frontdesk.orders (tenant_id, status, created_at) WHERE status IN ('pre_registered');
CREATE UNIQUE INDEX orders__tenant_id_source_ref__p_uq ON frontdesk.orders (tenant_id, source, source_ref_id) WHERE source_ref_id IS NOT NULL;
CREATE INDEX orders__tenant_id_referrer_id_registered_at__idx ON frontdesk.orders (tenant_id, referrer_id, registered_at) WHERE referrer_id IS NOT NULL;
CREATE TRIGGER orders__mutable_columns BEFORE UPDATE ON frontdesk.orders FOR EACH ROW EXECUTE FUNCTION app.enforce_mutable_columns(
  'status','registered_at','items_version','requires_credit_note','catalog_revision','referrer_id','visit_type','priority',
  'scheduled_at','cancelled_at','cancelled_by','cancel_reason_code','cancel_reason_text','is_active',
  'updated_at','updated_by','version');
CREATE FUNCTION frontdesk.orders_lifecycle_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  -- status: pre_registered→registered | pre_registered→cancelled | registered→cancelled; nothing out of cancelled
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT coalesce((OLD.status = 'pre_registered' AND NEW.status IN ('registered','cancelled'))
                      OR (OLD.status = 'registered' AND NEW.status = 'cancelled'), false) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'frontdesk.orders';
  END IF;
  -- referrer_id / visit_type / priority / scheduled_at / catalog_revision only while OLD.status = 'pre_registered'
  -- (this includes the pre_registered→registered transition, on which catalog_revision is re-stamped)
  IF OLD.status <> 'pre_registered'
     AND (NEW.referrer_id, NEW.visit_type, NEW.priority, NEW.scheduled_at, NEW.catalog_revision)
         IS DISTINCT FROM (OLD.referrer_id, OLD.visit_type, OLD.priority, OLD.scheduled_at, OLD.catalog_revision) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'frontdesk.orders';
  END IF;
  -- cancelled_*: set only on the transition to cancelled, never changed afterwards
  IF (NEW.cancelled_at, NEW.cancelled_by, NEW.cancel_reason_code, NEW.cancel_reason_text)
     IS DISTINCT FROM (OLD.cancelled_at, OLD.cancelled_by, OLD.cancel_reason_code, OLD.cancel_reason_text)
     AND NOT (OLD.status <> 'cancelled' AND NEW.status = 'cancelled') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'frontdesk.orders';
  END IF;
  RETURN NEW;
END $$;
ALTER FUNCTION frontdesk.orders_lifecycle_guard() OWNER TO lims_owner;
-- guard rules:
--  * status transitions allowed: pre_registered→registered, pre_registered→cancelled, registered→cancelled; nothing out of cancelled
--  * referrer_id/visit_type/priority/scheduled_at/catalog_revision may change only while OLD.status = 'pre_registered'
--    (catalog_revision also on the pre_registered→registered transition)
--  * cancelled_* may be set only on the transition to cancelled, never changed afterwards
CREATE TRIGGER orders__lifecycle_guard BEFORE UPDATE ON frontdesk.orders FOR EACH ROW EXECUTE FUNCTION frontdesk.orders_lifecycle_guard();

-- ---------- order items ----------
CREATE TABLE frontdesk.order_items (
  id uuid NOT NULL, tenant_id uuid NOT NULL, order_id uuid NOT NULL, centre_id uuid NOT NULL,
  orderable_id   uuid NOT NULL,                   -- P3 (orderable linked to a person)
  orderable_kind text NOT NULL,
  code           text NOT NULL,                   -- P3 snapshot
  name           text NOT NULL,                   -- P3 snapshot
  test_ids       uuid[] NOT NULL,                 -- P3
  department_id  uuid,                            -- P0 (NULL = multiple departments)
  priority       text NOT NULL,
  outsourced     boolean NOT NULL DEFAULT false,
  status         text NOT NULL DEFAULT 'active',
  unit_price_paisa       bigint NOT NULL,
  urgent_surcharge_paisa bigint,
  price_list_id uuid NOT NULL, price_list_version integer NOT NULL, price_source text NOT NULL,
  vat_treatment  text NOT NULL, other_tax_code text,
  added_in_items_version integer NOT NULL,
  removed_at timestamptz, removed_by uuid, removal_reason_code text,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT order_items__pk PRIMARY KEY (id),
  CONSTRAINT order_items__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT order_items__order__fk FOREIGN KEY (tenant_id, order_id) REFERENCES frontdesk.orders (tenant_id, id),
  CONSTRAINT order_items__centre__fk FOREIGN KEY (tenant_id, centre_id) REFERENCES core.collection_centres (tenant_id, id),
  CONSTRAINT order_items__kind__ck CHECK (orderable_kind IN ('test','panel')),
  CONSTRAINT order_items__priority__ck CHECK (priority IN ('routine','urgent')),
  CONSTRAINT order_items__status__ck CHECK (status IN ('active','removed','cancelled')),
  CONSTRAINT order_items__price__ck CHECK (unit_price_paisa >= 0 AND (urgent_surcharge_paisa IS NULL OR urgent_surcharge_paisa >= 0)),
  CONSTRAINT order_items__price_source__ck CHECK (price_source IN ('explicit','credit_party','referrer','centre','tenant_default')),
  CONSTRAINT order_items__vat__ck CHECK (vat_treatment IN ('exempt','taxable')),
  CONSTRAINT order_items__tests__ck CHECK (cardinality(test_ids) BETWEEN 1 AND 200),
  CONSTRAINT order_items__removed__ck CHECK ((status = 'removed') = (removed_at IS NOT NULL AND removal_reason_code IS NOT NULL))
);
CREATE INDEX order_items__tenant_id_order_id__idx ON frontdesk.order_items (tenant_id, order_id);
CREATE TRIGGER order_items__mutable_columns BEFORE UPDATE ON frontdesk.order_items FOR EACH ROW EXECUTE FUNCTION
  app.enforce_mutable_columns('status','removed_at','removed_by','removal_reason_code','is_active','updated_at','updated_by','version');
-- guard: status active→removed | active→cancelled only.
CREATE FUNCTION frontdesk.order_items_lifecycle_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT coalesce(OLD.status = 'active' AND NEW.status IN ('removed','cancelled'), false) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'frontdesk.order_items';
  END IF;
  RETURN NEW;
END $$;
ALTER FUNCTION frontdesk.order_items_lifecycle_guard() OWNER TO lims_owner;
CREATE TRIGGER order_items__lifecycle_guard BEFORE UPDATE ON frontdesk.order_items FOR EACH ROW EXECUTE FUNCTION frontdesk.order_items_lifecycle_guard();

-- ---------- discount approvals ----------
CREATE TABLE frontdesk.discount_approvals (
  id uuid NOT NULL, tenant_id uuid NOT NULL, centre_id uuid NOT NULL,
  requested_by_membership_id uuid NOT NULL,
  patient_id uuid,                                   -- NULL when the patient is new (draft_hash binds instead)
  draft_hash text,                                   -- sha256 hex of normalised new-patient draft
  base_fingerprint text NOT NULL,                    -- Quote.base_fingerprint: same lines with discounts [] (TRD §5.1)
  discounts jsonb NOT NULL,                          -- [DiscountInput] (schema in TRD §6.3)
  gross_paisa bigint NOT NULL, computed_discount_paisa bigint NOT NULL, percent_of_gross_bp integer NOT NULL,
  reason_code text NOT NULL, reason_text text,
  status text NOT NULL,
  decided_by_membership_id uuid, decided_at timestamptz, decision_note text,
  expires_at timestamptz NOT NULL,
  consumed_order_id uuid, consumed_at timestamptz,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT discount_approvals__pk PRIMARY KEY (id),
  CONSTRAINT discount_approvals__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT discount_approvals__centre__fk FOREIGN KEY (tenant_id, centre_id) REFERENCES core.collection_centres (tenant_id, id),
  CONSTRAINT discount_approvals__patient__fk FOREIGN KEY (tenant_id, patient_id) REFERENCES frontdesk.patients (tenant_id, id),
  CONSTRAINT discount_approvals__ref__ck CHECK ((patient_id IS NULL) <> (draft_hash IS NULL)),
  CONSTRAINT discount_approvals__fp__ck CHECK (base_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT discount_approvals__status__ck CHECK (status IN ('pending','approved','rejected','expired','consumed')),
  CONSTRAINT discount_approvals__decider__ck CHECK (decided_by_membership_id IS NULL OR decided_by_membership_id <> requested_by_membership_id),
  CONSTRAINT discount_approvals__consumed__ck CHECK ((status = 'consumed') = (consumed_order_id IS NOT NULL))
);
CREATE INDEX discount_approvals__tenant_id_status_centre_id__p_idx ON frontdesk.discount_approvals (tenant_id, status, centre_id, created_at)
  WHERE status IN ('pending','approved');
CREATE TRIGGER discount_approvals__mutable_columns BEFORE UPDATE ON frontdesk.discount_approvals FOR EACH ROW EXECUTE FUNCTION
  app.enforce_mutable_columns('status','decided_by_membership_id','decided_at','decision_note','consumed_order_id','consumed_at',
                              'is_active','updated_at','updated_by','version');
-- guard: pending→approved|rejected|expired; approved→consumed|expired; others terminal.
CREATE FUNCTION frontdesk.discount_approvals_lifecycle_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT coalesce((OLD.status = 'pending' AND NEW.status IN ('approved','rejected','expired'))
                      OR (OLD.status = 'approved' AND NEW.status IN ('consumed','expired')), false) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'frontdesk.discount_approvals';
  END IF;
  RETURN NEW;
END $$;
ALTER FUNCTION frontdesk.discount_approvals_lifecycle_guard() OWNER TO lims_owner;
CREATE TRIGGER discount_approvals__lifecycle_guard BEFORE UPDATE ON frontdesk.discount_approvals FOR EACH ROW EXECUTE FUNCTION frontdesk.discount_approvals_lifecycle_guard();

-- ---------- discounts ----------
CREATE TABLE frontdesk.discounts (
  id uuid NOT NULL, tenant_id uuid NOT NULL, order_id uuid NOT NULL, centre_id uuid NOT NULL,
  scope text NOT NULL, order_item_id uuid, kind text NOT NULL,
  amount_paisa bigint, percent_bp integer, computed_paisa bigint NOT NULL,
  reason_code text NOT NULL, reason_text text,
  approval_mode text NOT NULL, approval_id uuid,
  applied_by_membership_id uuid NOT NULL, approved_by_membership_id uuid NOT NULL,
  applied_at timestamptz NOT NULL,
  billing_document_id uuid,                         -- invoice id or credit-charge batch (plain uuid; no FK into billing)
  status text NOT NULL DEFAULT 'applied',
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT discounts__pk PRIMARY KEY (id),
  CONSTRAINT discounts__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT discounts__order__fk FOREIGN KEY (tenant_id, order_id) REFERENCES frontdesk.orders (tenant_id, id),
  CONSTRAINT discounts__item__fk FOREIGN KEY (tenant_id, order_item_id) REFERENCES frontdesk.order_items (tenant_id, id),
  CONSTRAINT discounts__approval__fk FOREIGN KEY (tenant_id, approval_id) REFERENCES frontdesk.discount_approvals (tenant_id, id),
  CONSTRAINT discounts__scope__ck CHECK ((scope = 'line' AND order_item_id IS NOT NULL) OR (scope = 'bill' AND order_item_id IS NULL)),
  CONSTRAINT discounts__kind__ck CHECK ((kind = 'amount' AND amount_paisa > 0 AND percent_bp IS NULL)
                                    OR (kind = 'percent' AND percent_bp BETWEEN 1 AND 10000 AND amount_paisa IS NULL)),
  CONSTRAINT discounts__computed__ck CHECK (computed_paisa >= 0),
  CONSTRAINT discounts__approval_mode__ck CHECK ((approval_mode = 'within_limit' AND approval_id IS NULL)
                                              OR (approval_mode = 'approved' AND approval_id IS NOT NULL)),
  CONSTRAINT discounts__status__ck CHECK (status IN ('applied','superseded')),
  CONSTRAINT discounts__reason_text__ck CHECK (reason_text IS NULL OR char_length(reason_text) <= 500)
);
CREATE INDEX discounts__tenant_id_order_id__idx ON frontdesk.discounts (tenant_id, order_id);
CREATE TRIGGER discounts__mutable_columns BEFORE UPDATE ON frontdesk.discounts FOR EACH ROW EXECUTE FUNCTION
  app.enforce_mutable_columns('status','is_active','updated_at','updated_by','version');

-- ---------- TRF attachments ----------
CREATE TABLE frontdesk.trf_attachments (
  id uuid NOT NULL, tenant_id uuid NOT NULL, centre_id uuid NOT NULL, order_id uuid,
  bucket text NOT NULL DEFAULT 'frontdesk-trf' CONSTRAINT trf_attachments__bucket__ck CHECK (bucket = 'frontdesk-trf'),   -- 08 R26
  object_path text NOT NULL,                          -- clean: '{tenant_id}/{yyyy}/{mm}/{id}'; quarantined: '{tenant_id}/q/{yyyy}/{mm}/{id}' (same layout as instruments-attachments, 03-IC §13.4)
  original_filename text,                             -- P2 metadata only (REQ-SEC-083)
  mime_type text NOT NULL, size_bytes bigint NOT NULL, sha256 text NOT NULL,
  scan_state text NOT NULL DEFAULT 'pending', scanned_at timestamptz, sanitized boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT trf_attachments__pk PRIMARY KEY (id),
  CONSTRAINT trf_attachments__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT trf_attachments__order__fk FOREIGN KEY (tenant_id, order_id) REFERENCES frontdesk.orders (tenant_id, id),
  CONSTRAINT trf_attachments__centre__fk FOREIGN KEY (tenant_id, centre_id) REFERENCES core.collection_centres (tenant_id, id),
  CONSTRAINT trf_attachments__mime__ck CHECK (mime_type IN ('application/pdf','image/jpeg','image/png')),
  CONSTRAINT trf_attachments__size__ck CHECK (size_bytes BETWEEN 1 AND 15728640),
  CONSTRAINT trf_attachments__sha__ck CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT trf_attachments__path__ck CHECK (split_part(object_path, '/', 1) = tenant_id::text),
  CONSTRAINT trf_attachments__scan__ck CHECK (scan_state IN ('pending','clean','quarantined','failed'))
);
CREATE INDEX trf_attachments__tenant_id_order_id__idx ON frontdesk.trf_attachments (tenant_id, order_id);
CREATE INDEX trf_attachments__tenant_id_drafts__p_idx ON frontdesk.trf_attachments (tenant_id, created_at) WHERE order_id IS NULL;
CREATE TRIGGER trf_attachments__mutable_columns BEFORE UPDATE ON frontdesk.trf_attachments FOR EACH ROW EXECUTE FUNCTION
  app.enforce_mutable_columns('order_id','object_path','scan_state','scanned_at','sanitized','is_active','updated_at','updated_by','version');
-- guard: order_id NULL→value once; scan_state pending→clean|quarantined|failed, failed→pending; quarantined terminal.
CREATE FUNCTION frontdesk.trf_attachments_lifecycle_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF OLD.order_id IS NOT NULL AND NEW.order_id IS DISTINCT FROM OLD.order_id THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'frontdesk.trf_attachments';
  END IF;
  IF NEW.scan_state IS DISTINCT FROM OLD.scan_state
     AND NOT coalesce((OLD.scan_state = 'pending' AND NEW.scan_state IN ('clean','quarantined','failed'))
                      OR (OLD.scan_state = 'failed' AND NEW.scan_state = 'pending'), false) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'frontdesk.trf_attachments';
  END IF;
  RETURN NEW;
END $$;
ALTER FUNCTION frontdesk.trf_attachments_lifecycle_guard() OWNER TO lims_owner;
CREATE TRIGGER trf_attachments__lifecycle_guard BEFORE UPDATE ON frontdesk.trf_attachments FOR EACH ROW EXECUTE FUNCTION frontdesk.trf_attachments_lifecycle_guard();

-- Draft purge (class E rows, order_id IS NULL). The worker task frontdesk.trf_draft_purge (per_tenant, tenant claims) first
-- deletes the storage objects of the selected drafts (ctx.storage.delete, E-class, P-12 a), then calls this function for those ids.
CREATE FUNCTION frontdesk.purge_trf_drafts(p_older_than interval, p_ids uuid[])
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_count integer;
BEGIN
  IF p_older_than IS NULL OR p_older_than < interval '1 hour' OR p_ids IS NULL OR cardinality(p_ids) > 1000 THEN
    RAISE EXCEPTION 'purge_trf_drafts_invalid_input';
  END IF;
  PERFORM set_config('app.maintenance', 'frontdesk_purge_trf_drafts', true);
  DELETE FROM frontdesk.trf_attachments t
   WHERE t.tenant_id = (SELECT app.current_tenant_id())
     AND t.id = ANY (p_ids) AND t.order_id IS NULL AND t.created_at < now() - p_older_than;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  PERFORM set_config('app.maintenance', '', true);
  RETURN v_count;
END $$;
ALTER FUNCTION frontdesk.purge_trf_drafts(interval, uuid[]) OWNER TO lims_owner;
REVOKE ALL ON FUNCTION frontdesk.purge_trf_drafts(interval, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION frontdesk.purge_trf_drafts(interval, uuid[]) TO lims_worker;
-- Owner policies (08 A10.5): FORCE RLS applies to lims_owner; narrowest USING the function needs.
CREATE POLICY trf_attachments__select__owner_only ON frontdesk.trf_attachments FOR SELECT TO lims_owner
  USING (current_setting('app.maintenance', true) = 'frontdesk_purge_trf_drafts'
         AND order_id IS NULL AND tenant_id = (SELECT app.current_tenant_id()));
CREATE POLICY trf_attachments__delete__owner_only ON frontdesk.trf_attachments FOR DELETE TO lims_owner
  USING (current_setting('app.maintenance', true) = 'frontdesk_purge_trf_drafts'
         AND order_id IS NULL AND tenant_id = (SELECT app.current_tenant_id()));
-- FORCE-RLS tests (A10.5/A12.7 pattern): (a) function deletes only expired drafts of the claimed tenant; (b) a lims_app session
-- that sets app.maintenance itself deletes/sees nothing through these policies; (c) app.maintenance is '' after return.

-- ---------- order flags ----------
CREATE TABLE frontdesk.order_flags (
  id uuid NOT NULL, tenant_id uuid NOT NULL, centre_id uuid NOT NULL, order_id uuid NOT NULL,
  kind text NOT NULL, specimen_id uuid, source_event_id uuid,
  status text NOT NULL DEFAULT 'open', resolution_code text, note text, resolved_at timestamptz, resolved_by uuid,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT order_flags__pk PRIMARY KEY (id),
  CONSTRAINT order_flags__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT order_flags__order__fk FOREIGN KEY (tenant_id, order_id) REFERENCES frontdesk.orders (tenant_id, id),
  CONSTRAINT order_flags__kind__ck CHECK (kind IN ('recollection_required','booking_cancelled_after_registration')),
  CONSTRAINT order_flags__status__ck CHECK (status IN ('open','resolved')),
  CONSTRAINT order_flags__specimen__ck CHECK ((kind = 'recollection_required') = (specimen_id IS NOT NULL))
);
CREATE UNIQUE INDEX order_flags__tenant_id_kind_specimen__p_uq ON frontdesk.order_flags (tenant_id, kind, specimen_id) WHERE specimen_id IS NOT NULL;
CREATE UNIQUE INDEX order_flags__tenant_id_kind_order__p_uq ON frontdesk.order_flags (tenant_id, kind, order_id) WHERE specimen_id IS NULL;
CREATE INDEX order_flags__tenant_id_status_centre_id__p_idx ON frontdesk.order_flags (tenant_id, status, centre_id, created_at) WHERE status = 'open';

-- ---------- booking links ----------
CREATE TABLE frontdesk.booking_links (
  tenant_id uuid NOT NULL, source text NOT NULL, source_ref_id uuid NOT NULL,
  order_id uuid, idempotency_key text, state text NOT NULL, last_seq integer NOT NULL,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT booking_links__pk PRIMARY KEY (tenant_id, source, source_ref_id),
  CONSTRAINT booking_links__order__fk FOREIGN KEY (tenant_id, order_id) REFERENCES frontdesk.orders (tenant_id, id),
  CONSTRAINT booking_links__source__ck CHECK (source IN ('engagement_booking','home_collection','partner_manifest')),
  CONSTRAINT booking_links__state__ck CHECK (state IN ('converted','cancelled')),
  CONSTRAINT booking_links__key__ck CHECK (idempotency_key IS NULL OR char_length(idempotency_key) <= 200)
);

-- ---------- coded sets ----------
CREATE TABLE frontdesk.g_cs_reasons (
  set_name text NOT NULL, code text NOT NULL, display text NOT NULL, sort_order integer NOT NULL,
  requires_text boolean NOT NULL DEFAULT false, is_active boolean NOT NULL DEFAULT true,
  id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT g_cs_reasons__pk PRIMARY KEY (set_name, code),
  CONSTRAINT g_cs_reasons__set__ck CHECK (set_name IN ('order_cancel_reasons','item_removal_reasons','discount_reasons',
             'duplicate_override_reasons','anonymise_reasons','flag_resolutions'))
);
CREATE TABLE frontdesk.cs_reasons (
  tenant_id uuid NOT NULL, set_name text NOT NULL, code text NOT NULL, display text NOT NULL, sort_order integer NOT NULL,
  requires_text boolean NOT NULL DEFAULT false,
  id uuid NOT NULL, version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT cs_reasons__pk PRIMARY KEY (tenant_id, set_name, code),
  CONSTRAINT cs_reasons__code__ck CHECK (code ~ '^[a-z0-9_]{1,64}$')
);
-- frontdesk.event_inbox: exactly per 03-IC §12 (C0 platform template).

-- =====================================================================
-- §4a RLS, policies and grants (frontdesk)
-- =====================================================================
-- T (tenant)
ALTER TABLE frontdesk.settings ENABLE ROW LEVEL SECURITY;  ALTER TABLE frontdesk.settings FORCE ROW LEVEL SECURITY;
CREATE POLICY settings__select__tenant ON frontdesk.settings FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY settings__insert__tenant ON frontdesk.settings FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY settings__update__tenant ON frontdesk.settings FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
GRANT SELECT, INSERT, UPDATE ON frontdesk.settings TO lims_app;
ALTER TABLE frontdesk.number_counters ENABLE ROW LEVEL SECURITY;  ALTER TABLE frontdesk.number_counters FORCE ROW LEVEL SECURITY;
CREATE POLICY number_counters__select__tenant ON frontdesk.number_counters FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY number_counters__insert__tenant ON frontdesk.number_counters FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY number_counters__update__tenant ON frontdesk.number_counters FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
GRANT SELECT, INSERT, UPDATE ON frontdesk.number_counters TO lims_app;
ALTER TABLE frontdesk.booking_links ENABLE ROW LEVEL SECURITY;  ALTER TABLE frontdesk.booking_links FORCE ROW LEVEL SECURITY;
CREATE POLICY booking_links__select__tenant ON frontdesk.booking_links FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY booking_links__insert__tenant ON frontdesk.booking_links FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY booking_links__update__tenant ON frontdesk.booking_links FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
GRANT SELECT, INSERT, UPDATE ON frontdesk.booking_links TO lims_app;
ALTER TABLE frontdesk.cs_reasons ENABLE ROW LEVEL SECURITY;  ALTER TABLE frontdesk.cs_reasons FORCE ROW LEVEL SECURITY;
CREATE POLICY cs_reasons__select__tenant ON frontdesk.cs_reasons FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY cs_reasons__insert__tenant ON frontdesk.cs_reasons FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY cs_reasons__update__tenant ON frontdesk.cs_reasons FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
GRANT SELECT, INSERT, UPDATE ON frontdesk.cs_reasons TO lims_app;
ALTER TABLE frontdesk.patients ENABLE ROW LEVEL SECURITY;  ALTER TABLE frontdesk.patients FORCE ROW LEVEL SECURITY;
CREATE POLICY patients__select__tenant ON frontdesk.patients FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY patients__insert__tenant ON frontdesk.patients FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY patients__update__tenant ON frontdesk.patients FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
GRANT SELECT, INSERT, UPDATE ON frontdesk.patients TO lims_app;
ALTER TABLE frontdesk.patient_consents ENABLE ROW LEVEL SECURITY;  ALTER TABLE frontdesk.patient_consents FORCE ROW LEVEL SECURITY;
CREATE POLICY patient_consents__select__tenant ON frontdesk.patient_consents FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY patient_consents__insert__tenant ON frontdesk.patient_consents FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
GRANT SELECT, INSERT ON frontdesk.patient_consents TO lims_app;
-- TC (tenant_centre; 02-CV §5.8 template, 08 A16.1 cast)
ALTER TABLE frontdesk.orders ENABLE ROW LEVEL SECURITY;  ALTER TABLE frontdesk.orders FORCE ROW LEVEL SECURITY;
CREATE POLICY orders__select__tenant_centre ON frontdesk.orders FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY orders__insert__tenant_centre ON frontdesk.orders FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY orders__update__tenant_centre ON frontdesk.orders FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
GRANT SELECT, INSERT, UPDATE ON frontdesk.orders TO lims_app;
ALTER TABLE frontdesk.order_items ENABLE ROW LEVEL SECURITY;  ALTER TABLE frontdesk.order_items FORCE ROW LEVEL SECURITY;
CREATE POLICY order_items__select__tenant_centre ON frontdesk.order_items FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY order_items__insert__tenant_centre ON frontdesk.order_items FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY order_items__update__tenant_centre ON frontdesk.order_items FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
GRANT SELECT, INSERT, UPDATE ON frontdesk.order_items TO lims_app;
ALTER TABLE frontdesk.discounts ENABLE ROW LEVEL SECURITY;  ALTER TABLE frontdesk.discounts FORCE ROW LEVEL SECURITY;
CREATE POLICY discounts__select__tenant_centre ON frontdesk.discounts FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY discounts__insert__tenant_centre ON frontdesk.discounts FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY discounts__update__tenant_centre ON frontdesk.discounts FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
GRANT SELECT, INSERT, UPDATE ON frontdesk.discounts TO lims_app;
ALTER TABLE frontdesk.discount_approvals ENABLE ROW LEVEL SECURITY;  ALTER TABLE frontdesk.discount_approvals FORCE ROW LEVEL SECURITY;
CREATE POLICY discount_approvals__select__tenant_centre ON frontdesk.discount_approvals FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY discount_approvals__insert__tenant_centre ON frontdesk.discount_approvals FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY discount_approvals__update__tenant_centre ON frontdesk.discount_approvals FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
GRANT SELECT, INSERT, UPDATE ON frontdesk.discount_approvals TO lims_app;
ALTER TABLE frontdesk.trf_attachments ENABLE ROW LEVEL SECURITY;  ALTER TABLE frontdesk.trf_attachments FORCE ROW LEVEL SECURITY;
CREATE POLICY trf_attachments__select__tenant_centre ON frontdesk.trf_attachments FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY trf_attachments__insert__tenant_centre ON frontdesk.trf_attachments FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY trf_attachments__update__tenant_centre ON frontdesk.trf_attachments FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
GRANT SELECT, INSERT, UPDATE ON frontdesk.trf_attachments TO lims_app;
ALTER TABLE frontdesk.order_flags ENABLE ROW LEVEL SECURITY;  ALTER TABLE frontdesk.order_flags FORCE ROW LEVEL SECURITY;
CREATE POLICY order_flags__select__tenant_centre ON frontdesk.order_flags FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY order_flags__insert__tenant_centre ON frontdesk.order_flags FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY order_flags__update__tenant_centre ON frontdesk.order_flags FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
GRANT SELECT, INSERT, UPDATE ON frontdesk.order_flags TO lims_app;
-- G tables: no tenant data, no RLS (02-CV §5.2)
GRANT SELECT ON frontdesk.g_cs_reasons TO lims_app;

-- =====================================================================
-- Row audit (C0 app.tg_row_audit; AC-0B-5.x)
-- =====================================================================
CREATE TRIGGER settings__audit AFTER INSERT OR UPDATE OR DELETE ON frontdesk.settings FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER number_counters__audit AFTER INSERT OR UPDATE OR DELETE ON frontdesk.number_counters FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER patients__audit AFTER INSERT OR UPDATE OR DELETE ON frontdesk.patients FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit('full_name', 'name_search', 'birth_on', 'phone_e164', 'email', 'address_text');
CREATE TRIGGER orders__audit AFTER INSERT OR UPDATE OR DELETE ON frontdesk.orders FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER order_items__audit AFTER INSERT OR UPDATE OR DELETE ON frontdesk.order_items FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER discount_approvals__audit AFTER INSERT OR UPDATE OR DELETE ON frontdesk.discount_approvals FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER discounts__audit AFTER INSERT OR UPDATE OR DELETE ON frontdesk.discounts FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER trf_attachments__audit AFTER INSERT OR UPDATE OR DELETE ON frontdesk.trf_attachments FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER order_flags__audit AFTER INSERT OR UPDATE OR DELETE ON frontdesk.order_flags FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER booking_links__audit AFTER INSERT OR UPDATE OR DELETE ON frontdesk.booking_links FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER cs_reasons__audit AFTER INSERT OR UPDATE OR DELETE ON frontdesk.cs_reasons FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();

-- =====================================================================
-- §6 published views (frontdesk)
-- =====================================================================
-- frontdesk
CREATE VIEW frontdesk.v_pub_order_daily WITH (security_invoker = true) AS
SELECT o.tenant_id, o.branch_id, o.centre_id,
       (o.registered_at AT TIME ZONE 'Asia/Kathmandu')::date AS business_date,
       count(*)                                             AS orders_registered,
       count(DISTINCT o.patient_id)                         AS patients_distinct,
       count(DISTINCT o.patient_id) FILTER (WHERE o.is_first_order_of_patient) AS new_patients,
       count(*) FILTER (WHERE o.priority = 'urgent')        AS urgent_orders,
       count(*) FILTER (WHERE o.status = 'cancelled')       AS cancelled_orders,
       count(*) FILTER (WHERE o.visit_type = 'opd')         AS opd_orders,
       count(*) FILTER (WHERE o.visit_type = 'ipd')         AS ipd_orders
FROM frontdesk.orders o WHERE o.registered_at IS NOT NULL
GROUP BY 1,2,3,4;
CREATE VIEW frontdesk.v_pub_referrer_volume WITH (security_invoker = true) AS
SELECT o.tenant_id, (o.registered_at AT TIME ZONE 'Asia/Kathmandu')::date AS business_date,
       o.branch_id, o.centre_id, o.referrer_id,
       count(DISTINCT o.id) AS orders, count(DISTINCT o.patient_id) AS patients_distinct,
       count(i.id) FILTER (WHERE i.status = 'active') AS order_items
FROM frontdesk.orders o LEFT JOIN frontdesk.order_items i ON i.tenant_id = o.tenant_id AND i.order_id = o.id
WHERE o.registered_at IS NOT NULL AND o.status <> 'cancelled'
GROUP BY 1,2,3,4,5;
CREATE VIEW frontdesk.v_pub_centre_volume WITH (security_invoker = true) AS
SELECT o.tenant_id, (o.registered_at AT TIME ZONE 'Asia/Kathmandu')::date AS business_date,
       o.branch_id, o.centre_id, o.collection_mode,
       count(DISTINCT o.id) AS orders, count(DISTINCT o.patient_id) AS patients_distinct,
       count(i.id) FILTER (WHERE i.status = 'active') AS order_items
FROM frontdesk.orders o LEFT JOIN frontdesk.order_items i ON i.tenant_id = o.tenant_id AND i.order_id = o.id
WHERE o.registered_at IS NOT NULL AND o.status <> 'cancelled'
GROUP BY 1,2,3,4,5;
CREATE VIEW frontdesk.v_pub_order_status WITH (security_invoker = true) AS
SELECT o.tenant_id, o.id AS order_id, o.patient_id, o.centre_id, o.branch_id, o.source, o.source_ref_id,
       o.partner_id, o.status, o.registered_at, o.updated_at
FROM frontdesk.orders o;
GRANT SELECT ON frontdesk.v_pub_order_daily, frontdesk.v_pub_referrer_volume, frontdesk.v_pub_centre_volume,
  frontdesk.v_pub_order_status TO lims_app;
