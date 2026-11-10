// C8 AN-T15 — export writers: layout (header block, NPR columns), CsvWriter, XlsxWriter, PdfRequest (analytics.report render data).
// PRD US-17.2/17.3 (header block, formula neutralisation), 02-TRD §10.2 step 6/6a, 07-SECURITY E5/E6 (REQ-SEC injection), D-C8-07.
//
// SEAMS pinned here (the spec names the files, not the signatures; the writer may dispute through the reviewer):
//   export/layout.ts      NOT_STATUTORY = 'Internal MIS — not a statutory register'
//                         types ExportColumn {key,label,kind:'text'|'count'|'paisa'|'seconds'|'bp'}, ExportMeta {tenantDisplayName, reportTitle, periodLabelAd, periodLabelBs,
//                         scopeLabel, generatedAtLocal, exportId, exportedBy, freshnessNote}, ExportTable {meta, columns, rows: Record<key, string|number>[]}
//                         headerLines(meta): string[]  - the 9 header-block lines in PRD order, each "<Label>: <value>" (exportedBy line = "Exported by <name>")
//                         withNprColumns(table): ExportTable - after every kind 'paisa' column "<x>_paisa" a text column "<x>_npr" with the amount as "<rupees>.<2 digits>" (no float maths)
//   export/CsvWriter.ts   writeCsv(table): Uint8Array   UTF-8 BOM, CRLF, '#'-prefixed header lines, header row (labels), rows; NPR columns included
//   export/XlsxWriter.ts  writeXlsx(table): Promise<Uint8Array>   sheet "Report" (labels row + rows, NPR columns included) and sheet "About" (the header lines)
//   export/PdfRequest.ts  buildPdfData(table): the `data` of RenderPort.renderPdf (TRD §10.2 step 6a); > 5,000 rows -> LimsError analytics.export_too_large
//   Numbers (count/paisa/seconds/bp) are written as numbers (never neutralised: -740 stays -740); every text cell passes neutraliseFormula.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { neutraliseFormula } from '../../../../../../../packages/shared-ts/src/spreadsheet/index.js';
import { isLimsError } from '../../../../core/errors.js';
import { csvParts, flat, readXlsx } from './xlsxRead.js';

const dir = join(import.meta.dirname, '..');
const load = async () => ({
  layout: await import('../layout.js') as any,
  csv: await import('../CsvWriter.js') as any,
  xlsx: await import('../XlsxWriter.js') as any,
  pdf: await import('../PdfRequest.js') as any,
});

const FORMULA = '=HYPERLINK("http://x","click")';
const META = {
  tenantDisplayName: 'Test Lab Pvt Ltd', reportTitle: 'Income report', periodLabelAd: '2026-11-05 to 2026-11-06', periodLabelBs: '2083-07-19 to 2083-07-20 B.S.',
  scopeLabel: 'All centres', generatedAtLocal: '2026-11-06 11:45', exportId: '01900002-0000-7000-8000-0000000000aa', exportedBy: 'Test User A-refowner',
  freshnessNote: 'Data as of 2026-11-06 11:40', notStatutoryNote: undefined,
};
const COLUMNS = [
  { key: 'label', label: 'Referrer', kind: 'text' }, { key: 'orders', label: 'Orders', kind: 'count' }, { key: 'net_sales_paisa', label: 'Net sales (paisa)', kind: 'paisa' },
  { key: 'median_seconds', label: 'Median TAT (s)', kind: 'seconds' }, { key: 'share_bp', label: 'Share (bp)', kind: 'bp' },
] as const;
const ROWS = [
  { label: FORMULA, orders: 3, net_sales_paisa: 1234567, median_seconds: 3600, share_bp: 2500 },
  { label: 'Dr. Test, "Quoted"\nSecond line', orders: 0, net_sales_paisa: -740, median_seconds: 0, share_bp: 0 },
  { label: 'Dr. Plain', orders: 12, net_sales_paisa: 5, median_seconds: 61, share_bp: 10000 },
];
const table = (over: Record<string, unknown> = {}) => ({ meta: { ...META }, columns: COLUMNS.map((c) => ({ ...c })), rows: ROWS.map((r) => ({ ...r })), ...over });
const NOT_STATUTORY = 'Internal MIS — not a statutory register';


