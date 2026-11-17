# T0B-FILESTREAM-1 debug
Cause: no code bug. verify.log: 917 tests pass; only 2 suites fail to load (frontdesk trf content.test.ts, upload.test.ts): `LIMS_TEST_APP_URL is not set`. T0B-FILESTREAM-1-verify.cmd runs the DB-backed TRF dir with plain vitest, no PG17 boot.
Fix: none in implementation code (none needed). Ran `bash tests/frontdesk/FD-T10.pg.sh` (boots PG17): TRF suite 4 files 70/70 pass, second suite 2 files 27/27 pass.
Action for tester/lead: change verify.cmd to run the TRF dir through tests/frontdesk/FD-T10.pg.sh (or export LIMS_TEST_APP_URL + LIMS_TEST_SUPER_URL). I did not edit it (test-side file).
