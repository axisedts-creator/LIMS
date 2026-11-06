# C17 Home Collection — 06 Implementation Plan

Status: DECISION draft, 2026-11-06. One task ≈ one PR (02-CV §12). Branch `c17/<topic>`. Every task's "done-when" includes: CI gates green, probes for every new operation/table, tests listed, docs/manual updated (05-DEFINITION-OF-DONE §1–2). "Fake" = `@lims/fakes` implementation of the port (C0) or Prism mock of an HTTP spec.

## 0. Preconditions (C0 deliverables this chunk consumes)

| # | Needed from C0 | Status at start |
|---|---|---|
| P-1 | `homecollection` DDL + policies from 05-SCHEMA Part A | C0 Wave-3 contract wave |
| P-2 | `contracts/openapi/homecollection.yaml` from TRD §5–6 (incl. mutation `oneOf`) | same |
| P-3 | Event schema `homecollection.collection.synced.v1` (+ CR-C17-006 optional field) | same |
| P-4 | errors/permissions/routes additions (CR-C17-007/008/009) | same |
| P-5 | Fakes: FrontdeskPort, BillingPort, LabPort (+ `lookupSpecimens({orderId, statuses?})`, CR-C17-002 merged into CR-C10-003), EngagementPort (CR-C17-005), NotificationPort, IdentityPort; Prism mock of C2 mobile sessions (CR-C17-004) | same |
| P-6 | `lims_shared`, `lims_ui` incl. `LimsBarcodeScanner`, `LimsSyncStatus`, `LimsOfflineBanner`, `LimsSecureScreen`; pinned Flutter deps (CR-C17-010) | C0-0D |
| P-7 | **Biometric/device-credential plugin pinned (CR-C17-010)** — hard precondition of HC-T23 and of any phlebo_app release; there is no fallback gate (08 A19 D-127) | C0-0D; until it lands HC-T23 cannot be done and the app is not shipped |
| P-8 | C6 seed `homecollection.visit_scheduled` (CR-C17-014, 08 A19 D-129) | C6; until merged H19 rejects `notify_patient_on_assign = true` |

Until P-1..P-4 land, C17 works in its own paths against Prism + fakes; no task edits `db/` or `contracts/`.

## 1. Tasks

