// C3 T-02 — code normalisation (domain/codes.ts). Spec: 02-TRD §5.0 ("trimmed and upper-cased before validation; regex per resource (§5.1)"), §5.1 DTO regexes.
// ACs: AC-01.2 (`haem` == `HAEM`, codes upper-cased on write -> duplicate detection works on the normalised value).
// Interface expected from the writer (spec fixes behaviour, not names) — SEAMS:
//   export type CodeKind = 'master'|'orderable'|'analyte'|'valueSet'|'valueSetValue'|'commentCode'|'doctor'|'party'|'priceList'|'taxType'
//   export function normaliseCode(raw: string): string          trim + upper-case (pure, no validation, never throws for strings)
//   export function isValidCode(kind: CodeKind, raw: unknown): boolean   normalise, then §5.1 regex
//   export function assertCode(kind: CodeKind, raw: unknown, path?: string): string
//        returns the normalised code, else throws LimsError('common.validation_failed') with errors[0] = {path (default '/code'), code:'common.field_invalid', message}
// Assumption (hardening, spec silent): non-ASCII input is rejected even when String#toUpperCase would fold it to ASCII ('ı'->'I', 'ſ'->'S'),
//   so look-alikes cannot collide with / impersonate an existing code.
import { describe, expect, it } from 'vitest';
import { isLimsError } from '../../../../core/errors.js';
import { assertCode, isValidCode, normaliseCode, type CodeKind } from '../codes.js';

/** [kind, regex from 02-TRD §5.1, max length, a valid sample, a sample that is valid for the other kinds but not this one]. */
const KINDS: Array<[CodeKind, RegExp]> = [
  ['master', /^[A-Z0-9][A-Z0-9_]{0,31}$/],
  ['orderable', /^[A-Z0-9][A-Z0-9_\-+.]{0,31}$/],
  ['analyte', /^[A-Z][A-Z0-9_]{0,31}$/],
  ['valueSet', /^[A-Z0-9_]{1,32}$/],
  ['valueSetValue', /^[A-Z0-9_+\-]{1,16}$/],
  ['commentCode', /^[A-Z0-9_]{1,16}$/],
  ['doctor', /^[A-Z0-9_\-]{1,20}$/],
  ['party', /^[A-Z0-9_\-]{1,20}$/],
  ['priceList', /^[A-Z0-9][A-Z0-9_\-]{0,31}$/],
  ['taxType', /^[A-Z0-9_]{1,16}$/],
];

describe('normaliseCode', () => {
  it('AC-01.2: haem / Haem / HAEM / " haem " all normalise to HAEM', () => {
    for (const raw of ['haem', 'Haem', 'HAEM', ' haem ', '\thaem\n', 'hAeM']) expect(normaliseCode(raw)).toBe('HAEM');
  });
  it('trims only the ends, keeps interior characters (validation rejects them later)', () => {
    expect(normaliseCode('  ab cd ')).toBe('AB CD');
  });
  it('is idempotent', () => {
    for (const raw of ['haem', ' x_1 ', 'a-b+c.d', '']) expect(normaliseCode(normaliseCode(raw))).toBe(normaliseCode(raw));
  });
  it('empty / whitespace-only stay empty (then fail validation)', () => {
    expect(normaliseCode('')).toBe('');
    expect(normaliseCode('   \t')).toBe('');
  });
});

