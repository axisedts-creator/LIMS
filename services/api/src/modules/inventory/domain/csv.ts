// C12.T-12 in-module RFC 4180 writer (02-TRD §3; 08 A13 P-9): UTF-8 BOM, CRLF row ends, quoting for , " CR LF.
// Every STRING cell passes the shared neutraliseFormula first (no module-local guard); numbers / bigints / `Dec` are plain decimal text and never neutralised.
import { neutraliseFormula } from '../../../../../../packages/shared-ts/src/spreadsheet/index.js';

/** T-19: an exact decimal string ("-2.500000") that is data, not text: written as is (a negative quantity must not become `'-2.500000`). */
export class Dec {
  readonly text: string;
  constructor(text: string) { this.text = text; }
}
export type CsvCell = string | number | bigint | Dec | null | undefined;

const quote = (s: string): string => (/[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s);
const cell = (v: CsvCell): string => (v === null || v === undefined ? '' : typeof v === 'string' ? quote(neutraliseFormula(v)) : v instanceof Dec ? v.text : String(v));

export function toCsv(header: readonly string[], rows: readonly (readonly CsvCell[])[]): string {
  return `﻿${[header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n')}\r\n`;
}