| ID | Goal | Files / paths | Depends on | Done when | Tests | Maps to |
|---|---|---|---|---|---|---|
| HC-T01 | Module skeleton + manifest + permissions + config | `services/api/src/modules/homecollection/{index,permissions,config}.ts`, empty handlers for every operationId | P-2 | API boots with module; every operationId has a handler returning 501 (dev only) | boot test | — |
| HC-T02 | Domain: visit/collection/handover state tables, mutation registry + validators, clock correction, cursor | `domain/*` | — | pure, 100 % transitions covered | unit: every allowed + one forbidden transition per state; clock anchor/offset/device/clamp/reboot; cursor encode/compare | 03-APP-FLOW §1, TRD §7.5 |
| HC-T03 | Repositories | `repository/*.repo.ts` | P-1 | all queries parameterised, explicit `tenant_id` filter | integration on migrated PG 17 (tenant_a/b) | — |
| HC-T04 | Settings + reasons endpoints (H18–H20) | handlers, `settings.service.ts`, mappers | T01–T03 | settings row created lazily on first use in any path with `INSERT … ON CONFLICT (tenant_id) DO NOTHING` and the TRD defaults; a read with no row uses the defaults (08 A17 P-22); reasons from global seeds only (D-130) | contract + probes; validation ranges; non-seed payment code rejected (D-128); `notify_patient_on_assign = true` rejected until CR-C17-014 (D-129) | US-07-7, TRD §11.2 |
| HC-T05 | Booking consumers (confirmed/cancelled) + booking_refs | `services/worker/src/jobs/homecollection/consumers/engagement.booking.*.ts`, `visit.service.ts` | T02–T03, P-5 | US-01, US-10 pass | consumer tests: 03-IC examples, duplicate, unknown fields, cancel-before-confirm (stale seq), EngagementPort failure → flag | US-01, US-10 |
| HC-T06 | `frontdesk.order.created.v1` consumer + specimen refresh task | consumers, `tasks/refresh_visit_specimens.ts`, `specimen.service.ts` | T05 | US-02 passes | consumer tests (home/front_desk, home_collection source, walk_in ignored, duplicate) | US-02 |
| HC-T07 | Specimen status + rejection consumers | consumers `lab.specimen.*` | T06 | US-11-1/2, US-14 | stale seq ignored; recollection idempotent per specimen; no-visit order ignored | US-11, US-14 |
| HC-T08 | Visit read endpoints H1, H2, H10, H12, H21 + DTO allowlists | handlers, mappers | T03 | phlebotomist-only filter enforced; H1 uses one `getPatientDemographicsBatch` per page; staff names via `ctx.core.memberships.list` (P-17); H2/H21 access-log rows | contract; probes; allowlist tests per role; `403 visit_not_assigned`; H12 `route_full`; H2 `visit_detail` and H21 `phone_reveal` log rows | US-04-3, US-06-5, US-16 |
| HC-T09 | Dispatcher actions H3–H8, H11 (incl. order creation at assign) | `visit.service.ts`, `route.service.ts` | T08, P-5 | US-03, US-04, US-11-3, US-15 (manual trigger); route version rule (TRD §4.1) | integration with FrontdeskPort fake (success, each error, replay); concurrency (two assigns same version → one 409); route full; daily cap 60 (D-131); H5 on an assigned visit bumps the route version; H7 bad parent → `409 homecollection.visit_closed`; SMS failure inside a savepoint does not fail the assign (P-44) | US-03, US-04, US-11 |
| HC-T10 | Device register + sign-off (A1, A5) | `device.service.ts` | T03 | US-13-2 server side | probes; sign-off 409 when seq missing; wipe_requested → 409 | US-13 |
| HC-T11 | Snapshot pull (A2) + ack (A4) | `snapshot.service.ts` | T08, T10 | US-06 passes; access_log rows written; `lookupSpecimens` called on every changed snapshot | contract (field tables TRD §5.3.1); probes; p95 test with 40 visits (fakes with 03-IC latencies); unchanged path makes no demographics calls (spy); port error → `specimens_stale` (review #2) | US-06, US-13-5 |
| HC-T12 | Push pipeline (A3): dedupe, guards, effects, events | `sync.service.ts`, `conflict.service.ts`, `events/publish.ts` | T02, T09, T11 | US-08 passes; SELECT → guard → INSERT order (review #14); JCS payload hash (m#38); `sync_batches` inserted last | integration per guard row (03-APP-FLOW §4); idempotent replay (same key; new key → duplicate); payload-hash mismatch; `common.not_found` mutation not stored, re-evaluated on resend; handover items get barcode/specimen type; handover across two centres rejected; 413 limits; event payload schema validation + idempotency key (with/without `booking_id`, D-120); split > 50 collections | US-07 (server), US-08, US-12-1/3 |
| HC-T13 | Review queue (H9) | `collection.service.ts` | T12 | US-09 passes | apply emits event once; apply on non-ordered → 409; discard; not held → 409 | US-09 |
| HC-T14 | Handovers H13–H15 + handover mutation effects + task `flag_handover_discrepancy` | `handover.service.ts`, `services/worker/src/jobs/homecollection/tasks/flag_handover_discrepancy.ts` | T12 | US-12 passes with a receiver who is not a member of the home-collection centre (D-125) | centre-scope probes on `to_centre_id`; H14 reads no visit table; H15 enqueues the task; discrepancy flags written by the worker | US-12 |
| HC-T15 | Device admin H16–H17 | handlers | T10 | wipe command delivered in snapshot | probes; privileged (`auth.mfa_required` at aal1) | US-13-5 |
| HC-T16 | Cron: missed sweep, overdue handovers, GPS purge, retention anonymise — all `per_tenant` (P-6) | `services/worker/src/jobs/homecollection/{cron.ts,tasks/*}` | T09, T14 | US-15, US-12-4 pass | integration with fake clock; sweep skips pulled routes (D-126); GPS purge as system actor under the P-18(c) delete policy; `app.homecollection_anonymise_retired_visits` FORCE-RLS tests T1–T5 (05-SCHEMA §4.2, 08 A12.7) | US-12-4, US-15 |
| HC-T17 | Observability (metrics, logs, alert rules file + CI job scripts per TRD §14, P-14) | module + worker, `alerts.yaml`, `apps/phlebo_app/tool/ci/*` | T12 | metrics in TRD §14 exported; log PHI scan test passes; C1 and C0-0A wiring CRs filed | log-scan test with planted names/phones/barcodes | DoD §3.7 |
| HC-T18 | Web: nav, dispatch board, schedule/assign/cancel dialogs | `apps/web/src/{app/(staff),features}/homecollection/**` | T09, P-4 | US-03/04/05 via E2E on Prism/real API | component tests; axe; keyboard-only walk-through | US-03, US-04, US-05 |
| HC-T19 | Web: visit detail + review + flags | same | T13, T18 | US-09 UI | component + E2E | US-09 |
| HC-T20 | Web: handovers, devices, settings | same | T14, T15, T04 | US-12 UI | scan flow test (kit BarcodeInput), confirm/discrepancy | US-12, US-13-5 |
| HC-T21 | App skeleton: flavours, router, theme, pinned HTTP, api factory, error mapping | `apps/phlebo_app/lib/{main.dart,app,core/net}` | P-6, CR-C17-011 (dev pins = staging CA) | app builds for dev/staging; no `badCertificateCallback` (CI grep) | unit; MITM test against a proxy with an untrusted cert → refused | REQ-SEC-104/105 |
| HC-T22 | Encrypted stores + keys + wipe/crypto-shred | `core/db/*` | T21 | both DBs open only with key; destroy order key→file | forensic test: file header ≠ `SQLite format 3`; reopening after key deletion fails; WAL/SHM removed | US-13, REQ-SEC-103 |
| HC-T23 | Session: C2 mobile login/refresh/logout, token guard, re-auth gate, integrity check, outbox owner binding | `core/session/*`, `core/platform/integrity.dart`, `features/login` | T21, CR-C17-004 (Prism), **P-7 (CR-C17-010 plugin pinned — hard precondition, D-127)** | refresh-before-call; `openMobileSession` sends `app_instance_id = phlebo.device_id` and `app_platform`; logout via `logoutMobileSession({session_token})`; revoke path destroys cache; 300 s gate | unit with fake clock; integration_test on emulator; other user refused while outbox non-empty; A1 409 for a foreign device id → reset path (review #8, #12) | US-07-8, US-13-2/4/6 |
| HC-T24 | Outbox + frozen batch bodies + clock anchors + monotonic/boot-id channels | `core/sync/clock_anchor.dart`, `core/platform/*`, `features/outbox` | T22 | invariants B.2 1–5 hold; spike records whether Android `elapsedRealtime()` includes deep sleep and whether `Settings.Global.BOOT_COUNT` is readable (both UNVERIFIED, review m#36) | unit; kill-app test (mutation persisted before UI ack); `batches.body_json` re-sent byte for byte | US-07-1, US-13-1 |
| HC-T25 | Sync engine (push → pull → ack, backoff, batch reuse) | `core/sync/sync_engine.dart` | T24, T11, T12 | same batch_id and identical body on retry; `422 idempotency_key_reused` → new batch_id (review #3); snapshot atomic replace | integration_test vs Prism + chaos (drop responses, 401 then refresh, 503, 422 reused key) | US-06, US-08-2/10 |
| HC-T26 | Visit flow screens M3–M9 + guard | `features/{visit,identity,consent,collect,payment,outcome}` | T25 | US-07 passes offline | widget tests per step; scan outcomes; manual entry; payment reference rule | US-07 |
| HC-T27 | Route list M2, handover M10, outbox M11, settings M12 | `features/{route,handover,outbox,settings}` | T26 | US-13-1/2, US-12 device side | widget + integration | US-12, US-13 |
| HC-T28 | Purge triggers (offline hours, date rollover, revoke, wipe command) | `core/db/wipe.dart`, sync engine hooks | T25 | US-13-3/4/5 | fake clock tests; wipe after drain | US-13 |
| HC-T29 | Release hardening: obfuscation, FLAG_SECURE on all PHI screens, text-field flags, min-version handling, binary secret scan | build config, `core/platform/secure_screen.dart` | T27 | REQ-SEC-107/109/111/112/113 checks pass | `strings`/apktool scan in CI; manual device test record | 07-SECURITY §4 |
| HC-T30 | E2E nightly scenario + manuals + help | `apps/phlebo_app/integration_test`, `apps/web/.../tests/e2e`, `docs/manual/homecollection/**`, `features/homecollection/help/*` | all | scenario in TRD §15 green on compose stack | E2E | DoD §3.8, §5 |

## 2. Milestones

| M | Contents | Exit |
|---|---|---|
| M1 Server core | T01–T12 | push/pull work against fakes; events validate |
| M2 Staff web | T13–T20 | dispatcher can run a day on staging with the Prism-mocked app |
| M3 App | T21–T29 | offline visit end-to-end on emulator against staging API |
| M4 Integration | T30 + fakes swapped | chunk gate (05-DEFINITION-OF-DONE §3) |

## 3. Fake → real switch

| Dependency | Fake until | Switch when | Integration test after switch |
|---|---|---|---|
| FrontdeskPort, BillingPort | C4 chunk gate | C4 merged + CR-C17-001 merged | assign → registered order → `frontdesk.order.created.v1`; synced payment → ledger row with `client_mutation_id` key |
| LabPort.lookupSpecimens | C5 implements CR-C10-003 (absorbs CR-C17-002) | merged | barcodes match C5 label page; synced → specimen `collected` → `in_transit` |
| EngagementPort, booking events | C16 | C16 merged + CR-C17-005 | booking E2E |
| NotificationPort | C6 | merged (+ CR-C17-014 for the patient template) | assignment SMS answered `suppressed_no_contact` (staff, Phase 1, 08 A13 D-34); scheduling SMS queued after CR-C17-014 (non-prod no provider, REQ-SEC-136) |
| C2 mobile sessions | C2 implements CR-C17-004 | merged | login/refresh/revoke on staging |
| IdentityPort | C2 | merged | privileged device/settings ops need aal2 |

## 4. CR candidates already foreseen

CR-C17-001 … CR-C17-014 (TRD § Change requests raised; CR-C17-014 = C6 template seed, 08 A19 D-129). Additional, not filed yet:
- C5: multi-order label page (print all labels of a route in one dialog) — today one page per order.
- C0-0D: `LimsStepHeader` widget (nice-to-have).
- C4: home-collection receipt reprint/SMS for the patient after a field payment (receipt is C4's).

08 Addendum A2/A3 applied 2026-11-06 (A2.5 `map_handoff_enabled` default true; A2.12 C4 `frontdesk.order_flags` review, no `finance_review_items`).

08 Addendum A4/A5 applied 2026-11-06 (A5.5: no C17 HMAC columns; no change).

Review fix pass 2026-11-06 — review/C17-home-collection.md + 08 Addendum A19 (D-120, D-125…D-131) and the A13/A17 rules that apply to C17 applied (preconditions P-7/P-8, tasks T04, T08, T09, T11, T12, T14, T16, T17, T23–T25).

## 5. Risks

| Risk | Mitigation |
|---|---|
| ~~C4 rejects CR-C17-001~~ — closed: CR-C17-001 accepted-modified (08 R7: C17 creates home-collection orders at assignment; C4's consumer ignores `home_collection`) | E2E test still guards against duplicate orders |
| iOS clock/boot semantics UNVERIFIED | Android first (ASSUMPTION staff-managed Android); iOS anchors valid in-process only |
| SQLCipher hook build differs per platform / cipher choice | C0 pins one; T22 forensic test on every CI build |
| No camera scanning library approved | HID scanner + manual entry (barcode_verified false) keep the flow working |
| Field users try to log out with pending data | logout block + server sign-off check; Outbox screen explains |
| Device clock badly wrong | anchor-based correction; plausibility clamp; skew alert |
| Lost phone with unsynced collections | outbox holds minimal data, encrypted; C5 web collect as manual fallback (runbook) |
| Snapshot latency with slow ports | 40-visit route default, 60-visit daily cap (D-131); unchanged-cursor path; one demographics batch call; a failing `lookupSpecimens` marks only that visit `specimens_stale` (no read-model fallback, review #2) |
| ~~Map hand-off not approved (B11)~~ — closed: approved by the founder 2026-11-06 (address only, device's own maps app) | tenant switch `map_handoff_enabled` (default true, 08 A2.5); address text + landmark when off |
