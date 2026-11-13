# HC-T11 debug (debugger)
- Failure: perf.test.ts only (3/84): changed p95 ~6.5 s (<=2 s), unchanged ~1.4 s (<=0.5 s), labFails ~5.6 s. Reproduced twice on the same code (earlier 84/84 passed on it).
- Measured inside `getSyncSnapshot` (temporary timing, removed, `git diff` clean): unchanged 0.55-0.72 s (queries ~30-130 ms + 40 balance spins of 10 ms = 400 ms floor); changed 1.7-2.3 s (demographics 50 ms, loop 1.4 s vs 1.2 s floor, 40 audit inserts 0.26-0.87 s).
- Gap to the test's 5-7 s changed / 1.0-1.4 s unchanged (3.5-4.5 s / ~0.5 s) is outside the service: harness `appTx` connect + BEGIN + COMMIT (commit after ~40 access_log rows) + handler wrapper, on a loaded host (fork failures, other lanes migrating). Not isolated further.
- No implementation change made: no code lever found. `Promise.all` does not help the fakes (they spin synchronously) and the spec forbids nothing here; one access_log row per visit is required (REQ-SEC-096).
- See HC-T11-dispute-perf.md: the p95 asserts time the whole harness tx, not the 02-TRD 13 service budget.
## Round 2 (after ack.test.ts helper fix per HC-T11-ruling.md)
- Verify log now: 81/84 pass, only perf.test.ts fails: changed p95 3146 ms (<=2000), unchanged p95 622 ms (<=500), labFails 2170 ms (<=2000). The ack unhandled-rejection errors are gone.
- Same cause as round 1: fake-latency floors (1.25 s / 0.4 s) plus per-visit savepoints and 40 audit inserts in one harness tx on a loaded host. Code is already one batch call, one lookup and one balance per visit, sequential by design (shared tx). No implementation change; dispute-perf.md stands and needs a ruling (time handler only, run perf alone, or add headroom).
## Round 3
- Verify log: 81/84; only perf.test.ts fails: changed p95 3025 ms (<=2000), unchanged 664 ms (<=500), labFails 2531 ms (<=2000). ack/static/settings pass.
- Same cause as rounds 1-2: busy-spin fake floors (1.25 s / 0.4 s) leave 750/100 ms for harness tx + 40 access_log inserts + savepoints on a loaded host. No code lever (Promise.all useless on sync-spinning fakes; one access row per visit is REQ-SEC-096). Implementation unchanged.
- Dispute HC-T11-dispute-perf.md stands, needs arbiter ruling (time handler only / run perf alone / add headroom). Stopping.
