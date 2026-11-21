-- T0C-FINCTRL-1 (LD-321; founder blanket authority LD-310; priority 2026-11-17 09:18 NPT): accounting controls in the billing module.
-- Additive only, no data rewrite. RLS ENABLE + FORCE by tenant like the neighbouring billing tables (tenant_id = app.current_tenant_id() AND staff or system actor), TO lims_app only:
--   billing.discount_reason (code ^[A-Z0-9_]{1,32}$ unique per tenant and immutable, name, display_order 0..9999, is_active = the brief's `active`);
--     seeded PER TENANT by billing.seed_discount_reasons(tenant, actor) with the eight reasons of the evidence file (a migration cannot seed tenants that do not exist yet; T0B-FINCTRL-1 calls it).
--   billing.party_discount_slab (party_kind credit_party | partner | doctor | franchise, party_id polymorphic (no FK), amount range HALF OPEN [amount_from_paisa, amount_to_paisa),
--     discount_bp 0..10000, effective_from .. effective_to inclusive (NULL = open ended)). Two ACTIVE slabs of one party never overlap in both ranges: a BEFORE INSERT OR UPDATE trigger
--     under pg_advisory_xact_lock per party raises 23505 (btree_gist is not assumed in the pinned image: the 20261117200000 precedent). party_kind / party_id never change.
--   billing.user_discount_limit (user_id, max_discount_bp, max_discount_paisa per bill): one ACTIVE row per (tenant, user), partial unique index; inactive history rows unlimited.
--   billing.discount_authority (user_id, max_discount_bp, max_discount_paisa).
--   billing.account_ledger_entries (T0C-ACCT-1) gains status held and held_reason, held_by, held_at, released_by, released_at, fiscal_year_label (e.g. 2083/84; fiscal year start defaults
--     to Shrawan 1 BS until the accountant confirms). Append only stays: lims_app gets a COLUMN level UPDATE grant on status, last_modified_by, updated_at and the hold columns only,
--     an UPDATE policy by tenant and a guard trigger: the only status changes are submitted -> held (hold) and held -> submitted (release); every other column is immutable.
--     Held rule (service, T0B-FINCTRL-1): balances, statements and summaries count only posted entries (every status except held); held entries are listed apart until released.
--   billing.cash_sessions gains previous_outstanding_cash_paisa (carried forward from the day before, set at open only) and deposit_paisa (editable, also after close); bigint paisa >= 0.
-- Idempotent: IF NOT EXISTS everywhere, policies and constraint changes guarded by pg_policy / pg_constraint checks, functions and triggers CREATE OR REPLACE.
-- Cloud apply is a founder step (push-cloud.ps1, LD-321 MIGRATIONS); not done by this task.
-- DOWN (manual, never automatic; DROP TABLE destroys entered master data: founder decision, export first):
--   DROP TABLE IF EXISTS billing.discount_reason, billing.party_discount_slab, billing.user_discount_limit, billing.discount_authority;
--   DROP FUNCTION IF EXISTS billing.seed_discount_reasons(uuid, uuid), billing.party_discount_slab_no_overlap(), billing.account_ledger_hold_guard(), billing.account_ledger_column_guard();
--   DROP TRIGGER IF EXISTS account_ledger_entries__hold_guard / __mutable_columns / __immutable_columns / __hold_columns ON billing.account_ledger_entries;
--   ALTER TABLE billing.account_ledger_entries DROP COLUMN held_reason, DROP COLUMN held_by, DROP COLUMN held_at, DROP COLUMN released_by, DROP COLUMN released_at,
--     DROP COLUMN fiscal_year_label (first set held rows back to submitted and restore the four value status check); REVOKE UPDATE on the ledger columns; DROP POLICY account_ledger_entries__update__tenant;
--   ALTER TABLE billing.cash_sessions DROP COLUMN previous_outstanding_cash_paisa, DROP COLUMN deposit_paisa (and re-create cash_sessions__mutable_columns without deposit_paisa).
SET LOCAL ROLE lims_owner;

-- ---------- discount reasons ----------
CREATE TABLE IF NOT EXISTS billing.discount_reason (
  id uuid NOT NULL, tenant_id uuid NOT NULL,
  code          text    NOT NULL,                 -- upper case, never changes (reports and approvals refer to it)
  name          text    NOT NULL,
  display_order integer NOT NULL DEFAULT 0,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT discount_reason__pk PRIMARY KEY (id),
  CONSTRAINT discount_reason__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT discount_reason__tenant_id_code__uq UNIQUE (tenant_id, code),
  CONSTRAINT discount_reason__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT discount_reason__code__ck CHECK (code ~ '^[A-Z0-9_]{1,32}$'),
  CONSTRAINT discount_reason__name__ck CHECK (char_length(name) BETWEEN 1 AND 200),
  CONSTRAINT discount_reason__display_order__ck CHECK (display_order BETWEEN 0 AND 9999)
);
CREATE OR REPLACE TRIGGER discount_reason__mutable_columns BEFORE UPDATE ON billing.discount_reason FOR EACH ROW EXECUTE FUNCTION
  app.enforce_mutable_columns('name','display_order','is_active','version','updated_at','updated_by');

-- the eight reasons of C:/LIMS-state/elabassist-accounting-20261117.md, per tenant; SECURITY INVOKER so RLS decides who may seed which tenant
CREATE OR REPLACE FUNCTION billing.seed_discount_reasons(p_tenant_id uuid, p_actor_id uuid) RETURNS integer
LANGUAGE sql SECURITY INVOKER SET search_path = '' AS $$
  WITH ins AS (
    INSERT INTO billing.discount_reason (id, tenant_id, code, name, display_order, created_by, updated_by)
    -- UUIDv7 inline (same expression as app.uuidv7(), whose EXECUTE is not granted to lims_app)
    SELECT encode(set_bit(set_bit(overlay(uuid_send(gen_random_uuid())
             PLACING substring(int8send(floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3) FROM 1 FOR 6), 52, 1), 53, 1), 'hex')::uuid, p_tenant_id, r.code, r.name, r.ord, p_actor_id, p_actor_id
      FROM (VALUES ('PARTNER_FAMILY', 'Partner Family', 1), ('PARTNER_FRIENDS_RELATIVES', 'Partners friend and relatives', 2), ('PRESCRIBED_BY_DOCTOR', 'Prescribed by Doctor', 3),
                   ('EMPLOYEES_FAMILY', 'Employees and family', 4), ('EMPLOYEE_RELATIVES', 'Employee relatives', 5), ('REGULAR_PATIENT', 'Regular patient', 6),
                   ('WALKING_PATIENT', 'Walking patient', 7), ('GOLD_MEMBERSHIP', 'Gold membership', 8)) r(code, name, ord)
    ON CONFLICT (tenant_id, code) DO NOTHING
    RETURNING 1)
  SELECT count(*)::integer FROM ins
$$;
GRANT EXECUTE ON FUNCTION billing.seed_discount_reasons(uuid, uuid) TO lims_app;

-- ---------- party discount slabs ----------
CREATE TABLE IF NOT EXISTS billing.party_discount_slab (
  id uuid NOT NULL, tenant_id uuid NOT NULL,
  party_kind        text    NOT NULL,             -- never changes
  party_id          uuid    NOT NULL,             -- polymorphic (credit party, partner, doctor, franchise): no FK, the service checks it; never changes
  amount_from_paisa bigint  NOT NULL,             -- included
  amount_to_paisa   bigint  NOT NULL,             -- excluded (half open range)
  discount_bp       integer NOT NULL,
  effective_from    date    NOT NULL,
  effective_to      date,                         -- inclusive; NULL = open ended
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT party_discount_slab__pk PRIMARY KEY (id),
  CONSTRAINT party_discount_slab__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT party_discount_slab__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT party_discount_slab__party_kind__ck CHECK (party_kind IN ('credit_party','partner','doctor','franchise')),
  CONSTRAINT party_discount_slab__amount__ck CHECK (amount_from_paisa >= 0 AND amount_to_paisa > amount_from_paisa AND amount_to_paisa <= 9007199254740991),
  CONSTRAINT party_discount_slab__discount_bp__ck CHECK (discount_bp BETWEEN 0 AND 10000),
  CONSTRAINT party_discount_slab__dates__ck CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
CREATE INDEX IF NOT EXISTS party_discount_slab__tenant_id_party__idx ON billing.party_discount_slab (tenant_id, party_kind, party_id, effective_from);
CREATE OR REPLACE TRIGGER party_discount_slab__mutable_columns BEFORE UPDATE ON billing.party_discount_slab FOR EACH ROW EXECUTE FUNCTION
  app.enforce_mutable_columns('amount_from_paisa','amount_to_paisa','discount_bp','effective_from','effective_to','is_active','version','updated_at','updated_by');

-- no overlap of two ACTIVE slabs of one party in amount [from, to) AND in dates [effective_from, effective_to] (inclusive); 23505 like price_list_assignments__no_overlap
CREATE OR REPLACE FUNCTION billing.party_discount_slab_no_overlap() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE v_other uuid;
BEGIN
  IF NOT NEW.is_active THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('billing.party_discount_slab:' || NEW.tenant_id::text || ':' || NEW.party_kind || ':' || NEW.party_id::text, 0));
  SELECT s.id INTO v_other FROM billing.party_discount_slab s
   WHERE s.tenant_id = NEW.tenant_id AND s.party_kind = NEW.party_kind AND s.party_id = NEW.party_id AND s.is_active AND s.id <> NEW.id
     AND s.amount_from_paisa < NEW.amount_to_paisa AND NEW.amount_from_paisa < s.amount_to_paisa
     AND s.effective_from <= coalesce(NEW.effective_to, 'infinity'::date) AND NEW.effective_from <= coalesce(s.effective_to, 'infinity'::date)
   LIMIT 1;
  IF v_other IS NOT NULL THEN
    RAISE EXCEPTION 'discount slab overlaps slab % of the same party', v_other
      USING ERRCODE = '23505', CONSTRAINT = 'party_discount_slab__no_overlap';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER party_discount_slab__no_overlap BEFORE INSERT OR UPDATE ON billing.party_discount_slab
  FOR EACH ROW EXECUTE FUNCTION billing.party_discount_slab_no_overlap();

-- ---------- per user discount limits ----------
CREATE TABLE IF NOT EXISTS billing.user_discount_limit (
  id uuid NOT NULL, tenant_id uuid NOT NULL,
  user_id            uuid    NOT NULL,            -- never changes; no FK (identity user)
  max_discount_bp    integer NOT NULL,
  max_discount_paisa bigint  NOT NULL,            -- per bill
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT user_discount_limit__pk PRIMARY KEY (id),
  CONSTRAINT user_discount_limit__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT user_discount_limit__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT user_discount_limit__bp__ck CHECK (max_discount_bp BETWEEN 0 AND 10000),
  CONSTRAINT user_discount_limit__paisa__ck CHECK (max_discount_paisa >= 0 AND max_discount_paisa <= 9007199254740991)
);
CREATE UNIQUE INDEX IF NOT EXISTS user_discount_limit__tenant_id_user_active__p_uq ON billing.user_discount_limit (tenant_id, user_id) WHERE is_active;
CREATE OR REPLACE TRIGGER user_discount_limit__mutable_columns BEFORE UPDATE ON billing.user_discount_limit FOR EACH ROW EXECUTE FUNCTION
  app.enforce_mutable_columns('max_discount_bp','max_discount_paisa','is_active','version','updated_at','updated_by');

-- ---------- discount authorities ----------
CREATE TABLE IF NOT EXISTS billing.discount_authority (
  id uuid NOT NULL, tenant_id uuid NOT NULL,
  user_id            uuid    NOT NULL,            -- never changes; no FK (identity user)
  max_discount_bp    integer NOT NULL,
  max_discount_paisa bigint  NOT NULL,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT discount_authority__pk PRIMARY KEY (id),
  CONSTRAINT discount_authority__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT discount_authority__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT discount_authority__bp__ck CHECK (max_discount_bp BETWEEN 0 AND 10000),
  CONSTRAINT discount_authority__paisa__ck CHECK (max_discount_paisa >= 0 AND max_discount_paisa <= 9007199254740991)
);
CREATE INDEX IF NOT EXISTS discount_authority__tenant_id_user__idx ON billing.discount_authority (tenant_id, user_id);
CREATE OR REPLACE TRIGGER discount_authority__mutable_columns BEFORE UPDATE ON billing.discount_authority FOR EACH ROW EXECUTE FUNCTION
  app.enforce_mutable_columns('max_discount_bp','max_discount_paisa','is_active','version','updated_at','updated_by');

-- ---------- ledger: held status, hold / release columns, fiscal year label ----------
ALTER TABLE billing.account_ledger_entries ADD COLUMN IF NOT EXISTS held_reason text, ADD COLUMN IF NOT EXISTS held_by uuid, ADD COLUMN IF NOT EXISTS held_at timestamptz,
  ADD COLUMN IF NOT EXISTS released_by uuid, ADD COLUMN IF NOT EXISTS released_at timestamptz, ADD COLUMN IF NOT EXISTS fiscal_year_label text;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'billing.account_ledger_entries'::regclass AND conname = 'account_ledger_entries__status__ck'
                  AND pg_get_constraintdef(oid) LIKE '%held%') THEN
    ALTER TABLE billing.account_ledger_entries DROP CONSTRAINT IF EXISTS account_ledger_entries__status__ck;
    ALTER TABLE billing.account_ledger_entries ADD CONSTRAINT account_ledger_entries__status__ck CHECK (status IN ('submitted','approved','rejected','reversed','held'));
  END IF;
END $do$;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'billing.account_ledger_entries'::regclass AND conname = 'account_ledger_entries__held__ck') THEN
    ALTER TABLE billing.account_ledger_entries ADD CONSTRAINT account_ledger_entries__held__ck CHECK (
      (held_reason IS NULL OR char_length(held_reason) BETWEEN 1 AND 500)
      AND ((released_by IS NULL) = (released_at IS NULL))
      AND (status <> 'held' OR (held_reason IS NOT NULL AND held_by IS NOT NULL AND held_at IS NOT NULL AND released_by IS NULL AND released_at IS NULL)));
  END IF;
