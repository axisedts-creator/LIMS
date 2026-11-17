-- T0C-REGPARITY-2 (LD-310; founder request 2026-11-17 04:49 + 05:00 NPT: all ElabAssist registration and billing functions; LD-310 (b): Nepal equivalents, external_reference instead of the India form number)
-- (a) Additive nullable columns, no default:
--   frontdesk.orders: collection_at, collected_by_membership_id (staff), collected_by_name (outside collector), sample_not_collected, sample_remark, remark_description,
--     clinical_history, patient_history, mr_number, external_reference, insurance_code, insurance_claim_amount_paisa, visiting_charge_paisa, coupon_code,
--     coupon_amount_paisa (server-derived from the coupon);
--   frontdesk.order_items: icd_code (snapshot of the code, per order line);
--   billing.ledger_entries: card_holder_name, payment_remark.
--   Every column is nullable with no default, so ADD COLUMN is catalog-only: no data rewrite, old rows and old inserts unchanged.
-- (b) Six new tenant tables, RLS ENABLE + FORCE by tenant like frontdesk.patients (tenant_id = app.current_tenant_id() AND staff or system actor), TO lims_app only:
--   frontdesk.coupons (code, amount_paisa or percent, valid_from / valid_to, usage_limit, used_count; used_count <= usage_limit is a CHECK so concurrent redemption cannot overshoot),
--   frontdesk.icd_codes (code, description, is_active), frontdesk.custom_field_definitions (field_key, label, field_type text|number|date|choice, required, is_active;
--   frontdesk.patients.custom_fields is validated against them by the service), frontdesk.reward_points_ledger (append-only: SELECT + INSERT only; earned | redeemed points
--   per patient and order), frontdesk.registration_drafts (per user, payload JSON object <= 1 MiB, expires_at = updated_at + 14 days; the service refreshes expires_at on
--   save and purges expired rows), frontdesk.favourite_tests (per user, unique per orderable).
--   The per-user filter of drafts and favourites is a service rule (T0B-REGAPI-*); RLS isolates tenants.
-- (c) SENSITIVE: card_holder_name is personal data (never in logs or audit diffs; billing.ledger_entries has no row-audit trigger). clinical_history and patient_history are
--   health text (D-27a): they join the orders__audit exclusion list. Drafts payload holds patient data: drafts and favourites get no audit trigger (ephemeral rows).
-- Idempotent: IF NOT EXISTS everywhere, column constraints inline in the guarded ADD COLUMN, composite FKs in DO blocks that check pg_constraint, DROP POLICY IF EXISTS before
--   each CREATE POLICY, triggers CREATE OR REPLACE. No sequences, no ENUM types, no default on id / tenant_id (UUIDv7 in app code).
-- Cloud apply is a founder step (push-cloud.ps1, LD-310 (e)), not done by this task.
-- DOWN (manual, never automatic; DROP TABLE / DROP COLUMN destroy entered data: founder decision, export first):
--   CREATE OR REPLACE TRIGGER orders__audit AFTER INSERT OR UPDATE OR DELETE ON frontdesk.orders FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
--   DROP TABLE IF EXISTS frontdesk.reward_points_ledger, frontdesk.registration_drafts, frontdesk.favourite_tests, frontdesk.custom_field_definitions,
--     frontdesk.coupons, frontdesk.icd_codes;
--   ALTER TABLE frontdesk.orders DROP CONSTRAINT IF EXISTS orders__collected_by__fk, DROP COLUMN IF EXISTS collection_at, DROP COLUMN IF EXISTS collected_by_membership_id,
--     DROP COLUMN IF EXISTS collected_by_name, DROP COLUMN IF EXISTS sample_not_collected, DROP COLUMN IF EXISTS sample_remark, DROP COLUMN IF EXISTS remark_description,
--     DROP COLUMN IF EXISTS clinical_history, DROP COLUMN IF EXISTS patient_history, DROP COLUMN IF EXISTS mr_number, DROP COLUMN IF EXISTS external_reference,
--     DROP COLUMN IF EXISTS insurance_code, DROP COLUMN IF EXISTS insurance_claim_amount_paisa, DROP COLUMN IF EXISTS visiting_charge_paisa,
--     DROP COLUMN IF EXISTS coupon_code, DROP COLUMN IF EXISTS coupon_amount_paisa;
--   ALTER TABLE frontdesk.order_items DROP COLUMN IF EXISTS icd_code;
--   ALTER TABLE billing.ledger_entries DROP COLUMN IF EXISTS card_holder_name, DROP COLUMN IF EXISTS payment_remark;
SET LOCAL ROLE lims_owner;

