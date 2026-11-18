// ctx.download.stream (02-TRD §6.3; 08 A13 P-2, A17 D-67; CR-C3-005; AC-0D-3.3). Bytes go through the API, never a signed URL.
// Order: scanState gate -> header checks -> storage open (tenant + bucket rules) -> access-log row -> response. Any failure = no bytes.
// T0B-FILESTREAM-1 (LD-312): the body is a stream from storage (core/storage/stream.ts), with Range (206 / 416), conditional requests (304)
// and the cache policy; one access-log row for 200 / 206 / 304, none for 416. A storage with only read() keeps the old whole-bytes answer.
import { LimsError } from '../errors.js';
import type { AccessLogEntry } from '../audit/access.js';
import type { BucketName, StorageAdapter } from './index.js';
import { respond, storageSource, type CachePolicy, type RequestHeaders, type StreamResponse } from './stream.js';

export interface DownloadInput {
  readonly bucket: BucketName; readonly objectPath: string;
  readonly filename: string; readonly contentType: string;
  /** Only 'clean' is served; anything else (pending/infected/unavailable/unknown) => 422 common.upload_quarantined. */
  readonly scanState: unknown;
  readonly access: AccessLogEntry;
  /** D-67: inline only for objects accepted with images.reencode: true and stored as image/png|image/jpeg. */
  readonly inline?: { readonly reencodedImage?: boolean };
  /** T0B-FILESTREAM-1: the request headers (Range, If-None-Match, If-Modified-Since, If-Range), lower case as req.headers. */
  readonly requestHeaders?: RequestHeaders;
  /** Default 'no-store' (patient documents); staff lists may pass { privateMaxAgeSeconds: 1..3600 }. */
  readonly cache?: CachePolicy;
}
export type DownloadResponse = StreamResponse;

export const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;
const INLINE_MIME = new Set(['image/png', 'image/jpeg']);

/** RFC 6266 / 8187: ASCII fallback (quote, backslash, controls and non-ASCII replaced) + UTF-8 filename*. */
export function contentDisposition(kind: 'attachment' | 'inline', filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]|["\\]/g, '_') || 'download';
  const star = encodeURIComponent(filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${star}`;
}

export function createDownload(o: {
  storage: Partial<Pick<StorageAdapter, 'read' | 'readStream'>>;
  audit: { access(entry: AccessLogEntry): Promise<unknown> };
  log?: unknown;
}) {
  return {
    async stream(input: DownloadInput): Promise<DownloadResponse> {
      if (input.scanState !== 'clean') throw new LimsError('common.upload_quarantined');
      if (typeof input.contentType !== 'string' || !MIME.test(input.contentType) || typeof input.filename !== 'string') throw new LimsError('common.internal');
      const inline = input.inline !== undefined;
      if (inline && (input.inline?.reencodedImage !== true || !INLINE_MIME.has(input.contentType))) throw new LimsError('common.internal');
      const headers: Record<string, string> = {
        'content-type': input.contentType,
        'content-disposition': contentDisposition(inline ? 'inline' : 'attachment', input.filename),
        'x-content-type-options': 'nosniff',
      };
      if (inline) headers['content-security-policy'] = "default-src 'none'; sandbox";
      return respond({
        open: storageSource(o.storage, input.bucket, input.objectPath), headers, onServe: () => o.audit.access(input.access),
        ...(input.cache !== undefined ? { cache: input.cache } : {}), ...(input.requestHeaders ? { requestHeaders: input.requestHeaders } : {}),
      });
    },
  };
}
