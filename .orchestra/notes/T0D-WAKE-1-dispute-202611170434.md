# T0D-WAKE-1 writer dispute (2026-11-17 02:18 NPT)

Writer changed nothing (LD-298/303/306, ruling: writer does not touch the baseline).

Verify run on lane head 2092db6bd:
- wake1 config: 53 of 53 passed.
- packages/ui no-raw-style-literals: 41 passed, 1 skipped.
- rs-c2.static: 3 red, all stale baseline: "data, action, validation-table and nav files are untouched", "same route files" (24 vs 23), "same form field names" (13 vs 15).

Cause: rs-c2.baseline.json last recorded at ec073f164; no "[tester] T0D-WAKE-1 tests revised per ruling" commit exists. The TESTER stage re-record (RS_C2_RECORD=1, allowed diff per LD-298 + LD-303 + LD-306) has not run on this lane. Same orchestrator routing defect as LD-298: the reset reached the writer, not the tester.

Needed: tester stage runs the re-record. No implementation change is needed.
