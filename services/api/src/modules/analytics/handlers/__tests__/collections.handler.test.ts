// C8 AN-T09 — getCollectionsReport (#4). PRD US-08.1–.5, M25–M29, R4 (Σ method = Σ staff = Σ centre incl. NULL centre), 08 A17 D-46, CR-C8-001,
// 02-TRD §5 #4 / §5.1 CollectionsReport / §6.3; 07-SECURITY REQ-SEC-013/017, P1, P4, P5, P12. Emulators: ./t09.helpers.ts (seedCollections()).
// Assumptions pinned: method key = payment_method_code, label = code unless a message-catalog entry exists (unknown code → the code itself);
// gateway captures (staff NULL) → key 'gateway', label "Online gateway"; NULL centre under group_by=centre → key 'none', label "No centre" (as AN-T08).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  A1, A2, ADMIN, NO_PERM, PARTNER, OWNER_A1, OWNER_ALL, FINANCE, FINANCE_A1, LAB_MANAGER, COLL_NO_CASH, D1, D2, S1, S2, WINDOW, CENTRE_NAME, B1,
  addDays, bsKey, golden, call09, contractErrors, db, expectLims, makeCtx09, ok09, rowByKey, seed09, seedCollections, cl, w,
} from './t09.helpers.js';

vi.mock('../../repository/rollups.repo.js', async () => (await import('./t09.helpers.js')).rollupsMock09);
vi.mock('../../repository/labels.repo.js', async () => (await import('./t09.helpers.js')).labelsRepoMock09);

const COLS = ['entries', 'reversals', 'gross_collected_paisa', 'reversed_paisa', 'net_collected_paisa'];
const pick = (o: any) => Object.fromEntries(COLS.map((k) => [k, o[k]]));
const C = (entries: number, reversals: number, gross_collected_paisa: number, reversed_paisa: number) =>
  ({ entries, reversals, gross_collected_paisa, reversed_paisa, net_collected_paisa: gross_collected_paisa - reversed_paisa });
const TOTAL = C(8, 1, 9000, 500);
const coll = (ctx: any, q: Record<string, unknown> = {}) => ok09('getCollectionsReport', ctx, { ...WINDOW, ...q });

beforeEach(() => { seed09(); seedCollections(); vi.clearAllMocks(); });

describe('US-08.1 — group_by=method (default): entries, reversals, gross, reversed, net', () => {
  it('rows per method, totals exact; net = gross − reversed on every row and in totals; contract-valid', async () => {
    const body = await coll((await makeCtx09(ADMIN)).ctx);
    expect(body.report_code).toBe('collections');
    expect(body.rows.map((r: any) => r.key).sort()).toEqual(['bank_transfer', 'cash', 'esewa']);
    expect(pick(rowByKey(body, 'cash'))).toEqual(C(5, 1, 7000, 500));
    expect(pick(rowByKey(body, 'esewa'))).toEqual(C(2, 0, 1300, 0));
    expect(pick(rowByKey(body, 'bank_transfer'))).toEqual(C(1, 0, 700, 0));
    expect(body.totals).toEqual(TOTAL);
    for (const r of body.rows) { expect(r.label, r.key).toBeTruthy(); expect(r.net_collected_paisa).toBe(r.gross_collected_paisa - r.reversed_paisa); }
    expect(contractErrors('CollectionsReport', body)).toEqual([]);
  });

  it('a payment method code with no catalog label falls back to the code itself', async () => {
    w.coll.push(cl(D1, A1, S1, 'zz_unknown', { entries: 1, gross: 10 }));
    const body = await coll((await makeCtx09(ADMIN)).ctx);
    expect(rowByKey(body, 'zz_unknown').label).toBe('zz_unknown');
  });

  it('rows outside [from, to) and tenant B payments never appear', async () => {
    const body = await coll((await makeCtx09(ADMIN)).ctx);
    expect(JSON.stringify(body)).not.toMatch(/999999|tenant_b_method/);
    expect(body.totals.gross_collected_paisa).toBe(9000); // 111 on D0 and 222 on D3 excluded
  });

  it('a reversal larger than the day\'s collections keeps a negative net (never clamped)', async () => {
    w.coll = [cl(D1, A1, S1, 'cash', { entries: 1, reversals: 1, gross: 100, reversed: 400 })];
    const body = await coll((await makeCtx09(ADMIN)).ctx);
    expect(rowByKey(body, 'cash').net_collected_paisa).toBe(-300);
    expect(body.totals.net_collected_paisa).toBe(-300);
    expect(contractErrors('CollectionsReport', body)).toEqual([]);
  });

  it('empty window → rows [] and zero integer totals', async () => {
    const body = await coll((await makeCtx09(ADMIN)).ctx, { business_date_from: '2030-01-01', business_date_to: '2030-01-08' });
    expect(body.rows).toEqual([]);
    expect(body.totals).toEqual(C(0, 0, 0, 0));
  });

  it('payment_method_code filter narrows rows and totals; > 20 codes → 400', async () => {
    const body = await coll((await makeCtx09(ADMIN)).ctx, { payment_method_code: ['esewa'] });
    expect(body.rows.map((r: any) => r.key)).toEqual(['esewa']);
    expect(body.totals).toEqual(C(2, 0, 1300, 0));
    const codes = Array.from({ length: 21 }, (_v, i) => `m${i}`);
    await expectLims(call09('getCollectionsReport', (await makeCtx09(ADMIN)).ctx, { ...WINDOW, payment_method_code: codes }), 'common.validation_failed', 400);
  });
});

