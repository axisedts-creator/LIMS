// AN-T06 (C8) - analytics.backfill (02-TRD §9.3 + order_index seed SQL; 08 A17 D-50; PRD X5/US-20.3; done_when "backfill seeds order_index from
// reporting.v_pub_order_report_tat"; test "backfill seeds an order with no C8 event and report_backlog counts it").
// ASSUMED API: services/worker/src/jobs/analytics/tasks/backfill.ts -> `export const backfillTask: TaskHandler`;
//   payload `{ tenant_id, from, to, family? }` - ISO dates, half-open [from, to) (like every refresh range), tenant_id == ctx.tenantId.
//   Per 7-day step [a, b) (last step truncated at `to`): (1) seed order_index (INSERT ... SELECT FROM reporting.v_pub_order_report_tat ... ON CONFLICT
//   (tenant_id, order_id) DO NOTHING, registered_at window = local midnights of a..b, created_by = actor, expires_at = registered_at + 400 days);
//   (2) mark the step dirty (all families, or only `family`; reason 'backfill'); (3) run the refresh (trigger 'backfill') - before the next step starts.
import { describe, expect, it } from 'vitest';
import { refreshTenantTask } from '../tasks/refresh_tenant.js';
import { backfillTask } from '../tasks/backfill.js';
import { ACTOR, FAMILY_TABLE, SNAPSHOT_DATE, TA, TB, createWorld, type World } from './tasksFake.js';

const NOW = '2026-11-08T08:00:00.000Z';
const C1 = '01a1a98a-ac40-7000-8000-0000000c0001';
const run = (w: World, p: Record<string, unknown> = {}) => backfillTask({ tenant_id: TA, from: '2026-11-01', to: '2026-11-08', ...p } as never, w.ctx);
const tableEvents = (w: World, table: string) => w.fake.committed('replace').filter((e) => e.table === table).sort((a, b) => (a.from! < b.from! ? -1 : 1));

function seeded() {
  const w = createWorld({ now: NOW });
  w.viewOrders.push(
    { tenant: TA, order_id: 'o-inside', centre_id: C1, registered_at: '2026-11-03T05:00:00.000Z' },       // no C8 event ever saw it
    { tenant: TA, order_id: 'o-late-night', centre_id: null, registered_at: '2026-11-07T19:00:00.000Z' }, // 00:45 local on the 8th -> outside [11-01, 11-08)
    { tenant: TA, order_id: 'o-before', centre_id: C1, registered_at: '2026-10-20T05:00:00.000Z' },
    { tenant: TA, order_id: 'o-known', centre_id: C1, registered_at: '2026-11-05T05:00:00.000Z' },
    { tenant: TB, order_id: 'o-other-tenant', centre_id: C1, registered_at: '2026-11-03T05:00:00.000Z' },
  );
  w.orderIndex.push({ tenant: TA, order_id: 'o-known', centre_id: C1, branch_id: 'branch-1', referrer_id: 'ref-1', registered_at: '2026-11-05T05:00:00.000Z', registered_on: '2026-11-05', created_by: 'event', cancelled_at: null });
  return w;
}

