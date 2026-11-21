-- T0B-13.C13 (LD-202): partners schema — C13 05-SCHEMA §8 DDL verbatim (18 tables: 1 G + 17 tenant; indexes; 10 functions incl.
-- the 2 DEFINERs app.current_partner_id (CREATE OR REPLACE, helpers-stage text) and partners.redact_lines; 14 triggers; 27 written-out policies),
-- with the C0 transcription steps the spec asks for: the RLS DO block expanded into literal ENABLE / FORCE / OWNER statements, the
-- name-search index option (a) tenant-leading (08 A31.1), the missing <t>__tenant__fk (C0 05-SCHEMA §9 rule 1), shapes A-D of the §8
-- policy table written out (66 policies), the §6 row-audit triggers and the §7 seeds. Policies are copied 1:1 to db/policies/partners.sql
-- (AC-0B-2.3). partners.event_inbox belongs to T0B-05. Schema partners exists since T0B-01. No view (§9). Single role switch: lims_owner.
-- Known gate conflict: §5 GRANT DELETE on partners.manifest_lines (class C) vs check-migrations NO_DELETE -> blocking CR .orchestra/cr/T0B-13.C13-manifest-lines-delete.md.
SET LOCAL ROLE lims_owner;

-- ===================== §8 DDL (verbatim) =====================
-- =====================================================================
-- partners schema — C13 (spec). Prerequisites: core, catalog, frontdesk DDL;
-- app.current_partner_id() (CR-C13-004) created right after partners.partner_users.
-- =====================================================================

-- ---------- coded sets (G) ----------
CREATE TABLE partners.g_cs_reasons (
  id uuid NOT NULL,
  set_name text NOT NULL, code text NOT NULL, display text NOT NULL,
  requires_text boolean NOT NULL DEFAULT false, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT g_cs_reasons__pk PRIMARY KEY (id),
  CONSTRAINT g_cs_reasons__set_code__uq UNIQUE (set_name, code),
  CONSTRAINT g_cs_reasons__set__ck CHECK (set_name IN ('manifest_withdraw_reasons','line_not_received_reasons',
    'pickup_cancel_reasons','pickup_reject_reasons','partner_suspend_reasons','partner_user_deactivate_reasons',
    'referrer_mapping_reject_reasons')),
  CONSTRAINT g_cs_reasons__code__ck CHECK (code ~ '^[a-z][a-z0-9_]{1,63}$')
);
GRANT SELECT ON partners.g_cs_reasons TO lims_app;   -- RLS-exempt (db/tests/rls_exempt.txt: "global coded set, no tenant data")

-- ---------- settings ----------
CREATE TABLE partners.settings (
  tenant_id uuid NOT NULL,
  default_conversion_mode text NOT NULL DEFAULT 'on_receipt',
  include_default_price_list boolean NOT NULL DEFAULT true,
  require_mapped_referrer boolean NOT NULL DEFAULT false,
  access_slip_enabled boolean NOT NULL DEFAULT false,
  max_lines_per_manifest integer NOT NULL DEFAULT 200,
  draft_ttl_days integer NOT NULL DEFAULT 30,
  pickup_max_days_ahead integer NOT NULL DEFAULT 7,
  report_download_daily_cap_per_user integer NOT NULL DEFAULT 500,
  consent_text_version text NOT NULL DEFAULT 'partner-v1',
  consent_statement text NOT NULL DEFAULT 'The patient has agreed that the lab may process their sample and contact them about the result.',  -- 02-TRD §10.2 placeholder [CONV; B16]
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT settings__pk PRIMARY KEY (tenant_id),
  CONSTRAINT settings__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT settings__mode__ck CHECK (default_conversion_mode IN ('on_receipt','on_submit')),
  CONSTRAINT settings__lines__ck CHECK (max_lines_per_manifest BETWEEN 1 AND 200),
  CONSTRAINT settings__draft_ttl__ck CHECK (draft_ttl_days BETWEEN 1 AND 90),
  CONSTRAINT settings__pickup_days__ck CHECK (pickup_max_days_ahead BETWEEN 1 AND 30),
  CONSTRAINT settings__dl_cap__ck CHECK (report_download_daily_cap_per_user BETWEEN 50 AND 5000),
  CONSTRAINT settings__consent_ver__ck CHECK (char_length(consent_text_version) BETWEEN 1 AND 32),
  CONSTRAINT settings__consent_stmt__ck CHECK (char_length(consent_statement) BETWEEN 1 AND 2000)
);

-- ---------- partners ----------
CREATE TABLE partners.partners (
  id uuid NOT NULL, tenant_id uuid NOT NULL,
  partner_code text NOT NULL, name text NOT NULL, status text NOT NULL DEFAULT 'active',
  credit_party_id uuid NOT NULL, receiving_branch_id uuid NOT NULL, receiving_centre_id uuid NOT NULL,
  conversion_mode text NOT NULL,
  contact_email text, contact_phone_e164 text, address_text text,
  suspended_at timestamptz, suspended_by uuid, suspend_reason_code text, suspend_reason_text text,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT partners__pk PRIMARY KEY (id),
  CONSTRAINT partners__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT partners__tenant_id_partner_code__uq UNIQUE (tenant_id, partner_code),
  CONSTRAINT partners__tenant_id_credit_party_id__uq UNIQUE (tenant_id, credit_party_id),
  CONSTRAINT partners__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT partners__credit_party__fk FOREIGN KEY (tenant_id, credit_party_id) REFERENCES catalog.credit_parties (tenant_id, id),
  CONSTRAINT partners__branch__fk FOREIGN KEY (tenant_id, receiving_branch_id) REFERENCES core.branches (tenant_id, id),
  CONSTRAINT partners__centre__fk FOREIGN KEY (tenant_id, receiving_centre_id) REFERENCES core.collection_centres (tenant_id, id),
  CONSTRAINT partners__code__ck CHECK (partner_code ~ '^[A-Z0-9_-]{1,20}$'),
  CONSTRAINT partners__name__ck CHECK (char_length(name) BETWEEN 1 AND 160),
  CONSTRAINT partners__status__ck CHECK (status IN ('active','suspended')),
  CONSTRAINT partners__mode__ck CHECK (conversion_mode IN ('on_receipt','on_submit')),
  CONSTRAINT partners__email__ck CHECK (contact_email IS NULL OR char_length(contact_email) <= 254),
  CONSTRAINT partners__phone__ck CHECK (contact_phone_e164 IS NULL OR contact_phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),   -- A13 P-11
  CONSTRAINT partners__addr__ck CHECK (address_text IS NULL OR char_length(address_text) <= 300),
  CONSTRAINT partners__suspend__ck CHECK ((status = 'suspended') = (suspended_at IS NOT NULL AND suspend_reason_code IS NOT NULL)),
  CONSTRAINT partners__suspend_text__ck CHECK (suspend_reason_text IS NULL OR char_length(suspend_reason_text) <= 300)
);
CREATE INDEX partners__tenant_id_status__idx ON partners.partners (tenant_id, status, partner_code);

