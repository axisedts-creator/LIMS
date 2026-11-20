// T0D-UIGUARD-1 exceptions registry (tester-owned). A page that CANNOT follow a rule is listed here by route with the reason (LD-353).
// Every entry must also be written in notes/T0D-UIGUARD-1-exceptions.md as one line holding the route and "rule N" (checked by uiguard1.guard.test.ts).
// A feature may add its own entries in apps/web/src/features/<feature>/__tests__/uiguard1.exceptions.ts (export const EXCEPTIONS: GuardException[]).
// An entry whose page no longer breaks the rule is stale and fails the guard: delete it. Reasons must name a real obstacle (see the REAL list in the guard test).
import type { GuardException, Rule } from './uiguard1.helpers';

// LD-434 (CR-C0-0D-UIGUARD-1, option A): a dated legacy baseline. The file broke the rule before this guard existed; the follow-up task named in the reason fixes it.
// The reason must read 'legacy baseline LD-434, fix in T0D-UIGUARD-1-<FEATURE>' (checked by the REAL regex in uiguard1.guard.test.ts). One entry per route and rule.
// When the follow-up fixes the file the entry goes stale and the guard fails until the entry is deleted (stale-entry test): that is how the baseline shrinks.
const legacy = (feature: string, rule: Rule, files: string, routes: string[]): GuardException[] =>
  routes.map((route) => ({ route, rule, reason: `legacy baseline LD-434, fix in T0D-UIGUARD-1-${feature}: rule ${rule} broken in ${files}` }));

