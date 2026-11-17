// AN-T06 (C8) - sweep_recent + sweep_nightly (02-TRD §9.3, §9.4; PRD US-20.3 "rollups_equal_views" after the nightly; CR-C8-012).
// ASSUMED API (tests-first; the writer may dispute with evidence):
//   services/worker/src/jobs/analytics/tasks/sweep_recent.ts  -> `export const sweepRecentTask: TaskHandler`
//   services/worker/src/jobs/analytics/tasks/sweep_nightly.ts -> `export const sweepNightlyTask: TaskHandler`
//   payload `{ tenant_id }` must equal ctx.tenantId (like refresh_tenant); "today" = Asia/Kathmandu date of the INJECTED clock ctx.now();
//   marks go through the repo's markDirty (INSERT INTO analytics.dirty_partitions, reason = the task name, created_by = ctx.actor.id);
//   the refresh then runs INLINE (refreshTenant, trigger = the task name); nightly then enqueues analytics.self_check via app.enqueue_job.
import { describe, expect, it } from 'vitest';
import { manifest } from '../index.js';
import { sweepNightlyTask } from '../tasks/sweep_nightly.js';
import { sweepRecentTask } from '../tasks/sweep_recent.js';
import { ACTOR, DATED, FAMILY_TABLE, SNAPSHOT_DATE, TA, TB, addDays, createWorld, type Family } from './tasksFake.js';

const run = (task: typeof sweepRecentTask, w: ReturnType<typeof createWorld>, payload: Record<string, unknown> = { tenant_id: TA }) => task(payload as never, w.ctx);
const marksFor = (w: ReturnType<typeof createWorld>, family: string) => w.marksMade.filter((m) => m.family === family).map((m) => m.date).sort();
const replaceTables = (w: ReturnType<typeof createWorld>) => [...new Set(w.fake.committed('replace').map((e) => e.table!))].sort();
const ALL_TABLES = Object.values(FAMILY_TABLE).sort();

describe('manifest wiring (done_when: cron entries in manifest; taskOptions 120 s for nightly/backfill, CR-C8-012)', () => {
  it('sweeps/self_check/purge/backfill are the real tasks, not the fail-closed AN-T01 stubs', async () => {
    const w = createWorld();
    for (const id of ['analytics.sweep_recent', 'analytics.sweep_nightly', 'analytics.self_check', 'analytics.purge', 'analytics.backfill']) {
      expect(manifest.tasks![id], id).toBeTypeOf('function');
      // a stub throws "<id> not implemented" for ANY input; a real task refuses a bad payload with a different reason
      await expect(manifest.tasks![id]!({} as never, w.ctx), id).rejects.not.toThrow(/not implemented/);
    }
    expect(manifest.tasks!['analytics.sweep_recent']).toBe(sweepRecentTask);
    expect(manifest.tasks!['analytics.sweep_nightly']).toBe(sweepNightlyTask);
  });

  it('cron entries and 120 s timeouts stay as in TRD §9.4 (nightly + backfill only)', () => {
    const cron = Object.fromEntries((manifest.crontab ?? []).map((c) => [c.identifier, c.schedule]));
    expect(cron['analytics.sweep_recent']).toBe('*/10 * * * *');
    expect(cron['analytics.sweep_nightly']).toBe('45 20 * * *');
    expect(cron['analytics.purge']).toBe('15 21 * * *');
    expect(Object.keys(cron)).not.toContain('analytics.self_check');
    expect(manifest.taskOptions).toEqual({ 'analytics.sweep_nightly': { statementTimeoutMs: 120000 }, 'analytics.backfill': { statementTimeoutMs: 120000 } });
  });
});

