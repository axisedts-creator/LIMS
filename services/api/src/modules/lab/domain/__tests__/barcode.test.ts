// C5 T-05 — barcode pattern parser/renderer (02-TRD §4.2; 06-IMPLEMENTATION-PLAN row T-05; 08 A13 D-8; CR-C5-005).
// ACs: AC-01.3 (E{yy}{seq:8}, counter 41, 2026 -> E2600000042, ^[A-Z0-9]{1,20}$), AC-01.4 (charset/length/overflow -> lab.barcode_pattern_invalid).
// Security: REQ-SEC-095 (07-SECURITY): problem bodies never echo a barcode/value; barcode charset check on anything that becomes a barcode.
// Interface expected from the writer (../barcode.ts) — SEAM (spec fixes behaviour, not the name):
//   export const DEFAULT_BARCODE_PATTERN = '{prefix}{yy}{seq:8}'                     (08 A13 D-8)
//   export function renderBarcode(pattern: string, input: { seq: number | bigint | string; prefix?: string; now: Date; timeZone?: string }): string
//        pure. `seq` = the counter value already allocated (>= 1; the pg bigint arrives as a string). `prefix` = numbering.barcodePrefix ([A-Z0-9]{0,4}, absent = '').
//        `now` = ctx.now(); {yy} = A.D. year, 2 digits, zero padded, in `timeZone` (default 'Asia/Kathmandu', 08 A13 P-15).
//        Tokens: {yy} {seq:N} (1 <= N <= 12, zero padded, never truncated) {prefix}; literals [A-Z0-9]. Anything else, or a result not matching ^[A-Z0-9]{1,20}$,
//        throws LimsError('lab.barcode_pattern_invalid') (http 500) whose message/detail never contain the pattern or the rendered value.
import { describe, expect, it } from 'vitest';
import { isLimsError, type LimsError } from '../../../../core/errors.js';
import { DEFAULT_BARCODE_PATTERN, renderBarcode } from '../barcode.js';

type Seq = number | bigint | string;
interface Extra { prefix?: string; now?: Date; timeZone?: string }
const NOW = new Date('2026-06-15T05:00:00Z');
const R = (pattern: string, seq: Seq = 42, extra: Extra = {}): string => renderBarcode(pattern, { seq, now: NOW, ...extra });
const INVALID = (pattern: string, seq: Seq = 42, extra: Extra = {}): LimsError => {
  try { R(pattern, seq, extra); } catch (e) {
    expect(isLimsError(e, 'lab.barcode_pattern_invalid'), `pattern ${JSON.stringify(pattern)} threw ${String(e)}`).toBe(true);
    return e as LimsError;
  }
  throw new Error(`expected lab.barcode_pattern_invalid for ${JSON.stringify(pattern)}`);
};

describe('T-05 default pattern and AC-01.3', () => {
  it('default pattern is {prefix}{yy}{seq:8} (08 A13 D-8)', () => {
    expect(DEFAULT_BARCODE_PATTERN).toBe('{prefix}{yy}{seq:8}');
  });
  it('prefix E, counter value 42 (counter was 41), 2026 -> E2600000042; matches ^[A-Z0-9]{1,20}$', () => {
    const v = R(DEFAULT_BARCODE_PATTERN, 42, { prefix: 'E' });
    expect(v).toBe('E2600000042');
    expect(v).toMatch(/^[A-Z0-9]{1,20}$/);
  });
  it('AC-01.3 literal form E{yy}{seq:8} gives the same value (client shape E1100001677 = E + 11 + 00001677)', () => {
    expect(R('E{yy}{seq:8}', 42)).toBe('E2600000042');
    expect(renderBarcode('E{yy}{seq:8}', { seq: 1677, now: new Date('2011-03-01T00:00:00Z') })).toBe('E1100001677');
  });
  it('{prefix} absent = empty string; empty prefix = empty string', () => {
    expect(R('{prefix}{yy}{seq:8}', 42)).toBe('2600000042');
    expect(R('{prefix}{yy}{seq:8}', 42, { prefix: '' })).toBe('2600000042');
  });
  it('{prefix} takes 1..4 chars of [A-Z0-9]', () => {
    expect(R('{prefix}{seq:4}', 7, { prefix: 'AB12' })).toBe('AB120007');
    expect(R('{prefix}{seq:4}', 7, { prefix: '9' })).toBe('90007');
  });
  it('a prefix value outside [A-Z0-9]{0,4} is a configuration error', () => {
    for (const p of ['ABCDE', 'e', 'A-B', 'A B', "A'", '{yy}', 'É']) INVALID('{prefix}{seq:4}', 7, { prefix: p });
  });
  it('the prefix is a value, never re-expanded as a token', () => {
    INVALID('{prefix}{seq:4}', 7, { prefix: '{yy}' });
  });
});

