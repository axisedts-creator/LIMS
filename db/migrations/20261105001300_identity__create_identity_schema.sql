-- T0B-10.C2: identity schema (C2 05-SCHEMA §4, §5, §8, §10.1 verbatim; the §10.1 DO loops written out as literal statements [CONV],
-- row-audit triggers per §3). The §6 DEFINERs exist since T0B-06 (20261105000800_app__create_identity_definers.sql);
-- app.identity_is_breached is created here (CR-C0-T0B-06). The §10.2 core.tenants __platform policies are in
-- 20261105001400_core__create_tenant_platform_policies.sql.
SET LOCAL ROLE lims_owner;

CREATE SCHEMA IF NOT EXISTS identity AUTHORIZATION lims_owner;

-- 4.8 global registry -------------------------------------------------------
CREATE TABLE identity.g_feature_flags (
  code                      text        NOT NULL,
  description               text        NOT NULL,
  scope                     text        NOT NULL,
  settable_by               text        NOT NULL,
  requires_founder_approval boolean     NOT NULL,
  default_enabled           boolean     NOT NULL,
  blocker_ref               text,
  is_active                 boolean     NOT NULL DEFAULT true,
  created_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT g_feature_flags__pk PRIMARY KEY (code),
  CONSTRAINT g_feature_flags__code__ck CHECK (code ~ '^[a-z][a-z0-9_]{2,63}$'),
  CONSTRAINT g_feature_flags__scope__ck CHECK (scope IN ('tenant','platform')),
  CONSTRAINT g_feature_flags__settable_by__ck CHECK (settable_by IN ('tenant','platform')),
  CONSTRAINT g_feature_flags__blocker_ref__ck CHECK (blocker_ref IS NULL OR blocker_ref ~ '^B[0-9]{1,2}$')
);
INSERT INTO identity.g_feature_flags (code, description, scope, settable_by, requires_founder_approval, default_enabled, blocker_ref) VALUES
 ('whatsapp_pdf_attachment','Send report PDF as WhatsApp attachment (needs patient consent)','tenant','platform',true,false,'B11'),
 ('smart_report_llm','Optional LLM fluency layer for smart reports','tenant','platform',true,false,'B11'),
 ('breached_password_online_check','Online breached-password range check (foreign call)','platform','platform',true,false,'B11'),
 ('referral_incentive_report','Show referral-incentive report (reporting only, never "commission")','tenant','tenant',false,false,'B13'),
 ('smart_report','Smart report (patient-friendly summary; per-summary pathologist approval)','tenant','tenant',false,false,NULL);   -- CR-C14-005; off by default (08 R17)

-- 4.9 breached passwords ------------------------------------------------------
CREATE TABLE identity.g_breached_passwords (
  sha1         bytea       NOT NULL,
  list_version text        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT g_breached_passwords__pk PRIMARY KEY (sha1),
  CONSTRAINT g_breached_passwords__sha1_len__ck CHECK (octet_length(sha1) = 20)
);

-- 4.5 platform staff ------------------------------------------------------------
CREATE TABLE identity.platform_staff (
  id               uuid        NOT NULL,
  user_id          uuid        NOT NULL,
  email_normalized text        NOT NULL,
  display_name     text        NOT NULL,
  role_code        text        NOT NULL,
  allowed_cidrs    cidr[]      NOT NULL DEFAULT '{}',
  last_login_at    timestamptz,
  is_active        boolean     NOT NULL DEFAULT true,
  version          integer     NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid        NOT NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid        NOT NULL,
  CONSTRAINT platform_staff__pk PRIMARY KEY (id),
  CONSTRAINT platform_staff__user_id__uq UNIQUE (user_id),
  CONSTRAINT platform_staff__role_code__ck CHECK (role_code IN ('platform_superadmin','platform_support')),
  CONSTRAINT platform_staff__email__ck CHECK (char_length(email_normalized) BETWEEN 3 AND 254),
  CONSTRAINT platform_staff__display_name__ck CHECK (char_length(display_name) BETWEEN 1 AND 120),
  CONSTRAINT platform_staff__cidrs__ck CHECK (cardinality(allowed_cidrs) <= 20)
);

-- 4.11 support sessions ----------------------------------------------------------
CREATE TABLE identity.support_sessions (
  id                        uuid        NOT NULL,
  tenant_id                 uuid        NOT NULL,
  platform_staff_id         uuid        NOT NULL,
  scope                     text        NOT NULL,
  reason_text               text        NOT NULL,
  ticket_ref                text        NOT NULL,
  duration_minutes          integer     NOT NULL,
  status                    text        NOT NULL,
  requested_at              timestamptz NOT NULL DEFAULT now(),
  decided_at                timestamptz,
  decided_by_membership_id  uuid,
  decision_note             text,
  started_at                timestamptz,
  expires_at                timestamptz,
  ended_at                  timestamptz,
  ended_by                  uuid,
  end_reason                text,
  version                   integer     NOT NULL DEFAULT 1,
  created_at                timestamptz NOT NULL DEFAULT now(),
  created_by                uuid        NOT NULL,
  updated_at                timestamptz NOT NULL DEFAULT now(),
  updated_by                uuid        NOT NULL,
  CONSTRAINT support_sessions__pk PRIMARY KEY (id),
  CONSTRAINT support_sessions__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT support_sessions__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT support_sessions__staff__fk FOREIGN KEY (platform_staff_id) REFERENCES identity.platform_staff (id),
  CONSTRAINT support_sessions__decider__fk FOREIGN KEY (tenant_id, decided_by_membership_id) REFERENCES core.memberships (tenant_id, id),
  CONSTRAINT support_sessions__scope__ck CHECK (scope IN ('read_only','admin')),
  CONSTRAINT support_sessions__status__ck CHECK (status IN ('requested','approved','denied','active','ended','expired','revoked')),
  CONSTRAINT support_sessions__reason__ck CHECK (char_length(reason_text) BETWEEN 10 AND 500),
  CONSTRAINT support_sessions__ticket__ck CHECK (char_length(ticket_ref) BETWEEN 1 AND 60),
  CONSTRAINT support_sessions__duration__ck CHECK (duration_minutes BETWEEN 5 AND 60),
  CONSTRAINT support_sessions__active_times__ck CHECK (status <> 'active' OR (started_at IS NOT NULL AND expires_at IS NOT NULL)),
  CONSTRAINT support_sessions__end_reason__ck CHECK (end_reason IS NULL OR end_reason IN
     ('ended_by_staff','expired','revoked_by_tenant','superseded','platform_logout','denied'))
);
CREATE INDEX support_sessions__tenant_id_status_requested_at__idx ON identity.support_sessions (tenant_id, status, requested_at DESC);
CREATE INDEX support_sessions__tenant_id_expires_at__p_idx ON identity.support_sessions (tenant_id, expires_at) WHERE status = 'active';
CREATE INDEX support_sessions__platform_staff_id_status__idx ON identity.support_sessions (platform_staff_id, status);

