// T0B-STORAGE-1 (LD-310, LD-316; founder 2026-11-17 08:48 NPT: supabase while testing, own server later, no code change to move).
// Provider neutral S3 adapter. Contract these tests pin (module `../s3.js`, to be written):
//   presignV4({ method, url, region, accessKeyId, secretAccessKey, now(ms), expiresSeconds, headers? }) -> full presigned URL (query signing)
//   createS3RawStorage(cfg, { now?, fetch? }): RawStorage   -- cfg from parseStorageConfig(env); logical bucket -> key prefix `<bucket>/<key>`
//     inside the ONE physical STORAGE_BUCKET. signUpload binds content-type, content-length, x-amz-content-sha256, x-amz-meta-sha256 and
//     if-none-match:* (create only) as SIGNED headers and returns them in `headers`; signDownload binds response-content-disposition /
//     -type / -cache-control as signed query parameters; head() reads the sha256 back from x-amz-meta-sha256.
// All traffic goes to the in-process fake (s3.fake.ts) on 127.0.0.1; the fake verifies signatures with its own code.
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LimsError } from '../../errors.js';
import { createStorage } from '../index.js';
import { createDirectTransfer } from '../direct.js';
import { createS3RawStorage, parseStorageConfig, presignV4 } from '../s3.js';
import { TENANT_A, recorders, storageOpts } from './helpers.js';
import { bytesOf } from './direct.helpers.js';
import { startFakeS3, sendVia, enc, TEST_ACCESS_KEY_ID, TEST_BUCKET, TEST_REGION, TEST_SECRET, type FakeS3 } from './s3.fake.js';

const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const START = Date.parse('2026-11-17T06:00:00Z');

