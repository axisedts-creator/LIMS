TESTS_WRONG — the frontdesk tests pin the old raw-table ARIA role; change `getByRole/findByRole/queryByRole('table', …)` to `'grid'` (same accessible name /selected tests/i) in fd-t13.keyboard.test.tsx:141, regscreen1.items.test.tsx:50, regscreen2.order.test.tsx:197, regscreen2.drafts.test.tsx:39 and :159. Nothing else in those tests changes.

Reasons:
- Brief DONE WHEN (1) (.orchestra/inbox/T0D-UIX-4-arbiter.md:19): every raw `<table` under features/frontdesk becomes the kit DataTable, so RegistrationForm's cart table must be DataTable; uix4.markup.test.ts enforces exactly that (DONE WHEN (5)).
- Brief DONE WHEN (6) (same line): "only tests that pinned the old markup change" — role "table" is the old raw `<table>` markup, so these tests are the allowed exception.
- LD-442 (arbiter.md:34): "a test that pins old markup may change, nothing else".
- The kit DataTable is built on react-aria Table with role=grid (packages/ui/src/components/DataTable/DataTable.tsx:2, spec 04-UI-UX §2.5). The spec asks for the kit component, not for role "table".
- react-aria still renders native table/tbody/tr with role=grid, so regscreen2.drafts.test.tsx:159 `querySelectorAll('tbody tr')` keeps working once only the role changes.
- rs-c4.ledger.test.tsx:41 already accepts both 'grid' and 'table'; that is the pattern to follow.
- The implementation stays as it is; no spec change, so no CR is needed.