-- ---------- partner users ----------
CREATE TABLE partners.partner_users (
  id uuid NOT NULL, tenant_id uuid NOT NULL, partner_id uuid NOT NULL, membership_id uuid NOT NULL,
  partner_role text NOT NULL, status text NOT NULL DEFAULT 'invited',
  display_name text NOT NULL, email_masked text NOT NULL,
  activated_at timestamptz, deactivated_at timestamptz, deactivated_by uuid, deactivate_reason_code text,
  invited_by_actor_type text NOT NULL,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT partner_users__pk PRIMARY KEY (id),
  CONSTRAINT partner_users__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT partner_users__tenant_id_membership_id__uq UNIQUE (tenant_id, membership_id),
  CONSTRAINT partner_users__tenant_id_id_partner_id__uq UNIQUE (tenant_id, id, partner_id),   -- FK target (review #5)
  CONSTRAINT partner_users__partner__fk FOREIGN KEY (tenant_id, partner_id) REFERENCES partners.partners (tenant_id, id),
  CONSTRAINT partner_users__membership__fk FOREIGN KEY (tenant_id, membership_id) REFERENCES core.memberships (tenant_id, id),
  CONSTRAINT partner_users__role__ck CHECK (partner_role IN ('partner_admin','partner_member')),
  CONSTRAINT partner_users__status__ck CHECK (status IN ('invited','active','deactivated')),
  CONSTRAINT partner_users__name__ck CHECK (char_length(display_name) BETWEEN 1 AND 120),
  CONSTRAINT partner_users__email__ck CHECK (char_length(email_masked) BETWEEN 3 AND 64),
  CONSTRAINT partner_users__deact__ck CHECK ((status = 'deactivated') = (deactivated_at IS NOT NULL)),
  CONSTRAINT partner_users__inviter__ck CHECK (invited_by_actor_type IN ('user','partner'))
);
CREATE INDEX partner_users__tenant_id_partner_id_status__idx ON partners.partner_users (tenant_id, partner_id, status, partner_role);

-- ---------- helper (CR-C13-004) — created here because it reads partner_users/partners ----------
-- Created first by the C0 helpers stage (C0 05-SCHEMA §4.5, 08 A30.1; C6 policies use it); same text, so CREATE OR REPLACE here.
CREATE OR REPLACE FUNCTION app.current_partner_id() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE WHEN app.current_actor_type() = 'partner' THEN (
    SELECT pu.partner_id
    FROM partners.partner_users pu
    JOIN partners.partners p ON p.tenant_id = pu.tenant_id AND p.id = pu.partner_id
    WHERE pu.tenant_id = app.current_tenant_id()
      AND pu.membership_id = nullif(app.current_claims() ->> 'membership_id', '')::uuid
      AND pu.status IN ('invited','active')
      AND p.status = 'active') END
$$;
ALTER FUNCTION app.current_partner_id() OWNER TO lims_owner;
REVOKE ALL ON FUNCTION app.current_partner_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.current_partner_id() TO lims_app;
-- Owner policies (08 A10.5, A19 P-41(b)/(c); review C13 #1 with the narrower USING of triage batch 3 §(c)):
-- FORCE RLS applies to lims_owner, and the lims_app policies below do not match lims_owner, so without these the
-- DEFINER would always see 0 rows and return NULL. Tenant-claim DEFINER → gated on app.current_tenant_id() + the claim column.
CREATE POLICY partner_users__select__owner_only ON partners.partner_users FOR SELECT TO lims_owner
  USING (tenant_id = (SELECT app.current_tenant_id())
         AND membership_id = nullif(app.current_claims() ->> 'membership_id', '')::uuid);
CREATE POLICY partners__select__owner_only ON partners.partners FOR SELECT TO lims_owner
  USING (tenant_id = (SELECT app.current_tenant_id()));
-- Inventory row (P-41(d); 08 §4.7 / 03-IC §13.3, already listed): app.current_partner_id() — owner lims_owner, EXECUTE lims_app, C13-004.

-- ---------- referrers ----------
CREATE TABLE partners.partner_referrers (
  id uuid NOT NULL, tenant_id uuid NOT NULL, partner_id uuid NOT NULL,
  display_name text NOT NULL, display_name_norm text NOT NULL,
  qualification text, registration_council text, registration_no text,
  mapping_state text NOT NULL DEFAULT 'unmapped', catalog_doctor_id uuid,
  mapped_at timestamptz, mapped_by uuid, mapping_reject_reason_code text, mapping_reject_text text,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT partner_referrers__pk PRIMARY KEY (id),
  CONSTRAINT partner_referrers__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT partner_referrers__tenant_id_id_partner_id__uq UNIQUE (tenant_id, id, partner_id),   -- FK target (review #5)
  CONSTRAINT partner_referrers__partner__fk FOREIGN KEY (tenant_id, partner_id) REFERENCES partners.partners (tenant_id, id),
  CONSTRAINT partner_referrers__doctor__fk FOREIGN KEY (tenant_id, catalog_doctor_id) REFERENCES catalog.doctors (tenant_id, id),
  CONSTRAINT partner_referrers__name__ck CHECK (char_length(display_name) BETWEEN 1 AND 120 AND char_length(display_name_norm) BETWEEN 1 AND 120),
  CONSTRAINT partner_referrers__qual__ck CHECK (qualification IS NULL OR char_length(qualification) <= 120),
  CONSTRAINT partner_referrers__council__ck CHECK (registration_council IS NULL OR char_length(registration_council) <= 20),
  CONSTRAINT partner_referrers__regno__ck CHECK (registration_no IS NULL OR char_length(registration_no) <= 30),
  CONSTRAINT partner_referrers__state__ck CHECK (mapping_state IN ('unmapped','mapped','rejected')),
  CONSTRAINT partner_referrers__mapped__ck CHECK ((mapping_state = 'mapped') = (catalog_doctor_id IS NOT NULL)),
  CONSTRAINT partner_referrers__rejected__ck CHECK ((mapping_state = 'rejected') = (mapping_reject_reason_code IS NOT NULL)),
  CONSTRAINT partner_referrers__rej_text__ck CHECK (mapping_reject_text IS NULL OR char_length(mapping_reject_text) <= 300)
);
CREATE UNIQUE INDEX partner_referrers__tenant_id_partner_id_name_regno__p_uq
  ON partners.partner_referrers (tenant_id, partner_id, display_name_norm, coalesce(registration_no, '')) WHERE is_active;
CREATE INDEX partner_referrers__tenant_id_partner_id_is_active__idx ON partners.partner_referrers (tenant_id, partner_id, is_active, display_name_norm);
CREATE INDEX partner_referrers__tenant_id_mapping_state__p_idx ON partners.partner_referrers (tenant_id, created_at) WHERE mapping_state = 'unmapped';

-- ---------- manifest counters ----------
CREATE TABLE partners.manifest_counters (
  tenant_id uuid NOT NULL, partner_id uuid NOT NULL, yy smallint NOT NULL, last_seq integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT manifest_counters__pk PRIMARY KEY (tenant_id, partner_id, yy),
  CONSTRAINT manifest_counters__partner__fk FOREIGN KEY (tenant_id, partner_id) REFERENCES partners.partners (tenant_id, id),
  CONSTRAINT manifest_counters__yy__ck CHECK (yy BETWEEN 0 AND 99),
  CONSTRAINT manifest_counters__seq__ck CHECK (last_seq BETWEEN 1 AND 999999)
);

-- ---------- manifests ----------
CREATE TABLE partners.manifests (
  id uuid NOT NULL, tenant_id uuid NOT NULL, partner_id uuid NOT NULL,
  manifest_no text NOT NULL, state text NOT NULL DEFAULT 'draft',
  receiving_branch_id uuid NOT NULL, receiving_centre_id uuid NOT NULL, conversion_mode text NOT NULL,
  notes text, collected_on date, line_count integer NOT NULL DEFAULT 0,
  submitted_at timestamptz, submitted_by uuid, received_at timestamptz, received_by uuid, in_transit_at timestamptz,
  withdrawn_at timestamptz, withdrawn_by uuid, withdraw_reason_code text, withdraw_reason_text text,
  discarded_at timestamptz,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT manifests__pk PRIMARY KEY (id),
  CONSTRAINT manifests__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT manifests__tenant_id_id_partner_id__uq UNIQUE (tenant_id, id, partner_id),   -- FK target (review #5)
  CONSTRAINT manifests__tenant_id_partner_id_no__uq UNIQUE (tenant_id, partner_id, manifest_no),
  CONSTRAINT manifests__partner__fk FOREIGN KEY (tenant_id, partner_id) REFERENCES partners.partners (tenant_id, id),
  CONSTRAINT manifests__branch__fk FOREIGN KEY (tenant_id, receiving_branch_id) REFERENCES core.branches (tenant_id, id),
  CONSTRAINT manifests__centre__fk FOREIGN KEY (tenant_id, receiving_centre_id) REFERENCES core.collection_centres (tenant_id, id),
  CONSTRAINT manifests__no__ck CHECK (manifest_no ~ '^MF[0-9]{8}$'),
  CONSTRAINT manifests__state__ck CHECK (state IN ('draft','submitted','partially_received','received','withdrawn','discarded')),
  CONSTRAINT manifests__mode__ck CHECK (conversion_mode IN ('on_receipt','on_submit')),
  CONSTRAINT manifests__notes__ck CHECK (notes IS NULL OR char_length(notes) <= 500),
  CONSTRAINT manifests__lines__ck CHECK (line_count BETWEEN 0 AND 200),
  CONSTRAINT manifests__submitted__ck CHECK ((state IN ('draft','discarded')) = (submitted_at IS NULL)),
  CONSTRAINT manifests__withdrawn__ck CHECK ((state = 'withdrawn') = (withdrawn_at IS NOT NULL AND withdraw_reason_code IS NOT NULL)),
  CONSTRAINT manifests__withdraw_text__ck CHECK (withdraw_reason_text IS NULL OR char_length(withdraw_reason_text) <= 300),
  CONSTRAINT manifests__discarded__ck CHECK ((state = 'discarded') = (discarded_at IS NOT NULL))
);
CREATE INDEX manifests__tenant_id_partner_id_created_at__idx ON partners.manifests (tenant_id, partner_id, created_at DESC, id);
CREATE INDEX manifests__tenant_id_receiving_centre_id_state__p_idx ON partners.manifests (tenant_id, receiving_centre_id, state, submitted_at DESC)
  WHERE state IN ('submitted','partially_received');
CREATE INDEX manifests__tenant_id_state_updated_at__p_idx ON partners.manifests (tenant_id, updated_at) WHERE state = 'draft';

-- ---------- manifest lines ----------
CREATE TABLE partners.manifest_lines (
  id uuid NOT NULL, tenant_id uuid NOT NULL, partner_id uuid NOT NULL, manifest_id uuid NOT NULL,
  receiving_centre_id uuid NOT NULL, line_no integer NOT NULL, state text NOT NULL DEFAULT 'draft',
  partner_sample_ref text,
  patient_full_name text, patient_sex text, patient_birth_on date, patient_age_years smallint, patient_phone_e164 text,
  consent_attested boolean NOT NULL, consent_sms boolean NOT NULL DEFAULT false, consent_whatsapp boolean NOT NULL DEFAULT false,
  consent_email boolean NOT NULL DEFAULT false, consent_share_with_referrer boolean NOT NULL DEFAULT false,
  consent_text_version text NOT NULL,
  orderable_ids uuid[] NOT NULL, orderables_snapshot jsonb NOT NULL,
  priority text NOT NULL, referrer_id uuid, collected_at timestamptz, clinical_note text,
  resolved_patient_id uuid, conversion_attempt integer NOT NULL DEFAULT 0,
  order_id uuid, registration_no text, converted_at timestamptz,
  failure_code text, failed_at timestamptz,
  sample_received_at timestamptz, received_by uuid, sample_missing boolean NOT NULL DEFAULT false,
  not_received_reason_code text,
  is_redacted boolean NOT NULL DEFAULT false, redacted_at timestamptz,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT manifest_lines__pk PRIMARY KEY (id),
  CONSTRAINT manifest_lines__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT manifest_lines__tenant_id_manifest_id_line_no__uq UNIQUE (tenant_id, manifest_id, line_no),
  CONSTRAINT manifest_lines__manifest__fk FOREIGN KEY (tenant_id, manifest_id) REFERENCES partners.manifests (tenant_id, id),
  CONSTRAINT manifest_lines__partner__fk FOREIGN KEY (tenant_id, partner_id) REFERENCES partners.partners (tenant_id, id),
  CONSTRAINT manifest_lines__centre__fk FOREIGN KEY (tenant_id, receiving_centre_id) REFERENCES core.collection_centres (tenant_id, id),
  CONSTRAINT manifest_lines__referrer__fk FOREIGN KEY (tenant_id, referrer_id, partner_id)
    REFERENCES partners.partner_referrers (tenant_id, id, partner_id),   -- MATCH SIMPLE: NULL referrer_id is not checked
  CONSTRAINT manifest_lines__order__fk FOREIGN KEY (tenant_id, order_id) REFERENCES frontdesk.orders (tenant_id, id),
  CONSTRAINT manifest_lines__line_no__ck CHECK (line_no BETWEEN 1 AND 200),
  CONSTRAINT manifest_lines__state__ck CHECK (state IN ('draft','submitted','converting','converted','conversion_failed',
    'not_received','withdrawn','discarded','cancelled')),
  CONSTRAINT manifest_lines__ref__ck CHECK (partner_sample_ref IS NULL OR partner_sample_ref ~ '^[A-Za-z0-9_./-]{1,40}$'),
  CONSTRAINT manifest_lines__name__ck CHECK (patient_full_name IS NULL OR char_length(patient_full_name) BETWEEN 1 AND 120),
  CONSTRAINT manifest_lines__sex__ck CHECK (patient_sex IS NULL OR patient_sex IN ('male','female','other','unknown')),
  CONSTRAINT manifest_lines__dob__ck CHECK (patient_birth_on IS NULL OR patient_birth_on >= DATE '1900-01-01'),
  CONSTRAINT manifest_lines__age__ck CHECK (patient_age_years IS NULL OR patient_age_years BETWEEN 0 AND 130),
  CONSTRAINT manifest_lines__phone__ck CHECK (patient_phone_e164 IS NULL OR patient_phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),   -- A13 P-11
  CONSTRAINT manifest_lines__patient__ck CHECK (is_redacted OR (patient_full_name IS NOT NULL AND patient_sex IS NOT NULL
    AND ((patient_birth_on IS NULL) <> (patient_age_years IS NULL)) AND consent_attested)),
  CONSTRAINT manifest_lines__consent_ver__ck CHECK (char_length(consent_text_version) BETWEEN 1 AND 32),
  CONSTRAINT manifest_lines__orderables__ck CHECK (cardinality(orderable_ids) BETWEEN 1 AND 30),
  CONSTRAINT manifest_lines__snapshot__ck CHECK (jsonb_typeof(orderables_snapshot) = 'array'),
  CONSTRAINT manifest_lines__priority__ck CHECK (priority IN ('routine','urgent')),
  CONSTRAINT manifest_lines__note__ck CHECK (clinical_note IS NULL OR char_length(clinical_note) <= 300),
  CONSTRAINT manifest_lines__attempt__ck CHECK (conversion_attempt BETWEEN 0 AND 100),
  CONSTRAINT manifest_lines__converted__ck CHECK ((order_id IS NOT NULL) = (converted_at IS NOT NULL)),
  CONSTRAINT manifest_lines__converted_state__ck CHECK (state NOT IN ('converted','cancelled') OR order_id IS NOT NULL),
  CONSTRAINT manifest_lines__regno__ck CHECK (registration_no IS NULL OR char_length(registration_no) <= 40),
  CONSTRAINT manifest_lines__failed__ck CHECK ((state = 'conversion_failed') = (failure_code IS NOT NULL)),
  CONSTRAINT manifest_lines__failure_code__ck CHECK (failure_code IS NULL OR failure_code ~ '^[a-z_]+\.[a-z_]+$'),
  CONSTRAINT manifest_lines__not_received__ck CHECK ((state = 'not_received' OR sample_missing) = (not_received_reason_code IS NOT NULL)),
  CONSTRAINT manifest_lines__redacted__ck CHECK (is_redacted = (redacted_at IS NOT NULL))
);
CREATE UNIQUE INDEX manifest_lines__tenant_id_manifest_id_ref__p_uq ON partners.manifest_lines (tenant_id, manifest_id, partner_sample_ref)
  WHERE partner_sample_ref IS NOT NULL;
CREATE UNIQUE INDEX manifest_lines__tenant_id_order_id__p_uq ON partners.manifest_lines (tenant_id, order_id) WHERE order_id IS NOT NULL;
CREATE INDEX manifest_lines__tenant_id_state_updated_at__p_idx ON partners.manifest_lines (tenant_id, state, updated_at)
  WHERE state IN ('converting','conversion_failed');
CREATE INDEX manifest_lines__tenant_id_partner_id_referrer_id__p_idx
  ON partners.manifest_lines (tenant_id, partner_id, referrer_id, converted_at) WHERE state = 'converted';
CREATE INDEX manifest_lines__tenant_id_partner_id_sample_ref__idx ON partners.manifest_lines (tenant_id, partner_id, partner_sample_ref);
-- name search: C0 picks option (a) (pg_trgm and btree_gin are installed by db/bootstrap/01_database.sql), tenant_id leading
-- (08 A31.1, REQ-SEC-023; opclass schema-qualified). Option (b) is not created.
CREATE INDEX manifest_lines__patient_name_trgm__idx ON partners.manifest_lines USING gin (tenant_id, patient_full_name extensions.gin_trgm_ops);
CREATE INDEX manifest_lines__tenant_id_created_at__p_idx ON partners.manifest_lines (tenant_id, created_at) WHERE NOT is_redacted;
CREATE INDEX manifest_lines__tenant_id_receiving_centre_id__missing__p_idx ON partners.manifest_lines (tenant_id, receiving_centre_id)
  WHERE sample_missing AND state = 'converted';   -- 08 A19 D-104 (SI1 has_missing_samples)

-- ---------- pickups ----------
CREATE TABLE partners.pickup_requests (
  id uuid NOT NULL, tenant_id uuid NOT NULL, partner_id uuid NOT NULL, receiving_centre_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'requested',
  window_start timestamptz NOT NULL, window_end timestamptz NOT NULL, packages_count smallint NOT NULL,
  notes text, contact_name text, contact_phone_e164 text,
  scheduled_start timestamptz, scheduled_end timestamptz, assignee_text text, picked_up_at timestamptz,
  cancel_reason_code text, reject_reason_code text, resolved_at timestamptz, resolved_by uuid,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT pickup_requests__pk PRIMARY KEY (id),
  CONSTRAINT pickup_requests__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT pickup_requests__tenant_id_id_partner_id__uq UNIQUE (tenant_id, id, partner_id),   -- FK target (review #5)
  CONSTRAINT pickup_requests__partner__fk FOREIGN KEY (tenant_id, partner_id) REFERENCES partners.partners (tenant_id, id),
  CONSTRAINT pickup_requests__centre__fk FOREIGN KEY (tenant_id, receiving_centre_id) REFERENCES core.collection_centres (tenant_id, id),
  CONSTRAINT pickup_requests__state__ck CHECK (state IN ('requested','scheduled','picked_up','cancelled','rejected')),
  CONSTRAINT pickup_requests__window__ck CHECK (window_start < window_end),
  CONSTRAINT pickup_requests__packages__ck CHECK (packages_count BETWEEN 1 AND 50),
  CONSTRAINT pickup_requests__notes__ck CHECK (notes IS NULL OR char_length(notes) <= 500),
  CONSTRAINT pickup_requests__contact__ck CHECK (contact_name IS NULL OR char_length(contact_name) <= 80),
  CONSTRAINT pickup_requests__phone__ck CHECK (contact_phone_e164 IS NULL OR contact_phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),   -- A13 P-11
  CONSTRAINT pickup_requests__sched__ck CHECK ((scheduled_start IS NULL) = (scheduled_end IS NULL) AND (scheduled_start IS NULL OR scheduled_start < scheduled_end)),
  CONSTRAINT pickup_requests__sched_state__ck CHECK (state <> 'scheduled' OR scheduled_start IS NOT NULL),
  CONSTRAINT pickup_requests__assignee__ck CHECK (assignee_text IS NULL OR char_length(assignee_text) <= 80),
  CONSTRAINT pickup_requests__picked__ck CHECK ((state = 'picked_up') = (picked_up_at IS NOT NULL)),
  CONSTRAINT pickup_requests__cancel__ck CHECK ((state = 'cancelled') = (cancel_reason_code IS NOT NULL)),
  CONSTRAINT pickup_requests__reject__ck CHECK ((state = 'rejected') = (reject_reason_code IS NOT NULL))
);
CREATE INDEX pickup_requests__tenant_id_partner_id_created_at__idx ON partners.pickup_requests (tenant_id, partner_id, created_at DESC, id);
CREATE INDEX pickup_requests__tenant_id_receiving_centre_id_state__p_idx ON partners.pickup_requests (tenant_id, receiving_centre_id, window_start)
  WHERE state IN ('requested','scheduled');

CREATE TABLE partners.pickup_request_manifests (
  tenant_id uuid NOT NULL, pickup_request_id uuid NOT NULL, manifest_id uuid NOT NULL,
  partner_id uuid NOT NULL, receiving_centre_id uuid NOT NULL, is_open boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT pickup_request_manifests__pk PRIMARY KEY (tenant_id, pickup_request_id, manifest_id),
  CONSTRAINT pickup_request_manifests__pickup__fk FOREIGN KEY (tenant_id, pickup_request_id, partner_id)
    REFERENCES partners.pickup_requests (tenant_id, id, partner_id),
  CONSTRAINT pickup_request_manifests__manifest__fk FOREIGN KEY (tenant_id, manifest_id, partner_id)
    REFERENCES partners.manifests (tenant_id, id, partner_id),
  CONSTRAINT pickup_request_manifests__partner__fk FOREIGN KEY (tenant_id, partner_id) REFERENCES partners.partners (tenant_id, id)
);
CREATE UNIQUE INDEX pickup_request_manifests__tenant_id_manifest_id__p_uq ON partners.pickup_request_manifests (tenant_id, manifest_id) WHERE is_open;

-- ---------- projections ----------
CREATE TABLE partners.order_tracking (
  tenant_id uuid NOT NULL, order_id uuid NOT NULL, partner_id uuid NOT NULL, line_id uuid NOT NULL, manifest_id uuid NOT NULL,
  receiving_centre_id uuid NOT NULL, registration_no text,
  tracking_status text NOT NULL, registered_at timestamptz NOT NULL, last_event_at timestamptz NOT NULL,
  cancelled_at timestamptz, report_count integer NOT NULL DEFAULT 0,
  stored_order_status text, reconciled_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT order_tracking__pk PRIMARY KEY (tenant_id, order_id),
  CONSTRAINT order_tracking__tenant_id_line_id__uq UNIQUE (tenant_id, line_id),
  CONSTRAINT order_tracking__tenant_id_order_id_partner_id__uq UNIQUE (tenant_id, order_id, partner_id),   -- FK target (review #5)
  CONSTRAINT order_tracking__line__fk FOREIGN KEY (tenant_id, line_id) REFERENCES partners.manifest_lines (tenant_id, id),
  CONSTRAINT order_tracking__manifest__fk FOREIGN KEY (tenant_id, manifest_id) REFERENCES partners.manifests (tenant_id, id),
  CONSTRAINT order_tracking__partner__fk FOREIGN KEY (tenant_id, partner_id) REFERENCES partners.partners (tenant_id, id),
  CONSTRAINT order_tracking__order__fk FOREIGN KEY (tenant_id, order_id) REFERENCES frontdesk.orders (tenant_id, id),
  CONSTRAINT order_tracking__status__ck CHECK (tracking_status IN ('registered','in_transit','in_lab','action_needed',
    'partially_reported','reported','cancelled')),
  CONSTRAINT order_tracking__stored__ck CHECK (stored_order_status IS NULL OR stored_order_status IN ('pre_registered','registered','cancelled')),
  CONSTRAINT order_tracking__regno__ck CHECK (registration_no IS NULL OR char_length(registration_no) <= 40)
);
CREATE INDEX order_tracking__tenant_id_partner_id_registered_at__idx ON partners.order_tracking (tenant_id, partner_id, registered_at DESC, order_id);
CREATE INDEX order_tracking__tenant_id_partner_id_status__idx ON partners.order_tracking (tenant_id, partner_id, tracking_status, last_event_at DESC);
CREATE INDEX order_tracking__tenant_id_manifest_id__idx ON partners.order_tracking (tenant_id, manifest_id);
CREATE INDEX order_tracking__tenant_id_updated_at__p_idx ON partners.order_tracking (tenant_id, updated_at)
  WHERE tracking_status NOT IN ('reported','cancelled');

CREATE TABLE partners.tracked_specimens (
  tenant_id uuid NOT NULL, specimen_id uuid NOT NULL, order_id uuid NOT NULL, partner_id uuid NOT NULL,
  receiving_centre_id uuid NOT NULL, specimen_type_code text NOT NULL, status text NOT NULL, last_seq integer NOT NULL,
  collected_at timestamptz, in_transit_at timestamptz, received_at timestamptz, rejected_at timestamptz, reported_at timestamptz,
  rejection_reason_code text, replaces_specimen_id uuid, parent_specimen_id uuid, changed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT tracked_specimens__pk PRIMARY KEY (tenant_id, specimen_id),
  CONSTRAINT tracked_specimens__order__fk FOREIGN KEY (tenant_id, order_id, partner_id)
    REFERENCES partners.order_tracking (tenant_id, order_id, partner_id),
  CONSTRAINT tracked_specimens__type__ck CHECK (char_length(specimen_type_code) BETWEEN 1 AND 64),
  CONSTRAINT tracked_specimens__status__ck CHECK (status IN ('ordered','collected','in_transit','received','aliquoted','in_process',
    'resulted','verified','approved','reported','rejected','recollection_ordered','stored','discarded')),
  CONSTRAINT tracked_specimens__seq__ck CHECK (last_seq >= 0),
  CONSTRAINT tracked_specimens__reason__ck CHECK (rejection_reason_code IS NULL OR char_length(rejection_reason_code) <= 64)
);
CREATE INDEX tracked_specimens__tenant_id_order_id__idx ON partners.tracked_specimens (tenant_id, order_id);

CREATE TABLE partners.order_reports (
  tenant_id uuid NOT NULL, report_id uuid NOT NULL, version_no integer NOT NULL, order_id uuid NOT NULL,
  partner_id uuid NOT NULL, receiving_centre_id uuid NOT NULL,
  kind text NOT NULL, status text NOT NULL DEFAULT 'valid', released_at timestamptz NOT NULL,
  panel_names text[], is_new boolean NOT NULL DEFAULT true, seen_at timestamptz, seen_by uuid, enriched_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT order_reports__pk PRIMARY KEY (tenant_id, report_id, version_no),
  CONSTRAINT order_reports__tenant_id_report_id_version_no_partner_id__uq UNIQUE (tenant_id, report_id, version_no, partner_id),   -- FK target (review #5)
  CONSTRAINT order_reports__order__fk FOREIGN KEY (tenant_id, order_id, partner_id)
    REFERENCES partners.order_tracking (tenant_id, order_id, partner_id),
  CONSTRAINT order_reports__kind__ck CHECK (char_length(kind) BETWEEN 1 AND 32),   -- report_kind is x-extensible (A13 P-4); known: final, partial, preliminary, amended, addendum (08 R1)
  CONSTRAINT order_reports__status__ck CHECK (status IN ('valid','superseded')),
  CONSTRAINT order_reports__version__ck CHECK (version_no >= 1),
  CONSTRAINT order_reports__panels__ck CHECK (panel_names IS NULL OR cardinality(panel_names) <= 50),
  CONSTRAINT order_reports__seen__ck CHECK (is_new OR seen_at IS NOT NULL)
);
CREATE INDEX order_reports__tenant_id_partner_id_released_at__idx ON partners.order_reports (tenant_id, partner_id, released_at DESC, report_id, version_no);
CREATE INDEX order_reports__tenant_id_partner_id_is_new__p_idx ON partners.order_reports (tenant_id, partner_id, released_at DESC) WHERE is_new;
CREATE INDEX order_reports__tenant_id_order_id__idx ON partners.order_reports (tenant_id, order_id, is_new);

CREATE TABLE partners.price_list_items (
  tenant_id uuid NOT NULL, partner_id uuid NOT NULL, orderable_id uuid NOT NULL,
  kind text NOT NULL, code text NOT NULL, name text NOT NULL, department_name text,
  unit_price_paisa bigint NOT NULL, source text NOT NULL, price_list_id uuid NOT NULL, price_list_version integer NOT NULL,
  effective_from timestamptz NOT NULL, effective_to timestamptz, synced_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  CONSTRAINT price_list_items__pk PRIMARY KEY (tenant_id, partner_id, orderable_id),
  CONSTRAINT price_list_items__partner__fk FOREIGN KEY (tenant_id, partner_id) REFERENCES partners.partners (tenant_id, id),
  CONSTRAINT price_list_items__kind__ck CHECK (kind IN ('test','panel')),
  CONSTRAINT price_list_items__code__ck CHECK (char_length(code) BETWEEN 1 AND 64),
  CONSTRAINT price_list_items__name__ck CHECK (char_length(name) BETWEEN 1 AND 200),
  CONSTRAINT price_list_items__dept__ck CHECK (department_name IS NULL OR char_length(department_name) <= 120),
  CONSTRAINT price_list_items__price__ck CHECK (unit_price_paisa BETWEEN 0 AND 9007199254740991),
  CONSTRAINT price_list_items__source__ck CHECK (source IN ('partner','standard'))
);
CREATE INDEX price_list_items__tenant_id_partner_id_code__idx ON partners.price_list_items (tenant_id, partner_id, code);
CREATE INDEX price_list_items__tenant_id_partner_id_name__idx ON partners.price_list_items (tenant_id, partner_id, lower(name) text_pattern_ops);

CREATE TABLE partners.price_list_syncs (
  tenant_id uuid NOT NULL, partner_id uuid NOT NULL, synced_at timestamptz NOT NULL, price_list_version integer,
  row_count integer NOT NULL DEFAULT 0, last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT price_list_syncs__pk PRIMARY KEY (tenant_id, partner_id),
  CONSTRAINT price_list_syncs__partner__fk FOREIGN KEY (tenant_id, partner_id) REFERENCES partners.partners (tenant_id, id)
);

CREATE TABLE partners.statement_months (
  tenant_id uuid NOT NULL, partner_id uuid NOT NULL, credit_party_id uuid NOT NULL,
  period_month date NOT NULL, fiscal_year_bs text NOT NULL,
  invoiced_paisa bigint NOT NULL, paid_paisa bigint NOT NULL, credited_paisa bigint NOT NULL, closing_balance_paisa bigint NOT NULL,
  synced_at timestamptz NOT NULL, is_stale boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT statement_months__pk PRIMARY KEY (tenant_id, partner_id, period_month, fiscal_year_bs),
  CONSTRAINT statement_months__partner__fk FOREIGN KEY (tenant_id, partner_id) REFERENCES partners.partners (tenant_id, id),
  CONSTRAINT statement_months__month__ck CHECK (extract(day FROM period_month) = 1),
  CONSTRAINT statement_months__fy__ck CHECK (fiscal_year_bs ~ '^[0-9]{4}/[0-9]{2}$')
);
CREATE INDEX statement_months__tenant_id_partner_id_period__idx ON partners.statement_months (tenant_id, partner_id, period_month DESC);
CREATE INDEX statement_months__tenant_id_credit_party_id__idx ON partners.statement_months (tenant_id, credit_party_id);

CREATE TABLE partners.download_counters (
  tenant_id uuid NOT NULL, partner_user_id uuid NOT NULL, day date NOT NULL, partner_id uuid NOT NULL,
  count integer NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '30 days'),   -- [CONV] §6 retention; P-18(c) purge
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT download_counters__pk PRIMARY KEY (tenant_id, partner_user_id, day),
  CONSTRAINT download_counters__user__fk FOREIGN KEY (tenant_id, partner_user_id, partner_id)
    REFERENCES partners.partner_users (tenant_id, id, partner_id),
  CONSTRAINT download_counters__count__ck CHECK (count >= 0)
);
CREATE INDEX download_counters__tenant_id_expires_at__idx ON partners.download_counters (tenant_id, expires_at);

CREATE TABLE partners.access_slips (   -- 08 A2.1; no column holds the link token or URL
  id uuid NOT NULL, tenant_id uuid NOT NULL, partner_id uuid NOT NULL, partner_user_id uuid NOT NULL,
  report_id uuid NOT NULL, version_no integer NOT NULL, order_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'requested',
  link_id uuid, link_expires_at timestamptz,
  file_path text, file_sha256 text, file_byte_size integer,
  failure_code text, issued_at timestamptz, expired_at timestamptz,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT access_slips__pk PRIMARY KEY (id),
  CONSTRAINT access_slips__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT access_slips__partner__fk FOREIGN KEY (tenant_id, partner_id) REFERENCES partners.partners (tenant_id, id),
  CONSTRAINT access_slips__user__fk FOREIGN KEY (tenant_id, partner_user_id) REFERENCES partners.partner_users (tenant_id, id),
  CONSTRAINT access_slips__report__fk FOREIGN KEY (tenant_id, report_id, version_no, partner_id)
    REFERENCES partners.order_reports (tenant_id, report_id, version_no, partner_id),
  CONSTRAINT access_slips__order__fk FOREIGN KEY (tenant_id, order_id, partner_id)
    REFERENCES partners.order_tracking (tenant_id, order_id, partner_id),
  CONSTRAINT access_slips__state__ck CHECK (state IN ('requested','issued','failed','expired')),
  CONSTRAINT access_slips__version_no__ck CHECK (version_no >= 1),
  CONSTRAINT access_slips__link__ck CHECK ((state IN ('issued','expired')) = (link_id IS NOT NULL AND link_expires_at IS NOT NULL)),
  CONSTRAINT access_slips__file__ck CHECK ((state = 'issued') = (file_path IS NOT NULL AND file_sha256 IS NOT NULL AND file_byte_size IS NOT NULL)),
  CONSTRAINT access_slips__path__ck CHECK (file_path IS NULL OR char_length(file_path) BETWEEN 1 AND 200),
  CONSTRAINT access_slips__sha__ck CHECK (file_sha256 IS NULL OR file_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT access_slips__size__ck CHECK (file_byte_size IS NULL OR file_byte_size BETWEEN 1 AND 10485760),
  CONSTRAINT access_slips__failure__ck CHECK ((state = 'failed') = (failure_code IS NOT NULL)
    AND (failure_code IS NULL OR (char_length(failure_code) <= 64 AND failure_code ~ '^[a-z_]+\.[a-z_]+$'))),
  CONSTRAINT access_slips__issued_at__ck CHECK ((state IN ('issued','expired')) = (issued_at IS NOT NULL)),
  CONSTRAINT access_slips__expired_at__ck CHECK ((state = 'expired') = (expired_at IS NOT NULL))
);
CREATE INDEX access_slips__tenant_id_partner_id_report_id_created_at__idx ON partners.access_slips (tenant_id, partner_id, report_id, created_at DESC);
CREATE INDEX access_slips__tenant_id_state_link_expires_at__p_idx ON partners.access_slips (tenant_id, link_expires_at) WHERE state = 'issued';
CREATE INDEX access_slips__tenant_id_state_created_at__p_idx ON partners.access_slips (tenant_id, created_at) WHERE state = 'requested';

-- partners.event_inbox: created by C0's standard template (03 §12), columns (tenant_id, event_id, event_type, received_at, created_by),
-- PK (tenant_id, event_id), __tenant policies, 90-day owner purge.


-- ===================== C0 additions (C0 05-SCHEMA §9 rule 1: tenant FK where §8 omits it) =====================
ALTER TABLE partners.partner_users ADD CONSTRAINT partner_users__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id);
ALTER TABLE partners.partner_referrers ADD CONSTRAINT partner_referrers__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id);
ALTER TABLE partners.manifest_counters ADD CONSTRAINT manifest_counters__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id);
ALTER TABLE partners.manifests ADD CONSTRAINT manifests__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id);
ALTER TABLE partners.manifest_lines ADD CONSTRAINT manifest_lines__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id);
ALTER TABLE partners.pickup_requests ADD CONSTRAINT pickup_requests__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id);
ALTER TABLE partners.pickup_request_manifests ADD CONSTRAINT pickup_request_manifests__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id);
ALTER TABLE partners.order_tracking ADD CONSTRAINT order_tracking__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id);
ALTER TABLE partners.tracked_specimens ADD CONSTRAINT tracked_specimens__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id);
ALTER TABLE partners.order_reports ADD CONSTRAINT order_reports__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id);
ALTER TABLE partners.price_list_items ADD CONSTRAINT price_list_items__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id);
ALTER TABLE partners.price_list_syncs ADD CONSTRAINT price_list_syncs__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id);
ALTER TABLE partners.statement_months ADD CONSTRAINT statement_months__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id);
ALTER TABLE partners.download_counters ADD CONSTRAINT download_counters__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id);
ALTER TABLE partners.access_slips ADD CONSTRAINT access_slips__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id);

