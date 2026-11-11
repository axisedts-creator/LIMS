// C14 T04 — domain/band.ts (02-TRD §4.2 band table + borderline rule; 02-TRD §9.6 vectors B-01…B-06; AC-08.7, AC-10.2, AC-10.3, AC-10.5).
// API pinned by these tests (spec gives no names):
//   bandOf({ flag?, valueNumeric?, referenceRangeSnapshot?: { low?, high?, text? }, borderlineFractionBp? }) -> { status, direction? } | null
//   null = not eligible (no flag AND no snapshot, AC-08.7). borderlineFractionBp is the already-resolved b (mapping override else library; default 0 = off).
//   in_range / critical / out_of_range carry direction only per the table; plain in_range has NO direction.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { bandOf } from '../band.js';

type Snap = { low?: string; high?: string; text?: string };
const inRange = (v: string, snap: Snap | undefined, b: number | undefined, flag: string | undefined = 'N') =>
  bandOf({ flag: flag as never, valueNumeric: v as never, referenceRangeSnapshot: snap as never, borderlineFractionBp: b });

describe('band table (§4.2) — flag is the authority, never recomputed from the value', () => {
  it.each([
    ['HH', { status: 'critical', direction: 'high' }],       // AC-10.2
    ['LL', { status: 'critical', direction: 'low' }],
    ['H', { status: 'out_of_range', direction: 'high' }],
    ['L', { status: 'out_of_range', direction: 'low' }],
    ['A', { status: 'out_of_range', direction: 'abnormal' }], // AC-10.3
  ])('flag %s', (flag, expected) => {
    expect(bandOf({ flag: flag as never })).toEqual(expected);
  });

  it('flag wins over the value: flag H with a value inside the range stays out_of_range/high', () => {
    expect(bandOf({ flag: 'H' as never, valueNumeric: '15' as never, referenceRangeSnapshot: { low: '10', high: '20' } as never, borderlineFractionBp: 500 }))
      .toEqual({ status: 'out_of_range', direction: 'high' });
  });

  it('critical/out-of-range are never downgraded to borderline by b > 0', () => {
    expect(bandOf({ flag: 'LL' as never, valueNumeric: '10.1' as never, referenceRangeSnapshot: { low: '10', high: '20' } as never, borderlineFractionBp: 2500 }))
      .toEqual({ status: 'critical', direction: 'low' });
  });

  it('flag N -> in_range with no direction', () => {
    expect(bandOf({ flag: 'N' as never })).toEqual({ status: 'in_range' });
    expect(bandOf({ flag: 'N' as never })).not.toHaveProperty('direction');
  });

  it('flag absent + range snapshot -> in_range (snapshot alone makes it eligible)', () => {
    expect(bandOf({ referenceRangeSnapshot: { low: '10', high: '20' } as never, valueNumeric: '15' as never })).toEqual({ status: 'in_range' });
    expect(bandOf({ referenceRangeSnapshot: { text: 'Negative' } as never })).toEqual({ status: 'in_range' });
  });

  it('AC-08.7: flag absent AND no snapshot -> null (excluded from tiles, score, deranged)', () => {
    expect(bandOf({})).toBeNull();
    expect(bandOf({ valueNumeric: '15' as never })).toBeNull();
    expect(bandOf({ valueNumeric: '15' as never, borderlineFractionBp: 500 })).toBeNull();
  });

  it('flag present, no snapshot -> still classified from the flag', () => {
    expect(bandOf({ flag: 'L' as never })).toEqual({ status: 'out_of_range', direction: 'low' });
  });
});

