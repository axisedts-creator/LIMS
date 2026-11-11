// PG-T02 — amount golden cases (TRD §7.2.3 formatRupees, §7.2.4 exact decimal parse, 04 P4 Khalti minimum 1000 paisa).
// Exact decimal only: no floats (02-CV §4.9, REQ-SEC-048).
import { describe, expect, it } from 'vitest';
import { assertAmountSupported, formatRupees, rupeesTextToPaisa } from '../../../domain/amount.js';

const codeOf = (fn: () => unknown): string | undefined => {
  try { fn(); } catch (e) { return (e as { code?: string }).code; }
  return undefined;
};

describe('rupeesTextToPaisa (gateway decimal text -> integer paisa, undefined = mismatch)', () => {
  it.each([
    ['2250', 225000],      // golden: due 2250
    ['2250.0', 225000],    // eSewa returns 2250.0 (US-PG-03 AC1)
    ['150.0', 15000],      // golden
    ['22.5', 2250],        // golden: 22.5 != 2250 rupees (US-PG-03 AC4, ST-03)
    ['0.01', 1],
    ['0.10', 10],
    ['2250.10', 225010],
    ['2250.100', 225010],  // trailing zero is not a third significant fraction digit
    ['0', 0],
    ['0.0', 0],
  ])('%s -> %i', (text, paisa) => {
    expect(rupeesTextToPaisa(text)).toBe(paisa);
  });

  it.each(['0.001', '2250.005', '1.999', '0.0001'])('%s has more than 2 non-zero fraction digits -> undefined (mismatch)', (t) => {
    expect(rupeesTextToPaisa(t)).toBeUndefined();
  });

  it.each(['', ' ', 'abc', '1e3', '1,000', '2250.', '.5', '--1', '12 34', 'NaN', 'Infinity', '0x10'])('rejects non-decimal %j', (t) => {
    expect(rupeesTextToPaisa(t)).toBeUndefined();
  });

  it('rejects values beyond the safe-integer paisa range instead of rounding', () => {
    expect(rupeesTextToPaisa('99999999999999999999')).toBeUndefined();
    expect(rupeesTextToPaisa('90071992547410.00')).toBeUndefined(); // 9007199254741000 paisa > MAX_SAFE_INTEGER
  });

  it('is exact where binary floats are not (no float path)', () => {
    expect(rupeesTextToPaisa('0.29')).toBe(29);  // 0.29*100 === 28.999999999999996 in floats
    expect(rupeesTextToPaisa('1.15')).toBe(115); // 1.15*100 === 114.99999999999999
    expect(rupeesTextToPaisa('4.35')).toBe(435);
  });
});

describe('formatRupees (paisa -> eSewa amount string)', () => {
  it.each([[225000, '2250'], [100, '1'], [15000, '150'], [100000000, '1000000']])('%i paisa -> %j (integer rupees, no separators)', (p, s) => {
    expect(formatRupees(p)).toBe(s);
  });

  it('round trips with rupeesTextToPaisa for whole rupees', () => {
    for (const p of [100, 12300, 225000, 99999900]) expect(rupeesTextToPaisa(formatRupees(p))).toBe(p);
  });

  it.each([225050, 150, 999, 101])('fractional rupee %i paisa is amount_not_supported while the flag is off', (p) => {
    expect(codeOf(() => formatRupees(p))).toBe('payments.amount_not_supported');
  });

  it.each([[225050, '2250.50'], [5, '0.05'], [101, '1.01'], [150, '1.50']])('flag on: %i paisa -> %j (<rupees>.<2 digits>)', (p, s) => {
    expect(formatRupees(p, { allowFractional: true })).toBe(s);
  });

  it.each([0, -100, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2])('rejects non-positive / non-integer / unsafe paisa %s', (p) => {
    expect(() => formatRupees(p)).toThrow();
  });
});

describe('assertAmountSupported (04 P4: Khalti min 1000 paisa; intents__amount__ck > 0)', () => {
  it('Khalti 999 paisa -> payments.amount_not_supported (422)', () => {
    let err: { code?: string; statusCode?: number } | undefined;
    try { assertAmountSupported('khalti', 999); } catch (e) { err = e as never; }
    expect(err?.code).toBe('payments.amount_not_supported');
    expect(err?.statusCode).toBe(422);
  });

  it.each([1000, 1001, 225000])('Khalti %i paisa is supported', (p) => {
    expect(() => assertAmountSupported('khalti', p)).not.toThrow();
  });

  it.each([1, 500, 999])('Khalti %i paisa is below the minimum', (p) => {
    expect(codeOf(() => assertAmountSupported('khalti', p))).toBe('payments.amount_not_supported');
  });

  it('eSewa has no 1000-paisa minimum (whole rupee 100 paisa passes)', () => {
    expect(() => assertAmountSupported('esewa', 100)).not.toThrow();
  });

  it.each(['esewa', 'khalti'] as const)('%s: zero / negative / non-integer amount is rejected', (g) => {
    for (const p of [0, -1, 1.5, Number.NaN]) expect(() => assertAmountSupported(g, p), `${g} ${p}`).toThrow();
  });
});
