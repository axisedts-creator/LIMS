APPROVE
Scope reviewed: `git diff e5273e79..HEAD` (3 commits: arbiter ruling, tester revision, writer re-run note).
- Code under apps/web: only three test files under features/catalog/__tests__ (owned path). No source, route, permission, RLS, migration, logging or secret change in this range.
- Test edits match the TESTS_WRONG ruling items a-d verbatim (emptytbl1 ALLOW entry and expected keys; anatomic "New batch" exactly once per LD-353 rules 4, 6; WorksheetListPage retitle and placeholder assertion removed). No other assertion weakened; lines 120-121 (Retry shown, no empty message) kept.
- `within` imported in emptytbl2.anatomic.test.tsx; `expectCreateTwice` still used at line 46.
- Checks run by reviewer (2026-11-20): pricetools1 193/193, emptytbl2 48/48, web-t34 116/116, testimport1 70/70, web-t38 216/216, uilist3 173/173, rs-c2 74/74. Worktree clean after (no snapshot rewrite).
- Not re-reviewed in this range: price tool implementation from earlier rounds (unchanged since e5273e79).
