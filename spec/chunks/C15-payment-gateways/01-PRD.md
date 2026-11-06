# C15 — Payment Gateways — 01 PRD

Status: DECISION draft, 2026-11-06. Phase **1.5–2** (04 §12, 04 P2). Wave 2 (01-CHUNK-MAP §1).
Precedence: 00 → 04 → 03-IC → 01/02 (program) → this file. Names of events, ports, permissions, error codes and routes are used verbatim from `program/03-INTERFACE-CATALOG.md` (03-IC). Anything 03-IC lacks is marked **[CR-C15-nnn]** and specified in `02-TRD.md` § "Change requests raised"; this chunk is designed as if those CRs are accepted.

Abbreviations: 02-CV = `program/02-CONVENTIONS.md`; CM = `program/01-CHUNK-MAP.md`; C4-TRD = `chunks/C4-frontdesk-billing/02-TRD.md`.

## 1. Purpose

Labs in Nepal take payments by eSewa, Khalti and Fonepay QR (00 A9). In Phase 1 the operator only *records* that a patient paid by one of these methods (04 P1; C4 ledger). C15 adds the **live, verified** gateway integration behind the single in-process interface `PaymentProviderPort` (03-IC §4.9; 04 P2; REQ-ARCH-090):

- **eSewa ePay v2** and **Khalti KPG-2** — real implementations (04 P3, P4), re-verified against the primary docs on 2026-11-06 (see `02-TRD.md` §0 "Verification note").
- **Fonepay** — **BLOCKED B8** (04 P5). C15 ships only the adapter slot (always `payments.gateway_not_available`) and an interim **static-QR manual reconciliation** worksheet. Nothing about the Fonepay API is invented.

C15 guarantees that money is marked as received **only** after a server-to-server check with the gateway and an exact amount match (04 P7; REQ-SEC-047/048), that no retry, replayed callback or race creates two ledger rows (04 P6; REQ-SEC-050/051/053), that every day's gateway activity is reconciled (REQ-SEC-054; REQ-ARCH-089), and that refunds are privileged, two-person and audited (REQ-SEC-055; 04 A4).

The ledger itself stays in C4's `billing` schema (CM §3). C15 writes to it only through `BillingPort` (03-IC §4.4; X3).

## 2. Users and roles

Permission codes are from 03-IC §11. Codes marked [CR-C15-005] are requested additions.

| Actor | What they do in C15 | Permissions |
|---|---|---|
| `front_desk` (via C4's "Pay by QR" dialog, CM §5.1) | starts a gateway payment for an order, checks it, cancels an unpaid one | `payments.intent.create` (C4 checks it on its endpoints B12/B13; the dialog's "Cancel payment" calls C15 P5 `cancelPaymentIntent` and P24b `listPaymentCancelReasons` through the staff BFF, which check it themselves — 08 A19 D-113, CR-C15-016) |
| `finance` (MFA, 04 A4) | reviews held payments, re-checks, resolves; runs/reads reconciliation; requests and approves refunds; static-QR reconciliation | `payments.reconciliation.read` (privileged), `payments.intent.resolve` [CR-C15-005], `payments.refund.request` [CR-C15-005], `payments.refund.approve` [CR-C15-005] |
| `tenant_admin` (MFA) | configures per-tenant merchant accounts (eSewa product code + secret key, Khalti secret key + website URL), tests them, enables/disables gateways | `payments.merchant_config.read` [CR-C15-005], `payments.merchant_config.manage` [CR-C15-005] (privileged) |
| Patient (C16 app) | pays the due of their own order through a hosted gateway page | none in C15; C16 checks the patient's ownership in its own tables, then calls `PaymentProviderPort` from its worker as the engagement system actor (08 R8) |
| Patient (C6 web portal, report link) | pays the due of the order from the portal | none in C15; the portal actor creates a C6 `reporting.portal_payment_requests` row and C6's worker calls `createIntent`/`getIntent` as the reporting system actor (08 A11.1, CR-C15-010 ACCEPT-MODIFIED); portal actors never call the port |
| Gateway (eSewa / Khalti) via the patient's browser | redirects the browser back to C15's public callback routes | public routes resolved by a per-intent callback token [CR-C15-004]; no permission |
| `payments` system actor (worker) | polls open intents, expires them, reconciles daily, executes refunds | system permissions declared in the worker manifest [CR-C15-005] |
| Platform support (C2 support session) | read-only diagnosis inside a tenant | as granted to the support role; never merchant secrets (secrets are write-only) |

