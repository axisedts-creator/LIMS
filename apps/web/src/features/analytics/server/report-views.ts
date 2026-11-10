// AN-T19: API report bodies -> plain-JSON PageVM for the client ReportView (04-UI-UX §2, §4.1-§4.12; copy per §13).
// Bodies are read defensively cell by cell: a missing/odd field becomes "—", never NaN/undefined/[object Object]. Only listed fields are read
// (no spread of API rows), so a stray field such as a money amount on the referrer report can never reach the page (D-44).
import type { Cell, Col, Control, FreshnessVM, Opt, PageVM, Section, TableVM } from '../components/report-types';
import type { FilterOptions, Json, ReportDef } from './reports.server';

type Perms = readonly string[];
type Kind = 'int' | 'money' | 'bp' | 'dur';
type Spec = [header: string, key: string, kind: Kind];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {});
const arr = (v: unknown): Json[] => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') : []);
const t = (v: string): Cell => ({ k: 'text', v });
const c = (k: Kind, v: unknown): Cell => ({ k, v: num(v) });
const short = (id: string) => (id.length > 8 ? `${id.slice(0, 8)}…` : id);

const TABS: readonly (readonly [id: string, label: string, href: string, permission: string])[] = [
  ['income', 'Income', '/analytics/reports/income', 'analytics.dashboard.read'],
  ['department-income', 'Departments', '/analytics/reports/department-income', 'analytics.dashboard.read'],
  ['collections', 'Collections', '/analytics/collections', 'analytics.collections.read'], // route staff.analytics.collections (D-46)
  ['volume', 'Volume', '/analytics/reports/volume', 'analytics.dashboard.read'],
  ['top-referrers', 'Referrers', '/analytics/reports/top-referrers', 'analytics.dashboard.read'],
  ['top-centres', 'Centres', '/analytics/reports/top-centres', 'analytics.dashboard.read'],
  ['tests-done', 'Tests done', '/analytics/reports/tests-done', 'analytics.dashboard.read'],
  ['tat', 'TAT', '/analytics/reports/tat', 'analytics.dashboard.read'],
  ['pending-tests', 'Pending tests', '/analytics/reports/pending-tests', 'analytics.dashboard.read'],
  ['quality-indicators', 'Quality', '/analytics/reports/quality-indicators', 'analytics.dashboard.read'],
  ['delivery', 'Delivery', '/analytics/reports/delivery', 'analytics.dashboard.read'],
  ['interfaces', 'Interfaces', '/analytics/reports/interfaces', 'analytics.dashboard.read'],
];
/** Tabs the session may use, §4 order (04-UI-UX §4: tabs the user cannot use are not rendered). */
export const tabsFor = (perms: Perms) => TABS.filter((x) => perms.includes(x[3])).map(([id, label, href]) => ({ id, label, href }));

// ------------------------------------------------------------------ helpers
const opts = (...p: [string, string][]): Opt[] => p.map(([value, label]) => ({ value, label }));
const list = (q: URLSearchParams, id: string) => (q.get(id) ?? '').split(',').filter(Boolean);
const radio = (q: URLSearchParams, id: string, label: string, options: Opt[], dflt: string): Extract<Control, { type: 'radio' }> => ({ type: 'radio', id, label, options, value: options.some((o) => o.value === q.get(id)) ? q.get(id)! : dflt });
const select = (q: URLSearchParams, id: string, label: string, options: Opt[], dflt: string): Control => ({ type: 'select', id, label, options, value: options.some((o) => o.value === q.get(id)) ? q.get(id)! : dflt });
const multi = (q: URLSearchParams, id: string, label: string, options: Opt[]): Control[] => (options.length > 0 ? [{ type: 'multi', id, label, options, value: list(q, id) }] : []);
const labelOf = (o: Opt[], v: string) => o.find((x) => x.value === v)?.label ?? v;
const name = (r: Json) => str(r.label) + (r.is_inactive ? ' (inactive)' : '');

function table(a: { id: string; caption: string; heading?: string; first: string; specs: Spec[]; rows: Json[]; totals?: Json; head: (r: Json) => Cell }): TableVM {
  const cols: Col[] = [{ id: 'g', header: a.first }, ...a.specs.map(([header, key], i) => ({ id: `${i}:${key}`, header, align: 'end' as const }))];
  return {
    id: a.id, caption: a.caption, ...(a.heading ? { heading: a.heading } : {}), columns: cols,
    rows: a.rows.map((r, i) => ({ id: `${i}:${str(r.key)}`, cells: [a.head(r), ...a.specs.map(([, key, kind]) => c(kind, r[key]))] })),
    ...(a.rows.length > 0 && a.totals ? { total: [t('Total'), ...a.specs.map(([, key, kind]) => c(kind, a.totals![key]))] } : {}),
  };
}
const labelCell = (r: Json): Cell => t(name(r) + (str(r.label_bs) ? ` · ${str(r.label_bs)}` : ''));

