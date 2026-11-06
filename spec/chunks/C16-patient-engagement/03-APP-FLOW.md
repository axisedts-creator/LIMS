# C16 — Patient Engagement — 03 App Flow

Status: DECISION draft, 2026-11-06. Reads with `01-PRD.md` and `02-TRD.md` (TRD). Operation ids (E*, S*, Q*, L*, R*, M*, N*, T*) refer to TRD §5. Sequence diagrams cover every cross-chunk interaction. Synthetic data only.

## 1. Screen inventory

### 1.1 Patient app (Flutter)

| ID | Screen | Entry | Main operations |
|---|---|---|---|
| A0 | Splash / config | launch | E1 |
| A1 | Update required | `426` or config min version | — |
| A2 | Phone entry | not signed in | E2 |
| A3 | OTP entry | after A2 | E3, E2 (resend) |
| A4 | App lock | resume after > 5 min, PHI screen | local auth |
| A5 | Home (tabs: Orders, Reports, Bookings, More) | signed in | E13, E20, E45 (badge) |
| A6 | Profiles | More → Profiles; first sign-in with no profiles | E13, E17 |
| A7 | Add profile: lab code | A6 | E14 |
| A8 | Add profile: from report message | A6 | E15 |
| A9 | Register myself / my child | A6 | E16, E17 |
| A10 | Orders list | tab | E20 |
| A11 | Order detail (stage timeline) | A10, notification, app link `patient_app.order` | E21 (poll), E41/E42 |
| A12 | Reports list | tab | E22 |
| A13 | Report viewer (PDF) | A12, A11, app link `patient_app.report` | E23 |
| A14 | Smart summary | A13 tab | E24 |
| A15 | Pay due | A11 | E41, E42, system browser |
| A16 | Bookings list | tab | E34 |
| A17 | Booking wizard (profile → type → tests → place/address → date & slot → review) | A16 | E30, E31, E32, E37, E38, E33 |
| A18 | Booking detail (cancel, reschedule) | A16, app link `patient_app.booking` | E35, E36, E33 (reschedule) |
| A19 | Addresses | More, A17 | E37–E40 |
| A20 | Notifications | bell | E45, E46 |
| A21 | Membership card | More | E47 |
| A22 | Enquiries list / thread / new | More | E48–E51, T3b |
| A23 | Settings (reminder opt-out, app lock, sign out, delete account) | More | E10, E11, E12, C2 logout |

### 1.2 Staff web (`/engagement/...`) and display

| ID | Screen | Route id | Operations |
|---|---|---|---|
| W1 | Bookings (list/calendar) | `staff.engagement.bookings` | S1, S6 |
| W2 | Booking detail | `staff.engagement.booking` | S2, S4, S5 |
| W3 | New booking (phone booking) | from W1 | C4 patient search (HTTP), S6, S3 |
| W4 | Slot templates & blackouts | `staff.engagement.slots` | S7–S11 |
| W5 | Bookable catalogue | `staff.engagement.bookable` | S12–S14 |
| W6 | Queue console | `staff.engagement.queue` | Q1a, Q2a, Q3–Q7 |
| W7 | Queue setup (queues, counters, displays) | `staff.engagement.queue_setup` | Q1b, Q1c, Q2b, Q2c, Q8 |
| W8 | Patient app access | `staff.engagement.app_access` | L1–L4 |
| W9 | Reminders | `staff.engagement.reminders` | R1–R4, T3a |
| W10 | Memberships (enrol, lookup) and plans | `staff.engagement.memberships` | M1a, M1b, M2–M5 |
| W11 | Enquiries inbox / thread | `staff.engagement.enquiries` | N1–N4 |
| W12 | Engagement settings | `staff.engagement.settings` | T1, T2 |
| D1 | Queue display board | `staff.engagement.queue_display` (`nav: false`, auth `display_token`) | Q9 |

## 2. Authentication flows

### 2.1 Sign-in (US-EN-01)

