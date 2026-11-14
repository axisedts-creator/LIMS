// ctx.storage.* (03-IC §13.4, §13.6; 08 R12b, A13 P-2/P-12/P-13). The only reader of the Storage service credential
// (LIMS_CORE_STORAGE_KEY_FILE [CONV], 07-SECURITY §6). Tenant-bound and module-bound: first path segment = tenantId,
// writes (put/move/delete) only in the module's own buckets. Raw failures surface as LimsError with the code only.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
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
}
export interface StorageAdapter {
  put(bucket: BucketName, objectPath: string, bytes: Uint8Array, opts: { contentType: string; ifAbsent?: boolean }): Promise<{ sha256: string; byteSize: number }>;
  read(bucket: BucketName, objectPath: string): Promise<Uint8Array>;
  move(bucket: BucketName, fromPath: string, toPath: string): Promise<void>;
  signedUrl(bucket: BucketName, objectPath: string, ttlSeconds: number): Promise<string>;
  delete(bucket: BucketName, objectPath: string): Promise<void>;
}
type LogFn = (obj: object, msg?: string) => void;
export interface StorageOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly readFile?: (path: string) => string;
  /** Builds the raw client. Required until the Storage HTTP API shape is pinned (SP-1; .orchestra/cr/T0D-17.nonblocking.md). */
  readonly connect?: (credential: string, url?: string) => RawStorage;
  readonly url?: string;
  readonly module: string;
  readonly tenantId: string;
  readonly log?: { warn: LogFn };
  readonly metrics?: { inc(name: 'lims_core_storage_deletes_total', labels: { bucket: string; reason: string }): void };
}

const TENANT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,254}$/;   // no '', '.', '..', '%', '\', NUL, spaces
/** [CONV] delete() carries no reason in 03-IC §13.6; one fixed label value until the catalog adds one (CR T0D-17). */
const DELETE_REASON = 'unspecified';
const internal = (): LimsError => new LimsError('common.internal');

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

export function createStorage(o: StorageOptions): StorageAdapter {
  const env = o.env ?? process.env;
  const { module, tenantId } = o;
  if (typeof tenantId !== 'string' || !TENANT.test(tenantId) || typeof module !== 'string') throw internal();
  const file = env.LIMS_CORE_STORAGE_KEY_FILE;
  if (!file) throw internal();
  let credential: string;
  try { credential = (o.readFile ?? ((p: string) => readFileSync(p, 'utf8')))(file).trim(); } catch { throw internal(); }
  if (!credential || !o.connect) throw internal();
  const raw = o.connect(credential, o.url);

  async function call<T>(op: string, bucket: string, fn: () => Promise<T>): Promise<T> {
    try { return await fn(); } catch {
      // Raw error text is dropped: it may carry the credential, a signed URL or the path.
      o.log?.warn({ event: 'storage_failed', op, bucket }, 'storage_failed');
      throw new LimsError('common.dependency_unavailable');
    }
  }

  return {
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
    async move(bucket, fromPath, toPath) {
      assertOwned(module, bucket); assertTenantPath(tenantId, fromPath); assertTenantPath(tenantId, toPath);
      await call('move', bucket, () => raw.move(bucket, fromPath, toPath));
    },
    async signedUrl(bucket, objectPath, ttlSeconds) {
      // P-2: internal only; the URL is never logged here and must never reach a response.
      assertBucket(bucket); assertTenantPath(tenantId, objectPath);
      if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 300) throw internal();
      return call('sign', bucket, () => raw.sign(bucket, objectPath, ttlSeconds));
    },
    async delete(bucket, objectPath) {
      assertOwned(module, bucket); assertTenantPath(tenantId, objectPath);
      await call('delete', bucket, () => raw.remove(bucket, objectPath));
      o.metrics?.inc('lims_core_storage_deletes_total', { bucket, reason: DELETE_REASON });
    },
  };
}