interface Built { title: string; controls: Control[]; sections: Section[]; groupLabel?: string }
interface Ctx { q: URLSearchParams; o: FilterOptions | undefined; perms: Perms; summary?: Json }
const T = (x: TableVM): Section => ({ t: 'table', vm: x });

const DAY_OPTS = opts(['day', 'Day'], ['ad_month', 'A.D. month'], ['bs_month', 'B.S. month'], ['branch', 'Branch'], ['centre', 'Centre']);
const MONTH_TAIL: [string, string][] = [['day', 'Day'], ['ad_month', 'A.D. month'], ['bs_month', 'B.S. month']];
const SEG: [string, string, string, string][] = [
  ['pre_analytical', 'Pre-analytical', 'Sample collected', 'Received at lab'],
  ['transport', 'Transport', 'Scanned out at centre', 'Scanned in at lab'],
  ['within_lab', 'Within-lab', 'Received at lab', 'First result verified'],
  ['total_first_release', 'Total (first report)', 'Registered', 'First report released'],
  ['total_final_release', 'Total (final report)', 'Registered', 'Final report released'],
];
const STATUS: Record<string, string> = { awaiting_collection: 'Awaiting collection', awaiting_receipt: 'Awaiting receipt', in_process: 'In process', resulted: 'Resulted', verified: 'Verified' };
const AGE: Record<string, string> = { lt_4h: 'Under 4 h', h4_24: '4–24 h', d1_3: '1–3 days', gt_3d: 'Over 3 days' };
const WHEN = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kathmandu' });
const when = (iso: string) => { const ms = Date.parse(iso); return Number.isFinite(ms) ? WHEN.format(ms) : '—'; };
const cap = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : '');

// ------------------------------------------------------------------ per report
function income(b: Json, { q }: Ctx): Built {
  const g = radio(q, 'group_by', 'Group by', DAY_OPTS, 'day');
  const rows = arr(b.rows);
  const chart: Section[] = rows.length === 0 ? [] : rows.length > 31
    ? [{ t: 'note', text: 'Chart shows up to 31 groups' }]
    : [{ t: 'chart', title: 'Net sales per group', categories: rows.map((r) => str(r.label)), series: [{ id: 'net', label: 'Net sales', values: rows.map((r) => num(r.net_sales_paisa) ?? 0) }], format: 'money' }];
  const specs: Spec[] = [['Invoices', 'invoices_issued', 'int'], ['Cancelled', 'invoices_cancelled', 'int'], ['Gross', 'gross_paisa', 'money'], ['Discount', 'discount_paisa', 'money'], ['Exempt', 'exempt_paisa', 'money'], ['Taxable', 'taxable_paisa', 'money'], ['VAT', 'vat_paisa', 'money'], ['Other tax', 'other_tax_paisa', 'money'], ['Invoiced', 'invoiced_paisa', 'money'], ['Credit notes', 'credit_notes_paisa', 'money'], ['Net sales', 'net_sales_paisa', 'money']];
  return {
    title: 'Income', controls: [g], groupLabel: labelOf(g.options, g.value),
    sections: [...chart, T(table({ id: 'income', caption: 'Income', first: labelOf(g.options, g.value), specs, rows, totals: obj(b.totals), head: labelCell })),
      { t: 'note', text: 'Income = invoices issued (incl. VAT/other tax) minus credit notes. Cash collected is shown separately.' },
      { t: 'note', text: 'Matches the sales register and credit-note register for the same dates.' }],
  };
}

function departmentIncome(b: Json, { q }: Ctx): Built {
  const g = radio(q, 'group_by', 'Group by', opts(['department', 'Department'], ['department_ad_month', 'Department × A.D. month'], ['department_bs_month', 'Department × B.S. month']), 'department');
  const specs: Spec[] = [['Billed lines', 'line_count', 'int'], ['Gross', 'gross_paisa', 'money'], ['Discount', 'discount_paisa', 'money'], ['Net sales', 'net_paisa', 'money'], ['Share', 'share_bp', 'bp']];
  const head = (r: Json) => t(r.is_multiple === true ? 'Multiple departments' : name(r) + (str(r.period_key) ? ` · ${str(r.period_key)}` : ''));
  return {
    title: 'Department income', controls: [g], groupLabel: labelOf(g.options, g.value),
    sections: [
      ...(b.reconciles_with_income === false ? [{ t: 'banner', tone: 'warning', title: 'Department totals do not match income for this period. The team has been alerted.' } as Section] : []),
      T(table({ id: 'department-income', caption: 'Department income', first: 'Department', specs, rows: arr(b.rows), totals: obj(b.totals), head })),
    ],
  };
}