-- 4.1 sessions ------------------------------------------------------------------
CREATE TABLE identity.sessions (
  id                   uuid        NOT NULL,
  tenant_id            uuid,
  kind                 text        NOT NULL,
  user_id              uuid        NOT NULL,
  membership_id        uuid,
  platform_staff_id    uuid,
  gotrue_session_id    uuid        NOT NULL,
  token_sha256         bytea       NOT NULL,
  previous_token_sha256 bytea,                                                     -- CR-C2-018 (08 A3.1): rotated-out app token, one kept
  state                text        NOT NULL,
  aal                  text        NOT NULL DEFAULT 'aal1',
  refresh_token_enc    bytea       NOT NULL,
  access_token_enc     bytea       NOT NULL,
  enc_key_id           text        NOT NULL,
  access_expires_at    timestamptz NOT NULL,
  idle_timeout_minutes integer     NOT NULL,
  last_seen_at         timestamptz NOT NULL DEFAULT now(),
  idle_expires_at      timestamptz NOT NULL,
  absolute_expires_at  timestamptz NOT NULL,
  mfa_failed_attempts  integer     NOT NULL DEFAULT 0,
  support_session_id   uuid,
  app_instance_id      uuid,                                                       -- patient / staff_mobile only (08 R10)
  app_platform         text,
  client_ip            inet,
  user_agent           text,
  revoked_at           timestamptz,
  revoked_by           uuid,
  revoke_reason        text,
  expires_at           timestamptz NOT NULL,
  version              integer     NOT NULL DEFAULT 1,
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_by           uuid        NOT NULL,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  updated_by           uuid        NOT NULL,
  CONSTRAINT sessions__pk PRIMARY KEY (id),
  CONSTRAINT sessions__token_sha256__uq UNIQUE (token_sha256),               -- CR-C2-017 exception
  CONSTRAINT sessions__gotrue_session_id__uq UNIQUE (gotrue_session_id),     -- CR-C2-017 exception
  CONSTRAINT sessions__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT sessions__membership__fk FOREIGN KEY (tenant_id, membership_id) REFERENCES core.memberships (tenant_id, id),
  CONSTRAINT sessions__platform_staff__fk FOREIGN KEY (platform_staff_id) REFERENCES identity.platform_staff (id),
  CONSTRAINT sessions__support__fk FOREIGN KEY (support_session_id) REFERENCES identity.support_sessions (id),
  CONSTRAINT sessions__kind__ck CHECK (kind IN ('tenant_staff','platform','partner','patient','staff_mobile')),   -- 08 R10
  CONSTRAINT sessions__kind_shape__ck CHECK (
       (kind IN ('tenant_staff','partner','patient','staff_mobile')
          AND tenant_id IS NOT NULL AND membership_id IS NOT NULL AND platform_staff_id IS NULL AND support_session_id IS NULL)
    OR (kind = 'platform'     AND tenant_id IS NULL     AND membership_id IS NULL     AND platform_staff_id IS NOT NULL)),
  CONSTRAINT sessions__app__ck CHECK ((kind IN ('patient','staff_mobile')) = (app_instance_id IS NOT NULL AND app_platform IS NOT NULL)
                                      AND (app_platform IS NULL OR app_platform IN ('android','ios'))),
  CONSTRAINT sessions__patient_aal__ck CHECK (kind <> 'patient' OR aal = 'aal1'),
  CONSTRAINT sessions__state__ck CHECK (state IN ('password_setup','mfa_pending','mfa_enrolment_required','active','revoked','expired')),
  CONSTRAINT sessions__aal__ck CHECK (aal IN ('aal1','aal2')),
  CONSTRAINT sessions__token_len__ck CHECK (octet_length(token_sha256) = 32),
  CONSTRAINT sessions__previous_token_len__ck CHECK (previous_token_sha256 IS NULL OR octet_length(previous_token_sha256) = 32),   -- CR-C2-018
  CONSTRAINT sessions__idle__ck CHECK (
       (kind IN ('tenant_staff','platform','partner') AND idle_timeout_minutes BETWEEN 15 AND 30)    -- 04 A8
    OR (kind = 'patient'      AND idle_timeout_minutes BETWEEN 1440 AND 43200)                       -- 1–30 d (08 R10)
    OR (kind = 'staff_mobile' AND idle_timeout_minutes BETWEEN 60 AND 720)),                           -- no idle timeout: service sets = configured absolute (04 A16)
  CONSTRAINT sessions__absolute__ck CHECK (
       (kind <> 'patient' AND absolute_expires_at <= created_at + interval '12 hours')               -- 04 A8
    OR (kind = 'patient'  AND absolute_expires_at <= created_at + interval '90 days')),              -- tenant-configurable 1–90 d (08 R10)
  CONSTRAINT sessions__mfa_attempts__ck CHECK (mfa_failed_attempts BETWEEN 0 AND 5),
  CONSTRAINT sessions__ua__ck CHECK (user_agent IS NULL OR char_length(user_agent) <= 512),
  CONSTRAINT sessions__revoke__ck CHECK ((state = 'revoked') = (revoked_at IS NOT NULL AND revoke_reason IS NOT NULL)),
  CONSTRAINT sessions__revoke_reason__ck CHECK (revoke_reason IS NULL OR revoke_reason IN
     ('logout','admin_revoke','self_revoke','password_change','role_change','lock','deactivate','tenant_suspended',
      'mfa_failed','mfa_reset','refresh_failed','superseded','token_reuse'))
);
CREATE INDEX sessions__tenant_id_membership_id_state__idx ON identity.sessions (tenant_id, membership_id, state);
CREATE INDEX sessions__tenant_id_last_seen_at__p_idx ON identity.sessions (tenant_id, last_seen_at DESC)
  WHERE state IN ('password_setup','mfa_pending','mfa_enrolment_required','active');
CREATE INDEX sessions__platform_staff_id_state__p_idx ON identity.sessions (platform_staff_id, state) WHERE kind = 'platform';
CREATE INDEX sessions__expires_at__idx ON identity.sessions (expires_at);
CREATE UNIQUE INDEX sessions__previous_token_sha256__p_uq ON identity.sessions (previous_token_sha256)
  WHERE previous_token_sha256 IS NOT NULL;                                         -- CR-C2-018 exception (index-exceptions.yaml; 08 A3.1)

-- 4.2 mfa factors ------------------------------------------------------------------
CREATE TABLE identity.mfa_factors (
  id               uuid        NOT NULL,
  tenant_id        uuid,
  user_id          uuid        NOT NULL,
  gotrue_factor_id uuid        NOT NULL,
  factor_type      text        NOT NULL DEFAULT 'totp',
  status           text        NOT NULL,
  friendly_name    text,
  verified_at      timestamptz,
  removed_at       timestamptz,
  removed_by       uuid,
  removal_reason   text,
  is_active        boolean     NOT NULL DEFAULT true,
  version          integer     NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid        NOT NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid        NOT NULL,
  CONSTRAINT mfa_factors__pk PRIMARY KEY (id),
  CONSTRAINT mfa_factors__tenant_id_gotrue_factor_id__uq UNIQUE NULLS NOT DISTINCT (tenant_id, gotrue_factor_id),
  CONSTRAINT mfa_factors__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT mfa_factors__type__ck CHECK (factor_type IN ('totp')),
  CONSTRAINT mfa_factors__status__ck CHECK (status IN ('unverified','verified','removed')),
  CONSTRAINT mfa_factors__name__ck CHECK (friendly_name IS NULL OR char_length(friendly_name) <= 40),
  CONSTRAINT mfa_factors__removal__ck CHECK (removal_reason IS NULL OR removal_reason IN ('self','admin_reset','re_enrol'))
);
CREATE INDEX mfa_factors__tenant_id_user_id_status__idx ON identity.mfa_factors (tenant_id, user_id, status);

-- 4.3 auth events (append-only) --------------------------------------------------
CREATE TABLE identity.auth_events (
  id                uuid        NOT NULL,
  tenant_id         uuid,
  user_id           uuid,
  membership_id     uuid,
  platform_staff_id uuid,
  session_id        uuid,
  event_type        text        NOT NULL,
  reason_code       text,
  email_hmac        bytea,
  client_ip         inet,
  user_agent        text,
  request_id        uuid,
  occurred_at       timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid        NOT NULL,
  CONSTRAINT auth_events__pk PRIMARY KEY (id),
  CONSTRAINT auth_events__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT auth_events__type__ck CHECK (event_type IN (
    'login_failed','login_password_ok','login_succeeded','login_step_up_required','login_rate_limited',
    'login_blocked_locked','login_blocked_inactive','login_blocked_tenant_suspended','login_blocked_ip',
    'mfa_verified','mfa_challenge_failed','mfa_enrolled','mfa_factor_removed','mfa_reset',
    'password_changed','password_reset_requested','recovery_link_opened','password_reset_completed',
    'invite_sent','invite_link_opened','invite_accepted','session_revoked','session_expired_idle',
    'session_expired_absolute','logout','refresh_failed','account_locked','account_unlocked',
    'membership_deactivated','membership_reactivated','login_ip_throttled','session_token_reused')),
  CONSTRAINT auth_events__hmac_len__ck CHECK (email_hmac IS NULL OR octet_length(email_hmac) = 32),
  CONSTRAINT auth_events__ua__ck CHECK (user_agent IS NULL OR char_length(user_agent) <= 512)
);
CREATE INDEX auth_events__tenant_id_occurred_at__idx ON identity.auth_events (tenant_id, occurred_at DESC, id DESC);
CREATE INDEX auth_events__tenant_id_membership_id_occurred_at__idx ON identity.auth_events (tenant_id, membership_id, occurred_at DESC);
CREATE INDEX auth_events__tenant_id_event_type_occurred_at__idx ON identity.auth_events (tenant_id, event_type, occurred_at DESC);
CREATE INDEX auth_events__occurred_at__idx ON identity.auth_events (occurred_at DESC, id DESC);   -- index-rule exception: platform-wide PL-8 list (index-exceptions.yaml)

