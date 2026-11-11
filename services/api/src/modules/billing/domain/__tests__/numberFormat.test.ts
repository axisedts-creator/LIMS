// BL-T02 domain/numberFormat.ts (03-IC §9.3; 02-TRD §12; US-BL-01.5, 08 A13 D-23). Tokens {fy},{fyl},{seq:N},{prefix},{branch} (TRD tree line 112).
// Assumed API: formatDocumentNumber(pattern, { fy: {short,long}, seq, prefix?, branch?, scope?: 'tenant'|'branch' }) -> string
//   scope 'branch' with a pattern lacking {branch} -> LimsError billing.numbering_pattern_invalid (409, nothing allocated)
//   seriesKey(kind: 'INV'|'CN'|'RC', scope: 'tenant'|'branch', branchCode?) -> 'INV' | 'INV:<branch_code>' | 'CN' | 'RC'
import { describe, expect, it } from 'vitest';
import { formatDocumentNumber, seriesKey } from '../numberFormat.js';

const FY = { short: '082/83', long: '2082/83' };

describe('formatDocumentNumber goldens (03-IC §9.3 synthetic examples)', () => {
  it.each([
    ['invoice default', '{fy}-{seq:6}', { fy: FY, seq: 123 }, '082/83-000123'],
    ['invoice first of FY', '{fy}-{seq:6}', { fy: FY, seq: 1 }, '082/83-000001'],
    ['credit_note_no', 'CN-{fy}-{seq:6}', { fy: FY, seq: 7 }, 'CN-082/83-000007'],
    ['receipt_no', 'RC-{fy}-{seq:6}', { fy: FY, seq: 310 }, 'RC-082/83-000310'],
    ['{fyl} long form', 'INV-{fyl}-{seq:4}', { fy: FY, seq: 12 }, 'INV-2082/83-0012'],
    ['{prefix}', '{prefix}{fy}-{seq:5}', { fy: FY, prefix: 'LAB/', seq: 42 }, 'LAB/082/83-00042'],
    ['{branch} series', '{branch}-{fy}-{seq:6}', { fy: FY, branch: 'KTM', seq: 5, scope: 'branch' }, 'KTM-082/83-000005'],
    ['previous FY', '{fy}-{seq:6}', { fy: { short: '081/82', long: '2081/82' }, seq: 99 }, '081/82-000099'],
    ['century roll', '{fyl}-{seq:3}', { fy: { short: '099/00', long: '2099/00' }, seq: 1 }, '2099/00-001'],
  ] as const)('%s', (_n, pattern, ctx, expected) => {
    expect(formatDocumentNumber(pattern, ctx as never)).toBe(expected);
  });
});

describe('formatDocumentNumber edge cases', () => {
  it('never truncates a counter wider than {seq:N} (truncation would collide with an earlier number)', () => {
    expect(formatDocumentNumber('{fy}-{seq:3}', { fy: FY, seq: 12345 })).toBe('082/83-12345');
  });
  it('single pass: a prefix containing token text or $-patterns is not re-expanded', () => {
    expect(formatDocumentNumber('{prefix}{seq:2}', { fy: FY, prefix: '{seq:3}', seq: 5 })).toBe('{seq:3}05');
    expect(formatDocumentNumber('$&{fy}-{seq:2}', { fy: FY, seq: 5 })).toBe('$&082/83-05');
  });
  it('distinct FY or seq always give distinct numbers (uniqueness per (tenant, FY, no))', () => {
    const seen = new Set<string>();
    for (const fy of [FY, { short: '083/84', long: '2083/84' }]) for (let s = 1; s <= 50; s++) seen.add(formatDocumentNumber('{fy}-{seq:6}', { fy, seq: s }));
    expect(seen.size).toBe(100);
  });
  it('throws: missing {seq:N}, bare {seq}, width 0, unknown token, seq 0 or negative/fractional', () => {
    expect(() => formatDocumentNumber('{fy}', { fy: FY, seq: 1 })).toThrow();
    expect(() => formatDocumentNumber('{fy}-{seq}', { fy: FY, seq: 1 })).toThrow();
    expect(() => formatDocumentNumber('{fy}-{seq:0}', { fy: FY, seq: 1 })).toThrow();
    expect(() => formatDocumentNumber('{bogus}-{seq:6}', { fy: FY, seq: 1 })).toThrow();
    expect(() => formatDocumentNumber('{fy}-{seq:6}', { fy: FY, seq: -1 })).toThrow();
    expect(() => formatDocumentNumber('{fy}-{seq:6}', { fy: FY, seq: 1.5 })).toThrow();
  });
  it('a gapless series starts at 1: seq 0 is rejected for fiscal documents', () => {
    expect(() => formatDocumentNumber('{fy}-{seq:6}', { fy: FY, seq: 0 })).toThrow();
  });
  it('a token with no supplied value throws ({branch} without branch)', () => {
    expect(() => formatDocumentNumber('{branch}-{seq:6}', { fy: FY, seq: 1 })).toThrow();
  });
});

describe('branch scope needs {branch} in the pattern (US-BL-01.5; 08 A13 D-23)', () => {
  it('scope=branch + pattern without {branch} -> billing.numbering_pattern_invalid', () => {
    expect(() => formatDocumentNumber('{fy}-{seq:6}', { fy: FY, seq: 1, branch: 'KTM', scope: 'branch' }))
      .toThrowError(expect.objectContaining({ code: 'billing.numbering_pattern_invalid' }));
  });
  it('scope=tenant + pattern without {branch} is fine; a {branch} pattern in tenant scope also formats', () => {
    expect(formatDocumentNumber('{fy}-{seq:6}', { fy: FY, seq: 1, scope: 'tenant' })).toBe('082/83-000001');
    expect(formatDocumentNumber('{branch}/{fy}-{seq:6}', { fy: FY, seq: 1, branch: 'KTM', scope: 'tenant' })).toBe('KTM/082/83-000001');
  });
});

describe('seriesKey (TRD §12 "Series keys")', () => {
  it('tenant scope', () => expect(seriesKey('INV', 'tenant')).toBe('INV'));
  it('branch scope', () => expect(seriesKey('INV', 'branch', 'KTM')).toBe('INV:KTM'));
  it('CN and RC are never per-branch', () => {
    expect(seriesKey('CN', 'branch', 'KTM')).toBe('CN');
    expect(seriesKey('RC', 'tenant')).toBe('RC');
  });
  it('branch scope without a branch code throws; a code outside [A-Za-z0-9_-]{1,20} throws (invoices__series__ck)', () => {
    expect(() => seriesKey('INV', 'branch')).toThrow();
    expect(() => seriesKey('INV', 'branch', 'bad code')).toThrow();
    expect(() => seriesKey('INV', 'branch', 'X'.repeat(21))).toThrow();
    expect(() => seriesKey('INV', 'branch', "K'; DROP")).toThrow();
  });
  it('keys always satisfy the DB regex ^INV(:[A-Za-z0-9_-]{1,20})?$ for INV', () => {
    for (const b of ['KTM', 'a_b-9', 'X'.repeat(20)]) expect(seriesKey('INV', 'branch', b)).toMatch(/^INV(:[A-Za-z0-9_-]{1,20})?$/);
  });
});
