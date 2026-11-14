// C5 T-06 — worker wiring of the three order consumers (02-TRD §7.2 rows 1-3; 06 row T-06 "consumer contract"). Behaviour is proven in
// services/api/src/modules/lab/service/__tests__/order.service.integration.test.ts (live DB); this file proves the wiring and the tenant guard without a database.
// SEAM: consumers/frontdesk.order.{created,items_changed,cancelled}.v1.ts each `export const handle: ConsumerHandler` (same convention as jobs/reporting/consumers),
//       registered in ../index.ts under the event type; the handler runs the service function of the same name on the job ctx (ctx.tx, ctx.tenantId, ctx.events, ctx.ports).
// Contract of the wrapper (core/consumer.ts) is not re-tested: inbox dedupe, envelope validation with known-fields-only (unknown payload fields are dropped before the handler).
import { describe, expect, it, vi } from 'vitest';
import { isLimsError } from '../../../../../api/src/core/errors.js';
import { manifest } from '../index.js';
import { handle as created } from '../consumers/frontdesk.order.created.v1.js';
import { handle as changed } from '../consumers/frontdesk.order.items_changed.v1.js';
import { handle as cancelled } from '../consumers/frontdesk.order.cancelled.v1.js';

const A = '01a1a98a-ac40-7000-8000-00000000a001';
const B = '01a1a98a-ac40-7000-8000-00000000b001';
const SYS = '01a1b34e-1000-7eee-9d29-d7ca59a102b5';
const ORDER = '0190c606-0000-7000-8000-000000009001';
const ITEM = '0190c606-0000-7000-8000-000000009002';
const TEST = '0190c606-0000-7000-8000-000000009003';

const TYPES = {
  'frontdesk.order.created.v1': created,
  'frontdesk.order.items_changed.v1': changed,
  'frontdesk.order.cancelled.v1': cancelled,
} as const;
const item = { order_item_id: ITEM, orderable_id: TEST, orderable_kind: 'test', test_ids: [TEST], priority: 'routine' };
const PAYLOAD: Record<string, unknown> = {
  'frontdesk.order.created.v1': { order_id: ORDER, patient_id: ORDER, branch_id: ORDER, centre_id: ORDER, visit_type: 'opd', billing_mode: 'cash', priority: 'routine', collection_mode: 'walk_in',
    source: 'front_desk', registered_at: '2026-06-15T05:00:00.000Z', items: [item] },
  'frontdesk.order.items_changed.v1': { order_id: ORDER, items_version: 2, added: [item], removed: [], changed_at: '2026-06-15T05:00:00.000Z' },
  'frontdesk.order.cancelled.v1': { order_id: ORDER, reason_code: 'patient_request', cancelled_at: '2026-06-15T05:00:00.000Z', requires_credit_note: false },
};
const envelope = (type: string, tenant: string) => ({ event_id: ORDER, event_type: type, tenant_id: tenant, producer: 'frontdesk', aggregate: { type: 'order', id: ORDER, seq: 2 }, payload: PAYLOAD[type] });

function jobCtx(tenant: string | undefined) {
  const touched = { tx: vi.fn(), port: vi.fn(), events: vi.fn() };
  const boom = (f: () => void) => async () => { f(); throw new Error('SENTINEL'); };
  const ctx = {
    tenantId: tenant, actor: { type: 'system', id: SYS }, requestId: ORDER, now: () => '2026-06-15T05:00:30.000Z',
    tx: { query: boom(touched.tx) },
    events: { publish: boom(touched.events) },
    ports: {
      IdentityPort: { getTenantSettings: boom(touched.port) },
      FrontdeskPort: { getOrderSummary: boom(touched.port), getPatientDemographics: boom(touched.port) },
      CatalogPort: { resolveOrderables: boom(touched.port) },
    },
    log: { info() {}, warn() {}, error() {}, child() { return this; } },
  };
  return { ctx, touched };
}
const failure = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e) { return e; } throw new Error('expected rejection, but it resolved'); };

describe('T-06 order consumers are registered (not stubs)', () => {
  for (const [type, handle] of Object.entries(TYPES)) {
    it(`${type}: manifest subscription is a real handler (does not reject with "not implemented")`, async () => {
      expect(typeof handle).toBe('function');
      const sub = manifest.subscriptions?.[type];
      expect(typeof sub).toBe('function');
      const { ctx, touched } = jobCtx(A);
      const err = await failure(Promise.resolve(sub!(envelope(type, A) as never, ctx as never)));
      expect(String(err?.message)).not.toMatch(/not implemented/i);
      expect(touched.tx.mock.calls.length + touched.port.mock.calls.length, 'the handler must use the job tx or a port').toBeGreaterThan(0);
    });
  }
});

describe('T-06 tenant guard (REQ-SEC-024, 07-SECURITY P-11)', () => {
  for (const [type, handle] of Object.entries(TYPES)) {
    it(`${type}: an envelope of tenant B on a tenant-A job is refused (common.internal) before any query, port or event`, async () => {
      const { ctx, touched } = jobCtx(A);
      const err = await failure(Promise.resolve(handle(envelope(type, B) as never, ctx as never)));
      expect(isLimsError(err, 'common.internal')).toBe(true);
      expect(touched.tx).not.toHaveBeenCalled();
      expect(touched.port).not.toHaveBeenCalled();
      expect(touched.events).not.toHaveBeenCalled();
    });
    it(`${type}: a job without a tenant is refused the same way`, async () => {
      const { ctx, touched } = jobCtx(undefined);
      const err = await failure(Promise.resolve(handle(envelope(type, A) as never, ctx as never)));
      expect(isLimsError(err, 'common.internal')).toBe(true);
      expect(touched.tx).not.toHaveBeenCalled();
      expect(touched.port).not.toHaveBeenCalled();
    });
  }
});

describe('T-06 failure of a dependency propagates (retry / dead letter, never a silent ack)', () => {
  for (const [type, handle] of Object.entries(TYPES)) {
    it(`${type}: a failing port/DB call rejects the handler`, async () => {
      const { ctx } = jobCtx(A);
      const err = await failure(Promise.resolve(handle(envelope(type, A) as never, ctx as never)));
      expect(err).toBeInstanceOf(Error);
    });
  }
});
