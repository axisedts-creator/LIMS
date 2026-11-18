## Debug 2026-11-18 (debugger)
- Verify log: only failure is `staleFiles(ROOT)` (codegen --check) hitting the 120s test timeout; 1105/1106 passed, run took 851s. No assertion failed, no stale file reported.
- Cause: machine resource exhaustion, not code. Re-run alone: vitest "Worker exited unexpectedly" after 7m28s; direct `tsx codegen.ts --check` could not fork (`0xC000012D` out of commit, "fork: Resource temporarily unavailable") with 9 lanes running.
- Fix: none in implementation (generated files not shown stale, test not wrong). Re-run verify when lane load/memory is low. If it still times out on a quiet machine, the 120_000 timeout needs a lead decision (I may not edit tests).
