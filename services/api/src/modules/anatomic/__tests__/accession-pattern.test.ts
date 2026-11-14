// C11 T-02 — accession pattern (02-TRD §4.2; AC-02.3 overflow, AC-02.4 year boundary, AC-02.1 example). Pure.
// SEAMS (spec fixes grammar/behaviour, not names):
//   ../domain/accession-pattern.ts
//     DEFAULT_ACCESSION_PATTERN = '{prefix}{yy}-{seq:4}'
//     DEFAULT_ACCESSION_PREFIXES = { histology:'S', cytology:'C', ihc:'I', molecular:'M' }
//     BATCH_ACCESSION_PATTERN = 'MB{yy}{seq:4}'
//     parseAccessionPattern(pattern): { seqWidth: number; hasYear: boolean; hasBranch: boolean; hasPrefix: boolean }   (throws on invalid)
//     renderAccessionNumber({ pattern, seq, year?, prefix?, branchCode? }): string      (seq = counter value after increment, ≥ 1)
//     accessionYearAd(now: Date, timeZone: string): number                              (A.D. year of `now` in that IANA zone)
//     counterYear(pattern, now, timeZone): number                                       (year_ad when pattern has {yy}, else 0 — scope key)
//   Every failure throws LimsError('anatomic.accession_pattern_invalid').
// Fails now: ../domain/accession-pattern.js does not exist.
import { describe, expect, it } from 'vitest';
import { LimsError } from '../../../core/errors.js';
import {
  accessionYearAd, BATCH_ACCESSION_PATTERN, counterYear, DEFAULT_ACCESSION_PATTERN, DEFAULT_ACCESSION_PREFIXES,
  parseAccessionPattern, renderAccessionNumber,
} from '../domain/accession-pattern.js';

const CODE = 'anatomic.accession_pattern_invalid';
function codeOf(fn: () => unknown): string | undefined {
  try { fn(); } catch (e) { return e instanceof LimsError ? e.code : `non-LimsError:${String(e)}`; }
  return undefined;
}
const KTM = 'Asia/Kathmandu';

describe('C11 accession pattern — defaults', () => {
  it('constants match TRD §4.2', () => {
    expect(DEFAULT_ACCESSION_PATTERN).toBe('{prefix}{yy}-{seq:4}');
    expect(DEFAULT_ACCESSION_PREFIXES).toEqual({ histology: 'S', cytology: 'C', ihc: 'I', molecular: 'M' });
    expect(BATCH_ACCESSION_PATTERN).toBe('MB{yy}{seq:4}');
  });
  it('AC-02.1 example: prefix S, 2026, counter 42 → S26-0042', () => {
    expect(renderAccessionNumber({ pattern: DEFAULT_ACCESSION_PATTERN, prefix: 'S', year: 2026, seq: 42 })).toBe('S26-0042');
  });
  it('AC-04.4 cytology example: C26-0007', () => {
    expect(renderAccessionNumber({ pattern: DEFAULT_ACCESSION_PATTERN, prefix: DEFAULT_ACCESSION_PREFIXES.cytology, year: 2026, seq: 7 })).toBe('C26-0007');
  });
  it('molecular batch pattern → MB260001 (no prefix needed)', () => {
    expect(renderAccessionNumber({ pattern: BATCH_ACCESSION_PATTERN, year: 2026, seq: 1 })).toBe('MB260001');
  });
});

describe('C11 accession pattern — tokens', () => {
  it('{prefix}{branch}{yy}{seq:N} all together; {branch} is upper-cased', () => {
    expect(renderAccessionNumber({ pattern: '{prefix}-{branch}-{yy}-{seq:3}', prefix: 'S', branchCode: 'ktm-1', year: 2026, seq: 7 })).toBe('S-KTM-1-26-007');
  });
  it('literal characters [A-Z0-9-] are copied verbatim', () => {
    expect(renderAccessionNumber({ pattern: 'PATH-{seq:5}', seq: 42 })).toBe('PATH-00042');
  });
  it('{yy} is the last two digits, zero-padded (2005 → 05, 2100 → 00)', () => {
    expect(renderAccessionNumber({ pattern: '{yy}{seq:3}', year: 2005, seq: 1 })).toBe('05001');
    expect(renderAccessionNumber({ pattern: '{yy}{seq:3}', year: 2100, seq: 1 })).toBe('00001');
  });
  it('{prefix} may be empty ("" ⇒ nothing rendered)', () => {
    expect(renderAccessionNumber({ pattern: '{prefix}{yy}-{seq:4}', prefix: '', year: 2026, seq: 5 })).toBe('26-0005');
  });
  it.each([3, 4, 5, 6, 7, 8])('seq width %i is accepted and zero-padded', (n) => {
    expect(renderAccessionNumber({ pattern: `{seq:${n}}`, seq: 1 })).toBe('1'.padStart(n, '0'));
    expect(parseAccessionPattern(`{seq:${n}}`).seqWidth).toBe(n);
  });
  it('parse reports which tokens are present', () => {
    expect(parseAccessionPattern('{prefix}{yy}-{seq:4}')).toMatchObject({ seqWidth: 4, hasYear: true, hasBranch: false, hasPrefix: true });
    expect(parseAccessionPattern('{branch}-{seq:6}')).toMatchObject({ seqWidth: 6, hasYear: false, hasBranch: true, hasPrefix: false });
  });
});

