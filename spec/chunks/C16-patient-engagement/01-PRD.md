# C16 — Patient Engagement — 01 PRD

Status: DECISION draft, 2026-11-06. Wave 3 (01-CHUNK-MAP §1). Phase per item: see §8 (Phase 2 for queue tokens and B2C reminders, Phase 3 for the patient app, appointment slots and minimal membership — 04 §12). Patient app: Phase 3 per the 01 §1 wave order (B1 closed, 08 A11.2).
Precedence: 00 → 04 → 03-IC → 01/02 (program) → this file. Names of events, ports, permissions, error codes and routes are verbatim from `program/03-INTERFACE-CATALOG.md` (03-IC). Anything 03-IC lacks is marked **[CR-C16-nnn]** and specified in `02-TRD.md` §15; this chunk is designed as if those CRs are accepted and builds against fakes until they merge.

Abbreviations: 02-CV = `program/02-CONVENTIONS.md`; CM = `program/01-CHUNK-MAP.md`; R01/R02/R03 = `research/01-features-workflow.md`, `02-security.md`, `03-backend-architecture.md`; C2-TRD, C4-TRD, C6-TRD, C13-TRD, C15-TRD = the `02-TRD.md` of those chunks.

## 1. Purpose

The client's own product formula is "Software + Website + APP (Patient APP, Phlebotomy APP) + Smart AI report" (00 §1, handwritten). Its wishlist asks for "test booking, real-time sample status, report download PDF, smart report analysis/download" in a patient app (00 §3 item 5; the baseline wording "their own developed Patient App" is read per 04 §12 phase 3 as a native app built by the LIMS provider in C16 — open client question C-06, 08 A19 D-124: "Does the client have or plan its own patient/phlebotomy app? Default: the LIMS provider builds both (C16, C17)"), B2C reminders, appointment and enquiry management (item 11), loyalty/membership/coupons (item 12), and queue/front-desk/appointment-slot management (item 13).

C16 delivers the **patient-facing engagement layer** of the LIMS, limited to what 04 §12 keeps:

1. A **native patient app** (Flutter, `apps/patient_app`): phone-OTP sign-in, family profiles, orders with live sample status, released reports (PDF), smart-report view, in-app payment of dues, bookings, in-app notifications, membership card, enquiries.
2. The **`engagement` API module**: patient accounts and the identity-proofing rules that link an app account to the lab's `frontdesk.patients` records, bookings and appointment slots, queue tokens, reminders, minimal membership, enquiries, and read models fed by events.
3. **Staff screens** in the staff web (`engagement` route segment): slot templates, bookings (incl. phone bookings and check-in), queue console and queue displays, patient-app access (linking codes), reminders, membership plans, enquiries, settings.

The most important property of this chunk: **an app account never sees another person's lab records.** A verified phone number alone grants nothing clinical. Seeing a patient's orders and reports needs a per-patient **link**, created only by one of three proofs (D-LINK, §6.1).

## 2. Users and roles

Permission codes are from 03-IC §11. Codes marked [CR-C16-002] are requested additions (02-TRD §15).

| Actor (actor_type) | What they do in C16 | Permissions |
|---|---|---|
| Patient app user (`patient`, after OTP) | manages own account, profiles, bookings, addresses, payments, enquiries; reads own orders/reports/notifications | fixed set 03-IC §11: `engagement.self.read`, `engagement.booking.create`, `engagement.booking.cancel`, `reporting.portal.view`, `reporting.portal.download`; plus [CR-C16-002]: `engagement.self.manage`, `engagement.link.redeem`, `engagement.payment.create`, `engagement.enquiry.create` |
| Patient app before sign-in (`patient`, claims `patient_stage = pre_auth`) | reads app config, requests and verifies an OTP | [CR-C16-002] `engagement.auth.challenge` only |
| `front_desk` | phone bookings, check-in, queue console, issues linking codes, revokes app links, enrols members, answers enquiries, manual reminders | `engagement.booking.read`, `engagement.booking.manage`, `engagement.booking.cancel` (03-IC §11); [CR-C16-002] `engagement.queue.operate`, `engagement.link.issue`, `engagement.link.read`, `engagement.link.revoke`, `engagement.reminder.read`, `engagement.reminder.manage`, `engagement.membership.read`, `engagement.membership.enrol`, `engagement.enquiry.read`, `engagement.enquiry.respond` |
| `centre_staff` | same as front desk at collection centres for queue, bookings check-in | [CR-C16-002] adds `centre_staff` to `engagement.booking.read`, `engagement.booking.manage`, `engagement.queue.operate` |
| `lab_manager` | slot templates, blackouts, bookable catalogue, queues/counters/displays | [CR-C16-002] `engagement.slot.manage`, `engagement.bookable_item.manage`, `engagement.queue.manage` |
| `tenant_admin` (MFA, 04 A4) | engagement settings, app consent text, membership plans, everything lab_manager does | [CR-C16-002] `engagement.settings.manage` (privileged), `engagement.membership_plan.manage` (privileged), plus the lab_manager codes |
| `finance` (MFA) | membership plans (price-list mapping is a pricing decision) | `engagement.membership_plan.manage` (privileged) |
| Queue display screen (`device`, claims `device_kind = queue_display`) | reads the public queue board of one centre (token numbers only, P0) | [CR-C16-002] `engagement.queue.board_read` only |
| `engagement` system actor (worker) | event consumers, projections, OTP sending, self-registration, payment-intent creation, reminders, no-shows | declared in the worker manifest (02-CV §2.3; 02-TRD §9.3) |

## 3. Problems this chunk solves

| # | Problem | Evidence |
|---|---|---|
| P-1 | Patients phone the lab to ask "is my report ready?"; the client wants real-time sample status in an app | 00 §3 item 5; 00 B3 |
| P-2 | Phone numbers are shared inside families and recycled by telcos; "log in with your phone, see every report for that phone" leaks health data | 06-GLOSSARY "Patient" ("families share phones"); Privacy Act s.12(4) (04 L17) |
| P-3 | Walk-in crowding at collection centres; no visible queue | 00 §3 item 13; R01 §1.7 ("A token display is trivial") |
| P-4 | Follow-up tests are forgotten; labs want reminders | 00 §3 item 11; R01 §1.7 ("follow-up test reminder = cron over Follow Ups data") |
| P-5 | Booking without capacity control overloads centres and home-collection phlebotomists | 00 §3 items 11, 13; REQ-SEC-100 |
| P-6 | Paying a due to release a held report requires a desk visit | 00 D1 (hold-till-paid); 00 A9 (eSewa/Khalti) |
| P-7 | Mobile apps leak PHI through lock-screen notifications, plaintext token storage, screenshots and stale binaries | REQ-SEC-102, 106, 109, 113 |
| P-8 | Membership/loyalty is requested but a full points engine is scope creep | 00 §3 item 12; R01 §1.7 row "Loyalty…: KEEP-LATER (Phase 3), minimal" |

