# C4 Front Desk & Billing — 07 SECURITY

Status: DECISION draft, 2026-11-05. Phase applicability per 04 §12: REQ-SEC §1, §3, §4, §6, §7 and REQ-SEC-057 from Phase 1; §2 gateway requirements from Phase 1.5–2 (S24, BL-T21). IDs are cited, not copied (02-CV §10).

## 1. Applicable requirements and how C4 meets them

| REQ | Application in C4 |
|---|---|
| REQ-SEC-001/002 | ASVS L2 target; BOLA is the primary threat: every handler loads the object through RLS-scoped repos before `assertRole` with its `centre_id` |
| REQ-SEC-004 | column PHI classes in `05-SCHEMA.md` are the C4 part of the data inventory |
| REQ-SEC-005 | consent captured at registration with text version; append-only `patient_consents`; registration without processing consent blocked (`frontdesk.consent_required`) |
| REQ-SEC-006 | C4 never discloses results; demographics through `FrontdeskPort` purpose allowlists only |
| REQ-SEC-007 | TRF images/PDFs stored only in Nepal-hosted Storage; SMS bodies non-PHI (CR-C4-011 params) |
| REQ-SEC-011–016 | ENABLE+FORCE RLS on every C4 table, per-command policies to `lims_app`, default deny, no DELETE policies (05 §2) |
| REQ-SEC-017 | centre scoping (TC/TCN templates) on orders, items, discounts, approvals, TRFs, invoices, ledger, sessions, balances, refund requests |
| REQ-SEC-022/023/024 | `(SELECT app.…)` wrappers; `tenant_id` leading in every index; explicit tenant filter in every repo query |
| REQ-SEC-026/027/028 | composite FKs; `tenant_id` no default; UUIDv7 ids only in URLs; human numbers never in paths |
| REQ-SEC-031 | all ten `v_pub_*` views `security_invoker = true` |
| REQ-SEC-034/035 | private buckets `frontdesk-trf`, `billing-exports` (08 R26; module-prefixed, the adapter refuses writes from other modules), first path segment = tenant_id (CHECK + storage policy); files reach browsers only by streaming through F21a / B29a (core download helper via the BFF); `ctx.storage.signedUrl` stays internal and never appears in a response, header or log (08 A13 P-2; 03-IC §13.6) |
| REQ-SEC-039/131 | no BYPASSRLS role on any C4 path; no `service_role` use |
| REQ-SEC-040/041/042/044 | probes §6; two synthetic tenants; negative RLS tests requested in `db/tests` (05 §9); id-swap / body-vs-path / mixed bulk ids |
| REQ-SEC-045/133 | alert rules (TRD §15, handed to C1 per P-14): exports per user (access_log `data.export`), refunds per day, quarantine bursts, patient-search volume per user = DB rule over `audit.access_log` (`action = 'patient.search'` per `actor_id` per hour > 300 [CONV]; no user label on metrics, 02-CV §9.4) |
| REQ-SEC-046 | prices/amount due computed server-side via CatalogPort + quote fingerprint; client never sends prices; gateway amount only from C15 |
| REQ-SEC-047/048 | (Phase 1.5) C15 verifies; C4 compares amount with `payment_intent_refs` (`billing.amount_mismatch`) |
| REQ-SEC-050/051 | Idempotency-Key required on all money/state POSTs (TRD §5); unique `(tenant, gateway, gateway_txn_ref)`; ledger idempotency keys for C17/C15 paths |
| REQ-SEC-053 | one open intent per order is C15's index; C4 surfaces `payments.intent_open_exists` |
| REQ-SEC-055 | two-person refunds (08 R15 binding; 08 A13 D-24): `requestRefund` needs `billing.refund.request`, `approveRefund` needs `billing.refund.approve` held by a **different** person (`403 billing.refund_self_approval_forbidden`; DB CHECK `refund_requests__two_person__ck`); both privileged ⇒ aal2; amount ≤ refundable at request and approval; the ledger row is written only on approval; audited; idempotent. Gateway refunds use C15's own two-person flow |
| REQ-SEC-056 | ledger `reference_text` refuses 13–19-digit runs (no card numbers); gateway refs only |
| REQ-SEC-057 | ledger append-only: no UPDATE/DELETE grants; reversals are new rows; unique single reversal |
| REQ-SEC-059 | "Payment received" in QR dialog driven only by server balance |
| REQ-SEC-062/067 | privileged C4 permissions (discount approve, invoice cancel, reverse, refund, credit-party manage, export, release override, settings, anonymise) re-validate membership and require aal2 |
| REQ-SEC-068/091/092 | browser talks only to BFF; state changes POST/PUT/PATCH; Origin checks by C0 BFF core |
| REQ-SEC-073 | reception PCs: idle timeout (C2) — C4 keeps no PHI in browser storage so a timed-out session leaves nothing behind |
| REQ-SEC-080/081/082 | strict spec validation, `additionalProperties:false`; role-based mappers; parameterised SQL; trigram search input escaped |
| REQ-SEC-083/084/085 | TRF: allowlist + magic bytes + 15 MB + random names + image re-encode with EXIF/GPS stripping (`ctx.uploads.accept` `images:{reencode, stripMetadata}`, 08 R12b) + scan/quarantine + qpdf sanitise; served only by F21a with `Content-Disposition: attachment`, `nosniff`, `no-store`, never inline on an app origin (P-2) |
| REQ-SEC-086/087 | PDFs via C6 renderer (bundled assets); TRF PDFs only through sandboxed qpdf, never Chromium |
| REQ-SEC-088/089 | React text nodes only; print templates render text, no `dangerouslySetInnerHTML` |
| REQ-SEC-093 | not applicable (C6) |
| REQ-SEC-095 | problem+json without PHI; duplicate-candidate payload only for callers with `frontdesk.registration.create` |
| REQ-SEC-096/097 | audit trigger on all mutable C4 tables (`frontdesk.patients` with the demographic columns excluded — 08 A13 D-27 a; demographic changes logged as access_log `patient.update` with `changed_fields`); `access_log` per TRD §5 table (search, patient view, consent change, TRF download, invoice/credit-note print, export create/download); FrontdeskPort itself writes none (03-IC §4.3 invariant); `billing.activity_log` append-only (separate-store shipping = CR candidate) |
| REQ-SEC-098 | no PHI in URLs (search is POST), logs, metrics labels, page titles, browser storage |
| REQ-SEC-099 | every operation in `frontdesk.yaml`/`billing.yaml` has owner + `x-permission`; no `x-public` operations in C4 |
| REQ-SEC-100 | export and bulk operations privileged; approval inbox rate via general tier; per-user export alert |
| REQ-SEC-128/129 | no secrets in C4 code; any new dependency (XLSX writer) via lockfile + audit |
| REQ-SEC-136 | non-prod: CBMS stub, NotificationPort fake/no real provider, synthetic fixtures only |
| REQ-SEC-139 | anonymisation workflow F7 with retention floor (B15); no demographic copy left in `audit.audit_log` (excluded columns, D-27 a); TRF objects deleted (P-12 c, D-27 b) |
| REQ-SEC-141 | touchpoints used: SMS gateway via C6 (cross-border flag), payment gateways via C15; C4 adds none |

