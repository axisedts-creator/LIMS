// T0B-PRICETOOLS-1 dryRunPriceListImport over a real PG17 under RLS (done_when 2, 3, 6, 7): the dry run NEVER writes a price; every rule is validated in the domain layer and ALL errors are
// collected with row and column; the file is checked by magic bytes and size before parsing; macros, external links, formula cells, zip bombs and renamed csv files are refused.
// File level refusals are problem+json and record nothing; row level problems are errors of a batch in status dry_run (HTTP 201).
import { randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { SYS_ACTOR, T, TENANT_A, TENANT_B, allBatches, batchErrors, batchRow, buildXlsx, dry, dryRun, dryRunFails, errKeys, expectCode, expectRowError, itemRows, listSnapshot, mkList, mkTests, pfails, priceBook, publishedList,
  rowsFor, sha, superTx, uid, versionRows, world, type TestRef, req } from './helpers.js';
import { zipDeflate } from '../import/xlsx.js';
import type { World } from '../testmgmt/helpers.js';

let w: World; let tests: TestRef[]; let L: Awaited<ReturnType<typeof mkList>>; let other: TestRef[];
beforeAll(async () => {
  w = await world(TENANT_A); tests = await mkTests(w, 12); L = await mkList();
  other = await mkTests(await world(TENANT_B), 1);       // a test code of ANOTHER tenant: must read as "not found"
}, T);

/** refused at file level: right problem, and nothing recorded, nothing written */
async function refused(bytes: Uint8Array, code: string, status: number): Promise<void> {
  const before = await listSnapshot(L.list.id); const n0 = (await allBatches(L.list.id)).length;
  expectCode(await dryRunFails(L.list.id, bytes), code, status);
  expect(await listSnapshot(L.list.id), 'price data untouched').toEqual(before);
  expect((await allBatches(L.list.id)).length, 'no batch recorded for a refused file').toBe(n0);
}
const INVALID = 'catalog.import_invalid_file'; const UNSUP = 'common.unsupported_media_type'; const TOO_BIG = 'common.payload_too_large';
const good = () => priceBook(rowsFor(tests.slice(0, 2), (i) => 10 + i));

describe('a clean file', () => {
  it('201, batch status dry_run, counts, sha256 of the file, no error; the batch row is stored with a file reference and the actor', { timeout: T }, async () => {
    const bytes = priceBook(rowsFor(tests.slice(0, 3), (i) => 100 + i));
    const r = await dry(L.list.id, bytes);
    expect(r.batch).toMatchObject({ price_list_id: L.list.id, status: 'dry_run', row_count: 3, error_count: 0, file_sha256: sha(bytes), created_by: SYS_ACTOR });
    expect(r.errors).toEqual([]);
    expect(r.batch.summary).toMatchObject({ rows: 3, errors: 0 });
    const db = await batchRow(r.batch.id);
    expect(db.status).toBe('dry_run'); expect(String(db.file_ref).length).toBeGreaterThan(0); expect(String(db.file_ref).length).toBeLessThanOrEqual(512);
    expect(db.result_price_list_version_id).toBeNull();
  });
  it('THE DRY RUN NEVER WRITES A PRICE: no price item, no version, no write statement on the price tables', { timeout: T }, async () => {
    const before = await listSnapshot(L.list.id);
    const r = await dryRun(L.list.id, priceBook(rowsFor(tests.slice(0, 4), () => 55)));
    expect(r.status).toBe(201);
    const after = await listSnapshot(L.list.id);
    expect(after.items, 'items').toBe(before.items); expect(after.versions, 'versions').toBe(before.versions);
    expect(r.writes.filter((s) => /price_list_(items|versions)\b/i.test(s)), 'write statements on items / versions').toEqual([]);
  });
  it('the summary compares with the CURRENT version: added / changed / unchanged', { timeout: T }, async () => {
    const pub = await publishedList([{ id: tests[0]!.id, paisa: 1000 }, { id: tests[1]!.id, paisa: 2000 }]);
    const r = await dry(pub.list.id, priceBook([{ code: tests[0]!.code, price: 10 }, { code: tests[1]!.code, price: 25 }, { code: tests[2]!.code, price: 30 }]));
    expect(r.batch.summary).toMatchObject({ rows: 3, added: 1, changed: 1, unchanged: 1, errors: 0 });
  });
  it('exact decimals are valid: 19.99, 0.29, 4.35, 8.2, 1.15 (float traps), a text cell "12.50", 0 and the 9999999.99 ceiling; trailing blank rows are ignored', { timeout: T }, async () => {
    const rows = [19.99, 0.29, 4.35, 8.2, 1.15, '12.50', 0, 9999999.99].map((p, i) => ({ code: tests[i]!.code, price: p }));
    const r = await dry(L.list.id, priceBook([...rows, {}, {}]));
    expect(r.errors, JSON.stringify(r.errors)).toEqual([]);
    expect(r.batch.row_count).toBe(8);
  });
  it('a valid effective from (YYYY-MM-DD) or none at all', { timeout: T }, async () => {
    const r = await dry(L.list.id, priceBook([{ code: tests[0]!.code, price: 5, from: '2026-11-17' }, { code: tests[1]!.code, price: 6 }]));
    expect(r.errors).toEqual([]);
  });
  it('the test code is trimmed (a stray space from Excel is not an error)', { timeout: T }, async () => {
    expect((await dry(L.list.id, priceBook([{ code: `  ${tests[0]!.code} `, price: 5 }]))).errors).toEqual([]);
  });
});

describe('VALIDATION: every rule, all errors together with row and column (done_when 3)', () => {
  it('price rules: more than 2 decimals, negative, not a number, comma, currency symbol, exponent, above the ceiling, empty', { timeout: T }, async () => {
    const bad: Array<[any, string]> = [[1.005, 'price_invalid'], [12.345, 'price_invalid'], [-1, 'price_invalid'], ['abc', 'price_invalid'], ['1,250', 'price_invalid'], ['Rs 100', 'price_invalid'],
      ['1E3', 'price_invalid'], [10000000, 'price_invalid'], [undefined, 'required_missing']];
    const r = await dry(L.list.id, priceBook(bad.map(([p], i) => ({ code: tests[i]!.code, price: p }))));
    bad.forEach(([, code], i) => expectRowError(r, i + 2, 'price_rupees', code));
    expect(r.batch.error_count).toBe(r.errors.length);
  });
  it('test code rules: empty, unknown, inactive, another tenant\'s code (indistinguishable from unknown)', { timeout: T }, async () => {
    const inactive = (await mkTests(w, 1))[0]!;
    await superTx(async (tx) => { await tx.query(`UPDATE catalog.orderables SET is_active = false WHERE id = $1`, [inactive.id]); }, TENANT_A);
    const r = await dry(L.list.id, priceBook([{ code: '', price: 1 }, { code: 'NOSUCHCODE9', price: 1 }, { code: inactive.code, price: 1 }, { code: other[0]!.code, price: 1 }]));
    expectRowError(r, 2, 'test_code', 'required_missing');
    for (const row of [3, 4, 5]) expectRowError(r, row, 'test_code', 'code_not_found');
    const msgs = r.errors.filter((e) => e.row_no === 5).map((e) => e.message).join(' ');
    expect(msgs, 'the message does not reveal that another tenant owns the code').not.toMatch(/tenant|another|other/i);
  });
  it('duplicate test code in the file: EVERY occurrence is reported', { timeout: T }, async () => {
    const r = await dry(L.list.id, priceBook([{ code: tests[0]!.code, price: 1 }, { code: tests[1]!.code, price: 2 }, { code: tests[0]!.code, price: 3 }, { code: tests[0]!.code, price: 4 }]));
    for (const row of [2, 4, 5]) expectRowError(r, row, 'test_code', 'code_duplicate');
    expect(errKeys(r)).not.toContain('3|test_code|code_duplicate');
  });
  it('effective from: not a date, impossible date, wrong format', { timeout: T }, async () => {
    const r = await dry(L.list.id, priceBook([{ code: tests[0]!.code, price: 1, from: 'next week' }, { code: tests[1]!.code, price: 1, from: '2026-02-30' }, { code: tests[2]!.code, price: 1, from: '17/11/2026' }]));
    for (const row of [2, 3, 4]) expectRowError(r, row, 'effective_from', 'date_invalid');
  });
  it('formula injection: text cells starting with = + - @ (also after spaces) are rejected in code, price and date, each one listed', { timeout: T }, async () => {
    const r = await dry(L.list.id, priceBook([{ code: '=1+1', price: 1 }, { code: tests[0]!.code, price: '=SUM(1,1)' }, { code: tests[1]!.code, price: '+5' }, { code: tests[2]!.code, price: '-5' },
      { code: tests[3]!.code, price: '@A1' }, { code: tests[4]!.code, price: ' =1', from: '-1' }]));
    expectRowError(r, 2, 'test_code', 'formula_rejected');
    for (const row of [3, 4, 5, 6, 7]) expectRowError(r, row, 'price_rupees', 'formula_rejected');
    expectRowError(r, 7, 'effective_from', 'formula_rejected');
  });
  it('ALL errors are returned together (not only the first), persisted one row each, and the batch count equals the list', { timeout: T }, async () => {
    const r = await dry(L.list.id, priceBook([{ code: 'NOSUCH1', price: 1 }, { code: tests[0]!.code, price: 'x' }, { code: tests[1]!.code, price: 1.234 }, { code: tests[2]!.code, price: 5, from: 'bad' }, { code: '', price: '' }, { code: tests[3]!.code, price: 7 }]));
    expect(r.errors.length).toBeGreaterThanOrEqual(5);
    expect(r.batch).toMatchObject({ status: 'dry_run', error_count: r.errors.length, row_count: 6 });
    expect(new Set(r.errors.map((e) => e.row_no)).size, 'more than one row has an error').toBeGreaterThan(1);
    for (const e of r.errors) { expect(e.row_no).toBeGreaterThanOrEqual(2); expect(e.column).toMatch(/^(test_code|price_rupees|effective_from)$/); expect(e.message.length).toBeLessThanOrEqual(300); }
    const db = await batchErrors(r.batch.id);
    expect(db.map((x: any) => `${x.row_no}|${x.column_name}|${x.code}`).sort()).toEqual(errKeys(r).sort());
    expect(r.batch.summary.errors).toBe(r.errors.length);
  });
  it('the test name column is read only: whatever it holds is ignored', { timeout: T }, async () => {
    const r = await dry(L.list.id, priceBook([{ code: tests[0]!.code, name: 'Renamed in Excel', price: 5 }, { code: tests[1]!.code, name: '', price: 6 }]));
    expect(r.errors).toEqual([]);
  });
  it('a huge cell (32 000 characters) is an error with a short message: nothing exceeds the 300 / 40 character columns, the value is not stored', { timeout: T }, async () => {
    const big = 'x'.repeat(32_000);
    const r = await dry(L.list.id, priceBook([{ code: big, price: 1 }, { code: tests[0]!.code, price: big }]));
    expect(r.errors.length).toBeGreaterThanOrEqual(2);
    for (const e of r.errors) { expect(e.message.length).toBeLessThanOrEqual(300); expect(e.column.length).toBeLessThanOrEqual(40); expect(e.message).not.toContain(big.slice(0, 50)); }
    for (const x of await batchErrors(r.batch.id)) expect(String(x.message)).not.toContain(big.slice(0, 50));
  });
  it('control characters and NUL in a cell do not crash the import (error or normalised, never a 500)', { timeout: T }, async () => {
    const r = await dryRun(L.list.id, priceBook([{ code: `${tests[0]!.code}\u0007\u0000`, price: 1 }, { code: tests[1]!.code, price: '1\u0000' }]));
    expect(r.status).toBe(201);
  });
});

describe('the file is checked by magic bytes and size BEFORE parsing; active content is refused (done_when 3)', () => {
  it('random garbage, an empty file, a pdf, an old binary xls (OLE2) and a csv renamed .xlsx (declared xlsx) -> 415', { timeout: T }, async () => {
    await refused(randomBytes(64 * 1024), UNSUP, 415);
    await refused(new Uint8Array(0), UNSUP, 415);
    await refused(Buffer.from('%PDF-1.7\n1 0 obj<<>>endobj\n%%EOF'), UNSUP, 415);
    await refused(Buffer.concat([Buffer.from('d0cf11e0a1b11ae1', 'hex'), randomBytes(4096)]), UNSUP, 415);
    await refused(Buffer.from('Test Code,Test Name,Price (Rs),Effective From\nSYN01,Synthetic,10,\n'), UNSUP, 415);
  });
  it('a ZIP that is not a workbook, a truncated xlsx, a workbook with no "Prices" sheet or other headers -> 422 catalog.import_invalid_file', { timeout: T }, async () => {
    await refused(zipDeflate({ 'readme.txt': 'hello' }), INVALID, 422);
    await refused(good().subarray(0, 600), INVALID, 422);
    await refused(priceBook(rowsFor(tests.slice(0, 1), () => 1), { sheet: 'Sheet1' }), INVALID, 422);
    await refused(priceBook(rowsFor(tests.slice(0, 1), () => 1), { headers: ['Code', 'Name', 'Rate', 'Date'] }), INVALID, 422);
  });
  it('xlsm (vbaProject part), macro enabled content type, external link part, external relationship, embedded OLE object, ActiveX -> 422', { timeout: T }, async () => {
    const rows = rowsFor(tests.slice(0, 1), () => 1);
    await refused(priceBook(rows, { extra: { 'xl/vbaProject.bin': randomBytes(512) } }), INVALID, 422);
    await refused(priceBook(rows, { macroContentType: true }), INVALID, 422);
    await refused(priceBook(rows, { extra: { 'xl/externalLinks/externalLink1.xml': '<externalLink xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>' } }), INVALID, 422);
    await refused(priceBook(rows, { relsExtra: '<Relationship Id="rId99" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/externalLink" Target="file:///C:/secret.xlsx" TargetMode="External"/>' }), INVALID, 422);
    await refused(priceBook(rows, { extra: { 'xl/embeddings/oleObject1.bin': randomBytes(256) } }), INVALID, 422);
    await refused(priceBook(rows, { extra: { 'xl/activeX/activeX1.xml': '<ocx/>' } }), INVALID, 422);
  });
  it('a real formula cell (<f>) in the price column, and in a hidden sheet, -> 422 (a formula is never evaluated, never accepted)', { timeout: T }, async () => {
    await refused(priceBook([{ code: tests[0]!.code, price: { f: 'SUM(1,1)' } }]), INVALID, 422);
    await refused(buildXlsx([{ name: 'Prices', rows: [['Test Code', 'Test Name', 'Price (Rs)', 'Effective From']] }, { name: 'Hidden', rows: [[{ f: 'HYPERLINK("http://x")' }]], state: 'hidden' }]), INVALID, 422);
  });
  it('XML entity expansion (billion laughs) and an external entity (XXE) -> 422', { timeout: T }, async () => {
    const bomb = '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;"><!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;">]><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets><sheet name="&c;" sheetId="1" r:id="rId1" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/></sheets></workbook>';
    await refused(priceBook(rowsFor(tests.slice(0, 1), () => 1), { extra: { 'xl/workbook.xml': bomb } }), INVALID, 422);
    const xxe = '<?xml version="1.0"?><!DOCTYPE s [<!ENTITY x SYSTEM "file:///etc/passwd">]><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>&x;</t></is></c></row></sheetData></worksheet>';
    await refused(priceBook(rowsFor(tests.slice(0, 1), () => 1), { extra: { 'xl/worksheets/sheet2.xml': xxe } }), INVALID, 422);
  });
  it('ZIP BOMB: a small file whose parts inflate to ~400 MB (blank sheet) or 300 MB (zeros) is refused before parsing (the uncompressed size is capped)', { timeout: 180_000 }, async () => {
    const a = priceBook(rowsFor(tests.slice(0, 1), () => 1), { extra: { 'xl/worksheets/sheet99.xml': Buffer.alloc(400 * 1024 * 1024, 0x20) }, level: 1 });
    expect(a.length, 'the bomb itself is small').toBeLessThan(2 * 1024 * 1024);
    await refused(a, INVALID, 422);
    await refused(priceBook(rowsFor(tests.slice(0, 1), () => 1), { extra: { 'docProps/junk.bin': Buffer.alloc(300 * 1024 * 1024, 0) }, level: 1 }), INVALID, 422);
  });
  it('ZIP BOMB: the Prices sheet itself inflates far beyond any real sheet (200 MB of rows)', { timeout: 180_000 }, async () => {
    const rows = '<row r="2"><c r="A2" t="inlineStr"><is><t>x</t></is></c></row>'.repeat(3_500_000);
    await refused(priceBook(rowsFor(tests.slice(0, 1), () => 1), { extra: { 'xl/worksheets/sheet2.xml': `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>` }, level: 1 }), INVALID, 422);
  });
  it('too many ZIP entries (3000 tiny parts) -> 422', { timeout: T }, async () =>
    refused(priceBook(rowsFor(tests.slice(0, 1), () => 1), { extra: Object.fromEntries(Array.from({ length: 3000 }, (_, i) => [`customXml/p${i}.xml`, '<a/>'])) }), INVALID, 422));
  it('more than 5 MB -> 413 common.payload_too_large', { timeout: T }, async () => {
    const big = priceBook(rowsFor(tests.slice(0, 1), () => 1), { extra: { 'docProps/pad.bin': randomBytes(5 * 1024 * 1024 + 1024) } });
    expect(big.length).toBeGreaterThan(5 * 1024 * 1024);
    await refused(big, TOO_BIG, 413);
  });
  it('more than 5000 data rows -> 413 common.payload_too_large (5001 rows)', { timeout: 180_000 }, async () => {
    await refused(priceBook(Array.from({ length: 5001 }, (_, i) => ({ code: `R${i}`, price: 1 }))), TOO_BIG, 413);
  });
});

describe('the list in the path', () => {
  it('an unknown list and another tenant\'s list both answer 404 common.not_found, the same answer, and record nothing', { timeout: T }, async () => {
    const mine = await mkList(TENANT_A);
    const versionsBefore = await versionRows(mine.list.id); // createPriceList makes an empty draft v1 (ruling 1): compare against it
    const e1 = await pfails('dryRunPriceListImport', req({ params: { price_list_id: mine.list.id }, headers: { 'idempotency-key': uid() }, body: { file: { filename: 'p.xlsx', mimeType: 'x', bytes: good() } } }), { tenant: TENANT_B });
    const e2 = await pfails('dryRunPriceListImport', req({ params: { price_list_id: uid() }, headers: { 'idempotency-key': uid() }, body: { file: { filename: 'p.xlsx', mimeType: 'x', bytes: good() } } }), { tenant: TENANT_B });
    expectCode(e1, 'common.not_found', 404); expectCode(e2, 'common.not_found', 404);
    expect([e1.code, e1.statusCode, e1.detail]).toEqual([e2.code, e2.statusCode, e2.detail]);
    expect(await allBatches(mine.list.id)).toEqual([]);
    expect(await versionRows(mine.list.id)).toEqual(versionsBefore);
    expect(await itemRows(uid())).toEqual([]);
  });
});
