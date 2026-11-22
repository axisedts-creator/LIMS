// T0D-BUILD-4 (LD-447; founder order 2026-11-22 13:36 NPT; closes CR item 8 of .orchestra/notes/T0D-MISREPORTS-1-cr-needed.md): the HTTP read of the MIS report
// definitions, operation getMisReportPage = GET /v1/analytics/mis-reports/{report_code}. Real handler (handlers/index.ts) over the T-15 emulators (t15.helpers.ts);
// the only data seam is service/misReports.service.ts runMisReport, replaced by an in-memory implementation that applies the same validators and the same keyset
// cursor as the real one (copied, see fakeRun). No database, no outside provider, synthetic data only.
// PINNED PICKS (the spec leaves them open; the writer may dispute through the reviewer, then the tests change with the ruling):
//   * request = { params: { report_code }, query: { business_date_from, business_date_to, centre_id?: string[], party_id?/representative_id?/referrer_id?/department_id?/collector_id?: string[],
//     visit_type?, min_repeat_count?, limit?: number, cursor?: string } }; the definition params are FLAT query names (the names ExportParams.filters uses); lists arrive parsed (form, explode false).
//   * response 200 = { columns: [{ key, label, kind }] (what runMisReport returns), rows (objects keyed by column key), totals: { <column key>: integer }, next_cursor? (absent or null on the last page) }.
//   * totals = sum over the WHOLE filtered set of every column of kind paisa (integer_paisa) and count (integer); NOT basis_points, not text; keys present with 0 on an empty result.
//     They are built from runMisReport (the existing seam: every page of the filtered set, <= row cap) so the handler adds no SQL of its own.
//   * gates in this order: permission of the report (assertRole; 403 auth.forbidden, aal1 -> 403 auth.mfa_required) -> tenant flag of the report (403 common.feature_disabled) -> input
//     (400 common.validation_failed / common.invalid_cursor, 404 analytics.report_unknown or common.not_found for a foreign centre) -> data. A refused request reads and writes nothing.
//   * the two money codes (two_level_commission, tds) write ONE access entry referral_report.view {entityType analytics_report, outcome allowed, detail.report_code, from, to} per served request
//     (never an amount, E4); the plain codes write none.
//   * a registered report code that has no MIS read (income, dashboard ...) -> LimsError operation_pending (the core renders 501); a code unknown to the registry -> 404 analytics.report_unknown.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LimsError, isLimsError } from '../../../../core/errors.js';
import { DEFS, MONEY_CODES, PLAIN_CODES, def } from '../../__tests__/misreports/contract.js';
import { A1, A2, B1, FINANCE, NO_PERM, OWNER, OWNER_A1, OWNER_AAL1, PARTNER, TA, db15, expectLims, makeCtx15, rejection, type Ctx15 } from './t15.helpers.js';

type Row = Record<string, string | number>;
type Args = { range: { from: string; to: string }; scope: { all: boolean; centreIds: readonly string[] }; filters?: any; limit?: unknown; cursor?: unknown };
const H = vi.hoisted(() => ({ impl: undefined as undefined | ((ctx: any, code: string, a: any) => Promise<any>), calls: [] as { ctx: any; code: string; args: any }[] }));

vi.mock('../../service/misReports.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../service/misReports.service.js')>();
  return { ...actual, runMisReport: vi.fn(async (ctx: any, code: string, args: any) => { H.calls.push({ ctx, code, args }); return H.impl!(ctx, code, args); }) };
});

