// T0B-STORAGE-1 (LD-310, LD-316; founder 2026-11-17 08:48 NPT: Supabase Storage while testing, the lab own server later, no code change to move).
// Provider neutral RawStorage for any S3 compatible endpoint. AWS Signature V4 QUERY signing (presigned URLs) in plain TypeScript over
// node:crypto, no SDK. Every request (server side too) is a presigned URL, so the credential never travels as a header and never appears
// in an error. Logical buckets (03-IC §13.4) are key prefixes `<bucket>/<key>` inside the ONE physical STORAGE_BUCKET [CONV].
// Not wired to any route here: direct upload/download routes wait for the P-2 spec change (see .orchestra/notes/T0B-STORAGE-1-impl.md).
import { createHash, createHmac } from 'node:crypto';
import { Readable } from 'node:stream';
import type { RawStorage } from './index.js';

export type StorageConfig =
  | { readonly provider: 'none' }
  | { readonly provider: 's3_compatible'; readonly endpoint: string; readonly region: string; readonly bucket: string;
      readonly accessKeyId: string; readonly secretAccessKey: string; readonly forcePathStyle: boolean;
      /** STORAGE_SIGNING_HOST: the `host[:port]` to SIGN with when it is not the endpoint's (see presignV4). */
      readonly signingHost?: string };
type S3Config = Extract<StorageConfig, { provider: 's3_compatible' }>;
type Env = Readonly<Record<string, string | undefined>>;

const NAMES = ['STORAGE_PROVIDER', 'STORAGE_ENDPOINT', 'STORAGE_REGION', 'STORAGE_BUCKET', 'STORAGE_ACCESS_KEY_ID', 'STORAGE_SECRET_ACCESS_KEY', 'STORAGE_FORCE_PATH_STYLE', 'STORAGE_SIGNING_HOST'] as const;
/** host or host:port, lower case; nothing a URL parser would read as path, user or query. */
const SIGNING_HOST = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?(:[0-9]{1,5})?$/;
const REQUIRED = ['STORAGE_ENDPOINT', 'STORAGE_REGION', 'STORAGE_BUCKET', 'STORAGE_ACCESS_KEY_ID', 'STORAGE_SECRET_ACCESS_KEY'] as const;
/** S3 bucket naming rule (3..63, lower case, digits, dot, hyphen). */
const BUCKET_NAME = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
/** SigV4 presigned URL lifetime limit (7 days). */
export const S3_MAX_EXPIRES_SECONDS = 604800;

/** Messages name keys only, never a value (a value may be a secret pasted into the wrong name). */
export function parseStorageConfig(env: Env): StorageConfig {
  const v = (k: string): string | undefined => (env[k] === undefined || env[k] === '' ? undefined : env[k]);
  const provider = v('STORAGE_PROVIDER');
  if (provider === undefined) {
    const set = NAMES.filter((k) => v(k) !== undefined);
    if (set.length) throw new Error(`config: STORAGE_PROVIDER is required when ${set.join(', ')} is set (s3_compatible|none)`);
    return { provider: 'none' };
  }
  if (provider === 'none') return { provider: 'none' };
  if (provider !== 's3_compatible') throw new Error('config: STORAGE_PROVIDER must be one of s3_compatible|none');
  const missing = REQUIRED.filter((k) => v(k) === undefined);
  if (missing.length) throw new Error(`config: ${missing.join(', ')} must be set for STORAGE_PROVIDER=s3_compatible (or set STORAGE_PROVIDER=none)`);
  let ep: URL | undefined;
  try { ep = new URL(v('STORAGE_ENDPOINT')!); } catch { ep = undefined; }
  if (!ep || (ep.protocol !== 'http:' && ep.protocol !== 'https:') || ep.username || ep.password || ep.search || ep.hash) {
    throw new Error('config: STORAGE_ENDPOINT must be an http(s) URL without user, password, query or fragment');
  }
  const bucket = v('STORAGE_BUCKET')!;
  if (!BUCKET_NAME.test(bucket)) throw new Error('config: STORAGE_BUCKET must be an S3 bucket name (3..63 of a-z 0-9 . -)');
  const fps = v('STORAGE_FORCE_PATH_STYLE');
  if (fps !== undefined && fps !== 'true' && fps !== 'false') throw new Error('config: STORAGE_FORCE_PATH_STYLE must be true|false');
  const sh = v('STORAGE_SIGNING_HOST')?.toLowerCase();
  if (sh !== undefined && !SIGNING_HOST.test(sh)) throw new Error('config: STORAGE_SIGNING_HOST must be host or host:port (no scheme, no path)');
  return Object.freeze({
    provider: 's3_compatible', endpoint: ep.origin + ep.pathname.replace(/\/+$/, ''), region: v('STORAGE_REGION')!, bucket,
    accessKeyId: v('STORAGE_ACCESS_KEY_ID')!, secretAccessKey: v('STORAGE_SECRET_ACCESS_KEY')!, forcePathStyle: fps === 'true',
    ...(sh !== undefined ? { signingHost: sh } : {}),
  });
}

