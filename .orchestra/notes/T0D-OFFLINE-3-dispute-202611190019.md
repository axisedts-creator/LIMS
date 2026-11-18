# T0D-OFFLINE-3 dispute (debugger, 2026-11-19)
rs-c4 guard tests contradict already-ruled, already-merged work. OFFLINE-3 touches none of it (only RegistrationForm offline paths; outbox/engine one optional field + one WIRE_KEYS entry). LD-393: "if blocked again on this same area, escalate to the lead with the exact new strings".
Rulings cited: LD-310 and LD-353 (REGSCREEN-2 drafts: "Save as draft" + "Drafts" buttons), LD-391/LD-393 (billing accounting drift allowed). Still failing after tester commit 7d2265509 (LD-393 allow-list not effective).
Exact strings (rs-c4 tester files):
1. static "same bytes": extra files src/features/billing/server/{accounts.actions,accounts.server,expenses.actions,expenses.server}.ts
2. frontdesk_feature routes: extra "/v1/catalog/tests"
3. billing_feature server_imports: extra server/accounts.actions, server/accounts.server, server/expenses.actions, server/expenses.server
4. billing_app server_symbols not matching trf_symbol: PARTY_KINDS PartyKind TRANSFER_TABS TransferTab UUID_RE cleanFilters dateRange expenseFilters getAccountStatement getDailyCollectionSummary listAccountGroups listAccountLedgerEntries listAccountParticulars listAccountParties listAccountSummaryRows listCashTransfers listExpenseTypes listExpenses listMembers
5. rs-c4.register.test.tsx:122 expects no /draft/i button; REGSCREEN-2 added two (RegistrationForm.tsx:891-892)
6. rs-c4.screens.test.tsx "Daily cash (open shift)" snapshot lacks the UIDASH stat row + chart card
Needed: lead ruling, tester widens LD310_ALLOW (1-4), updates test 5, re-records snapshot 6. Never regenerate rs-c4.baseline.json.
