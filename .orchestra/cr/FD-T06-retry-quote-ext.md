Title: CR-C4-FD-T06-002: handler ctx has no tx opener (F9 retry-once) and LimsError has no problem extensions (fresh `quote` on 409)
From chunk: C4            To owner: C0-0C (api core: handler ctx, errors)
Type: shared-lib | api
Blocking? no (FD-T06 ships without the retry and without the `quote` extension; both are marked in registration.service.ts)
Problem: C4 03-APP-FLOW.md §2.3 requires (a) retry of steps 1-9 once in a NEW transaction on `billing.counter_busy` / SQLSTATE `40P01` (03-APP-FLOW.md:97, 08 A13 D-25), and (b) the stale-quote 409 `common.version_conflict` to carry the fresh quote in the problem extension `quote` (03-APP-FLOW.md:86; US-FD-03 stale quote). Today the handler receives one request tx (`ctx.tx`) with no way to roll it back and open another, and core `LimsError(code, detail?)` has no field for problem-details extension members.
Proposed change (exact): (1) Handler ctx: `withTx<T>(fn: (tx) => Promise<T>): Promise<T>` (or a handler-level `retryOn: ['billing.counter_busy','40P01'], maxRetries: 1` option in the route registry) so the request tx can be rolled back and retried once. (2) core errors: `new LimsError(code, detail?, extensions?: Record<string, unknown>)`, serialised as top-level members of the application/problem+json body (RFC 9457 extension members), validated against the route's error response schema.
Backward compatible? yes (optional param / optional ctx member)
Tenant/security impact: none; the `quote` extension contains only the caller's own priced draft (no PHI). Retry re-runs RLS-scoped statements under the same tenant/actor.
IRD/regulatory impact: none (invoice counter consumed only in the committed tx; a rolled-back attempt leaves no gap, 04 L-rows unchanged).
Alternatives considered: retry inside C4 via SAVEPOINT (not equivalent: 40P01 aborts the whole tx); returning the quote in `detail` (string only, breaks the schema).
Tests that will prove it: FD-T06 rollback.test.ts + one forced `billing.counter_busy` on the first attempt (expect 201, one invoice, one event); registration.test.ts stale-quote case asserts `body.quote.fingerprint` equals a fresh F8 quote.
