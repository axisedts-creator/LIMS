// ctx.storage.* (03-IC §13.4, §13.6; 08 R12b, A13 P-2/P-12/P-13). The only reader of the Storage service credential
// (LIMS_CORE_STORAGE_KEY_FILE [CONV], 07-SECURITY §6). Tenant-bound and module-bound: first path segment = tenantId,
// writes (put/move/delete) only in the module's own buckets. Raw failures surface as LimsError with the code only.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { LimsError } from '../errors.js';

export type BucketName = 'reports' | 'reporting-inputs' | 'reporting-prints' | 'identity-assets' | 'identity-exports'
  | 'frontdesk-trf' | 'billing-exports' | 'instruments-attachments' | 'micro-imports' | 'anatomic-images' | 'partners-slips';

/** 03-IC §13.4 bucket -> owner module (`reporting-legacy` is reserved: refused). */
export const BUCKET_OWNERS: Readonly<Record<BucketName, string>> = Object.freeze({
  reports: 'reporting', 'reporting-inputs': 'reporting', 'reporting-prints': 'reporting',
  'identity-assets': 'identity', 'identity-exports': 'identity', 'frontdesk-trf': 'frontdesk',
  'billing-exports': 'billing', 'instruments-attachments': 'instruments', 'micro-imports': 'micro',
  'anatomic-images': 'anatomic', 'partners-slips': 'partners',
});

/** Raw Storage client built from the credential. Its errors never leave this file (message may carry the credential/URL). */
export interface RawStorage {
  put(bucket: string, key: string, bytes: Uint8Array, o: { contentType: string; ifAbsent?: boolean }): Promise<void>;
  get(bucket: string, key: string): Promise<Uint8Array>;
  move(bucket: string, from: string, to: string): Promise<void>;
  remove(bucket: string, key: string): Promise<void>;
  sign(bucket: string, key: string, ttlSeconds: number): Promise<string>;
  /** T0B-FILES-1 (LD-310): the provider binds every constraint into the signature and refuses anything else (403/412). */
  signUpload?(bucket: string, key: string, o: { ttlSeconds: number; contentType: string; byteSize: number; sha256: string; ifAbsent: true; resumable: boolean }):
    Promise<{ url: string; method: string; headers?: Record<string, string>; resumable?: boolean }>;
  signDownload?(bucket: string, key: string, o: { ttlSeconds: number; disposition: string; cacheControl: string; contentType: string; acceptRanges: true }): Promise<{ url: string }>;
  head?(bucket: string, key: string): Promise<{ byteSize: number; contentType: string; sha256?: string; etag?: string; lastModified?: Date } | undefined>;
  /** T0B-FILESTREAM-1 (LD-312): the body unread; `size` = the WHOLE object; `range` inclusive. */
  getStream?(bucket: string, key: string, o?: { range?: { start: number; end: number } }):
    Promise<{ body: Readable | ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>; size: number; etag?: string; lastModified?: Date }>;
  /** T0B-FILESTREAM-1: the body is consumed as it is sent; a failure leaves no object. */
  putStream?(bucket: string, key: string, body: AsyncIterable<Uint8Array>, o: { contentType: string; ifAbsent?: boolean; byteSize?: number }): Promise<void>;
}
export type ByteSource = Readable | ReadableStream<Uint8Array> | AsyncIterable<Uint8Array> | Uint8Array;
export interface ReadStreamResult { readonly body: Readable; readonly byteSize: number; readonly etag?: string; readonly lastModified?: Date; readonly range?: { readonly start: number; readonly end: number } }
export interface SignedUpload { readonly url: string; readonly method: string; readonly headers: Readonly<Record<string, string>>; readonly resumable: boolean; readonly expiresAt: string }
export interface SignedDownload { readonly url: string; readonly expiresAt: string; readonly acceptRanges: true }
export interface StorageAdapter {
  /** The binding this adapter enforces (T0B-FILES-1: lets core helpers check before any storage call). */
  readonly module: string;
  readonly tenantId: string;
  put(bucket: BucketName, objectPath: string, bytes: Uint8Array, opts: { contentType: string; ifAbsent?: boolean }): Promise<{ sha256: string; byteSize: number }>;
  read(bucket: BucketName, objectPath: string): Promise<Uint8Array>;
  move(bucket: BucketName, fromPath: string, toPath: string): Promise<void>;
  signedUrl(bucket: BucketName, objectPath: string, ttlSeconds: number): Promise<string>;
  delete(bucket: BucketName, objectPath: string): Promise<void>;
  /** T0B-FILES-1: create-only upload URL bound to type, exact size and sha256 (owned bucket, tenant path, ttl 1..300). Never logged. */
  signedUploadUrl(bucket: BucketName, objectPath: string, o: { ttlSeconds: number; contentType: string; byteSize: number; sha256: string; resumable?: boolean }): Promise<SignedUpload>;
  /** T0B-FILES-1: download URL; storage sets Content-Disposition / Cache-Control / Content-Type and serves ranges (P-13: any bucket). */
  signedDownloadUrl(bucket: BucketName, objectPath: string, o: { ttlSeconds: number; disposition: string; cacheControl: string; contentType: string }): Promise<SignedDownload>;
  /** Object metadata as stored; undefined when absent. */
  head(bucket: BucketName, objectPath: string): Promise<{ byteSize: number; contentType: string; sha256?: string } | undefined>;
  /** T0B-FILESTREAM-1: read() as a stream (P-13: any bucket, tenant path). Errors in the body are replaced by common.dependency_unavailable. */
  readStream(bucket: BucketName, objectPath: string, o?: { range?: { start: number; end: number } }): Promise<ReadStreamResult>;
  /** True when the raw client streams (getStream); downloads use readStream only then, else the old whole read() answer (raw fakes without streaming). */
  readonly canStream: boolean;
  /** T0B-FILESTREAM-1: put() from a stream; sha256 and size computed on the way; over maxBytes = 413 and nothing stored. */
  putStream(bucket: BucketName, objectPath: string, source: ByteSource, opts: { contentType: string; ifAbsent?: boolean; maxBytes?: number }): Promise<{ sha256: string; byteSize: number }>;
}
type LogFn = (obj: object, msg?: string) => void;
export interface StorageOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly readFile?: (path: string) => string;
  /** Builds the raw client. Required until the Storage HTTP API shape is pinned (SP-1; .orchestra/cr/T0D-17.nonblocking.md). */
  readonly connect?: (credential: string, url?: string) => RawStorage;
  /** A raw client that is already built (boot: createS3RawStorage from the STORAGE_* config, T0B-STORAGE-1). Its credential was read
   *  and checked there, so no key file is read here; the tenant and bucket-owner rules below apply unchanged. */
  readonly raw?: RawStorage;
  readonly url?: string;
  readonly module: string;
  readonly tenantId: string;
  readonly log?: { warn: LogFn };
  readonly metrics?: { inc(name: 'lims_core_storage_deletes_total', labels: { bucket: string; reason: string }): void };
  /** Clock for signed URL expiry (tests). */
  readonly now?: () => number;
}

