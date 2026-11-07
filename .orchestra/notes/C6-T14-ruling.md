TESTS_WRONG — the load test injects far more latency than the spec's cost model, so the 8 s budget cannot be met by any correct implementation on this host.
Reasons:
1. spec/chunks/C6-reporting-delivery/02-TRD.md:891 sets the budget from a model: 200 × (getReleaseEligibility ≤ 15 ms + update/publish ≈ 10 ms) ≈ 5 s, so p95 ≤ 8 s. The plan row (06-IMPLEMENTATION-PLAN.md:26) uses this as done_when.
2. The test intends to reproduce that model (bulk-release.load.test.ts:1-2: billing 15 ms, writes 2 ms each). But helpers `sleep` (bulk-release.helpers.ts:22) uses setTimeout. On Windows that is clamped to timer resolution. Measured here with 100 awaits each: setTimeout(2) ≈ 19.6 ms and setTimeout(15) ≈ 32.4 ms.
3. So the injected cost is ~9× the spec's write latency and ~2× its eligibility latency. The floor is ~19 s, well over the 5 s the spec models. The test enforces a stricter requirement than the spec states.
4. The implementation's own cost looks right: one eligibility call per id, statements per id within the 5..20 bound, and the linear-scaling test passes.
Required test change (tester): make injected latency accurate to the ms. In bulk-release.helpers.ts, replace `sleep` for billingMs/queryMs with a precise delay: await setTimeout for (ms − timer slack) if ms > slack, then spin on performance.now() until the target is reached (or a pure performance.now() spin). Keep billingMs: 15, queryMs: 2, RUNS 5 and BUDGET_MS 8000 unchanged. Optionally assert one self-check: mean injected delay for sleep(2) is < 4 ms.
Do not change the implementation for this test.
