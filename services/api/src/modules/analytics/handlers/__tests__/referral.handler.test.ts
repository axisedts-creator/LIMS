// C8 AN-T10 — getReferralIncentiveReport (#8). PRD US-07.1–.5 (+ US-05.3 / D-44: the ONLY response carrying net_billed_paisa), 02-TRD §5 #8, §5.1
// ReferralIncentiveReport, §5.2 (assertRole -> flag -> read -> ctx.audit.access), §6.4, §9 (access log), CR-C8-006; 07-SECURITY REQ-SEC-062/067/096/097, E7–E9, P1, P3, P4.
// Emulators + pinned seams: ./t10.helpers.ts. The access log is the REAL core/audit/access.ts validator + INSERT on ctx.tx.
// Assumptions the spec leaves open (pinned here, writer may dispute via the reviewer): row order = -orders, label, id (as top referrers) and, for the *_month
// group_bys, period_key ascending first; totals cover the whole period (not the page); a refused request (forbidden / mfa / flag / validation) writes NO access_log row.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  A1, A2, ADMIN, D1, D3, FINANCE, LAB_MANAGER, NO_PERM, OWNER, OWNER_A1, OWNER_AAL1, OWNER_REVOKED, PARTNER, R, REF_NAME, REF_ZETA, R_ZETA, WINDOW,
  addDays, bf, bsKey, call09, contractErrors, db, expectLims, getRef, golden, makeCtx10, okRef, rf, rejection, seed10, w, wb,
} from './t10.helpers.js';

vi.mock('../../repository/rollups.repo.js', async () => (await import('./t10.helpers.js')).rollupsMock10);
vi.mock('../../repository/labels.repo.js', async () => (await import('./t10.helpers.js')).labelsRepoMock09);

const SELF = 'SELF';
const NOTE = 'analytics.referrers.billed_note';
const WORD = ['commis', 'sion'].join('');
const reads = () => db.calls.filter((c) => /^referrer(Volume|Billing)Rows$/.test(c.fn));
const brief = (b: any) => b.rows.map((r: any) => [r.label, r.orders, r.patient_visits, r.tests_ordered, r.net_billed_paisa]);
const raw = (ctx: any, q: Record<string, unknown>) => call09('getReferralIncentiveReport' as never, ctx, q);
const ROW_KEYS = ['is_self', 'label', 'net_billed_paisa', 'orders', 'patient_visits', 'referrer_id', 'tests_ordered'];
const SELF_KEYS = ['is_self', 'label', 'orders', 'patient_visits', 'tests_ordered'];

beforeEach(() => { seed10(); vi.clearAllMocks(); });

/** Nothing was read, nothing was logged, no flag lookup (for the cases that must stop before it). */
function expectUntouched(c: Awaited<ReturnType<typeof makeCtx10>>, opts: { flagRead?: boolean } = {}) {
  expect(reads()).toEqual([]);
  expect(db.calls.filter((x) => x.fn !== 'memberships.list')).toEqual([]);
  expect(c.entries).toEqual([]);
  expect(c.accessRows).toEqual([]);
  expect(c.touched).toEqual([]);
  if (!opts.flagRead) expect(c.getTenantSettings).not.toHaveBeenCalled();
}

