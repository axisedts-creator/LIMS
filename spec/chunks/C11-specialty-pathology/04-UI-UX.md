# C11 Specialty Pathology — 04 UI/UX (staff web, feature `anatomic`)

Status: DECISION, 2026-11-06. Components come **only** from `@lims/ui` (C0 04-UI-UX §2). Message keys are `anatomic.<screen>.<key>` (02-CV §13); English copy below is the v1 `en.json` text. Layout follows the C0 web shell (C0 04-UI-UX §7). Every page has `PageHeader` with a `helpKey` and a help file in `apps/web/src/features/anatomic/help/` (build fails otherwise).

---

## 1. Navigation (`apps/web/src/features/anatomic/nav.manifest.ts`)

| id | label key (copy) | routeId | permission | group | order | chord |
|---|---|---|---|---|---|---|
| `anatomic.worklist` | `anatomic.nav.worklist` ("Pathology cases") | `staff.anatomic.worklist` (CR-C11-006) | `anatomic.case.read` | `laboratory` | 60 | `g p` |
| `anatomic.tracking` | `anatomic.nav.tracking` ("Block & slide tracking") | `staff.anatomic.tracking` (CR) | `anatomic.case.read` | `laboratory` | 61 | `g t` |
| `anatomic.batches` | `anatomic.nav.batches` ("Molecular batches") | `staff.anatomic.batches` (CR) | `anatomic.case.read` | `laboratory` | 62 | — |
| `anatomic.config` | `anatomic.nav.config` ("Pathology setup") | `staff.anatomic.config` (CR) | `anatomic.config.manage` | `laboratory` | 63 | — |

All entries `phase: '2'`. Chords must be unique across manifests (build check). `g k` was replaced by `g t` because C16 uses `g k` (`engagement.bookings`); on 2026-11-06 no chunk 04-UI-UX used `g p` or `g t`. If a later collision appears, the build fails and C11 drops its chord (no CR needed).

## 2. Global behaviours

