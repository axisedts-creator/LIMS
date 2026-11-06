# C17 Home Collection — 01 PRD

Status: DECISION draft, 2026-11-06. Chunk C17, **Phase 3** (04 §12), wave order per 01 §1 (B1 closed, 08 A11.2). Module `homecollection` (Postgres schema, API module, worker jobs, staff-web feature) plus the Flutter app `apps/phlebo_app`.

Labels: **DECISION** = engineering choice made here (change by CR). **[CONV]** = value chosen here with no external fact behind it. **ASSUMPTION** = planning number to validate. **UNVERIFIED** / **BLOCKED (B#)** as in 04. "03-IC" = `program/03-INTERFACE-CATALOG.md`, "02-CV" = `program/02-CONVENTIONS.md`, "CM" = `program/01-CHUNK-MAP.md`. CR ids `CR-C17-0nn` are defined in `02-TRD.md` § Change requests raised; everything marked with a CR id is designed **as if accepted** and runs against a fake until it is.

---

## 1. Purpose

A phlebotomist goes to the patient's home, confirms who the patient is, draws blood into tubes that were labelled at the centre, takes payment, and brings the tubes back. Mobile coverage on a home-collection route is unreliable, and the phone carries many patients' personal data (02 §7 threat 8: "a stolen phone is a 50-patient breach"). C17 delivers:

1. **`apps/phlebo_app`** — an offline-first Flutter app (04 S17, D14 in research 03): today's assigned visits, navigation hand-off, two-identifier patient check, collection consent, tube scan against the expected barcodes, payment capture, handover at the centre, and a durable append-only mutation log that syncs when a network is available.
2. **API module `homecollection`** — the visit model, dispatch/assignment, the sync protocol (snapshot pull, mutation push, ack), conflict resolution (server-wins with a human review queue for field facts), chain-of-custody records, device registry with remote wipe.
3. **Worker jobs** — consumers of booking/order/specimen events, cron housekeeping (missed visits, overdue handovers, GPS retention purge).
4. **Staff web `homecollection`** — dispatch board (assign visits to phlebotomists, route list per phlebotomist, status), visit detail with review queue, handover receipt at the centre, device list, settings.

The only facts C17 sends to other chunks are `homecollection.collection.synced.v1` (03-IC §3.23) → C4 records payments as ledger entries, C5 marks specimens `collected` then `in_transit`, C16 completes the `home_collection` booking from the optional `booking_id` (08 A19 D-120), and the synchronous `FrontdeskPort.createOrderFromBooking` call that turns a booked home visit into a registered order (03-IC §5.2 X5).

## 2. Users and roles

Permission codes from 03-IC §11 (verbatim) unless marked with a CR.

| Role (default, 03-IC §11) | What they do in C17 | Permissions |
|---|---|---|
| `phlebotomist` | Uses the app: pulls today's route, performs visits, records collections/payments/handover, signs off the device | `homecollection.visit.read`, `homecollection.sync.upload`, `billing.payment.record` (C4 records the ledger row in the phlebotomist's name via the event), `lab.specimen.collect` (C5 applies the collection) |
| `front_desk` (dispatcher) | Dispatch board: schedule, assign, re-sequence, cancel visits; review held collections; resolve flags; print the tube labels (C5 page) | `homecollection.visit.read`, `homecollection.visit.assign`, `lab.specimen.label_print` (C5), `frontdesk.order.read` (C4 deep links) |
| `lab_manager` | Same as dispatcher; device management; settings | `homecollection.visit.assign`, `homecollection.visit.read` (default grant added by **CR-C17-008**), `homecollection.device.manage` (**CR-C17-008**), `homecollection.settings.manage` (**CR-C17-008**) |
| `centre_staff`, `front_desk`, `lab_technologist` (receiving end) | Confirm a phlebotomist's handover of tubes at the centre (chain of custody) | `homecollection.handover.receive` (**CR-C17-008**) |
| `tenant_admin` | Device wipe, settings; revokes the phlebotomist's sessions in C2 when a phone is lost | `homecollection.device.manage`, `homecollection.settings.manage` (**CR-C17-008**), `identity.session.revoke` (C2) |
| system (worker) | Event consumers and cron | manifest-declared: `homecollection.visit.read`, `homecollection.visit.assign` (internal transitions only) |

Actor type of the phlebotomist is `user` (a staff GoTrue user with a tenant membership, 02-CV §6). The app authenticates through C2's native-staff session endpoints (**CR-C17-004**, accepted as session kind `staff_mobile`: the app holds an opaque, rotating LIMS session token, never a GoTrue refresh token — 08 R10).

## 3. Problems this chunk solves

