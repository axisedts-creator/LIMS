# C7 Instrument Integration — 05 Schema (`instruments`) — specification for C0-0B

Status: DECISION, 2026-11-06. C0 translates this verbatim (C0 05-SCHEMA §9). Conventions: 02-CV §5 (classes, mandatory columns, composite FKs, RLS template, no ENUM types, naming). Cross-schema FKs only `instruments → core` (and none to `lab`/`catalog`: `instruments` is downstream of both per 01-CM §5 R3, but C7 references no row of theirs — analyte/test ids in records are opaque copies of `CatalogPort` output, like C3 stores instrument ids opaquely). Items needing C0 inventory/grant changes are CR-C7-006/007/008.

---

## 1. Table inventory

| # | Table | Class (02-CV §5.2) | Centre-scoped | Audited (`tg_row_audit`) | Retention | Written by |
|---|---|---|---|---|---|---|
| 1 | `instruments.agents` | M (lifecycle columns) | yes | yes | never deleted | staff (API), device (enrol) |
| 2 | `instruments.agent_credentials` | M (lifecycle) | yes | yes (secret column excluded from audit values — see §4) | never deleted | staff, device |
| 3 | `instruments.agent_status` | E (state row, 1 per agent) | yes | **no** (updated every 60 s) | lives with agent | device (heartbeat), worker |
| 4 | `instruments.agent_health_transitions` | A | yes | no | 400 days [CONV] | worker |
| 5 | `instruments.agent_config_versions` | A | yes | no (append-only itself is the history) | never deleted [CONV] (small) | API |
| 6 | `instruments.agent_commands` | E (state column) | yes | yes | terminal + 90 days | staff, device, worker |
| 7 | `instruments.agent_log_bundles` | E | yes | no | 30 days | device |
| 8 | `instruments.instruments` | M | yes | yes | never deleted (retire) | staff |
| 9 | `instruments.instrument_status` | E (state row, 1 per instrument) | yes | no | lives with instrument | device, API |
| 10 | `instruments.messages` | A (raw archive) | yes | no | `TenantSettings.retention.rawInstrumentYears` (C2; default 1, floor 1 year = 04 I8; 08 A13 D-42) | device, worker |
| 11 | `instruments.processing_runs` | A | yes | no | with message | device, staff, worker |
| 12 | `instruments.message_records` | A | yes | no | 90 days [CONV] (D-11), counted from the **message's** `received_at` so source and derived rows are purged together | device, staff, worker |
| 13 | `instruments.message_duplicates` | A | yes | no | 90 days | device |
| 14 | `instruments.message_rejections` | A | yes | no | 90 days | device |
| 15 | `instruments.attachments` | C (scan lifecycle columns only) | yes | yes | with message | device, worker |
| 16 | `instruments.observed_codes` | E (upsert counters) | yes | no | rows unseen for 400 days purged | device, worker |
| 17 | `instruments.settings` | M (1 row per tenant) | no (tenant; `__tenant` policies with `app.is_staff_or_system()`) | yes | never | staff |
| 18 | `instruments.event_inbox` | A (C0 platform table, IC §12) | — | — | 90 days | worker core |
| G1 | `instruments.g_drivers` | G | — | — | seed | migrations |
| G2 | `instruments.g_agent_releases` | G | — | — | seed | release pipeline seed (CR-C7-012) |
| G3 | `instruments.g_cs_revoke_reasons` | G coded set | — | — | seed | migrations |
| G4 | `instruments.g_cs_reprocess_reasons` | G coded set | — | — | seed | migrations |

### 1.1 Centre-scoping decision
Every tenant table except `settings` carries `centre_id NOT NULL` = the agent's centre (agents are bound to one centre — 04 A13 "one per device per centre"). Policies use the `__tenant_centre` template (02-CV §5.8). Effect: centre-scoped lab managers see only their centre's agents/instruments/messages; hub staff with `all_centres` see all; a **device actor** sees exactly its centre (`app.current_centre_ids()` returns its `centre_id` claim; `has_all_centres()` false — 02-CV §5.8), which is the database half of REQ-SEC-072 (the service also checks `agent_id`). C5's assumption (C5 05-SCHEMA §1) that bridge agents are bound to a processing branch's in-house centre is confirmed: agents are created only for centres of kind `own` or `franchise` (checked in the service; `centre_kind` is in `core` so it is not a CHECK here).

## 2. Columns

PHI class per 03-IC §1: P0 none · P1 ids · P2 lab-linked identifiers/personal data · P3 health data.