## 2. Assets

| Asset | Classification | Where |
|---|---|---|
| Patient demographics, consents | P2 personal | `frontdesk.patients`, `patient_consents` |
| Ordered tests linked to patient | P3 health | `order_items`, `invoice_lines`, `credit_charges` |
| TRF files | P3 (clinical request content) | Storage `frontdesk-trf` |
| Fiscal documents (invoices, credit notes), counters | financial + legal (04 L5) | `billing.*` |
| Ledger, refunds | financial | `billing.ledger_entries` |
| Discount approvals | financial control | `frontdesk.discount_approvals` |
| Exports (registers, audit trail) | bulk financial + P2 (buyer names) | Storage `billing-exports` |
| Release eligibility (gate for report release) | integrity of C6's PHI release | `BillingPort` |

## 3. Threat model (STRIDE per entry point)

| Entry point / asset | S | T | R | I | D | E |
|---|---|---|---|---|---|---|
| F1 patient search | stolen session at reception → mitigated by BFF cookie + idle timeout (C2) | — | access_log per search | enumeration of patients by broad queries → min chars, 20 cap, per-user alert; tenant-wide scope is a deliberate trade-off (PRD D-PATIENT-SCOPE) reviewed here | trigram heavy queries → general rate tier, index | centre_staff reading other-centre patients: accepted (patients tenant-scoped); their **orders** stay centre-scoped |
| F9 registration | — | price tampering → server re-quote + fingerprint; discount tampering → approval binding | audit + activity | duplicate candidates leak other patients' summaries → only to `frontdesk.registration.create` holders, masked phone | burst submissions → idempotency + rate tier | cash invoice by role lacking `billing.invoice.issue` → second assert |
| Discount approval F15–F19 | approver impersonation → own session at aal2 | modify request after approval → fingerprint/patient/centre/discount JSON binding | decided_by + audit | — | inbox flooding → per-user rate | self-approval → DB CHECK + `frontdesk.discount_self_approval_forbidden` |
| F20 TRF upload | — | polyglot/malware → sniff + scan + quarantine + sanitise; EXIF/GPS leak → re-encode + strip | uploader recorded; `trf.view` per download | serving on app origin / leaked Storage URL → streamed by F21a only, attachment, no URL ever issued | zip-bomb/large → 15 MB cap, stream limit | path traversal → server-generated paths, tenant CHECK |
| Invoices B3–B5 | — | edit/delete → no API, DB trigger + no DELETE grant; print count reset → guard (+1 only) | print_log, activity, CBMS log | invoices of other centres → TCN RLS | counter lock DoS → timeout, alert | cancel by front desk → privileged permission + aal2 |
| Counter | — | number skipping/reuse → guard `last_no = old+1`; chronology trigger | integrity_check nightly | — | lock hogging → statements after allocation bounded | — |
| Ledger B8–B10a | — | amount edits → append-only; double reversal → unique index | collected_by, approved_by, refund request requester/decider | card numbers in reference → regex refusal | — | refund by cashier → privileged; single-person refund → second approver required (D-24) |
| BillingPort (C6, C15) | forged gateway payment → only C15 (system or staff context) calls `recordGatewayPayment`/`recordGatewayRefund`; every BillingPort method refuses `patient`/`portal`/`partner` actors (`auth.forbidden`, 08 R8); port not reachable over HTTP; gateway rows carry no collector (CHECK) | amount mismatch → refs check + C15 exact match | ledger row | eligibility for other tenant → `not_found` | — | override by non-finance → privileged |
| Exports B28/B29/B29a | — | XLSX formula injection → `neutraliseFormula` on every text cell (P-9) | access_log at create and every download + activity | bulk exfiltration → privileged + aal2, row cap (PDF 5,000), no shareable URL (streamed via B29a only), per-user alert | large exports → async job, cap | — |
| Event consumers | spoofed events → only C0 outbox fan-out enqueues `evt.*` tasks; payload validated | replay → inbox dedupe | inbox rows | — | poison event → dead letter (C0) | — |
| CBMS stub/live | (future) endpoint spoofing → TLS + spec (B6) | — | cbms_submissions | sends only fiscal fields (no test names) | outage → queue | — |

