// Worker renderer / PDF sandbox clients (../clients.ts) against a local fake of the two services. Synthetic data only.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createReportingClients } from '../clients.js';

const TOKEN = 'synthetic-worker-client-token-0123456789';
const PDF = Buffer.from('%PDF-1.7 synthetic');
type Seen = { url: string; auth: string; type: string; body: Buffer };

let server: http.Server; let url: string; let dir: string; let tokenFile: string;
let seen: Seen[] = [];
let reply: (req: Seen, res: http.ServerResponse) => void;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'c6-clients-'));
  tokenFile = join(dir, 'token');
  writeFileSync(tokenFile, `${TOKEN}\n`);
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const s = { url: req.url ?? '', auth: req.headers.authorization ?? '', type: req.headers['content-type'] ?? '', body: Buffer.concat(chunks) };
      seen.push(s);
      reply(s, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => { seen = []; reply = (_s, res) => void res.writeHead(500).end(); });

const wired = () => createReportingClients({
  LIMS_REPORTING_RENDERER_URL: `${url}/`, LIMS_REPORTING_RENDERER_TOKEN_FILE: tokenFile,
  LIMS_REPORTING_SANDBOX_URL: `${url}/`, LIMS_REPORTING_SANDBOX_TOKEN_FILE: tokenFile,
});
const rejection = async (p: Promise<unknown>): Promise<Error & { code?: string }> => { try { await p; } catch (e) { return e as Error; } throw new Error('did not reject'); };
const pdfReply = (pages: string) => (_s: Seen, res: http.ServerResponse) => void res.writeHead(200, { 'content-type': 'application/pdf', 'x-page-count': pages }).end(PDF);
const renderReq = { template_id: 'lab-report', variant: 'letterhead', template_version_config: {}, document: {}, assets: {} };
const assembleReq = { parts: [], stamp: {} };

describe('wired: calls reach the services with the bearer token from the file', () => {
  it('renderer.render posts to /internal/render and returns the pdf + page count', async () => {
    reply = pdfReply('3');
    const out = await wired().renderer.render(renderReq);
    expect(Buffer.from(out.pdf).equals(PDF)).toBe(true);
    expect(out.pageCount).toBe(3);
    expect(seen[0]).toMatchObject({ url: '/internal/render', auth: `Bearer ${TOKEN}` });   // trailing newline of the file stripped
  });

  it('sandbox.sanitize posts the bytes as multipart `file` and returns the JSON answer (200 and 422)', async () => {
    reply = (_s, res) => void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, page_count: 1, sha256: 'x', pdf_base64: 'eA==' }));
    expect(await wired().sandbox.sanitize(new Uint8Array(PDF))).toEqual({ ok: true, page_count: 1, sha256: 'x', pdf_base64: 'eA==' });
    expect(seen[0]).toMatchObject({ url: '/internal/sanitize', auth: `Bearer ${TOKEN}` });
    expect(seen[0]!.type).toMatch(/^multipart\/form-data; boundary=/);
    expect(seen[0]!.body.includes(PDF)).toBe(true);
    expect(seen[0]!.body.toString('latin1')).toContain('name="file"');

    reply = (_s, res) => void res.writeHead(422, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, reason: 'encrypted' }));
    expect(await wired().sandbox.sanitize(new Uint8Array(PDF))).toEqual({ ok: false, reason: 'encrypted' });
  });

  it('assembler.assemble posts JSON to /internal/assemble and returns the pdf + page count', async () => {
    reply = pdfReply('7');
    const out = await wired().assembler.assemble(assembleReq);
    expect(out.pageCount).toBe(7);
    expect(seen[0]).toMatchObject({ url: '/internal/assemble', auth: `Bearer ${TOKEN}`, type: 'application/json' });
    expect(JSON.parse(seen[0]!.body.toString('utf8'))).toEqual(assembleReq);
  });
});

