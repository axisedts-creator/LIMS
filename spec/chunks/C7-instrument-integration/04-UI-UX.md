# C7 Instrument Integration — 04 UI/UX (staff screens, agent CLI, site runbook UX)

Status: DECISION, 2026-11-06. Staff screens use **only** `@lims/ui` components (C0 04-UI-UX §2); missing components are CR-C7-010 (`CodeBlock`, `SecretRevealOnce` with `requireAcknowledgement?: boolean` default true, `KeyValueListEditor`; ACCEPTED-MODIFIED in 08 §4.6) and are marked **(CR)**. Message keys `instruments.<screen>.<key>`; English v1 (02-CV §13). Desktop-first (≥ 1280 px; C0 04-UI-UX §6). Every page has `loading.tsx`/`error.tsx` and a `PageHeader.helpKey` with a help file in `features/instruments/help/`.

---

## 1. Navigation (`features/instruments/nav.manifest.ts`)

| id | label | routeId | permission | group | order | chord |
|---|---|---|---|---|---|---|
| `instruments.agents` | Agents | `staff.instruments.agents` (CR-C7-003) | `instruments.agent.read` | instruments | 10 | `g a` |
| `instruments.instruments` | Instruments | `staff.instruments.instruments` (CR-C7-003) | `instruments.instrument.read` (CR-C7-001) | instruments | 20 | `g i` |
| `instruments.messages` | Messages | `staff.instruments.messages` (CR-C7-003) | `instruments.message.read` | instruments | 30 | `g m` |
| `instruments.settings` | Settings | `staff.instruments.settings` (CR-C7-003) | `instruments.instrument.read` | instruments | 90 | — |

Chords must be unique across manifests (C0 build check); if `g a`/`g i`/`g m` clash with another chunk the build fails and C7 picks another letter.

Health chip mapping (`StatusChip kind="generic"`, text always shown): online → tone success "Online"; backlog → warning "Backlog"; degraded → warning "Instrument silent"; offline → danger "Offline". Instrument state chip: draft → neutral "Draft"; commissioning → info "Commissioning (no results sent)"; live → success "Live"; suspended → warning "Suspended (no results sent)"; retired → neutral "Retired".

## 2. Bridge agent operator experience (DECISION: CLI, no tray app)

Reason: the agent PC is unattended and shared (reception/lab staff); a tray icon would need a GUI library and per-user session process, and a local web page would need a listener (REQ-SEC-114). Site support is done by the LIMS provider/lab IT with Administrator rights; the fleet UI is the day-to-day view.

All commands require an elevated prompt except `version`. Output is plain text; `--json` gives machine output. Exit code 0 success, 1 usage error, 2 operation failed, 3 not elevated.

| Command | Purpose | Notes |
|---|---|---|
| `bridge-agent install --server <https-url> --enrolment-code <lmse_…> [--proxy <url>] [--account virtual\|localservice] [--allow-lan-listener]` | install, enrol, start | refuses non-https URL; prints progress lines (below) |
| `bridge-agent enrol --enrolment-code <code>` | re-enrol (new PC token / after revocation) | |
| `bridge-agent status` | §2.1 | reads `status.json` |
| `bridge-agent instruments` | per-instrument link state | |
| `bridge-agent queue` | counts by state, oldest pending, rejected items with error codes and instrument codes (no content) | |
| `bridge-agent test-connection` | DNS, TCP 443, TLS chain + hostname, server time, auth check (calls heartbeat) | prints which step failed |
| `bridge-agent flush` | ask service to upload now | custom control 129 or `request.json` fallback |
| `bridge-agent diagnostics --out <file.zip>` | status + redacted config + 7 days logs | never queue payloads, token or code |
| `bridge-agent firewall enable\|disable` | program-scoped inbound rule for LAN listeners | |
| `bridge-agent uninstall [--purge]` | remove service; `--purge` refused while pending/rejected items exist unless `--force-discard-pending` typed with the count shown | |
| `bridge-agent version` | agent, launcher, build, config version | |

Install output (example):
```
[1/6] Checking Windows version ........ Windows 10 22H2  OK
[2/6] Creating folders and permissions  OK
[3/6] Registering service LimsBridgeAgent (NT SERVICE\LimsBridgeAgent)  OK
[4/6] Enrolling with https://lims.example.np ...  OK  agent HUB-PC-01
[5/6] Downloading configuration (version 3) ...  OK  2 instruments
[6/6] First heartbeat ...  OK
Installed. Check "bridge-agent status" or the Agents page.
```

