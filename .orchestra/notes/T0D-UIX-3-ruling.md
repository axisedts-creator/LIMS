TESTS_WRONG — round 3: uiconsole1.lab.test.tsx pins the old 5 ingest-exception headers; the tester adds 'Instrument' between 'Instrument code' and 'Status'.
1. apps/web/src/features/lab/__tests__/uiconsole1.lab.test.tsx:146 headers become ['Age', 'Barcode', 'Reason', 'Instrument code', 'Instrument', 'Status'].
2. Same file :227 (page test, same list): same 6-header array.
3. Same file :10 contract comment: "list headers exactly Age, Barcode, Reason, Instrument code, Instrument, Status".
Reason: spec/chunks/C5-lab-workflow/04-UI-UX.md:224 (§3.10) lists "instrument (C7 name or `IdText`)" as a list column, so the spec requires an instrument column and does not require the 5-header set. Round 2 point 2b (uilist1.lab.test.tsx:79 `min: 6` stays) ordered this column. The uiconsole1 pin is old markup, and the brief allows that to change (done when (6): "only tests that pinned the old markup change").
No other uiconsole1 assertion changes (barcode link, API order and FilterBar stay). The writer does nothing more for this point.
No CR is needed.

## LEAD ITEM LD-443 (11:20 NPT)
Snapshots under __snapshots__ are writer or reviewer owned, never tester owned (LD-440, LD-443). Tester: do not run vitest -u, only name stale snapshots in your tests note. Writer or reviewer: regenerate a stale rs-cN screens snapshot with -u after reading the diff, only when the diff is markup (table, dl, button, kit classes, react-aria ids) and no text or data changes. A stale snapshot is not a test dispute.

## LEAD ITEM LD-445 (12:10 NPT)
Correction of LD-443: the reviewer may NOT edit snapshots or source files and creates no scratch files in the repo (Enforce reverts them). Only the WRITER (or debugger) edits non-test sources and regenerates snapshots with -u after reading the diff. The reviewer states the exact change in the review note. See the LD-445 line for the exact list the writer does now for this task.