## 3. Problems this chunk solves

| # | Problem | Evidence |
|---|---|---|
| P-1 | A browser redirect or a gateway "success" screen is not proof of payment; trusting it gives free tests | 04 P3 (redirect is not proof), 04 P4 ("callback is not final validation"), REQ-SEC-047 |
| P-2 | Gateways and browsers retry; staff double-click; two QR scans race → double ledger rows or double settlement | REQ-SEC-050/051/053; 04 P6 |
| P-3 | Amount tampering / unit confusion (rupees vs paisa) | REQ-SEC-046/048; glossary "Paisa" |
| P-4 | Non-final statuses (eSewa `PENDING`, `AMBIGUOUS`/`AMBIGIOUS`, Khalti `Pending`, `Refunded`, unknown) must not auto-fail or auto-succeed | 04 P3, P4 |
| P-5 | Callbacks get lost (patient closes the tab) → money taken, order shows due | REQ-SEC-054; REQ-ARCH-089 |
| P-6 | Refunds are the classic insider-fraud path | REQ-SEC-055 |
| P-7 | Each lab has its own merchant account; a leaked secret lets attackers forge signed requests | REQ-SEC-058; 04 §11 |
| P-8 | Fonepay has no public API spec | 04 P5, B8 |

## 4. Scope

### 4.1 In scope (mapped to the client baseline)

| ID | Item | Client baseline (00) | 04 / REQ |
|---|---|---|---|
| S1 | `PaymentProviderPort` real implementation (`createIntent`, `verify`, `refund` + `getIntent`, `cancelIntent` [CR-C15-001]) | §2 A9 "Payment by … eSewa/Khalti/Fonepay QR, or part payment" | 03-IC §4.9; 04 P2; REQ-ARCH-090 |
| S2 | eSewa ePay v2 adapter: signed form, hosted launch page, success/failure callbacks, status check | §2 A9 | 04 P3; REQ-SEC-049 |
| S3 | Khalti KPG-2 adapter: server-side initiate, return callback, lookup | §2 A9 | 04 P4 |
| S4 | Fonepay adapter slot (always unavailable) + static-QR manual reconciliation worksheet | §2 A9 | 04 P5; B8 |
| S5 | Payment intents with idempotency key, one open intent per order, unique gateway reference, effects only on state transition | §2 A9 | 04 P6; REQ-SEC-050/051/053 |
| S6 | Server-to-server verification + exact amount match; hold + alert on mismatch | §2 A9; §2 D1 (hold-till-paid depends on correct balances) | 04 P7; REQ-SEC-046/047/048 |
| S7 | Settlement writes the ledger via `BillingPort.recordGatewayPayment` in the settle transaction and emits `payments.intent.settled.v1` (X3) | §2 A9, E7 (daily cash collection by method) | 03-IC §3.20, §4.4, X3 |
| S8 | Background polling, expiry, sweep of open intents | §2 A9 | REQ-SEC-054 |
| S9 | Daily reconciliation job + findings + finance resolution | §3 item 6 ("Accounting; Financing") | 04 P7; REQ-SEC-054; REQ-ARCH-089 |
| S10 | Held-for-review queue (finance, MFA) | §2 A9 | 03-IC §10.6; REQ-SEC-048 |
| S11 | Refund workflow: request → approve (two-person above threshold) → execute (manual merchant-dashboard refund confirmed by gateway status; Khalti refund API behind a flag, UNVERIFIED) → ledger refund row via `BillingPort.recordGatewayRefund` [CR-C15-002] | §2 A9 | REQ-SEC-055; 04 A4 |
| S12 | Per-tenant merchant accounts; secrets encrypted with a KEK from the secret store; write-only in the UI | §3 item 1 (multi-tenant) | REQ-SEC-058/128; 04 §11 |
| S13 | Public callback/launch/result routes reachable from the patient's browser on Nepal hosting; nginx/rate-limit/egress requirements handed to C1 [CR-C15-008] | 00 header (Nepal residency) | 03 §9.3; REQ-ARCH-087/088; REQ-SEC-052 |
| S14 | Hosted-redirect flow for the patient app (C16) and the web portal dues payment (C6 worker; 08 A11.1, CR-C15-010 ACCEPT-MODIFIED; C-04 closed YES) | §1 handwritten "Patient APP"; §3 items 5, 13 | 03-IC §4.9; REQ-SEC-059 |
| S15 | Staff web screens: held queue, intent detail, refunds, reconciliation, static-QR worksheet, merchant settings [CR-C15-007] | §2 E7; §3 item 6 | 02-CV §2.4 |
| S16 | User-manual pages + in-app help for every screen | §3 item 9 | 04 L26 ढ (program rule) |

