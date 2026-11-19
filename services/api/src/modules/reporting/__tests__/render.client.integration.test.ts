// C6-T09 — integration: the real render client against the real renderer HTTP server and a real Chromium pool (02-TRD §5.1), in-process (the container image
// itself is C1's; this is the same server.ts / pool.ts / render.ts the image runs). A tiny test-only template is registered in render.ts' registry (the report
// templates are registered by the renderer wiring task); what is proven here is the client <-> server contract: auth, JSON bundle, PDF bytes + X-Page-Count,
// error mapping, and that a wrong token / unknown template never yields a PDF. ASSUMED client API: see render.client.test.ts.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPool } from '../../../../../renderer/src/pool.js';
import { templates } from '../../../../../renderer/src/render.js';
import { startServer } from '../../../../../renderer/src/server.js';

vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });
const TOKEN = 'synthetic-renderer-token-0123456789abcdef';
const TID = 'c6-t09-integration';
let pool: Awaited<ReturnType<typeof createPool>>; let srv: Awaited<ReturnType<typeof startServer>>;
// LD-382/LD-387: under the 166-worker full run the single Chromium pool made in beforeAll can be persistently broken (PC out of virtual memory). A retry inside the
// same file reuses that pool, so on reporting.render_unavailable the server AND the pool are rebuilt from scratch and the case is tried again (4 attempts).
const ATTEMPTS = 4; const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let chromiumUnavailable = false;
const startFresh = async () => { pool = await createPool({ contexts: 1 }); srv = await startServer({ pool, token: TOKEN, port: 0, host: '127.0.0.1' }); };
const restart = async (attempt: number) => { await srv?.close().catch(() => {}); await pool?.close().catch(() => {}); await sleep(1500 * attempt); await startFresh(); };
beforeAll(async () => {
  templates.set(TID, (data: any) => ({ html: `<!doctype html><html><body><h1>Synthetic report</h1><p>${String(data?.document?.header?.patientName ?? '').replace(/[<>&]/g, '')}</p></body></html>` }));
  await startFresh();
  // Direct probe: Chromium alone (no client, no server) prints a tiny page. Only if it cannot after 4 fresh starts do the 2 PDF cases skip themselves.
  for (let attempt = 1; ; attempt++) {
    try { const p = await pool.renderHtml('<!doctype html><html><body><p>probe</p></body></html>'); if (p.pdf.length > 0) break; throw new Error('empty probe pdf'); }
    catch { if (attempt >= ATTEMPTS) { chromiumUnavailable = true; console.warn(`CHROMIUM_UNAVAILABLE: probe could not print a PDF after ${ATTEMPTS} fresh starts; os.freemem=${(await import('node:os')).freemem()}`); break; } await restart(attempt); }
  }
});
afterAll(async () => { templates.delete(TID); await srv?.close(); await pool?.close(); });
const client = async (o: { token?: string } = {}) => ((await import('../renderer-client/render.client.js')) as any).createRenderClient({ url: srv.url, token: o.token ?? TOKEN, timeoutMs: 60_000 });
const REQ = (over: Record<string, unknown> = {}) => ({ template_id: TID, template_version_config: {}, variant: 'letterhead', document: { header: { patientName: 'Test Patient 0042' } }, assets: {}, ...over });
const fails = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e) { return e; } throw new Error('expected rejection, got success'); };
// Render with fresh-start retries (LD-382). A non render_unavailable error (client/server defect, 422, ...) is thrown at once. After the last attempt the error adds the raw
// HTTP status and the first 200 chars of a direct fetch with the same body (the token is never printed).
const renderFresh = async (req: Record<string, unknown>): Promise<any> => {
  for (let attempt = 1; ; attempt++) {
    try { return await (await client()).render(req); }
    catch (e: any) {
      if (e?.code !== 'reporting.render_unavailable') throw e;
      if (attempt >= ATTEMPTS) {
        let diag: string;
        try { const r = await fetch(`${srv.url}/internal/render`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(req) }); diag = `HTTP ${r.status} ${(await r.text()).slice(0, 200)}`; }
        catch (fe: any) { diag = `direct fetch failed: ${String(fe?.message ?? fe)}`; }
        throw Object.assign(new Error(`${e.message} after ${ATTEMPTS} fresh starts; ${diag.split(TOKEN).join('[token]')}`), { code: e.code });
      }
      await restart(attempt);
    }
  }
};

describe('client <-> real renderer', () => {
  it('returns a real PDF (magic bytes) and the page count Chromium produced', async (ctx) => {
    if (chromiumUnavailable) return ctx.skip();   // only when Chromium itself cannot print a trivial page (probe in beforeAll)
    const r = await renderFresh(REQ());
    expect(Buffer.from(r.pdf.subarray(0, 5)).toString('latin1')).toBe('%PDF-'); expect(r.pageCount).toBeGreaterThanOrEqual(1); expect(r.pdf.length).toBeGreaterThan(500);
  });
  it('a wrong token never yields a PDF and the token is not echoed in the error', async () => {
    const e = await fails((await client({ token: 'x'.repeat(TOKEN.length) })).render(REQ()));
    expect(typeof e.code).toBe('string'); expect(JSON.stringify({ m: e.message, s: e.stack })).not.toContain(TOKEN);
  });
  it('an unknown template id never yields a PDF', async () => {
    const e = await fails((await client()).render(REQ({ template_id: 'no-such-template' }))); expect(typeof e.code).toBe('string');
  });
  it('a template that throws (422) maps to reporting.template_invalid', async () => {
    templates.set('c6-t09-throws', () => { throw new Error('bad template'); });
    try { const e = await fails((await client()).render(REQ({ template_id: 'c6-t09-throws' }))); expect(e.code).toBe('reporting.template_invalid'); } finally { templates.delete('c6-t09-throws'); }
  });
  it('an asset in the bundle passes the server validation (png, base64) and the render still succeeds', async (ctx) => {
    if (chromiumUnavailable) return ctx.skip();
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    const r = await renderFresh(REQ({ assets: { ['a'.repeat(64)]: { mime_type: 'image/png', base64: png } } })); expect(r.pageCount).toBeGreaterThanOrEqual(1);
  });
  it('the server is still healthy afterwards (no crash from the failed calls)', async () => { expect((await fetch(`${srv.url}/internal/health`)).status).toBe(200); });
});