-- ---------- triggers ----------
CREATE FUNCTION partners.guard_manifest_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF OLD.state <> 'draft' AND
     (to_jsonb(OLD) - ARRAY['state','line_count','received_at','received_by','in_transit_at','withdrawn_at','withdrawn_by',
        'withdraw_reason_code','withdraw_reason_text','updated_at','updated_by','version'])
     IS DISTINCT FROM
     (to_jsonb(NEW) - ARRAY['state','line_count','received_at','received_by','in_transit_at','withdrawn_at','withdrawn_by',
        'withdraw_reason_code','withdraw_reason_text','updated_at','updated_by','version']) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'partners.manifests';
  END IF;
  IF OLD.state IN ('received','withdrawn','discarded') AND NEW.state <> OLD.state THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'partners.manifests';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER manifests__guard BEFORE UPDATE ON partners.manifests FOR EACH ROW EXECUTE FUNCTION partners.guard_manifest_update();

CREATE FUNCTION partners.guard_line_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  lifecycle text[] := ARRAY['state','conversion_attempt','resolved_patient_id','order_id','registration_no','converted_at',
    'failure_code','failed_at','sample_received_at','received_by','sample_missing','not_received_reason_code',
    'updated_at','updated_by','version'];
  redaction text[] := ARRAY['patient_full_name','patient_sex','patient_birth_on','patient_age_years','patient_phone_e164',
    'orderables_snapshot','clinical_note','is_redacted','redacted_at'];