```mermaid
sequenceDiagram
  autonumber
  participant APP as Patient app
  participant ENG as API engagement
  participant C0 as API core (resolver, rate limit)
  participant W as Worker engagement (system)
  participant NP as NotificationPort (C6)
  participant ID as IdentityPort (C2)
  APP->>ENG: E1 GET /app/config (X-Lims-Patient-PreAuth: t.syn_alpha)
  ENG-->>APP: features, min versions, consent text version
  APP->>ENG: E2 POST /auth/otp-challenges {phone_e164, app_instance_id, app_platform}
  C0->>C0: resolve tenant code; rate limit otp_request p:<phone>
  ENG->>ENG: tx: insert challenge (token_sha256, code_hmac bytea, phone_hmac bytea, code_ciphertext); enqueue send_login_otp
  ENG-->>APP: 202 {challenge_token, expires_at, resend_after_seconds}
  W->>W: supersede older pending/sent challenges of the same phone_hmac + app_instance_id (system actor; TRD §4.1 step 2)
  W->>NP: sendSms(phone_otp, engagement.login_otp, {otp_code, lab_name, minutes}, key otp:<id>)
  NP-->>W: {deliveryId, queued}
  W->>W: null code_ciphertext; status sent; access log auth.otp_sent
  APP->>ENG: E3 POST /auth/otp-challenges/verify {code} (X-Lims-Patient-PreAuth: c.syn_alpha.<token>)
  C0->>C0: resolve challenge; rate limit otp_verify o:<challenge_id>
  ENG->>ENG: tx: lock challenge; attempts+1; compare HMAC (mismatch → access log auth.otp_failure, ctx.commitOnError(), 401); status verified; find-or-insert account (new id = challenge id)
  ENG->>ID: provisionPatientMembership({accountId}) (first sign-in only)
  ENG->>ID: openPatientSession({membershipId, appInstanceId, appPlatform})
  ID-->>ENG: {sessionToken, accessToken, accessExpiresAt, sessionExpiresAt}
  ENG-->>APP: 200 {session_token, access_token, ..., account}
  APP->>APP: secure storage ← session_token; memory ← access_token
```

Screen rules A2/A3:
1. A2 validates the number client-side (E.164 after prefixing the configured default prefix to a local number — prefix list from E1; Nepali number plan UNVERIFIED, so no length rule beyond the E.164 pattern) and shows the consent notice "By continuing you agree to {lab}'s app terms" with a link to the consent text from E1.
2. A3 auto-advances after 6 digits; "Resend code" enabled after `resend_after_seconds`; after `401 auth.otp_attempts_exhausted` the screen returns to A2 with "Too many attempts. Request a new code."
3. `429` shows "Too many codes requested. Try again in {minutes} minutes." using `Retry-After`.
4. Partial failure: C2 port error → `500`; the transaction rolls back (challenge status and attempts unchanged); the user may retry the same code within TTL (same rule as TRD §4.1 step 3 and §6.2). A wrong code is different: its `attempts` increment persists through `ctx.commitOnError()` (08 A19 P-42).

### 2.2 Session refresh and expiry (US-EN-02)

```mermaid
sequenceDiagram
  autonumber
  participant APP as Patient app
  participant API as API (any module)
  participant ID as identity (C2) public op
  APP->>API: request (Bearer access JWT)
  API-->>APP: 401 auth.token_expired
  APP->>ID: resolvePatientSession (X-Lims-Patient-Session) — single-flight
  alt session valid
    ID-->>APP: {session_token (rotated), access_token, access_expires_at, session_expires_at}
    APP->>APP: secure storage ← new session_token (before the retry; the old token is now a reuse → revokes the session, 08 R10/A3.1)
    APP->>API: retry once
  else idle/absolute expired, revoked, account deleted
    ID-->>APP: 401 auth.session_expired
    APP->>APP: wipe secure storage + memory + temp files → A2
  end
```

Proactive refresh: the session controller refreshes when the access JWT expires within 120 s (same margin as C2-TRD §4.7). Concurrent requests wait for the one in-flight refresh. A refresh never runs while the app is in the background.

### 2.3 App lock (A4)

`background_timer` records the time the app went to background. On resume, if > 300 s and the next route is a PHI screen (A6–A15, A18, A21, A22), the `LimsAppLockGate` prompts device biometric/PIN. Failure ×3 or cancel → stays on A5 with PHI tabs blurred. Device without screen lock → session wiped → A2. Non-PHI screens (A20 list titles are generic, A23) open without the prompt.

## 3. Profiles and linking

### 3.1 Desk-issued linking code (US-EN-03)

```mermaid
sequenceDiagram
  autonumber
  participant ST as Staff web (W8)
  participant ENG as API engagement
  participant FD as FrontdeskPort (C4)
  participant APP as Patient app (A7)
  participant W as Worker (system)
  participant V as v_pub views (C4/C5)
  participant RP as ReportingPort (C6)
  ST->>ENG: L1 issueLinkCode {patient_id, relationship, consented_by, identity_check_method, bind_phone}
  ENG->>FD: getPatientDemographics({patientId, purpose:'patient_app_link'}) (staff ctx)
  FD-->>ENG: {fullName, sex, birthOn?, phoneE164?, status}
  ENG->>ENG: tx: link_consents insert; link_codes insert (code_hmac, bound_phone_hmac, record_phone_hmac); access log
  ENG-->>ST: 201 {code, expires_at, bound_phone_masked} → print slip
  APP->>ENG: E14 redeemLinkCode {code}
  ENG->>ENG: app.engagement_redeem_link_code(code_hmac bytea) — DEFINER compares bound_phone_hmac = account.phone_hmac (bytea = bytea, 08 A2.4/A5.5); code redeemed; an existing active/suspended link is reactivated/widened inside the DEFINER
  alt no row
    ENG->>ENG: linkfail counter +1; ctx.commitOnError(); 422 engagement.link_code_invalid
  else existing link
    ENG->>ENG: enqueue backfill_link → 200 Profile
  else new
    ENG->>ENG: limits (409 rolls back the redemption); insert link (active, visible_from NULL, sex_snapshot; self→other if a self link exists); enqueue backfill_link
  end
  ENG-->>APP: 201 Profile
  W->>V: frontdesk.v_pub_order_status / lab.v_pub_specimen_timeline / billing.v_pub_order_balance (patient X)
  W->>RP: getReleasedReports({filter:{patientId}, includeSuperseded:true})
  W->>W: upsert patient_orders / specimens / reports; stages
```

