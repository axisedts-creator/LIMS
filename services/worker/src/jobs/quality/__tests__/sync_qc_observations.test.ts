// C9 T-09 — worker task quality.sync_qc_observations (02-TRD §6.2 steps 1-6 + §10.3; AC-05.1, AC-05.5) and consumer instruments.qc.received.v1 (§10.2; AC-05.2). No database.
// SEAMS (writer matches or disputes):
//   ../tasks/sync_qc_observations.ts   exports `createSyncQcObservationsHandler(deps?: { service?: { syncQcObservations(ctx): Promise<{ budgetExhausted: boolean; [k: string]: unknown }> } }): TaskHandler`
//                                      and `handle` (= createSyncQcObservationsHandler() on the real observation service). The handler: (1) tenant guard — payload.tenant_id must equal ctx.tenantId, else it throws BEFORE any
//                                      query or service call (REQ-SEC-024); (2) `await service.syncQcObservations(ctx)` on the JOB ctx (same tx, system actor); (3) when the result says budgetExhausted it enqueues
//                                      the continuation: `SELECT app.enqueue_job($1, $2::jsonb, $3, $4, $5)` with values [ 'quality.sync_qc_observations', JSON {tenant_id}, 'qcsync:cont:<tenant_id>', run_at (null or now), 5 ].
//                                      The continuation never uses the running job's own key `qcsync:<tenant_id>` (unsafe_dedupe would drop it). Service errors propagate (retry, dead letter).
//   ../consumers/instruments.qc.received.v1.ts  exports `handle: ConsumerHandler`: tenant guard (event.tenant_id === ctx.tenantId), then ONE statement
//                                      `SELECT app.enqueue_job($1, $2::jsonb, $3, $4, $5)` values [ 'quality.sync_qc_observations', JSON {tenant_id}, 'qcsync:<tenant_id>', ISO run_at = ctx.now() + 5 s, 5 ].
//   ../cron.ts                         exports `crontab` (checked in manifest.test.ts).
// Fails now: "Cannot find module ../tasks/sync_qc_observations.js" / "../consumers/instruments.qc.received.v1.js".
import { describe, expect, it, vi } from 'vitest';
import { createSyncQcObservationsHandler } from '../tasks/sync_qc_observations.js';
import { handle as qcReceived } from '../consumers/instruments.qc.received.v1.js';