-- ---------- (a) additive columns ----------
ALTER TABLE frontdesk.orders
  ADD COLUMN IF NOT EXISTS collection_at timestamptz,
  ADD COLUMN IF NOT EXISTS collected_by_membership_id uuid,
  ADD COLUMN IF NOT EXISTS collected_by_name text CONSTRAINT orders__collected_by_name__ck CHECK (char_length(collected_by_name) BETWEEN 1 AND 200),
  ADD COLUMN IF NOT EXISTS sample_not_collected boolean,
  ADD COLUMN IF NOT EXISTS sample_remark text CONSTRAINT orders__sample_remark__ck CHECK (char_length(sample_remark) BETWEEN 1 AND 500),
  ADD COLUMN IF NOT EXISTS remark_description text CONSTRAINT orders__remark_description__ck CHECK (char_length(remark_description) BETWEEN 1 AND 1000),
  ADD COLUMN IF NOT EXISTS clinical_history text CONSTRAINT orders__clinical_history__ck CHECK (char_length(clinical_history) BETWEEN 1 AND 4000),
  ADD COLUMN IF NOT EXISTS patient_history text CONSTRAINT orders__patient_history__ck CHECK (char_length(patient_history) BETWEEN 1 AND 4000),
  ADD COLUMN IF NOT EXISTS mr_number text CONSTRAINT orders__mr_number__ck CHECK (char_length(mr_number) BETWEEN 1 AND 64),
  ADD COLUMN IF NOT EXISTS external_reference text CONSTRAINT orders__external_reference__ck CHECK (char_length(external_reference) BETWEEN 1 AND 64),
  ADD COLUMN IF NOT EXISTS insurance_code text CONSTRAINT orders__insurance_code__ck CHECK (char_length(insurance_code) BETWEEN 1 AND 64),
  ADD COLUMN IF NOT EXISTS insurance_claim_amount_paisa bigint CONSTRAINT orders__insurance_claim_amount__ck CHECK (insurance_claim_amount_paisa >= 0),
  ADD COLUMN IF NOT EXISTS visiting_charge_paisa bigint CONSTRAINT orders__visiting_charge__ck CHECK (visiting_charge_paisa >= 0),
  ADD COLUMN IF NOT EXISTS coupon_code text CONSTRAINT orders__coupon_code__ck CHECK (coupon_code ~ '^[A-Z0-9][A-Z0-9_-]{0,31}$'),
  ADD COLUMN IF NOT EXISTS coupon_amount_paisa bigint CONSTRAINT orders__coupon_amount__ck CHECK (coupon_amount_paisa >= 0);

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'frontdesk.orders'::regclass AND conname = 'orders__collected_by__fk') THEN
    ALTER TABLE frontdesk.orders ADD CONSTRAINT orders__collected_by__fk FOREIGN KEY (tenant_id, collected_by_membership_id) REFERENCES core.memberships (tenant_id, id);
  END IF;
END $do$;

ALTER TABLE frontdesk.order_items
  ADD COLUMN IF NOT EXISTS icd_code text CONSTRAINT order_items__icd_code__ck CHECK (icd_code ~ '^[0-9A-Z][0-9A-Z.]{0,15}$');

ALTER TABLE billing.ledger_entries
  ADD COLUMN IF NOT EXISTS card_holder_name text CONSTRAINT ledger_entries__card_holder_name__ck CHECK (char_length(card_holder_name) BETWEEN 1 AND 100),
  ADD COLUMN IF NOT EXISTS payment_remark text CONSTRAINT ledger_entries__payment_remark__ck CHECK (char_length(payment_remark) BETWEEN 1 AND 300);

-- D-27a exclusion list extended (LD-310): health text never enters audit.audit_log
CREATE OR REPLACE TRIGGER orders__audit AFTER INSERT OR UPDATE OR DELETE ON frontdesk.orders FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit('clinical_history', 'patient_history');

