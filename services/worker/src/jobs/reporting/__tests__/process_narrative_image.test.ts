// C6-T11 — task `reporting.process_input_file` for kind='narrative_image' (02-TRD §9 row "images -> re-encoded by the upload pipeline -> ready";
// 01-PRD AC-05.3; 07-SECURITY T9, REQ-SEC-084/085). Same task + payload { tenant_id, input_file_id } as C6-T10; the PDF sandbox is NEVER used for images.
// The API (N6) stored the already re-encoded PNG at quarantine_object_path (narrative-image.handlers.test.ts). The worker re-scans it (ctx.files.scan,
// 08 A17 P-19), re-validates it is a clean PNG/JPEG container (never trusts the object: tampered / SVG / corrupt -> rejected), writes the object to the
// tenant-first `{tenant}/narrative-images/{yyyy}/{mm}/{id}.png` (02-TRD CR-C6-009), records detected_mime + image_width/height and moves to `ready`.
// ASSUMED: error code on rejection is not fixed by the spec -> only "set" is asserted; alert metric = ctx.metrics.inc('lims_reporting_*') like T10.
import { describe, expect, it } from 'vitest';
import { reencodePng } from '../../../../../api/src/core/uploads/image.js';
import { BUCKET, TENANT_A, TENANT_B, fakeScan, idN, makeDb, makeJobCtx, makeStorage, sha256, world, type Row } from '../../../../../api/src/modules/reporting/__tests__/outsourced.helpers.js';
import { SENTINEL_META, SVG, has, imagePath, imageRow, infectedPng, isPng, narratives, pngBytes, withMetadata, NARR_B } from '../../../../../api/src/modules/reporting/__tests__/narrative-image.helpers.js';

const CLEAN = new Uint8Array(reencodePng(pngBytes({ width: 5, height: 3 }), 40).bytes);   // what N6 leaves in quarantine
const PDF_UNUSED = { sanitize: async () => { throw new Error('the PDF sandbox must not be used for images'); } };

function setup(row: Row = imageRow(), bytes: Uint8Array | null = CLEAN, jobOver: Record<string, unknown> = {}, extra: Row[] = []) {
  const db = makeDb({ ...world(), narrative_reports: narratives(), input_files: [row, ...extra] }); const storage = makeStorage();
  if (bytes !== null) storage.objects.set(`${BUCKET}::${row['quarantine_object_path']}`, bytes);
  let sandboxCalls = 0; const sandbox = { sanitize: async (b: Uint8Array) => { sandboxCalls++; return PDF_UNUSED.sanitize(); } };
  return { db, storage, ...makeJobCtx(db, storage, jobOver), row, sandbox, sandboxCalls: () => sandboxCalls };
}
async function build(sandbox: { sanitize: (b: Uint8Array) => Promise<any> }) {
  const mod: any = await import('../tasks/process_input_file.js');
  return mod.createProcessInputFile({ sandbox }) as (payload: any, ctx: any) => Promise<void>;
}
const run = async (h: (p: any, c: any) => Promise<void>, ctx: any, row: Row) => { await h({ tenant_id: ctx.tenantId, input_file_id: row['id'] }, ctx); };
const settle = (p: Promise<unknown>) => p.then(() => 'ok', (e) => e);
const written = (t: ReturnType<typeof setup>) => t.storage.paths().filter((p) => p.includes('/narrative-images/'));

