// ctx.uploads.accept + ctx.files.scan (03-IC §13.6; 08 R12b; 02-CV §10.2; REQ-SEC-083..085).
// Order (fail closed): options -> bucket owner + tenant path -> size (413) -> extension + declared mime + magic (415)
// -> image re-encode (422) -> scan (infected 422; unavailable/throw stored as scanState 'unavailable', 08 §4.13) -> put ifAbsent.
// The client filename only selects the expected type; it never reaches the stored key.
import { uuidv7 } from '../../../../../packages/shared-ts/src/uuidv7/index.js';
import { LimsError } from '../errors.js';
import { assertOwned, assertTenantPath, iterableOf, type BucketName, type ByteSource, type StorageAdapter } from '../storage/index.js';
import { ImageRejected, reencodePng } from './image.js';
import type { ScanResult } from './scan.js';

export { createFiles, type ScanResult } from './scan.js';

export type UploadMime = 'application/pdf' | 'image/jpeg' | 'image/png' | 'text/csv'
  | 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
/** [CONV] not defined by 03-IC: what the multipart layer hands to accept(). T0B-FILESTREAM-1 (LD-312): bytes, or a stream with the declared size. */
export interface IncomingFile { readonly filename: string; readonly mimeType: string; readonly bytes: Uint8Array }
export interface StreamedFile { readonly filename: string; readonly mimeType: string; readonly stream: ByteSource; readonly declaredSize?: number }
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

export const MAX_BYTES = 15 * 1024 * 1024;   // 02-CV §10.2
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const BY_EXT: Readonly<Record<string, UploadMime>> = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', csv: 'text/csv', xlsx: XLSX };
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
  /** Expected type from the client filename's extension, only when the declared type agrees; never part of the stored key. */
  const typeOf = (file: { filename: unknown; mimeType: unknown }): UploadMime | undefined => {
    if (typeof file.filename !== 'string' || typeof file.mimeType !== 'string') return undefined;
    const base = file.filename.split(/[\\/]/).pop() ?? '';
    const dot = base.lastIndexOf('.');
    const mime = dot > 0 ? BY_EXT[base.slice(dot + 1).toLowerCase()] : undefined;
    return mime && file.mimeType.split(';')[0]!.trim().toLowerCase() === mime ? mime : undefined;
  };
  /** T0B-FILESTREAM-1 (LD-312): a streamed body is read up to maxBytes and no further (413 at the limit, a declaredSize over it refused before
   *  the first byte), and a wrong type is refused from its first bytes. What passes is held once, because every kind accept() takes today is
   *  inspected before it is stored: the scanner takes bytes (scan 'required': PDF / image / XLSX), PNG is re-encoded (REQ-SEC-083..085), CSV is
   *  checked whole for UTF-8 and NUL. At most maxBytes (<= 15 MiB, 02-CV §10.2) is held. */
  async function readLimited(file: { filename: unknown; mimeType: unknown; stream: unknown; declaredSize?: unknown }, opts: UploadAcceptOptions): Promise<Uint8Array> {
    if (typeof file.declaredSize === 'number' && file.declaredSize > opts.maxBytes) throw new LimsError('common.payload_too_large');
    const src = iterableOf(file.stream);
    const mime = typeOf(file);
    if (!src || !mime || !opts.allow.includes(mime)) throw unsupported();
    // One growing buffer (chunks are copied in and dropped), sized from declaredSize when given; a lying declaredSize only costs a regrow.
    const hint = typeof file.declaredSize === 'number' && Number.isInteger(file.declaredSize) && file.declaredSize > 0 ? file.declaredSize : 64 * 1024;
    let buf = Buffer.allocUnsafe(Math.min(hint, opts.maxBytes)); let size = 0; let typeChecked = mime === 'text/csv';   // CSV has no magic: checked whole later
    try {
      for await (const c of src) {
        if (!(c instanceof Uint8Array)) throw unsupported();
        if (size + c.length > opts.maxBytes) throw new LimsError('common.payload_too_large');   // stops reading the source here
        if (size + c.length > buf.length) { const next = Buffer.allocUnsafe(Math.min(opts.maxBytes, Math.max(buf.length * 2, size + c.length))); buf.copy(next, 0, 0, size); buf = next; }
        buf.set(c, size); size += c.length;
        if (!typeChecked && size >= 8) { if (!MAGIC[mime](buf.subarray(0, size))) throw unsupported(); typeChecked = true; }
      }
    } catch (e) {
      if (e instanceof LimsError) throw e;
      throw unsupported();   // [CONV] a body that breaks off is refused like an unreadable one; the source error text is never echoed
    }
    return buf.subarray(0, size);
  }
  return {
    async accept(file: IncomingFile | StreamedFile, opts: UploadAcceptOptions): Promise<AcceptedUpload> {
      // Programming errors in the calling module (bad options) -> 500.
      if (!Array.isArray(opts?.allow) || opts.allow.length === 0 || !opts.allow.every((m) => Object.hasOwn(MAGIC, m))
        || !Number.isInteger(opts.maxBytes) || opts.maxBytes < 1 || opts.maxBytes > MAX_BYTES
        || (opts.scan !== 'required' && opts.scan !== 'not_applicable')
        || (opts.images?.maxMegapixels !== undefined && !(opts.images.maxMegapixels > 0 && opts.images.maxMegapixels <= 40))) throw new LimsError('common.internal');
      assertOwned(o.module, opts.bucket); assertTenantPath(o.tenantId, opts.objectPath);
      const bytes = file && 'stream' in file && !('bytes' in file) ? await readLimited(file, opts) : (file as { bytes?: unknown })?.bytes;
      if (!(bytes instanceof Uint8Array) || typeof file.filename !== 'string' || typeof file.mimeType !== 'string') throw unsupported();
      if (bytes.length > opts.maxBytes) throw new LimsError('common.payload_too_large');
      const mime = typeOf(file);
      if (!mime || bytes.length === 0 || !opts.allow.includes(mime) || !MAGIC[mime](bytes)) throw unsupported();
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
