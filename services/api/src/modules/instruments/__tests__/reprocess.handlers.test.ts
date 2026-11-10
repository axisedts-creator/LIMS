// C7 API-T13 — handler wiring for E38 / E39 (request -> service mapping, fail closed). Service behaviour: reprocess.service.test.ts. Seams: reprocess.helpers.ts header.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { idN, makeCtx, rejection } from './agents.helpers.js';

const svc: Record<string, ReturnType<typeof vi.fn>> = {};
const OPS = ['reprocessInstrumentMessage', 'rematchInstrumentRecord'];
vi.mock('../service/reprocess.service.js', () => ({ createReprocessService: () => svc }));
const { manifest } = await import('../index.js');
const h = (op: string): any => (manifest.handlers as any)[op];

const MID = idN(0xf401), RID = idN(0xf501);
const hctx = (operationId: string) => ({ operationId, clientIp: '203.0.113.9', ...makeCtx().ctx });
const req = (o: { params?: object; query?: object; headers?: object; body?: unknown } = {}) => ({ params: {}, query: {}, headers: {}, body: undefined, ...o });
beforeEach(() => { for (const op of OPS) svc[op] = vi.fn(async () => ({ status: 200, body: { ok: op } })); });

describe('wiring', () => {
  it.each(OPS)('%s is a real handler (not the common.internal stub): the service is called', async (op) => {
    const r = await h(op)(req({ params: { instrument_message_id: MID, record_id: RID }, body: { reason_code: 'other' } }), hctx(op));
    expect(svc[op]).toHaveBeenCalledTimes(1); expect(r).toEqual({ status: 200, body: { ok: op } });
  });
  it.each(OPS)('%s without an authenticated context -> auth.unauthenticated and the service is never called', async (op) => {
    const e = await rejection(h(op)(req(), { operationId: op, clientIp: '203.0.113.9' }));
    expect(e.code).toBe('auth.unauthenticated'); expect(svc[op]).not.toHaveBeenCalled();
  });
});

describe('request -> service mapping', () => {
  it('E38: path id + body passed through unchanged', async () => {
    const body = { reason_code: 'driver_fixed', reason_text: 'x' };
    await h('reprocessInstrumentMessage')(req({ params: { instrument_message_id: MID }, body }), hctx('reprocessInstrumentMessage'));
    expect(svc['reprocessInstrumentMessage']).toHaveBeenCalledWith(expect.objectContaining({ tenantId: expect.any(String) }), { instrumentMessageId: MID, body });
  });
  it('E39: path record id + body; the barcode is read from the BODY only — a barcode in query or params is ignored', async () => {
    const body = { sample_barcode: 'BODY1', reason_code: 'barcode_keypad_error' };
    await h('rematchInstrumentRecord')(req({ params: { record_id: RID, barcode: 'PATH1' }, query: { sample_barcode: 'QUERY1' }, body }), hctx('rematchInstrumentRecord'));
    const [, input] = svc['rematchInstrumentRecord']!.mock.calls[0]!;
    expect(input).toEqual({ recordId: RID, body }); expect(JSON.stringify(input)).not.toMatch(/QUERY|PATH/);
  });
  it('a service error propagates (no body)', async () => {
    svc['rematchInstrumentRecord']!.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'instruments.reprocess_not_allowed' }));
    await expect(h('rematchInstrumentRecord')(req({ params: { record_id: RID }, body: {} }), hctx('rematchInstrumentRecord'))).rejects.toMatchObject({ code: 'instruments.reprocess_not_allowed' });
  });
});