describe('clean re-encoded PNG -> ready (AC-05.3)', () => {
  it('stores the PNG under the tenant-first narrative-images key, sha + mime + dimensions recorded, no sandbox call', async () => {
    const t = setup(); const h = await build(t.sandbox); await run(h, t.ctx, t.row);
    const f = t.db.file(t.row['id'])!;
    expect(f).toMatchObject({ state: 'ready', detected_mime: 'image/png', image_width: 5, image_height: 3, sanitized_sha256: sha256(CLEAN) });
    expect(f.last_error_code ?? null).toBeNull(); expect(f.version).toBeGreaterThan(1);
    expect(f.sanitized_object_path).toBe(imagePath(TENANT_A, t.row['id']));   // ctx.now() = 2026-11
    const out = t.storage.get(BUCKET, f.sanitized_object_path)!; expect(isPng(out)).toBe(true); expect(sha256(out)).toBe(f.sanitized_sha256);
    expect(t.sandboxCalls()).toBe(0); expect(f.sanitized_object_path).not.toBe(t.row['quarantine_object_path']);
  });
  it('the worker re-scans the stored object (defence in depth) exactly once', async () => {
    let scans = 0; const t = setup(imageRow(), CLEAN, { scan: async (b: Uint8Array) => { scans++; return fakeScan(b); } });
    const h = await build(t.sandbox); await run(h, t.ctx, t.row); expect(scans).toBe(1);
  });
  it('a crash between steps is recoverable: a row left in scanning / sanitizing is processed to ready', async () => {
    for (const state of ['scanning', 'sanitizing']) { const t = setup(imageRow({ state })); const h = await build(t.sandbox); await run(h, t.ctx, t.row); expect(t.db.file(t.row['id'])!.state).toBe('ready'); }
  });
  it('idempotent: re-running on terminal states changes nothing and writes no object', async () => {
    for (const state of ['ready', 'confirmed', 'withdrawn', 'rejected', 'quarantined']) {
      const t = setup(imageRow({ state, version: 6 })); const h = await build(t.sandbox); await run(h, t.ctx, t.row);
      expect(t.db.file(t.row['id'])).toMatchObject({ state, version: 6 }); expect(t.storage.calls.filter((c) => c.op === 'put')).toHaveLength(0);
    }
  });
  it('a retry that finds a DIFFERENT object at the target key never goes ready with content that does not match its recorded sha', async () => {
    const t = setup(); t.storage.objects.set(`${BUCKET}::${TENANT_A}/narrative-images/2026/11/${t.row['id']}.png`, new TextEncoder().encode('planted'));
    const h = await build(t.sandbox); const r = await settle(run(h, t.ctx, t.row)); const f = t.db.file(t.row['id'])!;
    if (r !== 'ok') expect(r).toBeInstanceOf(Error);
    if (f.state === 'ready') expect(sha256(t.storage.get(BUCKET, f.sanitized_object_path)!)).toBe(f.sanitized_sha256);
  });
  it('only tenant-first keys are written', async () => {
    const t = setup(); const h = await build(t.sandbox); await run(h, t.ctx, t.row);
    for (const p of t.storage.paths()) expect(p.startsWith(`${TENANT_A}/`)).toBe(true); expect(written(t)).toHaveLength(1);
  });
});

describe('infected / tampered quarantine objects never reach ready', () => {
  it('scanner hit -> quarantined + error code + alert metric; no sanitised object; no sandbox', async () => {
    const t = setup(imageRow(), infectedPng()); const h = await build(t.sandbox); await run(h, t.ctx, t.row);
    const f = t.db.file(t.row['id'])!; expect(f.state).toBe('quarantined'); expect(f.last_error_code).toBeTruthy(); expect(f.sanitized_object_path ?? null).toBeNull();
    expect(written(t)).toHaveLength(0); expect(t.sandboxCalls()).toBe(0); expect(t.metrics.filter((m) => /^lims_reporting_/.test(m.name)).length).toBeGreaterThanOrEqual(1);
  });
  it.each([
    ['an SVG', SVG],
    ['HTML', new TextEncoder().encode('<html><script>x</script></html>')],
    ['a PDF', new TextEncoder().encode('%PDF-1.7\n%%EOF')],
    ['a truncated PNG', pngBytes().subarray(0, 40)],
    ['empty', new Uint8Array(0)],
    ['a PNG-signature + SVG body', new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(SVG)]))],
  ])('quarantine object is %s -> rejected, nothing written to narrative-images', async (_n, bytes) => {
    const t = setup(imageRow(), bytes as Uint8Array); const h = await build(t.sandbox); await settle(run(h, t.ctx, t.row));
    const f = t.db.file(t.row['id'])!; expect(f.state).not.toBe('ready'); expect(['rejected', 'quarantined', 'scanning', 'pending_scan', 'sanitizing']).toContain(f.state);
    if (f.state === 'rejected' || f.state === 'quarantined') expect(f.last_error_code).toBeTruthy();
    expect(written(t)).toHaveLength(0); expect(t.sandboxCalls()).toBe(0);
  });
  it('a PNG that still carries metadata is re-encoded on the way (or refused) — planted metadata / markup is never published', async () => {
    const t = setup(imageRow(), withMetadata()); const h = await build(t.sandbox); await settle(run(h, t.ctx, t.row));
    const f = t.db.file(t.row['id'])!;
    if (f.state === 'ready') { const out = t.storage.get(BUCKET, f.sanitized_object_path)!; for (const n of [SENTINEL_META, '<svg', '<script', 'tEXt', 'eXIf']) expect(has(out, n), n).toBe(false); }
    else expect(['rejected', 'quarantined']).toContain(f.state);
  });
  it('the quarantine object missing from storage -> not ready (retry), never a ready row', async () => {
    const t = setup(imageRow(), null); const h = await build(t.sandbox); const r = await settle(run(h, t.ctx, t.row));
    expect(t.db.file(t.row['id'])!.state).not.toBe('ready'); if (r !== 'ok') expect(r).toBeInstanceOf(Error);
  });
});

