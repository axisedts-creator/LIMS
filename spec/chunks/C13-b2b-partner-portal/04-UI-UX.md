# C13 — B2B Partner Portal — 04 UI/UX

Status: DECISION draft, 2026-11-06. Components are **only** from `@lims/ui` (C0 04-UI-UX §2; 02-CV §14). Copy is English v1 with message keys `partners.<screen>.<key>` (02-CV §13). Field limits mirror `02-TRD.md` §5.1. Accessibility target WCAG 2.2 AA; partner pages usable at 320 CSS px (C0 04-UI-UX §5.7, §6).

---

## 1. Shells

### 1.1 Partner shell (`apps/partner/src/core/shell`, phone-first)

```
Phone (< md)                                 Desktop (≥ lg)
┌──────────────────────────────┐             ┌───────────┬──────────────────────────────────────┐
│ TopBar: Lab name · Partner ▾ │             │ SideNav   │ TopBar: Lab display name · Partner   │
│ [?]                          │             │ Home      │ name · [?] [Help] [User ▾]           │
├──────────────────────────────┤             │ Manifests │ Banner slot                          │
│ Banner slot                  │             │ Samples   │ PageHeader (breadcrumbs, title,      │
│ PageHeader                   │             │ Reports   │ actions, helpKey)                    │
│ Main (single column; tables  │             │ Pickups   │ Main                                 │
│ render as stacked cards)     │             │ Prices    │                         HelpPanel ▸ │
├──────────────────────────────┤             │ Statements│                                      │
│ Bottom nav (Tabs): Home ·    │             │ Doctors   │                                      │
│ Manifests · Samples · Reports│             │ Users*    │                                      │
│ · More                       │             └───────────┴──────────────────────────────────────┘
└──────────────────────────────┘             * partner_admin only
```

Built from `PageShell`, `PageHeader` (with required `helpKey`), `Tabs` (bottom navigation on phones; "More" opens a `Drawer` with the remaining entries), `Banner`, `Menu` (user menu: "Account", "Sign out"). Entries are filtered by `PartnerContext.permissions`. Touch targets ≥ 44 × 44 px (C0 04-UI-UX §1.5). The tenant accent override applies (C0 §1.6). TopBar shows the **lab's** display name and the partner name so users know which lab they are working with.

Global banners: suspended partner → full-page `ErrorState` (03-APP-FLOW §6); idle warning → `Dialog` "You'll be signed out in 2 minutes because of inactivity." [Stay signed in] [Sign out] (key `partners.shell.session_expiring`, same behaviour as C0 `SessionTimeoutDialog`); offline → `Banner tone=warning` "You're offline. Reconnect to see the latest status."

Keyboard (desktop): `?` shortcuts dialog (`KeyboardShortcutsDialog`), `Alt+N` / `Alt+M` focus nav/main, `Alt+H` help, page shortcuts listed per screen. No `g`-chords on the partner app (DECISION: phone-first; chords are a staff-web feature).

### 1.2 Staff screens (`apps/web/src/app/(staff)/partners/**`)

Use the C0 web shell. Nav manifest `apps/web/src/features/partners/nav.manifest.ts`, group `partners` (C0 04-UI-UX §3):

| id | label key | routeId (CR-C13-008) | permission | order | chord |
|---|---|---|---|---|---|
| `partners.inbox` | `partners.nav.inbox` "Partner manifests" | `staff.partners.inbox` | `partners.manifest.receive` | 10 | `g b` |
| `partners.pickups` | `partners.nav.pickups` "Partner pickups" | `staff.partners.pickups` | `partners.pickup.manage` | 20 | — |
| `partners.list` | `partners.nav.list` "Partners" | `staff.partners.list` | `partners.partner.read` | 30 | — |
| `partners.referrers` | `partners.nav.referrers` "Partner doctors" | `staff.partners.referrers` | `partners.referrer.map` | 40 | — |
| `partners.settings` | `partners.nav.settings` "Partner portal settings" | `staff.partners.settings` | `partners.partner.manage` | 50 | — |

