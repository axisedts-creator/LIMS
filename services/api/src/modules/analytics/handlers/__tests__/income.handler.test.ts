// C8 AN-T08 — getIncomeReport (GET /v1/analytics/reports/income). PRD US-03.1/.4/.5/.6 (+ US-04.3 via the department file), M10–M20,
// 02-TRD §5 #2 / §5.1 IncomeReport / §5.2 handler pattern / §6.1; 07-SECURITY REQ-SEC-013/017/081, P1, P3, P4, P5, abuse case 1.
// done_when: "M10–M22; group_by incl. bs_month". R1 (income_reconciles_to_registers) is an M6 gate and is NOT run here.
// Repos are in-memory emulators (./helpers.ts); handler + service + mapper + labels.service are real.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LimsError } from '../../../../core/errors.js';
import {
  A1, A2, A3, B1, BR1, BR2, BRB, ADMIN, NO_PERM, OWNER_A1, OWNER_ALL, OWNER_MULTI, PARTNER, D0, D1, D2, D3, BRANCH_NAME, CENTRE_NAME,
  addDays, bsKey, call, contractErrors, db, expectLims, golden, incFact, makeCtx, ok, rejection, seedStandard,
} from './helpers.js';

vi.mock('../../repository/rollups.repo.js', async () => (await import('./helpers.js')).rollupsMock);
vi.mock('../../repository/labels.repo.js', async () => (await import('./helpers.js')).labelsRepoMock);

const WINDOW = { business_date_from: D1, business_date_to: D3 };           // [2026-11-05, 2026-11-07)
const ZERO = { invoices_issued: 0, invoices_cancelled: 0, gross_paisa: 0, discount_paisa: 0, exempt_paisa: 0, taxable_paisa: 0, vat_paisa: 0, other_tax_paisa: 0, invoiced_paisa: 0, credit_notes_paisa: 0, net_sales_paisa: 0 };
const MONEY = Object.keys(ZERO);
const pick = (o: any) => Object.fromEntries(MONEY.map((k) => [k, o[k]]));

// Hand-computed from seedStandard(): window [D1, D3), tenant A, all centres.
const ROW_D1 = { invoices_issued: 5, invoices_cancelled: 1, gross_paisa: 15000, discount_paisa: 1000, exempt_paisa: 0, taxable_paisa: 14000, vat_paisa: 1820, other_tax_paisa: 0, invoiced_paisa: 15820, credit_notes_paisa: 0, net_sales_paisa: 15820 };
const ROW_D2 = { invoices_issued: 1, invoices_cancelled: 0, gross_paisa: 2000, discount_paisa: 0, exempt_paisa: 0, taxable_paisa: 2000, vat_paisa: 260, other_tax_paisa: 0, invoiced_paisa: 2260, credit_notes_paisa: 3000, net_sales_paisa: -740 };
const TOTAL_ALL = { invoices_issued: 6, invoices_cancelled: 1, gross_paisa: 17000, discount_paisa: 1000, exempt_paisa: 0, taxable_paisa: 16000, vat_paisa: 2080, other_tax_paisa: 0, invoiced_paisa: 18080, credit_notes_paisa: 3000, net_sales_paisa: 15080 };
const TOTAL_A1 = { invoices_issued: 4, invoices_cancelled: 1, gross_paisa: 12000, discount_paisa: 1000, exempt_paisa: 0, taxable_paisa: 11000, vat_paisa: 1430, other_tax_paisa: 0, invoiced_paisa: 12430, credit_notes_paisa: 3000, net_sales_paisa: 9430 };

beforeEach(() => { seedStandard(); vi.clearAllMocks(); });