-- 4.4 invitations -----------------------------------------------------------------------
CREATE TABLE identity.invitations (
  id                uuid        NOT NULL,
  tenant_id         uuid,
  user_id           uuid        NOT NULL,
  membership_id     uuid,
  platform_staff_id uuid,
  email             text,
  status            text        NOT NULL,
  attempt_no        integer     NOT NULL DEFAULT 1,
  issued_at         timestamptz,
  expires_at        timestamptz NOT NULL,
  accepted_at       timestamptz,
  last_error_code   text,
  invited_by        uuid        NOT NULL,
  version           integer     NOT NULL DEFAULT 1,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid        NOT NULL,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  updated_by        uuid        NOT NULL,
  CONSTRAINT invitations__pk PRIMARY KEY (id),
  CONSTRAINT invitations__tenant_id_id__uq UNIQUE NULLS NOT DISTINCT (tenant_id, id),
  CONSTRAINT invitations__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT invitations__membership__fk FOREIGN KEY (tenant_id, membership_id) REFERENCES core.memberships (tenant_id, id),
  CONSTRAINT invitations__staff__fk FOREIGN KEY (platform_staff_id) REFERENCES identity.platform_staff (id),
  CONSTRAINT invitations__shape__ck CHECK (
       (tenant_id IS NOT NULL AND membership_id IS NOT NULL AND platform_staff_id IS NULL)
    OR (tenant_id IS NULL AND membership_id IS NULL AND platform_staff_id IS NOT NULL)),
  CONSTRAINT invitations__status__ck CHECK (status IN ('pending','sent','accepted','expired','revoked','failed')),
  CONSTRAINT invitations__email__ck CHECK (email IS NULL OR char_length(email) BETWEEN 3 AND 254),
  CONSTRAINT invitations__email_present__ck CHECK (email IS NOT NULL OR status IN ('accepted','expired','revoked','failed'))
);
CREATE INDEX invitations__tenant_id_membership_id__idx ON identity.invitations (tenant_id, membership_id);
CREATE INDEX invitations__tenant_id_status_expires_at__idx ON identity.invitations (tenant_id, status, expires_at);

-- 4.10 branding assets ---------------------------------------------------------------------
CREATE TABLE identity.branding_assets (
  id            uuid        NOT NULL,
  tenant_id     uuid        NOT NULL,
  kind          text        NOT NULL,
  membership_id uuid,
  bucket        text        NOT NULL DEFAULT 'identity-assets',
  object_path   text        NOT NULL,
  content_type  text        NOT NULL,
  size_bytes    integer     NOT NULL,
  width_px      integer     NOT NULL,
  height_px     integer     NOT NULL,
  sha256        bytea       NOT NULL,
  is_active     boolean     NOT NULL DEFAULT true,
  scan_state    text        NOT NULL DEFAULT 'pending',                         -- 08 A17 P-19
  version       integer     NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid        NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid        NOT NULL,
  CONSTRAINT branding_assets__pk PRIMARY KEY (id),
  CONSTRAINT branding_assets__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT branding_assets__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT branding_assets__membership__fk FOREIGN KEY (tenant_id, membership_id) REFERENCES core.memberships (tenant_id, id),
  CONSTRAINT branding_assets__kind__ck CHECK (kind IN ('logo','letterhead_header','letterhead_footer','signature')),
  CONSTRAINT branding_assets__sig_member__ck CHECK ((kind = 'signature') = (membership_id IS NOT NULL)),
  CONSTRAINT branding_assets__bucket__ck CHECK (bucket = 'identity-assets'),          -- 08 R26
  CONSTRAINT branding_assets__path__ck CHECK (split_part(object_path, '/', 1) = tenant_id::text),
  CONSTRAINT branding_assets__ctype__ck CHECK (content_type IN ('image/png','image/jpeg')),
  CONSTRAINT branding_assets__size__ck CHECK (size_bytes BETWEEN 1 AND 2097152
                                              AND (kind <> 'signature' OR size_bytes <= 1048576)),
  CONSTRAINT branding_assets__dims__ck CHECK (width_px BETWEEN 1 AND 4000 AND height_px BETWEEN 1 AND 4000),
  CONSTRAINT branding_assets__sha__ck CHECK (octet_length(sha256) = 32),
  CONSTRAINT branding_assets__scan_state__ck CHECK (scan_state IN ('pending','clean','quarantined'))
);
CREATE INDEX branding_assets__tenant_id_kind_is_active__idx ON identity.branding_assets (tenant_id, kind, is_active);
CREATE INDEX branding_assets__tenant_id_membership_id__p_idx ON identity.branding_assets (tenant_id, membership_id) WHERE membership_id IS NOT NULL;
CREATE TRIGGER branding_assets__mutable_columns BEFORE UPDATE ON identity.branding_assets
  FOR EACH ROW EXECUTE FUNCTION app.enforce_mutable_columns('is_active','scan_state','updated_at','updated_by','version');

-- 4.12–4.14 IRD annex tracker -------------------------------------------------------------
CREATE TABLE identity.ird_annex_records (
  id                uuid        NOT NULL,
  tenant_id         uuid,
  annex_code        text        NOT NULL,
  status            text        NOT NULL DEFAULT 'not_started',
  reference_no      text,
  office_name       text,
  counterparty_name text,
  software_version  text,
  submitted_on      date,
  completed_on      date,
  notes             text,
  supersedes_id     uuid,
  is_active         boolean     NOT NULL DEFAULT true,
  version           integer     NOT NULL DEFAULT 1,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid        NOT NULL,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  updated_by        uuid        NOT NULL,
  CONSTRAINT ird_annex_records__pk PRIMARY KEY (id),
  CONSTRAINT ird_annex_records__tenant_id_id__uq UNIQUE NULLS NOT DISTINCT (tenant_id, id),
  CONSTRAINT ird_annex_records__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT ird_annex_records__supersedes__fk FOREIGN KEY (supersedes_id) REFERENCES identity.ird_annex_records (id),
  CONSTRAINT ird_annex_records__code__ck CHECK (annex_code IN ('annex_1','annex_2','annex_3','annex_7')),
  CONSTRAINT ird_annex_records__platform_level__ck CHECK ((annex_code = 'annex_1') = (tenant_id IS NULL)),
  CONSTRAINT ird_annex_records__status__ck CHECK (status IN ('not_started','in_preparation','submitted','completed','rejected','superseded')),
  CONSTRAINT ird_annex_records__submitted__ck CHECK (status NOT IN ('submitted','completed','rejected') OR submitted_on IS NOT NULL),
  CONSTRAINT ird_annex_records__completed__ck CHECK (status <> 'completed' OR (completed_on IS NOT NULL AND reference_no IS NOT NULL)),
  CONSTRAINT ird_annex_records__dates__ck CHECK (completed_on IS NULL OR submitted_on IS NULL OR completed_on >= submitted_on),
  CONSTRAINT ird_annex_records__lengths__ck CHECK (
        coalesce(char_length(reference_no),0) <= 100 AND coalesce(char_length(office_name),0) <= 200
    AND coalesce(char_length(counterparty_name),0) <= 200 AND coalesce(char_length(software_version),0) <= 40
    AND coalesce(char_length(notes),0) <= 2000)
);
CREATE UNIQUE INDEX ird_annex_records__tenant_id_annex_code__p_uq ON identity.ird_annex_records (tenant_id, annex_code)
  WHERE status <> 'superseded' AND tenant_id IS NOT NULL;
CREATE INDEX ird_annex_records__annex_code_status__p_idx ON identity.ird_annex_records (annex_code, status, created_at DESC)
  WHERE tenant_id IS NULL;

CREATE TABLE identity.ird_annex_events (
  id          uuid        NOT NULL,
  tenant_id   uuid,
  record_id   uuid        NOT NULL,
  from_status text,
  to_status   text        NOT NULL,
  note        text,
  actor_id    uuid        NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid        NOT NULL,
  CONSTRAINT ird_annex_events__pk PRIMARY KEY (id),
  CONSTRAINT ird_annex_events__record__fk FOREIGN KEY (tenant_id, record_id) REFERENCES identity.ird_annex_records (tenant_id, id),
  CONSTRAINT ird_annex_events__record_id__fk FOREIGN KEY (record_id) REFERENCES identity.ird_annex_records (id),  -- enforces platform rows (tenant_id NULL, MATCH SIMPLE)
  CONSTRAINT ird_annex_events__note__ck CHECK (note IS NULL OR char_length(note) <= 1000)
);
CREATE INDEX ird_annex_events__record_id_occurred_at__idx ON identity.ird_annex_events (record_id, occurred_at);
CREATE INDEX ird_annex_events__tenant_id_occurred_at__idx ON identity.ird_annex_events (tenant_id, occurred_at DESC);

