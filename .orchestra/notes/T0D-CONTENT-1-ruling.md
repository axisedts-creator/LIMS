TESTS_WRONG — the test asserts something the spec does not require (say precisely what to change in the test)
- Disputed: apps/web/src/features/engagement/__tests__/t-l1.app-access.test.tsx:85 uses `screen.getByRole('button', { name: /issue app code/i })`, which throws when more than one match exists, so it requires exactly one "Issue app code" button.
- Spec requires only the W8 empty text "This patient has no app access" (spec/chunks/C16-patient-engagement/03-APP-FLOW.md:508) and, per the test's own title, that the Issue action is still available. No spec line limits the page to a single Issue button.
- The second button is the empty-table repeat added by T0D-EMPTYTBL-2 (AppAccess.tsx:223, comment cites LD-310/LD-336) and is pinned by catalog/__tests__/emptytbl2.other.test.tsx:54. A lead decision outranks the chunk docs (CLAUDE.md precedence), so the repeat stays.
- LD-353 rule 6 (EmptyState has at most one button) holds: each EmptyState has at most one; the page-level button sits outside the tables.
- CHANGE THE TEST at t-l1:85 to: `expect(screen.getAllByRole('button', { name: /issue app code/i }).length).toBeGreaterThanOrEqual(1);` The title and the text assertion stay as they are.
- Do not change emptytbl2.other.test.tsx or AppAccess.tsx. This failure does not come from T0D-CONTENT-1.
