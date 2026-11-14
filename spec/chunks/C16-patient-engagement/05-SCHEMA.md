# C16 — Patient Engagement — 05 Schema (spec for C0-0B; CR-C16-006)

Status: DECISION draft, 2026-11-06. Schema `engagement` (01 §3). C0 writes the DDL from this file (01 §0); the SQL below is the specification. Conventions: 02-CV §5 (mandatory columns, composite FKs, no ENUM types, RLS template, immutability trigger, naming). PHI classes P0–P3 from 03-IC §1 are given per column in the DDL comments. All ids are UUIDv7 generated in application code, no DB defaults (04 D9). All tables: `ENABLE` + `FORCE ROW LEVEL SECURITY`, owner `lims_owner`, policies `TO lims_app` (X9), plus the `__owner_only` policies `TO lims_owner` of §6.5 for the DEFINERs (08 A10.5).

## 1. Table inventory

| Table | Class (02-CV §5.2) | Scope | Purpose | Grants to `lims_app` |
|---|---|---|---|---|
| `settings` | M | tenant | per-tenant engagement settings (one row) | S I U |
| `accounts` | M | tenant | patient app account = verified phone | S I U |
| `otp_challenges` | E | tenant | login OTP challenges | S I U D |
| `link_codes` | E | tenant | desk-issued linking codes | S I U D |
| `link_consents` | A | tenant | consent records for app access | S I |
| `account_patient_links` | M (status) | tenant | account ↔ `frontdesk.patients` links (patient column guard §4) | S I U |
| `self_registrations` | E | tenant | self/child registration requests | S I U |
| `addresses` | M | tenant | home-collection addresses | S I U |
| `bookable_items` | M | tenant | bookable catalogue snapshot | S I U |
| `booking_centres` | E (projection) | tenant | centre names/branch/address for patient handlers (08 A19 D-119) | S I U |
| `slot_templates` | M | tenant+centre | appointment slot rules | S I U |
| `slot_blackouts` | M | tenant+centre | closures | S I U |
| `slot_occupancy` | M (counter) | tenant+centre | capacity counters per slot | S I U |
| `bookings` | C (state machine, no delete) | tenant+centre | bookings | S I U |
| `booking_items` | A | tenant+centre | orderables of a booking | S I |
| `booking_transitions` | A | tenant+centre | booking state history | S I |
| `patient_orders` | E (projection, read model) | tenant | order projection for linked patients | S I U D |
| `patient_order_specimens` | E (projection, read model) | tenant | specimen projection | S I U D |
| `patient_reports` | E (projection, read model) | tenant | released report projection | S I U D |
| `smart_summaries` | E (projection, read model) | tenant | approved smart summaries | S I U D |
| `notifications` | E | tenant | in-app inbox | S I U D |
| `payment_requests` | M (status) | tenant | in-app payment requests (terminal rows purged by DEFINER §6.4) | S I U |
| `queue_definitions` | M | tenant+centre | queues | S I U |
| `queue_counters` | M | tenant+centre | counters | S I U |
| `queue_day_counters` | M (counter) | tenant+centre | token numbering per queue/day (purged after 1 year by DEFINER §6.4) | S I U |
| `queue_tokens` | C (state machine, no delete by `lims_app`) | tenant+centre | queue tokens (no patient data; purged after 1 year by DEFINER §6.4) | S I U |
| `queue_displays` | M | tenant+centre | paired display screens | S I U |
| `reminders` | M (status) | tenant | reminders | S I U |
| `membership_plans` | M | tenant | membership plans → price list | S I U |
| `patient_memberships` | M (status) | tenant | memberships | S I U |
| `number_counters` | E (counter) | tenant | booking_no, card_no, durable rate counters (rate keys expire) | S I U D |
| `enquiries` | M (status) | tenant | enquiry threads | S I U |
| `enquiry_messages` | A | tenant | messages | S I |
| `cs_booking_cancel_reasons`, `cs_reminder_reasons`, `cs_enquiry_categories` | M (coded set, tenant) | tenant | tenant additions/overrides | S I U |
| `g_cs_booking_cancel_reasons`, `g_cs_reminder_reasons`, `g_cs_enquiry_categories` | G | global | seeds | S |
| `event_inbox` | A | tenant | consumer dedupe (03-IC §12) | S I |

