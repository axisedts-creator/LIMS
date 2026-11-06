# C14 Smart Report — 04 UI / UX

Status: DECISION, 2026-11-06. Staff web screens are composed only from `@lims/ui` (C0 04-UI-UX §2; 02-CV §14). Missing component → CR (CR-C14-008 `TextDiff`). All copy goes through message keys `smartreport.<screen>.<key>` (02-CV §13); English v1. Route segment `apps/web/src/app/(staff)/smartreport/`. Every page has `loading.tsx` and `error.tsx` and a `PageHeader` with `helpKey`.

---

## 1. Navigation (`apps/web/src/features/smartreport/nav.manifest.ts`)

| Entry | Path | Permission |
|---|---|---|
| Smart summaries | `/smartreport/summaries` | `smartreport.summary.read` |
| Smart report library | `/smartreport/library` | `smartreport.template.manage` (CR) |
| Smart report wording | `/smartreport/wording` | `smartreport.template.manage` |

Route `/smartreport/summaries/{summary_id}` = `staff.smartreport.summary` (03-IC §7). Other paths are module-internal.

## 2. Components used

`PageShell`, `PageHeader`, `DataTable`, `FilterBar`, `StatusChip` (kind `generic`), `Badge`, `Card`, `Stack`, `Inline`, `Grid`, `Tabs`, `Form`, `TextField`, `TextArea`, `IntegerField`, `Select`, `CodedSelect`, `Combobox`, `Checkbox`, `Switch`, `RadioGroup`, `Button`, `IconButton`, `Menu`, `Dialog`, `ConfirmDialog`, `Drawer`, `Banner`, `useToast`, `EmptyState`, `ErrorState`, `LoadingSkeleton`, `DescriptionList`, `Timeline`, `ResultValue`, `FlagBadge`, `DateText`, `IdText`, `Tooltip`, `KeyboardShortcutsDialog`, `TimeSeriesChart` (trend preview in SR-02). Phase 3: `TextDiff` (CR-C14-008).

Status tones (`StatusChip kind="generic"`, text always shown — no colour-only status, 02-CV §14):

| Value | Label | Tone |
|---|---|---|
| summary `draft` | Awaiting review | `warning` |
| summary `approved` | Approved | `success` |
| summary `rejected` | Rejected | `danger` |
| summary `superseded` | Superseded | `neutral` |
| library `draft` / `in_review` / `approved` / `retired` | Draft / In review / Active / Retired | `neutral` / `warning` / `success` / `neutral` |
| band `in_range` / `borderline` / `out_of_range` / `critical` | In range / Borderline / Out of range / Critical | `success` / `warning` / `danger` / `danger` |

## 3. Screens

### SR-01 Review queue — `/smartreport/summaries`

Layout: `PageHeader` ("Smart summaries", helpKey `smartreport.queue`) · `FilterBar` · `DataTable` · footer pagination.

