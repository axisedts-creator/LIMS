// C9 T-19 — consumer reporting.report.released.v1 -> total clocks stop (02-TRD §10.2; 03-IC §3.17; AC-14.3; 08 R1, R13; 02-CV §11.4 duplicate + unknown-field tests; REQ-SEC-024, S-15). No database: the tat service is faked
// (the stop rules per report_kind are api tat.service.test.ts `applyRelease`).
// SEAM: ../consumers/reporting.report.released.v1.ts exports `createReportReleasedHandler(deps?: { service?: { applyRelease(ctx, { orderId, reportKind, orderItemIds?, releasedAt }): Promise<unknown> } }): ConsumerHandler`
//   and `handle` (= the handler on the real tat service). The handler: tenant guard (event.tenant_id === ctx.tenantId) and payload validation (order_id uuid, released_at IsoUtc, report_kind a non-empty string,
//   order_item_ids absent or an array of <= 200 uuids) BEFORE any service call or query; then `service.applyRelease(ctx, ...)` ONCE on the job ctx with EXACTLY those four keys (orderItemIds omitted when absent).
//   report_kind is passed through unchanged (x-extensible, 08 R13: the service decides; C9 stores no report_kind, P-4). The consumer issues no SQL itself; nothing else of the payload (patient_id, referrer, audiences,
//   release_basis, report_id) is read, passed on or logged. A service failure rejects (10 attempts, dead letter).
// Fails now: "Cannot find module ../consumers/reporting.report.released.v1.js".
import { describe, expect, it, vi } from 'vitest';
import { createReportReleasedHandler } from '../consumers/reporting.report.released.v1.js';