Staff screen W8 flow: open from C4's patient page or by patient id (route `staff.engagement.app_access`) → shows existing links and codes (L3) → [Issue app code] opens a dialog: relationship (default `self`), who consents (patient / guardian), identity check (photo ID / guardian photo ID / known patient), phone binding (patient's phone on record — masked — or another phone) → consent text shown read-only with version → [Issue] → code shown in large type + [Print slip] + "The code works once, only on the phone ending in ••42, until {expiry}".

### 3.2 Report-link linking (US-EN-04)

```mermaid
sequenceDiagram
  autonumber
  participant APP as Patient app (A8)
  participant ENG as API engagement
  participant RP as ReportingPort (C6)
  APP->>ENG: E15 redeemReportLink {link_url}
  ENG->>ENG: validate origin = LIMS_ORIGIN_PORTAL and path /r/<token>
  ENG->>RP: redeemPortalLinkForApp({linkToken, phoneE164: account phone}) (patient ctx)
  alt valid, patient recipient, destination = phone
    RP-->>ENG: {patientId, reportId, versionNo, releasedAt}
    ENG->>ENG: app.engagement_apply_report_link(patientId, releasedAt) — existing active: widen visible_from; suspended: reactivate (DEFINER)
    ENG->>ENG: else insert link (method report_link, visible_from releasedAt; self→other if a self link exists); enqueue backfill
    ENG-->>APP: 201 Profile
  else any failure
    RP-->>ENG: reporting.link_invalid
    ENG-->>APP: 422 engagement.link_code_invalid
  end
```

A8 offers a paste field and explains "Paste the link from the SMS or WhatsApp message the lab sent to this phone". The app does not register as a handler for `/r/` links (the portal stays the default handler for those).

### 3.3 Self-registration (US-EN-05)

```mermaid
sequenceDiagram
  autonumber
  participant APP as Patient app (A9)
  participant ENG as API engagement
  participant W as Worker (system)
  participant FD as FrontdeskPort (C4)
  APP->>ENG: E16 createSelfRegistration {relationship, full_name, sex, birth_on|age_years, sms_consent, whatsapp_consent, consent_text_version}
  ENG->>ENG: tx: validate; insert self_registrations (queued) + link_consents; enqueue create_self_patient
  ENG-->>APP: 202 SelfRegistration
  W->>FD: createSelfRegisteredPatient({..., phoneE164: account phone, consents, idempotencyKey: selfreg:<id>})
  FD-->>W: {patientId, patientCode, duplicateSuspected}
  W->>W: tx: insert link (self_registered, visible_from now); self_registration created
  APP->>ENG: E17 poll every 2 s up to 20 s, then on pull-to-refresh
```

### 3.4 Link state machine (`account_patient_links.status`)

| # | From | To | Trigger / guard | Actor | Side effects |
|---|---|---|---|---|---|
| L-1 | (none) | `active` | code redeemed (§3.1) / report link redeemed (§3.2) / self-registration created (§3.3); limits pass | patient / system | backfill job; access log |
| L-2 | `active` | `active` | another proof for the same patient | patient (inside DEFINER `engagement_redeem_link_code` / `engagement_apply_report_link`) | `visible_from` widened (code → NULL; report link → `least`); method upgraded to `link_code` by a code |
| L-3 | `active` | `suspended` | phone mismatch / merged / anonymised / dormant (TRD §4.3.5) | system | notification `profile_paused`; reads → 404 |
| L-4 | `suspended` | `active` | new proof after `suspended_at` | patient, only inside the same DEFINERs (a direct patient UPDATE raises `immutable_row`, 05-SCHEMA §4) | backfill; `record_phone_hmac_at_link` refreshed; code → `visible_from` NULL, report link → `releasedAt` |
| L-5 | `active`/`suspended` | `revoked` | patient removes; staff revoke; account deleted | patient / staff / system | access log; projections stop being readable |
| — | `revoked` | any | **forbidden** — a new link row is created instead (L-1) | | |

Projections of a patient remain stored while any link to that patient is active or suspended; when the last link is revoked, the nightly reconcile deletes that patient's projection rows (they are copies; source of truth stays in C4/C5/C6) — DECISION (data minimisation, REQ-SEC-139).

Self-registration machine: `queued → created` (link L-1) | `queued → failed` (after max attempts or `frontdesk.consent_required`). `failed` can be retried by the app (new request, new id).

