# T-PERF1 impl — writer (LD-184 reset)
- Files changed: none in product/test paths. Per LD-184 the tester owns `__tests__/load/*` (engagement.k6.js, consumer.pgbench.sql, seed.mjs) and `load.scenarios.test.ts`; I did not create or edit them.
- Added `.orchestra/cr/T-PERF1.nonblocking.md` (Blocking? no): p95 run at SCALE=1 and 10 + pgbench still to be done on Linux/staging, exact commands inside. [CONV] CR format per spec/program/04-CHANGE-REQUESTS.md §2.
- Review item 1 applied (CR only): step 3 now has exact 1x/10x pgbench commands with `orders=500` per tenant, and a PREREQUISITE saying the `patient_orders` loader is still missing (FK 23503 otherwise); claim "ids shared with seed.mjs" removed.
- Tests: `load.scenarios.test.ts` 24/24 pass (vitest, win32, 2026-11-14 21:13).
- Open: budgets NOT proven met (win32 timer tick, no pgbench); tester follow-up needed for `patient_orders` loader under `__tests__/load/`; queue-ops 50 ms, OTP verify 250 ms, report download 500 ms flows not covered.
