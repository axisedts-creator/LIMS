# C7 Instrument Integration — 01 Product Requirements (PRD)

Status: DECISION, 2026-11-06. Chunk C7, Phase 1 (04 §12 "analyser import (upload for all interfaced instruments, bi-directional where supported, phased per driver)"). Deliverables: the Go bridge agent `apps/bridge-agent`, the API module `instruments` (schema, API module, worker jobs) and the web feature `instruments`.
Precedence: `research/00` > `research/04` > `program/03-INTERFACE-CATALOG.md` (03-IC) > `program/01-CHUNK-MAP.md` (01-CM) / `program/02-CONVENTIONS.md` (02-CV) > this file. Contract gaps are raised as CRs in `02-TRD.md` §16 and designed as if accepted (marked **(CR-C7-nnn)**).

Labels: **VERIFIED** (source named) · **UNVERIFIED** (code must not hard-depend on it) · **DECISION** (engineering choice made here; change by CR) · **[CONV]** (value chosen here, no external fact behind it) · **ASSUMPTION** (planning number to validate) · **BLOCKED (B#)** (build the default from `program/07-BLOCKERS.md`).

---

## 1. Purpose

The client asked that "results come directly from lab machines (no typing)" (00 C1) and for "7 instruments bi-directional interface including urine analyser and microbiology ID/AST system with graphs; picture and PDF import from results like HbA1c (HPLC), urine, allergy" (00 §3 item 3). Their fleet is "Autobio, Mindray, Getein, etc." with no model list (00 G4, BLOCKED B2).

C7 is the only part of the system that talks to analysers. It has three parts:

1. **Bridge agent** — a Go Windows service on a lab PC (04 S16). It speaks ASTM E1381/E1394 and HL7 v2 over MLLP (04 N1, N4, N5, N9) on serial or TCP links. It stores every received message in an encrypted local queue **before** acknowledging it (04 N11). It uploads in batches over outbound-only HTTPS (04 §4), relays host queries, captures result files from watched folders, sends heartbeats every 60 s, and updates its own configuration and binary only from signed packages (04 N11).
2. **API module `instruments`** — device-token-authenticated ingest (04 A13), two-level idempotency (04 N10), the raw message archive kept ≥ 1 year server-side (04 I8), the parser framework and driver registry, host-query answering through `LabPort.getPendingTestsForBarcode`, and the events `instruments.result.received.v1`, `instruments.qc.received.v1`, `instruments.calibration.received.v1` (verified drivers only, B2) and `instruments.agent.health_changed.v1` (03-IC §3.14–§3.16, §3.26).
3. **Web feature `instruments`** — instrument registry, agent fleet and health, the code-mapping screens that write C3's code maps through C3's HTTP API (03-IC X4), the message browser, and reprocess/re-match through `LabPort.ingestInstrumentResult` (03-IC X2).

C7 applies **no clinical rules**. It does not verify, flag ranges, or evaluate QC. C5 applies results (03-IC §4.5), C9 evaluates QC (Phase 2), C10 handles organism/AST records (Phase 2), C12 counts consumption and receives calibration events (Phase 2).

## 2. Users and roles

Role and permission codes are from 03-IC §11. Codes marked **(CR-C7-001)** are requested in `02-TRD.md` §16.

| Role (default) | What they do in C7 | Permissions used |
|---|---|---|
| `lab_manager` | Registers agents and instruments; issues enrolment codes; revokes devices; configures transports, drivers and monitoring; moves instruments through commissioning; edits code maps (through C3); sets module settings; reads the fleet and messages | `instruments.agent.read`, `instruments.agent.manage` (privileged), `instruments.instrument.read` (CR-C7-001), `instruments.instrument.manage` (privileged, CR-C7-001), `instruments.message.read`, `catalog.instrument_code_map.manage` (C3's), `catalog.test.read` (C3's, for analyte pickers) |
| `tenant_admin` | Same device-credential powers as lab manager (issue/revoke), fleet view | `instruments.agent.manage` (privileged), `instruments.agent.read` is **not** in its default grant (03-IC §11) → DECISION: tenant admins use the agent detail page only through a role that also holds `instruments.agent.read`; the default `tenant_admin` grant is not changed by C7 |
| `pathologist` | Sees instrument display names in C5 screens (C5 BFF reads E23) | `instruments.instrument.read` (08 A13 D-14: role added in 03-IC §11) |
| `lab_technologist` | Reads messages for troubleshooting; reprocesses quarantined messages; re-matches a record whose barcode was mistyped at the instrument keypad | `instruments.message.read`, `instruments.message.rematch`, `instruments.instrument.read` (CR-C7-001) |
| Device actor (bridge agent) | Enrols once, then uploads messages, heartbeats, host queries, attachments; reads its signed config and update packages | fixed device set (03-IC §11): `instruments.ingest.submit`, `instruments.ingest.heartbeat`, `instruments.ingest.host_query`, `instruments.ingest.config_read`, plus `instruments.ingest.enrol` (CR-C7-001) |
| System actor (worker) | Health evaluation, attachment scanning, archive purge, observed-code refresh | `instruments` worker manifest (02-CV §2.3); no `assertRole` calls are made by these tasks |
| The LIMS provider release engineer (outside the tenant) | Publishes signed agent releases through the release pipeline (C1) | none in the app; release rows are global seed data (05-SCHEMA §2.11) |
| Site installer (the LIMS provider or lab IT) | Runs the agent installer with administrator rights on the lab PC, pastes the enrolment code | local Windows administrator; no LIMS login needed |

## 3. Problems this chunk solves

1. **Typing results is slow and error-prone** (00 C1). Every interfaced analyser's results must reach C5 without re-keying.
2. **Lab internet is unreliable.** A result an analyser has sent must never be lost, even if the PC crashes or the line is down for days (04 N11; REQ-ARCH-057).
3. **Analyser protocols differ per model and the manuals are not in hand** (B2; 04 N6–N8 UNVERIFIED). The system must support ASTM and HL7/MLLP from day one (04 N1) and add a driver per model only when its official manual arrives — without changing the agent or the rest of the system.
4. **Analyser codes are not our analyte codes.** Mapping is catalog data (03-IC X4); C7 gives lab managers the screens to maintain it.
5. **Twenty or more unmanaged Windows PCs** (00 G3) must be monitored and updated remotely without RDP (REQ-ARCH-060/061).
6. **The agent PC is the weakest asset** (02-security §8 item 9). Tokens, queue data and updates must survive commodity malware and network tampering (REQ-SEC-114…123).
7. **Disputes and debugging need the original bytes** (REQ-ARCH-062): a ≥ 1-year raw archive server-side (04 I8).
8. **Pictures and PDFs** (HbA1c HPLC chromatograms, urine, allergy — 00 §3 item 3) must attach to results without promising automatic parsing (01 §3.5).

## 4. Scope

### 4.1 In scope (mapped to the client baseline)

| ID | Item | Baseline / source | Notes |
|---|---|---|---|
| IS-01 | Go bridge agent as a Windows service on Windows 10/11 or Server 2016+ | 00 C1; 00 §3 item 3; 04 S16 | Linux build deferred (04 S16) |
| IS-02 | ASTM E1381 low-level link layer written in-house (send + receive, checksum, frame numbers, 247-char frames, ENQ contention, timeouts, retransmits) | 04 N1, N4, N13; REQ-ARCH-051/055 | timer defaults are [CONV] configurable values taken from a vendor LIS1-A implementation used as reference only (08 A13 D-41; 02-TRD §5.2.4) |
| IS-03 | ASTM E1394 record tokeniser (H, P, O, R, C, Q, L, S, M) | 04 N5 | field positions UNVERIFIED → driver options |
| IS-04 | HL7 v2 over MLLP (receive and send; ACK original AA/AE/AR and enhanced CA/CE/CR) | 04 N9; REQ-ARCH-052 | |
| IS-05 | Serial (`go.bug.st/serial` v1.8.0) and TCP (client and LAN-listener) transports | 04 S16, T7 | |
| IS-06 | Encrypted local SQLite queue (WAL), persist-before-ACK, at-least-once batched upload (≤ 100 messages/request), backoff, local truncation after upload (≤ 72 h) | 04 N11, I8, §4; REQ-SEC-117 | |
| IS-07 | Heartbeat every 60 s, agent health states, `instruments.agent.health_changed.v1`, metrics for C1 | 04 N11; 03-IC §3.16, X6; REQ-ARCH-061; REQ-SEC-123 | |
| IS-08 | Clock-offset tracking (agent ↔ server, instrument ↔ server) | 04 N12; REQ-ARCH-059 | |
| IS-09 | Signed configuration and signed self-update (Authenticode + internal signature) with rollback | 04 N11; REQ-ARCH-060; REQ-SEC-119 | Authenticode certificate purchased and owned by the client (founder decision 2026-11-06, research/04 §13); held in the C1 secret store; the release pipeline applies it plus the internal Ed25519 signature (04 N11) |
| IS-10 | Installer and enrolment (one-time enrolment code → device token shown once, DPAPI storage), low-privilege service account | 04 A13; REQ-SEC-071/116/118 | |
| IS-11 | Local command-line status and diagnostics tool (no tray UI) | DECISION (04-UI-UX §2) | |
| IS-12 | Ingest API with device-token auth, ingest rate tier, message-level and result-level idempotency, quarantine of malformed input | 04 A13, §4, N10; REQ-SEC-121 | |
| IS-13 | Server-side raw message archive ≥ 1 year: retention = C2 tenant setting `retention.rawInstrumentYears` (default 1, floor 1 year) | 04 I8; REQ-ARCH-062; 08 A13 D-42 | legal period BLOCKED B15 (07-BLOCKERS B15 lists C7) |
| IS-14 | Parser framework, driver registry, generic ASTM and HL7 drivers, file-drop driver; vendor drivers only with official manuals | REQ-ARCH-053; 04 B2, N14 | Mindray sketches are illustrative and cannot go live |
| IS-15 | Host query (instrument asks for a barcode's tests) answered through `LabPort.getPendingTestsForBarcode` — only on instruments whose verified driver supports it | 00 §3 item 3; 04 N14; 03-IC §4.5 | |
| IS-16 | Worklist download capability flag | 01 §3.1 style 2 | BLOCKED B2: stays off while no `verified` driver declares `worklistDownload`; the port method `LabPort.listPendingForInstrument` (CR-C7-005) already exists in 03-IC §4.5 |
| IS-17 | QC records → `instruments.qc.received.v1` | 00 §3 item 16 (data part); 04 §12 "QC data capture" | QC marker per driver/config (UNVERIFIED per model) |
| IS-17a | Calibrator records → `instruments.calibration.received.v1` (consumer C12) — only from drivers whose official manual classifies calibrator records | CR-C12-006; 08 §4.10 | BLOCKED B2 per driver; generic drivers never emit it |
| IS-17b | Microbiology driver rule: isolate carried in `instrument_analyte_code` (`ORG:<n>`, `AST:<n>:<antibiotic>:<method>`, ≤ 64 chars) | CR-C10-007; 08 R13 (04 N10 key unchanged) | |
| IS-18 | Picture/PDF import via per-instrument watched folder | 00 §3 item 3; 01 §3.5 | DECISION (02-TRD §8) |
| IS-19 | Instrument registry with commissioning lifecycle (draft → commissioning/shadow → live → suspended → retired) | DECISION (03-APP-FLOW §2.2) | |
| IS-20 | Agent fleet and health UI | REQ-ARCH-061; REQ-SEC-123 | |
| IS-21 | Code-mapping UI writing C3 code maps through C3's HTTP API | 03-IC X4; 01-CM §3 | C3 owns the data |
| IS-22 | Message browser, audited raw view, reprocess and re-match through `LabPort.ingestInstrumentResult` | 03-IC X2; REQ-SEC-096 | |
| IS-23 | Simulator / replay harness and golden-file driver tests in CI | REQ-ARCH-064; 02-CV §11.1 | synthetic sessions only |
| IS-24 | Published views `instruments.v_pub_agent_status`, `instruments.v_pub_message_daily`, `instruments.v_pub_instrument_directory` (`tenant_id, instrument_id, centre_id, instrument_code, display_name, vendor, model, state, is_active`; consumers C8, C9, C12 — 08 R12d/§4.9) | 03-IC §6.5 | |
| IS-25 | Remote agent commands: upload logs, refresh config, restart, re-upload since a time | 03 §6.4 ("on-demand log upload"); DR (04 I2 RPO ≤ 15 min) | |
| IS-26 | User-manual pages and in-app help for every screen | 01-CM §2 (training note) | `docs/manual/instruments/` |
| IS-27 | Instrument graphics (histogram/scattergram) — "with graphs" | 00 §3 item 3; 08 A13 D-40 | BLOCKED B2 per model: payloads from a `verified` driver whose manual documents them are stored as `attachment`-kind records (PNG when sent as an image, otherwise kept as raw in the archive) and shown in the C7 message viewer; generic drivers extract none; printing on reports is a later C6 CR (02-TRD §6.3) |

### 4.2 Out of scope

| Item | Where it lives / why |
|---|---|
| Applying results to specimens, flags, delta, critical values, verification, the unmatched-result exception queue | C5 (03-IC §4.5; C5 US-14) |
| Code-map data model and `CatalogPort.mapInstrumentCode` | C3 (03-IC X4) |
| QC rules, Levey-Jennings, Westgard | C9 (Phase 2) |
| Organism/AST interpretation | C10 (Phase 2); C7 passes raw values as received (04 D14) |
| Consumption models | C12 (Phase 2) |
| Real-time reagent telemetry | DROP (01-CM §2; 04 §12, N15) |
| Automatic parsing of chromatogram PDFs into numbers | not promised (01 §3.5) |
| Label printing through the agent (ZPL) | not in Phase 1 (C5 02-TRD §4.6 notes it needs a C7 CR) |
| Linux agent | deferred (04 S16) |
| Mirth/NextGen or any middleware | banned/design reference only (04 T6; 02-CV §15.3) |
| Alert rules and dashboards | C1 consumes C7 metrics (03-IC X6) |
| Agent tray (GUI) application | DECISION: CLI only (04-UI-UX §2) |
| Instrument-embedded images (e.g. HL7 encapsulated data) | UNVERIFIED per model; added inside a vendor driver once a manual shows it |

## 5. User stories and acceptance criteria

Numbering: `AC-<story>.<n>`. Every criterion becomes at least one automated test (05-DoD §2) unless marked **[manual]** (needs real hardware).

### US-01 Register an agent and enrol a lab PC
As a lab manager I register a bridge agent for a centre and install it on the lab PC with a one-time code, so the PC can upload without anyone handling a long-lived secret.
- **AC-01.1** Given a lab manager with `instruments.agent.manage` at aal2, When they create an agent `{agent_code: "HUB-PC-01", display_name, centre_id}` for a centre of kind `own` or `franchise`, Then the agent exists with status `pending_enrolment` and no credential.
- **AC-01.2** Given a `home_collection` centre, When an agent is created for it, Then `400 common.validation_failed` with `errors[0].path = /centre_id` (08 A13 P-1).
- **AC-01.3** Given an agent, When the manager issues an enrolment code, Then the response contains the code exactly once (prefix `lmse_`, 128-bit random — 02-TRD §7.2), the database holds only its SHA-256, and the code expires after 24 h [CONV].
- **AC-01.4** Given a valid unexpired code, When the installer runs `bridge-agent install --server <url> --enrolment-code <code>` and the agent calls `enrolAgent`, Then the response contains a device token (prefix `lmsd_`, 256-bit — 04 A13) exactly once, the code becomes `used`, the token hash is stored, the agent becomes `active`, and the agent writes the token only DPAPI-encrypted (REQ-SEC-118).
- **AC-01.5** Given a used, expired or unknown code, When `enrolAgent` is called, Then `401 auth.device_token_invalid`, and the response is identical for all three cases.
- **AC-01.6** Given an enrolment code, When anything other than `enrolAgent` is called with it, Then `401 auth.device_token_invalid`.
- **AC-01.7** Given two agents in the same centre, Then each has its own token; revoking one does not affect the other (04 A13).

### US-02 Revoke and re-enrol
- **AC-02.1** Given an active agent, When the manager revokes it with a reason code from `instruments.g_cs_revoke_reasons`, Then all its credentials become `revoked`, the next call with the old token gets `401 auth.device_token_invalid`, and an `access_log` row `device_credential.revoke` exists (CR-C7-008).
- **AC-02.2** Given an active agent being moved to a new PC, When the manager issues a new enrolment code and the new PC redeems it, Then the previous device token is revoked in the same transaction (`replaced_by_credential_id` set) and the agent stays the same row (same `agent_id`, same instruments).
- **AC-02.3** Given a revoked agent, When the manager issues an enrolment code, Then it is allowed and redemption returns the agent to `active` (re-enrolment after investigation).
- **AC-02.4** Given an agent with active (not retired) instruments, When the manager retires it, Then `409 instruments.agent_has_active_instruments` (CR-C7-002).

### US-03 Register and configure an instrument
- **AC-03.1** Given a lab manager with `instruments.instrument.manage`, When they create an instrument with `instrument_code`, agent, driver, protocol and transport settings, Then it is created in state `draft` with `centre_id` equal to the agent's centre (composite FK).
- **AC-03.2** Given transport settings that fail the transport schema (e.g. serial baud not in the allowed list, TCP port outside 1–65535), Then `400 common.validation_failed` with JSON-Pointer paths.
- **AC-03.3** Given a driver whose capability `host_query` is false, When `capabilities.host_query = true` is saved, Then `422 instruments.capability_not_supported` (CR-C7-002).
- **AC-03.4** Given `capabilities.worklist_download = true`, Then `422 instruments.capability_not_supported` while no `verified` driver declares `worklistDownload` (B2) — BLOCKED default.
- **AC-03.5** Given any change to an instrument that the agent needs (transport, driver, protocol options, file-drop, capabilities, state), When saved, Then a new signed agent config version is created for that agent in the same transaction and the next heartbeat response announces it.
- **AC-03.6** Given a duplicate `instrument_code` or `agent_code` in the tenant, Then `409 instruments.code_duplicate` (CR-C7-002).

### US-04 Commission an instrument safely
- **AC-04.1** Given an instrument in `draft`, When "Start commissioning" is invoked, Then state `commissioning`; messages from it are archived and parsed but **no event is emitted** and the processing run outcome is `shadow`.
- **AC-04.2** Given an instrument in `commissioning` whose driver status is `generic` or `sketch_blocked`, When "Go live" is invoked, Then `422 instruments.driver_not_available` (B2: only `verified` drivers go live).
- **AC-04.3** Given a `verified` driver and a checklist with all four items `true` (`manual_reference_confirmed`, `sample_comparison_done`, `qc_comparison_done`, `mappings_reviewed`) and a non-empty `evidence_note`, When "Go live", Then state `live`, the checklist and actor are stored, and later messages emit events. Missing/false item → `422 instruments.go_live_checklist_incomplete` (CR-C7-002).
- **AC-04.4** Given `live`, When "Suspend" with a reason, Then messages keep being archived and parsed with outcome `shadow` (no events) until "Resume" returns it to `live`.
- **AC-04.5** Given any state, When an action not allowed by the state machine (03-APP-FLOW §2.2) is invoked, Then `409 instruments.invalid_transition` (CR-C7-002).
- **AC-04.6** Given an instrument in `draft` or `retired`, When the agent uploads a message for it, Then the per-message outcome is `rejected` with `instruments.instrument_unknown` and a row in `instruments.message_rejections`.

### US-05 Receive ASTM messages without loss
- **AC-05.1** Given the instrument sends `ENQ`, When the agent's queue is writable, Then the agent replies `ACK`; when the queue cannot be written (disk full, DB error), Then it replies `NAK`.
- **AC-05.2** Given a frame `STX FN text ETX|ETB C1 C2 CR LF` with a correct checksum and expected frame number, Then the agent appends the frame text to the session **in SQLite (committed, synchronous)** before sending `ACK`.
- **AC-05.3** Given a wrong checksum, unexpected frame number, missing CR LF, or a frame longer than 247 characters, Then the agent replies `NAK` and does not append.
- **AC-05.4** Given a retransmitted frame (same FN as the previous accepted frame), Then the agent replies `ACK` and does not append it twice.
- **AC-05.5** Given `EOT`, Then the session becomes one queue item whose raw content is the concatenated frame texts; `raw_sha256` is computed over exactly those bytes (golden vector 02-TRD §5.2.6).
- **AC-05.6** Given no frame for 30 s (receiver frame-wait timeout, configurable), Then the agent stores the partial session as an `incomplete` item (uploaded and quarantined server-side for diagnosis) and returns to neutral.
- **AC-05.7** Given the agent process is killed after it ACKed frame *n* and before `EOT`, When it restarts, Then frames 1…*n* are still on disk; if the instrument re-sends the whole message, the server dedupes by `(instrument_id, sha256(raw))` (04 N10). **[manual + automated kill test]**

### US-06 Send ASTM replies (host query) correctly
- **AC-06.1** Given an outbound message, Then the agent sends `ENQ`, waits up to 15 s, and on `ACK` sends frames with FN starting at 1 and incrementing modulo 8, each ≤ 247 characters with ≤ 240 text characters, records longer than 240 characters split into `ETB` frames ending with an `ETX` frame.
- **AC-06.2** Given `NAK` (or any character other than `ACK`/`EOT`) to a frame, Then the agent resends the same frame with the same FN; after the 6th unaccepted send it sends `EOT` and keeps the message for a later attempt.
- **AC-06.3** Given the agent's `ENQ` crosses the instrument's `ENQ` (contention), Then the agent yields: it goes neutral, accepts the instrument's message, and does not re-send `ENQ` for 20 s or until the instrument's message completes.
- **AC-06.4** Given no reply to `ENQ` within 15 s, Then the agent sends `EOT` (termination) and retries later; given `NAK` to `ENQ`, Then it waits 10 s before retrying.
- **AC-06.5** All timer values and the retransmit limit are per-instrument configuration with the defaults in 02-TRD §5.2.4.

### US-07 Receive HL7 v2 over MLLP
- **AC-07.1** Given bytes `0x0B <message> 0x1C 0x0D` over TCP, Then the agent extracts exactly `<message>`; bytes before `0x0B` are discarded and counted.
- **AC-07.2** Given an original-mode message (MSH-15/16 empty), When it is persisted, Then the agent replies with an ACK whose `MSA-1 = AA` and `MSA-2 = MSH-10` of the message.
- **AC-07.3** Given an enhanced-mode message (MSH-15 present), When persisted, Then the agent replies `MSA-1 = CA` (commit accept); when it cannot persist, Then `CR` (enhanced) or `AR` (original), and the message is not considered received.
- **AC-07.4** Given an MSH that cannot be parsed, Then no ACK is sent, the bytes are queued as an `incomplete` item and quarantined server-side.
- **AC-07.5** Given a message larger than 1 MiB [CONV], Then it is not ACKed, the connection is reset, and a local error counter increments (visible in `status` and heartbeat).

### US-08 Upload reliably through outages
- **AC-08.1** Given pending queue items, Then the uploader sends batches of ≤ 100 messages and ≤ 3 MiB [CONV] per request, each with an `Idempotency-Key`.
- **AC-08.2** Given network failure or `5xx`/`429`, Then the uploader retries with exponential backoff (1 s doubling to 5 min, ±20 % jitter [CONV]) and honours `Retry-After`.
- **AC-08.3** Given per-message outcomes `accepted`, `duplicate` or `quarantined`, Then the item becomes `uploaded`; given `rejected`, Then `rejected` (not retried until the agent's config version changes, then retried once); given `retry`, Then it stays `pending`.
- **AC-08.4** Given an item `uploaded` more than `uploaded_retention_hours` ago (default 24, max 72 — 04 I8), Then its row is deleted with `secure_delete` on; pending items are never deleted automatically.
- **AC-08.5** Given 9,000 pending messages (72 h at the 04 §14 upper volume of 3,000/day), When the link returns, Then the backlog drains in ≤ 15 min at the 04 §4 limit of 60 requests/min/device (arithmetic in 02-TRD §12).

### US-09 Ingest, dedupe, parse, archive and emit
- **AC-09.1** Given a batch of 101 messages, Then `413 instruments.batch_too_large` and nothing is stored.
- **AC-09.2** Given a message whose `(agent_id, agent_message_id)` was already accepted, Then outcome `duplicate`, no new archive row, a row in `instruments.message_duplicates`.
- **AC-09.3** Given an HL7 message with the same `(instrument_id, MSH-10)` and the same `raw_sha256` as an archived message, Then `duplicate` (04 N10). Given the same MSH-10 with a **different** `raw_sha256` (instrument reused a control id after restart — 06-GLOSSARY MSH-10), Then the message is archived as new with `message_key = MSH-10 + ":" + first 16 hex of raw_sha256` and a warning `control_id_reused`.
- **AC-09.4** Given an ASTM message with the same `(instrument_id, sha256(raw))` as an archived message, Then `duplicate`.
- **AC-09.5** Given a parseable patient-result message from a `live` instrument, Then in the request transaction: the archive row, a processing run (`kind = live`, `outcome = parsed`), one `message_records` row per result record, and one `instruments.result.received.v1` per record (03-IC §3.14) whose envelope `idempotency_key` is `<instrument_id>:<sample_barcode>:<instrument_analyte_code>:<instrument_result_time or 'none'>`.
- **AC-09.6** Given an instrument code without an active inbound map, Then the event is still emitted with `mapping_status: unmapped` and no `analyte_id`/`test_id`; with a map, Then `mapping_status: mapped` with both ids (`CatalogPort.mapInstrumentCode`, direction `inbound`).
- **AC-09.7** Given a message the driver cannot parse, Then outcome `quarantined` with `instruments.message_malformed`, the raw bytes archived, no event (REQ-SEC-121).
- **AC-09.8** Given a batch where one message fails with an unexpected error, Then only that message gets outcome `retry`; the others commit (per-message savepoint).
- **AC-09.9** Given a message for an instrument bound to another agent **of the same centre**, Then outcome `rejected` with `instruments.device_mismatch`; given an instrument of another centre or tenant (invisible under device RLS), Then `rejected` with `instruments.instrument_unknown`. Both write a `message_rejections` row in the device's centre; nothing is parsed (REQ-SEC-121).
- **AC-09.10** Given a message larger than 1 MiB raw, Then outcome `rejected` with `instruments.message_too_large` (CR-C7-002).
- **AC-09.11** Given the same batch re-sent with the same `Idempotency-Key`, Then the stored response is replayed with `Idempotent-Replayed: true` (02-CV §4.5).
- **AC-09.12** No log line, metric label or error `detail` contains a barcode, analyte value, or raw message content (02-CV §9.2) — log-scan test.

### US-10 Answer host queries
- **AC-10.1** Given a `live` instrument whose verified driver supports host query and `capabilities.host_query = true`, When the agent relays a query for barcode `E2600000042`, Then the server calls `LabPort.getPendingTestsForBarcode({ instrumentId, barcode })` under the device context and maps each returned analyte to its outbound instrument code via `CatalogPort.mapInstrumentCode` (direction `outbound`).
- **AC-10.2** Given `lab.specimen_not_found` or `lab.specimen_not_receivable`, Then the answer for that barcode has `status: not_found` / `not_receivable` and the driver builds its "no order" reply; given found tests but no outbound map for any of them, Then `status: no_mapped_tests`.
- **AC-10.3** Then the server returns the reply message(s) built by the driver; the agent frames and sends them to the instrument (ASTM: as a new transfer; HL7: MLLP).
- **AC-10.4** Given host query disabled for the instrument, Then `422 instruments.capability_not_supported` and the query message is archived with run outcome `rejected_capability`.
- **AC-10.5** Server-side handling p95 ≤ 500 ms (02-TRD §12) at reference load.
- **AC-10.6** Given the server is unreachable, Then the agent does not send an invented reply; it logs `host_query_unavailable` and the instrument falls back to its own behaviour (per driver profile; UNVERIFIED per model). The query item stays `pending` and is uploaded later in a batch as `kind = host_query`.
- **AC-10.7** Given E05 is retried with the same `agent_message_id` (no stored idempotent response), Then no second archive row is written, a `message_duplicates` row is added and the reply is rebuilt; given a byte-identical query under a new `agent_message_id`, Then it is archived as a new message with `message_key_kind = sha256_repeat` (no unique-constraint error). E05 requires an `Idempotency-Key` (08 A13 P-8).

### US-11 QC records
- **AC-11.1** Given a record the driver classifies as QC (driver rule, or the sample id matches one of the instrument's `qc_sample_id_patterns`), Then one `instruments.qc.received.v1` per QC observation (03-IC §3.15) and no `result.received` event for it.
- **AC-11.1a** Given a QC record without a control id (after the driver option `control_id_field`, default = the matched sample id) or with `value_raw` longer than 64 characters, Then the record is `skipped_invalid` and no event is published (03-IC §3.15 limits).
- **AC-11.2** QC idempotency key = `<instrument_id>:qc:<control_id_raw>:<instrument_analyte_code>:<instrument_result_time or sha256(raw)>`.
- **AC-11.3** Given a driver with `capabilities.calibration = true` (only `verified` drivers whose official manual classifies calibrator records) and a `live` instrument, When a record with `record_class = calibrator` is parsed, Then one `instruments.calibration.received.v1` (key `<instrument_id>:cal:<instrument_analyte_code>:<instrument_result_time or sha256(raw)>`) is published and no `result.received`/`qc.received` for it; generic drivers never emit it (B2).
- **AC-11.4** Given an AST message with two isolates carrying the same antibiotic, Then two records with `instrument_analyte_code` `AST:1:<ab>:<method>` and `AST:2:<ab>:<method>` and two distinct result keys are produced; a composite code > 64 chars → record `skipped_invalid` (CR-C10-007).

### US-12 Picture and PDF import (file drop)
- **AC-12.1** Given an instrument with `file_drop.enabled`, When a `.pdf`, `.png` or `.jpg` file appears in its folder and its size is unchanged for 5 s [CONV], Then the agent stores it encrypted in the queue with its SHA-256 and uploads it with `submitAttachment`.
- **AC-12.2** Given the file name matches the instrument's `barcode_regex` (named group `barcode`), Then the record carries that `sample_barcode`; otherwise the record has no barcode and no event is emitted until a technologist re-matches it (US-19).
- **AC-12.3** Given an upload whose magic bytes do not match an allowed type, or larger than 15 MB, Then `415 common.unsupported_media_type` / `413 common.payload_too_large` (02-CV §10.2).
- **AC-12.4** Given a clean malware scan, Then the object is stored under `instruments-attachments/{tenant_id}/{yyyy}/{mm}/{attachment_id}.{ext}` and one `instruments.result.received.v1` with `record_kind: attachment`, `protocol: file_drop` and `attachment {bucket, object_path, sha256, mime_type}` is emitted (03-IC §3.14 rules). Given a scan hit, Then `quarantined`, no event, security alert.
- **AC-12.5** The agent never deletes files from the folder unless `move_after_capture = true`; the same file (same path, size, mtime and sha256) is never uploaded twice; the server dedupes a re-dropped identical file by `file_sha256` (message key) even when its mtime changed.
- **AC-12.6** Given a `clean` attachment, When a user with `instruments.message.read` presses "Open", Then E37 streams the file through the API with `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`, `Cache-Control: no-store` and writes `access_log` `instrument_message.attachment_view`; given a non-clean attachment, Then `422 common.upload_quarantined`. No response, header or log contains a Storage URL (08 A13 P-2).

### US-13 Heartbeat and fleet health
- **AC-13.1** The agent sends a heartbeat every 60 s (04 N11) with version, queue depth, oldest pending age, disk free, clock offset, applied config version, update state and per-instrument link state.
- **AC-13.2** Given no heartbeat for > 180 s (3 intervals, 03-IC §3.16), When the evaluator runs, Then state `offline`, `health_version + 1`, one `instruments.agent.health_changed.v1` with `from_state`/`to_state`, and a row in `agent_health_transitions`.
- **AC-13.3** Given an online agent whose reported queue depth exceeds its `backlog_threshold` (default 500 [CONV]) or whose oldest pending item is older than 15 min [CONV], Then `backlog`.
- **AC-13.4** Given an online agent with ≥ 1 `live` instrument silent longer than its `silence_window_minutes` inside its active hours, Then `degraded` with `silent_instrument_ids`.
- **AC-13.5** Precedence: `offline` > `backlog` > `degraded` > `online`. No event is emitted when the computed state is unchanged.
- **AC-13.6** The gauge `lims_instruments_agent_state{tenant_id,centre_id,agent_id,state}` reports 1 for the current state and 0 for the other three for every non-retired agent, and `lims_instruments_agent_last_heartbeat_timestamp_seconds`, `…_queue_depth`, `…_clock_offset_seconds`, `…_silent_instruments` (labels `tenant_id,centre_id,agent_id`) and `lims_instruments_agent_info{…,agent_version}` are exported — names and labels as C1 02-TRD §11.2 (03-IC X6, CR-C1-003).

### US-14 Clock offset
- **AC-14.1** Every server response to the agent carries `server_time`; the agent estimates its offset as `server_time − (t_send + t_recv)/2` and reports it.
- **AC-14.2** Every uploaded message carries the agent capture time and the offset in force; the server stores `agent_received_at`, `captured_at` (= capture time corrected by the offset) and its own `received_at`.
- **AC-14.3** Given a message timestamp in the message (per driver), Then `instrument_clock_offset_seconds` = instrument time − `captured_at` (rounded) is put in the event and on the instrument status.
- **AC-14.4** Given |agent offset| > `clock_offset_warn_seconds` (default 300 [CONV]), Then the fleet UI shows a warning and the metric `lims_instruments_agent_clock_offset_seconds` exposes it for C1 alerting.

### US-15 Signed configuration and self-update
- **AC-15.1** Given a config document whose Ed25519 signature does not verify with a trusted key id, or whose `agent_id` differs, or whose `config_version` is lower than the applied one, Then the agent rejects it, keeps the current config, and reports `config_state: signature_invalid | agent_mismatch | rollback_rejected` in the next heartbeat.
- **AC-15.2** Given an update target, Then the agent downloads the package, checks size and SHA-256, the internal Ed25519 release signature, and the Authenticode signature and publisher of the contained `agent.exe` (WinVerifyTrustEx); any failure → not installed, `update_state: verify_failed`.
- **AC-15.3** Given a verified package, Then the launcher switches to it only when no link session is active for 60 s [CONV] and inside the tenant's update window if set; if the new version does not complete a heartbeat within 5 min [CONV] or crashes 3 times, Then the launcher rolls back and the agent reports `update_state: rolled_back`.
- **AC-15.4** The launcher refuses a lower version unless the signed config sets `allow_downgrade: true` for that target.
- **AC-15.5** Given a newly seeded active release on an agent's channel (or a pin to another release), When task `instruments.publish_release_configs` runs (≤ 15 min), Then a new signed config version with reason `release_changed` and `update.target` = that release's `{release_id, version, package_sha256, package_size, signature, key_id, authenticode_publisher}` exists for the agent; no change → no new version. Given E41 changes the update window, Then every non-retired agent of the tenant gets a config version with reason `settings_changed` and `update.window = {from, to, timezone}` in the same transaction (02-TRD §5.10).

### US-16 Fleet UI
- **AC-16.1** Given a user with `instruments.agent.read`, Then `/instruments/agents` lists agents of their centre scope with state chip (text + colour), last heartbeat, version, queue depth, clock offset, and a filter by state and centre.
- **AC-16.2** Given a user scoped to centre A1, Then agents of centre A2 are not listed and `/instruments/agents/{id of A2 agent}` shows "not found" (404 `common.not_found`).
- **AC-16.3** The agent detail page shows the health timeline (last 50 transitions), instruments with link state and last message time, credentials (kind, status, issued/used/revoked times — never secrets), and update state.

### US-17 Code mapping (through C3)
- **AC-17.1** Given a user with `catalog.instrument_code_map.manage`, Then `/instruments/instruments/{instrument_id}/mappings` lists the instrument's maps from C3 (`listInstrumentCodeMaps`) and the codes observed from this instrument with their current mapping status.
- **AC-17.2** Given an observed unmapped code, When the user picks a test and analyte and saves, Then C7's BFF calls C3 `createInstrumentCodeMap` with `{instrument_id, direction, instrument_code, analyte_id, test_id, unit_from_raw?, unit_to_code?, unit_factor?, flag_map?}`; C3 errors (`409 catalog.code_duplicate`, `400 common.validation_failed`, `403 auth.mfa_required` — `catalog.instrument_code_map.manage` is privileged, 08 A13 D-18) are shown on the form (step-up banner for the last).
- **AC-17.3** Given `catalog.changed.v1` with `entity_type: instrument_code_map`, Then C7 refreshes `last_mapping_status` of its observed codes for that tenant within 1 min (task `instruments.refresh_observed_code_mapping`).
- **AC-17.4** Given a user without `catalog.instrument_code_map.manage` who holds `instruments.instrument.read`, Then the mapping page shows only the observed-codes panel (read-only) and the text "Mappings are visible to users who can manage them"; the BFF does not call C3's code-map operations (08 A13 D-39). Without `instruments.instrument.read` → forbidden.

### US-18 Message browser and raw view
- **AC-18.1** Given a user with `instruments.message.read`, Then `/instruments/messages` lists messages by received time (range ≤ 31 days [CONV], default last 24 h) with filters instrument, agent, kind, status, has QC records (`has_qc`), has unmapped; barcode search is a `POST` body (no barcode in any URL — REQ-SEC-098).
- **AC-18.2** The detail page shows metadata, processing runs, parsed records (barcode, code, value, unit, flags, mapping status, event id) and, for a record whose port outcome is `unmatched` or `held`, a link to C5's instrument-exception list filtered by this instrument (route `staff.lab.ingest_exceptions?instrument_id=`, CR-C7-014); until that route is registered the row shows the text "Check the lab's instrument exceptions".
- **AC-18.3** When the user presses "Show raw", Then `getMessageRaw` returns the bytes and an `access_log` row `instrument_message.raw_view` is written in the same transaction (CR-C7-008).

### US-19 Reprocess and re-match
- **AC-19.1** Given a message whose latest run outcome is `quarantined`, `shadow` or `parsed` and a user with `instruments.message.rematch`, When "Reprocess" with a reason, Then a new processing run (`kind = reprocess`) parses the archived bytes with the current driver; for each patient record C7 calls `LabPort.ingestInstrumentResult` in the user's context and stores the outcome, then publishes `instruments.result.received.v1` (CR-C7-004 trigger) — consumers dedupe on the result-level key; and an `access_log` row `instrument_message.reprocess` is written in the same transaction.
- **AC-19.2** Given a record with a mistyped barcode, When "Re-match" with a corrected barcode and reason, Then a derived record (`source_record_id` set) is created with the new barcode; the port outcome is shown; the original record is unchanged; `access_log` `instrument_message.rematch`.
- **AC-19.3** Given an `approved` target, Then the outcome shown is `rejected_state` with reason `result_locked`, and no value changes (04 R1; 03-IC §4.5 contract test 8).
- **AC-19.4** Given a message of kind `host_query`, or of a `retired` instrument, Then `409 instruments.reprocess_not_allowed` (CR-C7-002).
- **AC-19.5** Given a corrected barcode equal to the original, Then `400 common.validation_failed`.

### US-20 Archive retention
- **AC-20.1** Given the tenant setting `retention.rawInstrumentYears` (C2; default 1, floor 1 — 04 I8; 08 A13 D-42), When the daily per-tenant purge runs, Then that tenant's messages older than `rawInstrumentYears × 366` days and their runs, attachment rows and Storage objects are deleted by the inventoried purge function (CR-C7-006), parsed records are deleted 90 days after their message was received (source and re-match-derived rows together), and nothing younger and nothing of another tenant is touched.
- **AC-20.2** Given a retention below 365 days reaching the purge function (e.g. a corrupted setting), Then the function raises and deletes nothing; the value itself is validated by C2 (floor 1 year).

### US-21 Simulator, replay harness and drivers
- **AC-21.1** CI runs every session file in `apps/bridge-agent/testdata/sessions/` against the agent link layers over an in-memory duplex and asserts the exact bytes the agent sends and the queue items it produces.
- **AC-21.2** CI runs every golden case in `services/api/src/modules/instruments/drivers/<driver>/testdata/` (`*.raw` → `*.expected.json`) and fails on any difference.
- **AC-21.3** Given a driver with status `sketch_blocked`, Then it can be selected only in non-production environments (`NODE_ENV ≠ production`), and never for a `live` instrument.
- **AC-21.4** All session and golden files are synthetic (barcodes like `E2600000042`, no names); a CI check rejects files containing name-like `P` record or `PID` content outside the allowed synthetic list.

### US-22 Local status for the site person
- **AC-22.1** `bridge-agent status` (as Administrator) prints service state, agent id, server reachability, last heartbeat result, queue counts by state, per-instrument link state, last error codes, config version, update state — and no PHI.
- **AC-22.2** `bridge-agent diagnostics --out <file>` writes a zip with status, redacted config (no token) and the last 7 days of logs; it contains no queue payloads.

### US-23 Worklist download (BLOCKED)
- **AC-23.1** While no `verified` driver declares `worklistDownload` (B2), `capabilities.worklist_download` cannot be enabled (AC-03.4) and no worklist endpoint is exposed to agents.

### US-24 Remote commands
- **AC-24.1** Given a manager requests `upload_logs`, Then the next heartbeat response carries the command; the agent uploads the last 24 h of redacted logs; the bundle is viewable for 30 days [CONV].
- **AC-24.2** Given `reupload_since` with a time *t* (≤ 72 h ago), Then the agent re-sends every retained item captured after *t*; server dedupe makes re-sent items `duplicate` unless the server lost them (e.g. after a restore — 04 I2 RPO ≤ 15 min).
- **AC-24.3** Commands not delivered within 24 h [CONV] expire.

## 6. Success metrics

| Metric | Target | Measured by |
|---|---|---|
| Messages lost (instrument ACKed but never archived server-side) | 0 | reconciliation test in commissioning (instrument count vs archive), `lims_instruments_ingest_messages_total` vs agent counters |
| Agent → archive latency when online | p95 ≤ 10 s [CONV] (uploader flushes every 2 s or at 100 messages) | `captured_at` → `received_at` histogram |
| Unexplained quarantine rate per live instrument | < 1 % of messages per week [CONV] | `lims_instruments_ingest_messages_total{outcome="quarantined"}` |
| Agent availability | ≥ 99 % of minutes `online` per agent per month during lab hours [CONV] | health transitions |
| Host-query answer (server side) | p95 ≤ 500 ms | `lims_instruments_host_query_duration_seconds` |
| Unmapped codes on live instruments 7 days after go-live | 0 | observed codes |
| Fleet on supported agent version | 100 % within 14 days of a release [CONV] | `v_pub_agent_status.agent_version` |

## 7. Phase

Phase 1 (04 §12; 01-CM §1 Wave 1). Delivered per driver: the platform (agent, ingest, generic drivers, simulator, UI) ships first; each real analyser goes live only when its official manual is in hand and on-site commissioning passes (04 N14; B2).

## 8. Dependencies (contracts only)

| Dependency | Kind | Used for |
|---|---|---|
| C0 core: deviceToken `AuthResolver`, `ctx.db.tx` savepoints, idempotency hook, `ingest` rate tier, `events.publish`, `ctx.audit.access`, `ctx.core.centre(s)` | core | everything |
| `LabPort.getPendingTestsForBarcode`, `LabPort.ingestInstrumentResult` (C5) | port | host query; reprocess / re-match (X2) |
| `LabPort.listPendingForInstrument` (CR-C7-005 ACCEPTED in 08; 03-IC §4.5) | port | worklist download (still BLOCKED B2, US-23) |
| `CatalogPort.mapInstrumentCode` (C3) | port | inbound mapping at parse; outbound codes for host query |
| C3 HTTP `listInstrumentCodeMaps`, `createInstrumentCodeMap`, `updateInstrumentCodeMap`, `upsertInstrumentCodeMaps`, `searchOrderables`, `getTestDetail`, `listUnits` | HTTP (BFF) | mapping UI (X4) |
| `IdentityPort.assertRole`, `IdentityPort.getTenantSettings` (`timezone`, `retention`) | port | authz; business dates; instrument default timezone; raw-archive retention (D-42) |
| `catalog.changed.v1` | event consumed | observed-code mapping refresh |
| C0 upload/scan/storage API `ctx.uploads`/`ctx.files.scan`/`ctx.storage` (CR-C2-011; 08 R12b) + streaming download helper (03-IC §13.6; 08 A13 P-2) + bucket `instruments-attachments` (CR-C7-007 as renamed by 08 R26) | core | file-drop attachments; downloads streamed through the API |
| C1: nginx edge limits for agent paths, secret store (signing keys), release file mount, metric scraping and alert rules (CR-C7-012) | infra | operations |
| C0-0A: CI jobs (Windows runner, gates, fixture checks — CR-C7-013, 08 A13 P-14) | infra | build and test gates |

## 9. Blocked items and the default built meanwhile

| # | What is blocked | Default built now |
|---|---|---|
| B2 | Every vendor driver (Autobio, Mindray, Getein, urine analyser, ID/AST, HPLC) — models and official LIS manuals | Generic ASTM, generic HL7 and file-drop drivers (status `generic`: commissioning/shadow only); Mindray drivers as `sketch_blocked` illustrations from UNVERIFIED secondary copies (04 N6/N7); simulator + golden-file harness so each driver is built and proven the day its manual arrives; host query and worklist off by default (04 N14) |
| B2 | Which fields each model sends (sample id field, result time, flags, QC markers, units) | Driver options with documented UNVERIFIED defaults; every event field except the required ones is optional (03-IC §3.14) |
| B15 | Legal retention of raw analyser data | C2 tenant setting `retention.rawInstrumentYears`, default 1, floor 1 year (04 I8; 08 A13 D-42; 07-BLOCKERS B15 "Affects" includes C7) |
| B11 | Any foreign service | none used: updates and config come only from the Nepal-hosted API (04 S1, §11) |
| (closed 2026-11-06) | Authenticode code-signing certificate | Authenticode certificate purchased and owned by the client (founder decision 2026-11-06, research/04 §13); held in the C1 secret store; the release pipeline applies it plus the internal Ed25519 signature (04 N11); production release gate requires the Authenticode signature (06 §7 R3) |
| (open) | Code-map data and real analyte codes | C3 synthetic catalog (B3); codes observed in shadow mode drive the mapping screen |
