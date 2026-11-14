LEAD RULING LD-169

Cause: the goldens live in `drivers/getein_metis/testdata/`. That path is not a test path for the harness (`.orchestra/run.ps1:63`), so the tester's goldens were reverted at 11:02 (log `C7-instrument-integration.log:612-621`). This matches LD-148.

TESTER:
1. Change nothing. Do not edit `hostQuery.getein_metis.test.ts` or anything under `testdata/` (writes there are reverted). If, after the writer's goldens land, you believe a golden contradicts 09-ADDENDUM-GETEIN-METIS.md ┬º5 (:121) or ┬º6 (:207), write a dispute that cites the exact byte and spec line.

WRITER:
1. Create these new files in `services/api/src/modules/instruments/drivers/getein_metis/testdata/` (required by 09-ADDENDUM-GETEIN-METIS.md:259):
   - inputs: `qry-found.hl7`, `qry-not-found.hl7`, `qry-no-mapped-test.hl7`, `qry-sample-range.hl7`, `qry-time-range.hl7`, `ack-q03-mismatched-id.hl7`
   - expected replies: `qry-found.qck.hl7`, `qry-found.dsr.hl7`, `qry-not-found.qck.hl7`, `qry-no-mapped-test.qck.hl7`, `qry-sample-range.qck.hl7`, `qry-time-range.qck.hl7`
2. Build every byte from the spec text in ┬º5 (:121) and ┬º6 (:207), not by capturing what `hostQuery.ts` outputs:
   - QCK/DSR MSH-10 = MSA-2 = the query MSH-10
   - a trailing pipe on every segment
   - QRD/QRF echoed
   - DSP 1-28 per the ┬º5 table; DSP-29 and up one per mapped test, as id-only
   - DSC with an empty field
   - LF line ends (the test converts them to CR)
3. Make the files fit the test exactly. `ack-q03-mismatched-id.hl7` must contain `MSA|AA|99|` (test line 128 replaces it). Barcodes, mapped tests and query ids must match what the test's fake lab and assertions expect. Read the test; do not change it.
4. Synthetic data only: `MT26000000nn` barcodes, empty PID name, no text from the manual (LD-163). Add a row for each `qry-*` case and for `ack-q03-mismatched-id` to `testdata/SOURCE.md`, replacing the line "Host query cases (`qry-*`) belong to MET-T03."
5. Run `.orchestra/notes/MET-T03-verify.cmd`. Record the real pass/fail/todo counts in MET-T03-impl.md. Expected: 54 passed, 4 todo. If any test fails, record the failing assertion; do not touch the test.
