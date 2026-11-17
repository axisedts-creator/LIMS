// T0B-FILES-1 test fake: a storage PROVIDER that verifies what it was asked to sign (synthetic data only).
// It models the contract the API must rely on: a signed URL binds bucket, key, method, expiry, content type, length and sha256;
// the provider (never the API) receives the bytes; ranges are served by the provider. Raw methods the adapter must call:
//   signUpload(bucket, key, { ttlSeconds, contentType, byteSize, sha256, ifAbsent, resumable }) -> { url, method, headers, resumable }
//   signDownload(bucket, key, { ttlSeconds, disposition, cacheControl, contentType, acceptRanges }) -> { url }
//   head(bucket, key) -> { byteSize, contentType, sha256? } | undefined
import { createHash } from 'node:crypto';
import { fakeRaw } from './helpers.js';

export const clock = (start = Date.parse('2026-11-17T06:00:00Z')) => {
  const c = { t: start };
  return { c, now: () => c.t, advance: (s: number) => { c.t += s * 1000; } };
};

export function fakeProvider(now: () => number, opts: { resumable?: boolean } = {}) {
  const base = fakeRaw();
  const grants = new Map<string, any>();        // url -> what the API asked the provider to sign
  const signCalls: any[] = [];
  const objects = base.objects;
  let n = 0;
  const raw = {
    ...base.raw,
    async signUpload(bucket: string, key: string, o: any) {
      base.calls.push('signUpload'); signCalls.push({ op: 'upload', bucket, key, ...o });
      const url = `https://storage.invalid/up/${++n}?sig=S${n}`;
      grants.set(url, { kind: 'upload', bucket, key, ...o, exp: now() + o.ttlSeconds * 1000 });
      return { url, method: 'PUT', headers: { 'content-type': o.contentType }, resumable: !!(opts.resumable && o.resumable) };
    },
    async signDownload(bucket: string, key: string, o: any) {
      base.calls.push('signDownload'); signCalls.push({ op: 'download', bucket, key, ...o });
      const url = `https://storage.invalid/dl/${++n}?sig=S${n}`;
      grants.set(url, { kind: 'download', bucket, key, ...o, exp: now() + o.ttlSeconds * 1000 });
      return { url };
    },
    async head(bucket: string, key: string) {
      base.calls.push('head');
      const o = objects.get(`${bucket}|${key}`);
      return o ? { byteSize: o.bytes.length, contentType: o.contentType, sha256: createHash('sha256').update(o.bytes).digest('hex') } : undefined;
    },
  };
  const grantOf = (url: string) => grants.get(url);   // exact URL: a tampered URL is unknown
  /** What the BROWSER does: talk to the provider only. The API object is never involved. */
  const browser = {
    put(url: string, bytes: Uint8Array, h: { contentType: string }): { status: number } {
      const g = grantOf(url);
      if (!g || g.kind !== 'upload') return { status: 403 };                       // tampered / unknown signature
      if (now() > g.exp) return { status: 403 };                                   // expired
      if (h.contentType !== g.contentType || bytes.length !== g.byteSize) return { status: 403 };
      if (createHash('sha256').update(bytes).digest('hex') !== g.sha256) return { status: 403 };
      if (g.ifAbsent && objects.has(`${g.bucket}|${g.key}`)) return { status: 412 };
      objects.set(`${g.bucket}|${g.key}`, { bytes: Buffer.from(bytes), contentType: g.contentType });
      return { status: 200 };
    },
    get(url: string, range?: string): { status: number; headers: Record<string, string>; body?: Uint8Array } {
      const g = grantOf(url);
      if (!g || g.kind !== 'download' || now() > g.exp) return { status: 403, headers: {} };
      const o = objects.get(`${g.bucket}|${g.key}`);
      if (!o) return { status: 404, headers: {} };
      const headers: Record<string, string> = { 'content-type': g.contentType, 'content-disposition': g.disposition, 'cache-control': g.cacheControl, 'accept-ranges': 'bytes' };
      const m = range ? /^bytes=(\d+)-(\d+)$/.exec(range) : null;
      if (m) {
        const a = Number(m[1]); const b = Math.min(Number(m[2]), o.bytes.length - 1);
        return { status: 206, headers: { ...headers, 'content-range': `bytes ${a}-${b}/${o.bytes.length}` }, body: new Uint8Array(o.bytes.subarray(a, b + 1)) };
      }
      return { status: 200, headers, body: new Uint8Array(o.bytes) };
    },
  };
  return { ...base, raw, connect: (c: string) => { base.credentials.push(c); return raw; }, grants, signCalls, browser };
}

export const bytesOf = (n: number, fill = 0x61): Uint8Array => new Uint8Array(n).fill(fill);
export const digest = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
/** PDF-looking body of exactly `n` bytes (header + padding). */
export const pdfOf = (n: number): Uint8Array => { const b = bytesOf(n, 0x20); b.set(Buffer.from('%PDF-1.7\n')); return b; };
