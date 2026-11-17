// C6-T09 — R8 POST /report-versions/{report_version_id}/retry-render (operationId retryRenderReportVersion; 02-TRD §6.3; 03-APP-FLOW V4).
// Contract: permission reporting.report.render; If-Match = the version row's `version`; 202 ReportVersionSummary with status `rendering`;
// common.immutable_record when status != render_failed. V4: render_failed -> rendering, attempts counter reset, render job enqueued.
// ASSUMED: the handler takes the tenant tx from the handler context (tenantId, actor.id, tx) like O1-O6, enqueues through `SELECT app.enqueue_job(...)` with
// job key `render:<report_version_id>`, max_attempts 5, payload { tenant_id, report_id, report_version_id } (the key the stuck-render sweep also uses);
// rendering_started_at is set to now (the sweep measures "> 15 min" from it). DB = the worker's single-transaction fake (consumers.helpers.ts), reused here.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { REPO_ROOT, loadSpec } from '../../../core/module.js';
import { LAB, TENANT_A, TENANT_B, idN, versionRow, world } from '../../../../../worker/src/jobs/reporting/__tests__/assemble.helpers.js';
import { SYSTEM_ACTOR } from '../../../../../worker/src/jobs/reporting/__tests__/consumers.helpers.js';

const OP = 'retryRenderReportVersion';
const VID = idN(0xc001);
const failed = (over: Record<string, unknown> = {}) => versionRow(1, {
  status: 'render_failed', pdf_object_path: null, pdf_sha256: null, pdf_bytes: null, page_count: null, render_attempts: 5, last_render_error_code: 'reporting.render_unavailable',
  rendering_started_at: '2026-11-07T10:00:00.000Z', rendered_at: null, created_at: '2026-11-07T09:50:00.000Z', version: 4, ...over });
let manifest: any;
beforeAll(async () => {
  const k = join(mkdtempSync(join(tmpdir(), 'c6-t09-')), 'otp.key'); writeFileSync(k, Buffer.alloc(32, 7));
  process.env.LIMS_CORE_ENV = 'dev'; delete process.env.NODE_ENV; delete process.env.LIMS_REPORTING_ALLOW_REAL_PROVIDERS; process.env.LIMS_REPORTING_OTP_HMAC_KEY_FILE = k;
  manifest = (await import('../index.js')).manifest;
});
const rejection = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e) { return e; } throw new Error('expected rejection, got success'); };
function setup(v: Record<string, unknown> | null = failed(), o: { rls?: boolean } = {}) {
  const w = world({ versions: v ? [v] : [], ...(o.rls === undefined ? {} : { rls: o.rls }) });
  const ctx = { tenantId: TENANT_A, actor: { type: 'user', id: idN(0xa001) }, tx: w.db.tx, requestId: idN(0xf1), operationId: OP, clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} } };
  const call = (over: { id?: string; ifMatch?: string | undefined; ctx?: any } = {}) => {
    const headers: Record<string, string> = over.ifMatch === undefined && 'ifMatch' in over ? {} : { 'if-match': over.ifMatch ?? '"4"' };
    return manifest.handlers[OP]({ params: { report_version_id: over.id ?? VID }, query: {}, headers, body: undefined }, over.ctx ?? ctx);
  };
  return { ...w, call, ctx, row: () => w.db.all('reporting.report_versions').find((r) => r['id'] === (v?.['id'] ?? VID))! };
}

describe('contract', () => {
  it('operation exists, requires reporting.report.render, Idempotency-Key and If-Match; 202 documented', () => {
    const spec: any = loadSpec(join(REPO_ROOT, 'contracts/openapi/reporting.yaml'));
    const op = spec.paths['/v1/reporting/report-versions/{report_version_id}/retry-render'].post;
    expect(op.operationId).toBe(OP); expect(op['x-permission']).toBe('reporting.report.render'); expect(op['x-idempotency']).toBe('required'); expect(Object.keys(op.responses)).toContain('202');
  });
  it('is no longer a 501 stub: without a request context it fails closed (auth.unauthenticated), echoing no input', async () => {
    const planted = 'PLANTED-TOKEN-7d2e';
    const e = await rejection(manifest.handlers[OP]({ params: { report_version_id: planted }, query: {}, headers: { 'if-match': '"1"', authorization: planted }, body: undefined }, { operationId: OP, clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} } }));
    expect(e?.code).toBe('auth.unauthenticated'); expect(JSON.stringify({ c: e?.code, m: e?.message, d: e?.details })).not.toContain(planted);
  });
});

