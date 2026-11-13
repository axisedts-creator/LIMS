CHANGES
Ruling on the perf dispute: LD-156 (budgets stay).
1. TESTER: in helpers and perf.test.ts, replace the busy-spin fakes with async non-blocking delays of the same latencies (50/20/10 ms); time the handler call only, after one warm-up pull.
2. WRITER: allow bounded concurrency (about 8) for the per-visit port calls of one request; batch the access_log rows if the core writer allows it (one row per visit stays).
Budgets are not changed.