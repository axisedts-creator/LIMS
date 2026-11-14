// C11.T-14 (unit) — domain/report-content.ts: the immutable report snapshot (02-TRD §4.7 columns, §4.7.2 addendum_only, §4.7.3 summarise, §4.5.4 synoptic display; 05-SCHEMA §5 jsonb shapes;
// 01-PRD AC-09.1 (content stored), AC-09.10 (summary truncation), AC-09.8 (view carries exactly the signed content)). PURE: no DB, no ports, no clock.
//
// SEAMS (names chosen here — the writer follows or disputes):
//   * `summarise(text: string): string` — length <= 4000 -> unchanged; else the first 3,990 characters + " […]" (AC-09.10). Never leaves a lone UTF-16 surrogate (a cut inside an emoji drops the half).
//   * `buildContent(input): ReportContent` — input rows are PRE-RESOLVED by the service (the builder does no I/O):
//       { scope: 'full' | 'addendum_only', clinical_history_text, draft: { gross_text, microscopy_text, impression_text, comment_text, flag?, is_critical },
//         parts: [{ letter, site_text, description_text? }], synoptic: [{ template_key, template_version, definition, values }] (rendered with domain/synoptic.ts renderSynopticDisplay),
//         images: [{ bucket?, object_path, sha256, caption? }] (print order = given order), slides: [{ label, stain_display, adequacy_display?, finding_text?, include_in_report }],
//         ancillary: [{ stain_kind, stain_code, stain_display, block_label?, result_text }], molecular: [05-SCHEMA §5 objects], addenda: [{ seq, kind, text, signed_by_membership_id, signed_at }],
//         diagnosis_codes: [{ code, display, system, system_version? }] }
//     and returns the report_versions content columns: clinical_history_text, gross_text, microscopy_text, impression_text, comment_text, flag, is_critical, synoptic, images, specimen_parts, slides,
//     ancillary, molecular, addenda, diagnosis_codes. Every array element carries EXACTLY the 05-SCHEMA §5 keys (rows' extra columns — ids, tenant_id, state — never leak into the view); optional keys are
//     omitted when empty; parts are ordered by letter (A…Z, AA…); addenda oldest first (by seq); signed_at is an IsoUtc string; slides keep only include_in_report = true; nothing is mutated or aliased.
// Fails now: services/api/src/modules/anatomic/domain/report-content.ts does not exist.
import { describe, expect, it } from 'vitest';
import { buildContent, summarise } from '../domain/report-content.js';

const deepFreeze = <T>(x: T): T => { if (x && typeof x === 'object') { Object.values(x as object).forEach(deepFreeze); Object.freeze(x); } return x; };
const SHA = (c: string) => c.repeat(64);

