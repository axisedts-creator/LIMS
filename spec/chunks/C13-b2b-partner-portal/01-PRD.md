# C13 — B2B Partner Portal — 01 PRD

Status: DECISION draft, 2026-11-06. Phase 2 (04 §12: "B2B partner portal (web)"). Reads with `program/01-CHUNK-MAP.md` (01), `program/02-CONVENTIONS.md` (02-CV), `program/03-INTERFACE-CATALOG.md` (03), `research/04-consolidated-decisions.md` (04), `research/00-scope-baseline.md` (00).
Names of tables, endpoints, permissions, events and error codes match 03 and 02-CV. Anything not yet in the contracts is marked **(CR-C13-nnn)** and specified in `02-TRD.md` §15. The agent builds against the C0 fakes as if each CR were accepted.

---

## 1. Purpose

Labs that receive samples from other organisations (referring labs, hospitals, clinics, franchised collection points: "B2B partners", 06-GLOSSARY §A) need those partners to:
1. send a sample list (a **manifest**) before the box arrives,
2. ask the lab to pick the box up,
3. follow every sample through the lab,
4. download released reports,
5. see their agreed price list and their monthly statement,
6. keep their own list of referring doctors.

Today this happens by phone, paper and WhatsApp. C13 delivers it as a separate web application (`apps/partner`, separate origin — 01 §3; 03 §7 origin `partner`), plus the staff screens the lab needs to run the B2B intake, on top of the contracts other chunks already publish.

A B2B partner is a **customer of the tenant, never a tenant** (06-GLOSSARY §A). A partner user must only ever see the samples of their own organisation.

## 2. Users and roles

| Actor | Kind | Permissions (03 §11 and **CR-C13-002**) | Notes |
|---|---|---|---|
| Partner member | actor type `partner`, partner role `partner_member` | `partners.order.read`, `partners.manifest.submit`, `partners.report.read`, `partners.statement.read`, `partners.price_list.read` (03 §11 `fixed_actor_permissions.partner`) + `partners.pickup.request`, `partners.referrer.read` (CR-C13-002) + `identity.self.manage` (own sessions and MFA factors on the Account page; 08 A19 D-101) | Front-office staff of a clinic/hospital/lab. MFA offered, not forced. |
| Partner admin | actor type `partner`, partner role `partner_admin` | everything a member has + `partners.partner_user.manage` (privileged), `partners.referrer.manage` (CR-C13-002) | Manages the partner organisation's own users and referring doctors. **MFA (TOTP) mandatory** (DECISION; extends the 04 A4 rule "tenant-admin … roles" to the partner organisation's admin role, because a partner admin can create logins that see PHI). |
| Lab tenant admin | staff `user` | `partners.partner.manage` (03 §11, privileged, `tenant_admin`) | Creates partner accounts, links them to a C3 credit party, invites the first partner admin, suspends partners. |
| Lab front desk / centre staff / technologist at the receiving centre | staff `user` | `partners.partner.read`, `partners.manifest.receive`, `partners.pickup.manage` (CR-C13-002) | Receives manifests and boxes, resolves failed lines, handles pickup requests. Centre-scoped (REQ-SEC-017). |
| Lab catalogue owner | staff `user` | `partners.referrer.map` (CR-C13-002) + C3's `catalog.referrer.read` | Maps partner-entered doctors to C3 `catalog.doctors` records. |
| C13 system actor (worker) | `system` | module `systemPermissions` (02-TRD §9) | Converts manifest lines to orders, keeps read models current. |

The partner role is a property of the partner membership (CR-C13-003). One partner login belongs to exactly one tenant and one partner organisation (DECISION, same rule as staff: 02-CV §6 "one staff user = memberships in exactly one tenant"; `core.users` has one row per GoTrue user — C2 05-SCHEMA §2).

## 3. Problems solved

