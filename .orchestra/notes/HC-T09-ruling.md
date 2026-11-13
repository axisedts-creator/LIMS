TESTS_WRONG — the test asserts something the spec does not require (say precisely what to change in the test)
- Disputed test: services/api/src/modules/homecollection/__tests__/dispatch/schedule.test.ts:37 sends `win(6, 0)`, i.e. window_start == window_end == 2026-11-12T06:00:00Z, and expects 200.
- Spec says H5 refuses end ≤ start with 400 common.validation_failed: spec/chunks/C17-home-collection/02-TRD.md:181.
- The schema needs end > start: 05-SCHEMA.md:104 ("end > start") and the CHECK `visits__window__ck` at 05-SCHEMA.md:270-271 (`window_end > window_start`).
- The same test file already asserts that 'end == start' gives 400 (schedule.test.ts:62). Line 37 contradicts it.
- The test's purpose is to check that a window-only body keeps the stored address and coordinates. The zero-length window is accidental.
- Fix: on line 37, change `win(6, 0)` to a positive span, e.g. `win(6, 30)` (06:00–06:30Z, NEAR date, within 30 days). Keep the other assertions as they are.
- No change to the implementation.