## 4. Abuse cases (each has a test)

| # | Abuse | Expected outcome |
|---|---|---|
| A1 | Cashier edits request JSON to lower `unit_price` | field not in spec → `400 common.validation_failed` (`common.unknown_field`) |
| A2 | Cashier applies 90 % discount, reuses an old approval id from another patient | `403 frontdesk.discount_approval_required` |
| A3 | Cashier cancels then re-registers to skip an invoice number | numbers are gapless and immutable; cancellation needs finance; both invoices visible in cancelled register |
| A4 | Insider runs `UPDATE billing.invoices SET net_paisa = 0` with app credentials | `immutable_row` exception; no row changed |
| A5 | Insider deletes a ledger row | permission denied (no DELETE grant) |
| A6 | Reprint to produce a second "original" | `print_no ≥ 2` always carries copy mark |
| A7 | Refund to self by front desk | `403 auth.forbidden`; by finance at aal1 → `403 auth.mfa_required`; finance approving own refund request → `403 billing.refund_self_approval_forbidden` |
| A8 | Repeated small refunds | daily refund alert; refundable cap prevents over-refund |
| A9 | Upload HTML disguised as `.jpg` | `415 common.unsupported_media_type` |
| A10 | Upload EICAR | `quarantined`; F21a → `422 common.upload_quarantined` |
| A20 | Copy a download link of a TRF or export to another machine | no link exists: content only through the authenticated BFF stream (F21a/B29a) |
| A21 | Buyer name `=HYPERLINK(...)` in a register export | XLSX cell neutralised (`'=` prefix) |
| A11 | Tenant A user requests tenant B invoice/order/patient ids (path, query `order_id`, body `trf_attachment_ids`, credit party ids) | `404 common.not_found`, no side effects |
| A12 | Centre A1 user opens A2 order / invoice / ledger | `404 common.not_found` |
| A13 | Centre user lists periodic credit invoices (NULL centre) | rows invisible (TCN) |
| A14 | Gateway callback replay (Phase 1.5) | one ledger row (`duplicate: true`) |
| A15 | Mass patient search scraping | min chars + cap + alert; probe that wildcard-only queries are refused |
| A16 | Exports at night by finance account | alert on volume; access_log trail |
| A17 | Client sends `tenant_id`/`created_by`/`status` fields | rejected as unknown fields |
| A18 | Typing a full card number into payment reference | `400 common.validation_failed` |
| A19 | Event with a forged `tenant_id` | worker sets context from envelope written by producer tx under RLS (02-CV §6); consumer probe: event for tenant B processed only in B's context, A untouched |

