// C8 AN-T08 — getDepartmentIncomeReport (GET /v1/analytics/reports/department-income). PRD US-04.1–3, US-03.3 (R2), M21/M22;
// 02-TRD §5 #3 / §5.1 DepartmentIncomeReport / §6.2; 07-SECURITY P1, P3, P4, REQ-SEC-081. R2: Σ department net_paisa = M12 (income net sales).
// Repos are in-memory emulators (./helpers.ts); handler + service + mapper + labels.service are real.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LimsError } from '../../../../core/errors.js';
import { ratioBp } from '../../domain/metrics.js';
import {
  A1, A2, TA, ADMIN, DEPT, DEPT_NAME, NO_PERM, OWNER_A1, PARTNER, D0, D1, D2, D3, addDays, bsKey, call, contractErrors, db, deptFact, expectLims,
  golden, incFact, makeCtx, ok, seedStandard,
} from './helpers.js';

vi.mock('../../repository/rollups.repo.js', async () => (await import('./helpers.js')).rollupsMock);
vi.mock('../../repository/labels.repo.js', async () => (await import('./helpers.js')).labelsRepoMock);

const WINDOW = { business_date_from: D1, business_date_to: D3 };
const byDept = (body: any) => Object.fromEntries(body.rows.map((r: any) => [r.is_multiple ? 'MULTI' : r.department_id, r]));
const line = (r: any) => ({ line_count: r.line_count, gross_paisa: r.gross_paisa, discount_paisa: r.discount_paisa, net_paisa: r.net_paisa });

// Hand-computed from seedStandard(), window [D1, D3), all centres.
const ALL = {
  [DEPT.H]: { line_count: 7, gross_paisa: 13910, discount_paisa: 1000, net_paisa: 9910 },
  [DEPT.B]: { line_count: 2, gross_paisa: 3200, discount_paisa: 0, net_paisa: 3200 },
  [DEPT.OLD]: { line_count: 1, gross_paisa: 1500, discount_paisa: 0, net_paisa: 1500 },
  MULTI: { line_count: 1, gross_paisa: 500, discount_paisa: 30, net_paisa: 470 },
};
const TOTALS_ALL = { line_count: 11, gross_paisa: 19110, discount_paisa: 1030, net_paisa: 15080 };
// A1 only: H loses A2's 3 lines / 5650.
const ALL_A1 = { ...ALL, [DEPT.H]: { line_count: 4, gross_paisa: 8260, discount_paisa: 1000, net_paisa: 4260 } };
const TOTALS_A1 = { line_count: 8, gross_paisa: 13460, discount_paisa: 1030, net_paisa: 9430 };

beforeEach(() => { seedStandard(); vi.clearAllMocks(); });

describe('US-04.1 — income by department with names from catalog.v_pub_department', () => {
  it('one row per department with its name; NULL department_id is the single row "Multiple departments" (is_multiple, no department_id)', async () => {
    const { ctx } = await makeCtx(ADMIN);
    const body = await ok('getDepartmentIncomeReport', ctx, WINDOW);
    expect(body.rows).toHaveLength(4);
    const r = byDept(body);
    expect(r[DEPT.H]).toMatchObject({ label: DEPT_NAME.H, is_multiple: false, department_id: DEPT.H });
    expect(r[DEPT.B]).toMatchObject({ label: DEPT_NAME.B, is_multiple: false, department_id: DEPT.B });
    expect(r.MULTI).toMatchObject({ label: 'Multiple departments', is_multiple: true });
    expect(r.MULTI.department_id).toBeUndefined();
  });

  it('M21 net_paisa, M22 line_count, gross and discount per department are exact sums over centres and days; credit lines reduce net (H day 2 is −740)', async () => {
    const { ctx } = await makeCtx(ADMIN);
    const body = await ok('getDepartmentIncomeReport', ctx, WINDOW);
    const r = byDept(body);
    for (const k of Object.keys(ALL)) expect(line(r[k]), k).toEqual((ALL as any)[k]);
    expect(body.totals).toEqual(TOTALS_ALL);
    expect(Object.keys(body.totals).sort()).toEqual(['discount_paisa', 'gross_paisa', 'line_count', 'net_paisa']);
  });

  it('rows outside [from, to) and tenant B rows (Tenant B Radiology, 999999) never appear', async () => {
    const { ctx } = await makeCtx(ADMIN);
    const text = JSON.stringify(await ok('getDepartmentIncomeReport', ctx, WINDOW));
    expect(text).not.toContain('999999');
    expect(text).not.toContain(DEPT_NAME.FOREIGN);
    expect(text).not.toContain(DEPT.FOREIGN);
  });

  it('report_code is department_income; period echoes the resolved bounds', async () => {
    const { ctx } = await makeCtx(ADMIN);
    const body = await ok('getDepartmentIncomeReport', ctx, WINDOW);
    expect(body.report_code).toBe('department_income');
    expect(body.period).toMatchObject({ business_date_from: D1, business_date_to: D3, days: 2, timezone: 'Asia/Kathmandu' });
  });

  it('share_bp = round(net × 10000 / total net) per row (domain ratioBp), integer 0..1,000,000', async () => {
    const { ctx } = await makeCtx(ADMIN);
    const body = await ok('getDepartmentIncomeReport', ctx, { business_date_from: D1, business_date_to: D2 }); // day 1 only: all nets ≥ 0
    expect(body.totals.net_paisa).toBe(15820);
    for (const r of body.rows) expect(r.share_bp, r.label).toBe(ratioBp(r.net_paisa, 15820));
  });
});