| # | Problem today | Result with C13 |
|---|---|---|
| P1 | Lab re-types every partner sample at the front desk from a paper list | Partner enters patients and tests once; the lab confirms receipt and C4 creates the orders (`FrontdeskPort.createOrderFromBooking`, source `partner_manifest` — 03 §4.3, X5) |
| P2 | Partners phone the lab to ask "is it ready?" | Live per-sample status from `lab.specimen.status_changed.v1` (03 §3.7) and report availability from `reporting.report.released.v1` (03 §3.17) |
| P3 | Reports are sent by WhatsApp/e-mail by hand | Partner downloads released PDFs itself (ReportingPort, CR-C13-005) |
| P4 | Partners dispute rates and dues | Read-only price list and monthly statement from C3/C4 published views |
| P5 | Pickup requests by phone get lost | Pickup request with a visible status |
| P6 | Doctor names on partner forms do not match the lab's doctor master | Partner keeps its own referrer list; the lab maps each entry once to a C3 doctor |

## 4. Scope

### 4.1 In scope (mapped to the client baseline)

| ID | Item | Client baseline | Phase |
|---|---|---|---|
| IS-01 | Partner accounts (organisation master inside the tenant), linked to one C3 credit party (`catalog.credit_parties`, kind e.g. `partner_lab`/`hospital`/`clinic`) and one receiving branch + collection centre | 00 §3 item 10 ("B2B client portal"); 00 §3 item 6 ("comprehensive B2B business management module (sample to result)"); 00 E2 (affiliated hospitals) | 2 |
| IS-02 | Partner users (partner admin / partner member), invitation, MFA for partner admins, deactivate/reactivate, role change — identity held by C2/GoTrue | 00 §3 item 10; 00 E1 (logins, roles, lock) applied to partner logins | 2 |
| IS-03 | Sample submission: manifest with lines (patient, tests/packages, priority, referrer, partner sample reference, collection time), print view to send with the box. Collection time, clinical note and manifest notes/collection date are shown to the receiving lab staff only; they are not part of the lab order or the report (08 A19 D-102) | 00 §3 item 10 ("sample tracking"), item 6 ("sample to result"); 00 A1/A5/A6/A10 equivalents for partner intake | 2 |
| IS-04 | Lab-side manifest receipt at the receiving centre; conversion of received lines into orders via `FrontdeskPort.createOrderFromBooking` (`source = partner_manifest`, `partnerId` per CR-C4-006) | 00 §3 item 6; 01 §5.1 / 03 X5 | 2 |
| IS-05 | Pickup request (partner) and pickup handling (lab staff) | 00 §3 item 10 ("monitoring status"); DECISION: in-portal status only | 2 |
| IS-06 | Sample tracking: per-order and per-specimen status, timestamps, rejection with reason code and recollection flag | 00 §3 item 10 ("sample tracking and monitoring status"); 00 B3; 00 §3 item 15 (TAT) | 2 |
| IS-07 | Report list and PDF download of released report versions only; superseded versions flagged | 00 §3 item 10 ("report download"); 00 D4 (send report to … collection centre) | 2 |
| IS-08 | Optional printed patient access slip (portal link + QR, `ReportingPort.issuePortalLink` called by the C13 worker as the partners system actor, channel `print_qr`; 08 A2.1), tenant-switchable, default off | 00 D2/D6 spirit (patient access), 00 §3 item 13 ("patient portal in website for report access") | 2 |
| IS-09 | Read-only partner price list (from `catalog.v_pub_price_list_items`) | 00 E3 ("different price lists for each doctor, hospital or collection centre") | 2 |
| IS-10 | Monthly statement and outstanding balance (from `billing.v_pub_credit_party_statement`) | 00 E6 ("bills for companies or hospitals on credit (monthly bill)") | 2 |
| IS-11 | Referral-doctor management inside the partner organisation; lab maps entries to C3 doctors; per-referrer volume for the partner | 00 §3 item 10 ("referral doctor management"); 00 A5 | 2 |
| IS-12 | Responsive, installable web app (PWA manifest + static-only service worker); phone-first layout (C0 04-UI-UX §6) | 00 §3 item 10 ("by web and mobile app"), as far as 04 §12 phases it ("B2B partner portal (web)") | 2 |
| IS-13 | Partner dashboard (counts by status, new reports, open pickups, outstanding) | 00 §3 item 10 ("monitoring status") | 2 |
| IS-14 | User manual pages and in-app help for every screen | 01 §2 wishlist item 9 note; 00 §3 item 9 | 2 |

