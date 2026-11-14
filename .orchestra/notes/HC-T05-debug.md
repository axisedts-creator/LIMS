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

## Round 4 (real run: 34/35 pass)
- Cause: test bug, not impl. US-10-2 (booking.consumers.live.test.ts:367) does String(v.route_date).slice(0,10) on a pg `date` read back as a JS Date ("Sat Jan 02 2027...") vs the fixture's string "2027-01-02" -> "Sat Jan 02" != "2027-01-02". The consumer never writes route_date (kept as-is), so impl is correct.
- Fix: none in code (tests are off-limits). Test needs e.g. v.route_date.toISOString().slice(0,10) or a ::text cast in ownerRows. See HC-T05-dispute.md.