## 4. Domain state machines

### 4.1 Booking (`engagement.bookings.status`)

| # | From | To | Trigger / guard | Actor / permission | Events / side effects |
|---|---|---|---|---|---|
| B-1 | (none) | `confirmed` | E33/S3; slot generated and capacity reserved; orderables bookable; limits; patient id from active link (patient) or input (staff) | patient `engagement.booking.create` / staff `engagement.booking.manage` | `engagement.booking.confirmed.v1`; occupancy +1; confirmation SMS task; booking reminder scheduled; notification `booking_confirmed` |
| B-2 | `confirmed` | `checked_in` | S5 on or after `slot_start − 2 h` [CONV] and before `slot_end + no_show_grace_minutes` | staff `engagement.booking.manage` | optional queue token (same tx) |
| B-3 | `confirmed` | `cancelled` | E36 (≥ cutoff before start) / S4 / reschedule | patient `engagement.booking.cancel` / staff | `engagement.booking.cancelled.v1`; occupancy −1; reminders cancelled; cancellation SMS task; notification |
| B-4 | `checked_in` | `cancelled` | S4 (patient left) | staff | same as B-3 |
| B-5 | `confirmed` | `cancelled` (`no_show`) | cron: `centre_visit` only; `auto_no_show`, `slot_end + grace < now`, order still `pre_registered`/unknown | system | event; occupancy unchanged (slot is past) |
| B-6 | `confirmed`/`checked_in` | `completed` | `centre_visit`: reconcile finds the booking's order `registered`/`in_progress`/`completed` | system | `order_id` stored; no event |
| B-6h | `confirmed`/`checked_in` | `completed` | `home_collection`: first `homecollection.collection.synced.v1` carrying the `booking_id` (08 A19 D-120) | system | `order_id` from the event; no event. Never auto-no-showed; staff cancel manually (B-3/B-4) |
| B-7 | `confirmed`/`checked_in` | `cancelled` (`lab_unavailable`) | reconcile: C4 order `cancelled` | system | **no event** (C4 originated it); occupancy −1 if slot in future |

Forbidden (→ `409 engagement.booking_invalid_transition`): any transition out of `completed` or `cancelled`; `checked_in → checked_in`; patient cancel of `checked_in`.

### 4.2 Payment request (`engagement.payment_requests.status`)

| From | To | Trigger |
|---|---|---|
| (none) | `queued` | E41 |
| `queued` | `ready` | task created the intent |
| `queued` | `failed` | `payments.*` error from `createIntent` |
| `ready` | `completed` | `refresh_payment_request` task (system, enqueued by E42) sees `getIntent.status = settled` (08 R8) |
| `ready` | `expired` | refresh task: `getIntent` `failed`/`expired`; or cron past `expires_at + 30 min` |
| `ready` | `ready` (review) | `held_for_review` → `review: true` |

`completed`, `failed`, `expired` are terminal; `action_json` is scrubbed on leaving `ready`.

### 4.3 Queue token (`engagement.queue_tokens.status`)

| # | From | To | Operation | Guard |
|---|---|---|---|---|
| T-1 | (none) | `waiting` | Q3 issue / S5 check-in / Q7 transfer target | queue active, `queue_enabled` |
| T-2 | `waiting` | `called` | Q5 call next | oldest by priority then issue time; `SKIP LOCKED` |
| T-3 | `called` | `called` | Q6 recall | `call_count < 9` |
| T-4 | `called` | `serving` | Q6 serve | — |
| T-5 | `called` | `skipped` | Q6 skip | — |
| T-6 | `skipped` | `called` | Q6 recall (from skipped list) | same business day |
| T-7 | `serving`/`called` | `completed` | Q6 complete | — |
| T-8 | `waiting`/`called`/`skipped` | `cancelled` | Q6 cancel | — |
| T-9 | `waiting`/`called`/`serving` | `transferred` | Q7 | target queue active, same centre |
| T-10 | `waiting`/`called`/`serving`/`skipped` | `expired` | cron end of day | — |

Every transition that changes what a display shows (T-2, T-3, T-4, T-6, T-7, T-9) increments `queue_definitions.board_version`. Forbidden → `409 engagement.queue_token_invalid_transition`.

### 4.4 Reminder (`engagement.reminders.status`)

`scheduled → sent` (port returned `queued`) · `scheduled → suppressed` (port suppression, opt-out, feature off) · `scheduled → failed` (port error after retries) · `scheduled → cancelled` (R3, booking cancelled, patient anonymised). Terminal: all except `scheduled`. Forbidden → `409 engagement.reminder_invalid_transition`.

### 4.5 Enquiry (`engagement.enquiries.status`)

`(none) → open` (E49) · `open → answered` (N3) · `answered → open` (E51) · `open/answered → closed` (N4; also auto-close 30 days after last message [CONV], step of the `engagement.purge_ephemeral` task, TRD §8.2) · `closed →` nothing (E51/N3 → `409 engagement.enquiry_invalid_transition`).

