# API-T15 dispute (writer)
No src to write: task files = perf tests only; services T06/T09/T10 exist. Ran vitest perf twice on shared dev machine.
Run 1 (full, 231 s): 8/10 pass. FAIL ingest.perf 10x concurrent 5x100 batches (>= 8 s budget) and 10x steady p95 = 1595 ms (> 300).
Run 2 (ingest only): 5/6 pass. FAIL 10x steady p95 = 338 ms (> 300). Same test, ~5x variance: wall-clock, single-thread CPU-bound in-memory harness (100 worlds, per-message savepoints, 150 msg/s in one Node process), not a service defect.
Ask: tester make 10x cases deterministic (count ops, or relax/serialize under in-memory harness, or real-PG harness via CR). Writer cannot edit tests. Stopping.
