-- T0B-10.C6: reporting schema — C6 05-SCHEMA §6 DDL verbatim, then §6.1 RLS (ENABLE + FORCE on the 25 tenant tables) with the
-- literal §6.1 policies and the policies §6.1 describes by template written out (__tenant / __tenant_centre with the staff guard,
-- portal_sessions "identical pattern", print_jobs __tenant_expired), §6.3 lims_app grants, row-audit triggers on the class M/C
-- tables (§1; portal_links uses the two conditional §6 triggers), the §6.2 lookup grants/policies and the D-201 DEFINER window
-- verbatim, and the §7 v_pub_* views. Policies are copied 1:1 to db/policies/reporting.sql (AC-0B-2.3).
-- g_* seed rows (§8) belong to db/seeds. reporting.event_inbox is C0's (T0B-05). Schema reporting exists since T0B-01.
SET LOCAL ROLE lims_owner;

-- =====================================================================
-- §6 DDL (C6 05-SCHEMA, verbatim)
-- =====================================================================
-- ===================== reporting: masters =====================
CREATE TABLE reporting.settings (
  id uuid NOT NULL, tenant_id uuid NOT NULL,
  auto_release text NOT NULL DEFAULT 'when_eligible',
  narrative_report_mode text NOT NULL DEFAULT 'separate',
  patient_mobile_channel_order text[] NOT NULL DEFAULT '{whatsapp,sms}',
  patient_email_enabled boolean NOT NULL DEFAULT true,
  referrer_delivery_enabled boolean NOT NULL DEFAULT true,
  referrer_channels text[] NOT NULL DEFAULT '{sms}',
  centre_delivery_enabled boolean NOT NULL DEFAULT false,
  whatsapp_fallback_minutes integer NOT NULL DEFAULT 30,
  critical_alert_referrer_enabled boolean NOT NULL DEFAULT true,
  bulk_release_max integer NOT NULL DEFAULT 200,
  print_critical_label boolean NOT NULL DEFAULT false,
  link_reissue_max_per_day smallint NOT NULL DEFAULT 3,
  portal_payment_gateways text[] NOT NULL DEFAULT '{}',                  -- 08 A11.1; empty = no portal payment button [CONV]
  dues_link_enabled boolean NOT NULL DEFAULT true,                       -- 08 A21.1 [CONV switch]
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT settings__pk PRIMARY KEY (id),
  CONSTRAINT settings__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT settings__tenant_id__uq UNIQUE (tenant_id),
  CONSTRAINT settings__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT settings__auto_release__ck CHECK (auto_release IN ('when_eligible','manual')),
  CONSTRAINT settings__narrative_mode__ck CHECK (narrative_report_mode IN ('separate','combined')),
  CONSTRAINT settings__channel_order__ck CHECK (patient_mobile_channel_order <@ ARRAY['whatsapp','sms']
             AND cardinality(patient_mobile_channel_order) BETWEEN 1 AND 2),
  CONSTRAINT settings__referrer_channels__ck CHECK (referrer_channels <@ ARRAY['whatsapp','sms','email']),
  CONSTRAINT settings__fallback__ck CHECK (whatsapp_fallback_minutes BETWEEN 5 AND 240),
  CONSTRAINT settings__bulk__ck CHECK (bulk_release_max BETWEEN 1 AND 200),
  CONSTRAINT settings__reissue__ck CHECK (link_reissue_max_per_day BETWEEN 0 AND 5),
  CONSTRAINT settings__portal_gateways__ck CHECK (portal_payment_gateways <@ ARRAY['esewa','khalti'])   -- Fonepay BLOCKED B8
);

CREATE TABLE reporting.staff_assignments (
  id uuid NOT NULL, tenant_id uuid NOT NULL, membership_id uuid NOT NULL, assignment text NOT NULL,
  sort_order smallint NOT NULL DEFAULT 0,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT staff_assignments__pk PRIMARY KEY (id),
  CONSTRAINT staff_assignments__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT staff_assignments__tenant_id_assignment_membership_id__uq UNIQUE (tenant_id, assignment, membership_id),
  CONSTRAINT staff_assignments__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT staff_assignments__membership__fk FOREIGN KEY (tenant_id, membership_id) REFERENCES core.memberships (tenant_id, id),
  CONSTRAINT staff_assignments__assignment__ck CHECK (assignment IN ('nominated_signatory','critical_alert_recipient'))
);

