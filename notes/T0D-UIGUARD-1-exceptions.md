# T0D-UIGUARD-1 exceptions

Mirror of apps/web/src/core/__tests__/uiguard1.exceptions.ts (tester-owned registry). One line per entry: route, rule N, reason.
STANDING = real obstacles (pinned rs-c2.static admin pages, registration entry form, label print sheet, catch-all placeholder).
Other groups = LD-434 legacy baseline (CR-C0-0D-UIGUARD-1 option A); the heading is the follow-up task id the lead queues. When the follow-up fixes a file its entries go stale and the guard fails until the tester deletes them.

## STANDING (7 entries, 5 routes)

- /frontdesk/registrations/new rule 3: registration entry form: frontdesk.css bold totals and registration number (template 6)
- /frontdesk/registrations/new rule 5: registration entry form: the test line grid is an entry grid, not a list (template 6)
- /frontdesk/orders/[order_id] rule 3: registration entry form: shares frontdesk.css with the registration entry form
- /anatomic/cases/[case_id]/labels rule 3: label sheet: print layout of a physical label (label-sheet.css) needs a bold first line
- /[...slug] rule 1: catch-all placeholder for module routes without a page; not a screen (CR T0D-14)

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

## T0D-UIGUARD-1-FRONTDESK (4 entries, 2 routes)

- /frontdesk/orders/[order_id] rule 4: legacy baseline LD-434, fix in T0D-UIGUARD-1-FRONTDESK: rule 4 broken in the page itself
- /frontdesk/patients/[patient_id] rule 4: legacy baseline LD-434, fix in T0D-UIGUARD-1-FRONTDESK: rule 4 broken in the page itself
- /frontdesk/orders/[order_id] rule 5: legacy baseline LD-434, fix in T0D-UIGUARD-1-FRONTDESK: rule 5 broken in OrderView.tsx, PatientView.tsx
- /frontdesk/patients/[patient_id] rule 5: legacy baseline LD-434, fix in T0D-UIGUARD-1-FRONTDESK: rule 5 broken in OrderView.tsx, PatientView.tsx

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

## T0D-UIGUARD-1-ANATOMIC (rule 7: 8 entries)

- /anatomic rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-ANATOMIC: rule 7 broken in AnatomicForbidden.tsx
- /anatomic/batches rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-ANATOMIC: rule 7 broken in AnatomicForbidden.tsx
- /anatomic/batches/[batch_id] rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-ANATOMIC: rule 7 broken in AnatomicForbidden.tsx, BatchDetailScreen.tsx
- /anatomic/cases/[case_id] rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-ANATOMIC: rule 7 broken in AnatomicForbidden.tsx, CaseWorkspace.tsx, ImagesTab.tsx, BlocksSlidesTab.tsx, ReportEditor.tsx, ...
- /anatomic/cases/[case_id]/labels rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-ANATOMIC: rule 7 broken in AnatomicForbidden.tsx
- /anatomic/config rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-ANATOMIC: rule 7 broken in config-shared.tsx, AssaysTab.tsx
- /anatomic/config/templates/[template_id] rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-ANATOMIC: rule 7 broken in config-shared.tsx, TemplateEditor.tsx, TemplatePreview.tsx
- /anatomic/tracking rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-ANATOMIC: rule 7 broken in AnatomicForbidden.tsx, TrackingScreen.tsx, MovementDialog.tsx

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

## T0D-UIGUARD-1-FRONTDESK (rule 7: 5 entries)

- /frontdesk/discount-approvals rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-FRONTDESK: rule 7 broken in DiscountApprovalsInbox.tsx
- /frontdesk/orders/[order_id] rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-FRONTDESK: rule 7 broken in OrderView.tsx
- /frontdesk/patients/[patient_id] rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-FRONTDESK: rule 7 broken in PatientView.tsx
- /frontdesk/registrations/new rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-FRONTDESK: rule 7 broken in RegistrationForm.tsx, ReceiptPrintView.tsx, accountsShared.tsx, InvoiceDocument.tsx
- /frontdesk/settings rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-FRONTDESK: rule 7 broken in SettingsView.tsx

## T0D-UIGUARD-1-MICRO (rule 7: 6 entries)

- /micro/breakpoint-sets rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-MICRO: rule 7 broken in MicroForbidden.tsx
- /micro/breakpoint-sets/[breakpoint_set_id] rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-MICRO: rule 7 broken in MicroForbidden.tsx
- /micro/cultures/[culture_id] rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-MICRO: rule 7 broken in MicroForbidden.tsx, ReportDrawer.tsx, ReadsTab.tsx, ChooseCultureDialog.tsx
- /micro/instrument-records rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-MICRO: rule 7 broken in MicroForbidden.tsx
- /micro/settings rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-MICRO: rule 7 broken in MicroForbidden.tsx, DictionariesTab.tsx, MappingsTab.tsx, PanelsTab.tsx, ProtocolsTab.tsx
- /micro/worklist rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-MICRO: rule 7 broken in MicroForbidden.tsx, ChooseCultureDialog.tsx

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