### 4.2 Out of scope

| Item | Owner / reason |
|---|---|
| "Pay by QR" button and dialog on the registration page; staff endpoints `createPaymentIntent` (B12) / `verifyPaymentIntent` (B13) | C4 (CM §5.1; C4-TRD §5 B12/B13) |
| Ledger rows, balances, invoices, credit notes, manual (operator-recorded) payments incl. static-QR "fonepay_qr" entries | C4 (04 P1) |
| Patient app payment screens; portal pay-due page and `reporting.portal_payment_requests` | C16; C6 (08 A11.1) |
| Fonepay dynamic-QR API, signature, notification | BLOCKED B8 — no design beyond the slot |
| eSewa "Instant Payment Notification" (mentioned on the eSewa page, payload/config undocumented) and any gateway webhook | UNVERIFIED — no endpoint in v1 (see TRD §0) |
| NCHL NepalPay QR | not in 04 (glossary: not a Fonepay alias) |
| Card acquiring, wallet top-ups, payouts, settlement-to-bank reports, SaaS subscription billing of labs | not requested; CM §2 DROP list |
| Gateway mobile SDKs (Khalti Flutter/Android/iOS SDK) | not pinned in 04/02-CV; C16 uses the hosted redirect (S14) |
| nginx/infra configuration itself | C1 (C15 raises CR-C15-008) |
| DDL | C0 (`05-SCHEMA.md` here is the specification) |

## 5. User stories and acceptance criteria

Each AC is a test (05-DoD §2). Synthetic data only. Amounts: 1 NPR = 100 paisa.

