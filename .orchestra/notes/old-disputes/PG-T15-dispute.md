# PG-T15 dispute (debugger)
28 RED in `__tests__/sim/khalti.refund.sim.test.ts`: `sim.refund` undefined (e.g. line 108). `__tests__/sim/khalti.sim.ts` has no `origin`, refund endpoint, `refundOk`, `refundOther`. Assertions are spec-correct per LD-123/PG-T15-ruling.md. No implementation fault. Needs TESTER to apply the ruling's fix list.