// ------------------------------------------------------------------ the synthetic world (tenant A rows + one tenant B row that must never show)
const KIND: Record<string, string> = { string: 'text', date: 'text', datetime: 'text', integer: 'count', integer_paisa: 'paisa', basis_points: 'bp' };
interface Fact { tenant: string; day: string; centre: string; ord: number; values: Record<string, string | number> }
const fact = (code: string, tenant: string, day: string, centre: string, ord: number, values: Record<string, string | number>): [string, Fact] => [code, { tenant, day, centre, ord, values }];
const bill = (n: number, day: string, centre: string, ord: number, gross: number, discount: number, paid: number, tenant = TA): [string, Fact] => fact('bill_of_the_day', tenant, day, centre, ord, {
  invoice_id: `01a1a98a-ac40-7000-8000-0000000b${String(n).padStart(4, '0')}`, invoice_number: `INV-${n}`, billed_at: `${day}T0${ord % 9}:00:00.000Z`, business_date: day,
  centre_id: centre, party_id: '', gross_paisa: gross, discount_paisa: discount, net_paisa: gross - discount, paid_paisa: paid, due_paisa: gross - discount - paid,
});
const FACTS: [string, Fact][] = [
  bill(1, '2026-11-17', A1, 9, 150_000, 5_000, 145_000), bill(2, '2026-11-17', A1, 8, 80_000, 0, 40_000), bill(3, '2026-11-17', A2, 7, 123_456_789, 0, 100_000_000), bill(4, '2026-11-17', A1, 6, 25_000, 0, 25_000),
  bill(5, '2026-11-18', A2, 5, 10_000, 0, 0),
  bill(900, '2026-11-17', B1, 9, 999_999_999, 0, 999_999_999, 'tenant-b'),                       // another tenant, same day: never visible
  ...Array.from({ length: 55 }, (_, i) => bill(100 + i, '2026-12-01', A1, 100 - i, 1_000, 0, 1_000)),
  fact('party_billing', TA, '2026-11-17', A1, 3, { party_id: 'p1', party_name: 'Synthetic Party One', billing_mode: 'credit', orders_registered: 4, gross_paisa: 400_000, discount_paisa: 10_000, net_paisa: 390_000, paid_paisa: 100_000, outstanding_paisa: 290_000 }),
  fact('party_billing', TA, '2026-11-17', A1, 2, { party_id: 'p2', party_name: 'Synthetic Party Two', billing_mode: 'cash', orders_registered: 6, gross_paisa: 600_000, discount_paisa: 0, net_paisa: 600_000, paid_paisa: 600_000, outstanding_paisa: 0 }),
  fact('party_billing', TA, '2026-11-17', A2, 1, { party_id: 'p3', party_name: 'Synthetic Party Three', billing_mode: 'credit', orders_registered: 2, gross_paisa: 50_000, discount_paisa: 0, net_paisa: 50_000, paid_paisa: 0, outstanding_paisa: 50_000 }),
  fact('two_level_commission', TA, '2026-11-17', A1, 2, { parent_party_id: 'pp1', parent_party_name: 'Synthetic Parent', party_id: 'p1', party_name: 'Synthetic Sub', level: 1, orders_registered: 5, net_billed_paisa: 500_000, commission_bp: 1_000, commission_paisa: 50_000 }),
  fact('two_level_commission', TA, '2026-11-17', A1, 1, { parent_party_id: 'pp1', parent_party_name: 'Synthetic Parent', party_id: 'p2', party_name: 'Synthetic Sub Two', level: 2, orders_registered: 3, net_billed_paisa: 300_000, commission_bp: 1_500, commission_paisa: 45_000 }),
  fact('tds', TA, '2026-11-17', A1, 2, { party_id: 'p2', party_name: 'Synthetic Party Two', period_from: '2026-11-17', period_to: '2026-11-17', commission_payable_paisa: 30_000, tds_bp: 1_500, tds_withheld_paisa: 4_500, net_payable_paisa: 25_500 }), // ruling: 2 tds rows so limit 1 has a page 2
  fact('tds', TA, '2026-11-17', A1, 1, { party_id: 'p1', party_name: 'Synthetic Party One', period_from: '2026-11-17', period_to: '2026-11-17', commission_payable_paisa: 50_000, tds_bp: 1_500, tds_withheld_paisa: 7_500, net_payable_paisa: 42_500 }),
];

