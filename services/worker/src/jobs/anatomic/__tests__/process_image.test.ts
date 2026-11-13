// C11.T-10 — worker task `anatomic.process_image` (02-TRD §4.9 steps 2–3, §9, §3.2 layout "services/worker/src/jobs/anatomic/tasks/anatomic.process_image.ts"; 08 A17 P-19; 06-PLAN T-10).
// Re-scan of an upload whose scanState was pending/unavailable: r = ctx.files.scan(ctx.storage.read('anatomic-images', image.object_path)):
//   clean -> scan_state clean + state ready; infected -> scan_state infected + state quarantined + quarantine_reason_code 'malware';
//   unavailable (or the scanner throwing) -> scan_state unavailable, scan_attempts + 1, then THROW so the worker retries with backoff (maxAttempts 5, then dead letter; the image stays `processing`, never served).
//   A row that is no longer `processing` is a no-op (idempotent redelivery).
// SEAMS: the task is `export async function processImage(payload: { image_id; tenant_id? }, ctx: JobContext)` in ../tasks/anatomic.process_image.ts (TRD names the worker tree; the brief's api path
// services/api/.../tasks/ is a typo against 02-TRD §3.2 — the worker manifest registers it), reading/writing through the T-04 images.repo (getImage({tenantId,id}) / updateImage({tenantId,id,expectedVersion,actorId,patch}))
// which this test replaces with an in-memory table that emulates the images CHECKs. ctx = { tenantId, actor:{type:'system',id}, tx, log, storage.read, files.scan, attempt, maxAttempts, requestId, jobId }.
// The worker manifest (../index.ts) must register the task and maxAttempts['anatomic.process_image'] = 5; T-01 consumer subscription stays.
// Fails now: ../tasks/anatomic.process_image.ts does not exist.
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertBucket, assertTenantPath } from '../../../../../api/src/core/storage/index.js';
import { validateManifests } from '../../../core/manifest.js';

type Row = Record<string, any>;
const S = vi.hoisted(() => ({ images: new Map<string, Record<string, any>>(), updates: [] as Record<string, any>[], writes: 0 }));
const pgErr = (code: string, constraint: string) => Object.assign(new Error('constraint violation'), { code, constraint });
const COLS = ['part_id', 'kind', 'caption', 'state', 'quarantine_reason_code', 'scan_state', 'scan_attempts', 'is_active'];
function check(r: Row) {
  if (!(['pending', 'clean', 'infected', 'unavailable'].includes(r['scan_state']) && ((r['state'] === 'ready') === (r['scan_state'] === 'clean')) && ((r['state'] === 'quarantined') === (r['scan_state'] === 'infected'))
    && r['scan_attempts'] >= 0 && r['scan_attempts'] <= 5)) throw pgErr('23514', 'images__scan__ck');
  if (!((r['state'] === 'quarantined') === (r['quarantine_reason_code'] != null) && (r['quarantine_reason_code'] == null || /^[a-z_]{1,32}$/.test(r['quarantine_reason_code'])))) throw pgErr('23514', 'images__quarantine__ck');
  if (r['state'] === 'ready' && !(/^[0-9a-f]{64}$/.test(r['sha256'] ?? '') && ['image/png', 'image/jpeg'].includes(r['mime_type']) && r['byte_size'] >= 1)) throw pgErr('23514', 'images__ready__ck');
}
vi.mock('../../../../../api/src/modules/anatomic/repository/images.repo.js', async (orig) => ({
  ...((await orig()) as Row),
  async getImage(_tx: unknown, i: Row) { const r = S.images.get(i['id']); return r && r['tenant_id'] === i['tenantId'] ? { ...r } : undefined; },
  async updateImage(_tx: unknown, i: { tenantId: string; id: string; expectedVersion: number; actorId: string; patch: Row }) {
    S.writes++;
    for (const k of Object.keys(i.patch)) if (i.patch[k] !== undefined && !COLS.includes(k)) throw new Error(`anatomic repo: column '${k}' is not updatable`);
    const r = S.images.get(i.id);
    if (!r || r['tenant_id'] !== i.tenantId || r['version'] !== i.expectedVersion) return undefined;
    const next = { ...r, ...Object.fromEntries(Object.entries(i.patch).filter(([, v]) => v !== undefined)), version: r['version'] + 1, updated_by: i.actorId };
    check(next); S.images.set(i.id, next); S.updates.push({ ...i.patch }); return { ...next };
  },
}));