END $do$;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'billing.account_ledger_entries'::regclass AND conname = 'account_ledger_entries__fiscal_year_label__ck') THEN
    ALTER TABLE billing.account_ledger_entries ADD CONSTRAINT account_ledger_entries__fiscal_year_label__ck CHECK (fiscal_year_label IS NULL OR fiscal_year_label ~ '^[0-9]{4}/[0-9]{2}$');
  END IF;
END $do$;

-- every column except status, the hold columns, last_modified_by and updated_at is immutable (also for the owner session)
CREATE OR REPLACE TRIGGER account_ledger_entries__mutable_columns BEFORE UPDATE ON billing.account_ledger_entries FOR EACH ROW EXECUTE FUNCTION
  app.enforce_mutable_columns('status','held_reason','held_by','held_at','released_by','released_at','last_modified_by','updated_at');
-- hold: submitted -> held (released_* cleared); release: held -> submitted (released_by / released_at set, held_* kept as history); nothing else
CREATE OR REPLACE FUNCTION billing.account_ledger_hold_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    IF (NEW.held_reason, NEW.held_by, NEW.held_at, NEW.released_by, NEW.released_at) IS DISTINCT FROM (OLD.held_reason, OLD.held_by, OLD.held_at, OLD.released_by, OLD.released_at) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'billing.account_ledger_entries';
    END IF;
  ELSIF OLD.status = 'submitted' AND NEW.status = 'held' THEN
    NULL;   -- the held check constraint demands reason, holder, time and no release columns
  ELSIF OLD.status = 'held' AND NEW.status = 'submitted' THEN
    IF NEW.released_by IS NULL OR NEW.released_at IS NULL
       OR (NEW.held_reason, NEW.held_by, NEW.held_at) IS DISTINCT FROM (OLD.held_reason, OLD.held_by, OLD.held_at) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'billing.account_ledger_entries';
    END IF;
  ELSE
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'billing.account_ledger_entries';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER account_ledger_entries__hold_guard BEFORE UPDATE ON billing.account_ledger_entries FOR EACH ROW EXECUTE FUNCTION billing.account_ledger_hold_guard();
-- column triggers fire when a column is NAMED in SET, even with an unchanged value: the immutable columns are never assignable, the hold / release columns only with a status change
CREATE OR REPLACE FUNCTION billing.account_ledger_column_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_ARGV[0] = 'immutable' OR NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'billing.account_ledger_entries';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER account_ledger_entries__immutable_columns BEFORE UPDATE OF id, tenant_id, centre_id, party_kind, party_id, entry_date, account_particular_id, entry_type,
  amount_paisa, payment_mode, bank_name, reference_no, payment_details, comments, reverses_entry_id, receipt_no, receipt_seq, created_at, created_by, fiscal_year_label
  ON billing.account_ledger_entries FOR EACH ROW EXECUTE FUNCTION billing.account_ledger_column_guard('immutable');
