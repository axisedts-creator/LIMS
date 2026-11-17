// AN-T02 domain/metrics.ts (PRD §8.1 B.S. grouping, §8.2 formulas M03/M12/M72, US-01.2 deltas; TRD §6 `bs_month` = aggregate in domain).
// Assumed API (pure; integers only — money is integer paisa, ratios are basis points `_bp`, 02-CV §4.9):
//   groupByBsMonth<T extends { businessDate: IsoDate }>(rows: readonly T[], fields: readonly (keyof T & string)[]): Array<{ key: 'YYYY-MM' } & Record<field, number>>
//       sums `fields` per B.S. month (adToBs of each business date), ascending by key, months with no rows are absent
//   netSales(invoicedPaisa, creditNotesPaisa) = M10 - M11 (may be negative)       netOrders(registered, cancelled) = M01 - M02
//   ratioBp(numerator, denominator): number | null   — round(num * 10000 / den); null when den = 0 (M72 "—")
//   delta(current, previous): { absolute: number; percentBp: number | null }       — percentBp null when previous = 0 (US-01.2)
// B.S. month boundaries come from the golden table (helpers.ts), never hard-coded (US-02.7).
import { describe, expect, it } from 'vitest';
import type { IsoDate } from '../../../../../../../packages/shared-ts/src/bsdate/index.js';
import { delta, groupByBsMonth, netOrders, netSales, ratioBp } from '../metrics.js';
import { addDays, bsKey, golden } from './helpers.js';

// deterministic LCG, no Math.random
const lcg = (seed: number) => () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);

interface Row { businessDate: IsoDate; net: number; credit: number }

/** One row per A.D. day of B.S. year `y`, with signed values (net sales may be negative on a day). */
function yearRows(y: number, seed = 7): { rows: Row[]; expected: Map<string, { net: number; credit: number }> } {
  const next = lcg(seed);
  const rows: Row[] = [];
  const expected = new Map<string, { net: number; credit: number }>();
  for (let m = 1; m <= 12; m++) {
    const g = golden(y, m);
    const sums = { net: 0, credit: 0 };
    for (let d = 0; d < g.days; d++) {
      const net = (next() % 2_000_000_000) - 500_000_000; // up to ~2e9 paisa, some negative
      const credit = next() % 700_000;
      rows.push({ businessDate: addDays(g.ad_first_day, d) as IsoDate, net, credit });
      sums.net += net;
      sums.credit += credit;
    }
    expected.set(bsKey(y, m), sums);
  }
  return { rows, expected };
}

