# C17 Home Collection — 07 Security

Status: DECISION draft, 2026-11-06. REQ-SEC ids cite `research/02-security.md`; numeric values come from 04 §3/§4. REQ-SEC §5 (mobile) applies when the app ships (04 §12 rule); §1, §3, §4, §6, §7 apply to the API/web parts from day one.

## 1. Applicable requirements

| REQ | How it applies here | Where implemented / tested |
|---|---|---|
| REQ-SEC-002 | BOLA is the main risk: phlebotomist ↔ other phlebotomists' visits; centre ↔ centre; tenant ↔ tenant | TRD §5.4; probes §5 |
| REQ-SEC-003 | MASVS control groups for `phlebo_app`; MASTG-based pentest before launch | HC-T29; pre-launch pentest (C1/founder schedule) |
| REQ-SEC-004 | column classification P0–P3 | 05-SCHEMA §3 |
| REQ-SEC-005 | collection consent recorded per visit with text version (D-CONSENT) | `visit.consent_recorded` mutation; guard (3) |
| REQ-SEC-007 | map hand-off approved by the founder 2026-11-06 (CR-C17-012, research/04 §11): device's own maps app via OS intent/URL, address only (no name, tests, phone), no embedded map SDK; `map_handoff_enabled` stays a per-tenant operational switch, default true (08 A2.5); no push services | settings default; TRD §2 banned list |
| REQ-SEC-011..016, 022..024, 026, 027, 031, 039 | ENABLE+FORCE RLS on every table, per-command policies to `lims_app` (centre predicate with the `::uuid[]` cast, 08 A16.1; staff guard `is_staff_or_system()` in every `__tenant` policy, 08 A17 P-16), no DELETE except the class-E `visit_locations` retention delete by the system actor (08 A17 P-18(c)), tenant-leading indexes, composite FKs, explicit tenant filter in repos; one maintenance DEFINER (`app.homecollection_anonymise_retired_visits`) with `TO lims_owner` owner policies gated on `app.maintenance` (08 A19 P-41) | 05-SCHEMA §4.1–§4.2; `db/tests` (C0) |
| REQ-SEC-017 | centre scoping on `centre_id`; handovers and handover items also on `to_centre_id`; receivers never read visit tables (barcode/specimen type copied onto items, discrepancy flags by a worker task — 08 A19 D-125) | 05-SCHEMA §4.1 (2) |
| REQ-SEC-040, 041, 044 | cross-tenant + cross-centre probes for every endpoint/table; id-swap and mixed-id bodies (H11, H15) | §5 |
| REQ-SEC-045, 133 | alert on held spikes, many-visit reads by one user, failed device logins | TRD §14 + C1 rules |
| REQ-SEC-046 | amounts captured in the field are *facts recorded*, never prices: the server never trusts a client price; C4 computes balance; event carries what was collected | D-PAY |
| REQ-SEC-050/051 | `Idempotency-Key` required on assign, schedule, cancel, revisit, review, handover confirm, wipe, device register, push (review m#26); the push body is frozen per batch so a retry never changes the request hash (review #3); per-mutation uniqueness `(tenant, client_mutation_id)`; C4 ledger keyed on `client_mutation_id` | TRD §5–6 |
| REQ-SEC-057 | C17 never writes the ledger; payments are append-only mutations; corrections only in C4 (reversal) | D-PAY |
| REQ-SEC-065, 066 | access JWT ≤ 1 h (04 A5), rotation (04 A6, self-hosted config UNVERIFIED), **no expiry grace** (04 A7) incl. offline uploads | TRD §6.1 S-4, §7.4 |
| REQ-SEC-067 | tenant/membership from server-resolved claims only (C2 claims resolver); device id is never an authority, only a binding checked against the membership | TRD §5.2 |
| REQ-SEC-073, 140 | session revoke (C2) takes effect on the next API call; offboarding = revoke + wipe request | 03-APP-FLOW §5.8 |
| REQ-SEC-078/079 | tier `general` (10 req/s/user, burst 20 — 04 §4); C2 mobile login (`/v1/identity/mobile/sessions`) follows 08 Addendum A1: 10/hour/account + backoff/step-up after 5 failures; per-client-IP **failed**-attempt counter in C2 (≥ 10 failures in 10 min → 5 attempts/min for 30 min + alert); nginx flood guard 60 req/min/IP (burst 20); no static-IP dependency | spec `x-rate-limit-tier` |
| REQ-SEC-080 | strict schemas, `additionalProperties:false`, mutation `oneOf` with discriminator, payload size cap 8 KB per mutation, 512 KB per batch | TRD §6.3; 05-SCHEMA `mutations__payload__ck` |
| REQ-SEC-081 | per-role DTO allowlists; snapshot excludes test names, registration no, DOB (unless CR-C17-003 and setting) | TRD §5.3; mapper tests |
| REQ-SEC-082 | parameterised SQL only | lint |
| REQ-SEC-095 | problem+json without internals | C0 core |
| REQ-SEC-096/097 | data changes audited by C0 triggers; access-log `home_visit.view` for every snapshot visit with patient fields, for every H2 visit-detail read (purpose `visit_detail`) and for every phone reveal H21 (purpose `phone_reveal`) (review #18) | TRD §14 access-log table |
| REQ-SEC-098 | no PHI in URLs/logs: ids only in paths; barcodes/names never in query strings; logger denylist | TRD §14 |
| REQ-SEC-099 | every operation in OpenAPI with owner; no public endpoints | spec |
| REQ-SEC-100 | business-flow abuse: route cap `max_visits_per_route` (default 40); 60 active visits per phlebotomist per day across routes, enforced at assignment (08 A19 D-131); push cap 100 mutations/batch | TRD §11 |
| REQ-SEC-102 | opaque LIMS session token (no GoTrue refresh token, 08 R10) + DB keys only in `flutter_secure_storage`; access JWT in memory only | TRD §7.1 |
| REQ-SEC-103 | SQLCipher via `package:sqlite3` ≥3.x hook (not `sqlcipher_flutter_libs`); only today's assigned visits; cache purged on logout/revoke/offline-age/date change; logout blocked while unsynced; outbox holds no names/phones/addresses and is bound to the user who created it (review #12). **Deviation recorded (review m#37):** research/02 says "purged on logout and after sync"; C17 keeps `cache.db` after a sync because the route is needed during the day, and interprets "after sync" as: purged when the route date ends or after `offline_purge_hours` without a successful pull (accepted deviation) | TRD §7; 05-SCHEMA Part B |
| REQ-SEC-104/105 | CA pinning with backup pin; no `badCertificateCallback`; no unpinned fallback | TRD §12; HC-T21 |
| REQ-SEC-106 | no push notifications at all | §4.2 PRD out of scope |
| REQ-SEC-107 | no secrets in the binary (only endpoints); CI `strings` scan | HC-T29 |
| REQ-SEC-108 | root/jailbreak heuristics → login refused (block); not a security boundary | US-13-6 |
| REQ-SEC-109 | FLAG_SECURE / switcher masking on every PHI screen | `LimsSecureScreen` |
| REQ-SEC-110 | OS biometric/device-credential re-auth after > 5 min background (04 A16); the plugin pin (CR-C17-010) is a hard precondition of any release — no password fallback (08 A19 D-127) | TRD §7.4 |
| REQ-SEC-111 | `enableSuggestions:false`, `autocorrect:false`; no copy on patient fields | 04-UI-UX §3 |
| REQ-SEC-112 | `--obfuscate --split-debug-info`, private mapping files | HC-T29 |
| REQ-SEC-113 | `min_app_version` → `426 homecollection.app_version_unsupported` (CR-C17-007) | TRD §5.2 |
| REQ-SEC-128 | no secrets in repo; pins are public certs, still delivered via C1 build inputs | CR-C17-011 |
| REQ-SEC-136 | non-prod uses synthetic data and no real SMS provider | seeds §7 of 05-SCHEMA |
| REQ-SEC-137 | server is time authority; device times corrected and plausibility-clamped | TRD §7.5 |
| REQ-SEC-139 | retention per tenant (B15); GPS 90 days (`expires_at`, per-tenant system-actor delete); anonymisation of visit P2 columns and copied handover barcodes after retention (05-SCHEMA §4.2) | 05-SCHEMA §6 |

## 2. Assets

| Asset | Class | Where |
|---|---|---|
| Today's route on the phone (names, phones, addresses, barcodes) | P2 | `cache.db` |
| Unsynced mutations (barcodes, GPS, payment references, amounts) | P2 | `outbox.db` |
| Session token (opaque, rotating — 08 R10), DB keys | credential | secure storage |
| Visit/custody records, GPS points | P2/P3 (`orderable_ids`) | `homecollection` schema |
| Field cash trail | financial | mutations → C4 ledger |
| Dispatch board (all visits of a centre) | P2 | staff web |

## 3. Threat model (STRIDE per entry point)

| Entry point / asset | S | T | R | I | D | E |
|---|---|---|---|---|---|---|
| A1–A5 app API | stolen session token used from another device → C2 session-token rotation/reuse detection (08 R10) + device binding check | forged mutation payloads → strict schema, server guards, barcode check against C5 | phlebotomist denies a collection → append-only `mutations` with author, device, batch, corrected time | phlebotomist reads others' visits → assignee restriction (403); snapshot only own routes | push floods → batch caps, rate tier, 413 | phlebotomist calls dispatcher endpoints → `homecollection.visit.assign` not in role; probes |
| Phone at rest (lost/stolen) | thief opens app → OS lock + A16 gate + password login (online) | tamper with DB → SQLCipher; server re-validates everything | — | dump of app sandbox → encrypted DBs, keys in Keystore; cache purge on revoke/offline age | thief keeps phone offline to block upload → outbox data unrecoverable but minimal; C5 manual collect fallback | rooted device → login refused |
| Network | MITM → CA pinning | replay of a batch → Idempotency-Key + per-mutation uniqueness | — | TLS 1.2/1.3 (04 I5) | — | — |
| Staff web H1–H21 | session theft → C2 BFF cookie rules | If-Match + audit triggers | `visit_transitions`, `visit_assignments`, review fields, audit log | centre scoping; allowlists; H2 and H21 phone reveal audited | board polling 30 s, general tier | privileged device/settings ops need aal2 (CR-C17-008 `privileged: true`) |
| Event consumers | forged events → only produced by C0 outbox inside the DB | payload validation; seq check | inbox | events carry P1 only (no address) | dead letters + alerts | system actor limited to manifest permissions |
| Map / tel hand-off | — | — | — | address only to the device's own maps app (founder-approved 2026-11-06); name, tests, phone never handed off; per-tenant switch (default on, 08 A2.5) | — | — |

## 4. Abuse cases (each becomes a test)

| # | Abuse | Expected |
|---|---|---|
| AB1 | Phlebotomist A requests snapshot with B's `device_id` | `409 homecollection.device_not_registered` |
| AB2 | A pushes `specimen.collected` for B's visit | `held` `visit_not_assigned` (fact kept, never applied) |
| AB3 | A replays yesterday's batch with a new Idempotency-Key | all `duplicate`, no event |
| AB4 | A edits a stored payload (same `client_mutation_id`, different amount) | `rejected` `common.idempotency_key_reused` |
| AB5 | A records a payment for an order not on the visit | `rejected` `common.validation_failed` |
| AB6 | A submits `scan_method: camera` with a typed barcode of another tube | barcode check against C5 → `held` `barcode_mismatch` |
| AB7 | Dispatcher of centre X opens a visit of centre Y | `404 common.not_found` |
| AB8 | Tenant A user calls any endpoint with tenant B ids | `404 common.not_found`; no B rows in lists; no side effects |
| AB9 | Phlebotomist uses H1 to list all centre visits | filtered to own visits only |
| AB10 | Note field used to send test names to the device | help text + log/denylist cannot block free text → retention anonymisation; reviewed in manual (residual risk accepted) |
| AB11 | User tries to sign out with pending changes by clearing app data | data loss is the user's own action; server board shows device with `max_device_seq_received` lag; outbox gone means mutations lost → C5 manual collect runbook |
| AB12 | Expired JWT on push | `401 auth.token_expired`; nothing applied |
| AB13 | Wipe-requested device tries to sign off to avoid the wipe | `409 homecollection.unsynced_changes` until wipe ack |
| AB14 | Oversized batch / payload | `413 common.payload_too_large`; 8 KB per mutation CHECK |
| AB15 | Device clock set to the future to fake visit times | anchor correction; clamp to receipt time; `clock_suspect` |
| AB16 | User B signs in on A's phone while A's changes are unsent, to upload them under B's name | app refuses the login (outbox owner binding); A1 with A's device id → `409 homecollection.device_not_registered` (review #12) |
| AB17 | A `lims_app` session sets `app.maintenance = 'homecollection_anonymise_retired_visits'` to read other rows or rewrite handover barcodes | owner policies are `TO lims_owner` (0 extra rows); the column-guard trigger still runs because `current_user ≠ lims_owner` → `immutable_row` (05-SCHEMA §4.2 T2) |
| AB18 | Patient, portal or partner claims of the tenant read `homecollection` tenant tables | 0 rows (`is_staff_or_system()` in every `__tenant` policy, 08 A17 P-16) |

## 5. Required security tests

1. **Cross-tenant probes** (02-CV §11.3) for every operation H1–H21, A1–A5: tenant-A actor with tenant-B ids in path/body/query (incl. H11 `visit_ids`, H15 `items`, A3 `visit_id`/`specimen_id`/`order_id`/`to_centre_id` inside mutations) → `404` / per-mutation `rejected common.not_found`; list endpoints return zero B rows; DB check shows no B side effects.
2. **Cross-centre probes**: dispatcher scoped to centre HC-A1 vs visits of HC-A2 (all H*); centre staff at C1 vs handovers to C2 (H13–H15); phlebotomist whose membership lacks the visit centre (A2 returns no such visit; A3 mutations `rejected`).
3. **Assignee probes**: phlebotomist-only actor on H2 for a non-assigned visit → 403; A2 never includes it; A3 → held/rejected per §4.
4. **Table probes** for every `homecollection` table: SELECT with tenant-A claims sees zero B rows; INSERT with `tenant_id = B` fails; UPDATE of B rows affects 0 rows; `has_table_privilege('lims_app', t, 'DELETE') = false` for every table except `visit_locations`, where a `user` actor deletes 0 rows and the system actor deletes only expired rows of its tenant; patient/portal/partner claims of tenant A read 0 rows of every `__tenant` table (P-16); composite FK rejects cross-tenant parent ids (visit → B patient/order/specimen; handover item → B specimen/centre).
4a. **DEFINER tests** (08 A12.7): `app.homecollection_anonymise_retired_visits` T1–T5 in 05-SCHEMA §4.2.
5. **Privilege escalation**: phlebotomist calling H3–H9, H16–H19, H21 → `403 auth.forbidden`; `homecollection.device.manage` / `settings.manage` at aal1 → `403 auth.mfa_required`; system actor cannot call A* (no session).
6. **Immutability**: UPDATE of `mutations`, `visit_transitions`, `visit_assignments`, `sync_batches` impossible (no grant); visits: changing `patient_id`/`kind`/`orderable_ids` → `immutable_row`; `order_id` non-null → other value rejected; collections only `held → applied|discarded`.
7. **Device forensics** (REQ-SEC-103): pull app sandbox from an emulator after a day's use → no plaintext names/phones (grep for synthetic strings), DB headers not `SQLite format 3`; after logout/revoke/purge → `cache.db` absent and key absent.
8. **Pinning** (REQ-SEC-104): proxy with untrusted CA → requests fail; no fallback.
9. **Token** (REQ-SEC-066): expired JWT rejected on every A*; refresh-then-retry uses the same Idempotency-Key.
10. **Log scan**: planted synthetic name, phone, address, barcode, GPS, payment reference through every endpoint and consumer → absent from logs/metrics.
11. **Binary scan** (REQ-SEC-107): release APK has no secrets (gitleaks rules on decompiled strings).
12. **Event PHI**: `homecollection.collection.synced.v1` payloads contain no barcode, name, GPS (schema + test).

## 6. PHI handling and logging rules

- Device: only today's assigned visits; patient fields = full name, phone (+ DOB only via CR-C17-003 and setting); no test names, no registration number, no results; closed visits keep no patient fields; outbox never contains name/phone/address.
- Server: `orderable_ids` (P3) stored only for booking visits until the order exists (needed for `createOrderFromBooking`); address/landmark/coordinates/notes P2; GPS in `visit_locations` with expiry; mutations payload P2; `handover_items.barcode` P2 (copied for the receiving centre, 08 A19 D-125; anonymised with the visit after retention).
- Logs: ids, codes, counts, durations only (02-CV §9.2). The free-text fields (`note_for_phlebotomist`, reason texts, handover note) are never logged.
- Access log: `home_visit.view` entries for snapshot visits, H2 visit detail and H21 phone reveal; C0 audit triggers capture data changes.
- Exports: none in C17.

## 7. Secrets used

| Secret | Holder | Notes |
|---|---|---|
| none server-side specific to C17 | — | uses core DB credentials via C0; no provider keys (SMS via C6) |
| Pinned CA certificates | app build input (C1) | public material; versioned per environment |
| Release signing keys (client-owned store accounts and signing keys — founder decision 2026-11-06, research/04 §13), obfuscation mapping files | C1 secret store | never in repo (REQ-SEC-128) |
| Session token (opaque, rotating — 08 R10), DB keys | device secure storage | per install; destroyed on sign-off/wipe |