- **Scanner:** the worklist and tracking pages use `BarcodeInput` with `pattern = /^[A-Z0-9-]{1,32}$/` (accession, block and slide labels contain hyphens; C5's default pattern excludes them), `submitKeys ['Enter','Tab']`, `clearAfterScan true`, `allowManual true`. `useScanCapture` is enabled on the tracking page so staff can scan without focusing a field. Values are never logged or put in URLs (C0 §2.4 rule 6); lookups use `POST /cases/lookup`.
- **Specimen barcodes** (C5 `[A-Z0-9]{1,20}`) are not resolvable in C11 (C11 stores no barcodes); scanning one shows "This is a sample barcode. Receive samples in Lab → Specimens; pathology cases appear here after receipt." (`anatomic.scan.specimen_barcode`) when the value matches C5's pattern and the lookup returns 404.
- **Plain text editors:** all narrative fields are `TextArea` (plain text, NFC — 02-TRD §4.6) with `showCount`. Text-template insertion: typing `;` followed by a short code and `Tab` inside a narrative `TextArea` expands the matching active template of that section (client-side, from `listAnatomicTextTemplates(section)` loaded with the page). Unknown code → no change, small hint "No template ;{code}".
- **Unsaved changes:** navigating away from a dirty form shows `ConfirmDialog` "Discard unsaved changes?" [Stay] [Discard].
- **Version conflicts:** `Banner` tone warning, copy `anatomic.common.conflict` "This case was changed by someone else. Reload to see the latest version." action [Reload].
- **Step-up:** `403 auth.mfa_required` → `Dialog` "This action needs two-factor verification." [Verify now] (C2 step-up route, returns to the same URL) [Cancel].
- **Dates:** `DateText` with tenant `calendarDisplay` (default A.D. `DD/MM/YYYY hh:mm A`, 02-CV §13).
- **Status chip:** `StatusChip kind="generic"` with tones: received → neutral, accessioned → info, in_processing → info, ready_for_reporting → warning, signed_out → success, cancelled → neutral (strikethrough label text "Cancelled"). C0's StatusChip kinds don't include anatomic cases; `generic` is the kit's extension point (no CR).

## 3. Page-level keyboard shortcuts (registered via `shortcuts.register`)

| Page | Keys | Action |
|---|---|---|
| Worklist | `Alt+F` | focus lookup field (queue tabs use the kit `Tabs` arrow-key model; no digit shortcuts) |
| Case workspace | `Alt+O` | Overview tab |
| | `Alt+G` | Parts & gross tab |
| | `Alt+B` | Blocks & slides tab |
| | `Alt+T` | Stains tab |
| | `Alt+I` | Images tab |
| | `Alt+R` | Report tab |
| | `Alt+A` | open Accession dialog (when allowed) |
| | `Alt+L` | open labels page (blocks) |
| | `Alt+S` | save the current form (gross, draft, molecular) [CONV]; `Ctrl+Enter` (kit `Form` submit) also saves |
| | `Alt+U` | open Sign out dialog (when allowed) |
| Tracking | `Alt+V` | open "Record movement" for the basket (`Alt+M` is the global focus-main key, so it is not used) |

Every page shortcut is `Alt+<letter>`, the only page-level form in the C0 keyboard model (C0 04-UI-UX §4); `/`, `Alt+<digit>` and `Ctrl+S` are not used. No page shortcut uses `Alt+N`, `Alt+M`, `Alt+H` (global — C0 §4). Shortcuts are inactive during IME composition (Devanagari input).

## 4. Screens

### 4.1 Worklist `/anatomic`

Layout: `PageHeader` (title "Pathology cases", helpKey `anatomic.worklist`, actions: none) → lookup row → `Tabs` → `FilterBar` → `DataTable`.

Lookup row: `BarcodeInput` label "Scan or type an accession, block or slide label" (`anatomic.worklist.lookup_label`), name `label`.

Tabs (labels): To accession · Grossing · Bench · Reporting · Awaiting lab approval (CR-C11-011, accepted in 08) · Signed out · Cancelled · All. Badge = count only for the current tab after load (no extra count calls — 02-CV §4.3 totals not default).

Filters (`FilterBar`):

| id | kind | options / rule |
|---|---|---|
| `case_kind` | select multiple | Histology, Cytology, IHC, Molecular |
| `centre_id` | select multiple | centres visible to the user (`ctx.core` via BFF) |
| `priority` | select | Routine, Urgent |
| `assigned_pathologist` | select | Me, Anyone (+ Combobox of assignees for a specific person: `listAnatomicAssignees(q)` without `case_id`) |
| `received` | date_range | maps to `received_at_from` (00:00 tenant tz) / `received_at_to` (next day 00:00) ; max 92 days [CONV] |

Table columns (`DataTable`, density compact, caption "Pathology cases"):

| Column | Content | Sort key | hideBelow |
|---|---|---|---|
| Accession | `accession_no` mono, or "Not accessioned" muted | `accessioned_at` | — |
| Patient | `patient.display_name` (row header); second line `age_text / sex`, `patient_code` | — | — |
| Kind | Histology / Cytology / IHC / Molecular | — | md |
| Tests | `test_names` joined ", " (truncate 40 + tooltip) | — | lg |
| Parts | `part_count` | — | lg |
| Received | `DateText withTime` | `received_at` | — |
| Priority | Badge "Urgent" (danger) or blank | `priority_received_at` | — |
| Status | StatusChip + flags icons with text tooltips (Profile missing, Specimen rejected, Change open, Stains pending n) | — | — |
| Pathologist | display name or "—" | — | xl |

Row action: open case. Pagination: cursor (`limit` 50).

Empty states (`EmptyState`):
- To accession: "Nothing to accession" / "New cases appear here when the lab receives a histology, cytology or molecular specimen."
- Grossing: "No cases waiting for gross description."
- Bench: "No slides or stain orders pending."
- Reporting: "No cases ready for reporting."
- Signed out / Cancelled / All: "No cases match these filters." with action [Reset filters].

Errors: `ErrorState` "We couldn't load cases." + reference + Retry.

### 4.2 Case workspace `/anatomic/cases/{case_id}`

Layout: `PageHeader` (breadcrumbs Pathology cases › {accession or "Case"}; title = accession or "Not accessioned"; status = StatusChip; actions = `Menu` "Actions" with items from `allowed_actions`: Accession, Start processing, Mark ready, Sign out, Revise/Amend, Add addendum, Print block labels, Print slide labels, Cancel case) → banners → `DescriptionList` (3 columns) → `Tabs`.

Header `DescriptionList` items: Patient (name, age/sex, patient code) · Case kind · Priority · Centre · Received · Accessioned · Assigned pathologist · Tests (each with C5 status chip: "Lab: pending/resulted/verified/approved/cancelled"; omitted if no `lab_status`) · Current version.

Banners (`Banner`):

| Condition | Tone | Copy |
|---|---|---|
| `profile_missing` | warning | "This test has no pathology profile. Defaults were used. Ask a lab manager to set it up in Pathology setup." |
| part `specimen_state = rejected` | danger | "Specimen for part {letter} was rejected in the lab. A recollected specimen will be linked here when received." |
| item inactive | danger | "{test} was removed from the order. Sign-out is blocked for this case until the order is corrected or the case is cancelled." |
| add-on item without result | warning | "Billed add-on {test} still needs a result (sign an addendum linked to it) or cancellation at front desk." |
| open change draft | info | "A {revision|amendment} is in progress by {name} since {time}." |

#### 4.2.1 Accession dialog (`Dialog` size lg, title "Accession case")

| Field | Component | Type / validation | Required | Default | Max |
|---|---|---|---|---|---|
| Parts table: Letter | text (read-only) | — | — | assigned | — |
| Parts table: Site | `TextField` | text | yes | — | 200 |
| Parts table: Description | `TextField` | text | no | — | 1000 |
| Clinical history | `TextArea` rows 4 | text | no | — | 4000 |
| Assigned pathologist | `Combobox` (loadOptions → `listAnatomicAssignees(case_id, q)`: holders of `anatomic.case.signout` for the case centre, 02-TRD §6.2) | membership id | no | none | — |

Footer: [Cancel] [Accession] (primary, `Ctrl+Enter`). Success toast "Accessioned as {accession_no}". Errors: `anatomic.accession_pattern_invalid` → `ErrorState` in dialog "Accession numbering is misconfigured. Ask an administrator to check the accession pattern." (reference shown).

#### 4.2.2 Parts & gross tab

Per part: `Card` titled "Part {letter} — {site}". Inside:

| Field | Component | Validation | Required | Max |
|---|---|---|---|---|
| Site | `TextField` | — | yes | 200 |
| Description | `TextField` | — | no | 1000 |
| Gross description | `TextArea` rows 8, showCount | plain text | for "Gross complete" on histology parts with `requires_gross` | 20000 |
| Pieces | `IntegerField` min 0 max 999 | integer | no | — |
| Dimensions (mm) | 3 × `DecimalField` decimals 1, min "0.1", max "9999.9" labelled "Length", "Width", "Depth" | DecimalString | no (1–3 may be filled, left to right) | — |
| Weight (g) | `DecimalField` decimals 2, min "0.01", max "99999.99" | DecimalString | no | — |
| Gross complete | `Switch` | — | — | off |
| Gross images | `FileUpload` accept png/jpeg, maxBytes 15 MB, multiple, maxFiles 10 → `uploadAnatomicImage(kind=gross, part_id)` | — | — | — |

Buttons: [Save part] (`Alt+S`), [Add part] (opens small dialog: Site required ≤200, Description ≤1000). "Grossed by {name}, {time}" footer text.

Empty: "No parts yet. Parts are created when specimens are received, or add one."

#### 4.2.3 Blocks & slides tab

Two `DataTable`s.

Blocks: columns Label (mono, row header) · Part · Slides (count) · Location (status text + location text) · Note. Selection multiple (≤200). Toolbar: [Add blocks] → `Dialog`: Part (`Select`, required), Count (`IntegerField` 1–50, default 1), Note (`TextField` ≤200). [Add slides] (enabled with exactly 1 block selected) → `Dialog`: Stain (`CodedSelect codedSet="stains"`, default tenant default routine stain), Count (`IntegerField` 1–20, default 1). [Record movement] → movement dialog (§4.4). [Print labels] → labels page for selected or all.

Slides: columns Label · Source (block label or "Part {letter}") · Stain · Status (Pending stain / Ready) · Location · Assessment (cytology only: adequacy display + "In report" badge). Toolbar: [Add slides from part] (cytology/without blocks): Part `Select`, Stain, Count. [Mark ready] (bulk; result toast "{n} slides marked ready, {m} skipped" with skipped reasons in a Drawer). [Record movement]. [Print labels].

Cytology slide assessment (`Drawer` width md, title "Assessment — {slide label}"): Adequacy (`CodedSelect codedSet="cytology_adequacy"`, optional), Finding (`TextArea` ≤2000), Include in report (`Checkbox`, default off). [Save].

Empty: "No blocks yet. Add blocks after grossing." / "No slides yet."

#### 4.2.4 Stains tab

`DataTable` stain orders: Stain (display + kind badge Routine/Special/IHC) · On (block label or "Part X") · Status · Requested (time, by) · Lot · Add-on (linked test name or "—") · actions menu (Start, Complete, Cancel, Link add-on item).

[Order stain] → `Dialog`:

| Field | Component | Rule |
|---|---|---|
| Stain | `CodedSelect codedSet="stains"` (special + IHC only) | required |
| Block | `Select` of blocks with location in_lab, stored or sent_out (sent_out options labelled "Sent out — complete after return"; discarded blocks not offered) | required when stain kind = IHC ("IHC must be ordered on a block") |
| Part | `Select` | allowed only for special stains when no block chosen |
| Note | `TextArea` ≤500 | optional |
| Billed add-on item | `Select` of unlinked active add-on items of the order | optional |

Complete dialog: Slides made (`IntegerField` 1–20, default 1), Reagent lot (`TextField` ≤64), Performed at (`DateTimePicker`, default now, max now). Cancel dialog: `ConfirmDialog` with free text required ≤500.

Empty: "No special stains or IHC ordered."

#### 4.2.5 Images tab

`ImageThumbnailGrid` (CR-C6-010, accepted in 08 §4.6; until C0-0D ships it, a `DataTable` with columns Thumbnail-less "Image {n}", Kind, Part, Caption, State) loading images through the BFF route that streams `getAnatomicImageContent` inline (`<img>`; re-encoded PNG/JPEG only, `nosniff`, CSP `default-src 'none'; sandbox`, `no-store`, access-logged — 08 A17 D-67 exception to P-2). Non-ready images are not requested (the API would return `422 common.upload_quarantined`). Per image: Kind (`Select` Gross/Microscopy/Other), Part (`Select`, optional), Caption (`TextField` ≤200, description "Do not type patient names in captions."), [Remove from case] (`ConfirmDialog` "Remove this image from the case? Signed reports that include it keep it."). Processing chip "Processing…", quarantined chip "Blocked by security scan" (danger) — no preview.

[Upload images] `FileUpload` accept png/jpeg, maxBytes 15 MB, multiple, maxFiles 10 → one request per file with its own Idempotency-Key; `scanState` per file from the response state. Upload stays available after sign-out (08 A17 D-66 (a)); Kind/Part/Caption are read-only for an image already in a signed version (note "In a signed report — can't be changed"). Upload errors per file: 413 "This file is larger than 15 MB." 415 "Only PNG and JPEG images can be uploaded." `anatomic.image_limit_reached` "This case already has the maximum number of images ({max})."

Empty: "No images. Upload gross or microscopy photos."

#### 4.2.6 Molecular tab (molecular cases)

`DataTable` editable rows (one per assay target added):

| Column / field | Component | Validation | Required |
|---|---|---|---|
| Assay | `Select` (active assays) | — | yes |
| Target | `Select` (targets of assay) | — | yes |
| Result | `Select` (result values of target) | code in set | yes |
| Value | `DecimalField` decimals = target decimals | only when target `allows_quantitative` | no |
| Unit | read-only from target `unit_code` | — | — |
| Method | `TextField` ≤200, default assay `method_text_default` | — | no |
| Kit name | `TextField` ≤120 | — | no |
| Kit lot | `TextField` ≤64 | — | no |
| Kit expiry | `DatePicker` | ≥ 2000-01-01 | no |
| Batch | `Select` of open/closed batches for the assay | — | no |
| Comment | `TextField` ≤1000 | — | no |

Result values with `is_abnormal` render with text "Abnormal" next to the display (never colour only). [Add row] [Remove row] [Save] (`Alt+S`, full replace with `If-Match` molecular_rev). Empty: "No results yet. Add a row for each assay target."

#### 4.2.7 Report tab

Layout: left column editor (`Form`), right column `Card` "Preview" (read-only plain rendering: headings Gross, Microscopy, Diagnosis, Comment, Synoptic, Ancillary, Slides, Images (captions), Codes). Top: draft kind badge ("Initial report" / "Revision" / "Amendment — reason: {display}").

| Field | Component | Validation | Required at sign-out | Max |
|---|---|---|---|---|
| Gross | `TextArea` rows 8 + button [Insert gross from parts] (replaces after `ConfirmDialog` if non-empty) | plain text | histology | 20000 |
| Microscopy | `TextArea` rows 10 | plain text | no | 20000 |
| Diagnosis / impression | `TextArea` rows 6 | plain text | yes | 8000 |
| Comment | `TextArea` rows 4 | plain text | no | 8000 |
| Ancillary results | one `TextArea` (≤2000) per completed stain order, label "{stain} on {block}" | — | no | 2000 each |
| Slide assessments | read-only list of slides with "Include in report" on | — | — | — |
| Synoptic | [Add synoptic] → `Select` of published templates applicable to the case kind (default templates from the test profile first); each instance renders as a `Card` with sections; field components by type: text → `TextField` (max_length), long_text → `TextArea`, integer → `IntegerField` (min/max), decimal → `DecimalField` (decimals/min/max, unit as `suffix`), boolean → `Switch`, single_select → `Select`, multi_select → `Checkbox` group, date → `DatePicker`; required fields marked; `show_if` hides/shows live; [Remove] per instance | definition-driven (02-TRD §4.5) | required fields of visible items | ≤5 instances |
| Images in report | ordered picker from ready images (checkbox + up/down `IconButton`s "Move up"/"Move down") | ≤ `max_report_images` | — | — |
| Diagnosis codes | `Combobox` (loadOptions → `listAnatomicCodedValues('diagnoses', q)`), chips list with remove | active codes | no | 20 |
| Abnormal | `RadioGroup` Normal / Abnormal / Not stated (default Not stated) | — | — | — |
| Critical finding | `Checkbox` "Critical or unexpected finding — notify per lab protocol" | — | — | — |

Buttons: [Save draft] (`Alt+S`), [Sign out] (primary, privileged; hidden without `anatomic.case.signout`). Autosave: none (explicit save) [CONV: avoids version churn and conflicting saves].

Sign-out `Dialog` (title "Sign out report"): text "Version {n} will be created and sent to lab verification for: {test list}." + "Critical finding: Yes/No". `Checkbox` "I have reviewed this report and its images" (required) → [Sign out]. Errors handled per 03-APP-FLOW §4.2.

After sign-out the editor area is replaced by the version viewer (`Card` with the snapshot) + `DataTable` "Versions" (Version, Kind, Signed, By, Reason, Lab status at submit) + buttons [Revise]/[Amend] (label from C5 status), [Add addendum].

Change dialog (`ConfirmDialog requireReason { codedSet: "amendment_reasons", options: C5 `amendment_reasons` loaded through the BFF `listLabCodedSet` (C5 #53), active codes only, excluding `module_phase_progression`, `module_preliminary_update`, `supplementary_report`; freeText {maxLength 500, isRequired false} }` — 08 A17 D-62), title "Revise report" or "Amend approved report", body for amendment: "This result is approved. Your change creates an amended report; the previous version stays on record."

Addendum editor (`Drawer` width lg): Kind (`Select` IHC/Special stain/Molecular/Other), Text (`TextArea` ≤8000, required), Stain orders (`Checkbox` list of completed orders), Link to billed add-on item (`Select` of add-on case items without result). [Save] [Sign addendum] (privileged).

Empty (no draft yet): `EmptyState` "No report draft yet." action [Start report] (creates with `If-Match: "0"`).

### 4.3 Labels page `/anatomic/cases/{case_id}/labels`

Print-only layout (no shell chrome when printing — `@media print`). Each label: line 1 label text (mono, bold, ≥ 3 mm cap height [CONV]); line 2 `line2`; `BarcodeSymbol` (CR-C11-007, accepted in 08 §4.6; omitted until C0-0D ships it with a note "Barcode symbols not yet available — text labels only" shown on screen only). Toolbar (screen only): kind toggle Blocks/Slides, [Print] (`window.print()`), [Back to case]. Default label size 50 × 25 mm [CONV, same as C5 default].

### 4.4 Movement dialog (used from case workspace and tracking)

| Field | Component | Rule | Required |
|---|---|---|---|
| Items | read-only list of labels (≤200) | — | — |
| Movement | `RadioGroup`: Store, Retrieve, Send out, Return, Discard | — | yes |
| Location | `TextField` ≤120 (e.g. "Block cabinet 3, drawer 2") | required for Store | conditional |
| Destination | `TextField` ≤200 | required for Send out | conditional |
| Reason | `Select`: Second opinion, External stain, Consultation, Retention period ended, Other | — | for Send out and Discard (the API enforces the same rule, 02-TRD M11) |
| Note | `TextArea` ≤500 | — | no |

Discard uses `ConfirmDialog tone="danger"`: "Discarded blocks and slides can't be used again."

### 4.5 Tracking `/anatomic/tracking`

Layout: lookup `BarcodeInput` (auto-focus, `useScanCapture`) + [Basket mode] `Switch`. Single mode: result panel (`DescriptionList`: Label, Type, Case accession (link), Part, Stain (slides), Current location, Last movement) + `Timeline` of movements (newest first; label "{movement} — {location/destination}", actor, time). Basket mode: `DataTable` basket (Label, Type, Current location, remove) + [Record movement] (`Alt+V`). Tabs: Lookup · Sent out (table: Label, Case, Sent to, Since, Reason; sort oldest first).

Copy: not found "No block or slide with this label." Duplicate scan in basket: "Already in the list."

### 4.6 Batches

List `/anatomic/batches`: columns Batch no · Assay · Status · Kit lot · Run at · Members/Capacity. [New batch] `Dialog`: Assay (`Select`, required), Kit name (≤120), Kit lot (≤64), Kit expiry (`DatePicker`), Instrument (≤120), Run at (`DateTimePicker`), Capacity (`IntegerField` 1–384, default 96).

Detail `/anatomic/batches/{batch_id}`: `DescriptionList` header; position grid (`Grid` of `Card`s, 12 columns, position number + accession or empty) [CONV: plate-style grid; capacity not a multiple of 12 leaves the last row partial]; add by scanning accession (`BarcodeInput`) → next free position, or choose position first; [Remove selected]; [Close batch] (`ConfirmDialog`). Empty: "No samples in this batch yet."

### 4.7 Configuration `/anatomic/config`

`Tabs`: Settings · Stains · Test profiles · Assays · Coded lists · Synoptic templates · Text templates.

Settings form: Auto-accession on receipt (`Switch`), Require complete gross before processing (`Switch`), Default routine stain (`CodedSelect` routine stains), Max images per case (`IntegerField` 1–200), Max images per report (`IntegerField` 0–24). Read-only info: "Accession pattern: {pattern} (set by administrators in tenant settings)" and prefixes per kind.

Stains table: Code · Name · Kind · Add-on test · Active; Drawer form: Code (`TextField` ≤32, pattern `^[A-Z0-9_]+$`, create only), Name (≤120), Kind (`Select`), Add-on test (`Combobox` over catalog tests via BFF → C3 HTTP search; optional), Sort order (`IntegerField` 0–9999), Active (`Switch`).

Test profiles table: Test · Case kind · Add-on · Requires gross · Default stain · Default synoptic templates · Active. Drawer: Case kind (`Select`), Is add-on (`Switch`), Requires gross (`Switch`, default on for histology), Default stain (`CodedSelect`), Default synoptic templates (multi `Combobox` ≤5 published keys), Active. Tests listed = catalog tests with `workflow_type` anatomic/molecular (via BFF → C3 HTTP list, `catalog.test.read`).

Assays: table Code · Name · Targets · Active; editor Drawer lg: assay fields + nested targets table (Code, Name, Quantitative `Switch`, Unit code `TextField` ≤32, Decimals 0–6, Active) and per-target result values (Code `^[a-z0-9_]+$` ≤32, Display ≤120, Abnormal `Checkbox`, Active). Codes cannot be deleted, only deactivated (copy under the table).

Coded lists: `Select` of list (Diagnoses, Cytology adequacy, Cancellation reasons; change/amendment reasons are maintained in C5, 08 A17 D-62) + `DataTable` (Code, Display, System, Version, Active) + Drawer (Code ≤64 create-only, Display ≤300, System ≤32 default "local", System version ≤32, Sort order, Active). Notice text on Diagnoses: "Add only codes your lab is licensed to use. No external code sets are included." (`anatomic.config.codes_notice`).

Synoptic templates: table Key · Version · Title · Status · Case kinds · Published. Actions: New template, Open, New version, Publish, Retire. Editor page `/anatomic/config/templates/{template_id}`: left = builder (sections list with add/rename/reorder; fields table per section with add/edit Drawer: Key, Label, Type, Required, Help text, Unit, Min/Max, Decimals, Max length, Options editor, Show if), right = live preview identical to the report editor rendering. Status `published`/`retired` → read-only with banner "Published templates can't be changed. Create a new version." Notice: "Write your own checklists. Do not copy protocol text you do not have rights to." (`anatomic.config.template_notice`).

Text templates: table Short code · Section · Title · Active; Drawer: Short code (≤16 `^[a-z0-9_]+$`, create-only), Section (`Select`), Title (≤120), Body (`TextArea` ≤8000), Active.

Empty states: "No stains yet." etc. with [Add] action.

## 5. Components used (all from `@lims/ui`)

`PageHeader`, `Tabs`, `FilterBar`, `DataTable`, `DescriptionList`, `Timeline`, `Card`, `Stack`, `Inline`, `Grid`, `Divider`, `Badge`, `Tooltip`, `StatusChip` (generic), `Banner`, `EmptyState`, `ErrorState`, `LoadingSkeleton`, `Dialog`, `ConfirmDialog`, `Drawer`, `useToast`, `Menu`, `Button`, `IconButton`, `Form`, `TextField`, `TextArea`, `IntegerField`, `DecimalField`, `Select`, `CodedSelect`, `Combobox`, `Checkbox`, `RadioGroup`, `Switch`, `DatePicker`, `DateTimePicker`, `DateText`, `FileUpload`, `BarcodeInput`, `useScanCapture`, `IdText`, `KeyboardShortcutsDialog`.

Needed and not in the kit: `ImageThumbnailGrid` (CR-C6-010) and `BarcodeSymbol` (CR-C11-007) — both accepted for C0-0D (08 §4.6). The synoptic form is **composed** from kit fields (no new component).

## 6. Accessibility (WCAG 2.2 AA — 02-CV §14)

- Every field has a visible label; required fields marked with text "(required)", not colour.
- Status, flags, "Abnormal", "Critical finding", "Urgent" always carry text.
- Synoptic dynamic fields: when `show_if` reveals a field, focus stays where it was; a polite live region announces "{n} more fields shown".
- Image thumbnails have `alt` = caption or "Image {n}, {kind}, part {letter}" (no patient data).
- Label print page: label text is real text (screen readers, and fallback when barcodes are not printed).
- Keyboard: every action reachable; tables per kit model; Drawer/Dialog trap focus and return it.

## 7. Responsive rules

Staff web target ≥ 1280 px (C0 §6). Case workspace: at `lg` the report preview column moves below the editor; below `lg` the kit banner "best on a larger screen" appears; tables hide columns by `hideBelow` as listed. The labels page prints at the configured label size regardless of screen width.

## 8. Copy — error mapping (problem `code` → message)

| Code | Message |
|---|---|
| `anatomic.case_invalid_transition` | "That step isn't possible for a case in status {status}." |
| `anatomic.signout_locked` | "This case is signed out. Use Revise/Amend or add an addendum." |
| `anatomic.accession_duplicate` | "This accession number already exists. Ask an administrator to check the accession pattern." |
| `anatomic.accession_pattern_invalid` | "Accession numbering is misconfigured. Ask an administrator." |
| `anatomic.ihc_requires_block` | "IHC must be ordered on a block." |
| `anatomic.block_not_available` | "This block is sent out or discarded." |
| `anatomic.report_incomplete` | "Complete the highlighted fields before signing out." |
| `anatomic.template_invalid` | "The template has errors. Fix the highlighted items." |
| `anatomic.template_not_published` | "This template version is not published." |
| `anatomic.image_limit_reached` | "Image limit reached ({max})." |
| `common.upload_quarantined` | "This image is still processing or was blocked by the security scan." |
| `anatomic.order_item_inactive` | "A test on this case was removed from the order." |
| `anatomic.batch_closed` | "This batch is closed." |
| `anatomic.batch_position_taken` | "Position {n} is already used." |
| `lab.result_locked` | "The lab result is approved and locked. Use Amend." |
| `lab.module_result_stale` | "A newer version was already sent to the lab. Reload the case." |
| `lab.module_result_invalid` | "The lab did not accept this result for this test. Check the test's setup." |
| `lab.result_invalid_transition` | "The lab result can't accept a new version now (it may be cancelled)." |
| `lab.amendment_reason_required` | "An amendment needs a reason." |

## 9. User manual pages (`docs/manual/anatomic/`)

`worklist.md`, `accession.md`, `grossing.md`, `blocks-slides.md`, `stains-ihc.md`, `images.md`, `report-signout.md`, `revisions-addenda.md`, `molecular.md`, `tracking.md`, `setup.md` (each with screenshots from synthetic data only).