describe('US-04.2 — a department deactivated in C3 keeps its history', () => {
  it('historic income still shows with the department name and is_inactive true; active departments are not flagged', async () => {
    const { ctx } = await makeCtx(ADMIN);
    const r = byDept(await ok('getDepartmentIncomeReport', ctx, WINDOW));
    expect(r[DEPT.OLD].label).toContain(DEPT_NAME.OLD);
    expect(r[DEPT.OLD].is_inactive).toBe(true);
    expect(r[DEPT.OLD].net_paisa).toBe(1500);
    expect(r[DEPT.H].is_inactive ?? false).toBe(false);
    expect(r.MULTI.is_inactive ?? false).toBe(false);
  });

  it('a department id with no catalog row still gets a non-empty label (never undefined / a crash)', async () => {
    db.dept.push(deptFact(D1, A1, DEPT.UNKNOWN, { lines: 1, gross: 10, net: 10 }));
    db.income.push(incFact(D1, A1, { taxable: 10 }));
    const { ctx } = await makeCtx(ADMIN);
    const body = await ok('getDepartmentIncomeReport', ctx, WINDOW);
    const row = body.rows.find((x: any) => x.department_id === DEPT.UNKNOWN);
    expect(typeof row.label).toBe('string');
    expect(row.label.length).toBeGreaterThan(0);
    expect(row.label.length).toBeLessThanOrEqual(200);
    expect(contractErrors('DepartmentIncomeReport', body)).toEqual([]);
  });
});