const { processImage } = await import('../tasks/anatomic.process_image.js');
const { manifest } = await import('../index.js');

const uid = (n: number) => `0190c411-0000-7000-8000-${String(n).padStart(12, '0')}`;
const T = '01a1a98a-ac40-7000-8000-00000000a001', T_OTHER = '01a1a98a-ac40-7000-8000-00000000b001', SYSTEM = '01a1a98a-ac40-7000-8000-00000000a999';
const IMG = { P: uid(301), PEND: uid(302), DONE: uid(303), QUAR: uid(304), OTHER: uid(305), CORRUPT: uid(306), A4: uid(307) };
const BYTES = Buffer.from('synthetic re-encoded image bytes');
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const CAPTION = 'Test Patient 0042 left arm';
const row = (id: string, over: Row = {}): Row => ({
  id, tenant_id: T, centre_id: uid(9), case_id: uid(8), part_id: null, kind: 'gross', caption: CAPTION, bucket: 'anatomic-images', object_path: `${T}/2026/11/${id}.png`, state: 'processing', quarantine_reason_code: null,
  scan_state: 'unavailable', scan_attempts: 0, mime_type: 'image/png', byte_size: BYTES.length, sha256: sha(BYTES), width_px: 4, height_px: 4, is_active: true, version: 1, created_by: uid(7), updated_by: uid(7), ...over });

type Verdict = 'clean' | 'infected' | 'unavailable' | 'throw';
function makeCtx(o: { verdicts?: Verdict[]; attempt?: number; tenant?: string; missingObject?: boolean } = {}) {
  const verdicts = [...(o.verdicts ?? ['clean'])]; const reads: Array<{ bucket: string; path: string }> = []; const scans: Uint8Array[] = []; const logs: string[] = [];
  const lg = (x: object, m?: string) => logs.push(JSON.stringify({ x, m })); const incs: Array<{ name: string; labels: unknown }> = [];
  const ctx: any = {
    tenantId: o.tenant ?? T, actor: { type: 'system', id: SYSTEM }, requestId: uid(9999), jobId: '1', attempt: o.attempt ?? 1, maxAttempts: 5, tx: { query: async () => ({ rows: [] }) },
    log: { info: lg, warn: lg, error: lg, debug: lg }, metrics: { inc: (name: string, labels?: unknown) => { incs.push({ name, labels }); } }, now: () => '2026-11-13T00:00:00.000Z',
    storage: { async read(bucket: any, path: string) { assertBucket(bucket); assertTenantPath(o.tenant ?? T, path); reads.push({ bucket, path }); if (o.missingObject) throw new Error('not found'); return new Uint8Array(BYTES); } },
    files: { async scan(b: Uint8Array) { scans.push(b); const v = verdicts.length > 1 ? verdicts.shift()! : verdicts[0]!; if (v === 'throw') throw new Error('clamd down'); return v; } },
  };
  return Object.assign(ctx, { _incs: incs, _reads: reads, _scans: scans, _logs: logs, setVerdicts: (v: Verdict[]) => { verdicts.length = 0; verdicts.push(...v); } });
}
const rejects = async (p: Promise<unknown>): Promise<any> => p.then(() => { throw new Error('expected rejection'); }, (e: unknown) => e);
let consoleSpies: Array<ReturnType<typeof vi.spyOn>> = [];
beforeEach(() => {
  S.images.clear(); S.updates.length = 0; S.writes = 0;
  S.images.set(IMG.P, row(IMG.P)); S.images.set(IMG.PEND, row(IMG.PEND, { scan_state: 'pending' })); S.images.set(IMG.DONE, row(IMG.DONE, { state: 'ready', scan_state: 'clean' }));
  S.images.set(IMG.QUAR, row(IMG.QUAR, { state: 'quarantined', scan_state: 'infected', quarantine_reason_code: 'malware' }));
  S.images.set(IMG.OTHER, row(IMG.OTHER, { tenant_id: T_OTHER, object_path: `${T_OTHER}/2026/11/${IMG.OTHER}.png` }));
  S.images.set(IMG.CORRUPT, row(IMG.CORRUPT, { object_path: `${T_OTHER}/2026/11/${IMG.CORRUPT}.png` }));
  S.images.set(IMG.A4, row(IMG.A4, { scan_attempts: 4 }));
  consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
});
afterEach(() => { for (const s of consoleSpies) s.mockRestore(); });
const run = (id: string, ctx = makeCtx(), extra: Row = {}) => processImage({ image_id: id, ...extra } as any, ctx);