CREATE OR REPLACE TRIGGER account_ledger_entries__hold_columns BEFORE UPDATE OF held_reason, held_by, held_at, released_by, released_at
  ON billing.account_ledger_entries FOR EACH ROW EXECUTE FUNCTION billing.account_ledger_column_guard('hold');

DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'billing.account_ledger_entries'::regclass AND polname = 'account_ledger_entries__update__tenant') THEN
  CREATE POLICY account_ledger_entries__update__tenant ON billing.account_ledger_entries FOR UPDATE TO lims_app
    USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
    WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
END IF; END $do$;
GRANT UPDATE (status, last_modified_by, updated_at, held_reason, held_by, held_at, released_by, released_at) ON billing.account_ledger_entries TO lims_app;

-- ---------- cash sessions: carried forward cash and deposit ----------
ALTER TABLE billing.cash_sessions ADD COLUMN IF NOT EXISTS previous_outstanding_cash_paisa bigint NOT NULL DEFAULT 0, ADD COLUMN IF NOT EXISTS deposit_paisa bigint NOT NULL DEFAULT 0;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'billing.cash_sessions'::regclass AND conname = 'cash_sessions__carry_deposit__ck') THEN
    ALTER TABLE billing.cash_sessions ADD CONSTRAINT cash_sessions__carry_deposit__ck CHECK (previous_outstanding_cash_paisa >= 0 AND deposit_paisa >= 0);
  END IF;
