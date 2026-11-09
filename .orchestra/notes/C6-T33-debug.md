# C6-T33 debug (round 1)
- Failure = test timeout (30s), not an assertion: first test of observability.metrics.test.ts pays the cold `import('../index.js')` (portal.helpers.ts:317) -> narrative.service -> domain/sanitise.ts:27 `deps()` eager jsdom load. Measured `require('jsdom')` alone: 16s and 35s on this box (C6-T17 saw 2.3s). Pre-existing: portal.service.test.ts "wrong codes" (no T33 code involved) also takes 27s cold.
- T33 code is correct: the metric line (portal.service.ts:161) is one call; the other 3 metrics tests pass and the log test passes (20/20).
- No code change: making jsdom lazy would reverse the C6-T17 [CONV] (first N3/N9 request timed out) and only move the cost. Test timeout is fixed in the test file (cannot edit). Not a spec dispute.
- Action for orchestrator: rerun verify when the machine is idle, or give the verify run a larger --testTimeout / --hookTimeout (e.g. 120000); passes in impl-round runs with long timeouts.
