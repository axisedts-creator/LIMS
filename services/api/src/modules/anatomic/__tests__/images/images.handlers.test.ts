// C11.T-10 — images: I1 uploadAnatomicImage, I2 getAnatomicImageContent, I3 updateAnatomicImage, I4 deactivateAnatomicImage (02-TRD §4.9, §5 I1–I4 + "Edits on a signed_out case", §12 access-log table;
// 01-PRD AC-12.1…12.8; 07-SECURITY REQ-SEC-083…085, §5.5 content/upload tests, §5.6 log scan; 08 A17 P-19, D-66, D-67; 05-SCHEMA `anatomic.images` + CHECKs).
// Drives the REAL handlers (manifest.handlers) on IN-MEMORY repositories (vi.mock of images/cases/parts/drafts/versions/config repo with the T-04 signatures; the images mock emulates the table CHECKs:
// path regex + tenant prefix, state <-> scan_state, quarantine_reason_code, ready needs sha256/mime/size, caption <= 200, scan_attempts 0..5) and a FAKE PIPELINE (see `makePipeline`):
//   the REAL core createUploads (size 413, extension/mime/magic 415, PNG re-encode, tenant path + bucket-owner rules) over a fake storage, with the returned `scanState` forced to the value under test
//   (pending/clean/infected/unavailable), because CR-C11-008 / CR-C2-011 (real pipeline: JPEG re-encode, 50 MP cap, scan outcomes) are not merged (06-PLAN T-10 "fake before"). The REAL core createDownload
//   serves I2 and the REAL core `access` writes the access-log row (so the headers and the log row are the platform's, not a test double's).
// SEAMS (spec fixes behaviour; names chosen here — the writer follows or disputes):
//   * Multipart request body (core parser shape, as instruments attachments): { file: { filename, mimetype, data: Buffer }, kind, part_id?, caption? }; params { case_id }; I3 JSON body { kind, part_id?, caption? }
//     with header 'if-match' = '"<image.version>"'; I4 If-Match likewise. Responses: I1 201, I2 200 (core download result, headers lower-case), I3/I4 200 with the `Image` schema (closed key set, no nulls).
//   * Order per handler: load target through the tenant-bound repo (404) -> IdentityPort.assertRole({ permission, centreId: case.centre_id }) (I1/I3/I4 'anatomic.case.work', I2 'anatomic.case.read') -> validate -> write.
//   * I1 passes ctx.uploads.accept exactly { allow:['image/png','image/jpeg'], maxBytes: config.imageMaxBytes, images:{ reencode:true, stripMetadata:true, maxMegapixels: config.imageMaxMegapixels },
//     scan:'required', bucket:'anatomic-images', objectPath:'<tenant>/<yyyy UTC>/<mm UTC>/<image_id>.<png|jpg>' } where <image_id> = the new row id (the test clock is 2026-12-31T23:30Z: UTC month 2026/12, Kathmandu would be 2027/01).
//   * Row from AcceptedUpload: sha256/byte_size/mime_type of the STORED object, width_px/height_px from `image`, scan_state = scanState, state ready | quarantined (+ quarantine_reason_code 'malware') | processing;
//     processing => ONE `SELECT app.enqueue_job($1, $2::jsonb, $3)` with ('anatomic.process_image', {image_id[, tenant_id]}, 'image:<image_id>') on ctx.tx AFTER the row insert, in the same transaction (a failing enqueue rolls the row back).
//   * Limit: active images of the case (is_active) >= settings.max_images_per_case -> 422 anatomic.image_limit_reached, before the pipeline is called, nothing stored.
//   * I3 is a full replace of { kind, part_id, caption } (PUT): an omitted part_id / caption is cleared. Image in a signed version = some report_versions.images[].object_path equals the image's object_path.
//   * An other-case / other-tenant part_id is refused with common.validation_failed or common.not_found (both leak nothing).
// Fails now: I1–I4 are 501 / common.internal stubs.
import { createHash, randomBytes } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { access } from '../../../../core/audit/access.js';
import { LimsError, isLimsError } from '../../../../core/errors.js';
import { assertBucket, assertOwned, assertTenantPath } from '../../../../core/storage/index.js';
import { createDownload } from '../../../../core/storage/download.js';
import { createUploads } from '../../../../core/uploads/index.js';

type Row = Record<string, any>;
const S = vi.hoisted(() => ({
  cases: new Map<string, Record<string, any>>(), parts: new Map<string, Record<string, any>>(), images: new Map<string, Record<string, any>>(), versions: [] as Record<string, any>[],
  drafts: new Set<string>(), settings: new Map<string, Record<string, any>>(), jobs: [] as Record<string, any>[], events: [] as string[], writes: 0, seq: 0,
}));
const pgErr = (code: string, constraint: string) => Object.assign(new Error('constraint violation'), { code, constraint });
const undo = (tx: unknown, f: () => void) => { (tx as { undo?: (() => void)[] } | undefined)?.undo?.push(f); };
const mine = (i: Row) => [...S.images.values()].filter((r) => r['tenant_id'] === i['tenantId']);
const NOW_ISO = '2026-12-31T23:30:00.000Z';

const IMG_UPDATABLE = ['part_id', 'kind', 'caption', 'state', 'quarantine_reason_code', 'scan_state', 'scan_attempts', 'is_active'];
function checkImage(r: Row) {
  if (!/^[0-9a-f-]{36}\/[0-9]{4}\/[0-9]{2}\/[0-9a-f-]{36}\.(png|jpg)$/.test(r['object_path'] ?? '') || String(r['object_path']).split('/')[0] !== r['tenant_id']) throw pgErr('23514', 'images__path__ck');
  if (!['gross', 'microscopy', 'other'].includes(r['kind'])) throw pgErr('23514', 'images__kind__ck');
  if (r['bucket'] !== 'anatomic-images') throw pgErr('23514', 'images__bucket__ck');
  if (!['processing', 'ready', 'quarantined'].includes(r['state'])) throw pgErr('23514', 'images__state__ck');
  if (!(['pending', 'clean', 'infected', 'unavailable'].includes(r['scan_state']) && ((r['state'] === 'ready') === (r['scan_state'] === 'clean')) && ((r['state'] === 'quarantined') === (r['scan_state'] === 'infected'))
    && r['scan_attempts'] >= 0 && r['scan_attempts'] <= 5)) throw pgErr('23514', 'images__scan__ck');
  if (!((r['state'] === 'quarantined') === (r['quarantine_reason_code'] != null) && (r['quarantine_reason_code'] == null || /^[a-z_]{1,32}$/.test(r['quarantine_reason_code'])))) throw pgErr('23514', 'images__quarantine__ck');
  if (r['state'] === 'ready' && !(/^[0-9a-f]{64}$/.test(r['sha256'] ?? '') && ['image/png', 'image/jpeg'].includes(r['mime_type']) && r['byte_size'] >= 1 && r['byte_size'] <= 15728640)) throw pgErr('23514', 'images__ready__ck');
  if (String(r['caption'] ?? '').length > 200) throw pgErr('23514', 'images__caption__ck');
}