### 4.2 Out of scope (explicit)

| Item | Why / where |
|---|---|
| **Native partner mobile app (Flutter "B2B partner app")** | 00 §3 item 10 asks for "web and mobile app", but 04 §12 phases only "B2B partner portal (web)" in Phase 2 and lists no native partner app in any phase. **Out of scope** (B1 closed with the current wave order, 08 A11.2; a native app needs a new CR + founder approval). Meanwhile IS-12 makes the web app responsive and installable. A native app would reuse the same `partners` API. |
| Push notifications, SMS/WhatsApp/e-mail notices to partners ("report ready") | C13 is not a `NotificationPort` consumer (01 §5.1). CR candidate (06-PLAN §5). In-portal "new" badges only. |
| Outbound webhooks to partner systems | 02-CV §7.5 lists "Outbound webhooks (C13, later)" and REQ-ARCH-041; not in 04 §12 Phase 2 scope. CR candidate. |
| Partner-side barcode label printing | Labels are C5's (`lab.specimen.label_print`, staff permission). Partners write their own sample reference on the tube; the manifest print view lists line numbers. |
| Partner upload of the test request form (TRF) | TRF storage is C4's (`frontdesk.trf_attachments`). CR candidate. |
| Downloading invoice/monthly-bill PDFs, paying online | Invoices are C4's; no port exposes them; payments are C15. The statement is **not a tax invoice** and is labelled so. |
| Cash-billed partner orders | DECISION: every partner has a credit party; partner orders are credit orders (00 E6 monthly bill). |
| Partner orders registered at the lab front desk without a manifest | C4 `RegistrationDraft` has no `partner_id`. Such orders are not visible in the portal. CR candidate to C4. |
| Bulk ZIP download of reports | REQ-SEC-100 makes bulk download privileged; not requested for partners. |
| Editing the C3 doctor master, creating C3 doctors from the portal | Doctors master is C3 (`catalog.doctors`). C13 only stores the partner's own list and a mapping. |
| One partner login for several labs (tenants) | DECISION (§2). A person working for two labs uses two logins. |
| Referral incentive / "commission" for partners | 04 L19, B13. The word "commission" never appears. |

## 5. User stories and acceptance criteria

Conventions: "tenant A/B" are the synthetic tenants (02-CV §11.2). "Partner X/Y" are two partners of tenant A. Every criterion is an automated test unless marked (manual).

### US-01 Partner account management (staff)
As a lab tenant admin I create and maintain partner accounts so that partner users can be invited.
1. Given a staff user with `partners.partner.manage` at aal2, When they create a partner with a unique `partner_code`, a name, an active C3 credit party of tenant A, a receiving branch and centre, Then the partner exists with status `active`, and a price-list sync job is enqueued.
2. Given the same `partner_code` already exists in tenant A, When creating, Then `409 partners.code_duplicate` (CR-C13-009).
3. Given a credit party id of tenant B, When creating a partner in tenant A, Then `404 common.not_found` and no row is written.
4. Given a staff user without MFA (aal1), When they call any `partners.partner.manage` operation, Then `403 auth.mfa_required`.
5. Given an active partner, When a staff admin suspends it with a reason code, Then status is `suspended`, every partner user of that partner gets `403 partners.partner_inactive` on the next request, and the partner's data is still readable by staff.
6. Given a credit party that is linked to another partner of the same tenant, When creating a second partner with it, Then `409 partners.credit_party_in_use` (CR-C13-009).

### US-02 Partner user lifecycle
As a partner admin (or lab admin) I invite and manage my organisation's users.
1. Given staff with `partners.partner.manage`, When they invite `admin@partner-x.invalid` as `partner_admin` for partner X, Then `IdentityPort.provisionPartnerMembership` (CR-C13-003) is called in the same transaction, a `partners.partner_users` row (`invited`) is created, and C2 sends the invitation whose link opens the **partner origin** `/auth/confirm`.
2. Given a partner admin of X at aal2, When they invite a member, Then the new user belongs to partner X only; When they pass a `partner_id` of Y in any field, Then `400 common.validation_failed` (field not declared — REQ-SEC-080).
3. Given a partner member, When they call `invitePartnerUser`, Then `403 auth.forbidden`.
4. Given a partner admin at aal1 (MFA not verified), When they call any user-management operation, Then `403 auth.mfa_required`.
5. Given the last active partner admin of X, When anyone deactivates them or changes their role to member, Then `409 partners.last_partner_admin` (CR-C13-009).
6. Given a deactivated partner user, When they call any partner operation with an old access token, Then `401 auth.session_expired` or `403 identity.membership_inactive` (C2 resolver, live on next request).
7. Given a newly invited partner admin who sets a password, When they first sign in, Then they must enrol TOTP before any data page loads (session state `mfa_enrolment_required`).

