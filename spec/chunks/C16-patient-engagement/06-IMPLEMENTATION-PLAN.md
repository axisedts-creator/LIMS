# C16 — Patient Engagement — 06 Implementation Plan

Status: DECISION draft, 2026-11-06. One task ≈ one PR (02-CV §12). Branch `c16/<topic>`. "AC" = `01-PRD.md` acceptance criteria (US-EN-nn.k). Every task also carries the standard PR gates (05-DoD §1): probes for every new operation and table, contract tests, log-scan test, docs updated.

## 0. Prerequisites from C0 and others (block integration tests, not the start of work)

| Needed | From | CR | Until merged |
|---|---|---|---|
| `engagement` DDL + RLS + triggers + helpers + views (05-SCHEMA) | C0-0B (contract wave 3, C0 T0B-14) | CR-C16-006, -012 | unit tests only for DB-dependent code |
| `contracts/openapi/engagement.yaml` (TRD §5), event schemas `engagement.booking.*.v1` (03-IC §3.22/§3.24), errors, permissions, routes | C0-0C | CR-C16-002, -003, -011 | Prism mock `pnpm mock:engagement` built from the C16 TRD draft by C0 |
| Auth resolvers `patientPreAuth`, `queueDisplayToken`; `(display)` route group | C0-0D | CR-C16-005, -001 | resolver unit tests with a fake core |
| `IdentityPort` patient methods; patient session endpoints | C2 | CR-C16-004 | `@lims/fakes` IdentityPort extended by C0 |
| `FrontdeskPort` additions | C4 | CR-C16-007 | fake |
| `ReportingPort` patient support + `redeemPortalLinkForApp`; message templates; portal app-link files | C6 | CR-C16-008, -009, -010 (+ CR-C13-005) | fakes; template registry fake |
| `SmartSummary` display fields (type only; C16 does not call `SmartReportPort` — 08 A2.3) | C14 | CR-C16-015 (merged into CR-C14-001) | fake |
| Smart-summary snapshot on the report version via `ReportingPort` | C6 | 08 A2.3/A2.8 | ReportingPort fake returns a snapshot |
| `PaymentProviderPort` with `getIntent` | C15 | CR-C15-001 | fake |
| Flutter kit components + dependency pins | C0-0D | CR-C16-016, -017 | tasks needing them wait (no local look-alikes, 02-CV §14) |
| Infra exposure, nginx limits | C1 | CR-C16-018 | staging only |

C16 never writes migrations, specs or fakes (CM §4).

## 1. Tasks

### 1.1 Foundation

| ID | Goal | Files / paths | Depends on | Done when | Tests | ACs |
|---|---|---|---|---|---|---|
| T-01 | Module skeleton, manifest (produces, systemPermissions, authResolvers), config + boot checks, permissions list | `services/api/src/modules/engagement/{index,permissions,config}.ts`, `services/worker/src/jobs/engagement/index.ts` | C0 cores; paired C0-0D PR | boot fails on OTP TTL > 600, attempts ≠ 5, length < 6, missing key files; manifest validates against `EVENT_PRODUCERS`; **phase stub replaced (08 A17 P-20):** `EngagementPort` removed from `phase-stubs.ts` in the paired C0-0D PR and C16's own implementation registered, returning exactly the stub results | unit config tests per boot rule; `phase1Stub` contract subset passes against C16's implementation | US-EN-01.3 |
| T-02 | Pure domain: state tables (booking, token, link, reminder, enquiry, payment request), `stage.ts`, `slots.ts`, `linkCode.ts`, `otp.ts`, `phone.ts` | `domain/*.ts` | — | every TRD/App-Flow transition encoded as data | unit: each allowed transition + one forbidden per state; stage table for all 14 specimen statuses; slot boundaries (lead, horizon, blackout edges, end-of-day); code normalisation table; OTP digit distribution smoke test | US-EN-07, 12, 21 (logic) |
| T-03 | Settings + coded sets (T1, T2, T3a staff, T3b patient `/me/coded-sets`), defaults when row absent | `service/settings.service.ts`, handlers, `repository/settings.repo.ts`, `codedsets.repo.ts` | T-01, DDL | range errors map to `engagement.setting_out_of_range`; consent text change requires new version | integration; aal1 → `auth.mfa_required` on T2; probe | US-EN-20 (config) |

