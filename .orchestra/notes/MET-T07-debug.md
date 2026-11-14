
## MET-T07 debug (debugger, 2026-11-14)
- Cause: only failure = boot.test.ts "boots and mounts every instruments operation" hits its hard-coded 120_000 ms (LD-86). Reproduced ALONE (193 s run): core bootstrap compiles every module cold, ~2 s per module log line, >120 s on this shared machine. Not a Metis/truth_h80e defect; the 2081 other tests pass.
- Fix: none in C7 implementation. Slowness is in core bootstrap (C0), and the 120_000 is a test arg I may not edit. services/api/vitest.config.ts already allows 300000 (LD-110); the test overrides it lower.
- Needs lead: extend LD-86 to raise those two timeouts in boot.test.ts to 300_000 (or drop the per-test arg), then rerun MET-T07-verify.cmd; or run verify on an idle machine.