CREATE TABLE identity.ird_annex_documents (
  id                uuid        NOT NULL,
  tenant_id         uuid,
  record_id         uuid        NOT NULL,
  bucket            text        NOT NULL DEFAULT 'identity-assets',
  object_path       text        NOT NULL,
  original_filename text        NOT NULL,
  content_type      text        NOT NULL,
  size_bytes        integer     NOT NULL,
  sha256            bytea       NOT NULL,
  scan_state        text        NOT NULL DEFAULT 'pending',                     -- 08 A17 P-19
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid        NOT NULL,
  CONSTRAINT ird_annex_documents__pk PRIMARY KEY (id),
  CONSTRAINT ird_annex_documents__record__fk FOREIGN KEY (tenant_id, record_id) REFERENCES identity.ird_annex_records (tenant_id, id),
  CONSTRAINT ird_annex_documents__record_id__fk FOREIGN KEY (record_id) REFERENCES identity.ird_annex_records (id),
  CONSTRAINT ird_annex_documents__path__ck CHECK (split_part(object_path,'/',1) = coalesce(tenant_id::text, 'platform')),
  CONSTRAINT ird_annex_documents__ctype__ck CHECK (content_type IN ('application/pdf','image/png','image/jpeg')),
  CONSTRAINT ird_annex_documents__size__ck CHECK (size_bytes BETWEEN 1 AND 15728640),
  CONSTRAINT ird_annex_documents__name__ck CHECK (char_length(original_filename) BETWEEN 1 AND 200),
  CONSTRAINT ird_annex_documents__sha__ck CHECK (octet_length(sha256) = 32),
  CONSTRAINT ird_annex_documents__scan_state__ck CHECK (scan_state IN ('pending','clean','quarantined'))
);
CREATE INDEX ird_annex_documents__record_id_created_at__idx ON identity.ird_annex_documents (record_id, created_at);
CREATE TRIGGER ird_annex_documents__mutable_columns BEFORE UPDATE ON identity.ird_annex_documents
  FOR EACH ROW EXECUTE FUNCTION app.enforce_mutable_columns('scan_state');          -- only the P-19 scan outcome may change

-- 4.6 tenant settings ----------------------------------------------------------------------------
CREATE TABLE identity.tenant_settings (
  tenant_id                       uuid        NOT NULL,
  calendar_display                text        NOT NULL DEFAULT 'AD',
  timezone                        text        NOT NULL DEFAULT 'Asia/Kathmandu',
  idle_timeout_minutes            integer     NOT NULL DEFAULT 15,
  absolute_session_hours          integer     NOT NULL DEFAULT 12,
  password_min_length             integer     NOT NULL DEFAULT 12,
  support_access_mode             text        NOT NULL DEFAULT 'notify',
  report_link_ttl_days            integer     NOT NULL DEFAULT 30,
  release_requires_payment        boolean     NOT NULL DEFAULT true,
  partial_release_allowed         boolean     NOT NULL DEFAULT false,
  letterhead_default              text        NOT NULL DEFAULT 'with',
  numbering_prefix                text        NOT NULL DEFAULT '',
  patient_code_pattern            text        NOT NULL DEFAULT '{prefix}{seq:8}',
  registration_no_pattern         text        NOT NULL DEFAULT '{branch}{prefix}{seq:6}',
  barcode_pattern                 text        NOT NULL DEFAULT '{prefix}{yy}{seq:8}',                -- 08 A13 D-8
  invoice_no_pattern              text        NOT NULL DEFAULT '{fy}-{seq:6}',
  credit_note_no_pattern          text        NOT NULL DEFAULT 'CN-{fy}-{seq:6}',
  receipt_no_pattern              text        NOT NULL DEFAULT 'RC-{fy}-{seq:6}',
  barcode_prefix                  text,
  accession_no_pattern            text        NOT NULL DEFAULT '{prefix}{yy}-{seq:4}',
  accession_prefix_histology      text        NOT NULL DEFAULT 'S',
  accession_prefix_cytology       text        NOT NULL DEFAULT 'C',
  accession_prefix_ihc            text        NOT NULL DEFAULT 'I',
  accession_prefix_molecular      text        NOT NULL DEFAULT 'M',
  pending_invoice_no_pattern      text,
  pending_credit_note_no_pattern  text,
  pending_effective_fy_bs         text,
  whatsapp_enabled                boolean     NOT NULL DEFAULT false,
  sms_enabled                     boolean     NOT NULL DEFAULT false,
  email_enabled                   boolean     NOT NULL DEFAULT false,
  sms_sender_id                   text,
  retention_clinical_years        integer     NOT NULL DEFAULT 5,
  retention_audit_years           integer     NOT NULL DEFAULT 5,
  retention_raw_instrument_years  integer     NOT NULL DEFAULT 1,
  auto_verification_enabled       boolean     NOT NULL DEFAULT false,
  westgard_mode                   text        NOT NULL DEFAULT 'classic',
  ird_pan                         text,
  cbms_realtime_required          boolean     NOT NULL DEFAULT false,
  abbreviated_invoice_limit_paisa bigint,
  ird_annex_1_record_id           uuid,
  legal_name_snapshot             text        NOT NULL,
  display_name                    text        NOT NULL,
  address_lines                   text[]      NOT NULL DEFAULT '{}',
  phones                          text[]      NOT NULL DEFAULT '{}',
  contact_email                   text,
  website                         text,
  logo_asset_id                   uuid,
  letterhead_header_asset_id      uuid,
  letterhead_footer_asset_id      uuid,
  receipt_footer_note             text,
  accent_color                    text,
  version                         integer     NOT NULL DEFAULT 1,
  created_at                      timestamptz NOT NULL DEFAULT now(),
  created_by                      uuid        NOT NULL,
  updated_at                      timestamptz NOT NULL DEFAULT now(),
  updated_by                      uuid        NOT NULL,
  CONSTRAINT tenant_settings__pk PRIMARY KEY (tenant_id),
  CONSTRAINT tenant_settings__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT tenant_settings__logo__fk FOREIGN KEY (tenant_id, logo_asset_id) REFERENCES identity.branding_assets (tenant_id, id),
  CONSTRAINT tenant_settings__lh_header__fk FOREIGN KEY (tenant_id, letterhead_header_asset_id) REFERENCES identity.branding_assets (tenant_id, id),
  CONSTRAINT tenant_settings__lh_footer__fk FOREIGN KEY (tenant_id, letterhead_footer_asset_id) REFERENCES identity.branding_assets (tenant_id, id),
  CONSTRAINT tenant_settings__annex1__fk FOREIGN KEY (ird_annex_1_record_id) REFERENCES identity.ird_annex_records (id),
  CONSTRAINT tenant_settings__calendar__ck CHECK (calendar_display IN ('AD','BS','AD_BS','BS_AD')),
  CONSTRAINT tenant_settings__timezone__ck CHECK (timezone = 'Asia/Kathmandu'),                -- v1 only (08 A13 P-15)
  CONSTRAINT tenant_settings__idle__ck CHECK (idle_timeout_minutes BETWEEN 15 AND 30),            -- 04 A8
  CONSTRAINT tenant_settings__absolute__ck CHECK (absolute_session_hours BETWEEN 1 AND 12),        -- 04 A8
  CONSTRAINT tenant_settings__pwlen__ck CHECK (password_min_length BETWEEN 12 AND 64),            -- 04 A3
  CONSTRAINT tenant_settings__support_mode__ck CHECK (support_access_mode IN ('notify','approval_required')),
  CONSTRAINT tenant_settings__link_ttl__ck CHECK (report_link_ttl_days BETWEEN 30 AND 90),        -- 04 A10
  CONSTRAINT tenant_settings__letterhead__ck CHECK (letterhead_default IN ('with','without')),
  CONSTRAINT tenant_settings__prefix__ck CHECK (numbering_prefix ~ '^[A-Z0-9]{0,8}$'),
  CONSTRAINT tenant_settings__patterns_len__ck CHECK (
        char_length(patient_code_pattern) <= 40 AND char_length(registration_no_pattern) <= 40
    AND char_length(barcode_pattern) <= 40 AND char_length(invoice_no_pattern) <= 40
    AND char_length(credit_note_no_pattern) <= 40 AND char_length(receipt_no_pattern) <= 40
    AND char_length(accession_no_pattern) <= 40),
  CONSTRAINT tenant_settings__prefixes4__ck CHECK (
        (barcode_prefix IS NULL OR barcode_prefix ~ '^[A-Z0-9]{0,4}$')
    AND accession_prefix_histology ~ '^[A-Z0-9]{0,4}$' AND accession_prefix_cytology ~ '^[A-Z0-9]{0,4}$'
    AND accession_prefix_ihc ~ '^[A-Z0-9]{0,4}$' AND accession_prefix_molecular ~ '^[A-Z0-9]{0,4}$'),   -- CR-C5-009, CR-C11-005
  CONSTRAINT tenant_settings__fiscal_patterns__ck CHECK (
        invoice_no_pattern ~ '\{fyl?\}' AND credit_note_no_pattern ~ '\{fyl?\}' AND receipt_no_pattern ~ '\{fyl?\}'
    AND (pending_invoice_no_pattern IS NULL OR pending_invoice_no_pattern ~ '\{fyl?\}')
    AND (pending_credit_note_no_pattern IS NULL OR pending_credit_note_no_pattern ~ '\{fyl?\}')),
  CONSTRAINT tenant_settings__registration_branch__ck CHECK (registration_no_pattern LIKE '%{branch}%'),
  CONSTRAINT tenant_settings__pending_fy__ck CHECK (
        (pending_effective_fy_bs IS NULL) = (pending_invoice_no_pattern IS NULL AND pending_credit_note_no_pattern IS NULL)
    AND (pending_effective_fy_bs IS NULL OR pending_effective_fy_bs ~ '^[0-9]{4}/[0-9]{2}$')),
  CONSTRAINT tenant_settings__sender__ck CHECK (sms_sender_id IS NULL OR sms_sender_id ~ '^[A-Za-z0-9]{1,11}$'),
  CONSTRAINT tenant_settings__retention__ck CHECK (
        retention_clinical_years BETWEEN 5 AND 50 AND retention_audit_years BETWEEN 5 AND 50
    AND retention_raw_instrument_years BETWEEN 1 AND 50),                                          -- 04 I8 floors, B15
  CONSTRAINT tenant_settings__westgard__ck CHECK (westgard_mode IN ('classic','modern')),
  CONSTRAINT tenant_settings__abbrev__ck CHECK (abbreviated_invoice_limit_paisa IS NULL OR abbreviated_invoice_limit_paisa >= 0),
  CONSTRAINT tenant_settings__names__ck CHECK (char_length(legal_name_snapshot) BETWEEN 1 AND 200 AND char_length(display_name) BETWEEN 1 AND 120),
  CONSTRAINT tenant_settings__contact__ck CHECK (
        cardinality(address_lines) <= 4 AND cardinality(phones) <= 3                                    -- 08 §4.12 (element lengths ≤120 / ≤40 validated by C2 and the trigger below)
    AND coalesce(char_length(contact_email),0) <= 254 AND (website IS NULL OR (website ~ '^https://' AND char_length(website) <= 200))
    AND coalesce(char_length(receipt_footer_note),0) <= 200
    AND (accent_color IS NULL OR accent_color ~ '^#[0-9A-Fa-f]{6}$'))
);

