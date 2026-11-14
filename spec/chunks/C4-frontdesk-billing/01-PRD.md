# C4 Front Desk & Billing — 01 PRD

Status: DECISION draft, 2026-11-05. Phase 1 (04 §12), with gateway hooks for Phase 1.5–2 and booking/home-collection hooks for Phase 3.
Precedence: 00 → 04 → 03-IC → 01/02 → this file. Every name below (events, ports, permissions, error codes, routes) is used verbatim from `program/03-INTERFACE-CATALOG.md` (03-IC). Items that 03-IC does not yet contain are marked **[CR-C4-nnn]** and listed in `02-TRD.md` § "Change requests raised".

## 1. Purpose

C4 is the money-and-identity front door of every tenant lab. It must:

1. Let a front-desk operator register a patient, the tests, the discount and the payment on **one single page** (00 A1), keyboard-first, in well under a minute for a returning patient.
2. Produce **IRD-compliant, immutable fiscal documents** (invoices, credit notes) under the Electronic Invoice Procedure 2074 (04 L1–L6, L26), safe for the lab against the NPR 500,000 fine for software that can delete or correct data (04 L5).
3. Keep an **append-only payment-method ledger** (04 P1) that answers "what does this order still owe?" for the whole system (`BillingPort`).
4. Give owners/finance the daily cash tally, dues, credit-party monthly bills and statutory registers.

C4 is built as **two internal modules** that two agents can build in parallel (01 §8 risk 4):

| Module | Owns | Agent |
|---|---|---|
| `frontdesk` | patients, consents, orders, order items, discounts + approvals, TRF attachments, order flags, registration page, FrontdeskPort | Agent FD |
| `billing` | invoices, invoice lines, credit notes, fiscal counters, ledger, cash sessions, credit accounts/charges, balances, release overrides, CBMS sync, registers/exports, BillingPort | Agent BL |

The only coupling between them is the C4-internal port **`BillingCommandPort`** [CR-C4-001] (specified in `02-TRD.md` §6.3) plus the existing `BillingPort`/`FrontdeskPort`.

## 2. Users and roles

Roles are the [CONV] defaults from 03-IC §11; permissions are the codes the role needs here.