const cursorOf = (code: string, rank: number) => Buffer.from(JSON.stringify({ c: code, r: rank })).toString('base64url'); // same encoding as misReports.service.ts
function rankOf(code: string, v: unknown): number {
  if (v === undefined) return 0;
  try {
    if (typeof v !== 'string' || v.length > 200) throw new Error('bad');
    const c = JSON.parse(Buffer.from(v, 'base64url').toString('utf8'));
    if (c?.c !== code || !Number.isSafeInteger(c?.r) || c.r < 1) throw new Error('bad');
    return c.r as number;
  } catch { throw new LimsError('common.invalid_cursor'); }
}
H.impl = async (ctx, code, a: Args) => {
  const { checkMisRange, checkMisFilters } = await import('../../service/misReports.service.js');
  const d = def(code);
  const range = checkMisRange(a.range); checkMisFilters(code, a.filters);
  const limit = a.limit === undefined ? 100 : a.limit;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 1000) throw new LimsError('common.validation_failed');
  const after = rankOf(code, a.cursor);
  const wanted: string[] | undefined = a.filters?.centre_id;
  const all = FACTS.filter(([c, f]) => c === code && f.tenant === ctx.tenantId && f.day >= range.from && f.day <= range.to && (a.scope.all || a.scope.centreIds.includes(f.centre)) && (!wanted || wanted.includes(f.centre)))
    .map(([, f]) => f).sort((x, y) => y.ord - x.ord);
  const rows: Row[] = all.map((f) => Object.fromEntries(d.columns.map((c) => [c.name, f.values[c.name] ?? (c.type === 'string' || c.type === 'date' || c.type === 'datetime' ? '' : 0)])));
  const page = rows.slice(after, after + limit);
  return { columns: d.columns.map((c) => ({ key: c.name, label: c.title, kind: KIND[c.type] })), rows: page, ...(after + limit < rows.length ? { next_cursor: cursorOf(code, after + limit) } : {}) };
};

// ------------------------------------------------------------------ helpers
beforeEach(() => { db15.reset(); vi.clearAllMocks(); H.calls.length = 0; });

type Query = Record<string, unknown>;
const Q1 = { business_date_from: '2026-11-17', business_date_to: '2026-11-17' };
async function call(c: Ctx15, code: string, query: Query = Q1) {
  const { handlers } = await import('../index.js');
  c.ctx.operationId = 'getMisReportPage';
  return (handlers as any).getMisReportPage({ params: { report_code: code }, query, headers: {}, body: undefined }, c.ctx);
}
async function ok(c: Ctx15, code: string, query: Query = Q1): Promise<any> {
  const r = await call(c, code, query);
  if (r.status !== 200) throw new Error(`expected 200, got ${r.status}`);
  return r.body;
}
const codeOf = async (p: Promise<unknown>) => ((await rejection(p)) as any)?.code as string | undefined;
const denyOnly = (c: Ctx15, permission: string) => c.assertRole.mockImplementation(async (_c: unknown, rq: { permission: string }) => { if (rq.permission === permission) throw new LimsError('auth.forbidden'); });
const sumOf = (rows: Row[], k: string) => rows.reduce((a, r) => a + Number(r[k]), 0);
const untouched = (c: Ctx15) => { expect(H.calls).toEqual([]); expect(c.entries).toEqual([]); expect(c.accessRows).toEqual([]); };
const botdRows = (day: string, tenant = TA) => FACTS.filter(([code, f]) => code === 'bill_of_the_day' && f.tenant === tenant && f.day === day).map(([, f]) => f).sort((x, y) => y.ord - x.ord);

