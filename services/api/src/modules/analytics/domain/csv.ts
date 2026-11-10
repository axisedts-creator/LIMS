// CSV writer (02-TRD §1: RFC 4180 quoting only, UTF-8 with BOM [CONV]; PRD US-17.2/17.3; D-C8-07).
// The formula guard is the shared one (08 A13 P-9); no local copy.
// [CONV] relative import until @lims/shared-ts is a services/api dependency (same as billing/catalog).
import { neutraliseFormula } from '../../../../../../packages/shared-ts/src/spreadsheet/index.js';

export type CsvCell = string | number | null;

const BOM = '﻿';

function cell(v: CsvCell): string {
  if (v === null) return '';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new RangeError('csv: non-finite number');
    const s = String(v); // -0 -> "0"
    if (/e/i.test(s)) throw new RangeError('csv: number needs exponent notation');
    return s;
  }
  if (typeof v !== 'string') throw new TypeError('csv: cell must be string, number or null');
  const s = neutraliseFormula(v); // text cells only; numbers are data
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

/** BOM + every row CRLF-terminated; a field is quoted only if it contains , " CR or LF. */
export function toCsv(rows: readonly (readonly CsvCell[])[]): string {
  return BOM + rows.map((r) => `${r.map(cell).join(',')}\r\n`).join('');
}
