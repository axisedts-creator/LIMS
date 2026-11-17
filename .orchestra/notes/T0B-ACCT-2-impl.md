# T0B-ACCT-2 impl (writer). Status: BLOCKED on 2 test defects (T0B-ACCT-2-dispute.md); 2150/2154 billing tests pass on PG17, static + crossTenant + boot (alone) 301/301.
- New: repository/expenses.repo.ts, service/expenses.service.ts, handlers/expenses.handlers.ts. Edited: handlers/index.ts (12 handlers), billing/index.ts (pendingOperations now []), service/accounts.service.ts (shared helpers exported), repository/accounts.repo.ts (findParty user_pocket).
- [CONV] user_pocket party = active core.memberships row or core.collection_centres row; expense debit = actor pocket, cash, local date of expense_at, comments null.
- [CONV] accept: transfer row FOR UPDATE -> 403 (receiver, never creator) -> 409 (not pending) -> tenant ledger lock -> balance re-check -> pair on particular CASH_TRANSFER (missing -> 400) -> UPDATE ... WHERE status = 'pending'.
- [CONV] cancelExpense: expense row FOR UPDATE; if its entry was already reversed via reverseAccountLedgerEntry, the cancel posts no second reversal.
- [CONV] daily summary: unreversed non-reversal account credits + getDailyCash rows (payment - |reversal/refund|, collected only) by payment_mode; zero rows dropped.
- [CONV] allow_negative_pockets via IdentityPort featureFlags (no spec name; tests pin it). Admin = role tenant_admin.
- Open: a day whose refunds exceed payments gives a negative total_paisa (contract minimum 0); accept centre falls back to ctx.centreId when neither end is a centre.
