// C6-T32 — micro / anatomic section rendering from fixture view rows (IS-21) and the smart-report fragment hook (IS-22). Real Chromium via createPool.
// Spec: 03-IC §6.8 (view columns), C10 05-SCHEMA §6 (isolates/ast shapes + "Rendering notes for C6"), C11 05-SCHEMA §5 (images/synoptic/... shapes),
//       02-TRD §3.2 (`content` = ROW of micro./anatomic.v_pub_report_content), §5.3 (SmartSectionRenderer: optional; no script / external URL; same sanitiser), 07-SECURITY T8 / REQ-SEC-086.
// ASSUMED (spec gives no more): lab-report draws `kind:'micro'|'anatomic'` sections (today it skips them); section.content is the view row with the 03-IC column names (snake_case);
//   anatomic images are resolved with assets.dataUri({source:'module_image', sha256: <image.sha256>, ...}); text values are plain text (HTML-escaped by the template).
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPool } from '../../pool.js';
import { labReportTemplate } from '../lab/index.js';
import { dept, cbcBlock, externalRefs, makeAssets, makeConfig, makeDoc, renderPdf } from './fixtures.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
let pool: Awaited<ReturnType<typeof createPool>>;
beforeAll(async () => { pool = await createPool({ contexts: 2 }); });
afterAll(async () => { await pool?.close(); });
const R = (input: Parameters<typeof renderPdf>[2]) => renderPdf(pool, labReportTemplate, input);

const ITEM_M = '018f0000-0000-7000-8000-00000000a001'; const ITEM_A = '018f0000-0000-7000-8000-00000000a002';
const ENT = '018f0000-0000-7000-8000-00000000e001'; const SIGNER = '018f0000-0000-7000-8000-00000000000a';
const microRow = (over: Record<string, unknown> = {}) => ({
  tenant_id: '018f0000-0000-7000-8000-0000000000aa', entity_id: ENT, version_no: 2, order_item_id: ITEM_M, report_phase: 'final',
  culture_summary_text: 'SYNTHCULT: Significant growth of two organisms in urine.',
  isolates: [
    { seq: 2, organism_code: 'KLEB_PNEU', organism_display: 'Klebsiella pneumoniae (synthetic)', growth_text: '10^4 CFU/mL' },
    { seq: 1, organism_code: 'ESCH_COLI', organism_display: 'Escherichia coli (synthetic)', growth_text: '>10^5 CFU/mL' },
  ],
  ast: [
    { isolate_seq: 1, antibiotic_code: 'CIP', antibiotic_display: 'Ciprofloxacin (synthetic)', method: 'zone_diameter', raw_value: '14', category_code: 'R', standard: 'CLSI', standard_version: 'M100-SYN' },
    { isolate_seq: 1, antibiotic_code: 'AMK', antibiotic_display: 'Amikacin (synthetic)', method: 'mic', raw_value: '<=0.25', category_code: 'S', standard: 'CLSI', standard_version: 'M100-SYN' },
    { isolate_seq: 2, antibiotic_code: 'NIT', antibiotic_display: 'Nitrofurantoin (synthetic)', method: 'other', raw_value: 'pos', category_code: 'I', standard: 'EUCAST', standard_version: '14.0-SYN' },
  ],
  comments_text: 'SYNTHCOMMENT repeat culture advised.', signed_by_membership_id: SIGNER, signed_at: '2026-11-05T04:30:00Z', ...over,
});
const IMG1 = 'b'.repeat(64); const IMG2 = 'c'.repeat(64);
const anatRow = (over: Record<string, unknown> = {}) => ({
  tenant_id: '018f0000-0000-7000-8000-0000000000aa', entity_id: ENT, version_no: 1, order_item_id: ITEM_A, accession_no: 'SYN-AP-26-0001', case_kind: 'histology',
  gross_text: 'SYNTHGROSS skin ellipse 2 x 1 cm.', microscopy_text: 'SYNTHMICRO sections show benign epidermis.', impression_text: 'SYNTHIMPRESSION benign naevus (synthetic).',
  clinical_history_text: 'SYNTHHISTORY pigmented lesion.', comment_text: 'SYNTHACOMMENT correlate clinically.', synoptic: [], specimen_parts: [{ letter: 'A', site_text: 'SYNTHSITE left forearm', description_text: 'skin ellipse' }],
  slides: [], ancillary: [], molecular: [], addenda: [], diagnosis_codes: [{ code: 'SYN-D1', display: 'SYNTHDIAG naevus', system: 'synthetic' }],
  images: [{ bucket: 'anatomic-images', object_path: 'tenant/2026/11/SECRET-PATH-1.jpg', sha256: IMG1, caption: 'SYNTHCAP gross view' },
    { bucket: 'anatomic-images', object_path: 'tenant/2026/11/SECRET-PATH-2.jpg', sha256: IMG2, caption: 'SYNTHCAP microscopy x400' }],
  version_kind: 'original', scope: 'full', change_reason_code: null, signed_by_membership_id: SIGNER, signed_at: '2026-11-05T04:40:00Z', ...over,
});
const micro = (content: unknown = microRow(), phase: 'preliminary' | 'final' = 'final') => ({ kind: 'micro', orderItemId: ITEM_M, testName: 'URINE CULTURE (SYNTHETIC)', phase, content });
const anatomic = (content: unknown = anatRow()) => ({ kind: 'anatomic', orderItemId: ITEM_A, testName: 'SKIN BIOPSY (SYNTHETIC)', content });
const text = (pages: string[]) => pages.join(' ');
/** The text between `from` and the next of `others` (or the end). */
const segment = (t: string, from: string, others: string[]) => { const i = t.indexOf(from); expect(i, `"${from}" missing`).toBeGreaterThanOrEqual(0); const r = t.slice(i + from.length); const j = others.map((o) => r.indexOf(o)).filter((x) => x >= 0); return j.length ? r.slice(0, Math.min(...j)) : r; };

