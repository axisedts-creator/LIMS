// C6-T16 test helpers (not a test file). Synthetic data only. Single-table fake DB of the worker tests (consumers.helpers.ts) + the T15 fixtures.
// ASSUMED (spec gives no signatures; repeated in .orchestra/notes/C6-T16-tests.md):
//   - R10-R13 and T5 handlers take the usual API ctx { tenantId, actor:{type:'user',id,membershipId}, tx, ports:{IdentityPort}, storage, audit:{access}, now, log };
//     the requesting user's WORKING CENTRE (05-SCHEMA §2.14: bulk + template_preview `centre_id`) is read from `ctx.centreId` (the helper also mirrors it on `ctx.actor.centreId`)
//   - draft gate / privileged gate = ctx.ports.IdentityPort.assertRole(ctx,{permission}) (like R5 / R7); its `auth.mfa_required` propagates unchanged
//   - print jobs are enqueued as `SELECT app.enqueue_job('reporting.render_print' | 'reporting.build_bulk_print', payload {tenant_id, print_job_id}, key, null, 5)`
//   - expires_at = ctx.now() + 24 h, computed in JS (the fake cannot evaluate `now() + interval`)
//   - R12 reads bucket 'reports' (letterhead: versions.pdf_object_path) or 'reporting-prints' (print_jobs.object_path) through ctx.storage.read
//   - centre RLS (`__tenant_centre`) is emulated: SELECTs on reporting.* only return rows whose centre_id is in `centres` (the real policy is a DB test of C6-T02)
//   - the fake supports single-table statements only (no JOIN / sub-select / count(*) / LIKE / unnest): read one table per statement
import { makeDb, idN, TENANT_A, TENANT_B, NOW, type Row } from '../../../../../worker/src/jobs/reporting/__tests__/consumers.helpers.js';
import { wrapTx, mutex } from '../../../../../worker/src/jobs/reporting/__tests__/assemble.helpers.js';
import { makeStorage } from './outsourced.helpers.js';
import { CENTRE_A, CENTRE_B, MEMBERSHIP, RELEASED, USER, VID, reportRow, versionRow, iso } from './reports-read.helpers.js';

export { TENANT_A, TENANT_B, NOW, idN, CENTRE_A, CENTRE_B, USER, MEMBERSHIP, VID, RELEASED, reportRow, versionRow, iso, type Row };
export { rejection, lower, hasNull } from './reports-read.helpers.js';
export const PRINTS_BUCKET = 'reporting-prints';
export const REPORTS_BUCKET = 'reports';
export const PDF = new TextEncoder().encode('%PDF-1.7\n% synthetic CANONICAL version pdf\n%%EOF');
export const PRINT_PDF = new TextEncoder().encode('%PDF-1.7\n% synthetic PLAIN print pdf\n%%EOF');
export const EXPIRES = '2026-11-08T12:00:30.000Z';                                   // NOW + 24 h
export const PID = (i: number) => idN(0x61000 + i);                                   // print job ids
export const TEMPLATE = idN(0x902); export const TEMPLATE_VER_PUB = idN(0x912); export const TEMPLATE_VER_DRAFT = idN(0x913);
export const SENTINEL_NAME = 'SENTINEL-Print-Sita-Karki';                             // lives only in content_snapshot / report rows: must never reach logs, access log or print rows

export const printRow = (i: number, over: Row = {}): Row => ({
  tenant_id: TENANT_A, centre_id: CENTRE_A, id: PID(i), kind: 'single', report_version_ids: [VID(1, 1)], excluded_ids: [], template_version_id: idN(0x902), variant: 'plain', copies: 1,
  draft_watermark: false, state: 'ready', object_path: `${TENANT_A}/prints/${PID(i)}.pdf`, sha256: 'e'.repeat(64), page_count: 2, expires_at: EXPIRES, error_code: null,
  created_at: NOW, created_by: USER, updated_at: NOW, updated_by: USER, version: 2, ...over });

