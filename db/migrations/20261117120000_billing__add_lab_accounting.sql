-- T0C-ACCT-1 (LD-313; founder blanket authority LD-310, request 2026-11-17 04:57 NPT "do not leave any function"): lab accounting in the billing module (LD-313 a).
-- Additive only: six NEW tenant tables in schema billing, no ALTER of an old table, no data rewrite. RLS ENABLE + FORCE by tenant like the neighbouring billing tables
-- (tenant_id = app.current_tenant_id() AND staff or system actor), TO lims_app only:
--   billing.account_groups (code, name, nature income | expense | asset | liability; code and nature immutable),
--   billing.account_particulars (account_group_id, code, name; group and code immutable),
--   billing.expense_types (name unique per tenant ignoring case, account_particular_id),
--   billing.account_ledger_entries (the accounting ledger; billing.ledger_entries is the C4 invoice payment ledger and is not touched): APPEND ONLY (LD-313 b):
--     lims_app has SELECT + INSERT only, no UPDATE / DELETE; a correction is a NEW reversal row (reverses_entry_id, opposite type, same amount / centre / party / particular,
--     one per entry, never a reversal of a reversal; guard trigger + UNIQUE); status is set at insert. Money is bigint paisa > 0, never a float.
--     receipt_no / receipt_seq unique per tenant (UNIQUE constraints); the per tenant receipt counter is receipt_seq itself: the service takes
--     max(receipt_seq) + 1 of the tenant under pg_advisory_xact_lock in the posting transaction (no sequences: 05-SCHEMA §9 test 1). reference_no / payment_details never hold a 13..19 digit run (card number, REQ-SEC-056). No row audit trigger on the ledger
--     (like billing.ledger_entries; payment_details is free text that may hold personal data).
--   billing.expenses (amount, type, centre, time immutable; cancelled_at set once, never cleared; a correction is cancel and re-enter),
--   billing.cash_transfers (user | centre to user | centre, pending -> accepted | rejected | cancelled once; accepted / rejected need decided_by <> created_by;
--     accept posts a balanced pair of ledger entries in the same transaction: service rule, T0B-ACCT-*).
-- Records only: no money is moved by any of this. The lab accountant must confirm the groups and particulars before go-live (LD-313 e).
-- Idempotent: IF NOT EXISTS everywhere, constraints inline in CREATE TABLE, each CREATE POLICY guarded by a pg_policy NOT EXISTS check (no DROP: gate 9),
--   functions and triggers CREATE OR REPLACE. No ENUM types, no default on id / tenant_id (UUIDv7 in app code).
-- Cloud apply is a founder step (push-cloud.ps1, LD-313 MIGRATIONS), after 20261117100000 and 20261117110000; not done by this task.
-- DOWN (manual, never automatic; DROP TABLE destroys entered accounting data: founder decision, export first):
--   DROP TABLE IF EXISTS billing.expenses, billing.cash_transfers, billing.account_ledger_entries,
--     billing.expense_types, billing.account_particulars, billing.account_groups;
--   DROP FUNCTION IF EXISTS billing.account_ledger_reversal_guard(), billing.expenses_guard(), billing.cash_transfers_guard();
SET LOCAL ROLE lims_owner;

-- ---------- account groups ----------
CREATE TABLE IF NOT EXISTS billing.account_groups (
  id uuid NOT NULL, tenant_id uuid NOT NULL,
  code   text NOT NULL,                           -- upper case, so the per-tenant UNIQUE is case-insensitive
  name   text NOT NULL,
  nature text NOT NULL,                           -- never changes (postings depend on it)
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT account_groups__pk PRIMARY KEY (id),
  CONSTRAINT account_groups__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT account_groups__tenant_id_code__uq UNIQUE (tenant_id, code),
  CONSTRAINT account_groups__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT account_groups__code__ck CHECK (code ~ '^[A-Z0-9_]{1,32}$'),
  CONSTRAINT account_groups__name__ck CHECK (char_length(name) BETWEEN 1 AND 200),
  CONSTRAINT account_groups__nature__ck CHECK (nature IN ('income','expense','asset','liability'))
);

