// C12.T-02 — domain/quantity.ts (02-TRD §3.1, §4.1, §6.1; PRD AC-02.4). Unit tests, written before the implementation.
// Expected interface (domain/quantity.ts):
//   parseBaseQty(input: unknown): string   positive DecimalStringPositive ^[0-9]{1,12}(\.[0-9]{1,6})?$ and > 0; returns the input string
//   parsePackQty(input: unknown): string   positive DecimalStringPacks    ^[0-9]{1,9}(\.[0-9]{1,3})?$  and > 0; returns the input string
//   packToBase(qtyPacks: string, qtyInBase: string): string   round_half_up(qtyPacks × qtyInBase, 6) as a decimal string
// Every rejection throws an error whose `.code` is 'common.validation_failed'.
import { describe, expect, it } from 'vitest';
import { packToBase, parseBaseQty, parsePackQty } from '../../domain/quantity.js';
import { codeOf, norm } from './helpers.js';

const VALIDATION = 'common.validation_failed';

describe('AC-02.4 parseBaseQty (base unit: ≤12 integer digits, ≤6 decimals, > 0)', () => {
  it.each(['1', '0.000001', '999999999999', '999999999999.999999', '12.5', '0.5', '100.000000', '007'])('accepts %s', (v) => {
    expect(parseBaseQty(v)).toBe(v);
  });
  it.each([
    ['7 decimal places', '1.0000001'],
    ['7 decimal places, tiny', '0.0000001'],
    ['13 integer digits', '1000000000000'],
    ['zero', '0'],
    ['zero with decimals', '0.000000'],
    ['negative', '-1'],
    ['negative zero', '-0'],
    ['negative decimal', '-0.5'],
    ['empty', ''],
    ['whitespace', ' 1'],
    ['trailing whitespace', '1 '],
    ['trailing newline (regex $ trap)', '1\n'],
    ['leading plus', '+1'],
    ['exponent', '1e3'],
    ['comma decimal', '1,5'],
    ['no integer part', '.5'],
    ['no fraction digits', '1.'],
    ['text', 'abc'],
    ['Arabic-Indic digit', '١'],
    ['two dots', '1.2.3'],
  ])('rejects %s (%j)', (_why, v) => {
    expect(codeOf(() => parseBaseQty(v))).toBe(VALIDATION);
  });
  it.each([[1], [null], [undefined], [{}], [['1']], [true]])('rejects non-string %j (never coerces a number)', (v) => {
    expect(codeOf(() => parseBaseQty(v))).toBe(VALIDATION);
  });
});

describe('AC-02.4 parsePackQty (pack quantity: ≤9 integer digits, ≤3 decimals, > 0; numeric(12,3))', () => {
  it.each(['1', '0.001', '999999999', '999999999.999', '2.5', '10.000'])('accepts %s', (v) => {
    expect(parsePackQty(v)).toBe(v);
  });
  it.each([
    ['4 decimal places', '1.0001'],
    ['10 integer digits', '1000000000'],
    ['zero', '0'],
    ['zero with decimals', '0.000'],
    ['negative', '-1'],
    ['empty', ''],
    ['exponent', '1e2'],
    ['no integer part', '.5'],
    ['trailing newline', '1\n'],
    ['base-unit shape with 6 decimals', '0.000001'],
  ])('rejects %s (%j)', (_why, v) => {
    expect(codeOf(() => parsePackQty(v))).toBe(VALIDATION);
  });
  it('rejects non-strings', () => {
    expect(codeOf(() => parsePackQty(3))).toBe(VALIDATION);
    expect(codeOf(() => parsePackQty(null))).toBe(VALIDATION);
  });
});

describe('§4.1 packToBase = round_half_up(qty_packs × pack.qty_in_base, 6)', () => {
  it.each([
    ['2', '12', '24'],
    ['2.5', '12', '30'],
    ['0.001', '1000', '1'],
    ['1.001', '0.333333', '0.333666'], // 0.333666333 → 0.333666
    ['3', '0.123457', '0.370371'], // exact
    ['0.001', '0.0005', '0.000001'], // 5e-7 is exactly half → rounds UP (half-up, not banker's)
    ['1.5', '0.000001', '0.000002'], // 1.5e-6 → half up
    ['2.5', '0.000001', '0.000003'], // 2.5e-6 → half up (banker's would give 2e-6)
    ['0.5', '0.000003', '0.000002'], // 1.5e-6 → half up
    ['999999999.999', '1', '999999999.999'],
    ['0.1', '0.2', '0.02'], // binary-float trap: 0.1*0.2 = 0.020000000000000004
    ['0.7', '0.1', '0.07'], // 0.7*0.1 = 0.06999999999999999 in binary floats
    ['1.1', '1.1', '1.21'], // 1.1*1.1 = 1.2100000000000002
  ])('%s packs × %s base per pack = %s', (packs, perPack, expected) => {
    expect(norm(packToBase(packs, perPack))).toBe(expected);
  });
  it('rejects an invalid pack quantity (4 decimals) instead of silently rounding it', () => {
    expect(codeOf(() => packToBase('1.0001', '10'))).toBe(VALIDATION);
  });
  it('rejects a zero or negative pack quantity', () => {
    expect(codeOf(() => packToBase('0', '10'))).toBe(VALIDATION);
    expect(codeOf(() => packToBase('-1', '10'))).toBe(VALIDATION);
  });
  it('rejects a malformed qty_in_base', () => {
    expect(codeOf(() => packToBase('1', 'abc'))).toBe(VALIDATION);
    expect(codeOf(() => packToBase('1', '1e3'))).toBe(VALIDATION);
  });
});