describe('V4 render_failed -> rendering', () => {
  it('202 ReportVersionSummary with status `rendering`, version bumped (ETag), last error cleared', async () => {
    const s = setup(); const r = await s.call();
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ id: VID, version_no: 1, status: 'rendering', version: 5 });
    expect(r.body.last_render_error_code ?? null).toBeNull(); expect(r.headers?.etag).toBe('"5"');
  });
  it('row: status rendering, render_attempts reset to 0, last_render_error_code NULL, rendering_started_at = now, version + 1, pdf_* still NULL', async () => {
    const s = setup(); await s.call(); const v = s.row();
    expect(v).toMatchObject({ status: 'rendering', render_attempts: 0, last_render_error_code: null, version: 5, pdf_object_path: null, pdf_sha256: null });
    expect(v['rendering_started_at']).toBe('2026-11-07T12:00:30.000Z');
  });
  it('enqueues exactly one render job: key render:<version_id>, 5 attempts, payload with tenant / report / version ids', async () => {
    const s = setup(); await s.call();
    expect(s.db.jobs).toHaveLength(1);
    expect(s.db.jobs[0]).toMatchObject({ identifier: 'reporting.render_report_version', jobKey: `render:${VID}`, maxAttempts: 5 });
    expect(s.db.jobs[0]!.payload).toMatchObject({ tenant_id: TENANT_A, report_id: LAB, report_version_id: VID });
  });
  it('only mutable columns change: content_snapshot / content_sha256 / template_version_id / version_no untouched', async () => {
    const s = setup(); const keep = (r: any) => JSON.stringify([r['content_snapshot'], r['content_sha256'], r['template_version_id'], r['version_no'], r['report_id']]);
    const before = keep(s.row()); await s.call(); expect(keep(s.row())).toBe(before);
  });
  it('actor is recorded as updated_by', async () => {
    const s = setup(); await s.call(); expect(s.row()['updated_by']).toBe(idN(0xa001)); expect(s.row()['updated_by']).not.toBe(SYSTEM_ACTOR);
  });
});

describe('immutable_record: only render_failed can be retried', () => {
  it.each(['rendering', 'rendered', 'released', 'superseded', 'discarded'])('status %s -> common.immutable_record, nothing written, no job', async (st) => {
    const s = setup(failed({ status: st })); const before = JSON.stringify(s.row());
    const e = await rejection(s.call()); expect(e?.code).toBe('common.immutable_record');
    expect(s.db.writes()).toHaveLength(0); expect(s.db.jobs).toHaveLength(0); expect(JSON.stringify(s.row())).toBe(before);
  });
  it('a second retry right after the first (now `rendering`) is refused, not double-enqueued', async () => {
    const s = setup(); await s.call();
    const e = await rejection(s.call({ ifMatch: '"5"' })); expect(e?.code).toBe('common.immutable_record'); expect(s.db.jobs).toHaveLength(1);
  });
});

describe('If-Match / lookup / tenancy', () => {
  it('missing If-Match -> common.precondition_required', async () => {
    const s = setup(); const e = await rejection(s.call({ ifMatch: undefined })); expect(e?.code).toBe('common.precondition_required'); expect(s.db.writes()).toHaveLength(0); expect(s.db.jobs).toHaveLength(0);
  });
  it('stale If-Match -> common.version_conflict, nothing written, no job', async () => {
    const s = setup(); const e = await rejection(s.call({ ifMatch: '"3"' })); expect(e?.code).toBe('common.version_conflict');
    expect(s.row()).toMatchObject({ status: 'render_failed', version: 4 }); expect(s.db.jobs).toHaveLength(0);
  });
  it.each(['4', '"abc"', '""', '"0"', 'W/"4"'])('malformed If-Match %s -> rejected, nothing changes', async (h) => {
    const s = setup(); const e = await rejection(s.call({ ifMatch: h })); expect(['common.validation_failed', 'common.precondition_required', 'common.version_conflict']).toContain(e?.code);
    expect(s.row()['status']).toBe('render_failed'); expect(s.db.jobs).toHaveLength(0);
  });
  it('unknown version id -> common.not_found', async () => {
    const s = setup(); const e = await rejection(s.call({ id: idN(0xdead) })); expect(e?.code).toBe('common.not_found'); expect(s.db.jobs).toHaveLength(0);
  });
  it('another tenant\'s version -> the same common.not_found (no existence leak) — even with RLS off the statements name tenant_id', async () => {
    const s = setup(failed({ tenant_id: TENANT_B }), { rls: false }); const e = await rejection(s.call());
    expect(e?.code).toBe('common.not_found'); expect(s.row()['status']).toBe('render_failed'); expect(s.db.jobs).toHaveLength(0);
    expect(s.db.reportingStmts().length).toBeGreaterThan(0); expect(s.db.reportingStmts().every((x) => /\btenant_id\b/i.test(x.text))).toBe(true);
  });
  it('non-uuid id -> rejected without touching the database', async () => {
    const s = setup(); const e = await rejection(s.call({ id: "x'; DROP TABLE reporting.report_versions;--" })); expect(['common.validation_failed', 'common.not_found']).toContain(e?.code);
    expect(s.db.writes()).toHaveLength(0);
  });
  it('error responses never echo the If-Match or the id', async () => {
    const s = setup(); const planted = 'PLANTED-9c1b'; const e = await rejection(s.call({ id: planted, ifMatch: planted }));
    expect(JSON.stringify({ c: e?.code, m: e?.message, d: e?.details })).not.toContain(planted);
  });
});
