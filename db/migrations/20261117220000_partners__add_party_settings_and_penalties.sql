-- T0C-PARTYSET-1 (LD-321, LD-325; founder blanket authority LD-310; founder priority 2026-11-17 09:18 NPT): per party commercial settings, the onboarding
-- approval queue, non compliance penalties and their events in schema partners, a per tenant ICD master in schema catalog, government ID numbers on
-- partners and doctors, and the doctor master parity fields. The LIMS split party model (partner, credit party, doctor, referrer) is kept; attributes are added.
-- New tenant tables (deactivate, never delete: lims_app has SELECT, INSERT, UPDATE only and no DELETE policy):
--   partners.party_commercial_setting  one row per party (party_kind + party_id, polymorphic, service checked): auto_release_reports, whatsapp_enabled,
--                                      insurance_enabled, print_exception, auto_block_overdue, lab_number_scheme_code (plain code; the offline number blocks
--                                      belong to the offline wave), billing_cycle, invoice_payment_days / invoice_blocking_days / invoice_warning_days 0..365,
--                                      interest_bp_per_day / commission_bp / tds_bp 0..10000 (tds_bp default 0), priority P1..P5, header_footer_mode.
--                                      Interest per day is a statement line only, never posted automatically (LD-321).
--   partners.party_onboarding          approval queue: pending -> approved | held | rejected, held -> approved | rejected; approved and rejected are final
--                                      (BEFORE UPDATE trigger); held and rejected need a reason; pending <=> no decided_at / decided_by (CHECK).
--   partners.non_compliance_penalty    code (unique per tenant), name, amount_paisa >= 0, is_active.
--   partners.non_compliance_event      party_kind + party_id, penalty_id (composite tenant FK), event_date, amount_paisa, reason, status raised -> waived | charged
--                                      only (BEFORE UPDATE trigger); charged <=> ledger_entry_id set; UNIQUE (tenant_id, ledger_entry_id) = one ledger entry,
--                                      charged once; a decided event keeps its ledger_entry_id, amount and party for good.
--   catalog.icd_code                   per tenant ICD master: code (unique per tenant), title, chapter, is_active. Separate from frontdesk.icd_codes (the
--                                      registration pick list of T0C-REGPARITY), which stays untouched.
-- New columns (ADD COLUMN IF NOT EXISTS, nullable, no DEFAULT, so no rewrite of old rows):
--   partners.partners  tax_number (PAN), national_id_number            catalog.doctors  speciality, hospital, commission_bp, national_id_number
-- Government ID numbers (tax_number, national_id_number, credit party pan) are masked in every API read (last four characters only); the full value needs
-- partners.party_id_number.read and every full read writes an audit event (service, T0B-PARTYSET-1). The values never reach audit.audit_log: the audit
-- triggers partners__audit, doctors__audit and credit_parties__audit are re-created with the ID columns as excluded arguments (CR-C15-013).
-- Retention of PAN, Aadhar style and national id numbers is a founder confirmation (LD-321), not decided here.
-- Additive only: new tables, columns, functions, triggers, policies and grants; no data rewrite, no ENUM type, no sequence.
-- Idempotent: IF NOT EXISTS on tables, columns and indexes, constraints inline, each CREATE POLICY guarded by pg_policy, functions and triggers CREATE OR REPLACE.
-- Cloud apply is a founder step (push-cloud.ps1) after 20261117210000_partners__add_sales_hierarchy.sql; not done by this task.
-- DOWN (manual, never automatic; drops entered data: founder decision, export first):
--   DROP TABLE IF EXISTS partners.non_compliance_event, partners.non_compliance_penalty, partners.party_onboarding, partners.party_commercial_setting,
--     catalog.icd_code CASCADE;
--   ALTER TABLE partners.partners DROP COLUMN IF EXISTS tax_number, DROP COLUMN IF EXISTS national_id_number;
--   ALTER TABLE catalog.doctors DROP COLUMN IF EXISTS speciality, DROP COLUMN IF EXISTS hospital, DROP COLUMN IF EXISTS commission_bp,
--     DROP COLUMN IF EXISTS national_id_number;
--   DROP FUNCTION IF EXISTS partners.party_onboarding__transition(), partners.non_compliance_event__transition();
--   the three re-created audit triggers may stay as they are (excluding a dropped column is harmless).
SET LOCAL ROLE lims_owner;

