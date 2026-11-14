// C10 T-12 unit — csv/parser.ts (02-TRD §9.1: RFC 4180 quoting, LF/CRLF, blank lines + `#` comments ignored; 02-TRD §11 unit list "CSV parser").
// SEAM (spec silent): `parseCsv(text: string): { records: { line: number; fields: string[] }[]; unbalancedQuote: boolean }` — pure, no I/O.
//   `line` = 1-based PHYSICAL line where the record starts (a quoted field may span lines). BOM / UTF-8 / NUL are handled by breakpoint-file.ts (its test).
import { describe, expect, it } from 'vitest';
import { parseCsv } from '../../csv/parser.js';

const fields = (text: string) => parseCsv(text).records.map((r) => r.fields);

describe('C10-T12 parseCsv', () => {
  it('splits on commas, LF and CRLF alike, keeps empty cells and a missing final newline', () => {
    expect(fields('a,b,,d\nx,y,z,\n')).toEqual([['a', 'b', '', 'd'], ['x', 'y', 'z', '']]);
    expect(fields('a,b\r\nc,d\r\ne,f')).toEqual([['a', 'b'], ['c', 'd'], ['e', 'f']]);
    expect(parseCsv('a,b\r\nc,d\r\n').unbalancedQuote).toBe(false);
  });

  it('RFC 4180 quoting: embedded comma, doubled quote, embedded newline (LF and CRLF)', () => {
    expect(fields('"a,b","say ""hi""","l1\nl2","c1\r\nc2"\n')).toEqual([['a,b', 'say "hi"', 'l1\nl2', 'c1\r\nc2']]);
    expect(fields('"",x\n')).toEqual([['', 'x']]);
  });

  it('blank lines and # comment lines are ignored; # inside a line is data; cells are not trimmed', () => {
    expect(fields('# c1\n\n   \na,b\n#c2\n\r\n x , y \nq#r,s\n')).toEqual([['a', 'b'], [' x ', ' y '], ['q#r', 's']]);
  });

  it('a comma-only line is a record of empty cells (not blank)', () => {
    expect(fields(',,\n')).toEqual([['', '', '']]);
  });

  it('line numbers are physical: comments/blank lines and quoted newlines advance them', () => {
    const r = parseCsv('h1,h2\n# note\n\nA,"x\ny"\nB,2\r\nC,3').records;
    expect(r.map((x) => x.line)).toEqual([1, 4, 6, 7]);
    expect(r.map((x) => x.fields[0])).toEqual(['h1', 'A', 'B', 'C']);
  });

  it('an unterminated quote is reported (never silently swallowed into one giant cell)', () => {
    expect(parseCsv('a,b\nc,"never closed\nd,e\n').unbalancedQuote).toBe(true);
    expect(parseCsv('a,"b""\n').unbalancedQuote).toBe(true);
  });

  it('empty input has no records; a 2 MB single cell is handled in linear time', () => {
    expect(parseCsv('').records).toEqual([]);
    const t = Date.now();
    const r = parseCsv('"' + 'x'.repeat(2_000_000) + '",y\n');
    expect(r.records[0]!.fields[0]!.length).toBe(2_000_000);
    expect(Date.now() - t).toBeLessThan(5000);
  });

  it('never evaluates anything: formula/HTML-looking cells come back verbatim (T-B4)', () => {
    expect(fields('=1+1,+SUM(A1),-2,@x,"<script>alert(1)</script>"\n')).toEqual([['=1+1', '+SUM(A1)', '-2', '@x', '<script>alert(1)</script>']]);
  });
});
