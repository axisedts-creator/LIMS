// C6-T07 — preview-sample.ts: synthetic ReportDocument for template preview (AC-13.1; 07-SECURITY "Template previews use synthetic data only").
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPool } from '../../pool.js';
import { labReportTemplate } from '../lab/index.js';
import { previewSampleDocument } from '../preview-sample.js';
import { deepFreeze, externalRefs, makeAssets, makeConfig, renderPdf } from './fixtures.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let pool: Awaited<ReturnType<typeof createPool>>;
beforeAll(async () => {
  pool = await createPool({ contexts: 1 });
});
afterAll(async () => {
  await pool?.close();
});

describe('previewSampleDocument()', () => {
  it('is a schemaVersion-1 laboratory ReportDocument with synthetic identity, a QR url and a signatory', () => {
    const d = previewSampleDocument() as any;
    expect(d.schemaVersion).toBe(1);
    expect(d.family).toBe('laboratory');
    expect(d.sections.length).toBeGreaterThan(0);
    expect(d.signatories.length).toBeGreaterThan(0);
    expect(d.header.patientName).toMatch(/synthetic|test|sample/i);
    expect(d.qr.verifyUrl).toMatch(/^https:\/\//);
  });
  it('contains no real-looking contact data (only example/invalid/synthetic domains, no 10-digit mobile numbers)', () => {
    const s = JSON.stringify(previewSampleDocument());
    for (const m of s.matchAll(/[\w.+-]+@([\w.-]+)/g)) expect(m[1], m[0]).toMatch(/example|invalid|synthetic|test/i);
    expect(s).not.toMatch(/\b9[78]\d{8}\b/);
  });
  it('returns a fresh object on each call (a preview cannot mutate shared state)', () => {
    const a = previewSampleDocument();
    const b = previewSampleDocument();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
    expect(() => deepFreeze(a)).not.toThrow();
  });
  it('renders through lab-report (letterhead and plain) into a non-empty PDF with the patient block, without external references', async () => {
    for (const variant of ['letterhead', 'plain'] as const) {
      const r = await renderPdf(pool, labReportTemplate, { document: previewSampleDocument(), config: makeConfig(), variant });
      expect(r.pageCount).toBeGreaterThanOrEqual(1);
      expect(r.pages[0]).toContain('Reg No');
      expect(externalRefs(r.html)).toEqual([]);
    }
    expect(externalRefs(labReportTemplate.render({ document: previewSampleDocument(), config: makeConfig(), variant: 'plain', assets: makeAssets().assets }))).toEqual([]);
  });
});
