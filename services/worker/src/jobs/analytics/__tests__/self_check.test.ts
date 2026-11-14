// AN-T06 (C8) - analytics.self_check (02-TRD §9.3; PRD R2/R3/R4; US-20.3).
// ASSUMED API: services/worker/src/jobs/analytics/tasks/self_check.ts -> `export const selfCheckTask: TaskHandler`; payload `{ tenant_id }` == ctx.tenantId.
// Window = trailing 7 local days [today-7, today) (Asia/Kathmandu, injected ctx.now()). ONE read-only statement per (rule, family) binds (tenantId, from, to)
// as ISO dates and returns ONLY the mismatching dates as rows `{ business_date }` (R3: 15 dated families; R2: department_income vs income; R4: collections
// by method / staff / centre). Mismatch -> markDirty(reason 'self_check') for the affected family+date, `ctx.metrics.inc('lims_analytics_reconciliation_mismatch_total',
// { rule, family })` and `ctx.log.warn({ event: 'reconciliation_mismatch', family, business_date })`. Never edits figures.
import { describe, expect, it } from 'vitest';
import { refreshTenantTask } from '../tasks/refresh_tenant.js';
import { selfCheckTask } from '../tasks/self_check.js';
import { ACTOR, DATED, TA, TB, createWorld } from './tasksFake.js';

const NOW = '2026-11-08T21:00:00.000Z';        // 02:45 local on 2026-11-09 -> window [2026-11-02, 2026-11-09)
const METRIC = 'lims_analytics_reconciliation_mismatch_total';
const run = (w: ReturnType<typeof createWorld>, payload: Record<string, unknown> = { tenant_id: TA }) => selfCheckTask(payload as never, w.ctx);
const mm = (w: ReturnType<typeof createWorld>) => w.metrics.filter((m) => m.name === METRIC);
const remarks = (w: ReturnType<typeof createWorld>) => w.marksMade.map((m) => `${m.family}@${m.date}`).sort();

describe('self_check - clean tenant', () => {
  it('issues exactly one comparison per R3 family (15), one R2 and one R4, all bound to the tenant and to the window [today-7, today)', async () => {
    const w = createWorld({ now: NOW });
    await run(w);
    const by = (rule: string) => w.compares.filter((c) => c.rule === rule);
    expect(by('R3').map((c) => c.family).sort()).toEqual([...DATED].sort());
    expect(by('R2')).toHaveLength(1);
    expect(by('R4')).toHaveLength(1);
    expect(w.compares).toHaveLength(17);
    for (const c of w.compares) {
      expect(c.values[0], c.rule + c.family).toBe(TA);
      expect(c.values.filter((v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v))).toEqual(['2026-11-02', '2026-11-09']);
      expect(c.text).toMatch(/^\s*(SELECT|WITH)\b/i);                    // read-only
    }
  });

  it('no mismatch -> no re-mark, no metric, no warning, no write, no enqueue', async () => {
    const w = createWorld({ now: NOW });
    await run(w);
    expect(w.marksMade).toEqual([]); expect(mm(w)).toEqual([]); expect(w.warns).toEqual([]); expect(w.enqueued).toEqual([]);
    expect(w.fake.log.filter((l) => ['replaceDelete', 'insertRollup', 'deleteMarks', 'stateUpsert', 'runInsert'].includes(l.kind))).toEqual([]);
  });

  it('clock injection: the window moves with ctx.now() at the local midnight (23:59 vs 00:00 Asia/Kathmandu)', async () => {
    const a = createWorld({ now: '2026-11-08T18:14:00.000Z' });           // 23:59 local on the 8th
    await run(a);
    expect(a.compares[0]!.values.filter((v) => typeof v === 'string' && /^\d{4}-/.test(v))).toEqual(['2026-11-01', '2026-11-08']);
    const b = createWorld({ now: '2026-11-08T18:15:00.000Z' });           // 00:00 local on the 9th
    await run(b);
    expect(b.compares[0]!.values.filter((v) => typeof v === 'string' && /^\d{4}-/.test(v))).toEqual(['2026-11-02', '2026-11-09']);
  });
});

