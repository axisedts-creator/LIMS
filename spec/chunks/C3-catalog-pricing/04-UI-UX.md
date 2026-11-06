# C3 Catalog & Pricing — 04 UI/UX Specification

Status: DECISION draft, 2026-11-05. Staff web only (`apps/web`, route segment `(staff)/catalog`, features `features/catalog`). Composed **only** from `@lims/ui` (02-CV §14). Language: English, all strings in the message catalog under `catalog.<screen>.<key>` (02-CV §13). States (empty/loading/error/success/denied) per screen are in `03-APP-FLOW.md` §5 and are not repeated here.

The catalog is back-office master data: desktop-first. Instruments' code-mapping screens belong to C7 and use C3's HTTP API (X4); C3 ships no mapping screen. The registration screen's test search and doctor quick-add belong to C4 and call C3's HTTP API.

---

## 1. Routes and navigation

| Screen | Route (`apps/web/src/app/(staff)/catalog/…`) | Nav entry (`nav.manifest.ts`) | Required permission to see |
|---|---|---|---|
| SCR-01 Catalog home + health report | `/catalog` | "Catalog" (group) | `catalog.test.read` or `catalog.price_list.read` |
| SCR-02 Departments | `/catalog/departments` | Catalog › Departments | `catalog.test.read` |
| SCR-03 Specimen types & containers | `/catalog/specimens` (tabs) | Catalog › Specimens & containers | `catalog.test.read` |
| SCR-04 Methods | `/catalog/methods` | Catalog › Methods | `catalog.test.read` |
| SCR-05 Units & value sets | `/catalog/units` (tabs) | Catalog › Units & value sets | `catalog.test.read` |
| SCR-06 Tests list / detail | `/catalog/tests`, `/catalog/tests/{test_id}` (route id `staff.catalog.test`, 03-IC §7) | Catalog › Tests | `catalog.test.read` |
| SCR-07 Analyte editor (drawer inside SCR-06) | `/catalog/tests/{test_id}?analyte={analyte_id}` | — | `catalog.test.read` |
| SCR-08 Ranges & critical limits (tab inside SCR-07) | same + `&tab=ranges|critical` | — | `catalog.test.read` |
| SCR-09 Panels & packages | `/catalog/panels`, `/catalog/panels/{panel_id}` | Catalog › Panels & packages | `catalog.test.read` |
| SCR-10 Comment codes | `/catalog/comment-codes` | Catalog › Comment codes | `catalog.test.read` |
| SCR-11 Doctors | `/catalog/doctors`, `/catalog/doctors/{doctor_id}`, `/catalog/doctors/verify` | Catalog › Doctors | `catalog.referrer.read` (CR-C3-003, accepted in 08) |
| SCR-12 Credit parties & affiliations | `/catalog/credit-parties[/{id}]` | Pricing › Credit parties | `catalog.price_list.read` |
| SCR-13 Price lists | `/catalog/price-lists`, `/catalog/price-lists/{price_list_id}` (route id `staff.catalog.price_list`) | Pricing › Price lists | `catalog.price_list.read` |
| SCR-14 Price-list version editor | `/catalog/price-lists/{price_list_id}/versions/{version_id}` | — | `catalog.price_list.read` |
| SCR-15 Price simulator | `/catalog/price-simulator` | Pricing › Price simulator | `catalog.price_list.read` |
| SCR-16 Urgent surcharge rules | `/catalog/surcharges` | Pricing › Urgent surcharges | `catalog.price_list.read` |
| SCR-17 Tax rules & tax types | `/catalog/tax` | Pricing › Tax | `catalog.price_list.read` |
| SCR-18 Imports & exports | `/catalog/imports` | Catalog › Excel import/export | any of the import permissions |
| SCR-19 Import detail | `/catalog/imports/{import_id}` | — | permission of the import's kind |

Every page has `page.tsx`, `loading.tsx`, `error.tsx` (02-CV §2.4) and the shell's in-app help button linking to `features/catalog/help/<screen>.md` (01-CM §2 training note).

## 2. Components used (`@lims/ui`) — CR-C3-006

