# T0D-UIGUARD-1-PAYMENTS tests (tester)
- Edited: apps/web/src/core/__tests__/uiguard1.exceptions.ts. Deleted the PAYMENTS legacy7 block (2 rule 7 routes, LD-441). Nothing added.
- No new test file: the guard (uiguard1.guard.test.ts) proves done_when 1-4. Rule 7 = no raw h1-h4/ul/ol.
- Red now, for the right reason: rule 7, 2 routes. /payments/refunds and /payments/review: raw h2 in RefundsList.tsx / ReviewQueue.tsx; raw h3 + ul in consoleParts.tsx. 35 other guard tests pass.
- Writer: fix those files (and rebuild all 6 payments pages to the look spec), delete the 2 PAYMENTS lines in notes/T0D-UIGUARD-1-exceptions.md (line 81); do not touch the registry.
- Snapshots rs-c15.* are writer-owned (LD-440): not touched. Old markup pins in features/payments/__tests__ (pg-t18, pg-t19, uilist2, uiset1, uiconsole1) change by the writer's call only where they pin old markup.
- Run: .orchestra/notes/T0D-UIGUARD-1-PAYMENTS-verify.cmd
