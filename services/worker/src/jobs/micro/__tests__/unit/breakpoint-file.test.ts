// C10 T-12 unit — csv/breakpoint-file.ts: bytes -> rows/bands + issues (02-TRD §9.1; 01-PRD AC-12.2, AC-12.4; 07-SECURITY S-12, S-13).
// SEAMS (spec silent; the writer must match):
//   parseBreakpointFile(input: Uint8Array, opts?: { maxLines?: number /*20000*/; timeoutMs?: number /*60000*/; now?: () => number /*ms, default performance.now*/ })
//     -> { rows: ParsedRow[]; issues: ParsedIssue[] }   (pure, synchronous; never throws on bad content, never reads env — the job passes the LIMS_MICRO_* values)
//   ParsedRow   = { line_no (first line of the key), organism_scope, organism_code|null, antibiotic_code, method, specimen_site_code|null, qualifier_code|null,
//                   bands: { band_no, line_no, category_code, lower_value|null, lower_inclusive, upper_value|null, upper_inclusive, note|null }[] }  (values stay DecimalString text)
//   ParsedIssue = { line_no: number|null (null = file level), severity: 'error'|'warning', code, field: string|null (column name, ≤ 40), message (≤ 200) }
//   This layer checks everything that needs no dictionary: all file.* codes except file.processing_failed, plus row.column_count/scope_invalid/method_invalid/
//   qualifier_invalid/value_invalid/bounds_*/bands_overlap/too_many_bands/note_too_long/gap_between_bands/key_split. Dictionary/standard checks are the job's (integration test).
//   Data lines = non-blank, non-comment records after the header; the header is not counted. The deadline is consulted at least every 1,000 data lines and at the end.
//   A file-level error (encoding/header/empty/too_many_rows/parse_timeout/quote_unbalanced) is reported alone: rows = [].
import { describe, expect, it } from 'vitest';
import { parseBreakpointFile } from '../../csv/breakpoint-file.js';
import { HEADER, NOTE, PARSER_CODES, WARNING_CODES, band, bigFile, bytes, file } from '../helpers/csv.js';

const run = (text: string, opts?: Parameters<typeof parseBreakpointFile>[1]) => parseBreakpointFile(bytes(text), opts);
const codes = (r: { issues: { code: string }[] }) => r.issues.map((i) => i.code);
const only = (text: string, code: string) => {
  const r = run(text);
  expect(codes(r)).toEqual([code]);
  return r.issues[0]!;
};