describe('self_check - mismatch injection (R3/R2/R4)', () => {
  it('R3 on income at two dates: both are re-marked (reason self_check, system actor), metric labels {rule,family} only, one warning per family+date', async () => {
    const w = createWorld({ now: NOW });
    w.mismatches.set('R3|income', ['2026-11-05', '2026-11-06']);
    await run(w);
    expect(remarks(w)).toEqual(['income@2026-11-05', 'income@2026-11-06']);
    for (const m of w.marksMade) expect(m).toMatchObject({ tenant: TA, reason: 'self_check', actor: ACTOR });
    expect(mm(w).length).toBeGreaterThanOrEqual(1);
    for (const m of mm(w)) expect(m.labels).toEqual({ rule: 'R3', family: 'income' });          // no tenant / date label: bounded cardinality
    expect(w.warns.filter((l) => l?.event === 'reconciliation_mismatch').map((l) => `${l.family}@${l.business_date}`).sort()).toEqual(['income@2026-11-05', 'income@2026-11-06']);
  });

  it('R3 mismatches in several families are all handled independently', async () => {
    const w = createWorld({ now: NOW });
    w.mismatches.set('R3|results', ['2026-11-03']); w.mismatches.set('R3|tat', ['2026-11-04']); w.mismatches.set('R3|deliveries', ['2026-11-08']);
    await run(w);
    expect(remarks(w)).toEqual(['deliveries@2026-11-08', 'results@2026-11-03', 'tat@2026-11-04']);
    expect(new Set(mm(w).map((m) => m.labels.family))).toEqual(new Set(['results', 'tat', 'deliveries']));
  });

  it('R2 (sum of departments != income): both involved families are re-marked for that date; metric rule R2', async () => {
    const w = createWorld({ now: NOW });
    w.mismatches.set('R2|department_income', ['2026-11-04']);
    await run(w);
    expect(remarks(w)).toEqual(['department_income@2026-11-04', 'income@2026-11-04']);
    expect(mm(w).length).toBeGreaterThanOrEqual(1);
    for (const m of mm(w)) { expect(m.labels.rule).toBe('R2'); expect(['income', 'department_income']).toContain(m.labels.family); }
  });

  it('R4 (collections by method != by staff != by centre): collections re-marked for that date; metric rule R4', async () => {
    const w = createWorld({ now: NOW });
    w.mismatches.set('R4|collections', ['2026-11-03']);
    await run(w);
    expect(remarks(w)).toEqual(['collections@2026-11-03']);
    for (const m of mm(w)) expect(m.labels).toEqual({ rule: 'R4', family: 'collections' });
  });

  it('the same family+date flagged by two rules is re-marked once (idempotent) but both rules are counted', async () => {
    const w = createWorld({ now: NOW });
    w.mismatches.set('R3|income', ['2026-11-05']); w.mismatches.set('R2|department_income', ['2026-11-05']);
    await run(w);
    expect(w.marksOf(TA).filter((m) => m.family === 'income' && m.date === '2026-11-05')).toHaveLength(1);
    expect(new Set(mm(w).map((m) => m.labels.rule))).toEqual(new Set(['R2', 'R3']));
  });

  it('never edits figures: no partition replace, no delete, no state/run write - only dirty marks (and at most a debounced refresh_tenant enqueue)', async () => {
    const w = createWorld({ now: NOW });
    w.mismatches.set('R3|income', ['2026-11-05']);
    await run(w);
    expect(w.fake.log.filter((l) => ['replaceDelete', 'insertRollup', 'deleteMarks', 'stateUpsert', 'runInsert', 'runUpdate'].includes(l.kind))).toEqual([]);
    expect(w.texts.filter((t) => /^\s*(UPDATE|DELETE|TRUNCATE)\b/i.test(t) || /^\s*INSERT\s+INTO\s+analytics\.(?!dirty_partitions)/i.test(t))).toEqual([]);
    expect(w.enqueued.every((e) => e.task === 'analytics.refresh_tenant')).toBe(true);
  });

  it('the warning and the metric carry ids/dates only - no amounts, no tenant name, no SQL text', async () => {
    const w = createWorld({ now: NOW });
    w.mismatches.set('R3|income', ['2026-11-05']);
    await run(w);
    for (const l of w.warns) expect(Object.keys(l).sort()).toEqual(expect.arrayContaining(['business_date', 'event', 'family']));
    expect(JSON.stringify(w.warns) + JSON.stringify(w.metrics)).not.toMatch(/SELECT|paisa|sum/i);
  });

  it('end to end: the re-mark makes the next refresh recompute exactly that partition; a second self-check is then clean', async () => {
    const w = createWorld({ now: NOW });
    w.mismatches.set('R3|income', ['2026-11-05']);
    await run(w);
    await refreshTenantTask({ tenant_id: TA }, w.ctx);
    const ev = w.fake.committed('replace').filter((e) => e.table === 'daily_income');
    expect(ev.map((e) => [e.from, e.to])).toEqual([['2026-11-05', '2026-11-06']]);
    expect(w.marksOf(TA)).toEqual([]);
    w.mismatches.clear(); w.marksMade.length = 0; w.metrics.length = 0;
    await run(w);
    expect(w.marksMade).toEqual([]); expect(mm(w)).toEqual([]);
  });

  it('mismatches reported outside the trailing 7 days cannot be produced by the window binds (dates 11-01 and 11-09 are not in [11-02, 11-09))', async () => {
    const w = createWorld({ now: NOW });
    w.mismatches.set('R3|income', ['2026-11-01', '2026-11-09', '2026-11-02', '2026-11-08']);
    await run(w);
    expect(remarks(w)).toEqual(['income@2026-11-02', 'income@2026-11-08']);
  });
});

