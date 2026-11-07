# C6-T14 debugger (round after ruling)
Cause: no impl defect. verify.cmd runs bulk-release.load.test.ts in parallel with bulk-release.test.ts + manifest.test.ts; the spin-wait sleep (CPU-bound, per ruling) competes for cores, so run latencies were 6.6-8.7 s (max 8733 > 8000). Same load file run alone: 4/4 pass.
Impl floor is the injected cost (1 eligibility call + ~7 writes per id, all required by 02-TRD §4.6 rule 4); nothing removable without breaking AC-07.x. No code change made.
Fix needed outside my scope: run the load file isolated (verify.cmd split, or fileParallelism:false for it in services/api/vitest.config.ts, LD-53-owned). See C6-T14-dispute.md.