## 4. Scope

### 4.1 In scope (mapped to the client baseline)

| ID | Item | Client baseline (00) | 04 / research | Phase |
|---|---|---|---|---|
| IS-01 | Patient app sign-in by phone OTP (custom OTP, 04 A9 values; SMS via `NotificationPort`); sessions held by C2 | §1 handwritten "Patient APP"; §3 item 5 | 04 A9, A5, A15; REQ-SEC-069/070/102 | 3 |
| IS-02 | Family profiles: link lab patient records to an account by (a) lab-issued linking code, (b) report link token, (c) self/child self-registration; suspension and revocation rules | §3 item 5; glossary "Patient" | REQ-SEC-005/006; 04 L17 | 3 |
| IS-03 | Orders list + real-time sample status (patient-friendly stages) | §3 item 5 "real-time sample status"; B3 | R01 §1.2 (status backbone); 04 S5 (polling chosen, D-RT) | 3 |
| IS-04 | Released reports list + PDF download | §3 item 5 "report download PDF" | 03-IC §4.7; REQ-SEC-034/035 | 3 |
| IS-05 | Smart-report view in the app (approved summaries only; source = C6 report-version snapshot via `ReportingPort`, 08 A2.3) | §1 "Smart AI report"; §3 items 5, 8 | 04 R8; 03-IC §4.7; 08 A2.3 | 3 (needs C14, Phase 2–3) |
| IS-06 | Pay order due in the app via the C15 hosted redirect | §2 A9; §2 D1 | 04 P2–P7; C15 US-PG-11 | 3 (needs C15, Phase 1.5–2) |
| IS-07 | In-app notification inbox (no PHI); **no push** until B11 is approved | §3 item 5 | REQ-SEC-106; 04 §11, B11 | 3 |
| IS-08 | Appointment slots (templates, blackouts, capacity) for centre visits and home collection | §3 items 11 ("appointment management"), 13 ("appointment slot management") | 04 §12 "appointment slots" Phase 3 | 3 |
| IS-09 | Bookings from the app and by staff (phone bookings); cancel; reschedule; check-in; no-show; completion; events to C4/C17 | §3 items 5 ("test booking"), 11 | 03-IC §3.22/§3.24; X5 | 3 |
| IS-10 | Queue tokens per centre (issue, call, serve, transfer, skip) and a queue display board (token numbers only) | §3 item 13 ("Queue management") | 04 §12 "queue token display" Phase 2 | 2 |
| IS-11 | B2C reminders: manual staff reminders, follow-up reminders from approved smart summaries, booking reminders; SMS via `NotificationPort` + in-app inbox | §3 item 11 ("B2C patient reminder management") | 04 §12 "B2C follow-up reminders" Phase 2; REQ-SEC-005 | 2 (booking reminders 3) |
| IS-12 | Minimal membership: plans mapped to a C3 price list, enrolment by staff, membership card (number + QR) in the app, active membership for C4 via `EngagementPort.getActiveMembership` (08 R25) | §3 item 12 ("membership card") | 04 §12 "loyalty/membership (minimal)" Phase 3; R01 §1.7 row 35 ("membership price-list"); glossary "Price list" | 3 |
| IS-13 | Enquiries (patient → lab message thread; staff inbox) | §3 item 11 ("enquiry management") | R01 §1.7 keeps CRM out; this is a minimal inbox | 3 |
| IS-14 | Bookable catalogue (which orderables the app may book; indicative price) | §3 item 5 | REQ-SEC-046 (server price authority stays C4) | 3 |
| IS-15 | Account deletion in the app (keeps lab records) | — (app-store practice, UNVERIFIED as a store rule) | REQ-SEC-139 | 3 |
| IS-16 | App version enforcement, app config | — | REQ-SEC-113; 03-IC §8 `engagement.app_version_unsupported` | 3 |

### 4.2 Out of scope (explicit)

| Item | Why / where it lives |
|---|---|
| CRM suite, campaign tools | 04 §12 DROP ("CRM (export + external tool)") |
| Kiosk (self-service token/registration terminal) | 04 §12 DROP. Queue tokens are issued by staff only. |
| Generic patient document vault (prescription slips, old report scans) | 04 §12 DROP ("generic patient document vault"); 00 §3 item 11 partly. TRF upload stays C4 at the desk. |
| Reward points engine | R01 §1.7 row "Loyalty…": "Full points engines: DROP unless client insists post-launch" |
| Prepaid wallet / stored value | DECISION: R01 §1.7 mentions "prepaid wallet", but holding patient money is a billing liability with IRD/ledger implications (04 L5, P1) that C4 owns; not built. Reversible by CR + founder approval |
| Discount coupons | DECISION: 04 §12 "minimal" and R01 §6 row 35 ("membership price-list") do not include coupons; a coupon needs C4 registration-page changes (C4 owns that page, CM §5.1) and a redemption ledger. Deferred; proposal CR-C16-021 recorded, not built |
| Membership fee collection | DECISION: no invoiceable non-test item exists in C3/C4 contracts; v1 enrolment records the membership only. Any fee is billed by the lab outside C16 |
| B2C dashboard / MIS | Owner **C8** (00 §3 item 11 "B2C dashboard"; 08 A19 D-123): delivered as a later additive C8 CR after C16 ships, with booking/queue tiles from `engagement.v_pub_*`. The views exist (03-IC §6.9); they have no consumer until that C8 CR (08 A2.7) |
| Front-desk management (registration) | C4 (00 §3 item 13 "front desk management") |
| Patient web portal | C6 (`apps/portal`, Phase 1) |
| Native structured-results screen | DECISION: the PDF is the authoritative report; showing results natively would require opening `lab` tables to patient actors. Smart summary + PDF only |
| Patient self check-in from the app | DECISION: remote check-in lets a user grab a queue position from home; staff check in on arrival |
| Push notifications (FCM/APNs) | **BLOCKED B11**: push transits Google/Apple servers (REQ-SEC-106) — a foreign touchpoint not in 04 §11; Firebase SDK is a foreign SaaS SDK (02-CV §15.3). Default: in-app inbox + SMS/WhatsApp through C6 |
| Supabase Realtime in the app | DECISION D-RT (02-TRD §4.6): polling; Realtime is a CR candidate after 04 D3 is proven and claims are available to Realtime |
| Certificate pinning | DECISION D-PIN (07-SECURITY §2): not in v1 for the patient app (REQ-SEC-104 allows; trade-off documented) |
| Gateway mobile SDKs | C15-PRD §4.2: C16 uses the hosted redirect |
| Fonepay in the app | BLOCKED B8 (C15 returns `payments.gateway_not_available`) |
| Phlebotomy app, home visits, routes | C17 |
| Tenant-picker app ("one app for all labs") | DECISION D-STORE: one build flavour per tenant in v1 |
| Sharing a report with a doctor from the app | not requested; C6 delivers to referrers (00 D4) |

