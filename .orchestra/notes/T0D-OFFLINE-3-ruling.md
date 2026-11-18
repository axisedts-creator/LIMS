TESTS_WRONG — the rs-c4 guard asserts that already-landed, already-ruled feature work (T0B-ACCT-1/T0B-FINCTRL-1 accounting, T0D-REGSCREEN-2 drafts, T0D-UIDASH-1 stat row + chart) never happened; no spec line requires T0D-OFFLINE-3 to undo it.
Reasons (arbiter, 2026-11-19, after re-running vitest.rs-c4.config.ts: exactly the 6 failures listed in T0D-OFFLINE-3-dispute.md, nothing else):
1. rs-c4 enforces LD-140 "restyle = behaviour unchanged" (spec/program/10-DESIGN-SYSTEM.md:132-136); it binds restyle tasks, not later approved feature tasks. `git diff main...HEAD -- apps/web` shows OFFLINE-3 lane changes only the two rs-c4 tester files; none of the 6 drifts is OFFLINE-3 code.
2. LD-391/LD-393 (task brief) already ruled the billing accounting drift allowed via LD310_ALLOW, but under-scoped it; items 1-4 below are the rest of that same drift.
3. LD-353 (task brief) names T0D-REGSCREEN-2 and T0D-UIDASH-1 as approved UI work: RegistrationForm.tsx:891-892 "Save as draft"/"Drafts" (ghost, not primary) and the REPORT-template stat row + chart (LD-353 rule 10, template 5) are approved behaviour, so test 5 and snapshot 6 are stale.
4. rs-c4.baseline.json stays untouched (its own header comment); fix by extending LD310_ALLOW, same mechanism as LD-391/LD-393.

TESTER (files rs-c4.signature.ts, rs-c4.static.test.ts, rs-c4.register.test.tsx, and the rs-c4.screens snapshot file only; comment each change "LD-391/LD-393 follow-up, T0D-OFFLINE-3 arbiter"):
1. signature.ts LD310_ALLOW: add `logic_files_added` = exactly ['src/features/billing/server/accounts.actions.ts','src/features/billing/server/accounts.server.ts','src/features/billing/server/expenses.actions.ts','src/features/billing/server/expenses.server.ts']. static.test "same bytes": compare keys of `now` minus entries that are in logic_files_added AND not in baseline.logic; separately assert every baseline.logic key still exists.
2. Add `route_strings_added` = exactly ['/v1/catalog/tests']; change `expect(added(was.routes, now.routes)).toEqual([])` to filter out route_strings_added.
3. Add to LD310_ALLOW.server_imports exactly: 'server/accounts.actions','server/accounts.server','server/expenses.actions','server/expenses.server'.
4. Add `accounts_symbols` = exactly the 19 names in dispute item 4 (PARTY_KINDS PartyKind TRANSFER_TABS TransferTab UUID_RE cleanFilters dateRange expenseFilters getAccountStatement getDailyCollectionSummary listAccountGroups listAccountLedgerEntries listAccountParticulars listAccountParties listAccountSummaryRows listCashTransfers listExpenseTypes listExpenses listMembers); exclude them when computing extraSymbols (before the trf_symbol and length<=1 checks).
5. Not-vacuous test: add expect lengths logic_files_added 4, route_strings_added 1, accounts_symbols 19; expect(LD310_ALLOW.accounts_symbols).not.toContain('deleteEverythingAction').
6. rs-c4.register.test.tsx:122: replace the no-draft assertion with: buttons named exactly "Save as draft" and "Drafts" exist and neither has class lims-btn-primary (primary stays only "Register & print").
7. Re-record ONLY the "Daily cash (open shift)" snapshot (`vitest -u -t "Daily cash \(open shift\)"`); confirm no other snapshot changed in the diff.
WRITER and DEBUGGER: no code change. If rs-c4 fails again on new strings, escalate to the lead per LD-393; do not re-verify.

---- prior lead items (unchanged) ----