function collections(b: Json, { q, o }: Ctx): Built {
  const g = radio(q, 'group_by', 'Group by', opts(['method', 'Method'], ['staff', 'Staff'], ['staff_method', 'Staff × method'], ['centre', 'Centre'], ...MONTH_TAIL), 'method');
  const methods = (o?.payment_methods ?? []).map((m) => ({ value: str(m.code), label: str(m.display) || str(m.code) })).filter((m) => m.value);
  const specs: Spec[] = [['Payments', 'entries', 'int'], ['Reversals', 'reversals', 'int'], ['Collected', 'gross_collected_paisa', 'money'], ['Reversed/refunded', 'reversed_paisa', 'money'], ['Net collected', 'net_collected_paisa', 'money']];
  return {
    title: 'Collections history', controls: [g, ...multi(q, 'payment_method_code', 'Method', methods)], groupLabel: labelOf(g.options, g.value),
    sections: [T(table({ id: 'collections', caption: 'Collections', first: labelOf(g.options, g.value), specs, rows: arr(b.rows), totals: obj(b.totals), head: labelCell })),
      { t: 'note', text: 'Cash basis — includes payments of earlier invoices; differs from income.' }],
  };
}

function volume(b: Json, { q }: Ctx): Built {
  const g = radio(q, 'group_by', 'Group by', DAY_OPTS, 'day');
  const specs: Spec[] = [['Orders', 'orders_registered', 'int'], ['Cancelled', 'orders_cancelled', 'int'], ['Net orders', 'net_orders', 'int'], ['Patient visits', 'patient_visits', 'int'], ['New patients', 'new_patients', 'int'], ['Urgent', 'urgent_orders', 'int'], ['OPD', 'opd_orders', 'int'], ['IPD', 'ipd_orders', 'int'], ['Tests ordered', 'tests_ordered', 'int']];
  return { title: 'Volume', controls: [g], groupLabel: labelOf(g.options, g.value), sections: [T(table({ id: 'volume', caption: 'Volume', first: labelOf(g.options, g.value), specs, rows: arr(b.rows), totals: obj(b.totals), head: labelCell }))] };
}

const rankTable = (a: { id: string; caption: string; who: string; specs: Spec[]; rows: Json[]; totals: Json; head: (r: Json) => Cell }): TableVM => ({
  id: a.id, caption: a.caption, rowHeader: 1,
  columns: [{ id: 'rank', header: 'Rank', align: 'end' }, { id: 'who', header: a.who }, ...a.specs.map(([header, key], i) => ({ id: `${i}:${key}`, header, align: 'end' as const }))],
  rows: a.rows.map((r, i) => ({ id: `${i}:${num(r.rank) ?? ''}`, cells: [c('int', r.rank), a.head(r), ...a.specs.map(([, key, kind]) => c(kind, r[key]))] })),
  ...(a.rows.length > 0 ? { total: [t(''), t('Total'), ...a.specs.map(([, key, kind]) => c(kind, a.totals[key]))] } : {}),
});

function topReferrers(b: Json, { q }: Ctx): Built {
  // volume only: no money column exists (D-44)
  const specs: Spec[] = [['Orders', 'orders', 'int'], ['Patient visits', 'patient_visits', 'int'], ['Tests ordered', 'tests_ordered', 'int']];
  const head = (r: Json) => t(r.is_self === true ? 'SELF (no referrer)' : name(r));
  return {
    title: 'Top referrers',
    controls: [select(q, 'sort', 'Sort', opts(['-orders', 'Orders'], ['-patient_visits', 'Patient visits'], ['-tests_ordered', 'Tests ordered']), '-orders'),
      select(q, 'limit', 'Limit', opts(['10', '10'], ['20', '20'], ['50', '50'], ['100', '100']), '20'),
      { type: 'referrers', id: 'referrer_id', label: 'Referrer', value: list(q, 'referrer_id') },
      { type: 'switch', id: 'rollup', label: 'Combine merged doctors', on: q.get('rollup') !== 'none', offValue: 'none' }],
    sections: [T(rankTable({ id: 'top-referrers', caption: 'Top referrers', who: 'Referrer', specs, rows: arr(b.rows), totals: obj(b.totals), head }))],
  };
}

