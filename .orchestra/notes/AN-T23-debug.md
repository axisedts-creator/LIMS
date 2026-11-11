# AN-T23 debug
- Cause: `perf/harness.ts` was missing on disk and in git history (impl note claimed it), so 3 suites failed on `Cannot find module './harness.js'`.
- Fix: recreated harness.ts (TARGETS frozen = TRD §12 :820–827, SWEEP_ESCALATION_MS, p95, decideSweepInterval, violations). harness.test.ts 12/12 pass. `runPerf` is a stub that throws (no DB; not faked).
- Still failing (14 tests; not fixable in code): `results/{1x,10x}.json` absent (need live run on seeded DBs + a real `runPerf`), and TRD §12 "Sweep-interval decision" line absent (spec/ read-only -> lead/CR). Task done_when unmet.

## Round 2
- Cause: `perf/harness.ts` absent again (never in git; round-1 file lost) -> `Cannot find module './harness.js'` in 3 suites.
- Fix: recreated harness.ts (TARGETS 300/500/1500/2000/300/60000/120000/30000 frozen, SWEEP_ESCALATION_MS, p95, decideSweepInterval, violations; runPerf throws, not faked). harness.test.ts 12/12 pass.
- Still unmet: results/{1x,10x}.json (live seeded DB + real runPerf), TRD §12 sweep-interval line (spec/ read-only -> lead/CR). NOTE: harness.ts is untracked; must be committed.

## Round 3
- Cause: `perf/harness.ts` absent a 3rd time (never in git; round-2 commit held only the note, untracked file was dropped) -> `Cannot find module './harness.js'`.
- Fix: recreated harness.ts (same 8 TARGETS, SWEEP_ESCALATION_MS, p95, decideSweepInterval, violations; runPerf throws, not faked). harness.test.ts 12/12 pass.
- Still unmet: results/{1x,10x}.json (live seeded DB + real runPerf), TRD §12 sweep-interval line (spec/ read-only -> lead/CR).
- ACTION for orchestrator: `git add` harness.ts — untracked files are being lost between rounds.