const DEF = {
  schema_version: 1, title: 'Synthetic checklist', applies_to_case_kinds: ['histology'],
  sections: [{ key: 'tumour', heading: 'Tumour', fields: [
    { key: 'site', label: 'Site', type: 'text', required: true },
    { key: 'grade', label: 'Grade', type: 'single_select', required: true, options: [{ code: 'g1', display: 'Grade 1' }, { code: 'g2', display: 'Grade 2' }] },
    { key: 'size_mm', label: 'Size', type: 'integer', required: false, unit_text: 'mm' },
    { key: 'note', label: 'Note', type: 'text', required: false },
  ] }],
};
const ADDENDA = [
  { seq: 2, kind: 'special_stain', text: 'PAS: negative.', signed_by_membership_id: '0190c411-0000-7000-8000-000000005002', signed_at: '2026-11-14T06:00:00.000Z' },
  { seq: 1, kind: 'ihc', text: 'CK7 positive.', signed_by_membership_id: '0190c411-0000-7000-8000-000000005001', signed_at: new Date('2026-11-13T06:00:00.000Z') },
];
const input = (over: Record<string, unknown> = {}) => ({
  scope: 'full',
  clinical_history_text: 'Epigastric pain for 3 months.',
  draft: { gross_text: 'A. Antrum: two fragments.', microscopy_text: 'Mucosa with mild gastritis.', impression_text: 'Chronic gastritis.', comment_text: 'Correlate clinically.', flag: 'A', is_critical: true },
  parts: [
    { id: 'p-b', tenant_id: 'tenant-x', letter: 'B', site_text: 'Body' },
    { id: 'p-a', tenant_id: 'tenant-x', letter: 'A', site_text: 'Antrum', description_text: 'Two fragments' },
  ],
  synoptic: [{ template_key: 'synth_a', template_version: 2, definition: DEF, values: { site: 'Left lobe', grade: 'g2', size_mm: 12, note: '' } }],
  images: [
    { id: 'i1', tenant_id: 'tenant-x', state: 'ready', bucket: 'anatomic-images', object_path: 'T/2026/11/i1.png', sha256: SHA('a'), caption: 'Antral mucosa' },
    { id: 'i2', tenant_id: 'tenant-x', state: 'ready', bucket: 'anatomic-images', object_path: 'T/2026/11/i2.jpg', sha256: SHA('b'), caption: '' },
  ],
  slides: [
    { id: 's1', tenant_id: 'tenant-x', label: 'S26-0042-A1-1', stain_display: 'Haematoxylin & Eosin', finding_text: 'Adequate', include_in_report: true },
    { id: 's2', tenant_id: 'tenant-x', label: 'S26-0042-A1-2', stain_display: 'PAS', include_in_report: false },
  ],
  ancillary: [{ stain_order_id: 'so1', stain_kind: 'ihc', stain_code: 'IHC_CK7', stain_display: 'CK7', block_label: 'S26-0042-A1', result_text: 'Positive' }],
  molecular: [],
  addenda: [],
  diagnosis_codes: [{ code: 'LOC-0001', display: 'Chronic gastritis', system: 'local' }, { code: 'LOC-0002', display: 'Intestinal metaplasia', system: 'local', system_version: '1' }],
  ...over,
});

describe('summarise (02-TRD §4.7.3, AC-09.10)', () => {
  it('empty, short and exactly-4000-character text is returned unchanged', () => {
    expect(summarise('')).toBe('');
    expect(summarise('Chronic gastritis.')).toBe('Chronic gastritis.');
    const t = 'x'.repeat(4000);
    expect(summarise(t)).toBe(t);
  });
  it('AC-09.10: 4001 characters → the first 3,990 characters followed by " […]" (3,994 characters in all, within the 4,000-character A1 limit)', () => {
    const t = Array.from({ length: 4001 }, (_, i) => String.fromCharCode(97 + (i % 26))).join('');
    const s = summarise(t);
    expect(s).toBe(`${t.slice(0, 3990)} […]`);
    expect(s).toHaveLength(3994);
    expect(s.endsWith(' […]')).toBe(true);
  });
  it('a very long impression (30,000 characters) is cut the same way; the cut never exceeds 4,000', () => {
    const t = 'ab '.repeat(10000);
    const s = summarise(t);
    expect(s.startsWith(t.slice(0, 3990))).toBe(true);
    expect(s.endsWith(' […]')).toBe(true);
    expect(s.length).toBeLessThanOrEqual(4000);
  });
  it('a cut inside a surrogate pair does not leave a lone surrogate (well-formed text reaches C5)', () => {
    const t = `a${'😀'.repeat(2500)}`; // UTF-16 index 3989 is the HIGH half of an emoji
    const s = summarise(t);
    expect(s.endsWith(' […]')).toBe(true);
    expect(s.length).toBeLessThanOrEqual(4000);
    expect((s as unknown as { isWellFormed(): boolean }).isWellFormed()).toBe(true);
    expect(s.startsWith('a😀')).toBe(true);
  });
  it('plain text only: the marker is the three-dot ellipsis character U+2026 preceded by one space', () => {
    expect(summarise('y'.repeat(4001)).slice(-4)).toBe(' …]'.replace(' …]', ' […]'));
    expect(summarise('y'.repeat(4001)).slice(-3)).toBe('[…]');
  });
});