export interface PrintOpts {
  reports?: Row[]; versions?: Row[]; prints?: Row[]; deliveries?: Row[]; templates?: Row[]; templateVersions?: Row[];
  centres?: readonly string[] | null;                 // centre ids the caller may see (RLS emulation); null/undefined = all
  workingCentre?: string;                             // ctx.centreId (default CENTRE_A)
  denied?: readonly string[];                         // permissions assertRole refuses with auth.forbidden
  mfaRequired?: readonly string[];                    // permissions assertRole refuses with auth.mfa_required (aal1)
  objects?: Record<string, Uint8Array>;               // `${bucket}::${path}` -> bytes
  rls?: boolean; tenant?: string; failOn?: Array<{ match: RegExp; error: () => Error; times?: number }>;
}
export const templateSeed = (): { templates: Row[]; templateVersions: Row[] } => ({
  templates: [{ tenant_id: TENANT_A, id: TEMPLATE, family: 'laboratory', name: 'Default', current_version_id: TEMPLATE_VER_PUB, is_default: true, version: 3 }],
  templateVersions: [
    { tenant_id: TENANT_A, id: TEMPLATE_VER_PUB, template_id: TEMPLATE, version_no: 1, status: 'published', config: { signatoryMode: 'approvers' }, config_sha256: 'a'.repeat(64) },
    { tenant_id: TENANT_A, id: TEMPLATE_VER_DRAFT, template_id: TEMPLATE, version_no: 2, status: 'draft', config: { signatoryMode: 'approvers', watermark: { text: 'DRAFTMARK' } }, config_sha256: 'b'.repeat(64) },
  ] });

export function printSetup(o: PrintOpts = {}) {
  const seed = o.templates || o.templateVersions ? { templates: o.templates ?? [], templateVersions: o.templateVersions ?? [] } : templateSeed();
  const db = makeDb({
    'reporting.reports': o.reports ?? [], 'reporting.report_versions': o.versions ?? [], 'reporting.print_jobs': o.prints ?? [], 'reporting.deliveries': o.deliveries ?? [],
    'reporting.report_templates': seed.templates, 'reporting.report_template_versions': seed.templateVersions,
  }, { ...(o.rls === undefined ? {} : { rls: o.rls }), ...(o.tenant ? { tenant: o.tenant } : {}), ...(o.failOn ? { failOn: o.failOn } : {}) });
  const base = wrapTx(db.tx, mutex()); const centres = o.centres ? new Set(o.centres) : null;
  const tx: any = { startedAt: base.startedAt, savepoint: base.savepoint, release: base.release,
    async query(text: string, values: unknown[] = []) {
      const res = await base.query(text, values);
      if (centres && /^\s*select/i.test(text) && /\breporting\./i.test(text)) return { rows: res.rows.filter((r: Row) => r['centre_id'] === undefined || r['centre_id'] === null || centres.has(r['centre_id'])) };
      return res;
    } };
  const storage = makeStorage();
  for (const [k, b] of Object.entries(o.objects ?? {})) storage.objects.set(k, b);
  const access: any[] = []; const roleCalls: any[] = []; const logs: unknown[] = [];
  const ports: any = { IdentityPort: { async assertRole(_c: unknown, req: any) {
    roleCalls.push(req);
    if (o.denied?.includes(req.permission)) throw Object.assign(new Error('forbidden'), { code: 'auth.forbidden' });
    if (o.mfaRequired?.includes(req.permission)) throw Object.assign(new Error('aal2 needed'), { code: 'auth.mfa_required' });
  } } };
  const sink = (x: unknown) => { logs.push(x); };
  const wc = o.workingCentre ?? CENTRE_A;
  const ctx = (over: Row = {}): any => ({ tenantId: o.tenant ?? TENANT_A, actor: { type: 'user', id: USER, membershipId: MEMBERSHIP, centreId: wc }, centreId: wc, requestId: idN(0xf1), operationId: 'x',
    clientIp: '203.0.113.9', tx, ports, storage: storage.forTenant(o.tenant ?? TENANT_A), audit: { access: async (e: any) => { access.push(structuredClone(e)); } }, now: () => NOW,
    log: { info: sink, warn: sink, error: sink, debug: sink, child() { return this; } }, ...over });
  const prints = () => db.all('reporting.print_jobs'); const deliveries = () => db.all('reporting.deliveries');
  return { db, tx, ports, storage, access, roleCalls, logs, ctx, prints, deliveries, printJobs: () => db.jobs.filter((j) => /^reporting\.(render_print|build_bulk_print)$/.test(j.identifier)),
    stmtText: () => db.stmts.map((s) => s.text).join('\n'), allText: (extra: unknown = {}) => JSON.stringify({ a: access, l: logs, r: roleCalls, e: extra }) };
}
export type PrintSetup = ReturnType<typeof printSetup>;

/** Released / draft version fixtures of report 1 (centre A). */
export const released = (i = 1, n = 1, over: Row = {}): Row => versionRow(i, n, { ...RELEASED, ...over });
export const draft = (i = 1, n = 1, over: Row = {}): Row => versionRow(i, n, { status: 'rendered', ...over });
export const withPdf = (v: Row): Record<string, Uint8Array> => ({ [`${REPORTS_BUCKET}::${v['pdf_object_path']}`]: PDF });
export const req = (body: unknown, params: Record<string, string> = {}, headers: Record<string, string> = {}) => ({ params, query: {}, headers, body });