// ================================================================================================================ wiring
describe('getMisReportPage is served by a real handler (not the stub)', () => {
  it('handlers.getMisReportPage exists and answers 200 for a holder', async () => {
    const { handlers } = await import('../index.js');
    expect(typeof (handlers as any).getMisReportPage, 'operation getMisReportPage in handlers/index.ts').toBe('function');
    const c = await makeCtx15(OWNER, { flag: true });
    const r = await call(c, 'bill_of_the_day');
    expect(r.status).toBe(200);
  });
  it('the body carries columns, rows, totals; columns are the contract columns in contract order', async () => {
    const c = await makeCtx15(OWNER, { flag: true });
    const b = await ok(c, 'bill_of_the_day');
    expect(Object.keys(b)).toEqual(expect.arrayContaining(['columns', 'rows', 'totals']));
    expect(b.columns).toEqual(def('bill_of_the_day').columns.map((x) => ({ key: x.name, label: x.title, kind: KIND[x.type] })));
    expect(b.rows).toHaveLength(4);
    expect(Object.keys(b.rows[0])).toEqual(def('bill_of_the_day').columns.map((x) => x.name));
  });
});

// ================================================================================================================ permission first (REQ-SEC-062/067)
describe('getMisReportPage: the permission check comes first; a refused request reads and writes nothing', () => {
  it.each([['no permission', NO_PERM], ['partner', PARTNER]])('%s -> 403 auth.forbidden before the query is looked at (even garbage input)', async (_n, who) => {
    const c = await makeCtx15(who, { flag: true });
    await expectLims(call(c, 'bill_of_the_day', { business_date_from: 'garbage', limit: -5, cursor: '<script>' }), 'auth.forbidden', 403);
    untouched(c);
  });
  it.each(DEFS.map((d) => [d.code, d.permission] as const))('%s: asks the permission of its definition (%s); without it -> 403, nothing read, nothing logged', async (code, permission) => {
    const c = await makeCtx15(OWNER, { flag: true });
    await ok(c, code);
    expect(c.assertRole.mock.calls.map((x: any) => x[1].permission), 'permission asked').toContain(permission);
    H.calls.length = 0;
    const d = await makeCtx15(OWNER, { flag: true });
    denyOnly(d, permission);
    await expectLims(call(d, code), 'auth.forbidden', 403);
    untouched(d);
  });
  it('a finance user (collections.read only) reads Bill of the Day but not a dashboard.read report', async () => {
    const c = await makeCtx15(FINANCE, { flag: true });
    await ok(c, 'bill_of_the_day');
    const d = await makeCtx15(FINANCE, { flag: true });
    await expectLims(call(d, 'consultant'), 'auth.forbidden', 403);
    expect(H.calls.filter((x) => x.code === 'consultant')).toEqual([]);
  });
});

