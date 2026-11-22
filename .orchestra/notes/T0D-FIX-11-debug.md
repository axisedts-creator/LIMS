# T0D-FIX-11 debug
- Verify log: 7 files / 77 tests passed; only red is 1 unhandled error: `[vitest-pool-runner]: Timeout waiting for worker to respond` while starting a fork for bl-t20.screens.test.tsx (run took 226 s, 134 modules evaluated 440 times).
- Cause: infra, worker start timeout under load (cold import of the kit per fork). Not an assertion failure, no implementation defect. bl-t20 itself was 113/113 green in the fix11 config (impl.md).
- Fix: none in sources (nothing to change). Re-run verify on a quiet machine, or fewer forks / `isolate: false` (vitest hint in the log); that is a runner setting, not mine to edit. No dispute: tests do not contradict the spec.
- Not verified: bl-t20 alone with the per-feature config (plain `vitest run` uses the wrong config, 36 fails from config isolation, pre-existing).
