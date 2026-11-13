# HC-T09 dispute (1 test)
Test: `__tests__/dispatch/schedule.test.ts:37` "the window alone (no address object) keeps the stored address and does not touch coordinates".
Body is `win(6, 0)` = `window_start 2026-11-12T06:00:00Z`, `window_end 2026-11-12T06:00:00Z` (`mins = 0` makes end == start).
Spec: H5 refuses `end <= start` with 400 `common.validation_failed` (02-TRD §5.1 H5; DB `visits__window__ck` needs `window_end > window_start`). The same file asserts it ('end == start' case, line 62), so this call can never be a 200.
Fix (tester): use a positive span, e.g. `win(6, 30)`. Writer did not edit the test; implementation is spec-correct.
Result: 201 of 202 pass; only this test fails, only for that reason.
