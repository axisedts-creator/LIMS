// @lims/shared-ts/spreadsheet (08 §4.13, A13 P-9; 02-CV §10.2 "Spreadsheets"): the one CSV/XLSX injection guard.
// Every XLSX/CSV text cell written by product code passes neutraliseFormula; importers apply restoreNeutralised
// before validation. Module-local copies are banned (lint: no-local-spreadsheet-guard).

const LEADING = new Set(['=', '+', '-', '@', '\t', '\r', "'"]);

/** Prefixes "'" when the cell starts with = + - @ \t \r or "'". */
export function neutraliseFormula(cell: string): string {
  return cell.length > 0 && LEADING.has(cell[0] as string) ? `'${cell}` : cell;
}

/** Strips exactly one leading "'"; restoreNeutralised(neutraliseFormula(s)) === s for all s. */
export function restoreNeutralised(cell: string): string {
  return cell.startsWith("'") ? cell.slice(1) : cell;
}