`g b` [CONV] must be unique across manifests (build check).

## 2. Partner auth pages (PA, `apps/partner/src/app/(auth)/auth/*`)

No shell; centred `Card` (max width 420 px), lab display name + "Partner portal" heading. Behaviour mirrors C2's staff auth pages; operations per CR-C13-003.

| Screen | Fields | Validation | Copy |
|---|---|---|---|
| PA-1 `/auth/login` | Email (`TextField`, inputMode email, autoComplete `username`, max 254, required); Password (`TextField` type password, autoComplete `current-password`, max 128, required) | client: required; server errors in `Banner danger` above the form, never field-specific (no account oracle) | Title "Sign in"; link "Forgot password?"; `auth.login_failed` → "Email or password is incorrect." |
| PA-2 `/auth/mfa` | Code (`TextField` inputMode numeric, autoComplete `one-time-code`, pattern `^[0-9]{6}$`, max 6) | 6 digits | "Enter the 6-digit code from your authenticator app." |
| PA-3 `/auth/mfa/enrol` | QR (C2 returns `qr_svg_base64`, rendered as `<img>` data URI — never fetched from a URL); secret text (`IdTextProps`-style mono, copyable); Code | 6 digits | "Your organisation requires a second sign-in step. Scan this code with an authenticator app, then enter the 6-digit code." |
| PA-4 `/auth/forgot` | Email | required | Always: "If an account exists for this email, we've sent a reset link." |
| PA-5 `/auth/confirm` | (token from URL hash/query handled server-side, then removed from the URL with a redirect) | — | invalid → "This link is no longer valid. Ask your administrator to send a new invitation." |
| PA-6 `/auth/set-password` | New password, Confirm password (max 128) | ≥ 12 chars (04 A3) shown as hint; server `auth.password_policy_violation` / `auth.password_breached` mapped to the field | "Use at least 12 characters." |

## 3. Partner screens

### PH-1 Home (dashboard) — `/`
- `PageHeader` title "Home", helpKey `partners.home`.
- `Grid` of `StatTile` (phones: 2 columns; desktop: 4): "Submitted today", "In lab", "Reported today", "New sample needed" (tone warning when > 0), "New reports", "Open pickups", "Outstanding" (`MoneyText grouping='lakh'` + "as of {time}"). Each tile `href` → filtered list.
- Below: "Recent manifests" (5 rows, `DataTable` compact) and primary `Button` "New manifest" (desktop shortcut `Alt+W` [CONV]; `Alt+M` is the global "focus main").
- Empty: `EmptyState` title "Welcome", body "Create your first manifest to send samples to {lab name}.", action "New manifest".

### PM-1 Manifests — `/manifests`
- `FilterBar`: State (multi-select: Draft, Submitted, Partly received, Received, Withdrawn, Discarded), Created (date range, `DateRangePicker maxDays=366`).
- `DataTable` columns: Manifest no. (`IdText`, row header), State (`StatusChip kind='generic'`, tones: draft neutral, submitted info, partially_received info, received success, withdrawn neutral, discarded neutral), Samples (`line_count`), Registered (`lines_converted`), Needs lab check (`lines_failed`, warning badge when > 0; hideBelow md), Submitted (`DateText withTime`), Pickup (chip "Pickup requested/scheduled/picked up"; hideBelow lg). Sort: `-created_at` (default), `-submitted_at`. Row action → PM-3 (or PM-2 for drafts).
- Empty: "No manifests yet." action "New manifest".

### PM-2 Manifest editor (draft) — `/manifests/{manifest_id}` when `state = draft`
Layout: header block + lines list + line form in a `Drawer` (desktop `width=lg`, phone full-screen).

Header fields:

