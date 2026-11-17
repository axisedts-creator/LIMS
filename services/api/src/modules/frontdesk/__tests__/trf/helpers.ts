// FD-T10 harness (TRF upload F20 / metadata F21 / content F21a). Same convention as ../orders/helpers.ts: the handler is driven with a request-shaped object + a HandlerContext over a REAL
// PG17 tx (lims_api, RLS on). The scanner and the object store are in-memory fakes; the core pipeline itself is REAL: `ctx.uploads` = core createUploads (magic bytes, 413/415, PNG re-encode
// without metadata, scan, put ifAbsent) and `ctx.download` = core createDownload (scan gate, P-2 headers, access-log row through the real core/audit/access.ts on ctx.tx).
// ASSUMED seams (spec silent; the writer matches them or raises a dispute):
//   - F20 request: `req.body = { file: { filename, mimeType, bytes: Uint8Array }, centre_id, order_id? }` (the shape the multipart layer hands the reporting upload handlers: `body.file`).
//   - ctx carries `uploads`, `storage`, `files`, `download`, `audit`, `ports.IdentityPort{assertRole,getActor}` (as instruments/reporting). The service writes the row + enqueues the scan job with
//     `SELECT app.enqueue_job($1, $2::jsonb, $3)` on ctx.tx = ['frontdesk.trf_scan', {tenant_id, attachment_id}, <job key>]. The enqueue is CAPTURED here, not executed (the job registry is C0's).
//   - F21a returns `{ status: 200, headers, body: Uint8Array }` (the ctx.download.stream result), body = the stored bytes.
// JPEG: core `ctx.uploads.accept` cannot re-encode JPEG yet (core/uploads/image.ts: refused with 422), so the JPEG option wiring is asserted against a SPY `uploads`; EXIF/GPS stripping itself is
// proven on PNG (tEXt + eXIf chunks), the only image type the real core sanitises today.
import { createHash } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
import { access } from '../../../../core/audit/access.js';
import { LimsError } from '../../../../core/errors.js';
import { assertBucket, assertOwned, assertTenantPath } from '../../../../core/storage/index.js';
import { createDownload } from '../../../../core/storage/download.js';
import { createUploads } from '../../../../core/uploads/index.js';
import { handlers } from '../../handlers/index.js';
import { rows } from '../integration/helpers.js';
import { BRANCH, CENTRE, NOW, SYS_ACTOR, TENANT_A, TENANT_B, appTx, makeIdentity, ownerRows, rejection, req, schemaErrors, seed, seedPatient, superTx, uid } from '../patients/helpers.js';

export { BRANCH, CENTRE, NOW, SYS_ACTOR, TENANT_A, TENANT_B, ownerRows, rejection, req, schemaErrors, seed, seedPatient, superTx, uid };
export const T = 60_000;
export const BUCKET = 'frontdesk-trf';
export const MAX = 15 * 1024 * 1024;
export const UPLOAD = 'frontdesk.trf.upload';
export const READ = 'frontdesk.order.read';
/** Second centre of tenant A (db/seeds/010), same ids the orders/approvals suites use. */
export const CENTRE_A2 = '01a1a98a-ac40-7000-8000-00000000a202';
export const BRANCH_A2 = '01a1a98a-ac40-7000-8000-00000000a102';
export const URL_SENTINEL = 'https://storage.invalid/object/sign/SECRET-URL-SENTINEL?token=SECRET-URL-SENTINEL';
export const GPS = 'GPS-LAT-27.7172N-LON-85.3240E-SENTINEL';
export const NAME_SENTINEL = 'TRFNAMESENTINEL';                       // planted in file names: P2, must never reach a log (02-CV §9.2)
export const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
export const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$' + 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';   // split: no AV flags this source