const A = '01a1a98a-ac40-7000-8000-00000000a001';
const B = '01a1a98a-ac40-7000-8000-00000000b001';
const u = (n: number) => `0190c60b-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const ORDER = u(0xd1), PATIENT = u(0xd2), REPORT = u(0xd3), I1 = u(0xe1), I2 = u(0xe2), REFERRER = u(0xd4);
const RELEASED = '2026-11-14T09:50:00.123Z';
function jobCtx(tenant: string | undefined) {
  const queries: unknown[] = []; const logs: unknown[] = [];
  const ctx: any = { tenantId: tenant, actor: { type: 'system', id: '01a1b34e-1000-7eee-9d29-d7ca59a102b5' }, requestId: u(8), now: () => '2026-11-14T10:00:00.000Z', attempt: 1, maxAttempts: 10, jobId: '1',
    tx: { async query(t: string, v: unknown[] = []) { queries.push({ t, v }); return { rows: [] }; } },
    log: { info: (...a: unknown[]) => logs.push(a), warn: (...a: unknown[]) => logs.push(a), error: (...a: unknown[]) => logs.push(a), child() { return this; } } };
  return { ctx, queries, logs };
}
type P = Record<string, unknown>;
const payload = (o: P = {}): P => ({ report_id: REPORT, version_no: 1, order_id: ORDER, patient_id: PATIENT, centre_id: u(0xd5), report_kind: 'final', released_at: RELEASED, release_basis: 'paid_in_full', audiences: ['patient'], ...o });
const envelope = (tenant: string | undefined, p: unknown = payload(), over: Record<string, unknown> = {}) => ({ event_id: u(9), event_type: 'reporting.report.released.v1', tenant_id: tenant, producer: 'reporting', occurred_at: RELEASED,
  request_id: u(8), idempotency_key: `${REPORT}:released:1`, aggregate: { type: 'report', id: REPORT, seq: 1 }, payload: p, ...over });
const svc = () => ({ applyRelease: vi.fn(async (_c: unknown, _i: unknown) => undefined) });
const failure = (p: Promise<unknown>) => p.then(() => undefined, (e) => e);
const run = (service: unknown, event: unknown, ctx: unknown) => Promise.resolve(createReportReleasedHandler({ service } as never)(event as never, ctx as never));

describe('reporting.report.released.v1 consumer: delegates to tat.applyRelease', () => {
  it('final with order_item_ids: ONE call on the job ctx with { orderId, reportKind, orderItemIds, releasedAt } exactly; no SQL of its own', async () => {
    const service = svc(); const { ctx, queries } = jobCtx(A); await run(service, envelope(A, payload({ order_item_ids: [I1, I2] })), ctx);
    expect(service.applyRelease).toHaveBeenCalledTimes(1); expect(service.applyRelease.mock.calls[0]![0]).toBe(ctx);
    expect(service.applyRelease.mock.calls[0]![1]).toEqual({ orderId: ORDER, reportKind: 'final', orderItemIds: [I1, I2], releasedAt: RELEASED }); expect(queries).toEqual([]);
  });
  it('final WITHOUT order_item_ids: the key is omitted (not undefined, not an empty array: the service stops every total item of the order)', async () => {
    const service = svc(); const { ctx } = jobCtx(A); await run(service, envelope(A), ctx); const arg = service.applyRelease.mock.calls[0]![1] as P;
    expect(Object.keys(arg).sort()).toEqual(['orderId', 'releasedAt', 'reportKind']);
  });
  it.each(['final', 'partial', 'preliminary', 'amended', 'addendum', 'brand_new_kind'])('report_kind %s reaches the service unchanged (x-extensible; the service decides, an unknown kind never throws)', async (report_kind) => {
    const service = svc(); const { ctx } = jobCtx(A); await run(service, envelope(A, payload({ report_kind, order_item_ids: [I1] })), ctx); expect(service.applyRelease.mock.calls[0]![1]).toMatchObject({ reportKind: report_kind });
  });
  it('a duplicate delivery calls the service twice with identical input (idempotent: the service never rewrites a stopped clock)', async () => {
    const service = svc(); const { ctx } = jobCtx(A); await run(service, envelope(A), ctx); await run(service, envelope(A), ctx); expect(service.applyRelease.mock.calls[1]![1]).toEqual(service.applyRelease.mock.calls[0]![1]);
  });
  it('a service failure rejects (retry, then dead letter)', async () => {
    const { ctx } = jobCtx(A); expect(await failure(run({ applyRelease: vi.fn(async () => { throw new Error('db down'); }) }, envelope(A), ctx))).toBeInstanceOf(Error);
  });
});

describe('reporting.report.released.v1 consumer: tenancy, hostile input, minimisation', () => {
  it('REQ-SEC-024: an event of another tenant, without tenant, a job without tenant, or no event at all is refused before any service call or query', async () => {
    for (const [event, tenant] of [[envelope(B), A], [envelope(undefined), A], [envelope(A), undefined], [null, A], [undefined, A]] as const) {
      const service = svc(); const { ctx, queries } = jobCtx(tenant as string | undefined); expect(await failure(run(service, event, ctx)), JSON.stringify(event)?.slice(0, 50)).toBeInstanceOf(Error);
      expect(service.applyRelease).not.toHaveBeenCalled(); expect(queries).toEqual([]);
    }
  });
  it('a tenant id smuggled inside the payload is ignored (the service takes the tenant from ctx only)', async () => {
    const service = svc(); const { ctx } = jobCtx(A); await run(service, envelope(A, payload({ tenant_id: B })), ctx); expect(JSON.stringify(service.applyRelease.mock.calls)).not.toContain(B);
  });
  it.each([['order_id missing', { order_id: undefined }], ['order_id not a uuid', { order_id: "x'; DROP TABLE quality.tat_items;--" }], ['order_id number', { order_id: 7 }], ['report_kind missing', { report_kind: undefined }], ['report_kind empty', { report_kind: '' }],
    ['report_kind number', { report_kind: 1 }], ['released_at missing', { released_at: undefined }], ['released_at garbage', { released_at: 'yesterday' }], ['released_at with offset', { released_at: '2026-11-14T15:35:00.123+05:45' }],
    ['order_item_ids a string', { order_item_ids: I1 }], ['order_item_ids with a non-uuid', { order_item_ids: [I1, "1' OR '1'='1"] }], ['order_item_ids with a number', { order_item_ids: [7] }], ['order_item_ids 201 entries', { order_item_ids: Array.from({ length: 201 }, (_x, i) => u(0x1000 + i)) }],
    ['order_item_ids null', { order_item_ids: null }]])('malformed payload (%s): rejects with a fixed-message Error BEFORE any service call', async (_n, over) => {
    const service = svc(); const { ctx, queries } = jobCtx(A); const e: any = await failure(run(service, envelope(A, payload(over as P)), ctx));
    expect(e).toBeInstanceOf(Error); expect(service.applyRelease).not.toHaveBeenCalled(); expect(queries).toEqual([]); expect(String(e.message)).not.toMatch(/DROP TABLE|OR '1'|yesterday/);
  });
  it('a payload that is not an object (or a deleted payload key) rejects before any service call', async () => {
    for (const p of [null, 'x', 7, []] as const) { const service = svc(); const { ctx } = jobCtx(A); expect(await failure(run(service, envelope(A, p, { payload: p }), ctx))).toBeInstanceOf(Error); expect(service.applyRelease).not.toHaveBeenCalled(); }
    const ev: any = envelope(A); delete ev.payload; const service = svc(); const { ctx } = jobCtx(A); expect(await failure(run(service, ev, ctx))).toBeInstanceOf(Error); expect(service.applyRelease).not.toHaveBeenCalled();
  });
  it('unknown extra fields and unread fields change nothing and never reach the service or a log (patient_id, referrer_id, audiences, release_basis, report_id, supersedes_version_no)', async () => {
    const a = svc(), b = svc(); const ca = jobCtx(A), cb = jobCtx(A); await run(a, envelope(A), ca.ctx);
    await run(b, envelope(A, payload({ referrer_id: REFERRER, supersedes_version_no: 1, brand_new_field: { x: 1 }, patient_note: 'SENTINEL-PHI-Sita-Karki' })), cb.ctx);
    expect(b.applyRelease.mock.calls[0]![1]).toEqual(a.applyRelease.mock.calls[0]![1]);
    const text = JSON.stringify([b.applyRelease.mock.calls[0]![1], cb.logs]); for (const leak of [PATIENT, REFERRER, REPORT, 'paid_in_full', 'SENTINEL-PHI-Sita-Karki', 'brand_new_field']) expect(text, leak).not.toContain(leak);
  });
});
