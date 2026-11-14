// C6-T40 — `partners.access_slip` DataTemplateModule (08 Addendum A5.1, CR-C13-014; 02-TRD §7.4 cases (6),(9); §5.3; review fix #33). Synthetic data only.
// ASSUMED API (spec names no export): ../access-slip/index.ts exports `accessSlipTemplate: DataTemplateModule` (templateKey 'partners.access_slip'),
//   parallel to labReportTemplate; loadRegistry() registers it ALWAYS (the directory is inside src/, not under templatesRoot), so even the `empty` root resolves it.
//   render({ data, assets, qr }) draws the QR by calling the injected `qr(data.portalUrl)` (the in-tree encoder, C6-T07) and embeds the returned data: URI as <img>;
//   a missing / non-string portalUrl throws (=> HTTP 422 via render.ts). The renderer holds no LIMS_ORIGIN_PORTAL: the origin rule is the API's (render.access-slip.test.ts).
// Not covered: decoding the QR *from the PDF* (vector paths; no decoder dependency in the repo) — the QR is checked as the data: URI the template embeds, module-for-module
//   against the report QR encoder's matrix for portalUrl.
import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPool } from '../../pool.js';
import { startServer } from '../../server.js';
import { loadRegistry } from '../registry.js';
import { accessSlipTemplate } from '../access-slip/index.js';
import { qrDataUri, qrMatrix } from '../lab/qr.js';
import { norm, pdfPages, pdfText } from '../../__tests__/helpers/pdf-text.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
const root = (n: string) => fileURLToPath(new URL(`./fixture-roots/${n}`, import.meta.url));
const TOKEN = 'synthetic-renderer-token-0123456789abcdef';
const SLIP = {
  tenantDisplayName: 'Synthetic Test Lab', partnerName: 'Test Partner Clinic', patientDisplayName: 'Test Patient 0042',
  orderRef: '0001SY000001', portalUrl: 'https://portal.invalid/r/tok0001', expiresAtLocal: '2026-12-05 10:00', issuedAtLocal: '2026-11-05 10:00',
};
const assets = { dataUri: () => 'data:image/png;base64,iVBORw0KGgo=' };

/** Module grid of an SVG QR data: URI (qrDataUri format: one `M{x}{y}h1v1h-1z` square per dark module, 4-module quiet zone). */
function gridOf(uri: string): boolean[][] {
  const m = /^data:image\/svg\+xml;base64,([A-Za-z0-9+/=]+)$/.exec(uri);
  expect(m, 'QR is an svg data: URI').not.toBeNull();
  const svg = Buffer.from(m![1]!, 'base64').toString('utf8');
  const size = Number(/viewBox="0 0 (\d+) \1"/.exec(svg)?.[1]); const q = 4, n = size - 2 * q;
  const g = Array.from({ length: n }, () => new Array<boolean>(n).fill(false));
  for (const [, x, y] of svg.matchAll(/M(\d+) (\d+)h1v1h-1z/g)) g[Number(y) - q]![Number(x) - q] = true;
  return g;
}
const imgSrcs = (html: string) => [...html.matchAll(/<img\b[^>]*\bsrc="([^"]*)"/g)].map((x) => x[1]!);

describe('module — DataTemplateModule shape and registry (review fix #33: lives in src/templates/access-slip/)', () => {
  it('templateKey partners.access_slip; render is a function returning a full HTML document', () => {
    expect(accessSlipTemplate.templateKey).toBe('partners.access_slip');
    const html = accessSlipTemplate.render({ data: SLIP, assets, qr: qrDataUri });
    expect(html).toMatch(/^\s*<!doctype html>/i); expect(html).toMatch(/<\/html>\s*$/i);
  });
  it.each(['full', 'empty'])('loadRegistry(%s root) resolves partners.access_slip (built in) next to the report templates', async (r) => {
    const reg = await loadRegistry({ templatesRoot: root(r) });
    expect((reg.get('partners.access_slip') as any)?.templateKey).toBe('partners.access_slip');
    expect(reg.ids()).toContain('partners.access_slip');
    expect((reg.get('lab-report') as any)?.templateId).toBe('lab-report');
  });
  it('a billing/ or analytics/ root cannot register partners.* keys (a directory may only register its own prefix)', async () => {
    const reg = await loadRegistry({ templatesRoot: root('full') });
    expect(reg.ids().filter((i) => i === 'partners.access_slip')).toHaveLength(1);   // no duplicate-id throw, no shadowing
  });
});

