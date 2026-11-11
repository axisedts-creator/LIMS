// C6-T16 — renderer HTTP path used by prints (02-TRD §5.1 request shape; 01-PRD AC-12.2 plain from the frozen snapshot, AC-13.1 preview with synthetic data).
// POST /internal/render must serve the REPORT shapes through the server: template_id 'lab-report' (variant letterhead|plain, optional watermark_override) and 'template-preview'
// (template_version_config + variant, NO document: the renderer renders its own synthetic sample, templates/preview-sample.ts). ASSUMED: the server is started with the real registry.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPool } from '../pool.js';
import { startServer } from '../server.js';
import { loadRegistry } from '../templates/registry.js';
import { makeConfig, makeDoc } from '../templates/__tests__/fixtures.js';
import { norm, pdfPages } from './helpers/pdf-text.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
const TOKEN = 'synthetic-renderer-token-0123456789abcdef';
let pool: Awaited<ReturnType<typeof createPool>>; let srv: Awaited<ReturnType<typeof startServer>>;
beforeAll(async () => {
  pool = await createPool({ contexts: 2 });
  srv = await startServer({ pool, token: TOKEN, port: 0, host: '127.0.0.1', registry: await loadRegistry() });
});
afterAll(async () => { await srv?.close(); await pool?.close(); });
const post = (body: unknown) => fetch(`${srv.url}/internal/render`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const pdfOf = async (r: Response) => new Uint8Array(await r.arrayBuffer());

describe('lab-report through the server (plain print of a frozen snapshot)', () => {
  const body = (over: Record<string, unknown> = {}) => ({ template_id: 'lab-report', template_version_config: makeConfig(), variant: 'plain', document: makeDoc(), assets: {}, ...over });
  it.each(['letterhead', 'plain'])('variant %s -> 200 application/pdf with X-Page-Count and the patient block', async (variant) => {
    const r = await post(body({ variant })); expect(r.status).toBe(200); expect(r.headers.get('content-type')).toBe('application/pdf'); expect(Number(r.headers.get('x-page-count'))).toBeGreaterThanOrEqual(1);
    const pdf = await pdfOf(r); expect(Buffer.from(pdf.slice(0, 5)).toString()).toBe('%PDF-'); expect(norm(pdfPages(pdf)[0]!)).toContain('Reg No');
  });
  it('plain and letterhead of the same snapshot + config have the same page count and the same text (only letterhead images differ)', async () => {
    const a = await post(body({ variant: 'letterhead' })); const b = await post(body({ variant: 'plain' }));
    expect(b.headers.get('x-page-count')).toBe(a.headers.get('x-page-count')); expect(pdfPages(await pdfOf(b)).map(norm)).toEqual(pdfPages(await pdfOf(a)).map(norm));
  });
  it('a draft print request (watermark_override NOT RELEASED) is accepted', async () => {
    expect((await post(body({ watermark_override: 'NOT RELEASED' }))).status).toBe(200);
  });
  it.each([['sepia'], [''], [undefined]])('unknown variant %j -> 400, never 500', async (variant) => {
    const r = await post(body({ variant })); expect(r.status).toBe(400);
  });
  it('a malformed document -> 4xx (422 template error / 400 bad bundle), never 500', async () => {
    const r = await post(body({ document: { schemaVersion: 1 } })); expect([400, 422]).toContain(r.status);
  });
});

describe('template-preview through the server (AC-13.1)', () => {
  it.each(['letterhead', 'plain'])('variant %s, config only, no document -> 200 PDF of the synthetic sample', async (variant) => {
    const r = await post({ template_id: 'template-preview', template_version_config: makeConfig({ watermark: { text: 'PREVIEWMARK', opacity: 0.1 } }), variant, assets: {} });
    expect(r.status).toBe(200); const pdf = await pdfOf(r); expect(Buffer.from(pdf.slice(0, 5)).toString()).toBe('%PDF-');
    const text = pdfPages(pdf).map(norm).join('\n'); expect(text).toContain('Reg No'); expect(text).toContain('PREVIEWMARK'); expect(text).not.toMatch(/\b9[78]\d{8}\b/);
  });
  it('the preview applies the posted draft config (changing the watermark changes the output)', async () => {
    const mk = async (t: string) => pdfPages(await pdfOf(await post({ template_id: 'template-preview', template_version_config: makeConfig({ watermark: { text: t, opacity: 0.1 } }), variant: 'plain' }))).map(norm).join('\n');
    expect(await mk('WMKONE')).toContain('WMKONE'); expect(await mk('WMKTWO')).not.toContain('WMKONE');
  });
  it('a preview request that smuggles a document does not render it (synthetic data only)', async () => {
    const real = makeDoc(); const hdr = (real as any).header;
    const r = await post({ template_id: 'template-preview', template_version_config: makeConfig(), variant: 'plain', document: real });
    if (r.status === 200) { const text = pdfPages(await pdfOf(r)).map(norm).join('\n'); expect(text).not.toContain(norm(String(hdr.patientName))); } else { expect([400, 422]).toContain(r.status); }
  });
  it('unknown template ids are still 400', async () => {
    expect((await post({ template_id: 'template-nope', variant: 'plain' })).status).toBe(400);
  });
});
