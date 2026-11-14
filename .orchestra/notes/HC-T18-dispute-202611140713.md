# HC-T18 dispute (writer) — timeouts, not wrong behaviour
- Runs on 16d11b40 (impl unchanged since f5e6388d): full suite 105/135 pass, then 99/135 on rerun; dialogs file alone 29/45. Every failure is `Test timed out in 20000ms`, and the number changes between runs. No assertion failed.
- Proof: `vitest ... hc-t18.dialogs --testTimeout=120000 -t "US-03-2 submit"` passes (about 63 s of test time; import alone about 150 s on this machine). The earlier writer run on the same impl passed 133/135 inside 20 s, so the time budget depends on machine load.
- Cause: the failing tests type 60–100 characters with `userEvent.type` (helpers.tsx:43 `fill`). Each character waits for a timer and re-renders a dialog of kit pickers. The board tests time out the same way.
- Requested test-side fix (tester-owned files): either raise `testTimeout` in vitest.hc-t18.config.ts (for example to 120000), or make `fill` faster by using `userEvent.setup({ delay: null })` or by pasting instead of typing. Keep every assertion.
- Writer did not edit any tests or the implementation.
