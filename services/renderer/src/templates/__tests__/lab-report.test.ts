// C6-T07 — lab-report template (04-UI-UX §3). Real Chromium via createPool; assertions on per-page PDF text extraction (02-TRD §14).
// ACs: AC-03.1 (layout/order), AC-03.2 (header+footer every page), AC-03.3 (dates per calendarDisplay), AC-03.5 (watermark every page),
//      AC-03.6 / AC-03.7 (signatories, nominated + disclaimer). Security: 07-SECURITY T8 (SSRF/script/escaping), REQ-SEC-086.
// LD-26 (A33-3): training tenant prints "TRAINING - NOT A VALID REPORT" on every page. LD-27 (A33-4): footer prints "<council> No. <registration_no>".
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPool } from '../../pool.js';
import { labReportTemplate } from '../lab/index.js';
import {
  FIELD_LABELS, HB, SIG_A, SIG_B, bulkBlock, cbcBlock, dept, deepFreeze, esc, externalRefs, hasField, line, makeAssets, makeConfig, makeDoc, renderPdf,
} from './fixtures.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let pool: Awaited<ReturnType<typeof createPool>>;
beforeAll(async () => {
  pool = await createPool({ contexts: 2 });
});
afterAll(async () => {
  await pool?.close();
});
const R = (input: Parameters<typeof renderPdf>[2]) => renderPdf(pool, labReportTemplate, input);
const multi = (over: Record<string, unknown> = {}) => makeDoc({ sections: [dept('HAEMATOLOGY', [cbcBlock(), bulkBlock(140)])], ...over });

