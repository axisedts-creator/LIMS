-- T0B-10.C4: billing schema — C4 05-SCHEMA §4 verbatim, then §4a RLS/policies/grants for billing (literal statements),
-- row-audit triggers (§0.6: every table except class A, g_* and event_inbox; 08 A13 D-27a exclusion list on patients),
-- and the billing v_pub_* views of §6 (03-IC §6). Policies are copied 1:1 to db/policies/billing.sql (AC-0B-2.3).
-- g_* seed rows (§7) belong to db/seeds. event_inbox is C0's (T0B-05).
SET LOCAL ROLE lims_owner;

CREATE SCHEMA IF NOT EXISTS billing AUTHORIZATION lims_owner;   -- C0 creates every module schema (C0 05-SCHEMA §1); kept idempotent like C2/C3/C5

CREATE TABLE billing.settings (
  tenant_id uuid NOT NULL,
  invoice_series_scope text NOT NULL DEFAULT 'tenant',      -- B6/L8
  prices_include_tax boolean NOT NULL DEFAULT false,         -- B7
  abbreviated_invoice_enabled boolean NOT NULL DEFAULT false,-- L9
  pay_by_qr_enabled boolean NOT NULL DEFAULT false,
  receipt_no_enabled boolean NOT NULL DEFAULT true,          -- pattern = TenantSettings.numbering.receiptNoPattern (CR-C2-008); no local copy
  credit_days_auto_lock boolean NOT NULL DEFAULT true,
  cash_variance_alert_paisa bigint NOT NULL DEFAULT 0,
  refund_alert_per_day integer NOT NULL DEFAULT 5,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT settings__pk PRIMARY KEY (tenant_id),
  CONSTRAINT settings__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT settings__scope__ck CHECK (invoice_series_scope IN ('tenant','branch'))
);

-- The former C4 tax-code table is removed (08 R18). Tax types, rates and rules are owned by C3 (catalog.cs_tax_types, catalog.tax_rules);
-- C4 snapshots code + rate per invoice line from CatalogPort.priceFor().tax (invoice_lines.vat_rate_bp, other_tax_code, other_tax_rate_bp, hs_code).

CREATE TABLE billing.fiscal_counters (
  tenant_id uuid NOT NULL, series text NOT NULL, fiscal_year_bs text NOT NULL,
  last_no integer NOT NULL DEFAULT 0, closed_at timestamptz,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT fiscal_counters__pk PRIMARY KEY (tenant_id, series, fiscal_year_bs),
  CONSTRAINT fiscal_counters__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT fiscal_counters__fy__ck CHECK (fiscal_year_bs ~ '^[0-9]{4}/[0-9]{2}$'),
  CONSTRAINT fiscal_counters__series__ck CHECK (series ~ '^(INV|CN|RC)(:[A-Za-z0-9_-]{1,20})?$'),
  CONSTRAINT fiscal_counters__last__ck CHECK (last_no >= 0)
);
CREATE TRIGGER fiscal_counters__mutable_columns BEFORE UPDATE ON billing.fiscal_counters FOR EACH ROW EXECUTE FUNCTION
  app.enforce_mutable_columns('last_no','closed_at','updated_at','updated_by');
-- guard billing.fiscal_counters_guard(): NEW.last_no = OLD.last_no OR NEW.last_no = OLD.last_no + 1;
--   closed_at NULL→value once; no increment when OLD.closed_at IS NOT NULL.
CREATE FUNCTION billing.fiscal_counters_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NOT (NEW.last_no = OLD.last_no OR NEW.last_no = OLD.last_no + 1) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'billing.fiscal_counters';
  END IF;
  IF OLD.closed_at IS NOT NULL AND (NEW.last_no <> OLD.last_no OR NEW.closed_at IS DISTINCT FROM OLD.closed_at) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'billing.fiscal_counters';
  END IF;
  RETURN NEW;
END $$;
ALTER FUNCTION billing.fiscal_counters_guard() OWNER TO lims_owner;
CREATE TRIGGER fiscal_counters__guard BEFORE UPDATE ON billing.fiscal_counters FOR EACH ROW EXECUTE FUNCTION billing.fiscal_counters_guard();

CREATE TABLE billing.invoices (
  id uuid NOT NULL, tenant_id uuid NOT NULL, branch_id uuid NOT NULL, centre_id uuid,
  series text NOT NULL, fiscal_year_bs text NOT NULL, invoice_seq integer NOT NULL, invoice_no text NOT NULL,   -- P0 (fiscal)
  invoice_kind text NOT NULL, purpose text NOT NULL,
  order_id uuid, patient_id uuid,                                     -- P1
  credit_party_id uuid, is_periodic_credit_bill boolean NOT NULL DEFAULT false, period_month date,
  referrer_id uuid,                                                   -- P1
  buyer_name text NOT NULL, buyer_pan text, buyer_address text,       -- P2
  seller_name text NOT NULL, seller_pan text, seller_address text,    -- P0
  issued_at timestamptz NOT NULL, invoice_date_bs text NOT NULL,
  gross_paisa bigint NOT NULL, discount_paisa bigint NOT NULL, exempt_paisa bigint NOT NULL, taxable_paisa bigint NOT NULL,
  vat_paisa bigint NOT NULL, other_tax_paisa bigint NOT NULL, net_paisa bigint NOT NULL,
  prices_include_tax boolean NOT NULL, quote_fingerprint text NOT NULL,   -- tax rates are snapshotted per line (08 R18)
  status text NOT NULL DEFAULT 'issued', is_active boolean NOT NULL DEFAULT true,
  cancelled_at timestamptz, cancelled_by uuid, cancel_reason_code text, cancel_reason_text text, credit_note_id uuid,
  credited_total_paisa bigint NOT NULL DEFAULT 0,
  print_count integer NOT NULL DEFAULT 0, last_printed_at timestamptz,
  cbms_state text NOT NULL, cbms_attempts integer NOT NULL DEFAULT 0, cbms_last_attempt_at timestamptz,
  cbms_synced_at timestamptz, cbms_external_ref text,
  -- CBMS document 'invoice_cancellation' (TRD §9): own lifecycle, NULL until the invoice is cancelled
  cbms_cancel_state text, cbms_cancel_attempts integer NOT NULL DEFAULT 0, cbms_cancel_last_attempt_at timestamptz,
  cbms_cancel_synced_at timestamptz, cbms_cancel_external_ref text,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT invoices__pk PRIMARY KEY (id),
  CONSTRAINT invoices__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT invoices__tenant_id_no__uq UNIQUE (tenant_id, fiscal_year_bs, invoice_no),
  CONSTRAINT invoices__tenant_id_series_seq__uq UNIQUE (tenant_id, series, fiscal_year_bs, invoice_seq),
  CONSTRAINT invoices__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT invoices__branch__fk FOREIGN KEY (tenant_id, branch_id) REFERENCES core.branches (tenant_id, id),
  CONSTRAINT invoices__centre__fk FOREIGN KEY (tenant_id, centre_id) REFERENCES core.collection_centres (tenant_id, id),
  CONSTRAINT invoices__fy__ck CHECK (fiscal_year_bs ~ '^[0-9]{4}/[0-9]{2}$'),
  CONSTRAINT invoices__series__ck CHECK (series ~ '^INV(:[A-Za-z0-9_-]{1,20})?$'),
  CONSTRAINT invoices__seq__ck CHECK (invoice_seq >= 1),
  CONSTRAINT invoices__kind__ck CHECK (invoice_kind IN ('tax_invoice','abbreviated_tax_invoice')),
  CONSTRAINT invoices__purpose__ck CHECK (purpose IN ('registration','supplementary','periodic_credit')),
  CONSTRAINT invoices__subject__ck CHECK (
      (purpose IN ('registration','supplementary') AND order_id IS NOT NULL AND patient_id IS NOT NULL AND NOT is_periodic_credit_bill AND centre_id IS NOT NULL)
   OR (purpose = 'periodic_credit' AND order_id IS NULL AND credit_party_id IS NOT NULL AND is_periodic_credit_bill AND period_month IS NOT NULL)),
  CONSTRAINT invoices__date_bs__ck CHECK (invoice_date_bs ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  CONSTRAINT invoices__totals__ck CHECK (gross_paisa >= 0 AND discount_paisa >= 0 AND discount_paisa <= gross_paisa
      AND exempt_paisa >= 0 AND taxable_paisa >= 0 AND vat_paisa >= 0 AND other_tax_paisa >= 0
      AND gross_paisa - discount_paisa = exempt_paisa + taxable_paisa
      AND net_paisa = exempt_paisa + taxable_paisa + vat_paisa + other_tax_paisa),
  CONSTRAINT invoices__credited__ck CHECK (credited_total_paisa BETWEEN 0 AND net_paisa),
  CONSTRAINT invoices__status__ck CHECK (status IN ('issued','cancelled')),
  CONSTRAINT invoices__cancel__ck CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL AND cancel_reason_code IS NOT NULL
                                          AND credit_note_id IS NOT NULL AND NOT is_active)),
  CONSTRAINT invoices__active__ck CHECK (is_active = (status = 'issued')),
  CONSTRAINT invoices__print__ck CHECK (print_count >= 0),
  CONSTRAINT invoices__cbms__ck CHECK (cbms_state IN ('not_required','pending','synced','failed_permanent')),
  CONSTRAINT invoices__cbms_cancel__ck CHECK ((cbms_cancel_state IS NULL OR cbms_cancel_state IN ('not_required','pending','synced','failed_permanent'))
                                              AND (status = 'cancelled' OR cbms_cancel_state IS NULL)
                                              AND cbms_cancel_attempts >= 0),
  CONSTRAINT invoices__fp__ck CHECK (quote_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT invoices__pan__ck CHECK (buyer_pan IS NULL OR char_length(buyer_pan) <= 20)
);
CREATE INDEX invoices__tenant_id_issued_at__idx ON billing.invoices (tenant_id, issued_at DESC);
CREATE INDEX invoices__tenant_id_order_id__idx ON billing.invoices (tenant_id, order_id) WHERE order_id IS NOT NULL;
CREATE INDEX invoices__tenant_id_credit_party_id_period__idx ON billing.invoices (tenant_id, credit_party_id, period_month) WHERE credit_party_id IS NOT NULL;
CREATE INDEX invoices__tenant_id_centre_id_issued_at__idx ON billing.invoices (tenant_id, centre_id, issued_at);
CREATE INDEX invoices__tenant_id_cancelled_at__p_idx ON billing.invoices (tenant_id, cancelled_at) WHERE status = 'cancelled';
CREATE INDEX invoices__tenant_id_cbms__p_idx ON billing.invoices (tenant_id, cbms_state, cbms_last_attempt_at) WHERE cbms_state = 'pending';
CREATE INDEX invoices__tenant_id_cbms_cancel__p_idx ON billing.invoices (tenant_id, cbms_cancel_state, cbms_cancel_last_attempt_at) WHERE cbms_cancel_state = 'pending';
CREATE UNIQUE INDEX invoices__tenant_id_order_registration__p_uq ON billing.invoices (tenant_id, order_id) WHERE purpose = 'registration';
CREATE TRIGGER invoices__mutable_columns BEFORE UPDATE ON billing.invoices FOR EACH ROW EXECUTE FUNCTION app.enforce_mutable_columns(
  'status','is_active','cancelled_at','cancelled_by','cancel_reason_code','cancel_reason_text','credit_note_id',
  'credited_total_paisa','print_count','last_printed_at',
  'cbms_state','cbms_attempts','cbms_last_attempt_at','cbms_synced_at','cbms_external_ref',
  'cbms_cancel_state','cbms_cancel_attempts','cbms_cancel_last_attempt_at','cbms_cancel_synced_at','cbms_cancel_external_ref',
  'updated_at','updated_by','version');