// ============================================================================================================== US-07.1 gate order
describe('US-07.1 — assertRole, then MFA, then the flag; each stops before any read', () => {
  it.each([['no permission', NO_PERM], ['partner', PARTNER], ['tenant_admin (03-IC §11: owner_viewer only)', ADMIN], ['lab_manager (dashboard.read only)', LAB_MANAGER],
    ['finance', FINANCE], ['owner_viewer with a deactivated membership', OWNER_REVOKED]])('%s → 403 auth.forbidden, flag on or off, before the flag is looked at', async (_n, who) => {
    for (const flag of [undefined, false, true]) {
      vi.clearAllMocks(); db.calls.length = 0;
      const c = await makeCtx10(who, { flag });
      await expectLims(getRef(c.ctx), 'auth.forbidden', 403);
      expectUntouched(c);
      expect(c.assertRole).toHaveBeenCalledWith(expect.anything(), { permission: 'analytics.referral_report.read' });
    }
  });

  it('a non-holder who also sends bad input still gets auth.forbidden (authorisation is first, nothing is validated for strangers)', async () => {
    const c = await makeCtx10(NO_PERM, { flag: true });
    await expectLims(getRef(c.ctx, { limit: 0, group_by: 'x' }), 'auth.forbidden', 403);
    expectUntouched(c);
  });

  it.each([[undefined], [false], [true]])('holder at aal1 (flag %s) → 403 auth.mfa_required; the flag is not read, nothing is read or logged', async (flag) => {
    const c = await makeCtx10(OWNER_AAL1, { flag });
    await expectLims(getRef(c.ctx), 'auth.mfa_required', 403);
    expectUntouched(c);
  });

  it('holder at aal1 with bad input → still auth.mfa_required (MFA before validation)', async () => {
    const c = await makeCtx10(OWNER_AAL1, { flag: true });
    await expectLims(getRef(c.ctx, { limit: 0 }), 'auth.mfa_required', 403);
    expectUntouched(c);
  });

  it.each([[undefined, 'C2 default (not set)'], [false, 'explicitly false']])('flag off (%s: %s) + aal2 holder → 403 common.feature_disabled; flag asked once; no read, no access_log row', async (flag) => {
    const c = await makeCtx10(OWNER, { flag });
    await expectLims(getRef(c.ctx), 'common.feature_disabled', 403);
    expect(c.getTenantSettings).toHaveBeenCalledTimes(1);
    expect(c.getTenantSettings).toHaveBeenCalledWith(expect.anything(), { keys: ['referralIncentiveReportEnabled'] });
    expectUntouched(c, { flagRead: true });
  });

  it('another tenant having the flag on does not enable it for this tenant', async () => {
    const c = await makeCtx10(OWNER, { flagOtherTenant: true });
    await expectLims(getRef(c.ctx), 'common.feature_disabled', 403);
    expectUntouched(c, { flagRead: true });
  });

  it('feature_disabled leaks nothing about the report (no figures, no referrer names, no counts) in the error', async () => {
    const e = await expectLims(getRef((await makeCtx10(OWNER, { flag: false })).ctx), 'common.feature_disabled', 403);
    expect(JSON.stringify({ message: (e as Error).message, ...(e as object) })).not.toMatch(new RegExp(`${REF_NAME.ALPHA}|9000|11400|net_billed`));
  });

  it('flag on + aal2 holder → 200; call order is assertRole, getTenantSettings, rollup reads, ctx.audit.access', async () => {
    const c = await makeCtx10(OWNER, { flag: true });
    await okRef(c.ctx);
    const first = (fn: { mock: { invocationCallOrder: number[] } }) => fn.mock.invocationCallOrder[0]!;
    const { rollupsMock10 } = await import('./t10.helpers.js');
    const order = [first(c.assertRole as never), first(c.getTenantSettings as never), first(rollupsMock10.referrerVolumeRows as never), first(c.ctx.audit.access)];
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(new Set(order).size).toBe(4);
    expect(first(rollupsMock10.referrerBillingRows as never)).toBeLessThan(first(c.ctx.audit.access));
  });
});

