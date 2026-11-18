## Debug 2026-11-18 (debugger)
- Verify log: only failure is `staleFiles(ROOT)` (codegen --check) hitting the 120s test timeout; 1105/1106 passed, run took 851s. No assertion failed, no stale file reported.
- Cause: machine resource exhaustion, not code. Re-run alone: vitest "Worker exited unexpectedly" after 7m28s; direct `tsx codegen.ts --check` could not fork (`0xC000012D` out of commit, "fork: Resource temporarily unavailable") with 9 lanes running.
- Fix: none in implementation (generated files not shown stale, test not wrong). Re-run verify when lane load/memory is low. If it still times out on a quiet machine, the 120_000 timeout needs a lead decision (I may not edit tests).

## Debug round 2 (debugger)
- Latest verify log (08:16, 804s): 4/4 files, 1106/1106 tests PASSED; exit non-zero only from 4 "Timeout calling onTaskUpdate" unhandled errors (vitest worker RPC starved while whole-repo lintRepo / codegen --check block the worker 40-100s under 9-lane load; same known cause as T0C-ACCT-1, see tools/codegen/vitest.config.ts comments).
- No assertion failed, no stale generated file, no implementation defect. testTimeout 300_000 and fileParallelism:false already set; vitest's 60s RPC timeout is not configurable. Changed nothing.
- Needs lead: re-run verify on a quiet machine (lintRepo is 13s idle), or accept 1106/1106 green as pass.
