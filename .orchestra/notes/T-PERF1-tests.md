# T-PERF1 tests — tester (LD-184 reset)
- Test: `services/api/src/modules/engagement/__tests__/load.scenarios.test.ts` (ruling items 3-5 applied: win32 accepts k6 exit 0|99, send() direct at delay 0, mock(0) fast tests, slow-mock unchanged).
- Tester-owned scenario files, committed: `__tests__/load/engagement.k6.js`, `consumer.pgbench.sql`, `seed.mjs` (TRD §12 rates/budgets, nothing weakened).
- Run: `.orchestra\notes\T-PERF1-verify.cmd` (vitest via services/api; needs k6 on PATH). Result here: 24/24 pass on win32.
- NOT done: p95 evidence at SCALE=1/10 (needs Linux/staging: `k6 run -e SCALE=10 ...`, then SCALE=1) and real pgbench run (not installed). Writer raises non-blocking CR cr/T-PERF1.nonblocking.md. Budgets are NOT proven met.
- Not covered: queue ops 50 ms, OTP verify 250 ms, report download 500 ms flows.
