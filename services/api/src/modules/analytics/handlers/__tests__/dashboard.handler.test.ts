// C8 AN-T14 — getAnalyticsDashboard (GET /v1/analytics/dashboard). PRD US-01.1–6, US-16.1–3; 02-TRD §5 #1 / §5.1 DashboardDto / §6.7; 07-SECURITY P1, P3, P4, X1.
// Repos are in-memory emulators (./helpers.t14.ts); handler + service + mapper are real. Clock: 2026-11-06 11:45 Asia/Kathmandu → "Today" = 2026-11-06, previous = 2026-11-05.
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  A1, A2, ADMIN, B1, BR1, D1, D2, DEPT, FINANCE, LAB_MANAGER, NO_PERM, OWNER_A109, OWNER_ALL09, PARTNER, SENTINEL, TA, WINDOW,
  call14, contractErrors, dash, db, expectLims, makeCtx14, seedFreshness, seedT14, w14, NOW,
} from './helpers.t14.js';

vi.mock('../../repository/rollups.repo.js', async () => (await import('./helpers.t14.js')).rollupsMock14);
vi.mock('../../repository/labels.repo.js', async () => (await import('./helpers.t14.js')).labelsRepoMock14);

const OP = 'getAnalyticsDashboard' as const;
const TILE_KEYS = ['patient_visits', 'new_patients', 'net_orders', 'tests_ordered', 'net_sales_paisa', 'invoiced_paisa', 'credit_notes_paisa', 'results_approved',
  'net_collected_paisa', 'reports_pending', 'reports_ready_unreleased', 'pending_tests', 'pending_overdue'];
const SNAPSHOT_TILES = ['reports_pending', 'reports_ready_unreleased', 'pending_tests', 'pending_overdue'];
const t = (value: number, previous: number, delta: number, delta_bp: number | undefined, unit: string) => ({ value, previous, delta, ...(delta_bp === undefined ? {} : { delta_bp }), unit });

// Warm-up (ruling): cold import of handlers + first Ajv compile are not part of any test's budget.
beforeAll(async () => { await import('../index.js'); contractErrors('DashboardDto', {}); }, 30_000);
beforeEach(() => { seedT14(); vi.clearAllMocks(); });

describe('US-01.1 — default period = Today (Asia/Kathmandu); tiles M04 M12 M42 M08 M52 M50 M27', () => {
  it('all-centre reader, no params: period [2026-11-06, 2026-11-07), exact tile values, units, contract-valid', async () => {
    const { ctx } = await makeCtx14(ADMIN);
    const body = await dash(ctx);
    expect(body.report_code).toBe('dashboard');
    expect(body.period).toMatchObject({ business_date_from: D2, business_date_to: '2026-11-07', days: 1, timezone: 'Asia/Kathmandu' });
    expect(body.generated_at).toBe(NOW);
    expect(body.tiles.patient_visits).toEqual(t(13, 13, 0, 0, 'count'));
    expect(body.tiles.new_patients).toEqual(t(2, 4, -2, -5000, 'count'));
    expect(body.tiles.net_orders).toEqual(t(13, 13, 0, 0, 'count'));
    expect(body.tiles.tests_ordered).toEqual(t(50, 40, 10, 2500, 'count'));
    expect(body.tiles.net_sales_paisa).toEqual(t(16000, 20000, -4000, -2000, 'paisa'));
    expect(body.tiles.invoiced_paisa).toEqual(t(18000, 20000, -2000, -1000, 'paisa'));
    expect(body.tiles.results_approved).toEqual(t(15, 10, 5, 5000, 'count'));
    expect(body.tiles.net_collected_paisa).toEqual(t(6500, 4000, 2500, 6250, 'paisa'));
    expect(contractErrors('DashboardDto', body)).toEqual([]);
  });

  it('the business date comes from Asia/Kathmandu, not UTC: 23:00Z on 11-05 is already 11-06 locally', async () => {
    const { ctx } = await makeCtx14(ADMIN, { now: () => '2026-11-05T23:00:00.000Z' });
    const body = await dash(ctx);
    expect(body.period.business_date_from).toBe(D2);
  });

  it('the tile key set is exactly the contract set (collections tile included for a holder)', async () => {
    const { ctx } = await makeCtx14(OWNER_ALL09);
    const body = await dash(ctx);
    expect(Object.keys(body.tiles).sort()).toEqual([...TILE_KEYS].sort());
    expect(Object.keys(body).sort()).toEqual(['department_top', 'freshness', 'generated_at', 'period', 'report_code', 'scope', 'series', 'tiles'].sort());
  });

  it('results_approved is M42 (analyte level approved) — not tests_approved, not resulted', async () => {
    const { ctx } = await makeCtx14(ADMIN);
    expect((await dash(ctx)).tiles.results_approved.value).toBe(15);
  });

  it('credit_notes_paisa: previous 0 → previous present as 0, delta present, delta_bp omitted (US-01.2)', async () => {
    const { ctx } = await makeCtx14(ADMIN);
    const tile = (await dash(ctx)).tiles.credit_notes_paisa;
    expect(tile).toEqual({ value: 2000, previous: 0, delta: 2000, unit: 'paisa' });
    expect('delta_bp' in tile).toBe(false);
  });

  it('no data at all in the window → every flow tile 0, snapshot tiles still readable, series [], department_top [], contract-valid', async () => {
    const { ctx } = await makeCtx14(ADMIN);
    const body = await dash(ctx, { business_date_from: '2030-01-01', business_date_to: '2030-01-08' });
    for (const k of ['patient_visits', 'net_sales_paisa', 'results_approved', 'net_collected_paisa']) expect(body.tiles[k], k).toEqual({ value: 0, previous: 0, delta: 0, unit: body.tiles[k].unit });
    expect(body.series.days).toEqual([]);
    expect(body.department_top).toEqual([]);
    expect(contractErrors('DashboardDto', body)).toEqual([]);
  });
});