describe('module contract (02-TRD §5.3)', () => {
  it('is the lab-report TemplateModule and returns one full static HTML document', () => {
    expect(labReportTemplate.templateId).toBe('lab-report');
    const html = labReportTemplate.render({ document: makeDoc(), config: makeConfig(), variant: 'letterhead', assets: makeAssets().assets });
    expect(html.trimStart().toLowerCase()).toMatch(/^<!doctype html>/);
    expect(html).toMatch(/<meta[^>]+charset=["']?utf-8/i);
  });
  it('is deterministic and pure (same snapshot -> same HTML; frozen input is not mutated)', () => {
    const doc = deepFreeze(makeDoc());
    const cfg = deepFreeze(makeConfig());
    const a = labReportTemplate.render({ document: doc, config: cfg, variant: 'letterhead', assets: makeAssets().assets });
    const b = labReportTemplate.render({ document: doc, config: cfg, variant: 'letterhead', assets: makeAssets().assets });
    expect(b).toBe(a);
  });
  it('emits no script, link, @import, @font-face, event handler or non-data: URL (REQ-SEC-086; fonts are system fonts)', () => {
    const html = labReportTemplate.render({ document: multi(), config: makeConfig(), variant: 'letterhead', assets: makeAssets().assets });
    expect(externalRefs(html)).toEqual([]);
  });
});

describe('AC-03.1 body layout (single page)', () => {
  it('prints package > department > panel > sub-heading > analytes > specimen > approved-by, in order, under the column header', async () => {
    const { pages, pageCount } = await R({ document: makeDoc() });
    expect(pageCount).toBe(1);
    const t = pages[0]!;
    const seq = ['Tests', 'Results', 'Biological Ref Range', 'Units', 'SYNTHETIC HEALTH PACKAGE (BASIC) (MALE)', 'HAEMATOLOGY', 'CBC (Synthetic panel)',
      'RBC parameters', 'Haemoglobin', 'RBC count', 'WBC parameters', 'WBC count', 'Specimen: EDTA WHOLE BLOOD', 'Approved by: Dr. Synthetic Signatory A'];
    let at = -1;
    for (const s of seq) {
      const i = t.indexOf(s, at + 1);
      expect(i, `"${s}" after position ${at} in: ${t}`).toBeGreaterThan(at);
      at = i;
    }
    expect(t).not.toContain('Specimen: Specimen:');
  });
  it('prints each analyte with flag text left of the value, range and unit', async () => {
    const { pages } = await R({ document: makeDoc() });
    const row = pages[0]!.replace('METHOD : Synthetic Photometric Method', ' ');
    expect(row).toMatch(/Haemoglobin\s+High\s+17\.9\s+13\.0 - 17\.0\s+g\/dL/);
    expect(row).toMatch(/RBC count\s+4\.8\s+4\.5 - 5\.9\s+x10\^12\/L/);
  });
  it('prints "METHOD : <name>" under the analyte that has one, and nowhere else', async () => {
    const { pages } = await R({ document: makeDoc() });
    const t = pages[0]!;
    const m = t.indexOf('METHOD : Synthetic Photometric Method');
    expect(m).toBeGreaterThan(t.indexOf('Haemoglobin'));
    expect(m).toBeLessThan(t.indexOf('RBC count'));
    expect(t.match(/METHOD :/g)).toHaveLength(1);
  });
  it('results.show_method_line = false omits METHOD lines', async () => {
    const { pages } = await R({ document: makeDoc(), config: makeConfig({ results: { show_method_line: false } }) });
    expect(pages[0]).not.toContain('METHOD :');
  });
  it('results.show_units_column = false omits the Units column and unit text', async () => {
    const { pages } = await R({ document: makeDoc(), config: makeConfig({ results: { show_units_column: false } }) });
    expect(pages[0]).not.toContain('Units');
    expect(pages[0]).not.toContain('g/dL');
  });
  it('results.group_by_package = false omits the package heading', async () => {
    const { pages } = await R({ document: makeDoc(), config: makeConfig({ results: { group_by_package: false } }) });
    expect(pages[0]).not.toContain('SYNTHETIC HEALTH PACKAGE');
    expect(pages[0]).toContain('CBC (Synthetic panel)');
  });
  it('results.show_department_approved_by = false omits the "Approved by" line', async () => {
    const { pages } = await R({ document: makeDoc(), config: makeConfig({ results: { show_department_approved_by: false } }) });
    expect(pages[0]).not.toContain('Approved by:');
  });
  it('results.page_break_before_department starts the second department on a new page', async () => {
    const doc = makeDoc({ sections: [dept('HAEMATOLOGY', [cbcBlock()]), dept('BIOCHEMISTRY', [{ panelName: 'LIPID (SYNTHETIC)', subgroups: [{ lines: [line(7, { name: 'Cholesterol' })] }], comments: [] }], ['Dr. Synthetic Signatory B'])] });
    const on = await R({ document: doc, config: makeConfig({ results: { page_break_before_department: true } }) });
    expect(on.pageCount).toBeGreaterThanOrEqual(2);
    const p = on.pages.findIndex((x) => x.includes('BIOCHEMISTRY'));
    expect(on.pages[p]).not.toContain('Haemoglobin');
    const off = await R({ document: doc, config: makeConfig({ results: { page_break_before_department: false } }) });
    expect(off.pageCount).toBe(1);
  });
  it('prints panel comments and per-analyte comments as plain text', async () => {
    const b = cbcBlock();
    b.comments = ['Synthetic panel comment.'];
    b.subgroups[0]!.lines = [{ ...HB, comment: 'Synthetic analyte comment.' }];
    const { pages } = await R({ document: makeDoc({ sections: [dept('HAEMATOLOGY', [b])] }) });
    expect(pages[0]).toContain('Synthetic panel comment.');
    expect(pages[0]).toContain('Synthetic analyte comment.');
  });
  it('keeps an analyte with its METHOD line and a panel heading with its first row (CSS break rules, 04-UI-UX §3.2)', () => {
    const html = labReportTemplate.render({ document: makeDoc(), config: makeConfig(), variant: 'letterhead', assets: makeAssets().assets });
    expect(html).toMatch(/break-inside:\s*avoid|page-break-inside:\s*avoid/i);
    expect(html).toMatch(/break-after:\s*avoid|page-break-after:\s*avoid/i);
  });
  it('shows amended / addendum boxes on page 1 and the status label in the header', async () => {
    const am = await R({ document: makeDoc({ reportKind: 'amended', statusLabel: 'Amended', amendmentNotes: [{ analyteOrSection: 'Haemoglobin', previousVersionNo: 2, reasonCode: 'transcription', reasonText: 'Synthetic correction', amendedAt: '2026-11-05T05:00:00Z' }] }) });
    expect(am.pages[0]).toContain('AMENDED REPORT');
    expect(am.pages[0]).toMatch(/replaces version 2 issued/);
    expect(am.pages[0]).toContain('Haemoglobin:');
    expect(hasField(am.pages[0]!, 'Report Status', 'Amended')).toBe(true);
    const ad = await R({ document: makeDoc({ reportKind: 'addendum', statusLabel: 'Addendum', amendmentNotes: [{ analyteOrSection: 'Addendum', previousVersionNo: 1, reasonCode: 'addendum', amendedAt: '2026-11-05T05:00:00Z' }] }) });
    expect(ad.pages[0]).toContain('ADDENDUM');
    expect(ad.pages[0]).toContain('The original findings are not changed.');
    expect(ad.pages[0]).not.toContain('AMENDED REPORT');
  });
  it('page.size Letter / A4 sets the PDF page box', async () => {
    const box = (pdf: Uint8Array) => /\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)/.exec(Buffer.from(pdf).toString('latin1'))!.slice(1).map(Number);
    const a4 = await R({ document: makeDoc() });
    const lt = await R({ document: makeDoc(), config: makeConfig({ page: { size: 'Letter' } }) });
    expect(box(a4.pdf)[0]).toBeCloseTo(595.3, 0);
    expect(box(lt.pdf)).toEqual([612, 792]);
  });
  it('applies page margins from the config to the @page rule', () => {
    const html = labReportTemplate.render({ document: makeDoc(), config: makeConfig({ page: { margin_mm: { top: 23, bottom: 27, left: 13, right: 11 } } }), variant: 'letterhead', assets: makeAssets().assets });
    const page = /@page\s*\{[^}]*\}/.exec(html)?.[0] ?? '';
    for (const mm of ['23mm', '27mm', '13mm', '11mm']) expect(page, mm).toContain(mm);
  });
  it('applies fonts.base_pt', () => {
    const html = labReportTemplate.render({ document: makeDoc(), config: makeConfig({ fonts: { base_pt: 11 } }), variant: 'letterhead', assets: makeAssets().assets });
    expect(html).toMatch(/11pt/);
  });
});

