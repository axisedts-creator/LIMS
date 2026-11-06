# C15 — Payment Gateways — 04 UI/UX (staff screens, public pages, consumer guide, runbooks)

Status: DECISION draft, 2026-11-06. Staff screens exist under `apps/web/src/{app/(staff),features}/payments/` once CR-C15-007 is accepted. Components only from `@lims/ui` (C0 04-UI-UX §2). Missing component → CR (CR-C15-011 `SecretField`). Message keys `payments.<screen>.<key>` (02-CV §13). English v1.

The registration-page "Pay by QR" dialog is **C4's** (CM §5.1; C4 04-UI-UX §3.6). C15 only supplies the data it shows.

## 1. Navigation (`apps/web/src/features/payments/nav.manifest.ts`)

| id | label key | routeId | permission | group | order | chord | phase |
|---|---|---|---|---|---|---|---|
| `payments.review` | `payments.nav.review` "Payment review" | `staff.payments.review` | `payments.reconciliation.read` | billing | 60 | `g y` | 1.5 |
| `payments.refunds` | `payments.nav.refunds` "Gateway refunds" | `staff.payments.refunds` | `payments.reconciliation.read` | billing | 61 | — | 1.5 |
| `payments.reconciliation` | `payments.nav.reconciliation` "Gateway reconciliation" | `staff.payments.reconciliation` | `payments.reconciliation.read` | billing | 62 | — | 1.5 |
| `payments.static_qr` | `payments.nav.static_qr` "Fonepay QR worksheet" | `staff.payments.static_qr` | `payments.reconciliation.read` | billing | 63 | — | 1.5 |
| `payments.settings` | `payments.nav.settings` "Payment gateways" | `staff.payments.settings` | `payments.merchant_config.read` | billing | 64 | — | 1.5 |

Chord `g y` chosen as unlikely to collide [CONV]; the build check rejects duplicates.

## 2. Screens

Every page: `PageHeader` with `helpKey` (help file in `features/payments/help/`), `loading.tsx` (`LoadingSkeleton`) and `error.tsx` (`ErrorState` with request id). States per `03-APP-FLOW.md` §3. Dates via `DateText` (tenant `calendarDisplay`); money via `MoneyText` (grouping `lakh` [CONV]); ids via `IdText`; statuses via `StatusChip kind="payment_intent"` (C0 mapping: created/initiated/pending info, settled success "Paid", failed/expired danger, held_for_review warning "Under review", refunded/partially_refunded neutral) and `StatusChip kind="generic"` for refunds/findings.

### 2.1 Payment review queue — `/payments/review`

Layout: `PageHeader` title "Payment review", actions: none. `FilterBar` + `DataTable`.

Filters:
| id | kind | options | default |
|---|---|---|---|
| `status` | select multiple | `held_for_review` "Under review", `pending` "Waiting for provider", `initiated` "Started", `failed`, `expired`, `settled` "Paid" | `held_for_review` |
| `gateway` | select multiple | eSewa, Khalti, Fonepay (disabled entry "Fonepay — not available yet") | all |
| `hold_reason` | coded `payments.hold_reasons` | from P24 | all |
| `created` | date_range (max 31 days [CONV]) | — | last 7 days |
| `centre` | select | centres the user can see | all |

Columns: Created (`DateText withTime`, sort key `created_at`) · Gateway · Amount (`MoneyText`, align end) · Status (`StatusChip`) · Reason (hold/failure reason display) · Last checked (`DateText withTime`) · Order (`IdText` link to `staff.frontdesk.order`) · Intent (`IdText`). Row action (Enter): open detail. `caption` "Payments needing review". Empty: title "No payments need review." body "Held payments appear here when a provider answer needs a person." Page size 50.

Keyboard: `Alt+R` focuses filters reset [CONV]; table keys per kit.

### 2.2 Intent detail — `/payments/intents/{intent_id}`

