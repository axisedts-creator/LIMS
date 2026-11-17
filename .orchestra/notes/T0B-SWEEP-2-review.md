APPROVE

Reviewed: git diff 2bf5fa924..10c4068ce (request.ts, run.ts, classify.ts, sessions.ts, known-failures.json, gate/depth/sweep2-artifacts tests, results, impl notes). Re-review after the lead reset (LD-307) and my review 06997f057.
- Owned paths only (services/api/test-sweep/**, .orchestra/notes/T0B-SWEEP-2*). No secrets or PHI. No policy, grant, migration, seed or contract edit. No new names invented.
- Review 06997f057 item 1 is fixed: gate.test.ts now reads the SWEEP-2 artifacts, and every known-failures entry must have status, class (BUG/CONFIG/HARNESS) and ref. Item 2 is fixed: depth.test.ts covers reachedHandler true, false and undefined, plus 429 and 5xx. sweep2-artifacts checks that every SHALLOW row is a 400 common.validation_failed.
- Ran `pnpm exec vitest run test-sweep/__tests__` (services/api): 13 files, 132/132 pass.
- Committed results.json: 1114 rows, 0 x 429, 0 NOT EXERCISED; WIRED/DEEP 879, WIRED/SHALLOW 11, DEFECT/DEEP 224. known-failures.json has 224 entries, so the gate set matches the run.
- done_when 4: verifyProviderCallback has a stack (callbacks.service.ts:37, no ctx.tx on the public operation).

Non-blocking note: listDeadLetters now answers 200 WIRED (fixed on main). Its "Stack-level explanation" line in T0B-SWEEP-2-results.md still describes the old authz-guard 500. Next writer pass: mark that line as historical or drop it.
