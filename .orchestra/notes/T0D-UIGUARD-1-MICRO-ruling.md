TESTS_WRONG — the test asserts something the spec does not require (say precisely what to change in the test)

Reasons:
1. LD-353 rule 6 (binding lead decision, lead decisions override spec text for this task per inbox T0D-UIGUARD-1-MICRO-arbiter.md:37): "ErrorState keeps the page title and filters and shows message, reference and Retry"; LD-436 look spec .orchestra/notes/LD-436-look.md:28: "EmptyState, ErrorState and NotAvailable keep the table header". A failed read must render in the page, not throw to error.tsx.
2. apps/web/src/app/(staff)/micro/worklist/page.tsx:31-40 (from daea33fb9, T0D-UILIST-1, an ancestor of HEAD) catches ApiError and returns MicroLoadError with the title; 403 stays MicroForbidden (line 49). This task did not change that path.
3. apps/web/src/features/micro/__tests__/t19.pages.test.tsx:203-211 still pins the pre-LD-353 behaviour ("rejects so error.tsx renders"), so it fails regardless of this task.
4. The protected properties stay required: no partial table, no stale rows (03-APP-FLOW §5 intent the test cites).

Change in the test (tester):
- t19.pages.test.tsx:203-206 (500, 503) and :208-211 (400 invalid cursor): replace `await expect(worklist(...)).rejects.toBeTruthy()` with: `await worklist(...)` resolves; the page title "Microbiology" is shown; the ErrorState text is shown (the MicroLoadError message); `screen.queryByRole('grid')` is null or has no data rows; `document.body.textContent` does not contain 'Synthetic culture'. Rename to "%i from the list renders the in-page error state with the title (no partial table)" and "400 (invalid cursor) renders the in-page error state, no stale rows".
- No change to the implementation.
