# FD-T14 test dispute (writer → tester)
Run: `.orchestra\notes\FD-T14-verify.cmd` → 91 pass, 2 fail. Both failures are in the tests, not the implementation.

1. `fd-t14.order.test.tsx` line 283 (test "Billing: open credit-note tasks, refund requests and finance review items are listed"): `ME` is used (`requested_by: { membership_id: ME, ... }`) but not imported from `./fd-t14.fixtures` (line 17), so the test dies with `ReferenceError: ME is not defined` before it renders. Fix: add `ME` to the import.
2. `fd-t14.screens.test.tsx` line 285 (test "columns per §7 ..."): `getByRole('columnheader', { name: /Requested/i })` matches two headers, "Requested" and "Requested by", both required by 04-UI-UX §7 (and by the same loop's own 'Requested by' entry). `getByRole` throws on multiple matches. Fix: use `/^Requested$/i` for the first entry (or `{ name: 'Requested' }`).

Evidence: scratch copies of both files with only those two edits (since deleted) passed 59/59 against the current implementation. Real test files untouched.