-- ---------- account particulars ----------
CREATE TABLE IF NOT EXISTS billing.account_particulars (
  id uuid NOT NULL, tenant_id uuid NOT NULL,
  account_group_id uuid NOT NULL,                 -- never changes
  code text NOT NULL,                             -- upper case, never changes
  name text NOT NULL,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT account_particulars__pk PRIMARY KEY (id),
  CONSTRAINT account_particulars__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT account_particulars__tenant_id_code__uq UNIQUE (tenant_id, code),
  CONSTRAINT account_particulars__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT account_particulars__group__fk FOREIGN KEY (tenant_id, account_group_id) REFERENCES billing.account_groups (tenant_id, id),
  CONSTRAINT account_particulars__code__ck CHECK (code ~ '^[A-Z0-9_]{1,32}$'),
  CONSTRAINT account_particulars__name__ck CHECK (char_length(name) BETWEEN 1 AND 200)
);
CREATE INDEX IF NOT EXISTS account_particulars__tenant_id_group__idx ON billing.account_particulars (tenant_id, account_group_id);

-- ---------- expense types ----------
CREATE TABLE IF NOT EXISTS billing.expense_types (
  id uuid NOT NULL, tenant_id uuid NOT NULL,
  name text NOT NULL,
  account_particular_id uuid NOT NULL,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT expense_types__pk PRIMARY KEY (id),
  CONSTRAINT expense_types__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT expense_types__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT expense_types__particular__fk FOREIGN KEY (tenant_id, account_particular_id) REFERENCES billing.account_particulars (tenant_id, id),
  CONSTRAINT expense_types__name__ck CHECK (char_length(name) BETWEEN 1 AND 200)
);
CREATE UNIQUE INDEX IF NOT EXISTS expense_types__tenant_id_lower_name__uq ON billing.expense_types (tenant_id, lower(name));

-- ---------- account ledger entries (append only) ----------
CREATE TABLE IF NOT EXISTS billing.account_ledger_entries (
  id uuid NOT NULL, tenant_id uuid NOT NULL,
  centre_id             uuid   NOT NULL,
  party_kind            text   NOT NULL,
  party_id              uuid   NOT NULL,          -- polymorphic (credit party, franchise, user pocket, laboratory): no FK, the service checks it
  entry_date            date   NOT NULL,
  account_particular_id uuid   NOT NULL,
  entry_type            text   NOT NULL,
  amount_paisa          bigint NOT NULL,
  payment_mode          text   NOT NULL,
  bank_name             text,
  reference_no          text,
  payment_details       text,
  comments              text,
  status                text   NOT NULL DEFAULT 'submitted',
  reverses_entry_id     uuid,
  receipt_no            text   NOT NULL,
  receipt_seq           bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), last_modified_by uuid NOT NULL,
  CONSTRAINT account_ledger_entries__pk PRIMARY KEY (id),
  CONSTRAINT account_ledger_entries__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT account_ledger_entries__tenant_id_receipt_no__uq UNIQUE (tenant_id, receipt_no),
  CONSTRAINT account_ledger_entries__tenant_id_receipt_seq__uq UNIQUE (tenant_id, receipt_seq),
  CONSTRAINT account_ledger_entries__tenant_id_reverses__uq UNIQUE (tenant_id, reverses_entry_id),   -- one reversal per entry (NULLs are distinct)
  CONSTRAINT account_ledger_entries__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT account_ledger_entries__centre__fk FOREIGN KEY (tenant_id, centre_id) REFERENCES core.collection_centres (tenant_id, id),
  CONSTRAINT account_ledger_entries__particular__fk FOREIGN KEY (tenant_id, account_particular_id) REFERENCES billing.account_particulars (tenant_id, id),
  CONSTRAINT account_ledger_entries__reverses__fk FOREIGN KEY (tenant_id, reverses_entry_id) REFERENCES billing.account_ledger_entries (tenant_id, id),
  CONSTRAINT account_ledger_entries__party_kind__ck CHECK (party_kind IN ('credit_party','franchise','user_pocket','laboratory')),
  CONSTRAINT account_ledger_entries__entry_type__ck CHECK (entry_type IN ('credit','debit')),
  CONSTRAINT account_ledger_entries__status__ck CHECK (status IN ('submitted','approved','rejected','reversed')),
  CONSTRAINT account_ledger_entries__amount__ck CHECK (amount_paisa > 0 AND amount_paisa <= 9007199254740991),
  CONSTRAINT account_ledger_entries__payment_mode__ck CHECK (char_length(payment_mode) BETWEEN 1 AND 50),
  CONSTRAINT account_ledger_entries__bank_name__ck CHECK (char_length(bank_name) BETWEEN 1 AND 200),
  CONSTRAINT account_ledger_entries__reference_no__ck CHECK (char_length(reference_no) BETWEEN 1 AND 100 AND reference_no !~ '[0-9]{13,19}'),
  CONSTRAINT account_ledger_entries__payment_details__ck CHECK (char_length(payment_details) BETWEEN 1 AND 1000 AND payment_details !~ '[0-9]{13,19}'),
  CONSTRAINT account_ledger_entries__comments__ck CHECK (char_length(comments) BETWEEN 1 AND 2000),
  CONSTRAINT account_ledger_entries__receipt_no__ck CHECK (char_length(receipt_no) BETWEEN 1 AND 64),
  CONSTRAINT account_ledger_entries__receipt_seq__ck CHECK (receipt_seq > 0),
  CONSTRAINT account_ledger_entries__not_self__ck CHECK (reverses_entry_id IS NULL OR reverses_entry_id <> id)
);
CREATE INDEX IF NOT EXISTS account_ledger_entries__tenant_id_party_date__idx ON billing.account_ledger_entries (tenant_id, party_kind, party_id, entry_date);   -- statement, summary
CREATE INDEX IF NOT EXISTS account_ledger_entries__tenant_id_centre_date__idx ON billing.account_ledger_entries (tenant_id, centre_id, entry_date);          -- daily collection

