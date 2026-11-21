// T0D-UIGUARD-1 exceptions registry (tester-owned). A page that CANNOT follow a rule is listed here by route with the reason (LD-353).
// Every entry must also be written in notes/T0D-UIGUARD-1-exceptions.md as one line holding the route and "rule N" (checked by uiguard1.guard.test.ts).
// A feature may add its own entries in apps/web/src/features/<feature>/__tests__/uiguard1.exceptions.ts (export const EXCEPTIONS: GuardException[]).
// An entry whose page no longer breaks the rule is stale and fails the guard: delete it. Reasons must name a real obstacle (see the REAL list in the guard test).
import type { AREAS, GuardException, Rule } from './uiguard1.helpers';

// LD-434 (CR-C0-0D-UIGUARD-1, option A): a dated legacy baseline. The file broke the rule before this guard existed; the follow-up task named in the reason fixes it.
// The reason must read 'legacy baseline LD-434, fix in T0D-UIGUARD-1-<FEATURE>' (checked by the REAL regex in uiguard1.guard.test.ts). One entry per route and rule.
// When the follow-up fixes the file the entry goes stale and the guard fails until the entry is deleted (stale-entry test): that is how the baseline shrinks.
const legacy = (feature: string, rule: Rule, files: string, routes: string[]): GuardException[] =>
  routes.map((route) => ({ route, rule, reason: `legacy baseline LD-434, fix in T0D-UIGUARD-1-${feature}: rule ${rule} broken in ${files}` }));