describe('borderline (§4.2) — only in_range, numeric value, numeric limit(s), b > 0', () => {
  // B-01 two-sided: low 10, high 20, b 1000 -> m = (20-10)*1000/10000 = 1
  describe('B-01 two-sided (10..20, b=1000, m=1)', () => {
    const snap = { low: '10', high: '20' };
    it.each([
      ['10', 'borderline', 'low'], ['10.5', 'borderline', 'low'], ['10.999999', 'borderline', 'low'],
      ['11', 'in_range', undefined],                       // B-05: exactly low + m is NOT borderline (strict <)
      ['15', 'in_range', undefined],
      ['19', 'in_range', undefined],                       // exactly high - m is NOT borderline (strict >)
      ['19.000001', 'borderline', 'high'], ['20', 'borderline', 'high'],
    ])('v=%s -> %s %s', (v, status, direction) => {
      expect(inRange(v, snap, 1000)).toEqual(direction ? { status, direction } : { status });
    });
  });

  it('AC-10.5: HGB 12..16, b=500 (5 % of width 4 = 0.2): 12.1 -> borderline low; 12.2 / 14 -> in_range; 15.9 -> borderline high', () => {
    const snap = { low: '12', high: '16' };
    expect(inRange('12.1', snap, 500)).toEqual({ status: 'borderline', direction: 'low' });
    expect(inRange('12.2', snap, 500)).toEqual({ status: 'in_range' });
    expect(inRange('14', snap, 500)).toEqual({ status: 'in_range' });
    expect(inRange('15.9', snap, 500)).toEqual({ status: 'borderline', direction: 'high' });
  });

  it('AC-10.5 / B-04: b = 0 (default) or undefined -> never borderline', () => {
    const snap = { low: '12', high: '16' };
    expect(inRange('12.1', snap, 0)).toEqual({ status: 'in_range' });
    expect(inRange('12.1', snap, undefined)).toEqual({ status: 'in_range' });
    expect(inRange('15.99', snap, 0)).toEqual({ status: 'in_range' });
  });

  // B-02 high-only: high 100, b 500 -> m = |100|*500/10000 = 5
  it('B-02 high-only (high=100, b=500, m=5)', () => {
    const snap = { high: '100' };
    expect(inRange('95', snap, 500)).toEqual({ status: 'in_range' });
    expect(inRange('95.000001', snap, 500)).toEqual({ status: 'borderline', direction: 'high' });
    expect(inRange('100', snap, 500)).toEqual({ status: 'borderline', direction: 'high' });
    expect(inRange('1', snap, 500)).toEqual({ status: 'in_range' });             // far below: no low limit, never "low"
  });

  // B-03 low-only: low 100, b 500 -> m = 5
  it('B-03 low-only (low=100, b=500, m=5)', () => {
    const snap = { low: '100' };
    expect(inRange('105', snap, 500)).toEqual({ status: 'in_range' });
    expect(inRange('104.999999', snap, 500)).toEqual({ status: 'borderline', direction: 'low' });
    expect(inRange('100', snap, 500)).toEqual({ status: 'borderline', direction: 'low' });
    expect(inRange('500', snap, 500)).toEqual({ status: 'in_range' });           // far above: no high limit, never "high"
  });

  // B-06 negative limits
  describe('B-06 negative limits', () => {
    it('two-sided -10..-2, b=1000 -> m = 0.8: -9.5 low, -9.2 in, -2.8 in, -2.5 high', () => {
      const snap = { low: '-10', high: '-2' };
      expect(inRange('-9.5', snap, 1000)).toEqual({ status: 'borderline', direction: 'low' });
      expect(inRange('-9.2', snap, 1000)).toEqual({ status: 'in_range' });
      expect(inRange('-5', snap, 1000)).toEqual({ status: 'in_range' });
      expect(inRange('-2.8', snap, 1000)).toEqual({ status: 'in_range' });
      expect(inRange('-2.5', snap, 1000)).toEqual({ status: 'borderline', direction: 'high' });
    });
    it('high-only -100, b=500 -> m = |−100|*5% = 5 (absolute value of the limit): threshold -105', () => {
      const snap = { high: '-100' };
      expect(inRange('-104', snap, 500)).toEqual({ status: 'borderline', direction: 'high' });
      expect(inRange('-105', snap, 500)).toEqual({ status: 'in_range' });
    });
    it('low-only -100, b=500 -> m = 5: threshold -95', () => {
      const snap = { low: '-100' };
      expect(inRange('-96', snap, 500)).toEqual({ status: 'borderline', direction: 'low' });
      expect(inRange('-95', snap, 500)).toEqual({ status: 'in_range' });
    });
  });

  it('margin is rounded half-up in micro-units: width 0.000030, b=500 -> m = 1.5 µ -> 2 µ', () => {
    const snap = { low: '0', high: '0.000030' };
    expect(inRange('0.000001', snap, 500)).toEqual({ status: 'borderline', direction: 'low' });   // 1 < 2 (truncated m = 1 would give in_range: discriminates half-up)
    expect(inRange('0.000002', snap, 500)).toEqual({ status: 'in_range' });                        // 2 < 2 false; 2 > 30 - 2 = 28 false
  });

  it('exact arithmetic, no float drift: 0.1..0.3, b=5000 (m=0.1): v=0.2 is exactly low+m -> in_range; v=0.199999 -> borderline low', () => {
    const snap = { low: '0.1', high: '0.3' };
    expect(inRange('0.2', snap, 5000)).toEqual({ status: 'in_range' });
    expect(inRange('0.199999', snap, 5000)).toEqual({ status: 'borderline', direction: 'low' });
  });

  it('b = 2500 (max), range 10..11 (m=0.25): middle in_range, near-low borderline low', () => {
    expect(inRange('10.5', { low: '10', high: '11' }, 2500)).toEqual({ status: 'in_range' });       // m=0.25: 10.5 neither
    expect(inRange('10.2', { low: '10', high: '11' }, 2500)).toEqual({ status: 'borderline', direction: 'low' });
  });

  it('no valueNumeric (flag N, text/ordinal result) -> in_range even when b > 0', () => {
    expect(bandOf({ flag: 'N' as never, referenceRangeSnapshot: { low: '10', high: '20' } as never, borderlineFractionBp: 500 })).toEqual({ status: 'in_range' });
  });

  it('text-only snapshot -> never borderline', () => {
    expect(inRange('5', { text: 'Negative' }, 2500)).toEqual({ status: 'in_range' });
  });

  it('no snapshot at all with flag N and value -> in_range, never borderline', () => {
    expect(inRange('5', undefined, 2500)).toEqual({ status: 'in_range' });
  });

  it('degenerate snapshot low === high (zero width): margin 0 -> never borderline, no crash', () => {
    expect(inRange('10', { low: '10', high: '10' }, 2500)).toEqual({ status: 'in_range' });
  });
});

describe('purity / no float arithmetic (02-TRD §2 Decimal handling: integer bigint only)', () => {
  const dir = fileURLToPath(new URL('..', import.meta.url));
  for (const f of ['fixed.ts', 'band.ts']) {
    it(`${f} has no float parsing, no Math.*, no I/O imports`, () => {
      const src = readFileSync(dir + f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
      expect(src).not.toMatch(/\b(parseFloat|Number\s*\(|Math\.|Date\.now|Math\.random)/);
      expect(src).not.toMatch(/from\s+['"](node:|pg|\.\.\/repository|\.\.\/\.\.\/\.\.\/core)/);
    });
  }
});
