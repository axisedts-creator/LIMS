# C16 — Patient Engagement — 04 UI/UX

Status: DECISION draft, 2026-11-06. Screens are listed in `03-APP-FLOW.md` §1. Components come only from `lims_ui` (Flutter) and `@lims/ui` (web) per 02-CV §14 and C0 `04-UI-UX.md` (C0-UI). Components the kits lack are CR candidates (CR-C16-016, §9). Copy is English v1 (02-CV §13); every string is a message key — Flutter ARB keys `patient_app.<screen>.<key>`, web keys `engagement.<screen>.<key>`; the strings below are the `en` values.

## 1. Global rules

### 1.1 Patient app

| Topic | Rule |
|---|---|
| Layout | `LimsScaffold` with app bar + `LimsBottomNav` (CR) tabs: Orders · Reports · Bookings · More. Bookings tab hidden when `features.bookings` is false. Phones 360–430 dp; text scale up to 200 % without clipping (C0-UI §6) |
| Profile switcher | `LimsProfileSwitcher` (CR) in the app bar of Orders/Reports/Bookings: "All profiles" + each profile's display name and relationship; selection is in-memory only |
| Dates | `DateText`-equivalent in `lims_shared/bsdate`: mode = tenant `calendarDisplay` (from E1 config — field added there as `calendar_display`); A.D. `DD/MM/YYYY hh:mm A`, B.S. `YYYY-MM-DD B.S.` (02-CV §13); time zone = tenant timezone |
| Money | `LimsMoneyField`/money text from `lims_shared/money`; lakh grouping (C0-UI §2.5 `grouping: 'lakh'`) [CONV]; "Rs." prefix [CONV] |
| PHI screens | wrapped in `LimsSecureScreen` (screenshot/recents protection, REQ-SEC-109): A6–A15, A18, A21, A22 |
| Text fields | phone/OTP/code fields `enableSuggestions:false`, `autocorrect:false`, `autofillHints` only `telephoneNumber` / `oneTimeCode` (REQ-SEC-111) |
| Errors | inline field errors from problem+json `errors[]` (JSON Pointer → field); non-field errors as `LimsSnackbar` (tone danger persists) or full `LimsErrorState` with "Reference: xxxxxxxx" (first 8 of `request_id`) |
| Offline | `LimsOfflineBanner` "You're offline. Connect to see the latest updates." No offline actions |
| Loading | `LimsLoading` skeletons; buttons show spinner and are disabled while a request runs |
| Accessibility | `Semantics` label on every interactive element; 48 dp targets; status never by colour alone (stage chips carry text); OTP field announces "Digit 3 of 6" |
| Language | English v1; ARB structure ready for Nepali (02-CV §13) |

### 1.2 Staff web

| Topic | Rule |
|---|---|
| Shell | C0 web shell; `PageHeader` with `helpKey` on every page (help files in `features/engagement/help/`) |
| Centre | the shell's working-centre selector is the default `centre_id` filter (not an authorisation input — C0-UI §7) |
| Tables | `DataTable` with cursor paging, `FilterBar`, sticky header, compact density |
| Forms | `Form` with `ErrorSummary`, `Ctrl+Enter` submit, `If-Match` from the loaded `version`; `409 common.version_conflict` → `Banner` "Someone else changed this. Reload to see the latest." [Reload] |
| Reason-coded actions | `ConfirmDialog` with `requireReason` (codes from T3a `listEngagementCodedSet`) |
| Keyboard | global keys per C0-UI §4; page keys below, registered with `shortcuts.register` |
| Accessibility | WCAG 2.2 AA (C0-UI §5) |

### 1.3 Navigation manifest (`features/engagement/nav.manifest.ts`, group `engagement`)

