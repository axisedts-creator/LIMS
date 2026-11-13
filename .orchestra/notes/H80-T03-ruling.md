TESTS_WRONG — the test reads golden files from drivers/truth_h80e/testdata/ that do not exist there (tester commit cd49d38e deleted them from __tests__/fixtures/truth_h80e/ without re-adding them; re-checked 2026-11-13, still missing).
Reasons:
- spec/chunks/C7-instrument-integration/08-ADDENDUM-TRUTH-H80E.md:197 puts `testdata/` under `drivers/truth_h80e/`; :210 requires goldens `qry-found`, `qry-not-found`, `qry-no-hba1c-order`, `ack-q03-mismatched-id` there. The test's path is correct; the files are absent.
- Re-checked: drivers/truth_h80e/testdata/ holds only SOURCE.md and the H80-T02 oru-*/malformed-no-msh files; no *.hl7 file exists.
- The failures are ENOENT from readFileSync at hostQuery.truth_h80e.test.ts:23, before any assertion runs, so no implementation change is required.
Tester must (unchanged from previous ruling, not yet applied):
1. Restore the 8 files from cd49d38e~1 (services/api/src/modules/instruments/__tests__/fixtures/truth_h80e/{qry-found,qry-found.qck,qry-found.dsr,qry-not-found,qry-not-found.qck,qry-no-hba1c-order,qry-no-hba1c-order.qck,ack-q03-mismatched-id}.hl7) into services/api/src/modules/instruments/drivers/truth_h80e/testdata/, same names and contents.
2. Add the 4 query cases and their reply files to testdata/SOURCE.md (synthetic-data provenance).
3. Re-run hostQuery.truth_h80e.test.ts and confirm 34/34 pass.
