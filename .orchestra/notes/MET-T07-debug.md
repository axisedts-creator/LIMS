
## MET-T07 debug (debugger, 2026-11-14)
- Cause: only failure = boot.test.ts "boots and mounts every instruments operation" hits its hard-coded 120_000 ms (LD-86). Reproduced ALONE (193 s run): core bootstrap compiles every module cold, ~2 s per module log line, >120 s on this shared machine. Not a Metis/truth_h80e defect; the 2081 other tests pass.
- Fix: none in C7 implementation. Slowness is in core bootstrap (C0), and the 120_000 is a test arg I may not edit. services/api/vitest.config.ts already allows 300000 (LD-110); the test overrides it lower.
- Needs lead: extend LD-86 to raise those two timeouts in boot.test.ts to 300_000 (or drop the per-test arg), then rerun MET-T07-verify.cmd; or run verify on an idle machine.

## MET-T07 debug round 2 (debugger, 2026-11-14)
- Verify log: 3 fails, 2079 pass. (1) boot.test 120_000 ms timeout again (same as round 1). (2) boot "module frontdesk: index.ts exports no manifest": frontdesk/index.ts:6 exports `manifest`; same transient as "payments" in impl note, only under load/concurrent lanes, not C7. (3) ingest.perf p95 3102 ms vs 3000: 477 s run, 62 workers, ~2.4 s spawn each; timing flake, ingest code untouched by MET-T07.
- Fix: none in implementation. All three are machine-load/test-timeout issues; tests not editable. Same ask to lead as round 1: raise boot.test timeouts (LD-86 -> 300_000), rerun verify idle with `--pool=forks --maxWorkers=2`.

## MET-T07 debug round 3 (debugger, 2026-11-14)
- Verify log: 3 fails, 2079 pass: boot.test 120_000 ms timeout (same as r1/r2); ingest.perf p95 3392 ms and 3306 ms vs 3000. Re-ran ingest.perf ALONE: 6/6 pass (149 s). So load flake (62 workers, ~1.1-2.4 s spawn each), not a defect; ingest code untouched by MET-T07.
- Fix: none in implementation; tests not editable. Ask lead again: raise boot.test timeouts (LD-86 -> 300_000) and run verify with `--pool=forks --maxWorkers=2` on an idle machine.
