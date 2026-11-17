// C7 API-T11 — HTTP wiring of E06 submitAttachment and E37 downloadInstrumentAttachment (02-TRD §7.2; contracts/openapi/instruments.yaml). The service is mocked (behaviour: attachments.service.test.ts).
// Auth, schema, x-permission, x-upload allowlist, 15 MB body limit and Idempotency-Key are the core pipeline's; the handlers map request -> service and fail closed without an authenticated context.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeIngestCtx, makeWorld } from './ingest.helpers.js';
import { rejection } from './agents.helpers.js';
import { BARCODE, idN, metadata, pdfBytes } from './attachments.helpers.js';

const svc = { submitAttachment: vi.fn(), downloadInstrumentAttachment: vi.fn() };
vi.mock('../service/attachments.service.js', () => ({ createAttachmentsService: () => svc }));
const { manifest } = await import('../index.js');
const sub: any = (manifest.handlers as any)['submitAttachment'];
const dl: any = (manifest.handlers as any)['downloadInstrumentAttachment'];
const dctx = (operationId: string, type: 'device' | 'user' = 'device') => { const c = makeIngestCtx(makeWorld()).ctx; if (type === 'user') c.actor = { type: 'user', id: idN(0xd1) }; return { operationId, ...c }; };
const bare = (operationId: string) => ({ operationId, clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} } });
const file = pdfBytes();
const part = (o: Record<string, unknown> = {}) => ({ filename: 'slide-0042.pdf', mimetype: 'application/pdf', data: Buffer.from(file), ...o });   // [CONV] core multipart parser shape (catalog imports.handlers)
const OK = { status: 202, body: { outcome: 'accepted', instrument_message_id: idN(0xf001), attachment_id: idN(0xe001), scan_state: 'pending' } };
beforeEach(() => { svc.submitAttachment = vi.fn(async () => OK); svc.downloadInstrumentAttachment = vi.fn(async () => ({ status: 200, headers: { 'cache-control': 'no-store' }, body: file })); });

describe('submitAttachment handler (E06)', () => {
  it('is no longer the stub: without an authenticated device context it fails closed with auth.unauthenticated and never calls the service', async () => {
    const e = await rejection(sub({ params: {}, query: {}, headers: {}, body: { metadata: metadata(file), file: part() } }, bare('submitAttachment')));
    expect(e?.code).toBe('auth.unauthenticated'); expect(svc.submitAttachment).not.toHaveBeenCalled();
  });
  it('maps the multipart parts to { metadata, file: { filename, mimeType, bytes } } and returns the service result untouched', async () => {
    const meta = metadata(file); const r = await sub({ params: {}, query: {}, headers: {}, body: { metadata: meta, file: part() } }, dctx('submitAttachment'));
    const [ctx, input] = svc.submitAttachment.mock.calls[0]!; expect(ctx.actor).toMatchObject({ type: 'device' });
    expect(input.metadata).toEqual(meta); expect(input.file).toMatchObject({ filename: 'slide-0042.pdf', mimeType: 'application/pdf' }); expect(Buffer.from(input.file.bytes).equals(file)).toBe(true); expect(r).toEqual(OK);
  });
  it('the metadata part arrives as a JSON STRING from a real multipart parser: it is parsed to the object', async () => {
    const meta = metadata(file); await sub({ params: {}, query: {}, headers: {}, body: { metadata: JSON.stringify(meta), file: part() } }, dctx('submitAttachment'));
    expect(svc.submitAttachment.mock.calls[0]![1].metadata).toEqual(meta);
  });
  it.each([['not JSON', '{nope'], ['a JSON array', '[1]'], ['JSON null', 'null']])('metadata that is %s -> 400/422 common.validation_failed, the service is not called', async (_n, bad) => {
    const e = await rejection(sub({ params: {}, query: {}, headers: {}, body: { metadata: bad, file: part() } }, dctx('submitAttachment')));
    expect(e?.code).toBe('common.validation_failed'); expect(svc.submitAttachment).not.toHaveBeenCalled();
  });
  it('a missing file part -> common.validation_failed, the service is not called', async () => {
    const e = await rejection(sub({ params: {}, query: {}, headers: {}, body: { metadata: metadata(file) } }, dctx('submitAttachment')));
    expect(e?.code).toBe('common.validation_failed'); expect(svc.submitAttachment).not.toHaveBeenCalled();
  });
  it('service errors propagate unchanged (no swallow, no remap)', async () => {
    svc.submitAttachment = vi.fn(async () => { const { LimsError } = await import('../../../core/errors.js'); throw new LimsError('common.unsupported_media_type'); });
    const e = await rejection(sub({ params: {}, query: {}, headers: {}, body: { metadata: metadata(file), file: part() } }, dctx('submitAttachment'))); expect(e?.code).toBe('common.unsupported_media_type');
  });
  it('the barcode and file name never reach the handler-level log', async () => {
    const c = dctx('submitAttachment'); const lines: string[] = []; (c as any).log = { info: (...a: unknown[]) => lines.push(JSON.stringify(a)), warn: (...a: unknown[]) => lines.push(JSON.stringify(a)), error: (...a: unknown[]) => lines.push(JSON.stringify(a)), debug: () => undefined };
    await sub({ params: {}, query: {}, headers: {}, body: { metadata: metadata(file), file: part() } }, c); expect(lines.join('\n')).not.toContain(BARCODE);
  });
});

describe('downloadInstrumentAttachment handler (E37)', () => {
  it('is no longer the stub: without an authenticated staff context it fails closed with auth.unauthenticated and never calls the service', async () => {
    const e = await rejection(dl({ params: { instrument_message_id: idN(0xf001) }, query: {}, headers: {}, body: undefined }, bare('downloadInstrumentAttachment')));
    expect(e?.code).toBe('auth.unauthenticated'); expect(svc.downloadInstrumentAttachment).not.toHaveBeenCalled();
  });
  it('passes the path id as { instrumentMessageId } and returns the service result (status, headers, bytes) UNCHANGED', async () => {
    const out = { status: 200, headers: { 'content-disposition': 'attachment; filename="a.pdf"', 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' }, body: file };
    svc.downloadInstrumentAttachment = vi.fn(async () => out);
    const r = await dl({ params: { instrument_message_id: idN(0xf001) }, query: {}, headers: {}, body: undefined }, dctx('downloadInstrumentAttachment', 'user'));
    expect(svc.downloadInstrumentAttachment).toHaveBeenCalledWith(expect.objectContaining({ actor: expect.objectContaining({ type: 'user' }) }), { instrumentMessageId: idN(0xf001) }); expect(r).toBe(out);
  });
  it('never adds a Location / redirect / URL (no Storage URL reaches the browser)', async () => {
    const r = await dl({ params: { instrument_message_id: idN(0xf001) }, query: {}, headers: {}, body: undefined }, dctx('downloadInstrumentAttachment', 'user'));
    expect(JSON.stringify(r.headers)).not.toMatch(/https?:\/\//); expect(Object.keys(r.headers).some((k) => /^location$/i.test(k))).toBe(false); expect(r.status).toBe(200);
  });
});