-- billing.invoices_lifecycle_guard() BEFORE UPDATE:
--   status: issued→cancelled only (cancelled→issued impossible, 02-CV §5.7);
--   cancellation columns: NULL→value only on that transition, frozen afterwards;
--   print_count: NEW = OLD or OLD + 1; credited_total_paisa: NEW >= OLD;
--   cbms_state: not_required→pending | pending→synced|failed_permanent | failed_permanent→pending; synced terminal.
--   cbms_cancel_state: NULL→not_required|pending only on the issued→cancelled transition; then the same transitions as cbms_state.
-- billing.invoices_chronology_guard() BEFORE INSERT:
--   NEW.invoice_seq = (SELECT last_no FROM billing.fiscal_counters WHERE tenant_id=NEW.tenant_id AND series=NEW.series
--                      AND fiscal_year_bs=NEW.fiscal_year_bs FOR SHARE) AND
--   NOT EXISTS (SELECT 1 FROM billing.invoices i WHERE i.tenant_id=NEW.tenant_id AND i.series=NEW.series
--               AND i.fiscal_year_bs=NEW.fiscal_year_bs AND (i.invoice_seq >= NEW.invoice_seq OR i.issued_at > NEW.issued_at))
-- Both guards are SECURITY INVOKER (§3 header), so the NOT EXISTS sees the rows the inserting actor's TCN policy admits; the
-- counter equality and invoices__tenant_id_series_seq__uq hold for every row regardless, and billing.integrity_check (TRD §15)
-- checks the whole series nightly.
CREATE FUNCTION billing.invoices_lifecycle_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_cancelling boolean := (OLD.status = 'issued' AND NEW.status = 'cancelled');
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT v_cancelling THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'billing.invoices';
  END IF;
  IF (NEW.cancelled_at, NEW.cancelled_by, NEW.cancel_reason_code, NEW.cancel_reason_text, NEW.credit_note_id)
     IS DISTINCT FROM (OLD.cancelled_at, OLD.cancelled_by, OLD.cancel_reason_code, OLD.cancel_reason_text, OLD.credit_note_id)
     AND NOT (v_cancelling AND OLD.cancelled_at IS NULL AND OLD.cancelled_by IS NULL AND OLD.cancel_reason_code IS NULL
              AND OLD.cancel_reason_text IS NULL AND OLD.credit_note_id IS NULL) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'billing.invoices';
  END IF;
  IF NOT (NEW.print_count = OLD.print_count OR NEW.print_count = OLD.print_count + 1)
     OR NEW.credited_total_paisa < OLD.credited_total_paisa THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'billing.invoices';
  END IF;
  IF NEW.cbms_state IS DISTINCT FROM OLD.cbms_state
     AND NOT coalesce((OLD.cbms_state = 'not_required' AND NEW.cbms_state = 'pending')
                      OR (OLD.cbms_state = 'pending' AND NEW.cbms_state IN ('synced','failed_permanent'))
                      OR (OLD.cbms_state = 'failed_permanent' AND NEW.cbms_state = 'pending'), false) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'billing.invoices';
  END IF;
  IF NEW.cbms_cancel_state IS DISTINCT FROM OLD.cbms_cancel_state
     AND NOT coalesce(CASE WHEN OLD.cbms_cancel_state IS NULL
                           THEN v_cancelling AND NEW.cbms_cancel_state IN ('not_required','pending')
                           ELSE (OLD.cbms_cancel_state = 'not_required' AND NEW.cbms_cancel_state = 'pending')
                             OR (OLD.cbms_cancel_state = 'pending' AND NEW.cbms_cancel_state IN ('synced','failed_permanent'))
                             OR (OLD.cbms_cancel_state = 'failed_permanent' AND NEW.cbms_cancel_state = 'pending') END, false) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'billing.invoices';
  END IF;
  RETURN NEW;
END $$;
ALTER FUNCTION billing.invoices_lifecycle_guard() OWNER TO lims_owner;
CREATE FUNCTION billing.invoices_chronology_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE v_last integer;
BEGIN
  SELECT c.last_no INTO v_last FROM billing.fiscal_counters c
   WHERE c.tenant_id = NEW.tenant_id AND c.series = NEW.series AND c.fiscal_year_bs = NEW.fiscal_year_bs FOR SHARE;
  IF v_last IS DISTINCT FROM NEW.invoice_seq
     OR EXISTS (SELECT 1 FROM billing.invoices d
                 WHERE d.tenant_id = NEW.tenant_id AND d.series = NEW.series AND d.fiscal_year_bs = NEW.fiscal_year_bs
                   AND (d.invoice_seq >= NEW.invoice_seq OR d.issued_at > NEW.issued_at)) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'chronology_violation', DETAIL = 'billing.invoices';
  END IF;
  RETURN NEW;
END $$;
ALTER FUNCTION billing.invoices_chronology_guard() OWNER TO lims_owner;
CREATE TRIGGER invoices__lifecycle_guard BEFORE UPDATE ON billing.invoices FOR EACH ROW EXECUTE FUNCTION billing.invoices_lifecycle_guard();
CREATE TRIGGER invoices__chronology_guard BEFORE INSERT ON billing.invoices FOR EACH ROW EXECUTE FUNCTION billing.invoices_chronology_guard();

CREATE TABLE billing.invoice_lines (
  id uuid NOT NULL, tenant_id uuid NOT NULL, invoice_id uuid NOT NULL, centre_id uuid,
  line_no integer NOT NULL, line_kind text NOT NULL,
  order_item_id uuid, orderable_id uuid, orderable_kind text,           -- P3 (with invoice → patient)
  credit_charge_id uuid,
  code text NOT NULL, name text NOT NULL,                                -- P3
  department_id uuid, hs_code text,
  quantity integer NOT NULL DEFAULT 1, unit_price_paisa bigint NOT NULL,
  gross_paisa bigint NOT NULL, discount_paisa bigint NOT NULL, exempt_paisa bigint NOT NULL, taxable_paisa bigint NOT NULL,
  vat_treatment text NOT NULL, vat_rate_bp integer, vat_paisa bigint NOT NULL,      -- vat_rate_bp NULL iff exempt
  other_tax_code text, other_tax_rate_bp integer, other_tax_paisa bigint NOT NULL, net_paisa bigint NOT NULL,
  price_list_id uuid, price_list_version integer, price_source text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  CONSTRAINT invoice_lines__pk PRIMARY KEY (id),
  CONSTRAINT invoice_lines__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT invoice_lines__tenant_id_invoice_line_no__uq UNIQUE (tenant_id, invoice_id, line_no),
  CONSTRAINT invoice_lines__invoice__fk FOREIGN KEY (tenant_id, invoice_id) REFERENCES billing.invoices (tenant_id, id),
  CONSTRAINT invoice_lines__kind__ck CHECK (line_kind IN ('orderable','urgent_surcharge','credit_charge')),
  CONSTRAINT invoice_lines__vat__ck CHECK ((vat_treatment = 'exempt' AND vat_paisa = 0 AND vat_rate_bp IS NULL)
                                        OR (vat_treatment = 'taxable' AND vat_rate_bp BETWEEN 0 AND 10000)),
  CONSTRAINT invoice_lines__amounts__ck CHECK (quantity = 1 AND unit_price_paisa >= 0 AND gross_paisa >= 0
      AND discount_paisa BETWEEN 0 AND gross_paisa
      AND gross_paisa - discount_paisa = exempt_paisa + taxable_paisa
      AND ((vat_treatment = 'exempt' AND taxable_paisa = 0) OR (vat_treatment = 'taxable' AND exempt_paisa = 0))
      AND net_paisa = exempt_paisa + taxable_paisa + vat_paisa + other_tax_paisa),
  CONSTRAINT invoice_lines__other_tax__ck CHECK ((other_tax_code IS NULL AND other_tax_paisa = 0 AND other_tax_rate_bp IS NULL)
                                              OR (other_tax_code IS NOT NULL AND other_tax_rate_bp BETWEEN 0 AND 10000)),
  CONSTRAINT invoice_lines__hs__ck CHECK (hs_code IS NULL OR hs_code ~ '^[0-9]{4,10}$')
);
CREATE INDEX invoice_lines__tenant_id_invoice_id__idx ON billing.invoice_lines (tenant_id, invoice_id);
CREATE INDEX invoice_lines__tenant_id_order_item_id__idx ON billing.invoice_lines (tenant_id, order_item_id) WHERE order_item_id IS NOT NULL;
-- No UPDATE grant at all (fully immutable).