### US-03 Partner sign-in on the partner origin
1. Given a partner user, When they sign in at `/auth/login` on the partner origin, Then the partner BFF sets cookie `__Host-lims_psid` (HttpOnly, Secure, SameSite=Lax) and the browser never receives a JWT.
2. Given a staff user's credentials, When used on the partner origin, Then login fails with the generic `401 auth.login_failed` (no hint that the account exists elsewhere).
3. Given a partner user's credentials, When used on the staff origin, Then login fails with `401 auth.login_failed`.
4. Given 10 failed logins from one client IP within 10 minutes, Then further attempts from that IP are limited to 5 per minute for 30 minutes (`429 common.rate_limited`) and a security alert is raised; successful logins never count against the IP (04 §4 login tier as amended by 08 Addendum A1).
5. Given an idle partner session past the tenant idle timeout (15–30 min, 04 A8), When the user clicks anything, Then they are redirected to `/auth/login` with the "session ended" message.

### US-04 Create and submit a manifest
As a partner member I list the samples in a box and submit them.
1. Given partner X active, When a member creates a manifest, Then it is `draft` and has a `manifest_no` of the form `MF{yy}{seq:6}` unique within (tenant, partner) (03 §9.3).
2. Given a draft, When the member adds a line with a new patient (full name, sex, date of birth or age in years, optional phone, consent attestations), at least one orderable from the partner's price list, priority, optional partner referrer and optional partner sample reference, Then the line is stored and the manifest `version` increases.
3. Given an orderable that is not in the partner's price-list projection (and the tenant default list is excluded by setting), When adding it, Then `422 partners.orderable_not_offered` (CR-C13-009).
4. Given a manifest with 0 lines, When submitting, Then `422 partners.manifest_invalid` with `errors[]` pointing to `/lines`.
5. Given a valid draft, When the member submits with `If-Match` equal to the current version, Then state is `submitted`, `submitted_at` is set, lines become read-only, and (only in conversion mode `on_submit`) one `partners.convert_manifest_line` job per line is enqueued.
6. Given the same `Idempotency-Key` sent twice for submit, Then the second call replays the first response (`Idempotent-Replayed: true`) and no second set of jobs is enqueued.
7. Given a submitted manifest, When the member tries to add, change or delete a line, Then `409 partners.manifest_not_editable` (CR-C13-009).
8. Given a draft with more lines than the tenant limit (default 200), When adding, Then `422 partners.manifest_invalid`.
9. Given a submitted manifest (conversion mode `on_receipt`) none of whose lines has been converted, When the member withdraws it with a reason, Then state is `withdrawn` and the lab inbox no longer lists it as pending. In mode `on_submit` withdraw is unavailable (lines are `converting` from submit — 08 A19 D-104): the UI hides the action and the API returns `409 partners.manifest_invalid_transition`.
10. Given a manifest with at least one converted line, When withdrawing, Then `409 partners.manifest_invalid_transition` (CR-C13-009).

### US-05 Manifest print view
1. Given a submitted manifest of partner X, When a member opens "Print", Then the print view shows manifest no., partner name, receiving centre, and per line: line no., partner sample reference, patient name, sex/age, test codes, priority; and an `audit.access_log` row with action `manifest.print` (CR-C13-012) is written.
2. Given a manifest of partner Y, When a user of X requests its print view, Then `404 common.not_found`.

