# T0D-UIX-4 left over
## From this task (tester change done)
- instruments/rs-c7.behaviour.test.tsx:93 "one row per instrument": tester change, pins old cell spacing (native table trailing space; kit DataTable has none). Fixed by tester in d0c28268f (gridcell textContent 'up').
## Not from this task (red, not ruled)
- instruments/rs-c7.static.test.ts:101 permission-literal baseline (baseline from before other merged tasks).
- frontdesk/rs-c4.static.test.ts: 5 baseline failures (billing discount files, permission codes and routes added by other merged tasks).
- frontdesk/regscreen1.items + regscreen2.drafts Favourites tab: `expected undefined to be false` (kit Tabs aria-selected on the inactive tab; not this task).
- Load-sensitive, rerun on a quiet host: uiguard1.instruments 30 s timeout, regscreen2.patient timeout, web-t04.components "expected 'h' to be 'hemo'".
