// C9 T-19 — worker task quality.tat_refresh_order (02-TRD §9.3 steps 1-4 for one order, §10.2, §10.3; REQ-SEC-024). No database: the tat service is faked.
// SEAM: ../tasks/tat_refresh_order.ts exports `createTatRefreshOrderHandler(deps?: { service?: { refreshOrder(ctx, { orderId }): Promise<unknown> } }): TaskHandler` and `handle`.
//   Payload { tenant_id, order_id } (the consumer enqueues exactly this). The handler: tenant guard (payload.tenant_id === ctx.tenantId) and order_id must be a uuid, both BEFORE any service call or query;
//   then `await service.refreshOrder(ctx, { orderId })` ONCE on the job ctx; no SQL of its own; no metrics. Errors propagate (5 attempts, then dead letter).
// Fails now: "Cannot find module ../tasks/tat_refresh_order.js".
import { describe, expect, it, vi } from 'vitest';
import { createTatRefreshOrderHandler } from '../tasks/tat_refresh_order.js';

const A = '01a1a98a-ac40-7000-8000-00000000a001';
const B = '01a1a98a-ac40-7000-8000-00000000b001';
const ORDER = '01a1a98a-ac40-7000-8000-0000000000d1';
function jobCtx(tenant: string | undefined) {
  const queries: unknown[] = [];
  const ctx: any = { tenantId: tenant, actor: { type: 'system', id: '01a1b34e-1000-7eee-9d29-d7ca59a102b5' }, requestId: '01a1a98a-ac40-7000-8000-000000090001', now: () => '2026-11-14T10:00:30.000Z', attempt: 1, maxAttempts: 5, jobId: '1',
    tx: { async query(t: string, v: unknown[] = []) { queries.push({ t, v }); return { rows: [] }; } }, log: { info() {}, warn() {}, error() {}, child() { return this; } } };
  return { ctx, queries };
}
const svc = () => ({ refreshOrder: vi.fn(async (_c: unknown, _i: unknown) => ({})) });
const failure = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e) { return e; } throw new Error('expected rejection, but it resolved'); };
const run = (service: unknown, payload: unknown, ctx: unknown) => Promise.resolve(createTatRefreshOrderHandler({ service } as never)(payload as never, ctx as never));

describe('quality.tat_refresh_order task', () => {
  it('refreshes exactly the payload order once, on the job ctx, and issues no SQL itself', async () => {
    const service = svc(); const { ctx, queries } = jobCtx(A); await run(service, { tenant_id: A, order_id: ORDER }, ctx);
    expect(service.refreshOrder).toHaveBeenCalledTimes(1); expect(service.refreshOrder.mock.calls[0]![0]).toBe(ctx); expect(service.refreshOrder.mock.calls[0]![1]).toEqual({ orderId: ORDER }); expect(queries).toEqual([]);
  });
  it('REQ-SEC-024: another tenant, a missing / non-string tenant, or a job without tenant is refused before any service call or query', async () => {
    for (const [payload, tenant] of [[{ tenant_id: B, order_id: ORDER }, A], [{ order_id: ORDER }, A], [{ tenant_id: 7, order_id: ORDER }, A], [null, A], [{ tenant_id: A, order_id: ORDER }, undefined]] as const) {
      const service = svc(); const { ctx, queries } = jobCtx(tenant); expect(await failure(run(service, payload, ctx)), JSON.stringify(payload)).toBeInstanceOf(Error); expect(service.refreshOrder).not.toHaveBeenCalled(); expect(queries).toEqual([]);
    }
  });
  it.each([[undefined], [null], [''], [7], ["x'; DROP TABLE quality.tat_items;--"], ['not-a-uuid'], [[ORDER]]])('a malformed order_id (%j) is refused before any service call; the message never echoes it', async (order_id) => {
    const service = svc(); const { ctx, queries } = jobCtx(A); const e = await failure(run(service, { tenant_id: A, order_id }, ctx));
    expect(e).toBeInstanceOf(Error); expect(service.refreshOrder).not.toHaveBeenCalled(); expect(queries).toEqual([]); expect(String(e.message)).not.toMatch(/DROP TABLE|not-a-uuid/);
  });
  it('unknown payload fields are ignored (they never reach the service)', async () => {
    const service = svc(); const { ctx } = jobCtx(A); await run(service, { tenant_id: A, order_id: ORDER, patient_name: 'SENTINEL-PHI-Sita-Karki', brand_new: 1 }, ctx);
    expect(JSON.stringify(service.refreshOrder.mock.calls[0]![1])).toBe(JSON.stringify({ orderId: ORDER }));
  });
  it('a service failure rejects (retry, then dead letter)', async () => {
    const { ctx } = jobCtx(A); const service = { refreshOrder: vi.fn(async () => { throw new Error('db down'); }) }; expect(await failure(run(service, { tenant_id: A, order_id: ORDER }, ctx))).toBeInstanceOf(Error);
  });
});
