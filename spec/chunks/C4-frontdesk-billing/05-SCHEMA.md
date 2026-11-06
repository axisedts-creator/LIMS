# C4 Front Desk & Billing — 05 SCHEMA (specification C0-0B implements)

Status: DECISION draft, 2026-11-05. Rules: 02-CV §5 (classes, mandatory columns, composite FKs, no ENUM, immutability trigger, RLS template, roles, views). Shapes that consumers rely on (views) are fixed by 03-IC §6.1/§6.2 and reproduced exactly.
PHI classes per column use 03-IC §1: **P0** none · **P1** pseudonymous ids · **P2** lab-linked identifiers / personal data · **P3** health data linked to a person. Billing amounts are "Financial (restricted)" (02-CV §9.2) — allowed in billing audit trails only.

## 0. Global rules for both schemas

1. Every tenant table: `tenant_id uuid NOT NULL` (no default), FORCE RLS, owner `lims_owner`, policies `TO lims_app` (X9). `tenant_id` is the leading column of every index and unique constraint **except the single-column `PRIMARY KEY (id)`** (UUIDv7, globally unique, 04 D9); every table with such a PK also has `UNIQUE (tenant_id, id)` (02-CV §5.3 as amended by 08 A13 P-7; REQ-SEC-023; 04 D16). Other exceptions only via `db/meta/index-exceptions.yaml`.
2. IDs are UUIDv7 from app code; **no `DEFAULT` on id columns, no `SEQUENCE` objects in `frontdesk` or `billing`** (CI: `SELECT count(*) FROM pg_class WHERE relkind='S' AND relnamespace IN ('frontdesk'::regnamespace,'billing'::regnamespace)` = 0).
3. No Postgres ENUM types; `text + CHECK` or coded-set tables (02-CV §5.5).
4. `lims_app` grants: per table in §5 (never DELETE on classes C/B/A; never UPDATE on A).
5. Cross-schema FKs: `frontdesk → core`, `billing → core` only. **No FK from `billing` to `frontdesk`** (TRD §4 rule 3, relocatability — 04 D16) and none into `billing` (02-CV §5.4).
6. Audit: C0's generic audit trigger (04 D11) on every table except class A tables and `event_inbox`.
7. Money: `bigint` paisa, suffix `_paisa`. Percent: `integer` basis points `_bp` (0–10000).
8. B.S. values are stored only as labelled display snapshots required on fiscal documents (`fiscal_year_bs`, `*_date_bs`) — 02-CV §4.8.
9. Extensions needed: `pg_trgm` (REQ-ARCH-023) and `btree_gin` (to keep `tenant_id` leading in the trigram index). Presence in `supabase/postgres:17.6.1.136` is **UNVERIFIED** → C0 checks; if `btree_gin` is missing, the trigram index is created on `name_search` alone and listed in `db/tests/index_exemptions.txt` with this reason.

## 1. Table inventory