## LEAD ITEM LD-391 FOR THE TESTER (written by the lead, 20:55 NPT; this is a test file item and it is yours)
Files: src/features/frontdesk/__tests__/rs-c4.signature.ts and src/features/frontdesk/__tests__/rs-c4.static.test.ts. Change only these two files. Never edit rs-c4.baseline.json.
Why: the rs-c4 restyle guard (LD-140/LD-310) compares the live tree to the frozen baseline. OFFLINE-3 itself only touches outbox.ts and engine.ts (one WIRE_KEYS entry, one optional field); it adds no route and no permission. The 2 failures are both already-landed, already-ruled billing accounting UI (the T0B-ACCT-1/T0B-FINCTRL-1 area) that this lane pulled in from main at task start, not an OFFLINE-3 regression:
  (a) billing_app area: 7 new permission codes not yet in LD310_ALLOW.permissions: billing.account.manage, billing.account.read, billing.accounts.col.blocked, billing.accounts.col.credit_limit, billing.accounts.col.outstanding, billing.accounts.col.side, billing.accounts.summary.title.
  (b) whole app route tree hard pin (routeFiles() vs baseline.route_files, no allow-list exists for this check yet): 8 new files, all additions, no removal: src/app/(staff)/billing/accounts/entries/page.tsx, billing/accounts/ledger/page.tsx, billing/accounts/masters/page.tsx, billing/accounts/pocket/page.tsx, billing/accounts/summary/page.tsx, billing/cash-transfers/page.tsx, billing/expenses/page.tsx, billing/expenses/types/page.tsx.
1. In rs-c4.signature.ts add a new readonly array routes_added to LD310_ALLOW containing exactly the 8 paths listed above, no others.
2. Add the 7 permission codes listed above to LD310_ALLOW.permissions in rs-c4.signature.ts, no others.
3. In rs-c4.static.test.ts change the route tree assertion (expect(routeFiles()).toEqual(baseline.route_files)) to: first remove from routeFiles() any path that is in LD310_ALLOW.routes_added and is not already in baseline.route_files, assert that filtered list equals baseline.route_files, and separately assert every path in baseline.route_files is still present in routeFiles() (a real removal of an existing route must still fail the test).
4. Add one assertion to the existing allow-list-is-not-vacuous test checking LD310_ALLOW.routes_added has length 8, mirroring the existing logic_files length check.
5. Touch no other file. Do not regenerate rs-c4.baseline.json. Writer and debugger: no code change; outbox.ts and engine.ts are correct as is.


## LEAD ITEM LD-393 FOR THE TESTER (written by the lead, 21:40 NPT; this is a test file item and it is yours; supersedes nothing in LD-391, only adds to it)
Files: src/features/frontdesk/__tests__/rs-c4.signature.ts and src/features/frontdesk/__tests__/rs-c4.static.test.ts. Change only these two files. Never edit rs-c4.baseline.json.
Why: LD-391 only named 7 permission codes, but the already-landed billing accounting UI (T0B-ACCT-1/T0B-FINCTRL-1 area) actually added 152 billing.* strings in total (almost all i18n/column-label keys picked up by the same extractor as real permission codes) plus 2 server_imports. Verified: every one of the 152 added strings matches the single pattern below, checked against the full added-list from the verify log, zero misses. OFFLINE-3 itself adds no permission, route or server_import.
1. In rs-c4.signature.ts, add to LD310_ALLOW a new entry:
   billing_accounts_strings: /^billing\.(account_entry|cash_transfer|expense)\.|^billing\.accounts\.(col|entries|error|field|filter|ledger|masters|pocket|reason|receipt|summary)\./,
   with a one-line comment that it covers the T0B-ACCT-1/T0B-FINCTRL-1 accounting UI i18n and column-label keys landed on main, not a general escape hatch.
2. In the same LD310_ALLOW object, add to server_imports (literal strings, no others):
   '@/features/billing/server/accounts.server',
   '@/features/billing/server/expenses.server',
3. In rs-c4.static.test.ts, change the line:
   expect(added(was.permissions, now.permissions).filter((p) => !(LD310_ALLOW.permissions as readonly string[]).includes(p))).toEqual([]);
   to also exclude anything the new regex matches, e.g.:
   expect(added(was.permissions, now.permissions).filter((p) => !(LD310_ALLOW.permissions as readonly string[]).includes(p) && !LD310_ALLOW.billing_accounts_strings.test(p))).toEqual([]);
   (same style already used for trf_symbol filtering server_symbols a few lines below).
4. In the "allow-list guard is not vacuous" test, add one line: expect(LD310_ALLOW.billing_accounts_strings.test('frontdesk.order.cancel')).toBe(false);
5. Touch no other file. Writer and debugger: no code change needed; outbox.ts and engine.ts remain correct as is.
