# T0B-STORAGE-1 debug
- Cause: verify failed only in core/__tests__/pending-operations.test.ts (billing, frontdesk). Not storage: stale `pendingOperations` lists (24 billing ids, 18 frontdesk ids) although every id now has a handler function (REGAPI-2, ACCT-1; ACCT-2 ops are 503 stubs). Test requires pending == ops without a handler.
- Fix: `pendingOperations: []` in modules/billing/index.ts and modules/frontdesk/index.ts. No test touched. All storage tests were already green.
- Re-ran pending-operations.test.ts: 68 passed, 1 skipped. Full core suite not re-run here.
