// T0B-FILESTREAM-1 (LD-312) done_when 1, 2, 3, 5: E23 downloadMyReport used to fetch the signed URL server side and buffer the whole file (arrayBuffer).
// Now the fetch is streamed to the client. The sha256 check against the port digest (07 E23) and the access-log row after a completed stream stay:
// a corrupt file never ends as a good download and writes no report.download row. Same fixtures as reports.handlers.test.ts (global fetch stubbed); synthetic data only.
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bytesOf, expectedSha, memProbe, MiB, sink } from '../../../../core/storage/__tests__/stream.helpers.js';
import { handlers } from '../../handlers/index.js';
import { ID, makeLinkWorld } from '../../__tests__/link.world.js';

const HDR = { 'x-lims-app-version': '1.0.0', 'x-lims-app-platform': 'android' };
const X = ID(0x800); const ORDER_X = ID(0x820); const DAY = 86_400_000;
const hdr = (r: any, n: string): string | undefined => Object.entries<string>(r.headers ?? {}).find(([k]) => k.toLowerCase() === n)?.[1];
const rejection = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e) { return e; } throw new Error('expected a rejection'); };
const bodyBytes = async (b: unknown): Promise<Buffer> => { if (b == null) return Buffer.alloc(0); const p: Buffer[] = []; for await (const c of (b instanceof Uint8Array ? [b] : (b as AsyncIterable<Uint8Array>))) p.push(Buffer.from(c)); return Buffer.concat(p); };
afterEach(() => { vi.unstubAllGlobals(); });

let seq = 0xb00;
function setup(o: { size: number; sha?: string; corruptAfter?: number }) {
  const w = makeLinkWorld(); const a1 = w.seedAccount('+99001000001'); w.seedLink(a1['id'], X);
  const T = Date.parse('2026-11-17T06:00:00Z');
  const report: Record<string, any> = { tenant_id: w.tenantId, report_id: ID(++seq), version_no: 1, order_id: ORDER_X, patient_id: X, report_kind: 'final', status: 'valid', released_at: new Date(T - DAY).toISOString(),
    supersedes_version_no: null, panel_names: ['Synthetic Lipid Profile'], smart_summary_available: false, created_by: ID(0x7aa), updated_by: ID(0x7aa), created_at: w.now(), updated_at: w.now() };
  w.t['patient_reports']!.push(report);
  const sha = o.sha ?? expectedSha(o.size); const fetched: Array<{ url: string; range?: string | null }> = []; const pulled = { bytes: 0 };
  vi.stubGlobal('fetch', async (url: unknown, init?: any) => {
    const range = new Headers(init?.headers).get('range'); fetched.push({ url: String(url), range });
    let start = 0; let len = o.size; let status = 200; const h: Record<string, string> = { 'content-type': 'application/pdf', etag: '"eng-1"' };
    const m = range && /^bytes=(\d+)-(\d*)$/.exec(range);
    if (m) { start = Number(m[1]); const end = m[2] ? Math.min(Number(m[2]), o.size - 1) : o.size - 1; len = end - start + 1; status = 206; h['content-range'] = `bytes ${start}-${end}/${o.size}`; }
    h['content-length'] = String(len); let pos = 0;
    const stream = new ReadableStream<Uint8Array>({ pull(c) { if (pos >= len) return c.close(); const n = Math.min(65536, len - pos); pulled.bytes += n;
      const chunk = bytesOf(start + pos, n); if (o.corruptAfter !== undefined && start + pos >= o.corruptAfter) chunk[0] ^= 0xff; c.enqueue(chunk); pos += n; } }, { highWaterMark: 0 });
    return new Response(stream, { status, headers: h });
  });
  const port = { async openReleasedReportFile(ctx: any, input: { reportId: string; versionNo: number }) {
    if (ctx.actor?.type !== 'patient') throw Object.assign(new Error('nf'), { code: 'common.not_found' });
    return { reportVersionId: ID(0xa00), reportId: input.reportId, versionNo: input.versionNo, status: 'valid', contentType: 'application/pdf', byteSize: o.size, sha256: sha, signedUrl: `https://storage.internal.invalid/reports/${input.reportId}/${input.versionNo}.pdf?X-Sig=SECRETSIG`, expiresAt: new Date(T + 300_000).toISOString() };
  } };
  const ctx = w.patientCtx(a1, { ports: { ...w.ports, ReportingPort: port }, rateLimit: { consume: async () => undefined } });
  const run = (headers: Record<string, string> = {}) => w.inTx(() => (handlers as any).downloadMyReport({ params: { report_id: report['report_id'], version_no: 1 }, query: {}, headers: { ...HDR, ...headers } }, ctx));
  return { w, run, fetched, pulled, report };
}
const rows = (s: ReturnType<typeof setup>) => s.w.audit.filter((a: any) => a.action === 'report.download');