describe('T-05 tokens: {yy} (A.D. year in the tenant timezone), {seq:N}, literals', () => {
  it('{yy} is the 2-digit A.D. year, zero padded', () => {
    expect(R('{yy}', 1, { now: new Date('2026-06-15T05:00:00Z') })).toBe('26');
    expect(R('{yy}', 1, { now: new Date('2005-06-15T05:00:00Z') })).toBe('05');
  });
  it('{yy} follows Asia/Kathmandu (UTC+05:45), not UTC, by default', () => {
    expect(R('{yy}', 1, { now: new Date('2025-12-31T18:14:59Z') })).toBe('25');   // 23:59:59 on 31 Dec in Kathmandu
    expect(R('{yy}', 1, { now: new Date('2025-12-31T18:15:00Z') })).toBe('26');   // 00:00:00 on 1 Jan in Kathmandu (UTC still 2025)
    expect(R('{yy}', 1, { now: new Date('2026-12-31T18:30:00Z') })).toBe('27');
  });
  it('an explicit timeZone is honoured', () => {
    expect(R('{yy}', 1, { now: new Date('2025-12-31T18:30:00Z'), timeZone: 'UTC' })).toBe('25');
    expect(R('{yy}', 1, { now: new Date('2025-12-31T18:30:00Z'), timeZone: 'Asia/Kathmandu' })).toBe('26');
  });
  it('{seq:N} zero-pads to exactly N digits', () => {
    expect(R('{seq:1}', 7)).toBe('7');
    expect(R('{seq:4}', 7)).toBe('0007');
    expect(R('{seq:12}', 41)).toBe('000000000041');
  });
  it('{seq:N} accepts the counter as number, bigint or the pg bigint string (no float rounding)', () => {
    expect(R('{seq:8}', 42)).toBe('00000042');
    expect(R('{seq:8}', 42n)).toBe('00000042');
    expect(R('{seq:8}', '42')).toBe('00000042');
    expect(R('{seq:12}', '999999999999')).toBe('999999999999');
    INVALID('{seq:12}', '9007199254740993');   // 16 digits: overflow, and no float rounding on the way
  });
  it('the counter fits exactly N digits at the boundary and overflows one above (AC-01.4 overflow)', () => {
    expect(R('{seq:8}', 99999999)).toBe('99999999');
    INVALID('{seq:8}', 100000000);
    expect(R('{seq:1}', 9)).toBe('9');
    INVALID('{seq:1}', 10);
    INVALID('E{yy}{seq:3}', '1000');
  });
  it('overflow never truncates silently', () => {
    expect(() => R('{seq:3}', 12345)).toThrow();
  });
  it('literals [A-Z0-9] pass through, several tokens in any order', () => {
    expect(R('LAB{seq:4}X', 5)).toBe('LAB0005X');
    expect(R('{seq:3}{yy}Z9', 5)).toBe('00526Z9');
    expect(R('A{yy}B{yy}C{seq:2}', 5)).toBe('A26B26C05');
    expect(R('{yy}{prefix}{seq:2}', 5, { prefix: 'Q' })).toBe('26Q05');
  });
});

