# T0D-BUILD-1 debugger
- Cause: verify.cmd step 1 (tests/billing/T0D-BUILD-1.pg.sh) needs a Docker PG17; daemon is down ("failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine"). Environment fault, not an implementation or test defect. Log has no vitest output.
- Fix: none in code (nothing to change). Start Docker Desktop (or export LIMS_TEST_APP_URL + LIMS_TEST_SUPER_URL) and re-run verify. Web steps were already green per impl note (441 pass).
- acct1 dispute: ruling TESTS_WRONG already handled by tester commit f594e34a0; no dispute file needed from me.