| id | label key | routeId | permission | order | chord | phase |
|---|---|---|---|---|---|---|
| `engagement.queue` | `engagement.nav.queue` "Queue" | `staff.engagement.queue` | `engagement.queue.operate` | 10 | `g q` | 2 |
| `engagement.bookings` | `engagement.nav.bookings` "Bookings" | `staff.engagement.bookings` | `engagement.booking.read` | 20 | `g k` | 3 |
| `engagement.reminders` | `engagement.nav.reminders` "Reminders" | `staff.engagement.reminders` | `engagement.reminder.read` | 30 | `g m` | 2 |
| `engagement.enquiries` | `engagement.nav.enquiries` "Enquiries" | `staff.engagement.enquiries` | `engagement.enquiry.read` | 40 | `g e` | 3 |
| `engagement.memberships` | `engagement.nav.memberships` "Memberships" | `staff.engagement.memberships` | `engagement.membership.read` | 50 | — | 3 |
| `engagement.slots` | `engagement.nav.slots` "Booking slots" | `staff.engagement.slots` | `engagement.slot.manage` | 60 | — | 3 |
| `engagement.bookable` | `engagement.nav.bookable` "Bookable tests" | `staff.engagement.bookable` | `engagement.bookable_item.manage` | 70 | — | 3 |
| `engagement.queue_setup` | `engagement.nav.queue_setup` "Queue setup" | `staff.engagement.queue_setup` | `engagement.queue.manage` | 80 | — | 2 |
| `engagement.settings` | `engagement.nav.settings` "Engagement settings" | `staff.engagement.settings` | `engagement.settings.manage` | 90 | — | 2 |

Chords `g q`, `g k`, `g m`, `g e` must be unique across manifests (C0 build check); if taken, the build fails and C16 picks another before merge. Patient app access (W8) has a path parameter → no nav entry; C4's patient page links to it with `buildRoute('staff.engagement.app_access', { patient_id })` (C4 decides whether to show the link — CR candidate to C4, non-blocking).

## 2. Patient app screens

### A0 Splash / A1 Update required
- A0: tenant logo (flavour asset), spinner; calls E1; if E1 fails 3× → `LimsErrorState` "We can't reach {lab} right now." [Try again].
- A1: title "Update required", body "This version of the app is no longer supported. Please update to continue.", primary [Open store] (store URL from flavour config). No other navigation.

### A2 Phone entry

| Field | Widget | Type / validation | Required | Default | Max |
|---|---|---|---|---|---|
| Mobile number | `LimsPhoneField` (CR) | country prefix chip from `allowed_phone_prefixes` (first = default), national digits `[0-9]`; final value E.164 `^\+[1-9][0-9]{7,14}$` | yes | — | 15 digits total |

Primary [Send code]. Under the button: "By continuing you agree to {lab_display_name}'s app terms." (`lab_display_name` = the flavour display name, 02-TRD §2.3; E1 does not return it) link opens the consent text (E1 `consent.text`) in a `LimsDialog`. Errors: prefix not allowed → "This app accepts numbers starting with {prefixes} only."; `429` → "Too many codes requested. Try again in {minutes} minutes."; `403 feature_disabled` → "The app isn't available for {lab} yet."

### A3 OTP entry

| Field | Widget | Validation | Max |
|---|---|---|---|
| Code | `LimsOtpField` (CR), 6 boxes, numeric keypad, paste support | `^[0-9]{6}$` | 6 |

Text: "Enter the 6-digit code sent to {phone_masked}." [Resend code] disabled with countdown "Resend in 0:{ss}". [Change number] → A2. Errors: `auth.otp_invalid` → "That code is wrong or has expired."; `auth.otp_attempts_exhausted` → back to A2 with "Too many attempts. Request a new code."

### A4 App lock
Full-screen blur over the target screen; `LimsAppLockGate` (CR) prompt reason "Confirm it's you to view your health records". [Try again]. After 3 failures: "Locked. Open the app again later." and PHI tabs stay blurred.

### A5 Home
Tabs as §1.1. Orders tab is default. App bar: profile switcher, bell with unread count (E45 `unread_only=true`, count of first page capped "9+").

### A6 Profiles
List `LimsListTile` per profile: display name, relationship label ("Me", "Child", "Parent", "Spouse", "Sibling", "Other"), method subtitle ("Linked with lab code" / "Linked from a report message — earlier reports are not shown" / "Registered in the app"), [⋯] menu: Change relationship (E18), Remove (E19 with `LimsConfirmDialog` "Remove {name}? You'll stop seeing their orders and reports in this app."). Pending registrations show spinner "Creating record…". Banner when `paused_count > 0`: "Access to {n} profile(s) is paused. Ask the lab for a new code." Primary actions: [I have a code from the lab] → A7 · [Add from a report message] → A8 · [Register myself / my child] → A9 (hidden when `consent.text_version` is absent).

