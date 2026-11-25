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
import { startServer as startRenderer } from '../server.js';
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
const env = (over: Record<string, string> = {}) => ({
  LIMS_REPORTING_RENDERER_URL: renderer.url, LIMS_REPORTING_RENDERER_TOKEN_FILE: join(dir, 'renderer'),
  LIMS_REPORTING_SANDBOX_URL: sandbox.url, LIMS_REPORTING_SANDBOX_TOKEN_FILE: join(dir, 'sandbox'), ...over,
});

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'c6-e2e-'));
  writeFileSync(join(dir, 'renderer'), `${RENDER_TOKEN}\n`);
  writeFileSync(join(dir, 'sandbox'), `${SANDBOX_TOKEN}\n`);
  writeFileSync(join(dir, 'wrong'), 'not-the-token-0123456789abcdef0123456789\n');
  pool = await createPool({ contexts: 2 });
  renderer = await startRenderer({ pool, token: RENDER_TOKEN, port: 0, host: '127.0.0.1', registry: await loadRegistry() });
  sandbox = await startSandbox({ token: SANDBOX_TOKEN, workDir: join(dir, 'work') });
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

  it('a wrong token is refused by both services (401): coded failure, the token never in the error', async () => {
    const c = createReportingClients(env({ LIMS_REPORTING_RENDERER_TOKEN_FILE: join(dir, 'wrong'), LIMS_REPORTING_SANDBOX_TOKEN_FILE: join(dir, 'wrong') }));
    const r = await c.renderer.render(renderReq()).then(() => undefined, (x: Error & { code?: string }) => x);
    expect(r?.code).toBe('reporting.render_unavailable');
    expect(`${r?.message}${r?.stack}`).not.toContain('not-the-token');
    await expect(c.assembler.assemble({ parts: [], stamp: STAMP })).rejects.toMatchObject({ code: 'reporting.render_unavailable' });
    await expect(c.sandbox.sanitize(new Uint8Array([1]))).rejects.toThrow('pdf sandbox answered 401');
  });
});
