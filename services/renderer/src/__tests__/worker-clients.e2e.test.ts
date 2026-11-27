// End to end: the WORKER's clients (services/worker/src/jobs/reporting/clients.ts) against the REAL renderer server (Chromium pool)
// and the REAL PDF sandbox server (qpdf). Same call order as the render_report_version task: render -> assemble; sanitize as process_input_file.
// Needs Chromium (playwright) and qpdf on PATH, like the other tests of this package. Synthetic data only.
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createReportingClients } from '../../../worker/src/jobs/reporting/clients.js';
import { checkReply } from '../../../worker/src/jobs/reporting/tasks/process_input_file.js';
import { STAMP } from '../../../worker/src/jobs/reporting/tasks/render_report_version.js';
import { createPool } from '../pool.js';
import { startServer as startSandbox } from '../sandbox/server.js';
import { startFromEnv, startServer as startRenderer } from '../server.js';
import { makeConfig, makeDoc } from '../templates/__tests__/fixtures.js';
import { loadRegistry } from '../templates/registry.js';
import { norm, pdfPages } from './helpers/pdf-text.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
const RENDER_TOKEN = 'synthetic-renderer-token-0123456789abcdef';
const SANDBOX_TOKEN = 'synthetic-sandbox-token-0123456789abcdef';
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

let pool: Awaited<ReturnType<typeof createPool>>;
let renderer: Awaited<ReturnType<typeof startRenderer>>;
let sandbox: Awaited<ReturnType<typeof startSandbox>>;
let dir: string;
let clients: ReturnType<typeof createReportingClients>;
// Container mode: with LIMS_E2E_RENDERER_URL / LIMS_E2E_SANDBOX_URL / LIMS_E2E_RENDERER_TOKEN_FILE / LIMS_E2E_SANDBOX_TOKEN_FILE set, the same
// cases run against already running services (the images of Dockerfile.renderer / Dockerfile.sandbox) and nothing is started in-process.
const EXT = process.env['LIMS_E2E_RENDERER_URL'] && process.env['LIMS_E2E_SANDBOX_URL'] && process.env['LIMS_E2E_RENDERER_TOKEN_FILE'] && process.env['LIMS_E2E_SANDBOX_TOKEN_FILE']
  ? { rendererUrl: process.env['LIMS_E2E_RENDERER_URL']!, sandboxUrl: process.env['LIMS_E2E_SANDBOX_URL']!, rendererTokenFile: process.env['LIMS_E2E_RENDERER_TOKEN_FILE']!, sandboxTokenFile: process.env['LIMS_E2E_SANDBOX_TOKEN_FILE']! }
  : undefined;
const env = (over: Record<string, string> = {}) => ({
  LIMS_REPORTING_RENDERER_URL: EXT?.rendererUrl ?? renderer.url, LIMS_REPORTING_RENDERER_TOKEN_FILE: EXT?.rendererTokenFile ?? join(dir, 'renderer'),
  LIMS_REPORTING_SANDBOX_URL: EXT?.sandboxUrl ?? sandbox.url, LIMS_REPORTING_SANDBOX_TOKEN_FILE: EXT?.sandboxTokenFile ?? join(dir, 'sandbox'), ...over,
});

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'c6-e2e-'));
  writeFileSync(join(dir, 'renderer'), `${RENDER_TOKEN}\n`);
  writeFileSync(join(dir, 'sandbox'), `${SANDBOX_TOKEN}\n`);
  writeFileSync(join(dir, 'wrong'), 'not-the-token-0123456789abcdef0123456789\n');
  if (!EXT) {
    pool = await createPool({ contexts: 2 });
    renderer = await startRenderer({ pool, token: RENDER_TOKEN, port: 0, host: '127.0.0.1', registry: await loadRegistry() });
    sandbox = await startSandbox({ token: SANDBOX_TOKEN, workDir: join(dir, 'work') });
  }
  clients = createReportingClients(env());
});
afterAll(async () => {
  await renderer?.close(); await sandbox?.close(); await pool?.close();
  rmSync(dir, { recursive: true, force: true });
});

const renderReq = () => ({ template_id: 'lab-report', variant: 'letterhead', template_version_config: makeConfig(), document: makeDoc(), assets: {} });
const mainPart = (pdf: Uint8Array) => ({ kind: 'main', pdf_base64: Buffer.from(pdf).toString('base64'), sha256: sha(pdf) });