-- ---------- (b) coupons ----------
CREATE TABLE IF NOT EXISTS frontdesk.coupons (
  id uuid NOT NULL, tenant_id uuid NOT NULL,
  code         text     NOT NULL,                 -- upper case, so the per-tenant UNIQUE is case-insensitive
  amount_paisa bigint,
  percent      smallint,
  valid_from   date,
  valid_to     date,
  usage_limit  integer,                           -- NULL = unlimited
  used_count   integer  NOT NULL DEFAULT 0,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT coupons__pk PRIMARY KEY (id),
  CONSTRAINT coupons__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT coupons__tenant_id_code__uq UNIQUE (tenant_id, code),
  CONSTRAINT coupons__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT coupons__code__ck CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{0,31}$'),
  CONSTRAINT coupons__value__ck CHECK ((amount_paisa IS NULL) <> (percent IS NULL) AND (amount_paisa IS NULL OR amount_paisa > 0) AND (percent IS NULL OR percent BETWEEN 1 AND 100)),
  CONSTRAINT coupons__dates__ck CHECK (valid_from IS NULL OR valid_to IS NULL OR valid_to >= valid_from),
  CONSTRAINT coupons__usage__ck CHECK ((usage_limit IS NULL OR usage_limit > 0) AND used_count >= 0 AND (usage_limit IS NULL OR used_count <= usage_limit))
);

-- ---------- (b) icd master ----------
CREATE TABLE IF NOT EXISTS frontdesk.icd_codes (
  id uuid NOT NULL, tenant_id uuid NOT NULL,
  code        text NOT NULL,                      -- upper case (A09, E11.9)
  description text NOT NULL,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT icd_codes__pk PRIMARY KEY (id),
  CONSTRAINT icd_codes__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT icd_codes__tenant_id_code__uq UNIQUE (tenant_id, code),
  CONSTRAINT icd_codes__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT icd_codes__code__ck CHECK (code ~ '^[0-9A-Z][0-9A-Z.]{0,15}$'),
  CONSTRAINT icd_codes__description__ck CHECK (char_length(description) BETWEEN 1 AND 500)
);

-- ---------- (b) custom field definitions ----------
CREATE TABLE IF NOT EXISTS frontdesk.custom_field_definitions (
  id uuid NOT NULL, tenant_id uuid NOT NULL,
  field_key  text    NOT NULL,                    -- = PatientCustomField.code; never changes
  label      text    NOT NULL,
  field_type text    NOT NULL,                    -- never changes
  required   boolean NOT NULL DEFAULT false,
  choices    jsonb,                               -- array of labels, field_type = choice (service rule)
  sort_order integer NOT NULL DEFAULT 0,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT custom_field_definitions__pk PRIMARY KEY (id),
  CONSTRAINT custom_field_definitions__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT custom_field_definitions__tenant_id_field_key__uq UNIQUE (tenant_id, field_key),
  CONSTRAINT custom_field_definitions__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT custom_field_definitions__field_key__ck CHECK (field_key ~ '^[a-z][a-z0-9_]{0,63}$'),
  CONSTRAINT custom_field_definitions__label__ck CHECK (char_length(label) BETWEEN 1 AND 100),
  CONSTRAINT custom_field_definitions__field_type__ck CHECK (field_type IN ('text','number','date','choice')),
  CONSTRAINT custom_field_definitions__choices__ck CHECK (choices IS NULL OR (jsonb_typeof(choices) = 'array' AND jsonb_array_length(choices) BETWEEN 1 AND 50)),
  CONSTRAINT custom_field_definitions__sort_order__ck CHECK (sort_order BETWEEN 0 AND 1000)
);

