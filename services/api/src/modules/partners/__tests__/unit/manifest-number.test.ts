// C13 T04 — manifest number MF{yy}{seq:6} (03-APP-FLOW §4.1 M1 step 2; 05-SCHEMA manifests__no__ck ^MF[0-9]{8}$; US-04.1).
// yy = A.D. two-digit year in the TENANT timezone. Counter allocation itself is T08; only the pure formatter lives here.
// SEAMS: ../../domain/manifest-number.ts exports manifestYy(now: Date, timeZone: string): string  and  formatManifestNo(yy: string, seq: number): string.
// Fails now: ../../domain/manifest-number.js does not exist.
import { describe, expect, it } from 'vitest';
import { formatManifestNo, manifestYy } from '../../domain/manifest-number.js';

describe('formatManifestNo', () => {
  it('zero-pads seq to 6 digits', () => {
    expect(formatManifestNo('26', 1)).toBe('MF26000001');
    expect(formatManifestNo('26', 42)).toBe('MF26000042');
    expect(formatManifestNo('05', 123456)).toBe('MF05123456');
    expect(formatManifestNo('26', 999999)).toBe('MF26999999');
  });
  it('always matches the DB check ^MF[0-9]{8}$', () => {
    for (const seq of [1, 9, 10, 99, 100, 999, 1000, 99999, 100000, 999999]) expect(formatManifestNo('26', seq)).toMatch(/^MF[0-9]{8}$/);
  });
  it.each([0, -1, 1_000_000, 1.5, NaN, Infinity])('rejects seq %s (never emits a malformed number)', (seq) => {
    expect(() => formatManifestNo('26', seq)).toThrow();
  });
  it.each(['', '7', '2026', 'ab', ' 7', '2 ', '-1'])('rejects yy %j', (yy) => { expect(() => formatManifestNo(yy, 1)).toThrow(); });
});

describe('manifestYy (tenant timezone)', () => {
  it('two-digit A.D. year, zero padded', () => {
    expect(manifestYy(new Date('2026-06-15T12:00:00Z'), 'Asia/Kathmandu')).toBe('26');
    expect(manifestYy(new Date('2005-06-15T12:00:00Z'), 'Asia/Kathmandu')).toBe('05');
  });
  it('uses the tenant timezone at the year boundary (NPT = UTC+05:45)', () => {
    expect(manifestYy(new Date('2026-12-31T18:00:00Z'), 'Asia/Kathmandu')).toBe('26'); // 23:45 NPT, still 2026
    expect(manifestYy(new Date('2026-12-31T18:30:00Z'), 'Asia/Kathmandu')).toBe('27'); // 00:15 NPT on 1 Jan 2027
    expect(manifestYy(new Date('2026-12-31T18:30:00Z'), 'UTC')).toBe('26'); // same instant, other tenant timezone
  });
  it('rejects an invalid timezone instead of silently using UTC', () => {
    expect(() => manifestYy(new Date('2026-06-15T12:00:00Z'), 'Not/AZone')).toThrow();
  });
  it('feeds formatManifestNo for a typical number', () => {
    expect(formatManifestNo(manifestYy(new Date('2026-11-13T00:00:00Z'), 'Asia/Kathmandu'), 7)).toBe('MF26000007');
  });
});
