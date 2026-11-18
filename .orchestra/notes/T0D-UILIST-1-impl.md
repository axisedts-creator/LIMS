# T0D-UILIST-1 impl (writer, round after ruling)
Files: features/instruments/components/InstrumentsList.tsx (native table), instruments rs-c7.screens snapshot (instruments only, LD-362); earlier rounds: see git 74ea3e301, 734e0691e, screens in -screens.md.
[CONV] SCR-05 is a native `<table role="grid">` (as features/admin/Grid.tsx), not the react-aria DataTable: the revised A1 keyboard test needs every row link in the Tab order; sort = header buttons with aria-sort (Code asc, Last message -last_message_at).
[CONV] Status column moved after Name so the state pill is the row's first chip; each td ends with a space so the cell texts stay apart.
Runs: uilist1 76/76, web-style-3 101/101, rs-c7.behaviour 23/23, elabmenu 99/99, m-series-kit 29/29.
Pre-existing reds (not this task, no CSS changed here): m2.source and r04.source motion (shell.css .lims-auth-plate 14s sway, from main); rs-c7.static permission literal, rs-c7.screens messages (ruling item 4).
Open: merging main needed approval in this session and was not done. Snapshot test still named "link cards" (tester's file).
