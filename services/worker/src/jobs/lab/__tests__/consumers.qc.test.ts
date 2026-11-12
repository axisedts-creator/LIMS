// C5 T-25 — wiring + tenant guard of the two QC consumers, no database (06 row T-25; 02-TRD §7.2 rows `instruments.qc.received.v1` and `quality.qc_run.rejected.v1`;
// PRD AC-19.1, AC-19.4; 07-SECURITY P-11, REQ-SEC-024). Behaviour against the migrated DB: services/api/src/modules/lab/service/__tests__/qc.consumer.integration.test.ts.
// SEAM: consumers/instruments.qc.received.v1.ts and consumers/quality.qc_run.rejected.v1.ts each export `handle: ConsumerHandler` (same convention as the other lab consumers),
//       registered in ../index.ts under their event type; they run on the job ctx (ctx.tx, ctx.tenantId, ctx.now() ISO string, ctx.actor system).
// The wrapper (core/consumer.ts) validates the envelope against contracts/events/<type>.schema.json and dedupes by inbox; that is not re-tested here.
import { describe, expect, it, vi } from 'vitest';
import { isLimsError } from '../../../../../api/src/core/errors.js';
import { handle as qcReceived } from '../consumers/instruments.qc.received.v1.js';
import { handle as qcRejected } from '../consumers/quality.qc_run.rejected.v1.js';
import { manifest } from '../index.js';

const A = '01a1a98a-ac40-7000-8000-00000000a001';
const B = '01a1a98a-ac40-7000-8000-00000000b001';
const SYS = '01a1b34e-1000-7eee-9d29-d7ca59a102b5';
const u = (n: number) => `0190c60b-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;

const RECEIVED = 'instruments.qc.received.v1';
const REJECTED = 'quality.qc_run.rejected.v1';
const base = (type: string, tenant: string, producer: string, agg: string, payload: object) => ({ event_id: u(9), event_type: type, tenant_id: tenant, producer,
  occurred_at: '2026-11-05T04:15:00.000Z', request_id: u(8), idempotency_key: `${type}:k1`, aggregate: { type: agg, id: u(1), seq: 1 }, payload });
const received = (tenant: string) => base(RECEIVED, tenant, 'instruments', 'instrument_message', { instrument_message_id: u(1), instrument_id: u(2), centre_id: u(3), control_id_raw: 'CTRL-1',
  instrument_analyte_code: 'GLU', mapping_status: 'mapped', analyte_id: u(4), value_raw: '5.4', value_numeric: '5.4', received_at: '2026-11-05T04:15:00.000Z' });
const rejected = (tenant: string) => base(REJECTED, tenant, 'quality', 'qc_run', { qc_run_id: u(1), instrument_id: u(2), analyte_ids: [u(4)], rules_violated: ['1-3s'], rule_mode: 'classic',
  controls_per_run: 2, run_at: '2026-11-05T03:00:00.000Z', hold_since: '2026-11-05T02:00:00.000Z', rejected_at: '2026-11-05T04:15:00.000Z' });

function jobCtx(tenant: string | undefined) {
  const touched = { tx: vi.fn(), port: vi.fn(), events: vi.fn() };
  const boom = (f: () => void) => async () => { f(); throw new Error('SENTINEL'); };
  const ctx = {
    tenantId: tenant, actor: { type: 'system', id: SYS }, requestId: u(8), now: () => '2026-11-05T04:15:30.000Z',
    tx: { query: boom(touched.tx) },
    events: { publish: boom(touched.events) },
    ports: { IdentityPort: { getTenantSettings: boom(touched.port) } },
    log: { info() {}, warn() {}, error() {}, child() { return this; } },
  };
  return { ctx, touched };
}
const failure = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e) { return e; } throw new Error('expected rejection, but it resolved'); };

const CASES = [
  { type: RECEIVED, handle: qcReceived, env: received },
  { type: REJECTED, handle: qcRejected, env: rejected },
] as const;

describe.each(CASES)('T-25 $type consumer is registered (not a stub)', ({ type, handle, env }) => {
  it('exports handle; the manifest subscription is a real handler (does not reject with "not implemented") and uses the job tx or a port', async () => {
    expect(typeof handle).toBe('function');
    const sub = manifest.subscriptions?.[type];
    expect(typeof sub).toBe('function');
    const { ctx, touched } = jobCtx(A);
    const err = await failure(Promise.resolve(sub!(env(A) as never, ctx as never)));
    expect(String(err?.message)).not.toMatch(/not implemented/i);
    expect(touched.tx.mock.calls.length + touched.port.mock.calls.length, 'the handler must use the job tx (or a port)').toBeGreaterThan(0);
  });

  it('a failing DB call rejects the handler, never a silent ack (the job retries and dead-letters)', async () => {
    const { ctx } = jobCtx(A);
    expect(await failure(Promise.resolve(handle(env(A) as never, ctx as never)))).toBeInstanceOf(Error);
  });

  it('REQ-SEC-024 / P-11: an envelope of tenant B on a tenant-A job is refused (common.internal) before any query, port or event', async () => {
    const { ctx, touched } = jobCtx(A);
    const err = await failure(Promise.resolve(handle(env(B) as never, ctx as never)));
    expect(isLimsError(err, 'common.internal')).toBe(true);
    expect(touched.tx).not.toHaveBeenCalled();
    expect(touched.port).not.toHaveBeenCalled();
    expect(touched.events).not.toHaveBeenCalled();
  });

  it('a job without a tenant is refused the same way', async () => {
    const { ctx, touched } = jobCtx(undefined);
    const err = await failure(Promise.resolve(handle(env(A) as never, ctx as never)));
    expect(isLimsError(err, 'common.internal')).toBe(true);
    expect(touched.tx).not.toHaveBeenCalled();
    expect(touched.events).not.toHaveBeenCalled();
  });
});
