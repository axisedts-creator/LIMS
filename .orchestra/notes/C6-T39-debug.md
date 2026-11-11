# C6-T39 debug (verify: 2 api tests "Test timed out in 5000ms")
Cause: not a T39 logic fault. The failing tests are the FIRST test of t39.a4.test.ts and of notification.port.test.ts (a T19 test, untouched). They pay a one-time cold start in world()/first queued send (likely core/events/publish.ts eventValidators(): ajv compiles all 27 contracts/events schemas on first publish; not measured). Alone: t39 test passes with --testTimeout=60000 (~13 s); the other 75 tests pass in ~100 ms each. Same family as C6-T16-debug.md.
Fix: none in impl. T39's diff (messages.ts 1 line, send_delivery.ts) cannot cost 10 s, and the cold path is in C0-owned core/ (publish.ts) / vitest.config.ts (LD-53). Durable fix for the lead: `testTimeout`/`hookTimeout` (e.g. 60000) in services/api/vitest.config.ts, or `--testTimeout=60000` in C6-T39-verify.cmd. No test or impl edits made; no test dispute (tests agree with the spec).

## round 2 (verify.log 20:40: same 2 timeouts, 95/97 pass)
Cause confirmed: first-test cold start (ajv compile of all contracts/events schemas in core/events/publish.ts eventValidators(), C0-owned) exceeds the default 5000ms testTimeout. Re-run alone with --testTimeout=60000: t39.a4.test.ts 36/36 pass (~13 s for the cold test). No T39 logic fault.
Fix: none possible in C6 files. Needs lead: `testTimeout: 60000` in services/api/vitest.config.ts (C0-owned, LD-53) or `--testTimeout=60000` in C6-T39-verify.cmd. Not a test dispute.

## round 3 (verify.log 20:47: 4 timeouts, first test of each of 3 files, 93/97 pass)
Cause: same cold-start 5000ms default testTimeout (3 files import in parallel; first test pays the cold path). Not a T39 logic fault.
Re-run of the same 3 files with --testTimeout=60000 --hookTimeout=60000: 97/97 pass (36 s). No impl/test edits.
Fix needed from lead: `testTimeout`/`hookTimeout` 60000 in services/api/vitest.config.ts (C0-owned, LD-53) or the flags in C6-T39-verify.cmd. No dispute.

## round 4 (verify.log 23:17: api 97/97 pass after LD-87 config; worker 2-3 timeouts at 5000ms)
Cause: LD-87 testTimeout/hookTimeout 60000 is already in services/api/vitest.config.ts (api part green). The worker package (services/worker) has NO vitest config, so t39.a4.first_assembly.test.ts runs at the 5000ms default and its first tests pay the cold start. Rerun alone with --testTimeout=60000 --hookTimeout=60000: worker 11/11 pass (26 s). Not a T39 logic fault; tests untouched, no dispute.
Fix NOT applied: LD-87 authorises only services/api/vitest.config.ts. Needs lead: LD covering a services/worker/vitest.config.ts (testTimeout/hookTimeout 60000, C0-owned) or the flags on the worker line of C6-T39-verify.cmd.
