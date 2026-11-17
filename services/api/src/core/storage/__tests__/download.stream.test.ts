// T0B-FILESTREAM-1 (LD-312) done_when 1, 2, 3: ctx.download.stream and the shared streamStored helper send a stream, with Content-Length, validators,
// conditional 304, Range 206 / 416 and cache headers. Existing download.test.ts stays valid and unchanged (a storage with only read() still answers
// 200 with a Uint8Array body: the old path is the fallback).
// Prescribed API:
//   DownloadInput gains  requestHeaders?: Record<string, string | string[] | undefined>  (lower case names, as req.headers)  and  cache?: 'no-store' | { privateMaxAgeSeconds: number }
//   DownloadResponse     { status: 200 | 206 | 304 | 416; headers; body: Readable | Uint8Array | undefined }  (Readable when storage.readStream exists)
//   core/storage/stream.ts  streamStored(storage, { bucket, objectPath, headers, cache?, requestHeaders? })  same answer, no scan gate, no access log (the caller does that)
// Default cache-control stays exactly `no-store` (existing tests pin it; it already forbids shared caches). Access log: one row for 200, 206 and 304; none for 416.
import { Readable } from 'node:stream';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { TENANT_A, TENANT_B, PDF } from './helpers.js';
import { CHUNK, MiB, SLACK, bytesOf, makeStreamStorage, sink } from './stream.helpers.js';
import { installHttpPerf } from '../../observability/http-perf.js';

const PATH = `${TENANT_A}/2026/11/0190a000-0000-7000-8000-000000000001-v1.pdf`;
const ACCESS = { action: 'report.download', entityType: 'report', entityId: '0190a000-0000-7000-8000-000000000001', outcome: 'allowed' as const };
const ETAG = '"v1-abc"'; const LM = new Date('2026-11-16T10:00:00.000Z');
const hdr = (res: { headers?: Record<string, string> }, name: string): string | undefined => Object.entries(res.headers ?? {}).find(([k]) => k.toLowerCase() === name)?.[1];
const rejection = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e) { return e; } throw new Error('expected a rejection'); };
const bodyBytes = async (b: unknown): Promise<Buffer> => { if (b == null) return Buffer.alloc(0); const parts: Buffer[] = []; for await (const c of (b instanceof Uint8Array ? [b] : (b as AsyncIterable<Uint8Array>))) parts.push(Buffer.from(c)); return Buffer.concat(parts); };

/** An object of `size` bytes with the deterministic pattern (small ones are held, so ranges can be compared byte for byte). */
async function setup(o: { size?: number; etag?: string | null; lm?: Date | null; held?: boolean; bucket?: string; module?: string; path?: string } = {}) {
  const size = o.size ?? 1000; const bucket = o.bucket ?? 'reports'; const path = o.path ?? PATH;
  const { f, r, storage } = await makeStreamStorage(o.module ?? 'reporting');
  f.seed(bucket, path, { size, ...(o.etag === null ? {} : { etag: o.etag ?? ETAG }), ...(o.lm === null ? {} : { lastModified: o.lm ?? LM }), ...(o.held === false ? {} : { bytes: bytesOf(0, size) }) });
  const spies = { read: vi.spyOn(storage, 'read'), readStream: vi.spyOn(storage, 'readStream'), signedUrl: vi.spyOn(storage, 'signedUrl') };
  const audit = { access: vi.fn(async () => {}) };
  const { createDownload } = await import('../download.js');
  const dl = createDownload({ storage, audit, log: r.log });
  const input = (x: Record<string, unknown> = {}) => ({ bucket, objectPath: path, filename: 'report.pdf', contentType: 'application/pdf', scanState: 'clean', access: ACCESS, ...x });
  const req = (h: Record<string, string>) => ({ requestHeaders: h });
  return { f, r, storage, dl, audit, spies, input, req, size };
}

