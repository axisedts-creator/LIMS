# T0C-REGPARITY-1 debug
- Failure: verify log ends `bash: db/tests/run-suites.sh: No such file or directory`; vitest part passed (28/28). No test or implementation assertion failed.
- Cause: verify step 2 ran with cwd != repo root (file exists at db/tests/run-suites.sh; `%~dp0..\..` in verify.cmd resolves wrong if the cmd is run from a copy outside .orchestra/notes/). Harness/path issue, not implementation.
- Fix: none in code. Re-ran `bash db/tests/run-suites.sh db/tests/frontdesk_billing/T0C-REGPARITY-1_patient_parity.test.sql` from repo root: no `not ok`, finished (52s), git tree clean. Re-run verify with cwd = repo root / cmd left in .orchestra/notes/.