// ============================================================================================================== US-07.2 body
describe('US-07.2 — rows per referrer: orders, patient visits, tests ordered, net billed; SELF without net billed', () => {
  const body = async (q: Record<string, unknown> = {}, who = OWNER) => okRef((await makeCtx10(who, { flag: true })).ctx, q);

  it('canonical rollup (default): ALPHA absorbs merged GAMMA; SELF row has no net_billed_paisa and no referrer_id; totals; note key; contract-valid', async () => {
    const b = await body();
    expect(b.report_code).toBe('referral_incentive');
    expect(brief(b)).toEqual([
      [REF_NAME.ALPHA, 9, 9, 18, 9000], [REF_NAME.BETA, 3, 3, 3, 2000], [SELF, 2, 2, 2, undefined], [REF_NAME.DELTA, 1, 1, 1, 400],
    ]);
    const self = b.rows.find((r: any) => r.is_self);
    expect(Object.keys(self).sort()).toEqual(SELF_KEYS);
    expect(self.label).toBe(SELF);
    for (const r of b.rows.filter((x: any) => !x.is_self)) {
      expect(Object.keys(r).sort()).toEqual(ROW_KEYS);
      expect(Number.isInteger(r.net_billed_paisa)).toBe(true);
      expect(typeof r.referrer_id).toBe('string');
    }
    expect(b.totals).toEqual({ orders: 15, patient_visits: 15, tests_ordered: 24, net_billed_paisa: 11400 });
    expect(b.billed_note_key).toBe(NOTE);
    expect(b.freshness.map((f: any) => f.family).sort()).toEqual(['referrer_billing', 'referrer_volume']);
    expect(b.period).toMatchObject({ business_date_from: D1, business_date_to: D3 });
    expect(contractErrors('ReferralIncentiveReport', b)).toEqual([]);
  });

  it('rollup=none: merged GAMMA is its own row (ALPHA 5 / 8000, GAMMA 4 / 1000); order -orders', async () => {
    const b = await body({ rollup: 'none' });
    expect(brief(b)).toEqual([
      [REF_NAME.ALPHA, 5, 5, 10, 8000], [REF_NAME.GAMMA, 4, 4, 8, 1000], [REF_NAME.BETA, 3, 3, 3, 2000], [SELF, 2, 2, 2, undefined], [REF_NAME.DELTA, 1, 1, 1, 400],
    ]);
    expect(contractErrors('ReferralIncentiveReport', b)).toEqual([]);
  });

  it('merges are resolved at query time: re-pointing GAMMA to BETA changes the next answer, volume and money together', async () => {
    w.referrers.find((r) => r.referrer_id === R.GAMMA)!.canonical_referrer_id = R.BETA;
    const b = await body();
    expect(brief(b).slice(0, 2)).toEqual([[REF_NAME.BETA, 7, 7, 11, 3000], [REF_NAME.ALPHA, 5, 5, 10, 8000]]);
  });

  it('a referrer billed in the period but with no orders in it (credit-party charge on its charge date) gets a row with zero volume', async () => {
    wb.bill.push(bf(D1, A1, R_ZETA, 700));
    const b = await body();
    expect(b.rows.at(-1)).toMatchObject({ label: REF_ZETA, orders: 0, patient_visits: 0, tests_ordered: 0, net_billed_paisa: 700, is_self: false });
    expect(b.totals).toEqual({ orders: 15, patient_visits: 15, tests_ordered: 24, net_billed_paisa: 12100 });
  });

  it('a referrer id unknown to the directory still gets a labelled row (never empty, never "SELF")', async () => {
    const ghost = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    w.refs.push(rf(D1, A1, ghost, { orders: 1 })); wb.bill.push(bf(D1, A1, ghost, 50));
    const row = (await body()).rows.find((r: any) => r.referrer_id === ghost);
    expect(row?.label).toBeTruthy();
    expect(row?.label).not.toBe(SELF);
    expect(row?.net_billed_paisa).toBe(50);
  });

  it('referrer_id filter (canonical): keeps keys whose canonical id is listed; SELF never matches; totals follow the filter', async () => {
    const b = await body({ referrer_id: [R.ALPHA] });
    expect(brief(b)).toEqual([[REF_NAME.ALPHA, 9, 9, 18, 9000]]);
    expect(b.totals).toEqual({ orders: 9, patient_visits: 9, tests_ordered: 18, net_billed_paisa: 9000 });
    expect((await body({ rollup: 'none', referrer_id: [R.ALPHA] })).rows.map((r: any) => [r.label, r.net_billed_paisa])).toEqual([[REF_NAME.ALPHA, 8000]]);
    expect((await body({ rollup: 'none', referrer_id: [R.BETA, R.GAMMA] })).rows.map((r: any) => r.label)).toEqual([REF_NAME.GAMMA, REF_NAME.BETA]);
  });

  it("another tenant's referrer id yields no row (or 404), never its figures; tenant B rows and out-of-window days never show", async () => {
    const c = await makeCtx10(OWNER, { flag: true });
    const r = await raw(c.ctx, { ...WINDOW, referrer_id: [R.FOREIGN] }).catch((e: any) => ({ status: e.statusCode, body: undefined, code: e.code }));
    if (r.status === 200) expect((r as any).body.rows).toEqual([]); else expect([404, 400]).toContain(r.status);
    const all = await body();
    expect(JSON.stringify([r.body, all])).not.toMatch(new RegExp(`${REF_NAME.FOREIGN}|${R.FOREIGN}|999999|70000|80000`));
    expect(all.rows.find((x: any) => x.label === REF_NAME.BETA).net_billed_paisa).toBe(2000);
  });

  it('empty window → rows [], zero totals (net 0), contract-valid, and the view is still logged with rows 0', async () => {
    const c = await makeCtx10(OWNER, { flag: true });
    const b = await okRef(c.ctx, { business_date_from: '2030-01-01', business_date_to: '2030-01-08' });
    expect(b.rows).toEqual([]);
    expect(b.totals).toMatchObject({ orders: 0, patient_visits: 0, tests_ordered: 0 });
    expect(contractErrors('ReferralIncentiveReport', b)).toEqual([]);
    expect(c.entries[0].detail).toMatchObject({ rows: 0 });
  });

  it('group_by=referrer_ad_month: one row per (month, referrer), period_key YYYY-MM ascending, exact sums, SELF without net', async () => {
    w.refs = [rf('2026-10-31', A1, R.ALPHA, { orders: 2 }), rf('2026-11-01', A1, R.ALPHA, { orders: 3 }), rf('2026-11-01', A1, null, { orders: 1 })];
    wb.bill = [bf('2026-10-31', A1, R.ALPHA, 100), bf('2026-11-01', A1, R.ALPHA, 200)];
    const b = await body({ business_date_from: '2026-10-31', business_date_to: '2026-11-02', group_by: 'referrer_ad_month' });
    expect(b.rows.map((r: any) => [r.period_key, r.period_label, r.label, r.orders, r.net_billed_paisa])).toEqual([
      ['2026-10', '2026-10', REF_NAME.ALPHA, 2, 100], ['2026-11', '2026-11', REF_NAME.ALPHA, 3, 200], ['2026-11', '2026-11', SELF, 1, undefined],
    ]);
    expect(b.totals).toEqual({ orders: 6, patient_visits: 6, tests_ordered: 6, net_billed_paisa: 300 });
    expect(contractErrors('ReferralIncentiveReport', b)).toEqual([]);
  });

  it('group_by=referrer_bs_month: B.S. months from the golden table (last day of 2082-07 vs first day of 2082-08, no leak), label "YYYY-MM B.S."', async () => {
    const last = addDays(golden(2082, 7).ad_first_day, golden(2082, 7).days - 1), next = addDays(last, 1);
    w.refs = [rf(last, A1, R.ALPHA, { orders: 2 }), rf(next, A1, R.ALPHA, { orders: 3 })];
    wb.bill = [bf(last, A1, R.ALPHA, 100), bf(next, A1, R.ALPHA, 200)];
    const b = await body({ business_date_from: last, business_date_to: addDays(last, 2), group_by: 'referrer_bs_month' });
    expect(b.rows.map((r: any) => [r.period_key, r.period_label, r.orders, r.net_billed_paisa])).toEqual([
      [bsKey(2082, 7), '2082-07 B.S.', 2, 100], [bsKey(2082, 8), '2082-08 B.S.', 3, 200],
    ]);
    expect(contractErrors('ReferralIncentiveReport', b)).toEqual([]);
  });

  it('group_by=referrer (default and explicit) carries no period_key / period_label', async () => {
    for (const q of [{}, { group_by: 'referrer' }]) for (const r of (await body(q)).rows) expect(r).not.toHaveProperty('period_key');
  });
});

