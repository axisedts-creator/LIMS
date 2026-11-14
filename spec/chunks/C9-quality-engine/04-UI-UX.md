# C9 Quality Engine — 04 UI / UX

Status: DECISION, 2026-11-06. Staff web only (`apps/web`, route segment `(staff)/quality`). Components **only** from `@lims/ui` (C0 04-UI-UX §2); one new kit component is requested (CR-C9-007 `ControlChart`). Message keys `quality.<screen>.<key>`; English v1 (02-CV §13). Dates/times through `DateText` (tenant `calendarDisplay`, default A.D.; `DD/MM/YYYY hh:mm A`, Asia/Kathmandu).

## 1. Global rules

| Topic | Rule |
|---|---|
| Shell | `PageShell` + `PageHeader` (with `helpKey` on every page — in-app help, 02-CV §14) |
| Status words | Always text + chip, never colour alone: `StatusChip kind="generic"` with labels **In control**, **Warning**, **Out of control**, **No QC data**, **Collecting**, **Accepted**, **Accepted (warning)**, **Incomplete**, **Rejected**, **Closed**; rule-set versions: **Draft**, **Simulating**, **Stopped**, **Active**, **Retired**, **Discarded** |
| TAT wording | Every TAT number is shown with its segment label: "Within lab (received → first verified result)" or "Total (registration → report released)" (glossary "TAT") |
| Phase-1 honesty | While `LIMS_QUALITY_ENABLED=false`, the nav entry is hidden and pages return the feature-disabled state: "The QC module is not switched on for your lab yet." |
| Polling | status board and LJ chart 15 s, TAT alerts 30 s [CONV], only while the tab is visible (`document.visibilityState`); "Updated hh:mm:ss" text next to the title |
| Keyboard | All actions reachable without mouse; `?` opens `KeyboardShortcutsDialog`; `Ctrl+Enter` submits the open form (kit default); `Esc` closes drawers/dialogs; table keys are the kit's (C0 04-UI-UX §2.5) |
| Barcode scanner | Not used in C9 (no specimen handling) |
| PHI | C9 screens show no patient names, barcodes or registration numbers. Links to C5 pages use `buildRoute('staff.lab.specimen', …)` / `buildRoute('staff.lab.order_results', …)` |
| Numbers | QC values and targets: `ResultValue` with analyte `decimals`; z-scores 2 dp (the API sends 3 dp, stores 6 dp — 02-TRD §5.10); percentages 0 dp |
| Responsive | ≥ 1280 px: full tables. 1024–1279: hide columns marked `hideBelow: 'xl'`. < 1024: tables become card lists (kit behaviour), charts full width, side drawers become full-screen dialogs. Minimum supported width 768 px (tablet at the bench) [CONV] |

### 1.1 Nav manifest (`apps/web/src/features/quality/nav.manifest.ts`)

| Entry | Path | Permission |
|---|---|---|
| QC status | `/quality` | `quality.qc_run.read` |
| QC runs | `/quality/runs` | `quality.qc_run.read` |
| Levey-Jennings | `/quality/lj` | `quality.qc_run.read` |
| Unassigned QC | `/quality/observations` | `quality.qc_run.read` |
| QC set-up | `/quality/setup/materials` (tabs) | `quality.qc_run.read` (writes need `quality.qc.manage`) |
| Auto-verification | `/quality/autoverify` | `quality.autoverify.read` |
| TAT alerts | `/quality/tat-alerts` | `quality.tat_alert.read` |
| Quality settings | `/quality/settings` | `quality.qc_run.read` |

Badge on "TAT alerts": number of rows on the first page of #48 filtered `level=breached,escalated&acknowledged=false` (limit 50), shown as "50+" when the page is full [CONV] (no count endpoint, 02-CV §4.3). Badge on "QC status": number of rows on the first page of #28 filtered `needs_action=true`.

## 2. Screens

### 2.1 QC status board — `/quality`

Layout: `PageHeader` (title "QC status", actions: "Set up QC" if `quality.qc.manage`) · `FilterBar` · `DataTable`.

Filters: instrument (`Select`, from directory/BFF), status (`Select` multiple: In control / Warning / Out of control / No QC data), "Overdue only" (`Checkbox`).