describe('download.stream: the body is a stream, not a buffer', () => {
  it('returns a Readable before the object is read; read() (whole object) is never called; all bytes arrive intact', async () => {
    const s = await setup({ size: 8 * MiB, held: false });
    const res = await s.dl.stream(s.input());
    expect(res.status).toBe(200); expect(res.body).toBeInstanceOf(Readable);
    expect(s.spies.read).not.toHaveBeenCalled(); expect(s.f.count('get')).toBe(0);
    expect(s.f.pulled.bytes, 'the response is returned before the object is consumed').toBeLessThanOrEqual(SLACK);
    const got = await sink(res.body);
    expect(got.size).toBe(8 * MiB);
    expect(s.f.pulled.bytes).toBe(8 * MiB);
  });
  it('Content-Length (known size), Accept-Ranges, ETag and Last-Modified from the storage; type, disposition, nosniff and no-store kept', async () => {
    const s = await setup();
    const res = await s.dl.stream(s.input());
    expect(hdr(res, 'content-length')).toBe('1000'); expect(hdr(res, 'accept-ranges')).toBe('bytes');
    expect(hdr(res, 'etag')).toBe(ETAG); expect(new Date(hdr(res, 'last-modified')!).getTime()).toBe(LM.getTime());
    expect(hdr(res, 'content-disposition')).toMatch(/^attachment; filename="report\.pdf"/); expect(hdr(res, 'x-content-type-options')).toBe('nosniff');
    expect(hdr(res, 'cache-control')).toBe('no-store'); expect(hdr(res, 'content-type')).toBe('application/pdf');
    expect((await bodyBytes(res.body)).equals(bytesOf(0, 1000))).toBe(true);
  });
  it('no ETag / Last-Modified header when the storage gives none (never invented)', async () => {
    const s = await setup({ etag: null, lm: null });
    const res = await s.dl.stream(s.input());
    expect(hdr(res, 'etag')).toBeUndefined(); expect(hdr(res, 'last-modified')).toBeUndefined(); expect(hdr(res, 'content-length')).toBe('1000');
    await bodyBytes(res.body);
  });
  it('no signed URL: signedUrl is not requested, no URL in headers or logs', async () => {
    const s = await setup();
    const res = await s.dl.stream(s.input({ requestHeaders: { range: 'bytes=0-9' } }));
    expect(s.spies.signedUrl).not.toHaveBeenCalled();
    expect(JSON.stringify([res.headers, s.r.lines])).not.toMatch(/https?:|token=|location/i);
    await bodyBytes(res.body);
  });
  it('an object that fails in the middle ends the body with an error (the client sees a broken download, not a short good one)', async () => {
    const s = await setup({ size: 5 * CHUNK, held: false }); s.f.state.failAfter = 2 * CHUNK;
    const res = await s.dl.stream(s.input());
    await expect(sink(res.body)).rejects.toBeDefined();
  });
  it('a missing object is common.dependency_unavailable and no access-log row is written', async () => {
    const s = await setup();
    const e = await rejection(s.dl.stream(s.input({ objectPath: `${TENANT_A}/2026/11/other.pdf` })));
    expect(e.code).toBe('common.dependency_unavailable'); expect(s.audit.access).not.toHaveBeenCalled();
  });
});

describe('download.stream: unchanged gates', () => {
  it.each(['pending', 'infected', 'unavailable', undefined])('scanState %j: 422 common.upload_quarantined, storage untouched', async (scanState) => {
    const s = await setup();
    const e = await rejection(s.dl.stream(s.input({ scanState })));
    expect(e.code).toBe('common.upload_quarantined'); expect(s.f.calls).toEqual([]); expect(s.audit.access).not.toHaveBeenCalled();
  });
  it('fails closed when the access-log write fails: no bytes are produced', async () => {
    const s = await setup({ size: 8 * MiB, held: false }); s.audit.access.mockRejectedValueOnce(new Error('db down'));
    await rejection(s.dl.stream(s.input()));
    await new Promise((r) => setTimeout(r, 10));
    expect(s.f.pulled.bytes).toBeLessThanOrEqual(SLACK);
  });
  it('tenant isolation: another tenant path never reaches the raw service or the audit log', async () => {
    const s = await setup();
    await rejection(s.dl.stream(s.input({ objectPath: `${TENANT_B}/2026/11/x.pdf` })));
    expect(s.f.calls).toEqual([]); expect(s.audit.access).not.toHaveBeenCalled();
  });
  it('writes exactly one access-log row per served response, before the first byte', async () => {
    const s = await setup(); const order: string[] = [];
    s.audit.access.mockImplementation(async () => { order.push('audit'); });
    const res = await s.dl.stream(s.input()); order.push('returned'); await bodyBytes(res.body);
    expect(order).toEqual(['audit', 'returned']); expect(s.audit.access).toHaveBeenCalledTimes(1);
  });
});