CREATE TABLE billing.credit_notes (
  id uuid NOT NULL, tenant_id uuid NOT NULL, branch_id uuid NOT NULL, centre_id uuid,
  series text NOT NULL DEFAULT 'CN', fiscal_year_bs text NOT NULL, credit_note_seq integer NOT NULL, credit_note_no text NOT NULL,
  kind text NOT NULL, invoice_id uuid NOT NULL, invoice_no text NOT NULL, invoice_fiscal_year_bs text NOT NULL,
  order_id uuid, credit_party_id uuid,
  buyer_name text NOT NULL, buyer_pan text,                              -- P2
  issued_at timestamptz NOT NULL, credit_note_date_bs text NOT NULL,
  reason_code text NOT NULL, reason_text text,
  gross_paisa bigint NOT NULL, discount_paisa bigint NOT NULL, exempt_paisa bigint NOT NULL, taxable_paisa bigint NOT NULL,
  vat_paisa bigint NOT NULL, other_tax_paisa bigint NOT NULL, net_paisa bigint NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  print_count integer NOT NULL DEFAULT 0, last_printed_at timestamptz,
  cbms_state text NOT NULL, cbms_attempts integer NOT NULL DEFAULT 0, cbms_last_attempt_at timestamptz,
  cbms_synced_at timestamptz, cbms_external_ref text,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT credit_notes__pk PRIMARY KEY (id),
  CONSTRAINT credit_notes__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT credit_notes__tenant_id_series_seq__uq UNIQUE (tenant_id, series, fiscal_year_bs, credit_note_seq),
  CONSTRAINT credit_notes__tenant_id_no__uq UNIQUE (tenant_id, fiscal_year_bs, credit_note_no),
  CONSTRAINT credit_notes__invoice__fk FOREIGN KEY (tenant_id, invoice_id) REFERENCES billing.invoices (tenant_id, id),
  CONSTRAINT credit_notes__branch__fk FOREIGN KEY (tenant_id, branch_id) REFERENCES core.branches (tenant_id, id),
  CONSTRAINT credit_notes__centre__fk FOREIGN KEY (tenant_id, centre_id) REFERENCES core.collection_centres (tenant_id, id),
  CONSTRAINT credit_notes__series__ck CHECK (series = 'CN'),
  CONSTRAINT credit_notes__kind__ck CHECK (kind IN ('cancellation','partial')),
  CONSTRAINT credit_notes__totals__ck CHECK (net_paisa > 0 AND gross_paisa - discount_paisa = exempt_paisa + taxable_paisa
      AND net_paisa = exempt_paisa + taxable_paisa + vat_paisa + other_tax_paisa),
  CONSTRAINT credit_notes__cbms__ck CHECK (cbms_state IN ('not_required','pending','synced','failed_permanent'))
);
CREATE INDEX credit_notes__tenant_id_invoice_id__idx ON billing.credit_notes (tenant_id, invoice_id);
CREATE INDEX credit_notes__tenant_id_issued_at__idx ON billing.credit_notes (tenant_id, issued_at DESC);
CREATE INDEX credit_notes__tenant_id_credit_party_id_issued_at__p_idx ON billing.credit_notes (tenant_id, credit_party_id, issued_at) WHERE credit_party_id IS NOT NULL;   -- B23
CREATE INDEX credit_notes__tenant_id_cbms__p_idx ON billing.credit_notes (tenant_id, cbms_state, cbms_last_attempt_at) WHERE cbms_state = 'pending';               -- CBMS sweep
CREATE UNIQUE INDEX credit_notes__tenant_id_invoice_cancellation__p_uq ON billing.credit_notes (tenant_id, invoice_id) WHERE kind = 'cancellation';
CREATE TRIGGER credit_notes__mutable_columns BEFORE UPDATE ON billing.credit_notes FOR EACH ROW EXECUTE FUNCTION app.enforce_mutable_columns(
  'print_count','last_printed_at','cbms_state','cbms_attempts','cbms_last_attempt_at','cbms_synced_at','cbms_external_ref',
  'updated_at','updated_by','version');
CREATE FUNCTION billing.credit_notes_chronology_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE v_last integer;
BEGIN
  SELECT c.last_no INTO v_last FROM billing.fiscal_counters c
   WHERE c.tenant_id = NEW.tenant_id AND c.series = NEW.series AND c.fiscal_year_bs = NEW.fiscal_year_bs FOR SHARE;
  IF v_last IS DISTINCT FROM NEW.credit_note_seq
     OR EXISTS (SELECT 1 FROM billing.credit_notes d
                 WHERE d.tenant_id = NEW.tenant_id AND d.series = NEW.series AND d.fiscal_year_bs = NEW.fiscal_year_bs
                   AND (d.credit_note_seq >= NEW.credit_note_seq OR d.issued_at > NEW.issued_at)) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'chronology_violation', DETAIL = 'billing.credit_notes';
  END IF;
  RETURN NEW;
END $$;
ALTER FUNCTION billing.credit_notes_chronology_guard() OWNER TO lims_owner;
CREATE TRIGGER credit_notes__chronology_guard BEFORE INSERT ON billing.credit_notes FOR EACH ROW EXECUTE FUNCTION billing.credit_notes_chronology_guard(); -- same rule as invoices

CREATE TABLE billing.credit_note_lines (
  id uuid NOT NULL, tenant_id uuid NOT NULL, credit_note_id uuid NOT NULL, invoice_line_id uuid NOT NULL, centre_id uuid,
  gross_paisa bigint NOT NULL, discount_paisa bigint NOT NULL, exempt_paisa bigint NOT NULL, taxable_paisa bigint NOT NULL,
  vat_paisa bigint NOT NULL, other_tax_paisa bigint NOT NULL, net_paisa bigint NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  CONSTRAINT credit_note_lines__pk PRIMARY KEY (id),
  CONSTRAINT credit_note_lines__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT credit_note_lines__note__fk FOREIGN KEY (tenant_id, credit_note_id) REFERENCES billing.credit_notes (tenant_id, id),
  CONSTRAINT credit_note_lines__line__fk FOREIGN KEY (tenant_id, invoice_line_id) REFERENCES billing.invoice_lines (tenant_id, id),
  CONSTRAINT credit_note_lines__amounts__ck CHECK (net_paisa > 0 AND gross_paisa - discount_paisa = exempt_paisa + taxable_paisa
      AND net_paisa = exempt_paisa + taxable_paisa + vat_paisa + other_tax_paisa)
);
CREATE INDEX credit_note_lines__tenant_id_invoice_line_id__idx ON billing.credit_note_lines (tenant_id, invoice_line_id);
-- guard billing.credit_note_lines_guard() BEFORE INSERT: Σ net of credit_note_lines per invoice_line ≤ invoice_lines.net_paisa.
-- Concurrent credit notes on one invoice are serialised by B4's lock on the invoice row (TRD §12 lock order).
CREATE FUNCTION billing.credit_note_lines_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE v_line_net bigint; v_credited bigint;
BEGIN
  SELECT l.net_paisa INTO v_line_net FROM billing.invoice_lines l
   WHERE l.tenant_id = NEW.tenant_id AND l.id = NEW.invoice_line_id;
  SELECT coalesce(sum(cl.net_paisa), 0) INTO v_credited FROM billing.credit_note_lines cl
   WHERE cl.tenant_id = NEW.tenant_id AND cl.invoice_line_id = NEW.invoice_line_id;
  IF v_line_net IS NULL OR v_credited + NEW.net_paisa > v_line_net THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'credit_exceeds_invoice_line', DETAIL = 'billing.credit_note_lines';
  END IF;
  RETURN NEW;
END $$;
ALTER FUNCTION billing.credit_note_lines_guard() OWNER TO lims_owner;
CREATE TRIGGER credit_note_lines__guard BEFORE INSERT ON billing.credit_note_lines FOR EACH ROW EXECUTE FUNCTION billing.credit_note_lines_guard();

CREATE TABLE billing.cash_sessions (
  id uuid NOT NULL, tenant_id uuid NOT NULL, branch_id uuid NOT NULL, centre_id uuid NOT NULL, membership_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'open', opened_at timestamptz NOT NULL,
  closed_at timestamptz, expected jsonb, counted jsonb, variance_paisa bigint, close_note text,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT cash_sessions__pk PRIMARY KEY (id),
  CONSTRAINT cash_sessions__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT cash_sessions__branch__fk FOREIGN KEY (tenant_id, branch_id) REFERENCES core.branches (tenant_id, id),
  CONSTRAINT cash_sessions__centre__fk FOREIGN KEY (tenant_id, centre_id) REFERENCES core.collection_centres (tenant_id, id),
  CONSTRAINT cash_sessions__member__fk FOREIGN KEY (tenant_id, membership_id) REFERENCES core.memberships (tenant_id, id),
  CONSTRAINT cash_sessions__status__ck CHECK (status IN ('open','closed')),
  CONSTRAINT cash_sessions__closed__ck CHECK ((status = 'closed') = (closed_at IS NOT NULL AND counted IS NOT NULL AND expected IS NOT NULL))
);
CREATE UNIQUE INDEX cash_sessions__tenant_id_open__p_uq ON billing.cash_sessions (tenant_id, membership_id, centre_id) WHERE status = 'open';
CREATE INDEX cash_sessions__tenant_id_opened_at__idx ON billing.cash_sessions (tenant_id, opened_at);
CREATE TRIGGER cash_sessions__mutable_columns BEFORE UPDATE ON billing.cash_sessions FOR EACH ROW EXECUTE FUNCTION app.enforce_mutable_columns(
  'status','closed_at','expected','counted','variance_paisa','close_note','updated_at','updated_by','version');
-- guard: open→closed only.
CREATE FUNCTION billing.cash_sessions_lifecycle_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT coalesce(OLD.status = 'open' AND NEW.status = 'closed', false) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'billing.cash_sessions';
  END IF;
  RETURN NEW;
END $$;
ALTER FUNCTION billing.cash_sessions_lifecycle_guard() OWNER TO lims_owner;
CREATE TRIGGER cash_sessions__lifecycle_guard BEFORE UPDATE ON billing.cash_sessions FOR EACH ROW EXECUTE FUNCTION billing.cash_sessions_lifecycle_guard();

