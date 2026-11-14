// C9 T-11 — worker task quality.reprocess_pending_observations (02-TRD §6.4 + §10.3; 06 row T-11). No database.
// SEAMS (writer matches or disputes):
//   ../tasks/reprocess_pending_observations.ts  exports `createReprocessPendingObservationsHandler(deps?: { service?: { reprocessPending(ctx, scope: { instrument_id?: string; plan_id?: string }): Promise<unknown> } }): TaskHandler`
//                                      and `handle` (= the factory on the real observation service with the real run assembler, like tasks/sync_qc_observations.ts). The handler:
//                                      (1) tenant guard — payload.tenant_id must equal ctx.tenantId, else it throws BEFORE any query or service call (REQ-SEC-024);
//                                      (2) validates the scope: exactly one of instrument_id / plan_id, a UUID string; anything else throws before any query or service call (a malformed payload dead-letters after the retries);
//                                      (3) `await service.reprocessPending(ctx, scope)` on the JOB ctx (same tx), scope holding ONLY the validated id (unknown payload fields are never forwarded);
//                                      (4) enqueues nothing itself; service errors propagate (retry, then dead letter).
// Fails now: "Cannot find module ../tasks/reprocess_pending_observations.js".
import { describe, expect, it, vi } from 'vitest';
import { createReprocessPendingObservationsHandler, handle } from '../tasks/reprocess_pending_observations.js';

const A = '01a1a98a-ac40-7000-8000-00000000a001';
const B = '01a1a98a-ac40-7000-8000-00000000b001';
const SYS = '01a1b34e-1000-7eee-9d29-d7ca59a102b5';
const INS = '01a1a98a-ac40-7000-8000-0000000c9a02';
const PLN = '01a1a98a-ac40-7000-8000-0000000c9a03';

function jobCtx(tenant: string | undefined) {
  const queries: Array<{ text: string; values: unknown[] }> = [];
  const ctx: any = {
    tenantId: tenant, actor: { type: 'system', id: SYS }, requestId: A, now: () => '2026-11-13T19:00:00.000Z', attempt: 1, maxAttempts: 5, jobId: '1',
    tx: { async query(text: string, values: unknown[] = []) { queries.push({ text, values }); return { rows: [] }; } },
    log: { info() {}, warn() {}, error() {}, child() { return this; } },
  };
  return { ctx, queries };
}
const svc = () => ({ reprocessPending: vi.fn(async () => ({ reclassified: 0, adopted: 0, unchanged: 0, counts: {} })) });
const failure = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e) { return e; } throw new Error('expected rejection, but it resolved'); };

describe('quality.reprocess_pending_observations task', () => {
  it('instrument scope: runs the observation service once on the job ctx with { instrument_id }', async () => {
    const service = svc();
    const { ctx } = jobCtx(A);
    await createReprocessPendingObservationsHandler({ service } as never)({ tenant_id: A, instrument_id: INS }, ctx);
    expect(service.reprocessPending).toHaveBeenCalledTimes(1);
    expect(service.reprocessPending.mock.calls[0]![0]).toBe(ctx);
    expect(service.reprocessPending.mock.calls[0]![1]).toEqual({ instrument_id: INS });
  });
  it('plan scope (plan or target activation): { plan_id }; unknown payload fields are never forwarded', async () => {
    const service = svc();
    const { ctx } = jobCtx(A);
    await createReprocessPendingObservationsHandler({ service } as never)({ tenant_id: A, plan_id: PLN, tenant_override: B, evil: "x'; DROP TABLE quality.qc_observations;--" } as never, ctx);
    expect(service.reprocessPending.mock.calls[0]![1]).toEqual({ plan_id: PLN });
    expect(Object.keys(service.reprocessPending.mock.calls[0]![1] as object)).toEqual(['plan_id']);
  });
  it('REQ-SEC-024: a payload of another tenant (or a missing / non-string tenant) is refused before any query or service call', async () => {
    for (const [payload, tenant] of [[{ tenant_id: B, plan_id: PLN }, A], [{ plan_id: PLN }, A], [{ tenant_id: 42, plan_id: PLN }, A], [{ tenant_id: A, plan_id: PLN }, undefined]] as const) {
      const service = svc();
      const { ctx, queries } = jobCtx(tenant);
      expect(await failure(Promise.resolve(createReprocessPendingObservationsHandler({ service } as never)(payload as never, ctx))), JSON.stringify(payload)).toBeInstanceOf(Error);
      expect(service.reprocessPending).not.toHaveBeenCalled();
      expect(queries).toEqual([]);
    }
  });
  it('a malformed scope is refused before any query or service call: neither id, both ids, a non-UUID, a non-string', async () => {
    const bad: any[] = [{ tenant_id: A }, { tenant_id: A, instrument_id: INS, plan_id: PLN }, { tenant_id: A, plan_id: "x'; DROP TABLE quality.settings;--" }, { tenant_id: A, instrument_id: 7 }, { tenant_id: A, plan_id: null }, { tenant_id: A, plan_id: '' }];
    for (const payload of bad) {
      const service = svc();
      const { ctx, queries } = jobCtx(A);
      expect(await failure(Promise.resolve(createReprocessPendingObservationsHandler({ service } as never)(payload, ctx))), JSON.stringify(payload)).toBeInstanceOf(Error);
      expect(service.reprocessPending).not.toHaveBeenCalled();
      expect(queries).toEqual([]);
    }
  });
  it('service errors propagate (retry, then dead letter); the task enqueues no follow-up job of its own', async () => {
    const { ctx, queries } = jobCtx(A);
    const service = { reprocessPending: vi.fn(async () => { throw new Error('boom'); }) };
    expect((await failure(Promise.resolve(createReprocessPendingObservationsHandler({ service } as never)({ tenant_id: A, plan_id: PLN }, ctx)))).message).toBe('boom');
    const ok = jobCtx(A);
    await createReprocessPendingObservationsHandler({ service: svc() } as never)({ tenant_id: A, instrument_id: INS }, ok.ctx);
    expect([...queries, ...ok.queries].filter((q) => /enqueue_job/i.test(q.text))).toEqual([]);
  });
  it('the exported `handle` is the real task, not the T-01 no-op: an empty payload rejects before touching ctx.tx', async () => {
    const { ctx, queries } = jobCtx(A);
    expect(await failure(Promise.resolve(handle({}, ctx)))).toBeInstanceOf(Error);
    expect(queries).toEqual([]);
  });
});
