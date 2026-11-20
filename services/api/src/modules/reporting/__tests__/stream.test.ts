// T0B-FILESTREAM-1 (LD-312) done_when 1, 2, 3, 6: reporting downloads (R5 downloadReportVersionPdf, R12 downloadReportPrintPdf, P4 portal) send a stream with
// Content-Length / ETag, answer Range with 206 and If-None-Match with 304, keep every header they set today (attachment, nosniff, no-store, CSP sandbox) and the
// access-log row. The existing reports-read / print / portal tests stay valid: a ctx.storage that only has read() still gets the old whole-bytes answer.
// Prescribed: handlers pass req.headers as requestHeaders to core/storage/stream.ts streamStored(ctx.storage, { bucket, objectPath, headers, cache?, requestHeaders }).
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { beforeAll, describe, expect, it } from 'vitest';
import { makeStreamStorage, bytesOf } from '../../../core/storage/__tests__/stream.helpers.js';
import { PDF as RPDF, RELEASED, TENANT_A, VID, readSetup, reportRow, versionRow } from './reports-read.helpers.js';
import { PID, PRINTS_BUCKET, REPORTS_BUCKET, printRow, printSetup, released, withPdf } from './print.helpers.js';

let manifest: any;
beforeAll(async () => {
  const k = join(mkdtempSync(join(tmpdir(), 'fs1-')), 'otp.key'); writeFileSync(k, Buffer.alloc(32, 7));
  process.env.LIMS_CORE_ENV = 'dev'; delete process.env.NODE_ENV; delete process.env.LIMS_REPORTING_ALLOW_REAL_PROVIDERS; process.env.LIMS_REPORTING_OTP_HMAC_KEY_FILE = k;
  manifest = (await import('../index.js')).manifest;
});
const hdr = (r: any, n: string): string | undefined => Object.entries<string>(r.headers ?? {}).find(([k]) => k.toLowerCase() === n)?.[1];
const bodyBytes = async (b: unknown): Promise<Buffer> => { if (b == null) return Buffer.alloc(0); const p: Buffer[] = []; for await (const c of (b instanceof Uint8Array ? [b] : (b as AsyncIterable<Uint8Array>))) p.push(Buffer.from(c)); return Buffer.concat(p); };
const ETAG = '"rep-v1"';
const src = (rel: string) => readFileSync(join(fileURLToPath(new URL('..', import.meta.url)), rel), 'utf8');

describe('R5 downloadReportVersionPdf streams', () => {
  const rel = versionRow(1, 1, RELEASED); const path = rel['pdf_object_path'] as string;
  async function go(headers: Record<string, string> = {}, size = 4000) {
    const s = readSetup({ reports: [reportRow(1, { latest_version_no: 1 })], versions: [rel], pdf: { [path]: RPDF } });
    const st = await makeStreamStorage('reporting', TENANT_A);
    st.f.seed(REPORTS_BUCKET, path, { size, bytes: bytesOf(0, size), etag: ETAG });
    const ctx = s.ctx({ operationId: 'downloadReportVersionPdf', storage: st.storage });
    const res = await manifest.handlers.downloadReportVersionPdf({ params: { report_version_id: VID(1, 1) }, query: {}, headers, body: undefined }, ctx);
    return { s, st, res };
  }
  it('200: a Readable, never read() of the whole object, Content-Length, ETag, Accept-Ranges, and the headers it sets today are all still there', async () => {
    const { s, st, res } = await go();
    expect(res.status).toBe(200); expect(res.body).toBeInstanceOf(Readable); expect(st.f.count('get')).toBe(0);
    expect(hdr(res, 'content-type')).toBe('application/pdf'); expect(hdr(res, 'content-disposition')).toBe('attachment; filename="report-v1.pdf"');
    expect(hdr(res, 'x-content-type-options')).toBe('nosniff'); expect(hdr(res, 'cache-control')).toBe('no-store'); expect(hdr(res, 'content-security-policy')).toBe('sandbox');
    expect(hdr(res, 'content-length')).toBe('4000'); expect(hdr(res, 'etag')).toBe(ETAG); expect(hdr(res, 'accept-ranges')).toBe('bytes');
    expect((await bodyBytes(res.body)).equals(bytesOf(0, 4000))).toBe(true);
    expect(s.access).toEqual([expect.objectContaining({ action: 'report.download', entityType: 'report_version', outcome: 'allowed' })]);
  });
  it('Range -> 206 with Content-Range and exactly those bytes; one access-log row', async () => {
    const { s, res } = await go({ range: 'bytes=100-199' });
    expect(res.status).toBe(206); expect(hdr(res, 'content-range')).toBe('bytes 100-199/4000'); expect(hdr(res, 'content-length')).toBe('100');
    expect((await bodyBytes(res.body)).equals(bytesOf(100, 100))).toBe(true); expect(s.access).toHaveLength(1);
  });
  it('If-None-Match with the current ETag -> 304 with no body; unsatisfiable range -> 416 and no access-log row', async () => {
    const a = await go({ 'if-none-match': ETAG }); expect(a.res.status).toBe(304); expect((await bodyBytes(a.res.body)).length).toBe(0);
    const b = await go({ range: 'bytes=9000-' }); expect(b.res.status).toBe(416); expect(hdr(b.res, 'content-range')).toBe('bytes */4000'); expect(b.s.access).toHaveLength(0);
  });
  it('the draft rule is unchanged: an unreleased version without reporting.report.release is 409 before any storage call', async () => {
    const unrel = versionRow(1, 2, {});
    const s = readSetup({ reports: [reportRow(1, { latest_version_no: 2 })], versions: [unrel], denied: ['reporting.report.release'], pdf: { [unrel['pdf_object_path'] as string]: RPDF } });
    const st = await makeStreamStorage('reporting', TENANT_A);
    const e: any = await manifest.handlers.downloadReportVersionPdf({ params: { report_version_id: VID(1, 2) }, query: {}, headers: {}, body: undefined }, s.ctx({ operationId: 'x', storage: st.storage })).then(() => undefined, (x: any) => x);
    expect(e?.code).toBe('reporting.report_not_released'); expect(st.f.calls).toEqual([]); expect(s.access).toEqual([]);
  });
});

