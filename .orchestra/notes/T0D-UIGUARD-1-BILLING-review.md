APPROVE

Reviewed `git diff 3f1b7e9ac..HEAD` (22 files, inside the 30 file limit; nothing under features/admin, features/platform, app/(auth), app/(platform); tokens.json and shell.css not touched).
- Done when (1) rule 2: AccountEntries, AccountLedger, PocketLedger, CashTransfers, DailyCash, DailyCollection, PartysetCommon SearchBar, DiscountSlabs and Expenses now render the kit FilterBar. The FilterBar change is additive (optional filters/value/onChange/onReset, children, aria-label) and keeps role=search/.lims-filter-bar, as LD-441 allows.
- Done when (2) rule 5: InvoiceDetailView print history keeps its thead when empty (EmptyRow + PlaceholderRows); credit notes and CBMS moved to DataTable.
- Done when (3): the registry has no BILLING entries (tester's 3f1b7e9ac, plus 14 stale PARTNERS routes per the arbiter ruling); both BILLING sections were removed from notes/T0D-UIGUARD-1-exceptions.md; nothing was added.
- Done when (4) rule 7: raw h2/h3/ul in the billing files became Card titles, DataTable, or role=heading aria-level; the guard is green.
- Display only: no route, permission, API, operation or contract change. The rs-c4 "Daily cash (open shift)" snapshot was re-recorded by the writer (LD-440) and shows markup and ids only: NPR 100.00 is unchanged and no amount, permission or route changed. No PHI, no secrets, no invented names. RLS, idempotency and rate tier are not in scope (UI only).
Checks run by reviewer: uiguard1 36/36; billing acct1 199/199, acct2 273/273, bl-t20 54/54, bl-t23 25/25, finctrl1 392/392; packages/ui uikit1.table + batch2-data 90/90.
