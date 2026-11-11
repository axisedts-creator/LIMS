# FD-T04 dispute (debugger)
Failing: search.test.ts:171 `"' OR '1'='1" is treated as data` — `expected 112 to be 111` (countPatients(TENANT_A) before/after).
Cause: tenant-wide count asserted stable while other test files insert into TENANT_A in parallel. searchPatients (service/patient.service.ts:120-145) only reads (searchPatientsByNameRanked) and writes access_log; it never inserts into frontdesk.patients.
Spec: no line requires a tenant-wide count to be stable across concurrent suites. Arbiter ruling (FD-T04-ruling.md item 2) already ruled this class TESTS_WRONG for create.test.ts; search.test.ts:167/171 has the same defect and was missed.
Ask: drop the before/after countPatients in the hostile-probe test, or scope it to rows the test seeded.
No implementation change made.
