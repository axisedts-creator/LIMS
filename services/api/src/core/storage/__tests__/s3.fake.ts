// T0B-STORAGE-1 test fake: an in-process S3 compatible server on 127.0.0.1 (no network, synthetic keys only).
// It verifies AWS Signature V4 QUERY signatures with its OWN canonical request code (independent of the adapter under test),
// so a wrong or tampered signature, header, expiry, length or digest is refused the way S3 / MinIO refuse it.
// Addressing: path style `/<bucket>/<key>`, virtual host style `Host: <bucket>.<endpoint host>` + `/<key>`.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export const TEST_ACCESS_KEY_ID = 'AKIAFAKETESTKEY0001';
export const TEST_SECRET = 'fake/Secret+Key/for-tests-only-0123456789';
export const TEST_REGION = 'ap-south-1';
export const TEST_BUCKET = 'lims-test';

const sha256hex = (d: string | Uint8Array): string => createHash('sha256').update(d).digest('hex');
const hmac = (k: string | Buffer, d: string): Buffer => createHmac('sha256', k).update(d).digest();
/** RFC 3986 unreserved set; everything else %XX (this is the S3 / SigV4 rule). */
export const enc = (s: string): string => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const encPath = (p: string): string => p.split('/').map(enc).join('/');

export interface StoredObject { bytes: Buffer; contentType: string; meta: Record<string, string> }
export interface FakeS3 {
  readonly port: number; readonly objects: Map<string, StoredObject>; readonly requests: Array<{ method: string; target: string; status: number; reason?: string }>;
  readonly state: { clock: () => number; forceStatus?: number };
  close(): Promise<void>;
}

function verify(req: IncomingMessage, url: URL, method: string, accessKeyId: string, secret: string, region: string, nowMs: number): string | undefined {
  const q = url.searchParams;
  if (q.get('X-Amz-Algorithm') !== 'AWS4-HMAC-SHA256') return 'algorithm';
  const cred = (q.get('X-Amz-Credential') ?? '').split('/');
  if (cred.length !== 5 || cred[0] !== accessKeyId || cred[2] !== region || cred[3] !== 's3' || cred[4] !== 'aws4_request') return 'credential scope';
  const date = q.get('X-Amz-Date') ?? '';
  if (!/^\d{8}T\d{6}Z$/.test(date) || cred[1] !== date.slice(0, 8)) return 'date';
  const expires = Number(q.get('X-Amz-Expires'));
  if (!Number.isInteger(expires) || expires < 1 || expires > 604800) return 'expires out of range';
  const signedHeaders = (q.get('X-Amz-SignedHeaders') ?? '').split(';').filter(Boolean);
  if (!signedHeaders.includes('host') || [...signedHeaders].sort().join(';') !== signedHeaders.join(';')) return 'signed headers';
  const iso = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${date.slice(9, 11)}:${date.slice(11, 13)}:${date.slice(13, 15)}Z`;
  const t0 = Date.parse(iso);
  if (nowMs > t0 + expires * 1000) return 'expired';
  if (t0 > nowMs + 15 * 60 * 1000) return 'not yet valid';
  const canonicalQuery = [...q.entries()].filter(([k]) => k !== 'X-Amz-Signature').map(([k, v]) => [enc(k), enc(v)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('&');
  const headers = signedHeaders.map((h) => `${h}:${String(req.headers[h] ?? '').trim().replace(/\s+/g, ' ')}\n`).join('');
  // CR TENANT-LOGO-1: presigned requests always sign UNSIGNED-PAYLOAD (AWS rule). The fake used the header value before, which a real
  // Supabase Storage server answers with 403 (tests/core/STORAGE-KIT-1.pg.sh); the fake now behaves like the real server.
  const payload = 'UNSIGNED-PAYLOAD';
  const canonical = [method, encPath(decodeURIComponent(url.pathname)), canonicalQuery, headers, signedHeaders.join(';'), payload].join('\n');
  const sts = ['AWS4-HMAC-SHA256', date, `${date.slice(0, 8)}/${region}/s3/aws4_request`, sha256hex(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${secret}`, date.slice(0, 8)), region), 's3'), 'aws4_request');
  const want = hmac(key, sts);
  const got = Buffer.from(q.get('X-Amz-Signature') ?? '', 'hex');
  return got.length === want.length && timingSafeEqual(got, want) ? undefined : 'signature mismatch';
}

