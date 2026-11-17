// C6-T16 worker test helpers (not a test file). Synthetic data only. Builds on the T04 fake (consumers.helpers.ts), the T08 world (assemble.helpers.ts) and the T09 fakes (render.helpers.ts).
// ASSUMED task API (spec gives none; mirrors createRenderReportVersion, repeated in .orchestra/notes/C6-T16-tests.md):
//   tasks/render_print.ts       exports createRenderPrint({ renderer: { render(req) -> { pdf, pageCount } }, sandbox: { assemble(req) -> { pdf, pageCount } } }) -> TaskHandler   (id reporting.render_print)
//   tasks/build_bulk_print.ts   exports createBuildBulkPrint({ sandbox: { assemble(req) -> { pdf, pageCount } } }) -> TaskHandler                                           (id reporting.build_bulk_print)
//   tasks/purge_ephemeral.ts    registered in the manifest as 'reporting.purge_ephemeral' (cron `17 20 * * *`, per_tenant); this task only tests its print_jobs part
//   payload { tenant_id, print_job_id } (what R10/R13/T5 enqueue); the job context carries attempt / maxAttempts / storage { put, read, delete(bucket, path) } like T09.
//   print_jobs.state: rendering -> ready | failed (error_code = a stable code, never a message). Retryable failure on a non-final attempt THROWS; permanent / final -> commit `failed` and resolve.
//   Preview (kind template_preview) is rendered with template_id 'template-preview', the print's template_version_id config, the variant, and NO document (the renderer owns the synthetic sample).
//   Fake DB: single-table statements only; DELETE is opted in for the E tables (consumers.helpers.ts allowDelete).
import { createHash } from 'node:crypto';
import { makeCtx, makeLog, TENANT_A, TENANT_B, idN, NOW, type Row } from './consumers.helpers.js';
import { TEMPLATE, versionRow, world, type WorldOpts } from './assemble.helpers.js';
import {
  FINAL_PDF, FULL_NAME, I, LAB, TEMPLATE_VERSION, makeAssembler, makeIdentity, makeRenderer, snapshot, type IdentityOpts, type RendererReply,
} from './render.helpers.js';

export { FINAL_PDF, FULL_NAME, I, LAB, TEMPLATE_VERSION, TEMPLATE, TENANT_A, TENANT_B, NOW, idN, makeLog, snapshot, type Row };
export const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
export const enc = (s: string) => new TextEncoder().encode(s);
export const PRINTS = 'reporting-prints'; export const REPORTS = 'reports';
export const PID = (i: number) => idN(0x61000 + i);
export const EXPIRES = '2026-11-08T12:00:30.000Z';                       // NOW + 24 h
export const TEMPLATE_VERSION_NEW = idN(0x903); export const TEMPLATE_VERSION_DRAFT = idN(0x904);
export const OLD_CFG = { signatoryMode: 'approvers', maxSignatories: 2, disclaimers: ['OLDCFG disclaimer'] };
export const NEW_CFG = { signatoryMode: 'approvers', maxSignatories: 2, disclaimers: ['NEWCFG disclaimer'] };
export const DRAFT_CFG = { signatoryMode: 'approvers', maxSignatories: 2, disclaimers: ['DRAFTCFG disclaimer'], watermark: { text: 'PREVIEWMARK' } };

/** A released version n of the laboratory report, with a stored canonical pdf. */
export const releasedVersion = (n = 1, over: Row = {}): Row => versionRow(n, {
  status: 'released', released_at: '2026-11-07T11:55:00.000Z', content_snapshot: snapshot(), created_at: '2026-11-07T11:50:00.000Z', version: 4,
  pdf_object_path: `${TENANT_A}/2026/11/${LAB}-v${n}.pdf`, pdf_sha256: sha(`pdf-${n}`), ...over });
export const draftVersion = (n = 1, over: Row = {}): Row => releasedVersion(n, { status: 'rendered', released_at: null, ...over });
export const canonicalBytes = (n: number) => enc(`%PDF-1.7 synthetic canonical v${n}`);

