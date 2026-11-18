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
5. Touch no other file. Writer and debugger: no code change needed; outbox.ts and engine.ts remain correct as is. If the task goes blocked again on this same rs-c4 area after this pass, escalate to the lead with the exact new strings instead of re-verifying again.
