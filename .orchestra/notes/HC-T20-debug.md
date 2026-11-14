# HC-T20 debugger (2026-11-14)
Cause: not an impl bug. verify.cmd runs vitest with default parallel forks; jsdom import is slow here (~50s/file), so workers hit "Timeout waiting for worker to respond" (4 files never started; source test 44/44 passed).
Evidence: `--maxWorkers=1 --testTimeout=60000 --hookTimeout=120000 --teardownTimeout=120000` gives 5/5 files, 148/148 pass, 0 errors. Plain `--maxWorkers=1` still gave 3 worker errors.
Fix: no impl change. Verify cmd/config are not impl-owned; lead/tester should add `--maxWorkers=1 --hookTimeout=120000 --teardownTimeout=120000` (or test.pool timeouts) to HC-T20-verify.cmd.

## Round 2 (2026-11-14): 1 fail / 148 — settings "same code twice" (hc-t20.settings.test.tsx:250)
Cause: not an impl bug. SettingsForm.tsx:71 already sets "Each payment method can be used once only." and renders it in role=alert (:157). Test passes alone (1/1, same config, --maxWorkers=1); it only failed in the full 5-file run, where `waitFor` (default 1000ms asyncUtilTimeout) expired on a slow jsdom render (page dump shows the form, no error yet).
Fix: no impl change. Tester/lead: set `asyncUtilTimeout` (e.g. 10000 via configure() in vitest.hc-t20 setup) or pass an explicit `{timeout}` to that waitFor; re-run verify.