-- reversal guard: a reversal mirrors its original (opposite type, same amount / centre / party / particular) and the original is not itself a reversal
CREATE OR REPLACE FUNCTION billing.account_ledger_reversal_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE o billing.account_ledger_entries%ROWTYPE;
BEGIN
  IF NEW.reverses_entry_id IS NULL THEN RETURN NEW; END IF;
  SELECT e.* INTO o FROM billing.account_ledger_entries e WHERE e.tenant_id = NEW.tenant_id AND e.id = NEW.reverses_entry_id;
  IF NOT FOUND THEN RETURN NEW; END IF;   -- unknown or another tenant's entry: the composite FK refuses it (23503); itself: account_ledger_entries__not_self__ck
  IF o.reverses_entry_id IS NOT NULL OR o.entry_type = NEW.entry_type OR (o.amount_paisa <> NEW.amount_paisa) OR o.centre_id <> NEW.centre_id
     OR o.party_kind <> NEW.party_kind OR o.party_id <> NEW.party_id OR o.account_particular_id <> NEW.account_particular_id THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'reversal_mismatch', DETAIL = 'billing.account_ledger_entries';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER account_ledger_entries__reversal_guard BEFORE INSERT ON billing.account_ledger_entries FOR EACH ROW EXECUTE FUNCTION billing.account_ledger_reversal_guard();

