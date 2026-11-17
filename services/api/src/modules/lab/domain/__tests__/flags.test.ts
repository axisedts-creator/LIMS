// C5 T-12 — flags, critical decision, ordinal validation, canonical value hash (02-TRD §4.3 steps 1,3,4; 06 row T-12; 08 A13 D-9).
// ACs: AC-08.6 (ordinal codes only from ordinalSetValues; outside normalCodes -> A), AC-13.1 (7.0 vs critical high 6.5 -> HH, direction high),
//      AC-13.2 (idempotency key = first 16 hex of SHA-256 over the canonical value string n:/o:/t:, 02-TRD §5 [CONV]).
// Interface expected from the writer (../flags.ts) — SEAM (spec fixes behaviour, not the names):
//   export type Flag = 'N' | 'L' | 'H' | 'LL' | 'HH' | 'A'
//   export function compareDecimal(a: string, b: string): -1 | 0 | 1                 exact decimal-string comparison (no float), negatives allowed
//   export function computeFlag(i: { kind: 'numeric' | 'code'; value: string;
//       range?: { low?: string; high?: string; normalCodes?: readonly string[] };
//       critical?: { low?: string; high?: string; abnormalCodes?: readonly string[] }; manualAbnormal?: boolean }): Flag | undefined
//     numeric: < critical.low LL; > critical.high HH; else < low L; > high H; else N. Equal-to-limit is NOT flagged. No bound at all -> undefined (never a guess).
//     code: 'A' if code in critical.abnormalCodes, or range.normalCodes present and code not in it, or manualAbnormal; else undefined.
//   export function criticalDecision(i: { flag?: Flag; code?: string; abnormalCodes?: readonly string[] }): { critical: boolean; direction?: 'low' | 'high' | 'abnormal' }
//   export function validateOrdinalCode(code: string, ordinalSetValues?: readonly { code: string; display: string; sortOrder: number }[]): void   throws LimsError('lab.result_value_invalid')
//   export function canonicalValueString(kind: 'numeric' | 'ordinal' | 'text', value: string): string       'n:<decimal>' | 'o:<code>' | 't:<text>'
//   export function valueSha256Prefix16(kind: 'numeric' | 'ordinal' | 'text', value: string): string        first 16 hex chars of SHA-256(canonicalValueString)
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { isLimsError } from '../../../../core/errors.js';
import { canonicalValueString, compareDecimal, computeFlag, criticalDecision, validateOrdinalCode, valueSha256Prefix16 } from '../flags.js';

const num = (value: string, range?: { low?: string; high?: string }, critical?: { low?: string; high?: string }, extra: object = {}) =>
  computeFlag({ kind: 'numeric', value, range, critical, ...extra });
const code = (value: string, range?: { normalCodes?: readonly string[] }, critical?: { abnormalCodes?: readonly string[] }, extra: object = {}) =>
  computeFlag({ kind: 'code', value, range, critical, ...extra });
const RANGE = { low: '3.5', high: '5.1' };
const CRIT = { low: '2.5', high: '6.5' };

describe('T-12 compareDecimal is exact', () => {
  it('orders decimal strings without float error', () => {
    expect(compareDecimal('1', '2')).toBe(-1);
    expect(compareDecimal('2', '1')).toBe(1);
    expect(compareDecimal('5.1', '5.10')).toBe(0);
    expect(compareDecimal('0.1', '0.10000000000000000001')).toBe(-1); // beyond float precision
    expect(compareDecimal('-1.5', '-1.0')).toBe(-1);
    expect(compareDecimal('-0.5', '0.5')).toBe(-1);
    expect(compareDecimal('10', '9.99')).toBe(1);
    expect(compareDecimal('0', '0.0')).toBe(0);
  });
});

describe('T-12 numeric flags (02-TRD §4.3 step 3)', () => {
  it('N inside the range; L / H outside; LL / HH beyond critical', () => {
    expect(num('4.0', RANGE, CRIT)).toBe('N');
    expect(num('3.0', RANGE, CRIT)).toBe('L');
    expect(num('5.5', RANGE, CRIT)).toBe('H');
    expect(num('2.0', RANGE, CRIT)).toBe('LL');
    expect(num('7.0', RANGE, CRIT)).toBe('HH'); // AC-13.1
  });
  it('equal-to-limit is not flagged (range and critical, both ends)', () => {
    expect(num('3.5', RANGE, CRIT)).toBe('N');
    expect(num('5.1', RANGE, CRIT)).toBe('N');
    expect(num('2.5', RANGE, CRIT)).toBe('L'); // = critical.low is not LL; still below range.low
    expect(num('6.5', RANGE, CRIT)).toBe('H'); // = critical.high is not HH; still above range.high
  });
  it('comparison is on exact decimals (trailing zeros, digits beyond float precision)', () => {
    expect(num('5.10', RANGE, CRIT)).toBe('N');
    expect(num('5.1000000000000000001', RANGE, CRIT)).toBe('H');
    expect(num('-1.5', { low: '-1.0', high: '1.0' })).toBe('L');
  });
  it('missing range and missing critical -> no flag at all', () => {
    expect(num('4.0')).toBeUndefined();
    expect(num('4.0', undefined, undefined)).toBeUndefined();
    expect(num('4.0', {}, {})).toBeUndefined();
  });
  it('one-sided range: only the bound that exists is compared', () => {
    expect(num('9.9', { high: '10' })).toBe('N');
    expect(num('10.1', { high: '10' })).toBe('H');
    expect(num('0.1', { low: '0.5' })).toBe('L');
    expect(num('99', { low: '0.5' })).toBe('N');
  });
  it('critical without a range still flags LL/HH (critical is checked first); inside critical -> no flag', () => {
    expect(num('7.0', undefined, CRIT)).toBe('HH');
    expect(num('2.0', undefined, CRIT)).toBe('LL');
    expect(num('4.0', undefined, CRIT)).toBeUndefined();
  });
  it('a manual abnormal flag does not change a numeric flag', () => {
    expect(num('4.0', RANGE, CRIT, { manualAbnormal: true })).toBe('N');
  });
});

