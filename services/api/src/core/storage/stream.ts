// T0B-FILESTREAM-1 (LD-312): one answer for every file download that passes through the API. The object is sent as a stream (never read whole),
// with Content-Length, the validators the storage gives (ETag / Last-Modified, never invented), conditional requests (304), single byte ranges
// (206 / 416, RFC 9110 §14 and §13) and the cache header (default `no-store`; staff lists may ask for `private, max-age=N`, N 1..3600).
// No scan gate and no access log here: the caller passes `onServe`, called once before the first byte for 200 / 206 / 304 (never for 416);
// if it fails, the opened body is destroyed and no byte is produced. Storages that only have read() (old fakes) get the same answer over bytes.
import type { Readable } from 'node:stream';
import { LimsError } from '../errors.js';
import type { BucketName, StorageAdapter } from './index.js';

export type CachePolicy = 'no-store' | { readonly privateMaxAgeSeconds: number };
export type RequestHeaders = Readonly<Record<string, string | readonly string[] | undefined>>;
export interface StoredMeta { readonly size: number; readonly etag?: string; readonly lastModified?: Date }
export interface Opened extends StoredMeta { readonly body: Readable | Uint8Array }
export interface StreamResponse {
  readonly status: 200 | 206 | 304 | 416;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Readable | Uint8Array | undefined;
}
type Range = { start: number; end: number };

export function cacheControl(cache: CachePolicy | undefined): string {
  if (cache === undefined || cache === 'no-store') return 'no-store';
  const n = (cache as { privateMaxAgeSeconds?: unknown })?.privateMaxAgeSeconds;
  if (!Number.isInteger(n) || (n as number) < 1 || (n as number) > 3600) throw new LimsError('common.internal');
  return `private, max-age=${n}`;
}

