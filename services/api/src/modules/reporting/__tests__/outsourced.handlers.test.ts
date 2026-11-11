// C6-T10 — O1-O6 HTTP wiring (02-TRD §6.4; contracts/openapi/reporting.yaml). The six operations leave the 501 list, fail closed without an
// authenticated context, and O5 answers with the download header set of REQ-SEC-083 (attachment + nosniff + no-store + CSP sandbox).
// ASSUMED request shapes: upload req.body = { file: {filename,mimeType,bytes}, external_lab_name } (core multipart layer, 02-CV §10.2);
// If-Match header `"<version>"` (02-CV §4.2); params named as in the OpenAPI path templates. Context = the service ctx of outsourced.helpers.ts.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { BUCKET, ITEM_1, SANITIZED, SENTINEL_NAME, eicarPdf, fileRow, incoming, makeApiCtx, makeDb, makeStorage, pdfBytes, rejection, sanitizedPath, sha256, world, TENANT_A } from './outsourced.helpers.js';

const OPS = ['uploadOutsourcedReport', 'listOutsourcedReports', 'confirmOutsourcedReport', 'withdrawOutsourcedReport', 'downloadOutsourcedReport', 'listOutsourcedItems'];
let manifest: any;
beforeAll(async () => {
  const k = join(mkdtempSync(join(tmpdir(), 'c6-t10-')), 'otp.key'); writeFileSync(k, Buffer.alloc(32, 7));
  process.env.LIMS_CORE_ENV = 'dev'; delete process.env.NODE_ENV; delete process.env.LIMS_REPORTING_ALLOW_REAL_PROVIDERS; process.env.LIMS_REPORTING_OTP_HMAC_KEY_FILE = k;
  manifest = (await import('../index.js')).manifest;
});
const hctx = (operationId: string, extra: Record<string, unknown> = {}) => ({ operationId, clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} }, ...extra });
function full(operationId: string, seed: Record<string, any[]> = {}) {
  const db = makeDb({ ...world(), ...seed }); const storage = makeStorage(); const c = makeApiCtx(db, storage);
  return { db, storage, ...c, hctx: { ...c.ctx, ...hctx(operationId) } };
}
const ifm = (v: number) => ({ 'if-match': `"${v}"` });

describe('no longer 501 stubs', () => {
  it.each(OPS)('%s has a real handler (does not answer 501 without a context; it fails closed)', async (op) => {
    const e = await rejection(manifest.handlers[op]({ params: {}, query: {}, headers: {}, body: undefined }, hctx(op)));
    expect(e?.code).toBe('auth.unauthenticated');
  });
  it('a failed call echoes no request input', async () => {
    const planted = 'PLANTED-TOKEN-9f3a';
    const e = await rejection(manifest.handlers.confirmOutsourcedReport({ params: { file_id: planted }, query: {}, headers: { authorization: planted }, body: { x: planted } }, hctx('confirmOutsourcedReport')));
    expect(JSON.stringify({ c: e?.code, m: e?.message, d: e?.details })).not.toContain(planted);
  });
});

describe('O1 uploadOutsourcedReport', () => {
  it('201 InputFile pending_scan', async () => {
    const { hctx: c, db } = full('uploadOutsourcedReport');
    const r = await manifest.handlers.uploadOutsourcedReport({ params: { order_item_id: ITEM_1 }, query: {}, headers: {}, body: { file: incoming(pdfBytes(8192)), external_lab_name: 'Synthetic Reference Lab' } }, c);
    expect(r.status).toBe(201); expect(r.body).toMatchObject({ state: 'pending_scan', order_item_id: ITEM_1 }); expect(db.files()).toHaveLength(1);
  });
  it('a scanner hit surfaces as 422 reporting.outsourced_pdf_rejected, nothing stored', async () => {
    const { hctx: c, db, storage } = full('uploadOutsourcedReport');
    const e = await rejection(manifest.handlers.uploadOutsourcedReport({ params: { order_item_id: ITEM_1 }, query: {}, headers: {}, body: { file: incoming(eicarPdf()), external_lab_name: 'L' } }, c));
    expect(e?.code).toBe('reporting.outsourced_pdf_rejected'); expect(db.files()).toHaveLength(0); expect(storage.objects.size).toBe(0);
  });
});