describe('analytics.sweep_recent (TRD §9.3: every family @ today; @ yesterday too while local time < 06:00; backlog snapshot; refresh inline)', () => {
  it('daytime: marks the 15 dated families @ local today only, the backlog snapshot once, reason sweep_recent, created_by = system actor', async () => {
    const w = createWorld({ now: '2026-11-08T08:00:00.000Z' });          // 13:45 Asia/Kathmandu
    await run(sweepRecentTask, w);
    const dated = w.marksMade.filter((m) => m.family !== 'report_backlog');
    expect(dated.map((m) => m.family).sort()).toEqual([...DATED].sort());
    expect(new Set(dated.map((m) => m.date))).toEqual(new Set(['2026-11-08']));
    expect(w.marksMade.filter((m) => m.family === 'report_backlog').map((m) => m.date)).toEqual([SNAPSHOT_DATE]);
    for (const m of w.marksMade) expect(m).toMatchObject({ tenant: TA, reason: 'sweep_recent', actor: ACTOR });
    expect(w.marksMade).toHaveLength(16);
  });

  it('then runs the refresh INLINE: all 16 tables replaced, marks consumed, runs recorded with trigger sweep_recent; no enqueue needed', async () => {
    const w = createWorld({ now: '2026-11-08T08:00:00.000Z' });
    await run(sweepRecentTask, w);
    expect(replaceTables(w)).toEqual(ALL_TABLES);
    expect(w.marksOf(TA)).toEqual([]);
    const runs = w.fake.committed('run');
    expect(runs).toHaveLength(16);
    for (const r of runs) expect(r.values).toContain('sweep_recent');
    expect(w.enqueued.filter((e) => e.task !== 'analytics.refresh_tenant')).toEqual([]);
  });

  it('local time < 06:00: yesterday is marked as well (15 families x 2 days + snapshot); the instant is 03:15 local on 2026-11-08 = 21:30Z on the 7th', async () => {
    const w = createWorld({ now: '2026-11-07T21:30:00.000Z' });
    await run(sweepRecentTask, w);
    for (const f of DATED) expect(marksFor(w, f), f).toEqual(['2026-11-07', '2026-11-08']);
    expect(marksFor(w, 'report_backlog')).toEqual([SNAPSHOT_DATE]);
    expect(w.marksMade).toHaveLength(31);
  });

  it('the 06:00 boundary is local (Asia/Kathmandu, UTC+05:45): 05:59 still marks yesterday, 06:00 does not', async () => {
    const before = createWorld({ now: '2026-11-08T00:14:00.000Z' });      // 05:59 local
    await run(sweepRecentTask, before);
    expect(marksFor(before, 'income')).toEqual(['2026-11-07', '2026-11-08']);
    const at = createWorld({ now: '2026-11-08T00:15:00.000Z' });          // 06:00 local
    await run(sweepRecentTask, at);
    expect(marksFor(at, 'income')).toEqual(['2026-11-08']);
  });

  it('"today" is the LOCAL date, not the UTC date: 19:00Z on the 7th is 00:45 local on the 8th', async () => {
    const w = createWorld({ now: '2026-11-07T19:00:00.000Z' });
    await run(sweepRecentTask, w);
    expect(marksFor(w, 'results')).toEqual(['2026-11-07', '2026-11-08']);   // yesterday (7th) + today (8th); NOT the 6th/7th
  });

  it('clock injection: the same task at two instants marks two different days (no wall-clock read)', async () => {
    const w = createWorld({ now: '2026-12-30T08:00:00.000Z' });
    await run(sweepRecentTask, w);
    expect(marksFor(w, 'orders')).toEqual(['2026-12-30']);
    w.setNow('2027-01-01T08:00:00.000Z');
    await run(sweepRecentTask, w);
    expect(marksFor(w, 'orders')).toEqual(['2026-12-30', '2027-01-01']);
  });

  it('only the job tenant is touched: another tenant\'s dirty marks stay', async () => {
    const w = createWorld({ now: '2026-11-08T08:00:00.000Z', marks: [{ tenant: TB, family: 'income', date: '2026-11-01' }] });
    await run(sweepRecentTask, w);
    expect(w.marksMade.every((m) => m.tenant === TA)).toBe(true);
    expect(w.marksOf(TB)).toHaveLength(1);
    expect(w.fake.committed('replace').length).toBeGreaterThan(0);
  });

  it('a pre-existing older dirty mark of the same tenant is processed by the same inline refresh (nothing is left behind)', async () => {
    const w = createWorld({ now: '2026-11-08T08:00:00.000Z', marks: [{ tenant: TA, family: 'income', date: '2026-11-02' }] });
    await run(sweepRecentTask, w);
    expect(w.marksOf(TA)).toEqual([]);
    expect(w.fake.committed('replace').some((e) => e.table === 'daily_income' && e.from === '2026-11-02')).toBe(true);
  });

  it('a failing family makes the sweep reject (Graphile retries), its mark stays, the other families are still refreshed', async () => {
    const w = createWorld({
      now: '2026-11-08T08:00:00.000Z',
      hook: (a) => { if (a.kind === 'insertRollup' && a.table === 'daily_income') throw Object.assign(new Error('boom'), { code: '57014' }); },
    });
    await expect(run(sweepRecentTask, w)).rejects.toMatchObject({ code: '57014' });
    expect(w.marksOf(TA).map((m) => m.family)).toEqual(['income']);
    expect(replaceTables(w)).not.toContain('daily_income');
    expect(replaceTables(w)).toHaveLength(15);
  });

  it('payload trust: missing / non-uuid / other-tenant tenant_id and a missing job tenant are refused before any statement', async () => {
    for (const payload of [{}, { tenant_id: '' }, { tenant_id: 'nope' }, { tenant_id: 7 }, { tenant_id: TB }, { tenant_id: ["' OR 1=1"] }]) {
      const w = createWorld({ tenantId: TA });
      await expect(run(sweepRecentTask, w, payload), JSON.stringify(payload)).rejects.toBeTruthy();
      expect(w.texts).toEqual([]); expect(w.fake.log).toEqual([]);
    }
    const w = createWorld({ tenantId: undefined });
    await expect(run(sweepRecentTask, w)).rejects.toBeTruthy();
    expect(w.texts).toEqual([]); expect(w.fake.log).toEqual([]);
  });
});

