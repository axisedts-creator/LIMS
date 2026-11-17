-- T0B-10.C7: instruments schema — C7 05-SCHEMA §7 DDL verbatim (tables, indexes, the three spec mutable_columns triggers, g_* seeds),
-- then the §4 complement mutable-column lists for agents / instruments, the five 03-APP-FLOW §2 transition triggers, row-audit
-- triggers on the six audited tables (§1; agent_credentials excludes secret_sha256, §4), §5 RLS (ENABLE + FORCE on the 17 tenant
-- tables, the centre template written out per table, the settings block and the owner_only policies + DEFINERs verbatim), §5 grants
-- and the §6 v_pub_* views. Policies are copied 1:1 to db/policies/instruments.sql (AC-0B-2.3). The C0 inbox table of this schema
-- belongs to T0B-05. Schema instruments exists since T0B-01. Single role switch: lims_owner (no lookup role in C7).
SET LOCAL ROLE lims_owner;

-- ===== global reference
CREATE TABLE instruments.g_drivers (
  code text NOT NULL, display_name text NOT NULL, protocol text NOT NULL, vendor text, model_pattern text,
  status text NOT NULL, driver_version text NOT NULL,
  cap_host_query boolean NOT NULL DEFAULT false, cap_worklist_download boolean NOT NULL DEFAULT false,
  cap_qc boolean NOT NULL DEFAULT false, cap_attachments boolean NOT NULL DEFAULT false,
  cap_calibration boolean NOT NULL DEFAULT false,
  manual_title text, manual_document_id text, manual_revision text, manual_software_version text,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT g_drivers__pk PRIMARY KEY (code),
  CONSTRAINT g_drivers__code__ck CHECK (code ~ '^[a-z0-9_]{3,64}$'),
  CONSTRAINT g_drivers__protocol__ck CHECK (protocol IN ('astm','hl7v2','file_drop')),
  CONSTRAINT g_drivers__status__ck CHECK (status IN ('generic','verified','sketch_blocked')),
  CONSTRAINT g_drivers__verified_manual__ck CHECK (status <> 'verified' OR manual_document_id IS NOT NULL),
  CONSTRAINT g_drivers__calibration__ck CHECK (cap_calibration = false OR status = 'verified'),
  CONSTRAINT g_drivers__text__ck CHECK (char_length(display_name) BETWEEN 1 AND 80 AND char_length(driver_version) <= 32
    AND coalesce(char_length(vendor),0) <= 60 AND coalesce(char_length(model_pattern),0) <= 120
    AND coalesce(char_length(manual_title),0) <= 200 AND coalesce(char_length(manual_document_id),0) <= 100
    AND coalesce(char_length(manual_revision),0) <= 40 AND coalesce(char_length(manual_software_version),0) <= 40)
);
CREATE TABLE instruments.g_agent_releases (
  id uuid NOT NULL, version text NOT NULL, channel text NOT NULL, package_file_name text NOT NULL,
  package_sha256 text NOT NULL, package_size bigint NOT NULL, signature text NOT NULL, key_id text NOT NULL,
  authenticode_publisher text NOT NULL, min_windows_build integer, released_at timestamptz NOT NULL,
  is_active boolean NOT NULL DEFAULT true, notes text, created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT g_agent_releases__pk PRIMARY KEY (id),
  CONSTRAINT g_agent_releases__version__uq UNIQUE (version),
  CONSTRAINT g_agent_releases__version__ck CHECK (version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
  CONSTRAINT g_agent_releases__channel__ck CHECK (channel IN ('stable','beta')),
  CONSTRAINT g_agent_releases__sha__ck CHECK (package_sha256 ~ '^[0-9a-f]{64}$' AND package_size > 0),
  CONSTRAINT g_agent_releases__text__ck CHECK (char_length(package_file_name) <= 120 AND char_length(key_id) <= 32
    AND char_length(authenticode_publisher) <= 200 AND coalesce(char_length(notes),0) <= 2000)
);
CREATE TABLE instruments.g_cs_revoke_reasons (
  code text NOT NULL, display text NOT NULL, system text NOT NULL DEFAULT 'lims', system_version text NOT NULL DEFAULT '1',
  sort_order integer NOT NULL DEFAULT 0, is_active boolean NOT NULL DEFAULT true,
  CONSTRAINT g_cs_revoke_reasons__pk PRIMARY KEY (code));
CREATE TABLE instruments.g_cs_reprocess_reasons (
  code text NOT NULL, display text NOT NULL, system text NOT NULL DEFAULT 'lims', system_version text NOT NULL DEFAULT '1',
  sort_order integer NOT NULL DEFAULT 0, is_active boolean NOT NULL DEFAULT true,
  CONSTRAINT g_cs_reprocess_reasons__pk PRIMARY KEY (code));

-- ===== settings
CREATE TABLE instruments.settings (
  id uuid NOT NULL, tenant_id uuid NOT NULL,
  -- no archive_retention_days: raw retention = TenantSettings.retention.rawInstrumentYears (08 A13 D-42)
  default_backlog_threshold integer NOT NULL DEFAULT 500,
  backlog_max_oldest_pending_seconds integer NOT NULL DEFAULT 900,
  clock_offset_warn_seconds integer NOT NULL DEFAULT 300,
  agent_uploaded_retention_hours integer NOT NULL DEFAULT 24,
  update_window_from time, update_window_to time,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT settings__pk PRIMARY KEY (id),
  CONSTRAINT settings__tenant__uq UNIQUE (tenant_id),
  CONSTRAINT settings__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT settings__ranges__ck CHECK (default_backlog_threshold BETWEEN 10 AND 100000 AND backlog_max_oldest_pending_seconds BETWEEN 60 AND 86400
    AND clock_offset_warn_seconds BETWEEN 30 AND 3600 AND agent_uploaded_retention_hours BETWEEN 1 AND 72),
  CONSTRAINT settings__window__ck CHECK ((update_window_from IS NULL) = (update_window_to IS NULL))
);

-- ===== agents
CREATE TABLE instruments.agents (
  id uuid NOT NULL, tenant_id uuid NOT NULL, centre_id uuid NOT NULL,
  agent_code text NOT NULL, display_name text NOT NULL,
  status text NOT NULL DEFAULT 'pending_enrolment', update_channel text NOT NULL DEFAULT 'stable',
  pinned_release_id uuid, backlog_threshold integer,
  enrolled_at timestamptz, host_fingerprint_sha256 text,
  revoked_at timestamptz, revoked_by uuid, revoke_reason_code text, revoke_reason_text text,
  retired_at timestamptz, retired_by uuid,
  latest_config_version integer NOT NULL DEFAULT 1,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT agents__pk PRIMARY KEY (id),
  CONSTRAINT agents__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT agents__tenant_id_id_centre_id__uq UNIQUE (tenant_id, id, centre_id),
  CONSTRAINT agents__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT agents__centre__fk FOREIGN KEY (tenant_id, centre_id) REFERENCES core.collection_centres (tenant_id, id),
  CONSTRAINT agents__release__fk FOREIGN KEY (pinned_release_id) REFERENCES instruments.g_agent_releases (id),
  CONSTRAINT agents__revoke_reason__fk FOREIGN KEY (revoke_reason_code) REFERENCES instruments.g_cs_revoke_reasons (code),
  CONSTRAINT agents__code__ck CHECK (agent_code ~ '^[A-Z0-9-]{2,32}$'),
  CONSTRAINT agents__name__ck CHECK (char_length(display_name) BETWEEN 1 AND 80 AND coalesce(char_length(revoke_reason_text),0) <= 300),
  CONSTRAINT agents__status__ck CHECK (status IN ('pending_enrolment','active','revoked','retired')),
  CONSTRAINT agents__channel__ck CHECK (update_channel IN ('stable','beta')),
  CONSTRAINT agents__backlog__ck CHECK (backlog_threshold IS NULL OR backlog_threshold BETWEEN 10 AND 100000),
  CONSTRAINT agents__fingerprint__ck CHECK (host_fingerprint_sha256 IS NULL OR host_fingerprint_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT agents__config_version__ck CHECK (latest_config_version >= 1)
);
CREATE UNIQUE INDEX agents__tenant_id_agent_code__uq ON instruments.agents (tenant_id, agent_code);
CREATE INDEX agents__tenant_id_centre_id_status__idx ON instruments.agents (tenant_id, centre_id, status);

CREATE TABLE instruments.agent_credentials (
  id uuid NOT NULL, tenant_id uuid NOT NULL, centre_id uuid NOT NULL, agent_id uuid NOT NULL,
  kind text NOT NULL, secret_sha256 bytea NOT NULL, status text NOT NULL DEFAULT 'active',
  issued_at timestamptz NOT NULL DEFAULT now(), issued_by uuid NOT NULL, expires_at timestamptz,
  used_at timestamptz, last_used_at timestamptz,
  revoked_at timestamptz, revoked_by uuid, revoke_reason_code text, replaced_by_credential_id uuid,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT agent_credentials__pk PRIMARY KEY (id),
  CONSTRAINT agent_credentials__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT agent_credentials__agent__fk FOREIGN KEY (tenant_id, agent_id, centre_id) REFERENCES instruments.agents (tenant_id, id, centre_id),
  CONSTRAINT agent_credentials__replaced__fk FOREIGN KEY (tenant_id, replaced_by_credential_id) REFERENCES instruments.agent_credentials (tenant_id, id),
  CONSTRAINT agent_credentials__reason__fk FOREIGN KEY (revoke_reason_code) REFERENCES instruments.g_cs_revoke_reasons (code),
  CONSTRAINT agent_credentials__kind__ck CHECK (kind IN ('enrolment_code','device_token')),
  CONSTRAINT agent_credentials__status__ck CHECK (status IN ('active','used','expired','revoked')),
  CONSTRAINT agent_credentials__secret__ck CHECK (octet_length(secret_sha256) = 32),
  CONSTRAINT agent_credentials__expiry__ck CHECK (kind <> 'enrolment_code' OR expires_at IS NOT NULL),
  CONSTRAINT agent_credentials__used__ck CHECK (status <> 'used' OR (kind = 'enrolment_code' AND used_at IS NOT NULL))
);
CREATE UNIQUE INDEX agent_credentials__secret_sha256__uq ON instruments.agent_credentials (secret_sha256);  -- non-tenant-leading: §3 reason
CREATE INDEX agent_credentials__tenant_id_agent_id_status__idx ON instruments.agent_credentials (tenant_id, agent_id, status);
CREATE INDEX agent_credentials__active_code__p_idx ON instruments.agent_credentials (tenant_id, agent_id)
  WHERE kind = 'enrolment_code' AND status = 'active';

CREATE TABLE instruments.agent_status (
  tenant_id uuid NOT NULL, agent_id uuid NOT NULL, centre_id uuid NOT NULL,
  health_state text NOT NULL DEFAULT 'offline', health_version integer NOT NULL DEFAULT 1,
  state_changed_at timestamptz NOT NULL DEFAULT now(), silent_instrument_ids uuid[] NOT NULL DEFAULT '{}',
  last_heartbeat_at timestamptz, agent_version text, launcher_version text, os_version text,
  queue_depth integer NOT NULL DEFAULT 0, oldest_pending_age_seconds integer NOT NULL DEFAULT 0,
  queue_rejected integer NOT NULL DEFAULT 0, queue_oversize integer NOT NULL DEFAULT 0,
  disk_free_mb integer, clock_offset_ms integer, clock_offset_uncertainty_ms integer,
  config_version_applied integer, config_state text, update_state text, update_target_version text, update_error_code text,
  auth_state text, last_ip inet, last_ip_changed_at timestamptz, counters jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT agent_status__pk PRIMARY KEY (tenant_id, agent_id),
  CONSTRAINT agent_status__agent__fk FOREIGN KEY (tenant_id, agent_id, centre_id) REFERENCES instruments.agents (tenant_id, id, centre_id),
  CONSTRAINT agent_status__health__ck CHECK (health_state IN ('online','offline','backlog','degraded') AND health_version >= 1),
  CONSTRAINT agent_status__counts__ck CHECK (queue_depth >= 0 AND oldest_pending_age_seconds >= 0 AND queue_rejected >= 0 AND queue_oversize >= 0),
  CONSTRAINT agent_status__config_state__ck CHECK (config_state IS NULL OR config_state IN ('ok','signature_invalid','agent_mismatch','rollback_rejected','schema_invalid')),
  CONSTRAINT agent_status__update_state__ck CHECK (update_state IS NULL OR update_state IN ('idle','downloading','verifying','staged','applying','rolled_back','verify_failed','failed')),
  CONSTRAINT agent_status__auth_state__ck CHECK (auth_state IS NULL OR auth_state IN ('ok','rejected')),
  CONSTRAINT agent_status__text__ck CHECK (coalesce(char_length(agent_version),0) <= 32 AND coalesce(char_length(launcher_version),0) <= 32
    AND coalesce(char_length(os_version),0) <= 64 AND coalesce(char_length(update_target_version),0) <= 32
    AND coalesce(char_length(update_error_code),0) <= 64),
  CONSTRAINT agent_status__counters__ck CHECK (jsonb_typeof(counters) = 'object' AND octet_length(counters::text) <= 2048)
);
CREATE INDEX agent_status__tenant_id_health_state__idx ON instruments.agent_status (tenant_id, health_state);

CREATE TABLE instruments.agent_health_transitions (
  id uuid NOT NULL, tenant_id uuid NOT NULL, centre_id uuid NOT NULL, agent_id uuid NOT NULL,
  health_version integer NOT NULL, from_state text, to_state text NOT NULL, changed_at timestamptz NOT NULL,
  last_heartbeat_at timestamptz, queue_depth integer NOT NULL, clock_offset_seconds integer,
  silent_instrument_ids uuid[] NOT NULL DEFAULT '{}', event_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  CONSTRAINT agent_health_transitions__pk PRIMARY KEY (id),
  CONSTRAINT agent_health_transitions__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT agent_health_transitions__version__uq UNIQUE (tenant_id, agent_id, health_version),
  CONSTRAINT agent_health_transitions__agent__fk FOREIGN KEY (tenant_id, agent_id, centre_id) REFERENCES instruments.agents (tenant_id, id, centre_id),
  CONSTRAINT agent_health_transitions__states__ck CHECK (to_state IN ('online','offline','backlog','degraded')
    AND (from_state IS NULL OR from_state IN ('online','offline','backlog','degraded')))
);
CREATE INDEX agent_health_transitions__tenant_id_agent_id_changed_at__idx ON instruments.agent_health_transitions (tenant_id, agent_id, changed_at DESC);

CREATE TABLE instruments.agent_config_versions (
  id uuid NOT NULL, tenant_id uuid NOT NULL, centre_id uuid NOT NULL, agent_id uuid NOT NULL,
  config_version integer NOT NULL, document jsonb NOT NULL, canonical_sha256 text NOT NULL,
  signature text NOT NULL, key_id text NOT NULL, issued_at timestamptz NOT NULL, reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  CONSTRAINT agent_config_versions__pk PRIMARY KEY (id),
  CONSTRAINT agent_config_versions__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT agent_config_versions__agent__fk FOREIGN KEY (tenant_id, agent_id, centre_id) REFERENCES instruments.agents (tenant_id, id, centre_id),
  CONSTRAINT agent_config_versions__reason__ck CHECK (reason IN ('agent_created','instrument_changed','agent_changed','release_changed','settings_changed')),
  CONSTRAINT agent_config_versions__doc__ck CHECK (jsonb_typeof(document) = 'object' AND config_version >= 1
    AND canonical_sha256 ~ '^[0-9a-f]{64}$' AND char_length(key_id) <= 32)
);
CREATE UNIQUE INDEX agent_config_versions__tenant_id_agent_id_config_version__uq ON instruments.agent_config_versions (tenant_id, agent_id, config_version);

CREATE TABLE instruments.agent_commands (
  id uuid NOT NULL, tenant_id uuid NOT NULL, centre_id uuid NOT NULL, agent_id uuid NOT NULL,
  kind text NOT NULL, params jsonb NOT NULL DEFAULT '{}', state text NOT NULL DEFAULT 'queued',
  requested_by uuid NOT NULL, requested_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz, completed_at timestamptz, result_code text, expires_at timestamptz NOT NULL,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT agent_commands__pk PRIMARY KEY (id),
  CONSTRAINT agent_commands__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT agent_commands__agent__fk FOREIGN KEY (tenant_id, agent_id, centre_id) REFERENCES instruments.agents (tenant_id, id, centre_id),
  CONSTRAINT agent_commands__kind__ck CHECK (kind IN ('upload_logs','refresh_config','restart_service','reupload_since')),
  CONSTRAINT agent_commands__state__ck CHECK (state IN ('queued','delivered','completed','failed','expired')),
  CONSTRAINT agent_commands__params__ck CHECK (jsonb_typeof(params) = 'object' AND octet_length(params::text) <= 256
    AND (kind <> 'reupload_since' OR params ? 'since')),
  CONSTRAINT agent_commands__result__ck CHECK (coalesce(char_length(result_code),0) <= 64)
);
CREATE INDEX agent_commands__tenant_id_agent_id_state__idx ON instruments.agent_commands (tenant_id, agent_id, state, requested_at);
CREATE INDEX agent_commands__expiry__p_idx ON instruments.agent_commands (tenant_id, expires_at) WHERE state IN ('queued','delivered');

CREATE TABLE instruments.agent_log_bundles (
  id uuid NOT NULL, tenant_id uuid NOT NULL, centre_id uuid NOT NULL, agent_id uuid NOT NULL, command_id uuid NOT NULL,
  lines text[] NOT NULL, from_at_agent timestamptz NOT NULL, to_at_agent timestamptz NOT NULL, size_bytes integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  CONSTRAINT agent_log_bundles__pk PRIMARY KEY (id),
  CONSTRAINT agent_log_bundles__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT agent_log_bundles__agent__fk FOREIGN KEY (tenant_id, agent_id, centre_id) REFERENCES instruments.agents (tenant_id, id, centre_id),
  CONSTRAINT agent_log_bundles__command__fk FOREIGN KEY (tenant_id, command_id) REFERENCES instruments.agent_commands (tenant_id, id),
  CONSTRAINT agent_log_bundles__size__ck CHECK (cardinality(lines) <= 20000 AND size_bytes BETWEEN 0 AND 4194304)
);
CREATE INDEX agent_log_bundles__tenant_id_agent_id_created_at__idx ON instruments.agent_log_bundles (tenant_id, agent_id, created_at DESC);
CREATE INDEX agent_log_bundles__tenant_id_command_id__idx ON instruments.agent_log_bundles (tenant_id, command_id);   -- FK check during purge

-- ===== instruments
CREATE TABLE instruments.instruments (
  id uuid NOT NULL, tenant_id uuid NOT NULL, centre_id uuid NOT NULL, agent_id uuid NOT NULL,
  instrument_code text NOT NULL, display_name text NOT NULL, vendor text NOT NULL, model text NOT NULL,
  serial_no text, software_version text,
  protocol text NOT NULL, driver_code text NOT NULL,
  transport jsonb NOT NULL, protocol_options jsonb NOT NULL DEFAULT '{}', parser_options jsonb NOT NULL DEFAULT '{}',
  file_drop jsonb,
  cap_host_query boolean NOT NULL DEFAULT false, cap_worklist_download boolean NOT NULL DEFAULT false,
  qc_sample_id_patterns text[] NOT NULL DEFAULT '{}', timezone text NOT NULL,
  silence_window_minutes integer, silence_active_from time, silence_active_to time,
  state text NOT NULL DEFAULT 'draft',
  commissioned_at timestamptz, live_at timestamptz, live_by uuid, suspended_at timestamptz, retired_at timestamptz,
  go_live_checklist jsonb, state_reason_text text,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT instruments__pk PRIMARY KEY (id),
  CONSTRAINT instruments__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT instruments__tenant_id_id_centre_id__uq UNIQUE (tenant_id, id, centre_id),
  CONSTRAINT instruments__agent__fk FOREIGN KEY (tenant_id, agent_id, centre_id) REFERENCES instruments.agents (tenant_id, id, centre_id),
  CONSTRAINT instruments__driver__fk FOREIGN KEY (driver_code) REFERENCES instruments.g_drivers (code),
  CONSTRAINT instruments__code__ck CHECK (instrument_code ~ '^[A-Z0-9-]{2,32}$'),
  CONSTRAINT instruments__text__ck CHECK (char_length(display_name) BETWEEN 1 AND 80 AND char_length(vendor) BETWEEN 1 AND 60
    AND char_length(model) BETWEEN 1 AND 60 AND coalesce(char_length(serial_no),0) <= 60
    AND coalesce(char_length(software_version),0) <= 40 AND char_length(timezone) BETWEEN 1 AND 64
    AND coalesce(char_length(state_reason_text),0) <= 300),
  CONSTRAINT instruments__protocol__ck CHECK (protocol IN ('astm','hl7v2','file_drop')),
  CONSTRAINT instruments__transport__ck CHECK (jsonb_typeof(transport) = 'object'
    AND transport->>'kind' IN ('serial','tcp_client','tcp_server','file_drop')
    AND ((protocol = 'file_drop') = (transport->>'kind' = 'file_drop'))),
  CONSTRAINT instruments__options__ck CHECK (jsonb_typeof(protocol_options) = 'object' AND jsonb_typeof(parser_options) = 'object'
    AND (file_drop IS NULL OR (jsonb_typeof(file_drop) = 'object' AND protocol <> 'file_drop'))),
  CONSTRAINT instruments__worklist_blocked__ck CHECK (cap_worklist_download = false),
    -- dropped only in the migration that promotes a driver with cap_worklist_download = true (06 §4)
  CONSTRAINT instruments__qc_patterns__ck CHECK (cardinality(qc_sample_id_patterns) <= 10),
  CONSTRAINT instruments__silence__ck CHECK ((silence_window_minutes IS NULL OR silence_window_minutes BETWEEN 15 AND 1440)
    AND ((silence_active_from IS NULL) = (silence_active_to IS NULL))),
  CONSTRAINT instruments__state__ck CHECK (state IN ('draft','commissioning','live','suspended','retired')),
  CONSTRAINT instruments__live__ck CHECK (state NOT IN ('live','suspended') OR (live_at IS NOT NULL AND go_live_checklist IS NOT NULL))
);
CREATE UNIQUE INDEX instruments__tenant_id_instrument_code__uq ON instruments.instruments (tenant_id, instrument_code);
CREATE INDEX instruments__tenant_id_agent_id_state__idx ON instruments.instruments (tenant_id, agent_id, state);
CREATE INDEX instruments__tenant_id_centre_id_state__idx ON instruments.instruments (tenant_id, centre_id, state);

CREATE TABLE instruments.instrument_status (
  tenant_id uuid NOT NULL, instrument_id uuid NOT NULL, centre_id uuid NOT NULL, agent_id uuid NOT NULL,
  link_state text, last_link_error_code text, last_message_at timestamptz, last_message_at_agent timestamptz,
  instrument_clock_offset_seconds integer, silent_since timestamptz, messages_last_interval integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT instrument_status__pk PRIMARY KEY (tenant_id, instrument_id),
  CONSTRAINT instrument_status__instrument__fk FOREIGN KEY (tenant_id, instrument_id, centre_id) REFERENCES instruments.instruments (tenant_id, id, centre_id),
  CONSTRAINT instrument_status__agent__fk FOREIGN KEY (tenant_id, agent_id, centre_id) REFERENCES instruments.agents (tenant_id, id, centre_id),
  CONSTRAINT instrument_status__link__ck CHECK (link_state IS NULL OR link_state IN ('up','down','listening','connecting','error','disabled')),
  CONSTRAINT instrument_status__err__ck CHECK (coalesce(char_length(last_link_error_code),0) <= 64)
);

-- ===== archive
CREATE TABLE instruments.messages (
  id uuid NOT NULL, tenant_id uuid NOT NULL, centre_id uuid NOT NULL, instrument_id uuid NOT NULL, agent_id uuid NOT NULL,
  agent_message_id uuid NOT NULL, protocol text NOT NULL, message_kind text NOT NULL,
  message_key text NOT NULL, message_key_kind text NOT NULL, message_control_id text,
  raw_bytes bytea NOT NULL, raw_sha256 text NOT NULL, size_bytes integer NOT NULL,
  captured_at_agent timestamptz NOT NULL, agent_clock_offset_ms integer NOT NULL, captured_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(), link_meta jsonb NOT NULL DEFAULT '{}', warnings text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  CONSTRAINT messages__pk PRIMARY KEY (id),
  CONSTRAINT messages__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT messages__tenant_id_id_centre_id__uq UNIQUE (tenant_id, id, centre_id),
  CONSTRAINT messages__instrument__fk FOREIGN KEY (tenant_id, instrument_id, centre_id) REFERENCES instruments.instruments (tenant_id, id, centre_id),
  CONSTRAINT messages__agent__fk FOREIGN KEY (tenant_id, agent_id, centre_id) REFERENCES instruments.agents (tenant_id, id, centre_id),
  CONSTRAINT messages__protocol__ck CHECK (protocol IN ('astm','hl7v2','file_drop')),
  CONSTRAINT messages__kind__ck CHECK (message_kind IN ('data','incomplete','host_query','attachment')),
  CONSTRAINT messages__key__ck CHECK (char_length(message_key) BETWEEN 1 AND 220
    AND message_key_kind IN ('msh10','msh10_reused','sha256','sha256_repeat') AND coalesce(char_length(message_control_id),0) <= 199),
  CONSTRAINT messages__raw__ck CHECK (octet_length(raw_bytes) BETWEEN 1 AND 1048576 AND size_bytes = octet_length(raw_bytes)
    AND raw_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT messages__meta__ck CHECK (jsonb_typeof(link_meta) = 'object' AND octet_length(link_meta::text) <= 1024
    AND cardinality(warnings) <= 20)
);
CREATE UNIQUE INDEX messages__tenant_id_agent_id_agent_message_id__uq ON instruments.messages (tenant_id, agent_id, agent_message_id);
CREATE UNIQUE INDEX messages__tenant_id_instrument_id_message_key__uq ON instruments.messages (tenant_id, instrument_id, message_key);
CREATE INDEX messages__tenant_id_centre_id_received_at__idx ON instruments.messages (tenant_id, centre_id, received_at DESC);
CREATE INDEX messages__tenant_id_instrument_id_received_at__idx ON instruments.messages (tenant_id, instrument_id, received_at DESC);
CREATE INDEX messages__tenant_id_received_at__idx ON instruments.messages (tenant_id, received_at);

CREATE TABLE instruments.processing_runs (
  id uuid NOT NULL, tenant_id uuid NOT NULL, centre_id uuid NOT NULL, message_id uuid NOT NULL,
  run_no integer NOT NULL, kind text NOT NULL, driver_code text NOT NULL, driver_version text NOT NULL,
  outcome text NOT NULL, error_code text, error_reason text,
  patient_records integer NOT NULL DEFAULT 0, qc_records integer NOT NULL DEFAULT 0, calibrator_records integer NOT NULL DEFAULT 0,
  host_query_records integer NOT NULL DEFAULT 0, unmapped_records integer NOT NULL DEFAULT 0,
  skipped_no_barcode_records integer NOT NULL DEFAULT 0, emitted_events integer NOT NULL DEFAULT 0, skipped_records integer NOT NULL DEFAULT 0,
  reason_code text, reason_text text, actor_type text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  CONSTRAINT processing_runs__pk PRIMARY KEY (id),
  CONSTRAINT processing_runs__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT processing_runs__message__fk FOREIGN KEY (tenant_id, message_id, centre_id) REFERENCES instruments.messages (tenant_id, id, centre_id),
  CONSTRAINT processing_runs__reason__fk FOREIGN KEY (reason_code) REFERENCES instruments.g_cs_reprocess_reasons (code),
  CONSTRAINT processing_runs__kind__ck CHECK (kind IN ('live','reprocess','rematch','attachment_scan')),
  CONSTRAINT processing_runs__outcome__ck CHECK (outcome IN ('parsed','shadow','quarantined','rejected_capability')),
  CONSTRAINT processing_runs__reason_required__ck CHECK (kind NOT IN ('reprocess','rematch') OR reason_code IS NOT NULL),
  CONSTRAINT processing_runs__actor__ck CHECK (actor_type IN ('device','user','system')),
  CONSTRAINT processing_runs__counts__ck CHECK (run_no >= 1 AND patient_records >= 0 AND qc_records >= 0 AND calibrator_records >= 0
    AND host_query_records >= 0 AND unmapped_records >= 0 AND skipped_no_barcode_records >= 0 AND emitted_events >= 0
    AND skipped_records >= 0),
  CONSTRAINT processing_runs__text__ck CHECK (coalesce(char_length(error_code),0) <= 64 AND coalesce(char_length(error_reason),0) <= 200
    AND coalesce(char_length(reason_text),0) <= 300 AND char_length(driver_version) <= 32)
);
CREATE UNIQUE INDEX processing_runs__tenant_id_message_id_run_no__uq ON instruments.processing_runs (tenant_id, message_id, run_no);

CREATE TABLE instruments.message_records (
  id uuid NOT NULL, tenant_id uuid NOT NULL, centre_id uuid NOT NULL, message_id uuid NOT NULL, run_id uuid NOT NULL,
  instrument_id uuid NOT NULL, record_seq integer NOT NULL, record_class text NOT NULL,
  sample_barcode text, control_id_raw text, control_lot_raw text, control_level text,
  record_kind text, instrument_analyte_code text, mapping_status text, analyte_id uuid, test_id uuid,
  value_raw text, value_numeric text, unit_raw text, instrument_flags text[] NOT NULL DEFAULT '{}',
  instrument_result_time timestamptz, instrument_clock_offset_seconds integer, is_rerun boolean,
  organism jsonb, ast jsonb, result_key_sha256 text, emit_status text NOT NULL, event_id uuid,
  port_outcome text, port_reason_code text, port_result_id uuid, source_record_id uuid,
  detail jsonb NOT NULL DEFAULT '{}', warnings text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  CONSTRAINT message_records__pk PRIMARY KEY (id),
  CONSTRAINT message_records__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT message_records__message__fk FOREIGN KEY (tenant_id, message_id, centre_id) REFERENCES instruments.messages (tenant_id, id, centre_id),
  CONSTRAINT message_records__instrument__fk FOREIGN KEY (tenant_id, instrument_id, centre_id) REFERENCES instruments.instruments (tenant_id, id, centre_id),
  CONSTRAINT message_records__run__fk FOREIGN KEY (tenant_id, run_id) REFERENCES instruments.processing_runs (tenant_id, id),
  CONSTRAINT message_records__source__fk FOREIGN KEY (tenant_id, source_record_id) REFERENCES instruments.message_records (tenant_id, id),
  CONSTRAINT message_records__class__ck CHECK (record_class IN ('patient','qc','calibrator','host_query','other')),
  CONSTRAINT message_records__kind__ck CHECK (record_kind IS NULL OR record_kind IN ('quantitative','qualitative','ordinal','text','organism_id','ast','attachment')),
  CONSTRAINT message_records__mapping__ck CHECK (mapping_status IS NULL OR mapping_status IN ('mapped','unmapped')),
  CONSTRAINT message_records__emit__ck CHECK (emit_status IN ('emitted','duplicate_event','shadow','skipped_no_barcode','skipped_invalid',
    'not_applicable','pending_scan','quarantined_attachment')),
  CONSTRAINT message_records__port__ck CHECK (port_outcome IS NULL OR port_outcome IN ('applied','duplicate','unmatched','rejected_state','held')),
  CONSTRAINT message_records__sizes__ck CHECK (coalesce(char_length(sample_barcode),1) BETWEEN 1 AND 40
    AND coalesce(char_length(control_id_raw),0) <= 64 AND coalesce(char_length(control_lot_raw),0) <= 64
    AND coalesce(char_length(control_level),0) <= 16 AND coalesce(char_length(instrument_analyte_code),1) BETWEEN 1 AND 64
    AND coalesce(char_length(value_raw),0) <= 200 AND coalesce(char_length(unit_raw),0) <= 32
    AND cardinality(instrument_flags) <= 20 AND coalesce(char_length(port_reason_code),0) <= 64
    AND cardinality(warnings) <= 20 AND octet_length(detail::text) <= 2048),
  CONSTRAINT message_records__numeric__ck CHECK (value_numeric IS NULL OR value_numeric ~ '^-?[0-9]{1,12}(\.[0-9]{1,6})?$'),
  CONSTRAINT message_records__key__ck CHECK (result_key_sha256 IS NULL OR result_key_sha256 ~ '^[0-9a-f]{64}$')
);
CREATE INDEX message_records__tenant_id_message_id_run_id__idx ON instruments.message_records (tenant_id, message_id, run_id, record_seq);
CREATE INDEX message_records__tenant_id_sample_barcode__p_idx ON instruments.message_records (tenant_id, sample_barcode, created_at DESC)
  WHERE sample_barcode IS NOT NULL;
CREATE INDEX message_records__tenant_id_result_key_sha256__p_idx ON instruments.message_records (tenant_id, result_key_sha256)
  WHERE result_key_sha256 IS NOT NULL;
CREATE INDEX message_records__tenant_id_run_id__idx ON instruments.message_records (tenant_id, run_id);   -- FK check during purge
CREATE INDEX message_records__tenant_id_source_record_id__p_idx ON instruments.message_records (tenant_id, source_record_id)
  WHERE source_record_id IS NOT NULL;                                                                     -- FK check (self) during purge

CREATE TABLE instruments.message_duplicates (
  id uuid NOT NULL, tenant_id uuid NOT NULL, centre_id uuid NOT NULL, agent_id uuid NOT NULL, instrument_id uuid NOT NULL,
  original_message_id uuid NOT NULL, agent_message_id uuid NOT NULL, reason text NOT NULL, received_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  CONSTRAINT message_duplicates__pk PRIMARY KEY (id),
  CONSTRAINT message_duplicates__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT message_duplicates__original__fk FOREIGN KEY (tenant_id, original_message_id, centre_id) REFERENCES instruments.messages (tenant_id, id, centre_id),
  CONSTRAINT message_duplicates__reason__ck CHECK (reason IN ('agent_message_id','message_key'))
);
CREATE INDEX message_duplicates__tenant_id_received_at__idx ON instruments.message_duplicates (tenant_id, received_at);
CREATE INDEX message_duplicates__tenant_id_original_message_id__idx ON instruments.message_duplicates (tenant_id, original_message_id);   -- FK check during purge

CREATE TABLE instruments.message_rejections (
  id uuid NOT NULL, tenant_id uuid NOT NULL, centre_id uuid NOT NULL, agent_id uuid NOT NULL,
  claimed_instrument_id uuid NOT NULL, agent_message_id uuid NOT NULL, reason_code text NOT NULL,
  raw_bytes bytea, raw_sha256 text NOT NULL, size_bytes integer NOT NULL, received_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  CONSTRAINT message_rejections__pk PRIMARY KEY (id),
  CONSTRAINT message_rejections__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT message_rejections__agent__fk FOREIGN KEY (tenant_id, agent_id, centre_id) REFERENCES instruments.agents (tenant_id, id, centre_id),
  CONSTRAINT message_rejections__reason__ck CHECK (reason_code IN ('instruments.instrument_unknown','instruments.device_mismatch','instruments.message_too_large')),
  CONSTRAINT message_rejections__raw__ck CHECK ((raw_bytes IS NULL OR octet_length(raw_bytes) <= 1048576)
    AND (reason_code <> 'instruments.message_too_large' OR raw_bytes IS NULL) AND raw_sha256 ~ '^[0-9a-f]{64}$')
);
CREATE INDEX message_rejections__tenant_id_received_at__idx ON instruments.message_rejections (tenant_id, received_at);

CREATE TABLE instruments.attachments (
  id uuid NOT NULL, tenant_id uuid NOT NULL, centre_id uuid NOT NULL, message_id uuid NOT NULL, instrument_id uuid NOT NULL,
  bucket text NOT NULL, object_path text NOT NULL, sha256 text NOT NULL, mime_type text NOT NULL, size_bytes integer NOT NULL,
  original_file_name text NOT NULL, scan_state text NOT NULL DEFAULT 'pending', scan_attempts integer NOT NULL DEFAULT 0,
  scanned_at timestamptz, version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT attachments__pk PRIMARY KEY (id),
  CONSTRAINT attachments__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT attachments__message__uq UNIQUE (tenant_id, message_id),
  CONSTRAINT attachments__message__fk FOREIGN KEY (tenant_id, message_id, centre_id) REFERENCES instruments.messages (tenant_id, id, centre_id),
  CONSTRAINT attachments__instrument__fk FOREIGN KEY (tenant_id, instrument_id, centre_id) REFERENCES instruments.instruments (tenant_id, id, centre_id),
  CONSTRAINT attachments__path__ck CHECK (char_length(object_path) <= 512 AND split_part(object_path, '/', 1) = tenant_id::text),
  CONSTRAINT attachments__bucket__ck CHECK (bucket = 'instruments-attachments'),
  CONSTRAINT attachments__mime__ck CHECK (mime_type IN ('application/pdf','image/png','image/jpeg')),
  CONSTRAINT attachments__size__ck CHECK (size_bytes BETWEEN 1 AND 15728640 AND sha256 ~ '^[0-9a-f]{64}$'
    AND char_length(original_file_name) BETWEEN 1 AND 255),
  CONSTRAINT attachments__scan__ck CHECK (scan_state IN ('pending','clean','quarantined','failed') AND scan_attempts >= 0)
);
CREATE INDEX attachments__tenant_id_scan_state__p_idx ON instruments.attachments (tenant_id, scan_state) WHERE scan_state IN ('pending','failed');

CREATE TABLE instruments.observed_codes (
  tenant_id uuid NOT NULL, instrument_id uuid NOT NULL, record_class text NOT NULL, instrument_analyte_code text NOT NULL,
  centre_id uuid NOT NULL, first_seen_at timestamptz NOT NULL, last_seen_at timestamptz NOT NULL, seen_count bigint NOT NULL DEFAULT 1,
  last_mapping_status text NOT NULL, last_analyte_id uuid, last_mapping_checked_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT observed_codes__pk PRIMARY KEY (tenant_id, instrument_id, record_class, instrument_analyte_code),
  CONSTRAINT observed_codes__instrument__fk FOREIGN KEY (tenant_id, instrument_id, centre_id) REFERENCES instruments.instruments (tenant_id, id, centre_id),
  CONSTRAINT observed_codes__class__ck CHECK (record_class IN ('patient','qc','calibrator')),
  CONSTRAINT observed_codes__status__ck CHECK (last_mapping_status IN ('mapped','unmapped')),
  CONSTRAINT observed_codes__code__ck CHECK (char_length(instrument_analyte_code) BETWEEN 1 AND 64 AND seen_count >= 1)
);
CREATE INDEX observed_codes__tenant_id_instrument_id_status__idx ON instruments.observed_codes (tenant_id, instrument_id, last_mapping_status);

-- ===== triggers (C0 generic + module transition triggers; transition function bodies follow 03-APP-FLOW §2)
CREATE TRIGGER agent_credentials__mutable_columns BEFORE UPDATE ON instruments.agent_credentials FOR EACH ROW
  EXECUTE FUNCTION app.enforce_mutable_columns('status','used_at','last_used_at','revoked_at','revoked_by','revoke_reason_code',
    'replaced_by_credential_id','updated_at','updated_by','version');
CREATE TRIGGER attachments__mutable_columns BEFORE UPDATE ON instruments.attachments FOR EACH ROW
  EXECUTE FUNCTION app.enforce_mutable_columns('object_path','scan_state','scan_attempts','scanned_at','sha256','updated_at','updated_by','version');
CREATE TRIGGER agent_commands__mutable_columns BEFORE UPDATE ON instruments.agent_commands FOR EACH ROW
  EXECUTE FUNCTION app.enforce_mutable_columns('state','delivered_at','completed_at','result_code','updated_at','updated_by','version');
-- agents / instruments: identity columns frozen (§4) — C0 expresses as the complement list.

-- ===== seeds
INSERT INTO instruments.g_cs_revoke_reasons (code, display, sort_order) VALUES
 ('device_replaced','Device replaced',10),('device_lost_or_stolen','Device lost or stolen',20),
 ('suspected_compromise','Suspected compromise',30),('decommissioned','Decommissioned',40),('staff_error','Issued in error',50),('other','Other',90);
INSERT INTO instruments.g_cs_reprocess_reasons (code, display, sort_order) VALUES
 ('driver_fixed','Driver fixed',10),('mapping_added','Code mapping added',20),('quarantine_reviewed','Quarantine reviewed',30),
 ('barcode_keypad_error','Barcode typed wrongly at instrument',40),('barcode_label_misread','Barcode label misread',50),
 ('instrument_resent_wrong_id','Instrument sent wrong sample id',60),('other','Other',90);
INSERT INTO instruments.g_drivers (code, display_name, protocol, vendor, status, driver_version, cap_host_query, cap_qc, cap_attachments) VALUES
 ('astm_generic_e1394','Generic ASTM E1394','astm',NULL,'generic','0.1.0',false,true,false),
 ('hl7v2_generic_oru','Generic HL7 v2 ORU^R01','hl7v2',NULL,'generic','0.1.0',false,true,false),
 ('file_drop_generic','Folder (pictures/PDF)','file_drop',NULL,'generic','0.1.0',false,false,true),
 ('mindray_bc5380_sketch','Mindray BC-5380 (sketch — not for use)','hl7v2','Mindray','sketch_blocked','0.0.1',true,false,false),
 ('mindray_bs200_sketch','Mindray BS-120/200 (sketch — not for use)','hl7v2','Mindray','sketch_blocked','0.0.1',true,false,false);

-- =====================================================================
-- §4 mutable columns: agents / instruments = complement of the frozen identity columns
-- =====================================================================
CREATE TRIGGER agents__mutable_columns BEFORE UPDATE ON instruments.agents FOR EACH ROW
  EXECUTE FUNCTION app.enforce_mutable_columns('display_name','status','update_channel','pinned_release_id','backlog_threshold','enrolled_at','host_fingerprint_sha256','revoked_at','revoked_by','revoke_reason_code','revoke_reason_text','retired_at','retired_by','latest_config_version','version','is_active','updated_at','updated_by');
CREATE TRIGGER instruments__mutable_columns BEFORE UPDATE ON instruments.instruments FOR EACH ROW
  EXECUTE FUNCTION app.enforce_mutable_columns('display_name','vendor','model','serial_no','software_version','driver_code','transport','protocol_options','parser_options','file_drop','cap_host_query','cap_worklist_download','qc_sample_id_patterns','timezone','silence_window_minutes','silence_active_from','silence_active_to','state','commissioned_at','live_at','live_by','suspended_at','retired_at','go_live_checklist','state_reason_text','version','is_active','updated_at','updated_by');

-- =====================================================================
-- §4 transition triggers (INVOKER, search_path = '')
-- =====================================================================
-- 03-APP-FLOW §2.1: allowed agents.status pairs; anything else -> P0001 invalid_transition (409 instruments.invalid_transition)
CREATE FUNCTION instruments.tg_agent_transition() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'pending_enrolment' AND NEW.status IN ('active','revoked','retired')) OR
       (OLD.status = 'active'            AND NEW.status IN ('revoked','retired')) OR
       (OLD.status = 'revoked'           AND NEW.status IN ('active','retired'))) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'invalid_transition',
      DETAIL = format('instruments.agents.status %s -> %s', OLD.status, NEW.status);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER agents__transition BEFORE UPDATE ON instruments.agents FOR EACH ROW EXECUTE FUNCTION instruments.tg_agent_transition();

-- 03-APP-FLOW §2.2: allowed instruments.state pairs; anything else -> P0001 invalid_transition (409 instruments.invalid_transition)
CREATE FUNCTION instruments.tg_instrument_transition() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
       (OLD.state = 'draft'         AND NEW.state IN ('commissioning','retired')) OR
       (OLD.state = 'commissioning' AND NEW.state IN ('live','retired')) OR
       (OLD.state = 'live'          AND NEW.state IN ('suspended','retired')) OR
       (OLD.state = 'suspended'     AND NEW.state IN ('live','retired'))) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'invalid_transition',
      DETAIL = format('instruments.instruments.state %s -> %s', OLD.state, NEW.state);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER instruments__transition BEFORE UPDATE ON instruments.instruments FOR EACH ROW EXECUTE FUNCTION instruments.tg_instrument_transition();