describe('AC-03.2 header block and footer on every page', () => {
  it('a multi-page report repeats the patient block, column header and footer on every page', async () => {
    const { pages, pageCount } = await R({ document: multi() });
    expect(pageCount).toBeGreaterThanOrEqual(3);
    expect(pages).toHaveLength(pageCount);
    for (const [i, p] of pages.entries()) {
      const at = `page ${i + 1}`;
      for (const [label, value] of [['Name', 'Test Patient 0042'], ['Age/Gender', '43 Years/MALE'], ['Reg No', '0001SY000001'], ['Barcode No', 'E2600000042'],
        ['Referred By', 'SELF'], ['Report Status', 'Final'], ['Sample Collected At', 'C000000099-SYNTHETIC CENTRE NINETY-NINE']] as const)
        expect(hasField(p, label, value), `${at} ${label}`).toBe(true);
      for (const l of ['Sample Coll Dt', 'Sample Rcv Dt', 'Reg Date', 'Reported Date']) expect(p, `${at} ${l}`).toContain(l);
      expect(p, `${at} column header`).toContain('Biological Ref Range');
      for (const s of ['Dr. Synthetic Signatory A', 'Dr. Synthetic Signatory B', 'Synthetic disclaimer line one.', 'Synthetic disclaimer line two.',
        'labmail@synthetic.example', 'Tel: +977-1-0000000', 'www.synthetic.example', 'Scan to verify']) expect(p, `${at} footer "${s}"`).toContain(s);
    }
  });
  it('prints all 11 header field labels on page 1 and leaves "Page N Of M" to the sandbox', async () => {
    const { pages } = await R({ document: multi() });
    for (const l of FIELD_LABELS) expect(pages[0], l).toContain(l);
    for (const p of pages) expect(p).not.toMatch(/Page\s+\d+\s+Of\s+\d+/i);
  });
  it('lists up to 3 barcodes then "+n" (header.barcodeNos as given)', async () => {
    const doc = makeDoc();
    doc.header.barcodeNos = ['E01', 'E02', 'E03', '+2'];
    const { pages } = await R({ document: doc });
    expect(pages[0]).toMatch(/E01.*E02.*E03.*\+2/);
  });
  it('an absent sampleCollectedAt / sampleReceivedAt never prints undefined, null, NaN or Invalid', async () => {
    const doc = makeDoc();
    delete doc.header.sampleCollectedAt;
    delete doc.header.sampleReceivedAt;
    const { pages } = await R({ document: doc });
    expect(pages[0]).not.toMatch(/undefined|null|NaN|Invalid/i);
  });
});