describe('US-03.1 / M10–M12 — invoiced, credit notes, net sales ("Income")', () => {
  it('group_by defaults to day: one row per business date, ascending; M10 = Σ net issued, M11 = Σ credit notes, M12 = M10 − M11', async () => {
    const { ctx } = await makeCtx(ADMIN);
    const body = await ok('getIncomeReport', ctx, WINDOW);
    expect(body.rows.map((r: any) => r.key)).toEqual([D1, D2]);
    expect(pick(body.rows[0])).toEqual(ROW_D1);
    expect(pick(body.rows[1])).toEqual(ROW_D2);
    for (const r of body.rows) expect(r.net_sales_paisa, r.key).toBe(r.invoiced_paisa - r.credit_notes_paisa);
  });

  it('totals = exact sum of the rows, and totals.net_sales_paisa = totals.invoiced_paisa − totals.credit_notes_paisa', async () => {
    const { ctx } = await makeCtx(ADMIN);
    const body = await ok('getIncomeReport', ctx, WINDOW);
    expect(body.totals).toEqual(TOTAL_ALL);
    expect(Object.keys(body.totals).sort()).toEqual([...MONEY].sort()); // no key / label in totals (TRD §5.1)
    for (const k of MONEY) expect(body.totals[k], k).toBe(body.rows.reduce((s: number, r: any) => s + r[k], 0));
  });

  it('M20 invoices_cancelled is reported as stored (a cancelled invoice stays in invoices_issued on its issue date)', async () => {
    const { ctx } = await makeCtx(ADMIN);
    const body = await ok('getIncomeReport', ctx, { business_date_from: D1, business_date_to: D2 });
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]).toMatchObject({ invoices_issued: 5, invoices_cancelled: 1 });
  });

  it('report_code is income and basis_note_key is analytics.income.basis_note (US-03.6)', async () => {
    const { ctx } = await makeCtx(ADMIN);
    const body = await ok('getIncomeReport', ctx, WINDOW);
    expect(body.report_code).toBe('income');
    expect(body.basis_note_key).toBe('analytics.income.basis_note');
  });
});

describe('US-03.4 — a day may be negative and is never clamped', () => {
  it('credit notes larger than the day\'s invoices → negative net_sales_paisa on that row, in totals, and the body is still contract-valid', async () => {
    const { ctx } = await makeCtx(ADMIN);
    const body = await ok('getIncomeReport', ctx, { business_date_from: D2, business_date_to: D3 });
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0].net_sales_paisa).toBe(-740);
    expect(body.totals.net_sales_paisa).toBe(-740);
    expect(Number.isInteger(body.totals.net_sales_paisa)).toBe(true);
    expect(contractErrors('IncomeReport', body)).toEqual([]);
  });

  it('a period with credit notes only (no invoices that day): invoiced 0, net_sales = −credit notes', async () => {
    db.income.push(incFact('2026-12-01', A1, { issued: 0, taxable: 0, credit: 500 }));
    const { ctx } = await makeCtx(ADMIN);
    const body = await ok('getIncomeReport', ctx, { business_date_from: '2026-12-01', business_date_to: '2026-12-02' });
    expect(pick(body.totals)).toEqual({ ...ZERO, credit_notes_paisa: 500, net_sales_paisa: -500 });
  });
});

