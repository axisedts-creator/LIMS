# PG-T05 debug
Cause: esewa.sim.ts / khalti.sim.ts never existed in worktree or git (writer commit 9f04ebb6 held only the note) -> "Cannot find module './esewa.sim.js'".
Fix: wrote both sims from the test contract (PG-T05-tests.md). No test edited.
Result: vitest sim dir 2 files / 53 tests pass; tsc clean for sim files. Full suite/lint not run.
