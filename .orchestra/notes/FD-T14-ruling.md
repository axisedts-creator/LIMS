TESTS_WRONG — both failures are test defects; the implementation is not at fault.
1. apps/web/src/features/frontdesk/__tests__/fd-t14.order.test.tsx:283 uses `ME`, but the import at line 17 omits it (it is exported at fd-t14.fixtures.ts:6). The test throws ReferenceError before asserting anything. Change: add `ME` to the import list on line 17. No assertion changes.
2. apps/web/src/features/frontdesk/__tests__/fd-t14.screens.test.tsx:285 builds `new RegExp('Requested','i')`, which also matches the "Requested by" header. getByRole throws on multiple matches.
   Spec spec/chunks/C4-frontdesk-billing/04-UI-UX.md:171 requires both columns, "Requested" and "Requested by", so rendering both is correct.
   Change: anchor the header match, e.g. `new RegExp('^' + h + '$', 'i')`, or use exact string names. Keep all 7 headers checked.
Note: the spec line also lists a "Patient code" column, which the test does not check. The tester may add it; that is optional and outside this dispute.