CREATE FUNCTION identity.tenant_settings__check_arrays() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM unnest(NEW.address_lines) l WHERE char_length(l) > 120)
     OR EXISTS (SELECT 1 FROM unnest(NEW.phones) p WHERE char_length(p) > 40) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'branding_line_too_long';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tenant_settings__check_arrays BEFORE INSERT OR UPDATE ON identity.tenant_settings
  FOR EACH ROW EXECUTE FUNCTION identity.tenant_settings__check_arrays();

-- 4.7 feature flags -----------------------------------------------------------------------------------
CREATE TABLE identity.feature_flags (
  tenant_id    uuid        NOT NULL,
  flag_code    text        NOT NULL,
  is_enabled   boolean     NOT NULL,
  approval_ref text,
  version      integer     NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid        NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   uuid        NOT NULL,
  CONSTRAINT feature_flags__pk PRIMARY KEY (tenant_id, flag_code),
  CONSTRAINT feature_flags__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT feature_flags__flag__fk FOREIGN KEY (flag_code) REFERENCES identity.g_feature_flags (code),
  CONSTRAINT feature_flags__approval_len__ck CHECK (approval_ref IS NULL OR char_length(approval_ref) BETWEEN 3 AND 200)
);
CREATE FUNCTION identity.feature_flags__check_approval() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.is_enabled AND NEW.approval_ref IS NULL AND EXISTS (
       SELECT 1 FROM identity.g_feature_flags g WHERE g.code = NEW.flag_code AND g.requires_founder_approval) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'feature_flag_requires_approval';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER feature_flags__check_approval BEFORE INSERT OR UPDATE ON identity.feature_flags
  FOR EACH ROW EXECUTE FUNCTION identity.feature_flags__check_approval();

-- 4.15 audit exports ----------------------------------------------------------------------------------
CREATE TABLE identity.audit_exports (
  id                          uuid        NOT NULL,
  tenant_id                   uuid        NOT NULL,
  requested_by_membership_id  uuid        NOT NULL,
  source                      text        NOT NULL,
  filters                     jsonb       NOT NULL,
  range_from                  timestamptz NOT NULL,
  range_to                    timestamptz NOT NULL,
  status                      text        NOT NULL DEFAULT 'queued',
  row_count                   integer,
  object_path                 text,
  sha256                      bytea,
  size_bytes                  bigint,
  downloads_remaining         integer     NOT NULL DEFAULT 3,
  ready_at                    timestamptz,
  expires_at                  timestamptz,
  last_downloaded_at          timestamptz,
  error_code                  text,
  version                     integer     NOT NULL DEFAULT 1,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  created_by                  uuid        NOT NULL,
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  updated_by                  uuid        NOT NULL,
  CONSTRAINT audit_exports__pk PRIMARY KEY (id),
  CONSTRAINT audit_exports__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT audit_exports__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT audit_exports__requester__fk FOREIGN KEY (tenant_id, requested_by_membership_id) REFERENCES core.memberships (tenant_id, id),
  CONSTRAINT audit_exports__source__ck CHECK (source IN ('audit_log','access_log','auth_events')),
  CONSTRAINT audit_exports__status__ck CHECK (status IN ('queued','building','ready','failed','expired')),
  CONSTRAINT audit_exports__range__ck CHECK (range_to > range_from AND range_to - range_from <= interval '31 days'),
  CONSTRAINT audit_exports__rows__ck CHECK (row_count IS NULL OR row_count BETWEEN 0 AND 500000),
  CONSTRAINT audit_exports__downloads__ck CHECK (downloads_remaining BETWEEN 0 AND 3),
  CONSTRAINT audit_exports__ready__ck CHECK (status <> 'ready' OR (object_path IS NOT NULL AND sha256 IS NOT NULL AND expires_at IS NOT NULL)),
  CONSTRAINT audit_exports__path__ck CHECK (object_path IS NULL OR split_part(object_path,'/',1) = tenant_id::text)
);
CREATE INDEX audit_exports__tenant_id_created_at__idx ON identity.audit_exports (tenant_id, created_at DESC);
CREATE INDEX audit_exports__tenant_id_requester_created_at__idx ON identity.audit_exports (tenant_id, requested_by_membership_id, created_at DESC);
CREATE INDEX audit_exports__status_expires_at__p_idx ON identity.audit_exports (expires_at) WHERE status = 'ready';

-- 4.16 access reviews ---------------------------------------------------------------------------------
CREATE TABLE identity.access_reviews (
  id                         uuid        NOT NULL,
  tenant_id                  uuid        NOT NULL,
  reviewed_by_membership_id  uuid        NOT NULL,
  memberships_reviewed       integer     NOT NULL,
  notes                      text,
  reviewed_at                timestamptz NOT NULL DEFAULT now(),
  created_at                 timestamptz NOT NULL DEFAULT now(),
  created_by                 uuid        NOT NULL,
  CONSTRAINT access_reviews__pk PRIMARY KEY (id),
  CONSTRAINT access_reviews__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT access_reviews__reviewer__fk FOREIGN KEY (tenant_id, reviewed_by_membership_id) REFERENCES core.memberships (tenant_id, id),
  CONSTRAINT access_reviews__count__ck CHECK (memberships_reviewed >= 0),
  CONSTRAINT access_reviews__notes__ck CHECK (notes IS NULL OR char_length(notes) <= 2000)
);
CREATE INDEX access_reviews__tenant_id_reviewed_at__idx ON identity.access_reviews (tenant_id, reviewed_at DESC);

-- 4.17 platform events --------------------------------------------------------------------------------
CREATE TABLE identity.platform_events (
  id                      uuid        NOT NULL,
  event_type              text        NOT NULL,
  target_type             text        NOT NULL,
  target_id               uuid,
  target_tenant_id        uuid,
  detail                  jsonb       NOT NULL DEFAULT '{}',
  actor_platform_staff_id uuid,
  request_id              uuid,
  client_ip               inet,
  occurred_at             timestamptz NOT NULL DEFAULT now(),
  created_at              timestamptz NOT NULL DEFAULT now(),
  created_by              uuid        NOT NULL,
  CONSTRAINT platform_events__pk PRIMARY KEY (id),
  CONSTRAINT platform_events__type__ck CHECK (event_type IN (
    'platform_staff_invited','platform_staff_changed','platform_staff_deactivated','platform_mfa_enrolled','platform_mfa_reset',   -- + platform_mfa_enrolled (08 A25 D-215)
    'platform_session_revoked','annex_1_changed','ird_document_downloaded','dead_letter_viewed','dead_letter_replayed','dead_letter_discarded',   -- + ird_document_downloaded [CONV]
    'bootstrap_admin_created','tenant_provisioned','tenant_status_changed','feature_flag_changed','support_session_changed')),
  CONSTRAINT platform_events__target_type__ck CHECK (char_length(target_type) BETWEEN 1 AND 40)
);
CREATE INDEX platform_events__occurred_at__idx ON identity.platform_events (occurred_at DESC);
CREATE INDEX platform_events__target_tenant_id_occurred_at__idx ON identity.platform_events (target_tenant_id, occurred_at DESC);

