# T-PERF1 tests — tester
- File: `services/api/src/modules/engagement/__tests__/load.scenarios.test.ts` (contract in its header comment). Run: `.orchestra\notes\T-PERF1-verify.cmd` (vitest via services/api; k6 on PATH, k6 cases skip if absent).
- Implementer creates under `__tests__/load/`: `engagement.k6.js` (scenarios getMyOrder/listMyOrders/getQueueBoard/listMyAvailableSlots/createMyBooking, TRD §12 rates at SCALE=1|10, p95 thresholds, staging-only guard), `consumer.pgbench.sql`, `seed.mjs` (`generateSeed({scale,rngSeed})`).
- Covers: arrival rates 17/2.1/40/0.07 req/s at 10x and /10 at 1x; p95 budgets 40/10(304)/80/20/5(304)/100/150 ms; real `k6 run` vs local mock (fast = exit 0, 300 ms = non-zero); 304 path; Idempotency-Key; tokens header-only; prod/empty env refused before any request; pgbench status_seq guard; seed linear 10x, deterministic, synthetic.
- Now: all FAIL because the `load/` files do not exist.
- NOT covered: queue-operation (50 ms), OTP verify (250 ms), report download (500 ms) flows; real staging/pgbench run (pgbench not installed here); "p95 met or CR raised" needs a real run.