-- 03-APP-FLOW §2.3: allowed agent_credentials.status pairs; anything else -> P0001 invalid_transition (409 instruments.invalid_transition)
CREATE FUNCTION instruments.tg_credential_transition() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'active' AND NEW.status IN ('used','expired','revoked'))) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'invalid_transition',
      DETAIL = format('instruments.agent_credentials.status %s -> %s', OLD.status, NEW.status);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER agent_credentials__transition BEFORE UPDATE ON instruments.agent_credentials FOR EACH ROW EXECUTE FUNCTION instruments.tg_credential_transition();

-- 03-APP-FLOW §2.5: allowed agent_commands.state pairs; anything else -> P0001 invalid_transition (409 instruments.invalid_transition)
CREATE FUNCTION instruments.tg_command_transition() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
       (OLD.state = 'queued'    AND NEW.state IN ('delivered','expired')) OR
       (OLD.state = 'delivered' AND NEW.state IN ('completed','failed','expired'))) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'invalid_transition',
      DETAIL = format('instruments.agent_commands.state %s -> %s', OLD.state, NEW.state);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER agent_commands__transition BEFORE UPDATE ON instruments.agent_commands FOR EACH ROW EXECUTE FUNCTION instruments.tg_command_transition();

-- 03-APP-FLOW §2.6: allowed attachments.scan_state pairs; anything else -> P0001 invalid_transition (409 instruments.invalid_transition)
CREATE FUNCTION instruments.tg_attachment_transition() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  IF NEW.scan_state IS DISTINCT FROM OLD.scan_state AND NOT (
       (OLD.scan_state = 'pending' AND NEW.scan_state IN ('clean','quarantined','failed')) OR
       (OLD.scan_state = 'failed'  AND NEW.scan_state IN ('pending'))) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'invalid_transition',
      DETAIL = format('instruments.attachments.scan_state %s -> %s', OLD.scan_state, NEW.scan_state);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER attachments__transition BEFORE UPDATE ON instruments.attachments FOR EACH ROW EXECUTE FUNCTION instruments.tg_attachment_transition();