describe('US-03.3 / US-04.3 — R2 reconciliation: Σ department net = M12', () => {
  it('standard data: reconciles_with_income true; no metric, no warning', async () => {
    const { ctx } = await makeCtx(ADMIN);
    const body = await ok('getDepartmentIncomeReport', ctx, WINDOW);
    expect(body.reconciles_with_income).toBe(true);
    expect(body.totals.net_paisa).toBe(15080); // = income net sales for the same window
    expect(ctx.metrics.inc).not.toHaveBeenCalled();
    expect(ctx.log.warn).not.toHaveBeenCalled();
  });

  it('R2 on the income report of the same period: department totals.net_paisa = income totals.net_sales_paisa (credit-note lines negative on their date)', async () => {
    const { ctx } = await makeCtx(ADMIN);
    const dept = await ok('getDepartmentIncomeReport', ctx, WINDOW);
    const inc = await ok('getIncomeReport', (await makeCtx(ADMIN)).ctx, WINDOW);
    expect(dept.totals.net_paisa).toBe(inc.totals.net_sales_paisa);
  });

  it('negative day (credit notes only that day): totals.net_paisa −740 = M12 −740 → still reconciles; row keeps its minus sign; body contract-valid (share_bp inside 0..1,000,000)', async () => {
    const { ctx } = await makeCtx(ADMIN);
    const body = await ok('getDepartmentIncomeReport', ctx, { business_date_from: D2, business_date_to: D3 });
    expect(body.totals.net_paisa).toBe(-740);
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0].net_paisa).toBe(-740);
    expect(body.reconciles_with_income).toBe(true);
    expect(contractErrors('DepartmentIncomeReport', body)).toEqual([]);
  });

  it('zero total (no rows): reconciles (0 = 0), rows [], zero totals, contract-valid', async () => {
    const { ctx } = await makeCtx(ADMIN);
    const body = await ok('getDepartmentIncomeReport', ctx, { business_date_from: '2030-01-01', business_date_to: '2030-01-08' });
    expect(body.rows).toEqual([]);
    expect(body.totals).toEqual({ line_count: 0, gross_paisa: 0, discount_paisa: 0, net_paisa: 0 });
    expect(body.reconciles_with_income).toBe(true);
    expect(contractErrors('DepartmentIncomeReport', body)).toEqual([]);
  });

  it('mismatch: the response is still 200 with reconciles_with_income false; counter rule R2 +1; warn log reconciliation_mismatch with no names', async () => {
    db.dept.push(deptFact(D1, A1, DEPT.B, { lines: 1, gross: 7, net: 7 })); // 7 paisa of department income with no matching invoice
    const { ctx } = await makeCtx(ADMIN);
    const body = await ok('getDepartmentIncomeReport', ctx, WINDOW);
    expect(body.reconciles_with_income).toBe(false);
    expect(body.totals.net_paisa).toBe(15087); // figures are shown as stored, never "fixed"
    expect(ctx.metrics.inc).toHaveBeenCalledTimes(1);
    expect(ctx.metrics.inc).toHaveBeenCalledWith('lims_analytics_reconciliation_mismatch_total', expect.objectContaining({ rule: 'R2' }));
    expect(ctx.log.warn).toHaveBeenCalled();
    const logged = JSON.stringify(ctx.log.warn.mock.calls);
    expect(logged).toContain('reconciliation_mismatch');
    for (const name of Object.values(DEPT_NAME)) expect(logged).not.toContain(name); // ids/dates only
    expect(contractErrors('DepartmentIncomeReport', body)).toEqual([]);
  });

  it('R2 is evaluated on the SAME scope: A1-only user reconciles A1 department rows against A1 income (an A2 inconsistency must not flip it)', async () => {
    db.dept = db.dept.filter((f) => !(f.centreId === A2 && f.date === D1 && f.tenantId === TA)); // A2's department lines vanish
    const admin = await makeCtx(ADMIN);
    expect((await ok('getDepartmentIncomeReport', admin.ctx, WINDOW)).reconciles_with_income).toBe(false); // all centres: 5650 missing
    const a1 = await makeCtx(OWNER_A1);
    const body = await ok('getDepartmentIncomeReport', a1.ctx, WINDOW);
    expect(body.reconciles_with_income).toBe(true);
    expect(a1.ctx.metrics.inc).not.toHaveBeenCalled();
  });

  it('R2 holds for every period shape: day, two days, and a centre filter', async () => {
    for (const q of [{ business_date_from: D1, business_date_to: D2 }, WINDOW, { ...WINDOW, centre_id: [A2] }, { ...WINDOW, centre_id: [A1] }]) {
      const { ctx } = await makeCtx(ADMIN);
      expect((await ok('getDepartmentIncomeReport', ctx, q)).reconciles_with_income, JSON.stringify(q)).toBe(true);
    }
  });

  it('department_id filter narrows rows and totals but R2 is still judged over all departments (true on consistent data)', async () => {
    const { ctx } = await makeCtx(ADMIN);
    const body = await ok('getDepartmentIncomeReport', ctx, { ...WINDOW, department_id: [DEPT.H] });
    expect(body.rows).toHaveLength(1);
    expect(line(body.rows[0])).toEqual(ALL[DEPT.H]);
    expect(body.totals).toEqual(ALL[DEPT.H]);
    expect(body.reconciles_with_income).toBe(true);
    expect(ctx.metrics.inc).not.toHaveBeenCalled();
  });
});

