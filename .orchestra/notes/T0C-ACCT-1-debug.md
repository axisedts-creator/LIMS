# T0C-ACCT-1 debug
- Log: all 4 vitest files pass (1063/1063); the only failure line is `The system cannot find the path specified.` right after, so no test failed and no implementation defect shows in the log.
- Cause (unconfirmed): the error comes from a later step of `T0C-ACCT-1-verify.cmd`, not from code. The `contracts`, `services/api` role-packs and pgTAP paths all exist, so the likely culprit is the hardcoded `C:\Program Files\Git\bin\bash.exe`. Not confirmed: I could not run the script (shell approval denied).
- Fix: none made in implementation code. Lead to run the verify script by hand, or point it at the real bash path.
## round 2
- Ran every verify step by hand: codegen vitest 1063/1063, contracts registry-equality 5 passed, role-packs 765/765, pgTAP T0C-ACCT-1 suite finished with no failure (96s).
- Cause: no code defect. Trailing `The system cannot find the path specified.` is harness/cmd path error (likely hardcoded `C:\Program Files\Git\bin\bash.exe` or `cd /d` under the runner), not a test failure.
- Fix: none in implementation code. Lead: treat verify as green, or fix the runner bash path.
## round 3
- Log (08:37) shows codegen vitest 1063/1063 green, then only `The system cannot find the path specified.` Every path in verify.cmd exists (contracts, registry-equality test, services/api, run-suites.sh, ACCT-1 pgTAP file, Git bash).
- Cause: harness/cmd error after step 1 (`%~dp0`-relative `cd /d` or runner shell), not an implementation defect. Fix: none in code (tests untouched). Lead: run steps 2-4 of verify.cmd directly or fix the runner; see LD-311.
## round 4
- New log (09:00): path error is gone (LD-317 worked). Now 4 `lintRepo` tests time out at 120000ms (acct1, c4, regparity1, regparity2); 1059/1063 pass, run took 433s.
- Cause: load, not code. Run alone, acct1-openapi.test.ts passes 143/143 in 39s (lintRepo 13s). The 4 files run in parallel on a busy machine, so each whole-repo lintRepo starves past the 120s testTimeout; vitest also logged `Timeout calling "onTaskUpdate"`.
- Fix: none in implementation code, tests untouched. Lead: rerun verify on an idle machine, or add `--no-file-parallelism` to step 1 of verify.cmd.
## round 5
- Log (09:07): 1063/1063 pass but vitest exits non-zero: `Unhandled Error: Timeout calling "onTaskUpdate"` (4 files each run whole-repo lintRepo in parallel; worker RPC starves). `&&` chain stops, steps 2-4 never run.
- Cause: parallel load, not a code defect. Fix: `fileParallelism: false` in tools/codegen/vitest.config.ts (config only; no test touched, nothing narrowed). Not re-run: full serial run is ~4+ min, left to verify.
