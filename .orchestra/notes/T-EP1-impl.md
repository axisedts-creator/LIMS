# T-EP1 impl (writer)
- Changed: `services/api/src/modules/engagement/ports/EngagementPort.impl.ts` only (real getHomeAddress / getActiveMembership; same export, manifest wiring unchanged).
- Result (after ruling + revised tests): `EngagementPort.impl.test.ts` + `EngagementPort.phase1stub.contract.test.ts` 29/29 pass. Whole engagement module 1309/1310: only fail is `boot.test.ts` "still lists QualityPort" (stale since C9 T-01 removed QualityPort; not T-EP1 scope).
- [CONV] single-table SELECTs binding tenant_id (REQ-SEC-024); plan read separately from membership (no JOIN); read-only; no logging; no access_log (caller writes it).
- [CONV] authz: system passes; user needs assertRole (home: visit.assign OR visit.read; membership: frontdesk.registration.create); device/patient -> auth.forbidden before any read.
- [CONV] dates: valid_from <= UTC date(at) < valid_to; validTo = `<date>T00:00:00.000Z`; optional address fields omitted when null.
- Open: purpose != 'home_visit' and malformed uuid -> common.validation_failed (assumption from tester note). Full-suite/lint not run (only the two engagement test files); `tsc` shows one pre-existing error in contracts/ports/common.ts, none in my file.
