// C9 T-19 — worker task quality.purge_tat_items (02-TRD §10.3; 08 A17 P-18(c); 05-SCHEMA §7; REQ-SEC-024). No database: the tat service is faked (the row predicate is pinned in api tat.repo.sql.test.ts).
// SEAM: ../tasks/purge_tat_items.ts exports `createPurgeTatItemsHandler(deps?: { service?: { purgeExpired(ctx): Promise<{ deleted: number }> } }): TaskHandler` and `handle`.
//   The handler: tenant guard (payload.tenant_id === ctx.tenantId) BEFORE any service call; `await service.purgeExpired(ctx)` ONCE on the job ctx (system actor, the delete runs under tat_items__delete__tenant);
//   no SQL of its own; it deletes nothing else and writes no metric. Errors propagate (3 attempts, then dead letter; the next daily run retries anyway).
// Fails now: "Cannot find module ../tasks/purge_tat_items.js".
import { describe, expect, it, vi } from 'vitest';
import { createPurgeTatItemsHandler } from '../tasks/purge_tat_items.js';

const A = '01a1a98a-ac40-7000-8000-00000000a001';
const B = '01a1a98a-ac40-7000-8000-00000000b001';
function jobCtx(tenant: string | undefined) {
  const queries: unknown[] = [];
  const ctx: any = { tenantId: tenant, actor: { type: 'system', id: '01a1b34e-1000-7eee-9d29-d7ca59a102b5' }, requestId: '01a1a98a-ac40-7000-8000-000000090001', now: () => '2026-11-15T02:40:00.000Z', attempt: 1, maxAttempts: 3, jobId: '1',
    tx: { async query(t: string, v: unknown[] = []) { queries.push({ t, v }); return { rows: [] }; } }, log: { info() {}, warn() {}, error() {}, child() { return this; } } };
  return { ctx, queries };
}
const svc = (deleted = 4) => ({ purgeExpired: vi.fn(async (_c: unknown) => ({ deleted })) });
const failure = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e) { return e; } throw new Error('expected rejection, but it resolved'); };
const run = (service: unknown, payload: unknown, ctx: unknown) => Promise.resolve(createPurgeTatItemsHandler({ service } as never)(payload as never, ctx as never));

describe('quality.purge_tat_items task (P-18(c))', () => {
  it('calls the tat service purgeExpired ONCE on the job ctx and issues no SQL itself', async () => {
    const service = svc(); const { ctx, queries } = jobCtx(A); await run(service, { tenant_id: A }, ctx);
    expect(service.purgeExpired).toHaveBeenCalledTimes(1); expect(service.purgeExpired.mock.calls[0]![0]).toBe(ctx); expect(queries).toEqual([]);
  });
  it('REQ-SEC-024: another tenant, a missing / non-string tenant, or a job without tenant is refused before any service call or query (no cross-tenant delete)', async () => {
    for (const [payload, tenant] of [[{ tenant_id: B }, A], [{}, A], [{ tenant_id: 1 }, A], [null, A], [{ tenant_id: A }, undefined]] as const) {
      const service = svc(); const { ctx, queries } = jobCtx(tenant); expect(await failure(run(service, payload, ctx)), JSON.stringify(payload)).toBeInstanceOf(Error); expect(service.purgeExpired).not.toHaveBeenCalled(); expect(queries).toEqual([]);
    }
  });
  it('a run that deletes nothing resolves; a payload carrying a cut-off / table / limit field cannot widen the purge (the service gets ctx only)', async () => {
    const service = svc(0); const { ctx } = jobCtx(A); await expect(run(service, { tenant_id: A, expires_before: '2099-01-01T00:00:00.000Z', table: 'quality.tat_alert_events', limit: 1e9 }, ctx)).resolves.toBeUndefined();
    expect(service.purgeExpired.mock.calls[0]).toHaveLength(1);
  });
  it('a service failure rejects (retry, then dead letter)', async () => {
    const { ctx } = jobCtx(A); const service = { purgeExpired: vi.fn(async () => { throw new Error('db down'); }) }; expect(await failure(run(service, { tenant_id: A }, ctx))).toBeInstanceOf(Error);
  });
});