### 1.2 Milestone M1 — Phase 2 (no app): queue and reminders

| ID | Goal | Files | Depends | Done when | Tests | ACs |
|---|---|---|---|---|---|---|
| T-Q1 | Queues and counters (Q1, Q2) | `service/queue.service.ts`, `repository/queue.repo.ts`, handlers | T-03 | centre-scoped CRUD with If-Match | integration; centre probe (C1 staff vs C2 queue) | — |
| T-Q2 | Tokens: issue, call next, recall/serve/complete/skip/cancel, transfer; `close_queue_day` cron | queue service, handlers Q3–Q7, `cron.ts` | T-Q1 | numbering per business date in tenant tz; `SKIP LOCKED` call-next | 20 parallel issues → 20 distinct seqs; 2 parallel call-next → 2 different tokens; every transition test; day rollover with fake clock | US-EN-21.1–6 |
| T-Q3 | Board + display resolver + pairing/revoke (Q8, Q9) | `auth/display.resolver.ts`, handlers | T-Q2, CR-C16-005 | ETag/304; device actor limited to Q9; centre name from `booking_centres` | display token on every other op → 403; revoked → 401; board has no patient fields (schema test); 304 path; FORCE-RLS tests of `app.engagement_resolve_display` (05-SCHEMA §6.6 test 4: own GUC `app.pre_engagement_display_token_sha256` set by `lims_app` sees nothing; GUCs empty after return) | US-EN-22.2–5 |
| T-Q4 | Staff web: queue console W6 + setup W7 | `apps/web/src/app/(staff)/engagement/queue/**`, `features/engagement/{components,server}/queue*` | T-Q2, T-Q3, CR-C16-016 (`TokenSlip`) | 04-UI-UX W6/W7; shortcuts registered | component tests; keyboard script; axe | US-EN-21 |
| T-Q5 | `(display)` group layout + display page `(display)/queue-display` + BFF route + cookie pairing | `apps/web/src/app/(display)/layout.tsx`, `apps/web/src/app/(display)/queue-display/**` | T-Q3, CR-C16-001, CR-C16-016 (`QueueBoard`) | layout has no staff shell/session, CSP as shell; states Not paired / Live / Stale; cookie `__Secure-lims_qdisp; Path=/queue-display; HttpOnly; Secure; SameSite=Strict` | e2e on compose: pair → logout → board updates; revoke → unpaired | US-EN-22.1–4 |
| T-R1 | Reminders: R1–R3, dispatcher cron, `send_reminder` task, opt-out, in-app notification hook (no-op until accounts exist) | `service/reminder.service.ts`, tasks, cron | T-03, NotificationPort fake + CR-C16-009 | suppression statuses recorded | worker integration with fake clock; NotificationPort spy: params exactly `{lab_name, datetime}`; cancelled → no call; replay → same delivery | US-EN-23.1–4 |
| T-R2 | Staff web W9 (+ R4 suggestions panel when T-P4 exists) | `app/(staff)/engagement/reminders/**` | T-R1 | 04-UI-UX W9 | component + axe | US-EN-23 |
| T-OPS1 | Metrics, alert rules (`services/worker/src/jobs/engagement/alerts/engagement.rules.yml`, wired by C1 per 08 A13 P-14), `purge_ephemeral` (P-18(c) system deletes) and `purge_queue` tasks calling the §6.4 DEFINERs, dashboards registered with C1 | `services/api/src/modules/engagement/metrics.ts`, worker cron | T-Q2, T-R1 | metric names per TRD §13; alert rules delivered to C1; all crons `per_tenant` (P-6) | metric unit tests; alert rule lint (C1 format); 05-SCHEMA §6.6 test 5 (purge DEFINERs: claimed tenant only, own `app.maintenance` sees nothing, reset after return); E-table deletes only by the system actor and only past `expires_at`; a `link_codes` row referenced by a link is kept | — |

### 1.3 Milestone M2 — bookings (staff side + events)