### US-06 Lab receipt and conversion (staff)
As receiving-centre staff I confirm what physically arrived so that orders are created.
1. Given a submitted manifest whose receiving centre is C1 and a staff user scoped to C1 with `partners.manifest.receive`, When they mark lines L1, L2 `received` and L3 `not_received` (reason `sample_missing`), Then L1/L2 are `received`, L3 is `not_received`, the manifest is `partially_received`, and one conversion job per received line is enqueued.
2. Given a staff user scoped only to centre C2, When they open or receive that manifest, Then `404 common.not_found`.
3. Given a conversion job for L1, When it runs, Then it calls `FrontdeskPort.createOrderFromBooking` with `source: 'partner_manifest'`, `sourceRefId: L1.id`, `partnerId: X` (CR-C4-006), `creditPartyId` = partner X's credit party, `branchId`/`centreId` = the manifest's receiving branch/centre, `confirmImmediately: true`, `idempotencyKey: 'partners:' + L1.id + ':v' + L1.conversion_attempt`, and stores the returned `orderId`/`registrationNo`; L1 becomes `converted`.
4. Given the job is retried after the port call committed (duplicate delivery), Then the port replays (`replayed: true`) and no second order exists (C4 contract case 5).
5. Given the port throws `frontdesk.patient_duplicate_suspected`, Then L1 becomes `conversion_failed` with `failure_code = frontdesk.patient_duplicate_suspected`, no retry is scheduled, and the line appears in the staff "needs attention" list.
6. Given a failed line and a staff user who picked an existing patient via C4's patient search, When they retry with `patient_id`, Then a new attempt runs with `patient: { patientId }` and a new idempotency key (`…:v2`), and the line becomes `converted`.
7. Given the port throws `catalog.test_inactive` or `catalog.no_price`, Then the line is `conversion_failed` with that code; retrying without changes returns the same failure.
8. Given an infrastructure failure (`common.dependency_unavailable`), Then the job retries with Graphile Worker backoff and the line stays `converting`.
9. Given no line of the manifest is still *pending receipt* (mode `on_receipt`: no line `submitted`; mode `on_submit`: every converting/converted/failed line has `sample_received_at` or `sample_missing` — 03-APP-FLOW §2.1, 08 A19 D-104), Then the manifest is `received` (closed for receipt).
11. Given mode `on_submit` and a converted line whose sample did not arrive, When staff mark it `not_received` with a reason, Then the line keeps its order, `sample_missing = true`, and it appears in the inbox filter "Order exists but sample missing" (`has_missing_samples`) for follow-up at the front desk.
10. Given tenant A staff and a manifest id of tenant B, When receiving, Then `404 common.not_found` and nothing changes in tenant B.

### US-07 Sample tracking
As a partner member I see where each sample is.
1. Given L1 converted to order O1, When C5 emits `lab.specimen.status_changed.v1` for a specimen of O1 (`to_status = received`), Then the partner's order view shows that specimen as "Received at lab" with its time, and the order's tracking status becomes `in_lab`.
2. Given an older event (`aggregate.seq` lower than the stored seq) arrives after a newer one, Then it is ignored.
3. Given the same `event_id` is delivered twice, Then the second delivery changes nothing (inbox dedupe).
4. Given a status event for an order that no partner manifest line references, Then the consumer records the inbox row and stores nothing else.
5. Given a specimen of O1 is rejected (`to_status = rejected`), Then the order view shows "Rejected" with the rejection reason (code humanised, e.g. "Haemolysed" — 03-APP-FLOW §4.3; filled by the reconcile job from `lab.v_pub_specimen_timeline`) and tracking status `action_needed` ("New sample needed") until a replacement specimen (`replaces_specimen_id`) is received.
6. Given orders of partner Y, When a user of X lists orders, Then none of Y's orders appear (also when filtering by Y's manifest id: empty list, not an error).
7. Given order O1 is cancelled at the lab (CR-C13-006 consumer of `frontdesk.order.cancelled.v1`, or the reconciliation job reading `frontdesk.v_pub_order_status`), Then L1 tracking shows `cancelled`.
8. Given a patient-name search term, When a member searches, Then the request uses `POST /v1/partners/orders/search` with the term in the body (never in the URL — REQ-SEC-098).