| Field | Component | Required | Validation / default |
|---|---|---|---|
| Collection date | `DatePicker` (tenant calendar; value A.D.); helper "Shown to the receiving lab staff; not part of the lab order or the report" (08 A19 D-102) | no | ≤ today; default today |
| Notes for the lab | `TextArea` maxLength 500, rows 2; helper "Shown to the receiving lab staff; not part of the lab order or the report" (D-102) | no | — |

Lines list (`DataTable`, cards on phones): #, Sample ref, Patient (name, "M 43 y"), Tests (codes, truncated "+2"), Priority (`Badge` "Urgent" when urgent), Doctor, actions (Edit, Remove — `ConfirmDialog` "Remove this sample from the manifest?").

Line form (`Form`, `submitShortcut` Ctrl+Enter = "Save sample"):

| Field | Component | Required | Validation | Default |
|---|---|---|---|---|
| Your sample reference | `TextField` max 40, mono | no | `^[A-Za-z0-9_./-]{1,40}$`; unique in manifest | — |
| Patient full name | `TextField` max 120, NFC | yes | 1–120 | — |
| Sex | `RadioGroup` Male / Female / Other / Unknown | yes | — | — |
| Date of birth **or** Age | `RadioGroup` "Date of birth" / "Age in years" switching between `DatePicker` (min 1900-01-01, max today) and `IntegerField` (0–130) | one of them | exactly one | Date of birth |
| Patient mobile | `TextField` inputMode tel, max 16, prefix "+977" helper | no | E.164 `^\+[1-9][0-9]{7,14}$` (A13 P-11; UI normalises a 10-digit Nepali number by prefixing +977 — DECISION; the server validates E.164 only) | — |
| Tests | `Combobox` multi-pick (loadOptions → P2 `searchPartnerOrderables`, minChars 1, debounce 150 ms, renderOption: code — name — price `MoneyText`), selected items as removable `Badge`s | yes | 1–30, unique | — |
| Priority | `RadioGroup` Routine / Urgent | yes | — | Routine |
| Referring doctor | `Combobox` (F1 list, active only) | no (yes if lab requires mapped doctors — then only mapped doctors are offered and the hint says "Only doctors confirmed by the lab can be chosen.") | — | — |
| Collected at | `DateTimePicker` minuteStep 5; helper "Shown to the receiving lab staff; not part of the lab order or the report" (D-102) | no | ≤ now + 5 min | — |
| Clinical note | `TextArea` max 300; helper "Shown to the receiving lab staff; not part of the lab order or the report" (D-102) | no | — | — |
| Consent | statement text from settings (`consent_statement`) in a `Card`, then `Checkbox` "The patient agreed to the statement above" (required), and `Checkbox`es "May receive SMS", "May receive WhatsApp", "May receive e-mail", "May share results with the referring doctor" | first checkbox required | — | channel boxes unchecked (DECISION: opt-in, REQ-SEC-005) |

Footer actions: `Button secondary` "Add sample" (opens drawer, shortcut `Alt+A`), `Button primary` "Submit manifest" (`Alt+S`; disabled with 0 lines; opens `ConfirmDialog` "Submit {n} samples to {lab}? You can't edit them after submitting."), `Menu` → "Discard draft" (danger, `ConfirmDialog`).

Errors: server `errors[]` from submit are shown in `ErrorSummary` with links to the line ("Sample 3: Tests — test not offered to your organisation"). `409 common.version_conflict` → `Banner warning` + "Reload".

Unsaved changes: navigating away with a dirty drawer → browser `beforeunload` prompt and in-app `ConfirmDialog` "Discard unsaved changes?".

