# HC-T18 dispute (writer) — 2 of 135 tests cannot pass with the kit as it is; everything else passes (133/135)

## 1. `hc-t18.dialogs.test.tsx` › Assign dialog › "Route date = the visit window date and read-only …"
- Test does `within(dlg).getByLabelText(/route date/i)` (unanchored). The kit `DatePicker` (`_shared/DateFieldBase.tsx:120`) always renders a second control
  `<button aria-label="Open calendar for Route date">`, and `getByLabelText` also matches `aria-label` attributes.
- Real failure: `TestingLibraryElementError: Found multiple elements with the text of: /route date/i` (the input and the calendar button). The label text is fixed by the test and the
  button's name is built by the kit from that label, so no implementation of the spec'd `DatePicker` ("Route date `DatePicker`", 04-UI-UX §2.1) can pass.
- The Schedule dialog test avoids this by anchoring (`/^date/i`, `/^from/i`, `/^to/i`). Fix: anchor it, `getByLabelText(/^route date/i)` (two places in that test).

## 2. `hc-t18.board.test.tsx` › keyboard-only walk-through › "Tab reaches date, centre, Refresh …"
- The loop requires every Tab stop of type `button,a,[role=switch],[role=row],[role=gridcell],input` to have `aria-label`, text, `placeholder` or `aria-labelledby` **on the element itself**.
- The spec'd "Needs attention" is the kit `Switch` (react-aria): the focused element is `<input role="switch" type="checkbox">` inside a wrapping `<label>`; its accessible name comes from that label,
  but the element has no `aria-label`/text/placeholder/`aria-labelledby`, and the kit `Switch` accepts no such prop. Failure: `<input … role="switch" type="checkbox">: expected 0 to be greater than 0`.
- A probe of the whole Tab order (60 stops) found this switch to be the ONLY stop that fails; date, calendar button, centre, Refresh, Help, status list, kind, Reset and the three grids pass.
- Fix options: the test uses the computed accessible name (e.g. `el.labels?.[0]?.textContent`) for inputs, or C0 adds `aria-label` pass-through to `Switch` (not my path).

## Also seen (not blocking, not disputed)
- Kit `Button isLoading` renders "Working…" inside the button, so its name stops matching `/^schedule$/`; I used `isDisabled` while in flight (tests need the name to stay).
- `tsc` reports type errors only in the test files (`onUnhandledRequest` option, fixtures typed without `order_id`/`window_*`); none in HC-T18 source.