Components per 03-IC §13.2 (08 R22, CR-C3-006 accepted-modified): the names below are the kit's names (incl. the new `EditableGrid`, `CodeField`, `FormulaEditor`, `StatusStepper`, `DiffTable`; toasts via the `useToast` hook). Where 03-IC §13.2 and this table differ, 03-IC wins; C3 never builds look-alikes:

| Component | Used for |
|---|---|
| `PageShell`, `PageHeader` (title, breadcrumbs, primary actions) | every screen |
| `DataTable` (server-side cursor pagination, column sort, row selection, sticky header, keyboard row navigation) | lists |
| `EditableGrid` (cell editing, keyboard navigation, per-row status/error cell, dirty tracking) | SCR-14 prices, SCR-08 bands, SCR-09 members |
| `FilterBar` (text, select, toggle, date filters bound to query params) | lists |
| `Form`, `TextField`, `DecimalField` (decimal-string mode), `MoneyField` (NPR ↔ paisa), `Select`, `Combobox` (async search), `Checkbox`, `Switch`, `RadioGroup`, `TextArea`, `DateTimePicker` (A.D./B.S. per tenant calendar setting via `bsdate`) | forms |
| `CodeField` (upper-casing, regex hint) | all `code` inputs |
| `FormulaEditor` (monospace input, inline diagnostics, autocomplete of analyte codes) | SCR-07 |
| `Drawer`, `Dialog`, `ConfirmDialog` (typed confirmation) | editors, publish, merge |
| `Tabs`, `Badge` (status), `StatusStepper` | detail screens, import status |
| `Banner` (info/warning/error), `useToast`, `EmptyState`, `LoadingSkeleton`, `Tooltip` | states |
| `FileUpload` (single file, accept list incl. xlsx, size hint, `scanState`) | SCR-18 |
| `StatTile` | SCR-01, SCR-19 summary |
| `DiffTable` (two-version comparison) | SCR-13/14 compare |
| `KeyboardShortcutsDialog` | `?` overlay |

## 3. Global interaction rules

- Keyboard-first (02-CV §14): every action reachable by keyboard; tab order = visual order; `Esc` closes drawers/dialogs; `?` opens shortcut help.
- Global shortcuts on catalog screens [CONV]: `/` focus the list search/filter; `n` new item (when permitted); `Ctrl+S` save the open form/grid; `Ctrl+Enter` primary action in dialogs (publish, commit); `j`/`k` move row focus in tables; `Enter` open focused row.
- Codes: typed in any case, shown upper-case immediately; regex hint under the field.
- Money: entered as NPR with up to 2 decimals (`MoneyField`), sent as `amount_paisa` integers; displayed `NPR 1,234.50` [CONV]. No negative prices.
- Dates/times: `DateTimePicker` shows A.D. `DD/MM/YYYY hh:mm A` and/or B.S. per tenant `calendar_display` (02-CV §13); sent as UTC ISO. Default `effective_from` = "Now".
- Optimistic concurrency: every edit form holds `version`; `409 common.version_conflict` → `Banner` "Someone else changed this item. Reload to see their changes." + Reload button; unsaved input kept in the form until reload.
- Privileged actions (publish analyte versions and ranges — `catalog.reference_range.publish`, 08 A13 D-18 —, publish price lists, price import/export, referrer export, catalog-master commits that publish clinical versions) show a lock icon and the text "Requires two-step verification"; on `auth.mfa_required` the shell step-up runs, then the request is re-sent automatically with the same `Idempotency-Key`.
- Status badges always carry text (no colour-only meaning — WCAG): `Draft`, `Published`, `Scheduled` (published with future `effective_from`), `Superseded`, `Retired`, `Discarded`, `Inactive`, `Unverified`.
- Barcode scanner: not used in C3 screens (scanners act as keyboards; no catalog field expects a barcode). `instrument_code` fields are entered by C7 screens.
- Copy rule: the word "commission" never appears (04 L19); the referrer area uses "Doctors" / "Referring doctors".
- Tax disclaimer (07-BLOCKERS): every tax screen and the price-quote tax column show: "Tax treatment of lab services is pending confirmation by your auditor."

## 4. Screen specifications