describe('order_index seed (D-50)', () => {
  it('seeds an order that no C8 event saw: centre + local registered_on, branch/referrer NULL, created_by = actor; window = local days [from, to)', async () => {
    const w = seeded();
    await run(w);
    expect(w.orderIndex.find((o) => o.order_id === 'o-inside')).toMatchObject({ tenant: TA, centre_id: C1, registered_at: '2026-11-03T05:00:00.000Z', registered_on: '2026-11-03', branch_id: null, referrer_id: null, cancelled_at: null, created_by: ACTOR });
    expect(w.orderIndex.some((o) => o.order_id === 'o-before')).toBe(false);
    expect(w.orderIndex.some((o) => o.order_id === 'o-late-night')).toBe(false);   // 2026-11-07T19:00Z is the 8th locally: outside [11-01, 11-08)
    expect(w.orderIndex.some((o) => o.tenant === TB)).toBe(false);                  // tenant-scoped
  });

  it('seed SQL shape: reads the published view only, local-time bucket, 400-day expiry, ON CONFLICT (tenant_id, order_id) DO NOTHING', async () => {
    const w = seeded();
    await run(w);
    expect(w.seeds.length).toBeGreaterThanOrEqual(1);
    for (const s of w.seeds) {
      expect(s.text).toMatch(/FROM\s+reporting\.v_pub_order_report_tat/i);
      expect(s.text).toMatch(/Asia\/Kathmandu/);
      expect(s.text).toMatch(/400\s+days/i);
      expect(s.text).toMatch(/ON\s+CONFLICT\s*\(\s*tenant_id\s*,\s*order_id\s*\)\s*DO\s+NOTHING/i);
      expect(s.text).not.toMatch(/DO\s+UPDATE/i);
      expect(s.text).not.toMatch(/\bFROM\s+(frontdesk|billing|lab)\./i);             // no other module's tables (P-21)
      expect(s.values[0]).toBe(TA);
      expect(s.values).toContain(ACTOR);
    }
  });

  it('a complete row written by an event is never overwritten (branch/referrer survive), and seeding twice adds nothing', async () => {
    const w = seeded();
    await run(w); await run(w);
    expect(w.orderIndex.filter((o) => o.order_id === 'o-known')).toEqual([expect.objectContaining({ branch_id: 'branch-1', referrer_id: 'ref-1', created_by: 'event' })]);
    expect(w.orderIndex.filter((o) => o.order_id === 'o-inside')).toHaveLength(1);
  });

  it('report_backlog counts the seeded order: 0 without the backfill, 1 after it; the seed precedes the snapshot refresh', async () => {
    // control: a plain snapshot refresh (what a sweep does) cannot see an order that has no C8 event
    const before = seeded();
    before.orderIndex.length = 0;
    before.model.marks.set(`${TA}|report_backlog|${SNAPSHOT_DATE}`, { tenant: TA, family: 'report_backlog', date: SNAPSHOT_DATE, first: NOW, last: NOW });
    await refreshTenantTask({ tenant_id: TA }, before.ctx);
    expect(before.backlog.orders).toBe(0);

    const w = seeded();
    w.viewOrders.find((v) => v.order_id === 'o-known')!.released = true;      // released orders are not backlog
    await run(w);
    expect(w.backlog.orders).toBe(1);                                          // o-inside only
    const lastSeed = Math.max(...w.seeds.map((s) => s.seq));
    expect(lastSeed).toBeLessThan(w.backlog.seq);
    expect(w.fake.committed('replace').some((e) => e.table === 'report_backlog')).toBe(true);
  });
});

