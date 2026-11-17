APPROVE

Scope: `git diff 296ce779..HEAD` = additive change to `services/api/src/modules/payments/__tests__/sim/khalti.sim.ts` (+ impl note, dispute notes moved to old-disputes/). Matches LD-125 / PG-T15-ruling.md fix list exactly:
- `KhaltiSim.origin` (scheme+host, no path).
- `sim.refund` endpoint with `.script(...)`, served at `/api/merchant-transaction/<id>/refund/` (REFUND_PATH regex), recorded in `sim.requests` (method, path, authorization, parsed body), same `Key <apiKey>` check -> `invalidToken`, cleared in `reset()`; shared `next()` so invalidToken/notFound/serverError/malformed/drop/hang are scriptable.
- `khaltiReplies.refundOk()` = 200 `{detail: 'Transaction refund successful.'}`; `refundOther(status, body)`.
No test-named file or implementation file touched; owned path (TestExempt); no secrets, no PHI, synthetic only.

Checks run (2026-11-12):
- api `vitest run src/modules/payments/__tests__/sim`: 131/131 pass (incl. khalti.refund.sim.test.ts).
- worker `vitest run src/jobs/payments`: 148/148 pass.
- api `vitest run src/modules/payments`: 1743 pass, 1 fail — `unit/manifest.test.ts` (08 A17 P-20: PHASE_STUBS still lists PaymentProviderPort). Not in this diff (phase-stubs.ts untouched); pre-existing, belongs to the task that wires payments/index.ts, not PG-T15.

Note (not a defect): sim does not enforce POST on the refund route (same as lookup/initiate); method is recorded and asserted by the tests.