BEGIN
  IF NEW.partner_id <> OLD.partner_id OR NEW.manifest_id <> OLD.manifest_id OR NEW.tenant_id <> OLD.tenant_id THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'partners.manifest_lines';
  END IF;
  IF OLD.state <> 'draft' THEN
    IF current_setting('app.maintenance', true) = 'partners_redact_lines' AND current_user = 'lims_owner' THEN
      lifecycle := lifecycle || redaction;
    END IF;
    IF (to_jsonb(OLD) - lifecycle) IS DISTINCT FROM (to_jsonb(NEW) - lifecycle) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'partners.manifest_lines';
    END IF;
    IF OLD.state IN ('withdrawn','discarded','cancelled','not_received') AND NEW.state <> OLD.state THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'partners.manifest_lines';
    END IF;
    IF OLD.order_id IS NOT NULL AND NEW.order_id IS DISTINCT FROM OLD.order_id THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'partners.manifest_lines';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER manifest_lines__guard BEFORE UPDATE ON partners.manifest_lines FOR EACH ROW EXECUTE FUNCTION partners.guard_line_update();

CREATE FUNCTION partners.check_line_parent() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM partners.manifests m WHERE m.tenant_id = NEW.tenant_id AND m.id = NEW.manifest_id
                 AND m.partner_id = NEW.partner_id AND m.receiving_centre_id = NEW.receiving_centre_id) THEN
    RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'manifest_line_parent_mismatch';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER manifest_lines__parent BEFORE INSERT ON partners.manifest_lines FOR EACH ROW EXECUTE FUNCTION partners.check_line_parent();
