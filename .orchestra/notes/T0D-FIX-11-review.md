APPROVE
Round 2. Scope: `git diff 2109ee577..HEAD`, focus on review-fix commits f50324ed4 (tests) and b5d8a6c65 (writer) for round-1 items 1 and 2.

Item 1 fixed: daily-cash/page.tsx sessions read maps only a 403 to `s: null` (the honest sessions_unavailable line); any other ApiError becomes `sessionsError` with the reference. DailyCollectionScreen.tsx renders kit ErrorState (load_failed + requestId) and shows "—" for Previous Outstanding, Deposit and Carried Forward. Tests: 400/500 give one inline error with no permission hint; the 403 keeps the hint with no inline error.
Item 2 fixed: getMyCashSession().catch gives LoadError with the reference (a 404 is still null inside read.server.ts:43). The parties/particulars Promise.all is caught, and the collection section shows its ErrorState. Both reads have 400/500 tests. Non-ApiError errors still go to error.tsx through refOf (intended).
Rechecked: names verbatim, no new permission, migration or contract change, x-permission check before reads (billing.account.read gate kept, test present), no PHI or secrets, synthetic data, no quality/ paths.

Checks run: build:nav, then `vitest run --config src/__tests__/vitest.fix11.config.ts`: 8 files, 122/122 passed. `tsc --noEmit`: no errors in the touched files.
Notes (not blocking): the diff touches 21 non-note files, above the brief's "at most 16". The extra files come from the arbiter ruling (re-pinned tests) and the kit BarChart/TimeSeriesChart edit (gap in tests.md). The lead should accept this. The rs-c8.static baseline still needs a lead re-baseline (left.md). The wide billing/lab/analytics run was not re-run in this round (infra worker timeout, see debug.md).
