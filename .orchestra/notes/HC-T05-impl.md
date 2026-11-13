# HC-T05 impl
- Files: services/api/src/modules/homecollection/service/visit.service.ts (onBookingConfirmed/onBookingCancelled), services/worker/src/jobs/homecollection/consumers/engagement.booking.{confirmed,cancelled}.v1.ts (thin wrappers, tenant_id != ctx.tenantId -> no-op).
- [CONV] one pg_advisory_xact_lock per (tenant, booking) serialises confirmed/cancelled/redelivery; HC-T03 repos only.
- [CONV] confirmed: port via ctx.db.tx savepoint; any error/unusable address -> `address_missing` flag; log carries error code only. Redelivery no-op (port not re-called).
- Review fix 1: access log per TRD §8.2/§14 — visit id generated before the port call; `ctx.audit.access({action:'home_visit.view', entityType:'home_visit', purpose:'home_address_fetch', outcome:'allowed'})` after every port call (success or throw); none on redelivery / no home_address_id / centre_visit.
- [CONV] cancelled: stale/duplicate (last_seq >= seq) ignored; transitions cause `consumer`; order_cancel_required related_id = order_id; route version++ via updateRoute(patch {}).
- Verified: HC-T05-verify.cmd (HC-T05.pg.sh, live PG17) 35/35 pass, log in HC-T05-verify.log; tsc api+worker: no homecollection errors.
- Open: manifest wiring left to the HC index task.