### 2.1 `agents`
| Column | Type | Null | Default / check | PHI |
|---|---|---|---|---|
| id, tenant_id, centre_id | uuid | no | — | P1 |
| agent_code | text | no | `^[A-Z0-9-]{2,32}$` | P0 |
| display_name | text | no | 1–80 | P0 |
| status | text | no | `pending_enrolment` · CHECK in (pending_enrolment, active, revoked, retired) | P0 |
| update_channel | text | no | `stable` · CHECK in (stable, beta) | P0 |
| pinned_release_id | uuid | yes | FK g_agent_releases | P0 |
| backlog_threshold | integer | yes | 10–100000 (NULL = tenant default) | P0 |
| enrolled_at | timestamptz | yes | | P0 |
| host_fingerprint_sha256 | text | yes | `^[0-9a-f]{64}$` (sha256 of machine GUID, from E01) | P1 |
| revoked_at / revoked_by | timestamptz / uuid | yes | | P1 |
| revoke_reason_code | text | yes | FK g_cs_revoke_reasons | P0 |
| revoke_reason_text | text | yes | ≤ 300 | P0 (free text: UI warns not to enter patient data) |
| retired_at / retired_by | timestamptz / uuid | yes | | P1 |
| latest_config_version | integer | no | 1, ≥ 1 | P0 |
| version, is_active, created_*, updated_* | mandatory M | | | |

### 2.2 `agent_credentials`
| Column | Type | Null | Notes |
|---|---|---|---|
| id, tenant_id, centre_id, agent_id | uuid | no | FK (tenant_id, agent_id, centre_id) → agents |
| kind | text | no | CHECK (enrolment_code, device_token) |
| secret_sha256 | bytea | no | 32 bytes; **UNIQUE** (global — collisions impossible at 128/256 bits; global uniqueness lets the resolver find a credential before tenant context); no SELECT grant to `lims_app` (CR-C7-006) |
| status | text | no | CHECK (active, used, expired, revoked) |
| issued_at, issued_by | timestamptz, uuid | no | issued_by = user (code) or agent id (token) |
| expires_at | timestamptz | yes | required for enrolment codes (CHECK) |
| used_at | timestamptz | yes | enrolment codes |
| last_used_at | timestamptz | yes | device tokens (touch ≤ every 300 s) |
| revoked_at, revoked_by, revoke_reason_code | | yes | |
| replaced_by_credential_id | uuid | yes | self FK (tenant_id, id) |
| version, created_*, updated_* | | | |

Mutable columns (trigger `enforce_mutable_columns`): `status, used_at, last_used_at, revoked_at, revoked_by, revoke_reason_code, replaced_by_credential_id, updated_at, updated_by, version`. Status transitions per 03-APP-FLOW §2.3 enforced by trigger `instruments.tg_credential_transition()`.

### 2.3 `agent_status` (PK (tenant_id, agent_id))
health_state text CHECK (online, offline, backlog, degraded) default `offline`; health_version int ≥ 1 default 1; state_changed_at timestamptz; silent_instrument_ids uuid[] default '{}'; last_heartbeat_at timestamptz null; agent_version text ≤ 32; launcher_version ≤ 32; os_version ≤ 64; queue_depth int ≥ 0 default 0; oldest_pending_age_seconds int ≥ 0 default 0; queue_rejected int default 0; queue_oversize int default 0; disk_free_mb int null; clock_offset_ms int null; clock_offset_uncertainty_ms int null; config_version_applied int null; config_state text null CHECK (ok, signature_invalid, agent_mismatch, rollback_rejected, schema_invalid); update_state text null CHECK (idle, downloading, verifying, staged, applying, rolled_back, verify_failed, failed); update_target_version ≤ 32; update_error_code ≤ 64; auth_state text null CHECK (ok, rejected); last_ip inet null (P1); last_ip_changed_at timestamptz; counters jsonb default '{}' (CHECK object, ≤ 2 KB); centre_id; created_*, updated_*. PHI P0/P1.

### 2.4 `agent_health_transitions`
id, tenant_id, centre_id, agent_id, health_version int, from_state text null, to_state text, changed_at timestamptz, last_heartbeat_at timestamptz null, queue_depth int, clock_offset_seconds int null, silent_instrument_ids uuid[], event_id uuid (published envelope id), created_at, created_by. P0.

