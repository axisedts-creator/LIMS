// C12.T-12 unit tests for domain/csv.ts (02-TRD §3: "in-module RFC 4180 writer, UTF-8 BOM; every text cell passes neutraliseFormula from @lims/shared-ts/spreadsheet, no module-local neutraliser", P-9).
// PINNED INTERFACE (the spec names the file, not the function; the writer may dispute through the reviewer):
//   export function toCsv(header: readonly string[], rows: readonly (readonly (string | number | bigint | null | undefined)[])[]): string
// => '﻿' + header row + one line per row, cells joined by ',', rows ended by CRLF. A cell with ',', '"', CR or LF is wrapped in double quotes with inner quotes doubled; null / undefined => empty cell;
// numbers / bigints are written as plain decimal text (never prefixed); every STRING cell goes through neutraliseFormula FIRST (a leading = + - @ TAB CR or ' gets a ' prefix), then quoting.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { csvObjects, parseCsv } from '../../handlers/__tests__/receipts.helpers.js';
import { toCsv } from '../csv.js';

const body = (s: string) => s.replace(/^﻿/, '').replace(/\r\n$/, '');

describe('T-12 domain/csv.ts toCsv (RFC 4180, UTF-8 BOM, P-9)', () => {
  it('starts with exactly one UTF-8 BOM, then the header, rows end with CRLF', () => {
    const t = toCsv(['a', 'b'], [['x', 'y'], ['z', 'w']]);
    expect(t.charCodeAt(0)).toBe(0xfeff);
    expect(t.charCodeAt(1)).not.toBe(0xfeff);
    expect(body(t)).toBe('a,b\r\nx,y\r\nz,w');
    expect(t.split('\r\n').length - 1).toBeGreaterThanOrEqual(2); // CRLF between rows, never a bare LF
    expect(t.replace(/\r\n/g, '').includes('\n')).toBe(false);
  });
  it('no rows => BOM + header only', () => { expect(body(toCsv(['a', 'b'], []))).toBe('a,b'); });
  it('quotes a cell containing a comma, a double quote, an LF or a CR; doubles inner quotes', () => {
    expect(body(toCsv(['h'], [['a,b']]))).toBe('h\r\n"a,b"');
    expect(body(toCsv(['h'], [['say "hi"']]))).toBe('h\r\n"say ""hi"""');
    expect(body(toCsv(['h'], [['l1\nl2']]))).toBe('h\r\n"l1\nl2"');
    expect(body(toCsv(['h'], [['l1\r\nl2']]))).toBe('h\r\n"l1\r\nl2"');
  });
  it('a quoted multi-line cell round-trips through an RFC 4180 reader', () => {
    const rows = [['plain', 'a,b', 'say "hi"', 'l1\nl2', '']];
    expect(parseCsv(toCsv(['c1', 'c2', 'c3', 'c4', 'c5'], rows))[1]).toEqual(rows[0]);
  });
  it('null and undefined are empty cells; numbers and bigints are plain decimal text', () => {
    expect(body(toCsv(['a', 'b', 'c', 'd', 'e'], [[null, undefined, 0, 1234567, 9007199254740993n]]))).toBe('a,b,c,d,e\r\n,,0,1234567,9007199254740993');
  });
  it('P-9: a string cell starting with = + - @ TAB CR or \' is prefixed with an apostrophe (one per cell)', () => {
    const cells = ['=1+1', '+SUM(A1)', '-2+3', '@cmd', '\tx', "'already", '=HYPERLINK("http://x")'];
    const out = parseCsv(toCsv(cells.map((_, i) => `c${i}`), [cells]))[1] as string[];
    expect(out).toEqual(["'=1+1", "'+SUM(A1)", "'-2+3", "'@cmd", "'\tx", "''already", `'=HYPERLINK("http://x")`]);
  });
  it('P-9 then quoting: a neutralised cell that also needs quotes is "\'...\"', () => {
    expect(body(toCsv(['h'], [['=a,b']]))).toBe('h\r\n"\'=a,b"');
    const [, row] = parseCsv(toCsv(['h'], [['\rx']]));
    expect(row).toEqual(["'\rx"]);
  });
  it('cells that do not start with a trigger are untouched (also a trigger in the middle)', () => {
    expect(parseCsv(toCsv(['a', 'b'], [['a=1', 'GRN-1 -x']]))[1]).toEqual(['a=1', 'GRN-1 -x']);
    expect(parseCsv(toCsv(['a'], [['']]))[1]).toEqual(['']);
  });
  it('numbers are never neutralised (a number is not a text cell)', () => { expect(parseCsv(toCsv(['a', 'b'], [[1300, 0]]))[1]).toEqual(['1300', '0']); });
  it('every row has as many cells as the header (csvObjects reads it back by column name)', () => {
    const { header, rows } = csvObjects(toCsv(['grn_no', 'lot_no'], [['GR1', '=x'], ['GR2', 'ok']]));
    expect(header).toEqual(['grn_no', 'lot_no']);
    expect(rows).toEqual([{ grn_no: 'GR1', lot_no: "'=x" }, { grn_no: 'GR2', lot_no: 'ok' }]);
  });
  it('P-9 source rule: csv.ts uses the shared neutraliseFormula and defines no neutraliser of its own', () => {
    const src = readFileSync(fileURLToPath(new URL('../csv.ts', import.meta.url)), 'utf8');
    expect(src).toMatch(/neutraliseFormula/);
    expect(src).toMatch(/shared-ts[\\/](src[\\/])?spreadsheet/);
    expect(src).not.toMatch(/(function|const|let)\s+neutrali[sz]e\w*\s*[=(]/);
    expect(src).not.toMatch(/restoreNeutralised/);
  });
});
