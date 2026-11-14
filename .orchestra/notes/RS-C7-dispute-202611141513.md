# RS-C7 dispute (writer)
Tests wrong: A3 in rs-c7.behaviour.test.tsx (3 tests) and the two `messages:` cases in rs-c7.screens.test.tsx. Tester said "not run, no node_modules"; I ran them.
1. They use `getByRole('table', {name: /^messages$/i})` and `{name: /rejected uploads/i}`. The kit DataTable is react-aria Table with role=grid (DataTable.tsx line 1 comment; accessible names are "Received Instrument Kind ..."). No table role exists. MessagesList.tsx is untouched by me, so these fail on HEAD too. Existing web-t02/t03 tests use `columnheader` only, never role table.
   Fix is in the test: use role `grid` (name = caption "Messages" / "Rejected uploads"; the name seen is the column headers, so match the grid by columnheaders), or drop the role query.
2. A3 keyboard test expects Tab to reach the first message link. In a react-aria grid, cells use roving focus (arrow keys), so links in cells are not Tab stops; received only `link:/instruments/instruments`. Same kit behaviour; not changeable under my paths (packages/ui not owned). Test should use arrow keys or not require the row link.
3. A5 (already flagged by tester): web-t03 'renders the 04-UI-UX columns' pins SCR-05 columnheaders; conflicts with link cards by design (LD-140).
Snapshots (`rs-c7.screens`) not recorded: the messages cases would fail first. Record with `-u rs-c7.screens` once A3 is corrected.