describe('period: [from, to) on Asia/Kathmandu business dates (US-02.6, 03-APP-FLOW)', () => {
  it('rows on the exclusive upper bound or before the lower bound are not included; period echoes both A.D. bounds and the day count', async () => {
    const { ctx } = await makeCtx(ADMIN);
    const body = await ok('getIncomeReport', ctx, WINDOW);
    expect(body.rows.map((r: any) => r.key)).not.toContain(D0);
    expect(body.rows.map((r: any) => r.key)).not.toContain(D3);
    expect(body.period).toMatchObject({ business_date_from: D1, business_date_to: D3, days: 2, timezone: 'Asia/Kathmandu' });
  });

  it('no period → today in Asia/Kathmandu, decided by the instant: 18:14:59.999Z is still 2026-11-05, 18:15:00.000Z is 2026-11-06', async () => {
    const before = await makeCtx(ADMIN, { now: () => '2026-11-05T18:14:59.999Z' });
    const b = await ok('getIncomeReport', before.ctx, {});
    expect(b.period).toMatchObject({ business_date_from: D1, business_date_to: D2, days: 1 });
    expect(b.rows.map((r: any) => r.key)).toEqual([D1]);
    const after = await makeCtx(ADMIN, { now: () => '2026-11-05T18:15:00.000Z' });
    const a = await ok('getIncomeReport', after.ctx, {});
    expect(a.period).toMatchObject({ business_date_from: D2, business_date_to: D3, days: 1 });
    expect(a.rows.map((r: any) => r.key)).toEqual([D2]);
  });

  it('a window with no data → rows [] and all-zero totals (integers, not null/undefined), contract-valid', async () => {
    const { ctx } = await makeCtx(ADMIN);
    const body = await ok('getIncomeReport', ctx, { business_date_from: '2030-01-01', business_date_to: '2030-01-08' });
    expect(body.rows).toEqual([]);
    expect(body.totals).toEqual(ZERO);
    expect(contractErrors('IncomeReport', body)).toEqual([]);
  });
});