CREATE TABLE billing.ledger_entries (
  id uuid NOT NULL, tenant_id uuid NOT NULL, branch_id uuid NOT NULL, centre_id uuid,
  order_id uuid, invoice_id uuid, credit_party_id uuid,                       -- P1
  entry_kind text NOT NULL, capture_kind text NOT NULL, method_code text NOT NULL,
  amount_paisa bigint NOT NULL,                                               -- signed
  reverses_entry_id uuid, reason_code text, reason_text text,
  reference_text text,                                                        -- masked / gateway ref only (REQ-SEC-056)
  gateway text, gateway_txn_ref text, intent_id uuid,
  receipt_no text, receipt_seq integer, fiscal_year_bs text NOT NULL,
  cash_session_id uuid,
  collected_by_membership_id uuid, approved_by_membership_id uuid,          -- collected_by NULL iff capture_kind = 'gateway' (08 R8)
  refund_request_id uuid,                                                     -- manual refunds only (08 A13 D-24)
  idempotency_key text, captured_at_device timestamptz,
  business_date date NOT NULL,                                                -- in tenant tz
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  CONSTRAINT ledger_entries__pk PRIMARY KEY (id),
  CONSTRAINT ledger_entries__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT ledger_entries__invoice__fk FOREIGN KEY (tenant_id, invoice_id) REFERENCES billing.invoices (tenant_id, id),
  CONSTRAINT ledger_entries__reverses__fk FOREIGN KEY (tenant_id, reverses_entry_id) REFERENCES billing.ledger_entries (tenant_id, id),
  CONSTRAINT ledger_entries__session__fk FOREIGN KEY (tenant_id, cash_session_id) REFERENCES billing.cash_sessions (tenant_id, id),
  CONSTRAINT ledger_entries__branch__fk FOREIGN KEY (tenant_id, branch_id) REFERENCES core.branches (tenant_id, id),
  CONSTRAINT ledger_entries__centre__fk FOREIGN KEY (tenant_id, centre_id) REFERENCES core.collection_centres (tenant_id, id),
  CONSTRAINT ledger_entries__collector__fk FOREIGN KEY (tenant_id, collected_by_membership_id) REFERENCES core.memberships (tenant_id, id),
  CONSTRAINT ledger_entries__approver__fk FOREIGN KEY (tenant_id, approved_by_membership_id) REFERENCES core.memberships (tenant_id, id),
  CONSTRAINT ledger_entries__kind__ck CHECK (entry_kind IN ('payment','reversal','refund')),
  CONSTRAINT ledger_entries__capture__ck CHECK (capture_kind IN ('manual','gateway','home_collection')),
  CONSTRAINT ledger_entries__sign__ck CHECK ((entry_kind = 'payment' AND amount_paisa > 0) OR (entry_kind IN ('reversal','refund') AND amount_paisa < 0)),
  CONSTRAINT ledger_entries__reversal__ck CHECK ((entry_kind = 'reversal') = (reverses_entry_id IS NOT NULL)),
  CONSTRAINT ledger_entries__reason__ck CHECK (entry_kind = 'payment' OR reason_code IS NOT NULL),
  CONSTRAINT ledger_entries__refund_approver__ck CHECK (entry_kind <> 'refund' OR approved_by_membership_id IS NOT NULL),
  CONSTRAINT ledger_entries__subject__ck CHECK (order_id IS NOT NULL OR (credit_party_id IS NOT NULL AND invoice_id IS NOT NULL)),
  CONSTRAINT ledger_entries__gateway__ck CHECK ((capture_kind = 'gateway') = (gateway IS NOT NULL AND gateway_txn_ref IS NOT NULL AND intent_id IS NOT NULL)),
  CONSTRAINT ledger_entries__gateway_val__ck CHECK (gateway IS NULL OR gateway IN ('esewa','khalti','fonepay')),
  CONSTRAINT ledger_entries__ref__ck CHECK (reference_text IS NULL OR (char_length(reference_text) <= 100 AND reference_text !~ '[0-9]{13,19}')),
  CONSTRAINT ledger_entries__fy__ck CHECK (fiscal_year_bs ~ '^[0-9]{4}/[0-9]{2}$'),
  CONSTRAINT ledger_entries__collector__ck CHECK ((capture_kind = 'gateway') = (collected_by_membership_id IS NULL)),
  CONSTRAINT ledger_entries__refund_request__ck CHECK ((refund_request_id IS NULL OR entry_kind = 'refund')
                                                    AND (entry_kind <> 'refund' OR capture_kind = 'gateway' OR refund_request_id IS NOT NULL))
);
CREATE INDEX ledger_entries__tenant_id_order_id__idx ON billing.ledger_entries (tenant_id, order_id) WHERE order_id IS NOT NULL;
CREATE INDEX ledger_entries__tenant_id_business_date_collector__idx ON billing.ledger_entries (tenant_id, business_date, collected_by_membership_id, method_code);
CREATE INDEX ledger_entries__tenant_id_session__idx ON billing.ledger_entries (tenant_id, cash_session_id) WHERE cash_session_id IS NOT NULL;
CREATE INDEX ledger_entries__tenant_id_credit_party__p_idx ON billing.ledger_entries (tenant_id, credit_party_id, created_at) WHERE credit_party_id IS NOT NULL;
CREATE UNIQUE INDEX ledger_entries__tenant_id_gateway_txn__p_uq ON billing.ledger_entries (tenant_id, gateway, gateway_txn_ref) WHERE capture_kind = 'gateway' AND entry_kind = 'payment';
CREATE UNIQUE INDEX ledger_entries__tenant_id_idem__p_uq ON billing.ledger_entries (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX ledger_entries__tenant_id_reverses__p_uq ON billing.ledger_entries (tenant_id, reverses_entry_id) WHERE reverses_entry_id IS NOT NULL;
CREATE UNIQUE INDEX ledger_entries__tenant_id_receipt__p_uq ON billing.ledger_entries (tenant_id, fiscal_year_bs, receipt_seq) WHERE receipt_seq IS NOT NULL;
CREATE UNIQUE INDEX ledger_entries__tenant_id_refund_request__p_uq ON billing.ledger_entries (tenant_id, refund_request_id) WHERE refund_request_id IS NOT NULL;
CREATE INDEX ledger_entries__tenant_id_created_at__idx ON billing.ledger_entries (tenant_id, created_at);   -- B11 created_at_from/to
-- No UPDATE / DELETE grant (REQ-SEC-057). Guard billing.ledger_reversal_guard() BEFORE INSERT for reversals:
--   amount_paisa = -(original amount), original is a payment, same tenant, and the reversal copies the original's
--   capture_kind, method_code, gateway, gateway_txn_ref, intent_id, collected_by_membership_id, order_id, invoice_id,
--   credit_party_id, branch_id, centre_id (TRD §6.5; review C4 #17). cash_session_id = original's if still open, else the
--   reverser's open session for that centre, else NULL (B22 / home_collection / gateway rows have no session).
CREATE FUNCTION billing.ledger_reversal_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE o billing.ledger_entries%ROWTYPE; v_session uuid;
BEGIN
  IF NEW.entry_kind <> 'reversal' THEN RETURN NEW; END IF;
  SELECT e.* INTO o FROM billing.ledger_entries e WHERE e.tenant_id = NEW.tenant_id AND e.id = NEW.reverses_entry_id;
  IF NOT FOUND OR o.entry_kind <> 'payment' OR NEW.amount_paisa <> -o.amount_paisa
     OR (NEW.capture_kind, NEW.method_code, NEW.gateway, NEW.gateway_txn_ref, NEW.intent_id, NEW.collected_by_membership_id,
         NEW.order_id, NEW.invoice_id, NEW.credit_party_id, NEW.branch_id, NEW.centre_id)
        IS DISTINCT FROM
        (o.capture_kind, o.method_code, o.gateway, o.gateway_txn_ref, o.intent_id, o.collected_by_membership_id,
         o.order_id, o.invoice_id, o.credit_party_id, o.branch_id, o.centre_id) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'reversal_mismatch', DETAIL = 'billing.ledger_entries';
  END IF;
  IF o.cash_session_id IS NOT NULL AND EXISTS (SELECT 1 FROM billing.cash_sessions s
                                                WHERE s.tenant_id = NEW.tenant_id AND s.id = o.cash_session_id AND s.status = 'open') THEN
    v_session := o.cash_session_id;
  ELSE
    SELECT s.id INTO v_session FROM billing.cash_sessions s
     WHERE s.tenant_id = NEW.tenant_id AND s.membership_id = app.current_membership_id()
       AND s.centre_id = o.centre_id AND s.status = 'open';                  -- at most one row: cash_sessions__tenant_id_open__p_uq
  END IF;
  IF NEW.cash_session_id IS DISTINCT FROM v_session THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'reversal_mismatch', DETAIL = 'billing.ledger_entries';
  END IF;
  RETURN NEW;
END $$;
ALTER FUNCTION billing.ledger_reversal_guard() OWNER TO lims_owner;
CREATE TRIGGER ledger_entries__reversal_guard BEFORE INSERT ON billing.ledger_entries FOR EACH ROW EXECUTE FUNCTION billing.ledger_reversal_guard();

CREATE TABLE billing.order_balances (
  tenant_id uuid NOT NULL, order_id uuid NOT NULL, centre_id uuid NOT NULL,
  billing_mode text NOT NULL,
  invoiced_paisa bigint NOT NULL DEFAULT 0, paid_paisa bigint NOT NULL DEFAULT 0, credited_paisa bigint NOT NULL DEFAULT 0,
  balance_due_paisa bigint GENERATED ALWAYS AS (invoiced_paisa - credited_paisa - paid_paisa) STORED,
  balance_version integer NOT NULL DEFAULT 0,
  release_basis text NOT NULL DEFAULT 'no_invoice',
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL, version integer NOT NULL DEFAULT 1,
  CONSTRAINT order_balances__pk PRIMARY KEY (tenant_id, order_id),
  CONSTRAINT order_balances__centre__fk FOREIGN KEY (tenant_id, centre_id) REFERENCES core.collection_centres (tenant_id, id),
  CONSTRAINT order_balances__mode__ck CHECK (billing_mode IN ('cash','credit')),
  CONSTRAINT order_balances__basis__ck CHECK (release_basis IN ('paid_in_full','zero_balance','credit_party','override',
             'policy_not_enforced','due_outstanding','no_invoice')),
  CONSTRAINT order_balances__amounts__ck CHECK (invoiced_paisa >= 0 AND credited_paisa >= 0)
);
CREATE INDEX order_balances__tenant_id_centre_id_due__p_idx ON billing.order_balances (tenant_id, centre_id, balance_due_paisa) WHERE balance_due_paisa > 0;   -- B16 dues
-- guard: balance_version NEW >= OLD; NEW > OLD iff an amount changed.
CREATE FUNCTION billing.order_balances_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.balance_version < OLD.balance_version
     OR (NEW.balance_version > OLD.balance_version)
        <> ((NEW.invoiced_paisa, NEW.paid_paisa, NEW.credited_paisa) IS DISTINCT FROM (OLD.invoiced_paisa, OLD.paid_paisa, OLD.credited_paisa)) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'billing.order_balances';
  END IF;
  RETURN NEW;
END $$;
ALTER FUNCTION billing.order_balances_guard() OWNER TO lims_owner;
CREATE TRIGGER order_balances__guard BEFORE UPDATE ON billing.order_balances FOR EACH ROW EXECUTE FUNCTION billing.order_balances_guard();

CREATE TABLE billing.release_overrides (
  id uuid NOT NULL, tenant_id uuid NOT NULL, order_id uuid NOT NULL, centre_id uuid NOT NULL,
  reason_code text NOT NULL, reason_text text, expires_at timestamptz, membership_id uuid NOT NULL,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  CONSTRAINT release_overrides__pk PRIMARY KEY (id),
  CONSTRAINT release_overrides__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT release_overrides__centre__fk FOREIGN KEY (tenant_id, centre_id) REFERENCES core.collection_centres (tenant_id, id),
  CONSTRAINT release_overrides__member__fk FOREIGN KEY (tenant_id, membership_id) REFERENCES core.memberships (tenant_id, id)
);
CREATE INDEX release_overrides__tenant_id_order_id__idx ON billing.release_overrides (tenant_id, order_id, created_at DESC);

CREATE TABLE billing.credit_accounts (
  tenant_id uuid NOT NULL, credit_party_id uuid NOT NULL,
  party_code text NOT NULL, party_display_name text NOT NULL, party_pan text, party_address text,   -- P0 snapshots from CatalogPort
  credit_limit_paisa bigint, credit_days integer,
  is_locked boolean NOT NULL DEFAULT false, lock_reason_code text, locked_at timestamptz, locked_by uuid,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT credit_accounts__pk PRIMARY KEY (tenant_id, credit_party_id),
  CONSTRAINT credit_accounts__limit__ck CHECK (credit_limit_paisa IS NULL OR credit_limit_paisa >= 0),
  CONSTRAINT credit_accounts__days__ck CHECK (credit_days IS NULL OR credit_days BETWEEN 0 AND 365),
  CONSTRAINT credit_accounts__lock__ck CHECK (is_locked = (lock_reason_code IS NOT NULL))
);

CREATE TABLE billing.credit_charges (
  id uuid NOT NULL, tenant_id uuid NOT NULL, credit_party_id uuid NOT NULL,
  order_id uuid NOT NULL, order_item_id uuid, branch_id uuid NOT NULL, centre_id uuid NOT NULL, referrer_id uuid,
  patient_display_name text NOT NULL,                                     -- P2 (printed on monthly bill line)
  line_kind text NOT NULL, orderable_id uuid, code text NOT NULL, name text NOT NULL, department_id uuid,  -- P3
  unit_price_paisa bigint NOT NULL, gross_paisa bigint NOT NULL, discount_paisa bigint NOT NULL,
  vat_treatment text NOT NULL, other_tax_code text,
  charged_at timestamptz NOT NULL, period_month date NOT NULL,            -- first day of A.D. month in tenant tz (03-IC §6.2)
  status text NOT NULL DEFAULT 'uninvoiced', invoice_id uuid, invoice_line_id uuid, invoiced_at timestamptz,
  voided_at timestamptz, voided_by uuid, void_reason_code text,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT credit_charges__pk PRIMARY KEY (id),
  CONSTRAINT credit_charges__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT credit_charges__account__fk FOREIGN KEY (tenant_id, credit_party_id) REFERENCES billing.credit_accounts (tenant_id, credit_party_id),
  CONSTRAINT credit_charges__invoice__fk FOREIGN KEY (tenant_id, invoice_id) REFERENCES billing.invoices (tenant_id, id),
  CONSTRAINT credit_charges__branch__fk FOREIGN KEY (tenant_id, branch_id) REFERENCES core.branches (tenant_id, id),
  CONSTRAINT credit_charges__centre__fk FOREIGN KEY (tenant_id, centre_id) REFERENCES core.collection_centres (tenant_id, id),
  CONSTRAINT credit_charges__kind__ck CHECK (line_kind IN ('orderable','urgent_surcharge')),
  CONSTRAINT credit_charges__status__ck CHECK (status IN ('uninvoiced','invoiced','voided')),
  CONSTRAINT credit_charges__state__ck CHECK ((status = 'invoiced') = (invoice_id IS NOT NULL) AND (status = 'voided') = (voided_at IS NOT NULL)),
  CONSTRAINT credit_charges__amounts__ck CHECK (gross_paisa >= 0 AND discount_paisa BETWEEN 0 AND gross_paisa)
);
CREATE INDEX credit_charges__tenant_id_party_period_status__idx ON billing.credit_charges (tenant_id, credit_party_id, period_month, status);
CREATE INDEX credit_charges__tenant_id_order_id__idx ON billing.credit_charges (tenant_id, order_id);
CREATE TRIGGER credit_charges__mutable_columns BEFORE UPDATE ON billing.credit_charges FOR EACH ROW EXECUTE FUNCTION app.enforce_mutable_columns(
  'status','invoice_id','invoice_line_id','invoiced_at','voided_at','voided_by','void_reason_code','updated_at','updated_by','version');
-- guard: uninvoiced→invoiced|voided only.
CREATE FUNCTION billing.credit_charges_lifecycle_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT coalesce(OLD.status = 'uninvoiced' AND NEW.status IN ('invoiced','voided'), false) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'billing.credit_charges';
  END IF;
  RETURN NEW;
END $$;
ALTER FUNCTION billing.credit_charges_lifecycle_guard() OWNER TO lims_owner;
CREATE TRIGGER credit_charges__lifecycle_guard BEFORE UPDATE ON billing.credit_charges FOR EACH ROW EXECUTE FUNCTION billing.credit_charges_lifecycle_guard();

CREATE TABLE billing.credit_note_tasks (
  id uuid NOT NULL, tenant_id uuid NOT NULL, centre_id uuid NOT NULL, order_id uuid NOT NULL, invoice_id uuid NOT NULL,
  invoice_line_ids uuid[] NOT NULL, cause text NOT NULL, reason_code text NOT NULL,
  status text NOT NULL DEFAULT 'open', resolved_by_credit_note_id uuid, resolved_at timestamptz, resolved_by uuid,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT credit_note_tasks__pk PRIMARY KEY (id),
  CONSTRAINT credit_note_tasks__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT credit_note_tasks__invoice__fk FOREIGN KEY (tenant_id, invoice_id) REFERENCES billing.invoices (tenant_id, id),
  CONSTRAINT credit_note_tasks__cause__ck CHECK (cause IN ('order_cancelled','item_removed')),
  CONSTRAINT credit_note_tasks__status__ck CHECK (status IN ('open','resolved'))
);
CREATE INDEX credit_note_tasks__tenant_id_status__p_idx ON billing.credit_note_tasks (tenant_id, status, created_at) WHERE status = 'open';

CREATE TABLE billing.finance_review_items (
  id uuid NOT NULL, tenant_id uuid NOT NULL, centre_id uuid NOT NULL, order_id uuid NOT NULL,
  kind text NOT NULL, ledger_entry_id uuid NOT NULL, amount_paisa bigint NOT NULL,
  status text NOT NULL DEFAULT 'open', resolution_code text, note text, refund_ledger_entry_id uuid,
  resolved_at timestamptz, resolved_by uuid,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT finance_review_items__pk PRIMARY KEY (id),
  CONSTRAINT finance_review_items__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT finance_review_items__entry__fk FOREIGN KEY (tenant_id, ledger_entry_id) REFERENCES billing.ledger_entries (tenant_id, id),
  CONSTRAINT finance_review_items__kind__ck CHECK (kind IN ('home_payment_exceeds_due','gateway_payment_exceeds_due',   -- + gateway (CR-C15-002, BillingPort allowExceedsDue)
                                                         'home_payment_method_inactive')),                          -- + 08 A19 D-128 [CONV value]: home-collection payment on a tenant-inactive method
  CONSTRAINT finance_review_items__status__ck CHECK (status IN ('open','resolved')),
  CONSTRAINT finance_review_items__resolution__ck CHECK (resolution_code IS NULL OR resolution_code IN ('refunded','kept_as_advance','other'))
);
CREATE INDEX finance_review_items__tenant_id_status__p_idx ON billing.finance_review_items (tenant_id, status, created_at) WHERE status = 'open';   -- B36

-- Two-person manual refunds (08 A13 D-24; 02-CV §4.7 / 08 R15). Gateway refunds stay with C15 (recordGatewayRefund, no row here).
CREATE TABLE billing.refund_requests (
  id uuid NOT NULL, tenant_id uuid NOT NULL, branch_id uuid NOT NULL, centre_id uuid NOT NULL, order_id uuid NOT NULL,   -- P1
  method_code text NOT NULL, refund_amount_paisa bigint NOT NULL,
  reason_code text NOT NULL, reason_text text, reference_text text,
  status text NOT NULL DEFAULT 'pending',
  requested_by_membership_id uuid NOT NULL,
  decided_by_membership_id uuid, decided_at timestamptz, decision_note text,
  ledger_entry_id uuid,                                                    -- set on approval (the refund ledger row)
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT refund_requests__pk PRIMARY KEY (id),
  CONSTRAINT refund_requests__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT refund_requests__branch__fk FOREIGN KEY (tenant_id, branch_id) REFERENCES core.branches (tenant_id, id),
  CONSTRAINT refund_requests__centre__fk FOREIGN KEY (tenant_id, centre_id) REFERENCES core.collection_centres (tenant_id, id),
  CONSTRAINT refund_requests__requester__fk FOREIGN KEY (tenant_id, requested_by_membership_id) REFERENCES core.memberships (tenant_id, id),
  CONSTRAINT refund_requests__decider__fk FOREIGN KEY (tenant_id, decided_by_membership_id) REFERENCES core.memberships (tenant_id, id),
  CONSTRAINT refund_requests__ledger__fk FOREIGN KEY (tenant_id, ledger_entry_id) REFERENCES billing.ledger_entries (tenant_id, id),
  CONSTRAINT refund_requests__amount__ck CHECK (refund_amount_paisa BETWEEN 1 AND 9007199254740991),
  CONSTRAINT refund_requests__status__ck CHECK (status IN ('pending','approved','rejected')),
  CONSTRAINT refund_requests__decision__ck CHECK ((status = 'pending') = (decided_at IS NULL AND decided_by_membership_id IS NULL)),
  CONSTRAINT refund_requests__approved__ck CHECK ((status = 'approved') = (ledger_entry_id IS NOT NULL)),
  CONSTRAINT refund_requests__two_person__ck CHECK (status <> 'approved' OR decided_by_membership_id <> requested_by_membership_id),
  CONSTRAINT refund_requests__text__ck CHECK ((reason_text IS NULL OR char_length(reason_text) <= 500)
                                           AND (decision_note IS NULL OR char_length(decision_note) <= 500)
                                           AND (reference_text IS NULL OR (char_length(reference_text) <= 100 AND reference_text !~ '[0-9]{13,19}')))
);
CREATE INDEX refund_requests__tenant_id_order_id__idx ON billing.refund_requests (tenant_id, order_id, created_at DESC);
CREATE INDEX refund_requests__tenant_id_status__p_idx ON billing.refund_requests (tenant_id, status, created_at) WHERE status = 'pending';
CREATE TRIGGER refund_requests__mutable_columns BEFORE UPDATE ON billing.refund_requests FOR EACH ROW EXECUTE FUNCTION app.enforce_mutable_columns(
  'status','decided_by_membership_id','decided_at','decision_note','ledger_entry_id','updated_at','updated_by','version');
-- guard billing.refund_requests_guard(): pending→approved|rejected only; decision columns NULL→value once; terminal afterwards.
CREATE FUNCTION billing.refund_requests_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT coalesce(OLD.status = 'pending' AND NEW.status IN ('approved','rejected'), false) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'billing.refund_requests';
  END IF;
  IF (OLD.decided_by_membership_id IS NOT NULL AND NEW.decided_by_membership_id IS DISTINCT FROM OLD.decided_by_membership_id)
     OR (OLD.decided_at IS NOT NULL AND NEW.decided_at IS DISTINCT FROM OLD.decided_at)
     OR (OLD.decision_note IS NOT NULL AND NEW.decision_note IS DISTINCT FROM OLD.decision_note)
     OR (OLD.ledger_entry_id IS NOT NULL AND NEW.ledger_entry_id IS DISTINCT FROM OLD.ledger_entry_id)
     OR (OLD.status <> 'pending'
         AND (NEW.status, NEW.decided_by_membership_id, NEW.decided_at, NEW.decision_note, NEW.ledger_entry_id)
             IS DISTINCT FROM (OLD.status, OLD.decided_by_membership_id, OLD.decided_at, OLD.decision_note, OLD.ledger_entry_id)) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'billing.refund_requests';
  END IF;
  RETURN NEW;
END $$;
ALTER FUNCTION billing.refund_requests_guard() OWNER TO lims_owner;
CREATE TRIGGER refund_requests__guard BEFORE UPDATE ON billing.refund_requests FOR EACH ROW EXECUTE FUNCTION billing.refund_requests_guard();
ALTER TABLE billing.ledger_entries ADD CONSTRAINT ledger_entries__refund_request__fk
  FOREIGN KEY (tenant_id, refund_request_id) REFERENCES billing.refund_requests (tenant_id, id);   -- after both tables exist

CREATE TABLE billing.payment_intent_refs (
  tenant_id uuid NOT NULL, intent_id uuid NOT NULL, order_id uuid NOT NULL, gateway text NOT NULL, amount_paisa bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL, id uuid NOT NULL, is_active boolean NOT NULL DEFAULT true,
  CONSTRAINT payment_intent_refs__pk PRIMARY KEY (tenant_id, intent_id),
  CONSTRAINT payment_intent_refs__gateway__ck CHECK (gateway IN ('esewa','khalti','fonepay'))
);

CREATE TABLE billing.print_log (
  id uuid NOT NULL, tenant_id uuid NOT NULL, centre_id uuid,
  document_kind text NOT NULL, document_id uuid NOT NULL, document_no text NOT NULL, print_no integer NOT NULL, is_copy boolean NOT NULL,
  reason_code text, printed_at timestamptz NOT NULL,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  CONSTRAINT print_log__pk PRIMARY KEY (id),
  CONSTRAINT print_log__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT print_log__tenant_id_doc_print__uq UNIQUE (tenant_id, document_kind, document_id, print_no),
  CONSTRAINT print_log__centre__fk FOREIGN KEY (tenant_id, centre_id) REFERENCES core.collection_centres (tenant_id, id),
  CONSTRAINT print_log__kind__ck CHECK (document_kind IN ('invoice','credit_note','receipt')),
  CONSTRAINT print_log__copy__ck CHECK (is_copy = (print_no > 1))
);

CREATE TABLE billing.activity_log (
  id uuid NOT NULL, tenant_id uuid NOT NULL, centre_id uuid,
  action text NOT NULL, document_kind text, document_id uuid, document_no text,
  actor_id uuid NOT NULL, actor_membership_id uuid, actor_type text NOT NULL,
  occurred_at timestamptz NOT NULL, request_id uuid, details jsonb NOT NULL DEFAULT '{}'::jsonb,   -- non-PHI keys only
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  CONSTRAINT activity_log__pk PRIMARY KEY (id),
  CONSTRAINT activity_log__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT activity_log__centre__fk FOREIGN KEY (tenant_id, centre_id) REFERENCES core.collection_centres (tenant_id, id),
  CONSTRAINT activity_log__action__ck CHECK (action IN ('invoice_issued','invoice_printed','invoice_cancelled','credit_note_issued',
     'credit_note_printed','payment_recorded','payment_reversed','refund_requested','refund_rejected','refund_recorded','receipt_printed','override_created',
     'export_created','export_downloaded','cbms_submitted','credit_account_changed','periodic_invoice_issued',
     'settings_changed','cash_session_closed','finance_review_resolved'))   -- 'tax_code_created' removed (08 R18)
);
CREATE INDEX activity_log__tenant_id_actor_occurred__idx ON billing.activity_log (tenant_id, actor_membership_id, occurred_at DESC);
CREATE INDEX activity_log__tenant_id_occurred__idx ON billing.activity_log (tenant_id, occurred_at DESC);

CREATE TABLE billing.cbms_submissions (
  id uuid NOT NULL, tenant_id uuid NOT NULL, document_kind text NOT NULL, document_id uuid NOT NULL,
  attempt_no integer NOT NULL, client_mode text NOT NULL, outcome text NOT NULL,
  external_ref text, raw_status_redacted text, submitted_at timestamptz NOT NULL,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  CONSTRAINT cbms_submissions__pk PRIMARY KEY (id),
  CONSTRAINT cbms_submissions__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT cbms_submissions__tenant_id_doc_attempt__uq UNIQUE (tenant_id, document_kind, document_id, attempt_no),
  CONSTRAINT cbms_submissions__kind__ck CHECK (document_kind IN ('invoice','credit_note','invoice_cancellation')),
  CONSTRAINT cbms_submissions__mode__ck CHECK (client_mode IN ('stub','live')),
  CONSTRAINT cbms_submissions__outcome__ck CHECK (outcome IN ('accepted','rejected_permanent','retryable_error','stub_recorded'))
);

CREATE TABLE billing.export_jobs (
  id uuid NOT NULL, tenant_id uuid NOT NULL, kind text NOT NULL, format text NOT NULL, filters jsonb NOT NULL,
  status text NOT NULL DEFAULT 'queued', row_count integer, bucket text, object_path text, sha256 text, error_code text,
  requested_by_membership_id uuid NOT NULL, completed_at timestamptz, expires_at timestamptz,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT export_jobs__pk PRIMARY KEY (id),
  CONSTRAINT export_jobs__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT export_jobs__kind__ck CHECK (kind IN ('sales_register','cancelled_invoices','credit_notes','audit_trail','daily_cash','invoice_documents')),
  CONSTRAINT export_jobs__format__ck CHECK (format IN ('xlsx','xml','pdf')),
  CONSTRAINT export_jobs__status__ck CHECK (status IN ('queued','running','ready','failed','expired')),
  CONSTRAINT export_jobs__path__ck CHECK (object_path IS NULL OR split_part(object_path, '/', 1) = tenant_id::text)
);
CREATE INDEX export_jobs__tenant_id_expires__p_idx ON billing.export_jobs (tenant_id, expires_at) WHERE status = 'ready';

CREATE TABLE billing.g_cs_payment_methods (
  code text NOT NULL, display text NOT NULL, is_cash boolean NOT NULL, requires_reference boolean NOT NULL,
  sort_order integer NOT NULL, is_active boolean NOT NULL DEFAULT true, id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT g_cs_payment_methods__pk PRIMARY KEY (code)
);
CREATE TABLE billing.cs_payment_methods (
  tenant_id uuid NOT NULL, code text NOT NULL, display text NOT NULL, is_cash boolean NOT NULL, requires_reference boolean NOT NULL,
  sort_order integer NOT NULL, id uuid NOT NULL, version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT cs_payment_methods__pk PRIMARY KEY (tenant_id, code),
  CONSTRAINT cs_payment_methods__code__ck CHECK (code ~ '^[a-z0-9_]{1,64}$')
);
CREATE TABLE billing.g_cs_reasons ( /* same shape as frontdesk.g_cs_reasons */
  set_name text NOT NULL, code text NOT NULL, display text NOT NULL, sort_order integer NOT NULL,
  requires_text boolean NOT NULL DEFAULT false, is_active boolean NOT NULL DEFAULT true, id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT g_cs_reasons__pk PRIMARY KEY (set_name, code),
  CONSTRAINT g_cs_reasons__set__ck CHECK (set_name IN ('invoice_cancel_reasons','reversal_reasons','refund_reasons','override_reasons',
             'cash_variance_reasons','lock_reasons','charge_void_reasons','print_reasons'))
);
CREATE TABLE billing.cs_reasons ( /* same shape as frontdesk.cs_reasons */
  tenant_id uuid NOT NULL, set_name text NOT NULL, code text NOT NULL, display text NOT NULL, sort_order integer NOT NULL,
  requires_text boolean NOT NULL DEFAULT false, id uuid NOT NULL, version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT cs_reasons__pk PRIMARY KEY (tenant_id, set_name, code)
);
-- billing.event_inbox: exactly per 03-IC §12.

-- =====================================================================
-- §4a RLS, policies and grants (billing)
-- =====================================================================
ALTER TABLE billing.settings ENABLE ROW LEVEL SECURITY;  ALTER TABLE billing.settings FORCE ROW LEVEL SECURITY;
CREATE POLICY settings__select__tenant ON billing.settings FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY settings__insert__tenant ON billing.settings FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY settings__update__tenant ON billing.settings FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
GRANT SELECT, INSERT, UPDATE ON billing.settings TO lims_app;
ALTER TABLE billing.credit_accounts ENABLE ROW LEVEL SECURITY;  ALTER TABLE billing.credit_accounts FORCE ROW LEVEL SECURITY;
CREATE POLICY credit_accounts__select__tenant ON billing.credit_accounts FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY credit_accounts__insert__tenant ON billing.credit_accounts FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY credit_accounts__update__tenant ON billing.credit_accounts FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
GRANT SELECT, INSERT, UPDATE ON billing.credit_accounts TO lims_app;
ALTER TABLE billing.cs_payment_methods ENABLE ROW LEVEL SECURITY;  ALTER TABLE billing.cs_payment_methods FORCE ROW LEVEL SECURITY;
CREATE POLICY cs_payment_methods__select__tenant ON billing.cs_payment_methods FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY cs_payment_methods__insert__tenant ON billing.cs_payment_methods FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY cs_payment_methods__update__tenant ON billing.cs_payment_methods FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
GRANT SELECT, INSERT, UPDATE ON billing.cs_payment_methods TO lims_app;
ALTER TABLE billing.cs_reasons ENABLE ROW LEVEL SECURITY;  ALTER TABLE billing.cs_reasons FORCE ROW LEVEL SECURITY;
CREATE POLICY cs_reasons__select__tenant ON billing.cs_reasons FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY cs_reasons__insert__tenant ON billing.cs_reasons FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY cs_reasons__update__tenant ON billing.cs_reasons FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
GRANT SELECT, INSERT, UPDATE ON billing.cs_reasons TO lims_app;
ALTER TABLE billing.fiscal_counters ENABLE ROW LEVEL SECURITY;  ALTER TABLE billing.fiscal_counters FORCE ROW LEVEL SECURITY;
CREATE POLICY fiscal_counters__select__tenant ON billing.fiscal_counters FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY fiscal_counters__insert__tenant ON billing.fiscal_counters FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY fiscal_counters__update__tenant ON billing.fiscal_counters FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
GRANT SELECT, INSERT, UPDATE ON billing.fiscal_counters TO lims_app;
ALTER TABLE billing.payment_intent_refs ENABLE ROW LEVEL SECURITY;  ALTER TABLE billing.payment_intent_refs FORCE ROW LEVEL SECURITY;
CREATE POLICY payment_intent_refs__select__tenant ON billing.payment_intent_refs FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY payment_intent_refs__insert__tenant ON billing.payment_intent_refs FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
GRANT SELECT, INSERT ON billing.payment_intent_refs TO lims_app;
ALTER TABLE billing.activity_log ENABLE ROW LEVEL SECURITY;  ALTER TABLE billing.activity_log FORCE ROW LEVEL SECURITY;
CREATE POLICY activity_log__select__tenant ON billing.activity_log FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY activity_log__insert__tenant ON billing.activity_log FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
GRANT SELECT, INSERT ON billing.activity_log TO lims_app;
ALTER TABLE billing.cbms_submissions ENABLE ROW LEVEL SECURITY;  ALTER TABLE billing.cbms_submissions FORCE ROW LEVEL SECURITY;
CREATE POLICY cbms_submissions__select__tenant ON billing.cbms_submissions FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY cbms_submissions__insert__tenant ON billing.cbms_submissions FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
GRANT SELECT, INSERT ON billing.cbms_submissions TO lims_app;
ALTER TABLE billing.export_jobs ENABLE ROW LEVEL SECURITY;  ALTER TABLE billing.export_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY export_jobs__select__tenant ON billing.export_jobs FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY export_jobs__insert__tenant ON billing.export_jobs FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY export_jobs__update__tenant ON billing.export_jobs FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY export_jobs__delete__tenant ON billing.export_jobs FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
GRANT SELECT, INSERT, UPDATE, DELETE ON billing.export_jobs TO lims_app;
ALTER TABLE billing.cash_sessions ENABLE ROW LEVEL SECURITY;  ALTER TABLE billing.cash_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY cash_sessions__select__tenant_centre ON billing.cash_sessions FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY cash_sessions__insert__tenant_centre ON billing.cash_sessions FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY cash_sessions__update__tenant_centre ON billing.cash_sessions FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
GRANT SELECT, INSERT, UPDATE ON billing.cash_sessions TO lims_app;
ALTER TABLE billing.order_balances ENABLE ROW LEVEL SECURITY;  ALTER TABLE billing.order_balances FORCE ROW LEVEL SECURITY;
CREATE POLICY order_balances__select__tenant_centre ON billing.order_balances FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY order_balances__insert__tenant_centre ON billing.order_balances FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY order_balances__update__tenant_centre ON billing.order_balances FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
GRANT SELECT, INSERT, UPDATE ON billing.order_balances TO lims_app;
ALTER TABLE billing.credit_charges ENABLE ROW LEVEL SECURITY;  ALTER TABLE billing.credit_charges FORCE ROW LEVEL SECURITY;
CREATE POLICY credit_charges__select__tenant_centre ON billing.credit_charges FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY credit_charges__insert__tenant_centre ON billing.credit_charges FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY credit_charges__update__tenant_centre ON billing.credit_charges FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
GRANT SELECT, INSERT, UPDATE ON billing.credit_charges TO lims_app;
ALTER TABLE billing.credit_note_tasks ENABLE ROW LEVEL SECURITY;  ALTER TABLE billing.credit_note_tasks FORCE ROW LEVEL SECURITY;
CREATE POLICY credit_note_tasks__select__tenant_centre ON billing.credit_note_tasks FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY credit_note_tasks__insert__tenant_centre ON billing.credit_note_tasks FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY credit_note_tasks__update__tenant_centre ON billing.credit_note_tasks FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
GRANT SELECT, INSERT, UPDATE ON billing.credit_note_tasks TO lims_app;
ALTER TABLE billing.finance_review_items ENABLE ROW LEVEL SECURITY;  ALTER TABLE billing.finance_review_items FORCE ROW LEVEL SECURITY;
CREATE POLICY finance_review_items__select__tenant_centre ON billing.finance_review_items FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY finance_review_items__insert__tenant_centre ON billing.finance_review_items FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY finance_review_items__update__tenant_centre ON billing.finance_review_items FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
GRANT SELECT, INSERT, UPDATE ON billing.finance_review_items TO lims_app;
ALTER TABLE billing.refund_requests ENABLE ROW LEVEL SECURITY;  ALTER TABLE billing.refund_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY refund_requests__select__tenant_centre ON billing.refund_requests FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY refund_requests__insert__tenant_centre ON billing.refund_requests FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY refund_requests__update__tenant_centre ON billing.refund_requests FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
GRANT SELECT, INSERT, UPDATE ON billing.refund_requests TO lims_app;
ALTER TABLE billing.release_overrides ENABLE ROW LEVEL SECURITY;  ALTER TABLE billing.release_overrides FORCE ROW LEVEL SECURITY;
CREATE POLICY release_overrides__select__tenant_centre ON billing.release_overrides FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY release_overrides__insert__tenant_centre ON billing.release_overrides FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
GRANT SELECT, INSERT ON billing.release_overrides TO lims_app;
-- TCN (tenant_centre, nullable centre: NULL-centre rows only for app.has_all_centres())
ALTER TABLE billing.invoices ENABLE ROW LEVEL SECURITY;  ALTER TABLE billing.invoices FORCE ROW LEVEL SECURITY;
CREATE POLICY invoices__select__tenant_centre ON billing.invoices FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR (centre_id IS NOT NULL AND centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]))));
CREATE POLICY invoices__insert__tenant_centre ON billing.invoices FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR (centre_id IS NOT NULL AND centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]))));
CREATE POLICY invoices__update__tenant_centre ON billing.invoices FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR (centre_id IS NOT NULL AND centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]))))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR (centre_id IS NOT NULL AND centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]))));
GRANT SELECT, INSERT, UPDATE ON billing.invoices TO lims_app;
ALTER TABLE billing.credit_notes ENABLE ROW LEVEL SECURITY;  ALTER TABLE billing.credit_notes FORCE ROW LEVEL SECURITY;
CREATE POLICY credit_notes__select__tenant_centre ON billing.credit_notes FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR (centre_id IS NOT NULL AND centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]))));
CREATE POLICY credit_notes__insert__tenant_centre ON billing.credit_notes FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR (centre_id IS NOT NULL AND centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]))));
CREATE POLICY credit_notes__update__tenant_centre ON billing.credit_notes FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR (centre_id IS NOT NULL AND centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]))))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR (centre_id IS NOT NULL AND centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]))));
GRANT SELECT, INSERT, UPDATE ON billing.credit_notes TO lims_app;
ALTER TABLE billing.invoice_lines ENABLE ROW LEVEL SECURITY;  ALTER TABLE billing.invoice_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY invoice_lines__select__tenant_centre ON billing.invoice_lines FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR (centre_id IS NOT NULL AND centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]))));
CREATE POLICY invoice_lines__insert__tenant_centre ON billing.invoice_lines FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR (centre_id IS NOT NULL AND centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]))));
GRANT SELECT, INSERT ON billing.invoice_lines TO lims_app;
ALTER TABLE billing.credit_note_lines ENABLE ROW LEVEL SECURITY;  ALTER TABLE billing.credit_note_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY credit_note_lines__select__tenant_centre ON billing.credit_note_lines FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR (centre_id IS NOT NULL AND centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]))));
CREATE POLICY credit_note_lines__insert__tenant_centre ON billing.credit_note_lines FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR (centre_id IS NOT NULL AND centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]))));
GRANT SELECT, INSERT ON billing.credit_note_lines TO lims_app;
ALTER TABLE billing.ledger_entries ENABLE ROW LEVEL SECURITY;  ALTER TABLE billing.ledger_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY ledger_entries__select__tenant_centre ON billing.ledger_entries FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR (centre_id IS NOT NULL AND centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]))));
CREATE POLICY ledger_entries__insert__tenant_centre ON billing.ledger_entries FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR (centre_id IS NOT NULL AND centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]))));
GRANT SELECT, INSERT ON billing.ledger_entries TO lims_app;
ALTER TABLE billing.print_log ENABLE ROW LEVEL SECURITY;  ALTER TABLE billing.print_log FORCE ROW LEVEL SECURITY;
CREATE POLICY print_log__select__tenant_centre ON billing.print_log FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR (centre_id IS NOT NULL AND centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]))));
CREATE POLICY print_log__insert__tenant_centre ON billing.print_log FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR (centre_id IS NOT NULL AND centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]))));
GRANT SELECT, INSERT ON billing.print_log TO lims_app;
-- G tables: no tenant data, no RLS (02-CV §5.2)
GRANT SELECT ON billing.g_cs_payment_methods, billing.g_cs_reasons TO lims_app;

