# AN-T18 debug
- Failure: states.test.tsx "error.tsx … Retry" timed out at 15000ms (27 s). Only failure; page/source files green (57/58).
- Cause: not an impl bug. First test in file does the cold dynamic import of error.tsx → @lims/ui ErrorState while the heavy page test file transforms in parallel (import 47% of 44 s). Later tests in the same file take <500 ms; error.tsx is 14 lines, only imports ErrorState.
- Rerun of the same verify cmd: 3 files / 58 tests pass (18 s). Same one-off flake seen in impl notes. No impl change made; tests untouched.
- Residual: cold-start flake can recur under load; fix would be test-side (testTimeout / warm-up import in the tester-owned vitest.an-t18.config.ts) — not mine to edit.