CREATE TABLE reporting.centre_contacts (
  id uuid NOT NULL, tenant_id uuid NOT NULL, centre_id uuid NOT NULL, channel text NOT NULL,
  address text NOT NULL, label text,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT centre_contacts__pk PRIMARY KEY (id),
  CONSTRAINT centre_contacts__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT centre_contacts__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT centre_contacts__centre__fk FOREIGN KEY (tenant_id, centre_id) REFERENCES core.collection_centres (tenant_id, id),
  CONSTRAINT centre_contacts__channel__ck CHECK (channel IN ('whatsapp','sms','email')),
  CONSTRAINT centre_contacts__address__ck CHECK (
    (channel IN ('whatsapp','sms') AND address ~ '^\+[1-9][0-9]{7,14}$') OR
    (channel = 'email' AND char_length(address) <= 254 AND address ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')),
  CONSTRAINT centre_contacts__label__ck CHECK (label IS NULL OR char_length(label) <= 80)
);
CREATE INDEX centre_contacts__tenant_id_centre_id_channel__idx ON reporting.centre_contacts (tenant_id, centre_id, channel);

CREATE TABLE reporting.referrer_preferences (
  id uuid NOT NULL, tenant_id uuid NOT NULL, referrer_id uuid NOT NULL,
  disabled_channels text[] NOT NULL DEFAULT '{}',
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT referrer_preferences__pk PRIMARY KEY (id),
  CONSTRAINT referrer_preferences__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT referrer_preferences__tenant_id_referrer_id__uq UNIQUE (tenant_id, referrer_id),
  CONSTRAINT referrer_preferences__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT referrer_preferences__referrer__fk FOREIGN KEY (tenant_id, referrer_id) REFERENCES catalog.doctors (tenant_id, id),
  CONSTRAINT referrer_preferences__channels__ck CHECK (disabled_channels <@ ARRAY['whatsapp','sms','email'])
);

CREATE TABLE reporting.channel_accounts (
  id uuid NOT NULL, tenant_id uuid NOT NULL, channel text NOT NULL, provider_kind text NOT NULL,
  sender_id text, secret_ref text NOT NULL, callback_token_sha256 bytea,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT channel_accounts__pk PRIMARY KEY (id),
  CONSTRAINT channel_accounts__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT channel_accounts__tenant_id_channel__uq UNIQUE (tenant_id, channel),
  CONSTRAINT channel_accounts__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT channel_accounts__channel__ck CHECK (channel IN ('whatsapp','sms','email')),
  CONSTRAINT channel_accounts__provider__ck CHECK (provider_kind IN ('recording','whatsapp_cloud_api','sms_sparrow','sms_aakash','email_smtp_relay')),
  CONSTRAINT channel_accounts__sender__ck CHECK (sender_id IS NULL OR char_length(sender_id) <= 64),
  CONSTRAINT channel_accounts__secret_ref__ck CHECK (secret_ref ~ '^[a-z0-9_./-]{1,128}$'),
  CONSTRAINT channel_accounts__cb__ck CHECK (callback_token_sha256 IS NULL OR octet_length(callback_token_sha256) = 32)   -- 08 R24
);
CREATE UNIQUE INDEX channel_accounts__callback_token_sha256__p_uq ON reporting.channel_accounts (callback_token_sha256)
  WHERE callback_token_sha256 IS NOT NULL;                      -- global: CR-C6-002

CREATE TABLE reporting.g_message_templates (
  code text NOT NULL, purpose text NOT NULL, channels text[] NOT NULL, params jsonb NOT NULL,
  default_texts jsonb NOT NULL, description text, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT g_message_templates__pk PRIMARY KEY (code),
  CONSTRAINT g_message_templates__code__ck CHECK (code ~ '^[a-z_]+\.[a-z0-9_]{1,60}$'),
  CONSTRAINT g_message_templates__purpose__ck CHECK (purpose IN ('registration_confirmation','report_ready','otp','dues_reminder',
    'recollection_request','critical_value_alert','booking_confirmation','visit_assignment','follow_up_reminder',
    'scheduled_report_ready','booking_cancelled','booking_reminder')),   -- 08 R13
  CONSTRAINT g_message_templates__channels__ck CHECK (channels <@ ARRAY['whatsapp','sms','email'] AND cardinality(channels) >= 1),
  CONSTRAINT g_message_templates__params__ck CHECK (jsonb_typeof(params) = 'array')
);

CREATE TABLE reporting.message_template_texts (
  id uuid NOT NULL, tenant_id uuid NOT NULL, template_code text NOT NULL, channel text NOT NULL, language text NOT NULL,
  body_text text NOT NULL, subject_text text, provider_template_name text, provider_template_language text,
  provider_variable_order text[], approval_status text NOT NULL DEFAULT 'not_required',
  approval_recorded_by uuid, approval_recorded_at timestamptz,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT message_template_texts__pk PRIMARY KEY (id),
  CONSTRAINT message_template_texts__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT message_template_texts__tenant_id_template_code_channel_language__uq UNIQUE (tenant_id, template_code, channel, language),
  CONSTRAINT message_template_texts__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT message_template_texts__template__fk FOREIGN KEY (template_code) REFERENCES reporting.g_message_templates (code),
  CONSTRAINT message_template_texts__channel__ck CHECK (channel IN ('whatsapp','sms','email')),
  CONSTRAINT message_template_texts__language__ck CHECK (language IN ('en','ne')),
  CONSTRAINT message_template_texts__len__ck CHECK (char_length(body_text) BETWEEN 1 AND 1000
     AND (subject_text IS NULL OR char_length(subject_text) <= 150)
     AND (provider_template_name IS NULL OR char_length(provider_template_name) <= 128)
     AND (provider_template_language IS NULL OR char_length(provider_template_language) <= 16)),
  CONSTRAINT message_template_texts__approval__ck CHECK (approval_status IN ('not_required','draft','submitted','approved','rejected'))
);

CREATE TABLE reporting.report_templates (
  id uuid NOT NULL, tenant_id uuid NOT NULL, family text NOT NULL, name text NOT NULL,
  current_version_id uuid, is_default boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT report_templates__pk PRIMARY KEY (id),
  CONSTRAINT report_templates__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT report_templates__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT report_templates__family__ck CHECK (family IN ('laboratory','narrative')),
  CONSTRAINT report_templates__name__ck CHECK (char_length(name) BETWEEN 1 AND 80)
);
CREATE UNIQUE INDEX report_templates__tenant_id_family__default__p_uq ON reporting.report_templates (tenant_id, family) WHERE is_default;

CREATE TABLE reporting.report_template_versions (
  id uuid NOT NULL, tenant_id uuid NOT NULL, template_id uuid NOT NULL, version_no integer NOT NULL,
  status text NOT NULL DEFAULT 'draft', config jsonb NOT NULL, config_sha256 text NOT NULL,
  published_at timestamptz, published_by uuid,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT report_template_versions__pk PRIMARY KEY (id),
  CONSTRAINT report_template_versions__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT report_template_versions__tenant_id_template_id_version_no__uq UNIQUE (tenant_id, template_id, version_no),
  CONSTRAINT report_template_versions__template__fk FOREIGN KEY (tenant_id, template_id) REFERENCES reporting.report_templates (tenant_id, id),
  CONSTRAINT report_template_versions__status__ck CHECK (status IN ('draft','published','retired')),
  CONSTRAINT report_template_versions__config__ck CHECK (jsonb_typeof(config) = 'object' AND octet_length(config::text) <= 32768),
  CONSTRAINT report_template_versions__sha__ck CHECK (config_sha256 ~ '^[0-9a-f]{64}$')
);
CREATE UNIQUE INDEX report_template_versions__tenant_id_template_id__draft__p_uq ON reporting.report_template_versions (tenant_id, template_id) WHERE status = 'draft';
CREATE UNIQUE INDEX report_template_versions__tenant_id_template_id__published__p_uq ON reporting.report_template_versions (tenant_id, template_id) WHERE status = 'published';
ALTER TABLE reporting.report_templates ADD CONSTRAINT report_templates__current_version__fk
  FOREIGN KEY (tenant_id, current_version_id) REFERENCES reporting.report_template_versions (tenant_id, id);
-- published versions immutable (only status published → retired):
CREATE TRIGGER report_template_versions__mutable_columns BEFORE UPDATE ON reporting.report_template_versions
  FOR EACH ROW WHEN (OLD.status <> 'draft') EXECUTE FUNCTION app.enforce_mutable_columns('status','updated_at','updated_by','version');

CREATE TABLE reporting.narrative_templates (
  id uuid NOT NULL, tenant_id uuid NOT NULL, code text NOT NULL, name text NOT NULL, kind text NOT NULL,
  test_id uuid, sections jsonb NOT NULL,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT narrative_templates__pk PRIMARY KEY (id),
  CONSTRAINT narrative_templates__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT narrative_templates__tenant_id_code__uq UNIQUE (tenant_id, code),
  CONSTRAINT narrative_templates__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT narrative_templates__test__fk FOREIGN KEY (tenant_id, test_id) REFERENCES catalog.tests (tenant_id, id),
  CONSTRAINT narrative_templates__code__ck CHECK (code ~ '^[A-Z0-9_]{1,32}$'),
  CONSTRAINT narrative_templates__name__ck CHECK (char_length(name) BETWEEN 1 AND 120),
  CONSTRAINT narrative_templates__kind__ck CHECK (kind IN ('xray','usg','endoscopy','cytogenetics','other')),
  CONSTRAINT narrative_templates__sections__ck CHECK (jsonb_typeof(sections) = 'array'
     AND jsonb_array_length(sections) BETWEEN 1 AND 12 AND octet_length(sections::text) <= 65536)
);
CREATE INDEX narrative_templates__tenant_id_test_id__p_idx ON reporting.narrative_templates (tenant_id, test_id) WHERE test_id IS NOT NULL;

CREATE TABLE reporting.g_cs_reasons (
  set_name text NOT NULL, code text NOT NULL, display text NOT NULL, system text NOT NULL DEFAULT 'lims',
  system_version text NOT NULL DEFAULT '1', sort_order integer NOT NULL DEFAULT 0, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT g_cs_reasons__pk PRIMARY KEY (set_name, code),
  CONSTRAINT g_cs_reasons__set__ck CHECK (set_name IN ('regeneration_reasons','token_revoke_reasons','outsourced_withdraw_reasons','narrative_amend_reasons')),
  CONSTRAINT g_cs_reasons__code__ck CHECK (code ~ '^[a-z0-9_]{1,64}$')
);
CREATE TABLE reporting.cs_reasons (
  id uuid NOT NULL, tenant_id uuid NOT NULL, set_name text NOT NULL, code text NOT NULL, display text NOT NULL,
  system text NOT NULL DEFAULT 'tenant', system_version text NOT NULL DEFAULT '1', sort_order integer NOT NULL DEFAULT 0,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT cs_reasons__pk PRIMARY KEY (id),
  CONSTRAINT cs_reasons__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT cs_reasons__tenant_id_set_name_code__uq UNIQUE (tenant_id, set_name, code),
  CONSTRAINT cs_reasons__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT cs_reasons__set__ck CHECK (set_name IN ('regeneration_reasons','token_revoke_reasons','outsourced_withdraw_reasons','narrative_amend_reasons')),
  CONSTRAINT cs_reasons__code__ck CHECK (code ~ '^[a-z0-9_]{1,64}$')
);

-- ===================== reporting: clinical =====================
CREATE TABLE reporting.reports (
  id uuid NOT NULL, tenant_id uuid NOT NULL, centre_id uuid NOT NULL, branch_id uuid NOT NULL,
  order_id uuid NOT NULL, patient_id uuid NOT NULL, referrer_id uuid, partner_id uuid,
  family text NOT NULL, order_source text NOT NULL, registered_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'open',
  needs_assembly boolean NOT NULL DEFAULT false, needs_assembly_since timestamptz,
  latest_version_no integer NOT NULL DEFAULT 0, released_version_no integer,
  lab_ready_seq integer, lab_approved_set_hash text, lab_completeness text,
  lab_contains_amendment boolean NOT NULL DEFAULT false, regeneration_counter integer NOT NULL DEFAULT 0,
  billing_balance_due_paisa bigint, billing_release_eligible boolean, billing_balance_version integer,
  first_released_at timestamptz, final_released_at timestamptz, review_flag text, cancelled_at timestamptz,
  registration_no text NOT NULL, patient_display_name text, centre_code text NOT NULL, referrer_name text,   -- review fix #6
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT reports__pk PRIMARY KEY (id),
  CONSTRAINT reports__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT reports__tenant_id_order_id_family__uq UNIQUE (tenant_id, order_id, family),
  CONSTRAINT reports__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT reports__centre__fk FOREIGN KEY (tenant_id, centre_id) REFERENCES core.collection_centres (tenant_id, id),
  CONSTRAINT reports__branch__fk FOREIGN KEY (tenant_id, branch_id) REFERENCES core.branches (tenant_id, id),
  CONSTRAINT reports__order__fk FOREIGN KEY (tenant_id, order_id) REFERENCES frontdesk.orders (tenant_id, id),
  CONSTRAINT reports__patient__fk FOREIGN KEY (tenant_id, patient_id) REFERENCES frontdesk.patients (tenant_id, id),
  CONSTRAINT reports__referrer__fk FOREIGN KEY (tenant_id, referrer_id) REFERENCES catalog.doctors (tenant_id, id),
  CONSTRAINT reports__family__ck CHECK (family IN ('laboratory','narrative')),
  CONSTRAINT reports__source__ck CHECK (order_source IN ('front_desk','engagement_booking','home_collection','partner_manifest')),
  CONSTRAINT reports__state__ck CHECK (state IN ('open','cancelled')),
  CONSTRAINT reports__lab_hash__ck CHECK (lab_approved_set_hash IS NULL OR lab_approved_set_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT reports__lab_completeness__ck CHECK (lab_completeness IS NULL OR lab_completeness IN ('complete','partial')),
  CONSTRAINT reports__review_flag__ck CHECK (review_flag IS NULL OR review_flag IN ('released_order_cancelled','released_item_removed')),
  CONSTRAINT reports__snapshot__ck CHECK (char_length(registration_no) BETWEEN 1 AND 20 AND char_length(centre_code) BETWEEN 1 AND 32
     AND (patient_display_name IS NULL OR char_length(patient_display_name) <= 200)
     AND (referrer_name IS NULL OR char_length(referrer_name) <= 200))
);
CREATE INDEX reports__tenant_id_centre_id_state_updated_at__idx ON reporting.reports (tenant_id, centre_id, state, updated_at DESC);
CREATE INDEX reports__tenant_id_needs_assembly__p_idx ON reporting.reports (tenant_id, needs_assembly_since) WHERE needs_assembly;
CREATE INDEX reports__tenant_id_patient_id__idx ON reporting.reports (tenant_id, patient_id);
CREATE INDEX reports__tenant_id_partner_id__p_idx ON reporting.reports (tenant_id, partner_id) WHERE partner_id IS NOT NULL;
CREATE INDEX reports__tenant_id_registration_no__idx ON reporting.reports (tenant_id, registration_no);                 -- review fix #6
CREATE INDEX reports__tenant_id_registered_at__idx ON reporting.reports (tenant_id, registered_at DESC);                -- review fix #42
CREATE INDEX reports__tenant_id_first_released_at__p_idx ON reporting.reports (tenant_id, first_released_at DESC)
  WHERE first_released_at IS NOT NULL;                                                                                  -- review fix #42
CREATE TRIGGER reports__mutable_columns BEFORE UPDATE ON reporting.reports FOR EACH ROW EXECUTE FUNCTION
  app.enforce_mutable_columns('referrer_id','partner_id','state','needs_assembly','needs_assembly_since','latest_version_no',
   'released_version_no','lab_ready_seq','lab_approved_set_hash','lab_completeness','lab_contains_amendment','regeneration_counter',
   'billing_balance_due_paisa','billing_release_eligible','billing_balance_version','first_released_at','final_released_at',
   'review_flag','cancelled_at','patient_display_name','referrer_name','updated_at','updated_by','version');

CREATE TABLE reporting.report_order_items (
  id uuid NOT NULL, tenant_id uuid NOT NULL, centre_id uuid NOT NULL, report_id uuid NOT NULL,
  order_id uuid NOT NULL, order_item_id uuid NOT NULL, orderable_id uuid NOT NULL, orderable_kind text NOT NULL,
  test_ids uuid[] NOT NULL, narrative_test_ids uuid[] NOT NULL DEFAULT '{}', priority text NOT NULL,
  item_status text NOT NULL DEFAULT 'active',
  requires_lab boolean NOT NULL, requires_narrative boolean NOT NULL, requires_outsourced boolean NOT NULL,
  lab_ready boolean NOT NULL DEFAULT false, narrative_ready boolean NOT NULL DEFAULT false, outsourced_ready boolean NOT NULL DEFAULT false,
  ready_marker text, approved_results integer NOT NULL DEFAULT 0, amendment_pending boolean NOT NULL DEFAULT false,
  specimen_hint text, specimen_hint_seq integer, items_version integer,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT report_order_items__pk PRIMARY KEY (id),
  CONSTRAINT report_order_items__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT report_order_items__tenant_id_order_item_id_report_id__uq UNIQUE (tenant_id, order_item_id, report_id),
  CONSTRAINT report_order_items__report__fk FOREIGN KEY (tenant_id, report_id) REFERENCES reporting.reports (tenant_id, id),
  CONSTRAINT report_order_items__centre__fk FOREIGN KEY (tenant_id, centre_id) REFERENCES core.collection_centres (tenant_id, id),
  CONSTRAINT report_order_items__order_item__fk FOREIGN KEY (tenant_id, order_item_id) REFERENCES frontdesk.order_items (tenant_id, id),
  CONSTRAINT report_order_items__kind__ck CHECK (orderable_kind IN ('test','panel')),
  CONSTRAINT report_order_items__priority__ck CHECK (priority IN ('routine','urgent')),
  CONSTRAINT report_order_items__status__ck CHECK (item_status IN ('active','removed','cancelled')),
  CONSTRAINT report_order_items__tests__ck CHECK (cardinality(test_ids) BETWEEN 1 AND 200),
  CONSTRAINT report_order_items__requires__ck CHECK (requires_lab OR requires_narrative OR requires_outsourced),
  CONSTRAINT report_order_items__marker__ck CHECK (ready_marker IS NULL OR char_length(ready_marker) <= 600),
  CONSTRAINT report_order_items__hint__ck CHECK (specimen_hint IS NULL OR specimen_hint IN ('rejected','recollection_ordered'))
);
CREATE INDEX report_order_items__tenant_id_report_id__idx ON reporting.report_order_items (tenant_id, report_id);
CREATE INDEX report_order_items__tenant_id_requires_outsourced__p_idx ON reporting.report_order_items (tenant_id, report_id)
  WHERE requires_outsourced AND item_status = 'active';                                                                -- O6, review fix #42

CREATE TABLE reporting.report_versions (
  id uuid NOT NULL, tenant_id uuid NOT NULL, centre_id uuid NOT NULL, report_id uuid NOT NULL, order_id uuid NOT NULL,
  patient_id uuid NOT NULL, partner_id uuid,                                               -- copies of reports.* (review fix #12)
  version_no integer NOT NULL, status text NOT NULL DEFAULT 'rendering', report_kind text NOT NULL, completeness text NOT NULL,
  order_item_ids uuid[] NOT NULL, content_fingerprint text NOT NULL, approved_set_hash text,
  content_snapshot jsonb NOT NULL, content_sha256 text NOT NULL, template_version_id uuid NOT NULL,
  pdf_object_path text, pdf_sha256 text, pdf_bytes bigint, page_count integer,
  render_attempts integer NOT NULL DEFAULT 0, last_render_error_code text,
  rendering_started_at timestamptz, rendered_at timestamptz, reported_at timestamptz NOT NULL,
  released_at timestamptz, released_by uuid, release_mode text, release_basis text, release_override_id uuid, audiences text[],
  supersedes_version_no integer, superseded_at timestamptz, superseded_by_version_no integer,
  discarded_at timestamptz, discard_reason text, held_basis text, held_checked_at timestamptz,
  regeneration_reason_code text, regeneration_reason_text text,
  smart_summary_json jsonb, smart_summary_id uuid, smart_summary_version text,          -- 08 Addendum A2.3/A2.8
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT report_versions__pk PRIMARY KEY (id),
  CONSTRAINT report_versions__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT report_versions__tenant_id_report_id_version_no__uq UNIQUE (tenant_id, report_id, version_no),
  CONSTRAINT report_versions__report__fk FOREIGN KEY (tenant_id, report_id) REFERENCES reporting.reports (tenant_id, id),
  CONSTRAINT report_versions__centre__fk FOREIGN KEY (tenant_id, centre_id) REFERENCES core.collection_centres (tenant_id, id),
  CONSTRAINT report_versions__patient__fk FOREIGN KEY (tenant_id, patient_id) REFERENCES frontdesk.patients (tenant_id, id),
  CONSTRAINT report_versions__template__fk FOREIGN KEY (tenant_id, template_version_id) REFERENCES reporting.report_template_versions (tenant_id, id),
  CONSTRAINT report_versions__status__ck CHECK (status IN ('rendering','rendered','render_failed','released','superseded','discarded')),
  CONSTRAINT report_versions__kind__ck CHECK (report_kind IN ('final','partial','preliminary','amended','addendum')),   -- 08 R1
  CONSTRAINT report_versions__completeness__ck CHECK (completeness IN ('complete','partial')),
  CONSTRAINT report_versions__items__ck CHECK (cardinality(order_item_ids) BETWEEN 1 AND 200),
  CONSTRAINT report_versions__hashes__ck CHECK (content_fingerprint ~ '^[0-9a-f]{64}$' AND content_sha256 ~ '^[0-9a-f]{64}$'
     AND (approved_set_hash IS NULL OR approved_set_hash ~ '^[0-9a-f]{64}$') AND (pdf_sha256 IS NULL OR pdf_sha256 ~ '^[0-9a-f]{64}$')),
  CONSTRAINT report_versions__path__ck CHECK (pdf_object_path IS NULL OR pdf_object_path =
     tenant_id::text || '/' || to_char(created_at AT TIME ZONE 'UTC', 'YYYY/MM') || '/' || report_id::text || '-v' || version_no::text || '.pdf'),
  CONSTRAINT report_versions__pdf_present__ck CHECK (status NOT IN ('rendered','released','superseded')
     OR (pdf_object_path IS NOT NULL AND pdf_sha256 IS NOT NULL AND page_count > 0 AND pdf_bytes > 0)),
  CONSTRAINT report_versions__released__ck CHECK (status NOT IN ('released','superseded')
     OR (released_at IS NOT NULL AND release_basis IS NOT NULL AND audiences IS NOT NULL AND release_mode IS NOT NULL)),
  CONSTRAINT report_versions__mode__ck CHECK (release_mode IS NULL OR release_mode IN ('manual','bulk','auto')),
  CONSTRAINT report_versions__basis__ck CHECK (release_basis IS NULL OR release_basis IN ('paid_in_full','zero_balance','credit_party','override','policy_not_enforced')),
  CONSTRAINT report_versions__audiences__ck CHECK (audiences IS NULL OR (audiences <@ ARRAY['patient','referrer','centre','partner','print_only'] AND cardinality(audiences) BETWEEN 1 AND 5)),
  CONSTRAINT report_versions__discard__ck CHECK (discard_reason IS NULL OR discard_reason IN ('superseded_unreleased','order_cancelled')),
  CONSTRAINT report_versions__held__ck CHECK (held_basis IS NULL OR held_basis IN ('due_outstanding','no_invoice')),
  CONSTRAINT report_versions__regen__ck CHECK (regeneration_reason_text IS NULL OR char_length(regeneration_reason_text) <= 500),
  CONSTRAINT report_versions__smart_summary__ck CHECK (                                  -- 08 A2.3/A2.8: all three or none
       (smart_summary_json IS NULL AND smart_summary_id IS NULL AND smart_summary_version IS NULL)
    OR (smart_summary_json IS NOT NULL AND smart_summary_id IS NOT NULL AND smart_summary_version IS NOT NULL
        AND jsonb_typeof(smart_summary_json) = 'object' AND char_length(smart_summary_version) BETWEEN 1 AND 32))   -- object/length [CONV]
);
CREATE UNIQUE INDEX report_versions__tenant_id_report_id__released__p_uq ON reporting.report_versions (tenant_id, report_id) WHERE status = 'released';
CREATE INDEX report_versions__tenant_id_status_created_at__p_idx ON reporting.report_versions (tenant_id, status, created_at)
  WHERE status IN ('rendering','rendered','render_failed');
CREATE INDEX report_versions__tenant_id_released_at__p_idx ON reporting.report_versions (tenant_id, released_at, id) WHERE released_at IS NOT NULL;
CREATE INDEX report_versions__tenant_id_patient_id__p_idx ON reporting.report_versions (tenant_id, patient_id)
  WHERE status IN ('released','superseded');                                                 -- patient-actor policy / getReleasedReports
CREATE INDEX report_versions__tenant_id_partner_id__p_idx ON reporting.report_versions (tenant_id, partner_id)
  WHERE partner_id IS NOT NULL AND status IN ('released','superseded');                       -- partner-actor policy
CREATE TRIGGER report_versions__mutable_columns BEFORE UPDATE ON reporting.report_versions FOR EACH ROW EXECUTE FUNCTION
  app.enforce_mutable_columns('status','render_attempts','last_render_error_code','rendering_started_at','rendered_at',
   'pdf_object_path','pdf_sha256','pdf_bytes','page_count','released_at','released_by','release_mode','release_basis',
   'release_override_id','audiences','supersedes_version_no','superseded_at','superseded_by_version_no','discarded_at',
   'discard_reason','held_basis','held_checked_at','updated_at','updated_by','version');

CREATE FUNCTION reporting.tg_report_versions_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF OLD.pdf_object_path IS NOT NULL AND (NEW.pdf_object_path IS DISTINCT FROM OLD.pdf_object_path
       OR NEW.pdf_sha256 IS DISTINCT FROM OLD.pdf_sha256 OR NEW.pdf_bytes IS DISTINCT FROM OLD.pdf_bytes
       OR NEW.page_count IS DISTINCT FROM OLD.page_count) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'reporting.report_versions pdf';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'rendering'     AND NEW.status IN ('rendered','render_failed','discarded')) OR
       (OLD.status = 'render_failed' AND NEW.status IN ('rendering','discarded')) OR
       (OLD.status = 'rendered'      AND NEW.status IN ('released','discarded')) OR
       (OLD.status = 'released'      AND NEW.status = 'superseded')) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'reporting.report_versions status';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER report_versions__guard BEFORE UPDATE ON reporting.report_versions FOR EACH ROW EXECUTE FUNCTION reporting.tg_report_versions_guard();

CREATE TABLE reporting.qr_tokens (
  id uuid NOT NULL, tenant_id uuid NOT NULL, centre_id uuid NOT NULL, report_id uuid NOT NULL, report_version_id uuid NOT NULL,
  token_sha256 bytea NOT NULL, lab_name_snapshot text NOT NULL, patient_display_snapshot text NOT NULL,
  panel_names_snapshot text[] NOT NULL, issued_at timestamptz NOT NULL,
  revoked_at timestamptz, revoked_by uuid, revoke_reason_code text, revoke_reason_text text,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT qr_tokens__pk PRIMARY KEY (id),
  CONSTRAINT qr_tokens__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT qr_tokens__tenant_id_report_version_id__uq UNIQUE (tenant_id, report_version_id),
  CONSTRAINT qr_tokens__version__fk FOREIGN KEY (tenant_id, report_version_id) REFERENCES reporting.report_versions (tenant_id, id),
  CONSTRAINT qr_tokens__report__fk FOREIGN KEY (tenant_id, report_id) REFERENCES reporting.reports (tenant_id, id),
  CONSTRAINT qr_tokens__sha__ck CHECK (octet_length(token_sha256) = 32),   -- 08 R24
  CONSTRAINT qr_tokens__len__ck CHECK (char_length(lab_name_snapshot) <= 160 AND char_length(patient_display_snapshot) <= 60
     AND cardinality(panel_names_snapshot) <= 20 AND (revoke_reason_text IS NULL OR char_length(revoke_reason_text) <= 500))
);
CREATE UNIQUE INDEX qr_tokens__token_sha256__uq ON reporting.qr_tokens (token_sha256);       -- global: CR-C6-002
CREATE TRIGGER qr_tokens__mutable_columns BEFORE UPDATE ON reporting.qr_tokens FOR EACH ROW EXECUTE FUNCTION
  app.enforce_mutable_columns('revoked_at','revoked_by','revoke_reason_code','revoke_reason_text','updated_at','updated_by','version');

CREATE TABLE reporting.deliveries (
  id uuid NOT NULL, tenant_id uuid NOT NULL, centre_id uuid,
  channel text NOT NULL, purpose text NOT NULL, template_code text,                               -- NULL only for print/portal (review fix #5)
  recipient_kind text NOT NULL, recipient_id uuid, destination_masked text, destination_sha256 bytea, destination_e164 text,
  params jsonb NOT NULL DEFAULT '{}', language text NOT NULL DEFAULT 'en', idempotency_key text NOT NULL,
  related_entity_type text, related_entity_id uuid, report_id uuid, report_version_no integer, deferred_link jsonb, link_id uuid,
  status text NOT NULL, failure_code text, attempt_no integer NOT NULL DEFAULT 1,
  channel_account_id uuid, provider_kind text, provider_message_id text, fallback_of_delivery_id uuid, fallback_check_at timestamptz,
  queued_at timestamptz, sent_at timestamptz, delivered_at timestamptz, read_at timestamptz, failed_at timestamptz, suppressed_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT deliveries__pk PRIMARY KEY (id),
  CONSTRAINT deliveries__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT deliveries__tenant_id_idempotency_key__uq UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT deliveries__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT deliveries__centre__fk FOREIGN KEY (tenant_id, centre_id) REFERENCES core.collection_centres (tenant_id, id),
  CONSTRAINT deliveries__template__fk FOREIGN KEY (template_code) REFERENCES reporting.g_message_templates (code),
  CONSTRAINT deliveries__report__fk FOREIGN KEY (tenant_id, report_id) REFERENCES reporting.reports (tenant_id, id),
  CONSTRAINT deliveries__account__fk FOREIGN KEY (tenant_id, channel_account_id) REFERENCES reporting.channel_accounts (tenant_id, id),
  CONSTRAINT deliveries__fallback__fk FOREIGN KEY (tenant_id, fallback_of_delivery_id) REFERENCES reporting.deliveries (tenant_id, id),
  CONSTRAINT deliveries__channel__ck CHECK (channel IN ('whatsapp','sms','email','print','portal')),
  CONSTRAINT deliveries__template_presence__ck CHECK ((channel IN ('print','portal')) = (template_code IS NULL)),
  CONSTRAINT deliveries__purpose__ck CHECK (purpose IN ('registration_confirmation','report_ready','otp','dues_reminder',
    'recollection_request','critical_value_alert','booking_confirmation','visit_assignment','follow_up_reminder',
    'scheduled_report_ready','booking_cancelled','booking_reminder')),   -- 08 R13
  CONSTRAINT deliveries__recipient__ck CHECK (recipient_kind IN ('patient','referrer','centre','partner','staff','phone_otp')),
  CONSTRAINT deliveries__e164__ck CHECK (destination_e164 IS NULL OR (recipient_kind = 'phone_otp' AND destination_e164 ~ '^\+[1-9][0-9]{7,14}$')),
  CONSTRAINT deliveries__dest__ck CHECK ((destination_masked IS NULL OR char_length(destination_masked) <= 40)
     AND (destination_sha256 IS NULL OR octet_length(destination_sha256) = 32)),
  CONSTRAINT deliveries__language__ck CHECK (language IN ('en','ne')),
  CONSTRAINT deliveries__key__ck CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
  CONSTRAINT deliveries__related__ck CHECK (related_entity_type IS NULL OR related_entity_type IN ('order','report','specimen','booking','visit','critical_event','report_run')),
  CONSTRAINT deliveries__status__ck CHECK (status IN ('queued','sent','delivered','read','failed','suppressed')),
  CONSTRAINT deliveries__provider__ck CHECK (provider_kind IS NULL OR provider_kind IN ('recording','whatsapp_cloud_api','sms_sparrow','sms_aakash','email_smtp_relay')),
  CONSTRAINT deliveries__params__ck CHECK (jsonb_typeof(params) = 'object' AND octet_length(params::text) <= 2048)
);
CREATE INDEX deliveries__tenant_id_report_id_created_at__idx ON reporting.deliveries (tenant_id, report_id, created_at DESC);
CREATE INDEX deliveries__tenant_id_status_fallback_check_at__p_idx ON reporting.deliveries (tenant_id, status, fallback_check_at) WHERE status IN ('queued','sent');
CREATE UNIQUE INDEX deliveries__tenant_id_channel_account_id_provider_message_id__p_uq ON reporting.deliveries (tenant_id, channel_account_id, provider_message_id) WHERE provider_message_id IS NOT NULL;
CREATE UNIQUE INDEX deliveries__tenant_id_fallback_of_delivery_id__p_uq ON reporting.deliveries (tenant_id, fallback_of_delivery_id) WHERE fallback_of_delivery_id IS NOT NULL;
CREATE INDEX deliveries__tenant_id_created_at__idx ON reporting.deliveries (tenant_id, created_at);
CREATE INDEX deliveries__tenant_id_related_entity_id__p_idx ON reporting.deliveries (tenant_id, related_entity_id) WHERE related_entity_id IS NOT NULL;
CREATE INDEX deliveries__tenant_id_purpose_created_at__idx ON reporting.deliveries (tenant_id, purpose, created_at DESC);   -- listCriticalAlerts
CREATE TRIGGER deliveries__mutable_columns BEFORE UPDATE ON reporting.deliveries FOR EACH ROW EXECUTE FUNCTION
  app.enforce_mutable_columns('status','failure_code','attempt_no','channel_account_id','provider_kind','provider_message_id','link_id',
   'fallback_check_at','queued_at','sent_at','delivered_at','read_at','failed_at','suppressed_at','destination_masked','destination_sha256',
   'params','destination_e164','updated_at','updated_by','version');
CREATE FUNCTION reporting.tg_deliveries_scrub_only() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.params IS DISTINCT FROM OLD.params AND NEW.params IS DISTINCT FROM (OLD.params - 'url' - 'otp_code') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'reporting.deliveries params';
  END IF;
  IF NEW.destination_e164 IS DISTINCT FROM OLD.destination_e164 AND NEW.destination_e164 IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'reporting.deliveries destination';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER deliveries__scrub_only BEFORE UPDATE ON reporting.deliveries FOR EACH ROW EXECUTE FUNCTION reporting.tg_deliveries_scrub_only();

CREATE TABLE reporting.portal_links (
  id uuid NOT NULL, tenant_id uuid NOT NULL, centre_id uuid NOT NULL, report_id uuid NOT NULL, bound_version_no integer NOT NULL,
  channel text NOT NULL, recipient_kind text NOT NULL, recipient_ref_id uuid, otp_channel text,
  destination_masked text, destination_sha256 bytea, patient_display_snapshot text NOT NULL,
  token_sha256 bytea NOT NULL, expires_at timestamptz NOT NULL,
  revoked_at timestamptz, revoked_by uuid, revoke_reason_code text,
  delivery_id uuid, reissued_from_link_id uuid, last_used_at timestamptz, use_count integer NOT NULL DEFAULT 0,
  reissue_count_day integer NOT NULL DEFAULT 0, reissue_day date,
  redeem_failures smallint NOT NULL DEFAULT 0,                                                  -- 08 A13 D-30
  purpose text NOT NULL DEFAULT 'report',                                                       -- 08 A21.1: 'dues' = dues-only link
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT portal_links__pk PRIMARY KEY (id),
  CONSTRAINT portal_links__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT portal_links__report__fk FOREIGN KEY (tenant_id, report_id) REFERENCES reporting.reports (tenant_id, id),
  CONSTRAINT portal_links__centre__fk FOREIGN KEY (tenant_id, centre_id) REFERENCES core.collection_centres (tenant_id, id),
  CONSTRAINT portal_links__delivery__fk FOREIGN KEY (tenant_id, delivery_id) REFERENCES reporting.deliveries (tenant_id, id),
  CONSTRAINT portal_links__reissued__fk FOREIGN KEY (tenant_id, reissued_from_link_id) REFERENCES reporting.portal_links (tenant_id, id),
  CONSTRAINT portal_links__channel__ck CHECK (channel IN ('whatsapp','sms','email','print_qr','patient_app')),
  CONSTRAINT portal_links__recipient__ck CHECK (recipient_kind IN ('patient','referrer','centre','partner')),
  CONSTRAINT portal_links__otp_channel__ck CHECK (otp_channel IS NULL OR otp_channel IN ('sms','email')),
  CONSTRAINT portal_links__sha__ck CHECK (octet_length(token_sha256) = 32 AND (destination_sha256 IS NULL OR octet_length(destination_sha256) = 32)),   -- 08 R24
  CONSTRAINT portal_links__len__ck CHECK (char_length(patient_display_snapshot) <= 60 AND (destination_masked IS NULL OR char_length(destination_masked) <= 40)),
  CONSTRAINT portal_links__ttl__ck CHECK (expires_at > created_at AND expires_at <= created_at + interval '90 days'),    -- 04 A10
  CONSTRAINT portal_links__redeem_failures__ck CHECK (redeem_failures BETWEEN 0 AND 5),                                -- 08 A13 D-30
  CONSTRAINT portal_links__purpose__ck CHECK (purpose IN ('report','dues')
     AND (purpose = 'report' OR (recipient_kind = 'patient' AND channel IN ('sms','whatsapp'))))                     -- 08 A21.1
);
CREATE UNIQUE INDEX portal_links__token_sha256__uq ON reporting.portal_links (token_sha256);  -- global: CR-C6-002
CREATE INDEX portal_links__tenant_id_report_id__idx ON reporting.portal_links (tenant_id, report_id);
CREATE INDEX portal_links__tenant_id_delivery_id__p_idx ON reporting.portal_links (tenant_id, delivery_id) WHERE delivery_id IS NOT NULL;
ALTER TABLE reporting.deliveries ADD CONSTRAINT deliveries__link__fk FOREIGN KEY (tenant_id, link_id) REFERENCES reporting.portal_links (tenant_id, id);  -- circular pair: added after portal_links
CREATE TRIGGER portal_links__mutable_columns BEFORE UPDATE ON reporting.portal_links FOR EACH ROW EXECUTE FUNCTION
  app.enforce_mutable_columns('revoked_at','revoked_by','revoke_reason_code','delivery_id','last_used_at','use_count',
   'reissue_count_day','reissue_day','redeem_failures','updated_at','updated_by','version');
-- review fix #35: revocation is one-way; portal actors and the lookup role may touch only their own counters
CREATE FUNCTION reporting.tg_portal_links_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE v_changed text[];
BEGIN
  IF OLD.revoked_at IS NOT NULL AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at OR NEW.revoked_by IS DISTINCT FROM OLD.revoked_by
       OR NEW.revoke_reason_code IS DISTINCT FROM OLD.revoke_reason_code) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'reporting.portal_links revoked';
  END IF;
  IF OLD.delivery_id IS NOT NULL AND NEW.delivery_id IS DISTINCT FROM OLD.delivery_id THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'reporting.portal_links delivery';
  END IF;
  IF NEW.redeem_failures < OLD.redeem_failures THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'reporting.portal_links redeem_failures';
  END IF;
  SELECT coalesce(array_agg(n.key), '{}') INTO v_changed
    FROM jsonb_each(to_jsonb(NEW)) n JOIN jsonb_each(to_jsonb(OLD)) o ON o.key = n.key
   WHERE n.value IS DISTINCT FROM o.value;
  IF current_user = 'lims_reporting_lookup' THEN          -- inside app.reporting_redeem_link_for_app (no claims)
    IF NOT (v_changed <@ ARRAY['redeem_failures','updated_at','version']) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'reporting.portal_links lookup';
    END IF;
  ELSIF (SELECT app.current_actor_type()) = 'portal'
     AND NOT (v_changed <@ ARRAY['last_used_at','use_count','reissue_count_day','reissue_day','updated_at','updated_by','version']) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'reporting.portal_links portal';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER portal_links__guard BEFORE UPDATE ON reporting.portal_links FOR EACH ROW EXECUTE FUNCTION reporting.tg_portal_links_guard();
-- Row audit (§1 note): C0 attaches these two triggers instead of its default single audit trigger on this table.
CREATE TRIGGER portal_links__audit_ins AFTER INSERT ON reporting.portal_links FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER portal_links__audit_upd AFTER UPDATE ON reporting.portal_links FOR EACH ROW
  WHEN ((to_jsonb(OLD) - ARRAY['redeem_failures','updated_at','version']) IS DISTINCT FROM
        (to_jsonb(NEW) - ARRAY['redeem_failures','updated_at','version']))
  EXECUTE FUNCTION app.tg_row_audit();

CREATE TABLE reporting.otp_challenges (
  id uuid NOT NULL, tenant_id uuid NOT NULL, link_id uuid NOT NULL, channel text NOT NULL,
  destination_sha256 bytea,                                                                -- NULL until resolved by the worker (08 A13 D-31)
  code_hmac bytea, status text NOT NULL DEFAULT 'pending_send', attempts smallint NOT NULL DEFAULT 0,   -- bytea: 08 Addendum A2.4
  failure_code text,
  expires_at timestamptz NOT NULL, verified_at timestamptz, delivery_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  CONSTRAINT otp_challenges__pk PRIMARY KEY (id),
  CONSTRAINT otp_challenges__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT otp_challenges__link__fk FOREIGN KEY (tenant_id, link_id) REFERENCES reporting.portal_links (tenant_id, id),
  CONSTRAINT otp_challenges__channel__ck CHECK (channel IN ('sms','email')),
  CONSTRAINT otp_challenges__dest__ck CHECK (destination_sha256 IS NULL OR octet_length(destination_sha256) = 32),   -- 08 R24
  CONSTRAINT otp_challenges__dest_resolved__ck CHECK (status IN ('pending_send','failed','superseded','expired')
     OR destination_sha256 IS NOT NULL),                                                   -- 08 A13 D-31 (extended, §2.6)
  CONSTRAINT otp_challenges__hmac__ck CHECK (code_hmac IS NULL OR octet_length(code_hmac) = 32),   -- 08 A2.4 (R24 scope)
  CONSTRAINT otp_challenges__status__ck CHECK (status IN ('pending_send','pending','verified','exhausted','expired','superseded','failed')),
  CONSTRAINT otp_challenges__failure__ck CHECK ((failure_code IS NULL OR failure_code IN ('no_contact','send_rate_limited'))
     AND (status <> 'failed' OR failure_code IS NOT NULL)),
  CONSTRAINT otp_challenges__attempts__ck CHECK (attempts BETWEEN 0 AND 5),                  -- 04 A9
  CONSTRAINT otp_challenges__ttl__ck CHECK (expires_at <= created_at + interval '10 minutes') -- 04 A9
);
CREATE INDEX otp_challenges__tenant_id_link_id_created_at__idx ON reporting.otp_challenges (tenant_id, link_id, created_at DESC);
CREATE INDEX otp_challenges__tenant_id_expires_at__idx ON reporting.otp_challenges (tenant_id, expires_at);

CREATE TABLE reporting.portal_sessions (
  id uuid NOT NULL, tenant_id uuid NOT NULL, link_id uuid NOT NULL, report_id uuid NOT NULL, token_sha256 bytea NOT NULL,
  last_seen_at timestamptz NOT NULL, idle_expires_at timestamptz NOT NULL, absolute_expires_at timestamptz NOT NULL,
  ended_at timestamptz, user_agent_sha256 text,
  link_purpose text NOT NULL DEFAULT 'report',                                              -- copy of portal_links.purpose (08 A21.1)
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  CONSTRAINT portal_sessions__pk PRIMARY KEY (id),
  CONSTRAINT portal_sessions__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT portal_sessions__link__fk FOREIGN KEY (tenant_id, link_id) REFERENCES reporting.portal_links (tenant_id, id),
  CONSTRAINT portal_sessions__sha__ck CHECK (octet_length(token_sha256) = 32),   -- 08 R24
  CONSTRAINT portal_sessions__abs__ck CHECK (absolute_expires_at <= created_at + interval '12 hours'),
  CONSTRAINT portal_sessions__purpose__ck CHECK (link_purpose IN ('report','dues'))
);
CREATE UNIQUE INDEX portal_sessions__token_sha256__uq ON reporting.portal_sessions (token_sha256);  -- global: CR-C6-002
CREATE INDEX portal_sessions__tenant_id_absolute_expires_at__idx ON reporting.portal_sessions (tenant_id, absolute_expires_at);

CREATE TABLE reporting.delivery_attempts (
  id uuid NOT NULL, tenant_id uuid NOT NULL, delivery_id uuid NOT NULL, attempt_no integer NOT NULL,
  started_at timestamptz NOT NULL, finished_at timestamptz, outcome text NOT NULL, error_code text,
  provider_status_raw text, latency_ms integer,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  CONSTRAINT delivery_attempts__pk PRIMARY KEY (id),
  CONSTRAINT delivery_attempts__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT delivery_attempts__tenant_id_delivery_id_attempt_no__uq UNIQUE (tenant_id, delivery_id, attempt_no),
  CONSTRAINT delivery_attempts__delivery__fk FOREIGN KEY (tenant_id, delivery_id) REFERENCES reporting.deliveries (tenant_id, id),
  CONSTRAINT delivery_attempts__outcome__ck CHECK (outcome IN ('accepted','retryable_error','permanent_error','suppressed','circuit_open')),
  CONSTRAINT delivery_attempts__len__ck CHECK ((error_code IS NULL OR char_length(error_code) <= 64) AND (provider_status_raw IS NULL OR char_length(provider_status_raw) <= 64))
);

CREATE TABLE reporting.provider_events (
  id uuid NOT NULL, tenant_id uuid NOT NULL, channel_account_id uuid NOT NULL, provider_kind text NOT NULL,
  provider_message_id text NOT NULL, status_raw text NOT NULL, mapped_status text NOT NULL, occurred_at timestamptz,
  received_at timestamptz NOT NULL DEFAULT now(), delivery_id uuid, applied_at timestamptz, ignored_reason text,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  CONSTRAINT provider_events__pk PRIMARY KEY (id),
  CONSTRAINT provider_events__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT provider_events__dedupe__uq UNIQUE (tenant_id, channel_account_id, provider_message_id, mapped_status),
  CONSTRAINT provider_events__account__fk FOREIGN KEY (tenant_id, channel_account_id) REFERENCES reporting.channel_accounts (tenant_id, id),
  CONSTRAINT provider_events__mapped__ck CHECK (mapped_status IN ('sent','delivered','read','failed')),
  CONSTRAINT provider_events__len__ck CHECK (char_length(provider_message_id) <= 128 AND char_length(status_raw) <= 64),
  CONSTRAINT provider_events__ignored__ck CHECK (ignored_reason IS NULL OR ignored_reason IN ('unknown_message','duplicate','backwards'))
);
CREATE INDEX provider_events__tenant_id_received_at__idx ON reporting.provider_events (tenant_id, received_at);
CREATE TRIGGER provider_events__mutable_columns BEFORE UPDATE ON reporting.provider_events FOR EACH ROW EXECUTE FUNCTION
  app.enforce_mutable_columns('applied_at','delivery_id','ignored_reason');

CREATE TABLE reporting.narrative_reports (
  id uuid NOT NULL, tenant_id uuid NOT NULL, centre_id uuid NOT NULL, report_id uuid NOT NULL, order_id uuid NOT NULL,
  order_item_id uuid NOT NULL, test_id uuid NOT NULL, template_kind text NOT NULL, status text NOT NULL DEFAULT 'draft',
  current_version_no integer NOT NULL DEFAULT 1, signed_version_no integer,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT narrative_reports__pk PRIMARY KEY (id),
  CONSTRAINT narrative_reports__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT narrative_reports__tenant_id_order_item_id_test_id__uq UNIQUE (tenant_id, order_item_id, test_id),
  CONSTRAINT narrative_reports__report__fk FOREIGN KEY (tenant_id, report_id) REFERENCES reporting.reports (tenant_id, id),
  CONSTRAINT narrative_reports__centre__fk FOREIGN KEY (tenant_id, centre_id) REFERENCES core.collection_centres (tenant_id, id),
  CONSTRAINT narrative_reports__item__fk FOREIGN KEY (tenant_id, order_item_id) REFERENCES frontdesk.order_items (tenant_id, id),
  CONSTRAINT narrative_reports__test__fk FOREIGN KEY (tenant_id, test_id) REFERENCES catalog.tests (tenant_id, id),
  CONSTRAINT narrative_reports__kind__ck CHECK (template_kind IN ('xray','usg','endoscopy','cytogenetics','other')),
  CONSTRAINT narrative_reports__status__ck CHECK (status IN ('draft','signed','amending','cancelled'))
);
CREATE INDEX narrative_reports__tenant_id_centre_id_status__idx ON reporting.narrative_reports (tenant_id, centre_id, status);

CREATE TABLE reporting.input_files (
  id uuid NOT NULL, tenant_id uuid NOT NULL, centre_id uuid NOT NULL, order_id uuid NOT NULL, order_item_id uuid,
  narrative_report_id uuid, kind text NOT NULL, state text NOT NULL DEFAULT 'pending_scan',
  original_filename text NOT NULL, declared_mime text NOT NULL, detected_mime text, size_bytes bigint NOT NULL,
  sha256_original text NOT NULL, quarantine_object_path text NOT NULL, sanitized_object_path text, sanitized_sha256 text,
  page_count integer, image_width integer, image_height integer, external_lab_name text, caption text,
  sort_order smallint NOT NULL DEFAULT 0, confirmed_by uuid, confirmed_at timestamptz,
  withdrawn_reason_code text, withdrawn_reason_text text, last_error_code text,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT input_files__pk PRIMARY KEY (id),
  CONSTRAINT input_files__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT input_files__centre__fk FOREIGN KEY (tenant_id, centre_id) REFERENCES core.collection_centres (tenant_id, id),
  CONSTRAINT input_files__item__fk FOREIGN KEY (tenant_id, order_item_id) REFERENCES frontdesk.order_items (tenant_id, id),
  CONSTRAINT input_files__narrative__fk FOREIGN KEY (tenant_id, narrative_report_id) REFERENCES reporting.narrative_reports (tenant_id, id),
  CONSTRAINT input_files__kind__ck CHECK (kind IN ('outsourced_pdf','narrative_image')),
  CONSTRAINT input_files__state__ck CHECK (state IN ('pending_scan','scanning','quarantined','sanitizing','ready','rejected','confirmed','withdrawn')),
  CONSTRAINT input_files__mime__ck CHECK (declared_mime IN ('application/pdf','image/png','image/jpeg')
     AND (detected_mime IS NULL OR detected_mime IN ('application/pdf','image/png','image/jpeg'))),
  CONSTRAINT input_files__size__ck CHECK (size_bytes BETWEEN 1 AND 15728640),                -- 02-CV §10.2
  CONSTRAINT input_files__paths__ck CHECK (quarantine_object_path LIKE tenant_id::text || '/quarantine/%'
     AND (sanitized_object_path IS NULL OR sanitized_object_path LIKE tenant_id::text || '/%')),
  CONSTRAINT input_files__kind_fields__ck CHECK ((kind = 'outsourced_pdf' AND order_item_id IS NOT NULL AND external_lab_name IS NOT NULL)
     OR (kind = 'narrative_image' AND narrative_report_id IS NOT NULL)),
  CONSTRAINT input_files__len__ck CHECK (char_length(original_filename) <= 200 AND (external_lab_name IS NULL OR char_length(external_lab_name) <= 120)
     AND (caption IS NULL OR char_length(caption) <= 200) AND (withdrawn_reason_text IS NULL OR char_length(withdrawn_reason_text) <= 500)),
  CONSTRAINT input_files__sha__ck CHECK (sha256_original ~ '^[0-9a-f]{64}$' AND (sanitized_sha256 IS NULL OR sanitized_sha256 ~ '^[0-9a-f]{64}$'))
);
CREATE INDEX input_files__tenant_id_order_item_id__idx ON reporting.input_files (tenant_id, order_item_id);
CREATE INDEX input_files__tenant_id_state__p_idx ON reporting.input_files (tenant_id, state) WHERE state IN ('pending_scan','scanning','sanitizing');
CREATE INDEX input_files__tenant_id_narrative_report_id__p_idx ON reporting.input_files (tenant_id, narrative_report_id) WHERE narrative_report_id IS NOT NULL;
CREATE TRIGGER input_files__mutable_columns BEFORE UPDATE ON reporting.input_files FOR EACH ROW EXECUTE FUNCTION
  app.enforce_mutable_columns('state','detected_mime','sanitized_object_path','sanitized_sha256','page_count','image_width','image_height',
   'caption','sort_order','confirmed_by','confirmed_at','withdrawn_reason_code','withdrawn_reason_text','last_error_code','updated_at','updated_by','version');

CREATE TABLE reporting.narrative_versions (
  id uuid NOT NULL, tenant_id uuid NOT NULL, centre_id uuid NOT NULL, narrative_report_id uuid NOT NULL, version_no integer NOT NULL,
  status text NOT NULL DEFAULT 'draft', template_id uuid, sections jsonb NOT NULL, image_file_ids uuid[] NOT NULL DEFAULT '{}',
  signed_by_membership_id uuid, signed_at timestamptz, content_sha256 text,
  amendment_of_version_no integer, amendment_reason_code text, amendment_reason_text text,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT narrative_versions__pk PRIMARY KEY (id),
  CONSTRAINT narrative_versions__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT narrative_versions__tenant_id_narrative_report_id_version_no__uq UNIQUE (tenant_id, narrative_report_id, version_no),
  CONSTRAINT narrative_versions__narrative__fk FOREIGN KEY (tenant_id, narrative_report_id) REFERENCES reporting.narrative_reports (tenant_id, id),
  CONSTRAINT narrative_versions__centre__fk FOREIGN KEY (tenant_id, centre_id) REFERENCES core.collection_centres (tenant_id, id),
  CONSTRAINT narrative_versions__template__fk FOREIGN KEY (tenant_id, template_id) REFERENCES reporting.narrative_templates (tenant_id, id),
  CONSTRAINT narrative_versions__signer__fk FOREIGN KEY (tenant_id, signed_by_membership_id) REFERENCES core.memberships (tenant_id, id),
  CONSTRAINT narrative_versions__status__ck CHECK (status IN ('draft','signed','superseded','cancelled')),
  CONSTRAINT narrative_versions__sections__ck CHECK (jsonb_typeof(sections) = 'array' AND jsonb_array_length(sections) <= 12
     AND octet_length(sections::text) <= 262144),
  CONSTRAINT narrative_versions__images__ck CHECK (cardinality(image_file_ids) <= 12),
  CONSTRAINT narrative_versions__signed__ck CHECK (status NOT IN ('signed','superseded') OR (signed_by_membership_id IS NOT NULL
     AND signed_at IS NOT NULL AND content_sha256 ~ '^[0-9a-f]{64}$')),
  CONSTRAINT narrative_versions__reason__ck CHECK (amendment_reason_text IS NULL OR char_length(amendment_reason_text) <= 500)
);
CREATE FUNCTION reporting.tg_narrative_versions_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF OLD.status IN ('signed','superseded','cancelled') THEN
    IF (to_jsonb(OLD) - ARRAY['status','updated_at','updated_by','version']) IS DISTINCT FROM
       (to_jsonb(NEW) - ARRAY['status','updated_at','updated_by','version'])
       OR NOT (OLD.status = NEW.status OR (OLD.status = 'signed' AND NEW.status = 'superseded')) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'reporting.narrative_versions';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER narrative_versions__guard BEFORE UPDATE ON reporting.narrative_versions FOR EACH ROW EXECUTE FUNCTION reporting.tg_narrative_versions_guard();

CREATE TABLE reporting.print_jobs (
  id uuid NOT NULL, tenant_id uuid NOT NULL, centre_id uuid NOT NULL, kind text NOT NULL,
  report_version_ids uuid[] NOT NULL DEFAULT '{}', excluded_ids uuid[] NOT NULL DEFAULT '{}', template_version_id uuid,
  variant text NOT NULL, copies smallint NOT NULL DEFAULT 1, draft_watermark boolean NOT NULL DEFAULT false,
  state text NOT NULL DEFAULT 'rendering', object_path text, sha256 text, page_count integer,
  expires_at timestamptz NOT NULL, error_code text,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL, version integer NOT NULL DEFAULT 1,
  CONSTRAINT print_jobs__pk PRIMARY KEY (id),
  CONSTRAINT print_jobs__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT print_jobs__centre__fk FOREIGN KEY (tenant_id, centre_id) REFERENCES core.collection_centres (tenant_id, id),
  CONSTRAINT print_jobs__kind__ck CHECK (kind IN ('single','bulk','template_preview')),
  CONSTRAINT print_jobs__ids__ck CHECK (cardinality(report_version_ids) <= 200),
  CONSTRAINT print_jobs__variant__ck CHECK (variant IN ('letterhead','plain')),
  CONSTRAINT print_jobs__copies__ck CHECK (copies BETWEEN 1 AND 5),
  CONSTRAINT print_jobs__state__ck CHECK (state IN ('rendering','ready','failed','expired')),
  CONSTRAINT print_jobs__path__ck CHECK (object_path IS NULL OR object_path LIKE tenant_id::text || '/prints/%'),
  CONSTRAINT print_jobs__ttl__ck CHECK (expires_at <= created_at + interval '48 hours')
);
CREATE INDEX print_jobs__tenant_id_expires_at__idx ON reporting.print_jobs (tenant_id, expires_at);

-- ===================== reporting: portal dues payment (08 Addendum A11.1; ships with C15) =====================
CREATE TABLE reporting.portal_payment_requests (
  id uuid NOT NULL, tenant_id uuid NOT NULL, link_id uuid NOT NULL, report_id uuid NOT NULL, order_id uuid NOT NULL,
  gateway text NOT NULL, status text NOT NULL DEFAULT 'queued', review boolean NOT NULL DEFAULT false,
  intent_id uuid, amount_paisa bigint, action_json jsonb, failure_code text,
  intent_expires_at timestamptz, last_checked_at timestamptz, completed_at timestamptz,
  expires_at timestamptz NOT NULL,                                                         -- row retention (E): created_at + 90 days [CONV]
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT portal_payment_requests__pk PRIMARY KEY (id),
  CONSTRAINT portal_payment_requests__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT portal_payment_requests__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT portal_payment_requests__link__fk FOREIGN KEY (tenant_id, link_id) REFERENCES reporting.portal_links (tenant_id, id),
  CONSTRAINT portal_payment_requests__report__fk FOREIGN KEY (tenant_id, report_id) REFERENCES reporting.reports (tenant_id, id),
  CONSTRAINT portal_payment_requests__order__fk FOREIGN KEY (tenant_id, order_id) REFERENCES frontdesk.orders (tenant_id, id),
  CONSTRAINT portal_payment_requests__gateway__ck CHECK (gateway IN ('esewa','khalti')),                 -- Fonepay BLOCKED B8
  CONSTRAINT portal_payment_requests__status__ck CHECK (status IN ('queued','ready','completed','failed','expired')),
  CONSTRAINT portal_payment_requests__action__ck CHECK ((status = 'ready' AND NOT review) OR action_json IS NULL),
  CONSTRAINT portal_payment_requests__action_shape__ck CHECK (action_json IS NULL
     OR (jsonb_typeof(action_json) = 'object' AND jsonb_typeof(action_json -> 'url') = 'string' AND octet_length(action_json::text) <= 4096)),
  CONSTRAINT portal_payment_requests__ready__ck CHECK (status NOT IN ('ready','completed') OR (intent_id IS NOT NULL AND amount_paisa IS NOT NULL)),
  CONSTRAINT portal_payment_requests__amount__ck CHECK (amount_paisa IS NULL OR amount_paisa > 0),
  CONSTRAINT portal_payment_requests__failure__ck CHECK ((failure_code IS NULL OR char_length(failure_code) BETWEEN 1 AND 64)
     AND (status <> 'failed' OR failure_code IS NOT NULL)),
  CONSTRAINT portal_payment_requests__completed__ck CHECK (status <> 'completed' OR completed_at IS NOT NULL),
  CONSTRAINT portal_payment_requests__ttl__ck CHECK (expires_at > created_at AND expires_at <= created_at + interval '120 days')
);
CREATE UNIQUE INDEX portal_payment_requests__tenant_id_order_id__open__p_uq ON reporting.portal_payment_requests (tenant_id, order_id)
  WHERE status IN ('queued','ready');
CREATE INDEX portal_payment_requests__tenant_id_link_id_created_at__idx ON reporting.portal_payment_requests (tenant_id, link_id, created_at DESC);
CREATE INDEX portal_payment_requests__tenant_id_intent_expires_at__p_idx ON reporting.portal_payment_requests (tenant_id, intent_expires_at)
  WHERE status = 'ready';
CREATE INDEX portal_payment_requests__tenant_id_expires_at__idx ON reporting.portal_payment_requests (tenant_id, expires_at);
CREATE TRIGGER portal_payment_requests__mutable_columns BEFORE UPDATE ON reporting.portal_payment_requests FOR EACH ROW EXECUTE FUNCTION
  app.enforce_mutable_columns('status','review','intent_id','amount_paisa','action_json','failure_code','intent_expires_at',
   'last_checked_at','completed_at','updated_at','updated_by','version');
CREATE FUNCTION reporting.tg_portal_payment_requests_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF OLD.status IN ('completed','failed','expired') AND (to_jsonb(NEW) - ARRAY['updated_at','updated_by','version'])
       IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['updated_at','updated_by','version']) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'reporting.portal_payment_requests terminal';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'queued' AND NEW.status IN ('ready','failed')) OR
       (OLD.status = 'ready'  AND NEW.status IN ('completed','failed','expired'))) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'reporting.portal_payment_requests status';
  END IF;
  IF (OLD.intent_id IS NOT NULL AND NEW.intent_id IS DISTINCT FROM OLD.intent_id)
     OR (OLD.amount_paisa IS NOT NULL AND NEW.amount_paisa IS DISTINCT FROM OLD.amount_paisa) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'reporting.portal_payment_requests intent';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER portal_payment_requests__guard BEFORE UPDATE ON reporting.portal_payment_requests FOR EACH ROW
  EXECUTE FUNCTION reporting.tg_portal_payment_requests_guard();

