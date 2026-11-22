# T0D-UIX-3 dispute (writer, 2026-11-22)
Markup converted. All raw `<table`, `<dl` and `<button` tags are gone. 10 of the 11 uix3 tests pass. Every failure left comes from a test that pins the OLD native markup. DONE WHEN 6 allows changing those tests, but only the tester may change them. tsc shows no lab errors. vitest.uiguard1 is green (36/36).

## 1. uix3.markup.test.ts:68 "former raw-button screens ... PendingPage": TEST WRONG
PendingPage's old raw button was `role="switch" aria-checked`. It is now the kit `Switch` (role=switch). lab-t26:278 and uidash1:159/186 need `getByRole('switch', {name: /over target only/i})`. The kit Button can't be a switch, so the test should accept `<Switch\b` for PendingPage, or drop PendingPage from that list.

## 2. The kit DataTable is a react-aria grid (role=grid, rows=row, cells=gridcell), not role=table/cell
These queries fail: `getByRole('table', ...)`, `getByRole('cell')`, counts of `tr` rows (the empty state is one row), and the rs-c5 DOM snapshots.
- verlevel1.queues (43) and c5-t21.queues (25): `getByRole('table', {name: /queue/i})` / 'Results' → use 'grid'.
- lab-t25.holds (28): `getByRole('table')`; plus 1 `role="alert"` that cascades from it.
- lab-t26.worklists (4): getByRole('cell') and "0 data rows" (the EmptyState sits in a row).
- lab-t27.board:80, lab-t30.detail:120, adminpage-lab-1.critical-values:149/216, uiconsole1 critical-values (1), uidash1 pending (2), uilist1 critical values + ingest exceptions (4): role table/cell and row counts.
- rs-c5.screens (3 snapshots): need `-u` after review.
## 3. Keyboard: needs a lead decision (a behaviour change, not only markup)
In a react-aria grid, Tab does not stop on the links and buttons inside cells. The user reaches them with the arrow keys. These tests fail for that reason: adminpage-lab-1.worklists:172 ("Tab visits department links"), adminpage-lab-1.critical-values ("Tab reaches the row links"), rs-c5.behaviour:178 ("Tab to the row button").
Choose one: accept the grid keyboard model (the tests then use arrow keys), or change the kit DataTable (packages/ui, out of this task's scope).