// ================================================================================================================ the A39 gate of the two money codes
describe.each(MONEY_CODES)('%s (A39 / LD-342): flag + analytics.referral_report.read + aal2 + access log referral_report.view', (code) => {
  it('flag on, aal2, permission held -> 200 and ONE referral_report.view entry with the report code, dates, no amount', async () => {
    const c = await makeCtx15(OWNER, { flag: true });
    const b = await ok(c, code);
    expect(b.rows.length).toBeGreaterThan(0);
    expect(c.assertRole.mock.calls.map((x: any) => x[1].permission)).toContain('analytics.referral_report.read');
    const views = c.entries.filter((e: any) => e.action === 'referral_report.view');
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({ entityType: 'analytics_report', outcome: 'allowed' });
    expect(views[0].detail).toMatchObject({ report_code: code, from: Q1.business_date_from, to: Q1.business_date_to });
    expect(JSON.stringify(c.entries)).not.toMatch(/commission_paisa|tds_withheld|net_payable|"\d{5,}"/);
  });
  it('each served page writes its own entry (page 2 too)', async () => {
    const c = await makeCtx15(OWNER, { flag: true });
    const p1 = await ok(c, code, { ...Q1, limit: 1 });
    expect(p1.next_cursor).toBeTruthy();
    await ok(c, code, { ...Q1, limit: 1, cursor: p1.next_cursor });
    expect(c.entries.filter((e: any) => e.action === 'referral_report.view')).toHaveLength(2);
  });
  it.each([undefined, false])('flag %s -> 403 common.feature_disabled; nothing read, nothing logged', async (flag) => {
    const c = await makeCtx15(OWNER, flag === undefined ? {} : { flag });
    await expectLims(call(c, code), 'common.feature_disabled', 403);
    untouched(c);
  });
  it.each([undefined, true])('aal1 (flag %s) -> 403 auth.mfa_required; nothing read, nothing logged', async (flag) => {
    const c = await makeCtx15(OWNER_AAL1, flag === undefined ? {} : { flag });
    await expectLims(call(c, code), 'auth.mfa_required', 403);
    untouched(c);
  });
  it('without analytics.referral_report.read -> 403 auth.forbidden; nothing read, nothing logged', async () => {
    const c = await makeCtx15(OWNER, { flag: true });
    denyOnly(c, 'analytics.referral_report.read');
    await expectLims(call(c, code), 'auth.forbidden', 403);
    untouched(c);
  });
  it('the flag of ANOTHER tenant does not open it', async () => {
    const c = await makeCtx15(OWNER, { flagOtherTenant: true });
    await expectLims(call(c, code), 'common.feature_disabled', 403);
    untouched(c);
  });
  it('a failing access log fails the request (no unlogged money read)', async () => {
    await ok(await makeCtx15(OWNER, { flag: true }), code); // the same request is served when the log works
    const c = await makeCtx15(OWNER, { flag: true, accessFails: true });
    const e: any = await rejection(call(c, code));
    expect(e).toBeTruthy();
    expect(e).not.toBeInstanceOf(TypeError);
  });
});

describe('plain codes need no flag and write no referral_report.view', () => {
  it.each(PLAIN_CODES)('%s: flag off -> 200, no access entry', async (code) => {
    const c = await makeCtx15(OWNER, {});
    const b = await ok(c, code);
    expect(Array.isArray(b.rows)).toBe(true);
    expect(c.entries.filter((e: any) => e.action === 'referral_report.view')).toEqual([]);
  });
});

// ================================================================================================================ report code
describe('report_code', () => {
  it.each(['no_such_report', '__proto__', 'constructor', 'INCOME', ''])('unknown code %j -> 404 analytics.report_unknown; nothing read, nothing logged', async (code) => {
    const c = await makeCtx15(OWNER, { flag: true });
    const got = await codeOf(call(c, code));
    expect(got).toBe('analytics.report_unknown');
    untouched(c);
  });
  it.each(['income', 'dashboard', 'collections', 'referral_incentive'])('registered report %s has no MIS read -> operation_pending (the core renders 501), nothing read', async (code) => {
    const c = await makeCtx15(OWNER, { flag: true });
    const e: any = await rejection(call(c, code));
    expect(isLimsError(e, 'operation_pending'), `thrown ${e?.code}`).toBe(true);
    expect(H.calls).toEqual([]);
  });
});

