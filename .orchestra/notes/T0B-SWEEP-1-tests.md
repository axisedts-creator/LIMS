# T0B-SWEEP-1 tests (tester)
Files: services/api/test-sweep/__tests__/{classifier,safety,route-table,sessions,gate}.test.ts. They import siblings not yet written: classify.ts, safety.ts, ops.ts, sessions.ts, gate.ts (interfaces in each file header).
Run all: `.orchestra/notes/T0B-SWEEP-1-verify.cmd` = real sweep first (the "sweep itself" test; needs Docker), then the vitest files (gate.test.ts reads the sweep artifacts).
Unit only, no Docker: `pnpm --dir services/api exec vitest run test-sweep/__tests__` (artifact tests in gate.test.ts then fail until a sweep ran).
Implementer must provide: package.json script `sweep` (command contains test-sweep), known-failures.json [{operation,status,ref}], .orchestra/notes/T0B-SWEEP-1-results.json {rows[]} and -results.md.
Fail-now reason: ../classify.js, ../safety.js, ../ops.js, ../sessions.js, ../gate.js do not exist; no sweep script.
Not covered by tests: the Docker start/migrate and real-API boot steps (proved only by the sweep run itself).