### A7 Redeem lab code

| Field | Widget | Validation | Max |
|---|---|---|---|
| Code | `LimsCodeField` (CR) grouped `XXXXX-XXXXX`, uppercase, strips spaces/dashes | 10 symbols after normalisation, Crockford alphabet (letters I, L, O, U are accepted and normalised per TRD §4.3) | 13 incl. dash/spaces |

Help text: "Ask the front desk for an app code. It works once, on this phone number only." Errors as 03-APP-FLOW §10.1.

### A8 Add from report message

| Field | Widget | Validation | Max |
|---|---|---|---|
| Link | `LimsTextField` multiline paste | must start with the portal origin + `/r/` (client check; server re-checks) | 2000 |

Text: "Paste the report link from the SMS or WhatsApp message the lab sent to this phone. You'll see reports from that one onwards. For older reports, ask the lab for an app code."

### A9 Register myself / my child

| Field | Widget | Validation | Required | Default | Max |
|---|---|---|---|---|---|
| Who is this for? | `LimsSegmentedControl` (CR): Myself / My child | — | yes | Myself (disabled if a `self` profile exists) | — |
| Full name | `LimsTextField` (NFC) | 1–200 chars | yes | — | 200 |
| Sex | radio: Male / Female / Other / Prefer not to say (`unknown`) | enum | yes | — | — |
| Date of birth | `LimsDatePicker` (A.D./B.S.), `max = today` | child: age < `minor_age_years` | one of DOB/age | — | — |
| Age in years (if DOB unknown) | integer field | 0–150; child < `minor_age_years` | one of DOB/age | — | 3 |
| SMS updates | switch | — | — | on | — |
| WhatsApp updates | switch | — | — | on | — |
| Consent | checkbox "I have read and agree to {lab}'s terms" + [Read] | must be checked | yes | off | — |

Submit [Create record]. Info box: "This creates a new record at {lab}. If you've visited before, ask for an app code instead to see your earlier reports."

### A10 Orders list
Rows (`LimsListTile`): profile name (when "All profiles"), registered date, stage chip (`LimsStatusChip` generic tone: registered=neutral, sample_collected=info, in_lab=info, partial_report=warning, report_ready=success, recollection_needed=danger, cancelled=neutral), "Payment due" badge, reports count. Pull to refresh. Infinite scroll by cursor (page 50).

### A11 Order detail
- Header: registered date/time, centre name, booking no. if from a booking.
- `LimsStageTimeline` (CR): Registered → Sample collected → In the lab → Report ready, current step highlighted; recollection shows a red step "New sample needed — the lab will contact you or you can book a visit" with [Book a visit] (A17 prefilled with same profile).
- Samples: "Sample 1 — In the lab, received 06/11/2026 09:12 AM" (no specimen type names, no rejection reasons).
- Reports section: list as A12 rows.
- "Payment due Rs. 2,250.00 — your report will be released after payment" + [Pay now] (when `payment_due` and `features.payments`).
- Polls E21 every `order_poll_seconds` (config, default 30) while visible; last-updated line "Updated hh:mm".

### A12 Reports list
Rows: panel names (comma-joined, max 2 lines), profile, released date/time, kind label ("Final", "Partial", "Preliminary", "Amended", "Addendum"; any other value "Report"), "Smart summary" chip when available. Toggle "Show older versions" (sets `include_superseded`); superseded rows labelled "Replaced by a newer version".

### A13 Report viewer
`LimsPdfViewer` (CR) full screen; app bar: [Share/Save] → `LimsConfirmDialog` "This saves the report outside the app. Anyone with access to your phone's files may see it." [Save] [Cancel]. Temp file deleted on close (and on logout / app start cleanup).

