APPROVE
Scope: b393109c..HEAD touches only owned paths (frontdesk module tests/service, .orchestra/notes, .orchestra/cr/FD-T15.md). Prior review item 1 resolved:
- patient.service.ts:339 fails closed with 403 auth.forbidden after the aal2 role check and before any read/write unless IdentityPort.getActor().centreScope.all === true (shape matches contracts/ports/IdentityPort.ts ActorProfile.centreScope.all); comment cites REQ-SEC-139 / P-12 c and the CR.
- admin/anonymise.test.ts:177 covers the centre-scoped admin: 403 auth.forbidden, patient/consents/TRFs/storage untouched, no patient.anonymise access_log row; the all-centre admin still succeeds. helpers.ts ADMIN/ADMIN_B now allCentres: true so existing cases keep their meaning.
- .orchestra/cr/FD-T15.md filed (non-blocking, C0-0B, DEFINER all-centre path; names left to owner, nothing invented).
- duplicates.test.ts:93 stamp change matches FD-T15-ruling.md (18:14Z = 2026-11-09 23:59 Asia/Kathmandu).
No PHI in logs, no secrets, error code auth.forbidden already in use across the module. Writer-reported run: admin suites 79/79, unit 30/30 (not re-run by reviewer).