-- =====================================================================
-- Row audit (C0 app.tg_row_audit; AC-0B-5.x)
-- =====================================================================
CREATE TRIGGER settings__audit AFTER INSERT OR UPDATE OR DELETE ON billing.settings FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER fiscal_counters__audit AFTER INSERT OR UPDATE OR DELETE ON billing.fiscal_counters FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER invoices__audit AFTER INSERT OR UPDATE OR DELETE ON billing.invoices FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER invoice_lines__audit AFTER INSERT OR UPDATE OR DELETE ON billing.invoice_lines FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER credit_notes__audit AFTER INSERT OR UPDATE OR DELETE ON billing.credit_notes FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER credit_note_lines__audit AFTER INSERT OR UPDATE OR DELETE ON billing.credit_note_lines FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER cash_sessions__audit AFTER INSERT OR UPDATE OR DELETE ON billing.cash_sessions FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER order_balances__audit AFTER INSERT OR UPDATE OR DELETE ON billing.order_balances FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER credit_accounts__audit AFTER INSERT OR UPDATE OR DELETE ON billing.credit_accounts FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER credit_charges__audit AFTER INSERT OR UPDATE OR DELETE ON billing.credit_charges FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER credit_note_tasks__audit AFTER INSERT OR UPDATE OR DELETE ON billing.credit_note_tasks FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER finance_review_items__audit AFTER INSERT OR UPDATE OR DELETE ON billing.finance_review_items FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER refund_requests__audit AFTER INSERT OR UPDATE OR DELETE ON billing.refund_requests FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER export_jobs__audit AFTER INSERT OR UPDATE OR DELETE ON billing.export_jobs FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER cs_payment_methods__audit AFTER INSERT OR UPDATE OR DELETE ON billing.cs_payment_methods FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER cs_reasons__audit AFTER INSERT OR UPDATE OR DELETE ON billing.cs_reasons FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();

