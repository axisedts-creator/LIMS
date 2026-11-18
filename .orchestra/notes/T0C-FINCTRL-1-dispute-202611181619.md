# T0C-FINCTRL-1 dispute (debugger)

Only failing test: tools/codegen/__tests__/acctlist1-openapi.test.ts:260 ("no migration, no web page change"). It expects apps/web/src/app/(staff)/billing/accounts/summary/page.tsx NOT to contain `/v1/billing/account-summaries`.

That page now says (line 2 of the file): `// T0D-UILIST-2 (LD-358): one list read (listAccountSummaries, GET /v1/billing/account-summaries)`. So the T0D-UILIST-2 task (LD-358) deliberately made the page call the list; the T0C-ACCTLIST-1 pin was written before it and is stale.

Not caused by T0C-FINCTRL-1: the brief's files (billing.yaml, frontdesk.yaml, one migration, permissions, corp_admin pack, generated types, tests) never touch the web summary page, and the brief forbids web changes. Ruling note item 4 already lists this failure as outside the FINCTRL dispute.

Implementation fix is not possible without reverting T0D-UILIST-2 (another task's work). Needed: tester/arbiter changes line 260 (drop the page assertion, or allow the path now that LD-358 landed). All 4 other test files and the 127 finctrl1 tests pass.
