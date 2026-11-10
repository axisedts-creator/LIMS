TESTS_WRONG — search.test.ts:167/171 asserts a tenant-wide patient count is stable while other suites insert into TENANT_A in parallel; no spec line requires that.
1. Same defect class as prior ruling item 2 (create.test.ts countPatients race). Items 1-4 of the previous ruling still stand unchanged.
2. Spec need here is only that hostile input is treated as data: spec/chunks/C4-frontdesk-billing/07-SECURITY.md:34 (REQ-SEC-080/081/082: parameterised SQL; trigram search input escaped). It says nothing about tenant-wide row counts.
3. searchPatients only reads and writes access_log (01-PRD.md:142 patient.search row); it does not insert patients, so the count drift comes from other test files, not the handler.
4. Change in search.test.ts "probes: hostile query strings": remove `countPatients(TENANT_A)` before/after (lines 167, 171). Keep "table intact" by:
   a. keeping the patient from `const p = await seedPatient('a')` and asserting after the call that the row with p.id still exists (SELECT by id via superTx/ownerRows), and
   b. asserting `SELECT to_regclass('frontdesk.patients')` is not null.
5. Keep lines 168-170 (200 or common.validation_failed, ≤20 rows, no anonymised rows) unchanged.
No implementation change required by this ruling.