| Column | Content | Notes |
|---|---|---|
| Instrument | label (code + name) | `isRowHeader` |
| Analyte | code + name | |
| Status | `StatusChip` | violated rules as text after the chip, e.g. "Out of control · 1-3s" |
| Last in-control QC | `DateText withTime` | "—" if none |
| Open failures | count with link to run list filtered `needs_action=true` | |
| QC overdue | "Overdue" `Badge` (tone warning) or empty | AC-09.5 |
| Patients since QC | integer | from `qc_activity` |
| Actions | menu: "LJ chart", "Runs", "Plan" | |

Row action (Enter/double-click) opens the LJ chart for that plan. Empty: title "No QC plans yet", body "Set up control materials, a QC plan and targets to start evaluating QC.", action "Set up QC". Error: `ErrorState` "We couldn't load QC status." Banner when any row is Out of control: tone danger, "{n} instrument/analyte pairs are out of control. Patient results are held in Lab until released."

### 2.2 QC runs — `/quality/runs`

Filters: instrument, analyte (`Combobox` via C3), status (Collecting/Evaluated/Closed), outcome (multi), "Needs action" (`Checkbox`), run date range (`DateRangePicker`, max 92 days [CONV]; the API enforces the same span on #28 and returns `400 common.validation_failed` beyond it).
Columns: Run time (`DateText`), Instrument, Analyte, N (`controls_per_run`), Mode (Classic/Modern), Observations ("2 / 2"), Outcome chip, Rules (text list), Needs action (from `needs_action_reason`: `corrective_action` → "Corrective action needed", `rerun` → "Rerun needed"; absent → —), Closed at. Sort: run time desc only. Empty: "No QC runs match these filters."

### 2.3 QC run detail — `/quality/qc-runs/{qc_run_id}` (route `staff.quality.qc_run`)

Regions: header (title "QC run · {analyte code} · {instrument}", status chip, actions) · `DescriptionList` (Run time, Plan version, N, Mode, Mean rule, Complete yes/no, Evaluated at/by, Hold since, Last in-control run) · Observations `DataTable` · Rule hits list · Corrective actions `Timeline` · Reviews `Timeline`.

Observation columns: Level, Lot, Observed at (+ "server time" hint when basis = server), Value + unit, Target mean / SD, z (2 dp), Rule hits (text), Status.

Actions:

| Button | Visible when | Dialog / fields | API |
|---|---|---|---|
| "Evaluate now" (shortcut `E`) | status collecting, `quality.qc_run.review` | `ConfirmDialog` "Evaluate this run with {n} of {N} controls? It will be marked incomplete if no rule is violated." + optional comment `TextArea` max 500 | #30 |
| "Record corrective action" (`C`) | outcome rejected, not closed | `Dialog`: Action (`CodedSelect` `quality.corrective_actions`, required), Description (`TextArea`, required, 1–1000), Performed at (`DateTimePicker`, required, default now, min run_at − 24 h, max now + 5 min) | #31 |
| "Close run" | outcome rejected, not closed | `ConfirmDialog`; on 409 shows the code text: `corrective_action_required` → "Record a corrective action first."; `rerun_required` → "Run QC again and wait for an accepted run before closing." Success toast: "Run closed. Patient results held by this failure stay on hold until released in Lab › Settings › QC holds." | #32 |
| "Acknowledge" (`A`) | outcome accepted_warning | `Dialog`: Comment (`TextArea`, required, 1–500) | #33 |

Banner for rejected runs: tone danger, "This run was rejected ({rules}). Patient results for {analyte} on {instrument} since {hold_since} were put on hold in Lab."

### 2.4 Levey-Jennings chart — `/quality/lj`

Query state in URL: `plan_id`, `level_id`, `lot_id?`, `view`, `from`, `to` (UUIDs and dates only).
Controls row: Plan (`Combobox`, required), View (`RadioGroup`: "One level" / "All levels (SD units)"), Level (`Select`, required for One level), Lot (`Select`, "All lots" default), Period (`DateRangePicker`, default last 30 days, max 400 days).
Chart: `ControlChart` (CR-C9-007) — until merged, a `DataTable` of the same points with a note "Chart component pending; showing values as a table." Lines: Mean, +1SD, −1SD, +2SD, −2SD, +3SD, −3SD (labelled at the right edge with values, e.g. "+2SD 104.0"); step change at target changes with a vertical label "Target v{n} ({source})". Markers: accepted ●, warning ▲, rejected ✕ + rule text, excluded ○, unevaluated ◇, collecting ◌ (legend always visible). Point focus/hover tooltip: time, value, z, lot, run outcome, rules. Click/Enter → `Drawer` with observation details, "Open run", and "Exclude" (only when run collecting or no run; `quality.qc.manage`; `ConfirmDialog` with `requireReason` `quality.exclusion_reasons`, comment max 500).
Side panel (`Card`): current target (mean, SD, CV %, source, effective from), N and rule set ("1-2s warning; 1-3s, 2-2s, R-4s, 4-1s, 10x"), mode.
Empty: "No QC values in this period." Truncation banner: "Showing the newest 2,000 points. Narrow the period to see all."

### 2.5 Unassigned QC — `/quality/observations`

Filters: status (multi: Unmapped analyte, No plan, Unmapped control, Level not in plan, Lot expired, No target, Unit mismatch, Late), instrument, observed date range (≤ 92 days; enforced by #26 as well).
Columns: Observed at, Instrument, Analyte (or "Not mapped in catalog"), Control id (raw), Lot (raw), Level (raw), Value, Status (plain-language), Fix (button per status: "Create control map" → maps form pre-filled with instrument + raw id/lot; "Create QC plan"; "Add target"; for Unmapped analyte: text "Map the instrument code in Instruments › Code maps").
Empty: "All QC values are assigned."

### 2.6 QC set-up — `/quality/setup/{materials|maps|plans|targets}` (`Tabs`)

**Materials tab.** Table: Code, Name, Manufacturer, Levels (count), Lots expiring ≤ 30 days (`lots_expiring_30d`, warning badge when > 0), Active. "New material" `Dialog`:

| Field | Component | Validation | Required | Default |
|---|---|---|---|---|
| Code | `TextField` maxLength 32 | `^[A-Z0-9_-]{2,32}$` (uppercased on input) | yes | — |
| Name | `TextField` 120 | 1–120 | yes | — |
| Manufacturer | `TextField` 120 | ≤120 | no | — |
| Matrix | `TextField` 60 | ≤60 | no | — |
| Levels (repeatable rows, 1–6) | `TextField` code (16, `^[A-Za-z0-9]{1,16}$`), `TextField` name (60), `IntegerField` sort 0–99 | unique code | ≥1 row | rows "1", "2" |

Lot dialog (per level): Lot number `TextField` 64 (printable ASCII, no leading or trailing space — same pattern as the API and DB, 02-TRD #8; message "Use printable characters without spaces at the start or end."), Expires on `DatePicker` (min today). 409 duplicate → field error "This code is already used." 422 lot expired → "Expiry date is in the past."

**Maps tab.** Table: Instrument, Control id (raw), Lot (raw or "Any lot"), → Material / Level / Lot, Active. "New map" dialog: Instrument (`Combobox`, required), Control id as sent by the analyser (`TextField` 64, required, hint "Exactly as the analyser sends it, e.g. QC-L2"), Lot as sent (`TextField` 64, optional, hint "Leave empty to match any lot"), Lot (`Select` grouped by material/level, required).

**Plans tab.** Table: Instrument, Analyte, N, Composition ("L1 ×1, L2 ×1"), Mean rule, Status, Version. "New plan" dialog:

| Field | Component | Validation | Default |
|---|---|---|---|
| Instrument | `Combobox` | required | — |
| Test | `Combobox` (C3 tests) | required | — |
| Analyte | `Select` (analytes of the test, numeric only) | required | — |
| Controls per run (N) | `RadioGroup` 2 / 3 / 4 | required | 2 |
| Composition | rows: Level (`Select`) + Count (`IntegerField` 1–4) | sum must equal N ("Counts must add up to N = {n}") | — |
| n-x rule | `Select` options by N (N=2/4: 8x, 10x, 12x; N=3: 6x, 9x) | required | 10x / 6x |
| 2-2s also across runs | `Switch` | — | on |
| Count rules across levels | `Switch` | — | on |
| Ignore rejected runs in history | `Switch` | — | on |
| Run window (minutes) | `IntegerField` 5–240 | — | 30 |
| QC valid for (hours) | `IntegerField` 1–168 | — | 24 |
| Hold look-back (hours) | `IntegerField` 1–168 | — | 24 |

A read-only preview under the form shows the resulting rule set text and the tenant mode: "Rules: 1-2s warning; reject on 1-3s, 2-2s, R-4s, 4-1s, 10x. Mode: Classic (set in Admin › Tenant settings)." Warning on save response `instrument_code_unmapped`: `Banner` tone warning "This analyte has no code map for this instrument in Catalog; QC values will arrive unmapped until it is added." Activate button → on 422 `qc_target_missing`: "Add an active target for every level in the plan first." with link to Targets tab.

**Targets tab** (requires plan selection `Combobox`). Table: Level, Lot, Mean, SD, CV %, Unit, Source (Manufacturer / Established (n = 25)), Status, Effective from–to. Actions: "New target" dialog (Lot `Select`, Mean `DecimalField` decimals = analyte decimals + 2, SD `DecimalField` > 0, Unit read-only from analyte, Source shown as read-only text "Manufacturer" (manual targets are always manufacturer values; established targets come only from the wizard — 02-TRD #21), Note `TextArea` 500); "Establish from data" wizard (Step 1 lot + period; Step 2 preview: n, mean, SD, CV, and a point table with checkboxes to exclude; Step 3 confirm → draft); row actions Activate (`ConfirmDialog` "Activate this target from now? The current target for this lot will be superseded."), Retire (reason), Discard (draft only).

### 2.7 Auto-verification — `/quality/autoverify`

Header status line: "Auto-verification is ON/OFF for your lab (Admin › Tenant settings)" (read-only from #51). Cards: Active version (number, activated by/at, rule count), Simulating version (started at, days running, decisions so far, "Open report"). Versions table: Version, Status chip, Rules, Created by/at, Simulation period, Activated by/at. Buttons: "New version" (copy active, copy any version, or empty).

### 2.8 Version editor — `/quality/autoverify/{version_id}`

Draft: rules `DataTable` with inline row editing in a `Drawer` form:

| Field | Component | Validation | Required | Default |
|---|---|---|---|---|
| Key | `TextField` 40 | `^[A-Za-z0-9_-]{1,40}$`, unique | yes | generated `R1`, `R2`… |
| Test | `Combobox` (C3) | — | yes | — |
| Analyte | `Select` (numeric analytes of the test) | — | yes | — |
| Instrument | `Combobox` with "Any instrument" option | (analyte, instrument) unique | no | Any |
| Enabled | `Switch` (off = "Never auto-verify this analyte on this instrument") | — | yes | on |
| Lower limit / Upper limit | `DecimalField` (analyte decimals) | ≥1 of the two; low ≤ high | one required | — |
| Allowed range flags | `Checkbox` group N (Normal), L (Low), H (High) | ≥1 | yes | N |
| Instrument flags to ignore | `TextField` chips (≤20, each ≤16) | exact text | no | none |
| Allow when QC shows a warning | `Switch` | — | — | off |
| Note | `TextField` 200 | — | no | — |

Fixed rules box (read-only text): "Never auto-verified, whatever the rules: critical results, delta-check failures, results without an instrument (manual or calculated), results while QC is out of control or missing. Auto-verification replaces only the technologist's first verification; a pathologist always approves." Save → #39 (errors mapped to row + field). "Start simulation" (`ConfirmDialog`). Every write on this screen and on §2.7 (#37 New version, #39 Save, #40 Start simulation, #41 Stop, #43 Activate, #44 Retire, #45 Discard) handles `403 auth.mfa_required` with the kit step-up flow from C2 and then retries the same request once.
Simulating: read-only rules + Simulation report (`StatTile`s: Days running, Decisions, Would allow, Would deny, Allowed and later verified by staff; `BarChart` deny by reason; sample `DataTable`: decided at, analyte, shadow decision, reasons, live decision (`live_decision`, "—" when there was no live decision), verified by staff at, "Open results" link). Opening the report writes an access-log entry (server side). Buttons "Stop simulation" (`ConfirmDialog`: "Stop this simulation? The version will be closed for good. To simulate again, copy it into a new draft."), "Activate" (disabled with tooltip until minimums met: "Needs {d} more days / {n} more decisions"). Activate `ConfirmDialog` requires typing ACTIVATE (`TextField` maxLength 8) and explains "You can't activate a version you created."; Active: "Retire" with reason (500). Stopped: read-only rules, the simulation report, and "Copy to new draft" (#37 `copy_from_version_id`); status chip "Stopped".

### 2.9 Decisions — `/quality/autoverify/decisions`

Filters: period (`DateRangePicker` ≤ 31 days, required, default today), mode (Live/Shadow), decision (Allow/Deny), reason (`Select` of reason labels), analyte, instrument.
Columns: Decided at, Mode, Decision chip, Reasons (plain labels: "Instrument flag", "Outside auto-verify limits", "Critical", "Delta failure", "QC out of control", "QC warning", "No QC data", "Manual or calculated result", "No rule", "Switched off"), Analyte, Instrument, Version. Row → `Drawer` with inputs (value, range flag, delta, critical, flags, resulted at), QC status + run link, matched rule key. Opening the drawer writes an access-log entry `autoverify_decision.view` (server side, #47). Empty: "No decisions in this period."

### 2.10 TAT alerts — `/quality/tat-alerts`

Filters: level (Warning / Breached / Escalated), acknowledged (Yes/No, default No), segment, department, centre, priority. Default sort: level desc, then % of target desc.
Columns: Level chip ("Escalated" tone danger, "Breached" tone danger, "Warning" tone warning), Test (code), Department, Priority ("Urgent" badge), Centre, Segment (short label with tooltip of full definition), Started (`DateText withTime`), Elapsed / target ("4 h 12 min / 4 h"), % of target, Acknowledged (by/at or "—"), Actions ("Acknowledge" `A`, "Open specimen" → `staff.lab.specimen`).
Acknowledge dialog: Note (`TextArea`, optional, ≤500). After a higher level is reached, the row shows "New level since acknowledgement".
Empty: "No open TAT alerts." Error: `ErrorState`.

### 2.11 Quality settings — `/quality/settings`

Sections (`Card`s): TAT alerts (Enabled `Switch`; Warning at % `IntegerField` 50–99; Escalate at % `IntegerField` 101–1000; Close orphan clocks after h `IntegerField` 1–720), QC (Minimum points to establish a target `IntegerField` 2–500, hint "Common practice is about 20; check your SOP."; Re-process window days 1–30; default plan options), Auto-verification (Minimum simulation days 1–90; Minimum shadow decisions 10–100000), Read-only from tenant settings (Westgard mode, Auto-verification on/off, with link text "Change in Admin › Tenant settings"). Coded sets tab: Corrective actions / Exclusion reasons tables (code, display, order, active, source) with edit dialog (display 1–120, sort 0–999, active).

## 3. Components

Used (all `@lims/ui`): `PageShell`, `PageHeader`, `Tabs`, `FilterBar`, `DataTable`, `StatusChip`, `Badge`, `Banner`, `Card`, `Grid`, `Stack`, `Inline`, `DescriptionList`, `Timeline`, `StatTile`, `BarChart`, `Drawer`, `Dialog`, `ConfirmDialog`, `Form`, `TextField`, `TextArea`, `IntegerField`, `DecimalField`, `Select`, `CodedSelect`, `Combobox`, `Checkbox`, `RadioGroup`, `Switch`, `DatePicker`, `DateTimePicker`, `DateRangePicker`, `DateText`, `ResultValue`, `IdText`, `Tooltip`, `EmptyState`, `ErrorState`, `LoadingSkeleton`, `useToast`, `KeyboardShortcutsDialog`, `VisuallyHidden`.

Missing → CR: `ControlChart` (CR-C9-007, props in 02-TRD §16). No local look-alikes (02-CV §14).

## 4. Accessibility

- WCAG 2.2 AA (02-CV §14). LJ markers differ by shape and text label; status chips carry words.
- Charts have a visually hidden data table (kit rule) and an accessible summary sentence: "{n} points, {k} rejected, current target mean {m}, SD {s}."
- Dialog focus moves to the first field; errors linked by `aria-describedby`; `ErrorSummary` on submit.
- Live regions: polling updates announce only changes in the count of out-of-control pairs / open escalated alerts (`aria-live="polite"`), never every refresh.

## 5. Operator and developer experience (non-UI surfaces)

- **Runbook entries** (`docs/manual/quality/runbook.md`): "QC rejected but C5 shows no hold" (check `evt.lab.quality.qc_run.rejected.v1` dead letters), "QC values not appearing" (check `lims_quality_unassigned_observations{status}` and the Unassigned QC page; sync lag alert), "Auto-verify never allows" (tenant switch, active version, QC plan coverage — `deny_by_reason` in decisions).
- **API style**: follows 02-CV §4; every example in `quality.yaml` uses synthetic ids (`01a1a98a-ac40-7000-8000-…`).
- **User manual pages** (`docs/manual/quality/`): status board, runs and corrective actions, LJ charts, set-up (materials → maps → plans → targets), auto-verification (simulation, four-eyes activation), TAT alerts, settings.