## 5. Phasing and deliverable groups

| Group | Contents | 04 §12 phase | Depends on (contracts only) |
|---|---|---|---|
| G-QUEUE | IS-10 | 2 | C0, C2 (`IdentityPort`), CR-C16-005 (display resolver) |
| G-REMIND | IS-11 manual + follow-up | 2 | `NotificationPort` (C6), C6 smart-summary snapshot via `ReportingPort` for follow-ups (08 A2.3) |
| G-APP | IS-01…IS-07, IS-13, IS-15, IS-16 | 3 (01 §1 wave order; B1 closed, 08 A11.2) | C2 CR-C16-004, C4 CR-C16-007, C6 CR-C16-008/009/010, C14, C15 |
| G-BOOK | IS-08, IS-09, IS-14, booking reminders | 3 | C4 consumer of `engagement.booking.*`, C17 consumer, `CatalogPort` |
| G-MEMB | IS-12 | 3 | C3 `CatalogPort.getPriceListStatus` CR-C16-023 (08 A24.1), C4 CR-C16-014 |

Build order inside C16 (06-IMPLEMENTATION-PLAN): G-QUEUE and G-REMIND first (no app needed), then G-BOOK staff side, then G-APP.

## 6. Key decisions summarised (details in 02-TRD / 07-SECURITY)

### 6.1 D-LINK — how an app account is matched to lab patient records (security-critical)

An **account** = one verified phone number in one tenant. An account sees clinical data only through **links** (`engagement.account_patient_links`), one per lab patient record (`frontdesk.patients.id`). A link is created by exactly one of:

