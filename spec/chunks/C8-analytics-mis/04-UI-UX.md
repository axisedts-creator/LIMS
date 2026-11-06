# C8 Analytics & MIS — 04 UI/UX

Status: DECISION, 2026-11-06. Components are **only** from `@lims/ui` (C0 04-UI-UX §2); names below are the kit's. Message keys follow `analytics.<screen>.<key>` (CV §13); English copy v1 given in quotes. `PeriodPicker`, `DurationText` and `FreshnessBadge` are kit components (CR-C8-013 accepted; C0 04-UI-UX §2.2/§2.5); C8 composes only `ExportDialog` and `ScopeBanner` locally from kit primitives (no look-alike components, 08 R22).

## 1. Navigation (`apps/web/src/features/analytics/nav.manifest.ts`)

```ts
export const navManifest: NavManifest = {
  module: 'analytics',
  entries: [
    { id: 'analytics.dashboard', label: 'analytics.nav.dashboard', routeId: 'staff.analytics.dashboard',
      permission: 'analytics.dashboard.read', group: 'analytics', order: 10, icon: 'chart', chord: 'g o' },
    { id: 'analytics.reports', label: 'analytics.nav.reports', routeId: 'staff.analytics.reports',            // CR-C8-008
      permission: 'analytics.dashboard.read', group: 'analytics', order: 20, icon: 'table', chord: 'g m' },
    { id: 'analytics.collections', label: 'analytics.nav.collections', routeId: 'staff.analytics.collections', // 08 A17 D-46
      permission: 'analytics.collections.read', group: 'analytics', order: 25, icon: 'table' },
    { id: 'analytics.referral', label: 'analytics.nav.referral', routeId: 'staff.analytics.referral_incentive', // CR-C8-008
      permission: 'analytics.referral_report.read', group: 'analytics', order: 30, icon: 'users' },
    { id: 'analytics.exports', label: 'analytics.nav.exports', routeId: 'staff.analytics.exports',
      permission: 'analytics.data.export', group: 'analytics', order: 40, icon: 'download' },
    { id: 'analytics.schedules', label: 'analytics.nav.schedules', routeId: 'staff.analytics.schedules',
      permission: 'analytics.schedule.manage', group: 'analytics', order: 50, icon: 'calendar' },
  ],
};
```
Labels: "Owner dashboard", "MIS reports", "Collections history", "Referral business report", "My exports", "Scheduled reports". The referral entry is additionally hidden by the BFF when `referralIncentiveReportEnabled` is false (nav filtering hook `features/analytics/hooks/useNavVisibility.ts`; the shell filters by permission, C8 filters by flag). Icon names must exist in the kit icon set; if `chart`/`table`/`users`/`download`/`calendar` are missing, use the closest kit icon and list it in CR-C8-013. Chords `g o`, `g m` must be unique across manifests (build check); on conflict the build fails and C8 picks another.

All routes are in 03-IC §7 (CR-C8-008 accepted; `staff.analytics.collections` added by 08 A17 D-46). A `finance` user (collections only) sees just "Collections history".

## 2. Shared page frame (all C8 pages)

```
┌ PageHeader: title · breadcrumbs · actions [Refresh] [Export ▾] · helpKey ─────────────────────────────┐
│ FreshnessLine: "Updated 10:42 (Nepal time)" + per-family stale badges                                    │
├ FilterBar ──────────────────────────────────────────────────────────────────────────────────────────────┤
│ Period ▾ (presets)  [custom range]  Centre ▾ (multi)  Branch ▾ (multi)  <report-specific filters>  Reset │
├ Banner slot: tenant-wide-only notice · timezone notice · MFA notice ─────────────────────────────────────┤
│ Content (Grid of Card)                                                                                    │
└ Help panel (Alt+H) ───────────────────────────────────────────────────────────────────────────────────────┘
```