describe('module — content (case 6, template half)', () => {
  const html = accessSlipTemplate.render({ data: SLIP, assets, qr: qrDataUri });
  it('shows tenant, partner, patient, order ref and both timestamps (the printed slip)', () => {
    for (const k of ['tenantDisplayName', 'partnerName', 'patientDisplayName', 'orderRef', 'expiresAtLocal', 'issuedAtLocal'] as const)
      expect(html, k).toContain(SLIP[k]);
  });
  it('QR is drawn from portalUrl: the injected qr() is called with exactly portalUrl, once; its output is the one <img>', () => {
    const qr = vi.fn((t: string) => qrDataUri(t));
    const out = accessSlipTemplate.render({ data: SLIP, assets, qr });
    expect(qr).toHaveBeenCalledTimes(1); expect(qr).toHaveBeenCalledWith(SLIP.portalUrl);
    expect(imgSrcs(out)).toEqual([qrDataUri(SLIP.portalUrl)]);
  });
  it('the embedded QR image is module-for-module the report encoder\'s QR of portalUrl (decodes to portalUrl); a different URL gives a different image', () => {
    const g = gridOf(imgSrcs(html)[0]!);
    expect(g).toEqual(qrMatrix(SLIP.portalUrl));
    const other = accessSlipTemplate.render({ data: { ...SLIP, portalUrl: 'https://portal.invalid/r/tok0002' }, assets, qr: qrDataUri });
    expect(gridOf(imgSrcs(other)[0]!)).not.toEqual(g);
  });
  it('pure: same input → byte-identical HTML (no clock / random in the template)', () => {
    expect(accessSlipTemplate.render({ data: { ...SLIP }, assets, qr: qrDataUri })).toBe(html);
  });
  it('REQ-SEC-086: no script, no handlers, no external references, no link to portalUrl (QR image only; data: URIs only)', () => {
    expect(html).not.toMatch(/<script|<iframe|<object|<embed|<form|\son[a-z]+\s*=/i);
    expect(html).not.toMatch(/\b(src|href)\s*=\s*["']?(https?:|\/\/|file:)/i);
    expect(html).not.toMatch(/url\(\s*["']?(https?:|\/\/)|@import|<link\b/i);
    for (const s of imgSrcs(html)) expect(s).toMatch(/^data:/);
    expect(html).not.toMatch(/<a\b[^>]*href/i);   // portalUrl is not a clickable link in the PDF (a PDF URI action would leak it to the sandbox / viewers)
  });
  it('no result data: the slip has nothing but the 7 fields (adding a field the template does not know changes nothing)', () => {
    expect(accessSlipTemplate.render({ data: { ...SLIP, results: 'Hb 9.1 g/dL', patientPhone: '+9779800000000' }, assets, qr: qrDataUri })).toBe(html);
  });
  it('HTML is escaped: markup in any text field is text, not markup', () => {
    const evil = `<img src="http://127.0.0.1:9/x.png" onerror="1"><script>SCRIPT-RAN</script>&"'`;
    const out = accessSlipTemplate.render({ data: { ...SLIP, patientDisplayName: evil, partnerName: evil, tenantDisplayName: evil, orderRef: evil }, assets, qr: qrDataUri });
    expect(out).not.toContain('<script'); expect(out).not.toContain(evil);
    expect(out).not.toMatch(/<img\b[^>]*127\.0\.0\.1/); expect(imgSrcs(out)).toEqual([qrDataUri(SLIP.portalUrl)]);
    expect(out).toContain('&lt;script&gt;');
  });
  it.each([['missing', undefined], ['empty', ''], ['number', 5], ['null', null], ['object', { u: 1 }]])('portalUrl %s → render throws (server answers 422)', (_n, v) => {
    const { portalUrl: _d, ...rest } = SLIP;
    expect(() => accessSlipTemplate.render({ data: v === undefined ? rest : { ...rest, portalUrl: v }, assets, qr: qrDataUri })).toThrow();
  });
});

describe('static — the template directory logs nothing, stores nothing, fetches nothing, holds no QR library', () => {
  const dir = fileURLToPath(new URL('../access-slip/', import.meta.url));
  const files = readdirSync(dir, { recursive: true, withFileTypes: true }).filter((d) => d.isFile() && /\.(ts|js|css|html)$/.test(d.name)).map((d) => readFileSync(`${d.parentPath}/${d.name}`, 'utf8'));
  it('has source files', () => { expect(files.length).toBeGreaterThan(0); });
  it('no console / logger / stdout, no fs / network / process.env, no Date.now / Math.random', () => {
    for (const src of files) {
      expect(src).not.toMatch(/console\.|logger\.|process\.std(out|err)|\.log\(/);
      expect(src).not.toMatch(/node:(fs|http|https|net|child_process|dns)|\bfetch\(|XMLHttpRequest|process\.env|writeFile/);
      expect(src).not.toMatch(/Date\.now|new Date\(\)|Math\.random|performance\.now/);
    }
  });
  it('reuses the report QR encoder (no second QR implementation, no qr library import)', () => {
    const all = files.join('\n');
    expect(all).not.toMatch(/from\s+['"](qrcode|qr-image|qrcode-generator|jsqr|nayuki)/i);
    expect(all).not.toMatch(/rsRemainder|MASKS|gfMul/);   // encoder internals are not re-implemented here
  });
});

describe('POST /internal/render partners.access_slip — real Chromium (case 6: PDF text has patientDisplayName and orderRef)', () => {
  let pool: Awaited<ReturnType<typeof createPool>>;
  let srv: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => {
    pool = await createPool({ contexts: 2 });
    srv = await startServer({ pool, token: TOKEN, port: 0, host: '127.0.0.1', registry: await loadRegistry({ templatesRoot: root('empty') }) } as any);
  });
  afterAll(async () => { await srv?.close(); await pool?.close(); });
  const post = (data: unknown) => fetch(srv.url + '/internal/render', { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ template_id: 'partners.access_slip', data, assets: {} }) });

  it('200 application/pdf whose text contains patientDisplayName, orderRef, tenant, partner and both times', async () => {
    const res = await post(SLIP);
    expect(res.status).toBe(200); expect(res.headers.get('content-type')).toContain('application/pdf');
    const pdf = new Uint8Array(await res.arrayBuffer());
    expect(Buffer.from(pdf.subarray(0, 5)).toString()).toBe('%PDF-');
    const text = norm(pdfText(pdf));
    for (const k of ['patientDisplayName', 'orderRef', 'tenantDisplayName', 'partnerName', 'expiresAtLocal', 'issuedAtLocal'] as const) expect(text, k).toContain(SLIP[k]);
    expect(pdfPages(pdf).length).toBe(1);   // a slip is one page
    expect(Number(res.headers.get('x-page-count'))).toBe(1);
  });
  it('same data twice ≥1.1 s apart → identical sha256 (deterministic rendering behind contract case 4)', async () => {
    const x = await post(SLIP); await new Promise((r) => setTimeout(r, 1_100)); const y = await post(SLIP);
    const sha = async (r: Response) => createHash('sha256').update(Buffer.from(await r.arrayBuffer())).digest('hex');
    expect(await sha(x)).toBe(await sha(y));
  });
  it('different portalUrl → different bytes (the QR is in the PDF)', async () => {
    const sha = async (r: Response) => createHash('sha256').update(Buffer.from(await r.arrayBuffer())).digest('hex');
    expect(await sha(await post(SLIP))).not.toBe(await sha(await post({ ...SLIP, portalUrl: 'https://portal.invalid/r/tok0002' })));
  });
  it('hostile patient name is text: no script, no external request attempted', async () => {
    const before = pool.stats().blockedRequests;
    const evil = '<img src="http://127.0.0.1:9/x.png"><script>document.title="SCRIPT-RAN"</script>';
    const res = await post({ ...SLIP, patientDisplayName: evil });
    expect(res.status).toBe(200);
    const text = norm(pdfText(new Uint8Array(await res.arrayBuffer())));
    expect(text).toContain('<img src='); expect(pool.stats().blockedRequests - before).toBe(0);
  });
  it('missing portalUrl → 422, and the response body does not echo the data', async () => {
    const { portalUrl: _d, ...rest } = SLIP;
    const res = await post({ ...rest, patientDisplayName: 'Planted Patient Zq9' });
    expect(res.status).toBe(422);
    expect(await res.text()).not.toContain('Planted Patient Zq9');
  });

  it('(9, renderer side) log scan: planted portalUrl / patient name in 200 and 422 requests → zero hits in stdout, stderr, console', async () => {
    const PLANT = 'https://portal.invalid/r/PLANT-7c1e9b2a4d5f8e03', NAME = 'Planted Patient Zq9';
    const out: string[] = [];
    const spies = [
      ...(['stdout', 'stderr'] as const).map((s) => vi.spyOn(process[s], 'write').mockImplementation(((c: any) => { out.push(String(c)); return true; }) as any)),
      ...(['log', 'info', 'warn', 'error', 'debug', 'trace'] as const).map((m) => vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { out.push(JSON.stringify(a)); })),
    ];
    let bodies = '';
    try {
      const ok = await post({ ...SLIP, portalUrl: PLANT, patientDisplayName: NAME }); bodies += `${ok.status}`;
      const { orderRef: _o, ...bad } = { ...SLIP, portalUrl: PLANT, patientDisplayName: NAME };
      const r422 = await post({ ...bad, portalUrl: 5 }); bodies += await r422.text();
      const r400 = await fetch(srv.url + '/internal/render', { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ template_id: 'partners.access_slip', assets: {}, planted: PLANT }) }); bodies += await r400.text();
    } finally { spies.forEach((s) => s.mockRestore()); }
    const hay = out.join('\n') + bodies;
    for (const n of [PLANT, 'PLANT-7c1e9b2a4d5f8e03', NAME]) expect(hay, `needle ${n}`).not.toContain(n);
  });
  it('no token → 401', async () => {
    const res = await fetch(srv.url + '/internal/render', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ template_id: 'partners.access_slip', data: SLIP, assets: {} }) });
    expect(res.status).toBe(401);
  });
});