-- =====================================================================
-- §6.1 RLS and policies, §6.3 lims_app grants (literal; owner lims_owner)
-- =====================================================================
ALTER TABLE reporting.settings ENABLE ROW LEVEL SECURITY;  ALTER TABLE reporting.settings FORCE ROW LEVEL SECURITY;
CREATE POLICY settings__select__portal ON reporting.settings FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'portal'
         AND (SELECT app.current_claims() ->> 'portal_stage') = 'session');
CREATE POLICY settings__select__tenant ON reporting.settings FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY settings__insert__tenant ON reporting.settings FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY settings__update__tenant ON reporting.settings FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
GRANT SELECT, INSERT, UPDATE ON reporting.settings TO lims_app;
ALTER TABLE reporting.staff_assignments ENABLE ROW LEVEL SECURITY;  ALTER TABLE reporting.staff_assignments FORCE ROW LEVEL SECURITY;
CREATE POLICY staff_assignments__select__tenant ON reporting.staff_assignments FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY staff_assignments__insert__tenant ON reporting.staff_assignments FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY staff_assignments__update__tenant ON reporting.staff_assignments FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
GRANT SELECT, INSERT, UPDATE ON reporting.staff_assignments TO lims_app;
ALTER TABLE reporting.centre_contacts ENABLE ROW LEVEL SECURITY;  ALTER TABLE reporting.centre_contacts FORCE ROW LEVEL SECURITY;
CREATE POLICY centre_contacts__select__tenant_centre ON reporting.centre_contacts FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY centre_contacts__insert__tenant_centre ON reporting.centre_contacts FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY centre_contacts__update__tenant_centre ON reporting.centre_contacts FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
GRANT SELECT, INSERT, UPDATE ON reporting.centre_contacts TO lims_app;
ALTER TABLE reporting.referrer_preferences ENABLE ROW LEVEL SECURITY;  ALTER TABLE reporting.referrer_preferences FORCE ROW LEVEL SECURITY;
CREATE POLICY referrer_preferences__select__tenant ON reporting.referrer_preferences FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY referrer_preferences__insert__tenant ON reporting.referrer_preferences FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY referrer_preferences__update__tenant ON reporting.referrer_preferences FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
GRANT SELECT, INSERT, UPDATE ON reporting.referrer_preferences TO lims_app;
ALTER TABLE reporting.channel_accounts ENABLE ROW LEVEL SECURITY;  ALTER TABLE reporting.channel_accounts FORCE ROW LEVEL SECURITY;
CREATE POLICY channel_accounts__select__tenant ON reporting.channel_accounts FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY channel_accounts__insert__tenant ON reporting.channel_accounts FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY channel_accounts__update__tenant ON reporting.channel_accounts FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
GRANT SELECT, INSERT, UPDATE ON reporting.channel_accounts TO lims_app;
-- reporting.g_message_templates: class G, RLS-exempt (db/tests/rls_exempt.txt)
GRANT SELECT ON reporting.g_message_templates TO lims_app;
ALTER TABLE reporting.message_template_texts ENABLE ROW LEVEL SECURITY;  ALTER TABLE reporting.message_template_texts FORCE ROW LEVEL SECURITY;
CREATE POLICY message_template_texts__select__tenant ON reporting.message_template_texts FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY message_template_texts__insert__tenant ON reporting.message_template_texts FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY message_template_texts__update__tenant ON reporting.message_template_texts FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
GRANT SELECT, INSERT, UPDATE ON reporting.message_template_texts TO lims_app;
ALTER TABLE reporting.report_templates ENABLE ROW LEVEL SECURITY;  ALTER TABLE reporting.report_templates FORCE ROW LEVEL SECURITY;
CREATE POLICY report_templates__select__tenant ON reporting.report_templates FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY report_templates__insert__tenant ON reporting.report_templates FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY report_templates__update__tenant ON reporting.report_templates FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
GRANT SELECT, INSERT, UPDATE ON reporting.report_templates TO lims_app;
ALTER TABLE reporting.report_template_versions ENABLE ROW LEVEL SECURITY;  ALTER TABLE reporting.report_template_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY report_template_versions__select__tenant ON reporting.report_template_versions FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY report_template_versions__insert__tenant ON reporting.report_template_versions FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY report_template_versions__update__tenant ON reporting.report_template_versions FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
GRANT SELECT, INSERT, UPDATE ON reporting.report_template_versions TO lims_app;
ALTER TABLE reporting.narrative_templates ENABLE ROW LEVEL SECURITY;  ALTER TABLE reporting.narrative_templates FORCE ROW LEVEL SECURITY;
CREATE POLICY narrative_templates__select__tenant ON reporting.narrative_templates FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY narrative_templates__insert__tenant ON reporting.narrative_templates FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY narrative_templates__update__tenant ON reporting.narrative_templates FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
GRANT SELECT, INSERT, UPDATE ON reporting.narrative_templates TO lims_app;
-- reporting.g_cs_reasons: class G, RLS-exempt (db/tests/rls_exempt.txt)
GRANT SELECT ON reporting.g_cs_reasons TO lims_app;
ALTER TABLE reporting.cs_reasons ENABLE ROW LEVEL SECURITY;  ALTER TABLE reporting.cs_reasons FORCE ROW LEVEL SECURITY;
CREATE POLICY cs_reasons__select__tenant ON reporting.cs_reasons FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY cs_reasons__insert__tenant ON reporting.cs_reasons FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY cs_reasons__update__tenant ON reporting.cs_reasons FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
GRANT SELECT, INSERT, UPDATE ON reporting.cs_reasons TO lims_app;
ALTER TABLE reporting.reports ENABLE ROW LEVEL SECURITY;  ALTER TABLE reporting.reports FORCE ROW LEVEL SECURITY;
CREATE POLICY reports__select__tenant_centre ON reporting.reports FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY reports__insert__tenant_centre ON reporting.reports FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
              AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY reports__update__tenant_centre ON reporting.reports FOR UPDATE TO lims_app
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
              AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
              AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY reports__select__portal ON reporting.reports FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'portal'
         AND (SELECT app.current_claims() ->> 'portal_stage') = 'session'
         AND id = (SELECT nullif(app.current_claims() ->> 'portal_report_id', '')::uuid));