describe('failures are retryable, coded, and leak nothing', () => {
  const clean = (e: Error) => { for (const s of [TOKEN, tokenFile, url]) expect(`${e.message}${e.stack}${String((e as { cause?: unknown }).cause ?? '')}`).not.toContain(s); };

  it('service answers 500', async () => {
    const c = wired();
    const r = await rejection(c.renderer.render(renderReq)); expect(r.code).toBe('reporting.render_unavailable'); clean(r);
    const a = await rejection(c.assembler.assemble(assembleReq)); expect(a.code).toBe('reporting.render_unavailable'); clean(a);
    const s = await rejection(c.sandbox.sanitize(new Uint8Array(PDF))); expect(s.message).toBe('pdf sandbox answered 500'); clean(s);
  });

  it('assemble: 422, a bad x-page-count or an empty body is render_unavailable', async () => {
    reply = (_s, res) => void res.writeHead(422).end('{}');
    expect((await rejection(wired().assembler.assemble(assembleReq))).code).toBe('reporting.render_unavailable');
    reply = pdfReply('0');
    expect((await rejection(wired().assembler.assemble(assembleReq))).code).toBe('reporting.render_unavailable');
    reply = (_s, res) => void res.writeHead(200, { 'x-page-count': '1' }).end();
    expect((await rejection(wired().assembler.assemble(assembleReq))).code).toBe('reporting.render_unavailable');
  });

  it('service unreachable', async () => {
    const c = createReportingClients({ LIMS_REPORTING_RENDERER_URL: 'http://127.0.0.1:1', LIMS_REPORTING_RENDERER_TOKEN_FILE: tokenFile,
      LIMS_REPORTING_SANDBOX_URL: 'http://127.0.0.1:1', LIMS_REPORTING_SANDBOX_TOKEN_FILE: tokenFile });
    expect((await rejection(c.renderer.render(renderReq))).code).toBe('reporting.render_unavailable');
    expect((await rejection(c.assembler.assemble(assembleReq))).code).toBe('reporting.render_unavailable');
    const s = await rejection(c.sandbox.sanitize(new Uint8Array(PDF))); expect(s.message).toBe('pdf_sandbox_unreachable'); expect(s.cause).toBeUndefined();
  });

  it.each([
    ['nothing set', {}],
    ['url only', { LIMS_REPORTING_RENDERER_URL: 'http://renderer.invalid', LIMS_REPORTING_SANDBOX_URL: 'http://sandbox.invalid' }],
    ['unreadable token file', { LIMS_REPORTING_RENDERER_URL: 'http://renderer.invalid', LIMS_REPORTING_RENDERER_TOKEN_FILE: join(tmpdir(), 'c6-clients-missing'),
      LIMS_REPORTING_SANDBOX_URL: 'http://sandbox.invalid', LIMS_REPORTING_SANDBOX_TOKEN_FILE: join(tmpdir(), 'c6-clients-missing') }],
    ['url not http(s)', { LIMS_REPORTING_RENDERER_URL: 'file:///etc/passwd', LIMS_REPORTING_RENDERER_TOKEN_FILE: 'x', LIMS_REPORTING_SANDBOX_URL: 'file:///etc/passwd', LIMS_REPORTING_SANDBOX_TOKEN_FILE: 'x' }],
  ])('not configured (%s): same failures as before wiring, no request sent', async (_n, env) => {
    const c = createReportingClients(env);
    const r = await rejection(c.renderer.render(renderReq));
    expect(r.code).toBe('reporting.render_unavailable'); expect(r.message).toBe('renderer_not_configured');
    const a = await rejection(c.assembler.assemble(assembleReq));
    expect(a.code).toBe('reporting.render_unavailable'); expect(a.message).toBe('pdf_sandbox_not_configured');
    const s = await rejection(c.sandbox.sanitize(new Uint8Array(PDF)));
    expect(s.message).toBe('pdf_sandbox_not_configured'); expect(s.code).toBeUndefined();
    expect(seen).toHaveLength(0);
  });

  it('an empty token file is not configured', async () => {
    const empty = join(dir, 'empty'); writeFileSync(empty, '\n');
    const c = createReportingClients({ LIMS_REPORTING_SANDBOX_URL: url, LIMS_REPORTING_SANDBOX_TOKEN_FILE: empty });
    expect((await rejection(c.assembler.assemble(assembleReq))).message).toBe('pdf_sandbox_not_configured');
    expect(seen).toHaveLength(0);
  });
});
