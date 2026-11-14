// C12.T-02 — domain/numbering.ts (02-TRD §4.6; 05-SCHEMA §2.4/§2.5; IC §9.3 token table; 04 L16; shared bsdate golden table).
// Expected interface (domain/numbering.ts); dates are tenant business dates as A.D. 'YYYY-MM-DD':
//   parseNumberingPattern(pattern: unknown): ParsedPattern   throws .code 'common.validation_failed' for an invalid pattern
//   periodKey(pattern: string, onDate: string): string       'fy:<fyl>' | 'yy:<yy>' | 'all'
//   formatNumber(pattern: string, onDate: string, seq: number): string
// Token meaning (IC §9.3 [CONV]): {yy} A.D. 2-digit year; {fy} B.S. fiscal year short '082/83'; {fyl} long '2082/83'; {seq:N} zero-padded width N.
import { describe, expect, it } from 'vitest';
import { formatNumber, parseNumberingPattern, periodKey } from '../../domain/numbering.js';
import { bsGolden, codeOf, dayBefore } from './helpers.js';

const VALIDATION = 'common.validation_failed';
const pad2 = (n: number) => String(n).padStart(2, '0');
/** Fiscal year long form of the FY that starts on Shrawan 1 of B.S. year y — derived from the golden table, not from bsdate. */
const fyl = (y: number) => `${y}/${pad2((y + 1) % 100)}`;

describe('§4.6 parseNumberingPattern: grammar {yy} {fy} {fyl} {seq:N} (N 1–9) + literals [A-Z0-9\\-/]', () => {
  it.each(['PO{yy}{seq:6}', 'GR{yy}{seq:6}', 'TR{yy}{seq:6}', 'SC{yy}{seq:5}', 'SD{yy}{seq:6}', 'RC-{fy}-{seq:6}', '{fyl}/{seq:4}', 'A/B-9{seq:1}', '{seq:9}', 'X{yy}{fy}{fyl}{seq:3}'])(
    'accepts %s',
    (p) => {
      expect(() => parseNumberingPattern(p)).not.toThrow();
    },
  );
  it.each([
    ['{prefix} not supported in v1', '{prefix}{yy}{seq:4}'],
    ['{branch} not supported in v1', 'PO-{branch}-{seq:4}'],
    ['{centre} not supported in v1', '{centre}{seq:4}'],
    ['{seq:0} width below 1', 'PO{seq:0}'],
    ['{seq:10} width above 9', 'PO{seq:10}'],
    ['{seq} without width', 'PO{seq}'],
    ['{seq:x} non-numeric width', 'PO{seq:x}'],
    ['unknown token', 'PO{foo}{seq:4}'],
    ['upper-case token', 'PO{YY}{seq:4}'],
    ['lower-case literal', 'po{seq:4}'],
    ['space', 'PO {seq:4}'],
    ['underscore', 'PO_{seq:4}'],
    ['dot', 'PO.{seq:4}'],
    ['unclosed brace', 'PO{seq:4'],
    ['stray closing brace', 'PO{yy}}{seq:4}'],
    ['stray opening brace', 'PO{{yy}{seq:4}'],
    ['trailing newline (regex $ trap)', 'PO{seq:4}\n'],
    ['Arabic-Indic digit literal', 'PO١{seq:4}'],
    ['non-ASCII letter', 'PÖ{seq:4}'],
    ['SQL-ish text', "PO';DROP{seq:4}"],
  ])('rejects %s', (_why, p) => {
    expect(codeOf(() => parseNumberingPattern(p))).toBe(VALIDATION);
  });
  it.each([[undefined], [null], [123], [{}], [['PO{seq:4}']]])('rejects non-string %j', (p) => {
    expect(codeOf(() => parseNumberingPattern(p))).toBe(VALIDATION);
  });
});

