# T0C-ACCT-1 debug
- Log: all 4 vitest files pass (1063/1063); the only failure line is `The system cannot find the path specified.` right after, so no test failed and no implementation defect shows in the log.
- Cause (unconfirmed): the error comes from a later step of `T0C-ACCT-1-verify.cmd`, not from code. The `contracts`, `services/api` role-packs and pgTAP paths all exist, so the likely culprit is the hardcoded `C:\Program Files\Git\bin\bash.exe`. Not confirmed: I could not run the script (shell approval denied).
- Fix: none made in implementation code. Lead to run the verify script by hand, or point it at the real bash path.
## round 2
- Ran every verify step by hand: codegen vitest 1063/1063, contracts registry-equality 5 passed, role-packs 765/765, pgTAP T0C-ACCT-1 suite finished with no failure (96s).
- Cause: no code defect. Trailing `The system cannot find the path specified.` is harness/cmd path error (likely hardcoded `C:\Program Files\Git\bin\bash.exe` or `cd /d` under the runner), not a test failure.
- Fix: none in implementation code. Lead: treat verify as green, or fix the runner bash path.