END $do$;
-- previous_outstanding_cash_paisa is set at open only; deposit_paisa stays editable (the cashier records the deposit on the Daily Payment Collection screen)
CREATE OR REPLACE TRIGGER cash_sessions__mutable_columns BEFORE UPDATE ON billing.cash_sessions FOR EACH ROW EXECUTE FUNCTION app.enforce_mutable_columns(
  'status','closed_at','expected','counted','variance_paisa','close_note','updated_at','updated_by','version','deposit_paisa');

-- ---------- RLS, policies, grants of the four new tables ----------
ALTER TABLE billing.discount_reason ENABLE ROW LEVEL SECURITY;  ALTER TABLE billing.discount_reason FORCE ROW LEVEL SECURITY;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'billing.discount_reason'::regclass AND polname = 'discount_reason__select__tenant') THEN
  CREATE POLICY discount_reason__select__tenant ON billing.discount_reason FOR SELECT TO lims_app
    USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
END IF; END $do$;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'billing.discount_reason'::regclass AND polname = 'discount_reason__insert__tenant') THEN
  CREATE POLICY discount_reason__insert__tenant ON billing.discount_reason FOR INSERT TO lims_app
    WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
END IF; END $do$;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'billing.discount_reason'::regclass AND polname = 'discount_reason__update__tenant') THEN
  CREATE POLICY discount_reason__update__tenant ON billing.discount_reason FOR UPDATE TO lims_app
    USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
    WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
