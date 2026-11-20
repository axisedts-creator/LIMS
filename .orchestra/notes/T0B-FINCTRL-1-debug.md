## debugger 2026-11-18 (verify log: 5 boot-test failures)
Cause: not a FINCTRL defect. Verify run took 385s under load; the core autoload (imports every module via vite-node) exceeded the tests' hardcoded 60_000 ms timeout in billing/frontdesk boot.test.ts. "module X: index.ts exports no manifest" (partners, quality, reporting: a different module each run) is the knock-on of the timed-out import, not a missing manifest (partners/index.ts exports it).
Evidence: the same frontdesk boot test alone passes (autoload test 48.7s of 60s); runs 1-3 had no boot failure. No new import in the FINCTRL files is heavy. No code change made; tests untouched.
Next: re-run verify on an idle machine (other lane windows closed). If boot still exceeds 60s with no load, that is a core autoload speed issue (T0B-BOOTGATE-1 area), not this task.

## debugger 2026-11-18 20:37 (round 2: 2 boot-test failures)
Cause: same as round 1, not a FINCTRL defect. Only billing/frontdesk boot.test.ts "bootstrap" failed: "Test timed out in 60000ms" (frontdesk bootstrap took 131s, autoload 48s, file 229s) while 24 of 26 files and 752 of 754 tests passed. The 12 failures of runs 1-3 (carryForward, append-only ledger) are gone.
Fix: no code change, tests untouched. Hardcoded 60_000 ms in the boot tests is below core autoload time under lane load (T0B-BOOTGATE-1 area). Re-run verify with other lane windows closed.

## debugger 2026-11-18 20:42 (round 3: 1 boot-test failure)
Cause: not a FINCTRL defect. Only billing/boot.test.ts "bootstrap resolves..." failed: "Test timed out in 60000ms" (hardcoded 60_000 in the test) while 753 of 754 tests passed; frontdesk boot passed this time. Core autoload time is load dependent.
Evidence: billing boot.test.ts alone, run now: 9/9 pass, 46s. No FINCTRL import is heavy.
Fix: no code change, tests untouched. Re-run verify with other lane windows closed; persistent >60s autoload is a core/T0B-BOOTGATE-1 speed issue.