/** S4 (04-UI-UX §5). Volume plus Net billed only: no rate/amount-payable/pay column exists; the SELF row has no Net billed ("—"). */
function referral(b: Json, { q }: Ctx): Built {
  const g = radio(q, 'group_by', 'Group by', opts(['referrer', 'Referrer'], ['referrer_ad_month', 'Referrer × A.D. month'], ['referrer_bs_month', 'Referrer × B.S. month']), 'referrer');
  const monthly = g.value !== 'referrer';
  const rows = arr(b.rows);
  const totals = obj(b.totals);
  const next = str(obj(b.page).next_cursor);
  const nums: Spec[] = [['Orders', 'orders', 'int'], ['Patient visits', 'patient_visits', 'int'], ['Tests ordered', 'tests_ordered', 'int'], ['Net billed', 'net_billed_paisa', 'money']];
  const vm: TableVM = {
    id: 'referral', caption: 'Referral business report',
    columns: [{ id: 'who', header: 'Referrer' }, ...(monthly ? [{ id: 'period', header: 'Period' }] : []), ...nums.map(([header, key]) => ({ id: key, header, align: 'end' as const }))],
    rows: rows.map((r, i) => ({
      id: `${i}:${str(r.referrer_id)}:${str(r.period_key)}`,
      cells: [t(r.is_self === true ? 'SELF (no referrer)' : name(r)), ...(monthly ? [t(str(r.period_label) || str(r.period_key) || '—')] : []), ...nums.map(([, key, kind]) => c(kind, r[key]))],
    })),
    ...(rows.length > 0 ? { total: [t('Total'), ...(monthly ? [t('')] : []), ...nums.map(([, key, kind]) => c(kind, totals[key]))] } : {}),
    ...(next || q.has('cursor') ? { pager: { ...(next ? { next } : {}), hasPrevious: q.has('cursor'), limit: 50 } } : {}),
  };
  return {
    title: 'Referral business report', groupLabel: labelOf(g.options, g.value),
    controls: [g, { type: 'switch', id: 'rollup', label: 'Combine merged doctors', on: q.get('rollup') !== 'none', offValue: 'none' }],
    sections: [
      { t: 'note', text: 'Orders and billing by referring doctor. For internal review only.' },
      T(vm),
      { t: 'note', text: 'Net billed counts credit-party work on the day it was charged.' },
      { t: 'note', text: 'Viewing this report is recorded.' },
    ],
  };
}

function topCentres(b: Json, { q }: Ctx): Built {
  const modes: [string, string][] = [['Walk-in', 'walk_in'], ['Home', 'home'], ['Centre', 'centre'], ['Partner', 'partner']];
  const tail: Spec[] = [['Patient visits', 'patient_visits', 'int'], ['Tests ordered', 'tests_ordered', 'int'], ['Net sales', 'net_sales_paisa', 'money']];
  const rows = arr(b.rows);
  const totals = obj(b.totals);
  const vm: TableVM = {
    id: 'top-centres', caption: 'Top centres', rowHeader: 1,
    columns: [{ id: 'rank', header: 'Rank', align: 'end' }, { id: 'who', header: 'Centre' }, { id: 'orders', header: 'Orders', align: 'end' },
      ...modes.map(([header, key]) => ({ id: `mode:${key}`, header, align: 'end' as const })), ...tail.map(([header, key]) => ({ id: key, header, align: 'end' as const }))],
    rows: rows.map((r, i) => ({ id: `${i}:${num(r.rank) ?? ''}`, cells: [c('int', r.rank), t(name(r)), c('int', r.orders), ...modes.map(([, k]) => c('int', obj(r.by_mode)[k])), ...tail.map(([, k, kind]) => c(kind, r[k]))] })),
    ...(rows.length > 0 ? { total: [t(''), t('Total'), c('int', totals.orders), ...modes.map(() => c('int', undefined)), ...tail.map(([, k, kind]) => c(kind, totals[k]))] } : {}),
  };
  return {
    title: 'Top centres',
    controls: [select(q, 'sort', 'Sort', opts(['-orders', 'Orders'], ['-net_sales_paisa', 'Net sales'], ['-patient_visits', 'Patient visits'], ['-tests_ordered', 'Tests ordered']), '-orders'),
      select(q, 'limit', 'Limit', opts(['10', '10'], ['20', '20'], ['50', '50']), '20')],
    sections: [T(vm)],
  };
}