describe('C11 accession pattern — overflow (AC-02.3)', () => {
  it('last value that fits: 9999 with {seq:4}', () => {
    expect(renderAccessionNumber({ pattern: '{prefix}{yy}-{seq:4}', prefix: 'S', year: 2026, seq: 9999 })).toBe('S26-9999');
  });
  it('10000 with {seq:4} → anatomic.accession_pattern_invalid', () => {
    expect(codeOf(() => renderAccessionNumber({ pattern: '{prefix}{yy}-{seq:4}', prefix: 'S', year: 2026, seq: 10000 }))).toBe(CODE);
  });
  it('boundary per width: 10^N - 1 ok, 10^N fails', () => {
    for (const n of [3, 5, 8]) {
      expect(renderAccessionNumber({ pattern: `{seq:${n}}`, seq: 10 ** n - 1 })).toBe('9'.repeat(n));
      expect(codeOf(() => renderAccessionNumber({ pattern: `{seq:${n}}`, seq: 10 ** n }))).toBe(CODE);
    }
  });
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('seq %s is not a valid counter value', (seq) => {
    expect(codeOf(() => renderAccessionNumber({ pattern: '{seq:4}', seq }))).toBe(CODE);
  });
});

describe('C11 accession pattern — invalid patterns', () => {
  it.each([
    ['empty', ''],
    ['no {seq:N}', '{prefix}{yy}'],
    ['two {seq:N}', '{seq:4}-{seq:4}'],
    ['width below 3', '{seq:2}'],
    ['width above 8', '{seq:9}'],
    ['width 0', '{seq:0}'],
    ['width with sign', '{seq:+4}'],
    ['width with leading zero', '{seq:04}'],
    ['{seq} without width', '{seq}'],
    ['non-numeric width', '{seq:x}'],
    ['unknown token', '{prefix}{foo}{seq:4}'],
    ['token is case-sensitive', '{PREFIX}{seq:4}'],
    ['{year} is not a token', '{year}{seq:4}'],
    ['lower-case literal', 'abc-{seq:4}'],
    ['underscore literal', 'S_{seq:4}'],
    ['space literal', 'S {seq:4}'],
    ['slash literal', 'S/{seq:4}'],
    ['unicode literal', 'Ş{seq:4}'],
    ['newline literal', 'S\n{seq:4}'],
    ['unbalanced open brace', '{seq:4'],
    ['unbalanced close brace', 'seq:4}'],
    ['nested braces', '{{seq:4}}'],
    ['SQL-ish', "S';DROP TABLE x;--{seq:4}"],
    ['HTML-ish', '<b>{seq:4}'],
  ])('rejects (%s): %j', (_name, pattern) => {
    expect(codeOf(() => parseAccessionPattern(pattern))).toBe(CODE);
    expect(codeOf(() => renderAccessionNumber({ pattern, prefix: 'S', year: 2026, seq: 1 }))).toBe(CODE);
  });
  it('non-string pattern is rejected, not coerced', () => {
    expect(codeOf(() => parseAccessionPattern(undefined as unknown as string))).toBe(CODE);
    expect(codeOf(() => parseAccessionPattern(42 as unknown as string))).toBe(CODE);
  });
  it('very long pattern is rejected without hanging (ReDoS guard)', () => {
    const t0 = Date.now();
    expect(codeOf(() => parseAccessionPattern('{'.repeat(50_000)))).toBe(CODE);
    expect(codeOf(() => parseAccessionPattern('A'.repeat(50_000) + '{seq:4}'))).toBe(CODE);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});

describe('C11 accession pattern — invalid inputs at render time', () => {
  it('{branch} with no branch code → anatomic.accession_pattern_invalid (nothing changes)', () => {
    expect(codeOf(() => renderAccessionNumber({ pattern: '{branch}-{seq:4}', seq: 1 }))).toBe(CODE);
    expect(codeOf(() => renderAccessionNumber({ pattern: '{branch}-{seq:4}', seq: 1, branchCode: '' }))).toBe(CODE);
  });
  it('patterns without {branch} never read the branch (garbage branchCode ignored)', () => {
    expect(renderAccessionNumber({ pattern: '{prefix}{yy}-{seq:4}', prefix: 'S', year: 2026, seq: 1, branchCode: '!!bad!!' })).toBe('S26-0001');
  });
  it('{yy} with no year → invalid', () => {
    expect(codeOf(() => renderAccessionNumber({ pattern: '{yy}-{seq:4}', seq: 1 }))).toBe(CODE);
  });
  it('{prefix} with prefix undefined → invalid (caller must supply default)', () => {
    expect(codeOf(() => renderAccessionNumber({ pattern: '{prefix}-{seq:4}', seq: 1 }))).toBe(CODE);
  });
  it.each(['s', 'ABCDE', 'A-B', 'A B', 'A_', 'Ş'])('prefix %j violates [A-Z0-9]{0,4}', (prefix) => {
    expect(codeOf(() => renderAccessionNumber({ pattern: '{prefix}-{seq:4}', prefix, seq: 1 }))).toBe(CODE);
  });
  it.each(['', 'a'.repeat(17), 'K_T', 'K T', 'K/T', 'Ş'])('branch code %j violates ^[A-Za-z0-9-]{1,16}$', (branchCode) => {
    expect(codeOf(() => renderAccessionNumber({ pattern: '{branch}-{seq:4}', branchCode, seq: 1 }))).toBe(CODE);
  });
  it.each([Number.NaN, 1.5, -1])('year %s is not a valid A.D. year', (year) => {
    expect(codeOf(() => renderAccessionNumber({ pattern: '{yy}-{seq:4}', year, seq: 1 }))).toBe(CODE);
  });
  it('rendered value must match ^[A-Z0-9-]{1,20}$: 20 ok, 21 rejected', () => {
    // {prefix}(4) + {branch}(8) + '-' + {yy}(2) + {seq:5} = 20
    const ok = renderAccessionNumber({ pattern: '{prefix}{branch}-{yy}{seq:5}', prefix: 'ABCD', branchCode: 'EFGHIJKL', year: 2026, seq: 1 });
    expect(ok).toBe('ABCDEFGHIJKL-2600001');
    expect(ok.length).toBe(20);
    expect(codeOf(() => renderAccessionNumber({ pattern: '{prefix}{branch}-{yy}{seq:6}', prefix: 'ABCD', branchCode: 'EFGHIJKL', year: 2026, seq: 1 }))).toBe(CODE);
  });
});

describe('C11 accession pattern — year in tenant time zone (AC-02.4)', () => {
  it('31 Dec 2026 18:15:00 UTC = 1 Jan 2027 00:00 Asia/Kathmandu → 2027', () => {
    expect(accessionYearAd(new Date('2026-12-31T18:15:00Z'), KTM)).toBe(2027);
  });
  it('one second earlier (18:14:59 UTC) is still 2026 in Asia/Kathmandu', () => {
    expect(accessionYearAd(new Date('2026-12-31T18:14:59Z'), KTM)).toBe(2026);
  });
  it('the same instants in UTC stay 2026 (zone, not host clock, decides)', () => {
    expect(accessionYearAd(new Date('2026-12-31T18:15:00Z'), 'UTC')).toBe(2026);
  });
  it('1 Jan 00:30 UTC is already 2027 in Kathmandu, 31 Dec 2025 23:59 UTC is 2026', () => {
    expect(accessionYearAd(new Date('2027-01-01T00:30:00Z'), KTM)).toBe(2027);
    expect(accessionYearAd(new Date('2025-12-31T23:59:00Z'), KTM)).toBe(2026);
  });
  it('first case of new year restarts at 1 for its series: counter scope key changes; rendered number uses the new yy', () => {
    const before = new Date('2026-12-31T18:14:59Z');
    const after = new Date('2026-12-31T18:15:00Z');
    const pat = DEFAULT_ACCESSION_PATTERN;
    expect(counterYear(pat, before, KTM)).toBe(2026);
    expect(counterYear(pat, after, KTM)).toBe(2027);
    expect(renderAccessionNumber({ pattern: pat, prefix: 'S', year: counterYear(pat, after, KTM), seq: 1 })).toBe('S27-0001');
  });
  it('pattern without {yy} → counter year scope is 0 regardless of date', () => {
    expect(counterYear('{prefix}{seq:5}', new Date('2026-12-31T18:15:00Z'), KTM)).toBe(0);
    expect(counterYear('{prefix}{seq:5}', new Date('2026-06-01T00:00:00Z'), KTM)).toBe(0);
  });
  it('counterYear validates the pattern too', () => {
    expect(codeOf(() => counterYear('{yy}', new Date(), KTM))).toBe(CODE);
  });
  it('unknown time zone throws (never silently falls back to UTC)', () => {
    expect(() => accessionYearAd(new Date('2026-06-01T00:00:00Z'), 'Mars/Olympus')).toThrow();
  });
  it('invalid Date throws', () => {
    expect(() => accessionYearAd(new Date('nope'), KTM)).toThrow();
  });
});
