Title: CR-C7-API-T15: real-PostgreSQL load harness for C7 02-TRD §12.2 at 1× and 10×; defer worker and C5 latency rows
From chunk: C7            To owner: C0 (synthetic seed generator, CI/test tooling); C7 API-T14 (worker); C0/C5 (event fan-out)
Type: shared-lib
Blocking? no. API-T15 ships the in-memory perf suite (`services/api/src/modules/instruments/__tests__/perf/*`, 10/10 pass). That suite measures service overhead only. It does not satisfy 05-DEFINITION-OF-DONE §3 item 5 for the C7 chunk gate.
Problem (what you cannot do today, with the user story / acceptance criterion it serves):
1. 02-TRD §12.2 targets "`submitMessageBatch`, 100 messages p95 ≤ 3 s; hard budget 8 s" (derived as ≈ 2,700 statements at ~1 ms), "Backlog drain of 9,000 messages ≤ 15 min (AC-08.5)", "`submitHostQuery` p95 ≤ 500 ms (AC-10.5)" and "Message list (31-day window) p95 ≤ 400 ms per page of 50" (index `(tenant_id, centre_id, received_at DESC)`) all depend on real DB statement latency and index use. The in-memory repos in perf/* cannot measure that. DoD §3 item 5 requires "the reference dataset (04 §14 capacity assumptions; seed generator at 1× and 10× lab volume)". C0 owns the synthetic seed generator (01-CHUNK-MAP §2 C0 row), and there is no PG-backed load harness that C7 can call.
2. "`evaluate_agent_health` ≤ 2 s per run for 1,000 agents" lives in `services/worker/src/jobs/instruments/*` (API-T14), outside the API-T15 paths.
3. "Event commit → C5 applied p95 ≤ 5 s (C5's target)": the fan-out belongs to C0/C5, not C7.
Proposed change (exact):
A. C0: provide a seed generator mode for C7 tables at 1× (1 lab: 3,000 msgs/day, 25,000 records/day, ≤ 20 agents) and 10× (10 labs) per 02-TRD §12.1, plus a real-PG test harness entry point that C7 perf tests can call. C7 then adds PG-backed variants of the perf/* cases with the same thresholds.
B. Measure `evaluate_agent_health` ≤ 2 s/1,000 agents in API-T14 (worker tests) against the A harness.
C. Measure event commit → C5 applied p95 ≤ 5 s in C0/C5's performance run.
Backward compatible? yes (additive test tooling only).
Tenant/security impact: none. Synthetic data only; the harness runs under the normal RLS roles (FORCE RLS stays on).
IRD/regulatory impact: n/a.
Alternatives considered: extend the in-memory harness (cannot measure statement latency or index plans); a C7-owned PG harness (the seed generator and db/ tooling are C0-owned, so C7 would be working around the contract).
Tests that will prove it: PG-backed `ingest.perf`, `device.perf` and `messages.perf` at 1×/10× pass the 02-TRD §12.2 thresholds; an API-T14 health-evaluator perf test; C5's commit→applied latency test.
