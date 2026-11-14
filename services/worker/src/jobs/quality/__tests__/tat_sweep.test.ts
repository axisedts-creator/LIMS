// C9 T-19 — worker task quality.tat_sweep (02-TRD §9.3, §10.3, §14; PRD AC-14.1; 07-SECURITY REQ-SEC-024). No database: the tat service is faked (behaviour: api tat.service.test.ts).
// SEAMS (writer matches or disputes):
//   ../tasks/tat_sweep.ts  exports `createTatSweepHandler(deps?: { service?: { sweep(ctx): Promise<SweepResult> } }): TaskHandler` and `handle` (= the handler on the real tat service).
//   SweepResult = { seen, created, raised: Array<{ level, segment, lagSeconds }>, stopped, cancelled, orphanClosed, openAlerts: { warning, breached, escalated } } (api tat.helpers.ts header).
//   The handler: (1) tenant guard — payload.tenant_id must equal ctx.tenantId, else throws BEFORE any service call or query; (2) `await service.sweep(ctx)` ONCE on the JOB ctx;
//   (3) AFTER the service resolved, through the optional ctx.metrics (§14): observe `lims_quality_tat_sweep_duration_seconds` ONCE (no labels, finite >= 0); inc `lims_quality_tat_alerts_total`
//   {level, segment} once per raised alert; observe `lims_quality_tat_alert_lag_seconds` (no labels) once per raised alert with its lagSeconds; set `lims_quality_tat_open_alerts` {level, tenant_id}
//   for EACH of warning, breached, escalated (0 included, so the alert clears). Missing ctx.metrics is fine. A service error propagates and then NO metric is written.
// Fails now: "Cannot find module ../tasks/tat_sweep.js".
import { describe, expect, it, vi } from 'vitest';
import { createTatSweepHandler } from '../tasks/tat_sweep.js';

const A = '01a1a98a-ac40-7000-8000-00000000a001';
const B = '01a1a98a-ac40-7000-8000-00000000b001';
const SYS = '01a1b34e-1000-7eee-9d29-d7ca59a102b5';
const NOW = '2026-11-14T10:00:30.000Z';
type M = { kind: 'inc' | 'observe' | 'set'; name: string; value?: number; labels?: Record<string, string | number> };

function jobCtx(tenant: string | undefined, o: { metrics?: boolean } = { metrics: true }) {
  const queries: Array<{ text: string; values: unknown[] }> = []; const ms: M[] = [];
  const ctx: any = {
    tenantId: tenant, actor: { type: 'system', id: SYS }, requestId: '01a1a98a-ac40-7000-8000-000000090001', now: () => NOW, attempt: 1, maxAttempts: 3, jobId: '1',
    tx: { async query(text: string, values: unknown[] = []) { queries.push({ text, values }); return { rows: [] }; } },
    log: { info() {}, warn() {}, error() {}, child() { return this; } },
    ...(o.metrics === false ? {} : { metrics: {
      inc: (name: string, labels?: Record<string, string | number>, by?: number) => { ms.push({ kind: 'inc', name, ...(by !== undefined ? { value: by } : {}), ...(labels ? { labels } : {}) }); },
      observe: (name: string, value: number, labels?: Record<string, string | number>) => { ms.push({ kind: 'observe', name, value, ...(labels ? { labels } : {}) }); },
      set: (name: string, value: number, labels?: Record<string, string | number>) => { ms.push({ kind: 'set', name, value, ...(labels ? { labels } : {}) }); },
    } }),
  };
  return { ctx, queries, ms };
}
const RES = { seen: 3, created: 1, raised: [{ level: 'warning', segment: 'within_lab', lagSeconds: 30 }, { level: 'breached', segment: 'total', lagSeconds: 90 }], stopped: 0, cancelled: 0, orphanClosed: 0, openAlerts: { warning: 2, breached: 1, escalated: 0 } };
const ZERO = { seen: 0, created: 0, raised: [], stopped: 0, cancelled: 0, orphanClosed: 0, openAlerts: { warning: 0, breached: 0, escalated: 0 } };
const svc = (res: Record<string, unknown> = RES) => ({ sweep: vi.fn(async (_ctx: unknown) => res as any) });
const failure = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e) { return e; } throw new Error('expected rejection, but it resolved'); };
const run = (service: unknown, payload: unknown, ctx: unknown) => Promise.resolve(createTatSweepHandler({ service } as never)(payload as never, ctx as never));