### US-PG-01 eSewa checkout from the front desk (via C4)
As front desk, I want an eSewa payment for the order's due, so that the patient can pay by wallet.
1. Given order O with `BillingPort.getOrderBalance(O).balanceDue = 225000` paisa and an enabled eSewa merchant account, When C4 calls `createIntent({orderId:O, gateway:'esewa', idempotencyKey:K, returnUrl, cancelUrl})`, Then an intent with status `initiated` and `amount_paisa = 225000` exists, and `action.kind = 'form_post'` with `url` = the configured eSewa form URL, fields `amount = total_amount = "2250"`, `tax_amount = product_service_charge = product_delivery_charge = "0"`, `transaction_uuid` = the intent id, `signed_field_names = "total_amount,transaction_uuid,product_code"` and `signature` = Base64(HMAC-SHA256(secret, "total_amount=2250,transaction_uuid=<id>,product_code=<code>")) (04 P3), plus `launchUrl` [CR-C15-001].
2. Given the same call is repeated with the same `K`, Then the same intent and identical action are returned with `replayed: true`; no second row exists.
3. Given an open intent exists for O and a call arrives with a different key, Then `409 payments.intent_open_exists`.
4. Given `balanceDue ≤ 0`, Then `409 payments.nothing_due`.
5. Given the order is `cancelled` (FrontdeskPort), Then `409 payments.nothing_due`.
6. Given the tenant has no enabled eSewa account, Then `503 payments.gateway_not_available`.
7. Given `balanceDue = 225050` (fractional rupee) and `LIMS_PAYMENTS_ESEWA_ALLOW_FRACTIONAL_RUPEES = false`, Then `422 payments.amount_not_supported` [CR-C15-006] (decimal acceptance by eSewa UNVERIFIED).
8. Given a `returnUrl` whose origin/prefix is not on the allowlist, Then `422 payments.return_url_not_allowed` [CR-C15-006].
9. Given the client body contains an amount, Then it is rejected by schema (C4's endpoint does not declare one; the port has no amount input) (REQ-SEC-046).
10. Given `idempotencyKey = 'eng:<uuid>'` or any key matching `^[A-Za-z0-9_.:-]{1,200}$`, Then it is accepted; given a key with a space, `/` or more than 200 characters, Then `400 common.validation_failed` (port-key grammar, 08 A19 P-40).

### US-PG-02 Khalti checkout
1. Given due 225000 paisa and an enabled Khalti account, When `createIntent(gateway:'khalti')`, Then C15 sends `POST <khalti_base>/epayment/initiate/` server-side with header `Authorization: Key <secret>` and body `{return_url, website_url, amount: 225000, purchase_order_id: <intent id>, purchase_order_name: <tenant label>}` (no `customer_info`), stores `pidx`, `payment_url`, `expires_at`, sets status `initiated`, and returns `action = {kind:'redirect', url: payment_url}` and `expiresAt`.
2. Given due 900 paisa, Then `422 payments.amount_not_supported` without any call to Khalti (minimum 1000 paisa, 04 P4).
3. Given the initiate call times out or returns a validation error, Then `503 payments.gateway_not_available` and **no** intent row remains (transaction rolled back).
4. Given the initiate body, Then it contains no patient name, phone, email, test or panel names (04 §11 "order ref, amount" only).

### US-PG-03 eSewa return and verification
1. Given an `initiated` eSewa intent and a browser hit on its success callback with a correctly signed Base64 payload claiming `COMPLETE`, When the status check returns `{"status":"COMPLETE","totalAmount":2250.0,...}`, Then the intent becomes `settled`, `BillingPort.recordGatewayPayment` is called once in the same transaction, `payments.intent.settled.v1` is published with `verification_method = 'esewa_status_check'`, and the browser is redirected `303` to `returnUrl?intent_id=<id>&outcome=settled`.
2. Given a forged success payload (bad signature) and the status check returns `PENDING`, Then the intent is not settled, the callback row records `outcome_code = payments.signature_invalid`, a metric increments, and the browser is redirected with `outcome=pending`.
3. Given a correctly signed payload whose `signed_field_names` omits `total_amount`, Then it is treated as signature-invalid (REQ-SEC-049).
4. Given the status check returns `COMPLETE` with `totalAmount: 22.5` (mismatch), Then status `held_for_review`, `hold_reason = amount_mismatch`, no ledger write, a critical alert fires (REQ-SEC-048).
5. Given the status check returns `AMBIGUOUS` or `AMBIGIOUS`, Then `held_for_review` with `hold_reason = gateway_ambiguous` (both spellings, 04 P3).
6. Given the status check returns `{"code":0,"error_message":"Service is currently unavailable"}`, Then the intent status is unchanged, a poll job is scheduled, and the browser is redirected with `outcome=pending` (04 P3 "code: 0 = retry").
7. Given the same success callback is replayed 10 times, Then exactly one ledger call with `duplicate: false` exists, one event, one `settled` transition (REQ-SEC-051).
8. Given the failure callback, When the status check returns `CANCELED`, Then status `failed` and redirect to `cancelUrl?…&outcome=failed`; When it returns `NOT_FOUND` before the deadline, Then status stays `initiated`.
9. Given a front-desk intent whose `returnUrl` is C15's result page (`<PUBLIC>/v1/payments/result`, 08 A19 D-113), When the callback redirects to `…/v1/payments/result?intent_id=<id>&outcome=settled`, Then the result page answers `200` (the `intent_id` parameter is accepted and ignored, never echoed).

### US-PG-04 Khalti return and lookup
1. Given a Khalti return callback `?pidx=P&status=Completed&…` and lookup `{"status":"Completed","total_amount":225000,…}`, Then `settled` with `verification_method = 'khalti_lookup'` and `gateway_secondary_ref = transaction_id`.
2. Given the callback says `Completed` but lookup says `Pending`, Then `held_for_review` (`gateway_pending`) — the callback query never changes state (04 P4).
3. Given lookup returns HTTP 400 with body status `User canceled` or `Expired`, Then `failed` / `expired`; the HTTP status code is not used to decide (04 P4).
4. Given lookup returns HTTP 200 with `Refunded` or `Partially Refunded` for an unsettled intent, Then `held_for_review` (`gateway_refunded_before_settle`).
5. Given lookup returns an unlisted status string, Then `held_for_review` (`gateway_status_unknown`).
6. Given lookup returns `Initiated` before `expires_at + grace`, Then the intent stays non-terminal [CR-C15-001 contract-case refinement; 04 P4 as amended by 08 A19 D-114/A19.2 — pending founder sign-off F-08]; after the deadline → `held_for_review` (`gateway_initiated_after_expiry`).
7. Given the callback `pidx` differs from the intent's stored `pidx`, Then the stored `pidx` is used for lookup and the callback row records `outcome_code = payments.callback_mismatch` [CR-C15-006].

### US-PG-05 Patient closes the tab (polling, expiry, sweep)
1. Given an intent was created and no callback arrives, Then poll jobs run at +120 s, +300 s, +600 s, +1200 s, +2400 s [CONV] and a final check at `expires_at + 10 min` [CONV], each a server-to-server check with the same mapping as US-PG-03/04.
2. Given the final check finds eSewa `NOT_FOUND` / Khalti `Expired`, Then `expired`.
3. Given a poll job was lost, Then the 15-minute sweep finds open intents past their deadline and enqueues a final check (no intent stays open > deadline + 30 min).

### US-PG-06 Settlement and the ledger (X3)
1. Given a settle transition, Then `recordGatewayPayment({intentId, orderId, gateway, gatewayTxnRef, amount, verifiedAt})` is called inside the same transaction as the status update and the event insert; rolling back the transaction leaves no ledger row, no event and no status change.
2. Given `recordGatewayPayment` returns `duplicate: true`, Then the intent still settles once and the event carries the returned `ledger_entry_id`.
3. Given the order's due fell after the intent was created (e.g. a cash part payment), so `amount > balanceDue`, Then the intent becomes `held_for_review` with `hold_reason = exceeds_due` and no ledger write; finance can resolve with `record_exceeding_due` (US-PG-07 AC4).
4. Given `gateway_txn_ref`, Then it equals the eSewa `transaction_uuid` / Khalti `pidx` (03-IC §3.20).

### US-PG-07 Finance resolves held payments
1. Given finance at `aal2` with `payments.intent.resolve`, When they press "Re-check" on a held intent and the gateway now returns success with exact amount, Then `held_for_review → settled` with ledger + event.
2. Given they choose "Mark failed" with reason code `gateway_confirmed_unpaid`, Then `failed`; a later reconciliation that finds the money moves it back to `held_for_review` (`late_payment_found`) [CR-C15-003].
3. Given they choose "Settle" while the latest gateway check is not success + exact amount, Then `409 payments.intent_not_verifiable` [CR-C15-006]; finance can never settle without gateway confirmation.
4. Given `hold_reason = exceeds_due` and latest check success + exact amount, When they choose "Record anyway", Then `recordGatewayPayment` is called with `allowExceedsDue: true` [CR-C15-002] and C4 opens a finance review item; intent → `settled`.
5. Given a `front_desk` user or a session at `aal1`, Then `403 auth.forbidden` / `403 auth.mfa_required`.
6. Given the `If-Match` version is stale, Then `409 common.version_conflict`.
7. Given "Re-check" (P3) is pressed again within 10 s of the last gateway check, Then `429 common.rate_limited` with `Retry-After` and no gateway call (P3 is never forced; P4 `settle` always forces a fresh check).
8. Given an intent or refund has been `held_for_review` for more than 24 h, Then the sweep's gauge `lims_payments_held_for_review_oldest_age_seconds` exceeds 86400 and alert `PaymentsHeldForReviewStale` (warn) fires (02-TRD §11 "Alert rules for C1"; 08 A22.4).

### US-PG-08 Daily reconciliation
1. Given the cron at 20:40 UTC (02:25 Asia/Kathmandu) [CONV], Then for each tenant a run checks every intent that is open, held, settled within 2 days, or failed/expired within 7 days [CONV], plus refunds in `requested`/`held_for_review`, and records one `reconciliation_findings` row per discrepancy.
2. Given an `initiated` intent whose gateway now says success + exact amount, Then the run settles it (finding `missed_settlement`, `auto_action = settled`).
3. Given a `settled` intent whose gateway now says `FULL_REFUND`/`Refunded` and C15 has no completed refund, Then finding `gateway_refund_unrecorded` (critical); no automatic ledger change (glossary "Reconciliation never silently edits the ledger").
4. Given an `expired`/`failed` intent whose gateway says success, Then `→ held_for_review` (`late_payment_found`) [CR-C15-003] + critical finding.
5. Given a settled intent, Then the run calls `recordGatewayPayment` again; `duplicate: true` is the expected result; `duplicate: false` creates finding `ledger_entry_missing` (critical, `auto_action = ledger_repaired`); if the call throws `billing.payment_exceeds_due` (the due dropped meanwhile), Then finding `ledger_entry_missing` (critical, `auto_action = none`), no retry, and the rest of the run continues (savepoint, 08 A19 P-44).
6. Given the run has not completed for a tenant within 26 h, Then alert `PaymentsReconciliationMissing` (page) fires; given a run stays `running` with no update for more than 2 h, Then `lims_payments_reconciliation_stalled_runs` > 0 and `PaymentsReconciliationStalled` (warn) fires (02-TRD §11 "Alert rules for C1"; 08 A22.4).
7. Given finance opens the run, Then counts (checked, ok, findings by kind) and each finding with intent link are listed; resolving a finding needs `payments.intent.resolve` + reason.
8. Given a cron run at 02:25 Asia/Kathmandu, Then its `business_date` is the previous Kathmandu date; a manual run (P14) uses the current date.
9. Given a refund still not visible at the gateway, Then each run increments its `unconfirmed_run_count` and the second such run creates finding `refund_unconfirmed`.

### US-PG-09 Refunds
1. Given a settled Khalti intent of 225000 paisa whose order is overpaid by 225000 (`balanceDue = −225000` after C4 cancelled the invoice), When finance A requests a refund of 225000 with reason `test_cancelled`, Then a refund row `pending_approval` exists.
2. Given amount > captured − already refunded, Then `422 payments.refund_exceeds_captured`; given amount > max(0, −balanceDue), Then `422 payments.refund_exceeds_captured` with detail "exceeds refundable balance".
3. Given tenant threshold `refund_two_person_threshold_paisa = 0` (default), When finance A approves their own request, Then `403 payments.refund_self_approval_forbidden` [CR-C15-006]; When finance B (aal2) approves, Then the refund moves to `requested` (manual mode) and `PaymentProviderPort.refund` returned `status: 'requested'`.
4. Given manual mode, When finance confirms with the gateway refund reference, Then C15 checks the gateway (eSewa `FULL_REFUND`/`PARTIAL_REFUND`; Khalti `Refunded`/`Partially Refunded` or lookup `refunded`) and on confirmation marks the refund `completed`, calls `BillingPort.recordGatewayRefund` [CR-C15-002] once (idempotent on refund id), and sets the intent `refunded` or `partially_refunded`.
5. Given the gateway does not (yet) show a refund, Then the refund is `held_for_review` and re-checked by the daily run; no ledger row is written.
6. Given `refund()` is called without an approved approval id, Then `403 payments.refund_requires_approval`.
7. Given the tenant has not enabled Khalti API refunds (default; refund API method/auth/units UNVERIFIED), Then no refund API call is ever made.
8. Given the same idempotency key is reused for a different refund body, Then `422 common.idempotency_key_reused`.
9. Given a manual refund in `requested` or `held_for_review` and the gateway confirms no refund, When finance at aal2 with `payments.refund.approve` calls P11b with reason `gateway_confirmed_not_refunded`, Then the refund becomes `failed`, no ledger row is written and a new refund request for the intent is possible; When the gateway shows a refund, Then `409 payments.refund_not_allowed` and nothing changes.
10. Given a refund in `requested`/`held_for_review`, When finance with `payments.intent.resolve` presses "Re-check" (P7b), Then the gateway is checked in-request and the refund becomes `completed` (with the ledger call) or stays/turns `held_for_review`; a second press within 10 s → `429 common.rate_limited`.

### US-PG-10 Merchant accounts
1. Given tenant admin at aal2 saves an eSewa account with product code and secret key, Then the secret is stored only as AES-256-GCM ciphertext under the active KEK id; no API response, log, metric or audit row contains it; the screen shows only "Set on <date> · fingerprint ab12cd34".
2. Given "Test connection", Then eSewa: a status check for a random UUID returning a documented JSON body counts as reachable (note: this cannot prove the secret; the screen says so); Khalti: a lookup for a random pidx returning `{"detail":"Not found."…}` = `200 {outcome: reachable_key_valid}`, `{"detail":"Invalid token.","status_code":401}` = `200 {outcome: auth_failed}`; every outcome is stored in `last_test_outcome` (no error code is returned for a rejected key).
3. Given a production deployment (`LIMS_PAYMENTS_GATEWAY_ENV = production`), When an account is saved with environment `uat` or eSewa product code `EPAYTEST`, Then `400 common.validation_failed` (REQ-SEC-058/136; 08 A13 P-1).
4. Given a Fonepay account, Then it can be stored disabled only; enabling → `503 payments.gateway_not_available` while B8 is open (03-IC §8 `http: 503`).
5. Given a user without `payments.merchant_config.manage`, Then `403 auth.forbidden`.

### US-PG-11 Patient app hosted redirect
1. Given the C16 worker (engagement system actor, 08 R8) calls `createIntent` with `returnUrl = <portal origin>/app/payments/<payment_request_id>/done`, Then the allowlist accepts it and the action is returned; the app opens `launchUrl` (eSewa) or `action.url` (Khalti) in the system browser.
2. Given payment completes, Then the gateway redirects to C15's callback, C15 verifies server-side, and redirects to the app link with `intent_id` and `outcome`; the app shows "Paid" only after C16's `payment_requests` row (refreshed by its worker through `getIntent` [CR-C15-001]) reports `settled` (REQ-SEC-059).
3. Given the outcome query parameter is edited to `settled` by the user, Then nothing changes server-side.
4. Given a patient or portal actor context, When any `PaymentProviderPort` method is called, Then it is refused with `auth.forbidden` (callers staff/system only — 08 R8).

### US-PG-11b Web-portal dues payment (C6 worker; 08 A11.1, CR-C15-010 ACCEPT-MODIFIED)
1. Given the C6 worker (reporting system actor) calls `createIntent({orderId, gateway, idempotencyKey, returnUrl: '<PORTAL>/r/payments/<portal_payment_request_id>/done', cancelUrl: same})`, Then the default allowlist entry `${LIMS_ORIGIN_PORTAL}/` accepts it, the amount is C15's own `getOrderBalance` read (no amount input), and the action is returned.
2. Given payment completes, Then C15 settles it with `BillingPort.recordGatewayPayment` inside the settle transaction (08 A19 D-115; C4's `payments.intent.settled.v1` consumer is the safety net) and redirects the browser `303` to `<PORTAL>/r/payments/<id>/done?intent_id=<id>&outcome=<outcome>`.
3. Given the C6 worker calls `getIntent`, Then it receives the stored status without a gateway call; C6 shows "Paid" only from that server state (REQ-SEC-059).
4. Given a portal actor context calls any port method, Then `auth.forbidden` (08 R8).
5. Given C15 is not yet deployed, Then the C0 phase stub reports `payments.gateway_not_available` and the portal shows no payment button (08 A11.1).

### US-PG-12 Fonepay (blocked) and static QR
1. Given `createIntent(gateway:'fonepay')`, Then `503 payments.gateway_not_available` (03-IC §4.9; B8).
2. Given finance enters a business date, optional centre and the bank-statement Fonepay QR total, Then C15 shows the system total of ledger entries with method `fonepay_qr` for that date/centre from `billing.v_pub_payment_collection` [CR-C15-009], the difference, and stores the worksheet row; a non-zero difference requires a note to be accepted.
3. Given any Fonepay UI text, Then it says "Fonepay live payments are not available yet" — never implies verification.

### US-PG-13 Cancel an unpaid intent
1. Given an `initiated` Khalti intent, When the operator cancels, Then C15 first looks it up: `Completed` + match → settles instead (and says so); otherwise → `failed` (`abandoned`), and a final check is still scheduled at `expires_at + grace` because a Khalti link stays payable until it expires (no cancel API documented).
2. Given a cancelled intent, Then a new `createIntent` for the order succeeds (the open-intent slot is free).
3. Given a `front_desk` user (holds `payments.intent.create`, not `payments.reconciliation.read`), When C4's dialog calls P24b `listPaymentCancelReasons` and P5 `cancelPaymentIntent` through the staff BFF, Then both succeed; P24 `listPaymentCodes` returns `403 auth.forbidden` for that user (one permission floor per operation, 08 A19 P-43).

### US-PG-14 Tenant isolation
1. Given a tenant-A user, When calling any C15 endpoint with tenant-B intent/refund/run/finding/account ids, Then `404 common.not_found` and no B data or side effect.
2. Given a callback token of a tenant-B intent, Then it resolves only to tenant B; no tenant-A data is readable through it.
3. Given SQL as `lims_app` with tenant-A claims, Then `SELECT` on every `payments.*` table returns zero B rows; `INSERT` with B's `tenant_id` fails.

### US-PG-15 Environment separation
1. Given a non-production deployment, Then gateway base URLs are the UAT/sandbox URLs and boot fails if a production URL is configured (REQ-SEC-136).
2. Given production, Then boot fails if a sandbox URL is configured or the KEK file is missing.

## 6. Success metrics

| Metric | Target | Source |
|---|---|---|
| Settlements without a server-to-server success + exact amount | 0 (hard invariant, tested) | 04 P7 |
| Duplicate ledger rows from gateway paths | 0 | 04 P6 |
| Settled intents without a ledger row at the next daily run | 0 (finding `ledger_entry_missing` alerts) | X3 |
| Daily reconciliation completed per tenant | ≥ 99 % of days; alert after 26 h | REQ-SEC-054 |
| Open intents past deadline + 30 min | 0 | US-PG-05 |
| Held intents resolved | median ≤ 1 business day [CONV target, not an SLA] | REQ-SEC-048 |
| `createIntent` p95 | ≤ 1.5 s; `verify` p95 ≤ 3 s | 03-IC §4.9 |

## 7. Phase

Phase 1.5–2 (04 §12). REQ-SEC §2 applies from this phase (04 §12 rule). Until C15 merges, C0's phase stub returns `payments.gateway_not_available` (C0 TRD §9, CR-C0-010) and C4's "Pay by QR" stays feature-flagged off. Stub replacement follows 08 A17 P-20: the first PR that creates `services/api/src/modules/payments/` removes `PaymentProviderPort` from `phase-stubs.ts` and registers C15's own implementation, which returns exactly the stub results for every method not yet built (PG-T01).

## 8. Dependencies (contracts only)

| Contract | Direction | Until real | Notes |
|---|---|---|---|
| `PaymentProviderPort` (03-IC §4.9) + CR-C15-001 | implement | — | consumers C4 (staff), C6 (reporting worker, system actor; `createIntent`/`getIntent` — 08 A11.1, CR-C15-010 ACCEPT-MODIFIED), C16 (engagement worker, system actor) — callers staff/system only (08 R8). Port `idempotencyKey` grammar `^[A-Za-z0-9_.:-]{1,200}$` (08 A19 P-40) |
| `BillingPort.getOrderBalance`, `recordGatewayPayment` (03-IC §4.4) + `recordGatewayRefund`, `allowExceedsDue` [CR-C15-002] | consume | `packages/fakes` BillingPort fake | C4 already lists `recordGatewayRefund` as a planned CR (C4 06-PLAN) |
| `FrontdeskPort.getOrderSummary` (03-IC §4.3) | consume | fake | branch/centre/status of the order; C15 declared as consumer by CR-C15-014 (08 A19 D-110 / P-46) |
| `IdentityPort.assertRole`, `getActor`, `getTenantSettings(['timezone'])` (03-IC §4.6) | consume | fake | |
| Event `payments.intent.settled.v1` (03-IC §3.20) | produce | — | consumer C4 |
| View `billing.v_pub_payment_collection` (03-IC §6.2) | read | seeded view | consumer addition [CR-C15-009] |
| C0 core: callback auth resolver + DEFINER lookup [CR-C15-004]; idempotency hook; `ctx.noRetry()` | consume | — | |
| C1: public routes, rate limits, log masking, egress allowlist, KEK in SOPS [CR-C15-008] | consume | dev stack | |

## 9. Blocked and unverified items (with the default built meanwhile)

| Item | Status | Default built |
|---|---|---|
| Fonepay API / signature / notification | BLOCKED B8 (04 P5) | adapter throws `payments.gateway_not_available`; static-QR worksheet (US-PG-12) |
| eSewa UAT **form** URL | UNVERIFIED (04 P3; still absent from the page 2026-11-06) | no default: `LIMS_PAYMENTS_ESEWA_FORM_URL` must be set explicitly for UAT; boot fails if empty |
| eSewa success-redirect query parameter name | UNVERIFIED (page: "response parameters encoded in Base64", name not given) | route accepts optional `data`; verification never depends on it (status check always runs); UAT task PG-T21 confirms |
| eSewa status-check HTTP method | UNVERIFIED (page shows URLs with query strings, method not stated) | `GET`; UAT task confirms |
| eSewa acceptance of fractional rupee amounts | UNVERIFIED | fractional dues refused for eSewa (`payments.amount_not_supported`) behind a flag |
| eSewa Instant Payment Notification | UNVERIFIED (mentioned, not documented) | not implemented |
| eSewa refund API | not documented → none | manual refund confirmed by status check |
| Khalti refund API (`/api/merchant-transaction/{transaction_id}/refund/`) method, auth, amount unit | UNVERIFIED (page omits method/auth; paisa note conflicts with example) | adapter written but disabled per tenant by default; manual refund default |
| Khalti link expiry (60 min "default" vs sample 1800 s) | documented conflict | always use the returned `expires_at` |
| Khalti `Initiated` non-terminal before `expires_at` + grace | 04 P4 amended by 08 A19 D-114/A19.2; founder sign-off pending (F-08) | built as amended (US-PG-04 AC6) |
| Khalti webhook | none documented | lookup-pull model only |
| Whether eSewa/Khalti merchant dashboards support the refunds finance performs manually | eSewa UNVERIFIED; Khalti: "You can refund the payment to the user from your dashboard" (docs.khalti.com/gotchas) | manual confirmation requires gateway status evidence |
| B15 retention | BLOCKED | payment records kept ≥ 5 years (financial audit) per tenant config |