// ================================================================================================================ range and input
describe('range and input: typed 4xx, never 500', () => {
  it.each([
    ['367 days', { business_date_from: '2024-01-01', business_date_to: '2025-01-01' }],
    ['to before from', { business_date_from: '2026-11-18', business_date_to: '2026-11-17' }],
    ['impossible date', { business_date_from: '2026-13-40', business_date_to: '2026-11-17' }],
    ['no end', { business_date_from: '2026-11-17' }],
    ['no start', { business_date_to: '2026-11-17' }],
    ['no dates', {}],
    ['not a string', { business_date_from: 20261117, business_date_to: 20261117 }],
  ])('%s -> 400 common.validation_failed', async (_n, query) => {
    const c = await makeCtx15(OWNER, { flag: true });
    await expectLims(call(c, 'bill_of_the_day', query as Query), 'common.validation_failed', 400);
    expect(c.accessRows).toEqual([]);
  });
  it('one day (from == to) and exactly 366 days are accepted', async () => {
    const c = await makeCtx15(OWNER, { flag: true });
    await ok(c, 'bill_of_the_day', Q1);
    await ok(c, 'bill_of_the_day', { business_date_from: '2024-01-01', business_date_to: '2024-12-31' });
  });
  it.each([0, -1, 201, 1.5, 'abc', null])('limit %j -> 400 common.validation_failed (1..200)', async (limit) => {
    const c = await makeCtx15(OWNER, { flag: true });
    await expectLims(call(c, 'bill_of_the_day', { ...Q1, limit }), 'common.validation_failed', 400);
  });
  it('hostile filter values and filters the report does not list -> 400 common.validation_failed', async () => {
    for (const [code, extra] of [['bill_of_the_day', { party_id: ["'; DROP TABLE billing.invoices; --"] }], ['bill_of_the_day', { party_id: Array.from({ length: 21 }, () => '01a1a98a-ac40-7000-8000-000000000201') }],
      ['repeated_patient', { party_id: ['01a1a98a-ac40-7000-8000-000000000201'] }], ['ipd_opd', { visit_type: 'icu' }], ['repeated_patient', { min_repeat_count: 1 }], ['repeated_patient', { min_repeat_count: 'two' }]] as [string, Query][]) {
      const c = await makeCtx15(OWNER, { flag: true });
      await expectLims(call(c, code, { ...Q1, ...extra }), 'common.validation_failed', 400);
    }
  });
  it('a valid party filter reaches the report as filters.party_id', async () => {
    const c = await makeCtx15(OWNER, { flag: true });
    const id = '01a1a98a-ac40-7000-8000-000000000201';
    await ok(c, 'bill_of_the_day', { ...Q1, party_id: [id] });
    expect(H.calls.at(-1)!.args.filters.party_id).toEqual([id]);
  });
});

// ================================================================================================================ paging
describe('paging (opaque cursor)', () => {
  it('two pages of 2 over 4 rows: page 1 has a cursor, page 2 the rest and no cursor; no row twice, none lost, order kept', async () => {
    const c = await makeCtx15(OWNER, { flag: true });
    const p1 = await ok(c, 'bill_of_the_day', { ...Q1, limit: 2 });
    expect(p1.rows.map((r: Row) => r.invoice_number)).toEqual(['INV-1', 'INV-2']);
    expect(typeof p1.next_cursor).toBe('string');
    const p2 = await ok(c, 'bill_of_the_day', { ...Q1, limit: 2, cursor: p1.next_cursor });
    expect(p2.rows.map((r: Row) => r.invoice_number)).toEqual(['INV-3', 'INV-4']);
    expect(p2.next_cursor ?? null).toBeNull();
  });
  it('default limit is 50 and limit 200 is allowed: 55 rows -> 50 + cursor, or all 55 without cursor', async () => {
    const c = await makeCtx15(OWNER, { flag: true });
    const day = { business_date_from: '2026-12-01', business_date_to: '2026-12-01' };
    const d = await ok(c, 'bill_of_the_day', day);
    expect(d.rows).toHaveLength(50);
    expect(d.next_cursor).toBeTruthy();
    const w = await ok(c, 'bill_of_the_day', { ...day, limit: 200 });
    expect(w.rows).toHaveLength(55);
    expect(w.next_cursor ?? null).toBeNull();
  });
  it.each(['not-a-cursor!!', '<script>alert(1)</script>', 'e30', 'x'.repeat(500), '', Buffer.from(JSON.stringify({ c: 'party_billing', r: 1 })).toString('base64url')])(
    'bad or foreign cursor %j -> 400 common.invalid_cursor; no access entry', async (cursor) => {
      const c = await makeCtx15(OWNER, { flag: true });
      await expectLims(call(c, 'bill_of_the_day', { ...Q1, cursor }), 'common.invalid_cursor', 400);
      expect(c.accessRows).toEqual([]);
    });
});