CREATE POLICY reports__select__partner ON reporting.reports FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner'
         AND partner_id = (SELECT app.current_partner_id())
         AND EXISTS (SELECT 1 FROM reporting.report_versions v WHERE v.tenant_id = reports.tenant_id
                     AND v.report_id = reports.id AND v.status IN ('released','superseded')));
CREATE POLICY reports__select__patient ON reporting.reports FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'patient'
         AND patient_id = ANY ((SELECT app.engagement_patient_ids())::uuid[])
         AND EXISTS (SELECT 1 FROM reporting.report_versions v WHERE v.tenant_id = reports.tenant_id
                     AND v.report_id = reports.id AND v.status IN ('released','superseded')));
GRANT SELECT, INSERT, UPDATE ON reporting.reports TO lims_app;
ALTER TABLE reporting.report_order_items ENABLE ROW LEVEL SECURITY;  ALTER TABLE reporting.report_order_items FORCE ROW LEVEL SECURITY;
CREATE POLICY report_order_items__select__tenant_centre ON reporting.report_order_items FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY report_order_items__insert__tenant_centre ON reporting.report_order_items FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY report_order_items__update__tenant_centre ON reporting.report_order_items FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
GRANT SELECT, INSERT, UPDATE ON reporting.report_order_items TO lims_app;
ALTER TABLE reporting.report_versions ENABLE ROW LEVEL SECURITY;  ALTER TABLE reporting.report_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY report_versions__select__portal ON reporting.report_versions FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'portal'
         AND (SELECT app.current_claims() ->> 'portal_stage') = 'session'
         AND (SELECT app.current_claims() ->> 'portal_link_purpose') = 'report'
         AND report_id = (SELECT nullif(app.current_claims() ->> 'portal_report_id', '')::uuid)
         AND status IN ('released','superseded'));
