# T0D-BUILD-1 tests (tester)
- API (new): billing/__tests__/accounts/summaries.guard.test.ts (no DB: contract, pending line, guard order) and summaries.test.ts (PG17: row == getAccountSummary, filters, cursor paging, bad input, other/empty tenant).
- API (edited, reason: operation leaves pending/stub): contract/acctlist1.pending.test.ts (id now a handler, not pending); authz6.billing-guards.test.ts (listAccountSummaries removed from the stub list).
- Web (new): apps/web/src/features/billing/__tests__/build1.accountsummaries.test.tsx; config apps/web/src/__tests__/vitest.build1.config.ts (also runs all existing billing web tests).
- Web (edited): uilist2.accounts.test.tsx summary "no rows" header pin 13 columns -> 5 columns (name, kind, limit, outstanding, blocked). Its 501 NotAvailable test is kept: keep a graceful 501 fallback.
- Run: `.orchestra\notes\T0D-BUILD-1-verify.cmd` (needs Docker for PG17 via tests/billing/T0D-BUILD-1.pg.sh; Docker was NOT running here, so summaries.test.ts was only loaded, never executed).
- State now: guard test 10 red, pending test 1 red, web 12 red (right reasons: no handler, still pending, no kind select/switches/totals/paging); 17 other web files green.
- Writer: tests/security/authz-classification.json still says `stub` for listAccountSummaries; regenerate it (snapshot already drifts on this branch, test authz-classification.test.mjs fails before this task).
- Pins the writer may dispute are listed in the header comments of summaries.test.ts and build1.accountsummaries.test.tsx.
