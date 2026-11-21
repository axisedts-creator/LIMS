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
  ...legacy('PARTNERS', 2, 'PartysetCommon.tsx, ManifestInbox.tsx, PenaltyEvents.tsx', [
    '/partners/manifests',
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
  ...legacy('FRONTDESK', 4, 'the page itself', [
    '/frontdesk/orders/[order_id]',
    '/frontdesk/patients/[patient_id]',
  ]),
  ...legacy('CATALOG', 5, 'AnalytesTab.tsx', [
    '/catalog/tests/[test_id]',
  ]),
  ...legacy('FRONTDESK', 5, 'OrderView.tsx, PatientView.tsx', [
    '/frontdesk/orders/[order_id]',
    '/frontdesk/patients/[patient_id]',
  ]),
  ...legacy('QUALITY', 6, 'ReportView.tsx', [
    '/quality/autoverify/[version_id]',
  ]),

  // T0D-UIGUARD-2 (LD-436 R7, LD-438, LD-439 c): rule 7 legacy baseline, one entry per route, reason 'legacy baseline LD-436, fix in T0D-UIGUARD-1-<AREA>'.
  // The area is the sidebar group of the route (LD-439 a); the area task rebuilds every screen of its area, so when it ends none of its entries may remain (LD-439 b).
  // Nothing under app/(auth), app/(platform), features/platform or features/admin/auth is walked, so no pinned rule 7 entry is needed (a finding there would fail the pinned test).
  { route: '/[...slug]', rule: 7, reason: 'catch-all placeholder for module routes without a page; not a screen (CR T0D-14): raw h1 in page.tsx' },
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
  ...legacy7('CATALOG', [
    ['/catalog', 'CatalogHome.tsx'],
    ['/catalog/comment-codes', 'CatalogForbidden.tsx, master-ui.tsx'],
    ['/catalog/credit-parties', 'CatalogForbidden.tsx, master-ui.tsx'],
    ['/catalog/departments', 'CatalogForbidden.tsx, master-ui.tsx'],
    ['/catalog/doctors', 'CatalogForbidden.tsx, DoctorsList.tsx, master-ui.tsx, DoctorMergeDialog.tsx'],
    ['/catalog/doctors/[doctor_id]', 'CatalogForbidden.tsx, master-ui.tsx, DoctorMergeDialog.tsx'],
    ['/catalog/doctors/verify', 'CatalogForbidden.tsx, master-ui.tsx, DoctorMergeDialog.tsx'],
    ['/catalog/imports', 'CatalogForbidden.tsx, ImportsScreen.tsx, TestImportScreen.tsx, master-ui.tsx'],
    ['/catalog/imports/[import_id]', 'CatalogForbidden.tsx, ImportDetail.tsx, master-ui.tsx'],
    ['/catalog/methods', 'CatalogForbidden.tsx, master-ui.tsx'],
    ['/catalog/panels', 'CatalogForbidden.tsx, master-ui.tsx, PanelMembers.tsx'],
    ['/catalog/panels/[panel_id]', 'CatalogForbidden.tsx, PanelDetail.tsx, master-ui.tsx, PanelMembers.tsx, compact-ui.tsx'],
    ['/catalog/price-lists', 'CatalogForbidden.tsx, master-ui.tsx'],
    ['/catalog/price-lists/[price_list_id]', 'CatalogForbidden.tsx, PriceListDetail.tsx, master-ui.tsx, PriceListTools.tsx'],
    ['/catalog/price-lists/[price_list_id]/versions/[version_id]', 'CatalogForbidden.tsx, master-ui.tsx'],
    ['/catalog/price-simulator', 'PriceSimulator.tsx, CatalogForbidden.tsx, master-ui.tsx'],
    ['/catalog/specimens', 'CatalogForbidden.tsx, master-ui.tsx'],
    ['/catalog/surcharges', 'CatalogForbidden.tsx, master-ui.tsx'],
    ['/catalog/tax', 'CatalogForbidden.tsx, master-ui.tsx'],
    ['/catalog/tests', 'CatalogForbidden.tsx, TestDetailsView.tsx, compact-ui.tsx, master-ui.tsx'],
    ['/catalog/tests/[test_id]', 'ParameterForm.tsx, RangesTab.tsx, TestHeader.tsx, compact-ui.tsx'],
    ['/catalog/units', 'CatalogForbidden.tsx, master-ui.tsx'],
  ]),
  ...legacy7('FRONTDESK', [
    ['/frontdesk/discount-approvals', 'DiscountApprovalsInbox.tsx'],
    ['/frontdesk/orders/[order_id]', 'OrderView.tsx'],
    ['/frontdesk/patients/[patient_id]', 'PatientView.tsx'],
    ['/frontdesk/registrations/new', 'RegistrationForm.tsx, ReceiptPrintView.tsx, accountsShared.tsx, InvoiceDocument.tsx'],
    ['/frontdesk/settings', 'SettingsView.tsx'],
  ]),
  ...legacy7('MICRO', [
    ['/micro/breakpoint-sets', 'MicroForbidden.tsx'],
    ['/micro/breakpoint-sets/[breakpoint_set_id]', 'MicroForbidden.tsx'],
    ['/micro/cultures/[culture_id]', 'MicroForbidden.tsx, ReportDrawer.tsx, ReadsTab.tsx, ChooseCultureDialog.tsx'],
    ['/micro/instrument-records', 'MicroForbidden.tsx'],
    ['/micro/settings', 'MicroForbidden.tsx, DictionariesTab.tsx, MappingsTab.tsx, PanelsTab.tsx, ProtocolsTab.tsx'],
    ['/micro/worklist', 'MicroForbidden.tsx, ChooseCultureDialog.tsx'],
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
];
