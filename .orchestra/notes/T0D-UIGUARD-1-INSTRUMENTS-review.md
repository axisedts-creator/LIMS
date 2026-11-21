APPROVE

Reviewed `git diff 0b7e9164f..HEAD` (writer impl) plus tester commit 0b7e9164f.
- done_when 1: OutcomeTable keeps thead when empty; empty text is the one body row (colSpan 3). Test covers both empty and non-empty.
- done_when 2: INSTRUMENTS rule 5 + rule 7 lines gone from uiguard1.exceptions.ts (tester, LD-441) and notes/T0D-UIGUARD-1-exceptions.md (writer); nothing added. Registry test pins it.
- done_when 3 / LD-439 b: no raw h1-h4 / ul / ol left in instruments components (Card title rows, DataTable, StatusStepper; currentId="" = all Upcoming per kit doc line 27). No legacy entry left.
- Display only: no route, permission, API, contract or field-name change; owned paths only; no tokens/kit/shell edits; no PHI, no secrets; rs-c7 snapshot re-record by writer (LD-440) is _r_xx_ id drift only.
- Ran: uiguard1-instruments 55/55, web-t05 171/171, h80-t06 31/31, met-t05 38/38, rs-c7 34/35, web-t03 97/98.
- Not a defect of this diff (recorded for the lead): rs-c7.static "same permission strings" and web-t03 "one link card per instrument" fail on files this task does not touch (InstrumentSettingsForm.tsx, InstrumentsList.tsx, last changed by T0D-UISETTINGS-1 / T0D-UILIST-1). They need a tester or arbitration ruling, not a change here.
