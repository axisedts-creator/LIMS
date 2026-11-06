# C10 Microbiology — 04 UI/UX (staff web)

Status: DECISION, 2026-11-06. Screens live in `apps/web/src/app/(staff)/micro/` with components in `apps/web/src/features/micro/`. Components **only** from `@lims/ui` (C0 04-UI-UX §2); message keys `micro.<screen>.<key>` (02-CV §13). English v1. Times shown in the tenant timezone, A.D./B.S. per `calendarDisplay` through `DateText`/`DateTimePicker`.

---

## 1. Navigation (`features/micro/nav.manifest.ts`)

```ts
export const navManifest: NavManifest = {
  module: 'micro',
  entries: [
    { id: 'micro.worklist', label: 'micro.nav.worklist', routeId: 'staff.micro.worklist',
      permission: 'micro.culture.read', group: 'laboratory', order: 60, icon: 'flask', chord: 'g u', phase: '2' },
    { id: 'micro.instrument_records', label: 'micro.nav.instrument_records', routeId: 'staff.micro.instrument_records',
      permission: 'micro.culture.read', group: 'laboratory', order: 61, icon: 'inbox', phase: '2' },
    { id: 'micro.settings', label: 'micro.nav.settings', routeId: 'staff.micro.settings',
      permission: 'micro.config.manage', group: 'laboratory', order: 62, icon: 'settings', phase: '2' },
    { id: 'micro.breakpoint_sets', label: 'micro.nav.breakpoint_sets', routeId: 'staff.micro.breakpoint_sets',
      permission: 'micro.breakpoint.manage', group: 'laboratory', order: 63, icon: 'table', phase: '2' },
  ],
};
```

Routes per CR-C10-006 (plus existing `staff.micro.culture`). Labels: "Microbiology", "Micro instrument data", "Micro settings", "Breakpoint tables". Icon names must exist in the kit's `IconName` set; if `flask`/`inbox`/`table` are absent, C0-0D CR (`IconName` additions) — fallback icon `activity`. Chord `g u` [CONV] must be unique across manifests (build check).

## 2. Screen: Micro worklist (`/micro/worklist`)

Layout: `PageShell` → `PageHeader` (title "Microbiology", `helpKey: micro.worklist`) → scan bar (`BarcodeInput`, label "Scan specimen barcode", autoFocus, `useScanCapture` enabled) → `Tabs` → `FilterBar` → `DataTable`.

| Tab id | Label | Statuses | Default sort |
|---|---|---|---|
| `setup` | Awaiting setup ({count}) | `awaiting_setup` | `received_at` |
| `incubating` | Incubating ({count}) | `incubating` | `next_read_due_at` |
| `workup` | Growth / work-up ({count}) | `growth_detected` | `next_read_due_at` |
| `amending` | Amending ({count}) | `amending` | `-updated_at` |
| `recent` | Recently submitted | `final_submitted`, `cancelled` with `updated_at_from = now − recent_window_days` | `-updated_at` |