describe('self_check - failure and trust', () => {
  it('a failing comparison rejects the task (Graphile retries, max 2); nothing is half-marked silently', async () => {
    const w = createWorld({ now: NOW });
    const boom = (t: string) => /^\s*(SELECT|WITH)\b/i.test(t) && /analytics\.daily_results/.test(t);
    const orig = w.ctx.tx.query;
    w.ctx.tx.query = async (t: string, v?: unknown[]) => { if (boom(t)) throw Object.assign(new Error('boom'), { code: '57014' }); return orig(t, v); };
    const od = w.ctx.db.tx;
    w.ctx.db.tx = (fn: (c: any) => Promise<unknown>) => od((c: any) => fn({ tx: { query: (t: string, v?: unknown[]) => (boom(t) ? Promise.reject(Object.assign(new Error('boom'), { code: '57014' })) : c.tx.query(t, v)) } }));
    w.mismatches.set('R3|income', ['2026-11-05']);
    await expect(run(w)).rejects.toMatchObject({ code: '57014' });
  });

  it('payload trust: bad / foreign tenant payloads are refused before any statement (no cross-tenant comparison by payload)', async () => {
    for (const payload of [{}, { tenant_id: '' }, { tenant_id: 'x' }, { tenant_id: TB }, { tenant_id: 5 }]) {
      const w = createWorld({ now: NOW, tenantId: TA });
      await expect(run(w, payload), JSON.stringify(payload)).rejects.toBeTruthy();
      expect(w.texts).toEqual([]); expect(w.compares).toEqual([]); expect(w.marksMade).toEqual([]);
    }
    const none = createWorld({ now: NOW, tenantId: undefined });
    await expect(run(none)).rejects.toBeTruthy();
    expect(none.texts).toEqual([]);
  });

  it('every statement is bound to the job tenant only (an injected family/date can never reach SQL)', async () => {
    const w = createWorld({ now: NOW });
    w.mismatches.set('R3|income', ['2026-11-05']);
    await run(w, { tenant_id: TA, family: "income'; DROP TABLE x;--", from: '1999-01-01' });
    expect(w.texts.join('\n') + JSON.stringify(w.compares.map((c) => c.values))).not.toMatch(/DROP TABLE|1999-01-01/);
    expect(w.marksMade.every((m) => m.tenant === TA)).toBe(true);
  });
});
