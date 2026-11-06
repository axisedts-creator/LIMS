# C5 Lab Workflow — 04 UI/UX

Status: DECISION, 2026-11-05. Staff web only (`apps/web`, route segment `(staff)/lab`). Language English through the message catalog, keys `lab.<screen>.<key>` (02-CV §13). WCAG 2.2 AA target, keyboard-first (02-CV §14). Calendar display per `TenantSettings.calendarDisplay` (default A.D.), format `DD/MM/YYYY hh:mm A` in `Asia/Kathmandu` (02-CV §13). All values chosen here without an external source are [CONV].

---

## 1. Navigation (`apps/web/src/features/lab/nav.manifest.ts`)

| Entry | Route | Permission (any of) |
|---|---|---|
| Status board | `/lab/status-board` | `lab.status_board.read` |
| Collect & dispatch | `/lab/collect` | `lab.specimen.collect` |
| Receive | `/lab/receive` | `lab.specimen.receive` |
| Worklists | `/lab/worklists` | `lab.worklist.read` |
| Pending | `/lab/pending` | `lab.worklist.read` |
| Verify | `/lab/verification` | `lab.result.verify` |
| Approve | `/lab/approval` | `lab.result.approve` |
| Critical values | `/lab/critical-values` | `lab.critical_value.read` |
| Instrument exceptions | `/lab/ingest-exceptions` (route `staff.lab.ingest_exceptions`, CR-C7-014; C7 screens link here) | `lab.result.read` |
| Worksheets | `/lab/worksheets` | `lab.worklist.read` |
| QC results | `/lab/qc` | `lab.qc.capture` |
| Lab settings | `/lab/settings` | `lab.config.manage` (CR-C5-004) |

Not in nav (opened from links): `/lab/orders/{order_id}/labels`, `/lab/orders/{order_id}/results`, `/lab/specimens/{specimen_id}`, `/lab/worksheets/{worksheet_id}`, `/lab/critical-values/{critical_event_id}`, `/lab/ingest-exceptions/{exception_id}`.

## 2. Components (`@lims/ui` only — 02-CV §14)

All components come from the published kit (C0 04-UI-UX §2, 08 §4.6), mapped to existing names per 08 R22. No component is missing and none is built locally (02-CV §14).

| Component | Used for |
|---|---|
| `PageShell`, `PageHeader` (`helpKey` required → in-app help panel of the C0 shell) | every page; in-app help per screen |
| `Button`, `IconButton`, `ButtonGroup` | actions |
| `TextField`, `TextArea`, `Select`, `Combobox`, `Checkbox`, `Switch`, `RadioGroup`, `DateTimePicker`, `DecimalField` | forms |
| `DataTable` (keyboard row navigation, cursor "Load more", selection) | lists |
| `EditableGrid` (C3-requested kit component: cell editing, per-row status/error cell — 08 §4.6) | result entry |
| `BarcodeInput` / `useScanCapture` (C0 04-UI-UX §2.4; kit defaults) | receive, collect, dispatch, exception assign |
| `TimeSeriesChart` with `referenceBand` (hidden data-table alternative built in) | trend |
| `PrintFrame` (print-only iframe, `@media print`) | labels, worksheets |
| `BarcodeSymbol` (Code 128 SVG, 08 §4.6; value never logged) | labels, worksheet barcodes |
| `Dialog`, `ConfirmDialog`, `Drawer` (side panel) | reject, aliquot, amend, history |
| `Tabs`, `Card`, `DescriptionList`, `Timeline` | detail pages |
| `Badge`, `StatusChip` (kinds `specimen`, `result`, `generic`), `FlagBadge`, `ResultValue` (icon + text, never colour only) | statuses, flags |
| `IdText` | instrument ids when the C7 name cannot be read (08 A13 D-14) |
| `Banner`, `useToast`, `EmptyState`, `ErrorState`, `LoadingSkeleton` | states |
| `FilterBar`, `Chip` | filters |
| `KeyboardShortcutsDialog` | `?` help |
| `Tooltip` | abbreviations |

