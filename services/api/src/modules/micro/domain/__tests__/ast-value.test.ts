// C10 T-03 — pure domain: AST raw value grammar (02-TRD §4.3), AC-06.2, and exact decimals (TRD §4.5 "scaled BigInt, never IEEE floats").
// Interface expected from the writer (SEAMS = spec fixes the grammar, not the signatures):
//   ../domain/ast-value.ts  export function parseAstValue(input: string, method: 'mic'|'zone_diameter'|'other'):
//        { ok: true, value: { raw_value: string; raw_qualifier?: '<='|'>='|'<'|'>'|'='; raw_numeric?: string; unit_code?: 'ug_ml'|'mm' } }
//      | { ok: false, code: 'micro.ast_value_invalid' }
//      raw_value = input exactly as entered (never trimmed/normalised); parsing uses NFC + trim. raw_numeric is a DecimalString (no exponent).
//   ../domain/decimal.ts    export function parseDecimal(s: string): bigint   (scaled 10^6; throws on malformed)
//                           export function compareDecimal(a: string, b: string): -1 | 0 | 1
import { describe, expect, it } from 'vitest';
import { parseAstValue } from '../ast-value.js';
import { compareDecimal, parseDecimal } from '../decimal.js';

type Method = 'mic' | 'zone_diameter' | 'other';
type Ok = [method: Method, input: string, qualifier: string | undefined, numeric: string | undefined, unit: string | undefined];

const OK: Ok[] = [
  // mic — AC-06.2
  ['mic', '<=0.25', '<=', '0.25', 'ug_ml'],
  ['mic', '≤0.25', '<=', '0.25', 'ug_ml'],
  ['mic', '≤ 0.25', '<=', '0.25', 'ug_ml'],
  ['mic', '>=64', '>=', '64', 'ug_ml'],
  ['mic', '≥64', '>=', '64', 'ug_ml'],
  ['mic', '<1', '<', '1', 'ug_ml'],
  ['mic', '>128', '>', '128', 'ug_ml'],
  ['mic', '=2', '=', '2', 'ug_ml'],
  ['mic', '0.5', '=', '0.5', 'ug_ml'],
  ['mic', '  0.5  ', '=', '0.5', 'ug_ml'],
  ['mic', '8/4', '=', '8', 'ug_ml'], // combination: second number only kept in raw_value
  ['mic', '8 / 4', '=', '8', 'ug_ml'],
  ['mic', '<=0.12/2', '<=', '0.12', 'ug_ml'],
  ['mic', '0.000001', '=', '0.000001', 'ug_ml'], // 6 fraction digits
  ['mic', '999999.999999', '=', '999999.999999', 'ug_ml'], // 6 + 6 digits
  ['mic', '0', '=', '0', 'ug_ml'],
  // zone_diameter
  ['zone_diameter', '18', '=', '18', 'mm'],
  ['zone_diameter', '18.5', '=', '18.5', 'mm'],
  ['zone_diameter', '18.25', '=', '18.25', 'mm'],
  ['zone_diameter', '<=6', '<=', '6', 'mm'],
  ['zone_diameter', '≥ 30', '>=', '30', 'mm'],
  ['zone_diameter', '100', '=', '100', 'mm'], // upper limit inclusive
  ['zone_diameter', '100.00', '=', '100.00', 'mm'],
  ['zone_diameter', '0', '=', '0', 'mm'],
  // other — free text 1..32, no numeric, no unit
  ['other', 'positive', undefined, undefined, undefined],
  ['other', '<=0.25', undefined, undefined, undefined], // not parsed under "other"
  ['other', 'x'.repeat(32), undefined, undefined, undefined],
  ['other', 'x', undefined, undefined, undefined],
];

