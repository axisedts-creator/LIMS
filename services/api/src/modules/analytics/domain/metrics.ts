// Metric arithmetic (PRD §8.1 B.S. grouping, §8.2 M03/M12/M72, US-01.2 deltas). Integers only: money is paisa, ratios are basis points.
import { adToBs, type IsoDate } from '../../../../../../packages/shared-ts/src/bsdate/index.js';

export const netSales = (invoicedPaisa: number, creditNotesPaisa: number): number => invoicedPaisa - creditNotesPaisa; // M12 = M10 - M11
export const netOrders = (registered: number, cancelled: number): number => registered - cancelled; // M03 = M01 - M02

/** Integer n/d rounded half away from zero (BigInt: numerator * 10000 can pass 2^53). */
function divRound(n: bigint, d: bigint): number {
  const neg = (n < 0n) !== (d < 0n);
  const an = n < 0n ? -n : n, ad = d < 0n ? -d : d;
  const q = (2n * an + ad) / (2n * ad);
  return Number(neg ? -q : q);
}

/** round(num * 10000 / den); null when den = 0 (M72 shows "—"). */
export function ratioBp(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : divRound(BigInt(numerator) * 10_000n, BigInt(denominator));
}

/** Change against the previous period; percentBp is null when previous = 0 (US-01.2). A negative base uses |previous|. */
export function delta(current: number, previous: number): { absolute: number; percentBp: number | null } {
  const absolute = current - previous;
  return { absolute, percentBp: ratioBp(absolute, Math.abs(previous)) };
}

/** Sums `fields` per B.S. month of each row's business date; ascending by key, months without rows absent. Throws if a date is outside the B.S. window. */
export function groupByBsMonth<T extends { businessDate: IsoDate }, F extends keyof T & string>(
  rows: readonly T[],
  fields: readonly F[],
): Array<{ key: string } & Record<F, number>> {
  const groups = new Map<string, Record<string, number>>();
  for (const row of rows) {
    const b = adToBs(row.businessDate);
    const key = `${String(b.year).padStart(4, '0')}-${String(b.month).padStart(2, '0')}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = Object.fromEntries(fields.map((f) => [f, 0]))));
    for (const f of fields) {
      const sum = g[f]! + Number(row[f]);
      if (!Number.isSafeInteger(sum)) throw new RangeError(`groupByBsMonth: ${f} is not a safe integer sum`);
      g[f] = sum;
    }
  }
  return [...groups.keys()].sort().map((key) => ({ key, ...groups.get(key)! }) as { key: string } & Record<F, number>);
}