### 2.5 `agent_config_versions`
id, tenant_id, centre_id, agent_id, config_version int, document jsonb (P0/P1: ids, ports, IPs, paths — **no secrets**), canonical_sha256 text, signature text, key_id text ≤ 32, issued_at timestamptz, reason text CHECK (agent_created, instrument_changed, agent_changed, release_changed, settings_changed), created_at, created_by. UNIQUE (tenant_id, agent_id, config_version).

### 2.6 `agent_commands`
id, tenant_id, centre_id, agent_id, kind text CHECK (upload_logs, refresh_config, restart_service, reupload_since), params jsonb default '{}' (only `{since}`), state CHECK (queued, delivered, completed, failed, expired), requested_by uuid, requested_at, delivered_at, completed_at, result_code ≤ 64, expires_at, version, created_*, updated_*. Mutable: state, delivered_at, completed_at, result_code, updated_*, version.

### 2.7 `agent_log_bundles`
id, tenant_id, centre_id, agent_id, command_id, lines text[] (CHECK cardinality ≤ 20000), from_at_agent, to_at_agent timestamptz, size_bytes int, created_at, created_by. P0 by construction (agent redaction; server re-runs the logger denylist scrubber on ingest and drops lines that still match a PHI pattern, counting them).

### 2.8 `instruments` (table name `instruments.instruments`)
| Column | Type | Null | Default / check | PHI |
|---|---|---|---|---|
| id, tenant_id, centre_id, agent_id | uuid | no | FK (tenant_id, agent_id, centre_id) → agents | P1 |
| instrument_code | text | no | `^[A-Z0-9-]{2,32}$`, UNIQUE (tenant_id, instrument_code) | P0 |
| display_name | text | no | 1–80 | P0 |
| vendor, model | text | no | ≤ 60 | P0 |
| serial_no | text | yes | ≤ 60 | P0 |
| software_version | text | yes | ≤ 40 | P0 |
| protocol | text | no | CHECK (astm, hl7v2, file_drop) | P0 |
| driver_code | text | no | FK g_drivers(code) | P0 |
| transport | jsonb | no | CHECK object; `transport->>'kind'` in (serial, tcp_client, tcp_server, file_drop); protocol = file_drop ⇔ kind = file_drop (CHECK); full schema validated in app (02-TRD §5.8) | P0 |
| protocol_options | jsonb | no | '{}' object | P0 |
| parser_options | jsonb | no | '{}' object | P0 |
| file_drop | jsonb | yes | object; NULL when protocol = file_drop (config in transport) | P0 |
| cap_host_query | boolean | no | false | |
| cap_worklist_download | boolean | no | false; CHECK = false while no `verified` driver declares `worklistDownload` (B2). Constraint `instruments__worklist_blocked__ck` is dropped only in the migration that promotes a driver with `cap_worklist_download = true` (06 §4). `LabPort.listPendingForInstrument` (CR-C7-005) already exists in 03-IC §4.5 | |
| qc_sample_id_patterns | text[] | no | '{}', cardinality ≤ 10 | P0 |
| timezone | text | no | ≤ 64 (IANA; app sets tenant default) | P0 |
| silence_window_minutes | integer | yes | 15–1440 | |
| silence_active_from / _to | time | yes | both or neither | |
| state | text | no | `draft`; CHECK (draft, commissioning, live, suspended, retired) | |
| commissioned_at, live_at, live_by, suspended_at, retired_at | | yes | | P1 |
| go_live_checklist | jsonb | yes | object with the 4 booleans + evidence_note (≤ 2000) | P0 |
| state_reason_text | text | yes | ≤ 300 | P0 |
| version, is_active, created_*, updated_* | | | | |

### 2.9 `instrument_status` (PK (tenant_id, instrument_id))
centre_id, agent_id, link_state text null CHECK (up, down, listening, connecting, error, disabled), last_link_error_code ≤ 64, last_message_at timestamptz (server), last_message_at_agent timestamptz, instrument_clock_offset_seconds int, silent_since timestamptz, messages_last_interval int, updated_at, updated_by. P0.