### 4.6 OTP challenge, link code, membership, account

| Machine | Transitions |
|---|---|
| OTP challenge | `pending → sent` (task) · `pending/sent → verified` (E3 match) · `pending/sent → failed` (5th wrong code; send failed) · `pending/sent → superseded` (new request same phone+instance; done by the `send_login_otp` task as system actor) · any non-terminal past `expires_at` is treated as expired (no write); `verified` + `consumed_at` set when the session is issued |
| Link code | `issued → redeemed` · `issued → revoked` (L2; superseded by a 4th code) · `issued` past `expires_at` treated as expired |
| Membership | `active → cancelled` (M5) · `active → expired` (cron) |
| Account | `active → deleted` (E12). No other states in v1 |

## 5. Read-model and status flows

### 5.1 Specimen status → app (US-EN-07)

```mermaid
sequenceDiagram
  autonumber
  participant C5 as C5 lab (producer)
  participant W as Worker engagement
  participant V as frontdesk.v_pub_order_status
  participant DB as engagement tables
  participant APP as Patient app (A11)
  C5-->>W: lab.specimen.status_changed.v1 {specimen_id, order_id, patient_id, to_status, seq}
  W->>DB: inbox insert (dedupe) ; linked(patient_id)?
  alt not linked
    W->>W: commit (no-op)
  else linked
    W->>V: order row (if patient_orders row missing)
    W->>DB: upsert specimen if seq > status_seq; recompute order stage
  end
  loop every 30 s while A11 in foreground
    APP->>W: (via API) E21 GET /me/orders/{order_id} If-None-Match
  end
```

### 5.2 Report release → notification → download (US-EN-08/09)

```mermaid
sequenceDiagram
  autonumber
  participant C6 as C6 reporting
  participant W as Worker engagement
  participant APP as Patient app
  participant ENG as API engagement
  C6-->>W: reporting.report.released.v1 {report_id, version_no, order_id, patient_id, audiences}
  W->>C6: getReleasedReports({filter:{orderId}}) (system) → panelNames, smartSummaryAvailable
  W->>W: upsert patient_reports; supersede older; notification report_ready
  opt smart available and smart_report_in_app
    W->>C6: openReleasedReportFile({reportId, versionNo}) (system) → smartSummary snapshot (08 A2.3)
    C6-->>W: snapshot present and approved → store copy in smart_summaries; absent → none
  end
  APP->>ENG: E22 listMyReports → E23 download
  ENG->>ENG: projection row visible (RLS + visible_from)? else 404
  ENG->>C6: openReleasedReportFile({reportId, versionNo}) (patient ctx)
  C6-->>ENG: {signedUrl (internal), sha256, byteSize}
  ENG->>ENG: stream bytes; verify sha256; access log report.download
  ENG-->>APP: 200 application/pdf
```

Partial failure: if the storage stream fails mid-way, the API aborts the response (client sees a network error), no access-log entry is committed for an unfinished download (`ctx.commitOnError()` is not used), and the app offers retry. The rate-limit counter has already counted the attempt (04 §4 counts requests).

### 5.3 Balance → payment (US-EN-10)

```mermaid
sequenceDiagram
  autonumber
  participant APP as Patient app (A15)
  participant ENG as API engagement
  participant W as Worker (system)
  participant PP as PaymentProviderPort (C15)
  participant SB as System browser
  participant GW as eSewa/Khalti
  APP->>ENG: E41 createPaymentRequest {gateway} (Idempotency-Key)
  ENG->>ENG: order visible + payment_due; insert queued; enqueue create_payment_intent
  ENG-->>APP: 202 PaymentRequest(queued)
  W->>PP: createIntent({orderId, gateway, idempotencyKey: eng:<id>, returnUrl/cancelUrl: <PORTAL>/app/payments/<id>/done})
  PP-->>W: {intentId, amount, action, expiresAt}
  W->>W: request ready (action stored)
  APP->>ENG: E42 poll 2 s → ready + action
  APP->>SB: open action.url / launchUrl
  SB->>GW: pay
  GW-->>SB: → C15 callback → verify → 303 <PORTAL>/app/payments/<id>/done?intent_id&outcome
  SB-->>APP: app link opens A15 result
  APP->>ENG: E42 (poll 3 s up to 60 s) — reads payment_requests only
  ENG->>ENG: ready and last checked ≥ 3 s ago → enqueue engagement.refresh_payment_request (job_key per request)
  W->>PP: getIntent({intentId}) (system actor — 08 R8)
  PP-->>W: settled
  W->>W: request completed
  APP->>ENG: E42
  ENG-->>APP: completed → "Paid"; balance refresh via billing.balance.changed.v1 projection
```

If the app link does not open (app removed, OS setting), the portal fallback page (CR-C16-010) says "Return to the app"; when the app is next opened, A11 shows the payment request status from E42.

## 6. Booking flows

### 6.1 Create, confirm, downstream (US-EN-12/13)