| Table | Class (02-CV §5.2) | RLS scope | Purpose |
|---|---|---|---|
| `frontdesk.settings` | M | tenant | per-tenant front-desk settings |
| `frontdesk.number_counters` | M (counter) | tenant | patient code + registration no counters (gaps allowed) |
| `frontdesk.patients` | M + PHI (versioned in place, audited; never deleted; anonymisable) | tenant | persons tested |
| `frontdesk.patient_consents` | A | tenant | consent history (REQ-SEC-005) |
| `frontdesk.orders` | C | tenant_centre | visits |
| `frontdesk.order_items` | C | tenant_centre | orderables sold, price snapshot |
| `frontdesk.discounts` | C | tenant_centre | applied discounts (00 A8) |
| `frontdesk.discount_approvals` | C | tenant_centre | remote approval requests |
| `frontdesk.trf_attachments` | C (E while `order_id IS NULL`) | tenant_centre | TRF files metadata |
| `frontdesk.order_flags` | C | tenant_centre | front-desk work items |
| `frontdesk.booking_links` | M (read model) | tenant | booking/visit/manifest → order |
| `frontdesk.g_cs_reasons` / `frontdesk.cs_reasons` | G / M | none / tenant | reason coded sets |
| `frontdesk.event_inbox` | A | tenant | C0 platform (03-IC §12) |
| `billing.settings` | M | tenant | per-tenant billing settings |
| `billing.fiscal_counters` | B | tenant | gapless counters (04 L7) |
| `billing.invoices` | B | tenant_centre (*) | tax invoices |
| `billing.invoice_lines` | B (no UPDATE) | tenant_centre (*) | fiscal lines |
| `billing.credit_notes` | B | tenant_centre (*) | credit notes |
| `billing.credit_note_lines` | B (no UPDATE) | tenant_centre (*) | credit lines |
| `billing.ledger_entries` | A + B | tenant_centre (*) | payment-method ledger (04 P1) |
| `billing.cash_sessions` | B | tenant_centre | cashier shifts |
| `billing.order_balances` | projection (UPDATE allowed, no DELETE) | tenant_centre | balance + version |
| `billing.release_overrides` | A | tenant_centre | hold-till-paid overrides |
| `billing.credit_accounts` | M | tenant | credit terms per credit party |
| `billing.credit_charges` | B | tenant_centre | uninvoiced credit-order lines |
| `billing.credit_note_tasks` | C | tenant_centre | finance work: credit needed |
| `billing.finance_review_items` | C | tenant_centre | finance work: overpayments; home-collection payments on an inactive method (08 A19 D-128) |
| `billing.refund_requests` | C | tenant_centre | two-person manual refunds (08 A13 D-24; 02-CV §4.7 / 08 R15) |
| `billing.payment_intent_refs` | A | tenant | intents created via C4 (amount check) |
| `billing.print_log` | A | tenant_centre (*) | every print (04 L26 च) |
| `billing.activity_log` | A | tenant | IRD audit-trail report source (04 L26 ञ) |
| `billing.cbms_submissions` | A | tenant | CBMS attempts |
| `billing.export_jobs` | E | tenant | export files |
| `billing.g_cs_payment_methods` / `billing.cs_payment_methods` | G / M | none / tenant | payment methods |
| `billing.g_cs_reasons` / `billing.cs_reasons` | G / M | none / tenant | billing reason sets |
| `billing.event_inbox` | A | tenant | C0 platform |

(*) `centre_id` is NULL only for periodic credit-party documents and credit-party payments; NULL rows are visible only to actors with `app.has_all_centres()` (finance). Policy variant **TCN** below.

## 2. RLS policy templates (exact SQL; `<t>` = table, `<s>` = schema)

**T (tenant)** — pattern only (placeholders `<s>`, `<t>`); the concrete statements for every table are in §4a.
```text
ALTER TABLE <s>.<t> ENABLE ROW LEVEL SECURITY;  ALTER TABLE <s>.<t> FORCE ROW LEVEL SECURITY;
CREATE POLICY <t>__select__tenant ON <s>.<t> FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY <t>__insert__tenant ON <s>.<t> FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY <t>__update__tenant ON <s>.<t> FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
```
Every `__tenant` policy of both schemas (templates T, TC, TCN and the `export_jobs` DELETE policy) includes `(SELECT app.is_staff_or_system())` (CR-C13-011; 08 R10 item 5): no frontdesk/billing table is shared with partner, portal or patient actors — their needs are served by system-actor workers (08 R8).
**TC (tenant_centre)** — exactly the 02-CV §5.8 template (select/insert/update with `(SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])` — the `::uuid[]` cast is required on PostgreSQL 16+, 08 A16.1).
**TCN (tenant_centre, nullable centre)** — TC with the centre predicate written as
`((SELECT app.has_all_centres()) OR (centre_id IS NOT NULL AND centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])))` (08 A16.1 cast).
No DELETE policy for `lims_app` on any table except class E `billing.export_jobs` (`__delete__tenant` for the purge job). `frontdesk.trf_attachments` draft rows are deleted only by the SECURITY DEFINER function `frontdesk.purge_trf_drafts(p_older_than interval, p_ids uuid[])` (owner `lims_owner`, EXECUTE `lims_worker` only, `SET search_path = ''`; 02-CV §5.11), which needs the two narrow `__<cmd>__owner_only` policies `TO lims_owner` of 08 A10.5, gated by `app.maintenance = 'frontdesk_purge_trf_drafts'` (A12.2 naming) — SQL in §3 after the table. C0 adds the function to `db/meta/definer-inventory.yaml` and 03-IC §13.3 (hand-off). Commands without a policy below are default-deny (REQ-SEC-016).

