# T0B-SALES-1 old debt (LD-347 item 6)
- services/api/src/modules/homecollection/repository/__tests__/static.test.ts fails: "handovers.repo.ts: ${values.length} in SQL text" (handovers.repo.ts:52,57,63).
- Both files are byte-identical to main (`git diff main -- <both>` empty), and the test is a pure source scan, so it fails on clean main the same way. Not touched by this task; handovers.repo.ts NOT edited.
- Verify runs leave that one file out: SALES1_SUITES="... --exclude **/homecollection/repository/__tests__/static.test.ts". Owner of handovers.repo.ts should switch to a placeholder counter (e.g. `const p = () => '$' + values.length`) or the test should allow `values.length`.
