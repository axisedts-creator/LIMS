# HC-T05 debug
- Cause: environmental, not code. verify.log is one line: docker API unreachable (`dockerDesktopLinuxEngine` pipe missing, Docker Desktop not running). No test ran, so no impl failure observed.
- Fix: none in code; no change made. Impl/tests untouched, no dispute (tests not shown to contradict spec).
- Next: start Docker Desktop, rerun `.orchestra\notes\HC-T05-verify.cmd` (or export LIMS_TEST_APP_URL + LIMS_TEST_SUPER_URL and run vitest in services/worker). Expect small fixture fixes per tests note; real failures then need a fresh debug pass.
