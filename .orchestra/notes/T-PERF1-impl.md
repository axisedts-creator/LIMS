# T-PERF1 impl — writer (round 2)
- Files: `__tests__/load/engagement.k6.js`, `consumer.pgbench.sql`, `seed.mjs` (recreated; round-1 files were never committed). No test files touched.
- Result: 23/24 pass; 1 fail ("fast mock exits 0") on Windows timer granularity, see `T-PERF1-dispute.md`.
- [CONV] rates expressed per `timeUnit: 1000s` so 1x is exactly /10 with integer k6 rates; listMyAvailableSlots 0.35 req/s at 10x (TRD gives no rate).
- [CONV] per-VU ETag: first poll unconditional (200 path), later polls If-None-Match (304 path); display token `X-Lims-Display-Token` (TRD §Q9), patient `Authorization: Bearer`.
- [CONV] pgbench runs as table owner (no RLS), `-D tenants=N`; tenant ids lpad(n,8)-0000-4000-8000-000000000001, shared with seed.mjs.
- Open: real staging k6 run and pgbench run (pgbench absent) not executed; "p95 met or CR raised" needs a staging run; load files untracked, need commit.