-- ---------- (1) government ID numbers and doctor master parity (new nullable columns, inline CHECKs) ----------
ALTER TABLE partners.partners
  ADD COLUMN IF NOT EXISTS tax_number text CONSTRAINT partners__tax_number__ck CHECK (char_length(tax_number) BETWEEN 1 AND 32),
  ADD COLUMN IF NOT EXISTS national_id_number text CONSTRAINT partners__national_id_number__ck CHECK (char_length(national_id_number) BETWEEN 1 AND 32);
ALTER TABLE catalog.doctors
  ADD COLUMN IF NOT EXISTS speciality text CONSTRAINT doctors__speciality__ck CHECK (char_length(speciality) BETWEEN 1 AND 120),
  ADD COLUMN IF NOT EXISTS hospital text CONSTRAINT doctors__hospital__ck CHECK (char_length(hospital) BETWEEN 1 AND 200),
  ADD COLUMN IF NOT EXISTS commission_bp integer CONSTRAINT doctors__commission_bp__ck CHECK (commission_bp BETWEEN 0 AND 10000),
  ADD COLUMN IF NOT EXISTS national_id_number text CONSTRAINT doctors__national_id_number__ck CHECK (char_length(national_id_number) BETWEEN 1 AND 32);

-- ID numbers never reach audit.audit_log (done_when 3); everything else on these rows is still audited
CREATE OR REPLACE TRIGGER partners__audit AFTER INSERT OR UPDATE OR DELETE ON partners.partners FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit('tax_number', 'national_id_number');
CREATE OR REPLACE TRIGGER doctors__audit AFTER INSERT OR UPDATE OR DELETE ON catalog.doctors FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit('national_id_number');
CREATE OR REPLACE TRIGGER credit_parties__audit AFTER INSERT OR UPDATE OR DELETE ON catalog.credit_parties FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit('pan');

-- ---------- (2) per party commercial settings ----------
CREATE TABLE IF NOT EXISTS partners.party_commercial_setting (
  id                     uuid        NOT NULL,
  tenant_id              uuid        NOT NULL,
  party_kind             text        NOT NULL,
  party_id               uuid        NOT NULL,
  auto_release_reports   boolean     NOT NULL,
  whatsapp_enabled       boolean     NOT NULL,
  insurance_enabled      boolean     NOT NULL,
  print_exception        boolean     NOT NULL,
  auto_block_overdue     boolean     NOT NULL,
  lab_number_scheme_code text,
  billing_cycle          text        NOT NULL,
  invoice_payment_days   integer     NOT NULL,
  invoice_blocking_days  integer     NOT NULL,
  invoice_warning_days   integer     NOT NULL,
  interest_bp_per_day    integer     NOT NULL,
  commission_bp          integer     NOT NULL,
  tds_bp                 integer     NOT NULL DEFAULT 0,
  priority               text        NOT NULL,
  header_footer_mode     text        NOT NULL,
  version                integer     NOT NULL DEFAULT 1,
  created_at             timestamptz NOT NULL DEFAULT now(),
  created_by             uuid        NOT NULL,
  updated_at             timestamptz NOT NULL DEFAULT now(),
  updated_by             uuid        NOT NULL,
  CONSTRAINT party_commercial_setting__pk PRIMARY KEY (id),
  CONSTRAINT party_commercial_setting__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT party_commercial_setting__tenant_id_party__uq UNIQUE (tenant_id, party_kind, party_id),
  CONSTRAINT party_commercial_setting__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT party_commercial_setting__party_kind__ck CHECK (party_kind IN ('partner','credit_party','doctor','referrer')),
  CONSTRAINT party_commercial_setting__lab_number_scheme_code__ck CHECK (lab_number_scheme_code ~ '^[A-Z0-9_-]{1,20}$'),
  CONSTRAINT party_commercial_setting__billing_cycle__ck CHECK (billing_cycle IN ('daily','weekly','fortnightly','monthly','quarterly')),
  CONSTRAINT party_commercial_setting__invoice_payment_days__ck CHECK (invoice_payment_days BETWEEN 0 AND 365),
  CONSTRAINT party_commercial_setting__invoice_blocking_days__ck CHECK (invoice_blocking_days BETWEEN 0 AND 365),
  CONSTRAINT party_commercial_setting__invoice_warning_days__ck CHECK (invoice_warning_days BETWEEN 0 AND 365),
  CONSTRAINT party_commercial_setting__interest_bp_per_day__ck CHECK (interest_bp_per_day BETWEEN 0 AND 10000),
  CONSTRAINT party_commercial_setting__commission_bp__ck CHECK (commission_bp BETWEEN 0 AND 10000),
  CONSTRAINT party_commercial_setting__tds_bp__ck CHECK (tds_bp BETWEEN 0 AND 10000),
  CONSTRAINT party_commercial_setting__priority__ck CHECK (priority IN ('P1','P2','P3','P4','P5')),
  CONSTRAINT party_commercial_setting__header_footer_mode__ck CHECK (header_footer_mode IN ('with','without','both'))
);

