// C9 T-10 — worker task quality.close_stale_runs (02-TRD §7.3 step 7, §10.3, §14 gauge; PRD AC-06.7). No database: the run service is faked here (its behaviour is run.service.test.ts in the API package).
// SEAMS (writer matches or disputes):
//   ../tasks/close_stale_runs.ts   exports `createCloseStaleRunsHandler(deps?: { service?: { closeStaleRuns(ctx): Promise<{ closed: number; rejected: number; oldestRejectedWithoutActionAgeSeconds: number }> } }): TaskHandler`
//                                  and `handle` (= createCloseStaleRunsHandler() on the real run service). The handler: (1) tenant guard — payload.tenant_id must equal ctx.tenantId, else it throws BEFORE any
//                                  query or service call (REQ-SEC-024, same as sync_qc_observations); (2) `await service.closeStaleRuns(ctx)` ONCE on the JOB ctx (same tx, system actor);
//                                  (3) AFTER the service resolved, sets the gauge through the optional `ctx.metrics.set(name, value, labels)` (precedent: payments sweep_open_intents):
//                                  name `lims_quality_qc_rejected_without_action_oldest_age_seconds`, value = the service's oldestRejectedWithoutActionAgeSeconds (0 when none, so the alert clears),
//                                  labels exactly { tenant_id }. A missing ctx.metrics is fine. Service errors propagate (retry, dead letter) and then NO gauge is set.
// Fails now: "Cannot find module ../tasks/close_stale_runs.js".
import { describe, expect, it, vi } from 'vitest';
import { createCloseStaleRunsHandler } from '../tasks/close_stale_runs.js';

const A = '01a1a98a-ac40-7000-8000-00000000a001';
const B = '01a1a98a-ac40-7000-8000-00000000b001';
const SYS = '01a1b34e-1000-7eee-9d29-d7ca59a102b5';
const NOW = '2026-11-13T18:00:30.000Z';
const GAUGE = 'lims_quality_qc_rejected_without_action_oldest_age_seconds';

function jobCtx(tenant: string | undefined, o: { metrics?: boolean } = { metrics: true }) {
  const queries: Array<{ text: string; values: unknown[] }> = [];
  const sets: Array<{ name: string; value: number; labels?: Record<string, string> }> = [];
  const ctx: any = {
    tenantId: tenant, actor: { type: 'system', id: SYS }, requestId: '01a1a98a-ac40-7000-8000-000000090001', now: () => NOW, attempt: 1, maxAttempts: 5, jobId: '1',
    tx: { async query(text: string, values: unknown[] = []) { queries.push({ text, values }); return { rows: [] }; } },
    log: { info() {}, warn() {}, error() {}, child() { return this; } },
    ...(o.metrics === false ? {} : { metrics: { set: (name: string, value: number, labels?: Record<string, string>) => { sets.push({ name, value, ...(labels ? { labels } : {}) }); }, inc() {}, observe() {} } }),
  };
  return { ctx, queries, sets };
}
const svc = (res: Record<string, unknown> = { closed: 0, rejected: 0, oldestRejectedWithoutActionAgeSeconds: 0 }) => ({ closeStaleRuns: vi.fn(async (_ctx: unknown) => res as any) });
const failure = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e) { return e; } throw new Error('expected rejection, but it resolved'); };

describe('quality.close_stale_runs task', () => {
  it('runs the run service once on the job ctx for the job tenant', async () => {
    const service = svc();
    const { ctx } = jobCtx(A);
    await createCloseStaleRunsHandler({ service } as never)({ tenant_id: A }, ctx);
    expect(service.closeStaleRuns).toHaveBeenCalledTimes(1);
    expect(service.closeStaleRuns.mock.calls[0]![0]).toBe(ctx);
  });
  it('REQ-SEC-024: a payload of another tenant (or a missing / non-string tenant) is refused before any query or service call', async () => {
    for (const [payload, tenant] of [[{ tenant_id: B }, A], [{}, A], [{ tenant_id: 42 }, A], [{ tenant_id: A }, undefined]] as const) {
      const service = svc();
      const { ctx, queries, sets } = jobCtx(tenant);
      expect(await failure(Promise.resolve(createCloseStaleRunsHandler({ service } as never)(payload as never, ctx))), JSON.stringify(payload)).toBeInstanceOf(Error);
      expect(service.closeStaleRuns).not.toHaveBeenCalled();
      expect(queries).toEqual([]);
      expect(sets).toEqual([]);
    }
  });
  it('§14: sets lims_quality_qc_rejected_without_action_oldest_age_seconds once, value = the service age, labels exactly { tenant_id }', async () => {
    const { ctx, sets } = jobCtx(A);
    await createCloseStaleRunsHandler({ service: svc({ closed: 2, rejected: 1, oldestRejectedWithoutActionAgeSeconds: 14_400 }) } as never)({ tenant_id: A }, ctx);
    expect(sets.filter((s) => s.name === GAUGE)).toEqual([{ name: GAUGE, value: 14_400, labels: { tenant_id: A } }]);
  });
  it('the gauge is set to 0 when no rejected run waits for an action (the alert must clear) and on a tick that closed nothing', async () => {
    const { ctx, sets } = jobCtx(A);
    await createCloseStaleRunsHandler({ service: svc({ closed: 0, rejected: 0, oldestRejectedWithoutActionAgeSeconds: 0 }) } as never)({ tenant_id: A }, ctx);
    expect(sets.filter((s) => s.name === GAUGE)).toEqual([{ name: GAUGE, value: 0, labels: { tenant_id: A } }]);
  });
  it('no other metric name and no other label (tenant_id only) is written; the value is a finite number >= 0', async () => {
    const { ctx, sets } = jobCtx(A);
    await createCloseStaleRunsHandler({ service: svc({ closed: 1, rejected: 1, oldestRejectedWithoutActionAgeSeconds: 61 }) } as never)({ tenant_id: A }, ctx);
    for (const s of sets) { expect(s.name).toBe(GAUGE); expect(Object.keys(s.labels ?? {})).toEqual(['tenant_id']); expect(Number.isFinite(s.value) && s.value >= 0).toBe(true); }
  });
  it('a job context without ctx.metrics still completes', async () => {
    const { ctx } = jobCtx(A, { metrics: false });
    await expect(Promise.resolve(createCloseStaleRunsHandler({ service: svc() } as never)({ tenant_id: A }, ctx))).resolves.toBeUndefined();
  });
  it('a service failure rejects (retry, then dead letter) and sets NO gauge (no stale or zero value for a failed tick)', async () => {
    const { ctx, sets } = jobCtx(A);
    const service = { closeStaleRuns: vi.fn(async () => { throw new Error('db down'); }) };
    expect(await failure(Promise.resolve(createCloseStaleRunsHandler({ service } as never)({ tenant_id: A }, ctx)))).toBeInstanceOf(Error);
    expect(sets).toEqual([]);
  });
  it('the task itself issues no SQL (all work is in the service on the job tx) and never enqueues a job', async () => {
    const { ctx, queries } = jobCtx(A);
    await createCloseStaleRunsHandler({ service: svc({ closed: 1, rejected: 1, oldestRejectedWithoutActionAgeSeconds: 5 }) } as never)({ tenant_id: A }, ctx);
    expect(queries).toEqual([]);
  });
});
