// C6-T09 test helpers (not a test file). Synthetic data only. Builds on the T04 single-transaction fake (consumers.helpers.ts) and the T08 world
// (assemble.helpers.ts). Adds: a rendering-status version seeded with a ReportDocument snapshot, fake IdentityPort asset reads (readBrandingAsset,
// readSignatureImage, getSignatories with `council`, LD-27), a fake renderer client, a fake sandbox assembler, a put-if-absent storage fake.
// ASSUMED task API (spec gives none): tasks/render_report_version.ts exports
//   createRenderReportVersion({ renderer: { render(req) -> { pdf: Uint8Array, pageCount: number } }, sandbox: { assemble(req) -> { pdf: Uint8Array, pageCount: number } } }) -> TaskHandler
//   payload { tenant_id, report_id, report_version_id } (what T08 enqueues); the job context carries attempt / maxAttempts (JobContext).
//   renderer failures are Errors carrying `.code` = 'reporting.render_unavailable' (retryable) | 'reporting.template_invalid' (permanent).
import { createHash } from 'node:crypto';
import { makeCtx, makeLog, TENANT_A, idN, type Row } from './consumers.helpers.js';
import { I, id } from '../../../../../api/src/modules/reporting/domain/__tests__/document.fixtures.js';
import {
  LAB, NARR, OUT_FILE, REG_NO, FULL_NAME, TEMPLATE_VERSION, versionRow, world, type WorldOpts,
} from './assemble.helpers.js';

export { LAB, NARR, TENANT_A, idN, makeLog, I, OUT_FILE, FULL_NAME, TEMPLATE_VERSION };
export const sha256 = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
export const enc = (s: string) => new TextEncoder().encode(s);
export const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');

export const VID = versionRow(1)['id'] as string;           // id of version 1 (idN(0xc001))
export const PNG = (tag: string) => enc(`\x89PNG synthetic ${tag}`);
export const LOGO = PNG('logo'); export const HEADER = PNG('letterhead-header'); export const FOOTER = PNG('letterhead-footer'); export const SIG1_IMG = PNG('signature-1');
export const LOGO_ID = id(0x61); export const HEADER_ID = id(0x62); export const FOOTER_ID = id(0x63); export const SIG1_ASSET = id(0x71);
export const MAIN_PDF = enc('%PDF-1.7 synthetic MAIN pages');
export const FINAL_PDF = enc('%PDF-1.7 synthetic FINAL merged + stamped');
export const OUT_BUCKET = 'reporting-inputs';
export const OUT_PATH = `${TENANT_A}/outsourced/2026/11/${OUT_FILE}.pdf`;
export const OUT_BYTES = enc('%PDF-1.7 synthetic SANITISED outside lab pdf');
export const OUT_SHA = sha256(OUT_BYTES);
export const INST_BYTES = enc('%PDF-1.7 synthetic SANITISED instrument pdf');
export const INST_SHA = sha256(INST_BYTES);
export const INST_PATH = `${TENANT_A}/instrument-pdfs/${INST_SHA}.pdf`;   // T08 convention: reporting-inputs/<tenant>/instrument-pdfs/<sha>.pdf
export const RENDERER_TOKEN = 'synthetic-renderer-token-0123456789abcdef';

const ref = (source: string, assetId: string, bytes: Uint8Array, mimeType?: string) => ({ source, id: assetId, sha256: sha256(bytes), ...(mimeType ? { mimeType } : {}) });

/** A ReportDocument (02-TRD §4.3) as stored in report_versions.content_snapshot. */
export function snapshot(over: Row = {}): Row {
  return {
    schemaVersion: 1, family: 'laboratory', reportKind: 'final', statusLabel: 'Final',
    lab: { displayName: 'Synthetic Lab', legalName: 'Synthetic Lab Pvt Ltd', contactStrip: ['Synthetic contact line'],
      logoAssetRef: ref('branding', LOGO_ID, LOGO), headerAssetRef: ref('branding', HEADER_ID, HEADER), footerAssetRef: ref('branding', FOOTER_ID, FOOTER) },
    header: { patientName: FULL_NAME, ageGender: '30Y / F', regNo: REG_NO, barcodeNos: ['B0001'], registeredAt: '2026-11-05T02:17:00.000Z', reportedAt: '2026-11-07T10:00:00.000Z',
      referredBy: 'Dr. Synthetic Referrer', collectedAtCentre: { code: 'C000000099', name: 'Synthetic centre' } },
    calendarDisplay: 'AD', timezone: 'Asia/Kathmandu', sections: [], amendmentNotes: [],
    signatories: [
      { membershipId: I.m1, displayName: 'Dr. Synthetic Signatory A', displayTitle: 'MD Pathology', registrationNo: 'NMC-SYN-0001', signatureAssetRef: ref('signature', SIG1_ASSET, SIG1_IMG), role: 'approver' },
      { membershipId: I.m2, displayName: 'Dr. Synthetic Signatory B', displayTitle: 'Medical Lab Technologist', registrationNo: 'NHPC-SYN-0002', role: 'approver' },   // no signature image on file
    ],
    disclaimers: ['Synthetic disclaimer line 1.'], qr: { verifyUrl: 'https://portal.example.invalid/v/AAAAAAAAAAAAAAAAAAAAAA' },
    outsourcedAttachments: [{ inputFileId: OUT_FILE, externalLabName: 'Synthetic Reference Lab', testName: 'Synthetic outsourced assay', pageCount: 3, sha256: OUT_SHA }],
    instrumentPdfAttachments: [{ analyteName: 'Synthetic analyte', objectRef: ref('instrument_attachment', INST_SHA, INST_BYTES, 'application/pdf'), sha256: sha256(enc('orig')), sanitizedSha256: INST_SHA }],
    ...over,
  };
}
export const plainSnapshot = (): Row => snapshot({ outsourcedAttachments: [], instrumentPdfAttachments: [] });

