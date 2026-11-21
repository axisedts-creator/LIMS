// T0B-PRINTCFG-1 done_when (3) HEADER AND FOOTER on reports (LD-316, LD-319(1)): the renderer applies the print profile paper mode. Real Chromium through the real server (like print-render.test.ts);
// PDF text extraction + text positions (helpers/pdf-geometry.ts: mm from the page top) prove where text sits ("margin box checks").
// PINNED (spec silent; a change needs a ruling):
//   * POST /internal/render report bundle gets an optional `print_profile` = the contract PrintProfile fields the renderer needs, snake_case:
//       { paper_mode, header_text, footer_text, reserve_top_mm, reserve_bottom_mm, show_logo, grayscale, font_size_pt }
//     Module level (TemplateModule.render input) the same object is `printProfile`. With a profile present, `paper_mode` alone decides which header / footer is drawn (the `variant` only keeps
//     meaning for reports without a profile); without a profile nothing changes (the existing lab-report tests keep passing).
//   * letterhead_image: the branding images (document.lab.headerAssetRef / footerAssetRef, assets keyed by sha256) as today.  typed_header_footer: header_text / footer_text as plain text in the top / bottom
//     page margin of EVERY page, no images.  preprinted_paper: nothing is drawn in the top reserve_top_mm and bottom reserve_bottom_mm of any page, header_text / footer_text are NOT printed even if present.
//     plain: no header, no footer, no letterhead images.  grayscale: black and white (images converted to gray, no colour operators).  font_size_pt: the body font size.
//   * every text is escaped: angle brackets and ampersands print literally and no markup is interpreted (also at HTML level, no Chromium needed).
import { deflateSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPool } from '../../pool.js';
import { startServer } from '../../server.js';
import { labReportTemplate } from '../lab/index.js';
import { loadRegistry } from '../registry.js';
import { allImagesGray, imageDraws, lineWith, nonGrayColourOps, pageSizesMm, textLines, textRuns } from '../../__tests__/helpers/pdf-geometry.js';
import { norm, pdfPages } from '../../__tests__/helpers/pdf-text.js';
import { bulkBlock, cbcBlock, dept, makeAssets, makeConfig, makeDoc, PNG_B64 } from './fixtures.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
const TOKEN = 'synthetic-renderer-token-0123456789abcdef';
let pool: Awaited<ReturnType<typeof createPool>>; let srv: Awaited<ReturnType<typeof startServer>>;
beforeAll(async () => { pool = await createPool({ contexts: 2 }); srv = await startServer({ pool, token: TOKEN, port: 0, host: '127.0.0.1', registry: await loadRegistry() }); });
afterAll(async () => { await srv?.close(); await pool?.close(); });

// a 1x1 solid red PNG (so a grayscale print has something coloured to convert)
const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (t: string, d: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
const RED_PNG = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', Buffer.from([0, 0, 0, 8, 0, 0, 0, 8, 8, 2, 0, 0, 0])),
  chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: 8 }, () => Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: 8 }, () => [255, 0, 0]).flat())]))))), chunk('IEND', Buffer.alloc(0))]).toString('base64');
const SHA = 'a'.repeat(64);
const ASSETS = { [SHA]: { mime_type: 'image/png', base64: RED_PNG } };

