// FD-T02 numbering.ts (03-IC §9.3 pattern tokens). Goldens are the synthetic examples in the 03-IC §9.3 table.
// Assumed API: formatNumber(pattern, { prefix?, branch?, centre?, year?, fy?, fyl?, seq }) -> string; hasToken(pattern, name) -> boolean.
import { describe, expect, it } from 'vitest';
import { formatNumber, hasToken } from '../numbering.js';

describe('formatNumber goldens', () => {
  it.each([
    ['patient_code', '{prefix}{seq:8}', { prefix: 'MP', seq: 4211 }, 'MP00004211'],
    ['registration_no', '{branch}{prefix}{seq:6}', { branch: '0001', prefix: 'SY', seq: 1 }, '0001SY000001'],
    ['barcode', '{prefix}{yy}{seq:8}', { prefix: 'E', year: 2026, seq: 42 }, 'E2600000042'],
    ['receipt_no', 'RC-{fy}-{seq:6}', { fy: '082/83', seq: 310 }, 'RC-082/83-000310'],
    ['credit_note_no', 'CN-{fy}-{seq:6}', { fy: '082/83', seq: 7 }, 'CN-082/83-000007'],
    ['invoice default', '{fy}-{seq:6}', { fy: '082/83', seq: 1 }, '082/83-000001'],
    ['booking_no', 'BK{yy}{seq:6}', { year: 2026, seq: 15 }, 'BK26000015'],
    ['{fyl} long form', 'INV-{fyl}-{seq:4}', { fyl: '2082/83', seq: 12 }, 'INV-2082/83-0012'],
    ['{centre} token', '{centre}-{seq:3}', { centre: 'A1', seq: 9 }, 'A1-009'],
    ['yy zero-pads', '{yy}{seq:1}', { year: 2005, seq: 1 }, '051'],
  ] as const)('%s', (_n, pattern, ctx, expected) => {
    expect(formatNumber(pattern, ctx as never)).toBe(expected);
  });
});

describe('formatNumber edge cases', () => {
  it('never truncates a counter wider than {seq:N} (truncation would collide)', () => {
    expect(formatNumber('X{seq:3}', { seq: 12345 })).toBe('X12345');
  });
  it('is single-pass: values and literals are not re-expanded or treated as replace() patterns', () => {
    expect(formatNumber('{prefix}{seq:2}', { prefix: '{seq:3}', seq: 5 })).toBe('{seq:3}05');
    expect(formatNumber("$&-$1-{seq:2}", { seq: 5 })).toBe('$&-$1-05');
  });
  it('same token may appear twice', () => {
    expect(formatNumber('{prefix}-{prefix}{seq:2}', { prefix: 'Z', seq: 3 })).toBe('Z-Z03');
  });
  it('throws on a token with no supplied value', () => {
    expect(() => formatNumber('{branch}{seq:6}', { seq: 1 })).toThrow();
    expect(() => formatNumber('{fy}-{seq:6}', { seq: 1 })).toThrow();
    expect(() => formatNumber('{yy}{seq:6}', { seq: 1 })).toThrow();
  });
  it('throws on unknown tokens, bare {seq}, zero/negative width', () => {
    expect(() => formatNumber('{bogus}{seq:6}', { seq: 1 })).toThrow();
    expect(() => formatNumber('{seq}', { seq: 1 })).toThrow();
    expect(() => formatNumber('{seq:0}', { seq: 1 })).toThrow();
    expect(() => formatNumber('{seq:-2}', { seq: 1 })).toThrow();
  });
  it('throws on a pattern without {seq:N} (cannot be unique)', () => {
    expect(() => formatNumber('{prefix}', { prefix: 'A', seq: 1 })).toThrow();
  });
  it('throws on invalid seq (negative, fractional, NaN)', () => {
    for (const seq of [-1, 1.5, Number.NaN]) expect(() => formatNumber('{seq:6}', { seq })).toThrow();
  });
});

describe('hasToken (08 A13 D-23: registrationNoPattern must contain {branch})', () => {
  it('detects tokens', () => {
    expect(hasToken('{branch}{prefix}{seq:6}', 'branch')).toBe(true);
    expect(hasToken('{prefix}{seq:6}', 'branch')).toBe(false);
    expect(hasToken('{prefix}{seq:6}', 'seq')).toBe(true);
  });
});