describe('E23 downloadMyReport streams the fetch', () => {
  it('200: the body is a stream, Content-Length is the file size, no-store / nosniff / attachment unchanged, no storage URL anywhere; ONE report.download row after the stream completed', async () => {
    const s = setup({ size: 3 * MiB }); const res = await s.run();
    expect(res.status).toBe(200); expect(res.body).not.toBeInstanceOf(Uint8Array);
    expect(hdr(res, 'content-length')).toBe(String(3 * MiB)); expect(hdr(res, 'cache-control')).toBe('no-store'); expect(hdr(res, 'x-content-type-options')).toBe('nosniff');
    expect(hdr(res, 'content-disposition')).toMatch(/^attachment; filename="report-1\.pdf"/); expect(hdr(res, 'content-type')).toBe('application/pdf');
    const got = await sink(res.body);
    expect(got).toEqual({ size: 3 * MiB, sha256: expectedSha(3 * MiB) });
    expect(rows(s)).toHaveLength(1);
    expect(JSON.stringify(res.headers)).not.toMatch(/storage\.internal|X-Sig|SECRETSIG/i);
  });
  it('Range -> 206 with Content-Range and exactly those bytes, one access-log row; an unsatisfiable range -> 416 and no row', async () => {
    const s = setup({ size: 1000 }); const res = await s.run({ range: 'bytes=100-199' });
    expect(res.status).toBe(206); expect(hdr(res, 'content-range')).toBe('bytes 100-199/1000'); expect(hdr(res, 'content-length')).toBe('100');
    expect((await bodyBytes(res.body)).equals(bytesOf(100, 100))).toBe(true); expect(rows(s)).toHaveLength(1);
    const t = setup({ size: 1000 }); const r416 = await t.run({ range: 'bytes=5000-' });
    expect(r416.status).toBe(416); expect(hdr(r416, 'content-range')).toBe('bytes */1000'); expect(rows(t)).toHaveLength(0);
  });
  it('a corrupt file (bytes differ from the port digest) never ends as a good download: the request or the body fails, and no report.download row is written', async () => {
    const s = setup({ size: 2 * MiB, corruptAfter: MiB });
    const outcome = await (async () => { try { const res = await s.run(); await bodyBytes(res.body); return 'delivered'; } catch (e) { return e as any; } })();
    expect(outcome).not.toBe('delivered'); expect(rows(s)).toHaveLength(0);
  });
  it('a wrong digest from the port: same, no row; a storage that answers 500 is a dependency failure, no row', async () => {
    const s = setup({ size: 1000, sha: createHash('sha256').update('other').digest('hex') });
    expect(await (async () => { try { const r = await s.run(); await bodyBytes(r.body); return 'delivered'; } catch { return 'failed'; } })()).toBe('failed'); expect(rows(s)).toHaveLength(0);
    const t = setup({ size: 1000 }); vi.stubGlobal('fetch', async () => new Response('boom', { status: 500 }));
    const e = await rejection(t.run().then((r: any) => bodyBytes(r.body))); expect(e.code ?? e.message).toBeDefined(); expect(rows(t)).toHaveLength(0);
  });
  it('50 MB report: pushed through the handler to a sink with growth <= 20 MB', async () => {
    const s = setup({ size: 50 * MiB }); const probe = memProbe();
    const res = await s.run(); const got = await sink(res.body, probe);
    expect(got).toEqual({ size: 50 * MiB, sha256: expectedSha(50 * MiB) }); expect(rows(s)).toHaveLength(1);
    expect(probe.growthMiB(), `grew ${probe.growthMiB().toFixed(1)} MiB`).toBeLessThanOrEqual(20);
  }, 180_000);
});
