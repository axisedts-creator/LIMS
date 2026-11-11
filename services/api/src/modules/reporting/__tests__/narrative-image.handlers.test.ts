// C6-T11 — N6 uploadNarrativeImage / N7 getNarrativeImageContent through the upload pipeline (02-TRD §6.4 rows N6/N7, §9 row reporting.process_input_file;
// 01-PRD AC-05.3; 07-SECURITY T9, REQ-SEC-083/084/085; 08 A13 P-2). Done when: SVG rejected, PNG re-encoded.
// Integration level: the REAL manifest handlers + the REAL core createUploads (re-encoder, magic bytes, scanner call) over the in-memory fakes of
// outsourced.helpers.ts. ASSUMED (spec gives no more): request = { params:{narrative_id}, body:{ file:{filename,mimeType,bytes}, caption? } } like O1;
// the re-encoded object is stored by ctx.uploads at the quarantine_object_path of the new `kind='narrative_image'` input_files row (state pending_scan,
// job `reporting.process_input_file` queued, the worker finishes -> ready: process_narrative_image.test.ts). The P-10 conditional narrative.write
// check of N7 belongs to C6-T17 (plan row) and is NOT tested here.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { BUCKET, SENTINEL_NAME, TENANT_A, fileRow, incoming, makeApiCtx, makeDb, makeStorage, rejection, sha256, world } from './outsourced.helpers.js';
import { JPEG, NARR_1, NARR_B, SVG, has, imagePath, imageRow, infectedPng, isPng, narratives, pngBytes, SENTINEL_META, withMetadata } from './narrative-image.helpers.js';

let manifest: any;
beforeAll(async () => {
  const k = join(mkdtempSync(join(tmpdir(), 'c6-t11-')), 'otp.key'); writeFileSync(k, Buffer.alloc(32, 7));
  process.env.LIMS_CORE_ENV = 'dev'; delete process.env.NODE_ENV; delete process.env.LIMS_REPORTING_ALLOW_REAL_PROVIDERS; process.env.LIMS_REPORTING_OTP_HMAC_KEY_FILE = k;
  manifest = (await import('../index.js')).manifest;
});

const noop = { info() {}, warn() {}, error() {} };
function env(operationId: string, seed: Record<string, any[]> = {}, over: Record<string, unknown> = {}) {
  const db = makeDb({ ...world(), narrative_reports: narratives(), ...seed }); const storage = makeStorage();
  const identityCalls: unknown[] = [];
  // LEAD-VISIBLE TESTER EDIT (C6-T17): N7 gained the P-10 conditional reporting.narrative.write check (ctx.ports.IdentityPort.assertRole); this allow-all port keeps the T11 cases about bytes/headers.
  const allow = { assertRole: async (_c: unknown, req: unknown) => { identityCalls.push(req); } };
  const c = makeApiCtx(db, storage, { ports: { identity: allow, IdentityPort: allow }, ...over });
  return { db, storage, identityCalls, ...c, hctx: { ...c.ctx, operationId, clientIp: '203.0.113.9', log: noop } };
}
const N6 = 'uploadNarrativeImage'; const N7 = 'getNarrativeImageContent';
const up = (c: any, body: unknown, narrativeId: unknown = NARR_1) => manifest.handlers[N6]({ params: { narrative_id: narrativeId }, query: {}, headers: {}, body }, c);
const get = (c: any, id: unknown) => manifest.handlers[N7]({ params: { image_id: id }, query: {}, headers: {}, body: undefined }, c);
const png = (bytes: Uint8Array = pngBytes(), name = 'synthetic-scan.png', mime = 'image/png') => incoming(bytes, name, mime);
const nothingPersisted = (t: ReturnType<typeof env>) => { expect(t.db.files()).toHaveLength(0); expect(t.db.jobs).toHaveLength(0); expect(t.storage.objects.size).toBe(0); expect(t.db.writes()).toHaveLength(0); };
const rawBytes = (r: any) => Buffer.from(r.body);

