# C15 — Payment Gateways — 02 TRD

Status: DECISION draft, 2026-11-06. Read with `01-PRD.md`. Shapes come from 03-IC; rules from 02-CV. Items not in 03-IC are marked **[CR-C15-nnn]** and specified in § "Change requests raised" at the end, designed as if accepted.

## 0. Verification note (primary sources re-read 2026-11-06)

04 P3 and P4 were re-checked through WebFetch on 2026-11-06 against `https://developer.esewa.com.np/pages/Epay-V2`, `https://docs.khalti.com/khalti-epayment/`, `https://docs.khalti.com/api/refund/` and `https://docs.khalti.com/gotchas/`. **Every 04 P3/P4 statement is confirmed.** Details the primary source adds or leaves open (this TRD follows the primary source; none contradicts 04):

Status of this table (08 A19 D-117): it is the authoritative record of these vendor details; the 04 P3/P4 Source cells point here ("re-read 2026-11-06; details and open points in C15 02-TRD §0 (V1–V15)"). Rows marked **UNVERIFIED** (V3 parameter name, V5 method, V6, V8, V13 method/auth/unit) are open points and are never decisive: adapter code depends only on the other rows (what the primary page states, as read on 2026-11-06), and every UNVERIFIED row is closed or confirmed by PG-T21/PG-T22 before production enablement.

| # | Source says | Impact here |
|---|---|---|
| V1 | eSewa: all 11 form fields required, unused charges sent as `0` (also 05 Target 5) | §7.2 field table |
| V2 | eSewa signed message must contain `total_amount,transaction_uuid,product_code` "in the same order"; example message `total_amount=100,transaction_uuid=11-201-13,product_code=EPAYTEST` | §7.2 signing |
| V3 | eSewa success redirect: Base64-encoded parameters `status, signature, transaction_code, total_amount, transaction_uuid, product_code, success_url, signed_field_names`; **query parameter name not stated** | UNVERIFIED; route declares optional `data`; never decisive |
| V4 | eSewa failure redirect: no parameters described | route declares none (UAT task PG-T21) |
| V5 | eSewa status check: method **not stated**; response fields `pid, scd, totalAmount, status, refId`; `totalAmount` is a JSON number (`150.0`) | `GET` (UNVERIFIED); exact decimal parsing §7.2 |
| V6 | eSewa page mentions "Instant Payment Notification" without payload/config | UNVERIFIED → not implemented |
| V7 | eSewa: no refund API described | manual refunds only |
| V8 | eSewa UAT form URL still absent | 04 P3 UNVERIFIED stands; no default |
| V9 | Khalti return URL must support `GET`; documented query params `pidx, status, transaction_id, tidx, amount, total_amount, mobile, purchase_order_id, purchase_order_name` (sample also `txnId`); callback statuses `Completed, Pending, User canceled` | §5.2 P23 |
| V10 | Khalti lookup response `pidx, total_amount, status, transaction_id, fee, refunded` | §7.3 |
| V11 | Khalti errors: invalid key `{"detail":"Invalid token.","status_code":401}`; wrong pidx `{"detail":"Not found.","error_key":"validation_error"}`; initiate validation errors with `error_key: "validation_error"` | §7.3 mapping, credential test |
| V12 | Khalti: "Refunded … do not provide service" | consistent with 04 P4 hold |
| V13 | Khalti refund page: `…/api/merchant-transaction/{{transaction_id}}/refund/` (sandbox `dev.khalti.com`), `transaction_id` from lookup, optional `amount` (partial; "in paisa" but example `50.00`), `mobile` for bank refunds; **method and auth not stated**; success `{"detail": "Transaction refund successful."}` | UNVERIFIED → adapter disabled by default (§7.4) |
| V14 | Khalti gotchas: "You can refund the payment to the user from your dashboard." | manual refund mode default |
| V15 | Khalti docs: no webhook, no rate limits documented | pull model only; C15 self-limits (§10) |

## 1. Owned paths (CM §3; web paths by [CR-C15-007])

| Path | Content |
|---|---|
| `services/api/src/modules/payments/**` | API module: handlers, services, domain, repositories, gateway adapters, `PaymentProviderPort` implementation |
| `services/worker/src/jobs/payments/**` | worker manifest, tasks, cron |
| `apps/web/src/app/(staff)/payments/**` | staff route segment [CR-C15-007] |
| `apps/web/src/features/payments/**` | components, BFF server functions, help, nav manifest [CR-C15-007] |
| `docs/manual/payments/**` | user-manual pages |

Not owned (requested by CR): `contracts/openapi/payments.yaml`, `contracts/ports/PaymentProviderPort.ts`, `contracts/events/payments.intent.settled.v1.schema.json`, `db/migrations/*_payments__*.sql` (C0); nginx and secret store (C1).

## 2. Stack and libraries

| Concern | Choice | Source |
|---|---|---|
| Runtime | Node.js 26.x LTS (C0 pins patch) | 02-CV §1.1 |
| API | Fastify + `fastify-openapi-glue` 4.12.0 (C0 core) | 04 T7 |
| Jobs | Graphile Worker 0.18.0 (C0 core) | 04 S10, T7 |
| DB | PostgreSQL 17 (`supabase/postgres:17.6.1.136`) | 04 D9 |
| HMAC-SHA256, SHA-256, AES-256-GCM, constant-time compare, CSPRNG | Node built-in `node:crypto` (`createHmac`, `createHash`, `createCipheriv`/`createDecipheriv('aes-256-gcm')`, `timingSafeEqual`, `randomBytes`) — **no new dependency** | Node standard library |
| Outbound HTTPS | Node built-in `fetch` with `AbortSignal.timeout(ms)` — **no new dependency** | Node standard library |
| Money | `@lims/shared-ts/money` (safe-integer paisa; decimal-string → paisa parser) | 02-CV §4.9 |
| IDs | `@lims/shared-ts/uuidv7`; tokens `@lims/shared-ts/crypto` | 02-CV §4.10 |
| Logger | `@lims/shared-ts/logger` | 02-CV §9 |
| Web | Next.js (C0 pins), `@lims/ui` only | 02-CV §2.4, §14 |
| Gateway SDKs | **none** (no gateway SDK is pinned in 04/02-CV) | — |

Dependencies table (02-CV §15.1): **no third-party dependency is added by C15.**

## 3. Module architecture

### 3.1 Layers (02-CV §2.2)

```
services/api/src/modules/payments/
├── index.ts                         # ModuleManifest: name 'payments', openapi contracts/openapi/payments.yaml,
│                                    #   ports { PaymentProviderPort }, produces ['payments.intent.settled.v1'],
│                                    #   authResolvers { paymentCallback } [CR-C15-004], systemPermissions [CR-C15-005]
├── permissions.ts                   # codes from §5.4
├── config.ts                        # §9 keys (typed, validated at boot; boot checks §9.3)
├── handlers/                        # one file per operationId (§5)
├── service/
│   ├── intent.service.ts            # create / verify / cancel / resolve / settle (transaction owner for handlers & jobs)
│   ├── outcome.service.ts           # applies a GatewayCheck to an intent (state machine + side effects)
│   ├── callback.service.ts          # public callback handling
│   ├── refund.service.ts            # request / approve / execute / confirm / complete
│   ├── reconciliation.service.ts    # daily run, findings, resolution
│   ├── staticqr.service.ts          # Fonepay static-QR worksheet
│   ├── merchant.service.ts          # merchant accounts, credential test
│   └── credentials.ts               # KEK load, AES-256-GCM encrypt/decrypt, fingerprint (only place secrets are clear)
├── domain/
│   ├── intent.ts                    # types, invariants (amount > 0, NPR only)
│   ├── intent.state.ts              # transition table §4.1 (pure)
│   ├── refund.state.ts              # §4.2
│   ├── mapping.esewa.ts             # status → GatewayOutcome (pure, table §7.2.4)
│   ├── mapping.khalti.ts            # status → GatewayOutcome (pure, table §7.3.4)
│   ├── amount.ts                    # paisa ↔ eSewa rupee string; exact decimal parse
│   └── returnurl.ts                 # allowlist validation
├── gateways/
│   ├── GatewayAdapter.ts            # internal interface §7.1
│   ├── esewa.adapter.ts
│   ├── khalti.adapter.ts
│   ├── fonepay.adapter.ts           # B8 slot: every method throws payments.gateway_not_available
│   └── http.ts                      # fetch wrapper: timeouts, redaction, gateway_calls logging, metrics
├── pages/                           # static HTML builders for launch/result pages (no templates engine)
│   ├── launch.html.ts
│   └── result.html.ts
├── repository/
│   ├── intents.repo.ts  transitions.repo.ts  gatewayCalls.repo.ts  callbacks.repo.ts
│   ├── refunds.repo.ts  reconciliation.repo.ts  staticqr.repo.ts  merchant.repo.ts  settings.repo.ts
├── events/publish.ts                # typed publisher for payments.intent.settled.v1
├── ports/PaymentProviderPort.impl.ts
├── mappers/                         # DTO allowlists per role (REQ-SEC-081); secrets never mapped
└── __tests__/{unit,integration,contract,probes,sim}/
    └── sim/esewa.sim.ts, khalti.sim.ts   # local HTTP simulators of the documented responses (§12)
```

```
services/worker/src/jobs/payments/
├── index.ts          # WorkerManifest (§8)
├── tasks/poll_intent.ts  sweep_open_intents.ts  reconcile_tenant.ts  reconcile_batch.ts  execute_refund.ts  check_refund.ts  rewrap_credentials.ts
├── cron.ts
└── __tests__/{unit,integration}/
```

Rules: handlers never call adapters directly; only `service/` calls `gateways/`. `credentials.ts` is the only file that sees clear secrets; secrets are passed to adapters as an opaque `SecretHandle` with a `use(fn)` method and are never assigned to logged objects. Business logic shared by API and worker lives in `service/` and is imported by the worker through the module manifest (02-CV §2.3).

### 3.2 Transactions and network calls

- Every outbound gateway call happens inside the caller's transaction (ports must not open their own — 02-CV §8.1), **without** holding a row lock: read intent → call gateway → `SELECT … FOR UPDATE` → re-check status → apply. A concurrent second verifier blocks briefly on `FOR UPDATE`, then sees the new status and does nothing (REQ-SEC-051).
- Handlers that call the gateway set `ctx.noRetry()` (C0 TRD §6.4: `PaymentProviderPort` handlers must) so a serialization retry never repeats an initiate.
- Timeouts [CONV]: in-request Khalti initiate 1,200 ms; in-request status/lookup 2,500 ms; worker calls 10,000 ms. These keep `createIntent ≤ 1.5 s` and `verify ≤ 3 s` (03-IC §4.9) under the 5,000 ms statement timeout (C0 TRD §6.4).
- Side effects with external effect (refund API call) run only in worker tasks (02-CV §7.3). Status/lookup reads are not side effects; 03-IC §4.9 allows them in-request.
- Where a C15 handler or job needs to survive a failing port call (e.g. `BillingPort` throwing), it wraps the call in `ctx.db.tx(fn)` (SAVEPOINT — C0 TRD §6.3, §7.2) and handles the error in the outer transaction (08 A19 P-44). Users: callback handling (§6.3 step 5), reconciliation per candidate and its ledger repair (§6.7). Each such path has the P-44 test: the fake writes a marker row, fails with `failNext`, and the marker is absent after commit.
- Port errors that C15 does not handle propagate unchanged (08 A17 P-23): the handler rethrows the original `LimsError` (e.g. `billing.*` from `BillingPort`, `frontdesk.*` from `FrontdeskPort`) and never constructs it.

## 4. State machines (realise 03-IC §10.6 exactly; additions by [CR-C15-003])

### 4.1 Payment intent (`payments.intents.status`)

Open set = `created, initiated, pending` (partial unique index, REQ-SEC-053). Terminal-but-reopenable = `failed, expired` (only to `held_for_review` by CR-C15-003).