-- =====================================================================
-- §1 / §4 row audit (app.tg_row_audit; AC-0B-5.x)
-- =====================================================================
CREATE TRIGGER agents__audit AFTER INSERT OR UPDATE OR DELETE ON instruments.agents FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER agent_credentials__audit AFTER INSERT OR UPDATE OR DELETE ON instruments.agent_credentials FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit('secret_sha256');
CREATE TRIGGER agent_commands__audit AFTER INSERT OR UPDATE OR DELETE ON instruments.agent_commands FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER instruments__audit AFTER INSERT OR UPDATE OR DELETE ON instruments.instruments FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER attachments__audit AFTER INSERT OR UPDATE OR DELETE ON instruments.attachments FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER settings__audit AFTER INSERT OR UPDATE OR DELETE ON instruments.settings FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();

-- =====================================================================
-- §5 RLS: ENABLE + FORCE on the 17 tenant tables (G tables are RLS-exempt)
-- =====================================================================
ALTER TABLE instruments.settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE instruments.settings FORCE ROW LEVEL SECURITY;
ALTER TABLE instruments.agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE instruments.agents FORCE ROW LEVEL SECURITY;
ALTER TABLE instruments.agent_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE instruments.agent_credentials FORCE ROW LEVEL SECURITY;
ALTER TABLE instruments.agent_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE instruments.agent_status FORCE ROW LEVEL SECURITY;
ALTER TABLE instruments.agent_health_transitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE instruments.agent_health_transitions FORCE ROW LEVEL SECURITY;
ALTER TABLE instruments.agent_config_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE instruments.agent_config_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE instruments.agent_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE instruments.agent_commands FORCE ROW LEVEL SECURITY;
ALTER TABLE instruments.agent_log_bundles ENABLE ROW LEVEL SECURITY;
ALTER TABLE instruments.agent_log_bundles FORCE ROW LEVEL SECURITY;
ALTER TABLE instruments.instruments ENABLE ROW LEVEL SECURITY;
ALTER TABLE instruments.instruments FORCE ROW LEVEL SECURITY;
ALTER TABLE instruments.instrument_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE instruments.instrument_status FORCE ROW LEVEL SECURITY;
ALTER TABLE instruments.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE instruments.messages FORCE ROW LEVEL SECURITY;
ALTER TABLE instruments.processing_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE instruments.processing_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE instruments.message_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE instruments.message_records FORCE ROW LEVEL SECURITY;
ALTER TABLE instruments.message_duplicates ENABLE ROW LEVEL SECURITY;
ALTER TABLE instruments.message_duplicates FORCE ROW LEVEL SECURITY;
ALTER TABLE instruments.message_rejections ENABLE ROW LEVEL SECURITY;
ALTER TABLE instruments.message_rejections FORCE ROW LEVEL SECURITY;
ALTER TABLE instruments.attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE instruments.attachments FORCE ROW LEVEL SECURITY;
ALTER TABLE instruments.observed_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE instruments.observed_codes FORCE ROW LEVEL SECURITY;

