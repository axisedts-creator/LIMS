# T0B-ACCT-1 dispute (writer, pass 3, LD-328)
TEST WRONG: services/api/src/modules/billing/__tests__/unit/boot.test.ts:38-42 ("has a handler for every billing.yaml operationId and no extra handler")
calls checkHandlers('billing', spec, manifest.handlers) WITHOUT manifest.pendingOperations and asserts handler keys == spec operationIds.
LD-328 (2) orders the 12 T0B-ACCT-2 503 stubs DELETED and listed in billing pendingOperations (done: handlers/index.ts, billing/index.ts),
so this test can never pass under the ruling: "Error: module billing: missing handler for operationId listExpenseTypes".
FIX (tester): checkHandlers('billing', spec, manifest.handlers, manifest.pendingOperations ?? []) and expect
handler keys + pendingOperations == spec operationIds (disjoint), as core/__tests__/pending-operations.test.ts:278-312 already does for every module.
OUT OF SCOPE, also failing: crossTenant frontdesk createCustomFieldDefinition / updateCustomFieldDefinition / updateCoupon / updateIcdCode
(T0B-REGAPI-2 parity ops: fieldDto TypeError, path B id answers validation_failed). On this lane frontdesk pendingOperations is [] so they are probed.
Everything else green: whole billing PG17 suite 2012 pass / 5 fail (the 5 above), all accounts tests green, crossTenant billing ops green, tsc clean.