describe('C10-T12 breakpoint-file: a valid file', () => {
  it('groups lines sharing the first six columns into one row; band_no = order of appearance; values stay text; empty inclusive = true', () => {
    const r = run(file(
      band({ org: '', cat: 'S', hi: '0.25', hiInc: 'false' }),
      band({ cat: 'R', lo: '0.25', loInc: 'true', hi: '', hiInc: '', note: '' }),
      band({ scope: 'organism', org: 'syn_org_a', abx: 'syn_abx_b', method: 'zone_diameter', site: 'syn_site', qual: 'syn_q', cat: 'I', lo: '12', hi: '12.5', hiInc: '' }),
    ));
    expect(r.issues).toEqual([]);
    expect(r.rows).toEqual([
      {
        line_no: 2, organism_scope: 'any', organism_code: null, antibiotic_code: 'syn_abx_a', method: 'mic', specimen_site_code: null, qualifier_code: null,
        bands: [
          { band_no: 1, line_no: 2, category_code: 'S', lower_value: null, lower_inclusive: true, upper_value: '0.25', upper_inclusive: false, note: NOTE },
          { band_no: 2, line_no: 3, category_code: 'R', lower_value: '0.25', lower_inclusive: true, upper_value: null, upper_inclusive: true, note: null },
        ],
      },
      {
        line_no: 4, organism_scope: 'organism', organism_code: 'syn_org_a', antibiotic_code: 'syn_abx_b', method: 'zone_diameter', specimen_site_code: 'syn_site', qualifier_code: 'syn_q',
        bands: [{ band_no: 1, line_no: 4, category_code: 'I', lower_value: '12', lower_inclusive: true, upper_value: '12.5', upper_inclusive: true, note: NOTE }],
      },
    ]);
  });

  it('bands may appear unsorted; contiguous bands (2 inclusive | 2 exclusive) are neither overlap nor gap; the category I^ and unicode notes survive', () => {
    const r = run(file(
      band({ cat: 'R', lo: '4', loInc: 'false', hi: '', hiInc: '' }),
      band({ cat: 'S', lo: '', hi: '2', hiInc: 'true' }),
      band({ cat: 'I^', lo: '2', loInc: 'false', hi: '4', hiInc: 'true', note: 'µg/mL ≤ NOT CLINICAL' }),
    ));
    expect(r.issues).toEqual([]);
    expect(r.rows[0]!.bands.map((b) => [b.band_no, b.category_code])).toEqual([[1, 'R'], [2, 'S'], [3, 'I^']]);
    expect(r.rows[0]!.bands[2]!.note).toBe('µg/mL ≤ NOT CLINICAL');
  });

  it('strips a UTF-8 BOM, accepts CRLF, comments (also before the header) and blank lines', () => {
    const text = '﻿# template note\r\n' + HEADER + '\r\n\r\n# between\r\n' + band() + '\r\n';
    const r = run(text);
    expect(r.issues).toEqual([]);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]!.line_no).toBe(5);
  });

  it('a note of exactly 200 characters (multi-byte) is fine; a quoted note may hold commas, quotes and newlines', () => {
    expect(run(file(band({ note: 'é'.repeat(200) }))).issues).toEqual([]);
    const r = run(file(band({ note: '"a, ""b""\nc"' })));
    expect(r.issues).toEqual([]);
    expect(r.rows[0]!.bands[0]!.note).toBe('a, "b"\nc');
  });

  it('formula / HTML looking cells are plain text: a note =HYPERLINK(...) is kept verbatim, nothing is evaluated (T-B4, S-13)', () => {
    const r = run(file(band({ note: '"=HYPERLINK(""http://x.invalid"")"' })));
    expect(r.issues).toEqual([]);
    expect(r.rows[0]!.bands[0]!.note).toBe('=HYPERLINK("http://x.invalid")');
  });
});