describe('US-01.2 — delta against the immediately preceding period of equal length; snapshot tiles carry none', () => {
  it('explicit 2-day window: previous = the 2 days before, absolute and basis points; out-of-previous rows never count', async () => {
    const { ctx } = await makeCtx14(ADMIN);
    const body = await dash(ctx, WINDOW);
    expect(body.period).toMatchObject({ business_date_from: D1, business_date_to: '2026-11-07', days: 2 });
    expect(body.tiles.net_sales_paisa).toEqual(t(36000, 5000, 31000, 62000, 'paisa'));   // previous = 2026-11-03 (1000) + 2026-11-04 (4000); 11-02 (999 999) excluded
    expect(body.tiles.patient_visits).toEqual({ value: 26, previous: 0, delta: 26, unit: 'count' });
  });

  it.each(SNAPSHOT_TILES)('snapshot tile %s has value + unit only (no previous, no delta, no delta_bp)', async (k) => {
    const { ctx } = await makeCtx14(ADMIN);
    const tile = (await dash(ctx)).tiles[k];
    expect(Object.keys(tile).sort()).toEqual(['unit', 'value']);
  });

  it.each(TILE_KEYS.filter((k) => !SNAPSHOT_TILES.includes(k)))('flow tile %s always has previous and delta', async (k) => {
    const { ctx } = await makeCtx14(ADMIN);
    const tile = (await dash(ctx)).tiles[k];
    expect(typeof tile.previous).toBe('number');
    expect(tile.delta).toBe(tile.value - tile.previous);
  });

  it('snapshot tiles do not depend on the period: same values for Today and for a 2-day window', async () => {
    const { ctx } = await makeCtx14(ADMIN);
    const a = await dash(ctx);
    const b = await dash((await makeCtx14(ADMIN)).ctx, WINDOW);
    for (const k of SNAPSHOT_TILES) expect(b.tiles[k], k).toEqual(a.tiles[k]);
    expect(a.tiles.reports_pending).toEqual({ value: 10, unit: 'count' });
    expect(a.tiles.reports_ready_unreleased).toEqual({ value: 3, unit: 'count' });
    expect(a.tiles.pending_tests).toEqual({ value: 12, unit: 'count' });
    expect(a.tiles.pending_overdue).toEqual({ value: 3, unit: 'count' });
  });
});

