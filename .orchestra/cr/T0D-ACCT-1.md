Title: CR-C0-0D-ACCT1: list endpoint for account summaries
From chunk: C0-0D            To owner: C0-0C (contract), C0-0B (handler)
Type: api
Blocking? no (T0D-ACCT-1 works with per-party calls, capped at 5 in flight and 200 parties)
Problem: Account Summary (billing/accounts/summary) must show every client and franchise. getAccountSummary (GET /v1/billing/account-summary) takes one party, so the page makes one call per party under rate tier `general` (02-CONVENTIONS §10.3: 10 req/s, burst 20). Above ~200 parties the list is cut and a warning banner shows; under load some parties fail and are counted in a warning banner instead of shown.
Proposed change (exact): add a paged list operation in contracts/openapi/billing.yaml returning the existing AccountSummary schema per item, filtered by optional party_kind and centre_id, cursor paging per 02-CONVENTIONS; permission billing.account.read. Operation name and path to be chosen by C0-0C from the contract naming rules (this CR does not invent them).
Backward compatible? yes (additive endpoint)
Tenant/security impact: same RLS and permission as getAccountSummary; no new PHI field.
IRD/regulatory impact: none (read only, no money moves).
Alternatives considered: per-party calls with a concurrency cap of 5 (shipped now in T0D-ACCT-1, accounts.server.ts listAccountSummaries).
Tests that will prove it: contract test for the list op; acct1.summaries.server.test.ts switched to the list op with failed always 0 and no 200 cut.
