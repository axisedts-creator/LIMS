# AN-T23 tests (tester) — revised per LD-136
- Files: `services/api/src/modules/analytics/__tests__/perf/` — `harness.ts` (tester-owned: TARGETS, SWEEP_ESCALATION_MS, p95, decideSweepInterval, violations, runPerf), `harness.test.ts` (13 tests incl. trdTargetsMs() length 8), `report.test.ts`, `trd.decision.test.ts`, `load.live.test.ts`.
- Run: `.orchestra\notes\AN-T23-verify.cmd`
- Result: harness.test.ts 13/13 pass; report.test.ts, trd.decision.test.ts, load.live.test.ts SKIP (reasons name release gate RG-6: results/1x.json, results/10x.json, TRD §12 "Sweep-interval decision" line absent). tsc: no errors in perf/.
- Gated tests apply every assertion unchanged once the artefact exists. runPerf is NOT executed here (no seeded DB): live runs LIMS_TEST_PERF_SCALE=1x then 10x after `pnpm db:seed --scale 1|10`, plus the TRD line = RG-6 (lead / human spec follow-up).
- runPerf unverified: ctx/IdentityPort stubs and the export measurement (buildReport top_referrers + writeXlsx, 366 d) are written from reading the code, never run.
