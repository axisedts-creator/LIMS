# T-PERF1 debug
- Cause: engagement.k6.js, consumer.pgbench.sql, seed.mjs were absent from the worktree and never in git history (impl note claimed "committed"; commit 09587f64 only touched notes) -> 13 ENOENT/module-not-found fails.
- Fix: recreated the 3 files under __tests__/load (flood.js pattern, TRD §12 rates/budgets, 05-SCHEMA patient_order_specimens). No test edited.
- Result: load.scenarios.test.ts 24/24 pass (incl. k6 runs). Files are UNCOMMITTED: orchestrator must commit them or they vanish again.

## Round 2
- Cause: the round-1 files were wiped again (load/ empty, tree clean) because they were never committed; verify re-ran against an empty dir.
- Fix: recreated the same 3 files from the test contract + TRD §12 + 05-SCHEMA. No test edited. Result: 24/24 pass.
- MUST commit `services/api/src/modules/engagement/__tests__/load/` this round; a clean/reset removes untracked files.

## Round 3
- Cause: same as rounds 1-2: load/ empty again (3 files never committed, wiped between rounds); verify ran against empty dir -> 13 fails.
- Fix: recreated engagement.k6.js, consumer.pgbench.sql, seed.mjs (flood.js pattern, TRD §12, 05-SCHEMA). No test edited. Result: 24/24 pass.
- Files UNCOMMITTED. ORCHESTRATOR MUST COMMIT `services/api/src/modules/engagement/__tests__/load/` or they vanish a 4th time.