-- ---------- (3) onboarding approval queue ----------
CREATE TABLE IF NOT EXISTS partners.party_onboarding (
  id          uuid        NOT NULL,
  tenant_id   uuid        NOT NULL,
  party_kind  text        NOT NULL,
  party_id    uuid        NOT NULL,
  status      text        NOT NULL DEFAULT 'pending',
  reason      text,
  decided_by  uuid,
  decided_at  timestamptz,
  version     integer     NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid        NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid        NOT NULL,
  CONSTRAINT party_onboarding__pk PRIMARY KEY (id),
  CONSTRAINT party_onboarding__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT party_onboarding__tenant_id_party__uq UNIQUE (tenant_id, party_kind, party_id),
  CONSTRAINT party_onboarding__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT party_onboarding__party_kind__ck CHECK (party_kind IN ('partner','credit_party','doctor','referrer')),
  CONSTRAINT party_onboarding__status__ck CHECK (status IN ('pending','approved','held','rejected')),
  CONSTRAINT party_onboarding__reason__ck CHECK (char_length(reason) BETWEEN 1 AND 500),
  CONSTRAINT party_onboarding__reason_needed__ck CHECK (status NOT IN ('held','rejected') OR reason IS NOT NULL),
  CONSTRAINT party_onboarding__decided__ck CHECK ((status = 'pending') = (decided_at IS NULL) AND (status = 'pending') = (decided_by IS NULL))
);
CREATE INDEX IF NOT EXISTS party_onboarding__tenant_id_status__idx ON partners.party_onboarding (tenant_id, status, created_at);

-- pending -> approved | held | rejected; held -> approved | rejected; approved and rejected are final
CREATE OR REPLACE FUNCTION partners.party_onboarding__transition() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT ((OLD.status = 'pending' AND NEW.status IN ('approved','held','rejected'))
         OR (OLD.status = 'held' AND NEW.status IN ('approved','rejected'))) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'party_onboarding_transition', DETAIL = OLD.status || ' -> ' || NEW.status;
    END IF;
  END IF;
  IF NEW.party_kind IS DISTINCT FROM OLD.party_kind OR NEW.party_id IS DISTINCT FROM OLD.party_id THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'party_onboarding_party_fixed', DETAIL = OLD.id::text;
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER party_onboarding__transition BEFORE UPDATE ON partners.party_onboarding
  FOR EACH ROW EXECUTE FUNCTION partners.party_onboarding__transition();