describe('C10-T12 breakpoint-file: every parser-level issue code has a fixture', () => {
  const noteOver = 'x'.repeat(201);
  // code -> [file text or bytes, expected line_no (undefined = file level), expected field (optional)]
  const FIX: Record<string, { input: Uint8Array; line?: number; field?: string }> = {
    'file.encoding_invalid': { input: new Uint8Array([...bytes(HEADER + '\n'), 0xc3, 0x28, 0x0a]) },
    'file.header_mismatch': { input: bytes(HEADER.replace('method,specimen_site_code', 'specimen_site_code,method') + '\n' + band() + '\n') },
    'file.empty': { input: bytes(HEADER + '\n# only comments\n\n') },
    'file.too_many_rows': { input: bytes(bigFile(1) + band({ qual: 'z1' }) + '\n') },       // used with maxLines = 2 below
    'file.parse_timeout': { input: bytes(bigFile(1500)) },                                       // used with a jumping clock below
    'file.quote_unbalanced': { input: bytes(HEADER + '\n' + band().replace(NOTE, '"NOT CLINICAL') + '\n') },
    'row.column_count': { input: bytes(file(band() + ',extra')), line: 2 },
    'row.scope_invalid': { input: bytes(file(band({ scope: 'species' }))), line: 2, field: 'organism_scope' },
    'row.method_invalid': { input: bytes(file(band({ method: 'disk' }))), line: 2, field: 'method' },
    'row.qualifier_invalid': { input: bytes(file(band({ qual: 'Bad Qualifier!' }))), line: 2, field: 'qualifier_code' },
    'row.value_invalid': { input: bytes(file(band({ hi: '1e3' }))), line: 2, field: 'upper_value' },
    'row.bounds_missing': { input: bytes(file(band({ lo: '', hi: '' }))), line: 2 },
    'row.bounds_order': { input: bytes(file(band({ lo: '4', hi: '2' }))), line: 2 },
    'row.bands_overlap': { input: bytes(file(band({ cat: 'S', hi: '2', hiInc: 'true' }), band({ cat: 'R', lo: '2', loInc: 'true', hi: '', hiInc: '' }))) },
    'row.too_many_bands': { input: bytes(file(...[0, 1, 2, 3, 4, 5, 6].map((i) => band({ cat: i % 2 ? 'R' : 'S', lo: String(i), loInc: 'false', hi: String(i + 1), hiInc: 'true' })))) },
    'row.note_too_long': { input: bytes(file(band({ note: noteOver }))), line: 2, field: 'note' },
    'row.gap_between_bands': { input: bytes(file(band({ cat: 'S', hi: '2', hiInc: 'true' }), band({ cat: 'R', lo: '4', loInc: 'true', hi: '', hiInc: '' }))) },
    'row.key_split': { input: bytes(file(band({ qual: 'a', hi: '2' }), band({ qual: 'b', hi: '2' }), band({ qual: 'a', cat: 'R', lo: '2', loInc: 'false', hi: '', hiInc: '' }))) },
  };

  it('the fixture table covers exactly the parser-level codes (the job covers the rest)', () => {
    expect(Object.keys(FIX).sort()).toEqual([...PARSER_CODES].sort());
  });

  for (const code of PARSER_CODES) {
    it(`${code}`, () => {
      const f = FIX[code]!;
      const opts: Parameters<typeof parseBreakpointFile>[1] =
        code === 'file.too_many_rows' ? { maxLines: 2 }
        : code === 'file.parse_timeout' ? { timeoutMs: 5000, now: (() => { let t = 0; return () => (t += 10_000); })() } : undefined;
      const r = parseBreakpointFile(f.input, opts);
      const hits = r.issues.filter((i) => i.code === code);
      expect(hits.length, `${code} in ${JSON.stringify(codes(r))}`).toBeGreaterThanOrEqual(1);
      const i = hits[0]!;
      expect(i.severity).toBe(WARNING_CODES.includes(code) ? 'warning' : 'error');
      if (f.line !== undefined) expect(i.line_no).toBe(f.line);
      if (code.startsWith('file.') && code !== 'file.header_mismatch') expect(i.line_no).toBeNull();   // file level (a header mismatch may point at line 1)
      if (f.field) expect(i.field).toBe(f.field);
      expect(i.message.length).toBeLessThanOrEqual(200);
      expect((i.field ?? '').length).toBeLessThanOrEqual(40);
      if (code.startsWith('file.')) expect(r.rows).toEqual([]);                                // file-level failure is reported alone
      // nothing else is wrong with these fixtures
      const extra = codes(r).filter((c) => c !== code);
      expect(extra, `unexpected extra issues for ${code}`).toEqual([]);
    });
  }

  it('overlap / gap / key_split / too_many_bands point at a line of the offending key; an overlap or other error is never downgraded to a warning', () => {
    const lines = (code: string) => run(new TextDecoder().decode(FIX[code]!.input)).issues.filter((i) => i.code === code).map((i) => i.line_no);
    expect(lines('row.bands_overlap').every((l) => l === 2 || l === 3)).toBe(true);
    expect(lines('row.gap_between_bands').every((l) => l === 2 || l === 3)).toBe(true);
    expect(lines('row.key_split').every((l) => l !== null && [2, 3, 4].includes(l))).toBe(true);
    expect(lines('row.too_many_bands').every((l) => l !== null && l >= 2 && l <= 8)).toBe(true);
  });
});