### PM-3 Manifest detail (non-draft) — `/manifests/{manifest_id}` (routes.yaml `partner.manifest`)
- `PageHeader` title "Manifest {manifest_no}", status chip, actions: "Print" (→ PM-4), "Request pickup" (when submitted and not on an open pickup → PK-2 prefilled), "Withdraw" (submitted, conversion mode `on_receipt` only, nothing registered — hidden in mode `on_submit`, 08 A19 D-104; `ConfirmDialog requireReason` coded set `manifest_withdraw_reasons`).
- `DescriptionList`: Receiving centre, Submitted, Received, Pickup state, Notes.
- Lines `DataTable`: #, Sample ref, Patient, Tests, Status (line label per 03-APP-FLOW §3), Registration no. (when registered; link to PO-2), Updated.

### PM-4 Print view — `/manifests/{manifest_id}/print`
Print stylesheet (A4 portrait, 12 mm margins, black on white, no nav). Header: lab name, "Sample manifest", manifest no. in large mono, partner name + code, receiving centre, submitted time, page "N of M" (CSS counters). Table: #, Sample ref, Patient name, Sex/Age, Tests (codes), Priority, Collected at, "Received ☐" tick column for lab staff. Footer: "Handed over by ____ Received by ____ Time ____". `Button` "Print" calls `window.print()`. Page `Cache-Control: no-store`.

### PO-1 Samples (orders) — `/orders`
- Search: `TextField` "Search by patient name, your reference or registration no." (2–64) + `Button` "Search" → O2 (POST). Clearing returns to the list.
- `FilterBar`: Status (multi: Registered, On the way to lab, In lab, New sample needed, Partly reported, Report ready, Cancelled by lab), Manifest (select from recent manifests), Doctor (select), Registered (date range), "Only with new reports" (`Switch`).
- `DataTable`: Registration no. (row header, mono), Patient, Your ref (hideBelow md), Status (`StatusChip kind='generic'` tone: registered neutral, in_transit info, in_lab info, action_needed warning, partially_reported info, reported success, cancelled danger), Tests (count), Doctor (hideBelow lg), Registered (`DateText withTime`), New report (`Badge` "New"). Sort: `-registered_at` (default), `-last_event_at`.
- Polls every 60 s while visible (background header).

### PO-2 Sample detail — `/orders/{order_id}` (routes.yaml `partner.order`)
- Header: "Registration {registration_no}", status chip; `DescriptionList` (Patient name, Sex/Age, Your ref, Manifest no. link, Doctor, Priority, Tests list).
- "Samples" section: one `Card` per specimen: type label (humanised code), `StatusChip kind='specimen'` (C0 status mapping), `Timeline` items: Collected, Sent to lab, Received at lab, Rejected (+ reason humanised, tone danger, text "A new sample is needed" when T4 applies), Replaced by new sample.
- "Reports" section: list of versions (`PartnerReport`): kind label, released time, status chip (`kind='report_version'`: released → "Released", superseded → "Superseded"), panel names, buttons "Download PDF" and (if enabled) "Print patient slip".
- Empty specimens: "The lab has not labelled this sample yet."

### PR-1 Reports — `/reports`
- `FilterBar`: Released (date range), "New only" (`Switch`), "Show older versions" (`Switch` → `include_superseded`).
- `DataTable` (selection multiple, max 200 → bulk "Mark as seen" button, R2): Patient, Registration no., Report (kind + panel names, truncated), Version ("v2 · Superseded" when superseded), Released (`DateText withTime`), actions "Download" / "Patient slip". Sort `-released_at`.
- Download: `Button isLoading` while streaming; success toast "Download started"; 429 toast "Download limit reached. Try again in {n} minutes."; 404 toast "This report is no longer available."
- Empty: "No reports released yet."