describe('T-12 non-numeric flags (A via normalCodes / abnormalCodes / manual, 08 A13 D-9)', () => {
  it('code outside the range match normalCodes -> A (AC-08.6)', () => {
    expect(code('2+', { normalCodes: ['NEG', 'TRACE'] })).toBe('A');
  });
  it('code inside normalCodes -> no flag', () => {
    expect(code('NEG', { normalCodes: ['NEG', 'TRACE'] })).toBeUndefined();
  });
  it('code in critical.abnormalCodes -> A even when normalCodes is absent', () => {
    expect(code('POS', undefined, { abnormalCodes: ['POS'] })).toBe('A');
    expect(code('NEG', undefined, { abnormalCodes: ['POS'] })).toBeUndefined();
  });
  it('code in abnormalCodes wins over membership in normalCodes', () => {
    expect(code('TRACE', { normalCodes: ['NEG', 'TRACE'] }, { abnormalCodes: ['TRACE'] })).toBe('A');
  });
  it('manual abnormal -> A; otherwise no flag when nothing says abnormal', () => {
    expect(code('NEG', undefined, undefined, { manualAbnormal: true })).toBe('A');
    expect(code('NEG')).toBeUndefined();
  });
});

describe('T-12 critical decision (02-TRD §4.3 step 4)', () => {
  it('LL -> low, HH -> high', () => {
    expect(criticalDecision({ flag: 'LL' })).toEqual({ critical: true, direction: 'low' });
    expect(criticalDecision({ flag: 'HH' })).toEqual({ critical: true, direction: 'high' });
  });
  it('code in abnormalCodes -> abnormal', () => {
    expect(criticalDecision({ flag: 'A', code: 'POS', abnormalCodes: ['POS'] })).toEqual({ critical: true, direction: 'abnormal' });
  });
  it('L, H, N, undefined are not critical; A from normalCodes only is not critical', () => {
    for (const flag of ['L', 'H', 'N', undefined] as const) expect(criticalDecision({ flag })).toEqual({ critical: false });
    expect(criticalDecision({ flag: 'A', code: '2+', abnormalCodes: ['POS'] })).toEqual({ critical: false });
    expect(criticalDecision({ flag: 'A', code: '2+' })).toEqual({ critical: false });
  });
});

describe('T-12 ordinal validation against ordinalSetValues (02-TRD §4.3 step 1; AC-08.6; 08 A13 D-9)', () => {
  const SET = [
    { code: 'NEG', display: 'Negative', sortOrder: 1 },
    { code: '1+', display: 'One plus', sortOrder: 2 },
    { code: '2+', display: 'Two plus', sortOrder: 3 },
    { code: 'TRACE', display: 'Trace', sortOrder: 0 },
  ];
  it('accepts exactly the listed codes', () => {
    for (const c of ['NEG', '1+', '2+', 'TRACE']) expect(() => validateOrdinalCode(c, SET)).not.toThrow();
  });
  it.each(['3+', 'neg', 'Negative', ' NEG', 'NEG ', '', 'free text', "'; DROP TABLE lab.results;--"])('rejects %j with lab.result_value_invalid', (v) => {
    try { validateOrdinalCode(v, SET); } catch (e) {
      expect(isLimsError(e, 'lab.result_value_invalid')).toBe(true);
      expect(`${(e as Error).message} ${(e as { detail?: string }).detail ?? ''}`).not.toContain('DROP TABLE'); // never echo the value
      return;
    }
    throw new Error(`expected lab.result_value_invalid for ${JSON.stringify(v)}`);
  });
  it('no ordinalSetValues (or an empty set) accepts nothing', () => {
    for (const set of [undefined, []] as const) {
      expect(() => validateOrdinalCode('NEG', set)).toThrow();
    }
  });
});

describe('T-12 canonical value string and hash (02-TRD §5 [CONV])', () => {
  const sha16 = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);
  it('canonical strings are n:<decimal> / o:<code> / t:<text>', () => {
    expect(canonicalValueString('numeric', '7.0')).toBe('n:7.0');
    expect(canonicalValueString('ordinal', '2+')).toBe('o:2+');
    expect(canonicalValueString('text', 'Hemolysed')).toBe('t:Hemolysed');
  });
  it('hash = first 16 hex chars of SHA-256 over the canonical string (independent oracle)', () => {
    expect(valueSha256Prefix16('numeric', '7.0')).toBe(sha16('n:7.0'));
    expect(valueSha256Prefix16('ordinal', '2+')).toBe(sha16('o:2+'));
    expect(valueSha256Prefix16('text', 'Hemolysed')).toBe(sha16('t:Hemolysed'));
    expect(valueSha256Prefix16('numeric', '7.0')).toMatch(/^[0-9a-f]{16}$/); // critical_value_log__hash__ck
  });
  it('same value -> same hash (AC-13.2 re-save); different value or kind -> different hash', () => {
    expect(valueSha256Prefix16('numeric', '7.0')).toBe(valueSha256Prefix16('numeric', '7.0'));
    expect(valueSha256Prefix16('numeric', '7.0')).not.toBe(valueSha256Prefix16('numeric', '7.1'));
    expect(valueSha256Prefix16('ordinal', '1')).not.toBe(valueSha256Prefix16('text', '1'));
  });
});
