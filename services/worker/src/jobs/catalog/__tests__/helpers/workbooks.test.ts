// Self-check of the T-22 workbook fixtures (workbooks.ts): they must read back the way the T-22 assertions assume.
import { describe, expect, it } from 'vitest';
import { inspectZip } from '../../xlsx/ZipInspector.js';
import { HEADER, containsEicar, eicarSheet, macroXlsx, priceWorkbook, prow, readXlsx, sheetNamed } from './workbooks.js';

describe('workbooks fixtures', () => {
  it('priceWorkbook reads back: Prices header+rows (blank = null, numbers stay numbers), hidden _meta key/value rows', async () => {
    const sheets = await readXlsx(await priceWorkbook([prow('A1', 12.345), prow('A2', '250.00', { name: '=SUM(1)' })]));
    const prices = sheetNamed(sheets, 'Prices')!;
    expect(prices.rows[0]).toEqual(HEADER);
    expect(prices.rows[1]).toEqual(['A1', null, null, null, 12.345]);
    expect(prices.rows[2]).toEqual(['A2', null, '=SUM(1)', null, '250.00']);     // text price stays text; neutralised name restored
    const meta = Object.fromEntries(sheetNamed(sheets, '_meta')!.rows.map((r) => [r[0], r[1]]));
    expect(meta).toMatchObject({ template_kind: 'price_list', template_version: 1, base_version_no: 3 });
  });
  it('crafted ZIPs: EICAR sheet passes the inspector and is visible to a byte scan; macro workbook is refused by it', () => {
    expect(inspectZip(eicarSheet()).ok).toBe(true);
    expect(containsEicar(eicarSheet())).toBe(true);
    expect(inspectZip(macroXlsx())).toEqual({ ok: false, code: 'file.macro_present' });
  });
});