### A14 Smart summary
Source: the approved snapshot C6 stores on the report version, read via `ReportingPort` and served by E24 from `engagement.smart_summaries` (08 A2.3; never `SmartReportPort`). Sections in order: Health score (`LimsCard`: value/100 + band label "Good" / "Fair" / "Needs attention"); Panels grid (tile: display name or code, status text "In range" / "Borderline" / "Out of range" / "Critical — contact your doctor"); "Results that need attention" (each `text`); "Advice" (each text); "Suggested follow-up" ("In {interval_days} days: {text}"; no reminder button in v1 — reminders are created by staff or the system, TRD §4.11); Trends ("Improved" / "Worse" / "Stable" chips only); Disclaimer (from `disclaimer_text`, else tenant default "This summary is for information only and does not replace advice from your doctor."). No numbers are recomputed in the app.

### A15 Pay due
Amount (read-only, from order projection) + gateway choice (`LimsSegmentedControl` from E1 `gateways`: "eSewa", "Khalti") + [Continue]. Waiting view states per 03-APP-FLOW §10.1. Result view: "Paid — thank you" (success) / "Payment not completed" (failed/expired) [Try again] / "We are confirming your payment. This can take a few minutes." (review/timeout) [Check again].

### A16 Bookings list / A18 Booking detail
List rows: date/time, centre or "Home collection", booking no., status chip ("Confirmed", "Checked in", "Completed", "Cancelled"). Detail: items with indicative prices, address (home), [Cancel] (hidden after cutoff; text "You can cancel in the app until {cancellable_until}"), [Reschedule] (same wizard from the slot step; shown only when cancellable).

### A17 Booking wizard

| Step | Fields | Validation |
|---|---|---|
| 1 Who | profile (radio list of active profiles) | required |
| 2 Type | Visit a centre / Home collection (`features.home_collection`) | required |
| 3 Tests | search `LimsTextField` (≤40, debounced 300 ms) + list of `BookableItem` with checkboxes and indicative price; items restricted to the other sex are hidden, and when the profile's sex is unknown to C16 restricted items show "Suitability is confirmed at the lab" | 1–`max_orderables_per_booking` (default 20) items |
| 4 Place | centre list (E31, with address text) **or** address list (E37) + [Add address] (A19 form inline) | required |
| 5 Date & time | `LimsSlotPicker` (CR): 7-day strip (A.D. + B.S. per setting) + slot grid with remaining "3 left" (capped "9+"); past/lead-time slots not shown | required |
| 6 Review | summary; indicative total; "Final price is confirmed at the lab." | [Confirm booking] |

Back navigation keeps entries in memory. Leaving the wizard discards it.

### A19 Address form

| Field | Validation | Required | Max |
|---|---|---|---|
| Label (Home / Work / Other) | enum | yes | — |
| Address | free text, NFC | yes | 300 |
| Landmark | — | no | 120 |
| Municipality | — | no | 80 |
| Ward no. | integer 1–99 [CONV; real ward ranges UNVERIFIED] | no | 2 |
| District | — | no | 60 |
| Pin on map | **not in v1** (map tiles would be a foreign service — 04 §11); latitude/longitude fields stay empty from the app | — | — |
| Contact phone (if different) | E.164 | no | 15 |

### A20 Notifications
Rows rendered from kind keys: `report_ready` "A new report is ready for {profile}"; `sample_recollection` "The lab needs a new sample for {profile}"; `booking_confirmed` "Booking {booking_no} confirmed"; `booking_cancelled` "Booking {booking_no} cancelled"; `booking_reminder` "Reminder: booking {booking_no} soon"; `payment_completed` "Payment received"; `follow_up_reminder` "Time for a follow-up test for {profile}"; `enquiry_reply` "The lab replied to your message"; `profile_paused` "Access to a profile is paused". `booking_no` comes from the app's own booking data (fetched on tap), never from the notification row. [Mark all read] (E46 with the visible ids).

### A21 Membership card
`LimsCard` (CR): plan name, card no. (monospace), "Valid {from} – {to}", status; `LimsQrCode` (CR) of `card_token` (error correction M [CONV]); screen brightness raised while visible; "Show this at the front desk."

### A22 Enquiries

