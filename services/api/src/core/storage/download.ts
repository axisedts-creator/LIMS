// ctx.download.stream (02-TRD §6.3; 08 A13 P-2, A17 D-67; CR-C3-005; AC-0D-3.3). Bytes go through the API, never a signed URL.
// Order: scanState gate -> header checks -> storage.read (tenant + bucket rules) -> access-log row -> response. Any failure = no bytes.
import { LimsError } from '../errors.js';
import type { AccessLogEntry } from '../audit/access.js';
import type { BucketName, StorageAdapter } from './index.js';

export interface DownloadInput {
  readonly bucket: BucketName; readonly objectPath: string;
  readonly filename: string; readonly contentType: string;
  /** Only 'clean' is served; anything else (pending/infected/unavailable/unknown) => 422 common.upload_quarantined. */
  readonly scanState: unknown;
  readonly access: AccessLogEntry;
  /** D-67: inline only for objects accepted with images.reencode: true and stored as image/png|image/jpeg. */
  readonly inline?: { readonly reencodedImage?: boolean };
}
export interface DownloadResponse { readonly status: 200; readonly headers: Readonly<Record<string, string>>; readonly body: Uint8Array }

const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;
const INLINE_MIME = new Set(['image/png', 'image/jpeg']);

/** RFC 6266 / 8187: ASCII fallback (quote, backslash, controls and non-ASCII replaced) + UTF-8 filename*. */
export function contentDisposition(kind: 'attachment' | 'inline', filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]|["\\]/g, '_') || 'download';
  const star = encodeURIComponent(filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${star}`;
}

export function createDownload(o: {
  storage: Pick<StorageAdapter, 'read'>;
  audit: { access(entry: AccessLogEntry): Promise<unknown> };
  log?: unknown;
}) {
  return {
    async stream(input: DownloadInput): Promise<DownloadResponse> {
      if (input.scanState !== 'clean') throw new LimsError('common.upload_quarantined');
      if (typeof input.contentType !== 'string' || !MIME.test(input.contentType) || typeof input.filename !== 'string') throw new LimsError('common.internal');
      const inline = input.inline !== undefined;
      if (inline && (input.inline?.reencodedImage !== true || !INLINE_MIME.has(input.contentType))) throw new LimsError('common.internal');
      const body = await o.storage.read(input.bucket, input.objectPath);
      await o.audit.access(input.access);
      const headers: Record<string, string> = {
        'content-type': input.contentType,
        'content-disposition': contentDisposition(inline ? 'inline' : 'attachment', input.filename),
        'x-content-type-options': 'nosniff',
        'cache-control': 'no-store',
        'content-length': String(body.length),
      };
      if (inline) headers['content-security-policy'] = "default-src 'none'; sandbox";
      return { status: 200, headers, body };
    },
  };
}
