# PG-T15 dispute (writer, round 3) — same harness gap, still unfixed
- Re-ran verify (2026-11-12 03:12): api 128/156 (28 RED, all in `__tests__/sim/khalti.refund.sim.test.ts`), worker 48/48 green.
- Cause unchanged: `services/api/src/modules/payments/__tests__/sim/khalti.sim.ts` still has no `origin`, `refund` endpoint, `refundOk`/`refundOther` (last commit ebc04f60, PG-T05). Failures = `sim.refund` undefined, not adapter logic.
- Arbiter already ruled TESTS_WRONG twice (PG-T15-ruling.md); fix is the TESTER's additive sim change listed there. Writer cannot edit test files; no implementation change can pass these. Re-routing to writer again will loop — please dispatch the tester. Stopping.