describe('download.stream: cache headers (done_when 3)', () => {
  it('default no-store; staff lists may ask for private, max-age=N (short: 1..3600); never public', async () => {
    const s = await setup();
    expect(hdr(await s.dl.stream(s.input()), 'cache-control')).toBe('no-store');
    const res = await s.dl.stream(s.input({ cache: { privateMaxAgeSeconds: 60 } }));
    expect(hdr(res, 'cache-control')).toBe('private, max-age=60'); await bodyBytes(res.body);
    for (const bad of [0, -1, 3601, 1.5, NaN]) expect((await rejection(s.dl.stream(s.input({ cache: { privateMaxAgeSeconds: bad } })))).code, String(bad)).toBe('common.internal');
  });
});

describe('download.stream: conditional requests -> 304 (done_when 1)', () => {
  const dl304 = async (h: Record<string, string>, o: Parameters<typeof setup>[0] = {}) => { const s = await setup(o); const res = await s.dl.stream(s.input({ requestHeaders: h })); return { s, res }; };
  it.each([[ETAG], [`W/${ETAG}`], [`"zzz", ${ETAG}`], ['*']])('If-None-Match %s matches -> 304, validators kept, no body, one access-log row', async (inm) => {
    const { s, res } = await dl304({ 'if-none-match': inm });
    expect(res.status).toBe(304); expect((await bodyBytes(res.body)).length).toBe(0);
    expect(hdr(res, 'etag')).toBe(ETAG); expect(hdr(res, 'cache-control')).toBe('no-store');
    expect(s.audit.access).toHaveBeenCalledTimes(1);
  });
  it('If-None-Match that does not match -> 200 with the body', async () => {
    const { res } = await dl304({ 'if-none-match': '"other"' });
    expect(res.status).toBe(200); expect((await bodyBytes(res.body)).length).toBe(1000);
  });
  it('If-Modified-Since at or after Last-Modified -> 304; before it -> 200; an unparsable date is ignored (200)', async () => {
    expect((await dl304({ 'if-modified-since': LM.toUTCString() })).res.status).toBe(304);
    expect((await dl304({ 'if-modified-since': new Date(LM.getTime() + 86_400_000).toUTCString() })).res.status).toBe(304);
    const before = (await dl304({ 'if-modified-since': new Date(LM.getTime() - 1000).toUTCString() })).res; expect(before.status).toBe(200); await bodyBytes(before.body);
    const junk = (await dl304({ 'if-modified-since': 'yesterday-ish' })).res; expect(junk.status).toBe(200); await bodyBytes(junk.body);
  });
  it('If-None-Match wins over If-Modified-Since (RFC 9110 13.1.3)', async () => {
    const res = (await dl304({ 'if-none-match': '"other"', 'if-modified-since': LM.toUTCString() })).res;
    expect(res.status).toBe(200); await bodyBytes(res.body);
  });
  it('the storage stream is not drained for a 304 (no object bytes read)', async () => {
    const { s } = await dl304({ 'if-none-match': ETAG }, { size: 8 * MiB, held: false });
    await new Promise((r) => setTimeout(r, 10));
    expect(s.f.pulled.bytes).toBeLessThanOrEqual(SLACK);
  });
  it('without validators from the storage a specific If-None-Match / If-Modified-Since cannot match: 200 with the body', async () => {
    for (const h of [{ 'if-none-match': ETAG }, { 'if-modified-since': LM.toUTCString() }]) {
      const { res } = await dl304(h, { etag: null, lm: null });
      expect(res.status).toBe(200); expect((await bodyBytes(res.body)).length).toBe(1000);
    }
  });
});

