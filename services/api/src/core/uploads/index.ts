// ctx.uploads.accept + ctx.files.scan (03-IC §13.6; 08 R12b; 02-CV §10.2; REQ-SEC-083..085).
// Order (fail closed): options -> bucket owner + tenant path -> size (413) -> extension + declared mime + magic (415)
// -> image re-encode (422) -> scan (infected 422; unavailable/throw stored as scanState 'unavailable', 08 §4.13) -> put ifAbsent.
// The client filename only selects the expected type; it never reaches the stored key.
import { uuidv7 } from '../../../../../packages/shared-ts/src/uuidv7/index.js';
import { LimsError } from '../errors.js';
import { assertOwned, assertTenantPath, type BucketName, type StorageAdapter } from '../storage/index.js';
import { ImageRejected, reencodePng } from './image.js';
import type { ScanResult } from './scan.js';

export { createFiles, type ScanResult } from './scan.js';

export type UploadMime = 'application/pdf' | 'image/jpeg' | 'image/png' | 'text/csv'
  | 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
/** [CONV] not defined by 03-IC: what the multipart layer hands to accept(). */
export interface IncomingFile { readonly filename: string; readonly mimeType: string; readonly bytes: Uint8Array }
export interface UploadAcceptOptions {
  readonly allow: readonly UploadMime[]; readonly maxBytes: number;
  readonly bucket: BucketName; readonly objectPath: string;
  readonly images?: { readonly reencode: true; readonly stripMetadata: true; readonly maxMegapixels?: number };
  readonly scan: 'required' | 'not_applicable';
}
export interface AcceptedUpload {
  readonly objectId: string; readonly bucket: BucketName; readonly objectPath: string; readonly sha256: string; readonly byteSize: number;
  readonly mime: UploadMime; readonly image?: { readonly width: number; readonly height: number };
  readonly scanState: 'pending' | 'clean' | 'infected' | 'unavailable';
}

const MAX_BYTES = 15 * 1024 * 1024;   // 02-CV §10.2
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const BY_EXT: Readonly<Record<string, UploadMime>> = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', csv: 'text/csv', xlsx: XLSX };
const starts = (b: Uint8Array, sig: readonly number[]) => b.length >= sig.length && sig.every((v, i) => b[i] === v);
const utf8 = new TextDecoder('utf-8', { fatal: true });
const MAGIC: Readonly<Record<UploadMime, (b: Uint8Array) => boolean>> = {
  'application/pdf': (b) => starts(b, [0x25, 0x50, 0x44, 0x46, 0x2d]),                         // %PDF-
  'image/png': (b) => starts(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  'image/jpeg': (b) => starts(b, [0xff, 0xd8, 0xff]),
  [XLSX]: (b) => starts(b, [0x50, 0x4b, 0x03, 0x04]),                                             // ZIP local header
  'text/csv': (b) => { if (b.includes(0)) return false; try { utf8.decode(b); return true; } catch { return false; } },
};

export function createUploads(o: {
  files: { scan(bytes: Uint8Array): Promise<ScanResult> };
  storage: StorageAdapter; module: string; tenantId: string;
  log?: { warn(obj: object, msg?: string): void }; metrics?: unknown;
}) {
  const unsupported = () => new LimsError('common.unsupported_media_type');
  return {
    async accept(file: IncomingFile, opts: UploadAcceptOptions): Promise<AcceptedUpload> {
      // Programming errors in the calling module (bad options) -> 500.
      if (!Array.isArray(opts?.allow) || opts.allow.length === 0 || !opts.allow.every((m) => Object.hasOwn(MAGIC, m))
        || !Number.isInteger(opts.maxBytes) || opts.maxBytes < 1 || opts.maxBytes > MAX_BYTES
        || (opts.scan !== 'required' && opts.scan !== 'not_applicable')
        || (opts.images?.maxMegapixels !== undefined && !(opts.images.maxMegapixels > 0 && opts.images.maxMegapixels <= 40))) throw new LimsError('common.internal');
      assertOwned(o.module, opts.bucket); assertTenantPath(o.tenantId, opts.objectPath);
      const bytes = file?.bytes;
      if (!(bytes instanceof Uint8Array) || typeof file.filename !== 'string' || typeof file.mimeType !== 'string') throw unsupported();
      if (bytes.length > opts.maxBytes) throw new LimsError('common.payload_too_large');
      const base = file.filename.split(/[\\/]/).pop() ?? '';
      const dot = base.lastIndexOf('.');
      const mime = dot > 0 ? BY_EXT[base.slice(dot + 1).toLowerCase()] : undefined;
      if (!mime || bytes.length === 0 || !opts.allow.includes(mime) || file.mimeType.split(';')[0]!.trim().toLowerCase() !== mime || !MAGIC[mime](bytes)) throw unsupported();
      if (opts.scan === 'not_applicable' && mime !== 'text/csv') throw new LimsError('common.internal');

      let stored: Uint8Array = bytes; let image: { width: number; height: number } | undefined;
      if (opts.images && (mime === 'image/png' || mime === 'image/jpeg')) {
        try {
          if (mime !== 'image/png') throw new ImageRejected();
          const r = reencodePng(bytes, opts.images.maxMegapixels ?? 40);
          stored = r.bytes; image = { width: r.width, height: r.height };
        } catch (e) { if (e instanceof ImageRejected) throw new LimsError('common.upload_quarantined'); throw e; }
      }

      let scanState: AcceptedUpload['scanState'] = 'clean';
      if (opts.scan === 'required') {
        const r = await o.files.scan(bytes).catch((): ScanResult => 'unavailable');
        scanState = r === 'clean' || r === 'infected' ? r : 'unavailable';
      }
      if (scanState === 'infected') {
        o.log?.warn({ event: 'upload_quarantined', bucket: opts.bucket, mime }, 'upload_quarantined');
        throw new LimsError('common.upload_quarantined');
      }
      const put = await o.storage.put(opts.bucket, opts.objectPath, stored, { contentType: mime, ifAbsent: true });
      return {
        objectId: uuidv7(), bucket: opts.bucket, objectPath: opts.objectPath, sha256: put.sha256, byteSize: put.byteSize,
        mime, ...(image ? { image } : {}), scanState,
      };
    },
  };
}