### PR-2 Patient access slip — `/reports/{report_id}/slip` (feature flag; 08 A2.1)
"Print patient slip" → R4 (`202`, state `requested`) → this page shows `Spinner` + "Preparing the slip…" and polls R5 every 1 s (accepted, 08 A5.3) (typically ready in under 5 s [CONV]; after 30 s (accepted, 08 A5.3) → "The slip is taking longer than usual. Check again in a minute." with a "Check again" button).
- No patient mobile on the manifest line (08 A19 D-105): before and after requesting, `Banner tone='warning'` "The slip opens only if the lab has a mobile number for this patient." (key `partners.slip.no_phone_warning`). The request is still allowed.
- `issued` → "Download slip (PDF)" button (R6) and "Link valid until {link_expires_at}". The browser never receives the link or token; the URL and QR appear only inside the PDF.
- `failed` → `Banner tone='danger'` "A slip cannot be made for this report." (`reporting.report_superseded` → "This report has a newer version. Make the slip from the latest version.").
- `expired` → "This slip has expired." (no download).
PDF content (rendered once by the worker through `RenderPort` template `partners.access_slip`, owner C6 — 08 A5.1; 02-TRD §8.1): lab name (`tenantDisplayName`), partner name (`partnerName`), "Your report is ready", patient display name (`patientDisplayName`), registration no. (`orderRef`), QR of the link and the URL as text (both drawn by C6 from `portalUrl`), issued at (`issuedAtLocal`), "Open the link and enter the code sent to your mobile number.", "Link valid until {expiresAtLocal}". No results and no other PHI.

### PR-3 Report versions — `/reports/{report_id}` (routes.yaml `partner.report`, review m#25)
- `PageHeader` title "Report for registration {registration_no}", helpKey `partners.report`; `DescriptionList` (Patient name, Registration no. link → PO-2).
- `DataTable` of the report's versions from R1 filtered to this `report_id` with `include_superseded = true`: Version, Kind, Panels, Released (`DateText withTime`), Status chip (`kind='report_version'`: "Released" / "Superseded"), actions "Download" (R3) and, if enabled, "Patient slip" (→ PR-2, current `valid` version only).
- States: loading `detail` skeleton; 404 → "This report is no longer available."; download errors as PR-1.
- PR-1 rows and PO-2 "Reports" link here (`buildRoute('partner.report', {report_id})`).

### PK-1 Pickups — `/pickups`; PK-2 Request pickup — `/pickups/new`
PK-1 `DataTable`: Requested (`DateText`), Window, Manifests (count), Packages, Status (`StatusChip generic`: requested info, scheduled info, picked_up success, cancelled neutral, rejected danger), Scheduled time, Assignee (hideBelow md). Row action → detail `Drawer` with "Cancel request" (`ConfirmDialog requireReason` `pickup_cancel_reasons`).

PK-2 form:

| Field | Component | Required | Validation |
|---|---|---|---|
| Manifests | `Checkbox` list of eligible manifests (submitted/partly received, not on an open pickup, same receiving centre) | ≥ 1, ≤ 20 | — |
| Pickup window from / to | two `DateTimePicker` (minuteStep 15) | yes | from < to; from ≥ now − 1 h; to ≤ now + `pickup_max_days_ahead` |
| Number of boxes/bags | `IntegerField` 1–50 | yes | default 1 |
| Contact person | `TextField` max 80 | no | — |
| Contact phone | `TextField` tel max 16 | no | E.164 `^\+[1-9][0-9]{7,14}$` (P-11) |
| Notes (e.g. address details, gate) | `TextArea` max 500 | no | — |

### PP-1 Price list — `/price-list`
- Search `TextField` (code/name, ≤ 64), `FilterBar`: Kind (Test/Package), Rate (Your rate / Standard rate).
- `DataTable`: Code (mono, row header), Name, Kind, Department (hideBelow md), Price (`MoneyText`, align end), Rate (`Badge` "Standard rate" when `source = standard`), Valid from (hideBelow lg). Sort code/name.
- Header note `Banner tone=info`: "Urgent tests may carry an extra charge. The amount on your statement is final." + "Prices updated {synced_at}" + "Price list version {n}".
- Empty: "No prices are set up for your organisation yet. Contact the lab."

