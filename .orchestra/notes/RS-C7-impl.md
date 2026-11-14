# RS-C7 impl (writer; LD-140, LD-170)
Files: components/InstrumentsList.tsx (table -> link cards; Sort-by keeps `sort=-last_message_at`), InstrumentDetail.tsx (go-live sentence -> kit StatusStepper, region "Commissioning checklist"), MessagesList.tsx (Kind column `isRowHeader` too, so grid rows are named "<instrument> <kind>"; a11y markup only).
[CONV] 5th stepper step "All checks done" so four Complete reads right. Cards show last message, not heartbeat/queue (A2: needs CR).
Snapshots recorded once per LD-170: `__snapshots__/rs-c7.screens.test.tsx.snap` (4 written).
Result (CI=true): rs-c7 35/35; web-t02 73/73, t03 98/98, t04 188/188, t05 171/171, t06 85/85. tsc: 0 errors in non-test files under task paths.
Review r1: raised `.orchestra/cr/RS-C7.md` (CR-C7-RS01, non-blocking: agent heartbeat + queue depth on InstrumentSummary E23); cards keep "Last message" until ruled. No code change; rs-c7 re-run CI=true 35/35.
Open: tsc reports type errors inside rs-c7.behaviour.test.tsx (tester-owned; vitest runs fine). eslint not installed in apps/web, so not run. Lead must OK the web-t03 SCR-05 test edit (A5).