// ---- file fixtures ----
export const pdfBytes = (extra = ''): Buffer => Buffer.from(`%PDF-1.4\n% synthetic test request form ${extra}\n1 0 obj<< /Type /Catalog >>endobj\ntrailer<< /Root 1 0 R >>\n%%EOF\n`, 'latin1');
/** A valid PDF of exactly `n` bytes (comment padding after the header). */
export function pdfOfSize(n: number): Buffer {
  const head = Buffer.from('%PDF-1.4\n', 'latin1'), tail = Buffer.from('\n%%EOF\n', 'latin1');
  return Buffer.concat([head, Buffer.alloc(n - head.length - tail.length, 0x20), tail]);
}
function chunk(type: string, data: Buffer): Buffer {
  const t = Buffer.from(type, 'latin1'); const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0);
  return Buffer.concat([len, t, data, crc]);
}
/** valid 8-bit RGB PNG; `meta` adds tEXt + eXIf chunks carrying the GPS sentinel. */
export function pngBytes(o: { meta?: boolean } = {}): Buffer {
  const w = 4, h = 4; const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, 0x7f)]); const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr),
    ...(o.meta ? [chunk('tEXt', Buffer.from(`Comment\0${GPS}`, 'latin1')), chunk('eXIf', Buffer.from(GPS, 'latin1'))] : []), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
/** Minimal JPEG (SOI + APP1 Exif GPS + EOI). The real core refuses to re-encode it today, so only the spy `uploads` sees it. */
export const jpegBytes = (): Buffer => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1]), Buffer.from(`Exif\0\0${GPS}`, 'latin1'), Buffer.from([0xff, 0xd9])]);
export const file = (bytes: Uint8Array, filename = 'trf-scan.pdf', mimeType = 'application/pdf') => ({ filename, mimeType, bytes });

// ---- fake object store: enforces the REAL core bucket-owner + tenant-path rules (module 'frontdesk'); signedUrl returns a sentinel so any leak is detectable ----
export function makeStorage(tenantId = TENANT_A) {
  const objects = new Map<string, Buffer>(); const calls: Array<{ op: string; bucket: string; path: string }> = [];
  const k = (b: string, p: string) => `${b}/${p}`;
  const adapter = {
    async put(bucket: any, path: string, bytes: Uint8Array, o: { contentType: string; ifAbsent?: boolean }) {
      assertOwned('frontdesk', bucket); assertTenantPath(tenantId, path); calls.push({ op: 'put', bucket, path });
      if (o.ifAbsent && objects.has(k(bucket, path))) throw new Error('exists');
      objects.set(k(bucket, path), Buffer.from(bytes)); return { sha256: sha(bytes), byteSize: bytes.length };
    },
    async read(bucket: any, path: string) {
      assertBucket(bucket); assertTenantPath(tenantId, path); calls.push({ op: 'read', bucket, path });
      const v = objects.get(k(bucket, path)); if (!v) throw new LimsError('common.dependency_unavailable'); return new Uint8Array(v);
    },
    async move(bucket: any, from: string, to: string) {
      assertOwned('frontdesk', bucket); assertTenantPath(tenantId, from); assertTenantPath(tenantId, to); calls.push({ op: 'move', bucket, path: `${from} -> ${to}` });
      const v = objects.get(k(bucket, from)); if (!v) throw new LimsError('common.dependency_unavailable'); objects.delete(k(bucket, from)); objects.set(k(bucket, to), v);
    },
    async delete(bucket: any, path: string) { assertOwned('frontdesk', bucket); assertTenantPath(tenantId, path); calls.push({ op: 'delete', bucket, path }); objects.delete(k(bucket, path)); },
    async signedUrl(bucket: any, path: string) { calls.push({ op: 'signedUrl', bucket, path }); return URL_SENTINEL; },
  };
  return {
    adapter, calls, objects, has: (p: string) => objects.has(k(BUCKET, p)), get: (p: string) => objects.get(k(BUCKET, p)),
    seed: (p: string, bytes: Uint8Array) => { objects.set(k(BUCKET, p), Buffer.from(bytes)); },
    paths: () => [...objects.keys()].map((x) => x.slice(BUCKET.length + 1)), callsOf: (op: string) => calls.filter((c) => c.op === op),
  };
}
export type Storage = ReturnType<typeof makeStorage>;