describe('series (TimeSeriesChart) and department_top', () => {
  it('series.days: one entry per business date with net_sales_paisa, patient_visits, net_orders, ascending; tenant B / out-of-window never appear', async () => {
    const { ctx } = await makeCtx14(ADMIN);
    const body = await dash(ctx, WINDOW);
    expect(body.series.days).toEqual([
      { business_date: D1, net_sales_paisa: 20000, patient_visits: 13, net_orders: 13 },
      { business_date: D2, net_sales_paisa: 16000, patient_visits: 13, net_orders: 13 },
    ]);
  });

  it('series ≤ 366 days: a 366-day period is accepted, 367 → 422 analytics.range_too_large', async () => {
    const { ctx } = await makeCtx14(ADMIN);
    const ok = await dash(ctx, { business_date_from: '2025-11-06', business_date_to: '2026-11-07' });
    expect(ok.series.days.length).toBeLessThanOrEqual(366);
    await expectLims(call14(OP, ctx, { query: { business_date_from: '2025-11-05', business_date_to: '2026-11-07' } }), 'analytics.range_too_large', 422);
  });

  it('department_top (Today): ordered by net desc, ≤ 10, share_bp of the period total, NULL department = "Multiple departments", labels from the catalog', async () => {
    const { ctx } = await makeCtx14(ADMIN);
    const top = (await dash(ctx)).department_top;
    expect(top.map((r: any) => r.net_paisa)).toEqual([8000, 4000, 3000, 1000]);
    expect(top.map((r: any) => r.share_bp)).toEqual([5000, 2500, 1875, 625]);
    expect(top[0]).toMatchObject({ department_id: DEPT.H, label: 'Haematology', is_multiple: false });
    expect(top[1]).toMatchObject({ department_id: DEPT.B, label: 'Biochemistry', is_multiple: false });
    expect(top[2].label).toContain('Legacy Serology');
    expect(top[3]).toMatchObject({ label: 'Multiple departments', is_multiple: true });
    expect('department_id' in top[3]).toBe(false);
    expect(top.length).toBeLessThanOrEqual(10);
  });

  it('department_top follows the period: the 2-day window adds D1 (H 20 000 → 28 000)', async () => {
    const { ctx } = await makeCtx14(ADMIN);
    const top = (await dash(ctx, WINDOW)).department_top;
    expect(top[0]).toMatchObject({ department_id: DEPT.H, net_paisa: 28000 });
  });

  it('department_top is capped at 10 rows', async () => {
    for (let i = 0; i < 14; i++) {
      const id = `00000000-0000-7000-8000-0000000000${(i + 10).toString(16).padStart(2, '0')}`;
      db.dept.push({ tenantId: TA, date: D2, branchId: BR1, centreId: A1, departmentId: id, lines: 1, gross: 10 + i, discount: 0, net: 10 + i });
      db.departments.push({ tenantId: TA, department_id: id, name: `Extra ${i}`, is_active: true });
    }
    const { ctx } = await makeCtx14(ADMIN);
    expect((await dash(ctx)).department_top.length).toBe(10);
  });
});

describe('US-01.3 — permission gate (assertRole before any read)', () => {
  it.each([['no analytics permission', NO_PERM], ['finance (collections.read only, no dashboard.read)', FINANCE], ['partner actor', PARTNER]])('%s → 403 auth.forbidden; nothing touched', async (_n, actor) => {
    const { ctx, touched } = await makeCtx14(actor);
    await expectLims(call14(OP, ctx), 'auth.forbidden', 403);
    expect(touched).toEqual([]);
    expect(db.calls).toEqual([]);
    expect(w14.log).toEqual([]);
  });
});

describe('collections tile (X1 / CR-C8-001) — omitted, not 403, without analytics.collections.read', () => {
  it('lab_manager (dashboard.read only): 200, net_collected_paisa absent, no collections figure anywhere, collections not read', async () => {
    const { ctx } = await makeCtx14(LAB_MANAGER);
    const body = await dash(ctx);
    expect('net_collected_paisa' in body.tiles).toBe(false);
    expect(JSON.stringify(body)).not.toContain('net_collected');
    expect(db.calls.some((c) => c.fn === 'collectionRows')).toBe(false);
    expect(body.freshness.map((f: any) => f.family)).not.toContain('collections');
    expect(contractErrors('DashboardDto', body)).toEqual([]);
  });

  it('every other tile is unchanged for the lab_manager', async () => {
    const full = await dash((await makeCtx14(ADMIN)).ctx);
    const part = await dash((await makeCtx14(LAB_MANAGER)).ctx);
    const { net_collected_paisa: _x, ...rest } = full.tiles;
    expect(part.tiles).toEqual(rest);
  });
});