Filters (query params map 1:1 to #27):

| Filter | Kind | Default |
|---|---|---|
| Status | select multiple: Awaiting review, Approved, Rejected, Superseded | Awaiting review |
| Centre | select (centres visible to the user via `ctx.core` list from BFF) | all visible |
| Built | date range (`DateRangePicker`, max 31 days [CONV]) | none |
| Critical only | select Yes/No | No |

Columns:

| Column | Content | Sort |
|---|---|---|
| Built | `DateText withTime` of `built_at` | `built_at` (default ascending = oldest first) |
| Registration no. | `registration_no` (text) | — |
| Patient | `patient_display_name` when available (CR-C5-003), else "—" | — |
| Centre | centre code + name | — |
| Findings | "{deranged_count} outside range" + `Badge` "Critical" when `critical_count > 0` | — |
| Score band | Good / Fair / Needs attention / — | — |
| Status | `StatusChip` | — |

Row action (Enter / double-click): open SR-02. Page size 50. Keyboard: `J`/`K` move row focus, `Enter` open, `/` focus first filter, `?` shortcuts dialog. Empty: `EmptyState` "No summaries waiting for review." Feature off: `Banner tone="info"` "Smart report is switched off for this lab." (+ "Open settings" action only for users with `identity.settings.manage`).

### SR-02 Summary review — `/smartreport/summaries/{summary_id}`

Layout (two columns ≥ `lg`; stacked below):
- **Header:** title "Smart summary", `StatusChip`, registration no., patient display, centre, built time, library version "Library v{n}", formula `hs-1`; actions (only with `smartreport.summary.approve`): **Approve** (primary, `Ctrl+Enter`), **Reject** (danger, `Ctrl+Shift+R`), **Approve & next** (`Ctrl+Shift+Enter`), **Rebuild with active library** (Menu; only when the summary's library ≠ active), **Rephrase with AI** (Phase 3; only when `llm.enabled`).
- **Left — "What the patient will see"** (preview of the rendered section, same order as §4): score card, tiles grid, deranged list grouped by tile, trends (`TimeSeriesChart` per analyte with reference band from `review_inputs`; text table alternative), advice list, follow-up list, disclaimer.
- **Right — "Results used"** (`review_inputs`, only for `summary.approve`): `DataTable` columns Analyte, Result (`ResultValue` + `FlagBadge`), Unit, Reference range, Band (`StatusChip`), Group. Caption "Approved results this summary was built from". Plus `DescriptionList`: unmapped results count ("{n} approved results are not mapped to a body system and are not in this summary"), ignored duplicates.
- **Bottom — History:** `Timeline` from `SmartSummaryView.reviews[]` (08 A22.1: action, actor display name, reason code, time; oldest first) and status timestamps. Item text [CONV]: "Approved by {actor}", "Rejected by {actor} — {reason display}", "Superseded — results changed" (system, no actor), "AI rephrasing requested by {actor}"; reason display from the `summary_reject_reasons` coded set (#26). Empty list → only the "Built {time}" item.

Approve: `ConfirmDialog` title "Approve this summary?", body "I have read every sentence and confirm it is appropriate for this patient." confirm label "Approve"; sends `attestation: true` and (Phase 3) `use_llm_text` from a `Switch` "Use AI-rephrased wording" (default off; disabled when no validated overlay). On `409 summary_superseded`: `Banner tone="warning"` (03-APP-FLOW §4). On success: `Banner tone="success"` "Approved. The PDF report will include this summary the next time it is generated. Use Regenerate on the report screen to add it now." + action "Open order results" (route `staff.lab.order_results` by `order_id`; shown only with `lab.result.read`) — C14 stores no report id (03-APP-FLOW §2.6).

Reject: `ConfirmDialog` `requireReason` codedSet `smartreport.summary_reject_reasons` (from #26 `getSmartCodedSet`) (seed: `wording_problem`, `library_error`, `not_appropriate_for_patient`, `results_under_review`, `other`), free text ≤ 500, required for `other`.

Phase 3 LLM panel: per item `TextDiff` (template vs AI text) or, until CR-C14-008, two stacked `Card`s labelled "Approved template text" / "AI-rephrased text"; failed items show `Badge` "Kept original" with the failure codes.

Superseded/rejected/approved summaries: read-only; superseded shows "Replaced by a newer summary" link (`superseded_by_summary_id`).

### SR-03 Library versions — `/smartreport/library`

`DataTable` columns: Version (`v{n}`), Status (`StatusChip`), Language (English / Nepali), Approved by (`approved_by_display_name` from the API, resolved through `ctx.core.memberships.list` — 08 A17 P-17), Approved on, Updated. Header actions: **New draft** (`Menu`: "From active version", "From starter draft", "From version…" → `Select` of versions) — disabled with `Tooltip` "A draft or a version in review already exists" when one exists. Row action opens SR-04 (draft) or SR-05 (in review / approved / retired, read-only).

### SR-04 Library editor — `/smartreport/library/{library_version_id}`

`Tabs`: **Settings & score** · **Body systems** · **Analyte mapping** · **Texts** · **Rules** · **Check & submit**. Read-only when status ≠ `draft` (all fields `isReadOnly`, banner "This version is {status}; create a new draft to change it.").

**Settings & score** (`Form`, `PATCH #4`, `If-Match` from loaded version):

| Field | Component | Validation / default |
|---|---|---|
| Language | `RadioGroup` English / Nepali (Devanagari) | required; default English |
| Change summary | `TextArea` | ≤ 500 |
| Show health score | `Switch` | default on |
| Credit: in range / borderline / out of range / critical | `IntegerField` ×4, suffix "%" shown as bp ÷ 100 | 0–100 % each; non-increasing order enforced client + server |
| Minimum body systems for a score | `IntegerField` | 1–20, default 2 |
| "Good" from / "Fair" from | `IntegerField` ×2 | 1–100 / 0–99, fair < good; defaults 80 / 60 |
| Any critical result forces "Needs attention" | `Checkbox` | default on |
| Borderline margin (% of range width) | `IntegerField` (bp ÷ 100) | 0–25 %, default 0 = off; help text "0 means no borderline band." |
| Minimum mapped results per order | `IntegerField` | 1–50, default 3 |
| Trends: enabled / max points / look-back days / stable change % / max trends | `Switch`, `IntegerField` ×4 | 2–6 / 30–3650 / 0–50 % / 0–12; defaults 4 / 730 / 10 % / 6 |
| Max advice blocks / Max follow-up suggestions | `IntegerField` ×2 | 0–10 / 0–5; defaults 5 / 3 |

A fixed info `Card` explains formula `hs-1` in words (same text as 02-TRD §4.4 steps 1–5, message keys).

**Body systems** (`DataTable`, inline edit via `Drawer` + `Form`, `PUT #17`): columns Code, Display (English), Display (Nepali), Weight (0–10), Order, Shown (`Switch`). Display English 1–60 required; Nepali ≤ 60, required when language = Nepali.

**Analyte mapping** (`PUT #14` / `DELETE #15`): add via `Combobox` searching the tenant catalogue (BFF calls C3 HTTP search) → `Select` body system → `Checkbox` "Include in score" (default on), `Checkbox` "Show trend" (default off), optional `IntegerField` borderline margin override, optional stable-change override. Table columns: Analyte (name + code), Test, Body system, In score, Trend, Overrides, actions (Edit, Remove — `ConfirmDialog`; Remove deactivates the mapping, 08 A17 P-18(a)). Bulk keyboard: `A` add, `Delete` remove focused row (confirm).

**Texts** (`#5–#8`): list grouped by kind (Findings, Advice, Follow-up, Disclaimer, Score explanation). Editor `Drawer`:

| Field | Component | Validation |
|---|---|---|
| Key | `TextField` | `^[a-z][a-z0-9_.]{2,79}$`, required, immutable after create |
| Kind | `Select` | required, immutable after create |
| English text | `TextArea` `showCount` | ≤ 600; required when language English |
| Nepali text | `TextArea` `showCount`, `lang="ne"` | ≤ 600; required when language Nepali |
| Author note (not printed) | `TextArea` | ≤ 500 |

Below the text: chips of allowed placeholders for the kind (click inserts `{name}`); live client-side checks (digits, links, deny terms, unknown placeholders) shown as field errors; the server repeats them at validation.

**Rules** (`#9–#12`): sub-tabs Findings / Advice / Follow-up. Editor `Drawer` fields: Trigger (`RadioGroup`: Analyte / Body system / Any finding / All in range (advice only)); Analyte (`Combobox`, when Analyte); Body system (`Select`, when Body system; options from #35 `getSmartLibraryCodedSet('organ_groups')`, 08 A19 P-43); Direction (`Select` Low / High / Abnormal / Any); Minimum severity (`Select` Borderline / Out of range / Critical; hidden for All in range); Priority (`IntegerField` 1–999, default 100); Text (`Select` of blocks of the same kind); for Follow-up: Suggested test (`Combobox` over active catalogue tests) and Interval in days (`IntegerField` 1–730, **required, no default**). Follow-up sub-tab shows a fixed `Banner tone="info"`: "Follow-up suggestions are shown to patients. Keep them conservative; they must be justified by a finding. Prices and booking links are never shown."

**Check & submit**: button **Run checks** (#18) → issues `DataTable` (Severity, Code, Where, Detail; row action jumps to the tab/row). **Preview** (`Dialog`, #22): `RadioGroup` "Synthetic example" (fixtures) / "Real order" (`TextField` order id pasted from the lab screen; only shown with `lab.result.read`). **Submit for approval** (#19; disabled while errors exist).

### SR-05 Library review / approve — `/smartreport/library/{library_version_id}/review`

Read-only rendering of all tabs; a "Changes since active version" summary (counts of added/changed/removed blocks, rules, mappings computed by the BFF from both versions' lists). Actions (with `smartreport.template.approve`): **Approve** (`ConfirmDialog`: "I have reviewed every text, rule and interval in this library and approve it for patient summaries." optional note ≤ 500) and **Return to draft** (`Dialog` with `TextArea` comment 1–1000, required). Step-up MFA handled by the shell on `auth.mfa_required`.

### SR-06 Wording terms — `/smartreport/wording`

`DataTable` columns Term, Language, Scope (Global / This lab), Reason, Active; global rows have no actions. **Add term** `Dialog`: Term `TextField` 2–60, Language `Select` (English / Nepali / Any), Reason `TextArea` ≤ 200. Deactivate via row action (`ConfirmDialog`).

### Accessibility and responsive rules

WCAG 2.2 AA (02-CV §14): every status has a text label; charts have the data-table alternative; focus moves to the error summary on failed submit; review actions reachable by keyboard; Devanagari text fields use `lang="ne"`; components use `min-height` so Devanagari never clips (C0 04-UI-UX). Breakpoints: SR-02 two columns ≥ `lg`, one column below; tables hide Centre and Score band below `md`.

### In-app help and manual

Help keys: `smartreport.queue`, `smartreport.review`, `smartreport.library`, `smartreport.library_editor`, `smartreport.library_review`, `smartreport.wording`. Manual pages under `docs/manual/smartreport/`: overview (what patients see and why nothing is free-generated), library authoring, approval responsibilities (B14), health score formula, review workflow, LLM layer (Phase 3, when enabled).

---

## 4. Rendered section (PDF via C6; `services/renderer/templates/smart/`)

### 4.1 Contract

`export const smartSectionRenderer: SmartSectionRenderer = { libraryVersion: 'smart-section-1', renderSections }` (C6-TRD §5.3). `renderSections({ summary, calendarDisplay, timezone })`:
- `summary.status !== 'approved'` → returns `''` and logs `smart_render_not_approved` (no PHI).
- Output: one `<section class="smart-section">` fragment. Allowed elements: `section, div, h2, h3, p, ul, ol, li, table, thead, tbody, tr, th, td, span, strong`. Attributes: `class` (only `smart-*` classes, CR-C14-007), `lang`, `aria-label`, `scope`. No `style`, no `img`, no `svg`, no links, no `<script>` (C6-TRD §5.3 rules).
- All text is inserted as React text nodes (escaped). Devanagari text elements carry `lang="ne"`.
- Dates via `@lims/shared-ts/bsdate` honouring `calendarDisplay` (02-CV §13 formats).
- Numbers (`valueNumeric`, score) printed verbatim; never re-formatted or rounded.

### 4.2 Layout (top to bottom; C6 decides where the section sits in the report — recommendation: right after the patient header block, before department results)

| # | Block | Content |
|---|---|---|
| 1 | Title (`h2.smart-title`) | "Smart summary" |
| 2 | Notice (`p.smart-notice`) | fixed notice (§4.3 N1) |
| 3 | Score (`div.smart-score`) — only if `healthScore` | "Health score (not a diagnosis)": `{value} / 100` · band word · "Based on {panelsScored} body systems" · `explanationText` |
| 4 | Tiles (`ul.smart-tiles`) | one `li.smart-tile.smart-status-<status>` per panel: `displayName` + status word |
| 5 | Findings (`h3` "Results outside the reference range" + `ul.smart-list`) — omitted when empty | per deranged entry: direction word ("High"/"Low"/"Abnormal"), severity word, `text` |
| 6 | Trends (`h3` "Your results over time" + `table.smart-trends`) — omitted when empty | per trend: analyte name, unit, points as "date: value" cells (oldest → newest), direction word |
| 7 | Advice (`h3` "Suggestions" + `ul.smart-list`) — omitted when empty | `text` |
| 8 | Follow-ups (`h3` "Tests your doctor may consider" + `ul.smart-list`) — omitted when empty | `text` + "({suggestedTestName}, after {intervalDays} days)" |
| 9 | Disclaimer (`p.smart-disclaimer`) | tenant `disclaimerText` |
| 10 | Meta (`p.smart-meta`) | "Reviewed and approved by the laboratory's pathologist on {approvedAt}. Summary library version {templateLibraryVersion}; score formula {formulaVersion}." |

### 4.3 Fixed copy (`labels.en.ts`; English; DECISION)

| Key | Text |
|---|---|
| N1 notice | "This summary is prepared from your approved laboratory results using rules approved by the laboratory's pathologist. It is not a diagnosis or a prescription. Please discuss your results with your doctor." |
| Status words | In range · Borderline · Out of range · Critical |
| Direction words | High · Low · Abnormal |
| Trend words | Improved · Worsened · Stable |
| Band words | Good · Fair · Needs attention |
| Headings | as §4.2 |

When the library language is Nepali, block texts (findings, advice, follow-ups, disclaimer, score explanation, display names) are Nepali; the fixed copy above stays English because no verified Nepali translation is provided (PRD §10). Adding Nepali fixed copy later = a `labels.ne.ts` file reviewed by the tenant pathologist.

Wording rules (all enforced by validation or code): no diagnosis wording, no product/medicine names, no prices, no links or phone numbers, no digits in authored text, every sentence from an approved block, notice + disclaimer always present.

## 5. Display contract for the patient app (C16) and the portal (C6)

- **Source (08 A2.3):** the approved `SmartSummary` JSON snapshot C6 stores on the report version (written at first assembly or at Regenerate, reason `smart_summary_added` — 08 A4.4), read through `ReportingPort` / portal reads — never `SmartReportPort` (staff/system only). No snapshot → the C16 app shows "Your summary is not available yet. Your full report is available below." — wording owned by C16 (applies to C16 only; the portal hides its section, below).
- **Must show,** in the order of §4.2: notice N1, score with "(not a diagnosis)" when present, tiles with text status words, findings, trends (a chart is allowed; a text alternative is required), advice, follow-ups with test name and interval, disclaimer, approval line.
- **Must not:** reorder findings by anything other than the given order; hide findings; add prices, booking buttons or promotions next to follow-ups or advice (PRD §4 rows 7–8); show a `draft` summary; cache a summary after the app learns of a newer report version (refetch on `reporting.report.released.v1`, which C16 consumes).
- **Portal (C6):** C6 renders a read-only "Health summary" section on the portal report page from the snapshot, hidden when the snapshot is absent, with the same disclaimer text (08 A4.7). The "not available yet" copy above is not used on the portal.

## 6. Operator / developer experience

- Library authoring API is conventional REST (02-CV §4); every write returns the full object with `version`.
- Errors are problem+json with codes from 02-TRD §13; validation issues carry JSON Pointers that the UI maps to fields.
- No CLI. Support staff inspect a summary through SR-02 under a support session (C2).
