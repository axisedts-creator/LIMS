// C8 AN-T14 — getAnalyticsFreshness (GET /v1/analytics/freshness, TRD §5 #18 → {data: Freshness[]}). PRD US-16.1–3; TRD §9.2 (no refresh_state row = never_refreshed).
// Repos are in-memory emulators (./helpers.t14.ts); handler + service are real.
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ADMIN, FAMILIES, FINANCE, LAB_MANAGER, NO_PERM, OWNER_A109, PARTNER, SENTINEL, TA, TB, call14, contractErrors, db, expectLims, makeCtx14, ok14, seedFreshness, seedT14, w14, NOW } from './helpers.t14.js';

vi.mock('../../repository/rollups.repo.js', async () => (await import('./helpers.t14.js')).rollupsMock14);
vi.mock('../../repository/labels.repo.js', async () => (await import('./helpers.t14.js')).labelsRepoMock14);

const OP = 'getAnalyticsFreshness' as const;
const at = (min: number) => new Date(Date.parse(NOW) - min * 60_000).toISOString();
const get = async (actor = ADMIN) => { const { ctx } = await makeCtx14(actor); return (await ok14(OP, ctx)).data as any[]; };
const byFamily = (rows: any[]) => Object.fromEntries(rows.map((r) => [r.family, r]));

// Warm-up (ruling): cold import of handlers + first Ajv compile are not part of any test's budget.
beforeAll(async () => { await import('../index.js'); contractErrors('DashboardDto', {}); }, 30_000);
beforeEach(() => { seedT14(); vi.clearAllMocks(); });

describe('US-16.1 / US-16.2 — one Freshness per rollup family', () => {
  it('returns {data: [...]} with every one of the 16 families exactly once; every entry is contract-valid; ≤ 50 entries', async () => {
    seedFreshness();
    const { ctx } = await makeCtx14(ADMIN);
    const body = await ok14(OP, ctx);
    expect(Object.keys(body)).toEqual(['data']);
    const fams = body.data.map((r: any) => r.family);
    for (const f of FAMILIES) expect(fams.filter((x: string) => x === f).length, f).toBe(1);
    expect(body.data.length).toBeLessThanOrEqual(50);
    for (const r of body.data) expect(contractErrors('Freshness', r), r.family).toEqual([]);
  });

  it('fresh family: refreshed_at = last_success_at, is_stale false, live false, no stale_reason', async () => {
    seedFreshness();
    expect(byFamily(await get()).orders).toEqual({ family: 'orders', refreshed_at: at(10), is_stale: false, live: false });
  });

  it('last success 45 min ago → refresh_lagging, still reports refreshed_at (US-01.4)', async () => {
    seedFreshness();
    expect(byFamily(await get()).income).toEqual({ family: 'income', refreshed_at: at(45), is_stale: true, stale_reason: 'refresh_lagging', live: false });
  });

  it('no refresh_state row → never_refreshed, no refreshed_at; the read writes nothing (P-22: no seeding)', async () => {
    seedFreshness();
    expect(byFamily(await get()).department_income).toEqual({ family: 'department_income', is_stale: true, stale_reason: 'never_refreshed', live: false });
    expect(w14.log.filter((l) => /^\s*(INSERT|UPDATE|DELETE)/i.test(l.text))).toEqual([]);
    expect([...w14.state.keys()].some((k) => k.endsWith('|department_income'))).toBe(false);
  });

  it('last attempt failed → refresh_failed (error code present on the row), refreshed_at = last success', async () => {
    seedFreshness();
    expect(byFamily(await get()).referrer_billing).toEqual({ family: 'referrer_billing', refreshed_at: at(10), is_stale: true, stale_reason: 'refresh_failed', live: false });
  });

  it('oldest unprocessed dirty mark older than 20 min → refresh_lagging even though the last success is recent', async () => {
    seedFreshness();
    expect(byFamily(await get()).referrer_volume).toMatchObject({ is_stale: true, stale_reason: 'refresh_lagging', refreshed_at: at(10) });
  });

  it('a family with a dirty mark younger than 20 min is still fresh', async () => {
    seedFreshness();
    w14.marks.set(`${TA}|tat|2026-11-06`, { tenant: TA, family: 'tat', date: '2026-11-06', first: at(19), last: at(1), reason: 'event', actor: 'x' });
    expect(byFamily(await get()).tat.is_stale).toBe(false);
  });

  it('the oldest mark of a family decides (a newer mark of the same family does not hide an old one)', async () => {
    seedFreshness();
    w14.marks.set(`${TA}|tat|2026-11-05`, { tenant: TA, family: 'tat', date: '2026-11-05', first: at(25), last: at(25), reason: 'event', actor: 'x' });
    w14.marks.set(`${TA}|tat|2026-11-06`, { tenant: TA, family: 'tat', date: '2026-11-06', first: at(2), last: at(1), reason: 'event', actor: 'x' });
    expect(byFamily(await get()).tat).toMatchObject({ is_stale: true, stale_reason: 'refresh_lagging' });
  });

  it('the internal `_manual` throttle row is never reported as a family', async () => {
    seedFreshness();
    w14.state.set(`${TA}|_manual`, { tenant: TA, family: '_manual', last_manual_at: at(1) });
    const rows = await get();
    expect(rows.map((r) => r.family)).not.toContain('_manual');
    expect(JSON.stringify(rows)).not.toContain('last_manual_at');
  });

  it('error codes / internal columns never reach the DTO: only family, refreshed_at, is_stale, stale_reason, live', async () => {
    seedFreshness();
    for (const r of await get()) for (const k of Object.keys(r)) expect(['family', 'refreshed_at', 'is_stale', 'stale_reason', 'live'], k).toContain(k);
  });
});

