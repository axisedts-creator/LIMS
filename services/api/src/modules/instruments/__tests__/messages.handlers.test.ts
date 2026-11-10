// C7 API-T12 — handler wiring for E33-E36 / E42 (request -> service mapping, no-store on raw, fail closed). Service behaviour: messages.service.test.ts. Seams: messages.helpers.ts header.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { idN, makeCtx, rejection } from './agents.helpers.js';

const svc: Record<string, ReturnType<typeof vi.fn>> = {};
const OPS = ['listInstrumentMessages', 'searchInstrumentMessages', 'getInstrumentMessage', 'getInstrumentMessageRaw', 'listMessageRejections'];
vi.mock('../service/messages.service.js', () => ({ createMessagesService: () => svc }));
const { manifest } = await import('../index.js');
const h = (op: string): any => (manifest.handlers as any)[op];

const MID = idN(0xf001), AID = idN(0x1000), IID = idN(0x2001), CID = idN(0xc1);
const FROM = '2026-11-07T00:00:00.000Z', TO = '2026-11-08T00:00:00.000Z';
const hctx = (operationId: string) => ({ operationId, clientIp: '203.0.113.9', ...makeCtx().ctx });
const req = (o: { params?: object; query?: object; headers?: object; body?: unknown } = {}) => ({ params: {}, query: {}, headers: {}, body: undefined, ...o });
beforeEach(() => { for (const op of OPS) svc[op] = vi.fn(async () => ({ status: 200, body: { ok: op } })); });

describe('wiring', () => {
  it.each(OPS)('%s is a real handler (not the common.internal stub): the service is called', async (op) => {
    await h(op)(req({ params: { instrument_message_id: MID }, query: { received_at_from: FROM, received_at_to: TO }, body: { sample_barcode: 'AB1' } }), hctx(op));
    expect(svc[op]).toHaveBeenCalledTimes(1);
  });
  it.each(OPS)('%s without an authenticated context -> auth.unauthenticated and the service is never called', async (op) => {
    const e = await rejection(h(op)(req(), { operationId: op, clientIp: '203.0.113.9' }));
    expect(e.code).toBe('auth.unauthenticated'); expect(svc[op]).not.toHaveBeenCalled();
  });
});

describe('request -> service mapping', () => {
  it('E33: every query parameter, snake -> camel, values passed through as the core coerced them', async () => {
    const q = { received_at_from: FROM, received_at_to: TO, instrument_id: IID, agent_id: AID, centre_id: CID, message_kind: ['data', 'attachment'], latest_outcome: ['parsed'], has_unmapped: true, has_qc: false, sort: '-received_at', cursor: 'C1', limit: 25 };
    const r = await h('listInstrumentMessages')(req({ query: q }), hctx('listInstrumentMessages'));
    expect(svc['listInstrumentMessages']).toHaveBeenCalledWith(expect.objectContaining({ tenantId: expect.any(String) }), { receivedAtFrom: FROM, receivedAtTo: TO, instrumentId: IID, agentId: AID, centreId: CID, messageKind: ['data', 'attachment'], latestOutcome: ['parsed'], hasUnmapped: true, hasQc: false, sort: '-received_at', cursor: 'C1', limit: 25 });
    expect(r.status).toBe(200);
  });
  it('E34: the barcode is read from the BODY only — a barcode in the query string or params is ignored', async () => {
    await h('searchInstrumentMessages')(req({ body: { sample_barcode: 'BODY1' }, query: { sample_barcode: 'QUERY1', barcode: 'QUERY2' }, params: { barcode: 'PATH1' } }), hctx('searchInstrumentMessages'));
    const [, input] = svc['searchInstrumentMessages']!.mock.calls[0]!;
    expect(input).toEqual({ body: { sample_barcode: 'BODY1' } }); expect(JSON.stringify(input)).not.toMatch(/QUERY|PATH/);
  });
  it('E35: path id + preview_parse', async () => {
    await h('getInstrumentMessage')(req({ params: { instrument_message_id: MID }, query: { preview_parse: true } }), hctx('getInstrumentMessage'));
    expect(svc['getInstrumentMessage']).toHaveBeenCalledWith(expect.anything(), { instrumentMessageId: MID, previewParse: true });
    await h('getInstrumentMessage')(req({ params: { instrument_message_id: MID } }), hctx('getInstrumentMessage'));
    expect(svc['getInstrumentMessage']!.mock.calls[1]![1]).toEqual({ instrumentMessageId: MID, previewParse: undefined });
  });
  it('E36: path id; 200 body passed through UNCHANGED with Cache-Control: no-store (raw is never cached by the BFF, 07-SECURITY §5)', async () => {
    svc['getInstrumentMessageRaw']!.mockResolvedValueOnce({ status: 200, body: { raw_base64: 'U1lO', raw_text_escaped: 'SYN', raw_sha256: 'a'.repeat(64), size_bytes: 3 } });
    const r = await h('getInstrumentMessageRaw')(req({ params: { instrument_message_id: MID } }), hctx('getInstrumentMessageRaw'));
    expect(svc['getInstrumentMessageRaw']).toHaveBeenCalledWith(expect.anything(), { instrumentMessageId: MID });
    expect(r.status).toBe(200); expect(r.body).toEqual({ raw_base64: 'U1lO', raw_text_escaped: 'SYN', raw_sha256: 'a'.repeat(64), size_bytes: 3 }); expect(r.headers?.['cache-control']).toBe('no-store');
  });
  it('E36: a service error propagates (no body, no partial raw)', async () => {
    svc['getInstrumentMessageRaw']!.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'common.not_found' }));
    await expect(h('getInstrumentMessageRaw')(req({ params: { instrument_message_id: MID } }), hctx('getInstrumentMessageRaw'))).rejects.toMatchObject({ code: 'common.not_found' });
  });
  it('E42: query -> input', async () => {
    await h('listMessageRejections')(req({ query: { received_at_from: FROM, received_at_to: TO, agent_id: AID, reason: 'instruments.device_mismatch', cursor: 'C', limit: 10 } }), hctx('listMessageRejections'));
    expect(svc['listMessageRejections']).toHaveBeenCalledWith(expect.anything(), { receivedAtFrom: FROM, receivedAtTo: TO, agentId: AID, reason: 'instruments.device_mismatch', cursor: 'C', limit: 10 });
  });
});
