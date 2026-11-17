// C6-T07 — AC-12.2 (layout): "Without letterhead" = plain variant rendered from the same snapshot and template config:
// letterhead images omitted, the same top and bottom margins kept for pre-printed paper, everything else identical.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPool } from '../../pool.js';
import { labReportTemplate } from '../lab/index.js';
import { narrativeReportTemplate } from '../narrative/index.js';
import { bulkBlock, cbcBlock, dept, externalRefs, makeAssets, makeConfig, makeDoc, renderPdf } from './fixtures.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let pool: Awaited<ReturnType<typeof createPool>>;
beforeAll(async () => {
  pool = await createPool({ contexts: 2 });
});
afterAll(async () => {
  await pool?.close();
});

const doc = () => makeDoc({ sections: [dept('HAEMATOLOGY', [cbcBlock(), bulkBlock(100)])] });
const cfg = () => makeConfig({ letterhead: { plain_reserve_top_mm: 37, plain_reserve_bottom_mm: 23 }, watermark: { text: 'WMKSAMPLE', opacity: 0.1 } });

describe('AC-12.2 plain variant of lab-report', () => {
  it('never asks for a letterhead image (header, footer, logo); letterhead variant does', async () => {
    const lh = makeAssets();
    const pl = makeAssets();
    await renderPdf(pool, labReportTemplate, { document: doc(), config: cfg(), variant: 'letterhead', assets: lh.assets });
    await renderPdf(pool, labReportTemplate, { document: doc(), config: cfg(), variant: 'plain', assets: pl.assets });
    expect(lh.calls.some((c) => c.source === 'branding' && c.id === 'hdr')).toBe(true);
    expect(lh.calls.some((c) => c.source === 'branding' && c.id === 'ftr')).toBe(true);
    expect(pl.calls.filter((c) => c.source === 'branding')).toEqual([]);
  });
  it('keeps the signature images, QR and every text element (only letterhead images differ)', async () => {
    const pl = makeAssets();
    const r = await renderPdf(pool, labReportTemplate, { document: doc(), config: cfg(), variant: 'plain', assets: pl.assets });
    expect(pl.calls.filter((c) => c.source === 'signature').map((c) => c.id).sort()).toEqual(expect.arrayContaining(['sigA', 'sigB']));
    for (const p of r.pages) {
      expect(p).toContain('Scan to verify');
      expect(p).toContain('WMKSAMPLE');
      expect(p).toContain('NMC No. NMC-SYN-0001');
    }
  });
  it('same text on every page and same page count as the letterhead variant (same frozen snapshot and template version)', async () => {
    const a = await renderPdf(pool, labReportTemplate, { document: doc(), config: cfg(), variant: 'letterhead' });
    const b = await renderPdf(pool, labReportTemplate, { document: doc(), config: cfg(), variant: 'plain' });
    expect(a.pageCount).toBeGreaterThanOrEqual(2);
    expect(b.pageCount).toBe(a.pageCount);
    expect(b.pages).toEqual(a.pages);
  });
  it('keeps the same @page margins and reserves plain_reserve_top_mm / plain_reserve_bottom_mm for the pre-printed paper', () => {
    const mk = (variant: 'letterhead' | 'plain') => labReportTemplate.render({ document: doc(), config: cfg(), variant, assets: makeAssets().assets });
    const lh = mk('letterhead');
    const pl = mk('plain');
    const pageRule = (h: string) => /@page\s*\{[^}]*\}/.exec(h)?.[0];
    expect(pageRule(pl)).toBeDefined();
    expect(pageRule(pl)).toBe(pageRule(lh));
    expect(pl).toContain('37mm');
    expect(pl).toContain('23mm');
  });
  it('is deterministic (a re-print from the snapshot yields the same HTML)', () => {
    const mk = () => labReportTemplate.render({ document: doc(), config: cfg(), variant: 'plain', assets: makeAssets().assets });
    expect(mk()).toBe(mk());
  });
  it('plain output is as static as the letterhead output (no script, no external references)', () => {
    expect(externalRefs(labReportTemplate.render({ document: doc(), config: cfg(), variant: 'plain', assets: makeAssets().assets }))).toEqual([]);
  });
  it('the letterhead.header_asset / footer_asset = none config also omits the images on the letterhead variant', async () => {
    const mk = makeAssets();
    await renderPdf(pool, labReportTemplate, { document: doc(), config: makeConfig({ letterhead: { header_asset: 'none', footer_asset: 'none' } }), variant: 'letterhead', assets: mk.assets });
    expect(mk.calls.filter((c) => c.source === 'branding')).toEqual([]);
  });
});

describe('AC-12.2 plain variant of narrative-report', () => {
  it('omits letterhead images and keeps the margins rule', () => {
    const nd = makeDoc({
      family: 'narrative',
      sections: [{ kind: 'narrative', narrativeVersionId: '018f0000-0000-7000-8000-0000000000aa', testName: 'USG ABDOMEN (SYNTHETIC)', templateKind: 'ultrasonography',
        sections: [{ heading: 'FINDINGS', html: '<p>Synthetic findings.</p>' }], images: [], signedBy: { ...makeDoc().signatories[0], role: 'narrative_signer' } }],
    });
    const lh = makeAssets();
    const pl = makeAssets();
    const a = narrativeReportTemplate.render({ document: nd, config: cfg(), variant: 'letterhead', assets: lh.assets });
    const b = narrativeReportTemplate.render({ document: nd, config: cfg(), variant: 'plain', assets: pl.assets });
    expect(lh.calls.some((c) => c.source === 'branding')).toBe(true);
    expect(pl.calls.filter((c) => c.source === 'branding')).toEqual([]);
    expect(/@page\s*\{[^}]*\}/.exec(b)?.[0]).toBe(/@page\s*\{[^}]*\}/.exec(a)?.[0]);
  });
});