describe('analytics.sweep_nightly (TRD §9.3: mark all families dirty for [today-40d, today), refresh, then enqueue self_check)', () => {
  const NOW = '2026-11-08T21:00:00.000Z';       // 02:45 local on 2026-11-09 -> window [2026-09-30, 2026-11-09)
  const FROM = '2026-09-30', TO = '2026-11-09';

  it('marks every dated family for each of the 40 local days before today (reason sweep_nightly), never today itself', async () => {
    const w = createWorld({ now: NOW });
    await run(sweepNightlyTask, w);
    const expected = Array.from({ length: 40 }, (_, i) => addDays(FROM, i));
    expect(expected.at(-1)).toBe('2026-11-08');
    for (const f of DATED) expect(marksFor(w, f), f).toEqual(expected);
    expect(w.marksMade.filter((m) => m.family !== 'report_backlog')).toHaveLength(15 * 40);
    for (const m of w.marksMade) expect(m).toMatchObject({ tenant: TA, reason: 'sweep_nightly', actor: ACTOR });
    expect(w.marksMade.some((m) => m.date === TO)).toBe(false);
    const snap = w.marksMade.filter((m) => m.family === 'report_backlog');
    expect(snap.every((m) => m.date === SNAPSHOT_DATE) && snap.length <= 1).toBe(true);   // snapshot family: sentinel date only (dirty_partitions__snapshot__ck)
  });

  it('US-20.3: the refresh covers the whole window in <= 7-day chunks per family; every table replaced; no dirty mark left', async () => {
    const w = createWorld({ now: NOW });
    await run(sweepNightlyTask, w);
    for (const f of DATED.filter((x) => x !== 'tat' && x !== 'specimens')) {
      const evs = w.fake.committed('replace').filter((e) => e.table === FAMILY_TABLE[f]).sort((a, b) => (a.from! < b.from! ? -1 : 1));
      expect(evs.map((e) => [e.from, e.to]), f).toEqual([[FROM, '2026-10-07'], ['2026-10-07', '2026-10-14'], ['2026-10-14', '2026-10-21'], ['2026-10-21', '2026-10-28'], ['2026-10-28', '2026-11-04'], ['2026-11-04', TO]]);
    }
    expect(replaceTables(w)).toEqual(expect.arrayContaining(ALL_TABLES.filter((t) => t !== 'report_backlog')));
    expect(w.marksOf(TA)).toEqual([]);
    for (const r of w.fake.committed('run')) expect(r.values).toContain('sweep_nightly');
  });

  it('after the refresh it enqueues exactly one analytics.self_check for the tenant, never before the data is refreshed', async () => {
    const w = createWorld({ now: NOW });
    await run(sweepNightlyTask, w);
    const sc = w.enqueued.filter((e) => e.task === 'analytics.self_check');
    expect(sc).toHaveLength(1);
    expect(sc[0]!.payload).toEqual({ tenant_id: TA });
    expect(sc[0]!.values.some((v) => typeof v === 'string' && v.includes(TA) && v !== JSON.stringify({ tenant_id: TA }))).toBe(true);   // a job_key that dedupes per tenant
    expect(w.fake.committed('replace').length).toBeGreaterThan(0);
    expect(w.enqueued.map((e) => e.task).filter((t) => t !== 'analytics.refresh_tenant')).toEqual(['analytics.self_check']);
  });

  it('a failing refresh makes the nightly reject and self_check is NOT enqueued (it would compare stale partitions)', async () => {
    const w = createWorld({ now: NOW, hook: (a) => { if (a.kind === 'insertRollup' && a.table === 'daily_results') throw Object.assign(new Error('boom'), { code: '57014' }); } });
    await expect(run(sweepNightlyTask, w)).rejects.toMatchObject({ code: '57014' });
    expect(w.enqueued.filter((e) => e.task === 'analytics.self_check')).toEqual([]);
    expect(w.marksOf(TA).some((m) => m.family === 'results')).toBe(true);
  });

  it('a failing enqueue is not swallowed (the nightly is retried; replacing partitions twice is idempotent)', async () => {
    const w = createWorld({ now: NOW, failEnqueue: true });
    await expect(run(sweepNightlyTask, w)).rejects.toMatchObject({ code: '57P01' });
  });

  it('clock injection: the window follows ctx.now() across a month/year boundary (local 00:00 on 2027-01-01)', async () => {
    const w = createWorld({ now: '2026-12-31T18:15:00.000Z' });                     // 2027-01-01 00:00 local
    await run(sweepNightlyTask, w);
    expect(marksFor(w, 'income')[0]).toBe('2026-11-22');
    expect(marksFor(w, 'income').at(-1)).toBe('2026-12-31');
    expect(marksFor(w, 'income')).toHaveLength(40);
  });

  it('payload trust: bad / foreign tenant payloads are refused before any statement', async () => {
    for (const payload of [{}, { tenant_id: 'x' }, { tenant_id: TB }, { tenant_id: null }]) {
      const w = createWorld({ now: NOW, tenantId: TA });
      await expect(run(sweepNightlyTask, w, payload as never), JSON.stringify(payload)).rejects.toBeTruthy();
      expect(w.texts).toEqual([]); expect(w.fake.log).toEqual([]); expect(w.enqueued).toEqual([]);
    }
  });
});

export type { Family };