-- Rule (review m#18): receiving branch/centre are snapshotted at create and refreshed at submit; the MS3 submit transaction
-- updates the manifest first, then sets manifest_lines.receiving_centre_id of every line to the refreshed value.
-- This trigger runs on INSERT only.

-- Redaction DEFINER (owner role). Called only by task partners.redact_expired_lines (per_tenant, P-6) under the job's
-- tenant claims as the partners system actor. Gating per 08 A12.2 / A19 P-41(c): the body sets
-- app.maintenance = 'partners_redact_lines'; the owner policies below match only that value AND the caller's tenant.
-- The download_counters purge is NOT done here any more: it is a P-18(c) system-actor delete in the same task.
CREATE FUNCTION partners.redact_lines(p_tenant_id uuid, p_older_than timestamptz) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE n integer;
BEGIN
  IF p_tenant_id IS DISTINCT FROM app.current_tenant_id() OR app.current_actor_type() IS DISTINCT FROM 'system' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'redaction_scope';
  END IF;
  PERFORM set_config('app.maintenance', 'partners_redact_lines', true);
  UPDATE partners.manifest_lines SET patient_full_name = NULL, patient_sex = NULL, patient_birth_on = NULL,
         patient_age_years = NULL, patient_phone_e164 = NULL, orderables_snapshot = '[]'::jsonb, clinical_note = NULL,
         is_redacted = true, redacted_at = now(), updated_at = now(), updated_by = app.current_actor_id()
   WHERE tenant_id = p_tenant_id AND NOT is_redacted AND created_at < p_older_than;
  GET DIAGNOSTICS n = ROW_COUNT;
  UPDATE partners.order_reports r SET panel_names = NULL, updated_at = now(), updated_by = app.current_actor_id()
   WHERE r.tenant_id = p_tenant_id AND r.panel_names IS NOT NULL
     AND EXISTS (SELECT 1 FROM partners.order_tracking t JOIN partners.manifest_lines l ON l.tenant_id = t.tenant_id AND l.id = t.line_id
                 WHERE t.tenant_id = r.tenant_id AND t.order_id = r.order_id AND l.is_redacted);
  PERFORM set_config('app.maintenance', '', true);
  RETURN n;
END $$;
ALTER FUNCTION partners.redact_lines(uuid, timestamptz) OWNER TO lims_owner;
REVOKE ALL ON FUNCTION partners.redact_lines(uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION partners.redact_lines(uuid, timestamptz) TO lims_worker;
-- Inside the DEFINER current_user = lims_owner, which guard_line_update checks together with app.maintenance.
-- Inventory row (P-41(d); to be added to 08 §4.7 / 03-IC §13.3 / db/meta/definer-inventory.yaml — handed off):
--   partners.redact_lines(uuid, timestamptz) — owner lims_owner, EXECUTE lims_worker, maintenance GUC
--   app.maintenance = 'partners_redact_lines' (tenant-bound), source C13.

-- Owner policies for partners.redact_lines (08 A10.5; A12.2; A19 P-41(b)/(c)). TO lims_owner only, so a lims_app
-- session that sets app.maintenance itself gains nothing (A12.7 (b)).
CREATE POLICY manifest_lines__select__owner_only ON partners.manifest_lines FOR SELECT TO lims_owner
  USING (current_setting('app.maintenance', true) = 'partners_redact_lines'
         AND tenant_id = (SELECT app.current_tenant_id()));
CREATE POLICY manifest_lines__update__owner_only ON partners.manifest_lines FOR UPDATE TO lims_owner
  USING (current_setting('app.maintenance', true) = 'partners_redact_lines'
         AND tenant_id = (SELECT app.current_tenant_id()) AND NOT is_redacted)
  WITH CHECK (current_setting('app.maintenance', true) = 'partners_redact_lines'
              AND tenant_id = (SELECT app.current_tenant_id()) AND is_redacted);
CREATE POLICY order_reports__select__owner_only ON partners.order_reports FOR SELECT TO lims_owner
  USING (current_setting('app.maintenance', true) = 'partners_redact_lines'
         AND tenant_id = (SELECT app.current_tenant_id()));
CREATE POLICY order_reports__update__owner_only ON partners.order_reports FOR UPDATE TO lims_owner
  USING (current_setting('app.maintenance', true) = 'partners_redact_lines'
         AND tenant_id = (SELECT app.current_tenant_id()) AND panel_names IS NOT NULL)
  WITH CHECK (current_setting('app.maintenance', true) = 'partners_redact_lines'
              AND tenant_id = (SELECT app.current_tenant_id()) AND panel_names IS NULL);
CREATE POLICY order_tracking__select__owner_only ON partners.order_tracking FOR SELECT TO lims_owner
  USING (current_setting('app.maintenance', true) = 'partners_redact_lines'
         AND tenant_id = (SELECT app.current_tenant_id()));

-- ---------- RLS ----------
-- §8 RLS DO block expanded into literal statements by C0 (check-migrations.ts and the policy tools read statements).
ALTER TABLE partners.settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE partners.settings FORCE ROW LEVEL SECURITY;
ALTER TABLE partners.settings OWNER TO lims_owner;
ALTER TABLE partners.partners ENABLE ROW LEVEL SECURITY;
ALTER TABLE partners.partners FORCE ROW LEVEL SECURITY;
ALTER TABLE partners.partners OWNER TO lims_owner;
ALTER TABLE partners.partner_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE partners.partner_users FORCE ROW LEVEL SECURITY;
ALTER TABLE partners.partner_users OWNER TO lims_owner;
ALTER TABLE partners.partner_referrers ENABLE ROW LEVEL SECURITY;
ALTER TABLE partners.partner_referrers FORCE ROW LEVEL SECURITY;
ALTER TABLE partners.partner_referrers OWNER TO lims_owner;
ALTER TABLE partners.manifest_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE partners.manifest_counters FORCE ROW LEVEL SECURITY;
ALTER TABLE partners.manifest_counters OWNER TO lims_owner;
ALTER TABLE partners.manifests ENABLE ROW LEVEL SECURITY;
ALTER TABLE partners.manifests FORCE ROW LEVEL SECURITY;
ALTER TABLE partners.manifests OWNER TO lims_owner;
ALTER TABLE partners.manifest_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE partners.manifest_lines FORCE ROW LEVEL SECURITY;
ALTER TABLE partners.manifest_lines OWNER TO lims_owner;
ALTER TABLE partners.pickup_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE partners.pickup_requests FORCE ROW LEVEL SECURITY;
ALTER TABLE partners.pickup_requests OWNER TO lims_owner;
ALTER TABLE partners.pickup_request_manifests ENABLE ROW LEVEL SECURITY;
ALTER TABLE partners.pickup_request_manifests FORCE ROW LEVEL SECURITY;
ALTER TABLE partners.pickup_request_manifests OWNER TO lims_owner;
ALTER TABLE partners.order_tracking ENABLE ROW LEVEL SECURITY;
ALTER TABLE partners.order_tracking FORCE ROW LEVEL SECURITY;
ALTER TABLE partners.order_tracking OWNER TO lims_owner;
ALTER TABLE partners.tracked_specimens ENABLE ROW LEVEL SECURITY;
ALTER TABLE partners.tracked_specimens FORCE ROW LEVEL SECURITY;
ALTER TABLE partners.tracked_specimens OWNER TO lims_owner;
ALTER TABLE partners.order_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE partners.order_reports FORCE ROW LEVEL SECURITY;
ALTER TABLE partners.order_reports OWNER TO lims_owner;
ALTER TABLE partners.price_list_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE partners.price_list_items FORCE ROW LEVEL SECURITY;
ALTER TABLE partners.price_list_items OWNER TO lims_owner;
ALTER TABLE partners.price_list_syncs ENABLE ROW LEVEL SECURITY;
ALTER TABLE partners.price_list_syncs FORCE ROW LEVEL SECURITY;
ALTER TABLE partners.price_list_syncs OWNER TO lims_owner;
ALTER TABLE partners.statement_months ENABLE ROW LEVEL SECURITY;
ALTER TABLE partners.statement_months FORCE ROW LEVEL SECURITY;
ALTER TABLE partners.statement_months OWNER TO lims_owner;
ALTER TABLE partners.download_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE partners.download_counters FORCE ROW LEVEL SECURITY;
ALTER TABLE partners.download_counters OWNER TO lims_owner;
ALTER TABLE partners.access_slips ENABLE ROW LEVEL SECURITY;
ALTER TABLE partners.access_slips FORCE ROW LEVEL SECURITY;
ALTER TABLE partners.access_slips OWNER TO lims_owner;

-- settings: staff all commands; partner SELECT (needed for PartnerContext features + consent statement)
CREATE POLICY settings__select__staff ON partners.settings FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system'));
CREATE POLICY settings__select__partner ON partners.settings FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner'
         AND (SELECT app.current_partner_id()) IS NOT NULL);
CREATE POLICY settings__insert__staff ON partners.settings FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system'));
CREATE POLICY settings__update__staff ON partners.settings FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system'))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system'));