vi.mock('../../repository/images.repo.js', async (orig) => ({
  ...((await orig()) as Row),
  async insertImage(tx: unknown, row: Row) {
    S.writes++;
    for (const k of ['id', 'tenant_id', 'centre_id', 'case_id', 'kind', 'object_path', 'scan_state', 'created_by', 'updated_by']) if (row[k] == null) throw pgErr('23502', `images__${k}__nn`);
    const r: Row = { bucket: 'anatomic-images', state: 'processing', scan_attempts: 0, quarantine_reason_code: null, part_id: null, caption: null, is_active: true, version: 1, created_at: NOW_ISO, updated_at: NOW_ISO,
      ...Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined && v !== null)) };
    checkImage(r);
    if ([...S.images.values()].some((x) => x['tenant_id'] === r['tenant_id'] && x['object_path'] === r['object_path'])) throw pgErr('23505', 'images__tenant_id_object_path__uq');
    S.images.set(r['id'], r); S.events.push('insertImage'); undo(tx, () => S.images.delete(r['id'])); return { ...r };
  },
  async getImage(_tx: unknown, i: Row) { const r = S.images.get(i['id']); return r && r['tenant_id'] === i['tenantId'] ? { ...r } : undefined; },
  async listImages(_tx: unknown, i: Row) {
    return mine(i).filter((r) => r['case_id'] === i['caseId'] && (!i['activeOnly'] || r['is_active'])).sort((a, b) => (a['created_at'] < b['created_at'] ? -1 : a['id'] < b['id'] ? -1 : 1)).map((r) => ({ ...r }));
  },
  async updateImage(tx: unknown, i: { tenantId: string; id: string; expectedVersion: number; actorId: string; patch: Row }) {
    S.writes++;
    for (const k of Object.keys(i.patch)) if (i.patch[k] !== undefined && !IMG_UPDATABLE.includes(k)) throw new Error(`anatomic repo: column '${k}' is not updatable`);
    const r = S.images.get(i.id);
    if (!r || r['tenant_id'] !== i.tenantId || r['version'] !== i.expectedVersion) return undefined;
    const next = { ...r, ...Object.fromEntries(Object.entries(i.patch).filter(([, v]) => v !== undefined)), version: r['version'] + 1, updated_by: i.actorId, updated_at: NOW_ISO };
    checkImage(next); S.images.set(i.id, next); S.events.push('updateImage'); undo(tx, () => S.images.set(i.id, r)); return { ...next };
  },
}));
vi.mock('../../repository/cases.repo.js', async (orig) => ({
  ...((await orig()) as Row),
  async getCase(_tx: unknown, i: Row) { const r = S.cases.get(i['caseId']); return r && r['tenant_id'] === i['tenantId'] ? { ...r } : undefined; },
}));
vi.mock('../../repository/parts.repo.js', async (orig) => ({
  ...((await orig()) as Row),
  async getPart(_tx: unknown, i: Row) { const r = S.parts.get(i['id']); return r && r['tenant_id'] === i['tenantId'] ? { ...r } : undefined; },
  async listParts(_tx: unknown, i: Row) { return [...S.parts.values()].filter((r) => r['tenant_id'] === i['tenantId'] && r['case_id'] === i['caseId']).map((r) => ({ ...r })); },
}));
vi.mock('../../repository/drafts.repo.js', async (orig) => ({
  ...((await orig()) as Row),
  async getOpenDraft(_tx: unknown, i: Row) { return S.drafts.has(i['caseId']) ? { id: 'draft', case_id: i['caseId'], tenant_id: i['tenantId'], kind: 'revision', version: 1 } : undefined; },
}));
vi.mock('../../repository/versions.repo.js', async (orig) => ({
  ...((await orig()) as Row),
  async listReportVersions(_tx: unknown, i: Row) { return S.versions.filter((v) => v['tenant_id'] === i['tenantId'] && v['case_id'] === i['caseId']).map((v) => structuredClone(v)); },
  async getLatestReportVersion(_tx: unknown, i: Row) {
    return S.versions.filter((v) => v['tenant_id'] === i['tenantId'] && v['case_id'] === i['caseId']).sort((a, b) => b['version_no'] - a['version_no']).map((v) => structuredClone(v))[0];
  },
}));
vi.mock('../../repository/config.repo.js', async (orig) => ({
  ...((await orig()) as Row),
  async getSettings(_tx: unknown, i: Row) { const r = S.settings.get(i['tenantId']); return r ? { ...r } : undefined; },
  async insertSettings(_tx: unknown, row: Row) { S.writes++; const r = { id: 'settings', version: 1, max_images_per_case: 50, max_report_images: 12, ...row }; S.settings.set(row['tenant_id'], r); return { ...r }; },
}));

const { manifest, config } = await import('../../index.js');

// ------------------------------------------------------------------------------------------------ ids and fixtures
const uid = (n: number) => `0190c411-0000-7000-8000-${String(n).padStart(12, '0')}`;
const T = '01a1a98a-ac40-7000-8000-00000000a001', T_OTHER = '01a1a98a-ac40-7000-8000-00000000b001', ACTOR = '01a1a98a-ac40-7000-8000-00000000a300';
const C1 = '01a1a98a-ac40-7000-8000-00000000a201', C2 = '01a1a98a-ac40-7000-8000-00000000a202', C_B = '01a1a98a-ac40-7000-8000-00000000b201';
const CASE = { OPEN: uid(101), SIGNED: uid(102), SIGNED_DRAFT: uid(103), OTHER_TENANT: uid(104), C2: uid(105), LIMIT: uid(106) };
const PART = { A: uid(201), SIGNED_A: uid(202), OTHER_TENANT: uid(203), LIMIT_A: uid(204) };
const IMG = { READY: uid(301), JPEG: uid(302), PROCESSING: uid(303), QUARANTINED: uid(304), SIGNED_IN: uid(305), FREE_ON_SIGNED: uid(306), OTHER_TENANT: uid(307), C2: uid(308), DRAFT_IN: uid(309) };
const PLANTED_FILENAME = 'Test-Patient-0042-left-arm.png';
const PLANTED_CAPTION = 'Test Patient 0042 left arm';
const GPS = 'GPS-LAT-27.7172N-LON-85.3240E-SENTINEL';
const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
const MiB = 1024 * 1024;

// valid 8-bit RGB PNG (synthetic); `meta` adds tEXt/eXIf chunks carrying a GPS sentinel that must not survive the re-encode; `noise` = incompressible pixels
function chunk(type: string, data: Buffer): Buffer {
  const t = Buffer.from(type, 'latin1'); const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0);
  return Buffer.concat([len, t, data, crc]);
}
function pngBytes(o: { w?: number; h?: number; meta?: boolean; noise?: boolean } = {}): Buffer {
  const w = o.w ?? 4, h = o.h ?? 4; const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.concat(Array.from({ length: h }, () => Buffer.concat([Buffer.from([0]), o.noise ? randomBytes(w * 3) : Buffer.alloc(w * 3, 0x7f)])));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr),
    ...(o.meta ? [chunk('tEXt', Buffer.from(`Comment\0${GPS}`, 'latin1')), chunk('eXIf', Buffer.from(GPS, 'latin1'))] : []), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const jpegBytes = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 0x11), Buffer.from([0xff, 0xd9])]);
const pdfBytes = () => Buffer.from('%PDF-1.4\n1 0 obj<< /Type /Catalog >>endobj\ntrailer<< /Root 1 0 R >>\n%%EOF\n', 'latin1');
const SMALL = pngBytes();
let BIG_PNG: Buffer | undefined;
const png2mb = () => (BIG_PNG ??= pngBytes({ w: 830, h: 830, noise: true }));   // ~2.07 MB of incompressible pixels