CREATE POLICY report_versions__select__partner ON reporting.report_versions FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner'
         AND status IN ('released','superseded')
         AND partner_id = (SELECT app.current_partner_id()));
CREATE POLICY report_versions__select__patient ON reporting.report_versions FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'patient'
         AND status IN ('released','superseded')
         AND patient_id = ANY ((SELECT app.engagement_patient_ids())::uuid[]));
CREATE POLICY report_versions__select__tenant_centre ON reporting.report_versions FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY report_versions__insert__tenant_centre ON reporting.report_versions FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY report_versions__update__tenant_centre ON reporting.report_versions FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
GRANT SELECT, INSERT, UPDATE ON reporting.report_versions TO lims_app;
ALTER TABLE reporting.qr_tokens ENABLE ROW LEVEL SECURITY;  ALTER TABLE reporting.qr_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY qr_tokens__select__portal ON reporting.qr_tokens FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'portal'
         AND (SELECT app.current_claims() ->> 'portal_stage') = 'session'
         AND (SELECT app.current_claims() ->> 'portal_link_purpose') = 'report'
         AND report_id = (SELECT nullif(app.current_claims() ->> 'portal_report_id', '')::uuid));
CREATE POLICY qr_tokens__select__partner ON reporting.qr_tokens FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner'
         AND report_version_id IN (SELECT v.id FROM reporting.report_versions v WHERE v.tenant_id = qr_tokens.tenant_id
                                   AND v.status IN ('released','superseded') AND v.partner_id = (SELECT app.current_partner_id())));