-- ---------- expenses ----------
CREATE TABLE IF NOT EXISTS billing.expenses (
  id uuid NOT NULL, tenant_id uuid NOT NULL,
  centre_id          uuid        NOT NULL,
  expense_at         timestamptz NOT NULL,
  expense_type_id    uuid        NOT NULL,
  amount_paisa       bigint      NOT NULL,
  description        text,
  ledger_entry_id    uuid,                        -- set once (at insert or later), never changed
  cancelled_at       timestamptz,                 -- set once, never cleared
  cancel_reason_text text,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT expenses__pk PRIMARY KEY (id),
  CONSTRAINT expenses__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT expenses__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT expenses__centre__fk FOREIGN KEY (tenant_id, centre_id) REFERENCES core.collection_centres (tenant_id, id),
  CONSTRAINT expenses__type__fk FOREIGN KEY (tenant_id, expense_type_id) REFERENCES billing.expense_types (tenant_id, id),
  CONSTRAINT expenses__ledger__fk FOREIGN KEY (tenant_id, ledger_entry_id) REFERENCES billing.account_ledger_entries (tenant_id, id),
  CONSTRAINT expenses__amount__ck CHECK (amount_paisa > 0 AND amount_paisa <= 9007199254740991),
  CONSTRAINT expenses__description__ck CHECK (char_length(description) BETWEEN 1 AND 2000),
  CONSTRAINT expenses__cancel_reason__ck CHECK (cancel_reason_text IS NULL OR (char_length(cancel_reason_text) BETWEEN 1 AND 500 AND cancelled_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS expenses__tenant_id_centre_expense_at__idx ON billing.expenses (tenant_id, centre_id, expense_at);

CREATE OR REPLACE FUNCTION billing.expenses_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF OLD.cancelled_at IS NOT NULL OR (OLD.ledger_entry_id IS NOT NULL AND NEW.ledger_entry_id IS DISTINCT FROM OLD.ledger_entry_id) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'billing.expenses';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER expenses__mutable_columns BEFORE UPDATE ON billing.expenses FOR EACH ROW EXECUTE FUNCTION
  app.enforce_mutable_columns('description','ledger_entry_id','cancelled_at','cancel_reason_text','version','is_active','updated_at','updated_by');
CREATE OR REPLACE TRIGGER expenses__guard BEFORE UPDATE ON billing.expenses FOR EACH ROW EXECUTE FUNCTION billing.expenses_guard();

-- ---------- cash transfers ----------
CREATE TABLE IF NOT EXISTS billing.cash_transfers (
  id uuid NOT NULL, tenant_id uuid NOT NULL,
  from_kind    text   NOT NULL,
  from_id      uuid   NOT NULL,                   -- membership or centre (polymorphic, no FK)
  to_kind      text   NOT NULL,
  to_id        uuid   NOT NULL,
  amount_paisa bigint NOT NULL,
  status       text   NOT NULL DEFAULT 'pending',
  remark       text,
  decided_by   uuid,
  decided_at   timestamptz,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT cash_transfers__pk PRIMARY KEY (id),
  CONSTRAINT cash_transfers__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT cash_transfers__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT cash_transfers__from_kind__ck CHECK (from_kind IN ('user','centre')),
  CONSTRAINT cash_transfers__to_kind__ck CHECK (to_kind IN ('user','centre')),
  CONSTRAINT cash_transfers__not_same__ck CHECK (from_kind <> to_kind OR from_id <> to_id),
  CONSTRAINT cash_transfers__amount__ck CHECK (amount_paisa > 0 AND amount_paisa <= 9007199254740991),
  CONSTRAINT cash_transfers__status__ck CHECK (status IN ('pending','accepted','rejected','cancelled')),
  CONSTRAINT cash_transfers__remark__ck CHECK (char_length(remark) BETWEEN 1 AND 1000),
  CONSTRAINT cash_transfers__decision__ck CHECK ((status = 'pending' AND decided_by IS NULL AND decided_at IS NULL)
    OR (status <> 'pending' AND decided_by IS NOT NULL AND decided_at IS NOT NULL)),
  CONSTRAINT cash_transfers__duties__ck CHECK (status NOT IN ('accepted','rejected') OR decided_by <> created_by)   -- separation of duties
);
CREATE INDEX IF NOT EXISTS cash_transfers__tenant_id_status_created_at__idx ON billing.cash_transfers (tenant_id, status, created_at);
CREATE INDEX IF NOT EXISTS cash_transfers__tenant_id_from__idx ON billing.cash_transfers (tenant_id, from_id);
CREATE INDEX IF NOT EXISTS cash_transfers__tenant_id_to__idx ON billing.cash_transfers (tenant_id, to_id);

CREATE OR REPLACE FUNCTION billing.cash_transfers_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF OLD.status <> 'pending' THEN   -- accepted / rejected / cancelled are terminal
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'billing.cash_transfers';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER cash_transfers__mutable_columns BEFORE UPDATE ON billing.cash_transfers FOR EACH ROW EXECUTE FUNCTION
  app.enforce_mutable_columns('status','decided_by','decided_at','version','is_active','updated_at','updated_by');
CREATE OR REPLACE TRIGGER cash_transfers__lifecycle_guard BEFORE UPDATE ON billing.cash_transfers FOR EACH ROW EXECUTE FUNCTION billing.cash_transfers_guard();

-- masters: code / nature / group never change
CREATE OR REPLACE TRIGGER account_groups__mutable_columns BEFORE UPDATE ON billing.account_groups FOR EACH ROW EXECUTE FUNCTION
  app.enforce_mutable_columns('name','is_active','version','updated_at','updated_by');
CREATE OR REPLACE TRIGGER account_particulars__mutable_columns BEFORE UPDATE ON billing.account_particulars FOR EACH ROW EXECUTE FUNCTION
  app.enforce_mutable_columns('name','is_active','version','updated_at','updated_by');
CREATE OR REPLACE TRIGGER expense_types__mutable_columns BEFORE UPDATE ON billing.expense_types FOR EACH ROW EXECUTE FUNCTION
  app.enforce_mutable_columns('name','account_particular_id','is_active','version','updated_at','updated_by');

-- ---------- RLS (tenant, like billing.credit_accounts), policies, grants ----------
ALTER TABLE billing.account_groups ENABLE ROW LEVEL SECURITY;  ALTER TABLE billing.account_groups FORCE ROW LEVEL SECURITY;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'billing.account_groups'::regclass AND polname = 'account_groups__select__tenant') THEN
  CREATE POLICY account_groups__select__tenant ON billing.account_groups FOR SELECT TO lims_app
    USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
END IF; END $do$;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'billing.account_groups'::regclass AND polname = 'account_groups__insert__tenant') THEN
  CREATE POLICY account_groups__insert__tenant ON billing.account_groups FOR INSERT TO lims_app
    WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
END IF; END $do$;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'billing.account_groups'::regclass AND polname = 'account_groups__update__tenant') THEN
  CREATE POLICY account_groups__update__tenant ON billing.account_groups FOR UPDATE TO lims_app
    USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
    WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
