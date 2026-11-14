// C8 AN-T09 — getTopReferrersReport (#6) and searchAnalyticsReferrers (#17). PRD US-05.1–.4, M30–M32, 08 A17 D-44 (volume only), 02-TRD §5 #6/#17,
// §5.1 TopReferrersReport, §6.4; 07-SECURITY REQ-SEC-013/017/081/098, P1, P13 (no money figure outside the referral report). Emulators: ./t09.helpers.ts.
// Not covered here: "cancelled orders excluded" (US-05.1) is a property of frontdesk.v_pub_referrer_volume feeding the rollup (AN-T05 refresh), not of the read path.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  A1, A2, B1, ADMIN, NO_PERM, PARTNER, OWNER_A1, FINANCE, LAB_MANAGER, D1, TA, WINDOW, R, REF_NAME,
  call09, contractErrors, db, expectLims, makeCtx09, ok09, rf, seed09, w,
} from './t09.helpers.js';

vi.mock('../../repository/rollups.repo.js', async () => (await import('./t09.helpers.js')).rollupsMock09);
vi.mock('../../repository/labels.repo.js', async () => (await import('./t09.helpers.js')).labelsRepoMock09);

const top = (ctx: any, q: Record<string, unknown> = {}) => ok09('getTopReferrersReport', ctx, { ...WINDOW, ...q });
const brief = (b: any) => b.rows.map((r: any) => [r.label, r.orders, r.patient_visits, r.tests_ordered]);
const SELF = 'SELF';

beforeEach(() => { seed09(); vi.clearAllMocks(); });

