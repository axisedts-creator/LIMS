# C4 Front Desk & Billing — 06 IMPLEMENTATION PLAN

Status: DECISION draft, 2026-11-05. Two parallel tracks: **FD** (Agent FD, module `frontdesk`) and **BL** (Agent BL, module `billing`), joined only through `BillingCommandPort` [CR-C4-001], `BillingPort`, `FrontdeskPort` and their C0 fakes. One task ≈ one PR (02-CV §12). Every task: branch `c04/<topic>`, only C4 paths (TRD §1), DoD PR gate (05-DoD §1).

Prerequisites from C0 (block the first integration test, not the start of work): frontdesk/billing DDL + RLS from `05-SCHEMA.md`; `frontdesk.yaml`/`billing.yaml` from TRD §5; schemas of the 6 produced events; ports `FrontdeskPort`, `BillingPort`, `BillingCommandPort` + fakes; CR-C4-001/007/008 merged. Until then agents write domain code and unit tests (no DB/API dependency).

## 1. Track FD (frontdesk)

| ID | Goal | Files / paths | Depends on | Done when | Tests | Maps to |
|---|---|---|---|---|---|---|
| FD-T01 | Module skeletons + manifests | `services/api/src/modules/frontdesk/{index,permissions,config}.ts`, `handlers/index.ts` (the core fails boot unless every operationId has a handler, so not-yet-implemented handlers throw `common.service_unavailable` until their task merges; the nav entry stays hidden meanwhile), `services/worker/src/jobs/frontdesk/index.ts`, `apps/web/src/features/frontdesk/nav.manifest.ts` | C0 cores | core boots with module; CI path check green | boot test | — |
| FD-T02 | Pure domain | `domain/patient.ts` (NFC normalise, dedupe predicate, age→estimated DOB), `numbering.ts`, `order.state.ts`, `discount.ts` (limit eval, line/bill allocation, largest remainder), `discountApproval.state.ts`, `trf.state.ts` | — | 100 % of transitions + forbidden examples covered | unit: state tables, Devanagari normalisation cases, allocation golden (≥20 cases) | US-FD-02.1, 06.1, 07, 11.2–3 |
| FD-T03 | Repositories + RLS integration | `repository/*.repo.ts` (explicit `tenant_id` filters) | C0 DDL | queries pass on migrated PG 17 with tenant_a/b seeds | integration per repo; cross-tenant SELECT/INSERT probes | 07-SEC §6 |
| FD-T04 | Patients: F1–F6 | `handlers/{searchPatients,createPatient,getPatient,updatePatient,recordPatientConsent,listPatientOrders}.ts`, `service/patient.service.ts`, `mappers/patient.dto.ts` | FD-T02/T03 | all ACs below pass; access_log on search (`patient.search`) and update (`patient.update`, 08 A2.9) | contract (spec validation, each error code), integration (dedupe, consent append-only), probe | US-FD-01, US-FD-02 |
| FD-T05 | Quote F8 | `service/registration.service.ts#quote`, `handlers/quoteRegistration.ts` | FD-T03, fakes CatalogPort + BillingCommandPort | fingerprint stable; discount evaluation | contract; integration with CatalogPort fake price precedence fixtures | US-FD-05, 06, 14 (BL tax via fake) |
| FD-T06 | Registration F9 (atomic) | `service/registration.service.ts#create`, `events/publish.ts` | FD-T04/T05; fakes BillingCommandPort, NotificationPort, IdentityPort | one tx; event once; idempotent replay; stale-quote 409; rollback leaves nothing | integration: failure injection after `issueOrderInvoice` (fake records call, assert no rows); event payload validation; NotificationPort spy (params non-PHI) | US-FD-03, 04, 05, 08.1, 14 |
| FD-T07 | Discount approvals F15–F19 + expire cron | `service/discount.service.ts`, handlers, `services/worker/src/jobs/frontdesk/tasks/discount_approval_expire.ts`, `cron.ts` (`tenantScope: 'per_tenant'`, P-6) | FD-T06 | consumption bound to `base_fingerprint`/discounts/patient/centre; self-approval refused; aal1 refused | integration + IdentityPort fake aal1/aal2 | US-FD-07 |
| FD-T08 | Orders read F10/F11 + derived status | `service/order.service.ts` | FD-T03; LabPort fake (`getOrderItemProcessingState`) | in_progress/completed derived from `processingStatus` per 08 A13 D-5 (incl. rejected-without-recollection item → `cancelled`) | integration with LabPort fake states | 03-IC §10.4 (D-5) |
| FD-T09 | Items-change quote F8b + items change F13 + cancel F14 | `service/order.service.ts`, handlers `quoteOrderItemsChange`, `changeOrderItems`, `cancelOrder` | FD-T06/T08; LabPort fake | removal guard (`removable`); F13 fingerprint = F8b over `add`; cancel guard; events; billing port calls incl. task on a periodic invoice for already-invoiced credit charges; retry once on `billing.counter_busy`/40P01 | integration; event tests (`items_changed` never empty both; `cancelled` flag) | US-FD-10, 11; US-BL-10.5 |
| FD-T10 | TRF upload F20, metadata F21, content F21a + scan + purge | `service/trf.service.ts`, handlers, worker tasks `trf_scan.ts`, `trf_draft_purge.ts` | core `ctx.uploads`/`ctx.files.scan`/`ctx.storage` + streaming download helper (CR-C4-005 merged into CR-C2-011; bucket `frontdesk-trf`) or the C0 fake; C0 DEFINER `frontdesk.purge_trf_drafts` | EICAR → quarantined; 16 MB → 413; html → 415; EXIF GPS stripped; content only when clean (`422 common.upload_quarantined`); no response contains a Storage URL; `trf.view` per content call; drafts purged via the DEFINER | integration with fake scanner; header assertions on F21a (`attachment`, `nosniff`, `no-store`); response scan for `signedUrl`-shaped strings | US-FD-09 |
| FD-T11 | `FrontdeskPort` impl + contract | `ports/FrontdeskPort.impl.ts`, `service/booking.service.ts`, `__tests__/contract/FrontdeskPort.contract.test.ts` | FD-T06/T08 | all 10 contract cases (03-IC §4.3) + 08 cases 11–18 + C4 cases 19–20 (callers C14 and C15, 08 A19 D-110 — TRD §6.1; the C0 FrontdeskPort fake follows the same cases) pass (self-registered patient: `source = self_service`, no centre, consent source `self_service`; booking defaults per TRD §6.1); purpose allowlist table incl. `result_evaluation`, `lab_display`, `patient_app_link` (TRD §6.1); `getPatientDemographicsBatch`, `createSelfRegisteredPatient`; per-source authorisation of `createOrderFromBooking` (08 R7) | contract | US-FD-12.5 |
| FD-T12 | Consumers + flags + confirm F12, F22, F23 | `services/worker/src/jobs/frontdesk/consumers/{lab.specimen.rejected.v1,lab.specimen.status_changed.v1,catalog.changed.v1,engagement.booking.confirmed.v1,engagement.booking.cancelled.v1}.ts`, `service/flags.service.ts` | FD-T11 | duplicate delivery no-op; stale seq ignored; cancel-before-confirm (cancel reason `booking_cancelled`); `home_collection` confirmation → no order; home-collection cancel with linked registered order → flag (08 R7); `status_changed` `recollection_ordered` + `rejected` for one specimen → one flag (08 A13 D-6); recollection SMS params `lab_name`, `centre_phone` | consumer tests incl. 03-IC examples + unknown fields | US-FD-12, 13 |
| FD-T13 | Registration page | `apps/web/src/app/(staff)/frontdesk/registrations/new/{page,loading,error}.tsx`, `features/frontdesk/{components,forms,hooks,server}/…` | FD-T05/T06 API in Prism; CR-C4-013 components | keyboard script (04-UI-UX §3.7) passes; all states; label flow per 08 A13 D-4 (readiness call → open `staff.lab.order_labels`); credit badge from `Quote.credit_status` | UI tests with MSW (C3 search, C5 label op mocked); a11y checks | US-FD-03.6, 15; 04-UI-UX §3 |
| FD-T14 | Order, patient, worklist (incl. F26 possible duplicates), approvals pages | `app/(staff)/frontdesk/{orders/[order_id],patients/[patient_id],worklist,discount-approvals}/…` | FD-T09/T12 | all states (03-APP-FLOW §4) | UI tests | US-FD-07, 10, 11, 13 |
| FD-T15 | Settings F24, codes F25, anonymise F7, possible duplicates F26 | handlers + `service/settings.service.ts`, `patient.service.ts#anonymise`, `patient.service.ts#possibleDuplicates` | CR-C4-008 | settings If-Match; anonymise rules incl. TRF object deletion (P-12 c); `audit_log` holds no demographic value (excluded columns, D-27 a); access_log `patient.anonymise`/`patient.update` with `changed_fields`; F26 returns only same-tenant candidates | integration; privileged aal2 test; audit-row content test | US-FD-16 |
| FD-T16 | Probes + security tests | `__tests__/probes/*`, security cases of 07-SECURITY §6 | all FD | every operation/table covered | probes | 07-SEC |
| FD-T17 | Help + manual | `features/frontdesk/help/*.md`, `docs/manual/frontdesk/*.md` | FD-T13/14 | every screen has help; copy scan passes | copy-scan CI | 04 L26 ढ |
| FD-T18 | Performance | `__tests__/integration/perf.registration.test.ts` | FD-T06 | p95 targets (TRD §14) at 1× and 10× seeds | load script (seed generator) | PRD §9 |