describe('N6 / N7 are no longer 501 stubs', () => {
  it.each([N6, N7])('%s fails closed without a request context', async (op) => {
    const e = await rejection(manifest.handlers[op]({ params: {}, query: {}, headers: {}, body: undefined }, { operationId: op, clientIp: '203.0.113.9', log: noop }));
    expect(e?.code).toBe('auth.unauthenticated');
  });
  it('N6 without ctx.uploads fails closed (500), never stores unscanned bytes', async () => {
    const t = env(N6, {}, { uploads: undefined }); const e = await rejection(up(t.hctx, { file: png() }));
    expect(e?.code).toBe('common.internal'); nothingPersisted(t);
  });
});

describe('AC-05.3 — a PNG is accepted, re-encoded and queued', () => {
  it('201 {image_id, state:pending_scan}; a narrative_image row with the caption; process_input_file queued', async () => {
    const t = env(N6); const r = await up(t.hctx, { file: png(), caption: 'Synthetic caption' });
    expect(r.status).toBe(201); expect(Object.keys(r.body).sort()).toEqual(['image_id', 'state']); expect(r.body.state).toBe('pending_scan');
    const row = t.db.file(r.body.image_id)!;
    expect(row).toMatchObject({ tenant_id: TENANT_A, kind: 'narrative_image', narrative_report_id: NARR_1, state: 'pending_scan', declared_mime: 'image/png', caption: 'Synthetic caption' });
    expect(row.quarantine_object_path).toMatch(new RegExp(`^${TENANT_A}/quarantine/\\d{4}/\\d{2}/`));
    const jobs = t.db.jobsOf('reporting.process_input_file'); expect(jobs).toHaveLength(1);
    expect(JSON.stringify(jobs[0]!.payload)).toContain(r.body.image_id); expect(JSON.stringify(jobs[0]!.payload)).toContain(TENANT_A);
  });
  it('the stored object is a RE-ENCODED png: valid signature, different bytes, no ancillary chunks / planted metadata / markup', async () => {
    const t = env(N6); const original = withMetadata(); const r = await up(t.hctx, { file: png(original) });
    const stored = t.storage.get(BUCKET, t.db.file(r.body.image_id)!.quarantine_object_path)!;
    expect(isPng(stored)).toBe(true); expect(Buffer.from(stored).equals(Buffer.from(original))).toBe(false);
    for (const needle of [SENTINEL_META, '<svg', '<script', 'tEXt', 'eXIf', 'iTXt']) expect(has(stored, needle), needle).toBe(false);
    expect(t.storage.paths()).toHaveLength(1); expect(t.storage.paths()[0]!.startsWith(`${TENANT_A}/`)).toBe(true);
  });
  it('bytes appended after IEND (polyglot tail) do not survive the re-encode', async () => {
    const t = env(N6); const r = await up(t.hctx, { file: png(pngBytes({ trailing: Buffer.from('<svg onload=x>TRAILER-PAYLOAD</svg>') })) });
    const stored = t.storage.get(BUCKET, t.db.file(r.body.image_id)!.quarantine_object_path)!; expect(has(stored, 'TRAILER-PAYLOAD')).toBe(false); expect(has(stored, '<svg')).toBe(false);
  });
  it('caption is optional; the response and the stored row carry no path / hash / tenant', async () => {
    const t = env(N6); const r = await up(t.hctx, { file: png() });
    expect(t.db.file(r.body.image_id)!.caption ?? null).toBeNull(); expect(JSON.stringify(r.body)).not.toMatch(/quarantine|sanitized|sha256|tenant_id|reporting-inputs|narrative-images/i);
  });
  it('a JPEG is never stored as the client sent it (re-encoded, or refused 422 with nothing persisted)', async () => {
    // core re-encoder has no JPEG decoder (image.ts ponytail, CR T0D-17) -> 422 today; a later decoder may accept it re-encoded.
    const t = env(N6); const out: any = await up(t.hctx, { file: png(JPEG, 'scan.jpg', 'image/jpeg') }).then((r: any) => ({ r }), (e: any) => ({ e }));
    if (out.r) expect(Buffer.from(t.storage.get(BUCKET, t.db.file(out.r.body.image_id)!.quarantine_object_path)!).equals(Buffer.from(JPEG))).toBe(false);
    else { expect(out.e?.code).toBe('common.upload_quarantined'); nothingPersisted(t); }
  });
});