export interface RenderWorldOpts extends WorldOpts { snap?: Row; versionOver?: Row; extraVersions?: Row[] }
/** A `rendering` version 1 of the laboratory report (created 2026-11-07T11:50Z). */
export const renderingVersion = (over: Row = {}): Row => versionRow(1, {
  status: 'rendering', pdf_object_path: null, pdf_sha256: null, pdf_bytes: null, page_count: null, render_attempts: 0, rendering_started_at: null,
  rendered_at: null, last_render_error_code: null, created_at: '2026-11-07T11:50:00.000Z', content_snapshot: snapshot(), version: 1, ...over,
});

// ------------------------------------------------------------------------------------------------ fakes
const nf = () => Object.assign(new Error('not found'), { code: 'common.not_found' });
export interface IdentityOpts { noCouncil?: boolean; badCouncil?: boolean; sigImageMissing?: boolean; brandingMissing?: string[]; profilesDown?: boolean }
export function makeIdentity(o: IdentityOpts = {}) {
  const calls = { branding: [] as string[], signature: [] as string[], signatories: [] as string[][] };
  const BRANDING: Record<string, { kind: string; bytes: Uint8Array }> = {
    [LOGO_ID]: { kind: 'logo', bytes: LOGO }, [HEADER_ID]: { kind: 'letterhead_header', bytes: HEADER }, [FOOTER_ID]: { kind: 'letterhead_footer', bytes: FOOTER } };
  const profiles = [
    { membershipId: I.m1, displayName: 'Dr. Synthetic Signatory A', displayTitle: 'MD Pathology', registrationNo: 'NMC-SYN-0001', signatureAssetId: SIG1_ASSET, signatureSha256: sha256(SIG1_IMG), isActive: true,
      ...(o.noCouncil ? {} : { council: o.badCouncil ? 'XYZ' : 'NMC' }) },
    { membershipId: I.m2, displayName: 'Dr. Synthetic Signatory B', displayTitle: 'Medical Lab Technologist', registrationNo: 'NHPC-SYN-0002', isActive: true, ...(o.noCouncil ? {} : { council: 'NHPC' }) },
  ];
  const port = {
    async readBrandingAsset(_c: unknown, i: { assetId: string }) {
      calls.branding.push(i.assetId); const a = BRANDING[i.assetId];
      if (!a || o.brandingMissing?.includes(i.assetId)) throw nf();
      return { assetId: i.assetId, kind: a.kind, mimeType: 'image/png', sha256: sha256(a.bytes), base64: b64(a.bytes) };
    },
    async readSignatureImage(_c: unknown, i: { membershipId: string }) {
      calls.signature.push(i.membershipId);
      if (i.membershipId !== I.m1 || o.sigImageMissing) throw nf();
      return { membershipId: i.membershipId, contentBase64: b64(SIG1_IMG), mimeType: 'image/png', sha256: sha256(SIG1_IMG) };
    },
    async getSignatories(_c: unknown, i: { membershipIds: string[] }) {
      calls.signatories.push([...i.membershipIds]);
      if (o.profilesDown) throw Object.assign(new Error('identity down'), { code: 'common.unavailable' });
      return profiles.filter((p) => i.membershipIds.includes(p.membershipId));
    },
  };
  return { port, calls };
}

export type RendererReply = undefined | Error | ((req: any, n: number) => Promise<{ pdf: Uint8Array; pageCount: number }> | { pdf: Uint8Array; pageCount: number });
export function makeRenderer(reply?: RendererReply) {
  const calls: any[] = [];
  return { calls, async render(req: any) {
    calls.push(structuredClone(req));
    if (reply instanceof Error) throw reply;
    if (typeof reply === 'function') return reply(req, calls.length);
    return { pdf: MAIN_PDF, pageCount: 2 };
  } };
}
/** Sandbox /internal/assemble: returns FINAL_PDF; page count = 2 (main) + the pages `extraPages` says the other parts add. */
export function makeAssembler(o: { error?: Error; pageCount?: number; pdf?: Uint8Array } = {}) {
  const calls: any[] = [];
  return { calls, async assemble(req: any) {
    calls.push(req);
    if (o.error) throw o.error;
    return { pdf: o.pdf ?? FINAL_PDF, pageCount: o.pageCount ?? 2 };
  } };
}
export const partBytes = (p: any): Uint8Array => (p.pdf ?? p.bytes ?? Buffer.from(String(p.pdf_base64 ?? ''), 'base64')) as Uint8Array;