/** Fake scanner: EICAR => infected; `mode` overrides; counts calls. */
export function makeScanner() {
  const s = { mode: 'auto' as 'auto' | 'clean' | 'infected' | 'unavailable' | 'throw', calls: 0 };
  const scan = async (bytes: Uint8Array): Promise<'clean' | 'infected' | 'unavailable'> => {
    s.calls++; if (s.mode === 'throw') throw new Error('clamd down'); if (s.mode !== 'auto') return s.mode;
    return Buffer.from(bytes).includes('EICAR-STANDARD-ANTIVIRUS-TEST-FILE') ? 'infected' : 'clean';
  };
  return Object.assign(s, { scan });
}

/** One test world: object store + scanner + captured enqueues, shared across the handler calls of a test. */
export function makeWorld(tenantId = TENANT_A) {
  const storage = makeStorage(tenantId); const scanner = makeScanner();
  const jobs: Array<{ identifier: string; payload: any; jobKey: string | null }> = [];
  return { storage, scanner, jobs, jobsOf: (id: string) => jobs.filter((j) => j.identifier === id) };
}
export type World = ReturnType<typeof makeWorld>;

export interface Opts { grants?: readonly string[]; tenant?: string; centreIds?: readonly string[]; w?: World; uploads?: unknown; requestId?: string; displayName?: string }
export interface Reply { status: number; body: any; headers?: Record<string, string>; probe: { logs: string[]; accessCalls: any[]; identity: any; requestId: string; membershipId: string; w: World; ctx: any } }
const H = handlers as unknown as Record<string, (req: any, ctx: any) => Promise<{ status: number; body?: any; headers?: Record<string, string> }>>;

/** One request = one committed tx under RLS with the tenant's claims. */
export async function call(operationId: 'uploadTrf' | 'getTrfAttachment' | 'getTrfAttachmentContent', r: ReturnType<typeof req>, o: Opts = {}): Promise<Reply> {
  const tenant = o.tenant ?? TENANT_A;
  const side = tenant === TENANT_B ? 'b' : 'a';
  const w = o.w ?? makeWorld(tenant);
  const identity: any = makeIdentity(o.grants ?? [UPLOAD, READ], { centreIds: o.centreIds ?? [CENTRE[side]], ...(o.displayName ? { displayName: o.displayName } : {}) });
  const probe = { logs: [] as string[], accessCalls: [] as any[], identity, requestId: o.requestId ?? uid(), membershipId: uid(), w, ctx: undefined as any };
  const out = await appTx(tenant, async (tx) => {
    const log = (lvl: string) => (obj: object, msg?: string) => { probe.logs.push(`${lvl} ${JSON.stringify(obj)} ${msg ?? ''}`); };
    const wrapped: any = {
      query: async (text: string, values: unknown[] = []) => {
        if (/app\.enqueue_job/i.test(text) && typeof values[0] === 'string') {
          w.jobs.push({ identifier: values[0], payload: typeof values[1] === 'string' ? JSON.parse(values[1]) : values[1], jobKey: (values[2] as string | null) ?? null });
          return { rows: [{ enqueue_job: null }], rowCount: 1 };
        }
        return tx.query(text, values);
      },
    };
    const ctx: any = {
      operationId, clientIp: '203.0.113.9', log: { info: log('info'), warn: log('warn'), error: log('error'), debug: log('debug') }, metrics: { inc: () => undefined },
      tenantId: tenant, tx: wrapped, requestId: probe.requestId, now: () => NOW, centreId: CENTRE[side],
      actor: { type: 'user', id: SYS_ACTOR, membershipId: probe.membershipId },
      ports: { IdentityPort: identity }, storage: w.storage.adapter, files: { scan: w.scanner.scan },
    };
    ctx.uploads = o.uploads ?? createUploads({ files: { scan: w.scanner.scan }, storage: w.storage.adapter as any, module: 'frontdesk', tenantId: tenant, log: { warn: (obj: object, msg?: string) => ctx.log.warn(obj, msg) } });
    ctx.audit = { access: async (e: any) => { probe.accessCalls.push(e); await access(ctx, e); } };
    ctx.download = createDownload({ storage: w.storage.adapter as any, audit: ctx.audit });
    probe.ctx = ctx;
    return H[operationId]!(r, ctx);
  });
  return { ...(out as any), probe };
}
export const upload = (body: Record<string, unknown>, o: Opts = {}) => call('uploadTrf', req({ body, headers: { 'idempotency-key': uid() } }), o);
export const uploadFails = (body: Record<string, unknown>, o: Opts = {}) => rejection(upload(body, o));
export const meta = (id: string, o: Opts = {}) => call('getTrfAttachment', req({ params: { attachment_id: id } }), o);
export const metaFails = (id: string, o: Opts = {}) => rejection(meta(id, o));
export const content = (id: string, o: Opts = {}) => call('getTrfAttachmentContent', req({ params: { attachment_id: id } }), o);
export const contentFails = (id: string, o: Opts = {}) => rejection(content(id, o));

