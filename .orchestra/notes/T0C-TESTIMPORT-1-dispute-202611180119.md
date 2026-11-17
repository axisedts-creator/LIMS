# T0C-TESTIMPORT-1 dispute (debugger)
- Only failing test: tools/codegen/__tests__/testmgmt1-openapi.test.ts:562 "catalog module manifest lists the three new operationIds in pendingOperations" (852/853 pass).
- Test demands the 3 test category ids (listTestCategories etc.) stay in services/api/src/modules/catalog/index.ts pendingOperations.
- Contradicts LD-325(b): "every T0B handler task removes the ids it implements from that list". T0B-TESTMGMT-1 (commit 9125f44fa) merged the handlers and removed them, so the pin is stale. Fails on base too (see T0C-TESTIMPORT-1-impl.md OPEN).
- Impl fix impossible without re-adding ids that have handlers (LD-325(a): only a warning, but wrong per the rule). Not editing the test: debugger may not.
- Needed: arbiter/lead rules TESTS_WRONG; tester drops or flips the pin (handlers exist, ids absent from pendingOperations).