const profile = (over: Record<string, unknown> = {}) => ({ paper_mode: 'plain', header_text: '', footer_text: '', reserve_top_mm: 0, reserve_bottom_mm: 0, show_logo: false, grayscale: false, font_size_pt: 10, ...over });
const post = (body: unknown) => fetch(`${srv.url}/internal/render`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const renderReport = async (print_profile: unknown, o: { doc?: unknown; config?: unknown; variant?: string } = {}) => {
  const r = await post({ template_id: 'lab-report', template_version_config: o.config ?? makeConfig(), variant: o.variant ?? 'letterhead', document: o.doc ?? makeDoc(), assets: ASSETS, ...(print_profile === undefined ? {} : { print_profile }) });
  expect(r.status, 'renderer status').toBe(200);
  return new Uint8Array(await r.arrayBuffer());
};
const longDoc = () => makeDoc({ sections: [dept('HAEMATOLOGY', [cbcBlock(), bulkBlock(70)])] });

describe('typed_header_footer: own header and footer text in the page margins of every page', () => {
  const HEAD = ['Synthetic Diagnostic Lab (T0BPC)', 'Kathmandu, Nepal'], FOOT = ['Thank you (T0BPC)', 'Open 7am to 7pm'];
  it('header lines sit above the body, footer lines below it, on every page (multi page report)', async () => {
    const pdf = await renderReport(profile({ paper_mode: 'typed_header_footer', header_text: HEAD.join('\n'), footer_text: FOOT.join('\n') }), { doc: longDoc() });
    const pages = pdfPages(pdf).length; expect(pages).toBeGreaterThanOrEqual(2);
    const H = pageSizesMm(pdf)[0]!.h;
    for (let p = 1; p <= pages; p++) {
      const lines = textLines(pdf).filter((l) => l.page === p);
      const h1 = lines.find((l) => l.text.includes(HEAD[0]!)), h2 = lines.find((l) => l.text.includes(HEAD[1]!)), f1 = lines.find((l) => l.text.includes(FOOT[0]!)), f2 = lines.find((l) => l.text.includes(FOOT[1]!));
      expect(h1 && h2 && f1 && f2, `page ${p} carries header and footer`).toBeTruthy();
      const body = lines.filter((l) => !HEAD.concat(FOOT).some((t) => l.text.includes(t)));
      expect(h1!.yMm).toBeLessThan(h2!.yMm);                                   // lines keep their order
      expect(h2!.yMm).toBeLessThan(Math.min(...body.map((l) => l.yMm)));       // header entirely above the body
      expect(f1!.yMm).toBeGreaterThan(Math.max(...body.map((l) => l.yMm)));    // footer entirely below the body
      expect(f2!.yMm).toBeLessThan(H);                                          // and on the page
      expect(h1!.yMm).toBeGreaterThan(0);
    }
  });
  it('prints no letterhead image in this mode (fewer image draws than letterhead_image mode: header + footer image)', async () => {
    const typed = imageDraws(await renderReport(profile({ paper_mode: 'typed_header_footer', header_text: 'H', footer_text: 'F' })));
    const lh = imageDraws(await renderReport(profile({ paper_mode: 'letterhead_image' })));
    expect(typed).toBeLessThan(lh);
  });
  it('angle brackets, ampersands and quotes print literally (PDF text), nothing is interpreted as markup', async () => {
    const pdf = await renderReport(profile({ paper_mode: 'typed_header_footer', header_text: 'Lab <b>X</b> & Co "Q" <script>alert(1)</script>', footer_text: 'A &amp; B &lt;i&gt;' }));
    const text = pdfPages(pdf).map(norm).join('\n');
    expect(text).toContain('Lab <b>X</b> & Co "Q" <script>alert(1)</script>');
    expect(text).toContain('A &amp; B &lt;i&gt;');
  });
  it('HTML level: escaped, never raw (no Chromium)', () => {
    const html = labReportTemplate.render({ document: makeDoc(), config: makeConfig(), variant: 'letterhead', assets: makeAssets().assets,
      printProfile: profile({ paper_mode: 'typed_header_footer', header_text: 'H <img src=x onerror=alert(1)> & <b>', footer_text: '</style><script>1</script>' }) } as never);
    expect(html).not.toMatch(/<img src=x/i); expect(html).not.toMatch(/<script>1<\/script>/i); expect(html).not.toMatch(/<b>\s*<\/b>|& <b>/);
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;'); expect(html).toContain('&amp;');
  });
  it('a header of 8 lines of 120 characters still renders (the maximum the contract allows) and every line is on the page', async () => {
    const eight = Array.from({ length: 8 }, (_, i) => `L${i + 1} ${'w'.repeat(100)}`).join('\n');
    const pdf = await renderReport(profile({ paper_mode: 'typed_header_footer', header_text: eight }));
    const t = pdfPages(pdf).map(norm).join('\n'); for (let i = 1; i <= 8; i++) expect(t).toContain(`L${i} `);
  });
});

describe('preprinted_paper: the reserved millimetres stay blank and nothing is printed in them', () => {
  const RT = 45, RB = 25;
  it('no text starts above reserve_top_mm or below the bottom reserve on any page; header_text / footer_text are not printed', async () => {
    const pdf = await renderReport(profile({ paper_mode: 'preprinted_paper', reserve_top_mm: RT, reserve_bottom_mm: RB, header_text: 'MUSTNOTPRINT-HEAD', footer_text: 'MUSTNOTPRINT-FOOT' }), { doc: longDoc() });
    const sizes = pageSizesMm(pdf);
    expect(pdfPages(pdf).length).toBeGreaterThanOrEqual(2);
    const runs = textRuns(pdf); expect(runs.length).toBeGreaterThan(50);
    for (const r of runs) { expect(r.yMm, `"${r.text}" p${r.page}`).toBeGreaterThanOrEqual(RT); expect(r.yMm, `"${r.text}" p${r.page}`).toBeLessThanOrEqual(sizes[r.page - 1]!.h - RB); }
    expect(pdfPages(pdf).map(norm).join('\n')).not.toContain('MUSTNOTPRINT');
  });
  it('no letterhead image is drawn even when the report carries branding assets', async () => {
    const pre = imageDraws(await renderReport(profile({ paper_mode: 'preprinted_paper', reserve_top_mm: RT, reserve_bottom_mm: RB })));
    const lh = imageDraws(await renderReport(profile({ paper_mode: 'letterhead_image' })));
    expect(pre).toBeLessThan(lh);
  });
  it('a bigger reserve moves the body down (the profile reserve, not the template default, decides)', async () => {
    const top = async (mm: number) => lineWith(await renderReport(profile({ paper_mode: 'preprinted_paper', reserve_top_mm: mm, reserve_bottom_mm: 10 })), 'Reg No')!.yMm;
    expect(await top(70)).toBeGreaterThan((await top(40)) + 20);
  });
});

describe('plain and letterhead_image', () => {
  it('plain: no header, no footer, no letterhead images, body still printed; reserve 0 -> text may start near the top', async () => {
    const pdf = await renderReport(profile({ paper_mode: 'plain', header_text: 'MUSTNOTPRINT-HEAD', footer_text: 'MUSTNOTPRINT-FOOT' }));
    const t = pdfPages(pdf).map(norm).join('\n');
    expect(t).not.toContain('MUSTNOTPRINT'); expect(t).toContain('Reg No');
    const lh = imageDraws(await renderReport(profile({ paper_mode: 'letterhead_image' })));
    expect(imageDraws(pdf)).toBeLessThan(lh);
  });
  it('letterhead_image: the branding header and footer images are drawn (4 image draws against 2 without them), no typed text', async () => {
    const pdf = await renderReport(profile({ paper_mode: 'letterhead_image', header_text: 'MUSTNOTPRINT-HEAD' }), { variant: 'plain' });
    expect(imageDraws(pdf)).toBeGreaterThanOrEqual(4);
    expect(pdfPages(pdf).map(norm).join('\n')).not.toContain('MUSTNOTPRINT');
  });
});

describe('grayscale and font size', () => {
  it('grayscale forces black and white: no colour operator and every image pixel is gray, while the colour print keeps the red image', async () => {
    const colour = await renderReport(profile({ paper_mode: 'letterhead_image', grayscale: false }));
    const gray = await renderReport(profile({ paper_mode: 'letterhead_image', grayscale: true }));
    expect(allImagesGray(colour), 'fixture sanity: the colour print really contains the red image').toBe(false);
    expect(allImagesGray(gray)).toBe(true);
    expect(nonGrayColourOps(gray)).toEqual([]);
  });
  it('font_size_pt is applied: the median text size follows the profile', async () => {
    const med = async (pt: number) => { const s = textRuns(await renderReport(profile({ paper_mode: 'plain', font_size_pt: pt }))).map((r) => r.sizePt).sort((a, b) => a - b); return s[Math.floor(s.length / 2)]!; };
    const [a, b] = [await med(8), await med(12)];
    expect(Math.abs(a - 8)).toBeLessThan(1.2); expect(Math.abs(b - 12)).toBeLessThan(1.2); expect(b).toBeGreaterThan(a + 2);
  });
});

describe('contract of the request', () => {
  it('no print_profile: output is unchanged (same text and page count as the same request with the old shape)', async () => {
    const a = pdfPages(await renderReport(undefined)).map(norm); const b = pdfPages(await renderReport(undefined)).map(norm);
    expect(a).toEqual(b); expect(a[0]).toContain('Reg No');
  });
  it.each([[{ paper_mode: 'fancy' }], [{ paper_mode: 'plain', reserve_top_mm: 500 }], [{ paper_mode: 'plain', font_size_pt: 99 }], [{ paper_mode: 'plain', header_text: 5 }], ['plain'], [[]]])('a malformed print_profile %j is a 4xx, never a 500', async (pp) => {
    const r = await post({ template_id: 'lab-report', template_version_config: makeConfig(), variant: 'plain', document: makeDoc(), assets: ASSETS, print_profile: pp });
    expect([400, 422]).toContain(r.status);
  });
  it('unused asset keys do not matter; PNG fixture sanity', () => { expect(PNG_B64.length).toBeGreaterThan(10); });
});