describe('anatomic.process_image — re-scan outcomes (TRD §4.9 step 2)', () => {
  it.each(['unavailable', 'pending'] as const)('clean (row scan_state %s): scans the STORED object (storage.read anatomic-images + row path) and sets scan_state clean + state ready', async (st) => {
    S.images.set(IMG.P, row(IMG.P, { scan_state: st })); const ctx = makeCtx({ verdicts: ['clean'] });
    await run(IMG.P, ctx);
    expect(ctx._reads).toEqual([{ bucket: 'anatomic-images', path: `${T}/2026/11/${IMG.P}.png` }]); expect(ctx._scans).toHaveLength(1); expect(Buffer.from(ctx._scans[0]!).equals(BYTES)).toBe(true);
    expect(S.images.get(IMG.P)).toMatchObject({ state: 'ready', scan_state: 'clean', quarantine_reason_code: null, version: 2, updated_by: SYSTEM });
    expect(S.updates).toHaveLength(1);
  });
  it('infected: scan_state infected + state quarantined + quarantine_reason_code malware (terminal); the job completes (no retry)', async () => {
    const ctx = makeCtx({ verdicts: ['infected'] }); await run(IMG.PEND, ctx);
    expect(S.images.get(IMG.PEND)).toMatchObject({ state: 'quarantined', scan_state: 'infected', quarantine_reason_code: 'malware' });
  });
  it.each([['unavailable', 'unavailable' as Verdict], ['scanner throws', 'throw' as Verdict]])('%s: the job THROWS so the worker retries; the image never becomes ready or quarantined (fail closed)', async (_n, v) => {
    const ctx = makeCtx({ verdicts: [v], attempt: 1 }); const e = await rejects(run(IMG.P, ctx)); expect(e).toBeInstanceOf(Error);
    const r = S.images.get(IMG.P)!; expect(r['state']).toBe('processing'); expect(['pending', 'unavailable']).toContain(r['scan_state']);
    for (const u of S.updates) { expect(u['state'] ?? 'processing').toBe('processing'); expect(u['scan_state'] ?? 'unavailable').toBe('unavailable'); }
  });
  it('unavailable: scan_attempts is counted (+1 per attempt, never above 5: the images CHECK)', async () => {
    await rejects(run(IMG.P, makeCtx({ verdicts: ['unavailable'], attempt: 1 }))); const r = S.images.get(IMG.P)!;
    // the row may keep the count (tx committed on error) or not (rolled back by the worker); when it is written it is prior + 1
    if (S.updates.length) expect(r['scan_attempts']).toBe(1);
    await rejects(run(IMG.A4, makeCtx({ verdicts: ['unavailable'], attempt: 5 }))); const r4 = S.images.get(IMG.A4)!;
    expect(r4['scan_attempts']).toBeLessThanOrEqual(5); expect(r4['state']).toBe('processing');
  });
  it('re-scan that stays unavailable twice and then turns clean: attempts 1, 2 throw; attempt 3 -> ready; exactly 3 scans', async () => {
    const ctx = makeCtx({ verdicts: ['unavailable', 'unavailable', 'clean'] });
    ctx.attempt = 1; await rejects(run(IMG.P, ctx)); ctx.attempt = 2; await rejects(run(IMG.P, ctx)); expect(S.images.get(IMG.P)!['state']).toBe('processing');
    ctx.attempt = 3; await run(IMG.P, ctx); expect(S.images.get(IMG.P)).toMatchObject({ state: 'ready', scan_state: 'clean' }); expect(ctx._scans).toHaveLength(3);
  });
  it('re-scan that stays unavailable through all 5 attempts: every attempt throws (-> dead letter), the image stays processing (never served, never selectable), scan_attempts <= 5', async () => {
    const ctx = makeCtx({ verdicts: ['unavailable'] });
    for (let a = 1; a <= 5; a++) { ctx.attempt = a; await rejects(run(IMG.P, ctx)); }
    expect(S.images.get(IMG.P)).toMatchObject({ state: 'processing' }); expect(S.images.get(IMG.P)!['scan_attempts']).toBeLessThanOrEqual(5);
    expect(S.images.get(IMG.P)!['scan_state']).not.toBe('clean'); expect(ctx._scans).toHaveLength(5);
  });
  it('unavailable twice, then infected: ends quarantined', async () => {
    const ctx = makeCtx({ verdicts: ['unavailable', 'infected'] }); ctx.attempt = 1; await rejects(run(IMG.P, ctx)); ctx.attempt = 2; await run(IMG.P, ctx);
    expect(S.images.get(IMG.P)).toMatchObject({ state: 'quarantined', scan_state: 'infected', quarantine_reason_code: 'malware' });
  });
  // 02-TRD §9 (line 656): lims_anatomic_image_processing_total{outcome=ready|quarantined|scan_retry|failed}; C1 security alert watches outcome="quarantined" (review item 1/3)
  it.each([['clean', 'ready'], ['infected', 'quarantined']] as const)('%s increments lims_anatomic_image_processing_total{outcome="%s"}', async (v, outcome) => {
    const ctx = makeCtx({ verdicts: [v] }); await run(IMG.P, ctx);
    expect(ctx._incs).toContainEqual({ name: 'lims_anatomic_image_processing_total', labels: { outcome } });
    expect(ctx._incs.map((m: any) => m.name)).not.toContain('lims_anatomic_image_scans_total');
  });
  it('unavailable increments lims_anatomic_image_processing_total{outcome="scan_retry"} before throwing', async () => {
    const ctx = makeCtx({ verdicts: ['unavailable'] }); await rejects(run(IMG.P, ctx));
    expect(ctx._incs).toContainEqual({ name: 'lims_anatomic_image_processing_total', labels: { outcome: 'scan_retry' } });
  });
  it('only the allowed columns are patched; sha256, mime_type, byte_size, object_path never change', async () => {
    const before = structuredClone(S.images.get(IMG.P)!); await run(IMG.P, makeCtx({ verdicts: ['clean'] })); const a = S.images.get(IMG.P)!;
    for (const k of ['sha256', 'mime_type', 'byte_size', 'object_path', 'bucket', 'case_id', 'centre_id', 'kind', 'caption', 'part_id', 'is_active', 'width_px', 'height_px']) expect(a[k], k).toEqual(before[k]);
  });
});

