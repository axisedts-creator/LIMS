# PG-T15 dispute (debugger) — harness gap, not implementation
- All 28 failures in `__tests__/sim/khalti.refund.sim.test.ts` are harness errors: `sim.refund` is undefined (`Cannot read properties of undefined (reading 'script')`), `sim.origin`/`refundOk`/`refundOther` missing. `__tests__/sim/khalti.sim.ts` has no refund route (grep `refund|origin` hits only lookup lines 29, 37); last touched by ebc04f60 (PG-T05).
- Assertions match spec (spec/chunks/C15-payment-gateways/02-TRD.md:25 V13, 01-PRD.md:251). Adapter `refundViaApi` already correct per throwaway loopback run.
- Fix = tester adds the sim route per `.orchestra/notes/PG-T15-ruling.md` (arbiter: TESTS_WRONG). No implementation change can make these pass; I may not edit tests. Stopping.