function testsDone(b: Json, { q, o }: Ctx): Built {
  const g = radio(q, 'group_by', 'Group by', opts(['department', 'Department'], ['test', 'Test'], ['processing_branch', 'Processing branch'], ...MONTH_TAIL), 'department');
  const specs: Spec[] = [['Resulted', 'results_resulted', 'int'], ['Verified', 'results_verified', 'int'], ['Approved', 'results_approved', 'int'], ['Amended', 'results_amended', 'int'], ['Auto-verified', 'auto_verified', 'int'], ['Critical', 'critical_count', 'int'], ['Abnormal', 'abnormal_count', 'int'], ['Tests completed', 'tests_approved', 'int']];
  const dept = (o?.departments ?? []).map((d) => ({ value: d.id, label: d.label }));
  const br = (o?.branches ?? []).map((d) => ({ value: d.id, label: d.label }));
  return {
    title: 'Tests done', groupLabel: labelOf(g.options, g.value),
    controls: [g, ...multi(q, 'department_id', 'Department', dept), ...multi(q, 'processing_branch_id', 'Processing branch', br)],
    sections: [{ t: 'text', text: 'Results (analyte level)' }, T(table({ id: 'tests-done', caption: 'Tests done', first: labelOf(g.options, g.value), specs, rows: arr(b.rows), totals: obj(b.totals), head: labelCell }))],
  };
}

function tat(b: Json, { q, o }: Ctx): Built {
  const g = radio(q, 'group_by', 'Group by', opts(['none', 'None'], ['centre', 'Centre'], ['processing_branch', 'Processing branch'], ['priority', 'Priority'], ['specimen_type', 'Specimen type'], ...MONTH_TAIL), 'none');
  const segOpts = SEG.map(([value, label]) => ({ value, label }));
  const picked = list(q, 'segment').filter((s) => SEG.some((x) => x[0] === s));
  const label = (s: string) => SEG.find((x) => x[0] === s)?.[1] ?? s.replace(/_/g, ' ');
  const vm: TableVM = {
    id: 'tat', caption: 'Turnaround time (TAT)',
    columns: [{ id: 'segment', header: 'Segment' }, { id: 'group', header: 'Group' }, { id: 'n', header: 'Samples (n)', align: 'end' }, { id: 'median', header: 'Median', align: 'end' }, { id: 'p90', header: '90th percentile', align: 'end' }, { id: 'max', header: 'Max', align: 'end' }, { id: 'anomalies', header: 'Excluded (anomalies)', align: 'end' }],
    rows: arr(b.rows).map((r, i) => {
      const empty = (num(r.n) ?? 0) === 0; // n = 0 -> "—" in the statistic columns, never 0 or blank
      return { id: `${i}:${str(r.segment)}:${str(r.key)}`, cells: [t(label(str(r.segment))), t(str(r.label)), c('int', r.n), c('dur', empty ? undefined : r.median_seconds), c('dur', empty ? undefined : r.p90_seconds), c('dur', empty ? undefined : r.max_seconds), c('int', r.anomalies)] };
    }),
  };
  const sp = (o?.specimen_types ?? []).map((s) => ({ value: str(s.code), label: str(s.display) || str(s.code) })).filter((s) => s.value);
  const br = (o?.branches ?? []).map((d) => ({ value: d.id, label: d.label }));
  return {
    title: 'Turnaround time (TAT)', groupLabel: labelOf(g.options, g.value),
    controls: [{ type: 'checks', id: 'segment', label: 'Segments', options: segOpts, value: picked.length ? picked : segOpts.map((x) => x.value) },
      select(q, 'priority', 'Priority', opts(['all', 'All'], ['routine', 'Routine'], ['urgent', 'Urgent']), 'all'),
      ...multi(q, 'specimen_type_code', 'Specimen type', sp), ...multi(q, 'processing_branch_id', 'Processing branch', br), g],
    sections: [
      { t: 'dl', items: SEG.map(([, l, from, to]) => ({ term: l, value: `${from} → ${to}` })) },
      T(vm),
      { t: 'note', text: 'Server times are used, not analyser clocks.' },
      { t: 'note', text: 'Priority and specimen-type filters apply to sample segments only.' },
    ],
  };
}