| ID | Goal | Files | Depends | Done when | Tests | ACs |
|---|---|---|---|---|---|---|
| T-B1 | Bookable catalogue S12–S14 + `sync_bookable_items` task + nightly cron + `catalog.changed.v1` consumer (inactive until CR-C16-013) | `service/bookable.service.ts`, task, consumer | T-03, CatalogPort fake | price snapshot from tenant default; no-price handled | integration; consumer duplicate/unknown-entity tests | US-EN-26.1–3 |
| T-B2 | Slot templates + blackouts S7–S11 + staff availability S6 + `sync_booking_centres` task and nightly cron (08 A19 D-119) | `service/slot.service.ts`, repos, task | T-02, T-03 | overlap rule; overbooked flag; affected counts; template save enqueues the centre sync | integration; timezone fixture (Asia/Kathmandu UTC+05:45) | US-EN-16.1–4 |
| T-B3 | Booking create/cancel/check-in (staff S1–S5) + occupancy + `booking_no` + transitions + event publisher | `service/booking.service.ts`, `events/publish.ts`, repos | T-B1, T-B2, T-Q2 (check-in token) | both events validate against schemas; idempotency keys per TRD §7.1 | event contract tests; 20 parallel bookings for 1 place → 1 success; replay same Idempotency-Key → one event; centre probes; forbidden transitions | US-EN-12.2–4, 14.1, 14.6, 15.1–3 |
| T-B4 | `reconcile_bookings` + `mark_no_shows` crons (`centre_visit` only) + `homecollection.collection.synced.v1` consumer (08 A19 D-120) | worker cron, consumer, booking service | T-B3, `frontdesk.v_pub_order_status` | completion/no-show/order-cancelled rules; home bookings complete only from the synced event | fake clock + seeded view rows: registered → completed; pre_registered past grace → no-show + event, occupancy unchanged; cancelled order → cancelled without event; `home_collection` booking past grace never auto-no-showed; synced event with `booking_id` → completed with `order_id`, duplicate event no-op, event without `booking_id` no-op | US-EN-14.4–5, 14.7 |
| T-B5 | `send_booking_message` task (confirmation/cancel SMS) + booking reminders scheduling | tasks, reminder service | T-B3, T-R1 | templates per CR-C16-009 | NotificationPort spy; booking < 24 h ahead → no reminder | US-EN-12.8, 25.1–2 |
| T-B6 | Staff web W1–W5 | `app/(staff)/engagement/{bookings,slots,bookable-items}/**` | T-B1–T-B4, CR-C16-016 (`WeekdayTimeRangeEditor`) | 04-UI-UX W1–W5 | component, keyboard, axe | US-EN-15, 16 |

### 1.4 Milestone M3 — patient sign-in and linking (Phase 3 per 01 §1 wave order; B1 closed, 08 A11.2)

