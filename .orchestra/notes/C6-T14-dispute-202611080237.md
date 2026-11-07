# C6-T14 dispute: bulk-release.load.test.ts "5 consecutive 200-id requests ... p95 <= 8000 ms"
Result here: 22956, 23122, 23787, 21023, 21102 ms. All 187 other tests pass.
Cause: the latency is injected with `setTimeout(ms)` (helpers `sleep`, queryMs: 2). On this Windows host `setTimeout(2)` takes ~17 ms and `setTimeout(15)` ~21 ms (measured with node: 100 awaits each).
Floor for any correct implementation: 180 released x 5 mandatory writes (supersede, mark released, set report, revoke dues links, enqueue) x ~17 ms = ~15 s, plus 200 x ~21 ms = ~4 s billing = ~19 s. The 8 s budget assumes 2 ms and 15 ms timers (~5 s).
Not an implementation cost: one eligibility call per id, ~9 statements per id (test bound 5..20 passes), linear scaling test passes.
Proposed fix (tester): inject latency by busy-wait/`performance.now()` spin or scale by measured timer resolution, or run the load test on Linux CI (1 ms timers). I did not edit the test.