/** put-if-absent storage (ctx.storage, 02-TRD §10): put rejects when the object exists and ifAbsent is set; read by (bucket, path). */
export function makeStore(initial: Record<string, Uint8Array> = {}) {
  const objects = new Map<string, Uint8Array>(Object.entries(initial));
  const puts: Array<{ bucket: string; path: string; bytes: Uint8Array; opts: any }> = []; const reads: Array<[string, string]> = [];
  return { objects, puts, reads,
    async put(bucket: string, path: string, bytes: Uint8Array, opts: any = {}) {
      puts.push({ bucket, path, bytes, opts });
      if (opts.ifAbsent && objects.has(`${bucket}::${path}`)) throw Object.assign(new Error('storage: object exists'), { code: 'common.internal' });
      objects.set(`${bucket}::${path}`, new Uint8Array(bytes)); return { sha256: sha256(bytes), byteSize: bytes.length };
    },
    async read(bucket: string, path: string) { reads.push([bucket, path]); const o = objects.get(`${bucket}::${path}`); if (!o) throw Object.assign(new Error('storage: not found'), { code: 'common.internal' }); return new Uint8Array(o); },
    get: (bucket: string, path: string) => objects.get(`${bucket}::${path}`) };
}
export const baseStore = () => makeStore({ [`${OUT_BUCKET}::${OUT_PATH}`]: OUT_BYTES, [`${OUT_BUCKET}::${INST_PATH}`]: INST_BYTES });

// ------------------------------------------------------------------------------------------------ setup
export interface RS {
  db: ReturnType<typeof world>['db']; renderer: ReturnType<typeof makeRenderer>; assembler: ReturnType<typeof makeAssembler>; store: ReturnType<typeof makeStore>;
  identity: ReturnType<typeof makeIdentity>; logs: ReturnType<typeof makeLog>; metrics: Array<{ name: string; labels?: Record<string, string> }>;
  version(n?: number): Row; ctx(attempt?: number): any;
  run(attempt?: number, payload?: any): Promise<void>;
}
export function renderSetup(o: RenderWorldOpts & { identity?: IdentityOpts; rendererReply?: RendererReply; assembler?: Parameters<typeof makeAssembler>[0]; store?: ReturnType<typeof makeStore> } = {}): RS {
  const versions = [renderingVersion({ ...(o.snap ? { content_snapshot: o.snap } : {}), ...o.versionOver }), ...(o.extraVersions ?? [])];
  const w = world({ ...o, versions });
  const renderer = makeRenderer(o.rendererReply); const assembler = makeAssembler(o.assembler); const store = o.store ?? baseStore();
  const identity = makeIdentity(o.identity); const logs = makeLog(); const metrics: RS['metrics'] = [];
  const ctx = (attempt = 1) => {
    const c = makeCtx(w.db, { logs, ports: { identity: identity.port } as any }).ctx;
    c.storage = store; c.attempt = attempt; c.maxAttempts = 5; c.metrics = { inc: (name: string, labels?: Record<string, string>) => { metrics.push({ name, ...(labels ? { labels } : {}) }); } };
    return c;
  };
  const build = async () => {
    let mod: any;
    try { mod = await import('../tasks/render_report_version.js'); } catch (e) { throw Object.assign(new Error(`task module missing: ${(e as Error).message}`), { name: 'TaskLoadError' }); }
    return mod.createRenderReportVersion({ renderer, sandbox: assembler }) as (p: any, c: any) => Promise<void>;
  };
  return { db: w.db, renderer, assembler, store, identity, logs, metrics, ctx,
    version: (n = 1) => w.db.all('reporting.report_versions').find((v) => v['version_no'] === n)!,
    async run(attempt = 1, payload = { tenant_id: TENANT_A, report_id: LAB, report_version_id: VID }) { await (await build())(payload, ctx(attempt)); } };
}
/** Resolves to the thrown Error (or 'ok'). A missing task module is re-thrown, so rejection tests cannot pass just because the task does not exist yet. */
export const settle = (p: Promise<unknown>) => p.then(() => 'ok' as const, (e) => { if (e?.name === 'TaskLoadError') throw e; return e as Error; });
export const unavailable = (msg = 'renderer pool saturated') => Object.assign(new Error(msg), { code: 'reporting.render_unavailable' });
export const templateInvalid = () => Object.assign(new Error('page limit exceeded'), { code: 'reporting.template_invalid' });