// ------------------------------------------------------------------------------------------------ fake storage + fake pipeline
function makeStorage() {
  const objects = new Map<string, Buffer>(); const calls: Array<{ op: string; bucket: string; path: string }> = [];
  const k = (b: string, p: string) => `${b}/${p}`;
  const adapter = {
    async put(bucket: any, path: string, bytes: Uint8Array, o: { contentType: string; ifAbsent?: boolean }) {
      assertOwned('anatomic', bucket); assertTenantPath(T, path); calls.push({ op: 'put', bucket, path });
      if (o.ifAbsent && objects.has(k(bucket, path))) throw new Error('exists');
      objects.set(k(bucket, path), Buffer.from(bytes)); return { sha256: sha(bytes), byteSize: bytes.length };
    },
    async read(bucket: any, path: string) { assertBucket(bucket); assertTenantPath(T, path); calls.push({ op: 'read', bucket, path }); const v = objects.get(k(bucket, path)); if (!v) throw new LimsError('common.not_found'); return new Uint8Array(v); },
    async move(_b: any, from: string, to: string) { calls.push({ op: 'move', bucket: 'anatomic-images', path: `${from} -> ${to}` }); },
    async delete(bucket: any, path: string) { calls.push({ op: 'delete', bucket, path }); objects.delete(k(bucket, path)); },
    async signedUrl(bucket: any, path: string) { calls.push({ op: 'signedUrl', bucket, path }); return 'https://storage.invalid/SECRET-URL-SENTINEL'; },
  };
  return { adapter, calls, objects, seed: (path: string, bytes: Uint8Array) => { objects.set(k('anatomic-images', path), Buffer.from(bytes)); }, get: (path: string) => objects.get(k('anatomic-images', path)),
    paths: () => [...objects.keys()].map((x) => x.slice('anatomic-images/'.length)), callsOf: (op: string) => calls.filter((c) => c.op === op) };
}
type ScanState = 'pending' | 'clean' | 'infected' | 'unavailable';
function makePipeline(storage: ReturnType<typeof makeStorage>, tenantId: string, scanState: ScanState) {
  const real = createUploads({ files: { scan: async () => 'clean' as const }, storage: storage.adapter as any, module: 'anatomic', tenantId });
  const seen: Array<{ opts: any; filename: string; mimeType: string }> = [];
  const uploads = {
    async accept(file: any, opts: any) {
      seen.push({ opts: structuredClone(opts), filename: file?.filename, mimeType: file?.mimeType });
      // the real pipeline re-encodes PNG only and caps megapixels at 40 (CR-C11-008 / CR-C2-011 pending): the fake keeps the size/type/path/bucket rules and drops what it cannot do yet
      const isJpeg = /\.jpe?g$/i.test(String(file?.filename)) || String(file?.mimeType).startsWith('image/jpeg');
      const adj = { ...opts, images: isJpeg || !opts.images ? undefined : { ...opts.images, maxMegapixels: Math.min(opts.images.maxMegapixels ?? 40, 40) } };
      const r = await real.accept(file, adj);
      return { ...r, ...(r.image ? {} : { image: { width: 640, height: 480 } }), scanState };
    },
  };
  return { uploads, seen };
}

// ------------------------------------------------------------------------------------------------ ctx
interface CtxOpts { deny?: Record<string, string>; tenant?: string; denyCentre?: string; scan?: ScanState; failEnqueue?: boolean; now?: string }
const calls = { assertRole: [] as Row[], logs: [] as string[], access: [] as Row[] };
function mkCtx(o: CtxOpts = {}) {
  const tenantId = o.tenant ?? T; const storage = makeStorage(); const pipe = makePipeline(storage, tenantId, o.scan ?? 'clean');
  const lg = (x: object, m?: string) => calls.logs.push(JSON.stringify({ x, m })); const incs: Array<{ name: string; labels: unknown }> = [];
  const ctx: any = {
    operationId: 'op', clientIp: '203.0.113.7', requestId: uid(9999), log: { info: lg, warn: lg, error: lg, debug: lg }, metrics: { inc: (name: string, labels?: unknown) => { incs.push({ name, labels }); } }, _incs: incs,
    tenantId, actor: { type: 'user', id: ACTOR, membershipId: uid(5000) }, now: () => new Date(o.now ?? NOW_ISO),
    tx: {
      undo: [] as (() => void)[],
      async query(text: string, values: unknown[] = []) {
        if (/app\.enqueue_job/i.test(text)) {
          if (o.failEnqueue) throw new Error('queue unavailable');
          const j = { identifier: values[0], payload: typeof values[1] === 'string' ? JSON.parse(values[1]) : values[1], jobKey: values[2] ?? null, text }; S.jobs.push(j); S.events.push('enqueue'); undo(ctx.tx, () => S.jobs.pop()); return { rows: [{ enqueue_job: null }] };
        }
        if (/audit\.access_log/i.test(text)) {
          const row = { centreId: values[2], action: values[7], entityType: values[8], entityId: values[9], outcome: values[11], detail: values[12], actorId: values[3] };
          calls.access.push(row); S.events.push('access'); undo(ctx.tx, () => calls.access.pop()); return { rows: [] };
        }
        return { rows: [] };
      },
    },
    core: { async branch() { return { branchCode: 'KTM' }; } },
    ports: {
      IdentityPort: {
        async assertRole(_c: unknown, i: Row) {
          calls.assertRole.push(structuredClone(i));
          const d = o.deny?.[i['permission']]; if (d) throw new LimsError(d);
          if (o.denyCentre && i['centreId'] === o.denyCentre) throw new LimsError('common.not_found');
        },
        async getTenantSettings() { return { timezone: 'Asia/Kathmandu' }; },
      },
    },
    uploads: pipe.uploads, files: { scan: async () => 'clean' }, storage: storage.adapter,
  };
  ctx.audit = { access: (e: any) => access(ctx, e) };
  ctx.download = createDownload({ storage: storage.adapter as any, audit: ctx.audit });
  return Object.assign(ctx, { _storage: storage, _pipe: pipe });
}
type Ctx = ReturnType<typeof mkCtx>;

/** emulates requestTx: a throwing handler rolls back every write made through ctx.tx (undo journal kept by the mocks) */
async function call(op: string, req: Row, ctx: Ctx = mkCtx()): Promise<any> {
  try { return await (manifest.handlers as any)[op]({ params: {}, query: {}, headers: {}, body: {}, ...req }, ctx); } catch (e) {
    for (const u of [...ctx.tx.undo].reverse()) u();
    throw e;
  }
}
const rejects = async (p: Promise<unknown>): Promise<any> => p.then(() => { throw new Error('expected rejection'); }, (e: unknown) => e);
const ifm = (v: number) => ({ 'if-match': `"${v}"` });
const hdr = (r: any, name: string): string | undefined => { const k = Object.keys(r?.headers ?? {}).find((x) => x.toLowerCase() === name.toLowerCase()); return k ? r.headers[k] : undefined; };
const codeOf = (e: any, code: string, status?: number) => { expect(isLimsError(e, code), `expected ${code}, got ${e?.code} ${e?.message}`).toBe(true); if (status) expect((e as LimsError).statusCode).toBe(status); };
const hasNoNulls = (x: unknown): boolean => x === null ? false : Array.isArray(x) ? x.every(hasNoNulls) : x && typeof x === 'object' ? Object.values(x).every(hasNoNulls) : true;
const IMAGE_KEYS = ['id', 'kind', 'part_id', 'caption', 'state', 'mime_type', 'width_px', 'height_px', 'created_at', 'is_active', 'version'];
const REQUIRED_KEYS = ['id', 'kind', 'state', 'created_at', 'is_active', 'version'];
function imageShape(b: Row) {
  for (const k of Object.keys(b)) expect(IMAGE_KEYS, `unexpected key ${k} in Image`).toContain(k);
  for (const k of REQUIRED_KEYS) expect(b, `missing ${k}`).toHaveProperty(k);
  expect(hasNoNulls(b)).toBe(true);
}
const imagesOf = (caseId: string) => [...S.images.values()].filter((r) => r['case_id'] === caseId);
const stateDump = () => JSON.stringify({ i: [...S.images], j: S.jobs, w: S.writes });

const caseRow = (id: string, over: Row = {}): Row => ({ id, tenant_id: T, centre_id: C1, case_kind: 'histology', status: 'in_processing', version: 4, accession_no: `SYN-H-${id.slice(-3)}`, ...over });
const imgRow = (id: string, caseId: string, over: Row = {}): Row => ({
  id, tenant_id: T, centre_id: C1, case_id: caseId, part_id: null, kind: 'gross', caption: null, bucket: 'anatomic-images', object_path: `${T}/2026/11/${id}.png`, state: 'ready', quarantine_reason_code: null,
  scan_state: 'clean', scan_attempts: 0, mime_type: 'image/png', byte_size: SMALL.length, sha256: sha(SMALL), width_px: 4, height_px: 4, is_active: true, version: 1,
  created_at: '2026-11-10T00:00:00.000Z', updated_at: '2026-11-10T00:00:00.000Z', created_by: ACTOR, updated_by: ACTOR, ...over });