describe('stepping, marks, refresh', () => {
  it('range of 14 days -> two 7-day steps; each step is seeded, refreshed and consumed before the next starts', async () => {
    const w = seeded();
    await run(w, { from: '2026-11-01', to: '2026-11-15' });
    expect(w.seeds.map((s) => [s.from, s.to])).toEqual([['2026-11-01', '2026-11-08'], ['2026-11-08', '2026-11-15']]);
    const inc = tableEvents(w, 'daily_income');
    expect(inc.map((e) => [e.from, e.to])).toEqual([['2026-11-01', '2026-11-08'], ['2026-11-08', '2026-11-15']]);
    expect(w.marksOf(TA)).toEqual([]);
    const pos = (from: string) => w.fake.events.findIndex((e) => e.type === 'replace' && e.table === 'daily_income' && e.from === from);
    expect(pos('2026-11-01')).toBeLessThan(pos('2026-11-08'));
    // step 2's seed is issued after step 1's partitions were refreshed: its seq is higher than step 1's seed, and the marks of step 2 were not pre-made
    expect(w.seeds[1]!.seq).toBeGreaterThan(w.seeds[0]!.seq);
    const stepTwoMarks = w.marksMade.filter((m) => m.date >= '2026-11-08' && m.family === 'income');
    expect(stepTwoMarks.length).toBeGreaterThan(0);
    expect(Math.min(...stepTwoMarks.map((m) => m.seq))).toBeGreaterThan(w.seeds[0]!.seq);
  });

  it('a range that is not a multiple of 7 ends exactly at `to` (last step truncated; nothing outside [from, to) is touched)', async () => {
    const w = seeded();
    await run(w, { from: '2026-11-01', to: '2026-11-11' });
    expect(w.seeds.map((s) => [s.from, s.to])).toEqual([['2026-11-01', '2026-11-08'], ['2026-11-08', '2026-11-11']]);
    expect(w.marksMade.every((m) => m.family === 'report_backlog' || (m.date >= '2026-11-01' && m.date < '2026-11-11'))).toBe(true);
    for (const e of w.fake.committed('replace').filter((x) => x.from)) { expect(e.from! >= '2026-11-01').toBe(true); expect(e.to! <= '2026-11-11').toBe(true); }
  });

  it('marks every dated family of the range plus the backlog snapshot, reason backfill; runs recorded with trigger backfill; no mark left', async () => {
    const w = seeded();
    await run(w);
    expect(new Set(w.marksMade.map((m) => m.family)).size).toBe(16);
    for (const m of w.marksMade) expect(m).toMatchObject({ tenant: TA, reason: 'backfill', actor: ACTOR });
    expect(w.marksMade.filter((m) => m.family === 'report_backlog').every((m) => m.date === SNAPSHOT_DATE)).toBe(true);
    expect(w.fake.committed('run').every((r) => r.values.includes('backfill'))).toBe(true);
    expect(w.marksOf(TA)).toEqual([]);
    expect(new Set(w.fake.committed('replace').map((e) => e.table))).toEqual(new Set(Object.values(FAMILY_TABLE)));
  });

  it('`family` limits marks and refresh to that family', async () => {
    const w = seeded();
    await run(w, { family: 'income' });
    expect(new Set(w.marksMade.map((m) => m.family))).toEqual(new Set(['income']));
    expect(new Set(w.fake.committed('replace').map((e) => e.table))).toEqual(new Set(['daily_income']));
  });

  it('another tenant\'s dirty marks are neither processed nor consumed', async () => {
    const w = createWorld({ now: NOW, marks: [{ tenant: TB, family: 'income', date: '2026-11-02' }] });
    await run(w);
    expect(w.marksOf(TB)).toHaveLength(1);
    expect(w.marksMade.every((m) => m.tenant === TA)).toBe(true);
  });

  it('a failure in step 2 rejects (retry), step 1 stays done, and the retry finishes idempotently', async () => {
    let fail = true;
    const w = createWorld({ now: NOW, hook: (a) => { if (fail && a.kind === 'insertRollup' && a.table === 'daily_income' && a.values[1] === '2026-11-08') throw Object.assign(new Error('boom'), { code: '57014' }); } });
    w.viewOrders.push({ tenant: TA, order_id: 'o1', centre_id: C1, registered_at: '2026-11-03T05:00:00.000Z' });
    await expect(run(w, { to: '2026-11-15' })).rejects.toMatchObject({ code: '57014' });
    expect(tableEvents(w, 'daily_income').map((e) => e.from)).toContain('2026-11-01');
    fail = false;
    await run(w, { to: '2026-11-15' });
    expect(w.orderIndex.filter((o) => o.order_id === 'o1')).toHaveLength(1);
    expect(w.marksOf(TA)).toEqual([]);
  });

  it('end to end with the refresh task: after the backfill nothing is dirty, so a following refresh_tenant has nothing to do', async () => {
    const w = seeded();
    await run(w);
    const before = w.fake.committed('replace').length;
    await refreshTenantTask({ tenant_id: TA }, w.ctx);
    expect(w.fake.committed('replace').length).toBe(before);
  });
});

describe('input validation (trust boundary: nothing reaches SQL)', () => {
  const bad: [string, Record<string, unknown>][] = [
    ['tenant missing', { tenant_id: undefined }], ['tenant not uuid', { tenant_id: 'x' }], ['foreign tenant', { tenant_id: TB }],
    ['from missing', { from: undefined }], ['to missing', { to: undefined }], ['from not a date', { from: 'yesterday' }],
    ['impossible date', { from: '2026-02-30' }], ['month 13', { to: '2026-13-01' }], ['us format', { from: '11/01/2026' }],
    ['datetime instead of date', { from: '2026-11-01T00:00:00Z' }], ['from == to', { from: '2026-11-05', to: '2026-11-05' }],
    ['from > to', { from: '2026-11-08', to: '2026-11-01' }], ['numeric date', { from: 20261101 }],
    ['unknown family', { family: 'nope' }], ['table name as family', { family: 'daily_income' }], ['sql in family', { family: "income'; DROP TABLE analytics.daily_income;--" }],
    ['family array', { family: ['income'] }],
  ];
  for (const [name, patch] of bad) {
    it(`refuses: ${name} - before any statement, no mark, no seed`, async () => {
      const w = seeded();
      await expect(run(w, patch)).rejects.toBeTruthy();
      expect(w.texts).toEqual([]); expect(w.fake.log).toEqual([]); expect(w.marksMade).toEqual([]); expect(w.seeds).toEqual([]);
    });
  }

  it('unknown extra fields are ignored and never reach SQL', async () => {
    const w = seeded();
    await run(w, { evil: "'; DROP TABLE x;--", centre_id: 'c' });
    expect(w.texts.join('\n') + JSON.stringify(w.seeds.map((s) => s.values))).not.toMatch(/DROP TABLE/);
  });

  it('no job tenant context -> refused before any statement', async () => {
    const w = createWorld({ now: NOW, tenantId: undefined });
    await expect(run(w)).rejects.toBeTruthy();
    expect(w.texts).toEqual([]);
  });
});