-- =====================================================================
-- §6 published views (billing)
-- =====================================================================
-- status here is the STORED status (pre_registered|registered|cancelled). Derived in_progress/completed are computed on
-- read from LabPort.getOrderItemProcessingState (03-IC §10.4 as amended by 08 A13 D-5) and returned by
-- FrontdeskPort.getOrderSummary / F11; this view never carries them. Documented for C13/C16/C17.

-- billing  (business_date in Asia/Kathmandu = tenant default timezone, 03-IC §6)
CREATE VIEW billing.v_pub_invoice_daily WITH (security_invoker = true) AS
WITH issued AS (
  SELECT tenant_id, branch_id, centre_id, (issued_at AT TIME ZONE 'Asia/Kathmandu')::date AS business_date,
         count(*) AS invoices_issued, 0::bigint AS invoices_cancelled,
         sum(gross_paisa) AS gross_paisa, sum(discount_paisa) AS discount_paisa, sum(exempt_paisa) AS exempt_paisa,
         sum(taxable_paisa) AS taxable_paisa, sum(vat_paisa) AS vat_paisa, sum(other_tax_paisa) AS other_tax_paisa,
         sum(net_paisa) AS net_paisa, 0::bigint AS credit_notes_paisa
  FROM billing.invoices GROUP BY 1,2,3,4),
