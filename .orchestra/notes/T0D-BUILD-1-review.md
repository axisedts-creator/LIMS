APPROVE

Scope note: the named range ca9e9a02c..HEAD holds only notes (impl + ruling). Reviewed the whole task (c13f05779^..HEAD, BUILD-1 files only, BUILD-3 merge files excluded).

Checked against billing.yaml listAccountSummaries (:5705) and AccountSummaryRow (:10979):
- Names verbatim: route, operationId, x-permission billing.account.read, params party_kind/q/blocked_only/outstanding_only/cursor/limit (1..200, default 50), common.invalid_cursor, common.validation_failed. Contract not edited (guard test pins it).
- Permission first: guarded('billing.account.read', ...) like the neighbouring account reads; guard tests cover deny, adjacent permissions, port failure.
- Tenant: every CTE arm filters tenant_id = $1; no new table, no migration, so RLS is unchanged. Foreign/other-tenant cursor resolves to no anchor = empty page, no leak (tested).
- Same figures as getAccountSummary: same ledger sum (status <> 'held'), same sided(), limit NULL = 0, is_blocked = is_locked; tested on one fixture plus 200 random entries.
- outstanding_only `s <> 0` = outstanding_paisa > 0 (paisa is the absolute value), matches the contract text.
- q: LIKE metacharacters escaped, ESCAPE '\\', NUL refused; cursor key regex-checked before ::uuid cast. Bad input = typed 400 (it.each covers cursor, party_kind, limit, q, switches).
- Read only, x-idempotency none, no access_log write (matches getAccountSummary). No PHI or secret in code/tests; synthetic data.
- Web: kit only (FilterBar, Switch, DataTable, Badge, Banner), money via formatAmount, name links to the ledger screen, page totals, Next/First page, empty/error/400 states; URL values shape-checked before forwarding.

Open, not a defect of this task:
- user_pocket not listed (no name source in the data model) — honestly recorded in notes/T0D-BUILD-1-left.md; kind filter answers empty 200. Needs a lead ruling.
- unit/boot.test.ts "every billing operation is mounted" times out at issuePartialCreditNote, before reaching listAccountSummaries; untouched by this branch. Lead to triage.