describe('buildContent scope "full" — golden (02-TRD §4.7.1, 05-SCHEMA §5)', () => {
  it('full golden: every column of the snapshot, exactly the 05-SCHEMA §5 keys per element, in print/letter order', () => {
    const c = buildContent(deepFreeze(input()) as never);
    expect(c).toEqual({
      clinical_history_text: 'Epigastric pain for 3 months.',
      gross_text: 'A. Antrum: two fragments.', microscopy_text: 'Mucosa with mild gastritis.', impression_text: 'Chronic gastritis.', comment_text: 'Correlate clinically.',
      flag: 'A', is_critical: true,
      synoptic: [{ template_key: 'synth_a', template_version: 2, title: 'Synthetic checklist', sections: [{ heading: 'Tumour', items: [
        { label: 'Site', value: 'Left lobe' }, { label: 'Grade', value: 'Grade 2' }, { label: 'Size', value: '12 mm' }] }] }],
      images: [
        { bucket: 'anatomic-images', object_path: 'T/2026/11/i1.png', sha256: SHA('a'), caption: 'Antral mucosa' },
        { bucket: 'anatomic-images', object_path: 'T/2026/11/i2.jpg', sha256: SHA('b') }, // caption omitted when empty (02-TRD §4.7.1)
      ],
      specimen_parts: [{ letter: 'A', site_text: 'Antrum', description_text: 'Two fragments' }, { letter: 'B', site_text: 'Body' }],
      slides: [{ label: 'S26-0042-A1-1', stain_display: 'Haematoxylin & Eosin', finding_text: 'Adequate' }], // only include_in_report
      ancillary: [{ stain_kind: 'ihc', stain_code: 'IHC_CK7', stain_display: 'CK7', block_label: 'S26-0042-A1', result_text: 'Positive' }],
      molecular: [],
      addenda: [],
      diagnosis_codes: [{ code: 'LOC-0001', display: 'Chronic gastritis', system: 'local' }, { code: 'LOC-0002', display: 'Intestinal metaplasia', system: 'local', system_version: '1' }],
    });
  });
  it('no key of any element is a storage column: ids, tenant_id, state, stain_order_id never reach the snapshot (and so never the published view)', () => {
    const c = buildContent(deepFreeze(input()) as never) as Record<string, any[]>;
    const leaked = ['id', 'tenant_id', 'centre_id', 'case_id', 'state', 'scan_state', 'stain_order_id', 'created_by'];
    for (const col of ['synoptic', 'images', 'specimen_parts', 'slides', 'ancillary', 'diagnosis_codes']) {
      for (const el of c[col]!) for (const k of leaked) expect(Object.keys(el), `${col}.${k}`).not.toContain(k);
    }
  });
  it('parts are ordered by letter, not by input order or id: B, AA, Z, A → A, B, Z, AA', () => {
    const parts = ['B', 'AA', 'Z', 'A'].map((letter) => ({ letter, site_text: `Site ${letter}` }));
    expect((buildContent(input({ parts }) as never) as any).specimen_parts.map((p: any) => p.letter)).toEqual(['A', 'B', 'Z', 'AA']);
  });
  it('flag absent → flag null/undefined and is_critical false; empty optional keys (description_text, adequacy_display, finding_text, block_label) are omitted, not "" or null', () => {
    const c = buildContent(input({
      draft: { gross_text: 'g', microscopy_text: '', impression_text: 'i', comment_text: '', is_critical: false },
      parts: [{ letter: 'A', site_text: 'Antrum', description_text: '' }],
      slides: [{ label: 'S1', stain_display: 'H&E', adequacy_display: '', finding_text: '', include_in_report: true }],
      ancillary: [{ stain_kind: 'special', stain_code: 'PAS', stain_display: 'PAS', block_label: '', result_text: 'Negative' }],
    }) as never) as any;
    expect(c.flag ?? null).toBeNull();
    expect(c.is_critical).toBe(false);
    expect(c.specimen_parts).toEqual([{ letter: 'A', site_text: 'Antrum' }]);
    expect(c.slides).toEqual([{ label: 'S1', stain_display: 'H&E' }]);
    expect(c.ancillary).toEqual([{ stain_kind: 'special', stain_code: 'PAS', stain_display: 'PAS', result_text: 'Negative' }]);
  });
  it('molecular (CR-C11-001): the 05-SCHEMA §5 object is kept with its optional keys only when present', () => {
    const m = { assay_code: 'EGFR_PANEL', assay_display: 'EGFR panel', target_code: 'L858R', target_display: 'L858R mutation', result_code: 'DETECTED', result_display: 'Detected', is_abnormal: true };
    const full = { ...m, value_decimal: '12.5', unit_code: '%', method_text: 'PCR', kit_name: 'KitX', kit_lot: 'LOT1', kit_expiry_on: '2027-01-31', batch_no: 'MB26-0001', comment_text: 'Repeat confirmed' };
    const c = buildContent(input({ molecular: [{ ...m, id: 'm1', tenant_id: 'tenant-x', value_decimal: null, unit_code: '' }, full] }) as never) as any;
    expect(c.molecular).toEqual([m, full]);
  });
  it('addenda in a full version: oldest first by seq, signed_at as IsoUtc (a Date becomes its ISO string), only the 05-SCHEMA §5 keys', () => {
    const c = buildContent(deepFreeze(input({ addenda: ADDENDA.map((a) => ({ ...a, id: 'x', tenant_id: 'tenant-x', status: 'signed' })) })) as never) as any;
    expect(c.addenda).toEqual([
      { seq: 1, kind: 'ihc', text: 'CK7 positive.', signed_by_membership_id: '0190c411-0000-7000-8000-000000005001', signed_at: '2026-11-13T06:00:00.000Z' },
      { seq: 2, kind: 'special_stain', text: 'PAS: negative.', signed_by_membership_id: '0190c411-0000-7000-8000-000000005002', signed_at: '2026-11-14T06:00:00.000Z' },
    ]);
  });
  it('an original (first) version has no addenda; a hidden/empty synoptic field is omitted (display snapshot §4.5.4)', () => {
    const c = buildContent(input({ synoptic: [{ template_key: 'synth_a', template_version: 1, definition: DEF, values: { site: 'Right', grade: 'g1' } }] }) as never) as any;
    expect(c.addenda).toEqual([]);
    expect(c.synoptic[0].sections[0].items).toEqual([{ label: 'Site', value: 'Right' }, { label: 'Grade', value: 'Grade 1' }]);
  });
  it('texts are passed through byte for byte (already plain text from the draft): LF and TAB survive, nothing is trimmed or re-wrapped', () => {
    const g = 'Line 1\n\tindented\nLine 3';
    expect((buildContent(input({ draft: { gross_text: g, microscopy_text: '', impression_text: 'i', comment_text: '', is_critical: false } }) as never) as any).gross_text).toBe(g);
  });
  it('pure: frozen inputs are accepted, the output does not alias input arrays/objects, and calling twice gives equal results', () => {
    const i = deepFreeze(input({ addenda: ADDENDA }));
    const a = buildContent(i as never) as any, b = buildContent(i as never) as any;
    expect(a).toEqual(b);
    expect(a.images).not.toBe(i.images);
    expect(a.addenda).not.toBe(i.addenda);
    expect(a.specimen_parts[0]).not.toBe(i.parts[1]);
  });
});

