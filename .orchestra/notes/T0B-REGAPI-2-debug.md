# T0B-REGAPI-2 debugger round
- Verify log: 1675/1676 pass; only fail = unit/boot.test.ts "mounts nothing outside the spec": `Test timed out in 60000ms` (65 workers spawned, 302 s run, host loaded).
- Cause: host load, not product code. boot.test.ts alone on this lane: 30/30 pass (168 s, ~5 s per bootstrap). The test body is 2 inject calls after bootstrap; no failing assertion, no handler/contract defect (boot itself is green: all 47 ops have handlers).
- Fix: none in implementation. Raising the 60 s timeout or isolating workers would be a test/verify change (forbidden: LD-314/LD-328 (5)); no spec contradiction, so no dispute file.
- Needs: rerun `bash tests/frontdesk/T0B-REGAPI-2.pg.sh` on an idle host (3 runs in a row); if it times out again under load, lead decides on a verify-side worker cap (e.g. fewer vitest workers) — not a code change.