cancelled AS (
  SELECT tenant_id, branch_id, centre_id, (cancelled_at AT TIME ZONE 'Asia/Kathmandu')::date,
         0, count(*), 0,0,0,0,0,0,0,0 FROM billing.invoices WHERE status = 'cancelled' GROUP BY 1,2,3,4),
credits AS (
  SELECT tenant_id, branch_id, centre_id, (issued_at AT TIME ZONE 'Asia/Kathmandu')::date,
         0, 0, 0,0,0,0,0,0,0, sum(net_paisa) FROM billing.credit_notes GROUP BY 1,2,3,4)
SELECT tenant_id, branch_id, centre_id, business_date,
       sum(invoices_issued)::bigint AS invoices_issued, sum(invoices_cancelled)::bigint AS invoices_cancelled,
       sum(gross_paisa)::bigint AS gross_paisa, sum(discount_paisa)::bigint AS discount_paisa, sum(exempt_paisa)::bigint AS exempt_paisa,
       sum(taxable_paisa)::bigint AS taxable_paisa, sum(vat_paisa)::bigint AS vat_paisa, sum(other_tax_paisa)::bigint AS other_tax_paisa,
       sum(net_paisa)::bigint AS net_paisa, sum(credit_notes_paisa)::bigint AS credit_notes_paisa
