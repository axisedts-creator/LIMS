TESTS_WRONG — the test reads golden files from drivers/truth_h80e/testdata/ that do not exist there (tester commit cd49d38e deleted them from __tests__/fixtures/truth_h80e/ without re-adding them).
Reasons:
- spec/chunks/C7-instrument-integration/08-ADDENDUM-TRUTH-H80E.md:210 says the golden files go in `testdata/` and must include `qry-found`, `qry-not-found`, `qry-no-hba1c-order`, `ack-q03-mismatched-id`. So the new path is correct, but the files have to exist at that path.
- 08-ADDENDUM-TRUTH-H80E.md:197 puts `testdata/` under `drivers/truth_h80e/`. Checked: that directory has only the H80-T02 oru-*/malformed-* files and SOURCE.md, with no *.hl7 files.
- The 25 failures are ENOENT from readFileSync in hostQuery.truth_h80e.test.ts:23. No assertion against the implementation is reached, so no implementation change is required by these failures.
Tester must:
1. Restore the 8 files from cd49d38e~1 (__tests__/fixtures/truth_h80e/{qry-found,qry-found.qck,qry-found.dsr,qry-not-found,qry-not-found.qck,qry-no-hba1c-order,qry-no-hba1c-order.qck,ack-q03-mismatched-id}.hl7) into services/api/src/modules/instruments/drivers/truth_h80e/testdata/ with the same names and contents.
2. Add these 4 query cases and their reply files to testdata/SOURCE.md (synthetic-data provenance).
3. Re-run the test file and confirm 34/34 pass.