END IF; END $do$;
GRANT SELECT, INSERT, UPDATE ON billing.discount_reason TO lims_app;

ALTER TABLE billing.party_discount_slab ENABLE ROW LEVEL SECURITY;  ALTER TABLE billing.party_discount_slab FORCE ROW LEVEL SECURITY;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'billing.party_discount_slab'::regclass AND polname = 'party_discount_slab__select__tenant') THEN
  CREATE POLICY party_discount_slab__select__tenant ON billing.party_discount_slab FOR SELECT TO lims_app
    USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
END IF; END $do$;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'billing.party_discount_slab'::regclass AND polname = 'party_discount_slab__insert__tenant') THEN
  CREATE POLICY party_discount_slab__insert__tenant ON billing.party_discount_slab FOR INSERT TO lims_app
    WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
END IF; END $do$;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'billing.party_discount_slab'::regclass AND polname = 'party_discount_slab__update__tenant') THEN
  CREATE POLICY party_discount_slab__update__tenant ON billing.party_discount_slab FOR UPDATE TO lims_app
    USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
    WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
END IF; END $do$;
GRANT SELECT, INSERT, UPDATE ON billing.party_discount_slab TO lims_app;

ALTER TABLE billing.user_discount_limit ENABLE ROW LEVEL SECURITY;  ALTER TABLE billing.user_discount_limit FORCE ROW LEVEL SECURITY;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'billing.user_discount_limit'::regclass AND polname = 'user_discount_limit__select__tenant') THEN
  CREATE POLICY user_discount_limit__select__tenant ON billing.user_discount_limit FOR SELECT TO lims_app
    USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