describe('group_by (TRD §5 #2: day, ad_month, bs_month, branch, centre)', () => {
  it('ad_month: one row per A.D. month, key YYYY-MM, exact sums', async () => {
    db.income = db.income.filter((f) => f.date !== D0); // window [10-30, D3) is half-open and would include seeded D0
    db.income.push(incFact('2026-10-31', A1, { issued: 7, taxable: 4000, vat: 520 }));
    const { ctx } = await makeCtx(ADMIN);
    const body = await ok('getIncomeReport', ctx, { business_date_from: '2026-10-30', business_date_to: D3, group_by: 'ad_month' });
    expect(body.rows.map((r: any) => r.key)).toEqual(['2026-10', '2026-11']);
    expect(pick(body.rows[0])).toMatchObject({ invoices_issued: 7, invoiced_paisa: 4520, net_sales_paisa: 4520 });
    expect(pick(body.rows[1])).toEqual(TOTAL_ALL);
    expect(body.totals.invoiced_paisa).toBe(4520 + 18080);
  });

  it('bs_month over a bs_month period (US-03.5): one row, key YYYY-MM, label "YYYY-MM B.S.", sums only that B.S. month; boundaries from the golden table', async () => {
    const m = golden(2082, 7);
    const first = m.ad_first_day, last = addDays(first, m.days - 1);
    db.income.push(
      incFact(addDays(first, -1), A1, { taxable: 100 }),   // last day of the previous B.S. month: must not leak in
      incFact(first, A1, { issued: 2, taxable: 1000 }),
      incFact(addDays(first, 10), A2, { taxable: 5000 }),
      incFact(last, A1, { issued: 3, taxable: 20000, vat: 2600, credit: 1 }),
      incFact(addDays(first, m.days), A1, { taxable: 300000 }), // first day of the next B.S. month: must not leak in
    );
    const { ctx } = await makeCtx(ADMIN);
    const body = await ok('getIncomeReport', ctx, { bs_month: bsKey(2082, 7), group_by: 'bs_month' });
    expect(body.period).toMatchObject({ business_date_from: first, business_date_to: addDays(first, m.days), days: m.days, bs_month: '2082-07' });
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]).toMatchObject({ key: '2082-07', label: '2082-07 B.S.', invoices_issued: 6, invoiced_paisa: 1000 + 5000 + 22600, credit_notes_paisa: 1, net_sales_paisa: 28599 });
    expect(pick(body.totals)).toEqual(pick(body.rows[0]));
  });

  it('bs_month across a B.S. month boundary: consecutive months are separate rows, each the exact sum of its own days (no off-by-one at day 1 / last day)', async () => {
    const jestha = golden(2082, 2), asar = golden(2082, 3);
    const lastJestha = addDays(asar.ad_first_day, -1);
    expect(addDays(jestha.ad_first_day, jestha.days - 1)).toBe(lastJestha); // golden table is contiguous
    db.income.push(
      incFact(jestha.ad_first_day, A1, { taxable: 10 }), incFact(lastJestha, A2, { taxable: 200 }),
      incFact(asar.ad_first_day, A1, { taxable: 3000 }), incFact(addDays(asar.ad_first_day, asar.days - 1), A1, { taxable: 40000 }),
    );
    const { ctx } = await makeCtx(ADMIN);
    const body = await ok('getIncomeReport', ctx, { business_date_from: jestha.ad_first_day, business_date_to: addDays(asar.ad_first_day, asar.days), group_by: 'bs_month' });
    expect(body.rows.map((r: any) => [r.key, r.label, r.invoiced_paisa])).toEqual([['2082-02', '2082-02 B.S.', 210], ['2082-03', '2082-03 B.S.', 43000]]);
    expect(body.totals.invoiced_paisa).toBe(43210);
  });

  it('branch: key = branch id, label = branch name from ctx.core; NULL-centre invoices (credit party) count in their branch for all-centre readers', async () => {
    db.income.push(incFact(D1, A3, { issued: 1, taxable: 100 }), incFact(D1, null, { issued: 1, taxable: 777 }));
    const { ctx } = await makeCtx(ADMIN);
    const body = await ok('getIncomeReport', ctx, { ...WINDOW, group_by: 'branch' });
    const by = Object.fromEntries(body.rows.map((r: any) => [r.key, r]));
    expect(Object.keys(by).sort()).toEqual([BR1, BR2].sort());
    expect(by[BR1]).toMatchObject({ label: BRANCH_NAME(BR1), invoiced_paisa: 18080 + 777, net_sales_paisa: 15080 + 777 });
    expect(by[BR2]).toMatchObject({ label: BRANCH_NAME(BR2), invoiced_paisa: 100 });
    expect(body.totals.invoiced_paisa).toBe(18080 + 777 + 100);
  });

  it('centre: key = centre id, label = centre name; an inactive centre keeps its history and is flagged is_inactive', async () => {
    db.income.push(incFact(D1, A3, { issued: 1, taxable: 100 }));
    const { ctx } = await makeCtx(ADMIN);
    const body = await ok('getIncomeReport', ctx, { ...WINDOW, group_by: 'centre' });
    const by = Object.fromEntries(body.rows.map((r: any) => [r.key, r]));
    expect(Object.keys(by).sort()).toEqual([A1, A2, A3].sort());
    expect(by[A1]).toMatchObject({ label: CENTRE_NAME(A1), invoiced_paisa: 12430, credit_notes_paisa: 3000, net_sales_paisa: 9430 });
    expect(by[A2]).toMatchObject({ label: CENTRE_NAME(A2), invoiced_paisa: 5650 });
    expect(by[A3]).toMatchObject({ label: CENTRE_NAME(A3), invoiced_paisa: 100, is_inactive: true });
    expect(by[A1].is_inactive ?? false).toBe(false);
  });

  it.each(['day', 'ad_month', 'bs_month', 'branch', 'centre'])('group_by=%s: the body validates against the IncomeReport schema of analytics.yaml (envelope, additionalProperties:false, ≤400 rows)', async (group_by) => {
    const { ctx } = await makeCtx(ADMIN);
    const body = await ok('getIncomeReport', ctx, { ...WINDOW, group_by });
    expect(contractErrors('IncomeReport', body)).toEqual([]);
    expect(body.rows.length).toBeGreaterThan(0);
  });

  it('every row sums to the totals for every group_by (grouping never changes the grand total)', async () => {
    for (const group_by of ['day', 'ad_month', 'bs_month', 'branch', 'centre']) {
      const { ctx } = await makeCtx(ADMIN);
      const body = await ok('getIncomeReport', ctx, { ...WINDOW, group_by });
      expect(pick(body.totals), group_by).toEqual(TOTAL_ALL);
    }
  });
});