describe('AC-03.3 dates per calendarDisplay (Asia/Kathmandu, golden per mode)', () => {
  // 2026-11-05T04:45Z = 10:30 AM +05:45 = 2083-07-19 B.S. (adToBs); 2026-11-04T18:20Z = 05/11/2026 12:05 AM local (UTC date is the 4th).
  const GOLD: Record<string, { reported: string; midnight: string }> = {
    AD: { reported: '05/11/2026 10:30 AM', midnight: '05/11/2026 12:05 AM' },
    AD_BS: { reported: '05/11/2026 10:30 AM (2083-07-19 B.S.)', midnight: '05/11/2026 12:05 AM (2083-07-19 B.S.)' },
    BS: { reported: '2083-07-19 B.S. 10:30 AM', midnight: '2083-07-19 B.S. 12:05 AM' },
    BS_AD: { reported: '2083-07-19 B.S. 10:30 AM (05/11/2026)', midnight: '2083-07-19 B.S. 12:05 AM (05/11/2026)' },
  };
  for (const mode of Object.keys(GOLD)) {
    it(`${mode}`, async () => {
      const doc = makeDoc({ calendarDisplay: mode });
      doc.header.sampleCollectedAt = '2026-11-04T18:20:00Z';
      const { pages } = await R({ document: doc });
      const g = GOLD[mode]!;
      expect(hasField(pages[0]!, 'Reported Date', g.reported), `Reported Date ${g.reported} in ${pages[0]}`).toBe(true);
      expect(hasField(pages[0]!, 'Sample Coll Dt', g.midnight), `Sample Coll Dt ${g.midnight}`).toBe(true);
      if (mode === 'AD') expect(pages[0]).not.toContain('B.S.');
      // 08:10 AM/08:40 AM/08:02 AM come from 02:25Z/02:55Z/02:17Z
      expect(pages[0]).toContain('08:40 AM');
      expect(pages[0]).toContain('08:02 AM');
    });
  }
  it('the configured timezone, not the host zone, decides the printed time', async () => {
    const doc = makeDoc();
    doc.header.reportedAt = '2026-11-05T23:30:00Z'; // 2026-11-06 05:15 AM Kathmandu
    const { pages } = await R({ document: doc });
    expect(hasField(pages[0]!, 'Reported Date', '06/11/2026 05:15 AM')).toBe(true);
  });
});

describe('AC-03.5 watermark on every page; LD-26 training watermark', () => {
  const wm = (text: string, opacity = 0.12) => ({ watermark: { text, opacity } });
  it('config watermark text appears on every page of a multi-page report', async () => {
    const { pages, pageCount } = await R({ document: multi(), config: makeConfig(wm('WMKSAMPLE')) });
    expect(pageCount).toBeGreaterThanOrEqual(3);
    for (const [i, p] of pages.entries()) expect(p, `page ${i + 1}`).toContain('WMKSAMPLE');
  });
  it('no watermark configured -> none printed', async () => {
    const { pages } = await R({ document: multi() });
    for (const p of pages) expect(p).not.toContain('WMKSAMPLE');
  });
  it('is fixed, centred, rotated -30deg, 48pt, with the configured opacity (04-UI-UX §3.2; DECISIONS.md)', () => {
    const html = labReportTemplate.render({ document: makeDoc(), config: makeConfig(wm('WMKSAMPLE', 0.12)), variant: 'letterhead', assets: makeAssets().assets });
    expect(html).toMatch(/position:\s*fixed/);
    expect(html).toMatch(/rotate\(\s*-30deg\s*\)/);
    expect(html).toMatch(/48pt/);
    expect(html).toMatch(/opacity:\s*0?\.12/);
  });
  it('watermark text is escaped, never markup', async () => {
    const html = labReportTemplate.render({ document: makeDoc(), config: makeConfig(wm('A<script>x</script>B')), variant: 'letterhead', assets: makeAssets().assets });
    expect(html).not.toMatch(/<script/i);
    const { pages } = await R({ document: makeDoc(), config: makeConfig(wm('A<b>B</b>')) });
    expect(pages[0]).toContain('A<b>B</b>');
  });
  it('LD-26: trainingMode prints "TRAINING - NOT A VALID REPORT" on every page, also in the plain variant', async () => {
    for (const variant of ['letterhead', 'plain'] as const) {
      const { pages, pageCount } = await R({ document: multi(), variant, trainingMode: true });
      expect(pageCount).toBeGreaterThanOrEqual(3);
      for (const [i, p] of pages.entries()) expect(p, `${variant} page ${i + 1}`).toContain('TRAINING - NOT A VALID REPORT');
    }
  });
  it('LD-26: training watermark is added on top of a configured watermark, and absent for normal tenants', async () => {
    const both = await R({ document: multi(), config: makeConfig(wm('WMKSAMPLE')), trainingMode: true });
    for (const p of both.pages) expect(p).toContain('TRAINING - NOT A VALID REPORT');
    const none = await R({ document: multi() });
    for (const p of none.pages) expect(p).not.toContain('TRAINING');
    const off = await R({ document: makeDoc(), trainingMode: false });
    expect(off.pages[0]).not.toContain('TRAINING');
  });
});