describe('group_by (TRD §5 #3: department, department_ad_month, department_bs_month)', () => {
  it('department_ad_month: one row per (A.D. month, department) with period_key YYYY-MM; sums exact; totals unchanged', async () => {
    db.dept = db.dept.filter((f) => f.date !== D0); // window [10-30, D3) is half-open and would include seeded D0
    db.income = db.income.filter((f) => f.date !== D0);
    db.dept.push(deptFact('2026-10-31', A1, DEPT.H, { lines: 2, gross: 400, net: 400 }));
    db.income.push(incFact('2026-10-31', A1, { taxable: 400 }));
    const { ctx } = await makeCtx(ADMIN);
    const body = await ok('getDepartmentIncomeReport', ctx, { business_date_from: '2026-10-30', business_date_to: D3, group_by: 'department_ad_month' });
    const keyed = body.rows.map((r: any) => `${r.period_key}|${r.is_multiple ? 'MULTI' : r.department_id}`);
    expect(new Set(keyed).size).toBe(keyed.length);
    const oct = body.rows.filter((r: any) => r.period_key === '2026-10');
    expect(oct).toHaveLength(1);
    expect(line(oct[0])).toEqual({ line_count: 2, gross_paisa: 400, discount_paisa: 0, net_paisa: 400 });
    const nov = Object.fromEntries(body.rows.filter((r: any) => r.period_key === '2026-11').map((r: any) => [r.is_multiple ? 'MULTI' : r.department_id, line(r)]));
    expect(nov).toEqual(ALL);
    expect(body.totals.net_paisa).toBe(15080 + 400);
    expect(body.reconciles_with_income).toBe(true);
    expect(contractErrors('DepartmentIncomeReport', body)).toEqual([]);
  });

  it('department_bs_month: period_key is the B.S. month YYYY-MM, split at the golden-table boundary (last day / first day)', async () => {
    const a = golden(2082, 2), b = golden(2082, 3);
    const lastA = addDays(b.ad_first_day, -1);
    db.dept.push(
      deptFact(a.ad_first_day, A1, DEPT.H, { lines: 1, gross: 10, net: 10 }), deptFact(lastA, A1, DEPT.H, { lines: 1, gross: 200, net: 200 }),
      deptFact(b.ad_first_day, A1, DEPT.H, { lines: 1, gross: 3000, net: 3000 }), deptFact(b.ad_first_day, A1, null, { lines: 1, gross: 5, net: 5 }),
    );
    db.income.push(incFact(a.ad_first_day, A1, { taxable: 10 }), incFact(lastA, A1, { taxable: 200 }), incFact(b.ad_first_day, A1, { taxable: 3005 }));
    const { ctx } = await makeCtx(ADMIN);
    const body = await ok('getDepartmentIncomeReport', ctx, { business_date_from: a.ad_first_day, business_date_to: addDays(b.ad_first_day, 1), group_by: 'department_bs_month' });
    const cell = (pk: string, multi: boolean) => body.rows.find((r: any) => r.period_key === pk && r.is_multiple === multi);
    expect(cell(bsKey(2082, 2), false)).toMatchObject({ department_id: DEPT.H, net_paisa: 210, line_count: 2 });
    expect(cell(bsKey(2082, 3), false)).toMatchObject({ department_id: DEPT.H, net_paisa: 3000 });
    expect(cell(bsKey(2082, 3), true)).toMatchObject({ net_paisa: 5 });
    expect(body.rows).toHaveLength(3);
    expect(body.totals.net_paisa).toBe(3215);
    expect(body.reconciles_with_income).toBe(true);
  });

  it.each(['department', 'department_ad_month', 'department_bs_month'])('group_by=%s validates against the DepartmentIncomeReport schema', async (group_by) => {
    const { ctx } = await makeCtx(ADMIN);
    const body = await ok('getDepartmentIncomeReport', ctx, { ...WINDOW, group_by });
    expect(contractErrors('DepartmentIncomeReport', body)).toEqual([]);
    expect(body.rows.length).toBeGreaterThan(0);
  });
});

