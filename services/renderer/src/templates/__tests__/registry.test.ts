// C6-T36 — renderer registry + second /internal/render request shape (02-TRD §5.1, §5.3, §7.4; review fix #13; 08 R12c). Real Chromium via createPool.
// ASSUMED API (spec names no signatures) — writer must match or raise a dispute:
//   ../registry.ts  exports  loadRegistry(o?: { templatesRoot?: string }): Promise<Registry>
//        templatesRoot defaults to <services/renderer>/templates (= ../../templates from src/templates); it may hold billing/index.ts (C4), analytics/index.ts (C8),
//        smart/index.ts (C14); every sub-directory is optional (absent => nothing from it, no throw). Each of billing/ and analytics/ exports `DataTemplateModule[]`
//        as named `templates` OR as default; smart/ exports `smartSectionRenderer` (C14 04-UI-UX §4.1).
//        Registry = { get(id: string): TemplateModule | DataTemplateModule | undefined; ids(): string[]; smart?: SmartSectionRenderer }
//        report ids ('lab-report', 'narrative-report') -> TemplateModule (.templateId); RenderTemplateKey values -> DataTemplateModule (.templateKey).
//   ../../server.ts  startServer({ pool, token, registry? }) — with `registry`, POST /internal/render picks the shape by template_id: report ids -> TemplateModule
//        (shape 1, unchanged), RenderTemplateKey values -> DataTemplateModule (shape 2 { template_id, data, assets }; module.render({data, assets, qr})).
//        Unknown template_id -> 400; a module that throws -> 422.
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPool } from '../../pool.js';
import { startServer } from '../../server.js';
import { loadRegistry } from '../registry.js';
import { norm, pdfText } from '../../__tests__/helpers/pdf-text.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
const root = (n: string) => fileURLToPath(new URL(`./fixture-roots/${n}`, import.meta.url));
const TOKEN = 'synthetic-renderer-token-0123456789abcdef';

describe('registry loads templates/billing/** (C4), templates/analytics/** (C8), templates/smart (C14) when present', () => {
  it('full root: the four RenderPort keys resolve to DataTemplateModules; report templates still resolve', async () => {
    const reg = await loadRegistry({ templatesRoot: root('full') });
    for (const k of ['billing.invoice', 'billing.credit_note', 'billing.register', 'analytics.report'])
      expect((reg.get(k) as any)?.templateKey, k).toBe(k);
    expect((reg.get('lab-report') as any)?.templateId).toBe('lab-report');
    expect((reg.get('narrative-report') as any)?.templateId).toBe('narrative-report');
    expect(reg.ids()).toEqual(expect.arrayContaining(['billing.invoice', 'billing.credit_note', 'billing.register', 'analytics.report', 'lab-report', 'narrative-report']));
    expect(reg.smart?.libraryVersion).toBe('smart-section-fixture');
  });
  it('empty root: loads without throwing; no billing/analytics keys; smart undefined; report templates still there', async () => {
    const reg = await loadRegistry({ templatesRoot: root('empty') });
    for (const k of ['billing.invoice', 'billing.credit_note', 'billing.register', 'analytics.report']) expect(reg.get(k), k).toBeUndefined();
    expect(reg.smart).toBeUndefined();
    expect((reg.get('lab-report') as any)?.templateId).toBe('lab-report');
  });
  it('unknown id → undefined (not a prototype member)', async () => {
    const reg = await loadRegistry({ templatesRoot: root('full') });
    for (const id of ['nope', 'billing.nope', '__proto__', 'constructor', 'toString']) expect(reg.get(id), id).toBeUndefined();
  });
});