const SIGNED_VERSION = (images: Row[], caseId = CASE.SIGNED): Row => ({ id: uid(701), tenant_id: T, centre_id: C1, case_id: caseId, version_no: 1, version_kind: 'original', scope: 'full', images, created_at: '2026-11-11T00:00:00Z' });

function seed() {
  S.cases.set(CASE.OPEN, caseRow(CASE.OPEN)); S.cases.set(CASE.SIGNED, caseRow(CASE.SIGNED, { status: 'signed_out' })); S.cases.set(CASE.SIGNED_DRAFT, caseRow(CASE.SIGNED_DRAFT, { status: 'signed_out' }));
  S.cases.set(CASE.OTHER_TENANT, caseRow(CASE.OTHER_TENANT, { tenant_id: T_OTHER, centre_id: C_B })); S.cases.set(CASE.C2, caseRow(CASE.C2, { centre_id: C2 }));
  S.cases.set(CASE.LIMIT, caseRow(CASE.LIMIT));
  S.drafts.add(CASE.SIGNED_DRAFT);
  const part = (id: string, caseId: string, over: Row = {}) => S.parts.set(id, { id, tenant_id: T, case_id: caseId, letter: 'A', site_text: 'synthetic site', version: 1, ...over });
  part(PART.A, CASE.OPEN); part(PART.SIGNED_A, CASE.SIGNED); part(PART.OTHER_TENANT, CASE.OTHER_TENANT, { tenant_id: T_OTHER }); part(PART.LIMIT_A, CASE.LIMIT);
  S.settings.set(T, { id: 'settings', tenant_id: T, version: 1, max_images_per_case: 50, max_report_images: 12 }); // spec default (02-TRD:623, 05-SCHEMA:180); the limit tests lower it themselves (ruling C11.T-10)
  const add = (r: Row) => S.images.set(r['id'], r);
  add(imgRow(IMG.READY, CASE.OPEN, { part_id: PART.A, caption: 'synthetic caption' }));
  add(imgRow(IMG.JPEG, CASE.OPEN, { object_path: `${T}/2026/11/${IMG.JPEG}.jpg`, mime_type: 'image/jpeg', sha256: sha(jpegBytes()), byte_size: jpegBytes().length, kind: 'microscopy' }));
  add(imgRow(IMG.PROCESSING, CASE.OPEN, { state: 'processing', scan_state: 'pending' }));
  add(imgRow(IMG.QUARANTINED, CASE.OPEN, { state: 'quarantined', scan_state: 'infected', quarantine_reason_code: 'malware' }));
  add(imgRow(IMG.SIGNED_IN, CASE.SIGNED, { part_id: PART.SIGNED_A, caption: 'in the signed report' }));
  add(imgRow(IMG.FREE_ON_SIGNED, CASE.SIGNED, { kind: 'microscopy' }));
  add(imgRow(IMG.DRAFT_IN, CASE.SIGNED_DRAFT, {}));
  add(imgRow(IMG.OTHER_TENANT, CASE.OTHER_TENANT, { tenant_id: T_OTHER, centre_id: C_B, object_path: `${T_OTHER}/2026/11/${IMG.OTHER_TENANT}.png` }));
  add(imgRow(IMG.C2, CASE.C2, { centre_id: C2 }));
  S.versions.push(SIGNED_VERSION([{ bucket: 'anatomic-images', object_path: `${T}/2026/11/${IMG.SIGNED_IN}.png`, sha256: sha(SMALL), caption: 'in the signed report' }]));
  S.versions.push({ ...SIGNED_VERSION([{ bucket: 'anatomic-images', object_path: `${T}/2026/11/${IMG.DRAFT_IN}.png`, sha256: sha(SMALL) }], CASE.SIGNED_DRAFT), id: uid(702) });
}
/** seeds the stored objects for the images that exist in the world into the ctx storage */
function seedObjects(ctx: Ctx) {
  for (const r of S.images.values()) if (r['tenant_id'] === T) ctx._storage.seed(r['object_path'], r['mime_type'] === 'image/jpeg' ? jpegBytes() : SMALL);
}
let consoleSpies: Array<ReturnType<typeof vi.spyOn>> = [];
beforeEach(() => {
  for (const m of [S.cases, S.parts, S.images, S.settings]) m.clear();
  S.versions.length = 0; S.drafts.clear(); S.jobs.length = 0; S.events.length = 0; S.writes = 0; S.seq = 0;
  calls.assertRole.length = 0; calls.logs.length = 0; calls.access.length = 0;
  seed(); S.writes = 0;
  consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
});
afterEach(() => { for (const s of consoleSpies) s.mockRestore(); });

const file = (bytes: Uint8Array, o: { filename?: string; mimetype?: string } = {}) => ({ filename: o.filename ?? 'scan.png', mimetype: o.mimetype ?? 'image/png', data: Buffer.from(bytes) });
const up = (body: Row, caseId = CASE.OPEN, ctx: Ctx = mkCtx()) => call('uploadAnatomicImage', { params: { case_id: caseId }, body }, ctx);
const goodBody = (o: Row = {}) => ({ file: file(SMALL), kind: 'gross', ...o });
const nothingPersisted = (ctx: Ctx, before: string) => { expect(stateDump()).toBe(before); expect(ctx._storage.callsOf('put')).toEqual([]); expect(ctx._storage.objects.size).toBe(0); };