## 5. PHI handling and logging rules (C4-specific)

1. Logs (02-CV §9.2): allowed ids `patient_id`, `order_id`, `invoice_id`, `ledger_entry_id`, `invoice_no`, `credit_note_no`; **never** patient name, phone, email, address, DOB, registration no, patient code, TRF filename, test names/codes linked to an order, payment references, buyer PAN, discount reason text, cancel reason text.
2. Error responses: `detail` never echoes field values; duplicate candidates only in the structured problem extension for authorised callers.
3. Metrics labels: `tenant_id` only on low-cardinality metrics; never patient/order ids.
4. Browser: no PHI in `localStorage`/`sessionStorage`/IndexedDB/URL/page titles; print iframes are removed after printing.
5. Events: payloads per 03-IC (no names/phones/registration no); NotificationPort params non-PHI.
6. `billing.activity_log.details`: whitelisted keys only (`reason_code`, `amount_paisa`, `method_code`, `print_no`, `format`, `kind`, `row_count`, `state`) — enforced by a typed builder + unit test.
7. CBMS documents contain only fiscal fields (buyer name/PAN as required on the invoice; no test names).
8. `access_log` actions emitted by C4 (two-segment codes, 08 R20/§4.4; calls `ctx.audit.access({action, entityType, entityId?, centreId?, purpose?, outcome, detail?})`; operation → action → entityType table in TRD §5, 08 A13 P-3): `patient.search` (F1, F26), `patient.view` (F3), `consent.change` (F5), `trf.view` (F21a, every download), `invoice.print` (B3), `data.export` (B28 create and every B29a download, entityType `billing_export`), and — accepted into the seed by 08 Addendum A2.9 (03-IC §13.1) — `patient.update` (F4), `patient.anonymise` (F7), `credit_note.print` (B6 print), and `receipt.print` — **registered, unused in v1** (08 Addendum A4.5: C4 has no server-side receipt render/print endpoint; receipts are rendered client-side in `PrintFrame`; no endpoint is added for logging only).

## 6. Required security tests

### 6.1 Cross-tenant probes (every operation — 02-CV §11.3)
For **each** of F1–F26 (incl. F8b, F21a) and B1–B37 (incl. B10a–B10c, B29a): authenticate as tenant_a user with the operation's permission; call with tenant_b ids in path / query / body (incl. arrays mixing a and b ids: `trf_attachment_ids`, `lines[].invoice_line_id`, `resolves_task_ids`, `items[].orderable_id` of a b-only catalog item) → `404 common.not_found` (or validation for catalog ids), no b data, DB check as owner shows zero b changes. List endpoints (F6, F10, F16, F22, F26, B1, B6, B10c, B11, B16, B20, B24–B27, B30, B35, B36, B37): with b data present, zero b rows.
Port probes: FrontdeskPort/BillingPort/BillingCommandPort with b ids under a's ctx → `common.not_found`.
Consumer probes: event envelopes for tenant b processed → only b rows change.

### 6.2 Cross-centre probes
Centre-scoped tenant_a user (centre A1) against A2 orders/items/discounts/approvals/TRFs/flags/invoices/credit notes/ledger/sessions/balances/charges/tasks/review items/refund requests → `404`; list endpoints exclude A2 rows; periodic (NULL-centre) documents invisible; all-centre finance user sees all.

### 6.3 Table probes (C0 `db/tests`, requested in 05 §9)
For every table in `frontdesk` and `billing`: SELECT with a's claims sees zero b rows; INSERT with b's tenant_id fails; UPDATE/DELETE of b rows affects zero rows; grant assertions (no DELETE; no UPDATE on append-only tables); immutability trigger tests; no sequences; tenant-leading index check.

