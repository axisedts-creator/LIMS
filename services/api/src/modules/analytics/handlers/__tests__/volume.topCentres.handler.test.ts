// C8 AN-T09 — getVolumeReport (#5) and getTopCentresReport (#7). PRD US-06.1/.2, M01–M08, M35–M38, 02-TRD §5 #5/#7, §5.1 VolumeReport/TopCentresReport,
// §6.4; 07-SECURITY REQ-SEC-013/017/081, P1, P3, P4, P5. Repos are in-memory emulators (./t09.helpers.ts); handler + service + mapper + labels are real.
// Assumption pinned for #7: `sort` defaults to -orders (first enum value; the TRD row names no default).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  A1, A2, A3, B1, BR1, BR2, ADMIN, NO_PERM, PARTNER, OWNER_A1, OWNER_ALL, OWNER_MULTI, FINANCE, LAB_MANAGER, D0, D1, D2, D3, WINDOW,
  BRANCH_NAME, CENTRE_NAME, addDays, bsKey, golden, call09, contractErrors, db, expectLims, incFact, makeCtx09, ok09, ord, cv, rowByKey, seed09, w,
} from './t09.helpers.js';

vi.mock('../../repository/rollups.repo.js', async () => (await import('./t09.helpers.js')).rollupsMock09);
vi.mock('../../repository/labels.repo.js', async () => (await import('./t09.helpers.js')).labelsRepoMock09);

const COLS = ['orders_registered', 'orders_cancelled', 'net_orders', 'patient_visits', 'new_patients', 'urgent_orders', 'opd_orders', 'ipd_orders', 'tests_ordered'];
const pick = (o: any) => Object.fromEntries(COLS.map((k) => [k, o[k]]));
const V = (orders_registered: number, orders_cancelled: number, patient_visits: number, new_patients: number, urgent_orders: number, opd_orders: number, ipd_orders: number, tests_ordered: number) =>
  ({ orders_registered, orders_cancelled, net_orders: orders_registered - orders_cancelled, patient_visits, new_patients, urgent_orders, opd_orders, ipd_orders, tests_ordered });
// Hand-computed from seed09(), window [D1, D3).
const VOL_D1 = V(15, 1, 13, 3, 3, 10, 3, 36), VOL_D2 = V(4, 2, 3, 0, 1, 2, 2, 9), VOL_ALL = V(19, 3, 16, 3, 4, 12, 5, 45);
const VOL_A1 = V(14, 3, 11, 2, 4, 8, 4, 34), VOL_A2 = V(5, 0, 5, 1, 0, 4, 1, 11);

beforeEach(() => { seed09(); vi.clearAllMocks(); });

