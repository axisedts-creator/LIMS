Title: CR-C15-0xx: core rate limiter rejects the key `payments:cb:<intent_id>` (TRD §6.3 step 2)
From chunk: C15            To owner: C0-0B (core rate limiter)
Type: shared-lib
Blocking? yes for production wiring of PG-T09 (P30-P33). The service is written to the TRD key; tests pass against a spy.
Problem: core `createRateLimiter` only accepts key prefixes `u:` / `t:`; `ctx.rateLimit.consume('general', 'payments:cb:' + intentId)` (TRD §6.3 step 2, 08 A19 D-116) would throw "unknown tier or key prefix". The service only treats `common.rate_limited` as a throttle and rethrows anything else (so a misconfigured limiter is loud, not silently open).
Proposed change (exact): accept the key prefix `payments:cb:` for tier `general` (or a generic documented `<module>:<purpose>:<id>` prefix rule).
Backward compatible? yes.
Tenant/security impact: none new; REQ-SEC-052/078/079 (per-intent throttle on the public token routes).
Alternatives considered: key `t:<tenant_id>` (shares the tenant bucket with staff traffic: one hot intent could starve the tenant) — rejected.
Tests that will prove it: core limiter unit test for the new prefix; PG-T09 contract test "every token route consumes the general tier with payments:cb:<intent_id>".

Also for the spec owner (not a blocker): when the `paymentCallback` resolver returns `undefined` the core answers `auth.unauthenticated`, but TRD §5.2/§6.3 say `303 /v1/payments/result?outcome=unknown` for every invalid token (no existence oracle). The handlers give the 303 only when they are reached; the core must route a failed `paymentCallback` resolution to the handler (or return that 303 itself).