Mapping applied (08 R22, finding C5 #16): `ScanInput` → `BarcodeInput`/`useScanCapture`; `LineChart` → `TimeSeriesChart`; `PrintLayout` → `PrintFrame`; `StatusPill` → `StatusChip`; `AppShell` → `PageShell`; `HelpPanel` → `PageHeader.helpKey`.

Instrument names (08 A13 D-14): wherever a screen shows or filters by instrument, the BFF reads C7 `GET /v1/instruments/instruments` (E23, `instruments.instrument.read`; `pathologist` added to that permission). On `403` the screen shows `IdText` (8-char id) and the instrument filter is hidden.

## 3. Screens

Common to all screens:
- Loading: `LoadingSkeleton` rows (table) or blocks (forms).
- Error: `ErrorState` title "Something went wrong", body "Please try again. If it keeps happening, give this reference to support: {request_id}", button "Retry".
- Permission denied: `ErrorState` "You don't have access to this screen." (no Retry).
- Not found: "This item doesn't exist or isn't visible to you." (same text for other-tenant ids — REQ-SEC-044 parity).
- `version_conflict`: Banner "This item was changed by someone else. Reload to see the latest." + "Reload".
- Help: the shell's help panel (from `PageHeader.helpKey`) opens with F1 or the "?" icon; content from `features/lab/help/<screen>`.

### 3.1 Label page `/lab/orders/{order_id}/labels`

Layout: header (registration no, patient display, priority — from the `printSpecimenLabels` response) · specimen list (checkbox per specimen: barcode, ready / not printable; type, container and tests once labels are loaded) · options (copies 1–5, default `label_copies_default` from the `printSpecimenLabels` response) · buttons "Print labels" (primary, reprint), "Mark selected collected" (if `lab.specimen.collect`) · print region (`PrintFrame`, hidden on screen). On open the page waits for readiness (`requestOrderLabelPrint`), calls `printSpecimenLabels` and prints once without a click (08 A13 D-4).

| Field | Type | Validation | Default |
|---|---|---|---|
| Specimen selection | checkboxes | ≥1 selected | all active specimens |
| Copies | `Select` 1–5 | integer | `label_copies_default` (from the `printSpecimenLabels` response) |

Label layout (per label, `label_width_mm × label_height_mm`, default 50×25):
```
┌───────────────────────────────────────┐
│ ★ URGENT   TEST PATIENT 0042 (24 ch)   │  line 1: urgent mark (if any) + name
│ 43Y/M   0001SY000001   EDTA_WB  LAV    │  line 2: age/sex, reg no, specimen type, container
│ ║█║║█║█║║║█║█║║█║║║█║█ (Code 128)       │  barcode, ≥ 8 mm high
│ E2600000042        CBC ESR HBA1C +2    │  human-readable barcode + test codes
│ Coll: 05/11/2026 08:31 AM              │  if collected
└───────────────────────────────────────┘
```
Copy: auto-print waiting "Preparing labels…"; timeout "Labels are not ready yet. Try again in a moment." (Retry); inactive "Not printable (order cancelled)"; too small "Label too small for this barcode — increase label size in Lab settings."; success Toast "Sent {n} labels to the printer dialog."
Keyboard: Ctrl+P print; Space toggles focused specimen; Alt+C mark collected.

### 3.2 Collect & dispatch `/lab/collect`

Tab **Collect**: `BarcodeInput` "Scan barcode or enter registration number" (a value matching the barcode pattern is looked up as `{barcode}`, otherwise as `{registration_no}`, both in the lookup body) → specimen list for that order (status `ordered`) → "Collect selected" (Enter). Empty: "Scan a label to start." Success: "Collected {n} specimens."
Tab **Dispatch**: `BarcodeInput`; each scan adds a row (barcode, patient display, type, status must be `collected`, else row error "Not ready to dispatch (status: {status})"); "Dispatch {n} specimens" (Ctrl+Enter); "Clear list". Max 200 rows (bulk limit).

### 3.3 Receive `/lab/receive`

Regions: top bar (Receiving location `Select`, required; Auto-accept `Switch`) · `BarcodeInput` with `useScanCapture` (autofocus, always refocused after an action) · current specimen card · session log table.

Card fields: barcode, registration no, patient display, specimen type/container, collected at/by (or "Home collection"), tests with urgent ★, warnings (Banner): "Collection barcode was not verified on the phlebotomy app" (`collection_barcode_unverified`), "Order cancelled — do not process" (inactive), "Rejected on {date}: {reason}".

Buttons: Accept (Enter), Reject (R), Aliquot (A, only after accept), Open specimen (O).

Reject dialog:
| Field | Type | Validation | Default |
|---|---|---|---|
| Reason | `RadioGroup` of active `rejection_reasons` | required | none |
| Comment | `TextArea` | ≤500 chars | empty |
| Request recollection | `Checkbox` | — | `recollection_default` |
Copy: title "Reject specimen {barcode}"; confirm "Reject" (danger); success "Specimen rejected. New barcode {new_barcode} created for recollection." / "Specimen rejected."

Aliquot dialog: number of aliquots (1–10), per aliquot: specimen type (optional `Select`), tests (`Checkbox` list from parent tests not approved/cancelled, ≥1). Success "Created {n} aliquots" + "Print labels" button → label page with specimen ids.

Scanner behaviour [ASSUMPTION scanners are USB HID keyboard-wedge with Enter suffix — confirm per site]: the kit's `BarcodeInput`/`useScanCapture` with its defaults (C0 04-UI-UX §2.4: `scannerMaxInterKeyMs` 30, `minScanLength` 4, pattern `^[A-Z0-9]{1,20}$`, upper-casing and trimming, kit invalid message, duplicate scan within 1,500 ms ignored); C5 sets no own timings. While a dialog is open the screen passes `enabled: false` to `useScanCapture`, and a scan announces "Close the dialog before scanning" (aria-live).

Session log columns: time, barcode, outcome (Received / Rejected / Error: {title}), by. Last 50 rows kept in memory only.

### 3.4 Worklists `/lab/worklists` and `/lab/worklists/{department_id}`

Picker: department cards with counts (open, urgent). Worklist table columns:

| Column | Content |
|---|---|
| ★ | "★ Urgent" text when priority urgent (icon + visible text, sr-only not used alone) |
| Barcode | specimen barcode |
| Reg no | registration no |
| Patient | name, age/sex |
| Test | test code + name |
| Status | `StatusChip` in_process / resulted / verified |
| Received | date/time |
| Age since received | hh:mm |
| TAT target | hh:mm or "—" |
| Flags | H/L/HH/LL/Δ/Hold text badges |

Filters (`FilterBar`): instrument (`Select` of the C7 instrument list, 08 A13 D-14; hidden on 403; free UUID not offered), priority (All/Urgent/Routine), status (multi), processing centre. Sort default: urgent first, then received ascending.
Row actions: Enter = open order result grid filtered to the department; Space = select; Alt+W = create worksheet from selection (browsers reserve Ctrl+W) (dialog: title ≤80, required).
Empty: "No pending tests for this department."

### 3.5 Pending `/lab/pending`

Columns: ★, reg no, patient, test, department, item status (Awaiting collection / Awaiting receipt / In process / Resulted / Verified), age (header states the anchor: "Age since registered" for awaiting rows, "Age since received" otherwise — glossary TAT rule), TAT target, "Over target" text badge.
Filters: department, status, priority, centre, Over target only. Empty: "Nothing pending."

### 3.6 Result entry grid `/lab/orders/{order_id}/results`

Regions: header (reg no, patient display, referrer, priority ★, specimen chips with barcode + status) · grid (grouped by test, then `reportSubheading`) · side panel (history, Drawer, toggled F2) · footer action bar (Save, Save & verify, Approve, Return, Amend; buttons shown by permission).

Grid columns:
| Column | Editable | Notes |
|---|---|---|
| Analyte | no | name + code; "Calculated" tag for formula analytes |
| Value | yes while `pending`/`resulted` and not calculated; read-only when `verified` (return first), `approved` (amend), `cancelled` | `DecimalField` (numeric; decimals from catalog; shows unit), `Select` (ordinal/coded: `ordinalSetValues` display text in `sortOrder`, 08 A13 D-9), `TextArea` (text ≤2000) |
| Unit | no | |
| Flag | no | text badges "Low", "High", "Critical low", "Critical high", "Abnormal" (00 §4 uses "High"/"Low") |
| Ref range | no | snapshot text "low – high" or range text; when `range_unavailable_age_unknown` (08 A17.1): "Age unknown — reference range and critical check not applied" (warning badge, text not colour only) |
| Δ | no | "Δ +1.2 vs 4.0 (3 d ago)" when fail; "No previous" muted |
| Previous | no | last approved value + date |
| Comment | yes | short-code expansion (below) |
| Status | no | Pending / Resulted / Verified / Approved v{n} / Cancelled; "On QC hold"; "QC review" |
| Origin | no | Instrument / Manual / Calculated / Module |

Short codes: typing `:` followed by 1–16 `[A-Z0-9_]` and Space or Tab triggers C3 `GET /v1/catalog/comment-codes?code_prefix=` (`listCommentCodes`, #57, `catalog.test.read`) via the BFF; the server re-resolves the codes on save with `CatalogPort.resolveCommentCodes`; on hit the token is replaced by the text and the code is recorded; on miss the token stays and an inline hint "Unknown code {code}" shows; Ctrl+Space opens the code picker (search by prefix).

Calculated rows: value cell read-only; shows result or "Waiting for: {codes}" or "Not calculated: {reason}"; Tooltip lists provenance (expression, inputs with values).

Keyboard (all documented in `KeyboardShortcutsDialog`, opened with `?`):
| Key | Action |
|---|---|
| Enter / ↓ | next editable row (same column) |
| Shift+Enter / ↑ | previous row |
| Tab / Shift+Tab | next/previous cell in row |
| Ctrl+S | save all edited rows |
| Ctrl+Enter | save, then verify rows of the focused test |
| F2 | toggle history panel for the focused analyte |
| F3 | open trend chart for focused analyte |
| Ctrl+Space | short-code picker |
| Alt+A | approve selected (approve mode) |
| Alt+R | return focused result (reason dialog) |
| Alt+M | amend focused approved result |
| Alt+N / Alt+P | next / previous order from the worklist context |
| Esc | cancel current cell edit |

Validation copy (inline under the cell, `aria-describedby`): "Enter a number with up to {n} decimals.", "Choose one of the listed values.", "Text is limited to 2,000 characters.", locked "Approved results can only be changed by amendment."
Unsaved changes guard: leaving the page with edits → ConfirmDialog "You have unsaved results. Leave without saving?"

Verify prompt (rows with delta/critical/unit/instrument flags): Dialog listing each flagged row with checkboxes "I have reviewed the delta" / "critical value" / "unit mismatch" / "instrument flag"; Verify button disabled until all ticked.

Amend dialog:
| Field | Type | Validation |
|---|---|---|
| New value | same editor as grid | required, must differ |
| Reason | `Select` from `amendment_reasons` (excluding the module-only codes `module_phase_progression`, `module_preliminary_update`, `supplementary_report` — 08 R1, 08 A17 D-61) | required |
| Reason detail | `TextArea` ≤500 | optional |
| Comment codes/text | as grid | optional |
Copy: "Amend {analyte} (current v{n}: {value})"; warning "This creates version {n+1}. The released report will be superseded."; success "Amended to version {n+1}."

Return dialog: reason (`Select` `return_reasons`, required), comment (≤500). Success "Returned for correction."

Approve: if `auth.mfa_required`, BFF starts step-up (C2 flow) then retries. `lab.self_approval_forbidden` copy: "You verified this result. Another pathologist must approve it." `lab.critical_ack_required`: "Record the critical-value notification before approving." with link to the critical event.

### 3.7 History panel and trend

History (Drawer, right): table of last 5 approved results (date, value, unit, flag, version). Empty: "No previous results for this patient."
Trend (Dialog): `TimeSeriesChart` x = approved date, y = value; reference band from current snapshot; points with a different unit listed below in a table "Not plotted (different unit)"; accessible data table toggle "Show as table". Empty: "Not enough history to draw a trend (needs 2 results)."

### 3.8 Verification `/lab/verification` and approval `/lab/approval`

Table columns: ★, reg no, patient, test, analyte count, flags (incl. "Age unknown — reference range and critical check not applied" for any result with `range_unavailable_age_unknown`, 08 A17.1), resulted at (verify) / verified at + verifier (approve), department. Filters: department, priority, flagged only. Bulk select (Space, Shift+↓), "Verify {n}" / "Approve {n}". Per-id outcome summary dialog after bulk: "{ok} done, {failed} not done" with reasons. Empty: "Nothing waiting for verification." / "Nothing waiting for approval."

### 3.9 Critical values

List columns: detected at, age since detected (live), reg no, patient, analyte, direction text ("Critical high"), status (Open / Notified / Closed), notifications count. Open rows first. Empty: "No critical values."
Detail: value + unit + limits; patient; referrer (`referrer_display_name` from `getCriticalValue`); result link; notifications `Timeline`; form:
| Field | Type | Validation | Default |
|---|---|---|---|
| Notified party | `Select` referrer/clinician/ward/patient/other | required | referrer if present |
| Name | `TextField` | 1–120 | referrer name if present |
| Contact method | `Select` phone/sms/in person/whatsapp/other | required | phone |
| Contact detail | `TextField` | ≤60 | — |
| Notified at | `DateTimePicker` | ≤ now+5 min | now |
| Outcome | `RadioGroup` reached/not reached/left message | required | — |
| Read-back confirmed | `Checkbox` | — | unchecked |
| Read-back text | `TextArea` | 1–300; required when read-back confirmed (API `400` path `/read_back_text`; DB CHECK) | — |
| Comment | `TextArea` | ≤500 | — |
Copy: success "Notification recorded."; note under form "Entries cannot be edited or deleted."

### 3.10 Instrument exceptions

List columns: received at, instrument (C7 name or `IdText`), reason (text: Unknown barcode / Code not mapped / Specimen rejected / Result approved / Result already verified / Not yet received / Test not ordered / Unit mismatch), barcode, code, value, attempts, status. Filters: reason, instrument, status. Empty: "No open instrument exceptions."
Detail actions: Assign (`BarcodeInput` or registration search, both through the lookup body → pick result row; analyte mismatch requires checkbox "Apply to a different analyte"), Re-apply, Discard (reason `Select` `exception_discard_reasons`, comment ≤300). Copy for result_locked: "This result is approved. To use the new value, a pathologist must amend it."

### 3.11 Status board

Table columns: reg no, patient, centre, status (`StatusChip` kind `generic`: Waiting / Collected / In lab / Ready / Printed / Printed (partial) / Printed (preliminary)), badge "Sample rejected", urgent ★, last change, released at. Filters: date range (required, ≤7 days), centre, status chips. Auto-refresh 30 s with "Updated {time}" text and pause toggle. Empty: "No registrations in this period."

### 3.12 QC results

Header text: "QC results (captured — rules arrive with the QC module)". Columns: time, instrument, analyte, control, lot, level, value, unit, source (Instrument / Manual). No pass/fail, no colours (06-GLOSSARY QC data capture). Add dialog fields per API #44 (all required except lot/level/unit): centre (`Select` of the user's centres), instrument (`Select` of the C7 list, D-14), analyte, control id/lot/level, value, unit, result time. Empty: "No QC results captured."

### 3.13 Lab settings

Tabs: **General** (fields per 02-TRD §9.1 with ranges as validation), **Delta rules** (table: analyte, window, abs, pct, unit, version, effective from, active; "New rule", "New version", "Deactivate"), **Reason codes** (set selector; rows code/display/order/active/source; global rows editable only by overriding display/active), **QC holds** (list; Release with comment — Phase 2 copy "Holds are created by the QC module").

### 3.14 Specimen detail

`DescriptionList` (barcode, type, container, status, centre, processing centre, parent/replaces links, label prints) · `Timeline` of transitions (state, time, by) · tests table · actions by state and permission (Store: location ≤120; Discard: reason ≤200 — also offered for a `recollection_ordered` tube, 08 A13 D-15; Reject; Recollect; Aliquot; Print label).

### 3.15 Worksheet print

Print layout A4 portrait [CONV]; header (title, department, instrument name or `IdText`, created by/at, page x/y); rendered in `PrintFrame`; table: #, barcode (text + small Code 128), reg no, patient (name, age/sex), test, priority ★, blank "Result" and "Remarks" columns. Footer "Printed {datetime} — snapshot; check the worklist for current status."

## 4. Accessibility

- Every input has a visible label; errors linked with `aria-describedby`; grid cells expose row/column headers (`role="grid"`).
- Status, flags and priority always carry text (no colour-only — 02-CV §14).
- Scan results and bulk outcomes announced via `aria-live="polite"`; critical values detected while on a screen announced `assertive` [CONV].
- Focus is returned to `BarcodeInput` after each receive action; dialogs trap focus and restore it.
- Minimum target size 24×24 px (WCAG 2.2 AA).

## 5. Responsive rules

- Staff screens target desktop ≥1280 px; usable down to 1024 px (tables scroll horizontally with sticky first column).
- Status board and critical-value list usable on tablets ≥768 px (single-column cards).
- Print views (labels, worksheet) ignore screen breakpoints.

## 6. Help and manual

Each screen ships `features/lab/help/<screen>.md` (in-app) and `docs/manual/lab/<screen>.md` (user manual) covering purpose, steps, shortcuts, error messages (01 §2 training note; 04 L26 ढ applies to billing but the program rule extends it).

Final sweep 2026-11-06 — second touch applied (§1 route `staff.lab.ingest_exceptions` (CR-C7-014); §3.6/§3.8 08 A17.1 age-unknown text; §3.6 amend dialog excludes `module_preliminary_update` (D-61)).