describe('R12 downloadReportPrintPdf streams', () => {
  async function go(over: Record<string, unknown>, headers: Record<string, string>, bucket: string, pathOf: (v: any) => string) {
    const v = released(); const s = printSetup({ versions: [v], prints: [printRow(1, over)], objects: { ...withPdf(v) } });
    const st = await makeStreamStorage('reporting', TENANT_A); const p = pathOf(v);
    st.f.seed(bucket, p, { size: 3000, bytes: bytesOf(0, 3000), etag: '"print-1"' });
    const res = await manifest.handlers.downloadReportPrintPdf({ params: { print_id: PID(1) }, query: {}, headers, body: undefined }, s.ctx({ operationId: 'downloadReportPrintPdf', storage: st.storage }));
    return { s, st, res };
  }
  it('a print file (reporting-prints): streamed, Content-Length, ETag, headers kept, one access-log row', async () => {
    const { s, st, res } = await go({}, {}, PRINTS_BUCKET, () => `${TENANT_A}/prints/${PID(1)}.pdf`);
    expect(res.status).toBe(200); expect(res.body).toBeInstanceOf(Readable); expect(st.f.count('get')).toBe(0);
    expect(hdr(res, 'content-disposition')).toBe(`attachment; filename="print-${PID(1)}.pdf"`); expect(hdr(res, 'cache-control')).toBe('no-store'); expect(hdr(res, 'content-length')).toBe('3000'); expect(hdr(res, 'etag')).toBe('"print-1"');
    expect((await bodyBytes(res.body)).length).toBe(3000); expect(s.access).toHaveLength(1);
  });
  it('a letterhead single (canonical version PDF from bucket reports): Range -> 206', async () => {
    const { res } = await go({ variant: 'letterhead', object_path: null, sha256: null, page_count: null }, { range: 'bytes=0-9' }, REPORTS_BUCKET, (v) => v['pdf_object_path']);
    expect(res.status).toBe(206); expect(hdr(res, 'content-range')).toBe('bytes 0-9/3000'); expect((await bodyBytes(res.body)).equals(bytesOf(0, 10))).toBe(true);
  });
});

describe('no whole-object read is left in the reporting download code (static)', () => {
  const FILES = ['handlers/reports-read.handlers.ts', 'service/print.service.ts', 'service/portal.service.ts', 'handlers/portal.handlers.ts'];
  it.each(FILES)('%s does not call storage.read( for a download and does not size a body with bytes.length', (f) => {
    const t = src(f).split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
    if (f.endsWith('print.service.ts') || f.endsWith('reports-read.handlers.ts') || f.endsWith('portal.service.ts')) expect(t).not.toMatch(/storage\.read\(\s*(REPORT_BUCKET|'reports'|bucket)/);
    expect(t).not.toMatch(/String\((bytes|out\.bytes)\.length\)/);
  });
  it.each(['handlers/reports-read.handlers.ts', 'service/print.service.ts', 'handlers/portal.handlers.ts'])('%s uses streamStored and forwards the request headers', (f) => {
    const t = src(f); expect(t).toMatch(/streamStored/); expect(t).toMatch(/requestHeaders/);
  });
  it('the staff handlers still pin no-store (patient report) - never public, never a max-age', () => {
    for (const f of ['handlers/reports-read.handlers.ts', 'service/print.service.ts', 'handlers/portal.handlers.ts']) expect(src(f)).not.toMatch(/public|max-age/);
  });
});