### 2.1 `bridge-agent status` output
```
LIMS Bridge Agent 1.0.0 (launcher 1.0.0)       Service: RUNNING
Agent: HUB-PC-01  01a1a98a-…-0d0101                       Auth: OK
Server: reachable (last heartbeat 12 s ago, OK)           Clock offset: -0.4 s (±0.1)
Config: version 7 (OK)                                    Update: idle
Queue: pending 0 | uploading 0 | rejected 1 | oversize 0 | retained 1,204
Disk free on queue volume: 41,230 MB

Instruments
  SIM-CHEM-1  ASTM  COM3        up         last message 2 min ago   errors 0
  SIM-HEMA-1  HL7   10.0.5.21   connecting last message 3 h ago     last error tcp_connect_refused
```
No barcodes, values, names or file names are ever printed.

### 2.2 Error messages (CLI copy)
| Code | Text |
|---|---|
| `auth_rejected` | "The server refused this agent's credentials. It may have been revoked. Ask your lab manager for a new enrolment code and run: bridge-agent enrol --enrolment-code <code>" |
| `tls_verify_failed` | "Secure connection failed: the server certificate could not be verified. Do not bypass this. Check the PC's date/time and proxy settings." |
| `disk_low` | "Less than 500 MB free. The agent is refusing new instrument messages so the analyser keeps them. Free disk space now." |
| `firewall_rule_missing` | "Instrument X waits for incoming connections but the firewall rule is off. Run: bridge-agent firewall enable" |
| `config_rejected` | "A configuration from the server failed its signature check and was not applied. Contact the LIMS provider support." |

### 2.3 Site runbook (`docs/manual/instruments/site-installation.md`)
Contents (C7 writes): lab PC baseline (REQ-SEC-122: supported Windows with updates, antivirus, no unattended TeamViewer/AnyDesk, separate account, BitLocker where possible); network checklist (REQ-SEC-120: analysers + agent PC on an isolated switch/VLAN, not guest Wi-Fi; serial preferred); per-instrument cabling + settings sheet from the vendor manual; commissioning checklist (= go-live checklist items); how to replace a PC (F-03); what to do when offline alerts fire.

## 3. Staff screens

Common: `PageShell` from the web shell; `PageHeader` (title, breadcrumbs, status, actions, `helpKey`); lists use `DataTable` with cursor pagination (`limit` 50 default) and `FilterBar`; times via `DateText` (tenant `calendarDisplay`, with time); ids via `IdText`; confirmations via `ConfirmDialog` (with `requireReason` where the API needs a reason).

### SCR-01 Agents — `/instruments/agents`
- Header: "Agents"; action "New agent" (`Button primary`, visible with `instruments.agent.manage`); helpKey `instruments.agents`.
- FilterBar: Centre (`select`, centres in scope), Status (`select multiple`: pending_enrolment, active, revoked, retired; default all except retired), Health (`select multiple`).
- Columns: Agent code (row header, link to SCR-02) · Name · Centre · Health chip · Last heartbeat (relative + `DateText` tooltip) · Version · Queue (integer; warning icon + text "Backlog" above threshold) · Clock offset (seconds, warning text when |x| > tenant warn) · Status chip.
- Sort: agent code (default), last heartbeat desc.
- Auto-refresh: polling every 30 s through BFF [CONV] (02-CV §2.4), paused when the tab is hidden.
- Empty: SCR-01 empty text (03-APP-FLOW §5).

**New agent dialog** (`Dialog md`, `Form`):

| Field | Component | Validation | Required | Default |
|---|---|---|---|---|
| Agent code | `TextField maxLength=32` | `^[A-Z0-9-]{2,32}$` (uppercased on input) | yes | — |
| Name | `TextField maxLength=80` | 1–80 | yes | — |
| Centre | `Select` | centres in scope, kind own/franchise, active | yes | working centre |
| Update channel | `RadioGroup` stable / beta | — | no | stable |
| Backlog threshold | `IntegerField min=10 max=100000` | — | no | tenant default |

Submit `Ctrl+Enter` → E11 → navigate to SCR-02 with toast "Agent created. Issue an enrolment code to install it."