END IF; END $do$;
GRANT SELECT, INSERT, UPDATE ON billing.account_groups TO lims_app;

ALTER TABLE billing.account_particulars ENABLE ROW LEVEL SECURITY;  ALTER TABLE billing.account_particulars FORCE ROW LEVEL SECURITY;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'billing.account_particulars'::regclass AND polname = 'account_particulars__select__tenant') THEN
  CREATE POLICY account_particulars__select__tenant ON billing.account_particulars FOR SELECT TO lims_app
    USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
END IF; END $do$;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'billing.account_particulars'::regclass AND polname = 'account_particulars__insert__tenant') THEN
  CREATE POLICY account_particulars__insert__tenant ON billing.account_particulars FOR INSERT TO lims_app
    WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
END IF; END $do$;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'billing.account_particulars'::regclass AND polname = 'account_particulars__update__tenant') THEN
  CREATE POLICY account_particulars__update__tenant ON billing.account_particulars FOR UPDATE TO lims_app
    USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
    WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
END IF; END $do$;
GRANT SELECT, INSERT, UPDATE ON billing.account_particulars TO lims_app;

ALTER TABLE billing.expense_types ENABLE ROW LEVEL SECURITY;  ALTER TABLE billing.expense_types FORCE ROW LEVEL SECURITY;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'billing.expense_types'::regclass AND polname = 'expense_types__select__tenant') THEN
  CREATE POLICY expense_types__select__tenant ON billing.expense_types FOR SELECT TO lims_app
    USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
END IF; END $do$;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'billing.expense_types'::regclass AND polname = 'expense_types__insert__tenant') THEN
  CREATE POLICY expense_types__insert__tenant ON billing.expense_types FOR INSERT TO lims_app
    WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