### 6.4 Privilege-escalation tests
| Action | Actor without permission → | Actor with permission at aal1 → |
|---|---|---|
| approve discount | `403 auth.forbidden` | `403 auth.mfa_required` |
| cancel invoice / partial credit | `403 auth.forbidden` | `403 auth.mfa_required` |
| reverse ledger / request refund / approve refund | `403 auth.forbidden` | `403 auth.mfa_required` |
| approve own refund request (holds both permissions) | `403 billing.refund_self_approval_forbidden` | — |
| export / audit trail | `403 auth.forbidden` | `403 auth.mfa_required` |
| release override | `403 auth.forbidden` | `403 auth.mfa_required` |
| credit account terms / periodic bill | `403 auth.forbidden` | `403 auth.mfa_required` |
| settings / CBMS retry (tax rules are C3's — 08 R18) | `403 auth.forbidden` | `403 auth.mfa_required` |
| anonymise patient | `403 auth.forbidden` | `403 auth.mfa_required` |
| cash registration by `centre_staff` (no `billing.invoice.issue`) | `403 auth.forbidden` | — |
| close another user's cash session | `403 auth.forbidden` | — |
| revoked membership after token issue, privileged action | fails (IdentityPort re-validation) | — |
| locked account | `403 auth.account_locked` | — |
Plus: `getPatientDemographics` purpose without matching permission → `auth.forbidden`; `instrument_host_query` returns no name/phone; `lab_display` returns no phone; `notification` by a user actor returns `contactPresence` only; patient/portal actor → any BillingPort method → `auth.forbidden` (08 R8); `createOrderFromBooking` with `source = engagement_booking` by a user actor, or `home_collection` without `homecollection.visit.assign` → `auth.forbidden` (08 R7); `partner`/`portal`/`patient` claims see no frontdesk/billing rows (`app.is_staff_or_system()`).

### 6.5 Business-logic security tests
Gapless under concurrency; chronology trigger; print-count guard; single reversal; refundable cap; overpayment refusal; approval binding (fingerprint/patient/centre/discounts); idempotency replay and key reuse (`422 common.idempotency_key_reused`); stale quote; amount mismatch (Phase 1.5); B12 never accepts a client-supplied return URL (always `LIMS_FRONTDESK_PAYMENT_RESULT_URL`, which C15 checks against its allowlist — `payments.return_url_not_allowed` propagates) and the QR dialog never posts gateway `fields` from the staff browser (08 A19 D-113); a home-collection payment on a tenant-inactive method is recorded and raised for finance review, never silently dropped or dead-lettered (08 A19 D-128); PHI log-scan test with planted synthetic PHI through every C4 handler (05-DoD §1.8); copy-scan CI ("IRD approved…", "commission").

### 6.6 Upload tests (REQ-SEC-083/084/085)
EICAR, polyglot JPEG-HTML, `.pdf.exe`, SVG, 16 MB file, 0-byte file, PDF with JavaScript (sanitised by qpdf → clean or quarantined per qpdf result), JPEG with EXIF GPS (stored object has none), response headers on F21a and B29a (`Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`), and a scan of every F/B response body and header for Storage URL strings (must be none — P-2).

## 7. Secrets used

| Secret | Used by | Storage |
|---|---|---|
| none owned by C4 in Phase 1 | — | — |
| CBMS credentials (future, B6) | `LiveCbmsClient` | secret store, per tenant/environment (REQ-SEC-128); never in DB/logs |
| Gateway secrets | C15 only (C4 never sees them) | C15 |
| Storage signing | C0 core helper | C0/C1 |

## 8. Security sign-off checklist (05-DoD §4)

- [ ] every REQ in §1 has a code location and a test (map in PR descriptions)
- [ ] no foreign touchpoint added by C4
- [ ] no BYPASSRLS role / `service_role` on any C4 path
- [ ] exactly one SECURITY DEFINER function requested by C4: `frontdesk.purge_trf_drafts(interval, uuid[])` (owner `lims_owner`, EXECUTE `lims_worker`, `SET search_path = ''`, owner policies `trf_attachments__select__owner_only` / `__delete__owner_only` gated by `app.maintenance = 'frontdesk_purge_trf_drafts'` — 08 A10.5/A12.2), in `db/meta/definer-inventory.yaml` and 03-IC §13.3; its FORCE-RLS tests pass; all guards are INVOKER
- [ ] rate tiers match 04 §4 (`general` for all C4 operations)
- [ ] probes §6.1–§6.3 complete; privilege tests §6.4 complete
- [ ] billing UI/docs contain no approval claims; billing flagged "not certifiable" until B6 documents (05-DoD §5.4)

Review fix pass 2026-11-06 — review/C4-frontdesk-billing.md + 08 Addendum A13 applied (P-2 streaming downloads, P-3, P-9, P-12, D-24 two-person refunds, D-27 anonymisation, one inventoried DEFINER).

Final sweep 2026-11-06 — second touch applied (§6.5: D-113 return URL / no form post; D-128 inactive method review; A16.1 cast covered by 05-SCHEMA DB test 9).