describe('getVolumeReport — US-06 / M01–M08', () => {
  it('group_by=day (default): one ascending row per business date; M03 net_orders = M01 − M02; M08 tests_ordered from centre volume; day rows carry label_bs', async () => {
    const { ctx } = await makeCtx09(ADMIN);
    const body = await ok09('getVolumeReport', ctx, WINDOW);
    expect(body.report_code).toBe('volume');
    expect(body.rows.map((r: any) => r.key)).toEqual([D1, D2]);
    expect(pick(body.rows[0])).toEqual(VOL_D1);
    expect(pick(body.rows[1])).toEqual(VOL_D2);
    expect(typeof body.rows[0].label_bs).toBe('string');
    expect(body.rows[0].label).toBeTruthy();
  });

  it('totals = exact sum of rows; no key/label in totals; contract-valid (incl. freshness array and period/scope echo)', async () => {
    const { ctx } = await makeCtx09(ADMIN);
    const body = await ok09('getVolumeReport', ctx, WINDOW);
    expect(body.totals).toEqual(VOL_ALL);
    expect(contractErrors('VolumeReport', body)).toEqual([]);
    expect(body.period).toMatchObject({ business_date_from: D1, business_date_to: D3, days: 2, timezone: 'Asia/Kathmandu' });
    expect(body.scope).toMatchObject({ all_centres: true });
  });

  it('rows outside [from, to) and every other tenant\'s rows never appear (absurd tenant B values would show)', async () => {
    const { ctx } = await makeCtx09(ADMIN);
    const body = await ok09('getVolumeReport', ctx, WINDOW);
    expect(JSON.stringify(body)).not.toMatch(/999999|\b111\b|\b222\b/);
    expect(body.rows.map((r: any) => r.key)).not.toContain(D0);
    expect(body.rows.map((r: any) => r.key)).not.toContain(D3);
  });

  it('group_by=centre: key = centre uuid, label = centre name from ctx.core (inactive centre flagged), sums per centre', async () => {
    w.orders.push(ord(D1, A3, { reg: 2, pat: 2, opd: 2 }));
    w.cvol.push(cv(D1, A3, 'walk_in', { orders: 2, pat: 2, items: 3 }));
    const { ctx } = await makeCtx09(ADMIN);
    const body = await ok09('getVolumeReport', ctx, { ...WINDOW, group_by: 'centre' });
    expect(pick(rowByKey(body, A1))).toEqual(VOL_A1);
    expect(pick(rowByKey(body, A2))).toEqual(VOL_A2);
    expect(rowByKey(body, A1).label).toBe(CENTRE_NAME(A1));
    expect(rowByKey(body, A3)).toMatchObject({ label: CENTRE_NAME(A3), is_inactive: true, orders_registered: 2, tests_ordered: 3 });
    expect(rowByKey(body, A1).is_inactive).toBeFalsy();
  });

  it('group_by=branch: A1+A2 roll up to BR1, A3 to BR2; labels from ctx.core.branches', async () => {
    w.orders.push(ord(D1, A3, { reg: 2, pat: 2 }));
    w.cvol.push(cv(D1, A3, 'walk_in', { orders: 2, pat: 2, items: 3 }));
    const { ctx } = await makeCtx09(ADMIN);
    const body = await ok09('getVolumeReport', ctx, { ...WINDOW, group_by: 'branch' });
    expect(body.rows).toHaveLength(2);
    expect(pick(rowByKey(body, BR1))).toEqual(VOL_ALL);
    expect(rowByKey(body, BR1).label).toBe(BRANCH_NAME(BR1));
    expect(rowByKey(body, BR2)).toMatchObject({ orders_registered: 2, tests_ordered: 3, label: BRANCH_NAME(BR2) });
  });

  it('group_by=ad_month: key YYYY-MM, exact sums across the month', async () => {
    const { ctx } = await makeCtx09(ADMIN);
    const body = await ok09('getVolumeReport', ctx, { ...WINDOW, group_by: 'ad_month' });
    expect(body.rows.map((r: any) => r.key)).toEqual(['2026-11']);
    expect(pick(body.rows[0])).toEqual(VOL_ALL);
  });

  it('group_by=bs_month over a bs_month period: key YYYY-MM, label "YYYY-MM B.S.", only that B.S. month (golden boundaries, no leak at day 1 / last day)', async () => {
    const m = golden(2082, 7), first = m.ad_first_day, last = addDays(first, m.days - 1);
    w.orders.push(ord(addDays(first, -1), A1, { reg: 100 }), ord(first, A1, { reg: 2, canc: 1 }), ord(last, A2, { reg: 3, urgent: 1 }), ord(addDays(first, m.days), A1, { reg: 700 }));
    w.cvol.push(cv(first, A1, 'walk_in', { orders: 2, pat: 2, items: 5 }), cv(last, A2, 'centre', { orders: 3, pat: 3, items: 4 }));
    const { ctx } = await makeCtx09(ADMIN);
    const body = await ok09('getVolumeReport', ctx, { bs_month: bsKey(2082, 7), group_by: 'bs_month' });
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]).toMatchObject({ key: '2082-07', label: '2082-07 B.S.', orders_registered: 5, orders_cancelled: 1, net_orders: 4, urgent_orders: 1, tests_ordered: 9 });
    expect(pick(body.totals)).toEqual(pick(body.rows[0]));
  });

  it('empty window → rows [] and all-zero integer totals, contract-valid', async () => {
    const { ctx } = await makeCtx09(ADMIN);
    const body = await ok09('getVolumeReport', ctx, { business_date_from: '2030-01-01', business_date_to: '2030-01-08' });
    expect(body.rows).toEqual([]);
    expect(body.totals).toEqual(V(0, 0, 0, 0, 0, 0, 0, 0));
    expect(contractErrors('VolumeReport', body)).toEqual([]);
  });

  it('M03 net orders may be negative per row and is never clamped (cancellations of earlier-registered orders)', async () => {
    w.orders = [ord(D1, A1, { reg: 1, canc: 3 })];
    const { ctx } = await makeCtx09(ADMIN);
    const body = await ok09('getVolumeReport', ctx, WINDOW);
    expect(body.rows[0].net_orders).toBe(-2);
    expect(body.totals.net_orders).toBe(-2);
    expect(contractErrors('VolumeReport', body)).toEqual([]);
  });
});