function pending(items: Json, { q, o, summary }: Ctx): Built {
  const s = obj(summary);
  const depts = new Map<string, string>([...(o?.departments ?? []).map((d) => [d.id, d.label] as const), ...arr(s.by_department).map((d) => [str(d.department_id), str(d.label)] as const)]);
  const centres = new Map((o?.centres ?? []).map((x) => [x.id, x.label] as const));
  const idCell = (m: Map<string, string>, id: unknown): Cell => { const k = str(id); return m.get(k) ? t(m.get(k)!) : k ? { k: 'id', v: k } : t('—'); };
  const openHref = (r: Json) => (r.open_route_id === 'staff.lab.order_results' && UUID.test(str(r.order_id)) ? `/lab/orders/${str(r.order_id)}/results` : undefined);
  const data = arr(items.data);
  const page = obj(items.page);
  const vm: TableVM = {
    id: 'pending', caption: 'Pending tests',
    columns: [{ id: 'dept', header: 'Department' }, { id: 'test', header: 'Test' }, { id: 'priority', header: 'Priority' }, { id: 'status', header: 'Status' }, { id: 'centre', header: 'Centre' }, { id: 'age', header: 'Age', align: 'end' }, { id: 'target', header: 'Target', align: 'end' }, { id: 'overdue', header: 'Overdue' }],
    rows: data.map((r, i) => {
      const href = openHref(r);
      return {
        id: `${i}:${str(r.order_item_id)}`,
        cells: [idCell(depts, r.department_id), { k: 'text', v: `${str(r.test_code)} — ${str(r.test_label)}`, ...(href ? { open: href } : {}) },
          r.priority === 'urgent' ? { k: 'badge', v: 'Urgent', tone: 'warning' } : t(cap(str(r.priority))), t(STATUS[str(r.item_status)] ?? str(r.item_status).replace(/_/g, ' ')),
          idCell(centres, r.centre_id), c('dur', r.age_seconds), c('dur', r.tat_target_seconds), t(r.is_overdue === true ? 'Overdue' : '')],
      };
    }),
    pager: { ...(str(page.next_cursor) ? { next: str(page.next_cursor) } : {}), hasPrevious: q.has('cursor'), limit: 50 },
  };
  const byDept = arr(s.by_department);
  const bl = obj(s.backlog);
  const n = (v: unknown) => String(num(v) ?? '—');
  const dep = (o?.departments ?? []).map((d) => ({ value: d.id, label: d.label }));
  const br = (o?.branches ?? []).map((d) => ({ value: d.id, label: d.label }));
  return {
    title: 'Pending tests',
    controls: [...multi(q, 'department_id', 'Department', dep), select(q, 'priority', 'Priority', opts(['all', 'All'], ['routine', 'Routine'], ['urgent', 'Urgent']), 'all'),
      ...multi(q, 'item_status', 'Status', Object.entries(STATUS).map(([value, label]) => ({ value, label }))),
      { type: 'switch', id: 'overdue_only', label: 'Overdue only', on: q.get('overdue_only') === 'true', onValue: 'true' },
      ...multi(q, 'processing_branch_id', 'Processing branch', br),
      select(q, 'sort', 'Sort', opts(['-age_seconds', 'Oldest first'], ['age_seconds', 'Newest first']), '-age_seconds')],
    sections: [
      { t: 'tiles', items: [{ label: 'Pending', value: n(s.total) }, { label: 'Overdue', value: n(s.overdue) }, { label: 'No TAT target', value: n(s.no_target) }] },
      { t: 'card', title: 'Reports pending', items: [{ term: 'Reports pending', value: n(bl.reports_pending) }, { term: 'Awaiting results', value: n(bl.awaiting_results) }, { term: 'Ready, not released', value: n(bl.ready_unreleased) }, ...arr(s.by_age_bucket).map((x) => ({ term: AGE[str(x.bucket)] ?? str(x.bucket), value: n(x.count) }))] },
      ...(byDept.length > 0 ? [{ t: 'chart', title: 'Pending tests by department', categories: byDept.map((d) => str(d.label)), series: [{ id: 'pending', label: 'Pending', values: byDept.map((d) => num(d.count) ?? 0) }, { id: 'overdue', label: 'Overdue', values: byDept.map((d) => num(d.overdue) ?? 0) }], format: 'integer' } as Section] : []),
      T(vm),
      { t: 'note', text: 'Age since receipt at the lab, or since registration if not yet received.' },
    ],
  };
}