describe('download.stream: Range -> 206 / 416 (done_when 2)', () => {
  const get = async (range: string, h: Record<string, string> = {}, o: Parameters<typeof setup>[0] = {}) => { const s = await setup(o); const res = await s.dl.stream(s.input({ requestHeaders: { range, ...h } })); return { s, res, bytes: await bodyBytes(res.body) }; };
  it.each([
    ['bytes=0-9', 0, 9], ['bytes=100-199', 100, 199], ['bytes=990-', 990, 999], ['bytes=-10', 990, 999], ['bytes=990-5000', 990, 999], ['bytes=0-0', 0, 0], ['bytes=0-999', 0, 999], ['bytes=-5000', 0, 999],
  ])('%s -> 206, Content-Range bytes %i-%i/1000, exact length and bytes', async (range, a, b) => {
    const { res, bytes } = await get(range);
    expect(res.status).toBe(206);
    expect(hdr(res, 'content-range')).toBe(`bytes ${a}-${b}/1000`); expect(hdr(res, 'content-length')).toBe(String(b - a + 1)); expect(hdr(res, 'accept-ranges')).toBe('bytes');
    expect(bytes.equals(bytesOf(a, b - a + 1))).toBe(true);
    expect(hdr(res, 'etag')).toBe(ETAG);
  });
  it.each([['bytes=1000-'], ['bytes=5000-6000'], ['bytes=-0']])('%s is not satisfiable -> 416 with Content-Range bytes */1000, no body, no access-log row', async (range) => {
    const { s, res, bytes } = await get(range);
    expect(res.status).toBe(416); expect(hdr(res, 'content-range')).toBe('bytes */1000'); expect(bytes.length).toBe(0);
    expect(s.audit.access).not.toHaveBeenCalled();
  });
  it.each([['bytes=5-2'], ['bytes=0-1,5-6'], ['items=0-1'], ['bytes='], ['garbage'], ['bytes=a-b']])('%s is ignored: 200 with the whole object', async (range) => {
    const { res, bytes } = await get(range);
    expect(res.status).toBe(200); expect(hdr(res, 'content-range')).toBeUndefined(); expect(bytes.equals(bytesOf(0, 1000))).toBe(true);
  });
  it('a ranged response writes one access-log row and the full-object validators', async () => {
    const { s, res } = await get('bytes=0-9'); expect(res.status).toBe(206); expect(s.audit.access).toHaveBeenCalledTimes(1);
  });
  it('only the requested range is read from the storage (a 1 MiB tail of an 8 MiB object is not an 8 MiB read)', async () => {
    const s = await setup({ size: 8 * MiB, held: false });
    const res = await s.dl.stream(s.input({ requestHeaders: { range: `bytes=${7 * MiB}-` } }));
    expect(res.status).toBe(206); expect(hdr(res, 'content-length')).toBe(String(MiB));
    expect((await sink(res.body)).size).toBe(MiB);
    expect(s.f.pulled.bytes).toBe(MiB);
    expect(s.f.gets.at(-1)?.range).toEqual({ start: 7 * MiB, end: 8 * MiB - 1 });
  });
  it('If-Range: the current ETag -> 206; a different ETag or a stale date -> 200 whole object; a weak ETag never matches', async () => {
    expect((await get('bytes=0-9', { 'if-range': ETAG })).res.status).toBe(206);
    expect((await get('bytes=0-9', { 'if-range': LM.toUTCString() })).res.status).toBe(206);
    for (const v of ['"other"', `W/${ETAG}`, new Date(LM.getTime() - 5000).toUTCString()]) {
      const r = await get('bytes=0-9', { 'if-range': v }); expect(r.res.status, v).toBe(200); expect(r.bytes.length, v).toBe(1000);
    }
  });
  it('a zero length object has no satisfiable range: 416 for any bytes= range, 200 empty without one', async () => {
    const s = await setup({ size: 0 });
    expect((await s.dl.stream(s.input({ requestHeaders: { range: 'bytes=0-0' } }))).status).toBe(416);
    expect((await bodyBytes((await s.dl.stream(s.input())).body)).length).toBe(0);
  });
});