describe('AC-05.3 — SVG and every non-png/jpeg type is rejected 415 common.unsupported_media_type, nothing stored', () => {
  it.each([
    ['svg file, svg mime', SVG, 'logo.svg', 'image/svg+xml'],
    ['svg bytes named .png, png mime', SVG, 'logo.png', 'image/png'],
    ['svg bytes named .svg, png mime', SVG, 'logo.svg', 'image/png'],
    ['png bytes named .svg', pngBytes(), 'logo.svg', 'image/svg+xml'],
    ['svg bytes named .jpg, jpeg mime', SVG, 'logo.jpg', 'image/jpeg'],
    ['double extension .svg.png with svg body', SVG, 'logo.svg.png', 'image/png'],
    ['png bytes, declared jpeg (type confusion)', pngBytes(), 'scan.jpg', 'image/jpeg'],
    ['png bytes, declared mime text/html', pngBytes(), 'scan.png', 'text/html'],
    ['a PDF', new TextEncoder().encode('%PDF-1.7\n%%EOF'), 'report.pdf', 'application/pdf'],
    ['html', new TextEncoder().encode('<html><script>x</script></html>'), 'a.html', 'text/html'],
    ['empty png', new Uint8Array(0), 'empty.png', 'image/png'],
  ])('%s', async (_n, bytes, name, mime) => {
    const t = env(N6); const e = await rejection(up(t.hctx, { file: png(bytes as Uint8Array, name as string, mime as string) }));
    expect(e?.code).toBe('common.unsupported_media_type'); nothingPersisted(t);
  });
  it('a missing file part is not stored either', async () => {
    const t = env(N6); const e = await rejection(up(t.hctx, { caption: 'x' }));
    expect(['common.unsupported_media_type', 'common.validation_failed']).toContain(e?.code); nothingPersisted(t);
  });
});

describe('hostile images (REQ-SEC-084/085)', () => {
  it('> 15 MB -> 413 common.payload_too_large', async () => {
    const big = new Uint8Array(15 * 1024 * 1024 + 1); big.set(pngBytes().subarray(0, 8)); const t = env(N6);
    expect((await rejection(up(t.hctx, { file: png(big) })))?.code).toBe('common.payload_too_large'); nothingPersisted(t);
  });
  it('decompression-bomb header (50000 x 50000) -> 422 common.upload_quarantined', async () => {
    const t = env(N6); const e = await rejection(up(t.hctx, { file: png(pngBytes({ declared: { width: 50000, height: 50000 } })) }));
    expect(e?.code).toBe('common.upload_quarantined'); nothingPersisted(t);
  });
  it('truncated / corrupt png -> 422 common.upload_quarantined', async () => {
    const whole = pngBytes(); const cut = whole.subarray(0, whole.length - 20); const flipped = new Uint8Array(whole); flipped[flipped.length - 20]! ^= 0xff;
    for (const bad of [cut, flipped]) { const t = env(N6); expect((await rejection(up(t.hctx, { file: png(new Uint8Array(bad)) })))?.code).toBe('common.upload_quarantined'); nothingPersisted(t); }
  });
  it('EICAR hidden in an ancillary chunk (dropped by the re-encoder) is still caught -> 422 common.upload_quarantined, nothing persisted', async () => {
    const t = env(N6); const e = await rejection(up(t.hctx, { file: png(infectedPng()) }));
    expect(e?.code).toBe('common.upload_quarantined'); nothingPersisted(t);
  });
  it.each([['unavailable', async () => 'unavailable' as const], ['throws', async () => { throw new Error('clamd down'); }]])('scanner %s -> fail closed: pending_scan, never ready', async (_n, scan) => {
    const t = env(N6, {}, { scan });   // makeApiCtx builds ctx.uploads over this scanner
    const r = await up(t.hctx, { file: png() }); expect(r.body.state).toBe('pending_scan'); expect(t.db.file(r.body.image_id)!.state).toBe('pending_scan');
  });
  it('client filename and caption never reach the storage key, the response or the logs', async () => {
    const t = env(N6); const r = await up(t.hctx, { file: png(pngBytes(), `../../etc/${SENTINEL_NAME.replace('.pdf', '.png')}`), caption: 'ok' });
    expect(t.storage.paths().join('|')).not.toMatch(/\.\.|etc|SENTINEL|Sita/); expect(t.db.file(r.body.image_id)!.original_filename).not.toMatch(/[\\/]|\.\./);
    expect(JSON.stringify({ l: t.logs, m: t.metrics })).not.toContain('Sita-Karki');
  });
});

