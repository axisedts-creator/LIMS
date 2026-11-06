# C17 Home Collection — 04 UI/UX

Status: DECISION draft, 2026-11-06. Components only from `@lims/ui` (staff web) and `lims_ui` (Flutter) as listed in C0 04-UI-UX §2 and §8. Message keys `homecollection.<screen>.<key>` (02-CV §13); English v1; copy below is the English catalogue value. Dates/times shown with `DateText` / tenant `calendarDisplay` (default A.D. `DD/MM/YYYY hh:mm A`, Asia/Kathmandu). Money via `MoneyText` / `LimsMoneyField` (paisa, lakh grouping).

## 1. Navigation

`apps/web/src/features/homecollection/nav.manifest.ts`:

| id | label key | routeId | permission | group | order | chord |
|---|---|---|---|---|---|---|
| `homecollection.dispatch` | `homecollection.nav.dispatch` "Home visits" | `staff.homecollection.dispatch` (CR-C17-009) | `homecollection.visit.read` | `home_collection` | 10 | `g h` |
| `homecollection.handovers` | "Tube handovers" | `staff.homecollection.handovers` | `homecollection.handover.receive` | `home_collection` | 20 | `g t` |
| `homecollection.devices` | "Phlebotomy phones" | `staff.homecollection.devices` | `homecollection.device.manage` | `home_collection` | 30 | — |
| `homecollection.settings` | "Home collection settings" | `staff.homecollection.settings` | `homecollection.settings.manage` | `home_collection` | 40 | — |

All entries `phase: '3'`. Chords are checked unique by C0's build, which is authoritative. `g o` was dropped because C8 uses it (review #19); `g t` replaces it [CONV].

## 2. Staff web screens

### 2.1 W1 Dispatch board `/homecollection/dispatch`

Layout (≥ 1280 px): `PageHeader` (title "Home visits", `helpKey: homecollection.dispatch`, actions: date `DatePicker` (default today), centre `Select` (centres of the membership with kind `home_collection`, default working centre), "Refresh" `Button`) · `FilterBar` · two regions: **left** "Unassigned" `DataTable`, **right** "Routes" (one `Card` per phlebotomist route, stacked).

FilterBar: `status` (multi select: Unassigned, Assigned, In progress, Completed, Failed, Cancelled), `kind` (Booking, Front desk, Recollection, Revisit), `has_open_flags` (Switch "Needs attention"). Query params mirror H1.

Unassigned table columns: Window (`DateText withTime`, "Not scheduled" when empty) · Patient (display name) · Area (`area_hint`, ≤ 60 chars) · Kind (`StatusChip kind=generic`) · Tubes (`expected`) · Flags (`Badge` per open flag kind, text label) · Actions (`Menu`: Schedule, Assign, Cancel, Open). Sort `window_start`. Empty: "No unassigned visits for this date." Row `onRowAction` (Enter) → Assign dialog if scheduled, else Schedule dialog.

Route card: header "{phlebotomist display name} · {active_visits} visits · Phone updated {DateText of last_ack_at | 'never'}" · ordered list (`DataTable density=compact`): # · Window · Patient · Status (`StatusChip generic` with visit status label) · Tubes "collected/expected" · Flags · Actions (Move up `IconButton label="Move up"`, Move down, Print labels (link, requires `lab.specimen.label_print`), Unassign, Open). Footer: "Save order" `Button` (enabled when local order differs) → H11. Empty route card not shown.

Visit status chip labels and tones (generic chip; C0 kit has no `visit` kind — tones from C0 §1.2): Unassigned neutral · Assigned info · In progress info · Completed success · Failed danger · Cancelled neutral.

Flag badge labels: `address_missing` "Address needed" (warning) · `collected_after_cancel` "Collected after cancel" (danger) · `held_collection` "Collection on hold" (warning) · `cancel_requested_after_start` "Cancel requested" (warning) · `order_cancel_required` "Cancel order in front desk" (warning) · `missed` "Missed" (danger) · `recollection_required` "Recollection" (warning) · `handover_overdue` "Tubes not handed over" (warning) · `handover_discrepancy` "Missing tube" (danger) · `identity_mismatch` "ID mismatch" (danger) · `specimen_not_collected` "Tube not collected" (warning) · `payment_rejected` "Payment needs entry" (danger).