| ID | Goal | Files | Depends | Done when | Tests | ACs |
|---|---|---|---|---|---|---|
| T-A1 | Flutter skeleton: flavours (`tenant_code`, env URLs), router (routes.yaml ids), Riverpod, session store (`flutter_secure_storage`), API client factory + interceptors (auth, version headers, request id, single-flight refresh, 426), app-lock gate, temp-file cleanup, secure screens | `apps/patient_app/**` | CR-C16-016/017, `lims_api_client` generated | builds for Android (debug/release obfuscated) | widget tests: refresh single-flight; stored session token replaced by the rotated one on every refresh before the retry (review C16 #20); wipe on `auth.session_expired`; 426 → A1; app-lock after 300 s background (fake clock); no token in shared prefs (test harness inspects storage) | US-EN-02.1–5, 20.1 |
| T-A2 | Pre-auth resolver + E1 + E2 + `send_login_otp` task (incl. supersession as the system actor, `auth.otp_sent` access log) | `auth/preauth.resolver.ts`, `service/auth.service.ts`, `repository/otp.repo.ts`, task | T-01, CR-C16-005, NotificationPort fake | challenge stored hashed/encrypted (`code_hmac`, `phone_hmac` 32-byte `bytea`, 08 A5.5); ciphertext nulled after send; tenant daily cap | integration: rate limit 4th request → 429; prefix rule; identical response shape with/without account; daily-cap key `otp_day:<yyyymmdd>` accepted by `number_counters__key__ck`; log-scan for OTP/phone; FORCE-RLS tests of `app.engagement_resolve_preauth` (05-SCHEMA §6.6 test 4) | US-EN-01.1–2, 6–9 |
| T-A3 | E3 verify + accounts + IdentityPort provisioning/session + C2 refresh/logout usage | auth service, `repository/accounts.repo.ts` | T-A2, CR-C16-004 fake | PRE_ACC insert works only for the verified phone | integration: 5 wrong → exhausted; `attempts`/`failed` and the `auth.otp_failure` row persist after each `401` (`commitOnError`, 08 A19 P-42); expired → invalid; correct → session; C2 fake error → `500` with challenge and attempts unchanged and a retry with the same code succeeding, reusing the same account id (= challenge id); replay verify → invalid; SQL probe: pre-auth claims cannot SELECT another phone's account | US-EN-01.3–5 |
| T-A4 | App screens A0–A4 | `features/auth/**`, `app/app_lock_gate.dart` | T-A1, T-A3 | 04-UI-UX A0–A4 copy | widget tests per state; integration_test against Prism | US-EN-01, 02 |
| T-L1 | Link codes L1–L4 + consents + staff web W8 | `service/link.service.ts`, `repository/{linkCodes,consents}.repo.ts`, `app/(staff)/engagement/app-access/**` | T-03, FrontdeskPort fake (CR-C16-007) | code shown once; HMACs stored as 32-byte `bytea` (`code_hmac`, `bound_phone_hmac`, `record_phone_hmac`; 08 A2.4/A5.5); redemption bytea = bytea; access log; volume metric | integration; probes (staff of tenant B; patient actor → 403); code printed slip has no name (component test) | US-EN-03.1, 6–7 |
| T-L2 | Redeem code E14 (DEFINER redeem), limits, backfill task, projection service skeleton | link service, `service/projection.service.ts`, task `backfill_link`, `repository/views.repo.ts` | T-L1, T-A3, views | backfill from views + `getReleasedReports` | wrong phone → invalid; reuse → invalid; same account → 200; failure counter persists after each `422` (`commitOnError`) and → 429 after 5; limit `409` rolls the redemption back (code still `issued`); code `self` for an account with a `self` link → link `other`; existing suspended link → reactivated by the DEFINER; `sex_snapshot` copied; FORCE-RLS tests 1–3 and guard test 6 (05-SCHEMA §6.6; probe P-L9); backfill idempotent (run twice); backfill `status_seq` = `specimen_version` (or 0 before CR-C16-022) | US-EN-03.2–5, 8; 06.7 |
| T-L3 | Redeem report link E15 | link service | T-L2, CR-C16-008 fake | URL validation; `visible_from` rule | C6 fake failure → identical 422; visible_from filtering of older reports; later code widens history; suspended link reactivated via `engagement_apply_report_link` with `visible_from = releasedAt`; `self`→`other` rule | US-EN-04.1–6 |
| T-L4 | Self-registration E16/E17 + `create_self_patient` task | `service/selfreg.service.ts`, task | T-L2, CR-C16-007 fake | duplicate-suspected still new record | child age rule; consent version mismatch; feature off; task failure → failed | US-EN-05.1–5 |
| T-L5 | `reconcile_links` cron: phone mismatch, merged/anonymised, dormant; projection deletion on last revoke | link + projection services, cron | T-L2 | rules per TRD §4.3.5 | fake demographics changes → suspended; reactivation by new proof; deletion of projections; `display_name`/`sex_snapshot` refreshed | US-EN-06.1–3, 5 |
| T-L6 | App screens A6–A9 + remove/relationship (E13, E18, E19) | `features/profiles/**` | T-L2–T-L4, T-A4 | copy and identical error text | widget + integration_test | US-EN-03–06 |

### 1.5 Milestone M4 — orders, reports, smart summary, notifications

| ID | Goal | Files | Depends | Done when | Tests | ACs |
|---|---|---|---|---|---|---|
| T-P1 | Consumers: `lab.specimen.status_changed.v1`, `lab.specimen.rejected.v1`, `reporting.report.released.v1` (incl. `addendum` and unknown `report_kind`, 08 A13 P-4), `billing.balance.changed.v1`; stage recompute; notifications | `consumers/*.ts`, projection service, `service/notification.service.ts` | T-L2 | inbox dedupe; seq guard; unlinked no-op | per consumer: 03-IC example payloads, unknown extra fields, duplicate delivery, stale seq, unlinked patient, partner order filtered | US-EN-07.1–5, 08.1–2 |
| T-P2 | Orders E20/E21 (ETag/304) + app A10/A11 with polling | handlers, `features/orders/**` | T-P1, T-A4 | 30 s foreground polling, stops in background | API: visible_from filter, 304; probes (account B); app: polling lifecycle test | US-EN-07.6–8 |
| T-P3 | Reports E22/E23 (stream, sha256 check, access log, rate limit) + app A12/A13 (PDF viewer, temp cleanup, save confirmation) | `service/report.service.ts`, handlers, `features/reports/**` | T-P1, CR-C16-008 fake | headers per TRD | 21st download → 429; account B → 404; superseded listing; app temp file deleted on close/logout | US-EN-08.1–6 |
| T-P4 | `fetch_smart_summary` task + E24 + app A14 (+ R4 suggestions source) | task, report service, `features/reports/smart/**` | T-P3, ReportingPort fake with smart-summary snapshot (08 A2.3; no SmartReportPort) | approved-only storage | draft → not stored; feature disabled → hidden; newer version | US-EN-09.1–4, 24.1–3 (with T-R1) |
| T-P5 | Notifications E45/E46 + app A20 (bell badge, kind rendering) | handlers, `features/notifications/**` | T-P1 | no text stored | mixed-ids bulk → per-id not_found; rendering per kind; no push SDK in dependency tree (CI script) | US-EN-11.1–3 |

### 1.6 Milestone M5 — app bookings, payments, membership, enquiries, account

| ID | Goal | Files | Depends | Done when | Tests | ACs |
|---|---|---|---|---|---|---|
| T-BK1 | Patient booking endpoints E30–E40 (incl. reschedule) + app A16–A19 | booking/slot services, `features/bookings/**` | T-B3, T-L2 | wizard per 04-UI-UX; Idempotency-Key per review step | limits; sex restriction; address ownership; reschedule atomicity; app wizard widget tests | US-EN-12.1–8, 13.1–2, 14.1–3 |
| T-PAY1 | Payment requests E41/E42 + `create_payment_intent` and `refresh_payment_request` tasks (system actor, 08 R8) + `expire_payment_requests` cron + app A15 | `service/payment.service.ts`, task, `features/payments/**` | T-P2, PaymentProviderPort fake | "Paid" only on `completed` | every C15 error → failed code; `outcome` query ignored (app test); action scrubbed after ready; amount field rejected by schema | US-EN-10.1–6 |
| T-M1 | Membership plans/enrolment/lookup/cancel (M1–M5) + E47 + expiry cron + W10 + A21 | `service/membership.service.ts`, `app/(staff)/engagement/memberships/**`, `features/membership/**` | T-03, `CatalogPort.getPriceListStatus` fake (CR-C16-023, 08 A24.1) | card token format; overlap rule | aal1 on plan write → mfa_required; BarcodeInput pattern test; patient sees only own profiles' cards; M1b: `getPriceListStatus` fake → `not_found` / `isActive: false` / `status: 'draft'` each → 400, `published` + active → 201; no `catalog.v_pub_*` read from the handler (08 A24.1) | US-EN-17.1–6 |
| T-EP1 | `EngagementPort` implementation (`getHomeAddress`, `getActiveMembership`) — replaces the dropped `v_pub_booking_address` / `v_pub_patient_membership` views (08 R25) | `services/api/src/modules/engagement/ports/EngagementPort.impl.ts` | T-M1, addresses service | contract cases 1–3 (08 §4.14) | other tenant → not_found/undefined; device/patient actor → `auth.forbidden`; replaces the stub-equivalent methods registered in T-01 (P-20) | US-EN-13.3, US-EN-17.5 |
| T-N1 | Enquiries N1–N4, E48–E51 + W11 + A22 | `service/enquiry.service.ts`, UI | T-A3 | transitions; open-limit | probes; closed reply → 409 | US-EN-18.1–4 |
| T-AC1 | Account E10–E12 (opt-out, deletion) + app A23 | `service/account.service.ts`, `features/settings/**` | T-A3, T-L5 | deletion effects per TRD §4.14 | after delete: sessions revoked (fake spy), links revoked, phone nulled; re-sign-in → new account | US-EN-19.1–2, 23.3 |

### 1.7 Hardening and release

| ID | Goal | Depends | Done when | Tests |
|---|---|---|---|---|
| T-SEC1 | Full probe suite (07-SECURITY §6), mobile security checks (device dump, screenshot block, obfuscation, TLS-bypass grep, dependency deny-list) | all API tasks | every operation and table covered; CI green | as listed |
| T-PERF1 | Load test per TRD §12 at 1× and 10× (seed generator) | M4, M5 | p95 targets met or CR raised | k6/pgbench scenario files under `services/api/src/modules/engagement/__tests__/load/` |
| T-DOC1 | Manual pages `docs/manual/engagement/**` + help files for every `helpKey` + patient page "How the app protects your reports" | screens | production build passes help check (C0-UI §7) | link checker |
| T-E2E1 | Nightly E2E: issue code → redeem → C5 fake events → release → download; booking → C4 fake consumer → completion | M4, M5 | runs in `nightly.yml` | — |
| T-REL1 | Android internal track build pipeline (signing via C1 secret store), iOS after Android | T-A1 | client-owned store accounts and signing keys available in the C1 secret store (founder decision 2026-11-06, research/04 §13) | release checklist |

## 2. Milestones

| Milestone | Contents | Exit criteria |
|---|---|---|
| M0 | T-01–T-03 | module boots against fakes; settings API |
| M1 (Phase 2) | T-Q1–T-Q5, T-R1, T-R2, T-OPS1 | queue + display + manual reminders pass chunk gate items for these stories; can ship without the app |
| M2 | T-B1–T-B6 | staff bookings with events consumed by C4's fake consumer; C17 reads addresses via EngagementPort (T-EP1) |
| M3 | T-A1–T-A4, T-L1–T-L6 | sign-in + linking end to end on staging with real C2/C4/C6 or their fakes |
| M4 | T-P1–T-P5 | orders/reports/smart/notifications |
| M5 | T-BK1, T-PAY1, T-M1, T-N1, T-AC1 | all PRD stories |
| M6 | T-SEC1, T-PERF1, T-DOC1, T-E2E1, T-REL1 | chunk gate (05-DoD §3) + security sign-off (§4); patient app launch gated by the client-owned store accounts (B1 closed, 08 A11.2) |

## 3. Fakes → real implementations

| Dependency | Fake used in | Switch when | Integration test that proves the switch |
|---|---|---|---|
| IdentityPort (+CR-C16-004) | T-A3 onward | C2 merges CR-C16-004 and passes its contract suite | sign-in → API call with patient claims → RLS sees own rows only |
| FrontdeskPort (+CR-C16-007) | T-L1, T-L4, T-L5 | C4 merges | self-registration creates a C4 patient; demographics purpose `patient_app_link` |
| ReportingPort (+CR-C13-005/CR-C16-008), NotificationPort | T-A2, T-L3, T-P1, T-P3, T-R1 | C6 merges | report release → app download (bytes + sha256); OTP SMS delivery row in C6 |
| CatalogPort | T-B1 | C3 chunk gate | sync prices from a real price list |
| BillingPort, `billing.v_pub_order_balance` | T-P1 | C4 chunk gate | balance event updates payment-due flag |
| ReportingPort smart-summary snapshot (08 A2.3) | T-P4 | C6 adds `smart_summary_json` + snapshot write at Regenerate (08 A2.8); C14 merges (Phase 2–3) | approved summary visible in app; zero `SmartReportPort` calls from C16 |
| PaymentProviderPort | T-PAY1 | C15 merges CR-C15-001 | Khalti sandbox flow on staging (C15 sandbox config) |
| Events from C5/C6/C4 | T-P1 | producers merged | E2E nightly |
| Consumers of booking events (C4, C17) | T-B3 | C4 chunk gate; C17 later | booking → pre-registered order visible in `frontdesk.v_pub_order_status` → booking completed |

Production boot fails while any of these is a fake (02-CV §8.2) unless C0's phase-stub allowlist (CR-C0-010) covers it; C16 features depending on a stubbed port stay switched off by tenant settings.

08 Addendum A2/A3 applied 2026-11-06 (A2.3 smart tab via ReportingPort snapshot; A2.4 link-code HMACs bytea).

Review fix pass 2026-11-06 — review/C16-patient-engagement.md + 08 Addendum A19 (plus A13/A17 P-rules) applied (tasks T-01, T-A1–T-A3, T-L2/T-L3/T-L5, T-Q3, T-Q5, T-OPS1, T-B2, T-B4, T-P1, T-EP1).

08 Addendum A4/A5 applied 2026-11-06 (A5.5: OTP, account and record-phone HMACs `bytea` `octet_length = 32`; no `decode(…,'hex')`; tests in T-A2/T-L1 and 02-TRD §14 integration row).

## 4. CR candidates foreseen (not raised as blocking now)

1. Push notifications (CR-C16-020) — after founder approval of B11.
2. Realtime private channels for order status — after C0 SP-4 proves 04 D3 and claims are available to Realtime.
3. Coupon redemption at C4 registration (CR-C16-021) — if the client insists after launch.
4. Certificate pinning (SPKI + backup pin + remote kill switch) — if the threat model changes (REQ-SEC-104).
5. Tenant-picker single app — if more than a few tenants want the app and per-tenant listings become a burden.
6. ~~`NotificationPurpose` values `booking_reminder` / `booking_cancelled`~~ — resolved: added by 08 R13 (CR-C16-009 as modified).
7. C2 method for staff contact — not needed by C16.
8. A C4 link from the patient page to `staff.engagement.app_access` (C4 UI).
9. Timezone-aware `business_date` in `v_pub_*` for tenants outside `Asia/Kathmandu`.

## 5. Risks and mitigations

| # | Risk | Impact | Mitigation |
|---|---|---|---|
| R-1 | Linking rules too strict → users can't see history and call the lab | adoption | report-link path for new reports; clear in-app guidance; desk code takes < 1 min (W8); metrics on link methods |
| R-2 | Linking rules bypassed by a service bug | PHI breach | RLS patient predicates + DEFINER redemption and reactivation + patient column guard on links (P-L9) + immutable link ids + probes for every endpoint (07 §6); pentest scope (REQ-SEC-043) |
| R-3 | SMS pumping / OTP cost abuse | money | prefix allowlist, per-phone and per-IP limits, tenant daily cap + alert |
| R-4 | C2 patient sessions (CR-C16-004) late or GoTrue mechanism unworkable on the pinned version (UNVERIFIED) | M3 blocked | build against the fake; C2 T1 mapping decides; fallback proposal for C2: server-held credential via existing `signInWithPassword` |
| R-5 | C4/C17 both create orders for home-collection bookings | duplicate orders | Resolved by 08 R7 |
| R-6 | Display polling load (40 req/s at N=10) | API capacity | 304 path, 5 s interval configurable to 10 s, metric + alert |
| R-7 | App-store review delays / rejections (policy content UNVERIFIED) | launch date | Android internal track first; account deletion and data-safety info prepared; store accounts and listings owned by the client (founder decision 2026-11-06) |
| R-9 | Phone recycling exposes reports | PHI breach | dormancy suspension (180 d), phone-change suspension, monthly OTP re-auth, app lock |
| R-10 | Minor/guardian consent rules wrong for Nepal (B16) | legal | tenant-configurable `minor_age_years`, consent text per tenant, counsel review before launch |
| R-11 | Patients save PDFs outside the app | PHI spread | explicit confirmation dialog; default in-app viewing; documented in the patient help page |
| R-12 | Missing Flutter kit components delay screens | schedule | CR-C16-016 raised early with props; API work proceeds independently |
| R-13 | Read-model drift (missed events) | stale status | nightly reconcile + drift metric; consumers idempotent |
| R-14 | Payment intent creation through the worker adds latency | UX | target ≤ 3 s p95 to `ready`; waiting screen; Graphile Worker job pickup monitored (`lims_queue_depth`) |