export const printJob = (i: number, over: Row = {}): Row => ({
  tenant_id: TENANT_A, centre_id: I.centre, id: PID(i), kind: 'single', report_version_ids: [releasedVersion(1)['id']], excluded_ids: [], template_version_id: TEMPLATE_VERSION, variant: 'plain', copies: 1,
  draft_watermark: false, state: 'rendering', object_path: null, sha256: null, page_count: null, expires_at: EXPIRES, error_code: null,
  created_at: NOW, created_by: idN(0xa001), updated_at: NOW, updated_by: idN(0xa001), version: 1, ...over });

/** put / read / delete over (bucket, path); records every call. */
export function printStore(initial: Record<string, Uint8Array> = {}, o: { deleteFails?: (path: string) => boolean; putFails?: boolean } = {}) {
  const objects = new Map<string, Uint8Array>(Object.entries(initial)); const calls: Array<{ op: string; bucket: string; path: string; opts?: any }> = [];
  return { objects, calls,
    async put(bucket: string, path: string, bytes: Uint8Array, opts: any = {}) {
      calls.push({ op: 'put', bucket, path, opts }); if (o.putFails) throw new Error('storage down');
      if (opts.ifAbsent && objects.has(`${bucket}::${path}`)) throw Object.assign(new Error('exists'), { code: 'common.internal' });
      objects.set(`${bucket}::${path}`, new Uint8Array(bytes)); return { sha256: sha(bytes), byteSize: bytes.length };
    },
    async read(bucket: string, path: string) { calls.push({ op: 'read', bucket, path }); const b = objects.get(`${bucket}::${path}`); if (!b) throw new Error('storage: not found'); return new Uint8Array(b); },
    async delete(bucket: string, path: string) { calls.push({ op: 'delete', bucket, path }); if (o.deleteFails?.(path)) throw new Error('storage delete failed'); objects.delete(`${bucket}::${path}`); },
    has: (bucket: string, path: string) => objects.has(`${bucket}::${path}`), puts: () => calls.filter((c) => c.op === 'put'), deletes: () => calls.filter((c) => c.op === 'delete'), reads: () => calls.filter((c) => c.op === 'read') };
}
const EXTRA_BYTES = enc('%PDF-1.7 synthetic SANITISED outside lab pdf'); const INST_BYTES = enc('%PDF-1.7 synthetic SANITISED instrument pdf');
/** inputs the canonical snapshot references (outsourced + instrument pdfs), same layout as T09. */
export const inputObjects = (): Record<string, Uint8Array> => {
  const snap = snapshot(); const out = snap['outsourcedAttachments'][0]; const inst = snap['instrumentPdfAttachments'][0];
  return { [`reporting-inputs::${TENANT_A}/outsourced/2026/11/${out.inputFileId}.pdf`]: EXTRA_BYTES, [`reporting-inputs::${TENANT_A}/instrument-pdfs/${inst.sanitizedSha256}.pdf`]: INST_BYTES };
};