describe('O3 / O4 If-Match + ETag', () => {
  it('confirm: missing If-Match -> 428; malformed -> 400; valid -> 200 with ETag "<new version>"', async () => {
    const f = fileRow({ state: 'ready' }); const { hctx: c } = full('confirmOutsourcedReport', { input_files: [f] });
    const req = (headers: Record<string, string>) => ({ params: { file_id: f.id }, query: {}, headers, body: { patient_match_confirmed: true } });
    expect((await rejection(manifest.handlers.confirmOutsourcedReport(req({}), c)))?.code).toBe('common.precondition_required');
    expect((await rejection(manifest.handlers.confirmOutsourcedReport(req({ 'if-match': 'W/"1"' }), c)))?.code).toBe('common.validation_failed');
    const ok = await manifest.handlers.confirmOutsourcedReport(req(ifm(1)), c);
    expect(ok.status).toBe(200); expect(ok.body.state).toBe('confirmed'); expect(ok.headers?.etag).toBe('"2"');
  });
  it('withdraw: 200 withdrawn with ETag', async () => {
    const f = fileRow({ state: 'ready' }); const { hctx: c } = full('withdrawOutsourcedReport', { input_files: [f] });
    const ok = await manifest.handlers.withdrawOutsourcedReport({ params: { file_id: f.id }, query: {}, headers: ifm(1), body: { reason_code: 'wrong_patient' } }, c);
    expect(ok.status).toBe(200); expect(ok.body.state).toBe('withdrawn'); expect(ok.headers?.etag).toBe('"2"');
  });
});

describe('O2 / O5', () => {
  it('list -> 200 {data}', async () => {
    const f = fileRow({ state: 'ready' }); const { hctx: c } = full('listOutsourcedReports', { input_files: [f] });
    const r = await manifest.handlers.listOutsourcedReports({ params: { order_item_id: ITEM_1 }, query: {}, headers: {}, body: undefined }, c);
    expect(r.status).toBe(200); expect(r.body.data.map((x: any) => x.id)).toEqual([f.id]);
  });
  it('download -> sanitised bytes with attachment + nosniff + no-store + CSP sandbox; filename cannot inject headers', async () => {
    const f = fileRow({ state: 'ready', original_filename: `${SENTINEL_NAME}";\r\nX-Evil: 1` }); f.sanitized_object_path = sanitizedPath(TENANT_A, f.id); f.sanitized_sha256 = sha256(SANITIZED);
    const { hctx: c, storage } = full('downloadOutsourcedReport', { input_files: [f] });
    storage.objects.set(`${BUCKET}::${f.sanitized_object_path}`, SANITIZED);
    const r = await manifest.handlers.downloadOutsourcedReport({ params: { file_id: f.id }, query: {}, headers: {}, body: undefined }, c);
    expect(r.status).toBe(200); expect(Buffer.from(r.body).equals(Buffer.from(SANITIZED))).toBe(true);
    const h = Object.fromEntries(Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
    expect(h['content-type']).toMatch(/^application\/pdf/); expect(h['content-disposition']).toMatch(/^attachment/);
    expect(h['x-content-type-options']).toBe('nosniff'); expect(h['cache-control']).toBe('no-store'); expect(h['content-security-policy']).toBe('sandbox');
    for (const v of Object.values(h)) expect(v).not.toMatch(/[\r\n]/);
    expect(Object.keys(h).some((k) => k === 'x-evil')).toBe(false);
  });
  it('download of a pending_scan file -> 409 reporting.input_file_not_ready', async () => {
    const f = fileRow({ state: 'pending_scan' }); const { hctx: c } = full('downloadOutsourcedReport', { input_files: [f] });
    expect((await rejection(manifest.handlers.downloadOutsourcedReport({ params: { file_id: f.id }, query: {}, headers: {}, body: undefined }, c)))?.code).toBe('reporting.input_file_not_ready');
  });
});
