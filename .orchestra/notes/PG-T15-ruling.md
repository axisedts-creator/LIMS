TESTS_WRONG — `__tests__/sim/khalti.refund.sim.test.ts` depends on a simulator API the tester never shipped; the assertions themselves are spec-correct and must stay.
- Verified: `__tests__/sim/khalti.sim.ts` has no `origin`, no `refund` endpoint, no `refundOk`/`refundOther` (grep `refund|origin` hits only lookup lines 29, 37). So 28 tests fail on harness errors, not on adapter behaviour. Commit b78c940f does not touch the sim, despite tests.md saying it was "extended additively".
- Assertions match the spec: path `/api/merchant-transaction/{transaction_id}/refund/`, `transaction_id` from lookup, optional `amount`, success `{"detail": "Transaction refund successful."}` (spec/chunks/C15-payment-gateways/02-TRD.md:25 V13; 01-PRD.md:251). UNVERIFIED method/auth means the adapter stays disabled by default (02-TRD.md:25, §7.4). That is consistent with "one attempt, anything unexpected -> unknown".
- Fix (tester, additive only, in `__tests__/sim/khalti.sim.ts`):
  1. `KhaltiSim.origin`: scheme + host of the sim, no path.
  2. `sim.refund: KhaltiEndpoint` with `.script(...)`, served at `POST /api/merchant-transaction/<id>/refund/`. Record it in `sim.requests` (method, path, authorization, parsed body). Apply the same `Key <apiKey>` check as lookup (mismatch -> `invalidToken`). Clear it in `reset()`.
  3. `khaltiReplies.refundOk() = { status: 200, body: { detail: 'Transaction refund successful.' } }` and `khaltiReplies.refundOther(status, body)`.
  The existing `invalidToken/notFound/serverError/malformed/drop/hang` replies must also be scriptable on `sim.refund`.
- Do not change any assertion in `khalti.refund.sim.test.ts`. The writer's adapter needs no change for this dispute.
