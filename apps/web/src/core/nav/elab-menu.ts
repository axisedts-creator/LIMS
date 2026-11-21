// LD-340 (founder 2026-11-17 20:37 NPT): the sidebar follows the ElabAssist menu (names, order, grouping) because the users already know it.
// Presentation only: routes, permissions and the manifests (NavGroup, ids, chords) are untouched; AppShell uses this when menu="elab".
// An entry that is not listed here keeps working: it falls back to the group of its manifest (see fallbackGroup), so no screen can vanish.
export interface ElabGroup { readonly id: string; readonly labelKey: string; /** one entry: shown as a plain link, no accordion */ readonly direct?: boolean }

export const ELAB_GROUPS: readonly ElabGroup[] = [
  { id: 'dashboard', labelKey: 'core.elab.group.dashboard', direct: true },
  { id: 'daily_work', labelKey: 'core.elab.group.daily_work' },
  { id: 'accounts', labelKey: 'core.elab.group.accounts' },
  { id: 'reports', labelKey: 'core.elab.group.reports' },
  { id: 'administration', labelKey: 'core.elab.group.administration' },
  { id: 'quality', labelKey: 'core.nav.group.quality' },
  { id: 'machine', labelKey: 'core.elab.group.machine' },
  { id: 'inventory', labelKey: 'core.nav.group.inventory' },
  { id: 'partners', labelKey: 'core.nav.group.partners' },
  { id: 'engagement', labelKey: 'core.nav.group.engagement' },
  { id: 'home_collection', labelKey: 'core.nav.group.home_collection' },
  { id: 'other', labelKey: 'core.elab.group.other' },
];

type Slot = readonly [group: string, section: string | undefined, ids: readonly string[]];

/** In menu order: the position of an id in this list is its place in the sidebar. */
const SLOTS: readonly Slot[] = [
  ['dashboard', undefined, ['analytics.dashboard']],
  ['daily_work', undefined, [
    'frontdesk.registration_new', 'frontdesk.worklist', 'frontdesk.discount_approvals',
    'lab.status_board', 'lab.collect', 'lab.receive', 'lab.worklists', 'lab.pending', 'lab.verification', 'lab.approval',
    'lab.critical_values', 'lab.worksheets', 'reporting.worklist', 'reporting.outsourced',
  ]],
  ['daily_work', 'core.nav.section.microbiology', ['micro.worklist', 'micro.instrument_records', 'micro.breakpoint_sets', 'micro.settings']],
  ['daily_work', 'core.nav.section.anatomic', ['anatomic.worklist', 'anatomic.tracking', 'anatomic.batches', 'anatomic.config']],
  ['accounts', undefined, ['billing.account_entries', 'billing.account_summary', 'billing.account_ledger', 'billing.pocket_ledger', 'billing.daily_cash']],
  ['accounts', 'core.elab.section.billing', ['billing.invoices', 'billing.dues', 'billing.credit_parties', 'billing.registers', 'billing.worklist', 'billing.cbms']],
  ['accounts', 'core.nav.section.payments', ['payments.review', 'payments.refunds', 'payments.reconciliation', 'payments.static_qr', 'payments.settings']],
  ['reports', undefined, ['analytics.reports', 'reporting.settings', 'reporting.messages', 'analytics.collections', 'analytics.referral']],
  ['reports', 'core.elab.section.mis', ['analytics.exports', 'analytics.schedules']],
  ['reports', 'core.nav.section.smart_summaries', ['smartreport.summaries', 'smartreport.library', 'smartreport.wording']],
  ['administration', 'core.elab.section.user_mgmt', ['admin.users', 'admin.user_new', 'admin.roles', 'admin.sessions', 'admin.access_review', 'admin.me']],
  ['administration', 'core.elab.section.ops_masters', ['admin.branches', 'admin.centres', 'catalog.doctors', 'catalog.credit_parties']],
  ['administration', 'core.elab.section.test_mgmt', [
    'catalog.tests', 'catalog.panels', 'catalog.departments', 'catalog.specimens', 'catalog.units', 'catalog.comment_codes',
    'catalog.methods', 'catalog.imports', 'catalog.home',
  ]],
  ['administration', 'core.elab.section.accounting', ['catalog.price_lists', 'catalog.price_simulator', 'catalog.surcharges', 'catalog.tax', 'billing.account_masters']],
  ['administration', 'core.elab.section.settings', ['admin.settings', 'frontdesk.settings', 'lab.settings', 'billing.settings']],
  ['administration', 'core.elab.section.audit', ['admin.audit', 'admin.access_log', 'admin.exports', 'admin.support_access', 'billing.audit_trail']],
  ['machine', undefined, ['instruments.agents', 'instruments.instruments', 'instruments.messages', 'lab.ingest_exceptions', 'instruments.settings']],
];

export interface ElabPlace { readonly group: string; readonly section?: string; readonly pos: number }

export const ELAB_PLACE: ReadonlyMap<string, ElabPlace> = (() => {
  const m = new Map<string, ElabPlace>();
  let pos = 0;
  for (const [group, section, ids] of SLOTS) for (const id of ids) m.set(id, { group, ...(section ? { section } : {}), pos: pos++ });
  return m;
})();

const FALLBACK: Readonly<Record<string, string>> = {
  front_desk: 'daily_work', laboratory: 'daily_work', reporting: 'reports', billing: 'accounts', catalog: 'administration',
  instruments: 'machine', analytics: 'reports', quality: 'quality', inventory: 'inventory', partners: 'partners',
  engagement: 'engagement', home_collection: 'home_collection', admin: 'administration',
};

/** Sidebar group of a manifest entry that SLOTS does not list. */
export const fallbackGroup = (manifestGroup: string): string => FALLBACK[manifestGroup] ?? 'other';