describe('groupByBsMonth — exact integer sums per B.S. month (PRD §8.1)', () => {
  it('a full B.S. year of daily rows: each month sum equals the golden-table-derived sum, keys are YYYY-MM', () => {
    const { rows, expected } = yearRows(2082);
    const out = groupByBsMonth(rows, ['net', 'credit']);
    expect(out.map((g) => g.key)).toEqual([...expected.keys()]);
    for (const g of out) {
      const want = expected.get(g.key)!;
      expect(g.net).toBe(want.net);
      expect(g.credit).toBe(want.credit);
    }
  });
  it('grand total is preserved (nothing dropped or double counted) and all values stay safe integers', () => {
    const { rows } = yearRows(2081, 99);
    const out = groupByBsMonth(rows, ['net', 'credit']);
    expect(out.reduce((a, g) => a + g.net, 0)).toBe(rows.reduce((a, r) => a + r.net, 0));
    for (const g of out) expect(Number.isSafeInteger(g.net) && Number.isSafeInteger(g.credit)).toBe(true);
  });
  it('input order does not matter; output is ascending by key', () => {
    const { rows } = yearRows(2082, 3);
    const shuffled = [...rows].sort(() => 0).reverse();
    expect(groupByBsMonth(shuffled, ['net', 'credit'])).toEqual(groupByBsMonth(rows, ['net', 'credit']));
    const keys = groupByBsMonth(shuffled, ['net']).map((g) => g.key);
    expect(keys).toEqual([...keys].sort());
  });
  it('the last day of a B.S. month and the first day of the next land in different groups (every month of 2082)', () => {
    for (let m = 1; m <= 12; m++) {
      const g = golden(2082, m);
      const last = addDays(g.ad_first_day, g.days - 1) as IsoDate;
      const first = addDays(g.ad_first_day, g.days) as IsoDate; // first day of the next month (Chaitra -> Baisakh 2083)
      const out = groupByBsMonth([{ businessDate: last, v: 1 }, { businessDate: first, v: 10 }], ['v']);
      expect(out).toHaveLength(2);
      expect(out[0]).toEqual({ key: bsKey(2082, m), v: 1 });
      expect(out[1]!.v).toBe(10);
      expect(out[1]!.key).toBe(m === 12 ? bsKey(2083, 1) : bsKey(2082, m + 1));
    }
  });
  it('a B.S. month straddling two A.D. months and a B.S. year straddling two A.D. years group correctly', () => {
    const g = golden(2082, 9); // Poush starts in December A.D.; its tail is in January
    const rows = Array.from({ length: g.days }, (_, i) => ({ businessDate: addDays(g.ad_first_day, i) as IsoDate, v: 100 }));
    const out = groupByBsMonth(rows, ['v']);
    expect(out).toEqual([{ key: bsKey(2082, 9), v: 100 * g.days }]);
    expect(new Set(rows.map((r) => r.businessDate.slice(0, 7))).size).toBeGreaterThan(1);
  });
  it('sparse input: only months that have rows appear (no zero fill); empty input -> []', () => {
    const g = golden(2082, 3);
    expect(groupByBsMonth([{ businessDate: g.ad_first_day as IsoDate, v: 5 }], ['v'])).toEqual([{ key: bsKey(2082, 3), v: 5 }]);
    expect(groupByBsMonth([] as Array<{ businessDate: IsoDate; v: number }>, ['v'])).toEqual([]);
  });
  it('only the requested fields are summed; centre/branch splits of one day are added together', () => {
    const d = golden(2082, 5).ad_first_day as IsoDate;
    const out = groupByBsMonth([{ businessDate: d, a: 1, b: 100 }, { businessDate: d, a: 2, b: 200 }], ['a']);
    expect(out).toEqual([{ key: bsKey(2082, 5), a: 3 }]);
  });
  it('does not mutate its input', () => {
    const { rows } = yearRows(2082, 5);
    const snap = JSON.stringify(rows);
    groupByBsMonth(rows, ['net']);
    expect(JSON.stringify(rows)).toBe(snap);
  });
  it('an A.D. date outside the supported B.S. window is rejected, not silently dropped', () => {
    expect(() => groupByBsMonth([{ businessDate: '1800-01-01' as IsoDate, v: 1 }], ['v'])).toThrow();
  });
});

describe('M12 net sales = M10 - M11; M03 net orders = M01 - M02', () => {
  it('basic and negative-day cases', () => {
    expect(netSales(1_250_000, 250_000)).toBe(1_000_000);
    expect(netSales(100, 700)).toBe(-600);
    expect(netSales(0, 0)).toBe(0);
    expect(netOrders(12, 2)).toBe(10);
    expect(netOrders(0, 0)).toBe(0);
  });
  it('stays exact on large paisa values', () => {
    expect(netSales(9_000_000_000_000_001, 1)).toBe(9_000_000_000_000_000);
  });
});

describe('ratioBp — basis points, null when the denominator is 0 (M72 shows "—")', () => {
  it('table', () => {
    expect(ratioBp(0, 0)).toBeNull();
    expect(ratioBp(5, 0)).toBeNull();
    expect(ratioBp(0, 5)).toBe(0);
    expect(ratioBp(3, 40)).toBe(750); // 7.5 per 100
    expect(ratioBp(1, 8)).toBe(1250);
    expect(ratioBp(1, 3)).toBe(3333);
    expect(ratioBp(2, 3)).toBe(6667);
    expect(ratioBp(40, 40)).toBe(10_000);
  });
  it('result is always an integer', () => {
    for (const [n, d] of [[1, 7], [13, 17], [999, 1001]] as const) expect(Number.isInteger(ratioBp(n, d))).toBe(true);
  });
});

describe('delta — absolute and percent against the previous period (US-01.2)', () => {
  it('increase, decrease, flat', () => {
    expect(delta(150, 100)).toEqual({ absolute: 50, percentBp: 5000 });
    expect(delta(80, 100)).toEqual({ absolute: -20, percentBp: -2000 });
    expect(delta(100, 100)).toEqual({ absolute: 0, percentBp: 0 });
    expect(delta(1, 3)).toEqual({ absolute: -2, percentBp: -6667 });
  });
  it('percent is omitted (null) when the previous value is 0', () => {
    expect(delta(5, 0)).toEqual({ absolute: 5, percentBp: null });
    expect(delta(0, 0)).toEqual({ absolute: 0, percentBp: null });
  });
});