### PS-1 Statements — `/statements`; PS-2 Month — `/statements/{period_month}` (routes.yaml `partner.statement`)
- `Banner tone=neutral` (always): "This statement is for information. It is not a tax invoice."
- Outstanding `StatTile` "Outstanding balance" + "as of {time}".
- `DataTable`: Month (A.D. "Kartik 2082 B.S. / Oct–Nov 2026" displayed via `DateText` per tenant calendar — month label: A.D. month name + year; B.S. fiscal year column), Fiscal year (B.S.), Billed, Paid, Credited, Closing balance (all `MoneyText`, end-aligned, tabular). Billing documents show both calendars (02-CV §13); statement rows therefore always show the A.D. month and the B.S. fiscal year.
- PS-2: same columns for the one month (1–2 rows when the month straddles Shrawan 1).

### PF-1 Referring doctors — `/referrers`
- `DataTable`: Name (row header), Qualification, Council reg. no. (hideBelow md), Lab check (`StatusChip generic`: unmapped "Waiting for lab" neutral, mapped "Confirmed" success, rejected "Please check" warning), Samples this month, Active (`Switch` for admins; text for members).
- Admin actions: "Add doctor" (`Dialog` form: Name `TextField` 1–120 required; Qualification ≤120; Council `TextField` ≤20 (helper "e.g. NMC"); Registration no. ≤30), Edit (same), Deactivate/Reactivate.
- Rejected rows show the lab's reason text and "Edit to send again".

### PU-1 Users — `/users` (partner_admin only)
- `DataTable`: Name, Email (masked), Role (`Badge` Admin/Member), Status (`StatusChip generic`: invited info "Invitation sent", active success, deactivated neutral), Two-step sign-in (Yes/No), Last sign-in.
- Actions: "Invite user" (`Dialog`: Email ≤254 required; Name 1–120 required; Role `RadioGroup` Member (default) / Admin with description "Admins can add users and doctors. Admins must use two-step sign-in."), row menu: Change role, Deactivate (`ConfirmDialog requireReason` `partner_user_deactivate_reasons`), Reactivate, Resend invitation.
- `403 auth.mfa_required` → redirect to `/auth/mfa` with return path.

### PX-1 Account — `/account`
`DescriptionList` (name, email masked, role, organisation); "Two-step sign-in" section (enrol / remove factor via C2 self-service operations of CR-C2-006 — partner sessions accepted per CR-C13-003); "Sign out" button; "Sign out of all devices" (C2 `listOwnSessions`/`revokeOwnSession`). These C2 operations require `identity.self.manage`, which 08 A19 D-101 adds to both partner roles' fixed permission sets.

## 4. Staff screens

### SP-1 Partners — `/partners`
`FilterBar` (Status, text search code/name ≤64). `DataTable`: Code (mono), Name, Credit party (code + name), Receiving centre, Active users, Open manifests, Status chip (active success / suspended warning). Primary action "New partner" (permission `partners.partner.manage`) → `Dialog`:

| Field | Component | Required | Validation |
|---|---|---|---|
| Partner code | `TextField` max 20, uppercase on blur | yes | `^[A-Z0-9_-]{1,20}$` |
| Name | `TextField` max 160 | yes | — |
| Credit party | `Combobox` (BFF → C3 credit-party list/search) | yes | active; not linked to another partner |
| Receiving branch | `Select` (C2 branches) | yes | active |
| Receiving centre | `Select` (centres of the branch) | yes | active |
| Order creation | `RadioGroup` "When the lab receives the samples" (on_receipt, default) / "As soon as the partner submits" (on_submit) | yes | — |
| Contact e-mail / phone / address | `TextField` ≤254 / tel ≤16 / `TextArea` ≤300 | no | — |

### SP-2 Partner detail — `/partners/{partner_id}`
`Tabs`: Overview (`DescriptionList` + "Suspend"/"Reactivate" with `ConfirmDialog requireReason partner_suspend_reasons`, "Resync data" `Menu` → scopes), Users (SP-3), Manifests (SI1 filtered by partner), Doctors (SR1 filtered). Projection status line: "Prices synced {time} · Statements synced {time}".