const TENANT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,254}$/;   // no '', '.', '..', '%', '\', NUL, spaces
/** [CONV] delete() carries no reason in 03-IC §13.6; one fixed label value until the catalog adds one (CR T0D-17). */
const DELETE_REASON = 'unspecified';
const internal = (): LimsError => new LimsError('common.internal');
const assertTtl = (t: unknown): void => { if (!Number.isInteger(t) || (t as number) < 1 || (t as number) > 300) throw internal(); };

export function assertBucket(bucket: unknown): asserts bucket is BucketName {
  if (typeof bucket !== 'string' || !Object.hasOwn(BUCKET_OWNERS, bucket)) throw internal();
}
/** Write rule (R26): owner bucket only. */
export function assertOwned(module: string, bucket: unknown): asserts bucket is BucketName {
  assertBucket(bucket);
  if (BUCKET_OWNERS[bucket] !== module) throw internal();
}
/** First path segment = tenantId; every further segment a plain name (no traversal, encoding or separators). */
export function assertTenantPath(tenantId: string, objectPath: unknown): asserts objectPath is string {
  if (typeof objectPath !== 'string' || objectPath.length > 1024) throw internal();
  const seg = objectPath.split('/');
  if (seg.length < 2 || seg[0] !== tenantId || !seg.slice(1).every((s) => SEGMENT.test(s))) throw internal();
}