describe('N6 validation + tenant isolation', () => {
  it.each([['201 chars', 'c'.repeat(201)], ['a number', 12345], ['an object', { x: 1 }]])('caption %s -> 400 common.validation_failed, nothing persisted', async (_n, caption) => {
    const t = env(N6); expect((await rejection(up(t.hctx, { file: png(), caption })))?.code).toBe('common.validation_failed'); nothingPersisted(t);
  });
  it('a caption of 200 chars is accepted', async () => {
    const t = env(N6); const r = await up(t.hctx, { file: png(), caption: 'c'.repeat(200) }); expect(t.db.file(r.body.image_id)!.caption).toHaveLength(200);
  });
  it('BOLA: a narrative of another tenant -> 404 common.not_found, nothing stored (not even the object)', async () => {
    const t = env(N6); expect((await rejection(up(t.hctx, { file: png() }, NARR_B)))?.code).toBe('common.not_found'); nothingPersisted(t);
  });
  it.each([['unknown id', '00000000-0000-7000-8000-00000000dead'], ['not a uuid', "1' OR '1'='1"], ['number', 5], ['undefined', undefined]])('narrative_id %s -> 404/400, nothing persisted', async (_n, id) => {
    const t = env(N6);   // `up` has a default for narrativeId, so `undefined` must bypass it and call the handler directly
    const call = id === undefined ? manifest.handlers[N6]({ params: { narrative_id: undefined }, query: {}, headers: {}, body: { file: png() } }, t.hctx) : up(t.hctx, { file: png() }, id);
    expect(['common.not_found', 'common.validation_failed']).toContain((await rejection(call))?.code); nothingPersisted(t);
  });
  it('every reporting statement carries the tenant of the context', async () => {
    const t = env(N6); await up(t.hctx, { file: png() }); const st = t.db.reporting(); expect(st.length).toBeGreaterThan(1);
    for (const s of st) { expect(s.text, s.text).toMatch(/tenant_id/); expect(s.values, s.text).toContain(TENANT_A); }
  });
  it('a failing upload pipeline (storage down) leaves no row and no job', async () => {
    const t = env(N6, {}, { uploads: { accept: async () => { throw new Error('storage down'); } } }); await rejection(up(t.hctx, { file: png() })); nothingPersisted(t);
  });
  it('concurrent uploads each get their own image id, row, object and job', async () => {
    const t = env(N6); const rs = await Promise.all([1, 2, 3].map(() => up(t.hctx, { file: png() })));
    expect(new Set(rs.map((r: any) => r.body.image_id)).size).toBe(3); expect(t.db.files()).toHaveLength(3); expect(new Set(t.storage.paths()).size).toBe(3); expect(t.db.jobsOf('reporting.process_input_file')).toHaveLength(3);
  });
});

