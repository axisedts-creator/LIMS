// AN-T02 domain/csv.ts (02-TRD §1 CSV writer: RFC 4180 quoting only, UTF-8 with BOM [CONV]; PRD US-17.2/17.3; DECISION D-C8-07; 08 A13 P-9).
// The formula guard is NOT implemented here: csv.ts must import neutraliseFormula from @lims/shared-ts/spreadsheet (no local copy, P-9).
// Assumed API (pure):
//   type CsvCell = string | number | null
//   toCsv(rows: readonly (readonly CsvCell[])[]): string
//       '﻿' + every row terminated by CRLF; fields joined by ','; a field is wrapped in "…" (inner " doubled) only if it contains
//       ',' '"' CR or LF; string cells pass neutraliseFormula FIRST (then quoting); number cells are written as plain integers/decimals and are
//       never neutralised (a negative amount is data, not a formula); null -> empty field.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { neutraliseFormula, restoreNeutralised } from '../../../../../../../packages/shared-ts/src/spreadsheet/index.js';
import { toCsv, type CsvCell } from '../csv.js';

const BOM = '﻿';
const body = (s: string): string => {
  expect(s.startsWith(BOM)).toBe(true);
  expect(s.indexOf(BOM, 1)).toBe(-1); // exactly one BOM
  return s.slice(1);
};