describe('anatomic.process_image — idempotency, tenancy, hygiene', () => {
  it.each([['ready', IMG.DONE], ['quarantined', IMG.QUAR]])('a %s row is a no-op: no storage read, no scan, no update, resolves (redelivery)', async (_n, id) => {
    const ctx = makeCtx({ verdicts: ['infected'] }); const before = structuredClone(S.images.get(id)!); await run(id, ctx);
    expect(ctx._reads).toEqual([]); expect(ctx._scans).toEqual([]); expect(S.writes).toBe(0); expect(S.images.get(id)).toEqual(before);
  });
  it('running the job twice after success: the second run is a no-op', async () => {
    const ctx = makeCtx({ verdicts: ['clean'] }); await run(IMG.P, ctx); await run(IMG.P, ctx); expect(ctx._scans).toHaveLength(1); expect(S.images.get(IMG.P)!['version']).toBe(2);
  });
  it('an unknown image id, or an image of another tenant, is not scanned or written (no retry loop: resolves)', async () => {
    for (const id of [uid(990), IMG.OTHER]) { const ctx = makeCtx({ verdicts: ['clean'] }); await run(id, ctx); expect(ctx._scans).toEqual([]); expect(ctx._reads).toEqual([]); }
    expect(S.writes).toBe(0); expect(S.images.get(IMG.OTHER)!['state']).toBe('processing');
  });
  it('a payload tenant_id that differs from the job claims is refused (REQ-SEC-024): throws, nothing read or written', async () => {
    const ctx = makeCtx(); const e = await rejects(run(IMG.P, ctx, { tenant_id: T_OTHER })); expect(e).toBeInstanceOf(Error); expect(ctx._reads).toEqual([]); expect(S.writes).toBe(0);
  });
  it('a payload tenant_id equal to the claims is accepted', async () => { await run(IMG.P, makeCtx({ verdicts: ['clean'] }), { tenant_id: T }); expect(S.images.get(IMG.P)!['state']).toBe('ready'); });
  it.each([[''], ['not-a-uuid'], [undefined as unknown as string], [42 as unknown as string]])('image_id %j is refused (throws), nothing read or written', async (bad) => {
    const ctx = makeCtx(); const e = await rejects(processImage({ image_id: bad } as any, ctx)); expect(e).toBeInstanceOf(Error); expect(ctx._reads).toEqual([]); expect(S.writes).toBe(0);
  });
  it('a corrupt row whose object_path points into another tenant is never read: the tenant path rule stops it, the image does not become ready', async () => {
    const ctx = makeCtx({ verdicts: ['clean'] }); await run(IMG.CORRUPT, ctx).catch(() => undefined); expect(ctx._reads.filter((r) => r.path.startsWith(T_OTHER))).toEqual([]); expect(ctx._scans).toEqual([]);
    expect(S.images.get(IMG.CORRUPT)!['state']).toBe('processing');
  });
  it('the stored object is unreadable: the job throws (retry), nothing is marked clean', async () => {
    const ctx = makeCtx({ verdicts: ['clean'], missingObject: true }); const e = await rejects(run(IMG.P, ctx)); expect(e).toBeInstanceOf(Error); expect(S.images.get(IMG.P)!['state']).toBe('processing');
  });
  it('logs and thrown errors carry no caption, no object path, no bytes; console is never used', async () => {
    const errs: any[] = []; const ctx = makeCtx({ verdicts: ['infected'] }); await run(IMG.PEND, ctx);
    const c2 = makeCtx({ verdicts: ['unavailable'] }); errs.push(await rejects(run(IMG.P, c2)));
    const all = JSON.stringify({ l: [...ctx._logs, ...c2._logs], e: errs.map((e) => e?.message) });
    expect(all).not.toContain(CAPTION); expect(all).not.toContain(`${T}/2026`); expect(all).not.toContain('synthetic re-encoded image bytes');
    for (const s of consoleSpies) expect(s).not.toHaveBeenCalled();
  });
});

describe('worker manifest registers anatomic.process_image (TRD §3.2, §9)', () => {
  it('tasks has anatomic.process_image (a function), maxAttempts is 5, the T-01 consumer subscription is kept, no cron, and validateManifests passes', () => {
    expect(typeof manifest.tasks?.['anatomic.process_image']).toBe('function'); expect(manifest.maxAttempts?.['anatomic.process_image']).toBe(5);
    expect(Object.keys(manifest.subscriptions ?? {})).toContain('lab.specimen.status_changed.v1'); expect([...(manifest.crontab ?? [])]).toEqual([]);
    expect(() => validateManifests([manifest])).not.toThrow();
  });
});
