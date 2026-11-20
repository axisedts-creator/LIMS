# VERIFY-GREEN-7 — typecheck counts per package (`npx turbo run typecheck --continue --force`, 2026-11-19)

| package | before (e98ca0ace) | after (HEAD d72534e1c) |
|---|---|---|
| @lims/web | 365 (derived: 287 + 78 in-scope) | 287 (in-scope features/{instruments,inventory,partners,quality}: 0) |
| other 10 packages | 0 (derived: unchanged since e98ca0ace) | 0 (10 of 11 tasks successful) |

- AFTER: measured at HEAD. Only @lims/web fails; none of its 287 errors are under the four in-scope dirs.
- BEFORE: derived, not measured. `git diff --name-only e98ca0ace..HEAD` lists only the 55 in-scope test files and helpers plus notes, so the only change in errors is the 78 in-scope errors the tester measured at e98ca0ace (tsc -p apps/web, see VERIFY-GREEN-7-tests.md). Running the "before" measurement needs a temporary checkout of e98ca0ace in the 4 dirs, which was not permitted in the writer session.
- The 287 remaining @lims/web errors are in other feature dirs (lab, admin, payments, anatomic...) and belong to other VERIFY-GREEN tasks.
- 4 red tests (product/contract drift, not caused by this diff): see `.orchestra/cr/VERIFY-GREEN-7.md`.