// ================================================================================================ I1 upload
describe('I1 uploadAnatomicImage — scan outcome model (AC-12.1, AC-12.4; 08 A17 P-19; TRD §4.9)', () => {
  it('AC-12.1: a 2 MB PNG the pipeline scans clean, uploaded as a gross image of part A -> 201, state ready, stored object path rule, row from AcceptedUpload, no job', async () => {
    const big = png2mb(); expect(big.length).toBeGreaterThan(2 * 1000 * 1000);
    const ctx = mkCtx({ scan: 'clean' });
    const r = await up({ file: file(big, { filename: PLANTED_FILENAME }), kind: 'gross', part_id: PART.A, caption: 'synthetic caption' }, CASE.OPEN, ctx);
    expect(r.status).toBe(201); imageShape(r.body);
    expect(r.body).toMatchObject({ kind: 'gross', part_id: PART.A, caption: 'synthetic caption', state: 'ready', mime_type: 'image/png', is_active: true, version: 1 });
    expect(r.body.width_px).toBe(830); expect(r.body.height_px).toBe(830);
    const row = S.images.get(r.body.id)!; expect(row).toBeDefined();
    expect(row).toMatchObject({ tenant_id: T, centre_id: C1, case_id: CASE.OPEN, part_id: PART.A, kind: 'gross', bucket: 'anatomic-images', state: 'ready', scan_state: 'clean', scan_attempts: 0, mime_type: 'image/png',
      created_by: ACTOR, updated_by: ACTOR, quarantine_reason_code: null });
    const stored = ctx._storage.get(row['object_path'])!; expect(stored, 'object stored at the row path').toBeDefined();
    expect(row['sha256']).toBe(sha(stored)); expect(row['byte_size']).toBe(stored.length);
    expect(S.jobs).toEqual([]);                                   // clean: no re-scan job
    expect(ctx._storage.paths()).toEqual([row['object_path']]);   // exactly one object
  });

  it('AC-12.5: object path = {tenant_id}/{yyyy}/{mm}/{image_id}.png in bucket anatomic-images, yyyy/mm from the UTC clock (23:30Z on 31 Dec is still 2026/12, not Kathmandu 2027/01)', async () => {
    const ctx = mkCtx({ scan: 'clean', now: '2026-12-31T23:30:00Z' });
    const r = await up(goodBody(), CASE.OPEN, ctx); const row = S.images.get(r.body.id)!;
    expect(row['object_path']).toBe(`${T}/2026/12/${r.body.id}.png`);
    expect(row['bucket']).toBe('anatomic-images');
    const ctx2 = mkCtx({ scan: 'clean', now: '2027-01-01T00:00:00Z' }); const r2 = await up(goodBody(), CASE.OPEN, ctx2);
    expect(S.images.get(r2.body.id)!['object_path']).toBe(`${T}/2027/01/${r2.body.id}.png`);
  });

  it('x-upload list: ctx.uploads.accept gets exactly allow [png, jpeg] ⊆ x-upload, maxBytes = LIMS_ANATOMIC_IMAGE_MAX_BYTES (15 MB), re-encode + strip metadata + megapixel cap, scan required, bucket and path', async () => {
    const ctx = mkCtx({ scan: 'clean' }); const r = await up(goodBody(), CASE.OPEN, ctx);
    expect(ctx._pipe.seen).toHaveLength(1);
    const { opts } = ctx._pipe.seen[0]!;
    expect([...opts.allow].sort()).toEqual(['image/jpeg', 'image/png']);
    expect(opts.maxBytes).toBe(config.imageMaxBytes); expect(opts.maxBytes).toBe(15 * MiB);
    expect(opts.images).toEqual({ reencode: true, stripMetadata: true, maxMegapixels: config.imageMaxMegapixels });
    expect(opts.scan).toBe('required'); expect(opts.bucket).toBe('anatomic-images');
    expect(opts.objectPath).toBe(S.images.get(r.body.id)!['object_path']);
  });

  it('metadata is stripped by the re-encode: a PNG carrying a GPS tEXt/eXIf chunk is stored without it (REQ-SEC-083/085)', async () => {
    const ctx = mkCtx({ scan: 'clean' }); const r = await up({ file: file(pngBytes({ meta: true })), kind: 'gross' }, CASE.OPEN, ctx);
    const stored = ctx._storage.get(S.images.get(r.body.id)!['object_path'])!; expect(stored.includes(GPS)).toBe(false);
  });

  it('a JPEG upload is stored as .jpg with mime image/jpeg (path rule {png|jpg})', async () => {
    const ctx = mkCtx({ scan: 'clean' }); const r = await up({ file: file(jpegBytes(), { filename: 'x.jpg', mimetype: 'image/jpeg' }), kind: 'microscopy' }, CASE.OPEN, ctx);
    expect(r.status).toBe(201); expect(r.body.mime_type).toBe('image/jpeg');
    expect(S.images.get(r.body.id)!['object_path']).toBe(`${T}/2026/12/${r.body.id}.jpg`);
  });

  it('AC-12.4 infected (AcceptedUpload.scanState = infected): 201 with state quarantined, scan_state infected, quarantine_reason_code malware (terminal), no job, and the content is never served (422 common.upload_quarantined)', async () => {
    const ctx = mkCtx({ scan: 'infected' }); const r = await up(goodBody(), CASE.OPEN, ctx);
    expect(r.status).toBe(201); imageShape(r.body); expect(r.body.state).toBe('quarantined');
    expect(S.images.get(r.body.id)).toMatchObject({ state: 'quarantined', scan_state: 'infected', quarantine_reason_code: 'malware' });
    expect(S.jobs).toEqual([]);
    ctx._storage.calls.length = 0;
    const e = await rejects(call('getAnatomicImageContent', { params: { image_id: r.body.id } }, ctx)); codeOf(e, 'common.upload_quarantined', 422);
    expect(ctx._storage.callsOf('read')).toEqual([]); expect(calls.access).toEqual([]);
  });

  // 02-TRD §9 (line 656): lims_anatomic_image_processing_total{outcome}; the C1 security alert watches outcome="quarantined" (review item 2/3)
  it('infected upload increments lims_anatomic_image_processing_total{outcome="quarantined"} (feeds the C1 security alert)', async () => {
    const ctx = mkCtx({ scan: 'infected' }); await up(goodBody(), CASE.OPEN, ctx);
    expect(ctx._incs).toContainEqual({ name: 'lims_anatomic_image_processing_total', labels: { outcome: 'quarantined' } });
  });
  it('clean upload increments lims_anatomic_image_processing_total{outcome="ready"}, never "quarantined"', async () => {
    const ctx = mkCtx({ scan: 'clean' }); await up(goodBody(), CASE.OPEN, ctx);
    expect(ctx._incs).toContainEqual({ name: 'lims_anatomic_image_processing_total', labels: { outcome: 'ready' } });
    expect(ctx._incs).not.toContainEqual({ name: 'lims_anatomic_image_processing_total', labels: { outcome: 'quarantined' } });
  });

  it.each(['pending', 'unavailable'] as const)('AC-12.1 %s: 201 with state processing, scan_state %s, ONE anatomic.process_image job {image_id} with job_key image:<id>, enqueued after the row insert; content is refused until ready', async (scan) => {
    const ctx = mkCtx({ scan }); const r = await up(goodBody(), CASE.OPEN, ctx);
    expect(r.status).toBe(201); imageShape(r.body); expect(r.body.state).toBe('processing');
    expect(S.images.get(r.body.id)).toMatchObject({ state: 'processing', scan_state: scan, scan_attempts: 0, quarantine_reason_code: null });
    expect(S.jobs).toHaveLength(1);
    const j = S.jobs[0]!; expect(j['identifier']).toBe('anatomic.process_image'); expect(j['jobKey']).toBe(`image:${r.body.id}`);
    expect(j['payload']['image_id']).toBe(r.body.id); expect(Object.keys(j['payload']).every((k) => ['image_id', 'tenant_id'].includes(k))).toBe(true);
    if ('tenant_id' in j['payload']) expect(j['payload']['tenant_id']).toBe(T);
    expect(S.events.filter((x) => x !== 'access')).toEqual(['insertImage', 'enqueue']);
    const e = await rejects(call('getAnatomicImageContent', { params: { image_id: r.body.id } }, ctx)); codeOf(e, 'common.upload_quarantined', 422);
    expect(ctx._storage.callsOf('read')).toEqual([]);
  });

  it('the row insert and the job commit together: a failing enqueue rolls the processing row back (no processing image without a job)', async () => {
    const ctx = mkCtx({ scan: 'pending', failEnqueue: true }); const e = await rejects(up(goodBody(), CASE.OPEN, ctx));
    expect(e?.message).toBe('queue unavailable'); expect(S.events).toContain('insertImage'); expect(imagesOf(CASE.OPEN).filter((r) => r['state'] === 'processing' && r['id'] !== IMG.PROCESSING)).toEqual([]);
  });
});