-- partners: staff all; partner SELECT own row (id = current partner)
CREATE POLICY partners__select__staff ON partners.partners FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system'));
CREATE POLICY partners__select__partner ON partners.partners FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner'
         AND id = (SELECT app.current_partner_id()));
CREATE POLICY partners__insert__staff ON partners.partners FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system'));
CREATE POLICY partners__update__staff ON partners.partners FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system'))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system'));

-- ===================== shapes A-D of the §8 policy table, written out by C0 (manifests = the written-out shape B template below) =====================
-- partner_users: shape A
CREATE POLICY partner_users__select__staff ON partners.partner_users FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system'));
CREATE POLICY partner_users__insert__staff ON partners.partner_users FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system'));
CREATE POLICY partner_users__update__staff ON partners.partner_users FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system'))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system'));
CREATE POLICY partner_users__select__partner ON partners.partner_users FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner' AND partner_id = (SELECT app.current_partner_id()));
CREATE POLICY partner_users__insert__partner ON partners.partner_users FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner' AND partner_id = (SELECT app.current_partner_id()));
CREATE POLICY partner_users__update__partner ON partners.partner_users FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner' AND partner_id = (SELECT app.current_partner_id()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner' AND partner_id = (SELECT app.current_partner_id()));
-- partner_referrers: shape A
CREATE POLICY partner_referrers__select__staff ON partners.partner_referrers FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system'));
CREATE POLICY partner_referrers__insert__staff ON partners.partner_referrers FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system'));
CREATE POLICY partner_referrers__update__staff ON partners.partner_referrers FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system'))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system'));
CREATE POLICY partner_referrers__select__partner ON partners.partner_referrers FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner' AND partner_id = (SELECT app.current_partner_id()));
CREATE POLICY partner_referrers__insert__partner ON partners.partner_referrers FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner' AND partner_id = (SELECT app.current_partner_id()));
CREATE POLICY partner_referrers__update__partner ON partners.partner_referrers FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner' AND partner_id = (SELECT app.current_partner_id()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner' AND partner_id = (SELECT app.current_partner_id()));
-- manifest_counters: shape A
CREATE POLICY manifest_counters__select__staff ON partners.manifest_counters FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system'));
CREATE POLICY manifest_counters__insert__staff ON partners.manifest_counters FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system'));
CREATE POLICY manifest_counters__update__staff ON partners.manifest_counters FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system'))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system'));
CREATE POLICY manifest_counters__select__partner ON partners.manifest_counters FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner' AND partner_id = (SELECT app.current_partner_id()));
CREATE POLICY manifest_counters__insert__partner ON partners.manifest_counters FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner' AND partner_id = (SELECT app.current_partner_id()));
CREATE POLICY manifest_counters__update__partner ON partners.manifest_counters FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner' AND partner_id = (SELECT app.current_partner_id()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner' AND partner_id = (SELECT app.current_partner_id()));
-- manifest_lines: shape B
CREATE POLICY manifest_lines__select__staff_centre ON partners.manifest_lines FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system') AND ((SELECT app.has_all_centres()) OR receiving_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY manifest_lines__insert__staff_centre ON partners.manifest_lines FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system') AND ((SELECT app.has_all_centres()) OR receiving_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY manifest_lines__update__staff_centre ON partners.manifest_lines FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system') AND ((SELECT app.has_all_centres()) OR receiving_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system') AND ((SELECT app.has_all_centres()) OR receiving_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY manifest_lines__select__partner ON partners.manifest_lines FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner' AND partner_id = (SELECT app.current_partner_id()));
CREATE POLICY manifest_lines__insert__partner ON partners.manifest_lines FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner' AND partner_id = (SELECT app.current_partner_id()));
CREATE POLICY manifest_lines__update__partner ON partners.manifest_lines FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner' AND partner_id = (SELECT app.current_partner_id()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner' AND partner_id = (SELECT app.current_partner_id()));
-- pickup_requests: shape B
CREATE POLICY pickup_requests__select__staff_centre ON partners.pickup_requests FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system') AND ((SELECT app.has_all_centres()) OR receiving_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY pickup_requests__insert__staff_centre ON partners.pickup_requests FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system') AND ((SELECT app.has_all_centres()) OR receiving_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY pickup_requests__update__staff_centre ON partners.pickup_requests FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system') AND ((SELECT app.has_all_centres()) OR receiving_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system') AND ((SELECT app.has_all_centres()) OR receiving_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY pickup_requests__select__partner ON partners.pickup_requests FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner' AND partner_id = (SELECT app.current_partner_id()));
CREATE POLICY pickup_requests__insert__partner ON partners.pickup_requests FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner' AND partner_id = (SELECT app.current_partner_id()));
CREATE POLICY pickup_requests__update__partner ON partners.pickup_requests FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner' AND partner_id = (SELECT app.current_partner_id()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner' AND partner_id = (SELECT app.current_partner_id()));
-- pickup_request_manifests: shape B
CREATE POLICY pickup_request_manifests__select__staff_centre ON partners.pickup_request_manifests FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system') AND ((SELECT app.has_all_centres()) OR receiving_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY pickup_request_manifests__insert__staff_centre ON partners.pickup_request_manifests FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system') AND ((SELECT app.has_all_centres()) OR receiving_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY pickup_request_manifests__update__staff_centre ON partners.pickup_request_manifests FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system') AND ((SELECT app.has_all_centres()) OR receiving_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system') AND ((SELECT app.has_all_centres()) OR receiving_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY pickup_request_manifests__select__partner ON partners.pickup_request_manifests FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner' AND partner_id = (SELECT app.current_partner_id()));
CREATE POLICY pickup_request_manifests__insert__partner ON partners.pickup_request_manifests FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner' AND partner_id = (SELECT app.current_partner_id()));
CREATE POLICY pickup_request_manifests__update__partner ON partners.pickup_request_manifests FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner' AND partner_id = (SELECT app.current_partner_id()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner' AND partner_id = (SELECT app.current_partner_id()));
-- order_tracking: shape C
CREATE POLICY order_tracking__select__staff_centre ON partners.order_tracking FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system') AND ((SELECT app.has_all_centres()) OR receiving_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY order_tracking__select__partner ON partners.order_tracking FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner' AND partner_id = (SELECT app.current_partner_id()));
CREATE POLICY order_tracking__insert__system ON partners.order_tracking FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY order_tracking__update__system ON partners.order_tracking FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'system')
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'system');
-- tracked_specimens: shape C
CREATE POLICY tracked_specimens__select__staff_centre ON partners.tracked_specimens FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system') AND ((SELECT app.has_all_centres()) OR receiving_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY tracked_specimens__select__partner ON partners.tracked_specimens FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner' AND partner_id = (SELECT app.current_partner_id()));
CREATE POLICY tracked_specimens__insert__system ON partners.tracked_specimens FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY tracked_specimens__update__system ON partners.tracked_specimens FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'system')
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'system');
-- order_reports: shape C
CREATE POLICY order_reports__select__staff_centre ON partners.order_reports FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system') AND ((SELECT app.has_all_centres()) OR receiving_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY order_reports__select__partner ON partners.order_reports FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner' AND partner_id = (SELECT app.current_partner_id()));
CREATE POLICY order_reports__insert__system ON partners.order_reports FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY order_reports__update__system ON partners.order_reports FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'system')
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'system');
-- order_reports extra: partner mark-seen (columns guarded by partners.guard_report_seen)
CREATE POLICY order_reports__update__partner ON partners.order_reports FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner' AND partner_id = (SELECT app.current_partner_id()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner' AND partner_id = (SELECT app.current_partner_id()));
-- price_list_items: shape D
CREATE POLICY price_list_items__select__staff ON partners.price_list_items FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system'));
CREATE POLICY price_list_items__select__partner ON partners.price_list_items FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner' AND partner_id = (SELECT app.current_partner_id()));
CREATE POLICY price_list_items__insert__system ON partners.price_list_items FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY price_list_items__update__system ON partners.price_list_items FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'system')
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'system');
-- price_list_items extra: replace-on-sync delete, system only
CREATE POLICY price_list_items__delete__system ON partners.price_list_items FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'system');
-- price_list_syncs: shape D
CREATE POLICY price_list_syncs__select__staff ON partners.price_list_syncs FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system'));
CREATE POLICY price_list_syncs__select__partner ON partners.price_list_syncs FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner' AND partner_id = (SELECT app.current_partner_id()));
CREATE POLICY price_list_syncs__insert__system ON partners.price_list_syncs FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY price_list_syncs__update__system ON partners.price_list_syncs FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'system')
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'system');
-- statement_months: shape D
CREATE POLICY statement_months__select__staff ON partners.statement_months FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system'));
CREATE POLICY statement_months__select__partner ON partners.statement_months FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner' AND partner_id = (SELECT app.current_partner_id()));
CREATE POLICY statement_months__insert__system ON partners.statement_months FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY statement_months__update__system ON partners.statement_months FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'system')
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'system');
-- download_counters (§8 table): staff read; partner own user; delete__tenant written out below (A17 P-18(c))
CREATE POLICY download_counters__select__staff ON partners.download_counters FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system'));
CREATE POLICY download_counters__select__partner ON partners.download_counters FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner' AND partner_id = (SELECT app.current_partner_id()) AND partner_user_id = (SELECT pu.id FROM partners.partner_users pu WHERE pu.tenant_id = (SELECT app.current_tenant_id()) AND pu.membership_id = nullif((SELECT app.current_claims()) ->> 'membership_id','')::uuid));
CREATE POLICY download_counters__insert__partner ON partners.download_counters FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner' AND partner_id = (SELECT app.current_partner_id()) AND partner_user_id = (SELECT pu.id FROM partners.partner_users pu WHERE pu.tenant_id = (SELECT app.current_tenant_id()) AND pu.membership_id = nullif((SELECT app.current_claims()) ->> 'membership_id','')::uuid));
CREATE POLICY download_counters__update__partner ON partners.download_counters FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner' AND partner_id = (SELECT app.current_partner_id()) AND partner_user_id = (SELECT pu.id FROM partners.partner_users pu WHERE pu.tenant_id = (SELECT app.current_tenant_id()) AND pu.membership_id = nullif((SELECT app.current_claims()) ->> 'membership_id','')::uuid))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner' AND partner_id = (SELECT app.current_partner_id()) AND partner_user_id = (SELECT pu.id FROM partners.partner_users pu WHERE pu.tenant_id = (SELECT app.current_tenant_id()) AND pu.membership_id = nullif((SELECT app.current_claims()) ->> 'membership_id','')::uuid));