Keyboard (registered with `shortcuts.register('homecollection.dispatch', …)`): `Alt+D` focus date · `Alt+A` assign selected row · `Alt+S` schedule selected row · `Alt+R` refresh · `Ctrl+Enter` submit open dialog (kit default).

**Schedule dialog** (`Dialog size=md`, `Form`):

| Field | Component | Validation | Required | Default | Max |
|---|---|---|---|---|---|
| Date | `DatePicker` | today..today+30 days | yes | board date | — |
| From | `DateTimePicker minuteStep=15` | < To | yes | existing or 07:00 | — |
| To | `DateTimePicker minuteStep=15` | > From, ≤ From + 12 h | yes | From + 30 min | — |
| Address | `TextArea rows=3` | non-blank | yes | existing | 500 |
| Landmark | `TextField` | — | no | existing | 200 |
| Latitude / Longitude | `DecimalField decimals=6` (min −90/max 90; −180/180) | both or neither | no | existing | — |
| Note for phlebotomist | `TextArea rows=2` | no test names or results (help text) | no | existing | 500 |

Help text under Note: "Visible on the phlebotomist's phone. Don't write test names, results or diagnoses." Submit → H5. Success toast "Visit scheduled."

**Assign dialog**: Phlebotomist `Select` (from H12; option label "{name} — {active_visits} visits today"; disabled option with "(route full)" when H12 returns `route_full: true` — route at `max_visits_per_route` or phlebotomist at the 60-visit daily cap; review m#27, 08 A19 D-131), Route date `DatePicker` (default = window date, read-only when window set), Position `IntegerField min=1 max=60` (default end of route). Submit "Assign" → H3. Booking visits show a `Banner tone=info`: "Assigning registers the order and issues the bill in front desk." Errors: `common.validation_failed` at `/phlebotomist_membership_id` → "This phlebotomist's route is full for that day."; `homecollection.visit_incomplete` → "Add an address and a time window first."; `homecollection.phlebotomist_not_eligible` → "This person can't take visits for this centre."; `frontdesk.consent_required` → "The patient's consent is missing in front desk. Ask front desk to complete registration."; `catalog.no_price` → "A booked test has no price. Ask the lab manager to fix the price list."; `catalog.test_inactive` → "A booked test is no longer offered."

**Cancel dialog**: `ConfirmDialog tone=danger requireReason={codedSet:'homecollection.visit_cancel_reasons', freeText:{maxLength:500, isRequired:false}}` title "Cancel this visit?" body "The phlebotomist will see it as cancelled after their next sync." For assigned booking visits: extra line "The order and bill in front desk are not cancelled automatically."

**Unassign dialog**: `ConfirmDialog` with `homecollection.unassign_reasons`.

### 2.2 W2 Visit detail `/homecollection/visits/{visit_id}`

`PageHeader` (title "Home visit", status chip, breadcrumbs Home visits › Visit, actions per state: Schedule, Assign/Reassign, Unassign, Cancel, Create revisit, Open order (link `staff.frontdesk.order`), Print labels). Body `Grid` 2 columns:
- `Card` "Patient and address" (`DescriptionList`: Name, Phone (masked as "••••" until shown; the "Show" `IconButton` calls H21 `revealHomeVisitPhone`, which returns the number and writes access-log `home_visit.view` purpose `phone_reveal`; H2 itself carries no phone — review #18), Address, Landmark, Coordinates, Note) — only for `homecollection.visit.assign` holders.
- `Card` "Schedule": Window, Route date, Phlebotomist, Sequence, Phone updated at.
- `Card` "Tubes" `DataTable`: Specimen type · Container · Lab status (`StatusChip kind=specimen`) · Collected at · Collection (`StatusChip generic`: Applied success / On hold warning / Discarded neutral) · Scan ("Camera", "Scanner", "Typed — not verified" warning) · Clock ("Device clock adjusted" warning when `clock_suspect`).
- `Card` "On hold" (only when held collections exist): per row Reason text from code (`mutation_superseded` "The visit or tube changed on the server before this was uploaded", `visit_not_assigned` "Collected by someone not assigned at that time", `barcode_mismatch` "Scanned barcode doesn't match the tube") + `Button` "Review" → **Review dialog**: `RadioGroup` Apply / Discard (Apply disabled for `barcode_mismatch` with reason text), reason `CodedSelect homecollection.review_reasons`, text ≤ 500; submit → H9.
- `Card` "Payments": Method · Amount (`MoneyText`) · Captured at · Upload result. Footer: link "Open billing" (C4 order page).
- `Card` "Needs attention": flags with "Resolve" (`ConfirmDialog requireReason homecollection.flag_resolutions`).
- `Timeline`: transitions + assignments + reviews.

Loading `LoadingSkeleton variant=detail`; not found → shell not-found; 403 (phlebotomist-only) "This visit isn't assigned to you."

### 2.3 W3 Tube handovers `/homecollection/handovers`

List `DataTable`: Handed over at · From (phlebotomist) · Tubes · Status (`StatusChip generic`: Waiting warning / Received success / Missing tubes danger) · Open. Filter: status (default Waiting), centre (default working centre). Empty "No handovers waiting at this centre."

Detail `Drawer width=lg`: header "Handover from {name} · {n} tubes"; `BarcodeInput label="Scan tube"` (`autoFocus`, default pattern, `allowManual` true, duplicate scan ignored per kit); items `DataTable`: Barcode (mono) · Specimen type · Received (`Checkbox`, ticked by scan or manually). All columns come from the handover items themselves; there is no visit-window column, so staff at the receiving centre need no access to home-collection visits (08 A19 D-125). Live count "Received {x} of {n}". Footer `Button` "Confirm handover" → if all ticked H15; else `ConfirmDialog` "Mark {n} tubes as missing?" body "Missing tubes are flagged for the dispatcher." Unknown scan error "This tube is not in this handover." Success toast "Handover confirmed."

Keyboard: scan-first (`useScanCapture` enabled while the drawer is open), `Ctrl+Enter` confirm.

### 2.4 W4 Phlebotomy phones `/homecollection/devices`

`DataTable`: Phlebotomist · Model/platform · App version (warning chip "Update required" when < min) · Status (Active info, Signed off neutral, Wipe requested warning, Wiped neutral) · Last seen · Last upload · Last route download. Row action "Wipe on next connection" (`ConfirmDialog tone=danger requireReason homecollection.wipe_reasons`), body copy from 03-APP-FLOW §2.4. Empty "No phones registered yet. Phones appear after the first sign-in."

### 2.5 W5 Settings `/homecollection/settings`

`Form` sections:
- Sync & privacy: Sync interval (`IntegerField 60..900`, suffix "seconds"), Clear phone data after offline (`IntegerField 4..24`, "hours"), Capture GPS point (`Switch`, disabled with description "Needs the location component (pending)" until CR-C17-010), GPS kept for (`IntegerField 7..365` days), Allow maps hand-off (`Switch`, default on (08 A2.5), description "Sends only the visit address (no name, tests or phone) to the phone's own maps app." — hand-off approved by the founder 2026-11-06 (CR-C17-012)), Minimum app version (`TextField maxLength 20`, pattern semver).
- Visit checks: Second identifier (`RadioGroup` Phone number / Date of birth — DOB disabled until CR-C17-003), Allow typed barcodes (`Switch`), Consent text version (`TextField 40`), Consent text (`TextArea 2000`, showCount).
- Payments: methods table (code `Select` of C4's six seed codes — Cash `cash`, Card `card`, eSewa `esewa`, Khalti `khalti`, Fonepay QR `fonepay_qr`, Bank transfer `bank_transfer` (08 A19 D-128); label `TextField 40`; "Reference required" `Checkbox`, default from C4's seed: on for Fonepay QR, Card, Bank transfer), add/remove (1..10), each code at most once.
- Handover: Confirmation at centre required (`Switch`), Overdue after (`IntegerField 1..24` hours).
- Routes & messages: Max visits per route (`IntegerField 1..60`), SMS to phlebotomist on assignment (`Switch`, description "Staff SMS are not sent yet (Phase 1)." — 08 A13 D-34), SMS to patient on scheduling (`Switch`, disabled with description "Needs the scheduling SMS template (pending)" until CR-C17-014 — 08 A19 D-129), Clock tolerance (`IntegerField 60..3600` seconds).
Submit `Ctrl+Enter`; `If-Match` version; conflict banner as §2.1.

### 2.6 States common to all web screens

`loading.tsx` → `LoadingSkeleton`; `error.tsx` → `ErrorState` (reference id); offline → shell banner `core.shell.offline`; permission → nav hidden + 403 page; every `PageHeader` has a `helpKey` with a file under `features/homecollection/help/`.

### 2.7 Accessibility & responsive (web)

WCAG 2.2 AA per C0 §5; route reorder is button-based (no drag-and-drop), so it is keyboard-operable; flag badges carry text; below 1024 px the two regions stack (Unassigned first) and the kit "best on a larger screen" banner applies.

## 3. Flutter app (`apps/phlebo_app`)

Global: `LimsTheme.light`; every screen wrapped in `LimsSecureScreen` (FLAG_SECURE / app-switcher masking, REQ-SEC-109) except Login; `LimsScaffold` with `LimsOfflineBanner` slot and `LimsSyncStatus` chip ("{n} waiting · Last upload hh:mm") in the app bar; 48 dp targets; text scale to 2.0; Devanagari via bundled Noto. All text fields `enableSuggestions:false`, `autocorrect:false` (REQ-SEC-111). No copy-to-clipboard on patient fields [DECISION].

### 3.1 M1 Login
Fields: Email (`LimsTextField`, keyboard email, max 254, required), Password (`LimsTextField` obscured, max 128, required). Button "Sign in". Footer: app version, environment name in non-prod. Copy: offline "You need an internet connection to sign in."; failure "Email or password is incorrect."; locked "Your account is locked. Contact your lab administrator."; no screen lock "Set a screen lock (PIN, pattern or fingerprint) on this phone first."; rooted "This phone can't be used for home collection."; outdated (426) "Update the app to continue."; other user while unsent changes exist "This phone has unsent changes from another user. Ask that user to sign in, or the lab admin to wipe it."; device id still bound to the previous user (A1 409, empty outbox) "Sign in again to set up this phone." (review #12). Success → device registration (silent) → M2.

### 3.2 M2 Today's route
App bar: "Today · {DD/MM/YYYY}" + sync chip. Pull-to-refresh. List (`LimsListTile` per visit, ordered by sequence): leading sequence number; title = patient full name; subtitle = window "hh:mm–hh:mm" + landmark (truncated 40); trailing `LimsStatusChip` (Assigned "To do", In progress, Completed, Failed, Cancelled "Cancelled — do not visit"); badge "{collected}/{expected} tubes". Menu: Handover, Outbox, Settings. Empty: "No visits assigned for today. Pull down to refresh." Purged state: `LimsEmptyState` "Your list was cleared for security. Connect to the internet to download it again." Cancelled stub tile is greyed and not tappable except to show "This visit was cancelled by the centre."

### 3.3 M3 Visit
Sections: Patient (name; "Call" `LimsButton` → `tel:` hand-off (CR-C17-010)); Address (text, landmark; "Navigate" `LimsButton` only when `map_handoff_enabled` (default true, 08 A2.5), else hidden); Window; Note from centre; Tubes to collect (specimen type + container + last 4 of barcode "…0042"; when the snapshot marks the visit `specimens_stale`: `LimsErrorState` (inline) "Tubes unavailable — refresh before collecting" and the Collect step is disabled — review #2); Amount due `MoneyText` "as of hh:mm"; primary button by step: "I've arrived" → M4. Secondary: "Can't do this visit" → M9 (fail).

### 3.4 M4 Identity check
Copy: "Ask the patient to tell you their full name and {phone number | date of birth}. Don't read them out." Shows recorded name and phone (or DOB) for comparison. Two required `RadioGroup`-style choices (`LimsListTile` radio): "Name matches" / "Name doesn't match"; "{Phone|DOB} matches" / "doesn't match". Button "Continue". Any mismatch → `LimsConfirmDialog` "Identity doesn't match. You can't collect samples for this visit." [Fail visit] [Back] → M9 with reason `identity_mismatch` preselected.

### 3.5 M5 Consent
Shows `collection_consent_text` (scrollable) and version. Buttons "Patient agrees" / "Patient refuses". Refuse → M9 with `patient_refused`.

### 3.6 M6 Collect tubes
Top: `LimsBarcodeScanner` (camera) toggle and HID input field (always focused when no camera; burst detection: inter-key ≤ 30 ms, ≥ 4 chars, Enter/Tab submit — same rules as C0 §2.4). List of expected tubes: specimen type, container, "…last4", state (Waiting / "Collected hh:mm" / "Not collected: {reason}"). Per tube overflow: "Mark not collected" → `LimsDialog` with reason list (from config) + optional text ≤ 200. "Type barcode" (only when `manual_barcode_entry_allowed`) → `LimsTextField` max 20, uppercase, pattern `^[A-Z0-9]{1,20}$`.
Scan outcomes (with sound + haptic): match → "Collected {type}"; other visit → error "This tube belongs to another patient. Don't use it here."; unknown → "This tube is not on this visit."; repeat → "Already collected." Button "Done collecting" enabled when every tube is resolved.

### 3.7 M7 Payment
Amount due (as of). Method `LimsListTile` radio list from config. Amount `LimsMoneyField` (min NPR 0.01, max NPR 500,000.00, default = due). Reference `LimsTextField` max 100 (shown and required when method `requires_reference`; label "Transaction / QR reference"). Warning when amount ≠ due: "Amount differs from the amount due (NPR x). Continue?" Buttons "Record payment", "Skip — patient pays at centre". Copy under button: "This records the payment. The bill receipt is issued by the centre."

### 3.8 M8 Complete
Summary: tubes collected/not collected, payment. Button "Finish visit" → `visit.completed` (outcome `collected` or `partial`). Snackbar "Saved on phone. It will upload automatically."

### 3.9 M9 Fail visit
Reason list (`visit_fail_reasons` from config; seed: patient not home, address not found, patient refused, identity mismatch, unable to draw, other) + text ≤ 200 (required for `other`). Button "Fail visit" (danger).

### 3.10 M10 Handover
Choose centre (`handover_centres`), list of collected tubes not yet handed over (checkbox, all selected by default), button "Hand over {n} tubes". Copy: "Give the tubes to the centre staff. They will scan them to confirm." After sync: status per tube from push result ("Included" / "Not collected by you" / "Already handed over").

### 3.11 M11 Outbox
`LimsSyncStatus` header; list of mutations: type label ("Arrived", "ID check", "Consent", "Tube collected", "Tube not collected", "Payment", "Visit finished", "Visit failed", "Handover"), visit sequence + window (no names), time, state: Waiting / Uploading / Uploaded / "On hold at centre" / "Not accepted: {reason}". Button "Upload now". Rejected/held rows explain: "The centre will review this. Your record is saved."

### 3.12 M12 Settings/About
Device id (last 8), app version, signed-in user display name, last download/upload times, "Sign out" (`LimsButton`, disabled with text "Sync first — {n} changes are not uploaded yet" when pending > 0). Sign out confirmation: "Signing out erases today's visit list from this phone."

### 3.13 Re-auth gate (04 A16)
Needs the biometric/device-credential plugin pinned by CR-C17-010; the app is not released without it and has no password fallback after background (08 A19 D-127). Full-screen lock: lab name, "Unlock to continue" → OS prompt. Failure text "Couldn't verify. Try again." After 5 failures "Sign in again." (→ M1).

## 4. Barcode-scanner behaviour summary

| Input | Web (W3) | App (M6) |
|---|---|---|
| HID wedge scanner | `BarcodeInput` / `useScanCapture` (kit) | burst detection field (same thresholds) |
| Camera | — | `LimsBarcodeScanner` (lims_ui) |
| Manual | allowed (kit), marked `keyboard` | allowed by setting; `scan_method=manual` → `barcode_verified:false` |
| Duplicate within 1,500 ms | ignored (kit) | ignored [CONV, same value] |
| Logging | never logs values (kit rule) | never logs values |

## 5. Components not in the kits (CR candidates for C0-0D)

None required. The route reorder uses buttons (no drag-and-drop component), the step flow uses separate screens (no stepper widget), and the handover confirmation uses existing `BarcodeInput` + `Checkbox`. A `LimsStepHeader` ("Step 2 of 5") is a nice-to-have, implemented as plain text until requested.

## 6. In-app help and manual

`features/homecollection/help/`: `homecollection.dispatch`, `.visit`, `.handovers`, `.devices`, `.settings`. App: `?` icon on M2, M6, M7, M10 opening bundled help text. Manual pages in `docs/manual/homecollection/`: dispatcher guide, phlebotomist guide (incl. lost-phone steps), centre handover guide, admin settings.