Policy matrix (S = select, I = insert, U = update):
| Table | Template | Commands | Grants to lims_app |
|---|---|---|---|
| frontdesk.settings, number_counters, booking_links, cs_reasons | T | S I U | SELECT, INSERT, UPDATE |
| frontdesk.patients | T | S I U | SELECT, INSERT, UPDATE |
| frontdesk.patient_consents, event_inbox | T | S I | SELECT, INSERT |
| frontdesk.orders, order_items, discounts, discount_approvals, trf_attachments, order_flags | TC | S I U (+ `trf_attachments__select__owner_only` / `__delete__owner_only` TO lims_owner for the purge DEFINER) | SELECT, INSERT, UPDATE |
| frontdesk.g_cs_reasons | none (G) | — | SELECT |
| billing.settings, credit_accounts, cs_payment_methods, cs_reasons | T | S I U | SELECT, INSERT, UPDATE |
| billing.fiscal_counters | T | S I U | SELECT, INSERT, UPDATE |
| billing.invoices, credit_notes | TCN | S I U | SELECT, INSERT, UPDATE |
| billing.invoice_lines, credit_note_lines, ledger_entries, print_log | TCN | S I | SELECT, INSERT |
| billing.cash_sessions, order_balances, credit_charges, credit_note_tasks, finance_review_items, refund_requests | TC | S I U | SELECT, INSERT, UPDATE |
| billing.release_overrides | TC | S I | SELECT, INSERT |
| billing.payment_intent_refs, activity_log, cbms_submissions, event_inbox | T | S I | SELECT, INSERT |
| billing.export_jobs | T | S I U D | SELECT, INSERT, UPDATE, DELETE |
| billing.g_cs_payment_methods, g_cs_reasons | none (G) | — | SELECT |

Centre-scoping note for `frontdesk.patients` (tenant scope, PRD D-PATIENT-SCOPE): rows are visible tenant-wide for dedupe; exposure is limited by the API (search requires a query, max 20 results, access-logged, mapper field allowlists). Raised as an explicit design choice for the security reviewer (07-SECURITY §3).

## 3. DDL — schema `frontdesk`

DDL below is in load order (referenced tables first, e.g. `discount_approvals` before `discounts`; final sweep 2026-11-06). Every guard function is written out next to its trigger as a `SECURITY INVOKER`, `SET search_path = ''` plpgsql function owned by `lims_owner`; C0 transcribes them unchanged. Guard violations raise SQLSTATE `P0001` with message `immutable_row` (mapped by §5 to `409 billing.invoice_immutable` / `409 common.immutable_record`), except the three insert-time integrity guards, which raise `P0001` with `chronology_violation`, `credit_exceeds_invoice_line` and `reversal_mismatch` [CONV]; the service never triggers these in normal operation (TRD §6.5, §12), so the API maps them to 500 and the nightly `billing.integrity_check` stays the detector. Function names the doc did not give are `<schema>.<table>_lifecycle_guard` / `<schema>.<table>_guard` [CONV]. RLS, policies and grants: §4a. Columns in `UNION ALL` branches of the views are positional; C0 may add explicit aliases without changing the published column list.

```sql
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
```

## 4. DDL — schema `billing`

```sql
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
```

## 4a. RLS, policies and grants (concrete SQL of §2; final sweep 2026-11-06)

One statement group per table of the §2 matrix; predicates are the §2 templates verbatim (P-16 guard in every `__tenant`/`__tenant_centre` policy; A16.1 `::uuid[]` cast). The `trf_attachments` owner policies for the purge DEFINER are in §3. No other DELETE policy exists.

