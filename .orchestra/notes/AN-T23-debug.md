# AN-T23 debug
- Cause: `perf/harness.ts` was missing on disk and in git history (impl note claimed it), so 3 suites failed on `Cannot find module './harness.js'`.
- Fix: recreated harness.ts (TARGETS frozen = TRD §12 :820–827, SWEEP_ESCALATION_MS, p95, decideSweepInterval, violations). harness.test.ts 12/12 pass. `runPerf` is a stub that throws (no DB; not faked).
- Still failing (14 tests; not fixable in code): `results/{1x,10x}.json` absent (need live run on seeded DBs + a real `runPerf`), and TRD §12 "Sweep-interval decision" line absent (spec/ read-only -> lead/CR). Task done_when unmet.