### 2.10 `messages` (raw archive)
| Column | Type | Null | Notes | PHI |
|---|---|---|---|---|
| id, tenant_id, centre_id, instrument_id, agent_id | uuid | no | FK (tenant_id, instrument_id, centre_id) → instruments; FK (tenant_id, agent_id, centre_id) → agents; UNIQUE (tenant_id, id, centre_id) (parent of the centre-bound child FKs) | P1 |
| agent_message_id | uuid | no | UNIQUE (tenant_id, agent_id, agent_message_id) | P1 |
| protocol | text | no | CHECK (astm, hl7v2, file_drop) | |
| message_kind | text | no | CHECK (data, incomplete, host_query, attachment) | |
| message_key | text | no | 1–220 (MSH-10 ≤ 199 + `:` + 16 hex = 216; `raw_sha256:agent_message_id` = 101); UNIQUE (tenant_id, instrument_id, message_key) | P1 (MSH-10 or hash) |
| message_key_kind | text | no | CHECK (msh10, msh10_reused, sha256, sha256_repeat) — `sha256_repeat` = a byte-identical host query re-sent under a new `agent_message_id` (02-TRD §6.6) | |
| message_control_id | text | yes | ≤ 199 (HL7 MSH-10) | P1 |
| raw_bytes | bytea | no | ≤ 1,048,576 octets (CHECK); for file_drop = canonical JSON capture metadata | **P3 + P2** (may contain names, barcodes, results) |
| raw_sha256 | text | no | `^[0-9a-f]{64}$` | P1 |
| size_bytes | integer | no | | |
| captured_at_agent | timestamptz | no | agent wall clock | |
| agent_clock_offset_ms | integer | no | | |
| captured_at | timestamptz | no | corrected (02-TRD §5.9) | |
| received_at | timestamptz | no | server, `now()` of the tx | |
| link_meta | jsonb | no | '{}' (counts only) | P0 |
| warnings | text[] | no | '{}' (codes only) | P0 |
| created_at, created_by | | | created_by = agent id (device) or system actor | |

Class A: no UPDATE, no DELETE grant to `lims_app`. TOAST compresses `raw_bytes` (REQ-ARCH-062 "compressed"); `ALTER COLUMN raw_bytes SET COMPRESSION lz4` only if the pinned image supports lz4 (C0 checks), else default pglz.

