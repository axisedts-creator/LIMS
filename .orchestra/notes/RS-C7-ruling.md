TESTS_WRONG — A3 asserts ARIA role `table` and Tab-reachable cell links; the spec makes the kit DataTable an ARIA grid with arrow-key cell navigation.
Reasons:
1. spec/chunks/C0-foundation-contracts/04-UI-UX.md:214 — "Tab enters the grid. Arrow keys move between cells." The kit DataTable is a grid (packages/ui/src/components/DataTable/DataTable.tsx:1, react-aria Table), so `getByRole('table')` can never match; links inside cells are not separate Tab stops.
2. spec/chunks/C0-foundation-contracts/04-UI-UX.md:196 — `caption` is the accessible table name; DataTable.tsx:163 sets `aria-label={caption}`. Name matching on the caption stays valid.
3. spec/program/10-DESIGN-SYSTEM.md:107 asks for logs "as tables" visually; it does not require role=table. Behaviour is unchanged per LD-140, and MessagesList.tsx is untouched, so these tests fail on HEAD too.
Change in rs-c7.behaviour.test.tsx (A3) and rs-c7.screens.test.tsx (`messages:` cases):
- `getByRole('table', { name: /^messages$/i })` -> `getByRole('grid', { name: /^messages$/i })`; same for `/rejected uploads/i`. Keep the columnheader, row and chip assertions inside it.
- Keyboard test: assert Tab reaches the tabs, the barcode field and moves focus into the Messages grid; then press arrow keys (ArrowDown/ArrowRight, max ~20) inside the grid until `/instruments/messages/<MESSAGES[0].id>` link (or its cell) holds focus, and assert that. No mouse.
- A5 (web-t03 'renders the 04-UI-UX columns' on SCR-05): the task brief done_when (instrument list as link cards) and LD-140 override the old column layout; the tester updates that test to the card contract A1. The lead must OK that edit, because it is outside RS-C7's own test files.
After the fix, the writer records snapshots once with `-u rs-c7.screens` (LD-170).
