# C17 Home Collection — 02 TRD

Status: DECISION draft, 2026-11-06. Read with `01-PRD.md`. Names of events, ports, error codes, permissions and routes are verbatim from 03-IC; anything new carries a `CR-C17-0nn` id (last section) and is designed as if accepted.

## 1. Owned paths (CM §3)

| Path | Content |
|---|---|
| `apps/phlebo_app/**` | Flutter app (Dart package `phlebo_app`, 02-CV §2.1) |
| `services/api/src/modules/homecollection/**` | API module (manifest, handlers, services, domain, repository, mappers, tests) |
| `services/worker/src/jobs/homecollection/**` | consumers, tasks, cron |
| `apps/web/src/app/(staff)/homecollection/**` | staff route segment |
| `apps/web/src/features/homecollection/**` | nav manifest, BFF server functions, components, help |
| `docs/manual/homecollection/**` | user manual pages (staff web + app) |

Never touched: `db/`, `contracts/`, `packages/*`, any `core/`. The DDL in `05-SCHEMA.md`, the OpenAPI described in §5 and the event/permission/route/error additions are delivered by C0 from this spec.

## 2. Stack and libraries

| Concern | Choice | Source |
|---|---|---|
| API | Fastify module, routes from `contracts/openapi/homecollection.yaml` via `fastify-openapi-glue` 4.12.0 | 04 T7; 02-CV §2.2 |
| Worker | Graphile Worker 0.18.0 via worker core | 04 S10, T7 |
| DB | PostgreSQL 17 (`supabase/postgres:17.6.1.136`), schema `homecollection` | 04 D9 |
| Staff web | Next.js App Router, server-only BFF, `@lims/ui` only | 04 S4; 02-CV §2.4, §14 |
| Flutter / Dart SDK | C0 pins | 02-CV §1.1 |
| State management | Riverpod (`flutter_riverpod`), C0 pins | C0 02-TRD §2.2 |
| API client | `lims_api_client` (openapi-generator `dart-dio` v7.27.0 output) | 04 T8 |
| Offline store | `drift` **2.35.3** on `package:sqlite3` ≥3.x with its **SQLCipher** build-hook option (SQLite3MultipleCiphers is the allowed alternative; C0 picks one at pin time and records it). `sqlcipher_flutter_libs` is banned | 04 A15, T7; 02-CV §1.1, §15.3; research 05 (sqlite3 3.8.0, 2026-10-23, "On all native platforms, you can also use SQLite3MultipleCiphers or SQLCipher") |
| Secure storage | `flutter_secure_storage`, C0 pins | 04 A15; REQ-SEC-102 |
| Shared Dart | `lims_shared` (`uuidv7.dart`, `bsdate.dart`, `money.dart`, `errors.dart`), `lims_ui` | C0 02-TRD §3.4, 04-UI-UX §8 |
| Camera scanning | `LimsBarcodeScanner` (lims_ui); package candidate `mobile_scanner`, licence/maintenance/network-egress checked by C0 at pin time (UNVERIFIED) | C0 02-TRD §2.2 |
| HID scanner | Bluetooth keyboard-wedge scanners via a text field with burst detection (same semantics as `@lims/ui` BarcodeInput §2.4) — no dependency | DECISION |
| Biometric / device-credential prompt (04 A16) | Flutter plugin to be pinned by C0 (**CR-C17-010**; candidate `local_auth`, UNVERIFIED in 04). The pin is a **hard precondition** of HC-T23 and of any app release; there is no fallback gate (08 A19 D-127) | REQ-SEC-110 |
| OS hand-offs (`tel:`, maps) | Flutter plugin to be pinned by C0 (**CR-C17-010**; candidate `url_launcher`, UNVERIFIED in 04) | D-MAPS |
| GPS point capture | Flutter plugin to be pinned by C0 (**CR-C17-010**; candidate not named in 04 — C0 proposes). Until pinned, `capture_gps` is forced off | REQ-ARCH-069 |
| Monotonic clock, boot id, root heuristics, FLAG_SECURE | small in-app platform channels (`apps/phlebo_app/android`, `ios`), no dependency | DECISION |

### 2.1 Dependencies table (02-CV §15.1; filled at pin time by the PR that adds each)

| Name | Exact version | Licence | Purpose | Last release | Alternatives |
|---|---|---|---|---|---|
| drift | 2.35.3 | (C0 records) | offline DB | 2026-10-23 (research 05) | PowerSync/Electric banned for v1 (02-CV §15.3) |
| sqlite3 (Dart) | C0 pins ≥3.x | (C0 records) | SQLite + SQLCipher hook | 3.8.0 2026-10-23 (research 05) | — |
| others | C0 pins (CR-C17-010) | | | | |

Banned here: `sqlcipher_flutter_libs`, any Firebase/FCM/Crashlytics/analytics SDK, any map SDK, any RASP SDK that phones home (02-CV §15.3 "foreign SaaS SDKs"; 04 §11).

## 3. Module architecture

### 3.1 API module `services/api/src/modules/homecollection/`

```
index.ts                         ModuleManifest { name:'homecollection', openapi:'contracts/openapi/homecollection.yaml',
                                   handlers, ports: {} (owns no port), produces: ['homecollection.collection.synced.v1'] }
permissions.ts                   homecollection.visit.read|visit.assign|sync.upload (+ CR-C17-008: handover.receive,
                                   device.manage, settings.manage); billing.payment.record / lab.specimen.collect are NOT checked here
config.ts                        LIMS_HOMECOLLECTION_* env keys (§11.1)
handlers/<operationId>.ts        one per operation in §5 (thin: authz → service → mapper)
service/
  visit.service.ts               create (booking/order/revisit/recollection), schedule, assign (order creation), unassign,
                                   cancel, flags, missed sweep
  route.service.ts               upsert route, resequence, version bump (rule §4.1)
  snapshot.service.ts            build/compare snapshot, cursor, demographics/balances/specimens assembly, access log
  sync.service.ts                push pipeline (validate → dedupe → order → apply → emit), ack, sign-off
  conflict.service.ts            per-mutation guards (server-wins) → outcome
  collection.service.ts          held review apply/discard
  handover.service.ts            record (from mutation; copies barcode + specimen type onto items, 08 A19 D-125), confirm (staff;
                                   enqueues homecollection.flag_handover_discrepancy)
  device.service.ts              register, wipe request, status
  clock.service.ts               capture-time correction (§7.5) — pure functions in domain/clock.ts, IO-free
  specimen.service.ts            read model upsert + LabPort refresh
  settings.service.ts
domain/
  visit.ts  visit.state.ts       state table §03-APP-FLOW 1.1 (pure)
  mutation.ts                    mutation type registry, payload validators (mirrors spec oneOf)
  conflict.ts                    pure guard functions returning Outcome
  clock.ts                       correction + plausibility (pure)
  cursor.ts                      cursor encode/decode/compare (pure)
  handover.state.ts  collection.state.ts
repository/
  visits.repo.ts routes.repo.ts assignments.repo.ts specimens.repo.ts mutations.repo.ts batches.repo.ts
  collections.repo.ts handovers.repo.ts devices.repo.ts flags.repo.ts locations.repo.ts settings.repo.ts
  bookingRefs.repo.ts reasons.repo.ts (global seeds `g_cs_reasons` only — 08 A19 D-130)
events/publish.ts                publishCollectionSynced(tx, …)
mappers/                         visit.dto.ts (staff vs phlebotomist field lists), snapshot.dto.ts, handover.dto.ts, device.dto.ts
__tests__/{unit,integration,contract,probes}/
```

Layer rules per 02-CV §2.2: no SQL outside `repository/`; ports called only from `service/`; every transaction via `ctx.db.tx`.

### 3.2 Worker `services/worker/src/jobs/homecollection/`

```ts
export const manifest: WorkerManifest = {
  module: 'homecollection',
  tasks: {
    'homecollection.sweep_missed_visits': sweepMissedVisits,
    'homecollection.flag_overdue_handovers': flagOverdueHandovers,
    'homecollection.purge_locations': purgeLocations,
    'homecollection.purge_retention': purgeRetention,                  // review m#25; calls the §4.2 DEFINER of 05-SCHEMA
    'homecollection.refresh_visit_specimens': refreshVisitSpecimens,   // enqueued by consumers when the port must be called
    'homecollection.flag_handover_discrepancy': flagHandoverDiscrepancy, // enqueued by H15 (08 A19 D-125)
  },
  subscriptions: {
    'engagement.booking.confirmed.v1': onBookingConfirmed,
    'engagement.booking.cancelled.v1': onBookingCancelled,
    'frontdesk.order.created.v1': onOrderCreated,
    'lab.specimen.status_changed.v1': onSpecimenStatusChanged,
    'lab.specimen.rejected.v1': onSpecimenRejected,
  },
  crontab: [ /* §10 — every entry tenantScope: 'per_tenant' (08 A13 P-6) */ ],
  systemPermissions: ['homecollection.visit.read', 'homecollection.visit.assign'],
};
```
All five subscriptions are in 03-IC §3.25 for C17. Consumer files `consumers/<event_type>.ts` (dots kept).

### 3.3 Staff web

```
apps/web/src/app/(staff)/homecollection/
  dispatch/page.tsx  loading.tsx  error.tsx          board (route staff.homecollection.dispatch — CR-C17-009)
  visits/[visit_id]/page.tsx loading.tsx error.tsx   detail (route staff.homecollection.visit — 03-IC §7)
  handovers/page.tsx …                               (staff.homecollection.handovers — CR-C17-009)
  devices/page.tsx …                                 (staff.homecollection.devices — CR-C17-009)
  settings/page.tsx …                                (staff.homecollection.settings — CR-C17-009)
apps/web/src/features/homecollection/
  nav.manifest.ts   server/<operationId>.server.ts   components/   hooks/   forms/   help/   __tests__/
```
Live refresh of the board: polling through the BFF every 30 s [CONV] (02-CV §2.4; no browser Realtime).

### 3.4 Flutter app `apps/phlebo_app/`

```
lib/main.dart                         flavours dev/staging/prod; no secrets (REQ-SEC-107)
lib/app/                              router (routes.yaml ids phlebo_app.visit, phlebo_app.route), LimsTheme
lib/core/
  session/        session_store.dart (flutter_secure_storage), auth_api.dart (C2 mobile sessions, CR-C17-004),
                  token_guard.dart (refresh-before-call, §7.4), reauth_gate.dart (04 A16)
  db/             keys.dart (DB keys in secure storage), cache_db.dart, outbox_db.dart (drift + SQLCipher), wipe.dart
  sync/           sync_engine.dart (pull/push/ack loop), cursor.dart, clock_anchor.dart, backoff.dart
  platform/       monotonic_clock.dart, boot_id.dart, integrity.dart (root heuristics), secure_screen.dart
  net/            pinned_http.dart (SecurityContext with pinned CA set, REQ-SEC-104), api_factory.dart
  config/         remote_config.dart (from snapshot.config)
lib/features/
  login/ route/ visit/ identity/ consent/ collect/ payment/ outcome/ handover/ outbox/ settings/
    each: data/ (drift DAOs + repositories) domain/ (pure models, visit_flow.state.dart) presentation/ (lims_ui widgets)
test/  integration_test/
```

## 4. Domain model summary

