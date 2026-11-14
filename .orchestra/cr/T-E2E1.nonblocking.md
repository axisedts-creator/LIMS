Title: CR-C16-0xx: test-support endpoints for the C16 T-E2E1 nightly E2E journeys (non-production only)
From chunk: C16            To owner: C0-0C (contracts) / C0-0D (compose, nightly)
Type: api
Blocking? no — tests/e2e/engagement-journey.e2e.ts is written against this proposal; the real nightly run is blocked until these are mounted in the compose/ci stack.
Problem: T-E2E1 (02-TRD §14 E2E nightly; 06-PLAN §3 "Events from C5/C6/C4", "Consumers of booking events") must inject C5/C6 events, run the fake C4 consumer of engagement.booking.confirmed.v1, run engagement.reconcile_bookings, read the OTP the recording NotificationPort "sent", and scan logs. No spec defines such a surface, and the harness must not invent routes silently.
Proposed change (exact): mounted ONLY when TARGET_ENV/APP_ENV in {compose, ci, staging}; absent (404) in production; staff bearer + tenant RLS like every /v1/engagement route; synthetic data only. Prefix /v1/engagement/test-support:
  POST /scenarios {scenario: report-journey|booking-journey, distinct_from?, same_slot_as?}
       -> 201 {patient_id, patient_display_name, patient_phone, order_id, specimen_id, specimen_type_code, report_id, report_sha256, centre_id, slot_start, orderable_ids[]}  (registers a synthetic patient/order/released-report bytes via the fakes; slot capacity 1 for booking-journey)
  POST /events {event_type: lab.specimen.status_changed.v1|lab.specimen.rejected.v1|reporting.report.released.v1|billing.balance.changed.v1, aggregate_seq: integer, payload} -> 202  (route builds envelope.aggregate {type, id, seq=aggregate_seq} per 03 envelope; publishes onto the bus as C5/C6/C4 would)
  GET  /recorded-messages?kind=sms&purpose=otp&phone_e164= -> 200 {data:[{kind, purpose, otp_code}]}
  POST /consumers/c4/run {booking_id} -> 200 {order_id}  (fake C4 consumer: pre-registers the order visible in frontdesk.v_pub_order_status)
  POST /jobs/run {job: engagement.reconcile_bookings|engagement.mark_no_shows} -> 200
  GET  /logs -> 200 text/plain (api + worker lines of the run)
Also assumed (state if wrong): pre-auth E2 uses `Authorization: Bearer t.<tenant_code>`, E3 `Bearer c.<challenge_token>`, patient calls `Bearer <access_token>` (02-TRD §4.3 credentials).
Backward compatible? yes — additive, non-production only.
Tenant/security impact: exposes raw OTP codes; must never be mounted in production (startup assertion + CI check that production OpenAPI has no /test-support path). No real PHI.
Alternatives considered: direct DB fixtures from the runner (bypasses RLS and the ports the journey proves); Playwright through UIs (slower, still needs the recorded-message read).
Tests that will prove it: `node --test tests/e2e/engagement-journey.static.test.mjs` (wiring); nightly `pnpm exec vitest run tests/e2e/engagement-journey.e2e.ts` green against compose.
