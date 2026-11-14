IMPLEMENTATION_WRONG — the test is right; the missing goldens were the writer's deliverable (LD-148) and the writer has now supplied them in 6d4284a8. No further change is needed: 34/34 pass.
Reasons:
- spec/chunks/C7-instrument-integration/08-ADDENDUM-TRUTH-H80E.md:197 puts `testdata/` under `drivers/truth_h80e/`, and :210 names the goldens qry-found, qry-not-found, qry-no-hba1c-order and ack-q03-mismatched-id. The test's path matches the spec.
- LD-148 (binding, 2026-11-13) moves the restore from the tester to the WRITER, which supersedes the earlier TESTS_WRONG ruling. The dispute (15:29) predates LD-148 and is stale.
- Re-checked 2026-11-13 22:17: all 8 *.hl7 files are in drivers/truth_h80e/testdata/. `git diff cd49d38e~1:…/__tests__/fixtures/truth_h80e/ HEAD:…/testdata/` shows no difference in any .hl7 file. SOURCE.md lists the 4 query cases (6d4284a8).
- `npx vitest run src/modules/instruments/__tests__/hostQuery.truth_h80e.test.ts` passed 34 of 34.
- Writer: nothing left to do. The test and the implementation stay as they are, and the task can go to review.
