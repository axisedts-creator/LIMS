# T0D-UIGUARD-1 exceptions

Mirror of apps/web/src/core/__tests__/uiguard1.exceptions.ts (tester-owned registry). One line per entry: route, rule N, reason.
STANDING = real obstacles (pinned rs-c2.static admin pages, registration entry form, label print sheet, catch-all placeholder).
Other groups = LD-434 legacy baseline (CR-C0-0D-UIGUARD-1 option A); the heading is the follow-up task id the lead queues. When the follow-up fixes a file its entries go stale and the guard fails until the tester deletes them.

## STANDING (7 entries, 5 routes)

- /admin/* rule 2: pinned: access-log, audit, sessions and users build their own filter row under app/(staff)/admin on the pinned page-kit (rs-c2.static pins features/admin); only shared kit fixes apply
- /admin/* rule 1: pinned: heading comes from features/admin/server/page-kit Frame (rs-c2.static pins features/admin); only shared kit fixes apply
- /frontdesk/registrations/new rule 3: registration entry form: frontdesk.css bold totals and registration number (template 6)
- /frontdesk/registrations/new rule 5: registration entry form: the test line grid is an entry grid, not a list (template 6)
- /frontdesk/orders/[order_id] rule 3: registration entry form: shares frontdesk.css with the registration entry form
- /anatomic/cases/[case_id]/labels rule 3: label sheet: print layout of a physical label (label-sheet.css) needs a bold first line
- /[...slug] rule 1: catch-all placeholder for module routes without a page; not a screen (CR T0D-14)

## T0D-UIGUARD-1-BILLING (8 entries, 8 routes)

- /billing/accounts/entries rule 2: legacy baseline LD-434, fix in T0D-UIGUARD-1-BILLING: rule 2 broken in AccountEntriesScreen.tsx, AccountLedgerScreen.tsx, PocketLedgerScreen.tsx, CashTransfersScreen.tsx, DailyCashView.tsx, DailyCollectionScreen.tsx, PartysetCommon.tsx, DiscountSlabsScreen.tsx, ExpensesScreen.tsx
- /billing/accounts/ledger rule 2: legacy baseline LD-434, fix in T0D-UIGUARD-1-BILLING: rule 2 broken in AccountEntriesScreen.tsx, AccountLedgerScreen.tsx, PocketLedgerScreen.tsx, CashTransfersScreen.tsx, DailyCashView.tsx, DailyCollectionScreen.tsx, PartysetCommon.tsx, DiscountSlabsScreen.tsx, ExpensesScreen.tsx
- /billing/accounts/pocket rule 2: legacy baseline LD-434, fix in T0D-UIGUARD-1-BILLING: rule 2 broken in AccountEntriesScreen.tsx, AccountLedgerScreen.tsx, PocketLedgerScreen.tsx, CashTransfersScreen.tsx, DailyCashView.tsx, DailyCollectionScreen.tsx, PartysetCommon.tsx, DiscountSlabsScreen.tsx, ExpensesScreen.tsx
- /billing/cash-transfers rule 2: legacy baseline LD-434, fix in T0D-UIGUARD-1-BILLING: rule 2 broken in AccountEntriesScreen.tsx, AccountLedgerScreen.tsx, PocketLedgerScreen.tsx, CashTransfersScreen.tsx, DailyCashView.tsx, DailyCollectionScreen.tsx, PartysetCommon.tsx, DiscountSlabsScreen.tsx, ExpensesScreen.tsx
- /billing/daily-cash rule 2: legacy baseline LD-434, fix in T0D-UIGUARD-1-BILLING: rule 2 broken in AccountEntriesScreen.tsx, AccountLedgerScreen.tsx, PocketLedgerScreen.tsx, CashTransfersScreen.tsx, DailyCashView.tsx, DailyCollectionScreen.tsx, PartysetCommon.tsx, DiscountSlabsScreen.tsx, ExpensesScreen.tsx
- /billing/discounts/slabs rule 2: legacy baseline LD-434, fix in T0D-UIGUARD-1-BILLING: rule 2 broken in AccountEntriesScreen.tsx, AccountLedgerScreen.tsx, PocketLedgerScreen.tsx, CashTransfersScreen.tsx, DailyCashView.tsx, DailyCollectionScreen.tsx, PartysetCommon.tsx, DiscountSlabsScreen.tsx, ExpensesScreen.tsx
- /billing/expenses rule 2: legacy baseline LD-434, fix in T0D-UIGUARD-1-BILLING: rule 2 broken in AccountEntriesScreen.tsx, AccountLedgerScreen.tsx, PocketLedgerScreen.tsx, CashTransfersScreen.tsx, DailyCashView.tsx, DailyCollectionScreen.tsx, PartysetCommon.tsx, DiscountSlabsScreen.tsx, ExpensesScreen.tsx
- /billing/invoices/[invoice_id] rule 5: legacy baseline LD-434, fix in T0D-UIGUARD-1-BILLING: rule 5 broken in InvoiceDetailView.tsx

## T0D-UIGUARD-1-CATALOG (44 entries, 22 routes)

- /catalog/credit-parties/[credit_party_id] rule 1: legacy baseline LD-434, fix in T0D-UIGUARD-1-CATALOG: rule 1 broken in the page itself
- /catalog/tests/[test_id] rule 1: legacy baseline LD-434, fix in T0D-UIGUARD-1-CATALOG: rule 1 broken in the page itself
- /catalog/comment-codes rule 2: legacy baseline LD-434, fix in T0D-UIGUARD-1-CATALOG: rule 2 broken in CommentCodesScreen.tsx, master-ui.tsx, DoctorsList.tsx, ImportsScreen.tsx, TestImportScreen.tsx, PriceListDetail.tsx, PriceVersionEditor.tsx, PriceCompare.tsx, TestMgmtViews.tsx, TestsList.tsx
- /catalog/credit-parties rule 2: legacy baseline LD-434, fix in T0D-UIGUARD-1-CATALOG: rule 2 broken in CommentCodesScreen.tsx, master-ui.tsx, DoctorsList.tsx, ImportsScreen.tsx, TestImportScreen.tsx, PriceListDetail.tsx, PriceVersionEditor.tsx, PriceCompare.tsx, TestMgmtViews.tsx, TestsList.tsx
- /catalog/departments rule 2: legacy baseline LD-434, fix in T0D-UIGUARD-1-CATALOG: rule 2 broken in CommentCodesScreen.tsx, master-ui.tsx, DoctorsList.tsx, ImportsScreen.tsx, TestImportScreen.tsx, PriceListDetail.tsx, PriceVersionEditor.tsx, PriceCompare.tsx, TestMgmtViews.tsx, TestsList.tsx
- /catalog/doctors rule 2: legacy baseline LD-434, fix in T0D-UIGUARD-1-CATALOG: rule 2 broken in CommentCodesScreen.tsx, master-ui.tsx, DoctorsList.tsx, ImportsScreen.tsx, TestImportScreen.tsx, PriceListDetail.tsx, PriceVersionEditor.tsx, PriceCompare.tsx, TestMgmtViews.tsx, TestsList.tsx
- /catalog/doctors/[doctor_id] rule 2: legacy baseline LD-434, fix in T0D-UIGUARD-1-CATALOG: rule 2 broken in CommentCodesScreen.tsx, master-ui.tsx, DoctorsList.tsx, ImportsScreen.tsx, TestImportScreen.tsx, PriceListDetail.tsx, PriceVersionEditor.tsx, PriceCompare.tsx, TestMgmtViews.tsx, TestsList.tsx
- /catalog/doctors/verify rule 2: legacy baseline LD-434, fix in T0D-UIGUARD-1-CATALOG: rule 2 broken in CommentCodesScreen.tsx, master-ui.tsx, DoctorsList.tsx, ImportsScreen.tsx, TestImportScreen.tsx, PriceListDetail.tsx, PriceVersionEditor.tsx, PriceCompare.tsx, TestMgmtViews.tsx, TestsList.tsx
- /catalog/imports rule 2: legacy baseline LD-434, fix in T0D-UIGUARD-1-CATALOG: rule 2 broken in CommentCodesScreen.tsx, master-ui.tsx, DoctorsList.tsx, ImportsScreen.tsx, TestImportScreen.tsx, PriceListDetail.tsx, PriceVersionEditor.tsx, PriceCompare.tsx, TestMgmtViews.tsx, TestsList.tsx
- /catalog/imports/[import_id] rule 2: legacy baseline LD-434, fix in T0D-UIGUARD-1-CATALOG: rule 2 broken in CommentCodesScreen.tsx, master-ui.tsx, DoctorsList.tsx, ImportsScreen.tsx, TestImportScreen.tsx, PriceListDetail.tsx, PriceVersionEditor.tsx, PriceCompare.tsx, TestMgmtViews.tsx, TestsList.tsx
- /catalog/methods rule 2: legacy baseline LD-434, fix in T0D-UIGUARD-1-CATALOG: rule 2 broken in CommentCodesScreen.tsx, master-ui.tsx, DoctorsList.tsx, ImportsScreen.tsx, TestImportScreen.tsx, PriceListDetail.tsx, PriceVersionEditor.tsx, PriceCompare.tsx, TestMgmtViews.tsx, TestsList.tsx
- /catalog/panels rule 2: legacy baseline LD-434, fix in T0D-UIGUARD-1-CATALOG: rule 2 broken in CommentCodesScreen.tsx, master-ui.tsx, DoctorsList.tsx, ImportsScreen.tsx, TestImportScreen.tsx, PriceListDetail.tsx, PriceVersionEditor.tsx, PriceCompare.tsx, TestMgmtViews.tsx, TestsList.tsx
- /catalog/panels/[panel_id] rule 2: legacy baseline LD-434, fix in T0D-UIGUARD-1-CATALOG: rule 2 broken in CommentCodesScreen.tsx, master-ui.tsx, DoctorsList.tsx, ImportsScreen.tsx, TestImportScreen.tsx, PriceListDetail.tsx, PriceVersionEditor.tsx, PriceCompare.tsx, TestMgmtViews.tsx, TestsList.tsx
- /catalog/price-lists rule 2: legacy baseline LD-434, fix in T0D-UIGUARD-1-CATALOG: rule 2 broken in CommentCodesScreen.tsx, master-ui.tsx, DoctorsList.tsx, ImportsScreen.tsx, TestImportScreen.tsx, PriceListDetail.tsx, PriceVersionEditor.tsx, PriceCompare.tsx, TestMgmtViews.tsx, TestsList.tsx
- /catalog/price-lists/[price_list_id] rule 2: legacy baseline LD-434, fix in T0D-UIGUARD-1-CATALOG: rule 2 broken in CommentCodesScreen.tsx, master-ui.tsx, DoctorsList.tsx, ImportsScreen.tsx, TestImportScreen.tsx, PriceListDetail.tsx, PriceVersionEditor.tsx, PriceCompare.tsx, TestMgmtViews.tsx, TestsList.tsx
- /catalog/price-lists/[price_list_id]/versions/[version_id] rule 2: legacy baseline LD-434, fix in T0D-UIGUARD-1-CATALOG: rule 2 broken in CommentCodesScreen.tsx, master-ui.tsx, DoctorsList.tsx, ImportsScreen.tsx, TestImportScreen.tsx, PriceListDetail.tsx, PriceVersionEditor.tsx, PriceCompare.tsx, TestMgmtViews.tsx, TestsList.tsx
- /catalog/price-simulator rule 2: legacy baseline LD-434, fix in T0D-UIGUARD-1-CATALOG: rule 2 broken in CommentCodesScreen.tsx, master-ui.tsx, DoctorsList.tsx, ImportsScreen.tsx, TestImportScreen.tsx, PriceListDetail.tsx, PriceVersionEditor.tsx, PriceCompare.tsx, TestMgmtViews.tsx, TestsList.tsx
- /catalog/specimens rule 2: legacy baseline LD-434, fix in T0D-UIGUARD-1-CATALOG: rule 2 broken in CommentCodesScreen.tsx, master-ui.tsx, DoctorsList.tsx, ImportsScreen.tsx, TestImportScreen.tsx, PriceListDetail.tsx, PriceVersionEditor.tsx, PriceCompare.tsx, TestMgmtViews.tsx, TestsList.tsx
- /catalog/surcharges rule 2: legacy baseline LD-434, fix in T0D-UIGUARD-1-CATALOG: rule 2 broken in CommentCodesScreen.tsx, master-ui.tsx, DoctorsList.tsx, ImportsScreen.tsx, TestImportScreen.tsx, PriceListDetail.tsx, PriceVersionEditor.tsx, PriceCompare.tsx, TestMgmtViews.tsx, TestsList.tsx
- /catalog/tax rule 2: legacy baseline LD-434, fix in T0D-UIGUARD-1-CATALOG: rule 2 broken in CommentCodesScreen.tsx, master-ui.tsx, DoctorsList.tsx, ImportsScreen.tsx, TestImportScreen.tsx, PriceListDetail.tsx, PriceVersionEditor.tsx, PriceCompare.tsx, TestMgmtViews.tsx, TestsList.tsx
- /catalog/tests rule 2: legacy baseline LD-434, fix in T0D-UIGUARD-1-CATALOG: rule 2 broken in CommentCodesScreen.tsx, master-ui.tsx, DoctorsList.tsx, ImportsScreen.tsx, TestImportScreen.tsx, PriceListDetail.tsx, PriceVersionEditor.tsx, PriceCompare.tsx, TestMgmtViews.tsx, TestsList.tsx
- /catalog/units rule 2: legacy baseline LD-434, fix in T0D-UIGUARD-1-CATALOG: rule 2 broken in CommentCodesScreen.tsx, master-ui.tsx, DoctorsList.tsx, ImportsScreen.tsx, TestImportScreen.tsx, PriceListDetail.tsx, PriceVersionEditor.tsx, PriceCompare.tsx, TestMgmtViews.tsx, TestsList.tsx
- /catalog/comment-codes rule 3: legacy baseline LD-434, fix in T0D-UIGUARD-1-CATALOG: rule 3 broken in catalog.css
- /catalog/credit-parties rule 3: legacy baseline LD-434, fix in T0D-UIGUARD-1-CATALOG: rule 3 broken in catalog.css
- /catalog/departments rule 3: legacy baseline LD-434, fix in T0D-UIGUARD-1-CATALOG: rule 3 broken in catalog.css
- /catalog/doctors rule 3: legacy baseline LD-434, fix in T0D-UIGUARD-1-CATALOG: rule 3 broken in catalog.css
- /catalog/doctors/[doctor_id] rule 3: legacy baseline LD-434, fix in T0D-UIGUARD-1-CATALOG: rule 3 broken in catalog.css
- /catalog/doctors/verify rule 3: legacy baseline LD-434, fix in T0D-UIGUARD-1-CATALOG: rule 3 broken in catalog.css
- /catalog/imports rule 3: legacy baseline LD-434, fix in T0D-UIGUARD-1-CATALOG: rule 3 broken in catalog.css
- /catalog/imports/[import_id] rule 3: legacy baseline LD-434, fix in T0D-UIGUARD-1-CATALOG: rule 3 broken in catalog.css
- /catalog/methods rule 3: legacy baseline LD-434, fix in T0D-UIGUARD-1-CATALOG: rule 3 broken in catalog.css
- /catalog/panels rule 3: legacy baseline LD-434, fix in T0D-UIGUARD-1-CATALOG: rule 3 broken in catalog.css
- /catalog/panels/[panel_id] rule 3: legacy baseline LD-434, fix in T0D-UIGUARD-1-CATALOG: rule 3 broken in catalog.css
- /catalog/price-lists rule 3: legacy baseline LD-434, fix in T0D-UIGUARD-1-CATALOG: rule 3 broken in catalog.css
- /catalog/price-lists/[price_list_id] rule 3: legacy baseline LD-434, fix in T0D-UIGUARD-1-CATALOG: rule 3 broken in catalog.css
- /catalog/price-lists/[price_list_id]/versions/[version_id] rule 3: legacy baseline LD-434, fix in T0D-UIGUARD-1-CATALOG: rule 3 broken in catalog.css
- /catalog/price-simulator rule 3: legacy baseline LD-434, fix in T0D-UIGUARD-1-CATALOG: rule 3 broken in catalog.css
- /catalog/specimens rule 3: legacy baseline LD-434, fix in T0D-UIGUARD-1-CATALOG: rule 3 broken in catalog.css
- /catalog/surcharges rule 3: legacy baseline LD-434, fix in T0D-UIGUARD-1-CATALOG: rule 3 broken in catalog.css
- /catalog/tax rule 3: legacy baseline LD-434, fix in T0D-UIGUARD-1-CATALOG: rule 3 broken in catalog.css
- /catalog/tests rule 3: legacy baseline LD-434, fix in T0D-UIGUARD-1-CATALOG: rule 3 broken in catalog.css
- /catalog/tests/[test_id] rule 3: legacy baseline LD-434, fix in T0D-UIGUARD-1-CATALOG: rule 3 broken in catalog.css
- /catalog/units rule 3: legacy baseline LD-434, fix in T0D-UIGUARD-1-CATALOG: rule 3 broken in catalog.css
- /catalog/tests/[test_id] rule 5: legacy baseline LD-434, fix in T0D-UIGUARD-1-CATALOG: rule 5 broken in AnalytesTab.tsx

## T0D-UIGUARD-1-ENGAGEMENT (7 entries, 4 routes)

- /engagement/enquiries rule 2: legacy baseline LD-434, fix in T0D-UIGUARD-1-ENGAGEMENT: rule 2 broken in EnquiriesView.tsx, RemindersView.tsx
- /engagement/enquiries/[enquiry_id] rule 2: legacy baseline LD-434, fix in T0D-UIGUARD-1-ENGAGEMENT: rule 2 broken in EnquiriesView.tsx, RemindersView.tsx
- /engagement/reminders rule 2: legacy baseline LD-434, fix in T0D-UIGUARD-1-ENGAGEMENT: rule 2 broken in EnquiriesView.tsx, RemindersView.tsx
- /engagement/enquiries rule 4: legacy baseline LD-434, fix in T0D-UIGUARD-1-ENGAGEMENT: rule 4 broken in the page itself
- /engagement/enquiries/[enquiry_id] rule 4: legacy baseline LD-434, fix in T0D-UIGUARD-1-ENGAGEMENT: rule 4 broken in the page itself
- /engagement/memberships rule 4: legacy baseline LD-434, fix in T0D-UIGUARD-1-ENGAGEMENT: rule 4 broken in the page itself
- /engagement/reminders rule 4: legacy baseline LD-434, fix in T0D-UIGUARD-1-ENGAGEMENT: rule 4 broken in the page itself

## T0D-UIGUARD-1-FRONTDESK (4 entries, 2 routes)

- /frontdesk/orders/[order_id] rule 4: legacy baseline LD-434, fix in T0D-UIGUARD-1-FRONTDESK: rule 4 broken in the page itself
- /frontdesk/patients/[patient_id] rule 4: legacy baseline LD-434, fix in T0D-UIGUARD-1-FRONTDESK: rule 4 broken in the page itself
- /frontdesk/orders/[order_id] rule 5: legacy baseline LD-434, fix in T0D-UIGUARD-1-FRONTDESK: rule 5 broken in OrderView.tsx, PatientView.tsx
- /frontdesk/patients/[patient_id] rule 5: legacy baseline LD-434, fix in T0D-UIGUARD-1-FRONTDESK: rule 5 broken in OrderView.tsx, PatientView.tsx

## T0D-UIGUARD-1-HOMECOLLECTION (2 entries, 1 routes)

- /homecollection/dispatch rule 2: legacy baseline LD-434, fix in T0D-UIGUARD-1-HOMECOLLECTION: rule 2 broken in DispatchBoard.tsx
- /homecollection/dispatch rule 5: legacy baseline LD-434, fix in T0D-UIGUARD-1-HOMECOLLECTION: rule 5 broken in DispatchBoard.tsx

## T0D-UIGUARD-1-INSTRUMENTS (1 entries, 1 routes)

- /instruments/messages/[instrument_message_id] rule 5: legacy baseline LD-434, fix in T0D-UIGUARD-1-INSTRUMENTS: rule 5 broken in ReprocessDialog.tsx

## T0D-UIGUARD-1-INVENTORY (4 entries, 3 routes)

- /inventory/reports rule 2: legacy baseline LD-434, fix in T0D-UIGUARD-1-INVENTORY: rule 2 broken in RulesView.tsx
- /inventory/rules rule 2: legacy baseline LD-434, fix in T0D-UIGUARD-1-INVENTORY: rule 2 broken in RulesView.tsx
- /inventory/unresolved rule 2: legacy baseline LD-434, fix in T0D-UIGUARD-1-INVENTORY: rule 2 broken in RulesView.tsx
- /inventory/reports rule 6: legacy baseline LD-434, fix in T0D-UIGUARD-1-INVENTORY: rule 6 broken in ReportBody.tsx

## T0D-UIGUARD-1-LAB (10 entries, 9 routes)

- /lab/orders/[order_id]/labels rule 1: legacy baseline LD-434, fix in T0D-UIGUARD-1-LAB: rule 1 broken in the page itself
- /lab/worksheets/[worksheet_id] rule 1: legacy baseline LD-434, fix in T0D-UIGUARD-1-LAB: rule 1 broken in the page itself
- /lab/approval rule 2: legacy baseline LD-434, fix in T0D-UIGUARD-1-LAB: rule 2 broken in QueueScreen.tsx, PendingPage.tsx, StatusBoard.tsx, WorklistPage.tsx
- /lab/pending rule 2: legacy baseline LD-434, fix in T0D-UIGUARD-1-LAB: rule 2 broken in QueueScreen.tsx, PendingPage.tsx, StatusBoard.tsx, WorklistPage.tsx
- /lab/status-board rule 2: legacy baseline LD-434, fix in T0D-UIGUARD-1-LAB: rule 2 broken in QueueScreen.tsx, PendingPage.tsx, StatusBoard.tsx, WorklistPage.tsx
- /lab/verification rule 2: legacy baseline LD-434, fix in T0D-UIGUARD-1-LAB: rule 2 broken in QueueScreen.tsx, PendingPage.tsx, StatusBoard.tsx, WorklistPage.tsx
- /lab/worklists/[department_id] rule 2: legacy baseline LD-434, fix in T0D-UIGUARD-1-LAB: rule 2 broken in QueueScreen.tsx, PendingPage.tsx, StatusBoard.tsx, WorklistPage.tsx
- /lab/orders/[order_id]/results rule 5: legacy baseline LD-434, fix in T0D-UIGUARD-1-LAB: rule 5 broken in ResultPanels.tsx, DeltaRulesTab.tsx, QcHoldsTab.tsx
- /lab/settings rule 5: legacy baseline LD-434, fix in T0D-UIGUARD-1-LAB: rule 5 broken in ResultPanels.tsx, DeltaRulesTab.tsx, QcHoldsTab.tsx
- /lab/orders/[order_id]/results rule 6: legacy baseline LD-434, fix in T0D-UIGUARD-1-LAB: rule 6 broken in ResultPanels.tsx

## T0D-UIGUARD-1-OFFLINE (2 entries, 1 routes)

- /offline rule 1: legacy baseline LD-434, fix in T0D-UIGUARD-1-OFFLINE: rule 1 broken in the page itself
- /offline rule 4: legacy baseline LD-434, fix in T0D-UIGUARD-1-OFFLINE: rule 4 broken in the page itself

## T0D-UIGUARD-1-PARTNERS (18 entries, 18 routes)

- /billing/audit-trail rule 2: legacy baseline LD-434, fix in T0D-UIGUARD-1-PARTNERS: rule 2 broken in PartysetCommon.tsx, ManifestInbox.tsx, PenaltyEvents.tsx
- /billing/cbms rule 2: legacy baseline LD-434, fix in T0D-UIGUARD-1-PARTNERS: rule 2 broken in PartysetCommon.tsx, ManifestInbox.tsx, PenaltyEvents.tsx
- /billing/credit-parties rule 2: legacy baseline LD-434, fix in T0D-UIGUARD-1-PARTNERS: rule 2 broken in PartysetCommon.tsx, ManifestInbox.tsx, PenaltyEvents.tsx
- /billing/credit-parties/[credit_party_id] rule 2: legacy baseline LD-434, fix in T0D-UIGUARD-1-PARTNERS: rule 2 broken in PartysetCommon.tsx, ManifestInbox.tsx, PenaltyEvents.tsx
- /billing/dues rule 2: legacy baseline LD-434, fix in T0D-UIGUARD-1-PARTNERS: rule 2 broken in PartysetCommon.tsx, ManifestInbox.tsx, PenaltyEvents.tsx
- /billing/invoices rule 2: legacy baseline LD-434, fix in T0D-UIGUARD-1-PARTNERS: rule 2 broken in PartysetCommon.tsx, ManifestInbox.tsx, PenaltyEvents.tsx
- /billing/invoices/[invoice_id] rule 2: legacy baseline LD-434, fix in T0D-UIGUARD-1-PARTNERS: rule 2 broken in PartysetCommon.tsx, ManifestInbox.tsx, PenaltyEvents.tsx
- /billing/registers rule 2: legacy baseline LD-434, fix in T0D-UIGUARD-1-PARTNERS: rule 2 broken in PartysetCommon.tsx, ManifestInbox.tsx, PenaltyEvents.tsx
- /billing/settings rule 2: legacy baseline LD-434, fix in T0D-UIGUARD-1-PARTNERS: rule 2 broken in PartysetCommon.tsx, ManifestInbox.tsx, PenaltyEvents.tsx
- /billing/worklist rule 2: legacy baseline LD-434, fix in T0D-UIGUARD-1-PARTNERS: rule 2 broken in PartysetCommon.tsx, ManifestInbox.tsx, PenaltyEvents.tsx
- /catalog/icd rule 2: legacy baseline LD-434, fix in T0D-UIGUARD-1-PARTNERS: rule 2 broken in PartysetCommon.tsx, ManifestInbox.tsx, PenaltyEvents.tsx
- /partners/[partner_id] rule 2: legacy baseline LD-434, fix in T0D-UIGUARD-1-PARTNERS: rule 2 broken in PartysetCommon.tsx, ManifestInbox.tsx, PenaltyEvents.tsx
- /partners/manifests rule 2: legacy baseline LD-434, fix in T0D-UIGUARD-1-PARTNERS: rule 2 broken in PartysetCommon.tsx, ManifestInbox.tsx, PenaltyEvents.tsx
- /partners/onboarding rule 2: legacy baseline LD-434, fix in T0D-UIGUARD-1-PARTNERS: rule 2 broken in PartysetCommon.tsx, ManifestInbox.tsx, PenaltyEvents.tsx
- /partners/penalties rule 2: legacy baseline LD-434, fix in T0D-UIGUARD-1-PARTNERS: rule 2 broken in PartysetCommon.tsx, ManifestInbox.tsx, PenaltyEvents.tsx
- /partners/penalty-events rule 2: legacy baseline LD-434, fix in T0D-UIGUARD-1-PARTNERS: rule 2 broken in PartysetCommon.tsx, ManifestInbox.tsx, PenaltyEvents.tsx
- /partners/tickets rule 2: legacy baseline LD-434, fix in T0D-UIGUARD-1-PARTNERS: rule 2 broken in TicketInbox.tsx (breach came from T0D-MSGDESK-1 after UIGUARD-1)
- /partners/tickets/[ticket_id] rule 2: legacy baseline LD-434, fix in T0D-UIGUARD-1-PARTNERS: rule 2 broken in TicketInbox.tsx (breach came from T0D-MSGDESK-1 after UIGUARD-1)

## T0D-UIGUARD-1-QUALITY (7 entries, 7 routes)

- /quality rule 2: legacy baseline LD-434, fix in T0D-UIGUARD-1-QUALITY: rule 2 broken in DecisionsView.tsx, LjView.tsx
- /quality/autoverify/decisions rule 2: legacy baseline LD-434, fix in T0D-UIGUARD-1-QUALITY: rule 2 broken in DecisionsView.tsx, LjView.tsx
- /quality/lj rule 2: legacy baseline LD-434, fix in T0D-UIGUARD-1-QUALITY: rule 2 broken in DecisionsView.tsx, LjView.tsx
- /quality/observations rule 2: legacy baseline LD-434, fix in T0D-UIGUARD-1-QUALITY: rule 2 broken in DecisionsView.tsx, LjView.tsx
- /quality/qc-runs/[qc_run_id] rule 2: legacy baseline LD-434, fix in T0D-UIGUARD-1-QUALITY: rule 2 broken in DecisionsView.tsx, LjView.tsx
- /quality/runs rule 2: legacy baseline LD-434, fix in T0D-UIGUARD-1-QUALITY: rule 2 broken in DecisionsView.tsx, LjView.tsx
- /quality/autoverify/[version_id] rule 6: legacy baseline LD-434, fix in T0D-UIGUARD-1-QUALITY: rule 6 broken in ReportView.tsx

# Rule 7 (T0D-UIGUARD-2, LD-436 R7, LD-439 c): no raw h1 to h4, no raw ul or ol for page structure. One entry per route; heading = follow-up area task.

## STANDING (catch-all)

- /[...slug] rule 7: catch-all placeholder for module routes without a page; not a screen (CR T0D-14): raw h1 in page.tsx

## T0D-UIGUARD-1-ADMIN (rule 7: 18 entries)

- /admin/access-log rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-ADMIN: rule 7 broken in page-kit.tsx, ui.tsx
- /admin/access-review rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-ADMIN: rule 7 broken in page-kit.tsx
- /admin/audit rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-ADMIN: rule 7 broken in page-kit.tsx, ui.tsx
- /admin/audit/[audit_id] rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-ADMIN: rule 7 broken in page-kit.tsx
- /admin/branches rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-ADMIN: rule 7 broken in page-kit.tsx, OrgUnits.tsx, ui.tsx
- /admin/centres rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-ADMIN: rule 7 broken in page-kit.tsx, OrgUnits.tsx, ui.tsx
- /admin/exports rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-ADMIN: rule 7 broken in page-kit.tsx, ExportsScreen.tsx, ui.tsx
- /admin/me rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-ADMIN: rule 7 broken in page-kit.tsx, MyAccount.tsx, ui.tsx
- /admin/roles rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-ADMIN: rule 7 broken in page-kit.tsx
- /admin/roles/[role_id] rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-ADMIN: rule 7 broken in page-kit.tsx, RoleEditor.tsx, ui.tsx
- /admin/roles/new rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-ADMIN: rule 7 broken in page-kit.tsx, RoleEditor.tsx, ui.tsx
- /admin/roles/packs rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-ADMIN: rule 7 broken in page-kit.tsx
- /admin/sessions rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-ADMIN: rule 7 broken in page-kit.tsx, ui.tsx
- /admin/settings rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-ADMIN: rule 7 broken in page-kit.tsx, SettingsScreen.tsx, ui.tsx
- /admin/support-access rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-ADMIN: rule 7 broken in page-kit.tsx, SupportAccess.tsx, ui.tsx
- /admin/users rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-ADMIN: rule 7 broken in page-kit.tsx, ui.tsx
- /admin/users/[membership_id] rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-ADMIN: rule 7 broken in page-kit.tsx, UserDetailView.tsx, ui.tsx
- /admin/users/new rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-ADMIN: rule 7 broken in page-kit.tsx, ui.tsx

## T0D-UIGUARD-1-BILLING (rule 7: 15 entries)

- /billing/accounts/entries rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-BILLING: rule 7 broken in AccountReceiptView.tsx, accountsShared.tsx
- /billing/accounts/ledger rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-BILLING: rule 7 broken in AccountLedgerScreen.tsx, accountsShared.tsx
- /billing/accounts/masters rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-BILLING: rule 7 broken in AccountMastersScreen.tsx, accountsShared.tsx
- /billing/accounts/pocket rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-BILLING: rule 7 broken in PocketLedgerScreen.tsx, accountsShared.tsx, AccountLedgerScreen.tsx
- /billing/accounts/summary rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-BILLING: rule 7 broken in accountsShared.tsx
- /billing/cash-transfers rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-BILLING: rule 7 broken in accountsShared.tsx
- /billing/daily-cash rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-BILLING: rule 7 broken in DailyCashView.tsx, accountsShared.tsx
- /billing/discounts/authorities rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-BILLING: rule 7 broken in accountsShared.tsx
- /billing/discounts/limits rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-BILLING: rule 7 broken in accountsShared.tsx
- /billing/discounts/reasons rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-BILLING: rule 7 broken in accountsShared.tsx
- /billing/discounts/slabs rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-BILLING: rule 7 broken in accountsShared.tsx
- /billing/expenses rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-BILLING: rule 7 broken in accountsShared.tsx
- /billing/expenses/types rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-BILLING: rule 7 broken in accountsShared.tsx
- /billing/invoices/[invoice_id] rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-BILLING: rule 7 broken in InvoiceDetailView.tsx, InvoiceDocument.tsx
- /billing/settings rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-BILLING: rule 7 broken in PrintStationery.tsx

## T0D-UIGUARD-1-CATALOG (rule 7: 22 entries)

- /catalog rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-CATALOG: rule 7 broken in CatalogHome.tsx
- /catalog/comment-codes rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-CATALOG: rule 7 broken in CatalogForbidden.tsx, master-ui.tsx
- /catalog/credit-parties rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-CATALOG: rule 7 broken in CatalogForbidden.tsx, master-ui.tsx
- /catalog/departments rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-CATALOG: rule 7 broken in CatalogForbidden.tsx, master-ui.tsx
- /catalog/doctors rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-CATALOG: rule 7 broken in CatalogForbidden.tsx, DoctorsList.tsx, master-ui.tsx, DoctorMergeDialog.tsx
- /catalog/doctors/[doctor_id] rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-CATALOG: rule 7 broken in CatalogForbidden.tsx, master-ui.tsx, DoctorMergeDialog.tsx
- /catalog/doctors/verify rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-CATALOG: rule 7 broken in CatalogForbidden.tsx, master-ui.tsx, DoctorMergeDialog.tsx
- /catalog/imports rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-CATALOG: rule 7 broken in CatalogForbidden.tsx, ImportsScreen.tsx, TestImportScreen.tsx, master-ui.tsx
- /catalog/imports/[import_id] rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-CATALOG: rule 7 broken in CatalogForbidden.tsx, ImportDetail.tsx, master-ui.tsx
- /catalog/methods rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-CATALOG: rule 7 broken in CatalogForbidden.tsx, master-ui.tsx
- /catalog/panels rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-CATALOG: rule 7 broken in CatalogForbidden.tsx, master-ui.tsx, PanelMembers.tsx
- /catalog/panels/[panel_id] rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-CATALOG: rule 7 broken in CatalogForbidden.tsx, PanelDetail.tsx, master-ui.tsx, PanelMembers.tsx, compact-ui.tsx
- /catalog/price-lists rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-CATALOG: rule 7 broken in CatalogForbidden.tsx, master-ui.tsx
- /catalog/price-lists/[price_list_id] rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-CATALOG: rule 7 broken in CatalogForbidden.tsx, PriceListDetail.tsx, master-ui.tsx, PriceListTools.tsx
- /catalog/price-lists/[price_list_id]/versions/[version_id] rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-CATALOG: rule 7 broken in CatalogForbidden.tsx, master-ui.tsx
- /catalog/price-simulator rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-CATALOG: rule 7 broken in PriceSimulator.tsx, CatalogForbidden.tsx, master-ui.tsx
- /catalog/specimens rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-CATALOG: rule 7 broken in CatalogForbidden.tsx, master-ui.tsx
- /catalog/surcharges rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-CATALOG: rule 7 broken in CatalogForbidden.tsx, master-ui.tsx
- /catalog/tax rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-CATALOG: rule 7 broken in CatalogForbidden.tsx, master-ui.tsx
- /catalog/tests rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-CATALOG: rule 7 broken in CatalogForbidden.tsx, TestDetailsView.tsx, compact-ui.tsx, master-ui.tsx
- /catalog/tests/[test_id] rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-CATALOG: rule 7 broken in ParameterForm.tsx, RangesTab.tsx, TestHeader.tsx, compact-ui.tsx
- /catalog/units rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-CATALOG: rule 7 broken in CatalogForbidden.tsx, master-ui.tsx

## T0D-UIGUARD-1-ENGAGEMENT (rule 7: 9 entries)

- /engagement/bookable-items rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-ENGAGEMENT: rule 7 broken in BookingDetail.tsx, BookingNew.tsx, SlotsAdmin.tsx
- /engagement/bookings rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-ENGAGEMENT: rule 7 broken in BookingDetail.tsx, BookingNew.tsx, SlotsAdmin.tsx
- /engagement/bookings/[booking_id] rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-ENGAGEMENT: rule 7 broken in BookingDetail.tsx, BookingNew.tsx, SlotsAdmin.tsx
- /engagement/bookings/new rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-ENGAGEMENT: rule 7 broken in BookingDetail.tsx, BookingNew.tsx, SlotsAdmin.tsx
- /engagement/content rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-ENGAGEMENT: rule 7 broken in ProfileImages.tsx
- /engagement/enquiries/[enquiry_id] rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-ENGAGEMENT: rule 7 broken in EnquiryThread.tsx
- /engagement/messages/broadcasts rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-ENGAGEMENT: rule 7 broken in Broadcasts.tsx
- /engagement/settings rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-ENGAGEMENT: rule 7 broken in SettingsView.tsx
- /engagement/slots rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-ENGAGEMENT: rule 7 broken in BookingDetail.tsx, BookingNew.tsx, SlotsAdmin.tsx

## T0D-UIGUARD-1-FRONTDESK (rule 7: 5 entries)

- /frontdesk/discount-approvals rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-FRONTDESK: rule 7 broken in DiscountApprovalsInbox.tsx
- /frontdesk/orders/[order_id] rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-FRONTDESK: rule 7 broken in OrderView.tsx
- /frontdesk/patients/[patient_id] rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-FRONTDESK: rule 7 broken in PatientView.tsx
- /frontdesk/registrations/new rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-FRONTDESK: rule 7 broken in RegistrationForm.tsx, ReceiptPrintView.tsx, accountsShared.tsx, InvoiceDocument.tsx
- /frontdesk/settings rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-FRONTDESK: rule 7 broken in SettingsView.tsx

## T0D-UIGUARD-1-INSTRUMENTS (rule 7: 4 entries)

- /instruments/instruments rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-INSTRUMENTS: rule 7 broken in InstrumentForm.tsx
- /instruments/instruments/[instrument_id] rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-INSTRUMENTS: rule 7 broken in InstrumentForm.tsx
- /instruments/instruments/[instrument_id]/mappings rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-INSTRUMENTS: rule 7 broken in InstrumentMappings.tsx
- /instruments/messages/[instrument_message_id] rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-INSTRUMENTS: rule 7 broken in MessageDetail.tsx

## T0D-UIGUARD-1-INVENTORY (rule 7: 5 entries)

- /inventory/bench rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-INVENTORY: rule 7 broken in BenchView.tsx
- /inventory/reports rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-INVENTORY: rule 7 broken in ReportBody.tsx
- /inventory/stock rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-INVENTORY: rule 7 broken in StockView.tsx, IssueDrawer.tsx
- /inventory/unresolved rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-INVENTORY: rule 7 broken in UnresolvedView.tsx, consoleParts.tsx
- /inventory/wastage rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-INVENTORY: rule 7 broken in IssueDrawer.tsx

## T0D-UIGUARD-1-LAB (rule 7: 9 entries)

- /lab/approval rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-LAB: rule 7 broken in QueueScreen.tsx, consoleParts.tsx, ResultDialogs.tsx
- /lab/critical-values rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-LAB: rule 7 broken in CriticalValueList.tsx, consoleParts.tsx
- /lab/ingest-exceptions rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-LAB: rule 7 broken in IngestExceptionList.tsx, consoleParts.tsx
- /lab/orders/[order_id]/labels rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-LAB: rule 7 broken in LabelPage.tsx
- /lab/orders/[order_id]/results rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-LAB: rule 7 broken in CommentCell.tsx, ResultDialogs.tsx, ResultPanels.tsx
- /lab/settings rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-LAB: rule 7 broken in VerificationPolicyTab.tsx
- /lab/specimens/[specimen_id] rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-LAB: rule 7 broken in SpecimenDetail.tsx
- /lab/verification rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-LAB: rule 7 broken in QueueScreen.tsx, consoleParts.tsx, ResultDialogs.tsx
- /lab/worksheets/[worksheet_id] rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-LAB: rule 7 broken in WorksheetPrintPage.tsx

## T0D-UIGUARD-1-MICRO (rule 7: 6 entries)

- /micro/breakpoint-sets rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-MICRO: rule 7 broken in MicroForbidden.tsx
- /micro/breakpoint-sets/[breakpoint_set_id] rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-MICRO: rule 7 broken in MicroForbidden.tsx
- /micro/cultures/[culture_id] rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-MICRO: rule 7 broken in MicroForbidden.tsx, ReportDrawer.tsx, ReadsTab.tsx, ChooseCultureDialog.tsx
- /micro/instrument-records rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-MICRO: rule 7 broken in MicroForbidden.tsx
- /micro/settings rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-MICRO: rule 7 broken in MicroForbidden.tsx, DictionariesTab.tsx, MappingsTab.tsx, PanelsTab.tsx, ProtocolsTab.tsx
- /micro/worklist rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-MICRO: rule 7 broken in MicroForbidden.tsx, ChooseCultureDialog.tsx

## T0D-UIGUARD-1-OFFLINE (rule 7: 1 entries)

- /offline rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-OFFLINE: rule 7 broken in OfflinePanel.tsx, OfflineShell.tsx

## T0D-UIGUARD-1-PARTNERS (rule 7: 2 entries)

- /partners/sales/representatives rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-PARTNERS: rule 7 broken in SalesRepresentatives.tsx
- /partners/tickets/[ticket_id] rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-PARTNERS: rule 7 broken in TicketThread.tsx

## T0D-UIGUARD-1-PAYMENTS (rule 7: 2 entries)

- /payments/refunds rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-PAYMENTS: rule 7 broken in RefundsList.tsx, consoleParts.tsx
- /payments/review rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-PAYMENTS: rule 7 broken in ReviewQueue.tsx, consoleParts.tsx

## T0D-UIGUARD-1-QUALITY (rule 7: 12 entries)

- /quality rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-QUALITY: rule 7 broken in LjView.tsx, RunDetailView.tsx
- /quality/autoverify/[version_id] rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-QUALITY: rule 7 broken in ReportView.tsx, RuleDrawer.tsx
- /quality/autoverify/decisions rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-QUALITY: rule 7 broken in DecisionsView.tsx
- /quality/lj rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-QUALITY: rule 7 broken in LjView.tsx, RunDetailView.tsx
- /quality/observations rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-QUALITY: rule 7 broken in LjView.tsx, RunDetailView.tsx
- /quality/qc-runs/[qc_run_id] rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-QUALITY: rule 7 broken in LjView.tsx, RunDetailView.tsx
- /quality/runs rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-QUALITY: rule 7 broken in LjView.tsx, RunDetailView.tsx
- /quality/settings rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-QUALITY: rule 7 broken in SettingsView.tsx
- /quality/setup/maps rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-QUALITY: rule 7 broken in MaterialsView.tsx, TargetsView.tsx
- /quality/setup/materials rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-QUALITY: rule 7 broken in MaterialsView.tsx, TargetsView.tsx
- /quality/setup/plans rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-QUALITY: rule 7 broken in MaterialsView.tsx, TargetsView.tsx
- /quality/setup/targets rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-QUALITY: rule 7 broken in MaterialsView.tsx, TargetsView.tsx

## T0D-UIGUARD-1-REPORTING (rule 7: 7 entries)

- /reporting rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-REPORTING: rule 7 broken in CriticalAlertsPanel.tsx, ReportsWorklist.tsx
- /reporting/deliveries/[delivery_id] rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-REPORTING: rule 7 broken in DeliveryDetail.tsx
- /reporting/messages rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-REPORTING: rule 7 broken in MessagesChannels.tsx
- /reporting/narratives/[narrative_id] rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-REPORTING: rule 7 broken in NarrativeEditor.tsx
- /reporting/reports/[report_id] rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-REPORTING: rule 7 broken in ReportDetailView.tsx
- /reporting/settings rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-REPORTING: rule 7 broken in PrintStationery.tsx, ReportingSettingsForm.tsx, SignatoryProfiles.tsx
- /reporting/templates/[template_id] rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-REPORTING: rule 7 broken in TemplateEditor.tsx
