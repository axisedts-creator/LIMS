// T0B-PRICETOOLS-1 downloadPriceListTemplate over a real PG17 (done_when 3, 6): xlsx by magic bytes, sheets Prices + Instructions, pinned headers, prefilled from the draft or current version, tenant isolation, permission.
import { beforeAll, describe, expect, it } from 'vitest';
import { HEADERS, NONE, READ, SHEET, T, TENANT_A, TENANT_B, XLSX_CT, expectCode, mkList, mkTests, pcall, pfails, publishedList, putItems, draftOf, readWorkbook, req, superTx, uid, world, type TestRef } from './helpers.js';
import type { World } from '../testmgmt/helpers.js';

let w: World; let tests: TestRef[];
beforeAll(async () => { w = await world(TENANT_A); tests = await mkTests(w, 3); }, T);
const get = (id?: string, o: { tenant?: string; grants?: readonly string[] } = {}) => pcall('downloadPriceListTemplate', req({ query: id ? { price_list_id: id } : {} }), o);
const bytesOf = (b: any): Buffer => Buffer.from(b);

describe('the blank template', () => {
  it('200, an xlsx attachment (ZIP magic bytes), contract content type and Content-Disposition', { timeout: T }, async () => {
    const r = await get();
    expect(r.status).toBe(200);
    const b = bytesOf(r.body);
    expect(b.subarray(0, 4).toString('hex'), 'PK\\3\\4').toBe('504b0304');
    const h = Object.fromEntries(Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    expect(h['content-type']).toBe(XLSX_CT);
    expect(h['content-disposition']).toMatch(/^attachment; filename=.*\.xlsx/);
  });
  it('one sheet "Prices" with exactly the pinned header row, and an "Instructions" sheet that states the rules', { timeout: T }, async () => {
    const wb = readWorkbook(bytesOf((await get()).body));
    expect([...wb.sheets.keys()].sort()).toEqual([SHEET.instructions, SHEET.prices].sort());
    expect(wb.sheets.get(SHEET.prices)!.header).toEqual([...HEADERS]);
    const ins = [wb.sheets.get(SHEET.instructions)!.header, ...wb.sheets.get(SHEET.instructions)!.rows].flat().join(' ').toLowerCase();
    for (const needle of ['5000', '5 mb', 'rupee', '2 decimal', 'draft', 'yyyy-mm-dd']) expect(ins, needle).toContain(needle);
  });
  it('the template carries no macro, no external link, no formula cell (a user must be able to upload it back)', { timeout: T }, async () => {
    const wb = readWorkbook(bytesOf((await get()).body));
    const names = [...wb.files.keys()].join(' ');
    expect(names).not.toMatch(/vbaProject|externalLink|activeX|embeddings/);
    for (const s of wb.sheets.values()) expect(s.xml, s.name).not.toMatch(/<f[ >]/);
  });
});

describe('prefilled template (price_list_id)', () => {
  it('rows = the active tests with the prices of the CURRENT version, price in rupees, name read only', { timeout: T }, async () => {
    const pub = await publishedList([{ id: tests[0]!.id, paisa: 1250 }, { id: tests[1]!.id, paisa: 99900 }]);
    const wb = readWorkbook(bytesOf((await get(pub.list.id)).body));
    const rows = wb.sheets.get(SHEET.prices)!.rows;
    const byCode = Object.fromEntries(rows.map((r) => [r[0], r]));
    expect(Number(byCode[tests[0]!.code]![2])).toBe(12.5);
    expect(Number(byCode[tests[1]!.code]![2])).toBe(999);
    expect(byCode[tests[0]!.code]![1], 'name column is filled from the catalogue').toBeTruthy();
    expect(Object.keys(byCode), 'every active test is a row').toEqual(expect.arrayContaining([tests[0]!.code, tests[1]!.code, tests[2]!.code]));
    expect(byCode[tests[2]!.code]![2] ?? '', 'a test without a price in this list has an empty price cell, never 0').toBe('');
  });
  it('a DRAFT version wins over the current one', { timeout: T }, async () => {
    const pub = await publishedList([{ id: tests[0]!.id, paisa: 1000 }]);
    const dr = await draftOf(pub.list.id);
    await putItems(dr.id, [{ id: tests[0]!.id, paisa: 2000 }]);
    const row = readWorkbook(bytesOf((await get(pub.list.id)).body)).sheets.get(SHEET.prices)!.rows.find((r) => r[0] === tests[0]!.code)!;
    expect(Number(row[2])).toBe(20);
  });
  it('a catalogue name that starts with = + - @ is neutralised in the read only column (formula injection out of the template)', { timeout: T }, async () => {
    const t = tests[2]!;
    await superTx(async (tx) => { await tx.query(`UPDATE catalog.orderables SET name = '=HYPERLINK("http://evil.example")' WHERE id = $1`, [t.id]); }, TENANT_A);
    const { list } = await mkList();
    const wb = readWorkbook(bytesOf((await get(list.id)).body));
    const row = wb.sheets.get(SHEET.prices)!.rows.find((r) => r[0] === t.code)!;
    expect(row[1], 'name cell').not.toMatch(/^\s*[=+\-@]/);
    expect(wb.sheets.get(SHEET.prices)!.xml).not.toMatch(/<f[ >]/);
  });
  it('another tenant\'s list and an unknown id both answer 404 common.not_found (same answer)', { timeout: T }, async () => {
    const { list } = await mkList(TENANT_A);
    const e1 = await pfails('downloadPriceListTemplate', req({ query: { price_list_id: list.id } }), { tenant: TENANT_B });
    const e2 = await pfails('downloadPriceListTemplate', req({ query: { price_list_id: uid() } }), { tenant: TENANT_B });
    expectCode(e1, 'common.not_found', 404); expectCode(e2, 'common.not_found', 404);
    expect([e1.code, e1.statusCode, e1.detail]).toEqual([e2.code, e2.statusCode, e2.detail]);
  });
});

describe('permission', () => {
  it('needs catalog.price_list.manage: no grants and read only are 403 auth.forbidden; the handler asked for the permission', { timeout: T }, async () => {
    for (const grants of [NONE, READ]) expectCode(await pfails('downloadPriceListTemplate', req(), { grants }), 'auth.forbidden', 403);
    expect((await get()).assertCalls).toContain('catalog.price_list.manage');
  });
});