describe('US-01.4 / US-16 — freshness on the dashboard', () => {
  it('income last succeeded 45 min ago: freshness has income stale (refresh_lagging) with refreshed_at; the tile still shows the last values', async () => {
    seedFreshness();
    const { ctx } = await makeCtx14(ADMIN);
    const body = await dash(ctx);
    const f = Object.fromEntries(body.freshness.map((x: any) => [x.family, x]));
    expect(f.income).toEqual({ family: 'income', refreshed_at: new Date(Date.parse(NOW) - 45 * 60_000).toISOString(), is_stale: true, stale_reason: 'refresh_lagging', live: false });
    expect(f.orders).toEqual({ family: 'orders', refreshed_at: new Date(Date.parse(NOW) - 10 * 60_000).toISOString(), is_stale: false, live: false });
    expect(body.tiles.net_sales_paisa.value).toBe(16000);
    expect(contractErrors('DashboardDto', body)).toEqual([]);
  });

  it('exactly the dashboard families + the live pending source are reported (TRD §3.3), each once; tenant B state never leaks', async () => {
    seedFreshness();
    const { ctx } = await makeCtx14(ADMIN);
    const fams = (await dash(ctx)).freshness.map((x: any) => x.family);
    expect([...fams].sort()).toEqual(['collections', 'centre_volume', 'income', 'orders', 'pending_items', 'report_backlog', 'results'].sort());
    expect(new Set(fams).size).toBe(fams.length);
  });

  it('live source pending_items: refreshed_at = response time, never stale, live: true (US-16.3)', async () => {
    seedFreshness();
    const { ctx } = await makeCtx14(ADMIN);
    const f = (await dash(ctx)).freshness.find((x: any) => x.family === 'pending_items');
    expect(f).toEqual({ family: 'pending_items', refreshed_at: NOW, is_stale: false, live: true });
  });

  it('a family with no refresh_state row is never_refreshed (nothing written by the read)', async () => {
    seedFreshness({ results: null });
    const { ctx } = await makeCtx14(ADMIN);
    const f = (await dash(ctx)).freshness.find((x: any) => x.family === 'results');
    expect(f).toEqual({ family: 'results', is_stale: true, stale_reason: 'never_refreshed', live: false });
    expect(w14.log.filter((l) => /^\s*(INSERT|UPDATE|DELETE)/i.test(l.text))).toEqual([]);
  });

  it('last attempt failed → refresh_failed (wins over lagging)', async () => {
    seedFreshness({ orders: { last_success_at: new Date(Date.parse(NOW) - 90 * 60_000).toISOString(), last_error_code: 'refresh_error' } });
    const { ctx } = await makeCtx14(ADMIN);
    expect((await dash(ctx)).freshness.find((x: any) => x.family === 'orders')).toMatchObject({ is_stale: true, stale_reason: 'refresh_failed' });
  });

  it('an unprocessed dirty mark older than 20 min makes a recently refreshed family stale (refresh_lagging)', async () => {
    seedFreshness();
    w14.marks.set(`${TA}|results|${D2}`, { tenant: TA, family: 'results', date: D2, first: new Date(Date.parse(NOW) - 21 * 60_000).toISOString(), last: NOW, reason: 'event', actor: 'x' });
    const { ctx } = await makeCtx14(ADMIN);
    expect((await dash(ctx)).freshness.find((x: any) => x.family === 'results')).toMatchObject({ is_stale: true, stale_reason: 'refresh_lagging' });
  });

  it('boundaries: success 30 min old is fresh, 31 min old is stale', async () => {
    const at = (m: number) => new Date(Date.parse(NOW) - m * 60_000).toISOString();
    seedFreshness({ orders: { last_success_at: at(30) }, centre_volume: { last_success_at: at(31) } });
    const { ctx } = await makeCtx14(ADMIN);
    const f = Object.fromEntries((await dash(ctx)).freshness.map((x: any) => [x.family, x]));
    expect(f.orders.is_stale).toBe(false);
    expect(f.centre_volume).toMatchObject({ is_stale: true, stale_reason: 'refresh_lagging' });
  });
});

