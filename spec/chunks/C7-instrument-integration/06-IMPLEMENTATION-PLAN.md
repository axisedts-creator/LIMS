# C7 Instrument Integration — 06 Implementation Plan

Status: DECISION, 2026-11-06. Three parallel tracks (AG = Go agent, API = API/worker module, WEB = staff web) plus shared golden fixtures. One task ≈ one PR (02-CV §12). Every task's tests are in its row; "AC" = 01-PRD acceptance criteria. Paths are relative to the repo root.

## 1. Prerequisites (C0 deliverables, consumed through fakes until merged)

| Needed | From | Fake / default meanwhile |
|---|---|---|
| `instruments` DDL + RLS + views (this chunk's 05-SCHEMA) | C0-0B T0B-10.C7 | compose DB with C7's DDL applied from the C0 PR branch |
| `contracts/openapi/instruments.yaml` from 02-TRD §7 | C0-0C | Prism mock (`pnpm mock:instruments`) |
| Event schemas §3.14–3.16 (+ CR-C7-004 fields) | C0-0C | local ajv schemas in tests, replaced on merge |
| `AuthResolver` registry, savepoints, idempotency, ingest tier, streaming download helper (08 A13 P-2), `tenantScope: 'per_tenant'` cron fan-out + `app.cron_tenant_ids()` (08 A13 P-6) | C0-0D / C0 worker core | — (core is Wave 0); until per-tenant fan-out merges, the C7 cron tasks loop over a test tenant list in integration tests only |
| CI jobs of 02-TRD §16 CR-C7-013 (Windows runner, TLS/tag/fixture/registry/synthetic gates; 08 A13 P-14) | C0-0A | scripts run locally and are attached to the PR until the jobs are wired |
| DEFINER resolver (CR-C7-006) | C0-0B | `NODE_ENV=test` in-module resolver reading the table as owner in the test harness |
| Upload/scan/storage API `ctx.uploads`/`ctx.files.scan`/`ctx.storage` (CR-C2-011, which absorbed CR-C4-005; bucket `instruments-attachments` per CR-C7-007/08 R26) | C0-0D/0B | in-module `attachments/adapters/{storage,scanner}.fake.ts` |
| `LabPort`, `CatalogPort`, `IdentityPort` fakes | `@lims/fakes` | — |
| UI kit (+ CR-C7-010 components) | C0-0D | until merged: `CodeBlock` → read-only `TextArea` with control chars rendered as text; `SecretRevealOnce` → `Dialog` + `TextField isReadOnly` + `Checkbox` composed from kit primitives (allowed composition, no look-alike component exported) |

## 2. Tasks

### Track AG — bridge agent (`apps/bridge-agent/`)

| ID | Goal | Files | Depends | Done when | Tests | AC |
|---|---|---|---|---|---|---|
| AG-T01 | Module skeleton, toolchain pin, CI scripts (vet, staticcheck, gofmt, windows build, `CGO_ENABLED=0`, TLS gate, release-tag check — `build/ci.sh`, `build/ci-windows.ps1`), confirm the `modernc.org/sqlite` v1.61.1 pin builds | `go.mod`, `cmd/*/main.go` stubs, `build/` | **CR-C7-013** (C0-0A wires jobs `c7-go-build`, `c7-go-windows`, `c7-go-sessions`, `c7-go-insecure-tls-gate`, `c7-go-release-tag-check`) | windows/amd64 static binary built in CI; `InsecureSkipVerify` gate passes | build test | — |
| AG-T02 | **Spike** on Windows 10, 11, Server 2016 VMs: virtual account `NT SERVICE\LimsBridgeAgent` (serial port access, DPAPI user scope), custom control codes 128–255, `WinVerifyTrustEx` on a test-signed exe | `docs/manual/instruments/spikes.md` (findings) | AG-T01 | written results; fallbacks chosen (LocalService / machine-scope DPAPI / request.json) | manual + scripted | — |
| AG-T03 | ASTM framing + checksum + E1394 tokeniser + classifier | `internal/astm/{frame,checksum,records,classify}.go` | AG-T01 | 02-TRD §5.2.6 vectors pass; shared vector file used by TS | unit | AC-05.3, AC-05.5 |
| AG-T04 | Queue: schema, pragmas, AES-GCM + DPAPI key wrap, sessions, items, truncation | `internal/queue/*`, `internal/secrets/*` | AG-T01, AG-T02 | round-trip, AAD tamper detection, truncation rules, disk guard | unit, crash tests | AC-08.4, AC-05.7 |
| AG-T05 | ASTM receiver state machine (03-APP-FLOW §3.1) with persist-before-ACK and restart recovery | `internal/astm/link.go` | AG-T03, AG-T04 | all receive sessions pass; kill-test no loss | unit (fake clock), sessions, crash | AC-05.1–05.7 |
| AG-T06 | ASTM sender state machine (§3.2) incl. contention, NAK, 6 sends, interrupt | `internal/astm/link.go` | AG-T05 | send sessions pass | unit, sessions | AC-06.1–06.5 |
| AG-T07 | MLLP codec + HL7 MSH/ACK + sessions (§3.3) | `internal/mllp/*`, `internal/hl7/*` | AG-T04 | original/enhanced ACK, garbage, oversize, MSH-unparseable sessions | unit, sessions | AC-07.1–07.5 |
| AG-T08 | Transports: serial (go.bug.st/serial) and TCP client/listener with peer allowlist | `internal/transport/*` | AG-T01 | loopback TCP tests; serial via virtual COM pair on Windows CI runner (com0com-class tool on the runner only, not shipped — if unavailable, [manual]) | integration | AC-07.1 |
| AG-T09 | Session profiles + registry (generic + Mindray sketch profiles) | `internal/drivers/*` | AG-T05, AG-T07 | unknown profile fallback reported | unit | — |
| AG-T10 | Uploader: batcher, backoff, rate budget, outcomes, TLS strictness, proxy | `internal/uploader/*`, `internal/clock/*` | AG-T04, API-T06 (contract via Prism) | batches ≤100/≤3 MiB; Retry-After honoured; 401 stops uploads | unit, contract vs Prism | AC-08.1–08.3, AC-14.1–14.2 |
| AG-T11 | Signed config verify + apply (canonical JSON vector) | `internal/config/*` | AG-T01, shared vector (API-T08) | bad sig/agent/rollback rejected and reported | unit | AC-15.1 |
| AG-T12 | Heartbeat + commands (refresh, restart, upload_logs, reupload_since) | `internal/heartbeat/*` | AG-T10 | commands executed once per command_id | unit, contract | AC-13.1, AC-24.1–24.2 |
| AG-T13 | Host-query relay | `internal/hostquery/*` | AG-T06, AG-T07, AG-T10 | round trip with server stub; offline → no reply | sessions | AC-10.3, AC-10.6 |
| AG-T14 | File-drop watcher | `internal/filedrop/*` | AG-T04, AG-T10 | stability, dedupe, move option, path safety | unit + Windows integration | AC-12.1, AC-12.2, AC-12.5 |
| AG-T15 | Windows service, installer, ACLs, firewall, enrolment hand-off, status file, CLI | `internal/svc/*`, `internal/status/*`, `internal/cli/*` | AG-T02, AG-T11, AG-T12 | install/uninstall on Win10/11/2016 VMs; `icacls` audit matches 02-TRD §5.12; `netstat` shows no listener by default | Windows integration, [manual] port scan | AC-01.4, AC-22.1–22.2 |
| AG-T16 | Self-update + launcher with rollback and anti-rollback | `internal/update/*`, `cmd/launcher` | AG-T15, release key tooling | tampered zip, wrong publisher, lower version rejected; crash-loop rollback | Windows integration | AC-15.2–15.4 |
| AG-T17 | Simulator binary + full session suite in CI | `cmd/simulator`, `testdata/sessions/*` | AG-T05–T07, AG-T13 | all required sessions (02-TRD §15.3) green | CI | AC-21.1 |
| AG-T18 | Release pipeline scripts (build, sign Ed25519 + Authenticode hooks, manifest, seed SQL generator) | `build/*` | AG-T16, C1 secrets | dry-run release in staging produces a verifiable package + seed | CI | — |

### Track API — module `instruments` + worker

| ID | Goal | Files | Depends | Done when | Tests | AC |
|---|---|---|---|---|---|---|
| API-T01 | Manifest, permissions, config, empty handlers (boot passes against spec) | `services/api/src/modules/instruments/{index,permissions,config}.ts`, `handlers/*` | C0 spec | core boot validates handler set | boot test | — |
| API-T02 | Domain: state machines (agent, instrument, credential, command), keys, decimal, instrumentTime, transport schemas, health evaluator | `domain/*` | — | every allowed + one forbidden transition per machine tested | unit | AC-04.5, AC-13.2–13.5 |
| API-T03 | Device auth resolver + credential service | `auth/deviceTokenResolver.ts`, `service/credentials.service.ts` | CR-C7-006 (fake meanwhile) | formats, kinds, touch throttle, failures metric | unit, integration, probes | AC-01.5–01.7 |
| API-T04 | Agents: E10–E21 | handlers, `agents.service.ts`, repos, mappers | API-T02, API-T03 | secrets never in DTOs (mapper test), access_log rows | integration, contract, probes | AC-01.1–01.3, AC-02.1–02.4, AC-16.1–16.3, AC-24.3 |
| API-T05 | Instruments: E22–E32, E40–E41, config-version bump (incl. `settings_changed` for every agent on an update-window change) | `instruments.service.ts`, `settings.service.ts`, `observedCodes.service.ts` | API-T02, API-T08 | capability/driver/checklist rules; version bump rules; E32 lists observed codes (review #32) | integration, contract, probes | AC-03.1–03.6, AC-04.1–04.5, AC-15.5 (window part), AC-17.1 |
| API-T06 | Enrolment E01, config E02, heartbeat E03, log bundles E07, release download E08 | handlers, `heartbeat.service.ts`, `releases.service.ts` | API-T03, API-T08 | enrol transactions (A2/A3/A5); command delivery | integration, contract | AC-01.4, AC-02.2, AC-13.1, AC-24.1 |
| API-T07 | Driver framework + generic drivers (incl. `control_id_field`) + golden suite + Mindray sketches + CI scripts `__tests__/ci/{driver-registry-check,synthetic-scan,fixture-copy-check}` | `drivers/*`, `__tests__/ci/*` | **CR-C7-013** (C0-0A wires `c7-driver-registry-check`, `c7-synthetic-data-scan`, `c7-fixture-copy-check`) | golden cases pass; registry ↔ g_drivers (`status`, `cap_*`) check; sketch guard | unit (golden) | AC-21.2, AC-21.3, AC-21.4 |
| API-T08 | Canonical JSON + Ed25519 signing + shared vector with Go | `service/signing.ts`, `testdata/config/*` (vector copied from agent repo path by CI) | — | TS and Go produce identical bytes/signature | unit | AC-15.1 |
| API-T09 | Ingest pipeline E04 (§6.4, compute-then-insert order) + event publishers (four events; manifest `produces` = EVENT_PRODUCERS) | `ingest.service.ts`, `events/publish.ts` | API-T05, API-T07, C0 events | dedupe 3 levels, savepoints, time budget, events validate, QC `control_id_raw`/`value_raw ≤ 64` rule, run counters, no PHI in logs | integration, event contract, log-scan | AC-09.1–09.12, AC-11.1–11.2 (incl. AC-11.1a), AC-14.2–14.3 |
| API-T10 | Host query E05 (Idempotency required; agent-key and `sha256_repeat` dedupe) | `hostQuery.service.ts` | API-T09, LabPort fake | statuses, capability gate, dedupe, p95 | integration, perf | AC-10.1–10.5, AC-10.7 |
| API-T11 | Attachments E06 (`ctx.uploads.accept` only, re-encode on), E37 streaming download + worker `scan_attachment` (new record row per scan run) | `attachments.service.ts`, worker task | API-T09, adapters (fake), C0 streaming helper | EICAR quarantined; clean emits; path tenant check; E37 headers and no Storage URL in any response | integration, contract | AC-12.3–12.6 |
| API-T12 | Messages read E33–E36, E42, preview parse, access_log | `messages.service.ts` | API-T09 | barcode never in URL (spec lint), raw access logged | integration, probes | AC-18.1–18.3 |
| API-T13 | Reprocess / re-match E38–E39 (`InstrumentResultInput` 1:1 mapping, D-10; access log on both) | `reprocess.service.ts` | API-T09, LabPort fake (with `unitRaw`, `isRerun?`) | port outcomes stored; events with processing_kind; locked → rejected_state; `instrument_message.reprocess` row | integration | AC-19.1–19.5 |
| API-T14 | Worker: health evaluator, metrics export (C1 names/labels), expiry cron, `publish_release_configs`, observed-code refresh consumer, per-tenant purge (retention from IdentityPort), alert-rule file for C1 | `services/worker/src/jobs/instruments/*` | API-T02, CR-C7-006, C0 per-tenant cron | transitions + events; duplicate delivery no-op; purge boundaries under FORCE RLS (05-SCHEMA §8 items 7, 9, 10) | integration, event contract | AC-13.2–13.6, AC-15.5, AC-17.3, AC-20.1, AC-20.2 |
| API-T15 | Performance run at 1× and 10× (04 §14) | `__tests__/perf/*` | API-T09, API-T10 | 02-TRD §12 targets met | load test | AC-08.5, AC-10.5 |
| API-T16 | Micro driver rule (`drivers/micro-code.ts`: `ORG:<n>`, `AST:<n>:<ab>:<method>`, ≤ 64, CR-C10-007/08 R13) + calibration classification hook and publisher for `instruments.calibration.received.v1` (CR-C12-006; enabled per verified driver only, B2) + published view `instruments.v_pub_instrument_directory` column contract (08 §4.9) + bucket name `instruments-attachments` | `drivers/micro-code.ts`, `drivers/types.ts`, `events/publish.ts` | API-T07, API-T09 | two-isolate simulator session → two keys; generic drivers never emit calibration; view columns exact | unit (golden), event contract | AC-11.3, AC-11.4 |

### Track WEB — `apps/web/.../instruments`

| ID | Goal | Depends | Done when | Tests | AC |
|---|---|---|---|---|---|
| WEB-T01 | Nav manifest, route segment, loading/error, help files | CR-C7-003 routes | build-nav passes | build | — |
| WEB-T02 | SCR-01/02/03 agents (incl. enrolment code reveal) | API-T04 (Prism/MSW) | flows per 04-UI-UX | component + MSW, axe | AC-01.3, AC-16.* |
| WEB-T03 | SCR-05/06/07 instruments + commissioning dialogs | API-T05 | schema-driven forms, error mapping | component, axe | AC-03.*, AC-04.* |
| WEB-T04 | SCR-08 mappings through C3 operations | C3 #92–#95 (Prism `catalog`), API-T05 (E32) | create/edit/deactivate/copy; without `manage` the Mappings panel is hidden and no C3 call is made (D-39); step-up on `auth.mfa_required` | component + MSW | AC-17.1–17.4 |
| WEB-T05 | SCR-09/10 messages, raw drawer, attachment download (BFF stream proxy), reprocess, re-match | API-T11, API-T12, API-T13 | barcode only in POST body; raw cleared on close; download via stream, no URL | component, E2E | AC-12.6, AC-18.*, AC-19.* |
| WEB-T06 | SCR-11 settings (no retention field; help text points to tenant retention settings) | API-T05 | If-Match conflict banner | component | AC-15.5 (window) |
| WEB-T07 | User manual + site runbook (`docs/manual/instruments/`) | all | reviewed | — | — |

### Integration

| ID | Goal | Depends | Done when |
|---|---|---|---|
| INT-T01 | Nightly E2E: simulator → agent core (Linux test build) → API → C5 consumer (fake, later real) | AG-T17, API-T09 | result `resulted` in C5 within 5 s p95 |
| INT-T02 | Swap fakes: CatalogPort (C3 merged), LabPort (C5 merged), upload/storage API (CR-C2-011), resolver (CR-C7-006) | owners' chunk gates | contract suites green against real |
| INT-T03 | Cross-tenant/centre probe suite incl. device probes (07-SECURITY §6) | all | 100 % operation coverage |
| INT-T04 | Staging site trial with a real analyser in commissioning (shadow) | all + B2 for that model | [manual] reconciliation: instrument count = archive count |

## 3. Milestones

| M | Content | Exit |
|---|---|---|
| M1 "Bytes in safely" | AG-T01–T08, T10, T15 basic; API-T01–T04, T06, T09 (generic drivers) | simulator ASTM + HL7 messages archived and visible as `shadow` |
| M2 "Clinical flow" | API-T05, T07, T13, T14; WEB-T01–T05 | an instrument with a (test-marked) verified driver in staging emits events consumed by C5 |
| M3 "Fleet" | AG-T11–T14, T16–T18; API-T10–T12, T15; WEB-T06–T07 | updates, health alerts, attachments, host query in simulator |
| M4 per driver | driver playbook §5 per instrument model when its manual arrives (B2) | instrument `live` at the site |

## 4. Fake → real switch points
- CatalogPort/LabPort/IdentityPort: when C3/C5/C2 pass their chunk gates (05-DoD §5); run C7 integration suite with `LIMS_CORE_FAKE_PORTS` empty.
- Resolver: when CR-C7-006 merges, delete the test-only resolver (guarded by `NODE_ENV=test`; CI fails if present in a production build).
- Upload helper: when CR-C2-011/CR-C7-007 merge; then run the Storage 04 D3 probe before enabling attachments in production (feature gate: tenant cannot enable `file_drop` until the probe result is recorded in C0 `DECISIONS.md`).
- Worklist: `LabPort.listPendingForInstrument` (CR-C7-005) is already in 03-IC §4.5; enable only when a B2 driver declaring `worklistDownload` is promoted to `verified`, and drop `instruments__worklist_blocked__ck` in that same migration.

## 5. Driver playbook (when an official manual arrives — B2)
1. Record manual metadata (title, document id, revision, instrument software version) — it becomes the `g_drivers` row.
2. Write `SOURCE.md` and golden cases built from the manual's message examples with synthetic values; include malformed, QC, rerun, and host-query request/reply cases as the manual allows.
3. Implement the server driver (`drivers/<vendor>_<model>/`) and the agent session profile (`internal/drivers/<vendor>_<model>/`); simulator sessions for its link behaviour (timers, ACK mode) taken from the manual.
4. Second-person review of expected files against the manual.
5. Migration: insert/upgrade `g_drivers` with `status = generic` first (commissioning use).
6. On site: start commissioning, run QC + synthetic/consented comparison samples, add code maps from observed codes, fill the go-live checklist.
7. Migration promoting the driver to `verified` (requires `manual_document_id`; `cap_calibration` may be set true only now and only if the manual classifies calibrator records), then Go live.
7a. If the manual documents histogram/scattergram payloads (PRD IS-27, 08 A13 D-40): extract them as `attachment`-kind records in the driver, specify their storage/viewer details (several graphics per message) in the same PR, and add golden cases.
8. Contract text per instrument keeps "pending vendor documentation" until step 7 (04 N14).

## 6. CR candidates already foreseen (beyond 02-TRD §16)
- C5: a lookup of a C5 ingest exception by `result_key_sha256` so SCR-10 can deep-link exactly (today it links to a filtered list).
- C0: `randomToken` base32 option if sites cannot paste enrolment codes (typing 22 base64url chars is error-prone).
- C0: per-route rate-limit sub-budgets (host query separate from upload) if the 60/min/device limit proves too tight (R5) — would need a 04 change by the founder.
- C9 (Phase 2): QC classification hints from C9's control-material registry back to C7 (`control_id_raw` patterns) instead of per-instrument regexes.
- ~~C12 (Phase 2): calibration-event records~~ — closed: `instruments.calibration.received.v1` accepted (CR-C12-006, 08 §4.10); emitted only by drivers whose official manual classifies calibrators (B2). Task API-T16.

## 7. Risks

| # | Risk | L/I | Mitigation |
|---|---|---|---|
| R1 | Manuals never arrive or are partial (B2) | H/H | platform ships independently; commissioning/shadow mode; per-instrument contract clause (04 N14); founder chases distributors (07-BLOCKERS requests) |
| R2 | Vendor deviates from ASTM/HL7 framing (e.g. no CR LF, lowercase checksum) | M/M | receive-side tolerance options in the session profile (case-insensitive checksum already); golden sessions per model |
| R3 | Authenticode certificate not in the secret store at go-live | M/H | Authenticode certificate purchased and owned by the client (founder decision 2026-11-06, research/04 §13); held in the C1 secret store; the release pipeline applies it plus the internal Ed25519 signature (04 N11); production gate blocks unsigned releases |
| R4 | Virtual account cannot open COM ports or use DPAPI user scope | M/M | AG-T02 spike; fallback LocalService + machine-scope DPAPI + strict ACL |
| R5 | 60 requests/min/device (04 §4) too tight for host-query-heavy racks | M/M | reserved budget 20/min; queue queries until `ReplyTimeout`; measure in commissioning; CR candidate §6 |
| R6 | Instrument host-query reply timeout shorter than Nepal internet round trip | M/H | measure per model; profile `ReplyTimeout`; fall back to upload-only (manual programming) |
| R7 | Results without instrument time collide on key `'none'` | L/M | drivers must extract a time where the manual provides one; `duplicate_event` visible; C5 exception path |
| R8 | Lab PC replaced/reinstalled with unsent queue | M/M | UI warning before re-enrolment; `bridge-agent uninstall --purge` refuses with pending items |
| R9 | Storage claims not populated on self-hosted (04 D3) | M/M | attachments gated on probe; worker-side service path |
| R10 | Raw archive contains names (instrument P/PID) → PHI exposure via message.read | M/M | raw view on explicit action + access_log; list views carry no barcode; retention default = the 1-year floor (`retention.rawInstrumentYears`, D-42) |
| R11 | Driver bug emits wrong values for live instruments | L/H | go-live checklist; golden reviews; version-stamped runs; C5 verification still manual in Phase 1 (04 R2) |
| R12 | Clock drift on PCs/instruments | H/L | offset tracking + alert; server time for TAT |