// ================================================================================================================ totals
describe('totals: over the whole filtered set, not the page', () => {
  it('bill_of_the_day: every paisa column summed over all 4 rows although the page has 2; same totals on page 2', async () => {
    const c = await makeCtx15(OWNER, { flag: true });
    const all = botdRows('2026-11-17').map((f) => f.values as Row);
    const want = Object.fromEntries(['gross_paisa', 'discount_paisa', 'net_paisa', 'paid_paisa', 'due_paisa'].map((k) => [k, sumOf(all, k)]));
    const p1 = await ok(c, 'bill_of_the_day', { ...Q1, limit: 2 });
    expect(p1.rows).toHaveLength(2);
    expect(p1.totals).toEqual(want);
    expect(want.gross_paisa).toBe(150_000 + 80_000 + 123_456_789 + 25_000);
    const p2 = await ok(c, 'bill_of_the_day', { ...Q1, limit: 2, cursor: p1.next_cursor });
    expect(p2.totals).toEqual(want);
  });
  it('55 rows, page of 50: net total is 55 x 1000, not 50 x 1000', async () => {
    const c = await makeCtx15(OWNER, { flag: true });
    const b = await ok(c, 'bill_of_the_day', { business_date_from: '2026-12-01', business_date_to: '2026-12-01' });
    expect(b.rows).toHaveLength(50);
    expect(b.totals.net_paisa).toBe(55_000);
  });
  it('integer columns are summed as well, text and date columns never', async () => {
    const c = await makeCtx15(OWNER, { flag: true });
    const b = await ok(c, 'party_billing', { ...Q1, limit: 1 });
    expect(b.totals.orders_registered).toBe(12);
    expect(b.totals.outstanding_paisa).toBe(340_000);
    expect(Object.keys(b.totals).sort()).toEqual(def('party_billing').columns.filter((x) => x.type === 'integer' || x.type === 'integer_paisa').map((x) => x.name).sort());
  });
  it('basis_points columns are not summed (a rate has no total)', async () => {
    const c = await makeCtx15(OWNER, { flag: true });
    const b = await ok(c, 'two_level_commission', Q1);
    expect(b.totals).not.toHaveProperty('commission_bp');
    expect(b.totals.commission_paisa).toBe(95_000);
    expect(b.totals.net_billed_paisa).toBe(800_000);
  });
  it('totals are integers (paisa), never floats or strings', async () => {
    const c = await makeCtx15(OWNER, { flag: true });
    const b = await ok(c, 'bill_of_the_day', Q1);
    for (const v of Object.values(b.totals)) expect(Number.isSafeInteger(v)).toBe(true);
  });
});

// ================================================================================================================ empty data
describe('empty data answers an empty 200, never an error', () => {
  it('a range with no bill: rows [], zero totals for every summed column, no cursor', async () => {
    const c = await makeCtx15(OWNER, { flag: true });
    const b = await ok(c, 'bill_of_the_day', { business_date_from: '2026-01-01', business_date_to: '2026-01-01' });
    expect(b.rows).toEqual([]);
    expect(b.next_cursor ?? null).toBeNull();
    expect(Object.values(b.totals).every((v) => v === 0)).toBe(true);
    expect(Object.keys(b.totals).sort()).toEqual(['discount_paisa', 'due_paisa', 'gross_paisa', 'net_paisa', 'paid_paisa']);
  });
  it('a report with no data at all (collection_boy) is 200 with the columns and no rows', async () => {
    const c = await makeCtx15(OWNER, { flag: true });
    const b = await ok(c, 'collection_boy');
    expect(b.rows).toEqual([]);
    expect(b.columns.map((x: any) => x.key)).toEqual(def('collection_boy').columns.map((x) => x.name));
  });
  it('a money report with no data is still logged once', async () => {
    const c = await makeCtx15(OWNER, { flag: true });
    await ok(c, 'tds', { business_date_from: '2026-01-01', business_date_to: '2026-01-01' });
    expect(c.entries.filter((e: any) => e.action === 'referral_report.view')).toHaveLength(1);
  });
});

