// T0B-FILESTREAM-1 (LD-312): the S3 compatible raw client gets getStream / putStream (Supabase now, own MinIO later, same code). fetch is injected, so the
// response body can be a lazily produced stream and the test can prove that the object is not read whole. Fails now: createS3RawStorage has neither.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createS3RawStorage, parseStorageConfig } from '../s3.js';
import { CHUNK, MiB, SLACK, bytesOf, expectedSha, sink, source } from './stream.helpers.js';

const cfg = parseStorageConfig({
  STORAGE_PROVIDER: 's3_compatible', STORAGE_ENDPOINT: 'http://localhost:9999', STORAGE_REGION: 'ap-south-1', STORAGE_BUCKET: 'lims-test',
  STORAGE_ACCESS_KEY_ID: 'AKIAFAKETESTKEY0001', STORAGE_SECRET_ACCESS_KEY: 'fake/Secret+Key/for-tests-only-0123456789', STORAGE_FORCE_PATH_STYLE: 'true',
});
if (cfg.provider !== 's3_compatible') throw new Error('test setup');
const NOW = Date.parse('2026-11-17T06:00:00Z');
const rejection = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e) { return e; } throw new Error('expected a rejection'); };
const webOf = (len: number, start = 0, pulled = { bytes: 0 }): ReadableStream<Uint8Array> => {
  let pos = 0;
  return new ReadableStream({ pull(c) { if (pos >= len) return c.close(); const n = Math.min(CHUNK, len - pos); pulled.bytes += n; c.enqueue(bytesOf(start + pos, n)); pos += n; } }, { highWaterMark: 0 });
};

describe('createS3RawStorage.getStream', () => {
  it('GET the object and hand back the body unread: size from Content-Length, etag and last-modified from the headers', async () => {
    const pulled = { bytes: 0 }; const seen: Array<{ url: string; init: any }> = [];
    const fetchStub = (async (url: string, init: any) => { seen.push({ url: String(url), init });
      return new Response(webOf(5 * MiB, 0, pulled), { status: 200, headers: { 'content-length': String(5 * MiB), etag: '"e1"', 'last-modified': 'Mon, 16 Nov 2026 10:00:00 GMT' } }); }) as unknown as typeof fetch;
    const raw = createS3RawStorage(cfg, { now: () => NOW, fetch: fetchStub });
    const r: any = await raw.getStream!('reports', 'T/2026/11/a.pdf');
    expect(seen).toHaveLength(1); expect(seen[0]!.init.method).toBe('GET');
    expect(r.size).toBe(5 * MiB); expect(r.etag).toBe('"e1"'); expect(new Date(r.lastModified).getTime()).toBe(Date.parse('2026-11-16T10:00:00Z'));
    expect(pulled.bytes, 'not read before the consumer asks').toBeLessThanOrEqual(SLACK);
    expect((await sink(r.body)).size).toBe(5 * MiB);
  });
  it('a range sends Range: bytes=a-b, accepts the 206, and reports the WHOLE size from Content-Range', async () => {
    const seen: any[] = [];
    const fetchStub = (async (url: string, init: any) => { seen.push(init);
      return new Response(webOf(100, 2), { status: 206, headers: { 'content-length': '100', 'content-range': 'bytes 2-101/5000', etag: '"e1"' } }); }) as unknown as typeof fetch;
    const raw = createS3RawStorage(cfg, { now: () => NOW, fetch: fetchStub });
    const r: any = await raw.getStream!('reports', 'T/2026/11/a.pdf', { range: { start: 2, end: 101 } });
    expect(new Headers(seen[0].headers).get('range')).toBe('bytes=2-101');
    expect(r.size).toBe(5000);
    expect((await sink(r.body))).toEqual({ size: 100, sha256: createHash('sha256').update(bytesOf(2, 100)).digest('hex') });
  });
  it('404 / 403 / 500 / a network error all throw one plain Error that carries neither the signed URL nor the secret', async () => {
    for (const mk of [() => new Response('x', { status: 404 }), () => new Response('x', { status: 403 }), () => new Response('x', { status: 500 }), () => { throw new TypeError('fetch failed http://localhost:9999/?X-Amz-Signature=abc'); }]) {
      const raw = createS3RawStorage(cfg, { now: () => NOW, fetch: (async () => mk()) as unknown as typeof fetch });
      const e = await rejection(raw.getStream!('reports', 'T/2026/11/a.pdf'));
      expect(String(e?.message)).not.toMatch(/X-Amz|Signature|Secret|AKIA|localhost/);
    }
  });
  it('an unsatisfiable range (416 from the provider) is an error, not an empty success', async () => {
    const raw = createS3RawStorage(cfg, { now: () => NOW, fetch: (async () => new Response('', { status: 416 })) as unknown as typeof fetch });
    await rejection(raw.getStream!('reports', 'T/2026/11/a.pdf', { range: { start: 9, end: 99 } }));
  });
  it('bad names are refused before any request (same rule as get)', async () => {
    let called = 0; const raw = createS3RawStorage(cfg, { now: () => NOW, fetch: (async () => { called++; return new Response(''); }) as unknown as typeof fetch });
    await rejection(raw.getStream!('../etc', 'x')); await rejection(raw.getStream!('reports', '')); expect(called).toBe(0);
  });
});

