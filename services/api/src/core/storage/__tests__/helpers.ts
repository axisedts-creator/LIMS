// T0D-17 shared fakes (synthetic data only). Used by API and worker suites (worker imports this file by relative path).
import { createHash } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';

export const TENANT_A = '0190a000-0000-7000-8000-00000000aaaa';
export const TENANT_B = '0190a000-0000-7000-8000-00000000bbbb';
/** Sentinel storage credential: must never reach a log line, metric, error or response. */
export const CREDENTIAL = 'SENTINEL-STORAGE-CRED-7f3a9c';
export const SIGNED = 'https://storage.invalid/sign/SENTINEL-SIGNED-URL?token=abc123';
export const UUIDV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const KEY_FILE = '/run/secrets/lims_storage_key';

/** 08 §4.8 / 03-IC §13.4: bucket -> owner module (reserved `reporting-legacy` excluded). */
export const OWNERS: Readonly<Record<string, string>> = {
  reports: 'reporting', 'reporting-inputs': 'reporting', 'reporting-prints': 'reporting',
  'identity-assets': 'identity', 'identity-exports': 'identity', 'frontdesk-trf': 'frontdesk',
  'billing-exports': 'billing', 'instruments-attachments': 'instruments', 'micro-imports': 'micro',
  'anatomic-images': 'anatomic', 'partners-slips': 'partners',
};
export const BUCKETS = Object.keys(OWNERS);
export const MODULES = [...new Set(Object.values(OWNERS))];
export const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

/** In-memory raw Storage service that records every call. `connect(credential)` is what the adapter hands the credential to. */
export function fakeRaw() {
  const objects = new Map<string, { bytes: Buffer; contentType: string }>();
  const calls: string[] = [];
  const state: { failWith?: Error } = {};
  const k = (b: string, p: string) => `${b}|${p}`;
  const guard = (op: string) => { calls.push(op); if (state.failWith) throw state.failWith; };
  const raw = {
    async put(b: string, p: string, bytes: Uint8Array, o: { contentType: string; ifAbsent?: boolean }) {
      guard('put');
      if (o.ifAbsent && objects.has(k(b, p))) throw new Error('already exists');
      objects.set(k(b, p), { bytes: Buffer.from(bytes), contentType: o.contentType });
    },
    async get(b: string, p: string) { guard('get'); const o = objects.get(k(b, p)); if (!o) throw new Error('not found'); return new Uint8Array(o.bytes); },
    async move(b: string, from: string, to: string) { guard('move'); const o = objects.get(k(b, from)); if (!o) throw new Error('not found'); objects.delete(k(b, from)); objects.set(k(b, to), o); },
    async remove(b: string, p: string) { guard('remove'); objects.delete(k(b, p)); },
    async sign(b: string, p: string, ttl: number) { guard('sign'); void ttl; return `${SIGNED}&o=${b}/${p}`; },
  };
  const credentials: string[] = [];
  return { raw, objects, calls, state, credentials, connect: (c: string) => { credentials.push(c); return raw; } };
}

export function recorders() {
  const lines: unknown[] = [];
  const mk = (level: string) => (obj: unknown, msg?: string) => { lines.push({ level, obj, msg }); };
  const incs: Array<{ name: string; labels?: Record<string, unknown> }> = [];
  return {
    lines, incs,
    log: { info: mk('info'), warn: mk('warn'), error: mk('error'), debug: mk('debug') },
    metrics: { inc: (name: string, labels?: Record<string, unknown>) => { incs.push({ name, labels }); }, set() {}, observe() {} },
  };
}

/** Options for createStorage (tenant-bound, module-bound). */
export function storageOpts(f: ReturnType<typeof fakeRaw>, r: ReturnType<typeof recorders>, module: string, tenantId = TENANT_A) {
  return {
    env: { LIMS_CORE_STORAGE_KEY_FILE: KEY_FILE }, readFile: (p: string) => (p === KEY_FILE ? `${CREDENTIAL}\n` : (() => { throw new Error('ENOENT'); })()),
    connect: f.connect, module, tenantId, log: r.log, metrics: r.metrics,
  };
}

export async function toBytes(body: unknown): Promise<Buffer> {
  if (body instanceof Uint8Array) return Buffer.from(body);
  const b = body as { getReader?: () => { read(): Promise<{ done: boolean; value?: Uint8Array }> }; [Symbol.asyncIterator]?: () => AsyncIterator<Uint8Array> };
  const chunks: Buffer[] = [];
  if (typeof b?.getReader === 'function') {
    const rd = b.getReader();
    for (;;) { const { done, value } = await rd.read(); if (done) break; chunks.push(Buffer.from(value!)); }
  } else if (typeof b?.[Symbol.asyncIterator] === 'function') {
    for await (const c of b as AsyncIterable<Uint8Array | string>) chunks.push(Buffer.from(c));
  } else throw new Error('body is not bytes, a web stream or an async iterable');
  return Buffer.concat(chunks);
}

/** Valid RGB PNG (w x h) with an optional tEXt chunk (metadata that `stripMetadata` must remove). */
export function png(w = 4, h = 3, text?: string): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const t = Buffer.from(type, 'latin1'); const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0);
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, 0x7f)]);
  const idat = deflateSync(Buffer.concat(Array.from({ length: h }, () => row)));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr),
    ...(text ? [chunk('tEXt', Buffer.from(`Comment\0${text}`, 'latin1'))] : []), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0)),
  ]);
}
/** PNG whose IHDR claims huge dimensions but carries no pixel data (decompression-bomb shape). */
export function pngBomb(w: number, h: number): Buffer {
  const b = png(1, 1); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
  const crc = crc32(b.subarray(12, 29)) >>> 0; b.writeUInt32BE(crc, 29);
  return b;
}
export const PDF = Buffer.from('%PDF-1.7\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n', 'latin1');
export const ZIPISH = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(60, 1)]);
