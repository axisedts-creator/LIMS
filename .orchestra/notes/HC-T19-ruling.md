TESTS_WRONG — the test asks for an ARIA role (`table`) that the component named in the spec never renders.

Reasons:
- spec/chunks/C17-home-collection/04-UI-UX.md:61 says the Tubes card must be a `DataTable`. It does not mention any ARIA role.
- The kit `DataTable` is built on the react-aria Table and renders `role="grid"` (packages/ui/src/components/DataTable/DataTable.tsx:2, :137-138). So `getByRole('table')` cannot match it.
- LD-140 (task brief) requires screens to use packages/ui components only, so a raw `<table>` that would give role=table is not allowed either.
- The test is the only thing that conflicts here: it requires a role that the spec does not ask for and that the required component cannot produce.

Change in apps/web/src/features/homecollection/__tests__/hc-t19.detail.test.tsx:
- Line 94: change `within(card('Tubes')).getByRole('table')` to `within(card('Tubes')).getByRole('grid')`. Keep every assertion after it (columnheader, row count 1+3, Applied / On hold / Typed — not verified / Camera / Scanner).
- Line 128: change `queryByRole('table')` to `queryByRole('grid')`. Better still, assert the empty-state text, because the current `?? card(...)` makes the check pass no matter what.
