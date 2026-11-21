# T0D-UIGUARD-1-ANALYTICS impl (writer)
- ReportView.tsx: single-chart section now renders through ReportChart, so it sits in ChartCard (rule 6) like the hero and side charts. [CONV] reuse, no new component.
- ScheduleEditor.tsx: chosen-recipients raw ul/li replaced by kit Inline role="list" + div role="listitem" (rule 7, list semantics kept).
- packages/ui Inline.tsx: additive optional props role ('list'|'group') and aria-label (LD-441 small additive kit prop).
- notes/T0D-UIGUARD-1-exceptions.md: deleted both ANALYTICS sections (5 rule 6 + 3 rule 7 lines). Registry untouched (tester-owned, LD-441).
- rs-c8.screens.test.tsx.snap + rs-c8.screens.admin.test.tsx.snap re-recorded by writer (LD-440): diff is only ChartCard wrapper on Pending tests report and the Inline recipients row; no amount, permission, route or contract change.
- Checks: uiguard1 guard 36/36; analytics configs an-t17/18/19/20/24, misreports1, rs-c8, uidash1, uireport2(.mis), uidash2 all green. packages/ui: 7 failures (fonts, density, no-raw-style-literals) none in touched files, pre-existing.
- Open: T0D-MISREPORTS-1 is reviewed (7dabe68a2), so ReportView edit is not an ownership clash. Display only; no data gaps found.