describe('getVolumeReport — centre scoping (US-15, P3/P4/P5)', () => {
  it('centre-restricted {A1}: figures computed only from A1 rows; scope echoes the centre, never all_centres', async () => {
    const { ctx } = await makeCtx09(OWNER_A1);
    const body = await ok09('getVolumeReport', ctx, WINDOW);
    expect(pick(body.totals)).toEqual(VOL_A1);
    expect(body.scope).toMatchObject({ all_centres: false, centre_ids: [A1] });
    const grouped = await ok09('getVolumeReport', (await makeCtx09(OWNER_A1)).ctx, { ...WINDOW, group_by: 'centre' });
    expect(grouped.rows.map((r: any) => r.key)).toEqual([A1]);
    expect(JSON.stringify(grouped)).not.toContain(CENTRE_NAME(A2));
  });

  it('restricted {A1,A2}: both centres; a branch filter never widens beyond the caller scope (BR2 → nothing)', async () => {
    const { ctx } = await makeCtx09(OWNER_MULTI);
    expect(pick((await ok09('getVolumeReport', ctx, WINDOW)).totals)).toEqual(VOL_ALL);
    const b = await ok09('getVolumeReport', (await makeCtx09(OWNER_MULTI)).ctx, { ...WINDOW, branch_id: [BR2] });
    expect(pick(b.totals)).toEqual(V(0, 0, 0, 0, 0, 0, 0, 0));
  });

  it('centre_id filter outside the caller scope → 404 common.not_found, no rollup read; foreign-tenant centre → 404 even for an all-centre caller', async () => {
    const { ctx } = await makeCtx09(OWNER_A1);
    await expectLims(call09('getVolumeReport', ctx, { ...WINDOW, centre_id: [A2] }), 'common.not_found', 404);
    await expectLims(call09('getVolumeReport', (await makeCtx09(ADMIN)).ctx, { ...WINDOW, centre_id: [B1] }), 'common.not_found', 404);
    expect(db.calls.filter((c) => c.fn === 'volumeRows')).toEqual([]);
  });

  it('centre_id filter inside scope narrows the figures to that centre', async () => {
    const { ctx } = await makeCtx09(ADMIN);
    expect(pick((await ok09('getVolumeReport', ctx, { ...WINDOW, centre_id: [A2] })).totals)).toEqual(VOL_A2);
  });
});

describe('getVolumeReport — authz, validation, failure', () => {
  it.each([['no analytics permission', NO_PERM], ['partner actor', PARTNER], ['finance (collections only, no dashboard.read)', FINANCE]])(
    '%s → 403 auth.forbidden before anything is read', async (_n, actor) => {
      const { ctx, touched } = await makeCtx09(actor);
      await expectLims(call09('getVolumeReport', ctx, WINDOW), 'auth.forbidden', 403);
      expect(touched).toEqual([]);
      expect(db.calls).toEqual([]);
    });

  it.each(['week', '', 'day;drop table analytics.daily_orders', 'department', 'bs_month '])('group_by %j is outside the allow-list → 400 common.validation_failed, no read', async (group_by) => {
    const { ctx } = await makeCtx09(ADMIN);
    await expectLims(call09('getVolumeReport', ctx, { ...WINDOW, group_by }), 'common.validation_failed', 400);
    expect(db.calls).toEqual([]);
  });

  it('period errors: 400 invalid combination, 422 range_too_large / date_out_of_range', async () => {
    await expectLims(call09('getVolumeReport', (await makeCtx09(ADMIN)).ctx, { ...WINDOW, bs_month: '2082-07' }), 'common.validation_failed', 400);
    await expectLims(call09('getVolumeReport', (await makeCtx09(ADMIN)).ctx, { business_date_from: '2025-01-01', business_date_to: '2026-02-05' }), 'analytics.range_too_large', 422);
    await expectLims(call09('getVolumeReport', (await makeCtx09(ADMIN)).ctx, { bs_month: '2100-01' }), 'common.date_out_of_range', 422);
  });

  it('a failing rollup read propagates (no partial 200 body)', async () => {
    db.fail = new Error('boom');
    await expect(call09('getVolumeReport', (await makeCtx09(ADMIN)).ctx, WINDOW)).rejects.toThrow('boom');
  });
});