| Field | Validation | Required | Max |
|---|---|---|---|
| Topic | coded (T3b `listMyCodedSet` `enquiry_categories`: Booking, Report, Payment, Home collection, Other) | yes | — |
| About (profile) | optional profile | no | — |
| Subject | text | yes | 120 |
| Message | multiline, counter | yes | 2000 |

Thread view: bubbles (patient right, lab left), timestamps; reply box disabled when closed ("This conversation is closed.").

### A23 Settings
Switch "Reminder messages by SMS" (inverse of `reminders_opt_out`); "App lock" status (device lock required — informational); [Sign out]; [Delete my app account] → `LimsConfirmDialog` (danger) "This deletes your app account and removes all profiles from this app. Your records at {lab} are not deleted." with a typed confirmation "DELETE" [CONV].

## 3. Staff screens

### W1 Bookings
- Filters (`FilterBar`): date range (`date_range`, default today, ≤ 31 days), centre (`select`, default working centre), type (`select`: Centre visit / Home collection), status (`select multiple`, default Confirmed + Checked in).
- Columns: Time (`slot_start`, sortable) · Booking no. (`IdTextProps`-style mono, not copyable) · Patient (name fetched from C4 via `GET /v1/frontdesk/patients/{patient_id}` server-side for rows on the page; requires `frontdesk.patient.read`, else "—") · Type · Tests (count) · Source (App / Staff) · Status (`StatusChip` generic) · Order (link to `staff.frontdesk.order` when `order_id`).
- Row actions: Open, Check in, Cancel. Page keys: `Alt+B` new booking, `Alt+C` check in selected, `Alt+X` cancel selected.
- Empty: "No bookings for this day."

### W2 Booking detail
`DescriptionList`: booking no., patient (link to C4 patient), type, centre/address, slot, items with indicative price, status, created via, order link, queue token. `Timeline` of transitions. Actions: [Check in] (dialog: Switch "Issue queue token" default on; queue `Select`; priority `RadioGroup` Normal/Priority), [Cancel] (`ConfirmDialog` reasons from `booking_cancel_reasons`).

### W3 New booking
`Form`: Patient (`Combobox` → C4 patient search through BFF, min 3 chars, `renderOption` name + patient code + age/sex); Type (`RadioGroup`); Centre (`Select`, centre visit) or Address fields (as A19, staff-entered); Date (`DatePicker`) + slot `Select` (from S6: "07:15 — 2 of 3 left"; overbooked slots disabled); Tests (`Combobox` multi from S12 list, max 20). `Ctrl+Enter` submits. Success toast "Booking {booking_no} created" → W2.

### W4 Slot templates & blackouts
- Templates table: Centre · Type · Days (Mon–Sun chips) · Hours (`07:00–11:00`) · Slot (min) · Capacity · Effective · Active. [New template] opens `Drawer` form:

| Field | Component | Validation | Default |
|---|---|---|---|
| Centre | `Select` | required | working centre (home-collection centre listed with "(Home collection)") |
| Type | `RadioGroup` | required | Centre visit |
| Days | `WeekdayTimeRangeEditor` (CR) | ≥ 1 weekday | Mon–Fri |
| Start / End | time inputs inside the editor, `HH:MM` 15-min steps | end > start | 07:00 / 11:00 |
| Slot length | `IntegerField` 5–240 | multiple of 5 | 15 |
| Capacity per slot | `IntegerField` 1–100 | — | 3 |
| Effective from / to | `DatePicker` | to ≥ from | today / empty |

  Save → if `affected.overbooked_slots > 0`, `Banner` warning "{n} future slots now have more bookings than capacity. Review them in Bookings."
- Blackouts table + [Add blackout] (`DateTimePicker` from/to ≤ 31 days, type optional, reason `Select`, note ≤ 200); success shows "{n} existing bookings fall in this period — they are not cancelled automatically."

### W5 Bookable catalogue
Table: Code · Name · Kind · Types (Centre/Home) · Indicative price (`MoneyText`, "—" if none) · Synced at · Active (`Switch`, inline save). [Add test or package] → `Combobox` over C3 catalog search (C3 HTTP via BFF) → booking types checkboxes → save (S13). [Refresh from catalogue] (S14) → toast "Refresh started".