describe('I1 uploadAnatomicImage — size, type, validation (AC-12.2, AC-12.3; REQ-SEC-083)', () => {
  it('AC-12.2: a 16 MB file -> 413 common.payload_too_large; nothing stored, no row, no job', async () => {
    const before = stateDump(); const ctx = mkCtx(); const big = Buffer.concat([pngBytes(), Buffer.alloc(16 * MiB)]);
    const e = await rejects(up({ file: file(big), kind: 'gross' }, CASE.OPEN, ctx)); codeOf(e, 'common.payload_too_large', 413); nothingPersisted(ctx, before);
  });
  it('AC-12.2 boundary: 15 MB + 1 byte -> 413, exactly the limit is not a size error', async () => {
    const before = stateDump(); const ctx = mkCtx(); const e = await rejects(up({ file: file(Buffer.concat([pngBytes(), Buffer.alloc(15 * MiB + 1 - pngBytes().length)])), kind: 'gross' }, CASE.OPEN, ctx));
    codeOf(e, 'common.payload_too_large', 413); nothingPersisted(ctx, before);
  });
  it('AC-12.3: patient-name.png whose bytes are a PDF -> 415 common.unsupported_media_type; nothing stored, the filename is not echoed', async () => {
    const before = stateDump(); const ctx = mkCtx(); const e = await rejects(up({ file: file(pdfBytes(), { filename: 'patient-name.png', mimetype: 'image/png' }), kind: 'gross' }, CASE.OPEN, ctx));
    codeOf(e, 'common.unsupported_media_type', 415); nothingPersisted(ctx, before); expect(JSON.stringify({ m: e.message, d: e.detail, errors: e.errors })).not.toContain('patient-name');
  });
  it.each([
    ['PNG bytes declared image/gif', () => file(SMALL, { filename: 'a.gif', mimetype: 'image/gif' })],
    ['a .exe name', () => file(SMALL, { filename: 'a.exe', mimetype: 'image/png' })],
    ['PNG bytes declared as JPEG', () => file(SMALL, { filename: 'a.png', mimetype: 'image/jpeg' })],
    ['an empty file', () => file(Buffer.alloc(0))],
    ['a PDF declared application/pdf', () => file(pdfBytes(), { filename: 'a.pdf', mimetype: 'application/pdf' })],
  ])('%s -> 415 common.unsupported_media_type, nothing persisted', async (_n, mk) => {
    const before = stateDump(); const ctx = mkCtx(); const e = await rejects(up({ file: mk(), kind: 'gross' }, CASE.OPEN, ctx)); codeOf(e, 'common.unsupported_media_type', 415); nothingPersisted(ctx, before);
  });
  it('the pipeline rejecting an upload as infected / bad image (422 common.upload_quarantined thrown by accept) propagates unchanged: no row, no job', async () => {
    const before = stateDump(); const ctx = mkCtx(); ctx.uploads = { accept: async () => { throw new LimsError('common.upload_quarantined'); } };
    const e = await rejects(up(goodBody(), CASE.OPEN, ctx)); codeOf(e, 'common.upload_quarantined', 422); expect(stateDump()).toBe(before);
  });
  it.each([
    ['no file part', () => ({ kind: 'gross' })],
    ['file is a string', () => ({ file: 'not-a-file', kind: 'gross' })],
    ['kind missing', () => ({ file: file(SMALL) })],
    ['kind not in the enum', () => ({ file: file(SMALL), kind: 'selfie' })],
    ['caption of 201 characters', () => ({ file: file(SMALL), kind: 'gross', caption: 'c'.repeat(201) })],
    ['part_id not a uuid', () => ({ file: file(SMALL), kind: 'gross', part_id: 'A' })],
  ])('%s -> 400/422 common.validation_failed, nothing persisted', async (_n, mk) => {
    const before = stateDump(); const ctx = mkCtx(); const e = await rejects(up(mk() as Row, CASE.OPEN, ctx)); codeOf(e, 'common.validation_failed'); nothingPersisted(ctx, before);
  });
  it('a caption of exactly 200 characters is accepted', async () => {
    const r = await up(goodBody({ caption: 'c'.repeat(200) }), CASE.OPEN, mkCtx()); expect(r.status).toBe(201); expect(r.body.caption).toHaveLength(200);
  });
  it('a part_id of another case or another tenant is refused (validation_failed or not_found), nothing persisted', async () => {
    for (const partId of [PART.SIGNED_A, PART.OTHER_TENANT, uid(299)]) {
      const before = stateDump(); const ctx = mkCtx(); const e = await rejects(up(goodBody({ part_id: partId }), CASE.OPEN, ctx));
      expect(['common.validation_failed', 'common.not_found']).toContain(e?.code); nothingPersisted(ctx, before);
    }
  });
});

describe('I1 uploadAnatomicImage — limit, signed-out rule, access (AC-12.6, AC-12.8; D-66 (a))', () => {
  const fill = (n: number, caseId: string, active = true) => { for (let i = 0; i < n; i++) { const id = uid(5000 + S.images.size); S.images.set(id, imgRow(id, caseId, { is_active: active, created_at: `2026-11-1${i % 10}T00:00:00.000Z` })); } };
  const limit3 = () => S.settings.set(T, { ...S.settings.get(T), max_images_per_case: 3 });
  it('AC-12.6: the case already has max_images_per_case (3) active images -> 422 anatomic.image_limit_reached; nothing stored', async () => {
    limit3(); fill(3, CASE.LIMIT); const before = stateDump(); const ctx = mkCtx(); const e = await rejects(up(goodBody(), CASE.LIMIT, ctx));
    codeOf(e, 'anatomic.image_limit_reached', 422); nothingPersisted(ctx, before);
  });
  it('AC-12.6: deactivated images do not count; the 3rd active image is accepted and the 4th is refused', async () => {
    limit3(); fill(5, CASE.LIMIT, false); fill(1, CASE.LIMIT);
    expect((await up(goodBody(), CASE.LIMIT)).status).toBe(201); expect((await up(goodBody(), CASE.LIMIT)).status).toBe(201);
    const e = await rejects(up(goodBody(), CASE.LIMIT)); codeOf(e, 'anatomic.image_limit_reached', 422);
  });
  it('the limit is per case: another case of the same tenant is unaffected', async () => {
    limit3(); fill(3, CASE.LIMIT);
    const fresh = uid(107); S.cases.set(fresh, caseRow(fresh)); // tenant T, centre C1, no images
    expect((await up(goodBody(), fresh)).status).toBe(201);
  });
  it('AC-12.8: on a signed_out case with no open change draft a microscopy image (IHC photo) is accepted', async () => {
    expect(S.drafts.has(CASE.SIGNED)).toBe(false);
    const r = await up({ file: file(SMALL), kind: 'microscopy', caption: 'IHC photo' }, CASE.SIGNED, mkCtx({ scan: 'clean' }));
    expect(r.status).toBe(201); expect(r.body).toMatchObject({ kind: 'microscopy', state: 'ready' }); expect(S.images.get(r.body.id)).toMatchObject({ case_id: CASE.SIGNED, centre_id: C1 });
  });
  it('AC-12.8 also with an open change draft', async () => { expect((await up(goodBody(), CASE.SIGNED_DRAFT)).status).toBe(201); });
  it('order and permission: assertRole(anatomic.case.work, case centre) runs before the pipeline; denied -> auth.forbidden, pipeline never called, nothing stored', async () => {
    const before = stateDump(); const ctx = mkCtx({ deny: { 'anatomic.case.work': 'auth.forbidden' } }); const e = await rejects(up(goodBody(), CASE.OPEN, ctx));
    codeOf(e, 'auth.forbidden'); expect(ctx._pipe.seen).toEqual([]); nothingPersisted(ctx, before);
    expect(calls.assertRole).toEqual([{ permission: 'anatomic.case.work', centreId: C1 }]);
  });
  it('a centre the caller cannot see (port answers not_found) -> 404, pipeline never called', async () => {
    const ctx = mkCtx({ denyCentre: C2 }); const e = await rejects(up(goodBody(), CASE.C2, ctx)); codeOf(e, 'common.not_found', 404); expect(ctx._pipe.seen).toEqual([]);
  });
  it('a case of another tenant or an unknown case -> 404 common.not_found (no existence leak), pipeline never called', async () => {
    for (const id of [CASE.OTHER_TENANT, uid(999)]) { const ctx = mkCtx(); const e = await rejects(up(goodBody(), id, ctx)); codeOf(e, 'common.not_found', 404); expect(ctx._pipe.seen).toEqual([]); expect(calls.assertRole).toEqual([]); }
  });
});