export const EXCEPTIONS: GuardException[] = [
  // Pinned by rs-c2.static: the admin screens draw their heading through features/admin/server/page-kit Frame (a bare h1), which may not be edited.
  { route: '/admin/*', rule: 2, reason: 'pinned: access-log, audit, sessions and users build their own filter row under app/(staff)/admin on the pinned page-kit (rs-c2.static pins features/admin); only shared kit fixes apply' },
  { route: '/admin/*', rule: 1, reason: 'pinned: heading comes from features/admin/server/page-kit Frame (rs-c2.static pins features/admin); only shared kit fixes apply' },
  // The registration entry form (template 6) keeps its bold totals and its line table that swaps for a hint; its CSS is shared with the order view.
  { route: '/frontdesk/registrations/new', rule: 3, reason: 'registration entry form: frontdesk.css bold totals and registration number (template 6)' },
  { route: '/frontdesk/registrations/new', rule: 5, reason: 'registration entry form: the test line grid is an entry grid, not a list (template 6)' },
  { route: '/frontdesk/orders/[order_id]', rule: 3, reason: 'registration entry form: shares frontdesk.css with the registration entry form' },
  // The printed label sheet is a physical sticker layout, not a screen.
  { route: '/anatomic/cases/[case_id]/labels', rule: 3, reason: 'label sheet: print layout of a physical label (label-sheet.css) needs a bold first line' },
  // The placeholder served for a menu entry whose module has not shipped a page; it is not a screen and no nav entry resolves to it (guarded above).
  { route: '/[...slug]', rule: 1, reason: 'catch-all placeholder for module routes without a page; not a screen (CR T0D-14)' },

  // LD-434 legacy baseline, grouped by rule then feature area. Follow-up task ids: T0D-UIGUARD-1-<AREA> (the lead queues one per area).
  ...legacy('CATALOG', 1, 'the page itself', [
    '/catalog/credit-parties/[credit_party_id]',
    '/catalog/tests/[test_id]',
  ]),
  ...legacy('LAB', 1, 'the page itself', [
    '/lab/orders/[order_id]/labels',
    '/lab/worksheets/[worksheet_id]',
  ]),
  ...legacy('OFFLINE', 1, 'the page itself', [
    '/offline',
  ]),
  ...legacy('BILLING', 2, 'AccountEntriesScreen.tsx, AccountLedgerScreen.tsx, PocketLedgerScreen.tsx, CashTransfersScreen.tsx, DailyCashView.tsx, DailyCollectionScreen.tsx, PartysetCommon.tsx, DiscountSlabsScreen.tsx, ExpensesScreen.tsx', [
    '/billing/accounts/entries',
    '/billing/accounts/ledger',
    '/billing/accounts/pocket',
    '/billing/cash-transfers',
    '/billing/daily-cash',
    '/billing/discounts/slabs',
    '/billing/expenses',
  ]),
  ...legacy('CATALOG', 2, 'CommentCodesScreen.tsx, master-ui.tsx, DoctorsList.tsx, ImportsScreen.tsx, TestImportScreen.tsx, PriceListDetail.tsx, PriceVersionEditor.tsx, PriceCompare.tsx, TestMgmtViews.tsx, TestsList.tsx', [
    '/catalog/comment-codes',
    '/catalog/credit-parties',
    '/catalog/departments',
    '/catalog/doctors',
    '/catalog/doctors/[doctor_id]',
    '/catalog/doctors/verify',
    '/catalog/imports',
    '/catalog/imports/[import_id]',
    '/catalog/methods',
    '/catalog/panels',
    '/catalog/panels/[panel_id]',
    '/catalog/price-lists',
    '/catalog/price-lists/[price_list_id]',
    '/catalog/price-lists/[price_list_id]/versions/[version_id]',
    '/catalog/price-simulator',
    '/catalog/specimens',
    '/catalog/surcharges',
    '/catalog/tax',
    '/catalog/tests',
    '/catalog/units',
  ]),
  ...legacy('ENGAGEMENT', 2, 'EnquiriesView.tsx, RemindersView.tsx', [
    '/engagement/enquiries',
    '/engagement/enquiries/[enquiry_id]',
    '/engagement/reminders',
  ]),
  ...legacy('HOMECOLLECTION', 2, 'DispatchBoard.tsx', [
    '/homecollection/dispatch',
  ]),
  ...legacy('INVENTORY', 2, 'RulesView.tsx', [
    '/inventory/reports',
    '/inventory/rules',
    '/inventory/unresolved',
  ]),
  ...legacy('LAB', 2, 'QueueScreen.tsx, PendingPage.tsx, StatusBoard.tsx, WorklistPage.tsx', [
    '/lab/approval',
    '/lab/pending',
    '/lab/status-board',
    '/lab/verification',
    '/lab/worklists/[department_id]',
  ]),
  ...legacy('PARTNERS', 2, 'PartysetCommon.tsx, ManifestInbox.tsx, PenaltyEvents.tsx', [
    '/billing/audit-trail',
    '/billing/cbms',
    '/billing/credit-parties',
    '/billing/credit-parties/[credit_party_id]',
    '/billing/dues',
    '/billing/invoices',
    '/billing/invoices/[invoice_id]',
    '/billing/registers',
    '/billing/settings',
    '/billing/worklist',
    '/catalog/icd',
    '/partners/[partner_id]',
    '/partners/manifests',
    '/partners/onboarding',
    '/partners/penalties',
    '/partners/penalty-events',
  ]),
  ...legacy('QUALITY', 2, 'DecisionsView.tsx, LjView.tsx', [
    '/quality',
    '/quality/autoverify/decisions',
    '/quality/lj',
    '/quality/observations',
    '/quality/qc-runs/[qc_run_id]',
    '/quality/runs',
  ]),
  ...legacy('CATALOG', 3, 'catalog.css', [
    '/catalog/comment-codes',
    '/catalog/credit-parties',
    '/catalog/departments',
    '/catalog/doctors',
    '/catalog/doctors/[doctor_id]',
    '/catalog/doctors/verify',
    '/catalog/imports',
    '/catalog/imports/[import_id]',
    '/catalog/methods',
    '/catalog/panels',
    '/catalog/panels/[panel_id]',
    '/catalog/price-lists',
    '/catalog/price-lists/[price_list_id]',
    '/catalog/price-lists/[price_list_id]/versions/[version_id]',
    '/catalog/price-simulator',
    '/catalog/specimens',
    '/catalog/surcharges',
    '/catalog/tax',
    '/catalog/tests',
    '/catalog/tests/[test_id]',
    '/catalog/units',
  ]),
  ...legacy('ENGAGEMENT', 4, 'the page itself', [
    '/engagement/enquiries',
    '/engagement/enquiries/[enquiry_id]',
    '/engagement/memberships',
    '/engagement/reminders',
  ]),
  ...legacy('FRONTDESK', 4, 'the page itself', [
    '/frontdesk/orders/[order_id]',
    '/frontdesk/patients/[patient_id]',
  ]),
  ...legacy('OFFLINE', 4, 'the page itself', [
    '/offline',
  ]),
  ...legacy('BILLING', 5, 'InvoiceDetailView.tsx', [
    '/billing/invoices/[invoice_id]',
  ]),
  ...legacy('CATALOG', 5, 'AnalytesTab.tsx', [
    '/catalog/tests/[test_id]',
  ]),
  ...legacy('FRONTDESK', 5, 'OrderView.tsx, PatientView.tsx', [
    '/frontdesk/orders/[order_id]',
    '/frontdesk/patients/[patient_id]',
  ]),
  ...legacy('HOMECOLLECTION', 5, 'DispatchBoard.tsx', [
    '/homecollection/dispatch',
  ]),
  ...legacy('INSTRUMENTS', 5, 'ReprocessDialog.tsx', [
    '/instruments/messages/[instrument_message_id]',
  ]),
  ...legacy('LAB', 5, 'ResultPanels.tsx, DeltaRulesTab.tsx, QcHoldsTab.tsx', [
    '/lab/orders/[order_id]/results',
    '/lab/settings',
  ]),
  ...legacy('SMARTREPORT', 5, 'WordingTerms.tsx, CheckTab.tsx, GroupsTab.tsx', [
    '/smartreport/library',
    '/smartreport/library/[library_version_id]',
    '/smartreport/library/[library_version_id]/review',
    '/smartreport/wording',
  ]),
  ...legacy('ANALYTICS', 6, 'ReportView.tsx', [
    '/analytics/collections',
    '/analytics/referral-incentive',
    '/analytics/report-runs/[report_run_id]',
    '/analytics/reports',
    '/analytics/reports/[reportCode]',
  ]),
  ...legacy('INVENTORY', 6, 'ReportBody.tsx', [
    '/inventory/reports',
  ]),
  ...legacy('LAB', 6, 'ResultPanels.tsx', [
    '/lab/orders/[order_id]/results',
  ]),
  ...legacy('QUALITY', 6, 'ReportView.tsx', [
    '/quality/autoverify/[version_id]',
  ]),
  ...legacy('SMARTREPORT', 6, 'SummaryReview.tsx', [
    '/smartreport/summaries/[summary_id]',
  ]),
];