| Entity | Table (05-SCHEMA) | Key facts |
|---|---|---|
| Visit | `homecollection.visits` | state machine §03-APP-FLOW 1.1; centre-scoped; `order_id` set at assignment (booking) or at creation (front-desk order) |
| Route | `homecollection.routes` | one per (centre, phlebotomist membership, route date); `version` drives the snapshot cursor |
| Assignment history | `homecollection.visit_assignments` | append-only; used by the "assignee at capture time" guard |
| Expected specimens | `homecollection.visit_specimens` | read model (event + port refresh) for the board and H2; barcode **not** stored here — the snapshot (A2) and the push (A3) take barcodes only from a `LabPort.lookupSpecimens` call made in that request (review #2) |
| Mutation | `homecollection.mutations` | append-only copy of every pushed mutation with its outcome |
| Collection | `homecollection.collections` | one row per collection mutation; `applied` / `held` / `discarded`; at most one `applied` per specimen |
| Handover | `homecollection.handovers`, `handover_items` | custody hand-off; `pending` → `confirmed` / `discrepancy`; items carry their own `barcode` + `specimen_type_code` so the receiving centre never reads visit tables (08 A19 D-125) |
| Device | `homecollection.devices` | install-level registry; wipe command |
| Flag | `homecollection.visit_flags` | dispatcher work items |

### 4.1 Route version rule (review #10)

Every committed change to a visit whose `route_id` is set — schedule (H5: window, address, landmark, coordinates, note, `unset`), status change, outcome, `order_registered_at`, cancellation stub, and any `visit_specimens` read-model change for that visit — increments that route's `version` in the **same transaction** (`route.service.bumpVersion(tx, routeId)`). A reassignment bumps both the old and the new route. The snapshot cursor (§6.2 step 3) is built from route versions, so this rule is what makes the phone see the change on its next pull. Unit test: each listed write without a version bump fails a repository-level assertion; integration test: H5 on an assigned visit changes the next snapshot.

## 5. Endpoints (`contracts/openapi/homecollection.yaml`, prefix `/v1/homecollection`)

Common to every row (02-CV §4): `additionalProperties: false`; no `null`; `bearerJwt`; snake_case; problem+json; `limit` default 50 max 200; every operation may also return `400 common.validation_failed`, `401 auth.unauthenticated|auth.token_invalid|auth.token_expired|auth.session_expired`, `403 auth.forbidden`, `404 common.not_found` (object ops), `429 common.rate_limited`, `500 common.internal`. Rate tier `general` for all (02-CV §10.3). Actions on versioned resources require `If-Match` (`428 common.precondition_required`, `409 common.version_conflict`). "Idem" = `x-idempotency`. App endpoints (A*) additionally return `426 homecollection.app_version_unsupported` and `409 homecollection.device_not_registered` (CR-C17-007) and read header `X-Lims-App-Version` (semver ≤ 20 chars) and `X-Lims-Device-Id` (UUIDv7). The header `X-Lims-Device-Id` must equal every `device_id` in the path (A5), query (A2) or body (A1, A3, A4), and `app_version` in the A1 body must equal `X-Lims-App-Version`; a mismatch → `400 common.id_mismatch` before any other check (review m#28). `common.validation_failed` is always `400` with a JSON pointer in `errors[]` (08 A13 P-1). Idempotency (02-CV §4.5, 08 A13 P-8): **required** on H3, H5, H6, H7, H9, H15, H17, A1 and A3 (creates, or side effects such as flags, SMS and enqueued jobs — review m#26); optional on the other POSTs. Port `idempotencyKey` inputs built by C17 (`<visit_id>:order`, `<route_id>:<route_version>:assigned`, `<visit_id>:scheduled:<version>`) match the port-key grammar `^[A-Za-z0-9_.:-]{1,200}$` (08 A19 P-40). Staff names in responses (`*_display`, `display_name`) come from `ctx.core.memberships.list({ membershipIds })` (batched, memoised per request) and `ctx.core.user` for user ids such as `created_by` (08 A17 P-17).

### 5.1 Staff operations

| # | operationId | Method + path | Permission | Idem | Request | Response | Errors (beyond common) |
|---|---|---|---|---|---|---|---|
| H1 | `listHomeVisits` | GET `/visits` | `homecollection.visit.read` | none | query: `route_date` (date), `window_from`/`window_to` (IsoUtc), `status` (csv of visit statuses), `centre_id`, `phlebotomist_membership_id`, `unassigned_only` (bool), `has_open_flags` (bool), `kind` (csv), `sort` ∈ `window_start,-window_start,route_sequence,created_at,-created_at`, `limit`, `cursor` | page of `VisitSummaryDto`; `patient_display_name` from **one** `FrontdeskPort.getPatientDemographicsBatch({patientIds, purpose:'home_visit'})` call per page (review m#34) | `common.invalid_cursor` |
| H2 | `getHomeVisit` | GET `/visits/{visit_id}` | `homecollection.visit.read` | none | — | `VisitDetailDto` (no phone; see H21); writes one access-log row `home_visit.view`, purpose `visit_detail` (review #18) | `homecollection.visit_not_assigned` (phlebotomist-only actors, §5.4) |
| H3 | `assignHomeVisit` | POST `/visits/{visit_id}/assign` | `homecollection.visit.assign` | **required** | `{ phlebotomist_membership_id: Uuid, route_date: date, route_sequence?: int 1..60 }` | `VisitDetailDto` | `homecollection.visit_closed`, `homecollection.visit_incomplete`, `homecollection.phlebotomist_not_eligible`, `400 common.validation_failed` pointer `/phlebotomist_membership_id` when the route already has `max_visits_per_route` active visits **or** the phlebotomist's active visits on `route_date` across all routes would exceed `LIMS_HOMECOLLECTION_SNAPSHOT_MAX_VISITS` (60; 08 A19 D-131), propagated `frontdesk.consent_required`, `frontdesk.booking_already_converted`, `frontdesk.patient_duplicate_suspected`, `catalog.test_inactive`, `catalog.no_price` |
| H4 | `unassignHomeVisit` | POST `/visits/{visit_id}/unassign` | `homecollection.visit.assign` | optional | `{ reason_code: Code (x-coded-set homecollection.unassign_reasons), reason_text?: ≤500 }` | `VisitDetailDto` | `homecollection.visit_closed`; `409 homecollection.mutation_superseded` if the visit is `in_progress` |
| H5 | `scheduleHomeVisit` | POST `/visits/{visit_id}/schedule` | `homecollection.visit.assign` | **required** (review m#26) | `{ window_start: IsoUtc, window_end: IsoUtc, address?: { address_text: 1..500, landmark?: ≤200, latitude?: DecimalString (−90..90, 6 dp), longitude?: DecimalString (−180..180, 6 dp) }, note_for_phlebotomist?: ≤500, unset?: ['note_for_phlebotomist'\|'landmark'\|'coordinates'] }`; `latitude` and `longitude` both or neither (review m#31) | `VisitDetailDto`; route version bump when assigned (§4.1) | `homecollection.visit_closed`; `400 common.validation_failed` (end ≤ start, span > 12 h, window more than 30 days ahead [CONV], only one of latitude/longitude) |
| H6 | `cancelHomeVisit` | POST `/visits/{visit_id}/cancel` | `homecollection.visit.assign` | **required** (review m#26) | `{ reason_code (homecollection.visit_cancel_reasons), reason_text?: ≤500 }` | `VisitDetailDto` | `homecollection.visit_closed`; `409 homecollection.mutation_superseded` if `in_progress` (cancel → flag instead, §03-APP-FLOW) |
| H7 | `createHomeRevisit` | POST `/visits/{visit_id}/revisits` | `homecollection.visit.assign` | **required** | `{ reason_code (homecollection.revisit_reasons), reason_text?: ≤500 }` | `201 VisitDetailDto` (new visit) | `409 homecollection.visit_closed` if the parent is not `failed` or `completed` with `outcome=partial`, or the parent's order is cancelled (review #4; the parent-state precondition uses the registered 409 code, not `validation_failed`) |
| H8 | `resolveHomeVisitFlag` | POST `/visits/{visit_id}/flags/{flag_id}/resolve` | `homecollection.visit.assign` | optional | `{ resolution_code (homecollection.flag_resolutions), note?: ≤500 }` | `VisitFlagDto` | `409 common.version_conflict` (already resolved) |
| H9 | `reviewHeldCollection` | POST `/collections/{collection_id}/review` | `homecollection.visit.assign` | **required** | `{ decision: apply\|discard, reason_code (homecollection.review_reasons), reason_text?: ≤500 }` | `CollectionDto` | `homecollection.collection_not_held`, `homecollection.mutation_superseded` (apply when the specimen is no longer `ordered` or the order is cancelled), `homecollection.barcode_mismatch` (apply refused for a barcode mismatch) |
| H10 | `listHomeRoutes` | GET `/routes` | `homecollection.visit.read` | none | query `route_date` (required), `centre_id?` | `{ data: RouteDto[] }` (≤ 200 routes, no cursor) | — |
| H11 | `resequenceHomeRoute` | POST `/routes/{route_id}/sequence` | `homecollection.visit.assign` | optional | `{ visit_ids: Uuid[1..60] }` | `RouteDto` | `400 common.validation_failed` (set ≠ route's active visits) |
| H12 | `listEligiblePhlebotomists` | GET `/phlebotomists` | `homecollection.visit.assign` | none | query `centre_id` (required), `route_date?` | `{ data: [{ membership_id, display_name, route_id?, active_visits, route_full }] }` — `route_full: true` when that route has `max_visits_per_route` active visits or the phlebotomist's active visits on `route_date` across routes reached `LIMS_HOMECOLLECTION_SNAPSHOT_MAX_VISITS` (the two H3 refusals) [CONV: one flag for both, so the UI never offers an assignment that H3 refuses] (review m#27); without `route_date`, `route_full` = false | — |
| H13 | `listHandovers` | GET `/handovers` | `homecollection.handover.receive` (CR-C17-008) | none | query `status` (csv pending,confirmed,discrepancy), `to_centre_id?`, `handed_over_from`/`_to`, `limit`, `cursor` | page of `HandoverSummaryDto` | — |
| H14 | `getHandover` | GET `/handovers/{handover_id}` | `homecollection.handover.receive` | none | — | `HandoverDetailDto` (items incl. barcode, specimen type) — reads **only** `handovers` / `handover_items` (08 A19 D-125) | — |
| H15 | `confirmHandover` | POST `/handovers/{handover_id}/confirm` | `homecollection.handover.receive` | **required** (review m#26) | `{ items: [{ specimen_id, received: bool }] (1..50, exactly the handover's items), note?: ≤500 }` | `HandoverDetailDto`; writes only `handovers` / `handover_items`; with ≥ 1 `missing` item it enqueues `homecollection.flag_handover_discrepancy` `{tenant_id, handover_id}` (job_key `flag_handover_discrepancy:<handover_id>`) in the same transaction instead of inserting `visit_flags` (08 A19 D-125) | `409 common.version_conflict` (not `pending`) |
| H16 | `listPhleboDevices` | GET `/devices` | `homecollection.device.manage` (CR-C17-008, privileged) | none | query `status?`, `membership_id?`, `limit`, `cursor` | page of `DeviceDto` | — |
| H17 | `requestDeviceWipe` | POST `/devices/{device_id}/wipe` | `homecollection.device.manage` | **required** (review m#26) | `{ reason_code (homecollection.wipe_reasons), reason_text?: ≤500 }` | `DeviceDto` | `409 common.version_conflict` (already wiped) |
| H18 | `getHomecollectionSettings` | GET `/settings` | `homecollection.settings.manage` (CR-C17-008, privileged) | none | — | `SettingsDto` | — |
| H19 | `updateHomecollectionSettings` | PUT `/settings` | `homecollection.settings.manage` | optional | full mutable subset of `SettingsDto` (§11.2) | `SettingsDto` | `400 common.validation_failed` (ranges; a `payment_methods[].code` outside the C4 global seed set — 08 A19 D-128; `notify_patient_on_assign = true` before CR-C17-014 is merged — D-129; `second_identifier = birth_date` before CR-C17-003 is merged) |
| H20 | `listHomecollectionReasons` | GET `/reasons` | `homecollection.visit.read` | none | query `set` (enum of the sets in 05-SCHEMA §2) | `{ data: [{ code, display, requires_text, is_active }] }` — global seeds only (08 A19 D-130) | — |
| H21 | `revealHomeVisitPhone` | POST `/visits/{visit_id}/phone-reveal` | `homecollection.visit.assign` | optional (creates no state; the only write is the access-log row) | `{}` | `{ phone_e164?: string }` (absent when the patient has no phone) from `FrontdeskPort.getPatientDemographics({patientId, purpose:'home_visit'})`; writes access-log `home_visit.view`, purpose `phone_reveal` (review #18) | propagated `auth.forbidden` |

### 5.2 App operations (phlebo_app)

| # | operationId | Method + path | Permission | Idem | Request | Response |
|---|---|---|---|---|---|---|
| A1 | `registerPhleboDevice` | POST `/devices` | `homecollection.sync.upload` | **required** | `{ device_id: Uuidv7, platform: android\|ios, os_version: ≤40, app_version: ≤20, model?: ≤80 }` | `201 DeviceDto` (or 200 on replay / same device re-registered by the same membership); a `device_id` already bound to **another** membership → `409 homecollection.device_not_registered` (review #12) |
| A2 | `getSyncSnapshot` | GET `/sync/snapshot` | `homecollection.sync.upload` (floor, 08 A19 P-43) + `homecollection.visit.read` checked in the handler with `IdentityPort.assertRole` (08 A13 P-10; both are held by the `phlebotomist` role) | none | query `device_id` (required), `cursor?` (≤ 512) | `SnapshotDto` (§6.2) |
| A3 | `pushSyncMutations` | POST `/sync/mutations` | `homecollection.sync.upload` | **required** (key = `batch_id`) | `PushRequest` (§6.3) | `PushResponse` (§6.3) |
| A4 | `ackSync` | POST `/sync/ack` | `homecollection.sync.upload` | optional | `{ device_id, cursor: ≤512, applied_at_device: IsoUtc, max_device_seq_acked: int ≥0, wipe_completed?: bool }` | `204` |
| A5 | `signOffPhleboDevice` | POST `/devices/{device_id}/sign-off` | `homecollection.sync.upload` | optional | `{ last_device_seq: int ≥0 }` | `204` / `409 homecollection.unsynced_changes` |

Device-id binding: A2–A5 require `devices.membership_id = actor.membershipId` and `status ∈ {active, wipe_requested}` (A5 also `signed_off` → no-op 204). Else `409 homecollection.device_not_registered`.

### 5.3 DTOs (exact fields)

- `VisitSummaryDto`: `id, version, kind (booking|front_desk|recollection|revisit), status, outcome? (collected|partial|none), centre_id, branch_id, order_id?, patient_id, patient_display_name, window_start?, window_end?, route_id?, route_date?, route_sequence?, phlebotomist? {membership_id, display_name}, area_hint? (first 60 chars of address_text — staff only), open_flag_kinds: string[], specimens_summary {expected, collected, held, received, rejected}, last_device_ack_at?`
- `VisitDetailDto` = summary + `booking_id?, parent_visit_id?, registration_no? (from FrontdeskPort.getOrderSummary), address {address_text, landmark?, latitude?, longitude?}?, note_for_phlebotomist?, status_reason_code?, status_reason_text?, assigned_at?, arrived_at?, completed_at?, cancelled_at?, specimens: [{specimen_id, specimen_type_code, container_code?, status, collected_at?, collection_status? (applied|held|discarded), scan_method?, barcode_verified?}], collections: [CollectionDto], flags: [VisitFlagDto], assignments: [{membership_id, display_name, route_date, assigned_at, assigned_by_display}], transitions: [{from?, to, at, actor_display, reason_code?}], payments: [{client_mutation_id, method_code, amount: Money, captured_at, outcome}], balance? {balance_due: Money, as_of}`
- `CollectionDto`: `id, version, visit_id, specimen_id, client_mutation_id, status, hold_code?, scan_method, barcode_verified, collected_at, collected_by {membership_id, display_name}, review? {decision, reason_code, reason_text?, by_display, at}`
- `VisitFlagDto`: `id, version, kind, status (open|resolved), created_at, detail_code?, resolved_at?, resolution_code?, resolved_by_display?`
- `RouteDto`: `id, version, centre_id, route_date, phlebotomist {membership_id, display_name}, visit_ids_in_order, active_visits, completed_visits, last_snapshot_at?, last_ack_at?`
- `HandoverSummaryDto`: `id, version, status, from {membership_id, display_name}, to_centre_id, handed_over_at, item_count, received_count?`
- `HandoverDetailDto` = summary + `items: [{specimen_id, visit_id, barcode, specimen_type_code, outcome? (received|missing)}], received_by_display?, received_at?, note?` — every item field comes from `handover_items` itself (no visit window, 08 A19 D-125)
- `DeviceDto`: `id, version, membership_id, display_name, platform, os_version, app_version, model?, status (active|signed_off|wipe_requested|wiped), registered_at, last_seen_at?, last_snapshot_at?, last_push_at?, max_device_seq_received, wipe_requested_at?, wiped_at?`
- `SettingsDto`: §11.2 keys + `version`.

#### 5.3.1 Sync DTO field tables (review #17)

Required = present on every instance; "if" = present exactly under the stated condition (expressed with `if`/`then` in the spec, 08 A13 P-5); optional = may be absent. No field is ever `null` (02-CV §4). C0 writes the `additionalProperties: false` schemas from these tables.

`SnapshotDto` (A2 response)

| Field | Type | Presence |
|---|---|---|
| `server_time` | IsoUtc | required |
| `cursor` | string ≤ 512 | required |
| `unchanged` | boolean | required |
| `device_command` | `none` \| `wipe` | required |
| `balances` | `BalanceItem[]` (≤ 60) | required (empty when `unchanged = false`; the balances then sit on each visit) |
| `route_date` | date | if `unchanged = false` |
| `config` | `SnapshotConfig` (the §6.2 example keys: `sync_interval_seconds`, `offline_purge_hours`, `capture_gps`, `map_handoff_enabled`, `manual_barcode_entry_allowed`, `second_identifier`, `collection_consent_text_version`, `collection_consent_text`, `payment_methods[]`, `reasons{visit_fail_reasons[], specimen_not_collected_reasons[]}`, `handover_centres[]`, `min_app_version` — all required inside `config`) | if `unchanged = false` |
| `routes` | `{route_id, centre_id, version}[]` | if `unchanged = false` |
| `visits` | `(SnapshotVisit \| SnapshotStub)[]` (≤ 60, `oneOf` by `status`) | if `unchanged = false` |

`SnapshotVisit` (status `assigned` \| `in_progress` \| `completed` \| `failed`)

| Field | Type | Presence |
|---|---|---|
| `visit_id`, `version`, `route_id`, `route_sequence`, `status`, `kind` | as §5.3 | required |
| `window_start`, `window_end` | IsoUtc | if the visit has a window (always for assigned visits, V5 guard) |
| `order_id` | Uuidv7 | required (assigned visits always have one, `visits__order_when_active__ck`) |
| `outcome` | `collected` \| `partial` \| `none` | if `status ∈ {completed, failed}` |
| `patient` | `{ full_name, phone_e164?, birth_on? }` — `phone_e164` if on file; `birth_on` only if `second_identifier = birth_date` | if `status ∈ {assigned, in_progress}` and demographics succeeded |
| `patient_unavailable` | `true` | if `status ∈ {assigned, in_progress}` and demographics failed (then `patient` is absent) |
| `address` | `{ address_text, landmark? , latitude?, longitude? }` (coordinates both or neither) | if `status ∈ {assigned, in_progress}` |
| `note_for_phlebotomist` | string ≤ 500 | if set and `status ∈ {assigned, in_progress}` |
| `specimens` | `{ specimen_id, barcode, specimen_type_code, container_code?, status }[]` | required (`[]` for closed visits and when `specimens_stale`) |
| `specimens_stale` | `true` | if `lookupSpecimens` failed for this visit (review #2) |
| `balance` | `BalanceItem` without `visit_id` | if `status ∈ {assigned, in_progress}` and the balance read succeeded |
| `balance_unavailable` | `true` | if `status ∈ {assigned, in_progress}` and the balance read failed |

`SnapshotStub` (status `cancelled`): `visit_id`, `version`, `route_id`, `route_sequence`, `status: 'cancelled'`, `kind` required; `window_start`/`window_end` if set. No patient, address, note, specimens or balance.

`BalanceItem`: `{ visit_id: Uuidv7, balance_due: Money, as_of: IsoUtc }`, all required.

`PushRequest` (A3 body): `device_id`, `batch_id` (Uuidv7), `sent_at_device` (IsoUtc), `anchors` (`Anchor[]`, 0..20), `now` (`{device_wall_time: IsoUtc, monotonic_ms: int ≥ 0, boot_id: string 1..64}`), `mutations` (`Mutation[]`, 1..100) — all required. `Anchor`: `anchor_id`, `server_time`, `device_wall_time`, `monotonic_ms`, `boot_id`, all required.

`Mutation`: `client_mutation_id` (Uuidv7), `device_seq` (int ≥ 1), `type`, `captured` (`{device_wall_time, anchor_id, elapsed_since_anchor_ms: int}` all required), `payload` (per-type object, §6.3 table) — required; `visit_id` required for every type except `handover.recorded`, where it is absent (`if`/`then` on `type`).

`PushResponse`: `server_time`, `batch_id`, `results` (`PushResult[]`, same order as the request), `handover_items` (`HandoverItemResult[]`, `[]` when no handover in the batch), `device_command` — all required. `PushResult`: `client_mutation_id`, `device_seq`, `outcome` required; `code` if `outcome ∈ {held, rejected}`, or if `outcome = duplicate` and the stored outcome had a code. `HandoverItemResult`: `handover_id`, `specimen_id`, `outcome` (`included` \| `skipped_not_collected` \| `skipped_already_handed_over`), all required.

Field allowlists (REQ-SEC-081): `patient_display_name`, `address`, `registration_no` only for actors holding `homecollection.visit.assign` or the visit's current assignee; never in list responses to phlebotomist-only actors for visits not assigned to them (§5.4).

### 5.4 Authorization rules beyond `x-permission`

1. Every handler first loads the object through the RLS-scoped repository (404 if invisible), then `IdentityPort.assertRole(ctx, {permission, centreId: visit.centre_id})` (02-CV §10.1).
2. **Assignee restriction:** an actor holding `homecollection.sync.upload` but not `homecollection.visit.assign` ("phlebotomist-only") gets H1 filtered to `assigned_membership_id = actor.membershipId` and H2 → `403 homecollection.visit_not_assigned` for any other visit. All A* endpoints only ever expose the actor's own visits.
3. Handovers (H13–H15): visible when `to_centre_id` (or `centre_id`) is in the actor's centre scope (RLS policies on `handovers` / `handover_items`, 05-SCHEMA §4.1 (2)); `assertRole` uses `centreId: handover.to_centre_id`. Receivers need no membership in the home-collection centre: H14 reads only `handovers` / `handover_items` (barcode and specimen type are copied there when `handover.recorded` is applied), and H15 writes only those two tables and enqueues `homecollection.flag_handover_discrepancy` for the `visit_flags` rows (08 A19 D-125; review #1).
4. Body ids vs path ids must match (`400 common.id_mismatch`); the device-id header vs path/query/body and the A1 `app_version` vs header follow the same rule (§5 preamble, review m#28); bulk lists (H11 `visit_ids`, H15 `items`) with a foreign id → `404 common.not_found` for the whole request (sets are exact-match, not per-id best effort).

## 6. Sync protocol (04 S17, A7; REQ-ARCH-066/067/069/070)

### 6.1 Principles

| # | Rule |
|---|---|
| S-1 | **Two channels only**: pull = full snapshot of the actor's routes for *today* (tenant timezone, `IdentityPort.getTenantSettings(['timezone'])`); push = append-only mutations. No delta merge on the device, no tombstones: the device replaces its whole read-only cache atomically on every changed snapshot [DECISION — the dataset is ≤ 60 visits; full replace removes a whole class of merge bugs]. |
| S-2 | **Mutations are facts, never edits.** Each has a client UUIDv7 `client_mutation_id` (`lims_shared/uuidv7.dart`), a per-device monotonic `device_seq`, a type, an immutable payload, and is applied **at most once** server-side (unique `(tenant_id, client_mutation_id)`). |
| S-3 | **Server wins.** The server decides each mutation's outcome (`applied`, `duplicate`, `held`, `rejected`); the device never overrides server state. Held facts go to human review (D-SERVERWINS). |
| S-4 | **No token grace** (04 A7): the device refreshes before calling if the access JWT expires within 60 s [CONV]; on `401 auth.token_expired` it refreshes and retries the **byte-identical** request body with the same Idempotency-Key (the body is frozen when the batch is formed, 05-SCHEMA B.2 invariant 3 — review #3); if refresh fails, the user logs in again and the queue survives (REQ-ARCH-070). |
| S-5 | **Push before pull.** Each sync cycle: refresh the session (rotating LIMS session token, 08 R10) if needed → push all pending (in `device_seq` order, batches of ≤ 100) → pull snapshot → ack. A pull never discards pending mutations. |
| S-6 | **Clock**: the server is the time authority; device times are corrected with monotonic anchors (§7.5). |

### 6.2 Pull — `GET /v1/homecollection/sync/snapshot?device_id=…&cursor=…`

Server algorithm (`snapshot.service.ts`), one read transaction:
1. Device binding + app version check (§5.2).
2. `today = local date in tenant tz`; routes = `routes WHERE tenant_id = $t AND phlebotomist_membership_id = actor AND route_date = today` (may be >1 when the phlebotomist serves 2 home-collection centres). The total of active visits is ≤ `LIMS_HOMECOLLECTION_SNAPSHOT_MAX_VISITS` because H3 refuses assignments past it (08 A19 D-131); the snapshot never truncates.
3. `cursor_now = base64url(JSON{v:1, d: today, r: [[route_id, route_version]…sorted], s: settings.version, w: device.status})`. Opaque to the device.
4. If `cursor == cursor_now` → `{ unchanged: true, cursor, server_time, balances: [...], device_command }` where balances = `BillingPort.getOrderBalance` for each visit with `order_id` and status `assigned|in_progress`.
5. Else build visits: all visits on those routes with status `assigned|in_progress|completed|failed`, plus visits that were assigned to this route and are now `cancelled` (stub; V11 keeps `route_id`/`route_date`/`route_sequence`, review m#39). For the non-stub, non-closed visits: **one** `FrontdeskPort.getPatientDemographicsBatch({patientIds, purpose:'home_visit'})` call (review m#34; a patient missing from the result → that visit gets `patient_unavailable: true`); per visit `LabPort.lookupSpecimens({orderId, statuses:['ordered']})` (→ `readonly SpecimenRef[]`) — called on **every** changed snapshot, barcodes taken only from this result and never persisted (review #2); `BillingPort.getOrderBalance`. On a `lookupSpecimens` error the visit is returned with `specimens: []` and `specimens_stale: true`; the device shows "Tubes unavailable — refresh before collecting" and disables Collect for that visit. There is **no** fallback to the `visit_specimens` read model in the snapshot (it holds no barcodes). Closed visits (`completed|failed`) carry no patient fields, only status/outcome. Each port call that may fail without failing the snapshot runs inside `ctx.db.tx(…)` (savepoint, 08 A19 P-44).
6. For each visit returned with patient fields: `ctx.audit.access({ action: 'home_visit.view', entityType: 'home_visit', entityId: visitId, purpose: 'home_visit_snapshot', outcome: 'success' })` (action code per 08 §4.4).
7. Update `devices.last_snapshot_at`, `routes.last_snapshot_at`.

`SnapshotDto`:
```json
{
  "server_time": "2026-11-06T00:30:00.000Z",
  "cursor": "eyJ2IjoxLCJkIjoiMjAyNi0xMS0wNiIsInIiOltbIjAxYTFhOThhLi4uIiw0XV0sInMiOjIsInciOiJhY3RpdmUifQ",
  "unchanged": false,
  "route_date": "2026-11-06",
  "device_command": "none",
  "config": {
    "sync_interval_seconds": 300, "offline_purge_hours": 16, "capture_gps": false, "map_handoff_enabled": true,
    "manual_barcode_entry_allowed": true, "second_identifier": "phone",
    "collection_consent_text_version": "hc-consent-v1", "collection_consent_text": "I agree to give a blood sample …",
    "payment_methods": [ { "code": "cash", "display": "Cash", "requires_reference": false },
                         { "code": "fonepay_qr", "display": "Fonepay QR", "requires_reference": true } ],
    "reasons": { "visit_fail_reasons": [ { "code": "patient_not_home", "display": "Patient not at home" } ],
                 "specimen_not_collected_reasons": [ { "code": "unable_to_draw", "display": "Unable to draw" } ] },
    "handover_centres": [ { "centre_id": "01a1a98a-ac40-7000-8000-000000020002", "name": "Synthetic Centre A2" } ],
    "min_app_version": "1.0.0"
  },
  "routes": [ { "route_id": "01a1a98a-ac40-7000-8000-000000170001", "centre_id": "01a1a98a-ac40-7000-8000-000000020009", "version": 4 } ],
  "visits": [
    { "visit_id": "01a1a98a-ac40-7000-8000-000000130001", "version": 3, "route_id": "01a1a98a-ac40-7000-8000-000000170001",
      "route_sequence": 1, "status": "assigned", "kind": "booking",
      "window_start": "2026-11-06T01:15:00.000Z", "window_end": "2026-11-06T01:45:00.000Z",
      "order_id": "01a1a98a-ac40-7000-8000-000000050002",
      "patient": { "full_name": "Test Patient 0042", "phone_e164": "+9779800000042" },
      "address": { "address_text": "House 12, Synthetic Tole, Ward 4", "landmark": "Near the blue gate" },
      "note_for_phlebotomist": "Fasting sample",
      "specimens": [ { "specimen_id": "01a1a98a-ac40-7000-8000-000000090011", "barcode": "E2600000042",
                       "specimen_type_code": "EDTA_WB", "container_code": "LAV_3ML", "status": "ordered" } ],
      "balance": { "balance_due": { "amount_paisa": 180000, "currency": "NPR" }, "as_of": "2026-11-06T00:30:00.000Z" } }
  ],
  "balances": []
}
```
`device_command` ∈ `none | wipe` (wipe only when `devices.status = wipe_requested`). `handover_centres` = `ctx.core.centres({ kinds: ['own','franchise'], activeOnly: true })` (CR-C17-013; C0 `centre_kind` values, review m#22) — ids and names only.

### 6.3 Push — `POST /v1/homecollection/sync/mutations`

`PushRequest`:
```json
{
  "device_id": "01a1a98a-ac40-7000-8000-0000001b0001",
  "batch_id": "01a1a98a-ac44-7000-8000-0000001c0001",
  "sent_at_device": "2026-11-06T02:39:58.000Z",
  "anchors": [ { "anchor_id": "01a1a98a-ac41-7000-8000-0000001d0001", "server_time": "2026-11-06T00:30:00.000Z",
                 "device_wall_time": "2026-11-06T00:29:41.000Z", "monotonic_ms": 86400123, "boot_id": "b-0000000017" } ],
  "now": { "device_wall_time": "2026-11-06T02:39:58.000Z", "monotonic_ms": 94198123, "boot_id": "b-0000000017" },
  "mutations": [
    { "client_mutation_id": "01a1a98a-ac42-7000-8000-0000001a0001", "device_seq": 41, "type": "specimen.collected",
      "visit_id": "01a1a98a-ac40-7000-8000-000000130001",
      "captured": { "device_wall_time": "2026-11-06T01:26:41.000Z", "anchor_id": "01a1a98a-ac41-7000-8000-0000001d0001",
                    "elapsed_since_anchor_ms": 3401000 },
      "payload": { "specimen_id": "01a1a98a-ac40-7000-8000-000000090011", "scanned_barcode": "E2600000042",
                   "scan_method": "camera", "specimen_type_code": "EDTA_WB",
                   "gps": { "status": "off" } } }
  ]
}
```
Limits: `mutations` 1..100 (`LIMS_HOMECOLLECTION_PUSH_MAX_MUTATIONS`), body ≤ 512 KB (`LIMS_HOMECOLLECTION_PUSH_MAX_BYTES`) → `413 common.payload_too_large`; `anchors` ≤ 20; `device_seq` strictly increasing inside the batch (else `400 common.validation_failed`).

Mutation types and payloads (spec: `oneOf` with `discriminator.propertyName: type` and explicit `mapping`, 02-CV §4.12):

| `type` | `visit_id` | Payload fields (all required unless `?`) |
|---|---|---|
| `visit.arrived` | yes | `gps` |
| `visit.identity_checked` | yes | `name_check: matches|mismatch`, `second_identifier: phone|birth_date`, `second_check: matches|mismatch` |
| `visit.consent_recorded` | yes | `consent_text_version: ≤40`, `given: bool` |
| `specimen.collected` | yes | `specimen_id`, `scanned_barcode` (`^[A-Z0-9]{1,20}$`), `scan_method: camera|hid|manual`, `specimen_type_code: Code`, `gps` |
| `specimen.not_collected` | yes | `specimen_id`, `reason_code: Code`, `reason_text?: ≤200` |
| `payment.captured` | yes | `order_id`, `payment_method_code: Code`, `amount: Money` (1..50,000,000 paisa [CONV]), `reference?: ≤100` |
| `visit.completed` | yes | `outcome: collected|partial` |
| `visit.failed` | yes | `reason_code: Code`, `reason_text?: ≤200`, `gps` |
| `handover.recorded` | no | `handover_id: Uuidv7`, `to_centre_id`, `specimen_ids: Uuid[1..50]` |

`gps` = `{ status: off|denied|unavailable|ok, latitude?: DecimalString, longitude?: DecimalString, accuracy_m?: int 0..10000 }` (coordinates only when `ok`).

`PushResponse` (always 200 when the envelope is valid):
```json
{ "server_time": "2026-11-06T02:40:00.000Z", "batch_id": "01a1a98a-ac44-7000-8000-0000001c0001",
  "results": [ { "client_mutation_id": "01a1a98a-ac42-7000-8000-0000001a0001", "device_seq": 41,
                 "outcome": "applied", "code": null } ],
  "handover_items": [ { "handover_id": "…", "specimen_id": "…", "outcome": "included|skipped_not_collected|skipped_already_handed_over" } ],
  "device_command": "none" }
```
(`code` omitted, not `null`, when absent — the example shows the slot only.) `outcome` ∈ `applied | duplicate | held | rejected`; `code` ∈ errors.yaml codes (`homecollection.mutation_superseded`, `homecollection.visit_not_assigned`, `homecollection.barcode_mismatch`, `homecollection.visit_closed`, `common.idempotency_key_reused`, `common.validation_failed`, `common.not_found`). Field presence: §5.3.1.

Server pipeline (`sync.service.ts`), **one transaction per batch**:
1. Validate envelope (spec), device binding, app version, header/body device-id equality (§5).
2. Compute corrected times (§7.5) from the envelope's clock inputs. A replay of the same key never reaches this step (core idempotency hook, step 7).
3. `LabPort.lookupSpecimens({orderId})` once per distinct order touched by the batch, including the orders of the collections named in `handover.recorded` mutations (the `{orderId}` form is the one open to `homecollection.visit.read` holders, 03-IC §4.5; the `{specimenIds}` form needs `lab.specimen.read`, which phlebotomists lack); a port error fails the whole batch with `503 common.dependency_unavailable` and nothing is committed (the device retries the same frozen body).
4. For each mutation in `device_seq` order (review #14 — SELECT, then guard, then INSERT with the outcome; `mutations` is append-only, no UPDATE grant):
   1. `payload_sha256` = SHA-256 (hex) of the RFC 8785 (JCS) canonical JSON of `payload`, computed by the server; any device-side hash is local only and is not sent (review m#38).
   2. `SELECT outcome, outcome_code, payload_sha256 FROM homecollection.mutations WHERE tenant_id = $t AND client_mutation_id = $id`. Found → equal hash: outcome `duplicate` with the **stored** code in `code`; different hash: `rejected` + `common.idempotency_key_reused`. Not found → continue.
   3. Visit missing or invisible (RLS) for a type with `visit_id` → `rejected` + `common.not_found`; the mutation is **not** inserted (no visit row to reference, `mutations.visit_id` FK) and is recorded in `sync_batches.unresolved_mutations` (ids, type, seq — no payload); a later resend is evaluated again, not answered `duplicate` (review #7).
   4. Run the guard for the type (03-APP-FLOW §4) → outcome and code.
   5. `INSERT INTO homecollection.mutations (…, outcome, outcome_code) VALUES (…) ON CONFLICT (tenant_id, client_mutation_id) DO NOTHING RETURNING id`. No row returned (a concurrent push inserted it) → re-read it and answer as in 4.2. `centre_id` = the visit's centre; for `handover.recorded` = the centre of the included collections, which must all share one centre (else the mutation is `rejected` + `common.validation_failed`) (review #7).
   6. Write the effects referencing the new mutation id (collections, transitions, handovers + items, flags, GPS row with `expires_at = captured_at + gps_retention_days`). For `handover.recorded`, each included item gets `barcode` and `specimen_type_code` from the step-3 `lookupSpecimens` result (08 A19 D-125).
5. Per visit with ≥ 1 newly `applied` `specimen.collected` or `payment.captured` → `events.publish(tx, 'homecollection.collection.synced.v1', …)` (§8.1).
6. Insert the `sync_batches` row (`id = batch_id`, clock inputs, final counts, `unresolved_mutations`) — once, at the end, because the table is append-only (class A, no UPDATE grant); `mutations__batch__fk` is `DEFERRABLE INITIALLY DEFERRED` so the earlier mutation inserts may reference it (05-SCHEMA §4). Then `devices.max_device_seq_received = greatest(existing, max seq in batch)`, `last_push_at`; route version bumps per §4.1.
7. Commit. The HTTP idempotency hook (C0 core, 02-CV §4.5) stores the response under `batch_id`. The same key with a different request hash → `422 common.idempotency_key_reused` for the whole batch; the device then re-forms the batch under a new `batch_id` (§7.2).

Concurrency: the transaction takes `SELECT … FOR UPDATE` on every touched visit row in ascending id order [CONV] (deadlock avoidance); a concurrent dispatcher action waits or gets `409 common.version_conflict`.

### 6.4 Ack — `POST /v1/homecollection/sync/ack`

Records that the device durably replaced its cache with snapshot `cursor` and processed outcomes up to `max_device_seq_acked`: updates `devices.last_ack_at`, `last_ack_cursor`, `routes.last_ack_at` for routes in the cursor (board shows "Phone has latest route since hh:mm" — lets the dispatcher see that a cancellation reached the phlebotomist). `wipe_completed: true` → device `wiped`, `wiped_at`.

## 7. Offline design (device)

### 7.1 Storage layout

| Store | Content | Lifetime |
|---|---|---|
| `flutter_secure_storage` (Keystore/Keychain) | `device_id` (generated before the first login = C2 `app_instance_id`), `outbox_owner_user_id` (review #12), `cache_db_key` (32 random bytes, hex), `outbox_db_key` (32 bytes), `session_token` (opaque, 256-bit, rotating — 08 R10), `access_expires_at`, `session_expires_at` (no GoTrue refresh token on the device) | until sign-off / wipe |
| memory only | access JWT | process lifetime |
| `cache.db` (SQLCipher, key `cache_db_key`) | read-only snapshot (05-SCHEMA B.1) | replaced each changed pull; destroyed on logout, revoke, offline purge, date rollover, wipe |
| `outbox.db` (SQLCipher, key `outbox_db_key`) | mutation log, frozen batch bodies (`batches`, review #3), clock anchors, device counters (05-SCHEMA B.2) | rows deleted 24 h after terminal outcome [CONV]; file destroyed only at sign-off or wipe |

Destruction = delete the key from secure storage **first** (crypto-shred), then close and delete the DB file + `-wal`/`-shm` files. Keys are generated with `Random.secure()`; they never leave secure storage except into the SQLCipher `PRAGMA key` at open.

The outbox deliberately holds **no names, phones or addresses** — only ids, barcodes, codes, amounts, timestamps and optional GPS points — so a revoke-purge of `cache.db` leaves the minimum on the device (REQ-SEC-103 "cache minimized").

### 7.2 Sync engine loop

Triggers: app foreground, every `sync_interval_seconds` (default 300 [CONV]) while foreground, 2 s after a new mutation [CONV], manual pull-to-refresh. No background sync when the app is not in foreground [DECISION — OS background execution limits; avoids network use with the phone locked]. Backoff on network/5xx: 5 s, 15 s, 45 s, 2 min, 5 min cap [CONV], reset on success. One cycle at a time (mutex). Push retries re-send the stored batch body byte for byte (05-SCHEMA B.2 invariant 3). On `422 common.idempotency_key_reused` for a push, the device discards the stored body, gives the rows a new `batch_id` and re-sends; per-mutation dedupe on `client_mutation_id` makes this safe (review #3).

### 7.3 Device-side visit flow guard

`visit_flow.state.dart` (pure): Arrived → Identity (both matches) → Consent (given) → Collect → Payment (optional; skipped when balance due = 0 and no payment entered) → Complete | Fail (from any step). The device writes a mutation at each step; it derives UI state only from `cache.db` + `outbox.db` (never stores derived state).

### 7.4 Auth on the device (CR-C17-004)

1. Login (online only): the device id `phlebo.device_id` is generated (UUIDv7) **before** the first login and kept until sign-off or wipe. Email + password → C2 `openMobileSession({ email, password, app_instance_id: phlebo.device_id, app_platform: 'android'|'ios' })` (POST `/v1/identity/mobile/sessions`, kind `staff_mobile`; C2 02-TRD §5.1) → {session_token (opaque, 256-bit), access_token, access_expires_at, session_expires_at, session}; session token to secure storage, access JWT in memory; then `registerPhleboDevice` (idempotent) (review #8). **Outbox owner binding** (review #12): while `outbox.db` has non-terminal rows, the login is accepted only when the session's user id equals `phlebo.outbox_owner_user_id` (stored at the first login on this outbox); another user sees "This phone has unsent changes from another user. Ask that user to sign in, or the lab admin to wipe it." and the app closes that session with `logoutMobileSession`. A1 for a device id bound to another membership answers `409 homecollection.device_not_registered`; with an empty outbox the app then closes the session, destroys the outbox and its key, generates a new device id and asks for the login again (05-SCHEMA B.3).
2. Before any API call: if `access_expires_at − now < 60 s` → `refreshMobileSession` (POST `/v1/identity/mobile/sessions/refresh` with `session_token`; the session token rotates on every refresh with reuse detection in C2 — 08 R10) → store the new session token **before** using the new access token.
3. Refresh result `auth.session_expired` (revoked, reuse detected, absolute timeout) → destroy `cache.db`, keep `outbox.db`, show login. Network error → stay offline, keep working locally.
4. Re-auth gate (04 A16): on resume after > 300 s in background → OS biometric or device-credential prompt; device without a screen lock → login refused ("Set a screen lock on this phone first") [DECISION]; 5 failed prompts → treat as session end (step 3). The gate needs the plugin pinned by CR-C17-010; that pin is a hard precondition of HC-T23 and of any app release, and there is **no** fallback to an online password login after background (08 A19 D-127).
5. Logout (sign-off, US-13-2): `signOffPhleboDevice` succeeds → C2 `logoutMobileSession({ session_token })` (POST `/v1/identity/mobile/sessions/logout`) → destroy `cache.db` + key, then `outbox.db` + key, regenerate `phlebo.device_id`, clear `phlebo.outbox_owner_user_id` (review #8).

### 7.5 Clock handling

- **Anchors**: after every successful API response the device stores `anchor = {anchor_id (UUIDv7), server_time (body.server_time), device_wall_time, monotonic_ms, boot_id}`. Monotonic = Android `SystemClock.elapsedRealtime()` (said to include deep sleep — **UNVERIFIED**, no research citation; spike in HC-T24); iOS equivalent via platform channel — **UNVERIFIED** which iOS clock includes sleep; until a spike confirms it, iOS anchors are treated as valid only within the same app process [DECISION]. `boot_id` = Android `Settings.Global.BOOT_COUNT` (**UNVERIFIED**, spike in HC-T24); iOS kernel boot time — UNVERIFIED (review m#36).
- **Capture**: each mutation records `device_wall_time`, the latest `anchor_id`, `elapsed_since_anchor_ms = monotonic_now − anchor.monotonic_ms`.
- **Server correction** (`domain/clock.ts`):
  1. If the anchor is in the batch (or stored from a previous batch of this device) and the batch `now.boot_id` = anchor `boot_id` and `elapsed ≥ 0` → `corrected = anchor.server_time + elapsed`, `clock_source = 'anchor'`.
  2. Else if any anchor exists → `corrected = device_wall_time + (anchor.server_time − anchor.device_wall_time)` of the most recent anchor, `clock_source = 'offset'`.
  3. Else `corrected = device_wall_time`, `clock_source = 'device'`.
  4. Plausibility: clamp `corrected` into `[visit.assigned_at − clock_tolerance_seconds, server receipt time]` (default tolerance 600 s [CONV]); if clamped → `clock_suspect = true` (shown on visit detail).
- Stored: raw `captured_at_device`, `captured_at` (corrected), `clock_source`, `clock_suspect`. Events carry the **corrected** value in `collected_at_device` / `captured_at_device` (**CR-C17-006** clarifies the field meaning); C5 still clamps to `synced_at` (C5 PRD AC-03.2).
- Skew metric: `device_wall_time − corrected` → `lims_homecollection_clock_skew_seconds`.

### 7.6 Platform targets

Android 10+ staff-managed phones [ASSUMPTION]; iOS builds compile but ship only after the UNVERIFIED iOS items above and pinning on iOS are confirmed.

## 8. Events

### 8.1 Produced — `homecollection.collection.synced.v1` (payload exactly 03-IC §3.23)

| Aspect | Value |
|---|---|
| Trigger | commit of (a) a push transaction that applied ≥ 1 `specimen.collected` or `payment.captured` for the visit (one event per visit per batch), or (b) a `reviewHeldCollection` apply (one event, collections only) — (b) is the trigger clarification in **CR-C17-006** |
| Aggregate | `home_visit`, id = visit id, `seq` = visit `version` after the transaction |
| Idempotency key | `<visit_id>:sync:<hex sha256 of the sorted client_mutation_ids in this event>` |
| Payload mapping | `visit_id`; `order_id` = visit.order_id; `booking_id` = visit.booking_id, present **iff** the visit has `kind = 'booking'` (optional field, not in `required`, condition via `if`/`then` — 08 A19 D-120, A13 P-5; consumers C4, C5 and C16 tolerate it); `phlebotomist_membership_id` = mutation author's membership (all mutations in one event share the author — a batch comes from one device/membership); `synced_at` = transaction time; `collections[]` = applied collections: `client_mutation_id`, `specimen_id`, `barcode_verified` (= scan_method ∈ {camera, hid} and match), `collected_at_device` (corrected); `payments[]` = applied payments: `client_mutation_id`, `payment_method_code`, `amount`, `captured_at_device` (corrected), `reference` (**CR-C17-006**, optional) |
| Limits | ≤ 50 collections, ≤ 10 payments per event (03-IC); a batch exceeding either for one visit is split into several events with disjoint mutation sets (each has its own key) |
| PHI class | P1 (no names, no GPS, no barcode) |
| Consumers | C4 (ledger), C5 (specimen states), **C16** (completes the `home_collection` booking on the first event carrying its `booking_id` — 08 A19 D-120) |
| Actor | `{type:'user', id: sub, membership_id}` of the device user (review apply: the dispatcher) |

### 8.2 Consumed (02-CV §7.4: inbox first; duplicates no-op; stale seq ignored)

| Event | Behaviour |
|---|---|
| `engagement.booking.confirmed.v1` | C17 is the only order creator for home-collection bookings — the order is created at assignment (H3), C4's consumer ignores `home_collection` (08 R7). Ignore unless `booking_kind = home_collection`; if `booking_refs` has `state = cancelled` with `last_seq ≥ aggregate.seq` → ignore; else create visit (US-01) with `idempotency` on unique `(tenant_id, booking_id)`; call `EngagementPort.getHomeAddress` (CR-C17-005; system actor; access log `home_visit.view`, 08 §4.14 — no `engagement.v_pub_*` view, 08 R25) inside `ctx.db.tx(…)` (savepoint, 08 A19 P-44) — failure → `address_missing` flag, never fails the consumer; upsert `booking_refs (confirmed, seq, visit_id)` |
| `engagement.booking.cancelled.v1` | ignore unless `home_collection`; visit by `home_visit_id` or `booking_id`: none → `booking_refs` cancelled; `unassigned` → `cancelled`; `assigned` → `cancelled` (+ `order_cancel_required` flag when `order_id` set; route version++; `route_id`/`route_date`/`route_sequence` kept for history, the route's active set excludes cancelled visits — review m#39); every cancellation stores `status_reason_code = 'booking_cancelled'` (C17 `visit_cancel_reasons`) and the event's `reason_code` in `status_reason_text` (review m#32; extensible engagement code, never validated against C17 codes — 08 A13 P-4); `in_progress`/`completed` → flag `cancel_requested_after_start`; `failed`/`cancelled` → nothing. The finance/front-desk review of an order that was already registered is C4's `frontdesk.order_flags` kind `booking_cancelled_after_registration` (raised by C4's own `booking.cancelled` consumer; 08 R7, A2.12); C17 adds no `billing.finance_review_items` kind and only opens its own `order_cancel_required` visit flag |
| `frontdesk.order.created.v1` | `collection_mode = home` ∧ `source = front_desk` → create `front_desk` visit (unique `(tenant_id, order_id) WHERE kind = 'front_desk'`); `source = home_collection` → set `order_registered_at` on visit `source_ref_id`; enqueue `homecollection.refresh_visit_specimens` for that visit; else ignore |
| `lab.specimen.status_changed.v1` | if a visit with `order_id = payload.order_id` exists (any status, `created_at` within 30 days [CONV]) → upsert `visit_specimens` for every such visit where `aggregate.seq` > stored `last_seq`; bump route version for visits on a route; specimen with `from_status` absent and `replaces_specimen_id` → new row, old row stays |
| `lab.specimen.rejected.v1` | if `recollection_required` and a visit exists (`home_visit_id`, else latest visit of `order_id`) → create `recollection` visit, unique `(tenant_id, recollection_of_specimen_id)`; flag `recollection_required` |

### 8.3 Ordering hazards

- Booking cancel before confirm: `booking_refs.last_seq` (03-IC §3.24 ordering note).
- Specimen events before the visit exists (staff path: C5 and C17 both consume `order.created`): the consumer drops them; `refresh_visit_specimens` (port) fills the read model when the visit is created and again at assign / pull / board open.

## 9. Ports

### 9.1 Implemented
None (C17 owns no port; CM §5.1).

### 9.2 Consumed

| Port | Method (03-IC signature) | Where | Failure handling |
|---|---|---|---|
| `IdentityPort` | `assertRole(ctx, {permission, centreId})`, `getActor(ctx)`, `getTenantSettings(ctx, {keys: ['timezone','retentionYears','channels']})` | every handler; snapshot | propagate `auth.*` |
| `FrontdeskPort` | `createOrderFromBooking(ctx, input: BookingOrderInput)` | H3 (booking visits without order) | propagate (assign fails atomically); `replayed: true` accepted |
| | `getPatientDemographicsBatch(ctx, {patientIds, purpose: 'home_visit'})` (≤ 200 ids) → fullName, phoneE164, consents (+ birthOn/sex, CR-C17-003) | A2 (one call per changed snapshot), H1 (one call per page) — review m#34 | snapshot: a patient missing from the result, or a failed call, → those visits are returned without `patient` and with `patient_unavailable: true` [DECISION — one failure must not block the route]; board: name shown as "—" |
| | `getPatientDemographics(ctx, {patientId, purpose: 'home_visit'})` | H2 display name, H21 phone reveal | H2: name "—"; H21: propagate |
| | `getOrderSummary(ctx, {orderId})` | H2 (registration no, order status `cancelled` check for H9 apply) | propagate |
| `BillingPort` | `getOrderBalance(ctx, {orderId})` | A2 balances, H2 | balance omitted on error (`balance_unavailable: true`) |
| `LabPort` | `lookupSpecimens(ctx, {orderId, statuses?})` → `readonly SpecimenRef[]` (CR-C17-002 merged into CR-C10-003; users need `homecollection.visit.read` + C17 assignment check) | H3 and board/H2 (read-model refresh when `refreshed_at` is older than `LIMS_HOMECOLLECTION_SPECIMEN_REFRESH_SECONDS`), A2 (every changed snapshot), A3 (barcode + status guard; barcode/specimen type copied onto `handover_items`), H9 | A3: on port error the batch fails `503 common.dependency_unavailable` (device retries); A2: the visit is returned with `specimens: []` and `specimens_stale: true`, Collect disabled on the device — no read-model fallback (review #2); board/H2: last read model shown with its `refreshed_at` |
| `NotificationPort` | `sendSms(ctx, {recipient: {kind:'staff', membershipId}, purpose:'visit_assignment', templateCode:'homecollection.visit_assigned', params:{route_date, visit_count}, idempotencyKey:'<route_id>:<route_version>:assigned', related:{entityType:'visit', entityId}})` when `notify_phlebotomist_on_assign` — template seeded by C6 per 08 A13 D-34; staff recipients stay `suppressed_no_contact` in Phase 1, so **no assignment SMS is sent in Phase 1** (08 A19 D-129); `sendSms(ctx, {recipient:{kind:'patient', patientId}, purpose:'booking_confirmation', templateCode:'homecollection.visit_scheduled', params:{window_start_local, window_end_local}, idempotencyKey:'<visit_id>:scheduled:<version>', related:{entityType:'visit', entityId}})` when `notify_patient_on_assign` — template requested by **CR-C17-014** (params `short_text`, no lab-name parameter); the switch cannot be turned on until CR-C17-014 is merged (H19) | H3 | inside `ctx.db.tx(…)` (savepoint, 08 A19 P-44); a thrown error or a `suppressed_*` status is logged and never fails the assign |
| `EngagementPort` | `getHomeAddress(ctx, {homeAddressId, purpose:'home_visit'})` (**CR-C17-005**) | booking consumer | §8.2 |

Not consumed: `PaymentProviderPort` (CM §5.1 lists C4, C16 only), `CatalogPort` (C17 not a listed consumer; the board shows specimen types, not test names).

## 10. Background jobs

All cron entries are `tenantScope: 'per_tenant'` (08 A13 P-6): one job per active/suspended tenant per tick, run under that tenant's claims for the `homecollection` system actor; times are Asia/Kathmandu (08 A13 P-15).

| Task / cron | Schedule | Behaviour | Retries |
|---|---|---|---|
| `evt.homecollection.*` consumers | on event | §8.2 | 10 (02-CV §7.5) |
| `homecollection.refresh_visit_specimens` | enqueued (`job_key = refresh:<visit_id>`) | `LabPort.lookupSpecimens({orderId})` → upsert read model (no barcode); route version++ when assigned (§4.1) | 10 |
| `homecollection.flag_handover_discrepancy` | enqueued by H15 (`job_key = flag_handover_discrepancy:<handover_id>`, payload `{tenant_id, handover_id}`) | system actor: for each `handover_items` row with `outcome = 'missing'`, insert flag `handover_discrepancy` (`related_id` = handover id) on its visit, `ON CONFLICT DO NOTHING` (open-flag unique index); route version++ (08 A19 D-125) | 10 |
| `homecollection.sweep_missed_visits` | daily 00:20, `per_tenant` [CONV time] | `assigned` visits with `route_date < today` (tenant business date, P-15): if the visit's route has `last_snapshot_at` on its `route_date` (a phone holds it) → open flag `missed`, visit stays `assigned` until the dispatcher acts (H4 unassign is still blocked once an applied mutation exists); otherwise → `unassigned` + `visit_assignments` row `missed` + flag `missed` (08 A19 D-126; review #11) | 5 |
| `homecollection.flag_overdue_handovers` | every 30 min [CONV], `per_tenant` | applied collections without a handover item older than `handover_overdue_hours` → flag `handover_overdue` (unique open flag per visit) | 5 |
| `homecollection.purge_locations` | daily 02:40 [CONV], `per_tenant` | system actor: `DELETE FROM homecollection.visit_locations WHERE tenant_id = $t AND expires_at < now()` under `visit_locations__delete__tenant_centre` (08 A17 P-18(c); not a DEFINER). `expires_at = captured_at + gps_retention_days` is set at insert; this is the only purge predicate (review m#25) | 5 |
| `homecollection.purge_retention` | 1st of month 03:10 [CONV] (review m#25), `per_tenant` | `SELECT * FROM app.homecollection_anonymise_retired_visits(now() − retentionYears)` (`retentionYears` from `IdentityPort.getTenantSettings`): anonymises address/landmark/coordinates/note/reason text of closed visits and the copied `handover_items.barcode` (05-SCHEMA §4.2; B15; rows kept, never DELETE of class C/A rows) | 5 |

Crontab entries live in `cron.ts` (REQ-ARCH-042).

## 11. Configuration

### 11.1 Global env (`config.ts`)

| Key | Default | Meaning |
|---|---|---|
| `LIMS_HOMECOLLECTION_PUSH_MAX_MUTATIONS` | 100 [CONV] | per batch |
| `LIMS_HOMECOLLECTION_PUSH_MAX_BYTES` | 524288 [CONV] | body cap |
| `LIMS_HOMECOLLECTION_SNAPSHOT_MAX_VISITS` | 60 [CONV] (confirmed by 08 A19 D-131) | cap on one phlebotomist's active visits across all routes of a `route_date`; enforced by H3 (`400 common.validation_failed`, pointer `/phlebotomist_membership_id`); the snapshot never truncates |
| `LIMS_HOMECOLLECTION_SPECIMEN_REFRESH_SECONDS` | 60 [CONV] | staleness of the `visit_specimens` read model for the board / H2 / H3 only; the snapshot always calls the port (review #2) |
| `LIMS_HOMECOLLECTION_ACCESS_JWT_SKEW_SECONDS` (app build constant) | 60 [CONV] | refresh-before threshold |

### 11.2 Per tenant (`homecollection.settings`, one row)

| Key | Type / range | Default |
|---|---|---|
| `min_app_version` | semver ≤ 20 | `1.0.0` |
| `sync_interval_seconds` | 60..900 | 300 [CONV] |
| `offline_purge_hours` | 4..24 | 16 [CONV] |
| `capture_gps` | bool | false until CR-C17-010 pins a plugin; then tenant choice |
| `gps_retention_days` | 7..365 | 90 [CONV] |
| `map_handoff_enabled` | bool | **true** (08 A2.5) — tenant operational switch; hand-off approved by the founder 2026-11-06 (address only, device's own maps app; CR-C17-012) |
| `manual_barcode_entry_allowed` | bool | true [CONV] |
| `second_identifier` | `phone` \| `birth_date` | `phone` (birth_date rejected by validation until CR-C17-003 merges) |
| `collection_consent_text_version` | ≤ 40 | `hc-consent-v1` [CONV] |
| `collection_consent_text` | 1..2000 | synthetic placeholder text; tenant must replace before go-live (onboarding checklist) |
| `payment_methods` | 1..10 × `{code, display ≤40, requires_reference}`; `code` ∈ C4's global seed codes {`cash`, `card`, `esewa`, `khalti`, `fonepay_qr`, `bank_transfer`} (C4 05-SCHEMA seed; H19 rejects others with `400 common.validation_failed` — 08 A19 D-128) | `cash`(false), `fonepay_qr`(true), `esewa`(false), `khalti`(false) — `requires_reference` defaults copy C4's seed (`fonepay_qr`, `card`, `bank_transfer` true; `cash`, `esewa`, `khalti` false); a tenant may still tick `requires_reference` for any method |
| `handover_confirmation_required` | bool | true |
| `handover_overdue_hours` | 1..24 | 4 [CONV] |
| `max_visits_per_route` | 1..60 | 40 [CONV] |
| `notify_phlebotomist_on_assign` / `notify_patient_on_assign` | bool | false / false. Phlebotomist SMS: allowed, but staff recipients are `suppressed_no_contact` in Phase 1 (08 A13 D-34), so nothing is sent yet. Patient SMS: H19 rejects `true` until CR-C17-014 (template `homecollection.visit_scheduled`) is merged; the UI switch is disabled (08 A19 D-129) |
| `clock_tolerance_seconds` | 60..3600 | 600 [CONV] |

The re-auth background threshold is fixed at 300 s (04 A16) and is **not** a setting.

## 12. Security-relevant engineering

TLS pinning (REQ-SEC-104): `pinned_http.dart` builds a `SecurityContext(withTrustedRoots: false)` holding only the bundled issuing-CA certificates (current + backup) supplied by C1 per environment (CR-C17-011); no `badCertificateCallback` anywhere (REQ-SEC-105, CI grep). Pin rotation: new app release with the next backup pin ≥ 30 days [CONV] before rotation; `min_app_version` forces the update (REQ-SEC-113). There is no unpinned fallback; the "kill switch" is a release with an updated pin set (trade-off recorded in 07-SECURITY).
Release builds: `--obfuscate --split-debug-info` (REQ-SEC-112), mapping files stored in C1's secret store. FLAG_SECURE on every screen with patient data (REQ-SEC-109) through `LimsSecureScreen`. Text fields `enableSuggestions: false`, `autocorrect: false` (REQ-SEC-111).

## 13. Performance targets (04 §14 assumptions; arithmetic shown)

| Quantity | Arithmetic | Value |
|---|---|---|
| Home visits/day/lab | 500 patients/day (04 §14) × 20 % home share (ASSUMPTION) | 100 |
| At N = 10 labs | 100 × 10 | 1,000 visits/day |
| Phlebotomists | 100 visits ÷ 10 visits/route (ASSUMPTION) | 10/lab, 100 total |
| Pulls | 100 devices × 12/h (300 s interval) | 1,200/h ≈ 0.33 req/s |
| Mutations | 1,000 visits × ~8 mutations | 8,000/day; peak hour 25 % (04 §14) = 2,000/h ≈ 0.56/s |
| Write share of 250 writes/s headroom (04 §14) | push ≈ 0.6 batches/s × ~12 row writes | ≈ 7 writes/s ≈ 3 % |

| Operation | Target p95 [CONV] | Budget reasoning |
|---|---|---|
| A2 unchanged | ≤ 500 ms | ≤ 40 visits × `getOrderBalance` 10 ms (03-IC §4.4) = 400 ms; port calls share the caller's transaction (02-CV §8.1), so they run sequentially — hence the 40-visit route default. A phlebotomist at the 60-visit daily cap (D-131) needs 600 ms: the target is a p95 for the default route size, not for the cap [ASSUMPTION] |
| A2 changed | ≤ 2 s | 1 × `getPatientDemographicsBatch` (≤ 50 ms for ≤ 60 ids — ASSUMPTION, 03-IC §4.3 states no batch latency) + 40 × (balance 10 ms + `lookupSpecimens` ≤ 20 ms — ASSUMPTION: the 20 ms target was in CR-C17-002 and is not stated in 03-IC §4.5; review m#36) = 50 + 1,200 = 1.25 s |
| A3 batch of 20 mutations | ≤ 800 ms | port calls per touched order (≤ 3) + inserts |
| H1 board page of 50 | ≤ 400 ms | 1 × `getPatientDemographicsBatch` for the page (≤ 50 ms, ASSUMPTION as above) + 1 × `ctx.core.memberships.list({membershipIds})` + query ≈ 150 ms (review m#34) |
| H3 assign incl. order creation | ≤ 400 ms | `createOrderFromBooking` 150 ms (03-IC §4.3) + LabPort + writes |
| Consumer per event | ≤ 50 ms | |

## 14. Observability

Logs (02-CV §9): `operation_id`, `tenant_id`, `actor_id`, `visit_id`, `route_id`, `device_id`, `batch_id`, counts, outcomes, `error_code`. **Never**: names, phones, addresses, landmark, notes, barcodes, GPS, payment references, consent text, tokens.

| Metric | Type | Labels |
|---|---|---|
| `lims_homecollection_mutations_total` | counter | `type`, `outcome` |
| `lims_homecollection_push_duration_seconds` | histogram | — |
| `lims_homecollection_snapshot_duration_seconds` | histogram | `changed` |
| `lims_homecollection_held_open` | gauge | `tenant_id` |
| `lims_homecollection_clock_skew_seconds` | histogram | `clock_source` |
| `lims_homecollection_devices_stale_total` | gauge | `tenant_id` (devices with pending seq > received and last_seen > 2 h) |
| `lims_homecollection_handover_overdue_open` | gauge | `tenant_id` |
| `lims_homecollection_events_published_total` | counter | — |

Alerts (registered with C1): held open > 0 for > 4 h; push 5xx rate > 2 % over 15 min; any `evt.homecollection.*` dead letter; clock skew p95 > 30 min (device clock problem fleet-wide); `devices_stale_total` > 0 for > 8 h.

Alert rules for C1 (08 A13 P-14; file `services/worker/src/jobs/homecollection/alerts.yaml`, wired by C1 through one CR). Expressions are [CONV] transcriptions of the list above, using the C0 metric names `lims_http_requests_total{module,operation_id,status}` and `lims_core_dead_letters_total{task}` (C0 02-TRD observability row):

| Alert | expr | for | severity | route |
|---|---|---|---|---|
| `HomecollectionHeldOpen` | `max by (tenant_id) (lims_homecollection_held_open) > 0` | 4h | warning | tenant ops (e-mail) |
| `HomecollectionPush5xx` | `sum(rate(lims_http_requests_total{operation_id="pushSyncMutations",status=~"5.."}[15m])) / sum(rate(lims_http_requests_total{operation_id="pushSyncMutations"}[15m])) > 0.02` | 15m | critical | The LIMS provider on-call |
| `HomecollectionDeadLetter` | `sum(increase(lims_core_dead_letters_total{task=~"evt\\.homecollection\\..*\|homecollection\\..*"}[15m])) > 0` | 0m | critical | The LIMS provider on-call |
| `HomecollectionClockSkew` | `histogram_quantile(0.95, sum by (le) (rate(lims_homecollection_clock_skew_seconds_bucket[1h]))) > 1800` | 1h | warning | The LIMS provider on-call |
| `HomecollectionDevicesStale` | `max by (tenant_id) (lims_homecollection_devices_stale_total) > 0` | 8h | warning | tenant ops (e-mail) |

CI jobs for C0-0A (08 A13 P-14; scripts under `apps/phlebo_app/tool/ci/`, wired by C0-0A through one CR):

| Job id | Trigger paths | Runner OS | Command |
|---|---|---|---|
| `c17-no-bad-cert-callback` | `apps/phlebo_app/**` | linux | `tool/ci/grep_forbidden.sh` (fails on `badCertificateCallback`, `sqlcipher_flutter_libs`, Firebase/FCM/map SDK imports) |
| `c17-db-forensics` | `apps/phlebo_app/lib/core/db/**` | linux (Android emulator) | `flutter test integration_test/db_forensics_test.dart` (DB headers ≠ `SQLite format 3`) |
| `c17-release-binary-scan` | release tags `phlebo-v*` | linux | `tool/ci/scan_apk.sh` (apktool + `strings` + gitleaks rules, REQ-SEC-107) |

Access-log calls (08 A13 P-3; every action is in 03-IC §13.1):

| Operation / path | `action` | `entityType` | `purpose` |
|---|---|---|---|
| A2 `getSyncSnapshot` (each visit returned with patient fields) | `home_visit.view` | `home_visit` | `home_visit_snapshot` |
| H2 `getHomeVisit` | `home_visit.view` | `home_visit` | `visit_detail` |
| H21 `revealHomeVisitPhone` | `home_visit.view` | `home_visit` | `phone_reveal` |
| consumer `engagement.booking.confirmed.v1` (`EngagementPort.getHomeAddress`) | `home_visit.view` | `home_visit` | `home_address_fetch` |

## 15. Test strategy

| Layer | What | Fakes |
|---|---|---|
| Unit (TS) | visit/collection/handover state tables (every allowed + representative forbidden transition); conflict guards (each outcome); clock correction (anchor/offset/device/clamp, reboot); cursor; payload validators; DTO mappers (allowlists per role) | none |
| Unit (Dart) | visit flow guard; barcode match (expected / other visit / unknown / repeat); outbox sequencing; token guard; wipe order (key first); purge triggers; re-auth gate timing | fake clock, fake secure storage |
| Integration (API) | push pipeline on migrated PG 17 with tenant_a/tenant_b; idempotent replays (frozen body replayed; new key → per-mutation `duplicate`); `common.not_found` mutation not stored and re-evaluated on resend; concurrent push vs dispatcher cancel (row lock); event payload validates against schema (with and without `booking_id`, D-120); route version bump for every §4.1 write; H3 daily cap (D-131); H7 parent precondition → `409 homecollection.visit_closed`; handover confirmed by a receiver who is **not** a member of the home-collection centre (H14 shows barcodes, H15 succeeds, the discrepancy flag appears after the worker task — D-125); missed sweep: a pulled route's visit stays `assigned` and an offline upload on day +1 applies cleanly (D-126); H19 rejects a non-seed payment code and `notify_patient_on_assign = true` (D-128, D-129); each port failure that the handler tolerates leaves no marker row after commit (P-44 savepoint test with `failNext`); settings defaults: a lazily created `homecollection.settings` row has `map_handoff_enabled = true` and the sync snapshot `config.map_handoff_enabled` is `true` (08 A2.5); setting it false hides "Navigate" | `FrontdeskPort`, `BillingPort`, `LabPort`, `EngagementPort`, `NotificationPort` fakes from `@lims/fakes` |
| Contract HTTP | every operation vs spec (request + response validation), every `x-error-codes` entry | — |
| Contract events | produced payload validation; consumers: every 03-IC example, unknown extra fields, duplicate delivery, stale seq | — |
| Probes | §07-SECURITY §5 (every endpoint and table) | generator + hand-written |
| Device | integration_test on emulator against Prism mock (5.16.0) of `homecollection.yaml` + C2 mobile session mock: offline visit, kill app mid-batch, airplane-mode push retry, expired token → refresh → same key; forensic check that `cache.db`/`outbox.db` are not SQLite plaintext (`SQLite format 3` header absent) | Prism |
| E2E nightly | booking (fake C16 event) → assign → C4 order → C5 specimens/labels → app collect offline → push → C5 `collected`/`in_transit` → C4 ledger row → handover confirm → C5 receive | compose stack, real C4/C5 when merged |

---

## Change requests raised

> Status per `program/08-CR-REGISTER.md` (2026-11-06). CR texts below are kept as history.

| CR | Status |
|---|---|
| CR-C17-001 | ACCEPTED-MODIFIED in 08 — Single order owner per booking type (R7); C4 cancel consumer resolves `home_collection` links by `home_visit_id`. |
| CR-C17-002 | MERGED in 08 into CR-C10-003 — Use `lookupSpecimens({orderId})`. |
| CR-C17-003 | ACCEPTED in 08 |
| CR-C17-004 | ACCEPTED-MODIFIED in 08 — Kind `staff_mobile`; opaque session token + server-held GoTrue refresh token, same model as patient (R10). |
| CR-C17-005 | ACCEPTED in 08 |
| CR-C17-006 | ACCEPTED in 08 |
| CR-C17-007 | ACCEPTED in 08 |
| CR-C17-008 | ACCEPTED in 08 |
| CR-C17-009 | ACCEPTED in 08 |
| CR-C17-010 | ACCEPTED in 08 |
| CR-C17-011 | ACCEPTED in 08 |
| CR-C17-012 | ACCEPTED in 08 |
| CR-C17-013 | ACCEPTED in 08 |
| 08 Addendum A4/A5 | 08 Addendum A4/A5 applied 2026-11-06 — A5.5: C17 has no HMAC compared for authentication, redemption or phone matching (only content digests `mutations.payload_sha256` / device-outbox `payload_sha256`, which stay hex `text` with a format CHECK per A2.4); nothing changed. Other A4/A5 items: no C17 impact. |
| 08 Addendum A2/A3 | 08 Addendum A2/A3 applied 2026-11-06 — A2.5: `map_handoff_enabled` default **true** (tenant operational switch); A2.12: cancellation after registration reviewed via C4 `frontdesk.order_flags` (`booking_cancelled_after_registration`), no `finance_review_items` kind addition (none existed in C17 docs). A3: no C17 impact. |
| CR-C17-014 | RAISED 2026-11-06 [CONV id, 08 A19 D-129] — C6 seeds `homecollection.visit_scheduled` |
| Review fix pass | Review fix pass 2026-11-06 — review/C17-home-collection.md + 08 Addendum A19 (plus A13 and A17 rules P-1…P-23 that apply to you) applied: D-120, D-125…D-131; P-1, P-3, P-5, P-6, P-8, P-10, P-14, P-15, P-16, P-17, P-18, P-22, P-40, P-41, P-43, P-44, P-46; A16.1 cast |

**08 Addenda applied (08 A25 P-60: one row per addendum A1–A29; final check 2026-11-06)**

| Addendum | Status for C17 |
|---|---|
| A1 | applied 2026-11-06 — addendum rows above (SEC) |
| A2 | applied 2026-11-06 — A2.4, A2.5, A2.12 (PRD, TRD, UI, SCH, PLAN, SEC) |
| A3 | not applicable |
| A4 | applied 2026-11-06 — A4.3 (TRD, PLAN) |
| A5 | applied 2026-11-06 — A5.5 (TRD, PLAN) |
| A6 | not applicable |
| A7 | not applicable |
| A8 | not applicable |
| A9 | not applicable |
| A10 | applied 2026-11-06 — A10.5 (SCH) |
| A11 | applied 2026-11-06 — A11.2 (PRD) |
| A12 | applied 2026-11-06 — A12.2, A12.7 (SCH, PLAN, SEC) |
| A13 | applied 2026-11-06 — P-1, P-2, P-3, P-4, P-5, P-6, P-7, P-8, P-10, P-14, P-15, D-34 (PRD, TRD, UI, SCH, PLAN) |
| A14 | not applicable |
| A15 | not applicable |
| A16 | applied 2026-11-06 — A16.1 (TRD, SCH, SEC) |
| A17 | applied 2026-11-06 — P-16, P-17, P-18, P-22, P-23 (TRD, SCH, PLAN, SEC) |
| A18 | not applicable |
| A19 | applied 2026-11-06 — P-40, P-41, P-43, P-44, P-46, D-120, D-125, D-126, D-127, D-128, D-129, D-130, D-131, A19.4 (PRD, TRD, AF, UI, SCH, PLAN, SEC) |
| A20 | not applicable |
| A21 | not applicable |
| A22 | not applicable |
| A23 | not applicable |
| A24 | not applicable |
| A25 | not applicable |
| A26 | not applicable (A26.3 changes 03-IC / 01-CM only) |
| A27 | not applicable |
| A28 | not applicable |
| A29 | not applicable |


```
Title: CR-C17-001: Home-collection bookings — order created by C17, not by C4's booking consumer
From chunk: C17          To owner: C4 (C0-0C for doc)
Type: event/port behaviour   Blocking? yes for US-01/US-03 end-to-end (not for C17 unit work)
Problem: C4's engagement.booking.confirmed.v1 consumer creates a pre_registered order for every booking
  (C4 TRD §8.2). For booking_kind = home_collection, C17 must register the order at assignment through
  FrontdeskPort.createOrderFromBooking(source 'home_collection', sourceRefId = visit_id, confirmImmediately:true)
  (03-IC X5) so that C5 creates specimens/barcodes for label printing. Both would exist → duplicate order.
  C4's booking.cancelled consumer looks up only the engagement_booking link, so a registered home-visit order
  is never flagged for review.
Proposed: (a) C4 booking.confirmed consumer ignores booking_kind = home_collection (inbox + booking_links
  row state 'delegated' or no row); (b) C4 booking.cancelled consumer also resolves the order through
  booking_links (source 'home_collection', source_ref_id = payload.home_visit_id) and raises
  booking_cancelled_after_registration; (c) createOrderFromBooking with source 'home_collection' authorises
  the caller with homecollection.visit.assign (the dispatcher) instead of frontdesk.registration.create,
  and with billing.invoice.issue waived for the cash invoice it issues; (d) C4 home payment path uses
  payments[].reference (CR-C17-006) when present.
Backward compatible? yes (C16 not affected; no payload change)
Tenant/security impact: none new; same RLS; invoice issued in the dispatcher's name (audit).
IRD impact: invoice issued at assignment (cash mode, D-INVOICE-TIMING in C4 PRD) — cancellations go through
  C4 credit notes; C17 raises order_cancel_required.
Alternatives: C17 confirms C4's pre_registered order through a new FrontdeskPort.confirmPreRegisteredOrder
  method (rejected: needs payments/fingerprint semantics of F12). Fallback if (a) is refused: C17 looks up the
  pre_registered order in frontdesk.v_pub_order_status (source engagement_booking, source_ref_id booking_id)
  and the board links the dispatcher to C4's confirm screen; assignment waits for status registered.
Tests: C4 consumer test (home_collection booking → no order); C17 E2E US-03-3; C4 cancel consumer test.
```

```
Title: CR-C17-002: LabPort.listOrderSpecimens (C17 becomes a LabPort consumer)
From chunk: C17          To owner: C0-0C + C5
Type: port   Blocking? yes for barcode verification (fake meanwhile)
Problem: the app must verify scanned tubes against the order's barcodes; status_changed.v1 carries no barcode
  (P1, 03-IC §3.7) and phlebotomists lack lab.specimen.read; no port method returns specimens with barcodes.
Proposed (contracts/ports/LabPort.ts, additive):
  listOrderSpecimens(ctx: RequestContext, input: { orderId: Uuidv7; statuses?: readonly SpecimenStatus[] }):
    Promise<{ orderId: Uuidv7; specimens: readonly { specimenId: Uuidv7; barcode: string; specimenTypeCode: Code;
      containerCode?: Code; status: SpecimenStatus; isActive: boolean; replacesSpecimenId?: Uuidv7; version: number }[] }>;
  Authz: actor holds lab.specimen.read OR homecollection.visit.read, or is a system actor. Runs under the
  caller's RLS (centre scope). p95 ≤ 20 ms for ≤ 20 specimens. Consumers: C17 (add to CM §5.1).
  Contract tests: other tenant → not_found; centre-scoped actor other centre → not_found; statuses filter;
  inactive specimen listed with isActive=false; recollection specimen has replacesSpecimenId.
Backward compatible? yes. Security: returns P2 barcodes — only to assigned phlebotomists (C17 checks) and staff.
```

```
Title: CR-C17-003: FrontdeskPort 'home_visit' purpose adds birthOn and sex
From chunk: C17          To owner: C0-0C + C4
Type: port   Blocking? no (default second identifier = phone)
Problem: two-identifier patient check (D-IDENT) normally uses date of birth; allowlist gives fullName,
  phoneE164, consents only (03-IC §4.3).
Proposed: home_visit → fullName, phoneE164, consents, birthOn?, sex. Additive allowlist change.
Security: one more P2 field on the device for today's visits only; purged with the cache.
```

```
Title: CR-C17-004: Native staff-app sessions (phlebo_app) in identity
From chunk: C17          To owner: C2 (C0-0C spec, C1 nginx exposure)
Type: api   Blocking? yes for device login (Prism mock meanwhile)
Problem: C2 sessions are BFF-only (/v1/identity/auth/* reachable only from the BFF network, CR-C2-012) and
  every API call requires an identity.sessions row (C2 TRD §4 item 5). A native app needs to hold its own
  refresh token (04 A15, REQ-SEC-102).
Proposed: identity.sessions.kind 'mobile'; operations (tier login):
  POST /v1/identity/mobile/sessions        {email, password, device_id, app: 'phlebo_app'} →
       {access_token, access_expires_at, refresh_token, session_id}   errors as loginStaff
  POST /v1/identity/mobile/sessions/refresh {refresh_token} → rotated pair | 401 auth.session_expired
  POST /v1/identity/mobile/sessions/logout  (bearer) → 204
  Rules: absolute lifetime ≤ 12 h (04 A8 absolute bound); BFF idle timeout not applied (04 A16 local
  re-auth replaces it — DECISION to confirm with C2); revoke via existing revokeSession/revokeUserSessions;
  only memberships holding homecollection.sync.upload may open a 'mobile' session; refresh tokens stored
  encrypted as for BFF sessions. Self-hosted refresh-rotation config is UNVERIFIED (04 A6) — C2 T1 proves it.
Security: new public login surface → same login rate limits (04 §4), breached-password checks apply.
```

```
Title: CR-C17-005: EngagementPort.getHomeAddress (new port, owner C16)
From chunk: C17          To owner: C0-0C + C16
Type: port   Blocking? no (dispatcher enters the address; flag address_missing)
Problem: engagement.booking.confirmed.v1 carries home_address_id only ("consumers resolve via authorised
  calls", 03-IC §3.22) but no port or endpoint exists.
Proposed: contracts/ports/EngagementPort.ts
  getHomeAddress(ctx, input: { homeAddressId: Uuidv7; purpose: 'home_visit' }):
    Promise<{ addressText: string; landmark?: string; latitude?: DecimalString; longitude?: DecimalString }>;
  @throws common.not_found. Consumers: C17. System actors allowed.
```

```
Title: CR-C17-006: homecollection.collection.synced.v1 — optional payment reference; field semantics; trigger
From chunk: C17 (producer)  To owner: C0-0C (C4 consumer agrees)
Type: event   Blocking? no
Proposed (additive, stays .v1): payments[].reference { type: string, minLength 1, maxLength 100 } optional
  (C4 seed marks fonepay_qr/card/bank_transfer requires_reference). Document: collected_at_device /
  captured_at_device carry the server-corrected capture time (TRD §7.5), C5 still clamps; trigger also covers
  a dispatcher "apply" of a held collection (collections only, payments empty).
```

```
Title: CR-C17-007: New homecollection error codes
From chunk: C17          To owner: C0-0C
Type: api   Blocking? no
- { code: homecollection.app_version_unsupported, http: 426, owner: C17, title: "App update required", meaning: "Below tenant min_app_version (REQ-SEC-113)" }
- { code: homecollection.device_not_registered, http: 409, owner: C17, title: "Device not registered", meaning: "Unknown device id or bound to another user" }
- { code: homecollection.visit_incomplete, http: 422, owner: C17, title: "Visit is not ready to assign", meaning: "Address and time window required" }
- { code: homecollection.phlebotomist_not_eligible, http: 422, owner: C17, title: "Phlebotomist cannot take this visit", meaning: "Inactive, other centre, or no phlebotomist role" }
- { code: homecollection.collection_not_held, http: 409, owner: C17, title: "Collection is not awaiting review", meaning: "" }
```

```
Title: CR-C17-008: Permissions for handover, devices, settings; lab_manager read
From chunk: C17          To owner: C0-0C
Type: api   Blocking? no
- { code: homecollection.handover.receive,  privileged: false, roles: [centre_staff, front_desk, lab_technologist], phase: 3 }
- { code: homecollection.device.manage,     privileged: true,  roles: [tenant_admin, lab_manager], phase: 3 }
- { code: homecollection.settings.manage,   privileged: true,  roles: [tenant_admin, lab_manager], phase: 3 }
- homecollection.visit.read roles: add lab_manager (it already holds visit.assign but cannot read the board).
```

```
Title: CR-C17-009: Staff routes for home collection
From chunk: C17          To owner: C0-0C (routes.yaml)
- { id: staff.homecollection.dispatch,  origin: staff_web, path: /homecollection/dispatch,  owner: C17, permission: homecollection.visit.read }
- { id: staff.homecollection.handovers, origin: staff_web, path: /homecollection/handovers, owner: C17, permission: homecollection.handover.receive }
- { id: staff.homecollection.devices,   origin: staff_web, path: /homecollection/devices,   owner: C17, permission: homecollection.device.manage }
- { id: staff.homecollection.settings,  origin: staff_web, path: /homecollection/settings,  owner: C17, permission: homecollection.settings.manage }
```

```
Title: CR-C17-010: Flutter dependencies for phlebo_app
From chunk: C17          To owner: C0-0D (pinning, licence review)
Type: shared-lib   Blocking? partially (biometric gate, tel/maps hand-off, GPS)
Request: pin (exact versions, licence, last release, network-egress check = none):
  biometric/device-credential prompt (candidate local_auth); OS URL hand-off (candidate url_launcher);
  location point capture (candidate chosen by C0, no Google Play-services network dependency preferred);
  confirm mobile_scanner (or alternative) for LimsBarcodeScanner works fully on-device.
  Until pinned: capture_gps forced off.
  [Amended by 08 A19 D-127: the biometric/device-credential pin is a hard precondition of HC-T23 and of any app
   release; the earlier "fall back to full password login after > 5 min background" is deleted — the app is not
   shipped until the pin lands.]
```

```
Title: CR-C17-011: Certificate pin set and rotation runbook for phlebo_app
From chunk: C17          To owner: C1
Type: infra   Blocking? for production release only
Request: per-environment issuing-CA certificates (current + backup) for the API origin, delivered as build
  inputs; rotation runbook with ≥ 30 days lead time; ECDSA P-256 / 90-day ACME per 04 I5 means the pin must be
  on the CA/intermediate, not the leaf.
```

```
Title: CR-C17-012: Founder decision — map hand-off of the patient address (B11)
From chunk: C17          To owner: founder
Problem: "Navigate" passes the address/coordinates to the device's maps app, which may transmit it abroad.
Default: map_handoff_enabled = false. Decision needed per tenant before enabling.
[Superseded: founder approved 2026-11-06; default is now true per 08 A2.5 — still a tenant operational switch.]
```

```
Title: CR-C17-013: ctx.core membership query by centre and role
From chunk: C17          To owner: C0-0D (core repository)
Type: shared-lib   Blocking? no (fake)
Proposed: ctx.core.memberships.list(tx, { centreId, roleCode?, activeOnly: true }) →
  [{ membershipId, displayName, roleCodes, allCentres }]; ctx.core.centres.list(tx, { kinds? }).
  Used for eligibility (H3/H12) and handover centres (snapshot config).
```

```
Title: CR-C17-014: SMS template homecollection.visit_scheduled (08 A19 D-129)
From chunk: C17          To owner: C6 (seed reporting.g_message_templates; 03-IC §4.8 template list, 08 §4.10)
Type: seed   Blocking? no — the tenant switch notify_patient_on_assign stays disabled (H19 rejects true) until merged
Proposed: template homecollection.visit_scheduled — purpose booking_confirmation, channel sms, recipient patient,
  params window_start_local and window_end_local, both kind short_text (08 A4.3); no lab-name parameter.
  Params are non-PHI (04 R6). homecollection.visit_assigned is already seeded per 08 A13 D-34 (staff recipients
  suppressed_no_contact in Phase 1) and is not part of this CR.
Tests (C6): template validates both params as short_text; a third param → reporting.notification_params_invalid.
```