CREATE POLICY qr_tokens__select__patient ON reporting.qr_tokens FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'patient'
         AND report_version_id IN (SELECT v.id FROM reporting.report_versions v WHERE v.tenant_id = qr_tokens.tenant_id
                                   AND v.status IN ('released','superseded') AND v.patient_id = ANY ((SELECT app.engagement_patient_ids())::uuid[])));
CREATE POLICY qr_tokens__select__tenant_centre ON reporting.qr_tokens FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY qr_tokens__insert__tenant_centre ON reporting.qr_tokens FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY qr_tokens__update__tenant_centre ON reporting.qr_tokens FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
GRANT SELECT, INSERT, UPDATE ON reporting.qr_tokens TO lims_app;
ALTER TABLE reporting.deliveries ENABLE ROW LEVEL SECURITY;  ALTER TABLE reporting.deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY deliveries__select__tenant_centre ON reporting.deliveries FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR (centre_id IS NOT NULL AND centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]))));
CREATE POLICY deliveries__insert__tenant_centre ON reporting.deliveries FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR (centre_id IS NOT NULL AND centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]))));
CREATE POLICY deliveries__update__tenant_centre ON reporting.deliveries FOR UPDATE TO lims_app
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
              AND ((SELECT app.has_all_centres()) OR (centre_id IS NOT NULL AND centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]))))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
              AND ((SELECT app.has_all_centres()) OR (centre_id IS NOT NULL AND centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]))));
GRANT SELECT, INSERT, UPDATE ON reporting.deliveries TO lims_app;
ALTER TABLE reporting.portal_links ENABLE ROW LEVEL SECURITY;  ALTER TABLE reporting.portal_links FORCE ROW LEVEL SECURITY;
CREATE POLICY portal_links__select__portal ON reporting.portal_links FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'portal' AND id = (SELECT app.current_actor_id()));
CREATE POLICY portal_links__update__portal ON reporting.portal_links FOR UPDATE TO lims_app
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'portal' AND id = (SELECT app.current_actor_id()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'portal' AND id = (SELECT app.current_actor_id()));
CREATE POLICY portal_links__select__tenant_centre ON reporting.portal_links FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY portal_links__insert__tenant_centre ON reporting.portal_links FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY portal_links__update__tenant_centre ON reporting.portal_links FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
GRANT SELECT, INSERT, UPDATE ON reporting.portal_links TO lims_app;
ALTER TABLE reporting.otp_challenges ENABLE ROW LEVEL SECURITY;  ALTER TABLE reporting.otp_challenges FORCE ROW LEVEL SECURITY;
CREATE POLICY otp_challenges__select__portal ON reporting.otp_challenges FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'portal' AND link_id = (SELECT app.current_actor_id()));
CREATE POLICY otp_challenges__insert__portal ON reporting.otp_challenges FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'portal' AND link_id = (SELECT app.current_actor_id()));
CREATE POLICY otp_challenges__update__portal ON reporting.otp_challenges FOR UPDATE TO lims_app
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'portal' AND link_id = (SELECT app.current_actor_id()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'portal' AND link_id = (SELECT app.current_actor_id()));
CREATE POLICY otp_challenges__select__tenant_system ON reporting.otp_challenges FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY otp_challenges__update__tenant_system ON reporting.otp_challenges FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'system')
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY otp_challenges__delete__tenant_expired ON reporting.otp_challenges FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'system'
         AND expires_at < now() - interval '24 hours');