## 2. Track BL (billing)

| ID | Goal | Files / paths | Depends on | Done when | Tests | Maps to |
|---|---|---|---|---|---|---|
| BL-T01 | Module skeletons | `services/api/src/modules/billing/{index,permissions,config}.ts`, worker `jobs/billing/index.ts`, web `features/billing/nav.manifest.ts` | C0 cores | boots | boot | — |
| BL-T02 | Pure domain | `domain/money/tax.ts`, `domain/fiscalYear.ts`, `numberFormat.ts`, `invoice.state.ts`, `cashSession.state.ts`, `creditCharge.state.ts`, `cbms.state.ts`, `export.state.ts`, credit-note component split | `@lims/shared-ts/{money,bsdate}` | golden tables pass | unit: ≥50 tax cases; FY golden incl. 2025-07-16/17 NPT boundary (01 §4.8) and shared B.S. table; split rounding | US-BL-14, 01.3 |
| BL-T03 | Repositories + trigger/immutability tests | `repository/*.repo.ts` | C0 DDL | direct UPDATE/DELETE as `lims_app` fail as specified | integration (05-SCHEMA §9) | US-BL-02 |
| BL-T04 | Counter service (gapless) | `service/counter.service.ts` | BL-T03 | 200 concurrent allocations → 1..200; FY change during allocation → `billing.counter_busy` detail `fiscal_year_rollover` (D-25); lock timeout → `billing.counter_busy`; `lock_timeout` reset after the counter UPDATE; series scope branch; pattern without `{branch}` under branch scope → `billing.numbering_pattern_invalid` (D-23) | integration concurrency test (200 parallel tx), injected clock at Shrawan 1 | US-BL-01 |
| BL-T05 | Quote engine + settings (B32, B34; B33 removed — tax rates are C3's, 08 R18) | `service/quote.service.ts`, `service/settings.service.ts` (lazy defaults), handlers | BL-T02/T03, CR-C4-008; CatalogPort fake returning tax rates | rates taken from each line's `PriceQuote.tax` and snapshotted on invoice lines (exempt lines: `vat_rate_bp` NULL); `catalog.tax_config_missing` propagated unchanged when a rate is absent; `baseFingerprint`; B32 refuses branch scope without `{branch}` | unit + contract | US-BL-14, US-BL-01.5 |
| BL-T06 | Invoice issue + balance + events; reads B1 `listInvoices`, B2 `getInvoice` (+ `cbms_submissions[]`), B7 `getOrderBilling`, B37 `listInvoicePrints` | `service/invoice.service.ts#issue`, `service/balance.service.ts`, `events/publish.ts`, activity writes, CBMS job enqueue, handlers for B1/B2/B7/B37 | BL-T04/T05 | issued/balance events at exact triggers; balance_version strictly increasing; one balance event per balance change | event payload tests; integration | US-BL-01, 13.1, US-FD-03.1 |
| BL-T07 | `BillingCommandPort` impl + contract | `ports/BillingCommandPort.impl.ts` | BL-T06, BL-T08 (payments), CR-C4-001 | 11 contract cases (TRD §6.3) pass on real impl | contract | US-FD-03/04 (via FD) |
| BL-T08 | Ledger: payments, sessions, receipts (B8, B17); reads B11 `listLedgerEntries`, B16 `listDues`, B18 `getDailyCash` | `service/ledger.service.ts`, `service/cash.service.ts`, handlers for B11/B16/B18 | BL-T06 | overpay refused (manual), recorded (home); RC numbering from `TenantSettings.numbering.receiptNoPattern`; one open session; B22/home payments have no session | integration; REQ-SEC-056 reference check | US-FD-08, US-BL-11.2–3 |
| BL-T09 | Print (B3, B6 print) | `service/invoice.service.ts#print`, `printLog.repo.ts` | BL-T06 | original/copy marks; concurrent prints distinct numbers; access_log `invoice.print` / `credit_note.print` (08 A2.9) | integration (parallel prints) | US-BL-03 |
| BL-T10 | Cancel + partial credit + tasks (B4, B5, B35) | `invoice.service.ts#cancel/#credit`, `creditNoteTasks.repo.ts` | BL-T04/T06 | credit note gapless series; tasks resolve; `cbms_cancel_state` set at cancel; events | integration + event tests | US-BL-04, 05 |
| BL-T11 | Reversal, two-person refund, review items (B9, B10, B10a, B10b, B10c, B36) | `ledger.service.ts`, `service/refund.service.ts`, `repository/refundRequests.repo.ts` | BL-T08; `billing.refund.request` + `billing.refund_self_approval_forbidden` registered (D-24) | single reversal copying the original's capture fields/collector (TRD §6.5); refundable cap at request and approval; approver ≠ requester; refund ledger row only on approval; privileged/aal2 | integration; role tests; two-person tests | US-BL-06, 09.2 |
| BL-T12 | `BillingPort` impl + overrides (B14, B15) + contract | `ports/BillingPort.impl.ts`, `service/release.service.ts` | BL-T08; FrontdeskPort fake | 10 contract cases (03-IC §4.4) + 08 cases 11–14 pass (`recordGatewayRefund`, `allowExceedsDue`, patient/portal → `auth.forbidden`); gateway rows have no collector | contract | US-BL-07, 08 |
| BL-T13 | Credit parties (B19–B23) + `credit_days_check` | `service/credit.service.ts`, worker task | BL-T06; CatalogPort fake (`getCreditParty`, CR-C4-002) | monthly bill with request `branch_id`; `invoice.issued` payload without `order_id`/`centre_id` validates (D-1); account upsert on first charge; `allowsCredit`/inactive → locked; lock job; statement | integration; event schema test | US-FD-04, US-BL-10 |
| BL-T14 | CBMS stub + jobs + screens API (B30, B31) | `cbms/*`, `service/cbms.service.ts`, worker `cbms_sync.ts`, `cbms_sweep.ts` | BL-T06/T10 | stub never marks synced; retry/sweep for all three document kinds (`invoice_cancellation` on `cbms_cancel_*`); alert rules | integration with a test client returning each outcome | US-BL-13 |
| BL-T15 | Registers + audit trail + exports XML/PDF (B24–B29, B29a) | `service/register.service.ts`, `service/export.service.ts`, worker `export_render.ts`, `export_purge.ts` | BL-T10; RenderPort fake (CR-C4-004: bytes returned, stored by C4 in `billing-exports`, worker system actor); core streaming download helper | columns per TRD (B26 `CreditNoteRegisterRow` with `net`, published for C8 R1); range limit (PDF ≤ 5,000 rows); content only via B29a (no URL in any response); access_log at create and every download; privileged | integration; XML validated against `urn:lims:billing:export:v1` XSD kept in `docs/manual/billing/exports.md` | US-BL-12 |
| BL-T16 | Consumers `payments.intent.settled.v1`, `homecollection.collection.synced.v1` | `services/worker/src/jobs/billing/consumers/*.ts` | BL-T12/T08 | idempotent; overpayment review item; tenant-inactive payment method → payment recorded + review item `home_payment_method_inactive`, never a dead letter (08 A19 D-128); optional `booking_id` tolerated (D-120) | consumer tests (examples, duplicates, unknown fields, inactive method, payload with and without `booking_id`) | US-BL-08, 09 |
| BL-T17 | `fiscal_counter_prepare`, `integrity_check` jobs | worker tasks + `cron.ts` | BL-T04 | nightly check detects planted gap (test inserts as owner) | integration | US-BL-01, PRD §9 |
| BL-T18 | Per-tenant export/restore | worker `export_tenant.ts`, `__tests__/integration/tenant-export-restore.test.ts`, runbook `docs/manual/billing/tenant-export.md` | BL-T03 | checksums match; zero foreign rows; gapless continuation | integration | US-BL-15 |
| BL-T19 | XLSX export | `write-excel-file` 4.1.1 (repo pin, 08 R12e; added by C0-0D) + `neutraliseFormula` from `@lims/shared-ts/spreadsheet` on every text cell (P-9); remove the `common.feature_disabled` branch for `xlsx` | BL-T15; C0-0A spreadsheet helper | xlsx outputs pass column tests; formula-injection test (`=`, `+`, `-`, `@`, tab, CR prefixes are neutralised) | integration | US-BL-12.1, 12.6 |
| BL-T20 | Billing web screens | `apps/web/src/app/(staff)/billing/**`, `features/billing/**` (print templates in `features/billing/components/print/`) | BL-T09–T15 APIs in Prism; CR-C4-013 | all states; copy scan; dual dates on fiscal docs | UI tests (MSW) | 04-UI-UX §8 |
| BL-T21 | Pay by QR (B12, B13) — Phase 1.5 | handlers + `payment_intent_refs`, `config.ts` (`LIMS_FRONTDESK_PAYMENT_RESULT_URL`), QR dialog in `features/billing/` | C15 fake; flag; C15 P5/P24b in Prism | flag off → `common.feature_disabled`; one open intent; `returnUrl = cancelUrl = LIMS_FRONTDESK_PAYMENT_RESULT_URL`; `x-error-codes` incl. `payments.amount_not_supported`, `payments.return_url_not_allowed`; dialog: QR of `launchUrl` + "Open on this PC", no form post, "Cancel payment" via C15 P5 + P24b (08 A19 D-113, CR-C15-016) | integration with PaymentProviderPort fake; HTTP contract cases for the two codes; dialog component test (QR of `launchUrl`, no form post) | S24, US-BL-08.4 |
| BL-T22 | Probes + security tests + alert rule files | `__tests__/probes/*`, `services/worker/src/jobs/billing/alerts/*.yaml`, `services/worker/src/jobs/frontdesk/alerts/*.yaml` (TRD §15, P-14) | all BL | 07-SECURITY §6 complete; alert rules listed in TRD §15 handed to C1 by one CR | probes | 07-SEC |
| BL-T23 | Help + manual | `features/billing/help/*.md`, `docs/manual/billing/*.md` | BL-T20 | every screen; IRD behaviour explained neutrally | copy scan | 04 L26 ढ |
| BL-T24 | Performance | perf tests for eligibility, payment, registers | BL-T12/T15 | TRD §14 targets | load | PRD §9 |

## 3. Joint tasks

| ID | Goal | Depends on | Done when |
|---|---|---|---|
| J-T01 | Swap `BillingCommandPort` fake → real in FD integration tests (remove `BillingCommandPort` from `LIMS_CORE_FAKE_PORTS` in C4 test config) | FD-T06, BL-T07 | FD integration suite green against real billing; registration rollback test proves counter rollback (US-FD-03.5) |
| J-T02 | E2E journeys (nightly): walk-in cash; credit party month bill; part payment + dues + C6 release check (C6 fake); cancel order → credit note → refund; booking → confirm; registers export | J-T01 | 05-DoD §5.2 C4 scenarios green on compose stack |
| J-T03 | CI text scan "IRD approved…/commission" over C4 web/help/templates/messages | FD-T17, BL-T23 | job required |

## 4. Milestones

| Milestone | Contents | Exit |
|---|---|---|
| M1 Domain | FD-T01/T02, BL-T01/T02 | unit golden tables green (no DB) |
| M2 Core money path | FD-T03–T06, BL-T03–T08, J-T01 | walk-in cash registration end-to-end against real billing; gapless + immutability tests green |
| M3 Corrections & authority | FD-T07, T09, T11, BL-T09–T12 | cancel/credit/refund/print/eligibility; both port contract suites green |
| M4 Credit, registers, CBMS, consumers | FD-T10, T12, T15, BL-T13–T18 | registers/exports, CBMS stub, export/restore |
| M5 UI, security, perf, docs | FD-T13/14/16–18, BL-T19/20/22–24, J-T02/T03 | chunk gate (05-DoD §3); billing marked **not certifiable** until B6 documents (05-DoD §5.4) |
| M6 (Phase 1.5) | BL-T21 | C15 merged |

## 5. Fake → real swap schedule

| Dependency | Fake until | Swap trigger | Re-run |
|---|---|---|---|
| `BillingCommandPort` (FD side) | BL-T07 | J-T01 | FD integration |
| `FrontdeskPort` (BL side) | FD-T11 | FD chunk task merged | BL eligibility + consumers |
| `CatalogPort` | C3 chunk gate | C3 merged + CR-C4-002 | quote/registration integration, price precedence |
| `IdentityPort` | C2 chunk gate | C2 merged (+ CR-C4-009) | authz + aal2 tests |
| `NotificationPort` | C6 | C6 merged + CR-C4-011 templates | SMS tests |
| `LabPort` (`getOrderResults`, `getOrderItemProcessingState`) | C5 | C5 merged | cancel/removal guards; derived status |
| C5 label-print HTTP | C5 + CR-C4-010 | merged | UI label flow (MSW → Prism → staging) |
| `RenderPort` | CR-C4-004 + C6 | merged | PDF exports |
| Upload helper / scanner | CR-C4-005 + C1 | merged | TRF tests incl. EICAR through real scanner |
| `PaymentProviderPort` | C15 (Phase 1.5) | merged | BL-T21, US-BL-08 |
| `engagement.*` / `homecollection.*` producers | C16/C17 (Phase 3) | merged | consumer tests with real producers |
| `CbmsClient` stub | B6 answered | LiveCbmsClient implemented by C4 | CBMS golden mapping tests |

## 6. CR candidates foreseen (not yet raised)

| Candidate | Why | When |
|---|---|---|
| `frontdesk.patient.merged.v1` event + merge endpoint | patient merge (permission exists) needs C5 previous-results/trend to follow merged ids | after Phase 1 duplicate data shows need |
| Batched `CatalogPort.priceFor` | registration p95 budget spends ~200 ms on 10 sequential calls | if FD-T18 misses target |
| `NotificationPurpose` `payment_receipt` | optional SMS receipt for part payments | client request only |
| Separate audit-log store export of `billing.activity_log` | REQ-SEC-097 "shipped to a separate store" | with C1 log shipping |
| IRD-specific XML/CBMS mapping | B6 | when IRD documents arrive |
| HS-code per orderable in CatalogPort | 04 L10 if the auditor says it applies | B7 answer |

## 7. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| IRD requirements differ from 04 L26 when B6 documents arrive | rework of formats/fields | data-driven templates; CBMS behind interface; no claims of approval; 05-DoD §5.4 "not certifiable" flag |
| "Stored separately" (B17) requires per-tenant schema/DB | migration effort | no FK into/out of billing to frontdesk; tenant-leading keys; export/restore tested (BL-T18) |
| VAT/HST treatment (B7) changes totals | invoice math | tax as data per line; golden tests; `prices_include_tax` switch; HST never seeded |
| Counter contention under bursts | 503s at peak | lock window ≤50 ms, timeout 3 s, auto-retry once; metrics + alert |
| Two agents diverge on the internal port | integration break | CR-C4-001 fixes the TS signature; shared contract suite; J-T01 early in M2 |
| Duplicate patients from concurrent creation | broken history | dedupe at create + daily "possible duplicates" list; merge CR later |
| Discount approval latency annoys front desk | slower registration | self-limit setting; inbox polling 10 s; operators can continue other registrations |
| TRF scanner unavailable | uploads stuck in pending | registration does not wait for scan; `failed` state + re-upload; alert |
| CBMS outage / spec delay | sync backlog | queue + sweep; invoicing never blocked |
| Staff-web drafts lost on reload | re-typing | by design (no PHI in browser storage); quick re-entry with keyboard |
| `btree_gin`/`pg_trgm` absent in image | slow name search | C0 check in first task; fallback index documented |

08 Addendum A2/A3 applied 2026-11-06 (A2.9 access-log codes `patient.update`, `patient.anonymise`, `credit_note.print`, `receipt.print`; A2.12 cancelled home-collection booking → `frontdesk.order_flags`, no `finance_review_items` kind).
08 Addendum A4 applied 2026-11-06 (A4.5 `receipt.print` registered, unused in v1 — no server-side receipt endpoint in C4; no task change).
Review fix pass 2026-11-06 — review/C4-frontdesk-billing.md + 08 Addendum A13 applied (task changes above: FD-T08–T15, BL-T04–T06, BL-T08, BL-T10–T11, BL-T13–T15, BL-T19, BL-T22; stale CR-candidate row for `recordGatewayRefund` removed — CR-C15-002 is accepted).
Final sweep 2026-11-06 — second touch applied (FD-T11 cases 19–20; BL-T15 B26 row shape; BL-T16 D-128 / D-120; BL-T21 CR-C15-016 / D-113).