describe('AWS Signature V4 query signing: published test vector (AWS S3 docs, "Authenticating Requests: Using Query Parameters")', () => {
  const secret = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
  const url = presignV4({
    method: 'GET', url: 'https://examplebucket.s3.amazonaws.com/test.txt', region: 'us-east-1',
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: secret, now: Date.parse('2013-05-24T00:00:00Z'), expiresSeconds: 86400,
  });
  it('produces exactly the published signature', () => {
    expect(url).toContain('X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404');
  });
  it('carries the published algorithm, credential scope, date, expiry and signed headers', () => {
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe('https://examplebucket.s3.amazonaws.com/test.txt');
    expect(u.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(u.searchParams.get('X-Amz-Credential')).toBe('AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request');
    expect(u.searchParams.get('X-Amz-Date')).toBe('20130524T000000Z');
    expect(u.searchParams.get('X-Amz-Expires')).toBe('86400');
    expect(u.searchParams.get('X-Amz-SignedHeaders')).toBe('host');
  });
  it('never puts the secret in the URL', () => { expect(url).not.toContain(secret); expect(decodeURIComponent(url)).not.toContain(secret); });
  it('a different secret, method, key or date gives a different signature', () => {
    const base = { method: 'GET', url: 'https://examplebucket.s3.amazonaws.com/test.txt', region: 'us-east-1', accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: secret, now: Date.parse('2013-05-24T00:00:00Z'), expiresSeconds: 86400 };
    const sig = (o: object) => new URL(presignV4({ ...base, ...o })).searchParams.get('X-Amz-Signature');
    const ref = sig({});
    for (const o of [{ secretAccessKey: secret + 'x' }, { method: 'PUT' }, { url: 'https://examplebucket.s3.amazonaws.com/test2.txt' }, { now: base.now + 1000 }]) expect(sig(o)).not.toBe(ref);
  });
  it('extra signed headers are listed sorted in X-Amz-SignedHeaders', () => {
    const u = new URL(presignV4({ method: 'PUT', url: 'https://examplebucket.s3.amazonaws.com/a', region: 'us-east-1', accessKeyId: 'AK', secretAccessKey: 's', now: START, expiresSeconds: 60, headers: { 'Content-Type': 'application/pdf', 'If-None-Match': '*' } }));
    expect(u.searchParams.get('X-Amz-SignedHeaders')).toBe('content-type;host;if-none-match');
  });
});

describe.each([['path', true], ['virtual host', false]] as const)('S3 adapter against the fake S3 server, %s style addressing', (label, forcePathStyle) => {
  const clock = { t: START };
  const now = () => clock.t;
  let fake: FakeS3; let raw: ReturnType<typeof createS3RawStorage>;
  const env = (port: number) => ({
    STORAGE_PROVIDER: 's3_compatible', STORAGE_ENDPOINT: `http://localhost:${port}`, STORAGE_REGION: TEST_REGION, STORAGE_BUCKET: TEST_BUCKET,
    STORAGE_ACCESS_KEY_ID: TEST_ACCESS_KEY_ID, STORAGE_SECRET_ACCESS_KEY: TEST_SECRET, STORAGE_FORCE_PATH_STYLE: String(forcePathStyle),
  });
  const mk = (e: Record<string, string>, deps: object = {}) => {
    const cfg = parseStorageConfig(e);
    if (cfg.provider !== 's3_compatible') throw new Error('test setup: expected s3_compatible');
    return createS3RawStorage(cfg, { now, fetch: sendVia(fake.port) as unknown as typeof fetch, ...deps });
  };
  const send = (u: string, init?: Parameters<ReturnType<typeof sendVia>>[1]) => sendVia(fake.port)(u, init);
  const KEY = `${TENANT_A}/report-1.pdf`;
  const body = bytesOf(1000, 0x41);
  const up = async (key = KEY, bytes: Uint8Array = body, o: { ttlSeconds?: number; contentType?: string } = {}) => {
    const g = await raw.signUpload!('reports', key, { ttlSeconds: 300, contentType: 'application/pdf', byteSize: bytes.length, sha256: sha(bytes), ifAbsent: true, resumable: false, ...o });
    return { ...g, headers: Object.fromEntries(Object.entries(g.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])) as Record<string, string> };
  };
  const put = (g: { url: string; method: string; headers?: Record<string, string> }, bytes: Uint8Array = body, h: Record<string, string> = g.headers ?? {}) =>
    send(g.url, { method: g.method, headers: h, body: bytes });
  const lastReason = () => fake.requests.at(-1)?.reason;

  beforeAll(async () => { fake = await startFakeS3({ style: forcePathStyle ? 'path' : 'virtual', clock: now }); raw = mk(env(fake.port)); });
  afterAll(async () => { await fake.close(); });
  beforeEach(() => { clock.t = START; fake.objects.clear(); fake.requests.length = 0; delete fake.state.forceStatus; });

  it(`${label}: the signed URL addresses the bucket the configured way`, async () => {
    const g = await up(); const u = new URL(g.url);
    if (forcePathStyle) { expect(u.host).toBe(`localhost:${fake.port}`); expect(u.pathname).toBe(`/${TEST_BUCKET}/reports/${KEY}`); }
    else { expect(u.host).toBe(`${TEST_BUCKET}.localhost:${fake.port}`); expect(u.pathname).toBe(`/reports/${KEY}`); }
  });

  describe('signUpload', () => {
    it('returns PUT and the exact headers the signature binds', async () => {
      const g = await up(); const h = Object.fromEntries(Object.entries(g.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
      expect(g.method).toBe('PUT');
      expect(h).toMatchObject({ 'content-type': 'application/pdf', 'content-length': '1000', 'x-amz-content-sha256': sha(body), 'x-amz-meta-sha256': sha(body), 'if-none-match': '*' });
      const u = new URL(g.url);
      expect(u.searchParams.get('X-Amz-SignedHeaders')!.split(';')).toEqual(expect.arrayContaining(['content-length', 'content-type', 'host', 'if-none-match', 'x-amz-content-sha256', 'x-amz-meta-sha256']));
      expect(u.searchParams.get('X-Amz-Expires')).toBe('300');
      expect(u.searchParams.get('X-Amz-Date')).toBe('20261117T060000Z');
      expect(g.url).not.toContain(TEST_SECRET);
    });
    it('the bytes go straight to the store with the returned headers and the object is created', async () => {
      const g = await up();
      expect((await put(g)).status).toBe(200);
      const o = fake.objects.get(`reports/${KEY}`)!;
      expect(o.bytes.equals(Buffer.from(body))).toBe(true);
      expect(o.contentType).toBe('application/pdf');
      expect(o.meta.sha256).toBe(sha(body));
    });
    it('head() reports size, type and the stored sha256; absent object is undefined', async () => {
      expect(await raw.head!('reports', KEY)).toBeUndefined();
      await put(await up());
      expect(await raw.head!('reports', KEY)).toEqual({ byteSize: 1000, contentType: 'application/pdf', sha256: sha(body) });
    });
    it('create only: a second signed upload to the same key is refused (412) and the first object is untouched', async () => {
      await put(await up());
      const other = bytesOf(1000, 0x42);
      const r = await put(await up(KEY, other), other);
      expect(r.status).toBe(412);
      expect(fake.objects.get(`reports/${KEY}`)!.bytes.equals(Buffer.from(body))).toBe(true);
    });
    it('create only: the same URL cannot be replayed to overwrite', async () => {
      const g = await up(); await put(g);
      expect((await put(g)).status).toBe(412);
    });
    it.each([
      ['content type', 'content-type', 'text/html'],
      ['content length', 'content-length', '1001'],
      ['payload checksum', 'x-amz-content-sha256', 'f'.repeat(64)],
      ['stored checksum', 'x-amz-meta-sha256', 'e'.repeat(64)],
      ['create-only condition', 'if-none-match', '"x"'],
    ])('a tampered %s is refused and nothing is stored', async (_n, header, value) => {
      const g = await up();
      const h = { ...g.headers, [header]: value };
      const bytes = header === 'content-length' ? bytesOf(1001, 0x41) : body;
      expect((await put(g, bytes, h)).status).toBe(403);
      expect(lastReason()).toBe('signature mismatch');
      expect(fake.objects.size).toBe(0);
    });
    it.each(['content-type', 'x-amz-content-sha256', 'x-amz-meta-sha256', 'if-none-match'])('dropping the signed %s header is refused', async (header) => {
      const g = await up();
      const h = { ...g.headers }; delete h[header];
      expect((await put(g, body, h)).status).toBe(403);
      expect(fake.objects.size).toBe(0);
    });
    it('right headers but bytes that do not match the signed sha256 are refused (400) and nothing is stored', async () => {
      const g = await up();
      const r = await put(g, bytesOf(1000, 0x43));
      expect(r.status).toBe(400);
      expect(lastReason()).toBe('XAmzContentSHA256Mismatch');
      expect(fake.objects.size).toBe(0);
    });
    it('a tampered URL (key, expiry, signed header list) is refused', async () => {
      const g = await up(); const u = new URL(g.url);
      const swap = (f: (x: URL) => void) => { const t = new URL(g.url); f(t); return t.toString(); };
      for (const url of [
        swap((t) => { t.pathname = t.pathname.replace('report-1', 'report-2'); }),
        swap((t) => t.searchParams.set('X-Amz-Expires', '604800')),
        swap((t) => t.searchParams.set('X-Amz-SignedHeaders', 'host')),
        swap((t) => t.searchParams.set('X-Amz-Signature', '0'.repeat(64))),
      ]) { expect((await put({ ...g, url })).status).toBe(403); }
      expect(u.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
      expect(fake.objects.size).toBe(0);
    });
    it('the upload URL does not work as a download or a delete', async () => {
      const g = await up();
      expect((await send(g.url, { method: 'GET' })).status).toBe(403);
      expect((await send(g.url, { method: 'DELETE' })).status).toBe(403);
    });
    it('expiry is enforced: ok at ttl-1 s, refused after ttl, and the reason is expiry', async () => {
      const g = await up(KEY, body, { ttlSeconds: 60 });
      clock.t = START + 59_000;
      expect((await put(g)).status).toBe(200);
      const g2 = await up(`${TENANT_A}/report-2.pdf`, body, { ttlSeconds: 60 });
      clock.t += 61_000;
      expect((await put(g2)).status).toBe(403);
      expect(lastReason()).toBe('expired');
    });
    it('rejects a ttl of 0 or above the S3 maximum before signing', async () => {
      await expect(up(KEY, body, { ttlSeconds: 0 })).rejects.toThrow();
      await expect(up(KEY, body, { ttlSeconds: 604801 })).rejects.toThrow();
    });
    it('a key with a space, plus and non ASCII letter round trips (canonical encoding is correct)', async () => {
      const key = `${TENANT_A}/Rép ort+1~v2.pdf`;
      const g = await up(key); expect((await put(g)).status).toBe(200);
      expect(fake.objects.has(`reports/${key}`)).toBe(true);
      expect((await raw.head!('reports', key))?.byteSize).toBe(1000);
    });
  });

  describe('signDownload', () => {
    const DISP = 'attachment; filename="report.pdf"; filename*=UTF-8\'\'report.pdf';
    const dl = (key = KEY) => raw.signDownload!('reports', key, { ttlSeconds: 120, disposition: DISP, cacheControl: 'private, no-store, max-age=0', contentType: 'application/pdf', acceptRanges: true });
    beforeEach(async () => { await put(await up()); fake.requests.length = 0; });

    it('the store serves the object with the signed disposition, type and cache headers', async () => {
      const r = await send((await dl()).url);
      expect(r.status).toBe(200);
      expect(r.headers.get('content-disposition')).toBe(DISP);
      expect(r.headers.get('content-type')).toBe('application/pdf');
      expect(r.headers.get('cache-control')).toBe('private, no-store, max-age=0');
      expect(Buffer.from(await r.arrayBuffer()).equals(Buffer.from(body))).toBe(true);
    });
    it('serves byte ranges (206 with content-range)', async () => {
      const r = await send((await dl()).url, { headers: { range: 'bytes=10-19' } });
      expect(r.status).toBe(206);
      expect(r.headers.get('content-range')).toBe('bytes 10-19/1000');
      expect((await r.arrayBuffer()).byteLength).toBe(10);
    });
    it('the disposition, type and cache parameters are bound: changing any of them is refused', async () => {
      const g = await dl();
      for (const p of ['response-content-disposition', 'response-content-type', 'response-cache-control']) {
        const u = new URL(g.url); expect(u.searchParams.has(p), p).toBe(true);
        u.searchParams.set(p, 'inline'); expect((await send(u.toString())).status, p).toBe(403);
        const d = new URL(g.url); d.searchParams.delete(p); expect((await send(d.toString())).status, `${p} removed`).toBe(403);
      }
    });
    it('is bound to the key, the method and the expiry', async () => {
      const g = await dl();
      const other = new URL(g.url); other.pathname = other.pathname.replace('report-1', 'report-2');
      expect((await send(other.toString())).status).toBe(403);
      expect((await send(g.url, { method: 'PUT', body: bytesOf(5) })).status).toBe(403);
      clock.t = START + 121_000;
      expect((await send(g.url)).status).toBe(403);
      expect(lastReason()).toBe('expired');
    });
    it('a missing object is 404, not 403', async () => {
      expect((await send((await dl(`${TENANT_A}/nope.pdf`)).url)).status).toBe(404);
    });
  });

  describe('the rest of RawStorage', () => {
    const K2 = `${TENANT_A}/moved.pdf`;
    it('put then get returns the same bytes with the content type', async () => {
      await raw.put('reports', KEY, body, { contentType: 'application/pdf' });
      expect(fake.objects.get(`reports/${KEY}`)!.contentType).toBe('application/pdf');
      expect(Buffer.from(await raw.get('reports', KEY)).equals(Buffer.from(body))).toBe(true);
    });
    it('put with ifAbsent refuses to overwrite and keeps the first object', async () => {
      await raw.put('reports', KEY, body, { contentType: 'application/pdf', ifAbsent: true });
      await expect(raw.put('reports', KEY, bytesOf(1000, 0x42), { contentType: 'application/pdf', ifAbsent: true })).rejects.toThrow();
      expect(fake.objects.get(`reports/${KEY}`)!.bytes[0]).toBe(0x41);
    });
    it('get of a missing object rejects', async () => { await expect(raw.get('reports', KEY)).rejects.toThrow(); });
    it('move copies then removes the source', async () => {
      await raw.put('reports', KEY, body, { contentType: 'application/pdf' });
      await raw.move('reports', KEY, K2);
      expect(fake.objects.has(`reports/${KEY}`)).toBe(false);
      expect(fake.objects.get(`reports/${K2}`)!.bytes.equals(Buffer.from(body))).toBe(true);
    });
    it('move of a missing source rejects and creates nothing', async () => {
      await expect(raw.move('reports', KEY, K2)).rejects.toThrow();
      expect(fake.objects.size).toBe(0);
    });
    it('remove deletes; removing a missing object is not an error', async () => {
      await raw.put('reports', KEY, body, { contentType: 'application/pdf' });
      await raw.remove('reports', KEY); expect(fake.objects.size).toBe(0);
      await expect(raw.remove('reports', KEY)).resolves.toBeUndefined();
    });
    it('logical buckets stay apart inside the one physical bucket', async () => {
      await raw.put('reports', KEY, body, { contentType: 'application/pdf' });
      await expect(raw.get('billing-exports', KEY)).rejects.toThrow();
    });
    it('sign() gives a short lived GET url that works and then expires', async () => {
      await raw.put('reports', KEY, body, { contentType: 'application/pdf' });
      const url = await raw.sign('reports', KEY, 30);
      expect((await send(url)).status).toBe(200);
      clock.t += 31_000;
      expect((await send(url)).status).toBe(403);
    });
  });

  describe('failures never leak the credential', () => {
    const leaks = (e: unknown) => { const m = String((e as Error)?.message ?? e) + String((e as Error)?.stack ?? ''); return [TEST_SECRET, 'X-Amz-Signature', encodeURIComponent(TEST_SECRET), enc(TEST_SECRET)].filter((s) => m.includes(s)); };
    it.each([[500], [403], [503]])('a %i from the store rejects with a message that has no secret and no signature', async (status) => {
      fake.state.forceStatus = status;
      for (const call of [() => raw.head!('reports', KEY), () => raw.get('reports', KEY), () => raw.put('reports', KEY, body, { contentType: 'application/pdf' }), () => raw.remove('reports', KEY)]) {
        const e = await call().then(() => undefined, (x: unknown) => x);
        expect(e, 'must reject').toBeDefined(); expect(leaks(e)).toEqual([]);
      }
    });
    it('head() of a store that refuses (403 / 500) rejects, it does not answer "absent"', async () => {
      fake.state.forceStatus = 403; await expect(raw.head!('reports', KEY)).rejects.toThrow();
      fake.state.forceStatus = 500; await expect(raw.head!('reports', KEY)).rejects.toThrow();
    });
    it('wrong secret key is refused by the store (403), not accepted', async () => {
      const bad = mk({ ...env(fake.port), STORAGE_SECRET_ACCESS_KEY: TEST_SECRET + 'x' });
      await expect(bad.head!('reports', KEY)).rejects.toThrow();
    });
    it('a network failure rejects without the secret', async () => {
      const down = mk(env(fake.port), { fetch: (() => Promise.reject(new Error('connect ECONNREFUSED'))) as unknown as typeof fetch });
      const e = await down.head!('reports', KEY).then(() => undefined, (x: unknown) => x);
      expect(e).toBeDefined(); expect(leaks(e)).toEqual([]);
    });
  });

  describe('through the existing StorageAdapter and direct transfer (T0B-FILES-1 code, unchanged)', () => {
    it('signedUploadUrl -> store -> confirmUpload accepts; a wrong sha256 is refused (the store kept the signed one)', async () => {
      const rec = recorders();
      const storage = createStorage({ ...storageOpts({ connect: () => raw } as never, rec, 'reporting'), now } as never);
      const direct = createDirectTransfer({ storage, now });
      const path = `${TENANT_A}/via-adapter.pdf`;
      const s = await storage.signedUploadUrl('reports', path, { ttlSeconds: 300, contentType: 'application/pdf', byteSize: 1000, sha256: sha(body) });
      expect(s.method).toBe('PUT');
      expect((await send(s.url, { method: s.method, headers: { ...s.headers }, body })).status).toBe(200);
      await expect(direct.confirmUpload({ bucket: 'reports', objectPath: path, contentType: 'application/pdf', byteSize: 1000, sha256: 'a'.repeat(64) }))
        .rejects.toMatchObject({ code: 'common.validation_failed' });
      await expect(direct.confirmUpload({ bucket: 'reports', objectPath: path, contentType: 'application/pdf', byteSize: 1000, sha256: sha(body) }))
        .resolves.toMatchObject({ objectPath: path, scanState: 'pending' });
      expect(JSON.stringify(rec.lines)).not.toContain(TEST_SECRET);
    });
    it('a store outage surfaces as common.dependency_unavailable (not a raw error)', async () => {
      const rec = recorders();
      const storage = createStorage({ ...storageOpts({ connect: () => raw } as never, rec, 'reporting'), now } as never);
      fake.state.forceStatus = 500;
      const e = await storage.head('reports', `${TENANT_A}/x.pdf`).then(() => undefined, (x: unknown) => x);
      expect(e).toBeInstanceOf(LimsError); expect((e as LimsError).code).toBe('common.dependency_unavailable');
    });
  });
});

describe('adapter works with the real global fetch too (path style, default dependency)', () => {
  it('head() against the fake with no injected fetch', async () => {
    const clock = { t: Date.now() };
    const fake = await startFakeS3({ style: 'path', clock: () => clock.t });
    try {
      const cfg = parseStorageConfig({ STORAGE_PROVIDER: 's3_compatible', STORAGE_ENDPOINT: `http://127.0.0.1:${fake.port}`, STORAGE_REGION: TEST_REGION, STORAGE_BUCKET: TEST_BUCKET, STORAGE_ACCESS_KEY_ID: TEST_ACCESS_KEY_ID, STORAGE_SECRET_ACCESS_KEY: TEST_SECRET, STORAGE_FORCE_PATH_STYLE: 'true' });
      if (cfg.provider !== 's3_compatible') throw new Error('setup');
      const raw = createS3RawStorage(cfg, { now: () => clock.t });
      await raw.put('reports', `${TENANT_A}/g.pdf`, bytesOf(10), { contentType: 'application/pdf' });
      expect((await raw.head!('reports', `${TENANT_A}/g.pdf`))?.byteSize).toBe(10);
    } finally { await fake.close(); }
  });
});