/** Any byte source as an async iterable of chunks; undefined when it is none of them. */
export function iterableOf(src: unknown): AsyncIterable<Uint8Array> | undefined {
  if (src instanceof Uint8Array) return (async function* () { yield src; })();
  if (typeof (src as ReadableStream)?.getReader === 'function') return Readable.fromWeb(src as import('node:stream/web').ReadableStream<Uint8Array>);
  if (src !== null && typeof (src as AsyncIterable<Uint8Array>)?.[Symbol.asyncIterator] === 'function') return src as AsyncIterable<Uint8Array>;
  return undefined;
}
/** Stops a source nobody will read (a fetch body holds its socket until then). */
function release(src: AsyncIterable<Uint8Array>): void {
  const s = src as Partial<Readable> & { return?: () => unknown };
  try { if (typeof s.destroy === 'function') s.destroy(); else void (src as AsyncGenerator).return?.(undefined)?.catch?.(() => undefined); } catch { /* already closed */ }
}
/** T0B-FILESTREAM-1: a Readable over `src` that is read only on demand, replaces any source error by `onError()` (the raw text may carry a
 *  credential, a signed URL or a path), and stops the source when the client goes away (destroy before or during the read). */
export function guardedBody(src: AsyncIterable<Uint8Array>, onError: () => Error): Readable {
  let started = false;
  const body = Readable.from((async function* () {
    started = true;
    try { for await (const c of src) yield c; } catch { throw onError(); }
  })(), { objectMode: false });
  body.once('close', () => { if (!started) release(src); });
  return body;
}

