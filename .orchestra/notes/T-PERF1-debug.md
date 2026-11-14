# T-PERF1 debug
- Cause: engagement.k6.js, consumer.pgbench.sql, seed.mjs were absent from the worktree and never in git history (impl note claimed "committed"; commit 09587f64 only touched notes) -> 13 ENOENT/module-not-found fails.
- Fix: recreated the 3 files under __tests__/load (flood.js pattern, TRD §12 rates/budgets, 05-SCHEMA patient_order_specimens). No test edited.
- Result: load.scenarios.test.ts 24/24 pass (incl. k6 runs). Files are UNCOMMITTED: orchestrator must commit them or they vanish again.
