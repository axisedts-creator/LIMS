# HC-T05 impl
- Files: services/api/src/modules/homecollection/service/visit.service.ts (new: onBookingConfirmed/onBookingCancelled), services/worker/src/jobs/homecollection/consumers/engagement.booking.{confirmed,cancelled}.v1.ts (thin wrappers, tenant_id != ctx.tenantId -> no-op, same as frontdesk).
- [CONV] one pg_advisory_xact_lock per (tenant, booking) serialises confirmed/cancelled/redelivery; uses existing HC-T03 repos only (no new SQL files).
- [CONV] confirmed: port via ctx.db.tx savepoint, any error/unusable address -> `address_missing` flag; log carries error code only. Existing visit -> redelivery no-op (port not re-called).
- [CONV] cancelled: stale/duplicate (ref.last_seq >= seq) ignored; visit by home_visit_id else booking_id; transitions written with cause `consumer`; order_cancel_required flag related_id = order_id; route version++ via updateRoute(patch {}).
- Verified (post-ruling, impl unchanged): live PG17 run 34/35 pass; 1 = 5s vitest timeout in cancelled "tenant_id differs from ctx.tenantId" (handler returns before any I/O; time is fixture setup; passed in debug round 4). Rerun hit beforeAll 10s hook timeout (mkWorld). Both are slow-docker-host timeouts, not assertions; no clean 35/35 run yet.
- Open: `home_visit.view` access-log write (TRD §8.2) not implemented, column shape/helper unspecified; manifest wiring left to the HC index task; no dispute filed.
