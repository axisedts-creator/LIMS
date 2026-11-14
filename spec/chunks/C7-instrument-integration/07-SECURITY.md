# C7 Instrument Integration — 07 Security

Status: DECISION, 2026-11-06. REQ IDs from `research/02-security.md` (REQ-SEC) and `research/03-backend-architecture.md` (REQ-ARCH) are cited, not copied. Applies from Phase 1 (04 §12 rule).

## 1. Applicable requirements and how C7 meets them

| ID | Application in C7 |
|---|---|
| REQ-SEC-001/002 | ASVS L2 target; BOLA is the primary threat: every staff handler loads the object under RLS before `assertRole` with its `centre_id`; device handlers check `instrument.agent_id = actor` |
| REQ-SEC-011…016 | ENABLE + FORCE RLS on every `instruments` table, per-command policies `TO lims_app` (`settings` with `app.is_staff_or_system()`), no DELETE policy `TO lims_app`, no `USING (true)`; DELETE only through the purge DEFINER's narrow `__delete__owner_only` policies `TO lims_owner` (08 A10.5) (05-SCHEMA §5) |
| REQ-SEC-017 | centre-scoped tables; device actors limited to their centre by `app.current_centre_ids()` |
| REQ-SEC-019/020/021 | three DEFINER functions in `app`, `SET search_path = ''`, `REVOKE ALL … FROM PUBLIC` + EXECUTE to one role each, owner-only policies keyed to transaction-local GUCs set inside the function (`app.pre_*` — 08 A12.1; `app.maintenance = '<function name>'` — 08 A12.2) and reset before return; the purge acts on one tenant per call (CR-C7-006) |
| REQ-SEC-023/024/026/027 | tenant-leading indexes (one documented exception: `secret_sha256`), explicit tenant filters in repositories, composite FKs incl. `(tenant_id, id, centre_id)` to bind instruments/messages to the agent's centre |
| REQ-SEC-028 | UUIDv7 ids; no human numbers in URLs; barcodes only in POST bodies |
| REQ-SEC-031 | `v_pub_*` views `security_invoker` |
| REQ-SEC-034/035 | bucket `instruments-attachments` (08 R26), `{tenant_id}/…` paths, server-side access only; files reach browsers only by streaming through E37 — no Storage URL in any response, header or log (08 A13 P-2; CR-C7-007) |
| REQ-SEC-040/041/044 | cross-tenant + cross-centre + device probes for every operation and table (§6); synthetic tenants only |
| REQ-SEC-045/133 | metrics + alerts: auth failure spikes, config rejections, update failures, quarantine rate, attachment quarantine (02-TRD §13) |
| REQ-SEC-071 | device token ≥ 256-bit CSPRNG, shown once, SHA-256 stored, one per agent (each agent bound to one centre), individually revocable, `last_used_at` tracked |
| REQ-SEC-072 | device permission set = `instruments.ingest.*` only (+ `enrol`); no read of patient lists; host query returns only sex/age + test ids for the device's centre (C5); device cannot call any staff operation (security scheme differs) |
| REQ-SEC-078/079 | ingest tier 60 requests/min/device in the app (the real limit), ≤ 100 messages/request; nginx per-IP flood guard 600 r/m burst 200 on agent paths (CR-C7-012 as changed by 08 A13 D-43 — shared NAT); agent-side token bucket |
| REQ-SEC-080/081 | strict schemas (`additionalProperties: false`, max lengths, enums); mappers allowlist fields; `secret_sha256` and `raw_bytes` never serialised outside E36 |
| REQ-SEC-083/084/085 | attachments: `ctx.uploads.accept` (extension + magic bytes, 15 MB, PNG/JPEG re-encode stripping EXIF/GPS), scan + quarantine, PDF sanitise, streamed download with `Content-Disposition: attachment`, `nosniff`, `no-store` (E37) |
| REQ-SEC-095/098 | generic errors; no barcode/value/raw in logs, URLs, metrics labels or error details; `result_key_sha256` instead of the key |
| REQ-SEC-096/097 | `access_log` for raw view, attachment view, reprocess, re-match, credential issue/revoke (CR-C7-008; full call inventory 02-TRD §7.5, 08 A13 P-3); audit triggers on agents, credentials, instruments, commands, attachments, settings |
| REQ-SEC-099 | every route in the spec; no `x-public` operation in C7 (enrolment uses the device scheme) |
| REQ-SEC-114 | outbound-only HTTPS; no internet-side listener; LAN listeners only for `tcp_server` instruments bound to a LAN IP with a peer allowlist and an opt-in firewall rule; remote changes by polling (heartbeat/config) |
| REQ-SEC-115 | TLS ≥ 1.2, system roots, optional SPKI pins via signed config, no insecure fallback (CI grep gate), proxy failure never downgrades |
| REQ-SEC-116 | virtual service account (fallback LocalService), write access only to its data root; launcher in Program Files read-only to the service |
| REQ-SEC-117 | queue ACL'd, AES-256-GCM per row with DPAPI-wrapped key, `secure_delete`, truncation ≤ 72 h after upload; raw archive server-side ≥ 1 year (REQ-ARCH-062) |
| REQ-SEC-118 | device token DPAPI blob in `secrets\`, never plaintext config/registry |
| REQ-SEC-119 | Ed25519 internal signature + Authenticode publisher check, re-verified by the launcher, anti-rollback |
| REQ-SEC-120 | site network checklist (isolated segment, serial preferred); server-side plausibility stays in C5 (ranges/delta); C7 quarantines malformed input |
| REQ-SEC-121 | everything from agents treated as untrusted: schema, sizes, sha256 integrity, device↔instrument binding, timestamps stored as data (not trusted for ordering), per-device rate limit, malformed input quarantined with raw kept, rejections recorded |
| REQ-SEC-122 | lab PC baseline in the site runbook |
| REQ-SEC-123 | heartbeat, version, queue depth, upload failures, health states + alerts |
| REQ-SEC-128 | signing keys from the secret store; release key offline from API hosts |
| REQ-SEC-129 | `go.sum`, exact versions, SBOM per agent release, provenance of the build in CI (release pipeline) |
| REQ-SEC-136 | simulator/golden data synthetic; non-prod agents enrol only against non-prod APIs (installer refuses a production URL when built with the `nonprod` tag, and vice versa) |
| REQ-SEC-139 | raw-archive retention from the C2 tenant setting `retention.rawInstrumentYears` (floor 1 year, 08 A13 D-42); per-tenant purge function that refuses < 365 days |
| REQ-SEC-140 | revoke on PC replacement (automatic on re-enrolment A3) |
| REQ-ARCH-057…064 | persist-before-ACK, two-level dedupe, offsets, signed config/update, heartbeat/silence, archive, manual first verification downstream (C5), simulator harness |

## 2. Assets

| # | Asset | Why it matters |
|---|---|---|
| AS1 | Device tokens and enrolment codes | holder can inject results for a centre |
| AS2 | Agent local queue (PHI pending upload) | PHI on an unmanaged PC |
| AS3 | Raw archive and records (P3+P2) | names, barcodes, results of every patient |
| AS4 | Config and update channel | control of every lab PC in the fleet |
| AS5 | Signing keys (config, release) | forge AS4 |
| AS6 | Clinical integrity of results flowing to C5 | wrong value → wrong diagnosis |
| AS7 | Attachments | PHI documents; malware carrier |
| AS8 | Lab LAN analyser traffic | plaintext |

## 3. STRIDE per entry point

| Entry point | S | T | R | I | D | E |
|---|---|---|---|---|---|---|
| E01 enrol | guessing a code → 128-bit, 24 h, single use, uniform 401 | — | access_log on issue; enrolment time + host fingerprint visible | response contains a token: no idempotency storage, TLS | nginx per-IP + ingest tier | code only enrols the agent it was issued for |
| E04 batch / E05 host query / E06 attachment | stolen token → revocation, last IP change warning, DPAPI | forged results → bind check, centre RLS, sha256, C5 manual verification (04 R2) | every message archived with agent id, run actor | host query returns minimal fields; other centres invisible | 60/min, 100 msgs, 4 MiB, 8 s budget, 1 MiB/message | device permissions only |
| E02/E08 config + release | — | tampering in transit → TLS + signatures verified by agent | config versions stored | config has no secrets | — | config cannot change server URL |
| Staff E10–E42 | session via BFF (C0/C2) | If-Match, transition triggers | audit triggers, access_log | centre RLS, no barcodes in list DTOs/URLs, raw on demand | general tier, bounded ranges (31 days) | privileged ops need aal2 (`agent.manage`, `instrument.manage`) |
| Agent PC (local) | another local user reading the token → DPAPI + ACL | replacing the agent exe → launcher verification; launcher dir read-only | local logs (no PHI) | queue encrypted; status file has no PHI | disk fill → disk guard NAK | service account low privilege |
| LAN (instrument ↔ agent) | rogue device connecting to a listener → peer allowlist, bind IP | spoofed results on LAN → isolation checklist; C5 plausibility | archive keeps raw for disputes | plaintext sniffing → network segmentation (REQ-SEC-120) | flooding a listener → one connection per instrument, size caps | — |
| Worker tasks | — | — | run rows with system actor | — | scan retries bounded | DEFINER functions narrow |

## 4. Abuse cases

| # | Abuse | Expected result |
|---|---|---|
| AB1 | Attacker with tenant-A device token sends messages naming a tenant-B instrument id | `rejected instruments.instrument_unknown` (RLS invisible); nothing stored in B |
| AB2 | Device of centre A1 sends for an A2 instrument of the same tenant | `rejected instruments.instrument_unknown` (the A2 instrument is invisible under device RLS); `message_rejections` row in A1 (review #6) |
| AB2a | Device of agent X sends for an instrument of agent Y in the same centre | `rejected instruments.device_mismatch`; `message_rejections` row |
| AB3 | Device calls a staff endpoint (e.g. E33) with its token | `401` (scheme mismatch) |
| AB4 | Enrolment code used as a device token on E04 | `401 auth.device_token_invalid` |
| AB5 | Replay of a captured batch | idempotency replay / duplicates — no new events |
| AB6 | Malicious config pushed by MITM | signature fails → not applied; alert |
| AB7 | Downgrade to an old vulnerable agent | launcher refuses lower version without signed `allow_downgrade` |
| AB8 | Polyglot/EICAR attachment | quarantined, no event, alert, E37 → `422 common.upload_quarantined` |
| AB9 | Huge/fuzzed HL7/ASTM | size cap, quarantine with raw, no crash; savepoint isolation |
| AB10 | Lab tech enumerates barcodes via E34 | requires `message.read`, centre-scoped, ≤ 50 results; general rate tier; queries audited by request log (no barcode) — C2 access review |
| AB11 | User reprocesses to overwrite an approved result | C5 returns `rejected_state`; value unchanged |
| AB12 | Revoked agent continues uploading | 401; data stays local; re-enrol required |
| AB13 | Insider copies the raw archive via E36 repeatedly | each view in `access_log`; alert on > 50 raw views/user/day [CONV] (C1 rule from access_log metrics) |
| AB14 | Path traversal in file-drop names / `object_path` | server-generated paths; CHECK first segment = tenant; agent rejects `..` |
| AB15 | A `lims_api`/`lims_app` session calls the purge or sets the owner-policy GUCs itself | no EXECUTE on `app.purge_instruments_archive(integer)` (REVOKE FROM PUBLIC); owner policies are `TO lims_owner` only → 0 rows (05-SCHEMA §8 items 9–10) |

## 5. PHI handling and logging rules

- PHI-bearing columns: `messages.raw_bytes`, `message_rejections.raw_bytes` (P3+P2), `message_records.sample_barcode` (P2), `value_raw`/`value_numeric`/`ast`/`organism` (P3), `attachments.original_file_name` (P2), Storage objects (P3).
- Lists (E33, E23, E10) carry no barcode; barcode appears only in E35 detail, E34 results (POST) and E39 body.
- Logs/metrics/traces: ids, codes, counts, hashes only. Denylist enforced by `@lims/shared-ts/logger` (server) and `internal/logging/redact.go` (agent); log-scan test with planted synthetic barcodes `E2600000042` and names in P/PID segments (AC-09.12).
- Agent never prints PHI in CLI output, status file, diagnostics zip or uploaded log bundles; server re-scrubs log bundles.
- Raw view: explicit action, access_log, no copy button, not cached by BFF (`Cache-Control: no-store`).
- Event `instruments.result.received.v1` is P3+P2 by contract (03-IC §3.14); never logged.

## 6. Required security tests

| # | Test |
|---|---|
| S-01 | Cross-tenant probe for every operation E01–E42 (staff ops with tenant-A user against tenant-B ids → 404; device ops with tenant-A token naming B ids → rejected/404) |
| S-02 | Cross-centre probe for every staff operation (centre-A1 user vs A2 agent/instrument/message/record → 404) and every device operation: A1 device vs A2 instrument (other centre, invisible) → `instruments.instrument_unknown`; A1 device of agent X vs an A1 instrument bound to agent Y → `instruments.device_mismatch`; both with a `message_rejections` row in A1 |
| S-03 | SQL probes per table (05-SCHEMA §8 items 1–2) |
| S-04 | Privilege escalation: technologist calls E14/E15/E24/E28 → 403; lab manager at aal1 on privileged ops → `auth.mfa_required`; user without `catalog.instrument_code_map.manage` cannot write maps via the BFF |
| S-05 | Device scope: device token on any staff op → 401; enrolment code on non-enrol op → 401; device permission set excludes `lab.*`, `instruments.message.*` |
| S-06 | Secrets: DTO snapshot tests prove no `secret_sha256`, no token after issuance, no raw in non-raw endpoints; `lims_app` column privilege on `secret_sha256` = false |
| S-07 | Resolver: random/expired/revoked/used credentials → no row; GUCs cleared; timing does not depend on credential existence beyond a hash lookup |
| S-08 | Fuzz E04/E05/E06 with malformed base64, oversize, wrong sha256, hostile HL7/ASTM (nested delimiters, 1 MiB fields, invalid UTF-8) → no 5xx except per-message `retry`, quarantine rows created |
| S-09 | Agent: tampered config (bit flip), wrong key id, lower version; tampered package, wrong Authenticode publisher, lower version → all rejected |
| S-10 | Agent: queue file unreadable as another Windows user; token file DPAPI-protected; `icacls` matches spec; `netstat` shows no listener by default; MITM proxy with self-signed cert → TLS failure, no data sent |
| S-11 | Attachments: EICAR, polyglot, `.pdf.exe`, 16 MB, wrong magic → rejected/quarantined; E37 response headers (`Content-Disposition: attachment`, `nosniff`, `no-store`); no response body, header or log line of any operation contains a Storage URL; PNG/JPEG stored without EXIF/GPS |
| S-12 | Log-scan with planted PHI across API, worker and agent logs |
| S-13 | Rate limit: 61st request/min/device → 429 `common.rate_limited`; 101-message batch → 413 |
| S-14 | Purge never deletes younger than retention nor another tenant's rows; `p_raw_retention_days < 365` raises; call without tenant claims raises; runs under FORCE RLS (05-SCHEMA §8 item 7) |
| S-15 | DEFINER privileges and owner policies (05-SCHEMA §8 items 9–10): `has_function_privilege('lims_api', 'app.purge_instruments_archive(integer)', 'EXECUTE') = false`; GUC spoofing by `lims_app` yields 0 rows; GUCs empty after each call |

## 7. Secrets used

| Secret | Where | Rotation |
|---|---|---|
| Config signing key (Ed25519 private) | API hosts, secret store file `LIMS_INSTRUMENTS_CONFIG_SIGNING_KEY_FILE` | yearly [CONV] or on suspicion: ship agent release trusting the next key id, then switch |
| Release signing key (Ed25519 private) | release pipeline only, offline from API hosts | as above via launcher release |
| Authenticode certificate + key | release pipeline; Authenticode certificate purchased and owned by the client (founder decision 2026-11-06, research/04 §13); held in the C1 secret store; the release pipeline applies it plus the internal Ed25519 signature (04 N11) | per certificate validity |
| Device tokens | agent (DPAPI); server SHA-256 only | revoke + re-enrol |
| Enrolment codes | shown once; server SHA-256 only; 24 h | single use |