const sha256hex = (d: string | Uint8Array): string => createHash('sha256').update(d).digest('hex');
const hmac = (k: string | Buffer, d: string): Buffer => createHmac('sha256', k).update(d).digest();
/** RFC 3986: unreserved kept, everything else %XX (the SigV4 rule; encodeURIComponent leaves !'()* alone). */
const enc = (s: string): string => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const encPath = (p: string): string => p.split('/').map(enc).join('/');
const amzDate = (ms: number): string => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

export interface PresignInput {
  method: string; url: string; region: string; accessKeyId: string; secretAccessKey: string;
  /** Signing time, epoch ms. */
  now: number; expiresSeconds: number;
  /** Extra headers to bind into the signature (the client must send them exactly). `host` is always signed. */
  headers?: Record<string, string>;
  /** The `host[:port]` put into the signature instead of the URL's own. A Supabase Storage server that has STORAGE_PUBLIC_URL set verifies
   *  every S3 signature against THAT URL's host and port, whatever address the request arrived on (found on the production host and
   *  reproduced with tests/core/STORAGE-KIT-1.pg.sh, CR TENANT-LOGO-1). The request itself still goes to `url`. */
  signHost?: string;
}

/** SigV4 query signing (AWS S3 "Authenticating Requests: Using Query Parameters"). The payload hash of a presigned request is ALWAYS the
 *  literal UNSIGNED-PAYLOAD (AWS rule); `x-amz-content-sha256`, when bound, is one more signed header. Proven against a real Supabase Storage
 *  server (tests/core/STORAGE-KIT-1.pg.sh): signing the header value as the payload hash is answered 403 SignatureDoesNotMatch (CR TENANT-LOGO-1).
 *  Existing query parameters on `url` are signed too. */
