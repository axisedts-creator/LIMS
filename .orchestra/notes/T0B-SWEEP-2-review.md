CHANGES

Reviewed: git diff 2bf5fa924..83d1034d6 (request.ts, run.ts, classify.ts, sessions.ts, known-failures.json, results, impl notes). Only owned paths are touched. No secrets or PHI. No policy, migration, seed or contract edits. The partner seed is plain SQL on the throwaway DB, which SWEEP-1 already allowed. The working-tree re-run (16:55Z) reproduces 1114 ops / WIRED 890 / DEFECT 224 / DEEP 1103 / SHALLOW 11 / 0 x 429. Only the timestamp changed. I checked fastify 5.12.8 handle-request.js:115-167: handler:start fires only after validateSchema passes, so the `reachedHandler` DEEP rule is sound.

Ran: `pnpm exec vitest run test-sweep/__tests__` (services/api): 13 files, 127 tests, 3 FAILED, all in gate.test.ts.

1. services/api/test-sweep/__tests__/gate.test.ts:44, :64, :77 fail against the new known-failures.json:
   - "lists the four platform defects": the platform defects are fixed on main and no longer listed.
   - "results.json records ... four known defects as DEFECT" and "known-failures.json status equals the status of the committed run": these read the frozen T0B-SWEEP-1-results.json against the live SWEEP-2 known-failures.json, so 22 "listed undefined run 403/500" mismatches appear.
   This change turns the regression-gate suite red on merge (done_when 5: the sweep must stay a regression gate).
   Fix (tester step): retarget the "first-run artifacts" block (:63-:81) to .orchestra/notes/T0B-SWEEP-2-results.json. Replace the ":44 four platform defects" assertion with one that checks every known-failures.json entry has `status`, `class` and a reference. After that, the whole `vitest run test-sweep/__tests__` must pass, not only the verify.cmd subset.
2. services/api/test-sweep/classify.ts:25: the new `reachedHandler` branch decides DEEP vs SHALLOW for every 400 common.validation_failed, but no test covers it. A grep of `__tests__` for reachedHandler finds nothing, and impl note "Open 2" says the same. The task's tests field requires classifier unit tests for DEEP and SHALLOW.
   Fix (tester step): in classifier.test.ts or depth.test.ts, add two cases:
   - `classify({status:400, errorCode:'common.validation_failed', reachedHandler:true}).depth === 'DEEP'`
   - the same input with `reachedHandler:false` or omitted gives `'SHALLOW'`
   Also add a run-level check (sweep2-artifacts) that every SHALLOW row is a 400 common.validation_failed.
