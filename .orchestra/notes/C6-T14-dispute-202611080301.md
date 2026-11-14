# C6-T14 dispute (verify harness, not implementation)
Spec: 02-TRD.md:891 models 200 x (<=15 ms eligibility + ~10 ms writes) ~ 5 s, p95 <= 8 s, for a single request on an otherwise idle host.
Fact: .orchestra/out/C6-T14-verify.log failed at 8733 ms only because verify.cmd runs the busy-spin load file concurrently with two other test files; alone it passes 4/4 (re-run by debugger, 52 s).
Requested: run bulk-release.load.test.ts in its own vitest invocation (or fileParallelism:false for it). I may not edit tests, verify.cmd or vitest.config.ts (not chunk-owned).
