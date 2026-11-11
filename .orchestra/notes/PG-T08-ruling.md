TESTS_WRONG — two test defects; implementation stands.
1. Tenant mismatch (8 tests): `__tests__/helpers/merchantDb.ts:313-316` default `transitions/gatewayCalls/intents/accounts` to local `TENANT_A = 01930000-…0a` (line 16), but harness ctx uses `TENANTS.A = 01900000-…0a` (packages/fakes/src/base.ts:10,12). Calls like `h.db.transitions()` (intent.service.test.ts:65,75,102,292,333,348,392,460,477,498,541) read another tenant's empty rows. Spec never requires two tenant ids; it is a fixture bug.
   Change: in the test, pass `A` explicitly (e.g. `h.db.transitions(A)`, `h.db.gatewayCalls(A)`) or have `makePortHarness` build the db with default tenant `TENANTS.A`. Do not loosen any assertion.
2. Contradictory assertion (1 test): intent.service.test.ts:442 expects `'initiated'` after eSewa `PENDING` on an `initiated` intent; line 459 (same setup) expects `'pending'`.
   Spec: 02-TRD.md:136 (I3 `initiated`→`pending` on eSewa `PENDING`, transition row), 02-TRD.md:335 and :429 (`PENDING` ⇒ `to_pending`), 03-APP-FLOW.md:13. So `'pending'` is right.
   Change: line 442 assert `.toBe('pending')`; the interval/check-count assertions (443-447) stay unchanged.
