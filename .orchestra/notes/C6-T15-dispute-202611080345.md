# C6-T15 dispute — stale T03 test (not a T15 test)
`services/api/src/modules/reporting/__tests__/settings.handlers.test.ts:46` "the other reporting operations are still 501 stubs" takes the first 5 operationIds outside T03_OPS and asserts each returns 501.
`listReports` (R1) is now one of those 5 and is correctly implemented by C6-T15 (task brief), so the assertion fails: it throws `auth.unauthenticated` for a ctx without actor/tx (required by the T15 contract test "fails closed").
Fix (tester/lead, I may not edit tests): exclude every implemented op from `others` (e.g. filter by the manifest.test IMPLEMENTED set) or pick ops known to be stubs.
Nothing in the T15 tests is disputed; all of them pass.