| Method | Proof required (all of) | History visible | Typical use |
|---|---|---|---|
| `link_code` | (1) staff issued a single-use linking code for that patient record after an in-person identity check and recorded consent (relationship, who consented, consent text version); (2) the code is redeemed by an account whose OTP-verified phone equals the phone the code was bound to at issuance (default: the patient's phone on record); (3) code unexpired (default 72 h) and unused | full history | first-time app user who visits a centre |
| `report_link` | (1) a valid, unexpired, unrevoked C6 report link token sent to a patient recipient by SMS/WhatsApp; (2) the account's OTP-verified phone equals the destination the link was sent to (checked by C6, CR-C16-008) | only reports released at or after the redeemed report's release time (`visible_from`) | user who already got a WhatsApp/SMS report link |
| `self_registered` | the account creates a **new** patient record for itself (relationship `self`) or for a minor child (`child`, age below tenant `minor_age_years`) through C4 (CR-C16-007); it never matches or returns an existing record | none before creation (the record is new) | booking before the first visit |

Rules: phone match alone never creates a link; a matched phone without a code or report link yields nothing (no oracle, no "we found 3 patients"). Links are suspended automatically when the patient record's phone changes away from the phone it had at link time, when the record is merged or anonymised in C4, or when the account is dormant > `dormant_after_days` (default 180). Rationale and threat analysis: 07-SECURITY §3.

### 6.2 Other decisions

| ID | Decision | Where |
|---|---|---|
| D-AUTH | Custom phone OTP in `engagement` (not GoTrue phone OTP): SMS must go through `NotificationPort` (CM §5.1 "nobody else talks to providers"); 04 A9 values enforced in our code; GoTrue OTP defaults UNVERIFIED (04 A9). Patient sessions are C2 `identity.sessions` of kind `patient`; the app holds only an opaque session token in `flutter_secure_storage` (04 A15) and a ≤1 h access JWT in memory (04 A5) | 02-TRD §4.1 |
| D-PROJ | Patient requests read only `engagement.*` tables; order/specimen/report/balance data is projected there by the engagement system actor from events and published views (same pattern as C13-TRD §3.2) | 02-TRD §4.4 |
| D-RT | Polling (30 s on status screens in foreground), not Realtime | 02-TRD §4.6 |
| D-PAY | App payment intents are created by a worker task as the system actor (C15 reads C4 order/balance data that patient actors cannot see); the app polls | 02-TRD §4.7 |
| D-BOOK | Bookings are confirmed in the creating transaction (capacity reserved atomically, patient id known from an active link) and emit `engagement.booking.confirmed.v1` in the same transaction | 02-TRD §4.8 |
| D-PUSH | No push (B11); in-app inbox + C6 SMS/WhatsApp | 02-TRD §4.9 |
| D-PIN | No certificate pinning in the patient app v1 | 07-SECURITY §2 |
| D-STORE | Android first, then iOS, one codebase; one app flavour per tenant; app-store developer accounts, listings and signing keys are client-owned (founder decision 2026-11-06, research/04 §13); keys held in the C1 secret store | 02-TRD §2.3 |
| D-QDISP | Queue display authenticates with a per-screen display token (HttpOnly cookie on the staff-web origin, route group `(display)`), never with a staff session | 02-TRD §4.10 |

## 7. User stories and acceptance criteria

Each AC is a test (05-DoD §2). Synthetic data only (02-CV §11.2): tenant A "Synthetic Lab Alpha" (`tenant_code` `syn_alpha`), tenant B "Synthetic Lab Beta" (`syn_beta`; codes match C0 `^[a-z][a-z0-9_]{2,31}$`); phone numbers use C0's synthetic non-Nepali prefix (C0-TRD §3.5) — shown below as `+99X…` and the tenant setting `allowed_phone_prefixes` is set to that prefix in non-prod. "Account A1" = account of phone P1 in tenant A.

### US-EN-01 Sign in with phone OTP
As a patient, I want to sign in with my mobile number and a one-time code, so that I don't need a password.
1. Given tenant A's app flavour and phone P1 within `allowed_phone_prefixes`, When the app calls `requestPatientOtp`, Then `202` returns `{challenge_token, expires_at, resend_after_seconds}`, a challenge row exists with status `pending`, and a task `engagement.send_login_otp` is enqueued; the response is byte-identical in shape whether or not P1 already has an account.
2. Given the task runs, Then `NotificationPort.sendSms` is called once as the system actor with `recipient {kind:'phone_otp', phoneE164:P1}`, `purpose:'otp'`, `templateCode:'engagement.login_otp'`, params only `{otp_code, lab_name, minutes}`, and the challenge's `code_ciphertext` is nulled after the call.
3. Given the code is 6 digits from a CSPRNG and TTL ≤ 600 s (04 A9), When the correct code is posted to `verifyPatientOtp` within TTL, Then `200` returns `{session_token, access_token, access_expires_at, session_expires_at, account}`; a new account (first sign-in) or the existing account is used; the challenge becomes `verified` and cannot be verified again.
4. Given 5 wrong codes for one challenge, Then the 5th returns `401 auth.otp_attempts_exhausted` [CR-C16-003] and a 6th attempt with the correct code also fails; each wrong attempt's `attempts` increment and its `auth.otp_failure` access-log row persist although the request returns `401` (`ctx.commitOnError()`, 08 A19 P-42).
5. Given an expired challenge, When the correct code is posted, Then `401 auth.otp_invalid`.
6. Given 3 OTP requests for P1 within one hour, When a 4th arrives, Then `429 common.rate_limited` with `Retry-After` and no SMS is queued (04 A9, 04 §4).
7. Given a phone outside `allowed_phone_prefixes`, Then `400 common.validation_failed` (path `/phone_e164`) and no SMS.
8. Given tenant A's daily OTP cap is reached, Then requests return `429 common.rate_limited` and the alert `EngagementOtpDailyCapReached` fires.
9. Given a log scan after these tests, Then no phone number, OTP, challenge token, session token or JWT appears in logs (02-CV §9.2).

### US-EN-02 Session lifetime, refresh, app lock, logout
1. Given a signed-in app, Then the session token is stored only via `flutter_secure_storage` and the access JWT only in memory (04 A15, REQ-SEC-102); no token exists in shared preferences, files or SQLite (device-dump test).
2. Given the access JWT expired, When an API call returns `401 auth.token_expired`, Then the app calls C2 `resolvePatientSession` [CR-C16-004] once, retries the original call once, and never loops.
3. Given the patient session is past its idle (14 days) or absolute (30 days) limit [DECISION, CR-C16-004], Then refresh returns `401 auth.session_expired` and the app wipes secure storage and shows the sign-in screen.
4. Given the app was in the background > 5 minutes [CONV, same value as 04 A16], When the user opens any PHI screen (orders, reports, smart report, profiles), Then the device biometric/PIN prompt (app lock) is required; if the device has no screen lock, the app requires a new OTP sign-in instead (REQ-SEC-110).
5. Given logout, Then the app calls `logoutPatientSession`, deletes the session token, clears in-memory state and deletes temporary PDF files; the old session token then fails with `401`.
6. Given the account is deleted, Then the next API call returns `401 auth.session_expired`; given staff revoke a link (US-EN-06 AC6), Then the session continues and reads of that profile return `404 common.not_found`.

### US-EN-03 Link a profile with a lab-issued linking code
As front desk, I want to give a patient a one-time code so that their app shows their reports, and nobody else's.
1. Given front desk with `engagement.link.issue` opens "Patient app access" for patient X (synthetic), records identity check method `photo_id`, relationship `self`, consented by `patient`, and binds to the patient's phone on record P1, When `issueLinkCode` is called, Then `201` returns the code once (format `XXXXX-XXXXX`, Crockford base32, 50 bits), `expires_at = now + link_code_ttl_hours`, and the DB stores only `code_hmac` and `bound_phone_hmac`; an `access_log` entry `link_code.issue` exists [CR-C16-019; renamed in 08 §4.4].
2. Given account A1 (phone P1) redeems the code, Then `201` creates link `{method:'link_code', relationship:'self', status:'active', visible_from: null}`, the code becomes `redeemed`, and a `engagement.backfill_link` task projects X's orders and reports.
3. Given account A2 (phone P2 ≠ P1) redeems the same valid code, Then `422 engagement.link_code_invalid` [CR-C16-003] and nothing changes; the response is identical to an unknown code.
4. Given a code redeemed once, When any account redeems it again, Then `422 engagement.link_code_invalid` (except A1 again → `200` returning the existing link, idempotent).
5. Given 5 failed redemptions by one account within 1 hour [CONV], Then further attempts return `429 common.rate_limited` for that account, and the alert `EngagementLinkRedeemFailures` evaluates (each failed attempt's counter increment persists although it returns `422`, `ctx.commitOnError()`, 08 A19 P-42).
6. Given the patient is a minor and the guardian is present, When staff choose relationship `child`, consented by `guardian`, bind phone "other" = the guardian's phone P3, Then redemption succeeds only for the account of P3.
7. Given a staff member issues more than 50 codes in one business day [CONV], Then the alert `EngagementLinkIssueVolume` fires (insider misuse, REQ-SEC-045).
8. Given the account already has `max_profiles_per_account` (default 8) active links, Then `409 engagement.link_limit_reached`; given patient X already has `max_accounts_per_patient` (default 3) active links, Then also `409 engagement.link_limit_reached`.

### US-EN-04 Link a profile from a report link
1. Given account A1 (phone P1) and a C6 report link token sent by SMS to P1 for patient X's report R (released at T), When the user pastes the link into "Add from report message", Then the engagement service calls `ReportingPort.redeemPortalLinkForApp({linkToken, phoneE164:P1})` [CR-C16-008] and creates link `{method:'report_link', visible_from:T}`; X's reports released at or after T are listed; older ones are not.
2. Given the same link but account A2 (phone P2), Then `422 engagement.link_code_invalid` (C6 returns `reporting.link_invalid`, mapped to the identical response).
3. Given an expired or revoked link, Then `422 engagement.link_code_invalid`.
4. Given a later linking code is redeemed for the same patient by A1, Then the link's `visible_from` becomes null (full history) and its method becomes `link_code` (also when the link was `suspended`: it becomes `active`).
5. Given the pasted text is not a portal `/r/` URL of this environment's portal origin, Then `400 common.validation_failed` and no port call.
6. Given A1 already has a `self` profile, When a report link for another patient is redeemed, Then the new profile's relationship is `other` (changeable later); the same applies to a desk code issued with relationship `self`.

### US-EN-05 Self-registration (self or child)
1. Given account A1 with no profiles, When the user submits "Register myself" `{full_name, sex, birth_on, consent_text_version = settings.app_consent_text_version}`, Then `202` returns a self-registration in status `queued`, and the task `engagement.create_self_patient` calls `FrontdeskPort.createSelfRegisteredPatient` [CR-C16-007] as the system actor with `phoneE164 = P1` and consents from the form; on success the link `{method:'self_registered', relationship:'self', visible_from: now}` becomes active.
2. Given C4 reports `duplicateSuspected: true`, Then the link is still created to the **new** record (never to the existing one) and the app shows "You can link earlier visits with a code from the lab".
3. Given relationship `child` and an age ≥ `minor_age_years`, Then `400 common.validation_failed` (path `/birth_on` or `/age_years`).
4. Given a consent_text_version that differs from the current setting, Then `400 common.validation_failed`; given the tenant has no app consent text configured, Then `403 common.feature_disabled` and the screen explains that registration happens at the lab.
5. Given the task fails after retries, Then the self-registration becomes `failed` with `failure_code` and the app shows a retry option; no link exists.

### US-EN-06 Link safety: suspension, revocation, removal
1. Given link L (method `link_code`) was created when patient X's record phone was P1, When the nightly reconcile sees X's record phone is now P4, Then L becomes `suspended` (`phone_mismatch`), X disappears from A1's profiles list ("Access paused — ask the lab for a new code") and every read of X's data returns `404 common.not_found`.
2. Given C4 reports X `status = merged` or `anonymised` [CR-C16-007], Then L becomes `suspended` with `patient_merged` / `patient_anonymised`.
3. Given account A1 has not signed in for > `dormant_after_days`, Then all its links become `suspended` (`dormant`) at the next reconcile; a new link code or a report link redeemed after the suspension reactivates only the link it proves.
4. Given the patient removes profile X in the app, Then L becomes `revoked` (`revoked_by_kind: account`) and projections of X for A1 are no longer readable.
5. Given a suspended link, When any endpoint is called with X's ids, Then `404 common.not_found` (indistinguishable from never linked).
6. Given front desk with `engagement.link.revoke` revokes L with reason `patient_request`, Then L becomes `revoked`, an `access_log` entry `app_link.revoke` (08 §4.4) exists, and A1 sees X removed on next refresh.
7. Given A1's link L is suspended, When the patient app attempts to set it `active` or widen `visible_from` by a direct update, Then the database refuses (`immutable_row`, probe P-L9); only a new proof (US-EN-03/04) reactivates it.

### US-EN-07 Orders and real-time sample status
1. Given X is linked to A1 and C4 registered order O for X with 2 specimens, When `lab.specimen.status_changed.v1` events arrive (`ordered`→`collected`→`received`), Then within 60 s (p95, success metric M-3) `listMyOrders` shows O with stage `sample_collected` then `in_lab`, and `getMyOrder` lists each specimen's type and stage.
2. Given the events arrive out of order (seq 3 before seq 2), Then the projection keeps seq 3's state (02-CV §7.4).
3. Given the same event is delivered twice, Then exactly one projection change and one inbox row exist.
4. Given `lab.specimen.rejected.v1` with `recollection_required: true` for O, Then O's stage is `recollection_needed`, and A1 gets an in-app notification of kind `sample_recollection` without the rejection reason.
5. Given an order whose `source = partner_manifest` and tenant setting `show_partner_orders = false`, Then it is not projected.
6. Given an order registered before link L's `visible_from`, Then it is not listed.
7. Given account A2 (not linked to X) calls `getMyOrder(O)`, Then `404 common.not_found`.
8. Given the status screen is in the foreground, Then the app polls `getMyOrder` every 30 s [CONV] and stops polling in background.

### US-EN-08 Reports list and PDF download
1. Given `reporting.report.released.v1` for report R v1 of order O (patient X linked to A1), Then `listMyReports` shows R v1 `valid` with `released_at` and panel names; a notification `report_ready` exists for A1.
2. Given R v2 is released (amended), Then v1 shows `superseded` only when `include_superseded=true`, and the default list shows v2.
3. When A1 calls `downloadMyReport(R, 2)`, Then the handler checks the projection row, calls `ReportingPort.openReleasedReportFile` under the patient context [CR-C16-008 extending CR-C13-005], streams `application/pdf` with `Content-Disposition: attachment`, `Cache-Control: no-store`, and writes an `access_log` entry `report.download`.
4. Given 20 downloads by one link within an hour, Then the 21st returns `429 common.rate_limited` (tier `report_download`, 04 §4).
5. Given A2 requests R, Then `404 common.not_found`.
6. Given the app opens the PDF, Then it renders it in-app from a temporary file in app cache that is deleted when the viewer closes and on logout; "Save/Share" leaves the app only after an explicit confirmation dialog.

### US-EN-09 Smart report view
1. Given the released report's `smartSummaryAvailable = true` and tenant setting `smart_report_in_app = true`, When the consumer processes the release, Then task `engagement.fetch_smart_summary` reads the approved `SmartSummary` snapshot C6 stores on the report version (written at Regenerate, reason `smart_summary_added`), read through `ReportingPort` (08 A2.3; field per 03-IC §4.7 — currently `ReleasedReportFile.smartSummary`, placement [CONV] in 03) as system and stores it **only if** present and `status = 'approved'`. C16 never calls `SmartReportPort` (08 A2.3).
2. Given a stored approved summary, When A1 opens it, Then the app shows health score, panel tiles, deranged parameters, advice, follow-ups and the disclaimer exactly as returned (no client-side wording), and an `access_log` entry `smart_summary.view` [CR-C16-019] exists.
3. Given the report version carries no smart-summary snapshot (none attached by C6, feature off) or a non-`approved` status, Then no summary is stored and the app hides the smart tab.
4. Given a newer report version, Then the summary for the older version is shown as superseded and the new one is fetched.

### US-EN-10 Pay a due in the app
1. Given order O of linked patient X has `balance_due_paisa = 225000` in the projection, When A1 calls `createPaymentRequest(O, {gateway:'khalti'})` with an Idempotency-Key, Then `202` returns a payment request `queued`; the task `engagement.create_payment_intent` calls `PaymentProviderPort.createIntent` as the system actor with `returnUrl = cancelUrl = <PORTAL>/app/payments/<payment_request_id>/done`.
2. When the app polls `getPaymentRequest` (every 2 s up to 30 s [CONV]), Then it receives `ready` with `action {kind:'redirect', url}` (Khalti) or `{kind:'form_post', launchUrl}` (eSewa) and opens it in the system browser.
3. Given the gateway returns to the app link, Then the app shows "Paid" only after `getPaymentRequest` reports `completed` because the `engagement.refresh_payment_request` task (system actor) saw `PaymentProviderPort.getIntent` return `settled` (REQ-SEC-059; C15 F-04; 08 R8 — the patient context never calls the port); the `outcome` query parameter is ignored.
4. Given `payments.nothing_due`, `payments.intent_open_exists`, `payments.amount_not_supported` or `payments.gateway_not_available`, Then the request becomes `failed` with that `failure_code` and the app shows the matching message.
5. Given the order is not in A1's projections, Then `404 common.not_found` and nothing is enqueued.
6. Given the client sends an amount field, Then `400 common.validation_failed` (the schema declares none — REQ-SEC-046).

### US-EN-11 In-app notifications without PHI
1. Given any notification row, Then the stored row carries only `kind`, `entity_type`, `entity_id`, `patient_id` and `route_id` (the DTO exposes `profile_id` instead of `patient_id`) — no text, names, test names or results; the app renders text from local message keys.
2. Given push is not approved (B11), Then no push SDK is in the binary (dependency check) and the app refreshes the inbox on launch, resume and pull-to-refresh.
3. Given `markNotificationsRead` with ids of another account mixed in, Then only own ids change; foreign ids are reported per-id `common.not_found`.

### US-EN-12 Book a centre visit with slots
1. Given centre C1 has a template Mon–Fri 07:00–11:00 local, 15-minute slots, capacity 3, horizon 14 days, lead 120 min, When A1 lists slots for C1, Then only future slots ≥ now + lead and ≤ horizon, outside blackouts, with remaining capacity > 0 are returned.
2. When A1 books slot S for profile X with orderables [O1] from the bookable catalogue, Then in one transaction `slot_occupancy.booked` increases by 1, a booking `confirmed` with `booking_no` (`BK{yy}{seq:6}`) exists, and `engagement.booking.confirmed.v1` is published with `booking_kind:'centre_visit'`, `patient_id = X`, `branch_id` of C1, `orderable_ids:[O1]`.
3. Given 3 bookings already hold S, When a 4th is attempted (including 20 concurrent attempts for the last place), Then exactly the available number succeed and the rest get `409 engagement.slot_unavailable`.
4. Given the same Idempotency-Key is replayed, Then the same booking is returned and no second event is published.
5. Given an orderable not in the active bookable catalogue, Then `422 engagement.orderable_not_bookable`; given a sex-restricted package not matching X's sex, Then also `422 engagement.orderable_not_bookable`; given X's sex is not known to C16 (link `sex_snapshot` NULL), Then the restriction is not enforced and the app shows "Suitability is confirmed at the lab".
6. Given X already has `max_active_bookings_per_profile` future confirmed bookings, or A1 created `max_bookings_created_per_account_day` bookings today, Then `429 engagement.booking_limit_reached` (REQ-SEC-100).
7. Given a slot in the past or beyond the horizon, Then `422 engagement.slot_outside_window`.
8. Given the booking succeeds, Then a task sends `booking_confirmation` SMS through `NotificationPort` (consent-gated; params `{lab_name, datetime, booking_no}`), and the app shows the indicative price with the text "Final price is confirmed at the lab".

### US-EN-13 Home-collection booking
1. Given tenant setting `home_collection_centre_id = H` with a `home_collection` template, When A1 books with address D (owned by A1, for profile X), Then the event carries `booking_kind:'home_collection'`, `centre_id:H`, `home_address_id:D`; the address text is not in the event.
2. Given no address, Then `422 engagement.address_required`.
3. Given C17 calls `EngagementPort.getHomeAddress({homeAddressId, purpose:'home_visit'})` as its system actor or an assigned dispatcher (08 R25), Then it gets the address of D for that booking only.

### US-EN-14 Cancel, reschedule, no-show, completion
1. Given a confirmed booking more than `booking_cancel_cutoff_minutes` (default 60) before start, When A1 cancels, Then status `cancelled` (reason `patient_request`, by `patient`), `slot_occupancy.booked` decreases by 1, and `engagement.booking.cancelled.v1` is published (with `order_id` when known).
2. Given less than the cutoff, Then `409 engagement.booking_not_cancellable`.
3. Given reschedule to slot S2, Then the old booking is cancelled and a new one confirmed in one transaction (two events); if S2 is full, nothing changes (`409 engagement.slot_unavailable`).
4. Given a `centre_visit` booking, `auto_no_show = true` and slot end + `no_show_grace_minutes` passed while C4's order for the booking is still `pre_registered`, Then the cron cancels with reason `no_show`, `cancelled_by_kind: system`, publishes the event and leaves `slot_occupancy.booked` unchanged.
5. Given `frontdesk.v_pub_order_status` shows a `centre_visit` booking's order `registered` (or later), Then the reconcile job sets the booking `completed` and stores `order_id`; a no-show is never applied afterwards.
6. Given a cancellation event is retried by the outbox, Then consumers see one logical fact (idempotency key `<booking_id>:cancelled`).
7. Given a `home_collection` booking, When `homecollection.collection.synced.v1` arrives with its `booking_id` (08 A19 D-120), Then the booking becomes `completed` with that event's `order_id`; a `home_collection` booking is never auto-no-showed and is cancelled only by staff.

### US-EN-15 Staff phone booking and check-in
1. Given front desk at centre C1 with `engagement.booking.manage` selects patient X (found through C4's patient search) and a slot, When `createBookingForPatient` is called, Then the booking is `confirmed` with `created_via:'staff'`, `account_id` absent, and the event is published.
2. Given a front desk user scoped to C1 lists bookings, Then bookings of C2 are not returned; `getBooking` of a C2 booking returns `404 common.not_found`.
3. When the patient arrives and staff call `checkInBooking` with `issue_token: true` and queue Q, Then the booking becomes `checked_in` and a queue token linked to the booking is issued in the same transaction.

### US-EN-16 Slot templates and blackouts
1. Given `engagement.slot.manage`, When a template with `end_local ≤ start_local`, `slot_minutes ∉ [5, 240]` or `capacity ∉ [1, 100]` is saved, Then `400 common.validation_failed`.
2. Given two active templates of the same centre and booking kind overlap on a weekday and time, Then `400 common.validation_failed` (path `/start_local`).
3. Given a capacity reduction below already-booked counts for future slots, Then the save succeeds, the affected slots are flagged overbooked in the staff list, and no booking is cancelled automatically.
4. Given a blackout over existing bookings, Then the response lists the affected bookings count and they remain confirmed until staff cancel them (reason `lab_unavailable`).

### US-EN-21 Queue tokens (Phase 2)
1. Given queue "A — Registration" at C1, When front desk issues a token, Then `A-001` is the first token of the business day (tenant timezone), the next is `A-002`, and no two tokens of the same queue and day share a number under 20 concurrent issues.
2. When staff at counter 2 call next, Then the oldest `waiting` token with `priority` first, then by issue time, becomes `called` with `counter_id`, and the board version increases.
3. Given `recall`, Then `call_count` increases and the board highlights it again (recall allowed while `call_count < 9`). Skip is manual (Q6): the console suggests Skip after 3 calls [CONV]; given `skip`, Then status `skipped`.
4. Given `transfer` to queue B (sample collection), Then a new token in queue B is issued (status `waiting`, `transferred_from_token_id` set) and the old one becomes `transferred`.
5. Given the end of the business day, Then waiting/called tokens become `expired` (cron) and new numbering starts at 1 next day.
6. Given a token row, Then it contains no patient name or phone; tokens linked to a booking hold only `booking_id`.

### US-EN-22 Queue display (Phase 2)
1. Given `engagement.queue.manage` on the TV PC's browser, When staff pair a display for C1, Then the BFF sets an HttpOnly cookie with a 256-bit display token (stored as SHA-256), and staff can log out of the staff session without affecting the display.
2. Given the display page polls `getQueueBoard` every 5 s [CONV] with `If-None-Match`, Then unchanged boards return `304`; changes appear within 10 s (p95).
3. Given the display token, When it calls any other endpoint, Then `403 auth.forbidden`.
4. Given staff revoke the display, Then the next poll returns `401 auth.unauthenticated` and the page shows "This screen is no longer paired".
5. Then the board shows only token labels, counter names and queue names — never patient data.

### US-EN-23 Manual reminders (Phase 2)
1. Given front desk creates a reminder for patient X `{reason_code:'follow_up_test', due_at}`, When `due_at` arrives, Then the dispatcher calls `NotificationPort.sendSms` as system with `templateCode:'engagement.follow_up_reminder'`, params `{lab_name, datetime}` only, and the reminder becomes `sent` (or `suppressed` with the port's suppression status).
2. Given X has an active link to an account, Then an in-app notification `follow_up_reminder` is also created.
3. Given X's account set `reminders_opt_out = true`, Then no SMS is sent (status `suppressed`, `failure_code: opted_out`), and the in-app notification is still created.
4. Given a cancelled reminder, Then nothing is sent.

### US-EN-24 Follow-up reminders from smart summaries
1. Given `auto_follow_up_reminders = true` and an approved smart summary with `followUps [{ruleId, suggestedTestCode, intervalDays:90}]`, Then one reminder per follow-up is scheduled at `released_at + 90 days − follow_up_reminder_lead_days`, `source:'smart_report'`, idempotent on `(kind, source_ref_id)`.
2. Then the message never includes `suggestedTestCode` or the text (REQ-SEC-070; 04 R6).
3. Given the setting is false (default), Then no reminder is scheduled automatically; staff see the suggestion on the patient's reminder screen and may create one.

### US-EN-25 Booking reminders
1. Given a confirmed booking and `booking_reminder_hours_before = 24`, Then one `booking_reminder` SMS is sent between 24 h and 23 h before `slot_start` (hourly scheduler), and none for bookings created less than 24 h ahead.
2. Given the booking is cancelled before the send, Then the reminder is cancelled.

### US-EN-26 Bookable catalogue
1. Given `engagement.bookable_item.manage`, When staff mark orderable O1 bookable for `centre_visit`, Then the server fetches name and kind via `CatalogPort.getTest/getPanel` and the indicative price via `CatalogPort.priceFor({context:{}, priority:'routine', at:now})` (tenant default), and stores a snapshot.
2. Given `catalog.changed.v1` [CR-C16-013] or the nightly sync, Then inactive orderables become non-bookable and prices are refreshed.
3. Given `catalog.no_price`, Then the item is saved with no price and the app shows "Price at the lab".

### US-EN-17 Membership (minimal)
1. Given `engagement.membership_plan.manage` (aal2), When a plan `{code:'GOLD', price_list_id: PL1, validity_days: 365}` is created, Then `CatalogPort.getPriceListStatus({priceListId: PL1})` must return `isActive: true` and `status: 'published'` [CR-C16-023, 08 A24.1] (unknown, inactive or unpublished → `400 common.validation_failed`).
2. Given front desk enrols patient X, Then a membership `active` with `card_no` `MB{yy}{seq:6}`, a 130-bit (26 Crockford base32 characters) `card_token` (≥ the 128-bit floor, by analogy to 04 A11), `valid_from`, `valid_to = valid_from + validity_days` exists; a second overlapping active membership → `409 engagement.membership_overlap`.
3. Given X is linked to A1, Then the app's membership card shows plan name, card number, validity and a QR encoding only the card token.
4. When front desk scans the QR (`lookupMembershipCard`), Then the membership and patient id are returned to users with `engagement.membership.read`, and an `access_log` entry `patient_membership.lookup` (08 §4.4) exists.
5. Given C4 calls `EngagementPort.getActiveMembership({patientId})` at registration [CR-C16-014; 08 R25], Then it gets `{membershipId, planCode, planName, priceListId?, validTo}` for X's active membership (or `undefined`).
6. Given `valid_to` passed, Then the daily job sets `expired`.

### US-EN-18 Enquiries
1. Given A1 creates an enquiry `{category_code:'report', subject, message}` (subject ≤ 120, message ≤ 2000), Then it is `open` and visible to staff with `engagement.enquiry.read`.
2. When staff reply, Then status `answered`, A1 gets an in-app notification `enquiry_reply`, and no SMS contains the reply text.
3. Given A2 calls `getMyEnquiry` of A1's enquiry, Then `404 common.not_found`.
4. Given A1 replies to an answered enquiry, Then status returns to `open`; given `closed`, Then reply → `409 engagement.enquiry_invalid_transition`.

### US-EN-19 Account deletion
1. When A1 confirms "Delete my app account", Then all sessions are revoked (C2), all links `revoked`, the account `deleted` with `phone_e164` nulled, future reminders for the account's in-app channel stop, and lab records in C4/C5/C6 are untouched.
2. Given the same phone signs in again later, Then a new account is created with no links.

### US-EN-20 App version and config
1. Given `min_app_version_android = 1.4.0` and a request with `X-Lims-App-Version: 1.3.9`, `X-Lims-App-Platform: android`, Then every engagement operation except `getPatientAppConfig` returns `426 engagement.app_version_unsupported` and the app shows the update screen (REQ-SEC-113).
2. `getPatientAppConfig` returns enabled features (the lab display name comes from the app flavour, 02-TRD §2.3 / E1), minimum versions, current consent text version and text, and enabled gateways; it never returns secrets.

## 8. Success metrics

| # | Metric | Target | How measured |
|---|---|---|---|
| M-1 | Cross-person data exposure through the app | **0** — every probe in 07-SECURITY §6 passes in CI | probes, pentest (REQ-SEC-043) |
| M-2 | OTP sign-in completion (request → verified) | ≥ 90% of challenges verified within 10 min [CONV target, ASSUMPTION about SMS delivery] | `lims_engagement_otp_*` metrics |
| M-3 | Projection lag (event `occurred_at` → read model updated) | p95 ≤ 60 s, p99 ≤ 5 min | `lims_engagement_projection_lag_seconds` |
| M-4 | Slot overbooking caused by races | 0 | concurrency tests; `lims_engagement_slot_conflicts_total` |
| M-5 | Queue board staleness | p95 ≤ 10 s | display poll metrics |
| M-6 | Booking no-show rate visible to the lab | reported weekly once the C8 B2C dashboard CR exists (08 A19 D-123; view `engagement.v_pub_booking_daily`, 03-IC §6.9); no target | view |
| M-7 | Phone calls "is my report ready" | qualitative client feedback after go-live; no number invented | — |

## 9. Dependencies (contracts only)

| Contract | Owner | Use | Status |
|---|---|---|---|
| `IdentityPort` + patient session/membership methods | C2 | authz; patient sessions | 03-IC §4.6 + **CR-C16-004** |
| `FrontdeskPort.getPatientDemographics`, `createSelfRegisteredPatient` | C4 | link-code phone binding; self-registration | 03-IC §4.3 + **CR-C16-007** |
| `frontdesk.v_pub_order_status` | C4 | order projection, booking completion | 03-IC §6.1 (C16 listed) |
| `billing.v_pub_order_balance`, `billing.balance.changed.v1`, `BillingPort.getOrderBalance` | C4 | due display | 03-IC §6.2, §3.5, §4.4 |
| `lab.specimen.status_changed.v1`, `lab.specimen.rejected.v1`, `lab.v_pub_specimen_timeline` | C5 | sample status | 03-IC §3.7, §3.8, §6.3 |
| `ReportingPort` (+ `openReleasedReportFile`, `redeemPortalLinkForApp`), `reporting.report.released.v1`, `NotificationPort` | C6 | reports, links, messages | 03-IC §4.7, §4.8, §3.17 + **CR-C13-005**, **CR-C16-008/009/010** |
| `CatalogPort` (incl. `getPriceListStatus`), `catalog.changed.v1` | C3 | bookable catalogue, plans | 03-IC §4.2 + **CR-C16-013** (event) + **CR-C16-023** (08 A24.1; replaces the view read) |
| ~~`SmartReportPort.buildSummary`~~ — not consumed since 08 A2.3; smart view and follow-ups use the C6 report-version snapshot via `ReportingPort` | C6 (snapshot of the C14 `SmartSummary` type) | smart view, follow-ups | 03-IC §4.7; 08 A2.3; `SmartSummary` display fields **CR-C16-015** (merged into CR-C14-001) |
| `PaymentProviderPort` (+ `getIntent`) | C15 | in-app payment — called only from the C16 worker as system actor (08 R8) | 03-IC §4.9 + CR-C15-001 |
| `EngagementPort` (implemented by C16) | C16 → C4, C17 | home address, active membership | 08 §4.14 / 03-IC §4.17 |
| Consumers of `engagement.booking.confirmed.v1` / `.cancelled.v1` | C4, C17 | pre-registration, home visits | 03-IC §3.22, §3.24 |
| C0 cores, `lims_ui`, `lims_api_client`, auth resolvers | C0 | everything | **CR-C16-001/005/006/016/017** |

## 10. Blocked and unverified items (build against the default)

| Item | Status | Default built meanwhile |
|---|---|---|
| Patient app phase / timing | Phase 3 per 01 §1 wave order (B1 closed, 08 A11.2) | G-QUEUE/G-REMIND (Phase 2) first; app behind tenant setting `app_enabled = false` |
| Client's own patient/phlebotomy app | open client question C-06 (08 A19 D-124) | The LIMS provider builds both apps (C16, C17) |
| Push notifications | **BLOCKED B11** (foreign touchpoint) | In-app inbox + C6 SMS/WhatsApp; no push SDK |
| Smart-report templates owner | **BLOCKED B14** (C14) | Smart tab hidden unless an approved summary exists |
| Fonepay | **BLOCKED B8** | Only eSewa/Khalti offered (from C15 availability) |
| Legal retention periods | **BLOCKED B15** | Ephemeral rows purged per 05-SCHEMA §9; records with tenant `retentionYears` (default 5) are kept until B15 closes and a C16 CR specifies `engagement.purge_by_retention` (05-SCHEMA §6.4) |
| Consent wording, minors, guardian rules | **BLOCKED B16** (Privacy Regulation 2077 content unverified; 04 L18) | `minor_age_years` default 18 (UNVERIFIED legal value), tenant-configurable; consent text configured per tenant by `tenant_admin` |
| WhatsApp channel availability | B9 (C6) | C6 falls back to SMS |
| App-store developer accounts, listing owner, store review | client-owned store accounts, listings and signing keys (founder decision 2026-11-06, research/04 §13); keys held in the C1 secret store | Internal test builds until the client's accounts are in place |
| GoTrue mechanism for patient tokens | UNVERIFIED (C2 T1 mapping) | C2 fake; requirement: no phone/email in GoTrue, no GoTrue-sent SMS |
| Self-hosted Realtime/Storage claims (04 D3) | UNVERIFIED | polling; PDFs via C6 port only |
| App-store rules (account deletion, data-safety forms) | UNVERIFIED | account deletion built anyway (IS-15) |
| Nepali mobile number plan validation | UNVERIFIED (C4-TRD §5 note) | E.164 pattern + `allowed_phone_prefixes` |
| Telco number-recycling period | UNVERIFIED | dormancy rule `dormant_after_days` = 180 [CONV] |
| Flutter libraries for routing, browser launch, biometrics, PDF render, QR render, app links | not pinned in 04/02 → **C0 pins** (CR-C16-017) | capability list in 02-TRD §2.2 |
