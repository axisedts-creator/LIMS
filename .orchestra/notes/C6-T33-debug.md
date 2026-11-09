# C6-T33 debug (round 1)
- Failure = test timeout (30s), not an assertion: first test of observability.metrics.test.ts pays the cold `import('../index.js')` (portal.helpers.ts:317) -> narrative.service -> domain/sanitise.ts:27 `deps()` eager jsdom load. Measured `require('jsdom')` alone: 16s and 35s on this box (C6-T17 saw 2.3s). Pre-existing: portal.service.test.ts "wrong codes" (no T33 code involved) also takes 27s cold.
- T33 code is correct: the metric line (portal.service.ts:161) is one call; the other 3 metrics tests pass and the log test passes (20/20).
- No code change: making jsdom lazy would reverse the C6-T17 [CONV] (first N3/N9 request timed out) and only move the cost. Test timeout is fixed in the test file (cannot edit). Not a spec dispute.
- Action for orchestrator: rerun verify when the machine is idle, or give the verify run a larger --testTimeout / --hookTimeout (e.g. 120000); passes in impl-round runs with long timeouts.

# C6-T33 debug (round 2)
- Verify rerun (09:36) failed identically: same test, `vi.setConfig({ testTimeout: 30_000 })` hard-coded in the test file, so CLI --testTimeout does NOT override it (my run with 180000 still timed out at 30000; test 1 took 66s).
- Re-measured `node -e "require('jsdom')"` alone = 23.7s on this box today. Cold jsdom + index.js import land in test 1; no T33 code on that path. Assertions never ran/failed.
- No implementation change: only fixes are lazy jsdom (moves cost to first sanitise, reverses C6-T17) or editing the test timeout (forbidden). Not a spec dispute.
- Orchestrator: verify needs warm FS cache/idle box (run `node -e "require('jsdom')"` first) or a tester-owned timeout bump; T33 code itself: api 23/24 real, 24/24 when warm.

# C6-T33 debug (round 3)
- Full verify command rerun 09:45 with warm FS cache: api 2 files/24 tests pass (8.6s), worker 2 files/25 tests pass. Earlier failure = cold `require('jsdom')` (16-66s) vs hard-coded 30s test timeout; no assertion ever failed.
- No code change (same reasoning as rounds 1-2: lazy jsdom reverses C6-T17; test timeout not editable). Not a spec dispute. Re-run verify now.
