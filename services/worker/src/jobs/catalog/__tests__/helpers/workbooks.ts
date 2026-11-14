// T-22 (C3) test helper: synthetic price_list workbooks (02-TRD §8.2) built with the T-21 XlsxWriter, plus crafted ZIPs from the T-21 zip fixtures.
import { writeXlsx } from '../../xlsx/XlsxWriter.js';
import { readXlsx, type Sheet } from '../../xlsx/XlsxReader.js';
import { buildZip, minimalXlsxEntries, EICAR, unzip } from '../unit/xlsx/zipfixtures.js';
import { PRICE_LIST_ID } from './validateDb.js';

export { EICAR, unzip, readXlsx };
export const HEADER = ['orderable_code', 'orderable_kind', 'orderable_name', 'department', 'unit_price_npr'];
export type MetaRows = Array<[string, unknown]>;

export const metaFor = (o: { baseVersionNo?: number | null; priceListId?: string; kind?: string; informational?: boolean } = {}): MetaRows => [
  ['template_kind', o.kind ?? 'price_list'],
  ['template_version', 1],
  ['price_list_id', o.priceListId ?? PRICE_LIST_ID],
  ...(o.baseVersionNo === null ? [] : [['base_version_no', o.baseVersionNo ?? 3] as [string, unknown]]),
  // informational keys: the validator never reads them (02-TRD §8.2)
  ...(o.informational === false ? [] : [['price_list_code', 'RETAIL'], ['tenant_catalog_revision', 12], ['exported_at', '2026-11-07T12:00:00Z']] as MetaRows),
];

/** rows are aligned to `header` (default HEADER). meta=false omits the _meta sheet. */
export async function priceWorkbook(rows: unknown[][], o: { header?: string[]; meta?: MetaRows | false; sheet?: string } = {}): Promise<Uint8Array> {
  const sheets: Array<{ name: string; rows: unknown[][]; hidden?: boolean }> = [
    { name: 'Instructions', rows: [['Synthetic price list import template']] },
    { name: o.sheet ?? 'Prices', rows: [o.header ?? HEADER, ...rows] },
  ];
  if (o.meta !== false) sheets.push({ name: '_meta', rows: o.meta ?? metaFor(), hidden: true });
  return writeXlsx(sheets);
}

/** A row in HEADER order. */
export const prow = (code: unknown, price: unknown, o: { kind?: unknown; name?: unknown; dept?: unknown } = {}): unknown[] => [code, o.kind ?? null, o.name ?? null, o.dept ?? null, price];

/** A structurally valid xlsx-shaped ZIP (inspector passes) with stored extra entries — e.g. EICAR in a sheet, or xl/vbaProject.bin. */
export const crafted = (extra: Array<{ name: string; data: string }>): Uint8Array => new Uint8Array(buildZip([...minimalXlsxEntries(), ...extra]));
export const eicarSheet = (): Uint8Array => crafted([{ name: 'xl/worksheets/sheet2.xml', data: `<worksheet><sheetData><row><c t="inlineStr"><is><t>${EICAR}</t></is></c></row></sheetData></worksheet>` }]);
export const macroXlsx = (): Uint8Array => crafted([{ name: 'xl/vbaProject.bin', data: 'synthetic macro payload' }]);
export const containsEicar = (b: Uint8Array) => Buffer.from(b).includes(EICAR);

export const sheetNamed = (sheets: Sheet[], name: string) => sheets.find((s) => s.name === name);