describe('US-08.2 — group_by=staff: names from ctx.core.memberships, "(inactive)" flag, gateway row', () => {
  it('staff rows: S1 6700, S2 1500 (inactive, still named), gateway 300 "Online gateway"; one batched membership lookup with activeOnly:false for exactly the ids in the rows', async () => {
    const { ctx } = await makeCtx09(ADMIN);
    const body = await coll(ctx, { group_by: 'staff' });
    expect(pick(rowByKey(body, S1))).toMatchObject({ gross_collected_paisa: 6700, entries: 5 });
    expect(rowByKey(body, S1)).toMatchObject({ label: 'Test Cashier One' });
    expect(rowByKey(body, S1).is_inactive).toBeFalsy();
    expect(rowByKey(body, S2)).toMatchObject({ label: 'Test Cashier Two', is_inactive: true, gross_collected_paisa: 2000, net_collected_paisa: 1500 });
    expect(rowByKey(body, 'gateway')).toMatchObject({ label: 'Online gateway', gross_collected_paisa: 300 });
    const lists = db.calls.filter((c) => c.fn === 'memberships.list');
    expect(lists).toHaveLength(1);
    expect(lists[0]!.args).toMatchObject({ activeOnly: false });
    expect([...lists[0]!.args.membershipIds].sort()).toEqual([S1, S2].sort());
    expect(contractErrors('CollectionsReport', body)).toEqual([]);
  });

  it('no staff lookup for group_by=method (no needless directory read)', async () => {
    await coll((await makeCtx09(ADMIN)).ctx);
    expect(db.calls.filter((c) => c.fn === 'memberships.list')).toEqual([]);
  });

  it('a staff id the directory does not know still gets a row with a non-empty label (short id), no crash', async () => {
    w.coll.push(cl(D1, A1, 'ffffffff-ffff-4fff-8fff-ffffffffffff', 'cash', { entries: 1, gross: 5 }));
    const body = await coll((await makeCtx09(ADMIN)).ctx, { group_by: 'staff' });
    expect(rowByKey(body, 'ffffffff-ffff-4fff-8fff-ffffffffffff').label).toBeTruthy();
  });

  it('staff_method: one row per (staff, method) cell; cells sum to the totals; row labels name the staff', async () => {
    const body = await coll((await makeCtx09(ADMIN)).ctx, { group_by: 'staff_method' });
    expect(body.rows).toHaveLength(5); // S1·cash, S1·esewa, S1·bank_transfer, S2·cash, gateway·esewa
    expect(body.rows.reduce((s: number, r: any) => s + r.net_collected_paisa, 0)).toBe(8500);
    expect(body.rows.filter((r: any) => r.label.includes('Test Cashier One'))).toHaveLength(3);
    expect(new Set(body.rows.map((r: any) => r.key)).size).toBe(5);
    expect(body.totals).toEqual(TOTAL);
  });
});