`D` (DELETE) is granted to `lims_app` only on class E tables (08 A17 P-18(a)/(c)), and every DELETE policy admits only the system actor:
- the four read-model tables (copies of other modules' data, deleted by the system actor when no link to the patient remains — 03-APP-FLOW §3.4);
- `otp_challenges`, `link_codes`, `notifications`, `number_counters` (rate keys): retention deletes by the system actor in the `per_tenant` task `engagement.purge_ephemeral` (P-6), under `<t>__delete__tenant` policies with an `expires_at` predicate (P-18(c); SQL §5.3). These are **not** DEFINERs (08 A19 P-41, D-121).

Non-E rows that are removed after a retention period (`payment_requests` terminal + 90 days, `queue_tokens`/`queue_day_counters` after 1 year) are deleted only by the `lims_owner` DEFINERs of §6.4 with `app.maintenance` owner policies (08 A12.2, A19 D-121). CI assertion for every other table: `has_table_privilege('lims_app', '<table>', 'DELETE') = false`.

**Mandatory-column exceptions** (08 A17 P-18(b); copied to `db/meta/tables.yaml`):
- `patient_orders`, `patient_order_specimens`, `patient_reports`: natural-key PK (no `id`), no `version`/`is_active` (users never edit them), no `expires_at` (deleted by the system actor when the last link to the patient is revoked, not by age).
- `smart_summaries`: no `version`/`is_active`/`expires_at` (same reasons; deleted with its `patient_reports` row by `ON DELETE CASCADE`).
- `booking_centres`: no `version` (system-written only, users never edit), no `expires_at` (rows are deactivated, never expire).
- `queue_day_counters`, `number_counters`: natural-key PK (no `id`), no `version`/`is_active`; `number_counters.expires_at` is NULL for numbering keys (`booking_no`, `card_no`) and set for rate keys.
- `otp_challenges`, `link_codes`, `self_registrations`, `notifications`: no `version`/`is_active` (system/pre-auth run state; users never edit them through a versioned API).
- `event_inbox`: generated by C0 (03-IC §12).

## 2. Notable columns and rules

### 2.1 `engagement.settings` (one row per tenant; defaults used when absent)

| Column | Type | Default | Range / rule | PHI |
|---|---|---|---|---|
| app_enabled, bookings_enabled, home_collection_enabled, queue_enabled, reminders_enabled, memberships_enabled, enquiries_enabled, smart_report_in_app, show_partner_orders, auto_no_show, auto_follow_up_reminders | boolean | false (auto_no_show true) | — | P0 |
| home_collection_centre_id | uuid | NULL | FK centre; required when home_collection_enabled | P0 |
| allowed_phone_prefixes | text[] | `{+977}` | 1–5 entries `^\+[1-9][0-9]{0,3}$` (non-prod: C0 synthetic prefix) | P0 |
| otp_daily_cap | integer | 2000 | 100–20000 | P0 |
| min_app_version_android, min_app_version_ios | text | `0.0.0` | `^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,4}$` | P0 |
| app_gateways | text[] | `{}` | ⊆ {esewa, khalti} | P0 |
| support_phone | text | NULL | ≤ 40 (business phone) | P0 |
| app_consent_text | text | NULL | ≤ 4000 | P0 |
| app_consent_text_version | text | NULL | ≤ 32; changes whenever the text changes (trigger check: text changed ⇒ version changed) | P0 |
| max_profiles_per_account | integer | 8 | 1–10 | P0 |
| max_accounts_per_patient | integer | 3 | 1–5 | P0 |
| link_code_ttl_hours | integer | 72 | 1–168 | P0 |
| dormant_after_days | integer | 180 | 30–730 | P0 |
| minor_age_years | integer | 18 (UNVERIFIED legal value, B16) | 14–21 | P0 |
| booking_horizon_days | integer | 14 | 1–60 | P0 |
| booking_min_lead_minutes | integer | 120 | 0–2880 | P0 |
| booking_cancel_cutoff_minutes | integer | 60 | 0–2880 | P0 |
| no_show_grace_minutes | integer | 120 | 15–1440 | P0 |
| max_active_bookings_per_profile | integer | 2 | 1–5 | P0 |
| max_bookings_created_per_account_day | integer | 3 | 1–10 | P0 |
| max_orderables_per_booking | integer | 20 | 1–50 | P0 |
| booking_reminder_hours_before | integer | 24 | 1–72 | P0 |
| follow_up_reminder_lead_days | integer | 3 | 0–30 | P0 |
| queue_display_history_count | integer | 5 | 1–10 | P0 |
| smart_report_disclaimer_text | text | NULL | ≤ 1000 (fallback until CR-C16-015) | P0 |

### 2.2 Key invariants (enforced by constraints/triggers below)

1. One non-deleted account per (tenant, phone) — partial unique index.
2. One active-or-suspended link per (tenant, account, patient) — partial unique index.
3. `slot_occupancy.booked ≥ 0`; booking capacity enforced by the conditional `UPDATE … booked < capacity` (TRD §4.8); capacity may be lowered below `booked` by staff (overbooked flag computed).
4. One active membership per (tenant, patient) — partial unique index.
5. Queue token `(tenant, queue, business_date, seq)` unique.
6. One open payment request per (tenant, order) — partial unique index on status `queued`/`ready`.
7. Bookings: only lifecycle columns change (`app.enforce_mutable_columns`); items/transitions append-only.
8. Read models: no FK to source rows (projections tolerate ordering; sources are append/immutable) — DECISION; `patient_id` FK to `frontdesk.patients` is kept (upstream, R3).
9. Every unique constraint and index has `tenant_id` leading, except `queue_displays (token_sha256)` (pre-tenant resolver lookup; CR-C16-006 exception like CR-C2-017).

## 3. DDL

```sql
-- ============================================================================
-- engagement schema (C16) — specification for C0-0B
-- ============================================================================

-- ---------- settings (M) ----------
CREATE TABLE engagement.settings (
  id                               uuid        NOT NULL,
  tenant_id                        uuid        NOT NULL,
  app_enabled                      boolean     NOT NULL DEFAULT false,
  bookings_enabled                 boolean     NOT NULL DEFAULT false,
  home_collection_enabled          boolean     NOT NULL DEFAULT false,
  queue_enabled                    boolean     NOT NULL DEFAULT false,
  reminders_enabled                boolean     NOT NULL DEFAULT false,
  memberships_enabled              boolean     NOT NULL DEFAULT false,
  enquiries_enabled                boolean     NOT NULL DEFAULT false,
  smart_report_in_app              boolean     NOT NULL DEFAULT false,
  show_partner_orders              boolean     NOT NULL DEFAULT false,
  auto_no_show                     boolean     NOT NULL DEFAULT true,
  auto_follow_up_reminders         boolean     NOT NULL DEFAULT false,
  home_collection_centre_id        uuid,
  allowed_phone_prefixes           text[]      NOT NULL DEFAULT '{+977}',
  otp_daily_cap                    integer     NOT NULL DEFAULT 2000,
  min_app_version_android          text        NOT NULL DEFAULT '0.0.0',
  min_app_version_ios              text        NOT NULL DEFAULT '0.0.0',
  app_gateways                     text[]      NOT NULL DEFAULT '{}',
  support_phone                    text,
  app_consent_text                 text,
  app_consent_text_version         text,
  max_profiles_per_account         integer     NOT NULL DEFAULT 8,
  max_accounts_per_patient         integer     NOT NULL DEFAULT 3,
  link_code_ttl_hours              integer     NOT NULL DEFAULT 72,
  dormant_after_days               integer     NOT NULL DEFAULT 180,
  minor_age_years                  integer     NOT NULL DEFAULT 18,
  booking_horizon_days             integer     NOT NULL DEFAULT 14,
  booking_min_lead_minutes         integer     NOT NULL DEFAULT 120,
  booking_cancel_cutoff_minutes    integer     NOT NULL DEFAULT 60,
  no_show_grace_minutes            integer     NOT NULL DEFAULT 120,
  max_active_bookings_per_profile  integer     NOT NULL DEFAULT 2,
  max_bookings_created_per_account_day integer NOT NULL DEFAULT 3,
  max_orderables_per_booking       integer     NOT NULL DEFAULT 20,
  booking_reminder_hours_before    integer     NOT NULL DEFAULT 24,
  follow_up_reminder_lead_days     integer     NOT NULL DEFAULT 3,
  queue_display_history_count      integer     NOT NULL DEFAULT 5,
  smart_report_disclaimer_text     text,
  version                          integer     NOT NULL DEFAULT 1,
  is_active                        boolean     NOT NULL DEFAULT true,
  created_at                       timestamptz NOT NULL DEFAULT now(),
  created_by                       uuid        NOT NULL,
  updated_at                       timestamptz NOT NULL DEFAULT now(),
  updated_by                       uuid        NOT NULL,
  CONSTRAINT settings__pk PRIMARY KEY (id),
  CONSTRAINT settings__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT settings__tenant_id__uq UNIQUE (tenant_id),
  CONSTRAINT settings__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT settings__hc_centre__fk FOREIGN KEY (tenant_id, home_collection_centre_id) REFERENCES core.collection_centres (tenant_id, id),
  CONSTRAINT settings__hc_centre__ck CHECK (NOT home_collection_enabled OR home_collection_centre_id IS NOT NULL),
  CONSTRAINT settings__prefixes__ck CHECK (cardinality(allowed_phone_prefixes) BETWEEN 1 AND 5
             AND array_to_string(allowed_phone_prefixes, ',') ~ '^(\+[1-9][0-9]{0,3})(,\+[1-9][0-9]{0,3})*$'),
  CONSTRAINT settings__gateways__ck CHECK (app_gateways <@ ARRAY['esewa','khalti']::text[]),
  CONSTRAINT settings__versions__ck CHECK (min_app_version_android ~ '^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,4}$'
             AND min_app_version_ios ~ '^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,4}$'),
  CONSTRAINT settings__texts__ck CHECK ((support_phone IS NULL OR char_length(support_phone) <= 40)
             AND (app_consent_text IS NULL OR char_length(app_consent_text) <= 4000)
             AND (app_consent_text_version IS NULL OR char_length(app_consent_text_version) BETWEEN 1 AND 32)
             AND ((app_consent_text IS NULL) = (app_consent_text_version IS NULL))
             AND (smart_report_disclaimer_text IS NULL OR char_length(smart_report_disclaimer_text) <= 1000)),
  CONSTRAINT settings__ranges__ck CHECK (
        otp_daily_cap BETWEEN 100 AND 20000 AND max_profiles_per_account BETWEEN 1 AND 10
    AND max_accounts_per_patient BETWEEN 1 AND 5 AND link_code_ttl_hours BETWEEN 1 AND 168
    AND dormant_after_days BETWEEN 30 AND 730 AND minor_age_years BETWEEN 14 AND 21
    AND booking_horizon_days BETWEEN 1 AND 60 AND booking_min_lead_minutes BETWEEN 0 AND 2880
    AND booking_cancel_cutoff_minutes BETWEEN 0 AND 2880 AND no_show_grace_minutes BETWEEN 15 AND 1440
    AND max_active_bookings_per_profile BETWEEN 1 AND 5 AND max_bookings_created_per_account_day BETWEEN 1 AND 10
    AND max_orderables_per_booking BETWEEN 1 AND 50 AND booking_reminder_hours_before BETWEEN 1 AND 72
    AND follow_up_reminder_lead_days BETWEEN 0 AND 30 AND queue_display_history_count BETWEEN 1 AND 10)
);
-- trigger: if NEW.app_consent_text IS DISTINCT FROM OLD.app_consent_text then NEW.app_consent_text_version must differ
CREATE FUNCTION engagement.settings_consent_version_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.app_consent_text IS DISTINCT FROM OLD.app_consent_text
     AND NEW.app_consent_text_version IS NOT DISTINCT FROM OLD.app_consent_text_version THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'consent_version_required';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER settings__consent_version BEFORE UPDATE ON engagement.settings
  FOR EACH ROW EXECUTE FUNCTION engagement.settings_consent_version_guard();

-- ---------- accounts (M) ----------
CREATE TABLE engagement.accounts (
  id                 uuid        NOT NULL,
  tenant_id          uuid        NOT NULL,
  membership_id      uuid,                         -- P1; set after IdentityPort.provisionPatientMembership
  user_id            uuid,                         -- P1; GoTrue sub (any UUID version)
  phone_e164         text,                         -- P2; NULL only when deleted
  phone_hmac         bytea,                        -- P1; raw HMAC-SHA256, 32 bytes (08 A5.5); NULL only when deleted
  status             text        NOT NULL DEFAULT 'active',
  reminders_opt_out  boolean     NOT NULL DEFAULT false,
  last_login_at      timestamptz,
  last_app_platform  text,
  last_app_version   text,
  deleted_at         timestamptz,
  version            integer     NOT NULL DEFAULT 1,
  is_active          boolean     NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid        NOT NULL,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         uuid        NOT NULL,
  CONSTRAINT accounts__pk PRIMARY KEY (id),
  CONSTRAINT accounts__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT accounts__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT accounts__membership__fk FOREIGN KEY (tenant_id, membership_id) REFERENCES core.memberships (tenant_id, id),
  CONSTRAINT accounts__status__ck CHECK (status IN ('active','deleted')),
  CONSTRAINT accounts__phone__ck CHECK ((status = 'deleted') OR (phone_e164 ~ '^\+[1-9][0-9]{7,14}$' AND octet_length(phone_hmac) = 32)),   -- 08 A5.5
  CONSTRAINT accounts__deleted__ck CHECK ((status = 'deleted') = (deleted_at IS NOT NULL)),
  CONSTRAINT accounts__platform__ck CHECK (last_app_platform IS NULL OR last_app_platform IN ('android','ios')),
  CONSTRAINT accounts__app_version__ck CHECK (last_app_version IS NULL OR last_app_version ~ '^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,4}$')
);
CREATE UNIQUE INDEX accounts__tenant_id_phone_e164__p_uq ON engagement.accounts (tenant_id, phone_e164) WHERE status = 'active';
CREATE UNIQUE INDEX accounts__tenant_id_phone_hmac__p_uq ON engagement.accounts (tenant_id, phone_hmac) WHERE status = 'active';
CREATE UNIQUE INDEX accounts__tenant_id_membership_id__p_uq ON engagement.accounts (tenant_id, membership_id) WHERE membership_id IS NOT NULL;
CREATE INDEX accounts__tenant_id_last_login_at__p_idx ON engagement.accounts (tenant_id, last_login_at) WHERE status = 'active';

-- ---------- otp_challenges (E) ----------
CREATE TABLE engagement.otp_challenges (
  id                uuid        NOT NULL,
  tenant_id         uuid        NOT NULL,
  token_sha256      bytea       NOT NULL,          -- P1 (32-byte SHA-256 of a secret; 08 R24)
  phone_e164        text        NOT NULL,          -- P2
  phone_hmac        bytea       NOT NULL,          -- P1; raw HMAC-SHA256, 32 bytes (08 A5.5)
  app_instance_id   uuid        NOT NULL,          -- P1
  app_platform      text        NOT NULL,
  code_hmac         bytea       NOT NULL,          -- secret-derived; raw HMAC-SHA256, 32 bytes (08 A5.5); never logged
  code_ciphertext   bytea,                         -- secret; NULL after send
  code_key_id       text,
  status            text        NOT NULL DEFAULT 'pending',
  attempts          integer     NOT NULL DEFAULT 0,
  send_delivery_id  uuid,
  verified_at       timestamptz,
  consumed_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid        NOT NULL,
  expires_at        timestamptz NOT NULL,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT otp_challenges__pk PRIMARY KEY (id),
  CONSTRAINT otp_challenges__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT otp_challenges__tenant_id_token__uq UNIQUE (tenant_id, token_sha256),
  CONSTRAINT otp_challenges__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT otp_challenges__status__ck CHECK (status IN ('pending','sent','verified','failed','superseded')),
  CONSTRAINT otp_challenges__attempts__ck CHECK (attempts BETWEEN 0 AND 5),                       -- 04 A9
  CONSTRAINT otp_challenges__ttl__ck CHECK (expires_at <= created_at + interval '10 minutes'),     -- 04 A9
  CONSTRAINT otp_challenges__hashes__ck CHECK (octet_length(token_sha256) = 32 AND octet_length(code_hmac) = 32 AND octet_length(phone_hmac) = 32),  -- 08 A5.5
  CONSTRAINT otp_challenges__phone__ck CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  CONSTRAINT otp_challenges__platform__ck CHECK (app_platform IN ('android','ios'))
);
CREATE INDEX otp_challenges__tenant_id_phone_hmac_created_at__idx ON engagement.otp_challenges (tenant_id, phone_hmac, created_at DESC);
CREATE INDEX otp_challenges__tenant_id_expires_at__idx ON engagement.otp_challenges (tenant_id, expires_at);   -- purge (per_tenant task, P-18(c))
-- supersession (send_login_otp task, TRD §4.1 step 2) filters (tenant_id, phone_hmac, app_instance_id, status IN ('pending','sent'));
-- otp_challenges__tenant_id_phone_hmac_created_at__idx serves it (≤ 3 challenges per phone per hour, 04 §4), so no extra index is added.

-- ---------- link_consents (A) ----------
CREATE TABLE engagement.link_consents (
  id                     uuid        NOT NULL,
  tenant_id              uuid        NOT NULL,
  patient_id             uuid,                     -- P1; NULL for a self-registration until the patient exists
  account_id             uuid,                     -- P1; app-side consents
  source                 text        NOT NULL,     -- desk | app
  relationship           text        NOT NULL,
  consented_by           text        NOT NULL,     -- patient | guardian
  consent_text_version   text        NOT NULL,
  identity_check_method  text,                     -- desk only
  recorded_by_membership_id uuid,                  -- desk
  recorded_at            timestamptz NOT NULL DEFAULT now(),
  created_at             timestamptz NOT NULL DEFAULT now(),
  created_by             uuid        NOT NULL,
  CONSTRAINT link_consents__pk PRIMARY KEY (id),
  CONSTRAINT link_consents__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT link_consents__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT link_consents__patient__fk FOREIGN KEY (tenant_id, patient_id) REFERENCES frontdesk.patients (tenant_id, id),
  CONSTRAINT link_consents__account__fk FOREIGN KEY (tenant_id, account_id) REFERENCES engagement.accounts (tenant_id, id),
  CONSTRAINT link_consents__membership__fk FOREIGN KEY (tenant_id, recorded_by_membership_id) REFERENCES core.memberships (tenant_id, id),
  CONSTRAINT link_consents__source__ck CHECK (source IN ('desk','app')),
  CONSTRAINT link_consents__relationship__ck CHECK (relationship IN ('self','child','parent','spouse','sibling','other')),
  CONSTRAINT link_consents__by__ck CHECK (consented_by IN ('patient','guardian')),
  CONSTRAINT link_consents__version__ck CHECK (char_length(consent_text_version) BETWEEN 1 AND 40),
  CONSTRAINT link_consents__check__ck CHECK (identity_check_method IS NULL OR identity_check_method IN ('photo_id','guardian_photo_id','known_patient')),
  CONSTRAINT link_consents__shape__ck CHECK ((source = 'desk' AND patient_id IS NOT NULL AND identity_check_method IS NOT NULL AND recorded_by_membership_id IS NOT NULL)
                                          OR (source = 'app' AND account_id IS NOT NULL))
);
CREATE INDEX link_consents__tenant_id_patient_id__idx ON engagement.link_consents (tenant_id, patient_id);

-- ---------- link_codes (E) ----------
CREATE TABLE engagement.link_codes (
  id                       uuid        NOT NULL,
  tenant_id                uuid        NOT NULL,
  patient_id               uuid        NOT NULL,   -- P1
  code_hmac                bytea       NOT NULL,   -- secret-derived; raw HMAC-SHA256, 32 bytes (08 R24/A2.4)
  bound_phone_hmac         bytea       NOT NULL,   -- P1; raw HMAC-SHA256, 32 bytes (08 A2.4)
  bound_phone_last2        text        NOT NULL,   -- P2 (masked display)
  record_phone_hmac        bytea,                  -- P1; raw HMAC-SHA256 (32 bytes) of the record phone at issue (08 A5.5)
  relationship             text        NOT NULL,
  consent_id               uuid        NOT NULL,
  display_name_snapshot    text        NOT NULL,   -- P2 (patient name for the profile)
  sex_snapshot             text,                   -- P2; from FrontdeskPort.getPatientDemographics at issue, copied to the link on redeem (review C16 #16)
  issued_by_membership_id  uuid        NOT NULL,
  issued_centre_id         uuid,                   -- working centre of the issuer (audit context)
  status                   text        NOT NULL DEFAULT 'issued',
  revoke_reason            text,
  redeemed_at              timestamptz,
  redeemed_account_id      uuid,
  created_at               timestamptz NOT NULL DEFAULT now(),
  created_by               uuid        NOT NULL,
  expires_at               timestamptz NOT NULL,
  updated_at               timestamptz NOT NULL DEFAULT now(),
  updated_by               uuid        NOT NULL,
  CONSTRAINT link_codes__pk PRIMARY KEY (id),
  CONSTRAINT link_codes__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT link_codes__tenant_id_code_hmac__uq UNIQUE (tenant_id, code_hmac),
  CONSTRAINT link_codes__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT link_codes__patient__fk FOREIGN KEY (tenant_id, patient_id) REFERENCES frontdesk.patients (tenant_id, id),
  CONSTRAINT link_codes__consent__fk FOREIGN KEY (tenant_id, consent_id) REFERENCES engagement.link_consents (tenant_id, id),
  CONSTRAINT link_codes__issuer__fk FOREIGN KEY (tenant_id, issued_by_membership_id) REFERENCES core.memberships (tenant_id, id),
  CONSTRAINT link_codes__centre__fk FOREIGN KEY (tenant_id, issued_centre_id) REFERENCES core.collection_centres (tenant_id, id),
  CONSTRAINT link_codes__account__fk FOREIGN KEY (tenant_id, redeemed_account_id) REFERENCES engagement.accounts (tenant_id, id),
  CONSTRAINT link_codes__status__ck CHECK (status IN ('issued','redeemed','revoked')),
  CONSTRAINT link_codes__revoke__ck CHECK ((status = 'revoked') = (revoke_reason IS NOT NULL)),
  CONSTRAINT link_codes__revoke_reason__ck CHECK (revoke_reason IS NULL OR revoke_reason IN ('staff','superseded')),
  CONSTRAINT link_codes__redeemed__ck CHECK ((status = 'redeemed') = (redeemed_at IS NOT NULL AND redeemed_account_id IS NOT NULL)),
  CONSTRAINT link_codes__relationship__ck CHECK (relationship IN ('self','child','parent','spouse','sibling','other')),
  CONSTRAINT link_codes__ttl__ck CHECK (expires_at <= created_at + interval '168 hours'),
  CONSTRAINT link_codes__hash__ck CHECK (octet_length(code_hmac) = 32 AND octet_length(bound_phone_hmac) = 32   -- 08 A2.4
             AND (record_phone_hmac IS NULL OR octet_length(record_phone_hmac) = 32) AND bound_phone_last2 ~ '^[0-9]{2}$'),
  CONSTRAINT link_codes__name__ck CHECK (char_length(display_name_snapshot) BETWEEN 1 AND 200),
  CONSTRAINT link_codes__sex__ck CHECK (sex_snapshot IS NULL OR sex_snapshot IN ('male','female','other','unknown'))
);
CREATE INDEX link_codes__tenant_id_patient_id_status__idx ON engagement.link_codes (tenant_id, patient_id, status);
CREATE INDEX link_codes__tenant_id_issuer_created_at__idx ON engagement.link_codes (tenant_id, issued_by_membership_id, created_at);  -- volume alert
CREATE INDEX link_codes__tenant_id_expires_at__idx ON engagement.link_codes (tenant_id, expires_at);   -- purge (per_tenant task, P-18(c))

-- ---------- account_patient_links (M, status) ----------
CREATE TABLE engagement.account_patient_links (
  id                         uuid        NOT NULL,
  tenant_id                  uuid        NOT NULL,
  account_id                 uuid        NOT NULL,   -- P1
  patient_id                 uuid        NOT NULL,   -- P1
  relationship               text        NOT NULL,
  method                     text        NOT NULL,
  link_code_id               uuid,
  consent_id                 uuid,
  display_name               text        NOT NULL,   -- P2
  sex_snapshot               text,                   -- P2 (for bookable sex restrictions); link_code: copied from link_codes.sex_snapshot; report_link: set by backfill_link, refreshed by reconcile_links (system); NULL = restriction not enforced (TRD §4.8)
  status                     text        NOT NULL DEFAULT 'active',
  suspend_reason             text,
  suspended_at               timestamptz,
  visible_from               timestamptz,            -- NULL = full history
  record_phone_hmac_at_link  bytea,                  -- P1; copy of link_codes.record_phone_hmac, raw 32 bytes (08 A5.5: compared for phone matching)
  revoked_by_kind            text,
  revoked_reason_code        text,
  revoked_at                 timestamptz,
  version                    integer     NOT NULL DEFAULT 1,
  is_active                  boolean     NOT NULL DEFAULT true,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  created_by                 uuid        NOT NULL,
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  updated_by                 uuid        NOT NULL,
  CONSTRAINT account_patient_links__pk PRIMARY KEY (id),
  CONSTRAINT account_patient_links__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT account_patient_links__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT account_patient_links__account__fk FOREIGN KEY (tenant_id, account_id) REFERENCES engagement.accounts (tenant_id, id),
  CONSTRAINT account_patient_links__patient__fk FOREIGN KEY (tenant_id, patient_id) REFERENCES frontdesk.patients (tenant_id, id),
  CONSTRAINT account_patient_links__code__fk FOREIGN KEY (tenant_id, link_code_id) REFERENCES engagement.link_codes (tenant_id, id),
  CONSTRAINT account_patient_links__consent__fk FOREIGN KEY (tenant_id, consent_id) REFERENCES engagement.link_consents (tenant_id, id),
  CONSTRAINT account_patient_links__relationship__ck CHECK (relationship IN ('self','child','parent','spouse','sibling','other')),
  CONSTRAINT account_patient_links__method__ck CHECK (method IN ('link_code','report_link','self_registered')),
  CONSTRAINT account_patient_links__method_code__ck CHECK (method <> 'link_code' OR link_code_id IS NOT NULL),
  CONSTRAINT account_patient_links__status__ck CHECK (status IN ('active','suspended','revoked')),
  CONSTRAINT account_patient_links__suspend__ck CHECK ((status = 'suspended') = (suspend_reason IS NOT NULL AND suspended_at IS NOT NULL)),
  CONSTRAINT account_patient_links__suspend_reason__ck CHECK (suspend_reason IS NULL OR suspend_reason IN ('phone_mismatch','patient_merged','patient_anonymised','dormant')),
  CONSTRAINT account_patient_links__revoke__ck CHECK ((status = 'revoked') = (revoked_by_kind IS NOT NULL AND revoked_at IS NOT NULL)),
  CONSTRAINT account_patient_links__revoked_by__ck CHECK (revoked_by_kind IS NULL OR revoked_by_kind IN ('account','staff','system')),
  CONSTRAINT account_patient_links__revoke_reason__ck CHECK (revoked_reason_code IS NULL OR revoked_reason_code IN ('patient_request','suspected_misuse','staff_error','account_deleted','other')),
  CONSTRAINT account_patient_links__sex__ck CHECK (sex_snapshot IS NULL OR sex_snapshot IN ('male','female','other','unknown')),
  CONSTRAINT account_patient_links__name__ck CHECK (char_length(display_name) BETWEEN 1 AND 200),
  CONSTRAINT account_patient_links__phone_hmac__ck CHECK (record_phone_hmac_at_link IS NULL OR octet_length(record_phone_hmac_at_link) = 32)  -- 08 A5.5
);
CREATE UNIQUE INDEX account_patient_links__tenant_id_account_id_patient_id__p_uq
  ON engagement.account_patient_links (tenant_id, account_id, patient_id) WHERE status IN ('active','suspended');
CREATE UNIQUE INDEX account_patient_links__tenant_id_account_self__p_uq
  ON engagement.account_patient_links (tenant_id, account_id) WHERE status IN ('active','suspended') AND relationship = 'self';
CREATE INDEX account_patient_links__tenant_id_patient_id__p_idx
  ON engagement.account_patient_links (tenant_id, patient_id) WHERE status IN ('active','suspended');   -- consumer "is linked?"
CREATE INDEX account_patient_links__tenant_id_account_id__idx ON engagement.account_patient_links (tenant_id, account_id, status);
CREATE TRIGGER account_patient_links__mutable_columns BEFORE UPDATE ON engagement.account_patient_links
  FOR EACH ROW EXECUTE FUNCTION app.enforce_mutable_columns(
    'relationship','method','link_code_id','consent_id','display_name','sex_snapshot','status','suspend_reason','suspended_at',
    'visible_from','record_phone_hmac_at_link','revoked_by_kind','revoked_reason_code','revoked_at','is_active',
    'updated_at','updated_by','version');                                   -- account_id and patient_id never change

-- ---------- self_registrations (E) ----------
CREATE TABLE engagement.self_registrations (
  id               uuid        NOT NULL,
  tenant_id        uuid        NOT NULL,
  account_id       uuid        NOT NULL,
  relationship     text        NOT NULL,
  full_name        text,                     -- P2; NULLed 30 days after terminal
  sex              text,                     -- P2
  birth_on         date,                     -- P2
  age_years        integer,                  -- P2
  sms_consent      boolean     NOT NULL,
  whatsapp_consent boolean     NOT NULL,
  consent_id       uuid        NOT NULL,
  status           text        NOT NULL DEFAULT 'queued',
  patient_id       uuid,
  link_id          uuid,
  failure_code     text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid        NOT NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,     -- purge horizon for personal fields
  CONSTRAINT self_registrations__pk PRIMARY KEY (id),
  CONSTRAINT self_registrations__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT self_registrations__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT self_registrations__account__fk FOREIGN KEY (tenant_id, account_id) REFERENCES engagement.accounts (tenant_id, id),
  CONSTRAINT self_registrations__consent__fk FOREIGN KEY (tenant_id, consent_id) REFERENCES engagement.link_consents (tenant_id, id),
  CONSTRAINT self_registrations__patient__fk FOREIGN KEY (tenant_id, patient_id) REFERENCES frontdesk.patients (tenant_id, id),
  CONSTRAINT self_registrations__link__fk FOREIGN KEY (tenant_id, link_id) REFERENCES engagement.account_patient_links (tenant_id, id),
  CONSTRAINT self_registrations__relationship__ck CHECK (relationship IN ('self','child')),
  CONSTRAINT self_registrations__status__ck CHECK (status IN ('queued','created','failed')),
  CONSTRAINT self_registrations__created__ck CHECK ((status = 'created') = (patient_id IS NOT NULL AND link_id IS NOT NULL)),
  CONSTRAINT self_registrations__sex__ck CHECK (sex IS NULL OR sex IN ('male','female','other','unknown')),
  CONSTRAINT self_registrations__age__ck CHECK (age_years IS NULL OR age_years BETWEEN 0 AND 150),
  CONSTRAINT self_registrations__name__ck CHECK (full_name IS NULL OR char_length(full_name) BETWEEN 1 AND 200),
  CONSTRAINT self_registrations__queued_fields__ck CHECK (status <> 'queued' OR (full_name IS NOT NULL AND sex IS NOT NULL AND (birth_on IS NOT NULL OR age_years IS NOT NULL)))
);
CREATE INDEX self_registrations__tenant_id_account_id__idx ON engagement.self_registrations (tenant_id, account_id, created_at DESC);

-- ---------- addresses (M) ----------
CREATE TABLE engagement.addresses (
  id                  uuid        NOT NULL,
  tenant_id           uuid        NOT NULL,
  account_id          uuid,                    -- NULL when entered by staff
  patient_id          uuid        NOT NULL,
  label               text        NOT NULL,
  address_text        text        NOT NULL,    -- P2
  landmark            text,                    -- P2
  municipality        text,                    -- P2
  ward_no             integer,                 -- P2
  district            text,                    -- P2
  latitude            numeric(9,6),            -- P2 (staff-entered only in v1)
  longitude           numeric(9,6),            -- P2
  contact_phone_e164  text,                    -- P2
  version             integer     NOT NULL DEFAULT 1,
  is_active           boolean     NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid        NOT NULL,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          uuid        NOT NULL,
  CONSTRAINT addresses__pk PRIMARY KEY (id),
  CONSTRAINT addresses__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT addresses__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT addresses__account__fk FOREIGN KEY (tenant_id, account_id) REFERENCES engagement.accounts (tenant_id, id),
  CONSTRAINT addresses__patient__fk FOREIGN KEY (tenant_id, patient_id) REFERENCES frontdesk.patients (tenant_id, id),
  CONSTRAINT addresses__label__ck CHECK (label IN ('home','work','other')),
  CONSTRAINT addresses__lengths__ck CHECK (char_length(address_text) BETWEEN 1 AND 300
             AND (landmark IS NULL OR char_length(landmark) <= 120) AND (municipality IS NULL OR char_length(municipality) <= 80)
             AND (district IS NULL OR char_length(district) <= 60)),
  CONSTRAINT addresses__ward__ck CHECK (ward_no IS NULL OR ward_no BETWEEN 1 AND 99),
  CONSTRAINT addresses__geo__ck CHECK ((latitude IS NULL) = (longitude IS NULL)
             AND (latitude IS NULL OR (latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180))),
  CONSTRAINT addresses__phone__ck CHECK (contact_phone_e164 IS NULL OR contact_phone_e164 ~ '^\+[1-9][0-9]{7,14}$')
);
CREATE INDEX addresses__tenant_id_account_id__p_idx ON engagement.addresses (tenant_id, account_id) WHERE is_active;
CREATE INDEX addresses__tenant_id_patient_id__idx ON engagement.addresses (tenant_id, patient_id);

-- ---------- bookable_items (M) ----------
CREATE TABLE engagement.bookable_items (
  id                     uuid        NOT NULL,
  tenant_id              uuid        NOT NULL,
  orderable_id           uuid        NOT NULL,   -- P0 (catalog id)
  orderable_kind         text        NOT NULL,
  code                   text        NOT NULL,
  display_name           text        NOT NULL,
  indicative_price_paisa bigint,
  price_list_id          uuid,
  price_list_version     integer,
  sex_restriction        text,
  booking_kinds          text[]      NOT NULL,
  sort_order             integer     NOT NULL DEFAULT 1000,
  catalog_revision       integer,
  synced_at              timestamptz,
  version                integer     NOT NULL DEFAULT 1,
  is_active              boolean     NOT NULL DEFAULT true,
  created_at             timestamptz NOT NULL DEFAULT now(),
  created_by             uuid        NOT NULL,
  updated_at             timestamptz NOT NULL DEFAULT now(),
  updated_by             uuid        NOT NULL,
  CONSTRAINT bookable_items__pk PRIMARY KEY (id),
  CONSTRAINT bookable_items__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT bookable_items__tenant_id_orderable_id__uq UNIQUE (tenant_id, orderable_id),
  CONSTRAINT bookable_items__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT bookable_items__kind__ck CHECK (orderable_kind IN ('test','panel')),
  CONSTRAINT bookable_items__kinds__ck CHECK (cardinality(booking_kinds) BETWEEN 1 AND 2 AND booking_kinds <@ ARRAY['centre_visit','home_collection']::text[]),
  CONSTRAINT bookable_items__sex__ck CHECK (sex_restriction IS NULL OR sex_restriction IN ('male','female')),
  CONSTRAINT bookable_items__price__ck CHECK (indicative_price_paisa IS NULL OR indicative_price_paisa >= 0),
  CONSTRAINT bookable_items__lengths__ck CHECK (char_length(code) BETWEEN 1 AND 64 AND char_length(display_name) BETWEEN 1 AND 200),
  CONSTRAINT bookable_items__sort__ck CHECK (sort_order BETWEEN 0 AND 9999)
);
CREATE INDEX bookable_items__tenant_id_active_sort__p_idx ON engagement.bookable_items (tenant_id, sort_order, display_name) WHERE is_active;

-- ---------- booking_centres (E, projection; 08 A19 D-119) ----------
-- Written only by the system actor in task engagement.sync_booking_centres (nightly per_tenant, and enqueued on slot-template save;
-- TRD §8). Source: ctx.core.centres.list / ctx.core.centre in system context. Patient handlers read centre names, branch and
-- address only from this table (no ctx.core call in patient context, 02-CV §8.5 item 1). All centres of the tenant are synced
-- [CONV: so that order/booking DTOs can name any centre]; a centre that disappears or is deactivated in core gets is_active = false.
CREATE TABLE engagement.booking_centres (
  id            uuid        NOT NULL,
  tenant_id     uuid        NOT NULL,
  centre_id     uuid        NOT NULL,
  branch_id     uuid        NOT NULL,
  display_name  text        NOT NULL,      -- P0
  address_text  text,                      -- P0 (business address of the centre)
  is_active     boolean     NOT NULL DEFAULT true,
  synced_at     timestamptz NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid        NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid        NOT NULL,
  CONSTRAINT booking_centres__pk PRIMARY KEY (id),
  CONSTRAINT booking_centres__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT booking_centres__tenant_id_centre_id__uq UNIQUE (tenant_id, centre_id),
  CONSTRAINT booking_centres__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT booking_centres__centre__fk FOREIGN KEY (tenant_id, centre_id) REFERENCES core.collection_centres (tenant_id, id),
  CONSTRAINT booking_centres__branch__fk FOREIGN KEY (tenant_id, branch_id) REFERENCES core.branches (tenant_id, id),
  CONSTRAINT booking_centres__lengths__ck CHECK (char_length(display_name) BETWEEN 1 AND 200   -- [CONV]
             AND (address_text IS NULL OR char_length(address_text) <= 300))                  -- C2 address limit (03-IC §13.5 note)
);

-- ---------- slot_templates (M) ----------
CREATE TABLE engagement.slot_templates (
  id              uuid        NOT NULL,
  tenant_id       uuid        NOT NULL,
  centre_id       uuid        NOT NULL,
  booking_kind    text        NOT NULL,
  weekdays        smallint[]  NOT NULL,      -- ISO 1=Mon … 7=Sun
  start_local     time        NOT NULL,
  end_local       time        NOT NULL,
  slot_minutes    integer     NOT NULL,
  capacity        integer     NOT NULL,
  effective_from  date        NOT NULL,
  effective_to    date,
  version         integer     NOT NULL DEFAULT 1,
  is_active       boolean     NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid        NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid        NOT NULL,
  CONSTRAINT slot_templates__pk PRIMARY KEY (id),
  CONSTRAINT slot_templates__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT slot_templates__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT slot_templates__centre__fk FOREIGN KEY (tenant_id, centre_id) REFERENCES core.collection_centres (tenant_id, id),
  CONSTRAINT slot_templates__kind__ck CHECK (booking_kind IN ('centre_visit','home_collection')),
  CONSTRAINT slot_templates__weekdays__ck CHECK (cardinality(weekdays) BETWEEN 1 AND 7 AND weekdays <@ ARRAY[1,2,3,4,5,6,7]::smallint[]),
  CONSTRAINT slot_templates__times__ck CHECK (end_local > start_local),
  CONSTRAINT slot_templates__minutes__ck CHECK (slot_minutes BETWEEN 5 AND 240 AND slot_minutes % 5 = 0),
  CONSTRAINT slot_templates__capacity__ck CHECK (capacity BETWEEN 1 AND 100),
  CONSTRAINT slot_templates__dates__ck CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
-- overlap of active templates (same centre+kind, shared weekday, overlapping times, overlapping dates) is checked in slot.service
-- (array/time-range exclusion needs btree_gist, not assumed present in the pinned image)
CREATE INDEX slot_templates__tenant_id_centre_kind__p_idx ON engagement.slot_templates (tenant_id, centre_id, booking_kind) WHERE is_active;

-- ---------- slot_blackouts (M) ----------
CREATE TABLE engagement.slot_blackouts (
  id            uuid        NOT NULL,
  tenant_id     uuid        NOT NULL,
  centre_id     uuid        NOT NULL,
  booking_kind  text,                         -- NULL = all kinds
  starts_at     timestamptz NOT NULL,
  ends_at       timestamptz NOT NULL,
  reason_code   text        NOT NULL,
  note          text,                         -- P0 (UI warns: no patient data)
  version       integer     NOT NULL DEFAULT 1,
  is_active     boolean     NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid        NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid        NOT NULL,
  CONSTRAINT slot_blackouts__pk PRIMARY KEY (id),
  CONSTRAINT slot_blackouts__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT slot_blackouts__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT slot_blackouts__centre__fk FOREIGN KEY (tenant_id, centre_id) REFERENCES core.collection_centres (tenant_id, id),
  CONSTRAINT slot_blackouts__kind__ck CHECK (booking_kind IS NULL OR booking_kind IN ('centre_visit','home_collection')),
  CONSTRAINT slot_blackouts__range__ck CHECK (ends_at > starts_at AND ends_at <= starts_at + interval '31 days'),
  CONSTRAINT slot_blackouts__reason__ck CHECK (reason_code IN ('holiday','maintenance','other')),
  CONSTRAINT slot_blackouts__note__ck CHECK (note IS NULL OR char_length(note) <= 200)
);
CREATE INDEX slot_blackouts__tenant_id_centre_starts__p_idx ON engagement.slot_blackouts (tenant_id, centre_id, starts_at) WHERE is_active;

-- ---------- slot_occupancy (M counter) ----------
CREATE TABLE engagement.slot_occupancy (
  id            uuid        NOT NULL,
  tenant_id     uuid        NOT NULL,
  centre_id     uuid        NOT NULL,
  booking_kind  text        NOT NULL,
  slot_start    timestamptz NOT NULL,
  slot_end      timestamptz NOT NULL,
  template_id   uuid        NOT NULL,
  capacity      integer     NOT NULL,
  booked        integer     NOT NULL DEFAULT 0,
  version       integer     NOT NULL DEFAULT 1,
  is_active     boolean     NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid        NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid        NOT NULL,
  CONSTRAINT slot_occupancy__pk PRIMARY KEY (id),
  CONSTRAINT slot_occupancy__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT slot_occupancy__slot__uq UNIQUE (tenant_id, centre_id, booking_kind, slot_start),
  CONSTRAINT slot_occupancy__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT slot_occupancy__centre__fk FOREIGN KEY (tenant_id, centre_id) REFERENCES core.collection_centres (tenant_id, id),
  CONSTRAINT slot_occupancy__template__fk FOREIGN KEY (tenant_id, template_id) REFERENCES engagement.slot_templates (tenant_id, id),
  CONSTRAINT slot_occupancy__kind__ck CHECK (booking_kind IN ('centre_visit','home_collection')),
  CONSTRAINT slot_occupancy__booked__ck CHECK (booked >= 0),
  CONSTRAINT slot_occupancy__capacity__ck CHECK (capacity BETWEEN 1 AND 100),
  CONSTRAINT slot_occupancy__range__ck CHECK (slot_end > slot_start)
);
-- patient actors may change only booked/version/updated_* (guard trigger, §4)

-- ---------- bookings (C) ----------
CREATE TABLE engagement.bookings (
  id                 uuid        NOT NULL,
  tenant_id          uuid        NOT NULL,
  booking_no         text        NOT NULL,     -- P2 (lab-linked identifier; never in URLs/logs)
  account_id         uuid,                     -- P1; NULL for staff bookings
  patient_id         uuid        NOT NULL,     -- P1
  link_id            uuid,                     -- profile used (app bookings)
  created_via        text        NOT NULL,
  booking_kind       text        NOT NULL,
  branch_id          uuid        NOT NULL,
  centre_id          uuid        NOT NULL,
  slot_occupancy_id  uuid        NOT NULL,
  slot_start         timestamptz NOT NULL,
  slot_end           timestamptz NOT NULL,
  home_address_id    uuid,
  status             text        NOT NULL DEFAULT 'confirmed',
  order_id           uuid,                     -- from frontdesk.v_pub_order_status (no FK)
  queue_token_id     uuid,
  confirmed_at       timestamptz NOT NULL,
  checked_in_at      timestamptz,
  completed_at       timestamptz,
  cancelled_at       timestamptz,
  cancel_reason_code text,
  cancelled_by_kind  text,
  replaces_booking_id uuid,
  version            integer     NOT NULL DEFAULT 1,
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid        NOT NULL,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         uuid        NOT NULL,
  CONSTRAINT bookings__pk PRIMARY KEY (id),
  CONSTRAINT bookings__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT bookings__tenant_id_booking_no__uq UNIQUE (tenant_id, booking_no),
  CONSTRAINT bookings__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT bookings__account__fk FOREIGN KEY (tenant_id, account_id) REFERENCES engagement.accounts (tenant_id, id),
  CONSTRAINT bookings__patient__fk FOREIGN KEY (tenant_id, patient_id) REFERENCES frontdesk.patients (tenant_id, id),
  CONSTRAINT bookings__link__fk FOREIGN KEY (tenant_id, link_id) REFERENCES engagement.account_patient_links (tenant_id, id),
  CONSTRAINT bookings__branch__fk FOREIGN KEY (tenant_id, branch_id) REFERENCES core.branches (tenant_id, id),
  CONSTRAINT bookings__centre__fk FOREIGN KEY (tenant_id, centre_id) REFERENCES core.collection_centres (tenant_id, id),
  CONSTRAINT bookings__occupancy__fk FOREIGN KEY (tenant_id, slot_occupancy_id) REFERENCES engagement.slot_occupancy (tenant_id, id),
  CONSTRAINT bookings__address__fk FOREIGN KEY (tenant_id, home_address_id) REFERENCES engagement.addresses (tenant_id, id),
  CONSTRAINT bookings__replaces__fk FOREIGN KEY (tenant_id, replaces_booking_id) REFERENCES engagement.bookings (tenant_id, id),
  CONSTRAINT bookings__no__ck CHECK (booking_no ~ '^[A-Z0-9]{4,20}$'),
  CONSTRAINT bookings__via__ck CHECK (created_via IN ('app','staff')),
  CONSTRAINT bookings__via_account__ck CHECK ((created_via = 'app') = (account_id IS NOT NULL AND link_id IS NOT NULL)),
  CONSTRAINT bookings__kind__ck CHECK (booking_kind IN ('centre_visit','home_collection')),
  CONSTRAINT bookings__address_kind__ck CHECK ((booking_kind = 'home_collection') = (home_address_id IS NOT NULL)),
  CONSTRAINT bookings__status__ck CHECK (status IN ('confirmed','checked_in','completed','cancelled')),
  CONSTRAINT bookings__cancel__ck CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL AND cancel_reason_code IS NOT NULL AND cancelled_by_kind IS NOT NULL)),
  CONSTRAINT bookings__cancel_by__ck CHECK (cancelled_by_kind IS NULL OR cancelled_by_kind IN ('patient','staff','system')),
  CONSTRAINT bookings__range__ck CHECK (slot_end > slot_start)
);
CREATE TRIGGER bookings__mutable_columns BEFORE UPDATE ON engagement.bookings
  FOR EACH ROW EXECUTE FUNCTION app.enforce_mutable_columns(
    'status','order_id','queue_token_id','checked_in_at','completed_at','cancelled_at','cancel_reason_code',
    'cancelled_by_kind','updated_at','updated_by','version');
CREATE INDEX bookings__tenant_id_centre_slot__idx ON engagement.bookings (tenant_id, centre_id, slot_start, id);     -- S1
CREATE INDEX bookings__tenant_id_account_slot__p_idx ON engagement.bookings (tenant_id, account_id, slot_start DESC) WHERE account_id IS NOT NULL; -- E34
CREATE INDEX bookings__tenant_id_patient_status__idx ON engagement.bookings (tenant_id, patient_id, status, slot_start);  -- limits
CREATE INDEX bookings__tenant_id_open_slot__p_idx ON engagement.bookings (tenant_id, slot_start) WHERE status IN ('confirmed','checked_in'); -- reconcile / no-show
CREATE INDEX bookings__tenant_id_account_created__p_idx ON engagement.bookings (tenant_id, account_id, created_at) WHERE account_id IS NOT NULL; -- daily cap

-- ---------- booking_items (A) ----------
CREATE TABLE engagement.booking_items (
  id                     uuid        NOT NULL,
  tenant_id              uuid        NOT NULL,
  booking_id             uuid        NOT NULL,
  account_id             uuid,                 -- denormalised for RLS
  centre_id              uuid        NOT NULL,  -- denormalised for RLS
  orderable_id           uuid        NOT NULL,  -- P3 together with the booking's patient (03-IC §3.22 class)
  orderable_kind         text        NOT NULL,
  display_name_snapshot  text        NOT NULL,
  indicative_price_paisa bigint,
  sort_order             integer     NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  created_by             uuid        NOT NULL,
  CONSTRAINT booking_items__pk PRIMARY KEY (id),
  CONSTRAINT booking_items__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT booking_items__booking_orderable__uq UNIQUE (tenant_id, booking_id, orderable_id),
  CONSTRAINT booking_items__booking__fk FOREIGN KEY (tenant_id, booking_id) REFERENCES engagement.bookings (tenant_id, id),
  CONSTRAINT booking_items__kind__ck CHECK (orderable_kind IN ('test','panel')),
  CONSTRAINT booking_items__price__ck CHECK (indicative_price_paisa IS NULL OR indicative_price_paisa >= 0),
  CONSTRAINT booking_items__name__ck CHECK (char_length(display_name_snapshot) BETWEEN 1 AND 200)
);

-- ---------- booking_transitions (A) ----------
CREATE TABLE engagement.booking_transitions (
  id           uuid        NOT NULL,
  tenant_id    uuid        NOT NULL,
  booking_id   uuid        NOT NULL,
  account_id   uuid,
  centre_id    uuid        NOT NULL,
  from_status  text,
  to_status    text        NOT NULL,
  reason_code  text,
  actor_type   text        NOT NULL,
  actor_id     uuid        NOT NULL,
  occurred_at  timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid        NOT NULL,
  CONSTRAINT booking_transitions__pk PRIMARY KEY (id),
  CONSTRAINT booking_transitions__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT booking_transitions__booking__fk FOREIGN KEY (tenant_id, booking_id) REFERENCES engagement.bookings (tenant_id, id),
  CONSTRAINT booking_transitions__status__ck CHECK (to_status IN ('confirmed','checked_in','completed','cancelled')
             AND (from_status IS NULL OR from_status IN ('confirmed','checked_in','completed','cancelled'))),
  CONSTRAINT booking_transitions__actor__ck CHECK (actor_type IN ('user','system','patient'))
);
CREATE INDEX booking_transitions__tenant_id_booking__idx ON engagement.booking_transitions (tenant_id, booking_id, occurred_at);

-- ---------- read models ----------
CREATE TABLE engagement.patient_orders (
  tenant_id          uuid        NOT NULL,
  order_id           uuid        NOT NULL,     -- P1
  patient_id         uuid        NOT NULL,     -- P1
  centre_id          uuid        NOT NULL,
  branch_id          uuid        NOT NULL,
  source             text        NOT NULL,
  booking_id         uuid,
  order_status       text        NOT NULL,
  registered_at      timestamptz,              -- NULL for pre_registered
  visible_at         timestamptz NOT NULL,     -- registered_at, or booking slot_start for pre_registered (visibility anchor)
  stage              text        NOT NULL,
  payment_due        boolean     NOT NULL DEFAULT false,
  invoiced_paisa     bigint,
  paid_paisa         bigint,
  balance_due_paisa  bigint,
  balance_version    integer,
  release_basis      text,
  status_version     integer     NOT NULL DEFAULT 1,   -- bumps on any change (ETag)
  synced_at          timestamptz NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid        NOT NULL,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         uuid        NOT NULL,
  CONSTRAINT patient_orders__pk PRIMARY KEY (tenant_id, order_id),
  CONSTRAINT patient_orders__patient__fk FOREIGN KEY (tenant_id, patient_id) REFERENCES frontdesk.patients (tenant_id, id),
  CONSTRAINT patient_orders__source__ck CHECK (source IN ('front_desk','engagement_booking','home_collection','partner_manifest')),
  CONSTRAINT patient_orders__status__ck CHECK (order_status IN ('pre_registered','registered','in_progress','completed','cancelled')),
  CONSTRAINT patient_orders__stage__ck CHECK (stage IN ('registered','sample_collected','in_lab','partial_report','report_ready','recollection_needed','cancelled')),
  CONSTRAINT patient_orders__basis__ck CHECK (release_basis IS NULL OR release_basis IN ('paid_in_full','zero_balance','credit_party','override','policy_not_enforced','due_outstanding','no_invoice'))
);
CREATE INDEX patient_orders__tenant_id_patient_visible__idx ON engagement.patient_orders (tenant_id, patient_id, visible_at DESC, order_id);

CREATE TABLE engagement.patient_order_specimens (
  tenant_id              uuid        NOT NULL,
  specimen_id            uuid        NOT NULL,     -- P1
  order_id               uuid        NOT NULL,
  patient_id             uuid        NOT NULL,
  specimen_type_code     text        NOT NULL,     -- P0 code; not sent to the app
  status                 text        NOT NULL,
  status_seq             integer     NOT NULL,
  ordinal                integer     NOT NULL,     -- "Sample n" in the app
  collected_at           timestamptz,
  received_at            timestamptz,
  rejected_at            timestamptz,
  rejection_reason_code  text,                     -- P1; never sent to the app
  recollection_required  boolean     NOT NULL DEFAULT false,
  replaces_specimen_id   uuid,
  created_at             timestamptz NOT NULL DEFAULT now(),
  created_by             uuid        NOT NULL,
  updated_at             timestamptz NOT NULL DEFAULT now(),
  updated_by             uuid        NOT NULL,
  CONSTRAINT patient_order_specimens__pk PRIMARY KEY (tenant_id, specimen_id),
  CONSTRAINT patient_order_specimens__order__fk FOREIGN KEY (tenant_id, order_id) REFERENCES engagement.patient_orders (tenant_id, order_id) ON DELETE CASCADE,
  CONSTRAINT patient_order_specimens__status__ck CHECK (status IN ('ordered','collected','in_transit','received','aliquoted','in_process',
             'resulted','verified','approved','reported','rejected','recollection_ordered','stored','discarded')),
  CONSTRAINT patient_order_specimens__seq__ck CHECK (status_seq >= 0)   -- 0 = backfilled before the D-106 view column exists (any event wins); else = specimen version (08 A19 D-106)
);
CREATE INDEX patient_order_specimens__tenant_id_order__idx ON engagement.patient_order_specimens (tenant_id, order_id);

CREATE TABLE engagement.patient_reports (
  tenant_id               uuid        NOT NULL,
  report_id               uuid        NOT NULL,
  version_no              integer     NOT NULL,
  order_id                uuid        NOT NULL,
  patient_id              uuid        NOT NULL,
  report_kind             text        NOT NULL,
  status                  text        NOT NULL,
  released_at             timestamptz NOT NULL,
  supersedes_version_no   integer,
  panel_names             text[]      NOT NULL DEFAULT '{}',   -- P3
  smart_summary_available boolean     NOT NULL DEFAULT false,
  created_at              timestamptz NOT NULL DEFAULT now(),
  created_by              uuid        NOT NULL,
  updated_at              timestamptz NOT NULL DEFAULT now(),
  updated_by              uuid        NOT NULL,
  CONSTRAINT patient_reports__pk PRIMARY KEY (tenant_id, report_id, version_no),
  CONSTRAINT patient_reports__patient__fk FOREIGN KEY (tenant_id, patient_id) REFERENCES frontdesk.patients (tenant_id, id),
  CONSTRAINT patient_reports__kind__ck CHECK (char_length(report_kind) BETWEEN 1 AND 32),   -- x-extensible (03-IC §3.17; 08 A13 P-4): known final|partial|preliminary|amended|addendum; unknown kinds stored as-is (TRD §4.5)
  CONSTRAINT patient_reports__status__ck CHECK (status IN ('valid','superseded')),
  CONSTRAINT patient_reports__version__ck CHECK (version_no >= 1),
  CONSTRAINT patient_reports__panels__ck CHECK (cardinality(panel_names) <= 20)
);
CREATE INDEX patient_reports__tenant_id_patient_released__idx ON engagement.patient_reports (tenant_id, patient_id, released_at DESC, report_id);
CREATE INDEX patient_reports__tenant_id_order__idx ON engagement.patient_reports (tenant_id, order_id);

CREATE TABLE engagement.smart_summaries (
  id                        uuid        NOT NULL,
  tenant_id                 uuid        NOT NULL,
  order_id                  uuid        NOT NULL,
  report_id                 uuid        NOT NULL,
  report_version_no         integer     NOT NULL,
  patient_id                uuid        NOT NULL,
  summary                   jsonb       NOT NULL,    -- P3: approved SmartSummary snapshot from the C6 report version via ReportingPort (08 A2.3), minus ids not exposed
  template_library_version  text        NOT NULL,
  approved_at               timestamptz NOT NULL,
  fetched_at                timestamptz NOT NULL,
  created_at                timestamptz NOT NULL DEFAULT now(),
  created_by                uuid        NOT NULL,
  CONSTRAINT smart_summaries__pk PRIMARY KEY (id),
  CONSTRAINT smart_summaries__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT smart_summaries__report__uq UNIQUE (tenant_id, report_id, report_version_no),
  CONSTRAINT smart_summaries__report__fk FOREIGN KEY (tenant_id, report_id, report_version_no) REFERENCES engagement.patient_reports (tenant_id, report_id, version_no) ON DELETE CASCADE,
  CONSTRAINT smart_summaries__size__ck CHECK (pg_column_size(summary) <= 262144)
);

-- ---------- notifications (E) ----------
CREATE TABLE engagement.notifications (
  id           uuid        NOT NULL,
  tenant_id    uuid        NOT NULL,
  account_id   uuid        NOT NULL,
  patient_id   uuid,
  kind         text        NOT NULL,
  entity_type  text,
  entity_id    uuid,
  entity_seq   integer     NOT NULL DEFAULT 0,   -- e.g. report version_no, so v2 gets its own notification
  route_id     text,
  read_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid        NOT NULL,
  expires_at   timestamptz NOT NULL,
  CONSTRAINT notifications__pk PRIMARY KEY (id),
  CONSTRAINT notifications__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT notifications__dedupe__uq UNIQUE NULLS NOT DISTINCT (tenant_id, account_id, kind, entity_id, entity_seq),   -- PG 15+ (04 D9: PG 17)
  CONSTRAINT notifications__account__fk FOREIGN KEY (tenant_id, account_id) REFERENCES engagement.accounts (tenant_id, id),
  CONSTRAINT notifications__kind__ck CHECK (kind IN ('report_ready','sample_recollection','booking_confirmed','booking_cancelled',
             'booking_reminder','payment_completed','follow_up_reminder','enquiry_reply','profile_paused')),
  CONSTRAINT notifications__entity__ck CHECK (entity_type IS NULL OR entity_type IN ('order','report','booking','enquiry','reminder','profile')),
  CONSTRAINT notifications__route__ck CHECK (route_id IS NULL OR route_id IN ('patient_app.report','patient_app.order','patient_app.booking'))
);
CREATE INDEX notifications__tenant_id_account_created__idx ON engagement.notifications (tenant_id, account_id, created_at DESC, id);
CREATE INDEX notifications__tenant_id_expires_at__idx ON engagement.notifications (tenant_id, expires_at);   -- purge (per_tenant task, P-18(c))

-- ---------- payment_requests (M status) ----------
CREATE TABLE engagement.payment_requests (
  id               uuid        NOT NULL,
  tenant_id        uuid        NOT NULL,
  account_id       uuid        NOT NULL,
  order_id         uuid        NOT NULL,     -- P1
  patient_id       uuid        NOT NULL,
  gateway          text        NOT NULL,
  status           text        NOT NULL DEFAULT 'queued',
  review           boolean     NOT NULL DEFAULT false,
  intent_id        uuid,
  amount_paisa     bigint,
  action_json      jsonb,                    -- secret-bearing URL; scrubbed when leaving 'ready'
  failure_code     text,
  idempotency_key  text        NOT NULL,
  expires_at       timestamptz,
  version          integer     NOT NULL DEFAULT 1,
  is_active        boolean     NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid        NOT NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid        NOT NULL,
  CONSTRAINT payment_requests__pk PRIMARY KEY (id),
  CONSTRAINT payment_requests__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT payment_requests__account__fk FOREIGN KEY (tenant_id, account_id) REFERENCES engagement.accounts (tenant_id, id),
  CONSTRAINT payment_requests__gateway__ck CHECK (gateway IN ('esewa','khalti')),
  CONSTRAINT payment_requests__status__ck CHECK (status IN ('queued','ready','completed','failed','expired')),
  CONSTRAINT payment_requests__action__ck CHECK (status = 'ready' OR action_json IS NULL),
  CONSTRAINT payment_requests__ready__ck CHECK (status <> 'ready' OR (intent_id IS NOT NULL AND amount_paisa IS NOT NULL)),
  CONSTRAINT payment_requests__failure__ck CHECK (failure_code IS NULL OR char_length(failure_code) <= 64),
  CONSTRAINT payment_requests__amount__ck CHECK (amount_paisa IS NULL OR amount_paisa > 0)
);
CREATE UNIQUE INDEX payment_requests__tenant_id_order_open__p_uq ON engagement.payment_requests (tenant_id, order_id) WHERE status IN ('queued','ready');
CREATE INDEX payment_requests__tenant_id_ready_expires__p_idx ON engagement.payment_requests (tenant_id, expires_at) WHERE status = 'ready';

-- ---------- queue ----------
CREATE TABLE engagement.queue_definitions (
  id             uuid        NOT NULL,
  tenant_id      uuid        NOT NULL,
  centre_id      uuid        NOT NULL,
  code           text        NOT NULL,
  display_name   text        NOT NULL,
  token_prefix   text        NOT NULL,
  sort_order     integer     NOT NULL DEFAULT 0,
  board_version  bigint      NOT NULL DEFAULT 1,
  version        integer     NOT NULL DEFAULT 1,
  is_active      boolean     NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid        NOT NULL,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid        NOT NULL,
  CONSTRAINT queue_definitions__pk PRIMARY KEY (id),
  CONSTRAINT queue_definitions__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT queue_definitions__tenant_id_centre_code__uq UNIQUE (tenant_id, centre_id, code),
  CONSTRAINT queue_definitions__centre__fk FOREIGN KEY (tenant_id, centre_id) REFERENCES core.collection_centres (tenant_id, id),
  CONSTRAINT queue_definitions__code__ck CHECK (code ~ '^[a-z0-9_]{1,32}$'),
  CONSTRAINT queue_definitions__prefix__ck CHECK (token_prefix ~ '^[A-Z]{1,2}$'),
  CONSTRAINT queue_definitions__name__ck CHECK (char_length(display_name) BETWEEN 1 AND 60),
  CONSTRAINT queue_definitions__sort__ck CHECK (sort_order BETWEEN 0 AND 999)
);

CREATE TABLE engagement.queue_counters (
  id            uuid        NOT NULL,
  tenant_id     uuid        NOT NULL,
  centre_id     uuid        NOT NULL,
  display_name  text        NOT NULL,
  sort_order    integer     NOT NULL DEFAULT 0,
  version       integer     NOT NULL DEFAULT 1,
  is_active     boolean     NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid        NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid        NOT NULL,
  CONSTRAINT queue_counters__pk PRIMARY KEY (id),
  CONSTRAINT queue_counters__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT queue_counters__tenant_id_centre_name__uq UNIQUE (tenant_id, centre_id, display_name),
  CONSTRAINT queue_counters__centre__fk FOREIGN KEY (tenant_id, centre_id) REFERENCES core.collection_centres (tenant_id, id),
  CONSTRAINT queue_counters__name__ck CHECK (char_length(display_name) BETWEEN 1 AND 40)
);

CREATE TABLE engagement.queue_day_counters (
  tenant_id      uuid        NOT NULL,
  queue_id       uuid        NOT NULL,
  centre_id      uuid        NOT NULL,
  business_date  date        NOT NULL,
  last_seq       integer     NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid        NOT NULL,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT queue_day_counters__pk PRIMARY KEY (tenant_id, queue_id, business_date),
  CONSTRAINT queue_day_counters__queue__fk FOREIGN KEY (tenant_id, queue_id) REFERENCES engagement.queue_definitions (tenant_id, id),
  CONSTRAINT queue_day_counters__seq__ck CHECK (last_seq BETWEEN 0 AND 9999)
);

CREATE TABLE engagement.queue_tokens (
  id                         uuid        NOT NULL,
  tenant_id                  uuid        NOT NULL,
  centre_id                  uuid        NOT NULL,
  queue_id                   uuid        NOT NULL,
  business_date              date        NOT NULL,
  seq                        integer     NOT NULL,
  token_label                text        NOT NULL,     -- P0
  priority                   text        NOT NULL DEFAULT 'normal',
  status                     text        NOT NULL DEFAULT 'waiting',
  booking_id                 uuid,                     -- P1
  counter_id                 uuid,
  issued_at                  timestamptz NOT NULL,
  called_at                  timestamptz,
  call_count                 integer     NOT NULL DEFAULT 0,
  serving_started_at         timestamptz,
  completed_at               timestamptz,
  transferred_to_token_id    uuid,
  transferred_from_token_id  uuid,
  version                    integer     NOT NULL DEFAULT 1,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  created_by                 uuid        NOT NULL,
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  updated_by                 uuid        NOT NULL,
  CONSTRAINT queue_tokens__pk PRIMARY KEY (id),
  CONSTRAINT queue_tokens__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT queue_tokens__seq__uq UNIQUE (tenant_id, queue_id, business_date, seq),
  CONSTRAINT queue_tokens__queue__fk FOREIGN KEY (tenant_id, queue_id) REFERENCES engagement.queue_definitions (tenant_id, id),
  CONSTRAINT queue_tokens__centre__fk FOREIGN KEY (tenant_id, centre_id) REFERENCES core.collection_centres (tenant_id, id),
  CONSTRAINT queue_tokens__counter__fk FOREIGN KEY (tenant_id, counter_id) REFERENCES engagement.queue_counters (tenant_id, id),
  CONSTRAINT queue_tokens__booking__fk FOREIGN KEY (tenant_id, booking_id) REFERENCES engagement.bookings (tenant_id, id),
  CONSTRAINT queue_tokens__to__fk FOREIGN KEY (tenant_id, transferred_to_token_id) REFERENCES engagement.queue_tokens (tenant_id, id),
  CONSTRAINT queue_tokens__from__fk FOREIGN KEY (tenant_id, transferred_from_token_id) REFERENCES engagement.queue_tokens (tenant_id, id),
  CONSTRAINT queue_tokens__priority__ck CHECK (priority IN ('normal','priority')),
  CONSTRAINT queue_tokens__status__ck CHECK (status IN ('waiting','called','serving','completed','skipped','cancelled','transferred','expired')),
  CONSTRAINT queue_tokens__label__ck CHECK (token_label ~ '^[A-Z]{1,2}-[0-9]{3,4}$'),
  CONSTRAINT queue_tokens__calls__ck CHECK (call_count BETWEEN 0 AND 9),
  CONSTRAINT queue_tokens__transfer__ck CHECK ((status = 'transferred') = (transferred_to_token_id IS NOT NULL))
);
CREATE TRIGGER queue_tokens__mutable_columns BEFORE UPDATE ON engagement.queue_tokens
  FOR EACH ROW EXECUTE FUNCTION app.enforce_mutable_columns(
    'status','counter_id','called_at','call_count','serving_started_at','completed_at','transferred_to_token_id',
    'updated_at','updated_by','version');
CREATE INDEX queue_tokens__tenant_id_queue_waiting__p_idx ON engagement.queue_tokens (tenant_id, queue_id, business_date, priority DESC, issued_at, id)
  WHERE status = 'waiting';                                                    -- call next
CREATE INDEX queue_tokens__tenant_id_centre_called__p_idx ON engagement.queue_tokens (tenant_id, centre_id, called_at DESC)
  WHERE status IN ('called','serving');                                        -- board
CREATE INDEX queue_tokens__tenant_id_centre_date__idx ON engagement.queue_tokens (tenant_id, centre_id, business_date, issued_at);  -- Q4, stats

CREATE TABLE engagement.queue_displays (
  id            uuid        NOT NULL,
  tenant_id     uuid        NOT NULL,
  centre_id     uuid        NOT NULL,
  display_name  text        NOT NULL,
  queue_ids     uuid[]      NOT NULL,
  token_sha256  bytea       NOT NULL,      -- 32-byte SHA-256 of the display credential (08 R24)
  status        text        NOT NULL DEFAULT 'active',
  paired_at     timestamptz NOT NULL,
  paired_by     uuid        NOT NULL,
  last_seen_at  timestamptz,
  revoked_at    timestamptz,
  revoked_by    uuid,
  version       integer     NOT NULL DEFAULT 1,
  is_active     boolean     NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid        NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid        NOT NULL,
  CONSTRAINT queue_displays__pk PRIMARY KEY (id),
  CONSTRAINT queue_displays__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT queue_displays__token__uq UNIQUE (token_sha256),                 -- CR-C16-006 exception (pre-tenant lookup)
  CONSTRAINT queue_displays__centre__fk FOREIGN KEY (tenant_id, centre_id) REFERENCES core.collection_centres (tenant_id, id),
  CONSTRAINT queue_displays__status__ck CHECK (status IN ('active','revoked')),
  CONSTRAINT queue_displays__revoked__ck CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),
  CONSTRAINT queue_displays__queues__ck CHECK (cardinality(queue_ids) BETWEEN 1 AND 10),
  CONSTRAINT queue_displays__token__ck CHECK (octet_length(token_sha256) = 32),
  CONSTRAINT queue_displays__name__ck CHECK (char_length(display_name) BETWEEN 1 AND 40)
);
CREATE INDEX queue_displays__tenant_id_centre__idx ON engagement.queue_displays (tenant_id, centre_id, status);
-- device actors may change only last_seen_at/updated_at (guard trigger, §4)

-- ---------- reminders (M status) ----------
CREATE TABLE engagement.reminders (
  id              uuid        NOT NULL,
  tenant_id       uuid        NOT NULL,
  patient_id      uuid        NOT NULL,     -- P1
  kind            text        NOT NULL,
  reason_code     text,
  source          text        NOT NULL,
  source_ref_id   uuid,                     -- booking id / smart summary id
  source_ref_seq  integer     NOT NULL DEFAULT 0,   -- follow-up index within a summary
  due_at          timestamptz NOT NULL,
  status          text        NOT NULL DEFAULT 'scheduled',
  sent_at         timestamptz,
  delivery_id     uuid,
  failure_code    text,
  version         integer     NOT NULL DEFAULT 1,
  is_active       boolean     NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid        NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid        NOT NULL,
  CONSTRAINT reminders__pk PRIMARY KEY (id),
  CONSTRAINT reminders__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT reminders__patient__fk FOREIGN KEY (tenant_id, patient_id) REFERENCES frontdesk.patients (tenant_id, id),
  CONSTRAINT reminders__kind__ck CHECK (kind IN ('custom','follow_up','booking')),
  CONSTRAINT reminders__source__ck CHECK (source IN ('staff','smart_report','booking')),
  CONSTRAINT reminders__status__ck CHECK (status IN ('scheduled','sent','suppressed','failed','cancelled')),
  CONSTRAINT reminders__sent__ck CHECK ((status = 'sent') = (sent_at IS NOT NULL)),
  CONSTRAINT reminders__reason__ck CHECK (kind = 'booking' OR reason_code IS NOT NULL),
  CONSTRAINT reminders__failure__ck CHECK (failure_code IS NULL OR char_length(failure_code) <= 64)
);
CREATE UNIQUE INDEX reminders__tenant_id_source_ref__p_uq ON engagement.reminders (tenant_id, kind, source_ref_id, source_ref_seq) WHERE source_ref_id IS NOT NULL;
CREATE INDEX reminders__tenant_id_due__p_idx ON engagement.reminders (tenant_id, due_at, id) WHERE status = 'scheduled';
CREATE INDEX reminders__tenant_id_patient__idx ON engagement.reminders (tenant_id, patient_id, due_at DESC);

-- ---------- memberships ----------
CREATE TABLE engagement.membership_plans (
  id             uuid        NOT NULL,
  tenant_id      uuid        NOT NULL,
  code           text        NOT NULL,
  display_name   text        NOT NULL,
  description    text,
  price_list_id  uuid        NOT NULL,     -- catalog price list (validated via CatalogPort.getPriceListStatus, 08 A24.1; no FK across modules' internals)
  validity_days  integer     NOT NULL,
  version        integer     NOT NULL DEFAULT 1,
  is_active      boolean     NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid        NOT NULL,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid        NOT NULL,
  CONSTRAINT membership_plans__pk PRIMARY KEY (id),
  CONSTRAINT membership_plans__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT membership_plans__tenant_id_code__uq UNIQUE (tenant_id, code),
  CONSTRAINT membership_plans__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT membership_plans__code__ck CHECK (code ~ '^[A-Z0-9_]{2,20}$'),
  CONSTRAINT membership_plans__name__ck CHECK (char_length(display_name) BETWEEN 1 AND 60 AND (description IS NULL OR char_length(description) <= 300)),
  CONSTRAINT membership_plans__validity__ck CHECK (validity_days BETWEEN 30 AND 1095)
);

CREATE TABLE engagement.patient_memberships (
  id                    uuid        NOT NULL,
  tenant_id             uuid        NOT NULL,
  patient_id            uuid        NOT NULL,     -- P1
  plan_id               uuid        NOT NULL,
  card_no               text        NOT NULL,     -- P2
  card_token            text        NOT NULL,     -- secret lookup (QR)
  status                text        NOT NULL DEFAULT 'active',
  valid_from            date        NOT NULL,
  valid_to              date        NOT NULL,
  enrolled_by           uuid        NOT NULL,
  enrolled_centre_id    uuid,
  cancelled_at          timestamptz,
  cancel_reason_code    text,
  version               integer     NOT NULL DEFAULT 1,
  is_active             boolean     NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by            uuid        NOT NULL,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  updated_by            uuid        NOT NULL,
  CONSTRAINT patient_memberships__pk PRIMARY KEY (id),
  CONSTRAINT patient_memberships__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT patient_memberships__tenant_id_card_no__uq UNIQUE (tenant_id, card_no),
  CONSTRAINT patient_memberships__tenant_id_card_token__uq UNIQUE (tenant_id, card_token),
  CONSTRAINT patient_memberships__patient__fk FOREIGN KEY (tenant_id, patient_id) REFERENCES frontdesk.patients (tenant_id, id),
  CONSTRAINT patient_memberships__plan__fk FOREIGN KEY (tenant_id, plan_id) REFERENCES engagement.membership_plans (tenant_id, id),
  CONSTRAINT patient_memberships__centre__fk FOREIGN KEY (tenant_id, enrolled_centre_id) REFERENCES core.collection_centres (tenant_id, id),
  CONSTRAINT patient_memberships__status__ck CHECK (status IN ('active','cancelled','expired')),
  CONSTRAINT patient_memberships__dates__ck CHECK (valid_to > valid_from),
  CONSTRAINT patient_memberships__cancel__ck CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL AND cancel_reason_code IS NOT NULL)),
  CONSTRAINT patient_memberships__cancel_reason__ck CHECK (cancel_reason_code IS NULL OR cancel_reason_code IN ('patient_request','staff_error','other')),
  CONSTRAINT patient_memberships__card__ck CHECK (card_no ~ '^MB[0-9]{8}$' AND card_token ~ '^[0-9A-HJKMNP-TV-Z]{26}$')
);
CREATE UNIQUE INDEX patient_memberships__tenant_id_patient_active__p_uq ON engagement.patient_memberships (tenant_id, patient_id) WHERE status = 'active';
CREATE INDEX patient_memberships__tenant_id_active_valid_to__p_idx ON engagement.patient_memberships (tenant_id, valid_to) WHERE status = 'active';

-- ---------- number_counters (M counter) ----------
CREATE TABLE engagement.number_counters (
  tenant_id    uuid        NOT NULL,
  counter_key  text        NOT NULL,      -- 'booking_no:<yy>', 'card_no:<yy>', 'otp_day:<yyyymmdd>' (tenant business date), 'linkfail:<account_id>:<yyyymmddhh>'
  last_value   bigint      NOT NULL DEFAULT 0,
  expires_at   timestamptz,               -- NULL for numbering keys; set for rate counters
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid        NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT number_counters__pk PRIMARY KEY (tenant_id, counter_key),
  CONSTRAINT number_counters__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT number_counters__key__ck CHECK (counter_key ~ '^(booking_no|card_no):[0-9]{2}$|^otp_day:[0-9]{8}$|^linkfail:[0-9a-f-]{36}:[0-9]{10}$'),
  CONSTRAINT number_counters__value__ck CHECK (last_value >= 0)
);

-- ---------- enquiries ----------
CREATE TABLE engagement.enquiries (
  id               uuid        NOT NULL,
  tenant_id        uuid        NOT NULL,
  account_id       uuid        NOT NULL,
  patient_id       uuid,
  category_code    text        NOT NULL,
  subject          text        NOT NULL,     -- P3 (free text)
  status           text        NOT NULL DEFAULT 'open',
  last_message_at  timestamptz NOT NULL,
  closed_at        timestamptz,
  version          integer     NOT NULL DEFAULT 1,
  is_active        boolean     NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid        NOT NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid        NOT NULL,
  CONSTRAINT enquiries__pk PRIMARY KEY (id),
  CONSTRAINT enquiries__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT enquiries__account__fk FOREIGN KEY (tenant_id, account_id) REFERENCES engagement.accounts (tenant_id, id),
  CONSTRAINT enquiries__patient__fk FOREIGN KEY (tenant_id, patient_id) REFERENCES frontdesk.patients (tenant_id, id),
  CONSTRAINT enquiries__status__ck CHECK (status IN ('open','answered','closed')),
  CONSTRAINT enquiries__closed__ck CHECK ((status = 'closed') = (closed_at IS NOT NULL)),
  CONSTRAINT enquiries__subject__ck CHECK (char_length(subject) BETWEEN 1 AND 120),
  CONSTRAINT enquiries__category__ck CHECK (char_length(category_code) BETWEEN 1 AND 64)
);
CREATE INDEX enquiries__tenant_id_status_last__idx ON engagement.enquiries (tenant_id, status, last_message_at DESC, id);
CREATE INDEX enquiries__tenant_id_account__idx ON engagement.enquiries (tenant_id, account_id, last_message_at DESC);

CREATE TABLE engagement.enquiry_messages (
  id           uuid        NOT NULL,
  tenant_id    uuid        NOT NULL,
  enquiry_id   uuid        NOT NULL,
  account_id   uuid        NOT NULL,      -- denormalised owner for RLS
  author_kind  text        NOT NULL,
  author_id    uuid        NOT NULL,      -- account id or membership id
  body         text        NOT NULL,      -- P3
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid        NOT NULL,
  CONSTRAINT enquiry_messages__pk PRIMARY KEY (id),
  CONSTRAINT enquiry_messages__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT enquiry_messages__enquiry__fk FOREIGN KEY (tenant_id, enquiry_id) REFERENCES engagement.enquiries (tenant_id, id),
  CONSTRAINT enquiry_messages__author__ck CHECK (author_kind IN ('patient','staff')),
  CONSTRAINT enquiry_messages__body__ck CHECK (char_length(body) BETWEEN 1 AND 2000)
);
CREATE INDEX enquiry_messages__tenant_id_enquiry__idx ON engagement.enquiry_messages (tenant_id, enquiry_id, created_at);

-- ---------- coded sets (02-CV §5.5) ----------
CREATE TABLE engagement.g_cs_booking_cancel_reasons (
  code text NOT NULL, display text NOT NULL, system text NOT NULL DEFAULT 'lims', system_version text NOT NULL DEFAULT '1',
  sort_order integer NOT NULL, is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT g_cs_booking_cancel_reasons__pk PRIMARY KEY (code),
  CONSTRAINT g_cs_booking_cancel_reasons__code__ck CHECK (code ~ '^[a-z0-9_]{1,64}$'));
CREATE TABLE engagement.g_cs_reminder_reasons (LIKE engagement.g_cs_booking_cancel_reasons INCLUDING ALL);
CREATE TABLE engagement.g_cs_enquiry_categories (LIKE engagement.g_cs_booking_cancel_reasons INCLUDING ALL);

CREATE TABLE engagement.cs_booking_cancel_reasons (
  id uuid NOT NULL, tenant_id uuid NOT NULL, code text NOT NULL, display text NOT NULL,
  system text NOT NULL DEFAULT 'tenant', system_version text NOT NULL DEFAULT '1', sort_order integer NOT NULL,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT cs_booking_cancel_reasons__pk PRIMARY KEY (id),
  CONSTRAINT cs_booking_cancel_reasons__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT cs_booking_cancel_reasons__tenant_id_code__uq UNIQUE (tenant_id, code),
  CONSTRAINT cs_booking_cancel_reasons__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT cs_booking_cancel_reasons__code__ck CHECK (code ~ '^[a-z0-9_]{1,64}$' AND char_length(display) BETWEEN 1 AND 80));
-- cs_reminder_reasons, cs_enquiry_categories: identical structure, names substituted (08 A31.2)
CREATE TABLE engagement.cs_reminder_reasons (
  id uuid NOT NULL, tenant_id uuid NOT NULL, code text NOT NULL, display text NOT NULL,
  system text NOT NULL DEFAULT 'tenant', system_version text NOT NULL DEFAULT '1', sort_order integer NOT NULL,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT cs_reminder_reasons__pk PRIMARY KEY (id),
  CONSTRAINT cs_reminder_reasons__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT cs_reminder_reasons__tenant_id_code__uq UNIQUE (tenant_id, code),
  CONSTRAINT cs_reminder_reasons__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT cs_reminder_reasons__code__ck CHECK (code ~ '^[a-z0-9_]{1,64}$' AND char_length(display) BETWEEN 1 AND 80));
CREATE TABLE engagement.cs_enquiry_categories (
  id uuid NOT NULL, tenant_id uuid NOT NULL, code text NOT NULL, display text NOT NULL,
  system text NOT NULL DEFAULT 'tenant', system_version text NOT NULL DEFAULT '1', sort_order integer NOT NULL,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT cs_enquiry_categories__pk PRIMARY KEY (id),
  CONSTRAINT cs_enquiry_categories__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT cs_enquiry_categories__tenant_id_code__uq UNIQUE (tenant_id, code),
  CONSTRAINT cs_enquiry_categories__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT cs_enquiry_categories__code__ck CHECK (code ~ '^[a-z0-9_]{1,64}$' AND char_length(display) BETWEEN 1 AND 80));

-- ---------- event_inbox ----------
-- engagement.event_inbox (03-IC §12 standard shape) is generated by C0 only, with its RLS, grants and purge policies
-- (C0 05-SCHEMA §3.9; 08 A30.2); this chunk creates no inbox DDL.
```

## 4. Guard triggers for non-staff actors

```sql
-- Patient actors may only change booked/version/updated_* on slot_occupancy;
-- device (queue_display) actors may only change last_seen_at/updated_at on queue_displays.
CREATE FUNCTION engagement.guard_actor_columns() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_actor text := app.current_actor_type();
  v_allowed text[] := TG_ARGV[1:]::text[];       -- TG_ARGV[0] = actor type the guard applies to
BEGIN
  IF v_actor = TG_ARGV[0] AND (to_jsonb(OLD) - v_allowed) IS DISTINCT FROM (to_jsonb(NEW) - v_allowed) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER slot_occupancy__patient_guard BEFORE UPDATE ON engagement.slot_occupancy
  FOR EACH ROW EXECUTE FUNCTION engagement.guard_actor_columns('patient','booked','version','updated_at','updated_by');
CREATE TRIGGER queue_displays__device_guard BEFORE UPDATE ON engagement.queue_displays
  FOR EACH ROW EXECUTE FUNCTION engagement.guard_actor_columns('device','last_seen_at','updated_at','updated_by');

-- Patient actors on account_patient_links (review C16 #14): outside a DEFINER a patient may change only the profile
-- relationship and revoke the link (remove profile, delete account). Reactivation of a suspended link and widening of
-- visible_from / method happen only inside app.engagement_redeem_link_code / app.engagement_apply_report_link (§6), where
-- current_user is the function owner lims_owner, or as the system actor. lims_app cannot become lims_owner, so the
-- current_user test cannot be forged by the caller [CONV].
CREATE FUNCTION engagement.guard_patient_link_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_allowed text[] := ARRAY['relationship','status','revoked_by_kind','revoked_reason_code','revoked_at','is_active',
                            'updated_at','updated_by','version'];
BEGIN
  IF app.current_actor_type() = 'patient' AND current_user <> 'lims_owner' THEN
    IF (to_jsonb(OLD) - v_allowed) IS DISTINCT FROM (to_jsonb(NEW) - v_allowed)
       OR (NEW.status IS DISTINCT FROM OLD.status AND NEW.status <> 'revoked') THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'engagement.account_patient_links';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER account_patient_links__patient_guard BEFORE UPDATE ON engagement.account_patient_links
  FOR EACH ROW EXECUTE FUNCTION engagement.guard_patient_link_update();
```
(C0 may express `TG_ARGV[1:]` with an explicit array copy loop; PL/pgSQL `TG_ARGV` is a text array.) Probe P-L9 (07 §6.3): patient UPDATE of `status` suspended → active, or of `visible_from` → NULL, raises `immutable_row`.

## 5. RLS

### 5.1 Predicates (used verbatim below; `T` = `(SELECT app.current_tenant_id())`, `K` = `(SELECT app.current_actor_type())`, `G` = `(SELECT app.is_staff_or_system())`)

| Name | SQL |
|---|---|
| STAFF | `tenant_id = T AND G AND K IN ('user','system')` |
| STAFF_C | `STAFF AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]))` |
| SYS | `tenant_id = T AND G AND K = 'system'` |
| PAT_ACC | `tenant_id = T AND K = 'patient' AND account_id = (SELECT app.engagement_account_id())` |
| PAT_PID | `tenant_id = T AND K = 'patient' AND patient_id = ANY ((SELECT app.engagement_patient_ids())::uuid[])` |
| PAT_VIS(col) | `tenant_id = T AND K = 'patient' AND app.engagement_patient_visible(patient_id, col)` |
| PAT_ANY | `tenant_id = T AND K = 'patient' AND (SELECT app.engagement_account_id()) IS NOT NULL` |
| PRE | `tenant_id = T AND K = 'patient' AND (SELECT app.engagement_preauth_stage()) = 'pre_auth'` |
| PRE_TOK | `PRE AND token_sha256 = (SELECT decode(app.current_claims() ->> 'otp_token_sha256', 'hex'))` |
| DISP | `tenant_id = T AND K = 'device' AND (SELECT app.current_claims() ->> 'device_kind') = 'queue_display' AND centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])` |
| ANY_T | `tenant_id = T AND K IN ('user','system','patient','device')` |

Every staff and system predicate (STAFF, STAFF_C, SYS) carries `G` in the transcribed SQL (08 A17 P-16); `K IN ('user','system')` additionally excludes `device` (same positive list as 08 A19 D-109). Array predicates use the `::uuid[]` cast of 08 A16.1 (also for `app.engagement_patient_ids()`, which returns `uuid[]` and fails the same way without it). Tables with patient, pre-auth or display policies are marked in `db/meta/tables.yaml` `shared_with: [patient]` (all tables with a PAT_*/PRE* column in §5.2) or carry a DISP policy (queue tables, `booking_centres`); the generated P-16 probe then expects rows only through those actor-specific policies.

Patient predicates are false for staff/system/pre-auth actors (helpers return NULL/`{}`); pre-auth predicates are false for signed-in patients (no `patient_stage` claim). Staff predicates never admit `patient`/`device`/`portal`/`partner` actors.

### 5.2 Policy matrix (S = SELECT, I = INSERT (WITH CHECK), U = UPDATE (USING + WITH CHECK same predicate unless noted), D = DELETE)

| Table | S | I | U | D |
|---|---|---|---|---|
| settings | ANY_T | STAFF | STAFF | — |
| accounts | STAFF; PAT_ACC′ (`id = app.engagement_account_id()`); PRE_ACC (below) | PRE_ACC | PAT_ACC′; SYS; PRE_ACC | — |
| otp_challenges | PRE_TOK; SYS | PRE | PRE_TOK; SYS | SYS + `expires_at < now() − 24 h` (P-18(c)) |
| link_consents | STAFF; PAT_ACC (app rows) | STAFF; PAT_ACC (`source = 'app'`) | — | — |
| link_codes | STAFF | STAFF (`issued_by_membership_id` = claims membership) | STAFF | SYS + `expires_at < now() − 90 days` (P-18(c)) |
| account_patient_links | STAFF; PAT_ACC | PAT_LINK_INS (below); SYS | PAT_ACC (patient column guard §4: relationship + revoke only); STAFF; SYS (`patient_id`, `account_id` immutable by trigger) | — |
| self_registrations | PAT_ACC; SYS | PAT_ACC | SYS | — |
| addresses | PAT_ACC; STAFF | PAT_ACC_PID; STAFF | PAT_ACC_PID; STAFF | — |
| bookable_items | STAFF; PAT_ANY (`is_active`) | STAFF | STAFF | — |
| booking_centres | STAFF; PAT_ANY; DISP | SYS | SYS | — |
| slot_templates, slot_blackouts | STAFF_C; PAT_ANY (`is_active`) | STAFF_C | STAFF_C | — |
| slot_occupancy | STAFF_C; PAT_ANY | STAFF_C; PAT_ANY | STAFF_C; PAT_ANY (guard trigger §4) | — |
| bookings | STAFF_C; PAT_ACC | STAFF_C; PAT_ACC | STAFF_C; PAT_ACC | — |
| booking_items, booking_transitions | STAFF_C; PAT_ACC | STAFF_C; PAT_ACC | — | — |
| patient_orders | PAT_VIS(visible_at); SYS | SYS | SYS | SYS |
| patient_order_specimens | PAT_PID (+ parent order visible: service filter); SYS | SYS | SYS | SYS |
| patient_reports | PAT_VIS(released_at); SYS | SYS | SYS | SYS |
| smart_summaries | PAT_PID (+ report visible: service join); SYS | SYS | SYS | SYS |
| notifications | PAT_ACC; SYS | SYS | PAT_ACC (read_at only — service); SYS | SYS + `expires_at < now()` (P-18(c)) |
| payment_requests | PAT_ACC; SYS | PAT_ACC_PID | PAT_ACC; SYS | — |
| queue_definitions, queue_counters | STAFF_C; DISP | STAFF_C | STAFF_C | — |
| queue_day_counters, queue_tokens | STAFF_C; DISP (tokens, S only) | STAFF_C | STAFF_C | — |
| queue_displays | STAFF_C; DISP (`id = app.current_actor_id()`) | STAFF_C | STAFF_C; DISP (`id = app.current_actor_id()`, guard trigger) | — |
| reminders | STAFF | STAFF | STAFF | — |
| membership_plans | STAFF; PAT_ANY | STAFF | STAFF | — |
| patient_memberships | STAFF; PAT_PID | STAFF | STAFF | — |
| number_counters | ANY_T | ANY_T | ANY_T | SYS + `expires_at IS NOT NULL AND expires_at < now()` (P-18(c)) |
| enquiries | STAFF; PAT_ACC | PAT_ACC (and `patient_id IS NULL OR patient_id = ANY ((SELECT app.engagement_patient_ids())::uuid[])`) | STAFF; PAT_ACC | — |
| enquiry_messages | STAFF; PAT_ACC | STAFF (`author_kind = 'staff'`); PAT_ACC (`author_kind = 'patient'`) | — | — |
| cs_* | ANY_T | STAFF | STAFF | — |
| event_inbox | SYS | SYS | — | — |

`PAT_ACC_PID` = `PAT_ACC AND patient_id = ANY ((SELECT app.engagement_patient_ids())::uuid[])`.

Owner-role policies (`TO lims_owner`, `__owner_only`) needed by the DEFINERs are in §6 (08 A10.5, A19 P-41).

`PAT_LINK_INS` = `PAT_ACC AND ((method = 'link_code' AND app.engagement_code_redeemed_by_me(link_code_id, patient_id)) OR method = 'report_link')`. A `link_code` link can be inserted only for the patient of a code this account redeemed in the same transaction. A `report_link` link has no SQL-checkable proof (the proof is C6's `redeemPortalLinkForApp` result in the service); residual risk accepted and covered by service tests and probes (07-SECURITY §6 P-L4). `self_registered` links are inserted by the system actor only.

`PRE_ACC` (accounts during OTP verify): `PRE AND phone_e164 = (SELECT c.phone_e164 FROM engagement.otp_challenges c WHERE c.tenant_id = accounts.tenant_id AND c.token_sha256 = (SELECT decode(app.current_claims() ->> 'otp_token_sha256', 'hex')) AND c.status = 'verified')` — the subquery is itself subject to `otp_challenges` PRE_TOK, so it only sees the caller's own verified challenge.

Note on staff scope: `accounts`, `link_*`, `reminders`, `memberships`, `enquiries` are **tenant-wide** for staff (not centre-scoped) — patient app accounts are not tied to a centre (DECISION). Authorisation still requires the relevant `engagement.*` permission in the handler.

### 5.3 Policy SQL (representative; C0 writes all policies of §5.2 the same way, names `<table>__<cmd>__<scope>`)

**Policy scope names (lead note, final sweep 2026-11-06 — documented, not renamed).** 02-CV §5.8 lists the scopes `tenant`, `tenant_centre`, `owner_only`, `lookup`, `platform`, `partner`, `patient`. C16 also uses five qualified scopes, each tied to one predicate of §5.1: `system` (SYS), `patient_account` (PAT_ACC), `patient_visible` (PAT_VIS), `preauth` (PRE) and `preauth_token` (PRE_TOK). They are not normalised to `tenant` / `patient` because that rename is not trivial: several tables carry two policies that would fall into the same 02-CV scope for the same command — `accounts` (S and U: PAT_ACC′ and PRE_ACC, both patient actors) and `account_patient_links` (U: STAFF and SYS, both `tenant`) — so a normalised name would need a qualifier anyway. The names follow the `<table>__<command>__<scope>` pattern, are referenced only in this file, and C0 transcribes the §5.2 cells with the same qualifier per predicate. Adding the qualified scopes to the 02-CV §5.8 list is left to the program-doc owner.

```sql
ALTER TABLE engagement.bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE engagement.bookings FORCE ROW LEVEL SECURITY;
CREATE POLICY bookings__select__tenant_centre ON engagement.bookings FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system')
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY bookings__select__patient_account ON engagement.bookings FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'patient'
         AND account_id = (SELECT app.engagement_account_id()));
CREATE POLICY bookings__insert__tenant_centre ON engagement.bookings FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system')
              AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY bookings__insert__patient_account ON engagement.bookings FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'patient'
              AND account_id = (SELECT app.engagement_account_id())
              AND patient_id = ANY ((SELECT app.engagement_patient_ids())::uuid[]));
CREATE POLICY bookings__update__tenant_centre ON engagement.bookings FOR UPDATE TO lims_app
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system')
              AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system')
              AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY bookings__update__patient_account ON engagement.bookings FOR UPDATE TO lims_app
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'patient'
              AND account_id = (SELECT app.engagement_account_id()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'patient'
              AND account_id = (SELECT app.engagement_account_id()));
-- no DELETE policy (class C)

ALTER TABLE engagement.patient_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE engagement.patient_reports FORCE ROW LEVEL SECURITY;
CREATE POLICY patient_reports__select__patient_visible ON engagement.patient_reports FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'patient'
         AND app.engagement_patient_visible(patient_id, released_at));
CREATE POLICY patient_reports__select__system ON engagement.patient_reports FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY patient_reports__insert__system ON engagement.patient_reports FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY patient_reports__update__system ON engagement.patient_reports FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system')
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY patient_reports__delete__system ON engagement.patient_reports FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');

ALTER TABLE engagement.otp_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE engagement.otp_challenges FORCE ROW LEVEL SECURITY;
CREATE POLICY otp_challenges__insert__preauth ON engagement.otp_challenges FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'patient'
              AND (SELECT app.engagement_preauth_stage()) = 'pre_auth');
CREATE POLICY otp_challenges__select__preauth_token ON engagement.otp_challenges FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'patient'
         AND (SELECT app.engagement_preauth_stage()) = 'pre_auth'
         AND token_sha256 = (SELECT decode(app.current_claims() ->> 'otp_token_sha256', 'hex')));
CREATE POLICY otp_challenges__update__preauth_token ON engagement.otp_challenges FOR UPDATE TO lims_app
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'patient'
              AND (SELECT app.engagement_preauth_stage()) = 'pre_auth'
              AND token_sha256 = (SELECT decode(app.current_claims() ->> 'otp_token_sha256', 'hex')))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'patient'
              AND (SELECT app.engagement_preauth_stage()) = 'pre_auth'
              AND token_sha256 = (SELECT decode(app.current_claims() ->> 'otp_token_sha256', 'hex')));
CREATE POLICY otp_challenges__select__system ON engagement.otp_challenges FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY otp_challenges__update__system ON engagement.otp_challenges FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system')
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
-- Class-E retention deletes (08 A17 P-18(c)): system actor in the per_tenant task engagement.purge_ephemeral; no DEFINER.
CREATE POLICY otp_challenges__delete__tenant ON engagement.otp_challenges FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND (SELECT app.current_actor_type()) = 'system' AND expires_at < now() - interval '24 hours');
CREATE POLICY link_codes__delete__tenant ON engagement.link_codes FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND (SELECT app.current_actor_type()) = 'system' AND expires_at < now() - interval '90 days');
CREATE POLICY notifications__delete__tenant ON engagement.notifications FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND (SELECT app.current_actor_type()) = 'system' AND expires_at < now());
CREATE POLICY number_counters__delete__tenant ON engagement.number_counters FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND (SELECT app.current_actor_type()) = 'system' AND expires_at IS NOT NULL AND expires_at < now());
GRANT DELETE ON engagement.otp_challenges, engagement.link_codes, engagement.notifications, engagement.number_counters,
  engagement.patient_orders, engagement.patient_order_specimens, engagement.patient_reports, engagement.smart_summaries TO lims_app;

-- cs_reminder_reasons, cs_enquiry_categories (08 A31.2): §5.2 row `cs_*` — S ANY_T, I STAFF, U STAFF, no DELETE; grants S I U (§1)
ALTER TABLE engagement.cs_reminder_reasons ENABLE ROW LEVEL SECURITY;
ALTER TABLE engagement.cs_reminder_reasons FORCE ROW LEVEL SECURITY;
CREATE POLICY cs_reminder_reasons__select__tenant ON engagement.cs_reminder_reasons FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system','patient','device'));
CREATE POLICY cs_reminder_reasons__insert__tenant ON engagement.cs_reminder_reasons FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system'));
CREATE POLICY cs_reminder_reasons__update__tenant ON engagement.cs_reminder_reasons FOR UPDATE TO lims_app
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system'))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system'));
-- no DELETE policy (class M)
GRANT SELECT, INSERT, UPDATE ON engagement.cs_reminder_reasons TO lims_app;
ALTER TABLE engagement.cs_enquiry_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE engagement.cs_enquiry_categories FORCE ROW LEVEL SECURITY;
CREATE POLICY cs_enquiry_categories__select__tenant ON engagement.cs_enquiry_categories FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system','patient','device'));
CREATE POLICY cs_enquiry_categories__insert__tenant ON engagement.cs_enquiry_categories FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system'));
CREATE POLICY cs_enquiry_categories__update__tenant ON engagement.cs_enquiry_categories FOR UPDATE TO lims_app
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system'))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system'));
-- no DELETE policy (class M)
GRANT SELECT, INSERT, UPDATE ON engagement.cs_enquiry_categories TO lims_app;
```
The task's `link_codes` DELETE also filters `NOT EXISTS (SELECT 1 FROM engagement.account_patient_links l WHERE l.tenant_id = link_codes.tenant_id AND l.link_code_id = link_codes.id)`: a code referenced by a link (`account_patient_links__code__fk`) is kept for the link's lifetime.

Supersession (marking the same phone's and app instance's earlier `pending`/`sent` challenges `superseded`) cannot be done under `PRE` (no token claim for old challenges). It is done by the `engagement.send_login_otp` task as the system actor before it sends (TRD §4.1 step 2; review C16 #8), using `otp_challenges__tenant_id_phone_hmac_created_at__idx`. Old challenges are also unusable because the app only holds the newest token.

## 6. Helper, resolver and purge functions (DEFINER, inventoried per 04 D7; 08 A10.5, A12, A19 P-41 / D-121)

All DEFINERs: owner `lims_owner`, `SET search_path = ''`, schema-qualified, `REVOKE ALL … FROM PUBLIC`, then the `EXECUTE` grant stated per function. FORCE RLS applies to `lims_owner` (02-CV §5.9), so each function reads and writes only through the `__<cmd>__owner_only` policies `TO lims_owner` listed in §6.5 (narrowest USING, one policy per table and command; 08 A10.5). C16 specifies the full bodies and policies here (P-41); C0-0B transcribes them verbatim. Gating: tenant-claim functions use `app.current_tenant_id()` plus the claim columns they need; pre-tenant resolvers use `app.pre_*` GUCs set inside the body and reset to `''` before return (08 A12.1, A21.4); purges of non-E rows use `app.maintenance = '<function name>'` (08 A12.2).

### 6.1 Tenant-claim helpers (EXECUTE `lims_app`)

```sql
-- The four §6.1 helpers are created first by the C0 helpers stage (C0 05-SCHEMA §4.5, 08 A30.1: every app.* helper used inside
-- an RLS policy); same text, so CREATE OR REPLACE here.
CREATE OR REPLACE FUNCTION app.engagement_preauth_stage() RETURNS text LANGUAGE sql STABLE AS $$   -- INVOKER (no table read)
  SELECT app.current_claims() ->> 'patient_stage'
$$;

CREATE OR REPLACE FUNCTION app.engagement_account_id() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE WHEN app.current_actor_type() = 'patient' AND app.engagement_preauth_stage() IS NULL THEN (
    SELECT a.id FROM engagement.accounts a
    JOIN core.memberships m ON m.tenant_id = a.tenant_id AND m.id = a.membership_id
    WHERE a.tenant_id = app.current_tenant_id()
      AND a.membership_id = nullif(app.current_claims() ->> 'membership_id', '')::uuid
      AND a.status = 'active' AND m.actor_type = 'patient' AND m.is_active) END
$$;

CREATE OR REPLACE FUNCTION app.engagement_patient_ids() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(array_agg(l.patient_id), '{}') FROM engagement.account_patient_links l
  WHERE l.tenant_id = app.current_tenant_id() AND l.account_id = app.engagement_account_id() AND l.status = 'active'
$$;

CREATE OR REPLACE FUNCTION app.engagement_patient_visible(p_patient_id uuid, p_at timestamptz) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM engagement.account_patient_links l
    WHERE l.tenant_id = app.current_tenant_id() AND l.account_id = app.engagement_account_id()
      AND l.patient_id = p_patient_id AND l.status = 'active'
      AND (l.visible_from IS NULL OR p_at >= l.visible_from))
$$;

-- Redeem a link code (bytea per 08 A2.4). Also reactivates or widens an existing active/suspended link of the same
-- (account, patient) — review C16 #13/#14: a patient UPDATE of these columns outside a DEFINER is blocked by §4.
CREATE FUNCTION app.engagement_redeem_link_code(p_code_hmac bytea)
RETURNS TABLE (link_code_id uuid, patient_id uuid, relationship text, consent_id uuid, display_name_snapshot text,
               record_phone_hmac bytea, sex_snapshot text, existing_link_id uuid, existing_link_was_suspended boolean)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE
  v_account uuid := app.engagement_account_id();
  v_code    record;
  v_link    record;
BEGIN
  IF v_account IS NULL THEN RETURN; END IF;
  UPDATE engagement.link_codes c
     SET status = 'redeemed', redeemed_at = now(), redeemed_account_id = v_account,
         updated_at = now(), updated_by = app.current_actor_id()
   WHERE c.tenant_id = app.current_tenant_id() AND c.code_hmac = p_code_hmac AND c.status = 'issued' AND c.expires_at > now()
     AND c.bound_phone_hmac = (SELECT a.phone_hmac FROM engagement.accounts a          -- bytea = bytea (08 A5.5)
                               WHERE a.tenant_id = c.tenant_id AND a.id = v_account)
  RETURNING c.id, c.patient_id, c.relationship, c.consent_id, c.display_name_snapshot, c.record_phone_hmac, c.sex_snapshot
       INTO v_code;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT l.id, l.status INTO v_link
    FROM engagement.account_patient_links l
   WHERE l.tenant_id = app.current_tenant_id() AND l.account_id = v_account AND l.patient_id = v_code.patient_id
     AND l.status IN ('active','suspended')
   FOR UPDATE;
  IF FOUND THEN
    UPDATE engagement.account_patient_links l
       SET status = 'active', suspend_reason = NULL, suspended_at = NULL, visible_from = NULL, method = 'link_code',
           link_code_id = v_code.id, consent_id = v_code.consent_id, record_phone_hmac_at_link = v_code.record_phone_hmac,
           sex_snapshot = coalesce(v_code.sex_snapshot, l.sex_snapshot),
           version = l.version + 1, updated_at = now(), updated_by = app.current_actor_id()
     WHERE l.tenant_id = app.current_tenant_id() AND l.id = v_link.id;
  END IF;

  link_code_id := v_code.id; patient_id := v_code.patient_id; relationship := v_code.relationship;
  consent_id := v_code.consent_id; display_name_snapshot := v_code.display_name_snapshot;
  record_phone_hmac := v_code.record_phone_hmac; sex_snapshot := v_code.sex_snapshot;
  existing_link_id := v_link.id;
  existing_link_was_suspended := coalesce(v_link.status = 'suspended', false);
  RETURN NEXT;
END $$;

-- Apply a report-link proof (ReportingPort.redeemPortalLinkForApp succeeded in the service) to an existing link of the
-- caller's account (review C16 #13/#14). Active → visible_from = least(visible_from, p_released_at) unless NULL.
-- Suspended → reactivated with visible_from = p_released_at, record_phone_hmac_at_link = the account's phone HMAC; method
-- unchanged. No row → the service inserts a new report_link link (PAT_LINK_INS). Residual risk as PAT_LINK_INS report_link
-- (no SQL-level proof; 07 §3 (c), probe P-L4).
CREATE FUNCTION app.engagement_apply_report_link(p_patient_id uuid, p_released_at timestamptz)
RETURNS TABLE (link_id uuid, prior_status text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE
  v_account uuid := app.engagement_account_id();
  v_link    record;
BEGIN
  IF v_account IS NULL OR p_released_at IS NULL THEN RETURN; END IF;
  SELECT l.id, l.status INTO v_link
    FROM engagement.account_patient_links l
   WHERE l.tenant_id = app.current_tenant_id() AND l.account_id = v_account AND l.patient_id = p_patient_id
     AND l.status IN ('active','suspended')
   FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  IF v_link.status = 'active' THEN
    UPDATE engagement.account_patient_links l
       SET visible_from = CASE WHEN l.visible_from IS NULL THEN NULL ELSE least(l.visible_from, p_released_at) END,
           version = l.version + 1, updated_at = now(), updated_by = app.current_actor_id()
     WHERE l.tenant_id = app.current_tenant_id() AND l.id = v_link.id;
  ELSE
    UPDATE engagement.account_patient_links l
       SET status = 'active', suspend_reason = NULL, suspended_at = NULL, visible_from = p_released_at,
           record_phone_hmac_at_link = (SELECT a.phone_hmac FROM engagement.accounts a
                                        WHERE a.tenant_id = l.tenant_id AND a.id = v_account),
           version = l.version + 1, updated_at = now(), updated_by = app.current_actor_id()
     WHERE l.tenant_id = app.current_tenant_id() AND l.id = v_link.id;
  END IF;
  link_id := v_link.id; prior_status := v_link.status;
  RETURN NEXT;
END $$;

CREATE FUNCTION app.engagement_code_redeemed_by_me(p_link_code_id uuid, p_patient_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM engagement.link_codes c
    WHERE c.tenant_id = app.current_tenant_id() AND c.id = p_link_code_id AND c.patient_id = p_patient_id
      AND c.status = 'redeemed' AND c.redeemed_account_id = app.engagement_account_id())
$$;
```

### 6.2 Tenant code (C0 resolver, 08 A19 D-121)

`app.engagement_resolve_tenant_code` is **removed**. The `t.<tenant_code>` credential is resolved by the C0 function `app.core_resolve_tenant_code(p_code text) RETURNS TABLE (tenant_id uuid, status text)` (owner `lims_owner`, EXECUTE `lims_api`; body and the `app.pre_tenant_code` branch of `core.tenants__select__owner_only` are C0's, D-121). The C16 resolver accepts the result only when `status = 'active'`.

### 6.3 Pre-tenant resolvers (EXECUTE `lims_api` only; called by the C0 core in an anonymous transaction)

```sql
CREATE FUNCTION app.engagement_resolve_preauth(p_code text, p_token_sha256 bytea)   -- bytea per 08 R24
RETURNS TABLE (tenant_id uuid, challenge_id uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE
  v_tenant uuid; v_id uuid; v_ok boolean;
BEGIN
  IF p_token_sha256 IS NULL OR octet_length(p_token_sha256) <> 32 OR p_code IS NULL THEN RETURN; END IF;
  PERFORM set_config('app.pre_engagement_otp_token_sha256', encode(p_token_sha256, 'hex'), true);
  SELECT c.tenant_id, c.id INTO v_tenant, v_id
    FROM engagement.otp_challenges c
   WHERE c.token_sha256 = p_token_sha256 AND c.expires_at > now() - interval '24 hours';
  IF v_id IS NOT NULL THEN
    PERFORM set_config('app.pre_tenant_id', v_tenant::text, true);          -- set only after the row is found (A12.1)
    SELECT EXISTS (SELECT 1 FROM core.tenants t
                    WHERE t.id = v_tenant AND t.tenant_code = p_code AND t.status = 'active') INTO v_ok;
  END IF;
  PERFORM set_config('app.pre_engagement_otp_token_sha256', '', true);
  PERFORM set_config('app.pre_tenant_id', '', true);
  IF coalesce(v_ok, false) THEN
    tenant_id := v_tenant; challenge_id := v_id; RETURN NEXT;
  END IF;
END $$;

CREATE FUNCTION app.engagement_resolve_display(p_token_sha256 bytea)                 -- bytea per 08 R24
RETURNS TABLE (tenant_id uuid, centre_id uuid, display_id uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE
  v_tenant uuid; v_centre uuid; v_id uuid; v_ok boolean;
BEGIN
  IF p_token_sha256 IS NULL OR octet_length(p_token_sha256) <> 32 THEN RETURN; END IF;
  PERFORM set_config('app.pre_engagement_display_token_sha256', encode(p_token_sha256, 'hex'), true);
  SELECT d.tenant_id, d.centre_id, d.id INTO v_tenant, v_centre, v_id
    FROM engagement.queue_displays d
   WHERE d.token_sha256 = p_token_sha256 AND d.status = 'active';
  IF v_id IS NOT NULL THEN
    PERFORM set_config('app.pre_tenant_id', v_tenant::text, true);
    SELECT EXISTS (SELECT 1 FROM core.tenants t WHERE t.id = v_tenant AND t.status = 'active') INTO v_ok;
  END IF;
  PERFORM set_config('app.pre_engagement_display_token_sha256', '', true);
  PERFORM set_config('app.pre_tenant_id', '', true);
  IF coalesce(v_ok, false) THEN
    tenant_id := v_tenant; centre_id := v_centre; display_id := v_id; RETURN NEXT;
  END IF;
END $$;
```
`VOLATILE` because `set_config` is called. `core.tenants` is read through C0's `tenants__select__owner_only` `app.pre_tenant_id` branch (`id = nullif(current_setting('app.pre_tenant_id', true), '')::uuid`, 08 A12.1). Column names `core.tenants.tenant_code`, `core.tenants.status` and `core.memberships.is_active` follow C0/C2 05-SCHEMA; C0 adjusts identifiers if its final DDL differs, without changing semantics.

### 6.4 Purges of non-E rows (EXECUTE `lims_worker`; called by the `per_tenant` tasks of TRD §8.2 under the engagement system actor's tenant claims)

Retention deletes of class-E tables are **not** DEFINERs (§1, §5.3; 08 A17 P-18(c)). Only these two functions delete non-E rows:

```sql
CREATE FUNCTION engagement.purge_payment_requests() RETURNS integer                  -- M rows: terminal + 90 days [CONV]
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_count integer;
BEGIN
  IF app.current_actor_type() IS DISTINCT FROM 'system' OR app.current_tenant_id() IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'purge_requires_system_tenant_claims';
  END IF;
  PERFORM set_config('app.maintenance', 'engagement_purge_payment_requests', true);
  DELETE FROM engagement.payment_requests r
   WHERE r.tenant_id = app.current_tenant_id() AND r.status IN ('completed','failed','expired')
     AND r.updated_at < now() - interval '90 days';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  PERFORM set_config('app.maintenance', '', true);
  RETURN v_count;
END $$;

CREATE FUNCTION engagement.purge_queue() RETURNS integer                              -- C/M rows: business date older than 1 year [CONV]
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_tokens integer; v_days integer;
BEGIN
  IF app.current_actor_type() IS DISTINCT FROM 'system' OR app.current_tenant_id() IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'purge_requires_system_tenant_claims';
  END IF;
  PERFORM set_config('app.maintenance', 'engagement_purge_queue', true);
  DELETE FROM engagement.queue_tokens t                     -- self-FKs (transfer) are checked at statement end
   WHERE t.tenant_id = app.current_tenant_id()
     AND t.business_date < (now() AT TIME ZONE 'Asia/Kathmandu')::date - 365;      -- 08 A13 P-15
  GET DIAGNOSTICS v_tokens = ROW_COUNT;
  DELETE FROM engagement.queue_day_counters d
   WHERE d.tenant_id = app.current_tenant_id()
     AND d.business_date < (now() AT TIME ZONE 'Asia/Kathmandu')::date - 365;
  GET DIAGNOSTICS v_days = ROW_COUNT;
  PERFORM set_config('app.maintenance', '', true);
  RETURN v_tokens + v_days;
END $$;
```

`engagement.purge_by_retention()` (tenant `retentionYears` for bookings, links, consents, reminders, memberships, enquiries, addresses, deleted accounts, self-registration rows) is **not built in v1**: legal retention periods are BLOCKED B15 and the default of 5 years (04 I8) cannot elapse before 2031 for any v1 tenant. Until a C16 CR specifies its body and owner policies under P-41, these rows are kept [DECISION: no unspecified DEFINER is shipped]. Personal fields of `self_registrations` are still redacted after 30 days by the system actor (UPDATE, SYS policy; TRD §8.2).

### 6.5 Owner policies (`TO lims_owner`; 08 A10.5, A19 D-121)

```sql
-- tenant-claim helpers
CREATE POLICY accounts__select__owner_only ON engagement.accounts FOR SELECT TO lims_owner
  USING (tenant_id = (SELECT app.current_tenant_id())
         AND membership_id = nullif(app.current_claims() ->> 'membership_id', '')::uuid);
CREATE POLICY account_patient_links__select__owner_only ON engagement.account_patient_links FOR SELECT TO lims_owner
  USING (tenant_id = (SELECT app.current_tenant_id()) AND account_id = app.engagement_account_id());
CREATE POLICY account_patient_links__update__owner_only ON engagement.account_patient_links FOR UPDATE TO lims_owner
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND account_id = app.engagement_account_id())
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND account_id = app.engagement_account_id());
CREATE POLICY link_codes__select__owner_only ON engagement.link_codes FOR SELECT TO lims_owner
  USING (tenant_id = (SELECT app.current_tenant_id())
         AND (status = 'issued' OR redeemed_account_id = app.engagement_account_id()));
CREATE POLICY link_codes__update__owner_only ON engagement.link_codes FOR UPDATE TO lims_owner
  USING (tenant_id = (SELECT app.current_tenant_id()) AND status = 'issued')
  WITH CHECK (redeemed_account_id = app.engagement_account_id());
-- pre-tenant resolvers (app.pre_* GUCs, 08 A12.1 / A21.4)
CREATE POLICY otp_challenges__select__owner_only ON engagement.otp_challenges FOR SELECT TO lims_owner
  USING (token_sha256 = decode(current_setting('app.pre_engagement_otp_token_sha256', true), 'hex'));
CREATE POLICY queue_displays__select__owner_only ON engagement.queue_displays FOR SELECT TO lims_owner
  USING (token_sha256 = decode(current_setting('app.pre_engagement_display_token_sha256', true), 'hex'));
-- maintenance purges of non-E rows (08 A12.2)
CREATE POLICY payment_requests__select__owner_only ON engagement.payment_requests FOR SELECT TO lims_owner
  USING (current_setting('app.maintenance', true) = 'engagement_purge_payment_requests'
         AND tenant_id = (SELECT app.current_tenant_id()) AND status IN ('completed','failed','expired')
         AND updated_at < now() - interval '90 days');
CREATE POLICY payment_requests__delete__owner_only ON engagement.payment_requests FOR DELETE TO lims_owner
  USING (current_setting('app.maintenance', true) = 'engagement_purge_payment_requests'
         AND tenant_id = (SELECT app.current_tenant_id()) AND status IN ('completed','failed','expired')
         AND updated_at < now() - interval '90 days');
CREATE POLICY queue_tokens__select__owner_only ON engagement.queue_tokens FOR SELECT TO lims_owner
  USING (current_setting('app.maintenance', true) = 'engagement_purge_queue'
         AND tenant_id = (SELECT app.current_tenant_id())
         AND business_date < (now() AT TIME ZONE 'Asia/Kathmandu')::date - 365);
CREATE POLICY queue_tokens__delete__owner_only ON engagement.queue_tokens FOR DELETE TO lims_owner
  USING (current_setting('app.maintenance', true) = 'engagement_purge_queue'
         AND tenant_id = (SELECT app.current_tenant_id())
         AND business_date < (now() AT TIME ZONE 'Asia/Kathmandu')::date - 365);
CREATE POLICY queue_day_counters__select__owner_only ON engagement.queue_day_counters FOR SELECT TO lims_owner
  USING (current_setting('app.maintenance', true) = 'engagement_purge_queue'
         AND tenant_id = (SELECT app.current_tenant_id())
         AND business_date < (now() AT TIME ZONE 'Asia/Kathmandu')::date - 365);
CREATE POLICY queue_day_counters__delete__owner_only ON engagement.queue_day_counters FOR DELETE TO lims_owner
  USING (current_setting('app.maintenance', true) = 'engagement_purge_queue'
         AND tenant_id = (SELECT app.current_tenant_id())
         AND business_date < (now() AT TIME ZONE 'Asia/Kathmandu')::date - 365);
```
`core.memberships` (read by `app.engagement_account_id()`) uses C0's existing `memberships__select__owner_only` tenant-claim branch; `core.tenants` uses C0's `app.pre_tenant_id` branch. The owner policies reference only helpers that do not read the same table (`app.engagement_account_id()` reads `accounts`, not links or codes), so there is no policy recursion (42P17).

### 6.6 Inventory rows (for 03-IC §13.3 / 08 §4.7 / `db/meta/definer-inventory.yaml`) and tests

| Function | Owner | EXECUTE | Tables · commands | Owner policies |
|---|---|---|---|---|
| `app.engagement_account_id()` | lims_owner | lims_app | `engagement.accounts`, `core.memberships` · SELECT | `accounts__select__owner_only`; C0 `memberships__select__owner_only` |
| `app.engagement_patient_ids()`, `app.engagement_patient_visible(uuid, timestamptz)` | lims_owner | lims_app | `account_patient_links` · SELECT | `account_patient_links__select__owner_only` |
| `app.engagement_redeem_link_code(bytea)` | lims_owner | lims_app | `link_codes` · UPDATE … RETURNING; `accounts` · SELECT; `account_patient_links` · SELECT FOR UPDATE, UPDATE | `link_codes__select/update__owner_only`, `accounts__select__owner_only`, `account_patient_links__select/update__owner_only` |
| `app.engagement_apply_report_link(uuid, timestamptz)` | lims_owner | lims_app | `account_patient_links` · SELECT FOR UPDATE, UPDATE; `accounts` · SELECT | `account_patient_links__select/update__owner_only`, `accounts__select__owner_only` |
| `app.engagement_code_redeemed_by_me(uuid, uuid)` | lims_owner | lims_app | `link_codes` · SELECT | `link_codes__select__owner_only` |
| `app.engagement_resolve_preauth(text, bytea)` | lims_owner | lims_api | `otp_challenges`, `core.tenants` · SELECT | `otp_challenges__select__owner_only` (GUC `app.pre_engagement_otp_token_sha256`); C0 `tenants__select__owner_only` (`app.pre_tenant_id`) |
| `app.engagement_resolve_display(bytea)` | lims_owner | lims_api | `queue_displays`, `core.tenants` · SELECT | `queue_displays__select__owner_only` (GUC `app.pre_engagement_display_token_sha256`); C0 `tenants__select__owner_only` |
| `engagement.purge_payment_requests()` | lims_owner | lims_worker | `payment_requests` · SELECT, DELETE | `payment_requests__select/delete__owner_only` (`app.maintenance = 'engagement_purge_payment_requests'`) |
| `engagement.purge_queue()` | lims_owner | lims_worker | `queue_tokens`, `queue_day_counters` · SELECT, DELETE | `queue_tokens__…`, `queue_day_counters__select/delete__owner_only` (`app.maintenance = 'engagement_purge_queue'`) |

`app.engagement_preauth_stage()` is INVOKER (no table read). `app.engagement_resolve_tenant_code` is removed (D-121).

FORCE-RLS contract tests (08 A12.7; run with FORCE RLS on every touched table; tasks 06 T-A2, T-L2, T-Q3, T-OPS1):
1. Each helper returns the expected value for a patient of tenant A (non-empty account id, patient ids, visibility) and nothing for tenant B claims.
2. `engagement_redeem_link_code`: redeems the code bound to the caller's phone; another account's phone → no row; with an existing suspended link → link `active`, `visible_from` NULL, `method = link_code`, `link_code_id` set.
3. `engagement_apply_report_link`: active link → `visible_from` = least; suspended → reactivated with `visible_from = p_released_at`; no link → no row.
4. Resolvers: return the row for the presented hash; (b) a `lims_app` session that sets `app.pre_engagement_otp_token_sha256` / `app.pre_engagement_display_token_sha256` / `app.pre_tenant_id` itself reads 0 rows of `otp_challenges` / `queue_displays` / `core.tenants`; (c) both GUCs and `app.pre_tenant_id` are `''` after return; wrong `tenant_code` or a suspended tenant → no row.
5. Purges: delete only the claimed tenant's eligible rows; a `lims_app` session that sets `app.maintenance` itself deletes/sees nothing through these policies; `app.maintenance` is `''` after return; called without system claims → `purge_requires_system_tenant_claims`.
6. Guard (§4, probe P-L9): a patient `UPDATE` of `status` suspended → active or of `visible_from` raises `immutable_row`; the same change inside `engagement_redeem_link_code` succeeds.

## 7. Published views (CR-C16-012) — all `WITH (security_invoker = true)`, `GRANT SELECT … TO lims_app`

```sql
-- The booking-address and patient-membership views proposed by CR-C16-012 are NOT created (08 R25): C17 reads
-- addresses through EngagementPort.getHomeAddress and C4 reads memberships through EngagementPort.getActiveMembership
-- (02-TRD §6.1, implemented in services/api/src/modules/engagement/ports/EngagementPort.impl.ts).

CREATE VIEW engagement.v_pub_booking_daily WITH (security_invoker = true) AS          -- consumer C8 (accepted, 08 §4.9 / 03-IC §6.9)
SELECT b.tenant_id, b.centre_id, (b.slot_start AT TIME ZONE 'Asia/Kathmandu')::date AS business_date,
       b.booking_kind, b.created_via,
       count(*) AS bookings,
       count(*) FILTER (WHERE b.status = 'completed') AS completed,
       count(*) FILTER (WHERE b.status = 'cancelled' AND b.cancel_reason_code = 'no_show') AS no_shows,
       count(*) FILTER (WHERE b.status = 'cancelled' AND b.cancel_reason_code <> 'no_show') AS cancelled
FROM engagement.bookings b GROUP BY 1,2,3,4,5;                                        -- P0

CREATE VIEW engagement.v_pub_queue_daily WITH (security_invoker = true) AS            -- consumer C8 (accepted, 08 §4.9 / 03-IC §6.9)
SELECT t.tenant_id, t.centre_id, t.queue_id, t.business_date,
       count(*) AS tokens_issued,
       count(*) FILTER (WHERE t.status = 'completed') AS tokens_completed,
       count(*) FILTER (WHERE t.status IN ('skipped','expired')) AS tokens_not_served,
       (percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM t.called_at - t.issued_at)))::integer AS median_wait_seconds,
       (percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM t.called_at - t.issued_at)))::integer AS p90_wait_seconds
FROM engagement.queue_tokens t GROUP BY 1,2,3,4;                                      -- P0
```
`business_date` uses the literal `Asia/Kathmandu` (08 A13 P-15: in v1 `TenantSettings.timezone` accepts only `Asia/Kathmandu`; a per-tenant timezone needs a CR that adds stored `business_date` columns).

## 8. Seeds (synthetic / coded sets; C0 seeds)

| Set | Codes (display) |
|---|---|
| `g_cs_booking_cancel_reasons` | `patient_request` (Patient request), `no_show` (Did not attend), `slot_expired` (Slot expired), `duplicate` (Duplicate booking), `lab_unavailable` (Lab unavailable) — 03-IC §3.24 seed [CONV]; `slot_expired` unused by C16 v1 (no pending state) but kept for the contract |
| `g_cs_reminder_reasons` | `follow_up_test` (Follow-up test), `repeat_test` (Repeat test), `booking` (Appointment), `other` (Other) [CONV] |
| `g_cs_enquiry_categories` | `booking` (Booking), `report` (Report), `payment` (Payment), `home_collection` (Home collection), `other` (Other) [CONV] |

Synthetic fixtures (`packages/test-fixtures`, C0): for tenants A and B — settings with every feature on; 3 accounts per tenant using C0's synthetic phone prefix; links of every method/status; codes issued/redeemed/expired; 2 centres with templates (Mon–Fri 07:00–11:00, 15 min, capacity 3) + one blackout; 20 bookings across statuses; 2 queues, 3 counters, 30 tokens; 1 paired display; reminders in each status; 2 plans and memberships; enquiries with threads. Names "Test Patient 00nn".

## 9. Retention (02-CV §5.11; 04 I8; B15)

| Table | Retention | Mechanism |
|---|---|---|
| `otp_challenges` | expiry + 24 h | system-actor DELETE in `engagement.purge_ephemeral` (per_tenant; P-18(c), `otp_challenges__delete__tenant`) |
| `link_codes` | expired + 90 days [CONV] (redeemed/revoked codes expire ≤ 168 h after issue); kept while a link references the code | same task (`link_codes__delete__tenant` + `NOT EXISTS` link filter, §5.3) |
| `self_registrations` | personal fields NULLed 30 days after terminal (`expires_at`); row kept | system-actor UPDATE in `purge_ephemeral` (SYS policy); row deletion with `purge_by_retention` (not built, §6.4, B15) |
| `notifications` | 180 days (`expires_at`) [CONV] | same task (`notifications__delete__tenant`) |
| `number_counters` rate keys | `expires_at` (+1 day) | same task (`number_counters__delete__tenant`) |
| `payment_requests` | terminal + 90 days [CONV] | DEFINER `engagement.purge_payment_requests()` from `purge_ephemeral` (§6.4) |
| read models | while any link to the patient is active/suspended; deleted by the system actor when the last link is revoked | `engagement.reconcile_links` (DELETE policy SYS) |
| `booking_centres` | rows deactivated, never deleted | `engagement.sync_booking_centres` |
| `queue_tokens`, `queue_day_counters` | 1 year [CONV] (operational, P0) | DEFINER `engagement.purge_queue()` from the daily task `engagement.purge_queue` (§6.4) |
| `bookings`, `booking_items`, `booking_transitions`, `link_consents`, `accounts` (deleted rows), `account_patient_links`, `reminders`, `patient_memberships`, `enquiries`, `enquiry_messages`, `addresses`, `self_registrations` rows | tenant `retentionYears` (default 5, B15) after last activity | **not built in v1** (§6.4): kept until a C16 CR specifies `engagement.purge_by_retention()` under P-41 after B15 closes |
| `event_inbox` | 90 days | C0 platform purge |

## 10. Data classification summary

| Class | Columns |
|---|---|
| P3 | `booking_items.orderable_id` (with patient), `patient_reports.panel_names`, `smart_summaries.summary`, `enquiries.subject`, `enquiry_messages.body` |
| P2 | phones (`accounts.phone_e164`, `otp_challenges.phone_e164`, `addresses.contact_phone_e164`), names (`account_patient_links.display_name`, `link_codes.display_name_snapshot`, `self_registrations.full_name`), `self_registrations` demographics, address fields, `bookings.booking_no`, `patient_memberships.card_no`, `link_codes.bound_phone_last2` |
| P1 | ids (`patient_id`, `order_id`, `account_id`, …), HMACs, statuses linked to a person |
| Secret (never logged, never returned except where stated) | `otp_challenges.code_hmac/code_ciphertext/token_sha256`, `link_codes.code_hmac`, `queue_displays.token_sha256`, `patient_memberships.card_token` (returned to the owning patient and to staff with permission), `payment_requests.action_json` |
| P0 | settings, templates, blackouts, occupancy, queues, counters, tokens, plans, coded sets, bookable items, booking centres |