### US-08 Report list and download
1. Given C6 emits `reporting.report.released.v1` for O1 with `partner_id = X` and `audiences` containing `partner`, Then within one consumer run the report appears in X's report list marked "New".
2. Given a released report, When a member of X downloads it, Then the response is `application/pdf` with `Content-Disposition: attachment`, the bytes' SHA-256 equals the version's stored hash, and `audit.access_log` has a `report.download` row (outcome `allowed`).
3. Given a report of partner Y's order, When a member of X requests its download (guessing ids), Then `404 common.not_found` and an access-log row with outcome `denied` is committed (`ctx.commitOnError()`).
4. Given version 2 of a report was released, Then version 1 shows as "Superseded" and version 2 as current; downloading version 1 is allowed and the file is stamped by C6 as superseded only if C6 does so (C13 does not alter PDFs).
5. Given a report not yet released, Then it does not appear and its download returns `404 common.not_found`.
6. Given a member downloads more than the per-report limit within an hour (20, `report_download` tier, 04 §4), Then `429 common.rate_limited` with `Retry-After`.
7. Given a member exceeds the daily per-user download cap (tenant setting, default 500 [CONV]), Then `429 common.rate_limited` and an alert-worthy metric increments (REQ-SEC-100/133).

### US-09 Patient access slip (optional)
1. Given tenant setting `access_slip_enabled = false` (default), When requesting a slip, Then `403 common.feature_disabled`.
2. Given the setting is on and a released report of X, When a member requests a slip (`POST …/access-slips`), Then C13 records a slip request in `partners.access_slips` (state `requested`) and returns `202` with the slip id and state only — no link token or URL in the response (08 A2.1).
3. The C13 worker, running as the partners system actor, calls `ReportingPort.issuePortalLink({ reportId, versionNo, channel: 'print_qr', recipientKind: 'patient' })`, renders the slip PDF once through `RenderPort.renderPdf` with template key `partners.access_slip` (08 A5.1; data `{ tenantDisplayName, partnerName, patientDisplayName, orderRef, portalUrl, expiresAtLocal, issuedAtLocal }` — no results, no PHI beyond name and order ref; C6 draws the QR from `portalUrl`), stores it in the `partners-slips` bucket (08 A5.2) and records its reference in `partners.access_slips` (state `issued`). The plaintext link token/URL is never stored in a column and never logged (03 §4.7, 08 A2.1).
4. The partner UI polls the slip status every 1 s and gives up after 30 s (accepted, 08 A5.3); the slip is typically `issued` in under 5 s [CONV]. A port business error (`reporting.report_not_released`, `reporting.report_superseded`) → state `failed` with that code.
5. Given a line without a patient mobile number, When a member requests a slip, Then the request is accepted and PR-2 warns "The slip opens only if the lab has a mobile number for this patient." (08 A19 D-105; the portal OTP goes to the phone on file in C4, A13 D-31).
6. Given an `issued` slip, When a member of the same partner downloads it, Then the PDF is returned (`Cache-Control: no-store`) and `audit.access_log` has action `report.access_slip` (CR-C13-012) — logged on every download (accepted, 08 A5.3).

### US-10 Pickup requests
1. Given partner X with submitted manifests M1, M2, When a member creates a pickup request for them with a window start < end, window end ≤ 7 days ahead [CONV], package count 1–50, Then the request is `requested`.
2. Given a manifest of partner Y in `manifest_ids`, Then `404 common.not_found` (whole request rejected).
3. Given a `requested` pickup, When receiving-centre staff schedule it (time + assignee text), Then it is `scheduled` and the partner sees the scheduled time.
4. Given a `scheduled` pickup, When staff mark it picked up, Then it is `picked_up` and its manifests show "In transit to lab".
5. Given a `requested` or `scheduled` pickup, When the partner cancels it, Then it is `cancelled`; from `picked_up` → `409 partners.pickup_invalid_transition` (CR-C13-009).