describe('R4 — Σ_method M27 = Σ_staff M27 = Σ_centre M27 (incl. NULL centre) = day = ad_month = bs_month', () => {
  it('every grouping carries the same total and the sum of its rows equals it', async () => {
    const nets: number[] = [];
    for (const group_by of ['method', 'staff', 'staff_method', 'centre', 'day', 'ad_month', 'bs_month']) {
      const body = await coll((await makeCtx09(ADMIN)).ctx, { group_by });
      expect(body.totals.net_collected_paisa, group_by).toBe(8500);
      expect(body.rows.reduce((s: number, r: any) => s + r.net_collected_paisa, 0), group_by).toBe(8500);
      expect(body.rows.reduce((s: number, r: any) => s + r.gross_collected_paisa, 0), group_by).toBe(9000);
      nets.push(body.totals.net_collected_paisa);
    }
    expect(new Set(nets).size).toBe(1);
  });

  it('group_by=centre includes the NULL-centre (credit-party) payments for an all-centre caller, labelled "No centre"', async () => {
    const body = await coll((await makeCtx09(ADMIN)).ctx, { group_by: 'centre' });
    expect(rowByKey(body, A1)).toMatchObject({ label: CENTRE_NAME(A1), gross_collected_paisa: 6300 });
    expect(rowByKey(body, A2)).toMatchObject({ label: CENTRE_NAME(A2), net_collected_paisa: 1500 });
    expect(rowByKey(body, 'none')).toMatchObject({ label: 'No centre', gross_collected_paisa: 700 });
    expect(contractErrors('CollectionsReport', body)).toEqual([]);
  });
});

describe('time groupings', () => {
  it('day: keys are business dates ascending with label_bs; ad_month: YYYY-MM', async () => {
    const day = await coll((await makeCtx09(ADMIN)).ctx, { group_by: 'day' });
    expect(day.rows.map((r: any) => r.key)).toEqual([D1, D2]);
    expect(pick(day.rows[0])).toEqual(C(6, 1, 8000, 500));
    expect(pick(day.rows[1])).toEqual(C(2, 0, 1000, 0));
    expect(typeof day.rows[0].label_bs).toBe('string');
    const month = await coll((await makeCtx09(ADMIN)).ctx, { group_by: 'ad_month' });
    expect(month.rows.map((r: any) => r.key)).toEqual(['2026-11']);
  });

  it('bs_month over a bs_month period: label "YYYY-MM B.S.", only that month (golden boundaries)', async () => {
    const m = golden(2082, 7), first = m.ad_first_day, last = addDays(first, m.days - 1);
    w.coll = [cl(addDays(first, -1), A1, S1, 'cash', { entries: 1, gross: 1 }), cl(first, A1, S1, 'cash', { entries: 1, gross: 10 }),
      cl(last, A2, S1, 'esewa', { entries: 1, gross: 200 }), cl(addDays(first, m.days), A1, S1, 'cash', { entries: 1, gross: 5000 })];
    const body = await ok09('getCollectionsReport', (await makeCtx09(ADMIN)).ctx, { bs_month: bsKey(2082, 7), group_by: 'bs_month' });
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]).toMatchObject({ key: '2082-07', label: '2082-07 B.S.', gross_collected_paisa: 210, entries: 2 });
  });
});

describe('US-08.5 / US-15 — NULL-centre payments are all-centre only; restricted callers see their centres', () => {
  it('finance restricted to {A1}: A1 payments only (6300), no NULL-centre row, no A2 row, no bank_transfer method, scope echoed', async () => {
    const { ctx } = await makeCtx09(FINANCE_A1);
    const body = await coll(ctx);
    expect(body.totals).toEqual(C(5, 0, 6300, 0));
    expect(body.rows.map((r: any) => r.key).sort()).toEqual(['cash', 'esewa']);
    expect(body.scope).toMatchObject({ all_centres: false, centre_ids: [A1] });
    const byCentre = await coll((await makeCtx09(FINANCE_A1)).ctx, { group_by: 'centre' });
    expect(byCentre.rows.map((r: any) => r.key)).toEqual([A1]);
    expect(JSON.stringify(byCentre)).not.toMatch(new RegExp(`none|No centre|${CENTRE_NAME(A2)}`));
    const staff = await coll((await makeCtx09(FINANCE_A1)).ctx, { group_by: 'staff' });
    expect(staff.rows.map((r: any) => r.key).sort()).toEqual(['gateway', S1].sort()); // S2's payment was at A2
  });

  it('centre_id filter outside scope → 404 with no read; foreign tenant centre → 404; inside scope narrows', async () => {
    await expectLims(call09('getCollectionsReport', (await makeCtx09(FINANCE_A1)).ctx, { ...WINDOW, centre_id: [A2] }), 'common.not_found', 404);
    await expectLims(call09('getCollectionsReport', (await makeCtx09(ADMIN)).ctx, { ...WINDOW, centre_id: [B1] }), 'common.not_found', 404);
    expect(db.calls.filter((c) => c.fn === 'collectionRows')).toEqual([]);
    expect((await coll((await makeCtx09(ADMIN)).ctx, { centre_id: [A2] })).totals).toEqual(C(2, 1, 2000, 500));
  });

  it('the scope reaches the repository: restricted callers never get {all:true}', async () => {
    await coll((await makeCtx09(FINANCE_A1)).ctx);
    const c = db.calls.find((x) => x.fn === 'collectionRows')!;
    expect(c.args.scope).toEqual({ all: false, centreIds: [A1] });
    expect(c.args.tenantId).toBeTruthy();
  });
});

