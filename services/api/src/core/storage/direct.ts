// T0B-FILES-1 (LD-310; founder request 2026-11-17 04:54 NPT "upload and download speed should be fast").
// Direct browser <-> storage transfer for files above 256 KiB: the API checks, then signs a short lived URL (<= 300 s) and never
// sees the bytes. Upload: policy + size + type + sha256 are bound into the signature (create-only); the caller records the row only
// after confirmUpload() sees the object in storage. Download: scan gate + tenant rule first, storage sets Content-Disposition,
// Cache-Control and serves ranges; the access-log row is written once, after signing succeeded.
// Small files (<= 256 KiB) stay on the existing proxy path (ctx.uploads.accept / ctx.download.stream): one round trip is faster.
import { LimsError } from '../errors.js';
import type { AccessLogEntry } from '../audit/access.js';
import { BY_EXT, MAX_BYTES, type UploadMime } from '../uploads/index.js';
import { contentDisposition, MIME } from './download.js';
import { assertBucket, assertOwned, assertTenantPath, type BucketName, type SignedUpload, type StorageAdapter } from './index.js';

export const DIRECT_THRESHOLD_BYTES = 256 * 1024;
export const MAX_URL_TTL_SECONDS = 300;
/** [CONV] lead pick: resumable protocol requested above 8 MiB (only used when the provider supports it). */
export const RESUMABLE_THRESHOLD_BYTES = 8 * 1024 * 1024;
const CACHE = { 'patient-report': 'private, no-store, max-age=0', 'versioned-static': 'public, max-age=31536000, immutable' } as const;
const SHA256 = /^[0-9a-f]{64}$/;
const MIMES = new Set<string>(Object.values(BY_EXT));

export interface UploadPolicy { readonly allow: readonly UploadMime[]; readonly maxBytes: number }
export interface InitUploadInput { readonly bucket: BucketName; readonly objectPath: string; readonly filename: string; readonly contentType: string; readonly byteSize: number; readonly sha256: string }
export interface ConfirmUploadInput { readonly bucket: BucketName; readonly objectPath: string; readonly contentType: string; readonly byteSize: number; readonly sha256: string }
export interface InitDownloadInput {
  readonly bucket: BucketName; readonly objectPath: string; readonly filename: string; readonly contentType: string; readonly byteSize: number;
  readonly kind: 'patient-report' | 'versioned-static';
  /** Required for patient-report: only 'clean' is served. */
  readonly scanState?: unknown;
  readonly access?: AccessLogEntry;
}

const err = (code: string) => new LimsError(code as never);
const sizeOk = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0;

export function createDirectTransfer(o: {
  storage: Pick<StorageAdapter, 'module' | 'tenantId' | 'signedUploadUrl' | 'signedDownloadUrl' | 'head' | 'delete'>;
  audit?: { access(entry: AccessLogEntry): Promise<unknown> };
  now?: () => number;
  log?: unknown;
}) {
  return {
    async initUpload(i: InitUploadInput, policy: UploadPolicy): Promise<{ mode: 'proxy' | 'direct'; objectPath: string; upload?: SignedUpload }> {
      // Programming errors in the caller -> 500, nothing signed.
      if (!Array.isArray(policy?.allow) || policy.allow.length === 0 || !policy.allow.every((m) => MIMES.has(m))
        || !Number.isInteger(policy.maxBytes) || policy.maxBytes < 1 || policy.maxBytes > MAX_BYTES) throw err('common.internal');
      assertOwned(o.storage.module, i?.bucket); assertTenantPath(o.storage.tenantId, i.objectPath);
      // Size echo + checksum are mandatory (the signature binds them).
      if (!sizeOk(i.byteSize) || typeof i.sha256 !== 'string' || !SHA256.test(i.sha256)) throw err('common.validation_failed');
      if (i.byteSize > policy.maxBytes) throw err('common.payload_too_large');
      // Declared type decides (exact, lower case, no parameters); the extension must agree.
      const base = typeof i.filename === 'string' ? (i.filename.split(/[\\/]/).pop() ?? '') : '';
      const dot = base.lastIndexOf('.');
      const byExt = dot > 0 ? BY_EXT[base.slice(dot + 1).toLowerCase()] : undefined;
      if (typeof i.contentType !== 'string' || !(policy.allow as readonly string[]).includes(i.contentType) || byExt !== i.contentType) throw err('common.unsupported_media_type');
      if (i.byteSize <= DIRECT_THRESHOLD_BYTES) {
        return { mode: 'proxy', objectPath: i.objectPath };
      }
      // The adapter re-checks bucket, tenant and ttl; the client filename never reaches it.
      const upload = await o.storage.signedUploadUrl(i.bucket, i.objectPath, {
        ttlSeconds: MAX_URL_TTL_SECONDS, contentType: i.contentType, byteSize: i.byteSize, sha256: i.sha256,
        ...(i.byteSize > RESUMABLE_THRESHOLD_BYTES ? { resumable: true } : {}),
      });
      return { mode: 'direct', objectPath: i.objectPath, upload };
    },

    /** Resolve before recording the row: storage must hold exactly what was signed. A wrong object is deleted. */
    async confirmUpload(i: ConfirmUploadInput): Promise<{ objectPath: string; byteSize: number; sha256: string; contentType: string; scanState: 'pending' }> {
      assertOwned(o.storage.module, i?.bucket); assertTenantPath(o.storage.tenantId, i.objectPath);
      if (!sizeOk(i.byteSize) || typeof i.sha256 !== 'string' || !SHA256.test(i.sha256) || typeof i.contentType !== 'string') throw err('common.validation_failed');
      const got = await o.storage.head(i.bucket, i.objectPath);
      if (!got) throw err('common.not_found');
      if (got.byteSize !== i.byteSize || got.contentType !== i.contentType || (got.sha256 !== undefined && got.sha256 !== i.sha256)) {
        await o.storage.delete(i.bucket, i.objectPath);
        throw err('common.validation_failed');
      }
      return { objectPath: i.objectPath, byteSize: i.byteSize, sha256: i.sha256, contentType: i.contentType, scanState: 'pending' };
    },

    async initDownload(i: InitDownloadInput): Promise<{ mode: 'proxy' | 'direct'; url?: string; expiresAt?: string; acceptRanges?: true }> {
      assertBucket(i?.bucket); assertTenantPath(o.storage.tenantId, i.objectPath);
      if (i.kind !== 'patient-report' && i.kind !== 'versioned-static') throw err('common.internal');
      if (typeof i.contentType !== 'string' || !MIME.test(i.contentType) || typeof i.filename !== 'string' || !Number.isInteger(i.byteSize) || i.byteSize < 0) throw err('common.internal');
      const report = i.kind === 'patient-report';
      if (report && i.scanState !== 'clean') throw err('common.upload_quarantined');
      if (report && (!i.access || !o.audit)) throw err('common.internal');
      if (i.byteSize <= DIRECT_THRESHOLD_BYTES) return { mode: 'proxy' };
      const signed = await o.storage.signedDownloadUrl(i.bucket, i.objectPath, {
        ttlSeconds: MAX_URL_TTL_SECONDS, disposition: contentDisposition('attachment', i.filename), cacheControl: CACHE[i.kind], contentType: i.contentType,
      });
      if (report) await o.audit!.access(i.access!);
      return { mode: 'direct', url: signed.url, expiresAt: signed.expiresAt, acceptRanges: true };
    },
  };
}