### US-11 Price list
1. Given partner X linked to credit party CP1 with a published price list, When a member opens "Price list", Then they see each orderable's code, name, kind, unit price (NPR, from `catalog.v_pub_price_list_items` with `owner_kind = credit_party`, `owner_id = CP1`, effective now) and the list version.
2. Given setting `include_default_price_list = true` (default), Then orderables without a partner price appear with the tenant default price labelled "Standard rate".
3. Given C3 publishes a new version of CP1's price list, Then after the next sync (catalog event via CR-C13-006, or the nightly job) the new prices are shown with the new version number.
4. Given partner Y's prices, Then they are never visible to X (prices of other parties are never projected into X's rows).
5. The screen states "Urgent tests may carry an extra charge. The amount on your statement is final." (prices shown exclude urgent surcharge — C4 computes the charge, REQ-SEC-046).

### US-12 Statements
1. Given billing data for CP1, When the statement sync job runs, Then X's statement list shows one row per (A.D. month, B.S. fiscal year) with invoiced, paid, credited and closing balance in NPR from `billing.v_pub_credit_party_statement`.
2. The outstanding tile equals the latest row's `closing_balance_paisa`, with "as of" time = last sync time.
3. The screen carries the text "This statement is for information. It is not a tax invoice." (04 L5/L26 context; DECISION).
4. Given a period with no billing rows, When opening `/statements/2026-10`, Then an empty state, not an error.

### US-13 Referral doctors
1. Given a partner admin of X, When they add a referrer (display name, qualification, council registration no.), Then it is `active`, `mapping_state = unmapped`, and selectable on X's manifest lines.
2. Given a partner member, When they try to add a referrer, Then `403 auth.forbidden`; they can list and select.
3. Given staff with `partners.referrer.map`, When they map the referrer to C3 doctor D1 (found via C3 `searchDoctors`), Then `mapping_state = mapped`, `catalog_doctor_id = D1`; later conversions pass `referrerId = D1`.
4. Given an unmapped referrer on a line and setting `require_mapped_referrer = false` (default), When the line converts, Then the order is created without `referrerId` (prints "SELF" per C6) and the line keeps the partner referrer for portal display; with the setting `true`, the conversion job sets the line `conversion_failed` with `failure_code = partners.referrer_not_mapped` (CR-C13-009) without calling C4, and mapping the referrer (SR2) automatically re-enqueues the conversion.
5. Given D1 belongs to tenant B, When mapping in tenant A, Then `404 common.not_found` (validated through `CatalogPort.getReferrer`, CR-C13-007).
6. Given 30 converted lines with referrer R in October, Then X's referrer list shows "Samples this month: 30" for R (counts only, no money — 04 L19).

### US-14 Partner dashboard
1. Given partner X, When a member opens the home page, Then tiles show: samples submitted today, in lab, reported today, rejected (needs action), new reports, open pickups, outstanding balance; each tile links to the filtered list.
2. Given X has no data, Then each tile shows 0 and the page shows the onboarding empty state ("Create your first manifest").

### US-15 Isolation (cross-cutting)
1. For every partner-facing operation: a partner user of X calling with ids of partner Y (same tenant) → `404 common.not_found`, no Y data in the body, no change to Y rows.
2. For every operation: tenant A credentials with tenant B ids → `404 common.not_found`.
3. A partner user's access token used against any staff-only operation of any module → `403 auth.forbidden`.
4. A staff user's token used against partner-actor operations (`/v1/partners/me`, …) → `403 auth.forbidden` (partner permissions are not grantable to staff roles).
5. SQL probe: with partner X claims, `SELECT` on every `partners.*` table returns only X's rows; `INSERT` with `partner_id = Y` fails; `UPDATE` of Y rows affects 0 rows.

### US-16 Installable responsive app
1. Given a phone at 320 CSS px width, Then every partner page is usable without horizontal page scroll (C0 04-UI-UX §5.7).
2. Given the app is installed (PWA), When offline, Then only the static offline page is shown and no previously viewed patient data is available from any cache (service worker caches static assets only; data responses `Cache-Control: no-store`).

## 6. Success metrics (measured from metrics in 02-TRD §13; targets are ASSUMPTION, validate after go-live)

| Metric | Target |
|---|---|
| Share of partner samples arriving with a submitted manifest | ≥ 80 % of partner orders 3 months after onboarding |
| Manifest line → order conversion success at first attempt | ≥ 95 % |
| Median time from lab receipt to order created | ≤ 2 min |
| Report visible in portal after release (p95) | ≤ 2 min |
| Partner phone calls "is it ready?" | qualitative drop reported by the anchor lab (manual) |
| Cross-partner or cross-tenant data exposure | 0 (probe suite green on every release) |

