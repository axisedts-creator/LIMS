// C6-T36 — RenderPort (03-IC §4.16, 08 R12c) REAL implementation. AC-17.1, AC-17.2; 07-SECURITY §"RenderPort" (4b); 02-TRD §7.4.
// The C0 contract suite (cases 1-5 + P-40) is reused unchanged against the real impl; only the harness is ours (render.helpers.ts: a real HTTP stand-in for the renderer).
import { afterAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runRenderPortContract } from '../../../../../../packages/fakes/contract-tests/RenderPort.contract.js';
import { INVOICE, SLIP, TOKEN, analytics, makeRenderWorld, rejection, sha256hex, touched } from './render.helpers.js';

vi.setConfig({ testTimeout: 30_000 });
const worlds: Awaited<ReturnType<typeof makeRenderWorld>>[] = [];
const world = async (o: { timeoutMs?: number } = {}) => { const w = await makeRenderWorld(o); worlds.push(w); return w; };
afterAll(async () => { await Promise.all(worlds.map((w) => w.stub.close())); });

// ------------------------------------------------------------------------------------------------ contract cases (1)-(5) + P-40
runRenderPortContract(async () => (await world()).harness);

describe('AC-17.1 — system actor + schema-valid data → PDF bytes returned, nothing stored', () => {
  it('billing.invoice: returns base64 PDF with sha256/byteSize/pageCount; posts the SECOND /internal/render shape with the bearer token', async () => {
    const w = await world();
    const ctx = w.harness.ctxFor('A:system');
    const out = await w.port.renderPdf(ctx, { templateKey: 'billing.invoice', data: INVOICE, idempotencyKey: 'inv-1' });
    const bytes = Buffer.from(out.contentBase64, 'base64');
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
    expect(out.byteSize).toBe(bytes.length);
    expect(out.sha256).toBe(sha256hex(bytes));
    expect(out.pageCount).toBe(2);   // = renderer's X-Page-Count
    expect(w.stub.seen).toHaveLength(1);
    const r = w.stub.seen[0]!;
    expect(r.method).toBe('POST'); expect(r.url).toBe('/internal/render'); expect(r.authorization).toBe(`Bearer ${TOKEN}`);
    expect(Object.keys(r.body).sort()).toEqual(['assets', 'data', 'template_id']);   // no document / variant / config (02-TRD §5.1)
    expect(r.body.template_id).toBe('billing.invoice');
    expect(r.body.data).toEqual(INVOICE);
    expect(touched).toEqual([]);   // ctx.db / ctx.storage tripwires never fired: C6 stores nothing (08 R12c)
  });
  it.each(['billing.invoice', 'billing.credit_note', 'billing.register', 'analytics.report'] as const)('%s renders for a system actor', async (templateKey) => {
    const w = await world();
    const data = { 'billing.invoice': INVOICE, 'billing.credit_note': { creditNoteNo: 'SYN-CN-1', totalText: 'NPR 10.00' }, 'billing.register': { title: 'Synthetic register' }, 'analytics.report': analytics(3) }[templateKey];
    const out = await w.port.renderPdf(w.harness.ctxFor('A:system'), { templateKey, data, idempotencyKey: `k-${templateKey}` });
    expect(out.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(w.stub.seen[0]!.body.template_id).toBe(templateKey);
  });
  it('different data → different sha256 (the digest is of the returned bytes)', async () => {
    const w = await world();
    const a = await w.port.renderPdf(w.harness.ctxFor('A:system'), { templateKey: 'billing.invoice', data: INVOICE, idempotencyKey: 'd-1' });
    const b = await w.port.renderPdf(w.harness.ctxFor('A:system'), { templateKey: 'billing.invoice', data: { ...INVOICE, totalText: 'NPR 1,501.00' }, idempotencyKey: 'd-2' });
    expect(b.sha256).not.toBe(a.sha256);
  });
});

describe('AC-17.2 / 07-SECURITY 4b — only system actors; invalid data never reaches the renderer', () => {
  it.each(['user', 'device', 'portal', 'patient', 'partner'])('%s actor → auth.forbidden, renderer not called', async (type) => {
    const w = await world();
    const e = await rejection(w.port.renderPdf(w.harness.ctxFor(`A:${type}`), { templateKey: 'billing.invoice', data: INVOICE, idempotencyKey: 'f-1' }));
    expect(e.code).toBe('auth.forbidden');
    expect(w.stub.seen).toHaveLength(0);
  });
  it('forbidden is decided before the schema: a user actor with invalid data still gets auth.forbidden (no schema oracle)', async () => {
    const w = await world();
    const e = await rejection(w.port.renderPdf(w.harness.ctxFor('A:user'), { templateKey: 'billing.invoice', data: {}, idempotencyKey: 'f-2' }));
    expect(e.code).toBe('auth.forbidden');
  });
  it.each([
    ['missing required field', { invoiceNo: 'X', patientDisplayName: 'Y' }],
    ['extra property (additionalProperties:false)', { ...INVOICE, results: 'Hb 9.1' }],
    ['wrong type', { ...INVOICE, totalText: 15 }],
    ['not an object', [INVOICE]],
  ])('billing.invoice %s → reporting.template_invalid, renderer not called', async (_n, data) => {
    const w = await world();
    const e = await rejection(w.port.renderPdf(w.harness.ctxFor('A:system'), { templateKey: 'billing.invoice', data: data as any, idempotencyKey: 'v-1' }));
    expect(e.code).toBe('reporting.template_invalid');
    expect(w.stub.seen).toHaveLength(0);
  });
  it('unknown template key → common.validation_failed, renderer not called', async () => {
    const w = await world();
    const e = await rejection(w.port.renderPdf(w.harness.ctxFor('A:system'), { templateKey: 'lab-report' as any, data: {}, idempotencyKey: 'u-1' }));
    expect(e.code).toBe('common.validation_failed');
    expect(w.stub.seen).toHaveLength(0);
  });
  it('analytics.report: 5,000 rows pass, 5,001 → reporting.template_invalid (IC §4.16 cap enforced by the impl)', async () => {
    const w = await world();
    await w.port.renderPdf(w.harness.ctxFor('A:system'), { templateKey: 'analytics.report', data: analytics(5000), idempotencyKey: 'a-1' });
    const e = await rejection(w.port.renderPdf(w.harness.ctxFor('A:system'), { templateKey: 'analytics.report', data: analytics(5001), idempotencyKey: 'a-2' }));
    expect(e.code).toBe('reporting.template_invalid');
    expect(w.stub.seen).toHaveLength(1);
  });
});

describe('renderer failures (02-TRD §7.4; ASSUMED mapping = render.client.ts: 422 → template_invalid, everything else → render_unavailable)', () => {
  it.each([[408], [500], [503], [401]])('renderer answers %i → reporting.render_unavailable', async (status) => {
    const w = await world(); w.stub.setMode({ status });
    const e = await rejection(w.port.renderPdf(w.harness.ctxFor('A:system'), { templateKey: 'billing.invoice', data: INVOICE, idempotencyKey: 'r-1' }));
    expect(e.code).toBe('reporting.render_unavailable');
  });
  it('renderer answers 422 (template error / page limit) → reporting.template_invalid', async () => {
    const w = await world(); w.stub.setMode({ status: 422 });
    const e = await rejection(w.port.renderPdf(w.harness.ctxFor('A:system'), { templateKey: 'billing.invoice', data: INVOICE, idempotencyKey: 'r-2' }));
    expect(e.code).toBe('reporting.template_invalid');
  });
  it('renderer never answers → the impl times out (timeoutMs option) → reporting.render_unavailable', async () => {
    const w = await world({ timeoutMs: 300 }); w.stub.setMode('hang');
    const t0 = Date.now();
    const e = await rejection(w.port.renderPdf(w.harness.ctxFor('A:system'), { templateKey: 'billing.invoice', data: INVOICE, idempotencyKey: 'r-3' }));
    expect(e.code).toBe('reporting.render_unavailable');
    expect(Date.now() - t0).toBeLessThan(5_000);
  });
  it('output larger than 10 MB → common.payload_too_large', async () => {
    const w = await world(); w.stub.setMode({ bigPdfBytes: 10 * 1024 * 1024 + 1024 });
    const e = await rejection(w.port.renderPdf(w.harness.ctxFor('A:system'), { templateKey: 'billing.invoice', data: INVOICE, idempotencyKey: 'r-4' }));
    expect(e.code).toBe('common.payload_too_large');
  });
  it('errors never carry the bearer token or the data (no PHI / portalUrl in error text or logs)', async () => {
    const w = await world(); w.stub.setMode({ status: 503 });
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    try {
      const e = await rejection(w.port.renderPdf(w.harness.ctxFor('A:system'), { templateKey: 'partners.access_slip', data: SLIP, idempotencyKey: 'r-5' }));
      const blob = JSON.stringify({ m: e.message, c: e.code, d: e.details, s: e.stack }) + spies.map((s) => JSON.stringify(s.mock.calls)).join('');
      expect(blob).not.toContain(SLIP.portalUrl); expect(blob).not.toContain(SLIP.patientDisplayName); expect(blob).not.toContain(TOKEN);
    } finally { spies.forEach((s) => s.mockRestore()); }
  });
});

describe('static — 60 s default timeout, no storage / no logging of data', () => {
  const src = readFileSync(fileURLToPath(new URL('../ports/RenderPort.impl.ts', import.meta.url)), 'utf8');
  it('default timeout is 60 s', () => { expect(src).toMatch(/60[_]?000/); });
  it('does not use storage, db or fs writes (C6 stores nothing — 08 R12c, R26)', () => {
    expect(src).not.toMatch(/ctx\.(storage|db)\b/);
    expect(src).not.toMatch(/node:fs|writeFile|createWriteStream/);
  });
  it('does not log (request/response bodies carry portalUrl and PHI)', () => { expect(src).not.toMatch(/console\.|logger\.|\.log\(/); });
});