-- ---------- (4) non compliance penalties ----------
CREATE TABLE IF NOT EXISTS partners.non_compliance_penalty (
  id            uuid        NOT NULL,
  tenant_id     uuid        NOT NULL,
  code          text        NOT NULL,
  name          text        NOT NULL,
  amount_paisa  bigint      NOT NULL,
  is_active     boolean     NOT NULL DEFAULT true,
  version       integer     NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid        NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid        NOT NULL,
  CONSTRAINT non_compliance_penalty__pk PRIMARY KEY (id),
  CONSTRAINT non_compliance_penalty__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT non_compliance_penalty__tenant_id_code__uq UNIQUE (tenant_id, code),
  CONSTRAINT non_compliance_penalty__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT non_compliance_penalty__code__ck CHECK (code ~ '^[A-Z0-9_-]{1,20}$'),
  CONSTRAINT non_compliance_penalty__name__ck CHECK (char_length(name) BETWEEN 1 AND 120),
  CONSTRAINT non_compliance_penalty__amount_paisa__ck CHECK (amount_paisa >= 0)
);

-- ---------- (5) non compliance events (raised, waived or charged once to the ledger) ----------
CREATE TABLE IF NOT EXISTS partners.non_compliance_event (
  id               uuid        NOT NULL,
  tenant_id        uuid        NOT NULL,
  party_kind       text        NOT NULL,
  party_id         uuid        NOT NULL,
  penalty_id       uuid        NOT NULL,
  event_date       date        NOT NULL,
  amount_paisa     bigint      NOT NULL,
  reason           text,
  status           text        NOT NULL DEFAULT 'raised',
  ledger_entry_id  uuid,
  decided_by       uuid,
  version          integer     NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid        NOT NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid        NOT NULL,
  CONSTRAINT non_compliance_event__pk PRIMARY KEY (id),
  CONSTRAINT non_compliance_event__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT non_compliance_event__tenant_id_ledger_entry_id__uq UNIQUE (tenant_id, ledger_entry_id),
  CONSTRAINT non_compliance_event__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT non_compliance_event__penalty__fk FOREIGN KEY (tenant_id, penalty_id) REFERENCES partners.non_compliance_penalty (tenant_id, id),
  CONSTRAINT non_compliance_event__party_kind__ck CHECK (party_kind IN ('partner','credit_party','doctor','referrer')),
  CONSTRAINT non_compliance_event__status__ck CHECK (status IN ('raised','waived','charged')),
  CONSTRAINT non_compliance_event__amount_paisa__ck CHECK (amount_paisa >= 0),
  CONSTRAINT non_compliance_event__reason__ck CHECK (char_length(reason) BETWEEN 1 AND 500),
  CONSTRAINT non_compliance_event__decided__ck CHECK ((status = 'raised') = (decided_by IS NULL)),
  CONSTRAINT non_compliance_event__ledger__ck CHECK ((status = 'charged') = (ledger_entry_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS non_compliance_event__tenant_id_party__idx ON partners.non_compliance_event (tenant_id, party_kind, party_id, event_date);
CREATE INDEX IF NOT EXISTS non_compliance_event__tenant_id_penalty_id__idx ON partners.non_compliance_event (tenant_id, penalty_id);
CREATE INDEX IF NOT EXISTS non_compliance_event__tenant_id_status__idx ON partners.non_compliance_event (tenant_id, status, event_date);

-- raised -> waived | charged only; a decided event is final: status, ledger entry, amount, penalty and party never change again
CREATE OR REPLACE FUNCTION partners.non_compliance_event__transition() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (OLD.status = 'raised' AND NEW.status IN ('waived','charged')) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'non_compliance_event_transition', DETAIL = OLD.status || ' -> ' || NEW.status;
  END IF;
  IF OLD.status <> 'raised' AND (NEW.ledger_entry_id IS DISTINCT FROM OLD.ledger_entry_id OR NEW.amount_paisa IS DISTINCT FROM OLD.amount_paisa
      OR NEW.decided_by IS DISTINCT FROM OLD.decided_by) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'non_compliance_event_final', DETAIL = OLD.id::text;
  END IF;
  IF NEW.party_kind IS DISTINCT FROM OLD.party_kind OR NEW.party_id IS DISTINCT FROM OLD.party_id OR NEW.penalty_id IS DISTINCT FROM OLD.penalty_id THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'non_compliance_event_party_fixed', DETAIL = OLD.id::text;
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER non_compliance_event__transition BEFORE UPDATE ON partners.non_compliance_event
  FOR EACH ROW EXECUTE FUNCTION partners.non_compliance_event__transition();

-- ---------- (6) ICD master (per tenant) ----------
CREATE TABLE IF NOT EXISTS catalog.icd_code (
  id          uuid        NOT NULL,
  tenant_id   uuid        NOT NULL,
  code        text        NOT NULL,
  title       text        NOT NULL,
  chapter     text,
  is_active   boolean     NOT NULL DEFAULT true,
  version     integer     NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid        NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid        NOT NULL,
  CONSTRAINT icd_code__pk PRIMARY KEY (id),
  CONSTRAINT icd_code__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT icd_code__tenant_id_code__uq UNIQUE (tenant_id, code),
  CONSTRAINT icd_code__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT icd_code__code__ck CHECK (code ~ '^[0-9A-Z][0-9A-Z.]{0,15}$'),
  CONSTRAINT icd_code__title__ck CHECK (char_length(title) BETWEEN 1 AND 500),
  CONSTRAINT icd_code__chapter__ck CHECK (char_length(chapter) BETWEEN 1 AND 120)
);
CREATE INDEX IF NOT EXISTS icd_code__tenant_id_lower_title__idx ON catalog.icd_code (tenant_id, lower(title));
CREATE INDEX IF NOT EXISTS icd_code__tenant_id_chapter__idx ON catalog.icd_code (tenant_id, chapter);

-- ---------- (7) RLS by tenant (staff and system actors), policies, grants (no DELETE), audit ----------
ALTER TABLE partners.party_commercial_setting ENABLE ROW LEVEL SECURITY;
ALTER TABLE partners.party_commercial_setting FORCE ROW LEVEL SECURITY;
ALTER TABLE partners.party_onboarding ENABLE ROW LEVEL SECURITY;
ALTER TABLE partners.party_onboarding FORCE ROW LEVEL SECURITY;
ALTER TABLE partners.non_compliance_penalty ENABLE ROW LEVEL SECURITY;
ALTER TABLE partners.non_compliance_penalty FORCE ROW LEVEL SECURITY;
ALTER TABLE partners.non_compliance_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE partners.non_compliance_event FORCE ROW LEVEL SECURITY;
ALTER TABLE catalog.icd_code ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog.icd_code FORCE ROW LEVEL SECURITY;

DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'partners.party_commercial_setting'::regclass AND polname = 'party_commercial_setting__select__tenant') THEN
  CREATE POLICY party_commercial_setting__select__tenant ON partners.party_commercial_setting FOR SELECT TO lims_app
    USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
END IF; END $do$;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'partners.party_commercial_setting'::regclass AND polname = 'party_commercial_setting__insert__tenant') THEN
  CREATE POLICY party_commercial_setting__insert__tenant ON partners.party_commercial_setting FOR INSERT TO lims_app
    WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
END IF; END $do$;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'partners.party_commercial_setting'::regclass AND polname = 'party_commercial_setting__update__tenant') THEN
  CREATE POLICY party_commercial_setting__update__tenant ON partners.party_commercial_setting FOR UPDATE TO lims_app
    USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
    WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