describe('buildContent scope "addendum_only" (02-TRD §4.7.2)', () => {
  const only = () => buildContent(deepFreeze(input({
    scope: 'addendum_only', addenda: ADDENDA,
    ancillary: [{ stain_kind: 'ihc', stain_code: 'IHC_CK7', stain_display: 'CK7', result_text: 'Positive' }],
  })) as never) as any;
  it('texts are empty strings; synoptic, images, slides and molecular are [] — even though the caller passed them', () => {
    const c = only();
    for (const k of ['gross_text', 'microscopy_text', 'impression_text', 'comment_text']) expect(c[k], k).toBe('');
    for (const k of ['synoptic', 'images', 'slides', 'molecular']) expect(c[k], k).toEqual([]);
  });
  it('addenda = the given addenda oldest first (this one included); ancillary = the stain orders handed in (those of the addenda), not the draft report\'s', () => {
    const c = only();
    expect(c.addenda.map((a: any) => a.seq)).toEqual([1, 2]);
    expect(c.ancillary).toEqual([{ stain_kind: 'ihc', stain_code: 'IHC_CK7', stain_display: 'CK7', result_text: 'Positive' }]);
  });
  it('the full-scope golden and the addendum_only result differ only where §4.7.2 says so (texts, synoptic, images, slides, molecular, addenda, ancillary)', () => {
    const full = buildContent(input({ addenda: ADDENDA }) as never) as any;
    const part = only();
    const same = (k: string) => expect(part[k], k).toEqual(full[k]);
    if ('specimen_parts' in part) same('specimen_parts');
    expect(Object.keys(part).sort()).toEqual(Object.keys(full).sort()); // same column set
  });
});