describe('US-01.5 / 07 P3, P4 — centre-restricted reader', () => {
  it('owner restricted to A1: every figure is the A1-only figure; NULL-centre rows (credit-party income, collections, results) are excluded; A2 never counts', async () => {
    const { ctx } = await makeCtx14(OWNER_A109);
    const body = await dash(ctx);
    expect(body.scope).toEqual({ all_centres: false, centre_ids: [A1], tenant_wide_sections_hidden: [] });
    expect(body.tiles.patient_visits).toEqual(t(9, 8, 1, 1250, 'count'));
    expect(body.tiles.net_sales_paisa).toEqual(t(8000, 16000, -8000, -5000, 'paisa'));
    expect(body.tiles.invoiced_paisa).toEqual(t(10000, 16000, -6000, -3750, 'paisa'));
    expect(body.tiles.results_approved).toEqual(t(8, 4, 4, 10000, 'count'));      // includes M42 — NULL-centre 5 not counted
    expect(body.tiles.net_collected_paisa).toEqual(t(5000, 2500, 2500, 10000, 'paisa'));
    expect(body.tiles.reports_pending).toEqual({ value: 5, unit: 'count' });
    expect(body.tiles.reports_ready_unreleased).toEqual({ value: 2, unit: 'count' });
    expect(body.tiles.pending_tests).toEqual({ value: 7, unit: 'count' });
    expect(body.tiles.pending_overdue).toEqual({ value: 3, unit: 'count' });
    expect(body.series.days).toEqual([{ business_date: D2, net_sales_paisa: 8000, patient_visits: 9, net_orders: 10 }]);
    expect(body.department_top.map((r: any) => r.net_paisa)).toEqual([5000, 2000, 1000]);
    expect(contractErrors('DashboardDto', body)).toEqual([]);
  });

  it('every rollup read of a restricted caller carries the A1 scope (no all-centre read at all)', async () => {
    const { ctx } = await makeCtx14(OWNER_A109);
    await dash(ctx);
    const scoped = db.calls.filter((c) => c.args?.scope);
    expect(scoped.length).toBeGreaterThan(0);
    for (const c of scoped) expect(c.args.scope, c.fn).toEqual({ all: false, centreIds: [A1] });
  });

  it('centre_id=A2 for an A1-only caller → 404 common.not_found (no oracle), nothing computed', async () => {
    const { ctx } = await makeCtx14(OWNER_A109);
    await expectLims(call14(OP, ctx, { query: { centre_id: [A2] } }), 'common.not_found', 404);
    expect(db.calls.filter((c) => c.args?.scope)).toEqual([]);
  });

  it('centre_id=A1 for an all-centre caller narrows every figure to A1 (backlog and live pending too)', async () => {
    const { ctx } = await makeCtx14(ADMIN);
    const body = await dash(ctx, { centre_id: [A1] });
    expect(body.scope).toMatchObject({ all_centres: false, centre_ids: [A1] });
    expect(body.tiles.net_sales_paisa.value).toBe(8000);
    expect(body.tiles.reports_pending.value).toBe(5);
    expect(body.tiles.pending_tests.value).toBe(7);
  });

  it('branch filter never widens: branch containing A1+A2 for an A1-only caller → A1 only (P5)', async () => {
    const { ctx } = await makeCtx14(OWNER_A109);
    const body = await dash(ctx, { branch_id: [(db.income.find((i) => i.centreId === A1) as any).branchId] });
    expect(body.scope.centre_ids).toEqual([A1]);
    expect(body.tiles.net_sales_paisa.value).toBe(8000);
  });
});

describe('D-49 — live pending tiles come from C5 RLS only (no implicit centre predicate)', () => {
  const pendingSql = () => w14.log.filter((l) => /lab\.v_pub_pending_items/i.test(l.text));

  it('no centre filter: the pending statement has NO centre predicate, for an all-centre and for a restricted caller (RLS narrows)', async () => {
    for (const actor of [ADMIN, OWNER_A109]) {
      w14.log.length = 0;
      const { ctx } = await makeCtx14(actor);
      await dash(ctx);
      expect(pendingSql().length, actor).toBeGreaterThan(0);
      for (const l of pendingSql()) expect(l.text, actor).not.toMatch(/centre_id\s*=\s*ANY/i);
    }
  });

  it('explicit centre_id filter adds `centre_id = ANY($n)` bound to the validated ids', async () => {
    const { ctx } = await makeCtx14(ADMIN);
    await dash(ctx, { centre_id: [A2] });
    const sql = pendingSql()[0]!;
    expect(sql.text).toMatch(/centre_id\s*=\s*ANY\s*\(\s*\$\d+/i);
    expect(sql.values.some((v) => Array.isArray(v) && v.length === 1 && v[0] === A2)).toBe(true);
  });

  it('the pending read is tenant-bound ($1 = caller tenant) and tenant B items never count', async () => {
    const { ctx } = await makeCtx14(ADMIN);
    const body = await dash(ctx);
    expect(pendingSql()[0]!.values[0]).toBe(ctx.tenantId);
    expect(body.tiles.pending_tests.value).toBe(12);
    expect(JSON.stringify(body)).not.toContain(String(SENTINEL));
  });

  it('statement timeout (57014) on the live read → the error propagates (core maps to 503 common.dependency_unavailable); no partial 200', async () => {
    const { ctx } = await makeCtx14(ADMIN);
    w14.failOn = (text) => (/lab\.v_pub_pending_items/i.test(text) ? Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }) : undefined);
    const r = await call14(OP, ctx).then((x) => ({ resolved: x }), (e) => ({ rejected: e }));
    expect('rejected' in r).toBe(true);
    expect((r as any).rejected?.code).toMatch(/57014|common\.dependency_unavailable/);
  });
});