describe('C10-T12 breakpoint-file: syntax details', () => {
  it('numbers must match ^[0-9]{1,8}(\\.[0-9]{1,6})?$ or be empty; each bad shape is row.value_invalid on its own field', () => {
    for (const bad of ['-1', '+1', '1e3', '.5', '5.', '1,5', '123456789', '1.1234567', '0x10', 'NaN', ' 1', '١٢']) {
      const r = run(file(band({ hi: '"' + bad + '"' })));
      expect(codes(r), `value ${JSON.stringify(bad)}`).toContain('row.value_invalid');
    }
    for (const ok of ['0', '00012345', '12345678', '0.000001', '99999999.999999']) expect(run(file(band({ hi: ok }))).issues, ok).toEqual([]);
    expect(run(file(band({ lo: 'abc', hi: '' }))).issues[0]).toMatchObject({ code: 'row.value_invalid', field: 'lower_value' });
  });

  it('*_inclusive accepts exactly true|false|empty; anything else is row.value_invalid on that field', () => {
    expect(run(file(band({ loInc: 'yes', lo: '1', hi: '2' }))).issues[0]).toMatchObject({ code: 'row.value_invalid', field: 'lower_inclusive', line_no: 2 });
    expect(run(file(band({ hiInc: '1' }))).issues[0]).toMatchObject({ code: 'row.value_invalid', field: 'upper_inclusive' });
    expect(run(file(band({ loInc: 'false', lo: '1', hi: '2', hiInc: 'false' }))).issues).toEqual([]);
  });

  it('organism_scope: any needs an empty organism_code; organism/group need one — otherwise row.scope_invalid', () => {
    expect(codes(run(file(band({ scope: 'any', org: 'syn_org_a' }))))).toEqual(['row.scope_invalid']);
    expect(codes(run(file(band({ scope: 'organism', org: '' }))))).toEqual(['row.scope_invalid']);
    expect(codes(run(file(band({ scope: 'group', org: '' }))))).toEqual(['row.scope_invalid']);
    expect(run(file(band({ scope: 'group', org: 'syn_group' }))).issues).toEqual([]);
  });

  it('too few columns is row.column_count, and the other lines are still parsed and reported', () => {
    const r = run(file('any,,syn_abx_a,mic', band({ method: 'disk' })));
    expect(r.issues.map((i) => [i.line_no, i.code])).toEqual([[2, 'row.column_count'], [3, 'row.method_invalid']]);
  });

  it('exactly 6 bands per key is accepted, the 7th is row.too_many_bands', () => {
    const mk = (n: number) => file(...Array.from({ length: n }, (_, i) => band({ cat: 'S', lo: String(i), loInc: 'false', hi: String(i + 1), hiInc: 'true' })));
    expect(run(mk(6)).issues).toEqual([]);
    expect(codes(run(mk(7)))).toEqual(['row.too_many_bands']);
  });

  it('header must match exactly (order, names, case, count); the valid rows below are then not reported', () => {
    for (const h of [HEADER + ',extra', HEADER.replace(',note', ''), HEADER.toUpperCase(), HEADER.replace('organism_scope', 'scope'), '']) {
      const r = run(h + '\n' + band() + '\n');
      expect(codes(r)[0], JSON.stringify(h.slice(0, 20))).toMatch(/^file\.(header_mismatch|empty)$/);
      expect(r.rows).toEqual([]);
    }
    expect(codes(run(HEADER.replace('note', 'notes') + '\n' + band() + '\n'))).toEqual(['file.header_mismatch']);
  });

  it('zero bytes and header-only files are file.empty', () => {
    expect(codes(parseBreakpointFile(new Uint8Array()))).toEqual(['file.empty']);
    expect(codes(run(HEADER + '\n'))).toEqual(['file.empty']);
  });

  it('NUL byte (anywhere, even inside quotes) and invalid UTF-8 are file.encoding_invalid and nothing else', () => {
    const nul = new Uint8Array([...bytes(HEADER + '\n' + band().replace(NOTE, '"NOT\0 CLINICAL"') + '\n')]);
    expect(codes(parseBreakpointFile(nul))).toEqual(['file.encoding_invalid']);
    expect(parseBreakpointFile(nul).rows).toEqual([]);
    expect(codes(parseBreakpointFile(new Uint8Array([...bytes(HEADER + '\n'), 0xff, 0xfe, 0x0a])))).toEqual(['file.encoding_invalid']);
  });
});