END IF; END $do$;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'billing.expense_types'::regclass AND polname = 'expense_types__update__tenant') THEN
  CREATE POLICY expense_types__update__tenant ON billing.expense_types FOR UPDATE TO lims_app
    USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
    WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
END IF; END $do$;
GRANT SELECT, INSERT, UPDATE ON billing.expense_types TO lims_app;

-- append only: SELECT + INSERT policies and grants only (LD-313 b)
ALTER TABLE billing.account_ledger_entries ENABLE ROW LEVEL SECURITY;  ALTER TABLE billing.account_ledger_entries FORCE ROW LEVEL SECURITY;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'billing.account_ledger_entries'::regclass AND polname = 'account_ledger_entries__select__tenant') THEN
  CREATE POLICY account_ledger_entries__select__tenant ON billing.account_ledger_entries FOR SELECT TO lims_app
    USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
END IF; END $do$;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'billing.account_ledger_entries'::regclass AND polname = 'account_ledger_entries__insert__tenant') THEN
  CREATE POLICY account_ledger_entries__insert__tenant ON billing.account_ledger_entries FOR INSERT TO lims_app
    WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
END IF; END $do$;
GRANT SELECT, INSERT ON billing.account_ledger_entries TO lims_app;

ALTER TABLE billing.expenses ENABLE ROW LEVEL SECURITY;  ALTER TABLE billing.expenses FORCE ROW LEVEL SECURITY;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'billing.expenses'::regclass AND polname = 'expenses__select__tenant') THEN
  CREATE POLICY expenses__select__tenant ON billing.expenses FOR SELECT TO lims_app
    USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
END IF; END $do$;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'billing.expenses'::regclass AND polname = 'expenses__insert__tenant') THEN
  CREATE POLICY expenses__insert__tenant ON billing.expenses FOR INSERT TO lims_app
    WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
END IF; END $do$;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'billing.expenses'::regclass AND polname = 'expenses__update__tenant') THEN
  CREATE POLICY expenses__update__tenant ON billing.expenses FOR UPDATE TO lims_app
    USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
    WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
END IF; END $do$;
GRANT SELECT, INSERT, UPDATE ON billing.expenses TO lims_app;

ALTER TABLE billing.cash_transfers ENABLE ROW LEVEL SECURITY;  ALTER TABLE billing.cash_transfers FORCE ROW LEVEL SECURITY;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'billing.cash_transfers'::regclass AND polname = 'cash_transfers__select__tenant') THEN
  CREATE POLICY cash_transfers__select__tenant ON billing.cash_transfers FOR SELECT TO lims_app
    USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
END IF; END $do$;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'billing.cash_transfers'::regclass AND polname = 'cash_transfers__insert__tenant') THEN
  CREATE POLICY cash_transfers__insert__tenant ON billing.cash_transfers FOR INSERT TO lims_app
    WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
END IF; END $do$;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'billing.cash_transfers'::regclass AND polname = 'cash_transfers__update__tenant') THEN
  CREATE POLICY cash_transfers__update__tenant ON billing.cash_transfers FOR UPDATE TO lims_app
    USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
    WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
END IF; END $do$;
GRANT SELECT, INSERT, UPDATE ON billing.cash_transfers TO lims_app;

-- ---------- row audit: masters, expenses, transfers (the ledger has none, like billing.ledger_entries) ----------
CREATE OR REPLACE TRIGGER account_groups__audit AFTER INSERT OR UPDATE OR DELETE ON billing.account_groups FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE OR REPLACE TRIGGER account_particulars__audit AFTER INSERT OR UPDATE OR DELETE ON billing.account_particulars FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE OR REPLACE TRIGGER expense_types__audit AFTER INSERT OR UPDATE OR DELETE ON billing.expense_types FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE OR REPLACE TRIGGER expenses__audit AFTER INSERT OR UPDATE OR DELETE ON billing.expenses FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE OR REPLACE TRIGGER cash_transfers__audit AFTER INSERT OR UPDATE OR DELETE ON billing.cash_transfers FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