// ============================================================================================================== top centres
const TC = ['rank', 'centre_id', 'label', 'branch_id', 'orders', 'patient_visits', 'tests_ordered', 'net_sales_paisa', 'by_mode'];

/** Adds A3 so every sort key yields a different order: orders A3 20 > A1 14 > A2 5; net A1 9430 > A2 5650 > A3 100; pv A3 20 > A1 11 > A2 5; items A1 34 > A2 11 > A3 2. */
function addA3(): void {
  w.cvol.push(cv(D1, A3, 'partner', { orders: 20, pat: 20, items: 2 }));
  db.income.push(incFact(D1, A3, { taxable: 100 }));
}

describe('getTopCentresReport — US-06.1 / M35–M38', () => {
  it('one row per centre with orders, patient visits, tests ordered, net sales (M38 = M12 by centre) and the collection-mode split; default sort -orders; rank from 1', async () => {
    const { ctx } = await makeCtx09(ADMIN);
    const body = await ok09('getTopCentresReport', ctx, WINDOW);
    expect(body.report_code).toBe('top_centres');
    expect(body.rows.map((r: any) => r.centre_id)).toEqual([A1, A2]);
    expect(body.rows[0]).toEqual({
      rank: 1, centre_id: A1, label: CENTRE_NAME(A1), branch_id: BR1, orders: 14, patient_visits: 11, tests_ordered: 34, net_sales_paisa: 9430,
      by_mode: { walk_in: 11, home: 3, centre: 0, partner: 0 },
    });
    expect(body.rows[1]).toEqual({
      rank: 2, centre_id: A2, label: CENTRE_NAME(A2), branch_id: BR1, orders: 5, patient_visits: 5, tests_ordered: 11, net_sales_paisa: 5650,
      by_mode: { walk_in: 0, home: 0, centre: 5, partner: 0 },
    });
    expect(Object.keys(body.rows[0]).sort()).toEqual([...TC].sort());
    expect(body.totals).toEqual({ orders: 19, patient_visits: 16, tests_ordered: 45, net_sales_paisa: 15080 });
    expect(contractErrors('TopCentresReport', body)).toEqual([]);
  });

  it('by_mode sums to orders for every row (home collection included)', async () => {
    const { ctx } = await makeCtx09(ADMIN);
    for (const r of (await ok09('getTopCentresReport', ctx, WINDOW)).rows) expect(Object.values(r.by_mode).reduce((a: number, b: any) => a + b, 0), r.label).toBe(r.orders);
  });

  it.each([
    ['-orders', [A3, A1, A2]], ['-net_sales_paisa', [A1, A2, A3]], ['-patient_visits', [A3, A1, A2]], ['-tests_ordered', [A1, A2, A3]],
  ])('sort=%s orders the rows and ranks 1..n', async (sort, expected) => {
    addA3();
    const { ctx } = await makeCtx09(ADMIN);
    const body = await ok09('getTopCentresReport', ctx, { ...WINDOW, sort });
    expect(body.rows.map((r: any) => r.centre_id)).toEqual(expected);
    expect(body.rows.map((r: any) => r.rank)).toEqual([1, 2, 3]);
  });

  it('ties are broken by label then id', async () => {
    w.cvol = [cv(D1, A1, 'walk_in', { orders: 5, pat: 5, items: 5 }), cv(D1, A2, 'walk_in', { orders: 5, pat: 5, items: 5 })];
    const { ctx } = await makeCtx09(ADMIN);
    const body = await ok09('getTopCentresReport', ctx, WINDOW);
    expect(body.rows.map((r: any) => r.centre_id)).toEqual([A1, A2].sort((x, y) => CENTRE_NAME(x).localeCompare(CENTRE_NAME(y)) || x.localeCompare(y)));
  });

  it('limit truncates after ranking (default 20, 1..50 accepted); a zero-net-sales centre shows 0, not null', async () => {
    addA3();
    db.income = db.income.filter((f) => f.centreId !== A2);
    const { ctx } = await makeCtx09(ADMIN);
    const body = await ok09('getTopCentresReport', ctx, { ...WINDOW, limit: 2, sort: '-orders' });
    expect(body.rows.map((r: any) => r.centre_id)).toEqual([A3, A1]);
    const all = await ok09('getTopCentresReport', (await makeCtx09(ADMIN)).ctx, WINDOW);
    expect(all.rows.find((r: any) => r.centre_id === A2).net_sales_paisa).toBe(0);
    expect(contractErrors('TopCentresReport', all)).toEqual([]);
  });

  it.each([[0], [51], [-1], [1.5], ['abc']])('limit %j → 400 common.validation_failed', async (limit) => {
    await expectLims(call09('getTopCentresReport', (await makeCtx09(ADMIN)).ctx, { ...WINDOW, limit }), 'common.validation_failed', 400);
  });

  it.each(['-net_billed_paisa', 'orders', '-orders;select 1', ''])('sort %j outside the allow-list → 400', async (sort) => {
    await expectLims(call09('getTopCentresReport', (await makeCtx09(ADMIN)).ctx, { ...WINDOW, sort }), 'common.validation_failed', 400);
  });
});