| # | Problem | Source |
|---|---|---|
| P1 | The client's product formula includes a Phlebotomy APP; wishlist item 5 asks for "bi-directional integration with … Phlebotomy App … real-time sample status" | 00 §1 handwritten note; 00 §3 item 5 |
| P2 | Home-collection samples appear as a pseudo-centre ("C000000002-HOME COLLECTION") on today's report — there is no field workflow behind it | 00 §4 |
| P3 | Field coverage is unreliable; the app must work offline without losing a collection or a payment | 04 S17; REQ-ARCH-066/067/070 |
| P4 | A lost/stolen phone must not leak the day's patient list | REQ-SEC-103; 02 §7 threat 8; 04 A15 |
| P5 | Wrong-patient / wrong-tube errors at the door; rejected specimens need a revisit | 00 B2; 01 §2.1 (rejection triggers recollection); REQ-ARCH-069 |
| P6 | Cash collected in the field must reach the IRD-compliant ledger in the collector's name | 00 A9, E7; 04 P1; REQ-SEC-057 |
| P7 | Collection time ≠ receipt time; both are needed for TAT | 06-GLOSSARY "Phlebotomy"; 03-IC §6.3 `v_pub_specimen_timeline` |

## 4. Scope

### 4.1 In scope

| ID | Item | Client baseline | Notes |
|---|---|---|---|
| IS-01 | Visits created from `engagement.booking.confirmed.v1` (`booking_kind = home_collection`) | 00 §1 (apps), §3 items 5, 11, 13 | consumer; booking cancel via `engagement.booking.cancelled.v1` (03-IC §3.24) |
| IS-02 | Visits created from a front-desk order with `collection_mode = home` (staff dispatch of a phone request) | 00 A4 (centre that sent the sample), §4 HOME COLLECTION centre | consumer of `frontdesk.order.created.v1` (CM §5.1: C17 is a consumer) |
| IS-03 | Revisit after specimen rejection (`lab.specimen.rejected.v1`) and after a failed visit | 00 B2; 01 §2.1 | revisit is a new visit linked to its parent |
| IS-04 | Dispatch board: schedule (time window, address, note), assign to a phlebotomist for a date, re-sequence the route, unassign, cancel | 00 §3 item 13 (front desk management), §3 item 5 | staff web |
| IS-05 | Order creation at assignment for booked visits via `FrontdeskPort.createOrderFromBooking(confirmImmediately: true)` so C5 creates specimens and barcodes | 03-IC §4.3, §5.2 X5; C4 03-APP-FLOW §3.5 | C5 assigns barcodes (03-IC §9.3) |
| IS-06 | Tube labels printed at the centre before departure through C5's label page (link from the board) | 00 B1 | **DECISION D-LABELS** (§4.3) |
| IS-07 | Phlebotomist app: login, today's route, visit detail, navigate (hand-off to device maps app, **DECISION D-MAPS**), call patient, arrive, two-identifier check, collection consent, tube scan + collected_at, not-collected reasons, payment capture (cash / QR / wallet recorded), complete/fail, handover, sync status, sign-off | 00 §1; §3 item 5; A9 | offline-first |
| IS-08 | Offline store: encrypted drift DBs on `package:sqlite3` ≥3.x with the SQLCipher hook (04 A15), split into a purgeable read-only cache and a durable mutation log | 04 A15, S17; REQ-SEC-103 | not `sqlcipher_flutter_libs` (banned, 02-CV §15.3) |
| IS-09 | Sync protocol: snapshot pull with cursor, append-only idempotent mutation push (client UUIDv7 ids), ack; server-wins with a review queue; clock correction | 04 S17, A7; REQ-ARCH-066/067/069/070 | §5 user stories |
| IS-10 | Emission of `homecollection.collection.synced.v1` → C4 ledger, C5 specimen states | 03-IC §3.23 | |
| IS-11 | Chain of custody: collector, collected_at, scan method, GPS point (tenant setting), handover (handed_over_at, receiving centre, received_by, received_at, per-tube outcome) | REQ-ARCH-069 | |
| IS-12 | Device registry, remote wipe on next contact, sign-off check before logout, offline-age purge, re-auth after >5 min background | 04 A15, A16; REQ-SEC-102/103/110 | |
| IS-13 | Review queue for field facts that lost a server-wins conflict (e.g. collected while the visit was cancelled) | 04 S17 | dispatcher decides apply / discard |
| IS-14 | Flags on the board: address missing, missed visit, cancel after start, order needs cancelling in C4, overdue handover, recollection needed, identity mismatch | — | |
| IS-15 | Status read model of the visit's specimens from `lab.specimen.status_changed.v1` (collected / received / rejected shown on the board and app) | 03-IC §3.7 (C17 consumer) | |
| IS-16 | Per-tenant settings (consent text version, payment methods, GPS, sync interval, purge hours, minimum app version) | — | |
| IS-17 | User-manual pages + in-app help for every screen | CM §2 wishlist item 9 note | |