describe('N7 getNarrativeImageContent', () => {
  const REENCODED = pngBytes({ width: 4, height: 4 });
  function ready(o: Record<string, unknown> = {}) {
    const f = imageRow({ state: 'ready', original_filename: 'synthetic-scan.png', ...o }); f.sanitized_object_path = imagePath(TENANT_A, f.id); f.sanitized_sha256 = sha256(REENCODED); f.detected_mime = 'image/png';
    const t = env(N7, { input_files: [f] }); t.storage.objects.set(`${BUCKET}::${f.sanitized_object_path}`, REENCODED);
    t.storage.objects.set(`${BUCKET}::${f.quarantine_object_path}`, withMetadata());   // the dirty original must never be served
    return { t, f };
  }
  it('200: the re-encoded bytes (never the quarantine object) with attachment + nosniff + no-store + CSP sandbox + image content type', async () => {
    const { t, f } = ready(); const r = await get(t.hctx, f.id);
    expect(r.status).toBe(200); expect(rawBytes(r).equals(Buffer.from(REENCODED))).toBe(true); expect(has(r.body, SENTINEL_META)).toBe(false);
    const h = Object.fromEntries(Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
    expect(h['content-type']).toBe('image/png'); expect(h['content-disposition']).toMatch(/^attachment/); expect(h['x-content-type-options']).toBe('nosniff');
    expect(h['cache-control']).toBe('no-store'); expect(h['content-security-policy']).toBe('sandbox');
    expect(t.storage.reads().map((c) => c.path)).toEqual([f.sanitized_object_path]);
  });
  it('writes the access log report.view (entity narrative_image) for the served image only', async () => {
    const { t, f } = ready(); await get(t.hctx, f.id); expect(t.access).toHaveLength(1);
    expect(t.access[0]).toMatchObject({ action: 'report.view', entityType: 'narrative_image', entityId: f.id });
  });
  it('a hostile client filename cannot inject headers', async () => {
    const { t, f } = ready({ original_filename: `x";\r\nX-Evil: 1.png` }); const r = await get(t.hctx, f.id);
    for (const v of Object.values(r.headers ?? {})) expect(String(v)).not.toMatch(/[\r\n]/); expect(Object.keys(r.headers ?? {}).some((k) => k.toLowerCase() === 'x-evil')).toBe(false);
  });
  it.each(['pending_scan', 'scanning', 'sanitizing'])('state %s -> 409 reporting.input_file_not_ready, nothing read, no access log', async (state) => {
    const f = imageRow({ state }); const t = env(N7, { input_files: [f] }); t.storage.objects.set(`${BUCKET}::${f.quarantine_object_path}`, withMetadata());
    expect((await rejection(get(t.hctx, f.id)))?.code).toBe('reporting.input_file_not_ready'); expect(t.storage.reads()).toHaveLength(0); expect(t.access).toHaveLength(0);
  });
  it.each(['quarantined', 'rejected'])('state %s -> refused (not_ready / upload_quarantined), the quarantine object is never read', async (state) => {
    const f = imageRow({ state, last_error_code: 'common.upload_quarantined' }); const t = env(N7, { input_files: [f] }); t.storage.objects.set(`${BUCKET}::${f.quarantine_object_path}`, infectedPng());
    expect(['reporting.input_file_not_ready', 'common.upload_quarantined']).toContain((await rejection(get(t.hctx, f.id)))?.code); expect(t.storage.reads()).toHaveLength(0); expect(t.access).toHaveLength(0);
  });
  it('a ready row without a sanitised path fails closed (never falls back to the quarantine path)', async () => {
    const f = imageRow({ state: 'ready' }); const t = env(N7, { input_files: [f] }); t.storage.objects.set(`${BUCKET}::${f.quarantine_object_path}`, withMetadata());
    expect((await rejection(get(t.hctx, f.id)))?.code).toBe('reporting.input_file_not_ready'); expect(t.storage.reads()).toHaveLength(0);
  });
  it('BOLA: an image of another tenant -> 404 common.not_found, nothing read', async () => {
    const f = imageRow({ tenant_id: '00000000-0000-7000-8000-0000000000b2', narrative_report_id: NARR_B, state: 'ready' }); f.sanitized_object_path = imagePath(f.tenant_id, f.id);
    const t = env(N7, { input_files: [f] }); expect((await rejection(get(t.hctx, f.id)))?.code).toBe('common.not_found'); expect(t.storage.reads()).toHaveLength(0);
  });
  it('an outsourced PDF id is not reachable through the image route', async () => {
    const f = fileRow({ state: 'ready' }); f.sanitized_object_path = `${TENANT_A}/outsourced/2026/11/${f.id}.pdf`;
    const t = env(N7, { input_files: [f] }); expect((await rejection(get(t.hctx, f.id)))?.code).toBe('common.not_found'); expect(t.storage.reads()).toHaveLength(0);
  });
  it.each([['unknown', '00000000-0000-7000-8000-00000000dead'], ['not a uuid', '../../etc/passwd'], ['undefined', undefined]])('image_id %s -> 404/400, nothing read', async (_n, id) => {
    const t = env(N7); expect(['common.not_found', 'common.validation_failed']).toContain((await rejection(get(t.hctx, id)))?.code); expect(t.storage.reads()).toHaveLength(0);
  });
  it('every reporting statement carries the tenant of the context', async () => {
    const { t, f } = ready(); await get(t.hctx, f.id);
    for (const s of t.db.reporting()) { expect(s.text, s.text).toMatch(/tenant_id/); expect(s.values, s.text).toContain(TENANT_A); }
  });
});