export function presignV4(i: PresignInput): string {
  if (!Number.isInteger(i.expiresSeconds) || i.expiresSeconds < 1 || i.expiresSeconds > S3_MAX_EXPIRES_SECONDS) throw new Error('storage: expiry out of range');
  const u = new URL(i.url);
  const date = amzDate(i.now);
  const day = date.slice(0, 8);
  const scope = `${day}/${i.region}/s3/aws4_request`;
  const headers = new Map<string, string>([['host', i.signHost ?? u.host]]);
  for (const [k, v] of Object.entries(i.headers ?? {})) headers.set(k.toLowerCase(), String(v).trim().replace(/\s+/g, ' '));
  const names = [...headers.keys()].sort();
  const signedHeaders = names.join(';');
  const params: Array<[string, string]> = [...u.searchParams.entries()];
  params.push(['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'], ['X-Amz-Credential', `${i.accessKeyId}/${scope}`], ['X-Amz-Date', date],
    ['X-Amz-Expires', String(i.expiresSeconds)], ['X-Amz-SignedHeaders', signedHeaders]);
  const query = params.map(([k, v]) => [enc(k), enc(v)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('&');
  const path = encPath(decodeURIComponent(u.pathname));
  const canonical = [i.method.toUpperCase(), path, query, names.map((n) => `${n}:${headers.get(n)}\n`).join(''), signedHeaders,
    'UNSIGNED-PAYLOAD'].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', date, scope, sha256hex(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${i.secretAccessKey}`, day), i.region), 's3'), 'aws4_request');
  return `${u.origin}${path}?${query}&X-Amz-Signature=${hmac(key, toSign).toString('hex')}`;
}

const LOGICAL = /^[a-z0-9][a-z0-9-]*$/;

export function createS3RawStorage(cfg: S3Config, deps: { now?: () => number; fetch?: typeof fetch } = {}): Required<RawStorage> {
  const now = deps.now ?? Date.now;
  const doFetch = deps.fetch ?? fetch;
  const ep = new URL(cfg.endpoint);
  const base = ep.pathname.replace(/\/+$/, '');
  const objectPath = (bucket: string, key: string): string => {
    if (!LOGICAL.test(bucket) || typeof key !== 'string' || !key) throw new Error('storage: bad object name');
    return `${bucket}/${key}`;
  };
  const urlOf = (name: string): string => (cfg.forcePathStyle
    ? `${ep.protocol}//${ep.host}${base}/${enc(cfg.bucket)}/${encPath(name)}`
    : `${ep.protocol}//${cfg.bucket}.${ep.host}${base}/${encPath(name)}`);
  const sign = (method: string, name: string, ttl: number, headers?: Record<string, string>, query?: Record<string, string>): string => {
    const u = new URL(urlOf(name));
    for (const [k, v] of Object.entries(query ?? {})) u.searchParams.set(k, v);
    return presignV4({ method, url: u.toString(), region: cfg.region, accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey, now: now(), expiresSeconds: ttl, ...(headers ? { headers } : {}), ...(cfg.signingHost ? { signHost: cfg.signingHost } : {}) });
  };
  /** Server side calls: short lived URL; raw errors (they may carry the signed URL) are replaced by op + status only. */
  const SERVER_TTL = 60;
  async function send(op: string, method: string, name: string, o: { signed?: Record<string, string>; body?: Uint8Array | ReadableStream<Uint8Array>; ok?: number[]; unsigned?: Record<string, string> } = {}): Promise<Response> {
    const url = sign(method, name, SERVER_TTL, o.signed);
    // content-length is bound in the signature; fetch sets it itself from the body (it refuses a hand set one on some runtimes).
    const headers = { ...Object.fromEntries(Object.entries(o.signed ?? {}).filter(([k]) => k.toLowerCase() !== 'content-length')), ...o.unsigned };
    const streamed = o.body !== undefined && !(o.body instanceof Uint8Array);
    let r: Response;
    try { r = await doFetch(url, { method, headers, ...(o.body ? { body: o.body as BodyInit } : {}), ...(streamed ? { duplex: 'half' } : {}) } as RequestInit); } catch { throw new Error(`storage: ${op} failed (network)`); }
    if (r.ok || (o.ok ?? []).includes(r.status)) return r;
    await r.arrayBuffer().catch(() => undefined);
    throw new Error(`storage: ${op} failed (${r.status})`);
  }
  const drain = async (r: Response): Promise<void> => { await r.arrayBuffer().catch(() => undefined); };
  const validators = (r: Response): { etag?: string; lastModified?: Date } => {
    const etag = r.headers.get('etag'); const lm = Date.parse(r.headers.get('last-modified') ?? '');
    return { ...(etag ? { etag } : {}), ...(Number.isFinite(lm) ? { lastModified: new Date(lm) } : {}) };
  };

  /** Create only. `if-none-match: *` is sent, but not every S3 compatible server honours it: a real Supabase Storage server overwrites
   *  (tests/core/STORAGE-KIT-1.pg.sh). So the object is looked up first and an existing one is refused here.
   *  ponytail: look-then-put is not atomic; two writers of ONE key in the same instant could both pass. Keys carry a fresh UUIDv7, so no
   *  flow writes one key twice; use a server side condition if that ever changes. */
  async function refuseExisting(bucket: string, key: string): Promise<void> {
    const r = await send('put', 'HEAD', objectPath(bucket, key), { ok: [404] });
    await drain(r);
    if (r.status !== 404) throw new Error('storage: put failed (412)');
  }

  return {
    async put(bucket, key, bytes, o) {
      const signed: Record<string, string> = { 'content-type': o.contentType, 'content-length': String(bytes.length), 'x-amz-content-sha256': sha256hex(bytes) };
      if (o.ifAbsent) { signed['if-none-match'] = '*'; await refuseExisting(bucket, key); }
      await drain(await send('put', 'PUT', objectPath(bucket, key), { signed, body: bytes }));
    },
    async get(bucket, key) {
      const r = await send('get', 'GET', objectPath(bucket, key));
      return new Uint8Array(await r.arrayBuffer());
    },
    async move(bucket, from, to) {
      // S3 has no rename: copy, then delete the source (only after the copy succeeded).
      const src = objectPath(bucket, from);
      const copySource = `/${enc(cfg.bucket)}/${encPath(src)}`;
      await drain(await send('move', 'PUT', objectPath(bucket, to), { signed: { 'x-amz-copy-source': copySource } }));
      await drain(await send('move', 'DELETE', src, { ok: [404] }));
    },
    async remove(bucket, key) {
      await drain(await send('remove', 'DELETE', objectPath(bucket, key), { ok: [404] }));
    },
    async sign(bucket, key, ttlSeconds) {
      return sign('GET', objectPath(bucket, key), ttlSeconds);
    },
    async signUpload(bucket, key, o) {
      // Create only, exact type, exact size, exact digest: all bound as signed headers (a change is a 403, a body that does not match is a 400).
      // ponytail: `resumable` is accepted and ignored (single PUT, S3 limit 5 GiB); add multipart when uploads above that are needed.
      const headers = { 'content-type': o.contentType, 'content-length': String(o.byteSize), 'x-amz-content-sha256': o.sha256, 'x-amz-meta-sha256': o.sha256, 'if-none-match': '*' };
      return { url: sign('PUT', objectPath(bucket, key), o.ttlSeconds, headers), method: 'PUT', headers, resumable: false };
    },
    async signDownload(bucket, key, o) {
      return { url: sign('GET', objectPath(bucket, key), o.ttlSeconds, undefined, {
        'response-content-disposition': o.disposition, 'response-content-type': o.contentType, 'response-cache-control': o.cacheControl,
      }) };
    },
    async head(bucket, key) {
      const r = await send('head', 'HEAD', objectPath(bucket, key), { ok: [404] });
      await drain(r);
      if (r.status === 404) return undefined;
      const sha = r.headers.get('x-amz-meta-sha256');
      return { byteSize: Number(r.headers.get('content-length') ?? '0'), contentType: r.headers.get('content-type') ?? 'application/octet-stream', ...(sha ? { sha256: sha } : {}) };
    },
    // T0B-FILESTREAM-1 (LD-312): the body is handed back unread; Range is a plain (unsigned) header, allowed with query signing.
    async getStream(bucket, key, o = {}) {
      const name = objectPath(bucket, key);
      const r = await send('get', 'GET', name, o.range ? { unsigned: { range: `bytes=${o.range.start}-${o.range.end}` } } : {});
      if (o.range && r.status !== 206) { await drain(r); throw new Error('storage: get failed (range ignored)'); }
      const total = o.range ? /\/(\d+)$/.exec(r.headers.get('content-range') ?? '')?.[1] : r.headers.get('content-length');
      if (total == null || !/^\d+$/.test(total)) { await drain(r); throw new Error('storage: get failed (no size)'); }
      return { body: r.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() }), size: Number(total), ...validators(r) };
    },
    // ponytail: content-length is bound only when the caller knows byteSize; S3 refuses a chunked PUT without it (411), so callers that stream an
    // unknown size need multipart upload. Today no flow does (accept() buffers what it scans, see T0B-FILESTREAM-1-impl.md).
    async putStream(bucket, key, body, o) {
      const signed: Record<string, string> = { 'content-type': o.contentType };
      if (o.byteSize !== undefined) signed['content-length'] = String(o.byteSize);
      if (o.ifAbsent) { signed['if-none-match'] = '*'; await refuseExisting(bucket, key); }
      const web = Readable.toWeb(Readable.from(body, { objectMode: false })) as unknown as ReadableStream<Uint8Array>;
      await drain(await send('put', 'PUT', objectPath(bucket, key), { signed, body: web }));
    },
  };
}
