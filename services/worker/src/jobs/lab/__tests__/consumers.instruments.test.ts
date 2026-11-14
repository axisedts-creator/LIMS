// C5 T-22 — wiring + tenant guard of the instruments.result.received.v1 consumer, no database (06 row T-22; 02-TRD §4.5, §7.2 row "instruments.result.received.v1" (system actor, inbox + result-level key);
// 07-SECURITY P-08, REQ-SEC-024, REQ-SEC-098, REQ-SEC-121). The pipeline itself (every row of the §4.5 decision table) is proven in
// services/api/src/modules/lab/service/__tests__/ingest.service.test.ts and domain/__tests__/matching.test.ts.
// SEAM: consumers/instruments.result.received.v1.ts exports `handle: ConsumerHandler` (same convention as homecollection.collection.synced.v1.ts), registered in ../index.ts under
//       'instruments.result.received.v1'; it runs on the job ctx (ctx.tx, ctx.tenantId, ctx.events, ctx.now() ISO string, ctx.actor system) and calls the ingest service's
//       applyInstrumentResultEvent. The wrapper (core/consumer.ts) validates the envelope against the 03-IC §3.14 schema and dedupes on the event; that is not re-tested here.
import { describe, expect, it, vi } from 'vitest';
import { isLimsError } from '../../../../../api/src/core/errors.js';
import { handle } from '../consumers/instruments.result.received.v1.js';
import { manifest } from '../index.js';

const TYPE = 'instruments.result.received.v1';
const A = '01a1a98a-ac40-7000-8000-00000000a001';
const B = '01a1a98a-ac40-7000-8000-00000000b001';
const SYS = '01a1b34e-1000-7eee-9d29-d7ca59a102b5';
const BARCODE = 'SN2606150042';
const u = (n: number) => `0190c609-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;

const payload = (over: Record<string, unknown> = {}) => ({
  instrument_message_id: u(1), instrument_id: u(2), agent_id: u(3), centre_id: u(4), protocol: 'astm', sample_barcode: BARCODE, record_kind: 'quantitative', instrument_analyte_code: 'HGB',
  mapping_status: 'mapped', analyte_id: u(5), test_id: u(6), value_raw: '13.4', value_numeric: '13.4', unit_raw: 'g/dL', unit_code: 'g/dL', instrument_result_time: '2026-06-15T04:55:00.000Z',
  received_at: '2026-06-15T04:56:00.000Z', ...over,
});
const envelope = (tenant: string, over: Record<string, unknown> = {}) => ({ event_id: u(9), event_type: TYPE, tenant_id: tenant, producer: 'instruments',
  aggregate: { type: 'instrument_message', id: u(1), seq: 1 }, payload: payload(over) });

function jobCtx(tenant: string | undefined) {
  const touched = { tx: vi.fn(), port: vi.fn(), events: vi.fn() };
  const logged: unknown[][] = [];
  const boom = (f: () => void) => async () => { f(); throw new Error('SENTINEL'); };
  const ctx = {
    tenantId: tenant, actor: { type: 'system', id: SYS }, requestId: u(8), now: () => '2026-06-15T05:00:30.000Z',
    tx: { query: boom(touched.tx) },
    events: { publish: boom(touched.events) },
    ports: {
      IdentityPort: { getTenantSettings: boom(touched.port) },
      CatalogPort: { mapInstrumentCode: boom(touched.port), referenceRangeFor: boom(touched.port), criticalLimitsFor: boom(touched.port) },
      QualityPort: { canAutoVerify: boom(touched.port) },
    },
    log: { info: (...a: unknown[]) => logged.push(a), warn: (...a: unknown[]) => logged.push(a), error: (...a: unknown[]) => logged.push(a), debug: (...a: unknown[]) => logged.push(a), child() { return this; } },
  };
  return { ctx, touched, logged };
}
const failure = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e) { return e; } throw new Error('expected rejection, but it resolved'); };

describe('T-22 instruments.result.received.v1 consumer is registered (not a stub)', () => {
  it('exports handle and the manifest subscription is a real handler (does not reject with "not implemented")', async () => {
    expect(typeof handle).toBe('function');
    const sub = manifest.subscriptions?.[TYPE];
    expect(typeof sub).toBe('function');
    const { ctx, touched } = jobCtx(A);
    const err = await failure(Promise.resolve(sub!(envelope(A) as never, ctx as never)));
    expect(String(err?.message)).not.toMatch(/not implemented/i);
    expect(touched.tx.mock.calls.length + touched.port.mock.calls.length, 'the handler must use the job tx (or a port)').toBeGreaterThan(0);
  });

  it('a failing DB call rejects the handler, never a silent ack (the job retries / dead-letters)', async () => {
    const { ctx } = jobCtx(A);
    expect(await failure(Promise.resolve(handle(envelope(A) as never, ctx as never)))).toBeInstanceOf(Error);
  });

  it.each(['quantitative', 'attachment', 'organism_id'])('a %s record is processed under the job tx too (the result-level key is claimed first, even for records C5 ignores)', async (record_kind) => {
    const { ctx, touched } = jobCtx(A);
    await failure(Promise.resolve(handle(envelope(A, { record_kind }) as never, ctx as never)));
    expect(touched.tx).toHaveBeenCalled();
  });
});

describe('T-22 tenant guard (REQ-SEC-024, 07-SECURITY P-08)', () => {
  it('an envelope of tenant B on a tenant-A job is refused (common.internal) before any query, port or event', async () => {
    const { ctx, touched } = jobCtx(A);
    const err = await failure(Promise.resolve(handle(envelope(B) as never, ctx as never)));
    expect(isLimsError(err, 'common.internal')).toBe(true);
    expect(touched.tx).not.toHaveBeenCalled();
    expect(touched.port).not.toHaveBeenCalled();
    expect(touched.events).not.toHaveBeenCalled();
  });

  it('a job without a tenant is refused the same way', async () => {
    const { ctx, touched } = jobCtx(undefined);
    const err = await failure(Promise.resolve(handle(envelope(A) as never, ctx as never)));
    expect(isLimsError(err, 'common.internal')).toBe(true);
    expect(touched.tx).not.toHaveBeenCalled();
    expect(touched.events).not.toHaveBeenCalled();
  });

  it('a tenant id inside the payload is ignored: the job tenant is the only tenant', async () => {
    const { ctx, touched } = jobCtx(A);
    const err = await failure(Promise.resolve(handle(envelope(B, { tenant_id: A }) as never, ctx as never)));
    expect(isLimsError(err, 'common.internal')).toBe(true);
    expect(touched.tx).not.toHaveBeenCalled();
  });
});

describe('T-22 no patient-linked data in logs (REQ-SEC-098)', () => {
  it('a failing apply logs neither the barcode nor the value', async () => {
    const { ctx, logged } = jobCtx(A);
    await failure(Promise.resolve(handle(envelope(A) as never, ctx as never)));
    const text = JSON.stringify(logged);
    expect(text).not.toContain(BARCODE);
    expect(text).not.toContain('13.4');
  });
});
