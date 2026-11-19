// T0B-FILES-1 (LD-310, founder request 2026-11-17 04:54 NPT: fast upload and download). Direct browser <-> storage transfer.
// Prescribed API (nothing exists yet; every test here fails first because storage/direct.ts and the adapter methods are missing):
//   createStorage({... , now?: () => number}) adds to StorageAdapter (storage/index.ts), RawStorage gains signUpload / signDownload / head:
//     signedUploadUrl(bucket, path, { ttlSeconds, contentType, byteSize, sha256, resumable? }) -> { url, method, headers, resumable, expiresAt }   (owned bucket + tenant path; ttl 1..300)
//     signedDownloadUrl(bucket, path, { ttlSeconds, disposition, cacheControl, contentType }) -> { url, expiresAt, acceptRanges: true }     (any bucket, tenant path; ttl 1..300)
//     head(bucket, path) -> { byteSize, contentType, sha256? } | undefined
//   storage/direct.ts: createDirectTransfer({ storage, audit?: { access(entry) }, now?, log? }) ->
//     initUpload({ bucket, objectPath, filename, contentType, byteSize, sha256 }, { allow, maxBytes }) -> { mode: 'proxy' | 'direct', objectPath, upload?: <signedUploadUrl result> }
//     confirmUpload({ bucket, objectPath, contentType, byteSize, sha256 }) -> { objectPath, byteSize, sha256, contentType, scanState: 'pending' }  (the caller records the row ONLY after this resolves)
//     initDownload({ bucket, objectPath, filename, contentType, byteSize, kind: 'patient-report' | 'versioned-static', scanState?, access? }) -> { mode: 'proxy' | 'direct', url?, expiresAt?, acceptRanges? }
//   Constants: DIRECT_THRESHOLD_BYTES = 256 KiB (direct only ABOVE it), MAX_URL_TTL_SECONDS = 300, RESUMABLE_THRESHOLD_BYTES = 8 MiB (lead pick: resumable is requested above it).
// Error codes reused from contracts/errors.yaml: payload_too_large 413, unsupported_media_type 415, validation_failed, not_found, upload_quarantined, dependency_unavailable, internal.
// Done-when items covered: (2) direct + short ttl + API never buffers, (3) size/type/checksum at signing + record only after confirm, (4) disposition, ranges, cache headers, (6) fake storage tests.
import { describe, expect, it, vi } from 'vitest';
import { LimsError } from '../../errors.js';
import { TENANT_A, TENANT_B, SIGNED, recorders, storageOpts } from './helpers.js';
import { bytesOf, clock, digest, fakeProvider, pdfOf } from './direct.helpers.js';

const KB = 1024, MB = 1024 * 1024;
const POLICY = { allow: ['application/pdf', 'image/png'] as const, maxBytes: 15 * MB };
const path = (n = 1, ext = 'pdf') => `${TENANT_A}/2026/11/0190a000-0000-7000-8000-00000000000${n}.${ext}`;
const ACCESS = { action: 'report.download', entityType: 'report', entityId: '0190a000-0000-7000-8000-000000000001', outcome: 'allowed' as const };
const code = async (p: Promise<unknown>): Promise<string> => { try { await p; } catch (e) { return e instanceof LimsError ? e.code : `non-LimsError:${String(e)}`; } return 'resolved'; };

async function setup(o: { module?: string; tenantId?: string; resumable?: boolean } = {}) {
  const clk = clock(); const prov = fakeProvider(clk.now, { resumable: o.resumable ?? true }); const r = recorders();
  const { createStorage } = await import('../index.js');
  const { createDirectTransfer, DIRECT_THRESHOLD_BYTES, MAX_URL_TTL_SECONDS, RESUMABLE_THRESHOLD_BYTES } = await import('../direct.js');
  const storage = createStorage({ ...storageOpts(prov, r, o.module ?? 'instruments', o.tenantId ?? TENANT_A), now: clk.now } as any);
  const audit = { access: vi.fn(async () => {}) };
  const direct = createDirectTransfer({ storage, audit, now: clk.now, log: r.log } as any);
  const put = (url: string, b: Uint8Array, contentType = 'application/pdf') => prov.browser.put(url, b, { contentType }).status;
  const init = (b: Uint8Array, extra: Record<string, unknown> = {}, p = path(), policy: any = POLICY) =>
    direct.initUpload({ bucket: 'instruments-attachments', objectPath: p, filename: 'scan.pdf', contentType: 'application/pdf', byteSize: b.length, sha256: digest(b), ...extra } as any, policy);
  return { clk, prov, r, storage, audit, direct, put, init, DIRECT_THRESHOLD_BYTES, MAX_URL_TTL_SECONDS, RESUMABLE_THRESHOLD_BYTES };
}