Regions: header (status chip, amount, gateway, actions) · `DescriptionList` (2 columns) · `Tabs`: Timeline · Provider checks · Callbacks · Refunds.

DescriptionList terms: "Order" (link), "Centre", "Amount", "Provider reference" (`gateway_txn_ref`, `IdText copyable`), "Provider transaction" (`gateway_secondary_ref`), "Created", "Expires", "Paid at", "Verified amount", "Verification" (eSewa status check / Khalti lookup), "Hold reason", "Ledger entry" (`IdText`, link to C4 order billing), "Refunded".

Actions (shown only with `payments.intent.resolve`, enabled per state):
| Button | Variant | Enabled when | Behaviour |
|---|---|---|---|
| "Re-check with provider" (`Alt+C`) | secondary | status ∈ initiated, pending, held_for_review | P3; toast "Checked: <status label>"; 429 → toast "Checked a moment ago. Try again in a few seconds." |
| "Mark as paid" | primary | held_for_review | `ConfirmDialog` title "Mark payment as paid?" body "The provider will be checked again. The payment is marked paid only if the provider confirms it with the exact amount." `requireReason` coded `payments.resolution_reasons` (free text max 500, optional) → P4 `settle` |
| "Record although it exceeds the due" | secondary | held_for_review and hold_reason = exceeds_due | `ConfirmDialog` body "The provider confirmed NPR {amount}. The order now owes less. The full amount will be recorded and Finance will get a review item to refund or keep as advance." → P4 `record_exceeding_due` |
| "Mark as failed" | danger | held_for_review | `ConfirmDialog tone=danger` body "Only do this if the provider confirmed that no money was taken." requireReason (`resolution_reasons`, free text required when code `other`) → P4 `fail` |
| "Cancel payment" | ghost | initiated, pending | `ConfirmDialog` body "We check with the provider first. If the patient already paid, the payment is recorded instead." requireReason `payments.cancel_reasons` → P5 |
| "Request refund" | secondary | settled, partially_refunded; with `payments.refund.request` | opens Refund dialog §2.3.1 |

Errors mapped: `payments.intent_not_verifiable` → inline `Banner tone=warning` "The provider has not confirmed this payment (latest answer: {status}). It cannot be marked paid." · `common.version_conflict` → `Banner` "This payment changed. Reload to see the latest." with Reload action · `auth.mfa_required` → shell step-up.

Timeline tab: `Timeline` items from `transitions` (label = "Under review — amount mismatch", actor type text "System"/"Staff"; 08 R8). Provider checks tab: `DataTable` (When, Operation, Outcome, Provider status, HTTP status); Callbacks tab: (When, Kind, Outcome, Signature valid). No raw payloads, no URLs, no tokens.

### 2.3 Refunds — `/payments/refunds`

Filters: status (pending_approval "Waiting for approval", approved, requested "Refund in progress", held_for_review "Under review", completed, failed, rejected), gateway, created range. Columns: Requested (date), Gateway, Amount, Status, Mode ("Manual" / "Provider API"), Requested by, Approved by, Reason under review (`held_reason` display from `payments.refund_hold_reasons`), Intent (link). Row actions per state:

| Action | Permission | When | Dialog |
|---|---|---|---|
| Approve | `payments.refund.approve` | pending_approval and requester ≠ me (or amount ≤ threshold) | `ConfirmDialog` "Approve refund of NPR {amount}?" body lists mode-specific next step ("Refund the patient in the {gateway} merchant dashboard, then confirm here." / "The refund will be sent to Khalti automatically.") optional note ≤ 500 → P9 |
| Reject | `payments.refund.approve` | pending_approval | `ConfirmDialog tone=danger` requireReason `payments.refund_reject_reasons` → P10 |
| Confirm refund done | `payments.refund.approve` | requested / held_for_review, mode manual | Dialog §2.3.2 |
| Re-check | `payments.intent.resolve` | requested / held_for_review | P7b `recheckPaymentRefund` (in-request refund check); toast "Checked with {gateway}: {status label}"; `429 common.rate_limited` → toast "Checked a moment ago. Try again in a few seconds." |
| Mark refund failed | `payments.refund.approve` | requested / held_for_review | `ConfirmDialog tone=danger` title "Mark this refund as failed?" body "We check with {gateway} first. Only do this if {gateway} confirmed that no refund was made. No ledger entry is written, and a new refund can be requested." `requireReason` coded `payments.refund_fail_reasons` (free text ≤ 500, required when the code needs text) → P11b; `payments.refund_not_allowed` → banner "{gateway} shows a refund for this payment. Use Re-check instead." |

