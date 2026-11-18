APPROVE

T0C-ACCTLIST-1 review (diff 4955b768..a3a65e13d), LD-358 / LD-325 / LD-310.
- Names verbatim from brief: listAccountSummaries, GET /v1/billing/account-summaries, billing.account.read (existing, no new permission), tenant, none, general.
- Error codes = getAccountSummary's six + common.invalid_cursor (same as listAccountParticulars, needed for cursor paging). Paging cursor/limit params and envelope (AccountSummaryRowPage) identical to listAccountParticulars/AccountParticularPage.
- AccountSummaryRow closed, all AccountSummary fields + party_name (maxLength 200); centre_id omitted per brief (AccountSummary has no centre). AccountSummary/getAccountSummary unchanged.
- Example synthetic (2 rows, no PHI). No secrets, no migration, no permission, no handler, no web change. RLS N/A (contract only).
- pendingOperations line only change in billing/index.ts; boot test green.
- Files: 10 non-notes files vs "at most 8" — overrun is the 4 regenerated artifacts plus 2 stale total pins (acct1, c4) that must move with +1 operation; not a defect.
- Tests run by reviewer: acctlist1+acct1+lint-openapi+c4 (1106 passed), billing acctlist1.pending+boot (14 passed), registry-equality (14 passed).
- Follow-ups recorded in impl notes: T0B-ACCTLIST-1 handler, T0D-UILIST-2 web list.