// ============================================================================================================== paging
describe('paging — limit 1–200 (default 50), opaque cursor, invalid_cursor', () => {
  const many = () => Array.from({ length: 25 }, (_v, i) => {
    const id = `cccccccc-cccc-4ccc-8ccc-${String(i).padStart(12, '0')}`;
    w.referrers.push({ tenantId: w.referrers[0]!.tenantId, referrer_id: id, display_name: `Dr. Many ${String(i).padStart(2, '0')}`, is_active: true, canonical_referrer_id: null });
    w.refs.push(rf(D1, A1, id, { orders: 100 + i })); wb.bill.push(bf(D1, A1, id, 10 + i));
    return id;
  });
  const fresh = async () => (await makeCtx10(OWNER, { flag: true })).ctx;

  it('default limit is 50 and echoed; limit 200 is accepted and echoed', async () => {
    expect((await okRef(await fresh())).page).toEqual({ limit: 50 });
    expect((await okRef(await fresh(), { limit: 200 })).page).toMatchObject({ limit: 200 });
  });

  it('walking the cursors returns every row exactly once, in the unpaged order; totals are the whole period on every page; the last page has no next_cursor', async () => {
    many();
    const all = await okRef(await fresh(), { limit: 200 });
    expect(all.rows).toHaveLength(29);
    expect(all.page.next_cursor).toBeUndefined();
    const labels: string[] = []; let cursor: string | undefined; let pages = 0;
    do {
      const p = await okRef(await fresh(), { limit: 10, ...(cursor ? { cursor } : {}) });
      expect(p.page.limit).toBe(10);
      expect(p.totals).toEqual(all.totals);
      expect(p.rows.length).toBeLessThanOrEqual(10);
      labels.push(...p.rows.map((r: any) => r.label)); cursor = p.page.next_cursor; pages++;
      expect(pages).toBeLessThan(10);
    } while (cursor);
    expect(pages).toBe(3);
    expect(labels).toEqual(all.rows.map((r: any) => r.label));
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('boundary: exactly as many rows as the limit → no next_cursor; one fewer → a cursor whose page holds the last row', async () => {
    many();
    expect((await okRef(await fresh(), { limit: 29 })).page.next_cursor).toBeUndefined();
    const p1 = await okRef(await fresh(), { limit: 28 });
    expect(typeof p1.page.next_cursor).toBe('string');
    const p2 = await okRef(await fresh(), { limit: 28, cursor: p1.page.next_cursor });
    expect(p2.rows).toHaveLength(1);
    expect(p2.page.next_cursor).toBeUndefined();
  });

  it('the cursor is opaque base64url text without internal ids or money', async () => {
    many();
    const cur = (await okRef(await fresh(), { limit: 5 })).page.next_cursor as string;
    expect(cur).toMatch(/^[A-Za-z0-9_-]{1,512}$/);
  });

  it.each([[0], [201], [-5], [2.5], ['x'], ['10; drop table analytics.daily_referrer_billing']])('limit %j → 400 common.validation_failed, no read, no log', async (limit) => {
    const c = await makeCtx10(OWNER, { flag: true });
    await expectLims(getRef(c.ctx, { limit }), 'common.validation_failed', 400);
    expectUntouched(c, { flagRead: true });
  });

  const b64 = (s: string) => Buffer.from(s).toString('base64url');
  it.each([['not base64 !!'], ['!!!'], [b64('garbage')], [b64('{}')], [b64('[]')], [b64(JSON.stringify({ sort_value: "1; drop table x;--", key: 'k' }))], [b64(JSON.stringify({ sort_value: { $gt: 0 }, key: 1 }))], ['A'.repeat(4000)]])(
    'malformed or hostile cursor %#  → 400 common.invalid_cursor, no read, no access_log row', async (cursor) => {
      many();
      const c = await makeCtx10(OWNER, { flag: true });
      await expectLims(getRef(c.ctx, { limit: 10, cursor }), 'common.invalid_cursor', 400);
      expect(reads()).toEqual([]);
      expect(c.entries).toEqual([]);
    });

  it('a tampered cursor (key swapped for another tenant\'s referrer) is refused or harmless: never returns the foreign row', async () => {
    many();
    const cur = (await okRef(await fresh(), { limit: 5 })).page.next_cursor as string;
    const parsed = JSON.parse(Buffer.from(cur, 'base64url').toString('utf8'));
    const forged = Buffer.from(JSON.stringify({ ...parsed, key: R.FOREIGN })).toString('base64url');
    const r = await raw(await fresh(), { ...WINDOW, limit: 5, cursor: forged }).catch((e: any) => ({ status: e.statusCode, body: undefined }));
    expect([200, 400]).toContain(r.status);
    expect(JSON.stringify(r.body ?? {})).not.toMatch(new RegExp(`${REF_NAME.FOREIGN}|999999`));
  });
});

// ============================================================================================================== validation
describe('input validation: 400 before any read or access_log row (flag on, aal2)', () => {
  it.each([
    [{ group_by: 'day' }], [{ group_by: 'referral' }], [{ group_by: 'REFERRER' }], [{ group_by: 'referrer ' }], [{ group_by: '' }], [{ group_by: 'referrer; drop table x' }],
    [{ rollup: 'merge' }], [{ rollup: '' }], [{ rollup: ' none' }], [{ referrer_id: ['not-a-uuid'] }], [{ referrer_id: "x'; drop table analytics.daily_referrer_billing;--" }],
  ])('%j → 400 common.validation_failed', async (q) => {
    const c = await makeCtx10(OWNER, { flag: true });
    await expectLims(getRef(c.ctx, q), 'common.validation_failed', 400);
    expectUntouched(c, { flagRead: true });
  });

  it.each([[21], [50]])('more than 20 referrer_id values (%i) → 400 common.validation_failed', async (n) => {
    const ids = Array.from({ length: n }, (_v, i) => `bbbbbbbb-bbbb-4bbb-8bbb-${String(i).padStart(12, '0')}`);
    const c = await makeCtx10(OWNER, { flag: true });
    await expectLims(getRef(c.ctx, { referrer_id: ids }), 'common.validation_failed', 400);
    expectUntouched(c, { flagRead: true });
  });

  it('period rules as every report: bs_month + dates → 400; > max range → 422 analytics.range_too_large; bs_month 2100-01 → 422 common.date_out_of_range; nothing read or logged', async () => {
    const c = await makeCtx10(OWNER, { flag: true });
    await expectLims(raw(c.ctx, { ...WINDOW, bs_month: '2082-07' }), 'common.validation_failed', 400);
    await expectLims(raw(c.ctx, { business_date_from: '2025-01-01', business_date_to: '2026-02-05' }), 'analytics.range_too_large', 422);
    await expectLims(raw(c.ctx, { bs_month: '2100-01' }), 'common.date_out_of_range', 422);
    expectUntouched(c, { flagRead: true });
  });

  it('centre_id filter: inside scope narrows; outside scope or another tenant → 404 common.not_found with no read and no access_log row', async () => {
    const narrowed = await okRef((await makeCtx10(OWNER, { flag: true })).ctx, { centre_id: [A2] });
    expect(brief(narrowed)).toEqual([[REF_NAME.ALPHA, 2, 2, 4, 3000]]);
    db.calls.length = 0;
    const c = await makeCtx10(OWNER_A1, { flag: true });
    await expectLims(getRef(c.ctx, { centre_id: [A2] }), 'common.not_found', 404);
    expect(reads()).toEqual([]);
    expect(c.entries).toEqual([]);
  });
});

// ============================================================================================================== centre scope + isolation
describe('P1 / P4 — tenant isolation and centre scope reach the billing read too', () => {
  it('centre-restricted holder {A1}: volume AND money only from A1 (ALPHA 7 + GAMMA = 6000); scope echoed; both repos got the narrowed scope', async () => {
    const c = await makeCtx10(OWNER_A1, { flag: true });
    const b = await okRef(c.ctx);
    expect(brief(b)).toEqual([[REF_NAME.ALPHA, 7, 7, 14, 6000], [REF_NAME.BETA, 3, 3, 3, 2000], [SELF, 2, 2, 2, undefined], [REF_NAME.DELTA, 1, 1, 1, 400]]);
    expect(b.totals).toEqual({ orders: 13, patient_visits: 13, tests_ordered: 20, net_billed_paisa: 8400 });
    expect(b.scope).toMatchObject({ all_centres: false, centre_ids: [A1] });
    expect(reads().map((x) => x.fn).sort()).toEqual(['referrerBillingRows', 'referrerVolumeRows']);
    for (const x of reads()) expect(x.args.scope).toEqual({ all: false, centreIds: [A1] });
  });

  it('every repo call carries ctx.tenantId; a client tenant_id / scope parameter is ignored', async () => {
    const c = await makeCtx10(OWNER_A1, { flag: true });
    await okRef(c.ctx, { tenant_id: '00000000-0000-4000-8000-00000000beef', scope: 'all', all_centres: 'true' });
    expect(reads().length).toBeGreaterThan(0);
    for (const x of reads()) { expect(x.args.tenantId).toBe(c.ctx.tenantId); expect(x.args.scope).toEqual({ all: false, centreIds: [A1] }); expect(JSON.stringify(x.args)).not.toContain('beef'); }
  });

  it('only the two referrer rollups are read (no income / collections / memberships)', async () => {
    const c = await makeCtx10(OWNER, { flag: true });
    await okRef(c.ctx);
    const fns = new Set(db.calls.map((x) => x.fn));
    expect([...fns].filter((f) => /income|collection|volumeRows$|topCentres/i.test(f) && !/^referrer/.test(f))).toEqual([]);
    expect(c.touched).not.toContain('core.memberships');
  });

  it('many users at once: 16 interleaved all-centre and A1-only requests never share figures, and each writes exactly its own access_log row', async () => {
    const jobs = Array.from({ length: 16 }, async (_v, i) => {
      const who = i % 2 ? OWNER_A1 : OWNER; const c = await makeCtx10(who, { flag: true });
      return { who, b: await okRef(c.ctx), c };
    });
    for (const { who, b, c } of await Promise.all(jobs)) {
      expect(b.scope.all_centres, who).toBe(who === OWNER);
      expect(b.rows[0].orders, who).toBe(who === OWNER ? 9 : 7);
      expect(c.entries).toHaveLength(1);
      expect(c.accessRows).toHaveLength(1);
    }
  });
});

// ============================================================================================================== access log
describe('US-07.2 / CR-C8-006 — access_log row referral_report.view', () => {
  it('one allowed entry per view with exactly {report_code, from, to, rows}; written on the request transaction via the real access() validator', async () => {
    const c = await makeCtx10(OWNER, { flag: true });
    const b = await okRef(c.ctx);
    expect(c.entries).toEqual([{ action: 'referral_report.view', entityType: 'analytics_report', outcome: 'allowed', detail: { report_code: 'referral_incentive', from: D1, to: D3, rows: b.rows.length } }]);
    expect(c.accessRows).toHaveLength(1);
    const v = c.accessRows[0]!;
    expect([v[1], v[3], v[7], v[8], v[11]]).toEqual([c.ctx.tenantId, c.ctx.actor.id, 'referral_report.view', 'analytics_report', 'allowed']);
    expect(v[12]).toEqual(c.entries[0].detail);
  });

  it('the entry carries no figures, names or ids (PHI/money-free): no net_billed, paisa, referrer name or uuid', async () => {
    const c = await makeCtx10(OWNER, { flag: true });
    await okRef(c.ctx);
    expect(JSON.stringify(c.entries)).not.toMatch(/paisa|net_billed|Dr\. |[0-9a-f]{8}-[0-9a-f]{4}-/i);
  });

  it('every page of a paged walk is its own view: rows = rows on that page', async () => {
    const c = await makeCtx10(OWNER, { flag: true });
    const p = await okRef(c.ctx, { limit: 2 });
    expect(c.entries).toHaveLength(1);
    expect(c.entries[0].detail.rows).toBe(2);
    expect(p.rows).toHaveLength(2);
  });

  it('the report is not returned if the access row cannot be written (no un-logged view of net billed per referrer)', async () => {
    const c = await makeCtx10(OWNER, { flag: true, accessFails: true });
    const e = await rejection(getRef(c.ctx));
    expect(e).toBeInstanceOf(Error);
    expect(c.ctx.audit.access).toHaveBeenCalledTimes(1);   // the write was attempted (not a stub / early exit) and its failure propagated
    expect(reads().length).toBeGreaterThan(0);
    expect(c.accessRows).toEqual([]);
  });

  it('a failing rollup read fails the request and writes no access_log row', async () => {
    const c = await makeCtx10(OWNER, { flag: true });
    db.fail = new Error('synthetic db outage');
    await rejection(getRef(c.ctx));
    expect(c.getTenantSettings).toHaveBeenCalledTimes(1);  // got as far as the read (not a stub / early exit)
    expect(reads().length).toBeGreaterThan(0);
    expect(c.entries).toEqual([]);
    expect(c.accessRows).toEqual([]);
  });
});

// ============================================================================================================== US-07.3 / 07.4
describe('US-07.3 / US-07.4 — no commission wording, no rate / percentage / payable / payout / pay action', () => {
  it('the body has exactly the contract keys: no rate, percent, payable, payout status, action or link anywhere', async () => {
    const b = await okRef((await makeCtx10(OWNER, { flag: true })).ctx);
    expect(Object.keys(b).sort()).toEqual(['billed_note_key', 'freshness', 'generated_at', 'page', 'period', 'report_code', 'rows', 'scope', 'totals']);
    expect(Object.keys(b.totals).sort()).toEqual(['net_billed_paisa', 'orders', 'patient_visits', 'tests_ordered']);
    const keys = new Set<string>();
    (function walk(x: unknown) { if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) { keys.add(k); walk(v); } })(b);
    expect([...keys].filter((k) => /(^|_)(rate|percent|pct|share|payable|payout|pay|paid|status|action|href|url|link|due)(_|$)|incentive_amount/i.test(k))).toEqual([]);
  });

  it('neither the body nor the access entry contains the forbidden word (case-insensitive)', async () => {
    const c = await makeCtx10(OWNER, { flag: true });
    const b = await okRef(c.ctx);
    expect(JSON.stringify([b, c.entries])).not.toMatch(new RegExp(WORD, 'i'));
  });

  it('the report_code in the body is the registry code, not a pay-themed alias', async () => {
    expect((await okRef((await makeCtx10(OWNER, { flag: true })).ctx)).report_code).toBe('referral_incentive');
  });
});