```sql
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

ALTER TABLE frontdesk.patient_consents ENABLE ROW LEVEL SECURITY;  ALTER TABLE frontdesk.patient_consents FORCE ROW LEVEL SECURITY;
CREATE POLICY patient_consents__select__tenant ON frontdesk.patient_consents FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY patient_consents__insert__tenant ON frontdesk.patient_consents FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
GRANT SELECT, INSERT ON frontdesk.patient_consents TO lims_app;

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
GRANT SELECT ON frontdesk.g_cs_reasons, billing.g_cs_payment_methods, billing.g_cs_reasons TO lims_app;
-- frontdesk.event_inbox / billing.event_inbox: table, policies (T: S I + the purge owner policies) and grants are C0's (C0 05-SCHEMA §3.9).
```

Index ↔ query map (every TRD query has an index):
| Query (TRD) | Index |
|---|---|
| F1 name search | `patients__tenant_id_name_search__trgm_idx` |
| F1 phone / code | `patients__tenant_id_phone__p_idx`, `patients__tenant_id_patient_code__uq` |
| F1 registration_no | `orders__tenant_id_registration_no__uq` |
| F6 / last visit | `orders__tenant_id_patient_id_registered_at__idx` |
| F10 list orders | `orders__tenant_id_centre_id_registered_at__idx`; without `centre_id`: `orders__tenant_id_registered_at__idx` |
| F26 possible duplicates | `patients__tenant_id_created_at__idx` + per-candidate `patients__tenant_id_name_search__trgm_idx` / `patients__tenant_id_phone__p_idx` / `patients__tenant_id_birth_on__idx` |
| F21 / F21a TRF | `trf_attachments__pk` |
| F16 approval inbox | `discount_approvals__tenant_id_status_centre_id__p_idx` |
| F22 flags | `order_flags__tenant_id_status_centre_id__p_idx` |
| B1 / sales register | `invoices__tenant_id_issued_at__idx`, `invoices__tenant_id_series_seq__uq` |
| B7 / balance | `order_balances__pk`, `invoices__tenant_id_order_id__idx`, `ledger_entries__tenant_id_order_id__idx` |
| B10 / B10a refund requests | `refund_requests__tenant_id_order_id__idx`, `refund_requests__tenant_id_status__p_idx` |
| B11 ledger list (`created_at_from/to`) | `ledger_entries__tenant_id_created_at__idx` |
| B16 dues | `order_balances__tenant_id_centre_id_due__p_idx` |
| B18 daily cash | `ledger_entries__tenant_id_business_date_collector__idx` |
| B20/B21 credit charges | `credit_charges__tenant_id_party_period_status__idx` |
| B23 statement (credit notes by party) | `credit_notes__tenant_id_credit_party_id_issued_at__p_idx`, `invoices__tenant_id_credit_party_id_period__idx`, `ledger_entries__tenant_id_credit_party__p_idx` |
| B25 cancelled | `invoices__tenant_id_cancelled_at__p_idx` |
| B27 audit trail | `activity_log__tenant_id_actor_occurred__idx` |
| B36 review items | `finance_review_items__tenant_id_status__p_idx` |
| B37 invoice prints / B2 CBMS submissions | `print_log__tenant_id_doc_print__uq`, `cbms_submissions__tenant_id_doc_attempt__uq` |
| CBMS sweep | `invoices__tenant_id_cbms__p_idx`, `invoices__tenant_id_cbms_cancel__p_idx`, `credit_notes__tenant_id_cbms__p_idx` |
| allocation | `fiscal_counters__pk` |

## 5. Immutability and grants summary

| Table | INSERT | UPDATE (columns) | DELETE |
|---|---|---|---|
| billing.invoices | yes | lifecycle list above + guard | never |
| billing.invoice_lines, credit_note_lines, ledger_entries, print_log, activity_log, cbms_submissions, release_overrides, payment_intent_refs | yes | **no grant** | never |
| billing.credit_notes | yes | print/CBMS lifecycle only | never |
| billing.fiscal_counters | yes | last_no (+1), closed_at | never |
| billing.cash_sessions, credit_charges, credit_note_tasks, finance_review_items, refund_requests | yes | lifecycle lists | never |
| billing.order_balances | yes | amounts, version, basis | never |
| frontdesk.orders, order_items, discounts, discount_approvals, trf_attachments | yes | lifecycle lists | never |
| frontdesk.patients | yes | demographics (audited), anonymisation | never (anonymise instead — 02-CV §5.6) |
| frontdesk.patient_consents | yes | no grant | never |
| export_jobs | yes | status fields | purge job only |

