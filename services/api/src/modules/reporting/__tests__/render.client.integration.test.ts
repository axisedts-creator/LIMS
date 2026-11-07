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
beforeAll(async () => {
  templates.set(TID, (data: any) => ({ html: `<!doctype html><html><body><h1>Synthetic report</h1><p>${String(data?.document?.header?.patientName ?? '').replace(/[<>&]/g, '')}</p></body></html>` }));
  pool = await createPool({ contexts: 2 });
  srv = await startServer({ pool, token: TOKEN, port: 0, host: '127.0.0.1' });
});
afterAll(async () => { templates.delete(TID); await srv?.close(); await pool?.close(); });
const client = async (o: { token?: string } = {}) => ((await import('../renderer-client/render.client.js')) as any).createRenderClient({ url: srv.url, token: o.token ?? TOKEN, timeoutMs: 60_000 });
const REQ = (over: Record<string, unknown> = {}) => ({ template_id: TID, template_version_config: {}, variant: 'letterhead', document: { header: { patientName: 'Test Patient 0042' } }, assets: {}, ...over });
const fails = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e) { return e; } throw new Error('expected rejection, got success'); };

describe('client <-> real renderer', () => {
  it('returns a real PDF (magic bytes) and the page count Chromium produced', async () => {
    const r = await (await client()).render(REQ());
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
  it('an asset in the bundle passes the server validation (png, base64) and the render still succeeds', async () => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    const r = await (await client()).render(REQ({ assets: { ['a'.repeat(64)]: { mime_type: 'image/png', base64: png } } })); expect(r.pageCount).toBeGreaterThanOrEqual(1);
  });
  it('the server is still healthy afterwards (no crash from the failed calls)', async () => { expect((await fetch(`${srv.url}/internal/health`)).status).toBe(200); });
});
