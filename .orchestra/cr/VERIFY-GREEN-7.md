Title: CR-C1-VERIFY-GREEN-7: 4 existing web tests red because of product/contract drift (not caused by VERIFY-GREEN-7)
From chunk: C1            To owner: lead (owners of instruments / inventory web features)
Type: bug
Blocking? no. VERIFY-GREEN-7 (types only) is done without these. They stay red until the lead rules.
Problem (what you cannot do today, with the user story / acceptance criterion it serves):
done_when "the same tests, same assertions, green" (LD-268, LD-256 backlog). These 4 tests are red at e98ca0ace and at HEAD; the tester re-ran each with the old msw key and got the same result. VERIFY-GREEN-7 changed only types and the msw option name. It changed no product file and no assertion.
1. apps/web/src/features/instruments/__tests__/rs-c7.static.test.ts — permission-literal list. Question: does the product permission set or the test's expected literal list reflect the spec (03-INTERFACE-CATALOG permissions)?
2. apps/web/src/features/instruments/__tests__/rs-c7.screens.test.tsx — messages snapshot differs (useId counter in rendered ids). Question: should the snapshot be regenerated, or should the test stop depending on useId output?
3. apps/web/src/features/instruments/__tests__/web-t03.components.test.tsx — 'renders one link card' (an A5 columnheader conflict). Question: is the current product markup (table/columnheader) the intended UI, so the test expectation is stale?
4. apps/web/src/features/inventory/__tests__/t20.alerts.test.tsx — 'API 500 -> page throws': the product page no longer throws on an API 500. Question: is the error-boundary throw still required by the spec, or is the in-page error state now the contract?
Proposed change (exact): none in this task. The lead rules for each item whether the fix is product or test. If it is test: a tester task updates the assertion or snapshot. If it is product: the owning feature task fixes it.
Backward compatible? yes (no contract change proposed).
Tenant/security impact: none. No RLS, PHI, public surface or permission granted. Item 1 only asks which literal list is correct.
IRD/regulatory impact: none (no billing code).
Alternatives considered: edit tests/snapshot inside VERIFY-GREEN-7. Rejected because done_when forbids behaviour changes and this task's writer may not change assertions.
Tests that will prove it: the 4 named tests green under their feature vitest configs, with vg7 still 7/7.