describe('assertCode / isValidCode — §5.1 regexes', () => {
  it('AC-01.2: lower-case input is accepted and returned upper-cased', () => {
    expect(assertCode('master', 'haem')).toBe('HAEM');
    expect(assertCode('master', '  HaEm ')).toBe('HAEM');
    expect(normaliseCode('haem')).toBe(assertCode('master', 'HAEM')); // same key -> second create is a code_duplicate
  });

  describe.each(KINDS)('kind %s', (kind, re) => {
    const accepts = (s: string) => re.test(s);
    const samples = [
      'A', 'a', '0', '9', '_', '-', '+', '.', 'A_', '_A', '-A', 'A-', 'A.B', 'A+B', 'A_B_C', 'HAEM', 'hb', '1A',
      'A'.repeat(16), 'A'.repeat(17), 'A'.repeat(20), 'A'.repeat(21), 'A'.repeat(32), 'A'.repeat(33), '',
      'A B', 'A/B', 'A\\B', "A'B", 'A;B', 'A%B', '../A', 'A\u0000B', 'A\nB', 'Aé', 'ı', 'ſ', 'ＡＢ', 'ǅ',
    ];
    it.each(samples)('agrees with the spec regex on %j (after normalise)', (raw) => {
      const norm = normaliseCode(raw);
      const ascii = /^[\x20-\x7e]*$/.test(raw); // hardening: any non-ASCII raw input is invalid
      const expected = ascii && accepts(norm);
      expect(isValidCode(kind, raw)).toBe(expected);
      if (expected) expect(assertCode(kind, raw)).toBe(norm);
      else {
        let thrown: unknown;
        try { assertCode(kind, raw); } catch (e) { thrown = e; }
        expect(isLimsError(thrown, 'common.validation_failed')).toBe(true);
      }
    });

    it('error carries a field error at /code by default and at a caller-given path', () => {
      for (const [path, expectPath] of [[undefined, '/code'], ['/doctor_code', '/doctor_code']] as const) {
        let e: unknown;
        try { assertCode(kind, '!!', path); } catch (x) { e = x; }
        expect(isLimsError(e, 'common.validation_failed')).toBe(true);
        const errs = (e as { errors?: Array<{ path: string; code: string }> }).errors;
        expect(errs?.[0]?.path).toBe(expectPath);
        expect(errs?.[0]?.code).toBe('common.field_invalid');
      }
    });

    it('rejects non-string input without throwing anything but validation_failed', () => {
      for (const bad of [undefined, null, 5, {}, [], ['A'], true]) {
        expect(isValidCode(kind, bad)).toBe(false);
        let e: unknown;
        try { assertCode(kind, bad); } catch (x) { e = x; }
        expect(isLimsError(e, 'common.validation_failed')).toBe(true);
      }
    });
  });

  it('per-kind specifics (boundaries from §5.1)', () => {
    expect(isValidCode('master', 'A'.repeat(32))).toBe(true);
    expect(isValidCode('master', 'A'.repeat(33))).toBe(false);
    expect(isValidCode('master', '_A')).toBe(false); // must start alnum
    expect(isValidCode('master', 'A-B')).toBe(false); // no hyphen
    expect(isValidCode('orderable', 'CBC-1+2.3')).toBe(true);
    expect(isValidCode('analyte', '1HB')).toBe(false); // must start with a letter
    expect(isValidCode('commentCode', 'A'.repeat(16))).toBe(true);
    expect(isValidCode('commentCode', 'A'.repeat(17))).toBe(false);
    expect(isValidCode('valueSetValue', 'POS+')).toBe(true);
    expect(isValidCode('doctor', '_D-1')).toBe(true);
    expect(isValidCode('doctor', 'D'.repeat(21))).toBe(false);
    expect(isValidCode('party', 'CP00001')).toBe(true);
    expect(isValidCode('priceList', '-X')).toBe(false);
    expect(isValidCode('taxType', 'VAT')).toBe(true);
    expect(isValidCode('taxType', 'T'.repeat(17))).toBe(false);
  });

  it('adversarial: look-alike / folding characters never validate or collide with ASCII codes', () => {
    for (const raw of ['ı', 'ſ', 'ＨＡＥＭ', 'HAEM​', '‮HAEM', 'HAEM\u0000', 'HAEM\n', 'HAEM;DROP', "H'AEM"]) {
      expect(isValidCode('master', raw)).toBe(false);
    }
    // 'ß'.toUpperCase() === 'SS' must not turn an invalid raw code into a valid one
    expect(isValidCode('master', 'ß')).toBe(false);
  });

  it('adversarial: very long input is rejected quickly (no catastrophic regex)', () => {
    const t = Date.now();
    expect(isValidCode('master', 'A'.repeat(1_000_000))).toBe(false);
    expect(Date.now() - t).toBeLessThan(1000);
  });
});
