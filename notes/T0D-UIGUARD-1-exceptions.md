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

## T0D-UIGUARD-1-ANALYTICS (5 entries, 5 routes)

- /analytics/collections rule 6: legacy baseline LD-434, fix in T0D-UIGUARD-1-ANALYTICS: rule 6 broken in ReportView.tsx
- /analytics/referral-incentive rule 6: legacy baseline LD-434, fix in T0D-UIGUARD-1-ANALYTICS: rule 6 broken in ReportView.tsx
- /analytics/report-runs/[report_run_id] rule 6: legacy baseline LD-434, fix in T0D-UIGUARD-1-ANALYTICS: rule 6 broken in ReportView.tsx
- /analytics/reports rule 6: legacy baseline LD-434, fix in T0D-UIGUARD-1-ANALYTICS: rule 6 broken in ReportView.tsx
- /analytics/reports/[reportCode] rule 6: legacy baseline LD-434, fix in T0D-UIGUARD-1-ANALYTICS: rule 6 broken in ReportView.tsx

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

## T0D-UIGUARD-1-PARTNERS (16 entries, 16 routes)

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

## T0D-UIGUARD-1-QUALITY (7 entries, 7 routes)

- /quality rule 2: legacy baseline LD-434, fix in T0D-UIGUARD-1-QUALITY: rule 2 broken in DecisionsView.tsx, LjView.tsx
- /quality/autoverify/decisions rule 2: legacy baseline LD-434, fix in T0D-UIGUARD-1-QUALITY: rule 2 broken in DecisionsView.tsx, LjView.tsx
- /quality/lj rule 2: legacy baseline LD-434, fix in T0D-UIGUARD-1-QUALITY: rule 2 broken in DecisionsView.tsx, LjView.tsx
- /quality/observations rule 2: legacy baseline LD-434, fix in T0D-UIGUARD-1-QUALITY: rule 2 broken in DecisionsView.tsx, LjView.tsx
- /quality/qc-runs/[qc_run_id] rule 2: legacy baseline LD-434, fix in T0D-UIGUARD-1-QUALITY: rule 2 broken in DecisionsView.tsx, LjView.tsx
- /quality/runs rule 2: legacy baseline LD-434, fix in T0D-UIGUARD-1-QUALITY: rule 2 broken in DecisionsView.tsx, LjView.tsx
- /quality/autoverify/[version_id] rule 6: legacy baseline LD-434, fix in T0D-UIGUARD-1-QUALITY: rule 6 broken in ReportView.tsx

## T0D-UIGUARD-1-SMARTREPORT (5 entries, 5 routes)

- /smartreport/library rule 5: legacy baseline LD-434, fix in T0D-UIGUARD-1-SMARTREPORT: rule 5 broken in WordingTerms.tsx, CheckTab.tsx, GroupsTab.tsx
- /smartreport/library/[library_version_id] rule 5: legacy baseline LD-434, fix in T0D-UIGUARD-1-SMARTREPORT: rule 5 broken in WordingTerms.tsx, CheckTab.tsx, GroupsTab.tsx
- /smartreport/library/[library_version_id]/review rule 5: legacy baseline LD-434, fix in T0D-UIGUARD-1-SMARTREPORT: rule 5 broken in WordingTerms.tsx, CheckTab.tsx, GroupsTab.tsx
- /smartreport/wording rule 5: legacy baseline LD-434, fix in T0D-UIGUARD-1-SMARTREPORT: rule 5 broken in WordingTerms.tsx, CheckTab.tsx, GroupsTab.tsx
- /smartreport/summaries/[summary_id] rule 6: legacy baseline LD-434, fix in T0D-UIGUARD-1-SMARTREPORT: rule 6 broken in SummaryReview.tsx