describe('§4.6 periodKey is derived from the pattern', () => {
  const D = '2026-11-13'; // B.S. 2083-07-27 → FY 2083/84
  it('{fy} → fy:<fyl> (the key always carries the long form)', () => {
    expect(periodKey('RC-{fy}-{seq:6}', '2025-07-17')).toBe('fy:2082/83');
  });
  it('{fyl} → fy:<fyl>', () => {
    expect(periodKey('{fyl}/{seq:4}', '2025-07-17')).toBe('fy:2082/83');
  });
  it('{yy} only → yy:<A.D. 2-digit year>', () => {
    expect(periodKey('PO{yy}{seq:6}', D)).toBe('yy:26');
    expect(periodKey('PO{yy}{seq:6}', '2027-01-01')).toBe('yy:27');
    expect(periodKey('PO{yy}{seq:6}', '2099-12-31')).toBe('yy:99');
    expect(periodKey('PO{yy}{seq:6}', '2100-01-01')).toBe('yy:00');
  });
  it('{fy} wins over {yy} when both are present', () => {
    expect(periodKey('X{yy}{fy}{seq:3}', D)).toMatch(/^fy:/);
    expect(periodKey('X{fyl}{yy}{seq:3}', D)).toMatch(/^fy:/);
  });
  it('neither token → all', () => {
    expect(periodKey('PO{seq:6}', D)).toBe('all');
    expect(periodKey('LAB-{seq:4}', '1999-01-01')).toBe('all');
  });
  it('every key fits number_counters.period_key (1–16 chars)', () => {
    for (const k of [periodKey('A{fy}{seq:1}', D), periodKey('A{yy}{seq:1}', D), periodKey('A{seq:1}', D)]) {
      expect(k.length).toBeGreaterThanOrEqual(1);
      expect(k.length).toBeLessThanOrEqual(16);
    }
  });
});

describe('04 L16 fiscal year at the Shrawan 1 boundary — shared bsdate golden table (packages/test-fixtures/bsdate)', () => {
  const months = bsGolden();
  const shrawan1 = months.filter((m) => m.bs_month === 4);

  it('the golden table is loaded (1200 months, 100 Shrawan rows)', () => {
    expect(months).toHaveLength(1200);
    expect(shrawan1).toHaveLength(100);
  });

  it('Shrawan 1 of every golden year starts the new FY; the previous A.D. day is still the old FY (periodKey)', () => {
    for (const r of shrawan1) {
      expect(periodKey('X{fy}{seq:1}', r.ad_first_day), `Shrawan 1 ${r.bs_year}`).toBe(`fy:${fyl(r.bs_year)}`);
      expect(periodKey('X{fy}{seq:1}', dayBefore(r.ad_first_day)), `day before Shrawan 1 ${r.bs_year}`).toBe(`fy:${fyl(r.bs_year - 1)}`);
    }
  });

  it('every month of the golden table maps to the FY that began on the latest Shrawan 1 (months 1–3 belong to the year before)', () => {
    for (const r of months) {
      const startYear = r.bs_month >= 4 ? r.bs_year : r.bs_year - 1;
      expect(periodKey('X{fyl}{seq:1}', r.ad_first_day), `${r.bs_year}-${r.bs_month}`).toBe(`fy:${fyl(startYear)}`);
    }
  });

  it('formatNumber {fy} short and {fyl} long at the boundary (IC example RC-082/83-000310)', () => {
    expect(formatNumber('RC-{fy}-{seq:6}', '2025-07-17', 310)).toBe('RC-082/83-000310'); // Shrawan 1 2082
    expect(formatNumber('RC-{fy}-{seq:6}', '2025-07-16', 310)).toBe('RC-081/82-000310'); // Ashadh end 2081
    expect(formatNumber('{fyl}/{seq:4}', '2025-07-17', 7)).toBe('2082/83/0007');
    expect(formatNumber('{fyl}/{seq:4}', '2025-07-16', 7)).toBe('2081/82/0007');
  });

  it('formatNumber {fy} short = long without its first digit, at every golden Shrawan 1', () => {
    for (const r of shrawan1) {
      expect(formatNumber('{fy}-{seq:1}', r.ad_first_day, 1)).toBe(`${fyl(r.bs_year).slice(1)}-1`);
      expect(formatNumber('{fyl}-{seq:1}', r.ad_first_day, 1)).toBe(`${fyl(r.bs_year)}-1`);
    }
  });

  it('century wrap: FY 2099/00 and 1999/00', () => {
    const y2099 = shrawan1.find((r) => r.bs_year === 2099)!;
    const y2000 = shrawan1.find((r) => r.bs_year === 2000)!;
    expect(periodKey('{fyl}{seq:1}', y2099.ad_first_day)).toBe('fy:2099/00');
    expect(periodKey('{fyl}{seq:1}', dayBefore(y2000.ad_first_day))).toBe('fy:1999/00');
  });

  it('{yy} follows the A.D. calendar year, {fy} does not: 2026-12-31 → 2027-01-01 changes yy only', () => {
    expect(periodKey('P{yy}{seq:1}', '2026-12-31')).toBe('yy:26');
    expect(periodKey('P{yy}{seq:1}', '2027-01-01')).toBe('yy:27');
    expect(periodKey('P{fy}{seq:1}', '2026-12-31')).toBe(periodKey('P{fy}{seq:1}', '2027-01-01'));
  });

  it('a date outside the supported B.S. range is rejected for {fy}, not guessed', () => {
    expect(codeOf(() => periodKey('P{fy}{seq:1}', '1900-01-01'))).toMatch(/^common\.(date_out_of_range|validation_failed)$/);
    expect(codeOf(() => periodKey('P{fy}{seq:1}', '2100-06-01'))).toMatch(/^common\.(date_out_of_range|validation_failed)$/);
  });
});

