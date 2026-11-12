# HC-T05 debug
- Cause: environmental, not code. verify.log is one line: docker API unreachable (`dockerDesktopLinuxEngine` pipe missing, Docker Desktop not running). No test ran, so no impl failure observed.
- Fix: none in code; no change made. Impl/tests untouched, no dispute (tests not shown to contradict spec).
- Next: start Docker Desktop, rerun `.orchestra\notes\HC-T05-verify.cmd` (or export LIMS_TEST_APP_URL + LIMS_TEST_SUPER_URL and run vitest in services/worker). Expect small fixture fixes per tests note; real failures then need a fresh debug pass.

## Round 2
- Cause unchanged: verify.log still only the docker pipe error; `docker info` re-checked, daemon still unreachable. No test output exists, so no code root cause to fix.
- Fix: none; impl/tests untouched, no dispute. Blocked on Docker Desktop running; rerun HC-T05-verify.cmd after.

## Round 3
- Cause unchanged: docker client OK but daemon pipe (`dockerDesktopLinuxEngine`) still missing; no test output exists, so no code root cause.
- Fix: none; impl/tests untouched, no dispute. Blocked on Docker Desktop running; then rerun HC-T05-verify.cmd.