describe('getTopCentresReport — US-06.2 centre-restricted: no rank among other centres is revealed', () => {
  it('{A1} sees only its row, ranked 1 (even though it would be #2 tenant-wide when A3 is bigger); totals cover only A1; nothing names another centre', async () => {
    addA3();
    const { ctx } = await makeCtx09(OWNER_A1);
    const body = await ok09('getTopCentresReport', ctx, WINDOW);
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]).toMatchObject({ rank: 1, centre_id: A1, orders: 14, net_sales_paisa: 9430 });
    expect(body.totals).toEqual({ orders: 14, patient_visits: 11, tests_ordered: 34, net_sales_paisa: 9430 });
    expect(JSON.stringify(body)).not.toMatch(new RegExp(`${A2}|${A3}|${CENTRE_NAME(A2)}|${CENTRE_NAME(A3)}`));
  });

  it('centre_id outside scope → 404 and no read; another tenant\'s centre → 404', async () => {
    await expectLims(call09('getTopCentresReport', (await makeCtx09(OWNER_A1)).ctx, { ...WINDOW, centre_id: [A2] }), 'common.not_found', 404);
    await expectLims(call09('getTopCentresReport', (await makeCtx09(ADMIN)).ctx, { ...WINDOW, centre_id: [B1] }), 'common.not_found', 404);
    expect(db.calls.filter((c) => c.fn === 'topCentresRows')).toEqual([]);
  });

  it('tenant B centre figures never appear for tenant A', async () => {
    const body = await ok09('getTopCentresReport', (await makeCtx09(ADMIN)).ctx, WINDOW);
    expect(body.rows.map((r: any) => r.centre_id)).not.toContain(B1);
    expect(JSON.stringify(body)).not.toContain('999999');
  });
});

describe('getTopCentresReport — authz', () => {
  it.each([['no permission', NO_PERM], ['partner', PARTNER], ['finance', FINANCE]])('%s → 403 auth.forbidden, nothing read', async (_n, actor) => {
    const { ctx, touched } = await makeCtx09(actor);
    await expectLims(call09('getTopCentresReport', ctx, WINDOW), 'auth.forbidden', 403);
    expect(touched).toEqual([]);
    expect(db.calls).toEqual([]);
  });

  it('lab_manager and owner_viewer (analytics.dashboard.read) are allowed on both reports', async () => {
    for (const actor of [LAB_MANAGER, OWNER_ALL]) {
      expect((await call09('getTopCentresReport', (await makeCtx09(actor)).ctx, WINDOW)).status).toBe(200);
      expect((await call09('getVolumeReport', (await makeCtx09(actor)).ctx, WINDOW)).status).toBe(200);
    }
  });
});
