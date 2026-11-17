// C8 AN-T14 security tests — 07-SECURITY §5: P1, P3, P4, P7 (user writes), P12/X1 (privilege), P13 (no money-per-referrer / no "commission"), X2 (extra body field),
// X3 (DTO key sets), manual-refresh DoS bound (§3). Same harness as the functional tests (./helpers.t14.ts).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  A1, A2, ADMIN, B1, COLL_NO_CASH, FAMILIES, FINANCE, LAB_MANAGER, NO_PERM, OWNER_A109, PARTNER, SENTINEL, TA, TB, WINDOW,
  call14, dash, db, expectLims, makeCtx14, ok14, rejection, seedFreshness, seedT14, stateOf, w14, writes,
} from './helpers.t14.js';

vi.mock('../../repository/rollups.repo.js', async () => (await import('./helpers.t14.js')).rollupsMock14);
vi.mock('../../repository/labels.repo.js', async () => (await import('./helpers.t14.js')).labelsRepoMock14);

beforeEach(() => { seedT14(); vi.clearAllMocks(); });

const OPS = ['getAnalyticsDashboard', 'getAnalyticsFreshness', 'requestAnalyticsRefresh'] as const;
const run = (op: (typeof OPS)[number], ctx: any, query: Record<string, unknown> = {}) => call14(op, ctx, op === 'requestAnalyticsRefresh' ? { body: {} } : { query });
const allKeys = (v: unknown, out: string[] = []): string[] => {
  if (Array.isArray(v)) v.forEach((x) => allKeys(x, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.push(k); allKeys(x, out); }
  return out;
};

describe('authorisation precedes everything (REQ-SEC-013, CV §10.1)', () => {
  it.each(OPS.flatMap((op) => [[op, NO_PERM], [op, FINANCE], [op, PARTNER]] as const))('%s as %s → 403 auth.forbidden, zero reads, zero writes', async (op, actor) => {
    const { ctx, touched } = await makeCtx14(actor);
    await expectLims(run(op, ctx), 'auth.forbidden', 403);
    expect(touched).toEqual([]);
    expect(w14.log).toEqual([]);
    expect(db.calls).toEqual([]);
    expect(w14.jobs).toEqual([]);
  });

  it('hostile query/body for an unauthorised caller still yields 403 (no validation oracle before the permission check)', async () => {
    const { ctx } = await makeCtx14(NO_PERM);
    await expectLims(call14('getAnalyticsDashboard', ctx, { query: { centre_id: ['not-a-uuid'], bs_month: '99' } }), 'auth.forbidden', 403);
    await expectLims(call14('requestAnalyticsRefresh', (await makeCtx14(NO_PERM)).ctx, { body: { families: ['x; DROP TABLE analytics.refresh_state'] } }), 'auth.forbidden', 403);
  });
});

describe('X1 — privilege escalation via the dashboard', () => {
  it('without analytics.collections.read there is no collections tile, no collections key and no collections read at all (tile omitted, not 403)', async () => {
    const { ctx } = await makeCtx14(LAB_MANAGER);
    const body = await dash(ctx);
    expect(allKeys(body)).not.toContain('net_collected_paisa');
    expect(db.calls.map((c) => c.fn)).not.toContain('collectionRows');
    expect(w14.log.some((l) => /daily_collections/i.test(l.text))).toBe(false);
  });

  it('a holder of analytics.collections.read but not billing.cash_report.read still gets the tile (different permission)', async () => {
    const { ctx } = await makeCtx14(COLL_NO_CASH);
    expect((await dash(ctx)).tiles.net_collected_paisa.value).toBe(6500);
  });
});

describe('P1 / P3 / P4 — tenant and centre isolation of the dashboard', () => {
  it('A1-only caller: no A2 or NULL-centre figure leaks anywhere in the body (probe values made unique per centre)', async () => {
    db.income.push({ tenantId: TA, date: '2026-11-06', branchId: db.income[0]!.branchId, centreId: A2, issued: 1, cancelled: 0, gross: 7_777_001, discount: 0, exempt: 0, taxable: 7_777_001, vat: 0, other: 0, net: 7_777_001, credit: 0 });
    db.income.push({ tenantId: TA, date: '2026-11-06', branchId: db.income[0]!.branchId, centreId: null, issued: 1, cancelled: 0, gross: 8_888_002, discount: 0, exempt: 0, taxable: 8_888_002, vat: 0, other: 0, net: 8_888_002, credit: 0 });
    const text = JSON.stringify(await dash((await makeCtx14(OWNER_A109)).ctx));
    expect(text).not.toContain('7777001');
    expect(text).not.toContain('8888002');
    expect(text).not.toContain(String(SENTINEL));
  });

  it('a centre of another tenant, or a mixed A+B list, is 404 without telling which part was wrong', async () => {
    for (const ids of [[B1], [A1, B1]]) {
      const e = await expectLims(call14('getAnalyticsDashboard', (await makeCtx14(ADMIN)).ctx, { query: { centre_id: ids } }), 'common.not_found', 404);
      expect(JSON.stringify(e)).not.toContain(B1);
    }
  });

  it('scope echo for a restricted caller lists only the caller’s centres; tenant_wide_sections_hidden is empty in Phase 1', async () => {
    const body = await dash((await makeCtx14(OWNER_A109)).ctx);
    expect(body.scope.centre_ids).toEqual([A1]);
    expect(body.scope.tenant_wide_sections_hidden).toEqual([]);
  });

  it('freshness and refresh are tenant-level: tenant-B rows (state, marks) never appear and are never written', async () => {
    seedFreshness();
    w14.state.set(`${TB}|orders`, { tenant: TB, family: 'orders', last_success_at: '2020-01-01T00:00:00.000Z' });
    const fr = await ok14('getAnalyticsFreshness', (await makeCtx14(ADMIN)).ctx);
    expect(fr.data.find((r: any) => r.family === 'orders').is_stale).toBe(false);
    await ok14('requestAnalyticsRefresh', (await makeCtx14(ADMIN)).ctx, { body: {} }, 202);
    for (const w of writes().filter((x) => !/app\.enqueue_job/i.test(x.text))) expect(w.values[0], w.text).toBe(TA);
    expect(w14.jobs.every((j) => j.payload.tenant_id === TA)).toBe(true);
  });
});

describe('P13 — no per-referrer money, no "commission" anywhere in the three responses', () => {
  it('key names of dashboard / freshness / refresh responses never contain net_billed, referrer money, or commission', async () => {
    seedFreshness();
    const bodies = [await dash((await makeCtx14(ADMIN)).ctx, WINDOW), await ok14('getAnalyticsFreshness', (await makeCtx14(ADMIN)).ctx), await ok14('requestAnalyticsRefresh', (await makeCtx14(ADMIN)).ctx, { body: {} }, 202)];
    for (const b of bodies) {
      const ks = allKeys(b).join(' ');
      expect(ks).not.toMatch(/net_billed|commission|incentive|referrer/i);
    }
  });

  it('the dashboard does not read daily_referrer_billing (money per referrer) at all', async () => {
    await dash((await makeCtx14(ADMIN)).ctx);
    expect(db.calls.map((c) => c.fn)).not.toContain('referrerBillingRows');
    expect(w14.log.some((l) => /referrer_billing/i.test(l.text) && /^\s*SELECT[\s\S]*daily_referrer_billing/i.test(l.text))).toBe(false);
  });
});

describe('P7 — user writes are limited to the `_manual` throttle row, dirty marks and the queue; reads write nothing', () => {
  it('dashboard and freshness issue no INSERT/UPDATE/DELETE and no enqueue (nothing is seeded lazily on read)', async () => {
    await dash((await makeCtx14(ADMIN)).ctx);
    await ok14('getAnalyticsFreshness', (await makeCtx14(ADMIN)).ctx);
    expect(writes()).toEqual([]);
    expect(w14.state.size).toBe(0);
  });

  it('refresh writes only: refresh_state(`_manual`), dirty_partitions, app.enqueue_job — no refresh_runs, no rollup table, no DELETE', async () => {
    await ok14('requestAnalyticsRefresh', (await makeCtx14(ADMIN)).ctx, { body: {} }, 202);
    for (const w of writes()) {
      expect(w.text, w.text).toMatch(/analytics\.refresh_state|analytics\.dirty_partitions|app\.enqueue_job/i);
      expect(w.text).not.toMatch(/^\s*DELETE/i);
      expect(w.text).not.toMatch(/refresh_runs|daily_|tat_facts|report_backlog\b[\s\S]*VALUES/i);
    }
    expect([...w14.state.values()].map((s) => s.family)).toEqual(['_manual']);
  });
});

describe('input hardening of requestAnalyticsRefresh (X2, injection) — rejected with 400 before the throttle row is touched', () => {
  const bad: [string, unknown][] = [
    ['unknown family', { families: ['nope'] }],
    ['SQL metacharacters', { families: ["income'; DROP TABLE analytics.refresh_state;--"] }],
    ['uppercase / pattern violation', { families: ['Income'] }],
    ['prototype keys', { families: ['__proto__'] }],
    ['constructor', { families: ['constructor'] }],
    ['the throttle row itself', { families: ['_manual'] }],
    ['non-string item', { families: [1] }],
    ['object item', { families: [{ $ne: null }] }],
    ['families not an array', { families: 'income' }],
    ['more than 20 items', { families: Array.from({ length: 21 }, () => 'income') }],
    ['extra body field', { families: ['income'], tenant_id: TA }],
    ['body is an array', ['income']],
    ['body is a string', 'income'],
  ];
  it.each(bad)('%s → 400 common.validation_failed; no throttle row, no mark, no job', async (_n, body) => {
    const { ctx } = await makeCtx14(ADMIN);
    await expectLims(call14('requestAnalyticsRefresh', ctx, { body }), 'common.validation_failed', 400);
    expect(stateOf(TA, '_manual')).toBeUndefined();
    expect(writes()).toEqual([]);
    expect(w14.jobs).toEqual([]);
  });

  it('no statement ever carries the hostile family string', async () => {
    const { ctx } = await makeCtx14(ADMIN);
    await rejection(call14('requestAnalyticsRefresh', ctx, { body: { families: ["income'; DROP TABLE x;--"] } }));
    expect(JSON.stringify(w14.log)).not.toContain('DROP TABLE');
  });
});

describe('manual-refresh DoS bound (07-SECURITY §3: 1 per 5 min per tenant)', () => {
  it('50 sequential attempts inside one window enqueue exactly one job and mark each family once', async () => {
    let accepted = 0;
    for (let i = 0; i < 50; i++) {
      const r = await call14('requestAnalyticsRefresh', (await makeCtx14(ADMIN)).ctx, { body: {} }).catch((e) => e);
      if (r?.status === 202) accepted++; else expect(r?.code).toBe('common.rate_limited');
    }
    expect(accepted).toBe(1);
    expect(w14.jobs.length).toBe(1);
    expect(w14.marks.size).toBe(FAMILIES.length);
  });

  it('the 429 body and headers leak nothing about the other tenants or the previous caller', async () => {
    await ok14('requestAnalyticsRefresh', (await makeCtx14(ADMIN)).ctx, { body: {} }, 202);
    const e = await expectLims(call14('requestAnalyticsRefresh', (await makeCtx14(OWNER_A109)).ctx, { body: {} }), 'common.rate_limited', 429);
    expect(JSON.stringify(e)).not.toMatch(/created_by|last_manual_at|actor/i);
  });
});

describe('X3 — response key sets are exactly the contract (no extra fields)', () => {
  it('dashboard: top-level, tile and series / department_top row keys', async () => {
    const body = await dash((await makeCtx14(ADMIN)).ctx, WINDOW);
    expect(Object.keys(body).sort()).toEqual(['department_top', 'freshness', 'generated_at', 'period', 'report_code', 'scope', 'series', 'tiles']);
    for (const r of body.series.days) expect(Object.keys(r).sort()).toEqual(['business_date', 'net_orders', 'net_sales_paisa', 'patient_visits']);
    for (const r of body.department_top) for (const k of Object.keys(r)) expect(['department_id', 'label', 'is_multiple', 'net_paisa', 'share_bp']).toContain(k);
    for (const tile of Object.values(body.tiles) as any[]) for (const k of Object.keys(tile)) expect(['value', 'previous', 'delta', 'delta_bp', 'unit']).toContain(k);
  });

  it('freshness and refresh', async () => {
    seedFreshness();
    const fr = await ok14('getAnalyticsFreshness', (await makeCtx14(ADMIN)).ctx);
    expect(Object.keys(fr)).toEqual(['data']);
    const rf = await ok14('requestAnalyticsRefresh', (await makeCtx14(ADMIN)).ctx, { body: {} }, 202);
    expect(Object.keys(rf).sort()).toEqual(['next_allowed_at', 'queued_families']);
  });
});