| Element | Kit components | Rules |
|---|---|---|
| Period selector | `@lims/ui` `PeriodPicker` (presets: Today, Yesterday, This B.S. month, Last B.S. month, This fiscal year, Last fiscal year, This A.D. month, Last A.D. month, Custom; `calendar` = tenant primary; custom range limited to 366 days) | default Today on dashboard, This B.S. month on reports when tenant `calendarDisplay` primary is BS, else This A.D. month [CONV]. Header shows the API `period.label_ad` and `period.label_bs` ("01/11/2026 – 30/11/2026 · 2083-07-15 – … B.S." style per `DateText`) |
| Centre filter | `Select` multi via `FilterBar` `kind:'select', multiple:true` | options from `getAnalyticsFilterOptions` (caller scope only); max 20 selections; hidden when the user has exactly one centre |
| Branch filter | same | max 20 |
| Freshness | `@lims/ui` `FreshnessBadge` (`refreshedAt`, `isStale`, `reason`) | text "Updated {time}"; stale → tone `warning` "Data may be out of date" with tooltip giving reason: `refresh_lagging` "Recent changes are still being processed", `refresh_failed` "Last update failed — the team has been alerted", `never_refreshed` "Not yet calculated" |
| Refresh action | `Button variant='secondary' iconStart='refresh'` | calls `requestAnalyticsRefresh`; disabled for 5 min after use (shows "Refresh available at {time}"); `429` → toast with the same text |
| Export action | `Menu` (Excel, CSV, PDF) | visible only with `analytics.data.export`; PDF item disabled with tooltip "PDF export is not available yet" while `LIMS_ANALYTICS_PDF_ENABLED=false` |
| Money | `MoneyText grouping='lakh'` | negative values with leading minus and tone `danger` text only for net sales < 0 (colour is never the only cue — the minus sign is) |
| Durations | `@lims/ui` `DurationText` | `< 1 h` → "42 min"; `< 48 h` → "5 h 12 min"; else "3 d 4 h" [CONV]; tooltip exact seconds |
| Percent / bp | formatted from `_bp`: one decimal place + "%" | "—" when undefined |
| Dates | `DateText` (tenant `calendarDisplay`) | |
| Tenant-wide notice | `Banner tone='info'` | `analytics.scope.tenant_wide_only` "Some figures are only available to users with access to all centres." — shown when `scope.tenant_wide_sections_hidden` is non-empty; no Phase-1 family triggers it (CR-C8-004/005 accepted), so it stays for later families. NULL-centre rows hidden from centre-restricted users need no banner |
| Timezone notice | `Banner tone='info'` | `analytics.tz.fixed_nepal` "Business days are counted in Nepal time (UTC+05:45)." |

Page keyboard shortcuts (registered with `shortcuts.register(pageId, …)`; C0 04-UI-UX §4):

| Keys | Action | Pages |
|---|---|---|
| `Alt+P` | focus Period selector | all report pages |
| `Alt+C` | focus Centre filter | all |
| `Alt+R` | Refresh | dashboard |
| `Alt+E` | open Export menu | pages with export |
| `Alt+1`…`Alt+9` | switch report tab | report hub |

No barcode input on any C8 screen (C8 shows no barcodes).

## 3. S1 Owner dashboard (`/analytics`)

Layout (≥ `xl`): row 1 = 6 `StatTile`s in a `Grid` (3 columns at `lg`, 2 at `md`, 1 below); row 2 = `TimeSeriesChart` (net sales per day) + `BarChart` (top 10 departments by net sales); row 3 = `Card` "Reports pending" (stage × age bucket table) + `Card` "Pending tests" (by status; overdue count) + `Card` "Top referrers" (5 rows: referrer, orders, patient visits — no money column, 08 A17 D-44; link to report) + `Card` "Top centres" (5 rows).

