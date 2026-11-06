# C15 — Payment Gateways — 06 Implementation Plan

Status: DECISION draft, 2026-11-06. One task ≈ one PR (02-CV §12). Branch `c15/<topic>`. Every task's tests are listed; "AC" = `01-PRD.md` acceptance criteria.

## 0. Prerequisites from C0 (block integration tests, not the start of work)

`payments` DDL + RLS + triggers from `05-SCHEMA.md` (C0 T0B-13 contract wave 2); `contracts/openapi/payments.yaml` from TRD §5; `payments.intent.settled.v1` schema (03-IC §3.20); `PaymentProviderPort` with CR-C15-001; BillingPort fake with CR-C15-002; permissions CR-C15-005; errors CR-C15-006; callback resolver + DEFINER CR-C15-004 (owner policy and GUC per 05-SCHEMA §3, 08 A19 P-41); routes CR-C15-007; `SecretField` CR-C15-011; FrontdeskPort consumer entry CR-C15-014 (08 A19 D-110); C4 dialog contract CR-C15-016 (08 A19 D-113, needed for the C4 side only); C1 public routes/egress/KEK CR-C15-008 (production only). Until merged: work against Prism mocks (`pnpm mock:payments`) and `@lims/fakes`. C15 never writes its own migrations (path ownership, CM §4): DB integration tests wait for C0's DDL; unit and simulator tests do not.

## 1. Tasks