END IF; END $do$;

DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'partners.party_onboarding'::regclass AND polname = 'party_onboarding__select__tenant') THEN
  CREATE POLICY party_onboarding__select__tenant ON partners.party_onboarding FOR SELECT TO lims_app
    USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
END IF; END $do$;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'partners.party_onboarding'::regclass AND polname = 'party_onboarding__insert__tenant') THEN
  CREATE POLICY party_onboarding__insert__tenant ON partners.party_onboarding FOR INSERT TO lims_app
    WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
END IF; END $do$;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'partners.party_onboarding'::regclass AND polname = 'party_onboarding__update__tenant') THEN
  CREATE POLICY party_onboarding__update__tenant ON partners.party_onboarding FOR UPDATE TO lims_app
    USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
    WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
END IF; END $do$;

DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'partners.non_compliance_penalty'::regclass AND polname = 'non_compliance_penalty__select__tenant') THEN
  CREATE POLICY non_compliance_penalty__select__tenant ON partners.non_compliance_penalty FOR SELECT TO lims_app
    USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
END IF; END $do$;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'partners.non_compliance_penalty'::regclass AND polname = 'non_compliance_penalty__insert__tenant') THEN
  CREATE POLICY non_compliance_penalty__insert__tenant ON partners.non_compliance_penalty FOR INSERT TO lims_app
    WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
