TESTS_WRONG — the failure was the verify harness (load test run in the same vitest process as manifest.test.ts), not anything the spec requires; the current two-process verify.cmd is the required fix and no further test or implementation change is needed.
Reasons:
1. spec/chunks/C6-reporting-delivery/02-TRD.md:891 budgets "p95 ≤ 8 s per request" for a 200-id bulk release; plan row 06-IMPLEMENTATION-PLAN.md:26 reuses it ("200-id load ≤ 8 s p95"). That is a per-request latency, not latency under CPU starvation from a co-scheduled test file.
2. Running bulk-release.load in parallel with manifest.test.ts made the busy-spin sleep starve the CPU: manifest beforeAll "Hook timed out in 10000ms" and inflated run latencies (C6-T14-dispute.md:2). The spec asks for neither result.
3. .orchestra/notes/C6-T14-verify.cmd:1 now runs bulk-release.test + manifest, then `&&` bulk-release.load in its own process, as LD-69 directs.
4. Arbiter re-ran it 2026-11-08 05:41: process 1 = 2 files, 103/103 passed (13.5 s); process 2 = bulk-release.load 4/4 passed (39.4 s).
5. Per LD-69, the load test passes alone, so ruling 3 (strip the fake tx.query host cost) is withdrawn: the tester makes no helper change.
Keep RUNS 5, BUDGET_MS 8000, billingMs 15, queryMs 2 and the implementation unchanged. Keep verify.cmd as is.