| Tile | Label | Value | Sub-value / delta | href |
|---|---|---|---|---|
| T1 | "Patient visits" | M04 | "New patients {M05}" ; delta vs previous period | `/analytics/reports/volume` |
| T2 | "Income (net sales)" | M12 | "Invoiced {M10} · Credit notes {M11}" ; delta | `/analytics/reports/income` |
| T3 | "Results approved" | M42 | "Tests ordered {M08}" ; delta | `/analytics/reports/tests-done` — shown to every user, centre-scoped (CR-C8-004 accepted) |
| T4 | "Reports pending" | M52 | "Ready, not released {M54}" (snapshot: no delta) | `/analytics/reports/pending-tests` |
| T5 | "Pending tests" | M50 | "Overdue {M51}" (tone warning when > 0; snapshot: no delta) | `/analytics/reports/pending-tests` |
| T6 | "Cash collected (net)" | M27 | delta | `/analytics/collections` (`staff.analytics.collections`) — only with `analytics.collections.read` |

Delta copy: `StatTile.delta = { value: "+12 (8.1%)", direction: 'up', isGood: true }`; for credit notes/overdue, `isGood` is inverted. "vs yesterday" / "vs previous {n} days" caption (`analytics.dashboard.delta_caption`).

Tooltip on T1 (`analytics.metric.patient_visits.help`): "Counts each patient once per centre per day. Over several days the same person can be counted more than once."
Tooltip on T2 (`analytics.income.basis_note`): "Income = invoices issued (incl. VAT/other tax) minus credit notes. Cash collected is shown separately."

Empty (all zeros): tiles still render with 0; under row 1 an `EmptyState` (small) "No activity in this period" with action "Show yesterday".

## 4. S2 Report hub (`/analytics/reports`) and S3 report pages

`Tabs` across the top (badge none): Income · Departments · Collections · Volume · Referrers · Centres · Tests done · TAT · Pending tests · Quality · Delivery · Interfaces. Tabs the user cannot use are not rendered (collections without `analytics.collections.read`). Each tab is the page `/analytics/reports/{report_code}` (hyphenated slugs = `income`, `department-income`, `volume`, `top-referrers`, `top-centres`, `tests-done`, `tat`, `pending-tests`, `quality-indicators`, `delivery`, `interfaces`), except Collections, which links to `/analytics/collections` (route `staff.analytics.collections`, 08 A17 D-46).

Common table rules: `DataTable density='compact' stickyHeader caption=<report title>`; numeric columns `align='end'` (tabular numerals from the kit); totals row rendered as the last row with `isRowHeader` "Total"; sort only on server-sortable columns (top lists); client-side column sort is not offered (consistency with exports).

### 4.1 Income (`income`)
Filters: period, centre, branch, Group by `RadioGroup` [Day, A.D. month, B.S. month, Branch, Centre].
Columns: Period/Centre/Branch (row header) · Invoices · Cancelled · Gross · Discount · Exempt · Taxable · VAT · Other tax · Invoiced · Credit notes · **Net sales**.
Chart above table: `BarChart` net sales per group (≤ 31 bars; above that the chart is hidden and a note "Chart shows up to 31 groups" appears).
Footnote: basis note (above) + "Matches the sales register and credit-note register for the same dates." (`analytics.income.reconcile_note`).

### 4.2 Departments (`department-income`)
Group by [Department, Department × A.D. month, Department × B.S. month]. Columns: Department · Billed lines · Gross · Discount · Net sales · Share. Row "Multiple departments" (`analytics.department.multiple`) for packages. If `reconciles_with_income` is false → `Banner tone='warning'` "Department totals do not match income for this period. The team has been alerted." (never hide figures).

