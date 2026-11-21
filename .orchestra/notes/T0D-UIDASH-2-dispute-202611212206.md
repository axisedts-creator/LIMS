# T0D-UIDASH-2 dispute (writer) — 1 of 45 tests, test vs test

Test: apps/web/src/features/analytics/__tests__/uidash2.today.test.tsx:291-297
"no inline colour, gradient or font-weight 600 in the page body". It rejects ANY element with a `style` attribute that contains border, height or width.

Conflict: the same file at :78 (and done_when (1)) requires the kit PeriodPicker (`.lims-period`) in the Today header. PeriodPicker renders the kit
Select (packages/ui Select.tsx), which is react-aria-components `Select`; that ALWAYS renders react-aria's `HiddenSelect` (node_modules
react-aria-components/dist/private/Select.mjs) as a visually hidden div: `style="border: 0px; clip: rect(0px 0px 0px 0px); height: 1px; margin: -1px;
overflow: hidden; padding: 0px; position: absolute; width: 1px; white-space: nowrap"`. That is the library's screen-reader / form-autofill hiding,
not a colour or a design value, and it is not ours to remove (dropping it would break form semantics of every Select in the app).
Failure seen: `inline style on <div>: expected 'border: 0px; clip: rect(0px 0px 0px 0…' not to match /font-weight|color|background|border|…/i`.

Proposed fix (tester): skip the visually hidden pattern, e.g. ignore elements whose style contains `clip: rect(0` (or test only the `[style]`
elements outside `.lims-period`). The colour / gradient check on innerHTML (:293) already passes and stays as is.
Everything else: 44 of 45 pass (.orchestra/notes/T0D-UIDASH-2-verify.cmd).