END IF; END $do$;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'partners.non_compliance_penalty'::regclass AND polname = 'non_compliance_penalty__update__tenant') THEN
  CREATE POLICY non_compliance_penalty__update__tenant ON partners.non_compliance_penalty FOR UPDATE TO lims_app
    USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
    WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
END IF; END $do$;

DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'partners.non_compliance_event'::regclass AND polname = 'non_compliance_event__select__tenant') THEN
  CREATE POLICY non_compliance_event__select__tenant ON partners.non_compliance_event FOR SELECT TO lims_app
    USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
END IF; END $do$;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'partners.non_compliance_event'::regclass AND polname = 'non_compliance_event__insert__tenant') THEN
  CREATE POLICY non_compliance_event__insert__tenant ON partners.non_compliance_event FOR INSERT TO lims_app
    WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
END IF; END $do$;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'partners.non_compliance_event'::regclass AND polname = 'non_compliance_event__update__tenant') THEN
  CREATE POLICY non_compliance_event__update__tenant ON partners.non_compliance_event FOR UPDATE TO lims_app
    USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
    WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
END IF; END $do$;

DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'catalog.icd_code'::regclass AND polname = 'icd_code__select__tenant') THEN
  CREATE POLICY icd_code__select__tenant ON catalog.icd_code FOR SELECT TO lims_app
    USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
END IF; END $do$;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'catalog.icd_code'::regclass AND polname = 'icd_code__insert__tenant') THEN
  CREATE POLICY icd_code__insert__tenant ON catalog.icd_code FOR INSERT TO lims_app
    WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
END IF; END $do$;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'catalog.icd_code'::regclass AND polname = 'icd_code__update__tenant') THEN
  CREATE POLICY icd_code__update__tenant ON catalog.icd_code FOR UPDATE TO lims_app
    USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
    WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
END IF; END $do$;

GRANT SELECT, INSERT, UPDATE ON partners.party_commercial_setting TO lims_app;
GRANT SELECT, INSERT, UPDATE ON partners.party_onboarding TO lims_app;
GRANT SELECT, INSERT, UPDATE ON partners.non_compliance_penalty TO lims_app;
GRANT SELECT, INSERT, UPDATE ON partners.non_compliance_event TO lims_app;
GRANT SELECT, INSERT, UPDATE ON catalog.icd_code TO lims_app;

CREATE OR REPLACE TRIGGER party_commercial_setting__audit AFTER INSERT OR UPDATE OR DELETE ON partners.party_commercial_setting FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE OR REPLACE TRIGGER party_onboarding__audit AFTER INSERT OR UPDATE OR DELETE ON partners.party_onboarding FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE OR REPLACE TRIGGER non_compliance_penalty__audit AFTER INSERT OR UPDATE OR DELETE ON partners.non_compliance_penalty FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE OR REPLACE TRIGGER non_compliance_event__audit AFTER INSERT OR UPDATE OR DELETE ON partners.non_compliance_event FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE OR REPLACE TRIGGER icd_code__audit AFTER INSERT OR UPDATE OR DELETE ON catalog.icd_code FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