describe('C10-T12 breakpoint-file: limits (AC-12.4, S-12)', () => {
  it('20,000 data lines parse clean and fast (≤ 30 s, done_when); comments/blank lines do not count toward the cap', () => {
    const text = bigFile(10_000) + '# c\n\n'.repeat(500);
    const t = Date.now();
    const r = run(text);
    expect(Date.now() - t).toBeLessThanOrEqual(30_000);
    expect(r.issues).toEqual([]);
    expect(r.rows).toHaveLength(10_000);
    expect(r.rows.reduce((n, x) => n + x.bands.length, 0)).toBe(20_000);
  });

  it('20,001 data lines -> file.too_many_rows (alone, no partial rows)', () => {
    const r = run(bigFile(10_000) + band({ qual: 'extra' }) + '\n');
    expect(codes(r)).toEqual(['file.too_many_rows']);
    expect(r.issues[0]).toMatchObject({ severity: 'error' });
    expect(r.rows).toEqual([]);
  });

  it('maxLines is an option (LIMS_MICRO_IMPORT_MAX_LINES): 3 lines allowed with maxLines 3, 4 refused', () => {
    const mk = (n: number) => file(...Array.from({ length: n }, (_, i) => band({ qual: 'k' + i })));
    expect(run(mk(3), { maxLines: 3 }).issues).toEqual([]);
    expect(codes(run(mk(4), { maxLines: 3 }))).toEqual(['file.too_many_rows']);
  });

  it('timeout: a clock that jumps past timeoutMs gives file.parse_timeout (alone); a steady clock does not', () => {
    const text = bigFile(1500);                      // 3,000 lines: the deadline must be consulted at least once
    let t = 0;
    const jumpy = run(text, { timeoutMs: 5000, now: () => (t += 10_000) });
    expect(codes(jumpy)).toEqual(['file.parse_timeout']);
    expect(jumpy.rows).toEqual([]);
    expect(codes(run(text, { timeoutMs: 5000, now: () => 1 }))).toEqual([]);
  });

  it('the default timeout is 60 s: a clock at +59 s is fine, +61 s is not', () => {
    const text = bigFile(1500);
    const at = (elapsed: number) => { let n = 0; return () => (n++ === 0 ? 0 : elapsed); };
    expect(codes(run(text, { now: at(59_000) }))).toEqual([]);
    expect(codes(run(text, { now: at(61_000) }))).toEqual(['file.parse_timeout']);
  });
});

describe('C10-T12 breakpoint-file: issue messages never echo cell content (S-13)', () => {
  it('a 500-char hostile cell is not echoed beyond 40 chars; the message names the field; ≤ 200 chars', () => {
    const hostile = '=cmd|\' /C calc\'!A0<script>' + 'x'.repeat(480);
    const r = run(file(band({ method: '"' + hostile.replace(/"/g, '""') + '"' })));
    expect(codes(r)).toEqual(['row.method_invalid']);
    const i = r.issues[0]!;
    expect(i.field).toBe('method');
    expect(i.message.length).toBeLessThanOrEqual(200);
    expect(i.message).not.toContain(hostile.slice(0, 41));
    expect(i.message).not.toContain('x'.repeat(41));
  });
});
