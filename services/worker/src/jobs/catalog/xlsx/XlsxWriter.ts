// 02-TRD §8.2 guard: every text cell C3 writes (templates, exports, annotated reports incl. untrusted cells
// re-emitted from an upload) goes through neutraliseFormula; numbers are number cells; nothing is a formula.
// The only module that imports write-excel-file 4.1.1 (§3.1 confinement).
import { neutraliseFormula } from '@lims/shared-ts/spreadsheet';

export type SheetIn = { name: string; rows: unknown[][]; hidden?: boolean };

const cell = (v: unknown) => {
  if (typeof v === 'string') return { value: neutraliseFormula(v), type: String };
  if (typeof v === 'number' || typeof v === 'boolean' || v instanceof Date) return v;
  if (v === null || v === undefined) return null;
  return { value: neutraliseFormula(String(v)), type: String };
};

export async function writeXlsx(sheets: SheetIn[]): Promise<Uint8Array> {
  const { default: writeXlsxFile } = await import('write-excel-file/node');
  const hidden = new Set(sheets.flatMap((s, i) => (s.hidden ? [i] : [])));
  // write-excel-file has no hidden-sheet option; its feature hook sets state="hidden" on <sheet> in xl/workbook.xml.
  const hideSheets = {
    files: { transform: { 'xl/workbook.xml': {
      transformElementAttributes: (tag: string, attrs: Record<string, string | number>, index: number | undefined) =>
        tag === 'sheet' && index !== undefined && hidden.has(index) ? { ...attrs, state: 'hidden' } : attrs,
    } } },
  };
  const buf = await writeXlsxFile(
    sheets.map((s) => ({ sheet: s.name, dateFormat: 'yyyy-mm-dd', data: s.rows.map((r) => r.map(cell)) })),
    { features: [hideSheets] },
  ).toBuffer();
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}
