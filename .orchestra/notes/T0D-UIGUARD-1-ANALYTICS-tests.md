# T0D-UIGUARD-1-ANALYTICS tests (tester)
- Edited: apps/web/src/core/__tests__/uiguard1.exceptions.ts. Deleted all ANALYTICS legacy entries (LD-441): 5 rule 6 routes (ReportView.tsx) + 3 rule 7 routes (ScheduleEditor.tsx). Nothing added.
- No new test file: the guard (uiguard1.guard.test.ts) is the proof for done_when 1-3. Rule 6 = ChartCard, rule 7 = no raw h1-h4/ul/ol.
- Red now, for the right reason: rule 6 (5 routes, 1 chart without ChartCard in ReportView.tsx), rule 7 (3 routes, raw <ul> in ScheduleEditor.tsx). 34 other guard tests pass.
- Writer: fix ReportView.tsx + ScheduleEditor.tsx, delete the 8 ANALYTICS lines in notes/T0D-UIGUARD-1-exceptions.md (sections at lines 17-23 and 200-204); do not touch the registry.
- Snapshots rs-c8.* are writer/debugger-owned (LD-440): not touched by tester.
- Run: .orchestra/notes/T0D-UIGUARD-1-ANALYTICS-verify.cmd