// LD-436 / LD-439 (T0D-UIGUARD-2): the rule 7 baseline. Same method as LD-434; the reason must read 'legacy baseline LD-436, fix in T0D-UIGUARD-1-<AREA>' (AREA = one of the 18 of LD-439 c).
// Each row is [route, files]: the page or component files that hold the raw h1 to h4 / ul / ol. The entry goes stale when those files are fixed (stale-entry test), and the guard fails until it is deleted.
const legacy7 = (area: (typeof AREAS)[number], rows: Array<[route: string, files: string]>): GuardException[] =>
  rows.map(([route, files]) => ({ route, rule: 7 as Rule, reason: `legacy baseline LD-436, fix in T0D-UIGUARD-1-${area}: rule 7 broken in ${files}` }));

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
  // LD-441: TicketInbox.tsx hand builds its filter row (breach arrived with T0D-MSGDESK-1, after UIGUARD-1).
  ...legacy('PARTNERS', 2, 'TicketInbox.tsx', [
    '/partners/tickets',
    '/partners/tickets/[ticket_id]',
  ]),
  ...legacy('QUALITY', 2, 'DecisionsView.tsx, LjView.tsx', [
    '/quality',
    '/quality/autoverify/decisions',
    '/quality/lj',
    '/quality/observations',
    '/quality/qc-runs/[qc_run_id]',
    '/quality/runs',
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

  // T0D-UIGUARD-2 (LD-436 R7, LD-438, LD-439 c): rule 7 legacy baseline, one entry per route, reason 'legacy baseline LD-436, fix in T0D-UIGUARD-1-<AREA>'.
  // The area is the sidebar group of the route (LD-439 a); the area task rebuilds every screen of its area, so when it ends none of its entries may remain (LD-439 b).
  // Nothing under app/(auth), app/(platform), features/platform or features/admin/auth is walked, so no pinned rule 7 entry is needed (a finding there would fail the pinned test).
  { route: '/[...slug]', rule: 7, reason: 'catch-all placeholder for module routes without a page; not a screen (CR T0D-14): raw h1 in page.tsx' },
  ...legacy7('ADMIN', [
    ['/admin/access-log', 'page-kit.tsx, ui.tsx'],
    ['/admin/access-review', 'page-kit.tsx'],
    ['/admin/audit', 'page-kit.tsx, ui.tsx'],
    ['/admin/audit/[audit_id]', 'page-kit.tsx'],
    ['/admin/branches', 'page-kit.tsx, OrgUnits.tsx, ui.tsx'],
    ['/admin/centres', 'page-kit.tsx, OrgUnits.tsx, ui.tsx'],
    ['/admin/exports', 'page-kit.tsx, ExportsScreen.tsx, ui.tsx'],
    ['/admin/me', 'page-kit.tsx, MyAccount.tsx, ui.tsx'],
    ['/admin/roles', 'page-kit.tsx'],
    ['/admin/roles/[role_id]', 'page-kit.tsx, RoleEditor.tsx, ui.tsx'],
    ['/admin/roles/new', 'page-kit.tsx, RoleEditor.tsx, ui.tsx'],
    ['/admin/roles/packs', 'page-kit.tsx'],
    ['/admin/sessions', 'page-kit.tsx, ui.tsx'],
    ['/admin/settings', 'page-kit.tsx, SettingsScreen.tsx, ui.tsx'],
    ['/admin/support-access', 'page-kit.tsx, SupportAccess.tsx, ui.tsx'],
    ['/admin/users', 'page-kit.tsx, ui.tsx'],
    ['/admin/users/[membership_id]', 'page-kit.tsx, UserDetailView.tsx, ui.tsx'],
    ['/admin/users/new', 'page-kit.tsx, ui.tsx'],
  ]),
  ...legacy7('ANALYTICS', [
    ['/analytics/schedules', 'ScheduleEditor.tsx'],
    ['/analytics/schedules/[schedule_id]', 'ScheduleEditor.tsx'],
    ['/analytics/schedules/new', 'ScheduleEditor.tsx'],
  ]),
  ...legacy7('ANATOMIC', [
    ['/anatomic', 'AnatomicForbidden.tsx'],
    ['/anatomic/batches', 'AnatomicForbidden.tsx'],
    ['/anatomic/batches/[batch_id]', 'AnatomicForbidden.tsx, BatchDetailScreen.tsx'],
    ['/anatomic/cases/[case_id]', 'AnatomicForbidden.tsx, CaseWorkspace.tsx, ImagesTab.tsx, BlocksSlidesTab.tsx, ReportEditor.tsx, ...'],
    ['/anatomic/cases/[case_id]/labels', 'AnatomicForbidden.tsx'],
    ['/anatomic/config', 'config-shared.tsx, AssaysTab.tsx'],
    ['/anatomic/config/templates/[template_id]', 'config-shared.tsx, TemplateEditor.tsx, TemplatePreview.tsx'],
    ['/anatomic/tracking', 'AnatomicForbidden.tsx, TrackingScreen.tsx, MovementDialog.tsx'],
  ]),
  ...legacy7('BILLING', [
    ['/billing/accounts/entries', 'AccountReceiptView.tsx, accountsShared.tsx'],
    ['/billing/accounts/ledger', 'AccountLedgerScreen.tsx, accountsShared.tsx'],
    ['/billing/accounts/masters', 'AccountMastersScreen.tsx, accountsShared.tsx'],
    ['/billing/accounts/pocket', 'PocketLedgerScreen.tsx, accountsShared.tsx, AccountLedgerScreen.tsx'],
    ['/billing/accounts/summary', 'accountsShared.tsx'],
    ['/billing/cash-transfers', 'accountsShared.tsx'],
    ['/billing/daily-cash', 'DailyCashView.tsx, accountsShared.tsx'],
    ['/billing/discounts/authorities', 'accountsShared.tsx'],
    ['/billing/discounts/limits', 'accountsShared.tsx'],
    ['/billing/discounts/reasons', 'accountsShared.tsx'],
    ['/billing/discounts/slabs', 'accountsShared.tsx'],
    ['/billing/expenses', 'accountsShared.tsx'],
    ['/billing/expenses/types', 'accountsShared.tsx'],
    ['/billing/invoices/[invoice_id]', 'InvoiceDetailView.tsx, InvoiceDocument.tsx'],
    ['/billing/settings', 'PrintStationery.tsx'],
  ]),
  ...legacy7('ENGAGEMENT', [
    ['/engagement/bookable-items', 'BookingDetail.tsx, BookingNew.tsx, SlotsAdmin.tsx'],
    ['/engagement/bookings', 'BookingDetail.tsx, BookingNew.tsx, SlotsAdmin.tsx'],
    ['/engagement/bookings/[booking_id]', 'BookingDetail.tsx, BookingNew.tsx, SlotsAdmin.tsx'],
    ['/engagement/bookings/new', 'BookingDetail.tsx, BookingNew.tsx, SlotsAdmin.tsx'],
    ['/engagement/content', 'ProfileImages.tsx'],
    ['/engagement/enquiries/[enquiry_id]', 'EnquiryThread.tsx'],
    ['/engagement/messages/broadcasts', 'Broadcasts.tsx'],
    ['/engagement/settings', 'SettingsView.tsx'],
    ['/engagement/slots', 'BookingDetail.tsx, BookingNew.tsx, SlotsAdmin.tsx'],
  ]),
  ...legacy7('FRONTDESK', [
    ['/frontdesk/discount-approvals', 'DiscountApprovalsInbox.tsx'],
    ['/frontdesk/orders/[order_id]', 'OrderView.tsx'],
    ['/frontdesk/patients/[patient_id]', 'PatientView.tsx'],
    ['/frontdesk/registrations/new', 'RegistrationForm.tsx, ReceiptPrintView.tsx, accountsShared.tsx, InvoiceDocument.tsx'],
    ['/frontdesk/settings', 'SettingsView.tsx'],
  ]),
  ...legacy7('INSTRUMENTS', [
    ['/instruments/instruments', 'InstrumentForm.tsx'],
    ['/instruments/instruments/[instrument_id]', 'InstrumentForm.tsx'],
    ['/instruments/instruments/[instrument_id]/mappings', 'InstrumentMappings.tsx'],
    ['/instruments/messages/[instrument_message_id]', 'MessageDetail.tsx'],
  ]),
  ...legacy7('INVENTORY', [
    ['/inventory/bench', 'BenchView.tsx'],
    ['/inventory/reports', 'ReportBody.tsx'],
    ['/inventory/stock', 'StockView.tsx, IssueDrawer.tsx'],
    ['/inventory/unresolved', 'UnresolvedView.tsx, consoleParts.tsx'],
    ['/inventory/wastage', 'IssueDrawer.tsx'],
  ]),
  ...legacy7('LAB', [
    ['/lab/approval', 'QueueScreen.tsx, consoleParts.tsx, ResultDialogs.tsx'],
    ['/lab/critical-values', 'CriticalValueList.tsx, consoleParts.tsx'],
    ['/lab/ingest-exceptions', 'IngestExceptionList.tsx, consoleParts.tsx'],
    ['/lab/orders/[order_id]/labels', 'LabelPage.tsx'],
    ['/lab/orders/[order_id]/results', 'CommentCell.tsx, ResultDialogs.tsx, ResultPanels.tsx'],
    ['/lab/settings', 'VerificationPolicyTab.tsx'],
    ['/lab/specimens/[specimen_id]', 'SpecimenDetail.tsx'],
    ['/lab/verification', 'QueueScreen.tsx, consoleParts.tsx, ResultDialogs.tsx'],
    ['/lab/worksheets/[worksheet_id]', 'WorksheetPrintPage.tsx'],
  ]),
  ...legacy7('MICRO', [
    ['/micro/breakpoint-sets', 'MicroForbidden.tsx'],
    ['/micro/breakpoint-sets/[breakpoint_set_id]', 'MicroForbidden.tsx'],
    ['/micro/cultures/[culture_id]', 'MicroForbidden.tsx, ReportDrawer.tsx, ReadsTab.tsx, ChooseCultureDialog.tsx'],
    ['/micro/instrument-records', 'MicroForbidden.tsx'],
    ['/micro/settings', 'MicroForbidden.tsx, DictionariesTab.tsx, MappingsTab.tsx, PanelsTab.tsx, ProtocolsTab.tsx'],
    ['/micro/worklist', 'MicroForbidden.tsx, ChooseCultureDialog.tsx'],
  ]),
  ...legacy7('OFFLINE', [
    ['/offline', 'OfflinePanel.tsx, OfflineShell.tsx'],
  ]),
  ...legacy7('PARTNERS', [
    ['/partners/sales/representatives', 'SalesRepresentatives.tsx'],
    ['/partners/tickets/[ticket_id]', 'TicketThread.tsx'],
  ]),
  ...legacy7('PAYMENTS', [
    ['/payments/refunds', 'RefundsList.tsx, consoleParts.tsx'],
    ['/payments/review', 'ReviewQueue.tsx, consoleParts.tsx'],
  ]),
  ...legacy7('QUALITY', [
    ['/quality', 'LjView.tsx, RunDetailView.tsx'],
    ['/quality/autoverify/[version_id]', 'ReportView.tsx, RuleDrawer.tsx'],
    ['/quality/autoverify/decisions', 'DecisionsView.tsx'],
    ['/quality/lj', 'LjView.tsx, RunDetailView.tsx'],
    ['/quality/observations', 'LjView.tsx, RunDetailView.tsx'],
    ['/quality/qc-runs/[qc_run_id]', 'LjView.tsx, RunDetailView.tsx'],
    ['/quality/runs', 'LjView.tsx, RunDetailView.tsx'],
    ['/quality/settings', 'SettingsView.tsx'],
    ['/quality/setup/maps', 'MaterialsView.tsx, TargetsView.tsx'],
    ['/quality/setup/materials', 'MaterialsView.tsx, TargetsView.tsx'],
    ['/quality/setup/plans', 'MaterialsView.tsx, TargetsView.tsx'],
    ['/quality/setup/targets', 'MaterialsView.tsx, TargetsView.tsx'],
  ]),
  ...legacy7('REPORTING', [
    ['/reporting', 'CriticalAlertsPanel.tsx, ReportsWorklist.tsx'],
    ['/reporting/deliveries/[delivery_id]', 'DeliveryDetail.tsx'],
    ['/reporting/messages', 'MessagesChannels.tsx'],
    ['/reporting/narratives/[narrative_id]', 'NarrativeEditor.tsx'],
    ['/reporting/reports/[report_id]', 'ReportDetailView.tsx'],
    ['/reporting/settings', 'PrintStationery.tsx, ReportingSettingsForm.tsx, SignatoryProfiles.tsx'],
    ['/reporting/templates/[template_id]', 'TemplateEditor.tsx'],
  ]),
  ...legacy7('SMARTREPORT', [
    ['/smartreport/library', 'ReviewPanel.tsx, TextsTab.tsx, PreviewDialog.tsx'],
    ['/smartreport/library/[library_version_id]', 'ReviewPanel.tsx, TextsTab.tsx, PreviewDialog.tsx'],
    ['/smartreport/library/[library_version_id]/review', 'ReviewPanel.tsx, TextsTab.tsx, PreviewDialog.tsx'],
    ['/smartreport/summaries/[summary_id]', 'SummaryReview.tsx'],
    ['/smartreport/wording', 'ReviewPanel.tsx, TextsTab.tsx, PreviewDialog.tsx'],
  ]),
];