-- ---------- (b) reward points ledger (append-only) ----------
CREATE TABLE IF NOT EXISTS frontdesk.reward_points_ledger (
  id uuid NOT NULL, tenant_id uuid NOT NULL,
  patient_id uuid    NOT NULL,
  order_id   uuid    NOT NULL,
  entry_kind text    NOT NULL,
  points     integer NOT NULL,                    -- always positive; balance = sum(earned) - sum(redeemed)
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  CONSTRAINT reward_points_ledger__pk PRIMARY KEY (id),
  CONSTRAINT reward_points_ledger__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT reward_points_ledger__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT reward_points_ledger__patient__fk FOREIGN KEY (tenant_id, patient_id) REFERENCES frontdesk.patients (tenant_id, id),
  CONSTRAINT reward_points_ledger__order__fk FOREIGN KEY (tenant_id, order_id) REFERENCES frontdesk.orders (tenant_id, id),
  CONSTRAINT reward_points_ledger__kind__ck CHECK (entry_kind IN ('earned','redeemed')),
  CONSTRAINT reward_points_ledger__points__ck CHECK (points > 0)
);
CREATE INDEX IF NOT EXISTS reward_points_ledger__tenant_id_patient_id_created_at__idx ON frontdesk.reward_points_ledger (tenant_id, patient_id, created_at DESC);
CREATE INDEX IF NOT EXISTS reward_points_ledger__tenant_id_order_id__idx ON frontdesk.reward_points_ledger (tenant_id, order_id);

-- ---------- (b) registration drafts (14 days) ----------
CREATE TABLE IF NOT EXISTS frontdesk.registration_drafts (
  id uuid NOT NULL, tenant_id uuid NOT NULL,
  user_id    uuid        NOT NULL,                -- membership of the caller (service sets it from the token)
  centre_id  uuid        NOT NULL,
  payload    jsonb       NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '14 days'),
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT registration_drafts__pk PRIMARY KEY (id),
  CONSTRAINT registration_drafts__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT registration_drafts__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT registration_drafts__centre__fk FOREIGN KEY (tenant_id, centre_id) REFERENCES core.collection_centres (tenant_id, id),
  CONSTRAINT registration_drafts__payload__ck CHECK (jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 1048576)
);
CREATE INDEX IF NOT EXISTS registration_drafts__tenant_id_user_id_updated_at__idx ON frontdesk.registration_drafts (tenant_id, user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS registration_drafts__tenant_id_expires_at__idx ON frontdesk.registration_drafts (tenant_id, expires_at);   -- 14 day purge scan

-- ---------- (b) favourite tests ----------
CREATE TABLE IF NOT EXISTS frontdesk.favourite_tests (
  id uuid NOT NULL, tenant_id uuid NOT NULL,
  user_id      uuid NOT NULL,                     -- membership of the caller
  orderable_id uuid NOT NULL,                     -- catalog orderable (no cross-module FK)
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT favourite_tests__pk PRIMARY KEY (id),
  CONSTRAINT favourite_tests__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT favourite_tests__tenant_id_user_id_orderable_id__uq UNIQUE (tenant_id, user_id, orderable_id),
  CONSTRAINT favourite_tests__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id)
);

-- ---------- RLS (tenant, like frontdesk.patients), policies, grants ----------
ALTER TABLE frontdesk.coupons ENABLE ROW LEVEL SECURITY;  ALTER TABLE frontdesk.coupons FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS coupons__select__tenant ON frontdesk.coupons;
CREATE POLICY coupons__select__tenant ON frontdesk.coupons FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
DROP POLICY IF EXISTS coupons__insert__tenant ON frontdesk.coupons;
CREATE POLICY coupons__insert__tenant ON frontdesk.coupons FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
DROP POLICY IF EXISTS coupons__update__tenant ON frontdesk.coupons;
CREATE POLICY coupons__update__tenant ON frontdesk.coupons FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
GRANT SELECT, INSERT, UPDATE ON frontdesk.coupons TO lims_app;

ALTER TABLE frontdesk.icd_codes ENABLE ROW LEVEL SECURITY;  ALTER TABLE frontdesk.icd_codes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS icd_codes__select__tenant ON frontdesk.icd_codes;
CREATE POLICY icd_codes__select__tenant ON frontdesk.icd_codes FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
DROP POLICY IF EXISTS icd_codes__insert__tenant ON frontdesk.icd_codes;
CREATE POLICY icd_codes__insert__tenant ON frontdesk.icd_codes FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
DROP POLICY IF EXISTS icd_codes__update__tenant ON frontdesk.icd_codes;
CREATE POLICY icd_codes__update__tenant ON frontdesk.icd_codes FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
GRANT SELECT, INSERT, UPDATE ON frontdesk.icd_codes TO lims_app;