describe('streamStored (reports, prints, portal, engagement)', () => {
  const FIXED = { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="report-v1.pdf"', 'x-content-type-options': 'nosniff', 'content-security-policy': 'sandbox' };
  async function ss(o: Parameters<typeof setup>[0] = {}) {
    const s = await setup(o); const { streamStored } = await import('../stream.js');
    return { s, run: (x: Record<string, unknown> = {}) => streamStored(s.storage, { bucket: 'reports', objectPath: PATH, headers: FIXED, ...x }) };
  }
  it('streams with the caller headers kept, Content-Length, validators, Accept-Ranges and no-store by default; never reads the whole object', async () => {
    const { s, run } = await ss({ size: 4 * MiB, held: false });
    const res = await run();
    expect(res.status).toBe(200); expect(res.body).toBeInstanceOf(Readable); expect(s.spies.read).not.toHaveBeenCalled();
    for (const [k, v] of Object.entries(FIXED)) expect(hdr(res, k)).toBe(v);
    expect(hdr(res, 'content-length')).toBe(String(4 * MiB)); expect(hdr(res, 'etag')).toBe(ETAG); expect(hdr(res, 'accept-ranges')).toBe('bytes'); expect(hdr(res, 'cache-control')).toBe('no-store');
    expect((await sink(res.body)).size).toBe(4 * MiB);
  });
  it('Range and conditional requests are answered exactly as download.stream does', async () => {
    const { run } = await ss();
    const r = await run({ requestHeaders: { range: 'bytes=10-19' } }); expect(r.status).toBe(206); expect(hdr(r, 'content-range')).toBe('bytes 10-19/1000'); expect((await bodyBytes(r.body)).equals(bytesOf(10, 10))).toBe(true);
    const n = await run({ requestHeaders: { 'if-none-match': ETAG } }); expect(n.status).toBe(304); expect((await bodyBytes(n.body)).length).toBe(0);
    expect((await run({ requestHeaders: { range: 'bytes=2000-' } })).status).toBe(416);
  });
  it('cache: { privateMaxAgeSeconds } for staff lists; an invalid value is common.internal', async () => {
    const { run } = await ss();
    const r = await run({ cache: { privateMaxAgeSeconds: 30 } }); expect(hdr(r, 'cache-control')).toBe('private, max-age=30'); await bodyBytes(r.body);
    expect((await rejection(run({ cache: { privateMaxAgeSeconds: 99999 } }))).code).toBe('common.internal');
  });
  it('the tenant rule holds: another tenant path is refused before any storage call', async () => {
    const { s, run } = await ss();
    expect((await rejection(run({ objectPath: `${TENANT_B}/2026/11/x.pdf` }))).code).toBe('common.internal'); expect(s.f.calls).toEqual([]);
  });
  it('a storage that can only read() (old fakes) still works: 200 with the whole object as bytes and a Content-Length', async () => {
    const { storage } = await makeStreamStorage('reporting');
    const only = { read: async () => new Uint8Array(PDF) };
    const { streamStored } = await import('../stream.js');
    const res: any = await streamStored(only as any, { bucket: 'reports', objectPath: PATH, headers: FIXED });
    expect(res.status).toBe(200); expect(Buffer.from(res.body).equals(PDF)).toBe(true); expect(hdr(res, 'content-length')).toBe(String(PDF.length)); void storage;
  });
});

describe('HTTP level: nothing between the handler and the socket buffers, compresses or rewrites the stream', () => {
  async function app() {
    const s = await setup({ size: 3 * MiB, held: false });
    const a = Fastify(); installHttpPerf(a as any);
    a.get('/f', async (req, reply) => {
      const r = await s.dl.stream(s.input({ requestHeaders: req.headers }));
      if (r.headers) reply.headers(r.headers); reply.code(r.status); return reply.send(r.body);
    });
    await a.ready(); return { a, s };
  }
  it('200 streams the whole object with Content-Length, not gzipped even when the client accepts gzip', async () => {
    const { a } = await app();
    const r = await a.inject({ method: 'GET', url: '/f', headers: { 'accept-encoding': 'gzip, br' } });
    expect(r.statusCode).toBe(200); expect(r.headers['content-encoding']).toBeUndefined(); expect(r.headers['content-length']).toBe(String(3 * MiB)); expect(r.rawPayload.length).toBe(3 * MiB);
    await a.close();
  });
  it('Range answers 206 with Content-Range; If-None-Match answers 304 with an empty payload; an unsatisfiable range answers 416', async () => {
    const { a } = await app();
    const p = await a.inject({ method: 'GET', url: '/f', headers: { range: 'bytes=1048576-1048585' } });
    expect(p.statusCode).toBe(206); expect(p.headers['content-range']).toBe(`bytes 1048576-1048585/${3 * MiB}`); expect(p.rawPayload.equals(bytesOf(MiB, 10))).toBe(true);
    const n = await a.inject({ method: 'GET', url: '/f', headers: { 'if-none-match': ETAG } });
    expect(n.statusCode).toBe(304); expect(n.rawPayload.length).toBe(0);
    expect((await a.inject({ method: 'GET', url: '/f', headers: { range: `bytes=${3 * MiB}-` } })).statusCode).toBe(416);
    await a.close();
  });
});