describe('layout — header block (US-17.2) and NPR columns', () => {
  it('headerLines: tenant, title, period A.D./B.S., scope, generated at, export id, "Exported by <name>", freshness, not-statutory line — in that order', async () => {
    const { layout } = await load();
    expect(layout.NOT_STATUTORY).toBe(NOT_STATUTORY);
    const lines: string[] = layout.headerLines(META);
    expect(lines).toHaveLength(9);
    const wants = [META.tenantDisplayName, META.reportTitle, META.periodLabelAd, META.scopeLabel, META.generatedAtLocal, META.exportId, 'Exported by Test User A-refowner', META.freshnessNote, NOT_STATUTORY];
    wants.forEach((w, i) => expect(lines[i], `line ${i}`).toContain(w));
    expect(lines[2]).toContain(META.periodLabelBs);            // period carries both calendars
  });

  it('withNprColumns: a text "<x>_npr" column after each paisa column, two decimals, integer maths only', async () => {
    const { layout } = await load();
    const out = layout.withNprColumns(table());
    const keys = out.columns.map((c: any) => c.key);
    expect(keys).toEqual(['label', 'orders', 'net_sales_paisa', 'net_sales_npr', 'median_seconds', 'share_bp']);
    expect(out.columns[3].kind).toBe('text');
    const npr = out.rows.map((r: any) => r.net_sales_npr);
    expect(npr[0]).toBe('12345.67');
    expect(npr[2]).toBe('0.05');
    expect(out.rows.map((r: any) => r.net_sales_paisa)).toEqual([1234567, -740, 5]);   // the integer paisa stay
    expect(out.rows.length).toBe(3);
  });
});