export function createStorage(o: StorageOptions): StorageAdapter {
  const env = o.env ?? process.env;
  const { module, tenantId } = o;
  if (typeof tenantId !== 'string' || !TENANT.test(tenantId) || typeof module !== 'string') throw internal();
  const raw = o.raw ?? ((): RawStorage => {
    const file = env.LIMS_CORE_STORAGE_KEY_FILE;
    if (!file) throw internal();
    let credential: string;
    try { credential = (o.readFile ?? ((p: string) => readFileSync(p, 'utf8')))(file).trim(); } catch { throw internal(); }
    if (!credential || !o.connect) throw internal();
    return o.connect(credential, o.url);
  })();
  const now = o.now ?? Date.now;

  async function call<T>(op: string, bucket: string, fn: () => Promise<T>): Promise<T> {
    try { return await fn(); } catch {
      // Raw error text is dropped: it may carry the credential, a signed URL or the path.
      o.log?.warn({ event: 'storage_failed', op, bucket }, 'storage_failed');
      throw new LimsError('common.dependency_unavailable');
    }
  }

  return {
    module, tenantId, canStream: typeof raw.getStream === 'function',
    async put(bucket, objectPath, bytes, opts) {
      assertOwned(module, bucket); assertTenantPath(tenantId, objectPath);
      if (!(bytes instanceof Uint8Array) || typeof opts?.contentType !== 'string') throw internal();
      const put: { contentType: string; ifAbsent?: boolean } = { contentType: opts.contentType };
      if (opts.ifAbsent) put.ifAbsent = true;
      await call('put', bucket, () => raw.put(bucket, objectPath, bytes, put));
      return { sha256: createHash('sha256').update(bytes).digest('hex'), byteSize: bytes.length };
    },
    async read(bucket, objectPath) {
      // P-13: reads may target another module's bucket (pair received in the same flow); tenant rule still applies.
      assertBucket(bucket); assertTenantPath(tenantId, objectPath);
      return call('read', bucket, () => raw.get(bucket, objectPath));
    },
    async readStream(bucket, objectPath, ro) {
      assertBucket(bucket); assertTenantPath(tenantId, objectPath);
      const range = ro?.range;
      if (range !== undefined && !(Number.isInteger(range.start) && Number.isInteger(range.end) && range.start >= 0 && range.end >= range.start)) throw internal();
      const r: { body: unknown; size: number; etag?: string; lastModified?: Date } = await call('read', bucket, async () => {
        if (raw.getStream) return raw.getStream(bucket, objectPath, range ? { range } : {});
        const all = await raw.get(bucket, objectPath);   // raw clients without streaming (test fakes): same answer over the bytes
        return { body: range ? all.subarray(range.start, range.end + 1) : all, size: all.length };
      });
      const src = iterableOf(r.body);
      if (!src) { o.log?.warn({ event: 'storage_failed', op: 'read', bucket }, 'storage_failed'); throw new LimsError('common.dependency_unavailable'); }
      // The client sees a broken download, never a short good one.
      const body = guardedBody(src, () => { o.log?.warn({ event: 'storage_failed', op: 'read_body', bucket }, 'storage_failed'); return new LimsError('common.dependency_unavailable'); });
      return { body, byteSize: r.size, ...(r.etag !== undefined ? { etag: r.etag } : {}), ...(r.lastModified !== undefined ? { lastModified: new Date(r.lastModified) } : {}), ...(range ? { range: { start: range.start, end: range.end } } : {}) };
    },
    async putStream(bucket, objectPath, source, opts) {
      assertOwned(module, bucket); assertTenantPath(tenantId, objectPath);
      const max = opts?.maxBytes;
      if (typeof opts?.contentType !== 'string' || (max !== undefined && (!Number.isInteger(max) || max < 0))) throw internal();
      const src = iterableOf(source);
      if (!src) throw internal();
      const h = createHash('sha256'); let size = 0; let tooLarge = false;
      const counted = (async function* () {
        for await (const c of src) {
          size += c.length;
          if (max !== undefined && size > max) { tooLarge = true; throw new Error('over limit'); }   // stops reading the source here
          h.update(c); yield c;
        }
      })();
      const put: { contentType: string; ifAbsent?: boolean } = { contentType: opts.contentType };
      if (opts.ifAbsent) put.ifAbsent = true;
      try {
        if (raw.putStream) await raw.putStream(bucket, objectPath, counted, put);
        else { const parts: Uint8Array[] = []; for await (const c of counted) parts.push(c); await raw.put(bucket, objectPath, Buffer.concat(parts), put); }
      } catch {
        if (tooLarge) throw new LimsError('common.payload_too_large');
        o.log?.warn({ event: 'storage_failed', op: 'put', bucket }, 'storage_failed');
        throw new LimsError('common.dependency_unavailable');
      }
      return { sha256: h.digest('hex'), byteSize: size };
    },
    async move(bucket, fromPath, toPath) {
      assertOwned(module, bucket); assertTenantPath(tenantId, fromPath); assertTenantPath(tenantId, toPath);
      await call('move', bucket, () => raw.move(bucket, fromPath, toPath));
    },
    async signedUrl(bucket, objectPath, ttlSeconds) {
      // P-2: internal only; the URL is never logged here and must never reach a response.
      assertBucket(bucket); assertTenantPath(tenantId, objectPath);
      assertTtl(ttlSeconds);
      return call('sign', bucket, () => raw.sign(bucket, objectPath, ttlSeconds));
    },
    async signedUploadUrl(bucket, objectPath, u) {
      assertOwned(module, bucket); assertTenantPath(tenantId, objectPath); assertTtl(u?.ttlSeconds);
      if (typeof u.contentType !== 'string' || !Number.isInteger(u.byteSize) || u.byteSize < 1 || typeof u.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(u.sha256)) throw internal();
      const expiresAt = new Date(now() + u.ttlSeconds * 1000).toISOString();
      const r = await call('sign_upload', bucket, () => raw.signUpload!(bucket, objectPath,
        { ttlSeconds: u.ttlSeconds, contentType: u.contentType, byteSize: u.byteSize, sha256: u.sha256, ifAbsent: true, resumable: u.resumable === true }));
      return { url: r.url, method: r.method, headers: { ...r.headers }, resumable: r.resumable === true, expiresAt };
    },
    async signedDownloadUrl(bucket, objectPath, d) {
      assertBucket(bucket); assertTenantPath(tenantId, objectPath); assertTtl(d?.ttlSeconds);
      if (typeof d.disposition !== 'string' || /[\r\n]/.test(d.disposition) || typeof d.cacheControl !== 'string' || typeof d.contentType !== 'string') throw internal();
      const expiresAt = new Date(now() + d.ttlSeconds * 1000).toISOString();
      const r = await call('sign_download', bucket, () => raw.signDownload!(bucket, objectPath,
        { ttlSeconds: d.ttlSeconds, disposition: d.disposition, cacheControl: d.cacheControl, contentType: d.contentType, acceptRanges: true }));
      return { url: r.url, expiresAt, acceptRanges: true };
    },
    async head(bucket, objectPath) {
      assertBucket(bucket); assertTenantPath(tenantId, objectPath);
      return call('head', bucket, () => raw.head!(bucket, objectPath));
    },
    async delete(bucket, objectPath) {
      assertOwned(module, bucket); assertTenantPath(tenantId, objectPath);
      await call('delete', bucket, () => raw.remove(bucket, objectPath));
      o.metrics?.inc('lims_core_storage_deletes_total', { bucket, reason: DELETE_REASON });
    },
  };
}
