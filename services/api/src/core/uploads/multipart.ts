// The multipart layer of 02-TRD §6.2 ("JSON + multipart only"), missing until CR TENANT-LOGO-1: without it Fastify answered 415 to every
// upload before any handler ran. Strict multipart/form-data parser over the whole (size limited) body, node only, no dependency.
//   text part  (no filename)  -> string (UTF-8, fatal)
//   file part  (filename)     -> IncomingFile { filename, mimeType, bytes }   (what ctx.uploads.accept takes)
// Everything that is not exactly that shape is refused with 400 common.validation_failed: no boundary, no closing delimiter, a part
// without a name, a repeated name, nested multipart, too many parts, oversized headers or fields. Nothing here trusts the client
// filename or type: accept() re-derives the type from the bytes and never uses the filename in a stored key.
import type { FastifyInstance } from 'fastify';
import { LimsError } from '../errors.js';
import type { IncomingFile } from './index.js';

/** Whole request body. The largest file accept() takes is 15 MiB (02-CV §10.2); the rest is part headers and text fields. Over = 413. */
export const MULTIPART_BODY_LIMIT = 16 * 1024 * 1024;
const MAX_PARTS = 20;
const MAX_HEADER_BYTES = 4096;
const MAX_FIELD_BYTES = 64 * 1024;
const NAME = /^[A-Za-z0-9_.-]{1,64}$/;
const CRLF2 = Buffer.from('\r\n\r\n');

export type MultipartBody = Record<string, string | IncomingFile>;
const bad = (): never => { throw new LimsError('common.validation_failed'); };
const utf8 = new TextDecoder('utf-8', { fatal: true });

/** boundary parameter of a multipart/form-data content type (RFC 2046: 1..70 characters, optionally quoted). */
export function boundaryOf(contentType: unknown): string | undefined {
  if (typeof contentType !== 'string' || !/^multipart\/form-data\s*(;|$)/i.test(contentType)) return undefined;
  const m = /;\s*boundary=(?:"([^"\r\n]{1,70})"|([^\s;"]{1,70}))\s*(?:;|$)/i.exec(contentType);
  return m ? (m[1] ?? m[2]) : undefined;
}

/** `name="x"` style parameter of a Content-Disposition value; undefined when absent. Quoted form only (what browsers and fetch send). */
function param(disposition: string, key: string): string | undefined {
  const m = new RegExp(`(?:^|;)\\s*${key}="((?:[^"\\\\\\r\\n]|\\\\.)*)"`, 'i').exec(disposition);
  return m ? m[1]!.replace(/\\(.)/g, '$1') : undefined;
}

export function parseMultipart(contentType: unknown, body: unknown): MultipartBody {
  const boundary = boundaryOf(contentType);
  if (!boundary || !(body instanceof Uint8Array)) return bad();
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  const first = Buffer.from(`--${boundary}`); const next = Buffer.from(`\r\n--${boundary}`);
  let at = buf.indexOf(first);
  if (at < 0 || buf.subarray(0, at).toString('latin1').trim() !== '') return bad();   // only white space may come before the first delimiter
  at += first.length;
  const out: MultipartBody = Object.create(null);
  for (let parts = 0; ; parts++) {
    if (buf[at] === 0x2d && buf[at + 1] === 0x2d) break;                                  // "--" after a delimiter: the closing one
    if (parts >= MAX_PARTS || buf[at] !== 0x0d || buf[at + 1] !== 0x0a) return bad();
    at += 2;
    const headEnd = buf.indexOf(CRLF2, at);
    if (headEnd < 0 || headEnd - at > MAX_HEADER_BYTES) return bad();
    const headers = new Map<string, string>();
    for (const line of buf.subarray(at, headEnd).toString('latin1').split('\r\n')) {
      const c = line.indexOf(':');
      if (c < 1 || headers.has(line.slice(0, c).trim().toLowerCase())) return bad();
      headers.set(line.slice(0, c).trim().toLowerCase(), line.slice(c + 1).trim());
    }
    const start = headEnd + CRLF2.length;
    const end = buf.indexOf(next, start);
    if (end < 0) return bad();                                                            // no delimiter after this part: truncated body
    const disposition = headers.get('content-disposition') ?? '';
    const name = param(disposition, 'name');
    if (!/^form-data\s*(;|$)/i.test(disposition) || name === undefined || !NAME.test(name) || Object.hasOwn(out, name)) return bad();
    const type = (headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    if (type.startsWith('multipart/')) return bad();                                      // no nested multipart
    const filename = param(disposition, 'filename');
    const content = buf.subarray(start, end);
    if (filename === undefined) {
      if (content.length > MAX_FIELD_BYTES) return bad();
      try { out[name] = utf8.decode(content); } catch { return bad(); }
    } else {
      // Latin-1 header bytes are re-read as UTF-8 when they are valid UTF-8 (what browsers send); control characters never pass.
      let fn = filename; try { fn = utf8.decode(Buffer.from(filename, 'latin1')); } catch { /* keep the latin1 reading */ }
      if (fn.length > 255 || /[\u0000-\u001f\u007f]/.test(fn) || type.length > 127) return bad();
      out[name] = { filename: fn, mimeType: type || 'application/octet-stream', bytes: Buffer.from(content) };   // own copy: the request buffer is not kept alive
    }
    at = end + next.length;
  }
  return out;
}

/** Registers the parser. Routes decide whether multipart is allowed at all (openapi.ts wrap: only operations that declare it). */
export function installMultipart(app: FastifyInstance): void {
  app.addContentTypeParser('multipart/form-data', { parseAs: 'buffer', bodyLimit: MULTIPART_BODY_LIMIT }, (req, body, done) => {
    try { done(null, parseMultipart(req.headers['content-type'], body)); } catch (e) { done(e as Error); }
  });
}