describe('scope: centre-restricted users, centre_id / branch_id filters (US-15.2, 07 P1 P3 P4 P5, abuse case 1)', () => {
  it('all-centre user: scope echo is all_centres true, no ids, nothing hidden (no Phase-1 tenant-wide family)', async () => {
    const { ctx } = await makeCtx(OWNER_ALL);
    const body = await ok('getIncomeReport', ctx, WINDOW);
    expect(body.scope).toEqual({ all_centres: true, centre_ids: [], tenant_wide_sections_hidden: [] });
    expect(pick(body.totals)).toEqual(TOTAL_ALL);
  });

  it('A1-only user: every figure equals the A1-only expected values; A2, NULL-centre and tenant B rows contribute nothing', async () => {
    db.income.push(incFact(D1, null, { issued: 1, taxable: 777 }));
    const { ctx } = await makeCtx(OWNER_A1);
    const body = await ok('getIncomeReport', ctx, WINDOW);
    expect(pick(body.totals)).toEqual(TOTAL_A1);
    expect(body.scope).toEqual({ all_centres: false, centre_ids: [A1], tenant_wide_sections_hidden: [] });
    const text = JSON.stringify(body);
    expect(text).not.toContain(A2);
    expect(text).not.toContain(B1);
    expect(text).not.toContain('999999');
  });

  it('A1-only user asking for centre A2 → 404 common.not_found, no oracle (the id is not echoed), and no rollup is read', async () => {
    const { ctx } = await makeCtx(OWNER_A1);
    const e = await expectLims(call('getIncomeReport', ctx, { ...WINDOW, centre_id: [A2] }), 'common.not_found', 404);
    expect(JSON.stringify({ m: e.message, d: e.detail, e: e.errors })).not.toContain(A2);
    expect(db.calls).toEqual([]);
  });

  it('all-centre user with a tenant B centre id or branch id → 404 (07 P1); a mixed A + B list is 404 too, never a partial result', async () => {
    const { ctx } = await makeCtx(ADMIN);
    await expectLims(call('getIncomeReport', ctx, { ...WINDOW, centre_id: [B1] }), 'common.not_found', 404);
    await expectLims(call('getIncomeReport', (await makeCtx(ADMIN)).ctx, { ...WINDOW, centre_id: [A1, B1] }), 'common.not_found', 404);
    await expectLims(call('getIncomeReport', (await makeCtx(ADMIN)).ctx, { ...WINDOW, branch_id: [BRB] }), 'common.not_found', 404);
    expect(db.calls).toEqual([]);
  });

  it('all-centre user with centre_id=[A1] → only A1 rows and the scope echo narrows to that centre', async () => {
    const { ctx } = await makeCtx(ADMIN);
    const body = await ok('getIncomeReport', ctx, { ...WINDOW, centre_id: [A1] });
    expect(pick(body.totals)).toEqual(TOTAL_A1);
    expect(body.scope).toMatchObject({ all_centres: false, centre_ids: [A1] });
  });

  it('branch filter does not widen scope (07 P5): {A1,A2} user + a branch holding none of their centres → empty rows, zero totals, empty restricted scope', async () => {
    db.income.push(incFact(D1, A3, { taxable: 100 }));
    const { ctx } = await makeCtx(OWNER_MULTI);
    const body = await ok('getIncomeReport', ctx, { ...WINDOW, branch_id: [BR2] });
    expect(body.rows).toEqual([]);
    expect(body.totals).toEqual(ZERO);
    expect(body.scope).toMatchObject({ all_centres: false, centre_ids: [] });
    expect(contractErrors('IncomeReport', body)).toEqual([]);
  });

  it('branch filter for an all-centre user returns that branch\'s centres only and excludes NULL-centre rows (scope predicate: centre_id IS NOT NULL)', async () => {
    db.income.push(incFact(D1, A3, { taxable: 100 }), incFact(D1, null, { taxable: 777 }));
    const { ctx } = await makeCtx(ADMIN);
    const body = await ok('getIncomeReport', ctx, { ...WINDOW, branch_id: [BR1] });
    expect(pick(body.totals)).toEqual(TOTAL_ALL);
  });

  it('the scope handed to the repository is the resolved effective scope, with the tenant from ctx (never from the query)', async () => {
    const { ctx } = await makeCtx(OWNER_MULTI);
    await ok('getIncomeReport', ctx, { ...WINDOW, centre_id: [A2] });
    const last = db.calls.at(-1)!;
    expect(last.fn).toBe('incomeRows');
    expect(last.args.tenantId).toBe(ctx.tenantId);
    expect(last.args.scope).toEqual({ all: false, centreIds: [A2] });
    expect(db.calls.every((c) => c.args.tenantId === ctx.tenantId)).toBe(true);
  });

  it('many users at once: interleaved requests of different scopes each get their own totals (no per-request state leaks between callers)', async () => {
    const jobs = Array.from({ length: 24 }, async (_, i) => {
      const who = [ADMIN, OWNER_A1, OWNER_MULTI][i % 3]!;
      const { ctx } = await makeCtx(who);
      const body = await ok('getIncomeReport', ctx, { ...WINDOW, group_by: ['day', 'branch', 'centre', 'bs_month'][i % 4]! });
      return { who, totals: pick(body.totals) };
    });
    for (const r of await Promise.all(jobs)) expect(r.totals, r.who).toEqual(r.who === OWNER_A1 ? TOTAL_A1 : TOTAL_ALL); // {A1,A2} holds every tenant A row of the window
  });
});