-- =====================================================================
-- §5 centre template (02-CV §5.8), rows 1-16
-- =====================================================================
CREATE POLICY agents__select__tenant_centre ON instruments.agents FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY agents__insert__tenant_centre ON instruments.agents FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY agents__update__tenant_centre ON instruments.agents FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY agent_credentials__select__tenant_centre ON instruments.agent_credentials FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY agent_credentials__insert__tenant_centre ON instruments.agent_credentials FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY agent_credentials__update__tenant_centre ON instruments.agent_credentials FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY agent_status__select__tenant_centre ON instruments.agent_status FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY agent_status__insert__tenant_centre ON instruments.agent_status FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY agent_status__update__tenant_centre ON instruments.agent_status FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY agent_health_transitions__select__tenant_centre ON instruments.agent_health_transitions FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY agent_health_transitions__insert__tenant_centre ON instruments.agent_health_transitions FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY agent_config_versions__select__tenant_centre ON instruments.agent_config_versions FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY agent_config_versions__insert__tenant_centre ON instruments.agent_config_versions FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY agent_commands__select__tenant_centre ON instruments.agent_commands FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY agent_commands__insert__tenant_centre ON instruments.agent_commands FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY agent_commands__update__tenant_centre ON instruments.agent_commands FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY agent_log_bundles__select__tenant_centre ON instruments.agent_log_bundles FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY agent_log_bundles__insert__tenant_centre ON instruments.agent_log_bundles FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY instruments__select__tenant_centre ON instruments.instruments FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY instruments__insert__tenant_centre ON instruments.instruments FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY instruments__update__tenant_centre ON instruments.instruments FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY instrument_status__select__tenant_centre ON instruments.instrument_status FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY instrument_status__insert__tenant_centre ON instruments.instrument_status FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY instrument_status__update__tenant_centre ON instruments.instrument_status FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY messages__select__tenant_centre ON instruments.messages FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY messages__insert__tenant_centre ON instruments.messages FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY processing_runs__select__tenant_centre ON instruments.processing_runs FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY processing_runs__insert__tenant_centre ON instruments.processing_runs FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY message_records__select__tenant_centre ON instruments.message_records FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY message_records__insert__tenant_centre ON instruments.message_records FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY message_duplicates__select__tenant_centre ON instruments.message_duplicates FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY message_duplicates__insert__tenant_centre ON instruments.message_duplicates FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY message_rejections__select__tenant_centre ON instruments.message_rejections FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY message_rejections__insert__tenant_centre ON instruments.message_rejections FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY attachments__select__tenant_centre ON instruments.attachments FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY attachments__insert__tenant_centre ON instruments.attachments FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY attachments__update__tenant_centre ON instruments.attachments FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY observed_codes__select__tenant_centre ON instruments.observed_codes FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY observed_codes__insert__tenant_centre ON instruments.observed_codes FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY observed_codes__update__tenant_centre ON instruments.observed_codes FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));

