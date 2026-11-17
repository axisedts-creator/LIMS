## Debug round (2026-11-17)
Verify log: 4 failed / 5881 passed. Failures = 3 boot/autoload timeouts (real-modules-boot 60s, pending-operations 120s, catalog skeleton 120s) + orderables.search perf p95 298ms vs 150ms. Full run took 541s under host load (104 workers).
Re-ran all four alone: real-modules-boot 2/2 pass (35s); pending-operations + skeleton + perf 116 pass, 2 skipped (pre-existing). No implementation defect; load-induced (same pattern as LD-317 for ACCT-1).
Fix: no code change. Tests untouched. Re-run verify with an idle host or fewer vitest workers.