const A = '01a1a98a-ac40-7000-8000-00000000a001';
const B = '01a1a98a-ac40-7000-8000-00000000b001';
const SYS = '01a1b34e-1000-7eee-9d29-d7ca59a102b5';
const NOW = '2026-11-13T18:00:30.000Z';
const u = (n: number) => `0190c60b-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const TASK = 'quality.sync_qc_observations';

function jobCtx(tenant: string | undefined, over: { enqueueFails?: boolean } = {}) {
  const queries: Array<{ text: string; values: unknown[] }> = [];
  const logs: unknown[] = [];
  const ctx: any = {
    tenantId: tenant, actor: { type: 'system', id: SYS }, requestId: u(8), now: () => NOW, attempt: 1, maxAttempts: 5, jobId: '1',
    tx: { async query(text: string, values: unknown[] = []) { queries.push({ text, values }); if (over.enqueueFails && /app\.enqueue_job/i.test(text)) throw new Error('queue down'); return { rows: [] }; } },
    log: { info: (...a: unknown[]) => logs.push(a), warn: (...a: unknown[]) => logs.push(a), error: (...a: unknown[]) => logs.push(a), child() { return this; } },
  };
  return { ctx, queries, logs, enqueues: () => queries.filter((q) => /app\.enqueue_job/i.test(q.text)) };
}
const failure = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e) { return e; } throw new Error('expected rejection, but it resolved'); };

describe('quality.sync_qc_observations task', () => {
  const svc = (res: Record<string, unknown> = { budgetExhausted: false }) => ({ syncQcObservations: vi.fn(async () => res) });

  it('runs the observation service once on the job ctx for the job tenant', async () => {
    const service = svc();
    const { ctx } = jobCtx(A);
    await createSyncQcObservationsHandler({ service } as never)({ tenant_id: A }, ctx);
    expect(service.syncQcObservations).toHaveBeenCalledTimes(1);
    expect(service.syncQcObservations.mock.calls[0]![0]).toBe(ctx);
  });
  it('REQ-SEC-024: a payload of another tenant (or a missing tenant) is refused before any query or service call', async () => {
    for (const [payload, tenant] of [[{ tenant_id: B }, A], [{}, A], [{ tenant_id: 42 }, A], [{ tenant_id: A }, undefined]] as const) {
      const service = svc();
      const { ctx, queries } = jobCtx(tenant);
      expect(await failure(Promise.resolve(createSyncQcObservationsHandler({ service } as never)(payload as never, ctx))), JSON.stringify(payload)).toBeInstanceOf(Error);
      expect(service.syncQcObservations).not.toHaveBeenCalled();
      expect(queries).toEqual([]);
    }
  });
  it('time budget used up: enqueues the continuation under its own key qcsync:cont:<tenant> (never the running qcsync:<tenant>), payload = tenant id only, max attempts 5', async () => {
    const { ctx, enqueues } = jobCtx(A);
    await createSyncQcObservationsHandler({ service: svc({ budgetExhausted: true, imported: 500 }) } as never)({ tenant_id: A }, ctx);
    const e = enqueues();
    expect(e).toHaveLength(1);
    const v = e[0]!.values;
    expect(v[0]).toBe(TASK);
    expect(JSON.parse(String(v[1]))).toEqual({ tenant_id: A });
    expect(v[2]).toBe(`qcsync:cont:${A}`);
    expect(v[2]).not.toBe(`qcsync:${A}`);
    expect(v[3] === null || v[3] === undefined || Date.parse(String(v[3])) <= Date.parse(NOW)).toBe(true);
    expect(v[4]).toBe(5);
  });
  it('budget not used up: no continuation is enqueued', async () => {
    const { ctx, enqueues } = jobCtx(A);
    await createSyncQcObservationsHandler({ service: svc({ budgetExhausted: false }) } as never)({ tenant_id: A }, ctx);
    expect(enqueues()).toEqual([]);
  });
  it('a service failure rejects (retry, then dead letter) and enqueues nothing', async () => {
    const { ctx, enqueues } = jobCtx(A);
    const service = { syncQcObservations: vi.fn(async () => { throw new Error('view unavailable'); }) };
    expect(await failure(Promise.resolve(createSyncQcObservationsHandler({ service } as never)({ tenant_id: A }, ctx)))).toBeInstanceOf(Error);
    expect(enqueues()).toEqual([]);
  });
  it('a failing continuation enqueue rejects (the import is not reported done while the follow-up job is lost)', async () => {
    const { ctx } = jobCtx(A, { enqueueFails: true });
    expect(await failure(Promise.resolve(createSyncQcObservationsHandler({ service: svc({ budgetExhausted: true }) } as never)({ tenant_id: A }, ctx)))).toBeInstanceOf(Error);
  });
  it('a hostile payload (extra keys, SQL text) is ignored: only the tenant guard reads it', async () => {
    const service = svc();
    const { ctx, queries } = jobCtx(A);
    await createSyncQcObservationsHandler({ service } as never)({ tenant_id: A, since: "x'; DROP TABLE lab.qc_results;--", qc_result_id: u(1) } as never, ctx);
    expect(service.syncQcObservations).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(queries)).not.toContain('DROP TABLE');
  });
});

// ================================================================================================ consumer
const PHI = 'SENTINEL-PHI-Sita-Karki';
const envelope = (tenant: string, payload: Record<string, unknown> = {}) => ({
  event_id: u(9), event_type: 'instruments.qc.received.v1', tenant_id: tenant, producer: 'instruments', occurred_at: '2026-11-13T18:00:00.000Z', request_id: u(8), idempotency_key: 'instruments.qc.received.v1:k1',
  aggregate: { type: 'instrument_message', id: u(1), seq: 1 },
  payload: { instrument_message_id: u(1), instrument_id: u(2), centre_id: u(3), control_id_raw: 'CTRL-1', instrument_analyte_code: 'GLU', mapping_status: 'mapped', analyte_id: u(4), value_raw: '5.4', value_numeric: '5.4',
    received_at: '2026-11-13T18:00:00.000Z', ...payload },
});

describe('instruments.qc.received.v1 consumer (AC-05.2: a trigger, debounced by job key)', () => {
  it('enqueues quality.sync_qc_observations for the tenant: key qcsync:<tenant>, run_at = now + 5 s, max attempts 5, payload = tenant id only', async () => {
    const { ctx, enqueues } = jobCtx(A);
    await qcReceived(envelope(A), ctx);
    const e = enqueues();
    expect(e).toHaveLength(1);
    const v = e[0]!.values;
    expect(v[0]).toBe(TASK);
    expect(JSON.parse(String(v[1]))).toEqual({ tenant_id: A });
    expect(v[2]).toBe(`qcsync:${A}`);
    expect(Date.parse(String(v[3]))).toBe(Date.parse(NOW) + 5_000);
    expect(v[4]).toBe(5);
  });
  it('duplicate delivery: the same event twice enqueues the same job key twice (the queue\'s unsafe_dedupe absorbs it) and writes nothing else — no row, no counter, no second source of data', async () => {
    const { ctx, queries, enqueues } = jobCtx(A);
    await qcReceived(envelope(A), ctx);
    await qcReceived(envelope(A), ctx);
    const e = enqueues();
    expect(e).toHaveLength(2);
    expect(e[1]!.values).toEqual(e[0]!.values);
    expect(queries).toHaveLength(2);   // only app.enqueue_job statements
  });
  it('the payload is a trigger only: nothing of it (instrument message id, control id, value, analyte, sample data) reaches a statement or a log line', async () => {
    const { ctx, queries, logs } = jobCtx(A);
    await qcReceived(envelope(A, { control_id_raw: PHI, value_raw: '987.654', value_numeric: '987.654' }), ctx);
    const text = JSON.stringify([queries, logs]);
    for (const leak of [PHI, '987.654', u(1), u(2), u(4), 'GLU']) expect(text, leak).not.toContain(leak);
  });
  it('unknown extra payload fields are ignored (forward compatible)', async () => {
    const { ctx, enqueues } = jobCtx(A);
    await qcReceived(envelope(A, { brand_new_field: { x: 1 } }), ctx);
    expect(enqueues()).toHaveLength(1);
  });
  it('an unmapped analyte still triggers the sync (the observation is imported and classified as unmapped_analyte there)', async () => {
    const { ctx, enqueues } = jobCtx(A);
    await qcReceived(envelope(A, { mapping_status: 'unmapped', analyte_id: null }), ctx);
    expect(enqueues()).toHaveLength(1);
  });
  it('REQ-SEC-024: an event of another tenant (or a job without tenant) is refused before any query', async () => {
    for (const [event, tenant] of [[envelope(B), A], [envelope(A), undefined], [{ ...envelope(A), tenant_id: undefined }, A]] as const) {
      const { ctx, queries } = jobCtx(tenant);
      expect(await failure(Promise.resolve(qcReceived(event as never, ctx)))).toBeInstanceOf(Error);
      expect(queries).toEqual([]);
    }
  });
  it('a failing enqueue rejects (retry, then dead letter), never a silent ack', async () => {
    const { ctx } = jobCtx(A, { enqueueFails: true });
    expect(await failure(Promise.resolve(qcReceived(envelope(A), ctx)))).toBeInstanceOf(Error);
  });
});