describe('US-08.3 / CR-C8-001 — permission is analytics.collections.read, not dashboard.read', () => {
  it.each([['dashboard.read only (lab_manager)', LAB_MANAGER], ['no analytics permission', NO_PERM], ['partner actor', PARTNER]])(
    '%s → 403 auth.forbidden, nothing read', async (_n, actor) => {
      const { ctx, touched } = await makeCtx09(actor);
      await expectLims(call09('getCollectionsReport', ctx, WINDOW), 'auth.forbidden', 403);
      expect(touched).toEqual([]);
      expect(db.calls).toEqual([]);
    });

  it.each([['finance (collections.read, no dashboard.read)', FINANCE], ['tenant_admin', ADMIN], ['owner_viewer', OWNER_ALL]])('%s → 200', async (_n, actor) => {
    expect((await call09('getCollectionsReport', (await makeCtx09(actor)).ctx, WINDOW)).status).toBe(200);
  });
});

describe('US-08.4 — daily cash link depends on billing.cash_report.read', () => {
  it('holder (finance, tenant_admin, owner_viewer) → daily_cash_route_id = staff.billing.daily_cash', async () => {
    for (const actor of [FINANCE, ADMIN, OWNER_ALL]) expect((await coll((await makeCtx09(actor)).ctx)).daily_cash_route_id, actor).toBe('staff.billing.daily_cash');
  });

  it('collections.read without billing.cash_report.read → field omitted (not null, not empty); response still contract-valid', async () => {
    const body = await coll((await makeCtx09(COLL_NO_CASH)).ctx);
    expect('daily_cash_route_id' in body).toBe(false);
    expect(contractErrors('CollectionsReport', body)).toEqual([]);
  });

  it('no session/variance/till data is returned anywhere in the body', async () => {
    const body = await coll((await makeCtx09(FINANCE)).ctx);
    expect(JSON.stringify(body)).not.toMatch(/session|variance|till|opening_balance/i);
  });
});

describe('validation and failure', () => {
  it.each(['week', '', 'method;drop table analytics.daily_collections', 'branch', 'METHOD'])('group_by %j outside the allow-list → 400, no read', async (group_by) => {
    await expectLims(call09('getCollectionsReport', (await makeCtx09(ADMIN)).ctx, { ...WINDOW, group_by }), 'common.validation_failed', 400);
    expect(db.calls.filter((c) => c.fn === 'collectionRows')).toEqual([]);
  });

  it('period errors: range_too_large 422', async () => {
    await expectLims(call09('getCollectionsReport', (await makeCtx09(ADMIN)).ctx, { business_date_from: '2025-01-01', business_date_to: '2026-02-05' }), 'analytics.range_too_large', 422);
  });

  it('a failing read propagates; a failing membership lookup is not swallowed into wrong labels', async () => {
    db.fail = new Error('boom');
    await expect(call09('getCollectionsReport', (await makeCtx09(ADMIN)).ctx, WINDOW)).rejects.toThrow('boom');
    db.fail = undefined;
    const { ctx } = await makeCtx09(ADMIN);
    ctx.core.memberships.list = vi.fn(async () => { throw new Error('directory down'); });
    await expect(call09('getCollectionsReport', ctx, { ...WINDOW, group_by: 'staff' })).rejects.toThrow('directory down');
  });
});