ALTER TABLE frontdesk.custom_field_definitions ENABLE ROW LEVEL SECURITY;  ALTER TABLE frontdesk.custom_field_definitions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS custom_field_definitions__select__tenant ON frontdesk.custom_field_definitions;
CREATE POLICY custom_field_definitions__select__tenant ON frontdesk.custom_field_definitions FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
DROP POLICY IF EXISTS custom_field_definitions__insert__tenant ON frontdesk.custom_field_definitions;
CREATE POLICY custom_field_definitions__insert__tenant ON frontdesk.custom_field_definitions FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
DROP POLICY IF EXISTS custom_field_definitions__update__tenant ON frontdesk.custom_field_definitions;
CREATE POLICY custom_field_definitions__update__tenant ON frontdesk.custom_field_definitions FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
GRANT SELECT, INSERT, UPDATE ON frontdesk.custom_field_definitions TO lims_app;

ALTER TABLE frontdesk.reward_points_ledger ENABLE ROW LEVEL SECURITY;  ALTER TABLE frontdesk.reward_points_ledger FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS reward_points_ledger__select__tenant ON frontdesk.reward_points_ledger;
CREATE POLICY reward_points_ledger__select__tenant ON frontdesk.reward_points_ledger FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
DROP POLICY IF EXISTS reward_points_ledger__insert__tenant ON frontdesk.reward_points_ledger;
CREATE POLICY reward_points_ledger__insert__tenant ON frontdesk.reward_points_ledger FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
GRANT SELECT, INSERT ON frontdesk.reward_points_ledger TO lims_app;

ALTER TABLE frontdesk.registration_drafts ENABLE ROW LEVEL SECURITY;  ALTER TABLE frontdesk.registration_drafts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS registration_drafts__select__tenant ON frontdesk.registration_drafts;
CREATE POLICY registration_drafts__select__tenant ON frontdesk.registration_drafts FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
DROP POLICY IF EXISTS registration_drafts__insert__tenant ON frontdesk.registration_drafts;
CREATE POLICY registration_drafts__insert__tenant ON frontdesk.registration_drafts FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
DROP POLICY IF EXISTS registration_drafts__update__tenant ON frontdesk.registration_drafts;
CREATE POLICY registration_drafts__update__tenant ON frontdesk.registration_drafts FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
DROP POLICY IF EXISTS registration_drafts__delete__tenant ON frontdesk.registration_drafts;
CREATE POLICY registration_drafts__delete__tenant ON frontdesk.registration_drafts FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
GRANT SELECT, INSERT, UPDATE, DELETE ON frontdesk.registration_drafts TO lims_app;

ALTER TABLE frontdesk.favourite_tests ENABLE ROW LEVEL SECURITY;  ALTER TABLE frontdesk.favourite_tests FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS favourite_tests__select__tenant ON frontdesk.favourite_tests;
CREATE POLICY favourite_tests__select__tenant ON frontdesk.favourite_tests FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
DROP POLICY IF EXISTS favourite_tests__insert__tenant ON frontdesk.favourite_tests;
CREATE POLICY favourite_tests__insert__tenant ON frontdesk.favourite_tests FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
DROP POLICY IF EXISTS favourite_tests__delete__tenant ON frontdesk.favourite_tests;
CREATE POLICY favourite_tests__delete__tenant ON frontdesk.favourite_tests FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
GRANT SELECT, INSERT, DELETE ON frontdesk.favourite_tests TO lims_app;

-- ---------- row audit: master data and the points ledger (drafts / favourites are ephemeral, no trigger) ----------
CREATE OR REPLACE TRIGGER coupons__audit AFTER INSERT OR UPDATE OR DELETE ON frontdesk.coupons FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE OR REPLACE TRIGGER icd_codes__audit AFTER INSERT OR UPDATE OR DELETE ON frontdesk.icd_codes FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE OR REPLACE TRIGGER custom_field_definitions__audit AFTER INSERT OR UPDATE OR DELETE ON frontdesk.custom_field_definitions FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE OR REPLACE TRIGGER reward_points_ledger__audit AFTER INSERT OR UPDATE OR DELETE ON frontdesk.reward_points_ledger FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