| Role (03-IC §11) | What they do in C4 | Permissions used |
|---|---|---|
| `front_desk` | Register, search patients, edit/cancel orders, apply discounts within limit, upload TRF, take payments, print invoices/receipts, close own cash shift, request discount approval, Pay-by-QR (Phase 1.5) | `frontdesk.registration.create`, `frontdesk.patient.read`, `frontdesk.order.read`, `frontdesk.order.edit`, `frontdesk.order.cancel`, `frontdesk.discount.apply`, `frontdesk.trf.upload`, `billing.invoice.read`, `billing.invoice.issue`, `billing.invoice.reprint`, `billing.payment.record`, `payments.intent.create` |
| `centre_staff` | Register at a collection centre, upload TRF, view orders of own centre | `frontdesk.registration.create`, `frontdesk.patient.read`, `frontdesk.order.read`, `frontdesk.trf.upload` |
| `finance` (MFA) | Cancel invoices, partial credit notes, reversals, refunds (request, and approve another person's request — two-person rule), credit-party terms, monthly credit bills, exports/registers, audit-trail report, release override, approve discounts | `billing.invoice.cancel`, `billing.payment.reverse`, `billing.refund.request` (08 A13 D-24), `billing.refund.approve`, `billing.credit_party.read`, `billing.credit_party.manage`, `billing.cash_report.read`, `billing.data.export`, `billing.release.override`, `frontdesk.discount.approve` |
| `tenant_admin` (MFA) | Approve discounts, cancel orders, settings, release override | `frontdesk.discount.approve`, `frontdesk.order.cancel`, `billing.release.override`, `billing.credit_party.read`, `frontdesk.settings.manage` [CR-C4-008], `billing.settings.manage` [CR-C4-008], `frontdesk.patient.anonymise` [CR-C4-008], `frontdesk.patient.read`, `frontdesk.order.read` (default roles widened by 08 A13 D-28 so the patient and order pages open) |
| `owner_viewer` (MFA) | Daily cash report | `billing.cash_report.read` |
| `lab_technologist`, `pathologist` | Read patient/order context | `frontdesk.patient.read`, `frontdesk.order.read` |
| `phlebotomist` | (via C17 app) payments arrive as `homecollection.collection.synced.v1` | `billing.payment.record` (C17 path) |
| System actors | Worker consumers/jobs (C4 manifest), C15 settle transaction, C6 release check | declared per worker manifest (02-CV §2.3) |

Privileged permissions (`privileged: true` in 03-IC §11) require aal2 (TOTP) and live membership re-validation (04 A4; REQ-SEC-062/067).

## 3. Problems this chunk solves (from the client)

| # | Problem | Source |
|---|---|---|
| P1 | Registration, tests and payment are spread over screens; queues at 7–11 am | 00 A1; 03 §1.1 (peak ~25 % of daily volume) |
| P2 | Duplicate patient records break previous results/trends | 00 A2; 01 research §1.1 |
| P3 | Discounts given without trace | 00 A8 |
| P4 | The lab must hold IRD-approved billing (each lab's own permission); software that can delete/correct data exposes the lab to NPR 500,000 | 00 G5; 04 L3, L5 |
| P5 | Owners cannot reconcile daily cash by staff and method | 00 E7 |
| P6 | Companies/hospitals billed monthly on credit | 00 E6 |
| P7 | Reports released before dues are paid | 00 D1 (C6 release; C4 is the authority on dues) |

## 4. In scope (mapped to the client baseline)

| ID | Capability | Baseline item(s) | Notes |
|---|---|---|---|
| S1 | One-page registration (patient + order + discount + payment + print) | 00 A1 | `POST /v1/frontdesk/registrations` is one atomic transaction |
| S2 | Patient search by name / mobile / patient code ("lab code") / registration no | 00 A2 ("All") | body search, no PHI in URL (REQ-SEC-098) |
| S3 | New patient with dedupe check and consent capture | 00 A2; REQ-SEC-005 | `frontdesk.patient_duplicate_suspected`, `frontdesk.consent_required` |
| S4 | OPD/IPD visit type and cash/credit billing mode (two independent fields) | 00 A3; glossary "Cash vs credit" | |
| S5 | Collection centre selection | 00 A4 | limited to the operator's centre scope |
| S6 | Referring doctor select + quick-add | 00 A5 | quick-add uses C3's HTTP API (`catalog.referrer.manage`) from C4's page; "SELF" = no referrer |
| S7 | Test search by short name / package | 00 A6 | C3's HTTP catalog search; server re-resolves via `CatalogPort` |
| S8 | TRF photo/scan upload, scanned and quarantined before preview | 00 A7; REQ-SEC-083/084/085 | |
| S9 | Discount per line or bill, amount or %, reason code, approver | 00 A8 | approval flow §7 DECISION D-APPROVAL |
| S10 | Payment by cash / card / eSewa / Khalti / Fonepay QR (manual ledger in Phase 1), part payment | 00 A9; 04 P1, P5 | live gateways Phase 1.5–2 via C15 |
| S11 | Urgent flag + urgent surcharge line | 00 A10 | surcharge from `CatalogPort.priceFor().urgentSurcharge` |
| S12 | Registration SMS | 00 A11 | `NotificationPort.sendSms`, purpose `registration_confirmation`, link/PHI-free |
| S13 | Bill print with the tenant branding block (letterhead; tax invoice original print; later payment receipts) | 00 A12; TenantSettings.branding (08 §4.12) | |
| S14 | Barcode label print **trigger** (labels belong to C5) | 00 B1 | see §8 |
| S15 | IRD invoicing: immutable invoices, gapless serial per (tenant, B.S. FY), chronological, cancelled viewable/printable, reprint "Copy of Original"/"प्रतिलिपि" + print count, per-user audit-trail report, sales register, cancelled-invoice report, Excel/XML/PDF export, dual calendar, timestamp+active flag+user, CBMS sync capability, in-app help + manual | 00 G5; 04 L5–L8, L11, L16, L26 | design for the procedure; never claim approval (05-DoD §5.4) |
| S16 | Tax engine: exempt / VAT 13 % / additional per-line tax type; rates configured in C3 (08 R18) | 04 L14, L15, L25; B7 | |
| S17 | Payment-method ledger (append-only, reversals), dues, hold-till-paid authority | 00 A9, D1; 04 P1 | `BillingPort` |
| S18 | Credit-party monthly billing + statements, credit limit / credit-days lock | 00 E6; 01 research §1.5 | |
| S19 | Daily cash collection report by staff and method; shift close | 00 E7 | |
| S20 | Refunds (privileged, MFA, two people: requester ≠ approver) and reversals | REQ-SEC-055, 057; 04 A4; 02-CV §4.7 / 08 R15; 08 A13 D-24 | |
| S21 | Referral attribution captured on every order (data only) | 00 E5; 04 L19; B13 | reporting is C8; never "commission" |
| S22 | FrontdeskPort and BillingPort implementations | 01 §5.1 | contract suites 03-IC §4.3/§4.4 |
| S23 | Event consumers: `lab.specimen.rejected.v1`, `lab.specimen.status_changed.v1` (`recollection_ordered` only — 08 A13 D-6), `catalog.changed.v1`, `payments.intent.settled.v1`, `engagement.booking.confirmed.v1`, `engagement.booking.cancelled.v1`, `homecollection.collection.synced.v1` | 01 §5.1; 03-IC §3 | Phase-3 producers are faked until they exist |
| S24 | "Pay by QR" button on the registration page calling `PaymentProviderPort` | 01 §5.1 page ownership | feature-flagged until C15 ships (Phase 1.5) |
| S25 | Published views `frontdesk.v_pub_*` and `billing.v_pub_*` | 03-IC §6.1/§6.2 | |
| S26 | Patient anonymisation (privileged, audited; retention floor) | 02-CV §5.6; REQ-SEC-139; B15 | [CR-C4-008] permission |
| S27 | Per-tenant billing export/restore (isolatability) | 04 D16; B17 | tested, operator task |

## 5. Out of scope

| Item | Why / owner |
|---|---|
| Label layout, printer drivers, barcode generation | C5 (01 §2: "barcode label print"; 03-IC §9.3 barcode owner C5) |
| Specimen collection/receipt status changes | C5 |
| Report release, override UI on reports, delivery | C6 (C4 only answers `getReleaseEligibility` and stores overrides) |
| Referral-incentive report, dashboards, MIS | C8 (reads `billing.v_pub_referrer_billing` etc.) |
| Gateway integration (eSewa/Khalti/Fonepay APIs), reconciliation job, gateway refunds | C15 (Phase 1.5–2) |
| Doctor/credit-party/price-list masters, urgent surcharge rules, tax flag per orderable | C3 |
| User/role/MFA management, tenant settings (letterhead, numbering patterns), IRD Annex workflow | C2 |
| Patient merge | deferred: needs a new event so C5's previous-results/trend can follow the merge (CR candidate in `06` §5) |
| Purchase register, debit notes, VAT return (Maskebari) | Lab buys nothing through LIMS; accounting module is a wishlist item not in 04 §12 Phase 1 |
| Payout of referral incentives | 04 L19, B13 |
| SaaS subscription billing of labs | 01 §2 DROP list |
| Any statement that the software is "IRD approved/certified" | 05-DoD §5.4; IRD listing/permission is per 04 L3 |

## 6. Phase and blocked items

Phase 1 delivers S1–S23, S25–S27. S24 ships hidden behind tenant flag `billing.settings.pay_by_qr_enabled` (default `false`) and becomes usable when C15 merges (Phase 1.5–2).

| Blocker | What is blocked | Default built meanwhile (07-BLOCKERS) |
|---|---|---|
| B6 / 04 L13 | CBMS API spec, IRD checklist, invoice-series granularity (04 L8), cl.7 interpretation | `CbmsClient` interface + recording stub (`LIMS_BILLING_CBMS_MODE=stub`); series key configurable (`invoice_series_scope ∈ {tenant, branch}`, default `tenant`); gapless per (tenant, series, B.S. FY) |
| B7 / 04 L15, L25, L10 | VAT treatment of lab services, Health Service Tax, HS-code | per-line `vat_treatment ∈ {exempt, taxable}` and the rates (`vatRateBp` 13 % per 04 L14, `otherTaxRateBp`, `hsCode`) from `CatalogPort.priceFor().tax` — C3 is the only owner of tax rates (08 R18); C4 snapshots code + rate on every invoice line and has no tax table; no rate is ever guessed |
| B17 / 04 D16 | Is shared schema + RLS "stored separately"? | `billing` schema with tenant-leading keys, no sequences, no cross-tenant rows, per-tenant export/restore test (S27) |
| B13 / 04 L19 | Referral-incentive compliance | referrer captured on orders only; no UI says "commission" |
| B15 / 04 L20 | Legal retention | anonymisation blocked before `retentionYears` (default 5) after last order; **no** purge of billing documents in v1 |
| B8 / 04 P5 | Fonepay API | Fonepay recorded manually as ledger method `fonepay_qr` with operator reference |
| 04 L9 | Abbreviated tax invoice limit | `abbreviated_invoice_enabled = false` by default; limit is config (`TenantSettings.ird.abbreviatedInvoiceLimitPaisa`) |
| B1 | Patient app / phlebotomy app timing | consumers built against fakes |

The billing module is marked **not certifiable** until B6 documents arrive (05-DoD §5.4). UI copy must never say otherwise.

## 7. Key product decisions

| ID | Decision | Rationale |
|---|---|---|
| D-APPROVAL | **Discount approval = remote approval from the approver's own session at aal2.** Discounts within the tenant's self-limit need only a reason (approver recorded = operator, mode `within_limit`). Above the limit, the operator raises a `discount_approval` request bound to the base (pre-discount) quote fingerprint `base_fingerprint` and the exact discounts; an approver holding `frontdesk.discount.approve` approves it from their own session (privileged ⇒ aal2 + membership re-validation, 03-IC §11); the registration then consumes the approval once. **No PIN, no approver password on the cashier's PC.** | A PIN is a new credential class with no parameters in 04 §3 (would be invented); 02-CV §6 / 04 A4 require aal2 + re-validated membership for privileged permissions, which a PIN cannot provide; typing an approver's password + TOTP into a shared reception terminal creates a second session on a shared PC and needs a step-up API C2 does not offer. Remote approval reuses existing auth. |
| D-RECEIPT | The bill printed at registration **is the tax invoice (original print)** with a non-fiscal payment block (paid / due). Later part payments print a non-fiscal **payment receipt** numbered `RC-…` (03-IC §9.3 `receipt_no`). | Glossary "Invoice" leaves this to C4's PRD; one document at the desk. |
| D-INVOICE-TIMING | Cash-mode orders get their invoice when the order enters `registered` (front desk, pre-registration confirm, booking/home-visit with `confirmImmediately`). Credit-mode orders get **no per-order invoice**; their lines become `credit_charges` invoiced by the monthly credit bill (`is_periodic_credit_bill`). | 03-IC §3.4 notes; 00 E6 |
| D-CORRECTIONS | Corrections never edit: items added after invoicing → supplementary invoice; items removed / post-invoice discount → partial credit note (finance); full cancellation → cancel + credit note (finance). Order cancellation at the desk sets `requires_credit_note`; finance completes the credit note. | 04 L5, L26 ख/ट; 03-IC §3.3 ("separate billing transaction"); `billing.invoice.cancel` is privileged |
| D-PAYMENT-AMOUNT | Manual ledger amounts are operator-recorded facts (04 P1); the server computes the due amount and rejects overpayment (`billing.payment_exceeds_due`). Gateway amounts come only from C15 (REQ-SEC-046). | Interpretation of 02-CV §4.7 (see TRD CR-C4-012) |
| D-LABELS | C4 never prints labels. `frontdesk.order.created.v1` makes C5 create specimens + barcodes (03-IC §10.1 S1); When tenant setting `label_autoprint = true`, C4's success panel calls C5's readiness operation (CR-C4-010) and then opens C5's label route `staff.lab.order_labels` in a print frame; the label page prints (08 A13 D-4). | 01 §2 C5 scope; `lab.specimen.label_print` |
| D-PATIENT-SCOPE | `frontdesk.patients` is **tenant-scoped** (not centre-scoped) so dedupe works across 20 centres; orders, discounts, TRFs, invoices are centre-scoped. Search requires ≥3 characters (name) or a full mobile/code, results capped at 20, each search access-logged. | 00 A2; 01 research §1.1; REQ-SEC-045 |

## 8. User stories and acceptance criteria

Notation: each AC is a test (05-DoD §2). "Operator" = `front_desk` at centre A1 of `tenant_a`. Money in NPR; synthetic data only.

### Front desk (module `frontdesk`)

**US-FD-01 Search patient.** As an operator I find a returning patient by name, mobile or code so no duplicate is created.
1. Given patient "Test Patient 0042" with mobile +9779800000042 exists in tenant_a, When I search `9800000042`, Then the result list shows that patient first with patient code, sex, age and last visit date.
2. Given the same, When I search by patient code `MP00000042` or by registration no of any of their orders, Then exactly that patient is returned.
3. Given I type 2 characters of a name, When I search, Then the API returns `400 common.validation_failed` and the UI says "Type at least 3 letters or a full mobile/code".
4. Given a patient exists only in tenant_b, When a tenant_a operator searches the exact mobile, Then zero results are returned.
5. Given any search, Then an `access_log` row (action `patient.search`, result count, no query text) is written and no query text appears in logs.
6. Given Devanagari input "परीक्षण", When I search, Then matching NFC-normalised names are returned (trigram on normalised text).

**US-FD-02 Create patient with dedupe and consent.**
1. Given no match, When I submit name, sex, age 43 y (no DOB) and processing consent, Then a patient is created with `birth_on` estimated, `is_birth_on_estimated = true` and a new `patient_code` from the tenant pattern.
2. Given an existing patient with the same normalised name, same birth year (±1) and same phone, When I create, Then `409 frontdesk.patient_duplicate_suspected` lists the candidate ids; When I resubmit with `duplicate_override.reason_code`, Then the patient is created and the override is audited.
3. Given processing consent unchecked, When I submit, Then `422 frontdesk.consent_required` and nothing is stored.
4. Given SMS consent unchecked, When the order registers, Then no registration SMS is queued (NotificationPort returns `suppressed_no_consent`) and the UI shows "SMS not sent: no consent".
5. Given a consent change, Then a new `patient_consents` row (append-only) with the consent text version is written; the old row is unchanged.

**US-FD-03 One-page registration (cash, walk-in).**
1. Given an existing patient, centre A1, referrer "SELF", items CBC + Lipid profile, When I press `Ctrl+Enter`, Then one transaction creates the order (`registered`), order items with price snapshots, the invoice (`issued`, number `082/83-000001`-shape from the tenant pattern), the ledger entry for the cash payment, and emits `frontdesk.order.created.v1` and `billing.invoice.issued.v1` exactly once each, and `billing.balance.changed.v1` once per balance change (1 + number of `payments[]`) with strictly increasing `balance_version`.
2. Given the response, Then the invoice print view opens with the branding block (letterhead), both B.S. and A.D. dates, "Original" mark is absent, `print_count` becomes 1 after the print call.
3. Given the client retries the same request with the same `Idempotency-Key`, Then the stored response is replayed (`Idempotent-Replayed: true`) and no second order/invoice/number is created.
4. Given the price list changed between quote and submit, When I submit with the old `quote_fingerprint`, Then `409 common.version_conflict` with the fresh quote; nothing is stored, no invoice number is consumed.
5. Given the transaction fails after the invoice number was allocated (e.g. event schema failure), Then the counter value is rolled back and the next invoice receives the same number (gapless test).
6. Given a returning patient and 3 items, When an operator uses only the keyboard, Then registration completes with ≤ 12 keystroke groups and no mouse (UI test script in 04-UI-UX §3.7).
7. Given the tenant setting `require_referrer = true`, When no referrer is selected, Then `422 frontdesk.referrer_required`.

**US-FD-04 Credit-mode registration.**
1. Given credit party "Synthetic Corp" with an active credit account, When I register with `billing_mode = credit`, Then no invoice is issued, `credit_charges` rows are created per line, `BillingPort.getReleaseEligibility` returns `eligible: true, basis: credit_party`.
2. Given the credit account is locked, or C3 reports the credit party inactive or `allowsCredit = false`, or the projected outstanding exceeds the limit, Then `409 billing.credit_party_locked` / `409 billing.credit_limit_exceeded` and nothing is stored; the quote (F8) already shows the state (`credit_status`).
3. Given `billing_mode = credit` without `credit_party_id`, Then `400 common.validation_failed`.
4. Given the first credit order for a party, Then its `credit_accounts` row is created from `CatalogPort.getCreditParty({purpose:'billing'})` in the same transaction.

**US-FD-05 Urgent.**
1. Given an item marked urgent and a surcharge rule in C3, When I register, Then an extra invoice line of kind `urgent_surcharge` is added and the order item and `frontdesk.order.created.v1` item carry `priority: urgent`.
2. Given no surcharge rule, Then the item is urgent with no surcharge line.

**US-FD-06 Discount within limit.**
1. Given tenant self-limit 10 %, When I apply a 5 % bill discount with reason `staff_family`, Then the discount is allocated pro-rata across lines (largest remainder to the paisa) and recorded with `approval_mode = within_limit`, approver = me.
2. Given no reason code, Then `400 common.validation_failed` (path `/discounts/0/reason_code`).
3. Given a line discount larger than the line amount, Then `422 frontdesk.discount_exceeds_limit`.

**US-FD-07 Discount above limit (remote approval).**
1. Given a 30 % discount and limit 10 %, When I submit the registration without an approval, Then `403 frontdesk.discount_approval_required` and the UI offers "Request approval".
2. When I request approval, Then a pending approval bound to my quote's `base_fingerprint` (same lines, no discounts) and the requested discounts appears in approvers' inbox; When a `finance` user at aal2 approves, Then my screen shows "Approved by <name>" within 5 s (polling) and the registration succeeds, consuming the approval.
3. Given the approver session is aal1, When approving, Then `403 auth.mfa_required`.
4. Given I hold `frontdesk.discount.approve` myself, When I approve my own request, Then `403 frontdesk.discount_self_approval_forbidden` [CR-C4-007].
5. Given an approval older than 15 min or already consumed, or the server-recomputed base fingerprint or the discounts differ from the approval's, Then `403 frontdesk.discount_approval_required`.

**US-FD-08 Part payment and dues.**
1. Given invoice net NPR 2,250.00, When I record cash NPR 1,000.00, Then balance due is NPR 1,250.00 and `billing.balance.changed.v1` has `release_eligible: false, release_basis: due_outstanding` (setting `releaseRequiresPayment = true`).
2. When I later record card NPR 1,250.00 from the order page, Then a receipt `RC-…` prints, balance is 0, eligibility `paid_in_full`.
3. Given due NPR 1,250.00, When I record NPR 1,300.00, Then `422 billing.payment_exceeds_due`; the UI shows tendered/change locally but records only the due.

**US-FD-09 TRF upload.**
1. Given a JPEG ≤15 MB, When I upload, Then it is stored under `{tenant_id}/…`, `scan_state = pending`, and preview is disabled until `clean`.
2. Given an EICAR test file or a polyglot, Then `scan_state = quarantined`, the UI shows "File rejected by security scan", and the content operation returns `422 common.upload_quarantined`.
3. Given a `.pdf.exe` or `text/html`, Then `415 common.unsupported_media_type`; given 16 MB, Then `413 common.payload_too_large`.
4. Given a clean file, When I click preview, Then the file is streamed by `GET /v1/frontdesk/trf-attachments/{attachment_id}/content` through the BFF with `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`, no Storage URL ever reaches the browser, and an `access_log` row `trf.view` is written on every call (08 A13 P-2).
5. Given a phone JPEG carrying EXIF GPS tags, When I upload it, Then the stored object has no EXIF/GPS metadata (core re-encode with `stripMetadata`, 08 R12b).

**US-FD-10 Edit order items.**
1. Given a registered, invoiced cash order with no specimen received, When I add "TSH", Then a supplementary invoice is issued for TSH only, `frontdesk.order.items_changed.v1` is emitted with `added` = TSH and `items_version` 2.
2. When I remove "Lipid profile" (reason `patient_request`), Then the order item is `removed`, the event lists it under `removed`, and a billing `credit_note_required` task is opened for finance (the invoice line is not changed).
3. Given `LabPort.getOrderItemProcessingState` returns `removable: false` for the item, When I remove it, Then `409 frontdesk.order_not_editable`; other items stay removable and additions are still allowed (08 A13 D-5).

**US-FD-11 Cancel order.**
1. Given no approved results (`LabPort.getOrderResults` scope `approved` returns none), When I cancel with reason `patient_left`, Then status `cancelled`, `frontdesk.order.cancelled.v1` with `requires_credit_note: true` (because an invoice exists) and an open `credit_note_required` task in billing.
2. Given an approved result, Then `409 frontdesk.order_cancel_not_allowed`.
3. Given already cancelled, Then `409 frontdesk.order_already_cancelled`.
4. Given a credit-mode order whose charges are not yet billed, Then charges are voided in the same transaction and `requires_credit_note: false`.

**US-FD-12 Pre-registration from bookings / home visits.**
1. Given `engagement.booking.confirmed.v1` (fake producer) with `booking_kind = centre_visit`, Then a `pre_registered` order exists with `source = engagement_booking`, no event `frontdesk.order.created.v1`, no invoice; duplicate delivery of the same `event_id` creates nothing new.
2. When the patient arrives and I confirm, Then the order becomes `registered`, invoice + payment as in US-FD-03, and `frontdesk.order.created.v1` is emitted once.
3. Given `engagement.booking.cancelled.v1` for a `pre_registered` order, Then the order is `cancelled` (event emitted with `requires_credit_note: false`); for a `registered` order, Then an order flag `booking_cancelled_after_registration` is raised and the order is untouched.
4. Given the cancellation event arrives before the confirmation event (lower `aggregate.seq`), Then the later confirmation is ignored.
5. Given C17 calls `FrontdeskPort.createOrderFromBooking` twice with the same `idempotencyKey`, Then the same `orderId` is returned with `replayed: true`; with a new key and the same `sourceRefId`, Then `frontdesk.booking_already_converted`.
6. Given `engagement.booking.confirmed.v1` with `booking_kind = home_collection`, Then no order is created (inbox row only; C17 creates the order at assignment — 08 R7); given `engagement.booking.cancelled.v1` for such a booking whose `home_visit_id` links a `registered` order, Then an order flag `booking_cancelled_after_registration` is raised and the order is untouched.

**US-FD-13 Recollection notice.**
1. Given `lab.specimen.rejected.v1` with `recollection_required: true`, Then an order flag `recollection_required` appears on the front-desk worklist and `NotificationPort.sendSms` purpose `recollection_request` is queued (consent permitting) once per specimen.
2. Given duplicate delivery, Then no second flag or SMS.
3. Given `lab.specimen.status_changed.v1` with `to_status = recollection_ordered` for a specimen (with or without the `rejected` event first), Then exactly one open `recollection_required` flag exists for that specimen (08 A13 D-6).

**US-FD-14 Registration SMS.**
1. Given SMS consent and tenant SMS enabled, When an order registers, Then exactly one `NotificationPort.sendSms` with purpose `registration_confirmation`, idempotency key `<order_id>:registration_sms` and params from the declared non-PHI set only (no test names, no registration no).

**US-FD-15 Label print trigger.**
1. Given `label_autoprint = true`, When registration succeeds, Then the success panel calls C5's readiness operation `requestOrderLabelPrint` (retry on `409 common.version_conflict` every 1 s up to 10 s); after `200` it opens route `staff.lab.order_labels` (built with `@lims/shared-ts/routes`) in a print frame and shows "Labels ready — printing", or C5's error text. With the C5 mock, this is asserted via MSW (08 A13 D-4).

**US-FD-16 Anonymise patient.**
1. Given the last order of a patient is older than `retentionYears`, When a `tenant_admin` at aal2 anonymises, Then name/phone/email/address/DOB are replaced, consents set false, `anonymised_at` set, orders keep ids, the patient's TRF objects are deleted (rows kept, `is_active = false`; 08 A13 D-27 b / P-12 c), an `access_log` row `patient.anonymise` exists, and `audit.audit_log` holds no demographic value of the patient before or after (excluded columns, 08 A13 D-27 a); invoices keep their buyer snapshot (fiscal record, 04 L5).
2. Given the retention period has not elapsed, Then `409 frontdesk.retention_not_elapsed` [CR-C4-007].

### Billing (module `billing`)

**US-BL-01 Gapless chronological numbering.**
1. Given 200 concurrent registrations in one tenant, Then invoice numbers are 1..200 with no gap and no duplicate, and ordering by `invoice_seq` equals ordering by `issued_at`.
2. Given two tenants registering concurrently, Then each tenant's series is independent (both start at 1).
3. Given the B.S. fiscal year changes (Shrawan 1, Asia/Kathmandu), When the first invoice after midnight is issued, Then it carries the new `fiscal_year_bs` and `invoice_seq = 1`; an invoice whose allocation straddled midnight is retried, never numbered in the wrong FY.
4. Given the counter row is locked longer than the lock timeout, Then the registration service retries its transaction once; if that also times out, `503 billing.counter_busy` with `Retry-After` and nothing is stored (08 A13 D-25).
5. Given `invoice_series_scope = branch` (B6 alternative), Then each branch has its own gapless series; switching scope is allowed only before the first invoice of a fiscal year and only when `invoiceNoPattern` contains `{branch}` (else `400 common.validation_failed`, path `/invoice_series_scope`); if the pattern later loses `{branch}`, issuing fails with `409 billing.numbering_pattern_invalid` and nothing is stored (08 A13 D-23).

**US-BL-02 Immutability.**
1. Given an issued invoice, When any code path (incl. a direct SQL UPDATE as `lims_app`) changes a content column, Then the DB raises `immutable_row` (API: `409 billing.invoice_immutable`).
2. Given `lims_app`, Then `DELETE` privilege on every billing table is false (CI grant assertion).
3. Given the API, Then no endpoint exists that edits or deletes an invoice, credit note or ledger entry (spec lint: no PUT/PATCH/DELETE under `/v1/billing/invoices|credit-notes|ledger-entries`).

**US-BL-03 Print and reprint.**
1. Given `print_count = 0`, When the first print is requested, Then the print payload has `copy_mark` absent and `print_no = 1`.
2. Given `print_count ≥ 1`, When printed again (any reason, incl. printer jam), Then the payload carries `copy_mark = "Copy of Original / प्रतिलिपि"` and `print_no = n+1`; `print_log` has one row per print with user and time.
3. Given a cancelled invoice, When printed, Then it prints with a "CANCELLED" banner, cancellation date/reason and credit-note number, and still increments `print_count`.

**US-BL-04 Cancel invoice with credit note.**
1. Given an issued invoice and a `finance` user at aal2, When cancelling with reason `billing_error`, Then in one transaction: invoice `status = cancelled`, `is_active = false`, cancellation fields set, a full credit note `CN-…` (own gapless series) issued, `billing.invoice.cancelled.v1` and `billing.balance.changed.v1` emitted.
2. Given reason `other` without text, Then `422 billing.cancel_reason_required`.
3. Given already cancelled, Then `409 billing.invoice_already_cancelled`.
4. Given a `front_desk` user, Then `403 auth.forbidden`; given finance at aal1, Then `403 auth.mfa_required`.
5. Given a partially credited invoice, When cancelled, Then the credit note covers only the remaining uncredited amount.

**US-BL-05 Partial credit note.**
1. Given an open `credit_note_required` task for a removed item, When finance issues a partial credit note for that line, Then the credit note references the invoice line, the task resolves, the balance drops by the line net, and no invoice column except `credited_total_paisa`/`version`/`updated_*` changes.
2. Given the credit exceeds the line's remaining uncredited net, Then `400 common.validation_failed` (path `/lines/0/amount_paisa`; 08 A13 P-1).

**US-BL-06 Ledger reversal and refund.**
1. Given a mis-recorded cash entry, When finance reverses it with reason, Then a reversal row with negative amount references the original; a second reversal → `409 billing.ledger_reversal_invalid`.
2. Given a cancelled invoice paid NPR 2,250.00, When finance user F1 at aal2 requests a refund of NPR 2,250.00 cash, Then a `pending` refund request is stored and no ledger row exists; When a second finance user F2 at aal2 approves it, Then one `refund` ledger row (negative, `capture_kind = manual`, approver = F2, `refund_request_id` set) is stored and the balance event is emitted; a request or approval above the refundable amount → `409 billing.ledger_reversal_invalid` (08 A13 D-24).
3. Given F1 approves F1's own request, Then `403 billing.refund_self_approval_forbidden` and nothing changes. Given a `front_desk` user, When requesting a refund, Then `403 auth.forbidden`.
4. Given `lims_app`, Then UPDATE/DELETE on `billing.ledger_entries` is denied (REQ-SEC-057).

**US-BL-07 Hold-till-paid authority.**
1. The 10 BillingPort contract cases of 03-IC §4.4 pass against the real implementation.
2. Given finance creates a release override with reason for an order, Then `getReleaseEligibility` returns `eligible: true, basis: override, overrideId`.

**US-BL-08 Gateway payment safety net (Phase 1.5).**
1. Given C15 (fake) calls `recordGatewayPayment` inside its settle transaction (system actor), Then one ledger row with `capture_kind = gateway` and `collected_by_membership_id` NULL; the later `payments.intent.settled.v1` consumer finds it and does nothing else.
2. Given the event arrives but the port was never called (C15 crash between commit steps cannot happen because both are one transaction — test uses a fake that skips the call), Then the consumer records the ledger row idempotently.
3. Given a patient or portal actor calls any BillingPort method, Then `403 auth.forbidden` (08 R8). Given `allowExceedsDue = true` and an amount above the due, Then the full amount is recorded and a finance review item `gateway_payment_exceeds_due` is raised. Given C15 calls `recordGatewayRefund` twice with the same `refundId`, Then one refund row (`duplicate: true` on the second).
4. Pay by QR dialog (08 A19 D-113, CR-C15-016; PaymentProviderPort fake): Given B12, Then `createIntent` receives `returnUrl = cancelUrl = LIMS_FRONTDESK_PAYMENT_RESULT_URL`; given an eSewa `form_post` action, Then the dialog shows a QR of `launchUrl` and "Open on this PC" opens `launchUrl` in a new window, and no form is posted by C4; given "Cancel payment", Then the staff BFF calls C15 P24b and P5 (no C4 endpoint); given the fake throws `payments.amount_not_supported` or `payments.return_url_not_allowed`, Then B12 returns that code unchanged.

**US-BL-09 Home-collection payments.**
1. Given `homecollection.collection.synced.v1` with 1 cash payment, Then one ledger row with idempotency key = `client_mutation_id`, `capture_kind = home_collection`, collected by the phlebotomist membership; duplicate delivery adds nothing.
2. Given the payment exceeds the due, Then it is still recorded (money is physically collected) and a finance review item `home_payment_exceeds_due` is raised (resolved by refund or kept as advance).
3. Given the payment's `method_code` is inactive for the tenant (e.g. the lab deactivated `khalti`), Then the consumer does not fail and the event is not dead-lettered: the payment is recorded with that method and a finance review item `home_payment_method_inactive` [CONV] is raised in the same transaction (08 A19 D-128); a payment both over the due and on an inactive method raises one item of each kind.
4. Given the event carries the optional `booking_id` (visit of kind `booking`, 08 A19 D-120), Then it is processed exactly as without it (the field is ignored by C4).

**US-BL-10 Credit-party monthly bill.**
1. Given 12 uninvoiced charges for "Synthetic Corp" in A.D. month 2026-10, When finance generates the periodic invoice for that month and branch, Then one invoice with `credit_party_id`, `is_periodic_credit_bill = true`, `centre_id` NULL, the requested `branch_id`, one line per charge, all charges `invoiced`, and `billing.invoice.issued.v1` validates without `order_id`/`centre_id` (08 A13 D-1).
2. Given the month already billed (no uninvoiced charges), Then `409 billing.credit_period_already_billed` [CR-C4-007].
3. Given a payment from the credit party, Then a ledger row against that invoice; the statement shows invoiced, paid, credited and closing balance per month.
4. Given the oldest unpaid periodic invoice is older than the account's `credit_days`, Then the nightly job locks the account (`is_locked = true`, reason `credit_days_exceeded`) and new credit registrations fail with `billing.credit_party_locked`.
5. Given a credit order whose charges are already on a periodic invoice, When the order is cancelled, Then a credit-note task opens on that periodic invoice for those lines.

**US-BL-11 Daily cash and shift close.**
1. Given payments by 2 users with 3 methods, When finance opens the daily cash report for a B.S./A.D. date, Then totals per user × method (entries, reversals, gross, net) match the ledger exactly and equal `billing.v_pub_payment_collection`.
2. Given my open cash session, When I close it with counted cash NPR 10,450.00 and the system expects NPR 10,500.00, Then the session closes with variance −NPR 50.00 recorded; the next payment opens a new session.
3. Given a credit-party payment (B22) or a home-collection payment, Then it has no cash session and appears in daily cash only, never in a shift close.

**US-BL-12 Registers, audit trail, exports.**
1. Given invoices (incl. cancelled), When finance exports the sales register for FY 2082/83 as XLSX, XML and PDF, Then each contains: SN, B.S. date, A.D. date, invoice no, buyer name, buyer PAN, total, exempt, taxable, VAT, other tax (B7 column), status; cancelled invoices are present and marked.
2. Given the cancelled-invoice report, Then it lists number, date, reason, cancelled by, credit-note no.
3. Given the audit-trail report filtered by user, Then every issue/print/cancel/credit/reversal/refund/export/CBMS action of that user appears with timestamp and document no.
4. Given a range above the export limit (100,000 rows; 5,000 rows for PDF), Then `422 billing.export_too_large`.
5. Every export writes an `access_log` row (`data.export`) at creation and on every download; the file is downloaded only by streaming `GET /v1/billing/exports/{export_id}/content` (attachment, `nosniff`, `no-store`; never a Storage URL — 08 A13 P-2); `billing.data.export` is privileged (aal2).
6. Given a buyer name starting with `=`, `+`, `-` or `@`, When exported as XLSX, Then the cell is neutralised by `neutraliseFormula` (`@lims/shared-ts/spreadsheet`; 08 A13 P-9).
7. Given credit notes of both kinds in a date range, When B26 `getCreditNoteRegister` is read, Then each row has the published `CreditNoteRegisterRow` shape (TRD §5.2) and Σ `net` equals Σ `billing.credit_notes.net_paisa` for the same `issued_at` range and centre filter (C8 R1 reconciliation input).

**US-BL-13 CBMS sync (stub).**
1. Given tenant `ird.cbmsRealtimeRequired = true`, When an invoice is issued, Then a `billing.cbms_sync` job is enqueued in the same transaction; with the stub, a `cbms_submissions` row with outcome `stub_recorded` exists and `cbms_state` stays `pending` (never shown as synced).
2. Given a retryable failure from a (test) client, Then retries continue; after 10 failures an alert fires and the document stays `pending`/`failed` in the sweep queue.
3. Given `cbmsRealtimeRequired = false`, Then `cbms_state = not_required` and the document can be submitted later in bulk.
4. Cancellations and credit notes produce their own CBMS documents (REQ-ARCH-033).

**US-BL-14 Tax lines.**
1. Given a line with `vat_treatment = taxable`, net NPR 1,000.00, Then VAT = NPR 130.00 (13 %, 04 L14, half-up to the paisa).
2. Given `vat_treatment = exempt`, Then VAT 0 and the amount appears in the exempt column.
3. Given `otherTaxCode = HST` but no configured rate for `HST` in C3, Then `CatalogPort.priceFor` throws and registration fails with `422 catalog.tax_config_missing`, propagated unchanged (08 R18; never a guessed rate).
4. Golden tests cover 50 synthetic combinations (rounding, bill discount allocation, surcharge, exempt + taxable mix).

**US-BL-15 Isolatability.**
1. Given two tenants with billing data, When the per-tenant export task runs for tenant_a and the dump is restored into an empty database, Then row counts and checksums match tenant_a's source rows, zero tenant_b rows are present, and issuing the next invoice continues the series gaplessly.
2. CI asserts: no `SEQUENCE` objects in schema `billing`; every index and unique constraint on billing tables leads with `tenant_id` except the single-column `PRIMARY KEY (id)` (UUIDv7), and every such table also has `UNIQUE (tenant_id, id)` (08 A13 P-7).

**US-BL-16 No false compliance claims.**
1. A CI text scan over `apps/web/src/features/{frontdesk,billing}`, message catalogs and print templates fails on "IRD approved", "IRD-approved", "IRD certified", "approved by IRD", and on "commission" (case-insensitive).

## 9. Success metrics

| Metric | Target | Measurement |
|---|---|---|
| Returning-patient registration time (search → printed invoice), 3 items, cash | median ≤ 45 s, p90 ≤ 75 s [CONV] | UI timing events (no PHI) |
| Registration API p95 (≤10 items) | ≤ 600 ms (TRD §11 arithmetic) | `lims_http_request_duration_seconds{operation_id="createRegistration"}` |
| Invoice gaps / chronology violations | 0, ever | nightly `billing.integrity_check` |
| Duplicate patient rate | < 1 % of new patients flagged later by staff [CONV] | count of `duplicate_override` rows vs creations |
| Daily cash variance surfaced | 100 % of closed sessions show variance | cash sessions report |
| CBMS documents pending > 1 h (tenants with real-time duty) | 0 (once real client exists) | `lims_billing_cbms_pending_documents` |

## 10. Dependencies (contracts only)

| Contract | Direction | Fake until owner merges |
|---|---|---|
| `CatalogPort` (getTest, getPanel, resolveOrderables, priceFor incl. tax rates) + `getReferrer`, `getCreditParty({purpose:'billing'})` (CR-C4-002 merged into CR-C3-001); C3 HTTP search/quick-add operations | consume | `packages/fakes` CatalogPort fake; Prism/MSW for C3 HTTP |
| `IdentityPort` (assertRole, getActor, getTenantSettings, readBrandingAsset — any user/system actor, 08 A13 D-26) + `TenantSettings.branding`, `numbering.receiptNoPattern` (CR-C4-009 merged into CR-C2-008) | consume | fake |
| `NotificationPort.sendSms` + templates `registration_confirmation`, `recollection_request` [CR-C4-011] | consume | fake |
| `LabPort.getOrderResults` (scope `approved`), `LabPort.getOrderItemProcessingState` (CR-C4-003; removal guard and derived order status — 08 A13 D-5); C5 label readiness operation + route `staff.lab.order_labels` (CR-C4-010; D-4) | consume | fake / MSW |
| `PaymentProviderPort.createIntent` (`returnUrl = cancelUrl = LIMS_FRONTDESK_PAYMENT_RESULT_URL`, 08 A19 D-113), `verify`; C15 HTTP P5 `cancelPaymentIntent` + P24b `listPaymentCancelReasons` via the staff BFF (QR dialog cancel) | consume (Phase 1.5) | fake / MSW |
| `RenderPort.renderPdf` [CR-C4-004] — worker/system actor, returns PDF bytes stored by C4 in `billing-exports` | consume | fake returns a fixed PDF |
| `EngagementPort.getActiveMembership` (CR-C16-014) | consume | phase stub returns `undefined` until C16 ships (08 R9) |
| Core upload/storage API `ctx.uploads`/`ctx.files.scan`/`ctx.storage` (CR-C4-005 merged into CR-C2-011; bucket `frontdesk-trf`) | consume | C0 fake scanner/storage |
| Events in: 7 listed in S23 | consume | fake producers in tests |
| `FrontdeskPort` (consumers C5, C6, C10, C11, C13, C14, C15, C16, C17 — 08 A19 D-110), `BillingPort`, `BillingCommandPort` [CR-C4-001] | implement | — |
| Events out: `frontdesk.order.created.v1`, `frontdesk.order.items_changed.v1`, `frontdesk.order.cancelled.v1`, `billing.invoice.issued.v1`, `billing.balance.changed.v1`, `billing.invoice.cancelled.v1` | produce | — |

Final sweep 2026-11-06 — second touch applied (US-BL-08 AC4 D-113; US-BL-09 AC3–4 D-128/D-120; US-BL-12 AC7 B26 row shape; §6 FrontdeskPort consumers D-110).