GRANT SELECT, INSERT, UPDATE, DELETE ON reporting.otp_challenges TO lims_app;
ALTER TABLE reporting.portal_sessions ENABLE ROW LEVEL SECURITY;  ALTER TABLE reporting.portal_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY portal_sessions__select__portal ON reporting.portal_sessions FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'portal' AND link_id = (SELECT app.current_actor_id()));
CREATE POLICY portal_sessions__insert__portal ON reporting.portal_sessions FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'portal' AND link_id = (SELECT app.current_actor_id()));
CREATE POLICY portal_sessions__update__portal ON reporting.portal_sessions FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'portal' AND link_id = (SELECT app.current_actor_id()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'portal' AND link_id = (SELECT app.current_actor_id()));
CREATE POLICY portal_sessions__select__tenant_system ON reporting.portal_sessions FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY portal_sessions__update__tenant_system ON reporting.portal_sessions FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'system')
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY portal_sessions__delete__tenant_expired ON reporting.portal_sessions FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'system' AND coalesce(ended_at, absolute_expires_at) < now() - interval '24 hours');
GRANT SELECT, INSERT, UPDATE, DELETE ON reporting.portal_sessions TO lims_app;
ALTER TABLE reporting.delivery_attempts ENABLE ROW LEVEL SECURITY;  ALTER TABLE reporting.delivery_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY delivery_attempts__select__tenant ON reporting.delivery_attempts FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY delivery_attempts__insert__tenant ON reporting.delivery_attempts FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
GRANT SELECT, INSERT ON reporting.delivery_attempts TO lims_app;
ALTER TABLE reporting.provider_events ENABLE ROW LEVEL SECURITY;  ALTER TABLE reporting.provider_events FORCE ROW LEVEL SECURITY;
CREATE POLICY provider_events__select__tenant ON reporting.provider_events FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY provider_events__insert__tenant ON reporting.provider_events FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY provider_events__update__tenant ON reporting.provider_events FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
GRANT SELECT, INSERT, UPDATE ON reporting.provider_events TO lims_app;
ALTER TABLE reporting.narrative_reports ENABLE ROW LEVEL SECURITY;  ALTER TABLE reporting.narrative_reports FORCE ROW LEVEL SECURITY;
CREATE POLICY narrative_reports__select__tenant_centre ON reporting.narrative_reports FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY narrative_reports__insert__tenant_centre ON reporting.narrative_reports FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY narrative_reports__update__tenant_centre ON reporting.narrative_reports FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
GRANT SELECT, INSERT, UPDATE ON reporting.narrative_reports TO lims_app;
ALTER TABLE reporting.input_files ENABLE ROW LEVEL SECURITY;  ALTER TABLE reporting.input_files FORCE ROW LEVEL SECURITY;
CREATE POLICY input_files__select__tenant_centre ON reporting.input_files FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY input_files__insert__tenant_centre ON reporting.input_files FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY input_files__update__tenant_centre ON reporting.input_files FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
GRANT SELECT, INSERT, UPDATE ON reporting.input_files TO lims_app;
ALTER TABLE reporting.narrative_versions ENABLE ROW LEVEL SECURITY;  ALTER TABLE reporting.narrative_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY narrative_versions__select__tenant_centre ON reporting.narrative_versions FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY narrative_versions__insert__tenant_centre ON reporting.narrative_versions FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY narrative_versions__update__tenant_centre ON reporting.narrative_versions FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
GRANT SELECT, INSERT, UPDATE ON reporting.narrative_versions TO lims_app;
ALTER TABLE reporting.print_jobs ENABLE ROW LEVEL SECURITY;  ALTER TABLE reporting.print_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY print_jobs__select__tenant_centre ON reporting.print_jobs FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY print_jobs__insert__tenant_centre ON reporting.print_jobs FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY print_jobs__update__tenant_centre ON reporting.print_jobs FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY print_jobs__delete__tenant_expired ON reporting.print_jobs FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'system' AND expires_at < now());
GRANT SELECT, INSERT, UPDATE, DELETE ON reporting.print_jobs TO lims_app;
ALTER TABLE reporting.portal_payment_requests ENABLE ROW LEVEL SECURITY;  ALTER TABLE reporting.portal_payment_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY portal_payment_requests__select__portal ON reporting.portal_payment_requests FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'portal'
         AND (SELECT app.current_claims() ->> 'portal_stage') = 'session' AND link_id = (SELECT app.current_actor_id()));
CREATE POLICY portal_payment_requests__insert__portal ON reporting.portal_payment_requests FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'portal'
              AND (SELECT app.current_claims() ->> 'portal_stage') = 'session' AND link_id = (SELECT app.current_actor_id())
              AND report_id = (SELECT nullif(app.current_claims() ->> 'portal_report_id', '')::uuid)
              AND EXISTS (SELECT 1 FROM reporting.reports r WHERE r.tenant_id = portal_payment_requests.tenant_id
                          AND r.id = portal_payment_requests.report_id AND r.order_id = portal_payment_requests.order_id));
CREATE POLICY portal_payment_requests__select__tenant_system ON reporting.portal_payment_requests FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY portal_payment_requests__update__tenant_system ON reporting.portal_payment_requests FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'system')
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY portal_payment_requests__delete__tenant_expired ON reporting.portal_payment_requests FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'system' AND expires_at < now());
GRANT SELECT, INSERT, UPDATE, DELETE ON reporting.portal_payment_requests TO lims_app;

-- ---------- Row audit (§1): every class M and C table; portal_links has the two §6 conditional triggers ----------
CREATE TRIGGER settings__audit AFTER INSERT OR UPDATE OR DELETE ON reporting.settings FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER staff_assignments__audit AFTER INSERT OR UPDATE OR DELETE ON reporting.staff_assignments FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER centre_contacts__audit AFTER INSERT OR UPDATE OR DELETE ON reporting.centre_contacts FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER referrer_preferences__audit AFTER INSERT OR UPDATE OR DELETE ON reporting.referrer_preferences FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER channel_accounts__audit AFTER INSERT OR UPDATE OR DELETE ON reporting.channel_accounts FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER message_template_texts__audit AFTER INSERT OR UPDATE OR DELETE ON reporting.message_template_texts FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER report_templates__audit AFTER INSERT OR UPDATE OR DELETE ON reporting.report_templates FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER report_template_versions__audit AFTER INSERT OR UPDATE OR DELETE ON reporting.report_template_versions FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER narrative_templates__audit AFTER INSERT OR UPDATE OR DELETE ON reporting.narrative_templates FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER cs_reasons__audit AFTER INSERT OR UPDATE OR DELETE ON reporting.cs_reasons FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER reports__audit AFTER INSERT OR UPDATE OR DELETE ON reporting.reports FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER report_order_items__audit AFTER INSERT OR UPDATE OR DELETE ON reporting.report_order_items FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER report_versions__audit AFTER INSERT OR UPDATE OR DELETE ON reporting.report_versions FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER qr_tokens__audit AFTER INSERT OR UPDATE OR DELETE ON reporting.qr_tokens FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER deliveries__audit AFTER INSERT OR UPDATE OR DELETE ON reporting.deliveries FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER input_files__audit AFTER INSERT OR UPDATE OR DELETE ON reporting.input_files FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER narrative_reports__audit AFTER INSERT OR UPDATE OR DELETE ON reporting.narrative_reports FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER narrative_versions__audit AFTER INSERT OR UPDATE OR DELETE ON reporting.narrative_versions FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();

-- =====================================================================
-- §6.2 lookup role grants, policies and DEFINER functions (verbatim; D-201 window)
-- =====================================================================
-- Role lims_reporting_lookup is created by C0 (db/bootstrap/00_roles.sql, C0 05-SCHEMA §1: NOLOGIN, NOBYPASSRLS, SET-only member of
-- lims_migrator; USAGE on app granted there). This migration runs as lims_owner (SET LOCAL ROLE lims_owner, C0 rule).
GRANT USAGE ON SCHEMA reporting TO lims_reporting_lookup;
GRANT SELECT ON reporting.qr_tokens, reporting.report_versions, reporting.portal_links, reporting.portal_sessions,
                reporting.channel_accounts, reporting.reports, reporting.deliveries TO lims_reporting_lookup;   -- reports, deliveries: D-30
GRANT SELECT, INSERT ON reporting.provider_events TO lims_reporting_lookup;   -- SELECT: needed by INSERT … ON CONFLICT (second fix pass)
GRANT UPDATE (redeem_failures, updated_at, version) ON reporting.portal_links TO lims_reporting_lookup;          -- D-30 counter only

-- 08 A21.4 (A12.1 generalised): every C6 pre-tenant DEFINER uses its own app.pre_* GUC [CONV names], set inside the body
-- with set_config(…, true) and reset to '' before every return. The former shared lookup GUC names are retired.
CREATE POLICY qr_tokens__select__lookup ON reporting.qr_tokens FOR SELECT TO lims_reporting_lookup
  USING (token_sha256 = decode(nullif(current_setting('app.pre_qr_token_sha256', true), ''), 'hex'));
CREATE POLICY report_versions__select__lookup ON reporting.report_versions FOR SELECT TO lims_reporting_lookup
  USING (id IN (SELECT q.report_version_id FROM reporting.qr_tokens q
                WHERE q.token_sha256 = decode(nullif(current_setting('app.pre_qr_token_sha256', true), ''), 'hex')));
CREATE POLICY portal_links__select__lookup ON reporting.portal_links FOR SELECT TO lims_reporting_lookup
  USING (token_sha256 = decode(nullif(current_setting('app.pre_portal_credential_sha256', true), ''), 'hex'));
-- D-30 (08 A13; A10.5 owner-policy rule, owner = lims_reporting_lookup): the redeem DEFINER's narrowest read/update paths,
-- named __owner_only as in 03-IC §13.3 / 08 A13 D-30, bound to app.pre_portal_token_sha256 set inside the function.
CREATE POLICY portal_links__select__owner_only ON reporting.portal_links FOR SELECT TO lims_reporting_lookup
  USING (token_sha256 = decode(nullif(current_setting('app.pre_portal_token_sha256', true), ''), 'hex'));
CREATE POLICY portal_links__update__owner_only ON reporting.portal_links FOR UPDATE TO lims_reporting_lookup
  USING      (token_sha256 = decode(nullif(current_setting('app.pre_portal_token_sha256', true), ''), 'hex'))
  WITH CHECK (token_sha256 = decode(nullif(current_setting('app.pre_portal_token_sha256', true), ''), 'hex'));
-- The function body also reads the link's report, its released version and the link's delivery (destination fallback),
-- so three more owner_only SELECT policies are needed beyond the two named in 03-IC §13.3 (handed off to 03-IC):
CREATE POLICY reports__select__owner_only ON reporting.reports FOR SELECT TO lims_reporting_lookup
  USING (id IN (SELECT l.report_id FROM reporting.portal_links l
                WHERE l.token_sha256 = decode(nullif(current_setting('app.pre_portal_token_sha256', true), ''), 'hex')));
CREATE POLICY report_versions__select__owner_only ON reporting.report_versions FOR SELECT TO lims_reporting_lookup
  USING (report_id IN (SELECT l.report_id FROM reporting.portal_links l
                WHERE l.token_sha256 = decode(nullif(current_setting('app.pre_portal_token_sha256', true), ''), 'hex')));
CREATE POLICY deliveries__select__owner_only ON reporting.deliveries FOR SELECT TO lims_reporting_lookup
  USING (id IN (SELECT l.delivery_id FROM reporting.portal_links l
                WHERE l.token_sha256 = decode(nullif(current_setting('app.pre_portal_token_sha256', true), ''), 'hex')));
CREATE POLICY portal_sessions__select__lookup ON reporting.portal_sessions FOR SELECT TO lims_reporting_lookup
  USING (token_sha256 = decode(nullif(current_setting('app.pre_portal_credential_sha256', true), ''), 'hex'));
CREATE POLICY channel_accounts__select__lookup ON reporting.channel_accounts FOR SELECT TO lims_reporting_lookup
  USING (callback_token_sha256 = decode(nullif(current_setting('app.pre_callback_token_sha256', true), ''), 'hex'));
CREATE POLICY provider_events__insert__lookup ON reporting.provider_events FOR INSERT TO lims_reporting_lookup
  WITH CHECK (tenant_id = nullif(current_setting('app.pre_callback_tenant_id', true), '')::uuid
              AND channel_account_id = nullif(current_setting('app.pre_callback_channel_account_id', true), '')::uuid);
-- INSERT … ON CONFLICT DO NOTHING under FORCE RLS also needs SELECT privilege and a SELECT policy on the target: without them
-- the ingest function fails ("permission denied" / "violates row-level security policy") — found on scratch PG 16.
CREATE POLICY provider_events__select__lookup ON reporting.provider_events FOR SELECT TO lims_reporting_lookup
  USING (tenant_id = nullif(current_setting('app.pre_callback_tenant_id', true), '')::uuid
         AND channel_account_id = nullif(current_setting('app.pre_callback_channel_account_id', true), '')::uuid);

-- 08 A25 D-201: no standing CREATE. This migration file is the only window in which lims_reporting_lookup holds CREATE on schema
-- app (same pattern as C0 05-SCHEMA §10 "queue wrapper"): as lims_owner grant → SET LOCAL ROLE lims_reporting_lookup → create the
-- four DEFINERs → back to lims_owner → revoke, all in this one file. The role creates no schema, so it gets no CREATE on the database.
-- (PostgreSQL also needs CREATE on the schema for ALTER … OWNER TO, so "create as lims_owner, then ALTER OWNER" would not avoid it.)
GRANT CREATE ON SCHEMA app TO lims_reporting_lookup;
RESET ROLE;  SET LOCAL ROLE lims_reporting_lookup;          -- lims_migrator holds SET on this role (C0 05-SCHEMA §1)