### SP-3 Partner users (tab) — same columns as PU-1 + actions "Invite user" (`partners.partner.manage`), Change role, Deactivate, Reactivate. Banner when no active admin: "This partner has no active administrator."

### SM-1 Partner manifests inbox — `/partners/manifests`
`FilterBar`: State (default Submitted + Partly received), Partner, Receiving centre (only centres in scope), Submitted (date range), "Has samples needing attention" (`Switch`). `DataTable` (density compact): Manifest no. (mono), Partner, Samples, Received, Needs attention (danger badge), Submitted, Pickup state. Second `Switch` "Order exists but sample missing" (SI1 `has_missing_samples`, mode `on_submit` lines with an order and `sample_missing` — the staff task of 03-APP-FLOW §2.1, 08 A19 D-104); such rows show the text "Cancel or recollect in Front desk". Row action → SM-2. Auto-refresh 60 s.

### SM-2 Receive manifest — `/partners/manifests/{manifest_id}`
Layout: `PageHeader` (manifest no., partner, status, actions "Confirm receipt" primary `Alt+R`), scan bar, lines table.
- Scan bar: `BarcodeInput` label "Scan or type the partner's sample reference" (`pattern /^[A-Za-z0-9_./-]{1,40}$/`, allowManual true). A match ticks the line's "Received" checkbox and scrolls it into view with a success flash; no match → inline error "No sample with this reference on this manifest."; already ticked → hint "Already ticked". Note: partner references are not lab barcodes; the default kit pattern is overridden (C0 §2.4 allows `pattern`).
- Header `DescriptionList` adds the partner's manifest Notes and Collection date (08 A19 D-102: shown to receiving staff; not part of the order).
- Lines `DataTable` (selection multiple): #, Ref (mono), Patient name, Sex/Age, Tests, Priority (`Badge` Urgent), Doctor (+ "Not confirmed" warning badge if unmapped), Collected at, Clinical note (truncated; full text in a row `Drawer`) (D-102), Status, per-line outcome control (`RadioGroup` horizontal: Received / Not received; Not received opens a `CodedSelect` `line_not_received_reasons`).
- Bulk: "Mark selected as received" (`Alt+A`).
- "Confirm receipt" → `ConfirmDialog` "Confirm {r} received and {n} not received? Orders will be created for the received samples." → SI3.
- After receipt: status column shows Registering → Registered (registration no. link to C4 route `staff.frontdesk.order` via `buildRoute`) or "Needs attention" with the failure code's staff text (table below) and actions "Retry" / "Choose existing patient" / "Mark not received".
- "Choose existing patient" → `Dialog` with C4 patient search (BFF → `POST /v1/frontdesk/patients/search`, staff permission `frontdesk.patient.read`), results list, pick → SI4 with `patient_id`.

Staff failure texts (`partners.inbox.failure.<code>`):

| failure_code | Text | Suggested action |
|---|---|---|
| `frontdesk.patient_duplicate_suspected` | "A patient with similar details already exists." | Choose existing patient |
| `frontdesk.consent_required` | "Consent details are missing for this patient." | Contact partner; register at front desk |
| `catalog.test_inactive` | "A test on this sample is no longer offered." | Mark not received (reason `test_not_available`) or register at front desk |
| `catalog.no_price` | "A test has no price for this partner." | Fix price list in Catalog, then Retry |
| `partners.referrer_not_mapped` | "The referring doctor has not been confirmed." | Confirm the doctor (Partner doctors), retry is automatic |
| `common.internal` / other | "Registration did not complete." | Retry |

Warning banner when the partner is suspended: "This partner is suspended. You can still receive samples already submitted."

