TESTS_WRONG — the test asserts something the spec does not require (say precisely what to change in the test)

Change: apps/web/src/features/lab/__tests__/adminpage-lab-1.critical-values.test.tsx:75 — make `links()` use `screen.queryAllByRole('link')` instead of `screen.getAllByRole('link')` (same filter). No other change; the assertion at :185 `expect(links()).toEqual([])` stays.

Reasons:
1. spec/chunks/C5-lab-workflow/04-UI-UX.md:207 defines the empty state as only `Empty: "No critical values."` — no link, no control. A correct empty page therefore renders zero links.
2. `getAllByRole` throws when no element matches, so test :181-186 fails on exactly the spec-conformant empty state; the intent ("no row link") needs `queryAllByRole`.
3. The other uses of `links()` (:128) run with 4 rows, so `queryAllByRole` keeps them equally strict (they then fail on missing hrefs via `toContain`, not silently pass).
4. The sibling worklists test already uses `queryAllByRole('link')` for its empty/forbidden cases (adminpage-lab-1.worklists.test.tsx:78, :89, :144) — same convention.
5. Adding a link to the empty state to satisfy the test would be an invented control (LD-250 / brief RULES: no stub, no invented control). Implementation stays as is.