-- ===================== §8 DDL, second block (verbatim) =====================
CREATE POLICY manifests__select__staff_centre ON partners.manifests FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system')
         AND ((SELECT app.has_all_centres()) OR receiving_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY manifests__insert__staff_centre ON partners.manifests FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system')
         AND ((SELECT app.has_all_centres()) OR receiving_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY manifests__update__staff_centre ON partners.manifests FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system')
         AND ((SELECT app.has_all_centres()) OR receiving_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system')
         AND ((SELECT app.has_all_centres()) OR receiving_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY manifests__select__partner ON partners.manifests FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner'
         AND partner_id = (SELECT app.current_partner_id()));
CREATE POLICY manifests__insert__partner ON partners.manifests FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner'
         AND partner_id = (SELECT app.current_partner_id()));
CREATE POLICY manifests__update__partner ON partners.manifests FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner'
         AND partner_id = (SELECT app.current_partner_id()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner'
         AND partner_id = (SELECT app.current_partner_id()));

CREATE POLICY manifest_lines__delete__partner ON partners.manifest_lines FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner'
         AND partner_id = (SELECT app.current_partner_id()) AND state = 'draft');

CREATE POLICY download_counters__delete__tenant ON partners.download_counters FOR DELETE TO lims_app   -- A17 P-18(c)
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND (SELECT app.current_actor_type()) = 'system' AND expires_at < now());

CREATE FUNCTION partners.guard_report_seen() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF app.current_actor_type() = 'partner' AND
     (to_jsonb(OLD) - ARRAY['is_new','seen_at','seen_by','updated_at','updated_by']) IS DISTINCT FROM
     (to_jsonb(NEW) - ARRAY['is_new','seen_at','seen_by','updated_at','updated_by']) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'partners.order_reports';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER order_reports__guard_seen BEFORE UPDATE ON partners.order_reports FOR EACH ROW EXECUTE FUNCTION partners.guard_report_seen();

-- access_slips (08 A2.1): partner reads/inserts requests; only the system actor (worker) moves state.
CREATE POLICY access_slips__select__staff ON partners.access_slips FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system'));
CREATE POLICY access_slips__select__partner ON partners.access_slips FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner'
         AND partner_id = (SELECT app.current_partner_id()));
CREATE POLICY access_slips__insert__partner ON partners.access_slips FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner'
         AND partner_id = (SELECT app.current_partner_id()) AND state = 'requested');
CREATE POLICY access_slips__update__system ON partners.access_slips FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'system')
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'system');

CREATE FUNCTION partners.guard_access_slip_update() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NOT ((OLD.state = 'requested' AND NEW.state IN ('requested','issued','failed'))
       OR (OLD.state = 'issued' AND NEW.state IN ('issued','expired'))) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'partners.access_slips';
  END IF;
  IF (to_jsonb(OLD) - ARRAY['state','link_id','link_expires_at','file_path','file_sha256','file_byte_size','failure_code',
        'issued_at','expired_at','version','updated_at','updated_by'])
     IS DISTINCT FROM
     (to_jsonb(NEW) - ARRAY['state','link_id','link_expires_at','file_path','file_sha256','file_byte_size','failure_code',
        'issued_at','expired_at','version','updated_at','updated_by']) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'partners.access_slips';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER access_slips__guard BEFORE UPDATE ON partners.access_slips FOR EACH ROW EXECUTE FUNCTION partners.guard_access_slip_update();

-- Partner-side guards that RLS cannot express (enforced in service AND by trigger, defence in depth; 08 A19 D-103).
-- (1) States: a partner actor may only move manifests/lines draft→submitted/discarded (lines also draft→converting,
--     on_submit only — checked in guard_partner_columns), submitted→withdrawn, and pickups requested/scheduled→cancelled.
CREATE FUNCTION partners.guard_partner_transitions() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF app.current_actor_type() = 'partner' AND NEW.state IS DISTINCT FROM OLD.state AND NOT (
       (TG_TABLE_NAME IN ('manifests','manifest_lines') AND OLD.state = 'draft' AND NEW.state IN ('submitted','discarded'))
    OR (TG_TABLE_NAME = 'manifest_lines' AND OLD.state = 'draft' AND NEW.state = 'converting')
    OR (TG_TABLE_NAME IN ('manifests','manifest_lines') AND OLD.state = 'submitted' AND NEW.state = 'withdrawn')
    OR (TG_TABLE_NAME = 'pickup_requests' AND OLD.state IN ('requested','scheduled') AND NEW.state = 'cancelled')) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER manifests__partner_transitions BEFORE UPDATE ON partners.manifests FOR EACH ROW EXECUTE FUNCTION partners.guard_partner_transitions();
CREATE TRIGGER manifest_lines__partner_transitions BEFORE UPDATE ON partners.manifest_lines FOR EACH ROW EXECUTE FUNCTION partners.guard_partner_transitions();
CREATE TRIGGER pickup_requests__partner_transitions BEFORE UPDATE ON partners.pickup_requests FOR EACH ROW EXECUTE FUNCTION partners.guard_partner_transitions();

