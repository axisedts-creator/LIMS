# T0C-ACCTLIST-1 dispute (writer): 2 of 24 acctlist1 tests are wrong; the other 1104 tests of the verify run are green
Contract, pendingOperations, regenerated clients and the impl notes are done (see T0C-ACCTLIST-1-impl.md). acct1, lint-openapi, c4, acctlist1.pending, billing boot and registry-equality all pass.

1. `tools/codegen/__tests__/acctlist1-openapi.test.ts:240` `expect(ts).toContain("AccountSummaryRow")` cannot pass. The codegen inlines every schema into `operations[...]`
   and emits no component schema names or descriptions: `packages/api-client-ts/src/billing.ts` does not contain `AccountSummary` either (only the operation keys). The new row is present inline
   (billing.ts:7747-7755, with party_name), and `codegen --check` (staleFiles) is green. Fix: drop that one line, or assert `party_name: string` inside the listAccountSummaries block.
2. `tools/codegen/__tests__/acctlist1-openapi.test.ts:259` asserts that `apps/web/src/app/(staff)/billing/accounts/summary/page.tsx` does not contain `listAccountSummaries`.
   That page ALREADY contains it (line 4/8, since T0D-ACCT-1 commit 33ff41fc0): it is the web's own per-party fallback helper of
   `@/features/billing/server/accounts.server` (the fallback LD-339 mentions), not a call of the new operation. The writer may not edit web files. Fix: compare the file with
   its state at the task base (unchanged by this task), or assert that it does not contain `/v1/billing/account-summaries`.
