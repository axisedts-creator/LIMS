# T-EP1 impl (writer)
- Changed: `services/api/src/modules/engagement/ports/EngagementPort.impl.ts` only (real getHomeAddress / getActiveMembership; same export, manifest wiring unchanged).
- Result: `EngagementPort.impl.test.ts` 28/28 pass. `EngagementPort.phase1stub.contract.test.ts` 5 fail (obsolete T-01 stub assertions) -> `.orchestra/notes/T-EP1-dispute.md`.
- [CONV] single-table SELECTs binding tenant_id (REQ-SEC-024); plan read separately from membership (no JOIN); read-only; no logging; no access_log (caller writes it).
- [CONV] authz: system passes; user needs assertRole (home: visit.assign OR visit.read; membership: frontdesk.registration.create); device/patient -> auth.forbidden before any read.
- [CONV] dates: valid_from <= UTC date(at) < valid_to; validTo = `<date>T00:00:00.000Z`; optional address fields omitted when null.
- Open: purpose != 'home_visit' and malformed uuid -> common.validation_failed (assumption from tester note). Full-suite/lint not run (only the two engagement test files); `tsc` shows one pre-existing error in contracts/ports/common.ts, none in my file.