// ================================================================================================================ tenant and centre scope
describe('tenant and centre scope', () => {
  it('only the caller tenant: the other tenant bill of the same day never shows, in rows or in totals; the report runs on the caller ctx', async () => {
    const c = await makeCtx15(OWNER, { flag: true });
    const b = await ok(c, 'bill_of_the_day');
    expect(JSON.stringify(b)).not.toMatch(/INV-900|999999999/);
    expect(b.totals.gross_paisa).toBe(150_000 + 80_000 + 123_456_789 + 25_000);
    for (const x of H.calls) expect(x.ctx.tenantId).toBe(TA);
  });
  it('a centre of another tenant in centre_id -> 404 common.not_found; nothing read, nothing logged', async () => {
    const c = await makeCtx15(OWNER, { flag: true });
    await expectLims(call(c, 'bill_of_the_day', { ...Q1, centre_id: [B1] }), 'common.not_found', 404);
    untouched(c);
  });
  it('a centre-restricted caller sees only their centre: scope {A1} reaches the report, rows and totals leave A2 out', async () => {
    const c = await makeCtx15(OWNER_A1, { flag: true });
    const b = await ok(c, 'bill_of_the_day');
    expect(b.rows.map((r: Row) => r.centre_id)).toEqual([A1, A1, A1]);
    expect(b.totals.gross_paisa).toBe(150_000 + 80_000 + 25_000);
    expect(H.calls[0]!.args.scope).toEqual({ all: false, centreIds: [A1] });
  });
  it('a restricted caller naming a centre outside their scope -> 404 common.not_found', async () => {
    const c = await makeCtx15(OWNER_A1, { flag: true });
    await expectLims(call(c, 'bill_of_the_day', { ...Q1, centre_id: [A2] }), 'common.not_found', 404);
    untouched(c);
  });
  it('an all-centre caller may narrow to one centre; rows and totals follow', async () => {
    const c = await makeCtx15(OWNER, { flag: true });
    const b = await ok(c, 'bill_of_the_day', { ...Q1, centre_id: [A2] });
    expect(b.rows.map((r: Row) => r.invoice_number)).toEqual(['INV-3']);
    expect(b.totals.net_paisa).toBe(123_456_789);
  });
  it('more than 20 centre ids -> 400 common.validation_failed (same limit as the other lists)', async () => {
    const c = await makeCtx15(OWNER, { flag: true });
    await expectLims(call(c, 'bill_of_the_day', { ...Q1, centre_id: Array.from({ length: 21 }, () => A1) }), 'common.validation_failed', 400);
  });
});

// ================================================================================================================ failure of the data source
describe('failure of the data source', () => {
  it('a database failure surfaces as an error the core maps to common.internal (no row leaks, no half page)', async () => {
    const keep = H.impl; H.impl = async () => { throw new Error('synthetic database down'); };
    try {
      const c = await makeCtx15(OWNER, { flag: true });
      const e: any = await rejection(call(c, 'bill_of_the_day'));
      expect(e).toBeTruthy();
      expect(e).not.toBeInstanceOf(TypeError);
      expect(H.calls.length, 'the failing source was really called').toBeGreaterThan(0);
    } finally { H.impl = keep; }
  });
  it('a report above its row cap is the standard validation error and is passed on as is', async () => {
    const keep = H.impl; H.impl = async () => { throw new LimsError('common.validation_failed', 'The result has more than 5000 rows: narrow the range or add a filter', [{ path: 'range', code: 'common.field_invalid', message: 'Field invalid' }]); };
    try {
      const c = await makeCtx15(OWNER, { flag: true });
      await expectLims(call(c, 'bill_of_the_day'), 'common.validation_failed', 400);
    } finally { H.impl = keep; }
  });
});
