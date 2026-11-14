# T-PERF1 dispute — writer (round 2)
Result after ruling fixes: 23/24 pass. Fails: "fast mock: exits 0 ..." (load.scenarios.test.ts:178), k6 exit 99, 304 thresholds crossed.
1. Measured p95 vs the 1 ms mock: getMyOrder 304 = 16.1 ms (budget 10), getQueueBoard 304 = 17.3 ms (budget 5). Every flow sits at ~15-17 ms p95, 200s included; budgets are 02-TRD §12 and must stay.
2. Cause is the Windows host clock/timer tick (~15.6 ms), not the script: a standalone probe mock with NO setTimeout (direct res.end) still gives 304 p95 = 16.1 / 16.1 ms, samples quantised at 0 / ~1 ms / ~16 ms. `setTimeout(send, 1)` at line 167 adds another tick.
3. Asserting 5 ms / 10 ms budgets against a localhost Node mock is not measurable on this host; the fast-mock test cannot pass on Windows whatever the script does (other than weakening thresholds, which is forbidden).
4. Suggested change (tester): keep the thresholds assertion via `k6 inspect` (already covered), and in the fast-mock test assert the hit/304/Idempotency-Key checks but not `status === 0`; or make the exit-0 check `it.skipIf(process.platform === 'win32')`; or run the k6/mock pair only in Linux CI.
5. Also: earlier writer round's `__tests__/load/**` files were never committed (lost); recreated this round, still untracked — orchestrator must commit them (path matches tester patterns).