| # | From | To | Trigger / guard | Side effects |
|---|---|---|---|---|
| I1 | (none) | `created` | `createIntent` passes all guards (§6.1) | insert intent + transition row |
| I2 | `created` | `initiated` | eSewa form signed (same transaction) / Khalti initiate returned `pidx` + `payment_url` | store refs, `expires_at`; enqueue first poll |
| I3 | `initiated` | `pending` | callback received, or gateway reports in-progress (eSewa `PENDING`) | transition row |
| I4 | `initiated`/`pending` | `settled` | gateway success (eSewa `COMPLETE` / Khalti `Completed`) **and** verified amount = `amount_paisa` **and** `amount_paisa ≤ balanceDue` | `BillingPort.recordGatewayPayment` + event `payments.intent.settled.v1` in the same transaction; metric |
| I5 | `initiated`/`pending` | `failed` | gateway failure status (eSewa `CANCELED`; Khalti `User canceled`/`Canceled`/`Failed`) or `cancelIntent` (`abandoned`) | transition row; if `abandoned` and Khalti: final check stays scheduled |
| I6 | `initiated`/`pending` | `expired` | after deadline: eSewa `NOT_FOUND`; Khalti `Expired` (any time) | transition row |
| I7 | `initiated`/`pending` | `held_for_review` | hold outcome (§7.2.4, §7.3.4): amount mismatch, ambiguous, Khalti `Pending`, refunded-before-settle, unknown status, not found after retries, exceeds due, non-final after deadline | `hold_reason`; metric + alert (REQ-SEC-048) |
| I8 | `held_for_review` | `settled` | finance re-check/resolve with success + exact amount (and due, or `record_exceeding_due`), or reconciliation | as I4 |
| I9 | `held_for_review` | `failed` | finance resolve `fail` with reason | transition row |
| I10 | `settled` | `partially_refunded` | completed refund < remaining captured | via refund completion |
| I11 | `settled`/`partially_refunded` | `refunded` | completed refunds = captured | via refund completion |
| I12 [CR-C15-003] | `partially_refunded` | `partially_refunded` | another partial refund completed | version + 1 |
| I13 [CR-C15-003] | `failed`/`expired` | `held_for_review` | reconciliation or a final check finds gateway success (`late_payment_found`) | critical alert |
| I14 [CR-C15-003] | `created` | `failed` | (only reachable inside `createIntent`'s own transaction if initiate fails after insert — the transaction is rolled back, so in practice never persisted; listed for completeness of the guard) | — |

Forbidden (→ `409 payments.intent_invalid_transition` [CR-C15-006] from handlers; trigger guard raises in SQL): any transition out of `refunded`; `settled → failed|expired|held_for_review`; `held_for_review → expired`; any `→ created`; `failed|expired → settled` directly (must pass `held_for_review`).

Only I4/I8 emit `payments.intent.settled.v1` (03-IC §10.6).

### 4.2 Refund (`payments.refunds.status`)

| # | From | To | Trigger / guard | Side effects |
|---|---|---|---|---|
| R1 | (none) | `pending_approval` | `createPaymentRefundRequest` (finance, aal2) passes §6.6 guards | row; row audit (`app.tg_row_audit`, 08 A19 D-112) |
| R2 | `pending_approval` | `rejected` | approver rejects with reason | — |
| R3 | `pending_approval` | `approved` | approver ≠ requester (unless amount ≤ tenant threshold and requester re-auth at aal2), aal2 | — |
| R4 | `approved` | `requested` | `PaymentProviderPort.refund(approvalId = refund id)` | mode `api`: enqueue `payments.execute_refund`; mode `manual`: wait for confirmation |
| R5 | `requested` | `completed` | gateway shows refund (§6.6 step 6) | `BillingPort.recordGatewayRefund` [CR-C15-002]; intent I10/I11/I12 |
| R6 | `requested` | `held_for_review` | gateway does not confirm after the check, or API call outcome unknown | daily re-check |
| R7 | `held_for_review` | `completed` | later check confirms | as R5 |
| R8 | `requested`/`held_for_review` | `failed` | API returned a documented failure (none documented today, §7.4), or finance marks it failed with P11b `failManualPaymentRefund` after a fresh gateway check shows no refund (§6.6 step 8) | `failure_reason` (`refund_fail_reasons`), `failure_note`; frees the in-flight slot |

At most one refund per intent in `pending_approval, approved, requested, held_for_review` (partial unique index). Every refund transition is evidenced by the row-audit trigger only (08 A19 D-112); the DB guard `payments.refunds_transition_guard()` enforces R1–R8 (05-SCHEMA §6) and its `invalid_transition` maps to `409 payments.refund_not_allowed`. `held_reason` ∈ `refund_hold_reasons` (`refund_not_visible`, `refund_kind_mismatch`, `api_outcome_unknown`).

### 4.3 Reconciliation run and finding

Run: `running → completed | failed`. Finding: `open → resolved` (with `resolution_code`); findings with `auto_action ∈ {settled, ledger_repaired}` are created `open` with severity and need acknowledgement [CONV: money moved by automation is always looked at by a human].

## 5. HTTP API (`contracts/openapi/payments.yaml`, owner C0 from this spec)

General: base `/v1/payments`; JSON snake_case; no `null` (omit); every object `additionalProperties: false`; strings have `maxLength`; `If-Match` on mutating actions of versioned resources; RFC 9457 errors (02-CV §4). Staff security `bearerJwt` (through BFF). Public security `paymentCallbackToken` [CR-C15-004] or none.

### 5.1 Staff operations

`IM` = requires `If-Match`. Idem = `x-idempotency`. Tier = `x-rate-limit-tier`. All list endpoints: cursor pagination (limit default 50, max 200), `sort` enum listed.

| # | operationId | Method + path | Permission | Idem | Request | Response | Error codes (besides common/auth) |
|---|---|---|---|---|---|---|---|
| P1 | `listPaymentIntents` | GET `/v1/payments/intents` | `payments.reconciliation.read` (priv) | — | query: `status` (csv of §4.1 states), `gateway` (csv), `hold_reason` (csv, x-coded-set `payments.hold_reasons`), `order_id`, `centre_id`, `created_at_from`, `created_at_to`, `sort ∈ {-created_at, created_at}` (`-updated_at` dropped: no index serves it, review m#21), `cursor`, `limit` | page of `PaymentIntentSummary` | — |
| P2 | `getPaymentIntent` | GET `/v1/payments/intents/{intent_id}` | `payments.reconciliation.read` | — | — | `PaymentIntentDetail` | — |
| P3 | `recheckPaymentIntent` | POST `/v1/payments/intents/{intent_id}/recheck` | `payments.intent.resolve` (priv) [CR-C15-005] | optional | — (allowed while `initiated`, `pending`, `held_for_review`; else `payments.intent_invalid_transition`) | `PaymentIntentDetail` | `common.rate_limited`, `payments.gateway_not_available`, `payments.intent_invalid_transition` |
| P4 | `resolvePaymentIntent` | POST `/v1/payments/intents/{intent_id}/resolve` IM | `payments.intent.resolve` | required | `{resolution ∈ settle, fail, record_exceeding_due; reason_code (x-coded-set payments.resolution_reasons); note? ≤500}` | `PaymentIntentDetail` | `payments.intent_not_verifiable`, `payments.intent_invalid_transition` |
| P5 | `cancelPaymentIntent` | POST `/v1/payments/intents/{intent_id}/cancel` | `payments.intent.create` | required | `{reason_code (x-coded-set payments.cancel_reasons)}` | `{intent_id, status}` | `payments.intent_invalid_transition` |
| P6 | `listPaymentRefunds` | GET `/v1/payments/refunds` | `payments.reconciliation.read` | — | query `status`, `gateway`, `intent_id`, `created_at_from/_to`, `sort ∈ {-created_at, created_at}` | page of `RefundDto` | — |
| P7 | `getPaymentRefund` | GET `/v1/payments/refunds/{refund_id}` | `payments.reconciliation.read` | — | — | `RefundDto` | — |
| P7b | `recheckPaymentRefund` | POST `/v1/payments/refunds/{refund_id}/recheck` | `payments.intent.resolve` (priv) | optional | `{}`; allowed while `requested`/`held_for_review` (else `payments.refund_not_allowed`); runs §6.6 step 6 in-request; within `VERIFY_MIN_INTERVAL_SECONDS` of `refunds.last_checked_at` → `429 common.rate_limited` + `Retry-After` (review #7) | `RefundDto` | `common.rate_limited`, `payments.refund_not_allowed`, `payments.gateway_not_available` |
| P8 | `createPaymentRefundRequest` | POST `/v1/payments/intents/{intent_id}/refunds` | `payments.refund.request` (priv) [CR-C15-005] | required | `{refund_amount_paisa (1…9007199254740991); reason_code (x-coded-set payments.refund_reasons); reason_text? ≤500}` [CR-C15-012] | `201 RefundDto` | `payments.refund_not_allowed`, `payments.refund_exceeds_captured` |
| P9 | `approvePaymentRefund` | POST `/v1/payments/refunds/{refund_id}/approve` IM | `payments.refund.approve` (priv) [CR-C15-005] | required | `{note? ≤500}` | `RefundDto` | `payments.refund_self_approval_forbidden`, `payments.refund_not_allowed`, `payments.refund_exceeds_captured` (re-checked) |
| P10 | `rejectPaymentRefund` | POST `/v1/payments/refunds/{refund_id}/reject` IM | `payments.refund.approve` | required | `{reason_code (payments.refund_reject_reasons); note? ≤500}` | `RefundDto` | `payments.refund_not_allowed` |
| P11 | `confirmManualPaymentRefund` | POST `/v1/payments/refunds/{refund_id}/confirm-manual` IM | `payments.refund.approve` | required | `{gateway_refund_reference ≤100 pattern ^[A-Za-z0-9_.:/-]{1,100}$; refunded_on (date)}` | `RefundDto` (status `completed` or `held_for_review`) | `payments.refund_not_allowed` |
| P11b | `failManualPaymentRefund` | POST `/v1/payments/refunds/{refund_id}/fail` IM | `payments.refund.approve` (priv) | required | `{reason_code (x-coded-set payments.refund_fail_reasons); note? ≤500 (required when the code has `requires_text`)}`; allowed only from `requested`/`held_for_review` and only after the in-request gateway check of §6.6 step 8 shows no refund (review #6) | `RefundDto` (status `failed`) | `payments.refund_not_allowed`, `payments.gateway_not_available` |
| P12 | `listReconciliationRuns` | GET `/v1/payments/reconciliation-runs` | `payments.reconciliation.read` | — | query `business_date_from`, `business_date_to`, `status`, `sort ∈ {-business_date}` | page of `ReconciliationRunDto` | — |
| P13 | `getReconciliationRun` | GET `/v1/payments/reconciliation-runs/{run_id}` | `payments.reconciliation.read` | — | — | `ReconciliationRunDto` | — |
| P14 | `startReconciliationRun` | POST `/v1/payments/reconciliation-runs` | `payments.intent.resolve` | required | `{}` (always "now", trigger `manual`) | `202 ReconciliationRunDto` (`running`) | `payments.reconciliation_in_progress` [CR-C15-006] |
| P15 | `listReconciliationFindings` | GET `/v1/payments/reconciliation-findings` | `payments.reconciliation.read` | — | query `status`, `kind` (csv), `severity`, `run_id`, `sort ∈ {-created_at, severity}` | page of `FindingDto` | — |
| P16 | `resolveReconciliationFinding` | POST `/v1/payments/reconciliation-findings/{finding_id}/resolve` IM | `payments.intent.resolve` | required | `{resolution_code (payments.finding_resolutions); note ≤1000 (required when code = other)}` | `FindingDto` | `common.immutable_record` (already resolved) |
| P17 | `listStaticQrReconciliations` | GET `/v1/payments/static-qr-reconciliations` | `payments.reconciliation.read` | — | query `business_date_from/_to`, `centre_id` | page of `StaticQrReconDto` | — |
| P18 | `previewStaticQrReconciliation` | GET `/v1/payments/static-qr-reconciliations/preview` | `payments.reconciliation.read` | — | query `business_date` (required), `centre_id?` | `{business_date, centre_id?, system_entries, system_total: Money}` | — |
| P19 | `createStaticQrReconciliation` | POST `/v1/payments/static-qr-reconciliations` | `payments.intent.resolve` | required | `{business_date; centre_id?; statement_total_paisa (0…); statement_reference ≤100; note? ≤1000}` [CR-C15-012] | `201 StaticQrReconDto` | `common.validation_failed` (note required when difference ≠ 0), `payments.static_qr_already_reconciled` [CR-C15-006] |
| P20 | `listMerchantAccounts` | GET `/v1/payments/merchant-accounts` | `payments.merchant_config.read` [CR-C15-005] | — | — | `{data: MerchantAccountDto[]}` (≤ 6 rows; no pagination) | — |
| P21 | `putMerchantAccount` | PUT `/v1/payments/merchant-accounts/{gateway}/{environment}` IM (absent row: `If-Match` omitted) | `payments.merchant_config.manage` (priv) | optional | `{is_enabled; esewa_product_code? ≤64 ^[A-Za-z0-9_-]+$; khalti_website_url? ≤300 https URL; secret? ≤256 (write-only); api_refunds_enabled? (khalti only)}` | `MerchantAccountDto` | `payments.gateway_not_available` (fonepay enable), `common.validation_failed` |
| P22 | `testMerchantAccount` | POST `/v1/payments/merchant-accounts/{gateway}/{environment}/test` | `payments.merchant_config.manage` | optional | — | `200 {outcome ∈ reachable_key_valid, reachable_key_unverifiable, auth_failed, unreachable; checked_at}`; every outcome, including a rejected key (`auth_failed`), is a `200` and is stored in `last_test_outcome`/`last_test_at` (review m#18) | — (`payments.credential_invalid` stays registered (CR-C15-006) but is not emitted by P22 or any other operation) |
| P23 | `getPaymentSettings` / `updatePaymentSettings` | GET / PUT `/v1/payments/settings` (PUT IM) | read `payments.merchant_config.read`; write `payments.merchant_config.manage` | PUT optional | `{refund_two_person_threshold_paisa (0…); purchase_order_label 1–50 chars ^[A-Za-z0-9 .,&()-]+$; reconciliation_enabled}` | `PaymentSettingsDto` | — |
| P24 | `listPaymentCodes` | GET `/v1/payments/coded-sets/{set_name}` (`hold_reasons, failure_reasons, cancel_reasons, resolution_reasons, refund_reasons, refund_reject_reasons, refund_fail_reasons, refund_hold_reasons, finding_kinds, finding_resolutions`) | `payments.reconciliation.read` | — | — | `{data: [{code, display, requires_text, is_active}]}` | — |
| P24b | `listPaymentCancelReasons` | GET `/v1/payments/cancel-reasons` [CONV path] | `payments.intent.create` | — | — | `{data: [{code, display, requires_text, is_active}]}` (set `cancel_reasons` only) | — |

All staff operations: tier `general`. Probes: every id parameter (§11.3 of 02-CV). One permission floor per operation (08 A19 P-43): P24 (finance screens) and P24b (C4 front-desk cancel dialog through the staff BFF, 08 A19 D-113) are separate operations; no operation accepts "A or B".

Access-log calls (08 A13 P-3; 08 A19 D-112 — no new action codes). Every other write is evidenced by the row-audit trigger (05-SCHEMA §1), not by `access_log`:

| Operation | `ctx.audit.access` action | `entityType` | Detail |
|---|---|---|---|
| P4 `resolvePaymentIntent` | `payment_intent.resolve` | `payment_intent` | `{resolution, reason_code}` |
| P16 `resolveReconciliationFinding` | `payment_intent.resolve` | `reconciliation_finding` | `{resolution_code}` |
| P21 `putMerchantAccount` | `settings.change` | `payment_merchant_account` | changed field **names** only (`is_enabled`, `secret`, …); never a value or the secret |
| P23 `updatePaymentSettings` | `settings.change` | `payment_settings` | changed field names only |

DTOs (fields exactly; money as `Money`):
- `PaymentIntentSummary`: `id, order_id, centre_id, gateway, environment, status, amount, hold_reason?, failure_reason?, created_at, expires_at?, settled_at?, last_checked_at?, version`.
- `PaymentIntentDetail`: Summary + `gateway_txn_ref, gateway_secondary_ref?, last_gateway_status_raw?, verified_amount?, verification_method?, refunded_amount, ledger_entry_id?, created_by_actor_type, transitions: [{from_status?, to_status, cause, reason_code?, actor_type, at}], gateway_checks: [{operation, outcome, gateway_status_raw?, http_status?, at}] (last 20), callbacks: [{kind, outcome_code, signature_valid?, at}] (last 20), refunds: RefundDto[]`. Never: callback token, return URLs (they may carry app-link paths), raw payloads, secrets.
- `RefundDto`: `id, intent_id, order_id, gateway, mode, status, amount, reason_code, reason_text?, requested_by {membership_id, display_name}, requested_at, approved_by?, approved_at?, rejected_by?, rejected_at?, gateway_refund_reference?, completed_at?, ledger_entry_id?, failure_reason?, failure_note?, held_reason?, last_checked_at?, version`. `display_name` values (and those of `approved_by`/`rejected_by`) come from `ctx.core.memberships.list({ membershipIds, activeOnly: false })`, batched and memoised per request (08 A17 P-17).
- `ReconciliationRunDto`: `id, business_date, trigger, status, started_at, finished_at?, counts {checked, ok, findings, critical}, version`.
- `FindingDto`: `id, run_id, kind, severity, intent_id?, refund_id?, our_status?, gateway_status_raw?, our_amount?, gateway_amount?, auto_action, status, resolution_code?, note?, resolved_by?, resolved_at?, created_at, version`.
- `StaticQrReconDto`: `id, business_date, centre_id?, system_entries, system_total, statement_total, difference, statement_reference, status ∈ matched|accepted_with_difference, note?, reconciled_by, created_at`.
- `MerchantAccountDto`: `gateway, environment, is_enabled, esewa_product_code?, khalti_website_url?, secret {is_set, set_at?, fingerprint?}, api_refunds_enabled, last_test {outcome, at}?, version`. **The secret value is write-only.**
- `PaymentSettingsDto`: `refund_two_person_threshold, purchase_order_label, reconciliation_enabled, version`.

### 5.2 Public operations (browser redirects; `x-public` with justification; resolver [CR-C15-004])

Responses carry `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`. Path tokens are secrets → excluded from access logs by C1 [CR-C15-008]. Tier (08 A19 D-116): P30–P34 declare `x-rate-limit-tier: general`, using the documented 02-CV §10.3 variant "unauthenticated callback/launch routes: per-IP at nginx 10 r/s burst 20 (CR-C15-008) + app key per intent (`payments:cb:<intent_id>`)"; no new tier.

| # | operationId | Method + path | Security | Query (all optional strings unless stated) | Response |
|---|---|---|---|---|---|
| P30 | `launchEsewaPayment` | GET `/v1/payments/launch/{callback_token}` | `paymentCallbackToken` | — | `200 text/html` launch page (§7.2.3) when intent is `initiated`/`pending` and gateway `esewa`; otherwise `303` → result page `outcome` for the current state. Writes one `payments.callbacks` row `kind = 'launch'` (§6.3a) |
| P31 | `esewaSuccessCallback` | GET `/v1/payments/callbacks/esewa/{callback_token}/success` | `paymentCallbackToken` | `data` ≤ 4096, pattern Base64 (`^[A-Za-z0-9+/=_-]+$`) — name UNVERIFIED (V3) | `303` Location §6.3 |
| P32 | `esewaFailureCallback` | GET `/v1/payments/callbacks/esewa/{callback_token}/failure` | `paymentCallbackToken` | none documented (V4) | `303` |
| P33 | `khaltiReturnCallback` | GET `/v1/payments/callbacks/khalti/{callback_token}` | `paymentCallbackToken` | `pidx` ≤64, `status` ≤32, `transaction_id` ≤64, `tidx` ≤64, `txnId` ≤64, `amount` ≤20 digits, `total_amount` ≤20 digits, `mobile` ≤20, `purchase_order_id` ≤64, `purchase_order_name` ≤100 (V9) | `303` |
| P34 | `getPaymentResultPage` | GET `/v1/payments/result` | none (`x-public`: "static payment outcome page; no data, no DB") | `outcome` (required) ∈ `settled, pending, failed, unknown`; `intent_id` (optional, `format: uuid`; accepted so that the §6.3 step 6 redirect, which appends it, validates; ignored by the handler and never echoed — review #2) | `200 text/html` (§7.5) |

Unknown/expired/forged tokens: the resolver returns nothing → handler responds `303 /v1/payments/result?outcome=unknown` (no existence oracle; same response for every invalid token). Tokens are accepted for 30 days after intent creation [CONV]; the window is a constant in the resolver DEFINER (05-SCHEMA §6), not configuration (review m#23).

UNVERIFIED risk: if eSewa appends parameters other than `data` to either callback, strict query validation (REQ-SEC-080) rejects with `400`. Verification still completes through polling (§8), so money is never lost; the UAT task PG-T21 fixes the spec before production enablement.

### 5.3 Ports implemented — `PaymentProviderPort` (03-IC §4.9 verbatim + CR-C15-001 additions)

```ts
// contracts/ports/PaymentProviderPort.ts (C0) — V1, additions marked
export type Gateway = 'esewa' | 'khalti' | 'fonepay';
export type IntentAction =
  | { kind: 'form_post'; url: string; fields: Readonly<Record<string, string>>; launchUrl?: string }   // launchUrl: CR-C15-001
  | { kind: 'redirect'; url: string }
  | { kind: 'qr'; qrPayload: string };                                                                // Fonepay — BLOCKED B8, never returned
export type IntentStatus = 'created' | 'initiated' | 'pending' | 'settled' | 'failed' | 'expired' | 'held_for_review'
  | 'refunded' | 'partially_refunded';

export interface PaymentProviderPortV1 {
  createIntent(ctx: RequestContext, input: { orderId: Uuidv7; gateway: Gateway; idempotencyKey: string; returnUrl: string; cancelUrl: string }):
    Promise<{ intentId: Uuidv7; gateway: Gateway; amount: Money; action: IntentAction; expiresAt?: IsoUtc; replayed: boolean }>;
  verify(ctx: RequestContext, input: { intentId: Uuidv7 }): Promise<{ intentId: Uuidv7; status: IntentStatus; gatewayStatusRaw?: string; verifiedAmount?: Money }>;
  refund(ctx: RequestContext, input: { intentId: Uuidv7; amount: Money; reasonCode: Code; idempotencyKey: string; approvalId: Uuidv7 }):
    Promise<{ refundId: Uuidv7; status: 'requested' | 'completed' | 'failed' | 'held_for_review'; replayed: boolean }>;
  /** CR-C15-001. Read-only, no gateway call. */
  getIntent(ctx: RequestContext, input: { intentId: Uuidv7 }): Promise<{ intentId: Uuidv7; orderId: Uuidv7; gateway: Gateway; status: IntentStatus;
    amount: Money; refundedAmount: Money; expiresAt?: IsoUtc; settledAt?: IsoUtc; action?: IntentAction /* only while initiated/pending */ }>;
  /** CR-C15-001. Verifies first; settles instead if paid. @throws payments.intent_invalid_transition */
  cancelIntent(ctx: RequestContext, input: { intentId: Uuidv7; reasonCode: Code }): Promise<{ intentId: Uuidv7; status: IntentStatus }>;
}
```

Error codes per method (all also `common.not_found`, `common.validation_failed`, `common.internal`):

| Method | Throws |
|---|---|
| `createIntent` | `payments.intent_open_exists`, `payments.nothing_due`, `payments.gateway_not_available`, `payments.amount_not_supported`, `payments.return_url_not_allowed`, `common.idempotency_key_reused` |
| `verify` | `payments.gateway_not_available` only when the merchant account was disabled/deleted after creation; transient gateway failures do **not** throw — the current status is returned unchanged (04 P3 `code: 0` = retry) |
| `refund` | `payments.refund_requires_approval`, `payments.refund_exceeds_captured`, `payments.refund_not_allowed`, `payments.gateway_not_available`, `common.idempotency_key_reused` |
| `getIntent` | — |
| `cancelIntent` | `payments.intent_invalid_transition` |

Semantics that consumers rely on:
- `amount` is always `BillingPort.getOrderBalance(orderId).balanceDue` at creation (REQ-SEC-046). Partial gateway payments of less than the due are not offered in v1 [DECISION: the port has no amount input].
- `verify` (port) is safe to call any time; calls within `LIMS_PAYMENTS_VERIFY_MIN_INTERVAL_SECONDS` (10) of the last gateway check return the stored status without a gateway call (no error). The staff HTTP re-check P3 differs on purpose: it is not forced, and within the interval it returns `429 common.rate_limited` + `Retry-After` (review m#19).
- `idempotencyKey` grammar (08 A19 P-40): `^[A-Za-z0-9_.:-]{1,200}$`, built as `<prefix>:<id>[:<suffix>]` (e.g. C16 `eng:<payment_request_id>`). This is the port-key grammar, not the `Idempotency-Key` HTTP-header grammar of 02-CV §4.5; the key never reaches a gateway (eSewa `transaction_uuid` is the intent id, §7.2.3).
- Every method requires `ctx.tenantId`; the port never authorises the *caller's* right to act on the order — the caller does that before calling. Callers (actor type `user` or `system` only; any other actor type → `auth.forbidden`): staff holding `payments.intent.create` (C4), the engagement system actor in the C16 worker, and the reporting system actor in the C6 portal dues-payment worker (`createIntent` / `getIntent` only — 08 A11.1 as amended by A19.3, CR-C15-010 ACCEPT-MODIFIED). Patient/portal actors never call this port (08 R8).
- Ledger path (08 A19 D-115, replacing A11.1 bullet 4): for every caller, including the C6 portal flow, C15 calls `BillingPort.recordGatewayPayment` inside its settle transaction (03-IC X3, canonical); C4's `payments.intent.settled.v1` consumer is the idempotent safety net.
- C6 portal flow (08 A11.1): the C6 worker reads the amount via `BillingPort.getOrderBalance` for its own `reporting.portal_payment_requests` row, then calls `createIntent` with `returnUrl = cancelUrl = <PORTAL>/r/payments/{portal_payment_request_id}/done` (route `portal.payment_done`); the default `RETURN_URL_ALLOWLIST` entry `${LIMS_ORIGIN_PORTAL}/` already admits it (§9.1). The amount C15 uses is always its own `getOrderBalance` read at creation (§6.1 step 6), never a caller value.
- Contract suite (03-IC §4.9 cases 1–11) passes, with case 5 refined by CR-C15-001 (pre-deadline `Initiated`/`PENDING` stay non-terminal; for Khalti `Initiated` this follows 04 P4 as amended by 08 A19 D-114 / A19.2 — founder sign-off of the 04 wording pending under F-08). Added cases 12–18: (12) `getIntent` returns `action` only while open; (13) `cancelIntent` on an intent the gateway reports paid → `settled`; (14) eSewa `NOT_FOUND` after deadline → `expired`; (15) return URL off-allowlist → `payments.return_url_not_allowed`; (16) Khalti due 999 paisa → `payments.amount_not_supported`; (17) late success on `expired` → `held_for_review`; (18) refund replay same key → same refund, `replayed: true`.

Performance (03-IC §4.9): `createIntent` ≤ 1.5 s (eSewa ≤ 50 ms, local signing only), `verify` ≤ 3 s, `getIntent` ≤ 10 ms [CONV], `cancelIntent` ≤ 3 s, `refund` ≤ 50 ms (DB + enqueue only).

### 5.4 Permissions checked (all via `IdentityPort.assertRole` before any state read beyond the authz lookup)

`payments.intent.create` (03-IC §11), `payments.reconciliation.read` (03-IC §11), and [CR-C15-005]: `payments.intent.resolve` (priv), `payments.refund.request` (priv), `payments.refund.approve` (priv), `payments.merchant_config.read`, `payments.merchant_config.manage` (priv). Object-level: intents/refunds are loaded first (RLS tenant scope); then `assertRole({permission, centreId: intent.centre_id})` (02-CV §10.1).

## 6. Service algorithms

### 6.1 `createIntent`

1. Validate `idempotencyKey` (`^[A-Za-z0-9_.:-]{1,200}$`, 08 A19 P-40; same rule as `intents__idem__ck`), `gateway`, `returnUrl`/`cancelUrl` (`domain/returnurl.ts`: absolute `https:` URL ≤ 2000 chars, no userinfo, no fragment; `origin + path` must start with one entry of `LIMS_PAYMENTS_RETURN_URL_ALLOWLIST`; else `payments.return_url_not_allowed`).
2. `fingerprint = sha256(orderId|gateway|returnUrl|cancelUrl)`. `SELECT … FROM payments.intents WHERE tenant_id=$t AND idempotency_key=$k` → found: same fingerprint → return stored intent + action (regenerated, §7.2/§7.3), `replayed: true`; different → `common.idempotency_key_reused`.
3. `gateway = 'fonepay'` → `payments.gateway_not_available` (B8).
4. Merchant account for `(tenant, gateway, LIMS_PAYMENTS_GATEWAY_ENV)` enabled with secret set → else `payments.gateway_not_available`.
5. `FrontdeskPort.getOrderSummary(orderId)` → `status = cancelled` → `payments.nothing_due`. Keep `branchId`, `centreId`. (C15 is a declared FrontdeskPort consumer for `getOrderSummary` only — CR-C15-014, 08 A19 D-110 / P-46.)
6. `BillingPort.getOrderBalance(orderId)` → `balanceDue.amountPaisa ≤ 0` → `payments.nothing_due`. `amount = balanceDue`.
7. Gateway amount rules: Khalti `amount < 1000` → `payments.amount_not_supported` (04 P4). eSewa `amount % 100 ≠ 0` and flag false → `payments.amount_not_supported`.
8. `callbackToken = randomBytes(32)` (256-bit; stored `sha256`). Insert intent `created` with `INSERT … ON CONFLICT DO NOTHING RETURNING id`. No row → re-read by idempotency key (go to 2) else open intent exists → `payments.intent_open_exists` (partial unique index).
9. Adapter `initiate` (§7): eSewa signs (no network); Khalti `POST /epayment/initiate/` (in-request timeout 1,200 ms). Failure → throw `payments.gateway_not_available` (whole request rolls back; nothing persisted).
10. Update `→ initiated` with refs, `expires_at` (Khalti: response `expires_at`; if absent `now + expires_in`; if both absent `now + 60 min` per docs; eSewa: `now + LIMS_PAYMENTS_ESEWA_INTENT_TTL_MINUTES`). Transition rows I1, I2.
11. Enqueue `payments.poll_intent` jobs at the poll schedule (§8) and one final check at `deadline = expires_at + LIMS_PAYMENTS_EXPIRY_GRACE_MINUTES`, job keys `poll:<intent_id>:<n>`.
12. Return `{intentId, gateway, amount, action, expiresAt, replayed:false}`.

### 6.2 `verify` / `applyCheck` (shared by port verify, callbacks, polls, recheck, reconciliation)

1. Load intent (no lock). If `last_checked_at > now − min_interval` and caller is not reconciliation → return stored status.
2. Adapter `check(intent)` → `GatewayCheck { kind: 'answer', statusRaw, amountPaisa?, secondaryRef?, refundedFlag? } | { kind: 'transient', reason } | { kind: 'auth_error' } | { kind: 'not_found' }`. Every call is logged to `payments.gateway_calls` (redacted, §7.6).
3. Map to `GatewayOutcome` via the pure tables §7.2.4 / §7.3.4 with `{statusRaw, amountMatches, beforeDeadline, intentStatus}` → one of `settle | stay | to_pending | fail(reason) | expire | hold(reason) | retry`.
4. `SELECT … FOR UPDATE` the intent; if its status changed since step 1, re-run step 3 with the new status (no second gateway call).
5. Apply:
   - `settle`: (a) `bal = BillingPort.getOrderBalance(orderId)`; if `amount > bal.balanceDue` and not `allowExceedsDue` → treat as `hold(exceeds_due)`; (b) `UPDATE payments.intents SET status='settled', … WHERE tenant_id=$t AND id=$id AND status = ANY($open_or_held) AND version=$v` → 0 rows → stop (someone else applied); (c) `res = BillingPort.recordGatewayPayment({intentId, orderId, gateway, gatewayTxnRef, amount, verifiedAt: ctx.now()} [, allowExceedsDue])`; (d) store `ledger_entry_id = res.ledgerEntryId`; (e) publish `payments.intent.settled.v1` (§8.1); (f) transition row; metric. Any throw in (c)–(e) rolls back the whole unit (caller decides: port callers see the error; jobs retry; callback handler uses a SAVEPOINT and redirects `pending`).
   - `hold(reason)`: status `held_for_review`, `hold_reason`; metric `lims_payments_intents_held_total{gateway,reason}`; `amount_mismatch` also logs `payment_amount_mismatch` at `error` level (ids only) → critical alert.
   - `fail`, `expire`, `to_pending`: conditional update + transition row.
   - `stay` / `retry`: update `last_checked_at`, `check_count`, `last_gateway_status_raw` only (no transition); `retry` reschedules a poll (worker) or returns current status (request).
6. Return `{intentId, status, gatewayStatusRaw, verifiedAmount?}`.

Deadline: `beforeDeadline = now < expires_at + grace`.

### 6.3 Callback handling (P31–P33)

1. Resolver [CR-C15-004]: `sha256(token)` → DEFINER lookup → `{tenantId, intentId}` or none → `303 /v1/payments/result?outcome=unknown`. Claims `{sub: <payments system actor>, tenant_id, actor_type: 'system'}`.
2. Rate check: `ctx.rateLimit.consume('general', 'payments:cb:' + intentId)` [CONV key; 08 A19 D-116]; exceeded → insert the `payments.callbacks` row of step 3 with `outcome_code = 'rate_limited'`, skip steps 4–5 (no gateway call), redirect by stored status.
3. Insert `payments.callbacks` row: kind, redacted query (allowlisted keys; Khalti `mobile` dropped — REQ-SEC-056), `signature_valid` (eSewa success only, §7.2.2), `outcome_code` (`ok`, `payments.signature_invalid`, `payments.callback_mismatch` (Khalti `pidx`/`purchase_order_id` ≠ stored, or eSewa `transaction_uuid`/`product_code` ≠ stored), `payments.callback_stale` (intent already terminal); tokens older than 30 days never get here, because the resolver returns nothing for them (step 1; review m#23)). Callback values **never** change state.
4. If intent is `initiated` → `to_pending` (I3).
5. `ctx.db.tx(() => applyCheck(intent))` (SAVEPOINT). Any error → enqueue `payments.poll_intent` (run now) in the outer transaction.
6. Redirect `303`: `settled` → `returnUrl + ?intent_id&outcome=settled`; `failed`/`expired` → `cancelUrl + ?intent_id&outcome=failed`; else `returnUrl + ?intent_id&outcome=pending`. Query appended with `URL.searchParams` (existing query kept). When the target is C15's own result page (C4 flows, 08 A19 D-113), P34 accepts `intent_id` as an optional ignored parameter (§5.2), so the redirect never ends on a `400`; an HTTP contract test follows the redirect for each outcome (review #2).

**§6.3a Launch page (P30).** Steps 1–2 as above (rate-limited → `rate_limited` row, redirect by stored status). Then insert one `payments.callbacks` row `kind = 'launch'`, `gateway = 'esewa'`, no query, `outcome_code = 'ok'` when the intent is `initiated`/`pending`, else `payments.callback_stale`; no gateway call and no state change. Serve the page or redirect per §5.2 (review m#22).

### 6.4 `cancelIntent`

Open intent only (else `payments.intent_invalid_transition`). Run `applyCheck` (reconciliation mode, no min interval). If result `settled` → return it. If still open → `fail(abandoned)` with `reason_code`; Khalti/eSewa final-check job at deadline stays queued (a late success → I13 hold).

### 6.5 Resolve (P4)

`settle` → `applyCheck` with forced gateway call; outcome must be `settle` (else `payments.intent_not_verifiable`). `record_exceeding_due` → same but `allowExceedsDue: true` (only when `hold_reason = exceeds_due`). `fail` → I9 with `reason_code` (requires latest check not success; if latest check is success → `payments.intent_not_verifiable`). All write a transition row with actor, reason and note; `ctx.audit.access({action:'payment_intent.resolve', entityType:'payment_intent', entityId, outcome, …})` (08 §4.4; table in §5.1). P16 writes the same action with `entityType: 'reconciliation_finding'` (08 A19 D-112).

### 6.6 Refunds

1. Request (P8): intent `settled` or `partially_refunded` (else `payments.refund_not_allowed`); no refund in flight (partial unique index → `payments.refund_not_allowed`); `amount ≤ amount_paisa − refunded_paisa` else `payments.refund_exceeds_captured`; `bal = BillingPort.getOrderBalance`; `amount ≤ max(0, −bal.balanceDue)` else `payments.refund_exceeds_captured` (detail "exceeds refundable balance") — mirrors C4's refundable rule (C4 03-APP-FLOW §2.12). `mode = api` only if gateway `khalti` and merchant `api_refunds_enabled`; else `manual`. The new row's `idempotency_key = 'refund:' || id` (port-key grammar, 08 A19 P-40). Recorded by the row-audit trigger (08 A19 D-112).
2. Approve (P9): requester ≠ approver unless `amount ≤ refund_two_person_threshold_paisa` (default 0 → always two-person) → `payments.refund_self_approval_forbidden`; re-check step-1 bounds; `→ approved`; then call `PaymentProviderPort.refund({…, approvalId: refund.id, idempotencyKey: 'refund:' + refund.id})` in the same transaction → `→ requested`; `api` mode enqueues `payments.execute_refund`. P10 reject: `pending_approval → rejected` with `reject_reason_code` and note (R2).
3. `refund()` (port): validate `idempotencyKey` against `^[A-Za-z0-9_.:-]{1,200}$` (08 A19 P-40; same rule as `refunds__idem__ck`) else `common.validation_failed`; load refund by `approvalId`; must be `approved` with same intent, amount, reason and `idempotency_key` → else `payments.refund_requires_approval`; idempotency on `(tenant_id, idempotency_key)`; returns `requested`.
4. Execute (api, Khalti only, task `payments.execute_refund`, `max_attempts = 1` for the POST [CONV: the refund API's idempotency is undocumented, never retry blindly]): before the POST, lookup — if already `Refunded`/`Partially Refunded` → skip POST; POST per §7.4; any outcome → enqueue `payments.check_refund`.
5. Confirm manual (P11): stores reference and date, then `payments.check_refund` runs in-request.
6. Check (`payments.check_refund`, P7b, P11): sets `refunds.last_checked_at = now()`. eSewa status ∈ {`FULL_REFUND`, `PARTIAL_REFUND`} / Khalti status ∈ {`Refunded`, `Partially Refunded`} or lookup `refunded` truthy → confirmed. Expected kind: full when `refunded_paisa + amount = amount_paisa`, else partial; a mismatch of kind → `held_for_review` (`held_reason = refund_kind_mismatch`). Confirmed → `completed`, `BillingPort.recordGatewayRefund({refundId, intentId, orderId, gateway, gatewayTxnRef, amount, reasonCode, approvedByMembershipId, refundedAt})` [CR-C15-002] in the same transaction, `refunded_paisa += amount`, intent I10/I11/I12. Not confirmed → `held_for_review` (`held_reason = refund_not_visible`; after an API call whose outcome was `unknown`, `api_outcome_unknown`). A transient gateway answer leaves the refund unchanged (task: retry; P7b/P11b: `503 payments.gateway_not_available`).
7. The gateway responses do not state partial-refund amounts (eSewa returns `totalAmount` only; Khalti lookup has `refunded`), so the refunded **amount** rests on the two-person approval plus finance's reference; the gateway check confirms that a refund happened (documented limitation, 07-SECURITY abuse case AB-7).
8. Fail (P11b `failManualPaymentRefund`, R8; review #6): refund must be `requested` or `held_for_review` (else `payments.refund_not_allowed`). The handler first runs the gateway check of step 6 **read-only** (no state change yet). If the gateway shows a refund → `409 payments.refund_not_allowed` with detail `gateway_shows_refund` and nothing is written (finance uses P7b, which completes it) [CONV]; transient → `503 payments.gateway_not_available`. Otherwise → `failed` with `failure_reason = reason_code` (`refund_fail_reasons`), `failure_note`, `last_checked_at`; the in-flight slot is freed, so a new refund request is possible. No ledger row. Row-audited (D-112).
9. Re-check (P7b `recheckPaymentRefund`, review #7): refund `requested`/`held_for_review` (else `payments.refund_not_allowed`); `last_checked_at` within `VERIFY_MIN_INTERVAL_SECONDS` → `429 common.rate_limited` + `Retry-After`; else step 6 in-request (confirmed → `completed` with the ledger call; not confirmed → `held_for_review`).

### 6.7 Reconciliation (`payments.reconcile_tenant`)

Run row `running` (partial unique: one running per tenant → `payments.reconciliation_in_progress`). `business_date` (review m#30) = the tenant business date (`Asia/Kathmandu` in v1, 08 A13 P-15) at `started_at` **minus 1 day** for `trigger = cron` (the 02:25 run covers the day that just ended), and the current business date for `manual`. Candidate set, evaluated relative to the run's `started_at` (not the wall clock of a later batch): intents `status ∈ open ∪ {held_for_review}`; `settled|partially_refunded|refunded` with `settled_at ≥ started_at − 2 d`; `failed|expired` with `closed_at ≥ started_at − 7 d`; refunds `requested|held_for_review`. Concurrency 2 gateway calls at a time per tenant [CONV].

Transaction boundaries (review m#30). A worker job runs in one transaction (C0 `JobContext`), so the run is split into batch jobs instead of one long transaction:
- The cron job (or P14 in the request transaction) inserts the run row and enqueues `payments.reconcile_batch {tenant_id, run_id, phase: 'intents', after_id?}` (job key `recon:<run_id>:<phase>:<after_id or 'start'>`).
- Each batch job takes the next ≤ 50 candidates [CONV] of its phase in `id` order after `after_id`, processes each one inside `ctx.db.tx(…)` (SAVEPOINT; one failing candidate is rolled back to its savepoint and counted, 08 A19 P-44), adds the batch counts to the run row, commits, and enqueues the next batch (then phase `refunds`). The last batch sets the run `completed`.
- A batch job that fails its 3 attempts is dead-lettered; the run stays `running`. The next cron tick for the tenant first marks a `running` run whose `updated_at < now − 2 h` [CONV] as `failed` (`error_code = 'stalled'`), then starts the new run. The 26 h alert (§11) covers the gap.

Per item `applyCheck` (reconciliation mode) plus:

| Finding kind | Condition | Severity | Auto action |
|---|---|---|---|
| `missed_settlement` | open/held intent settled by this run | warning | `settled` |
| `still_held` | held intent unchanged | info | none |
| `late_payment_found` | failed/expired intent with gateway success | critical | `held` (I13) |
| `status_divergence` | settled intent, gateway now not success/refund | critical | none |
| `gateway_refund_unrecorded` | settled intent, gateway shows refund, C15 refunds don't cover it | critical | none |
| `amount_mismatch` | gateway amount ≠ ours | critical | `held` |
| `ledger_entry_missing` | settled intent; idempotent `recordGatewayPayment` returned `duplicate: false` | critical | `ledger_repaired` |
| `ledger_entry_missing` (repair refused) | settled intent; the repair call (inside `ctx.db.tx`, P-44) threw `billing.payment_exceeds_due` because the order's due dropped meanwhile (review m#31) | critical | none — no retry; finance resolves with C4 |
| `refund_unconfirmed` | refund still not visible at gateway; each run that does not see it increments `refunds.unconfirmed_run_count`, and the finding is created when the count reaches 2 (review m#20) | warning | none |
| `gateway_unreachable` | ≥ 3 transient failures for an item in this run | warning | none |

Run → `completed` with counts; metric `lims_payments_reconciliation_last_success_timestamp_seconds{tenant_id}`. Failure → see the stalled-run rule above.

### 6.8 Static-QR worksheet (P18/P19)

`system_total` = `SUM(net_collected_paisa)`, `system_entries = SUM(entries)` from `billing.v_pub_payment_collection` where `tenant_id = ctx.tenantId AND business_date = $d AND payment_method_code = 'fonepay_qr'` (C4 seed code, C4 05-SCHEMA) `[AND centre_id = $c]` [CR-C15-009]. `difference = statement_total − system_total`; `≠ 0` requires `note`; status `matched` / `accepted_with_difference`. One row per `(tenant, business_date, centre or all)`. No ledger change (C4 owns corrections).

### 6.9 Merchant accounts and secrets

- Encrypt: `aes-256-gcm`, 96-bit random nonce, AAD = `tenant_id|gateway|environment|merchant_account_id`, KEK = active key from `LIMS_PAYMENTS_KEK_FILE` (JSON `{ "keys": { "<kek_id>": "<base64 32 bytes>" }, "active": "<kek_id>" }`, SOPS-managed by C1 — CR-C15-008). Store `secret_ciphertext`, `secret_nonce`, `secret_auth_tag`, `secret_kek_id`, `secret_fingerprint = first 8 hex of sha256(secret)`.
- Decrypt only inside `credentials.ts` for one adapter call; zero the Buffer after use (best effort).
- Rotation: `payments.rewrap_credentials` re-encrypts rows whose `secret_kek_id ≠ active` (daily, per tenant).
- Environment guard: production deployment refuses `environment = uat` rows and eSewa product code `EPAYTEST` (the published UAT code); non-production refuses `environment = production` (REQ-SEC-136).
- Test (P22): eSewa status check with a fresh random UUID → documented JSON (`status` present or `code` present) = `reachable_key_unverifiable` (the status check needs no secret, so the secret cannot be proven without a real transaction — the UI says this); Khalti lookup with a random `pidx` → `{"detail":"Not found."…}` = `reachable_key_valid`; `401`/"Invalid token." = `auth_failed`; transport failure = `unreachable`. Every outcome is returned as `200` and stored in `last_test_outcome`/`last_test_at` (review m#18); `payments.credential_invalid` is not emitted. The test is evidenced by the row-audit trigger on `merchant_accounts` (secret columns excluded), not by an access-log row (08 A19 D-112).
- P21/P23 write `ctx.audit.access({action: 'settings.change', entityType: 'payment_merchant_account' | 'payment_settings', detail: {fields: [<changed field names>]}})` (08 A19 D-112; table in §5.1); the secret value never appears in `detail`.

## 7. Gateway adapters

### 7.1 Internal interface

```ts
interface GatewayAdapter {
  readonly gateway: Gateway;
  initiate(i: IntentForGateway, s: SecretHandle, c: CallContext): Promise<{ gatewayTxnRef: string; action: IntentAction; expiresAt: IsoUtc; paymentUrl?: string }>;
  buildAction(i: StoredIntent, s: SecretHandle): IntentAction;                     // replay without network
  check(i: StoredIntent, s: SecretHandle, c: CallContext): Promise<GatewayCheck>;
  verifyCallbackSignature?(payloadB64: string, s: SecretHandle, i: StoredIntent): { valid: boolean; fields?: Readonly<Record<string, string>> };
  refundViaApi?(r: StoredRefund, s: SecretHandle, c: CallContext): Promise<{ kind: 'accepted' | 'rejected' | 'unknown'; detail?: string }>;
}
```

### 7.2 eSewa ePay v2 (04 P3; V1–V8)

7.2.1 **Endpoints** (config §9): form `LIMS_PAYMENTS_ESEWA_FORM_URL` — production `https://epay.esewa.com.np/api/epay/main/v2/form`; UAT **no default** (UNVERIFIED). Status `LIMS_PAYMENTS_ESEWA_STATUS_URL` — production `https://epay.esewa.com.np/api/epay/transaction/status/`, UAT `https://uat.esewa.com.np/api/epay/transaction/status/`.

7.2.2 **Signing and callback signature.** `sign(fields, names) = base64(hmacSha256(secret, names.map(n => n + '=' + fields[n]).join(',')))`. Request: `names = ['total_amount','transaction_uuid','product_code']` (exact order, V2). Callback: decode `data` (Base64 → UTF-8 JSON object, ≤ 4 KB); require keys `status, signature, total_amount, transaction_uuid, product_code, signed_field_names`; split `signed_field_names` on `,`; require it to contain `total_amount`, `transaction_uuid`, `product_code` (REQ-SEC-049); recompute over the listed fields in the listed order; compare with `timingSafeEqual` on decoded bytes (length check first); require `transaction_uuid = intent.gateway_txn_ref` and `product_code = account.product_code`. Result only feeds `payments.callbacks.signature_valid` / `outcome_code`; settlement always needs the status check (04 P7).

7.2.3 **Form fields and launch page.** Fields (all strings; V1): `amount = A`, `tax_amount = "0"`, `product_service_charge = "0"`, `product_delivery_charge = "0"`, `product_code`, `total_amount = A`, `transaction_uuid = <intent id>` (UUID text: hex + hyphens — allowed, 04 P3), `success_url = <PUBLIC_BASE>/v1/payments/callbacks/esewa/<token>/success`, `failure_url = …/failure`, `signed_field_names`, `signature`. `A = formatRupees(amount_paisa)`: integer rupees as decimal digits without separators (e.g. 225000 paisa → `"2250"`); fractional (only if flag on) `"<rupees>.<2 digits>"` — UNVERIFIED. DECISION: VAT/charges are already in C4's invoice; eSewa receives them as `0`. `launchUrl = <PUBLIC_BASE>/v1/payments/launch/<token>`: HTML page with one `<form method="post" action="<form url>">` of hidden inputs and one visible submit button "Continue to eSewa" (no JavaScript; CSP `default-src 'none'; form-action <form url origin>; style-src 'unsafe-inline'`; `Referrer-Policy: no-referrer` so the token is not sent to eSewa in `Referer`).

7.2.4 **Status check** (`GET <status url>?product_code=…&total_amount=A&transaction_uuid=…` — method UNVERIFIED, V5). Parse body as text first. `totalAmount` extracted with `/"totalAmount"\s*:\s*(-?\d+(?:\.\d+)?)/` and converted by the shared decimal parser to paisa (more than 2 non-zero fraction digits → mismatch) — no floating point (02-CV §4.9). `scd` must equal product code when present (else `amount_mismatch` class hold `gateway_identity_mismatch`). `refId` → `gateway_secondary_ref`.

| Gateway answer | Intent open, before deadline | Intent open, after deadline | Intent `held_for_review` | Intent `failed`/`expired` (recon/final check) | Intent `settled`/`*refunded` (recon) |
|---|---|---|---|---|---|
| `COMPLETE` + amount equal | `settle` | `settle` | `settle` (I8) | `hold(late_payment_found)` | ok |
| `COMPLETE` + amount differs | `hold(amount_mismatch)` | same | stay | `hold(amount_mismatch)` | finding `amount_mismatch` |
| `PENDING` | `to_pending` / `stay` | `hold(gateway_pending_after_expiry)` | stay | stay | finding `status_divergence` |
| `AMBIGUOUS` or `AMBIGIOUS` | `hold(gateway_ambiguous)` | same | stay | `hold(gateway_ambiguous)` | finding `status_divergence` |
| `FULL_REFUND` / `PARTIAL_REFUND` | `hold(gateway_refunded_before_settle)` | same | stay | stay | refunds check / finding `gateway_refund_unrecorded` |
| `NOT_FOUND` | `stay` | `expire` | stay | stay | finding `status_divergence` |
| `CANCELED` | `fail(gateway_cancelled)` | same | stay | stay | finding `status_divergence` |
| `{"code":0,…}`, HTTP 5xx, timeout, network | `retry` | `retry` | `retry` | `retry` | `retry` |
| other status / unparseable JSON | `retry` (≤ 3 consecutive), then `hold(gateway_status_unknown)` | same | stay | stay | finding `status_divergence` |

Status strings are compared exactly (case-sensitive) after trimming.

### 7.3 Khalti KPG-2 (04 P4; V9–V15)

7.3.1 **Endpoints**: `LIMS_PAYMENTS_KHALTI_BASE_URL` — production `https://khalti.com/api/v2/`, sandbox `https://dev.khalti.com/api/v2/`; paths `epayment/initiate/`, `epayment/lookup/`. Header `Authorization: Key <secret>` (documented form; samples use lowercase `key` — the documented `Key` is used), `Content-Type: application/json`.

7.3.2 **Initiate** body: `{"return_url": "<PUBLIC_BASE>/v1/payments/callbacks/khalti/<token>", "website_url": <account.khalti_website_url>, "amount": <integer paisa>, "purchase_order_id": "<intent id>", "purchase_order_name": <settings.purchase_order_label>}`. No `customer_info`, `amount_breakdown`, `product_details` or `merchant_*` (no PHI, 04 §11). Response must contain `pidx` (≤ 64 chars) and `payment_url` with scheme `https:`; else `payments.gateway_not_available`. Any `error_key` → `payments.gateway_not_available` (logged with the Khalti `error_key`, not the message).

7.3.3 **Lookup** `POST epayment/lookup/ {"pidx": <stored pidx>}`. The **body `status` field is the signal; the HTTP status code is ignored whenever the body has `status`** (04 P4). `total_amount` must be a JSON integer and safe integer. `transaction_id` → `gateway_secondary_ref`; `refunded` kept for refund checks. Body without `status`: `401`/"Invalid token." → `auth_error` (alert `payments_credential_rejected`; `retry`); `"Not found."` → `not_found` (`retry` ≤ 3 consecutive, then `hold(gateway_not_found)`); 5xx/timeout/network → `retry`.

7.3.4 Mapping (same columns as §7.2.4):

| Lookup `status` | open, before deadline | open, after deadline | held | failed/expired | settled/*refunded |
|---|---|---|---|---|---|
| `Completed` + `total_amount` equal | `settle` | `settle` | `settle` | `hold(late_payment_found)` | ok |
| `Completed` + differs | `hold(amount_mismatch)` | same | stay | `hold(amount_mismatch)` | finding `amount_mismatch` |
| `Pending` | `hold(gateway_pending)` (04 P4 "hold + escalate"; Khalti "hold, and contact Khalti") | same | stay | stay | finding `status_divergence` |
| `Initiated` | `stay` [CR-C15-001 refinement; 04 P4 as amended by 08 A19 D-114/A19.2 — pending founder sign-off F-08] | `hold(gateway_initiated_after_expiry)` | stay | stay | finding `status_divergence` |
| `Refunded` / `Partially Refunded` | `hold(gateway_refunded_before_settle)` | same | stay | stay | refunds check / finding `gateway_refund_unrecorded` |
| `Expired` | `expire` | `expire` | stay | stay | finding `status_divergence` |
| `User canceled`, `Canceled`, `Failed` | `fail(gateway_cancelled)` | same | stay | stay | finding `status_divergence` |
| any other string | `hold(gateway_status_unknown)` | same | stay | stay | finding `status_divergence` |

### 7.4 Khalti refund API (UNVERIFIED, disabled by default)

Only when `merchant_accounts.api_refunds_enabled = true` (tenant admin sets it **after** the UAT task PG-T22 confirms method, auth and amount unit). Request [UNVERIFIED shape from V13]: `POST <origin>/api/merchant-transaction/<transaction_id>/refund/` (origin = `https://khalti.com` / `https://dev.khalti.com` from `LIMS_PAYMENTS_KHALTI_REFUND_ORIGIN`), header as §7.3.1, body `{}` for full refund or `{"amount": <paisa integer>}` for partial; wallet refunds only (bank refunds need the payer `mobile`, which C15 does not store → `mode = manual`). Response `{"detail":"Transaction refund successful."}` → `accepted`; documented failure bodies: none → anything else `unknown`. Confirmation is always by lookup (§6.6 step 6).

### 7.5 Result page (P34)

Static English text (message keys `payments.result.<outcome>` rendered server-side): `settled` "Payment received. You can close this page." · `pending` "We are confirming your payment with the payment provider. You can close this page; the lab will see the result." · `failed` "The payment was not completed. No money was taken by this attempt. Please ask the lab for another way to pay." · `unknown` "We could not find this payment. Please contact the lab." No amounts, names, ids. CSP `default-src 'none'; style-src 'unsafe-inline'`.

### 7.6 Outbound call logging and redaction (REQ-SEC-056/098)

`payments.gateway_calls.response_redacted` keeps only allowlisted keys: eSewa `status, totalAmount (as string), refId, scd, code, error_message`; Khalti lookup `status, total_amount, transaction_id, refunded, fee`, initiate `pidx, expires_at, expires_in, error_key`. Request bodies and headers are never stored. Logs: `gateway, operation, outcome, http_status, duration_ms, intent_id` only. No gateway secret, signature, `payment_url`, callback token or `mobile` ever reaches logs, metrics, traces or error details.

## 8. Events and background jobs

### 8.1 Produced

| Event | Trigger (exact) | Idempotency key | Aggregate |
|---|---|---|---|
| `payments.intent.settled.v1` | commit of the transaction that moves an intent to `settled` (I4, I8) and in which `recordGatewayPayment` returned | `<gateway>:<gateway_txn_ref>:settled` (03-IC §3.20) | `payment_intent`, `seq = intents.version` after the update |

Payload: `intent_id, order_id, gateway, gateway_txn_ref, amount {amount_paisa, currency:'NPR'}, verified_at, verification_method ∈ {esewa_status_check, khalti_lookup}, ledger_entry_id`. `invoice_id` omitted (C15 does not know it). P1.

### 8.2 Consumed

None (03-IC §3.25 lists no C15 subscription). `payments.event_inbox` exists (C0 creates one per module) but stays empty.

### 8.3 Tasks and cron (`services/worker/src/jobs/payments/index.ts`)

| Identifier | Kind | Schedule / trigger | Payload | Behaviour | max_attempts |
|---|---|---|---|---|---|
| `payments.poll_intent` | task | at create: +120, +300, +600, +1200, +2400 s and `deadline` [CONV]; on callback errors: now | `{tenant_id, intent_id, n}` | `applyCheck`; terminal → no further polls; `retry` → throw (built-in backoff) | 8 |
| `payments.sweep_open_intents` | cron | `*/15 * * * *` UTC, `tenantScope: 'per_tenant'` (08 A13 P-6) | — | open intents with `deadline < now − 0` and no check in 15 min → enqueue `poll_intent` now; refunds `requested` older than 1 h → enqueue `check_refund` | 3 |
| `payments.reconcile_tenant` | cron | `40 20 * * *` UTC (02:25 Asia/Kathmandu) [CONV], `tenantScope: 'per_tenant'` | `{tenant_id}` | §6.7: stalled-run check, run row, first batch (skipped if `reconciliation_enabled = false`) | 3 |
| `payments.reconcile_batch` | task | from `reconcile_tenant`, P14, and the previous batch | `{tenant_id, run_id, phase, after_id?}` | §6.7 one batch of ≤ 50 candidates | 3 |
| `payments.execute_refund` | task | P9 in api mode | `{tenant_id, refund_id}` | §6.6 step 4 | 1 |
| `payments.check_refund` | task | after execute; sweep | `{tenant_id, refund_id}` | §6.6 step 6; `retry` on transient (P7b and P11 run the same step in-request) | 8 |
| `payments.rewrap_credentials` | cron | `10 21 * * *` UTC, `tenantScope: 'per_tenant'` | — | §6.9 rotation | 3 |

System actor permissions (manifest `systemPermissions`) [CR-C15-005]: `payments.intent.resolve` is **not** granted; jobs call services directly with explicit job-scoped authorisation (only the transitions listed above).

## 9. Configuration

### 9.1 Global (env `LIMS_PAYMENTS_*`)

| Key | Default | Notes |
|---|---|---|
| `GATEWAY_ENV` | `uat` | `uat` or `production`; must be `production` exactly when `NODE_ENV=production` |
| `PUBLIC_BASE_URL` | — (required) | public HTTPS origin of the API that serves `/v1/payments/{launch,callbacks,result}` (C1) |
| `RETURN_URL_ALLOWLIST` | `${LIMS_ORIGIN_STAFF_WEB}/,${LIMS_ORIGIN_PORTAL}/,${PUBLIC_BASE_URL}/v1/payments/result` | comma list of `origin + path prefix`; `${LIMS_ORIGIN_PORTAL}/` covers C16 `/app/payments/…` and C6 `/r/payments/{id}/done` (08 A11.1); `${PUBLIC_BASE_URL}/v1/payments/result` covers C4 `LIMS_FRONTDESK_PAYMENT_RESULT_URL` (08 A19 D-113) |
| `ESEWA_FORM_URL` | production: `https://epay.esewa.com.np/api/epay/main/v2/form`; uat: none | UAT value UNVERIFIED → must be set; boot fails if empty |
| `ESEWA_STATUS_URL` | production `https://epay.esewa.com.np/api/epay/transaction/status/`; uat `https://uat.esewa.com.np/api/epay/transaction/status/` | 04 P3 |
| `KHALTI_BASE_URL` | production `https://khalti.com/api/v2/`; uat `https://dev.khalti.com/api/v2/` | 04 P4 |
| `KHALTI_REFUND_ORIGIN` | production `https://khalti.com`; uat `https://dev.khalti.com` | V13, used only if api refunds enabled |
| `KEK_FILE` | — (required) | SOPS-decrypted mount (C1) |
| `HTTP_TIMEOUT_INITIATE_MS` / `HTTP_TIMEOUT_INREQUEST_MS` / `HTTP_TIMEOUT_JOB_MS` | 1200 / 2500 / 10000 | [CONV] §3.2 |
| `ESEWA_INTENT_TTL_MINUTES` | 30 | [CONV] eSewa documents no expiry |
| `EXPIRY_GRACE_MINUTES` | 10 | [CONV] |
| `POLL_SCHEDULE_SECONDS` | `120,300,600,1200,2400` | [CONV] |
| `VERIFY_MIN_INTERVAL_SECONDS` | 10 | [CONV] matches C4 B13 "1 call / 10 s / intent" |
| `RECON_LOOKBACK_SETTLED_DAYS` / `RECON_LOOKBACK_CLOSED_DAYS` | 2 / 7 | [CONV] |
| `RECON_CONCURRENCY` | 2 | [CONV] per tenant |
| `ESEWA_ALLOW_FRACTIONAL_RUPEES` | `false` | until UAT confirms decimal amounts |

### 9.2 Per tenant (`payments.settings`, `payments.merchant_accounts`)

`refund_two_person_threshold_paisa` (default 0), `purchase_order_label` (default `Lab payment`), `reconciliation_enabled` (default true); per merchant account: `is_enabled` (default false), product code / website URL, secret, `api_refunds_enabled` (default false).

### 9.3 Boot checks (API and worker)

Fail boot if: KEK file missing/unparseable or active key ≠ 32 bytes; `GATEWAY_ENV=production` with any URL whose host is `uat.esewa.com.np` or `dev.khalti.com`; `GATEWAY_ENV=uat` with production gateway hosts; `ESEWA_FORM_URL` empty; `PUBLIC_BASE_URL` not `https:`.

## 10. Performance targets (derived from 04 §14; ASSUMPTION until load-tested)

| Quantity | Arithmetic | Result |
|---|---|---|
| Intents/day/lab (upper bound) | 500 patients/day (04 §14) × 1 intent each (ASSUMPTION: every patient pays by gateway) | ≤ 500 |
| Intents/day at N = 10 | 500 × 10 | ≤ 5,000 |
| Peak intent creation | 5,000 × 25 % peak hour ÷ 3,600 s | ≈ 0.35/s |
| Gateway checks peak | 0.35/s × (6 polls + 1 callback) | ≈ 2.4 calls/s (all tenants) |
| Reconciliation items/tenant/day | open/held (small) + settled 2 d (≤ 1,000) + closed 7 d (≤ 3,500 worst case) | ≤ 4,500 |
| Reconciliation duration/tenant | 4,500 × 0.5 s (ASSUMPTION per call) ÷ 2 concurrency | ≈ 19 min |
| `payments.intents` growth | 5,000/day × 365 | ≈ 1.8 M rows/year at N = 10 |
| `payments.gateway_calls` growth | 7 calls/intent × 1.8 M | ≈ 12.8 M rows/year (index `(tenant_id, intent_id, created_at)`) |

Latency targets: §5.3. Staff list endpoints p95 ≤ 150 ms for a page of 50 [CONV].

## 11. Observability

Metrics (02-CV §9.4): `lims_payments_intents_created_total{gateway}`, `lims_payments_intents_transitions_total{gateway,to_status}`, `lims_payments_intents_held_total{gateway,reason}`, `lims_payments_gateway_requests_total{gateway,operation,outcome}`, `lims_payments_gateway_request_duration_seconds{gateway,operation}`, `lims_payments_callbacks_total{gateway,kind,outcome}`, `lims_payments_open_intents_past_deadline{gateway}` (gauge, from sweep), `lims_payments_reconciliation_findings_total{kind,severity}`, `lims_payments_reconciliation_last_success_timestamp_seconds{tenant_id}`, `lims_payments_refunds_total{gateway,mode,status}`. Backing gauges for the alert rules (08 A22.4) [CONV names and labels]: `lims_payments_held_for_review_oldest_age_seconds{tenant_id,kind}` (`kind` ∈ `intent`, `refund`; age in seconds of the oldest row of that kind in `held_for_review`, measured for intents from their latest `payments.intent_transitions` row with `to_status = 'held_for_review'`, and for refunds from `refunds.requested_at` (refunds carry no hold timestamp and `updated_at` moves on every check, so the age is an upper bound; no schema change) [CONV]; 0 when none) and `lims_payments_reconciliation_stalled_runs{tenant_id}` (number of the tenant's `reconciliation_runs` in `running` whose `updated_at < now − 2 h`, the §6.7 stalled threshold). Both are set by `payments.sweep_open_intents` (every 15 min, per tenant, §8.3), which already sets `lims_payments_open_intents_past_deadline`. `lims_payments_reconciliation_last_success_timestamp_seconds` is exported only for tenants with `reconciliation_enabled = true` [CONV], so a disabled tenant does not fire the 26 h rule.

Alerts (registered with C1): `amount_mismatch` hold or finding → page; `ledger_entry_missing`/`late_payment_found`/`gateway_refund_unrecorded`/`status_divergence` → page; reconciliation not successful for a tenant in 26 h → page; any `held_for_review` older than 24 h → warn (finance); `signature_invalid` callbacks > 0 in 15 min → warn; gateway error ratio > 20 % over 10 min per gateway → warn; `auth_error` on any call → warn (`payments_credential_rejected`); open intents past deadline + 30 min > 0 → warn. The binding form of these alerts is the table below (08 A22.4).

Logs: structured per 02-CV §9.1; events `payment_intent_created`, `payment_intent_transition`, `payment_amount_mismatch`, `payment_callback_received`, `gateway_call`, `refund_transition`, `reconciliation_run` — ids, codes, statuses only.

#### Alert rules for C1 (08 A13 P-14; 08 A22.4)

C15 keeps the rule file in its own path, `services/worker/src/jobs/payments/ops/payments.rules.yml` [CONV], and C1 wires it through **CR-C15-008** item (6) (no new CR). Routes are C1's receivers (C1 02-TRD §11.3: `page` → `oncall-email`, `warn` → `ops-digest-email`); C1 adds `team` and `runbook_url` (`infra/runbooks/payments.md#<alert>`). Thresholds are the ones of the list above, unchanged; alert names, windows and label mappings are [CONV]. C1 has no finance receiver; the rows marked "finance" are routed to `ops-digest-email` until C1 adds one (CR-C15-008 item (6) "finance on-call where marked").

| Alert | expr | for | severity | route | source rule (list above) |
|---|---|---|---|---|---|
| `PaymentsAmountMismatch` | `sum(increase(lims_payments_intents_held_total{reason="amount_mismatch"}[15m])) > 0 or sum(increase(lims_payments_reconciliation_findings_total{kind="amount_mismatch"}[15m])) > 0` | 0m | page | `oncall-email` (finance) | `amount_mismatch` hold or finding |
| `PaymentsCriticalFinding` | `sum by (kind) (increase(lims_payments_reconciliation_findings_total{kind=~"ledger_entry_missing\|late_payment_found\|gateway_refund_unrecorded\|status_divergence"}[15m])) > 0 or sum(increase(lims_payments_intents_held_total{reason="late_payment_found"}[15m])) > 0` | 0m | page | `oncall-email` (finance) | `ledger_entry_missing` / `late_payment_found` (reconciliation or final check, I13) / `gateway_refund_unrecorded` / `status_divergence` |
| `PaymentsReconciliationMissing` | `time() - max by (tenant_id) (lims_payments_reconciliation_last_success_timestamp_seconds) > 93600` | 0m | page | `oncall-email` | reconciliation not successful for a tenant in 26 h |
| `PaymentsReconciliationStalled` | `max by (tenant_id) (lims_payments_reconciliation_stalled_runs) > 0` | 0m | warn | `ops-digest-email` | §6.7 stalled run (backing gauge, 08 A22.4); the 26 h page above still covers the gap |
| `PaymentsHeldForReviewStale` | `max by (tenant_id, kind) (lims_payments_held_for_review_oldest_age_seconds) > 86400` | 0m | warn | `ops-digest-email` (finance) | any `held_for_review` older than 24 h (backing gauge, 08 A22.4) |
| `PaymentsCallbackSignatureInvalid` | `sum by (gateway) (increase(lims_payments_callbacks_total{outcome="payments.signature_invalid"}[15m])) > 0` | 0m | warn | `ops-digest-email` | `signature_invalid` callbacks > 0 in 15 min |
| `PaymentsGatewayErrorRatio` | `sum by (gateway) (rate(lims_payments_gateway_requests_total{outcome=~"service_unavailable\|timeout\|network_error\|http_error\|invalid_response\|auth_error"}[10m])) / sum by (gateway) (rate(lims_payments_gateway_requests_total[10m])) > 0.2` | 10m | warn | `ops-digest-email` | gateway error ratio > 20 % over 10 min per gateway |
| `PaymentsCredentialRejected` | `sum by (gateway) (increase(lims_payments_gateway_requests_total{outcome="auth_error"}[15m])) > 0` | 0m | warn | `ops-digest-email` | `auth_error` on any call (`payments_credential_rejected`) |
| `PaymentsOpenIntentsPastDeadline` | `max by (gateway) (lims_payments_open_intents_past_deadline) > 0` | 30m | warn | `ops-digest-email` | open intents past deadline + 30 min > 0 |

Label values used above: `outcome` of `lims_payments_gateway_requests_total` = `payments.gateway_calls.outcome` (05-SCHEMA `gateway_calls__outcome__ck`); "error" = every value except `answer` and `not_found` (`not_found` is a gateway answer handled by the mapping tables, §7.2.4/§7.3.4) [CONV]. `outcome` of `lims_payments_callbacks_total` = `payments.callbacks.outcome_code`. `reason` of `lims_payments_intents_held_total` = `hold_reasons` codes; `kind` of `lims_payments_reconciliation_findings_total` = `finding_kinds` codes (05-SCHEMA §3). In the table, `\|` is the Markdown escape of the regex alternation `|`.

CI jobs for C0-0A (P-14): none.


## 12. Test strategy

| Layer | What | Fakes / tools |
|---|---|---|
| Unit | `intent.state.ts`, `refund.state.ts` (every allowed + representative forbidden transition); mapping tables §7.2.4/§7.3.4 (every row × every column); `amount.ts` (paisa → rupee string; decimal parse incl. `150.0`, `2250`, `22.5`, `0.001`); signing (eSewa documented example message shape; golden HMAC vectors generated with a synthetic key); callback signature (altered field set, missing names, wrong order, truncated signature, length mismatch); `returnurl.ts`; redaction | — |
| Integration | services + repos + RLS on migrated PG 17 (tenant_a/tenant_b seeds): create/replay/open-exists races (50 parallel creates, same key → 1 row; different keys → 1 open), settle exactly once under 10 concurrent callbacks + polls, rollback leaves no ledger/event, exceeds-due hold, refunds two-person, reconciliation findings, static-QR preview | gateway simulators `__tests__/sim/*.sim.ts` (local HTTP servers returning every documented body incl. `code: 0`, `AMBIGIOUS`, HTTP 400 `User canceled`, `Invalid token.`, `Not found.`); BillingPort/FrontdeskPort/IdentityPort fakes then real |
| Contract — port | `runPaymentProviderPortContract` (03-IC §4.9 cases 1–11 + 12–18) against the real impl | `packages/fakes/contract-tests` |
| Contract — HTTP | every operation request/response validated against `payments.yaml`; one test per `x-error-codes` entry; the §6.3 step 6 redirect is followed to P34 for every outcome and returns `200` (review #2) | fastify-openapi-glue validation |
| Contract — events | every published payload validates against `payments.intent.settled.v1` schema | ajv |
| Probes | cross-tenant for every operation (incl. callback tokens of other tenants), every table (§11.3 of 02-CV); partner/portal/patient claims of the same tenant read 0 rows of every `payments.*` table (08 A17 P-16); the callback DEFINER's A12.7 cases (05-SCHEMA §10 items 11–13) | C0 generator + hand-written |
| Savepoint (08 A19 P-44) | callback `applyCheck` and reconciliation per-candidate/ledger-repair paths: the fake writes a marker row then fails (`failNext`); the marker is absent after commit and the outer transaction commits | BillingPort fake |
| Observability (08 A22.4) | `payments.sweep_open_intents` sets `lims_payments_held_for_review_oldest_age_seconds{tenant_id,kind}` (seeded intent held 25 h ago → ≥ 90000 for `intent`; refund held, requested 2 h ago → ≈ 7200 for `refund`; none → 0) and `lims_payments_reconciliation_stalled_runs{tenant_id}` (a `running` run with `updated_at` 3 h old → 1; 1 h old → 0); the last-success timestamp series is absent for a tenant with `reconciliation_enabled = false`; `payments.rules.yml` contains exactly the §11 "Alert rules for C1" rows (names, expr, for, severity) — checked by C1's `promtool check rules` / `promtool test rules` once wired (CR-C15-008 item (6)) | metrics registry test; seeded DB |
| Consumers | port contract suite run with the C4 staff caller, the C16 engagement-worker fake and the C6 reporting-worker fake (PG-T24); a patient/portal actor context → `auth.forbidden` | `packages/fakes` |
| E2E (staging, UAT credentials only) | eSewa UAT and Khalti sandbox round trips (PG-T21/T22) | real sandbox, synthetic tenant |
| Security | §07 tests | — |

## 13. Error codes used

From 03-IC §8: `payments.gateway_not_available`, `payments.intent_open_exists`, `payments.nothing_due`, `payments.signature_invalid`, `payments.callback_stale`, `payments.refund_exceeds_captured`, `payments.refund_requires_approval`, `common.*`, `auth.*`. New [CR-C15-006]: `payments.amount_not_supported`, `payments.return_url_not_allowed`, `payments.intent_invalid_transition`, `payments.intent_not_verifiable`, `payments.refund_not_allowed`, `payments.refund_self_approval_forbidden`, `payments.credential_invalid`, `payments.reconciliation_in_progress`, `payments.callback_mismatch`, `payments.static_qr_already_reconciled`. `payments.credential_invalid` stays registered but is emitted by no operation (P22 returns `200 {outcome: 'auth_failed'}`, review m#18; same treatment as 08 A7.2 / A19 D-111). `common.validation_failed` is always `400` (08 A13 P-1). C15 never constructs `billing.*` or `frontdesk.*` codes; errors thrown by `BillingPort`/`FrontdeskPort` propagate unchanged — the handler rethrows the original `LimsError` (08 A17 P-23) — except the one caught case of §6.7 (ledger repair).

## Change requests raised

> Status per `program/08-CR-REGISTER.md` (2026-11-06). CR texts below are kept as history.

| CR | Status |
|---|---|
| CR-C15-001 | ACCEPTED-MODIFIED in 08 — All methods callable by staff or system actors only (R8). |
| CR-C15-002 | ACCEPTED-MODIFIED in 08 — Callers system/staff only (no patient/portal context); `collected_by_membership_id` NULL for gateway capture (R8). |
| CR-C15-003 | ACCEPTED in 08 |
| CR-C15-004 | ACCEPTED in 08 |
| CR-C15-005 | ACCEPTED in 08 |
| CR-C15-006 | ACCEPTED in 08 |
| CR-C15-007 | ACCEPTED in 08 |
| CR-C15-008 | ACCEPTED in 08 |
| CR-C15-009 | ACCEPTED in 08 |
| CR-C15-010 | ACCEPT-MODIFIED (08 A11.1, ledger wording replaced by A19.3 / D-115) — C6 portal dues payment ships with C15: the C6 worker (reporting system actor) calls `createIntent`/`getIntent`; return/cancel URL `<PORTAL>/r/payments/{portal_payment_request_id}/done` (route `portal.payment_done`). |
| CR-C15-011 | ACCEPTED in 08 |
| CR-C15-012 | MERGED in 08 into CR-C4-012 |
| CR-C15-013 | ACCEPTED in 08 |
| CR-C15-014 | Registered by 08 A19 D-110 [CONV id] — C15 as FrontdeskPort consumer (`getOrderSummary` only). Text below. |
| CR-C15-015 | Not raised — the access-log codes the review proposed (#5) are not needed (08 A19 D-112). |
| CR-C15-016 | Registered by 08 A19 D-113 [CONV id] — C4 front-desk gateway dialog contract. Text below. |
| Review fix pass 2026-11-06 | review/C15-payment-gateways.md + 08 Addendum A19 (plus A11.1 portal payments as amended by A19.3, and A13/A17 rules P-1…P-23 that apply to C15) applied. |
| Final sweep 2026-11-06 — second touch applied | 08 A22.4: backing gauges `lims_payments_held_for_review_oldest_age_seconds{tenant_id,kind}` and `lims_payments_reconciliation_stalled_runs{tenant_id}` [CONV] set by `payments.sweep_open_intents`, and the §11 "Alert rules for C1" table (rule file `services/worker/src/jobs/payments/ops/payments.rules.yml` [CONV], wired by C1 under CR-C15-008 item (6)); test row "Observability (08 A22.4)" (§12); plan PG-T20. Already present, verified: return-URL allowlist default `${LIMS_ORIGIN_PORTAL}/` covers `<LIMS_ORIGIN_PORTAL>/r/payments/` (§9.1); no DEFERRED text left in 01-PRD or 02-TRD for the C6 portal flow (PRD US-PG-11b, TRD §5.3, CR-C15-010 row). No SQL change. |

**08 Addenda applied (08 A25 P-60: one row per addendum A1–A29; final check 2026-11-06)**

| Addendum | Status for C15 |
|---|---|
| A1 | not applicable |
| A2 | not applicable |
| A3 | not applicable |
| A4 | not applicable |
| A5 | not applicable |
| A6 | not applicable |
| A7 | applied 2026-11-06 — A7.2 (TRD) |
| A8 | not applicable |
| A9 | not applicable |
| A10 | not applicable |
| A11 | applied 2026-11-06 — A11.1 (PRD, TRD, AF, UI, SCH, PLAN, SEC) |
| A12 | applied 2026-11-06 — A12.1, A12.2, A12.7 (TRD, SCH, SEC) |
| A13 | applied 2026-11-06 — P-1, P-2, P-3, P-4, P-5, P-6, P-7, P-8, P-14, P-15, D-14 (PRD, TRD) |
| A14 | not applicable |
| A15 | not applicable |
| A16 | applied 2026-11-06 — A16.1 (SCH) |
| A17 | applied 2026-11-06 — P-16, P-17, P-18, P-20, P-22, P-23 (PRD, TRD, SCH, PLAN, SEC) |
| A18 | not applicable |
| A19 | applied 2026-11-06 — P-40, P-41, P-43, P-44, P-46, D-110, D-111, D-112, D-113, D-114, D-115, D-116, D-117, D-118, A19.2, A19.3 (PRD, TRD, AF, UI, SCH, PLAN, SEC) |
| A20 | not applicable |
| A21 | not applicable (A21.1 is C6's dues link; the C15 payment flow behind it is unchanged) |
| A22 | applied 2026-11-06 — A22.4 (PRD, TRD, PLAN) |
| A23 | not applicable |
| A24 | not applicable |
| A25 | not applicable |
| A26 | not applicable |
| A27 | not applicable |
| A28 | not applicable |
| A29 | not applicable |


**CR-C15-001: PaymentProviderPort additive methods and contract refinement**
From chunk: C15 · To owner: C0-0C (consumers C4, C16 informed) · Type: port · Blocking? no (C15 builds the impl; fakes updated by C0)
Problem: (a) consumers cannot read an intent's status without triggering a gateway call (US-PG-11 AC2); (b) an unpaid open intent blocks a new one until expiry, and there is no way to abandon it safely (US-PG-13); (c) eSewa is a form POST, which cannot be shown as a QR or opened from a mobile app without a hosted page (US-PG-01 AC1, US-PG-11); (d) contract case 5 ("each hold status → held_for_review") would hold every Khalti `Initiated` intent at the first "Check now" before the patient has paid.
Proposed change (exact): in `contracts/ports/PaymentProviderPort.ts` add `launchUrl?: string` to the `form_post` member of `IntentAction`; add methods `getIntent` and `cancelIntent` exactly as in `02-TRD.md` §5.3. Contract case 5 reworded: "each hold status (eSewa `AMBIGUOUS`/`AMBIGIOUS`/`FULL_REFUND`/`PARTIAL_REFUND`/unknown; Khalti `Pending`/`Refunded`/`Partially Refunded`/unknown) → `held_for_review`; eSewa `PENDING`/`NOT_FOUND` and Khalti `Initiated` before `expires_at + grace` → unchanged non-terminal; after it → `held_for_review` (`PENDING`, `Initiated`) or `expired` (`NOT_FOUND`)". Add cases 12–18 (§5.3). Fake: implement the two methods and the deadline rule.
Backward compatible? yes (new optional field, new methods; no consumer breaks).
Tenant/security impact: none new; `getIntent` returns P1 data only.
Alternatives considered: C15 HTTP endpoints for C16 (rejected: C16 talks to C15 by port, CM §5); hold on every `Initiated` (rejected: floods finance, contradicts Khalti's own guidance that only `Pending` needs contact).
Tests: contract cases 5 (refined), 12–18 on fake and real.

**CR-C15-002: BillingPort.recordGatewayRefund and allowExceedsDue**
From: C15 · To: C0-0C + C4 (implementer) · Type: port · Blocking? yes for PG-T15 (refund completion) and PG-T11 AC4; work continues against the fake.
Problem: gateway refunds must appear in the ledger as refund rows (C4 06-PLAN lists this CR as expected; C4 03-APP-FLOW §2.12 routes gateway refunds to C15). A verified gateway payment that exceeds the current due (cash part payment recorded meanwhile) cannot be recorded today (`billing.payment_exceeds_due`), although the money has moved (US-PG-06 AC3, US-PG-07 AC4).
Proposed change (exact, additive to `BillingPortV1`):
```ts
export interface GatewayPaymentInput { /* existing fields */ readonly allowExceedsDue?: boolean }   // when true: record the full amount and open a
                                                                                                     // finance_review_items row kind 'gateway_payment_exceeds_due'
export interface GatewayRefundInput {
  readonly refundId: Uuidv7; readonly intentId: Uuidv7; readonly orderId: Uuidv7;
  readonly gateway: 'esewa' | 'khalti' | 'fonepay'; readonly gatewayTxnRef: string;
  readonly amount: Money;             // positive; C4 stores it negative (entry_kind 'refund', capture_kind 'gateway')
  readonly reasonCode: Code; readonly approvedByMembershipId: Uuidv7; readonly refundedAt: IsoUtc;
}
/** Idempotent on refundId. @throws billing.ledger_reversal_invalid (amount > refundable) */
recordGatewayRefund(ctx: RequestContext, input: GatewayRefundInput): Promise<{ ledgerEntryId: Uuidv7; duplicate: boolean; balance: OrderBalance }>;
```
C4 DDL: `finance_review_items.kind` adds `'gateway_payment_exceeds_due'`; ledger unique partial index `(tenant_id, idempotency_key)` already exists — C4 uses `idempotency_key = 'gw_refund:' || refundId`. `billing.balance.changed.v1` cause for refunds = `payment_reversed` (existing mapping, C4-TRD §8.1).
Alignment notes for C4 (as decided in 08): `collected_by_membership_id` is NULL for gateway capture; BillingPort callers are staff/system only (08 R8).
Backward compatible? yes. Security: refunds stay privileged in C15 (two-person); IRD impact: refund rows are ledger rows (not invoices), no fiscal document change (04 P1).
Tests: BillingPort contract adds (11) refund idempotent on refundId, (12) refund > refundable → `billing.ledger_reversal_invalid`, (13) `allowExceedsDue` records + opens review item.

**CR-C15-003: Payment-intent state machine clarifications (03-IC §10.6)**
From: C15 · To: C0-0C / doc owner · Type: event/port semantics · Blocking? no
Problem: §10.6 lists the chain but not (a) that any open state may move to a terminal state, (b) money found late on a `failed`/`expired` intent (cancelled Khalti link still payable until expiry; eSewa has no documented expiry), (c) repeated partial refunds.
Proposed change: replace §10.6 text with the transition table in `02-TRD.md` §4.1 (I1–I14), including `failed|expired → held_for_review` (`late_payment_found`) and `partially_refunded → partially_refunded|refunded`. Only `→ settled` emits the event (unchanged).
Backward compatible? yes (no consumer reads intent states except via the port). Tests: unit state-table tests; integration late-payment test.

**CR-C15-004: Public payment-callback authentication in the API core**
From: C15 · To: C0-0D (core) + C0-0B (DEFINER) · Type: api/schema · Blocking? yes for PG-T09 (callbacks); dev uses a test-only resolver.
Problem: gateway redirects reach C15 without any credential, and 02-CV §6 forbids taking the tenant from a path segment. `ModuleManifest.authResolvers` allows only `deviceToken` (instruments) and `portalSession` (reporting) (C0 TRD §6.3).
Proposed change: (1) `authResolvers.paymentCallback?: AuthResolver` allowed only for module `payments`; resolver result `actor: { type: 'system', id: <payments system actor> }`, `extraClaims: { payment_intent_id }`. (2) OpenAPI security scheme `paymentCallbackToken` (path parameter `callback_token`, base64url 43 chars) usable only in `payments.yaml`. (3) DEFINER `app.payments_resolve_callback_token(p_token_sha256 bytea) RETURNS TABLE (tenant_id uuid, intent_id uuid)`, owner `lims_owner`, `EXECUTE` to `lims_api`, `SET search_path = ''`, body `SELECT i.tenant_id, i.id FROM payments.intents i WHERE i.callback_token_sha256 = p_token_sha256 AND i.created_at > now() - interval '30 days'`, relying on policy `intents__select__owner_only` (`TO lims_owner USING (callback_token_sha256 = nullif(current_setting('app.payments_lookup_token', true), '')::bytea)`, the function sets that GUC with `set_config(…, true)` first). Added to `db/meta/definer-inventory.yaml`. **[Superseded in part, 08 A19 P-41 / A12.1:** the GUC is `app.pre_payments_callback_token_sha256` (hex), the owner policy is `USING (callback_token_sha256 = decode(current_setting('app.pre_payments_callback_token_sha256', true), 'hex'))` with no other disjunct, and the 30-day window is a constant — 05-SCHEMA §3/§6 are binding.**]** (4) Index exception: `intents__callback_token_sha256__uq` is unique on the hash alone (not tenant-leading) because the lookup happens before any tenant context — list it in the C0 index-lint exception file with this justification (same need as C7 device tokens). (5) Public operations of `payments` may respond `303` and `text/html` (P30, P34) — spec lint allows `text/html` responses only for operations with `x-public` or `paymentCallbackToken`.
Backward compatible? yes. Security: new public surface (REQ-SEC-052, 099) → security sign-off (05-DoD §4). Tokens ≥256-bit CSPRNG, stored as SHA-256 (04 A13 pattern); invalid tokens indistinguishable.
Tests: probes — tenant-B token never yields tenant-A data; expired token → `unknown`; DEFINER inventory test.

**CR-C15-005: Permissions**
From: C15 · To: C0-0C (`contracts/permissions.yaml`) · Type: api · Blocking? no
Add (phase 1.5): `payments.intent.resolve` (privileged, roles [finance]); `payments.refund.request` (privileged, [finance]); `payments.refund.approve` (privileged, [finance]); `payments.merchant_config.read` (not privileged, [tenant_admin, finance]); `payments.merchant_config.manage` (privileged, [tenant_admin]). `payments.intent.create` also granted to `finance` (cancel from the review screen). Worker `systemPermissions` for `payments`: none beyond its own service calls (no `payments.*` HTTP permissions). Rationale: `billing.refund.approve` governs C4's manual refunds; gateway refunds are a separate privileged path (REQ-SEC-055; 04 A4 "finance/refund" roles need MFA).

**CR-C15-006: Error codes** (to C0-0C `contracts/errors.yaml`, owner C15)
```yaml
- { code: payments.amount_not_supported,        http: 422, owner: C15, title: "Amount not supported by this payment method", meaning: "Khalti < 1000 paisa (04 P4); eSewa fractional rupees while unverified" }
- { code: payments.return_url_not_allowed,      http: 422, owner: C15, title: "Return address not allowed", meaning: "returnUrl/cancelUrl outside the allowlist" }
- { code: payments.intent_invalid_transition,   http: 409, owner: C15, title: "Payment cannot move to the requested state", meaning: "02-TRD §4.1" }
- { code: payments.intent_not_verifiable,       http: 409, owner: C15, title: "Payment not confirmed by the provider", meaning: "Resolve requires gateway success + exact amount" }
- { code: payments.refund_not_allowed,          http: 409, owner: C15, title: "Refund not allowed", meaning: "Intent not settled, refund in progress, or wrong refund state" }
- { code: payments.refund_self_approval_forbidden, http: 403, owner: C15, title: "Refund needs a second approver", meaning: "REQ-SEC-055 two-person rule" }
- { code: payments.credential_invalid,          http: 422, owner: C15, title: "Merchant credentials rejected", meaning: "Gateway rejected the key during test" }
- { code: payments.reconciliation_in_progress,  http: 409, owner: C15, title: "Reconciliation already running", meaning: "" }
- { code: payments.callback_mismatch,           http: 400, owner: C15, title: "Callback does not match payment", meaning: "Recorded outcome only; callbacks never change state" }
- { code: payments.static_qr_already_reconciled, http: 409, owner: C15, title: "Already reconciled", meaning: "One worksheet per date and centre" }
```

**CR-C15-007: Web deployable and routes for C15**
From: C15 · To: doc owner (CM §2/§3) + C0-0C (`contracts/routes.yaml`) · Type: api/docs · Blocking? no (API first)
Problem: CM §2 lists C15 deployables "api payments, worker payments" only, but finance/tenant-admin screens (held queue, refunds, reconciliation, static QR, merchant settings) are needed (US-PG-07…12).
Proposed: C15 owns `apps/web/src/app/(staff)/payments/**` and `apps/web/src/features/payments/**`. Routes: `staff.payments.review` `/payments/review` (`payments.reconciliation.read`); `staff.payments.intent` `/payments/intents/{intent_id}` (`payments.reconciliation.read`); `staff.payments.refunds` `/payments/refunds` (`payments.reconciliation.read`); `staff.payments.reconciliation` `/payments/reconciliation` (`payments.reconciliation.read`); `staff.payments.static_qr` `/payments/static-qr` (`payments.reconciliation.read`); `staff.payments.settings` `/payments/settings` (`payments.merchant_config.read`). Nav group `billing`.

**CR-C15-008: Infrastructure for public payment routes and secrets**
From: C15 · To: C1 · Type: infra · Blocking? yes for production enablement (PG-T23), not for development.
Requests: (1) Publish the API origin `LIMS_PAYMENTS_PUBLIC_BASE_URL` over TLS per 04 I5 on Nepal infra (03 §9.3; REQ-ARCH-087), no foreign CDN (04 I7). (2) nginx locations `= /v1/payments/result`, `^~ /v1/payments/launch/`, `^~ /v1/payments/callbacks/`: methods `GET`/`HEAD` only (others 405), request body 0, `limit_req` zone keyed by client IP **10 r/s burst 20** (04 §4 "General API" values, applied per IP because these routes have no user), `Referrer-Policy: no-referrer`, `Cache-Control: no-store`, HSTS per 04 I6. (3) Access-log path masking for `/v1/payments/launch/*` and `/v1/payments/callbacks/*` (token segment replaced by `:token`) and never log query strings for `/v1/payments/callbacks/*` (Khalti adds `mobile`) — same mechanism as the `/r/`, `/v/` token routes (03-IC §7). (4) Egress allowlist from API and worker containers: production `epay.esewa.com.np:443`, `khalti.com:443`; staging `uat.esewa.com.np:443`, `dev.khalti.com:443` (+ the eSewa UAT form host once known). No other gateway egress. (5) SOPS-managed file for `LIMS_PAYMENTS_KEK_FILE` (per environment, distinct keys), mounted read-only into API and worker; rotation runbook (add new key id → set active → wait for `payments.rewrap_credentials` → remove old). (6) Alert rules from 02-TRD §11 routed to finance on-call where marked.

**CR-C15-009: C15 as consumer of `billing.v_pub_payment_collection`**
From: C15 · To: C0-0C (03-IC §6.2 consumer list) + C4 (owner) · Type: api · Blocking? no
Problem: static-QR reconciliation (04 P5 interim) needs the daily sum of `fonepay_qr` ledger entries per date/centre. Proposed: add C15 to the view's consumers; no column change. Reads are tenant/centre-scoped (security_invoker).

**CR-C15-010: C6 portal as PaymentProviderPort consumer**
From: C15 · To: C0-0C (03-IC §4.9 consumer list, CM §5.1) + C6 (must agree) · Type: port · Blocking? no
[Now ACCEPT-MODIFIED by 08 A11.1 / A19.3; the binding text is §5.3 "C6 portal flow" and 03-APP-FLOW §2.5.] Problem: the portal (C6) shows dues and is the web fallback for the patient app; paying a due there needs the port. Proposed: consumers C4, C6, C16. C6 authorises the portal actor against the link's order before calling; return URLs on `LIMS_ORIGIN_PORTAL` are already allowlisted. If C6 declines, portal checkout is out of scope and only C16 uses the hosted flow.

**CR-C15-011: UI kit `SecretField`**
From: C15 · To: C0-0D · Type: ui-kit · Blocking? no (TextField with a "replace secret" toggle as interim is **not** used; the settings screen ships after the component)
Proposed: `SecretFieldProps extends FieldBase { onChange(v: string | undefined): void; maxLength: number; isSet: boolean; fingerprint?: string; setAt?: IsoUtc }` — renders a masked input (`type=password`, `autocomplete=off`, no reveal toggle, value never pre-filled), and "Set on <date> · fingerprint <8 hex>" when `isSet`.

**CR-C15-012: 02-CV §4.7 clarification for finance-entered amounts**
From: C15 · To: doc owner · Type: docs · Blocking? no
Problem: 02-CV §4.7 forbids `amount_paisa (for payments)` in client bodies. C15 accepts `amount_paisa` on refund **requests** (a finance decision, bounded server-side by captured and refundable amounts and approved by a second person) and `statement_total_paisa` on the static-QR worksheet (a bank-statement figure that never touches the ledger). Proposed wording: "…never accept amounts that the server can compute (prices, dues, gateway amounts); finance-entered amounts are allowed only where the server bounds them and the operation is privileged." Same interpretation as C4's CR-C4-012.

**CR-C15-013: Audit-trigger column exclusion for merchant secrets**
From: C15 · To: C0-0B · Type: schema · Blocking? no
Problem: the generic JSONB old/new audit trigger (04 D11) would copy `payments.merchant_accounts.secret_ciphertext/secret_nonce/secret_auth_tag` into `audit.audit_log`, spreading encrypted credentials into a store with different retention and readers.
Proposed: `app.tg_row_audit()` accepts a per-table excluded-column list (trigger argument); for `payments.merchant_accounts` exclude those three columns and record only `secret_fingerprint`/`secret_set_at` changes. Tests: audit row after a secret replacement contains no `secret_ciphertext` key.

**CR-C15-014: C15 as FrontdeskPort consumer** (08 A19 D-110 / P-46; review #4)
From: C15 · To: C0-0C (03-IC §4.3 heading), doc owner (01-CM §5.1 and §6 matrix), C4 (fake + contract suite) · Type: port · Blocking? no (the C0 fake already implements `getOrderSummary`)
Problem: C15 calls `FrontdeskPort.getOrderSummary` (§6.1 step 5) but is not a listed consumer, so the port-manifest check and the consumer contract suite do not cover it.
Proposed change (exact, as decided in D-110): 03-IC §4.3 / 01-CM §5.1 FrontdeskPort consumers = "C5, C6, C10, C11, C13, C14, C15, C16, C17"; C15 calls `getOrderSummary` only, under staff or system actors. 01-CM §6 row C15: `p` under C4, `v` under C4 (CR-C15-009), dependency on C1 (CR-C15-008). C4 fake and contract suite add the caller.
Backward compatible? yes. Tests: C4 contract suite case "C15 caller (staff / system) reads summary"; C0 port-manifest check passes for `payments`.

**CR-C15-016: C4 front-desk gateway dialog** (08 A19 D-113; review #8, #9, m#16)
From: C15 · To: C4 · Type: api/ui · Blocking? no for C15 (C15 P5 and P24b exist); yes for the C4 dialog behaviour
Proposed change (exact, as decided in D-113):
1. C4 B12 passes `returnUrl = cancelUrl = ${LIMS_FRONTDESK_PAYMENT_RESULT_URL}` — new C4 config key [CONV], set by C1 to `<LIMS_PAYMENTS_PUBLIC_BASE_URL>/v1/payments/result` (already on C15's default allowlist, §9.1).
2. For `action.kind = 'form_post'` the C4 dialog shows a QR of `action.launchUrl` and an "Open on this PC" button that opens `launchUrl` in a new window. C4 never posts `fields` itself (04-UI-UX §4).
3. "Cancel payment" in the C4 dialog calls C15 P5 `cancelPaymentIntent` through the staff BFF (`payments.intent.create`, held by `front_desk`; precedent 08 A13 D-14) and reads the reason list from P24b `listPaymentCancelReasons`. No new C4 endpoint.
4. C4 B12 `x-error-codes` += `payments.amount_not_supported`, `payments.return_url_not_allowed` (propagated from the port unchanged, 08 A17 P-23).
Backward compatible? yes (additive C4 config and UI). Tests: C4 dialog component test (QR of `launchUrl`, no form post); C4 B12 HTTP contract cases for the two codes; C15 P5/P24b permission tests with a `front_desk` session.