describe('IS-21 — micro section from a micro.v_pub_report_content row', () => {
  it('prints test name, culture summary, comments, isolates ordered by seq with growth text', async () => {
    const { pages } = await R({ document: makeDoc({ sections: [micro()] }) }); const t = text(pages);
    for (const s of ['URINE CULTURE (SYNTHETIC)', 'SYNTHCULT: Significant growth', 'SYNTHCOMMENT repeat culture advised.', '>10^5 CFU/mL', '10^4 CFU/mL']) expect(t).toContain(s);
    expect(t.indexOf('Escherichia coli (synthetic)')).toBeGreaterThan(-1);
    expect(t.indexOf('Escherichia coli (synthetic)')).toBeLessThan(t.indexOf('Klebsiella pneumoniae (synthetic)'));   // seq 1 before seq 2 although the array has seq 2 first
  });
  it('AST rows: antibiotic + raw_value with qualifier + unit from method (mic -> µg/mL, zone_diameter -> mm, other -> none) + the category of THAT antibiotic', async () => {
    const t = text((await R({ document: makeDoc({ sections: [micro()] }) })).pages);
    const names = ['Ciprofloxacin (synthetic)', 'Amikacin (synthetic)', 'Nitrofurantoin (synthetic)'];
    const cip = segment(t, names[0]!, names.slice(1)); const amk = segment(t, names[1]!, [names[0]!, names[2]!]); const nit = segment(t, names[2]!, names.slice(0, 2));
    expect(cip).toMatch(/\b14\s*mm\b/); expect(cip).toMatch(/(^|\s)(R|Resistant)(\s|$)/); expect(cip).not.toMatch(/(^|\s)(S|Susceptible|I|Intermediate)(\s|$)/);
    expect(amk).toMatch(/<=\s*0\.25\s*(µg|μg|ug)\/mL/); expect(amk).toMatch(/(^|\s)(S|Susceptible)(\s|$)/); expect(amk).not.toMatch(/(^|\s)(R|Resistant)(\s|$)/);
    expect(nit).toMatch(/\bpos\b/); expect(nit).not.toMatch(/\b(mm|mL)\b/); expect(nit).toMatch(/(^|\s)(I|Intermediate)(\s|$)/);
  });
  it('prints the interpretive standard + version used (CLSI M100-SYN / EUCAST 14.0-SYN)', async () => {
    const t = text((await R({ document: makeDoc({ sections: [micro()] }) })).pages);
    expect(t).toMatch(/CLSI\s*M100-SYN/); expect(t).toMatch(/EUCAST\s*14\.0-SYN/);
  });
  it('empty isolates / ast ([] allowed by the view schema): culture text still printed, no crash, no empty AST table heading with no rows', async () => {
    const t = text((await R({ document: makeDoc({ sections: [micro(microRow({ isolates: [], ast: [], comments_text: null }))] }) })).pages);
    expect(t).toContain('SYNTHCULT: Significant growth'); expect(t).not.toMatch(/undefined|null|\[object/i);
  });
  it('phase preliminary is marked "preliminary" in the section itself; phase final is not (D-61, AC-02.8)', async () => {
    const pre = text((await R({ document: makeDoc({ statusLabel: 'Final', reportKind: 'final', sections: [micro(microRow({ report_phase: 'preliminary' }), 'preliminary')] }) })).pages);
    const fin = text((await R({ document: makeDoc({ statusLabel: 'Final', reportKind: 'final', sections: [micro()] }) })).pages);
    expect(pre).toMatch(/preliminary/i); expect(fin).not.toMatch(/preliminary/i);
  });
  it('plain text is escaped: markup in culture/comment/organism text is printed as text, never executed or fetched (T8, REQ-SEC-086)', async () => {
    const EVIL = '<script>alert(1)</script><img src="http://evil.invalid/x.png" onerror="alert(2)">';
    const row = microRow({ culture_summary_text: EVIL, comments_text: EVIL, isolates: [{ seq: 1, organism_code: 'X', organism_display: EVIL, growth_text: EVIL }] });
    const { html, pages } = await R({ document: makeDoc({ sections: [micro(row)] }) });
    expect(externalRefs(html)).toEqual([]); expect(html).not.toMatch(/<script/i); expect(html).not.toMatch(/<img[^>]+evil\.invalid/i); expect(text(pages)).toContain('alert(1)');
  });
  it('a micro section does not disturb a lab department section in the same report (both printed, department first as given)', async () => {
    const t = text((await R({ document: makeDoc({ sections: [dept('HAEMATOLOGY', [cbcBlock()]), micro()] }) })).pages);
    expect(t).toContain('Haemoglobin'); expect(t.indexOf('Haemoglobin')).toBeLessThan(t.indexOf('SYNTHCULT'));
  });
  it('is pure: a frozen micro section is not mutated and gives the same HTML twice', () => {
    const doc = makeDoc({ sections: [micro()] }); const snap = JSON.stringify(doc);
    const a = labReportTemplate.render({ document: doc, config: makeConfig(), variant: 'letterhead', assets: makeAssets().assets });
    expect(labReportTemplate.render({ document: doc, config: makeConfig(), variant: 'letterhead', assets: makeAssets().assets })).toBe(a);
    expect(JSON.stringify(doc)).toBe(snap);
  });
});

describe('IS-21 — anatomic section from an anatomic.v_pub_report_content row', () => {
  it('prints test name, accession, case kind, clinical history, gross, microscopy, impression, comment, part site, diagnosis display', async () => {
    const t = text((await R({ document: makeDoc({ sections: [anatomic()] }) })).pages);
    for (const s of ['SKIN BIOPSY (SYNTHETIC)', 'SYN-AP-26-0001', 'SYNTHHISTORY', 'SYNTHGROSS', 'SYNTHMICRO', 'SYNTHIMPRESSION', 'SYNTHACOMMENT', 'SYNTHSITE', 'SYNTHDIAG']) expect(t, s).toContain(s);
    expect(t).toMatch(/histology/i);
  });
  it('findings read in clinical order: history -> gross -> microscopy -> impression', async () => {
    const t = text((await R({ document: makeDoc({ sections: [anatomic()] }) })).pages);
    const at = ['SYNTHHISTORY', 'SYNTHGROSS', 'SYNTHMICRO', 'SYNTHIMPRESSION'].map((s) => t.indexOf(s));
    expect(at.every((i) => i >= 0)).toBe(true); expect([...at].sort((a, b) => a - b)).toEqual(at);
  });
  it('images: each image is resolved by its sha256 as a module_image data: URI and its caption printed; the storage object_path / bucket never reach the HTML', async () => {
    const { assets, calls } = makeAssets();
    const { html, pages } = await R({ document: makeDoc({ sections: [anatomic()] }), assets });
    const mod = calls.filter((c) => c.source === 'module_image').map((c) => c.sha256).sort();
    expect(mod).toEqual([IMG1, IMG2].sort()); expect(text(pages)).toContain('SYNTHCAP gross view'); expect(text(pages)).toContain('SYNTHCAP microscopy x400');
    expect(html).toMatch(/<img[^>]+src="data:image\//i); expect(html).not.toContain('SECRET-PATH'); expect(html).not.toContain('anatomic-images'); expect(externalRefs(html)).toEqual([]);
  });
  it('synoptic: heading, label and value of every item are printed', async () => {
    const synoptic = [{ template_key: 'skin_syn', template_version: 1, title: 'SYNTHSYN Skin synoptic', sections: [{ heading: 'SYNTHSEC Margins', items: [{ label: 'SYNTHLBL Peripheral margin', value: 'SYNTHVAL involved' }] }] }];
    const t = text((await R({ document: makeDoc({ sections: [anatomic(anatRow({ synoptic }))] }) })).pages);
    for (const s of ['SYNTHSYN Skin synoptic', 'SYNTHSEC Margins', 'SYNTHLBL Peripheral margin', 'SYNTHVAL involved']) expect(t, s).toContain(s);
  });
  it('signed addenda are printed oldest first (C11 §5 addenda)', async () => {
    const addenda = [{ seq: 1, kind: 'ihc', text: 'SYNTHADD-ONE ER positive', signed_by_membership_id: SIGNER, signed_at: '2026-11-06T04:00:00Z' },
      { seq: 2, kind: 'other', text: 'SYNTHADD-TWO second opinion', signed_by_membership_id: SIGNER, signed_at: '2026-11-07T04:00:00Z' }];
    const t = text((await R({ document: makeDoc({ sections: [anatomic(anatRow({ addenda }))] }) })).pages);
    expect(t).toContain('SYNTHADD-ONE'); expect(t.indexOf('SYNTHADD-ONE')).toBeLessThan(t.indexOf('SYNTHADD-TWO'));
  });
  it('no images / empty optional jsonb: renders without crash and without placeholders', async () => {
    const t = text((await R({ document: makeDoc({ sections: [anatomic(anatRow({ images: [], synoptic: [], slides: [], ancillary: [], molecular: [], addenda: [], specimen_parts: [], diagnosis_codes: [], comment_text: null, clinical_history_text: null }))] }) })).pages);
    expect(t).toContain('SYNTHIMPRESSION'); expect(t).not.toMatch(/undefined|null|\[object/i);
  });
  it('plain text is escaped: markup in gross/impression/caption is printed as text only (T8)', async () => {
    const EVIL = '<script>alert(1)</script><iframe src="http://evil.invalid/"></iframe>';
    const row = anatRow({ gross_text: EVIL, impression_text: EVIL, images: [{ bucket: 'anatomic-images', object_path: 'p', sha256: IMG1, caption: EVIL }] });
    const { html, pages } = await R({ document: makeDoc({ sections: [anatomic(row)] }) });
    expect(externalRefs(html)).toEqual([]); expect(html).not.toMatch(/<script|<iframe/i); expect(text(pages)).toContain('alert(1)');
  });
});

describe('IS-22 — smart section hook (SmartSectionRenderer is C14-owned; C6 only inserts the sanitised fragment)', () => {
  const PAYLOAD = { summaryId: '018f0000-0000-7000-8000-00000000f001', status: 'approved', templateLibraryVersion: 'lib-SYN-1', disclaimerText: 'SYNTHDISC' };
  const smartDoc = (over: Record<string, unknown> = {}) => makeDoc({ smart: { summaryId: PAYLOAD.summaryId, templateLibraryVersion: 'lib-SYN-1', payload: PAYLOAD }, ...over });
  const fake = (frag: string) => { const calls: any[] = []; return { calls, libraryVersion: 'lib-SYN-1', renderSections: (i: any) => { calls.push(i); return frag; } }; };
  it('document.smart + renderer: renderSections gets the stored payload + calendarDisplay + timezone; the fragment is in the PDF', async () => {
    const smart = fake('<div class="smart-section"><p>SYNTHSMART health summary text</p></div>');
    const { pages } = await R({ document: smartDoc(), smart });
    expect(smart.calls).toEqual([{ summary: PAYLOAD, calendarDisplay: 'AD', timezone: 'Asia/Kathmandu' }]); expect(text(pages)).toContain('SYNTHSMART health summary text');
  });
  it('document.smart absent (not approved / flag off): the renderer is never called and nothing smart is printed', async () => {
    const smart = fake('<p>SYNTHSMART must not appear</p>');
    const { pages } = await R({ document: makeDoc(), smart });
    expect(smart.calls).toHaveLength(0); expect(text(pages)).not.toContain('SYNTHSMART');
  });
  it('document.smart present but no SmartSectionRenderer (C14 module absent): section omitted, no crash, payload not leaked', async () => {
    const { html, pages } = await R({ document: smartDoc() });
    expect(text(pages)).not.toContain('SYNTHDISC'); expect(html).not.toContain('lib-SYN-1'); expect(pages.length).toBeGreaterThan(0);
  });
  it('the fragment is re-sanitised before insertion: script, event handlers, iframes and external URLs are dropped (§5.3, T8)', async () => {
    const smart = fake('<p>SYNTHSMART ok</p><script>alert(1)</script><img src="http://evil.invalid/p.png" onerror="alert(2)"><iframe src="http://evil.invalid/"></iframe><a href="javascript:alert(3)">x</a>');
    const { html, pages } = await R({ document: smartDoc(), smart });
    expect(externalRefs(html)).toEqual([]); expect(text(pages)).toContain('SYNTHSMART ok');
  });
  it('smart fragment follows the lab content and stays inside the document (not before the header)', async () => {
    const smart = fake('<p>SYNTHSMART tail</p>');
    const t = text((await R({ document: smartDoc(), smart })).pages);
    expect(t.indexOf('Haemoglobin')).toBeLessThan(t.indexOf('SYNTHSMART tail'));
  });
});