### SCR-02 Agent detail — `/instruments/agents/{agent_id}` (route `staff.instruments.agent`)
- Header: `agent_code — display_name`, health chip + status chip; actions (manage only): "Issue enrolment code", "Request command ▾" (`Menu`: Upload logs, Refresh configuration, Restart service, Re-upload since…), "Revoke" (danger), "Retire" (danger), "Edit".
- `Tabs`: **Overview** · **Instruments** · **Health history** · **Credentials** · **Commands & logs**.
- Overview: `DescriptionList` (3 columns), all from the Agent DTO (02-TRD §7.4): centre, status, enrolled at, last heartbeat, agent/launcher/OS version, queue (`queue_depth`/`queue_rejected`/`queue_oversize`), oldest pending age, disk free, clock offset ± uncertainty (`clock_offset_ms`, `clock_offset_uncertainty_ms`), applied/latest config version + state, update state/target (`update_target_version`), update channel/pinned release, auth state, last IP (`health.last_ip`). `Banner warning` when config state ≠ ok ("The agent rejected configuration version N: signature_invalid. Contact support."), when update state ∈ {verify_failed, rolled_back}, when |offset| > warn, when `health.last_ip_changed_at` is within 24 h [CONV] ("This agent's network address changed recently. If you didn't move the PC, revoke it.").
- Instruments tab: `DataTable` instrument code (link SCR-07), state chip, link state, last message, last error code, silence status.
- Health history: `Timeline` of last 50 transitions (from E19) "Online → Offline" with time.
- Credentials: table kind (Enrolment code / Device token), status, issued at/by, expires, used/last used, revoked at. No secret, no hash.
- Commands & logs: table from E18 (`AgentCommand`: kind, state, requested by/at, completed at, result); for completed `upload_logs` with a `log_bundle_id`, "View log" opens `Drawer lg` with E20 lines in `CodeBlock` (CR) — no copy restriction (logs have no PHI).

**SCR-03 Issue enrolment code** — `ConfirmDialog`: title "Issue enrolment code", body "A one-time code lets one PC enrol as this agent. It expires in 24 hours. Earlier unused codes stop working." (+ queue warning text from 03-APP-FLOW F-03 when queue > 0). Confirm → E14 → `Dialog isDismissable=false` with `SecretRevealOnce requireAcknowledgement` (kit component shared with C2; prop `requireAcknowledgement`, default true — CR-C7-010 as modified by 08 R22/§4.6) labelled "Enrolment code", expiry `DateText`, instruction "Paste this into the installer on the lab PC: bridge-agent install --server <origin> --enrolment-code <code>". Close only after the checkbox "I have copied this code". After closing the code is gone.

**Revoke** — `ConfirmDialog tone=danger` with `requireReason { codedSet: 'instruments.g_cs_revoke_reasons', freeText { maxLength 300, isRequired false } }`, body "The PC stops uploading immediately. Messages already on the PC stay there until it is re-enrolled."

**Retire** — `ConfirmDialog tone=danger` + reason; disabled with tooltip when instruments are not retired.

**Re-upload since** — `Dialog` with `DateTimePicker` (min now − 72 h, max now).

### SCR-05 Instruments — `/instruments/instruments`
- Header "Instruments"; action "New instrument" (`instruments.instrument.manage`).
- Filters: Centre, Agent, State (default excludes retired), Protocol.
- Columns: Code (link) · Name · Vendor/Model · Protocol · Agent · Driver (name + status badge: Generic / Verified / Sketch — not for live use) · State chip · Link state · Last message · Unmapped codes (`InstrumentSummary.unmapped_code_count` from E23 — shown as text "3 unmapped", link to SCR-08).

### SCR-06 Instrument form (create / edit) — create in `Dialog lg`; edit on SCR-07 "Configuration" tab
Sections (each a `Card`):

1. **Identity**: Code (`TextField 32`, `^[A-Z0-9-]{2,32}$`, immutable after create), Name (1–80), Vendor (1–60, required), Model (1–60, required), Serial no (60, optional), Software version (40, optional; help text "Interface behaviour can change with software version — record it from the instrument's About screen.").
2. **Connection**: Agent (`Select`, active/pending agents in scope; immutable after create); Protocol (`RadioGroup` ASTM / HL7 v2 / Folder only); Transport kind (`Select`, filtered by protocol) and the kind's fields per 02-TRD §5.8:
   - serial: Port (`TextField 6`, `^COM[1-9][0-9]{0,2}$`), Baud (`Select` list), Data bits (`Select` 7/8), Parity (`Select`), Stop bits (`Select` 1/1.5/2), DTR/RTS (`Switch`, default on). Help: "Use the values from the instrument's LIS/host interface manual."
   - tcp_client: Host (253), Port (`IntegerField 1–65535`), Connect timeout s (`IntegerField 1–60`, default 10), Reconnect max back-off s (`IntegerField 1–300`, default 60) — ranges as 02-TRD §5.8.
   - tcp_server: Listen address (IPv4 `TextField 15`), Port (1024–65535), Allowed instrument addresses (`TextField` comma list, 1–8 IPv4). Warning `Banner`: "The agent will accept connections on the lab network. Run 'bridge-agent firewall enable' on the PC."