describe('§4.6 formatNumber', () => {
  it.each([
    ['PO{yy}{seq:6}', '2026-11-13', 12, 'PO26000012'], // IC §9.3 example
    ['GR{yy}{seq:6}', '2026-11-13', 1, 'GR26000001'],
    ['SC{yy}{seq:5}', '2026-11-13', 7, 'SC2600007'],
    ['SD{yy}{seq:6}', '2027-01-01', 999999, 'SD27999999'],
    ['TR{yy}{seq:6}', '2026-11-13', 42, 'TR26000042'],
    ['{seq:1}', '2026-11-13', 5, '5'],
    ['A/B-{seq:3}', '2026-11-13', 5, 'A/B-005'],
    ['{seq:9}', '2026-11-13', 123456789, '123456789'],
  ])('%s on %s #%i → %s', (pattern, date, seq, expected) => {
    expect(formatNumber(pattern, date, seq)).toBe(expected);
  });
  it('a sequence wider than N is never truncated (truncation would create duplicate numbers)', () => {
    expect(formatNumber('X{seq:2}', '2026-11-13', 123)).toBe('X123');
    expect(formatNumber('PO{yy}{seq:6}', '2026-11-13', 1234567)).toBe('PO261234567');
  });
  it.each([[0], [-1], [1.5], [Number.NaN], [Number.POSITIVE_INFINITY]])('rejects sequence %s (number_counters.next_value ≥ 1)', (seq) => {
    expect(codeOf(() => formatNumber('PO{yy}{seq:6}', '2026-11-13', seq))).toBe(VALIDATION);
  });
  it('rejects an invalid pattern and a malformed date', () => {
    expect(codeOf(() => formatNumber('{prefix}{seq:4}', '2026-11-13', 1))).toBe(VALIDATION);
    expect(codeOf(() => formatNumber('PO{yy}{seq:6}', '2026-13-45', 1))).toBe(VALIDATION);
    expect(codeOf(() => formatNumber('PO{yy}{seq:6}', 'tomorrow', 1))).toBe(VALIDATION);
  });
});