export async function startFakeS3(o: { bucket?: string; style: 'path' | 'virtual'; clock: () => number; endpointHost?: string }): Promise<FakeS3> {
  const bucket = o.bucket ?? TEST_BUCKET;
  const objects = new Map<string, StoredObject>();
  const requests: FakeS3['requests'] = [];
  const state: FakeS3['state'] = { clock: o.clock };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const method = req.method ?? 'GET';
      const done = (status: number, reason?: string, headers: Record<string, string> = {}, payload?: Buffer) => {
        requests.push({ method, target: req.url ?? '', status, ...(reason ? { reason } : {}) });
        res.writeHead(status, { ...headers, ...(payload ? { 'content-length': String(payload.length) } : {}) });
        res.end(method === 'HEAD' ? undefined : payload ?? (status >= 400 ? `<Error><Code>${reason ?? status}</Code></Error>` : undefined));
      };
      if (state.forceStatus) return done(state.forceStatus, 'forced');
      const host = String(req.headers.host ?? '');
      const url = new URL(req.url ?? '/', `http://${host}`);
      const bad = verify(req, url, method, TEST_ACCESS_KEY_ID, TEST_SECRET, TEST_REGION, state.clock());
      if (bad) return done(403, bad);
      let key: string;
      const path = decodeURIComponent(url.pathname);
      if (o.style === 'path') {
        if (!path.startsWith(`/${bucket}/`)) return done(404, 'NoSuchBucket');
        key = path.slice(bucket.length + 2);
      } else {
        if (!host.startsWith(`${bucket}.`)) return done(404, 'NoSuchBucket');
        key = path.slice(1);
      }
      if (!key) return done(400, 'KeyMissing');
      if (method === 'PUT' && req.headers['x-amz-copy-source']) {
        const src = decodeURIComponent(String(req.headers['x-amz-copy-source'])).replace(/^\//, '').replace(new RegExp(`^${bucket}/`), '');
        const s = objects.get(src);
        if (!s) return done(404, 'NoSuchKey');
        objects.set(key, { ...s, bytes: Buffer.from(s.bytes) });
        return done(200, undefined, {}, Buffer.from('<CopyObjectResult/>'));
      }
      if (method === 'PUT') {
        if (String(req.headers['content-length'] ?? '') !== String(body.length)) return done(400, 'IncompleteBody');
        const claimed = String(req.headers['x-amz-content-sha256'] ?? '');
        if (claimed && claimed !== 'UNSIGNED-PAYLOAD' && claimed !== sha256hex(body)) return done(400, 'XAmzContentSHA256Mismatch');
        if (req.headers['if-none-match'] === '*' && objects.has(key)) return done(412, 'PreconditionFailed');
        const meta: Record<string, string> = {};
        for (const [h, v] of Object.entries(req.headers)) if (h.startsWith('x-amz-meta-')) meta[h.slice('x-amz-meta-'.length)] = String(v);
        objects.set(key, { bytes: body, contentType: String(req.headers['content-type'] ?? 'binary/octet-stream'), meta });
        return done(200);
      }
      if (method === 'DELETE') { objects.delete(key); return done(204); }
      if (method === 'GET' || method === 'HEAD') {
        const obj = objects.get(key);
        if (!obj) return done(404, 'NoSuchKey');
        const h: Record<string, string> = {
          'content-type': url.searchParams.get('response-content-type') ?? obj.contentType, 'accept-ranges': 'bytes', etag: `"${sha256hex(obj.bytes).slice(0, 32)}"`,
        };
        for (const [k, v] of Object.entries(obj.meta)) h[`x-amz-meta-${k}`] = v;
        const cd = url.searchParams.get('response-content-disposition'); if (cd) h['content-disposition'] = cd;
        const cc = url.searchParams.get('response-cache-control'); if (cc) h['cache-control'] = cc;
        if (method === 'HEAD') { h['content-length'] = String(obj.bytes.length); return done(200, undefined, h); }
        const m = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range ?? ''));
        if (m) {
          const a = Number(m[1]); const b = m[2] ? Math.min(Number(m[2]), obj.bytes.length - 1) : obj.bytes.length - 1;
          return done(206, undefined, { ...h, 'content-range': `bytes ${a}-${b}/${obj.bytes.length}` }, obj.bytes.subarray(a, b + 1));
        }
        return done(200, undefined, h, obj.bytes);
      }
      return done(405, 'MethodNotAllowed');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return { port, objects, requests, state, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

/** What a client does with a URL whose host cannot be resolved here: connect to 127.0.0.1:<port>, keep the URL's host as Host. */
export function sendVia(port: number) {
  return (input: string | URL, init: { method?: string; headers?: Record<string, string>; body?: Uint8Array | Buffer | string | null } = {}): Promise<Response> =>
    new Promise((resolve, reject) => {
      const u = new URL(String(input));
      const headers: Record<string, string> = { ...init.headers, host: u.host };
      const body = init.body == null ? undefined : Buffer.from(init.body as Uint8Array);
      if (body && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-length')) headers['content-length'] = String(body.length);
      const req = httpRequest({ host: '127.0.0.1', port, method: init.method ?? 'GET', path: u.pathname + u.search, headers, setHost: false }, (res) => {
        const parts: Buffer[] = [];
        res.on('data', (c: Buffer) => parts.push(c));
        res.on('end', () => {
          const h = new Headers(); for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) h.set(k, Array.isArray(v) ? v.join(', ') : v);
          const noBody = [101, 204, 205, 304].includes(res.statusCode ?? 0) || init.method === 'HEAD';
          resolve(new Response(noBody ? null : Buffer.concat(parts), { status: res.statusCode ?? 0, headers: h }));
        });
      });
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
}
export const sha256Hex = sha256hex;