describe('T-05 rejected patterns -> lab.barcode_pattern_invalid (AC-01.4, CR-C5-005)', () => {
  it('{branch} {centre} {fy} {fyl} are not allowed in barcodes (location-neutral series)', () => {
    for (const t of ['{branch}', '{centre}', '{fy}', '{fyl}']) {
      INVALID(`${t}{seq:8}`);
      INVALID(`E{yy}${t}{seq:8}`);
    }
  });
  it('unknown, malformed or differently-cased tokens', () => {
    for (const p of ['{foo}{seq:8}', '{YY}{seq:8}', '{Seq:8}', '{PREFIX}{seq:8}', '{yy{seq:8}', '{yy}}{seq:8}', '{{yy}}{seq:8}', '{}{seq:8}', '{ yy }{seq:8}', '{seq:8', 'seq:8}']) INVALID(p);
  });
  it('{seq} needs a width 1..12 (no bare {seq}, no 0, no 13, no signs/decimals/blank)', () => {
    for (const p of ['{seq}', '{seq:0}', '{seq:13}', '{seq:99}', '{seq:-1}', '{seq:1.5}', '{seq:}', '{seq: 8}', '{seq:abc}', '{seq:8:2}']) INVALID(p);
  });
  it('{yy} and {prefix} take no arguments', () => {
    for (const p of ['{yy:2}', '{prefix:4}']) INVALID(`${p}{seq:8}`);
  });
  it('literal characters outside [A-Z0-9]: lowercase, "-", space, punctuation, non-ASCII, control, quotes', () => {
    for (const ch of ['a', '-', ' ', '/', '_', '.', '#', '*', "'", '"', ';', '\\', '\n', '\u0000', 'É', '１', '😀']) INVALID(`E${ch}{seq:8}`);
  });
  it('injection-shaped patterns are only rejected, never interpreted', () => {
    for (const p of ["E'; DROP TABLE lab.specimens; --{seq:8}", '${process.env.HOME}{seq:8}', '$&{seq:8}', '$1{seq:8}', '`id`{seq:8}', '<script>{seq:8}']) INVALID(p);
  });
  it('rendered value longer than 20 characters (boundary 20 ok / 21 invalid)', () => {
    expect(R('ABCDEFGHIJKL{seq:8}', 1)).toBe('ABCDEFGHIJKL00000001');
    expect(R('ABCDEFGHIJKL{seq:8}', 1)).toHaveLength(20);
    INVALID('ABCDEFGHIJKLM{seq:8}', 1);
    INVALID('{prefix}{yy}{seq:12}ABCDEFGH', 1, { prefix: 'ABCD' });
  });
  it('empty rendered value (empty pattern, or only an absent prefix) is invalid', () => {
    INVALID('');
    INVALID('{prefix}');
    INVALID('{prefix}', 1, { prefix: '' });
  });
  it('non-string patterns and unusable counters', () => {
    for (const p of [undefined, null, 42, {}, ['{seq:8}']]) expect(() => renderBarcode(p as never, { seq: 1, now: NOW })).toThrow();
    for (const s of [0, -1, 1.5, Number.NaN, Infinity, '', 'abc', '1e3', '-5', ' 5', '0x10', Number.MAX_SAFE_INTEGER + 1]) expect(() => R('{seq:12}', s)).toThrow();
  });
});

describe('T-05 error shape (REQ-SEC-095: no barcode/pattern in problem bodies)', () => {
  it('http 500, code lab.barcode_pattern_invalid, message/detail/errors never echo pattern, counter or prefix', () => {
    const e = INVALID('SECRETLIT{branch}{seq:2}', 123456, { prefix: 'ZZ9' });
    expect(e.statusCode).toBe(500);
    const dump = JSON.stringify({ m: e.message, d: e.detail, errors: e.errors });
    for (const s of ['SECRETLIT', '{branch}', '123456', 'ZZ9']) expect(dump).not.toContain(s);
  });
  it('overflow error carries no digits of the counter', () => {
    const e = INVALID('{seq:2}', 987654321);
    expect(JSON.stringify({ m: e.message, d: e.detail, errors: e.errors })).not.toContain('987654321');
  });
});
