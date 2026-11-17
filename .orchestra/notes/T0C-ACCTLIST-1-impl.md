# T0C-ACCTLIST-1 impl (LD-358, LD-325, LD-310)
- contracts/openapi/billing.yaml: + GET /v1/billing/account-summaries `listAccountSummaries` (billing.account.read, tenant, idempotency none, general; filters party_kind, q maxLength 80, blocked_only, outstanding_only; cursor/limit copied from listAccountParticulars; error codes of getAccountSummary + common.invalid_cursor) + schemas AccountSummaryRow (closed) and AccountSummaryRowPage (envelope like AccountParticularPage), 2-row synthetic example.
- services/api/src/modules/billing/index.ts: pendingOperations = ['listAccountSummaries'] (LD-325, 501 operation_pending until handler).
- Regenerated: packages/api-client-ts (billing.ts, server/operations.ts), api-client-dart billing.dart, fakes msw handlers.generated.ts.
- [CONV] centre_id omitted from AccountSummaryRow: AccountSummary carries no centre, so the existing summary data has none (brief: omit unless data allows it).
- [CONV] envelope schema named AccountSummaryRowPage after the <Item>Page pattern.
- Follow-ups (lead): T0B-ACCTLIST-1 handler (tenant-scoped paged SELECT over ledger + credit account; removes the pendingOperations entry), then T0D-UILIST-2 web list on /billing/accounts/summary.
- No migration, no permission, no handler, no web change. AccountSummary and getAccountSummary unchanged.