const BAD: [Method, string][] = [
  ['mic', ''], ['mic', '   '], ['mic', 'abc'], ['mic', '0.25mg'], ['mic', '<=<0.25'], ['mic', '=<0.25'],
  ['mic', '-1'], ['mic', '+1'], ['mic', '1e3'], ['mic', '1,5'], ['mic', '.5'], ['mic', '5.'], ['mic', '1.2.3'],
  ['mic', '8/'], ['mic', '/4'], ['mic', '8/4/2'], ['mic', '8//4'], ['mic', '8/a'],
  ['mic', '1234567'], // > 6 integer digits
  ['mic', '0.1234567'], // > 6 fraction digits
  ['mic', '8/1234567'],
  ['mic', '≤'], ['mic', '<= '], ['mic', '０.５'] /* fullwidth digits are not [0-9] */, ['mic', '1\n2'],
  ['zone_diameter', ''], ['zone_diameter', 'abc'], ['zone_diameter', '100.01'], ['zone_diameter', '101'],
  ['zone_diameter', '1000'], ['zone_diameter', '18.123'], ['zone_diameter', '8/4'], ['zone_diameter', '-5'],
  ['zone_diameter', '18mm'],
  ['other', ''], ['other', '   '], ['other', 'x'.repeat(33)],
];

describe('parseAstValue — accepted values (TRD §4.3, AC-06.2)', () => {
  it.each(OK)('%s %j parses', (method, input, qualifier, numeric, unit) => {
    const r = parseAstValue(input, method);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.raw_value).toBe(input); // stored exactly as entered
    expect(r.value.raw_qualifier).toBe(qualifier);
    expect(r.value.raw_numeric).toBe(numeric);
    expect(r.value.unit_code).toBe(unit);
  });

  it('"≤0.25" is never stored as plain 0.25 (qualifier not dropped)', () => {
    const r = parseAstValue('≤0.25', 'mic');
    expect(r).toMatchObject({ ok: true, value: { raw_qualifier: '<=', raw_numeric: '0.25' } });
  });

  it('NFC: decomposed input is stored unchanged', () => {
    const decomposed = 'é'; // e + combining acute
    expect(parseAstValue(decomposed, 'other')).toMatchObject({ ok: true, value: { raw_value: decomposed } });
  });
});

describe('parseAstValue — rejected values → micro.ast_value_invalid', () => {
  it.each(BAD)('%s %j is invalid', (method, input) => {
    expect(parseAstValue(input, method)).toEqual({ ok: false, code: 'micro.ast_value_invalid' });
  });

  it('raw_value longer than 32 chars is invalid for every method', () => {
    for (const m of ['mic', 'zone_diameter', 'other'] as const) {
      expect(parseAstValue('1'.repeat(33), m)).toEqual({ ok: false, code: 'micro.ast_value_invalid' });
    }
  });

  it('does not throw and stays fast on pathological input (no ReDoS)', () => {
    const t = Date.now();
    for (const s of ['1'.repeat(50000), ' '.repeat(50000) + 'x', '8/'.repeat(20000), '<'.repeat(50000)]) {
      for (const m of ['mic', 'zone_diameter', 'other'] as const) {
        expect(parseAstValue(s, m).ok).toBe(false);
      }
    }
    expect(Date.now() - t).toBeLessThan(1000);
  });
});

describe('decimal.ts — exact scaled-BigInt (no IEEE floats)', () => {
  it('parseDecimal scales by 10^6', () => {
    expect(parseDecimal('0')).toBe(0n);
    expect(parseDecimal('1')).toBe(1_000_000n);
    expect(parseDecimal('0.25')).toBe(250_000n);
    expect(parseDecimal('0.000001')).toBe(1n);
    expect(parseDecimal('999999.999999')).toBe(999_999_999_999n);
  });

  it.each(['', 'abc', '1e3', '-', '1.', '.5', '1.2.3', ' 1', '0.1234567'])('parseDecimal(%j) throws', (s) => {
    expect(() => parseDecimal(s)).toThrow();
  });

  it('compareDecimal is exact where floats are not', () => {
    expect(compareDecimal('0.1', '0.10')).toBe(0);
    expect(compareDecimal('0.25', '0.5')).toBe(-1);
    expect(compareDecimal('64', '8')).toBe(1); // numeric, not lexicographic
    expect(compareDecimal('0.300000', '0.3')).toBe(0);
    expect(compareDecimal('999999.999999', '999999.999998')).toBe(1);
    expect(compareDecimal('0.000001', '0')).toBe(1);
  });
});