FROM (SELECT * FROM issued UNION ALL SELECT * FROM cancelled UNION ALL SELECT * FROM credits) u
GROUP BY 1,2,3,4;
CREATE VIEW billing.v_pub_department_income WITH (security_invoker = true) AS
SELECT tenant_id, branch_id, centre_id, business_date, department_id,
       sum(line_count)::bigint AS line_count, sum(gross_paisa)::bigint AS gross_paisa,
       sum(discount_paisa)::bigint AS discount_paisa, sum(net_paisa)::bigint AS net_paisa
FROM (
  SELECT l.tenant_id, i.branch_id, i.centre_id, (i.issued_at AT TIME ZONE 'Asia/Kathmandu')::date AS business_date, l.department_id,
         1 AS line_count, l.gross_paisa, l.discount_paisa, l.net_paisa
  FROM billing.invoice_lines l JOIN billing.invoices i ON i.tenant_id = l.tenant_id AND i.id = l.invoice_id
  UNION ALL   -- credits reduce income on the credit-note date (negative values; line_count 0)
  SELECT cl.tenant_id, c.branch_id, c.centre_id, (c.issued_at AT TIME ZONE 'Asia/Kathmandu')::date, l.department_id,
         0, -cl.gross_paisa, -cl.discount_paisa, -cl.net_paisa
  FROM billing.credit_note_lines cl
  JOIN billing.credit_notes c ON c.tenant_id = cl.tenant_id AND c.id = cl.credit_note_id
  JOIN billing.invoice_lines l ON l.tenant_id = cl.tenant_id AND l.id = cl.invoice_line_id
) x GROUP BY 1,2,3,4,5;
-- department_id NULL = line spanning several departments (package) — C8 labels it "Multiple departments".

CREATE VIEW billing.v_pub_payment_collection WITH (security_invoker = true) AS
SELECT tenant_id, branch_id, centre_id, business_date, collected_by_membership_id, method_code AS payment_method_code,   -- 08 R4 (03-IC §6.2)
       count(*) FILTER (WHERE entry_kind = 'payment')                      AS entries,
       count(*) FILTER (WHERE entry_kind IN ('reversal','refund'))         AS reversals,
       coalesce(sum(amount_paisa) FILTER (WHERE entry_kind = 'payment'),0)::bigint AS gross_collected_paisa,
       coalesce(-sum(amount_paisa) FILTER (WHERE entry_kind IN ('reversal','refund')),0)::bigint AS reversed_paisa,
       coalesce(sum(amount_paisa),0)::bigint                               AS net_collected_paisa
FROM billing.ledger_entries GROUP BY 1,2,3,4,5,6;
CREATE VIEW billing.v_pub_referrer_billing WITH (security_invoker = true) AS
SELECT tenant_id, business_date, referrer_id, centre_id,
       count(DISTINCT order_id) FILTER (WHERE counts_order) AS orders, sum(net_paisa)::bigint AS net_billed_paisa
FROM (
  SELECT tenant_id, (issued_at AT TIME ZONE 'Asia/Kathmandu')::date AS business_date, referrer_id, centre_id, order_id,
         true AS counts_order, net_paisa
  FROM billing.invoices WHERE order_id IS NOT NULL AND referrer_id IS NOT NULL
  UNION ALL
  SELECT tenant_id, (charged_at AT TIME ZONE 'Asia/Kathmandu')::date, referrer_id, centre_id, order_id, true,
         gross_paisa - discount_paisa      -- pre-tax; credit-party tax is applied on the periodic invoice
  FROM billing.credit_charges WHERE referrer_id IS NOT NULL AND status <> 'voided'
  UNION ALL
  SELECT c.tenant_id, (c.issued_at AT TIME ZONE 'Asia/Kathmandu')::date, i.referrer_id, c.centre_id, c.order_id, false, -c.net_paisa
  FROM billing.credit_notes c JOIN billing.invoices i ON i.tenant_id = c.tenant_id AND i.id = c.invoice_id
  WHERE i.order_id IS NOT NULL AND i.referrer_id IS NOT NULL
) x GROUP BY 1,2,3,4;
-- Referral-incentive *report input* only (04 L19, B13). No column or comment may say "commission".

CREATE VIEW billing.v_pub_credit_party_statement WITH (security_invoker = true) AS
WITH m AS (
  SELECT tenant_id, credit_party_id, period_month, fiscal_year_bs, net_paisa AS invoiced, 0::bigint AS paid, 0::bigint AS credited
  FROM billing.invoices WHERE is_periodic_credit_bill
  UNION ALL
  SELECT tenant_id, credit_party_id, date_trunc('month', created_at AT TIME ZONE 'Asia/Kathmandu')::date, fiscal_year_bs, 0, amount_paisa, 0
  FROM billing.ledger_entries WHERE credit_party_id IS NOT NULL
  UNION ALL
  SELECT c.tenant_id, c.credit_party_id, date_trunc('month', c.issued_at AT TIME ZONE 'Asia/Kathmandu')::date, c.fiscal_year_bs, 0, 0, c.net_paisa
  FROM billing.credit_notes c WHERE c.credit_party_id IS NOT NULL)
SELECT tenant_id, credit_party_id, period_month, fiscal_year_bs,
       sum(invoiced)::bigint AS invoiced_paisa, sum(paid)::bigint AS paid_paisa, sum(credited)::bigint AS credited_paisa,
       (sum(sum(invoiced) - sum(paid) - sum(credited)) OVER (PARTITION BY tenant_id, credit_party_id
            ORDER BY period_month, fiscal_year_bs ROWS UNBOUNDED PRECEDING))::bigint AS closing_balance_paisa
FROM m GROUP BY tenant_id, credit_party_id, period_month, fiscal_year_bs;
-- An A.D. month that straddles Shrawan 1 yields two rows (one per fiscal_year_bs) — intended.

CREATE VIEW billing.v_pub_order_balance WITH (security_invoker = true) AS
SELECT tenant_id, order_id, invoiced_paisa, paid_paisa, credited_paisa, balance_due_paisa, balance_version, release_basis
FROM billing.order_balances;
GRANT SELECT ON billing.v_pub_invoice_daily, billing.v_pub_department_income,
  billing.v_pub_payment_collection, billing.v_pub_referrer_billing, billing.v_pub_credit_party_statement,
  billing.v_pub_order_balance TO lims_app;