describe('US-05.1 — rows by orders, "SELF" for no referrer', () => {
  it('canonical rollup (default): ALPHA absorbs merged GAMMA (5+4); order -orders; SELF row has label "SELF", is_self, no referrer_id', async () => {
    const body = await top((await makeCtx09(ADMIN)).ctx);
    expect(body.report_code).toBe('top_referrers');
    expect(brief(body)).toEqual([[REF_NAME.ALPHA, 9, 9, 18], [REF_NAME.BETA, 3, 3, 3], [SELF, 2, 2, 2], [REF_NAME.DELTA, 1, 1, 1]]);
    expect(body.rows.map((r: any) => r.rank)).toEqual([1, 2, 3, 4]);
    const self = body.rows.find((r: any) => r.is_self);
    expect(self).toMatchObject({ label: SELF, orders: 2, is_inactive: false });
    expect('referrer_id' in self).toBe(false);
    expect(body.rows.filter((r: any) => !r.is_self).every((r: any) => typeof r.referrer_id === 'string')).toBe(true);
    expect(body.totals).toEqual({ orders: 15, patient_visits: 15, tests_ordered: 24 });
    expect(contractErrors('TopReferrersReport', body)).toEqual([]);
  });

  it('PRD example: D1 5 orders, D2 3, no referrer 2 → rows D1, D2, SELF with 5, 3, 2', async () => {
    w.refs = [rf(D1, A1, R.ALPHA, { orders: 5 }), rf(D1, A1, R.BETA, { orders: 3 }), rf(D1, A1, null, { orders: 2 })];
    const body = await top((await makeCtx09(ADMIN)).ctx);
    expect(brief(body).map((r: any) => [r[0], r[1]])).toEqual([[REF_NAME.ALPHA, 5], [REF_NAME.BETA, 3], [SELF, 2]]);
  });

  it('an inactive referrer keeps its historic row with is_inactive = true', async () => {
    const body = await top((await makeCtx09(ADMIN)).ctx);
    expect(body.rows.find((r: any) => r.label === REF_NAME.DELTA)).toMatchObject({ is_inactive: true, is_self: false, referrer_id: R.DELTA });
    expect(body.rows.find((r: any) => r.label === REF_NAME.ALPHA).is_inactive).toBe(false);
  });

  it('rows outside [from, to) and tenant B referrers never appear', async () => {
    const body = await top((await makeCtx09(ADMIN)).ctx);
    expect(JSON.stringify(body)).not.toMatch(new RegExp(`${REF_NAME.FOREIGN}|${R.FOREIGN}|999999`));
    expect(body.rows.find((r: any) => r.label === REF_NAME.BETA).orders).toBe(3); // 100 on D0 and 200 on D3 excluded
  });

  it('a referrer id unknown to the directory still gets a row (short-id label, never an empty label)', async () => {
    w.refs.push(rf(D1, A1, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', { orders: 1 }));
    const body = await top((await makeCtx09(ADMIN)).ctx);
    const row = body.rows.find((r: any) => r.referrer_id === 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect(row?.label).toBeTruthy();
    expect(row?.label).not.toBe(SELF);
  });
});

describe('US-05.2 — canonical merge (resolved at query time) and rollup=none', () => {
  it('rollup=none shows the merged referrer separately: ALPHA 5, GAMMA 4 (order -orders)', async () => {
    const body = await top((await makeCtx09(ADMIN)).ctx, { rollup: 'none' });
    expect(brief(body).map((r: any) => [r[0], r[1]])).toEqual([[REF_NAME.ALPHA, 5], [REF_NAME.GAMMA, 4], [REF_NAME.BETA, 3], [SELF, 2], [REF_NAME.DELTA, 1]]);
  });

  it('merges apply retroactively: re-pointing the canonical id changes the next answer with no rollup change', async () => {
    const { ctx } = await makeCtx09(ADMIN);
    expect(brief(await top(ctx)).slice(0, 2).map((r: any) => r[1])).toEqual([9, 3]);
    w.referrers.find((r) => r.referrer_id === R.GAMMA)!.canonical_referrer_id = R.BETA;
    const body = await top((await makeCtx09(ADMIN)).ctx);
    expect(brief(body).slice(0, 3).map((r: any) => [r[0], r[1]])).toEqual([[REF_NAME.BETA, 7], [REF_NAME.ALPHA, 5], [SELF, 2]]);
  });

  it('referrer_id filter (canonical): keeps keys whose canonical id is listed → ALPHA incl. merged GAMMA orders', async () => {
    const body = await top((await makeCtx09(ADMIN)).ctx, { referrer_id: [R.ALPHA] });
    expect(brief(body)).toEqual([[REF_NAME.ALPHA, 9, 9, 18]]);
    expect(body.totals).toEqual({ orders: 9, patient_visits: 9, tests_ordered: 18 });
  });

  it('referrer_id filter with rollup=none matches the raw id only; several ids allowed (≤ 20)', async () => {
    const one = await top((await makeCtx09(ADMIN)).ctx, { rollup: 'none', referrer_id: [R.ALPHA] });
    expect(brief(one)).toEqual([[REF_NAME.ALPHA, 5, 5, 10]]);
    const two = await top((await makeCtx09(ADMIN)).ctx, { rollup: 'none', referrer_id: [R.BETA, R.GAMMA] });
    expect(brief(two).map((r: any) => r[0])).toEqual([REF_NAME.GAMMA, REF_NAME.BETA]);
  });

  it('referrer_id filter never returns another tenant\'s referrer: a foreign id yields no row (or 404), never its figures', async () => {
    let status = 0; let body: any;
    try { const r = await call09('getTopReferrersReport', (await makeCtx09(ADMIN)).ctx, { ...WINDOW, referrer_id: [R.FOREIGN] }); status = r.status; body = r.body; }
    catch (e: any) { expect(e.code).toBe('common.not_found'); status = 404; }
    if (status === 200) expect(body.rows).toEqual([]);
    expect(JSON.stringify(body ?? {})).not.toMatch(new RegExp(`${REF_NAME.FOREIGN}|999999`));
  });

  it.each([[21], [50]])('more than 20 referrer_id values (%i) → 400 common.validation_failed', async (n) => {
    const ids = Array.from({ length: n }, (_v, i) => `bbbbbbbb-bbbb-4bbb-8bbb-${String(i).padStart(12, '0')}`);
    await expectLims(call09('getTopReferrersReport', (await makeCtx09(ADMIN)).ctx, { ...WINDOW, referrer_id: ids }), 'common.validation_failed', 400);
  });

  it.each([[{ rollup: 'merge' }], [{ rollup: '' }], [{ referrer_id: ['not-a-uuid'] }], [{ referrer_id: "x'; drop table analytics.daily_referrer_volume;--" }]])(
    'bad input %j → 400 common.validation_failed and no rollup read', async (q) => {
      await expectLims(call09('getTopReferrersReport', (await makeCtx09(ADMIN)).ctx, { ...WINDOW, ...q }), 'common.validation_failed', 400);
      expect(db.calls.filter((c) => c.fn === 'referrerVolumeRows')).toEqual([]);
    });
});

describe('US-05.3 / D-44 — volume only, never a money figure', () => {
  it('no row or total key is money-like; no billing/commission word anywhere in the body', async () => {
    const body = await top((await makeCtx09(ADMIN)).ctx);
    for (const r of body.rows) expect(Object.keys(r).sort()).toEqual(['is_inactive', 'is_self', 'label', 'orders', 'patient_visits', 'rank', 'tests_ordered', ...('referrer_id' in r ? ['referrer_id'] : [])].sort());
    expect(Object.keys(body.totals).sort()).toEqual(['orders', 'patient_visits', 'tests_ordered']);
    expect(JSON.stringify(body)).not.toMatch(/paisa|billed|commission|amount|incentive|payable/i);
  });

  it('only the volume rollup is read: no billing/income rollup call, no memberships call', async () => {
    const { ctx, touched } = await makeCtx09(ADMIN);
    await top(ctx);
    const fns = new Set(db.calls.map((c) => c.fn));
    expect([...fns].filter((f) => /billing|income|collection/i.test(f))).toEqual([]);
    expect(fns.has('referrerVolumeRows')).toBe(true);
    expect(touched).not.toContain('core.memberships');
  });

  it.each(['-net_billed_paisa', '-net_sales_paisa', 'net_billed_paisa', '-orders;drop', ''])('sort %j (money or unknown) → 400 common.validation_failed', async (sort) => {
    await expectLims(call09('getTopReferrersReport', (await makeCtx09(ADMIN)).ctx, { ...WINDOW, sort }), 'common.validation_failed', 400);
  });
});

describe('US-05.4 — sort, limit, ties', () => {
  it('sort -patient_visits and -tests_ordered reorder (rollup=none)', async () => {
    w.refs = [rf(D1, A1, R.ALPHA, { orders: 9, pat: 1, items: 5 }), rf(D1, A1, R.BETA, { orders: 2, pat: 8, items: 1 }), rf(D1, A1, null, { orders: 1, pat: 3, items: 9 })];
    const q = { rollup: 'none' };
    expect((await top((await makeCtx09(ADMIN)).ctx, q)).rows.map((r: any) => r.label)).toEqual([REF_NAME.ALPHA, REF_NAME.BETA, SELF]);
    expect((await top((await makeCtx09(ADMIN)).ctx, { ...q, sort: '-patient_visits' })).rows.map((r: any) => r.label)).toEqual([REF_NAME.BETA, SELF, REF_NAME.ALPHA]);
    expect((await top((await makeCtx09(ADMIN)).ctx, { ...q, sort: '-tests_ordered' })).rows.map((r: any) => r.label)).toEqual([SELF, REF_NAME.ALPHA, REF_NAME.BETA]);
  });

  it('limit defaults to 20 and caps rows; ranks are 1..n after truncation', async () => {
    const many = Array.from({ length: 25 }, (_v, i) => `cccccccc-cccc-4ccc-8ccc-${String(i).padStart(12, '0')}`);
    many.forEach((id, i) => { w.referrers.push({ tenantId: TA, referrer_id: id, display_name: `Dr. Many ${String(i).padStart(2, '0')}`, is_active: true, canonical_referrer_id: null }); w.refs.push(rf(D1, A1, id, { orders: 100 + i })); });
    const def = await top((await makeCtx09(ADMIN)).ctx);
    expect(def.rows).toHaveLength(20);
    expect(def.rows.map((r: any) => r.rank)).toEqual(Array.from({ length: 20 }, (_v, i) => i + 1));
    expect(def.rows[0].orders).toBe(124);
    const three = await top((await makeCtx09(ADMIN)).ctx, { limit: 3 });
    expect(three.rows.map((r: any) => r.orders)).toEqual([124, 123, 122]);
    expect((await top((await makeCtx09(ADMIN)).ctx, { limit: 100 })).rows).toHaveLength(29); // 25 + ALPHA, BETA, SELF, DELTA
  });

  it.each([[0], [101], [-5], [2.5], ['x']])('limit %j → 400 common.validation_failed', async (limit) => {
    await expectLims(call09('getTopReferrersReport', (await makeCtx09(ADMIN)).ctx, { ...WINDOW, limit }), 'common.validation_failed', 400);
  });

  it('ties broken by display name, then by id', async () => {
    const X = 'dddddddd-dddd-4ddd-8ddd-000000000002', Y = 'dddddddd-dddd-4ddd-8ddd-000000000001', Z = 'dddddddd-dddd-4ddd-8ddd-000000000003';
    w.referrers.push(
      { tenantId: TA, referrer_id: X, display_name: 'Dr. Same Name', is_active: true, canonical_referrer_id: null },
      { tenantId: TA, referrer_id: Y, display_name: 'Dr. Same Name', is_active: true, canonical_referrer_id: null },
      { tenantId: TA, referrer_id: Z, display_name: 'Dr. Aaa First', is_active: true, canonical_referrer_id: null },
    );
    w.refs = [rf(D1, A1, X, { orders: 4 }), rf(D1, A1, Y, { orders: 4 }), rf(D1, A1, Z, { orders: 4 })];
    const body = await top((await makeCtx09(ADMIN)).ctx);
    expect(body.rows.map((r: any) => r.referrer_id)).toEqual([Z, Y, X]);
  });
});

describe('centre scoping (US-15) and authz', () => {
  it('centre-restricted {A1}: only A1 volume (ALPHA 3 + GAMMA 4 = 7 canonical; A2\'s 2 excluded); scope echoed', async () => {
    const body = await top((await makeCtx09(OWNER_A1)).ctx);
    expect(brief(body).map((r: any) => [r[0], r[1]])).toEqual([[REF_NAME.ALPHA, 7], [REF_NAME.BETA, 3], [SELF, 2], [REF_NAME.DELTA, 1]]);
    expect(body.scope).toMatchObject({ all_centres: false, centre_ids: [A1] });
  });

  it('centre_id filter: inside scope narrows (A2 → ALPHA 2 only); outside scope or foreign tenant → 404 with no read', async () => {
    const narrowed = await top((await makeCtx09(ADMIN)).ctx, { centre_id: [A2] });
    expect(brief(narrowed)).toEqual([[REF_NAME.ALPHA, 2, 2, 4]]);
    db.calls.length = 0;
    await expectLims(call09('getTopReferrersReport', (await makeCtx09(OWNER_A1)).ctx, { ...WINDOW, centre_id: [A2] }), 'common.not_found', 404);
    await expectLims(call09('getTopReferrersReport', (await makeCtx09(ADMIN)).ctx, { ...WINDOW, centre_id: [B1] }), 'common.not_found', 404);
    expect(db.calls.filter((c) => c.fn === 'referrerVolumeRows')).toEqual([]);
  });

  it.each([['no permission', NO_PERM], ['partner', PARTNER], ['finance (no dashboard.read)', FINANCE]])('%s → 403 auth.forbidden before any read', async (_n, actor) => {
    const { ctx, touched } = await makeCtx09(actor);
    await expectLims(call09('getTopReferrersReport', ctx, WINDOW), 'auth.forbidden', 403);
    expect(touched).toEqual([]);
    expect(db.calls).toEqual([]);
  });

  it('lab_manager (dashboard.read only) is allowed — the report is not privileged', async () => {
    expect((await call09('getTopReferrersReport', (await makeCtx09(LAB_MANAGER)).ctx, WINDOW)).status).toBe(200);
  });
});

// ============================================================================================================== search
const search = (ctx: any, query: unknown) => call09('searchAnalyticsReferrers', ctx, {}, { query });

describe('searchAnalyticsReferrers (#17) — POST body, never the URL', () => {
  it('finds referrers by case-insensitive substring; returns {data:[{referrer_id,label,is_active}]} only; inactive included flagged; other tenants excluded', async () => {
    const r = await search((await makeCtx09(ADMIN)).ctx, 'dr. test');
    expect(r.status).toBe(200);
    expect(r.body.data.map((d: any) => d.referrer_id).sort()).toEqual([R.ALPHA, R.BETA, R.GAMMA, R.DELTA].sort());
    expect(Object.keys(r.body)).toEqual(['data']);
    for (const d of r.body.data) expect(Object.keys(d).sort()).toEqual(['is_active', 'label', 'referrer_id']);
    expect(r.body.data.find((d: any) => d.referrer_id === R.DELTA)).toMatchObject({ label: REF_NAME.DELTA, is_active: false });
    expect(JSON.stringify(r.body)).not.toContain(REF_NAME.FOREIGN);
  });

  it('narrow term → one hit; no hit → data []', async () => {
    expect((await search((await makeCtx09(ADMIN)).ctx, 'alpha')).body.data.map((d: any) => d.referrer_id)).toEqual([R.ALPHA]);
    expect((await search((await makeCtx09(ADMIN)).ctx, 'zzzz-no-such')).body).toEqual({ data: [] });
  });

  it('answers at most 20 rows', async () => {
    for (let i = 0; i < 30; i++) w.referrers.push({ tenantId: TA, referrer_id: `eeeeeeee-eeee-4eee-8eee-${String(i).padStart(12, '0')}`, display_name: `Dr. Bulk ${i}`, is_active: true, canonical_referrer_id: null });
    expect((await search((await makeCtx09(ADMIN)).ctx, 'bulk')).body.data).toHaveLength(20);
  });

  it('the search term goes to the repository as a value for the tenant of the caller (not concatenated, not another tenant)', async () => {
    const { ctx } = await makeCtx09(ADMIN);
    await search(ctx, 'alpha');
    const c = db.calls.find((x) => x.fn === 'searchReferrers')!;
    expect(c.args).toMatchObject({ tenantId: ctx.tenantId, query: 'alpha' });
  });

  it.each([[''], ['a'], ['x'.repeat(61)], [undefined], [null], [42], [['alpha']], [{ $ne: '' }]])('query %j → 400 common.validation_failed, no repository call', async (q) => {
    await expectLims(search((await makeCtx09(ADMIN)).ctx, q), 'common.validation_failed', 400);
    expect(db.calls.filter((c) => c.fn === 'searchReferrers')).toEqual([]);
  });

  it('boundary lengths 2 and 60 are accepted', async () => {
    expect((await search((await makeCtx09(ADMIN)).ctx, 'dr')).status).toBe(200);
    expect((await search((await makeCtx09(ADMIN)).ctx, 'x'.repeat(60))).status).toBe(200);
  });

  it('a missing body → 400 common.validation_failed', async () => {
    await expectLims(call09('searchAnalyticsReferrers', (await makeCtx09(ADMIN)).ctx, {}, undefined), 'common.validation_failed', 400);
  });

  it.each([['no permission', NO_PERM], ['partner', PARTNER], ['finance', FINANCE]])('%s → 403 auth.forbidden before any read', async (_n, actor) => {
    const { ctx, touched } = await makeCtx09(actor);
    await expectLims(search(ctx, 'alpha'), 'auth.forbidden', 403);
    expect(touched).toEqual([]);
    expect(db.calls).toEqual([]);
  });

  it('the answer does not depend on the caller\'s centre scope (a directory lookup, no figures) and carries no request echo', async () => {
    const r = await search((await makeCtx09(OWNER_A1)).ctx, 'alpha');
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toContain('"query"');
  });
});
