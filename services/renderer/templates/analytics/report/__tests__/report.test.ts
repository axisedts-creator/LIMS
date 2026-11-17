// AN-T15b — `analytics.report` DataTemplateModule (02-TRD §10.2 step 6a; C6 02-TRD §5.3, §7.4; REQ-SEC-086; US-17 AC4 PDF path). Synthetic data only.
// ASSUMED API (spec gives the DataTemplateModule contract, not file names): services/renderer/templates/analytics/index.ts exports `templates: DataTemplateModule[]`
//   containing { templateKey: 'analytics.report', render }; it is found through the real loadRegistry() default root (services/renderer/templates).
// ASSUMED markup: the data table is a <table> whose first row cells (th or td) are the column labels in `columns` order; one <tr> per row, one cell per column.
// ASSUMED formats (02-TRD step 6a + 04-UI-UX §3): paisa -> lakh grouping with 2 decimals (optional Rs./NPR prefix), seconds -> "42 min" | "5 h 12 min" | "3 d 4 h",
//   bp -> one decimal + "%", count -> plain integer. Defensive: data that breaks the schema (no columns/rows, non-integer numeric cell) throws -> HTTP 422, no echo.
// Not covered: pixel layout / fonts (no PDF image diff in repo); the RenderPort-side schema check itself (C6-T36 + schema.test.ts).
import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPool } from '../../../../src/pool.js';
import { startServer } from '../../../../src/server.js';
import { loadRegistry } from '../../../../src/templates/registry.js';
import { norm, pdfPages, pdfText } from '../../../../src/__tests__/helpers/pdf-text.js';
import { EXPECTED_CELLS, FORMULA, META_KEYS, NOT_STATUTORY, REPORT, ROWS, clone, deepFreeze, wideColumns, withRows, type ReportData } from './fixtures.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
const TOKEN = 'synthetic-renderer-token-0123456789abcdef';
const assets = { dataUri: () => 'data:image/png;base64,iVBORw0KGgo=' };

