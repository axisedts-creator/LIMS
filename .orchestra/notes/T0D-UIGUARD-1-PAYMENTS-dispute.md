# T0D-UIGUARD-1-PAYMENTS dispute (writer)
- TESTS_WRONG, old-markup pins only (done_when 6): apps/web/src/features/payments/__tests__/pg-t18.review.test.tsx:84 `getByRole('table', { name: /Payments needing review/ })` and :232 `within(screen.getByRole('table'))`.
- Why: review item 1 / LD-439 done_when 2 put the review list on kit DataTable (react-aria Table, role="grid"), and rs-c15.behaviour (tester-owned, now green) asserts `getByRole('grid')` on the same list. Both cannot hold; the native `role=table` is the pre-rebuild markup.
- Fix for the tester: `'table'` -> `'grid'` on those two lines. Nothing else in pg-t18 changes (87/89 green).
