TESTS_WRONG — boot.test.ts:38-42 asserts handlers == every billing.yaml operationId, which the binding lead decisions no longer require.
Reasons:
- spec/chunks/C0-foundation-contracts/01-PRD.md:189 (AC-0D-1.2) requires boot to fail on a missing handler; LD-325 (a) (inbox brief, binding, overrides spec text) amends this: a spec operation with no handler is allowed iff listed in the module's pendingOperations.
- LD-328 (2) orders the 12 T0B-ACCT-2 operations to STAY in billing pendingOperations with their 503 stubs DELETED, so handler keys can never equal all operationIds on this task; the test contradicts a binding ruling.
- core/module.ts:165 checkHandlers already takes the 4th `pending` arg; core/__tests__/pending-operations.test.ts:288-295 already asserts pending == spec ops lacking a handler for every module.
CHANGE IN TEST (tester, services/api/src/modules/billing/__tests__/unit/boot.test.ts:38-42):
- call `checkHandlers('billing', spec, manifest.handlers, manifest.pendingOperations ?? [])` and expect it not to throw;
- expect `[...Object.keys(manifest.handlers), ...(manifest.pendingOperations ?? [])].sort()` toEqual `[...operationIds(spec)].sort()`, and assert the two sets are disjoint (no pending id has a handler key, per LD-328 (3));
- keep the "no extra handler" intent (every handler key is an operationId). Do not drop the assertion that operationIds(spec).length > 0.
Out of scope: the 4 frontdesk crossTenant failures (T0B-REGAPI-2 parity ops) are not ruled here; they belong to T0B-REGAPI-2.