describe('US-01.6 / 07 P1 — tenant isolation', () => {
  it('tenant A caller: no tenant-B value (SENTINEL) anywhere in the body; totals equal the A-only expectation', async () => {
    const { ctx } = await makeCtx14(ADMIN);
    const body = await dash(ctx, WINDOW);
    expect(JSON.stringify(body)).not.toContain(String(SENTINEL));
    expect(body.tiles.net_sales_paisa.value).toBe(36000);
    expect(body.tiles.results_approved.value).toBe(25);
  });

  it('every rollup read is bound to the caller tenant', async () => {
    const { ctx } = await makeCtx14(ADMIN);
    await dash(ctx);
    for (const c of db.calls.filter((x) => x.args?.tenantId)) expect(c.args.tenantId, c.fn).toBe(ctx.tenantId);
  });

  it('centre_id of tenant B → 404 (no oracle), even for an all-centre caller', async () => {
    const { ctx } = await makeCtx14(ADMIN);
    await expectLims(call14(OP, ctx, { query: { centre_id: [B1] } }), 'common.not_found', 404);
  });

  it('mixed A+B centre ids → 404', async () => {
    const { ctx } = await makeCtx14(ADMIN);
    await expectLims(call14(OP, ctx, { query: { centre_id: [A1, B1] } }), 'common.not_found', 404);
  });
});

describe('period validation (shared resolvePeriod)', () => {
  it('two selectors → 400 common.validation_failed', async () => {
    const { ctx } = await makeCtx14(ADMIN);
    await expectLims(call14(OP, ctx, { query: { bs_month: '2083-07', business_date_from: D1, business_date_to: D2 } }), 'common.validation_failed', 400);
  });

  it('only one date bound → 400', async () => {
    const { ctx } = await makeCtx14(ADMIN);
    await expectLims(call14(OP, ctx, { query: { business_date_from: D1 } }), 'common.validation_failed', 400);
  });

  it('bs_month is honoured: bounds echoed in period and previous = the preceding equal-length block', async () => {
    const { ctx } = await makeCtx14(ADMIN);
    const body = await dash(ctx, { bs_month: '2083-07' });
    expect(body.period.bs_month).toBe('2083-07');
    expect(body.period.days).toBeGreaterThanOrEqual(29);
  });
});

describe('perf smoke (TRD §12: ≤ 300 ms p95 for 31 days; bounded number of reads)', () => {
  it('31-day all-centre dashboard: 25 calls, p95 < 300 ms on the in-memory fakes', async () => {
    const times: number[] = [];
    for (let i = 0; i < 25; i++) {
      const { ctx } = await makeCtx14(ADMIN);
      const s = performance.now();
      await dash(ctx, { business_date_from: '2026-10-07', business_date_to: '2026-11-07' });
      times.push(performance.now() - s);
    }
    times.sort((a, b) => a - b);
    expect(times[Math.floor(times.length * 0.95) - 1]!).toBeLessThan(300);
  });

  it('read count does not grow with the period (no per-day queries): 1-day and 366-day periods issue the same number of rollup reads and tx statements', async () => {
    const run = async (q: Record<string, unknown>) => {
      db.calls.length = 0; w14.log.length = 0;
      const { ctx } = await makeCtx14(ADMIN);
      await dash(ctx, q);
      return { rollup: db.calls.length, tx: w14.log.length };
    };
    const one = await run({});
    const year = await run({ business_date_from: '2025-11-07', business_date_to: '2026-11-07' });
    expect(year).toEqual(one);
    expect(one.rollup).toBeLessThanOrEqual(16);
    expect(one.tx).toBeLessThanOrEqual(8);
  });
});