API mapping: SQLSTATE `P0001` + `immutable_row` → `409 billing.invoice_immutable` on billing invoice/credit-note/ledger tables, else `409 common.immutable_record` (02-CV §5.7).

## 6. Published views (03-IC §6 — exact columns)

```sql
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

GRANT SELECT ON frontdesk.v_pub_order_daily, frontdesk.v_pub_referrer_volume, frontdesk.v_pub_centre_volume,
  frontdesk.v_pub_order_status, billing.v_pub_invoice_daily, billing.v_pub_department_income,
  billing.v_pub_payment_collection, billing.v_pub_referrer_billing, billing.v_pub_credit_party_statement,
  billing.v_pub_order_balance TO lims_app;
-- C4 reads no other module's view (08 R25; 08 A13 D-5: order status comes from LabPort.getOrderItemProcessingState).
```
Time zone of every `business_date` above: the literal `Asia/Kathmandu` is correct because in v1 `TenantSettings.timezone` accepts only `Asia/Kathmandu` (08 A13 P-15); `ledger_entries.business_date` is written by the app from `timezone` and equals the same date. A per-tenant time zone needs a CR that adds stored `business_date` columns.
Note `v_pub_order_balance.release_basis` is the basis computed at the last balance change; authoritative eligibility is always `BillingPort.getReleaseEligibility` (03-IC §3.5).

## 7. Coded sets and seed data (global G rows, synthetic-safe)

| Table / set | Seed codes [CONV] |
|---|---|
| billing.g_cs_payment_methods | `cash` (is_cash), `card` (requires_reference), `esewa`, `khalti`, `fonepay_qr` (requires_reference), `bank_transfer` (requires_reference) — 00 A9 |
| billing.g_cs_reasons `invoice_cancel_reasons` | `order_cancelled`, `billing_error`, `duplicate_invoice`, `patient_request`, `other` (requires_text) |
| `reversal_reasons` | `wrong_method`, `wrong_amount`, `duplicate_entry`, `other` (requires_text) |
| `refund_reasons` | `test_cancelled`, `overpayment`, `service_not_provided`, `other` (requires_text) |
| `override_reasons` | `credit_arranged`, `management_approval`, `clinical_urgency`, `other` (requires_text) |
| `cash_variance_reasons` | `counting_error`, `change_shortage`, `unknown`, `other` (requires_text) |
| `lock_reasons` | `credit_days_exceeded`, `manual`, `credit_limit_review` |
| `charge_void_reasons` | `order_cancelled`, `item_removed` |
| `print_reasons` | `first_print`, `reprint`, `printer_fault`, `customer_copy` |
| frontdesk.g_cs_reasons `order_cancel_reasons` | `patient_left`, `duplicate_registration`, `wrong_patient`, `booking_cancelled`, `other` (requires_text) |
| `item_removal_reasons` | `patient_request`, `doctor_changed_order`, `wrong_test`, `repriced`, `other` (requires_text) |
| `discount_reasons` | `staff_family`, `senior_citizen`, `promotion`, `doctor_request`, `financial_hardship`, `other` (requires_text) |
| `duplicate_override_reasons` | `different_person_same_name`, `family_shared_phone`, `other` (requires_text) |
| `anonymise_reasons` | `patient_request`, `legal_instruction`, `other` (requires_text) |
| `flag_resolutions` | `recollected`, `patient_unreachable`, `order_kept`, `order_cancelled`, `other` |

Seed generator (C0 `packages/test-fixtures`) needs: per synthetic tenant ≥2 centres, 200 patients "Test Patient NNNN", 2 credit parties "Synthetic Corp", "Synthetic Hospital", synthetic price lists from the C3 fake, frontdesk/billing settings rows.

## 8. Retention