describe('createS3RawStorage.putStream', () => {
  it('PUT with the body as a stream (not a whole buffer), create only, with the content type; every byte reaches the server', async () => {
    const seen: any[] = []; let got = { size: 0, sha256: '' };
    // CR TENANT-LOGO-1: create only now looks the object up first (HEAD, 404 = absent), because a real Supabase Storage server ignores
    // if-none-match; the stub answers that HEAD and records the PUT (it was: exactly one request).
    const heads: string[] = [];
    const fetchStub = (async (url: string, init: any) => {
      if (init.method === 'HEAD') { heads.push(String(url)); return new Response(null, { status: 404 }); }
      seen.push({ url: String(url), init }); got = await sink(init.body); return new Response('', { status: 200 });
    }) as unknown as typeof fetch;
    const raw = createS3RawStorage(cfg, { now: () => NOW, fetch: fetchStub });
    await raw.putStream!('frontdesk-trf', 'T/2026/11/up.pdf', source(3 * MiB), { contentType: 'application/pdf', ifAbsent: true, byteSize: 3 * MiB });
    expect(heads).toHaveLength(1); expect(new URL(heads[0]!).pathname).toBe(new URL(seen[0].url).pathname);
    expect(seen).toHaveLength(1); expect(seen[0].init.method).toBe('PUT');
    expect(seen[0].init.body instanceof Uint8Array, 'body must not be a whole in-memory buffer').toBe(false);
    expect(got).toEqual({ size: 3 * MiB, sha256: expectedSha(3 * MiB) });
    const h = new Headers(seen[0].init.headers); expect(h.get('if-none-match')).toBe('*'); expect(h.get('content-type') ?? new URL(seen[0].url).searchParams.get('X-Amz-SignedHeaders')).toBeTruthy();
  });
  it('create only: an object that already exists (HEAD 200) is refused and NO byte is sent', async () => {
    let puts = 0;
    const raw = createS3RawStorage(cfg, { now: () => NOW, fetch: (async (_u: string, init: any) => { if (init.method === 'HEAD') return new Response(null, { status: 200 }); puts++; return new Response('', { status: 200 }); }) as unknown as typeof fetch });
    const e = await rejection(raw.putStream!('frontdesk-trf', 'T/2026/11/up.pdf', source(1000), { contentType: 'application/pdf', ifAbsent: true, byteSize: 1000 }));
    expect(String(e?.message)).toBe('storage: put failed (412)'); expect(puts).toBe(0);
    const e2 = await rejection(raw.put('frontdesk-trf', 'T/2026/11/up.pdf', new Uint8Array([1]), { contentType: 'application/pdf', ifAbsent: true }));
    expect(String(e2?.message)).toBe('storage: put failed (412)'); expect(puts).toBe(0);
  });
  it('a 412 (object exists) or 5xx answer is an Error without the URL or the secret', async () => {
    for (const status of [412, 500, 403]) {
      const raw = createS3RawStorage(cfg, { now: () => NOW, fetch: (async (_u: string, init: any) => { await sink(init.body); return new Response('', { status }); }) as unknown as typeof fetch });
      const e = await rejection(raw.putStream!('frontdesk-trf', 'T/2026/11/up.pdf', source(1000), { contentType: 'application/pdf', ifAbsent: true, byteSize: 1000 }));
      expect(String(e?.message)).not.toMatch(/X-Amz|Signature|Secret|AKIA|localhost/);
    }
  });
});
