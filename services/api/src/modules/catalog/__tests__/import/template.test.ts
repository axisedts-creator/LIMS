// T0B-TESTIMPORT-1 (done_when 3) downloadCatalogImportTemplate over a real PG17: sheets, headers equal the pinned field lists, locked headers, unlocked input cells,
// dropdowns filled from the live masters of the caller's tenant only, hidden Lists and Meta (version + checksum), instructions for every column, and no macro / link in the file we hand out.
import { describe, expect, it } from 'vitest';
import { COLUMNS, DATA_SHEETS, SHEET, TEMPLATE_VERSION, labels, type DataSheet } from './columns.js';
import { T, TENANT_A, TENANT_B, call, fresh, req, schemaErrors } from './helpers.js';
import { colName, readWorkbook } from './xlsx.js';

const download = async (tenant = TENANT_A) => {
  const r = await call('downloadCatalogImportTemplate', req(), { tenant });
  expect(r.status).toBe(200);
  return r;
};

describe('template download', () => {
  it('200 xlsx attachment, ZIP magic, no macro / external link / embedded object part, no formula cell', { timeout: T }, async () => {
    const r = await download();
    expect(String(r.headers?.['content-disposition'])).toMatch(/^attachment;.*test-import-template\.xlsx/);
    expect(String(r.headers?.['content-type'] ?? '')).toContain('spreadsheetml.sheet');
    const bytes = Buffer.from(r.body);
    expect(bytes.subarray(0, 4).toString('hex')).toBe('504b0304');
    expect(bytes.length).toBeLessThan(5 * 1024 * 1024);
    const { files, sheets } = readWorkbook(bytes);
    for (const n of files.keys()) expect(n, 'forbidden part').not.toMatch(/vbaProject|externalLinks|embeddings|activeX|oleObject/i);
    for (const s of sheets.values()) expect(s.xml, `${s.name} has no formula cell`).not.toMatch(/<f[ >]/);
    expect(files.get('[Content_Types].xml')!.toString()).not.toMatch(/macroEnabled/i);
  });
  it('sheets: Instructions, Tests, Parameters, Reference Ranges, Panels visible; Lists and Meta hidden', { timeout: T }, async () => {
    const { sheets } = readWorkbook(Buffer.from((await download()).body));
    for (const n of [SHEET.instructions, ...DATA_SHEETS]) expect(sheets.get(n)?.state, n).toBe('visible');
    for (const n of [SHEET.lists, SHEET.meta]) expect(['hidden', 'veryHidden'], n).toContain(sheets.get(n)?.state);
  });
  it.each(DATA_SHEETS)('%s: header row = the pinned field list, in order (template and forms cannot drift)', { timeout: T }, async (sheet: DataSheet) => {
    const { sheets } = readWorkbook(Buffer.from((await download()).body));
    expect(sheets.get(sheet)!.header).toEqual(labels(sheet));
  });
  it('Meta holds template_version and a 64 hex checksum', { timeout: T }, async () => {
    const meta = readWorkbook(Buffer.from((await download()).body)).sheets.get(SHEET.meta)!;
    const kv = Object.fromEntries([meta.header, ...meta.rows].map((r) => [r[0], r[1]]));
    expect(kv['template_version']).toBe(TEMPLATE_VERSION);
    expect(kv['checksum']).toMatch(/^[0-9a-f]{64}$/);
  });
  it('Instructions explain every column of every sheet and the import rules', { timeout: T }, async () => {
    const ins = readWorkbook(Buffer.from((await download()).body)).sheets.get(SHEET.instructions)!;
    const text = [ins.header, ...ins.rows].flat().join('\n');
    for (const s of DATA_SHEETS) for (const l of labels(s)) expect(text, `${s}/${l}`).toContain(l);
    for (const needle of ['5 MB', '5000', 'DRAFT']) expect(text).toContain(needle);
  });
  it('header rows are locked (sheet protection on every data sheet) and input cells are unlocked (an unlocked style exists)', { timeout: T }, async () => {
    const { sheets, files } = readWorkbook(Buffer.from((await download()).body));
    for (const s of DATA_SHEETS) expect(sheets.get(s)!.protectedSheet, `${s} protected`).toBe(true);
    expect(files.get('xl/styles.xml')!.toString()).toMatch(/<protection[^>]*locked="0"/);
  });
});

describe('dropdowns come from the live masters of the caller tenant', () => {
  it('data validation lists exist on the enum and master columns; the hidden Lists sheet carries this tenant masters and every enum value; the other tenant sees none of them', { timeout: T }, async () => {
    const A = await fresh(TENANT_A);
    const a = readWorkbook(Buffer.from((await download(TENANT_A)).body));
    const b = readWorkbook(Buffer.from((await download(TENANT_B)).body));
    const listA = a.sheets.get(SHEET.lists)!; const flatA = [listA.header, ...listA.rows].flat().join('|');
    const flatB = [b.sheets.get(SHEET.lists)!.header, ...b.sheets.get(SHEET.lists)!.rows].flat().join('|');
    for (const v of [A.masters.dept, A.masters.spec, A.masters.unit, A.masters.valueSet, A.masters.category]) { expect(flatA, v).toContain(v); expect(flatB, `tenant B must not see ${v}`).not.toContain(v); }
    for (const v of ['numeric', 'coded', 'third_gender', 'hour', 'year', 'four_column', 'local', 'branch_transfer', 'outsource_branch', 'table', 'hidden', 'clinical', 'package', 'standard', 'microbiology']) expect(flatA, v).toContain(v);
    const need: Record<DataSheet, string[]> = {
      [SHEET.tests]: ['Department Code', 'Category Name', 'Specimen Code', 'Workflow Type', 'Report Type', 'Processing Type'],
      [SHEET.params]: ['Result Type', 'Result Display Type', 'Unit Code', 'Method Code', 'Value Set Code'],
      [SHEET.ranges]: ['Sex', 'Age From Unit', 'Age To Unit', 'Kind', 'Instrument Code', 'Laboratory Code'],
      [SHEET.panels]: ['Panel Kind', 'Member Kind', 'Sex Restriction'],
    };
    for (const s of DATA_SHEETS) {
      const sheet = a.sheets.get(s)!;
      for (const label of need[s]) {
        const col = colName(COLUMNS[s].findIndex((c) => c.label === label));
        const v = sheet.validations.find((x) => x.type === 'list' && x.sqref.split(/[ ,]/).some((r) => r.startsWith(col)));
        expect(v, `${s}/${label} (column ${col}) has a list validation`).toBeTruthy();
        expect(v!.formula1, `${s}/${label} list source is the hidden Lists sheet or an inline list`).toMatch(/Lists!|^"/);
      }
    }
  });
  it('the downloaded template uploaded with no data row is rejected as an empty workbook (never silently accepted)', { timeout: T }, async () => {
    const { upload } = await import('./helpers.js');
    const r = await upload(Buffer.from((await download()).body));
    expect(r.status).toBe(201);
    expect(schemaErrors('CatalogImportValidation', r.body)).toEqual([]);
    expect(r.body.batch.status).toBe('rejected');
    expect(r.body.errors.map((e: any) => e.code)).toContain('workbook_empty');
  });
});