-- =====================================================================
-- §5 settings (__tenant with the staff guard)
-- =====================================================================
CREATE POLICY settings__select__tenant ON instruments.settings FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY settings__insert__tenant ON instruments.settings FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY settings__update__tenant ON instruments.settings FOR UPDATE TO lims_app
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));

-- =====================================================================
-- §5 grants to lims_app
-- =====================================================================
GRANT SELECT, INSERT, UPDATE ON instruments.agents, instruments.instruments, instruments.agent_commands, instruments.attachments, instruments.agent_status, instruments.instrument_status, instruments.observed_codes, instruments.settings TO lims_app;
GRANT SELECT, INSERT ON instruments.agent_health_transitions, instruments.agent_config_versions, instruments.agent_log_bundles, instruments.messages, instruments.processing_runs, instruments.message_records, instruments.message_duplicates, instruments.message_rejections TO lims_app;
GRANT SELECT ON instruments.g_drivers, instruments.g_agent_releases, instruments.g_cs_revoke_reasons, instruments.g_cs_reprocess_reasons TO lims_app;
-- agent_credentials (CR-C7-006): INSERT on all columns, UPDATE on the lifecycle (mutable) columns, SELECT on every column except secret_sha256
GRANT INSERT ON instruments.agent_credentials TO lims_app;
GRANT SELECT (id, tenant_id, centre_id, agent_id, kind, status, issued_at, issued_by, expires_at, used_at, last_used_at, revoked_at, revoked_by, revoke_reason_code, replaced_by_credential_id, version, created_at, created_by, updated_at, updated_by) ON instruments.agent_credentials TO lims_app;
GRANT UPDATE (status, used_at, last_used_at, revoked_at, revoked_by, revoke_reason_code, replaced_by_credential_id, updated_at, updated_by, version) ON instruments.agent_credentials TO lims_app;