/** Minimal strict RFC 4180 reader, independent of the implementation under test. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', i = 0, quoted = false, any = false;
  while (i < text.length) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i += 2; continue; } quoted = false; i++; continue; }
      field += c; i++; continue;
    }
    if (c === '"') { if (field !== '') throw new Error(`stray quote at ${i}`); quoted = true; any = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; any = true; i++; continue; }
    if (c === '\r' && text[i + 1] === '\n') { row.push(field); rows.push(row); row = []; field = ''; any = false; i += 2; continue; }
    if (c === '\n' || c === '\r') throw new Error(`bare line break outside quotes at ${i}`);
    field += c; any = true; i++;
  }
  if (quoted) throw new Error('unterminated quote');
  if (any) { row.push(field); rows.push(row); }
  return rows;
}

describe('structure: BOM, CRLF, delimiter', () => {
  it('starts with one UTF-8 BOM, rows end with CRLF', () => {
    expect(body(toCsv([['a', 'b'], ['1', '2']]))).toBe('a,b\r\n1,2\r\n');
  });
  it('no rows -> only the BOM (a valid empty file)', () => {
    expect(toCsv([])).toBe(BOM);
  });
  it('encodes to UTF-8 with the EF BB BF prefix and keeps Devanagari intact', () => {
    const s = toCsv([['नमस्ते', 'पुरानो']]);
    const bytes = Buffer.from(s, 'utf8');
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(parseCsv(body(s))).toEqual([['नमस्ते', 'पुरानो']]);
  });
  it('rows may have different widths (header block lines have one cell)', () => {
    expect(body(toCsv([['Internal MIS — not a statutory register'], ['a', 'b', 'c']]))).toBe('Internal MIS — not a statutory register\r\na,b,c\r\n');
  });
});

describe('RFC 4180 quoting — and nothing more', () => {
  it('plain fields (spaces, apostrophes, semicolons, tabs inside) stay unquoted', () => {
    expect(body(toCsv([['hello world', "it's", 'a;b', 'x\ty']]))).toBe("hello world,it's,a;b,x\ty\r\n");
  });
  it('comma -> quoted', () => {
    expect(body(toCsv([['Kathmandu, Lalitpur']]))).toBe('"Kathmandu, Lalitpur"\r\n');
  });
  it('double quote -> quoted with the quote doubled', () => {
    expect(body(toCsv([['say "hi"']]))).toBe('"say ""hi"""\r\n');
  });
  it('LF and CR inside a field -> quoted, kept verbatim', () => {
    expect(body(toCsv([['l1\nl2'], ['c1\rc2']]))).toBe('"l1\nl2"\r\n"c1\rc2"\r\n');
  });
  it('empty string and null are empty fields; a lone empty field row is not dropped', () => {
    expect(body(toCsv([['a', '', null, 'd']]))).toBe('a,,,d\r\n');
    expect(parseCsv(body(toCsv([['a'], ['']])))).toEqual([['a'], ['']]);
  });
  it('no backslash escaping, no HTML escaping, no trimming', () => {
    expect(body(toCsv([['a\\b', '<b>&', '  padded  ']]))).toBe('a\\b,<b>&,  padded  \r\n');
  });
});

describe('numbers: written as data, never neutralised (US-17.3 applies to TEXT cells)', () => {
  it('integers, negative paisa, zero', () => {
    expect(body(toCsv([[1250000, -600, 0, -0]]))).toBe('1250000,-600,0,0\r\n');
  });
  it('a text cell that looks like a number IS text and is neutralised when it starts with a trigger', () => {
    expect(body(toCsv([['-600']]))).toBe("'-600\r\n");
  });
  it('non-finite numbers are rejected rather than written as NaN/Infinity', () => {
    for (const n of [NaN, Infinity, -Infinity]) expect(() => toCsv([[n]])).toThrow();
  });
});

describe('US-17.3 formula injection: text cells beginning with = + - @ TAB CR get a leading apostrophe', () => {
  const triggers: Array<[string, string]> = [
    ['=SUM(A1:A9)', "'=SUM(A1:A9)"],
    ['+1+1', "'+1+1"],
    ['-2+3', "'-2+3"],
    ['@SUM(1)', "'@SUM(1)"],
    ['=cmd|\' /C calc\'!A0', "'=cmd|' /C calc'!A0"],
    ['=HYPERLINK("http://evil","x")', `"'=HYPERLINK(""http://evil"",""x"")"`], // neutralise first, THEN quote
    ['=1,2', `"'=1,2"`],
  ];
  it.each(triggers)('%j', (input, want) => {
    expect(body(toCsv([[input]]))).toBe(`${want}\r\n`);
  });
  it('leading TAB is neutralised (and stays unquoted)', () => {
    expect(body(toCsv([['\t=1']]))).toBe("'\t=1\r\n");
  });
  it('leading CR is neutralised AND the field is quoted (it contains a CR)', () => {
    expect(body(toCsv([['\r=1']]))).toBe('"\'\r=1"\r\n');
  });
  it('a trigger anywhere but position 0 is left alone', () => {
    expect(body(toCsv([['a=b', 'x+y', 'user@host', 'a-b', ' =1']]))).toBe('a=b,x+y,user@host,a-b, =1\r\n');
  });
  it('every cell of a row is guarded, not just the first; header-block cells too', () => {
    expect(body(toCsv([['ok', '=1', '@x', '-y']]))).toBe("ok,'=1,'@x,'-y\r\n");
  });
  it('matches the shared guard exactly on a corpus (incl. the leading apostrophe case the shared guard also covers)', () => {
    const corpus = ['', 'plain', '=', '+', '-', '@', '\t', '\r', "'", "'=1", '==1', '--1', '=1+1', '+49 170', 'नमस्ते', '=नमस्ते', 'a"b', 'a,b', '=a,"b"'];
    for (const s of corpus) {
      const got = parseCsv(body(toCsv([[s]])));
      if (s === '') { expect(got).toEqual([['']]); continue; }
      expect(got).toEqual([[neutraliseFormula(s)]]);
    }
  });
  it('round trip: parse + restoreNeutralised gives back the original text for every cell', () => {
    const rows: CsvCell[][] = [
      ['Name', 'Note'],
      ['=1+1', 'line1\nline2'],
      ["'quoted", 'a,b,"c"'],
      ['@user', '\t-1'],
      ['नमस्ते', '+977-1-4000000'],
    ];
    const parsed = parseCsv(body(toCsv(rows)));
    expect(parsed.map((r) => r.map(restoreNeutralised))).toEqual(rows);
  });
});

describe('structural safety', () => {
  it('output is always parseable and cell-count preserving, whatever the content (deterministic fuzz)', () => {
    const alphabet = ['a', 'Z', '0', ' ', ',', '"', '\n', '\r', '\t', '=', '+', '-', '@', "'", 'न', '\\', ';'];
    let seed = 12345;
    const rnd = (n: number) => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) % n;
    for (let t = 0; t < 300; t++) {
      const rows: string[][] = Array.from({ length: 1 + rnd(4) }, () => Array.from({ length: 1 + rnd(5) }, () => Array.from({ length: rnd(8) }, () => alphabet[rnd(alphabet.length)]!).join('')));
      const parsed = parseCsv(body(toCsv(rows)));
      expect(parsed.map((r) => r.map(restoreNeutralised))).toEqual(rows);
    }
  });
  it('a hostile cell cannot add a column or a row', () => {
    const parsed = parseCsv(body(toCsv([['x", "y\r\nINJECTED,ROW', 'z']])));
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toHaveLength(2);
  });
  it('does not mutate its input', () => {
    const rows: CsvCell[][] = [['=1', 2, null]];
    const snap = JSON.stringify(rows);
    toCsv(rows);
    expect(JSON.stringify(rows)).toBe(snap);
  });
});

describe('P-9: the injection guard is the shared one, not a local copy', () => {
  const src = readFileSync(fileURLToPath(new URL('../csv.ts', import.meta.url)), 'utf8');
  it('csv.ts imports neutraliseFormula from the shared spreadsheet module', () => {
    expect(src).toMatch(/import\s*\{[^}]*\bneutraliseFormula\b[^}]*\}\s*from\s*['"][^'"]*spreadsheet[^'"]*['"]/);
  });
  it('csv.ts defines no formula guard of its own', () => {
    expect(src).not.toMatch(/(function\s+|(?:const|let|var)\s+)(neutraliseFormula|neutralizeFormula|restoreNeutralised|escapeFormula\w*|sanitiz\w*Formula\w*|formulaGuard\w*)\b/);
    expect(src).not.toMatch(/\[\s*['"]=['"]\s*,\s*['"]\+['"]/); // no local trigger list
    expect(src).not.toMatch(/\/\^?\[=\+\-@/); // no local trigger regex
  });
});
