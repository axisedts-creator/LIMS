# T0B-REGAPI-2 debugger round
- Verify log: 1675/1676 pass; only fail = unit/boot.test.ts "mounts nothing outside the spec": `Test timed out in 60000ms` (65 workers spawned, 302 s run, host loaded).
- Cause: host load, not product code. boot.test.ts alone on this lane: 30/30 pass (168 s, ~5 s per bootstrap). The test body is 2 inject calls after bootstrap; no failing assertion, no handler/contract defect (boot itself is green: all 47 ops have handlers).
- Fix: none in implementation. Raising the 60 s timeout or isolating workers would be a test/verify change (forbidden: LD-314/LD-328 (5)); no spec contradiction, so no dispute file.
- Needs: rerun `bash tests/frontdesk/T0B-REGAPI-2.pg.sh` on an idle host (3 runs in a row); if it times out again under load, lead decides on a verify-side worker cap (e.g. fewer vitest workers) — not a code change.

# T0B-REGAPI-2 debugger round 2
- Verify log: 1672/1676; boot.test.ts first test `Test timed out in 60000ms` (65 workers, 310 s, host loaded), then 3 cascade fails `module reporting/smartreport: index.ts exports no manifest` (vite-node partial module from the still-in-flight timed-out import, not a missing export: both index.ts export `manifest`).
- Cause: host load, not product code. boot.test.ts alone: 30/30 pass (112 s). All 47 frontdesk ops have handlers; boot green.
- Fix: none in implementation (60 s test timeouts are in the test file, off limits; no spec contradiction, no dispute). Needs rerun on idle host, or lead decision on a verify-side vitest worker cap.
