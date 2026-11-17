APPROVE

Re-review after the LD-334 reset (T0B-ACCT-2 FIRST reset, verify + review only).

Scope note: the inbox range f9952172117e..HEAD is empty (HEAD = f99521721, the lane merge of main). The T0B-ACCT-2 work is in 75bfec8b6..d304a23b6 (tester, writer, arbiter ruling, debugger rounds 1-3, review fixes); that range plus the main merge carrying T0C-ACCTFIX-1 was reviewed.

Prior CHANGES item 1 (negative daily summary vs `minimum: 0`): RESOLVED by the LD-334 ruling (a) signed net, implemented on the contract side by T0C-ACCTFIX-1: contracts/openapi/billing.yaml DailyCollectionRow.entry_count (int32 bounds), DailyCollectionRow.total_paisa and DailyCollectionSummary.total_paisa (±2^53-1) now allow negatives with LD-334 descriptions. No handler change, no clamping (expenses.service.ts dailySummary / expenses.repo.ts dailyCollection unchanged since the first review, as the ruling requires). dailySummary.test.ts adds the refund-only day test (payment on D-1, reversal on D) checking the response against the bounds read from billing.yaml.

Re-checked, no defect:
- billing/index.ts pendingOperations is [] (LD-325 b / LD-328): all 12 ACCT-2 operations have handlers.
- Since the first review only invoice.service.ts previewNo, BillingCommandPort.impl.ts and previewInvoiceNo tests changed in billing (T0B-REGAPI-2 work merged via main, not ACCT-2 scope).
- Ledger: createExpense posts one debit (expense type particular) in the request tx; cancelExpense locks the row, posts one reversal unless the entry is already reversed (derived status, read after the tenant ledger lock), never deletes; accept takes the row lock, then the tenant ledger lock, re-checks the pocket balance and posts the balanced debit/credit pair with the status change; reject/cancel post nothing; decided transfers -> common.immutable_record; creator can never decide (contract acceptCashTransfer); allow_negative_pockets default off.
- Tenant isolation: tenant_id = $1 on every query on top of RLS, bound params only; audit via row triggers plus account_entry.create/.reverse with ids only; no logging of remark/description/reason; no secrets; owned paths only.