describe('AC-03.6 / AC-03.7 / LD-27 signatories', () => {
  it('approvers: both names, titles, "<council> No. <registration_no>" lines and signature images (every page)', async () => {
    const mk = makeAssets();
    const { pages, pageCount } = await R({ document: multi(), assets: mk.assets });
    expect(pageCount).toBeGreaterThanOrEqual(3);
    for (const [i, p] of pages.entries()) {
      for (const s of ['Dr. Synthetic Signatory A', 'MD Pathology', 'NMC No. NMC-SYN-0001', 'Dr. Synthetic Signatory B', 'Consultant Pathologist', 'NHPC No. NHPC-SYN-0002'])
        expect(p, `page ${i + 1} "${s}"`).toContain(s);
      expect(p, `page ${i + 1}`).not.toContain('NMC No. NHPC-SYN-0002');
    }
    expect(mk.calls.filter((c) => c.source === 'signature').map((c) => c.id).sort()).toEqual(expect.arrayContaining(['sigA', 'sigB']));
  });
  it('LD-27: the label comes from the signatory council, not a fixed "NMC No."', async () => {
    const only = { ...SIG_B, registrationNo: 'NHPC-LAB-77' };
    const { pages } = await R({ document: makeDoc({ signatories: [only] }) });
    expect(pages[0]).toContain('NHPC No. NHPC-LAB-77');
    expect(pages[0]).not.toContain('NMC No.');
  });
  it('LD-27: a profile without council prints name + title only (no number, no "No." label)', async () => {
    const orphan = { ...SIG_A, council: undefined, registrationNo: 'ORPHAN-REG-1' };
    const { pages } = await R({ document: makeDoc({ signatories: [orphan] }) });
    expect(pages[0]).toContain('Dr. Synthetic Signatory A');
    expect(pages[0]).toContain('MD Pathology');
    expect(pages[0]).not.toContain('ORPHAN-REG-1');
    expect(pages[0]).not.toMatch(/\bNo\.\s/);
  });
  it('a signatory with no signature image prints name + title and asks the resolver for nothing', async () => {
    const mk = makeAssets();
    const noImg = { ...SIG_B, signatureAssetRef: undefined };
    const { pages } = await R({ document: makeDoc({ signatories: [SIG_A, noImg] }), assets: mk.assets });
    expect(pages[0]).toContain('Dr. Synthetic Signatory B');
    expect(pages[0]).toContain('Consultant Pathologist');
    expect(mk.calls.filter((c) => c.source === 'signature').map((c) => c.id)).toEqual(['sigA']);
  });
  it('signatories.show_signature_images = false never resolves signature assets', async () => {
    const mk = makeAssets();
    const { pages } = await R({ document: makeDoc(), config: makeConfig({ signatories: { show_signature_images: false } }), assets: mk.assets });
    expect(mk.calls.filter((c) => c.source === 'signature')).toEqual([]);
    expect(pages[0]).toContain('Dr. Synthetic Signatory A');
  });
  it('signature images are bounded to 30 x 12 mm (aspect preserved)', () => {
    const html = labReportTemplate.render({ document: makeDoc(), config: makeConfig(), variant: 'letterhead', assets: makeAssets().assets });
    expect(html).toMatch(/30mm/);
    expect(html).toMatch(/12mm/);
    expect(html).toMatch(/object-fit:\s*contain|max-width:\s*30mm/);
  });
  it('signatories.max caps the footer (3 given, max 2 -> third not printed)', async () => {
    const third = { ...SIG_A, membershipId: '018f0000-0000-7000-8000-00000000000c', displayName: 'Dr. Synthetic Signatory C', registrationNo: 'NMC-SYN-0003', signatureAssetRef: undefined };
    const { pages } = await R({ document: makeDoc({ signatories: [SIG_A, SIG_B, third] }), config: makeConfig({ signatories: { max: 2 } }) });
    expect(pages[0]).not.toContain('Dr. Synthetic Signatory C');
    const four = await R({ document: makeDoc({ signatories: [SIG_A, SIG_B, third] }), config: makeConfig({ signatories: { max: 3 } }) });
    expect(four.pages[0]).toContain('Dr. Synthetic Signatory C');
  });
  it('nominated mode: nominated signatories print with the Lab Director disclaimer; approvers stay in the department "Approved by" line', async () => {
    const nom = { ...SIG_B, role: 'nominated' };
    const doc = makeDoc({
      signatories: [nom],
      disclaimers: ['Authorized signatory nominated by Lab Director', 'Synthetic disclaimer line two.'],
    });
    const { pages } = await R({ document: multi({ signatories: doc.signatories, disclaimers: doc.disclaimers }), config: makeConfig({ signatories: { mode: 'nominated' } }) });
    for (const [i, p] of pages.entries()) {
      expect(p, `page ${i + 1}`).toContain('Authorized signatory nominated by Lab Director');
      expect(p, `page ${i + 1}`).toContain('NHPC No. NHPC-SYN-0002');
    }
    expect(pages.at(-1)).toContain('Approved by: Dr. Synthetic Signatory A');
    expect(pages.join('').split('Approved by: Dr. Synthetic Signatory A').length - 1).toBe(1);
  });
  it('prints at most 5 disclaimer lines', async () => {
    const d = Array.from({ length: 6 }, (_, i) => `Synthetic disclaimer ${i + 1}.`);
    const { pages } = await R({ document: makeDoc({ disclaimers: d }) });
    for (let i = 1; i <= 5; i++) expect(pages[0]).toContain(`Synthetic disclaimer ${i}.`);
    expect(pages[0]).not.toContain('Synthetic disclaimer 6.');
  });
  it('contact_strip_extra is printed in the footer when configured', async () => {
    const { pages } = await R({ document: makeDoc(), config: makeConfig({ contact_strip_extra: 'Synthetic extra contact line' }) });
    expect(pages[0]).toContain('Synthetic extra contact line');
  });
});

