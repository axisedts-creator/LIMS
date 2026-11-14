// C6-T07 — narrative-report template (04-UI-UX §3.3, §3.2 "Narrative section"). Same header/footer as lab-report; signatory = narrative signer.
// Security: narrative HTML is sanitised server-side AND re-sanitised at render (REQ-SEC-088, 07-SECURITY T8; AC-05.2).
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPool } from '../../pool.js';
import { narrativeReportTemplate } from '../narrative/index.js';
import { SIG_A, externalRefs, hasField, makeAssets, makeConfig, makeDoc, ref, renderPdf } from './fixtures.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let pool: Awaited<ReturnType<typeof createPool>>;
beforeAll(async () => {
  pool = await createPool({ contexts: 2 });
});
afterAll(async () => {
  await pool?.close();
});

const signer = { ...SIG_A, membershipId: '018f0000-0000-7000-8000-00000000000d', displayName: 'Dr. Synthetic Radiologist', displayTitle: 'MD Radiology', registrationNo: 'NMC-SYN-0003', role: 'narrative_signer' };
const narrative = (over: Record<string, unknown> = {}) => ({
  kind: 'narrative', narrativeVersionId: '018f0000-0000-7000-8000-0000000000aa', testName: 'USG ABDOMEN (SYNTHETIC)', templateKind: 'ultrasonography',
  sections: [
    { heading: 'FINDINGS', html: '<p>Liver is <b>normal</b> in size.</p><ul><li>No focal lesion</li></ul>' },
    { heading: 'IMPRESSION', html: '<p>Synthetic normal study.</p>' },
  ],
  images: [1, 2, 3].map((n) => ({ ref: ref('narrative_image', `img${n}`), caption: `Synthetic image ${n}` })),
  signedBy: signer, ...over,
});
const ndoc = (n: Record<string, unknown> = {}, over: Record<string, unknown> = {}) => makeDoc({ family: 'narrative', sections: [narrative(n)], signatories: [signer], disclaimers: ['Synthetic narrative disclaimer.'], ...over });
const R = (input: Parameters<typeof renderPdf>[2]) => renderPdf(pool, narrativeReportTemplate, input);

describe('module contract', () => {
  it('is the narrative-report TemplateModule returning a full static HTML document', () => {
    expect(narrativeReportTemplate.templateId).toBe('narrative-report');
    const html = narrativeReportTemplate.render({ document: ndoc(), config: makeConfig(), variant: 'letterhead', assets: makeAssets().assets });
    expect(html.trimStart().toLowerCase()).toMatch(/^<!doctype html>/);
    expect(externalRefs(html)).toEqual([]);
  });
  it('is deterministic', () => {
    const mk = () => narrativeReportTemplate.render({ document: ndoc(), config: makeConfig(), variant: 'letterhead', assets: makeAssets().assets });
    expect(mk()).toBe(mk());
  });
});

describe('body (AC-03.1 analogue for narrative)', () => {
  it('prints "<KIND> REPORT" title, test name, section headings in order, sanitised text, captions and the "Signed by" line', async () => {
    const mk = makeAssets();
    const { pages, pageCount } = await R({ document: ndoc(), assets: mk.assets });
    expect(pageCount).toBe(1);
    const t = pages[0]!;
    let at = -1;
    for (const s of ['ULTRASONOGRAPHY REPORT', 'USG ABDOMEN (SYNTHETIC)', 'FINDINGS', 'Liver is normal in size.', 'No focal lesion', 'IMPRESSION', 'Synthetic normal study.',
      'Synthetic image 1', 'Synthetic image 2', 'Synthetic image 3', 'Signed by']) {
      const i = t.indexOf(s, at + 1);
      expect(i, `"${s}" after ${at} in: ${t}`).toBeGreaterThan(at);
      at = i;
    }
    expect(t).toMatch(/Signed by\s*:?\s*Dr\. Synthetic Radiologist/);
    expect(mk.calls.filter((c) => c.source === 'narrative_image').map((c) => c.id).sort()).toEqual(['img1', 'img2', 'img3']);
  });
  it('images are bounded to 80 mm height (04-UI-UX §3.2)', () => {
    const html = narrativeReportTemplate.render({ document: ndoc(), config: makeConfig(), variant: 'letterhead', assets: makeAssets().assets });
    expect(html).toMatch(/max-height:\s*80mm/);
  });
  it('the footer signatory is the narrative signer with "<council> No. <registration_no>" (LD-27); the lab "Approved by" line does not exist', async () => {
    const { pages } = await R({ document: ndoc() });
    expect(pages[0]).toContain('Dr. Synthetic Radiologist');
    expect(pages[0]).toContain('MD Radiology');
    expect(pages[0]).toContain('NMC No. NMC-SYN-0003');
    expect(pages[0]).not.toContain('Approved by:');
  });
  it('headings and test name are escaped text', async () => {
    const { html, pages } = await R({ document: ndoc({ testName: '<i>TN</i>', sections: [{ heading: '<b>H</b>', html: '<p>x</p>' }] }) });
    expect(html).not.toContain('<i>TN</i>');
    expect(pages[0]).toContain('<i>TN</i>');
    expect(pages[0]).toContain('<b>H</b>');
  });
});