// ================================================================================================ I2 content
describe('I2 getAnatomicImageContent — inline stream, headers, access log (AC-12.1; 08 A17 D-67; REQ-SEC-085)', () => {
  const get = (id: string, ctx: Ctx) => call('getAnatomicImageContent', { params: { image_id: id } }, ctx);
  it('a ready PNG -> 200 with the stored bytes and EXACTLY the D-67 headers, plus one access-log row anatomic_image.view', async () => {
    const ctx = mkCtx(); seedObjects(ctx); const r = await get(IMG.READY, ctx);
    expect(r.status).toBe(200); expect(Buffer.from(r.body).equals(SMALL)).toBe(true);
    expect(hdr(r, 'content-type')).toBe('image/png');
    expect(hdr(r, 'content-disposition')).toMatch(new RegExp(`^inline; filename="${IMG.READY}\\.png"`));
    expect(hdr(r, 'x-content-type-options')).toBe('nosniff');
    expect(hdr(r, 'content-security-policy')).toBe("default-src 'none'; sandbox");
    expect(hdr(r, 'cache-control')).toBe('no-store');
    expect(calls.access).toHaveLength(1);
    expect(calls.access[0]).toMatchObject({ action: 'anatomic_image.view', entityType: 'anatomic_image', entityId: IMG.READY, centreId: C1, outcome: 'allowed', actorId: ACTOR });
    expect(calls.assertRole).toEqual([{ permission: 'anatomic.case.read', centreId: C1 }]);
  });
  it('Content-Type is the STORED mime (never client-supplied) and the inline filename uses the stored extension: a jpeg row -> image/jpeg, <id>.jpg', async () => {
    const ctx = mkCtx(); seedObjects(ctx); const r = await get(IMG.JPEG, ctx);
    expect(hdr(r, 'content-type')).toBe('image/jpeg'); expect(hdr(r, 'content-disposition')).toMatch(new RegExp(`^inline; filename="${IMG.JPEG}\\.jpg"`));
  });
  it('the original filename and the caption appear in no response header (filename is not stored: only <image_id>.<ext>)', async () => {
    const ctx = mkCtx(); seedObjects(ctx); const r = await get(IMG.READY, ctx); const all = JSON.stringify(r.headers);
    expect(all).not.toContain('synthetic caption'); expect(all).not.toMatch(/patient/i); expect(all).not.toMatch(/https?:/i);
  });
  it('every call writes a row: 3 calls -> 3 anatomic_image.view rows; 12 concurrent calls -> 12 rows, each with the full body', async () => {
    const ctx = mkCtx(); seedObjects(ctx);
    for (let i = 0; i < 3; i++) await get(IMG.READY, ctx);
    expect(calls.access.filter((a) => a['action'] === 'anatomic_image.view')).toHaveLength(3);
    calls.access.length = 0;
    const rs = await Promise.all(Array.from({ length: 12 }, () => get(IMG.READY, ctx)));
    expect(calls.access).toHaveLength(12); for (const r of rs) expect(Buffer.from(r.body).equals(SMALL)).toBe(true);
  });
  it('the access-log row carries ids and codes only: no caption, no object path, no filename', async () => {
    const ctx = mkCtx(); seedObjects(ctx); await get(IMG.READY, ctx); const dump = JSON.stringify(calls.access);
    expect(dump).not.toContain('synthetic caption'); expect(dump).not.toContain(`${T}/2026`);
  });
  it.each([['processing', IMG.PROCESSING], ['quarantined', IMG.QUARANTINED]])('AC-12.1/12.4: a %s image -> 422 common.upload_quarantined, the object is never read, no bytes, no signed URL', async (_n, id) => {
    const ctx = mkCtx(); seedObjects(ctx); const e = await rejects(get(id, ctx)); codeOf(e, 'common.upload_quarantined', 422);
    expect(ctx._storage.callsOf('read')).toEqual([]); expect(ctx._storage.callsOf('signedUrl')).toEqual([]);
  });
  it('bytes never leave through a signed URL: a successful call makes no storage.signedUrl call', async () => {
    const ctx = mkCtx(); seedObjects(ctx); await get(IMG.READY, ctx); expect(ctx._storage.callsOf('signedUrl')).toEqual([]);
  });
  it('an image of another tenant / unknown id -> 404 common.not_found; no read, no access-log row, no role call for a foreign object', async () => {
    for (const id of [IMG.OTHER_TENANT, uid(998)]) {
      const ctx = mkCtx(); seedObjects(ctx); const e = await rejects(get(id, ctx)); codeOf(e, 'common.not_found', 404); expect(ctx._storage.callsOf('read')).toEqual([]); expect(calls.access).toEqual([]);
    }
  });
  it('permission anatomic.case.read denied -> auth.forbidden, no read, no access-log row', async () => {
    const ctx = mkCtx({ deny: { 'anatomic.case.read': 'auth.forbidden' } }); seedObjects(ctx); const e = await rejects(get(IMG.READY, ctx));
    codeOf(e, 'auth.forbidden'); expect(ctx._storage.callsOf('read')).toEqual([]); expect(calls.access).toEqual([]);
  });
  it('a centre the caller cannot see -> 404, no read', async () => {
    const ctx = mkCtx({ denyCentre: C2 }); seedObjects(ctx); const e = await rejects(get(IMG.C2, ctx)); codeOf(e, 'common.not_found'); expect(ctx._storage.callsOf('read')).toEqual([]);
  });
});

// ================================================================================================ I3 update
describe('I3 updateAnatomicImage — kind, part, caption (AC-12.7; D-66 (a)/(c))', () => {
  const put = (id: string, body: Row, v = 1, ctx: Ctx = mkCtx(), headers: Row | undefined = undefined) => call('updateAnatomicImage', { params: { image_id: id }, headers: headers ?? ifm(v), body }, ctx);
  it('updates kind, part and caption: 200 Image, version 1 -> 2, response closed key set without nulls, role anatomic.case.work on the case centre', async () => {
    const r = await put(IMG.READY, { kind: 'microscopy', part_id: PART.A, caption: 'new synthetic caption' });
    expect(r.status).toBe(200); imageShape(r.body); expect(r.body).toMatchObject({ id: IMG.READY, kind: 'microscopy', part_id: PART.A, caption: 'new synthetic caption', version: 2, state: 'ready' });
    expect(S.images.get(IMG.READY)).toMatchObject({ kind: 'microscopy', caption: 'new synthetic caption', version: 2, updated_by: ACTOR }); expect(calls.assertRole).toEqual([{ permission: 'anatomic.case.work', centreId: C1 }]);
  });
  it('PUT is a full replace: { kind } alone clears part_id and caption', async () => {
    const r = await put(IMG.READY, { kind: 'gross' }); expect(r.body).not.toHaveProperty('part_id'); expect(r.body).not.toHaveProperty('caption');
    expect(S.images.get(IMG.READY)).toMatchObject({ part_id: null, caption: null });
  });
  it('the immutable columns never change: object_path, sha256, mime, size, state and scan_state are as before', async () => {
    const before = structuredClone(S.images.get(IMG.READY)!); await put(IMG.READY, { kind: 'other' }); const a = S.images.get(IMG.READY)!;
    for (const k of ['object_path', 'sha256', 'mime_type', 'byte_size', 'width_px', 'height_px', 'state', 'scan_state', 'bucket', 'case_id', 'centre_id', 'is_active']) expect(a[k], k).toEqual(before[k]);
  });
  it('If-Match: absent -> 428 common.precondition_required; stale -> 409 common.version_conflict; malformed -> 400; nothing written', async () => {
    const before = stateDump();
    codeOf(await rejects(put(IMG.READY, { kind: 'gross' }, 1, mkCtx(), {})), 'common.precondition_required', 428);
    codeOf(await rejects(put(IMG.READY, { kind: 'gross' }, 7)), 'common.version_conflict', 409);
    codeOf(await rejects(put(IMG.READY, { kind: 'gross' }, 1, mkCtx(), { 'if-match': 'abc' })), 'common.validation_failed');
    expect(stateDump()).toBe(before);
  });
  it.each([['unknown field', { kind: 'gross', evil: 1 }], ['kind missing', { caption: 'x' }], ['kind not in the enum', { kind: 'selfie' }], ['caption 201 chars', { kind: 'gross', caption: 'c'.repeat(201) }],
    ['part_id not a uuid', { kind: 'gross', part_id: '1' }], ['object_path in the body', { kind: 'gross', object_path: 'x' }]])('%s -> common.validation_failed, nothing written, the value is not echoed', async (_n, body) => {
    const before = stateDump(); const e = await rejects(put(IMG.READY, body)); codeOf(e, 'common.validation_failed'); expect(stateDump()).toBe(before);
    expect(JSON.stringify({ m: e.message, d: e.detail, errors: e.errors })).not.toContain('c'.repeat(50));
  });
  it('a part of another case / tenant -> validation_failed or not_found, nothing written', async () => {
    for (const p of [PART.SIGNED_A, PART.OTHER_TENANT]) { const before = stateDump(); const e = await rejects(put(IMG.READY, { kind: 'gross', part_id: p })); expect(['common.validation_failed', 'common.not_found']).toContain(e?.code); expect(stateDump()).toBe(before); }
  });
  it('AC-12.7: an image already in a signed version -> 409 anatomic.signout_locked; row unchanged', async () => {
    const before = stateDump(); const e = await rejects(put(IMG.SIGNED_IN, { kind: 'other', caption: 'rewrite history' })); codeOf(e, 'anatomic.signout_locked', 409); expect(stateDump()).toBe(before);
  });
  it('AC-12.7 / D-66 (c): still locked while a revision draft is open (content already in a signed version is never editable)', async () => {
    expect(S.drafts.has(CASE.SIGNED_DRAFT)).toBe(true); const e = await rejects(put(IMG.DRAFT_IN, { kind: 'other' })); codeOf(e, 'anatomic.signout_locked', 409);
  });
  it('D-66 (a): on a signed_out case, an image that is in no signed version can still be edited (no open draft needed)', async () => {
    const r = await put(IMG.FREE_ON_SIGNED, { kind: 'other', caption: 'added later' }); expect(r.status).toBe(200); expect(r.body).toMatchObject({ kind: 'other', caption: 'added later', version: 2 });
  });
  it('another tenant -> 404; unknown -> 404; role denied -> auth.forbidden; centre invisible -> 404; nothing written', async () => {
    const before = stateDump();
    codeOf(await rejects(put(IMG.OTHER_TENANT, { kind: 'gross' })), 'common.not_found', 404);
    codeOf(await rejects(put(uid(997), { kind: 'gross' })), 'common.not_found', 404);
    codeOf(await rejects(put(IMG.READY, { kind: 'gross' }, 1, mkCtx({ deny: { 'anatomic.case.work': 'auth.forbidden' } }))), 'auth.forbidden');
    codeOf(await rejects(put(IMG.C2, { kind: 'gross' }, 1, mkCtx({ denyCentre: C2 }))), 'common.not_found');
    expect(stateDump()).toBe(before);
  });
});

