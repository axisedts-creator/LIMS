// C9 T-19 — TAT stop logic of consumer lab.result.verified.v1 (02-TRD §10.2 row 3; AC-14.2, AC-14.3; vectors T5, T11; 02-CV §11.4). The verification_log insert is T-16 (lab.result.verified.test.ts, must stay green).
// SEAM: ../consumers/lab.result.verified.v1.ts additionally exports `createResultVerifiedHandler(deps?: { service?: { applyVerified(ctx, { orderItemId, testId, verifiedAt }): Promise<unknown> } }): ConsumerHandler`;
//   `handle` stays and = createResultVerifiedHandler() on the real tat service. Order of work: (1) tenant guard + payload validation (unchanged, before ANY query or service call); (2) the verification_log insert
//   (still the FIRST statement); (3) ONCE `service.applyVerified(ctx, { orderItemId: payload.order_item_id, testId: payload.test_id, verifiedAt: payload.verified_at })` on the job ctx — exactly these three keys,
//   for mode manual AND auto. A failing log insert rejects and the service is NOT called; a service failure rejects (retry; the insert is idempotent by ON CONFLICT DO NOTHING and applyVerified is idempotent, earliest wins).
//   specimen_id / verified_by_membership_id / department_id are never passed on (T-16 PII rules stay).
// Fails now: "createResultVerifiedHandler is not a function" (the consumer only inserts the log row).
import { describe, expect, it, vi } from 'vitest';
import { createResultVerifiedHandler } from '../consumers/lab.result.verified.v1.js';