-- =====================================================================
-- §5 owner_only policies and DEFINER functions (verbatim)
-- =====================================================================
-- ===== (a) Device-credential resolver (pre-tenant; 08 A12.1)
CREATE POLICY agent_credentials__select__owner_only ON instruments.agent_credentials FOR SELECT TO lims_owner
  USING (secret_sha256 = decode(nullif(current_setting('app.pre_device_secret_sha256', true), ''), 'hex'));
-- one SELECT owner policy on agents serves both the resolver (a) and the metrics snapshot (b)
CREATE POLICY agents__select__owner_only ON instruments.agents FOR SELECT TO lims_owner
  USING (id = nullif(current_setting('app.pre_device_agent_id', true), '')::uuid
         OR current_setting('app.maintenance', true) = 'instruments_agent_state_snapshot');

CREATE FUNCTION app.instruments_resolve_device_credential(p_secret_sha256 bytea)
RETURNS TABLE (tenant_id uuid, agent_id uuid, centre_id uuid, credential_id uuid, credential_kind text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE c record;
BEGIN
  IF p_secret_sha256 IS NULL OR octet_length(p_secret_sha256) <> 32 THEN RETURN; END IF;
  PERFORM set_config('app.pre_device_secret_sha256', encode(p_secret_sha256, 'hex'), true);
  SELECT ac.id, ac.tenant_id, ac.agent_id, ac.kind, ac.status, ac.expires_at INTO c
    FROM instruments.agent_credentials ac WHERE ac.secret_sha256 = p_secret_sha256;
  PERFORM set_config('app.pre_device_secret_sha256', '', true);
  IF NOT FOUND OR c.status <> 'active' OR (c.expires_at IS NOT NULL AND c.expires_at <= now()) THEN RETURN; END IF;
  PERFORM set_config('app.pre_device_agent_id', c.agent_id::text, true);
  RETURN QUERY
    SELECT a.tenant_id, a.id, a.centre_id, c.id, c.kind
      FROM instruments.agents a
     WHERE a.id = c.agent_id AND a.tenant_id = c.tenant_id
       AND ((c.kind = 'device_token'   AND a.status = 'active')
         OR (c.kind = 'enrolment_code' AND a.status IN ('pending_enrolment','active','revoked')));
  PERFORM set_config('app.pre_device_agent_id', '', true);
END $$;
-- VOLATILE because the body calls set_config (review fix pass; replaces the earlier STABLE + note).
REVOKE ALL ON FUNCTION app.instruments_resolve_device_credential(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.instruments_resolve_device_credential(bytea) TO lims_api;

-- ===== (b) Metrics snapshot (P0 only), all tenants — called by the platform-scope task (02-TRD §10)
CREATE POLICY agent_status__select__owner_only ON instruments.agent_status FOR SELECT TO lims_owner
  USING (current_setting('app.maintenance', true) = 'instruments_agent_state_snapshot');
CREATE FUNCTION app.instruments_agent_state_snapshot()
RETURNS TABLE (tenant_id uuid, centre_id uuid, agent_id uuid, health_state text, last_heartbeat_at timestamptz,
               queue_depth integer, clock_offset_ms integer, agent_version text, silent_instrument_count integer)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM set_config('app.maintenance', 'instruments_agent_state_snapshot', true);
  RETURN QUERY
    SELECT s.tenant_id, s.centre_id, s.agent_id, s.health_state, s.last_heartbeat_at, s.queue_depth,
           s.clock_offset_ms, s.agent_version, cardinality(s.silent_instrument_ids)
      FROM instruments.agent_status s
      JOIN instruments.agents a ON a.tenant_id = s.tenant_id AND a.id = s.agent_id
     WHERE a.status <> 'retired';
  PERFORM set_config('app.maintenance', '', true);
END $$;
REVOKE ALL ON FUNCTION app.instruments_agent_state_snapshot() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.instruments_agent_state_snapshot() TO lims_worker;

-- ===== (c) Archive purge — ONE tenant per call (08 A13 P-6 / D-42): the per-tenant job runs under that tenant's
-- system-actor claims; the function deletes only rows of app.current_tenant_id() and refuses to run without it.
-- Owner policies: SELECT (rows must be visible to the DELETE's WHERE/USING and to the joined tables) + DELETE.
CREATE POLICY messages__select__owner_only ON instruments.messages FOR SELECT TO lims_owner
  USING (current_setting('app.maintenance', true) = 'purge_instruments_archive'
         AND tenant_id = (SELECT app.current_tenant_id()));
CREATE POLICY messages__delete__owner_only ON instruments.messages FOR DELETE TO lims_owner
  USING (current_setting('app.maintenance', true) = 'purge_instruments_archive'
         AND tenant_id = (SELECT app.current_tenant_id()));
CREATE POLICY processing_runs__select__owner_only ON instruments.processing_runs FOR SELECT TO lims_owner
  USING (current_setting('app.maintenance', true) = 'purge_instruments_archive'
         AND tenant_id = (SELECT app.current_tenant_id()));
CREATE POLICY processing_runs__delete__owner_only ON instruments.processing_runs FOR DELETE TO lims_owner
  USING (current_setting('app.maintenance', true) = 'purge_instruments_archive'
         AND tenant_id = (SELECT app.current_tenant_id()));
CREATE POLICY message_records__select__owner_only ON instruments.message_records FOR SELECT TO lims_owner
  USING (current_setting('app.maintenance', true) = 'purge_instruments_archive'
         AND tenant_id = (SELECT app.current_tenant_id()));
CREATE POLICY message_records__delete__owner_only ON instruments.message_records FOR DELETE TO lims_owner
  USING (current_setting('app.maintenance', true) = 'purge_instruments_archive'
         AND tenant_id = (SELECT app.current_tenant_id()));
CREATE POLICY message_duplicates__select__owner_only ON instruments.message_duplicates FOR SELECT TO lims_owner
  USING (current_setting('app.maintenance', true) = 'purge_instruments_archive'
         AND tenant_id = (SELECT app.current_tenant_id()));
CREATE POLICY message_duplicates__delete__owner_only ON instruments.message_duplicates FOR DELETE TO lims_owner
  USING (current_setting('app.maintenance', true) = 'purge_instruments_archive'
         AND tenant_id = (SELECT app.current_tenant_id()));
CREATE POLICY message_rejections__select__owner_only ON instruments.message_rejections FOR SELECT TO lims_owner
  USING (current_setting('app.maintenance', true) = 'purge_instruments_archive'
         AND tenant_id = (SELECT app.current_tenant_id()));
CREATE POLICY message_rejections__delete__owner_only ON instruments.message_rejections FOR DELETE TO lims_owner
  USING (current_setting('app.maintenance', true) = 'purge_instruments_archive'
         AND tenant_id = (SELECT app.current_tenant_id()));
CREATE POLICY attachments__select__owner_only ON instruments.attachments FOR SELECT TO lims_owner
  USING (current_setting('app.maintenance', true) = 'purge_instruments_archive'
         AND tenant_id = (SELECT app.current_tenant_id()));
CREATE POLICY attachments__delete__owner_only ON instruments.attachments FOR DELETE TO lims_owner
  USING (current_setting('app.maintenance', true) = 'purge_instruments_archive'
         AND tenant_id = (SELECT app.current_tenant_id()));
CREATE POLICY agent_log_bundles__select__owner_only ON instruments.agent_log_bundles FOR SELECT TO lims_owner
  USING (current_setting('app.maintenance', true) = 'purge_instruments_archive'
         AND tenant_id = (SELECT app.current_tenant_id()));
CREATE POLICY agent_log_bundles__delete__owner_only ON instruments.agent_log_bundles FOR DELETE TO lims_owner
  USING (current_setting('app.maintenance', true) = 'purge_instruments_archive'
         AND tenant_id = (SELECT app.current_tenant_id()));
CREATE POLICY agent_commands__select__owner_only ON instruments.agent_commands FOR SELECT TO lims_owner
  USING (current_setting('app.maintenance', true) = 'purge_instruments_archive'
         AND tenant_id = (SELECT app.current_tenant_id()));
CREATE POLICY agent_commands__delete__owner_only ON instruments.agent_commands FOR DELETE TO lims_owner
  USING (current_setting('app.maintenance', true) = 'purge_instruments_archive'
         AND tenant_id = (SELECT app.current_tenant_id()));
CREATE POLICY agent_health_transitions__select__owner_only ON instruments.agent_health_transitions FOR SELECT TO lims_owner
  USING (current_setting('app.maintenance', true) = 'purge_instruments_archive'
         AND tenant_id = (SELECT app.current_tenant_id()));
CREATE POLICY agent_health_transitions__delete__owner_only ON instruments.agent_health_transitions FOR DELETE TO lims_owner
  USING (current_setting('app.maintenance', true) = 'purge_instruments_archive'
         AND tenant_id = (SELECT app.current_tenant_id()));
CREATE POLICY observed_codes__select__owner_only ON instruments.observed_codes FOR SELECT TO lims_owner
  USING (current_setting('app.maintenance', true) = 'purge_instruments_archive'
         AND tenant_id = (SELECT app.current_tenant_id()));
CREATE POLICY observed_codes__delete__owner_only ON instruments.observed_codes FOR DELETE TO lims_owner
  USING (current_setting('app.maintenance', true) = 'purge_instruments_archive'
         AND tenant_id = (SELECT app.current_tenant_id()));

CREATE FUNCTION app.purge_instruments_archive(p_raw_retention_days integer)
RETURNS TABLE (table_name text, deleted bigint)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_tenant uuid := app.current_tenant_id();
  v_cut    timestamptz;
  n        bigint;
  n2       bigint;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'purge_instruments_archive: tenant claims required' USING ERRCODE = 'P0001';
  END IF;
  IF p_raw_retention_days IS NULL OR p_raw_retention_days < 365 THEN          -- 04 I8 floor (1 year)
    RAISE EXCEPTION 'purge_instruments_archive: retention below 365 days' USING ERRCODE = 'P0001';
  END IF;
  v_cut := now() - make_interval(days => p_raw_retention_days);
  PERFORM set_config('app.maintenance', 'purge_instruments_archive', true);

  -- 1. parsed records: 90 days counted from the MESSAGE (source + derived rows share message_id; review #4)
  DELETE FROM instruments.message_records r USING instruments.messages m
   WHERE r.tenant_id = v_tenant AND m.tenant_id = r.tenant_id AND m.id = r.message_id
     AND m.received_at < now() - interval '90 days';
  GET DIAGNOSTICS n = ROW_COUNT; table_name := 'message_records'; deleted := n; RETURN NEXT;

  -- 2. attachment rows past retention whose Storage object the worker already deleted (path marked '#deleted')
  DELETE FROM instruments.attachments t
   WHERE t.tenant_id = v_tenant AND t.created_at < v_cut AND t.object_path LIKE '%#deleted';
  GET DIAGNOSTICS n = ROW_COUNT; table_name := 'attachments'; deleted := n; RETURN NEXT;

  -- 3. duplicates: those pointing at a message about to be purged, then everything older than 90 days
  DELETE FROM instruments.message_duplicates d USING instruments.messages m
   WHERE d.tenant_id = v_tenant AND m.tenant_id = d.tenant_id AND m.id = d.original_message_id
     AND m.received_at < v_cut
     AND NOT EXISTS (SELECT 1 FROM instruments.attachments a WHERE a.tenant_id = m.tenant_id AND a.message_id = m.id);
  GET DIAGNOSTICS n = ROW_COUNT;
  DELETE FROM instruments.message_duplicates d
   WHERE d.tenant_id = v_tenant AND d.created_at < now() - interval '90 days';
  GET DIAGNOSTICS n2 = ROW_COUNT; table_name := 'message_duplicates'; deleted := n + n2; RETURN NEXT;

  -- 4. runs, then messages, past retention (messages that still have an attachment row wait for step 2)
  DELETE FROM instruments.processing_runs p USING instruments.messages m
   WHERE p.tenant_id = v_tenant AND m.tenant_id = p.tenant_id AND m.id = p.message_id
     AND m.received_at < v_cut
     AND NOT EXISTS (SELECT 1 FROM instruments.attachments a WHERE a.tenant_id = m.tenant_id AND a.message_id = m.id);
  GET DIAGNOSTICS n = ROW_COUNT; table_name := 'processing_runs'; deleted := n; RETURN NEXT;
  DELETE FROM instruments.messages m
   WHERE m.tenant_id = v_tenant AND m.received_at < v_cut
     AND NOT EXISTS (SELECT 1 FROM instruments.attachments a WHERE a.tenant_id = m.tenant_id AND a.message_id = m.id);
  GET DIAGNOSTICS n = ROW_COUNT; table_name := 'messages'; deleted := n; RETURN NEXT;

  -- 5. operational tables with fixed retention [CONV values from §1]
  DELETE FROM instruments.message_rejections x WHERE x.tenant_id = v_tenant AND x.created_at < now() - interval '90 days';
  GET DIAGNOSTICS n = ROW_COUNT; table_name := 'message_rejections'; deleted := n; RETURN NEXT;
  DELETE FROM instruments.agent_log_bundles x WHERE x.tenant_id = v_tenant AND x.created_at < now() - interval '30 days';
  GET DIAGNOSTICS n = ROW_COUNT; table_name := 'agent_log_bundles'; deleted := n; RETURN NEXT;
  DELETE FROM instruments.agent_commands x
   WHERE x.tenant_id = v_tenant AND x.state IN ('completed','failed','expired') AND x.updated_at < now() - interval '90 days'
     AND NOT EXISTS (SELECT 1 FROM instruments.agent_log_bundles b WHERE b.tenant_id = x.tenant_id AND b.command_id = x.id);
  GET DIAGNOSTICS n = ROW_COUNT; table_name := 'agent_commands'; deleted := n; RETURN NEXT;
  DELETE FROM instruments.agent_health_transitions x WHERE x.tenant_id = v_tenant AND x.created_at < now() - interval '400 days';
  GET DIAGNOSTICS n = ROW_COUNT; table_name := 'agent_health_transitions'; deleted := n; RETURN NEXT;
  DELETE FROM instruments.observed_codes x WHERE x.tenant_id = v_tenant AND x.last_seen_at < now() - interval '400 days';
  GET DIAGNOSTICS n = ROW_COUNT; table_name := 'observed_codes'; deleted := n; RETURN NEXT;

  PERFORM set_config('app.maintenance', '', true);
END $$;
REVOKE ALL ON FUNCTION app.purge_instruments_archive(integer) FROM PUBLIC;     -- review #3 (PUBLIC has EXECUTE by default)
GRANT EXECUTE ON FUNCTION app.purge_instruments_archive(integer) TO lims_worker;

-- =====================================================================
-- §6 published views (03-IC §6.5)
-- =====================================================================
CREATE VIEW instruments.v_pub_agent_status WITH (security_invoker = true) AS
SELECT a.tenant_id, a.id AS agent_id, a.centre_id,
       s.health_state AS state, s.last_heartbeat_at, s.agent_version, s.queue_depth,
       (s.clock_offset_ms / 1000)::integer AS clock_offset_seconds
FROM instruments.agents a
JOIN instruments.agent_status s ON s.tenant_id = a.tenant_id AND s.agent_id = a.id
WHERE a.status <> 'retired';

CREATE VIEW instruments.v_pub_message_daily WITH (security_invoker = true) AS
WITH latest AS (
  SELECT DISTINCT ON (p.tenant_id, p.message_id) p.tenant_id, p.message_id, p.outcome, p.run_no,
         p.patient_records, p.qc_records, (p.unmapped_records + p.skipped_no_barcode_records) AS unmatched
  FROM instruments.processing_runs p ORDER BY p.tenant_id, p.message_id, p.run_no DESC),
msg AS (
  SELECT m.tenant_id, m.instrument_id, m.centre_id,
         (m.received_at AT TIME ZONE 'Asia/Kathmandu')::date AS business_date,      -- 08 A13 P-15 (v1 literal)
         count(*) AS messages,
         coalesce(sum(l.patient_records), 0)::bigint AS patient_records,
         coalesce(sum(l.qc_records), 0)::bigint AS qc_records,
         coalesce(sum(l.unmatched), 0)::bigint AS unmatched,
         count(*) FILTER (WHERE l.outcome = 'quarantined') AS quarantined
  FROM instruments.messages m
  LEFT JOIN latest l ON l.tenant_id = m.tenant_id AND l.message_id = m.id
  GROUP BY 1, 2, 3, 4),
dup AS (
  SELECT d.tenant_id, d.instrument_id, d.centre_id, (d.received_at AT TIME ZONE 'Asia/Kathmandu')::date AS business_date,
         count(*) AS duplicates
  FROM instruments.message_duplicates d GROUP BY 1, 2, 3, 4)
SELECT coalesce(msg.tenant_id, dup.tenant_id) AS tenant_id,
       coalesce(msg.instrument_id, dup.instrument_id) AS instrument_id,
       coalesce(msg.centre_id, dup.centre_id) AS centre_id,
       coalesce(msg.business_date, dup.business_date) AS business_date,
       coalesce(msg.messages, 0)::bigint AS messages, coalesce(msg.patient_records, 0)::bigint AS patient_records,
       coalesce(msg.qc_records, 0)::bigint AS qc_records, coalesce(msg.unmatched, 0)::bigint AS unmatched,
       coalesce(msg.quarantined, 0)::bigint AS quarantined, coalesce(dup.duplicates, 0)::bigint AS duplicates
FROM msg FULL JOIN dup USING (tenant_id, instrument_id, centre_id, business_date);

-- 08 R12d / §4.9 (CR-C9-006 primary, CR-C12-005 merged): one directory view for C8, C9, C12; P0
CREATE VIEW instruments.v_pub_instrument_directory WITH (security_invoker = true) AS
SELECT i.tenant_id, i.id AS instrument_id, i.centre_id, i.instrument_code, i.display_name, i.vendor, i.model,
       i.state, i.is_active
FROM instruments.instruments i;

GRANT SELECT ON instruments.v_pub_agent_status, instruments.v_pub_message_daily, instruments.v_pub_instrument_directory TO lims_app, lims_analytics;
