CHANGES

Re-review of `git diff 7924842f..HEAD` (H80-T03, round 2) against 08-ADDENDUM-TRUTH-H80E §5, §6, §8 and LD-139. Ran `hostQuery.truth_h80e.test.ts`: 34/34 pass.
Round-1 item 1 fixed: CR-C7-018 is filed in `.orchestra/cr/H80-T03.nonblocking.md` and cited in `hostQuery.ts:5`. DSP-1/2/3/4/13 stay empty as interim behaviour.
Round-1 item 2 fixed: MSH-3/MSH-4 = `LIS`/`LIMS` in `hostQuery.ts:42`, and the four reply goldens are updated.
Still OK: QRD-8.1 extraction (empty or >40 => instruments.message_malformed), OK only when `found` with >=1 test, [QCK] / [QCK, DSR], no test list, replay is byte-identical, status stays `generic` (inert), no PHI in reasons, no secrets, no RLS/route/permission surface.

1. Round-1 item 3 is still open: the golden files are outside the task paths and outside the §8 location. `services/api/src/modules/instruments/__tests__/fixtures/truth_h80e/*.hl7` (8 files) is not in the task `files` list (`drivers/truth_h80e/**` plus the test file). 08-ADDENDUM §8:210 puts `qry-found`, `qry-not-found`, `qry-no-hba1c-order` and `ack-q03-mismatched-id` in `testdata/`. Fix (tester):
   - `git mv` the 8 files to `services/api/src/modules/instruments/drivers/truth_h80e/testdata/`. Keep the `.hl7` names so the `.raw`/`.expected.json` parse auto-runner does not pick them up.
   - Update `fixture()` in `__tests__/hostQuery.truth_h80e.test.ts` to read from that directory.
   - Add the 4 query cases and their reply files to `drivers/truth_h80e/testdata/SOURCE.md` (synthetic, §5 layout).
   - Remove the empty `__tests__/fixtures/truth_h80e/` directory.