Own requests: Approve button disabled with `Tooltip` "A second person must approve this refund." (`payments.refund_self_approval_forbidden` also mapped to this text.)

#### 2.3.1 Request refund dialog (from intent detail)

| Field | Component | Validation | Required | Default |
|---|---|---|---|---|
| Amount | `MoneyField` | 1 paisa … min(captured − refunded, refundable); helper text "Refundable now: NPR {x} (captured {c}, already refunded {r}, order overpaid by {o})" | yes | refundable amount |
| Reason | `CodedSelect codedSet="payments.refund_reasons"` | active codes | yes | — |
| Details | `TextArea maxLength=500` | required when reason `other` | conditional | — |

Submit "Request refund" (`Ctrl+Enter`) → P8 with Idempotency-Key = UUIDv7 generated when the dialog opens (re-used on retry). Errors: `payments.refund_exceeds_captured` → field error on Amount "More than can be refunded (max NPR {x})"; `payments.refund_not_allowed` → banner "A refund is already in progress for this payment."

#### 2.3.2 Confirm manual refund dialog

| Field | Component | Validation | Required |
|---|---|---|---|
| Provider refund reference | `TextField maxLength=100` | `^[A-Za-z0-9_.:/-]{1,100}$` | yes |
| Refunded on | `DatePicker` | ≤ today, ≥ refund approved date | yes |

Result: `completed` → toast success "Refund confirmed by {gateway} and recorded."; `held_for_review` → toast warning "{gateway} does not show this refund yet. We will check again tonight."

### 2.4 Gateway reconciliation — `/payments/reconciliation`

`Tabs`: Runs · Open findings.
- Runs: columns Business date, Trigger (Nightly/Manual), Status, Checked, OK, Findings, Critical, Finished. Header action "Run now" (`payments.intent.resolve`) → P14 → toast "Reconciliation started."; `payments.reconciliation_in_progress` → toast "A reconciliation is already running."
- Open findings: `FilterBar` (kind coded `payments.finding_kinds`, severity), columns Found (date), Severity (`StatusChip generic`: critical → tone danger "Critical", warning → warning, info → neutral), Kind (display), Intent (link), Our status, Provider status, Our amount, Provider amount, Automatic action ("Marked paid", "Put under review", "Ledger repaired", "—"). Row action "Resolve" → `ConfirmDialog` requireReason `payments.finding_resolutions` (free text max 1000, required for `other`) → P16.
- `StatTile` row above tabs: "Last successful run" (date/time), "Open critical findings", "Payments under review".

### 2.5 Fonepay QR worksheet — `/payments/static-qr`

`Banner tone=info` (always): "Fonepay live payments are not available yet. Use this worksheet to compare Fonepay QR payments recorded at the counter with your bank statement."
Form:
| Field | Component | Validation | Required | Default |
|---|---|---|---|---|
| Business date | `DatePicker` | ≤ today | yes | yesterday |
| Centre | `Select` (centres in scope + "All centres") | — | yes | All centres |
| System total | read-only `MoneyText` + entries count (P18, refreshed on date/centre change) | — | — | — |
| Bank statement total | `MoneyField` | ≥ 0 | yes | — |
| Statement reference | `TextField maxLength=100` | — | yes | — |
| Difference | read-only `MoneyText` (danger tone text "Difference" when ≠ 0) | — | — | — |
| Note | `TextArea maxLength=1000` | required when difference ≠ 0 | conditional | — |
Submit "Save worksheet" → P19. `payments.static_qr_already_reconciled` → banner "This date and centre were already reconciled." List below: date, centre, system, statement, difference, status, by.