describe('QR (C0-pinned encoder; 04-UI-UX §3.2)', () => {
  const qrImgs = (html: string) => [...html.matchAll(/<img\b[^>]*>/gi)].map((m) => m[0]).filter((t) => /data:image\/(svg\+xml|png)/i.test(t) && /qr/i.test(t));
  it('draws the verify URL as an inline data: image with the caption, sized by qr.size_mm, once per page footer', async () => {
    const { html, pages } = await R({ document: multi(), config: makeConfig({ qr: { size_mm: 28 } }) });
    expect(qrImgs(html).length).toBeGreaterThan(0);
    expect(html).toMatch(/28mm/);
    for (const p of pages) expect(p).toContain('Scan to verify');
  });
  it('is deterministic per URL and differs between URLs; the token is never printed as text', async () => {
    const mk = (u: string) => labReportTemplate.render({ document: makeDoc({ qr: { verifyUrl: u } }), config: makeConfig(), variant: 'letterhead', assets: makeAssets().assets });
    const a1 = mk('https://portal.example.invalid/v/AbCdEfGhIjKlMnOpQrStUv');
    const a2 = mk('https://portal.example.invalid/v/AbCdEfGhIjKlMnOpQrStUv');
    const b = mk('https://portal.example.invalid/v/ZzCdEfGhIjKlMnOpQrStUv');
    expect(a1).toBe(a2);
    expect(b).not.toBe(a1);
    expect(a1).not.toContain('AbCdEfGhIjKlMnOpQrStUv');
    const { pages } = await R({ document: makeDoc() });
    expect(pages[0]).not.toContain('AbCdEfGhIjKlMnOpQrStUv');
  });
  it('qr.enabled = false omits the QR and its caption', async () => {
    const { html, pages } = await R({ document: makeDoc(), config: makeConfig({ qr: { enabled: false } }) });
    expect(pages[0]).not.toContain('Scan to verify');
    expect(qrImgs(html)).toEqual([]);
  });
  it('a custom caption replaces the default', async () => {
    const { pages } = await R({ document: makeDoc(), config: makeConfig({ qr: { caption: 'Synthetic verify caption' } }) });
    expect(pages[0]).toContain('Synthetic verify caption');
    expect(pages[0]).not.toContain('Scan to verify');
  });
});

