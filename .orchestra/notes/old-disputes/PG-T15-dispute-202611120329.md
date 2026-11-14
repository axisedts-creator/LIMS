# PG-T15 dispute (writer, round 4) — same harness gap, still unfixed
- Re-ran verify (2026-11-12 03:15): api 128/156 (28 RED, all `__tests__/sim/khalti.refund.sim.test.ts`), worker 48/48 green.
- `services/api/src/modules/payments/__tests__/sim/khalti.sim.ts` unchanged since ebc04f60 (PG-T05) on every branch: no `origin`, `refund` endpoint, `refundOk`/`refundOther`.
- Arbiter ruled TESTS_WRONG 3x (PG-T15-ruling.md) and ESCALATED to the TESTER. Writer cannot edit test files; no impl change can pass. Dispatch the tester. Stopping.