function quality(b: Json, { q }: Ctx): Built {
  const g = radio(q, 'group_by', 'Group by', opts(['reason', 'Reason'], ['centre', 'Centre'], ['specimen_type', 'Specimen type'], ...MONTH_TAIL), 'reason');
  const rej = obj(b.rejections);
  const cv = obj(b.critical_values);
  const specs: Spec[] = [['Rejections', 'rejections', 'int'], ['Recollections ordered', 'recollections_ordered', 'int'], ['Specimens received', 'specimens_received', 'int'], ['Rejections per 100 received', 'per_100_received_bp', 'bp']];
  const cvRows = arr(cv.rows);
  const cvTot = obj(cv.totals);
  const cvTable: TableVM = {
    id: 'critical', caption: 'Critical values',
    columns: [{ id: 'date', header: 'Date' }, ...['Detected', 'Notified', 'Notified %', 'Median time to notify', 'Max time to notify'].map((header) => ({ id: header, header, align: 'end' as const }))],
    rows: cvRows.map((r, i) => ({ id: `${i}:${str(r.business_date)}`, cells: [t(str(r.business_date)), c('int', r.detected), c('int', r.notified), c('bp', r.notified_bp), c('dur', r.median_notify_seconds), c('dur', r.max_notify_seconds)] })),
    // medians are not additive: the summary row shows totals and the maximum only (US-12.2)
    ...(cvRows.length > 0 ? { total: [t('Total'), c('int', cvTot.detected), c('int', cvTot.notified), c('bp', cvTot.notified_bp), c('dur', undefined), c('dur', cvTot.max_notify_seconds)] } : {}),
  };
  const reason = (r: Json): Cell => t(g.value === 'reason' ? name({ ...r, label: str(r.label).replace(/_/g, ' ') }) : name(r));
  return {
    title: 'Quality indicators', groupLabel: labelOf(g.options, g.value), controls: [g],
    sections: [T(table({ id: 'rejections', caption: 'Rejections', first: labelOf(g.options, g.value), specs, rows: arr(rej.rows), totals: obj(rej.totals), head: reason })), T(cvTable), { t: 'note', text: 'Median is shown per day only.' }],
  };
}

function delivery(b: Json, { q }: Ctx): Built {
  const g = radio(q, 'group_by', 'Group by', opts(['channel', 'Channel'], ...MONTH_TAIL), 'channel');
  const d = obj(b.deliveries);
  const r = obj(b.releases);
  const dSpecs: Spec[] = [['Queued', 'queued', 'int'], ['Sent', 'sent', 'int'], ['Delivered', 'delivered', 'int'], ['Read', 'read', 'int'], ['Failed', 'failed', 'int'], ['Suppressed', 'suppressed', 'int'], ['Failure share', 'failure_share_bp', 'bp']];
  const rSpecs: Spec[] = [['Released', 'released', 'int'], ['Final', 'final', 'int'], ['Partial', 'partial', 'int'], ['Preliminary', 'preliminary', 'int'], ['Amended', 'amended', 'int'], ['Override releases', 'overrides', 'int']];
  return {
    title: 'Delivery', groupLabel: labelOf(g.options, g.value), controls: [g],
    sections: [
      T(table({ id: 'deliveries', caption: 'Deliveries', first: labelOf(g.options, g.value), specs: dSpecs, rows: arr(d.rows), totals: obj(d.totals), head: labelCell })),
      { t: 'note', text: 'Counted on the day each message was created; later status changes update that day.' },
      T(table({ id: 'releases', caption: 'Releases', first: g.value === 'channel' ? 'Day' : labelOf(g.options, g.value), specs: rSpecs, rows: arr(r.rows), totals: obj(r.totals), head: labelCell })),
    ],
  };
}

function interfaces(b: Json, { o, perms }: Ctx): Built {
  const centres = new Map((o?.centres ?? []).map((x) => [x.id, x.label] as const));
  const centre = (id: unknown): Cell => { const k = str(id); return centres.get(k) ? t(centres.get(k)!) : k ? { k: 'id', v: k } : t('—'); };
  const ag = obj(b.agents);
  const canLink = perms.includes('instruments.agent.read');
  const agentVM: TableVM = {
    id: 'agents', caption: 'Agents',
    columns: [{ id: 'agent', header: 'Agent' }, { id: 'centre', header: 'Centre' }, { id: 'state', header: 'State' }, { id: 'hb', header: 'Last heartbeat' }, { id: 'ver', header: 'Version' }, { id: 'queue', header: 'Queue', align: 'end' }],
    rows: arr(ag.agents).map((x, i) => {
      const id = str(x.agent_id);
      return { id: `${i}:${id}`, cells: [canLink && UUID.test(id) ? { k: 'link', v: short(id), href: `/instruments/agents/${id}` } : { k: 'id', v: id }, centre(x.centre_id), t(cap(str(x.state))), t(when(str(x.last_heartbeat_at))), t(str(x.agent_version)), c('int', x.queue_depth)] };
    }),
  };
  const specs: Spec[] = [['Messages', 'messages', 'int'], ['Patient records', 'patient_records', 'int'], ['QC records', 'qc_records', 'int'], ['Unmatched', 'unmatched', 'int'], ['Quarantined', 'quarantined', 'int'], ['Duplicates', 'duplicates', 'int']];
  const msgVM: TableVM = {
    id: 'messages', caption: 'Instrument messages',
    columns: [{ id: 'inst', header: 'Instrument' }, { id: 'centre', header: 'Centre' }, ...specs.map(([header, key]) => ({ id: key, header, align: 'end' as const }))],
    rows: arr(b.instruments).map((r, i) => {
      const id = str(r.instrument_id);
      const nm = str(r.label) ? str(r.label) + (r.is_active === false ? ' (inactive)' : '') + (str(r.instrument_code) ? ` · ${str(r.instrument_code)}` : '') : '';
      return { id: `${i}:${id}`, cells: [nm ? t(nm) : { k: 'id', v: id }, centre(r.centre_id), ...specs.map(([, k, kind]) => c(kind, r[k]))] };
    }),
  };
  return {
    title: 'Instrument interfaces', controls: [],
    sections: [{ t: 'card', title: 'Agents by state', items: arr(ag.by_state).map((s) => ({ term: cap(str(s.state)), value: String(num(s.count) ?? '—') })) }, T(agentVM), T(msgVM)],
  };
}

