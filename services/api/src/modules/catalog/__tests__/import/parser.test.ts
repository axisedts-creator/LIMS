// T0B-TESTIMPORT-1 (done_when 4, 7) PARSER SAFETY over a real PG17. File-level refusals are problem+json (a thrown LimsError, nothing recorded: 422 catalog.import_invalid_file,
// 422 catalog.import_template_outdated, 413 catalog.import_too_large); cell-level problems are rows of the batch errors (batch rejected, HTTP 201). Every refusal leaves the catalog untouched.
import { randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { DATA_SHEETS, SHEET, TEMPLATE_VERSION, labels } from './columns.js';
import { T, batchRows, build, errorsOf, expectCode, expectError, fresh, sha, snapshot, upload, uploadFails, validated, TENANT_A, ownerRows } from './helpers.js';
import { buildXlsx, colName, metaRows, toRows, workbook, zipDeflate } from './xlsx.js';

let C: Awaited<ReturnType<typeof fresh>>;
beforeAll(async () => { C = await fresh(); }, T);

/** the file is refused at file level: right problem code AND nothing recorded or written */
async function refused(bytes: Uint8Array, code: string, status: number): Promise<void> {
  const before = await snapshot(TENANT_A, C.t); const n0 = (await ownerRows('catalog.import_batch', 'tenant_id = $1', [TENANT_A])).length;
  expectCode(await uploadFails(bytes), code, status);
  expect(await snapshot(TENANT_A, C.t), 'catalog untouched').toEqual(before);
  expect((await ownerRows('catalog.import_batch', 'tenant_id = $1', [TENANT_A])).length, 'no batch recorded for a refused file').toBe(n0);
}
const INVALID = 'catalog.import_invalid_file';

describe('not an xlsx (magic bytes and structure, never the file name or mime type)', () => {
  it('random garbage', { timeout: T }, async () => refused(randomBytes(64 * 1024), INVALID, 422));
  it('empty file', { timeout: T }, async () => refused(new Uint8Array(0), INVALID, 422));
  it('a csv renamed .xlsx (declared with the xlsx mime type)', { timeout: T }, async () => refused(Buffer.from('Test Code,Test Name\nSYN01,Synthetic\n'), INVALID, 422));
  it('an old binary .xls (OLE2 magic)', { timeout: T }, async () => refused(Buffer.concat([Buffer.from('d0cf11e0a1b11ae1', 'hex'), randomBytes(4096)]), INVALID, 422));
  it('a zip that is not an OOXML workbook (no workbook part)', { timeout: T }, async () => refused(zipDeflate({ 'readme.txt': 'hello' }), INVALID, 422));
  it('a truncated xlsx', { timeout: T }, async () => refused(build(C).subarray(0, 600), INVALID, 422));
  it('a pdf', { timeout: T }, async () => refused(Buffer.from('%PDF-1.7\n1 0 obj<<>>endobj\n%%EOF'), INVALID, 422));
});

describe('active content is refused (macro, external link, embedded object, formula)', () => {
  it('xlsm: a vbaProject part', { timeout: T }, async () => refused(build(C, undefined, { extra: { 'xl/vbaProject.bin': randomBytes(512) } }), INVALID, 422));
  it('xlsm: macro enabled content type with no vba part', { timeout: T }, async () => refused(build(C, undefined, { macroContentType: true }), INVALID, 422));
  it('external link part', { timeout: T }, async () => refused(build(C, undefined, { extra: { 'xl/externalLinks/externalLink1.xml': '<externalLink xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>' } }), INVALID, 422));
  it('external relationship target (TargetMode External)', { timeout: T }, async () =>
    refused(build(C, undefined, { relsExtra: '<Relationship Id="rId99" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/externalLink" Target="file:///C:/secret.xlsx" TargetMode="External"/>' }), INVALID, 422));
  it('embedded OLE object', { timeout: T }, async () => refused(build(C, undefined, { extra: { 'xl/embeddings/oleObject1.bin': randomBytes(256) } }), INVALID, 422));
  it('ActiveX control', { timeout: T }, async () => refused(build(C, undefined, { extra: { 'xl/activeX/activeX1.xml': '<ocx/>' } }), INVALID, 422));
  it('a cell that holds a formula, in a data sheet', { timeout: T }, async () =>
    refused(build(C, (d) => { d[SHEET.tests]![0]!['Test Name'] = { f: 'SUM(1,1)' } as any; }), INVALID, 422));
  it('a formula cell in the hidden Lists sheet (hidden is not trusted)', { timeout: T }, async () =>
    refused(buildXlsx([
      { name: SHEET.instructions, rows: [['x']] }, ...DATA_SHEETS.map((s) => ({ name: s, rows: toRows(s, []) })),
      { name: SHEET.lists, rows: [[{ f: 'HYPERLINK("http://x")' }]], state: 'hidden' as const }, { name: SHEET.meta, rows: metaRows(TEMPLATE_VERSION, C.checksum), state: 'hidden' as const },
    ]), INVALID, 422));
  it('XML entity expansion (billion laughs) in the workbook part', { timeout: T }, async () => {
    const bomb = '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;"><!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;">]><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets><sheet name="&c;" sheetId="1" r:id="rId1" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/></sheets></workbook>';
    await refused(build(C, undefined, { extra: { 'xl/workbook.xml': bomb } }), INVALID, 422);
  });
  it('external entity (XXE) in a sheet part', { timeout: T }, async () => {
    const xxe = '<?xml version="1.0"?><!DOCTYPE s [<!ENTITY x SYSTEM "file:///etc/passwd">]><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>&x;</t></is></c></row></sheetData></worksheet>';
    await refused(build(C, undefined, { extra: { 'xl/worksheets/sheet2.xml': xxe } }), INVALID, 422);
  });
});

describe('size limits (zip bomb, entry count, 5 MB, 5000 rows)', () => {
  it('zip bomb: a worksheet part of ~400 MB of blanks (the file itself is small) is refused before parsing', { timeout: 180_000 }, async () => {
    const bomb = build(C, undefined, { extra: { 'xl/worksheets/sheet99.xml': Buffer.alloc(400 * 1024 * 1024, 0x20) }, level: 1 });
    expect(bomb.length, 'the bomb itself is small').toBeLessThan(2 * 1024 * 1024);
    await refused(bomb, INVALID, 422);
  });
  it('zip bomb: an unreferenced part with an absurd expansion ratio (300 MB of zeros)', { timeout: 180_000 }, async () => {
    await refused(build(C, undefined, { extra: { 'docProps/junk.bin': Buffer.alloc(300 * 1024 * 1024, 0) }, level: 1 }), INVALID, 422);
  });
  it('zip bomb: the sheet part that IS read inflates far beyond any real sheet (200 MB of rows)', { timeout: 180_000 }, async () => {
    const rows = '<row r="2"><c r="A2" t="inlineStr"><is><t>x</t></is></c></row>'.repeat(3_500_000);
    await refused(build(C, undefined, { extra: { 'xl/worksheets/sheet2.xml': `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>` }, level: 1 }), INVALID, 422);
  });
  it('too many zip entries (3000 tiny parts)', { timeout: T }, async () =>
    refused(build(C, undefined, { extra: Object.fromEntries(Array.from({ length: 3000 }, (_, i) => [`customXml/p${i}.xml`, '<a/>'])) }), INVALID, 422));
  it('more than 5 MB -> 413 catalog.import_too_large', { timeout: T }, async () => {
    const big = build(C, undefined, { extra: { 'docProps/pad.bin': randomBytes(5 * 1024 * 1024 + 1024) } });
    expect(big.length).toBeGreaterThan(5 * 1024 * 1024);
    await refused(big, 'catalog.import_too_large', 413);
  });
  it('more than 5000 rows in a sheet -> 413 catalog.import_too_large (data rows 5001)', { timeout: 180_000 }, async () => {
    const rows = Array.from({ length: 5001 }, (_, i) => ({ 'Test Code': `R${C.t}${i}`, 'Test Name': 'Synthetic', 'Department Code': C.masters.dept, 'Specimen Code': C.masters.spec, 'Workflow Type': 'standard' }));
    await refused(workbook({ [SHEET.tests]: rows } as any, { metaChecksum: C.checksum }), 'catalog.import_too_large', 413);
  });
});

describe('template version and shape', () => {
  it('outdated template version in Meta -> 422 catalog.import_template_outdated', { timeout: T }, async () =>
    refused(build(C, undefined, { metaVersion: '0' }), 'catalog.import_template_outdated', 422));
  it('a version from the future is outdated too', { timeout: T }, async () => refused(build(C, undefined, { metaVersion: '999' }), 'catalog.import_template_outdated', 422));
  it('a tampered checksum -> catalog.import_template_outdated', { timeout: T }, async () =>
    refused(build(C, undefined, { metaChecksum: 'f'.repeat(64) }), 'catalog.import_template_outdated', 422));
  it('a renamed header (the sheet no longer matches the template) -> catalog.import_template_outdated', { timeout: T }, async () => {
    const headers = labels(SHEET.tests).map((h) => (h === 'Test Name' ? 'Name Of Test' : h));
    await refused(build(C, undefined, { headers: { [SHEET.tests]: headers } }), 'catalog.import_template_outdated', 422);
  });
  it('a missing data sheet -> catalog.import_template_outdated', { timeout: T }, async () => refused(build(C, undefined, { omitSheet: SHEET.params as any }), 'catalog.import_template_outdated', 422));
  it('no Meta sheet at all (not our template) -> catalog.import_invalid_file', { timeout: T }, async () => refused(build(C, undefined, { noMeta: true }), INVALID, 422));
});

describe('cell hygiene (batch errors, all listed)', () => {
  it('formula injection: text cells starting with = + - @ are rejected, each one listed (also after leading spaces)', { timeout: T }, async () => {
    const r = await validated(build(C, (d) => {
      d[SHEET.tests]![0]!['Test Name'] = '=cmd|"/c calc"!A1'; d[SHEET.tests]![0]!['Description'] = '+1+1';
      d[SHEET.tests]![1]!['Test Name'] = '-2+3'; d[SHEET.tests]![1]!['Description'] = '@SUM(A1)'; d[SHEET.tests]![1]!['Barcode Text'] = '  =1+1';
    }));
    expect(r.batch.status).toBe('rejected');
    for (const [row, col] of [[2, 'Test Name'], [2, 'Description'], [3, 'Test Name'], [3, 'Description'], [3, 'Barcode Text']] as const) expectError(r, SHEET.tests, row, col, 'formula_injection');
    expect(r.preview.tests).toEqual([]);
  });
  it('a harmless "=" or "-" inside text is fine', { timeout: T }, async () => {
    const r = await validated(build(C, (d) => { d[SHEET.tests]![0]!['Description'] = 'HbA1c = 6 - 7 % (target @ fasting)'; }));
    expect(r.errors, JSON.stringify(r.errors)).toEqual([]);
  });
  it('a cell longer than the cap (32 000 chars) -> cell_too_long, the value is never stored in the batch', { timeout: T }, async () => {
    const r = await validated(build(C, (d) => { d[SHEET.tests]![0]!['Description'] = 'x'.repeat(32_000); }));
    expectError(r, SHEET.tests, 2, 'Description', 'cell_too_long');
    const row = (await batchRows(TENANT_A, r.batch.file_sha256))[0];
    expect(JSON.stringify(row.payload).length, 'payload does not carry the huge cell').toBeLessThan(200_000);
  });
  it('trim, NFC, control characters: the preview shows the normalized values', { timeout: T }, async () => {
    const r = await validated(build(C, (d) => { d[SHEET.tests]![0]!['Test Code'] = `  ${C.g.codes.t1}  `; d[SHEET.tests]![0]!['Test Name'] = `Cafe\u0301 \u0007Lipid\u0000 ${C.t}`; }));
    expect(r.errors, JSON.stringify(r.errors)).toEqual([]);
    const t = r.preview.tests.find((x: any) => x.code === C.g.codes.t1);
    expect(t, 'trimmed code').toBeTruthy();
    expect(t.name).toBe(`Caf\u00e9 Lipid ${C.t}`);
  });
  it('inline strings and shared strings read the same (Excel writes shared strings, other tools inline)', { timeout: T }, async () => {
    const a = await validated(build(C, undefined, { shared: false }));
    expect(a.errors, JSON.stringify(a.errors)).toEqual([]);
    expect(a.batch.counts.tests).toBe(2);
  });
  it('only the named sheets are read: an extra sheet full of junk and injection strings is ignored', { timeout: T }, async () => {
    const junk = Array.from({ length: 6000 }, (_, i) => ['=BAD()', `+${i}`, '@x']);
    const r = await validated(build(C, undefined, { extraSheets: [{ name: 'Scratch', rows: junk }] }));
    expect(r.errors, JSON.stringify(r.errors)).toEqual([]);
    expect(r.batch.status).toBe('validated');
  });
  it('every error carries sheet, row (Excel row, header = 1) and column; none is invented outside the sheet', { timeout: T }, async () => {
    const r = await validated(build(C, (d) => { d[SHEET.tests]![1]!['Test Name'] = '=1'; }));
    expect(errorsOf(r)).toEqual([`${SHEET.tests}|3|Test Name|formula_injection`]);
    expect(colName(1)).toBe('B');
  });
});

describe('a refused or rejected upload writes no catalog row', () => {
  it('a rejected (errors) batch is recorded as history only; tests, analytes and panels stay at zero', { timeout: T }, async () => {
    const before = await snapshot(TENANT_A, C.t);
    const bytes = build(C, (d) => { d[SHEET.tests]![0]!['Test Name'] = '=1'; });
    const r = await upload(bytes);
    expect(r.body.batch.status).toBe('rejected');
    expect(await snapshot(TENANT_A, C.t)).toEqual(before);
    expect((await batchRows(TENANT_A, sha(bytes))).length).toBe(1);
  });
});
