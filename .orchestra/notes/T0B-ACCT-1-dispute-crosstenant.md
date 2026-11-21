# T0B-ACCT-1 dispute (debugger): crossTenant.handlers.test.ts vs ACCT-2 stubs
- probes/crossTenant.handlers.test.ts:55 ("common.service_unavailable is a failure for every non-deferred operation", LD-98) and :72 fail for the 12 operations T0C-ACCT-1 split off to T0B-ACCT-2: listExpenseTypes, createExpenseType, updateExpenseType, createExpense, listExpenses, cancelExpense, createCashTransfer, listCashTransfers, acceptCashTransfer, rejectCashTransfer, cancelCashTransfer, getDailyCollectionSummary.
- handlers/index.ts:27 and the T0B-ACCT-1 brief scope = the first 12 ops; the other 12 stay 503 stubs until T0B-ACCT-2. Implementing them here exceeds the task scope.
- Ask: lead rules that the probe exempts ACCT-2 ops until T0B-ACCT-2 lands, or that ACCT-1 verify excludes this file.