### 4.2 Out of scope

| Item | Where it lives / why |
|---|---|
| Patient-facing booking, slots, patient app | C16 |
| Order registration, invoices, ledger rows, receipts, refunds, credit notes, order cancellation | C4 (C17 only links to C4's order page) |
| Barcode generation, label rendering/printing, specimen state machine, lab receive | C5 |
| Gateway (eSewa/Khalti/Fonepay) API payments in the field | C15; not a `PaymentProviderPort` consumer (CM §5.1). Phlebotomist **records** QR/wallet payments like the front desk does (04 P1) |
| Route optimisation, embedded maps, geocoding | **DECISION D-MAPS**: no foreign map SDK/API (04 §11); manual sequencing by the dispatcher |
| Push notifications (FCM/APNs) | foreign touchpoint not in 04 §11; app polls |
| Supabase Realtime in the app | 04 S5 allows it, but D3 (claims population) is UNVERIFIED; polling suffices for ≤ 60 visits/route [DECISION] |
| Printing in the field (Bluetooth label/receipt printers) | **DECISION D-LABELS**; hardware + SDK not in 04 |
| Adding tests or tubes at the door | order changes are C4 (`frontdesk.order.items_changed.v1`); app shows a message "Ask the centre to add tests" |
| Phlebotomist time/attendance, HR, incentives | 04 §12 DROP (HR/payroll) |
| Cytogenetics, kiosk, CRM | CM §2 DROP list |

### 4.3 Product decisions

| ID | Decision | Rationale |
|---|---|---|
| **D-LABELS** | Tubes are labelled **at the centre before departure** with the barcodes C5 already assigned to the order's specimens (C5 label page `/lab/orders/{order_id}/labels`, opened from the dispatch board). The app **scans** each tube at collection and checks it against the expected barcodes. No blank pre-printed label stock, no field printing. | (1) Barcodes are generated by C5 per specimen and never reused (03-IC §9.3; 01 §2.1). Pre-printed blank stock would need a "bind label to specimen" transition that C5's state machine does not have (03-IC §10.1) and opens a field mislabel window. (2) Field printers need hardware and an SDK not in 04. (3) Verification still happens at the door: scan vs expected list (P5). Trade-off: tests cannot be added at the door; recollection needs a centre visit to print the new label (S12 creates a new barcode). |
| **D-MAPS** | "Navigate" hands the address text (or coordinates if the dispatcher set them) to the device's maps app via an OS intent/URL; no map SDK is embedded. Approved by the founder 2026-11-06 (research/04 §11; CR-C17-012 ACCEPTED in 08): hand-off to the device's own maps app via OS intent/URL, address only (no name, tests, phone), no embedded map SDK. The per-tenant setting `map_handoff_enabled` stays as an operational switch; when off, the app shows the address and landmark only. | 04 §11 (no foreign service without approval), REQ-SEC-007; no PHI other than the address leaves; patient name/tests never in the hand-off. |
| **D-IDENT** | Two identifiers before any collection: (1) full name stated by the patient compared with the record; (2) the second identifier per tenant setting `second_identifier` — `phone` (default; available today through `FrontdeskPort` purpose `home_visit`) or `birth_date` (available after **CR-C17-003**). Mismatch → visit fails with `identity_mismatch`; no collection is possible on the device. | `home_visit` purpose returns fullName, phoneE164, consents only (03-IC §4.3). |
| **D-CONSENT** | Collection consent is recorded per visit (given / refused) with the tenant's `collection_consent_text_version`. Messaging consents stay with C4. | REQ-SEC-005 ("collection, processing, …"). |
| **D-PAY** | Payments are captured on the device as mutations and forwarded in `homecollection.collection.synced.v1`; **C4's consumer writes the ledger entry** (03-IC §3.23; C4 US-BL-09). C17 never writes billing data and uses `BillingPort.getOrderBalance` only to show the amount due. Payments are always forwarded once authored by a phlebotomist who was assigned to the visit (money physically collected is a fact), even when the visit was cancelled; C4 raises its own finance review for overpayment. | CM §5 R2; 04 P1; REQ-SEC-057 |
| **D-SERVERWINS** | Server state (assignment, cancellation, specimen status) always wins. A field fact that conflicts (collection on a cancelled/reassigned visit, specimen no longer `ordered`) is **stored and held** for dispatcher review — never silently dropped, never applied automatically. | 04 S17; 03-IC §8 `homecollection.mutation_superseded` |

## 5. User stories and acceptance criteria

Every criterion is a test (06 plan maps them). Synthetic data only (02-CV §11.2): tenant A "Synthetic Lab Alpha", home-collection centre `HC-A1`, phlebotomist "Test Phlebo 01", patient "Test Patient 0042".

### US-01 Visit from a booking
1. Given `engagement.booking.confirmed.v1` with `booking_kind = home_collection`, When the consumer runs, Then one visit exists with `status = unassigned`, `kind = booking`, `booking_id`, `patient_id`, `centre_id`, `branch_id`, `orderable_ids`, `window_start/end = slot_start/slot_end`, no `order_id`.
2. Given the same `event_id` delivered twice, Then still one visit (inbox dedupe).
3. Given `booking_kind = centre_visit`, Then no visit and the inbox row exists.
4. Given `home_address_id` and `EngagementPort.getHomeAddress` (**CR-C17-005**, fake) returns an address, Then `address_text`/`landmark`/coordinates are stored; Given the port throws or is unavailable, Then the visit is created without address and flag `address_missing` is open.
5. Given `engagement.booking.cancelled.v1` for that booking arrived **before** the confirmation with higher `aggregate.seq`, Then the confirmation creates no visit (booking_refs `cancelled`).

### US-02 Visit from a front-desk order (staff dispatch)
1. Given `frontdesk.order.created.v1` with `collection_mode = home` and `source = front_desk`, Then one `unassigned` visit `kind = front_desk` with that `order_id`, `patient_id`, `centre_id`, no window, and flag `address_missing`.
2. Given `source = home_collection` and `source_ref_id` = an existing visit, Then no new visit; the visit's `order_registered_at` is set.
3. Given `collection_mode = walk_in` (any source), Then nothing.

### US-03 Schedule and assign
1. Given an unassigned visit without address or window, When the dispatcher assigns it, Then `422 homecollection.visit_incomplete` (**CR-C17-007**).
2. When the dispatcher posts `schedule` with a window (end > start, ≤ 12 h [CONV]) and an address (≤ 500 chars), Then both are stored, `version` increments, open `address_missing` flag resolves automatically, and, when the visit is assigned, its route `version` increments in the same transaction (review #10). Given only one of latitude/longitude, Then `400 common.validation_failed`.
3. Given a scheduled `kind = booking` visit, When assigned to an eligible phlebotomist for date D (If-Match, Idempotency-Key), Then in **one transaction**: `FrontdeskPort.createOrderFromBooking({source:'home_collection', sourceRefId: visit_id, patient:{patientId}, orderableIds, branchId, centreId, referrerId?, priority:'routine', scheduledAt: window_start, confirmImmediately: true, idempotencyKey: '<visit_id>:order'})` is called, `order_id` is stored, status → `assigned`, a `visit_assignments` row and a route `(centre, phlebotomist, D)` exist, route `version` increments.
4. Given the port throws (`catalog.test_inactive`, `catalog.no_price`, `frontdesk.consent_required`, `auth.forbidden`), Then the assign fails with that error and nothing is written.
5. Given the assign is retried with the same Idempotency-Key, Then the stored response is replayed (`Idempotent-Replayed: true`) and the port is not called again; Given a C4 replay (`replayed: true`), Then the same `order_id` is stored.
6. Given a membership that is inactive, not in the visit's centre, or without role `phlebotomist`, Then `422 homecollection.phlebotomist_not_eligible` (**CR-C17-007**).
7. Given an `assigned` visit, When reassigned to another phlebotomist or date, Then a new `visit_assignments` row, both routes' versions increment, `order_id` unchanged, no second port call.
8. Given the route already has `max_visits_per_route` (default 40 [CONV]) active visits, Then `400 common.validation_failed` with pointer `/phlebotomist_membership_id` (08 A13 P-1).
9. Given a `completed`, `failed` or `cancelled` visit, When any dispatcher action is posted, Then `409 homecollection.visit_closed`.
10. Given the phlebotomist already has 60 active visits on that `route_date` across all routes (`LIMS_HOMECOLLECTION_SNAPSHOT_MAX_VISITS`), When another visit is assigned to any of their routes for that date, Then `400 common.validation_failed` with pointer `/phlebotomist_membership_id`, and H12 lists that phlebotomist with `route_full: true` (08 A19 D-131).

### US-04 Route list and sequencing
1. Given a route with 5 visits, When the dispatcher posts the sequence `[v3, v1, v2, v5, v4]` with If-Match, Then `route_sequence` = 1..5 in that order and route `version` increments.
2. Given the list does not contain exactly the route's active visits, Then `400 common.validation_failed`.
3. The board lists unassigned visits for the selected date (window start in that date, or no window) and one lane per phlebotomist route, each lane ordered by `route_sequence` then `window_start`.

### US-05 Labels at dispatch (D-LABELS)
1. Given an assigned visit with `order_id`, Then the board row has "Print labels" linking to route `staff.lab.order_labels` (C5, CR-C5-007) with `order_id`; it is shown only to actors holding `lab.specimen.label_print`.
2. Given the visit's specimens are not yet in the read model, Then the board shows "Tubes: preparing…" and refreshes them through `LabPort.lookupSpecimens({orderId})` (CR-C17-002, merged into CR-C10-003 — 08 §4.14) on open.

### US-06 Pull today's route (app)
1. Given a registered device and a phlebotomist with 2 visits assigned for today (tenant timezone) and 1 for tomorrow, When the app pulls with no cursor, Then the snapshot contains exactly the 2 visits, each with: visit id, version, sequence, window, status, patient full name, patient phone, address text, landmark, coordinates (if set), dispatcher note, expected specimens (specimen id, barcode, specimen type code, container code, status — barcodes from a `LabPort.lookupSpecimens` call made for this snapshot, never from stored data), balance due (paisa) with `as_of`, and **no** test names, registration number or birth date (unless D-IDENT `birth_date` is on).
2. Given the same cursor and no server change, Then `unchanged: true` with fresh balances only.
3. Given a visit on today's route was cancelled after assignment, Then it appears as a stub `{visit_id, status: cancelled, route_sequence, window}` without patient fields.
4. Given the pull, Then one access-log entry with action `home_visit.view` (purpose `home_visit_snapshot`) per visit with patient fields is written (04 D11; review m#39).
5. Given another phlebotomist's visit id requested in any app endpoint, Then `403 homecollection.visit_not_assigned`.
6. Given app version below `min_app_version`, Then `426 homecollection.app_version_unsupported` (**CR-C17-007**) on every app endpoint.
7. Given an unregistered `device_id` or a device registered to another membership, Then `409 homecollection.device_not_registered`.
8. Given `LabPort.lookupSpecimens` fails for a visit during a changed pull, Then that visit has `specimens: []` and `specimens_stale: true`, the app shows "Tubes unavailable — refresh before collecting" and Collect is disabled for it; the other visits are unaffected (review #2).

### US-07 Visit at the door (app, offline)
1. Given airplane mode, When the phlebotomist taps Arrive, completes identity check (name + second identifier both "matches"), records consent "given", scans 2 expected tubes, records a cash payment of NPR 1,800.00 and completes, Then 7 mutations are in the mutation log with consecutive `device_seq`, each with a UUIDv7 `client_mutation_id`, device wall time, clock anchor id and monotonic elapsed ms; nothing is lost after force-closing and reopening the app.
2. Given the identity check records a mismatch on either identifier, Then the Collect step is disabled and the only actions are "Fail visit (identity mismatch)" or "Back".
3. Given consent "refused", Then collection is disabled and Fail visit with reason `patient_refused` is offered.
4. Given a scanned barcode that equals an expected specimen of this visit, Then that specimen shows "Collected hh:mm"; Given a barcode that belongs to another visit on the device, Then "This tube belongs to another patient" and nothing is recorded; Given an unknown barcode, Then "This tube is not on this visit" and nothing is recorded; Given a repeat scan of an already-collected tube, Then "Already collected".
5. Given manual entry is used (`manual_barcode_entry_allowed`, default true [CONV]), Then the full barcode must be typed (the screen shows only the last 4 characters of expected barcodes) and the mutation records `scan_method = manual`.
6. Given a specimen cannot be drawn, When marked "Not collected" with reason `unable_to_draw` | `patient_declined_tube` | `tube_missing` | `other`, Then a `specimen.not_collected` mutation; completing the visit then yields `outcome = partial`.
7. Given a payment method marked `requires_reference` (defaults copy C4's seed: `fonepay_qr`, `card`, `bank_transfer`; `cash`, `esewa`, `khalti` off), Then the reference (1–100 chars) is mandatory. Given a settings update with a payment-method code outside C4's seed codes {`cash`, `card`, `esewa`, `khalti`, `fonepay_qr`, `bank_transfer`}, Then `400 common.validation_failed` (08 A19 D-128).
8. Given the app was in background > 5 min (04 A16), When reopened, Then OS biometric / device-credential prompt is required before any screen with patient data renders; 5 consecutive failures → app requires full login. The app is not released before the plugin is pinned (CR-C17-010); there is no password fallback after background (08 A19 D-127).

### US-08 Push and server-wins
1. Given the 7 mutations from US-07-1 and a valid access token, When pushed in one batch, Then the response lists each `client_mutation_id` with `applied`; one `homecollection.collection.synced.v1` is emitted for the visit with 2 collections (`barcode_verified: true`) and 1 payment (`payment_method_code: cash`, `amount: {amount_paisa: 180000, currency: NPR}`), idempotency key `<visit_id>:sync:<sha256 of sorted client_mutation_ids>`.
2. Given the same batch retried (same Idempotency-Key, byte-identical stored body), Then the stored response is replayed; Given the same mutations in a new batch (new key), Then each is `duplicate` and **no** second event. Given a push answered `422 common.idempotency_key_reused`, Then the device re-forms the batch under a new `batch_id` and every mutation is answered `applied` or `duplicate` (review #3).
3. Given a mutation with an existing `client_mutation_id` but a different payload hash, Then `rejected` with `common.idempotency_key_reused` for that mutation.
4. Given the visit was cancelled on the server while the collection happened offline, Then collections are `held` with code `homecollection.mutation_superseded`, the payment is `applied` and forwarded (D-PAY), the visit stays `cancelled`, flag `collected_after_cancel` opens, and the event carries the payment only.
5. Given the visit was reassigned to phlebotomist B before A's offline collection, and A was the assignee at the corrected capture time, Then A's collection is `applied`; Given A was never the assignee at capture time, Then `held` with `homecollection.visit_not_assigned`.
6. Given C5 reports the specimen is no longer `ordered` (e.g. `collected` at a walk-in counter), Then `held` with `homecollection.mutation_superseded`.
7. Given the scanned barcode differs from the specimen's barcode returned by `LabPort.lookupSpecimens({orderId})`, Then `held` with `homecollection.barcode_mismatch`.
8. Given a collection that is **not** preceded (in `device_seq`) by both an applied identity check with both identifiers `matches` and an applied consent with `given: true` by the same author for the visit, Then `held` with `homecollection.mutation_superseded` (review m#29).
9. Given `scan_method = manual` and the barcode matches, Then `applied` with `barcode_verified: false` in the event (C5 shows "barcode was not verified" warning).
10. Given an expired access JWT, Then `401 auth.token_expired` (no grace, 04 A7); the app refreshes first, then re-sends the same batch with the same Idempotency-Key.
11. Given the batch has > 100 mutations or > 512 KB [CONV], Then `413 common.payload_too_large`.
12. Given a mutation for a visit id the server does not know, Then it is answered `rejected` `common.not_found`, is not stored in `homecollection.mutations`, and a later resend is evaluated again (review #7).

### US-09 Review queue
1. Given a held collection, When the dispatcher chooses **Apply** with reason, and the order is active in C4 and the specimen is `ordered` in C5, Then the collection becomes `applied` and a `homecollection.collection.synced.v1` with that collection only is emitted (trigger clarified by **CR-C17-006**).
2. Given the specimen is no longer `ordered`, Then Apply fails with `409 homecollection.mutation_superseded` and only **Discard** remains.
3. When **Discard** with reason (`specimen_destroyed`, `duplicate_draw`, `wrong_patient`, `other` + text), Then status `discarded`, no event, flag resolved with the reason.
4. Given the collection is not `held`, Then `409 homecollection.collection_not_held` (**CR-C17-007**).

### US-10 Booking cancelled
1. Given `engagement.booking.cancelled.v1` for an `unassigned` visit, Then status `cancelled`, `status_reason_code = booking_cancelled`, and the event's `reason_code` is kept in `status_reason_text` (review m#32).
2. Given an `assigned` visit with an `order_id`, Then status `cancelled` and flag `order_cancel_required` with a link to C4's order page (`staff.frontdesk.order`), because C17 cannot cancel C4 orders/invoices.
3. Given an `in_progress` or `completed` visit, Then the visit is not changed and flag `cancel_requested_after_start` opens (03-IC §3.24).
4. Given no visit yet, Then a `booking_refs` row `cancelled` with `last_seq` is stored (US-01-5).

### US-11 Recollection and revisit
1. Given `lab.specimen.rejected.v1` with `recollection_required: true` and `home_visit_id` = V1 (or an order linked to V1), Then a new visit `kind = recollection`, `parent_visit_id = V1`, same order, address copied, no window, `unassigned`, flag `recollection_required`; duplicate delivery creates nothing.
2. Given `recollection_required: false`, Then only the specimen read model changes.
3. When the dispatcher posts `revisits` on a `failed` visit, or a `completed` visit with `outcome = partial`, with reason, Then a new `kind = revisit` visit (same order, address copied) is created; on any other parent state, Then `409 homecollection.visit_closed` (review m#30, #4).
4. The revisit's expected specimens are exactly the order's specimens in `ordered` at pull time (the new recollection specimen has a new barcode, 03-IC §10.1 S12).

### US-12 Handover (chain of custody)
1. Given 3 applied collections by phlebotomist A, When A records a handover to centre C with the 3 specimens, Then after sync a handover `pending` exists with 3 items, `handed_over_at` (corrected), `from_membership_id = A`.
2. Given centre staff with `homecollection.handover.receive` at C — **not** members of the home-collection centre — open the handover, Then they see each item's barcode and specimen type (from `handover_items`); When they scan all 3 barcodes and confirm, Then status `confirmed`, `received_by_membership_id`, `received_at`; Given 1 not received, Then `discrepancy`, and the worker task `homecollection.flag_handover_discrepancy` opens flag `handover_discrepancy` on that visit (08 A19 D-125).
3. Given a specimen not collected by A (or already handed over), Then that item is skipped with per-item outcome in the push result.
4. Given applied collections not handed over after `handover_overdue_hours` (default 4 [CONV]), Then flag `handover_overdue` (cron).
5. Centre staff at another centre see no handover addressed to C (centre scoping on `to_centre_id`).

### US-13 Logout, sign-off, purge
1. Given ≥1 mutation `pending`/`sending`, Then Sign out is disabled with "Sync first — n changes are not uploaded yet" (04 A15).
2. Given the log is empty locally, When Sign out, Then the app calls `signOffPhleboDevice` with `last_device_seq`; Given the server has not received that seq, Then `409 homecollection.unsynced_changes` and sign-out is refused; Given it has, Then C2 `logoutMobileSession({session_token})`, then the cache DB and its key are destroyed, then the mutation DB and its key, and a new device id is generated (review #8).
3. Given no successful pull for `offline_purge_hours` (default 16 [CONV]) or the local date changed past the route date, Then the read-only cache is destroyed while the mutation log is kept.
4. Given a refresh (session-token rotation, 08 R10) returns "session revoked/expired" (C2; incl. reuse of an old session token), Then the read-only cache is destroyed immediately and the login screen shows; pending mutations remain encrypted and upload after the next successful login **by the same user**. Given another user signs in while pending mutations exist, Then the app refuses with "This phone has unsent changes from another user. Ask that user to sign in, or the lab admin to wipe it."; Given `registerPhleboDevice` with a device id bound to another membership, Then `409 homecollection.device_not_registered` (review #12).
5. Given `requestDeviceWipe` was posted for the device, When the device next pulls successfully, Then it first finishes uploading pending mutations, then destroys both DBs and keys, calls `ackSync` with `wipe_completed: true`, signs out; the device row becomes `wiped`.
6. Given a rooted/jailbroken device is detected (heuristics, REQ-SEC-108), Then login is refused with "This device can't be used for home collection" [DECISION: block, not degrade].

### US-14 Specimen status on board and app
1. Given `lab.specimen.status_changed.v1` for a specimen of an order linked to a visit, Then `visit_specimens.status` updates only if `aggregate.seq` > stored seq; the route version increments when the visit is on a route.
2. Given an event for an order with no visit, Then nothing is stored (inbox only).

### US-15 Missed visits
1. Given an `assigned` visit whose route date is before today (tenant tz) at the daily cron and whose route was **never pulled** on that date, Then it returns to `unassigned`, keeps `order_id`, and flag `missed` opens.
2. Given the same but the route has `last_snapshot_at` on its route date (a phone holds the visit), Then the visit stays `assigned` with flag `missed`; Given the phone uploads the visit's collections on the next day, Then they are applied normally (08 A19 D-126).

### US-16 Visit detail views and phone reveal (staff web)
1. Given a dispatcher opens a visit, Then `getHomeVisit` writes one access-log row `home_visit.view` with purpose `visit_detail`, and the response carries no phone number (review #18).
2. When the dispatcher clicks "Show" on the phone, Then `revealHomeVisitPhone` returns `phone_e164` and writes one access-log row `home_visit.view` with purpose `phone_reveal`; Given an actor without `homecollection.visit.assign`, Then `403 auth.forbidden`.

## 6. Success metrics

| Metric | Target | Measured by |
|---|---|---|
| Collections lost between device and lab | 0 (every captured mutation reaches the server or is visible as pending on the device) | `lims_homecollection_mutations_total` vs device pending count in sign-off; E2E chaos test |
| Duplicate ledger rows / duplicate collections from retries | 0 | C4 ledger idempotency (client_mutation_id) + C17 unique constraints; contract tests |
| Time from push to specimen `collected` in C5 | p95 ≤ 10 s [CONV] | event timestamps |
| Held mutations resolved | ≤ 1 business day | `lims_homecollection_held_open` gauge age |
| Plaintext PHI on device | none (DB files unreadable without Keystore key) | MASTG-style forensic test (REQ-SEC-103) |
| Pull p95 | ≤ 500 ms unchanged, ≤ 2 s changed for ≤ 40 visits | TRD §13 |

## 7. Phase

Phase 3 (04 §12 "Native patient app + phlebotomy app"), wave order per 01 §1 (B1 closed 2026-11-06, 08 A11.2; review m#21). The per-tenant feature flag `homecollection` is a go-live switch, not a blocker default. Whether the client has or plans its own phlebotomy app is open client question C-06 (08 A19.4; default: the LIMS provider builds it). REQ-SEC §5 (mobile) applies when the app ships (04 §12 rule). Contracts are frozen by C0 in the Wave-3 contract wave; build can start against fakes immediately.

## 8. Dependencies (contracts only)

| Contract | Kind | Owner | Use |
|---|---|---|---|
| `engagement.booking.confirmed.v1`, `engagement.booking.cancelled.v1` | events | C16 | visit creation / cancel |
| `frontdesk.order.created.v1` | event | C4 | staff-dispatch visits; confirmation for our own orders |
| `lab.specimen.status_changed.v1`, `lab.specimen.rejected.v1` | events | C5 | specimen read model; recollection revisit |
| `homecollection.collection.synced.v1` | event (produced) | C17 → C4, C5, C16 | optional `booking_id` for booking visits (08 A19 D-120) |
| `FrontdeskPort.createOrderFromBooking`, `getPatientDemographics('home_visit')`, `getPatientDemographicsBatch('home_visit')`, `getOrderSummary` | port | C4 | batch for snapshot and board (review m#34) |
| `BillingPort.getOrderBalance` | port | C4 | amount due |
| `LabPort.lookupSpecimens({orderId, statuses?})` → `readonly SpecimenRef[]` | port (CR-C17-002 merged into CR-C10-003) | C5 | barcodes, specimen types |
| `EngagementPort.getHomeAddress` | port (**CR-C17-005**) | C16 | address of booked visits |
| `IdentityPort.assertRole`, `getActor`, `getTenantSettings(['timezone','retentionYears'])` | port | C2 | |
| `NotificationPort.sendSms` (purposes `visit_assignment`, `booking_confirmation`) | port | C6 | optional SMS on assignment; staff SMS suppressed in Phase 1 (08 A13 D-34); patient template `homecollection.visit_scheduled` via **CR-C17-014** (08 A19 D-129) |
| C2 native staff sessions | HTTP (**CR-C17-004**) | C2 | app login/refresh/logout |
| `staff.lab.order_labels` | route (CR-C5-007) | C5 | label printing link |
| `staff.frontdesk.order` | route | C4 | order deep link |
| `ctx.core` memberships/centres incl. role codes | core repo (**CR-C17-013**) | C0 | eligibility, handover centres |

## 9. Blocked items and defaults built meanwhile

| # | Item | Default built now |
|---|---|---|
| ~~B1~~ | Phase/priority of the phlebotomy app — **closed 2026-11-06** (08 A11.2: wave order per 01 §1) | built against fakes; feature-flag `homecollection` off per tenant until go-live (go-live switch) |
| ~~B11~~ | Map hand-off as a foreign touchpoint — **approved 2026-11-06** (founder, research/04 §11; 08 §5.0): address only, device's own maps app, no embedded map SDK | `map_handoff_enabled` is a per-tenant operational switch, default **true** (08 A2.5) |
| B15 | Legal retention for visit/custody records | per-tenant `retentionYears` (default 5, 04 I8); GPS points 90 days [CONV] |
| B12 | Nepal DC (pins depend on C1 certificates) | pin set injected at build per environment (CR-C17-011) |
| CR-C17-001/002/004/005 pending | — | fakes in `packages/fakes` (C0) with the proposed signatures |

## 10. Open questions (recorded, not blocking)

1. Home-collection volume per lab (research 01 §8 question 7) — capacity uses ASSUMPTION 20 % of 500 patients/day (TRD §13).
2. Does the client issue phones (staff-managed Android devices) or allow personal phones? Design assumes staff-managed Android 10+ [ASSUMPTION]; iOS supported only after the iOS items marked UNVERIFIED in TRD §7.6 are confirmed.
3. Is a home-collection fee charged (research 01 §8 question 4)? If so it is a C3 catalog orderable, not C17 logic.