describe('scanner failure is fail-closed (REQ-SEC-084)', () => {
  it.each([['unavailable', async () => 'unavailable' as const], ['throws', async () => { throw new Error('clamd down'); }]])('scanner %s -> not ready, nothing written', async (_n, scan) => {
    const t = setup(imageRow(), CLEAN, { scan }); const h = await build(t.sandbox); const r = await settle(run(h, t.ctx, t.row));
    expect(['pending_scan', 'scanning']).toContain(t.db.file(t.row['id'])!.state); expect(written(t)).toHaveLength(0); if (r !== 'ok') expect(r).toBeInstanceOf(Error);
  });
});

describe('tenant isolation', () => {
  it('payload tenant_id different from ctx.tenantId -> nothing happens (or an error)', async () => {
    const t = setup(); const h = await build(t.sandbox); const r = await settle(h({ tenant_id: TENANT_B, input_file_id: t.row['id'] }, t.ctx));
    expect(t.db.file(t.row['id'])).toMatchObject({ state: 'pending_scan', version: 1 }); expect(written(t)).toHaveLength(0); if (r !== 'ok') expect(r).toBeInstanceOf(Error);
  });
  it("another tenant's image id under tenant A's ctx is untouched", async () => {
    const foreign = imageRow({ tenant_id: TENANT_B, narrative_report_id: NARR_B }); const t = setup(imageRow(), CLEAN, {}, [foreign]);
    t.storage.objects.set(`${BUCKET}::${foreign['quarantine_object_path']}`, CLEAN);
    const h = await build(t.sandbox); await settle(h({ tenant_id: TENANT_A, input_file_id: foreign['id'] }, t.ctx));
    expect(t.db.file(foreign['id'])).toMatchObject({ state: 'pending_scan', version: 1 }); expect(written(t)).toHaveLength(0);
  });
  it.each([[{}], [{ tenant_id: TENANT_A }], [{ tenant_id: TENANT_A, input_file_id: 'x' }], [{ tenant_id: TENANT_A, input_file_id: idN(0xdead) }]])('malformed / unknown payload %j -> no write', async (p) => {
    const t = setup(); const h = await build(t.sandbox); await settle(h(p, t.ctx)); expect(t.db.writes()).toHaveLength(0);
  });
  it('every reporting statement of a full run carries the tenant', async () => {
    const t = setup(); const h = await build(t.sandbox); await run(h, t.ctx, t.row);
    const st = t.db.reporting(); expect(st.length).toBeGreaterThan(1);
    for (const s of st) { expect(s.text, s.text).toMatch(/tenant_id/); expect(s.values, s.text).toContain(TENANT_A); }
  });
  it('logs and metrics never carry the filename, the object path or the planted metadata', async () => {
    const t = setup(imageRow({ original_filename: 'SENTINEL-Sita-Karki-scan.png' }), infectedPng()); const h = await build(t.sandbox); await run(h, t.ctx, t.row);
    const blob = JSON.stringify({ l: t.logs, m: t.metrics }); expect(blob).not.toContain('Sita-Karki'); expect(blob).not.toContain(t.row['quarantine_object_path']); expect(blob).not.toContain('EICAR');
  });
});