describe('quality.tat_sweep task', () => {
  it('runs the tat service sweep ONCE on the job ctx (same tx, system actor) and issues no SQL itself', async () => {
    const service = svc(); const { ctx, queries } = jobCtx(A); await run(service, { tenant_id: A }, ctx);
    expect(service.sweep).toHaveBeenCalledTimes(1); expect(service.sweep.mock.calls[0]![0]).toBe(ctx); expect(queries).toEqual([]);
  });
  it('REQ-SEC-024: a payload of another tenant, a missing / non-string tenant, or a job without tenant is refused before any service call, query or metric', async () => {
    for (const [payload, tenant] of [[{ tenant_id: B }, A], [{}, A], [{ tenant_id: 42 }, A], [null, A], [{ tenant_id: A }, undefined]] as const) {
      const service = svc(); const { ctx, queries, ms } = jobCtx(tenant);
      expect(await failure(run(service, payload, ctx)), JSON.stringify(payload)).toBeInstanceOf(Error); expect(service.sweep).not.toHaveBeenCalled(); expect(queries).toEqual([]); expect(ms).toEqual([]);
    }
  });
  it('§14: the sweep duration histogram is observed once with no labels (finite, >= 0)', async () => {
    const { ctx, ms } = jobCtx(A); await run(svc(), { tenant_id: A }, ctx);
    const d = ms.filter((m) => m.name === 'lims_quality_tat_sweep_duration_seconds'); expect(d).toHaveLength(1); expect(d[0]!.kind).toBe('observe'); expect(d[0]!.labels).toBeUndefined(); expect(Number.isFinite(d[0]!.value!) && d[0]!.value! >= 0).toBe(true);
  });
  it('§14: lims_quality_tat_alerts_total{level, segment} is incremented once per raised alert; the lag histogram gets each lagSeconds (no labels)', async () => {
    const { ctx, ms } = jobCtx(A); await run(svc(), { tenant_id: A }, ctx);
    const incs = ms.filter((m) => m.name === 'lims_quality_tat_alerts_total'); expect(incs.map((m) => m.kind)).toEqual(['inc', 'inc']);
    expect(incs.map((m) => m.labels)).toEqual([{ level: 'warning', segment: 'within_lab' }, { level: 'breached', segment: 'total' }]); for (const m of incs) expect(m.value === undefined || m.value === 1).toBe(true);
    const lag = ms.filter((m) => m.name === 'lims_quality_tat_alert_lag_seconds'); expect(lag.map((m) => m.value)).toEqual([30, 90]); for (const m of lag) { expect(m.kind).toBe('observe'); expect(m.labels).toBeUndefined(); }
  });
  it('§14: lims_quality_tat_open_alerts{level, tenant_id} is set for each of the three levels from the sweep result, zeros included (the alert must clear)', async () => {
    const { ctx, ms } = jobCtx(A); await run(svc(), { tenant_id: A }, ctx);
    const g = ms.filter((m) => m.name === 'lims_quality_tat_open_alerts'); expect(g.every((m) => m.kind === 'set')).toBe(true);
    expect(g.map((m) => [m.labels, m.value])).toEqual(expect.arrayContaining([[{ level: 'warning', tenant_id: A }, 2], [{ level: 'breached', tenant_id: A }, 1], [{ level: 'escalated', tenant_id: A }, 0]])); expect(g).toHaveLength(3);
    const z = jobCtx(A); await run(svc(ZERO), { tenant_id: A }, z.ctx); expect(z.ms.filter((m) => m.name === 'lims_quality_tat_open_alerts').map((m) => m.value)).toEqual([0, 0, 0]);
    expect(z.ms.filter((m) => m.name === 'lims_quality_tat_alerts_total' || m.name === 'lims_quality_tat_alert_lag_seconds')).toEqual([]);
  });
  it('only the four §14 TAT metric names are written; labels never carry an order, item, test or specimen id; every value is a finite number', async () => {
    const { ctx, ms } = jobCtx(A); await run(svc(), { tenant_id: A }, ctx);
    const names = ['lims_quality_tat_sweep_duration_seconds', 'lims_quality_tat_alerts_total', 'lims_quality_tat_open_alerts', 'lims_quality_tat_alert_lag_seconds'];
    for (const m of ms) { expect(names).toContain(m.name); expect(m.value === undefined || Number.isFinite(m.value)).toBe(true); for (const k of Object.keys(m.labels ?? {})) expect(['level', 'segment', 'tenant_id']).toContain(k); }
  });
  it('a job context without ctx.metrics still completes', async () => {
    const { ctx } = jobCtx(A, { metrics: false }); await expect(run(svc(), { tenant_id: A }, ctx)).resolves.toBeUndefined();
  });
  it('a service failure rejects (the next minute retries anyway; max attempts 3) and writes NO metric', async () => {
    const { ctx, ms } = jobCtx(A); const service = { sweep: vi.fn(async () => { throw new Error('db down'); }) };
    expect(await failure(run(service, { tenant_id: A }, ctx))).toBeInstanceOf(Error); expect(ms).toEqual([]);
  });
});
