# T-PERF1 impl — writer (round 3)
- Files: `__tests__/load/engagement.k6.js`, `consumer.pgbench.sql`, `seed.mjs` (recreated, now committed). No test files touched.
- Result: 24/24 pass on win32 with k6 present (fast-mock accepts exit 0|99 per ruling).
- [CONV] rates per `timeUnit: 1000s` so 1x is exactly /10 with integer rates; listMyAvailableSlots 0.35 req/s at 10x (TRD gives no rate).
- [CONV] per-VU ETag: first poll unconditional, later If-None-Match; display token `X-Lims-Display-Token`, patient `Authorization: Bearer`.
- [CONV] pgbench as table owner (no RLS), `-D tenants=N`, upserts specimens only (parent patient_orders from seed load); id scheme shared with seed.mjs.
- Open: real staging k6 run at SCALE=1/10 and pgbench run (pgbench absent) not executed; "p95 met or CR raised" needs that run. seed.mjs emits counts/ids only, no SQL loader.