const A = '01a1a98a-ac40-7000-8000-00000000a001';
const B = '01a1a98a-ac40-7000-8000-00000000b001';
const u = (n: number) => `0190c60b-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const VERIFIED_AT = '2026-11-14T09:59:58.123Z';
const MEMBERSHIP = u(0x5a), SPECIMEN = u(0x5b);
function jobCtx(tenant: string | undefined, order: string[], over: { queryFails?: boolean } = {}) {
  const queries: Array<{ text: string; values: unknown[] }> = []; const logs: unknown[] = [];
  const ctx: any = { tenantId: tenant, actor: { type: 'system', id: '01a1b34e-1000-7eee-9d29-d7ca59a102b5' }, requestId: u(8), now: () => '2026-11-14T10:00:00.000Z', attempt: 1, maxAttempts: 10, jobId: '1',
    tx: { async query(text: string, values: unknown[] = []) { order.push('query'); queries.push({ text, values }); if (over.queryFails) throw new Error('db down'); return { rows: [] }; } },
    log: { info: (...a: unknown[]) => logs.push(a), warn: (...a: unknown[]) => logs.push(a), error: (...a: unknown[]) => logs.push(a), child() { return this; } } };
  return { ctx, queries, logs };
}
type P = Record<string, unknown>;
const manual = (o: P = {}): P => ({ result_id: u(1), result_version_no: 2, order_id: u(2), order_item_id: u(3), specimen_id: SPECIMEN, test_id: u(4), analyte_id: u(6), mode: 'manual', verified_at: VERIFIED_AT, verified_by_membership_id: MEMBERSHIP, ...o });
const auto = (o: P = {}): P => { const p = manual({ mode: 'auto', ...o }); delete p['verified_by_membership_id']; delete p['specimen_id']; return p; };
const envelope = (tenant: string | undefined, payload: P = manual()) => ({ event_id: u(9), event_type: 'lab.result.verified.v1', tenant_id: tenant, producer: 'lab', occurred_at: '2026-11-14T09:59:59.000Z', request_id: u(8),
  idempotency_key: `${u(1)}:verified:2:5`, aggregate: { type: 'result', id: u(1), seq: 5 }, payload });
const failure = (p: Promise<unknown>) => p.then(() => undefined, (e) => e);
function setup(o: { serviceFails?: boolean; queryFails?: boolean; tenant?: string | undefined } = {}) {
  const order: string[] = []; const service = { applyVerified: vi.fn(async (_c: unknown, _i: unknown) => { order.push('service'); if (o.serviceFails) throw new Error('db down'); }) };
  const c = jobCtx('tenant' in o ? o.tenant : A, order, { ...(o.queryFails ? { queryFails: true } : {}) });
  return { service, order, ...c, run: (event: unknown) => Promise.resolve(createResultVerifiedHandler({ service } as never)(event as never, c.ctx)) };
}

describe('lab.result.verified.v1 consumer: TAT stop after the verification_log insert', () => {
  it('manual: ONE applyVerified call on the job ctx with { orderItemId, testId, verifiedAt } exactly, AFTER the log insert', async () => {
    const s = setup(); await s.run(envelope(A, manual()));
    expect(s.service.applyVerified).toHaveBeenCalledTimes(1); expect(s.service.applyVerified.mock.calls[0]![0]).toBe(s.ctx); expect(s.service.applyVerified.mock.calls[0]![1]).toEqual({ orderItemId: u(3), testId: u(4), verifiedAt: VERIFIED_AT });
    expect(s.order[0]).toBe('query'); expect(s.order.indexOf('service')).toBeGreaterThan(0); expect(s.queries[0]!.text.replace(/\s+/g, ' ')).toMatch(/^INSERT INTO quality\.verification_log\b/i);
  });
  it('mode:auto with specimen_id and verified_by_membership_id absent (03-IC §3.9, D-2) stops the clock the same way', async () => {
    const s = setup(); await s.run(envelope(A, auto())); expect(s.service.applyVerified).toHaveBeenCalledTimes(1); expect(s.service.applyVerified.mock.calls[0]![1]).toEqual({ orderItemId: u(3), testId: u(4), verifiedAt: VERIFIED_AT });
  });
  it('a duplicate delivery calls the service again with identical input (idempotent downstream: earliest verified_at wins, no rewrite)', async () => {
    const s = setup(); await s.run(envelope(A)); await s.run(envelope(A)); expect(s.service.applyVerified.mock.calls[1]![1]).toEqual(s.service.applyVerified.mock.calls[0]![1]);
  });
  it('a failing log insert rejects and the service is NOT called (retry redoes both)', async () => {
    const s = setup({ queryFails: true }); expect(await failure(s.run(envelope(A)))).toBeInstanceOf(Error); expect(s.service.applyVerified).not.toHaveBeenCalled();
  });
  it('a service failure rejects (retry, then dead letter)', async () => {
    const s = setup({ serviceFails: true }); expect(await failure(s.run(envelope(A)))).toBeInstanceOf(Error);
  });
  it('REQ-SEC-024: another tenant / no tenant / job without tenant / no event: no query and no service call', async () => {
    for (const [event, tenant] of [[envelope(B), A], [envelope(undefined), A], [envelope(A), undefined], [null, A]] as const) {
      const s = setup({ tenant: tenant as string | undefined }); expect(await failure(s.run(event))).toBeInstanceOf(Error); expect(s.queries).toEqual([]); expect(s.service.applyVerified).not.toHaveBeenCalled();
    }
  });
  it.each([['order_item_id not a uuid', { order_item_id: "x'; --" }], ['test_id missing', { test_id: undefined }], ['verified_at garbage', { verified_at: 'yesterday' }], ['mode unknown', { mode: 'semi' }]])('malformed payload (%s): no query and no service call', async (_n, over) => {
    const s = setup(); expect(await failure(s.run(envelope(A, manual(over as P))))).toBeInstanceOf(Error); expect(s.queries).toEqual([]); expect(s.service.applyVerified).not.toHaveBeenCalled();
  });
  it('S-15: specimen_id, verified_by_membership_id and unknown extra fields never reach the service input', async () => {
    const s = setup(); await s.run(envelope(A, manual({ brand_new_field: 'SENTINEL-PHI-Sita-Karki' }))); const text = JSON.stringify(s.service.applyVerified.mock.calls[0]![1]);
    for (const leak of [SPECIMEN, MEMBERSHIP, 'SENTINEL-PHI-Sita-Karki', 'brand_new_field']) expect(text, leak).not.toContain(leak);
  });
});