describe('AC-03.2 / AC-03.5 on a multi-page narrative', () => {
  it('repeats header block, signer footer, QR caption and watermark on every page', async () => {
    const long = Array.from({ length: 140 }, (_, i) => `<p>Synthetic finding paragraph ${i + 1}.</p>`).join('');
    const { pages, pageCount } = await R({ document: ndoc({ sections: [{ heading: 'FINDINGS', html: long }] }), config: makeConfig({ watermark: { text: 'WMKSAMPLE', opacity: 0.1 } }) });
    expect(pageCount).toBeGreaterThanOrEqual(3);
    for (const [i, p] of pages.entries()) {
      expect(hasField(p, 'Name', 'Test Patient 0042'), `page ${i + 1} name`).toBe(true);
      expect(p, `page ${i + 1} reg`).toContain('0001SY000001');
      for (const s of ['Dr. Synthetic Radiologist', 'NMC No. NMC-SYN-0003', 'Synthetic narrative disclaimer.', 'labmail@synthetic.example', 'Scan to verify', 'WMKSAMPLE'])
        expect(p, `page ${i + 1} "${s}"`).toContain(s);
    }
  });
  it('LD-26: training watermark on every page', async () => {
    const long = Array.from({ length: 140 }, (_, i) => `<p>Synthetic finding paragraph ${i + 1}.</p>`).join('');
    const { pages, pageCount } = await R({ document: ndoc({ sections: [{ heading: 'FINDINGS', html: long }] }), trainingMode: true });
    expect(pageCount).toBeGreaterThanOrEqual(3);
    for (const p of pages) expect(p).toContain('TRAINING - NOT A VALID REPORT');
  });
});

describe('REQ-SEC-088 narrative HTML is re-sanitised at render (defence in depth)', () => {
  const HOSTILE =
    '<p>ok-text</p><script>alert(1)</script><img src="http://169.254.169.254/x" onerror="alert(2)">' +
    '<a href="javascript:alert(3)">link-text</a><iframe src="data:text/html,x"></iframe><object data="http://x.example/o"></object>' +
    '<style>@import url(http://x.example/s.css);</style><link rel="stylesheet" href="http://x.example/l.css">' +
    '<p style="background:url(http://169.254.169.254/y)" onclick="alert(4)">styled-text</p><svg onload="alert(5)"><a xlink:href="javascript:alert(6)">s</a></svg>' +
    '<form action="http://x.example/f"><input name="a"></form><meta http-equiv="refresh" content="0;url=http://x.example/">';
  it('strips scripts, handlers, external URLs, iframes, styles, forms and svg but keeps the safe text', async () => {
    const before = pool.stats().blockedRequests;
    const { html, pages } = await R({ document: ndoc({ sections: [{ heading: 'FINDINGS', html: HOSTILE }] }) });
    expect(externalRefs(html)).toEqual([]);
    for (const bad of ['169.254.169.254', 'x.example', 'onerror', 'onclick', 'onload', 'javascript:', '<iframe', '<object', '<form', '<svg', '<meta http-equiv'])
      expect(html, bad).not.toContain(bad);
    expect(pages[0]).toContain('ok-text');
    expect(pages[0]).toContain('link-text');
    expect(pages[0]).toContain('styled-text');
    expect(pool.stats().blockedRequests).toBe(before);
  });
  it('keeps the allowlisted formatting (paragraph, bold, list) as markup', () => {
    const html = narrativeReportTemplate.render({ document: ndoc(), config: makeConfig(), variant: 'letterhead', assets: makeAssets().assets });
    expect(html).toMatch(/<b>normal<\/b>|<strong>normal<\/strong>/);
    expect(html).toMatch(/<li>No focal lesion<\/li>/);
  });
  it('an unterminated or malformed fragment cannot break out of its section', () => {
    const html = narrativeReportTemplate.render({
      document: ndoc({ sections: [{ heading: 'A', html: '<p><b>open' }, { heading: 'B', html: '</div></td></table></body></html><h1>escape</h1>' }] }),
      config: makeConfig(), variant: 'letterhead', assets: makeAssets().assets,
    });
    expect(externalRefs(html)).toEqual([]);
    expect((html.match(/<\/body>/gi) ?? []).length).toBe(1);
    expect((html.match(/<\/html>/gi) ?? []).length).toBe(1);
  });
});
