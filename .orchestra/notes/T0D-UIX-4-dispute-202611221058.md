# T0D-UIX-4 dispute (writer, round 2)
uix4.markup 9/9 green. Touched-feature suites still fail; two kinds:

A. Tests pin old raw-table ARIA (same pattern as the 10:13 ruling, which named only 5 lines). DataTable is role=grid / gridcell (packages/ui DataTable.tsx:2):
- inventory/__tests__/t24.unresolved.test.tsx (12 cases, getByRole('table')) — UnresolvedView
- instruments/__tests__/uiguard1.instruments.test.tsx (2, role "table") — ReprocessDialog
- instruments/__tests__/web-t04.components.test.tsx (2, role "table" /observed codes/, outcome table) — InstrumentMappings
- reporting/__tests__/rs-c6.screens.test.tsx (1, role "table") — DeliveryDetail
- frontdesk/__tests__/regscreen2.drafts.test.tsx (4, getByRole('cell', {name:'CBC'}) -> 'gridcell')
- DOM snapshots to re-record: rs-c4.screens (4), rs-c2.screens "centres drawer", rs-c7.screens (2)
Fix (tester): 'table' -> 'grid', 'cell' -> 'gridcell', update those snapshots.

B. Real conflict, InstrumentsList (SCR-05). rs-c7.behaviour.test.tsx:180 requires Tab to reach each row link + unmapped link, and :144 a control named /last message/ (old header buttons). main had a native `<table role="grid">` for exactly this ([CONV] comment, keyboard-only contract). The kit DataTable is roving focus: Tab leaves the grid, sort is on the columnheader. uix4.markup forbids `<table` there. Both cannot pass.
Proposal: add InstrumentsList.tsx to uix4 `<table` exceptions (reason: SCR-05 keyboard-only Tab order, like admin/Grid.tsx); writer restores main's table, header sort buttons become kit Button. Alternative: drop/rewrite rs-c7.behaviour:144/:180.
Not from this task (seen, not baselined: git checkout of main blocked here): PC.session undefined (printcfg1.*), timeouts (regscreen2.patient/order, h80-t06, met-t05, finctrl1), rs-c4/rs-c7.static baselines (discount routes/permissions from other merges), web-t03 card test (main already a table), regscreen1 Favourites aria-selected.
Stopped.