describe('constants (done_when 2)', () => {
  it('direct above 256 KiB, URL ttl at most 300 s', async () => {
    const s = await setup();
    expect(s.DIRECT_THRESHOLD_BYTES).toBe(256 * KB);
    expect(s.MAX_URL_TTL_SECONDS).toBeLessThanOrEqual(300);
    expect(s.RESUMABLE_THRESHOLD_BYTES).toBe(8 * MB);
  });
});

describe('initUpload: direct path for files over 256 KiB (done_when 2, 3)', () => {
  it('a 300 KiB PDF gets a direct signed URL; the API calls only signUpload, never put/get (it never receives the bytes)', async () => {
    const s = await setup(); const b = pdfOf(300 * KB);
    const res: any = await s.init(b);
    expect(res.mode).toBe('direct');
    expect(res.objectPath).toBe(path());
    expect(res.upload.url).toMatch(/^https:\/\/storage\.invalid\/up\//);
    expect(res.upload.method).toBe('PUT');
    expect(s.prov.calls).toEqual(['signUpload']);
    expect(s.prov.objects.size, 'nothing stored by the API').toBe(0);
  });
  it('256 KiB exactly stays on the proxy path (no signing); 256 KiB + 1 goes direct', async () => {
    const s = await setup();
    const small: any = await s.init(pdfOf(256 * KB));
    expect(small).toMatchObject({ mode: 'proxy', objectPath: path() });
    expect(small.upload).toBeUndefined();
    expect(s.prov.calls).not.toContain('signUpload');
    const big: any = await s.init(pdfOf(256 * KB + 1), {}, path(2));
    expect(big.mode).toBe('direct');
  });
  it('the signature binds ttl <= 300 s, content type, exact byte size, sha256, bucket, path and create-only (ifAbsent)', async () => {
    const s = await setup(); const b = pdfOf(400 * KB);
    const res: any = await s.init(b);
    const call = s.prov.signCalls.at(-1)!;
    expect(call).toMatchObject({ op: 'upload', bucket: 'instruments-attachments', key: path(), contentType: 'application/pdf', byteSize: b.length, sha256: digest(b), ifAbsent: true });
    expect(call.ttlSeconds).toBeGreaterThanOrEqual(1);
    expect(call.ttlSeconds).toBeLessThanOrEqual(300);
    expect(Date.parse(res.upload.expiresAt) - s.clk.now()).toBeLessThanOrEqual(300 * 1000);
    expect(Date.parse(res.upload.expiresAt)).toBeGreaterThan(s.clk.now());
  });
  it('the browser can upload straight to storage and confirm; the happy path ends with a pending scan', async () => {
    const s = await setup(); const b = pdfOf(500 * KB);
    const res: any = await s.init(b);
    expect(s.put(res.upload.url, b)).toBe(200);
    const done: any = await s.direct.confirmUpload({ bucket: 'instruments-attachments', objectPath: path(), contentType: 'application/pdf', byteSize: b.length, sha256: digest(b) });
    expect(done).toMatchObject({ objectPath: path(), byteSize: b.length, sha256: digest(b), contentType: 'application/pdf', scanState: 'pending' });
    expect(s.prov.calls.filter((c) => c === 'put' || c === 'get')).toEqual([]);
  });
  it('a declared 50 MiB file is signed without the API ever allocating or touching bytes (fake sees no put/get)', async () => {
    const s = await setup();
    const res: any = await s.direct.initUpload({ bucket: 'instruments-attachments', objectPath: path(), filename: 'big.pdf', contentType: 'application/pdf', byteSize: 15 * MB, sha256: 'a'.repeat(64) } as any, POLICY);
    expect(res.mode).toBe('direct');
    expect(s.prov.calls.every((c) => c === 'signUpload')).toBe(true);
  });
});

describe('initUpload: limits enforced at signing time (done_when 3)', () => {
  it('over the policy maximum -> common.payload_too_large, nothing signed', async () => {
    const s = await setup();
    expect(await code(s.init(pdfOf(300 * KB), { byteSize: 15 * MB + 1 }))).toBe('common.payload_too_large');
    expect(await code(s.init(pdfOf(300 * KB), { byteSize: 2 * MB }, path(), { ...POLICY, maxBytes: 1 * MB }))).toBe('common.payload_too_large');
    expect(s.prov.signCalls).toEqual([]);
  });
  it('wrong content type -> common.unsupported_media_type: html, octet-stream, a type with parameters, upper case, not in this policy', async () => {
    const s = await setup();
    for (const contentType of ['text/html', 'application/octet-stream', 'application/pdf; charset=utf-8', 'Application/PDF', 'image/jpeg', '', 'pdf']) {
      expect(await code(s.init(pdfOf(300 * KB), { contentType })), contentType).toBe('common.unsupported_media_type');
    }
    expect(s.prov.signCalls).toEqual([]);
  });
  it('a type that does not match the file extension is refused (declared type decides, extension must agree)', async () => {
    const s = await setup();
    expect(await code(s.init(pdfOf(300 * KB), { filename: 'run.html' }))).toBe('common.unsupported_media_type');
    expect(await code(s.init(pdfOf(300 * KB), { filename: 'noextension' }))).toBe('common.unsupported_media_type');
    expect(s.prov.signCalls).toEqual([]);
  });
  it('size echo and checksum are mandatory and well formed -> common.validation_failed', async () => {
    const s = await setup();
    for (const bad of [{ byteSize: 0 }, { byteSize: -1 }, { byteSize: 1.5 }, { byteSize: '300000' }, { byteSize: undefined }, { sha256: undefined }, { sha256: 'abc' }, { sha256: 'G'.repeat(64) }, { sha256: 'A'.repeat(64) }, { sha256: 'a'.repeat(65) }]) {
      expect(await code(s.init(pdfOf(300 * KB), bad)), JSON.stringify(bad)).toBe('common.validation_failed');
    }
    expect(s.prov.signCalls).toEqual([]);
  });
  it('programming errors: policy maximum above 15 MiB, empty allow list, bucket the module does not own, another tenant path -> common.internal', async () => {
    const s = await setup();
    expect(await code(s.init(pdfOf(300 * KB), {}, path(), { ...POLICY, maxBytes: 16 * MB }))).toBe('common.internal');
    expect(await code(s.init(pdfOf(300 * KB), {}, path(), { ...POLICY, allow: [] }))).toBe('common.internal');
    expect(await code(s.init(pdfOf(300 * KB), { bucket: 'reports' }))).toBe('common.internal');
    expect(await code(s.init(pdfOf(300 * KB), {}, `${TENANT_B}/2026/11/x.pdf`))).toBe('common.internal');
    expect(await code(s.init(pdfOf(300 * KB), {}, `${TENANT_A}/../${TENANT_B}/x.pdf`))).toBe('common.internal');
    expect(s.prov.signCalls).toEqual([]);
  });
  it('the client file name never reaches the key or the signed constraints', async () => {
    const s = await setup();
    await s.init(pdfOf(300 * KB), { filename: 'PATIENT-NAME-SENTINEL.pdf' });
    expect(JSON.stringify(s.prov.signCalls)).not.toContain('PATIENT-NAME-SENTINEL');
  });
});

describe('provider refuses expired and tampered URLs; confirm refuses wrong objects (done_when 6)', () => {
  it('an upload after the ttl is refused by storage (403), and a fresh URL can be obtained: re-signing before the object exists is allowed', async () => {
    const s = await setup(); const b = pdfOf(300 * KB);
    const a: any = await s.init(b);
    s.clk.advance(301);
    expect(s.put(a.upload.url, b)).toBe(403);
    const again: any = await s.init(b);
    expect(again.upload.url).not.toBe(a.upload.url);
    expect(s.put(again.upload.url, b)).toBe(200);
  });
  it('a tampered URL, or bytes that differ from the signed size, type or sha256, are refused by storage', async () => {
    const s = await setup(); const b = pdfOf(300 * KB);
    const a: any = await s.init(b);
    expect(s.put(a.upload.url + 'x', b)).toBe(403);
    expect(s.put(a.upload.url, pdfOf(300 * KB + 1))).toBe(403);
    expect(s.put(a.upload.url, bytesOf(300 * KB, 0x62))).toBe(403);
    expect(s.put(a.upload.url, b, 'text/html')).toBe(403);
    expect(s.prov.objects.size).toBe(0);
  });
  it('the URL is create-only: a second upload to the same key is refused (412), the stored object is not overwritten', async () => {
    const s = await setup(); const b = pdfOf(300 * KB);
    const a: any = await s.init(b);
    expect(s.put(a.upload.url, b)).toBe(200);
    const again: any = await s.init(b);
    expect(s.put(again.upload.url, b)).toBe(412);
  });
  it('confirmUpload with no object in storage -> common.not_found (the row must not be recorded)', async () => {
    const s = await setup(); const b = pdfOf(300 * KB);
    await s.init(b);
    expect(await code(s.direct.confirmUpload({ bucket: 'instruments-attachments', objectPath: path(), contentType: 'application/pdf', byteSize: b.length, sha256: digest(b) }))).toBe('common.not_found');
  });
  it('confirmUpload when storage holds something else (size, sha256 or type differ from the signing request) -> common.validation_failed AND the object is deleted', async () => {
    for (const mutate of ['size', 'sha', 'type'] as const) {
      const s = await setup(); const b = pdfOf(300 * KB);
      s.prov.objects.set(`instruments-attachments|${path()}`, { bytes: Buffer.from(mutate === 'size' ? pdfOf(300 * KB + 5) : mutate === 'sha' ? bytesOf(300 * KB, 0x62) : b), contentType: mutate === 'type' ? 'text/html' : 'application/pdf' });
      expect(await code(s.direct.confirmUpload({ bucket: 'instruments-attachments', objectPath: path(), contentType: 'application/pdf', byteSize: b.length, sha256: digest(b), unrecorded: true })), mutate).toBe('common.validation_failed');
      expect(s.prov.objects.has(`instruments-attachments|${path()}`), `${mutate}: wrong object removed`).toBe(false);
    }
  });
  // review item 1: without `unrecorded: true` the helper must never delete (a recorded attachment or report could be hit by a wrong sha256). LD-310 keeps data deletion with the founder.
  it('confirmUpload mismatch WITHOUT unrecorded:true -> common.validation_failed and the object is left in storage', async () => {
    for (const mutate of ['size', 'sha', 'type'] as const) {
      const s = await setup(); const b = pdfOf(300 * KB);
      s.prov.objects.set(`instruments-attachments|${path()}`, { bytes: Buffer.from(mutate === 'size' ? pdfOf(300 * KB + 5) : mutate === 'sha' ? bytesOf(300 * KB, 0x62) : b), contentType: mutate === 'type' ? 'text/html' : 'application/pdf' });
      expect(await code(s.direct.confirmUpload({ bucket: 'instruments-attachments', objectPath: path(), contentType: 'application/pdf', byteSize: b.length, sha256: digest(b) })), mutate).toBe('common.validation_failed');
      expect(s.prov.objects.has(`instruments-attachments|${path()}`), `${mutate}: object deleted without unrecorded`).toBe(true);
    }
  });
  it('confirmUpload for a path of another tenant or a bucket the module does not own -> common.internal, storage untouched', async () => {
    const s = await setup(); const b = pdfOf(300 * KB);
    expect(await code(s.direct.confirmUpload({ bucket: 'instruments-attachments', objectPath: `${TENANT_B}/x.pdf`, contentType: 'application/pdf', byteSize: b.length, sha256: digest(b) }))).toBe('common.internal');
    expect(await code(s.direct.confirmUpload({ bucket: 'reports', objectPath: path(), contentType: 'application/pdf', byteSize: b.length, sha256: digest(b) }))).toBe('common.internal');
    expect(s.prov.calls).not.toContain('head');
  });
  it('a storage outage while signing or confirming surfaces as common.dependency_unavailable with no URL, credential or path in logs', async () => {
    const s = await setup(); const b = pdfOf(300 * KB);
    s.prov.raw.signUpload = async () => { throw new Error(`boom ${SIGNED} CRED`); };
    s.prov.raw.head = async () => { throw new Error(`boom ${SIGNED} CRED`); };
    expect(await code(s.init(b))).toBe('common.dependency_unavailable');
    expect(await code(s.direct.confirmUpload({ bucket: 'instruments-attachments', objectPath: path(), contentType: 'application/pdf', byteSize: b.length, sha256: digest(b) }))).toBe('common.dependency_unavailable');
    expect(JSON.stringify(s.r.lines)).not.toMatch(/storage\.invalid|SENTINEL|CRED|token=/);
  });
});

describe('resumable uploads (done_when 5, API side)', () => {
  it('requested only above 8 MiB and only reported when the provider supports it', async () => {
    const s = await setup({ resumable: true });
    const small: any = await s.init(pdfOf(300 * KB));
    expect(small.upload.resumable).toBe(false);
    const big: any = await s.direct.initUpload({ bucket: 'instruments-attachments', objectPath: path(2), filename: 'b.pdf', contentType: 'application/pdf', byteSize: 9 * MB, sha256: 'a'.repeat(64) } as any, POLICY);
    expect(big.upload.resumable).toBe(true);
    expect(s.prov.signCalls.at(-1)!.resumable).toBe(true);
    expect(s.prov.signCalls[0]!.resumable).toBeFalsy();
    const none = await setup({ resumable: false });
    const noRes: any = await none.direct.initUpload({ bucket: 'instruments-attachments', objectPath: path(2), filename: 'b.pdf', contentType: 'application/pdf', byteSize: 9 * MB, sha256: 'a'.repeat(64) } as any, POLICY);
    expect(noRes.mode).toBe('direct');
    expect(noRes.upload.resumable).toBe(false);
  });
});

describe('initDownload (done_when 2, 4)', () => {
  async function withReport(size: number) {
    const s = await setup({ module: 'engagement' }); const b = pdfOf(size);
    s.prov.objects.set(`reports|${path()}`, { bytes: Buffer.from(b), contentType: 'application/pdf' });
    s.prov.calls.length = 0;
    const dl = (extra: Record<string, unknown> = {}) => s.direct.initDownload({ bucket: 'reports', objectPath: path(), filename: 'report-2.pdf', contentType: 'application/pdf', byteSize: b.length, kind: 'patient-report', scanState: 'clean', access: ACCESS, ...extra } as any);
    return { s, b, dl };
  }
  it('a report over 256 KiB is a direct signed URL: the API signs only and never reads the object', async () => {
    const { s, dl } = await withReport(600 * KB);
    const res: any = await dl();
    expect(res.mode).toBe('direct');
    expect(res.url).toMatch(/^https:\/\/storage\.invalid\/dl\//);
    expect(res.acceptRanges).toBe(true);
    expect(s.prov.calls).toEqual(['signDownload']);
    expect(Date.parse(res.expiresAt) - s.clk.now()).toBeLessThanOrEqual(300 * 1000);
    expect(s.prov.signCalls[0]!.ttlSeconds).toBeLessThanOrEqual(300);
  });
  it('256 KiB or less stays on the proxy path with no signing', async () => {
    const { s, dl } = await withReport(256 * KB);
    expect(((await dl()) as any).mode).toBe('proxy');
    expect(s.prov.calls).not.toContain('signDownload');
  });
  it('Content-Disposition is attachment with the RFC 6266 / 8187 filename, set by storage through the signature; no header injection', async () => {
    const { s, dl } = await withReport(600 * KB);
    const res: any = await dl({ filename: 'रिपोर्ट "x"\r\nSet-Cookie: a=1.pdf' });
    const g = s.prov.browser.get(res.url);
    const cd = g.headers['content-disposition']!;
    expect(cd).toMatch(/^attachment; filename="[\x20-\x7e]*"; filename\*=UTF-8''%E0%A4%B0/);
    expect(cd).not.toMatch(/[\r\n]/);
    expect(Object.keys(g.headers)).not.toContain('set-cookie');
    expect(g.headers['content-type']).toBe('application/pdf');
  });
  it('patient reports are cache private (never public, not shared-cacheable); the URL is still short-lived', async () => {
    const { s, dl } = await withReport(600 * KB);
    const res: any = await dl();
    const cc = s.prov.browser.get(res.url).headers['cache-control']!;
    expect(cc).toMatch(/(^|,\s*)private(\s*,|$)/);
    expect(cc).not.toMatch(/public|immutable|s-maxage/);
  });
  it('versioned static assets (kind versioned-static) are public, long lived and immutable; they need no scan state or access row', async () => {
    const { s, dl } = await withReport(600 * KB);
    const res: any = await dl({ kind: 'versioned-static', scanState: undefined, access: undefined });
    const cc = s.prov.browser.get(res.url).headers['cache-control']!;
    expect(cc).toMatch(/public/);
    expect(cc).toMatch(/max-age=31536000/);
    expect(cc).toMatch(/immutable/);
    expect(s.audit.access).not.toHaveBeenCalled();
  });
  it('range requests are served by storage through the signed URL (206 + Content-Range), so the browser can resume and seek', async () => {
    const { s, b, dl } = await withReport(600 * KB);
    const res: any = await dl();
    const part = s.prov.browser.get(res.url, 'bytes=0-9');
    expect(part.status).toBe(206);
    expect(part.headers['content-range']).toBe(`bytes 0-9/${b.length}`);
    expect(Buffer.from(part.body!).toString('latin1')).toBe(Buffer.from(b.subarray(0, 10)).toString('latin1'));
    expect(part.headers['accept-ranges']).toBe('bytes');
    expect(s.prov.signCalls[0]).not.toHaveProperty('range');
  });
  it('permission and tenant checks come first: a path in another tenant -> common.internal and nothing is signed or logged to the access trail', async () => {
    const { s, dl } = await withReport(600 * KB);
    expect(await code(Promise.resolve(dl({ objectPath: `${TENANT_B}/2026/11/x.pdf` })))).toBe('common.internal');
    expect(s.prov.signCalls).toEqual([]);
    expect(s.audit.access).not.toHaveBeenCalled();
  });
  it('only clean objects are served: pending, infected, unavailable, unknown -> common.upload_quarantined, no URL', async () => {
    const { s, dl } = await withReport(600 * KB);
    for (const scanState of ['pending', 'infected', 'unavailable', undefined, 'clean ']) {
      expect(await code(Promise.resolve(dl({ scanState }))), String(scanState)).toBe('common.upload_quarantined');
    }
    expect(s.prov.signCalls).toEqual([]);
    expect(s.audit.access).not.toHaveBeenCalled();
  });
  it('the access-log row is written once, when the URL is issued, and only after signing succeeded', async () => {
    const { s, dl } = await withReport(600 * KB);
    await dl();
    expect(s.audit.access).toHaveBeenCalledTimes(1);
    expect(s.audit.access).toHaveBeenCalledWith(ACCESS);
    const s2 = await withReport(600 * KB);
    s2.s.prov.raw.signDownload = async () => { throw new Error('down'); };
    expect(await code(Promise.resolve(s2.dl()))).toBe('common.dependency_unavailable');
    expect(s2.s.audit.access).not.toHaveBeenCalled();
  });
  it('an expired or tampered download URL is refused by storage', async () => {
    const { s, dl } = await withReport(600 * KB);
    const res: any = await dl();
    expect(s.prov.browser.get(res.url + 'x').status).toBe(403);
    s.clk.advance(301);
    expect(s.prov.browser.get(res.url).status).toBe(403);
  });
  it('the signed URL is never logged and never written to metrics', async () => {
    const { s, dl } = await withReport(600 * KB);
    const res: any = await dl();
    expect(JSON.stringify([s.r.lines, s.r.incs])).not.toContain(res.url);
    expect(JSON.stringify([s.r.lines, s.r.incs])).not.toMatch(/storage\.invalid/);
  });
});

describe('adapter signing limits (P-2 stays: ttl 1..300, tenant path, bucket rules)', () => {
  it('signedUploadUrl: ttl 0, 301 or non-integer, other tenant, non-owned bucket -> common.internal', async () => {
    const s = await setup(); const b = pdfOf(300 * KB);
    const o = { contentType: 'application/pdf', byteSize: b.length, sha256: digest(b) };
    const up = (bucket: string, p: string, ttlSeconds: number) => (s.storage as any).signedUploadUrl(bucket, p, { ...o, ttlSeconds });
    expect(await code(up('instruments-attachments', path(), 300))).toBe('resolved');
    for (const ttl of [0, 301, 1.5, NaN, -5]) expect(await code(up('instruments-attachments', path(), ttl)), String(ttl)).toBe('common.internal');
    expect(await code(up('instruments-attachments', `${TENANT_B}/x.pdf`, 60))).toBe('common.internal');
    expect(await code(up('reports', path(), 60))).toBe('common.internal');
  });
  it('signedDownloadUrl: ttl above 300 and other tenants refused; another module bucket is readable (P-13)', async () => {
    const s = await setup(); const o = { disposition: 'attachment; filename="a.pdf"', cacheControl: 'private, no-store', contentType: 'application/pdf' };
    const dl = (bucket: string, p: string, ttlSeconds: number) => (s.storage as any).signedDownloadUrl(bucket, p, { ...o, ttlSeconds });
    expect(await code(dl('reports', path(), 300))).toBe('resolved');
    expect(await code(dl('reports', path(), 301))).toBe('common.internal');
    expect(await code(dl('reports', `${TENANT_B}/x.pdf`, 60))).toBe('common.internal');
  });
});