```mermaid
sequenceDiagram
  autonumber
  participant APP as Patient app (A17)
  participant ENG as API engagement
  participant Q as Outbox / worker core
  participant C4 as C4 frontdesk consumer
  participant C17 as C17 homecollection consumer
  participant W as Worker engagement
  participant NP as NotificationPort (C6)
  APP->>ENG: E32 listMyAvailableSlots(kind, centre, dates)
  APP->>ENG: E33 createMyBooking (Idempotency-Key)
  ENG->>ENG: tx: validate; occupancy UPDATE … booked < capacity; booking_no; insert booking+items+transition
  ENG->>Q: publish engagement.booking.confirmed.v1 (same tx); enqueue send_booking_message
  ENG-->>APP: 201 Booking
  Q-->>C4: confirmed (centre_visit) → createFromBooking(confirmImmediately:false) → pre_registered order; home_collection → inbox only, no order (08 R7)
  Q-->>C17: confirmed (home_collection) → home visit; order created by C17 at assignment; address via EngagementPort.getHomeAddress (08 R25)
  W->>NP: sendSms(patient, engagement.booking_confirmation, {lab_name, datetime, booking_no})
```

Wizard rules (A17): step "tests" lists E30 items filtered by kind and sex restriction of the chosen profile (sex from the link `sex_snapshot`; when it is NULL, restricted items stay selectable with "Suitability is confirmed at the lab"); step "place" lists E31 centres (from `engagement.booking_centres`) (centre visit) or E37 addresses (home collection, "Add address" inline); step "slot" calls E32 for 7 days at a time; step "review" shows indicative total (sum of `indicative_price`; items without a price show "Price at the lab") and the text "Final price is confirmed at the lab". Submit sends one Idempotency-Key generated when the review step opens; a retry after a timeout reuses it.

### 6.2 Cancel, reschedule, completion, no-show (US-EN-14)

```mermaid
sequenceDiagram
  autonumber
  participant APP as Patient app (A18)
  participant ENG as API engagement
  participant Q as Outbox
  participant C4 as C4 consumer
  participant C17 as C17 consumer
  participant CR as Cron engagement
  participant V as frontdesk.v_pub_order_status
  APP->>ENG: E36 cancelMyBooking (If-Match)
  ENG->>ENG: tx: guard cutoff; occupancy −1; status cancelled; cancel reminders
  ENG->>Q: engagement.booking.cancelled.v1 {reason patient_request, cancelled_by_kind patient, order_id?}
  Q-->>C4: centre_visit: pre_registered → cancel order; registered → flag booking_cancelled_after_registration; home_collection: lookup booking_links by home_visit_id → review item if registered (08 R7)
  Q-->>C17: drop/unassign visit (or flag if in progress)
  CR->>V: source=engagement_booking, source_ref_id ∈ open bookings
  V-->>CR: order statuses
  CR->>ENG: completed (registered+) / cancelled without event (order cancelled) / store order_id
  CR->>ENG: no-show (centre_visit only): slot_end + grace < now and still pre_registered → cancel (system) + event; occupancy unchanged
  Note over CR,ENG: home_collection bookings complete on homecollection.collection.synced.v1 with booking_id (D-120); never auto-no-showed
```

Reschedule (E33 with `replaces_booking_id`): one transaction: cancel old (B-3, event `cancelled`) then create new (B-1, event `confirmed`). If the new slot is full, the whole transaction rolls back (old booking untouched).

### 6.3 Staff phone booking and check-in (US-EN-15)

W3: search patient through C4's `POST /v1/frontdesk/patients/search` (BFF, staff token; C4 owns that API) → pick → kind/centre/slot (S6 shows capacity) → tests (S12 list) → [Book] (S3). For home collection the staff type the address (stored as an address with `account_id` NULL for that patient). W2 [Check in] → dialog "Issue queue token?" (default on when the centre has a `registration` queue) → S5.

## 7. Queue flows (US-EN-21/22)

### 7.1 Console (W6)

