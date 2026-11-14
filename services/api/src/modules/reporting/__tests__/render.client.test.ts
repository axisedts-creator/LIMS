// C6-T09 — renderer-client/render.client.ts: internal HTTP client of POST /internal/render (02-TRD §5.1). Worker-side use only.
// ASSUMED API: createRenderClient({ url: string, token: string, timeoutMs?: number }) -> { render(req): Promise<{ pdf: Uint8Array; pageCount: number }> };
// req = the §5.1 JSON body verbatim ({template_id, template_version_config, variant, document, assets, watermark_override?}); errors are Errors with `.code`:
// 408 / 503 / 5xx / connection failure / client timeout -> 'reporting.render_unavailable' (retryable); 422 (page limit, template error) -> 'reporting.template_invalid'.
// Tested against a local stub server (wire shape + failure mapping); the real renderer round trip is render.client.integration.test.ts.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

const TOKEN = 'synthetic-renderer-token-0123456789abcdef';
const PDF = Buffer.from('%PDF-1.7 synthetic stub pdf');
const REQ = {
  template_id: 'lab-report', template_version_config: { signatoryMode: 'approvers' }, variant: 'letterhead' as const,
  document: { header: { patientName: 'Test Patient 0042' } }, assets: { ['a'.repeat(64)]: { mime_type: 'image/png', base64: 'aGk=' } },
};
type Seen = { method?: string; url?: string; headers: http.IncomingHttpHeaders; body: string };
const servers: http.Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => new Promise((r) => { s.closeAllConnections?.(); s.close(() => r(null)); }))); });
async function stub(reply: (req: http.IncomingMessage, res: http.ServerResponse, seen: Seen) => void | Promise<void>) {
  const seen: Seen[] = [];
  const s = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
    const rec = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') }; seen.push(rec); await reply(req, res, rec);
  });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r)); servers.push(s);
  return { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, seen };
}
const ok = (_q: http.IncomingMessage, res: http.ServerResponse) => { res.writeHead(200, { 'content-type': 'application/pdf', 'x-page-count': '3', 'x-render-ms': '12' }); res.end(PDF); };
const client = async (url: string, o: { token?: string; timeoutMs?: number } = {}) => ((await import('../renderer-client/render.client.js')) as any).createRenderClient({ url, token: o.token ?? TOKEN, ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}) });
const fails = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e) { return e; } throw new Error('expected rejection, got success'); };

describe('wire shape', () => {
  it('POST /internal/render with Bearer token and the request as JSON; returns the PDF bytes and X-Page-Count', async () => {
    const { url, seen } = await stub(ok); const c = await client(url); const r = await c.render(REQ);
    expect(seen).toHaveLength(1); expect(seen[0]).toMatchObject({ method: 'POST', url: '/internal/render' });
    expect(seen[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`); expect(String(seen[0]!.headers['content-type'])).toContain('application/json');
    expect(JSON.parse(seen[0]!.body)).toEqual(REQ);
    expect(Buffer.from(r.pdf).equals(PDF)).toBe(true); expect(r.pageCount).toBe(3);
  });
  it('a trailing slash in the base url is tolerated', async () => {
    const { url, seen } = await stub(ok); const c = await client(`${url}/`); await c.render(REQ); expect(seen[0]!.url).toBe('/internal/render');
  });
  it('watermark_override is forwarded when given and absent otherwise', async () => {
    const { url, seen } = await stub(ok); const c = await client(url);
    await c.render(REQ); await c.render({ ...REQ, watermark_override: 'NOT RELEASED' });
    expect(JSON.parse(seen[0]!.body).watermark_override).toBeUndefined(); expect(JSON.parse(seen[1]!.body).watermark_override).toBe('NOT RELEASED');
  });
  it('an empty token is refused at construction (never sends an unauthenticated call)', async () => {
    const mod: any = await import('../renderer-client/render.client.js'); expect(() => mod.createRenderClient({ url: 'http://127.0.0.1:1', token: '' })).toThrow();
  });
});

describe('failure mapping (AC-03.9: timeout / crash / saturation are retryable; 422 is permanent)', () => {
  it.each([[408], [503], [500], [502]])('HTTP %i -> reporting.render_unavailable', async (status) => {
    const { url } = await stub((_q, res) => { res.writeHead(status).end('boom'); }); const e = await fails((await client(url)).render(REQ)); expect(e.code).toBe('reporting.render_unavailable');
  });
  it('HTTP 422 (page limit / template error) -> reporting.template_invalid', async () => {
    const { url } = await stub((_q, res) => { res.writeHead(422).end(); }); const e = await fails((await client(url)).render(REQ)); expect(e.code).toBe('reporting.template_invalid');
  });
  it('connection refused -> reporting.render_unavailable', async () => {
    const { url } = await stub(ok); await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(() => r(null)))));
    const e = await fails((await client(url)).render(REQ)); expect(e.code).toBe('reporting.render_unavailable');
  });
  it('no answer within timeoutMs -> reporting.render_unavailable, promptly', async () => {
    const { url } = await stub(() => new Promise(() => undefined)); const t0 = Date.now();
    const e = await fails((await client(url, { timeoutMs: 200 })).render(REQ)); expect(e.code).toBe('reporting.render_unavailable'); expect(Date.now() - t0).toBeLessThan(5000);
  });
  it('connection dropped mid-body -> reporting.render_unavailable', async () => {
    const { url } = await stub((_q, res) => { res.writeHead(200, { 'content-type': 'application/pdf', 'x-page-count': '1', 'content-length': '1000' }); res.write('%PDF'); res.destroy(); });
    const e = await fails((await client(url)).render(REQ)); expect(e.code).toBe('reporting.render_unavailable');
  });
  it('the bearer token never appears in a thrown error (message, code, cause)', async () => {
    for (const reply of [(_q: any, res: http.ServerResponse) => { res.writeHead(503).end(); }, (_q: any, res: http.ServerResponse) => { res.writeHead(422).end(); }]) {
      const { url } = await stub(reply); const e = await fails((await client(url)).render(REQ));
      expect(JSON.stringify({ m: e.message, c: e.code, cause: String(e.cause ?? ''), s: e.stack })).not.toContain(TOKEN);
    }
  });
  it('the error never carries the document (patient name) or the response body', async () => {
    const { url } = await stub((_q, res) => { res.writeHead(503).end('SENTINEL-RESPONSE-BODY'); }); const e = await fails((await client(url)).render(REQ));
    expect(JSON.stringify({ m: e.message, s: e.stack })).not.toContain('Test Patient 0042'); expect(e.message).not.toContain('SENTINEL-RESPONSE-BODY');
  });
});
