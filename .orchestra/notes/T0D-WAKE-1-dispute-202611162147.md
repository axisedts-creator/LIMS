# T0D-WAKE-1 dispute (debugger)
Test: apps/web/src/features/admin/__tests__/rs-c2.static.test.ts:121-126 ("data, action, validation-table and nav files are untouched", "same route files").
It compares against rs-c2.baseline.json, recorded for T0D-MSERIES-5 (restyle, behaviour frozen). Task brief "files" for T0D-WAKE-1 allows the actions.ts failure branch and a new auth state, so three diffs are required: actions.ts hash, messages.ts hash, new route `app/(auth)/auth/waking/page.tsx`.
Not an implementation bug. Arbiter already ruled TESTS_WRONG (T0D-WAKE-1-ruling.md item 1): tester re-records with RS_C2_RECORD=1, checks diff is only those 3 entries, commits "[tester] T0D-WAKE-1 tests revised per ruling". Debugger may not edit tests; baseline still unrecorded (last commit ec073f164).
