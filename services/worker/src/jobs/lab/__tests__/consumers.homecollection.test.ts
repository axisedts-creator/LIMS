// C5 T-09 — wiring + tenant guard of the home-collection consumer, no database (06 row T-09; 02-TRD §7.2 row 8; PRD AC-03.2, AC-03.2a; 07-SECURITY P-11, REQ-SEC-024).
// Behaviour against the migrated DB is proven in services/api/src/modules/lab/service/__tests__/homecollection.consumer.integration.test.ts.
// SEAM: consumers/homecollection.collection.synced.v1.ts exports `handle: ConsumerHandler` (same convention as the frontdesk.order.* consumers), registered in ../index.ts
//       under 'homecollection.collection.synced.v1'; it runs on the job ctx (ctx.tx, ctx.tenantId, ctx.events, ctx.now() ISO string, ctx.actor system).
// The wrapper (core/consumer.ts) validates the envelope against the 03-IC §3.23 schema (booking_id optional) and dedupes; that is not re-tested here.
import { describe, expect, it, vi } from 'vitest';
import { isLimsError } from '../../../../../api/src/core/errors.js';
import { handle } from '../consumers/homecollection.collection.synced.v1.js';
import { manifest } from '../index.js';

const TYPE = 'homecollection.collection.synced.v1';
const A = '01a1a98a-ac40-7000-8000-00000000a001';
const B = '01a1a98a-ac40-7000-8000-00000000b001';
const SYS = '01a1b34e-1000-7eee-9d29-d7ca59a102b5';
const u = (n: number) => `0190c609-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;

const payload = (withBooking: boolean) => ({
  visit_id: u(1), order_id: u(2), phlebotomist_membership_id: u(3), ...(withBooking ? { booking_id: u(4) } : {}), synced_at: '2026-06-15T05:00:00.000Z',
  collections: [{ client_mutation_id: u(5), specimen_id: u(6), barcode_verified: true, collected_at_device: '2026-06-15T04:50:00.000Z' }], payments: [],
});
const envelope = (tenant: string, withBooking = false) => ({ event_id: u(9), event_type: TYPE, tenant_id: tenant, producer: 'homecollection',
  aggregate: { type: 'home_visit', id: u(1), seq: 3 }, payload: payload(withBooking) });

function jobCtx(tenant: string | undefined) {
  const touched = { tx: vi.fn(), port: vi.fn(), events: vi.fn() };
  const boom = (f: () => void) => async () => { f(); throw new Error('SENTINEL'); };
  const ctx = {
    tenantId: tenant, actor: { type: 'system', id: SYS }, requestId: u(8), now: () => '2026-06-15T05:00:30.000Z',
    tx: { query: boom(touched.tx) },
    events: { publish: boom(touched.events) },
    ports: { IdentityPort: { getTenantSettings: boom(touched.port) } },
    log: { info() {}, warn() {}, error() {}, child() { return this; } },
  };
  return { ctx, touched };
}
const failure = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e) { return e; } throw new Error('expected rejection, but it resolved'); };

describe('T-09 homecollection.collection.synced.v1 consumer is registered (not a stub)', () => {
  it('exports handle and the manifest subscription is a real handler (does not reject with "not implemented")', async () => {
    expect(typeof handle).toBe('function');
    const sub = manifest.subscriptions?.[TYPE];
    expect(typeof sub).toBe('function');
    const { ctx, touched } = jobCtx(A);
    const err = await failure(Promise.resolve(sub!(envelope(A) as never, ctx as never)));
    expect(String(err?.message)).not.toMatch(/not implemented/i);
    expect(touched.tx.mock.calls.length + touched.port.mock.calls.length, 'the handler must use the job tx (or a port)').toBeGreaterThan(0);
  });

  for (const withBooking of [false, true]) {
    it(`a failing DB call rejects the handler, never a silent ack (${withBooking ? 'with' : 'without'} booking_id)`, async () => {
      const { ctx } = jobCtx(A);
      expect(await failure(Promise.resolve(handle(envelope(A, withBooking) as never, ctx as never)))).toBeInstanceOf(Error);
    });
  }
});

describe('T-09 tenant guard (REQ-SEC-024, 07-SECURITY P-11)', () => {
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
});