describe('US-16.3 — live sources', () => {
  it('any live entry (pending_items, agent_status) has refreshed_at = response time, is_stale false, live true; family entries are live false', async () => {
    seedFreshness();
    const rows = await get();
    const live = rows.filter((r) => r.live);
    for (const r of live) expect(r).toEqual({ family: r.family, refreshed_at: NOW, is_stale: false, live: true });
    for (const r of rows.filter((x) => !x.live)) expect((FAMILIES as readonly string[]).includes(r.family), r.family).toBe(true);
  });

  it('refreshed_at of a live entry follows the clock of the request', async () => {
    seedFreshness();
    w14.clock.now = '2026-11-06T06:10:00.000Z';
    const { ctx } = await makeCtx14(ADMIN);
    const live = ((await ok14(OP, ctx)).data as any[]).filter((r) => r.live);
    for (const r of live) expect(r.refreshed_at).toBe('2026-11-06T06:10:00.000Z');
  });
});

describe('isolation and permission', () => {
  it('tenant B refresh_state (very old success) never changes tenant A entries', async () => {
    seedFreshness();
    w14.state.set(`${TB}|orders`, { tenant: TB, family: 'orders', last_success_at: at(5000), last_error_code: 'x' });
    expect(byFamily(await get()).orders.is_stale).toBe(false);
    for (const l of w14.log) expect(l.values[0], l.text).toBe(TA);
    expect(JSON.stringify(await get())).not.toContain(String(SENTINEL));
  });

  it('a centre-restricted dashboard.read holder gets the same tenant-level freshness (no scope concept for freshness)', async () => {
    seedFreshness();
    expect(await get(OWNER_A109)).toEqual(await get(ADMIN));
  });

  it('lab_manager (dashboard.read only) → 200', async () => {
    seedFreshness();
    expect((await get(LAB_MANAGER)).length).toBeGreaterThanOrEqual(16);
  });

  it.each([['no analytics permission', NO_PERM], ['finance (collections.read only)', FINANCE], ['partner', PARTNER]])('%s → 403 auth.forbidden, no read', async (_n, actor) => {
    const { ctx, touched } = await makeCtx14(actor);
    await expectLims(call14(OP, ctx), 'auth.forbidden', 403);
    expect(touched).toEqual([]);
    expect(w14.log).toEqual([]);
    expect(db.calls).toEqual([]);
  });
});
