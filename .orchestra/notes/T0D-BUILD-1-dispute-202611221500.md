# T0D-BUILD-1 dispute (writer)
Test: apps/web/src/features/billing/__tests__/acct1.screens.test.tsx, describe "billing/accounts/summary — Account Summary" (13 tests, lines 567+).
Why wrong now: it pins the retired T0D-ACCT-1 component API (props summaries / parties / failed / truncated) and EXACTLY the 13 ElabAssist party-detail columns
(SUMMARY_COLUMNS, line 121). The task's own tests require the opposite: build1.accountsummaries.test.tsx needs a Kind column (/kind|type/) and the kind in words,
and uilist2.accounts.test.tsx was edited by the tester to the 5 column list ("the 13 column party-detail layout is retired"). Both cannot pass with one component.
The tester's commit c13f05779 edited uilist2 but missed acct1. The included config vitest.build1.config.ts runs acct1.*, so done_when (4) is red only on these 13.
Ask: retire or rewrite that describe block to the new screen (props headers / rows / nextCursor / filters; columns Name, Kind, Credit Limit, Outstanding Amount,
Debit/Credit, Is Blocked). Everything else in the web config is green (441 passed); the writer did not touch the test.