describe('worker clients against the real renderer and PDF sandbox', () => {
  it('render -> assemble: a stamped PDF with the report text and "Page n Of m" on every page', async () => {
    const main = await clients.renderer.render(renderReq());
    expect(Buffer.from(main.pdf.slice(0, 5)).toString()).toBe('%PDF-');
    expect(main.pageCount).toBeGreaterThanOrEqual(1);

    const merged = await clients.assembler.assemble({ parts: [mainPart(main.pdf)], stamp: STAMP });
    expect(merged.pageCount).toBe(main.pageCount);
    const pages = pdfPages(merged.pdf).map(norm);
    expect(pages).toHaveLength(merged.pageCount);
    expect(pages[0]).toContain('Reg No');
    pages.forEach((p, i) => expect(p).toContain(`Page ${i + 1} Of ${pages.length}`));
  });

  it('sanitize: a clean PDF comes back accepted by the task\'s own reply check; a non-PDF is refused with a reason', async () => {
    const main = await clients.renderer.render(renderReq());
    const clean = await clients.assembler.assemble({ parts: [mainPart(main.pdf)], stamp: STAMP });
    const ok = checkReply(await clients.sandbox.sanitize(clean.pdf));
    expect(ok).toHaveProperty('bytes');
    expect((ok as { pages: number }).pages).toBe(clean.pageCount);

    expect(checkReply(await clients.sandbox.sanitize(new TextEncoder().encode('<html>not a pdf</html>')))).toEqual({ reason: 'not_pdf' });
  });

  it('a part whose sha256 does not match its bytes is refused by the sandbox: render_unavailable, nothing returned', async () => {
    const main = await clients.renderer.render(renderReq());
    const bad = { ...mainPart(main.pdf), sha256: 'a'.repeat(64) };
    await expect(clients.assembler.assemble({ parts: [bad], stamp: STAMP })).rejects.toMatchObject({ code: 'reporting.render_unavailable' });
  });

  it('an unknown template is a permanent template_invalid or a retryable render_unavailable, never a PDF', async () => {
    const e = await clients.renderer.render({ ...renderReq(), template_id: 'no-such-template' }).then(() => undefined, (x: { code?: string }) => x);
    expect(['reporting.template_invalid', 'reporting.render_unavailable']).toContain(e?.code);
  });

  it('50 simultaneous renders (pool of 2 contexts): each is a correct PDF or a retryable render_unavailable, and the renderer still serves afterwards', async () => {
    const one = await clients.renderer.render(renderReq());
    const started = Date.now();
    const out = await Promise.all(Array.from({ length: 50 }, () => clients.renderer.render(renderReq()).then((r) => ({ ok: r }), (e: { code?: string }) => ({ err: e?.code }))));
    const ok = out.flatMap((o) => ('ok' in o ? [o.ok] : []));
    const errs = out.flatMap((o) => ('err' in o ? [o.err] : []));
    // A saturated pool answers 503 -> render_unavailable (the queue retries, 02-TRD §5.1). Nothing else is acceptable: no hang, no other code, no bad PDF.
    expect(new Set(errs).size === 0 || [...new Set(errs)].every((c) => c === 'reporting.render_unavailable')).toBe(true);
    expect(ok.length).toBeGreaterThan(0);
    for (const r of ok) {
      expect(Buffer.from(r.pdf.slice(0, 5)).toString()).toBe('%PDF-');
      expect(r.pageCount).toBe(one.pageCount);
    }
    console.log(`50 concurrent renders: ${ok.length} ok, ${errs.length} render_unavailable, ${Date.now() - started} ms`);
    expect((await clients.renderer.render(renderReq())).pageCount).toBe(one.pageCount);   // recovered
  });

  it('the process entry path (startFromEnv) serves the report templates: lab-report renders, it is not an unknown template', async () => {
    const srv = await startFromEnv({ LIMS_RENDERER_TOKEN_FILE: join(dir, 'renderer') }, { port: 0, host: '127.0.0.1' });
    try {
      const c = createReportingClients(env({ LIMS_REPORTING_RENDERER_URL: srv.url }));
      expect((await c.renderer.render(renderReq())).pageCount).toBeGreaterThanOrEqual(1);
    } finally { await srv.close(); await srv.pool.close(); }
  });

  it('a wrong token is refused by both services (401): coded failure, the token never in the error', async () => {
    const c = createReportingClients(env({ LIMS_REPORTING_RENDERER_TOKEN_FILE: join(dir, 'wrong'), LIMS_REPORTING_SANDBOX_TOKEN_FILE: join(dir, 'wrong') }));
    const r = await c.renderer.render(renderReq()).then(() => undefined, (x: Error & { code?: string }) => x);
    expect(r?.code).toBe('reporting.render_unavailable');
    expect(`${r?.message}${r?.stack}`).not.toContain('not-the-token');
    await expect(c.assembler.assemble({ parts: [], stamp: STAMP })).rejects.toMatchObject({ code: 'reporting.render_unavailable' });
    await expect(c.sandbox.sanitize(new Uint8Array([1]))).rejects.toThrow('pdf sandbox answered 401');
  });
});