describe('security: untrusted text is escaped, nothing reaches the network (07-SECURITY T8, A11; REQ-SEC-086)', () => {
  const EVIL = '<script>alert(1)</script><img src="http://169.254.169.254/x" onerror="alert(2)">';
  it('escapes every document string field and the output has no live markup or external reference', async () => {
    const before = pool.stats().blockedRequests;
    const doc = makeDoc();
    doc.header.patientName = EVIL;
    doc.header.referredBy = EVIL;
    doc.header.collectedAtCentre = { code: 'C1', name: EVIL, addressText: EVIL };
    doc.lab.displayName = EVIL;
    doc.lab.contactStrip = [EVIL];
    doc.disclaimers = [EVIL];
    doc.signatories = [{ ...SIG_A, displayName: EVIL, displayTitle: EVIL, registrationNo: EVIL }];
    doc.sections = [dept(EVIL, [{ packageName: EVIL, panelName: EVIL, subgroups: [{ subheading: EVIL, lines: [line(1, { name: EVIL, valueText: EVIL, refRangeText: EVIL, unitText: EVIL, methodLine: `METHOD : ${EVIL}`, comment: EVIL })] }], specimenLine: EVIL, comments: [EVIL] }], [EVIL])];
    doc.qr = { verifyUrl: `https://portal.example.invalid/v/${EVIL}` };
    const { html, pages } = await R({ document: doc, config: makeConfig({ contact_strip_extra: EVIL, qr: { caption: EVIL }, watermark: { text: EVIL, opacity: 0.1 } }) });
    expect(externalRefs(html)).toEqual([]);
    expect(pages[0]).toContain('<script>alert(1)</script>'); // literal text
    expect(pool.stats().blockedRequests).toBe(before); // nothing even tried to leave
  });
  it('a javascript:/http: looking asset id or mime type from the snapshot never becomes a URL (resolver output is the only src)', () => {
    const doc = makeDoc();
    doc.lab.headerAssetRef = { source: 'branding', id: 'http://169.254.169.254/latest', sha256: 'a'.repeat(64), mimeType: 'image/png' };
    const html = labReportTemplate.render({ document: doc, config: makeConfig(), variant: 'letterhead', assets: makeAssets().assets });
    expect(externalRefs(html)).toEqual([]);
    expect(html).not.toContain('169.254.169.254');
  });
  it('Devanagari and very long unbroken text still render a PDF', async () => {
    const doc = makeDoc();
    doc.header.patientName = 'परीक्षण बिरामी';
    doc.header.referredBy = 'X'.repeat(300);
    const { pageCount } = await R({ document: doc });
    expect(pageCount).toBeGreaterThanOrEqual(1);
  });
});

describe('sanity of the fixtures (guards against vacuous passes)', () => {
  it('the multi-page fixture really spans several pages and the single-page one spans one', async () => {
    expect((await R({ document: multi() })).pageCount).toBeGreaterThanOrEqual(3);
    expect((await R({ document: makeDoc() })).pageCount).toBe(1);
    expect(esc('a.b')).toBe('a\\.b');
  });
});
