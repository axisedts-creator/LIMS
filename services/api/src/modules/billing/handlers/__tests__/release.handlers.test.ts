// BL-T12 handlers: B14 createReleaseOverride and B15 getReleaseEligibility (request -> service mapping; the service logic is tested in service/__tests__/release.service.test.ts).
// Schema, auth, x-permission (billing.release.override, privileged / billing.invoice.read) and Idempotency-Key are enforced by the core pipeline.
// Spec: 02-TRD §5 B14 (201 {override_id, created_at}), B15 (ReleaseEligibilityDto = BillingPort shape, snake_case); openapi ReleaseOverrideRequest / ReleaseOverrideCreated / ReleaseEligibilityDto.
// Fails now: handlers/index.ts maps both operationIds to the BL-T01 stub (common.service_unavailable).
// ASSUMED: handlers call createReleaseService(...).createOverride(ctx, {orderId, reasonCode, reasonText?, expiresAt?}) -> {overrideId, createdAt}
//   and .getEligibility(ctx, {orderId}) -> ReleaseEligibility (same factory style as ledger.handlers.ts / invoice.handlers.ts).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeCtxFor } from '../../../../../../../packages/fakes/src/harness';

const h = vi.hoisted(() => ({ create: [] as any[], get: [] as any[], createResult: undefined as any, getResult: undefined as any, error: undefined as any }));
vi.mock('../../service/release.service.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>().catch(() => ({}))),
  createReleaseService: () => ({
    createOverride: async (ctx: any, input: any) => { h.create.push({ ctx, input }); if (h.error) throw h.error; return h.createResult; },
    getEligibility: async (ctx: any, input: any) => { h.get.push({ ctx, input }); if (h.error) throw h.error; return h.getResult; },
  }),
}));
import { LimsError } from '../../../../core/errors.js';
import { handlers } from '../index.js';

const V7 = (n: string) => `01a1a98a-ac40-7000-8000-${n}`;
const ORDER = V7('000000050001'), OVR = V7('0000000e0001');
const M = (n: number) => ({ amount_paisa: n, currency: 'NPR' });
const NPR = (n: number) => ({ amountPaisa: n, currency: 'NPR' });
const hctx = (extra: Record<string, unknown> = {}) => ({ operationId: 'x', clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} }, ...makeCtxFor()('A'), ...extra }) as never;
const req = (o: { params?: unknown; query?: unknown; headers?: unknown; body?: unknown } = {}) => ({ params: {}, query: {}, headers: {}, body: undefined, ...o }) as never;
const run = (op: string, r: unknown, c: unknown) => (handlers as any)[op](r, c);
const fail = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as any; } throw new Error('expected rejection'); };

beforeEach(() => {
  h.create.length = 0; h.get.length = 0; h.error = undefined;
  h.createResult = { overrideId: OVR, createdAt: '2026-11-08T06:00:01.000Z' };
  h.getResult = { orderId: ORDER, eligible: true, basis: 'override', balanceDue: NPR(100000), overrideId: OVR, evaluatedAt: '2026-11-08T06:00:02.000Z' };
});

describe('fail closed without an authenticated request context (REQ-SEC-099): not the BL-T01 503 stub', () => {
  for (const op of ['createReleaseOverride', 'getReleaseEligibility']) {
    it(`${op}: ctx without tenantId/actor/tx -> auth.unauthenticated and the service is never called`, async () => {
      const bare = { operationId: 'x', clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} } };
      const e = await fail(run(op, req({ params: { order_id: ORDER }, headers: { 'idempotency-key': 'k' }, body: { reason_code: 'SYN' } }), bare));
      expect(e.code).toBe('auth.unauthenticated'); expect(h.create.length + h.get.length).toBe(0);
    });
  }
});

describe('B14 createReleaseOverride', () => {
  const r = (body: Record<string, unknown> = { reason_code: 'SYN_REASON' }) => req({ params: { order_id: ORDER }, headers: { 'idempotency-key': 'K-1' }, body });
  it('201 {override_id, created_at} and nothing else', async () => {
    const out = await run('createReleaseOverride', r(), hctx());
    expect(out.status).toBe(201);
    expect(out.body).toEqual({ override_id: OVR, created_at: '2026-11-08T06:00:01.000Z' });
  });
  it('maps path order_id + body reason_code / reason_text / expires_at to camelCase service input; optional fields stay absent when not sent', async () => {
    await run('createReleaseOverride', r({ reason_code: 'SYN_REASON', reason_text: 'Synthetic text', expires_at: '2026-12-01T00:00:00.000Z' }), hctx());
    expect(h.create[0].input).toEqual({ orderId: ORDER, reasonCode: 'SYN_REASON', reasonText: 'Synthetic text', expiresAt: '2026-12-01T00:00:00.000Z' });
    await run('createReleaseOverride', r(), hctx());
    expect(h.create[1].input).toEqual({ orderId: ORDER, reasonCode: 'SYN_REASON' });
    expect(Object.keys(h.create[1].input)).toEqual(['orderId', 'reasonCode']);
  });
  it('passes the request ctx through unchanged (tenant and actor come from it, never the body)', async () => {
    const c = hctx();
    await run('createReleaseOverride', r({ reason_code: 'X', tenant_id: V7('0000000e0fff'), membership_id: V7('0000000e0ffe') }), c);
    expect(h.create[0].ctx).toBe(c);
    expect(JSON.stringify(h.create[0].input)).not.toContain('0000000e0fff');
    expect(JSON.stringify(h.create[0].input)).not.toContain('0000000e0ffe');
  });
  it('service errors pass through unchanged (not_found for another tenant\'s order, forbidden for a non-person)', async () => {
    for (const code of ['common.not_found', 'auth.forbidden', 'common.validation_failed']) {
      h.error = new LimsError(code);
      expect((await fail(run('createReleaseOverride', r(), hctx()))).code).toBe(code);
    }
  });
});

describe('B15 getReleaseEligibility', () => {
  const r = () => req({ params: { order_id: ORDER } });
  it('200 ReleaseEligibilityDto: snake_case keys, Money in snake form, override_id present for basis override', async () => {
    const out = await run('getReleaseEligibility', r(), hctx());
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ order_id: ORDER, eligible: true, basis: 'override', balance_due: M(100000), override_id: OVR, evaluated_at: '2026-11-08T06:00:02.000Z' });
    expect(h.get[0].input).toEqual({ orderId: ORDER });
  });
  it('override_id is omitted (not null) for every other basis', async () => {
    h.getResult = { orderId: ORDER, eligible: false, basis: 'due_outstanding', balanceDue: NPR(5), evaluatedAt: '2026-11-08T06:00:02.000Z' };
    const out = await run('getReleaseEligibility', r(), hctx());
    expect('override_id' in out.body).toBe(false);
    expect(out.body).toEqual({ order_id: ORDER, eligible: false, basis: 'due_outstanding', balance_due: M(5), evaluated_at: '2026-11-08T06:00:02.000Z' });
  });
  it('service errors pass through unchanged', async () => {
    h.error = new LimsError('common.not_found');
    expect((await fail(run('getReleaseEligibility', r(), hctx()))).code).toBe('common.not_found');
  });
});
