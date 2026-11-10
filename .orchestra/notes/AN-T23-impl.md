# AN-T23 impl (writer)
- File: `services/api/src/modules/analytics/__tests__/perf/harness.ts` — TARGETS (frozen, TRD §12 order, 8 rows), SWEEP_ESCALATION_MS, p95 (nearest rank), decideSweepInterval, violations, runPerf (real services over lims_app/requestTx, like refresh.live.test.ts).
- Run: harness.test.ts 12/12 pass; report.test.ts 11 fail + trd.decision.test.ts 3 fail (no results/*.json, no TRD line); load.live skipped (no DB). tsc: no errors in harness.ts.
- [CONV] report_31d/366d rotate income/volume/collections; export_10k = buildReport('tests_done', group_by test, 366 d) + writeCsv, ≤10k rows (worker steps 4-6, no storage); refresh_lag = debounceSeconds + measured event refresh; sweep_recent = worker body (mark all families today + snapshot, refreshTenant); patientsPerDay = 500/5000 from declared scale.
- OPEN (lead): run `LIMS_TEST_PERF_SCALE=1x|10x` load.live on DBs seeded `pnpm db:seed --scale 1|10` to write results/{1x,10x}.json; then add TRD §12 "Sweep-interval decision" line (spec/ read-only -> lead/CR).
- NOT verified: runPerf never executed (no DB); any TRD target at 1x/10x. Task done_when still unmet.