### SCR-01 Catalog home + health report
Layout: `PageHeader` "Catalog" · row of `StatTile`s: Tests (active), Panels & packages, Doctors (unverified count highlighted), Price lists, Catalog revision · section "Needs attention" from #4: "Active orderables without a default price (n)", "Analytes without a reference range (n)", "Tests without a specimen type (n)", "Tests missing their narrative/attachment analyte (n)", "Tax default configured: Yes/No", "Formulas referring to inactive analytes (n)" — each a link to a filtered list. Buttons: "Import from Excel", "New test" (permission-gated).

### SCR-02 Departments (same pattern for SCR-03 specimen types/containers, SCR-04 methods)
Table columns: Code · Name · Report order · Report heading · Status · Updated. Filters: Status (Active/Inactive/All), search (code/name, client-side over the loaded page ≤ 200 rows [CONV]). Row action: Edit (drawer).
Form fields:

| Field | Type | Required | Validation | Default | Max |
|---|---|---|---|---|---|
| Code | `CodeField` | yes (create only; read-only after) | `^[A-Z0-9][A-Z0-9_]{0,31}$` | — | 32 |
| Name | `TextField` | yes | non-blank | — | 100 (methods 120) |
| Report order (departments) | `DecimalField` int | yes | 0–9999 | 100 | — |
| Report heading (departments) | `TextField` | no | — | — | 100 |
| Report label (specimen types) | `TextField` | yes | printed as "Specimen: …" | = Name upper-cased | 100 |
| Additive (containers) | `TextField` | no | — | — | 60 |
| Cap colour (containers) | `TextField` | no | free text, display only (06-GLOSSARY Container) | — | 40 |
| Default specimen type (containers) | `Select` | no | active specimen types | — | — |
| Active | `Switch` | — | — | on | — |

Copy: create button "New department"; save toast "Department saved."; duplicate error "This code is already used."

### SCR-05 Units & value sets
Tab "Units": table Code · Display · Scope (Global/Lab) · Status. Global rows read-only (lock icon, tooltip "Provided by the system"). "New lab unit" form: Code (`^[A-Za-z0-9_]{1,32}$`), Display (≤32, e.g. `10^3/µL`).
Tab "Value sets": table Code · Display · Ordered (Yes/No) · Values (count) · Scope. Editor drawer: Code, Display, Ordered `Switch`, values `EditableGrid` columns Code (≤16, `^[A-Z0-9_+\-]{1,16}$`) · Display (≤40) · Order · Active. When the set is in use (API 409), the Order column and row-delete become read-only with `Banner` (03-APP-FLOW §5).

