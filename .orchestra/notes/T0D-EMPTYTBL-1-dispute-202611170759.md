# T0D-EMPTYTBL-1 dispute (writer)
Test: `emptytbl1.screens.test.tsx` > catalog list screens > Doctors — fails `expectCreateTwice` ("Unable to find … role button name /^new |^add /i").
Why the test is wrong: `MANAGE` (line 58) grants `catalog.doctor.manage`, a permission code that does not exist in spec/ or contracts/ (grep: 0 hits).
The spec code is `catalog.referrer.manage` (55 hits); `DoctorsList` gates New doctor on `canManageDoctors` = `catalog.referrer.manage` (DoctorDetail.tsx:22).
Permission codes are off limits (LD-310 (d)), so the code is not changed. The screen itself meets the contract: with `catalog.referrer.manage`
the header has "New doctor" and MasterTable repeats it in the message row (emptyAction), plus 4 placeholder rows.
Fix (tester): add `'catalog.referrer.manage'` to `MANAGE` (keep or drop `catalog.doctor.*`). Everything else in the suite passes (28/29).

## 2. web-t34.components.test.tsx:151 (existing test) conflicts with done_when (3)
`show([])` then `press(/new price list/i)` uses `getByRole` (line 108), which now finds TWO buttons: the header one and the one the
brief requires repeated in the empty message row (emptytbl1 `expectCreateTwice(/^new price list$/i)` demands exactly that). Both cannot pass.
## 4. packages/ui ui-r03-kit-pass.test.tsx:638 snapshot "DataTable: compact, sticky, sorted, empty"
Changes only by the four `<div class="lims-row-placeholder" aria-hidden="true">` the tester contract requires in kit DataTable empty states.
Fix (tester): re-record (`pnpm --dir packages/ui exec vitest run -u -t "DataTable: compact, sticky, sorted, empty"`).

## 3. lab-t27.board.test.tsx:79 (existing test) conflicts with done_when (1)
`expect(screen.queryByRole('table')).toBeNull()` on an empty board. The brief names the status board: it must draw its headers when empty.
Fix (tester): drop that line or assert the table with headers instead (the message text assertion on line 78 still passes).

Fix for #2 (tester): in that test press the header button, e.g. `getAllByRole('button', { name: /new price list/i })[0]`. Writer left the code meeting the new contract.
