# T0D-UIGUARD-1-MICRO dispute (writer)
- Tests: apps/web/src/features/micro/__tests__/t19.pages.test.tsx, "permission and failure states": 500 / 503 / 400 from the list "rejects so error.tsx renders".
- Why wrong: they pin the pre T0D-UILIST-1 behaviour. Since daea33fb9 (T0D-UILIST-1, LD-353 rule 6) app/(staff)/micro/worklist/page.tsx catches ApiError and renders MicroLoadError (ErrorState with the page title) in the page, so the promise resolves. This task did not change that path (only the 403 MicroForbidden helpKey).
- Ask: tester re-pins these 3 to "renders the in-page error state with the title, no partial table". Not caused by this task; the rest of the task is done.
