CHANGES
Reviewed `git diff 252aeca3..HEAD` (FD-T11) against 03-IC §4.3, C4 TRD §6.1 (cases 1-20, purpose table, 08 R7), 05-SCHEMA orders RLS (TC policy).
Run log: FD-T11-run.log 50/50. Names, error codes, allowlists, `::uuid[]` casts, no logging, no access_log, owned paths: OK. Contract cases (1)-(20) all have tests.

1. services/api/src/modules/frontdesk/service/booking.service.ts:450-455 (createOrderFromBooking): a USER actor (home_collection dispatcher with `homecollection.visit.assign`, or a `partners.manifest.receive` holder) is never checked against its centre scope. 03-IC §4.3 "Tenant context: centre scope applies". A centre-scoped dispatcher passing another centre's `centreId` gets past every app check, writes the patient, consent and counter rows, then hits the `orders__insert__tenant_centre` RLS WITH CHECK. That gives a raw PG error instead of a coded one. F9 does this check explicitly (registration.service.ts:286-287, "404, not 403").
   Fix: right after `const b = parseBooking(...)` and before `lock(...)`/any write, add:
   `if (c.actor.type === 'user') { const s = (await c.ports.IdentityPort.getActor(c)).centreScope; if (s?.all !== true && !(s?.centreIds ?? []).includes(b.centreId)) throw new LimsError('common.not_found'); }`
   Ask the tester to add a case in FrontdeskPort.booking.contract.test.ts: a dispatcher scoped to centre A with centreId = centre B gets `common.not_found` and nothing is written.

2. services/api/src/modules/frontdesk/ports/FrontdeskPort.impl.ts:96 (`notification.users: [P.patientRead]`): TRD §6.1 lists `notification` as "system only", but 03-IC case (15)/CR-C6-015 needs a user caller. No spec text names the user permission, so `frontdesk.patient.read` is a security rule the writer chose. The code comment admits "to be confirmed with C6". CLAUDE.md says that when the spec is missing something, write a CR instead of deciding it.
   Fix: write `.orchestra/cr/FD-T11.md` (04-CHANGE-REQUESTS template) asking C6/lead which permission gates `notification` for non-system actors. Keep the current fail-closed gate until it is ruled on, and cite the CR id in the comment at line 96.