### 2.11 `processing_runs`
id, tenant_id, centre_id, message_id (FK (tenant_id, message_id, centre_id) → messages), run_no int ≥ 1 (UNIQUE (tenant_id, message_id, run_no)), kind CHECK (live, reprocess, rematch, attachment_scan), driver_code, driver_version ≤ 32, outcome CHECK (parsed, shadow, quarantined, rejected_capability), error_code ≤ 64, error_reason text ≤ 200 (no PHI — driver reason codes), patient_records, qc_records, calibrator_records, host_query_records, unmapped_records, skipped_no_barcode_records, emitted_events, skipped_records (ints ≥ 0; set once at insert — the run is inserted after its records' outcomes are computed, 02-TRD §6.4), reason_code (FK g_cs_reprocess_reasons, required when kind ∈ reprocess/rematch), reason_text ≤ 300, actor_type text, created_at, created_by. P0/P1.

### 2.12 `message_records`
id, tenant_id, centre_id, message_id (FK (tenant_id, message_id, centre_id) → messages), run_id (FK processing_runs), instrument_id (FK (tenant_id, instrument_id, centre_id) → instruments), record_seq int, record_class CHECK (patient, qc, calibrator, host_query, other), sample_barcode text ≤ 40 (**P2**), control_id_raw ≤ 64, control_lot_raw ≤ 64, control_level ≤ 16 (for `calibrator` records `control_id_raw`/`control_lot_raw` hold the calibrator id/lot [CONV: no separate columns; the calibration event payload maps them to `calibrator_id_raw`/`calibrator_lot_raw`]), record_kind CHECK (quantitative, qualitative, ordinal, text, organism_id, ast, attachment) null, instrument_analyte_code ≤ 64, mapping_status CHECK (mapped, unmapped) null, analyte_id uuid null, test_id uuid null (opaque copies), value_raw ≤ 200 (**P3**), value_numeric text (DecimalString pattern) null, unit_raw ≤ 32, instrument_flags text[] (≤ 20), instrument_result_time timestamptz null, instrument_clock_offset_seconds int null, is_rerun boolean null, organism jsonb null, ast jsonb null (P3), result_key_sha256 text null, emit_status CHECK (emitted, duplicate_event, shadow, skipped_no_barcode, skipped_invalid, not_applicable, pending_scan, quarantined_attachment), event_id uuid null, port_outcome CHECK (applied, duplicate, unmatched, rejected_state, held) null, port_reason_code ≤ 64, port_result_id uuid null, source_record_id uuid null (self FK; source and derived rows always share `message_id`, so the by-message purge removes them in one statement), detail jsonb default '{}' (host-query answer status/test count; ≤ 2 KB), warnings text[], created_at, created_by. Class A (re-match creates new rows).

### 2.13 `message_duplicates`
id, tenant_id, centre_id, agent_id, instrument_id, original_message_id (FK (tenant_id, original_message_id, centre_id) → messages), agent_message_id, reason CHECK (agent_message_id, message_key), received_at, created_at, created_by. P1.

### 2.14 `message_rejections`
id, tenant_id, centre_id, agent_id, claimed_instrument_id uuid (no FK — may be invalid), agent_message_id, reason_code ≤ 64 (CHECK in instruments.instrument_unknown, instruments.device_mismatch, instruments.message_too_large), raw_bytes bytea null (stored only for device_mismatch/instrument_unknown, ≤ 1 MiB; **P3+P2**), raw_sha256, size_bytes, received_at, created_at, created_by.

### 2.15 `attachments`
id, tenant_id, centre_id, message_id (UNIQUE; FK (tenant_id, message_id, centre_id) → messages), instrument_id, bucket text (`instruments-attachments`), object_path text ≤ 512 (CHECK first segment = tenant_id::text — `split_part(object_path,'/',1) = tenant_id::text`), sha256 hex64, mime_type CHECK (application/pdf, image/png, image/jpeg), size_bytes ≤ 15,728,640 (15 MiB per 02-CV §10.2 "15 MB" [CONV binary interpretation]), original_file_name ≤ 255 (**P2** — may contain barcode), scan_state CHECK (pending, clean, quarantined, failed), scan_attempts int, scanned_at, version, created_*, updated_*. Mutable: `object_path, scan_state, scan_attempts, scanned_at, sha256, updated_*, version` (sha256 updated after PDF sanitisation). Transition trigger per 03-APP-FLOW §2.6.

### 2.16 `observed_codes` (PK (tenant_id, instrument_id, record_class, instrument_analyte_code))
record_class CHECK (patient, qc, calibrator); centre_id, first_seen_at, last_seen_at, seen_count bigint, last_mapping_status CHECK (mapped, unmapped), last_analyte_id uuid null, last_mapping_checked_at, updated_at, updated_by. P0 (codes, counts).

### 2.17 `settings` (PK (id), UNIQUE (tenant_id))
Raw-archive retention is **not** a C7 setting: it is `TenantSettings.retention.rawInstrumentYears` (C2, read through `IdentityPort.getTenantSettings`; 08 A13 D-42). default_backlog_threshold 10–100000 default 500; backlog_max_oldest_pending_seconds 60–86400 default 900; clock_offset_warn_seconds 30–3600 default 300; agent_uploaded_retention_hours 1–72 default 24; update_window_from / update_window_to time null (both or neither); id, version, is_active, created_*, updated_*. Row created lazily by the service on first read (defaults) — insert under staff/system ctx.

### 2.18 Global tables
- `g_drivers`: code text PK (`^[a-z0-9_]{3,64}$`), display_name, protocol CHECK, vendor ≤ 60 null, model_pattern ≤ 120 null, status CHECK (generic, verified, sketch_blocked), driver_version ≤ 32, cap_host_query, cap_worklist_download, cap_qc, cap_attachments, cap_calibration boolean (all default false; `cap_calibration` true only for a `verified` driver whose official manual classifies calibrator records — B2; CHECK `cap_calibration = false OR status = 'verified'`), manual_title ≤ 200 null, manual_document_id ≤ 100 null, manual_revision ≤ 40 null, manual_software_version ≤ 40 null, CHECK (status <> 'verified' OR manual_document_id IS NOT NULL), is_active, created_at.
- `g_agent_releases`: id uuid PK, version text UNIQUE (`^[0-9]+\.[0-9]+\.[0-9]+$`), channel CHECK (stable, beta), package_file_name ≤ 120, package_sha256 hex64, package_size bigint, signature text (base64url Ed25519), key_id ≤ 32, authenticode_publisher ≤ 200, min_windows_build int null, released_at, is_active, notes ≤ 2000, created_at.
- `g_cs_revoke_reasons` (02-CV §5.5 columns): seed `device_replaced`, `device_lost_or_stolen`, `suspected_compromise`, `decommissioned`, `staff_error`, `other` [CONV].
- `g_cs_reprocess_reasons`: seed `driver_fixed`, `mapping_added`, `quarantine_reviewed`, `barcode_keypad_error`, `barcode_label_misread`, `instrument_resent_wrong_id`, `other` [CONV].

G tables: RLS-exempt (listed in `db/tests/rls_exempt.txt` — "global reference, no tenant data"), SELECT to `lims_app`.

Seed `g_drivers` (synthetic, v1):

| code | protocol | status | caps (hq, wl, qc, att, cal) | manual |
|---|---|---|---|---|
| `astm_generic_e1394` | astm | generic | f, f, t, f, f | — |
| `hl7v2_generic_oru` | hl7v2 | generic | f, f, t, f, f | — |
| `file_drop_generic` | file_drop | generic | f, f, f, t, f | — |
| `mindray_bc5380_sketch` | hl7v2 | sketch_blocked | t, f, f, f, f | — (B2) |
| `mindray_bs200_sketch` | hl7v2 | sketch_blocked | t, f, f, f, f | — (B2) |

## 3. Indexes (each serves a query in 02-TRD)

| Index | Query |
|---|---|
| `agents__tenant_id_agent_code__uq` | E11 uniqueness |
| `agents__tenant_id_centre_id_status__idx` | E10 list |
| `agents__tenant_id_id_centre_id__uq` | composite FK parent |
| `agent_credentials__secret_sha256__uq` (global) | resolver |
| `agent_credentials__tenant_id_agent_id_status__idx` | revoke all active; detail |
| `agent_credentials__active_code__p_idx` on (tenant_id, agent_id) WHERE kind='enrolment_code' AND status='active' | revoke earlier codes |
| `agent_status__tenant_id_health_state__idx` | E10 filter; evaluator |
| `agent_health_transitions__tenant_id_agent_id_changed_at__idx` (DESC) | E19 |
| `agent_config_versions__tenant_id_agent_id_config_version__uq` | E02 latest |
| `agent_commands__tenant_id_agent_id_state__idx` | heartbeat delivery; E18 |
| `agent_commands__expiry__p_idx` (tenant_id, expires_at) WHERE state IN ('queued','delivered') | expiry cron |
| `agent_log_bundles__tenant_id_agent_id_created_at__idx` | E20; purge |
| `agent_log_bundles__tenant_id_command_id__idx` | FK check during purge (deleting `agent_commands`) |
| `instruments__tenant_id_instrument_code__uq` | uniqueness |
| `instruments__tenant_id_id_centre_id__uq` | FK parent |
| `instruments__tenant_id_agent_id_state__idx` | config build; retire guard; evaluator |
| `instruments__tenant_id_centre_id_state__idx` | E23 |
| `messages__tenant_id_agent_id_agent_message_id__uq` | agent-key dedupe |
| `messages__tenant_id_instrument_id_message_key__uq` | 04 N10 message dedupe |
| `messages__tenant_id_centre_id_received_at__idx` (received_at DESC) | E33 |
| `messages__tenant_id_instrument_id_received_at__idx` (DESC) | E33 by instrument |
| `messages__tenant_id_received_at__idx` | purge, v_pub_message_daily |
| `messages__tenant_id_id_centre_id__uq` (constraint) | parent of the centre-bound FKs from runs, records, duplicates, attachments |
| `processing_runs__tenant_id_message_id_run_no__uq` | latest run (lateral, `ORDER BY run_no DESC LIMIT 1`) |
| `message_records__tenant_id_message_id_run_id__idx` | E35 |
| `message_records__tenant_id_sample_barcode__p_idx` (tenant_id, sample_barcode, created_at DESC) WHERE sample_barcode IS NOT NULL | E34 |
| `message_records__tenant_id_result_key_sha256__p_idx` WHERE result_key_sha256 IS NOT NULL | reprocess lookups |
| `message_records__tenant_id_run_id__idx` | FK check during purge (deleting `processing_runs`) |
| `message_records__tenant_id_source_record_id__p_idx` WHERE source_record_id IS NOT NULL | FK check during purge (self FK); re-match history |
| `message_duplicates__tenant_id_received_at__idx`, `message_rejections__tenant_id_received_at__idx` | E42, purge, view |
| `message_duplicates__tenant_id_original_message_id__idx` | FK check during purge (deleting `messages`); by-message duplicate purge |
| `attachments__tenant_id_scan_state__p_idx` WHERE scan_state IN ('pending','failed') | worker |
| `observed_codes__tenant_id_instrument_id_status__idx` (tenant_id, instrument_id, last_mapping_status) | E32 |

`tenant_id` leads every index and unique constraint except the global `secret_sha256` unique index — **stated reason**: the credential must be found before any tenant is known (C0 05-SCHEMA §9 rule 2 allows a non-tenant-leading index with a reason).

## 4. Immutability, triggers, audit
- `enforce_mutable_columns` on `agent_credentials` (§2.2 list), `attachments` (§2.15), `agent_commands` (§2.6), `agents` (all except `id, tenant_id, centre_id, agent_code, created_*`), `instruments` (all except `id, tenant_id, centre_id, agent_id, instrument_code, protocol, created_*`).
- Transition triggers: `instruments.tg_agent_transition`, `tg_instrument_transition`, `tg_credential_transition`, `tg_command_transition`, `tg_attachment_transition` (allowed pairs from 03-APP-FLOW §2; violation → `P0001` `invalid_transition` → mapped by the module to `409 instruments.invalid_transition`). INVOKER, `SET search_path = ''`.
- `tg_row_audit` excludes column `secret_sha256` from `old_values`/`new_values` (C0 trigger argument list of excluded columns — if C0's trigger has no exclusion parameter this is part of CR-C7-006).
- A-class tables get no UPDATE/DELETE grants; CI assertion 02-CV §5.6.

## 5. RLS policies, grants and DEFINER functions

Template (02-CV §5.8) for every centre-scoped table `T` in §1 rows 1–16:

```sql
ALTER TABLE instruments.T ENABLE ROW LEVEL SECURITY;
ALTER TABLE instruments.T FORCE ROW LEVEL SECURITY;
CREATE POLICY T__select__tenant_centre ON instruments.T FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY T__insert__tenant_centre ON instruments.T FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id())
              AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
-- `::uuid[]` cast: without it PostgreSQL parses `= ANY ((SELECT …))` as `= ANY (subquery)` and fails with
--   "operator does not exist: uuid = uuid[]" (verified on PostgreSQL 16, review fix pass 2026-11-06; the same
--   text in 02-CV §5.8 is handed off to the program-doc owner). The cast keeps the per-statement InitPlan caching.
-- UPDATE policy (USING + WITH CHECK, same predicate) only on: agents, agent_credentials, agent_status,
--   agent_commands, instruments, instrument_status, attachments, observed_codes
-- no DELETE policy TO lims_app on any table (the purge runs as lims_owner through app.purge_instruments_archive)
```

`settings` (tenant-only table; 02-CV §5.8 `__tenant` variant **with** `app.is_staff_or_system()` — CR-C13-011 rule; review #15):

```sql
ALTER TABLE instruments.settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE instruments.settings FORCE ROW LEVEL SECURITY;
CREATE POLICY settings__select__tenant ON instruments.settings FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY settings__insert__tenant ON instruments.settings FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY settings__update__tenant ON instruments.settings FOR UPDATE TO lims_app
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
-- no DELETE policy
```

Grants to `lims_app`:

| Table | Grants |
|---|---|
| agents, instruments, agent_commands, attachments, agent_status, instrument_status, observed_codes, settings | SELECT, INSERT, UPDATE |
| agent_credentials | INSERT (all columns), UPDATE (lifecycle columns), SELECT on all columns **except** `secret_sha256` (column-level grant, CR-C7-006) |
| agent_health_transitions, agent_config_versions, agent_log_bundles, messages, processing_runs, message_records, message_duplicates, message_rejections | SELECT, INSERT |
| g_* | SELECT |
| v_pub_* | SELECT (also `lims_analytics`) |

Owner-only policies and DEFINER functions (CR-C7-006; inventory rows for C0 05-SCHEMA §4.3). Binding rules applied (review fix pass 2026-11-06):
- **08 A10.5** — FORCE RLS applies to `lims_owner`, so every table a DEFINER below reads, joins or deletes has a `__<cmd>__owner_only` policy `TO lims_owner` with the narrowest USING clause the function needs. Policy scope name is `owner_only` (02-CV §5.8; review #28).
- **08 A12.1** — the pre-tenant resolver sets its GUCs inside the body with `set_config(…, true)`; names are `app.pre_*` (`app.pre_device_secret_sha256`, `app.pre_device_agent_id`), reset to `''` before returning.
- **08 A12.2 / A13** — cross-tenant or maintenance functions set `app.maintenance = '<function name>'` (`instruments_agent_state_snapshot`, `purge_instruments_archive`); the ad-hoc GUCs `app.instruments_metrics_snapshot` / `app.instruments_purge` are removed.
- Policies are `TO lims_owner` only, so a `lims_app` session that sets the same GUCs sees nothing (08 A12.7 test, §8 item 9).

```sql
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
```

Notes:
- The function no longer reads `instruments.settings` (D-42): the worker task reads `TenantSettings.retention.rawInstrumentYears` through `IdentityPort.getTenantSettings` and passes `p_raw_retention_days = rawInstrumentYears × 366` [CONV: 366 days per year so the archive is never kept less than the configured whole years; 1 year → 366 days ≥ the 365-day floor].
- The worker deletes the Storage object first (`ctx.storage.delete`, allowed by 08 A13 P-12 (b) — retention-expired object deleted by the owning module's purge task), then updates `attachments.object_path` to `<path>#deleted` (mutable column) under tenant context; only then can the row and its message be purged (step 2, next run at the latest).
- `agent_commands` rows that still have a log bundle wait until the bundle is purged (30 days < 90 days, so this only matters for bundles uploaded late).

## 6. Published views (03-IC §6.5 — exact columns)

```sql
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
```

Semantics: `unmatched` = C7-side unmatched records of the message's latest run = `unmapped_records` (mapping_status `unmapped`) + `skipped_no_barcode_records` (emit_status `skipped_no_barcode` with a mapped code, so no record is counted twice — 02-TRD §6.4). C5's barcode-matching outcome is C5's (`lab` views). All counts come from `processing_runs` counters (one body only; review #27), so the view is stable after the 90-day record purge. Business date uses the literal `Asia/Kathmandu` (08 A13 P-15: `TenantSettings.timezone` accepts only that value in v1); `core.tenants` is no longer joined.

## 7. DDL

```sql
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
-- RLS policies per §5 template (centre-scoped tables) and §5 `settings` block; owner_only policies, DEFINER functions
-- and their REVOKE/GRANT exactly as written in §5; views per §6.
```

## 8. Required DB tests (C0 `db/tests`, written with this DDL)
1. Tenant probe per table: tenant-A claims see 0 tenant-B rows; INSERT with B tenant fails; UPDATE affects 0 rows.
2. Centre probe: centre-A1 user and device-A1 claims see 0 rows of centre A2 in every table; device A1 cannot INSERT a `messages` row with `centre_id` A2 (RLS) nor with an A2 instrument (composite FK).
3. Composite FK: instrument with an agent of another centre → FK violation.
4. `lims_app` cannot `SELECT secret_sha256`; `has_table_privilege('lims_app','instruments.messages','UPDATE') = false` (and DELETE false) for every A table.
5. Resolver: returns a row only for active credentials; enrolment code past `expires_at` → 0 rows; device token of a revoked agent → 0 rows; after the call `app.pre_device_secret_sha256` and `app.pre_device_agent_id` are empty; calling with a random 32-byte value → 0 rows; owner policies return nothing when the GUC is unset.
6. Transition triggers: forbidden pairs raise `invalid_transition`.
7. Purge (**FORCE RLS on, never disabled on stand-in tables** — 08 A10.5): under tenant-A system claims `app.purge_instruments_archive(366)` deletes an expired row from every target table (non-empty `deleted` per table) and keeps younger rows; tenant-B rows of the same age are untouched; `p_raw_retention_days = 364` raises; a call without tenant claims raises; attachment rows (and their message) are kept until the path is marked `#deleted`; a message 89 days old with a re-match-derived record and a 90-day-old message with its source + derived records are purged without an FK error (review #4).
8. Views are `security_invoker` and centre-filtered for a centre-scoped reader.
9. Owner policies (08 A12.7): for each DEFINER (a) it returns the expected rows under FORCE RLS; (b) a `lims_app` session that sets `app.pre_device_secret_sha256`, `app.pre_device_agent_id` or `app.maintenance` itself sees 0 rows of `agent_credentials`/`agents`/`agent_status`/purge targets and can delete nothing; (c) all these GUCs are `''` after the function returns.
10. `has_function_privilege('lims_api', 'app.purge_instruments_archive(integer)', 'EXECUTE') = false` and the same for `lims_app` and `PUBLIC`; `lims_worker` true (review #3). Same check for the other two functions against their inventory rows.
11. Centre-bound FKs (review #26): inserting a `processing_runs`, `message_records`, `message_duplicates` or `attachments` row whose `centre_id` differs from its message's centre fails; a `message_records` row whose `instrument_id` belongs to another centre fails.
12. `settings` policies: a `partner`/`portal`/`patient` actor of the same tenant sees and writes 0 rows (`app.is_staff_or_system()`, review #15).