| Data | Retention | Basis |
|---|---|---|
| invoices, lines, credit notes, ledger, counters, print_log, activity_log, cbms_submissions | **kept indefinitely in v1** (no purge function) | legal period UNVERIFIED (04 L20, B15); fiscal records; VAT Act s.29(1)(g2) exposure if deleted (04 L5) |
| patients, consents, orders, items, discounts | per-tenant `retentionYears` floor (default 5); end-of-life = anonymisation, never DELETE | 02-CV §5.6; REQ-SEC-139 |
| TRF attachments (linked) | with the order | 04 I8 default 5 y; no purge task before B15 resolves; objects of an anonymised patient are deleted by F7 (retention already elapsed — 08 A13 P-12 c / D-27 b), rows kept with `is_active = false` |
| TRF drafts (`order_id IS NULL`) | 24 h | class E; `frontdesk.trf_draft_purge` + `frontdesk.purge_trf_drafts` (§3) |
| refund_requests | kept indefinitely in v1 (financial control record) | as fiscal records |
| export_jobs objects / rows | 24 h objects; rows 90 days [CONV] | |
| event_inbox | 90 days | 02-CV §5.11 |

## 9. Per-tenant isolation checks (C0 `db/tests`, requested by C4)

1. No sequences in `frontdesk`/`billing` (§0.2).
2. Every index and unique constraint on tables in these schemas has `tenant_id` as first key column (catalog query over `pg_index`), **except the single-column `PRIMARY KEY (id)`** (UUIDv7, globally unique — 08 A13 P-7), G tables and entries in `db/meta/index-exceptions.yaml` (e.g. the trigram fallback, §0.9); every table with `PRIMARY KEY (id)` also has `UNIQUE (tenant_id, id)`.
3. `has_table_privilege('lims_app', t, 'DELETE') = false` for every table except `billing.export_jobs`; `frontdesk.purge_trf_drafts` FORCE-RLS tests per §3 (08 A10.5).
4. `has_table_privilege('lims_app', t, 'UPDATE') = false` for invoice_lines, credit_note_lines, ledger_entries, print_log, activity_log, cbms_submissions, release_overrides, payment_intent_refs, patient_consents.
5. RLS probes per §11.3 02-CV for every table above (positive + negative), including TCN rows with NULL centre for a centre-scoped actor (must be invisible).
6. Trigger tests: direct `UPDATE billing.invoices SET net_paisa = …` as `lims_app` → `immutable_row`; `UPDATE billing.fiscal_counters SET last_no = last_no + 2` → guard error; `UPDATE … SET status='issued'` on a cancelled invoice → guard error.
7. `ledger_entries`: gateway row with a collector, or manual/home_collection row without one → CHECK violation `ledger_entries__collector__ck` (08 R8). `billing.v_pub_payment_collection` exposes `payment_method_code` (08 R4).
8. Claims with `actor_type` `partner`/`portal`/`patient` and the tenant id see 0 rows in every frontdesk/billing table (`app.is_staff_or_system()`).
9. `finance_review_items`: INSERT with `kind = 'home_payment_method_inactive'` succeeds; `kind = 'unknown_kind'` → CHECK violation `finance_review_items__kind__ck` (08 A19 D-128). The TC/TCN policy predicates use `ANY ((SELECT app.current_centre_ids())::uuid[])` (08 A16.1): a centre-scoped actor's SELECT runs without `operator does not exist: uuid = uuid[]`.

Final sweep 2026-11-06 — second touch applied (A16.1 cast in TC/TCN; D-128 `finance_review_items__kind__ck` value `home_payment_method_inactive` [CONV]; DB tests 9).

Final check 2026-11-06 — every guard trigger function the DDL references is written out (§3/§4: `frontdesk.orders_lifecycle_guard`, `billing.fiscal_counters_guard`, `billing.invoices_lifecycle_guard`, `billing.invoices_chronology_guard`, `billing.credit_notes_chronology_guard`) together with the comment-only guards of the same sections (`order_items`, `discount_approvals`, `trf_attachments`, `credit_note_lines`, `cash_sessions`, `ledger_entries` reversal, `order_balances`, `credit_charges`, `refund_requests`); `discount_approvals` now precedes `discounts`; the §2 template is pattern text and §4a gives the concrete RLS/grant SQL; `CREATE SCHEMA IF NOT EXISTS` (C0 creates the schemas). The whole DDL loads on scratch PostgreSQL 16 as `lims_owner` in one transaction with no errors (C0 objects stubbed), and the §9 test 6/7/8 cases behave as specified.