type Mod = { templateKey: string; render(i: { data: Readonly<Record<string, unknown>>; assets: typeof assets; qr?: (t: string) => string }): string };
let mod: Mod;
beforeAll(async () => {
  const reg = await loadRegistry();
  mod = reg.get('analytics.report') as unknown as Mod;
  expect(mod, 'loadRegistry() must register analytics.report from templates/analytics/index.ts').toBeDefined();
});
const html = (d: unknown) => mod.render({ data: d as Record<string, unknown>, assets });

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", '#x27': "'", '#34': '"' };
const decode = (s: string) => s.replace(/&(amp|lt|gt|quot|apos|#39|#x27|#34);/g, (_m, e: string) => ENT[e]!);
const textOf = (h: string) => norm(decode(h.replace(/<(style|script)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]*>/g, ' ')));
/** Every <table> as a matrix of decoded cell text. */
const tables = (h: string): string[][][] => [...h.matchAll(/<table\b[\s\S]*?<\/table>/gi)].map((t) =>
  [...t[0].matchAll(/<tr\b[\s\S]*?<\/tr>/gi)].map((r) => [...r[0].matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((c) => textOf(c[1]!))));
const dataTable = (h: string, labels: string[]) => {
  const t = tables(h).find((m) => JSON.stringify(m[0]) === JSON.stringify(labels));
  expect(t, `a <table> whose first row is ${JSON.stringify(labels)}`).toBeDefined();
  return t!;
};
const imgSrcs = (h: string) => [...h.matchAll(/<img\b[^>]*\bsrc="([^"]*)"/g)].map((x) => x[1]!);
const LABELS = REPORT.columns.map((c) => c.label);

describe('module — DataTemplateModule shape and registry', () => {
  it('loadRegistry() (default root) resolves analytics.report next to the C6 templates; ids stay unique', async () => {
    const reg = await loadRegistry();
    expect(reg.get('analytics.report')).toBeDefined();
    expect(reg.ids()).toContain('analytics.report');
    expect((reg.get('lab-report') as { templateId?: string })?.templateId).toBe('lab-report');
    expect(reg.ids().filter((i) => i === 'analytics.report')).toHaveLength(1);
  });
  it('templateKey analytics.report; render returns a full HTML document', () => {
    expect(mod.templateKey).toBe('analytics.report');
    const h = html(REPORT);
    expect(h).toMatch(/^\s*<!doctype html>/i); expect(h).toMatch(/<\/html>\s*$/i);
  });
});

describe('render the fixture (done_when: template renders the fixture)', () => {
  let h = '';
  beforeAll(() => { h = html(REPORT); });
  it('prints every header-block value of step 6a (tenant, title, A.D./B.S. period, scope, generated at, export id, exported by, freshness, not-statutory line)', () => {
    const t = textOf(h);
    for (const k of META_KEYS) expect(t, k).toContain(REPORT[k]);
    expect(t).toContain(NOT_STATUTORY);
  });
  it('render snapshot: the data table is exactly header labels + one formatted row per input row, cells in `columns` order', () => {
    const t = dataTable(h, LABELS);
    expect(t).toHaveLength(1 + ROWS.length);
    t.slice(1).forEach((row, i) => {
      expect(row, `row ${i}`).toHaveLength(LABELS.length);
      row.forEach((cell, j) => {
        const want = EXPECTED_CELLS[i]![j]!;
        if (typeof want === 'string') expect(cell, `r${i}c${j}`).toBe(want); else expect(cell, `r${i}c${j}`).toMatch(want);
      });
    });
  });
  it('cells follow `columns` order, not the key order of the row object', () => {
    const d = clone(REPORT); d.rows = d.rows.map((r) => Object.fromEntries(Object.entries(r).reverse()));
    expect(dataTable(html(d), LABELS).slice(1).map((r) => r[0])).toEqual(ROWS.map((r) => String(r['department'])));
  });
  it('kinds format per step 6a: paisa lakh-grouped, seconds as durations, bp one decimal', () => {
    const d = { ...clone(REPORT), columns: [{ key: 'v', label: 'V', kind: 'paisa' }], rows: [{ v: 100 }, { v: 99 }, { v: 100000 }, { v: 10000000 }, { v: 1234567890 }] };
    const cells = dataTable(html(d), ['V']).slice(1).map((r) => r[0]!.replace(/^(?:Rs\.?\s?|NPR\s?)/, ''));
    expect(cells).toEqual(['1.00', '0.99', '1,000.00', '1,00,000.00', '1,23,45,678.90']);
    const s = { ...clone(REPORT), columns: [{ key: 'v', label: 'V', kind: 'seconds' }], rows: [{ v: 0 }, { v: 3599 }, { v: 3660 }, { v: 172799 }, { v: 176400 }] };
    expect(dataTable(html(s), ['V']).slice(1).map((r) => r[0])).toEqual(['0 min', '59 min', '1 h 1 min', '47 h 59 min', '2 d 1 h']);
    const b = { ...clone(REPORT), columns: [{ key: 'v', label: 'V', kind: 'bp' }], rows: [{ v: 0 }, { v: 1 }, { v: 2500 }, { v: 9990 }] };
    expect(dataTable(html(b), ['V']).slice(1).map((r) => r[0])).toEqual(['0.0%', '0.0%', '25.0%', '99.9%']);
  });
  it('0 rows: renders, keeps the header block, the column labels and the not-statutory line', () => {
    const out = html({ ...clone(REPORT), rows: [] });
    expect(textOf(out)).toContain(NOT_STATUTORY);
    expect(dataTable(out, LABELS)).toHaveLength(1);
  });
  it('5,000 rows (the RenderPort cap) render to one table row each; 40 columns keep every label', () => {
    expect(dataTable(html(withRows(5000)), LABELS)).toHaveLength(5001);
    const w = withRows(3, wideColumns(40));
    expect(dataTable(html(w), w.columns.map((c) => c.label))[1]).toHaveLength(40);
  });
  it('pure: same input -> byte-identical HTML; input (even deeply frozen) is not mutated; no clock or random', () => {
    expect(html(REPORT)).toBe(h);
    const frozen = deepFreeze(clone(REPORT));
    expect(html(frozen)).toBe(h); expect(frozen).toEqual(REPORT);
  });
  it('unknown extra data keys change nothing (the template prints only the step 6a fields)', () => {
    expect(html({ ...clone(REPORT), results: 'Hb 9.1 g/dL', patientPhone: '+9779800000000' })).toBe(h);
  });
});

describe('escaping and REQ-SEC-086 (no script, no external asset, text stays text)', () => {
  const EVIL = `<img src="http://127.0.0.1:9/x.png" onerror="1"><script>SCRIPT-RAN</script>&"'`;
  const evilReport = (): ReportData => ({
    ...Object.fromEntries(META_KEYS.map((k) => [k, EVIL])) as unknown as ReportData,
    columns: [{ key: 'a', label: EVIL, kind: 'text' }, { key: 'b', label: 'B', kind: 'count' }], rows: [{ a: EVIL, b: 1 }],
  });
  it('markup in any string (meta, column label, text cell) is escaped: no tag, no handler, no request-triggering element', () => {
    const out = html(evilReport());
    expect(out).not.toContain(EVIL); expect(out).not.toContain('<script'); expect(out).not.toMatch(/<img\b[^>]*127\.0\.0\.1/); expect(out).not.toMatch(/\son[a-z]+\s*=\s*["']?1/i);
    expect(textOf(out)).toContain(EVIL);   // shown literally
  });
  it('a formula-neutralised cell (leading apostrophe) is printed verbatim, not as a link', () => {
    const out = html(REPORT);
    expect(textOf(out)).toContain(FORMULA); expect(out).not.toMatch(/<a\b/i);
  });
  it('no script / iframe / form / handler, no http(s)/file/protocol-relative src, href, url(), @import, <link>; any image is a data: URI', () => {
    for (const out of [html(REPORT), html(evilReport()), html(withRows(2, wideColumns(40)))]) {
      expect(out).not.toMatch(/<(script|iframe|object|embed|form|link)\b/i);
      expect(out).not.toMatch(/<[^>]*\son[a-z]+\s*=/i);   // no event handler inside any tag (escaped text may still say "onerror=")
      expect(out).not.toMatch(/\b(src|href)\s*=\s*["']?(https?:|\/\/|file:)/i);
      expect(out).not.toMatch(/url\(\s*["']?(https?:|\/\/|file:)|@import|@font-face[^}]*url\(\s*["']?(?!data:)/i);
      for (const s of imgSrcs(out)) expect(s).toMatch(/^data:/);
    }
  });
});

describe('fail closed on data that breaks the schema (defence in depth; server answers 422)', () => {
  it.each([
    ['no columns', (() => { const d: Record<string, unknown> = clone(REPORT); delete d['columns']; return d; })()],
    ['no rows', (() => { const d: Record<string, unknown> = clone(REPORT); delete d['rows']; return d; })()],
    ['rows not an array', { ...clone(REPORT), rows: { a: 1 } }],
    ['columns not an array', { ...clone(REPORT), columns: 'x' }],
    ['float in a paisa cell', { ...clone(REPORT), columns: [{ key: 'a', label: 'A', kind: 'paisa' }], rows: [{ a: 1.5 }] }],
    ['string in a count cell', { ...clone(REPORT), columns: [{ key: 'a', label: 'A', kind: 'count' }], rows: [{ a: 'many' }] }],
  ])('%s -> throws', (_n, d) => { expect(() => html(d)).toThrow(); });
});

describe('static — the template directory fetches nothing, reads nothing, logs nothing, bundles its assets', () => {
  const dir = fileURLToPath(new URL('../../', import.meta.url));   // services/renderer/templates/analytics/
  const files = readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && /\.(ts|js|css|html|svg)$/.test(d.name) && !/__tests__|node_modules/.test(`${d.parentPath}/`))
    .map((d) => [d.name, readFileSync(`${d.parentPath}/${d.name}`, 'utf8')] as const);
  it('has source files, including the report template', () => { expect(files.length).toBeGreaterThan(0); });
  it('no console / logger, no fs / network / process.env, no Date.now / Math.random', () => {
    for (const [n, src] of files) {
      expect(src, n).not.toMatch(/console\.|logger\.|process\.std(out|err)/);
      expect(src, n).not.toMatch(/node:(fs|http|https|net|child_process|dns)|\bfetch\(|XMLHttpRequest|process\.env|writeFile|readFile/);
      expect(src, n).not.toMatch(/Date\.now|new Date\(\)|Math\.random|performance\.now|toLocale(Date|Time)?String|Intl\.DateTimeFormat/);
    }
  });
  it('no external asset reference in any source (src/href/url()/@import/<link>/<script>)', () => {
    for (const [n, src] of files) {
      expect(src, n).not.toMatch(/\b(src|href)\s*=\s*["']?(https?:|\/\/|file:)/i);
      expect(src, n).not.toMatch(/url\(\s*["']?(https?:|\/\/|file:)|@import|<link\b|<script/i);
    }
  });
});

describe('POST /internal/render analytics.report — real Chromium (US-17 AC4 PDF path)', () => {
  let pool: Awaited<ReturnType<typeof createPool>>;
  let srv: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => {
    pool = await createPool({ contexts: 2 });
    srv = await startServer({ pool, token: TOKEN, port: 0, host: '127.0.0.1', registry: await loadRegistry() } as never);
  });
  afterAll(async () => { await srv?.close(); await pool?.close(); });
  const post = (data: unknown) => fetch(srv.url + '/internal/render', { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ template_id: 'analytics.report', data, assets: {} }) });
  const sha = async (r: Response) => createHash('sha256').update(Buffer.from(await r.arrayBuffer())).digest('hex');

  it('200 application/pdf whose text has the header block, labels and formatted values', async () => {
    const res = await post(REPORT);
    expect(res.status).toBe(200); expect(res.headers.get('content-type')).toContain('application/pdf');
    const pdf = new Uint8Array(await res.arrayBuffer());
    expect(Buffer.from(pdf.subarray(0, 5)).toString()).toBe('%PDF-');
    const text = norm(pdfText(pdf));
    for (const k of META_KEYS) expect(text, k).toContain(REPORT[k]);
    for (const l of LABELS) expect(text, l).toContain(l);
    for (const v of ['Biochemistry', '12,34,567.89', '42 min', '12.3%', '5 h 12 min', '3 d 4 h', '100.0%']) expect(text, v).toContain(v);
    expect(Number(res.headers.get('x-page-count'))).toBe(pdfPages(pdf).length);
  });
  it('same data twice >= 1.1 s apart -> identical sha256 (deterministic rendering, contract case 4)', async () => {
    const x = await post(REPORT); await new Promise((r) => setTimeout(r, 1_100)); const y = await post(REPORT);
    expect(await sha(x)).toBe(await sha(y));
  });
  it('different data -> different bytes', async () => {
    expect(await sha(await post(REPORT))).not.toBe(await sha(await post({ ...clone(REPORT), reportTitle: 'Other report' })));
  });
  it('long report: 300 rows span several pages and the column labels repeat on every page', async () => {
    const res = await post(withRows(300)); expect(res.status).toBe(200);
    const pages = pdfPages(new Uint8Array(await res.arrayBuffer()));
    expect(pages.length).toBeGreaterThanOrEqual(2);
    for (const [i, p] of pages.entries()) for (const l of LABELS) expect(norm(p), `page ${i + 1} ${l}`).toContain(l);
  });
  it('40 columns render (200) and every label is in the PDF text', async () => {
    const w = withRows(10, wideColumns(40)); const res = await post(w); expect(res.status).toBe(200);
    const text = norm(pdfText(new Uint8Array(await res.arrayBuffer())));
    for (const c of w.columns) expect(text, c.label).toContain(c.label);
  });
  it('5,000 rows (the RenderPort cap) render within the 30 s job timeout and <= 200 pages; first and last row are in the PDF', async () => {
    // The default pool allows 60 pages (LIMS_RENDERER_MAX_PAGES, C6 deploy config): 5,000 rows only fit with that raised, so this pool is built with 200.
    const big = await createPool({ contexts: 1, maxPages: 200 });
    const bigSrv = await startServer({ pool: big, token: TOKEN, port: 0, host: '127.0.0.1', registry: await loadRegistry() } as never);
    try {
      const res = await fetch(bigSrv.url + '/internal/render', { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ template_id: 'analytics.report', data: withRows(5000), assets: {} }) });
      expect(res.status).toBe(200);
      const text = norm(pdfText(new Uint8Array(await res.arrayBuffer())));
      expect(text).toContain('Dept 0000'); expect(text).toContain('Dept 4999');
    } finally { await bigSrv.close(); await big.close(); }
  });
  it('hostile text is text: no script, no external request attempted', async () => {
    const before = pool.stats().blockedRequests;
    const evil = '<img src="http://127.0.0.1:9/x.png"><script>document.title="SCRIPT-RAN"</script>';
    const res = await post({ ...clone(REPORT), reportTitle: evil, columns: [{ key: 'a', label: evil, kind: 'text' }], rows: [{ a: evil }] });
    expect(res.status).toBe(200);
    expect(norm(pdfText(new Uint8Array(await res.arrayBuffer())))).toContain('<img src=');
    expect(pool.stats().blockedRequests - before).toBe(0);
  });
  it('schema-breaking data -> 422 and the body does not echo the data', async () => {
    const res = await post({ ...clone(REPORT), reportTitle: 'Planted Title Zq9', rows: 'not-an-array' });
    expect(res.status).toBe(422); expect(await res.text()).not.toContain('Planted Title Zq9');
  });
  it('log scan: planted values in 200 and 422 requests -> zero hits in stdout, stderr, console', async () => {
    const PLANT = 'Planted Dept Zq9-7c1e9b2a';
    const out: string[] = [];
    const spies = [
      ...(['stdout', 'stderr'] as const).map((s) => vi.spyOn(process[s], 'write').mockImplementation(((c: unknown) => { out.push(String(c)); return true; }) as never)),
      ...(['log', 'info', 'warn', 'error', 'debug', 'trace'] as const).map((m) => vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { out.push(JSON.stringify(a)); })),
    ];
    let bodies = '';
    try {
      bodies += (await post({ ...clone(REPORT), rows: [{ ...ROWS[0]!, department: PLANT }] })).status;
      bodies += await (await post({ ...clone(REPORT), reportTitle: PLANT, rows: 5 })).text();
    } finally { spies.forEach((s) => s.mockRestore()); }
    expect(out.join('\n') + bodies).not.toContain(PLANT);
  });
  it('no token -> 401', async () => {
    const res = await fetch(srv.url + '/internal/render', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ template_id: 'analytics.report', data: REPORT, assets: {} }) });
    expect(res.status).toBe(401);
  });
});