## 7. Phase

Phase 2 (04 §12; 01 §1 Wave 2). B1 is closed: the client confirmed the current wave order (08 A11.2).

## 8. Dependencies (contracts only)

| Kind | Name | Owner | Use |
|---|---|---|---|
| Port | `FrontdeskPort.createOrderFromBooking` (+ `partnerId`, CR-C4-006) | C4 | manifest line → order |
| Port | `ReportingPort.getReleasedReports` (system actor), `openReleasedReportFile` (partner actor, CR-C13-005), `issuePortalLink` (access slip — system actor in the C13 worker, 08 A2.1; R8 allowlist unchanged) | C6 | report list enrichment, download, access slip |
| Port | `RenderPort.renderPdf` with `templateKey: 'partners.access_slip'` (system actor in the C13 worker; C13 is a listed RenderPort consumer — 08 A5.1, CR-C13-014) | C6 | access-slip PDF |
| Port | `IdentityPort.assertRole`, `getActor`, `getTenantSettings`; `provisionPartnerMembership`, `updatePartnerMembership` (CR-C13-003) | C2 | authz, timeouts, partner logins |
| Port | `CatalogPort.getTest`, `getPanel`, `getReferrer`, `getCreditParty` (C13 as consumer: CR-C13-007; `getReferrer`/`getCreditParty` from CR-C3-001) | C3 | names for the price list; validation of doctor/credit-party ids |
| HTTP | C2 `/v1/identity/auth/*` with partner session kind (CR-C13-003) | C2 | sign-in, MFA, recovery on the partner origin |
| HTTP (staff web BFF) | C4 `POST /v1/frontdesk/patients/search`; C3 `POST /v1/catalog/doctors/search`, `GET /v1/catalog/credit-parties/{id}` | C4, C3 | staff screens resolve duplicates, map doctors, pick credit party |
| Event (consume) | `lab.specimen.status_changed.v1`, `reporting.report.released.v1` (03 §3.25); `frontdesk.order.cancelled.v1`, `catalog.changed.v1` (CR-C13-006) | C5, C6, C4, C3 | read models |
| View (read, system actor) | `frontdesk.v_pub_order_status`, `lab.v_pub_specimen_timeline`, `catalog.v_pub_price_list_items`, `catalog.v_pub_test_directory`, `billing.v_pub_credit_party_statement` (03 §6) | C4, C5, C3 | projections and reconciliation |
| Platform | C0 core (`ctx.db`, `ctx.audit.access`, `ctx.rateLimit`, idempotency, events inbox, worker), `@lims/ui`, RLS helper `app.current_partner_id()` (CR-C13-004) | C0 | — |
| Infra | partner origin `LIMS_ORIGIN_PARTNER`, flag `partner_enabled` (C1 02-TRD) | C1 | deployment |

## 9. Blocked items and defaults

| # | Blocked item | Default built meanwhile |
|---|---|---|
| B1 | **CLOSED** (08 A11.2): current wave order confirmed | Web portal only, responsive + PWA; a native partner app needs a new CR + founder approval |
| B16 | Privacy Regulation 2077 / whether consent attested by the referring partner is sufficient for the lab's processing and channels | Partner attests consent per line with the tenant consent text version (REQ-SEC-005); C4 enforces `frontdesk.consent_required`; UI says the partner confirms it obtained consent. Legal sufficiency **UNVERIFIED** |
| B15 | Legal retention periods | Manifest patient fields redacted after the tenant `retentionYears` (default 5, 04 I8) |
| B13 | Referral-incentive position | Partner referrer volumes are counts only; no money per referrer; never "commission" |
| B6/B17 | IRD interpretation | Statement labelled "not a tax invoice"; C13 never writes billing data |
| B3 | Real test list and prices | Synthetic catalog and price lists (`packages/test-fixtures`) |
| 04 D3 | Self-hosted Storage claims behaviour (UNVERIFIED) | Report bytes are fetched server-side by the API through C6's port (signed URL never reaches the browser); probes cover the download path |
