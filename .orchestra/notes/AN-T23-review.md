APPROVE

AN-T23 review (diff 699f2bff..HEAD), checked against LD-136.
- Ownership: code changes are only under services/api/src/modules/analytics/__tests__/perf/ (harness.ts is tester-owned per LD-136). The other changes are .orchestra/notes moves.
- TARGETS are frozen to the TRD §12 order (300, 500, 1500, 2000, 300, 60000, 120000, 30000). SWEEP_ESCALATION_MS is 120000, p95 uses nearest rank, and decideSweepInterval/violations match the contract.
- harness.test.ts: 13/13 pass (the 12 existing tests plus the trdTargetsMs() length-8 assertion).
- report.test.ts, the 1x/10x agreement test and trd.decision.test.ts use describe.skipIf, and the skip reason names RG-6. Their assertions are unchanged. load.live.test.ts skips because the environment variables are not set.
- Names match 03-INTERFACE-CATALOG verbatim: the four analytics.* permissions, the 11 v_pub_* views and the handler ids.
- runPerf uses synthetic fixture UUIDs and a TEST-NET IP, has no secrets, and writes only aggregates. The view names in its SQL come from a constant allow-list. It does not run in this lane (RG-6).
- tsc: no errors in perf/ files (the 25 existing errors are in contracts/ports and are out of scope).
Run: `npx vitest run services/api/src/modules/analytics/__tests__/perf` gave 13 passed and 17 skipped.