Layout: queue tabs (one per active queue at the working centre — the shell's centre selector, C0-UI §7) → left: waiting list (token, priority, waited mm:ss); right: counter panel (select my counter, [Call next] `Alt+N`, current token with [Recall] `Alt+R`, [Serving] `Alt+S`, [Done] `Alt+D`, [Skip] `Alt+K`, [Transfer…] `Alt+T`), plus [Issue token] `Alt+I` (queue + priority) which prints a slip. Polls Q4 every 5 s through the BFF (background header set).

### 7.2 Display pairing and board

```mermaid
sequenceDiagram
  autonumber
  participant TV as TV browser (staff signs in once)
  participant BFF as Staff BFF
  participant ENG as API engagement
  participant DP as (display) route server
  TV->>BFF: W7 [Pair this screen] (staff session, engagement.queue.manage)
  BFF->>ENG: Q8 pairQueueDisplay {centre_id, display_name, queue_ids}
  ENG-->>BFF: {display, display_token} (token never sent to browser)
  BFF-->>TV: Set-Cookie __Secure-lims_qdisp (HttpOnly, Secure, SameSite=Strict, Path=/queue-display, no Domain) [CONV]; redirect /queue-display
  TV->>BFF: staff signs out (C2 logout) — display cookie remains
  loop every 5 s
    TV->>DP: GET /queue-display/api/board (cookie)
    DP->>ENG: Q9 getQueueBoard (X-Lims-Display-Token, If-None-Match)
    ENG-->>DP: 200 QueueBoard + ETag | 304
    DP-->>TV: JSON (no-store)
  end
```

Display page states: "Not paired" (no cookie / `401`) with text "Ask a lab administrator to pair this screen"; "Connecting…" (first load); "Live" (board); "Connection lost — showing last update at hh:mm" after 3 failed polls (keeps the last board, never blank). Revocation → `401` → "This screen is no longer paired".

## 8. Reminder flow (US-EN-23/24/25)

```mermaid
sequenceDiagram
  autonumber
  participant ST as Staff (W9) / system (summary, booking)
  participant ENG as API engagement
  participant CR as Cron dispatch (5 min)
  participant W as Task send_reminder
  participant NP as NotificationPort (C6)
  ST->>ENG: R2 createReminder / system insert (scheduled)
  CR->>ENG: due reminders (FOR UPDATE SKIP LOCKED) → enqueue send_reminder
  W->>W: checks: reminders_enabled, opt-out of linked accounts
  W->>NP: sendSms({recipient:{kind:'patient', patientId}, templateCode, purpose, params:{lab_name, datetime[, booking_no]}, idempotencyKey: rem:<id>})
  NP-->>W: queued | suppressed_no_consent | suppressed_no_contact | suppressed_channel_disabled
  W->>ENG: status sent | suppressed (failure_code = suppression); in-app notification per active linked account
```

## 9. Membership flow (US-EN-17)

```mermaid
sequenceDiagram
  autonumber
  participant ST as Staff (W10)
  participant ENG as API engagement
  participant CP as CatalogPort (C3)
  participant C4 as C4 registration (CR-C16-014)
  participant APP as Patient app (A21)
  ST->>ENG: M1 createMembershipPlan {price_list_id} (aal2)
  ENG->>CP: getPriceListStatus({priceListId}) → isActive && status = published, else 400 (08 A24.1, CR-C16-023)
  ST->>ENG: M2 enrolMembership {patient_id, plan_id, valid_from}
  ENG->>ENG: tx: overlap check (partial unique); card_no; card_token; access log
  C4->>ENG: EngagementPort.getActiveMembership({patientId}) at registration (08 R25)
  APP->>ENG: E47 listMyMemberships → card with QR(card_token)
  ST->>ENG: M4 lookupMembershipCard {card_token} (scanned)
```

## 10. Empty / loading / error / success / permission states

### 10.1 Patient app

| Screen | Empty | Loading | Error | Success | Permission / auth |
|---|---|---|---|---|---|
| A5 Home | no profiles → card "Add your lab records" (→ A6) | `LimsLoading` skeleton | `LimsErrorState` with retry + reference id | tabs with badges | `401` → refresh → A2 |
| A6 Profiles | "No profiles yet" + 3 options (code, report message, register) | skeleton | error + retry | list; pending self-registrations with spinner; paused profiles never listed (message banner "One profile is paused — ask the lab for a new code" when E13 reports `paused_count > 0`) | — |
| A7/A8 | — | button spinner | `422` "This code didn't work. Check it or ask the lab for a new one." (same text for every cause); `429` "Too many tries. Try again in an hour."; `409 link_limit_reached` "You have the maximum number of profiles." | toast "Profile added" → A10 filtered to it | — |
| A9 | — | spinner, then "Creating your record…" polling | `403 common.feature_disabled` "Registration happens at the lab"; validation inline | "Profile created" | — |
| A10 Orders | "No orders yet" | skeleton | error + retry; offline banner keeps last list in memory only | list with stage chips | — |
| A11 Order detail | — | skeleton | `404` "This order is no longer available" → back | timeline; "Payment due" banner → A15 | — |
| A12 Reports | "No reports yet. You'll see them here when the lab releases them." | skeleton | error | list; superseded hidden toggle | — |
| A13 Viewer | — | progress "Downloading report…" | `429` message; `503` "The report can't be downloaded right now"; integrity mismatch → "Download failed" | PDF | app lock |
| A14 Smart | tab hidden when none | skeleton | error | content + disclaimer | app lock |
| A15 Pay | — | "Preparing payment…" (≤ 30 s) then "Opening eSewa/Khalti…" | `failed` mapping: `payments.nothing_due` "Nothing to pay", `payments.intent_open_exists` "A payment is already in progress", `payments.amount_not_supported` "This amount can't be paid online", `payments.gateway_not_available` "This payment method is unavailable" | "Paid" only on `completed`; "We are confirming your payment" on review/timeout | — |
| A16/A17/A18 Bookings | "No bookings" + [Book a test] (hidden when `bookings_enabled` false) | skeleton / slot grid shimmer | `409 slot_unavailable` "That time was just taken — pick another" (refresh slots); `429 booking_limit_reached` "You have reached the booking limit"; `409 booking_not_cancellable` "Too close to the appointment to cancel in the app — call the lab" | confirmation screen with booking no., date/time (A.D./B.S. per `calendarDisplay`), place | — |
| A20 Notifications | "You're all caught up" | skeleton | error | list | — |
| A21 Membership | "No membership" | skeleton | error | card + QR (screen brightness raised while shown) | app lock |
| A22 Enquiries | "No messages" + [New message] | skeleton | `409` "This conversation is closed" | thread | — |
| A1 Update | — | — | — | "Update required" + store button | — |

### 10.2 Staff web and display

Every page has `loading.tsx` (`LoadingSkeleton`) and `error.tsx` (`ErrorState` with request id). Permission denied → shell `core.shell.forbidden`; object outside centre → `core.shell.not_found` (02-CV §4.6). Empty states: W1 "No bookings for this day", W4 "No slot templates yet — patients cannot book this centre", W5 "Nothing is bookable yet", W6 "No tokens waiting", W8 "This patient has no app access", W9 "No reminders", W10 "No membership plans", W11 "No open enquiries". Feature switched off → `Banner` "This feature is turned off in Engagement settings" with link to W12 (only for users with `engagement.settings.manage`).

## 11. Edge cases

| Case | Behaviour |
|---|---|
| Double-tap "Book" / network timeout retry | same Idempotency-Key → same booking (`Idempotent-Replayed: true`); one event (outbox `ON CONFLICT`) |
| 20 concurrent bookings for 1 remaining place | conditional `UPDATE … booked < capacity` serialises; 1 success, 19 `409 engagement.slot_unavailable` |
| Template capacity reduced after bookings | existing bookings kept; slot `overbooked` flag in S6; staff decide |
| Blackout added over bookings | bookings stay confirmed; S11 returns the count; staff cancel with `lab_unavailable` |
| Cancel event delivered to C4 before confirmed (worker reorder) | C4 handles via `booking_links.last_seq` (C4-TRD §8); C16 emits confirmed before cancelled transactionally, so seq 1 < seq 2 |
| C4 consumer fails permanently (dead letter) | booking stays `confirmed`; reconcile finds no order; front desk sees the booking in W1 and registers from it; no-show job does **not** cancel bookings whose order is missing until grace passes — then cancels (`no_show`), which is correct if the patient never came |
| Patient arrives without the app | staff find the booking in W1 (filter by centre and date; the list shows booking no. and slot time); booking numbers are display attributes only, never path parameters (02-CV §4.1) |
| OTP SMS never arrives | resend after 60 s; 3/hour limit; the screen offers "Call the lab" with `support_phone` |
| Two devices sign in with the same phone | two sessions (C2), same account; both see the same profiles |
| Phone number recycled to a new person | dormancy rule suspends links after 180 days without sign-in; phone-change rule suspends links when the lab updates the patient's number |
| Patient changes number at the desk while the old SIM is active | reconcile suspends `link_code` links bound to the old record phone; the patient re-links on the new phone with a new code |
| Family shares one phone | every family member needs their own proof (code or report link); one account holds up to 8 profiles |
| Child linked to two parents | allowed up to `max_accounts_per_patient` (3); each parent proves separately |
| Report amended | v2 released → v1 `superseded`; downloads of v1 still allowed (marked "Superseded") because the patient may need the history; smart summary of v1 hidden |
| Report released while link suspended | projected (link suspended still projects) but invisible until reactivation |
| Order cancelled at desk | stage `cancelled`; still listed for 30 days, then hidden [CONV] |
| App offline | requests fail fast; offline banner; nothing is cached on disk; actions are not queued (online-only app, REQ-ARCH-065) |
| Access JWT expires during a PDF download | download fails `401`; app refreshes and retries once |
| Worker backlog delays OTP | OTP valid 300 s from issue; if the SMS goes out late, the user may need to resend — metric `otp_requests_total{outcome}` and queue-depth alert (C0) |
| Display clock vs server clock | board shows server `generated_at`; the page never computes "minutes waiting" from its own clock |
| Queue day boundary at 23:50 local | tokens still `waiting` expire; next issue after midnight starts at 001 |
| Settings changed while bookings exist (horizon shortened) | existing bookings unaffected; only availability changes |
| Self-registration duplicate | new record always; front desk merges later (C4); merge suspends the link (`patient_merged`) and the user re-links with a code |
| Payment completes after the app was closed | C15 settles via callback/poll; next E42 shows `completed`; balance projection updated by event |
| Mixed-tenant ids in `markMyNotificationsRead` | per-id `not_found` (02-CV §4.1) |