-- (2) Columns (D-103, column sets of review C13 #4): for partner actors only the listed columns may change.
--     Lifecycle facts written by staff or the system (order linkage, receipt, pickup scheduling, mapping) are never
--     writable under partner claims, whatever the state. Non-partner actors are unaffected (their own guards apply).
CREATE FUNCTION partners.guard_partner_columns() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  changed text[];
  allowed text[];
  v_mode text;
BEGIN
  IF app.current_actor_type() IS DISTINCT FROM 'partner' THEN
    RETURN NEW;
  END IF;
  SELECT coalesce(array_agg(n.key), '{}') INTO changed
    FROM jsonb_each(to_jsonb(NEW)) n JOIN jsonb_each(to_jsonb(OLD)) o USING (key)
   WHERE n.value IS DISTINCT FROM o.value;
  IF TG_TABLE_NAME = 'manifests' THEN
    allowed := ARRAY['notes','collected_on','line_count','state','submitted_at','submitted_by','withdrawn_at','withdrawn_by',
      'withdraw_reason_code','withdraw_reason_text','discarded_at','conversion_mode','updated_at','updated_by','version'];
    IF OLD.state = 'draft' THEN
      allowed := allowed || ARRAY['receiving_branch_id','receiving_centre_id'];   -- refreshed at submit (m#18)
    END IF;
  ELSIF TG_TABLE_NAME = 'manifest_lines' THEN
    IF OLD.state = 'draft' THEN
      allowed := ARRAY['partner_sample_ref','patient_full_name','patient_sex','patient_birth_on','patient_age_years',
        'patient_phone_e164','consent_attested','consent_sms','consent_whatsapp','consent_email','consent_share_with_referrer',
        'consent_text_version','orderable_ids','orderables_snapshot','priority','referrer_id','collected_at','clinical_note',
        'receiving_centre_id','state','conversion_attempt','is_redacted','redacted_at','updated_at','updated_by','version'];
      IF 'conversion_attempt' = ANY (changed) THEN
        SELECT m.conversion_mode INTO v_mode FROM partners.manifests m
         WHERE m.tenant_id = NEW.tenant_id AND m.id = NEW.manifest_id;
        IF NOT (OLD.conversion_attempt = 0 AND NEW.conversion_attempt = 1 AND NEW.state = 'converting'
                AND v_mode = 'on_submit') THEN
          RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'partners.manifest_lines';
        END IF;
      END IF;
      IF NEW.state = 'converting' AND 'conversion_attempt' <> ALL (changed) THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'partners.manifest_lines';
      END IF;
    ELSE
      allowed := ARRAY['state','updated_at','updated_by','version'];   -- only submitted → withdrawn (transition guard)
    END IF;
  ELSIF TG_TABLE_NAME = 'pickup_requests' THEN
    allowed := ARRAY['state','cancel_reason_code','resolved_at','resolved_by','updated_at','updated_by','version'];
  ELSIF TG_TABLE_NAME = 'partner_users' THEN
    allowed := ARRAY['status','activated_at','partner_role','deactivated_at','deactivated_by','deactivate_reason_code',
      'updated_at','updated_by','version'];   -- who may change what: partners.guard_partner_users()
  ELSIF TG_TABLE_NAME = 'partner_referrers' THEN
    -- [CONV] derived from 03-APP-FLOW §2.6 (F2–F5): partner edits its own fields, (de)activates, and an edit of a
    -- rejected entry returns it to unmapped (reason cleared). Mapping columns are staff-only (SR2/SR3).
    allowed := ARRAY['display_name','display_name_norm','qualification','registration_council','registration_no',
      'is_active','updated_at','updated_by','version'];
    IF OLD.mapping_state = 'rejected' AND NEW.mapping_state = 'unmapped' THEN
      allowed := allowed || ARRAY['mapping_state','mapping_reject_reason_code','mapping_reject_text'];
    END IF;
  END IF;
  IF NOT (changed <@ allowed) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER manifests__partner_columns BEFORE UPDATE ON partners.manifests FOR EACH ROW EXECUTE FUNCTION partners.guard_partner_columns();
CREATE TRIGGER manifest_lines__partner_columns BEFORE UPDATE ON partners.manifest_lines FOR EACH ROW EXECUTE FUNCTION partners.guard_partner_columns();
CREATE TRIGGER pickup_requests__partner_columns BEFORE UPDATE ON partners.pickup_requests FOR EACH ROW EXECUTE FUNCTION partners.guard_partner_columns();
CREATE TRIGGER partner_users__partner_columns BEFORE UPDATE ON partners.partner_users FOR EACH ROW EXECUTE FUNCTION partners.guard_partner_columns();
CREATE TRIGGER partner_referrers__partner_columns BEFORE UPDATE ON partners.partner_referrers FOR EACH ROW EXECUTE FUNCTION partners.guard_partner_columns();

-- (3) partner_users writes under partner claims (D-103): the caller's own row (by claims membership_id) must be an
--     active partner_admin; the one exception is a member's (or admin's) own first-sign-in flip invited → active
--     (02-TRD §4.8), which may change only status/activated_at/updated_*/version. Otherwise immutable_row.
CREATE FUNCTION partners.guard_partner_users() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_me uuid := nullif(app.current_claims() ->> 'membership_id', '')::uuid;
  v_is_admin boolean;
  changed text[];
BEGIN
  IF app.current_actor_type() IS DISTINCT FROM 'partner' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.membership_id = v_me AND OLD.status = 'invited' AND NEW.status = 'active' THEN
    SELECT coalesce(array_agg(n.key), '{}') INTO changed
      FROM jsonb_each(to_jsonb(NEW)) n JOIN jsonb_each(to_jsonb(OLD)) o USING (key)
     WHERE n.value IS DISTINCT FROM o.value;
    IF changed <@ ARRAY['status','activated_at','updated_at','updated_by','version'] THEN
      RETURN NEW;
    END IF;
  END IF;
  SELECT EXISTS (SELECT 1 FROM partners.partner_users pu
                  WHERE pu.tenant_id = NEW.tenant_id AND pu.membership_id = v_me
                    AND pu.partner_id = NEW.partner_id
                    AND pu.partner_role = 'partner_admin' AND pu.status = 'active') INTO v_is_admin;
  IF NOT v_is_admin THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'partners.partner_users';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER partner_users__partner_guard BEFORE INSERT OR UPDATE ON partners.partner_users FOR EACH ROW EXECUTE FUNCTION partners.guard_partner_users();

-- ---------- grants ----------
GRANT SELECT, INSERT, UPDATE ON partners.settings, partners.partners, partners.partner_users, partners.partner_referrers,
  partners.manifest_counters, partners.manifests, partners.pickup_requests, partners.pickup_request_manifests,
  partners.order_tracking, partners.tracked_specimens, partners.order_reports, partners.price_list_syncs,
  partners.statement_months, partners.access_slips TO lims_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON partners.manifest_lines, partners.price_list_items, partners.download_counters TO lims_app;
-- (DELETE is policy-limited: lines draft-only by partner; price_list_items system-only; download_counters system-only
--  after expires_at, A17 P-18(c).)

-- ===================== row audit (04 D11; §6: listed tables only; not on projections; counters / link row / daily counter not audited [CONV]) =====================
CREATE TRIGGER partners__audit AFTER INSERT OR UPDATE OR DELETE ON partners.partners FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER partner_users__audit AFTER INSERT OR UPDATE OR DELETE ON partners.partner_users FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER partner_referrers__audit AFTER INSERT OR UPDATE OR DELETE ON partners.partner_referrers FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER manifests__audit AFTER INSERT OR UPDATE OR DELETE ON partners.manifests FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER manifest_lines__audit AFTER INSERT OR UPDATE OR DELETE ON partners.manifest_lines FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER pickup_requests__audit AFTER INSERT OR UPDATE OR DELETE ON partners.pickup_requests FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER settings__audit AFTER INSERT OR UPDATE OR DELETE ON partners.settings FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER access_slips__audit AFTER INSERT OR UPDATE OR DELETE ON partners.access_slips FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();

-- ===================== §7 global coded sets (seed; [CONV] codes; fixed UUIDv7-shaped ids, sort_order 10.. per set [CONV]) =====================
INSERT INTO partners.g_cs_reasons (id, set_name, code, display, requires_text, sort_order) VALUES
  ('019a0000-c013-7000-8001-000000001001', 'manifest_withdraw_reasons', 'entered_in_error', 'Entered by mistake', false, 10),
  ('019a0000-c013-7000-8001-000000001002', 'manifest_withdraw_reasons', 'samples_not_sent', 'Samples not sent', false, 20),
  ('019a0000-c013-7000-8001-000000001003', 'manifest_withdraw_reasons', 'duplicate_manifest', 'Duplicate manifest', false, 30),
  ('019a0000-c013-7000-8001-000000001004', 'manifest_withdraw_reasons', 'other', 'Other', true, 40),
  ('019a0000-c013-7000-8001-000000001005', 'line_not_received_reasons', 'sample_missing', 'Sample missing', false, 10),
  ('019a0000-c013-7000-8001-000000001006', 'line_not_received_reasons', 'label_unreadable', 'Label unreadable', false, 20),
  ('019a0000-c013-7000-8001-000000001007', 'line_not_received_reasons', 'wrong_container', 'Wrong container', false, 30),
  ('019a0000-c013-7000-8001-000000001008', 'line_not_received_reasons', 'leaked_or_broken', 'Leaked or broken', false, 40),
  ('019a0000-c013-7000-8001-000000001009', 'line_not_received_reasons', 'test_not_available', 'Test not available', false, 50),
  ('019a0000-c013-7000-8001-000000001010', 'line_not_received_reasons', 'other', 'Other', true, 60),
  ('019a0000-c013-7000-8001-000000001011', 'pickup_cancel_reasons', 'no_longer_needed', 'No longer needed', false, 10),
  ('019a0000-c013-7000-8001-000000001012', 'pickup_cancel_reasons', 'will_deliver_ourselves', 'We will deliver ourselves', false, 20),
  ('019a0000-c013-7000-8001-000000001013', 'pickup_cancel_reasons', 'manifest_withdrawn', 'Manifest withdrawn', false, 30),
  ('019a0000-c013-7000-8001-000000001014', 'pickup_cancel_reasons', 'other', 'Other', true, 40),
  ('019a0000-c013-7000-8001-000000001015', 'pickup_reject_reasons', 'outside_service_area', 'Outside service area', false, 10),
  ('019a0000-c013-7000-8001-000000001016', 'pickup_reject_reasons', 'no_rider_available', 'No rider available', false, 20),
  ('019a0000-c013-7000-8001-000000001017', 'pickup_reject_reasons', 'window_too_short', 'Window too short', false, 30),
  ('019a0000-c013-7000-8001-000000001018', 'pickup_reject_reasons', 'other', 'Other', true, 40),
  ('019a0000-c013-7000-8001-000000001019', 'partner_suspend_reasons', 'credit_hold', 'Credit hold', false, 10),
  ('019a0000-c013-7000-8001-000000001020', 'partner_suspend_reasons', 'agreement_ended', 'Agreement ended', false, 20),
  ('019a0000-c013-7000-8001-000000001021', 'partner_suspend_reasons', 'security_concern', 'Security concern', false, 30),
  ('019a0000-c013-7000-8001-000000001022', 'partner_suspend_reasons', 'other', 'Other', true, 40),
  ('019a0000-c013-7000-8001-000000001023', 'partner_user_deactivate_reasons', 'left_organisation', 'Left organisation', false, 10),
  ('019a0000-c013-7000-8001-000000001024', 'partner_user_deactivate_reasons', 'role_changed', 'Role changed', false, 20),
  ('019a0000-c013-7000-8001-000000001025', 'partner_user_deactivate_reasons', 'security_concern', 'Security concern', false, 30),
  ('019a0000-c013-7000-8001-000000001026', 'partner_user_deactivate_reasons', 'other', 'Other', true, 40),
  ('019a0000-c013-7000-8001-000000001027', 'referrer_mapping_reject_reasons', 'not_identifiable', 'Cannot identify this doctor', false, 10),
  ('019a0000-c013-7000-8001-000000001028', 'referrer_mapping_reject_reasons', 'duplicate_entry', 'Duplicate entry', false, 20),
  ('019a0000-c013-7000-8001-000000001029', 'referrer_mapping_reject_reasons', 'other', 'Other', true, 30);
