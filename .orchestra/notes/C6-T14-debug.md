# C6-T14 debugger (round after ruling)
Cause: no impl defect. verify.cmd runs bulk-release.load.test.ts in parallel with bulk-release.test.ts + manifest.test.ts; the spin-wait sleep (CPU-bound, per ruling) competes for cores, so run latencies were 6.6-8.7 s (max 8733 > 8000). Same load file run alone: 4/4 pass.
Impl floor is the injected cost (1 eligibility call + ~7 writes per id, all required by 02-TRD §4.6 rule 4); nothing removable without breaking AC-07.x. No code change made.
Fix needed outside my scope: run the load file isolated (verify.cmd split, or fileParallelism:false for it in services/api/vitest.config.ts, LD-53-owned). See C6-T14-dispute.md.

# C6-T14 debugger (round 2026-11-08 05:47, after LD-69 two-process verify.cmd)
Cause: no impl defect. Load file ALONE (own process) failed twice (05:45 log; my re-run 05:47): the test-only self-check `sleep(2)/sleep(15)` means exceeded (4.83 ms > 4; sleep(15) >= 17) and once run0 = 8203 ms. Spin-sleep is sub-ms accurate unless the thread is preempted, so the host CPU was contended (other lane sessions) — the injected cost floor (~200 x (15 + ~7x2) ~ 5.8 s) leaves only ~2 s headroom. Same file passed 4/4 alone at 05:41 and earlier.
Fix: none in impl (floor = required calls; nothing removable). No test edited. Re-run verify when no other vitest/lane is running; if flaky repeats, tester/lead must widen the self-check/budget margin (test-owned, LD-69 forbids me).