END IF; END $do$;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'billing.user_discount_limit'::regclass AND polname = 'user_discount_limit__insert__tenant') THEN
  CREATE POLICY user_discount_limit__insert__tenant ON billing.user_discount_limit FOR INSERT TO lims_app
    WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
END IF; END $do$;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'billing.user_discount_limit'::regclass AND polname = 'user_discount_limit__update__tenant') THEN
  CREATE POLICY user_discount_limit__update__tenant ON billing.user_discount_limit FOR UPDATE TO lims_app
    USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
    WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
END IF; END $do$;
GRANT SELECT, INSERT, UPDATE ON billing.user_discount_limit TO lims_app;

ALTER TABLE billing.discount_authority ENABLE ROW LEVEL SECURITY;  ALTER TABLE billing.discount_authority FORCE ROW LEVEL SECURITY;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'billing.discount_authority'::regclass AND polname = 'discount_authority__select__tenant') THEN
  CREATE POLICY discount_authority__select__tenant ON billing.discount_authority FOR SELECT TO lims_app
    USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
END IF; END $do$;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'billing.discount_authority'::regclass AND polname = 'discount_authority__insert__tenant') THEN
  CREATE POLICY discount_authority__insert__tenant ON billing.discount_authority FOR INSERT TO lims_app
    WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
END IF; END $do$;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'billing.discount_authority'::regclass AND polname = 'discount_authority__update__tenant') THEN
  CREATE POLICY discount_authority__update__tenant ON billing.discount_authority FOR UPDATE TO lims_app
    USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
    WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
END IF; END $do$;
GRANT SELECT, INSERT, UPDATE ON billing.discount_authority TO lims_app;

-- ---------- row audit on the four new tables (the ledger keeps none: payment_details is free text) ----------
CREATE OR REPLACE TRIGGER discount_reason__audit AFTER INSERT OR UPDATE OR DELETE ON billing.discount_reason FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE OR REPLACE TRIGGER party_discount_slab__audit AFTER INSERT OR UPDATE OR DELETE ON billing.party_discount_slab FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE OR REPLACE TRIGGER user_discount_limit__audit AFTER INSERT OR UPDATE OR DELETE ON billing.user_discount_limit FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE OR REPLACE TRIGGER discount_authority__audit AFTER INSERT OR UPDATE OR DELETE ON billing.discount_authority FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
