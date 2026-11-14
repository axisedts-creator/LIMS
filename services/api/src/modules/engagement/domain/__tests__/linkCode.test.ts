// C16 T-02 linkCode.ts (02-TRD §4.3: Crockford base32 without I L O U, 10 symbols shown XXXXX-XXXXX; normalise: uppercase,
// strip '-' and spaces, O->0, I/L->1; E14 input ^[0-9A-Za-z -]+$ length 10–13; US-EN-12 n/a — linking US-EN-07 prerequisite).
// Assumed API: LINK_CODE_ALPHABET (string, 32 symbols), LINK_CODE_LENGTH (10), normalizeLinkCode(raw) -> string,
//   isValidLinkCode(raw) -> boolean (after normalisation: exactly 10 alphabet symbols), formatLinkCode(normalised) -> 'XXXXX-XXXXX'
import { describe, expect, it } from 'vitest';
import { LINK_CODE_ALPHABET, LINK_CODE_LENGTH, formatLinkCode, isValidLinkCode, normalizeLinkCode } from '../linkCode.js';

describe('alphabet', () => {
  it('32 distinct symbols, no I L O U, digits + uppercase only', () => {
    expect(LINK_CODE_ALPHABET).toHaveLength(32);
    expect(new Set(LINK_CODE_ALPHABET).size).toBe(32);
    expect(LINK_CODE_ALPHABET).toMatch(/^[0-9A-Z]{32}$/);
    for (const c of 'ILOU') expect(LINK_CODE_ALPHABET).not.toContain(c);
  });
  it('10 symbols = 50 bits', () => expect(LINK_CODE_LENGTH * Math.log2(LINK_CODE_ALPHABET.length)).toBe(50));
});

describe('normalizeLinkCode table', () => {
  it.each([
    ['ABCDE-FGHJK', 'ABCDEFGHJK'],
    ['abcde-fghjk', 'ABCDEFGHJK'],
    ['abcde fghjk', 'ABCDEFGHJK'],
    [' A B C D E - F G H J K ', 'ABCDEFGHJK'],
    ['0123456789', '0123456789'],
    ['OOOOO-OOOOO', '0000000000'],
    ['ooooo-ooooo', '0000000000'],
    ['IIIII-LLLLL', '1111111111'],
    ['iiiii-lllll', '1111111111'],
    ['AB0CD-1EFGH', 'AB0CD1EFGH'],
    ['ABOCD-IEFLH', 'AB0CD1EF1H'],
    ['', ''],
  ])('%j -> %j', (raw, expected) => expect(normalizeLinkCode(raw)).toBe(expected));
  it('is idempotent', () => {
    const once = normalizeLinkCode('abOIl-Z9 xK');
    expect(normalizeLinkCode(once)).toBe(once);
  });
  it('does not rewrite U (excluded symbol stays invalid)', () => expect(normalizeLinkCode('UUUUU-UUUUU')).toBe('UUUUUUUUUU'));
});

describe('isValidLinkCode', () => {
  it.each([
    ['ABCDE-FGHJK', true],
    ['abcdefghjk', true],
    ['OIL01-23456', true], // O/I/L are normalised, so typed-by-eye codes still validate
    ['0123456789', true],
  ])('accepts %j', (raw, ok) => expect(isValidLinkCode(raw)).toBe(ok));
  it.each([
    ['too short', 'ABCDE-FGHJ'],
    ['too long', 'ABCDE-FGHJKM'],
    ['U is not in the alphabet', 'ABCDE-FGHJU'],
    ['punctuation', 'ABCDE_FGHJK'],
    ['unicode digit-lookalike', 'ABCDE-FGHJ٣'],
    ['empty', ''],
    ['only separators', '----- -----'],
    ['SQL-ish', "ABCDE'; DROP"],
  ])('rejects %s', (_n, raw) => expect(isValidLinkCode(raw)).toBe(false));
});

describe('formatLinkCode', () => {
  it('groups 5-5 with a dash', () => expect(formatLinkCode('ABCDEFGHJK')).toBe('ABCDE-FGHJK'));
  it('round-trips through normalize', () => expect(normalizeLinkCode(formatLinkCode('0123456789'))).toBe('0123456789'));
});