3. **Driver**: Driver (`Select` from E22; options show status; sketch drivers listed only outside production); Parser options rendered from the driver `optionsSchema` as fields (strings ≤ 64, selects for enums); Timezone (`Select` IANA list, default tenant); QC sample id patterns (`TextArea` one regex per line, ≤ 10 lines × 100).
4. **Protocol options** (`Disclosure`-style `Card` collapsed by default, label "Advanced link settings"): ASTM timers and counters (incl. Max outbound retry cycles 1–10, default 3) as `IntegerField`s with the 02-TRD §5.2.4 defaults and ranges, and the note "Default values, taken from a published vendor implementation of LIS1-A. Use the values in this instrument's manual when it gives them." (08 A13 D-41); HL7: ACK mode (`Select`), ACK sending app/facility, ACK timeout, send retries, max message size.
5. **Capabilities**: Host query (`Switch`; disabled with reason text when driver doesn't support it); Worklist download (`Switch` always disabled, text "Not available yet"); Picture/PDF folder (`Switch` → shows file-drop fields: Folder path (240), File name pattern (200), Barcode pattern (200, must contain `(?P<barcode>…)` — inline error "Include a named group (?P<barcode>…) that captures the sample barcode"), Types (`Checkbox` PDF/PNG/JPEG), Stable seconds (2–60, 5), Move after capture (`Switch`), Captured subfolder (`TextField 60`, `^[A-Za-z0-9_-]{1,60}$`, default `captured`), Attachment code (64)).
6. **Monitoring**: Silence window minutes (`IntegerField 15–1440`, optional), Active from/to (`TextField 5` `HH:MM`).

Submit → E24/E26; server `errors[]` mapped by JSON Pointer (`/transport/port`, …). Success toast (edit): "Saved. The agent picks this up within a minute."

### SCR-07 Instrument detail — `/instruments/instruments/{instrument_id}` (CR route)
- Header: code — name, state chip; actions by state (manage only): Start commissioning · Go live · Suspend · Resume · Retire; "Mappings" link (SCR-08); "Messages" link (SCR-09 pre-filtered).
- Tabs: **Overview** (status `DescriptionList`: link state, last message (server/agent), instrument clock offset, silent since, driver + version + manual reference, go-live record) · **Configuration** (SCR-06) · **History** (audit entries via C2 audit viewer link `staff.admin.audit_entry` where the user has `audit.log.read`).
- **Go live dialog** (`Dialog lg`): four `Checkbox`es (labels: "The official interface manual for this model and software version is on file", "Patient-sample comparison with the instrument printout is done", "QC values compared", "Code mappings reviewed"), Evidence note (`TextArea 2000`, min 10). Blocking `Banner danger` when driver ≠ verified: "This driver is not verified against an official manual. The instrument cannot go live." (B2). Confirm → E28; MFA step-up per `auth.mfa_required`.
- Suspend/Retire: `ConfirmDialog` with free-text reason (3–300). Retire additionally reminds: "Deactivate this instrument's code mappings in Mappings."

### SCR-08 Mappings — `/instruments/instruments/{instrument_id}/mappings` (CR route; data owned by C3 — X4)
Layout two panels (`Grid` 5/7):
- **Observed codes** (left): `DataTable` from E32 (`ObservedCode`) — Code, Class (Patient/QC/Calibrator), Seen count, Last seen, Mapping status (text "Mapped"/"Unmapped"); filter Unmapped only (default on). Row action "Map…" (only with `catalog.instrument_code_map.manage`) prefills the editor.
- **Mappings** (right): `DataTable` from C3 `listInstrumentCodeMaps` — Direction, Instrument code, Test, Analyte, Unit conversion (`g/L → g/dL × 0.1`), Flag map count, Active; row actions Edit, Deactivate; header actions "Add mapping", "Copy from instrument…" (select another instrument → bulk upsert via C3 `upsertInstrumentCodeMaps` with per-row outcome table).
- **Editor** (`Drawer md`, `Form`):

| Field | Component | Validation (C3 02-TRD #93) | Required |
|---|---|---|---|
| Direction | `RadioGroup` Inbound / Outbound / Both | — | yes (default Both) |
| Instrument code | `TextField maxLength=64` | 1–64 | yes (immutable on edit) |
| Test | `Combobox` → C3 `searchOrderables` (kind test) | — | yes |
| Analyte | `Select` from C3 `getTestDetail` analytes | must belong to test | yes |
| Unit from (instrument) | `TextField 32` | all three or none | no |
| Unit to | `Select` from C3 `listUnits` | | no |
| Factor | `DecimalField decimals=6` | > 0 | no |
| Flag map | `KeyValueListEditor` (CR) key ≤16 → code ≤64, ≤ 20 rows | | no |

C3 errors: `409 catalog.code_duplicate` → field error on Instrument code "This code is already mapped for this instrument."; `400 common.validation_failed` → field errors by JSON Pointer; `403 auth.mfa_required` → banner "Confirm with your authenticator to continue" with the C2 step-up link (`catalog.instrument_code_map.manage` is privileged → aal2, 08 A13 D-18).

**Without `catalog.instrument_code_map.manage`** (08 A13 D-39; review #16): the Mappings panel, editor and "Copy from instrument…" are not rendered and the BFF makes no C3 code-map call (C3 `listInstrumentCodeMaps` requires `manage`); in their place an `EmptyState` with the text "Mappings are visible to users who can manage them." The Observed codes panel stays (read-only, full width).

### SCR-09 Messages — `/instruments/messages`
- Filters: Received (`DateRangePicker maxDays=31`, default last 24 h — AC-18.1), Instrument, Agent, Centre, Kind (`message_kind`: data / host query / attachment / incomplete), "Has QC records" (`Switch` → E33 `has_qc`, review #35), Latest outcome (parsed, shadow, quarantined, rejected_capability), "Has unmapped".
- Barcode search: `BarcodeInput` (`allowManual`, pattern `^[A-Z0-9]{1,40}$`) above the table — on scan/Enter calls E34 (POST); results replace the table with a "Search results for scanned barcode" chip + Clear. The barcode never appears in the URL or the browser history.
- Columns: Received (`DateText`) · Instrument · Kind · Records (patient/QC) · Unmapped · Events · Outcome chip (Parsed / Shadow / Quarantined — danger / Rejected) · Size.
- Second tab **Rejected uploads** (E42): received, agent, claimed instrument id, reason code, size.

### SCR-10 Message detail — `/instruments/messages/{instrument_message_id}` (route `staff.instruments.message`)
- Header: "Message" + `IdText`, outcome chip; actions: "Reprocess" (`instruments.message.rematch`; enabled for latest outcome quarantined/shadow/parsed — AC-19.1 — not host_query; writes access log `instrument_message.reprocess`), "Show raw".
- `DescriptionList`: instrument, agent, protocol, kind, control id (HL7), message key kind, received (server), captured (corrected), size, sha256 (`IdText truncate 12`), warnings.
- **Runs** `Timeline`: "Run 1 · live · parsed · 8 records · 8 events" etc. with actor and reason.
- **Records** `DataTable` (latest run): #, Class, Barcode, Code, Value, Unit, Flags, Result time, Mapping chip, Emit status text, C5 outcome (port outcome when known), Event id (`IdText`). Row action "Re-match…" (patient/attachment records). When the record's port outcome is `unmatched` or `held`, the row shows the link "Open lab exceptions" → C5's exception list filtered by this instrument, built with `buildRoute('staff.lab.ingest_exceptions')` + query `instrument_id` (route requested by CR-C7-014; C7 does not know the exception id). Until that route id is registered, the row shows the text "Check the lab's instrument exceptions" without a link (no hand-built URL).
- When `records_expired`: `Banner info` "Parsed rows older than 90 days are not kept. Show a preview parse of the original message." + button → E35 `preview_parse=true`.
- **Raw panel** (`Drawer lg`): opened by "Show raw" → E36 → `CodeBlock` (CR) with `renderControlChars`, `allowCopy=false`, caption "Viewing raw messages is recorded." Closing clears state.
- **Attachment** card (file-drop): file name, type, size, scan state chip; "Open" (clean only) → BFF → E37 `downloadInstrumentAttachment` → the browser downloads the streamed file (`Content-Disposition: attachment`; no Storage URL, 08 A13 P-2). Non-clean → no button; a `422 common.upload_quarantined` race shows "This file is not available."
- **Reprocess dialog**: `ConfirmDialog` with `requireReason { codedSet: 'instruments.g_cs_reprocess_reasons' }`, body "The original message is parsed again with the current driver and sent to the laboratory. Results already applied are not duplicated; approved results are never changed." Result → `Dialog` table of records with port outcome text: Applied / Already received / Not matched (see lab exceptions) / Locked (approved — amend in Lab) / On QC hold.
- **Re-match dialog**: original barcode shown read-only; New barcode `BarcodeInput` (scanner or typing; must differ); Reason (`CodedSelect` reprocess reasons, default `barcode_keypad_error`); Note (`TextArea 300`). Confirm shows the same outcome table.

### SCR-11 Settings — `/instruments/settings`
`Form` with `IntegerField`s (fields = `InstrumentSettings`, 02-TRD §7.4): Default backlog threshold (10–100000), Backlog oldest pending seconds (60–86400), Clock warning seconds (30–3600), Agent local retention hours (1–72), Update window from/to (`HH:MM`, optional). Read-only without `instruments.instrument.manage`. If-Match conflict → banner "Someone else changed these settings. Reload to see them." Help text (no field): "Raw analyser messages are kept for the period set in the lab's retention settings (Administration), at least one year. Legal retention is not yet confirmed." (retention is C2's `retention.rawInstrumentYears`, 08 A13 D-42). Saving a changed update window shows the toast "Saved. Agents pick up the new update window within a minute."

## 4. Keyboard shortcuts (page-level, registered via `shortcuts.register`)

| Page | Keys | Action |
|---|---|---|
| SCR-01 | `Alt+A` | New agent |
| SCR-02 | `Alt+E` | Issue enrolment code |
| SCR-05 | `Alt+I` | New instrument |
| SCR-07 | `Alt+M` is global (focus main) → use `Alt+P` | Open mappings |
| SCR-09 | `/` | focus barcode search |
| SCR-10 | `Alt+R` | Show raw · `Alt+P` Reprocess |
Global keys (C0 §4) unchanged; a page key never reuses a global key (C0 AC-0D-7.5), so SCR-01 and SCR-05 use `Alt+A` and `Alt+I`, not the global `Alt+N`; tables use the kit keyboard model.

## 5. Accessibility and responsive
- Chips always carry text; offline/backlog warnings use icon + text.
- `CodeBlock` is a focusable region with `aria-label` "Raw message"; control characters rendered as text badges `<STX>` (not colour only).
- `SecretRevealOnce` announces "Code shown. Copy it now." via live region; focus trapped until acknowledged.
- Polling updates do not move focus; the table announces "Updated" politely at most once per minute.
- Below `lg` the shell banner applies; the Mappings two-panel layout stacks vertically below `xl`.

## 6. Copy (selected keys)
| Key | Text |
|---|---|
| `instruments.agents.empty` | "No agents yet. Create one for each lab PC that connects analysers." |
| `instruments.instrument.not_verified` | "This driver is not verified against an official manual. The instrument cannot go live." |
| `instruments.instrument.shadow_note` | "Commissioning: messages are stored and shown here but are not sent to the laboratory." |
| `instruments.messages.raw_audit` | "Viewing raw messages is recorded." |
| `instruments.rematch.locked` | "This result is approved. It was not changed. A pathologist can amend it in Lab." |
| `instruments.code.expired` | "This code has expired. Issue a new one." |
| `instruments.agent.revoked_banner` | "This agent's access was revoked. It keeps messages locally until it is re-enrolled." |

## 7. Components used
`PageShell`, `PageHeader`, `Tabs`, `Card`, `Grid`, `Stack`, `Inline`, `DataTable`, `FilterBar`, `StatusChip`, `DescriptionList`, `Timeline`, `DateText`, `DateRangePicker`, `DateTimePicker`, `IdText`, `Button`, `IconButton`, `Menu`, `Form`, `TextField`, `TextArea`, `IntegerField`, `DecimalField`, `Select`, `CodedSelect`, `Combobox`, `Checkbox`, `RadioGroup`, `Switch`, `BarcodeInput`, `Dialog`, `ConfirmDialog`, `Drawer`, `Banner`, `EmptyState`, `ErrorState`, `LoadingSkeleton`, `useToast`, `Tooltip`, `Badge`. **CR-C7-010**: `CodeBlock`, `SecretRevealOnce`, `KeyValueListEditor`.