export interface PrintWorldOpts extends WorldOpts {
  versions?: Row[]; prints?: Row[]; identity?: IdentityOpts; rendererReply?: RendererReply; assembler?: Parameters<typeof makeAssembler>[0]; objects?: Record<string, Uint8Array>;
  storeOpts?: Parameters<typeof printStore>[1]; frozenTemplate?: boolean; noDraftTemplate?: boolean; allowDelete?: readonly string[];
}
export function printWorld(o: PrintWorldOpts = {}) {
  const versionsRows = o.versions ?? [releasedVersion(1)];
  const base = { tenant_id: TENANT_A, centre_id: I.centre, created_by: idN(0xa009), updated_by: idN(0xa009) };
  const tvs: Row[] = [
    { ...base, id: TEMPLATE_VERSION, template_id: TEMPLATE, version_no: 1, status: o.frozenTemplate ? 'retired' : 'published', config: OLD_CFG, config_sha256: 'e'.repeat(64) },
    ...(o.frozenTemplate ? [{ ...base, id: TEMPLATE_VERSION_NEW, template_id: TEMPLATE, version_no: 2, status: 'published', config: NEW_CFG, config_sha256: 'f'.repeat(64) }] : []),
    ...(o.noDraftTemplate ? [] : [{ ...base, id: TEMPLATE_VERSION_DRAFT, template_id: TEMPLATE, version_no: 3, status: 'draft', config: DRAFT_CFG, config_sha256: 'd'.repeat(64) }]),
  ];
  const w = world({ ...o, versions: versionsRows, dbOpts: { allowDelete: o.allowDelete ?? ['reporting.print_jobs', 'reporting.otp_challenges', 'reporting.portal_sessions', 'reporting.portal_payment_requests'], ...o.dbOpts },
    extraSeed: { 'reporting.print_jobs': o.prints ?? [printJob(1)], 'reporting.report_template_versions': tvs,
      'reporting.report_templates': [{ ...base, id: TEMPLATE, family: 'laboratory', name: 'Default', current_version_id: o.frozenTemplate ? TEMPLATE_VERSION_NEW : TEMPLATE_VERSION, is_default: true }], ...o.extraSeed } });
  const renderer = makeRenderer(o.rendererReply); const assembler = makeAssembler(o.assembler); const identity = makeIdentity(o.identity); const logs = makeLog();
  const store = printStore({ ...inputObjects(), ...Object.fromEntries(versionsRows.map((v) => [`${REPORTS}::${v['pdf_object_path']}`, canonicalBytes(v['version_no'])])), ...o.objects }, o.storeOpts);
  const metrics: Array<{ name: string; labels?: Record<string, string> }> = [];
  const ctx = (attempt = 1, over: Row = {}) => {
    const c = makeCtx(w.db, { logs, ports: { identity: identity.port } as any }).ctx;
    c.storage = store; c.attempt = attempt; c.maxAttempts = 5; c.metrics = { inc: (name: string, labels?: Record<string, string>) => { metrics.push({ name, ...(labels ? { labels } : {}) }); } }; Object.assign(c, over); return c;
  };
  const print = (i = 1) => w.db.all('reporting.print_jobs').find((p) => p['id'] === PID(i));
  const settleLoad = async (file: string, factory: string, ports: object) => { try { return ((await import(file)) as any)[factory](ports) as (p: any, c: any) => Promise<void>; } catch (e) { throw Object.assign(new Error(`task module missing: ${(e as Error).message}`), { name: 'TaskLoadError' }); } };
  const runner = (file: string, factory: string, ports: object) => async (attempt = 1, payload: Row = { tenant_id: TENANT_A, print_job_id: PID(1) }, over: Row = {}) => (await settleLoad(file, factory, ports))(payload, ctx(attempt, over));
  return { db: w.db, renderer, assembler, identity, logs, store, metrics, ctx, print, prints: () => w.db.all('reporting.print_jobs'), versions: () => w.versions(),
    runRender: runner('../tasks/render_print.js', 'createRenderPrint', { renderer, sandbox: assembler }),
    runBulk: runner('../tasks/build_bulk_print.js', 'createBuildBulkPrint', { sandbox: assembler }) };
}
export type PrintWorld = ReturnType<typeof printWorld>;
/** Resolves to the thrown Error (or 'ok'); a missing task module is re-thrown so a rejection test cannot pass just because the task does not exist yet. */
export const settle = (p: Promise<unknown>) => p.then(() => 'ok' as const, (e) => { if (e?.name === 'TaskLoadError') throw e; return e as Error; });
export const partBytes = (p: any): Uint8Array => Buffer.from(String(p.pdf_base64 ?? ''), 'base64');
export const unavailable = () => Object.assign(new Error('renderer pool saturated'), { code: 'reporting.render_unavailable' });
export const templateInvalid = () => Object.assign(new Error('page limit exceeded'), { code: 'reporting.template_invalid' });