| ID | Goal | Files / paths | Depends on | Done when | Tests | ACs |
|---|---|---|---|---|---|---|
| PG-T01 | Module skeleton, manifest, config + boot checks; phase-stub replacement (08 A17 P-20) | `services/api/src/modules/payments/{index,permissions,config}.ts`, `services/worker/src/jobs/payments/index.ts`; paired C0-0D PR removing `PaymentProviderPort` from `phase-stubs.ts` | C0 cores | boot fails per TRD §9.3; manifest validates (ports, produces, resolver); the module registers its own port implementation that returns exactly the stub results for every method not yet built | unit config tests (each boot-failure rule); `phase1Stub` contract subset passes on the module implementation | US-PG-15 |
| PG-T02 | Domain: intent + refund state tables, mapping tables, amount, return-URL | `domain/*.ts` | — | every TRD §4/§7.2.4/§7.3.4 row encoded as data | unit: every allowed transition + one forbidden per state; every mapping cell; amount golden cases (`2250`, `150.0`, `22.5`, `0.001`, 999 paisa Khalti); allowlist cases | US-PG-03 AC4–6, 04 AC2–6 |
| PG-T03 | Credentials: KEK load, AES-256-GCM, fingerprint, SecretHandle | `service/credentials.ts` | PG-T01 | encrypt/decrypt round trip with AAD; wrong AAD/kek → fails closed; secrets never in logger output | unit; planted-secret log-scan test | US-PG-10 AC1 |
| PG-T04 | HTTP wrapper + gateway_calls logging + redaction | `gateways/http.ts`, `repository/gatewayCalls.repo.ts` | PG-T01 | timeouts per class; allowlisted keys only stored | unit (redaction of unknown keys, `mobile`), integration | REQ-SEC-056/098 |
| PG-T05 | Gateway simulators | `__tests__/sim/esewa.sim.ts`, `khalti.sim.ts` | — | every documented body/status incl. `code:0`, `AMBIGIOUS`, HTTP 400 `User canceled`, `Invalid token.`, `Not found.` scriptable per test | self-tests | — |
| PG-T06 | eSewa adapter (sign, buildAction, check, callback signature) | `gateways/esewa.adapter.ts` | PG-T02–T05 | fields per TRD §7.2.3; signature verified constant-time; status parsed without floats | unit + sim | US-PG-01 AC1, 03 AC1–6 |
| PG-T07 | Khalti adapter (initiate, check) + Fonepay slot | `gateways/khalti.adapter.ts`, `fonepay.adapter.ts` | PG-T02–T05 | body status is the signal; `Key` header; no PII in initiate | unit + sim (HTTP code ignored when body has status) | US-PG-02, 04, 12 AC1 |
| PG-T08 | `createIntent` / `getIntent` / `cancelIntent` / `verify` services + port impl | `service/intent.service.ts`, `outcome.service.ts`, `ports/PaymentProviderPort.impl.ts`, repos | PG-T06/T07, C0 DDL | TRD §6.1–§6.4 | integration (50 parallel same key → 1 row; different keys → 1 open + `intent_open_exists`; settle once under 10 concurrent verifies; rollback leaves no ledger spy call/event); **port contract suite 1–18** | US-PG-01, 02, 05, 06, 13 |
| PG-T09 | Public routes: resolver, launch, callbacks, result page | `handlers/{launchEsewaPayment,esewaSuccessCallback,esewaFailureCallback,khaltiReturnCallback,getPaymentResultPage}.ts`, `pages/*`, `service/callback.service.ts` | PG-T08, CR-C15-004 | 303 rules TRD §6.3; headers (no-store, no-referrer, CSP); invalid token = identical `unknown` | HTTP contract; replay 10× → one ledger call; forged signature stays unpaid; probes with tenant-B token; redirect to P34 with `intent_id` → `200` for every outcome (review #2); throttled hit → `rate_limited` row; P30 writes a `launch` row; P-44 savepoint marker test on the callback path | US-PG-03 (incl. AC9), 04, 11, 11b, 14 AC2 |
| PG-T10 | Event publisher | `events/publish.ts` | PG-T08 | payload validates; idempotency key `<gateway>:<ref>:settled` | event contract test; duplicate settle → one event | US-PG-06 |
| PG-T11 | Worker: poll, sweep | `tasks/poll_intent.ts`, `sweep_open_intents.ts`, `cron.ts` | PG-T08 | schedule per TRD §8.3; terminal stops polls | worker integration with fake clock; lost job recovered by sweep | US-PG-05 |
| PG-T12 | Staff intent endpoints P1–P5, P24, P24b | handlers + mappers | PG-T08 | DTO allowlists (no token/URLs/secrets); centre filter; access-log calls per TRD §5.1 table (P4) | HTTP contract; probes; role/aal tests; P3 within 10 s → 429; `front_desk` → P5 + P24b allowed, P24 → 403 (08 A19 P-43) | US-PG-07, 13 |
| PG-T13 | Reconciliation service + tasks + P12–P16 | `service/reconciliation.service.ts`, `tasks/reconcile_tenant.ts`, `tasks/reconcile_batch.ts` | PG-T08, PG-T11 | every finding kind of TRD §6.7 produced from sim scenarios; batches of ≤ 50 in their own jobs; `business_date` rule; stalled-run rule; P16 access log | integration per kind (incl. repair refused on `billing.payment_exceeds_due`, `refund_unconfirmed` at count 2); one-running constraint; 26 h metric; P-44 savepoint marker test | US-PG-08 |
| PG-T14 | Refund request/approve/reject + port `refund` (P6–P10) | `service/refund.service.ts` | PG-T08, CR-C15-002 (fake) | two-person rule; bounds; in-flight uniqueness; port key grammar (P-40) | integration; self-approval 403; aal1 403; row-audit rows for request/approve/reject (D-112) | US-PG-09 AC1–3, 6, 8 |
| PG-T15 | Refund confirm/check/execute/re-check/fail (P7b, P11, P11b, tasks) + `recordGatewayRefund` | `tasks/check_refund.ts`, `execute_refund.ts`, `khalti.adapter.ts#refundViaApi`, handlers `recheckPaymentRefund`, `failManualPaymentRefund` | PG-T14 | manual confirm path; api path behind flag (1 attempt, lookup first); `held_reason` codes; P7b min interval; P11b only after a no-refund check | sim: refund visible / not visible; api flag off → zero refund calls; P7b within 10 s → 429; P11b with gateway showing a refund → 409 and no write; P11b → `failed` frees the slot | US-PG-09 AC4, 5, 7, 9, 10 |
| PG-T16 | Static-QR worksheet P17–P19 | `service/staticqr.service.ts` | CR-C15-009 view | preview from view; difference/note rules | integration with seeded C4 view rows | US-PG-12 AC2–3 |
| PG-T17 | Merchant accounts + settings P20–P23, rewrap task | `service/merchant.service.ts`, `tasks/rewrap_credentials.ts` | PG-T03 | write-only secret; env guard; test outcomes (every outcome `200`); lazy settings row (P-22); `settings.change` access log with field names only | integration; log/audit scan for secret; rewrap after KEK change; rejected Khalti key → `200 auth_failed` | US-PG-10 |
| PG-T18 | Staff web: review queue + intent detail | `apps/web/src/app/(staff)/payments/{review,intents/[intent_id]}/…`, `features/payments/…` | PG-T12, CR-C15-007 | 04-UI-UX §2.1–2.2; help files | component tests; keyboard script; axe | US-PG-07 |
| PG-T19 | Staff web: refunds, reconciliation, static QR, settings | same feature folder | PG-T13–T17, CR-C15-011 | 04-UI-UX §2.3–2.6 | component tests; axe | US-PG-08–10, 12 |
| PG-T20 | Observability: metrics, alert rules handed to C1, manual pages | `docs/manual/payments/**`, metrics in services | all | TRD §11 list exists, incl. the 08 A22.4 gauges (`lims_payments_held_for_review_oldest_age_seconds`, `lims_payments_reconciliation_stalled_runs`) set by the sweep; `services/worker/src/jobs/payments/ops/payments.rules.yml` = §11 "Alert rules for C1" table; runbooks RB-1…RB-9 | metric presence test; TRD §12 row "Observability (08 A22.4)" | DoD §3.7–3.8 |
| PG-T21 | **eSewa UAT verification** (staging, UAT keys) | record in `docs/manual/payments/uat-esewa.md` | PG-T09 | confirmed or corrected: UAT form URL, success param name, failure params, status-check method, fractional amounts; spec CR if any differs | manual recorded checks + automated E2E against UAT | 01-PRD §9 items |
| PG-T22 | **Khalti sandbox verification** incl. refund API | `uat-khalti.md` | PG-T09, PG-T15 | initiate/lookup/return verified; refund API method/auth/amount unit verified or API mode stays disabled | E2E against `dev.khalti.com` | US-PG-02, 04, 09 AC7 |
| PG-T23 | Production enablement checklist | — | CR-C15-008 done (C1), PG-T21/T22 | RB-9 signed by founder; security sign-off (05-DoD §4) incl. the 07 §2 DECISIONs; 08 F-08 (04 P4 amendment, D-114) signed | — | — |
| PG-T24 | Consumer contract tests for all three callers (review #11) | `__tests__/contract/consumers.*` | PG-T08, PG-T09 | port suite green with the C4 staff caller, the C16 engagement-worker fake and the C6 reporting-worker fake (`createIntent`/`getIntent`, `returnUrl = <PORTAL>/r/payments/<id>/done`); redirect lands on that URL with `intent_id`, `outcome` | contract; portal/patient actor → `auth.forbidden` | US-PG-11, 11b |

## 2. Milestones

| M | Content | Exit |
|---|---|---|
| M1 | PG-T01–T07 | adapters pass all sim tests |
| M2 | PG-T08–T12, PG-T24 | port contract suite green on real impl for all three callers; C4 can switch its BL-T21 from fake to real in staging |
| M3 | PG-T13–T17 | reconciliation + refunds + config complete |
| M4 | PG-T18–T20 | screens + help + alerts |
| M5 | PG-T21–T23 | UAT verified; production per tenant |

## 3. Fakes → real

| Dependency | Fake until | Switch when |
|---|---|---|
| BillingPort (C4) | C4 chunk gate + CR-C15-002 merged | M2 (recordGatewayPayment), M3 (recordGatewayRefund) |
| FrontdeskPort (C4) | C4 chunk gate | M2 |
| IdentityPort (C2) | C2 chunk gate | M2 |
| Gateways | simulators | staging E2E in M5 only with UAT/sandbox keys (REQ-SEC-136) |
| Consumers of C15 (C4 BL-T21, C16, C6 portal worker) | they use the C0 fake | after M2 (C0 phase stub removed from `phase-stubs.ts` by PG-T01's paired PR, 08 A17 P-20) |

## 4. CR candidates (raised in 02-TRD) — CR-C15-001 … CR-C15-014 and CR-C15-016 (CR-C15-015 not raised, 08 A19 D-112); see `02-TRD.md` § "Change requests raised".

## 5. Risks

| # | Risk | Mitigation |
|---|---|---|
| R-1 | eSewa undocumented details (param name, method, decimals, UAT URL) differ in reality | everything decisive goes through the status check; PG-T21 before go-live; fractional amounts off |
| R-2 | Strict query validation 400s an eSewa redirect | polling settles anyway; fix spec after PG-T21 |
| R-3 | Late eSewa payment beyond the 7-day lookback | eSewa merchant statement manual check in RB-4; finding volume reviewed after first month |
| R-4 | Khalti refund API double refund on retry | 1 attempt, lookup before POST, disabled by default |
| R-5 | BillingPort under patient/portal actors fails RLS in C4 | Resolved by 08 R8: BillingPort and PaymentProviderPort are called only by staff/system actors (C16 from its worker); integration test in M2 that a patient/portal actor gets `auth.forbidden`; C6 portal payments also go through its worker as system actor (08 A11.1, PG-T24) |
| R-6 | Holding a DB transaction during gateway calls exhausts the pool | timeouts ≤ 2.5 s in-request; low volume (TRD §10); metric on tx duration |
| R-7 | KEK loss = all merchant secrets unusable | SOPS backups (C1); recovery = tenant admins re-enter secrets (no payment data lost) |
| R-8 | Callback token in URLs leaks via logs | C1 log masking (CR-C15-008), no-referrer, token grants no data |
| R-9 | Finance with a single person per lab blocks refunds (two-person default 0) | tenant threshold setting; documented trade-off |
| R-10 | Fonepay spec never arrives | static-QR worksheet stays; slot isolates future work |