-- 4.18 admin notices ----------------------------------------------------------------------------------
CREATE TABLE identity.admin_notices (
  id                         uuid        NOT NULL,
  tenant_id                  uuid        NOT NULL,
  kind                       text        NOT NULL,
  subject_type               text        NOT NULL,
  subject_id                 uuid,                                              -- NULL only for login_ip_throttled (08 A25 D-217)
  created_for_membership_id  uuid,
  dismissed_by               uuid[]      NOT NULL DEFAULT '{}',
  expires_at                 timestamptz NOT NULL,
  version                    integer     NOT NULL DEFAULT 1,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  created_by                 uuid        NOT NULL,
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  updated_by                 uuid        NOT NULL,
  CONSTRAINT admin_notices__pk PRIMARY KEY (id),
  CONSTRAINT admin_notices__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT admin_notices__for__fk FOREIGN KEY (tenant_id, created_for_membership_id) REFERENCES core.memberships (tenant_id, id),
  CONSTRAINT admin_notices__kind__ck CHECK (kind IN ('support_session_requested','support_session_started','audit_export_created','access_review_due',
                                                   'login_ip_throttled')),                             -- 08 Addendum A1
  CONSTRAINT admin_notices__subject__ck CHECK (subject_type IN ('support_session','audit_export','access_review','auth_event')
                                               AND (subject_id IS NOT NULL OR kind = 'login_ip_throttled'))
);
CREATE INDEX admin_notices__tenant_id_created_at__idx ON identity.admin_notices (tenant_id, created_at DESC);

-- RLS: enable + force on every non-g table --------------------------------------------------------------
ALTER TABLE identity.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE identity.mfa_factors ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.mfa_factors FORCE ROW LEVEL SECURITY;
ALTER TABLE identity.auth_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.auth_events FORCE ROW LEVEL SECURITY;
ALTER TABLE identity.invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.invitations FORCE ROW LEVEL SECURITY;
ALTER TABLE identity.platform_staff ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.platform_staff FORCE ROW LEVEL SECURITY;
ALTER TABLE identity.tenant_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.tenant_settings FORCE ROW LEVEL SECURITY;
ALTER TABLE identity.feature_flags ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.feature_flags FORCE ROW LEVEL SECURITY;
ALTER TABLE identity.branding_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.branding_assets FORCE ROW LEVEL SECURITY;
ALTER TABLE identity.support_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.support_sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE identity.ird_annex_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.ird_annex_records FORCE ROW LEVEL SECURITY;
ALTER TABLE identity.ird_annex_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.ird_annex_events FORCE ROW LEVEL SECURITY;
ALTER TABLE identity.ird_annex_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.ird_annex_documents FORCE ROW LEVEL SECURITY;
ALTER TABLE identity.audit_exports ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.audit_exports FORCE ROW LEVEL SECURITY;
ALTER TABLE identity.access_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.access_reviews FORCE ROW LEVEL SECURITY;
ALTER TABLE identity.platform_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.platform_events FORCE ROW LEVEL SECURITY;
ALTER TABLE identity.admin_notices ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.admin_notices FORCE ROW LEVEL SECURITY;

-- Tenant policies (§5.2): one generator, so the P-16 guard is in the predicate that is actually transcribed (08 A17 P-16).
-- pred_t = tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) — USING and WITH CHECK of EVERY __tenant policy.
-- expanded from the §10.1 generator loop (literal, so db/policies/identity.sql is a 1:1 copy; AC-0B-2.3)
CREATE POLICY sessions__select__tenant ON identity.sessions FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY sessions__insert__tenant ON identity.sessions FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY sessions__update__tenant ON identity.sessions FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY mfa_factors__select__tenant ON identity.mfa_factors FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY mfa_factors__insert__tenant ON identity.mfa_factors FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY mfa_factors__update__tenant ON identity.mfa_factors FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY auth_events__select__tenant ON identity.auth_events FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY auth_events__insert__tenant ON identity.auth_events FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY invitations__select__tenant ON identity.invitations FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY invitations__insert__tenant ON identity.invitations FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY invitations__update__tenant ON identity.invitations FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY tenant_settings__select__tenant ON identity.tenant_settings FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY tenant_settings__insert__tenant ON identity.tenant_settings FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY tenant_settings__update__tenant ON identity.tenant_settings FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY feature_flags__select__tenant ON identity.feature_flags FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY feature_flags__insert__tenant ON identity.feature_flags FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY feature_flags__update__tenant ON identity.feature_flags FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY branding_assets__select__tenant ON identity.branding_assets FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY branding_assets__insert__tenant ON identity.branding_assets FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY branding_assets__update__tenant ON identity.branding_assets FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY support_sessions__select__tenant ON identity.support_sessions FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY support_sessions__update__tenant ON identity.support_sessions FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY ird_annex_records__select__tenant ON identity.ird_annex_records FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY ird_annex_events__select__tenant ON identity.ird_annex_events FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY ird_annex_documents__select__tenant ON identity.ird_annex_documents FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY audit_exports__select__tenant ON identity.audit_exports FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY audit_exports__insert__tenant ON identity.audit_exports FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY audit_exports__update__tenant ON identity.audit_exports FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY access_reviews__select__tenant ON identity.access_reviews FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY access_reviews__insert__tenant ON identity.access_reviews FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY admin_notices__select__tenant ON identity.admin_notices FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY admin_notices__insert__tenant ON identity.admin_notices FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY admin_notices__update__tenant ON identity.admin_notices FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
-- 08 A25 D-216: tenant claims read exactly the platform Annex 1 row their settings reference (verbatim from D-216)
CREATE POLICY ird_annex_records__select__tenant_platform_ref ON identity.ird_annex_records FOR SELECT TO lims_app
  USING (tenant_id IS NULL AND annex_code = 'annex_1'
         AND id = (SELECT ts.ird_annex_1_record_id FROM identity.tenant_settings ts WHERE ts.tenant_id = (SELECT app.current_tenant_id()))
         AND (SELECT app.is_staff_or_system()));
CREATE POLICY tenant_settings__select__platform ON identity.tenant_settings FOR SELECT TO lims_app
  USING ((SELECT app.is_platform_actor()));
CREATE POLICY tenant_settings__update__platform ON identity.tenant_settings FOR UPDATE TO lims_app
  USING ((SELECT app.is_platform_actor())) WITH CHECK ((SELECT app.is_platform_actor()));

CREATE POLICY sessions__select__own ON identity.sessions FOR SELECT TO lims_app
  USING (id = (SELECT app.current_lims_session_id()) AND user_id = (SELECT app.current_actor_id())
         AND tenant_id IS NOT DISTINCT FROM (SELECT app.current_tenant_id()));
CREATE POLICY sessions__insert__own ON identity.sessions FOR INSERT TO lims_app
  WITH CHECK (id = (SELECT app.current_lims_session_id()) AND user_id = (SELECT app.current_actor_id())
              AND tenant_id IS NOT DISTINCT FROM (SELECT app.current_tenant_id()));
CREATE POLICY sessions__update__own ON identity.sessions FOR UPDATE TO lims_app
  USING (id = (SELECT app.current_lims_session_id()) AND user_id = (SELECT app.current_actor_id())
         AND tenant_id IS NOT DISTINCT FROM (SELECT app.current_tenant_id()))
  WITH CHECK (id = (SELECT app.current_lims_session_id()) AND user_id = (SELECT app.current_actor_id())
         AND tenant_id IS NOT DISTINCT FROM (SELECT app.current_tenant_id()));
-- __own_user: every session of the calling user in the calling tenant (partner self-service, 08 A19 D-101; no guard — shared_with: [partner])
CREATE POLICY sessions__select__own_user ON identity.sessions FOR SELECT TO lims_app
  USING (user_id = (SELECT app.current_actor_id()) AND tenant_id = (SELECT app.current_tenant_id()));