CREATE FUNCTION app.reporting_verify_qr(p_token_sha256 bytea)
RETURNS TABLE (lab_name text, patient_display text, panel_names text[], issued_at timestamptz, version_no integer, status text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF p_token_sha256 IS NULL OR octet_length(p_token_sha256) <> 32 THEN RETURN; END IF;
  PERFORM set_config('app.pre_qr_token_sha256', encode(p_token_sha256, 'hex'), true);
  RETURN QUERY
    SELECT q.lab_name_snapshot, q.patient_display_snapshot, q.panel_names_snapshot, v.released_at, v.version_no,
           CASE v.status WHEN 'released' THEN 'valid' ELSE 'superseded' END
    FROM reporting.qr_tokens q
    JOIN reporting.report_versions v ON v.tenant_id = q.tenant_id AND v.id = q.report_version_id
    WHERE q.token_sha256 = p_token_sha256 AND q.revoked_at IS NULL AND v.status IN ('released','superseded');
  PERFORM set_config('app.pre_qr_token_sha256', '', true);              -- A21.4: reset before return
  RETURN;
END $$;
ALTER FUNCTION app.reporting_verify_qr(bytea) OWNER TO lims_reporting_lookup;
REVOKE ALL ON FUNCTION app.reporting_verify_qr(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reporting_verify_qr(bytea) TO lims_api;

CREATE FUNCTION app.reporting_resolve_portal_credential(p_kind text, p_token_sha256 bytea)
RETURNS TABLE (tenant_id uuid, link_id uuid, report_id uuid, stage text, session_id uuid, purpose text)   -- purpose: 08 A21.1
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF p_token_sha256 IS NULL OR octet_length(p_token_sha256) <> 32 OR p_kind NOT IN ('link','session') THEN RETURN; END IF;
  PERFORM set_config('app.pre_portal_credential_sha256', encode(p_token_sha256, 'hex'), true);
  IF p_kind = 'link' THEN
    RETURN QUERY SELECT l.tenant_id, l.id, l.report_id,
      CASE WHEN l.expires_at > now() THEN 'link' ELSE 'expired_link' END, NULL::uuid, l.purpose
      FROM reporting.portal_links l WHERE l.token_sha256 = p_token_sha256 AND l.revoked_at IS NULL;
  ELSE
    RETURN QUERY SELECT s.tenant_id, s.link_id, s.report_id, 'session'::text, s.id, s.link_purpose
      FROM reporting.portal_sessions s
      WHERE s.token_sha256 = p_token_sha256 AND s.ended_at IS NULL
        AND s.idle_expires_at > now() AND s.absolute_expires_at > now();
  END IF;
  PERFORM set_config('app.pre_portal_credential_sha256', '', true);     -- A21.4: reset before return
  RETURN;
END $$;
-- session rows of revoked links: the API checks the link (portal_links__select__portal) after resolution and ends the session.
ALTER FUNCTION app.reporting_resolve_portal_credential(text, bytea) OWNER TO lims_reporting_lookup;
REVOKE ALL ON FUNCTION app.reporting_resolve_portal_credential(text, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reporting_resolve_portal_credential(text, bytea) TO lims_api;

CREATE FUNCTION app.reporting_ingest_provider_callback(p_provider_kind text, p_token_sha256 bytea, p_events jsonb)   -- 08 §4.7 signature
RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_tenant uuid; v_account uuid; e jsonb;
BEGIN
  IF p_token_sha256 IS NULL OR octet_length(p_token_sha256) <> 32 OR jsonb_typeof(p_events) <> 'array' OR jsonb_array_length(p_events) > 100 THEN RETURN NULL; END IF;
  PERFORM set_config('app.pre_callback_token_sha256', encode(p_token_sha256, 'hex'), true);
  SELECT a.tenant_id, a.id INTO v_tenant, v_account FROM reporting.channel_accounts a
   WHERE a.callback_token_sha256 = p_token_sha256 AND a.is_active AND a.provider_kind = p_provider_kind;
  IF v_tenant IS NULL THEN
    PERFORM set_config('app.pre_callback_token_sha256', '', true);
    RETURN NULL;
  END IF;
  PERFORM set_config('app.pre_callback_tenant_id', v_tenant::text, true);
  PERFORM set_config('app.pre_callback_channel_account_id', v_account::text, true);
  FOR e IN SELECT * FROM jsonb_array_elements(p_events) LOOP
    INSERT INTO reporting.provider_events (id, tenant_id, channel_account_id, provider_kind, provider_message_id, status_raw,
                                           mapped_status, occurred_at, created_by)
    VALUES ((e->>'id')::uuid, v_tenant, v_account, p_provider_kind, left(e->>'provider_message_id', 128), left(e->>'status_raw', 64),
            e->>'mapped_status', (e->>'occurred_at')::timestamptz, v_account)
    ON CONFLICT ON CONSTRAINT provider_events__dedupe__uq DO NOTHING;
  END LOOP;
  PERFORM set_config('app.pre_callback_token_sha256', '', true);        -- A21.4: reset all three before return
  PERFORM set_config('app.pre_callback_tenant_id', '', true);
  PERFORM set_config('app.pre_callback_channel_account_id', '', true);
  RETURN v_tenant;   -- LD-49 (b) / LD-77: no enqueue here; the API handler enqueues inside withTenantScope(v_tenant, reporting system actor)
END $$;
-- 'id' values are UUIDv7 generated by the API handler (04 D9: app-generated ids).
ALTER FUNCTION app.reporting_ingest_provider_callback(text, bytea, jsonb) OWNER TO lims_reporting_lookup;
REVOKE ALL ON FUNCTION app.reporting_ingest_provider_callback(text, bytea, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reporting_ingest_provider_callback(text, bytea, jsonb) TO lims_api;

-- 08 A13 D-30: ReportingPort.redeemPortalLinkForApp (patient actor via C16). Inventory row: 03-IC §13.3 / 08 §4.7.
CREATE FUNCTION app.reporting_redeem_link_for_app(p_token_sha256 bytea, p_phone_sha256 bytea)
RETURNS TABLE (tenant_id uuid, patient_id uuid, report_id uuid, version_no integer, released_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_link reporting.portal_links%ROWTYPE; v_dest bytea;
BEGIN
  IF p_token_sha256 IS NULL OR octet_length(p_token_sha256) <> 32
     OR p_phone_sha256 IS NULL OR octet_length(p_phone_sha256) <> 32 THEN RETURN; END IF;
  PERFORM set_config('app.pre_portal_token_sha256', encode(p_token_sha256, 'hex'), true);
  SELECT l.* INTO v_link FROM reporting.portal_links l
   WHERE l.token_sha256 = p_token_sha256 AND l.revoked_at IS NULL AND l.expires_at > now()
     AND l.recipient_kind = 'patient' AND l.channel IN ('sms','whatsapp') AND l.purpose = 'report'   -- A21.1
   FOR UPDATE;
  IF NOT FOUND OR v_link.redeem_failures >= 5 THEN                      -- invalid / wrong kind / locked: no counter change
    PERFORM set_config('app.pre_portal_token_sha256', '', true);
    RETURN;
  END IF;
  IF v_link.destination_sha256 IS NULL AND v_link.delivery_id IS NOT NULL THEN
    SELECT d.destination_sha256 INTO v_dest FROM reporting.deliveries d
     WHERE d.tenant_id = v_link.tenant_id AND d.id = v_link.delivery_id;
  END IF;
  IF coalesce(v_link.destination_sha256, v_dest) IS DISTINCT FROM p_phone_sha256 THEN   -- bytea = bytea (A5.5)
    UPDATE reporting.portal_links pl SET redeem_failures = pl.redeem_failures + 1, updated_at = now(), version = pl.version + 1
     WHERE pl.tenant_id = v_link.tenant_id AND pl.id = v_link.id;
    PERFORM set_config('app.pre_portal_token_sha256', '', true);
    RETURN;
  END IF;
  RETURN QUERY
    SELECT r.tenant_id, r.patient_id, r.id, v.version_no, v.released_at
      FROM reporting.reports r
      JOIN reporting.report_versions v ON v.tenant_id = r.tenant_id AND v.report_id = r.id AND v.status = 'released'
     WHERE r.tenant_id = v_link.tenant_id AND r.id = v_link.report_id;
  PERFORM set_config('app.pre_portal_token_sha256', '', true);           -- A12.1: GUC empty on return
  RETURN;
END $$;
ALTER FUNCTION app.reporting_redeem_link_for_app(bytea, bytea) OWNER TO lims_reporting_lookup;
REVOKE ALL ON FUNCTION app.reporting_redeem_link_for_app(bytea, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reporting_redeem_link_for_app(bytea, bytea) TO lims_api;
RESET ROLE;  SET LOCAL ROLE lims_owner;
REVOKE CREATE ON SCHEMA app FROM lims_reporting_lookup;                                  -- D-201: close the window
-- Role test (C0 05-SCHEMA §10 test 30, D-201): after this migration has_schema_privilege('lims_reporting_lookup','app','CREATE') = false
-- and has_database_privilege('lims_reporting_lookup', current_database(), 'CREATE') = false; the four functions are owned by it.
-- Never consumes, extends or reveals the link: the only write is redeem_failures (+ updated_at, version), allowed by the
-- column grant, portal_links__update__owner_only and tg_portal_links_guard; that update is not row-audited (§1 note).
-- The caller (ReportingPort impl, patient actor) passes sha256(token) and sha256(phoneE164) and requires the returned
-- tenant_id = ctx.tenantId; no row → reporting.link_invalid (identical for every failure).

-- =====================================================================
-- §7 published views (03-IC §6.4)
-- =====================================================================
CREATE VIEW reporting.v_pub_report_release WITH (security_invoker = true) AS
SELECT v.tenant_id, v.report_id, v.version_no, v.order_id, v.centre_id, v.report_kind,
       v.released_at, v.release_basis, v.superseded_at
FROM reporting.report_versions v
WHERE v.status IN ('released','superseded');
-- report_kind may be 'addendum' (08 R1, 03-IC §6.4 note); consumers tolerate new values.

CREATE VIEW reporting.v_pub_order_report_tat WITH (security_invoker = true) AS
SELECT r.tenant_id, r.order_id, r.centre_id, min(r.registered_at) AS registered_at,
       min(r.first_released_at) AS first_released_at, max(r.final_released_at) AS final_released_at,
       CASE WHEN bool_and(r.final_released_at IS NOT NULL)
            THEN extract(epoch FROM (max(r.final_released_at) - min(r.registered_at)))::bigint END AS total_tat_seconds
FROM reporting.reports r
WHERE r.state = 'open'
GROUP BY r.tenant_id, r.order_id, r.centre_id;
-- final_released_at = first release of a version with completeness 'complete' (set by release.service).
-- An order with two families counts as finally released when both are (bool_and).

-- CR-C8-005 (08 §4.9) + 08 A17 D-48: every count anchors on the delivery's creation date (cohort); centre_id NULL for
-- non-report deliveries (CR-C8-005). Each status column counts the deliveries of that creation-day cohort whose status
-- timestamp is set (queued_at, sent_at, delivered_at, read_at, failed_at, suppressed_at — the same per-delivery test as
-- before D-48); a delivery created on day 1 and delivered on day 2 counts as sent and delivered on day 1, and the day-1
-- row changes when the later status arrives (C8 re-reads it: 02-TRD §8.1 `delivery_created_at`). This replaces the
-- per-status anchors of review fix #9. Column order = 03-IC §6.4 (centre_id appended); grouped by tenant_id,
-- business_date, channel, purpose, recipient_kind and centre_id (D-48 "group by it"; written as expressions because
-- centre_id is the last column, not the 6th).
CREATE VIEW reporting.v_pub_delivery_daily WITH (security_invoker = true) AS
SELECT d.tenant_id, (d.created_at AT TIME ZONE 'Asia/Kathmandu')::date AS business_date,
       d.channel, d.purpose, d.recipient_kind,
       count(*) FILTER (WHERE d.queued_at     IS NOT NULL) AS queued,
       count(*) FILTER (WHERE d.sent_at       IS NOT NULL) AS sent,
       count(*) FILTER (WHERE d.delivered_at  IS NOT NULL) AS delivered,
       count(*) FILTER (WHERE d.read_at       IS NOT NULL) AS read,
       count(*) FILTER (WHERE d.failed_at     IS NOT NULL) AS failed,
       count(*) FILTER (WHERE d.suppressed_at IS NOT NULL) AS suppressed,
       d.centre_id
FROM reporting.deliveries d
GROUP BY d.tenant_id, (d.created_at AT TIME ZONE 'Asia/Kathmandu')::date, d.channel, d.purpose, d.recipient_kind, d.centre_id;
-- 08 A13 P-15: in v1 TenantSettings.timezone accepts only Asia/Kathmandu, so every v_pub_* view uses that literal; a
-- per-tenant timezone needs a CR that adds stored business_date columns (08 §4.9 fallback).

GRANT SELECT ON reporting.v_pub_report_release, reporting.v_pub_order_report_tat, reporting.v_pub_delivery_daily TO lims_app, lims_analytics;