### SK-1 Partner pickups — `/partners/pickups`
`DataTable`: Window, Partner, Address/contact (hideBelow lg), Manifests, Packages, Status, Scheduled, Assignee. Row actions: "Schedule" (`Dialog`: from/to `DateTimePicker` required, Assignee `TextField` ≤80 required), "Mark picked up" (`ConfirmDialog`, optional time ≤ now), "Reject" (`ConfirmDialog requireReason pickup_reject_reasons`).

### SF-1 Partner doctors (mapping) — `/partners/referrers`
`FilterBar`: Lab check state (default Waiting), Partner. `DataTable`: Partner, Name, Qualification, Council/reg. no., Samples this month, State. Row action "Confirm" → `Dialog` with C3 doctor search (`Combobox` → BFF → `POST /v1/catalog/doctors/search`), pick → SR2. No "create doctor" link: 03 §7 has no C3 doctor route (review m#26); the dialog text says "If the doctor is not listed, ask the catalogue team to add them, then confirm." "Reject" with reason (`referrer_mapping_reject_reasons`) and optional text. Mapped rows: "Unlink".

### SS-1 Partner portal settings — `/partners/settings`
`Form` with fields from 02-TRD §10.2: Default order creation (`RadioGroup`), Show standard-rate tests (`Switch`), Require confirmed doctors (`Switch`), Patient access slips (`Switch` + description "Partners can print a slip with a link the patient opens with a code sent to their mobile."; may be switched on once the 08 A2.1 worker flow is implemented), Max samples per manifest (`IntegerField` 1–200), Draft expiry days (1–90), Pickup days ahead (1–30), Daily report downloads per user (50–5000), Consent text version (`TextField` 1–32), Consent statement (`TextArea` max 2000, showCount). `If-Match`.

## 5. Coded sets used in forms (seed codes, 05-SCHEMA §7)

`manifest_withdraw_reasons`, `line_not_received_reasons`, `pickup_cancel_reasons`, `pickup_reject_reasons`, `partner_suspend_reasons`, `partner_user_deactivate_reasons`, `referrer_mapping_reject_reasons` — rendered with `CodedSelect`; `other` requires the free-text field (`requires_text`).

## 6. Copy rules

- Never "commission" (04 L19). Doctor volumes are "Samples this month".
- Never "invoice" on partner screens; "statement", "billed", "paid".
- Status labels exactly as 03-APP-FLOW §3 and C0 status mapping.
- Times: tenant `calendarDisplay` via `DateText`; statements show A.D. month + B.S. fiscal year (02-CV §13).
- Money: `MoneyText grouping='lakh'` (Nepali grouping, C0 component option).
- Error toasts include the request reference via `ErrorState requestId` where a page fails.

## 7. Accessibility and responsive specifics

- Every table has a `caption`; on phones `DataTable hideBelow` + card renderer; cards keep the row-header field first.
- Status is never colour-only (chips carry text).
- Line form in a full-screen `Drawer` on phones; focus moves to the first field; `Esc` closes with the unsaved-changes guard.
- Download buttons have accessible names including the patient-independent identifier ("Download report version 2 for registration 0001SY000123" uses the registration no., which is the partner's own data).
- Print views use real tables with `<th scope>`.
- axe scans at 320 px and 1280 px for every page (06-PLAN T22).

## 8. UI-kit CR candidates

| Need | Status |
|---|---|
| `QrCode` (access slip) | **CR-C13-013 withdrawn by C13** (review m#20): the QR is drawn by C6's render pipeline inside the `partners.access_slip` PDF (08 A5.1); C13 uses no browser-side `QrCode`. C0 is asked to drop the 08 §4.6 row unless another chunk needs it |
| Bottom navigation for phones | composed from `Tabs` (no CR); if C0 prefers a dedicated `BottomNav`, C0 may add it later |
| Print layout primitives (page counters, print-only header) | plain CSS in `apps/partner` print stylesheet using kit tokens (no component needed) |
| Multi-select chips inside `Combobox` | composed from `Combobox` + `Badge`; CR to C0-0D only if the kit's `Combobox` cannot keep focus after selection (verify in T08) |
