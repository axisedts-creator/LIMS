// AN-T19 shared test harness (tester-owned; not a test file). MSW plays the API; fixtures follow services/api/.../mappers/reports.dto.ts
// (the real response shapes) and contracts/openapi/analytics.yaml. Synthetic data only.
// Each test file registers three mocks pointing here:
//   vi.mock('next/navigation', async () => (await import('./an-t19.harness')).navigationMock)
//   vi.mock('server-only', () => ({}))
//   vi.mock('@/core/session/server', async () => (await import('./an-t19.harness')).sessionMock)
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { vi, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import axe from 'axe-core';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { ToastProvider } from '@lims/ui/components/Toast';

export const ORIGIN = 'http://api.test';
process.env['LIMS_ORIGIN_API'] = ORIGIN;
process.env['LIMS_ANALYTICS_PDF_ENABLED'] = 'false';

export const CENTRE_A = '01a1a98a-ac40-7000-8000-000000000002';
export const CENTRE_B = '01a1a98a-ac40-7000-8000-000000000003';
export const BRANCH = '01a1a98a-ac40-7000-8000-000000000004';
export const DEPT = '01a1a98a-ac40-7000-8000-000000000005';
export const REF_ID = '01a1a98a-ac40-7000-8000-000000000006';
export const INST_1 = '01a1a98a-ac40-7000-8000-0000000000a1';
export const INST_2 = '01a1a98a-ac40-7000-8000-0000000000a2';
export const INST_3 = '01a1a98a-ac40-7000-8000-0000000000a3';
export const AGENT = '01a1a98a-ac40-7000-8000-0000000000b1';
export const ORDER = '01a1a98a-ac40-7000-8000-0000000000c1';
export const TOKEN = 'jwt-synthetic';

// ---------------------------------------------------------------- mocks (module-level state shared with the test file)
export const session = { permissions: ['analytics.dashboard.read'] as string[] };
export const sessionMock = {
  getAccessToken: async () => TOKEN,
  getShellSession: async () => ({ actor: { permissions: session.permissions, displayName: 'Synthetic Owner', tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => '/analytics/reports',
};
export const router = { push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() };
export const navigationMock = {
  useRouter: () => router,
  usePathname: () => '/analytics/reports',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
  redirect: (to: string) => { throw new Error(`NEXT_REDIRECT ${to}`); },
};
export const ALL = ['analytics.dashboard.read', 'analytics.collections.read', 'analytics.data.export', 'billing.cash_report.read', 'instruments.agent.read', 'lab.result.read'];

// ---------------------------------------------------------------- fixtures
export const problem = (code: string, status: number) => HttpResponse.json({ type: `urn:lims:error:${code}`, title: code, status, code }, { status });
const FRESH = [{ family: 'income', refreshed_at: '2026-01-15T04:30:00.000Z', is_stale: false, live: false }];
export const env = (code: string, over: Record<string, unknown> = {}) => ({
  report_code: code,
  period: { business_date_from: '2026-01-01', business_date_to: '2026-01-16', days: 15, label_ad: '01 Jan – 15 Jan 2026', label_bs: '2082-09-17 – 2082-10-01', timezone: 'Asia/Kathmandu' },
  scope: { all_centres: true, centre_ids: [], tenant_wide_sections_hidden: [] },
  freshness: FRESH,
  generated_at: '2026-01-15T04:30:00.000Z',
  ...over,
});

export interface TableSpec { name: RegExp; headers: string[]; /** compare headers after the first (group) column only */ skipFirst?: boolean; total?: boolean; rowText: string[]; totalText?: string[] }
export interface ReportSpec {
  slug: string;
  tab: string;
  /** API paths the page reads (the first is the "main" one used for query checks) */
  paths: string[];
  body: Record<string, any>;
  /** other path -> body (pending items) */
  extra?: Record<string, any>;
  empty: Record<string, any>;
  emptyExtra?: Record<string, any>;
  tables: TableSpec[];
  /** [query key, good value, bad value] forwarded / dropped by the BFF whitelist */
  params: [string, string, string][];
  /** rewrites the first row label of the main body to a hostile string */
  hostile: (b: any, label: string) => any;
  /** texts that must be on the page (notes, labels, formatted values) */
  texts: string[];
}
const patch = (b: any, path: string[], label: string) => {
  const c = structuredClone(b);
  let o = c;
  for (const p of path.slice(0, -1)) o = o[p];
  o[path.at(-1)!].label = label;
  return c;
};
const P = (key: string, ok: string, bad: string): [string, string, string] => [key, ok, bad];
const GROUP_DAY = P('group_by', 'bs_month', 'evil;drop');

const income = { key: '2026-01-15', label: '15 Jan 2026', label_bs: '2082-10-01', invoices_issued: 3, invoices_cancelled: 1, gross_paisa: 25000000, discount_paisa: 1000000, exempt_paisa: 0, taxable_paisa: 24000000, vat_paisa: 3120000, other_tax_paisa: 0, invoiced_paisa: 23000000, credit_notes_paisa: 500000, net_sales_paisa: 22500000 };
const incomeTotals = { invoices_issued: 6, invoices_cancelled: 2, gross_paisa: 50000000, discount_paisa: 2000000, exempt_paisa: 0, taxable_paisa: 48000000, vat_paisa: 6240000, other_tax_paisa: 0, invoiced_paisa: 46000000, credit_notes_paisa: 1000000, net_sales_paisa: 45000000 };
const zero = (o: Record<string, number>) => Object.fromEntries(Object.keys(o).map((k) => [k, 0]));

const volRow = { key: '2026-01-15', label: '15 Jan 2026', orders_registered: 14, orders_cancelled: 1, net_orders: 13, patient_visits: 12, new_patients: 4, urgent_orders: 2, opd_orders: 10, ipd_orders: 3, tests_ordered: 31 };
const volTot = { orders_registered: 28, orders_cancelled: 2, net_orders: 26, patient_visits: 24, new_patients: 8, urgent_orders: 4, opd_orders: 20, ipd_orders: 6, tests_ordered: 62 };

const tdRow = { key: DEPT, label: 'Synthetic Biochemistry', results_resulted: 40, results_verified: 38, results_approved: 36, results_amended: 2, auto_verified: 20, critical_count: 3, abnormal_count: 11, tests_approved: 30 };
const tdTot = { results_resulted: 80, results_verified: 76, results_approved: 72, results_amended: 4, auto_verified: 40, critical_count: 6, abnormal_count: 22, tests_approved: 61 };

const q = (k: string) => ({ rejections: 4, recollections_ordered: 3, specimens_received: 200, per_100_received_bp: 200, key: k, label: k });
const dl = { key: 'email', label: 'email', queued: 1, sent: 20, delivered: 18, read: 10, failed: 2, suppressed: 1, failure_share_bp: 870 };
const rel = { key: '2026-01-15', label: '15 Jan 2026', released: 30, final: 25, partial: 2, preliminary: 1, amended: 2, overrides: 3 };

const inst = (id: string, over: Record<string, unknown>) => ({ instrument_id: id, centre_id: CENTRE_A, messages: 100, patient_records: 80, qc_records: 15, unmatched: 3, quarantined: 1, duplicates: 1, ...over });

const pendingSummary = env('pending_tests', {
  period: undefined, freshness: [{ family: 'pending_items', refreshed_at: '2026-01-15T04:30:00.000Z', is_stale: false, live: true }],
  total: 9, overdue: 1, no_target: 2,
  by_status: [{ item_status: 'in_process', count: 5 }, { item_status: 'awaiting_receipt', count: 4 }],
  by_priority: [{ priority: 'urgent', count: 3 }, { priority: 'routine', count: 6 }],
  by_department: [{ department_id: DEPT, label: 'Synthetic Biochemistry', count: 6, overdue: 1 }],
  by_age_bucket: [{ bucket: 'lt_4h', count: 4 }, { bucket: 'h4_24', count: 3 }, { bucket: 'd1_3', count: 1 }, { bucket: 'gt_3d', count: 1 }],
  backlog: { reports_pending: 5, awaiting_results: 3, ready_unreleased: 2, by_centre: [] },
  age_anchor_note_key: 'analytics.pending.age_anchor',
});
const item = (over: Record<string, unknown>) => ({ order_item_id: '01a1a98a-ac40-7000-8000-0000000000d1', order_id: ORDER, centre_id: CENTRE_A, department_id: DEPT, test_id: '01a1a98a-ac40-7000-8000-0000000000e1', test_code: 'CBC', test_label: 'Complete blood count', priority: 'urgent', item_status: 'in_process', age_seconds: 2520, tat_target_seconds: 5400, is_overdue: false, open_route_id: 'staff.lab.order_results', ...over });
const pendingItems = {
  data: [
    item({}),
    item({ order_item_id: '01a1a98a-ac40-7000-8000-0000000000d2', test_code: 'LFT', test_label: 'Liver function test', priority: 'routine', item_status: 'awaiting_receipt', age_seconds: 273600, tat_target_seconds: 80700, is_overdue: true }),
  ],
  page: { limit: 50, next_cursor: 'cur2' },
};

export const REPORTS: ReportSpec[] = [
  {
    slug: 'income', tab: 'Income', paths: ['/v1/analytics/reports/income'],
    body: env('income', { rows: [income], totals: incomeTotals, basis_note_key: 'analytics.income.basis_note' }),
    empty: env('income', { rows: [], totals: zero(incomeTotals) }),
    tables: [{ name: /income/i, headers: ['Invoices', 'Cancelled', 'Gross', 'Discount', 'Exempt', 'Taxable', 'VAT', 'Other tax', 'Invoiced', 'Credit notes', 'Net sales'], skipFirst: true, total: true, rowText: ['15 Jan 2026', '2,25,000', '2,30,000'], totalText: ['4,50,000', '4,60,000'] }],
    params: [GROUP_DAY],
    hostile: (b, l) => patch(b, ['rows', '0'], l),
    texts: ['Income = invoices issued (incl. VAT/other tax) minus credit notes. Cash collected is shown separately.', 'Matches the sales register and credit-note register for the same dates.'],
  },
  {
    slug: 'department-income', tab: 'Departments', paths: ['/v1/analytics/reports/department-income'],
    body: env('department_income', {
      rows: [
        { key: DEPT, label: 'Synthetic Biochemistry', department_id: DEPT, is_multiple: false, line_count: 10, gross_paisa: 1000000, discount_paisa: 100000, net_paisa: 900000, share_bp: 6294 },
        { key: 'multiple', label: 'ignored for multiple', is_multiple: true, line_count: 2, gross_paisa: 600000, discount_paisa: 0, net_paisa: 600000, share_bp: 4206 },
      ],
      totals: { line_count: 12, gross_paisa: 1600000, discount_paisa: 100000, net_paisa: 1500000 }, reconciles_with_income: true,
    }),
    empty: env('department_income', { rows: [], totals: { line_count: 0, gross_paisa: 0, discount_paisa: 0, net_paisa: 0 }, reconciles_with_income: true }),
    tables: [{ name: /department/i, headers: ['Department', 'Billed lines', 'Gross', 'Discount', 'Net sales', 'Share'], total: true, rowText: ['Synthetic Biochemistry', '9,000', '62.9%', 'Multiple departments'], totalText: ['15,000'] }],
    params: [P('group_by', 'department_bs_month', 'evil;drop'), P('department_id', DEPT, 'not-a-uuid;drop')],
    hostile: (b, l) => patch(b, ['rows', '0'], l),
    texts: [],
  },
  {
    slug: 'collections', tab: 'Collections', paths: ['/v1/analytics/reports/collections'],
    body: env('collections', {
      rows: [{ key: 'cash', label: 'Cash', entries: 5, reversals: 1, gross_collected_paisa: 5000000, reversed_paisa: 500000, net_collected_paisa: 4500000 }],
      totals: { entries: 7, reversals: 1, gross_collected_paisa: 7000000, reversed_paisa: 500000, net_collected_paisa: 6500000 },
    }),
    empty: env('collections', { rows: [], totals: { entries: 0, reversals: 0, gross_collected_paisa: 0, reversed_paisa: 0, net_collected_paisa: 0 } }),
    tables: [{ name: /collection/i, headers: ['Payments', 'Reversals', 'Collected', 'Reversed/refunded', 'Net collected'], skipFirst: true, total: true, rowText: ['Cash', '45,000'], totalText: ['65,000'] }],
    params: [P('group_by', 'staff_method', 'evil;drop'), P('payment_method_code', 'cash,esewa', 'cash;drop table')],
    hostile: (b, l) => patch(b, ['rows', '0'], l),
    texts: ['Cash basis — includes payments of earlier invoices; differs from income.'],
  },
  {
    slug: 'volume', tab: 'Volume', paths: ['/v1/analytics/reports/volume'],
    body: env('volume', { rows: [volRow], totals: volTot }),
    empty: env('volume', { rows: [], totals: zero(volTot) }),
    tables: [{ name: /volume/i, headers: ['Orders', 'Cancelled', 'Net orders', 'Patient visits', 'New patients', 'Urgent', 'OPD', 'IPD', 'Tests ordered'], skipFirst: true, total: true, rowText: ['15 Jan 2026', '31'], totalText: ['62'] }],
    params: [GROUP_DAY],
    hostile: (b, l) => patch(b, ['rows', '0'], l),
    texts: [],
  },
  {
    slug: 'top-referrers', tab: 'Referrers', paths: ['/v1/analytics/reports/top-referrers'],
    body: env('top_referrers', {
      rows: [
        { rank: 1, referrer_id: REF_ID, label: 'Dr Synthetic One', is_self: false, is_inactive: false, orders: 5, patient_visits: 5, tests_ordered: 12 },
        { rank: 2, label: 'SELF', is_self: true, is_inactive: false, orders: 2, patient_visits: 2, tests_ordered: 4 },
      ],
      totals: { orders: 7, patient_visits: 7, tests_ordered: 16 },
    }),
    empty: env('top_referrers', { rows: [], totals: { orders: 0, patient_visits: 0, tests_ordered: 0 } }),
    tables: [{ name: /referrer/i, headers: ['Rank', 'Referrer', 'Orders', 'Patient visits', 'Tests ordered'], total: true, rowText: ['Dr Synthetic One', 'SELF (no referrer)'], totalText: ['16'] }],
    params: [P('sort', '-patient_visits', '-money;drop'), P('limit', '50', '1000'), P('rollup', 'none', 'x;drop'), P('referrer_id', `${REF_ID},${CENTRE_A}`, 'not-a-uuid;drop')],
    hostile: (b, l) => patch(b, ['rows', '0'], l),
    texts: [],
  },
  {
    slug: 'top-centres', tab: 'Centres', paths: ['/v1/analytics/reports/top-centres'],
    body: env('top_centres', {
      rows: [{ rank: 1, centre_id: CENTRE_A, label: 'Synthetic Centre A', branch_id: BRANCH, orders: 9, patient_visits: 8, tests_ordered: 20, net_sales_paisa: 12500000, by_mode: { walk_in: 6, home: 1, centre: 1, partner: 1 } }],
      totals: { orders: 9, patient_visits: 8, tests_ordered: 20, net_sales_paisa: 12500000 },
    }),
    empty: env('top_centres', { rows: [], totals: { orders: 0, patient_visits: 0, tests_ordered: 0, net_sales_paisa: 0 } }),
    tables: [{ name: /centre/i, headers: ['Rank', 'Centre', 'Orders', 'Walk-in', 'Home', 'Centre', 'Partner', 'Patient visits', 'Tests ordered', 'Net sales'], total: true, rowText: ['Synthetic Centre A', '1,25,000'], totalText: ['1,25,000'] }],
    params: [P('sort', '-net_sales_paisa', '-money;drop'), P('limit', '20', '100')],
    hostile: (b, l) => patch(b, ['rows', '0'], l),
    texts: [],
  },
  {
    slug: 'tests-done', tab: 'Tests done', paths: ['/v1/analytics/reports/tests-done'],
    body: env('tests_done', { rows: [tdRow], totals: tdTot }),
    empty: env('tests_done', { rows: [], totals: zero(tdTot) }),
    tables: [{ name: /tests done/i, headers: ['Resulted', 'Verified', 'Approved', 'Amended', 'Auto-verified', 'Critical', 'Abnormal', 'Tests completed'], skipFirst: true, total: true, rowText: ['Synthetic Biochemistry', '38', '30'], totalText: ['61'] }],
    params: [P('group_by', 'processing_branch', 'evil;drop'), P('processing_branch_id', BRANCH, 'not-a-uuid;drop'), P('department_id', DEPT, 'not-a-uuid;drop')],
    hostile: (b, l) => patch(b, ['rows', '0'], l),
    texts: ['Results (analyte level)'],
  },
  {
    slug: 'tat', tab: 'TAT', paths: ['/v1/analytics/reports/tat'],
    body: env('tat', {
      rows: [
        { segment: 'pre_analytical', n: 10, median_seconds: 2520, p90_seconds: 18720, max_seconds: 273600, anomalies: 1 },
        { segment: 'transport', n: 0, anomalies: 0 },
        { segment: 'within_lab', key: CENTRE_A, label: 'Synthetic Centre A', n: 8, median_seconds: 2520, p90_seconds: 2520, max_seconds: 2520, anomalies: 0 },
      ],
      segment_definitions: ['pre_analytical', 'transport', 'within_lab', 'total_first_release', 'total_final_release'].map((s) => ({ segment: s, start_label_key: `analytics.tat.${s}.start`, stop_label_key: `analytics.tat.${s}.stop` })),
    }),
    empty: env('tat', { rows: [], segment_definitions: [] }),
    tables: [{ name: /tat|turnaround/i, headers: ['Segment', 'Group', 'Samples (n)', 'Median', '90th percentile', 'Max', 'Excluded (anomalies)'], rowText: ['Pre-analytical', 'Transport', 'Within-lab', '42 min', '5 h 12 min', '3 d 4 h'] }],
    params: [P('segment', 'pre_analytical,transport', 'evil;drop'), P('priority', 'urgent', 'evil;drop'), P('specimen_type_code', 'serum', 'serum;drop table'), P('processing_branch_id', BRANCH, 'not-a-uuid;drop'), P('group_by', 'specimen_type', 'evil;drop')],
    hostile: (b, l) => patch(b, ['rows', '2'], l),
    texts: ['Sample collected', 'Received at lab', 'Scanned out at centre', 'Scanned in at lab', 'First result verified', 'First report released', 'Final report released', 'Server times are used, not analyser clocks.', 'Priority and specimen-type filters apply to sample segments only.'],
  },
  {
    slug: 'pending-tests', tab: 'Pending tests',
    paths: ['/v1/analytics/reports/pending-tests/items', '/v1/analytics/reports/pending-tests/summary'],
    body: pendingItems,
    extra: { '/v1/analytics/reports/pending-tests/summary': pendingSummary },
    empty: { data: [], page: { limit: 50 } },
    emptyExtra: { '/v1/analytics/reports/pending-tests/summary': { ...pendingSummary, total: 0, overdue: 0, no_target: 0, by_status: [], by_priority: [], by_department: [], by_age_bucket: [], backlog: { reports_pending: 0, awaiting_results: 0, ready_unreleased: 0, by_centre: [] } } },
    tables: [{ name: /pending/i, headers: ['Department', 'Test', 'Priority', 'Status', 'Centre', 'Age', 'Target', 'Overdue'], rowText: ['CBC — Complete blood count', 'Urgent', 'In process', '42 min', '1 h 30 min', 'Liver function test', 'Awaiting receipt', '3 d 4 h', '22 h 25 min'] }],
    params: [P('department_id', DEPT, 'not-a-uuid;drop'), P('priority', 'urgent', 'evil;drop'), P('item_status', 'in_process,resulted', 'evil;drop'), P('overdue_only', 'true', 'evil;drop'), P('sort', 'age_seconds', '-evil;drop'), P('processing_branch_id', BRANCH, 'not-a-uuid;drop')],
    hostile: (b, l) => { const c = structuredClone(b); c.data[0].test_label = l; return c; },
    texts: ['Age since receipt at the lab, or since registration if not yet received.'],
  },
  {
    slug: 'quality-indicators', tab: 'Quality', paths: ['/v1/analytics/reports/quality-indicators'],
    body: env('quality_indicators', {
      rejections: { rows: [q('clotted_sample')], totals: { rejections: 4, recollections_ordered: 3, specimens_received: 200, per_100_received_bp: 200 } },
      critical_values: {
        rows: [{ business_date: '2026-01-15', detected: 5, notified: 4, notified_bp: 8000, median_notify_seconds: 2520, max_notify_seconds: 18720 }],
        totals: { detected: 5, notified: 4, notified_bp: 8000, max_notify_seconds: 18720 },
      },
    }),
    empty: env('quality_indicators', {
      rejections: { rows: [], totals: { rejections: 0, recollections_ordered: 0, specimens_received: 0 } },
      critical_values: { rows: [], totals: { detected: 0, notified: 0 } },
    }),
    tables: [
      { name: /rejection/i, headers: ['Rejections', 'Recollections ordered', 'Specimens received', 'Rejections per 100 received'], skipFirst: true, total: true, rowText: ['clotted sample', '2.0%'], totalText: ['200'] },
      { name: /critical/i, headers: ['Date', 'Detected', 'Notified', 'Notified %', 'Median time to notify', 'Max time to notify'], total: true, rowText: ['80.0%', '42 min', '5 h 12 min'] },
    ],
    params: [P('group_by', 'specimen_type', 'evil;drop')],
    hostile: (b, l) => { const c = structuredClone(b); c.rejections.rows[0].label = l; c.rejections.rows[0].key = l; return c; },
    texts: ['Median is shown per day only.'],
  },
  {
    slug: 'delivery', tab: 'Delivery', paths: ['/v1/analytics/reports/delivery'],
    body: env('delivery', { deliveries: { rows: [dl], totals: { queued: 2, sent: 40, delivered: 36, read: 20, failed: 4, suppressed: 2, failure_share_bp: 870 } }, releases: { rows: [rel], totals: { released: 60, final: 50, partial: 4, preliminary: 2, amended: 4, overrides: 6 } } }),
    empty: env('delivery', { deliveries: { rows: [], totals: { queued: 0, sent: 0, delivered: 0, read: 0, failed: 0, suppressed: 0 } }, releases: { rows: [], totals: { released: 0, final: 0, partial: 0, preliminary: 0, amended: 0, overrides: 0 } } }),
    tables: [
      { name: /deliver/i, headers: ['Queued', 'Sent', 'Delivered', 'Read', 'Failed', 'Suppressed', 'Failure share'], skipFirst: true, total: true, rowText: ['8.7%'], totalText: ['40'] },
      { name: /release/i, headers: ['Released', 'Final', 'Partial', 'Preliminary', 'Amended', 'Override releases'], skipFirst: true, total: true, rowText: ['15 Jan 2026', '30'], totalText: ['60'] },
    ],
    params: [P('group_by', 'ad_month', 'evil;drop')],
    hostile: (b, l) => { const c = structuredClone(b); c.deliveries.rows[0].label = l; return c; },
    texts: ['Counted on the day each message was created; later status changes update that day.'],
  },
  {
    slug: 'interfaces', tab: 'Interfaces', paths: ['/v1/analytics/reports/interfaces'],
    body: env('interfaces', {
      instruments: [
        inst(INST_1, { instrument_code: 'XN-1000', label: 'Synthetic Haematology Analyser', is_active: true }),
        inst(INST_2, { instrument_code: 'OLD-1', label: 'Synthetic Retired Analyser', is_active: false }),
        inst(INST_3, {}),
      ],
      agents: { by_state: [{ state: 'online', count: 2 }, { state: 'offline', count: 1 }], agents: [{ agent_id: AGENT, centre_id: CENTRE_A, state: 'online', last_heartbeat_at: '2026-01-15T04:29:00.000Z', agent_version: '1.4.2', queue_depth: 7 }] },
    }),
    empty: env('interfaces', { instruments: [], agents: { by_state: [], agents: [] } }),
    tables: [
      { name: /agent/i, headers: ['Agent', 'Centre', 'State', 'Last heartbeat', 'Version', 'Queue'], rowText: ['1.4.2', 'Online'] },
      { name: /instrument|message/i, headers: ['Instrument', 'Centre', 'Messages', 'Patient records', 'QC records', 'Unmatched', 'Quarantined', 'Duplicates'], rowText: ['Synthetic Haematology Analyser', 'XN-1000', 'Synthetic Retired Analyser (inactive)'] },
    ],
    params: [],
    hostile: (b, l) => { const c = structuredClone(b); c.instruments[0].label = l; return c; },
    texts: [],
  },
];
export const bySlug = (s: string) => REPORTS.find((r) => r.slug === s)!;

// ---------------------------------------------------------------- MSW
export const FILTER_OPTIONS = {
  centres: [{ id: CENTRE_A, label: 'Synthetic Centre A', branch_id: BRANCH, is_active: true }, { id: CENTRE_B, label: 'Synthetic Centre B', branch_id: BRANCH, is_active: true }],
  branches: [{ id: BRANCH, label: 'Synthetic Branch North', is_active: true }],
  departments: [{ id: DEPT, label: 'Synthetic Biochemistry', is_active: true }],
  payment_methods: [{ code: 'cash', display: 'Cash' }, { code: 'esewa', display: 'eSewa' }],
  specimen_types: [{ code: 'serum' }],
};
export const calls: { url: URL; headers: Headers; method: string; body?: string }[] = [];
export const bodies: Record<string, any> = {};
export const respond: Record<string, () => Response | Promise<Response>> = {};
export function resetApi() {
  calls.length = 0;
  for (const k of Object.keys(bodies)) delete bodies[k];
  for (const k of Object.keys(respond)) delete respond[k];
  for (const r of REPORTS) { bodies[r.paths[0]!] = r.body; Object.assign(bodies, r.extra ?? {}); }
  bodies['/v1/analytics/filter-options'] = FILTER_OPTIONS;
  bodies['/v1/analytics/filter-options/collections'] = { centres: FILTER_OPTIONS.centres, branches: FILTER_OPTIONS.branches, payment_methods: FILTER_OPTIONS.payment_methods };
  bodies['/v1/analytics/freshness'] = { data: FRESH };
  session.permissions = ['analytics.dashboard.read'];
  router.push.mockClear(); router.replace.mockClear(); router.refresh.mockClear();
}
export const api = setupServer(
  http.all(`${ORIGIN}/v1/analytics/*`, async ({ request }) => {
    const url = new URL(request.url);
    calls.push({ url, headers: request.headers, method: request.method, ...(request.method === 'POST' ? { body: await request.clone().text() } : {}) });
    const h = respond[url.pathname];
    if (h) return h();
    const b = bodies[url.pathname];
    return b !== undefined ? HttpResponse.json(b) : problem('common.dependency_unavailable', 503);
  }),
);
/** GET calls to the report/collections read endpoints (not filter-options/freshness). */
export const readCalls = () => calls.filter((c) => c.method === 'GET' && /\/v1\/analytics\/reports\//.test(c.url.pathname));
export const callsTo = (path: string) => calls.filter((c) => c.method === 'GET' && c.url.pathname === path);

// ---------------------------------------------------------------- pages
type SP = Record<string, string | string[] | undefined>;
const APP = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'app', '(staff)', 'analytics');
export const appDir = APP;
export function pageFile(kind: 'hub' | 'collections' | string): { rel: string; paramKey?: string } {
  if (kind === 'hub') return { rel: 'reports/page' };
  if (kind === 'collections') return { rel: 'collections/page' };
  if (kind === 'collections-report') return { rel: 'collections/page' };
  if (existsSync(join(APP, 'reports', kind, 'page.tsx'))) return { rel: `reports/${kind}/page` };
  const dyn = existsSync(join(APP, 'reports')) ? readdirSync(join(APP, 'reports')).find((d) => /^\[[A-Za-z_]+\]$/.test(d) && existsSync(join(APP, 'reports', d, 'page.tsx'))) : undefined;
  if (dyn) return { rel: `reports/${dyn}/page`, paramKey: dyn.slice(1, -1) };
  throw new Error(`no page for report "${kind}": expected app/(staff)/analytics/reports/${kind}/page.tsx or reports/[reportCode]/page.tsx`);
}
export async function load(kind: string) {
  const { rel, paramKey } = pageFile(kind);
  const mod = (await import(/* @vite-ignore */ `../../../app/(staff)/analytics/${rel}`)) as { default: (p: any) => Promise<any> };
  return { Page: mod.default, paramKey };
}
export async function show(kind: string, sp: SP = {}) {
  const { Page, paramKey } = await load(kind);
  const props: Record<string, unknown> = { searchParams: Promise.resolve(sp) };
  if (paramKey) props['params'] = Promise.resolve({ [paramKey]: kind });
  const el = await Page(props);
  return render(<ToastProvider>{el}</ToastProvider>);
}

/** Renders, or returns false when the page refuses by throwing. A MISSING page is never a "refusal": it rethrows. */
export async function showOrRefuse(kind: string, sp: SP = {}): Promise<boolean> {
  try { await show(kind, sp); return true; } catch (e) {
    if (/no page for report|Cannot find module|Failed to (load|resolve)/.test(String((e as Error)?.message))) throw e;
    return false;
  }
}

// ---------------------------------------------------------------- DOM helpers
export const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
export function gridNamed(re: RegExp) {
  const g = screen.queryAllByRole('grid', { name: re });
  if (!g.length) throw new Error(`no table named ${re}; tables: ${JSON.stringify(screen.queryAllByRole('grid').map((x) => x.getAttribute('aria-label')))}`);
  return g[0]!;
}
export const headersOf = (g: HTMLElement) => within(g).getAllByRole('columnheader').map((h) => norm(h.textContent));
export const dataRows = (g: HTMLElement) => within(g).getAllByRole('row').slice(1);
export const rowTexts = (g: HTMLElement) => dataRows(g).map((r) => norm(r.textContent));
export const lastRow = (g: HTMLElement) => dataRows(g).at(-1)!;
export const pageText = () => norm(document.body.textContent) + ' ' + [...document.body.querySelectorAll('[title],[aria-label]')].map((e) => `${e.getAttribute('title') ?? ''} ${e.getAttribute('aria-label') ?? ''}`).join(' ');
export async function axeClean() {
  const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
  expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
}
export const shortcut = async (pageId: string, re: RegExp) => (await import('@/core/shortcuts/registry')).shortcuts.list(pageId).find((s) => re.test(s.key));
