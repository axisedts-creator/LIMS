TESTS_WRONG — tools/codegen/__tests__/testmgmt1-openapi.test.ts:558-563 pins listTestCategories, createTestCategory, updateTestCategory in catalog pendingOperations; that pin was only true until T0B-TESTMGMT-1 merged.

Reasons:
- spec/chunks/C0-foundation-contracts/01-PRD.md:189 (AC-0D-1.2): boot requires a handler per spec operationId; pendingOperations (LD-325(a), binding lead decision quoted in the task brief) is only the temporary exemption for ids WITHOUT a handler.
- LD-325(b) (brief, binding): "every T0B handler task removes the ids it implements from that list" — T0B-TESTMGMT-1 is named there and did so (commit 9125f44fa).
- Handlers now exist: services/api/src/modules/catalog/handlers/masters.handlers.ts:42-44; the ids are absent from services/api/src/modules/catalog/index.ts:19, as LD-325 requires.
- The sibling API test already asserts the post-handler state: services/api/src/modules/catalog/__tests__/testmgmt/boot.test.ts:2 ("no pendingOperations left in catalog" for these ids).
- LD-335 (brief): T0C tasks add only their OWN new ids to pendingOperations; T0C-TESTIMPORT-1 must not re-add TESTMGMT ids.

Change to the test (tester): in testmgmt1-openapi.test.ts:558-563, keep the `pendingOperations` declaration check, and flip line 562 so each NEW_OPS id is NOT in the parsed pendingOperations array (parse the array literal, do not use a whole-file toContain) and IS registered in handlers/masters.handlers.ts. Retitle the `it` to say the T0B handler task removed them (LD-325(b)). No implementation change.