### 4.3 Collections (`/analytics/collections`, S2b)
Own page (route `staff.analytics.collections`, permission `analytics.collections.read`; filter options from `getCollectionsFilterOptions` #30). Group by [Method, Staff, Staff × method, Centre, Day, A.D. month, B.S. month]; filter Method (`Select` multi; labels `analytics.payment_method.<code>`, fallback code). Columns: Group · Payments · Reversals · Collected · Reversed/refunded · **Net collected**. Header link (when the user holds `billing.cash_report.read`): "Today's cash report and session close" → `buildRoute('staff.billing.daily_cash')`. Note: "Cash basis — includes payments of earlier invoices; differs from income." (`analytics.collections.basis_note`). Rows with no centre appear as "No centre (credit parties)" only for all-centre users.

### 4.4 Volume (`volume`)
Group by [Day, A.D. month, B.S. month, Branch, Centre]. Columns: Group · Orders · Cancelled · Net orders · Patient visits · New patients · Urgent · OPD · IPD · Tests ordered.

### 4.5 Referrers (`top-referrers`)
Controls: Sort `Select` [Orders, Patient visits, Tests ordered]; Limit `Select` [10, 20, 50, 100]; `Switch` "Combine merged doctors" (default on = `rollup=canonical`). Referrer filter: `Combobox` multi using `searchAnalyticsReferrers` (POST body; min 2 chars, debounce 150 ms) — selecting narrows to those referrers (query param `referrer_id`, ≤ 20). Columns: Rank · Referrer · Orders · Patient visits · Tests ordered. No money column (08 A17 D-44: net billed per referrer is only in the referral business report). "SELF" row label `analytics.referrer.self` "SELF (no referrer)".

### 4.6 Centres (`top-centres`)
Sort [Orders, Net sales, Patient visits, Tests ordered]; Limit [10, 20, 50]. Columns: Rank · Centre · Orders · Walk-in · Home · Centre · Partner · Patient visits · Tests ordered · Net sales.

### 4.7 Tests done (`tests-done`)
Filters: processing branch, department. Group by [Department, Test, Processing branch, Day, A.D. month, B.S. month]. Columns: Group · Resulted · Verified · Approved · Amended · Auto-verified · Critical · Abnormal (these seven captioned "Results (analyte level)", `analytics.tests_done.analyte_level`) · Tests completed (`analytics.tests_done.tests_completed`). Centre-restricted users see their centres' rows (CR-C8-004 accepted).

### 4.8 TAT (`tat`)
Filters: segment `Checkbox` group (5 segments, default all), priority `Select` [All, Routine, Urgent], specimen type `Select` multi, processing branch, centre; Group by [None, Centre, Processing branch, Priority, Specimen type, Day, A.D. month, B.S. month].
Segment definition list (`DescriptionList`, always visible above the table):
| Segment | Start → stop (message keys `analytics.tat.<segment>.start/.stop`) |
|---|---|
| Pre-analytical | "Sample collected" → "Received at lab" |
| Transport | "Scanned out at centre" → "Scanned in at lab" |
| Within-lab | "Received at lab" → "First result verified" |
| Total (first report) | "Registered" → "First report released" |
| Total (final report) | "Registered" → "Final report released" |
Columns: Segment · Group · Samples (n) · Median · 90th percentile · Max · Excluded (anomalies). n = 0 → "—" in stat columns. Note: "Server times are used, not analyser clocks." (06-GLOSSARY) and "Priority and specimen-type filters apply to sample segments only."

### 4.9 Pending tests (`pending-tests`)
Top: three `StatTile`s (Pending, Overdue, No TAT target) + `Card` "Reports pending" (stage × age bucket table, from backlog). Then `BarChart` by department (pending vs overdue). Then the list:
Filters: department, priority, item status (`Select` multi: Awaiting collection, Awaiting receipt, In process, Resulted, Verified — labels via kit status mapping where available, else `analytics.item_status.<code>`), `Switch` "Overdue only", centre, processing branch.
Columns: Department · Test (code — name) · Priority (`Badge`, "Urgent" text) · Status · Centre · Age (DurationText) · Target (DurationText or "—") · Overdue (text "Overdue"/"") · action "Open" (only when `open_route_id`).
`DataTable page` cursor pagination, limit 50; sort Age desc/asc. Note `analytics.pending.age_anchor` "Age since receipt at the lab, or since registration if not yet received." No patient name, number or barcode column exists.

### 4.10 Quality (`quality-indicators`)
Two `Card`s. Rejections: group by [Reason, Centre, Specimen type, Day, A.D. month, B.S. month]; columns Group · Rejections · Recollections ordered · Specimens received · Rejections per 100 received. Reason label: kit coded display if the coded set is exposed to the UI, else the code with "_" → space (DECISION; display view is a C5 CR candidate). Critical values (centre-scoped, CR-C8-004): per-day table Date · Detected · Notified · Notified % · Median time to notify · Max time to notify; summary row shows totals and max; note "Median is shown per day only."

### 4.11 Delivery (`delivery`)
Deliveries (centre-scoped, CR-C8-005; deliveries not linked to a report are shown only to all-centre users): group by [Channel, Day, A.D. month, B.S. month]; columns Group · Queued · Sent · Delivered · Read · Failed · Suppressed · Failure share. Note `analytics.delivery.cohort_note` "Counted on the day each message was created; later status changes update that day." (08 A17 D-48). Releases: same group options; columns Group · Released · Final · Partial · Preliminary · Amended · Override releases.

### 4.12 Interfaces (`interfaces`)
Agents card: counts by state (`StatusChip kind='generic'` with text Online/Offline/Backlog/Degraded) and a table Agent (IdText) · Centre · State · Last heartbeat (DateText withTime) · Version · Queue. Messages table: Instrument (label = `display_name` with `instrument_code`, "(inactive)" suffix when inactive; `IdText` only when the directory has no row) · Centre · Messages · Patient records · QC records · Unmatched · Quarantined · Duplicates. Link per agent → `staff.instruments.agent` when the user holds `instruments.agent.read`.

## 5. S4 Referral business report (`/analytics/referral-incentive`)

Title `analytics.referral.title` "Referral business report". Subtitle `analytics.referral.subtitle` "Orders and billing by referring doctor. For internal review only." Footer `analytics.referral.logged` "Viewing this report is recorded."
Filters: period (default Last B.S. month [CONV]), centre, Group by [Referrer, Referrer × A.D. month, Referrer × B.S. month], Switch "Combine merged doctors".
Columns: Referrer · (Period) · Orders · Patient visits · Tests ordered · Net billed ("—" on the SELF row: not available). Note `analytics.referrers.billed_note` "Net billed counts credit-party work on the day it was charged." under the table. Cursor pagination 50/page. No column, button or text implies a rate, amount payable or payment. Forbidden words list enforced by CI for all C8 copy: "commission" (case-insensitive).
States: MFA required → `Banner tone='warning'` "Verify with your authenticator app to open this report." + `Button` "Verify now" (C2 step-up route); flag off → full-page `EmptyState` "This report is not enabled for your lab." (no further detail).

## 6. Export dialog (from any report page)

`Dialog size='sm' title='Export report'`:
| Field | Component | Validation | Default |
|---|---|---|---|
| Format | `RadioGroup` [Excel (.xlsx), CSV (.csv), PDF] | required; PDF disabled until enabled | Excel |
| Summary | `DescriptionList` (report, period A.D./B.S., centres, group by) | read-only | current page state |
| Acknowledgement | `Checkbox` "I will keep this file inside the lab and delete it when no longer needed." | required to enable Export | unchecked |
Buttons: `Button variant='primary'` "Export" (`isLoading` while posting), "Cancel". On `202` → toast (`tone:'success'`, "Export queued", description "You can download it from My exports.") and close. Errors: `429` → inline `Banner tone='warning'` "Export limit reached. Try again at {time}."; `auth.mfa_required` → banner with "Verify now"; `analytics.range_too_large` → "Choose 366 days or fewer.".

## 7. S5 My exports (`/analytics/exports`)

`DataTable` columns: Requested (DateText withTime) · Report · Period · Format · Status (`StatusChip kind='generic'`: Queued/Building = neutral, Ready = success, Failed = danger, Expired = neutral) · Rows · Size · Downloads ("1 of 3") · Expires · action Download (primary when ready). Filter: status. Poll every 3 s while any row is queued/building (max 2 min, then manual refresh button) [CONV]. Failure reasons: `analytics.export_too_large` "Too much data — choose a shorter period or fewer centres."; `auth.forbidden` "You no longer have access to this data."; `common.feature_disabled` "This report is disabled for your lab."; other → "Export failed. Reference: {request id}".
Download uses a plain `<a>` to the BFF download route (attachment; the BFF streams the API response with `Cache-Control: no-store`); no blob URLs kept in memory.

## 8. S6 Scheduled reports

List: `DataTable` Name · Reports (count + first two names) · Frequency ("Daily at 07:00", "Weekly on Sunday at 08:00", "Monthly (B.S.) on day 1 at 07:00") · Period ("Previous day", …) · Recipients (count) · Next send (DateText withTime) · Status (Active/Inactive) · row action Edit / Deactivate (ConfirmDialog "Stop sending this report?").
Editor (`Form`, Ctrl+Enter submits):
| Field | Component | Validation (mirrors spec) | Default |
|---|---|---|---|
| Name | `TextField maxLength=80` | required, 1–80; no `@`, no run of ≥ 7 digits, no `://` or `www.` (server rule, 08 A5.4) → "Names cannot contain email addresses, phone numbers or web addresses" [CONV: copy] | — |
| Reports | `Checkbox` list of schedulable report codes the user can access | 1–10 | Dashboard, Income |
| Frequency | `RadioGroup` [Daily, Weekly, Monthly (A.D.), Monthly (B.S.)] | required | Daily |
| Weekday | `Select` (Sunday…Saturday, ISO 7,1…6) | required iff Weekly | Sunday |
| Send time (Nepal time) | `Select` of 96 quarter-hour values 00:00…23:45 | required | 07:00 |
| Period | `Select` [Previous day, Previous 7 days, A.D. month to date, Previous A.D. month, B.S. month to date, Previous B.S. month, Fiscal year to date] | required | Previous day |
| Centres | `RadioGroup` [All centres (only if the user has all), Selected] + `Select` multi | ⊆ own scope; ≤ 20 | user's scope |
| Recipients | `Combobox` multi of tenant staff: `recipients` of `getAnalyticsFilterOptions` (#16; present only for holders of `analytics.schedule.manage`; = `ctx.core.memberships.list({ permission: 'analytics.dashboard.read' })`, 08 A17 D-47) — display names only | 1–20; ineligible → field error "{name} cannot receive this report" | creator |
Info text under the form: "Recipients get an email with a link only. They must sign in to see the figures." (`analytics.schedule.link_only_note`).
Run log (on the edit page): last 20 runs: Slot time · Period · Sent · Skipped · Omitted reports.

## 9. S7 Report run (`/analytics/report-runs/{report_run_id}`)

Header: "{schedule name} — {period A.D./B.S.}" and `Banner tone='info'` "Figures as of now for this period. Your access limits apply." Content: for each report code in the run that is not in `viewer_omitted_report_codes`, a `Card` with the same component used on its report page (read-only filters showing the run's period and scope). Not-found copy: "This report link is not for your account or has expired."

## 10. Accessibility (WCAG 2.2 AA, CV §14)

- Every chart has the kit's visually hidden data table; chart titles name the metric and the period.
- Tiles are links with accessible names "Income (net sales): NPR 2,25,000, up 8.1 percent vs yesterday" (composed by the tile).
- Status and staleness never rely on colour: text labels ("Overdue", "Data may be out of date").
- Tables have captions; totals row is a `<th scope="row">`.
- Focus order: header actions → filters → content; filter changes announce "Results updated" via `aria-live="polite"` region (kit `VisuallyHidden`).
- Devanagari labels (doctor/centre names entered in Nepali) render with the kit font stack (Noto Sans Devanagari bundled, 04 S14).

## 11. Responsive (C0 04-UI-UX §6)

Staff web ≥ 1280 px primary. At `lg`: tiles 3 per row, charts stacked. Below `lg`: kit "best on a larger screen" banner; tables use `hideBelow` on secondary columns (Exempt, Taxable, Other tax, Gross; TAT Max/Excluded; Delivery Queued/Read) and keep the row header + main metric. No horizontal page scroll; tables scroll inside their `Card`.

## 12. Help and manual

`help/<screen>.md` per screen (dashboard, each report, referral, exports, schedules, report run) explaining every metric with its M-id definition in plain words, the business-day rule, B.S. periods, freshness and centre scope. `docs/manual/analytics/` mirrors them with screenshots from synthetic tenants only.

## 13. Copy keys (complete list for translators; English v1)

| Key | Text |
|---|---|
| `analytics.nav.dashboard` | Owner dashboard |
| `analytics.nav.reports` | MIS reports |
| `analytics.nav.referral` | Referral business report |
| `analytics.nav.exports` | My exports |
| `analytics.nav.schedules` | Scheduled reports |
| `analytics.dashboard.empty` | No activity in this period |
| `analytics.dashboard.delta_caption` | vs {previous_label} |
| `analytics.metric.patient_visits.help` | Counts each patient once per centre per day. Over several days the same person can be counted more than once. |
| `analytics.income.basis_note` | Income = invoices issued (incl. VAT/other tax) minus credit notes. Cash collected is shown separately. |
| `analytics.income.reconcile_note` | Matches the sales register and credit-note register for the same dates. |
| `analytics.department.multiple` | Multiple departments |
| `analytics.collections.basis_note` | Cash basis — includes payments of earlier invoices; differs from income. |
| `analytics.referrer.self` | SELF (no referrer) |
| `analytics.referrers.billed_note` | Net billed counts credit-party work on the day it was charged. |
| `analytics.referral.title` | Referral business report |
| `analytics.referral.subtitle` | Orders and billing by referring doctor. For internal review only. |
| `analytics.referral.logged` | Viewing this report is recorded. |
| `analytics.pending.age_anchor` | Age since receipt at the lab, or since registration if not yet received. |
| `analytics.scope.tenant_wide_only` | Some figures are only available to users with access to all centres. |
| `analytics.tz.fixed_nepal` | Business days are counted in Nepal time (UTC+05:45). |
| `analytics.report.empty` | No data for this period and filter |
| `analytics.export.not_statutory` | Internal MIS — not a statutory register |
| `analytics.schedule.link_only_note` | Recipients get an email with a link only. They must sign in to see the figures. |
| `analytics.fresh.updated` | Updated {time} |
| `analytics.fresh.stale` | Data may be out of date |
| `analytics.fresh.refresh_lagging` | Recent changes are still being processed |
| `analytics.fresh.refresh_failed` | Last update failed — the team has been alerted |
| `analytics.fresh.never_refreshed` | Not yet calculated |
| `analytics.tat.<segment>.start` / `.stop` | per §4.8 |
| `analytics.payment_method.<code>` | Cash, Card, eSewa, Khalti, Fonepay QR, Bank transfer (seed codes from C4 05-SCHEMA §7) |
| `analytics.nav.collections` | Collections history |
| `analytics.common.inactive_suffix` | (inactive) |
| `analytics.common.not_available` | — |
| `analytics.common.total` | Total |
| `analytics.common.export` | Export |
| `analytics.common.cancel` | Cancel |
| `analytics.common.open` | Open |
| `analytics.common.verify_now` | Verify now |
| `analytics.fresh.updated_local` | Updated {time} (Nepal time) |
| `analytics.refresh.available_at` | Refresh available at {time} |
| `analytics.export.pdf_unavailable` | PDF export is not available yet |
| `analytics.dashboard.delta_caption.yesterday` | vs yesterday |
| `analytics.dashboard.delta_caption.previous_days` | vs previous {n} days |
| `analytics.dashboard.show_yesterday` | Show yesterday |
| `analytics.dashboard.tile.patient_visits` | Patient visits |
| `analytics.dashboard.tile.new_patients` | New patients {count} |
| `analytics.dashboard.tile.income` | Income (net sales) |
| `analytics.dashboard.tile.income_sub` | Invoiced {invoiced} · Credit notes {credit_notes} |
| `analytics.dashboard.tile.results_approved` | Results approved |
| `analytics.dashboard.tile.tests_ordered_sub` | Tests ordered {count} |
| `analytics.dashboard.tile.reports_pending` | Reports pending |
| `analytics.dashboard.tile.ready_unreleased_sub` | Ready, not released {count} |
| `analytics.dashboard.tile.pending_tests` | Pending tests |
| `analytics.dashboard.tile.overdue_sub` | Overdue {count} |
| `analytics.dashboard.tile.cash_collected` | Cash collected (net) |
| `analytics.dashboard.card.top_referrers` | Top referrers |
| `analytics.dashboard.card.top_centres` | Top centres |
| `analytics.chart.max_groups_note` | Chart shows up to 31 groups |
| `analytics.department.mismatch_banner` | Department totals do not match income for this period. The team has been alerted. |
| `analytics.collections.no_centre` | No centre (credit parties) |
| `analytics.collections.daily_cash_link` | Today's cash report and session close |
| `analytics.collections.staff_gateway` | Online gateway |
| `analytics.referrers.combine_merged` | Combine merged doctors |
| `analytics.tests_done.analyte_level` | Results (analyte level) |
| `analytics.tests_done.tests_completed` | Tests completed |
| `analytics.tat.note.server_times` | Server times are used, not analyser clocks. |
| `analytics.tat.note.filters_samples_only` | Priority and specimen-type filters apply to sample segments only. |
| `analytics.tat.pre_analytical.start` / `.stop` | Sample collected / Received at lab |
| `analytics.tat.transport.start` / `.stop` | Scanned out at centre / Scanned in at lab |
| `analytics.tat.within_lab.start` / `.stop` | Received at lab / First result verified |
| `analytics.tat.total_first_release.start` / `.stop` | Registered / First report released |
| `analytics.tat.total_final_release.start` / `.stop` | Registered / Final report released |
| `analytics.pending.overdue` | Overdue |
| `analytics.pending.overdue_only` | Overdue only |
| `analytics.pending.urgent` | Urgent |
| `analytics.item_status.<code>` | awaiting_collection "Awaiting collection", awaiting_receipt "Awaiting receipt", in_process "In process", resulted "Resulted", verified "Verified" |
| `analytics.quality.median_per_day_note` | Median is shown per day only. |
| `analytics.delivery.cohort_note` | Counted on the day each message was created; later status changes update that day. |
| `analytics.referral.mfa_banner` | Verify with your authenticator app to open this report. |
| `analytics.referral.disabled` | This report is not enabled for your lab. |
| `analytics.export.dialog_title` | Export report |
| `analytics.export.acknowledge` | I will keep this file inside the lab and delete it when no longer needed. |
| `analytics.export.queued` | Export queued |
| `analytics.export.queued_description` | You can download it from My exports. |
| `analytics.export.limit_reached` | Export limit reached. Try again at {time}. |
| `analytics.export.range_too_large` | Choose 366 days or fewer. |
| `analytics.export.downloads_count` | {used} of {allowed} |
| `analytics.export.failed.too_large` | Too much data — choose a shorter period or fewer centres. |
| `analytics.export.failed.forbidden` | You no longer have access to this data. |
| `analytics.export.failed.feature_disabled` | This report is disabled for your lab. |
| `analytics.export.failed.other` | Export failed. Reference: {request_id} |
| `analytics.schedule.frequency.daily` | Daily at {time} |
| `analytics.schedule.frequency.weekly` | Weekly on {weekday} at {time} |
| `analytics.schedule.frequency.monthly_ad` | Monthly (A.D.) on day 1 at {time} |
| `analytics.schedule.frequency.monthly_bs` | Monthly (B.S.) on day 1 at {time} |
| `analytics.schedule.period.<period_rule>` | previous_business_day "Previous day", previous_7_days "Previous 7 days", month_to_date_ad "A.D. month to date", previous_ad_month "Previous A.D. month", month_to_date_bs "B.S. month to date", previous_bs_month "Previous B.S. month", fiscal_year_to_date "Fiscal year to date" |
| `analytics.schedule.name_invalid` | Names cannot contain email addresses, phone numbers or web addresses |
| `analytics.schedule.recipient_ineligible` | {name} cannot receive this report |
| `analytics.schedule.deactivate_confirm` | Stop sending this report? |
| `analytics.run.title` | {schedule_name} — {period} |
| `analytics.run.as_of_banner` | Figures as of now for this period. Your access limits apply. |
| `analytics.run.not_found` | This report link is not for your account or has expired. |