describe('scope (07 P1, P3, P4)', () => {
  it('A1-only user: every figure equals the A1-only expected values; A2 and NULL-centre department lines are absent', async () => {
    db.dept.push(deptFact(D1, null, DEPT.H, { lines: 1, gross: 777, net: 777 }));
    db.income.push(incFact(D1, null, { taxable: 777 }));
    const { ctx } = await makeCtx(OWNER_A1);
    const body = await ok('getDepartmentIncomeReport', ctx, WINDOW);
    const r = byDept(body);
    for (const k of Object.keys(ALL_A1)) expect(line(r[k]), k).toEqual((ALL_A1 as any)[k]);
    expect(body.totals).toEqual(TOTALS_A1);
    expect(body.reconciles_with_income).toBe(true);
  });

  it('A1-only user asking for centre A2 → 404 common.not_found and nothing is read', async () => {
    const { ctx } = await makeCtx(OWNER_A1);
    await expectLims(call('getDepartmentIncomeReport', ctx, { ...WINDOW, centre_id: [A2] }), 'common.not_found', 404);
    expect(db.calls).toEqual([]);
  });

  it('scope handed to the repo is the effective scope with the ctx tenant; every repo call in the request uses it', async () => {
    const { ctx } = await makeCtx(OWNER_A1);
    await ok('getDepartmentIncomeReport', ctx, WINDOW);
    expect(db.calls.length).toBeGreaterThan(0);
    for (const c of db.calls) {
      expect(c.args.tenantId).toBe(ctx.tenantId);
      expect(c.args.scope).toEqual({ all: false, centreIds: [A1] });
    }
  });

  it('department_id of tenant B, an unknown department, or a mixed A+B list → 404 (07 P1), nothing partial', async () => {
    for (const ids of [[DEPT.FOREIGN], [DEPT.UNKNOWN], [DEPT.H, DEPT.FOREIGN]]) {
      const { ctx } = await makeCtx(ADMIN);
      await expectLims(call('getDepartmentIncomeReport', ctx, { ...WINDOW, department_id: ids }), 'common.not_found', 404);
    }
    expect(db.calls).toEqual([]);
  });

  it('an inactive department of the tenant is a valid filter (history stays reachable)', async () => {
    const { ctx } = await makeCtx(ADMIN);
    const body = await ok('getDepartmentIncomeReport', ctx, { ...WINDOW, department_id: [DEPT.OLD] });
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]).toMatchObject({ department_id: DEPT.OLD, net_paisa: 1500, is_inactive: true });
  });

  it('many users at once: interleaved all-centre and A1-only requests keep their own figures', async () => {
    const jobs = Array.from({ length: 20 }, async (_, i) => {
      const who = i % 2 ? OWNER_A1 : ADMIN;
      const { ctx } = await makeCtx(who);
      return { who, totals: (await ok('getDepartmentIncomeReport', ctx, WINDOW)).totals };
    });
    for (const r of await Promise.all(jobs)) expect(r.totals, r.who).toEqual(r.who === OWNER_A1 ? TOTALS_A1 : TOTALS_ALL);
  });
});

describe('response allow-list (REQ-SEC-081, 07 P13)', () => {
  it('rows carry only DepartmentIncomeReport fields; no "commission", no net_billed_paisa', async () => {
    const { ctx } = await makeCtx(ADMIN);
    const body = await ok('getDepartmentIncomeReport', ctx, { ...WINDOW, group_by: 'department_ad_month' });
    const allowed = new Set(['key', 'label', 'label_bs', 'is_inactive', 'department_id', 'is_multiple', 'period_key', 'line_count', 'gross_paisa', 'discount_paisa', 'net_paisa', 'share_bp']);
    for (const r of body.rows) for (const k of Object.keys(r)) expect(allowed.has(k), k).toBe(true);
    const text = JSON.stringify(body).toLowerCase();
    expect(text).not.toContain('commission');
    expect(text).not.toContain('net_billed_paisa');
  });
});

describe('errors', () => {
  it('no analytics.dashboard.read → 403 auth.forbidden before any read (no core port, tx or rollup touched)', async () => {
    for (const who of [NO_PERM, PARTNER]) {
      const { ctx, touched } = await makeCtx(who);
      await expectLims(call('getDepartmentIncomeReport', ctx, WINDOW), 'auth.forbidden', 403);
      expect(touched, who).toEqual([]);
    }
    expect(db.calls).toEqual([]);
  });

  it('bs_month + dates → 400; 400-day range → 422 analytics.range_too_large; bs_month 2100-01 → 422 common.date_out_of_range', async () => {
    await expectLims(call('getDepartmentIncomeReport', (await makeCtx(ADMIN)).ctx, { ...WINDOW, bs_month: '2082-07' }), 'common.validation_failed', 400);
    await expectLims(call('getDepartmentIncomeReport', (await makeCtx(ADMIN)).ctx, { business_date_from: '2025-01-01', business_date_to: '2026-02-05' }), 'analytics.range_too_large', 422);
    await expectLims(call('getDepartmentIncomeReport', (await makeCtx(ADMIN)).ctx, { bs_month: '2100-01' }), 'common.date_out_of_range', 422);
    expect(db.calls).toEqual([]);
  });

  it.each(['day', 'bs_month', 'branch', '', 'department; DROP TABLE x'])('group_by %j (not a department grouping) → 400 common.validation_failed before any query', async (group_by) => {
    const { ctx } = await makeCtx(ADMIN);
    await expectLims(call('getDepartmentIncomeReport', ctx, { ...WINDOW, group_by }), 'common.validation_failed', 400);
    expect(db.calls).toEqual([]);
  });

  it('a dependency failure is propagated, never an empty 200 with reconciles_with_income true', async () => {
    db.fail = new LimsError('common.dependency_unavailable');
    const { ctx } = await makeCtx(ADMIN);
    await expectLims(call('getDepartmentIncomeReport', ctx, WINDOW), 'common.dependency_unavailable', 503);
  });
});
