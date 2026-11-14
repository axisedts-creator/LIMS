Title: CR-C16-T-PERF1: p95 evidence at SCALE=1 and SCALE=10 still to be produced on Linux/staging (non-blocking, per LD-184)
From chunk: C16            To owner: lead / infra (staging run); no spec, contract or product-code change
Type: bug (missing evidence, not a code defect)
Blocking? no — T-PERF1 done_when is "p95 targets met or CR raised"; this CR is the "CR raised" branch. Nothing downstream in 06-IMPLEMENTATION-PLAN is blocked.
Problem: The k6 / pgbench / seed files exist (`services/api/src/modules/engagement/__tests__/load/engagement.k6.js`, `consumer.pgbench.sql`, `seed.mjs`; TRD §12 rates and budgets unchanged) and `load.scenarios.test.ts` passes 24/24 on win32. That test proves the scenarios are well-formed and wired to the budgets. It does NOT prove the budgets are met: a localhost Node mock on Windows quantises to the ~15.6 ms timer tick, so the 5/10 ms p95 budgets cannot be measured there, and pgbench is not installed on this host. NOBODY MAY CLAIM THE BUDGETS WERE MET until the runs below are done.
Not covered by any scenario yet: queue ops 50 ms, OTP verify 250 ms, report download 500 ms flows.
Proposed change (exact): run on Linux or staging with k6 and pgbench installed, against a seeded staging DB, then attach the k6 summary (thresholds pass/fail, p95 per flow) and pgbench TPS/latency to this CR:
  1. SCALE=10:  `k6 run -e SCALE=10 -e BASE_URL=<staging api> services/api/src/modules/engagement/__tests__/load/engagement.k6.js`
  2. SCALE=1:   `k6 run -e SCALE=1  -e BASE_URL=<staging api> services/api/src/modules/engagement/__tests__/load/engagement.k6.js`
  3. Consumer upsert load: `pgbench -n -f services/api/src/modules/engagement/__tests__/load/consumer.pgbench.sql -D tenants=<N> -c <clients> -T 60 <staging db>` (as table owner, after seed load; ids shared with seed.mjs)
  If any threshold fails, raise a follow-up CR with the failing flow and measured p95. Close this CR (rename to `.resolved-<ts>.md`) only with the attached evidence.
Backward compatible? yes (no change).
Tenant/security impact: none. Synthetic seed data only; run against staging, never production.
Alternatives considered: loosening thresholds or accepting the win32 mock numbers (rejected: LD-184 says thresholds stay exactly as TRD §12 and nothing is weakened); a Linux CI job (possible later, out of T-PERF1 scope).
Tests that will prove it: the k6 summaries and pgbench output above, from SCALE=1 and SCALE=10 runs.
