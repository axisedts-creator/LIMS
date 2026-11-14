# T-PERF1 impl — writer
- Files: `__tests__/load/engagement.k6.js`, `consumer.pgbench.sql`, `seed.mjs` (no test files touched).
- Result: 19/24 pass; 5 fail on test-harness defects, see `T-PERF1-dispute.md` (k6 inspect ignores env; spawnSync blocks mock).
- [CONV] listMyAvailableSlots 0.35 req/s at 10x (TRD gives no rate); 304 path measured via ETag fetched once in setup(), 1 in 10 calls unconditional so the 200 path is measured.
- [CONV] display token sent as `X-Lims-Display-Token` (TRD §Q9 line 1055), patient token as `Authorization: Bearer`.
- [CONV] pgbench script runs as table owner (no RLS); tenant ids `0000000n-0000-4000-8000-000000000001`.
- Open: k6 run vs mock, real staging run and pgbench run (pgbench absent) not executed; "p95 met or CR raised" needs a staging run.