### SCR-06 Tests list / test detail
List columns: Code · Name · Department · Workflow · Orderable alone (Yes/No) · Analytes (count) · Status · Revision. Filters: Department, Workflow type, Status; search box (`searchOrderables`, kind=test, debounce 250 ms [CONV]).
Detail layout: `PageHeader` (code — name, status badge, actions: Edit, Deactivate) · `Tabs`: **General** · **Specimens** · **Analytes** · **TAT targets** · **Tax** (read-only view of the effective rule with link to SCR-17) · **Instrument codes** (read-only list from #92 when the user has `catalog.instrument_code_map.manage` — privileged, so the shell may run step-up first (08 A13 D-18) — with note "Edit mappings in Instruments"; hidden otherwise).
General form:

| Field | Type | Required | Validation | Default |
|---|---|---|---|---|
| Code | `CodeField` | yes, create only | orderable regex `^[A-Z0-9][A-Z0-9_\-+.]{0,31}$`, unique across tests and panels | — |
| Name | `TextField` ≤200 | yes | — | — |
| Department | `Select` | yes | active departments | — |
| Workflow type | `Select`: Standard · Narrative report · Microbiology · Anatomic pathology · Molecular · Attachment · Outsourced | yes | change blocked after first published analyte version | Standard |
| Report order | `DecimalField` 0–9999 | no | — | 100 |
| Can be ordered alone | `Switch` | — | — | on |

Workflow help text (tooltip): Standard "Routine results entered or received from analysers"; Narrative "Free-text report with images (X-ray, USG, endoscopy)"; Microbiology/Anatomic/Molecular "Handled by the specialist module; one 'module result' analyte of type Narrative is required"; Attachment "Result is a file (PDF or picture)"; Outsourced "Performed by another lab; their PDF is merged into the report".
Specimens tab: `EditableGrid` Specimen type (`Select`) · Container (`Select`, optional) · Preferred (`RadioGroup` cell, exactly one) · Min volume µL (int 1–100000, optional); max 10 rows.
Analytes tab: `DataTable` Order · Sub-heading · Code · Name · Result type · Unit · Decimals · Method · Formula (icon) · Range set (version or "None" warning badge) · Current version · Draft (badge). Rows grouped visually by Sub-heading in sort order, mirroring the report (00 §4). Actions: "Add analyte", row "Open" (SCR-07 drawer), drag-or-keyboard reorder (`Alt+↑/↓`) saving `sort_order` via #31.
TAT targets tab: two rows (Routine, Urgent) — Target (hours + minutes inputs → seconds; 1 min–30 days), Segment `Select` "Within lab (received → first verified)" / "Total (registration → report released)" (06-GLOSSARY TAT: always name start/stop), Effective from. Note text: "Targets are stored here. Alerts on late tests arrive with the Quality module."

### SCR-07 Analyte editor (drawer, 720 px)
Sections:
1. **Display (not versioned)**: Code (`CodeField`, `^[A-Z][A-Z0-9_]{0,31}$`, create only), Name ≤120, Print name ≤120, Report sub-heading ≤80 (`Combobox` suggesting existing sub-headings of the test), Sort order, Reportable `Switch`, Active `Switch`.
2. **Clinical definition (versioned)** — header shows "Version 2 · Published · effective 06/11/2026 00:00" and a version `Select` to view older versions read-only. Buttons: "Create new version" (if no draft) / "Edit draft". Draft fields:

| Field | Type | Required | Validation |
|---|---|---|---|
| Result type | `Select` Numeric · Text · Ordinal · Coded · Attachment · Narrative | yes | — |
| Unit | `Combobox` (global + lab units) | numeric: recommended | must exist |
| Decimals | `DecimalField` 0–6 | numeric: yes | — |
| Method | `Select` (methods) | no | printed as `METHOD : <name>` |
| Value set | `Select` (value sets) | ordinal/coded: yes | ordinal requires an ordered set |
| Formula | `FormulaEditor` ≤500 chars | no (numeric only) | live validation via #36: shows "Inputs: MCV, RBC", "Order: MCV → RBC → MENTZER", errors with position; "Try it" mini-form (one `DecimalField` per input + optional age/sex) shows the sample result |

3. **Publish dialog** (`Dialog`): Effective from (`DateTimePicker`, default Now, cannot be in the past), Change reason (`TextArea` 1–500, required), checkboxes "Also publish reference-range draft (version n)" / "Also publish critical-limit draft" (shown when drafts exist; pre-ticked; required when the unit or method changed — otherwise the dialog shows `Banner` warning "Unit or method changed: the old reference ranges will no longer apply." and an explicit checkbox "Publish without reference ranges"). Primary button "Publish" (`Ctrl+Enter`), with the lock icon; enabled only for users holding both `catalog.reference_range.publish` and `catalog.test.manage` (08 A13 D-18), otherwise disabled with the tooltip naming the missing permission.

Formula editor keyboard: `Ctrl+Space` autocomplete analyte codes and functions; errors announced via `aria-live="polite"`.

### SCR-08 Reference ranges & critical limits (tab in SCR-07)
Version strip: chips per set version with status badges; "New version" (copies current), "Discard draft", "Publish…", "Retire…".
Bands `EditableGrid` (draft only; published shown read-only):

| Column | Type | Validation |
|---|---|---|
| Sex | `Select` Any/Male/Female | required |
| Age from | int 0–200 + unit `Select` days/weeks/months/years | optional (blank = from birth) |
| Age to (exclusive) | int + unit | optional (blank = no upper limit); must be > Age from |
| Specimen type | `Select` | optional |
| Kind | `Select` Numeric/Text/Ordinal | required |
| Low / High | `DecimalField` decimal-string | Numeric: at least one; Low ≤ High |
| Normal codes | multi-`Select` of the value set codes | Ordinal: required |
| Display text | `TextField` ≤500 | Text/Ordinal: required; Numeric: optional override (auto preview "13.0 - 17.0") |

Critical-limit grid: same dimension columns + Critical low · Critical high · Abnormal codes.
Grid copy: header help "Lower age is included, upper age is not. Example: 0–18 years covers patients until the day before their 18th birthday."
Preview panel (right side): Sex, Age (value + unit or date of birth), Specimen type, At (date-time) → "Matches band 2: Male, 18 years and over — 13.0 - 17.0 g/dL (version 3)" or "No reference range" (#51).
Publish dialog: Effective from, Change reason, typed confirmation of the analyte code (`ConfirmDialog`) because the change affects all future results.

### SCR-09 Panels & packages
List columns: Code · Name · Kind (Clinical panel / Package) · Sex restriction · Members (count) · Status. Filters: Kind, Status.
Detail: General (Code, Name ≤200, Kind `RadioGroup` (create only), Sex restriction `Select` None/Male/Female, Department optional, Active) · Members `EditableGrid`: Order · Kind (Test/Panel) · Orderable (`Combobox` → `searchOrderables`) · Name (read-only) · Status; max 100 rows · "Expanded tests" panel (live #3 preview) listing the resolved tests and specimen groups. Copy for packages: "Packages are priced as one item. Component prices are not added up."

### SCR-10 Comment codes
Table: Code · Department ("All departments" when blank) · Text (first 80 chars) · Status · Version. Filters: Department, search by code prefix. Form: Code (`^[A-Z0-9_]{1,16}$`), Department (`Select`, optional), Text (`TextArea` 1–2000), Active. Help: "Technologists type :CODE followed by a space in the result comment to insert this text. Changing the text later does not change results already saved."

### SCR-11 Doctors
List columns: Code · Name · Qualification · Verified (badge) · Source (Back office / Quick add / Import) · Price list · Status. Filters: Verified, Status, Source. Search box calls `POST /doctors/search` (no names in URLs — D-C3-06).
Verify queue `/catalog/doctors/verify`: unverified doctors, newest first, with possible duplicates listed under each row; actions "Verify", "Merge into…", "Edit".
Detail form:

| Field | Type | Required | Validation |
|---|---|---|---|
| Doctor code | `CodeField` | no (auto `DR00001` style) | `^[A-Z0-9_\-]{1,20}$` |
| Display name | `TextField` | yes | 1–120 |
| Qualification | `TextField` | no | ≤120 |
| Registration council | `Select` NMC / Other | no | — |
| Registration no. | `TextField` | no | ≤30 |
| Phone | `TextField` (E.164, `+977…`) | no | `^\+[1-9][0-9]{7,14}$` (08 A13 P-11) |
| Email | `TextField` | no | email, ≤254 |
| Notes | `TextArea` | no | ≤500 |
| Price list | read-only link (assignment managed in SCR-13) | — | — |

Merge dialog: target `Combobox` (verified, active doctors), typed confirmation of the source code, text "Past orders keep the original doctor. Reports and analytics will show <target>." Contact fields are hidden for users without `catalog.referrer.manage`.

### SCR-12 Credit parties & affiliations
List: Code · Name · Kind · Credit allowed (Yes/No) · Price list · Status. Form: Party code (`^[A-Z0-9_\-]{1,20}$`, auto `CP00001` if blank [CONV]), Name 1–160, Kind `Select` (Hospital, Company, Clinic, Partner lab, Insurer, Other), Credit allowed `Switch` (help: "Off = affiliation with its own prices; patients still pay at the counter"), PAN ≤20, Phone (E.164, `^\+[1-9][0-9]{7,14}$`), Email, Billing address ≤500, Active. PAN, phone, email and billing address are shown and editable only for users holding `catalog.price_list.manage` (the API omits them otherwise). Note: "Credit limits, credit days and monthly statements are managed in Billing."

### SCR-13 Price lists
List: Code · Name · Applies to (Default / Hospital-company / Doctor / Centre) · Assigned to (count) · Current version (no. + effective from) · Scheduled (badge) · Draft (badge) · Status. Filters: Applies to, Status.
Detail: header actions "Edit prices" (creates/opens draft), "Export to Excel", "Import from Excel", "Compare versions". Sections: General (Code, Name ≤120, Applies to — create only, Falls through `Switch` with help "When an item is missing here, use the next price list (doctor → centre → default)"), Assignments (`DataTable` + "Add" `Combobox` of credit parties (#67) / doctors (#60) / centres per kind — centres from C2 `listCentres` via the BFF, permission `identity.centre.read` (08 A13 D-16); max 500), Versions (`DataTable`: Version · Status · Effective from · Effective to · Items · Source (Manual/Import) · Change reason · Published by).

### SCR-14 Price-list version editor
`EditableGrid` columns: Code · Name · Kind · Department · Price (NPR, `MoneyField`) · Current published price (read-only) · Change (± %, warning badge when > 50 % [CONV]) · Row status (saved / error text). Toolbar: search (code/name, client-side over loaded rows), "Add orderable" (`Combobox` → `searchOrderables`), "Remove selected", "Save" (`Ctrl+S`; batches of 200), "Publish…". Unsaved-changes guard on navigation. Published versions open read-only with "Create new version" button.
Keyboard: arrow keys move cells; `Enter` edits/commits a cell; `Tab` next cell; `Delete` on a selected row marks it for removal.

### SCR-15 Price simulator
Form: Orderables (multi `Combobox`, ≤50), Priority `RadioGroup` Routine/Urgent, Context: Price list (optional), Credit party (optional), Doctor (optional), Centre (optional; `Combobox` fed by C2 `listCentres` via the BFF, permission `identity.centre.read` — 08 A13 D-16), At (default now). Result table: Orderable · Price list used · Source (Explicit / Hospital-company / Doctor / Centre / Default) · Version · Unit price · Urgent surcharge · VAT (Exempt/Taxable 13 %) · Other tax · HS code · Error. Tax disclaimer under the table.

### SCR-16 Urgent surcharge rules
Table: Applies to (All tests / Department X / Orderable Y) · Price list (All / name) · Amount (NPR 200.00 or 50 %) · Effective from · Effective to · Status. Form: Applies to `RadioGroup` + conditional `Select`/`Combobox`, Price list (optional), Amount type `RadioGroup` Flat/Percent, Amount (`MoneyField`) or Percent (`DecimalField` 0.01–1000 % → bp), Effective from. "End rule" action with date. Help: "Applies only when the order item is marked Urgent. The most specific rule wins: orderable, then department, then all tests."

### SCR-17 Tax rules & tax types
Disclaimer `Banner` (info, always visible): "Tax treatment of lab services is pending confirmation by your auditor. Configure what your auditor confirms."
Tab "Rules": table Applies to (Lab default / Department / Orderable) · VAT (Exempt / Taxable 13 %) · Other tax (code + rate) · HS code · Effective from/to. Form: Applies to, VAT treatment `RadioGroup` (no pre-selection — D-C3-04), Other tax type `Select` (only types with a rate), HS code (4–8 digits, help "Optional. Applicability to lab services is not confirmed."), Effective from. If no lab-default rule exists: error `Banner` "Prices cannot be quoted until a lab default tax rule exists."
Tab "Tax types": table Code · Name · Rate · Effective from/to · Scope (System/Lab); "Rate history" expands earlier versions. VAT row is system, read-only, 13 %. Lab type form: Code (`^[A-Z0-9_]{1,16}$`), Name ≤60, Rate % (0–100, 2 dp → bp; may stay empty: "Not configured — cannot be used in rules"), Effective from (`DateTimePicker`, default Now). Changing the rate of an existing type asks for "Effective from" and creates a new rate version; earlier rates stay unchanged (C3 is the only owner of tax rates — 08 R18).

### SCR-18 Imports & exports
Two sections.
**Import**: `RadioGroup` kind — "Price list prices" (requires choosing the price list `Select`), "Catalog master (tests, analytes, ranges, panels, comment codes)", "Doctors", "Credit parties" (CR-C18-008; requires `catalog.price_list.manage`). Buttons "Download blank template", "Download current data" (= export). `FileUpload` accept `.xlsx`, hint "Excel .xlsx only, up to 15 MB. Macro files (.xlsm) are not accepted." Upload button (`Idempotency-Key` generated per selected file).
**History** `DataTable`: Started · Kind · Target · File name · Status badge · Errors/Warnings · By. Filters: Kind, Status. Exports table (`DataTable` over #107 `listExports`, filters Kind/Status): Requested · Kind · Status · Download (when ready; expires in N days). A download answered `409 common.version_conflict` with `detail: "file_not_ready"` shows `Banner` "Still preparing — try again shortly" (08 A13 D-20).

### SCR-19 Import detail
`StatusStepper`: Uploaded → Security scan → Validating → Ready to commit → Committing → Committed (terminal variants shown in red/grey with text). Summary `StatTile`s: Rows · Added · Changed · Removed · Unchanged · Errors · Warnings. Issues `DataTable`: Severity · Sheet · Row · Column · Issue (human text from the message catalog keyed by `issue_code`) — filter Errors/Warnings. Buttons: "Download annotated file" (#101), "Discard", "Commit…".
Commit dialog: Effective from (default Now), Change reason (required), "Publish immediately" `Switch` (price lists; off = leave as draft for review), stale-base checkbox "The price list was changed after this file was exported. I want to replace it anyway." (only when warning present), typed confirmation of the price list code for price imports; "Replace open drafts" `Switch` (sends `replace_draft: true`; default off; help "Open drafts of these items are discarded before the import is applied."). For catalog-master commits that publish analyte versions or ranges, the Commit button carries the lock icon and needs `catalog.reference_range.publish` (08 A13 D-18).
Polling: every 2 s while status ∈ {uploaded, scanning, validating, committing}; stop after 15 min with `Banner` "This is taking longer than expected. You can leave this page; the import continues."

Issue message copy (message catalog `catalog.import.issue.<code>`), examples: `row.price_decimals` "Price has more than 2 decimal places."; `row.orderable_unknown` "No test or panel with this code."; `file.stale_base` "This price list has a newer version than the one you exported."; `file.macro_present` "The file contains macros and was not read."; `row.formula_invalid` "Formula is not valid: {reason}."

## 5. Accessibility (WCAG 2.2 AA target, 02-CV §14)

- Every input has a visible label and `aria-describedby` for help and error text; errors are listed in a summary at the top of the form on submit, each linking to the field.
- `EditableGrid`: implements the ARIA grid pattern (roving tabindex, `aria-rowindex`, `aria-colindex`, `aria-invalid` on cells with errors, row status announced via `aria-live="polite"`).
- Status never by colour alone (badges have text; flags in previews say "High"/"Low" like the report, 00 §4).
- Focus returns to the triggering control when a drawer/dialog closes.
- Contrast from `@lims/ui` tokens only.
- Typed-confirmation dialogs announce the required text.

## 6. Responsive rules

- Designed for ≥ 1280 px wide; usable down to 1024 px (drawers become full-width).
- < 1024 px (tablet/phone): lists and details are readable; `EditableGrid` switches to read-only with the message "Editing prices and ranges needs a larger screen." [CONV]; imports/exports remain usable.
- No horizontal scrolling of the page; wide tables scroll inside their container with sticky first column (code).

## 7. Operator / developer experience (API)

- API style per 02-CV §4: problem+json errors with `code`; cursor pagination; `If-Match` on every change; `Idempotency-Key` on every create and on publish/import/export/bulk/merge (08 A13 P-8).
- Integration guide for consumer chunks (in `docs/manual/catalog/integration.md`): use `CatalogPort`, never the HTTP API, from server code; snapshot `referenceRangeId + version` and `priceListId + priceListVersion`; pass `birthOn` to `referenceRangeFor` whenever known; omit `ageDays` only when the patient's age is unknown — then only age-unrestricted bands match (08 A17.1); validate a stored price-list id with `getPriceListStatus`, never by reading `catalog.v_pub_*` in a request (08 A24.1); treat `kind = text` ranges as print-only; `catalog.changed.v1` is cache invalidation only — never rebuild state from it.
- Runbook entries (C1 registers alerts): "Import stuck" (check worker queue `catalog.import_*`, dead letters; re-enqueue is safe — tasks are idempotent), "Import quarantined" (security incident procedure; file remains in `catalog.files` until purge for forensics — do not download it on a staff PC), "No price spike" (run health report; usually a newly published list without fall-through).

Final sweep 2026-11-06 — second touch applied (§7 integration guide: age unknown, `getPriceListStatus`).
