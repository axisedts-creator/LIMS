TESTS_WRONG — `hc-t20.devices.test.tsx:200` asserts over `document.body`, which always contains the D3 status word "Wipe requested" required by the same file's status test (`:78-80`, from `DEVICES` rendered by `view()` at `:46`), so the regex `/wipe (is )?(requested|scheduled)|will be wiped/i` can never be absent.

Reasons:
- Spec requires the 409 path only as `409 common.version_conflict (already wiped)` for H17 (spec/chunks/C17-home-collection/02-TRD.md:193); the test's intent (plain sentence, no raw code, no success message) is fine.
- The spec requires `wipe_requested` to be a listed device status (02-TRD.md:220; 03-APP-FLOW.md:54), and LD-140 requires every status to show its word, so the table legitimately renders "Wipe requested". The assertion conflicts with that, not with the implementation.
- Change in the test (pick one, keep the intent):
  (a) In this test call `view({ devices: [D1] })` so no row shows "Wipe requested"; and/or
  (b) scope the negative assertion to the toast/status region and the dialog, e.g. `screen.queryAllByRole('status')` / `queryAllByRole('alert')` text plus `within(dlg)`, instead of `document.body`; also assert D1's row still shows "Active" (no optimistic status flip).
- Keep `:198` (plain sentence matching /already|changed|reload|refresh/i) and `noRawCodes()` unchanged.
- Side note (not disputed): `:159` positive check has the same body-wide flaw and is vacuously true; tester should scope it to the toast region too.