/** A committed TRF row (+ its object in the fake store when `bytes` is given). Default: a clean A1 PDF, draft. */
export async function seedTrf(w: World, o: { side?: 'a' | 'b'; centre?: string; state?: string; orderId?: string | null; bytes?: Uint8Array; mime?: string; filename?: string; path?: string; noObject?: boolean; row?: Record<string, unknown> } = {}): Promise<any> {
  const side = o.side ?? 'a'; const tenant = side === 'a' ? TENANT_A : TENANT_B;
  const id = uid(); const bytes = o.bytes ?? pdfBytes('seed'); const state = o.state ?? 'clean';
  const path = o.path ?? (state === 'clean' ? `${tenant}/2026/11/${id}.pdf` : `${tenant}/q/2026/11/${id}.pdf`);
  const row = { ...rows.trf(side, o.orderId ?? null, { id, centre_id: o.centre ?? CENTRE[side], object_path: path, mime_type: o.mime ?? 'application/pdf', size_bytes: bytes.length, sha256: sha(bytes),
    original_filename: o.filename ?? 'synthetic-trf.pdf', scan_state: state, created_by: SYS_ACTOR, updated_by: SYS_ACTOR, ...(state !== 'pending' ? { scanned_at: '2026-11-09T04:00:00Z' } : {}), ...(o.row ?? {}) }) };
  await seed('frontdesk.trf_attachments', row);
  if (!o.noObject) w.storage.seed(path, bytes);
  return row;
}
/** An order of tenant A (centre A1 by default) to link uploads to. */
export async function seedOrderFor(side: 'a' | 'b' = 'a', centre?: string): Promise<any> {
  const patient = await seedPatient(side, {});
  const c = centre ?? CENTRE[side]; const branch = c === CENTRE_A2 ? BRANCH_A2 : BRANCH[side];
  const order = rows.order(side, patient.id, { centre_id: c, branch_id: branch, registration_no: `FDT10-${Date.now() % 1e6}-${Math.floor(Math.random() * 1e6)}` });
  await seed('frontdesk.orders', order);
  return order;
}
export const trfRow = async (id: string) => (await ownerRows('frontdesk.trf_attachments', 'id = $1', [id]))[0];
export const trfCount = async (tenant: string) => Number((await superTx(async (tx) => (await tx.query('SELECT count(*)::int AS n FROM frontdesk.trf_attachments WHERE tenant_id = $1', [tenant])).rows[0].n)));
export const viewRows = async (entityId: string) => ownerRows('audit.access_log', `action = 'trf.view' AND entity_id = $1 ORDER BY created_at, id`, [entityId]);