CREATE POLICY sessions__update__own_user ON identity.sessions FOR UPDATE TO lims_app
  USING (user_id = (SELECT app.current_actor_id()) AND tenant_id = (SELECT app.current_tenant_id()))
  WITH CHECK (user_id = (SELECT app.current_actor_id()) AND tenant_id = (SELECT app.current_tenant_id()));
-- mfa_factors __own (user's own factors, tenant or tenant-less; partner self-service):
CREATE POLICY mfa_factors__select__own ON identity.mfa_factors FOR SELECT TO lims_app
  USING (user_id = (SELECT app.current_actor_id()) AND tenant_id IS NOT DISTINCT FROM (SELECT app.current_tenant_id()));
CREATE POLICY mfa_factors__insert__own ON identity.mfa_factors FOR INSERT TO lims_app
  WITH CHECK (user_id = (SELECT app.current_actor_id()) AND tenant_id IS NOT DISTINCT FROM (SELECT app.current_tenant_id()));
CREATE POLICY mfa_factors__update__own ON identity.mfa_factors FOR UPDATE TO lims_app
  USING (user_id = (SELECT app.current_actor_id()) AND tenant_id IS NOT DISTINCT FROM (SELECT app.current_tenant_id()))
  WITH CHECK (user_id = (SELECT app.current_actor_id()) AND tenant_id IS NOT DISTINCT FROM (SELECT app.current_tenant_id()));
CREATE POLICY sessions__select__platform ON identity.sessions FOR SELECT TO lims_app
  USING (kind = 'platform' AND tenant_id IS NULL AND (SELECT app.is_platform_actor()));
CREATE POLICY sessions__update__platform ON identity.sessions FOR UPDATE TO lims_app
  USING (kind = 'platform' AND tenant_id IS NULL AND (SELECT app.is_platform_actor()))
  WITH CHECK (kind = 'platform' AND tenant_id IS NULL AND (SELECT app.is_platform_actor()));
-- 08 A28.1: platform rows after login (platform-context operations, 02-TRD §5.10)
-- expanded from the §10.1 A28.1 loop
CREATE POLICY mfa_factors__select__platform ON identity.mfa_factors FOR SELECT TO lims_app
  USING (tenant_id IS NULL AND (SELECT app.is_platform_actor()));
CREATE POLICY mfa_factors__insert__platform ON identity.mfa_factors FOR INSERT TO lims_app
  WITH CHECK (tenant_id IS NULL AND (SELECT app.is_platform_actor()));
CREATE POLICY mfa_factors__update__platform ON identity.mfa_factors FOR UPDATE TO lims_app
  USING (tenant_id IS NULL AND (SELECT app.is_platform_actor()))
  WITH CHECK (tenant_id IS NULL AND (SELECT app.is_platform_actor()));
CREATE POLICY invitations__select__platform ON identity.invitations FOR SELECT TO lims_app
  USING (tenant_id IS NULL AND (SELECT app.is_platform_actor()));
CREATE POLICY invitations__insert__platform ON identity.invitations FOR INSERT TO lims_app
  WITH CHECK (tenant_id IS NULL AND (SELECT app.is_platform_actor()));
CREATE POLICY invitations__update__platform ON identity.invitations FOR UPDATE TO lims_app
  USING (tenant_id IS NULL AND (SELECT app.is_platform_actor()))
  WITH CHECK (tenant_id IS NULL AND (SELECT app.is_platform_actor()));

-- Owner policies for the §6 DEFINER functions (§5.4; 08 A10.5, A12, A15). FORCE RLS applies to lims_owner; each policy admits only
-- what the named function reads or writes. Parameter-bound lookups match on the transaction-local app.pre_* GUCs that the function
-- sets with set_config(…, true) and resets to '' before returning (08 A12.1, A15.1); every cross-tenant maintenance branch is gated
-- on app.maintenance = '<function name>' (08 A12.2, A15.3: no static maintenance policy). All are TO lims_owner only: a lims_app
-- session that sets these GUCs gains nothing (§11 test 24).
-- The core.* owner policies (memberships, users, tenants, roles, membership_roles) are C0's (C0 05-SCHEMA §10; mirrored in §10.2).
-- app.is_platform_actor(), app.identity_bootstrap_platform_admin(), and the platform_staff joins of §10.3 (decided, 08 A10.5):
CREATE POLICY platform_staff__select__owner_only ON identity.platform_staff FOR SELECT TO lims_owner
  USING (true);                                                   -- only allowlisted USING (true) (C0 02-TRD §4.2)
-- app.identity_bootstrap_platform_admin():
CREATE POLICY platform_staff__insert__owner_only ON identity.platform_staff FOR INSERT TO lims_owner
  WITH CHECK (role_code = 'platform_superadmin');
CREATE POLICY platform_events__insert__owner_only ON identity.platform_events FOR INSERT TO lims_owner
  WITH CHECK (event_type = 'bootstrap_admin_created');
-- app.identity_record_auth_event():
CREATE POLICY auth_events__insert__owner_only ON identity.auth_events FOR INSERT TO lims_owner
  WITH CHECK (tenant_id IS NULL);
-- app.identity_purge_auth_events() (08 A12.2: app.maintenance; every deletable row is older than 5 years — retention_audit_years >= 5,
-- tenant-less rows 5 years, §9):
CREATE POLICY auth_events__select__owner_only ON identity.auth_events FOR SELECT TO lims_owner
  USING ((current_setting('app.maintenance', true) = 'identity_purge_auth_events' AND occurred_at < now() - interval '5 years')
      OR (current_setting('app.maintenance', true) = 'identity_notify_ip_throttle'                  -- 08 A28.4
          AND tenant_id IS NULL AND event_type = 'login_failed' AND email_hmac IS NOT NULL));
CREATE POLICY auth_events__delete__owner_only ON identity.auth_events FOR DELETE TO lims_owner
  USING (current_setting('app.maintenance', true) = 'identity_purge_auth_events' AND occurred_at < now() - interval '5 years');
-- identity.tenant_settings: app.identity_login_context() (the chosen membership's tenant, 08 A12.1) and
-- app.identity_purge_auth_events() (every tenant's retention_audit_years; no narrower row predicate exists, 08 A12.2):
CREATE POLICY tenant_settings__select__owner_only ON identity.tenant_settings FOR SELECT TO lims_owner
  USING (tenant_id = nullif(current_setting('app.pre_tenant_id', true), '')::uuid
      OR current_setting('app.maintenance', true) = 'identity_purge_auth_events');
-- identity.sessions: app.identity_purge_sessions() (expiry, gated on app.maintenance, 08 A15.3), app.identity_session_by_token()
-- (current or previous hash) and app.identity_resolve_session() (GoTrue session id) — one SELECT owner policy, predicates ORed (08 A12.1):
CREATE POLICY sessions__select__owner_only ON identity.sessions FOR SELECT TO lims_owner
  USING ((current_setting('app.maintenance', true) = 'identity_purge_sessions' AND expires_at < now())
      OR token_sha256 = decode(current_setting('app.pre_session_token_sha256', true), 'hex')
      OR previous_token_sha256 = decode(current_setting('app.pre_session_token_sha256', true), 'hex')
      OR gotrue_session_id = nullif(current_setting('app.pre_gotrue_session_id', true), '')::uuid
      OR (tenant_id IS NULL AND kind = 'platform' AND user_id = nullif(current_setting('app.pre_user_id', true), '')::uuid));      -- 08 A28.1
-- app.identity_platform_auth_write_session_insert / _session_update (08 A28.1):
CREATE POLICY sessions__insert__owner_only ON identity.sessions FOR INSERT TO lims_owner
  WITH CHECK (tenant_id IS NULL AND kind = 'platform' AND user_id = nullif(current_setting('app.pre_user_id', true), '')::uuid);
CREATE POLICY sessions__update__owner_only ON identity.sessions FOR UPDATE TO lims_owner
  USING (tenant_id IS NULL AND kind = 'platform' AND user_id = nullif(current_setting('app.pre_user_id', true), '')::uuid)
  WITH CHECK (tenant_id IS NULL AND kind = 'platform' AND user_id = nullif(current_setting('app.pre_user_id', true), '')::uuid);
CREATE POLICY sessions__delete__owner_only ON identity.sessions FOR DELETE TO lims_owner
  USING (current_setting('app.maintenance', true) = 'identity_purge_sessions' AND expires_at < now());
-- identity.admin_notices: app.identity_purge_sessions() (08 A15.3):
CREATE POLICY admin_notices__select__owner_only ON identity.admin_notices FOR SELECT TO lims_owner
  USING (current_setting('app.maintenance', true) = 'identity_purge_sessions' AND expires_at < now());
CREATE POLICY admin_notices__delete__owner_only ON identity.admin_notices FOR DELETE TO lims_owner
  USING (current_setting('app.maintenance', true) = 'identity_purge_sessions' AND expires_at < now());
-- identity.mfa_factors: app.identity_login_context() — the user, and the chosen membership's tenant or, with no membership
-- (app.pre_tenant_id = '' → NULL), the user's tenant-less factors (platform staff; 08 A12.1, A15.2):
CREATE POLICY mfa_factors__select__owner_only ON identity.mfa_factors FOR SELECT TO lims_owner
  USING (user_id = nullif(current_setting('app.pre_user_id', true), '')::uuid
         AND tenant_id IS NOT DISTINCT FROM nullif(current_setting('app.pre_tenant_id', true), '')::uuid);
-- app.identity_platform_auth_write_mfa_factor (08 A28.1):
CREATE POLICY mfa_factors__insert__owner_only ON identity.mfa_factors FOR INSERT TO lims_owner
  WITH CHECK (tenant_id IS NULL AND user_id = nullif(current_setting('app.pre_user_id', true), '')::uuid);
CREATE POLICY mfa_factors__update__owner_only ON identity.mfa_factors FOR UPDATE TO lims_owner
  USING (tenant_id IS NULL AND user_id = nullif(current_setting('app.pre_user_id', true), '')::uuid) WITH CHECK (tenant_id IS NULL AND user_id = nullif(current_setting('app.pre_user_id', true), '')::uuid);
-- app.identity_platform_auth_write_staff_login (08 A28.1):
CREATE POLICY platform_staff__update__owner_only ON identity.platform_staff FOR UPDATE TO lims_owner
  USING (user_id = nullif(current_setting('app.pre_user_id', true), '')::uuid) WITH CHECK (user_id = nullif(current_setting('app.pre_user_id', true), '')::uuid);
-- identity.support_sessions: app.identity_expire_support_sessions() (UPDATE … WHERE: SELECT policy must admit the old and the new
-- row; gated on app.maintenance, 08 A15.3) and app.identity_resolve_session() (the session row's support_session_id, 08 A15.1;
-- the session's tenant, 08 A12.1):
CREATE POLICY support_sessions__select__owner_only ON identity.support_sessions FOR SELECT TO lims_owner
  USING ((current_setting('app.maintenance', true) = 'identity_expire_support_sessions'
          AND ((status = 'requested' AND requested_at < now() - interval '24 hours')
            OR (status = 'approved'  AND decided_at   < now() - interval '60 minutes')
            OR (status = 'active'    AND expires_at   <= now())
            OR (status = 'expired'   AND end_reason = 'expired')))
      OR id = nullif(current_setting('app.pre_support_session_id', true), '')::uuid
      OR tenant_id = nullif(current_setting('app.pre_tenant_id', true), '')::uuid);
CREATE POLICY support_sessions__update__owner_only ON identity.support_sessions FOR UPDATE TO lims_owner
  USING (current_setting('app.maintenance', true) = 'identity_expire_support_sessions'
         AND ((status = 'requested' AND requested_at < now() - interval '24 hours')
           OR (status = 'approved'  AND decided_at   < now() - interval '60 minutes')
           OR (status = 'active'    AND expires_at   <= now())))
  WITH CHECK (current_setting('app.maintenance', true) = 'identity_expire_support_sessions'
              AND status = 'expired' AND end_reason = 'expired');
-- app.identity_expire_invitations() (one UPDATE, 08 A12.6; <e>: expire; <r>: clear email 30 days after a terminal state; 08 A15.3):
CREATE POLICY invitations__select__owner_only ON identity.invitations FOR SELECT TO lims_owner
  USING ((current_setting('app.maintenance', true) = 'identity_expire_invitations'
         AND ((status IN ('pending','sent') AND expires_at < now())
           OR (email IS NOT NULL AND status IN ('accepted','expired','revoked','failed') AND updated_at < now() - interval '30 days')
           OR status = 'expired'
           OR (email IS NULL AND status IN ('accepted','expired','revoked','failed'))))
      OR (tenant_id IS NULL AND user_id = nullif(current_setting('app.pre_user_id', true), '')::uuid));                                  -- 08 A28.1 invitation_accept
CREATE POLICY invitations__update__owner_only ON identity.invitations FOR UPDATE TO lims_owner
  USING ((current_setting('app.maintenance', true) = 'identity_expire_invitations'
          AND ((status IN ('pending','sent') AND expires_at < now())
            OR (email IS NOT NULL AND status IN ('accepted','expired','revoked','failed') AND updated_at < now() - interval '30 days')))
      OR (tenant_id IS NULL AND user_id = nullif(current_setting('app.pre_user_id', true), '')::uuid))
  WITH CHECK ((current_setting('app.maintenance', true) = 'identity_expire_invitations'
               AND (status = 'expired' OR (email IS NULL AND status IN ('accepted','expired','revoked','failed'))))
           OR (tenant_id IS NULL AND user_id = nullif(current_setting('app.pre_user_id', true), '')::uuid));
-- app.identity_expire_audit_exports() (08 A15.3):
CREATE POLICY audit_exports__select__owner_only ON identity.audit_exports FOR SELECT TO lims_owner
  USING (current_setting('app.maintenance', true) = 'identity_expire_audit_exports'
         AND ((status = 'ready' AND (expires_at <= now() OR downloads_remaining = 0)) OR status = 'expired'
           OR (status IN ('expired','failed') AND created_at < now() - interval '1 year')));
CREATE POLICY audit_exports__delete__owner_only ON identity.audit_exports FOR DELETE TO lims_owner      -- 1-year row purge (08 A17 P-18(c))
  USING (current_setting('app.maintenance', true) = 'identity_expire_audit_exports'
         AND status IN ('expired','failed') AND created_at < now() - interval '1 year');
CREATE POLICY audit_exports__update__owner_only ON identity.audit_exports FOR UPDATE TO lims_owner
  USING (current_setting('app.maintenance', true) = 'identity_expire_audit_exports'
         AND status = 'ready' AND (expires_at <= now() OR downloads_remaining = 0))
  WITH CHECK (current_setting('app.maintenance', true) = 'identity_expire_audit_exports' AND status = 'expired');

-- Grants (02-CV §5.9; classes §4) -----------------------------------------------------------------------
GRANT USAGE ON SCHEMA identity TO lims_app;
GRANT SELECT ON identity.g_feature_flags, identity.g_breached_passwords TO lims_app;
GRANT SELECT, INSERT, UPDATE ON identity.sessions, identity.mfa_factors, identity.invitations, identity.platform_staff,
  identity.tenant_settings, identity.feature_flags, identity.branding_assets, identity.support_sessions,
  identity.ird_annex_records, identity.audit_exports, identity.admin_notices TO lims_app;
GRANT SELECT, INSERT ON identity.auth_events, identity.ird_annex_events, identity.ird_annex_documents,
  identity.access_reviews, identity.platform_events TO lims_app;
GRANT UPDATE (scan_state) ON identity.ird_annex_documents TO lims_app;   -- P-19 re-scan; trigger allows nothing else
-- no DELETE grants on any identity table (purge via §6 maintenance functions)

-- Row audit (C2 05-SCHEMA §3; 08 A12.5: not on sessions / platform_staff / platform_events; NULL-tenant rows skipped, 08 A25 D-215)
CREATE TRIGGER tenant_settings__audit AFTER INSERT OR UPDATE OR DELETE ON identity.tenant_settings FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER feature_flags__audit AFTER INSERT OR UPDATE OR DELETE ON identity.feature_flags FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER invitations__audit AFTER INSERT OR UPDATE OR DELETE ON identity.invitations FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER support_sessions__audit AFTER INSERT OR UPDATE OR DELETE ON identity.support_sessions FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER ird_annex_records__audit AFTER INSERT OR UPDATE OR DELETE ON identity.ird_annex_records FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER branding_assets__audit AFTER INSERT OR UPDATE OR DELETE ON identity.branding_assets FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER access_reviews__audit AFTER INSERT OR UPDATE OR DELETE ON identity.access_reviews FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER mfa_factors__audit AFTER INSERT OR UPDATE OR DELETE ON identity.mfa_factors FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();

-- C2 05-SCHEMA §10.3 (moved here by CR-C0-T0B-06):
-- INVOKER breached-password lookup (§4.9; review C2 m#30): lims_app holds SELECT on the G table
CREATE FUNCTION app.identity_is_breached(p_sha1 bytea) RETURNS boolean
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM identity.g_breached_passwords WHERE sha1 = p_sha1)
$$;
REVOKE ALL ON FUNCTION app.identity_is_breached(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.identity_is_breached(bytea) TO lims_app;