describe('CsvWriter — RFC 4180, header block, neutralisation (US-17.2/17.3, E5/E6)', () => {
  it('UTF-8 BOM, CRLF records, "#" header block first (incl. requester name and the not-statutory line), then the label row', async () => {
    const { csv } = await load();
    const { buf, headerLines, head } = csvParts(csv.writeCsv(table()));
    expect([...buf.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(buf.toString('utf8')).toContain('\r\n');
    expect(headerLines.length).toBe(9);
    const block = headerLines.join('\n');
    for (const w of [META.tenantDisplayName, META.reportTitle, META.periodLabelAd, META.periodLabelBs, META.scopeLabel, META.exportId, 'Exported by Test User A-refowner', META.freshnessNote, NOT_STATUTORY]) expect(block).toContain(w);
    expect(head).toEqual(expect.arrayContaining(['Referrer', 'Orders', 'Net sales (paisa)', 'Median TAT (s)', 'Share (bp)']));
    expect(head.length).toBe(6);                                // 5 columns + the NPR companion
  });

  it('fields with comma, quote or newline are quoted with doubled quotes; every record has the same field count; round-trips', async () => {
    const { csv } = await load();
    const { body, head } = csvParts(csv.writeCsv(table()));
    expect(body).toHaveLength(3);
    for (const r of body) expect(r).toHaveLength(head.length);
    expect(body[1]![0]).toBe('Dr. Test, "Quoted"\nSecond line');
    const raw = Buffer.from(csv.writeCsv(table())).toString('utf8');
    expect(raw).toContain('"Dr. Test, ""Quoted""\nSecond line"');
  });

  it('numbers are written bare (negative paisa stays -740, not "\'-740"); the NPR column carries two decimals', async () => {
    const { csv } = await load();
    const { body, head } = csvParts(csv.writeCsv(table()));
    const col = (k: string) => head.indexOf(k);
    expect(body.map((r) => r[col('Net sales (paisa)')])).toEqual(['1234567', '-740', '5']);
    expect(body.map((r) => r[col('Orders')])).toEqual(['3', '0', '12']);
    expect(body.some((r) => r.includes('12345.67'))).toBe(true);
    expect(body.some((r) => r.includes('0.05'))).toBe(true);
  });

  it('a doctor name starting with a HYPERLINK formula stays TEXT: leading apostrophe, never a raw "="', async () => {
    const { csv } = await load();
    const { body } = csvParts(csv.writeCsv(table()));
    expect(body[0]![0]).toBe(`'${FORMULA}`);
    expect(body.flat().filter((c) => c === FORMULA)).toEqual([]);
  });

  it.each(['=1+1', '+1', '-1+2', '@SUM(A1)', '\tx', '\rx', "'quoted"])('corpus %j is neutralised exactly like @lims/shared-ts/spreadsheet', async (v) => {
    const { csv } = await load();
    const { body } = csvParts(csv.writeCsv(table({ rows: [{ ...ROWS[2], label: v }] })));
    expect(body[0]![0]).toBe(neutraliseFormula(v));
    expect(body[0]![0]).not.toBe(v);
  });
});

describe('XlsxWriter — opens, sheets Report + About, numbers are numbers (US-17.1/17.2/17.3)', () => {
  it('a valid workbook with sheets "Report" and "About"', async () => {
    const { xlsx } = await load();
    const book = readXlsx(await xlsx.writeXlsx(table()));
    expect(Object.keys(book).sort()).toEqual(['About', 'Report']);
  });

  it('Report: label row then one row per data row; counts / paisa / seconds / bp are NUMBERS (negative stays a number), NPR companion is text with two decimals', async () => {
    const { xlsx } = await load();
    const rows = readXlsx(await xlsx.writeXlsx(table())).Report!;
    const head = rows[0]!.map(String);
    expect(head).toEqual(expect.arrayContaining(['Referrer', 'Orders', 'Net sales (paisa)', 'Median TAT (s)', 'Share (bp)']));
    expect(rows).toHaveLength(4);
    const col = (k: string) => head.indexOf(k);
    expect(rows.slice(1).map((r) => r[col('Net sales (paisa)')])).toEqual([1234567, -740, 5]);
    expect(rows.slice(1).map((r) => r[col('Orders')])).toEqual([3, 0, 12]);
    expect(rows.slice(1).map((r) => r[col('Median TAT (s)')])).toEqual([3600, 0, 61]);
    expect(flat(rows)).toEqual(expect.arrayContaining(['12345.67', '0.05']));
    expect(rows[2]![0]).toBe('Dr. Test, "Quoted"\nSecond line');
  });

  it('formula-looking text cell (doctor name) is written as text with a leading apostrophe', async () => {
    const { xlsx } = await load();
    const rows = readXlsx(await xlsx.writeXlsx(table())).Report!;
    expect(rows[1]![0]).toBe(`'${FORMULA}`);
    expect(flat(rows).filter((c) => c === FORMULA)).toEqual([]);
  });

  it('About sheet holds the whole header block incl. requester name and the not-statutory line', async () => {
    const { xlsx } = await load();
    const text = flat(readXlsx(await xlsx.writeXlsx(table())).About!).join('\n');
    for (const w of [META.tenantDisplayName, META.reportTitle, META.periodLabelAd, META.periodLabelBs, META.scopeLabel, META.generatedAtLocal, META.exportId, 'Exported by Test User A-refowner', META.freshnessNote, NOT_STATUTORY]) expect(text).toContain(w);
  });

  it('header-block values are neutralised too (a tenant or user name starting with a formula char)', async () => {
    const { xlsx } = await load();
    const t = table({ meta: { ...META, tenantDisplayName: '=cmd|x', exportedBy: '@evil' } });
    const about = flat(readXlsx(await xlsx.writeXlsx(t)).About!);
    expect(about.some((c) => c === '=cmd|x' || c === '@evil')).toBe(false);
    expect(about.join('\n')).toContain("'=cmd|x");
  });
});

describe('PdfRequest — analytics.report render data (TRD §10.2 step 6a)', () => {
  const TOP = ['tenantDisplayName', 'reportTitle', 'periodLabelAd', 'periodLabelBs', 'scopeLabel', 'generatedAtLocal', 'exportId', 'exportedBy', 'freshnessNote', 'notStatutoryNote', 'columns', 'rows'];

  it('exactly the 12 top-level keys; columns {key,label,kind}; rows keyed by column key only; not-statutory note present', async () => {
    const { pdf } = await load();
    const d = pdf.buildPdfData(table());
    expect(Object.keys(d).sort()).toEqual([...TOP].sort());
    expect(d.notStatutoryNote).toBe(NOT_STATUTORY);
    expect(d.exportedBy).toContain('Test User A-refowner');
    expect(d.exportId).toBe(META.exportId);
    expect(d.columns).toEqual(COLUMNS.map((c) => ({ key: c.key, label: c.label, kind: c.kind })));
    for (const c of d.columns) { expect(c.key).toMatch(/^[a-z0-9_]{1,40}$/); expect(['text', 'count', 'paisa', 'seconds', 'bp']).toContain(c.kind); }
    expect(d.rows).toHaveLength(3);
    for (const r of d.rows) expect(Object.keys(r).sort()).toEqual(COLUMNS.map((c) => c.key).sort());
  });

  it('count/paisa/seconds/bp stay integers (template formats them, negative stays a number); text cells are neutralised', async () => {
    const { pdf } = await load();
    const d = pdf.buildPdfData(table());
    expect(d.rows[1].net_sales_paisa).toBe(-740);
    expect(d.rows[0].net_sales_paisa).toBe(1234567);
    expect(Number.isInteger(d.rows[0].orders)).toBe(true);
    expect(d.rows[0].label).toBe(`'${FORMULA}`);
  });

  it('header strings are neutralised and every string is cut to ≤ 200 characters (schema bound)', async () => {
    const { pdf } = await load();
    const d = pdf.buildPdfData(table({ meta: { ...META, exportedBy: '@evil', reportTitle: 'T'.repeat(500) }, rows: [{ ...ROWS[2], label: 'L'.repeat(300) }] }));
    expect(d.exportedBy).toBe("'@evil");
    expect(d.reportTitle.length).toBeLessThanOrEqual(200);
    expect(d.rows[0].label.length).toBeLessThanOrEqual(200);
  });

  it('> 5,000 rows -> LimsError analytics.export_too_large (RenderPort cap, checked before any call); 5,000 is fine', async () => {
    const { pdf } = await load();
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ ...ROWS[2], label: `Dr. ${i}` }));
    expect(pdf.buildPdfData(table({ rows: many(5000) })).rows).toHaveLength(5000);
    let err: unknown;
    try { pdf.buildPdfData(table({ rows: many(5001) })); } catch (e) { err = e; }
    expect(isLimsError(err, 'analytics.export_too_large')).toBe(true);
  });
});

describe('every writer calls the ONE shared neutraliseFormula (08 A13 P-9; no module copy) — E5 integration check', () => {
  it.each(['CsvWriter.ts', 'XlsxWriter.ts', 'PdfRequest.ts'])('%s imports neutraliseFormula from the shared spreadsheet module and defines no local copy', (file) => {
    const src = readFileSync(join(dir, file), 'utf8');
    expect(src).toMatch(/neutraliseFormula/);
    expect(src).toMatch(/shared-ts[^'"]*spreadsheet/);
    expect(src).not.toMatch(/function\s+neutraliseFormula|const\s+neutraliseFormula\s*=|restoreNeutralised/);
  });
});