Filters (`FilterBar`): Centre (`select`; options from C2 `listCentres` — GET `/v1/identity/centres?is_active=true` through the BFF under the user's `identity.centre.read` (08 A13 D-16); hidden when that call returns 403; review m#37), Received (`date_range`, max 31 days [CONV]), Reads overdue (`select` yes/no), Instrument data waiting (`select` yes/no).

Columns (`DataTable`, `density: compact`, caption "Microbiology cultures"):

| Column | Content | Sort key | Hide below |
|---|---|---|---|
| Barcode | `barcode` (monospace via `IdText`-style text, not copyable) or "—" | — | — |
| Reg no | from C5 (BFF) | — | `md` |
| Test | `test_code` · `test_name` | — | — |
| Specimen | specimen type + site | — | `lg` |
| Received | `DateText withTime` | `received_at` | — |
| Next read | `DateText withTime`; if overdue `Badge` "Read overdue" (text + icon) | `next_read_due_at` | — |
| Status | `StatusChip kind="generic"` with label from §9 | — | — |
| Reports | "P1, F2" style list of submitted versions (P = preliminary, F = final) | — | `md` |
| Instrument data | `Badge` with open count | — | `lg` |

Row action (Enter / double-click) opens the culture page. Empty states: setup "No specimens waiting for set-up." · incubating "No cultures incubating." · workup "No cultures with growth to work up." · amending "No amendments in progress." · recent "Nothing submitted in the last {n} days."

Scan behaviour (C0 §2.4): valid scan → BFF lookup (F-02). Messages: not found / no culture → inline `Banner tone="info"` "No microbiology culture for this specimen." (same text for unknown barcode and no culture — no existence oracle across modules); several → `Dialog` "Choose a culture" listing test name + status; invalid pattern → kit error "This doesn't look like a sample barcode". Barcode never in URL or logs.

## 3. Screen: Culture (`/micro/cultures/{culture_id}`)

Layout: `PageHeader` (title "{test_name}", breadcrumbs Microbiology › Culture, `status` = `StatusChip`, actions per state — 03-APP-FLOW §4.2, `helpKey: micro.culture`) → identity `Card` (`DescriptionList columns=3`: Patient (name), Age/Sex, Barcode, Reg no, Specimen type, Site, Received, Planted, Next read, Final due, Lab status) → banners → `Tabs` (Setup & plates · Reads & stains · Isolates & AST · Reports · Instrument data) → help panel.

Patient name/age come from C4 `getPatient` via the BFF; if the call fails or is forbidden, show "Patient details unavailable" (no retry storm; one Retry link).

Page shortcuts (registered with `shortcuts.register('micro.culture', …)`; none collide with Alt+N/M/H):

| Key | Action |
|---|---|
| `Alt+S` | Set up culture (awaiting_setup) |
| `Alt+R` | Record read |
| `Alt+G` | Record Gram stain |
| `Alt+I` | Add isolate |
| `Alt+A` | Focus the AST grid of the selected isolate |
| `Alt+P` | Preliminary report |
| `Alt+F` | Final report |
| `Alt+B` | Focus barcode scan (opens the scan dialog) |

### 3.1 Tab "Setup & plates"

Plates `DataTable` columns: No., Medium, Incubation, Planted, Parent plate, From isolate, Status. Row action "Discard plate" (ConfirmDialog). Button "Add plate" (dialog §3.1.2).

#### 3.1.1 Set-up dialog (`Dialog size=lg`, title "Set up culture")

| Field | Component | Required | Validation | Default |
|---|---|---|---|---|
| Plating protocol | `Select` (current protocols) | no | — | `suggested_protocol` |
| Specimen site | `CodedSelect codedSet="micro.specimen_sites"` | no | active code | protocol default site |
| Planted at | `DateTimePicker minuteStep=5` | yes | ≤ now, ≥ now − 72 h | now |
| Plates (repeater, 1..12) | per row: Medium `CodedSelect micro.media` (required), Incubation `TextField maxLength=120` | yes (≥1) | — | protocol media |

Buttons: "Set up" (primary, `Ctrl+Enter`), "Cancel". Success toast "Culture set up — first read due {time}".

#### 3.1.2 Add plate dialog
Medium (required), Incubation (≤120), Parent plate (`Select` of active plates, optional), From isolate (`Select` of isolates, optional — subculture), Planted at (default now). Success "Plate {n} added".

### 3.2 Tab "Reads & stains"

`Timeline` of observations (newest first): "{kind label} · plate {n} · {growth display} · {quantity}" / finding text (rendered as text node, line breaks preserved), actor, time, "{h} h after planting". Corrected entries show strikethrough + "Corrected" badge. Buttons: "Record read", "Record stain / microscopy".

Observation dialog:

| Field | Component | Required | Validation |
|---|---|---|---|
| Type | `RadioGroup` Plate read / Gram stain / Microscopy / Other | yes | — |
| Plate | `Select` active plates | plate read: yes | — |
| Growth | `CodedSelect micro.growth_codes` | plate read: yes | active |
| Quantity | `TextField maxLength=80` (e.g. "≥10^5 CFU/mL") | no | — |
| Finding | `TextArea maxLength=2000 rows=4` | gram stain/microscopy/other: yes | 1..2000 |
| Observed at | `DateTimePicker` | yes | ≤ now, ≥ planted_at (plate read) |

### 3.3 Tab "Isolates & AST"

Left: isolate list (`DataTable` single selection): Isolate no., Organism (or "Not identified"), Source (Manual/Instrument), Quantity, Reportable (Yes/No), Status. Buttons: "Add isolate", row menu: Identify, Edit description, Choose AST panel, Withdraw.

Add isolate / Identify dialog: Organism `Combobox` (`loadOptions` → `listMicroCodedSet(organisms, q)`, `minChars: 2`, option renders "{display} · {group}"), Plate (`Select`), Colony description (`TextArea maxLength=500`), Quantity (`TextField maxLength=80`), Reportable (`Checkbox`, default checked). Unknown organism error: "Choose an organism from the list. Ask your lab manager to add new organisms."

Withdraw: `ConfirmDialog tone="danger"` title "Withdraw isolate {n}?", `requireReason { codedSet: 'micro.isolate_withdraw_reasons', freeText: { maxLength: 500, isRequired: false } }`.

Right: AST grid for the selected isolate. Header: panel name + version, method, standard selector default (`Select`: CLSI / EUCAST / ECOFF; default tenant `manual_ast_standard`, else empty), version (`TextField maxLength=32`, default = active breakpoint set version for that standard when one exists).

Grid columns (`DataTable` with field cells, caption "AST results for isolate {n}"):

| Column | Cell | Validation / behaviour |
|---|---|---|
| Antibiotic | display text | — |
| Method | text (MIC / Zone) | per panel |
| Raw value | `TextField maxLength=32`, `inputMode="text"` (qualifiers allowed), suffix "µg/mL" or "mm" | grammar of 02-TRD §4.3; inline error "Enter a value like 0.25, <=0.25 or 18" |
| Suggested | text "S" + `Tooltip` "From {standard} {version} table imported {date}" + `Button size=sm variant=ghost` "Use" | only when preview returns a suggestion |
| Category | `Select` options = codes of the row's standard (display "S — Susceptible") | required to report; colistin/polymyxin B under CLSI show only I and R |
| Standard / version | text (inherits header; per-row override via row menu "Change standard") | — |
| Source | "Manual" / "Instrument" / "Suggested" | — |
| Report | `Checkbox` | default `is_reported_default` |

Keyboard: Enter in Raw value moves to the next row's Raw value; `Tab` moves across cells; typing a category letter in the Category select picks the first match; `Ctrl+Enter` saves the grid ("Save AST"). Unsaved changes → leaving the tab shows `ConfirmDialog` "Discard unsaved AST changes?".

Copy: banner when no breakpoint set is active and suggestions are enabled: "No active breakpoint table for {standard}. Categories must be entered manually." Disclaimer under the grid (always): "Suggested categories come from the breakpoint table your laboratory imported. Check each category before saving."

### 3.4 Tab "Reports"

`DataTable` of versions: Version, Phase (Preliminary/Final), Kind (Initial/Update/Amendment), Outcome, Flag (`FlagBadge` N/A), Critical (icon + "Critical"), Signed by, Signed at, Lab status at submit. Row action: "View" → `Drawer size=lg` with the snapshot (summary text, isolates table, AST table with method units, comments). Buttons: "Preliminary report", "Final report", "Reopen for amendment" (final_submitted).

Report drawer (`Drawer width=lg`, title "Preliminary report" / "Final report"):

| Field | Component | Required | Validation | Default |
|---|---|---|---|---|
| Outcome (final) | `CodedSelect micro.culture_outcomes` | final: yes | active | — |
| Summary | `TextArea maxLength=4000 rows=6 showCount` | yes | 1..4000 | generated text (02-TRD §4.6) — "Regenerate" button |
| Comments | `TextArea maxLength=4000 rows=3` | no | — | empty |
| Notify as critical | `Checkbox` | — | — | ticked when an alert organism is included |
| Reason for early final | `TextArea maxLength=500` | when no-growth before final due and setting on | 1..500 | — |
| Amendment reason | read-only text | — | — | from reopen |
| Included isolates / AST | read-only tables | — | rows missing category highlighted with text "Category missing" | — |

Submit button "Send for verification" (`Ctrl+Enter`). Disabled-state explanation (approved preliminary, user lacks `lab.result.amend`): final drawer "The preliminary report is already approved. A pathologist must submit the final."; preliminary drawer "The preliminary report is already approved. A pathologist must submit an updated preliminary." (08 A17 D-61).

Reopen dialog: `ConfirmDialog` title "Reopen for amendment", `requireReason { codedSet: 'lab.amendment_reasons', options from C5 listLabCodedSet (global + tenant) with the system codes `module_phase_progression`, `module_preliminary_update` and `supplementary_report` removed by the BFF (08 A17 D-62), freeText: { maxLength: 500, isRequired: false } }`, confirm "Reopen".

### 3.5 Tab "Instrument data"

Records of this culture (`listMicroInstrumentRecords?culture_id=`) — same columns as §4 minus Barcode; actions Apply / Resolve / Ignore.

## 4. Screen: Micro instrument data (`/micro/instrument-records`)

`PageHeader` "Micro instrument data" (`helpKey: micro.instrument_records`). `FilterBar`: Status (`select multiple`: Waiting for match, Needs mapping, Conflict, After final, Applied, Ignored; default first four), Instrument (`select`), Received (`date_range` ≤ 31 days).

Columns: Received (`DateText withTime`), Instrument, Kind (Organism ID / AST), Barcode (P2 — shown, never in URL), Isolate no., Code (raw organism / antibiotic code), Value (raw value + interpretation as received, e.g. "<=0.25 · S · CLSI 2026"), Status (`StatusChip generic`), Reason (text from §9). Row menu: Assign to culture, Apply, Resolve conflict, Ignore.

Assign dialog: `BarcodeInput` (scan specimen) → BFF lookup → `Select` culture (test + status) → Isolate no. (`IntegerField min=1 max=99`, default record's isolate seq) → Assign. Conflict dialog shows a two-column comparison "Instrument" vs "Current" with `RadioGroup` "Use instrument value" / "Keep current value". Ignore: `ConfirmDialog requireReason { codedSet: 'micro.record_ignore_reasons', freeText: { maxLength: 300, isRequired: false } }` (comment stored as `ignore_comment`).

Empty: "No instrument data waiting." While `LIMS_MICRO_SPECIMEN_LOOKUP_PORT` is off (C5 has not yet implemented `lookupSpecimens`, CR-C10-003), a persistent `Banner tone="info"`: "Instrument results are matched to cultures manually until automatic matching is enabled."

## 5. Screen: Micro settings (`/micro/settings`)

`Tabs`: Dictionaries · Plating protocols · AST panels · Instrument mappings · General. All writes require `micro.config.manage`; read-only for others (buttons hidden).

- **Dictionaries**: set `Select` (Organisms, Organism groups, Antibiotics, Media, Specimen sites, Growth codes, Culture outcomes, Isolate withdraw reasons, Culture cancel reasons, Instrument ignore reasons, AST categories [read-only]); table columns Code, Display, Source (Global/Tenant), Active, Order + set extras (organism: group, Gram class, Alert organism, SNOMED CT id; antibiotic: class; growth: "Means growth"; outcome: flag, "Needs isolate"). Edit dialog fields: Code (`TextField maxLength=64`, pattern `^[a-z0-9_]{2,64}$`, read-only when editing), Display (≤200, required), Order (`IntegerField 0..9999`), Active (`Switch`), extras (`Select`/`Checkbox`/`TextField maxLength=18` for SNOMED with help "Optional. Fill only if your laboratory is licensed to use SNOMED CT."). AST categories tab note: "Interpretive categories are fixed per standard (CLSI, EUCAST, ECOFF) and cannot be edited here."
- **Plating protocols**: list (code, version, display, reads, final no-growth hours, Gram stain, applies to, active); form: Code (≤64), Display (≤120), Read schedule (`TextField` "24, 48" → parsed ascending ints 1..720, ≤10), Final no-growth after (hours, `IntegerField 1..720`), Gram stain required (`Checkbox`), Default site (`CodedSelect`), Media rows (1..12), Applies to rows (test `Combobox` over C3 test search via BFF `GET /v1/catalog/tests?workflow_type=microbiology` — C3 HTTP, user's `catalog.test.read` — and/or specimen type `Select`). "New version" keeps code.
- **AST panels**: list (code, version, display, organism / group, site, method, antibiotics count); form: Code, Display (`TextField maxLength=120`, required), Scope (`RadioGroup` Organism / Organism group / Any) + matching `Combobox`, Site (optional), Default method (`Select`), Antibiotics (ordered list: antibiotic `Combobox`, method override, "Report by default" `Checkbox`; ≤60; reorder with up/down `IconButton`s labelled "Move up"/"Move down").
- **Instrument mappings**: instrument `Select` (C7 `listInstruments` `GET /v1/instruments/instruments` via BFF, user permission `instruments.instrument.read` (C7's CR) — if forbidden, a `TextField` for the instrument id is shown with help text); maps table (kind, instrument code, local code, active) + "Add mapping"; per-instrument default standard (`Select` + version `TextField ≤32`).
- **General**: Standard for manual suggestions (`Select`: None / CLSI / EUCAST), Suggest for zone diameters (`Switch`, default on), Suggest for MIC (`Switch`, default off, description "Not recommended until your microbiologist validates MIC tables."), Default no-growth final after (hours 1..720, default 48), Require a reason for early no-growth finals (`Switch`, default on), "Recently submitted" window (days 1..31, default 7).

## 6. Screens: Breakpoint tables

### 6.1 List (`/micro/breakpoint-sets`)
`PageHeader` "Breakpoint tables" (`helpKey: micro.breakpoint_sets`), action "Import table". `Banner tone="info"` (always): "LIMS does not include CLSI or EUCAST breakpoints. Import only tables your laboratory is licensed to use." Columns: Title, Standard, Version, Status (`StatusChip generic`), Effective from, Effective to, Rows, Errors, Imported by, Imported at. Empty: "No breakpoint tables imported. Categories are entered manually."

Import dialog (`Dialog size=md`): Standard (`Select` CLSI/EUCAST/ECOFF, required), Version (`TextField maxLength=32`, required, help "As printed on your source, e.g. the edition"), Title (≤120, required), Intended start (`DateTimePicker`, optional; stored and used as the default "Start using from" on activation), Licence confirmation (`TextArea maxLength=500`, 20..500, required, placeholder-free; label "Describe your laboratory's right to use this table"), File (`FileUpload accept=['text/csv'] maxBytes={5242880}` (5 MiB) — **CR-C10-008** adds `text/csv` to the kit), link "Download template". Submit "Upload". MFA prompt is handled by the shell on `auth.mfa_required`.

### 6.2 Detail (`/micro/breakpoint-sets/{breakpoint_set_id}`)
Header with status; `DescriptionList` (standard, version, licence text, sha256 (`IdText`), size, counts, dates, users). While `uploaded`/`validating`: `Spinner` + "Checking the file… this page updates automatically." `Tabs`: Issues (`DataTable`: Line, Severity, Code, Field, Message; filter severity) · Rows (filter antibiotic/organism; columns Line, Scope, Organism/group, Antibiotic, Method, Site, Qualifier, Bands rendered from the stored data as "{category} {lower}–{upper}" with ≥/>/≤/< symbols from the inclusive flags and "–" omitted for open bounds; no example values are shipped). Actions: Activate (`ConfirmDialog` with `DateTimePicker` "Start using from", body "The current {standard} table will stop being used from this time."), Retire (`ConfirmDialog tone=danger`), Discard. Four-eyes error copy: "Another user must activate a table you imported."

## 7. Components used (all `@lims/ui`)

`PageShell`, `PageHeader`, `Tabs`, `FilterBar`, `DataTable`, `StatusChip` (`kind="generic"`), `FlagBadge`, `Badge`, `BarcodeInput`, `useScanCapture`, `Form`, `TextField`, `TextArea`, `IntegerField`, `Select`, `CodedSelect`, `Combobox`, `Checkbox`, `RadioGroup`, `Switch`, `DateTimePicker`, `DateRangePicker`, `DateText`, `IdText`, `DescriptionList`, `Timeline`, `Card`, `Banner`, `Dialog`, `ConfirmDialog`, `Drawer`, `EmptyState`, `ErrorState`, `LoadingSkeleton`, `Tooltip`, `Spinner`, `Button`, `IconButton`, `Menu`, `useToast`, `FileUpload`, `KeyboardShortcutsDialog`, layout primitives.

CR candidates for C0-0D: (1) `FileUpload.accept` value `'text/csv'` (CR-C10-008 — accepted via CR-C2-011, 08 §4.6); (2) `StatusChip` kinds `culture`, `isolate`, `instrument_record`, `breakpoint_set` (optional — v1 uses `generic` with tones from §9, so not blocking); (3) icons `flask`, `inbox`, `table` if missing.

## 8. Accessibility and responsiveness

- WCAG 2.2 AA (02-CV §14). Status and flags always carry text ("Read overdue", "Critical", "Category missing"); colour is secondary.
- AST grid: each input has an accessible name "{antibiotic} raw value", "{antibiotic} category"; suggestion button "Use suggested category {code} for {antibiotic}"; errors linked via `aria-describedby`.
- Live regions: save results announced via toast (`role="status"`); scan result announced by `BarcodeInput`.
- Free texts (findings, summaries, comments) render as text nodes with `white-space: pre-wrap`; never HTML (REQ-SEC-088).
- Breakpoints: ≥ `lg` (bench PCs) two-column isolate/AST layout; `md` stacks the AST grid under the isolate list; below `md` the worklist turns into stacked cards (`hideBelow`) and the AST grid shows one antibiotic per card. Primary target is desktop bench PCs (DECISION).

## 9. Status labels and tones

| Value | Label | Tone |
|---|---|---|
| awaiting_setup | Awaiting set-up | neutral |
| incubating | Incubating | info |
| growth_detected | Growth — work-up | warning |
| final_submitted | Final submitted | success |
| amending | Amending | warning |
| cancelled | Cancelled | neutral |
| pending_id / identified / withdrawn | Not identified / Identified / Withdrawn | neutral / success / neutral |
| pending_match | Waiting for match | warning |
| needs_mapping | Needs code mapping | warning |
| conflict | Conflict | danger |
| late_after_final | After final report | warning |
| applied / ignored | Applied / Ignored | success / neutral |
| uploaded / validating / validated / invalid / active / retired / discarded | Uploaded / Checking / Ready to activate / Has errors / In use / Retired / Discarded | neutral / info / info / danger / success / neutral / neutral |
| match_reason codes | `lookup_unavailable` "Automatic matching not enabled" · `unknown_barcode` "Barcode not found" · `no_culture` "No culture for this specimen" · `multiple_cultures` "Several cultures for this specimen" · `isolate_missing` "Isolate not yet recorded" · `isolate_seq_out_of_range` "Isolate number above 99 — choose one" · `organism_differs` "Different organism already recorded" · `manual_value_exists` "Manual value already recorded" · `culture_cancelled` "Culture cancelled" | — |

## 10. Error copy (problem code → message)

| Code | Message |
|---|---|
| `micro.culture_invalid_transition` | "This culture has changed. Reload to see its current state." |
| `micro.report_final_locked` | "The final report has been sent. Reopen the culture to make changes." |
| `micro.isolate_invalid_transition` | "This isolate can't be changed that way." |
| `micro.organism_code_unknown` | "Choose an organism from the list." |
| `micro.ast_value_invalid` | "Enter a value like 0.25, <=0.25 or 18." (row with a category but no value: "Enter the measured value before choosing a category.") |
| `micro.ast_standard_required` | "Choose the standard and version for this category." |
| `micro.ast_category_not_allowed` | "This category isn't allowed for this standard or antibiotic." |
| `micro.antibiotic_not_in_panel` | "This antibiotic isn't in the panel. Tick 'Add to isolate' to record it anyway." |
| `micro.report_incomplete` | "Some required information is missing. See the highlighted items." |
| `micro.amendment_reason_required` | "Choose a reason for the amendment." |
| `micro.instrument_record_conflict` | "This record conflicts with existing data. Choose which value to keep." |
| `micro.breakpoint_import_invalid` | "The file can't be used (it must be a UTF-8 CSV that hasn't been uploaded before)." |
| `micro.breakpoint_set_invalid_transition` | "This table can't change to that state." |
| `micro.breakpoint_four_eyes_required` | "Another user must activate a table you imported." |
| `micro.code_duplicate` | "This code is already used." |
| `lab.result_locked` | "Only a pathologist can submit a change to an approved result." |
| `lab.result_invalid_transition` | "The lab has cancelled or changed this test. Reload the culture." |
| `lab.module_result_stale` | "A newer report version already exists. Reload the culture." |
| `lab.module_result_invalid` | "The lab did not accept this report (for example, the amendment reason is not valid). Check the reason and try again." |
| `common.version_conflict` | kit default ("Someone else changed this. Reload and try again.") |

## 11. In-app help and manual

`features/micro/help/` contains one help page per screen key (`micro.worklist`, `micro.culture`, `micro.instrument_records`, `micro.settings`, `micro.breakpoint_sets`). `docs/manual/micro/` pages: culture workflow, AST entry and categories (explains CLSI vs EUCAST "I" — 06-GLOSSARY), breakpoint import (CSV format of 02-TRD §9.1, licence responsibility), instrument data matching, amendments.
