# RS-C5 impl (writer)
Files: ReceiveScreen.tsx (Session log = kit Tabs All/Received/Rejected/Errors + counts, filters table), CollectDispatch.tsx (tab counts), WorklistPage.tsx (Grid: table + aside "Result entry", row button, Card panel, Esc closes), grid/ResultGrid.tsx (StatusStepper track per item, "Next: ..", StatusChip "Instrument" portalled in Origin cell), WorksheetPrintPage.tsx (#000 -> currentColor), __snapshots__/rs-c5.screens.test.tsx.snap (4 written with -u, LD-170).
[CONV] LD-140 restyle only: server/**, routes, permissions untouched (static baseline green). Track current step = least advanced result (pending -> none current).
Run: rs-c5 19/23 pass; screens 4/4; c5-t20 57/57; lab-t26 36/36; lab-t11 66/74.
Open: 4 rs-c5 tests disputed (select, \bHB\b x2, delay:null) and lab-t11 tab names vs counts -> RS-C5-dispute.md. Lead: drop apps/web/src/features/lab from raw-style-pending.json.