describe('tenant isolation (07 P1, REQ-SEC-013)', () => {
  it('tenant B rows are never in an A response, whatever the grouping; B rows are only reachable with B credentials', async () => {
    for (const group_by of ['day', 'ad_month', 'bs_month', 'branch', 'centre']) {
      const { ctx } = await makeCtx(ADMIN);
      const text = JSON.stringify(await ok('getIncomeReport', ctx, { ...WINDOW, group_by }));
      expect(text, group_by).not.toContain('999999');
      expect(text, group_by).not.toContain('888888');
      expect(text, group_by).not.toContain(BRB);
    }
  });
});

describe('exact integer money (REQ: paisa are integers, no floats, no silent precision loss)', () => {
  it('sums just below 2^53 stay exact', async () => {
    db.income.length = 0;
    db.income.push(incFact(D1, A1, { taxable: 4_000_000_000_000_000 }), incFact(D1, A2, { taxable: 4_000_000_000_000_001 }));
    const { ctx } = await makeCtx(ADMIN);
    const body = await ok('getIncomeReport', ctx, { business_date_from: D1, business_date_to: D2 });
    expect(body.totals.invoiced_paisa).toBe(8_000_000_000_000_001);
  });

  it('a total beyond 2^53 is refused, never rounded into a wrong figure', async () => {
    db.income.length = 0;
    db.income.push(incFact(D1, A1, { taxable: 5_000_000_000_000_000 }), incFact(D2, A1, { taxable: 5_000_000_000_000_000 }));
    const { ctx } = await makeCtx(ADMIN);
    const e = await rejection(call('getIncomeReport', ctx, WINDOW));
    expect(e).toBeInstanceOf(Error);
  });
});