### 2.6 Payment gateways (settings) — `/payments/settings`

`Banner tone=neutral`: "Environment: {UAT/Production}". One `Card` per gateway for the deployment's environment (the other environment is not shown):

eSewa card:
| Field | Component | Validation | Required |
|---|---|---|---|
| Enabled | `Switch` | requires secret + product code | — |
| Product code | `TextField maxLength=64` | `^[A-Za-z0-9_-]+$`; production rejects `EPAYTEST` | when enabled |
| Secret key | `SecretField` (CR-C15-011) `maxLength=256` | 1–256 | when not yet set |

Khalti card: Enabled · Website URL (`TextField maxLength=300`, https URL; help "Khalti requires your website address.") · Secret key (`SecretField`) · "Use Khalti refund API" (`Switch`, default off, description "Only after the LIMS provider has confirmed the refund API in the sandbox. Otherwise refunds are done in the Khalti dashboard.").

Fonepay card: all inputs disabled; text "Waiting for the Fonepay merchant integration document from your bank (blocker B8)."

Card actions: "Save" (P21; `If-Match` from the card's `version`) · "Test connection" (P22). Test outcome texts: `reachable_key_valid` success "Khalti accepted the key."; `reachable_key_unverifiable` info "eSewa is reachable. eSewa does not let us check the secret key without a real payment — make a small test payment in UAT before going live."; `auth_failed` danger "The provider rejected the key."; `unreachable` danger "Could not reach the provider. Try again later."

Settings card "Refunds and labels" (`payments.merchant_config.manage`): Two-person threshold (`MoneyField`, ≥ 0, description "Refunds above this amount always need a second approver. 0 = always."), Order label sent to Khalti (`TextField maxLength=50`, pattern `^[A-Za-z0-9 .,&()-]+$`, description "Shown to the patient on the Khalti page. Do not include patient or test names."), Nightly reconciliation (`Switch`).

The secret is never displayed, copied or pre-filled; after save the field shows "Set on {date} · fingerprint {8 hex}" and an empty input labelled "Replace secret key".

## 3. Public pages (served by the API, P30/P34)

| Page | Content | Rules |
|---|---|---|
| Launch | Lab display name (tenant `display_name` via `ctx.core`), heading "Continue to eSewa", amount "NPR 2,250", one button "Continue to eSewa", small text "You will enter your eSewa ID on eSewa's page." | plain HTML, inline minimal CSS, no JS, no external assets, `lang="en"`, button ≥ 44 px, works at 320 px width, CSP per TRD §7.2.3 |
| Result | text per outcome (TRD §7.5); no lab name, no amount | same |

Amount on the launch page is not PHI (it is the due of an order the bearer of the link is paying); no name, test or order number is shown.

## 4. Consumer guide (for C4, C6 and C16 developers)

```ts
// C4: inside a staff handler/service after assertRole(payments.intent.create);
// C16: inside its worker task as the engagement system actor, after it checked the patient's ownership (08 R8).
// C6: inside its portal dues-payment worker as the reporting system actor; createIntent/getIntent only (08 A11.1);
//     returnUrl = cancelUrl = `${origins.portal}/r/payments/${portalPaymentRequestId}/done` (route portal.payment_done).
// Patient/portal request contexts never call this port (→ auth.forbidden).
// idempotencyKey: port-key grammar ^[A-Za-z0-9_.:-]{1,200}$ (08 A19 P-40), built as '<prefix>:<id>' (e.g. 'eng:' + paymentRequestId);
//     an HTTP Idempotency-Key header value also matches it.
const intent = await ctx.ports.PaymentProviderPort.createIntent(ctx, {
  orderId, gateway: 'khalti',
  idempotencyKey: req.headers['idempotency-key'],              // reuse the client's key; never generate per retry
  returnUrl: `${origins.portal}/app/payments/${pendingId}/done`, // must match LIMS_PAYMENTS_RETURN_URL_ALLOWLIST
  cancelUrl: `${origins.portal}/app/payments/${pendingId}/done`,
});
// eSewa: show intent.action.launchUrl (C4: QR of launchUrl + "Open on this PC" opening it in a new window) — never build or post the form yourself
// C4 front desk: returnUrl = cancelUrl = LIMS_FRONTDESK_PAYMENT_RESULT_URL (= <payments public base>/v1/payments/result; 08 A19 D-113, CR-C15-016)
// C4 "Cancel payment": call C15 P5 cancelPaymentIntent and P24b listPaymentCancelReasons through the staff BFF (no C4 endpoint)
// Khalti: intent.action.kind === 'redirect' → open intent.action.url
// Status: ctx.ports.PaymentProviderPort.getIntent(ctx, { intentId }) — no gateway call
// "Check now": verify(ctx, { intentId }) — throttled to one gateway call per 10 s per intent
```

Rules: (0) the settle transaction itself writes the ledger through `BillingPort.recordGatewayPayment` for every caller; C4's event consumer is only the safety net (08 A19 D-115); (1) never show "Paid" from a query parameter, SDK or redirect (REQ-SEC-059); (2) never pass an amount (the port has none); (3) map `payments.*` errors to user text: `intent_open_exists` "A payment is already in progress for this order.", `nothing_due` "Nothing to pay.", `gateway_not_available` "This payment method is not available right now.", `amount_not_supported` "This amount can't be paid with {gateway}. Please use another method.", `return_url_not_allowed` (a configuration error: log and show "This payment method is not available right now."); (4) handle `replayed: true` as success; (5) in tests use the C0 fake (`createFakePaymentProviderPort`) with its gateway-status fixtures.

## 5. Operator runbooks (pages in `docs/manual/payments/`)

| Runbook | Steps (summary) |
|---|---|
| RB-1 Enable a gateway for a lab | obtain merchant credentials from the lab (eSewa product code + secret; Khalti live secret + website URL) over a secure channel (never chat/email) → tenant admin enters them → Test → UAT payment in staging with the UAT keys → switch the production account on |
| RB-2 Held payment | open review queue → Re-check → if still held: contact the provider with `gateway_txn_ref` (Khalti: "hold, and contact Khalti") → resolve |
| RB-3 Amount mismatch alert | do not settle; compare provider dashboard with the intent; record evidence in the resolve note; escalate to the LIMS provider security if tampering suspected |
| RB-4 Reconciliation failed / not run | check worker health and gateway reachability (alerts) → "Run now" → if a provider is down, findings `gateway_unreachable` clear on the next successful run |
| RB-5 Gateway refund | request (finance A) → approve (finance B) → refund in provider dashboard → confirm with reference → if held, re-check next day |
| RB-6 Secret rotation / staff departure | provider issues new secret → tenant admin replaces it → old secret revoked at the provider (REQ-SEC-058) |
| RB-7 KEK rotation (C1) | per CR-C15-008 item 5 |
| RB-8 Static-QR worksheet | daily: compare bank statement Fonepay credits with the worksheet; discrepancies fixed in C4 (reversal / new manual entry) |
| RB-9 Go-live checklist | PG-T21/PG-T22 UAT results recorded; UNVERIFIED items in 01-PRD §9 each closed or accepted by the founder |

## 6. Accessibility and responsive rules

WCAG 2.2 AA (02-CV §14): every action reachable by keyboard; status always text + tone; dialogs trap focus and return it; error text tied to fields. Staff screens target ≥ 1280 px (C0 §6); public pages are phone-first single column.

## 7. Copy that must never appear

"Payment successful" before the server says `settled`; "Fonepay verified"; any statement that the system is IRD-approved; patient names, test names, registration numbers or barcodes on any payment page or in gateway fields (04 §11).