// ================================================================================================ I4 deactivate
describe('I4 deactivateAnatomicImage (AC-12.7)', () => {
  const deact = (id: string, v = 1, ctx: Ctx = mkCtx(), headers?: Row) => call('deactivateAnatomicImage', { params: { image_id: id }, headers: headers ?? ifm(v) }, ctx);
  it('deactivates: 200 Image with is_active false and version 2; it leaves the working gallery (listImages activeOnly) and the object stays in storage (no delete)', async () => {
    const ctx = mkCtx(); seedObjects(ctx); const r = await deact(IMG.READY, 1, ctx);
    expect(r.status).toBe(200); imageShape(r.body); expect(r.body).toMatchObject({ id: IMG.READY, is_active: false, version: 2 });
    const { listImages } = await import('../../repository/images.repo.js');
    expect((await listImages({} as any, { tenantId: T, caseId: CASE.OPEN, activeOnly: true })).map((x: Row) => x['id'])).not.toContain(IMG.READY);
    expect(ctx._storage.callsOf('delete')).toEqual([]); expect(ctx._storage.get(S.images.get(IMG.READY)!['object_path'])).toBeDefined();
    expect(calls.assertRole).toEqual([{ permission: 'anatomic.case.work', centreId: C1 }]);
  });
  it('AC-12.7: an image in a signed version on a signed_out case with no open draft can be deactivated; the signed version still references it (unchanged) and the object is still readable', async () => {
    const versionsBefore = JSON.stringify(S.versions); const ctx = mkCtx(); seedObjects(ctx);
    const r = await deact(IMG.SIGNED_IN, 1, ctx); expect(r.status).toBe(200); expect(r.body.is_active).toBe(false);
    expect(JSON.stringify(S.versions)).toBe(versionsBefore);
    expect(S.versions[0]!['images'].map((i: Row) => i['object_path'])).toContain(`${T}/2026/11/${IMG.SIGNED_IN}.png`);
    expect(ctx._storage.callsOf('delete')).toEqual([]);
    expect(Buffer.from(await ctx._storage.adapter.read('anatomic-images', S.images.get(IMG.SIGNED_IN)!['object_path'])).equals(SMALL)).toBe(true);   // what C6 reads for the signed version
  });
  it('If-Match: absent -> 428; stale -> 409 common.version_conflict; nothing written', async () => {
    const before = stateDump(); codeOf(await rejects(deact(IMG.READY, 1, mkCtx(), {})), 'common.precondition_required', 428); codeOf(await rejects(deact(IMG.READY, 9)), 'common.version_conflict', 409); expect(stateDump()).toBe(before);
  });
  it('another tenant / unknown -> 404; role denied -> auth.forbidden; nothing written', async () => {
    const before = stateDump();
    codeOf(await rejects(deact(IMG.OTHER_TENANT)), 'common.not_found', 404); codeOf(await rejects(deact(uid(996))), 'common.not_found', 404);
    codeOf(await rejects(deact(IMG.READY, 1, mkCtx({ deny: { 'anatomic.case.work': 'auth.forbidden' } }))), 'auth.forbidden'); expect(stateDump()).toBe(before);
  });
});

// ================================================================================================ logs: planted filename / caption (AC-12.5; 07-SECURITY §5.5, §5.6)
describe('AC-12.5 no original filename anywhere; no PHI in logs, jobs, access rows (log-scan)', () => {
  it.each(['clean', 'pending', 'unavailable', 'infected'] as const)('scan %s: the planted filename is in no row, no object path, no log line, no job payload, no access row, no response; the planted caption is in no log, job or access row', async (scan) => {
    const ctx = mkCtx({ scan }); const r = await up({ file: file(SMALL, { filename: PLANTED_FILENAME }), kind: 'gross', caption: PLANTED_CAPTION }, CASE.OPEN, ctx);
    if (scan === 'clean') await call('getAnatomicImageContent', { params: { image_id: r.body.id } }, ctx);
    await call('updateAnatomicImage', { params: { image_id: r.body.id }, headers: ifm(1), body: { kind: 'other', caption: PLANTED_CAPTION } }, ctx);
    const everything = JSON.stringify({ rows: [...S.images.values()], paths: ctx._storage.paths(), logs: calls.logs, jobs: S.jobs, access: calls.access, resp: r.body });
    expect(everything).not.toContain(PLANTED_FILENAME); expect(everything.toLowerCase()).not.toContain('test-patient-0042');
    expect(JSON.stringify({ logs: calls.logs, jobs: S.jobs, access: calls.access, paths: ctx._storage.paths() })).not.toContain(PLANTED_CAPTION);
    for (const s of consoleSpies) expect(s).not.toHaveBeenCalled();
  });
  it('a rejected upload (415 / 413 / limit) logs neither the filename nor the caption, and the thrown error carries neither', async () => {
    const errs: any[] = [];
    errs.push(await rejects(up({ file: file(pdfBytes(), { filename: PLANTED_FILENAME }), kind: 'gross', caption: PLANTED_CAPTION })));
    errs.push(await rejects(up({ file: file(Buffer.concat([pngBytes(), Buffer.alloc(16 * MiB)]), { filename: PLANTED_FILENAME }), kind: 'gross', caption: PLANTED_CAPTION })));
    codeOf(errs[0], 'common.unsupported_media_type', 415); codeOf(errs[1], 'common.payload_too_large', 413);
    const all = JSON.stringify({ logs: calls.logs, errs: errs.map((e) => ({ m: e?.message, d: e?.detail, e: e?.errors, c: e?.code })) });
    expect(all).not.toContain(PLANTED_FILENAME); expect(all).not.toContain(PLANTED_CAPTION);
    for (const s of consoleSpies) expect(s).not.toHaveBeenCalled();
  });
});