describe('POST /internal/render — second request shape { template_id, data, assets } (done_when: C4/C8 fixtures render)', () => {
  let pool: Awaited<ReturnType<typeof createPool>>;
  let srv: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => {
    pool = await createPool({ contexts: 2 });
    srv = await startServer({ pool, token: TOKEN, port: 0, host: '127.0.0.1', registry: await loadRegistry({ templatesRoot: root('full') }) } as any);
  });
  afterAll(async () => { await srv?.close(); await pool?.close(); });
  const post = (body: unknown) => fetch(srv.url + '/internal/render', { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('billing.invoice (C4 fixture) → 200 application/pdf containing the data', async () => {
    const res = await post({ template_id: 'billing.invoice', data: { invoiceNo: 'SYN-INV-0001', patientDisplayName: 'Test Patient 0042', totalText: 'NPR 1,500.00' }, assets: {} });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/pdf');
    expect(Number(res.headers.get('x-page-count'))).toBeGreaterThanOrEqual(1);
    const text = norm(pdfText(new Uint8Array(await res.arrayBuffer())));
    expect(text).toContain('FIXTURE-INVOICE'); expect(text).toContain('SYN-INV-0001'); expect(text).toContain('Test Patient 0042'); expect(text).toContain('NPR 1,500.00');
  });
  it('billing.credit_note and analytics.report (C8 fixture) render too', async () => {
    const a = await post({ template_id: 'billing.credit_note', data: { creditNoteNo: 'SYN-CN-7' }, assets: {} });
    expect(a.status).toBe(200); expect(norm(pdfText(new Uint8Array(await a.arrayBuffer())))).toContain('SYN-CN-7');
    const b = await post({ template_id: 'analytics.report', data: { reportTitle: 'Synthetic MIS', rows: [{ c1: 1 }, { c1: 2 }] }, assets: {} });
    expect(b.status).toBe(200); const t = norm(pdfText(new Uint8Array(await b.arrayBuffer())));
    expect(t).toContain('FIXTURE-ANALYTICS Synthetic MIS'); expect(t).toContain('2 rows');
  });
  it('same request twice → same text and page count (determinism behind contract case 4)', async () => {
    const body = { template_id: 'billing.credit_note', data: { creditNoteNo: 'SYN-CN-9' }, assets: {} };
    const [x, y] = await Promise.all([post(body), post(body)]);
    const [bx, by] = [Buffer.from(await x.arrayBuffer()), Buffer.from(await y.arrayBuffer())];
    // text + page count only; byte-level sha256 determinism is asserted in the next test
    expect(norm(pdfText(bx))).toBe(norm(pdfText(by)));
    expect(x.headers.get('x-page-count')).toBe(y.headers.get('x-page-count'));
  });
  it('same shape-2 body twice ≥1.1 s apart → identical sha256 of response bytes (contract case 4; 02-TRD §7.4 deterministic rendering)', async () => {
    const body = { template_id: 'billing.credit_note', data: { creditNoteNo: 'SYN-CN-11' }, assets: {} };
    const x = await post(body);
    await new Promise((r) => setTimeout(r, 1_100));
    const y = await post(body);
    expect(x.status).toBe(200); expect(y.status).toBe(200);
    const sha = async (r: Response) => createHash('sha256').update(Buffer.from(await r.arrayBuffer())).digest('hex');
    expect(await sha(x)).toBe(await sha(y));
  });
  it('data templates get the same guard as report templates: script not run, external requests blocked (REQ-SEC-086)', async () => {
    const before = pool.stats().blockedRequests;
    const res = await post({ template_id: 'billing.register', data: { title: 'Synthetic' }, assets: {} });
    expect(res.status).toBe(200);
    const text = norm(pdfText(new Uint8Array(await res.arrayBuffer())));
    expect(text).toContain('FIXTURE-REGISTER Synthetic');
    expect(text).not.toContain('SCRIPT-RAN');
    expect(pool.stats().blockedRequests - before).toBeGreaterThanOrEqual(2);
  });
  it('unknown / unregistered template_id → 400', async () => {
    for (const id of ['billing.nope', 'partners.nope', 'constructor']) expect((await post({ template_id: id, data: {}, assets: {} })).status, id).toBe(400);
  });
  it('a data-template request without `data` → 400 (bad bundle, not a 500)', async () => {
    expect((await post({ template_id: 'billing.invoice', assets: {} })).status).toBe(400);
  });
  it('no token → 401 on the second shape too', async () => {
    const res = await fetch(srv.url + '/internal/render', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ template_id: 'billing.invoice', data: {}, assets: {} }) });
    expect(res.status).toBe(401);
  });
});