### W6 Queue console
Layout in 03-APP-FLOW §7.1.

| Element | Detail |
|---|---|
| Queue tabs | `Tabs` with waiting count badges |
| Waiting list | `DataTable` columns Token · Priority · Waiting (mm:ss, from server `issued_at`) · Booking (✓) |
| My counter | `Select` of counters (remembered for the browser session in memory) |
| Current token | large token label + status + call count |
| Buttons | [Call next] `Alt+N`, [Recall] `Alt+R`, [Serving] `Alt+S`, [Done] `Alt+D`, [Skip] `Alt+K`, [Transfer…] `Alt+T` (dialog: target queue), [Issue token] `Alt+I` (dialog: queue, priority) |
| Slip | `TokenSlip` (CR) print: lab name, queue name, token label, date/time; nothing else |
| Polling | Q4 every 5 s via BFF with `X-Lims-Background: 1` (C2 idle rule unaffected) |

`Alt+N` with an empty queue → toast "No one is waiting."

### W7 Queue setup
Three `Tabs` (lists from Q1b `listQueueDefinitions` / Q2b `listCounterDefinitions`, `engagement.queue.manage`; the console W6 uses Q1a/Q2a, `engagement.queue.operate` — one permission floor per operation, 08 A19 P-43): Queues (Code `^[a-z0-9_]{1,32}$`, Name ≤ 60, Token prefix `^[A-Z]{1,2}$`, Order 0–999, Active), Counters (Name ≤ 40, Order, Active), Displays (Name ≤ 40, Queues multi-select 1–10, Status, Last seen; [Pair this screen] only works on the device that will be the display: dialog "Use this button on the TV's own browser. After pairing, sign out — the screen keeps showing the queue." [Pair]; [Revoke] `ConfirmDialog`).

### W8 Patient app access
Header: patient name + patient code (from C4 via BFF). Section "App accounts linked" (`DataTable`): Phone (masked) · Relationship · Method · Status (Active / Paused: reason) · Since · [Revoke] (`ConfirmDialog` reasons: Patient request / Suspected misuse / Staff error / Other). Section "Codes": Issued · Expires · Status · [Revoke]. [Issue app code] → `Dialog` form:

| Field | Component | Validation | Default |
|---|---|---|---|
| "This patient is the app user's…" (stored as the profile's `relationship`) | `Select`: Self (`self`), Child (`child`), Parent (`parent`), Spouse (`spouse`), Sibling (`sibling`), Other (`other`); help text under Self: "If the app account already has a 'Myself' profile, this one is added as 'Other' (the user can change it)." (review C16 #12) | required | Self |
| Who gave consent | `RadioGroup` Patient / Guardian | required; Guardian required when the patient's age < `minor_age_years` | Patient |
| Identity checked by | `RadioGroup` Photo ID / Guardian's photo ID / Known regular patient | required | Photo ID |
| Code works for | `RadioGroup` "Patient's phone on record ••42" / "Another phone" | record option disabled when no phone on record | record |
| Other phone | `TextField` tel E.164 | required iff another phone | — |
| Consent text | read-only text + version | — | — |
| Confirmation | `Checkbox` "I checked the person's identity and they agreed to app access" | required | off |

Result panel: code in 32 px mono `XXXXX-XXXXX`, "Valid until {expiry}. Works once, only on the phone ending in {last2}." [Print slip] (`TokenSlip` variant: lab name, code, expiry, instructions "Open the {lab} app → Profiles → I have a code"; no patient name). Closing the panel hides the code permanently.

### W9 Reminders
Filters: due date range (≤ 92 days), status, kind. Columns: Due · Patient · Kind · Reason · Status · Sent at · Result (suppression reason text: "No SMS consent", "No phone number", "SMS turned off", "Patient opted out"). [New reminder] (patient `Combobox` via C4, reason `CodedSelect`, due `DateTimePicker` ≥ now + 1 h). Patient follow-up suggestions panel (R4) when opened from a patient: rows "Follow-up suggested in {n} days (report of {date})" + [Create reminder].

### W10 Memberships
Tabs: Lookup & enrol (`BarcodeInput` with `pattern = /^[0-9A-Z]{26}$|^MB[0-9]{8}$/`, `minScanLength 10`, label "Scan or type a membership card" → M4 → card panel; [Enrol patient] form: patient `Combobox`, plan `Select` (active plans), valid from `DatePicker` (today…+30 days) → M2); Plans (aal2 required — shell prompts MFA via C2 if `auth.mfa_required`): Code, Name ≤ 60, Description ≤ 300, Price list (`Select` from C3 price lists via BFF), Validity days 30–1095, Active.

### W11 Enquiries
Inbox `DataTable`: Last message · Topic · Subject · Status · Account phone (masked) · Profile (if any). Thread page: messages, reply `TextArea` (≤ 2000, counter), [Send] `Ctrl+Enter`, [Close] `Alt+X`. Warning above the reply box: "Don't include test results in replies; ask the patient to open their report in the app."

### W12 Engagement settings
Sections with `Switch`/`IntegerField`/`TextArea` matching 05-SCHEMA §2.1 columns and ranges: Features (app, bookings, home collection, queue, reminders, memberships, enquiries, smart summary in app, show partner orders); Patient app (allowed phone prefixes — tag input `^\+[1-9][0-9]{0,3}$`, OTP daily cap, min versions `^[0-9]+\.[0-9]+\.[0-9]+$`, gateways multi-select eSewa/Khalti, support phone, consent text `TextArea` ≤ 4000 + version `TextField` ≤ 32 — changing the text requires a new version; profiles/accounts limits, link-code TTL, dormancy days, minor age with the note "Confirm the legal age with your counsel" (B16)); Bookings (horizon, lead time, cancel cutoff, no-show grace and switch, limits, reminder hours, home-collection centre `Select`); Reminders (auto follow-up switch, lead days); Queue (display history count). Saving requires aal2 (privileged permission).

### D1 Queue display
Full-screen `QueueBoard` (CR): header lab name + centre + clock (server time from `generated_at`, advanced locally between polls); main area "Now calling" — up to 5 rows "A-012 → Counter 2" (token ≥ 96 px font [CONV]); side column "Waiting" per queue name and count; footer "Please keep your token slip". Newly called token flashes for 3 s and plays a short chime (bundled audio; muted unless the operator enabled sound once — browsers block autoplay) [CONV]. High-contrast tokens, no colour-only meaning.

## 4. Copy for statuses (shared keys)

| Key | en |
|---|---|
| `patient_app.stage.registered` | Registered |
| `patient_app.stage.sample_collected` | Sample collected |
| `patient_app.stage.in_lab` | In the lab |
| `patient_app.stage.partial_report` | Partial report |
| `patient_app.stage.report_ready` | Report ready |
| `patient_app.stage.recollection_needed` | New sample needed |
| `patient_app.stage.cancelled` | Cancelled |
| `patient_app.order.payment_due` | Payment due |
| `engagement.booking.status.confirmed` | Confirmed |
| `engagement.booking.status.checked_in` | Checked in |
| `engagement.booking.status.completed` | Completed |
| `engagement.booking.status.cancelled` | Cancelled |
| `engagement.token.status.waiting` / `called` / `serving` / `completed` / `skipped` / `cancelled` / `transferred` / `expired` | Waiting / Called / Being served / Done / Skipped / Cancelled / Moved / Expired |

## 5. Barcode / scanner behaviour

Only W10 uses a scanner (`BarcodeInput`, C0-UI §2.4): keyboard-wedge 2D scanner reading the membership QR (26 uppercase base32 chars) or a typed card number. Duplicate scans within 1.5 s ignored (kit default). Scanned values are never logged or put in URLs (kit rule). Queue slips have no barcode in v1 [DECISION: staff call tokens by number].

## 6. Responsive rules

- Patient app: single column; bottom nav; slot grid wraps 3 columns at 360 dp, 4 at ≥ 400 dp.
- Staff web: W6 is designed for 1280 px reception PCs; at `lg` the waiting list stacks above the counter panel.
- D1: 16:9 TVs at 1920×1080 and 1366×768; text sizes in `vh` units within the kit component; no scrolling.

## 7. Accessibility checklist (C16-specific)

1. OTP and code fields: one accessible text field semantically (the boxes are visual), `oneTimeCode` autofill.
2. Stage timeline: each step has text ("Step 2 of 4: Sample collected, completed").
3. Slot grid: each slot is a button labelled "07:15, 2 places left".
4. Queue board: live region `polite` announcing "Token A-012, counter 2" for screen readers on the display (mainly for staff-side use).
5. PDF viewer: page count announced; zoom gestures plus +/- buttons.
6. Every error text is linked to its field (Flutter `Semantics` / web `aria-describedby`).

## 8. Help content (`features/engagement/help/` and in-app)

Help keys: `engagement.bookings`, `engagement.booking_detail`, `engagement.booking_new`, `engagement.slots`, `engagement.bookable`, `engagement.queue`, `engagement.queue_setup`, `engagement.app_access` (must explain the identity check, the phone binding, and that a code shows the full history), `engagement.reminders`, `engagement.memberships`, `engagement.enquiries`, `engagement.settings`. Manual pages under `docs/manual/engagement/` mirror them, plus a patient-facing "How the app protects your reports" page (linked from A6).

## 9. Components missing from the kits (CR-C16-016)

### 9.1 Flutter (`lims_ui`)

| Component | Props (Dart) | Notes |
|---|---|---|
| `LimsPhoneField` | `label, prefixes: List<String>, initialPrefix, onChanged(String e164), errorText?` | numeric keypad; formats display only |
| `LimsOtpField` | `length (6), onCompleted(String), errorText?, autofocus` | single semantic field, `oneTimeCode` |
| `LimsCodeField` | `label, groupSize (5), groups (2), alphabet, onChanged(String normalised), errorText?` | uppercase, normalises per TRD §4.3 |
| `LimsStageTimeline` | `steps: List<{label, state: done|current|todo|alert}>` | text + icon per state |
| `LimsSlotPicker` | `days: List<{date, slots: List<{start, label, remaining}>}>, selected?, onSelected, calendarMode` | B.S. labels via `lims_shared/bsdate` |
| `LimsSegmentedControl<T>` | `options: List<{value, label}>, value, onChanged` | |
| `LimsBottomNav` | `items: List<{icon, label, badge?}>, index, onTap` | |
| `LimsCard` | `title, child, footer?` | |
| `LimsQrCode` | `data (String), size, semanticLabel` | offline rendering (pinned lib, CR-C16-017) |
| `LimsPdfViewer` | `filePath, onClose` | wraps pinned PDF lib |
| `LimsProfileSwitcher` | `profiles: List<{id, label, sublabel}>, selectedId?, onChanged` | "All" option |
| `LimsAppLockGate` | `child, isLocked, onUnlockRequested` | wraps local-auth capability |

No local look-alikes are built (02-CV §14: "a component missing from the kit → CR to C0, not a local look-alike"). Tasks that need a missing component depend on CR-C16-016 (06 §1); until it merges they are developed against the C0 kit's existing widgets only where the screen can be completed with them (A2 uses `LimsTextField` with `inputMode` tel if `LimsPhoneField` is late — an allowed composition, not a copy).

### 9.2 Web (`@lims/ui`)

| Component | Props (TS) | Notes |
|---|---|---|
| `QueueBoard` | `{ title: string; subtitle?: string; nowCalling: { token: string; counter: string; queue: string; isNew: boolean }[]; waiting: { queue: string; count: number }[]; serverTime: IsoUtc; connection: 'live' | 'stale' | 'unpaired'; staleSince?: IsoUtc; soundEnabled: boolean }` | listed as a planned CR in C0-UI §10 ("queue display board (C16)") |
| `TokenSlip` | `{ labName: string; heading: string; big: string; lines: string[]; issuedAt: IsoUtc }` | print stylesheet, 80 mm thermal width [CONV] |
| `WeekdayTimeRangeEditor` | `{ value: { weekdays: number[]; start: string; end: string }; onChange; minuteStep?: 5 | 15 }` | |
