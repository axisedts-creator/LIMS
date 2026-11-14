# RS-C7 impl (writer; LD-140, LD-170)
Files: features/instruments/components/InstrumentsList.tsx (table -> Card/Grid link cards; Sort-by RadioGroup keeps `sort=-last_message_at`), InstrumentDetail.tsx (go-live sentence -> kit StatusStepper in region "Commissioning checklist").
[CONV] 5th stepper step "All checks done" so four Complete reads right (kit stepper needs a current step). Cards show last message, not heartbeat/queue (A2: needs CR).
Result: 28/35 pass. Fail: 3 A3 behaviour + 2 messages screens (tests assume role=table; kit is role=grid, see RS-C7-dispute.md), 2 screens snapshots unrecorded (cards, stepper).
Open: tests dispute; web-t03 columns test conflicts with cards (A5); snapshots to record last with `-u rs-c7.screens`; web-t0x and axe on other suites not run by me.