const one = (h: RequestHeaders | undefined, name: string): string | undefined => {
  const v = h?.[name];
  return typeof v === 'string' ? v : Array.isArray(v) ? v.join(', ') : undefined;
};
const seconds = (d: Date): number => Math.floor(d.getTime() / 1000);
const opaque = (t: string): string => t.trim().replace(/^W\//, '');

/** Single `bytes=` range against `size`. undefined = ignore the header (absent, malformed, multi range); 'unsatisfiable' = 416. */
export function parseRange(header: string | undefined, size: number): Range | 'unsatisfiable' | undefined {
  const m = header === undefined ? null : /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return undefined;
  if (m[1] === '') {                                                   // suffix: the last N bytes
    const n = Number(m[2]);
    return n === 0 || size === 0 ? 'unsatisfiable' : { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(m[1]);
  if (m[2] !== '' && Number(m[2]) < start) return undefined;           // invalid range-spec: ignored (RFC 9110 §14.2)
  if (start >= size) return 'unsatisfiable';
  return { start, end: m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1) };
}

/** RFC 9110 §13.1.2 / §13.1.3: If-None-Match (weak comparison) wins over If-Modified-Since. */
function notModified(h: RequestHeaders | undefined, m: StoredMeta): boolean {
  const inm = one(h, 'if-none-match');
  if (inm !== undefined) return inm.trim() === '*' || (m.etag !== undefined && inm.split(',').some((t) => opaque(t) === opaque(m.etag!)));
  const ims = one(h, 'if-modified-since');
  const since = ims === undefined ? NaN : Date.parse(ims);
  return m.lastModified !== undefined && Number.isFinite(since) && seconds(m.lastModified) <= Math.floor(since / 1000);
}

/** RFC 9110 §13.1.5: a strong ETag equal to the current one, or the exact Last-Modified date. A weak ETag never matches. */
function ifRangeHolds(h: RequestHeaders | undefined, m: StoredMeta): boolean {
  const v = one(h, 'if-range')?.trim();
  if (v === undefined) return true;
  if (v.startsWith('"')) return m.etag !== undefined && !m.etag.startsWith('W/') && v === m.etag;
  if (v.startsWith('W/')) return false;
  const d = Date.parse(v);
  return m.lastModified !== undefined && Number.isFinite(d) && Math.floor(d / 1000) === seconds(m.lastModified);
}

const destroy = (b: Opened['body'] | undefined): void => { if (b && typeof (b as Readable).destroy === 'function') (b as Readable).destroy(); };

/** The core answer over any source. `meta` (when the caller already knows size / validators) avoids opening the whole object before a range. */
export async function respond(o: {
  open(range?: Range): Promise<Opened>;
  meta?: StoredMeta;
  headers: Readonly<Record<string, string>>;
  cache?: CachePolicy;
  requestHeaders?: RequestHeaders;
  onServe?: () => Promise<unknown>;
}): Promise<StreamResponse> {
  const cc = cacheControl(o.cache);
  const rh = o.requestHeaders;
  // ponytail: without `meta` the whole object is opened first (its validators decide 304 / range), then dropped unread and reopened for a range.
  let opened: Opened | undefined = o.meta ? undefined : await o.open();
  const meta: StoredMeta = o.meta ?? opened!;
  const base: Record<string, string> = { ...o.headers, 'cache-control': cc };
  if (meta.etag !== undefined) base['etag'] = meta.etag;
  if (meta.lastModified !== undefined) base['last-modified'] = meta.lastModified.toUTCString();
  const serve = async (r: StreamResponse): Promise<StreamResponse> => {
    try { await o.onServe?.(); } catch (e) { destroy(r.body); throw e; }
    return r;
  };

  if (notModified(rh, meta)) { destroy(opened?.body); return serve({ status: 304, headers: base, body: undefined }); }

  const range = ifRangeHolds(rh, meta) ? parseRange(one(rh, 'range'), meta.size) : undefined;
  if (range === 'unsatisfiable') {
    destroy(opened?.body);
    return { status: 416, headers: { ...base, 'content-range': `bytes */${meta.size}` }, body: undefined };
  }
  const headers = { ...base, 'accept-ranges': 'bytes' };
  if (range === undefined) {
    opened ??= await o.open();
    return serve({ status: 200, headers: { ...headers, 'content-length': String(meta.size) }, body: opened.body });
  }
  let body: Opened['body'];
  if (opened?.body instanceof Uint8Array) body = opened.body.subarray(range.start, range.end + 1);
  else { destroy(opened?.body); body = (await o.open(range)).body; }
  return serve({ status: 206, headers: { ...headers, 'content-range': `bytes ${range.start}-${range.end}/${meta.size}`, 'content-length': String(range.end - range.start + 1) }, body });
}

/** Storage source for respond(): readStream when the adapter can stream, else the old whole read() (fakes). Tenant / bucket rules are the adapter's. */
export function storageSource(storage: Partial<Pick<StorageAdapter, 'read' | 'readStream' | 'canStream'>>, bucket: BucketName, objectPath: string): (range?: Range) => Promise<Opened> {
  if (typeof storage.readStream === 'function' && storage.canStream !== false) {
    return async (range) => { const r = await storage.readStream!(bucket, objectPath, range ? { range } : {}); return { body: r.body, size: r.byteSize, ...(r.etag !== undefined ? { etag: r.etag } : {}), ...(r.lastModified !== undefined ? { lastModified: r.lastModified } : {}) }; };
  }
  return async () => { const bytes = await storage.read!(bucket, objectPath); return { body: bytes, size: bytes.length }; };
}

/** Reports, prints, portal: stream a stored object with the caller's fixed headers. */
export function streamStored(storage: Partial<Pick<StorageAdapter, 'read' | 'readStream'>>, o: {
  bucket: BucketName; objectPath: string; headers: Readonly<Record<string, string>>;
  cache?: CachePolicy; requestHeaders?: RequestHeaders; onServe?: () => Promise<unknown>;
}): Promise<StreamResponse> {
  return respond({ open: storageSource(storage, o.bucket, o.objectPath), headers: o.headers,
    ...(o.cache !== undefined ? { cache: o.cache } : {}), ...(o.requestHeaders ? { requestHeaders: o.requestHeaders } : {}), ...(o.onServe ? { onServe: o.onServe } : {}) });
}