const BUILDERS: Record<string, (b: Json, x: Ctx) => Built> = {
  income, 'department-income': departmentIncome, collections, volume, 'top-referrers': topReferrers, 'top-centres': topCentres, 'referral-incentive': referral, 'tests-done': testsDone, tat,
  'pending-tests': pending, 'quality-indicators': quality, delivery, interfaces,
};

// ------------------------------------------------------------------ page
export interface PageArgs {
  def: ReportDef; body: Json; summary?: Json; q: URLSearchParams; options: FilterOptions | undefined; perms: Perms;
  tabs: PageVM['tabs']; hub: boolean; pdfEnabled: boolean; basePath: string; pageId: PageVM['pageId'];
}
export function buildPage(a: PageArgs): PageVM {
  const built = BUILDERS[a.def.slug]!(a.body, { q: a.q, o: a.options, perms: a.perms, ...(a.summary ? { summary: a.summary } : {}) });
  const env = a.def.slug === 'pending-tests' ? obj(a.summary) : a.body; // pending has no period; its freshness is the summary's
  const p = obj(env.period);
  const scope = obj(env.scope);
  const to = str(p.business_date_to);
  const scoped = a.def.scoped !== false; // tests-done: no Centre/Branch filters (the API takes neither)
  const centreOptions = scoped && (a.options?.centres ?? []).length > 1 ? (a.options!.centres!).map((x) => ({ value: x.id, label: x.label })) : [];
  const branchOptions = !scoped ? [] : (a.options?.branches ?? []).map((x) => ({ value: x.id, label: x.label }));
  const fresh: FreshnessVM[] = arr(env.freshness).map((f) => ({
    family: str(f.family), is_stale: f.is_stale === true, live: f.live === true,
    ...(str(f.refreshed_at) ? { refreshed_at: str(f.refreshed_at) } : {}),
    ...(['refresh_lagging', 'refresh_failed', 'never_refreshed'].includes(str(f.stale_reason)) ? { stale_reason: f.stale_reason as NonNullable<FreshnessVM['stale_reason']> } : {}),
  }));
  return {
    tab: a.def.slug, title: built.title, helpKey: `analytics.reports.${a.def.slug}`, pageId: a.pageId, basePath: a.basePath, tabs: a.tabs, query: a.q.toString(),
    ...(a.def.period && str(p.label_ad) ? { period: { labelAd: str(p.label_ad), labelBs: str(p.label_bs), timezone: str(p.timezone), from: str(p.business_date_from), to } } : {}),
    freshness: fresh, ...(str(env.generated_at) ? { generatedAt: str(env.generated_at) } : {}),
    scope: { all_centres: scope.all_centres !== false, centre_ids: [], tenant_wide_sections_hidden: Array.isArray(scope.tenant_wide_sections_hidden) ? scope.tenant_wide_sections_hidden.filter((x: unknown) => typeof x === 'string') : [] },
    controls: built.controls, centreOptions, branchOptions, canRefresh: a.perms.includes('analytics.dashboard.read'),
    ...(a.perms.includes('analytics.data.export') ? { export: { reportCode: a.def.code, pdfEnabled: a.pdfEnabled, ...(built.groupLabel ? { groupLabel: built.groupLabel } : {}) } } : {}),
    ...(a.def.slug === 'collections' && a.perms.includes('billing.cash_report.read') ? { link: { href: '/billing/daily-cash', label: "Today's cash report and session close" } } : {}),
    sections: built.sections,
  };
}
