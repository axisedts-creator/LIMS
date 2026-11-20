# T0C-PINFIX-1 tests (tester stage)
- Changed only contracts/__tests__/t0d-12d.test.ts: total is now a floor (>=174) plus unique route ids; contiguous/next-row cases replaced by one relative-order case (20 LD-112 ids once each, in order, after dead_letter, before qc_run). Row checks and raw comment-line case unchanged (still pass).
- Run: `pnpm exec vitest run contracts/__tests__/t0d-12d.test.ts` -> 15/15 pass. See .orchestra/notes/T0C-PINFIX-1-verify.cmd.
- Whole contracts/__tests__: 246 pass, 19 fail, NONE a stale route total/adjacency (no further test file touched):
  - ports.test.ts (17): ports/*.ts vs IC section 4 blocks differ (incl. BillingCommandPort methods/@throws, PortRegistry spot check). Not a route pin.
  - registry-equality.test.ts (2): errors.yaml vs IC section 8 and permissions.yaml vs IC section 11 (cases named "equals IC §8 entry for entry", "equals IC §11 entry for entry"). Routes-vs-IC-7 case is green. Not caused by a stale pin; the task says keep registry-equality green, but these two reds need a spec/yaml sync, not a test change.
- tools/codegen/__tests__: many failures are `lintRepo` timeouts/failures (c6, c7, c9, c12, c14-c17 ...), not route pins; not fixed.