describe('response allow-list and wording (REQ-SEC-081, 07 P13, PRD US-07.3)', () => {
  it('no "commission" anywhere and no per-referrer money field in the income body', async () => {
    const { ctx } = await makeCtx(ADMIN);
    const text = JSON.stringify(await ok('getIncomeReport', ctx, { ...WINDOW, group_by: 'centre' }));
    expect(text.toLowerCase()).not.toContain('commission');
    expect(text).not.toContain('net_billed_paisa');
  });

  it('rows carry exactly the IncomeRow fields (no extra column from the SQL row leaks through the mapper)', async () => {
    const { ctx } = await makeCtx(ADMIN);
    const body = await ok('getIncomeReport', ctx, WINDOW);
    const allowed = new Set(['key', 'label', 'label_bs', 'is_inactive', ...MONEY]);
    for (const r of body.rows) for (const k of Object.keys(r)) expect(allowed.has(k), k).toBe(true);
  });
});

describe('errors (TRD §5 #2 x-error-codes; CV §10.1 assertRole before any read)', () => {
  it('a user without analytics.dashboard.read → 403 auth.forbidden, and nothing was read (no core port, no tx, no rollup)', async () => {
    const { ctx, touched } = await makeCtx(NO_PERM);
    await expectLims(call('getIncomeReport', ctx, WINDOW), 'auth.forbidden', 403);
    expect(touched).toEqual([]);
    expect(db.calls).toEqual([]);
  });

  it('a partner actor is forbidden too (07 P12): no income data for partner claims', async () => {
    const { ctx, touched } = await makeCtx(PARTNER);
    await expectLims(call('getIncomeReport', ctx, WINDOW), 'auth.forbidden', 403);
    expect(touched).toEqual([]);
    expect(db.calls).toEqual([]);
  });

  it('bs_month together with explicit dates → 400 common.validation_failed (US-02.3); nothing is read', async () => {
    const { ctx } = await makeCtx(ADMIN);
    await expectLims(call('getIncomeReport', ctx, { ...WINDOW, bs_month: '2082-07' }), 'common.validation_failed', 400);
    expect(db.calls).toEqual([]);
  });

  it('a range of 400 days → 422 analytics.range_too_large (US-02.4)', async () => {
    const { ctx } = await makeCtx(ADMIN);
    await expectLims(call('getIncomeReport', ctx, { business_date_from: '2025-01-01', business_date_to: '2026-02-05' }), 'analytics.range_too_large', 422);
    expect(db.calls).toEqual([]);
  });

  it('a B.S. month outside 1975–2099 → 422 common.date_out_of_range (US-02.5)', async () => {
    const { ctx } = await makeCtx(ADMIN);
    await expectLims(call('getIncomeReport', ctx, { bs_month: '2100-01' }), 'common.date_out_of_range', 422);
  });

  it.each(['department', 'week', '', 'DAY', 'day; DROP TABLE analytics.daily_income', 'day\' OR \'1\'=\'1'])('unsupported group_by %j → 400 common.validation_failed before any query (no identifier from input reaches SQL)', async (group_by) => {
    const { ctx } = await makeCtx(ADMIN);
    await expectLims(call('getIncomeReport', ctx, { ...WINDOW, group_by }), 'common.validation_failed', 400);
    expect(db.calls).toEqual([]);
  });

  it('a dependency failure surfaces as the same error, never as an empty or partial 200', async () => {
    db.fail = new LimsError('common.dependency_unavailable');
    const { ctx } = await makeCtx(ADMIN);
    await expectLims(call('getIncomeReport', ctx, WINDOW), 'common.dependency_unavailable', 503);
  });

  it('an unexpected database error rejects; the secret in its message is not turned into a response body', async () => {
    db.fail = new Error('connection string postgres://lims:s3cret@db/lims failed');
    const { ctx } = await makeCtx(ADMIN);
    const r = await call('getIncomeReport', ctx, WINDOW).then((x) => ({ resolved: x }), (e) => ({ rejected: e }));
    expect(db.calls.length).toBeGreaterThan(0); // it really reached the repository
    expect('rejected' in r).toBe(true);
    expect(JSON.stringify((r as any).resolved ?? {})).not.toContain('s3cret');
  });
});
