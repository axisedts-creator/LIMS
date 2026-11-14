# HC-T20 debugger (2026-11-14)
Cause: not an impl bug. verify.cmd runs vitest with default parallel forks; jsdom import is slow here (~50s/file), so workers hit "Timeout waiting for worker to respond" (4 files never started; source test 44/44 passed).
Evidence: `--maxWorkers=1 --testTimeout=60000 --hookTimeout=120000 --teardownTimeout=120000` gives 5/5 files, 148/148 pass, 0 errors. Plain `--maxWorkers=1` still gave 3 worker errors.
Fix: no impl change. Verify cmd/config are not impl-owned; lead/tester should add `--maxWorkers=1 --hookTimeout=120000 --teardownTimeout=120000` (or test.pool timeouts) to HC-T20-verify.cmd.
