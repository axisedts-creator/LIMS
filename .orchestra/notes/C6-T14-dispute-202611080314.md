# C6-T14 dispute (writer, after ruling 1b3d375)
Claim: load test still fails when run ALONE, as the ruling prescribed: `vitest run .../bulk-release.load` -> 1 of 3 runs passed; failures "latencies ms: 7040, 7126, 8589, 8556, 8795 (max 8795) ... expected <= 8000". (bulk-release.test + manifest in their own process: 108/108 pass.)
Evidence (scratch probe, deleted after; same bulkSetup({items: many(200), dues 20, fastSavepoints: true}) but billingMs/queryMs = 0):
- Statements per request: 1501 = 200 x (3 SELECT) + 180 x (4 UPDATE + 1 enqueue_job) + 1 settings read. Injected floor = 200 x 15 + 900 writes x 2 = 4800 ms.
- With ZERO injected latency a 200-id request still takes 1950-4480 ms, and 3215-4340 ms of that (~95%) is spent inside the fake DB's `w.db.tx.query` (test infra). Impl code itself is ~100-200 ms per 200 ids. Probe times also grew run to run in one process (2.1 -> 2.3 s; 3.4 -> 4.5 s).
- So measured = 4.8 s cost model + 2-4.5 s fake-DB host cost (not in 02-TRD:891 cost model) + host noise; > 8 s whenever the host is busy. Same reasoning as the ruling's point 1: the budget covers the spec's per-request cost, not fake-store interpretation cost.
- Nothing removable in impl: 1 eligibility call per id (asserted), writes required by 02-TRD §4.6 rule 4; reads have no injected latency.
Suggested test fix (tester): make the fake cheap for the load test (like fastSavepoints did for SAVEPOINT clones), e.g. find what in `w.db.tx.query` is O(store) or O(stmts) per call; or subtract measured fake-DB time from the latency; or budget = injected floor + measured zero-latency baseline. Keep RUNS 5, BUDGET_MS 8000, billingMs 15, queryMs 2.
No impl change made.
